/* tools/_probe-open-in-browser.cjs —— 「在浏览器中打开」端到端探针
 *
 * 【为什么需要它】
 *   用户报障（2026-09-30）：
 *     「在浏览器中打开 出问题了。word 没有用 onlyoffice 打开。变成了PDF
 *       DWG 可以调用，但是无法打开文件  PDF 会变成 cdr文件预览。」
 *   这一条链路横跨 插件 → 后端路由 → 三套渲染器（kkFileView / OnlyOffice / cad-viewer），
 *   任何一层都可能出问题，而且**服务端往往一切正常**（200 + 正确的字节），
 *   真正的失败发生在**浏览器**里（CDN 被拦、PDF.js 取流失败、字体加载不到）。
 *
 *   ⇒ 只测 HTTP 状态码是不够的。**必须在真实浏览器里打开，抓控制台与失败请求。**
 *
 * 【它做什么】
 *   对每种文件类型（默认 pdf / docx / dwg）：
 *     ① 调 /api/stat   —— 看后端认定的 route（cad / onlyoffice / kkfileview）
 *     ② 调 /api/preview（或 /api/cad/preview）—— 拿渲染入口地址
 *     ③ 用 headless Chrome 真实打开该地址，抓：
 *          · 控制台 error/warning
 *          · Network.loadingFailed（含 ERR_CONNECTION_RESET 这类）
 *          · 最终 iframe.src / 页面可见文本
 *     ④ 可选截图（NB_SHOT=1）
 *
 * 【用法】
 *   node tools/_probe-open-in-browser.cjs                     # 用内置样例（需改 mount/path）
 *   NB_FILE=pdf:售前项目:/a/b.pdf,docx:售前项目:/c/d.docx node tools/_probe-open-in-browser.cjs
 *   NB_SHOT=1 node tools/_probe-open-in-browser.cjs
 *
 *   ★ 样例路径必须自己给 ★ 本仓库不含用户文件清单；
 *     先用 /api/search 找文件（见下「找样例文件」）。
 *
 * 【找样例文件】
 *   const tok = await L.nebulaLogin();
 *   fetch(`${B}/api/search?mount=${m}&q=.dwg`, {headers:{Authorization:`Bearer ${tok}`}})
 *
 * 【判读要点（2026-09-30 实测基线）】
 *   · DWG 正常应看到图纸 + 不报 fonts.json 失败；
 *     若出现 `ERR_CONNECTION_RESET cdn.jsdelivr.net/.../fonts.json`
 *     与文案「无法…获取可用的字体信息」⇒ 是 CDN 被阻断（见 _probe-cdn-reach.cjs）。
 *   · DOCX 走 kkFileView 时**本来就会转成 PDF 再用 PDF.js 显示**
 *     （页面里 `var url = '…docx.pdf'`）。这是设计行为，不是 bug。
 *   · PDF 正常应看到 PDF.js 界面；页面文本为空属正常（在 iframe 里）。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const L = require("./_local.cjs");

const BASE = L.NEBULA;
const SHOT = process.env.NB_SHOT === "1";
const WAIT = Number(process.env.NB_WAIT || 12000);
const OUT_DIR = path.join(__dirname, "..", ".scratch");

/** 从 NB_FILE 解析样例；格式 name:mount:path，逗号分隔 */
function parseFiles() {
  const raw = process.env.NB_FILE;
  if (!raw) return [];
  return raw.split(",").map((s) => {
    const i = s.indexOf(":");
    const j = s.indexOf(":", i + 1);
    return { label: s.slice(0, i), mount: s.slice(i + 1, j), path: s.slice(j + 1) };
  }).filter((f) => f.label && f.mount && f.path);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpClient(port) {
  const jget = (p) => new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port, path: p }, (r) => {
      let s = ""; r.on("data", (d) => (s += d)); r.on("end", () => res(JSON.parse(s)));
    }).on("error", rej);
  });
  return { jget };
}

(async () => {
  if (!BASE) { console.error("未配置 NebulaDisk 地址（NB_SERVERURL）"); process.exit(1); }

  const files = parseFiles();
  if (!files.length) {
    console.error("请用 NB_FILE=name:mount:path[,name:mount:path] 指定样例文件。");
    console.error("例如：NB_FILE=pdf:售前项目:/dir/a.pdf,dwg:售前项目:/dir/b.dwg");
    process.exit(1);
  }

  const token = await L.nebulaLogin();
  console.log(`NebulaDisk: ${BASE}   已登录\n`);

  // 起一次 Chrome，复用
  const PORT = Number(process.env.NB_CDP_PORT || 9336);
  const userData = path.join(os.tmpdir(), "nb-oib-" + Date.now());
  const ch = spawn(L.CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1400,900", "about:blank",
  ], { stdio: "ignore" });

  const { jget } = cdpClient(PORT);
  let ver = null;
  for (let i = 0; i < 50; i++) { try { ver = await jget("/json/version"); break; } catch { await sleep(300); } }
  if (!ver) { console.error("Chrome 未就绪"); ch.kill(); process.exit(1); }
  console.log("Chrome:", ver["Browser"], "\n");

  const tabs = await jget("/json/list");
  const tab = tabs.find((t) => t.type === "page");
  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  if (!ws) { console.error("无内置 WebSocket（需 Node 22+）"); ch.kill(); process.exit(1); }

  let id = 0; const pend = new Map(); let ev = [];
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
    if (m.method) ev.push(m);
  });
  await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const H = { Authorization: `Bearer ${token}` };

  for (const f of files) {
    console.log(`${"=".repeat(66)}\n## ${f.label}   ${f.path.split("/").pop()}`);
    const qs = new URLSearchParams({ mount: f.mount, path: f.path }).toString();

    // ① stat → 后端认定的 route
    let route = "?";
    try {
      const st = await (await fetch(`${BASE}/api/stat?${qs}`, { headers: H, signal: AbortSignal.timeout(15000) })).json();
      route = st.route ?? JSON.stringify(st).slice(0, 80);
      console.log(`  ① /api/stat      route=${route}  ext=${st.ext}  size=${st.size}`);
    } catch (e) { console.log("  ① /api/stat 失败:", e.message); }

    // ② 取渲染入口（cad 走 /api/cad/preview，其余走 /api/preview）
    let entry = null;
    const eps = route === "cad" ? ["/api/cad/preview", "/api/preview"] : ["/api/preview"];
    for (const ep of eps) {
      try {
        const j = await (await fetch(`${BASE}${ep}?${qs}`, { headers: H, signal: AbortSignal.timeout(30000) })).json();
        if (j && j.url) { entry = j.url; console.log(`  ② ${ep.padEnd(17)} → ${j.url.slice(0, 90)}`); break; }
        console.log(`  ② ${ep} → 无 url: ${JSON.stringify(j).slice(0, 120)}`);
      } catch (e) { console.log(`  ② ${ep} 失败:`, e.message); }
    }
    if (!entry) { console.log("  !! 拿不到渲染入口，跳过\n"); continue; }

    // ③ 浏览器真实打开
    ev = [];
    const u = new URL(BASE);
    await send("Network.setCookie", { name: "nb_session", value: token, domain: u.hostname, path: "/" });
    await send("Page.navigate", { url: BASE + entry });
    await sleep(WAIT);

    const fails = ev.filter((e) => e.method === "Network.loadingFailed");
    const errs = ev.filter((e) => (e.method === "Log.entryAdded" && ["error"].includes(e.params.entry.level))
      || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error"));

    console.log(`  ③ 浏览器：失败请求 ${fails.length} 条，错误日志 ${errs.length} 条`);
    for (const x of fails.slice(0, 8)) {
      const req = ev.find((e) => e.method === "Network.requestWillBeSent" && e.params.requestId === x.params.requestId);
      console.log(`     ✗ ${x.params.errorText}  ${(req?.params?.request?.url || "?").slice(0, 120)}`);
    }
    for (const x of errs.slice(0, 6)) {
      const t = x.params.entry?.text || x.params.args?.map((a) => a.value ?? a.description).join(" ") || "";
      console.log(`     ! ${String(t).replace(/\s+/g, " ").slice(0, 160)}`);
    }

    const st = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        iframe: (document.querySelector('iframe')||{}).src || null,
        text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300)
      })`,
      returnByValue: true,
    });
    try {
      const o = JSON.parse(st.result.value);
      console.log(`  ④ title: ${o.title}`);
      if (o.iframe) console.log(`     iframe: ${String(o.iframe).slice(0, 130)}`);
      console.log(`     可见文本: ${o.text || "(空)"}`);
    } catch { /* ignore */ }

    if (SHOT) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      if (r && r.data) {
        const p = path.join(OUT_DIR, `oib-${f.label}.png`);
        fs.writeFileSync(p, Buffer.from(r.data, "base64"));
        console.log(`  ⑤ 截图: ${p}`);
      }
    }
    console.log("");
  }

  ws.close(); ch.kill();
})();

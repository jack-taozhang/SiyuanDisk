/**
 * 三个功能的最终端到端验证（浏览器视角，模拟插件真实调用序列）。
 *
 *   ① 侧边栏浏览：/api/me → /api/list（逐层下钻，验证每条都有 path）
 *   ② 预览与在线编辑：/api/preview、/api/oo/config、/api/cad/preview
 *   ③ 无缝嵌入：嵌入块用到的同一批接口（list + previewUrl）
 *
 * 用法：node final-check.cjs
 */
const http = require("http");

const HOST = process.env.NB_HOST || "172.16.30.128";
const PORT = parseInt(process.env.NB_PORT || "8089", 10);
const BASE = `http://${HOST}:${PORT}`;
const ORIGIN = process.env.NB_ORIGIN || "http://172.16.30.128:6806";
const USER = process.env.NB_USER || "tao_zhang";
const { PASS } = require("./_secrets.cjs");

function call(method, path, { token, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Origin: ORIGIN, Accept: "application/json" }, headers);
    let payload = null;
    if (form) {
      payload = new URLSearchParams(form).toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h["Content-Length"] = Buffer.byteLength(payload);
    }
    if (token) h["Authorization"] = "Bearer " + token;
    const r = http.request({ host: HOST, port: PORT, path, method, headers: h }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON（HTML/文件流） */ }
        resolve({ status: res.statusCode, headers: res.headers, json, len: d.length });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let fail = 0;
const say = (ok, label, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};

(async () => {
  console.log(`后端 ${BASE}    页面来源 ${ORIGIN}\n`);

  // ---------- 通道探测（插件启动第一步）----------
  const hz = await call("GET", "/healthz");
  say(hz.status === 200 && hz.headers["access-control-allow-origin"] === "*",
    "通道探测 /healthz（CORS 可读）", `ACAO=${hz.headers["access-control-allow-origin"]}`);

  // ---------- 登录 ----------
  const login = await call("POST", "/api/login", { form: { username: USER, password: PASS } });
  const token = login.json && login.json.token;
  say(login.status === 200 && !!token, "登录并取到 Bearer token", `len=${token ? token.length : 0}`);

  const me = await call("GET", "/api/me", { token });
  const mounts = (me.json && me.json.mounts) || [];
  say(me.status === 200 && mounts.length > 0, "读取挂载点列表",
    `${mounts.length} 个：${mounts.map((m) => m.label).join("、")}`);

  const mount = mounts[0] && mounts[0].label;

  // ============================================================
  console.log("\n【① 侧边栏浏览】逐层下钻");
  // ============================================================
  async function listDir(p) {
    const r = await call("GET", `/api/list?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(p)}`, { token });
    return r;
  }

  let cur = "/";
  let depth = 0;
  let totalEntries = 0;
  let pathless = 0;
  while (depth < 3) {
    const r = await listDir(cur);
    if (r.status !== 200) { say(false, `列目录 ${cur}`, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`); break; }
    const entries = r.json.entries || [];
    const noPath = entries.filter((e) => typeof e.path !== "string" || !e.path).length;
    pathless += noPath;
    totalEntries += entries.length;
    say(noPath === 0, `第 ${depth + 1} 层 ${cur === "/" ? "(根)" : cur}`,
      `${entries.length} 项，缺 path ${noPath} 条，顶层 path=${JSON.stringify(r.json.path)}`);
    const dir = entries.find((e) => e.isDir);
    if (!dir) break;
    cur = dir.path;
    depth++;
  }
  say(pathless === 0, "所有层级均无缺失 path 的条目", `共 ${totalEntries} 项`);
  say(cur !== "/", "子目录可继续下钻（末层路径）", cur);

  // 回到根，挑几个不同类型的文件做预览测试
  const rootR = await listDir("/");
  const files = (rootR.json.entries || []).filter((e) => !e.isDir);
  const byExt = {};
  for (const f of files) (byExt[(f.ext || "").toLowerCase()] ||= []).push(f);
  console.log(`   根目录文件分布: ${Object.entries(byExt).map(([k, v]) => `${k || "(无扩展)"}×${v.length}`).join(", ")}`);

  // ============================================================
  console.log("\n【② 预览 / 在线编辑】");
  // ============================================================
  const probe = files.slice(0, 6);
  for (const f of probe) {
    const p = f.path;
    if (f.route === "onlyoffice") {
      const oo = await call("POST", "/api/oo/config", {
        token,
        form: { mount, path: p },
      });
      const ok = oo.status === 200;
      say(ok, `在线编辑配置 ${f.name}`,
        ok ? `HTTP 200, title=${JSON.stringify((oo.json && oo.json.document && oo.json.document.title) || "")}` : `HTTP ${oo.status} ${JSON.stringify(oo.json).slice(0, 140)}`);
    } else if (f.route === "kkfileview") {
      const pv = await call("GET", `/api/preview?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(p)}`, { token });
      const url = pv.json && pv.json.url;
      say(pv.status === 200 && !!url, `预览地址 ${f.name}`, url ? `${String(url).slice(0, 60)}…` : `HTTP ${pv.status}`);
    } else {
      // download 类（图片/压缩包等）走 downloadUrl
      const dl = await call("GET", `/api/download?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(p)}&inline=1`, { token });
      say(dl.status === 200, `直链 ${f.name}`, `HTTP ${dl.status} ct=${dl.headers["content-type"] || "?"} ${dl.headers["content-length"] || "?"}B`);
    }
  }

  // CAD 专项（如果有）
  const cad = files.find((f) => /\.(dwg|dxf|step|stp|iges|igs|stl)$/i.test(f.name));
  if (cad) {
    const c = await call("GET", `/api/cad/preview?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(cad.path)}`, { token });
    say(c.status === 200, `CAD 预览 ${cad.name}`, `HTTP ${c.status}`);
  } else {
    console.log("  （根目录无 CAD 文件，跳过）");
  }

  // 各后端健康
  for (const [label, path] of [["OnlyOffice", "/api/oo/health"], ["kkFileView", "/api/kk/health"], ["CAD viewer", "/api/cad/health"]]) {
    const h = await call("GET", path, { token });
    say(h.status === 200, `${label} 健康`, `HTTP ${h.status} ${JSON.stringify(h.json).slice(0, 80)}`);
  }

  // ============================================================
  console.log("\n【③ 无缝嵌入】");
  // ============================================================
  // 嵌入块渲染树浏览器时，用的是同一套 list；渲染文件嵌入用的是 previewUrl。
  // 这里验证「嵌入规格里的 mount/path 能直接取到可渲染地址」。
  const target = files.find((f) => f.route === "kkfileview") || files[0];
  if (target) {
    const spec = { mount, path: target.path, name: target.name };
    const ok = typeof spec.mount === "string" && spec.mount && typeof spec.path === "string" && spec.path;
    say(ok, "嵌入规格 mount/path 完整（不会再报「缺少网盘/路径参数」）",
      `${spec.mount}:${spec.path}`);
    const pv = await call("GET", `/api/preview?mount=${encodeURIComponent(spec.mount)}&path=${encodeURIComponent(spec.path)}`, { token });
    const abs = pv.json && pv.json.url ? BASE + pv.json.url : "";
    say(!!abs, "嵌入块 iframe 可用的绝对地址", abs ? `${abs.slice(0, 72)}…` : `HTTP ${pv.status}`);
  } else {
    say(false, "找不到可嵌入的文件");
  }

  // ---------- 安全回归 ----------
  console.log("\n【安全回归】");
  const noTok = await call("GET", "/api/list?mount=" + encodeURIComponent(mount) + "&path=/");
  say(noTok.status === 401, "无 token 被拒（401）", `HTTP ${noTok.status}`);
  const pre = await call("OPTIONS", "/api/list", { headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
  say(String(pre.headers["access-control-allow-credentials"]) !== "true",
    "未下发 Allow-Credentials=true（* 与凭据不可共存）", `= ${pre.headers["access-control-allow-credentials"]}`);

  console.log("\n" + (fail ? `❌ ${fail} 项未通过` : "✅ 三个功能全链路通过"));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("异常:", e.message, e.stack); process.exit(1); });

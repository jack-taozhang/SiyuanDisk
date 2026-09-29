/* 测「连接断掉后能不能自愈」——不重启内核，用 CDP 模拟断网（对用户无干扰）
 *
 * ⚠️⚠️ 实测结论：**这个办法不成立，别再用** ⚠️⚠️
 *   `Network.emulateNetworkConditions({offline:true})` **不影响 WebSocket**：
 *   掐网 8 秒期间 `window.siyuan.ws.ws.readyState` 仍是 1（OPEN）、也不弹断连对话框
 *   ⇒ CDP 的 offline 只作用于普通网络请求，WS 不走那套拦截。
 *   所以本脚本**测不出**重连能力（产出是空的「✅」，属假绿，勿引用其结论）。
 *
 *   真要断开 WS，可行的是：① 重启内核容器（会打断用户，慎用）；
 *   ② 在页面里主动 `ws.close()`（但那测的是应用自愈，不是网络中断）；
 *   ③ 从网络层阻断（NAS 上 iptables / 拔网线）。
 *   本次调查最终没用它下结论 —— 见 2026-09-29 工作记录。
 *
 * 下面保留原始实现（原意图：把网络掐掉再恢复，直接检验思源的重连机制是否可靠；
 *   · 若掐网→恢复后能自动连回 ⇒ 重连机制可靠，用户遇到的必是别的条件
 *   · 若恢复后仍连不回         ⇒ 找到可复现的真实缺陷），
 * 供将来换成办法 ② 或 ③ 时参考。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const LOCAL = require("./_local.cjs");
const WS = LOCAL.WS;
LOCAL.assertReady();

const CHROME = LOCAL.CHROME;
const SIYUAN = LOCAL.SIYUAN;
const AUTH = LOCAL.AUTH;
const HOST = LOCAL.HOST;
const PORT = 9354;
const PROFILE = "E:/TEMP/nb-cdp-net";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hj(url, opts) {
  return new Promise((res, rej) => {
    const r = http.request(url, opts || {}, (x) => {
      let b = ""; x.on("data", (c) => (b += c));
      x.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } });
    });
    r.on("error", rej); r.end();
  });
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(m, pa) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.p.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method: m, params: pa || {} }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error("timeout " + m)); } }, 40000);
    });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  }
}

const READ = `
(function(){
  var txt = (document.body && document.body.innerText) || "";
  var w = window.siyuan && window.siyuan.ws, ready = null;
  try { ready = (w && w.ws && typeof w.ws.readyState === "number") ? w.ws.readyState : null; } catch(e){}
  return { url: location.href, banner: txt.indexOf("与内核的连接已断开") >= 0,
           dialog: !!document.querySelector(".b3-dialog--open"), ready: ready,
           wsUrl: (w && w.ws && w.ws.url) ? String(w.ws.url).slice(-40) : null };
})()
`;

(async () => {
  console.log("=".repeat(70));
  console.log("测重连机制：模拟断网 → 恢复，看思源能否自动连回");
  console.log("=".repeat(70));

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE, "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1400,900", "--no-proxy-server", "--proxy-bypass-list=<-loopback>", "about:blank"], { stdio: "ignore" });
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await hj("http://127.0.0.1:" + PORT + "/json/version"); break; } catch { await sleep(300); } }
  if (!v) { console.log("❌ CDP 未就绪"); chrome.kill(); process.exitCode = 1; return; }

  const list = await hj("http://127.0.0.1:" + PORT + "/json/list");
  const page = list.find((t) => t.type === "page");
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Network.setCookie", {
    name: "siyuan", value: await new Promise((res, rej) => {
      const data = JSON.stringify({ authCode: AUTH });
      const r = http.request({ host: HOST, port: Number(LOCAL.PORT || 6806), path: "/api/system/loginAuth", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
        (x) => { const sc = x.headers["set-cookie"] || []; const m = sc.map((c) => /^siyuan=([^;]+)/.exec(c)).find(Boolean);
                 x.resume(); x.on("end", () => res(m ? m[1] : null)); });
      r.on("error", rej); r.write(data); r.end();
    }),
    domain: HOST, path: "/", httpOnly: true, sameSite: "Lax",
  });

  console.log("\n[1] 打开应用");
  await cdp.send("Page.navigate", { url: SIYUAN + "/stage/build/desktop/" });
  await sleep(9000);
  const s1 = await cdp.eval(READ);
  console.log("    " + JSON.stringify(s1));

  console.log("\n[2] 掐网 8 秒（模拟连接中断）");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(8000);
  const s2 = await cdp.eval(READ);
  console.log("    断网中: " + JSON.stringify(s2));

  console.log("\n[3] 恢复网络，观察 20 秒（分点采样）");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(3000); const a = await cdp.eval(READ); console.log("    +3s : " + JSON.stringify(a));
  await sleep(5000); const b = await cdp.eval(READ); console.log("    +8s : " + JSON.stringify(b));
  await sleep(12000); const c = await cdp.eval(READ); console.log("    +20s: " + JSON.stringify(c));

  console.log("\n" + "=".repeat(70));
  console.log("判定");
  console.log("=".repeat(70));
  console.log("  断网中是否弹窗 : " + s2.banner + " / " + s2.dialog);
  console.log("  恢复 20s 后    : banner=" + c.banner + " ready=" + c.ready);
  if (!c.banner && c.ready === 1) {
    console.log("\n  ✅ 断网→恢复后**自动连回** ⇒ 思源的重连机制可靠。");
    console.log("     用户遇到的断连必然另有条件（不是「内核坏了」也不是「重连坏了」）。");
  } else {
    console.log("\n  ⚠️ 恢复网络 20 秒后仍未连回（banner=" + c.banner + ", ready=" + c.ready + "）");
    console.log("     ⇒ 这是可复现的真实缺陷：思源在 WS 断开后不总能自愈。");
  }

  try { const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("E:/TEMP/nb-net-recover.png", Buffer.from(shot.data, "base64")); } catch {}
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exitCode = 2; });

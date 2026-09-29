/* 忠实复现：未认证打开登录页 → 用登录页 UI 登录 → 后移到登录页 → 前移回应用
 *
 * 与 v1（_probe-bfcache-repro.cjs）的区别：
 *   v1 带 cookie 访问 `/`，被服务端**直接重定向**到应用 ⇒ 历史里没有登录页 ⇒ 复现不到。
 *   本版先清空 cookie，让历史的第 1 条真的是登录页（/），再走真实 UI 登录。
 *
 * 逐步输出：文档指纹 / 事件(pageshow persisted) / WebSocket 建连记录 / 断连横幅 /
 *          思源 ws.readyState / 页面是否仍认得 cookie。
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
const PORT = 9352;
const PROFILE = "E:/TEMP/nb-cdp-bf2";
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
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); reject(new Error("timeout " + m)); } }, 30000);
    });
  }
  async eval(e) {
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  }
}

const INJECT = `
(function(){
  window.__DOC_ID = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
  window.__WS_LOG = [];
  window.__EV = [];
  window.addEventListener("load", function(){ window.__EV.push("load"); });
  window.addEventListener("pageshow", function(e){ window.__EV.push("pageshow(persisted=" + e.persisted + ")"); });
  window.addEventListener("pagehide", function(e){ window.__EV.push("pagehide(persisted=" + e.persisted + ")"); });
  try {
    var Orig = window.WebSocket;
    function Patched(u, p) {
      try { window.__WS_LOG.push(String(u).replace(/id=[^&]+/, "id=<..>")); } catch (e) {}
      return new Orig(u, p);
    }
    Patched.prototype = Orig.prototype;
    window.WebSocket = Patched;
  } catch (e) { window.__WS_PATCH_ERR = String(e && e.message); }
})();
`;

const READ = `
(function(){
  var out = { url: location.href, docId: window.__DOC_ID || null,
              ev: window.__EV || null, ws: window.__WS_LOG || null };
  var txt = (document.body && document.body.innerText) || "";
  out.banner = txt.indexOf("与内核的连接已断开") >= 0;
  out.isAuthPage = txt.indexOf("访问授权码") >= 0 || !!document.querySelector("input[type=password]");
  out.title = (document.title || "").slice(0, 24);
  try {
    var w = window.siyuan && window.siyuan.ws;
    out.ready = (w && w.ws && typeof w.ws.readyState === "number") ? w.ws.readyState : null;
  } catch (e) {}
  out.cookieVisible = document.cookie.indexOf("siyuan=") >= 0 ? "可见" : "不可见(HttpOnly)";
  return out;
})()
`;

(async () => {
  console.log("=".repeat(72));
  console.log("忠实复现：登录页 →(登录)→ 应用 →(后退)→ 登录页 →(前进)→ 应用");
  console.log("=".repeat(72));

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
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Network.clearBrowserCookies");

  /* [1] 未认证打开 / → 登录页 */
  console.log("\n[1] 清空 cookie 后打开 " + SIYUAN + "/");
  await cdp.send("Page.navigate", { url: SIYUAN + "/" });
  await sleep(5000);
  const s1 = await cdp.eval(READ);
  console.log("    " + JSON.stringify(s1));
  if (!s1.isAuthPage) { console.log("    ⚠️ 没落在登录页，后续可能复现不到"); }

  /* [2] 用登录页真实 UI 登录 */
  console.log("\n[2] 在登录页填入授权码并提交（走真实 UI）");
  const dom = await cdp.eval(`
    (function(){
      var ins = Array.from(document.querySelectorAll("input")).map(function(i){
        return { type: i.type, id: i.id, cls: (i.className||"").slice(0,40), ph: i.placeholder||"" }; });
      var bs = Array.from(document.querySelectorAll("button,.b3-button,[class*=btn]")).map(function(b){
        return { tag: b.tagName, id: b.id, cls: (b.className||"").slice(0,50), txt: (b.innerText||"").trim().slice(0,18) }; });
      return { inputs: ins, buttons: bs.slice(0, 12), html: document.body.innerHTML.length };
    })()
  `);
  console.log("    输入框: " + JSON.stringify(dom.inputs));
  console.log("    按钮  : " + JSON.stringify(dom.buttons));

  const loginRes = await cdp.eval(`
    (async function(){
      var code = ${JSON.stringify(AUTH)};
      var inp = document.querySelector("input[type=password]") || document.querySelector("#authCode") || document.querySelector("input");
      if (!inp) return { ok:false, why:"找不到输入框" };
      inp.value = code;
      inp.dispatchEvent(new Event("input", { bubbles:true }));
      inp.dispatchEvent(new Event("change", { bubbles:true }));
      var rm = document.getElementById("rememberMe");
      var btn = document.querySelector("#confirm") || document.querySelector(".b3-button") ||
                Array.from(document.querySelectorAll("button")).find(function(b){ return /确认|登录|确定/.test(b.innerText||""); });
      if (!btn) return { ok:false, why:"找不到提交按钮" };
      var info = { ok:true, input: inp.id || inp.className, rememberMe: rm ? rm.checked : "无此控件",
                   button: (btn.id || btn.className || btn.tagName) };
      btn.click();
      return info;
    })()
  `);
  console.log("    提交: " + JSON.stringify(loginRes));

  // 登录后应当是 location.href = toPath("/") → 再重定向到应用
  await sleep(9000);
  const s2 = await cdp.eval(READ);
  console.log("\n[3] 登录后（应用界面）");
  console.log("    " + JSON.stringify(s2));
  const wsBefore = (s2.ws || []).length;

  /* [4] 后退到登录页，不做任何动作 */
  console.log("\n[4] 【后退】到登录页（不做任何动作，等 4 秒）");
  await cdp.eval("history.back()");
  await sleep(4000);
  const s3 = await cdp.eval(READ);
  console.log("    " + JSON.stringify(s3));

  /* [5] 前进回应用 */
  console.log("\n[5] 【前进】回应用（不做任何动作，等 12 秒）");
  await cdp.eval("history.forward()");
  await sleep(12000);
  const s4 = await cdp.eval(READ);
  console.log("    " + JSON.stringify(s4, null, 1).split("\n").join("\n    "));
  const wsAdded = (s4.ws || []).length - wsBefore;

  /* [6] 判定 */
  const sameDoc = s2.docId && s4.docId && s2.docId === s4.docId;
  console.log("\n" + "=".repeat(72));
  console.log("判定");
  console.log("=".repeat(72));
  console.log("  应用文档指纹  登录后=" + s2.docId + "  前进后=" + s4.docId +
              "  ⇒ " + (sameDoc ? "同一文档**被恢复**（bfcache）" : "整页重载（新文档）"));
  console.log("  应用 WS 建连  进入时 " + wsBefore + " 条 → 前进后 " + (s4.ws || []).length +
              " 条（恢复后新建 " + wsAdded + " 条）");
  console.log("  事件链        " + JSON.stringify(s4.ev));
  console.log("  前进后        横幅=" + s4.banner + "  readyState=" + s4.ready + "  url=" + s4.url);
  console.log("  WS 明细       " + JSON.stringify(s4.ws));

  if (s4.banner) {
    console.log("\n  ✅ 复现成功：前进回来报「与内核的连接已断开」");
    console.log("     恢复后新建 " + wsAdded + " 条 WS ⇒ " +
                (wsAdded > 0 ? "有重连动作但状态不对（可能未认证被内核关掉）" : "根本没有重连动作"));
  } else if (sameDoc) {
    console.log("\n  ℹ️ 走了 bfcache 恢复但**没有**报断连（恢复后新建 " + wsAdded + " 条 WS）。");
    console.log("     ⇒ 说明该路径下思源是能自愈的；用户遇到的情况还需别的条件。");
  } else {
    console.log("\n  ℹ️ 前进走的是整页重载（未走 bfcache），本轮无法复现该现象。");
  }

  try { const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("E:/TEMP/nb-bf2-result.png", Buffer.from(shot.data, "base64")); } catch {}
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exitCode = 2; });

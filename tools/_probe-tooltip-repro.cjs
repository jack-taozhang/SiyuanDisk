/* 复现并量化 tooltip 残留问题
 *
 * 用户报：「弹出后 一直显示"更多" 这俩字」
 * 假设（来自思源 base.css 原文）：
 *   .b3-tooltips::after{ z-index:1000000; content:attr(aria-label); }
 *   .b3-tooltips:hover::after, .b3-tooltips:focus-within::after{ opacity:1 }
 *   .b3-tooltips__s::after{ top:100% }   ← 按钮正下方（就是菜单弹出的位置）
 *   ⇒ 点击后鼠标仍 hover、按钮仍 focus ⇒ tooltip 持续显示且盖在菜单上。
 *
 * 本脚本：模拟「hover + focus + click」，读 ::after 的 computed 样式，并截图对比。
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ★ 本地配置（地址 / 访问授权码 / Chrome / ws）从 _local.cjs 读 ★
//   口令绝不写进脚本 —— 配置源 tools/.nb-local.json 已被 .gitignore 排除。
const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
const PORT = 9342;
const PROFILE = "E:/TEMP/nb-cdp-tip";
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
    const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return r.result.value;
  }
}

(async () => {
  console.log("=".repeat(64));
  console.log("复现：菜单弹出后 tooltip「更多」是否残留（并量化 ::after）");
  console.log("=".repeat(64));

  const cookie = await new Promise((res, rej) => {
    const data = JSON.stringify({ authCode: AUTH });
    const r = http.request(SIYUAN + "/api/system/loginAuth", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (x) => {
      const sc = x.headers["set-cookie"] || [];
      const m = sc.map((c) => /^siyuan=([^;]+)/.exec(c)).find(Boolean);
      x.resume(); x.on("end", () => res(m ? m[1] : null));
    });
    r.on("error", rej); r.write(data); r.end();
  });
  if (!cookie) { console.log("❌ 登录失败"); process.exit(1); }

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1600,1000",
    "--no-proxy-server", "--proxy-bypass-list=<-loopback>", "about:blank",
  ], { stdio: "ignore" });
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await hj("http://127.0.0.1:" + PORT + "/json/version"); break; } catch { await sleep(300); } }
  if (!v) { console.log("❌ CDP 未就绪"); chrome.kill(); process.exit(1); }

  const list = await hj("http://127.0.0.1:" + PORT + "/json/list");
  const page = list.find((t) => t.type === "page");
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCookie", { name: "siyuan", value: cookie, domain: "192.168.193.70", path: "/", httpOnly: true, sameSite: "Lax" });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: SIYUAN + "/" });
  await sleep(6500);

  // 展开面板
  const dt = "siyuan-nebuladisknebuladisk_tree";
  const doClick = `(function(){var e=Array.from(document.querySelectorAll('.dock__item')).find(function(x){return x.getAttribute('data-type')===${JSON.stringify(dt)}});if(e){e.click();return true}return false})()`;
  const probePanel = `(function(){var e=document.querySelector('.nb-tree');return {exists:!!e,w:e?Math.round(e.getBoundingClientRect().width):-1}})()`;
  let panel = { exists: false, w: -1 };
  for (let i = 1; i <= 6; i++) { await cdp.eval(doClick); await sleep(1500); panel = await cdp.eval(probePanel); if (panel.exists && panel.w > 50) break; }
  console.log("  ℹ️  面板: " + JSON.stringify(panel));
  if (!panel.exists || panel.w <= 50) { console.log("❌ 面板未展开"); try{ws.close()}catch{}; try{chrome.kill()}catch{}; process.exit(1); }

  /* 读按钮的 tooltip 相关 computed 样式 */
  const READ = `
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      if (!b) return { err: 'no button' };
      var a = getComputedStyle(b, '::after');
      return {
        cls: b.className,
        ariaLabel: b.getAttribute('aria-label'),
        isHover: b.matches(':hover'),
        isFocusWithin: b.matches(':focus-within'),
        isFocused: document.activeElement === b,
        afterContent: a.content,
        afterOpacity: a.opacity,
        afterDisplay: a.display,
        afterZ: a.zIndex,
        afterTop: a.top
      };
    })()
  `;

  console.log("\n── 1) 初始（未 hover / 未 focus）──");
  console.log("   " + JSON.stringify(await cdp.eval(READ)));

  console.log("\n── 2) 模拟 hover（鼠标移到按钮上）──");
  await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||'')); })[0];
      var r = b.getBoundingClientRect();
      ['mouseover','mouseenter','mousemove'].forEach(function(t){
        b.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window,
          clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2)}));
      });
    })()
  `);
  await sleep(600);
  console.log("   " + JSON.stringify(await cdp.eval(READ)));

  console.log("\n── 3) 点击（会 focus 按钮）→ 菜单打开 ──");
  await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||'')); })[0];
      b.focus();                       // 模拟点击带来的 focus
      var r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window,
        clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2)}));
    })()
  `);
  await sleep(700);
  console.log("   " + JSON.stringify(await cdp.eval(READ)));
  const menuState = await cdp.eval(`
    (function(){ var ms=Array.from(document.querySelectorAll('.b3-menu'));
      var wi=ms.filter(function(m){return m.querySelectorAll('.b3-menu__item').length>0 && m.offsetHeight>0;});
      return { withItems: wi.length }; })()
  `);
  console.log("   菜单状态: " + JSON.stringify(menuState));

  try {
    const s = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync("E:/TEMP/nb-tooltip-repro.png", Buffer.from(s.data, "base64"));
    console.log("   📸 E:/TEMP/nb-tooltip-repro.png");
  } catch {}

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  process.exit(0);
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exit(2); });

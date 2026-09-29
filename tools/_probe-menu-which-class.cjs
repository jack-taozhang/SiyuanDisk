/* 定案：我们插件的 Menu 到底是哪个类？openMenuAt 走了哪条分支？
 *
 * 背景（两个类，别再混）：
 *   A. 内部类 `te`（window.siyuan.menus.menu 的类）：
 *      popup / addItem / append / remove / removeImmediately / ...（24 个方法）
 *      **没有 open，也没有 addSeparator**
 *   B. 包装类（main.js @2133635）：
 *      addItem / addSeparator / showSubMenu / **open(c){ this.menu.popup(c) }** /
 *      fullscreen / close      ← 内部持有 this.menu 指向 A
 *
 * 我们的插件调 menu.addSeparator() 是**有效**的 ⇒ 我们拿到的更像 B。
 * 而 B **有 open()** ⇒ 我此前「Menu 没有 open，所以 menu.open() 抛 TypeError」
 * 这条结论可能是**张冠李戴**（拿 A 的性质去解释 B 的调用）。
 *
 * 本脚本用**调用栈**定案：把 A 的 popup 包一层，打印 `this` 与 stack。
 *   · 若紧邻调用者是我们的插件帧（plugin:siyuan-nebuladisk / index.js）
 *     ⇒ 我们直接调了 popup（即我们的对象自己有 popup 分支）
 *   · 若紧邻调用者是 SiYuan 的包装类帧（open 内部）
 *     ⇒ 我们走的是 open 分支，我们的对象**没有 popup**（= 我们用的是 B）
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ★ 本地配置（地址 / 访问授权码 / Chrome / ws）从 _local.cjs 读 ★
//   口令绝不写进脚本 —— 配置源 tools/.nb-local.json 已被 .gitignore 排除。
const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
const PORT = 9346;
const PROFILE = "E:/TEMP/nb-cdp-which";
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
    this.ws = ws; this.id = 0; this.p = new Map(); this.all = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()); this.all.push(m);
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
  console.log("=".repeat(66));
  console.log("定案：我们的 Menu 是哪个类 / openMenuAt 走了哪条分支");
  console.log("=".repeat(66));

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
  if (!cookie) { console.log("❌ 登录失败"); process.exitCode = 1; return; }

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1600,1000",
    "--no-proxy-server", "--proxy-bypass-list=<-loopback>", "about:blank",
  ], { stdio: "ignore" });
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await hj("http://127.0.0.1:" + PORT + "/json/version"); break; } catch { await sleep(300); } }
  if (!v) { console.log("❌ CDP 未就绪"); chrome.kill(); process.exitCode = 1; return; }

  const list = await hj("http://127.0.0.1:" + PORT + "/json/list");
  const page = list.find((t) => t.type === "page");
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");

  // 收集页面 console（我们插件的 diag 日志也在里面）
  const pageLogs = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === "Runtime.consoleAPICalled") {
      const txt = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      pageLogs.push("[" + m.params.type + "] " + txt);
    }
  });

  await cdp.send("Network.setCookie", { name: "siyuan", value: cookie, domain: "192.168.193.70", path: "/", httpOnly: true, sameSite: "Lax" });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: SIYUAN + "/" });
  await sleep(7000);

  // 展开面板
  const dt = "siyuan-nebuladisknebuladisk_tree";
  const doDock = `(function(){var e=Array.from(document.querySelectorAll('.dock__item')).find(function(x){return x.getAttribute('data-type')===${JSON.stringify(dt)}});if(e){e.click();return true}return false})()`;
  const probePanel = `(function(){var e=document.querySelector('.nb-tree');var b=document.querySelectorAll('.nb-tree-toolbar button').length;return {e:!!e,w:e?Math.round(e.getBoundingClientRect().width):-1,b:b}})()`;
  let panel = { e: false, w: -1, b: 0 };
  for (let i = 1; i <= 10; i++) {
    await cdp.eval(doDock);
    for (let k = 0; k < 8; k++) { await sleep(300); panel = await cdp.eval(probePanel); if (panel.e && panel.w > 50 && panel.b > 0) break; }
    if (panel.e && panel.w > 50 && panel.b > 0) break;
    await sleep(600);
  }
  console.log("面板: " + JSON.stringify(panel));
  if (!(panel.e && panel.w > 50 && panel.b > 0)) { console.log("❌ 面板未展开"); try{ws.close()}catch{} try{chrome.kill()}catch{} process.exitCode=3; return; }

  /* 装 hook：包 A 的 popup，抓 this + stack */
  const hooked = await cdp.eval(`
    (function(){
      var single = window.siyuan && window.siyuan.menus && window.siyuan.menus.menu;
      if (!single) return { ok:false, why:'no singleton' };
      window.__SINGLE = single;
      var proto = Object.getPrototypeOf(single);
      if (!proto || typeof proto.popup !== 'function') return { ok:false, why:'no popup on proto' };
      window.__POPUPS = [];
      var orig = proto.popup;
      proto.popup = function(){
        var st = '';
        try { st = (new Error()).stack || ''; } catch(e){}
        window.__POPUPS.push({
          isSelf: this === window.__SINGLE,
          ctorName: (this && this.constructor && this.constructor.name) || '?',
          ownHasPopup: this ? Object.prototype.hasOwnProperty.call(this, 'popup') : null,
          protoHasPopup: this ? (typeof Object.getPrototypeOf(this).popup) : null,
          argKeys: arguments[0] ? Object.keys(arguments[0]) : null,
          stack: st.split('\\n').slice(0, 10)
        });
        return orig.apply(this, arguments);
      };
      return { ok:true };
    })()
  `);
  console.log("hook: " + JSON.stringify(hooked));

  /* 点击「更多」 */
  await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      if (!b) return;
      var r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,
        clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2)}));
    })()
  `);
  await sleep(1200);

  const pops = await cdp.eval("window.__POPUPS || []");
  const menuState = await cdp.eval(`
    (function(){ var ms=Array.from(document.querySelectorAll('.b3-menu'));
      var wi=ms.filter(function(m){return m.querySelectorAll('.b3-menu__item').length>0 && m.offsetHeight>0;});
      return { withItems: wi.length, items: wi[0]? wi[0].querySelectorAll('.b3-menu__item').length : 0 }; })()
  `);
  console.log("菜单状态: " + JSON.stringify(menuState));
  console.log("\n=== popup 被调用 " + (pops ? pops.length : 0) + " 次 ===");
  (pops || []).forEach((p, i) => {
    console.log("\n【" + (i + 1) + "】");
    console.log("   this === 单例 ?  " + p.isSelf + "   (this.ctor=" + p.ctorName + ")");
    console.log("   this 自有 popup? " + p.ownHasPopup + "   this 原型 popup 类型=" + p.protoHasPopup);
    console.log("   入参 keys: " + JSON.stringify(p.argKeys));
    console.log("   stack:");
    (p.stack || []).forEach((l) => console.log("      " + l.slice(0, 190)));
  });

  console.log("\n=== 页面里与插件有关的日志（末 15 条）===");
  pageLogs.filter((l) => /nebuladisk|plugin:/i.test(l)).slice(-15).forEach((l) => console.log("   " + l.slice(0, 200)));

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exitCode = 2; });

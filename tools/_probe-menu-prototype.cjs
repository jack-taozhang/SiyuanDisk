/* 精确枚举 Menu 实例的**整条原型链**上的方法名
 *
 * 为什么：上一版只枚举了 Object.getPrototypeOf(inst) 的**自有**方法，
 * 于是得出「没有 addSeparator」—— 但插件调 menu.addSeparator() 明明有效
 * （DOM 里确实出现了 .b3-menu__separator）。说明它继承自父类。
 * 结论要写进 skill，必须先把这条链走完，不能留不准确的「方法全集」。
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ★ 本地配置（地址 / 访问授权码 / Chrome / ws）从 _local.cjs 读 ★
//   口令绝不写进脚本 —— 配置源 tools/.nb-local.json 已被 .gitignore 排除。
const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
const PORT = 9345;
const PROFILE = "E:/TEMP/nb-cdp-proto";
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
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1200,800",
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
  await cdp.send("Network.setCookie", { name: "siyuan", value: cookie, domain: "192.168.193.70", path: "/", httpOnly: true, sameSite: "Lax" });
  await cdp.send("Page.navigate", { url: SIYUAN + "/" });
  await sleep(7000);

  // ★ 单例是懒初始化的：实测刚加载完拿不到。
  //   最可靠的办法是**直接打开插件的「更多」菜单** —— 那一刻单例必然在用。
  const dt = "siyuan-nebuladisknebuladisk_tree";
  const doDock = `(function(){var e=Array.from(document.querySelectorAll('.dock__item')).find(function(x){return x.getAttribute('data-type')===${JSON.stringify(dt)}});if(e){e.click();return true}return false})()`;
  const probePanel = `
    (function(){ var e=document.querySelector('.nb-tree');
      var b = document.querySelectorAll('.nb-tree-toolbar button').length;
      return { exists: !!e, w: e ? Math.round(e.getBoundingClientRect().width) : -1, btns: b }; })()
  `;
  let panel = { exists: false, w: -1, btns: 0 };
  for (let i = 1; i <= 10; i++) {
    await cdp.eval(doDock);
    for (let k = 0; k < 8; k++) {
      await sleep(300);
      panel = await cdp.eval(probePanel);
      if (panel.exists && panel.w > 50 && panel.btns > 0) break;
    }
    if (panel.exists && panel.w > 50 && panel.btns > 0) break;
    await sleep(600);
  }
  console.log("面板: " + JSON.stringify(panel));
  if (!(panel.exists && panel.w > 50 && panel.btns > 0)) {
    console.log("❌ 面板未展开，无法继续（驱动抖动）"); try { ws.close(); } catch {} try { chrome.kill(); } catch {}
    process.exitCode = 3; return;
  }

  // 打开「更多」菜单 → 单例必然就绪
  const opened = await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      if (!b) return false;
      var r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,
        clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2)}));
      return true;
    })()
  `);
  await sleep(900);
  const singletonReady = await cdp.eval("!!(window.siyuan && window.siyuan.menus && window.siyuan.menus.menu)");
  console.log("已点开「更多」菜单=" + opened + "  单例可用=" + singletonReady);

  const chain = await cdp.eval(`
    (function(){
      var inst = window.siyuan && window.siyuan.menus && window.siyuan.menus.menu;
      if (!inst) return { err: 'no singleton' };
      var out = [], p = Object.getPrototypeOf(inst), depth = 0;
      while (p && p !== Object.prototype && depth < 6) {
        var name = (p.constructor && p.constructor.name) || '(anonymous)';
        out.push({ depth: depth, ctor: name,
                   methods: Object.getOwnPropertyNames(p)
                     .filter(function(k){ return k !== 'constructor'; }).sort() });
        p = Object.getPrototypeOf(p); depth++;
      }
      var all = {};
      out.forEach(function(l){ l.methods.forEach(function(m){ all[m] = l.depth; }); });

      // ★ addSeparator 不在原型上，但实测它们能插入 .b3-menu__separator
      //   ⇒ 查它到底挂在哪：实例自有属性？还是别处？
      var own = Object.getOwnPropertyNames(inst);
      var hasOwnSep = own.indexOf('addSeparator') >= 0;
      // 真的调一次，看是否抛 + 是否插入 separator 节点
      var before = inst.element ? inst.element.querySelectorAll('.b3-menu__separator').length : -1;
      var callErr = null, ret = null;
      try { ret = inst.addSeparator(); } catch (e) { callErr = String(e && e.message || e); }
      var after = inst.element ? inst.element.querySelectorAll('.b3-menu__separator').length : -1;
      // 清理掉这次测试插入的 separator，别污染单例
      try { if (inst.element && after > before) {
        var seps = inst.element.querySelectorAll('.b3-menu__separator');
        seps[seps.length-1].remove();
      } } catch(e){}

      return { chain: out, allSorted: Object.keys(all).sort(),
               hasOpen: typeof inst.open === 'function',
               hasPopup: typeof inst.popup === 'function',
               hasAddSeparator: typeof inst.addSeparator === 'function',
               ownProps: own.sort(),
               addSeparatorOnInstance: hasOwnSep,
               sepCallErr: callErr, sepReturn: (ret === undefined ? 'undefined' : String(ret)),
               sepBefore: before, sepAfter: after };
    })()
  `);

  console.log("=== 原型链（每层的方法）===");
  (chain.chain || []).forEach((l) => {
    console.log("\n[层 " + l.depth + "] " + l.ctor);
    console.log("   " + l.methods.join(", "));
  });
  console.log("\n=== 全链方法名（去重，共 " + (chain.allSorted || []).length + " 个）===");
  console.log(JSON.stringify(chain.allSorted));
  console.log("\n=== 关键判定 ===");
  console.log("   open         = " + chain.hasOpen);
  console.log("   popup        = " + chain.hasPopup);
  console.log("   addSeparator = " + chain.hasAddSeparator +
              "（实例自有属性? " + chain.addSeparatorOnInstance + "）");
  console.log("   调用 addSeparator 抛错? " + chain.sepCallErr);
  console.log("   separator 数 before/after = " + chain.sepBefore + " / " + chain.sepAfter);
  console.log("\n=== 实例自有属性 ===");
  console.log("   " + JSON.stringify(chain.ownProps));

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exitCode = 2; });

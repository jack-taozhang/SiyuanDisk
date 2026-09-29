/* 诊断图标渲染：菜单项里的 <svg>/<use> 到底有没有画出来
 *
 * 疑问：页面上 querySelectorAll('symbol[id]').length === 0，
 *      但截图里菜单项似乎有图标。必须实测。
 * 本脚本：打开菜单 → 逐项报告 innerText / svg 尺寸 / use 的 href / 该 symbol 是否存在；
 *        另外把文档里 symbol、svg、use 的总数，以及 body 直接子元素 id 都列出来。
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ★ 本地配置（地址 / 访问授权码 / Chrome / ws）从 _local.cjs 读 ★
//   口令绝不写进脚本 —— 配置源 tools/.nb-local.json 已被 .gitignore 排除。
const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
const PORT = 9344;
const PROFILE = "E:/TEMP/nb-cdp-icon2";
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
  console.log("图标渲染诊断：菜单项的 svg/use 是否真的画出来");
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
  await sleep(7000);

  /* --- A. 文档级统计 --- */
  const doc = await cdp.eval(`
    (function(){
      var sym = document.querySelectorAll('symbol').length;
      var symId = document.querySelectorAll('symbol[id]').length;
      var svgs = document.querySelectorAll('svg').length;
      var uses = document.querySelectorAll('use').length;
      // 找所有含 symbol 的子树（可能在 shadowRoot 或非标准位置）
      var roots = [];
      try {
        if (document.head) roots.push('head:' + document.head.querySelectorAll('symbol').length);
        if (document.body) roots.push('body:' + document.body.querySelectorAll('symbol').length);
      } catch(e){}
      var shadowHosts = [];
      document.querySelectorAll('*').forEach(function(el){
        if (el.shadowRoot) shadowHosts.push((el.tagName + '.' + (el.className||'')).slice(0,60));
      });
      var frames = Array.from(document.querySelectorAll('iframe')).map(function(f){ return f.src || '(no src)'; });
      return { symbol: sym, symbolWithId: symId, svg: svgs, use: uses, roots: roots,
               shadowHosts: shadowHosts.slice(0,8), iframes: frames.slice(0,6),
               bodyChildren: Array.from(document.body.children).map(function(c){ return c.tagName + '#' + (c.id||'') + '.' + String(c.className||'').slice(0,40); }).slice(0,20) };
    })()
  `);
  console.log("\n=== A. 文档级统计 ===");
  console.log("   symbol=" + doc.symbol + "  symbol[id]=" + doc.symbolWithId +
              "  svg=" + doc.svg + "  use=" + doc.use);
  console.log("   roots: " + JSON.stringify(doc.roots));
  console.log("   iframes: " + JSON.stringify(doc.iframes));
  console.log("   body 子元素:");
  (doc.bodyChildren || []).forEach((c) => console.log("      " + c));

  /* --- B. 思源自己 UI 上某个图标是否可见（dock 图标）--- */
  const own = await cdp.eval(`
    (function(){
      var item = document.querySelector('.dock__item svg, .dock__item use');
      var svgEl = document.querySelector('.dock__item svg');
      var out = { found: !!svgEl };
      if (svgEl) {
        var r = svgEl.getBoundingClientRect();
        out.rect = { w: Math.round(r.width), h: Math.round(r.height) };
        var u = svgEl.querySelector('use');
        out.href = u ? (u.getAttribute('xlink:href') || u.getAttribute('href')) : null;
        out.symbolExists = out.href ? !!document.getElementById(String(out.href).replace('#','')) : null;
        try { out.bbox = svgEl.getBBox ? { w: Math.round(svgEl.getBBox().width), h: Math.round(svgEl.getBBox().height) } : null; } catch(e){ out.bbox = 'err'; }
      }
      return out;
    })()
  `);
  console.log("\n=== B. 思源自身 dock 图标的渲染 ===");
  console.log("   " + JSON.stringify(own));

  /* --- C. 展开面板 + 打开更多菜单，逐项报告 --- */
  const dt = "siyuan-nebuladisknebuladisk_tree";
  const doClick = `(function(){var e=Array.from(document.querySelectorAll('.dock__item')).find(function(x){return x.getAttribute('data-type')===${JSON.stringify(dt)}});if(e){e.click();return true}return false})()`;
  const probePanel = `(function(){var e=document.querySelector('.nb-tree');return {exists:!!e,w:e?Math.round(e.getBoundingClientRect().width):-1}})()`;
  let panel = { exists: false, w: -1 };
  for (let i = 1; i <= 6; i++) { await cdp.eval(doClick); await sleep(1500); panel = await cdp.eval(probePanel); if (panel.exists && panel.w > 50) break; }
  console.log("\n   面板: " + JSON.stringify(panel));

  if (panel.exists && panel.w > 50) {
    await cdp.eval(`
      (function(){
        var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
          .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
        if (b) { var r=b.getBoundingClientRect();
          b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,
            clientX:Math.round(r.left+r.width/2), clientY:Math.round(r.top+r.height/2)})); }
      })()
    `);
    await sleep(900);

    const items = await cdp.eval(`
      (function(){
        var ms = Array.from(document.querySelectorAll('.b3-menu'));
        var m = ms.filter(function(x){ return x.querySelectorAll('.b3-menu__item').length>0 && x.offsetHeight>0; })[0];
        if (!m) return { err:'菜单未开' };
        return Array.from(m.querySelectorAll('.b3-menu__item')).map(function(it){
          var svg = it.querySelector('svg');
          var use = it.querySelector('use');
          var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href')) : null;
          var id = href ? String(href).replace('#','') : null;
          var r = svg ? svg.getBoundingClientRect() : null;
          var cs = svg ? getComputedStyle(svg) : null;
          return { text: (it.innerText||'').trim(),
                   iconAttr: it.querySelector('.b3-menu__icon') ? 'has .b3-menu__icon' : 'NO icon span',
                   href: href, symbolExists: id ? !!document.getElementById(id) : null,
                   svgW: r ? Math.round(r.width) : -1, svgH: r ? Math.round(r.height) : -1,
                   fill: cs ? cs.fill : null, color: cs ? cs.color : null };
        });
      })()
    `);
    console.log("\n=== C. 更多菜单逐项图标状态 ===");
    if (items.err) console.log("   " + items.err);
    else items.forEach((it) => console.log("   " + JSON.stringify(it)));

    // 也试一下：往菜单里塞一个"肯定存在的图标"看能不能画出来
    const probe = await cdp.eval(`
      (function(){
        var ids = Array.from(document.querySelectorAll('svg[id]')).map(function(s){return s.id;});
        var syms = Array.from(document.querySelectorAll('symbol')).map(function(s){return s.id;});
        return { svgIds: ids, symbolCount: syms.length, symbolSample: syms.slice(0,10),
                 innerSVGLen: (document.querySelector('svg')||{}).outerHTML ? document.querySelector('svg').outerHTML.length : 0 };
      })()
    `);
    console.log("\n=== D. DOM 里有没有 svg[id] / symbol ===");
    console.log("   " + JSON.stringify(probe));
  }

  try { const s = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync("E:/TEMP/nb-icon-diag.png", Buffer.from(s.data, "base64")); console.log("\n📸 E:/TEMP/nb-icon-diag.png"); } catch {}

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  process.exit(0);
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exit(2); });

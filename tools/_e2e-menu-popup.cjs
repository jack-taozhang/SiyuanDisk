/* E2E：真实浏览器里验证「更多」菜单与节点右键菜单真的能显示且**留得住**
 *
 * 背景（两层根因，都已修）：
 *   ① Menu 类没有 open()，只有 popup() ⇒ 老代码 menu.open() 抛 TypeError
 *   ② 按钮缺 data-menu="true" ⇒ 菜单刚弹出就被思源的全局 click 处理器 remove()
 * 本脚本证明修复后：点击 → 菜单出现 → 采样 120/520/1520ms 都还在 → 6 个菜单项正确。
 *
 * ★ 不用 CDP Input.dispatchMouseEvent ★
 *   实测：headless 下 CDP 原生鼠标事件打到正确坐标也**不触发**按钮的 onclick
 *   （计数器实测 cdpCalls=0）。改用对**真实 DOM 按钮**派发合成 MouseEvent ——
 *   事件会正常冒泡（这正是第 ② 层根因的触发条件），因此能真实检验
 *   「思源的全局 click 处理器会不会把菜单关掉」。
 *
 * 用法：node tools/_e2e-menu-popup.cjs
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ★ 本地配置（地址 / 访问授权码 / Chrome / ws）从 _local.cjs 读 ★
//   口令绝不写进脚本 —— 配置源 tools/.nb-local.json 已被 .gitignore 排除。
const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
const PORT = 9341;
const PROFILE = "E:/TEMP/nb-cdp-e2e";
/* ★ 不要用 process.exit() ★
 *  当 stdout 被管道接走时（例如 `node tools/_e2e-menu-popup.cjs | grep 结果`），
 *  process.exit() 会**截断尚未 flush 的输出** —— 实测表现很迷惑：
 *  明明跑了「31 通过 0 失败」，管道里却读到空，于是误判成「脚本没输出/挂了」。
 *  改用 process.exitCode + 正常返回，让 Node 自己收尾 flush。
 */
function done(code) { process.exitCode = code; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  \u2705 " + m); } else { fail++; console.log("  \u274c " + m); } };

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

/* 菜单状态采样：只有「可见 且 有 .b3-menu__item」才算真的显示 */
const SNAP = `
  (function(){
    var ms = Array.from(document.querySelectorAll('.b3-menu'));
    var vis = ms.filter(function(m){ var s=getComputedStyle(m);
      return s.display!=='none' && s.visibility!=='hidden' && m.offsetHeight>0; });
    var withItems = vis.filter(function(m){ return m.querySelectorAll('.b3-menu__item').length>0; });
    var src = withItems[0] || null;
    return { visible: vis.length, withItems: withItems.length,
             items: src ? Array.from(src.querySelectorAll('.b3-menu__item'))
                     .map(function(i){ return (i.innerText||'').trim(); }).filter(Boolean) : [] };
  })()
`;

(async () => {
  console.log("=".repeat(64));
  console.log("E2E：更多菜单 / 节点右键菜单 —— 能否真的显示并留住");
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
  if (!cookie) { console.log("❌ 登录失败"); done(1); return; }
  ok(true, "登录成功（拿到 siyuan session cookie）");

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1600,1000",
    "--no-proxy-server", "--proxy-bypass-list=<-loopback>", "about:blank",
  ], { stdio: "ignore" });
  let v = null;
  for (let i = 0; i < 40; i++) { try { v = await hj("http://127.0.0.1:" + PORT + "/json/version"); break; } catch { await sleep(300); } }
  if (!v) { console.log("❌ CDP 未就绪"); chrome.kill(); done(1); return; }
  ok(true, "Chrome CDP 就绪");

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
  console.log("  ℹ️  页面: " + (await cdp.eval("location.href")));

  /* 展开网盘面板（多策略重试，直到 .nb-tree 存在且宽度 > 50） */
  //
  //  ★ 这里是**已知抖动点**：思源的 dock__item 是开关语义 —— 若该面板
  //    已经是「活动」态，点一下反而会**收起**它，于是「点一次就开」并不成立。
  //    实测跑几次会出现「尝试 1/2/3 都是 exists=false，第 4 次才开」。
  //    所以：多轮重试 + 每轮之后不只等固定时间，而是等到
  //    `.nb-tree-toolbar` 里真的出现按钮为止。
  //    这不是产品问题（不是 flaky 的产品，是 flaky 的驱动方式）。
  const dt = "siyuan-nebuladisknebuladisk_tree";
  const doClick = `(function(){var e=Array.from(document.querySelectorAll('.dock__item')).find(function(x){return x.getAttribute('data-type')===${JSON.stringify(dt)}});if(e){e.click();return true}return false})()`;
  const probePanel = `
    (function(){ var e=document.querySelector('.nb-tree');
      var btns = document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn').length;
      return { exists: !!e, w: e ? Math.round(e.getBoundingClientRect().width) : -1, btns: btns }; })()
  `;
  let panel = { exists: false, w: -1, btns: 0 };
  for (let i = 1; i <= 10; i++) {
    await cdp.eval(doClick);
    // 等面板 + 工具条按钮都出现（最多 2.4s）
    for (let k = 0; k < 8; k++) {
      await sleep(300);
      panel = await cdp.eval(probePanel);
      if (panel.exists && panel.w > 50 && panel.btns > 0) break;
    }
    console.log("     展开尝试 " + i + " → exists=" + panel.exists + " width=" + panel.w + " 按钮数=" + panel.btns);
    if (panel.exists && panel.w > 50 && panel.btns > 0) break;
    await sleep(600);
  }
  ok(panel.exists && panel.w > 50, "网盘面板已展开（宽度 " + panel.w + "px）");
  ok(panel.btns > 0, "工具条已渲染出按钮（" + panel.btns + " 个）");
  if (!(panel.exists && panel.w > 50 && panel.btns > 0)) {
    console.log("❌ 面板始终未能展开，后续场景无法进行（这是驱动方式抖动，不是产品失败）");
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    done(3);
    return;
  }

  /* 按钮必须带 data-menu="true"（这是第②层根因的修复点） */
  const btnInfo = await cdp.eval(`
    (function(){
      var bs = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'));
      return bs.map(function(b){ return { label: (b.getAttribute('aria-label')||'').slice(0,14),
        dataMenu: b.getAttribute('data-menu'), hasOnclick: typeof b.onclick === 'function' }; });
    })()
  `);
  console.log("  ℹ️  工具条按钮: " + JSON.stringify(btnInfo));
  const moreBtn = (btnInfo || []).find((b) => /更多/.test(b.label));
  ok(!!moreBtn, "找到「更多」按钮");
  ok(moreBtn && moreBtn.dataMenu === "true",
     "★★ 「更多」按钮带 data-menu=\"true\"（否则菜单会被思源全局 click 处理器秒关）");
  ok(moreBtn && moreBtn.hasOnclick, "「更多」按钮绑定了 onclick");
  if (!moreBtn) {
    // 干净地失败，别让后面的 getComputedStyle(undefined) 抛 TypeError 把结果搅浑
    console.log("❌ 找不到「更多」按钮，点击类场景无法进行");
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    done(3);
    return;
  }

  /* ===== 场景 1：点击「更多」→ 菜单必须显示且留得住 ===== */
  console.log("\n── 场景 1：点击「更多」 ──");
  const r1 = await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      if (!b) return { ok:false };
      var r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window,
        clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2) }));
      return { ok:true, sync: ${SNAP} };
    })()
  `);
  console.log("   同步: " + JSON.stringify(r1.sync));
  await sleep(120);
  const s120 = await cdp.eval(SNAP); console.log("   +120ms : " + JSON.stringify(s120));
  await sleep(400);
  const s520 = await cdp.eval(SNAP); console.log("   +520ms : " + JSON.stringify(s520));
  await sleep(1000);
  const s1520 = await cdp.eval(SNAP); console.log("   +1520ms: " + JSON.stringify(s1520));

  ok(s120.withItems >= 1, "★ 点击后 120ms 菜单仍在（含菜单项）");
  ok(s520.withItems >= 1, "★★ 点击后 520ms 菜单仍在 —— 没有被思源秒关");
  ok(s1520.withItems >= 1, "★★★ 点击后 1520ms 菜单仍在 —— 稳定显示，不是一闪而过");

  const items = (s1520.items.length ? s1520.items : (s520.items.length ? s520.items : s120.items));
  console.log("  ℹ️  菜单项: " + JSON.stringify(items));
  ok(items.length === 5, "菜单项恰好 5 项（实际 " + items.length + "）");
  ok(items.some((t) => /^刷新$/.test(t)), "含「刷新」");
  // ★ 反向：2026-09-28 用户要求「删除 刷新并重置展开状态 按钮及其功能」
  ok(!items.some((t) => /刷新并重置/.test(t)),
     "★ 不含「刷新并重置展开状态」（已按要求删除，反向断言防加回）");
  ok(items.some((t) => /全部折叠/.test(t)), "含「全部折叠」");
  ok(items.some((t) => /插件设置/.test(t)), "含「插件设置」");
  // ★ 改名：2026-09-28「在浏览器中打开网盘」→「打开网盘」
  ok(items.some((t) => /^打开网盘$/.test(t)), "★ 含「打开网盘」（新名字）");
  ok(!items.some((t) => /在浏览器中打开网盘/.test(t)),
     "★ 不含旧名「在浏览器中打开网盘」（改名后不留旧串）");
  ok(items.some((t) => /退出登录/.test(t)), "含「退出登录」");

  /* ---- 每一项的图标必须指向**真实存在**的 symbol ---- */
  //
  //  ★ 为什么必须测：这类错误是**静默**的 —— <use xlink:href="#图标名">
  //    指向不存在的 symbol 时，浏览器既不报错也不白屏，只是画出一片空白。
  //    真事：菜单「退出登录」原本写 icon:"iconLogout"，而思源雪碧图里
  //    根本没有这个 symbol ⇒ 用户看到的就是「这一项没有图标」。
  //    只靠肉眼看截图很容易漏（也可能误判别的项）。
  //    所以这里逐项报 href + document.getElementById(icon) 是否为 null。
  const icons = await cdp.eval(`
    (function(){
      var ms = Array.from(document.querySelectorAll('.b3-menu'));
      var m = ms.filter(function(x){ return x.querySelectorAll('.b3-menu__item').length>0 && x.offsetHeight>0; })[0];
      if (!m) return { err: '菜单未开' };
      return Array.from(m.querySelectorAll('.b3-menu__item')).map(function(it){
        var use = it.querySelector('use');
        var href = use ? (use.getAttribute('xlink:href') || use.getAttribute('href') || '') : '';
        var id = href ? String(href).replace('#','') : '';
        var svg = it.querySelector('svg');
        var r = svg ? svg.getBoundingClientRect() : null;
        return { text: (it.innerText||'').trim(), href: href || null,
                 symbolExists: id ? !!document.getElementById(id) : false,
                 svgW: r ? Math.round(r.width) : -1 };
      });
    })()
  `);
  console.log("  ℹ️  逐项图标: " + JSON.stringify(icons));

  if (!icons.err) {
    const missing = icons.filter((x) => !x.symbolExists);
    ok(missing.length === 0,
       "★★ 每个菜单项的图标 symbol 都真实存在（缺失 " + missing.length + " 个" +
       (missing.length ? "：" + JSON.stringify(missing.map((x) => x.text + "→" + x.href)) : "") + "）");
    const quit = icons.find((x) => /退出登录/.test(x.text));
    ok(!!quit && quit.href === "#iconQuit",
       "★★ 「退出登录」用 iconQuit（实际 " + (quit && quit.href) + "）；不许改回 iconLogout");
    ok(!!quit && quit.svgW > 0,
       "★★ 「退出登录」的图标有实际渲染尺寸（width=" + (quit && quit.svgW) + "px）");
  }

  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync("E:/TEMP/nb-e2e-more-menu.png", Buffer.from(shot.data, "base64"));
    console.log("  📸 E:/TEMP/nb-e2e-more-menu.png");
  } catch {}

  /* 关掉菜单（点空白）——证明关闭逻辑健在，而不是「一直开着」 */
  await cdp.eval(`(function(){ document.body.click(); return true; })()`);
  await sleep(600);
  const closed = await cdp.eval(SNAP);
  ok(closed.withItems === 0, "点空白后菜单正常关闭（说明关闭逻辑健在，不是一直开着）");

  /* ===== 场景 2：节点右键菜单 ===== */
  console.log("\n── 场景 2：文件树节点右键菜单 ──");
  const nodeInfo = await cdp.eval(`
    (function(){
      var rows = Array.from(document.querySelectorAll('.nb-node'));
      return { count: rows.length, first: rows[0] ? {
        name: rows[0].getAttribute('data-name'), isDir: rows[0].getAttribute('data-is-dir'),
        cls: rows[0].className } : null };
    })()
  `);
  console.log("  ℹ️  节点行: " + JSON.stringify(nodeInfo));
  ok(nodeInfo.count > 0, "文件树里存在节点行（" + nodeInfo.count + " 个）");

  if (nodeInfo.count > 0) {
    const r2 = await cdp.eval(`
      (function(){
        var row = document.querySelector('.nb-node');
        if (!row) return { ok:false };
        var r = row.getBoundingClientRect();
        var ev = new MouseEvent('contextmenu', { bubbles:true, cancelable:true, view:window,
          clientX: Math.round(r.left+30), clientY: Math.round(r.top+r.height/2) });
        row.dispatchEvent(ev);
        return { ok:true, sync: ${SNAP} };
      })()
    `);
    console.log("   右键同步: " + JSON.stringify(r2.sync));
    await sleep(600);
    const s2 = await cdp.eval(SNAP);
    console.log("   +600ms  : " + JSON.stringify(s2));
    ok(s2.withItems >= 1, "★ 节点右键菜单能显示且留住（含菜单项）");
    ok(s2.items.length > 0, "节点菜单项数 = " + s2.items.length + "：" + JSON.stringify(s2.items.slice(0, 8)));

    try {
      const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync("E:/TEMP/nb-e2e-node-menu.png", Buffer.from(shot2.data, "base64"));
      console.log("  📸 E:/TEMP/nb-e2e-node-menu.png");
    } catch {}
  }

  /* ===== 场景 3：菜单打开期间，按钮自己的 tooltip「更多」必须被压住 ===== */
  //
  //  用户反馈：「弹出后 一直显示『更多』这俩字」。
  //  思源 base.css：.b3-tooltips:hover::after / :focus-within::after { opacity:1 }
  //  且 .b3-tooltips::after{ z-index:1000000; content:attr(aria-label) }
  //  点击后按钮**保持焦点** ⇒ :focus-within 恒真 ⇒ tooltip 一直盖在菜单上。
  //  修复：弹菜单时给按钮加 .is-menu-open，CSS 里 display:none 压掉。
  //
  //  ★ 必须显式 focus()：真实点击会让按钮获得焦点（mousedown 默认行为），
  //    而合成 MouseEvent 不会 —— 不 focus 就复现不出这个 bug，会测成假绿。
  console.log("\n── 场景 3：tooltip「更多」是否被压住 ──");
  await cdp.eval(`(function(){ document.body.click(); return true; })()`);
  await sleep(500);
  const tip = await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      if (!b) return { err:'no button' };
      b.focus();                     // 模拟真实点击带来的焦点
      var r = b.getBoundingClientRect();
      var before = getComputedStyle(b, '::after');
      var snapBefore = { content: before.content, opacity: before.opacity, display: before.display,
                         z: before.zIndex, focusWithin: b.matches(':focus-within'),
                         cls: b.className };
      b.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window,
        clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2) }));
      var after = getComputedStyle(b, '::after');
      return { snapBefore: snapBefore,
               snapAfter: { content: after.content, opacity: after.opacity, display: after.display,
                            z: after.zIndex, focusWithin: b.matches(':focus-within'),
                            cls: b.className } };
    })()
  `);
  console.log("   点击前: " + JSON.stringify(tip.snapBefore));
  console.log("   点击后: " + JSON.stringify(tip.snapAfter));
  await sleep(700);
  const tipLater = await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      var a = getComputedStyle(b, '::after');
      var ms = Array.from(document.querySelectorAll('.b3-menu'));
      var wi = ms.filter(function(m){ return m.querySelectorAll('.b3-menu__item').length>0 && m.offsetHeight>0; });
      return { opacity: a.opacity, display: a.display, cls: b.className,
               hasMenuOpen: wi.length, items: wi[0] ? wi[0].querySelectorAll('.b3-menu__item').length : 0 };
    })()
  `);
  console.log("   +700ms: " + JSON.stringify(tipLater));

  ok(tip.snapBefore && tip.snapBefore.content === '"更多"',
     'tooltip 内容确实是「更多」（content=' + (tip.snapBefore && tip.snapBefore.content) + '）');
  ok(tip.snapAfter && /is-menu-open/.test(tip.snapAfter.cls || ""),
     "★ 弹菜单后按钮带 .is-menu-open（抑制类已生效）");
  ok(tip.snapAfter && tip.snapAfter.display === "none",
     "★★ 弹菜单后 ::after 的 display=none —— tooltip 被压住（实际 " + (tip.snapAfter && tip.snapAfter.display) + "）");
  ok(tipLater.display === "none",
     "★★★ 菜单开着期间 ::after 始终 display=none（不会「一直显示」）");
  ok(tipLater.hasMenuOpen >= 1,
     "★ 抑制 tooltip 没有把菜单一起压掉（菜单仍在，含 " + tipLater.items + " 项）");

  // ★ 趁菜单还开着截图 —— 这张图要能看出「菜单在，但 tooltip 不在」
  try {
    const shot3 = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync("E:/TEMP/nb-e2e-tooltip.png", Buffer.from(shot3.data, "base64"));
    console.log("  📸 E:/TEMP/nb-e2e-tooltip.png（菜单开着 + tooltip 已压住）");
  } catch {}

  // 关掉菜单后，抑制类应当被移除（tooltip 恢复正常可用）
  await cdp.eval(`(function(){ document.body.click(); return true; })()`);
  await sleep(400);
  const tipRestored = await cdp.eval(`
    (function(){
      var b = Array.from(document.querySelectorAll('.nb-tree-toolbar button, .nb-tree-toolbar .nb-tree-btn'))
        .filter(function(x){ return /更多/.test((x.getAttribute('aria-label')||x.title||'')); })[0];
      return { cls: b.className, hasSuppress: b.classList.contains('is-menu-open') };
    })()
  `);
  ok(!tipRestored.hasSuppress,
     "关菜单后 .is-menu-open 被移除（tooltip 恢复可用，不是永久禁用）");

  console.log("\n" + "=".repeat(64));
  console.log("结果: " + pass + " 通过, " + fail + " 失败");
  console.log("=".repeat(64));

  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  done(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("脚本异常:", e && e.stack || e); done(2); });

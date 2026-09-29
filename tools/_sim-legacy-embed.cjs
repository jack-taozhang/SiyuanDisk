/**
 * 回归：旧写法嵌入块的就地重绘（migrateLegacyEmbeds）
 *
 * 复刻思源的真实 DOM 契约：
 *   <div data-type="NodeCustomBlock"
 *        data-info="nebuladisk"                       ← 旧写法
 *        data-content='{"kind":"file","mount":...,"path":...}'>
 *     <pre>{"kind":"file",...}</pre>                     ← 思源把内容按字面显示
 *     <div class="protyle-attr"></div>
 *   </div>
 *
 * 期望：调 migrateLegacyEmbeds 后
 *   · 裸 <pre> 消失，换成 .custom-block__content 容器
 *   · 渲染器被调用，容器里出现 .nb-embed 节点
 *   · 块的 data-info 保持原样（我们不改笔记）
 *   · 幂等：非 force 情况下第二次不重复渲染
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ★ 产物路径用**候选列表**，不要硬编码单一路径 ★
//   本机思源安装位只在开发机存在；换台机器（或 CI）会直接 readFileSync 抛错。
//   顺序：命令行参数 > 仓库 dist/ > 本机思源安装位。
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_CANDIDATES = [
  ...(process.argv[2] ? [process.argv[2]] : []),
  path.join(ROOT, "dist", "index.js"),
  "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js",
];
let BUNDLE = null;
for (const c of BUNDLE_CANDIDATES) {
  if (fs.existsSync(c)) { BUNDLE = c; break; }
}
if (!BUNDLE) {
  console.log("找不到构建产物 index.js，请先运行 node tools/build.js --repo");
  process.exit(1);
}
const code = fs.readFileSync(BUNDLE, "utf8");

/* ---------- 极简 DOM ---------- */
/** 递归解析一段 HTML（只认标签/class/xlink:href 与文本，够插件用） */
function parseHTML(html) {
  const out = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const raw = html.slice(lt + 1, gt);
    // 结束标签
    if (raw.startsWith("/")) { i = gt + 1; continue; }
    // 自闭合
    const selfClose = raw.endsWith("/");
    const tag = raw.replace(/\/$/, "").split(/[\s]/)[0];
    const attrStr = raw.slice(tag.length);
    i = gt + 1;

    const el = new El(tag);
    const cm = /class="([^"]*)"/.exec(attrStr);
    if (cm) el.className = cm[1];
    const xm = /xlink:href="([^"]*)"/.exec(attrStr);
    if (xm) el.setAttribute("xlink:href", xm[1]);
    const im = /id="([^"]*)"/.exec(attrStr);
    if (im) el.setAttribute("id", im[1]);

    if (!selfClose) {
      // 找到配对的结束标签（考虑嵌套）
      const close = `</${tag}>`;
      let depth = 1, j = i;
      while (depth > 0) {
        const nextOpen = html.indexOf(`<${tag}`, j);
        const nextClose = html.indexOf(close, j);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) { depth++; j = nextOpen + 1; }
        else { depth--; j = nextClose + close.length; }
      }
      const inner = html.slice(i, depth === 0 ? j - close.length : html.length);
      i = depth === 0 ? j : html.length;
      for (const n of parseHTML(inner)) el.appendChild(n);
    }
    out.push(el);
  }
  return out;
}

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); this.el._cls = this.set; }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.classList = new ClassList(this);
    this.style = {};
    this.textContent = "";
    this._html = "";
    this._listeners = {};
  }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return Array.from(this.classList.set).join(" "); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(typeof c === "string" ? Object.assign(new El("span"), { textContent: c }) : c)); }
  insertBefore(c, ref) {
    c.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  remove() { if (this.parentElement) { const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); } }
  get ownerDocument() { return document; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    for (const n of parseHTML(this._html)) this.appendChild(n);
  }
  get innerHTML() { return this._html || ""; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const match = (el) => {
      if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
      if (sel.startsWith("[")) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
        if (!m) return false;
        const v = el.getAttribute(m[1]);
        return m[2] === undefined ? v !== null : v === m[2];
      }
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  closest() { return null; }

  /* 说明：这里手写一个**递归**的迷你 HTML 解析器。
   * 不能用正则 —— 模板里有 <span class="x"><svg/><span class="y"></span></span>
   * 这种嵌套，非贪婪正则会把内层也一并吃掉，导致 querySelector(".y") 找不到。 */
}

// 文档树：body > protyle-wysiwyg > [customBlock]
const body = new El("body");
const wys = new El("div"); wys.classList.add("protyle-wysiwyg"); body.appendChild(wys);

function makeLegacyBlock(info, contentObj) {
  const blk = new El("div");
  blk.setAttribute("data-type", "NodeCustomBlock");
  blk.setAttribute("data-info", info);
  const content = JSON.stringify(contentObj);
  blk.setAttribute("data-content", content);
  // 思源的降级显示：把内容原样塞进 <pre>
  const pre = new El("pre"); pre.textContent = content;
  blk.appendChild(pre);
  const attr = new El("div"); attr.classList.add("protyle-attr");
  blk.appendChild(attr);
  wys.appendChild(blk);
  return blk;
}

const b1 = makeLegacyBlock("nebuladisk", { kind: "file", mount: "售前项目", path: "/a.docx", name: "a.docx" });
const b2 = makeLegacyBlock("siyuan-nebuladisk", { kind: "tree", mount: "售前项目", path: "/x" });
const b3 = makeLegacyBlock("siyuan-nebuladisk/nebuladisk", { kind: "file", mount: "售前项目", path: "/new.pdf" }); // 新写法，不该被我们动

const document = {
  body,
  documentElement: body,
  createElement: (t) => new El(t),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener: () => {},
};

/* ---------- 浏览器全局 ---------- */
let fetchCalls = [];
const sandbox = {
  console, setTimeout, clearTimeout, Buffer, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Map, Set, WeakMap, Symbol, URLSearchParams,
  document,
  location: { hostname: "192.168.193.70", href: "http://192.168.193.70:6806/stage/build/desktop/" },
  navigator: { userAgent: "Mozilla/5.0" },
  window: null,
  fetch: async (url, opts) => {
    fetchCalls.push(String(url));
    return { ok: true, status: 200, headers: { get: () => "*" }, json: async () => ({ code: 0, data: { entries: [] } }), text: async () => "{}" };
  },
  MutationObserver: class { constructor() {} observe() {} disconnect() {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  MutationObserver: class { constructor() {} observe() {} disconnect() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

/* ---------- 加载插件（复刻思源加载器） ---------- */
// ★ 关键：new Function 的作用域链指向**真正的 Node 全局**，
//   所以 document / MutationObserver 必须挂到 global 上，
//   只放进 sandbox 对象是看不见的。
global.document = document;
global.MutationObserver = class { constructor() {} observe() {} disconnect() {} };
global.window = sandbox;
global.self = sandbox;
global.location = sandbox.location;
global.navigator = sandbox.navigator;
global.fetch = sandbox.fetch;

const siyuanStub = {
  Plugin: class Plugin {
    constructor(opts) { Object.assign(this, opts || {}); this.name = (opts && opts.name) || "x"; }
    addIcons() {} addTab() {} addDock() {} addTopBar() {} addCommand() {}
    loadData() { return Promise.resolve(null); }
    saveData() { return Promise.resolve(); }
    eventBus = { on() {}, off() {}, emit() {} };
  },
  showMessage() {}, confirm() { return Promise.resolve(true); },
  getFrontend: () => "browser-desktop",
  getBackend: () => "docker",
};
const req = (spec) => {
  if (spec === "siyuan") return siyuanStub;
  throw new Error(`Cannot find module '${spec}'（浏览器环境没有 window.require）`);
};

const moduleObj = { exports: {} };
let Plugin;
try {
  const factory = new Function("require", "module", "exports", "window", code);
  factory(req, moduleObj, moduleObj.exports, sandbox);
} catch (e) {
  console.error("✗ 脚本执行失败:", e.message);
  process.exit(1);
}
Plugin = moduleObj.exports?.default || moduleObj.exports;
console.log("✅ bundle 执行成功，导出:", typeof Plugin);

/* ---------- 实例化 + onload ---------- */
const inst = new Plugin({
  name: "siyuan-nebuladisk",
  displayName: "NebulaDisk",
  i18n: { dockTitle: "NebulaDisk", settingsTitle: "设置" },
  app: {},
  addIcons() {}, addTab() {}, addDock() {}, addTopBar() {}, addCommand() {}, loadData: async () => null, saveData: async () => {},
});
inst.name = "siyuan-nebuladisk";
inst.i18n = { dockTitle: "NebulaDisk", settingsTitle: "设置" };

(async () => {
  await inst.onload();
  console.log("✅ onload 完成\n");

  // 手动取出 migrateLegacyEmbeds（从 bundle 内部不好拿，改用 onLayoutReady 路径）
  // onLayoutReady 会注册 MutationObserver + setTimeout(run) —— 直接调它
  inst.onLayoutReady();

  // 等首轮 setTimeout（1200ms）跑完
  await new Promise(r => setTimeout(r, 1600));

  console.log("=== 断言 ===");
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };

  // b1 / b2：旧写法 → 应被重绘
  for (const [label, blk] of [["b1(data-info=nebuladisk)", b1], ["b2(data-info=siyuan-nebuladisk)", b2]]) {
    const box = Array.from(blk.children).find(c => c.classList.contains("custom-block__content"));
    ok(`${label} 出现 .custom-block__content 容器`, !!box);
    ok(`${label} 裸 <pre> 已移除`, !blk.children.some(c => c.tagName === "PRE"));
    ok(`${label} 渲染出 .nb-embed 节点`, !!(box && box.querySelector(".nb-embed")));
    ok(`${label} data-info 未被改动`, blk.getAttribute("data-info") !== "siyuan-nebuladisk/nebuladisk");
    ok(`${label} 非 force 情况下只渲染一次`, blk.dataset.nbLegacyRendered === "1");
  }

  // b3：新写法 → 不该被我们动（仍保留思源的裸 <pre>）
  const b3box = Array.from(b3.children).find(c => c.classList.contains("custom-block__content"));
  ok("b3(新写法) 未被本插件重绘（保持思源原状）", !b3box && b3.children.some(c => c.tagName === "PRE"));
  ok("b3 未被标记 nbLegacyRendered", b3.dataset.nbLegacyRendered !== "1");

  // 幂等：再调一次不该重复渲染
  const cb1 = Array.from(b1.children).find(c => c.classList.contains("custom-block__content"));
  const cntBefore = cb1 ? cb1.children.length : -1;
  inst.onLayoutReady();
  await new Promise(r => setTimeout(r, 1600));
  const cb1b = Array.from(b1.children).find(c => c.classList.contains("custom-block__content"));
  ok("二次调用幂等（不重复渲染）", cb1b && cb1b.children.length === cntBefore);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();

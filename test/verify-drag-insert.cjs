/* verify-drag-insert.cjs — 任务30/#55：拖拽插入契约测试
 *
 * ★ 为什么必须「真跑实现」而不是 grep 源码 ★
 *   任务30 的 bug 恰恰是「源码里有一段 DnD 接线，但它只在 makeNode 里」。
 *   纯 grep 一个 `draggable = true` 会**绿色通过**，却完全测不出
 *   「搜索结果拖不动」。所以本测试用一个真实的（够用的）DOM 桩，
 *   把 tree.js 求值出来，**真的调用** makeResultRow() / makeGridCell() / makeNode()，
 *   然后检查返回的元素上与拖拽相关的**运行时属性**。
 *
 * ★ 反向测试（见 test/reverse-drag.cjs）★
 *   把 attachEmbedDrag 的三处调用删掉一处 → 本测试必须变红。
 *   做不到这一点的断言等于没有断言。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");

/* =====================================================================
 * 一个够用的 DOM 桩
 * ---------------------------------------------------------------------
 * tree.js 用到的东西（已逐一核对，不多不少）：
 *   document.createElement / createElementNS / querySelector(All) /
 *   addEventListener / removeEventListener / elementFromPoint / body
 *   el.appendChild / classList / dataset / style / setAttribute /
 *   getAttribute / getBoundingClientRect / closest / querySelector /
 *   removeChild / innerHTML / textContent / title / onclick / … 
 *   window.getComputedStyle
 * ===================================================================== */
function makeDom() {
  class ClassList {
    constructor(el) { this.el = el; this._set = new Set(); }
    add(...cs) { cs.forEach((c) => c && this._set.add(c)); this._sync(); }
    remove(...cs) { cs.forEach((c) => this._set.delete(c)); this._sync(); }
    contains(c) { return this._set.has(c); }
    toggle(c, f) { const on = f === undefined ? !this._set.has(c) : !!f; on ? this._set.add(c) : this._set.delete(c); this._sync(); return on; }
    _sync() { this.el._className = Array.from(this._set).join(" "); }
    toString() { return Array.from(this._set).join(" "); }
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this._children = [];
      this._attrs = {};
      this._style = {};
      this._inner = "";
      this._className = "";
      this.dataset = {};
      this.parentElement = null;
      this.classList = new ClassList(this);
      // 事件回调属性（tree.js 大量使用 el.onclick = fn 这种写法）
      this.onclick = null; this.ondblclick = null; this.oncontextmenu = null;
      this.ondragstart = null; this.ondragend = null; this.ondragover = null;
      this.ondrop = null; this.ondragenter = null; this.ondragleave = null;
      this.onmousedown = null; this.onmouseup = null; this.onmouseover = null;
      this.onmouseout = null; this.onkeydown = null; this.onchange = null;
      this.draggable = false;
      this.title = "";
      this._text = "";
      this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k]; } };
    }
    get className() { return this._className; }
    set className(v) {
      this._className = String(v || "");
      this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === "class") this.className = v; if (k === "draggable") this.draggable = v !== "false"; }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    removeAttribute(k) { delete this._attrs[k]; }
    hasAttribute(k) { return k in this._attrs; }
    appendChild(c) { if (!c) return c; c.parentElement = this; this._children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.parentElement = null; } return c; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    get children() { return this._children.filter((c) => c.nodeType === 1); }
    get firstElementChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length; }
    get innerHTML() { return this._inner; }
    set innerHTML(v) { this._inner = String(v || ""); this._children = []; }
    get textContent() { return this._text !== "" ? this._text : this._children.map((c) => c.textContent || "").join(""); }
    set textContent(v) { this._text = String(v == null ? "" : v); this._children = []; }
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 }; }
    querySelector(sel) { return this._qs(sel, false)[0] || null; }
    querySelectorAll(sel) { return this._qs(sel, true); }
    _qs(sel, all) {
      const out = [];
      const sels = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
      const walk = (node) => {
        for (const c of node.children) {
          for (const s of sels) {
            if (matchSimple(c, s)) { out.push(c); break; }
          }
          walk(c);
        }
      };
      walk(this);
      return all ? out : out.slice(0, 1);
    }
    closest(sel) {
      let n = this;
      while (n && n.nodeType === 1) { if (String(sel).split(",").some((s) => matchSimple(n, s.trim()))) return n; n = n.parentElement; }
      return null;
    }
    matches(sel) { return String(sel).split(",").some((s) => matchSimple(this, s.trim())); }
    addEventListener() {} removeEventListener() {}
  }

  // 支持：tag / .cls / #id / [attr] / [attr="v"] / tag.cls 的**简单**匹配
  function matchSimple(el, sel) {
    if (!sel || !el) return false;
    let rest = sel;
    // 属性选择器
    const am = /\[([\w-]+)(?:([*^$|~]?=)["']?([^\]"']*)["']?)?\]/.exec(rest);
    if (am) {
      const [, key, op, val] = am;
      const actual = key === "class" ? el.className : (key in el._attrs ? el._attrs[key] : null);
      if (actual == null) return false;
      if (op === "*=") { if (!String(actual).includes(val)) return false; }
      else if (op === "^=") { if (!String(actual).startsWith(val)) return false; }
      else if (op === "=") { if (String(actual) !== val) return false; }
      rest = rest.replace(am[0], "");
    }
    // id
    const im = /#([\w-]+)/.exec(rest);
    if (im) { if (el.getAttribute("id") !== im[1]) return false; rest = rest.replace(im[0], ""); }
    // 类
    const cms = rest.match(/\.([\w-]+)/g) || [];
    for (const cm of cms) { if (!el.classList.contains(cm.slice(1))) return false; }
    // 标签
    const tag = rest.replace(/\.[\w-]+/g, "").replace(/\s/g, "");
    if (tag && !/^[.#\[]/.test(tag) && el.tagName !== tag.toUpperCase()) return false;
    return true;
  }

  const doc = new El("document");
  doc.createElement = (t) => new El(t);
  doc.createElementNS = (_ns, t) => new El(t);
  doc.body = new El("body");
  doc.documentElement = new El("html");
  doc.head = new El("head");
  doc.elementFromPoint = () => null;
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.defaultView = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", userSelect: "auto", pointerEvents: "auto" }) };
  // 让 document 自己也是一个可查询的根
  return doc;
}

/* ---- 把 tree.js 当 CJS 求值（剥 import / export） ---- */
function loadTree() {
  let src = fs.readFileSync(path.join(ROOT, "src/tree.js"), "utf8");

  // 收集 export 名
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m; while ((m = re.exec(src))) names.push(m[1]);

  // 剥掉所有 import 行（我们给桩）
  src = src.replace(/^import\s+[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm, "");
  src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  src += `\nmodule.exports = { ${names.join(", ")} };`;

  const dom = makeDom();
  const ctx = vm.createContext({
    module: { exports: {} }, exports: {},
    console,
    document: dom,
    window: { getComputedStyle: dom.defaultView.getComputedStyle },
    navigator: { userAgent: "node" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("no network in test")),
    // 桩：tree.js 依赖的这些外部符号
    showMessage: () => {}, confirm: () => true, Menu: class { open() {} },
    // ★ tree.js 里从 api.js / proxy.js / icons.js 导入的自由标识符。
    //   真实运行时由 ESM import 提供；这里既然剥掉了 import，就得补齐，
    //   否则任何走到它们的代码路径都会 ReferenceError（会把测试假红）。
    diag: () => {},
    extOf: (n) => String(n || "").split(".").pop().toLowerCase(),
    isEditable: () => false,
    nodeKey: (m, p) => `${m}::${p == null ? "<nil>" : p}`,
    webDiskUrl: () => "http://x/",
    displayMountPath: (m, p) => {
      const mm = String(m == null ? "" : m).trim();
      let pp = String(p == null ? "" : p).trim().replace(/\/{2,}/g, "/");
      if (pp && !pp.startsWith("/")) pp = "/" + pp;
      pp = pp.replace(/\/+$/, "");
      return `${mm}:${pp || "/"}`;
    },
    typeIconEl: (ext, isDir) => {
      const e = new El("svg");
      e.className = "nb-type-icon" + (isDir ? " nb-type-icon--dir" : "");
      e.innerHTML = "<svg></svg>";
      return e;
    },
    insertEmbedIntoDoc: async () => true,
    getActiveEditor: () => null,
    showToast: () => {},
    openTab: () => {},
    getFrontend: () => "",
    platformUtils: {},
    Constants: {},
    Protyle: class {},
    Dialog: class {},
    fetchPost: () => {},
    fetchSyncPost: () => Promise.resolve({}),
    escapeHtml: (s) => String(s == null ? "" : s),
    escapeAttr: (s) => String(s == null ? "" : s),
  });
  ctx.globalThis = ctx;
  const mod = ctx.module;
  vm.runInContext(src, ctx, { filename: "src/tree.js" });
  return { exports: mod.exports, ctx, dom };
}

/* ---- 把 api.js 当 CJS 求值（只需要 displayMountPath 这个纯函数） ---- */
function loadApi() {
  let src = fs.readFileSync(path.join(ROOT, "src/api.js"), "utf8");
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m; while ((m = re.exec(src))) names.push(m[1]);
  src = src.replace(/^import\s+[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm, "");
  src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  src += `\nmodule.exports = { ${names.join(", ")} };`;
  const dom = makeDom();
  const ctx = vm.createContext({
    module: { exports: {} }, exports: {}, console,
    document: dom,
    window: { getComputedStyle: dom.defaultView.getComputedStyle },
    navigator: { userAgent: "node" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("no network in test")),
    diag: () => {}, showMessage: () => {},
  });
  ctx.globalThis = ctx;
  const mod = ctx.module;
  vm.runInContext(src, ctx, { filename: "src/api.js" });
  return mod.exports;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n       " + e.message); fail++; }
}

console.log("【任务30 + #55：拖拽插入契约】");

let tree;
try {
  tree = loadTree();
  console.log("  · tree.js 求值成功，导出：" + Object.keys(tree.exports).join(", "));
} catch (e) {
  console.log("  ❌ tree.js 求值失败：" + (e && e.message));
  process.exit(1);
}

const { FileTree } = tree.exports;
const dom = tree.dom;

/** 造一个不 bootstrap 的 FileTree（只调用我们要测的渲染方法） */
function mkTree() {
  const ft = Object.create(FileTree.prototype);
  ft.plugin = { settings: {} };
  ft.el = dom.createElement("div");
  ft.mounts = [{ label: "售前项目", writable: true }];
  ft.currentMount = "售前项目";
  ft.expanded = new Set();
  ft.filter = "";
  ft.treeEl = dom.createElement("div");
  ft._dragging = null;
  ft.destroyed = false;
  ft.gridPath = "";
  ft.gridMode = true;
  return ft;
}

/* ---------- 1) attachEmbedDrag 是唯一实现 ---------- */
check("1 attachEmbedDrag 是 FileTree 的方法（唯一实现存在）", () => {
  assert.strictEqual(typeof FileTree.prototype.attachEmbedDrag, "function",
    "attachEmbedDrag 不存在 —— 三处必然各自漂移");
});

check("2 attachEmbedDrag 给元素接上 draggable + ondragstart + ondragend", () => {
  const ft = mkTree();
  const el = dom.createElement("div");
  ft.attachEmbedDrag(el, { path: "a/b.pdf", name: "b.pdf", isDir: false });
  assert.strictEqual(el.draggable, true, "draggable 没打开");
  assert.strictEqual(typeof el.ondragstart, "function", "ondragstart 没接上");
  assert.strictEqual(typeof el.ondragend, "function", "ondragend 没接上");
});

check("3 拖拽时 setData 自定义 MIME + 记录 _dragging", () => {
  const ft = mkTree();
  const el = dom.createElement("div");
  const store = {};
  ft.attachEmbedDrag(el, { path: "a/b.pdf", name: "b.pdf", isDir: false });
  const ev = { dataTransfer: {
    effectAllowed: "", setData(k, v) { store[k] = v; },
  } };
  el.ondragstart(ev);
  const raw = store["application/x-nebuladisk-embed"];
  assert.ok(raw, "没有写自定义 MIME —— drop 端识别不了");
  const p = JSON.parse(raw);
  assert.strictEqual(p.mount, "售前项目");
  assert.strictEqual(p.path, "a/b.pdf");
  assert.strictEqual(p.isDir, false);
  assert.ok(ft._dragging, "_dragging 没记录");
});

/* ---------- 2) ★ 三处入口都接上了（任务30 的核心） ---------- */
check("4 ★ makeResultRow（搜索结果）可拖 —— 任务30 的原始诉求", () => {
  const ft = mkTree();
  const row = ft.makeResultRow({ path: "x/y.pdf", name: "y.pdf", isDir: false, ext: "pdf" });
  assert.strictEqual(row.draggable, true, "搜索结果行 draggable 仍是 false —— 任务30 没修好");
  assert.strictEqual(typeof row.ondragstart, "function", "搜索结果行缺 ondragstart");
});

check("5 ★ makeGridCell（网格格子）可拖", () => {
  const ft = mkTree();
  const cell = ft.makeGridCell({ path: "x/y.pdf", name: "y.pdf", isDir: false, ext: "pdf" });
  assert.strictEqual(cell.draggable, true, "网格格子 draggable 仍是 false");
  assert.strictEqual(typeof cell.ondragstart, "function", "网格格子缺 ondragstart");
});

check("6 ★ makeNode（文件树）可拖（搬家后没退化）", () => {
  const ft = mkTree();
  const wrap = ft.makeNode({ name: "y.pdf", isDir: false, path: "x/y.pdf", ext: "pdf" }, 0);
  assert.ok(wrap, "makeNode 没返回元素");
  // ★ 实测发现：makeNode 返回的是 **wrap**（外层包裹），真正的行是 wrap._row。
  //   拖拽接线挂在 row 上，所以断言必须落在 row 上 —— 断言 wrap 会假红。
  const row = wrap._row || wrap;
  assert.strictEqual(row.draggable, true,
    "文件树节点行 draggable 不是 true —— attachEmbedDrag 搬家时把能力弄丢了");
  assert.strictEqual(typeof row.ondragstart, "function", "文件树节点行缺 ondragstart");
});

/* ---------- 3) #55 文件夹不参与拖拽插入 ---------- */
check("7 ★ #55 文件可拖", () => {
  const ft = mkTree();
  const el = dom.createElement("div");
  ft.attachEmbedDrag(el, { path: "d", name: "d", isDir: false });
  assert.strictEqual(el.draggable, true, "文件必须可拖");
});

check("8 ★ #55 文件夹不可拖（draggable 必须为假）", () => {
  const ft = mkTree();
  const el = dom.createElement("div");
  ft.attachEmbedDrag(el, { path: "d", name: "d", isDir: true });
  assert.strictEqual(el.draggable, false,
    "文件夹仍被设成 draggable=true —— 用户要求「取消文件夹的拖拽插入支持」");
});

check("9 ★ #55 文件夹即使被强行拖起，也不写入可插入的 payload", () => {
  const ft = mkTree();
  const el = dom.createElement("div");
  const store = {};
  ft.attachEmbedDrag(el, { path: "d", name: "d", isDir: true });
  if (typeof el.ondragstart === "function") {
    el.ondragstart({ dataTransfer: { setData(k, v) { store[k] = v; } } });
  }
  const raw = store["application/x-nebuladisk-embed"];
  assert.ok(!raw, "文件夹仍写了自定义 MIME —— drop 端会把它当可插入条目");
  assert.strictEqual(ft._dragging, null, "文件夹拖拽不该记录 _dragging");
});

/* ---------- 4) #54 网格面包屑路径 ---------- */
check("10 ★ #54 网格根目录面包屑不含 ':/' 后紧跟斜杠的怪形（/:售前项目）", () => {
  const A = loadApi();
  const t = A.displayMountPath("售前项目", "");
  assert.ok(!/^\//.test(t), `面包屑以 / 开头（用户看到的 /:售前项目）：${t}`);
  assert.strictEqual(t, "售前项目:/", `根目录应显示「售前项目:/」，实际 ${t}`);
  // 带前导斜杠的路径也不能出现双斜杠
  assert.strictEqual(A.displayMountPath("售前项目", "/托璞勒"), "售前项目:/托璞勒");
  assert.strictEqual(A.displayMountPath("售前项目", "托璞勒"), "售前项目:/托璞勒");
});

check("11 ★ #54 displayCrumbPath：与网盘 Web UI 同款面包屑（无冒号/无多余斜杠）", () => {
  const A = loadApi();
  assert.strictEqual(typeof A.displayCrumbPath, "function", "缺 displayCrumbPath");
  // 根目录：只显示盘名 —— 用户的报错点就在这里（改前是 `售前项目:/`，他读成 /:售前项目）
  assert.strictEqual(A.displayCrumbPath("售前项目", ""), "售前项目");
  assert.strictEqual(A.displayCrumbPath("售前项目", "/"), "售前项目");
  assert.strictEqual(A.displayCrumbPath("售前项目", null), "售前项目");
  assert.strictEqual(A.displayCrumbPath("售前项目", undefined), "售前项目");
  // 子目录：盘名 / 段 / 段（与 explorer.js 的 renderCrumbs 同风格）
  assert.strictEqual(A.displayCrumbPath("售前项目", "/2026年08月"),
    "售前项目 / 2026年08月");
  assert.strictEqual(A.displayCrumbPath("售前项目", "2026年08月/盛元立库"),
    "售前项目 / 2026年08月 / 盛元立库");
  // 连续斜杠 / 尾斜杠都不能产出空段
  assert.strictEqual(A.displayCrumbPath("售前项目", "//a//b//"),
    "售前项目 / a / b");
  // 绝不能出现冒号（那就是老毛病）
  assert.ok(!A.displayCrumbPath("售前项目", "a/b").includes(":"), "面包屑不该出现冒号");
});

check("12 ★ #54 renderGrid 的面包屑真的用 displayCrumbPath（而不是只定义了函数）", () => {
  const treeSrc = fs.readFileSync(path.join(ROOT, "src/tree.js"), "utf8");
  assert.ok(/crumb\.textContent\s*=\s*displayCrumbPath\s*\(/.test(treeSrc),
    "renderGrid 里没有调用 displayCrumbPath —— 光有函数不接线等于没修");
  // 并且 tooltip 仍保留完整路径（displayMountPath），两者刻意不同
  assert.ok(/crumb\.title\s*=\s*displayMountPath\s*\(/.test(treeSrc),
    "面包屑的 title 应保留完整路径（displayMountPath）");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

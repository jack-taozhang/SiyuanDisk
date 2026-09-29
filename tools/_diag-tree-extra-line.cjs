/* 诊断：侧边栏面板「多了一行」到底是哪个元素渲染出来的（任务26 排查用）
 *
 * 用法: node tools/_diag-tree-extra-line.cjs [bundle.js]
 *
 * 做法：用 jsdom 挂上真实 bundle，实例化 FileTree，把渲染出来的
 *      .nb-tree 的直接子元素逐个打印（class / inline display / 文本前 40 字），
 *      再打印 DOM 顺序。这样"多了一行"就是哪一行，一目了然。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const DIST = process.argv[2] || path.join(ROOT, "dist", "index.js");
const JSDOM = require("jsdom").JSDOM;

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:6806/",
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
for (const k of ["HTMLElement", "Node", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "Element"]) {
  global[k] = window[k];
}
global.getComputedStyle = window.getComputedStyle.bind(window);
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
for (const k of ["localStorage", "sessionStorage"]) {
  try { global[k] = window[k]; } catch { /* ignore */ }
}

const MOUNT = "售前项目";
function jsonResponse(body) {
  return {
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
window.__nebuladiskPlugin = {
  settings: { serverUrl: "http://127.0.0.1:8099", proxyPort: 6810, defaultMount: "" },
  boot: { noNode: true },
};
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/healthz")) return jsonResponse({ ok: true });
  if (u.includes("/api/me")) {
    return jsonResponse({ ok: true, username: "tao_zhang", mounts: [{ label: MOUNT, name: MOUNT }] });
  }
  if (u.includes("/api/list")) {
    return jsonResponse({
      ok: true, path: "/",
      entries: [
        { name: "PDF", isDir: true, ext: "" },
        { name: "报告.pdf", isDir: false, ext: "pdf", size: 4096, mtime: 1 },
      ],
    });
  }
  if (u.includes("/api/search")) {
    return jsonResponse({ ok: true, mount: MOUNT, base: "", terms: ["x"], hits: [], total: 0, hasMore: false, scanned: 1 });
  }
  return jsonResponse({ ok: true, data: {} });
};
global.fetch = window.fetch;

const siyuanStub = {
  ws: { send: () => {}, addEventListener: () => {} },
  config: { lang: "zh_CN" },
  log: { info: () => {}, warn: () => {}, error: console.error },
  fetchSyncPost: async () => ({ code: 0, data: {} }),
  fetchPost: async () => {},
  openTab: () => {},
  showMessage: () => {},
  Plugin: class Plugin {
    constructor(o) { this.name = (o && o.name) || "siyuan-nebuladisk"; this.eventBus = { on: () => {}, off: () => {}, emit: () => {} }; }
    onload() {} onunload() {} onLayoutReady() {}
    loadData() { return Promise.resolve(null); } saveData() { return Promise.resolve(); }
    addTopBar() {} addCommand() {} addIcons() {} addTab() {} addDock() {} addSetting() {}
  },
  Protyle: class Protyle {},
  Dialog: class Dialog {
    constructor(o) {
      this.element = window.document.createElement("div");
      this.element.className = "b3-dialog";
      window.document.body.appendChild(this.element);
    }
    destroy() {}
  },
  Menu: class Menu { constructor() { this.element = window.document.createElement("div"); } addItem() {} open() {} close() {} },
  platformUtils: { isMobile: false, isDesktop: true },
  getFrontend: () => "desktop",
  getBackend: () => "windows",
  Constants: { ZINDEX_DIALOG: 1000 },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "siyuan") return "siyuan";
  return origResolve.call(this, request, ...rest);
};
require.cache["siyuan"] = { id: "siyuan", filename: "siyuan", loaded: true, exports: siyuanStub };
require.cache["http"] = {
  id: "http", filename: "http", loaded: true,
  exports: { createServer: () => ({ on: () => {}, listen: () => {}, close: () => {} }), request: () => ({ on: () => {}, end: () => {}, write: () => {} }) },
};

const TEST_COPY = path.join(os.tmpdir(), "nb-diag-tree-bundle.js");
let src = fs.readFileSync(DIST, "utf8");
// FileTree 不在 module.exports 里，挂出来（只改临时副本）
const anchor = "module.exports.default = __mod_index.default;";
src = src.replace(anchor, anchor + "\ntry { module.exports.FileTree = __mod_tree.FileTree; } catch (e) {}");
const ret = "  return {\n    __cjs: false,\n    default: NebulaDiskPlugin,\n  };\n})();";
src = src.replace(ret, "  return {\n    __cjs: false,\n    default: NebulaDiskPlugin,\n    FileTree: (typeof FileTree !== 'undefined' ? FileTree : undefined),\n  };\n})();");
fs.writeFileSync(TEST_COPY, src, "utf8");

let plugin;
try { plugin = require(TEST_COPY); }
catch (e) { console.log("bundle 加载失败：" + e.message); console.log(e.stack.split("\n").slice(0, 12).join("\n")); process.exit(1); }

console.log("导出键：" + Object.keys(plugin).join(", "));
const FileTree = plugin.FileTree;
if (typeof FileTree !== "function") {
  console.log("✗ 拿不到 FileTree，改从 bundle 文本再试");
  // 退化：直接在 bundle 里 new 出来做不到，打印线索
  const m = src.match(/class FileTree\s*\{([\s\S]{0,400})/);
  console.log(m ? m[1].slice(0, 400) : "no match");
  process.exit(1);
}

setTimeout(async () => {
  const doc = window.document;
  const host = doc.createElement("div");
  host.className = "nb-tree";
  doc.body.appendChild(host);

  let inst;
  try {
    // 注意签名：constructor(plugin, element) —— plugin 在前
    inst = new FileTree(window.__nebuladiskPlugin, host);
  } catch (e) {
    console.log("构造失败：" + e.message);
    console.log(e.stack.split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  }

  try { inst.render(); } catch (e) { console.log("render 抛错：" + e.message); }

  await new Promise((r) => setTimeout(r, 1200));

  const panel = inst.el || host;
  console.log("\n===== .nb-tree 直接子元素（渲染顺序） =====");
  [...panel.children].forEach((c, i) => {
    const txt = (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const rect = c.getBoundingClientRect ? c.getBoundingClientRect() : {};
    console.log(
      `[${i}] .${(c.className || "").toString().replace(/\s+/g, ".")} ` +
      `| inline.display="${c.style.display}" | computed="${window.getComputedStyle(c).display}" ` +
      `| text="${txt}"`
    );
  });

  console.log("\n===== 完整 DOM 大纲（depth<=3） =====");
  function walk(el, d) {
    if (d > 3) return;
    if (el.nodeType !== 1) return;
    const cls = (el.className || "").toString().replace(/\s+/g, ".");
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("").slice(0, 30);
    const inline = el.style && el.style.display ? ` [inline:${el.style.display}]` : "";
    console.log("  ".repeat(d) + `<${el.tagName.toLowerCase()}${cls ? " class=" + cls : ""}${inline}>` + (own ? ` "${own}"` : ""));
    [...el.children].forEach((c) => walk(c, d + 1));
  }
  walk(panel, 0);

  console.log("\n===== 关键元素存在性 =====");
  // ★ 2026-09-28：移除了 ".nb-grid-nav" —— 网格视图已整体删除，该元素不会再有。
  //   同时补上 .nb-tree-mount / .nb-tree-btn 两个仍在用的关键选择器，
  //   便于日后排查"工具条上的按钮怎么没了"这类问题。
  for (const sel of [".nb-tree-toolbar", ".nb-tree-mount", ".nb-tree-btn", ".nb-tree-filter", ".nb-tree-filter input", ".nb-tree-results", ".nb-tree-banner", ".nb-tree-body", ".nb-results-head", ".nb-tree-path"]) {
    const e = panel.querySelector(sel);
    const n = panel.querySelectorAll(sel).length;
    console.log(`${sel}: ${e ? `存在 ×${n}` : "不存在"}` + (e ? ` (inline.display="${e.style.display}")` : ""));
  }
  process.exit(0);
}, 300);

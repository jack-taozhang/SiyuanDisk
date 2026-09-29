/* 渲染冒烟测试：选择器搜索（任务24a）+ 网格/图标（任务25）+ 结果计数（任务24b）
 *
 * 用法: node tools/_sim-picker-render.cjs [bundle.js] [bundle.css]
 *       （不传参则默认取 ../dist/index.js 与 ../dist/index.css）
 *
 * ★ 为什么要有它 ★
 *   任务24/25 的其它测试都是**静态断言**（在源码文本里搜字符串）——
 *   它们能证明「代码写了」，但证明不了「跑起来真的渲染出搜索框、真的发请求、
 *   真的把 emoji 换成彩色类型图标」。
 *   这里用 jsdom 把**真实 bundle** 当 CommonJS 模块加载起来，
 *   真的 new Picker() → open() → 输入关键词 → 断言 DOM。
 *
 * ★ 踩过的坑（都写在这里，省得下次再摸）★
 *   1. bundle 是 CommonJS，裸 `fetch` / `sessionStorage` 必须在 globalThis 上
 *      真实存在，否则报 "Cannot read properties of undefined (reading 'get')"。
 *   2. 响应对象必须带 headers.get("content-type")，否则 parse() 直接炸。
 *   3. HAS_NODE 在真 Node 下为 true ⇒ 插件会去起本地代理。测试里靠
 *      window.__nebuladiskPlugin.boot.noNode = true 强制走直连（见 hasNode()）。
 *   4. global.fetch 必须在 stub 定义**之后**赋值，否则捕获的是 jsdom 的原生
 *      fetch（会真的发网络请求）。
 *   5. Picker 未导出。测试用「临时副本」在 module.exports 后挂一个 Picker ——
 *      绝不改动 dist 产物本身。
 *   6. CSS 断言必须先剥注释：选择器与声明之间夹了说明注释时（很常见），
 *      正则匹配不到「.nb-grid { ... grid-auto-rows }」——
 *      这个坑曾让 4 条断言假绿过。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const DIST = process.argv[2] || path.join(ROOT, "dist", "index.js");
const CSS = process.argv[3] || path.join(ROOT, "dist", "index.css");

let JSDOM;
try {
  JSDOM = require("jsdom").JSDOM;
} catch {
  console.log("⚠️  未安装 jsdom，跳过渲染冒烟测试（npm i -D jsdom）");
  console.log("通过 0 失败 0");
  process.exit(0);
}

if (!fs.existsSync(DIST) || !fs.existsSync(CSS)) {
  console.log(`✗ 找不到产物：${DIST} / ${CSS}`);
  console.log("通过 0 失败 1");
  process.exit(1);
}

// ---------------- jsdom 环境 ----------------
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://127.0.0.1:6806/",
});
const { window } = dom;

global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.HTMLElement = window.HTMLElement;
global.Node = window.Node;
global.Event = window.Event;
global.CustomEvent = window.CustomEvent;
global.KeyboardEvent = window.KeyboardEvent;
global.MouseEvent = window.MouseEvent;
global.getComputedStyle = window.getComputedStyle.bind(window);
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// 裸 localStorage / sessionStorage：先赋值，失败再 defineProperty
for (const k of ["localStorage", "sessionStorage"]) {
  try { global[k] = window[k]; } catch { /* ignore */ }
  if (!global[k]) {
    try {
      Object.defineProperty(global, k, { value: window[k], configurable: true, writable: true });
    } catch { /* ignore */ }
  }
}

const TRACE = !!process.env.NB_TRACE;
global.__nbTrace = (m) => { if (TRACE) console.log("[trace] " + m); };

const calls = { search: [], list: [] };
const MOUNT = "售前项目";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    // 插件 parse() 会读 content-type，缺了会抛 undefined.get
    headers: {
      get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// 把通道锁到 direct（真 Node 下 HAS_NODE 为 true，否则插件会去起代理）
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
  if (u.includes("/api/search")) {
    calls.search.push(u);
    let q = "";
    const m = u.match(/[?&]q=([^&]*)/);
    if (m) q = decodeURIComponent(m[1]);
    return jsonResponse({
      ok: true, mount: MOUNT, base: "", terms: [q],
      hits: [
        { name: "PDF", path: "/a/PDF", isDir: true, ext: "" },
        { name: "报告.pdf", path: "/a/报告.pdf", isDir: false, ext: "pdf" },
      ],
      total: 4526, reachable: 4526, offset: 0, limit: 500, hasMore: true,
      scanned: 39629, depthCapped: false, truncated: true,
    });
  }
  if (u.includes("/api/list")) {
    calls.list.push(u);
    return jsonResponse({
      ok: true,
      entries: [
        { name: "PDF", path: "/PDF", isDir: true, ext: "" },
        { name: "报告.pdf", path: "/报告.pdf", isDir: false, ext: "pdf", size: 4096, mtime: 1 },
        { name: "1.2.14.TFDF-6# F向.STEP", path: "/x.step", isDir: false, ext: "step", size: 8192, mtime: 1 },
      ],
      path: "/",
    });
  }
  return jsonResponse({ ok: true, data: {} });
};
// ★ 必须在 stub 定义之后赋值（提前赋值会捕获 jsdom 原生 fetch，真的发网络请求）
global.fetch = window.fetch;

// ---------------- siyuan 内建模块 stub ----------------
const siyuanStub = {
  ws: { send: () => {}, addEventListener: () => {} },
  config: { lang: "zh_CN" },
  log: { info: () => {}, warn: () => {}, error: console.error },
  fetchSyncPost: async () => ({ code: 0, data: {} }),
  fetchPost: async () => {},
  openTab: () => {},
  showMessage: (m) => { siyuanStub.__lastMessage = m; },
  __lastMessage: null,
  Plugin: class Plugin {
    constructor(options) {
      this.name = (options && options.name) || "siyuan-nebuladisk";
      this.eventBus = { on: () => {}, off: () => {}, emit: () => {} };
    }
    onload() {}
    onunload() {}
    onLayoutReady() {}
    loadData() { return Promise.resolve(null); }
    saveData() { return Promise.resolve(); }
    addTopBar() {}
    addCommand() {}
    addIcons() {}
    addTab() {}
    addDock() {}
    addSetting() {}
  },
  Protyle: class Protyle {},
  Dialog: class Dialog {
    constructor(opts) {
      this.options = opts || {};
      this.element = window.document.createElement("div");
      this.element.className = "b3-dialog";
      this.element.innerHTML = (opts && opts.content) || "";
      window.document.body.appendChild(this.element);
      this.contentEl = this.element.querySelector(".nb-dialog-content") || this.element;
    }
    destroy() { if (this.element.parentNode) this.element.parentNode.removeChild(this.element); }
  },
  Menu: class Menu {
    constructor() { this.element = window.document.createElement("div"); }
    addItem() {} open() {} close() {}
  },
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

// 代理用的 node http：stub 掉，避免真的去 listen 端口
require.cache["http"] = {
  id: "http", filename: "http", loaded: true,
  exports: {
    createServer: () => ({ on: () => {}, listen: () => {}, close: () => {} }),
    request: () => ({ on: () => {}, end: () => {}, write: () => {} }),
  },
};

// ---------------- 断言 ----------------
let pass = 0, fail = 0;
const lines = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; lines.push("✅ " + msg); }
  else { fail++; lines.push("❌ " + msg + (extra ? "  << " + String(extra).slice(0, 220) : "")); }
}

const css = fs.readFileSync(CSS, "utf8");
// ★ 先剥注释：`.nb-grid { /* 说明 */ grid-auto-rows:… }` 否则匹配不上
const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------- 加载真实 bundle（临时副本，只为把 Picker 挂出来）----------------
const TEST_COPY = path.join(os.tmpdir(), "nb-picker-render-bundle.js");
let plugin;
try {
  let src = fs.readFileSync(DIST, "utf8");

  const apiGetAnchor = "  async function apiGet(path, params) {";
  if (!src.includes(apiGetAnchor)) throw new Error("apiGet 锚点未找到（bundle 结构变了？）");
  src = src.replace(apiGetAnchor,
    apiGetAnchor + '\n    if (typeof globalThis.__nbTrace === "function") globalThis.__nbTrace("apiGet " + path);');

  const reqAnchor = "  async function requestOnce(method, path, { params, bodyKind, onProgress } = {}) {";
  if (src.includes(reqAnchor)) {
    src = src.replace(reqAnchor,
      reqAnchor + '\n    if (typeof globalThis.__nbTrace === "function") globalThis.__nbTrace("requestOnce " + method + " " + path);');
  }

  const anchor = "module.exports.default = __mod_index.default;";
  if (!src.includes(anchor)) throw new Error("module.exports 锚点未找到（bundle 结构变了？）");
  src = src.replace(anchor, anchor + "\ntry { module.exports.Picker = __mod_index.Picker; } catch (e) {}");

  const ret = "  return {\n    __cjs: false,\n    default: NebulaDiskPlugin,\n  };\n})();";
  if (!src.includes(ret)) throw new Error("IIFE return 块未找到（bundle 结构变了？）");
  src = src.replace(ret, "  return {\n    __cjs: false,\n    default: NebulaDiskPlugin,\n    Picker,\n  };\n})();");

  fs.writeFileSync(TEST_COPY, src, "utf8");
  plugin = require(TEST_COPY);
} catch (e) {
  console.log("✗ bundle 加载失败：" + e.message);
  console.log(e.stack.split("\n").slice(0, 8).join("\n"));
  console.log("通过 0 失败 1");
  process.exit(1);
}
ok(!!plugin, "bundle 可加载（真实产物，非源码文本）");

function report() {
  console.log(lines.join("\n"));
  console.log(`\n结果：通过 ${pass} 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

setTimeout(async () => {
  const doc = window.document;

  // ============ 任务25a：网格不再占满整高 —— ★ 断言已作废 ★ ============
  //   2026-09-28：网格视图整体移除，.nb-grid / .nb-cell 的 CSS 规则
  //   连同这些断言一起删除。**反向断言**改为「网格样式确实不存在了」，
  //   这样以后有人把网格 CSS 贴回来时能立刻报警（而不是安静通过）。
  ok(!/\.nb-grid\b/.test(cssNC), "任务25a'：.nb-grid 样式已移除（网格视图已删）");
  ok(!/\.nb-cell\b/.test(cssNC), "任务25a'：.nb-cell 样式已移除");

  // ================= 任务25b：文件夹/文件图标 =================
  ok(/\.nb-type-icon--dir\b/.test(cssNC), "任务25b CSS 有 .nb-type-icon--dir");

  // ================= 任务24a：选择器搜索 =================
  const Picker = plugin.Picker;
  ok(typeof Picker === "function", "任务24a Picker 类可从 bundle 取到");

  if (typeof Picker === "function") {
    const host = {
      settings: { defaultMount: "" },
      ensureLogin: async () => {},
      t: (s) => s,
      notify: () => {},
    };
    let instance = null;
    try {
      // ★ 真实调用点是 "file" / "tree"（见 index.js 的 pickAndEmbed 调用处）。
      //   这里必须是 "file"，否则走不进文件多选分支（"doc" 会落到 else 被置灰）。
      instance = new Picker(host, "file", () => {});
    } catch (e) {
      lines.push("ℹ️  Picker 构造抛错：" + e.message);
    }
    ok(!!instance, "任务24a Picker 实例化成功");

    if (instance) {
      try {
        await instance.open();
      } catch (e) {
        lines.push("ℹ️  Picker.open() 抛错：" + e.message);
      }

      const q = doc.querySelector(".nb-picker-q");
      ok(!!q, "任务24a 搜索输入框 .nb-picker-q 已渲染");
      ok(!!doc.querySelector(".nb-picker-search"), "任务24a .nb-picker-search 容器已渲染");

      if (q) {
        calls.search.length = 0;
        q.value = "pdf";
        q.dispatchEvent(new window.Event("input", { bubbles: true }));
        setTimeout(() => {
          ok(calls.search.length > 0, "任务24a 打字真的触发了 /api/search", JSON.stringify(calls.search));
          const body = doc.body.textContent || "";
          ok(/4526/.test(body), "任务24a 结果头部显示了 total");

          const iconDir = doc.querySelector(".nb-type-icon--dir");
          ok(!!iconDir, "任务25b 目录行渲染出文件夹图标元素");

          const badges = [...doc.querySelectorAll(".nb-picker-row .nb-type-icon")].map((el) => el.textContent);
          ok(badges.includes("PDF"), "任务25b 文件行是 PDF 彩色徽标（不是名字前 3 字兜底）", JSON.stringify(badges));

          const listText = (doc.querySelector(".nb-picker-list") || {}).textContent || "";
          ok(!/[\u{1F4C1}\u{1F4C4}]/u.test(listText), "任务25b 选择器里不再有 emoji 图标");

          const shead = (doc.querySelector(".nb-picker-shead") || {}).textContent || "";
          ok(/2\s*\/\s*4526/.test(shead), "任务24b 头部是「已显示/总数」而不是裸条数", shead);

          /* ================= 任务26b：多选 + 已选区排序 ================= */
          //  先把搜索关掉，回到浏览模式（3 个条目，便于顺序断言）
          q.value = "";
          q.dispatchEvent(new window.Event("input", { bubbles: true }));

          setTimeout(() => {
            const rows = [...doc.querySelectorAll(".nb-picker-list .nb-picker-row")];
            // 目录行 + 2 个文件行（报告.pdf / x.step）
            const fileRows = rows.filter((r) => !r.classList.contains("is-disabled") && r.dataset.nbKey);
            ok(rows.length >= 3, "任务26b 浏览模式渲染出目录+文件行", "rows=" + rows.length);
            ok(fileRows.length >= 2, "任务26b 文件行带 data-nb-key（可用于多选定位）", "files=" + fileRows.length);

            const tray = doc.querySelector(".nb-picker-tray");
            ok(!!tray, "任务26b 已选区 .nb-picker-tray 已渲染");
            const trayEmpty = (doc.querySelector(".nb-picker-trayempty") || {}).textContent || "";
            ok(/单击文件|Ctrl/.test(trayEmpty), "任务26b 空态给出多选操作提示", trayEmpty);

            // —— 单击第一个文件：进入已选 ——
            fileRows[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
            let chips = [...doc.querySelectorAll(".nb-picker-chip")];
            ok(chips.length === 1, "任务26b 单击文件后已选区出现 1 项", "chips=" + chips.length);
            ok(fileRows[0].classList.contains("is-picked"), "任务26b 被选中的行有 is-picked 高亮");

            // —— Ctrl 点击第二个文件：追加（多选）——
            fileRows[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
            chips = [...doc.querySelectorAll(".nb-picker-chip")];
            ok(chips.length === 2, "任务26b Ctrl 点击追加为 2 项（多选）", "chips=" + chips.length);

            const title = (doc.querySelector(".nb-picker-traytitle") || {}).textContent || "";
            ok(/已选\s*2\s*项/.test(title), "任务26b 标题显示「已选 2 项」", title);

            // —— 记下顺序，然后下移第 0 项 → 顺序应互换 ——
            const namesBefore = chips.map((c) => c.querySelector(".nb-picker-chipname").textContent);
            ok(namesBefore[0].startsWith("1. "), "任务26b 已选序号从 1 开始", JSON.stringify(namesBefore));

            const downBtn = chips[0].querySelector(".nb-down");
            ok(!!downBtn, "任务26b 每项带「下移」按钮");
            downBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
            const chips2 = [...doc.querySelectorAll(".nb-picker-chip")];
            const namesAfter = chips2.map((c) => c.querySelector(".nb-picker-chipname").textContent);
            ok(
              namesAfter[0] === namesBefore[1].replace(/^2\. /, "1. ") &&
              namesAfter[1] === namesBefore[0].replace(/^1\. /, "2. "),
              "任务26b 下移后顺序真的互换（顺序 = 插入顺序）",
              JSON.stringify({ before: namesBefore, after: namesAfter })
            );

            // —— 上移还原，验证对称性（不能只测一个方向）——
            chips2[1].querySelector(".nb-up").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
            const namesBack = [...doc.querySelectorAll(".nb-picker-chip")]
              .map((c) => c.querySelector(".nb-picker-chipname").textContent);
            ok(
              namesBack[0] === namesBefore[0] && namesBack[1] === namesBefore[1],
              "任务26b 上移可还原（上下操作对称）",
              JSON.stringify(namesBack)
            );

            // —— 确定按钮文案应随多选变化 ——
            const okBtn = doc.querySelector(".nb-picker-ok");
            ok(/插入这\s*2\s*个/.test(okBtn ? okBtn.textContent : ""),
               "任务26b 多选时确定按钮文案为「插入这 N 个」", okBtn ? okBtn.textContent : "");

            const hint = (doc.querySelector(".nb-picker-hint") || {}).textContent || "";
            ok(/已选\s*2\s*项/.test(hint), "任务26b 底部提示反映已选数量", hint);

            report();
          }, 900);
          return;
        }, 900);
        return;
      }
    }
  }
  report();
}, 500);

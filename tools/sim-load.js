/**
 * sim-load.js —— 模拟思源加载器，在 Node 里跑插件的 onload()
 *
 * 目的：思源加载插件抛错时**不写日志**，只能用这种方式把异常逼出来。
 * 用法：node tools/sim-load.js [插件目录]
 */
const path = require("path");
const Module = require("module");

const DIR = process.argv[2] || "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk";

/* ---- 记录所有注册类 API 调用 ---- */
const calls = [];
const rec = (s) => calls.push(s);

class Plugin {
  constructor(o) {
    this.__opts = o;
    // 思源会把 i18n 注入实例；这里用 Proxy 让任意 key 回退成 key 名
    this.i18n = new Proxy({}, { get: (_t, k) => String(k) });
  }
  addIcons() { rec("addIcons"); }
  addTab(o) { rec("addTab(" + (o && o.type) + ")"); return {}; }
  addDock(o) { rec("addDock(" + (o && o.type) + ")"); return {}; }
  addTopBar() { rec("addTopBar"); return {}; }
  addCommand(o) { rec("addCommand(" + (o && o.langKey) + ")"); return {}; }
  addStatusBar() { rec("addStatusBar"); return {}; }
  updateProtyleToolbar() { rec("updateProtyleToolbar"); }
  loadData() { return Promise.resolve(null); }
  saveData() { return Promise.resolve(); }
  removeData() { return Promise.resolve(); }
}

const siyuanStub = {
  Plugin,
  getFrontend: () => "desktop",
  showMessage: () => {},
  openTab: () => {},
  Dialog: function () {},
  Setting: function () {},
  getActiveEditor: () => null,
  getAllTabs: () => [],
  Protyle: function () {},
  fetchPost: () => {},
  fetchSyncPost: () => Promise.resolve({}),
};

/* ---- 拦截 require("siyuan") ---- */
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "siyuan") return siyuanStub;
  return origLoad.apply(this, arguments);
};

/* ---- 补浏览器全局 ---- */
const el = () => ({
  style: {}, dataset: {}, children: [], innerHTML: "", textContent: "",
  classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  appendChild() {}, removeChild() {}, insertBefore() {},
  addEventListener() {}, removeEventListener() {},
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ width: 300, height: 400, top: 0, left: 0 }),
  scrollTop: 0, scrollHeight: 0,
});

global.window = {
  siyuan: { config: { system: { workDir: "D:/Software/SiYuan" } }, ws: null },
  addEventListener() {}, removeEventListener() {},
  open() {},
  require: null,
};
global.document = {
  createElement: el,
  addEventListener() {}, removeEventListener() {},
  body: el(),
  head: el(),
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.location = { origin: "http://192.168.193.70:6806", href: "http://192.168.193.70:6806/", protocol: "http:", host: "192.168.193.70:6806" };
global.navigator = { userAgent: "Electron", clipboard: { writeText: () => Promise.resolve() } };
global.fetch = () => Promise.reject(new Error("sim: no network"));
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.getComputedStyle = () => ({ getPropertyValue: () => "" });
global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
global.Event = global.CustomEvent;

/* ---- 跑 ---- */
(async () => {
  let P;
  try {
    P = require(path.resolve(DIR, "index.js"));
  } catch (e) {
    console.log("★ require(index.js) 抛错:", e.message);
    console.log(e.stack.split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("require 成功: typeof =", typeof P, "| name =", P && P.name, "| .default =", typeof (P && P.default));

  const Ctor = typeof P === "function" ? P : P && P.default;
  if (typeof Ctor !== "function") {
    console.log("★ 导出不是构造函数 —— 思源会加载失败");
    process.exitCode = 1;
    return;
  }

  let inst;
  try {
    inst = new Ctor({ name: "siyuan-nebuladisk", displayName: "NebulaDisk", i18n: {} });
  } catch (e) {
    console.log("★ 实例化抛错:", e.message);
    console.log(e.stack.split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("实例化成功");

  try {
    await inst.onload();
    console.log("✅ onload 成功");
  } catch (e) {
    console.log("★ onload 抛错:", e && e.message);
    console.log((e && e.stack ? e.stack : "").split("\n").slice(0, 10).join("\n"));
    process.exitCode = 1;
  }

  console.log("\n--- onload 期间注册的 UI（这些决定侧边栏/顶栏有没有入口）---");
  if (!calls.length) console.log("  （一个都没有注册！）");
  calls.forEach((c, i) => console.log("  " + (i + 1) + ". " + c));

  const hasDock = calls.some((c) => c.startsWith("addDock("));
  const hasTopBar = calls.some((c) => c === "addTopBar");
  console.log("\naddDock:", hasDock ? "有 ✅" : "无 ❌", "| addTopBar:", hasTopBar ? "有 ✅" : "无 ❌");
  if (!hasDock && !hasTopBar) process.exitCode = 1;
})();

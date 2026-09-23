/**
 * probe-onload.js —— 用「更接近真实 Electron」的环境执行插件并调用 onload
 *
 * 目的：sim-load.js 用的是极简 stub，可能掩盖真实错误。
 *      这里补上 onload 真跑一遍，并把任何异常完整打出（含 stack）。
 */
const fs = require("fs");
const path = require("path");

const DIR = process.argv[2] || "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk";
const CODE = fs.readFileSync(path.join(DIR, "index.js"), "utf8");

// ---------- 记录注册动作 ----------
const registered = { docks: [], tabs: [], topBars: [], commands: [], icons: 0, custom: [] };

class Plugin {
  constructor(o) {
    this.app = o.app; this.name = o.name; this.displayName = o.displayName; this.i18n = o.i18n || {};
    this.eventBus = { on: () => {}, off: () => {}, emit: () => {} };
  }
  addIcons() { registered.icons++; }
  addTab(o) { registered.tabs.push(o && o.type); }
  addDock(o) { registered.docks.push({ type: o && o.type, config: o && o.config }); }
  addTopBar(o) { registered.topBars.push(o && o.className); }
  addCommand(o) { registered.commands.push(o && o.langKey); }
  addCustomBlock() { registered.custom.push("block"); }
  loadData() { return Promise.resolve(null); }
  saveData() { return Promise.resolve(); }
  onload() {}
  onLayoutReady() {}
  onunload() {}
}

const el = () => {
  const e = {
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, insertBefore(c) { return c; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    innerHTML: "", textContent: "", title: "", id: "", className: "",
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    closest: () => null, contains: () => false, focus() {}, blur() {}, click() {},
  };
  return e;
};

global.document = {
  createElement: () => el(),
  createElementNS: () => el(),
  createTextNode: (t) => ({ textContent: t }),
  createDocumentFragment: () => el(),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
  body: el(), head: el(), documentElement: el(),
  createRange: () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} }),
};

global.window = {
  siyuan: {
    config: {
      system: { workDir: "D:/Software/SiYuan" },
      keymap: { plugin: {} },
      appearance: { mode: 0, icon: "material" },
      bazaar: { trust: true, petalDisabled: false },
      langs: ["zh_CN"],
      lang: "zh_CN",
    },
    ws: null, layout: {}, languages: {},
    storage: {}, zIndex: 0,
  },
  location: { origin: "http://192.168.193.70:6806", href: "http://192.168.193.70:6806/", protocol: "http:", host: "192.168.193.70:6806" },
  navigator: { userAgent: "Electron", clipboard: { writeText: () => Promise.resolve() } },
  addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestAnimationFrame: (f) => setTimeout(f, 0),
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: (spec) => {
    if (/^\.|^\//.test(spec)) {
      const err = new Error(`Cannot find module '${spec}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    const head = String(spec).replace(/^node:/, "").split("/")[0];
    const OK = new Set(["http","https","url","fs","path","crypto","os","stream","zlib","net","tls","events","util","querystring","buffer","child_process","worker_threads","electron","@electron/remote"]);
    if (OK.has(head)) return require(spec.replace(/^node:/, "node:"));
    const err = new Error(`Cannot find module '${spec}'`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  },
  fetch: () => Promise.reject(new Error("sim")),
  eval: (c) => eval(c),
  open() {}, close() {},
};

global.location = global.window.location;
global.navigator = global.window.navigator;
global.self = global.window;
global.HTMLElement = function () {};
global.Node = function () {};
global.CustomEvent = function (t, o) { return { type: t, detail: o && o.detail }; };
global.Event = function (t) { return { type: t }; };
global.MutationObserver = function () { return { observe() {}, disconnect() {} }; };
global.ResizeObserver = function () { return { observe() {}, disconnect() {} }; };
global.IntersectionObserver = function () { return { observe() {}, disconnect() {} }; };
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.fetch = global.window.fetch;

const siyuanModule = {
  Plugin,
  getFrontend: () => "desktop",
  showMessage: (m) => console.log("   [showMessage]", String(m).slice(0, 120)),
  openTab: (o) => console.log("   [openTab]", JSON.stringify(o).slice(0, 160)),
  Dialog: function () { return { element: el(), destroy() {} }; },
  Menu: function () { return { addItem() {}, open() {}, close() {} }; },
  confirm: (t, d, cb) => cb && cb(),
  fetchPost: () => {},
  fetchSyncPost: () => Promise.resolve({ code: 0, data: {} }),
  getActiveEditor: () => null,
  getAllTabs: () => [],
  getModelByDockType: () => null,
};

const req = (spec) => (spec === "siyuan" ? siyuanModule : global.window.require(spec));
const moduleObj = { exports: {} };

console.log("=== 在接近真实的环境里加载并调用 onload ===");
console.log("插件目录:", DIR);

let Cls;
try {
  const factory = new Function("require", "module", "exports", CODE);
  factory(req, moduleObj, moduleObj.exports);
  Cls = (moduleObj.exports || {}).default || moduleObj.exports;
  console.log("✅ 脚本执行成功，导出:", typeof Cls, Cls && Cls.name);
} catch (e) {
  console.log("❌ 脚本执行抛错:");
  console.log(e && e.stack ? e.stack : e);
  process.exit(1);
}

if (typeof Cls !== "function") { console.log("❌ 导出不是函数"); process.exit(1); }
if (!(Cls.prototype instanceof Plugin)) { console.log("❌ 不继承 Plugin"); process.exit(1); }

let inst;
try {
  inst = new Cls({ app: {}, displayName: "NebulaDisk 网盘", name: "siyuan-nebuladisk", i18n: {} });
  console.log("✅ 实例化成功");
} catch (e) {
  console.log("❌ 实例化抛错:");
  console.log(e && e.stack ? e.stack : e);
  process.exit(1);
}

(async () => {
  try {
    await inst.onload();
    console.log("✅ onload 成功");
  } catch (e) {
    console.log("❌ onload 抛错（思源会 console.error 后静默放弃）:");
    console.log(e && e.stack ? e.stack : e);
    process.exitCode = 1;
    return;
  }

  console.log("\n注册结果:");
  console.log("  icons    :", registered.icons);
  console.log("  tabs     :", JSON.stringify(registered.tabs));
  console.log("  docks    :", JSON.stringify(registered.docks.map((d) => d.type)));
  console.log("  dockConf :", JSON.stringify(registered.docks.map((d) => d.config)));
  console.log("  topBars  :", JSON.stringify(registered.topBars));
  console.log("  commands :", JSON.stringify(registered.commands));

  // 等异步代理启动
  await new Promise((r) => setTimeout(r, 2500));

  const http = require("http");
  const probe = await new Promise((res) => {
    const rq = http.get({ host: "127.0.0.1", port: 6810, path: "/__ping", timeout: 1500 }, (rs) => {
      let b = ""; rs.on("data", (c) => (b += c)); rs.on("end", () => res("HTTP " + rs.statusCode + " " + b.slice(0, 80)));
    });
    rq.on("error", (e) => res(e.code));
    rq.on("timeout", () => { rq.destroy(); res("TIMEOUT"); });
  });
  console.log("\n 代理 6810 :", probe);
  if (inst.proxy) console.log(" inst.proxy 端口:", inst.proxy.actualPort);
  process.exit(0);
})();

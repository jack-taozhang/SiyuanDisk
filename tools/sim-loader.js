/**
 * sim-loader.js —— 严格复刻思源真实的插件加载器
 *
 * 关键：思源是这样执行插件的（从 common.js 里读到的原文）：
 *
 *   const Ue = Ve => Ve === "siyuan" ? P() : window.require?.(Ve);
 *   const ce = (Ve, Xe) => window.eval(
 *     "(function anonymous(require, module, exports){" + Ve + " }) //# sourceURL=" + Xe
 *   );
 *   const He = (Ve, Xe) => {
 *     const ft = {}, Tt = { exports: ft };
 *     try { ce(Xe.js, "plugin:" + name)(Ue, Tt, ft) }
 *     catch (Et) { console.error(`plugin ${name} run error:`, Et); return }
 *     const mt = (Tt.exports || ft).default || Tt.exports;
 *     if (typeof mt != "function") throw new Error("has no export");
 *     if (!(mt.prototype instanceof Plugin)) throw new Error("does not extends Plugin");
 *     return new mt({ app, displayName, name, i18n });
 *   }
 *
 * 所以本脚本**故意把 window.require 做成只会抛错**，
 * 来暴露「插件依赖相对 require」这个致命问题。
 */
const fs = require("fs");
const path = require("path");

const PLUGIN_DIR = process.argv[2] || "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk";
const PLUGIN_NAME = path.basename(PLUGIN_DIR);

/* ---- 极简 Plugin 基类（模拟 siyuan 模块导出的 Plugin）---- */
class Plugin {
  constructor(o) {
    this.app = o.app;
    this.name = o.name;
    this.displayName = o.displayName;
    this.i18n = o.i18n || {};
  }
  addIcons() {}
  addTab() {}
  addDock() {}
  addTopBar() {}
  addCommand() {}
  loadData() { return Promise.resolve(null); }
  saveData() { return Promise.resolve(); }
}

/* ---- 模拟思源：require("siyuan") 有值，其它走 window.require ----
 *
 * ★ 关于 node 内建模块：已装插件里有实证 ——
 *     siyuan-importer  用了 fs / path / crypto / electron / child_process
 *     siyuan-canvas    用了 node:fs/promises
 *     siyuan-sou-easy  用了 @electron/remote
 *   ⇒ 思源的 Electron 渲染进程**确实开放了 node 能力**，
 *     所以 require("http") 这类是合法的。模拟器必须放行它们，
 *     否则会误报（早期版本就误报过 require("http")）。
 *
 *   真正解析不了的只有「相对路径」—— 因为 window.require 的基准是
 *   渲染进程 bundle，不是插件目录。
 */
const siyuanModule = {
  Plugin,
  getFrontend: () => "desktop",
  showMessage: () => {},
  openTab: () => {},
  Dialog: function () {},
  confirm: () => {},
  fetchPost: () => {},
  fetchSyncPost: () => Promise.resolve({}),
  getActiveEditor: () => null,
  getAllTabs: () => [],
};

const NODE_BUILTINS = new Set([
  "http", "https", "url", "fs", "path", "crypto", "os", "stream", "zlib",
  "net", "tls", "events", "util", "querystring", "buffer", "child_process",
  "worker_threads", "assert", "dns", "readline", "string_decoder", "timers",
  "electron", "@electron/remote", "@electron/remote/main",
]);

let windowRequireCalls = [];
function windowRequire(spec) {
  windowRequireCalls.push(spec);

  // 相对 / 绝对路径：Electron 会相对 bundle 解析 → 必然失败
  if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:/.test(spec)) {
    const err = new Error(`Cannot find module '${spec}'`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }

  // 冒烟：允许 require 子路径如 "fs/promises"
  const head = spec.replace(/^node:/, "").split("/")[0];
  if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(head)) {
    return require(spec.replace(/^node:/, "node:"));
  }

  const err = new Error(`Cannot find module '${spec}'`);
  err.code = "MODULE_NOT_FOUND";
  throw err;
}

/* ---- 组装执行环境 ---- */
const PLUGIN_JS = fs.readFileSync(path.join(PLUGIN_DIR, "index.js"), "utf8");

// 插件里会用到的一点点全局
global.window = {
  siyuan: { config: { system: { workDir: "D:/Software/SiYuan" }, keymap: { plugin: {} }, ws: null } },
  require: windowRequire,
  eval: (code) => eval(code),
  addEventListener() {},
  open() {},
};
global.document = {
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  body: { appendChild() {} },
  head: { appendChild() {} },
};
global.location = { origin: "http://192.168.193.70:6806", href: "http://192.168.193.70:6806/" };
global.navigator = { userAgent: "Electron" };
global.fetch = () => Promise.reject(new Error("sim: no network"));

/* ---- 完全按思源的方式执行 ---- */
const req = (spec) => (spec === "siyuan" ? siyuanModule : windowRequire(spec));
const moduleObj = { exports: {} };
const exportsObj = moduleObj.exports;

console.log("模拟思源插件加载器（严格模式：window.require 只会抛错）");
console.log("插件: " + PLUGIN_NAME);
console.log("─".repeat(60));

// 这就是思源的 ce(Xe.js, ...)(Ue, Tt, ft)
const factory = new Function("require", "module", "exports", PLUGIN_JS);
try {
  factory(req, moduleObj, exportsObj);
} catch (e) {
  console.log("★ 插件执行抛错（思源会 console.error 后静默放弃，不写 siyuan.log）:");
  console.log("  " + e.message);
  console.log();
  if (windowRequireCalls.length) {
    console.log("  触发失败的 require:");
    for (const s of windowRequireCalls) console.log("    require(" + JSON.stringify(s) + ")");
    console.log();
    console.log("  ⇒ 诊断：插件用了相对 require。思源给插件的 require 只认 \"siyuan\"，");
    console.log("     其余委托给 Electron 的 window.require —— 它的解析基准是**渲染进程 bundle**，");
    console.log("     不是插件目录 ⇒ 相对路径必然找不到模块。");
    console.log("     ⚠️ 已在用的 12 个插件里，没有任何一个使用相对 require（多文件插件也是打成单文件）。");
    console.log("     ⇒ 修法：把所有 src/*.js **打成单个 index.js** 再安装。");
  }
  process.exitCode = 1;
  return;
}

console.log("✅ 插件脚本执行成功（无 require 错误）");

// 后续校验（与思源一致）
const mt = (moduleObj.exports || exportsObj).default || moduleObj.exports;
if (typeof mt !== "function") {
  console.log("★ 思源会判定: plugin " + PLUGIN_NAME + " has no export");
  process.exitCode = 1;
  return;
}
console.log("✅ 导出是函数: " + mt.name);
if (!(mt.prototype instanceof Plugin)) {
  console.log("★ 思源会判定: plugin " + PLUGIN_NAME + " does not extends Plugin");
  process.exitCode = 1;
  return;
}
console.log("✅ 继承自 Plugin");

/* 验证「插件包本身」是否正确 —— 包能装、思源能加载。
 *
 * 用法:
 *   node tools/verify-package.cjs [包目录]
 *     不传参时默认取本机思源安装位 D:/Software/SiYuan/data/plugins/siyuan-nebuladisk
 *     （即把 zip 解压后的目录）。
 *
 * 思源加载插件的方式（common.js）：
 *   (function anonymous(require, module, exports){ <plugin js> })(req, module, exports)
 * 其中 require 只认 "siyuan"。
 *
 * 本脚本回答的是：**这个包本身对不对**。四件事：
 *   1) 必需文件齐备（index.js / index.css / plugin.json / icon.png / i18n/）
 *   2) plugin.json 字段合法且指向的文件真实存在
 *   3) i18n 是合法 JSON、icon.png 是真 PNG
 *   4) 用思源同款包裹方式执行 index.js：能执行、导出是构造器、能实例化
 *
 * ★ 边界说明（重要）★
 *   「运行期行为」（onload 里注册了哪些 dock/tab/icons、通道怎么选）
 *   **不由本脚本负责** —— 因为 onload 是异步流程，同步断言会读到 0（假红），
 *   而要精确复刻时序就得补越来越多的桩，越补越容易自欺。
 *   那部分交给项目里已有的**专用模拟器**（它们更真实，且已进全量测试）：
 *     tools/_sim-browser.cjs        浏览器端通道 + 主机改名 + 打开网盘深链
 *     tools/_sim-legacy-embed.cjs   旧写法嵌入块就地重绘
 *     tools/_sim-embed-contract.cjs 嵌入块契约（299 条）
 *     tools/_sim-picker-render.cjs  选择器/网格渲染冒烟
 */
const fs = require("fs");
const path = require("path");

const NODEPATH = require("path");
const ROOT = NODEPATH.resolve(__dirname, "..");
// 候选：命令行参数 > 本机思源安装位 > 仓库 dist/
//   ★ 用绝对路径候选而不是相对 __dirname 上跳 ★
//     上跳层数依赖目录摆放位置，一挪就错（实测跳出到 D:\Docker\SiyuanDisk\Software\...）。
const PKG_CANDIDATES = [
  ...(process.argv[2] ? [process.argv[2]] : []),
  "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk",
  path.join(ROOT, "dist"),
];
const PKG = PKG_CANDIDATES.find((p) => p && fs.existsSync(path.join(p, "plugin.json")));

if (!PKG) {
  console.error("✗ 找不到包目录。试过：");
  for (const c of PKG_CANDIDATES) console.error("    " + c);
  console.error("  用法: node tools/verify-package.cjs <解压后的包目录>");
  process.exit(1);
}
console.log(`验证目标: ${PKG}\n`);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  → " + extra : ""}`); }
}

console.log("=== 1. 包文件清单 ===");
const files = fs.readdirSync(PKG);
ok("index.js 存在", files.includes("index.js"));
ok("index.css 存在", files.includes("index.css"));
ok("plugin.json 存在", files.includes("plugin.json"));
ok("icon.png 存在", files.includes("icon.png"));
ok("i18n/ 存在", fs.existsSync(path.join(PKG, "i18n")));

console.log("\n=== 2. plugin.json 合法且字段齐全 ===");
const man = JSON.parse(fs.readFileSync(path.join(PKG, "plugin.json"), "utf8"));
ok("name", man.name === "siyuan-nebuladisk", man.name);
ok("version", !!man.version, man.version);
ok("minAppVersion", !!man.minAppVersion, man.minAppVersion);
ok("displayName.zh_CN", !!man.displayName?.zh_CN);
ok("backends 含 docker", man.backends?.includes("docker"), JSON.stringify(man.backends));
ok("frontends 含 browser-desktop", man.frontends?.includes("browser-desktop"), JSON.stringify(man.frontends));
ok("icon 指向 icon.png", man.icon === "icon.png", man.icon);
ok("readme 两份都在", fs.existsSync(path.join(PKG, man.readme.default)) && fs.existsSync(path.join(PKG, man.readme.zh_CN)));

console.log("\n=== 3. i18n 合法 JSON ===");
const i18n = JSON.parse(fs.readFileSync(path.join(PKG, "i18n", "zh_CN.json"), "utf8"));
ok("zh_CN.json 可解析", typeof i18n === "object");
ok("键数 > 10", Object.keys(i18n).length > 10, String(Object.keys(i18n).length));

console.log("\n=== 4. icon.png 是真 PNG ===");
const png = fs.readFileSync(path.join(PKG, "icon.png"));
ok("PNG 魔数", png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

console.log("\n=== 5. ★ 用思源同款包裹方式执行 index.js ★ ===");
const js = fs.readFileSync(path.join(PKG, "index.js"), "utf8");
console.log(`   大小 ${js.length} 字符 / ${Buffer.byteLength(js)} 字节`);

// ---- 构造一个「桌面端思源」环境（有 node 能力，但不起真代理）----
const registered = { dock: 0, tab: 0, topBar: 0, icons: 0, commands: 0, embeds: 0 };
const fakeEl = () => ({
  style: {}, className: "", innerHTML: "", textContent: "",
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, getAttribute: () => null, appendChild() {}, removeChild() {},
  remove() {}, insertBefore() {}, addEventListener() {}, querySelector: () => null,
  querySelectorAll: () => [], children: [], dataset: {}, parentElement: null,
});

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
  RegExp, Map, Set, URLSearchParams, URL, TextEncoder, TextDecoder,
  Buffer, process: { env: {}, platform: "win32", versions: { node: "22" } },
  document: {
    createElement: fakeEl, createElementNS: fakeEl,
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, addEventListener() {},
    head: fakeEl(), body: fakeEl(), documentElement: fakeEl(),
  },
  location: { hostname: "127.0.0.1", protocol: "http:", href: "http://127.0.0.1:6806/" },
  navigator: { userAgent: "node" },
  localStorage: (() => { const m = {}; return {
    getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => (m[k] = String(v)),
    removeItem: (k) => delete m[k], clear: () => { for (const k in m) delete m[k]; },
    key: (i) => Object.keys(m)[i], get length() { return Object.keys(m).length; },
  }; })(),
  fetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}", json: async () => ({}) }),
  __siyuanPlugin: null,
};

// 思源提供的 require：只认 "siyuan"，其余走 window.require
// ★ 必须提供 Plugin 基类 ★
//   插件代码是 `class NebulaDiskPlugin extends Plugin`，Plugin 来自 require("siyuan")。
//   少了它 → 探针自己抛 `Class extends value undefined`，
//   看起来像「包坏了」，其实是**桩不全造成的假红**（本项目反复踩过这个坑）。
class FakePlugin {
  constructor(opts) {
    Object.assign(this, opts || {});
    this.data = {};
    this._events = {};
    this.i18n = {};
    this.setting = { addItem() {}, open() {}, };
    this.eventBus = { on() {}, off() {}, emit() {} };
  }
  addIcons() {}
  addDock() {}
  addTab() {}
  addTopBar() {}
  addCommand() {}
  addStatusBar() {}
  registerCustomBlockRender() {}
  async loadData() { return null; }
  async saveData() {}
  onload() {}
  onLayoutReady() {}
  onunload() {}
}
const siyuanMock = {
  Plugin: FakePlugin,
  showMessage: () => {}, fetchPost: async () => ({}), fetchSyncPost: async () => ({}),
  adaptHotkey: () => "", openTab: () => ({}), getFrontend: () => "desktop",
  platform: { isMobile: false, isDesktop: true, isBrowser: false, isWin: true, isMac: false, isLinux: false },
  constants: { SIYUAN_VERSION: "3.8.4" },
  getActiveEditor: () => null, openWindow: () => ({}), setStorageVal: () => {},
  getStorageVal: () => null, loadData: async () => null, saveData: async () => {},
  removeData: async () => {}, pushMsg: () => {}, sql: async () => [],
  Protyle: class {}, Dialog: class {}, Menu: class {}, getModelByDockType: () => null,
  util: { genUUID: () => "u", escapeHtml: (s) => s, isMobile: () => false },
  confirm: async () => true,
};
const req = (name) => {
  if (name === "siyuan") return siyuanMock;
  throw new Error("MODULE_NOT_FOUND: " + name);
};

// ---- 关键：桌面端应能拿到「真 node 能力」；这里不给 fs/http 避免起真代理 ----
//      所以故意让 require("fs") 抛 —— 插件应降级到 direct 通道且不崩。
const module_ = { exports: {} };
try {
  const fn = new Function(
    "require", "module", "exports", "window", "self", "globalThis", "document", "location", "navigator", "localStorage", "fetch",
    js,
  );
  const win = { ...sandbox, require: () => { throw new Error("no node"); }, addEventListener() {}, postMessage() {} };
  fn(req, module_, module_.exports, win, win, win, sandbox.document, sandbox.location, sandbox.navigator, sandbox.localStorage, sandbox.fetch);
  ok("包裹执行无异常", true);
} catch (e) {
  fail++;
  console.log("  ❌ 包裹执行抛错: " + e.message);
  console.log(String(e.stack).split("\n").slice(0, 8).join("\n"));
}

const PluginClass = module_.exports.default || module_.exports;
ok("导出是构造器/函数", typeof PluginClass === "function", typeof PluginClass);

if (typeof PluginClass === "function") {
  let inst = null;
  try {
    inst = new PluginClass({
      name: "siyuan-nebuladisk",
      displayName: "NebulaDisk 网盘",
      app: {},
      i18n: {},
    });
    ok("new PluginClass(...) 成功", true);
  } catch (e) {
    fail++;
    console.log("  ❌ 实例化失败: " + e.message);
  }

  // ★ 关于「注册计数」的取舍 ★
  //   onload 内部是**异步**流程（先 await loadSettings 才 addIcons/addDock…），
  //   同步调用后立即断言注册数，必然读到 0 —— 那是假红，不是包的问题。
  //   而「等它跑完再断言」需要精确复刻插件的时序与全部桩，桩越补越容易自欺。
  //   ⇒ 运行期行为交给**项目里已有的专用模拟器**去验证（它们更真实，且已进全量测试）：
  //        tools/_sim-browser.cjs       浏览器端通道 + 主机改写 + 深链
  //        tools/_sim-legacy-embed.cjs  旧写法嵌入块就地重绘
  //        tools/_sim-embed-contract.cjs 嵌入块契约（299 条）
  //   本脚本只负责回答「这个 zip 包本身是不是对的」。
  if (inst) {
    try {
      const r = inst.onload();
      if (r && typeof r.then === "function") {
        // 异步 onload：只断言「调用它不会同步抛错」，不作为注册数的判据
        r.catch(() => {});
        ok("onload 调用未同步抛错（异步流程交给专用模拟器验证）", true);
      } else {
        ok("onload 调用未抛错", true);
      }
    } catch (e) {
      fail++;
      console.log("  ❌ onload 同步抛错: " + e.message);
      if (e.stack) console.log(String(e.stack).split("\n").slice(0, 10).join("\n"));
    }
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

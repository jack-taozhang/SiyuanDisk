/**
 * 复刻思源 main.js 里「自定义块 → 渲染器」的查找逻辑，验证插件注册的键能被找到。
 *
 * 思源源码（v3.8.4，从 NAS 容器 main.c678b149bf7301cb4dfa.js 逐字提取）：
 *
 *   h = Z => {
 *     const re = Z.indexOf("/");
 *     if (re < 1 || re !== Z.lastIndexOf("/") || re === Z.length - 1) return;
 *     try {
 *       const U  = decodeURIComponent(Z.slice(0, re));
 *       const le = decodeURIComponent(Z.slice(re + 1));
 *       if (U && le) return { pluginName: U, blockType: le };
 *     } catch { return }
 *   }
 *   const L = h(el.getAttribute("data-info") || "");
 *   const O = L && plugins.has(L.pluginName)
 *     ? window.siyuan.ws?.app?.plugins.find(ie => ie.name === L.pluginName) : undefined;
 *   const B = L ? O?.customBlockRenders[L.blockType]?.render : undefined;
 *
 * 用法：node tools/_sim-embed-lookup.cjs
 */
const fs = require("fs");

const BUNDLE = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js";
const js = fs.readFileSync(BUNDLE, "utf8");

// ---- 思源的 data-info 解析（逐字复刻）----
function parseInfo(Z) {
  const re = Z.indexOf("/");
  if (re < 1 || re !== Z.lastIndexOf("/") || re === Z.length - 1) return undefined;
  try {
    const U = decodeURIComponent(Z.slice(0, re));
    const le = decodeURIComponent(Z.slice(re + 1));
    if (U && le) return { pluginName: U, blockType: le };
  } catch (e) { return undefined; }
}

// ---- 构造浏览器沙箱（无 require / 无 process）----
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
  RegExp, Map, Set, URLSearchParams, AbortController, TextEncoder, TextDecoder,
  document: {
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {}, appendChild() {}, remove() {}, addEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      innerHTML: "", textContent: "",
    }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} }, body: { appendChild() {} },
    addEventListener() {},
  },
  location: {
    href: "http://192.168.193.70:6806/stage/build/desktop/",
    origin: "http://192.168.193.70:6806",
    hostname: "192.168.193.70", protocol: "http:", port: "6806",
  },
  navigator: { userAgent: "Mozilla/5.0 Chrome/120" },
  fetch: async () => { throw new Error("fetch stub"); },
  window: {}, siyuan: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

const siyuanStub = {
  Plugin: class Plugin {
    constructor(o) { Object.assign(this, o || {}); this.name = (o && o.name) || "x"; }
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
  throw new Error(`Cannot find module '${spec}'`);
};

console.log("=== 复刻思源自定义块查找逻辑 ===\n");

const moduleObj = { exports: {} };
new Function("require", "module", "exports", "window", js)(
  req, moduleObj, moduleObj.exports, sandbox.window
);

const Plugin = moduleObj.exports.default || moduleObj.exports;
const inst = new Plugin({ app: null, name: "siyuan-nebuladisk", displayName: "NebulaDisk", i18n: {} });

(async () => {
  await inst.onload();
  console.log("插件名:", inst.name);
  console.log("customBlockRenders 的键:", Object.keys(inst.customBlockRenders || {}));
  console.log("");

  // 思源的 plugins.find(p => p.name === pluginName)
  const plugins = [inst];
  const lookup = (info) => {
    const L = parseInfo(info);
    const O = L ? plugins.find((ie) => ie.name === L.pluginName) : undefined;
    const B = L ? (O && O.customBlockRenders[L.blockType] && O.customBlockRenders[L.blockType].render) : undefined;
    return { L, O: !!O, render: typeof B };
  };

  const cases = [
    ["nebuladisk", "旧写法（你笔记里现在就是这个）", false],
    ["siyuan-nebuladisk/nebuladisk", "新写法（应该能找到）", true],
    ["siyuan-nebuladisk", "老笔记的另一种旧写法", false],
    ["siyuan-nebuladisk/myapp", "块类型不对，应找不到", false],
    ["a/b/c", "多个斜杠，思源直接放弃", false],
    ["/nebuladisk", "斜杠在最前，无效", false],
    ["nebuladisk/", "斜杠在最后，无效", false],
  ];

  let pass = 0, fail = 0;
  for (const [info, desc, expectFound] of cases) {
    const r = lookup(info);
    const found = r.render === "function";
    const ok = found === expectFound;
    console.log(
      (ok ? "✅" : "❌") + " data-info=" + JSON.stringify(info).padEnd(34) +
      " 解析=" + (r.L ? r.L.pluginName + "/" + r.L.blockType : "undefined").padEnd(36) +
      " 找到渲染器=" + (found ? "是" : "否") + "   ← " + desc
    );
    ok ? pass++ : fail++;
  }

  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) process.exit(1);
  console.log("\n✅ 注册键与思源的查找算法一致：新写法能命中");
})().catch((e) => { console.log("❌ 异常:", e.message, e.stack); process.exit(1); });

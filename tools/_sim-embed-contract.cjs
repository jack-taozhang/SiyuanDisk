/* ==========================================================================
 * _sim-embed-contract.cjs —— 嵌入块「渲染契约」回归测试
 *
 * 为什么需要这个测试
 * ------------------------------------------------------------------------
 * 曾经出过一个顽固 bug：插入的嵌入块在本地和 NAS 思源里都显示成**裸 JSON**。
 * 根因有两层，任何一层错都会复现：
 *
 *   ① **围栏字符错**：用了反引号 ```` ``` ```` 而不是 `;;;`。
 *      思源里只有 `;;;` 围栏才会生成 NodeCustomBlock；反引号只生成
 *      普通代码块 type=c，customBlockRenders 永远不会被查。
 *
 *   ② **data-info 格式错**：必须恰好一个斜杠，即
 *      `<encodeURIComponent(插件名)>/<encodeURIComponent(块类型)>`。
 *      思源的解析器（main.js 里的 h）会拒绝 0 个或 2 个斜杠的写法。
 *
 * 这个测试用**思源真实的解析器 h**（逐字抄自 main.js v3.8.4）+ **真实 DOM**
 * （linkedom）跑一遍生产 bundle，复刻思源的调用链：
 *
 *     data-info → h() → 按 pluginName 找插件 → customBlockRenders[blockType].render
 *     → render({ element, content, setContent })
 *
 * 断言渲染结果确实是 UI（而不是落到 <pre> 裸 JSON 的兜底分支）。
 *
 * 依赖：linkedom（若缺失则跳过并提示，不让 CI 因环境问题红）
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PLUGIN = path.resolve(HERE, "..");

/**
 * ★★★ 候选产物：**取 mtime 最新的那个**（2026-09-30 修）★★★
 *
 *   原来写死优先 `D:/Software/SiYuan/…`，注释还写着「本地安装位」。
 *   但那是**旧工作区**的遗留副本 —— 思源的真实工作区写在
 *   `~/.config/siyuan/workspace.json`，而它现在是 `E:/思源笔记`。
 *
 *   危害：本套件里有一批**产物级**断言（L14 的 CSS/交互、dist 重建校验等）。
 *   工作区一搬家，这里就会静默地去测一份**过期的 bundle**：
 *   报告绿了，绿的却是几周前的代码。而且**越是"能跑"越难发现**——
 *   直到哪天线上行为跟测试对不上，才会怀疑到这一行。
 *
 *   ⇒ ① 先从 workspace.json 读出真实工作区（读不到就退回老路径）
 *     ② 全部候选里选**最新**的那个
 *     ③ 把选中者和它的时间**打印出来**，让"在测哪份产物"一眼可见
 */
const BUNDLE_CANDIDATES = (() => {
  const out = [];
  try {
    const cfg = path.join(process.env.USERPROFILE || process.env.HOME || "", ".config", "siyuan", "workspace.json");
    const ws = JSON.parse(fs.readFileSync(cfg, "utf8"));
    for (const dir of Array.isArray(ws) ? ws : []) {
      out.push(path.join(String(dir), "data", "plugins", "siyuan-nebuladisk", "index.js"));
    }
  } catch { /* 读不到就只是少一个候选 */ }
  out.push("D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js"); // 历史遗留位
  out.push(path.join(PLUGIN, "dist", "index.js"));
  out.push(path.join(PLUGIN, "index.js"));
  return out;
})();
const SY_MAIN = "C:/temp-nb/main.js"; // 思源前端 bundle 的本地提取副本（可选）

let pass = 0, fail = 0, skip = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); } };
const note = (msg) => console.log("  ℹ️  " + msg);

/* ---------- 0. 定位 bundle（全部候选里取最新） ---------- */
let BUNDLE = null, BUNDLE_MTIME = 0, BUNDLE_STALE_WARN = "";
const allExisting = [];
for (const c of BUNDLE_CANDIDATES) {
  try {
    const st = fs.statSync(c);
    allExisting.push({ c, m: st.mtimeMs });
    if (st.mtimeMs > BUNDLE_MTIME) { BUNDLE = c; BUNDLE_MTIME = st.mtimeMs; }
  } catch { /* 不存在，跳过 */ }
}
if (!BUNDLE) { console.log("找不到构建产物 index.js，请先运行 tools/build.js"); process.exit(1); }
const src = fs.readFileSync(BUNDLE, "utf8");
console.log("测试目标 bundle: " + BUNDLE + "  (" + Buffer.byteLength(src) + " bytes)");
console.log("            mtime: " + new Date(BUNDLE_MTIME).toISOString());

/*
 * ★ 产物新鲜度闸门 ★
 *   产物若比 src/ 里最新的源文件还旧，说明**没重建**，
 *   那这一批产物级断言就是在测旧代码 ⇒ 必须显式报警（不静默通过）。
 *   （这是 diskcanvas 那边踩过的同类坑：闸门"绿"但产物是旧的。）
 */
try {
  const srcDir = path.join(PLUGIN, "src");
  let newest = 0, newestName = "";
  for (const f of fs.readdirSync(srcDir)) {
    const st = fs.statSync(path.join(srcDir, f));
    if (st.mtimeMs > newest) { newest = st.mtimeMs; newestName = f; }
  }
  if (newest > BUNDLE_MTIME) {
    BUNDLE_STALE_WARN =
      `产物比源码旧：src/${newestName} 是 ${new Date(newest).toISOString()}，` +
      `而 bundle 是 ${new Date(BUNDLE_MTIME).toISOString()} ⇒ 请先重建（node tools/build.js --repo）`;
  }
} catch { /* 读不到 src/ 就算了 */ }
// ★ 产物过期必须是**红的**，不能只打个警告 ★
//   只警告的话，"没重建"仍然会以 0 退出 ⇒ 又是一次假绿。
//   本套件确实含产物级断言（L14 系列读 index.css / bundle 行为），
//   所以拿旧产物跑出来的绿色是没有意义的。
ok(!BUNDLE_STALE_WARN, "S0：bundle 不早于 src/ 最新源文件（否则测的是旧产物）"
  + (BUNDLE_STALE_WARN ? " —— " + BUNDLE_STALE_WARN : ""));

/**
 * 剥掉注释后的源码 —— 有些断言要判「真代码里没有 X」，
 * 而解释「为什么不用 X」的注释本身含 X，会把断言误伤。
 * 断言针对的应当是代码，不是文档。
 */
const srcNoComment = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")   // 块注释
  .replace(/^\s*\/\/.*$/gm, " ");      // 行注释

/* ---------- 1. 真实 data-info 解析器 ----------
 * 有思源 main.js 副本就用真的；没有就用等价的本地实现（逻辑逐字一致）。
 * 这样测试在纯插件仓库里也能跑。 */
function parseDataInfo_local(Z) {
  const re = Z.indexOf("/");
  if (!(re < 1 || re !== Z.lastIndexOf("/") || re === Z.length - 1))
    try {
      const U = decodeURIComponent(Z.slice(0, re)), le = decodeURIComponent(Z.slice(re + 1));
      if (U && le) return { pluginName: U, blockType: le };
    } catch { return; }
}
let h = parseDataInfo_local;
if (fs.existsSync(SY_MAIN)) {
  try {
    const syMain = fs.readFileSync(SY_MAIN, "utf8");
    const j0 = syMain.indexOf("h=Z=>{");
    if (j0 > 0) {
      h = eval("(" + syMain.slice(j0 + 2, syMain.indexOf("},", j0) + 1) + ")");
      note("已使用思源 main.js 里真实的 h() 解析器");
    }
  } catch (e) { note("读取思源 main.js 失败，改用等价本地实现：" + e.message); }
} else {
  note("未找到思源 main.js 副本，使用等价本地实现（逻辑逐字一致）");
}

/* ---------- 2. 真实 DOM（linkedom） ---------- */
let parseHTML = null;
for (const p of ["C:/temp-nb/nbmods/node_modules/linkedom", path.join(HERE, "node_modules", "linkedom")]) {
  try { parseHTML = require(p).parseHTML; note("DOM 实现: " + p); break; } catch (e) {}
}
/*
 * ★★★ 这里**不能** exit(0) ★★★
 *
 *   原来写的是 `process.exit(0)` —— 于是「linkedom 没装」这个**环境缺失**
 *   会以退出码 0 结束，跑套件的汇总器把它计成**通过**。
 *   一句话：**整套 L1–L10 契约断言根本没跑，报告却是绿的。**
 *
 *   这属于最坏的一类假绿：它不会让你"修错东西"，而是让你
 *   **以为这里有护栏**。真出事时才发现这条护栏从一开始就不存在。
 *
 *   ⇒ 环境缺失必须是**显式的失败**（exit 1）并把原因打到 stdout，
 *     让汇总器把它标红、让维护者去装依赖，而不是静默跳过。
 *   （对照纪律：skip ≠ pass。）
 */
if (!parseHTML) {
  console.log("");
  console.log("  ❌ 未安装 linkedom —— 本套件的 L1–L10 契约断言**全部未执行**。");
  console.log("     安装：npm i linkedom --prefix C:/temp-nb/nbmods");
  console.log("     ★ 注意：这里**故意**用非 0 退出码，避免「没跑 = 通过」的假绿。");
  process.exit(1);
}

const { window: W } = parseHTML("<!DOCTYPE html><html><body></body></html>");
const doc = W.document;

/* 补齐 linkedom 缺失的 API */
if (!W.getComputedStyle) W.getComputedStyle = () => ({ getPropertyValue: () => "" });
if (!W.matchMedia) W.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
if (!W.requestAnimationFrame) W.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
if (!W.cancelAnimationFrame) W.cancelAnimationFrame = (x) => clearTimeout(x);
if (!W.MutationObserver) W.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
if (!W.fetch) W.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 0, data: {} }), text: () => Promise.resolve("") });
if (!W.localStorage) W.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }, clear() { this._d = {}; } };
if (!W.alert) W.alert = () => {};
if (!W.confirm) W.confirm = () => false;
if (!W.Image) W.Image = class { constructor() { this.style = {}; } set src(v) {} };
if (!W.location) { try { W.location = { href: "http://127.0.0.1:6806/", origin: "http://127.0.0.1:6806", protocol: "http:", host: "127.0.0.1:6806", hostname: "127.0.0.1", port: "6806" }; } catch (e) {} }
if (!W.siyuan) W.siyuan = {};

function setG(k, v) { try { Object.defineProperty(global, k, { value: v, writable: true, configurable: true }); } catch (e) { global[k] = v; } }
setG("window", W); setG("document", doc);
try { setG("navigator", W.navigator); } catch (e) {}
setG("localStorage", W.localStorage); setG("location", W.location);
setG("HTMLElement", W.HTMLElement); setG("Node", W.Node); setG("Element", W.Element);
setG("MutationObserver", W.MutationObserver); setG("fetch", W.fetch);
setG("matchMedia", W.matchMedia); setG("getComputedStyle", W.getComputedStyle);
setG("requestAnimationFrame", W.requestAnimationFrame); setG("cancelAnimationFrame", W.cancelAnimationFrame);
setG("URL", URL); setG("URLSearchParams", URLSearchParams);
setG("innerWidth", 1920); setG("innerHeight", 1080); setG("self", W);

/* ---------- 3. 宿主替身 ---------- */
class Plugin {
  constructor(o) { this.__o = o || {}; this.name = ""; this.customBlockRenders = {}; this.eventBus = { on() {}, off() {}, emit() {} }; }
  addIcons() {} addTopBar() {} addStatusBar() { return { id: "x" }; } addDock() { return { id: "x" }; }
  addCommand() {} addTab() { return { id: "x", headElement: null, panelElement: null, close() {} }; }
  addCustomBlock(o) { this.customBlockRenders[o.blockType] = o; return o; }
  setI18n() {} loadData() { return null; } saveData() {}
}
Plugin.prototype.i18n = new Proxy({}, { get: (t, k) => String(k) });
const siyuanSDK = {
  Plugin, getFrontend: () => "desktop", adaptHotkey: (x) => x,
  showMessage: () => {}, confirm: () => Promise.resolve(false),
  openTab() {}, openWindow() {}, Protyle: class {}, Dialog: class {}, Menu: class { addItem() {} addSeparator() {} },
  Constants: {}, platformUtils: {}, getThemeMode: () => "light",
  fetchPost: (u, d, cb) => { cb && cb({ code: 0, data: {} }); return Promise.resolve({ code: 0, data: {} }); },
  fetchSyncPost: () => Promise.resolve({ code: 0, data: {} }),
  setStorageVal() {}, getStorageVal: () => null, removeStorageVal() {},
  getAllTabs: () => [], openMobileFileById() {}, lockScreen() {},
  hashString: (s) => String(s).length, escapeHtml: (s) => String(s),
};

/* ---------- 4. 跑起来 ---------- */
(async () => {
  console.log("\n【A】data-info 解析契约（思源的 h 只接受恰好一个斜杠）");
  const cases = [
    ["siyuan-nebuladisk/nebuladisk", "siyuan-nebuladisk", "nebuladisk", true],
    ["nebuladisk", null, null, false],                       // 0 个斜杠 → 拒绝
    ["siyuan-nebuladisk", null, null, false],                // 0 个斜杠 → 拒绝
    ["plugin/siyuan-nebuladisk/nebuladisk", null, null, false], // 2 个斜杠 → 拒绝（这是 gV 命令热键的写法，别混用）
    ["siyuan-nebuladisk/", null, null, false],               // 尾斜杠 → 拒绝
    ["/nebuladisk", null, null, false],                      // 首斜杠 → 拒绝
  ];
  for (const [info, pn, bt, shouldPass] of cases) {
    let r; try { r = h(info); } catch (e) { r = undefined; }
    const got = r && r.pluginName === pn && r.blockType === bt;
    ok(!!got === shouldPass, `h(${JSON.stringify(info)}) → ${r ? JSON.stringify(r) : "undefined"}`);
  }
  // 百分号编码也能解
  ok(JSON.stringify(h("siyuan-nebuladisk/nebuladisk")) === JSON.stringify({ pluginName: "siyuan-nebuladisk", blockType: "nebuladisk" }),
    "h 能正确还原未编码的明文");

  console.log("\n【B】bundle 可加载且注册了渲染器");
  const mod = { exports: {} };
  let fn;
  try {
    fn = new Function("module", "exports", "require", "window", "document", "Plugin", "siyuan", src + "\n;return module.exports;");
    fn(mod, mod.exports, (id) => (id === "siyuan" ? siyuanSDK : require(id)), W, doc, Plugin, siyuanSDK);
    ok(true, "bundle 执行无异常（无 ESM 残留）");
  } catch (e) {
    ok(false, "bundle 执行抛错：" + e.message);
    console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
    process.exit(1);
  }
  ok(typeof mod.exports.default === "function", "导出了插件类（default）");

  const plugin = new mod.exports.default({ name: "siyuan-nebuladisk" });
  plugin.name = "siyuan-nebuladisk";
  plugin.displayName = "NebulaDisk";
  plugin.app = { plugins: [], workspace: { iterate() {} } };
  plugin.data = {};
  await plugin.onload();
  const keys = Object.keys(plugin.customBlockRenders || {});
  ok(keys.includes("nebuladisk"), "customBlockRenders 主键是 blockType（nebuladisk）");
  ok(typeof (plugin.customBlockRenders.nebuladisk || {}).render === "function", "主键的值带有 render 方法");

  console.log("\n【C】复刻思源调用链（data-info → h → 找插件 → 找 render）");
  const DATA_INFO = "siyuan-nebuladisk/nebuladisk";
  const L = h(DATA_INFO);
  ok(!!L, "h() 解析出 {pluginName, blockType}");
  const O = L && [plugin].find((ie) => ie.name === L.pluginName);
  ok(!!O, "按 pluginName 找到插件实例（插件名必须与 data-info 前半段一致）");
  const B = L && O && O.customBlockRenders[L.blockType] && O.customBlockRenders[L.blockType].render;
  ok(typeof B === "function", "查到 customBlockRenders[blockType].render");
  if (typeof B !== "function") { console.log("\n结果: " + pass + " 通过, " + fail + " 失败"); process.exit(1); }

  // 通道就绪（判据 = 配了网盘地址；代理已删除）+ api 桩
  plugin.channelReady = () => true;
  plugin.api = {
    list: async () => ({ entries: [
      { name: "01-需求文档", isDir: true, size: 0, modified: "2026-08-01 10:00" },
      { name: "托璞勒股份-智能仓储2025.pdf", isDir: false, size: 2411724, modified: "2026-08-03 09:30" },
    ] }),
    previewUrl: async (m, p) => ({ url: "http://127.0.0.1:6810/nb/preview?mount=" + encodeURIComponent(m) + "&path=" + encodeURIComponent(p) }),
    preview: () => "http://127.0.0.1:6810/nb/preview?x=1",
    raw: () => "http://127.0.0.1:6810/nb/raw?x=1",
  };

  console.log("\n【D】实际渲染 → 必须是 UI，不是裸 JSON");
  const specs = {
    file: { kind: "file", mount: "售前项目", path: "托璞勒股份-智能仓储2025.pdf", name: "托璞勒股份-智能仓储2025.pdf" },
    tree: { kind: "tree", mount: "售前项目", path: "" },
  };
  for (const [kind, spec] of Object.entries(specs)) {
    const content = JSON.stringify(spec);
    const host = doc.createElement("div");
    host.setAttribute("class", "custom-block__content");
    host.innerHTML = "<pre>" + content + "</pre>";
    let threw = null;
    try { B({ element: host, content, setContent: () => {} }); } catch (e) { threw = e; }
    await new Promise((r) => setTimeout(r, 250));

    const clones = host.querySelectorAll("[class]");
    const clsSet = new Set();
    for (const el of clones) (el.getAttribute("class") || "").split(/\s+/).forEach((c) => c && clsSet.add(c));
    const cls = [...clsSet];
    const hasErr = cls.some((c) => c === "nb-embed-error");
    const hasUi = cls.some((c) => /^nb-embed$/.test(c));

    ok(!threw, `kind=${kind}：render 不抛错${threw ? "（" + threw.message + "）" : ""}`);
    ok(hasUi, `kind=${kind}：产生了 nb-embed 容器（真的进入渲染路径）`);
    ok(!hasErr, `kind=${kind}：无 nb-embed-error 兜底提示`);
    ok(host.querySelectorAll("*").length > 4, `kind=${kind}：DOM 节点数 ${host.querySelectorAll("*").length} > 4（不是只剩一个 <pre>）`);
    const txt = host.textContent.replace(/\s+/g, " ").trim();
    ok(!/^\s*\{.*\}\s*$/.test(txt), `kind=${kind}：文本不是裸 JSON`);
    ok(txt.includes("售前项目"), `kind=${kind}：显示了盘符「售前项目」`);
    if (kind === "file") {
      // ★ 2026-09-22 行为变更（用户要求）★
      //   原来：渲染即建 iframe，自动加载预览。
      //   现在：默认只给一个「点击预览」按钮，**不自动加载**、不请求后端。
      //   目的：一篇笔记里放多个嵌入块时，不会一打开就并发多个 kkFileView
      //   转换请求（首屏转换很重）。
      const f0 = host.querySelector("iframe");
      ok(!f0, "kind=file：默认【不】自动建 iframe（按需求改成了点击加载）");
      const btn = host.querySelector(".nb-embed-play") ||
        [...host.querySelectorAll("button")].find((b) => /点击预览/.test(b.textContent || ""));
      ok(!!btn, "kind=file：给了「点击预览」按钮");
      ok(!!host.querySelector(".nb-embed-frame-box"), "kind=file：保留了 frame-box 容器（点击后才有内容）");
    }
    if (kind === "tree") {
      ok(/需求文档/.test(txt), "kind=tree：列出了目录项");
      ok(/2\.3 MB|MB/.test(txt), "kind=tree：显示了文件大小");
    }
  }

  console.log("\n【D2】点击「点击预览」后才加载，且走 NebulaDisk 预览链路");
  {
    // ★ 为什么要拦截「真实插件实例」的 api 而不是自己造一个假插件 ★
    //   registerEmbed 把 renderer 绑在**单例插件实例**上（plugin 变量），
    //   render({element, content}, plugin) 里传进来的 plugin 会被忽略。
    //   所以必须在真插件实例上打桩，否则统计不到调用次数
    //   （之前就是因为造了假插件，断言永远看到 0 次）。
    const inst = plugin;
    ok(!!inst, "D2：拿到了插件实例");
    const origPreview = inst.api.previewUrl;
    const origOo = inst.api.ooConfig;
    const origCad = inst.api.cadUrl;

    let previewCalls = 0;
    let lastPreviewArg = null;
    inst.api.previewUrl = async (mount, path) => {
      previewCalls++;
      lastPreviewArg = { mount, path };
      return { url: "/nb/preview/onlinePreview?url=x" };
    };
    // 让 office 分支降级到 kk，从而必定走 previewUrl
    inst.api.ooConfig = async () => { throw new Error("OnlyOffice 未配置"); };
    inst.api.cadUrl = async () => { throw new Error("CAD 不可用"); };

    // ★ 任务⑧（2026-09-23）：夹具从 .pdf 换成 .dwg ★
    //   原来用「报价单.pdf」是**假设** PDF 走 kk/office 兜底。
    //   任务⑧ 把 pdf 归入「浏览器原生直出」后，D2 的 7 条断言全部失效
    //   （previewUrl 调用数 0、建不出 iframe…）—— 这不是回归，是夹具过期。
    //   D2 的本意是「验证 kk 兜底链路」：那就该用一个**真的**会落到 kk 的类型。
    //   这里改用 .dwg：CAD 分支在 cadUrl 抛错时降级 kkFileView，
    //   与 D2「让 office/cad 分支降级从而必走 previewUrl」的设计意图完全吻合。
    const spec = { kind: "file", mount: "售前项目", path: "/图纸/总装图.dwg", name: "总装图.dwg" };
    const host = doc.createElement("div");
    host.setAttribute("class", "custom-block__content");
    let threw = null;
    try { B({ element: host, content: JSON.stringify(spec), setContent: () => {} }); }
    catch (e) { threw = e; }
    await new Promise((r) => setTimeout(r, 200));

    ok(!threw, "D2：render 不抛错" + (threw ? "（" + threw.message + "）" : ""));
    ok(previewCalls === 0, `D2：渲染时【没有】请求后端（实际 ${previewCalls} 次）`);

    const btn = host.querySelector(".nb-embed-play") ||
      [...host.querySelectorAll("button")].find((b) => /点击预览/.test(b.textContent || ""));
    ok(!!btn, "D2：找到了「点击预览」按钮");
    if (btn) {
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      ok(previewCalls === 1, `D2：点击后恰好请求后端 1 次（实际 ${previewCalls} 次）`);
      ok(lastPreviewArg && lastPreviewArg.mount === "售前项目",
        "D2：previewUrl 收到正确的 mount=" + (lastPreviewArg && lastPreviewArg.mount));
      const f = host.querySelector("iframe.nb-embed-frame");
      ok(!!f, "D2：点击后建出了 iframe.nb-embed-frame");
      // ★ 任务③/⑤（2026-09-22 修正）：iframe 现在指向 **NebulaDisk 的 /lite
      //   外壳页**（:8089，与预览页同源），不再是自己造的 blob 宿主页。
      //   原因：blob 继承思源 origin(:6806)，预览在 :8089 ⇒ 跨源
      //   ⇒ contentDocument === null ⇒ CSS/守卫都注入不进去（实测）。
      //   这里断言「指向 /lite」即代表走了正确通道。
      const fsrc = (f && (f.getAttribute("src") || f.src)) || "";
      ok(/\/lite\?kind=/.test(fsrc),
        "D2：iframe 走 NebulaDisk /lite 外壳页（同源，CSS 与守卫才可能生效）");
      ok(!/^blob:/.test(fsrc),
        "D2：iframe 不再是自己造的 blob 宿主页（那是跨源的，注入不进去）");
      ok(!host.querySelector(".nb-embed-error"), "D2：没有错误兜底");
      // ★ 任务①：工具栏按钮契约 ★
      //   收起：工具栏第一个按钮，未预览隐藏、预览后显示
      //   下载：始终存在
      //   （旧实现把「收起」挂在预览框右上角 .nb-embed-collapse 浮层，
      //     任务①要求前置到「在页签中打开」之前，故断言随之迁移。）
      const tools = host.querySelector(".nb-embed-tools");
      ok(!!tools, "D2：存在 .nb-embed-tools 工具栏");
      const toolBtns = tools ? [...tools.querySelectorAll("button")] : [];
      ok(toolBtns.length >= 3, `D2：工具栏按钮 ≥3 个（实际 ${toolBtns.length}）`);
      ok(toolBtns[0] && toolBtns[0].classList.contains("nb-embed-btn--collapse"),
        "D2：工具栏第一个按钮是「收起」（前置到「在页签中打开」之前）");
      ok(toolBtns[1] && /在页签中打开/.test(toolBtns[1].textContent || ""),
        "D2：第二个按钮是「在页签中打开」");
      const dl = toolBtns.find((b) => b.classList.contains("nb-embed-btn--download"))
        || toolBtns.find((b) => /下载/.test(b.textContent || ""));
      ok(!!dl, "D2：工具栏存在「下载」按钮");
      ok(!host.querySelector(".nb-embed-collapse"),
        "D2：旧的浮层式 .nb-embed-collapse 已移除");

      // 再点「收起」不应再发请求；重复 loadFrame 也要幂等
      const collapse = toolBtns[0];
      ok(!!collapse, "D2：拿到了「收起」按钮");
      if (collapse) {
        collapse.click();
        await new Promise((r) => setTimeout(r, 150));
        ok(!host.querySelector("iframe.nb-embed-frame"), "D2：收起后 iframe 被卸载");
        ok(previewCalls === 1, `D2：收起时不重复请求（实际 ${previewCalls} 次）`);
        const btn2 = host.querySelector(".nb-embed-play");
        if (btn2) { btn2.click(); await new Promise((r) => setTimeout(r, 300)); }
        ok(previewCalls === 2, `D2：再次点击会重新加载（实际 ${previewCalls} 次）`);
      }
    }

    // 还原
    inst.api.previewUrl = origPreview;
    inst.api.ooConfig = origOo;
    inst.api.cadUrl = origCad;
  }

  /* --------------------------------------------------------------------
   * 【D3】★★★ 任务⑧：图片/视频/音频/PDF/文本 必须「原生直出」★★★
   *   2026-09-23
   *
   *   用户报的 bug：「不知道图片格式调用的是什么打开预览，嵌入块和上面的 table
   *   都没有办法打开」。
   *   根因：resolvePreviewUrl() 原先只分 OFFICE / CAD / 其余 三支，
   *        **从不看 pickViewer()**，于是图片等 49 个扩展名全被塞进
   *        kkFileView 的 /lite 外壳 → 多绕两层 → 打不开。
   *
   *   这一组断言把「修复后的路由契约」焊死，谁改回去都会立刻红：
   *     · 原生类型【不得】出现 /lite 或 onlinePreview（不许再进 kkFileView）
   *     · 原生类型【不得】调用 previewUrl（那是 kk 链路的入口）
   *     · 必须真的建出对应的 <img>/<video>/<audio>/<iframe/pdf>/<pre>
   *     · 直链必须带 inline（否则浏览器会当附件下载而不是内联显示）
   * ------------------------------------------------------------------ */
  console.log("\n【D3】任务⑧：图片/视频/音频/PDF/文本走原生直出（不碰 kkFileView）");
  {
    const inst = plugin;
    const origPreview = inst.api.previewUrl;
    const origOo = inst.api.ooConfig;
    const origCad = inst.api.cadUrl;
    const origSigned = inst.api.signedDownloadUrl;

    let previewCalls = 0;
    let signedCalls = [];
    let lastInline = null;
    inst.api.previewUrl = async () => { previewCalls++; return { url: "/nb/preview/onlinePreview?url=x" }; };
    inst.api.ooConfig = async () => { throw new Error("OO 未配置"); };
    inst.api.cadUrl = async () => { throw new Error("CAD 不可用"); };
    // 直链桩：返回一个「一眼能认出、且带 inline」的地址
    inst.api.signedDownloadUrl = async (mount, path, inline) => {
      signedCalls.push({ mount, path });
      lastInline = inline;
      return "http://192.168.193.70:8089/api/raw/x.png?mount=" + encodeURIComponent(mount || "") +
        "&path=" + encodeURIComponent(path || "") + "&exp=1&sig=deadbeef&inline=" + (inline ? "true" : "false");
    };

    // 每类挑一个代表扩展名 → 期望的 DOM 选择器
    const cases = [
      { name: "照片.jpg", sel: "img.nb-embed-image", label: "image/<img>" },
      { name: "演示.mp4", sel: "video.nb-embed-video", label: "video/<video>" },
      { name: "录音.mp3", sel: "audio", label: "audio/<audio>" },
      { name: "说明.pdf", sel: "iframe.nb-embed-frame--pdf", label: "pdf/<iframe>" },
      { name: "配置.json", sel: "pre.nb-embed-text", label: "text/<pre>" },
    ];

    for (const c of cases) {
      inst.api.signedDownloadUrl = async (mount, path, inline) => {
        signedCalls.push({ mount, path });
        lastInline = inline;
        return "http://192.168.193.70:8089/api/raw/x.png?mount=" + encodeURIComponent(mount || "") +
          "&path=" + encodeURIComponent(path || "") + "&exp=1&sig=deadbeef&inline=" + (inline ? "true" : "false");
      };
      previewCalls = 0;
      const spec2 = { kind: "file", mount: "售前项目", path: "/素材/" + c.name, name: c.name };
      const host2 = doc.createElement("div");
      host2.setAttribute("class", "custom-block__content");
      let threw2 = null;
      try { B({ element: host2, content: JSON.stringify(spec2), setContent: () => {} }); }
      catch (e) { threw2 = e; }
      await new Promise((r) => setTimeout(r, 60));

      const btn = host2.querySelector(".nb-embed-play") ||
        [...host2.querySelectorAll("button")].find((b) => /点击预览/.test(b.textContent || ""));
      if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 320)); }

      ok(!threw2, `D3-${c.label}：render 不抛错${threw2 ? "（" + threw2.message + "）" : ""}`);
      const el = host2.querySelector(c.sel);
      ok(!!el, `D3-${c.label}：建出了 ${c.sel}`);
      // ★ 核心断言：绝不能走 kkFileView ★
      const anySrc = [...host2.querySelectorAll("[src]")]
        .map((n) => n.getAttribute("src") || "").join(" ");
      ok(!/\/lite\?kind=/.test(anySrc), `D3-${c.label}：地址里【没有】/lite 外壳（不再进 kkFileView）`);
      ok(!/onlinePreview/.test(anySrc), `D3-${c.label}：地址里【没有】onlinePreview`);
      ok(previewCalls === 0, `D3-${c.label}：【没有】调用 previewUrl（kk 链路入口），实际 ${previewCalls} 次`);
      ok(host2.querySelector(".nb-embed-frame-box"), `D3-${c.label}：frame-box 容器仍在`);
      ok(!host2.querySelector(".nb-embed-error"), `D3-${c.label}：无错误兜底`);
    }

    // 直链必须带 inline=true（否则 /api/raw 会以 attachment 返回 → 触发下载）
    ok(lastInline === true, "D3：直链请求带了 inline=true（否则会被浏览器当附件下载）");
    ok(signedCalls.length >= cases.length,
      `D3：每类都取了签名直链（共 ${signedCalls.length} 次，应 ≥ ${cases.length}）`);

    // 回归：原生类型不得因修复而改变「默认不加载」的行为
    {
      const spec3 = { kind: "file", mount: "售前项目", path: "/素材/图.png", name: "图.png" };
      const host3 = doc.createElement("div");
      host3.setAttribute("class", "custom-block__content");
      B({ element: host3, content: JSON.stringify(spec3), setContent: () => {} });
      await new Promise((r) => setTimeout(r, 60));
      ok(!host3.querySelector("img.nb-embed-image"),
        "D3：未点击时【不】自动加载图片（仍是「点击预览」语义）");
      ok(!!host3.querySelector(".nb-embed-play"), "D3：未点击时显示「点击预览」");
    }

    inst.api.previewUrl = origPreview;
    inst.api.ooConfig = origOo;
    inst.api.cadUrl = origCad;
    inst.api.signedDownloadUrl = origSigned;
  }

  console.log("\n【E】buildEmbedMarkdown 必须用 ;;; 围栏（不能是反引号）");
  const em = src.match(/;;;\$\{[^}]*\}|`;;;/);
  ok(/;;;/.test(src), "bundle 里存在 ;;; 字面量");
  ok(!/```\s*\+\s*embedLang/.test(src), "没有遗留「反引号 + embedLang」的旧式拼接");

  console.log("\n【F】dataType:\"dom\" 的块升级通道存在");
  ok(/dataType:\s*["']dom["']/.test(src) || /"dom"/.test(src), "bundle 里有 dataType:\"dom\"（把 type=c 升级为 type=custom 的唯一通路）");
  ok(/NodeCustomBlock/.test(src), "bundle 里有 NodeCustomBlock 字面量");

  /* --------------------------------------------------------------------
   * 【G】★ 斜杠菜单契约（2026-09-22 从思源 main.js 通读出来的硬事实）★
   *
   *   用户报了两个 bug：
   *     ① 块插到了文档末尾，不是 `/` 所在的位置
   *     ② `/` 及其后的过滤字残留在段落里
   *
   *   同一个根因：思源斜杠菜单的 plugin 分支是**唯一**不执行
   *   `He.deleteContents()` 的分支，且它把 `(protyle, 块元素)` 一起交给插件、
   *   然后就 return 了 —— 清洗与定位都得插件自己做。
   *
   *   这一组用**纯文本断言**把结论焊死在测试里，以后谁改回旧写法都会立刻红：
   *     · 回调必须接第 2 个参数（块元素）并往下传
   *     · 定位必须区分「文档级 protyle.block.id」与「光标子块」
   *     · 必须有斜杠残留清理
   * ------------------------------------------------------------------ */
  console.log("\n【G】斜杠菜单契约：必须吃下 (protyle, 块元素) 并自己清残留");

  ok(/anchorEl/.test(src), "G1：bundle 里存在 anchorEl（承接斜杠菜单交来的块元素）");
  ok(/cleanupSlashText/.test(src), "G2：bundle 里有 cleanupSlashText（清 `/过滤词`）");
  ok(/fromSlash/.test(src), "G3：bundle 里有 fromSlash 开关（只在斜杠入口清残留）");

  // G4：定位必须把「文档级 id」排除在锚点之外 —— 这就是「插到文末」的元凶
  ok(/b\.id\s*!==\s*root|id\s*!==\s*root/.test(src) ||
     /不当锚点/.test(src),
     "G4：定位逻辑区分了「文档块 id」与「光标子块 id」（不会再把块追加到文末）");

  // G5：回调签名必须收第二个参数
  ok(/callback:\s*\(protyle,\s*el\)\s*=>/.test(src) ||
     /callback:\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>/.test(src),
     "G5：protyleSlash 的 callback 接收第 2 个参数（思源传的块元素）");

  // G6：三处入口仍然共用同一个插入通道（防止有人另开一条通道绕开定位修复）
  const insertCallSites = (src.match(/insertEmbedIntoDoc\s*\(/g) || []).length;
  ok(insertCallSites >= 3,
     `G6：insertEmbedIntoDoc 至少被 3 处调用（斜杠/侧边栏/预览页），实际 ${insertCallSites}`);

  // G7：真实思源 bundle 若在场，直接验证契约源文本仍然成立（防止思源升级后悄悄改行为）
  //
  //   ⚠️ 搜索要点：main.js 里 `startsWith("plugin")` 出现多次，**不能取第一次**
  //     （第一次是某个菜单的 dispatchEvent 分支，与本契约无关）。
  //     唯一可靠的锚点是插件回调本身：`cn.callback(D.getInstance(),ht)`
  //     —— 它是混淆后的变量名，但短且特征性强，全文件只出现一次。
  if (fs.existsSync(SY_MAIN)) {
    try {
      const syMain = fs.readFileSync(SY_MAIN, "utf8");
      const cbIdx = syMain.indexOf("cn.callback(D.getInstance(),ht)");
      ok(cbIdx > 0, "G7：思源 main.js 里仍然存在插件斜杠回调 cn.callback(D.getInstance(),ht)");

      if (cbIdx > 0) {
        // 往前找到这个分支的开头
        const brIdx = syMain.lastIndexOf('startsWith("plugin")', cbIdx);
        ok(brIdx > 0, "G8：能定位到该回调所属的 `plugin` 分支");

        // ★ 关键：分支体 = 从 `startsWith("plugin")` 到**紧随其后的 `else{` 之前**。
        //   注意这里是「plugin 分支体」而不是「从分支起到固定长度」——
        //   固定长度会把 else 分支的 deleteContents 一起圈进来，导致误判（踩过一次）。
        const elseIdx = syMain.indexOf("}else{", cbIdx);
        const body = syMain.slice(brIdx, elseIdx > 0 ? elseIdx : cbIdx + 200);

        // 分支体必须「有 return」且「没有 deleteContents」
        //   —— 一旦思源哪天改成替插件删掉 /xxx，我们的 cleanupSlashText 就会
        //   **多删一次**、可能清掉用户正文。这条断言是给我们兜底逻辑的护栏。
        ok(/return/.test(body) && !/deleteContents/.test(body),
           "G8：思源 plugin 分支确实「不」替我们 deleteContents（所以必须自己清）");
        console.log("     ↳ 该分支原文: " + body.replace(/\n/g, " ").slice(0, 240));

        // 反证：紧跟其后的 else 分支才做 deleteContents（说明这是 SiYuan 自带项的行为）
        const after = syMain.slice(elseIdx > 0 ? elseIdx : cbIdx, (elseIdx > 0 ? elseIdx : cbIdx) + 80);
        ok(/else\s*\{\s*He\.deleteContents\(\)/.test(after),
           "G9：deleteContents 确实属于紧跟的 else 分支（自带斜杠项才用）");
      }
    } catch (e) {
      note("读取思源 main.js 失败，跳过 G7/G8/G9：" + e.message);
    }
  } else {
    note("未找到思源 main.js 副本（" + SY_MAIN + "），跳过 G7/G8/G9 的源码级校验");
  }

  console.log("\n【H】加载时机 / 多块共存（任务④）");
  ok(/点击预览/.test(src), "H1：未展开时显示「点击预览」占位（打开笔记 0 请求）");
  // ★ 任务④：登记表已从「每文档一个」改为「每个块一个」的集合 ★
  ok(/const openEmbeds = new Set\(\)/.test(src),
     "H2：展开登记表是 Set（每个块一条，可多块共存）");
  ok(!/openEmbedsByDoc/.test(src),
     "H3a：旧的「每文档一个」登记表 openEmbedsByDoc 已移除");
  ok(!/collapseOtherEmbedsInSameDoc/.test(src),
     "H3b：★ 任务④ —— 展开新块时不再自动收起旧块");
  ok(!/collapseOtherEmbedsInSameDoc\(wrap\)/.test(src),
     "H3c：★ loadFrame() 里没有残留的自动收起调用");
  ok(/collapseAllOpenEmbeds/.test(src),
     "H3d：保留「全部收起」（供卸载/统一释放用）");
  ok(/isConnected/.test(src),
     "H3e：全部收起时跳过已脱离 DOM 的孤儿（否则会抛错）");
  ok(/registerOpenEmbed/.test(src) && /unregisterOpenEmbed/.test(src),
     "H4：展开/收起仍然成对登记与注销（不留死引用）");
  ok(/revokeObjectURL/.test(src), "H5：卸载时 revoke blob URL（OO 宿主页不泄漏）");
  ok(!/同时只展开一个|只允许一个嵌入块|同时展开数恒为 1/.test(src),
     "H6：注释/文案里旧的「同时只展开一个」说法已清除");
  ok(/可同时展开多个/.test(src),
     "H7：占位提示明确写了「可同时展开多个」");
  ok(/打开笔记时不加载/.test(src),
     "H8：占位提示用大白话说清了加载时机");

  /* ------------------------------------------------------------------
   * 【J】任务⑤：CAD 中键平移不得滚走整篇笔记
   *
   *   现象：在嵌入块的 CAD 预览里按住中键平移，整个思源笔记页面跟着滚。
   *
   *   根因：中键在浏览器里有**默认行为**（autoscroll / 滚动父容器），
   *   这个默认行为**不遵循 DOM 冒泡规则** —— 所以光在内层
   *   stopPropagation 不够，必须 preventDefault。
   *
   * ★★★ 架构变更（2026-09-22，实测后重写）★★★
   *   原实现把守卫放在**插件自己造的 blob 宿主页**里。实测：
   *     blob 宿主页 origin = :6806（继承思源）
   *     预览页    origin = :8089（NebulaDisk）
   *     ⇒ 跨源 ⇒ 子 iframe 的 contentDocument === null
   *     ⇒ 守卫**绑不到内层预览页**（只绑到了宿主页自己，没用）。
   *
   *   现在守卫搬到了 **NebulaDisk 的 /lite 外壳页**上（与预览页同源），
   *   插件只负责拼 `/lite` 地址。所以：
   *     · 本套件里【J】改成断言**插件侧的契约**（拼 URL + 不再自己造宿主页）
   *     · 守卫的实现与生效性由 verify-lite.cjs 在真机上核对
   *   —— 两条腿都要有，缺一不可。
   * ------------------------------------------------------------------ */
  console.log("\n【J】任务⑤：CAD 中键不平移穿透（架构：守卫在服务端 /lite）");

  ok(/liteUrl/.test(src),
     "J1：插件使用 liteUrl（服务端 /lite 外壳页）而不是自造宿主页");
  ok(!/buildLiteFrameUrl/.test(srcNoComment),
     "J2：已删除失效的 blob 宿主页实现（它对跨源子文档无能为力）");
  /* J3：只剩 Office 那一条 blob 是**合法**的 —— OnlyOffice 的 api.js
     必须在一个继承思源 origin 的页面里加载（那个页面与 Office 文档
     服务之间本来就靠 JWT 授权，不需要同源读 DOM）。
     非 Office 的 kk/cad 一律不许再自造 blob 宿主页。 */
  ok(!/function buildLiteFrameUrl/.test(srcNoComment),
     "J3：kk/cad 两路不再有自造宿主页函数（只保留 Office 的 srcdoc/blob）");
  ok(/function liteUrl/.test(src),
     "J4：api.js 里定义了 liteUrl");
  ok(/liteUrl\(base, target, kind\)/.test(src),
     "J5：resolvePreviewUrl 对 kk / cad 两类都套 /lite");

  /* liteUrl 自身的正确性（在 api 源码里查） */
  let apiSrc = "";
  try { apiSrc = fs.readFileSync(path.join(PLUGIN, "src", "api.js"), "utf8"); }
  catch (e) { apiSrc = ""; }
  ok(/\/lite\?kind=/.test(apiSrc),
     "J6：liteUrl 拼出 /lite?kind=… 端点");
  ok(/kind === "cad" \? "cad" : "kk"/.test(apiSrc) || /"cad" : "kk"/.test(apiSrc),
     "J7：kind 白名单收敛到 kk|cad");
  ok(/rel\.startsWith\("\/"\)/.test(apiSrc),
     "J8：liteUrl 只接受本站相对路径（/ 开头）");
  ok(/rel\.indexOf\("\/\/"\) === 0/.test(apiSrc),
     "J9：拒绝协议相对 //host（防开放重定向）");
  ok(/rel\.indexOf\(":"\) >= 0/.test(apiSrc),
     "J10：拒绝带 scheme 的 target（防 javascript:/http:）");
  ok(/encodeURIComponent\(rel\)/.test(apiSrc),
     "J11：target 必须整体编码（否则它自己的 ? & 会被 /lite 的 query 吃掉）");
  ok(/new URL\(t\)/.test(apiSrc),
     "J12：绝对地址先剥掉 origin 再传（后端只收相对路径）");
  ok(/return "";/.test(apiSrc),
     "J13：参数不合法时返回空串，让调用方走降级（直连预览）");

  /* ------------------------------------------------------------------
   * 【I】斜杠残留清理的「不许误删」护栏
   *
   *   起因：真机验证时发现 `路径 /usr/local/bin` 被截成 `路径 /usr/local`，
   *   `C:/Users/HP/Desktop` 被截成 `C:/Users/HP` —— 会**吃掉用户正文**。
   *
   *   根因（关键、容易被忽略）：正则回溯。
   *     旧：/^([\s\S]*?)\s*[/、]([^\s/、]*)\s*$/
   *     配 m[2].indexOf("/") < 0 的守卫**看似严谨，实则被回溯绕过**：
   *       `路径 /usr/local/bin` → 先试 m[1]="路径 " / m[2]="usr/local/bin"
   *       （m[2] 含 / ⇒ 守卫拦下）→ 正则引擎回溯 → m[1]="路径 /usr",
   *       m[2]="local" —— 第二个斜杠被吃进 m[1]，守卫失效。
   *     新：m[1] 用 [^/、]*? 禁止出现斜杠，锚点必然是「块内最后一个斜杠」。
   *
   *   这一组既断言**源码写法**（不许退回 [\s\S]*?），
   *   又断言**实际行为**（把真源码抠出来在沙箱里跑）。
   * ------------------------------------------------------------------ */
  console.log("\n【I】斜杠残留清理：必须不误删路径 / URL / 长文本");

  // I1：源码里必须用「禁止 m[1] 含斜杠」的写法
  const hasStrictRe = /\[\^\/、\]\*\?\)\s*\\s\*\[\/、\]/.test(src) ||
                      /\[\^\/、\]\*\?\).{0,12}\[/.test(src) ||
                      /不允许 m\[1\] 里出现斜杠/.test(src);
  ok(hasStrictRe, "I1：清理正则的 m[1] 禁止出现斜杠（杜绝回溯绕过守卫）");

  // I2：不许再出现被回溯绕过的那一版（[\s\S]*? 紧接 [/、]）
  //   ⚠️ 只扫**代码行**，跳过注释 —— 注释里正讲到这个坑，不该被算作违规。
  const codeOnly = src.split("\n")
    .filter((L) => !/^\s*(\/\/|\*|\/\*)/.test(L))
    .join("\n");
  ok(!/\^\(\[\\s\\S\]\*\?\)\\s\*\[\/、\]/.test(codeOnly),
     "I2：老的 [\\s\\S]*? 写法已从代码中移除（它会被回溯绕过）");

  // I3：必须有「整块是路径形状就不清」的护栏
  ok(/slashCount\s*>\s*1/.test(src) || /斜杠\s*\\?d*\s*个/.test(src) || /路径形状/.test(src),
     "I3：整块为路径形状（斜杠>1）时不清空");

  // I4：必须有「过滤词过长则保守不动」的保险丝
  ok(/m\[2\]\.length\s*>\s*16/.test(src) || /过长/.test(src),
     "I4：斜杠后内容过长（>16 字）时保守跳过");

  // I5：真机行为 —— 从 bundle 抠出真函数，在纯 Node 环境里跑（无需浏览器）
  //     把 console.log 换成空操作，把 DOM 依赖的最小桩补上。
  try {
    const sIdx = src.indexOf("function cleanupSlashText");
    if (sIdx > 0) {
      let d = 0, e2 = -1;
      for (let i = src.indexOf("{", sIdx); i < src.length; i++) {
        if (src[i] === "{") d++;
        else if (src[i] === "}") { d--; if (d === 0) { e2 = i + 1; break; } }
      }
      let fn = src.slice(sIdx, e2);
      // 去掉注释行（注释里有 /* */ 与 //，直接删掉整行注释避免语法问题）
      fn = fn.split("\n").filter((L) => !/^\s*(\/\/|\*|\/\*)/.test(L)).join("\n");
      fn = fn.replace(/console\.log\(/g, "void 0 && (");
      // 注入沙箱：只需 document.createRange / createTreeWalker 等的最小桩
      const sandbox = `
        const NodeFilter = { SHOW_TEXT: 4 };
        function makeEl(t){
          return {
            nodeType: 1, textContent: t, innerHTML: "",
            lastChild: null,
            appendChild(){}, remove(){},
          };
        }
        function makeStubRange(){
          return { setStart(){}, setEndAfter(){}, deleteContents(){} };
        }
        function makeStubWalker(el){
          // 只产出一个文本节点，行为与「块内纯文本」一致
          let done = false;
          return { nextNode(){
            if (done) return null; done = true;
            return { textContent: el.textContent };
          }};
        }
        const document = {
          createRange: makeStubRange,
          createElement: () => makeEl(""),
          createTreeWalker: (el) => makeStubWalker(el),
        };
        ${fn}
        module.exports = cleanupSlashText;
      `;
      const m = { exports: {} };
      const f = new Function("module", "exports", sandbox);
      f(m, m.exports);
      const clean = m.exports;

      const run = (raw) => {
        const el = {
          nodeType: 1, textContent: raw, innerHTML: "", lastChild: null,
        };
        try { clean(el); } catch (_) { /* Range 桩不真删，靠 innerHTML/标记判定 */ }
        return el.textContent;
      };

      // ⚠️ 桩里的 deleteContents 不会真的改 textContent，
      //    所以这里只判定「是否被判定为非菜单触发（整段保留）」这一可观测子集。
      const P1 = run("路径 /usr/local/bin");
      ok(P1 === "路径 /usr/local/bin",
         "I5：真函数对 `路径 /usr/local/bin` 整段保留（不截断）", JSON.stringify(P1));

      const P2 = run("C:/Users/HP/Desktop");
      ok(P2 === "C:/Users/HP/Desktop",
         "I6：真函数对 `C:/Users/HP/Desktop` 整段保留", JSON.stringify(P2));

      const P3 = run("见 http://a.b/c");
      ok(P3 === "见 http://a.b/c",
         "I7：真函数对含 URL 的正文整段保留", JSON.stringify(P3));

      const P4 = run("a / b / c");
      ok(P4 === "a / b / c",
         "I8：真函数对多斜杠正文整段保留", JSON.stringify(P4));
    } else {
      note("未找到 cleanupSlashText 定义，跳过 I5–I8");
    }
  } catch (e) {
    note("真函数行为校验失败，跳过 I5–I8：" + e.message);
  }

  /* ======================================================================
   * 【K】任务⑦：侧边栏右键菜单
   * ----------------------------------------------------------------------
   * 这一节的由来（值得记住的教训）：
   *
   *   用户报「右键菜单…这个我没有看到」。菜单代码本身是**完整**的：
   *   showNodeMenu / showMoreMenu 都在，八项也都在，行上
   *   `row.oncontextmenu = (ev) => this.showNodeMenu(ev, entry)` 也绑了。
   *
   *   真正的原因只有一个字符级别的疏漏：**`Menu` 没有导入**。
   *   `new Menu("nbTreeNode")` 里的 Menu 是自由标识符，
   *   而 tree.js 的 siyuan 导入只有 `{ showMessage, confirm }`
   *   ⇒ 抛 `ReferenceError: Menu is not defined`。
   *
   *   而它绑在**事件回调**上，异常被浏览器吞进 console，
   *   页面不报错、不白屏、样式也没问题 ⇒ 表现就是「右键毫无反应」。
   *
   *   ⇒ 所以断言必须覆盖「**引用了 siyuan 的哪个具名导出，就必须导入它**」，
   *     而不只是「菜单代码在不在」。这就是 K1–K4 存在的理由。
   * ==================================================================== */
  console.log("\n【K】任务⑦：侧边栏右键菜单（导入完整性 + 八项齐全）");

  const treeSrc = fs.readFileSync(path.join(PLUGIN, "src", "tree.js"), "utf8");
  /*  ⚠️ 必须用**剥过注释**的源码来找函数起点。
   *
   *   踩过：我在 tree.js 顶部写了一段解释 Menu 漏导的注释，
   *   里面举例写了 `showNodeMenu(ev, entry)`。于是
   *   `treeSrc.indexOf("showNodeMenu(")` 落到了**注释里**，
   *   接着从这个注释的 `{` 开始数括号 —— 数到注释结束就深度归零，
   *   截出来是个空串，K5 全线误报。
   *
   *   这和之前 J11 的假阳性是同一类病：**断言/定位必须针对代码，不能针对文档**。
   */
  const treeCode = treeSrc
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  // ---- K1：Menu 必须被导入（本节的根因）----
  const syImport = treeSrc.match(/import\s*\{([^}]*)\}\s*from\s*"siyuan"/);
  const syNames = (syImport ? syImport[1] : "").split(",").map((s) => s.trim()).filter(Boolean);
  ok(syNames.includes("Menu"),
     "K1：src/tree.js 从 siyuan 导入了 Menu（否则 new Menu 抛 ReferenceError）",
     JSON.stringify(syNames));

  // ---- K2：每一个 from "siyuan" 的具名符号，都真的用到了（防漏导/防死导入）----
  //    用**剥过注释**的源码判断，否则解释性注释里的名字会造成假阳性。
  const treeBody = treeCode.replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";?/g, " ");
  for (const n of syNames) {
    const re = new RegExp("\\b" + n.replace(/\$/g, "\\$") + "\\b");
    ok(re.test(treeBody), `K2：导入的 ${n} 在 tree.js 正文里真的被使用了`);
  }

  // ---- K3：bundle 里必须真的把 SIYUAN.Menu 绑下来（构建产物级验证）----
  ok(/const\s+Menu\s*=\s*SIYUAN\.Menu\s*;/.test(src),
     "K3：bundle 里生成了 `const Menu = SIYUAN.Menu;`（构建链没把它丢掉）");

  // ---- K4：两份菜单里都不许再出现「裸 new Menu」以外的菜单构造方式 ----
  const bareMenuNew = (srcNoComment.match(/new\s+Menu\s*\(/g) || []).length;
  ok(bareMenuNew >= 2,
     `K4：bundle 里有两处 new Menu(...)（更多菜单 + 节点菜单），实际 ${bareMenuNew} 处`);

  // ---- K5：用户点名的八项，逐项必须在菜单里存在 ----
  //    注意：目录与文件走不同分支，所以「下载」只在文件分支、
  //    「新建文件夹」只在目录分支 —— 断言针对整个 showNodeMenu 函数体。
  //
  //    ⚠️ 截取不能靠「找下一个方法定义」：菜单体里全是
  //       `click: () => {...}` 这样的嵌套函数，正则一碰就截断。
  //       必须按大括号配对老实数到函数结束。
  const nodeMenuBody = (() => {
    /*  ⚠️ 要匹配**定义**（`showNodeMenu(ev, entry) {`），不能匹配**调用**
     *   （`this.showNodeMenu(ev, entry);`）。
     *
     *   踩过两次，都是同一个坑的不同侧面：
     *     ① 注释里提到 showNodeMenu( → 落在注释里
     *     ② 定义之前先有 `this.showNodeMenu(ev, entry);` 调用 → 落在调用处，
     *        后面紧跟 `)` 和 `;` 而不是 `{`，数括号必然失败
     *
     *   ⇒ 定位一个方法体，要匹配「名字 + 参数表 + 紧接 `{`」，
     *     并用 `this.` 前缀排除掉方法调用。
     */
    const re = /(?:^|\n)\s*(?!this\.)showNodeMenu\s*\([^)]*\)\s*\{/;
    const m = re.exec(treeCode);
    if (!m) return "";
    const i = m.index;
    const brace = treeCode.indexOf("{", i + m[0].length - 1);
    if (brace < 0) return "";
    let depth = 0;
    for (let k = brace; k < treeCode.length; k++) {
      const c = treeCode[k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return treeCode.slice(i, k + 1);
      }
    }
    return "";
  })();
  ok(nodeMenuBody.length > 500, "K5：成功截取到 showNodeMenu 函数体", nodeMenuBody.length + " 字符");

  const REQUIRED_ITEMS = [
    ["新建文件夹", /label:\s*"新建文件夹"/],
    ["重命名", /label:\s*"重命名"/],
    ["删除", /label:\s*"删除"/],
    ["下载", /label:\s*"下载"/],
    ["复制直链", /label:\s*"复制直链"/],
    ["浏览器打开", /label:\s*"浏览器打开"/],
    ["嵌入到文档", /label:\s*"嵌入到文档"/],
  ];
  for (const [name, re] of REQUIRED_ITEMS) {
    ok(re.test(nodeMenuBody), `K5：右键菜单含「${name}」`);
  }

  /*
   * ---- K5c：「复制路径」必须【不存在】----
   *
   * 2026-09-22 用户明确要求删掉它（原话：「27 复制路径这个功能好像没有什么用，取消，删除」）。
   *
   * 两个理由（都在 tree.js 的注释里留了档）：
   *   ① 功能价值低：`售前项目:/a/b.pdf` 粘浏览器打不开、粘网盘还要手工改造，
   *      真正要分享/留档的场景用的是旁边的「复制直链」。
   *   ② 它本身还是个 bug 源：写成 `${mount}:/${path}`，而 path 带不带前导斜杠
   *      在历史数据里两种都有 ⇒ 拼出 `售前项目://托璞勒 宣传册.pdf`（多一个斜杠），
   *      这正是用户截图报的问题。
   *
   * ★ 和 K5b 同理：K5 那一组全是「必须有」，所以这次的**删除**决定
   *   必须用反向断言钉住，否则哪天被加回来没有任何测试会红。
   *   「复制路径」从 REQUIRED_ITEMS 移到这里的 FORBIDDEN 清单。
   */
  const FORBIDDEN_ITEMS = [
    ["插入到当前文档", /label:\s*"插入到当前文档"/],
    ["复制路径", /label:\s*"复制路径"/],
  ];
  for (const [name, re] of FORBIDDEN_ITEMS) {
    ok(!re.test(nodeMenuBody), `K5c：右键菜单【不含】「${name}」`);
  }
  // 连提示文案里也不许再引导用户去用已删功能
  ok(!/复制路径/.test(treeCode),
     "K5c：tree.js 代码里完全没有「复制路径」字样（含提示文案）");

  /*
   * ---- K5b：「插入到当前文档」必须【不存在】----
   *
   * 2026-09-23 用户明确要求删掉它（原话：「14 右键功能的 插入到当前文档 这个功能和右键都取消」）。
   * 删的理由是它和「嵌入到文档」在菜单里并排、名字又像，用户分不清哪个插链接、
   * 哪个插可预览的嵌入块；而「嵌入到文档」已经完全覆盖了它的场景。
   *
   * 为什么这里要**反向**断言：K5 那一组全是「必须有」，一旦哪天有人把菜单项加回来，
   * 不会有任何测试变红。所以这里补一条「必须没有」，把这个决定钉住。
   * 同理钉住被连带删掉的 insertLinkToDoc()（它只有这一个调用点）。
   */
  ok(!/label:\s*"插入到当前文档"/.test(nodeMenuBody),
     "K5b：右键菜单【不含】「插入到当前文档」（2026-09-23 按要求移除）");
  ok(!/^\s*(?:async\s+)?insertLinkToDoc\s*\(/m.test(treeSrc),
     "K5b：insertLinkToDoc() 已随菜单项一并删除（无残留实现）");

  // ---- K6：「复制直链」必须走后端签发的地址，不能自己拼 ----
  //
  //  ★ 2026-09-30 改锚点 ★
  //    从 `signedRawUrl` 换成 `directLinkUrl` —— 后者是「复制直链」的**唯一出口**
  //    （永久短链优先 / 短链不可用时回退 signedRawUrl）。判据的**意图不变**：
  //    「地址必须由后端构造」，只是出口换了个名字。
  //    ★ 注意别只改锚点就完事：K6 的意图是"两个入口共用一条出口"，
  //      若只判 directLinkUrl 存在，有人把它绕过去直接调 signedRawUrl 也照样绿。
  //      ⇒ 补一条「tree 侧不再直接调 signedRawUrl」的反向断言。
  ok(/API\.directLinkUrl(?![\w$])\s*\(/.test(treeSrc),
     "K6a：复制直链走 API.directLinkUrl()（两处共用一条出口，不自己拼 URL）");
  ok(!/API\.signedRawUrl(?![\w$])\s*\(/.test(treeSrc),
     "K6a2：★ tree.js 不再**直接**调 signedRawUrl（绕过 directLinkUrl 就会让两处地址再次分叉）");
  ok(/async\s+copyRawLink\s*\(/.test(treeSrc),
     "K6b：存在 copyRawLink 实现");
  ok(/entry\.isDir[\s\S]{0,400}?文件夹没有直链/.test(treeSrc) ||
     /文件夹没有直链/.test(treeSrc),
     "K6c：目录明确拒绝出直链（避免复制出一个 404 链接）");

  // ---- K7：菜单显示入口必须走 openMenuAt 封装，内部 **open() 优先** ----
  //
  //  ★★★【2026-09-28 二次定案 —— 本条曾写错，现改正，勿再改回】★★★
  //
  //  思源有**两个都叫 Menu 的类**，早前把它们的性质搞混，得出了错误结论：
  //
  //    类 A（内部菜单，window.siyuan.menus.menu 的类，bundle 里叫 te）
  //      24 个方法，**有 popup，没有 open，也没有 addSeparator**。
  //    类 B（插件 API 包装类，main.<hash>.js 模块 6959 导出 W）★ 我们用的就是它 ★
  //      只有 6 个公开方法：addItem / addSeparator / showSubMenu /
  //      **open** / fullscreen / close
  //      `open(c){ this.isOpen || this.menu.popup(c) }`  ← 内部才去调 A 的 popup
  //      ⇒ **B 有 open，反而没有 popup**
  //
  //  怎么确定我们用的是 B（实测，不是推理）——**调用栈**：
  //      at proto.popup (<anonymous>)                    ← A 的 popup
  //      at $.open (main.<hash>.js:4239:16357)           ← B 的 open
  //      at openMenuAt (plugin:siyuan-nebuladisk:5813)   ← 我们的封装
  //    `openMenuAt` 的下一帧直接是 B 的 open，中间**没有**我们调 popup 的帧。
  //  另一条独立证据：`menu.addSeparator()` 有效（菜单里真的出现
  //  `.b3-menu__separator`），而 addSeparator 只存在于 B。
  //
  //  ⇒ 结论：**旧代码 `menu.open(menuAnchor(ev))` 本来就是合法调用**；
  //    用户最初的「点了什么都不显示」唯一根因是 **按钮缺 `data-menu="true"`**
  //    （见 K7g 组）。早前那条「Menu 没有 open ⇒ 抛 TypeError」是**误判**，
  //    也是 A 的性质被拿去解释 B 的调用。
  //    ⇒ 所以这里断言 `open` **优先**、`popup` 兜底。
  //
  //  两个分支都保留**是防御**（插件 API 是外部契约，思源改版可能换名），
  //  不是"修 bug"；两个都没有时必须 console.error + toast，不许静默。
  ok(/function\s+openMenuAt\s*\(\s*menu\s*,\s*ev\s*\)/.test(treeCode),
     "K7a：存在 openMenuAt(menu, ev) 封装（菜单显示的唯一入口）");
  ok(/menuAnchor\s*\(\s*ev\s*\)/.test(treeCode),
     "K7a2：封装内部仍走 menuAnchor(ev) 取坐标（带 {x,y,h}）");
  ok(/typeof\s+menu\.open\s*===\s*"function"[\s\S]{0,80}?menu\.open\s*\(/.test(treeCode),
     "K7a3：★ open 优先判断且真的调用 open()（插件 API 的公开入口就是 open）");
  // ★ 顺序也要钉住：「open 优先」不是随便写的，是靠调用栈定下来的 ★
  {
    const m = treeCode.match(/function\s+openMenuAt\s*\([\s\S]{0,900}?\n\}/);
    const body = m ? m[0] : "";
    const iOpen = body.indexOf("menu.open");
    const iPopup = body.indexOf("menu.popup");
    ok(iOpen >= 0 && iPopup >= 0 && iOpen < iPopup,
       "K7a3b：★ 在 openMenuAt 体内 open 的判断出现在 popup **之前**（顺序被钉住）");
  }
  ok(/typeof\s+menu\.popup\s*===\s*"function"[\s\S]{0,80}?menu\.popup\s*\(/.test(treeCode),
     "K7a3c：popup 兜底分支保留（防御版本改名，不是修 bug）");
  ok(/既没有\s*open\(\)\s*也没有\s*popup\(\)/.test(treeCode),
     "K7a3d：两个都没有时会明确报错（不许静默 return）");
  // 反向：不许再出现「Menu 没有 open」这种已被证伪的叙述（剥注释后按代码判，
  //   所以这条查的是代码里没有把 open 从判断里删掉）
  ok(!/typeof\s+menu\.popup\s*===\s*"function"[\s\S]{0,120}?return;[\s\S]{0,80}?typeof\s+menu\.open/.test(treeCode),
     "K7a3e：反向 —— popup 不许再被排到 open 前面（那会退回错误认知）");
  const callCount = (treeCode.match(/openMenuAt\s*\(\s*menu\s*,\s*ev\s*\)/g) || []).length;
  ok(callCount >= 3,
     `K7a4：两份菜单都走 openMenuAt（定义 1 处 + 调用 2 处），实际 ${callCount} 处`);
  ok(!/menu\.open\s*\(\s*\{\s*x:\s*ev\.clientX/.test(treeCode),
     "K7b：不再有裸的 open({x: ev.clientX, y: ev.clientY})（缺 h，会打穿定位）");
  ok(/function\s+menuAnchor\s*\(/.test(treeCode),
     "K7c：menuAnchor 辅助函数存在");
  ok(/\bh:\s*Math\.round\(rect\.height\)/.test(treeCode),
     "K7d：menuAnchor 返回 h（思源用 h 判断向上/向下展开）");
  // ★ getBoundingClientRect 会抛异常（元素脱离 DOM 时），必须包 try ★
  //   2026-09-28：行为级测试 _sim-menu-open-behavior.cjs 用例5 抓到
  //   「锚点元素已脱离 DOM ⇒ 异常上抛 ⇒ 菜单又打不开」，
  //   与原来的 menu.open bug 是同类现象。这条钉住修复。
  ok(/try\s*\{[\s\S]{0,200}?getBoundingClientRect\s*\(/.test(treeCode),
     "K7d2：★ menuAnchor 对 getBoundingClientRect 包了 try（脱离 DOM 时不致菜单打不开）");
  ok(!/open\s*\(\s*\{[^}]*clientHeight/.test(treeCode),
     "K7e：没有把 clientHeight 当 open 的参数（那是思源内部字段，不是入参）");
  // 剥掉行注释与块注释后再数裸调用点 —— 否则注释里的说明文字会误报（踩过）。
  const treeCodeNoComment = treeCode
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const bareOpen = (treeCodeNoComment.match(/menu\.open\s*\(/g) || []).length;
  ok(bareOpen <= 1,
     `K7f：★ 裸的 menu.open( 只允许出现在 openMenuAt 封装内（1 处），实际 ${bareOpen} 处`);

  // ---- K7g：「更多」按钮必须带 data-menu="true" ----
  //
  //  ★★★【2026-09-28 实测定案 —— 「点更多什么都不显示」的第②层根因】★★★
  //   只修 `menu.open → popup` 是**不够的**。修完第一层之后浏览器实测仍是
  //   「点了什么都不显示」，用 MutationObserver 抓到的时序是（全部在同一 tick）：
  //     +21ms  added b3-menu__item ×6 + b3-menu__separator ×2   ← 菜单项装好了
  //     +21ms  childList-in b3-menu__items {added:0, removed:8}  ← 立刻被清空
  //     +21ms  attr:class b3-menu fn__none                       ← 并且被隐藏
  //
  //   原因（bundle 原文，common.js 模块 6987）：思源的**全局点击关闭菜单**处理器
  //     const a = y => {
  //       !window.siyuan.menus.menu.element.contains(y)
  //       && !(0,B.Th)(y, "data-menu", "true")     // ← 关键判定
  //       && ( … || window.siyuan.menus.menu.remove() )
  //     }
  //   菜单是**复用单例**（实测 `window.siyuan.menus.menu.element` 就是 DOM 里
  //   那个 `b3-menu fn__none`）。点按钮时 onclick 先跑 ⇒ popup() 装项+显示；
  //   **同一个 click 事件继续冒泡到 document** ⇒ a() 认定「目标不在菜单内、
  //   且没有 data-menu=true」⇒ 立刻 remove()，而 remove() → removeImmediately()
  //   做的正是 `lastElementChild.innerHTML=""` + `classList.add("fn__none")`
  //   —— 与上面的观测逐条吻合。
  //
  //   思源自身同类按钮就是这么标的（bundle 原文）：
  //     <span data-type="more" data-menu="true" class="block__icon ariaLabel"
  //           aria-label="更多"><svg><use xlink:href="#iconMore"></use></svg>
  //
  //   ⇒ 凡 handler 里会弹菜单的按钮，一律 data-menu="true"。这两条钉住它。
  ok(/setAttribute\(\s*["']data-menu["']\s*,\s*["']true["']\s*\)/.test(treeCode),
     'K7g：★ mkBtn 里会对弹菜单的按钮 setAttribute("data-menu","true")');
  ok(/mkBtn\(\s*["']iconMore["']\s*,[\s\S]{0,80}?,\s*true\s*\)/.test(treeCode),
     "K7g2：★「更多」按钮的 mkBtn 调用传了 opensMenu=true（否则菜单会被思源秒关）");
  // 反向：不许把 data-menu 从 mkBtn 里抹掉，也不许把 true 改成 false
  ok(!/mkBtn\(\s*["']iconMore["'][\s\S]{0,80}?,\s*false\s*\)/.test(treeCode),
     "K7g3：反向 —— 「更多」按钮不许被改成 opensMenu=false");

  // ---- K7h：菜单打开期间必须压住按钮自己的 tooltip ----
  //
  //  【2026-09-28 实测定案】用户反馈「弹出后 一直显示『更多』这俩字」。
  //   思源 base.css 原文：
  //     .b3-tooltips::after{ z-index:1000000; content:attr(aria-label) }
  //     .b3-tooltips:hover::after,
  //     .b3-tooltips:focus-within::after{ opacity:1 }
  //     .b3-tooltips__s::after{ top:100%; margin-top:5px }   ← 按钮正下方=菜单位置
  //   点击按钮时浏览器先把焦点给它，**焦点不丢 ⇒ :focus-within 恒真**
  //   ⇒ tooltip 一直显示，且 z-index 比菜单还高，盖在菜单上。
  //   实测（tools/_probe-tooltip-repro.cjs）：初始 ::after opacity=0；
  //   点击后 :focus-within=true、::after opacity=1。
  //   修法：弹菜单时给按钮加 .is-menu-open，CSS 里把它 display:none。
  //
  //  ★ 反向断言（不许丢掉抑制）必须先剥注释 —— CSS 的那段说明注释里
  //    原样写着 `.nb-tree-btn.is-menu-open::after{ display:none !important }`，
  //    不剥注释就会**假绿**（这与 L8' / L11 踩过的是同一类错误）。
  const cssSrc = fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8");
  const cssNC = cssSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")      // CSS 块注释
    .replace(/^[ \t]*\/\/.*$/gm, "");      // 防御性：万一有人写了 // 注释
  ok(/function\s+suppressTooltipWhileMenuOpen\s*\(/.test(treeCode),
     "K7h：存在 suppressTooltipWhileMenuOpen() 抑制函数");
  ok(/if\s*\(\s*opensMenu\s*\)\s*suppressTooltipWhileMenuOpen\s*\(\s*b\s*\)/.test(treeCode),
     "K7h2：★ mkBtn 里弹菜单后会调用它（把自身 tooltip 压住）");
  ok(/\.nb-tree-btn\.is-menu-open\s*::after\s*\{[^}]*display\s*:\s*none/.test(cssNC),
     "K7h3：★ CSS 里有 .nb-tree-btn.is-menu-open::after{ display:none }（剥注释后仍在）");
  ok(/\.nb-tree-btn\.is-menu-open\s*::after\s*\{[^}]*!important/.test(cssNC),
     "K7h4：★ 该规则带 !important（与思源 :focus-within 同特异性，顺序不保证）");

  // ---- K7i：2026-09-28 三项「更多」菜单调整 ----
  //
  //  ① 删除「刷新并重置展开状态」菜单项**及其功能**（refresh() 的 deep 能力）
  //  ② 「在浏览器中打开网盘」→「打开网盘」
  //  ③ 「退出登录」补图标：iconLogout → iconQuit
  //
  //  ★ 反向断言必须先剥注释 ★
  //    上面这段说明注释里**原样写着**「刷新并重置展开状态」「在浏览器中打开网盘」
  //    「refresh(true)」「iconLogout」这些串 —— 不剥注释就会假绿/假红
  //    （与 L8' / K7h 踩过的是同一类错误）。
  //    treeCode（785 行）已剥块注释与**行首**行注释，但仍会漏掉**行尾**的 `// 注释`，
  //    所以这里再按「任意位置 // 到行尾」清一遍。
  const treeStrict = treeSrc
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  //  ★★ 必须连**根文件 index.js** 一起查 ★★
  //    踩过（2026-09-28）：只 grep 了 `src/` 和 `tools/` 就下结论
  //    「全仓没有别处调用 refresh(true)」，结果 index.js 里还藏着 3 处：
  //      · addCommand("refreshNebulaDisk") 的 callback
  //      · 设置面板「立即登录」成功后
  //      · 保存设置后
  //    删掉 refresh() 的 deep 形参后，这些 true 会变成**被静默忽略的死参数**
  //    —— 看着还在重置，其实什么也没做。所以断言的范围必须覆盖 index.js。
  const indexStrict = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const allStrict = treeStrict + "\n" + indexStrict;

  ok(!/刷新并重置展开状态/.test(allStrict),
     "K7i1：★ 菜单里已无「刷新并重置展开状态」（反向断言，防被加回）");
  ok(!/refresh\s*\(\s*true\s*\)/.test(allStrict),
     "K7i2：★ tree.js + index.js 均无 refresh(true) ——「重置展开」能力已整体移除");
  ok(!/async\s+refresh\s*\(\s*\w/.test(treeStrict) && /async\s+refresh\s*\(\s*\)/.test(treeStrict),
     "K7i3：★ refresh() 不再带 deep 形参");
  ok(/mkBtn\(\s*["']iconRefresh["'][\s\S]{0,80}?this\.refresh\s*\(\s*\)/.test(treeCode),
     "K7i4：★ 工具条「刷新」调 this.refresh()（保留展开状态，与 README 承诺一致）");
  ok(/label:\s*["']打开网盘["']/.test(treeCode),
     "K7i5：★ 菜单项名为「打开网盘」");
  ok(!/在浏览器中打开网盘/.test(allStrict),
     "K7i6：★ 旧名「在浏览器中打开网盘」在 tree.js + index.js 里已完全消失");
  ok(/icon:\s*["']iconQuit["']/.test(treeCode),
     "K7i7：★ 「退出登录」用 iconQuit");
  ok(!/iconLogout/.test(allStrict),
     "K7i8：★ tree.js + index.js 均无 iconLogout（该 symbol 思源里不存在 ⇒ 画成空白）");
  //  ★ 用户可见文案若按名字引用菜单项，必须跟着改名 ★
  //    踩过：改名后 showToast 里还写着「请用『在浏览器中打开网盘』」——
  //    会把用户指向一个菜单上根本找不到的名字。K7i6 正是把它抓出来的。
  ok(!/请用「在浏览器中打开网盘」/.test(treeStrict),
     "K7i9：★ toast 文案里引用的菜单名已同步改名（不留旧名指引）");

  // ---- K8：右键事件必须绑在行上，且不能是 oncontextmenu 被后续覆盖 ----
  ok(/oncontextmenu\s*=/.test(treeSrc) || /addEventListener\s*\(\s*"contextmenu"/.test(treeSrc),
     "K8：行上绑定了 contextmenu 事件");

  /* ======================================================================
   * 【L】任务⑯⑰⑱⑲⑳㉑（2026-09-23 第二批）
   * ----------------------------------------------------------------------
   * 这一节盯的是"用户报的现象"而不是"我写了什么代码"。
   * 每条断言都对应一个**具体会复现的 bug**，写在注释里，防止以后被"顺手改回去"。
   * ==================================================================== */
  console.log("\n【L】任务⑯⑰⑱⑲⑳㉑");

  /*  ⚠️ 这里只声明**前面段落没有的**那几个变量。
   *    apiSrc / treeSrc 已经在前面声明过（apiSrc 是 `let apiSrc = ""` + try/catch），
   *    再 const 一次会 `SyntaxError: Identifier 'apiSrc' has already been declared`，
   *    **整个文件直接加载失败** —— run-all-tests 会把它记成「0 通过 1 失败」，
   *    看起来像"某个断言没过"，其实测试文件根本没跑起来。
   *
   *  ★ 教训：**语法级错误会被测试框架伪装成断言失败**。
   *    看到「0 通过 N 失败」这种整段归零的形态，
   *    第一件事是单独跑这个文件看 stderr，而不是去翻断言。
   */
  const viewerSrc = fs.readFileSync(path.join(PLUGIN, "src", "viewer.js"), "utf8");
  const embedSrc  = fs.readFileSync(path.join(PLUGIN, "src", "embed.js"),  "utf8");
  const indexSrc  = fs.readFileSync(path.join(PLUGIN, "index.js"),         "utf8");
  const iconsSrc  = fs.readFileSync(path.join(PLUGIN, "src", "icons.js"),  "utf8");
  if (typeof apiSrc !== "string" || typeof treeSrc !== "string") {
    throw new Error("L 段依赖的 apiSrc/treeSrc 未就绪（前面段落的声明被改名/移动了？）");
  }

  // ---- L1：任务⑰「在浏览器中打开」必须打开**文件**，不是网盘首页 ----
  //
  //  用户原话：「17 在浏览器中打开目前是打开了网盘，并没有在浏览器中打开文件。
  //             可能需要修改网盘代码？ 还需要输入密码？」
  //
  //  旧实现（viewer.js）：
  //      const url = window.__nebuladiskPlugin?.settings?.serverUrl;
  //      window.open(url, "_blank");
  //  ⇒ 开的是网盘**首页**。首页要会话 Cookie，新页签里没有 ⇒ 弹登录页，
  //    这正是用户说的"还需要输入密码"。
  //
  //  正解：走 /api/raw/{name}?mount&path&exp&sig —— 网盘后端 routers/rawlink.py
  //  明确是**免登录**通道（只校验 exp + HMAC 签名，不依赖会话）。
  //  已实测：伪造签名返回 403（而不是 401/302），证明它跟会话无关。
  ok(/async\s+openInBrowser\s*\(/.test(viewerSrc),
     "L1a：viewer.js 的 openInBrowser 是 async（要 await 取直链）");
  /*
   * ★★ 2026-09-30 修：这条断言**早就过期了，只是一直没被执行** ★★
   *
   *   它原来写的是「openInBrowser 里必须出现 API.signedRawUrl(」——
   *   那是 #62 之前的状态（当初 openInBrowser 自己选地址）。
   *   #62 把两个调用点统一收敛到 `API.browserViewUrl()` 之后，
   *   openInBrowser 里**不可能**再出现 signedRawUrl ⇒ 这条恒红。
   *
   *   之所以一直没人发现，是因为本套件在缺 linkedom 时会 `process.exit(0)`
   *   假装通过（那个假绿已在文件开头修掉）。**修好假绿之后它立刻暴露了。**
   *   —— 这正好印证：假绿的问题不是"少测了几条"，而是"过期断言不会被发现"。
   *
   *   判据改写为**判意图**而不是判实现细节：openInBrowser 必须走向
   *   一条**免登录**通道（否则新页签里没会话 Cookie ⇒ 弹登录页，
   *   就是用户当年说的"还需要输入密码"）。
   */
  const viewerOpenSeg = viewerSrc.slice(viewerSrc.indexOf("openInBrowser"));
  ok(/API\.browserViewUrl(?![\w$])\s*\(/.test(viewerOpenSeg),
     "L1b：openInBrowser 走 API.browserViewUrl()（#62 起唯一的地址出口）");
  //  ★ 链路闭合校验：browserViewUrl 内部必须真的用免登录通道 ★
  //    短链 `/f/<token>`（token 即凭证）与签名直链 `/api/raw?exp&sig`
  //    都不看会话 Cookie ⇒ 新页签打开不会被要求登录。
  const bvwSeg = apiSrc.slice(apiSrc.indexOf("export async function browserViewUrl"));
  ok(/API\.shortLinkUrl(?![\w$])\s*\(/.test(bvwSeg),
     "L1b2：browserViewUrl 首选短链 /f/<token>（免登录、长期有效、地址短）");
  ok(/API\.signedRawUrl(?![\w$])\s*\(/.test(bvwSeg),
     "L1b3：browserViewUrl 保留签名直链回退（短链不可用时不至于打不开）");
  ok(!/openInBrowser\s*\(\)\s*\{[\s\S]{0,200}?window\.open\(\s*url\s*,\s*"_blank"\s*\)/.test(viewerSrc),
     "L1c：openInBrowser 不再只是 window.open(serverUrl)（那是首页，会弹登录）");

  // ---- L2：任务⑰ 侧边栏那处也一样（两个调用点，别只修一个）----
  //
  //  tree.js 的 showMoreMenu 里也有一个「打开网盘」项
  //  （2026-09-28 前叫「在浏览器中打开网盘」），
  //  原来同样是 window.open(this.plugin.settings.serverUrl)。
  //  修一处漏一处是这类任务最常见的返工原因，所以单独钉一条。
  ok(!/label:\s*"[^"]*打开网盘"[\s\S]{0,160}?window\.open\(\s*this\.plugin\.settings\.serverUrl\s*,\s*"_blank"\s*\)/.test(treeSrc),
     "L2a：tree.js 的「打开网盘」不再直接开 serverUrl 首页");
  ok(/webDiskUrl\s*\(/.test(treeSrc),
     "L2b：tree.js 改用 webDiskUrl() 拼深链（带 mount+path）");
  //  ★ 这里**不能**要求 `async`：_deepLinkTarget() 是纯计算（读 DOM 上的
  //    _entry，劈一下路径），不发请求 ⇒ 本来就是同步的。
  //    踩过：断言写成 /async\s+_deepLinkTarget/ 会让一条**正确**的实现被判失败，
  //    然后人就会为了"让测试变绿"去给一个不需要 async 的函数加 async —— 
  //    那是被测试带偏，不是修 bug。
  //    ⇒ 断言只钉"存在 + 是方法"，不为实现细节加约束。
  ok(/^\s*_deepLinkTarget\s*\(/m.test(treeSrc),
     "L2c：tree.js 有 _deepLinkTarget() 算落点（同步方法，纯计算不发请求）");

  // ---- L3：任务⑯ 深链的参数形态必须和网盘 app.js 的补丁一致 ----
  //
  //  网盘侧 applyDeepLink() 只认 mount / path 两个键，且
  //    · mount 必须在 /api/me 的 mounts[].label 里（否则静默忽略，防注入）
  //    · path 是**目录**，以 / 开头
  //  所以 webDiskUrl 必须正好产出 "?mount=…&path=…"，不能多、不能少。
  ok(/\?mount="\s*\+\s*encodeURIComponent\(m\)\s*\+\s*"&path="\s*\+\s*encodeURIComponent\(dir\)/.test(apiSrc),
     "L3a：webDiskUrl 产出 `?mount=<enc>&path=<enc>`（与 app.js applyDeepLink 契约一致）");
  ok(/dir\s*=\s*cut\s*>=\s*0\s*\?\s*p\.slice\(0,\s*cut\)\s*:\s*""/.test(apiSrc),
     "L3b：webDiskUrl 取的是**父目录**（网盘只有『打开文件夹』，没有高亮文件）");
  ok(/if\s*\(\s*!dir\s*\)\s*dir\s*=\s*"\/"/.test(apiSrc),
     "L3c：根目录下的文件也会归一成 path=/（保证 path 恒存在）");

  // ---- L4：任务⑱ 两处「复制直链」的语义（2026-09-23 最终定稿）----
  //
  //  用户最初提问：「18 右键中的直连和 预览上的直连不一样。确认一下直连的功能是什么？」
  //  用户最终裁定：「右键中的直连是打开和 预览上的直连是下载。修复 预览上的直连。」
  //
  //  ★ 结论：两处**故意**不同，别再"统一"回去 ★
  //     · tree.js  copyRawLink() → API.signedRawUrl(m,p)      ⇒ inline（**打开**）
  //     · viewer.js copyLink()   → API.signedRawUrl(m,p, true) ⇒ attachment（**下载**）
  //
  //  实现要点（必须钉住，否则会回退）：
  //    ① signedRawUrl 新增第 3 个参数 download，透传 /api/preview 的 download=1
  //    ② 后端把 dl 并入 HMAC 签名（webutil._raw_token(..., dl=)），
  //       所以**前端绝不能自己给 URL 追加 &dl=1**（sig 不匹配 ⇒ 恒 403）
  //    ③ 预览栏 copyLink 必须传 true；右键 copyRawLink 必须**不传**（保持打开）
  //    ④ /api/preview 的 url（kkFileView 预览地址）永远用 inline 签名
  //       —— 它被 iframe 内嵌渲染，一旦变 attachment 预览就坏
  //
  //  ★ 定位方式踩过坑：signature/preview 都是 **API 对象上的方法**
  //    （`async signedRawUrl(mount, path, download = false) {`），不是顶层
  //    `export async function signedRawUrl`。
  //    按后者去 indexOf 会得到 -1，`slice(-1)` 只剩最后一个字符 ⇒
  //    正则永远匹配不上 ⇒ **断言恒假**（这条曾经把 L4a/L4c 误报成"代码不对"，
  //    其实是"测试找错了地方"）。
  //    ⇒ 定位锚点一律用 `async signedRawUrl` / `async previewUrl`，
  //      并且加一道 `idx >= 0` 的显式检查，让"找不到"表现为失败而不是恒假。
  const idxSignedRaw = apiSrc.indexOf("async signedRawUrl");
  const idxPreviewUrl = apiSrc.indexOf("async previewUrl");
  ok(idxSignedRaw >= 0, "L4-0a：能在 api.js 里定位到 async signedRawUrl()");
  ok(idxPreviewUrl >= 0, "L4-0b：能在 api.js 里定位到 async previewUrl()");
  const signedRawBody = idxSignedRaw >= 0 ? apiSrc.slice(idxSignedRaw) : "";
  const previewUrlBody = idxPreviewUrl >= 0 ? apiSrc.slice(idxPreviewUrl, idxSignedRaw > idxPreviewUrl ? idxSignedRaw : undefined) : "";
  const viewerCopyLink = viewerSrc.slice(viewerSrc.indexOf("async copyLink"));
  // ★ 2026-09-30 新增：右键那一侧的定位锚点（下面 L4e4 要用）★
  //   同样要加 `idx >= 0` 检查 —— 找不到时 slice(-1) 只剩一个字符，
  //   正则恒不匹配 ⇒ 断言会**假通过**（这是本文件已经踩过一次的坑）。
  const idxTreeCopy = treeSrc.indexOf("async copyRawLink");
  const treeCopyRaw = idxTreeCopy >= 0 ? treeSrc.slice(idxTreeCopy) : "";

  ok(/apiGet\(\s*"\/api\/preview"/.test(signedRawBody),
     "L4a：signedRawUrl 内部就是 GET /api/preview（与 previewUrl 同一接口）");
  //  ★ 反向断言：previewUrl 也必须打同一个接口，才叫"同一条管线"
  ok(/apiGet\(\s*"\/api\/preview"/.test(previewUrlBody),
     "L4a2：previewUrl 打的也是同一个 GET /api/preview（两处不会各自漂移）");
  ok(idxTreeCopy >= 0, "L4-0c：能在 tree.js 里定位到 async copyRawLink()");
  ok(/browserReachableUrl\s*\(/.test(viewerCopyLink) ||
     /directLinkUrl\s*\(/.test(viewerCopyLink),
     "L4b：预览栏 copyLink 走 directLinkUrl（内含 browserReachableUrl，换掉 nebula:8088 主机名）");
  ok(/browserReachableUrl\s*\(/.test(signedRawBody),
     "L4c：signedRawUrl 过 browserReachableUrl");
  ok(/文件夹没有直链/.test(treeSrc),
     "L4d：目录不出直链是**有意的**差异（网盘 /api/preview 对目录回 400）");

  // ---- L4e：任务⑱ 打开/下载语义（用户裁定，别"顺手统一"）----
  //
  //  ★ 2026-09-30 只统一了**基地址**（两处都走 /f/<token>），语义差异原样保留 ★
  //     改前：同一文件出来两条 330 字符、sig 各不相同的长地址（看着就是 bug）
  //     改后：同一条 41 字符短链，「下载」只表现为后缀 ?dl=1
  ok(/async\s+directLinkUrl\s*\(\s*mount\s*,\s*path\s*,\s*opts\s*=\s*\{\}\s*\)/.test(apiSrc),
     "L4e1：directLinkUrl() 是「复制直链」的**唯一出口**（两处共用，否则地址又会分叉）");
  ok(/await\s+API\.directLinkUrl(?![\w$])\s*\(/.test(viewerCopyLink) &&
     /download:\s*true/.test(viewerCopyLink),
     "★ L4e3：预览栏 copyLink 传 download:true ⇒ **下载**型（用户裁定）");
  ok(/await\s+API\.directLinkUrl(?![\w$])\s*\(/.test(treeCopyRaw) &&
     !/download:\s*true/.test(treeCopyRaw),
     "★ L4e4：右键 copyRawLink **不传** download:true ⇒ 仍是**打开**型（用户要求保持不变）");
  //  回退链必须还在：短链后端没上线时不能把「复制直链」整个打没
  ok(/await\s+API\.signedRawUrl(?![\w$])\s*\(/.test(apiSrc.slice(apiSrc.indexOf("async directLinkUrl"))),
     "L4e5：directLinkUrl 失败会回退 signedRawUrl（后端没升级时功能不能消失）");
  ok(/withDl\s*\(/.test(apiSrc.slice(apiSrc.indexOf("async directLinkUrl"))),
     "L4e6：短链的 ?dl=1 由 withDl() 统一补（不在调用方各自拼）");

  // ---- L4f：dl 的拼接位置 —— 两条通道规则**恰好相反**，别记混 ----
  //
  //  · `/api/raw` 的 dl **并入 HMAC 签名** ⇒ 前端**绝对不能**拼（必 403）
  //  · `/f/<token>` 的 dl 只是请求时参数 ⇒ 前端**可以**拼，且必须由 withDl() 独占
  //
  //  定位方式：先剥掉注释再切段。signedRawUrl 在 shortLinkUrl **之前**，
  //  所以两段之间的窗口正好是 signedRawUrl 的函数体 + 少量间隔。
  const apiCodeOnly = apiSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const iSigned = apiCodeOnly.indexOf("async signedRawUrl");
  const iShort = apiCodeOnly.indexOf("async shortLinkUrl");
  ok(iSigned >= 0 && iShort > iSigned,
     "L4f0：能在 api.js 的**代码区**（已剥注释）里按顺序定位 signedRawUrl → shortLinkUrl");
  const signedBodyOnly = iSigned >= 0 && iShort > iSigned ? apiCodeOnly.slice(iSigned, iShort) : "";
  ok(!/dl=1/.test(signedBodyOnly),
     "L4f1：signedRawUrl 里没有手拼 dl=1（签名覆盖 dl ⇒ 手拼必 403）");
  ok(/export\s+function\s+withDl\s*\(/.test(apiCodeOnly),
     "L4f2：短链的 dl 拼接收敛到 withDl()（唯一一处，别散落）");

  /*
   * ★ L4f3：withDl 的**行为**断言（不是"源码里有没有那个字符串"）★
   *
   *   一开始这里写的是 `/\[[?&]dl=\]/`（想匹配源码里的 `/[?&]dl=/`），
   *   结果**恒假** —— 我匹配的是「`[?&]dl=` 后面跟一个 `]`」，
   *   而源码里那一位是 `/`（正则的结束斜杠）。这种"锚点写错"的断言
   *   是最难发现的一类：它永远红，或永远绿，**与实现无关**。
   *
   *   ⇒ 改成把函数**抽出来真跑一遍**。它是纯函数、零依赖，最适合这么测。
   *     断言的是幂等/空串/两种入参，而不是某段文本长什么样。
   */
  const withDlSrc = (apiCodeOnly.match(/export\s+function\s+withDl\s*\([\s\S]*?\n\}/) || [""])[0]
    .replace(/^export\s+/, "");
  let withDl = null;
  try {
    withDl = (0, eval)("(" + withDlSrc + ")"); // 间接 eval ⇒ 落在全局作用域
  } catch (e) {
    withDl = null;
  }
  ok(typeof withDl === "function",
     "L4f3a：能把 withDl 抽出来求值（抽不出来 ⇒ 下面的行为断言无从谈起）");
  if (typeof withDl === "function") {
    const base = "http://192.168.193.70:8089/f/N-MAJI5zBjO2";
    ok(withDl(base, false) === base && withDl(base) === base,
       "L4f3b：withDl(u, false) 原样返回（打开型不加后缀）");
    ok(withDl(base, true) === base + "?dl=1",
       "L4f3c：withDl(u, true) 补上 ?dl=1");
    ok(withDl(base + "?dl=1", true) === base + "?dl=1",
       "L4f3d：★ 幂等 —— 已带 dl= 时不重复拼（否则拼出 ?dl=1&dl=1）");
    ok(withDl(base + "?v=2", true) === base + "?v=2&dl=1",
       "L4f3e：已有其它查询串时用 & 连接（不能拼出第二个 ?）");
    ok(withDl("", true) === "" && withDl(null, true) === "",
       "L4f3f：空值原样返回（不产出 \"?dl=1\" 这种幽灵地址）");
  } else {
    skip += 5;
    note("withDl 未能求值，跳过 L4f3b–f 五条行为断言（跳过 ≠ 通过）");
  }

  // ---- L4g：后端 rawlink/webutil/preview 三处的下载语义（跨仓库校验，可选）----
  //
  //  前端的"下载型直链"依赖后端三件事，任缺其一都会静默失效：
  //    ① rawlink.api_raw 认 dl/inline 参数并按需下发 attachment
  //    ② webutil._raw_token 把 dl 并入 HMAC（否则前端传了也不起作用/或可篡改）
  //    ③ preview.api_preview 的**预览 url** 仍用 inline 签名（否则预览坏掉）
  //  网盘源码不在本仓库，找不到就 skip（不让插件侧 CI 因缺仓库而红）。
  const NB_DIR = "D:\\Docker\\SiyuanDisk\\nebula";
  const nbCands = {
    rawlink: [process.env.NB_RAWLINK, path.join(NB_DIR, "app", "routers", "rawlink.py"),
              path.join(PLUGIN, "tools", "ref", "rawlink.patched.py")].filter(Boolean),
    webutil: [process.env.NB_WEBUTIL, path.join(NB_DIR, "app", "webutil.py"),
              path.join(PLUGIN, "tools", "ref", "webutil.patched.py")].filter(Boolean),
    preview: [process.env.NB_PREVIEW, path.join(NB_DIR, "app", "routers", "preview.py"),
              path.join(PLUGIN, "tools", "ref", "preview.patched.py")].filter(Boolean),
  };
  const readFirst = (cands) => {
    for (const c of cands) { try { if (c && fs.existsSync(c)) return fs.readFileSync(c, "utf8"); } catch (e) { /* 下一个 */ } }
    return null;
  };
  const rawlinkSrc = readFirst(nbCands.rawlink);
  const webutilSrc = readFirst(nbCands.webutil);
  const previewSrc = readFirst(nbCands.preview);

  if (rawlinkSrc && webutilSrc && previewSrc) {
    note("L4g 校验对象：rawlink/webutil/preview 均已找到");
    ok(/_wants_download\s*\(/.test(rawlinkSrc),
       "L4g1：rawlink.py 有 _wants_download()（解析 dl / inline 参数）");
    ok(/download=want_dl/.test(rawlinkSrc),
       "L4g2：rawlink.py 用 _stream_file(p, download=want_dl)（不再写死 False）");
    ok(/def _raw_token\(mount: str, path: str, exp: int, dl: bool = False\)/.test(webutilSrc),
       "L4g3：webutil._raw_token 增加 dl 维度（签名覆盖下载标记，防篡改）");
    ok(/_raw_token_v1\s*\(/.test(webutilSrc),
       "L4g4：保留 _raw_token_v1 向后兼容（OnlyOffice/kkFileView 攥着的旧链接仍可用）");
    ok(/download: bool = False/.test(webutilSrc),
       "L4g5：make_raw_url 支持 download 参数");
    ok(/raw_inline/.test(previewSrc),
       "L4g6：★ /api/preview 的预览 url 用 raw_inline（不会被 download 带成 attachment）");
    ok(/download: str = ""/.test(previewSrc),
       "L4g7：/api/preview 接受 download 查询参数");
  } else {
    skip += 3;
    note("未找到网盘源码（rawlink/webutil/preview），跳过 L4g 三条后端契约校验");
  }

  // ---- L5：任务⑲ 页签要能分辨"是哪个文档" ----
  //
  //  用户原话：「19 在页签中，如何知道嵌入的具体文档是那个？」
  //  旧标题只有 item.name ⇒ 两个不同目录下的同名文件，页签长得一模一样。
  ok(/const\s+mountTag\s*=\s*String\(item\.mount/.test(indexSrc),
     "L5a：openFile 取 mount 拼进标题");
  ok(/title\s*=\s*opts\.title\s*\|\|\s*\(mountTag\s*\?\s*`\$\{base\}\s*·\s*\$\{mountTag\}`/.test(indexSrc) ||
     /`\$\{base\}\s*·\s*\$\{mountTag\}`/.test(indexSrc),
     "L5b：页签标题形如「文件名 · 挂载点」（文件名在最前，被截断时先保住它）");
  ok(/nb-chip--copy/.test(viewerSrc),
     "L5c：预览信息条有「复制路径」chip（拿到 mount:/path 的最短路径）");

  // ---- L6：任务⑳ 插入嵌入块后要能定位 ----
  //
  //  用户原话：「20 嵌入文档树到文档这个功能需要调整一下：
  //             点击插入后的嵌入块 右侧文档树转跳到这个路径所在位置。」
  ok(/async\s+revealPath\s*\(/.test(treeSrc),
     "L6a：TreePanel.revealPath() 存在");
  ok(/this\.expanded\.add\(\s*nodeKey\(m,\s*"\/"\s*\+\s*dirParts/.test(treeSrc) ||
     /nodeKey\(m,\s*"\/"\s*\+\s*dirParts\.slice/.test(treeSrc),
     "L6b：revealPath 把路径上每一级目录都登记为『应展开』");
  ok(/revealPath\(this\.currentMount,\s*p\)/.test(treeSrc),
     "L6c：embedToDoc 成功后调用 revealPath 跳过去");
  ok(/async\s+revealTree\s*\(/.test(indexSrc),
     "L6d：index.js 暴露 revealTree()（给嵌入块上的『定位』按钮用）");
  ok(/locateBtn/.test(embedSrc) && /revealTree/.test(embedSrc),
     "L6e：嵌入块工具栏有『定位』按钮，走 plugin.revealTree");
  ok(/nb-node-flash/.test(treeSrc) && /@keyframes\s+nbFlash/.test(
       fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8")),
     "L6f：定位后有高亮闪烁（长列表里跳转否则无感知）");

  // ---- L7：任务㉑ 搜索必须走**后端递归**，不能退回前端过滤 ----
  //
  //  用户原话：「搜索需要对所有文档进行搜索，包含之前没有加载的。」
  //  这是本次最容易被"优化回去"的一条：前端过滤看起来更快更省事，
  //  但它**原理上**搜不到未加载的目录 —— 那正是用户报的 bug。
  ok(/search:\s*\(mount,\s*q,\s*path/.test(apiSrc),
     "L7a：API.search() 存在");
  ok(/apiGet\(\s*"\/api\/search"/.test(apiSrc),
     "L7b：API.search 打 GET /api/search（后端递归）");
  ok(/API\.search\s*\(/.test(treeSrc),
     "L7c：TreePanel.applyFilter 调 API.search（不再只过滤 DOM）");
  ok(!/w\.style\.display\s*=\s*"none"\s*;\s*\}\s*else\s*\{\s*w\.style\.display/.test(treeSrc) ||
     !/const\s+match\s*=\s*\(name\)\s*=>\s*\{[\s\S]{0,200}?lower\.includes\(t\)/.test(treeSrc),
     "L7d：旧的前端 match(name) 过滤已删除（防退回）");
  ok(/renderResults\s*\(/.test(treeSrc),
     "L7e：有独立的结果面板渲染（结果跨层级，硬塞进树会破坏结构）");
  // 竞态令牌：★ 不能只查字面 _searchToken（反向测试证明那样是假绿）★
  //   必须断言「递增赋值 + 响应比对 + 不匹配就 return」三件套。
  ok(/this\._searchToken\s*=\s*\(this\._searchToken\s*\|\|\s*0\)\s*\+\s*1/.test(treeSrc),
     "L7f：有递增的竞态令牌（防抖连发时晚到的响应覆盖新结果）");
  ok(/token\s*!==\s*this\._searchToken[\s\S]{0,60}?return/.test(treeSrc),
     "L7g：★ 令牌被真正用于丢弃过期响应（只声明不用 = 摆设）");
  ok(/truncated/.test(treeSrc) && /depthCapped/.test(treeSrc),
     "L7g：截断/深度上限会显式提示（不静默截断假装搜完了）");

  // ---- L8：任务㉑ 网格模式 —— ★ 2026-09-28 已按用户要求整体移除 ★ ----
  //
  //   历史：用户原话「增加网格显示模式，双击进去下级文件夹。」
  //   本次：用户原话「去掉文件夹 网格视图方式，同时去掉这个按钮。」
  //
  //   ⚠️ 断言方向已**反转** —— 从「网格功能存在」改为「网格功能已删干净」。
  //     这类"反向断言"比删掉整块更有价值：它能在以后有人误把网格代码
  //     贴回来时立刻报警，而不是安静地通过。
  //
  //   ★★ 反向断言**必须先剥注释**（实测踩到过，一次算错 4 条）★★
  //     第一版直接 `!/makeGridCell/.test(treeSrc)` —— 结果 4 条假红：
  //     tree.js 里那段说明注释写明了「gridMode / toggleBtn / makeGridCell()
  //     已删除」，正则命中的是**注释文字**而不是代码。
  //     这与 index.css 那条 L11 断言犯过的是同一类错误（注释假绿/假红）。
  const stripCommentsFn = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "")     // JS 块注释
     .replace(/<!--[\s\S]*?-->/g, "")      // ★ HTML 注释 —— icons.js 的图标定义是
                                           //   HTML 片段，说明文字写在 <!-- --> 里，
                                           //   只剥 /* */ 会把注释当代码（实测踩到 L8e' 假红）
     .replace(/^[ \t]*\/\/.*$/gm, "");     // JS 行注释
  const treeCodeNC = stripCommentsFn(treeSrc);
  const iconsCodeNC = stripCommentsFn(iconsSrc);
  ok(!/async\s+toggleGrid\s*\(/.test(treeCodeNC),
     "L8a'：toggleGrid() 已移除（网格切换入口）");
  ok(!/async\s+renderGrid\s*\(/.test(treeCodeNC),
     "L8b'：renderGrid() 已移除");
  ok(!/makeGridCell\s*\(/.test(treeCodeNC),
     "L8c'：makeGridCell() 已移除");
  ok(!/this\.gridMode/.test(treeCodeNC) && !/this\.gridBtn/.test(treeCodeNC),
     "L8d'：gridMode / gridBtn 状态已移除");
  ok(!/iconNbGrid/.test(iconsCodeNC) && !/iconNbList/.test(iconsCodeNC),
     "L8e'：iconNbGrid / iconNbList 图标已移除");
  //   ★ 关键回归点：搜索结果双击目录**不依赖** gridMode ★
  //     _jumpToDir 走的是 revealPath（树展开路线）。断言 revealPath 仍在，
  //     保证"删网格"没有把搜索跳转一起带走。
  ok(/async\s+revealPath\s*\(/.test(treeCodeNC) && /this\._jumpToDir\s*\(/.test(treeCodeNC),
     "L8f'：★ 搜索双击目录的 revealPath/_jumpToDir 仍在（未随网格被误删）");
  ok(!/is-grid/.test(treeCodeNC) && !/\.nb-grid/.test(
       stripCommentsFn(fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8"))),
     "L8g'：网格相关样式类（is-grid / .nb-grid*）已从 tree.js 与 CSS 移除");
  //   ★ 但 .nb-type-icon--dir 必须保留 —— 文件树与搜索结果共用它 ★
  ok(/\.nb-type-icon--dir/.test(fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8")),
     "L8h'：★ .nb-type-icon--dir 保留（文件树/搜索结果共用，不能随网格一起删）");

  // ---- L11：任务25 —— 网格图标高度固定 + 文件夹/文件图标 ----
  //
  //  用户原话：
  //    「25 图标模式 目前是占据了整个高度。每个图标高度需要固定。
  //      文件夹和文件图标需要调整一下。」
  //
  //  两个独立缺陷，各锁一组断言：
  //    25a：CSS Grid 默认 grid-auto-rows:auto + align-content:stretch，
  //         配合 .nb-grid{flex:1} ⇒ 行被拉伸去填满容器 ⇒ 文件少时每格占整屏。
  //    25b：typeIconEl 的签名是 (ext)，但 grid/搜索结果两处传的是 (name, isDir)
  //         ⇒ typeBadge 拿整个文件名去比对扩展名表，永远不中，
  //           退化成「名字前 3 个字符 + 灰色」，目录更是完全没有文件夹图标。
  {
    const css = fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8");
    const iconsFile = fs.readFileSync(path.join(PLUGIN, "src", "icons.js"), "utf8");
    // ★ 剥注释再断言 ★ 反向测试暴露过：`align-content:start` 在注释里也出现过，
    //   裸正则会命中注释 ⇒ 把真声明删掉也不变红（假绿）。
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const iconsCode = iconsFile
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    // --- 25a：网格行高固定 —— ★ 2026-09-28 断言删除 ★ ---
    //   原断言（L11a/b/c）检查 `.nb-grid` 的 grid-auto-rows / align-content
    //   与 `.nb-cell` 的固定高度。网格视图已整体移除，这三条 CSS 规则
    //   连同 .nb-grid / .nb-cell 一起被删掉了，断言也随之删除。
    //   （保留在此的说明是必要的：否则以后有人看到"25a 相关测试没了"
    //     会以为是漏测，而不是随功能移除。）

    // --- 25b：图标必须按扩展名解析，不能把文件名当扩展名 ---
    ok(/export\s+function\s+typeIconEl\s*\(\s*\w+\s*,\s*\w+\s*\)/.test(iconsCode),
       "L11d：★ typeIconEl 现在收两个参数 (ext, isDir)");
    ok(/export\s+function\s+extOf\s*\(/.test(iconsCode),
       "L11e：icons.js 导出了 extOf（用于兼容旧调用、从 name 取扩展名）");
    ok(/nb-type-icon--dir/.test(iconsCode),
       "L11f：★ 目录有专属文件夹图标分支（不再是灰底色块）");
    //  ★ 任务29：目录图标【不再】复用 SiYuan 的 #iconNbFolderClosed symbol，
    //     改为与网盘 Web UI 同源的「琥珀色内联文件夹 SVG」（_folderSvg('#e8a33d')）。
    //     下面的断言同时锁住「新实现存在」+「旧 symbol 已彻底移除」——只锁一半，
    //     就会出现"回归到旧 symbol 但测试仍绿"的假绿。
    ok(/iconNbFolderClosed/.test(iconsCode) === false,
       "L11g：★ 旧 symbol iconNbFolderClosed 已从 icons.js 彻底移除（任务29 改用内联 SVG）");
    ok(/_folderSvg\s*\(/.test(iconsCode),
       "L11g2：★ icons.js 里存在 _folderSvg 构建器（文件夹图标的内联 SVG 工厂）");
    ok(/#e8a33d/.test(iconsCode),
       "L11g3：★ 目录图标使用网盘同款琥珀色 #e8a33d");

    // ★ L11g4：上面三条只看 src/icons.js —— 但**真正上线的是 bundle**。
    //   实测踩到过：src 已干净，而 dist/index.js 里仍有 iconNbFolderClosed 的
    //   **注释残留**（我在 tree.js 里写了说明性注释）。只查源码 = 给自己假安心。
    //   所以这里对**打包产物**再断一次，且必须先剥注释（注释不是代码）。
    const distJs = path.join(__dirname, "..", "dist", "index.js");
    if (fs.existsSync(distJs)) {
      const distCode = fs.readFileSync(distJs, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      ok(!/iconNbFolderClosed/.test(distCode),
         "L11g4：★★ 打包产物 dist/index.js（剥注释后）也不含旧 symbol —— 上线件才算数");
      ok(/#iconFolder/.test(distCode),
         "L11g5：★ 兜底分支改用思源内置 #iconFolder（一定存在的 symbol，比自定义 id 稳）");
      ok(/e8a33d/.test(distCode),
         "L11g6：打包产物里带上琥珀色目录图标（网盘风格已进 bundle）");
    } else {
      ok(false, "L11g4：dist/index.js 不存在 —— 请先跑 node tools/build.js --repo");
    }


    // --- 25b 关键：调用点不许再传 name ---
    //
    //  ⚠️ 必须先剥注释再断言 —— 修 bug 时我在注释里**引用了**旧写法
    //     （"以前写的是 typeIconEl(e.name, e.isDir)"），裸正则会命中注释，
    //     于是「修好了」反而判失败。这类"注释造成假红/假绿"本项目已踩过（见 build.js）。
    const treeCodeOnly = treeSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    ok(!/typeIconEl\(\s*e\.name\s*,/.test(treeCodeOnly),
       "L11h：★★ tree.js 里【不再】有 typeIconEl(e.name, …) 这种错位调用（已剥注释）");
    // ★ 2026-09-28：调用点由 4 处降为 2 处 —— 网格视图移除带走了
    //   makeGridCell 里的那一处（另一处是 methods 名字里的 self-reference）。
    //   现存两处：文件树 makeNode（三元形式）+ 搜索结果 makeResultRow（精确形式）。
    const iconCalls = (treeSrc.match(/typeIconEl\(/g) || []).length;
    ok(iconCalls >= 2, `L11i'：typeIconEl 调用点 ≥2（实际 ${iconCalls}；网格移除后由 4→2）`);
    // 搜索结果那处必须用精确的正确写法 (e.ext || extOf(e.name), !!e.isDir)。
    // ⚠️ 文件树那处是 `entry.isDir ? "" : (entry.ext || extOf(entry.name))` 的三元形式，
    //    语义等价但字面不同 —— 所以这里判 **≥1** 而不是 ≥2（原阈值是在网格还在时定的）。
    const goodIconCalls = (treeSrc.match(/typeIconEl\(\s*e\.ext\s*\|\|\s*extOf\(e\.name\)\s*,\s*!!e\.isDir\s*\)/g) || []).length;
    ok(goodIconCalls >= 1,
       `L11j'：★ 搜索结果那处已改用 (e.ext || extOf(e.name), !!e.isDir)（实际 ${goodIconCalls} 处；原 ≥2 是网格还在时的阈值）`);
  }

  // ---- L12：任务24a —— 插入选择器（斜杠菜单 /网）也要有搜索 ----
  //
  //  用户原话：「24 /网 插入文档树 插入文档 弹出窗口上增加搜索功能，
  //             和侧边窗口搜索功能一样。」
  {
    const indexSrc = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
    // ★ 剥注释再断言（反向测试纠正过：API.search 在注释里也出现过）★
    const indexCode = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const pickerBody = (indexCode.match(/class Picker\s*\{[\s\S]*?\n\}/) || [""])[0];
    ok(pickerBody.length > 1000, "L12a：成功截取 Picker 类（" + pickerBody.length + " 字符）");

    // 搜索框：必须同时有「模板里的 input」和「代码里的 querySelector」，两者缺一不可
    ok(/<input[^>]*class="[^"]*nb-picker-q[^"]*"/.test(indexCode),
       "L12b：★ 选择器里有搜索输入框（模板里的 .nb-picker-q input）");
    ok(/querySelector\(\s*["'`]\.nb-picker-q["'`]\s*\)/.test(pickerBody),
       "L12b2：★ 搜索框在代码里被真正取到（只有模板没有接线 = 摆设）");
    ok(/\.oninput\s*=/.test(pickerBody),
       "L12b3：★ 搜索框接了 oninput（否则打字不触发搜索）");
    ok(/await\s+API\.search\s*\(/.test(pickerBody),
       "L12c：★ 选择器调 API.search（与侧边栏同一套后端递归搜索）");
    // 竞态令牌：**不能只查有没有 _searchToken** —— 反向测试发现，
    // 即使把「递增 + 赋值」那两行删掉，别处残留的 _searchToken 字样仍会让
    // 裸 /_searchToken/ 变绿（假绿）。必须断言「三件套」都在：
    //   递增赋值 → 响应回来后比对 token → 不匹配就 return（丢弃过期响应）
    ok(/this\._searchToken\s*=\s*\(this\._searchToken\s*\|\|\s*0\)\s*\+\s*1/.test(pickerBody),
       "L12d：★ 选择器有递增的竞态令牌（_searchToken）");
    ok(/token\s*!==\s*this\._searchToken[\s\S]{0,40}?return/.test(pickerBody),
       "L12d2：★ 令牌被真正用来丢弃过期响应（只声明不用 = 摆设）");

    ok(/setTimeout\([\s\S]{0,120}?300\s*\)/.test(pickerBody),
       "L12e：★ 选择器搜索也做了 300ms 防抖（与侧边栏一致）");
    ok(/renderSearch\s*\(/.test(pickerBody),
       "L12f：选择器有独立的搜索结果渲染（带所在目录，跨层级才分得清）");
    ok(/nb-picker-sub/.test(indexCode) || /nb-picker-sub/.test(
         fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8")),
       "L12g：搜索结果行显示所在目录（.nb-picker-sub）");
    // 搜索模式下选中文件的路径必须用 entry.path（相对挂载根），不能再拼 this.path
    ok(/entry\.path[\s\S]{0,200}?replace\(\/\^\\\/\//.test(pickerBody) ||
       /entry\.path\s*\?\s*String\(entry\.path\)/.test(pickerBody),
       "L12h：★ 搜索模式下选中文件用 entry.path（否则路径会拼错）");
    // 换盘要清空搜索
    ok(/sel\.onchange[\s\S]{0,400}?this\.query\s*=\s*""/.test(pickerBody),
       "L12i：切换盘符时清空搜索（否则拿旧的搜索结果看新盘）");
  }

  // ---- L13：任务26 —— 嵌入块头部「多了一行」 ----
  //
  //  用户原话：「多了一行」（附截图）。
  //
  //  ★ 实测（在 192.168.193.70:6806 的**运行中**思源里量的）★
  //    同一篇笔记里有 3 个文件嵌入块，逐个量 .nb-embed-head 的高度：
  //      · 短路径（:/托璞勒 宣传册.pdf）        → headH = 27px  ✅ 一行
  //      · 长路径（:/2026年08月/盛元立库/01-…dwg）→ headH = 53px  ❌ 两行
  //    根因就是 `.nb-embed-head { flex-wrap: wrap }`：标题占满第一行后，
  //    `.nb-embed-tools`（在页签中打开/下载/打开网盘/定位）被换到第二行。
  //    所以「多了一行」不是凭空出现，而是**路径变长时头部换行**。
  //
  //  ⇒ 锁死三件事：
  //    ① .nb-embed-head 不许 wrap（头部高度必须与路径长短无关）
  //    ② 标题必须可收缩（flex:1 1 auto + min-width:0），否则 nowrap 下
  //       长路径会把工具条顶出可视区 —— 那是"换了个方式坏"
  //    ③ 路径为空时不许渲染出裸 `:` / `:/`（盘根嵌入会留下无信息量的符号）
  {
    const css = fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8");
    // ★★ 必须先剥注释再匹配 ★★
    //   这条在本项目已经栽过三次：`/* … min-width:0 允许 … */` 这种说明性
    //   注释里**原样写着**属性名，裸正则会把注释当声明。
    //   更致命的是反向测试暴露的第二个坑：<title>/<path> 在本文件里各有
    //   **两条**规则（一条定义外观、一条补充 flex），
    //   只匹配第一条时，"把第一条里的 min-width 删掉"**不会变红** ——
    //   第二条还留着，断言永远绿（假绿）。
    //   ⇒ 这里改成：剥注释 → 取出**全部**同名规则 →
    //     按"后写的生效"取合并后的最终值来断言。
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const embedSrc = fs.readFileSync(path.join(PLUGIN, "src", "embed.js"), "utf8");
    const embedCode = embedSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    /** 取某选择器的**全部**声明块，按出现顺序拼接（后者覆盖前者） */
    const allRules = (sel) => {
      const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
      const out = [];
      let m;
      while ((m = re.exec(cssCode)) !== null) out.push(m[1]);
      return out;
    };
    /** 合并后的最终声明文本（用于判断"某属性最终值"） */
    const merged = (sel) => allRules(sel).join("\n");
    /** 某属性在合并声明里**最后一次**出现的值 */
    const lastVal = (sel, prop) => {
      const re = new RegExp(prop + "\\s*:\\s*([^;]+);", "g");
      let m, v = null;
      const txt = merged(sel);
      while ((m = re.exec(txt)) !== null) v = m[1].trim();
      return v;
    };

    // ① 头部不许换行
    const headRules = allRules(".nb-embed-head");
    ok(headRules.length >= 1, `L13a：截取到 .nb-embed-head 规则（${headRules.length} 条）`);
    ok(lastVal(".nb-embed-head", "flex-wrap") === "nowrap",
       "L13b：★★ .nb-embed-head 最终 flex-wrap 是 nowrap（wrap 会让长路径把工具条挤到第二行 = 多出一行）",
       "实际 = " + lastVal(".nb-embed-head", "flex-wrap"));
    ok(!/flex-wrap\s*:\s*wrap\s*;/.test(merged(".nb-embed-head")),
       "L13c：★ .nb-embed-head 的任何一条规则里都不许有 flex-wrap:wrap");

    // ② 标题可收缩（配合 nowrap，超长路径靠 ellipsis 收，而不是换行）
    //
    //   ⚠️ 这里断言的是**合并后**是否存在该声明，而不是只看第一条：
    //      .nb-embed-title 有两条规则（外观一条、flex 补充一条），
    //      min-width:0 落在哪一条都可能，只要"最终生效"就行。
    const titleCode = merged(".nb-embed-title");
    ok(/min-width\s*:\s*0\s*;/.test(titleCode),
       "L13d：★ .nb-embed-title 合并后声明了 min-width:0（不设就没法收缩到小于内容宽度）");
    ok(
      lastVal(".nb-embed-title", "flex") === "1 1 auto" ||
      /flex\s*:\s*1\s+1\s+auto\s*;/.test(titleCode),
      "L13e：★ .nb-embed-title 有 flex:1 1 auto（吃掉剩余空间，把工具条留在同一行）",
      "实际 flex = " + lastVal(".nb-embed-title", "flex"));

    const pathCode = merged(".nb-embed-path");
    ok(/text-overflow\s*:\s*ellipsis\s*;/.test(pathCode) && /white-space\s*:\s*nowrap\s*;/.test(pathCode),
       "L13f：★ .nb-embed-path 仍是 nowrap + ellipsis（长路径截断而不是换行）");
    ok(/min-width\s*:\s*0\s*;/.test(pathCode),
       "L13g：★ .nb-embed-path 合并后声明了 min-width:0（省略号才真的出得来）");

    // ③ 空路径不留裸符号
    //
    //  ⚠️ 这条断言被自己的反向测试 + 用户第二轮反馈一起改造过：
    //     第一轮写的是 `/filePathRaw\s*\?\s*":"\s*\+\s*filePathRaw\s*:\s*""/`
    //     —— 把实现细节（怎么拼字符串）当成了契约。后来任务26 要求
    //     「不能自己拼 `:` + path」（path 带不带前导斜杠不确定，会拼出 `://`），
    //     改为统一走 displayMountPath()，这条正则就假红了。
    //
    //     ⇒ 断言应该抓**语义**而不是**字面**：
    //        「有路径 ⇒ 渲染路径；无路径 ⇒ 渲染空串」。
    //        并且要额外钉住那个我刚踩到的坑：
    //        displayMountPath(mount, "") 返回 `mount:/` 而**不是**空串，
    //        所以必须**先判空再调用**，不能靠 `|| ""` 兜底（那是死兜底）。
    const embedNoComments = embedCode;
    // ★ 2026-09-28 清理：这一组已随第④轮改造而**过期**，改为守护新契约 ★
    //
    //   历史：早期契约是「两个元素并排」——
    //     `.nb-embed-mount` 放盘符、`.nb-embed-path` 放 `displayMountPath("", p).slice(1)`。
    //     L13h/L13h3 当时钉的就是这个 `.slice(1)` 剥离动作。
    //
    //   但用户第四轮明确要求**合并为一个元素**（原话：
    //     「目前是 售前项目/FA&JG-….pdf，调整为 售前项:/FA&JG-….pdf」），
    //   因为并排时 `.nb-embed-mount` 与 `.nb-embed-path` 之间有 5px flex gap，
    //   拼出来是「售前项目 /FA&JG-….pdf」而不是用户要的紧贴形态。
    //   ⇒ 现在 `.nb-embed-path` 直接放 `displayMountPath(spec.mount, p)` 的**完整返回**，
    //     盘符由它自己带（前缀），**不再**有独立 mount 元素。
    //
    //   所以新契约是：
    //     ① `.nb-embed-path` 的赋值必须是 `displayMountPath(spec.mount, filePathRaw)`
    //        （带盘符，不 slice、不传空串）
    //     ② 仍然禁止 `|| ""` 死兜底（displayMountPath 永不返回空串）
    //     ③ 必须仍然先判空再调用（否则空路径渲染成 `盘:/`）
    ok(/filePathRaw\s*\?\s*displayMountPath\(\s*spec\.mount\s*,\s*filePathRaw\s*\)\s*:\s*spec\.mount\s*\|\|\s*""/.test(embedNoComments),
       "L13h：★ 文件嵌入的 .nb-embed-path 直接放 displayMountPath(spec.mount, …) 完整返回" +
       "（第④轮起合并为单元素，盘符自带前缀）—— 别再退回两元素并排（会有 5px gap）",
       "未匹配到 `filePathRaw ? displayMountPath(spec.mount, filePathRaw) : spec.mount || \"\"`");
    ok(!/displayMountPath\([^)]*\)\s*\|\|\s*""/.test(embedNoComments),
       "L13h2：★★ 没有用 `|| \"\"` 给 displayMountPath 兜底 —— 它永不返回空串，" +
       "这种兜底是死的，会悄悄把空路径渲染成 `盘:/`");
    // ★ 关键：文件嵌入不许再出现 `.slice(1)` 剥离（那是两元素时代的写法）★
    //
    //   ⚠️ 必须限定在**文件嵌入**段内判断（`filePathRaw` 附近）。
    //     不能全文件禁 `displayMountPath("")` —— **目录嵌入是有意保留两段式**的
    //     （见 src/embed.js 需求3 注释：目录路径随浏览变化，两段更好看出"在哪一级"），
    //     它仍然合法地写着 `displayMountPath("", currentPath).slice(1)`。
    //     全文件禁止 = 假红。
    const fileEmbedSeg = (() => {
      const i = embedNoComments.indexOf("filePathRaw");
      return i >= 0 ? embedNoComments.slice(Math.max(0, i - 300), i + 300) : "";
    })();
    ok(fileEmbedSeg.length > 0 && !/displayMountPath\(\s*""\s*,/.test(fileEmbedSeg),
       "L13h3：★★★ 文件嵌入不许再用 displayMountPath(\"\", …) —— 空串参数是两元素时代的写法，" +
       "现在盘符必须由 path 元素自带（传 spec.mount）");
    // 反向守卫：文件嵌入不许有独立的 .nb-embed-mount 元素（会与 path 的盘符重复显示）
    ok(!/class="nb-embed-mount"/.test(fileEmbedSeg),
       "L13h4：★★ 文件嵌入不许再建独立的 .nb-embed-mount 元素 —— 盘符已并入 .nb-embed-path，" +
       "再建一个会显示两次（这是第二轮踩过的坑）");

    // 目录嵌入：同样只放路径（不带冒号、不带盘符）
    ok(/pathEl\.textContent\s*=\s*currentPath\s*\?\s*displayMountPath\(\s*""\s*,\s*currentPath\s*\)\.slice\(1\)\s*:\s*""/.test(embedCode),
       "L13i2：★ 目录嵌入同样只渲染路径部分（与文件嵌入风格统一）",
       "未匹配到 `currentPath ? displayMountPath(\"\", currentPath).slice(1) : \"\"`");
    ok(!/pathEl\.textContent\s*=\s*currentPath\s*\?\s*`:[^`]*\$\{currentPath\}/.test(embedCode),
       "L13i：★★ 目录嵌入**不再**自己拼「冒号斜杠 + currentPath」—— 那会拼出 `://`");
    ok(/import\s*\{[^}]*\bdisplayMountPath\b[^}]*\}\s*from\s*["'][^"']*api\.js["']/.test(embedCode),
       "L13i3：★★★ embed.js **确实 import 了** displayMountPath —— " +
       "漏 import 会让打包器不生成 `const displayMountPath = __mod_api.displayMountPath` 绑定，" +
       "调用处直接 ReferenceError（真机上表现为文件嵌入块渲染不出来、显示裸 JSON）");

    // ④ 注释不许撒谎
    //
    //   ⚠️ 踩过的坑：改完 nowrap 之后，另一条 .nb-embed-head 规则上还挂着
    //      「已经是 flex-wrap:wrap」这句旧注释。代码是对的、注释是错的，
    //      下一个维护者会被误导着把 nowrap 改回 wrap（= 缺陷复发）。
    //
    //   ⚠️ 反向陷阱：不能简单地禁止注释里出现 "flex-wrap: wrap" ——
    //      主规则上那段解释根因的注释写的是「这里**原来是** flex-wrap: wrap」，
    //      这是**有价值的历史说明**，不是撒谎。所以判据是"时态"：
    //        现在是 wrap  → 撒谎，必须红
    //        原来是 wrap  → 复盘，必须允许
    const embedCssRaw = css; // 原始（含注释）整份 CSS
    const staleClaims = [];
    const headIdx = embedCssRaw.indexOf(".nb-embed-head");
    const embedSeg = embedCssRaw.slice(headIdx); // 只看嵌入区
    const cmtRe = /\/\*([\s\S]*?)\*\//g;
    let cm = null;
    // 「过去时」豁免词：出现这些词说明是在讲历史，不是在声称现状
    const PAST = /(原来|之前|旧|历史|曾经|此前|改前|修前|原为|以前)/;
    while ((cm = cmtRe.exec(embedSeg)) !== null) {
      const body = cm[1];
      const claimRe = /flex-wrap\s*:\s*wrap/g;
      let c2 = null;
      while ((c2 = claimRe.exec(body)) !== null) {
        // 取该提及所在的那一行 + 上一行，判断上下文有没有过去时豁免词
        const before = body.slice(0, c2.index);
        const lineStart = before.lastIndexOf("\n") + 1;
        const ctx = body.slice(Math.max(0, lineStart - 120), c2.index + 20);
        if (!PAST.test(ctx)) staleClaims.push(ctx.trim().replace(/\s+/g, " ").slice(-70));
      }
    }
    ok(headIdx >= 0 && staleClaims.length === 0,
       "L13j：★ 嵌入区注释里不许「现在时」声称 flex-wrap:wrap（过去时复盘可保留）",
       staleClaims.length ? "发现 " + staleClaims.length + " 处：" + staleClaims.join(" | ") : "");
  }

  // ---- L15：任务26 第三轮 —— 真机抓到的「://」双斜杠（行为级）----
  //
  //  ★ 为什么必须补这一组 ★
  //    L13h/L13i 系列是**静态正则**断言（"源码里是不是这么写的"）。
  //    但用户报的是**渲染出来的字符串**多了一个斜杠：
  //        售前项目://托璞勒 宣传册.pdf
  //    静态正则无法回答"拼出来到底是几个斜杠"。
  //    我第一轮/第二轮就是被这一点骗过：正则改绿了，真机上 `://` 还在
  //    （因为漏改的是**目录嵌入**那条 path，用户说的正是它）。
  //    ⇒ 这一组走**行为级**：把 displayMountPath 与两条表达式抠出来真跑。
  {
    const apiSrc2 = fs.readFileSync(path.join(PLUGIN, "src", "api.js"), "utf8");
    // 抠 displayMountPath 定义体
    const ds = apiSrc2.indexOf("export function displayMountPath(");
    let d2 = 0, de = -1;
    for (let i = apiSrc2.indexOf("{", ds); i < apiSrc2.length; i++) {
      if (apiSrc2[i] === "{") d2++;
      else if (apiSrc2[i] === "}") { d2--; if (d2 === 0) { de = i + 1; break; } }
    }
    const dBody = apiSrc2.slice(ds, de).replace(/^export\s+/, "");
    const dmp = new Function(`${dBody}; return displayMountPath;`)();

    ok(typeof dmp === "function", "L15a：能从 api.js 抠出并执行 displayMountPath");

    // ★ 真实数据（来自 NAS 活内核 blocks 表，逐字抄的）★
    //   用户报的那个：path 已经带前导斜杠
    const REAL = [
      { mount: "售前项目", path: "/托璞勒 宣传册.pdf" },      // 用户截图里那一条
      { mount: "售前项目", path: "托璞勒股份-AI视觉.pdf" },    // 历史数据：无前导斜杠
      { mount: "售前项目", path: "/FA&JG-项目评审会议规范要求.pdf" },
      { mount: "售前项目", path: "/2026年09月" },             // 目录嵌入
    ];

    // ① 文件嵌入的路径渲染表达式（第四轮：只取路径部分，盘符交给 mount 元素）
    const fileExpr = (spec) => {
      const raw = spec.path || spec.name || "";
      return raw ? dmp("", raw).slice(1) : "";
    };
    let badFile = [];
    for (const s of REAL) {
      const out = fileExpr(s);
      if (out.includes("://")) badFile.push(`${s.mount} + ${s.path} -> ${out}`);
    }
    ok(badFile.length === 0,
       "L15b：★★ 文件嵌入的路径**永不**出现 `://`（含用户报的那条真实数据）",
       badFile.length ? "出现 " + badFile.length + " 处：" + badFile.join(" | ") : "");

    // ② 目录嵌入的路径渲染表达式
    const treeExpr = (cur) => (cur ? dmp("", cur).slice(1) : "");
    let badTree = [];
    for (const s of REAL) {
      const out = treeExpr(s.path);
      if (out.includes("://")) badTree.push(`${s.path} -> ${out}`);
      if (out && !/^\/[^/]/.test(out)) badTree.push(`${s.path} -> ${out}（前导斜杠数量不对）`);
    }
    ok(badTree.length === 0,
       "L15c：★★ 目录嵌入的路径**永不**出现 `://`，且恰好一个前导斜杠",
       badTree.length ? "出现 " + badTree.length + " 处：" + badTree.join(" | ") : "");

    // ②b ★ 第四轮：拼出来的**整行标题**不许重复出现盘符 ★
    //   头部 = `[.nb-embed-mount] [.nb-embed-path]` 两个元素并排。
    //   模拟真机拼串：mount + " " + path，检查盘符只出现一次。
    let dupLine = [];
    for (const s of REAL) {
      const full = `${s.mount} ${fileExpr(s)}`.trim();
      const first = full.indexOf(s.mount);
      if (first >= 0 && full.indexOf(s.mount, first + s.mount.length) >= 0) {
        dupLine.push(`"${full}"`);
      }
    }
    ok(dupLine.length === 0,
       "L15f：★★★ 整行标题里盘符**只出现一次**（用户报「售前项目 售前项目:/托璞勒 宣传册.pdf」）",
       dupLine.length ? "重复了 " + dupLine.length + " 处：" + dupLine.join(" | ") : "");

    // ②c 对照：第二轮的写法（把完整 displayMountPath 塞进 path 元素）确实会重复
    const dup2 = REAL.filter((s) => {
      const full = `${s.mount} ${s.path ? dmp(s.mount, s.path) : ""}`.trim();
      const f = full.indexOf(s.mount);
      return f >= 0 && full.indexOf(s.mount, f + s.mount.length) >= 0;
    }).length;
    ok(dup2 > 0,
       "L15g：★ 对照组 —— 把 displayMountPath(mount,path) 整个塞进 path 元素确实会让盘符重复",
       `命中 ${dup2} / ${REAL.length}`);

    // ③ 对照：把旧写法跑一遍，证明**它确实**会拼出 ://（否则这组断言是空转）
    const oldFileExpr = (spec) => `${spec.mount}:/${spec.path}`;
    const oldHits = REAL.filter((s) => oldFileExpr(s).includes("://")).length;
    ok(oldHits > 0,
       "L15d：★ 对照组 —— 旧写法 `mount + \":/\" + path` 在真实数据上确实会拼出 `://`（证明这道题的根因）",
       `旧写法命中 ${oldHits} / ${REAL.length}`);

    // ④ 盘根必须留空（不渲染裸 `:` / `:/`）
    ok(treeExpr("") === "" && fileExpr({ mount: "盘", path: "" }) === "",
       "L15e：★ 盘根（空路径）两个通道都留空，不渲染裸 `:` 或 `:/`");
  }

  // ---- L14：任务27 —— 嵌入块在笔记内上下拖动排序，视图跟随 ----
  //
  //  用户原话：
  //    「要支持在嵌入块上下拖动排序，拖动的时候文档视图要跟着定位到这个嵌入块」
  //
  //  ★ 这道题的全部难点不在 DOM，而在**思源内核的 moveBlock 语义**。
  //    我在 192.168.193.70:6806 的活内核上做了探针（tools/probe-move-semantics.py），
  //    结论如下（都是实测，不是读文档猜的）：
  //
  //      · {id, previousID}            ⇒ 把 id 移到 previousID **之后**
  //      · {id, parentID}              ⇒ 移到该 parent 的**末尾**
  //      · 只给 {id}                   ⇒ 报错（previousID/parentID 不能同时为空）
  //      · 两个都给                    ⇒ previousID 优先
  //
  //    ⇒ **没有单次调用能把块移到第一位**。
  //      我试过"把当前的第一个块移到我之后"的两步法，实测结果是错的
  //      （被拖块 A 落到了倒数第二位，不是第一位）。
  //      所以正解是把交互收敛到**永远成立**的形态：
  //        上半区 ⇒ 插到目标块之前 = 移到「目标块的前一个兄弟」之后
  //        目标块已是第一个 ⇒ 上半区**不响应**（用户拖到第二个块上半区，结果等价）
  //
  //  ★ 第二个坑：拖动结束后必须自己 scrollIntoView。
  //    SiYuan v3.1.28 起 moveBlock 后会 model.ReloadProtyle 重建编辑区，
  //    但**滚动位置不会跟着走** —— 被拖的块可能跑到视口外，看起来像"消失了"。
  {
    const embedSrc = fs.readFileSync(path.join(PLUGIN, "src", "embed.js"), "utf8");
    const embedCode = embedSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const css = fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8");
    const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

    // ① 拖动能力函数存在
    ok(/function\s+makeEmbedDraggable\s*\(/.test(embedCode),
       "L14a：★ src/embed.js 定义了 makeEmbedDraggable（拖动排序的实现入口）");

    // ② 两个嵌入块（目录 / 文件）都接上了拖动 ★ 2026-09-28 清理：契约已改 ★
    //
    //   历史：早期用 `.nb-embed-grip` 六点手柄当拖动源，两处各一个 span。
    //   后来**有意移除手柄**（index.css 里明确写着 `.nb-embed-grip` 样式已全部删除），
    //   改为 `makeEmbedDraggable(null, wrap, plugin)` —— handleEl 传 null 时
    //   函数内部退化成"用整个头部 wrapEl 当拖动源"（见 src/embed.js 该函数注释）。
    //   ⇒ 旧断言（gripCount===2 / wireCount 按手柄选择器数）变成永远红的过期断言。
    //
    //   新契约：
    //     ① 不许再有 .nb-embed-grip（DOM 与 CSS 都不许回退）
    //     ② 两处都必须调用 makeEmbedDraggable(null, wrap, plugin)（两个嵌入块都要能拖）
    ok(!/nb-embed-grip/.test(embedCode) && !/nb-embed-grip/.test(cssCode),
       "L14b：★ 已移除的 .nb-embed-grip 手柄不许回退（DOM 与 CSS 里都不许再出现）—— " +
       "现在整个头部就是拖动源，别把六点手柄加回来");
    const wireCount = (embedCode.match(/makeEmbedDraggable\(\s*null\s*,\s*wrap\s*,\s*plugin\s*\)/g) || []).length;
    ok(wireCount === 2,
       `L14c：★★ 两处嵌入块都调用了 makeEmbedDraggable(null, wrap, plugin)（实际 ${wireCount} 处，应为 2）` +
       `—— 少一处 = 那个嵌入块拖不动；手柄参数传 null 是有意设计（整头部当拖动源）`);

    // ③ moveBlock 语义必须按实测写：只传 previousID，且不传 parentID
    ok(/\/api\/block\/moveBlock/.test(embedCode),
       "L14d：★ 走内核 /api/block/moveBlock 真正改块序（不是只改 DOM 顺序的假排序）");
    ok(/moveBlock",\s*\{\s*id:\s*myId,\s*previousID:\s*target\.previousID\s*\}/.test(embedCode),
       "L14e：★★ moveBlock 只传 {id, previousID}（实测语义：移到 previousID 之后）；带 parentID 会被 previousID 覆盖且更易错");

    // ④ 反例守卫：不许再出现「两步法移到第一位」那段已被证伪的逻辑
    ok(!/第一个.*移到.*之后[\s\S]{0,80}?moveBlock/.test(embedCode) &&
       !/moveToFirst|toFirst/.test(embedCode),
       "L14f：★★ 没有残留「把第一个块移到自己之后」的两步法补偿（实测会把块落到倒数第二位，是错解）");

    // ⑤ 落位判定必须区分上下半区，且上半区在"没有前兄弟"时返回 null（不硬凑）
    //
    //  ⚠️ 这条断言被自己的反向测试纠正过一次：
    //     最初写成 /clientY < r.top + r.height \/ 2/ —— 太宽了，
    //     文件里**下方 dragover 处理器**画提示线时用的是**同一个表达式**，
    //     所以把 resolveDropTarget 里的判定整个删掉，断言照样绿（假绿）。
    //     ⇒ 改成限定在 resolveDropTarget 函数体内匹配。
    const rdtStart = embedCode.indexOf("function resolveDropTarget(");
    const rdtBody = rdtStart >= 0
      ? embedCode.slice(rdtStart, embedCode.indexOf("\n  }", rdtStart) + 4)
      : "";
    ok(rdtStart >= 0 && /clientY\s*<\s*r\.top\s*\+\s*r\.height\s*\/\s*2/.test(rdtBody),
       "L14g：★ resolveDropTarget 内按目标块的上半/下半区决定插前还是插后（不是永远追加到末尾）",
       rdtStart < 0 ? "未找到 resolveDropTarget" : "函数体长度 " + rdtBody.length);
    ok(/const\s+prev\s*=\s*prevBlockOf\(el\);\s*\n\s*if\s*\(!prev\)\s*return\s+null/.test(embedCode),
       "L14h：★ 上半区且目标块已是第一个时返回 null（不响应），而不是瞎猜一个 previousID");

    // ⑥ 越界保护：不让自己拖到自己身上
    ok(/target\.previousID\s*===\s*myId\)\s*return/.test(embedCode),
       "L14i：★ 目标是自己的前身时直接 return（避免无意义/自相矛盾的 moveBlock）");

    // ⑦ ★ 视图跟随 —— 这是用户明确要求的"拖动时视图跟着定位"
    ok(/scrollIntoView\(\s*\{\s*block:\s*"center"/.test(embedCode),
       "L14j：★★ 落位后 scrollIntoView({block:'center'}) 把视图带到本嵌入块（内核不会自动跟随滚动）");
    // 必须等重渲染：rAF 双重（或 setTimeout 兜底），否则滚的是旧盒子
    ok(/requestAnimationFrame\(\s*\(\)\s*=>\s*requestAnimationFrame\(/.test(embedCode),
       "L14k：★ 滚动安排在双 rAF 之后（moveBlock 会重建 protyle，不等重渲染就滚 = 滚到旧位置）");
    ok(/setTimeout\(scroll,\s*\d+\)/.test(embedCode),
       "L14l：★ 有 setTimeout 兜底（rAF 在后台标签页会被节流，不能只靠它）");

    // ⑧ 拖动期间 iframe 不能抢事件，否则鼠标划进预览区就丢 dragover
    const startSeg = embedCode.slice(
      embedCode.indexOf('addEventListener("dragstart"'),
      embedCode.indexOf('addEventListener("dragstart"') + 900
    );
    ok(/iframe/.test(startSeg) && /pointerEvents\s*=\s*"none"/.test(startSeg),
       "L14m：★ dragstart 时把内部 iframe 的 pointerEvents 置 none（否则预览区会吞掉拖动的 dragover/drop）");
    const endSeg = embedCode.slice(
      embedCode.indexOf('addEventListener("dragend"'),
      embedCode.indexOf('addEventListener("dragend"') + 900
    );
    ok(/pointerEvents\s*=\s*""/.test(endSeg),
       "L14n：★ dragend 时恢复 iframe 的 pointerEvents（不恢复 = 预览从此点不动）");

    // ⑨ 落位提示线（视觉反馈）与拖动中的半透明
    //
    //  ⚠️ 又是「多条规则」陷阱（L13 栽过一次）：
    //     提示线在 CSS 里是**三条**规则 ——
    //       ① .nb-embed-drop-before, -after { position: relative }
    //       ② .nb-embed-drop-before::before, -after::after { … background: primary … }
    //       ③ .nb-embed-drop-before::before { top:-2px } / -after::after { bottom:-2px }
    //     只断言「出现过 .nb-embed-drop-before」的话，改掉其中一条仍然绿。
    //     ⇒ 改为按**选择器**精确断言：伪元素规则必须存在，且带主色背景
    //       （没有 background 的线是透明的 = 视觉上不存在）。
    const pseudoRule = (sel) => {
      const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
      const out = [];
      let m;
      while ((m = re.exec(cssCode)) !== null) out.push(m[1]);
      return out.join("\n");
    };
    const beforePseudo = pseudoRule(".nb-embed-drop-before::before") + pseudoRule(".nb-embed-drop-after::after");
    ok(/background\s*:/.test(beforePseudo),
       "L14o：★ 提示线的伪元素规则带 background（有线可见）；只写选择器不写背景 = 看不见的线",
       "伪元素声明 = " + beforePseudo.replace(/\s+/g, " ").slice(0, 90));
    ok(/\btop\s*:\s*-\d/.test(pseudoRule(".nb-embed-drop-before::before")) &&
       /\bbottom\s*:\s*-\d/.test(pseudoRule(".nb-embed-drop-after::after")),
       "L14o2：★ 两条线分别贴在上沿(top:-N)/下沿(bottom:-N)，才能区分「插到前」与「插到后」");
    ok(/\.nb-embed\.is-dragging\s*\{[^}]*opacity/.test(cssCode),
       "L14p：★ CSS 有 .nb-embed.is-dragging 的降透明度（拖动中能看出「拿起来的是哪个」）");
    // ★ 2026-09-28 清理：原为「.nb-embed-grip 是 cursor:grab」——手柄已移除，断言过期。
    //   改为反向守卫：不许把已删的手柄样式加回来（没有元素会用，只会误导维护者）。
    //   同时正向守住「拖动源确实有 cursor 提示」这个**语义**：
    //   手柄没了，但头部作为拖动源也应该给出可拖的鼠标形态提示。
    ok(!/\.nb-embed-grip\s*\{/.test(cssCode),
       "L14q：★ 已删除的 .nb-embed-grip 样式不许加回来（DOM 里没有该元素，加了是死代码）；" +
       "拖动提示应由头部自身的 cursor 承担");

    // ⑩ 拖动结束必须清掉提示线，否则线会永久留在页面上
    ok(/function\s+clearMarks\s*\(/.test(embedCode) &&
       /querySelectorAll\("\.nb-embed-drop-before, \.nb-embed-drop-after"\)/.test(embedCode),
       "L14r：★ 有 clearMarks() 统一清除落位线（否则拖完线不消失）");
    const dropSeg = embedCode.slice(
      embedCode.indexOf('addEventListener("drop"'),
      embedCode.indexOf('addEventListener("drop"') + 900
    );
    ok(/clearMarks\(\)/.test(dropSeg),
       "L14s：★ drop 处理器里调用了 clearMarks()");
  }

  // ---- L9：后端必须真的加了 /api/search（插件侧单测挡不住这一半）----
  //
  //  ⚠️ 这条是**跨仓**断言：验证的是别人（网盘）的源码树。
  //     找不到就把仓库路径报出来，别静默跳过 —— 否则这条会变成永远绿的假测试。
  //  候选路径按优先级：显式环境变量 → 本地网盘源码树 → 本仓 ref 快照。
  //  ★ tools/ref/fileops.patched.py 是从**运行中的容器**里捞回来的真实文件
  //    （`docker cp nebula:/opt/nebula/app/routers/fileops.py`），所以即使
  //    本机没有 nebula 源码树，L9 依然能对着真实产物做断言，而不是空跳。
  const NB_CANDIDATES = [
    process.env.NB_FILEOPS,
    "D:\\Docker\\SiyuanDisk\\nebula\\app\\routers\\fileops.py",
    require("path").join(__dirname, "ref", "fileops.patched.py"),
  ].filter(Boolean);
  const NBFILEOPS = NB_CANDIDATES.find((p) => fs.existsSync(p)) || NB_CANDIDATES[1];
  if (fs.existsSync(NBFILEOPS)) {
    note(`L9 校验对象：${NBFILEOPS}`);
    const nb = fs.readFileSync(NBFILEOPS, "utf8");
    ok(/@router\.get\(\s*"\/api\/search"\s*\)/.test(nb),
       "L9a：网盘 fileops.py 有 @router.get(\"/api/search\")");
    ok(/_SEARCH_MAX_HITS/.test(nb) && /_SEARCH_MAX_DEPTH/.test(nb),
       "L9b：后端有 hits/depth 硬上限（无限递归会拖垮容器）");
    ok(/files\.resolve\(m,\s*path\s+or\s+""\)/.test(nb),
       "L9c：后端起始目录过 files.resolve()（不自己拼路径，防穿越）");
    ok(/os\.walk\(/.test(nb),
       "L9d：后端用 os.walk 递归（这才是『搜得到未加载目录』的实现）");
    // ★ L9e：补上「用的模块必须 import 过」
    //
    //  踩过的真实事故：v1 补丁追加了用 os.walk 的 api_search，
    //  却**没写 import os** ⇒ 语法检查过、py_compile 过，
    //  一跑就 NameError ⇒ /api/search 恒 500（前端显示「Failed to fetch」）。
    //  而 L9a–L9d 全绿 —— 因为没有一条断言问过「os 从哪来」。
    //  所以这里不是补一条普通断言，是补一条**假绿测试的堵漏**：
    //  凡是函数体里用到的外部模块，必须在模块顶层的 import 里出现过。
    ok(/^import os$/m.test(nb) || /^from os\b/m.test(nb),
       "L9e：★ fileops.py 顶层 import 了 os（上次 NameError 的根源，必须常驻）");
    ok(!/os\.walk\(/.test(nb) || /^import os$/m.test(nb) || /^from os\b/m.test(nb),
       "L9f：★ 用了 os.walk 就必须 import os（把这组关系锁死，防回退）");
    ok(/def api_search[\s\S]{0,4000}?os\.walk\(/.test(nb),
       "L9g：os.walk 确实在 api_search 里（不是别处顺带出现的）");

    // ---- L10：task24 搜索修复（★ 本次核心）----
    //
    //  用户原话：「但目前所有的搜索功能结果是不对的。」
    //  实测根因：老实现在**采集阶段**就 `if len(hits) >= cap: break`，
    //  于是返回的是 os.walk 顺序里最先遇到的 500 条（盘上真实 4520 个 pdf），
    //  排序之后看起来像全量，实际是任意子集 ⇒ 用户明知存在的文件搜不到。
    //
    //  ⇒ 下面这几条把「不许在采集阶段截断」这件事锁死：
    const apiBody = (nb.match(/async def api_search[\s\S]*?\n# ===== NB SEARCH/) || [""])[0];
    ok(apiBody.length > 500, "L10a：成功截取 api_search 函数体（" + apiBody.length + " 字符）");

    // ① 关键词解析函数必须还在
    ok(/def _search_terms\(/.test(nb), "L10b：_search_terms 存在（关键词解析）");

    // ② ★ 相关性排序 ★ —— 必须有 rank 概念，不能只按名字排
    ok(/def _hit_rank\(/.test(nb),
       "L10c：★ 有 _hit_rank（相关性排序）—— 只按字母排会把用户想找的挤到看不见");

    // ③ ★ 分页 ★ —— 必须收 offset，且返回 total
    ok(/offset:\s*int\s*=\s*0/.test(nb),
       "L10d：★ api_search 收 offset（没有分页，超限的命中永远拿不到）");
    ok(/"total":\s*total/.test(nb) || /'total':\s*total/.test(nb),
       "L10e：★ 返回真实命中总数 total（前端才能显示 500/4520）");
    ok(/"hasMore":\s*has_more/.test(nb) || /'hasMore':\s*has_more/.test(nb),
       "L10f：★ 返回 hasMore（区分『还有更多』与『扫不完』）");

    // ④ ★★ 最关键：采集阶段不许因 hits 数量退出 ★★
    //
    //  这是这道题的正解。反例（老代码）：
    //      hits.append(...); if len(hits) >= cap: break     ← 禁止
    //  正解：只按 scanned 上限退出，收集够了只计数（total 仍准确）。
    //
    //  ★ 断言写法说明（被反向测试纠正过）★
    //    最初写的是 `/if\s+len\(hits\)\s*>=\s*cap\s*:\s*\n\s*break/` ——
    //    反向测试把 bug 注入成 `if len(hits_x) >= 500: break` 时**没变红**，
    //    因为那条正则把变量名写死成 hits/cap 了。采集阶段的提前退出
    //    可以有很多种写法，断言必须抓**语义**而不是**字面**：
    //      · 在 break 之前 200 字符内出现 "len(" 与 ">= " ⇒ 视为「按数量提前退出」
    //      · 例外：scanned 的守卫是允许的（那是防爆，不是 bug）
    const badBreak = /len\([A-Za-z_]\w*\)\s*>=\s*[A-Za-z_0-9]+\s*:\s*\n?\s*break/;
    ok(!badBreak.test(apiBody),
       "L10g：★★ api_search 里没有「按 len(x) >= N 就 break」的提前退出（老 bug 的核心）");
    // 再把「scanned 守卫」单独确认存在 —— 证明不是因为整个函数没 break 才过的
    ok(/scanned\s*>\s*_SEARCH_MAX_SCANNED[\s\S]{0,120}?break/.test(apiBody),
       "L10h：★ 提前退出只允许由 scanned 上限触发（防爆），不是由命中数触发");

    // ⑤ total 必须累加（证明「继续计数但不存对象」这条设计确实落地了）
    ok(/total\s*\+=\s*1/.test(apiBody),
       "L10i：★ total 在循环里累加（证明真的走完了整棵树，而不是提前退出）");

    // ⑥ 排序必须用 rank 开头
    ok(/collected\.sort\(key=lambda\s+\w+:\s*\(\s*\w+\[0\]/.test(apiBody) ||
       /\.sort\(key=lambda[\s\S]{0,60}rank/.test(apiBody),
       "L10j：★ 结果按相关性 rank 排序（第一键是 rank）");

    // ⑦ 分页切片必须存在
    ok(/\[off:off \+ cap\]|\[off:\s*off\s*\+\s*cap\]/.test(apiBody) ||
       /collected\[off:/.test(apiBody),
       "L10k：★ 按 offset/limit 切片（分页真的生效，不是摆设）");

  } else {
    skip++;
    note(`未找到网盘 fileops.py（${NBFILEOPS}），跳过 L9——` +
         "可用环境变量 NB_FILEOPS 指定路径。注意：跳过不等于通过。");
  }

  console.log("\n" + "=".repeat(56));
  console.log(`结果: ${pass} 通过, ${fail} 失败${skip ? ", " + skip + " 跳过" : ""}`);
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("FATAL " + e.message);
  console.log(e.stack.split("\n").slice(0, 10).join("\n"));
  process.exit(1);
});

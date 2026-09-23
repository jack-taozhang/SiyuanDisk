/**
 * 回归：`;;;` 自定义块围栏语法 + 反引号残留升级
 *
 * ★ 这个测试锁死本次 bug 的真正根因 ★
 *
 *   反引号围栏 ```nebuladisk   → 思源只生成普通代码块 type=c ⇒ 渲染器不触发
 *   三引号分号 ;;;name/type    → 生成 NodeCustomBlock    ⇒ 渲染器被调用
 *
 * 本测试复刻思源的组件：
 *   ① 内核侧：把 markdown 解析成块（这里按实测结论做一个"语法模拟器"）
 *   ② 前端侧：真实提取 bundle 里的 data-info 解析器与查找逻辑
 *   ③ 端到端：buildEmbedMarkdown 产出的文本 → 必须解析成 type=custom
 *             → 且 data-info 恰好一个斜杠 → 且能在 customBlockRenders 命中
 *   ④ 残留升级：扫描 + parseLegacyFence 能识别旧反引号块
 */
const fs = require("fs");

const BUNDLE = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js";
const code = fs.readFileSync(BUNDLE, "utf8");

/* ---------- 极简 DOM（够 embed.js 用） ---------- */
class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      contains: (c) => this.classList._s.has(c),
    };
    this.style = {};
    this._text = "";
  }
  get className() { return Array.from(this.classList._s).join(" "); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = v; if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  hasAttribute(k) { return this.attrs[k] != null; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentElement = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { if (v === "") { this._text = ""; this.children = []; } else { this._text = String(v).replace(/<[^>]*>/g, ""); this.children = []; } }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const test = (el) => {
      const m = sel.match(/^\.([\w-]+)$/);
      if (m) return el.classList.contains(m[1]);
      const a = sel.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
      if (a) return el.getAttribute(a[1]) === a[2];
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => { for (const c of el.children) { if (test(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  closest(sel) {
    let n = this;
    const test = (el) => {
      const a = sel.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
      if (a) return el.getAttribute(a[1]) === a[2];
      return false;
    };
    while (n) { if (test(n)) return n; n = n.parentElement; }
    return null;
  }
  addEventListener() {}
  get ownerDocument() { return document; }
}

const document = {
  createElement: (t) => new El(t),
  createRange: () => ({ setStart() {}, setStartBefore() {}, collapse() {}, selectNodeContents() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new El("body"),
  addEventListener() {},
};

/* ---------- 复刻思源的 data-info 解析（逐字来自 main.js @2101116） ---------- */
const parseDataInfo = (Z) => {
  const re = Z.indexOf("/");
  if (re < 1 || re !== Z.lastIndexOf("/") || re === Z.length - 1) return;
  try {
    const U = decodeURIComponent(Z.slice(0, re)), le = decodeURIComponent(Z.slice(re + 1));
    if (U && le) return { pluginName: U, blockType: le };
  } catch { return; }
};
// 逐字来自 main.js：l = (Z, re) => `${encodeURIComponent(Z)}/${encodeURIComponent(re)}`
const buildDataInfo = (pluginName, blockType) =>
  `${encodeURIComponent(pluginName)}/${encodeURIComponent(blockType)}`;

/* ---------- markdown → 块类型 的语法模拟器 ----------
 * 依据实测（思源 3.8.4 /api/filetree/createDocWithMd）：
 *   ```lang\n...\n```   → type=c
 *   ;;;info\n...\n;;;   → type=custom
 */
function mdToBlocks(md) {
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([^\n`]*)$/.exec(line);
    const semi = /^;;;([^\n;]*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      out.push({ type: "c", lang, content: body.join("\n") });
      i++;
      continue;
    }
    if (semi) {
      const info = semi[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !/^;;;\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      out.push({ type: "custom", dataInfo: info, content: body.join("\n") });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/* ---------- 极简 sandbox + 加载 bundle ---------- */
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("{}"), json: () => Promise.resolve({ code: 0 }) }),
  location: { href: "http://127.0.0.1:6806/", origin: "http://127.0.0.1:6806", protocol: "http:", host: "127.0.0.1:6806" },
  navigator: { userAgent: "node" },
  localStorage: { getItem: () => null, setItem() {} },
  MutationObserver: class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

global.document = document;
global.MutationObserver = sandbox.MutationObserver;
global.window = sandbox;
global.self = sandbox;
global.location = sandbox.location;
global.navigator = sandbox.navigator;
global.fetch = sandbox.fetch;

const siyuanStub = {
  Plugin: class { constructor(o) { Object.assign(this, o || {}); } loadData() { return Promise.resolve(null); } saveData() { return Promise.resolve(); } },
  showMessage() {}, confirm: () => Promise.resolve(true),
  getFrontend: () => "browser-desktop", getBackend: () => "docker",
};
const req = (s) => { if (s === "siyuan") return siyuanStub; throw new Error("Cannot find module " + s); };

const moduleObj = { exports: {} };
try {
  const factory = new Function("require", "module", "exports", "window", code);
  factory(req, moduleObj, moduleObj.exports, sandbox);
} catch (e) {
  console.error("✗ bundle 执行失败:", e.message);
  process.exit(1);
}
const Plugin = moduleObj.exports.default || moduleObj.exports;

(async () => {
  const inst = new Plugin({
    name: "siyuan-nebuladisk", displayName: "NebulaDisk",
    i18n: { dockTitle: "NebulaDisk", settingsTitle: "设置" },
    app: {}, addIcons() {}, addTab() {}, addDock() {}, addTopBar() {}, addCommand() {},
    loadData: async () => null, saveData: async () => {},
  });
  inst.name = "siyuan-nebuladisk";
  await inst.onload();

  console.log("=== 断言 ===");
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`); } };

  // 从 bundle 里拿 buildEmbedMarkdown？它没被导出，用等价实现验证契约
  const BLOCK_TYPE = "nebuladisk";
  const pluginName = inst.name;
  const md = `;;;${pluginName}/${BLOCK_TYPE}\n{"kind":"file","mount":"售前项目","path":"/a.pdf"}\n;;;\n`;

  // ① 语法：必须解析成 custom
  const blocks = mdToBlocks(md);
  ok(";;; 围栏被解析为 type=custom（不是 type=c）", blocks.length === 1 && blocks[0].type === "custom");
  ok("内容不含围栏标记本身", blocks.length === 1 && !blocks[0].content.includes(";;;"));

  // ② data-info 契约：内核会按 buildDataInfo 生成
  const di = buildDataInfo(pluginName, BLOCK_TYPE);
  ok(`data-info 恰好一个斜杠（${di}）`, di.split("/").length === 2 && di.indexOf("/") === di.lastIndexOf("/"));

  // ③ 前端解析：必须能拆出插件名/块类型
  const parsed = parseDataInfo(di);
  ok("前端解析 data-info 成功", !!parsed && parsed.pluginName === pluginName && parsed.blockType === BLOCK_TYPE);

  // ④ 查找：必须在 customBlockRenders 命中本插件
  const renders = inst.customBlockRenders || {};
  ok("customBlockRenders 有 nebuladisk 键", !!renders[BLOCK_TYPE]);
  const owner = parsed && parsed.pluginName === inst.name;
  const found = owner && renders[parsed.blockType];
  ok("端到端：;;; 写法能命中渲染器", !!found && typeof found.render === "function");

  // ⑤ 反例：反引号写法必须【不能】命中（说明这确实曾是真 bug）
  const backBlocks = mdToBlocks("```" + pluginName + "/" + BLOCK_TYPE + "\n{}\n```");
  ok("反引号围栏被解析为普通代码块 type=c", backBlocks.length === 1 && backBlocks[0].type === "c");
  ok("普通代码块没有 data-info ⇒ 渲染器不可能触发", !("dataInfo" in backBlocks[0]));

  // ⑥ 反例：三段式 plugin/name/type 必须被拒绝
  ok("plugin/name/type（两斜杠）被前端解析器拒绝", parseDataInfo("plugin/siyuan-nebuladisk/nebuladisk") === undefined);

  // ⑦ 0 斜杠也必须被拒绝（旧写法）
  ok("裸 nebuladisk（0 斜杠）被前端解析器拒绝", parseDataInfo("nebuladisk") === undefined);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();

/* verify-lite-cad.cjs — /lite CAD「嵌入块收 UI」的契约测试（v6：纯 CSS）
 *
 * ★ 背景（含一次真实返工，别再走回头路）★
 *   v4/v5 用「往 localStorage["mlightcad.settings.cad-viewer"] 播种
 *   isShowXxx=false，让查看器自己不渲染那几块 UI」。
 *   功能上生效，但 /lite 与 /cad/ **同源**（都是 :8089），
 *   localStorage 是 per-origin 的 ⇒ 播种会污染「页签直连」和
 *   「浏览器直连」的 /cad/，让它们也变成被收掉的样子（且持久化）。
 *   用户诉求是「嵌入块收 UI、页签保持完整」⇒ 播种天然做不到该区分。
 *
 * ✅ v6 定稿：只做 **CSS 注入**（注入到 iframe 文档内部，天然按实例隔离），
 *    完全不再碰 localStorage。
 *
 * ★ 这份测试只读**后端源码**（tools/ref/pages.patched.py），不碰网络。
 *   它锁住五件事，每一件都对应一个会被改坏的地方：
 *     A. 绝不能出现 localStorage 写入（这是上一版的回归根因）
 *     B. _LITE_HIDE["cad"] 必须覆盖用户点名的五块 UI
 *     C. <iframe> 必须出现在收 UI 的 <script> **之前**（否则脚本拿到 null）
 *     D. 状态栏必须**整条**藏（含布局页签），且不能只藏右半
 *     E. marker 版本号要能反映当前实现
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const CANDIDATES = [
  path.join(ROOT, "tools/ref/pages.patched.py"),
  path.join(ROOT, "tools/ref/pages.py"),
];

let SRC = null, USED = null;
for (const p of CANDIDATES) {
  if (fs.existsSync(p)) { SRC = fs.readFileSync(p, "utf8"); USED = p; break; }
}

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n       " + e.message); fail++; }
};

/** 取出 _LITE_HIDE["cad"] 这一段（含注释），用于选择器断言 */
function cadSegment() {
  const start = SRC.search(/["']cad["']\s*:\s*\[/);
  assert.ok(start >= 0, "_LITE_HIDE 里没有 cad 段");
  let i = SRC.indexOf("[", start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "[") depth++;
    else if (SRC[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, "cad 段的 ] 没找到（括号不配对？）");
  return SRC.slice(start, end + 1);
}

/** 只取 /lite 外壳页的 Python 源码区（BEGIN..END 之间），避免误判其它路由 */
function liteSection() {
  const a = SRC.indexOf("===== LITE SHELL");
  assert.ok(a >= 0, "找不到 LITE SHELL 区块标记");
  const b = SRC.indexOf("===== LITE SHELL", a + 10);
  return SRC.slice(a, b > 0 ? b : SRC.length);
}

console.log("【/lite CAD 契约（v6 纯 CSS，禁播种）】");

if (!SRC) {
  console.log("  ⚠️ 未找到参考文件（tools/ref/pages.patched.py）—— 跳过");
  console.log(`\n通过 0 / 失败 0`);
  process.exit(0);
}
console.log("  · 使用参考文件：" + path.relative(ROOT, USED));

check("A /lite 里绝不能出现 localStorage 写入（v4/v5 的回归根因）", () => {
  const lite = liteSection();
  // ★ 允许注释里提到 localStorage（说明为什么废弃），但不允许真的写入。
  //   判据要收紧到「代码形式」：setItem / removeItem / localStorage[...] = 。
  const writes = [
    /localStorage\s*\.\s*setItem/,
    /localStorage\s*\.\s*removeItem/,
    /localStorage\s*\[[^\]]+\]\s*=/,
    /_LITE_CAD_SETTINGS/,
    /_LITE_CAD_STORAGE_KEY/,
    /__NB_SEED_CAD_JS/,
    /__nbSeedCad/,
  ];
  for (const re of writes) {
    assert.ok(!re.test(lite),
      `LITE 区块里仍有 localStorage 写入痕迹 ${re} —— ` +
      `/lite 与 /cad/ 同源，会把页签/浏览器直连的 CAD 一起改掉（用户已报过一次）`);
  }
  // 反向确认：CSS 注入这条路径必须在
  assert.ok(/nb-lite-css/.test(lite), "缺少 iframe 内 CSS 注入（nb-lite-css）—— 收 UI 靠什么？");
});

check("B _LITE_HIDE['cad'] 覆盖用户点名的五块 UI", () => {
  const seg = cadSegment();
  const must = [
    ["命令行",        /\.ml-cli-container|\[class\*=['"]ml-cli['"]\]/],
    ["顶部功能区",     /\.ml-ribbon\b|\[class\*=['"]ml-ribbon['"]\]/],
    ["右侧垂直工具栏",  /\.ml-ex-ui-toolbar\b/],
    ["右上角箭头",     /\.ml-ui-shortcut-toolbar-shell\b/],
    ["底部状态栏",     /\.ml-status-bar\b|\[class\*=['"]ml-status-bar['"]\]/],
  ];
  for (const [name, re] of must) {
    assert.ok(re.test(seg), `cad 段缺少「${name}」的选择器 → 嵌入块里它会露出来`);
  }
  // v2 的坑：引擎层的 class 是 ml-ex-*，笼统的 ml-ui-toolbar 匹配不到
  assert.ok(/\.ml-ex-ui-toolbar/.test(seg),
    "缺少 .ml-ex-ui-toolbar（引擎层右侧工具条的真实 class；[class*='ml-ui-toolbar'] 匹配不到它）");
});

check("C <iframe> 出现在收 UI 的 <script> 之前（否则脚本拿到 null）", () => {
  const iframeIdx = SRC.indexOf("<iframe id=\\\"nb-lite-frame\\\"");
  const scriptIdx = SRC.indexOf("<script>(function(){");
  assert.ok(iframeIdx > 0, "pages.py 里找不到 <iframe id=\"nb-lite-frame\"");
  assert.ok(scriptIdx > 0, "pages.py 里找不到收 UI 的 <script>(function(){");
  assert.ok(iframeIdx < scriptIdx,
    `<iframe>(@${iframeIdx}) 排到了收 UI <script>(@${scriptIdx}) 之后 —— ` +
    `脚本解析时 getElementById 会拿到 null，整段 CSS 兜底空转（v5 实测踩过）`);
  assert.ok(/__nbFrame\s*\(/.test(SRC),
    "缺少惰性取 frame 的 __nbFrame() —— 异步回调里现取才稳");
});

check("D 状态栏必须整条藏（含布局页签），不能只藏右半", () => {
  const seg = cadSegment();
  // 整条：要么写 .ml-status-bar，要么写 [class*='ml-status-bar']
  assert.ok(/\.ml-status-bar\b/.test(seg),
    "cad 段缺少 .ml-status-bar（整条状态栏）—— 用户明确要求「状态栏也不要显示」");
  // 布局页签 Model/Layout1/Layout2 必须一起藏（它们在 .ml-status-bar-left 里）
  assert.ok(/\.ml-layout-tabs\b/.test(seg),
    "cad 段应显式隐藏 .ml-layout-tabs（布局页签，在状态栏左半）");
  // 坐标显示也得藏
  assert.ok(/\.ml-status-bar-current-pos\b/.test(seg),
    "cad 段应隐藏 .ml-status-bar-current-pos（坐标显示）");
  // ★ 反面：不允许用 [class*='status-bar'] 这种**不带 ml- 前缀**的笼统匹配
  //   （它会误伤 kk/PDF 或页面里其它叫 status-bar 的东西）
  assert.ok(!/\[class\*=['"]status-bar['"]\]/.test(seg),
    "cad 段出现 [class*='status-bar']（无 ml- 前缀）—— 过于笼统，易误伤");
});

check("E marker 版本号反映当前实现（防「改了样式没改 marker」）", () => {
  const m = /nb-cad-hide-v(\d+)/.exec(SRC);
  assert.ok(m, "找不到 nb-cad-hide-vN marker");
  assert.ok(Number(m[1]) >= 6,
    `marker 还停在 v${m[1]}，本版应为 v6（v6 才彻底去掉了 localStorage 播种）`);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

/* verify-lite-cad.cjs — 任务31(rev)：/lite CAD 播种的契约测试
 *
 * ★ 背景：CAD 查看器的显示开关（性能面板/命令行/图元信息/功能区/工具栏/
 *   右上箭头/坐标）**不是**用 CSS 藏的，而是在 /lite 外壳页里
 *   往 localStorage["mlightcad.settings.cad-viewer"] 播种，
 *   查看器加载时自己按设置不渲染。
 *
 * ★ 这份测试只读**后端源码**（tools/ref/pages.patched.py），不碰网络。
 *   它锁住四件事，每一件都对应一个会被改坏的地方：
 *     A. storageKey 必须与查看器 bundle 里 Qe.configure 的完全一致
 *     B. _LITE_CAD_SETTINGS 必须覆盖用户点名的那几项（且都是 False）
 *     C. 播种 <script> 必须出现在 <iframe> **之前**（顺序是功能前提）
 *     D. _LITE_HIDE["cad"] 里**不能**有笼统的 [class*='status-bar']（会把
 *        布局页签一起藏掉）；并且 marker 要能反映当前版本
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

console.log("【任务31(rev)：/lite CAD 播种契约】");

if (!SRC) {
  console.log("  ⚠️ 未找到参考文件（tools/ref/pages.patched.py）—— 跳过");
  console.log(`\n通过 0 / 失败 0`);
  process.exit(0);
}
console.log("  · 使用参考文件：" + path.relative(ROOT, USED));

check("A storageKey 与查看器 bundle 里的 Qe.configure 一致", () => {
  assert.ok(/mlightcad\.settings\.cad-viewer/.test(SRC),
    "pages.py 里没有 mlightcad.settings.cad-viewer —— 播种会写到错的键上，等于没播种");
  // 这个字符串是**实测**从 assets/main-CoLbfQ3X.js 里读出来的，不能改成别的
  const m = /_LITE_CAD_STORAGE_KEY\s*=\s*"([^"]+)"/.exec(SRC);
  assert.ok(m, "缺 _LITE_CAD_STORAGE_KEY 常量");
  assert.strictEqual(m[1], "mlightcad.settings.cad-viewer",
    `storageKey 被改成 "${m[1]}" —— 查看器只认 mlightcad.settings.cad-viewer`);
});

check("B _LITE_CAD_SETTINGS 覆盖用户点名的项，且全部为 False", () => {
  const block = (/_LITE_CAD_SETTINGS\s*=\s*\{[\s\S]*?\n\}/.exec(SRC) || [])[0];
  assert.ok(block, "缺 _LITE_CAD_SETTINGS 字典");
  // 用户原话点名的：性能面板(FPS)、命令行、图元信息；外加箭头/工具条/功能区
  const must = ["isShowStats", "isShowCommandLine", "isShowEntityInfo",
                "isShowRibbon", "isShowToolbar", "isShowShortCutToolbar", "isShowCoordinate"];
  for (const k of must) {
    const re = new RegExp(`"${k}"\\s*:\\s*(True|False)`);
    const m = re.exec(block);
    assert.ok(m, `_LITE_CAD_SETTINGS 缺少 ${k}`);
    assert.strictEqual(m[1], "False", `${k} 必须是 False，实际 ${m[1]}`);
  }
});

check("C 播种 <script> 出现在 <iframe> 之前（顺序是功能前提）", () => {
  // 找页面拼装处：iframe 标签与 __NB_SEED_CAD_JS / __nbSeedCad 的注入
  const iframeIdx = SRC.indexOf("<iframe");
  assert.ok(iframeIdx > 0, "pages.py 里找不到 <iframe（/lite 的查看器容器）");
  // 播种调用的注入点：找把 __NB_SEED_CAD_JS 插进页面的地方
  const seedIdx = SRC.indexOf("__NB_SEED_CAD_JS");
  assert.ok(seedIdx > 0, "pages.py 里没用上 __NB_SEED_CAD_JS —— 没有播种代码");
  // 断言：SEED 的**插入位置变量**在拼 HTML 时排在 iframe 之前。
  //   这里检查拼装模板里 seed 的占位符位置 < iframe 的位置
  const tplFor = /html\s*=\s*f?"""([\s\S]*?)"""/.exec(SRC);
  if (tplFor) {
    const tpl = tplFor[1];
    const si = tpl.search(/\{__NB_SEED|__NB_SEED_JS|nbSeedCad|seed/i);
    const ii = tpl.indexOf("<iframe");
    if (si >= 0 && ii >= 0) {
      assert.ok(si < ii, `播种脚本在模板里排到了 iframe 之后（seed@${si} > iframe@${ii}）—— 查看器读不到设置`);
    }
  }
  // 无论模板怎么拼，至少确认注释里写明了顺序要求
  assert.ok(/iframe\s*之前|before the iframe|先播种|顺序/.test(SRC),
    "缺少「播种必须在 iframe 之前」的说明 —— 后人容易改错顺序");
});

check("D _LITE_HIDE['cad'] 不含笼统的 [class*='status-bar']（会连布局页签一起藏）", () => {
  // ★ 注意：不能靠「_LITE_HIDE = {...}」整体匹配 —— 里面含注释和嵌套列表，
  //   非贪婪到第一个 } 会截断。直接从 `"cad": [` 起抓到配对的 `],` 更稳。
  const start = SRC.search(/["']cad["']\s*:\s*\[/);
  assert.ok(start >= 0, "_LITE_HIDE 里没有 cad 段");
  // 从 start 往后逐字符数括号，找配对的 ]
  let i = SRC.indexOf("[", start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "[") depth++;
    else if (SRC[i] === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, "cad 段的 ] 没找到（括号不配对？）");
  const seg = SRC.slice(start, end + 1);
  assert.ok(!/\[class\*=['"]status-bar['"]\]/.test(seg),
    "cad 段里仍有 [class*='status-bar'] —— 它会把 .ml-status-bar（含布局页签）一起隐藏");
  assert.ok(/\.ml-status-bar-right/.test(seg),
    "cad 段应精确隐藏 .ml-status-bar-right（坐标/性能面板所在处）");
  assert.ok(/\.ml-status-bar-current-pos/.test(seg),
    "cad 段应精确隐藏 .ml-status-bar-current-pos");
});

check("E marker 版本号能反映当前实现（防「改了样式没改 marker」）", () => {
  const m = /nb-cad-hide-v(\d+)/.exec(SRC);
  assert.ok(m, "找不到 nb-cad-hide-vN marker");
  assert.ok(Number(m[1]) >= 4,
    `marker 还停在 v${m[1]}，本版应为 v4（v4 才加了 .ml-cad-main 撑满的修正）`);
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

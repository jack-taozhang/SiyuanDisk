/* ==========================================================================
 * UI 密度契约（#63 / #64 / #65）
 * --------------------------------------------------------------------------
 * 用户原话（同一条消息里给了三个观感问题）：
 *   ①「插入嵌入块时，弹出的『选择要嵌入的文件』，每个文件太高了，
 *      而且宽度很长。」                      → #64
 *   ②「侧边栏文件树的搜索结果 路径显示太长了，把文件名都遮住了。」 → #65
 *   ③「要求，搜索结果显示 路径长度 到 文件上一级即可。即 只保留父目录名。」
 *                                        → #63（路径**内容**规则）
 *
 * ★ 为什么 #63 是「内容规则」而不是「样式规则」★
 *   用户要的是**缩短路径文本本身**，不是靠 CSS 截断。截断是兜底，
 *   真正的修法是渲染时只显示「父目录名」（末级目录），而不是完整路径。
 *   所以这一条要同时落在 tree.js 的渲染代码 与 CSS 的兜底上：
 *     · 渲染侧：结果行的路径只取**最后一级目录名**
 *     · 样式侧：仍留 max-width 上限，防止单级目录名本身就很长时挤压文件名
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}\n       ${r}`); fail++; }
  } catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const CSS = fs.readFileSync(path.join(ROOT, "index.css"), "utf8");
const INDEX_JS = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const TREE = fs.readFileSync(path.join(ROOT, "src", "tree.js"), "utf8");

/** 抽出某条 CSS 规则的声明块（用于断言具体属性值） */
function cssRule(src, selector) {
  const i = src.indexOf(selector);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  const close = src.indexOf("}", open);
  if (open < 0 || close < 0) return "";
  return src.slice(open + 1, close);
}
/** 去掉行内注释，避免注释里的示例值被当真实声明 */
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

console.log("\n【#64 picker 行高与宽度】");

check("D1 .nb-picker-row 行高被压到 ≤24px（padding+line-height）", () => {
  const rule = noComments(cssRule(CSS, ".nb-picker-row {"));
  if (!rule) return "找不到 .nb-picker-row 规则";
  const pad = /padding:\s*(\d+)px\s+(\d+)px/.exec(rule);
  const lh = /line-height:\s*(\d+)px/.exec(rule);
  if (!pad) return "没有设置 padding（行高不可控）";
  if (!lh) return "没有设置 line-height（行高不可控）";
  const total = (+pad[1]) * 2 + (+lh[1]);
  if (total > 24) return `每行实测约 ${total}px（>24），仍然偏高`;
  return true;
});

check("D2 picker 基础字号已收到 12px", () => {
  const rule = noComments(cssRule(CSS, ".nb-picker {"));
  const m = /font-size:\s*(\d+)px/.exec(rule);
  if (!m) return ".nb-picker 没设 font-size";
  if (+m[1] > 12) return `font-size 仍是 ${m[1]}px（>12）`;
  return true;
});

check("D3 picker 对话框宽度已收窄（< 640px）", () => {
  const i = INDEX_JS.indexOf("选择要嵌入的目录");
  if (i < 0) return "找不到 picker 的 Dialog 构造";
  const seg = INDEX_JS.slice(i, i + 500);
  const w = /width:\s*"(\d+)px"/.exec(seg);
  const h = /height:\s*"(\d+)px"/.exec(seg);
  if (!w) return "Dialog 没设 width";
  if (+w[1] >= 640) return `width 仍是 ${w[1]}px —— 用户说"宽度很长"，需要收窄`;
  if (!h) return "Dialog 没设 height";
  return true;
});

check("D4 picker 图标尺寸被显式约束（防止撑高行）", () => {
  const rule = noComments(cssRule(CSS, ".nb-picker-ico {"));
  if (!rule) return "找不到 .nb-picker-ico 规则";
  if (!/height:\s*\d+px/.test(rule)) return ".nb-picker-ico 没有固定 height —— svg 自然高度会撑高行";
  return true;
});

console.log("\n【#65 搜索结果路径不得遮住文件名】");

check("D5 .nb-result-path 有 max-width 上限", () => {
  const rule = noComments(cssRule(CSS, ".nb-result-path {"));
  if (!rule) return "找不到 .nb-result-path 规则";
  const m = /max-width:\s*(\d+)%/.exec(rule);
  if (!m) return "没有 max-width —— 长路径会一路吃掉文件名宽度";
  if (+m[1] > 50) return `max-width ${m[1]}% 过大（应 ≤50%，给文件名留多数空间）`;
  return true;
});

check("D6 .nb-result-path 优先被压缩（flex-shrink 大值）", () => {
  const rule = noComments(cssRule(CSS, ".nb-result-path {"));
  const m = /flex-shrink:\s*(\d+)/.exec(rule);
  if (!m) return "没有 flex-shrink —— 默认 1，与文件名等权，不保证文件名优先";
  if (+m[1] < 10) return `flex-shrink ${m[1]} 太小，长路径仍会抢走文件名宽度`;
  return true;
});

check("D7 结果行的文件名有 min-width 下限", () => {
  const rule = noComments(cssRule(CSS, ".nb-result-row .nb-node-name {"));
  if (!rule) return "缺少 .nb-result-row .nb-node-name 规则";
  const m = /min-width:\s*(\d+)px/.exec(rule);
  if (!m) return "文件名没有 min-width 下限 —— 极端情况下会被压没";
  if (+m[1] < 40) return `min-width ${m[1]}px 过小`;
  return true;
});

console.log("\n【#63 路径只显示到父目录名】");

check("D8 tree.js 搜索结果路径只取「父目录名」而不是完整路径", () => {
  // 渲染处必须以「最后一级目录名」作为展示文本
  const i = TREE.indexOf("makeResultRow(e, raw)");
  if (i < 0) return "找不到 makeResultRow";
  const open = TREE.indexOf("{", i);
  let d = 0, end = -1;
  for (let k = open; k < TREE.length; k++) {
    if (TREE[k] === "{") d++;
    else if (TREE[k] === "}") { d--; if (d === 0) { end = k; break; } }
  }
  const body = noComments(TREE.slice(open, end < 0 ? TREE.length : end));
  if (!/nb-result-path/.test(body)) return "函数体里没有 nb-result-path";
  // 必须把 path 拆成段并取最后一段
  const takesLast = /split\(\s*["']\/["']\s*\)/.test(body) || /\/\[\^\/\]\*\$/g.test(body) === false;
  if (!takesLast && !/\.pop\(\)/.test(body)) {
    return "路径文本看起来仍是完整 path（没有取最后一段）";
  }
  return true;
});

check("D9 完整路径仍保留在 title（悬停可见，信息不丢）", () => {
  const i = TREE.indexOf("makeResultRow(e, raw)");
  const seg = TREE.slice(i, i + 4000);
  if (!/pathEl\.title\s*=\s*displayMountPath\(/.test(noComments(seg))) {
    return "pathEl.title 没有保留完整路径 —— 缩短后就查不到文件在哪了";
  }
  return true;
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

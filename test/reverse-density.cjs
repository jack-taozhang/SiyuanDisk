/* ==========================================================================
 * UI 密度 · 反向注入（#63 / #64 / #65）
 * --------------------------------------------------------------------------
 * 规矩：**恒真等于没有断言**。
 * verify-density.cjs 里每条契约都要有一个注入点把它搞红。
 *
 * ★ 极性说明（踩过，务必看清）★
 *   判据约定：返回 true = 绿；返回**字符串** = 红（字符串即原因）。
 *   ⇒「注入后应变红」= `verdict !== true`。
 *   我第一版把极性写反，害得 7 条注入全报"没变红"（其实全红了）。
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;

function ok(n) { console.log(`  ✅ ${n}`); pass++; }
function bad(n, d) { console.log(`  ❌ ${n}\n       ${d}`); fail++; }
function expectRed(n, v) {
  if (v !== true) ok(`${n} → 已变红（${v}）`);
  else bad(n, "注入后判据仍是绿的 —— 该断言是常绿的，等于没测");
}
function expectGreen(n, v) {
  if (v === true) ok(n); else bad(n, `基线应为绿，实测红了：${v}`);
}

const CSS = fs.readFileSync(path.join(ROOT, "index.css"), "utf8");
const INDEX_JS = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const TREE = fs.readFileSync(path.join(ROOT, "src", "tree.js"), "utf8");

const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
function cssRule(src, selector) {
  const i = src.indexOf(selector);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  const close = src.indexOf("}", open);
  if (open < 0 || close < 0) return "";
  return src.slice(open + 1, close);
}
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  if (open < 0) return "";
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(open, k + 1); }
  }
  return src.slice(open);
}

/* ------------------------------- 判据 ------------------------------- */
const judge = {
  d1(css) {
    const rule = noComments(cssRule(css, ".nb-picker-row {"));
    if (!rule) return "找不到规则";
    const pad = /padding:\s*(\d+)px\s+(\d+)px/.exec(rule);
    const lh = /line-height:\s*(\d+)px/.exec(rule);
    if (!pad || !lh) return "行高不可控";
    const t = (+pad[1]) * 2 + (+lh[1]);
    return t > 24 ? `行高 ${t}px > 24` : true;
  },
  d2(css) {
    const m = /font-size:\s*(\d+)px/.exec(noComments(cssRule(css, ".nb-picker {")));
    if (!m) return "没设 font-size";
    return +m[1] > 12 ? `font-size ${m[1]}px` : true;
  },
  d3(js) {
    const i = js.indexOf("选择要嵌入的目录");
    if (i < 0) return "找不到 Dialog";
    const w = /width:\s*"(\d+)px"/.exec(js.slice(i, i + 500));
    if (!w) return "没设 width";
    return +w[1] >= 640 ? `width ${w[1]}px` : true;
  },
  d4(css) {
    const rule = noComments(cssRule(css, ".nb-picker-ico {"));
    if (!rule) return "找不到规则";
    return /height:\s*\d+px/.test(rule) ? true : "没固定 height";
  },
  d5(css) {
    const rule = noComments(cssRule(css, ".nb-result-path {"));
    if (!rule) return "找不到规则";
    const m = /max-width:\s*(\d+)%/.exec(rule);
    if (!m) return "没有 max-width";
    return +m[1] > 50 ? `max-width ${m[1]}%` : true;
  },
  d6(css) {
    const rule = noComments(cssRule(css, ".nb-result-path {"));
    const m = /flex-shrink:\s*(\d+)/.exec(rule);
    if (!m) return "没有 flex-shrink";
    return +m[1] < 10 ? `flex-shrink ${m[1]}` : true;
  },
  d7(css) {
    const rule = noComments(cssRule(css, ".nb-result-row .nb-node-name {"));
    if (!rule) return "缺规则";
    const m = /min-width:\s*(\d+)px/.exec(rule);
    if (!m) return "没有 min-width";
    return +m[1] < 40 ? `min-width ${m[1]}px` : true;
  },
  d8(tree) {
    const body = noComments(fnBody(tree, "makeResultRow(e, raw)"));
    if (!body) return "找不到 makeResultRow";
    if (!/nb-result-path/.test(body)) return "函数体里没有 nb-result-path";
    if (!/split\(\s*["']\/["']\s*\)/.test(body)) return "没有按 / 拆段（仍是完整路径）";
    return true;
  },
  d9(tree) {
    const seg = noComments(TREE_TAIL(tree));
    return /pathEl\.title\s*=\s*displayMountPath\(/.test(seg) ? true : "title 没保留完整路径";
  },
};
function TREE_TAIL(tree) {
  const i = tree.indexOf("makeResultRow(e, raw)");
  return tree.slice(i, i + 4000);
}

/* ------------------------------- 基线 ------------------------------- */
console.log("\n【基线】当前源码应全绿");
expectGreen("BASE-1 行高 ≤24px", judge.d1(CSS));
expectGreen("BASE-2 font-size ≤12", judge.d2(CSS));
expectGreen("BASE-3 Dialog width <640", judge.d3(INDEX_JS));
expectGreen("BASE-4 图标固定高", judge.d4(CSS));
expectGreen("BASE-5 path 有 max-width", judge.d5(CSS));
expectGreen("BASE-6 path 优先压缩", judge.d6(CSS));
expectGreen("BASE-7 文件名有 min-width", judge.d7(CSS));
expectGreen("BASE-8 只取父目录名", judge.d8(TREE));
expectGreen("BASE-9 title 保留全路径", judge.d9(TREE));

/* ------------------------------ 注入点 ------------------------------ */
console.log("\n【INJ】逐个注入，对应判据必须变红");

// INJ-D1：把行高改回 padding 5px + line-height 24px ⇒ 34px，D1 红
{
  /*
   * ★ 用正则而不是写死换行 ★
   *   踩过：写脚本落盘时，字符串里的换行转义变成了**字面量反斜杠+n**，
   *   于是带换行的长串永远匹配不到真实 CSS ⇒ 报「注入未生效」，
   *   看起来像"注入无效"，其实是**注入文本本身错了**。
   *   ⇒ 一律用正则跨行匹配，不依赖换行形态。
   *   （注：这条注释里刻意不写出 星号-斜杠 序列，否则会提前结束块注释。）
   */
  const out = CSS.replace(
    /(\.nb-picker-row\s*\{[\s\S]*?)padding:\s*2px\s+10px;\s*line-height:\s*20px;/,
    "$1padding: 5px 12px; line-height: 24px;"
  );
  if (out === CSS) bad("INJ-D1 注入未生效", "没匹配到 .nb-picker-row 的 padding/line-height 组合");
  else expectRed("INJ-D1 行高改回 34px", judge.d1(out));
}

// INJ-D2：font-size 改回 13px ⇒ D2 红
{
  const out = CSS.replace(
    /(\.nb-picker\s*\{[\s\S]*?)font-size:\s*12px;/,
    "$1font-size: 13px;"
  );
  if (out === CSS) bad("INJ-D2 注入未生效", "没匹配到 .nb-picker 的 font-size");
  else expectRed("INJ-D2 font-size 改回 13px", judge.d2(out));
}

// INJ-D3：Dialog 宽度改回 640px ⇒ D3 红
{
  const out = INDEX_JS.replace(
    /(选择要嵌入的目录[\s\S]{0,400}?)width:\s*"520px",\s*height:\s*"500px",/,
    '$1width: "640px", height: "560px",'
  );
  if (out === INDEX_JS) bad("INJ-D3 注入未生效", "没匹配到 picker 的 width/height 组合");
  else expectRed("INJ-D3 Dialog 宽度改回 640px", judge.d3(out));
}

// INJ-D4：删掉 .nb-picker-ico 的 height ⇒ D4 红
{
  const out = CSS.replace(
    /(\.nb-picker-ico\s*\{[\s\S]*?)height:\s*16px;/,
    "$1"
  );
  if (out === CSS) bad("INJ-D4 注入未生效", "没匹配到 .nb-picker-ico 的 height");
  else expectRed("INJ-D4 图标高度无约束", judge.d4(out));
}

// INJ-D5：把 max-width 改到 80% ⇒ D5 红
{
  const out = CSS.replace(/max-width:\s*42%;\s*flex-shrink:\s*999;/, "max-width: 80%; flex-shrink: 999;");
  if (out === CSS) bad("INJ-D5 注入未生效", "没匹配到 max-width: 42%");
  else expectRed("INJ-D5 path max-width 放到 80%", judge.d5(out));
}

// INJ-D6：flex-shrink 改回 1 ⇒ D6 红
{
  const out = CSS.replace(/max-width:\s*42%;\s*flex-shrink:\s*999;/, "max-width: 42%; flex-shrink: 1;");
  if (out === CSS) bad("INJ-D6 注入未生效", "没匹配到 flex-shrink: 999");
  else expectRed("INJ-D6 flex-shrink 改回 1", judge.d6(out));
}

// INJ-D7：删掉文件名的 min-width ⇒ D7 红
{
  const out = CSS.replace(
    /\.nb-result-row\s+\.nb-node-name\s*\{\s*min-width:\s*56px;\s*\}/,
    ".nb-result-row .nb-node-name { }"
  );
  if (out === CSS) bad("INJ-D7 注入未生效", "没匹配到 .nb-result-row .nb-node-name 规则");
  else expectRed("INJ-D7 文件名无 min-width", judge.d7(out));
}

// INJ-D8：路径改回完整路径（不再按 / 拆段）⇒ D8 红
{
  const out = TREE.replace(
    /const segs = String\(e\.path \|\| ""\)\.split\("\/"\)\.filter\(Boolean\);/,
    'const segs = [String(e.path || "")];'
  );
  if (out === TREE) bad("INJ-D8 注入未生效", "没匹配到 segs 的 split 行");
  else expectRed("INJ-D8 不再按 / 拆段（回到完整路径）", judge.d8(out));
}

// INJ-D9：把 title 的完整路径去掉 ⇒ D9 红
{
  const out = TREE.replace(
    /pathEl\.title = displayMountPath\(this\.currentMount, e\.path\);/,
    "pathEl.title = pathEl.textContent;"
  );
  if (out === TREE) bad("INJ-D9 注入未生效", "没匹配到 pathEl.title 赋值");
  else expectRed("INJ-D9 title 不再保留完整路径", judge.d9(out));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

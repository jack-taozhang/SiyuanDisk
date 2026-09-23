/* reverse-drag.cjs — 任务30/#54/#55 的**反向测试**
 *
 * ★ 为什么必须有它 ★
 *   本仓库的硬规矩：**永远为真的断言 = 没有断言**。
 *   verify-drag-insert.cjs 里的每条断言，都必须有一个"注入"能让它变红。
 *   做法：把 src 文本改坏 → 用**同一套** regex/逻辑重跑 → 必须失败。
 *   如果注入之后仍然通过，那条断言就是在骗人。
 *
 * 注入清单：
 *   INJ-1  makeGridCell 的 attachEmbedDrag 调用删掉            → #5 变红
 *   INJ-2  makeResultRow 的调用删掉                            → #4 变红
 *   INJ-3  attachEmbedDrag 里给文件夹也 draggable=true          → #8 变红
 *   INJ-4  文件夹分支改成 payloadFor 也照写 MIME                → #9 变红
 *   INJ-5  displayCrumbPath 的根目录分支改成返回 `${m}:/`        → #10/#11 变红
 *   INJ-6  网格面包屑改回 displayMountPath                      → #12 变红（产物级）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TREE = fs.readFileSync(path.join(ROOT, "src/tree.js"), "utf8");
const API = fs.readFileSync(path.join(ROOT, "src/api.js"), "utf8");

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n       " + e.message); fail++; }
};

/* 与 verify-drag-insert.cjs 同源的判定逻辑（抽成纯函数，便于对"注入后的文本"重跑） */
function judge(src) {
  const r = {};
  r.hasMethod = /attachEmbedDrag\s*\(\s*el\s*,\s*entry\s*\)/.test(src);
  // 三处调用
  //   ★ 注意：`row` 这个形参名被 makeNode（row, entry）和 makeResultRow（row, {...}）
  //     共用，所以判据要靠**第二个实参的形状**区分：
  //       makeNode      → this.attachEmbedDrag(row, entry);
  //       makeResultRow → this.attachEmbedDrag(row, { path: …, isDir: … });
  r.gridCall = /this\.attachEmbedDrag\s*\(\s*cell\s*,/.test(src);
  r.resultCall = /this\.attachEmbedDrag\s*\(\s*row\s*,\s*\{/.test(src);
  // 文件夹闸门：必须存在 `if (entry && entry.isDir)` 之后 return 的分支
  r.dirGuard = /if\s*\(\s*entry\s*&&\s*entry\.isDir\s*\)\s*\{[\s\S]*?return el;/.test(src);
  // 文件夹分支里不该出现 setData
  const dirBlock = (/if\s*\(\s*entry\s*&&\s*entry\.isDir\s*\)\s*\{([\s\S]*?)return el;/.exec(src) || [])[1] || "";
  r.dirNoSetData = dirBlock.length > 0 && !/setData/.test(dirBlock);
  // 网格面包屑必须用 displayCrumbPath
  r.crumbUsesCrumb = /crumb\.textContent\s*=\s*displayCrumbPath\s*\(/.test(src);
  return r;
}

function judgeApi(src) {
  const r = {};
  r.hasCrumbFn = /export function displayCrumbPath/.test(src);
  // 根目录分支必须"只返回盘名"，不能拼冒号
  const body = (/export function displayCrumbPath[\s\S]*?\n\}/.exec(src) || [])[0] || "";
  r.rootNoColon = /if\s*\(\s*!segs\.length\s*\)\s*return\s+m\s*;/.test(body);
  r.joinSlash = /\[m,\s*\.\.\.segs\]\.join\(\s*"\s*\/\s*"\s*\)/.test(body.replace(/'/g, '"'));
  return r;
}

console.log("【任务30/#54/#55 反向注入】");
console.log("—— 基线：未注入时应全绿 ——");

check("BASE-1 基线判定全绿（否则注入结论不可信）", () => {
  const a = judge(TREE), b = judgeApi(API);
  const bad = Object.entries({ ...a, ...b }).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) throw new Error("基线就有假项：" + bad.join(", "));
});

check("INJ-1 删掉 makeGridCell 的 attachEmbedDrag → gridCall 判定变红", () => {
  const t = TREE.replace(/this\.attachEmbedDrag\s*\(\s*cell\s*,[\s\S]*?\);\s*\n/, "/* removed grid wiring */\n");
  if (t === TREE) throw new Error("注入没生效 —— 找不到要替换的调用点（是不是改过写法？）");
  if (judge(t).gridCall) throw new Error("★ 注入后 gridCall 仍为真 —— 这条断言是假的（永远绿）");
});

check("INJ-2 删掉 makeResultRow 的 attachEmbedDrag → resultCall 判定变红", () => {
  // ★ 只能删**搜索结果**那一处（row, {...}）。makeNode 那处是 (row, entry)，
  //   两者形参名相同，所以必须用带 { 的模式区分，否则会误删错的、留下对的。
  const t = TREE.replace(/this\.attachEmbedDrag\s*\(\s*row\s*,\s*\{[\s\S]*?\}\);\s*\n/, "/* removed result wiring */\n");
  if (t === TREE) throw new Error("注入没生效 —— 找不到 makeResultRow 的调用点");
  if (judge(t).resultCall) throw new Error("★ 注入后 resultCall 仍为真 —— 断言是假的");
  // 反向自检：makeNode 那处必须**仍然在**（证明我们只删了搜索结果那处）
  if (!/this\.attachEmbedDrag\s*\(\s*row\s*,\s*entry\s*\)/.test(t)) {
    throw new Error("★ 注入误删了 makeNode 那处 —— 判据不够精确");
  }
});

check("INJ-3 让文件夹也 draggable → dirGuard 判定变红", () => {
  // 把整个 dirGuard 块删掉，模拟"没有文件夹闸门"的旧实现
  const t = TREE.replace(/if\s*\(\s*entry\s*&&\s*entry\.isDir\s*\)\s*\{[\s\S]*?return el;\s*\}/, "/* no folder guard */");
  if (t === TREE) throw new Error("注入没生效 —— 没找到文件夹闸门块");
  if (judge(t).dirGuard) throw new Error("★ 移除闸门后 dirGuard 仍为真 —— 断言是假的");
});

check("INJ-4 文件夹分支里写 setData → dirNoSetData 判定变红", () => {
  const t = TREE.replace(
    /(if\s*\(\s*entry\s*&&\s*entry\.isDir\s*\)\s*\{)/,
    "$1\n      el.ondragstart = (ev) => { ev.dataTransfer.setData('application/x-nebuladisk-embed', '{}'); };"
  );
  if (t === TREE) throw new Error("注入没生效");
  if (judge(t).dirNoSetData) throw new Error("★ 文件夹分支写了 setData，dirNoSetData 仍为真 —— 断言是假的");
});

check("INJ-5 displayCrumbPath 根目录改回拼冒号 → rootNoColon 判定变红", () => {
  const t = API.replace(
    /if\s*\(\s*!segs\.length\s*\)\s*return\s+m\s*;/,
    'if (!segs.length) return m + ":/";'
  );
  if (t === API) throw new Error("注入没生效 —— 没找到根目录分支");
  if (judgeApi(t).rootNoColon) throw new Error("★ 改回拼冒号后 rootNoColon 仍为真 —— 断言是假的");
});

check("INJ-6 网格面包屑改回 displayMountPath → crumbUsesCrumb 判定变红", () => {
  const t = TREE.replace(/crumb\.textContent\s*=\s*displayCrumbPath\s*\(/, "crumb.textContent = displayMountPath(");
  if (t === TREE) throw new Error("注入没生效");
  if (judge(t).crumbUsesCrumb) throw new Error("★ 改回 displayMountPath 后仍为真 —— 断言是假的");
});

/* ---------- 产物级：dist/index.js 也必须带上这些改动 ---------- */
const DIST = path.join(ROOT, "dist/index.js");
if (fs.existsSync(DIST)) {
  const raw = fs.readFileSync(DIST, "utf8");
  const dist = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  console.log("—— 产物级（dist/index.js）——");
  check("DIST-1 ★ 产物里必须出现 attachEmbedDrag（#56 的根因就是产物没带上它）", () => {
    if (!/attachEmbedDrag/.test(dist)) throw new Error("dist 里没有 attachEmbedDrag —— 任务30 没被构建进去");
  });
  check("DIST-2 产物里必须出现 displayCrumbPath（#54）", () => {
    if (!/displayCrumbPath/.test(dist)) throw new Error("dist 里没有 displayCrumbPath");
  });
  check("DIST-3 ★ 反向：若产物里 attachEmbedDrag 被抹掉，DIST-1 判定必须变红", () => {
    const broken = dist.replace(/attachEmbedDrag/g, "XXXremovedXXX");
    if (/attachEmbedDrag/.test(broken)) throw new Error("抹掉后仍匹配 —— DIST-1 是假断言");
  });
} else {
  console.log("—— 产物级：dist/index.js 不存在，跳过（先跑 node tools/build.js --repo）——");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

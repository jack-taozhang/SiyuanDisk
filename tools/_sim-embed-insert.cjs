/* ==========================================================================
 * 嵌入块「插入通道」契约测试
 * --------------------------------------------------------------------------
 * 背景（2026-09-22 NAS 实测）：
 *   · protyle.insert(md) 在浏览器前端会把 `;;;` 围栏存成**普通段落(type=p)**
 *     ⇒ 笔记里显示裸 JSON。这是「本地能看、NAS 前端不行」的真正原因。
 *   · 内核 API /api/block/insertBlock {dataType:"markdown"} 则正确生成
 *     type=custom + data-info。
 *
 * 本测试不连网，只做静态契约校验：
 *   ① bundle 里 pickAndEmbed 不再直接调 protyle.insert（只保留兜底）
 *   ② bundle 里有 insertEmbedBlock，且它调的是 /api/block/insertBlock
 *   ③ insertEmbedBlock 里 dataType 是 markdown
 *   ④ 兜底分支存在（内核 API 失败时不至于什么都不插）
 *   ⑤ extractJson 能从 buildEmbedMarkdown 产物里抠出 JSON
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

/*
 * ★ 2026-09-28：把硬编码的绝对路径改成基于 __dirname 的解析。
 *   原写法是 D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/…，
 *   而本机真实路径是 D:/Docker/Siyuan/data/plugins/siyuan-nebuladisk/ ——
 *   那个 SiYuanDisk 目录**根本不存在**，于是本文件后面的 readFileSync
 *   直接抛 ENOENT 崩掉，整个套件从未真正跑通过
 *   （实测：改成相对路径后才有正常输出）。
 *   用 __dirname 后，仓库换位置/换机器都不用再改。
 *
 * ⚠️ 顺序有讲究：`path` 的 require 必须在 PLUGIN 之前。
 *    第一版把它插在了 `const fs = require("fs")` 正下方 ——
 *    `node --check` 语法检查能过（const 提升），但运行时立刻
 *    ReferenceError: Cannot access 'path' before initialization。
 *    语法通过 ≠ 能运行，这类错必须真跑一次才会现形。
 */
const PLUGIN = path.resolve(__dirname, "..");

const BUNDLE = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js";
const src = fs.readFileSync(BUNDLE, "utf8");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

console.log(`测试目标 bundle: ${BUNDLE}  (${src.length} bytes)\n`);

console.log("【A】插入必须走内核 API，而不是前端 protyle.insert");
ok(src.includes("/api/block/insertBlock"), "bundle 里有 /api/block/insertBlock 调用");
ok(/insertEmbedIntoDoc/.test(src), "bundle 里有 insertEmbedIntoDoc（唯一插入通道）");

// pickAndEmbed 体内：主路径必须是 insertEmbedIntoDoc
// 注意：`pickAndEmbed` 这个名字会先作为「斜杠菜单回调」出现，必须锚定到
// 方法定义（`async pickAndEmbed(`）之后再取窗口，否则会切到错误的位置。
const pi = src.indexOf("async pickAndEmbed(");
const piBody = pi >= 0 ? src.slice(pi, pi + 3000) : "";
ok(pi >= 0, "找到 pickAndEmbed 方法定义");
ok(piBody.includes("insertEmbedIntoDoc"), "pickAndEmbed 主路径调用 insertEmbedIntoDoc");
ok(
  /insertEmbedIntoDoc\(this,\s*protyle,\s*spec/.test(piBody),
  "pickAndEmbed 把 plugin+protyle+spec 交给 insertEmbedIntoDoc"
);
// protyle.insert 只能出现在 catch 兜底里
const fallbackIdx = piBody.indexOf("protyle.insert(");
ok(
  fallbackIdx < 0,
  "pickAndEmbed 里不再直接写 protyle.insert（兜底已下沉到 embed.js）"
);

console.log("\n【B】insertEmbedIntoDoc 的实现契约（在 bundle 里）");
const ii = src.indexOf("async function insertEmbedIntoDoc");
const iiBody = ii >= 0 ? src.slice(ii, ii + 4200) : "";
ok(ii >= 0, "找到 insertEmbedIntoDoc");
ok(/dataType:\s*["']markdown["']/.test(iiBody), 'dataType 用 markdown（内核会用 lute 完整解析）');
ok(iiBody.includes("parentID"), "带 parentID");
ok(iiBody.includes("previousID"), "带 previousID（插在光标块之后）");
ok(iiBody.includes("locateInsertPoint"), "调 locateInsertPoint 定位");
ok(/BOXED_TYPES/.test(iiBody) || /BOXED_TYPES/.test(src), "容器块（列表/引用等）有往上一层处理");
ok(iiBody.includes("code !== 0"), "检查内核返回 code");
ok(/verifyCustomBlock|kb\(\s*["']\/api\/query\/sql/.test(iiBody) ||
   /verifyCustomBlock/.test(src), "插入后回查块类型做自校验");
ok(iiBody.includes("repairFenceBlock"), "类型不对时走重建路径兜底");
// ★ 2026-09-22 反转：前端 protyle.insert 兜底必须**移除** ★
//   实测证明它只会产出 type=p 的字面围栏段落（= 用户看到的裸 JSON），
//   而且失败是静默的 —— 用户以为插好了，其实插了个坏块。
//   ⇒ 这条断言从「必须有兜底」改成「必须没有前端兜底」。
ok(!iiBody.includes("typeof protyle.insert"),
   "内核失败时不再退回前端 protyle.insert（它会静默产出裸 JSON 坏块）");
ok(iiBody.includes("return false"),
   "内核失败时明确返回 false（失败要吵闹，不要静默写坏块）");
ok(iiBody.includes("verifyCustomBlock"),
   "插入后用 verifyCustomBlock 做三态校验（custom/not-custom/unknown）");
ok(/verdict\s*===\s*"not-custom"/.test(iiBody),
   "只有「明确不是 custom」才触发重建，避免把索引延迟误判成坏块");

console.log("\n【B2】locateInsertPoint 的定位逻辑");
const li = src.indexOf("function locateInsertPoint");
// ★ 窗口必须覆盖整个函数体，别再写死小数字 ★
//   locateInsertPoint 现在多级回退很长（实测 ~14.5k 字符），
//   之前用 2600/5200/9000 都出现过「后面的断言明明该过却报错」的假失败。
const liNext = src.indexOf("\nfunction ", li + 30);
const liBody = li >= 0 ? src.slice(li, liNext > li ? liNext : li + 20000) : "";
ok(li >= 0, "找到 locateInsertPoint");
ok(liBody.includes("protyle.block"), "从 protyle.block 取光标/文档信息");
ok(liBody.includes("protyle-wysiwyg--select"), "兜底从 DOM 取当前选中块");
ok(liBody.includes("BOXED_TYPES"), "容器块上移一层");
// ★★ 2026-09-22 在真实环境实测确定的路径 ★★
//   之前几版全错：_protyle / --focus / data-initdata / layout.children 都不存在。
//   真机 dump 出来的可用路径只有下面这两条（+ layout.centerLayout 下钻）。
ok(liBody.includes("dataset.nodeId") && liBody.includes(".protyle"),
   "★ 纯 DOM：读 .protyle 的 data-node-id（实测唯一不依赖内部对象的路径）");
ok(liBody.includes("backStack"),
   "★ siyuan.backStack[0].protyle.block.rootID（最近文档栈＝预览页抢焦点场景的正解）");
ok(liBody.includes("centerLayout"),
   "layout.centerLayout 下钻兜底（实测 layout 上没有 children）");
ok(!liBody.includes("allProtylesFromLayout"),
   "已删除基于错误 layout 假设的 allProtylesFromLayout（siyuan.layout 根本没有 children）");
// 反证：以下路径在真机上**都被证伪**，不应再出现在活代码里。
{
  const live = liBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok(!/lastActiveTab/.test(live),
     "反证：lastActiveTab 不存在于思源（main.js 里 0 命中）");
  ok(!/_protyle/.test(live),
     "反证：.protyle 元素上没有 _protyle 属性（真机实测为空）");
  ok(!/data-initdata/.test(live),
     "反证：页签的 data-initdata 实测是空对象 {}，不能用");
  ok(!/ul\.layout-tab-bar/.test(live),
     "反证：聚焦页签的 data-id 是 UUID，不是思源块 id，不能用");
}
ok(/src\s*=\s*"/.test(liBody), "记录命中的定位来源（src），便于排查");
ok(liBody.includes("dbg"), "输出逐级回退的调试轨迹");

console.log("\n【B3】失败必须吵闹且具体（不能只说「查看控制台日志」）");
ok(!/return false;\s*\/\/\s*★ 不再退回前端插入/.test(src),
   "内核失败时不再 return false 静默吞掉");
ok(iiBody.includes("throw err") || /throw new Error\(\(e && e\.message\)/.test(iiBody),
   "内核失败时把原因 throw 出去，让调用方显示具体原因");
ok(/找不到要插入的文档/.test(src),
   "定位失败时给出可自助的中文提示（而不是「请查看控制台日志」）");
for (const [label, p] of [["index.js", path.join(PLUGIN, "index.js")],
                          ["src/viewer.js", path.join(PLUGIN, "src/viewer.js")],
                          ["src/tree.js", path.join(PLUGIN, "src/tree.js")]]) {
  const t = fs.readFileSync(p, "utf8");
  ok(!/请查看控制台日志/.test(t), `${label} 不再出现无用的「请查看控制台日志」`);
  ok(/e && e\.message/.test(t), `${label} catch 里显示 e.message`);
}

console.log("\n【B4】★ 三处「嵌入」插入点都不得「拿不到编辑器就提前 return」★");
console.log("（2026-09-22 真根因：前置拦截把多级回退整个跳过了）");
{
  // 注意：只检查「嵌入」相关函数体。tree.js 里还有一个 insertLinkToDoc()
  // （插入普通链接，走 editor.insert），那个功能**确实**需要活动编辑器，
  // 保留它的判空是合理的，不能一起扫。
  const cases = [
    ["index.js  pickAndEmbed",
     path.join(PLUGIN, "index.js"),
     /async pickAndEmbed\([\s\S]*?\n  \}/],
    ["tree.js   embedToDoc",
     path.join(PLUGIN, "src/tree.js"),
     /embedToDoc\(entry, kind\) \{[\s\S]*?\n  \}/],
    ["viewer.js embedToDoc",
     path.join(PLUGIN, "src/viewer.js"),
     /embedToDoc\(\) \{[\s\S]*?\n  \}/],
  ];
  for (const [label, p, re] of cases) {
    const t = fs.readFileSync(p, "utf8");
    const m = t.match(re);
    ok(!!m, `找到 ${label} 函数体`);
    if (!m) continue;
    // 只扫活代码：先剥注释，否则说明文字里的示例会被误判
    const body = m[0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // ★ 只针对「编辑器」判空：protyle / editor。
    //   保留 `if (!plugin) return` 是**正确**的（插件没就绪本来就没法插），
    //   不能把它一起判死。
    ok(!/if\s*\(!?(?:protyle|editor)\)\s*\{[\s\S]{0,140}?return;/.test(body),
       `${label} 不再因「拿不到编辑器」提前 return（否则定位回退跑不到）`);
    ok(/e && e\.message/.test(body), `${label} catch 里显示 e.message`);
    ok(/e\.trace/.test(body), `${label} 失败时输出定位轨迹 e.trace`);
    ok(/insertEmbedIntoDoc/.test(body), `${label} 走唯一插入通道`);
  }
}

console.log("\n【C】extractJson 能从嵌入块 markdown 抠出 JSON");
const ei = src.indexOf("function extractJson");
ok(ei >= 0, "找到 extractJson");
// 复刻一份逻辑做行为验证
function extractJson(md) {
  const lines = String(md || "").split(/\r?\n/);
  const body = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === ";;;") break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}
const md = ';;;siyuan-nebuladisk/nebuladisk\n{"kind":"tree","mount":"售前项目","path":"/a"}\n;;;\n';
const got = extractJson(md);
let parsed = null;
try { parsed = JSON.parse(got); } catch {}
ok(parsed && parsed.mount === "售前项目", "extractJson 抠出的 JSON 可解析且 mount 正确");
ok(parsed && parsed.kind === "tree", "kind 正确");
ok(got.indexOf(";;;") < 0, "抠出的内容不含围栏标记");

console.log("\n【D】★★★ 三处插入点必须全部收敛到唯一通道 ★★★");
// 背景：历史上插入点散落三处，修了两处漏一处（用户点的正是漏的那处）。
// 这里逐个静态确认：① 都调 insertEmbedIntoDoc ② 都没有反引号围栏 ③ 没有裸前端 insert
const srcFiles = {
  "index.js": path.join(PLUGIN, "index.js"),
  "src/tree.js": path.join(PLUGIN, "src/tree.js"),
  "src/viewer.js": path.join(PLUGIN, "src/viewer.js"),
};
const bodies = {};
for (const [label, p] of Object.entries(srcFiles)) {
  let t = "";
  try { t = fs.readFileSync(p, "utf8"); } catch { t = ""; }
  bodies[label] = t;
  ok(t.length > 0, `${label} 可读`);
}

// ① 三处都被调用
ok(bodies["index.js"].includes("insertEmbedIntoDoc(this, protyle, spec"),
   "index.js pickAndEmbed 调 insertEmbedIntoDoc");
ok(bodies["src/tree.js"].includes("insertEmbedIntoDoc(this.plugin, editor"),
   "tree.js embedToDoc 调 insertEmbedIntoDoc");
ok(bodies["src/viewer.js"].includes("insertEmbedIntoDoc(plugin, protyle"),
   "viewer.js embedToDoc 调 insertEmbedIntoDoc（← 用户实际点的按钮）");

// ② 没有任何活代码用反引号围栏
for (const [label, t] of Object.entries(bodies)) {
  // 去掉注释行后再找（注释里提历史 bug 是允许的）
  const noComment = t.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const live = noComment.includes("```nebuladisk");
  ok(!live, `${label} 活代码里没有反引号围栏`);
}

// ③ viewer.js 不再把整个 data 手工 JSON.stringify 后插入
ok(!/protyle\.insert\("```/.test(bodies["src/viewer.js"]),
   "viewer.js 不再用 protyle.insert + 反引号");

// ④ 唯一通道的实现存在且用内核 API
const emb = fs.readFileSync(path.join(PLUGIN, "src/embed.js"), "utf8");
ok(emb.includes("export async function insertEmbedIntoDoc"), "embed.js 导出 insertEmbedIntoDoc");
ok(emb.includes("export async function repairFenceBlock"), "embed.js 导出 repairFenceBlock");
ok(/\/api\/block\/insertBlock/.test(emb), "insertEmbedIntoDoc 走内核 insertBlock");
ok(/dataType:\s*"markdown"/.test(emb), "用 markdown 模式");
ok(emb.includes("BOXED_TYPES"), "容器块类型表存在（列表/引用等要上移）");

/* ==========================================================================
 * 【H】需求 ④：文件树 → 正文 拖拽插入
 *
 * 用户原话：「增加可以从 右侧文件树 拖拽的方式插入」。
 *
 * 这一组把 HTML5 DnD 的**三个致命易错点**焊进测试（任何一个错都会表现为
 * 「拖了没反应，控制台连日志都没有」，是最难自查的一类）：
 *   1. dragover 里必须 preventDefault，否则 drop 永不触发
 *   2. 必须 setData 至少一种类型，否则部分浏览器不触发 dragstart
 *   3. 监听必须挂在 document 上（正文与文件树是相邻的两个 DOM 子树）
 * ========================================================================== */
console.log("\n【H】文件树拖拽插入（需求 ④）");
const tree = fs.readFileSync(path.join(PLUGIN, "src/tree.js"), "utf8");
// ★ 剥注释版本：下面 H1e' 是**反向**断言（"makeGridCell 已不存在"），
//   不剥注释会命中说明注释里的 "makeGridCell" 而假红（实测踩到过一次）。
const treeNC = tree
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

// ★ H1：任务30 把这段接线从 makeNode 搬进了 attachEmbedDrag()（唯一实现）。
//   所以不能再断言 `row.draggable = true` —— 那个字面量已经不在源码里了。
//   改断「能力仍在，且是多处共用的唯一实现」：
//     · attachEmbedDrag() 里设置 el.draggable = true
//     · 且 makeNode / makeResultRow 两处都调用它
//   （更完整的行为断言见 test/verify-drag-insert.cjs —— 那套会真跑 DOM）
//
//   ★ 2026-09-28：`makeGridCell` 这一处调用点**已随网格视图一起删除** ★
//     用户要求「去掉文件夹 网格视图方式，同时去掉这个按钮」，
//     makeGridCell() 整个函数不存在了，原来的 H1e 断言
//     （`this.attachEmbedDrag(cell, ...)`）随之删除。
//     ⚠️ 注意：拖拽能力**没有减少** —— 树节点 + 搜索结果两条链路完好。
ok(/attachEmbedDrag\s*\(\s*el\s*,\s*entry\s*\)/.test(tree),
   "H1：存在 attachEmbedDrag() 唯一实现（任务30：不再是 makeNode 内联一份）");
ok(/el\.draggable\s*=\s*true/.test(tree),
   "H1b：attachEmbedDrag 里把元素设为 draggable");
ok(/this\.attachEmbedDrag\s*\(\s*row\s*,\s*entry\s*\)/.test(tree),
   "H1c：makeNode（文件树）调用了 attachEmbedDrag");
ok(/this\.attachEmbedDrag\s*\(\s*row\s*,\s*\{/.test(tree),
   "H1d：makeResultRow（搜索结果）调用了 attachEmbedDrag（任务30 的原始诉求）");
ok(/makeGridCell\s*\(/.test(treeNC) === false,
   "H1e'：★ makeGridCell 已随网格视图移除（用户 2026-09-28 要求）");
// ★ #55：文件夹必须被明确排除（否则用户会把文件夹拖成嵌入块）
ok(/if\s*\(\s*entry\s*&&\s*entry\.isDir\s*\)\s*\{[\s\S]*?return el;/.test(tree),
   "H1f：★ #55 文件夹在 attachEmbedDrag 里被拦下（不再可拖）");
ok(/x-nebuladisk-embed/.test(tree), "H2：用了自定义 MIME 作为握手暗号（不误伤外部拖拽）");
ok(/setData\(\s*["']text\/plain["']/.test(tree),
   "H3：同时塞了 text/plain 保底（落点不支持自定义 MIME 时也能降级）");
ok(/bindDragDrop\s*\(\)/.test(tree), "H4：有 bindDragDrop()");
ok(/addEventListener\(\s*["']dragover["'][\s\S]{0,80},\s*true\s*\)/.test(tree),
   "H5：dragover 监听挂在 document 上（capture 阶段）");
ok(/addEventListener\(\s*["']drop["'][\s\S]{0,80},\s*true\s*\)/.test(tree),
   "H6：drop 监听挂在 document 上");
ok(/unbindDragDrop/.test(tree) && /removeEventListener/.test(tree),
   "H7：destroy 时摘掉监听（否则面板重建会叠加，拖一次插 N 个块）");

// H8：dragover 里必须 preventDefault —— 这是 HTML5 DnD 的硬约束
{
  const i = tree.indexOf("dragover");
  const seg = tree.slice(i, i + 900);
  ok(/preventDefault\s*\(\s*\)/.test(seg),
     "H8：dragover 里调了 preventDefault（不调则 drop 永不触发）");
}
{
  // drop 里也要 preventDefault，否则思源原生编辑器会再用 text/plain 插一份
  const i = tree.indexOf('this._onDrop = async');
  const seg = i >= 0 ? tree.slice(i, i + 2200) : "";
  ok(/preventDefault\s*\(\s*\)/.test(seg), "H9：drop 里也 preventDefault（防思源再插一份 text/plain）");
  ok(/stopPropagation\s*\(\s*\)/.test(seg), "H10：drop 里 stopPropagation（不让思源原生处理器也吃这个事件）");
}

// H11：落点解析必须限定在 .protyle-wysiwyg 内，否则会锚到页签头之类的非正文块
{
  // ⚠️ 必须锚到**方法定义**，而不是第一次出现的名字：
  //    · 第一次出现往往是**调用点**（resolveDropBlock(document...)）
  //    · 第二次可能是**注释里**的示例（`resolveDropBlock(el)`：）
  //    只有带 `{` 的才是定义体 —— 用这个特征精确锚定。
  const i = tree.indexOf("resolveDropBlock(el) {");
  const seg = i >= 0 ? tree.slice(i, i + 1200) : "";
  ok(/resolveDropBlock/.test(tree), "H11：有 resolveDropBlock 落点解析");
  ok(i >= 0, "H11b：能定位到 resolveDropBlock 的方法定义体");
  ok(/protyle-wysiwyg/.test(seg), "H12：落点必须落在 .protyle-wysiwyg 内才算正文块");
  ok(/data-node-id/.test(seg), "H13：落点靠 [data-node-id] 定位");
}

// H14：拖拽插入必须走唯一通道，且**不能**触发斜杠清理（拖拽没有 / 残留，清错会删正文）
{
  const i = tree.indexOf("this._onDrop = async");
  const seg = i >= 0 ? tree.slice(i, i + 2500) : "";
  ok(/insertEmbedIntoDoc/.test(seg), "H14：drop 走 insertEmbedIntoDoc 唯一通道");
  ok(/fromSlash:\s*false/.test(seg), "H15：拖拽明确 fromSlash:false（不去清正文内容）");
  ok(/anchorEl:\s*targetEl/.test(seg), "H16：把落点块作为 anchorEl 传下去（拖哪儿插哪儿）");
}

// H17：CSS 要有落点高亮，否则用户盲放
const css = fs.readFileSync(path.join(PLUGIN, "index.css"), "utf8");
ok(/\.nb-drop-target/.test(css), "H17：CSS 里有 .nb-drop-target 落点高亮");
ok(/\.nb-node\.is-dragging/.test(css), "H18：CSS 里有拖拽中的节点样式");


console.log("\n========================================================");
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log("========================================================");
process.exit(fail ? 1 : 0);

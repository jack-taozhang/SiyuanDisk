/* ==========================================================================
 * 任务⑨⑩⑫ 回归契约测试
 * --------------------------------------------------------------------------
 * 这三条都是「前端行为」类修复，单元测试拿不到 DOM，所以用**对 bundle 的静态
 * 契约断言**把它们钉住：谁把关键实现改回去了，这里立刻红。
 *
 *   ⑨ 侧边栏过滤支持扩展名 / 通配 `*.png` / 逗号分隔多值
 *   ⑩ 斜杠残留清理必须走内核 updateBlock（不是只擦 DOM）
 *   ⑫ 系统文件拖入文件树上传：识别 Files、递归 entry、readEntries 循环
 * ========================================================================== */
const fs = require("fs");

const BUNDLE = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js";
const src = fs.readFileSync(BUNDLE, "utf8");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}
const slice = (from, len = 4000) => {
  const i = src.indexOf(from);
  return i >= 0 ? src.slice(i, i + len) : "";
};

/* ★ 花括号配对切片（2026-09-23 加，任务26 踩坑后）★
 *
 *  为什么需要它：上面那个 `slice(from, len)` 用**固定字符数**截取。
 *  它有个隐蔽的失效模式 —— 只要有人往 bundle 里加了别的内容（哪怕只是注释
 *  或新测试的文件头），所有锚点后面紧跟的那些字符串就会**整体后移**，
 *  于是原先"刚好落在窗口里"的标记滑出窗口 ⇒ 断言报失败，
 *  而实现其实完全没坏。
 *
 *  真实事故：任务26 我只改了 CSS 与 embed.js，bundle 因为新增注释变长，
 *  `dataType: "markdown"` 从窗口内滑到偏移 3569（窗口 3600），
 *  ⑩ 的两条断言立刻变红 —— **是测试脆弱，不是实现回退**。
 *  这类"假红"最容易被误判成"改坏了"，所以这里换成按花括号配对取完整函数体：
 *  窗口大小由代码结构决定，不再由字符数决定。
 *
 *  ★ 注意 ★ 会先把参数列表 `(...)` 里的花括号跳过（函数体从第一个
 *    顶层 `{` 开始算），并支持字符串/模板串内的花括号不计数。
 */
function sliceBlock(from) {
  const i = src.indexOf(from);
  if (i < 0) return "";
  const bodyStart = src.indexOf("{", i);
  if (bodyStart < 0) return "";
  let depth = 0;
  let inS = null;      // 当前字符串定界符：', ", `
  let esc = false;
  for (let k = bodyStart; k < src.length; k++) {
    const c = src[k];
    if (inS) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inS = c; continue; }
    if (c === "/" && src[k + 1] === "/") {           // 行注释
      const nl = src.indexOf("\n", k);
      k = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[k + 1] === "*") {           // 块注释
      const end = src.indexOf("*/", k + 2);
      k = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return src.slice(i, Math.min(src.length, i + 4000));
}

console.log(`测试目标 bundle: ${BUNDLE}  (${src.length} bytes)\n`);

/* ---------------------------------------------------------------- 任务⑨ */
console.log("【⑨】侧边栏过滤：扩展名 / 通配 / 多值");
/*
 * ⚠️ 锚点注意：`_filterTerms(raw)` 在 bundle 里**先以调用形式出现**
 *    （`const terms = this._filterTerms(raw);`，在 applyFilter 里），
 *    定义在其后。第一版我拿 `_filterTerms(raw)` 当锚点，切片正好落在
 *    applyFilter 里，于是"通配/逗号"两条误报失败 —— 是**测试写错了**，
 *    不是实现错了。这里改成锚定**定义**形式。
 */
const ft = sliceBlock("_filterTerms(raw) {");
ok(ft.length > 0, "bundle 里有 _filterTerms（过滤词解析统一入口）");
ok(ft.includes("startsWith(\"*\")") || ft.includes("startsWith('*')"),
   "支持 `*` 前缀通配（*.png）");
ok(ft.includes(",，|") , "支持逗号/竖线分隔多值");
ok(ft.includes("toLowerCase()"), "统一转小写（大小写不敏感）");

const af = sliceBlock("applyFilter() {");
/*  ★ 任务㉑（2026-09-23）改了这里的契约，旧断言必须跟着改，否则会被"正确地"判失败 ★
 *
 *  旧实现：在前端遍历**已加载的 DOM 节点**做 filter（_filterTerms + some() + _matchHit）。
 *  为什么要废弃：文件树是**懒加载**的，没展开过的目录在 DOM 里根本不存在
 *  ⇒ 前端过滤**永远搜不全**（用户原话：「搜索需要对所有文档进行搜索，
 *    包含之前没有加载的」）。这是**结构性的**，不是调参能修的。
 *
 *  新实现：applyFilter() 改调 API.search() 打后端 /api/search（os.walk 递归全盘），
 *  结果渲染到**独立的**结果面板 .nb-tree-results 里。
 *
 *  ⚠️ 这 3 条不是"删掉断言"——是把断言**换成新的契约**，
 *     并且额外钉一条"旧的前端过滤不许回来"，防止有人"顺手改回"。
 */
ok(af.includes("API.search"), "applyFilter 调 API.search()（后端递归，才搜得到未加载的目录）");
ok(af.includes("_searchToken"), "有单调自增的比赛令牌（防抖连发时旧响应覆盖新结果）");
ok(af.includes("resultsEl"), "结果渲染到独立面板（跨层级结果硬塞进树里会破坏结构）");
//  ★ 反向断言：旧的前端匹配不许复活
ok(!af.includes("_matchHit"),
   "★ 旧的两趟 DOM 扫描已移除（它是'搜不全'的根源，别改回来）");

const fi = slice("filterInput.placeholder", 400);
ok(/扩展名|\.png|pdf/.test(fi), "输入框提示文案里写明了支持扩展名（可发现性）");

/* ---------------------------------------------------------------- 任务⑩ */
console.log("\n【⑩】斜杠残留清理：必须落库到内核");
// ★ 用 sliceBlock（花括号配对）而不是 slice(…, 固定字数) ★
//   固定窗口会随 bundle 变长而"假红"（见 sliceBlock 的说明）。
const cs = sliceBlock("async function cleanupSlashText");
ok(cs.length > 0, "cleanupSlashText 是 async（要等内核写完成）");
ok(cs.includes("/api/block/updateBlock"), "★ 走 /api/block/updateBlock 改写内核");
ok(cs.includes("dataType: \"markdown\"") || cs.includes("dataType:\"markdown\""),
   "用 markdown 形式提交（交给 lute 解析）");
ok(cs.includes("data-node-id"), "从 anchorEl 取块 id（没 id 就不动）");
ok(/contenteditable/.test(cs), "★ 读内层可编辑区，避开 protyle-attr 的零宽空格");
ok(cs.includes("<wbr>"), "★ 整块清空时写 <wbr>（空串会让思源删掉整个段落）");
ok(!/createTreeWalker\(el/.test(cs), "不再对 anchorEl 做 Range 直改（旧方案的病根）");
ok(!cs.includes("dispatchEvent"), "不再派发假 input 事件（实测一字都存不进去）");
ok(!cs.includes("m[2].length > 16"),
   "去掉「过滤词>16字就跳过」的保险丝（会误伤长关键词）");

// 调用点必须 await，否则「清完再返回」的时序不成立
ok(!/if \(fromSlash\) cleanupSlashText\(anchorEl\);/.test(src),
   "调用点已改为 await cleanupSlashText(...)");
ok(src.includes("await cleanupSlashText(anchorEl)"), "存在 await 调用点");

// 旧的事件补丁必须彻底消失
ok(!src.includes("initUIEvent(\"input\", true, false, window, 0)"),
   "抹掉旧的假 input 事件补丁");

/* ---------------------------------------------------------------- 任务⑫ */
console.log("\n【⑫】拖系统文件进文件树上传");
const ud = sliceBlock("bindUploadDrop() {");
ok(ud.length > 0, "bundle 里有 bindUploadDrop");
ok(ud.includes("Files"), "★ 用 dataTransfer.types 含 Files 识别系统文件拖拽");
ok(ud.includes("webkitGetAsEntry"), "★ 用 webkitGetAsEntry 拿 entry（dataTransfer.files 拿不到文件夹内容）");
ok(ud.includes("preventDefault"), "dragover/drop 都 preventDefault（否则不触发 drop / 浏览器会打开文件）");
ok(ud.includes("_uploading"), "有上传中标记，防重复上传同一批");

// 关键：非文件拖拽必须放行，否则会和「树→正文」的嵌入拖拽打架
ok(/if \(!isFileDrag\(ev\)\) return;/.test(ud),
   "★ 非系统文件拖拽直接放行（不与正文嵌入拖拽抢事件）");

const ce = sliceBlock("async function collectEntry");
ok(ce.length > 0, "bundle 里有 collectEntry 递归器");
ok(ce.includes("isDirectory"), "识别目录");
ok(ce.includes("readEntries"), "读目录条目");
ok(/for \(;;\)/.test(ce) || ce.includes("for(;;)"),
   "★ 循环 readEntries 直到空（一次最多 100 条，不循环会静默丢文件）");
ok(ce.includes("createReader"), "用 createReader 下钻");

const ub = slice("async function _runUploadBatch", 400) ;
const ub2 = sliceBlock("_runUploadBatch(tasks, baseDir)");
ok(ub2.includes("API.mkdir"), "上传前逐级建目录");
ok(ub2.includes("API.upload"), "调 API.upload 上传");
ok(ub2.includes("reloadDir"), "上传完刷新落点目录");
ok(ub2.includes("failed"), "收集失败清单并回报");

ok(src.includes("unbindUploadDrop"), "有 unbind（面板重建/销毁时摘监听，防叠加）");

/*
 * ★★★ 构造函数陷阱（真机才暴露，必须钉住）★★★
 *
 *   `bindUploadDrop()` 挂的是 `this.treeEl`，而 treeEl 是 render() 里才建的。
 *   第一版把它和 `bindDragDrop()` 一起写在构造函数里 ⇒ `new FileTree()` 直接抛
 *     TypeError: Cannot read properties of undefined (reading 'addEventListener')
 *   ⇒ **整个侧边栏起不来**。单元测试当时全绿（没有真 DOM、也没真的 new）。
 *
 *   这里用静态位置断言把它钉死：bindUploadDrop 的调用必须出现在
 *   `this.treeEl = document.createElement` **之后**。
 */
const ctorStart = src.indexOf("constructor(plugin, element)");
const ctorEnd = src.indexOf("bindDragDrop() {");
const ctorBody = (ctorStart >= 0 && ctorEnd > ctorStart) ? src.slice(ctorStart, ctorEnd) : "";
ok(ctorBody.length > 0, "找到 FileTree 构造函数体");
ok(!/this\.bindUploadDrop\(\)/.test(ctorBody),
   "★ 构造函数里**没有** bindUploadDrop（否则 new FileTree 就炸）");

const renderIdx = src.indexOf("this.treeEl = document.createElement");
// 取 render 里那次真实调用（排除方法定义 `bindUploadDrop() {`）
const callIdx = src.indexOf("this.bindUploadDrop();");
ok(callIdx > 0, "存在 this.bindUploadDrop() 调用");
ok(renderIdx > 0 && callIdx > renderIdx,
   "★ bindUploadDrop 在 `this.treeEl = ...` 之后才调用（顺序正确）");

console.log(`\n----------------\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

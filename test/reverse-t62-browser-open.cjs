/* ==========================================================================
 * #62 反向注入测试：「在浏览器中打开」的类型路由断言必须能变红
 * --------------------------------------------------------------------------
 * 原则（本项目的老规矩）：**恒真等于没有断言**。
 * verify-t62-browser-open.cjs 里每条契约都要有一个「注入点」把它搞红，
 * 否则我们无法区分「断言通过」与「断言根本没在测东西」。
 *
 * 手法：把源码读进内存 → 做一处**等价于旧 bug 的**改写 → 用同一组判据重判
 *      → 断言「该判据红了」。
 *
 * ★ 关键：注入必须真的命中最想测的那一处 ★
 *   踩过的坑（任务30 的 INJ-2 假绿）：`row` 在 makeNode 与 makeResultRow 里
 *   是同名参数，非贪婪替换删掉了**第一个**，结果目标那处根本没被改。
 *   ⇒ 这里的每一处注入都带**自检**：改完先确认「确实改动过」再判红。
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;

function ok(name) { console.log(`  ✅ ${name}`); pass++; }
function bad(name, detail) { console.log(`  ❌ ${name}\n       ${detail}`); fail++; }

/*
 * ★★ 极性说明（这里踩过一次，务必看清）★★
 *   judge.* 的约定是：**返回 true = 绿（契约成立）**，
 *   返回**字符串 = 红**（字符串就是失败原因）。
 *   所以「注入后应该变红」的正确判据是 `verdict !== true`，
 *   而不是 `verdict === true`。我第一版写反了，导致 7 条注入全报
 *   「没有变红」——其实全都红了，是**测试自己的极性错**。
 *   （这也说明为什么反向测试本身也要能被审视。）
 */
function expectRed(name, verdict, why) {
  if (verdict !== true) ok(`${name} → 已变红（${verdict}）`);
  else bad(name, `注入后判据仍是绿的 —— 该断言是常绿的，等于没测${why ? "；" + why : ""}`);
}
function expectGreen(name, verdict) {
  if (verdict === true) ok(name);
  else bad(name, `基线应为绿，实测红了：${verdict}`);
}

const F_API = path.join(ROOT, "src", "api.js");
const F_VIEWER = path.join(ROOT, "src", "viewer.js");
const F_TREE = path.join(ROOT, "src", "tree.js");
const F_DIST = path.join(ROOT, "dist", "index.js");

const API_SRC = fs.readFileSync(F_API, "utf8");
const VIEWER_SRC = fs.readFileSync(F_VIEWER, "utf8");
const TREE_SRC = fs.readFileSync(F_TREE, "utf8");

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function bodyAfter(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return stripComments(src.slice(open, k + 1)); }
  }
  return stripComments(src.slice(open));
}

/* ---------- 判据（与 verify 套件同源；返回 true=绿，字符串=红） ---------- */

const judge = {
  /** browserViewUrl 体里有没有 pickViewer 路由 */
  usesPickViewer(apiSrc) {
    const i = apiSrc.indexOf("export async function browserViewUrl");
    if (i < 0) return "没有 browserViewUrl";
    const seg = apiSrc.slice(i, i + 4000);
    return /pickViewer\s*\(/.test(seg) ? true : "browserViewUrl 里没有 pickViewer";
  },
  /** office 兜底是否走 /api/preview */
  officeFallsToKk(apiSrc) {
    const i = apiSrc.indexOf("export async function browserViewUrl");
    if (i < 0) return "没有 browserViewUrl";
    const seg = apiSrc.slice(i, i + 4000);
    return /apiGet\(\s*["']\/api\/preview["']/.test(seg) ? true : "没有 /api/preview 兜底";
  },
  /** cad 是否走 cad/preview */
  cadUsesCadApi(apiSrc) {
    const i = apiSrc.indexOf("export async function browserViewUrl");
    if (i < 0) return "没有 browserViewUrl";
    const seg = apiSrc.slice(i, i + 4000);
    const j = seg.indexOf('kind === "cad"');
    if (j < 0) return "没有 cad 分支";
    return /\/api\/cad\/preview/.test(seg.slice(j, j + 500)) ? true : "cad 分支没走 cad/preview";
  },
  /** viewer 是否用了 browserViewUrl */
  viewerUsesHelper(src) {
    const b = bodyAfter(src, "async openInBrowser()");
    if (!b) return "找不到 viewer.openInBrowser";
    /*
     * ★ 判据必须卡出「标识符边界」，否则 rename 类注入抓不住 ★
     *
     *   反例（本文件第一版就是这么写的）：
     *       /API\.browserViewUrl\(/
     *   注入 `API.browserViewUrl(…)` → `API.browserViewUrlX(…)` 后，
     *   这个正则**仍然匹配**：它先在 "browserViewUrl" 上匹配，接着要求一个 "("，
     *   而 "X(" 里那个 "(" 正好满足 ⇒ 判据常绿，注入"无效"。
     *   这不是注入写错了，是**判据太松**。
     *
     *   ⇒ 用 `(?![\w$])` 负向先行断言声明「这个标识符到此结束」，
     *     后面才允许出现 `(`。任何 rename（加后缀 / 改拼写）都会立刻变红。
     */
    return /API\.browserViewUrl(?![\w$])\s*\(/.test(b) ? true : "viewer 没用 browserViewUrl(";
  },
  /** viewer 是否又自己开 raw（旧 bug 的形状） */
  viewerNoRaw(src) {
    const b = bodyAfter(src, "async openInBrowser()");
    if (!b) return "找不到 viewer.openInBrowser";
    return /API\.signedRawUrl\(/.test(b) ? "viewer 又直接开 raw 了" : true;
  },
  /** tree 是否也用了 browserViewUrl */
  treeUsesHelper(src) {
    const b = bodyAfter(src, "async openInBrowser(entry)");
    if (!b) return "找不到 tree.openInBrowser";
    return /API\.browserViewUrl(?![\w$])\s*\(/.test(b) ? true : "tree 没用 browserViewUrl(";
  },
  /** tree 是否还在用 previewUrl */
  treeNoPreviewUrl(src) {
    const b = bodyAfter(src, "async openInBrowser(entry)");
    if (!b) return "找不到 tree.openInBrowser";
    return /API\.previewUrl\(/.test(b) ? "tree 又用 previewUrl 了" : true;
  },
};

/* ------------------------------- 基线 ------------------------------- */
console.log("\n【基线】当前源码应全绿");
expectGreen("BASE-1 browserViewUrl 用 pickViewer 路由", judge.usesPickViewer(API_SRC));
expectGreen("BASE-2 office 兜底走 kk", judge.officeFallsToKk(API_SRC));
expectGreen("BASE-3 cad 走 cad/preview", judge.cadUsesCadApi(API_SRC));
expectGreen("BASE-4 viewer 用 browserViewUrl", judge.viewerUsesHelper(VIEWER_SRC));
expectGreen("BASE-5 viewer 不再开 raw", judge.viewerNoRaw(VIEWER_SRC));
expectGreen("BASE-6 tree 用 browserViewUrl", judge.treeUsesHelper(TREE_SRC));
expectGreen("BASE-7 tree 不用 previewUrl", judge.treeNoPreviewUrl(TREE_SRC));

/*
 * ★ 通用注入器：只替换「openInBrowser 函数体」里的第一处，并自检落点 ★
 *   为什么不能直接对整份源码String.replace：
 *     非全局 replace 只改第一处，而 "API.browserViewUrl(" 在 doc-comment 里
 *     也会出现 ⇒ 注入会落在注释上，函数体没动，断言"看起来"没法变红。
 */
function injectInBody(src, methodSig, re, repl) {
  const i = src.indexOf(methodSig);
  if (i < 0) return { err: `找不到 ${methodSig}` };
  const bStart = src.indexOf("{", i);
  if (bStart < 0) return { err: "找不到函数体起始 {" };
  let d = 0, bEnd = -1;
  for (let k = bStart; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) { bEnd = k; break; } }
  }
  if (bEnd < 0) return { err: "函数体花括号不配平" };
  const body = src.slice(bStart + 1, bEnd);
  const newBody = body.replace(re, repl);
  if (newBody === body) return { err: "替换没有生效（函数体里没匹配到）" };
  const out = src.slice(0, bStart + 1) + newBody + src.slice(bEnd);
  // ★ 自检：注入后的函数体必须真的改变了 ★
  const outBody = out.slice(bStart + 1, out.length - src.slice(bEnd).length);
  if (outBody === body) return { err: "注入落点异常（函数体未变）" };
  return { out };
}

/* ------------------------------ 注入点 ------------------------------ */
console.log("\n【INJ】逐个注入，对应判据必须变红");

// INJ-1：browserViewUrl 里去掉 pickViewer ⇒ A2 红
{
  const out = API_SRC.replace(/const\s+kind\s*=\s*pickViewer\(nm\);/, "const kind = 'office';");
  if (out === API_SRC) bad("INJ-1 注入未生效", "没找到 `const kind = pickViewer(nm);`");
  else expectRed("INJ-1 去掉 pickViewer（不再按类型路由）", judge.usesPickViewer(out));
}

// INJ-2：把 office 兜底的 /api/preview 换成 /api/raw ⇒ A4 红（= 复现本 bug）
{
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  if (!/apiGet\(\s*["']\/api\/preview["']/.test(seg)) {
    bad("INJ-2 注入未生效", "没找到 /api/preview 兜底");
  } else {
    const out = API_SRC.slice(0, i) +
      API_SRC.slice(i, i + 4000).replace(/apiGet\(\s*["']\/api\/preview["']/, 'apiGet("/api/raw"') +
      API_SRC.slice(i + 4000);
    if (out === API_SRC) bad("INJ-2 注入未生效", "替换没有改变文本");
    else expectRed("INJ-2 office 兜底改回 raw（复现 bug）", judge.officeFallsToKk(out));
  }
}

// INJ-3：cad 分支改成走 raw ⇒ A3 红
{
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const head = API_SRC.slice(0, i);
  const seg = API_SRC.slice(i, i + 4000);
  const j = seg.indexOf('kind === "cad"');
  if (j < 0) {
    bad("INJ-3 注入未生效", "没找到 cad 分支");
  } else {
    const cadSeg = seg.slice(j, j + 500);
    const newCad = cadSeg.replace(/\/api\/cad\/preview/, "/api/raw");
    if (newCad === cadSeg) bad("INJ-3 注入未生效", "cad 分段里没有 /api/cad/preview");
    else {
      const out = head + seg.slice(0, j) + newCad + seg.slice(j + 500) + API_SRC.slice(i + 4000);
      expectRed("INJ-3 cad 改走 raw", judge.cadUsesCadApi(out));
    }
  }
}

// INJ-4：viewer 改回直接开 raw ⇒ A5(A2 同源) + viewerNoRaw 红
{
  const r = injectInBody(
    VIEWER_SRC,
    "async openInBrowser()",
    /const url = await API\.browserViewUrl\(this\.mount, this\.path, this\.name\);/,
    "const url = await API.signedRawUrl(this.mount, this.path);"
  );
  if (r.err) bad("INJ-4 注入未生效", r.err);
  else {
    expectRed("INJ-4a viewer 改回开 raw（复现 bug）", judge.viewerNoRaw(r.out));
    expectRed("INJ-4b viewer 不再用 browserViewUrl", judge.viewerUsesHelper(r.out));
  }
}

// INJ-5：tree 改回 previewUrl ⇒ treeUsesHelper + treeNoPreviewUrl 双双红
{
  const r = injectInBody(
    TREE_SRC,
    "async openInBrowser(entry)",
    /const url = await API\.browserViewUrl\(this\.currentMount, entry\.path, entry\.name\);/,
    "const { url } = await API.previewUrl(this.currentMount, entry.path);"
  );
  if (r.err) bad("INJ-5 注入未生效", r.err);
  else {
    expectRed("INJ-5a tree 改回 previewUrl", judge.treeNoPreviewUrl(r.out));
    expectRed("INJ-5b tree 不再用 browserViewUrl", judge.treeUsesHelper(r.out));
  }
}

/*
 * INJ-6：把**函数体里的那一次调用**改成打错的名字（browserViewUrlX）
 * ⇒ viewerUsesHelper 必须变红。
 *
 * ★★ 这一条踩了两次坑，值得留痕 ★★
 *   第一次：判据写 /API\.browserViewUrl\(/ —— 太松，
 *           rename 成 browserViewUrlX( 后正则仍能从 "X(" 找到 "("。已改为
 *           /API\.browserViewUrl(?![\w$])\s*\(/（卡标识符边界）。
 *   第二次（更隐蔽）：`String.replace(/…/, …)` 非全局，只替换**第一处**。
 *           而 viewer.js 里 "API.browserViewUrl(" 一共出现 **3 次**，
 *           前两次都在**注释里**（我这轮刚写的 doc-comment 就在讲它）——
 *           于是注入落在注释上，函数体原封不动 ⇒ 判据当然还是绿的。
 *           这与任务30 的 INJ-2 假绿是**同一类错误**：改了，但没改到目标那处。
 *   ⇒ 修法：注入前先剥注释取函数体，只替换体里那一处；
 *     并**自检注入确实落在体内**（injectionLanded）。
 */
{
  const i = VIEWER_SRC.indexOf("async openInBrowser()");
  const bStart = VIEWER_SRC.indexOf("{", i);
  let d = 0, bEnd = -1;
  for (let k = bStart; k < VIEWER_SRC.length; k++) {
    if (VIEWER_SRC[k] === "{") d++;
    else if (VIEWER_SRC[k] === "}") { d--; if (d === 0) { bEnd = k; break; } }
  }
  const head = VIEWER_SRC.slice(0, bStart + 1);
  const body = VIEWER_SRC.slice(bStart + 1, bEnd);
  const tail = VIEWER_SRC.slice(bEnd);

  const before = (body.match(/API\.browserViewUrl\(/g) || []).length;
  const newBody = body.replace(/API\.browserViewUrl\(/, "API.browserViewUrlX(");
  const injectionLanded = newBody !== body && /browserViewUrlX\(/.test(newBody);

  if (before === 0) {
    bad("INJ-6 注入未生效", "函数体里找不到 API.browserViewUrl(");
  } else if (!injectionLanded) {
    bad("INJ-6 注入未生效", "替换没有落在函数体里（改动量为 0）");
  } else {
    const out = head + newBody + tail;
    // 自检：确认函数体里那处**确实**被改了
    const outBody = out.slice(bStart + 1, bEnd);
    if (!/browserViewUrlX\(/.test(outBody)) {
      bad("INJ-6 自检失败", "注入后函数体里没有 browserViewUrlX —— 注入落点错了");
    } else {
      expectRed("INJ-6 函数体里调用名打错（browserViewUrlX）", judge.viewerUsesHelper(out));
    }
  }
}

/* --------------------------- 产物级（dist） --------------------------- */
console.log("\n【DIST】产物必须已重建，否则线上跑的是旧行为");
if (!fs.existsSync(F_DIST)) {
  bad("DIST", "dist/index.js 不存在");
} else {
  const dist = fs.readFileSync(F_DIST, "utf8");
  const hasMark = /browserViewUrl/.test(dist);
  if (hasMark) ok("DIST-1 dist 含 browserViewUrl"); else bad("DIST-1 dist 含 browserViewUrl", "dist 是旧产物，需要重建");
  if (/\/api\/cad\/preview/.test(dist)) ok("DIST-2 dist 含 cad 路由"); else bad("DIST-2 dist 含 cad 路由", "缺 /api/cad/preview");

  // DIST-3：证明 DIST-1 能红 —— 模拟一份不含该标记的产物
  const fake = dist.replace(/browserViewUrl/g, "NOPE");
  if (fake === dist) bad("DIST-3 证明 DIST-1 可红", "替换没生效（browserViewUrl 出现 0 次？）");
  else if (/browserViewUrl/.test(fake)) bad("DIST-3 证明 DIST-1 可红", "替换后仍含标记");
  else ok("DIST-3 证明 DIST-1 可红（注入后确实不含标记）");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

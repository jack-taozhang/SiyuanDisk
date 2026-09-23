/* ==========================================================================
 * #62 契约测试：「在浏览器中打开」必须按类型选**渲染通道**
 * --------------------------------------------------------------------------
 * 用户报障（原话）：
 *   「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
 *     onlyoffice 预览一样 kkviewer 也一样。
 *     PDF 预览目前点击这个按钮是在网页中打开。」
 *
 * 实测结论（本测试据此立契约）：
 *   /api/raw 是**字节通道**，不是渲染通道。`Content-Disposition: inline`
 *   一直都有，但浏览器只内嵌渲染极少数 MIME —— Office / CAD 专用 MIME
 *   浏览器没有渲染器 ⇒ 即使 inline 也只能下载。PDF 恰好被原生支持，
 *   所以同一段代码只有 PDF「看起来是对的」。
 *
 *   ⇒ 「在浏览器中打开」必须按 pickViewer() 的同一套路由分流：
 *       pdf/图片/视频/音频/文本 → /api/raw（原生）
 *       office/压缩包/其它      → kkFileView /preview/onlinePreview（text/html）
 *       cad                     → cad-viewer 深链
 * ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name}\n       ${r}`); fail++; }
  } catch (e) {
    console.log(`  ❌ ${name}\n       ${e.message}`);
    fail++;
  }
}

const API_SRC = fs.readFileSync(path.join(ROOT, "src", "api.js"), "utf8");
const VIEWER_SRC = fs.readFileSync(path.join(ROOT, "src", "viewer.js"), "utf8");
const TREE_SRC = fs.readFileSync(path.join(ROOT, "src", "tree.js"), "utf8");

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

console.log("\n【A】browserViewUrl 存在且路由正确（源码契约）");

check("A1 api.js 导出了 browserViewUrl", () => {
  if (!/export\s+async\s+function\s+browserViewUrl/.test(API_SRC)) {
    return "未找到 `export async function browserViewUrl`";
  }
  return true;
});

check("A2 它按 pickViewer 取类型（同一套路由）", () => {
  const body = API_SRC.slice(API_SRC.indexOf("export async function browserViewUrl"));
  const seg = body.slice(0, body.indexOf("\n}"));
  if (!/pickViewer\s*\(/.test(seg)) return "browserViewUrl 里没有调用 pickViewer —— 路由就无从对齐";
  return true;
});

check("A3 CAD 走 /api/cad/preview（不是 raw）", () => {
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  const cadIdx = seg.indexOf('kind === "cad"');
  if (cadIdx < 0) return "没有针对 cad 的分支";
  const cadSeg = seg.slice(cadIdx, cadIdx + 500);
  if (!/\/api\/cad\/preview/.test(cadSeg)) return "cad 分支没有请求 /api/cad/preview";
  return true;
});

check("A4 office/其它 兜底走 /api/preview（kkFileView）", () => {
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  if (!/apiGet\(\s*["']\/api\/preview["']/.test(seg)) {
    return "browserViewUrl 里没有 apiGet(\"/api/preview\") 兜底 —— office 仍会落到 raw（就是本 bug）";
  }
  return true;
});

check("A5 原生类型走 API.signedRawUrl（不是裸 signedRawUrl）", () => {
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  if (!/API\.signedRawUrl\(/.test(seg)) return "没有 API.signedRawUrl(...) 调用（裸名会 ReferenceError）";
  if (/\bawait\s+signedRawUrl\s*\(/.test(seg)) return "用了裸标识符 signedRawUrl —— 它是 API 的方法，会 ReferenceError";
  return true;
});

check("A6 所有返回都过 browserReachableUrl（主机名改写）", () => {
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  const n = (seg.match(/browserReachableUrl\(/g) || []).length;
  // cad 一处 + preview 一处 = 至少 2
  if (n < 2) return `只出现 ${n} 次 browserReachableUrl —— nebula:8088 会漏给浏览器`;
  return true;
});

check("A7 API 对象上挂了 browserViewUrl", () => {
  if (!/browserViewUrl\s*:\s*\(/.test(API_SRC)) return "API 对象里没有 browserViewUrl 方法";
  return true;
});

/*
 * ★ 取「函数体」而不是「从 openInBrowser 往下 2000 字符」★
 *   踩过：函数上方那段 doc-comment **本身**就在解释「原先用 API.previewUrl()，
 *   现在改用 browserViewUrl()」，从方法名开始切窗会把这段历史说明一起切进来，
 *   于是 B5 把**注释**里的 API.previewUrl 当成真实调用 ⇒ 假红。
 *   ⇒ 先剥注释，再按花括号配平取函数体。
 */
function bodyAfter(src, needle) {
  const i = src.indexOf(needle);
  if (i < 0) return "";
  const open = src.indexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return stripComments(src.slice(open, k + 1));
    }
  }
  return stripComments(src.slice(open));
}

console.log("\n【B】两个调用点都用它（viewer + tree）");

check("B1 viewer.openInBrowser 走 API.browserViewUrl", () => {
  const seg = bodyAfter(VIEWER_SRC, "async openInBrowser()");
  if (!seg) return "viewer.js 找不到 openInBrowser() 函数体";
  if (!/API\.browserViewUrl(?![\w$])\s*\(/.test(seg)) return "viewer.openInBrowser 没有用 API.browserViewUrl";
  return true;
});

check("B2 viewer 不再直接用 signedRawUrl 开新窗口（本 bug 的直接成因）", () => {
  const seg = bodyAfter(VIEWER_SRC, "async openInBrowser()");
  if (/API\.signedRawUrl\(/.test(seg)) {
    return "viewer.openInBrowser 仍在直接调 signedRawUrl —— 对 Office/CAD 会变成下载";
  }
  return true;
});

check("B3 viewer 不再退回网盘首页/深链（任务⑰的老问题）", () => {
  const seg = bodyAfter(VIEWER_SRC, "async openInBrowser()");
  if (/webDiskUrl\(/.test(seg)) return "仍有 webDiskUrl 兜底（会把用户丢到网盘首页）";
  return true;
});

check("B4 tree.openInBrowser 也走 API.browserViewUrl（两处一致）", () => {
  const seg = bodyAfter(TREE_SRC, "async openInBrowser(entry)");
  if (!seg) return "tree.js 找不到 openInBrowser(entry) 函数体";
  if (!/API\.browserViewUrl(?![\w$])\s*\(/.test(seg)) return "tree.openInBrowser 没有用 API.browserViewUrl";
  return true;
});

check("B5 tree.openInBrowser 不再用 previewUrl（那是恒走 kk 的旧写法）", () => {
  const seg = bodyAfter(TREE_SRC, "async openInBrowser(entry)");
  if (/API\.previewUrl\(/.test(seg)) return "tree.openInBrowser 仍在用 API.previewUrl";
  return true;
});

check("B6 viewer.js 已移除未使用的 webDiskUrl 导入", () => {
  const head = VIEWER_SRC.slice(0, VIEWER_SRC.indexOf("export class Viewer"));
  if (/^\s*webDiskUrl,\s*$/m.test(head)) {
    return "仍 import 了 webDiskUrl —— syntax.check 的检查④会报未使用";
  }
  return true;
});

console.log("\n【C】产物级：dist 必须已重建（否则部署的是旧行为）");

const DIST = path.join(ROOT, "dist", "index.js");
if (fs.existsSync(DIST)) {
  const dist = fs.readFileSync(DIST, "utf8");
  check("C1 dist 含 browserViewUrl", () => {
    if (!/browserViewUrl/.test(dist)) return "dist/index.js 里没有 browserViewUrl —— 需要 `node tools/build.js --repo`";
    return true;
  });
  check("C2 dist 的 browserViewUrl 里有 /api/cad/preview 与 /api/preview", () => {
    const hits = ["/api/cad/preview", "/api/preview"].filter((k) => dist.includes(k));
    if (hits.length < 2) return `dist 只命中 ${hits.join(",")}`;
    return true;
  });
} else {
  check("C1 dist/index.js 存在", () => "dist/index.js 不存在，先构建");
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

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
 *       office                  → **后端 /oo 承载页**（真实 origin，内嵌 OnlyOffice）
 *       压缩包/其它             → kkFileView /preview/onlinePreview（text/html）
 *       cad                     → cad-viewer 深链
 *
 *   ★ 2026-09-30（第 3 次修订）承载页形态三代演进 —— 每一代的失败都实测过 ★
 *     第 1 代 `data:text/html,…`  ：opaque origin ⇒ Chrome 拒载 http 子资源
 *     第 2 代 `blob:http://…`      ：不透明来源文档不发 Origin/Referer
 *                                   ⇒ PNA 判 InsecureLocalNetwork，连同源都拦
 *     第 3 代 `<serverUrl>/oo`    ：真实 http origin（:8089）⇒ 实测全绿 ✅
 *     根因矩阵（同 origin / 同 isSecureContext=false）见 src/api.js 该函数头注释。
 *
 *   ★ 2026-09-30 修订（用户第 2 次报障）★
 *     上一版这里写的是「office/压缩包/其它 → kkFileView」。用户实测反馈：
 *     「在浏览器中打开 本该 onlyoffice 打开的，跳转到了 KK 打开」——
 *     页签内是 OO，浏览器打开却变 kk（且 kk 的 KK_OFFICE_PREVIEW_TYPE=pdf
 *     会把 docx 转成 PDF 显示，观感更差）。⇒ office 一律走 OO，kk 仅作兜底。
 *     A4 相应拆成 A4a（office 走 OO）+ A4b（/api/preview 仍是最终兜底）。
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

check("A4a office 优先走 OnlyOffice（buildOoStandaloneUrl）", () => {
  const i = API_SRC.indexOf("export async function browserViewUrl");
  const seg = API_SRC.slice(i, i + 4000);
  const j = seg.indexOf('kind === "office"');
  if (j < 0) return "没有针对 office 的分支 —— office 会落到 kk，就是本 bug";
  const offSeg = seg.slice(j, j + 500);
  if (!/buildOoStandaloneUrl\s*\(/.test(offSeg)) {
    return "office 分支没有调用 buildOoStandaloneUrl —— 仍会走 kk";
  }
  return true;
});

check("A4b buildOoStandaloneUrl 返回后端 /oo 承载页，且先探测 /api/oo/config", () => {
  const i = API_SRC.indexOf("async function buildOoStandaloneUrl");
  if (i < 0) return "没有 buildOoStandaloneUrl 函数";
  const seg = API_SRC.slice(i, i + 8000);
  // ★ 端点名卡边界（`(?![\w/])`）：否则 `/api/oo/configX` 这类误写仍会命中（前缀匹配）★
  if (!/\/api\/oo\/config(?![\w/])/.test(seg)) return "没有请求 /api/oo/config —— 拿不到 OO 配置";
  // ★★ 2026-09-30（第 3 代契约）：必须返回**后端 /oo 承载页** ★★
  //   第 1 代 data: → opaque origin 拒载 api.js
  //   第 2 代 blob: → 不带 Origin/Referer，被 Chrome PNA 判 InsecureLocalNetwork
  //   第 3 代 /oo  → 真实 http origin（:8089），✅ 实测 docsAPI:true、零失败请求
  if (!/fixUrl\(\s*["']\/oo\?(?![\w=])/.test(seg)) {
    return "没有 fixUrl(\"/oo?...\") —— 没指向后端承载页，会退回复现 api.js 加载失败";
  }
  // ★ 路径判据同样要卡边界（同 INJ-9 的教训）★
  //   否则 `fixUrl("/oo?cfg=<base64>")` 这种「把 config 塞进 URL」的写法
  //   仍会命中 `/oo?` 前缀 ⇒ 判据常绿（本文件 INJ-11 抓出来的）。
  if (/fixUrl\(\s*["']\/oo\?[^"']*(cfg|apiJs|config)/.test(seg)) {
    return "把 config/apiJs 拼进了 /oo 的 URL —— 签名超长且 token 泄漏到历史/日志";
  }
  if (/return\s+["']data:text\/html/.test(seg)) {
    return "仍然返回 data:text/html —— 会复现「无法加载 OnlyOffice api.js」";
  }
  if (/URL\.createObjectURL\s*\(/.test(seg)) {
    return "仍在用 URL.createObjectURL 造 blob 页 —— 不透明来源会被 PNA 拦（InsecureLocalNetwork）";
  }
  if (/new\s+Blob\s*\(/.test(seg)) {
    return "仍在造 Blob 承载页 —— 同上，会复现 PNA 拦截";
  }
  // 探测结果应仍被用于「可用性判定」（配置不完整就降级）
  if (!/cfg\.config/.test(seg)) {
    return "没有校验 cfg.config —— OO 不可用时无从降级";
  }
  return true;
});

check("A4b2 buildOoStandaloneUrl 不把 config 塞进 URL（签名/超长隐患）", () => {
  // config 含 HS256 签名且约 2.9KB，进 URL 会超长 + token 泄漏到历史/日志。
  // 承载页自己按 mount/path 重新生成 config。
  const i = API_SRC.indexOf("async function buildOoStandaloneUrl");
  if (i < 0) return "没有 buildOoStandaloneUrl 函数";
  const seg = API_SRC.slice(i, i + 8000);
  if (/data:text\/html;charset=utf-8,"\s*\+/.test(seg)) {
    return "检测到 `data:text/html;charset=utf-8,` + 拼接 —— 退回 Data URL 了";
  }
  if (/\/oo\?[^"']*cfg(\.config|\.apiJs)/.test(seg) || /fixUrl\(\s*["']\/oo\?[^"']*(cfg|apiJs|config)/.test(seg)) {
    return "把 config/apiJs 拼进了 /oo 的 URL —— 签名会超长且 token 泄漏";
  }
  if (!/encodeURIComponent\(\s*String\(\s*(mount|path)/.test(seg)) {
    return "没有对 mount/path 做 encodeURIComponent —— 中文/特殊字符路径会拼坏 URL";
  }
  return true;
});

check("A4c office 分支拿不到 OO 时必须降级（返回空串而非抛错）", () => {
  const i = API_SRC.indexOf("async function buildOoStandaloneUrl");
  if (i < 0) return "没有 buildOoStandaloneUrl 函数";
  const seg = API_SRC.slice(i, i + 6000);
  // 失败路径必须是 return ""（由调用方落到 kk 兜底），不能 throw
  const hasEmptyReturn = /return\s+""\s*;/.test(seg);
  if (!hasEmptyReturn) return "失败路径没有 `return \"\"` —— 调用方无从降级";
  if (/throw\s+new\s+ApiError/.test(seg.slice(0, 1200))) {
    return "配置不可用时直接抛异常 —— 会把用户丢在报错里，应返回空串降级";
  }
  return true;
});

check("A4d office/其它 兜底走 /api/preview（kkFileView）", () => {
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

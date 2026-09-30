/* ==========================================================================
 * 诊断日志 + 工作区路径工具
 * --------------------------------------------------------------------------
 * ★ 为什么单独成模块（2026-09-30）★
 *   本插件已**彻底移除内置代理**（原 src/proxy.js 的 CookieJar / NebulaProxy /
 *   端口探测等全部删掉），但它的前半部分 —— 诊断日志与路径工具 —— 是
 *   **跨模块公共能力**，必须留下：
 *     · diag()                                  插件加载过程唯一可外部读取的痕迹
 *     · dirExists / normPath / pickWorkspace    定位思源工作区（日志要写到那儿）
 *   把它们继续挂在「proxy」这个名字下，会让「代理」这个概念以公共设施的形式
 *   苟活下来，下一个读代码的人会以为代理还在。所以抽成独立模块。
 *
 * ★★ node 能力必须是「可选 + 惰性」的 ★★
 *   踩过的大坑（NAS 端整轮空白）：
 *     这里原本在**模块顶层**直接写
 *       const fs = require("fs");
 *     桌面端（Electron，有 node）没问题；但**服务端思源**是浏览器访问，
 *     全局根本没有 `require`（也没有 window.require）—— 这个模块会在
 *     **脚本求值阶段**就抛错，而思源加载插件的写法是
 *       (function anonymous(require, module, exports){ <插件js> })(req, module, exports)
 *     一旦求值抛错，思源只 `console.error` 然后**静默放弃整个插件**：
 *       · siyuan.log 里只有 `loaded petals [...]`（那是清单，不是加载成功）
 *       · onload 永远不会执行 ⇒ 连诊断日志都不会产生
 *     ⇒ 外部表现是「插件列表里有它、但什么反应都没有」，且无从排查。
 *
 *   因此改为惰性获取：拿不到唯一的代价是「没有文件日志」，
 *   绝不会让插件消失。
 *
 * ★ 注意（写给构建器）★
 *   tools/build.js 的 export 转换只认
 *   `export [default] (async function|function|class|const|let|var) name`，
 *   **不支持** `export { a, b }` 这种聚合写法 —— 那会在产物里留下裸
 *   `export` 语句 ⇒ 整个 bundle 语法错误。所以本文件一律用内联 export。
 * ========================================================================== */

/** 惰性取 node 内建模块；拿不到就返回 null（浏览器端思源） */
function tryRequire(name) {
  try {
    // eslint-disable-next-line no-undef
    if (typeof require === "function") return require(name);
  } catch { /* 浏览器：无 require */ }
  try {
    // Electron 渲染进程若开了 nodeIntegration，可从 window.require 拿
    const w = typeof window !== "undefined" ? window : null;
    if (w && typeof w.require === "function") return w.require(name);
  } catch { /* ignore */ }
  return null;
}

const fs = tryRequire("fs");

/* -------------------------------------------------------------------------
 * 诊断日志
 *
 * 为什么需要
 *   思源加载插件时抛的任何异常**只写进浏览器 console**，siyuan.log 里一行都没有。
 *   把关键过程写进**工作区 temp/ 下的日志文件**，脚本就能读到真正的错因。
 *   写入失败不影响主流程（日志是辅助，不是功能）。
 * ---------------------------------------------------------------------- */
let DIAG_FILE = "";
export function setDiagFile(p) {
  DIAG_FILE = String(p || "");
}

/**
 * 相同内容的连续重复行折叠计数器。
 *
 * ★ 为什么需要 ★
 *   一旦上层出现「刷新风暴」（例如侧边栏被反复 init，每秒上百次
 *   /api/list），日志会瞬间膨胀到几万行，把真正有用的启动信息冲掉。
 *   这里做最朴素的折叠：连续 N 条相同消息 → 只写一条，再补一行汇总。
 *   换一条不同的消息即重置计数。
 */
let _diagLast = "";
let _diagRepeat = 0;

/** 进程标识：浏览器端没有 process，退回 "-" */
function pidTag() {
  try {
    return typeof process !== "undefined" && process.pid ? process.pid : "-";
  } catch {
    return "-";
  }
}

export function diag(msg) {
  const s = String(msg);
  // ★ 没有 fs（浏览器端思源）时退化为 console ★
  //   否则诊断信息会彻底消失 —— 那正是当初最难受的地方。
  if (!fs || !DIAG_FILE) {
    try { console.log(`[nebuladisk] ${s}`); } catch { /* ignore */ }
    return;
  }
  const tag = `[pid:${pidTag()}]`;
  try {
    if (s === _diagLast) {
      _diagRepeat++;
      // 每重复 50 次补一条汇总，避免把「还在刷」这件事彻底藏掉
      if (_diagRepeat % 50 === 0) {
        fs.appendFileSync(
          DIAG_FILE,
          `${new Date().toISOString()} ${tag} (同上重复 ${_diagRepeat} 次) ${s}\n`,
          "utf8",
        );
      }
      return;
    }
    if (_diagRepeat >= 2) {
      fs.appendFileSync(
        DIAG_FILE,
        `${new Date().toISOString()} ${tag} (上一条共重复 ${_diagRepeat + 1} 次)\n`,
        "utf8",
      );
    }
    _diagLast = s;
    _diagRepeat = 0;
    fs.appendFileSync(
      DIAG_FILE,
      `${new Date().toISOString()} ${tag} ${s}\n`,
      "utf8",
    );
  } catch {
    /* 日志写不进去就算了 */
  }
}

/* -------------------------------------------------------------------------
 * 路径工具
 *
 * 浏览器侧代码不应该直接碰 fs；把判断封装成函数，调用方只调函数。
 * ---------------------------------------------------------------------- */

/** 目录是否存在（且是目录）。无 fs 能力（浏览器端）时恒为 false。 */
export function dirExists(p) {
  if (!fs) return false;
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 文件是否存在。无 fs 能力（浏览器端）时恒为 false。 */
export function fileExists(p) {
  if (!fs) return false;
  try {
    return Boolean(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 把 Windows 反斜杠统一成正斜杠，去掉尾随斜杠 */
export function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 从若干候选里挑出第一个「看起来像思源工作区」的目录。
 *
 * 判定标准：该目录下同时有 `data` 或 `storage`（思源工作区的标志）。
 * 这样 process.cwd()、location 推断值之类即便指向别处也不会被误用。
 */
export function pickWorkspace(candidates) {
  for (const raw of candidates || []) {
    const p = normPath(raw);
    if (!p) continue;
    if (dirExists(`${p}/data`) || dirExists(`${p}/storage`)) return p;
  }
  return "";
}

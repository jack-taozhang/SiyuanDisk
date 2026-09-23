/* ==========================================================================
 * NebulaDisk 同源代理（SiYuan 插件内置）
 * --------------------------------------------------------------------------
 * 为什么需要它
 *   思源 WebView 的 origin 是 http://<nas>:6806，而 NebulaDisk 在
 *   http://<nas>:8089 —— 两者跨域。而 NebulaDisk 侧：
 *     · 没有任何 CORS 中间件（app/ 下搜不到 CORSMiddleware）
 *     · 会话 Cookie 是 SameSite=lax
 *   于是浏览器直接向 8089 发起的 fetch 一律读不到响应体，
 *   带 Cookie 的请求也不会被发送。
 *
 *   ⇒ 插件必须在「同源」位置提供一个转发层。
 *     本文件就是那一层：跑在思源进程内的 node http 服务，
 *     对插件暴露 /nb/*，由它去访问 NebulaDisk，并把 Cookie 收在自己手里。
 *
 * 关键设计
 *   1. Cookie 由代理自己保管（内存 + 可选落盘），不依赖浏览器携带。
 *      这样彻底绕开 SameSite=lax 的限制，也不用给网盘加 CORS 头。
 *   2. 只暴露「显式白名单」的路径前缀，代理不是开放转发器
 *      （否则思源的同源位置会变成一个可被文档内脚本利用的 SSRF 跳板）。
 *   3. 端口默认只绑定 127.0.0.1。
 *      思源不管跑在宿主机还是容器里，插件 JS 都在「思源进程」内执行，
 *      访问 127.0.0.1 = 访问思源自己所在的环境，因此始终可达。
 *
 * 无法做到的事（务必知情）
 *   · 无法把 /nb/* 变成真正的同源 iframe 内容源：代理端口与思源端口不同，
 *     iframe 仍然是跨 origin。所以 kkFileView 预览页由代理**改写 HTML**
 *     （见 rewritePreviewHtml），把资源地址指回 /nb/preview/*。
 *   · OnlyOffice 的 api.js 必须由浏览器直接从 OO 加载（跨域脚本加载是允许的），
 *     但 OO 服务端回拉文档时走的是**容器网络**内部的 NEBULA_BASE_URL，
 *     与代理无关 —— 因此在线编辑是三条链路里唯一「天然不受 CORS 影响」的。
 * ========================================================================== */

/* -------------------------------------------------------------------------
 * ★★★ node 能力必须是「可选 + 惰性」的 ★★★
 *
 * 踩过的大坑（NAS 端整轮空白）：
 *   这里原本在**模块顶层**直接写
 *     const http = require("http");
 *     const fs   = require("fs");
 *   桌面端（Electron，有 node）没问题；但**服务端思源**是浏览器访问，
 *   全局根本没有 `require`（也没有 window.require）——于是这个 IIFE
 *   在**脚本求值阶段**就抛 `Cannot find module 'http'`。
 *
 *   思源加载插件的写法是
 *     (function anonymous(require, module, exports){ <插件js> })(req, module, exports)
 *   一旦求值抛错，思源只 `console.error` 然后**静默放弃整个插件**：
 *      · siyuan.log 里只有 `loaded petals [...siyuan-nebuladisk]`（那是清单，不是成功）
 *      · 插件的 onload 永远不会执行 ⇒ 连插件自己写的诊断日志都不会产生
 *   ⇒ 外部表现就是「插件列表里有它、但什么反应都没有」，且**无从排查**。
 *
 * 因此这里改为惰性获取：拿不到就返回 null，功能降级为「仅直连通道」，
 * 而不是让整个插件消失。
 * ---------------------------------------------------------------------- */
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

const http = tryRequire("http");
const https = tryRequire("https");
const fs = tryRequire("fs");
const path = tryRequire("path");
const URL_ = tryRequire("url");
// URL 在浏览器里是全局内建的；node 里从 url 模块取。两者取其一即可。
const URL =
  (URL_ && URL_.URL) ||
  (typeof globalThis !== "undefined" && globalThis.URL) ||
  null;

/** 是否具备起本地代理所需的 node 能力（浏览器端为 false） */
const HAS_NODE = Boolean(http && fs && path && URL);

/* -------------------------------------------------------------------------
 * 诊断日志
 *
 * 为什么需要
 *   思源加载插件时抛的任何异常**只写进浏览器 console**，siyuan.log 里一行都没有。
 *   而代理启动是在渲染进程里做的，一旦失败（端口占用 / 没有 node 能力 / 配置错），
 *   外部完全看不到原因 —— 表现只是「插件在、但没有数据」。
 *
 *   ⇒ 把启动过程写进**插件目录下的日志文件**，这样脚本就能读到真正的错因。
 *     写入失败不影响主流程（日志是辅助，不是功能）。
 * ---------------------------------------------------------------------- */
let DIAG_FILE = "";
function setDiagFile(p) {
  DIAG_FILE = String(p || "");
}

/**
 * 相同内容的连续重复行折叠计数器。
 *
 * ★ 为什么需要 ★
 *   一旦上层出现「刷新风暴」（例如侧边栏被反复 init，每秒上百次
 *   /api/list），日志会瞬间膨胀到几万行，把真正有用的启动信息冲掉，
 *   排查反而更难。这里做最朴素的折叠：
 *     连续 N 条相同消息 → 只写一条，再补一行 "(同上重复 N 次)"。
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

function diag(msg) {
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
 * 路径工具（给 index.js 用，让它不必直接碰 fs）
 *
 * 浏览器侧代码不应该出现 fs；而 proxy.js 本来就跑在有 node 能力的
 * 渲染进程里（Electron），把这些封装在这里，index.js 只调用函数。
 * ---------------------------------------------------------------------- */

/** 目录是否存在（且是目录）。无 fs 能力（浏览器端）时恒为 false。 */
function dirExists(p) {
  if (!fs) return false;
  try {
    return Boolean(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 文件是否存在。无 fs 能力（浏览器端）时恒为 false。 */
function fileExists(p) {
  if (!fs) return false;
  try {
    return Boolean(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 把 Windows 反斜杠统一成正斜杠，去掉尾随斜杠 */
function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 用 Node 的 http 探测某端口上是否已有本插件的代理在跑。
 *
 * ★ 为什么不能用浏览器 fetch ★
 *   fetch 受同源策略约束：思源页面在 http://127.0.0.1:<思源端口>，
 *   代理在 http://127.0.0.1:<proxyPort> —— 端口不同即跨源。
 *   若那个代理恰好是**旧版代码**（没下发 CORS 头），
 *   响应体会被浏览器直接丢弃，fetch 抛错 ⇒ 误判为「没有代理」，
 *   于是插件以为自己该起一个 → EADDRINUSE → 整个通道不可用。
 *   这个误判链真实发生过，日志里就是：
 *       listen 失败: EADDRINUSE
 *       外部代理也探测不到 ⇒ 代理不可用
 *   而实际上代理好端端地在 6810 上回 200。
 *
 *   Node 的 http 请求不经过浏览器网络栈，没有 CORS 概念，
 *   探测结果才是可信的。
 *
 * @returns {Promise<{ok:boolean, info?:object}>}
 */
function probeProxyPort(port, timeout = 1500) {
  return new Promise((resolve) => {
    // 无 http 能力（浏览器端思源）⇒ 代理必然不存在，直接判否
    if (!http) return resolve({ ok: false });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.request(
        { host: "127.0.0.1", port, path: "/__ping", method: "GET", timeout },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => {
            if (res.statusCode !== 200) return finish({ ok: false });
            try {
              const d = JSON.parse(b);
              return finish(d && d.ok ? { ok: true, info: d } : { ok: false });
            } catch {
              return finish({ ok: false });
            }
          });
        },
      );
    } catch {
      return finish({ ok: false });
    }
    req.on("error", () => finish({ ok: false }));
    req.on("timeout", () => { req.destroy(); finish({ ok: false }); });
    req.end();
  });
}


/**
 * 从若干候选里挑出第一个「看起来像思源工作区」的目录。
 *
 * 判定标准：该目录下同时有 `data` 或 `storage`（思源工作区的标志）。
 * 这样 process.cwd()、location 推断值之类即便指向别处也不会被误用。
 */
function pickWorkspace(candidates) {
  for (const raw of candidates || []) {
    const p = normPath(raw);
    if (!p) continue;
    if (dirExists(`${p}/data`) || dirExists(`${p}/storage`)) return p;
  }
  return "";
}

/* -------------------------------------------------------------------------
 * 默认配置
 * ---------------------------------------------------------------------- */
const DEFAULTS = {
  /** NebulaDisk 地址；插件设置里可改 */
  target: "http://192.168.193.70:8089",
  /** 代理监听端口 */
  port: 6810,
  /** 监听地址：只绑本机 */
  host: "127.0.0.1",
  /** 请求超时（毫秒）。上传大文件要放宽 */
  timeout: 0,
};

/* -------------------------------------------------------------------------
 * 允许代理的路径白名单
 *
 * 判断方式：请求路径必须以其中某一项**开头**。
 * 宁可少放几个，也不要写成空前缀（那等于开放转发器）。
 * ---------------------------------------------------------------------- */
const ALLOW_PREFIX = [
  "/api/",      // 云盘全部业务 API（login / list / preview / oo / cad / shares …）
  "/preview/",  // kkFileView 同源反代
  "/cad/",      // CAD 查看器同源反代
  "/website/",  // o3dv 的根路径静态资源
  "/s/",        // 分享短链（嵌入笔记时会用到）
  "/healthz",   // 探活
  "/favicon",   // 图标
];

/** 明确拒绝的路径（即使是 /api/ 前缀）——避免把网盘变成文件外泄通道 */
const DENY_PREFIX = [
  // 无需登录即可取流的签名直链：签名本身是凭据，但代理不应替匿名方保管它。
  // 插件需要直链时走 /api/preview 等接口拿，由网盘自己签发。
  "/api/raw/",
];

/* -------------------------------------------------------------------------
 * 会话 Cookie 存储
 *
 * NebulaDisk 的登录接口下发 Set-Cookie（HttpOnly, SameSite=lax）。
 * 代理把它截下来存住，后续请求再补回 Cookie 头。
 * ---------------------------------------------------------------------- */
class CookieJar {
  constructor(storePath) {
    this.storePath = storePath;
    /** @type {Map<string,string>} name -> value */
    this.cookies = new Map();
    this.load();
  }

  /** 从 Set-Cookie 数组里吸收 cookie */
  absorb(setCookieHeaders) {
    if (!setCookieHeaders) return false;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let changed = false;
    for (const raw of list) {
      if (!raw) continue;
      // 只取 name=value 段，忽略属性（Path/HttpOnly/SameSite…）
      const first = String(raw).split(";")[0].trim();
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "" || /^(deleted|expired)$/i.test(value)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  /** 拼成 Cookie 请求头；无 cookie 时返回空串 */
  header() {
    if (this.cookies.size === 0) return "";
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear() {
    this.cookies.clear();
    this.save();
  }

  get size() {
    return this.cookies.size;
  }

  load() {
    if (!this.storePath || !fs) return;
    try {
      const txt = fs.readFileSync(this.storePath, "utf8");
      const obj = JSON.parse(txt);
      for (const [k, v] of Object.entries(obj || {})) {
        if (typeof v === "string") this.cookies.set(k, v);
      }
    } catch {
      /* 首次运行没有文件，或文件损坏 —— 都按「空 jar」处理 */
    }
  }

  save() {
    if (!this.storePath || !fs || !path) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const obj = Object.fromEntries(this.cookies.entries());
      fs.writeFileSync(this.storePath, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* 落盘失败不影响本次会话：cookie 仍在内存里 */
    }
  }
}

/* -------------------------------------------------------------------------
 * 代理主体
 * ---------------------------------------------------------------------- */
class NebulaProxy {
  /**
   * @param {object} opts
   * @param {string} [opts.target]    NebulaDisk 基地址
   * @param {number} [opts.port]      监听端口
   * @param {string} [opts.host]      监听地址
   * @param {string} [opts.cookieFile] cookie 落盘路径；空则不落盘
   * @param {function} [opts.log]     日志函数
   */
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.jar = new CookieJar(this.cfg.cookieFile || "");
    this.log = this.cfg.log || (() => {});
    /** @type {http.Server|null} */
    this.server = null;
    /** 实际监听到的端口（port=0 时由系统分配，需要回读） */
    this.actualPort = 0;
    /** 最近一次上游错误，供插件界面显示 */
    this.lastError = "";
  }

  /** 启动；已启动则直接返回当前端口 */
  start() {
    if (this.server) return Promise.resolve(this.actualPort);

    // ★ 无 node 能力（浏览器端思源，如 NAS 上的 Docker 思源）★
    //   这里必须**明确拒绝**而不是硬用 http（后者会 TypeError）。
    //   上层据此把通道切到「直连」，并给用户可读的提示。
    if (!HAS_NODE) {
      const msg = "当前环境不支持内置代理（浏览器端思源没有 node 能力），已改用直连通道";
      diag(`[proxy] ${msg}`);
      return Promise.reject(new Error(msg));
    }

    return new Promise((resolve, reject) => {
      diag(
        `start() 请求: ${this.cfg.host}:${this.cfg.port} → ${this.cfg.target}`,
      );

      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((err) => {
          this.lastError = `${err && err.name}: ${err && err.message}`;
          this.log(`[netdisk-proxy] 未捕获: ${this.lastError}`);
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          }
          res.end(`代理内部错误: ${this.lastError}`);
        });
      });

      // 上传大文件时不要让 node 提前掐断
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.keepAliveTimeout = 65000;

      server.on("error", (err) => {
        const detail = `${err && err.code ? err.code + " " : ""}${err && err.message}`;
        diag(`listen 失败: ${detail}`);
        if (!this.server) reject(err);
        else this.log(`[netdisk-proxy] server error: ${err.message}`);
      });

      server.listen(this.cfg.port, this.cfg.host, () => {
        this.server = server;
        this.actualPort = server.address().port;
        const line = `[netdisk-proxy] 监听 http://${this.cfg.host}:${this.actualPort} → ${this.cfg.target}`;
        this.log(line);
        diag(`✅ 监听成功 http://${this.cfg.host}:${this.actualPort} → ${this.cfg.target}`);
        resolve(this.actualPort);
      });
    });
  }

  /** 诊断用：把自身状态写一行到日志 */
  diagDump(tag) {
    diag(
      `${tag}: running=${this.running} port=${this.actualPort} ` +
        `target=${this.cfg.target} lastError=${this.lastError || "(空)"}`,
    );
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const s = this.server;
      this.server = null;
      s.close(() => resolve());
      // 兜底：有些 keep-alive 连接会让 close 迟迟不回调
      setTimeout(resolve, 1500).unref?.();
    });
  }

  get running() {
    return Boolean(this.server);
  }

  setTarget(url) {
    this.cfg.target = String(url || "").trim().replace(/\/+$/, "");
  }

  /** 清空会话（退出登录时调用） */
  clearSession() {
    this.jar.clear();
  }

  /* ---------------------------------------------------------------------
   * 请求处理
   * ------------------------------------------------------------------ */
  async _handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return this._send(res, 400, "text/plain; charset=utf-8", "非法请求路径", req);
    }

    // ---- CORS 预检：本地直接回 204，不转发上游 ----
    // 上游是 FastAPI，未注册 OPTIONS 时对 /api/list 会回 405，
    // 浏览器据此判定预检失败、真正请求根本不会发出。
    // 代理自己应答即可 —— 反正白名单已经由 _allowed 把关。
    if (req.method === "OPTIONS") {
      res.writeHead(204, Object.assign({ "content-length": "0" }, this._cors(req)));
      return res.end();
    }

    // ---- 代理自身的控制接口（不与网盘 API 冲突，加 __ 前缀区分）----
    if (pathname === "/__ping") {
      return this._send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        ok: true,
        target: this.cfg.target,
        port: this.actualPort,
        cookieCount: this.jar.size,
        lastError: this.lastError,
      }), req);
    }
    if (pathname === "/__session" && req.method === "GET") {
      return this._send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        hasSession: this.jar.size > 0,
      }), req);
    }
    if (pathname === "/__session" && req.method === "DELETE") {
      this.jar.clear();
      return this._send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), req);
    }

    // ---- 白名单校验 ----
    if (!this._allowed(pathname)) {
      this.log(`[netdisk-proxy] 拒答（不在白名单）: ${req.method} ${pathname}`);
      return this._send(res, 403, "text/plain; charset=utf-8",
        `此路径不允许经代理访问: ${pathname}`, req);
    }

    // ---- 转发 ----
    return this._forward(req, res, pathname);
  }

  _allowed(pathname) {
    if (DENY_PREFIX.some((p) => pathname.startsWith(p))) return false;
    return ALLOW_PREFIX.some((p) => pathname.startsWith(p));
  }

  _forward(req, res, pathname) {
    const targetBase = this.cfg.target.replace(/\/+$/, "");
    const targetUrl = targetBase + req.url;

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      this.lastError = `目标地址非法: ${this.cfg.target}`;
      return this._send(res, 502, "text/plain; charset=utf-8",
        `网盘地址非法，请在插件设置里修正：${this.cfg.target}`, req);
    }

    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    /** 组装转发头：剔除逐跳头，补上代理自己的 Cookie */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (
        lk === "host" ||
        lk === "cookie" ||        // ★ 丢弃浏览器带来的 cookie，用 jar 里的
        lk === "connection" ||
        lk === "keep-alive" ||
        lk === "proxy-connection" ||
        lk === "transfer-encoding" ||
        lk === "upgrade" ||
        lk === "origin" ||        // 让上游以为是同源请求
        lk === "referer"
      ) {
        continue;
      }
      headers[k] = v;
    }
    const jarCookie = this.jar.header();
    if (jarCookie) headers["cookie"] = jarCookie;
    headers["host"] = parsed.host;
    // 明确告诉上游「我期望 JSON」，避免拿到登录页 HTML
    if (!headers["accept"]) headers["accept"] = "*/*";

    const options = {
      method: req.method,
      headers,
      // 自签证书场景（NAS 上常见）——代理面向内网，放宽校验
      rejectUnauthorized: false,
    };

    const upstream = transport.request(parsed, options, (upRes) => {
      // ★ 吸收 Set-Cookie，不转给浏览器 ★
      const setCookie = upRes.headers["set-cookie"];
      if (setCookie) {
        const changed = this.jar.absorb(setCookie);
        if (changed) this.log(`[netdisk-proxy] 会话 cookie 已更新（共 ${this.jar.size} 项）`);
      }

      const status = upRes.statusCode || 502;
      /** 过滤响应头 */
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase();
        if (
          lk === "content-encoding" ||   // node 已解压
          lk === "content-length" ||     // 改写正文后长度会变
          lk === "transfer-encoding" ||
          lk === "connection" ||
          lk === "set-cookie" ||         // 见上：由 jar 保管
          lk === "x-frame-options" ||    // 反代进 iframe 必须去掉
          lk === "content-security-policy"
        ) {
          continue;
        }
        outHeaders[k] = v;
      }
      // 代理端口与思源不同源，必须显式放开，否则内嵌 iframe 会白屏
      delete outHeaders["x-frame-options"];
      delete outHeaders["content-security-policy"];

      // ★ 所有转发响应都必须带 CORS 头 ★
      //   之前只给 _send/_sendRaw 加了，遗漏了这里的流式分支，
      //   结果 /api/login、/api/me、/api/list 这些 JSON 接口全都没 ACAO，
      //   浏览器把 200 的响应体直接丢掉 —— 前端表现为「文件树永远空」。
      Object.assign(outHeaders, this._cors(req));

      const ctype = String(upRes.headers["content-type"] || "");

      // ---- HTML：改写资源地址，让预览页在 /nb/ 前缀下能取到 js/css ----
      if (ctype.includes("text/html")) {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf8");
          html = this._rewriteHtml(html);
          const buf = Buffer.from(html, "utf8");
          outHeaders["content-type"] = ctype.includes("charset")
            ? ctype
            : ctype + "; charset=utf-8";
          this._sendRaw(res, status, outHeaders, buf, req);
        });
        return;
      }

      // ---- 其它：直接流式回传（视频 Range 请求靠这条） ----
      res.writeHead(status, outHeaders);
      upRes.pipe(res);
    });

    upstream.on("error", (err) => {
      this.lastError = `${err.code || err.name}: ${err.message}`;
      this.log(`[netdisk-proxy] 上游错误 ${targetUrl}: ${this.lastError}`);
      if (!res.headersSent) {
        const hint = err.code === "ECONNREFUSED"
          ? `无法连接网盘服务（${this.cfg.target}）。请确认 NebulaDisk 正在运行，且地址与端口正确。`
          : err.code === "ENOTFOUND"
            ? `域名解析失败（${parsed.hostname}）。请检查网盘地址。`
            : `连接网盘失败：${err.message}`;
        this._send(res, 502, "text/plain; charset=utf-8", hint, req);
      }
    });

    // ---- 请求体透传（上传、表单 POST 都要）----
    req.pipe(upstream);
    req.on("aborted", () => upstream.destroy());
  }

  /**
   * 改写上游 HTML
   *
   * 场景：kkFileView 的预览页会以「绝对根路径」引用静态资源
   *       （例如 /js/xxx.js、/website/libs/...）。
   *
   * ★ 前缀为什么是空串（而不是早期的 "/nb"）★
   *   代理是**独立端口**的服务（http://127.0.0.1:6810），本身就是一个 origin，
   *   iframe 加载的就是 http://127.0.0.1:6810/preview/...，
   *   所以页面里的根路径资源 /js/xxx.js 直接落到代理根下即可，
   *   代理的白名单（ALLOW_PREFIX）也正是以 /preview/ /cad/ /website/ /s/ /api/ 开头。
   *
   *   早期写 "/nb" 是和旧架构（把请求挂到思源 origin 的 /nb 子路径）绑定的，
   *   架构改成独立端口后没跟着改 —— 后果是页面资源被改写成
   *   http://127.0.0.1:6810/nb/js/xxx.js，而白名单里没有 /nb/ 前缀，
   *   代理直接 403，预览页只有骨架没有样式/脚本。
   *
   * 做法保守：只改写 HTML 里的属性值与少量内联脚本里的字符串字面量，
   * 不做通用 URL 解析（模板里已有的 __SERVER_BASE_URL__ 占位符交给
   * NebulaDisk 自己的反代逻辑处理，这里不抢）。
   */
  _rewriteHtml(html) {
    const PREFIX = "";
    // 需要处理的根路径（与 ALLOW_PREFIX 呼应）
    const roots = ["/preview/", "/cad/", "/website/", "/api/", "/s/"];

    for (const r of roots) {
      const esc = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // ① 属性里出现 src="/preview/…" / href='/preview/…'
      html = html.replace(
        new RegExp(`(\\s(?:src|href|action|data-src|poster)=)(["'])${esc}`, "g"),
        `$1$2${PREFIX}${r}`,
      );
      // ② 已带绝对 origin 的地址：src="http://host/preview/…"
      html = html.replace(
        new RegExp(`((?:src|href|action|data-src|poster)=["'])https?://[^/"']+${esc}`, "g"),
        `$1${PREFIX}${r}`,
      );
      // ③ 内联脚本里的字符串字面量："…/preview/xxx"
      html = html.replace(
        new RegExp(`(["'])${esc}`, "g"),
        `$1${PREFIX}${r}`,
      );
      // ④ fetch('…') / new URL('…') 里的裸根路径（前面没有引号也算）
      //    —— 已由 ③ 覆盖，因为它同样以引号开头。
    }

    // ⑤ 加固：去掉可能残留的 frame busting
    html = html.replace(
      /if\s*\(\s*(?:window\.)?(?:top|parent)\s*!==?\s*(?:window\.)?self\s*\)/g,
      "if(false)",
    );

    return html;
  }

  /* ---------------------------------------------------------------------
   * CORS
   *
   * ★ 为什么必须有这一段 ★
   *
   *   思源的渲染进程页面跑在 http://127.0.0.1:<思源端口>（6806 或随机端口），
   *   代理跑在 http://127.0.0.1:6810 —— **端口不同即跨源**。
   *   浏览器对跨源 fetch/XHR 的判定完全依据响应头，代理若不下发
   *   Access-Control-Allow-Origin，响应体即使 HTTP 200 也会被浏览器丢弃，
   *   前端只看到 "TypeError: Failed to fetch"。
   *
   *   实测症状（不补 CORS 头时）：
   *     GET  /api/me   → HTTP 200，但 ACAO 缺失 ⇒ fetch 抛网络错误
   *     OPTIONS /api/list → 405 ⇒ 带 Content-Type 的 POST 预检直接失败
   *   表现就是「面板能打开、登录似乎也过了，但文件树永远空」。
   *
   *   写法：把请求方的 Origin 原样回显，并允许携带凭据。
   *   代理只监听 127.0.0.1，且自带白名单（见 _allowed），
   *   回显 Origin 不会把内网网盘暴露给任意站点。
   * ------------------------------------------------------------------ */
  _cors(req) {
    const origin = req && req.headers && req.headers.origin;
    return {
      // 无 Origin（同源请求/直接访问）时用 *，有 Origin 时原样回显
      "access-control-allow-origin": origin || "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
      // 回显请求方声明要用的头（预检通过的关键），再兜底一个通用集合
      "access-control-allow-headers":
        req && req.headers && req.headers["access-control-request-headers"]
          ? req.headers["access-control-request-headers"]
          : "content-type, authorization, accept, x-requested-with, range",
      // ★ 必须暴露这些头，前端的 XHR 才能读到上传进度 / 文件名 ★
      "access-control-expose-headers":
        "content-length, content-range, content-disposition, accept-ranges",
      "access-control-max-age": "600",
      // 让中间缓存按 Origin 分开存
      "vary": "Origin",
    };
  }

  /* ---- 小工具 ---- */
  _send(res, status, ctype, body, req) {
    const buf = Buffer.from(String(body), "utf8");
    res.writeHead(status, Object.assign({
      "content-type": ctype,
      "content-length": buf.length,
      "cache-control": "no-store",
    }, this._cors(req)));
    res.end(buf);
  }

  _sendRaw(res, status, headers, buf, req) {
    headers["content-length"] = buf.length;
    Object.assign(headers, this._cors(req));
    res.writeHead(status, headers);
    res.end(buf);
  }
}

module.exports = {
  NebulaProxy,
  DEFAULTS,
  ALLOW_PREFIX,
  DENY_PREFIX,
  HAS_NODE,
  setDiagFile,
  diag,
  dirExists,
  fileExists,
  normPath,
  pickWorkspace,
  probeProxyPort,
};

/* -------------------------------------------------------------------------
 * siyuan-nebuladisk —— 由 tools/build.js 打包生成，请勿直接编辑。
 *
 * ★ 必须是单文件：思源给插件的 require 只认 "siyuan"，
 *   其余委托给 Electron 的 window.require（解析基准是渲染进程 bundle，
 *   不是插件目录），所以 require("./src/x.js") 必然失败，且**只报在浏览器 console**，
 *   siyuan.log 里看不到任何痕迹。
 *
 * 源码：<项目根>/index.js 与 <项目根>/src/*.js（模块见下方 // ===== 分隔）
 * ---------------------------------------------------------------------- */
"use strict";

/** 内核为插件提供的 siyuan 内建模块 */
const SIYUAN = require("siyuan");
/* ===== src/proxy.js  [CommonJS] ===== */
const __mod_proxy = (() => {
  const module = { exports: {} };
  const exports = module.exports;
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
  return {
    __cjs: true,
    __exports: module.exports,
  };
})();

/* ===== src/api.js ===== */
const __mod_api = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const diag = __mod_proxy.__exports.diag;
  const HAS_NODE = __mod_proxy.__exports.HAS_NODE;
  /* ==========================================================================
   * NebulaDisk API 客户端（浏览器侧）
   * --------------------------------------------------------------------------
   * ★★ 双通道传输 ★★
   *
   * 有两条路可以到达网盘后端，运行时自动选择：
   *
   *  ① 直连通道（首选）
   *     直接 fetch `http://<网盘>:8089/api/...`。
   *     前提是后端开了 CORS（NEBULA_CORS_ORIGINS）并且调用方带
   *     `Authorization: Bearer <token>`。
   *     优点：不依赖任何本地进程，网页端、手机端、Docker 版思源都能用。
   *
   *  ② 本地代理通道（兜底）
   *     插件在思源进程内起一个 Node HTTP 服务（默认 127.0.0.1:6810），
   *     由它代为请求后端（服务端之间没有同源策略），再把结果加 CORS 头回传。
   *     用途：后端还没升级到带 CORS 的版本时的兼容路径，
   *           以及需要「服务端 Cookie 会话」而不想管理 token 的场景。
   *
   * 选择逻辑见 pickChannel()：**先探测直连，能用就一直用**；
   * 直连不可用（后端没开 CORS / 网络不通）才回落到代理。
   * 探测结果缓存在 sessionStorage，避免每次请求都试错。
   *
   * 与后端契约的对应关系（读自 nebula/app/routers/）：
   *   POST /api/login   Form(username,password) → {ok,username,display,isAdmin,token}
   *   GET  /api/me                                → {username,isAdmin,mounts[],onlyoffice,cad,disk}
   *   GET  /api/list?mount=&path=                 → {path,entries[],mount{label,readonly}}
   *   GET  /api/stat?mount=&path=                 → 文件属性
   *   POST /api/mkdir|rename|delete|move|extract  Form
   *   POST /api/upload                            multipart
   *   GET  /api/preview?mount=&path=              → {ok,url:"/preview/onlinePreview?…",raw}
   *   GET  /api/cad/preview?mount=&path=          → {ok,url:"/cad/?open=…"}
   *   POST /api/oo/config Form(mount,path)        → {ok,config,apiJs,mode,title}
   *   GET  /api/download?mount=&path=&inline=     → 二进制
   * ========================================================================== */



  /** 代理默认端口（与 index.js 的 DEFAULT_SETTINGS.proxyPort 一致） */
  const DEFAULT_PROXY_PORT = 6810;

  /**
   * 当前环境有没有 node 能力（即「本地代理」这条路究竟存不存在）。
   *
   * ★ 意义 ★
   *   浏览器端思源（NAS / Docker / 网页版）没有 node ⇒ 进程内代理**永远起不来**。
   *   这种情况下**绝不能**回退代理，否则每次请求都变成
   *   `POST http://127.0.0.1:6810/… net::ERR_CONNECTION_REFUSED`，
   *   用户看到满屏报错，而实际上直连是好的。
   */
  function hasNode() {
    try {
      const inst = window.__nebuladiskPlugin;
      // 插件把探测结果放在 boot.noNode 上（index.js startInline 里设置）
      if (inst && inst.boot && inst.boot.noNode) return false;
    } catch { /* ignore */ }
    return HAS_NODE;
  }

  /** 直连通道的探测结果缓存键（放在 sessionStorage，刷新页面后重探） */
  const CHANNEL_KEY = "nebuladisk.channel";

  /**
   * 后端服务器地址 —— 形如 `http://172.16.30.128:8089`。
   *
   * 来源优先级：插件设置 serverUrl → 空。
   * 空表示「没有直连目标」，此时只能用代理通道。
   */
  function serverBase() {
    try {
      const inst = window.__nebuladiskPlugin;
      const s = inst && inst.settings;
      const u = s && String(s.serverUrl || "").trim();
      if (u) return u.replace(/\/+$/, "");
    } catch { /* ignore */ }
    return "";
  }

  /**
   * 「打开网盘」的深链地址 —— 定位到**某个文件所在的目录**。
   *
   * ★ 任务③（2026-09-22）★
   *   用户原话：「打开网盘 应该是 打开到对应嵌入块 对应文件所在的目录。」
   *
   * 为什么是「目录」而不是「文件」：
   *   NebulaDisk 是文件管理器，它的网页版只有「打开某个文件夹」这个动作，
   *   没有「高亮某个文件」的能力。落在目录上，用户一眼就能看到文件在哪儿，
   *   也能继续在该目录里做上传/下载/多选等网页版才有的操作。
   *
   * 后端配合（已实测）：
   *   网盘前端的四个 bundle 原本完全没有 URL 深链支持；
   *   我给它的 app.js 打了最小补丁（enterDesktop 末尾读一次参数，
   *   交给既有的 Explorer.open(mount, initialPath)），浏览器 E2E 通过。
   *   ⇒ 本函数拼出的 `?mount=&path=` 现在**真的会跳转**。
   *
   * 参数格式（与后端补丁约定，必须一致）：
   *   · mount = 挂载点名（如「研发立项」），必须与 /api/me 的 mounts[].label 相同
   *   · path  = **目录**路径，以 / 开头（如「/02 单机图纸」）
   *   两者都用 encodeURIComponent 编码（中文/空格必须编码）。
   *
   * @param {string} base  网盘根地址（serverBase() 的返回值）
   * @param {string} mount 挂载点名
   * @param {string} filePath 文件路径（会自动取所在目录）
   * @returns {string} 可直接 window.open 的 URL
   */
  function webDiskUrl(base, mount, filePath) {
    const root = String(base || "").replace(/\/+$/, "") + "/";
    const m = String(mount || "").trim();
    if (!m) return root;

    // ---- 取所在目录 ----
    //   只处理正斜杠：网盘返回的 path 一律是 POSIX 风格（/a/b/c.docx）。
    //   空路径也走下面的通用分支，最终归一成 "/" ——
    //   保证「有 mount」时 path 参数**恒存在**，调用方不用分情况处理。
    let p = String(filePath || "").replace(/\\/g, "/");
    // 目录 = 最后一个 / 之前的部分；文件直接在根目录时结果为空 → 归一为 "/"
    const cut = p.lastIndexOf("/");
    let dir = cut >= 0 ? p.slice(0, cut) : "";
    // 去掉结尾斜杠（"/a/b/" → "/a/b"），但保留「根」这一个斜杠
    dir = dir.replace(/\/+$/, "");
    if (!dir) dir = "/";
    // 合并重复斜杠
    dir = dir.replace(/\/{2,}/g, "/");

    return root + "?mount=" + encodeURIComponent(m) + "&path=" + encodeURIComponent(dir);
  }

  /**
   * 轻量外壳页地址 —— 把预览页包进一个**同源**的外壳里，收掉菜单栏并挡中键。
   *
   * ★★★ 任务③/⑤ 的关键修正（2026-09-22，实测得出）★★★
   *
   *   旧做法：插件自己用 `URL.createObjectURL(blob)` 造一个宿主页，
   *          宿主页里再 `<iframe src="http://172.16.30.128:8089/preview/…">`。
   *
   *   **这个做法不成立。** 用 CDP 在真机上量到：
   *
   *       hostSrcHead      = blob:http://172.16.30.128:6806/7d77a594-…
   *       innerOrigin      = http://172.16.30.128:8089
   *       innerDocReadable = false          ← ★ contentDocument === null ★
   *
   *   blob: 继承的是**创建者**（思源，:6806）的 origin，而预览页在
   *   NebulaDisk（:8089）—— 跨源 ⇒ 宿主页拿不到子 iframe 的 document：
   *     · 隐藏菜单栏的 CSS      → 注入不到（任务③ 根本没生效）
   *     · 内层 document 的中键守卫 → 绑不上（任务⑤ 根本没生效）
   *
   *   正确做法：让**预览服务自己**吐出外壳页。NebulaDisk 本来就在 :8089 上
   *   跑着反代 `/preview/{rest:path}`，所以我在它那边加了一个 `/lite` 端点：
   *
   *       GET /lite?kind=kk|cad&target=<本站相对路径>
   *
   *   外壳页与 target 都在 :8089 ⇒ 同源 ⇒ contentDocument 可读
   *   ⇒ CSS 与守卫都真正生效（已实测：readable/hasCss/hasGuard 全 true）。
   *
   * ★ 为什么 target 必须转成**相对路径** ★
   *   后端出于安全只接受本站相对路径（/ 开头、无 "//"、无 ":"），
   *   以免 /lite 变成开放重定向或任意站点 iframe 的跳板。
   *   所以这里把绝对地址去掉 origin 再传。
   *
   * ★ 降级 ★
   *   万一 /lite 不可用（老版本 NebulaDisk 没打这个补丁），返回空串，
   *   调用方退回「直连预览页」——功能可用，只是收不掉菜单栏。
   *
   * @param {string} base    网盘根地址
   * @param {string} target  预览页地址（绝对或相对都行）
   * @param {"kk"|"cad"} kind 隐藏哪一组选择器
   * @returns {string} /lite 地址；参数不合法时返回 ""
   */
  function liteUrl(base, target, kind) {
    const root = String(base || "").replace(/\/+$/, "");
    const t = String(target || "").trim();
    if (!root || !t) return "";

    // 绝对 → 相对（去掉 origin）；相对原样用
    let rel = t;
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        rel = u.pathname + (u.search || "");
      } catch { return ""; }
    }
    // 后端会做同样的校验，这里先挡一道，避免拼出注定 400 的地址
    if (!rel.startsWith("/") || rel.indexOf("//") === 0 || rel.indexOf(":") >= 0) return "";

    const k = kind === "cad" ? "cad" : "kk";
    // 注意：target 里的 ? & 都要编码，否则会被 /lite 自己的 query 吃掉
    return root + "/lite?kind=" + k + "&target=" + encodeURIComponent(rel);
  }

  /**
   * 代理基点 —— 形如 `http://127.0.0.1:6810`。
   *
   * 端口来源（按优先级）：
   *   ① 插件实例上解析出来的实际端口（可能是内嵌代理，也可能是复用到的外部代理）
   *   ② 插件设置里的 proxyPort
   *   ③ 默认 6810
   *
   * 注意：**不能用 location.origin** —— 那是思源的地址，不是代理的地址。
   */
  function proxyBase() {
    let port = DEFAULT_PROXY_PORT;
    try {
      const inst = window.__nebuladiskPlugin;
      if (inst) {
        const boot = inst.boot;
        if (boot) {
          const p = boot.externalPort || boot.actualPort;
          if (p) port = Number(p);
        }
        if (!port && inst.settings && inst.settings.proxyPort) {
          port = Number(inst.settings.proxyPort);
        }
      }
    } catch { /* 拿不到就用默认 */ }
    return `http://127.0.0.1:${port}`;
  }

  /* -------------------------------------------------------------------------
   * 直连通道的会话 token
   * --------------------------------------------------------------------------
   * 后端不支持 allow_credentials（开了就等于全员 CSRF），所以跨域拿不到 Cookie，
   * 必须自己保存 Bearer token。
   * 放 sessionStorage：关闭标签页即失效，比 localStorage 少一份长期暴露风险；
   * 会话本身在后端也有 expiry（默认 12 小时）。
   * ---------------------------------------------------------------------- */
  const TOKEN_KEY = "nebuladisk.token";

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  }
  function setToken(t) {
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* 隐私模式下 sessionStorage 可能不可用，忽略 */ }
  }

  /**
   * 当前使用的通道：`"direct"` 或 `"proxy"`。
   *
   * ★ 为什么要缓存 ★
   *   探测要发一次真实请求。如果每次 API 调用都先探测，请求量会翻倍，
   *   而且失败时会有明显延迟。缓存到 sessionStorage 后，一次会话只探一次。
   *   但要注意：**用户改了 serverUrl 就必须重探**，所以缓存里带上 URL，
   *   不一致就作废（见 pickChannel）。
   */
  let channelMemo = null;   // { base: string, kind: "direct"|"proxy" }

  function resetChannel() {
    channelMemo = null;
    try { sessionStorage.removeItem(CHANNEL_KEY); } catch { /* ignore */ }
  }

  /** 读缓存（同一次会话、同一个 serverUrl 才复用） */
  function cachedChannel(base) {
    if (channelMemo && channelMemo.base === base) return channelMemo.kind;
    try {
      const raw = sessionStorage.getItem(CHANNEL_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (o && o.base === base && (o.kind === "direct" || o.kind === "proxy")) {
        channelMemo = o;
        return o.kind;
      }
    } catch { /* ignore */ }
    return null;
  }

  function saveChannel(base, kind) {
    channelMemo = { base, kind };
    try { sessionStorage.setItem(CHANNEL_KEY, JSON.stringify(channelMemo)); } catch { /* ignore */ }
  }

  /**
   * 探测直连通道是否可用。
   *
   * ★ 判据（2026-09 修正）★
   *   对 /healthz 发一次带 `Accept` 头的跨域 GET：
   *   - **只要 fetch 没抛异常，就说明直连可用** —— 真被 CORS 拦时 fetch 会抛
   *     TypeError，压根走不到 `then`。所以"没抛错"本身已是充分证据。
   *   - `access-control-allow-origin` 只当**日志参考**，不再作为唯一判据。
   *
   * ★ 为什么以前会误判 ★（务必看完，这是 2026-09 那次线上故障的根因）
   *   Starlette/FastAPI 的 `CORSMiddleware` **只在请求带 `Origin` 头时才回 ACAO**。
   *   一个不带自定义头的简单 GET 浏览器不会替我们加 `Origin`，
   *   于是响应里 ACAO 恒为 `(无)` ⇒ 误判直连不可用 ⇒ 回退本地代理。
   *   而在**浏览器端思源**（NAS / Docker）压根没有代理进程，
   *   结果就是满屏 `POST http://127.0.0.1:6810/… net::ERR_CONNECTION_REFUSED`。
   */
  async function probeDirect(base, timeoutMs = 2500) {
    if (!base) return false;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      // ★★★ 关键：必须显式带上 Origin 头，否则探测结论是错的 ★★★
      //
      //   Starlette/FastAPI 的 CORSMiddleware **只在请求带 Origin 时**才回
      //   access-control-allow-origin。而一个不带自定义头的简单 GET，
      //   浏览器是**不会**替你加 Origin 的（只有跨域非简单请求才加）。
      //
      //   后果（真实踩过）：不显式带 Origin 时响应里 ACAO 恒为「(无)」，
      //   探测误判「直连不可用」→ 回退代理 → 浏览器端没有代理 →
      //   满屏 ERR_CONNECTION_REFUSED，而直连其实是好的。
      //
      //   显式设 Origin 后，该请求变成「非简单请求」的等价形态，
      //   浏览器会发 Origin 并校验响应，ACAO 也就可读了。
      const r = await fetch(base + "/healthz", {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        signal: ctl ? ctl.signal : undefined,
        // Accept 自定义头本身就会触发预检，Origin 也随之上送
        headers: { Accept: "application/json" },
      });
      const acao = r.headers.get("access-control-allow-origin");
      // ★ 判定放宽：能拿到响应体 = CORS 已经放行 ★
      //   若真被 CORS 拦，fetch 会抛 TypeError，压根走不到这里。
      //   所以「请求没抛错」本身就是直连可用的充分证据；
      //   ACAO 只作为日志参考，不再作为唯一判据。
      const ok = r.ok || !!acao;
      diag(`[channel] 直连探测 ${base}/healthz → ${r.status} ACAO=${acao || "(无)"} ⇒ ${ok ? "直连可用" : "直连不可用"}`);
      return ok;
    } catch (e) {
      diag(`[channel] 直连探测失败（${e && e.name}: ${e && e.message}）`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 决定本次使用哪条通道。
   * @returns {Promise<"direct"|"proxy">}
   */
  async function pickChannel() {
    const base = serverBase();

    // ★ 第一优先：没有 node 能力 ⇒ 本地代理这条路根本不存在 ★
    //   直接锁定直连，连探测都省了（探测再准也没别的选项）。
    //   必须放在 cachedChannel 之前，否则旧的错误缓存会继续把我们带向代理。
    if (!hasNode()) {
      if (!base) {
        diag("[channel] ⚠ 当前环境无 node 能力（无法用本地代理），但也没配置后端地址 ⇒ 通道不可用");
        return "direct";
      }
      saveChannel(base, "direct");       // 顺手把缓存修正过来
      diag(`[channel] 无 node 能力 ⇒ 强制直连通道：${base}`);
      return "direct";
    }

    if (!base) return "proxy";           // 有 node 但没配地址，只能靠代理
    const hit = cachedChannel(base);
    if (hit) return hit;
    const ok = await probeDirect(base);
    const kind = ok ? "direct" : "proxy";
    saveChannel(base, kind);
    if (ok) diag(`[channel] 采用直连通道：${base}`);
    else diag(`[channel] 采用本地代理通道（直连不可用）`);
    return kind;
  }

  /**
   * 把后端返回的相对路径补成可访问的绝对 URL。
   *
   * ★ 两通道的基址不同 ★
   *   直连：基址 = serverUrl（http://172.16.30.128:8089）
   *   代理：基址 = proxyBase()（http://127.0.0.1:6810）
   *   同一个 `/preview/onlinePreview?...` 在两条通道下要拼出不同的绝对地址。
   *   预览 iframe 的 src、下载链接都用这里的结果。
   */
  function fixUrl(u) {
    if (!u) return "";
    const s = String(u);
    if (/^https?:\/\//i.test(s)) return s;   // 已是绝对地址
    const base = currentKind() === "direct" ? serverBase() : proxyBase();
    if (!base) return s;
    if (s.startsWith(base)) return s;
    return base + (s.startsWith("/") ? s : "/" + s);
  }

  /**
   * 把**后端签发的绝对直链**改写成「浏览器真正能打开」的地址。
   *
   * ★★★ 与 fixUrl() 的区别（这就是「复制直链」拿到 nebula:8088 的原因）★★★
   *
   *   fixUrl()  只负责「相对 → 绝对」，对已经是绝对地址的串原样返回。
   *   browserReachableUrl() 负责「容器内主机名 → 浏览器可达主机名」，
   *   即把 `http://nebula:8088/...` 这类**只在 docker 网络里可解析**的地址
   *   换成当前通道的基点。
   *
   *   两个函数是**互补**的，不能互相替代：
   *     · 相对路径（/preview/...）      → fixUrl 就够
   *     · 绝对但主机不可达（nebula:8088）→ 必须 browserReachableUrl
   *
   * ★ 什么算「不可达主机」★
   *   不写死 `nebula`，而是「凡是与当前可达基点不同源、且主机名不含点的
   *   短名（docker 服务名/容器名没有域名后缀）⇒ 判定为容器内地址」。
   *   这样 compose 换了服务名也照样兜得住。
   *
   * @param {string} u 后端返回的直链（可能是相对路径，也可能是 nebula:8088 绝对地址）
   * @returns {string} 浏览器可打开的地址
   */
  function browserReachableUrl(u) {
    const s = String(u || "");
    if (!s) return "";
    // 先补齐相对路径
    const abs = fixUrl(s);
    if (!/^https?:\/\//i.test(abs)) return abs;

    const base = currentKind() === "direct" ? serverBase() : proxyBase();
    if (!base) return abs;

    // 同源 ⇒ 已经是对的
    let uu, bb;
    try { uu = new URL(abs); bb = new URL(base); } catch { return abs; }
    if (uu.host === bb.host) return abs;

    // 主机名是「无域名后缀的短名」⇒ 容器内部名，浏览器解析不了
    const bareHost = uu.hostname;
    const looksInternal = bareHost && bareHost.indexOf(".") < 0 &&
                          bareHost !== "localhost" && bareHost !== "127.0.0.1";
    if (!looksInternal) return abs;

    // 只换「协议+主机+端口」，路径与查询串（含签名）原样保留
    const fromHost = uu.host;
    uu.protocol = bb.protocol;
    uu.hostname = bb.hostname;
    uu.port = bb.port;
    diag(`[url] 直链主机改写：${fromHost} → ${bb.host}（容器内名改为浏览器可达）`);
    return uu.toString();
  }

  /** 同步读当前通道（渲染时用；未探测过时按「有 serverUrl 就直连」乐观估计）*/
  function currentKind() {
    const base = serverBase();
    // ★ 无 node 能力 ⇒ 只可能是直连 ★
    //   必须放在读缓存之前：否则会话里一旦存过错误的 "proxy"，
    //   所有 iframe src / 下载链接都会被拼成 127.0.0.1:6810。
    if (!hasNode()) return "direct";
    if (!base) return "proxy";
    if (channelMemo && channelMemo.base === base) return channelMemo.kind;
    try {
      const raw = sessionStorage.getItem(CHANNEL_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.base === base) return o.kind;
      }
    } catch { /* ignore */ }
    return "direct";
  }

  /**
   * 异步取当前通道 —— 必要时会真的发一次探测请求。
   * 「测试连接」按钮用它，因为它需要拿到**准确**结果而不是乐观估计。
   */
  function currentKindAsync() {
    return pickChannel();
  }

  class ApiError extends Error {
    constructor(message, status = 0, kind = "api") {
      super(message);
      this.name = "ApiError";
      this.status = status;
      /** kind: api | network | proxy | auth */
      this.kind = kind;
    }
  }

  /* -------------------------------------------------------------------------
   * 底层请求
   * ---------------------------------------------------------------------- */
  let unauthorizedHandler = null;
  function setUnauthorizedHandler(fn) {
    unauthorizedHandler = fn;
  }

  async function parse(resp, reqPath = "") {
    const ct = resp.headers.get("content-type") || "";
    let data = null;
    let asText = false;
    try {
      if (ct.includes("application/json")) {
        data = await resp.json();
      } else {
        asText = true;
        data = await resp.text();
      }
    } catch (e) {
      // ★ 这里以前是静默 catch —— 结果「返回 undefined 而不是抛错」，
      //   排查时完全看不出发生过什么。现在写进诊断日志。
      data = null;
      try { diag(`[api] parse 失败 ct=${ct} err=${e && e.message}`); } catch { /* ignore */ }
    }

    try {
      // ★ 日志要克制 ★
      //   早期版本把整个响应体（最多 300 字符）都写进去，
      //   /api/list 返回 34 条目录时每行上千字符，几十次调用就把日志刷爆，
      //   真正有用的信息反而被淹没。
      //   现在只记「状态 + content-type + 关键字段摘要」。
      let brief = "";
      if (typeof data === "string") {
        brief = `text(${data.length})`;
      } else if (data && typeof data === "object") {
        const keys = Object.keys(data);
        const bits = [];
        if (data.entries) bits.push(`entries=${Array.isArray(data.entries) ? data.entries.length : "?"}`);
        if (data.mounts) bits.push(`mounts=${Array.isArray(data.mounts) ? data.mounts.length : "?"}`);
        if (data.username) bits.push(`username=${data.username}`);
        if (data.display) bits.push(`display=${data.display}`);
        if (data.path !== undefined) bits.push(`path=${data.path}`);
        brief = bits.length ? bits.join(" ") : keys.slice(0, 6).join(",");
      } else {
        brief = String(data);
      }
      diag(`[api] ${resp.status} ${reqPath} ct=${JSON.stringify(ct)} asText=${asText} ${brief}`);
    } catch { /* ignore */ }

    if (!resp.ok) {
      if (resp.status === 401) {
        if (unauthorizedHandler) unauthorizedHandler();
        const m = (data && (data.detail || data.error)) || "登录已过期，请重新登录";
        throw new ApiError(m, 401, "auth");
      }
      const detail =
        (data && (data.detail || data.error || data.message)) ||
        (typeof data === "string" && data.trim() ? data.trim().slice(0, 300) : "") ||
        `请求失败 (HTTP ${resp.status})`;
      // 502/403 来自本地代理本身，归为 proxy 类，便于界面给出不同提示
      const kind = resp.status === 502 || resp.status === 403 ? "proxy" : "api";
      throw new ApiError(detail, resp.status, kind);
    }
    return data;
  }

  /** 组装查询串 */
  function qs(params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) q.append(k, v);
    }
    const s = q.toString();
    return s ? "?" + s : "";
  }

  /* -------------------------------------------------------------------------
   * 签名直链缓存
   * --------------------------------------------------------------------------
   * 为什么需要：`downloadUrl()` 是**同步**的（渲染器要立刻给 img.src 赋值、
   * <a download> 要立刻设 href），但签名直链必须**请求后端**才有。
   *
   * 桥接办法：谁先 await 过 signedDownloadUrl()，就把结果缓存下来，
   * 后面的同步 downloadUrl() 直接命中同一条带签名的地址。
   * key 用 mount+path，value 记住过期时间（后端默认 ttl 3600s），
   * 留 60s 余量，避免把将过期的签名发出去。
   * ---------------------------------------------------------------------- */
  const rawUrlMemo = new Map();
  const RAW_TTL_SKEW_MS = 60 * 1000;

  function rememberRawUrl(mount, path, url) {
    // 从签名串里读 exp（秒）；读不到就按 55 分钟保守记
    let expMs = Date.now() + 55 * 60 * 1000;
    try {
      const m = /[?&]exp=(\d+)/.exec(String(url));
      if (m) expMs = Number(m[1]) * 1000;
    } catch { /* 用默认值 */ }
    rawUrlMemo.set(nodeKey(mount, path), { url: String(url), expMs });
  }

  function cachedRawUrl(mount, path) {
    const hit = rawUrlMemo.get(nodeKey(mount, path));
    if (!hit) return "";
    if (Date.now() > hit.expMs - RAW_TTL_SKEW_MS) {
      rawUrlMemo.delete(nodeKey(mount, path));
      return "";
    }
    return hit.url;
  }

  /** 给签名直链追加 inline 标记（预览用；下载时不要加，否则浏览器会内联打开）*/
  function withInline(url, inline) {
    const s = String(url || "");
    if (!inline || !s) return s;
    return s + (s.indexOf("?") >= 0 ? "&" : "?") + "inline=true";
  }

  /**
   * 进行中的 GET 请求表 —— 相同 URL 的并发请求合并成一次。
   *
   * ★ 为什么需要它 ★
   *   侧边栏面板在思源的「打开面板 / 切页签 / 恢复布局」时会被反复 init，
   *   每次都触发一遍 bootstrap → loadMounts → loadRoot → GET /api/list。
   *   实测踩过：18 秒内打出 1600+ 次 /api/list，把诊断日志刷爆、
   *   网盘连接数暴涨。
   *   这里做一个兜底：同一时刻对同一 URL 的 GET 只发一次，
   *   后来的调用共享同一个 Promise。请求结束后立即从表中移除，
   *   因此不会拿到过期数据（下一次调用仍是真实请求）。
   */
  const inflight = new Map();

  /**
   * 给请求补上跨域直连所需的头。
   *
   * ★ 只在直连通道下加 ★
   *   代理通道下代理自己持有服务端 Cookie，不需要也不应该看到 token。
   */
  function authHeaders(kind) {
    const h = { Accept: "application/json" };
    if (kind === "direct") {
      const t = getToken();
      if (t) h.Authorization = `Bearer ${t}`;
    }
    return h;
  }

  /**
   * 按当前通道拼出请求 URL。
   * 直连：http://<网盘>:8089/api/list?...
   * 代理：http://127.0.0.1:6810/api/list?...
   */
  async function resolveUrl(path) {
    const kind = await pickChannel();
    const base = kind === "direct" ? serverBase() : proxyBase();
    return { url: base + path, kind };
  }

  /**
   * 一次请求 + 自动处理「直连通道失效」。
   *
   * ★ 为什么要重试 ★
   *   通道探测发生在会话开始时，但 token 可能过期、后端可能重启、
   *   用户可能改了 serverUrl —— 这些都会让已缓存的 "direct" 失效。
   *   收到网络错误或 401 时清掉通道缓存重探一次：
   *     直连挂了 → 若代理可用，这次请求还能成功；
   *     代理也没了 → 抛出真实错误。
   *   只重试一次，避免死循环。
   */
  async function requestOnce(method, path, { params, bodyKind, onProgress } = {}) {
    const { url, kind } = await resolveUrl(path + (params ? qs(params) : ""));
    let resp;
    try {
      const init = { method, credentials: "omit", headers: authHeaders(kind) };
      if (bodyKind) init.body = bodyKind;
      resp = await fetch(url, init);
    } catch (e) {
      const target = kind === "direct" ? `网盘（${serverBase()}）` : "本地代理";
      throw new ApiError(
        `无法访问${target}（${e && e.message}）。请检查地址与网络，或确认插件代理已启动。`,
        0,
        kind === "direct" ? "network" : "proxy"
      );
    }
    return { resp, kind };
  }

  async function withChannelRetry(method, path, opts, onResponse) {
    try {
      const { resp, kind } = await requestOnce(method, path, opts);
      // 401 也可能是「直连 token 过期」——交给上层统一处理，不在这里重试，
      // 否则会变成「悄悄用代理拿到另一个会话」，语义混乱。
      return await onResponse(resp, path, kind);
    } catch (e) {
      if (e instanceof ApiError && (e.kind === "network" || e.kind === "proxy")) {
        // 通道级失败：作废缓存后重试一次，让 pickChannel 重新探测
        resetChannel();
        diag(`[channel] ${path} 失败（${e.kind}），重置通道后重试一次`);
        const { resp, kind } = await requestOnce(method, path, opts);
        return await onResponse(resp, path, kind);
      }
      throw e;
    }
  }

  async function apiGet(path, params) {
    const existing = inflight.get(path + qs(params));
    if (existing) return existing;
    const key = path + qs(params);
    const p = withChannelRetry("GET", path, { params }, (resp, p2) => parse(resp, p2));
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      // 无论成功失败都要清掉，否则后续请求会一直复用这个已结束的 Promise
      if (inflight.get(key) === p) inflight.delete(key);
    }
  }

  async function apiPost(path, fields) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) {
      if (v !== undefined && v !== null) fd.append(k, v);
    }
    return withChannelRetry("POST", path, { bodyKind: fd }, (resp, p2) => parse(resp, p2));
  }

  /**
   * 带进度的上传。
   * fetch 拿不到上传进度，只有 XHR 可以，所以这里单独用 XHR。
   */
  async function apiUpload(fields, file, onProgress) {
    const { url, kind } = await resolveUrl("/api/upload");
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields || {})) {
        if (v !== undefined && v !== null) fd.append(k, v);
      }
      fd.append("file", file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.withCredentials = false;
      if (kind === "direct") {
        const t = getToken();
        if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total, e.loaded, e.total);
      };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        if (xhr.status === 401 && unauthorizedHandler) unauthorizedHandler();
        const msg = (data && (data.detail || data.error)) || `上传失败 (HTTP ${xhr.status})`;
        reject(new ApiError(msg, xhr.status, xhr.status === 401 ? "auth" : "api"));
      };
      xhr.onerror = () => reject(new ApiError("网络错误，上传中断", 0, "network"));
      xhr.onabort = () => reject(new ApiError("上传已取消", 0, "network"));
      xhr.send(fd);
    });
  }

  /* -------------------------------------------------------------------------
   * 业务封装
   * ---------------------------------------------------------------------- */
  const API = {
    // ---- 会话 ----
    /**
     * 登录。直连通道下后端会回 `token`，这里顺手存下来供后续 Bearer 使用。
     *
     * ★ 为什么在业务层存 token、而不是在 apiPost 里 ★
     *   只有 /api/login 会下发 token（其它接口都不带）。
     *   放在这里职责最清楚：登录的副作用就是「建立会话」。
     */
    async login(username, password) {
      const r = await apiPost("/api/login", { username, password });
      if (r && r.token) {
        setToken(r.token);
        diag("[api] 已保存直连会话 token");
      }
      return r;
    },
    async logout() {
      // 两条通道都要清：代理由它自己删 cookie，直连则由我们删本地 token
      try { await fetch(proxyBase() + "/__session", { method: "DELETE" }); } catch { /* 代理可能没在跑 */ }
      setToken("");
      resetChannel();
      return true;
    },
    me: () => apiGet("/api/me"),

    /**
     * 会话状态（跨通道统一语义）。
     *
     * 代理通道：问代理 `__session`（它持有服务端 Cookie）
     * 直连通道：本地有没有 token + 能不能取到 `/api/me`
     *
     * ★ 以前只有代理版本 ★
     *   直连通道下代理可能压根没启动，去问 `__session` 永远是「无会话」，
     *   界面就会错误地弹登录框。所以必须按通道分流。
     */
    async hasSession() {
      const kind = await pickChannel();
      if (kind === "direct") {
        if (!getToken()) return { hasSession: false, channel: "direct" };
        try {
          await apiGet("/api/me");
          return { hasSession: true, channel: "direct" };
        } catch (e) {
          if (e && e.status === 401) return { hasSession: false, channel: "direct" };
          throw e;
        }
      }
      const r = await apiGet("/__session");
      return Object.assign({ channel: "proxy" }, r || {});
    },

    /** 代理自身的状态（是否已持有会话、上游错误）。仅代理通道有意义。 */
    proxyStatus: () => apiGet("/__ping"),

    // ---- 通道诊断（设置界面用）----
    /** 当前通道（同步，乐观估计） */
    currentKind,
    /** 当前通道（异步，会真探测） */
    currentKindAsync,
    /** 作废通道缓存，下次请求重新探测 */
    resetChannel,
    /** 网盘服务器地址 */
    serverBase,
    /**
     * 「打开网盘」深链构造器（任务③）。
     *
     * 挂在 API 上是因为 tree.js / viewer.js 也可能要用；
     * embed.js 是当前唯一的调用方（「打开网盘」按钮）。
     */
    webDiskUrl,
    /**
     * 轻量外壳页地址（NebulaDisk /lite 端点）。
     * 见上方函数注释：这是任务③（隐藏菜单栏）与任务⑤（中键不穿透）
     * **唯一真正生效**的通道 —— 靠自己造 blob 宿主页跨源是做不到的。
     */
    liteUrl,
    /**
     * 「容器内主机名 → 浏览器可达地址」改写器。
     *
     * ★ 为什么必须挂到 API 上 ★
     *   tree.js / viewer.js / embed.js 拿到的是 `plugin.api`（就是本对象），
     *   它们**要把后端下发的 raw 直链**（`http://nebula:8088/api/raw/...`）
     *   改写成浏览器能解析的地址。以前它们直接调 fixUrl()，但 fixUrl 对
     *   绝对地址原样返回 ⇒ 容器服务名泄漏到剪贴板/iframe，打开即失败。
     *   这个函数就是那个坑的统一出口，必须随 API 一起暴露。
     */
    browserReachableUrl,

    // ---- 浏览 ----
    list: (mount, path) => apiGet("/api/list", { mount, path }),
    stat: (mount, path) => apiGet("/api/stat", { mount, path }),

    /**
     * 递归搜索（任务㉑）。
     *
     * ★ 为什么必须要这个后端接口 ★
     *   原来的搜索是纯前端 applyFilter()，只过滤**已渲染出来的 DOM 节点**。
     *   文件树是懒加载的（点开一层才 /api/list 一次），所以
     *     · 没展开过的目录里的文件 → 前端根本不知道它们存在
     *     · 层级最深的文件 → 除非用户手动逐层点开，否则搜不到
     *   用户原话：「搜索需要对所有文档进行搜索，包含之前没有加载的。」
     *   ⇒ 只能让**后端**递归遍历目录树。已给 NebulaDisk 加了 GET /api/search。
     *
     * 参数：
     *   mount 挂载点名
     *   q     查询串（逗号/竖线/空格分隔多个关键词，OR）
     *   path  起始目录（默认盘根）
     * 返回： { ok, mount, base, terms, hits:[entry...], scanned, depthCapped, truncated }
     *   —— hits 的每一项与 /api/list 的 entries 同构，可直接喂给 makeNode。
     */
    search: (mount, q, path = "", limit = 500) =>
      apiGet("/api/search", { mount, q, path, limit }),

    // ---- 文件操作 ----
    mkdir: (mount, path, name) => apiPost("/api/mkdir", { mount, path, name }),
    rename: (mount, path, name) => apiPost("/api/rename", { mount, path, name }),
    remove: (mount, path) => apiPost("/api/delete", { mount, path }),
    move: (mount, path, target, isMove = true) =>
      apiPost("/api/move", { mount, path, target, move: String(!!isMove) }),
    extract: (mount, path, dest = "", overwrite = false) =>
      apiPost("/api/extract", { mount, path, dest, overwrite: String(!!overwrite) }),
    upload: apiUpload,

    // ---- 预览 ----
    /**
     * kkFileView 预览地址（已带代理前缀）
     *
     * ★ 前置参数校验（必须）★
     *   后端 /api/preview 的 mount / path 都是 FastAPI 的必填查询参数，
     *   少传一个直接回 422（detail: Field required）。历史上这里没校验，
     *   笔记里或调用方一旦漏参，控制台就会飘一条 422，看着像服务故障。
     *   这里提前挡掉并抛出可读错误，比让后端回 422 更清楚。
     */
    async previewUrl(mount, path) {
      requireMountPath("/api/preview", mount, path);
      const r = await apiGet("/api/preview", { mount, path });
      return { url: fixUrl(r.url), raw: fixUrl(r.raw) };
    },
    /** CAD 查看器深链（已带代理前缀） */
    async cadUrl(mount, path) {
      requireMountPath("/api/cad/preview", mount, path);
      const r = await apiGet("/api/cad/preview", { mount, path });
      return { url: fixUrl(r.url), raw: fixUrl(r.raw) };
    },
    /**
     * OnlyOffice 编辑器配置。
     *
     * ★ apiJs 必须是浏览器直连的绝对地址，不加代理前缀 ★
     *
     * ★★★ embed 参数（任务③）★★★
     *   后端 build_editor_config() 会用 HS256 对**整份 config** 签名
     *   （JWT payload = {documentType, document, editorConfig}，实测核对），
     *   且 compose 里 JWT_ENABLED=true ⇒ token 强校验。
     *   **前端改 config 的任何字段都会让 token 失效、编辑器白屏。**
     *   所以「嵌入块隐藏菜单栏」只能由后端在**签名之前**决定：
     *   传 embed=1 让后端下发精简版 customization。
     *
     * @param {string} mount
     * @param {string} path
     * @param {boolean} [embed] true ⇒ 请求「嵌入块精简版」配置（无菜单栏）
     */
    async ooConfig(mount, path, embed = false) {
      requireMountPath("/api/oo/config", mount, path);
      return apiPost("/api/oo/config", { mount, path, embed: embed ? "1" : "" });
    },
    ooHealth: () => apiGet("/api/oo/health"),
    kkHealth: () => apiGet("/api/kk/health"),
    cadHealth: () => apiGet("/api/cad/health"),

    /**
     * 「在浏览器里打开」应当用的地址（任务 #62）。
     *
     * ★ 调度器是模块级的 browserViewUrl()，这里只是把它挂到 API 上 ★
     *   为什么挂上来：viewer.js / tree.js 已经 `import { API }`，
     *   让它们直接调用 `API.browserViewUrl(...)` 比再加一条 import 更集中，
     *   也与 `API.previewUrl` / `API.signedRawUrl` 的用法保持一致。
     *
     * ★ 为什么不直接暴露模块级函数 ★
     *   两者都导出会导致 syntax.check.js 的检查④b（无人引用的导出）报死代码。
     *   这里保留模块级导出（因为它要给 test 用），并额外挂上 API 方法。
     */
    browserViewUrl: (mount, path, name) => browserViewUrl(mount, path, name),

    // ---- 直链 ----
    /**
     * 下载地址 —— **必须按当前通道选基点**（踩过的坑）。
     *
     * ★★★ 历史故障：这里原本写死 proxyBase() ★★★
     *
     *   `proxyBase()` 是 `http://127.0.0.1:<proxyPort>`，
     *   那是**本机桌面端**的内嵌代理。但 NAS 部署的思源是**浏览器直连**的，
     *   浏览器里 127.0.0.1 指的是**用户自己那台电脑**，根本没有代理进程 ——
     *   于是所有下载、图片/视频/音频/文本预览全变成
     *   `GET http://127.0.0.1:6810/api/download?… ERR_CONNECTION_REFUSED`。
     *
     *   （用户报的「下载会报错」、任务⑧「图片/视频/文本都打不开」，
     *     根因都是这一行。）
     *
     *   正确做法与 iframe / 直链一致：
     *     · 直连通道 ⇒ serverBase()，即 http://172.16.30.128:8089 ✓
     *     · 代理通道 ⇒ proxyBase()，即 http://127.0.0.1:6810（本机桌面端可达）✓
     *
     *   ★ 直连通道为什么不用 /api/download ★
     *     /api/download 认 Cookie 会话，而直连是**跨源**的
     *     （思源 :6806 → 网盘 :8089），拿不到 Cookie ⇒ 401。
     *     所以直连走 `/api/raw/<文件名>?mount=&path=&exp=&sig=` 签名直链，
     *     签名校验与 Cookie 无关，且后端对 raw 支持 Range（视频可拖进度）。
     *     签名值由后端 /api/preview 签发，这里通过 signedDownloadUrl() 拿。
     */
    downloadUrl(mount, path, inline = false) {
      if (currentKind() !== "direct") {
        // 代理通道：代理自己持有 jar 会话，直接打 /api/download 即可
        return proxyBase() + "/api/download" + qs({ mount, path, inline: inline ? "true" : undefined });
      }
      // 直连通道：优先用已缓存的签名直链（预热过就同步命中）
      const cached = cachedRawUrl(mount, path);
      if (cached) return withInline(cached, inline);
      // 没缓存 ⇒ 退回一条**通道正确但需预热**的地址。
      //
      // ★ 底线：绝不能拼出 127.0.0.1（那才是原始 bug）★
      //   此时返回 /api/download 直连地址：若后端为同源/已放行就用得上，
      //   否则调用方应当先 await warmRawUrl() 拿到签名直链。
      //   预览渲染器（图片/视频/音频/文本）都会先 await signedDownloadUrl()，
      //   所以正常路径不会走到这里。
      return serverBase() + "/api/download" +
        qs({ mount, path, inline: inline ? "true" : undefined });
    },

    /**
     * 异步版的下载地址（两条通道都能用）。
     *
     * - 代理通道 ⇒ 同 downloadUrl()，直接用 /api/download
     * - 直连通道 ⇒ 先问 /api/preview 拿签名，再拼 /api/raw
     *
     * 追加 `inline=1` 时让后端按 inline 下发（图片/视频/文本预览要用）。
     * 注意：raw 的 inline 语义由后端 `?inline=` 决定，沿用同一套参数名。
     */
    async signedDownloadUrl(mount, path, inline = false) {
      if (currentKind() !== "direct") {
        return proxyBase() + "/api/download" + qs({ mount, path, inline: inline ? "true" : undefined });
      }
      requireMountPath("/api/preview", mount, path);
      const r = await apiGet("/api/preview", { mount, path });
      const abs = browserReachableUrl(r.raw);
      if (!abs) throw new ApiError("后端未返回签名直链", 0, "api");
      // 存进缓存：这样随后的同步 downloadUrl() 也能拿到同一条签名直链
      // （渲染器里 src 赋值、<a download> 都是同步的，需要这个桥）
      rememberRawUrl(mount, path, abs);
      return withInline(abs, inline);
    },
    /**
     * 带签名的 raw 直链（浏览器可直接用，无需 cookie）—— 由预览接口下发。
     *
     * ★★★ 必须做「容器内主机名 → 浏览器可达地址」的改写（踩过的坑）★★★
     *
     *   后端 make_raw_url() 用的是 `_internal_origin()`，也就是
     *   `NEBULA_BASE_URL`（典型值 `http://nebula:8088`）：
     *
     *       http://nebula:8088/api/raw/xxx.doc?mount=..&path=..&exp=..&sig=..
     *
     *   这个主机名**只有 docker 网络里的 OnlyOffice / kkFileView 容器能解析**，
     *   浏览器（以及用户的其它电脑、手机）解析不了 `nebula` 这个名字 ——
     *   复制出来的直链粘到浏览器里就是 `ERR_NAME_NOT_RESOLVED`。
     *
     *   而 fixUrl() 对**已经是绝对地址**的串是原样返回的（它只补相对路径），
     *   所以这里必须显式改写主机，不能指望 fixUrl 兜住。
     *
     *   改写成什么：当前通道的**浏览器可达**基点。
     *     · 直连通道 ⇒ serverBase()，即 http://172.16.30.128:8089 ✓
     *     · 代理通道 ⇒ proxyBase()，即 http://127.0.0.1:6810（本机桌面端可达）✓
     *   签名在查询串里，换主机不影响校验，所以这样改是安全的。
     *
     * ★★★ download 参数（任务⑱，2026-09-23）★★★
     *
     *   用户最终确认的语义：
     *     · **右键菜单**的「复制直链」 = **打开**该文件（inline 渲染）—— 保持原样
     *     · **预览栏**的「复制直链」   = **下载**该文件（attachment）
     *
     *   两者文件名与签名格式完全相同，只差一个 dl 标记。后端 /api/raw
     *   新增了 dl 维度（见 nebula `routers/rawlink.py` 的 `_wants_download`）：
     *   dl 进入 HMAC 签名串，所以**不能在前端拼**，必须让后端签发。
     *
     *   ★ 为什么由后端签发而不是前端给 URL 追加 `&dl=1` ★
     *     签名覆盖 dl ⇒ 前端手动追加会让 sig 与实参不匹配 ⇒ 恒 403。
     *     （这一点已实测：v2 签名把 dl 并入 HMAC 输入。）
     *
     *   ★ 代理通道为什么也能用 ★
     *     代理通道下 /api/raw 同样是签名校验、不看 Cookie，因此 dl 一样有效；
     *     browserReachableUrl() 会把主机换成 proxyBase()。
     *
     * @param {string} mount
     * @param {string} path
     * @param {boolean} [download] true ⇒ 取「下载型」直链（Content-Disposition: attachment）
     */
    async signedRawUrl(mount, path, download = false) {
      requireMountPath("/api/preview", mount, path);
      const r = await apiGet("/api/preview", {
        mount,
        path,
        download: download ? "1" : undefined,
      });
      return browserReachableUrl(r.raw);
    },
  };

  /* -------------------------------------------------------------------------
   * 请求参数校验
   * ---------------------------------------------------------------------- */

  /**
   * 预览类接口的必填参数校验。
   *
   * 后端是 FastAPI，/api/preview、/api/cad/preview、/api/oo/config 的
   * mount 与 path 都是必填项，缺任意一个直接 422（Field required）。
   * 调用方漏参时让前端提前抛出可读错误，比在控制台看到 422 好排查得多。
   */
  function requireMountPath(api, mount, path) {
    if (!mount || typeof mount !== "string") {
      throw new ApiError(`${api}：缺少网盘参数（mount）`, 0, "param");
    }
    if (path === undefined || path === null || typeof path !== "string") {
      throw new ApiError(`${api}：缺少文件路径参数（path）`, 0, "param");
    }
  }

  /* -------------------------------------------------------------------------
   * 文件类型判断
   *
   * 与后端 files.route_of() 的语义对齐：后端返回 route 字段
   * （onlyoffice / kkfileview / download），前端优先用它；
   * 但侧边栏在没调后端时也要给图标，所以这里留一份前端判断。
   * ---------------------------------------------------------------------- */
  const OFFICE = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "odt", "ods", "odp", "rtf"]);
  const CAD = new Set(["dwg", "dxf", "dwf"]);
  const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
  const VIDEO = new Set(["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"]);
  const AUDIO = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]);
  const PDF = new Set(["pdf"]);

  /*
   * ★ 纯文本 / 代码 / 配置 ★（2026-09-23 扩充）
   *
   * 用户要求：「.txt 代码等类型的文件 走轻量文本直出」。
   *
   * 为什么把 txt 从 OFFICE 挪到这里 —— 三个理由：
   *   ① 用 OnlyOffice 打开一个 .txt 是**杀鸡用牛刀**：要拉起整个 OO 编辑器
   *      （几十 MB 的 iframe + 文档服务器往返），而文本只需一次 GET + <pre>。
   *   ② 用户是把它当**看**的对象（日志、清单、脚本），不是要"编辑"的对象。
   *   ③ 与后端 route_of 的偏差是可接受的：后端把 txt 归 onlyoffice 是因为
   *      OO 能编辑它；但前端「预览」语义下，直出更轻更快。
   *      ★ 想编辑仍可点「在页签中打开」，页签链路不受影响。
   *
   * 清单刻意做得很宽（含常见编程语言/配置/脚本/构建文件），因为
   * 「未知扩展名」走 download 是最差的结果 —— 用户连内容都看不到。
   * 宁可多列，不可漏列。
   */
  const TEXT = new Set([
    // 纯文本 / 标记
    "txt", "text", "log", "md", "markdown", "rst", "adoc", "tex",
    // 数据 / 配置
    "json", "jsonc", "json5", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf",
    "config", "properties", "env", "editorconfig", "gitignore", "gitattributes",
    "npmrc", "lock", "csv", "tsv", "diff", "patch", "sql", "graphql", "gql", "proto",
    // Web
    "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl", "vue", "svelte",
    "jsx", "tsx", "astro",
    // 编程语言
    "js", "mjs", "cjs", "ts", "mts", "cts", "py", "pyw", "ipynb", "java", "kt", "kts",
    "scala", "groovy", "gradle", "go", "rs", "rb", "php", "pl", "pm", "lua", "r",
    "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm", "cs", "vb", "swift",
    "dart", "jl", "ex", "exs", "erl", "hrl", "clj", "cljs", "hs", "lhs", "ml", "fs",
    "fsx", "nim", "zig", "v", "asm", "s", "pas", "f90", "f95", "groovy",
    // 脚本 / 运维
    "sh", "bash", "zsh", "fish", "ksh", "csh", "bat", "cmd", "ps1", "psm1", "psd1",
    "perl", "awk", "sed", "tcl", "dockerfile", "containerfile", "makefile", "mk",
    "cmake", "ninja", "tf", "tfvars", "hcl",
    // 其它文本类
    "srt", "vtt", "ass", "ssa", "po", "pot", "properties", "desktop", "service",
    "spec", "rules", "editorconfig", "babelrc", "eslintrc", "prettierrc",
  ]);

  const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]);

  function extOf(name) {
    const i = String(name || "").lastIndexOf(".");
    if (i <= 0) {
      // ★ 无扩展名的常见文本文件（Makefile / Dockerfile / LICENSE / README …）★
      //   它们 lastIndexOf(".") <= 0，若直接返回 ""，pickViewer 会判成 download
      //   ⇒ 用户看到「不支持预览」，但这明明是可读文本。
      //   这里按「完整文件名」识别，交给 pickViewer 的 TEXT 判定。
      const base = String(name || "").split("/").pop().split("\\").pop().trim().toLowerCase();
      if (!base) return "";
      // 对照表：无扩展名 → 视为该类文本
      const NOEXT = new Set([
        "makefile", "gnumakefile", "dockerfile", "containerfile", "vagrantfile",
        "rakefile", "gemfile", "brewfile", "procfile", "jenkinsfile",
        "license", "licence", "copying", "readme", "changelog", "authors",
        "notice", "install", "todo", "version", "hosts", "passwd", "fstab",
      ]);
      /*
       * ⚠️ 这里**不能**放 `cmakelists.txt` / `requirements.txt` 这类带点的名字。
       *   能走到本分支的前提就是 `name` 里没有点（`i <= 0`），
       *   放进来是永远匹配不到的死数据 —— 而它们本来就靠扩展名
       *   (`txt`) 被 TEXT 接住了，不需要在这里兜。
       */
      if (NOEXT.has(base)) return base;
      return "";
    }
    return name.slice(i + 1).toLowerCase();
  }

  /**
   * 决定用什么方式打开
   * @returns {"image"|"video"|"audio"|"pdf"|"office"|"cad"|"text"|"archive"|"download"}
   */
  function pickViewer(name) {
    const e = extOf(name);
    if (IMAGE.has(e)) return "image";
    if (VIDEO.has(e)) return "video";
    if (AUDIO.has(e)) return "audio";
    if (PDF.has(e)) return "pdf";
    if (CAD.has(e)) return "cad";
    if (OFFICE.has(e)) return "office";
    if (ARCHIVE.has(e)) return "archive";
    if (TEXT.has(e)) return "text";
    return "download";
  }

  /** 是否可用 OnlyOffice 在线编辑 */
  function isEditable(name) {
    return pickViewer(name) === "office";
  }

  /**
   * 算出「在**浏览器**里打开这个文件」应当用哪条地址（任务 #62）。
   *
   * ★★★ 为什么需要这个函数：`/api/raw` 是「字节通道」，不是「渲染通道」★★★
   *
   *   背景（2026-09-23 实测，用户的报障）：
   *     「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
   *       onlyoffice 预览一样 kkviewer 也一样。
   *       PDF 预览目前点击这个按钮是在网页中打开。」
   *
   *   原先 openInBrowser() 一律打开 `API.signedRawUrl()`（即 `/api/raw`）。
   *   实测各类型的响应头：
   *
   *     | 类型 | Content-Type                                              | 浏览器行为 |
   *     |------|-----------------------------------------------------------|-----------|
   *     | PDF  | application/pdf                                            | 内嵌打开 ✅ |
   *     | DOCX | application/vnd.openxmlformats-...wordprocessingml.document | 下载 ❌   |
   *     | STEP | model/step                                                 | 下载 ❌   |
   *     | DWG  | model/*                                                    | 下载 ❌   |
   *
   *   ⇒ **`Content-Disposition: inline` 一直都下发了（实测），它没错。**
   *     错的是目标地址的选择：浏览器**只内嵌渲染极少数 MIME**
   *     （pdf / 图片 / 视频 / 音频 / text）。Office、CAD 这类专用 MIME
   *     **浏览器没有渲染器**，即使 inline 也只能走下载。
   *     PDF 恰好是浏览器原生支持的 ⇒ 同一段代码只有 PDF「看起来是对的」。
   *
   * ★ 正确做法：按 pickViewer() 的**同一套路由**选「渲染通道」★
   *
   *   插件在**页签里**本来就已经按类型分流了（viewer.render 的 switch），
   *   这里的路由与之**一一对齐**，只是把结果换成「浏览器可直接打开的 URL」：
   *
   *     · pdf / image / video / audio / text → 原生类型，`/api/raw` 即可
   *       （browserReachableUrl 会把 nebula:8088 换成浏览器可达主机）
   *     · office / archive / 其它            → kkFileView `/preview/onlinePreview`
   *       （实测返回 text/html，内部自己去拉 raw 并转成 HTML —— 浏览器能看）
   *     · cad                                → cad-viewer 深链
   *
   * ★ 关于 OnlyOffice 为什么不走 OO ★
   *   OO **不是无状态查看页**：它需要一个 `document.key` + `callbackUrl`，
   *   每次打开都可能触发回调写回。用户要的是「看一眼」，不是「起一个编辑会话」。
   *   ⇒ 浏览器打开走 **kkFileView**（只读渲染、无副作用）更稳妥，
   *     与 viewer.renderKk() 的语义一致。
   *
   * ★ 为什么 office 不退回 raw ★
   *   raw 对 office 恒定为下载（就是本次 bug）。宁可给 kkFileView 页，
   *   哪怕 kkFileView 偶发慢（实测大 docx 首次转换会超过 20s），
   *   至少它**是在浏览器里打开**，符合按钮文案。
   *
   * @param {string} mount
   * @param {string} path
   * @param {string} [name] 文件名（不传则用 path 末段）
   * @returns {Promise<string>} 浏览器可打开的绝对地址
   */
  async function browserViewUrl(mount, path, name) {
    const nm = name || String(path || "").split("/").pop() || "";
    const kind = pickViewer(nm);

    // ① CAD：走 cad-viewer 深链（与 viewer.renderCad 同一条腿）
    if (kind === "cad") {
      const r = await apiGet("/api/cad/preview", { mount, path });
      const u = browserReachableUrl(r && r.url);
      if (u) return u;
      // 拿不到就退回 kk（kk 对 dwg 也能渲染）
    }

    // ② Office / 压缩包 / 未知：kkFileView 渲染页
    //    ③ 原生类型（pdf/image/video/audio/text）：也用 kk **只有当 raw 不可用时**；
    //       正常情况下原生类型走 raw（零转换、最快）。
    const NATIVE = kind === "pdf" || kind === "image" ||
                   kind === "video" || kind === "audio" || kind === "text";

    if (NATIVE) {
      try {
        // ★ 必须走 API.signedRawUrl（它是 API 对象的方法，不是模块级函数）★
        const abs = await API.signedRawUrl(mount, path);
        if (abs) return abs;
      } catch { /* 落到 kk 兜底 */ }
    }

    // ④ 默认 / 兜底：kkFileView 预览页
    const r = await apiGet("/api/preview", { mount, path });
    const u = browserReachableUrl(r && r.url);
    if (u) return u;
    throw new ApiError("后端未返回可预览的地址", 0, "api");
  }

  /* -------------------------------------------------------------------------
   * 显示格式化
   * ---------------------------------------------------------------------- */
  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }

  function humanTime(sec) {
    const n = Number(sec) || 0;
    if (!n) return "";
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* -------------------------------------------------------------------------
   * 文本解码
   * ---------------------------------------------------------------------- */

  /**
   * 智能解码文本：UTF-8 严格模式失败则依序回退（与 NebulaDisk 前端的策略一致）。
   *
   * ★ 2026-09-23 从 viewer.js 搬来 ★
   *   任务⑧ 给嵌入块加了「文本直出」（embed.js 的 renderNative），它也要用同一套
   *   解码逻辑。而 embed.js **不能** import viewer.js —— viewer.js 已经
   *   `import { insertEmbedIntoDoc } from "./embed.js"`，反向引用会形成**循环导入**。
   *   ⇒ 下沉到 api.js：两边都只依赖 api.js，无环。
   *
   * ★ 为什么要 `fatal: true` 逐编码回退，而不是直接 new TextDecoder()？★
   *   非 fatal 的 TextDecoder 遇到非法字节会**静默替换成 U+FFFD**，
   *   于是 GBK 文件（比如中文 Windows 上存的 .txt / .log）会被解成一堆乱码
   *   「�ҵ��豸」而不是报错——看起来像文件坏了。用 fatal 严格模式让 UTF-8 先
   *   「失败得很响亮」，再按概率顺序试 GBK / GB18030 / Big5，命中率最高。
   */
  function decodeSmart(arrayBuffer) {
    const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : new Uint8Array(arrayBuffer).buffer;
    const bytes = new Uint8Array(buf);

    const tryDecode = (enc) => {
      try {
        return new TextDecoder(enc, { fatal: true }).decode(bytes);
      } catch {
        // 该编码不认这些字节（或运行环境不支持该编码名）→ 换下一个
        return null;
      }
    };

    // BOM 优先：UTF-16 的 BOM 一旦被当 UTF-8 解，会整篇变成带 \u0000 的怪串
    if (bytes.length >= 2) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return tryDecode("utf-16le") ?? "";
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return tryDecode("utf-16be") ?? "";
    }
    // UTF-8 BOM：TextDecoder("utf-8") 会自动吃掉，无需特殊处理
    for (const enc of ["utf-8", "gbk", "gb18030", "big5", "utf-16le"]) {
      const t = tryDecode(enc);
      if (t !== null) return t;
    }
    // 兜底：非严格解码，保证一定返回字符串（乱码好过抛异常把预览层打挂）
    return new TextDecoder("utf-8").decode(bytes);
  }

  /**
   * 把「挂载点 + 路径」渲染成给人看的显示形式：`售前项目:/2026年08月/xxx.pdf`。
   *
   * ★★★ 为什么必须有这个函数（用户 2026-09-22 报的「多了一个 /」）★★★
   *
   *   用户截图：「26 复制路径 结果是  售前项目://托璞勒 宣传册.pdf  是不是多了一个/」
   *
   *   根因：各处都在写 `` `${mount}:/${path}` ``，而 **path 到底带不带前导斜杠
   *   是不确定的**。我查了活着的内核里两个真实 custom 块的 content：
   *       {"kind":"file","mount":"售前项目","path":"托璞勒股份-AI视觉.pdf"}      ← 无前导 /
   *       {"kind":"file","mount":"售前项目","path":"/FA&JG-项目评审会议规范要求.pdf"} ← 有前导 /
   *   同一个字段两种形状并存（早期代码没归一化，后来才加的）。
   *   于是「有前导 /」的那些就被拼成 `mount://path` —— 多一个斜杠。
   *
   *   ⇒ 结论：**不能在调用点假设 path 的形状**，必须在这里统一归一化。
   *     修复方式选"归一化"而不是"把 `:/` 改成 `:`"：
   *       光改分隔符，遇到"没有前导 /"的历史数据就会变成 `售前项目:托璞璞…`
   *       （冒号后直接贴文件名），同样难看。
   *     归一化对两种输入都给出唯一正确输出，是真正的不变量。
   *
   * @param {string} mount 挂载点名（如「售前项目」）
   * @param {string} path  路径，**带不带前导 / 都接受**
   * @returns {string} 形如 `售前项目:/a/b.pdf`；path 为空时返回 `售前项目:/`
   */
  function displayMountPath(mount, path) {
    const m = String(mount == null ? "" : mount).trim();
    let p = String(path == null ? "" : path).trim();
    // 统一：先把连续斜杠压成一个（防 `//a//b`），再保证恰好一个前导斜杠
    p = p.replace(/\/{2,}/g, "/");
    if (p && !p.startsWith("/")) p = "/" + p;
    // 末尾斜杠去掉（文件不该有；目录的尾斜杠也没有信息量）
    p = p.replace(/\/+$/, "");
    return `${m}:${p || "/"}`;
  }

  /**
   * 把「挂载点 + 目录路径」渲染成**面包屑**：`售前项目 / 2026年08月 / 盛元立库`。
   *
   * ★★★ 为什么另开一个函数，而不复用 displayMountPath（#54）★★★
   *
   *   用户 2026-09-23 报：「网格视图上面的初始路径显示为：/:售前项目 是不对的」。
   *
   *   实测（不是猜）：
   *     · displayMountPath("售前项目", "") 输出的是 `售前项目:/`
   *       —— 作为「完整路径」它没错（任务26/27 就是它修的，用户也确认过）。
   *     · 但拿它当**面包屑**就很难看：根目录显示成 `售前项目:/`，
   *       那个 `:/` 是"协议式"写法，放在一行导航文本里显得莫名其妙。
   *
   *   参照物是**网盘自己的 Web UI**（/opt/nebula/web/js/explorer.js 的 renderCrumbs）：
   *     根目录  ⇒ 只显示盘名（前面挂个硬盘图标）：`售前项目`
   *     进目录后 ⇒ 盘名 + 逐级段名，中间用 ` / ` 分隔：`售前项目 / 2026年08月`
   *   没有冒号、没有多余斜杠、根目录也不带尾巴。
   *
   *   ⇒ 所以这里给出与 Web UI 一致的渲染，网格面包屑专用。
   *     displayMountPath 继续服务「复制路径/标题/嵌入块」等需要完整路径的场景，
   *     两者职责不同，互不替换。
   *
   * @param {string} mount 挂载点名（如「售前项目」）
   * @param {string} path  目录路径，带不带前导 / 都接受；空 = 根目录
   * @returns {string} 根目录 → `售前项目`；子目录 → `售前项目 / a / b`
   */
  function displayCrumbPath(mount, path) {
    const m = String(mount == null ? "" : mount).trim();
    const p = String(path == null ? "" : path).trim();
    // 按 / 切段，丢掉空段（根 / 尾斜杠 / 连续斜杠都会产出空段）
    const segs = p.split("/").filter(Boolean);
    if (!segs.length) return m;              // 根目录：只显示盘名
    return [m, ...segs].join(" / ");
  }

  /**
   * 把 mount+path 合成一个稳定 key，便于树节点缓存。
   *
   * ★ 必须区分「根目录 "/"」和「没有 path（undefined / null）」★
   *   旧实现是 `${mount}::${path || "/"}`，于是 undefined、null、""、"/"
   *   四种值全部塌缩成同一个 key `${mount}::/`。后果很隐蔽：
   *   文件节点没有 path，它的 key 跟盘根的 key 恰好相同，
   *   于是「盘根已展开」这个状态被误判到文件节点上 → 文件节点被拿去
   *   expandNode → API.list(mount, undefined) → 后端当根目录返回，
   *   形成每秒几十次的重复请求（2026-09-22 实测日志刷屏）。
   *   现在给「无 path」单独一个哨兵值，杜绝别名。
   */
  function nodeKey(mount, path) {
    let p;
    if (typeof path === "string") {
      p = path.length ? path : "/";
    } else if (path === undefined || path === null) {
      p = "\u0000nopath";
    } else {
      p = String(path);
    }
    return `${mount}::${p}`;
  }
  return {
    __cjs: false,
    hasNode,
    serverBase,
    webDiskUrl,
    liteUrl,
    proxyBase,
    getToken,
    setToken,
    resetChannel,
    fixUrl,
    browserReachableUrl,
    currentKind,
    currentKindAsync,
    ApiError,
    setUnauthorizedHandler,
    apiGet,
    apiPost,
    apiUpload,
    API,
    extOf,
    pickViewer,
    isEditable,
    browserViewUrl,
    humanSize,
    humanTime,
    decodeSmart,
    displayMountPath,
    displayCrumbPath,
    nodeKey,
  };
})();

/* ===== src/icons.js ===== */
const __mod_icons = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  /* ==========================================================================
   * 图标
   * --------------------------------------------------------------------------
   * 思源内置图标用 <svg><use xlink:href="#iconXxx"></use></svg> 引用。
   * 自定义图标用 plugin.addIcons() 注册 <symbol>，然后同样用 #id 引用。
   *
   * ★★ 任务29（2026-09-23）：按**网盘风格**重做文件/文件夹图标 ★★
   *
   *   参考对象 = NebulaDisk 自己的 Web UI（容器内 /opt/nebula/web/js/icons.js）。
   *   那边是 Windows-11 资源管理器风格，两套图标分工明确：
   *     · UI 线性图标      —— 1.5px 描边、currentColor 上色（按钮/工具栏用）
   *     · 文件类型图标     —— **自带配色、不跟主题**：白纸底 + 折角 + 类型色 + 标记
   *
   *   之前插件的做法是「一个小色块 + 扩展名文字」（.nb-type-icon 是个 <span>
   *   带背景色），文件夹只是一个细细的描边 path —— 用户评价「太难看了」。
   *   现在**照搬网盘那套**：目录 = 琥珀色实心文件夹；
   *   文件 = 白纸+折角+类型色+字母/图形标记（W/X/P/PDF/MD/…）。
   *
   *   ★ 兼容性 ★
   *     对外 API 一个都没变（typeBadge / extOf / typeIconEl / CUSTOM_ICONS），
   *     只是 typeIconEl 返回的 DOM 从「<span>色块」变成了「<svg>彩色图标」。
   *     调用方一律走 appendChild，因此无需改动任何调用点。
   * ========================================================================== */

  /** 需要注册到思源的自定义 symbol（addIcons 用） */
  const CUSTOM_ICONS = `
  <symbol id="iconNebulaDisk" viewBox="0 0 32 32">
    <path fill="currentColor" d="M16 3.2c-4.2 0-7.7 2.8-8.9 6.6A6.4 6.4 0 0 0 7.4 22.4h2.3a1.2 1.2 0 0 0 0-2.4H7.4a4 4 0 0 1-.1-8 4 4 0 0 1 .5.03l1.2.16.4-1.14A6.7 6.7 0 0 1 16 5.6c3 0 5.6 2 6.5 4.7l.35 1.06 1.1.1a4.3 4.3 0 0 1 3.9 4.3 4.3 4.3 0 0 1-1.3 3.1 1.2 1.2 0 0 0 1.7 1.7A6.7 6.7 0 0 0 30.2 15.8a6.7 6.7 0 0 0-5.6-6.6A9.2 9.2 0 0 0 16 3.2Z"/>
    <path fill="currentColor" d="M13.1 16.3a1.2 1.2 0 0 1 1.7 0l.4.4V11a1.2 1.2 0 0 1 2.4 0v5.7l.4-.4a1.2 1.2 0 0 1 1.7 1.7l-2.6 2.6a1.2 1.2 0 0 1-1.7 0L13.1 18a1.2 1.2 0 0 1 0-1.7Z"/>
    <path fill="currentColor" d="M11 23.2a1.2 1.2 0 0 1 1.2-1.2h7.6a1.2 1.2 0 0 1 0 2.4h-7.6A1.2 1.2 0 0 1 11 23.2Z"/>
  </symbol>
  <!-- ★ 任务㉑：网格/列表视图切换图标 ★
       自绘而不是用思源内置的 iconGrid —— 内置图标名在不同思源版本里
       不一定存在（addIcons 里没有的 id，<use> 会渲染成空白，
       按钮就变成"点不动的空气"）。自己的 symbol 永远是稳的。 -->
  <symbol id="iconNbGrid" viewBox="0 0 32 32">
    <rect x="5" y="4" width="9.4" height="9.4" rx="1.6" fill="currentColor"/>
    <rect x="17.6" y="4" width="9.4" height="9.4" rx="1.6" fill="currentColor"/>
    <rect x="5" y="16.6" width="9.4" height="9.4" rx="1.6" fill="currentColor"/>
    <rect x="17.6" y="16.6" width="9.4" height="9.4" rx="1.6" fill="currentColor"/>
  </symbol>
  <symbol id="iconNbList" viewBox="0 0 32 32">
    <rect x="5" y="5" width="4.4" height="4.4" rx="1.1" fill="currentColor"/>
    <rect x="12.2" y="6" width="14.8" height="2.6" rx="1.3" fill="currentColor"/>
    <rect x="5" y="13.8" width="4.4" height="4.4" rx="1.1" fill="currentColor"/>
    <rect x="12.2" y="14.8" width="14.8" height="2.6" rx="1.3" fill="currentColor"/>
    <rect x="5" y="22.6" width="4.4" height="4.4" rx="1.1" fill="currentColor"/>
    <rect x="12.2" y="23.6" width="14.8" height="2.6" rx="1.3" fill="currentColor"/>
  </symbol>
  `;

  /* ==========================================================================
   * 一、文件类型图标（Windows 风格彩色文档）
   * --------------------------------------------------------------------------
   * 与网盘 Web UI 的 _paper()/_folder() 保持同一套画法，只是内联成字符串，
   * 由 typeIconEl() 解析成真实 <svg> DOM（思源插件里用 innerHTML 拼更省事，
   * 但 currentColor / 主题色那种场景仍需要 DOM，所以统一走 DOM 出口）。
   * ========================================================================== */

  /** 纸张底 + 折角 + 类型色里的自定义内容 */
  function _paperSvg(color, inner) {
    return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">`
      + `<path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h12L26 8.5v20a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 6 28.5z" `
      + `fill="#fff" stroke="${color}" stroke-width="1.4"/>`
      + `<path d="M19.5 2v5a1.5 1.5 0 0 0 1.5 1.5h5" fill="${color}" opacity=".22" `
      + `stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
      + inner
      + `</svg>`;
  }

  /** 琥珀色实心文件夹（与网盘 _folder('#e8a33d') 同一套路径） */
  function _folderSvg(color) {
    return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">`
      + `<path d="M2 7.5A2.5 2.5 0 0 1 4.5 5h6.2a2 2 0 0 1 1.6.8L14 8h13.5A2.5 2.5 0 0 1 30 10.5v14A2.5 2.5 0 0 1 27.5 27h-23A2.5 2.5 0 0 1 2 24.5z" `
      + `fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.5"/>`
      + `<path d="M2 12h28" stroke="${color}" stroke-width="1.2" opacity=".5"/>`
      + `</svg>`;
  }

  /** 纸张里一个字母标记（Word 的 W、Excel 的 X、PPT 的 P…） */
  function _letter(color, ch, size) {
    const s = size || 9.5;
    return `<text x="16" y="25" font-size="${s}" font-weight="700" fill="${color}" `
      + `text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif">${ch}</text>`;
  }

  /**
   * 类型 → svg 字符串。
   * ★ 配色沿用网盘的品牌色（Word 蓝 / Excel 绿 / PPT 橙红 …），
   *   这些是**内容语义色**，故意不跟随思源主题（资源管理器就是这么做的）。
   */
  const FILE_SVG = {
    folder: _folderSvg("#e8a33d"),

    doc: _paperSvg("#2b579a", _letter("#2b579a", "W")),
    xls: _paperSvg("#217346", _letter("#217346", "X")),
    ppt: _paperSvg("#c43e1c", _letter("#c43e1c", "P")),

    pdf: _paperSvg("#c8102e", _letter("#c8102e", "PDF", 8)),

    txt: _paperSvg("#5c6b7a",
      `<path d="M10 15h12M10 18.5h12M10 22h8" stroke="#5c6b7a" stroke-width="1.5" stroke-linecap="round"/>`),
    md: _paperSvg("#3b6ea5", _letter("#3b6ea5", "MD", 8)),

    code: _paperSvg("#7b3fa0",
      `<path d="M13 18l-3 3 3 3M19 18l3 3-3 3" stroke="#7b3fa0" stroke-width="1.6" `
      + `stroke-linecap="round" stroke-linejoin="round"/>`),

    image: _paperSvg("#0f7b0f",
      `<rect x="9.5" y="15" width="13" height="10" rx="1" stroke="#0f7b0f" stroke-width="1.4"/>`
      + `<circle cx="12.8" cy="18.2" r="1.3" fill="#0f7b0f"/>`
      + `<path d="M9.5 23.5l3.6-3.2 2.4 2.1 2.3-2 3.7 3.4" stroke="#0f7b0f" stroke-width="1.4" `
      + `stroke-linecap="round" stroke-linejoin="round"/>`),

    video: _paperSvg("#a4262c",
      `<rect x="9" y="15" width="14" height="10" rx="1.4" stroke="#a4262c" stroke-width="1.4"/>`
      + `<path d="M14.4 17.6 20 20l-5.6 2.4z" fill="#a4262c"/>`),

    audio: _paperSvg("#8764b8",
      `<circle cx="13" cy="23" r="2.2" stroke="#8764b8" stroke-width="1.4"/>`
      + `<circle cx="20" cy="21.4" r="2.2" stroke="#8764b8" stroke-width="1.4"/>`
      + `<path d="M15.2 23v-7.4l7-1.7v7.5" stroke="#8764b8" stroke-width="1.4"/>`),

    zip: _paperSvg("#b8860b",
      `<path d="M16 14.5v2M16 17.6v2M16 20.7v1.9" stroke="#b8860b" stroke-width="1.7" stroke-linecap="round"/>`
      + `<rect x="13.8" y="22.6" width="4.4" height="3.4" rx=".8" fill="#b8860b" fill-opacity=".3" `
      + `stroke="#b8860b" stroke-width="1.3"/>`),

    cad: _paperSvg("#0b6a8f",
      `<path d="M11 24 16 14.5 21 24z" stroke="#0b6a8f" stroke-width="1.4" stroke-linejoin="round"/>`),

    // 3D 模型（step/stl/obj/3mf/gltf…）—— 等轴测立方体
    model: _paperSvg("#00838f",
      `<path d="M16 13.6 24.5 18l-8.5 4.4L7.5 18z" stroke="#00838f" stroke-width="1.4" stroke-linejoin="round"/>`
      + `<path d="M7.5 18v5.6L16 28l8.5-4.4V18" stroke="#00838f" stroke-width="1.4" stroke-linejoin="round"/>`
      + `<path d="M16 22.4V28" stroke="#00838f" stroke-width="1.4"/>`),

    eml: _paperSvg("#4a5568",
      `<rect x="9.5" y="15.5" width="13" height="9.5" rx="1.1" stroke="#4a5568" stroke-width="1.4"/>`
      + `<path d="M9.8 16.3 16 20.4l6.2-4.1" stroke="#4a5568" stroke-width="1.4" stroke-linejoin="round"/>`),

    unknown: _paperSvg("#8a8a8a", ""),
  };

  /* -------------------------------------------------------------------------
   * 文件类型配色（保留原有 TABLE 结构 —— 单测与外部都在按 label/color 读）
   *   ★ 这里同时给出两个东西：
   *     · kind —— 决定用 FILE_SVG 里的哪一张图
   *     · label/color —— 兼容旧调用（typeBadge 的返回值契约没变）
   * ---------------------------------------------------------------------- */
  const TYPE_TABLE = [
    { exts: ["doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "wps"], kind: "doc", label: "DOC", color: "#2b579a" },
    { exts: ["xls", "xlsx", "xlsm", "xlt", "ods", "csv", "et"],          kind: "xls", label: "XLS", color: "#217346" },
    { exts: ["ppt", "pptx", "pptm", "pot", "potx", "odp", "dps"],        kind: "ppt", label: "PPT", color: "#c43e1c" },
    { exts: ["pdf"],                                                     kind: "pdf", label: "PDF", color: "#c8102e" },
    { exts: ["dwg", "dxf", "dwf"],                                       kind: "cad", label: "CAD", color: "#0b6a8f" },
    { exts: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso"], kind: "zip", label: "ZIP", color: "#b8860b" },
    { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff"],
                                                                          kind: "image", label: "IMG", color: "#0f7b0f" },
    { exts: ["mp4", "webm", "mkv", "mov", "avi", "m4v", "flv", "wmv"],   kind: "video", label: "VID", color: "#a4262c" },
    { exts: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"],          kind: "audio", label: "AUD", color: "#8764b8" },
    { exts: ["txt", "log", "ini", "conf", "properties"],                 kind: "txt", label: "TXT", color: "#5c6b7a" },
    { exts: ["md", "markdown"],                                          kind: "md", label: "MD", color: "#3b6ea5" },
    { exts: ["json", "xml", "yml", "yaml", "toml"],                      kind: "code", label: "CFG", color: "#7b3fa0" },
    { exts: ["js", "ts", "py", "java", "go", "rs", "c", "cpp", "h", "sh", "sql", "vue", "html", "css", "jsx", "tsx",
             "cs", "php", "rb", "bat"],                                  kind: "code", label: "SRC", color: "#7b3fa0" },
    { exts: ["step", "stp", "iges", "igs", "brep", "stl", "obj", "off", "ply", "wrl", "3mf", "amf",
             "3ds", "3dm", "dae", "fbx", "gltf", "glb", "fcstd", "bim", "ifc"],
                                                                          kind: "model", label: "3D", color: "#00838f" },
    { exts: ["eml", "msg"],                                              kind: "eml", label: "EML", color: "#4a5568" },
  ];

  /**
   * 取文件类型描述
   *   ★ 契约保持不变：仍然返回 { label, color }。
   *     额外多给一个 kind（内部用来挑 svg），旧调用方忽略它即可。
   * @param {string} ext 扩展名（小写，不带点）
   * @returns {{label:string,color:string,kind:string}}
   */
  function typeBadge(ext) {
    const e = String(ext || "").toLowerCase();
    if (!e) return { label: "?", color: "#9ca3af", kind: "unknown" };
    for (const row of TYPE_TABLE) {
      if (row.exts.includes(e)) return { label: row.label, color: row.color, kind: row.kind };
    }
    return { label: e.slice(0, 3).toUpperCase(), color: "#9ca3af", kind: "unknown" };
  }

  /**
   * 从文件名里取扩展名（小写、不带点）。
   *   "报告.PDF"  → "pdf"
   *   "a.tar.gz"  → "gz"
   *   "没有扩展名" → ""
   * ★ 点开头的隐藏文件（".gitignore"）不算有扩展名。
   */
  function extOf(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    if (i <= 0 || i === n.length - 1) return "";
    return n.slice(i + 1).toLowerCase();
  }

  /** 把一小段 svg 源码解析成真实 SVG 元素（不依赖 innerHTML 的 HTML 解析差异） */
  function svgFromString(src) {
    const wrap = document.createElement("div");
    wrap.innerHTML = src;
    const svg = wrap.firstElementChild;
    return svg || document.createElementNS("http://www.w3.org/2000/svg", "svg");
  }

  /**
   * 生成一个「文件/目录」图标 DOM。
   *
   * ★★★ 2026-09-23（任务25b）修了一个长期存在的真 bug ★★★
   *
   *   本函数签名一直是 `typeIconEl(ext)` —— 只吃**扩展名**。
   *   但 grid / 搜索结果两处调用写的是 `typeIconEl(e.name, e.isDir)`，
   *   传进来的是**整个文件名**。于是 typeBadge 拿着 "报告.pdf" 去比对
   *   TYPE_TABLE（里面是 "pdf"），永远匹配不上，退化到
   *   `label = 名字前 3 个字符`、颜色恒为灰。
   *
   *   ⇒ 现在做两件事：
   *     ① 参数宽容化：既能收 ext，也能收 (name, isDir) —— 传错也不再退化；
   *     ② 目录真正给一个文件夹图标。
   *
   * ★★★ 任务29（2026-09-23）★★★
   *   返回的 DOM 从「<span> 色块 + 文字」换成**网盘风格的彩色 <svg>**
   *   （目录 = 琥珀色文件夹；文件 = 白纸 + 折角 + 类型色 + 标记）。
   *   出口仍是 HTMLElement，调用方（grid / 搜索结果 / 文件树）不用改。
   *
   * @param {string}  extOrName 扩展名（推荐）或文件名（兼容旧调用）
   * @param {boolean} [isDir]   是否目录；传 true 时强制返回文件夹图标
   * @returns {HTMLElement}  <svg class="nb-type-icon …">
   */
  function typeIconEl(extOrName, isDir) {
    const raw = String(extOrName || "");

    // 目录：琥珀色实心文件夹
    if (isDir) {
      const svg = svgFromString(FILE_SVG.folder);
      svg.setAttribute("class", "nb-type-icon nb-type-icon--dir");
      return svg;
    }

    // ★ 兼容层：区分「传的是 ext」还是「传的是文件名」。
    //
    //   判据（简单可靠，不做玄学猜测）：
    //     · 扩展名里**不可能**有路径分隔符，也不可能有点 —— 有点的是文件名。
    //     · 含 "/" 或 "\" ⇒ 一定是文件名。
    //     · 含 "." 且不是以 "." 开头 ⇒ 一定是文件名（"报告.pdf" / "a.tar.gz"）。
    //     · 其余（"pdf" / "png" / "step" / ""）⇒ 就是扩展名，原样用。
    let ext = raw;
    if (raw.includes("/") || raw.includes("\\") || raw.lastIndexOf(".") > 0) {
      ext = extOf(raw);
    }

    const badge = typeBadge(ext);
    const svg = svgFromString(FILE_SVG[badge.kind] || FILE_SVG.unknown);
    svg.setAttribute("class", "nb-type-icon nb-type-icon--file");
    // 类型色额外挂到 style 上：便于 CSS 需要时（如整体低饱和）取用
    svg.style.setProperty("--nb-type-color", badge.color);
    return svg;
  }
  return {
    __cjs: false,
    CUSTOM_ICONS,
    typeBadge,
    extOf,
    typeIconEl,
  };
})();

/* ===== src/embed.js ===== */
const __mod_embed = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const serverBase = __mod_api.serverBase;
  const webDiskUrl = __mod_api.webDiskUrl;
  const liteUrl = __mod_api.liteUrl;
  const pickViewer = __mod_api.pickViewer;
  const decodeSmart = __mod_api.decodeSmart;
  const displayMountPath = __mod_api.displayMountPath;
  const typeIconEl = __mod_icons.typeIconEl;
  const extOf = __mod_icons.extOf;
  /* ==========================================================================
   * 笔记内无缝嵌入（需求 ③）
   * --------------------------------------------------------------------------
   * 目标：把「文件树或特定文件页面」嵌进笔记正文，实现笔记与文件管理一体化。
   *
   * 实现方式：注册一个**自定义块（NodeCustomBlock）**。
   *
   * ★★★ 思源自定义块的 markdown 语法是「三个分号」围栏，不是反引号 ★★★
   *
   *   ;;;siyuan-nebuladisk/nebuladisk
   *   {"kind":"tree","mount":"售前项目","path":"2026/某项目"}
   *   ;;;
   *
   *   渲染时思源把块内 .custom-block__content 交给本插件的渲染器，
   *   渲染器把内容替换成一个可交互的目录浏览器，或一个文件预览 iframe。
   *   所有网络请求都复用插件已建立的代理通道（src/proxy.js + src/api.js）。
   *
   * ⚠️ 历史 bug（已定位并修复）：
   *   早期实现用 ```` ```nebuladisk ```` 反引号围栏，但**反引号围栏在思源里
   *   只会生成普通代码块（type=c）**，永远不是 NodeCustomBlock，因此
   *   自定义块渲染器根本不会被触发，笔记里就一直显示成一坨裸 JSON。
   *   实测（思源 3.8.4，/api/filetree/createDocWithMd）：
   *     ```nebuladisk                        → type=c   （普通代码块）
   *     ;;;siyuan-nebuladisk/nebuladisk      → type=custom ✓
   *   且反引号写法的整个围栏（含 ``` 行）会被原样存进 kramdown。
   *
   * 为什么选「自定义块」而不是挂件（widget）：
   *   · 挂件是独立目录 + 独立 iframe 沙箱，与本插件的代理/登录态隔离，拿不到会话
   *   · 自定义块渲染由本插件进程直接负责，可以复用同一个代理与 cookie jar
   *   · 纯文本存储，跨设备同步、导出 Markdown 都不丢内容（最坏情况退化成一段 JSON）
   *
   * ★ 关于 iframe 与代理 ★
   *   代理端口 ≠ 思源端口，所以 iframe 内容仍是跨 origin。
   *   代理已剥离 X-Frame-Options / CSP，并改写内部资源地址为 /nb 前缀，
   *   因此可以正常嵌入显示。
   *
   * ★ 关于编辑冲突 ★
   *   嵌入的是「只读浏览视图」。用户在嵌入内容里做的操作不会同步回笔记；
   *   笔记里保存的只是「指向哪个目录/文件」这一层信息。
   *   这是刻意的：笔记该是可移植的文本，不该背负网盘的状态。
   * ========================================================================== */

  // ★ 跨模块依赖：网盘可达基点 ★
  //   「打开网盘」按钮要拼出 NebulaDisk **网页版**的地址。
  //   serverBase() 返回形如 http://172.16.30.128:8089 的**网盘地址**
  //   （来自插件设置 serverUrl）。
  //   ⚠️ 不要用 proxyBase() —— 那是 127.0.0.1:6810 的插件本地代理，
  //      不是网盘界面，网页端/手机端也连不上（任务②修的就是这个）。
  //   ⚠️ 也不要用 location.origin —— 那是思源自己的地址（6806）。
  /**
   * ★ 任务⑧（2026-09-23）：这里增加了 pickViewer 与 decodeSmart ★
   *   resolvePreviewUrl() 原来只按「扩展名数组」自己判 OFFICE / CAD，
   *   其余一律丢给 kkFileView ⇒ 图片/视频/音频/PDF/文本在嵌入块里全部
   *   绕道 kk 外壳（用户报的「图片在嵌入块里打不开」）。
   *   现在与 viewer.js 用**同一个** pickViewer() 判定，保证两条链路行为一致。
   *
   *   decodeSmart 是 renderNative() 的文本分支要用的（原文本解码 UTF-8/GBK 自动判）。
   *   ★ 曾漏配过一次：renderNative 里写了 `decodeSmart ? decodeSmart(buf) : …` 的
   *     兜底判断，于是**漏 import 时不会报错，只会在运行时静默降级**——
   *     页面上表现为「读取失败：decodeSmart is not defined」。
   *     靠真机跑一遍文本文件才发现（单测因为走了 falsy 分支而全绿）。
   *     ⇒ 教训：不要用 `typeof X !== 'undefined' ? X() : 兜底` 这种写法掩盖
   *        漏 import；真机验证必须覆盖每一个分支。
   */



  /**
   * ★ 最近一次「定位插入点」的逐步轨迹 ★
   *
   * locateInsertPoint() 是多级回退的，失败时必须能说清**卡在哪一级**，
   * 否则用户只能看到一句「找不到要插入的文档」，而他人明明开着文档 ——
   * 这种无从下手的报错是 2026-09-22 那一整轮排查的根源。
   * 这里把轨迹留在模块级，insertEmbedIntoDoc 失败时一并抛给调用方。
   * @type {string}
   */
  let lastLocateTrace = "";

  /* =========================================================================
   * 需求⑤：嵌入块的「按需加载」登记表
   * -------------------------------------------------------------------------
   * 用户原话：「需要考虑一下，什么时候这些插入的块载入？避免都是打开状态下，
   *           电脑性能、软件性能有影响。」
   *
   * 三层节流，从粗到细：
   *
   *   第 1 层 ─ 打开笔记时「一个都不加载」
   *     默认只渲染一个「点击预览」占位块。整整一篇嵌了 20 个文件的笔记，
   *     打开时对后端的请求数是 **0**。（见 renderPlaceholder）
   *
   *   第 2 层 ─ 手动控制加载（★ 任务④：不再自动收起 ★）
   *     由下面的 registry 实现。用户点开几个就是几个，互不干扰；
   *     之前「展开新的就自动收起旧的」已按用户要求删除（对照看两个文件很常用）。
   *     真要释放内存，用每个块自己的「收起」，或插件卸载时的 collapseAllOpenEmbeds()。
   *
   *   第 3 层 ─ 手动「收起」立即释放
   *     收起时销毁 iframe（iframe 一移除，浏览器就会回收它整个渲染上下文）
   *     并 revoke OnlyOffice 的 blob URL（否则那份 HTML 会一直挂在内存里）。
   *
   * 为什么不用 IntersectionObserver 做「滚到可视区才加载」：
   *   那会让「滚动 = 发请求」，用户在长笔记里上下滚两下就触发一串加载，
   *   反而更容易卡。显式点击是最可控、也最符合用户预期的方式。
   * ====================================================================== */

  /**
   * 当前所有「已展开」的嵌入块。
   *
   * ★★★ 任务④：从「每文档一个」改成「每个块一个」★★★
   *
   *   用户原话：「当前页面中，点击预览后，再点击其他预览，原来的就会收起。
   *             这个需要调整一下。」
   *
   *   历史实现是 `Map<docKey, {wrap, collapse}>` —— **每篇文档只记一个**，
   *   于是展开第二个时必然要把第一个顶掉。那是当初为了「避免一篇笔记里
   *   挂八个重型编辑器拖垮电脑」而做的节流。
   *
   *   实际用下来这个节流是错的：
   *     · 用户经常要「左边文档、右边表格」对照着看，第一个被强制收起很烦；
   *     · 展开/收起本身是有成本的动作，用户没点就不该动；
   *     · 真要省资源，「收起」按钮本来就在，用户自己控制就行。
   *
   *   现在改成 `Set<{wrap, collapse}>`：登记所有已展开的块，**互不干扰**。
   *   每个块在自己的「收起」里注销自己，所以集合不会无限增长。
   *
   *   ★ 注意：集合里可能残留已经从 DOM 上消失的块（思源切页签/重渲染块
   *     会直接丢掉 DOM，不会回调我们）。所以 collapseAllOpenEmbeds() 里
   *     要跳过 `!isConnected` 的项 —— 否则对一个孤儿节点调用 collapse
   *     会抛错，把后面的清理也带崩。
   *
   * @type {Set<{wrap: Element, collapse: Function}>}
   */
  const openEmbeds = new Set();

  /** 登记「我展开了」 */
  function registerOpenEmbed(self, collapse) {
    // 同一个块重复登记（先展开→收起→再展开）时，先清掉旧记录
    unregisterOpenEmbed(self);
    openEmbeds.add({ wrap: self, collapse });
  }

  /** 注销（收起时调） */
  function unregisterOpenEmbed(self) {
    for (const rec of Array.from(openEmbeds)) {
      if (rec.wrap === self) openEmbeds.delete(rec);
    }
  }

  /**
   * 收起**全部**已展开的嵌入块。
   *
   * ★ 任务④：这个方法现在不在「展开新块」时调用了 ★
   *   保留它是因为两个合法场景还需要「一键全收」：
   *     ① 思源切换/关闭文档、插件 unload 时释放内存
   *     ② 将来若加「全部收起」按钮
   */
  function collapseAllOpenEmbeds() {
    for (const rec of Array.from(openEmbeds)) {
      try {
        // ★ 跳过已经脱离 DOM 的孤儿：思源重渲染块时不会通知我们，
        //   对孤儿调 collapse 会抛错并中断后面的清理。
        if (!rec.wrap || !rec.wrap.isConnected) { openEmbeds.delete(rec); continue; }
        rec.collapse && rec.collapse();
      } catch (e) {
        console.log("[nebuladisk] [embed] 收起失败（忽略）: " + (e && e.message));
      }
    }
    openEmbeds.clear();
  }

  /**
   * 解析代码块内容
   * @param {string} content
   * @returns {{kind:"tree"|"file", mount:string, path:string, name?:string, height?:number}|null}
   */
  function parseEmbed(content) {
    const raw = String(content || "").trim();
    if (!raw) return null;

    // 期望是 JSON；容错处理「key=value 换行」的朴素写法
    let obj = null;
    if (raw.startsWith("{")) {
      try { obj = JSON.parse(raw); } catch { return null; }
    } else {
      obj = {};
      for (const line of raw.split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    if (!obj || !obj.mount) return null;

    const kind = obj.kind === "file" ? "file" : "tree";
    let p = String(obj.path || "");
    // ★ 容错：早期版本写的嵌入块 path 没有前导斜杠 ★
    //   后端 /api/preview 的 path 以 "/" 开头（如 "/a/b.pdf"），缺了就补上，
    //   这样历史笔记里已经插入的旧块也能正常渲染，不必让用户手动重建。
    if (p && !p.startsWith("/")) p = "/" + p;
    return {
      kind,
      mount: String(obj.mount),
      path: p,
      name: obj.name ? String(obj.name) : "",
      height: Number(obj.height) || 0,
    };
  }

  /** 序列化回代码块内容（插入笔记时用） */
  function stringifyEmbed(spec) {
    const o = {
      kind: spec.kind,
      mount: spec.mount,
      path: spec.path || "",
    };
    if (spec.kind === "file" && spec.name) o.name = spec.name;
    if (spec.height) o.height = spec.height;
    return JSON.stringify(o);
  }

  /* -------------------------------------------------------------------------
   * 渲染器
   *
   * 注册到 plugin.customBlockRenders[<plugin name>]
   *
   * 说明：目录浏览**不走 iframe**，而是直接调用代理 API 构建 DOM。原因：
   *   · 逐层交互需要与父文档通信，用 iframe 反而要多做一层消息桥
   *   · iframe 指向插件自身页面时，又多一层 origin 差异要处理
   * 只有「单个文件的完整预览」才用 iframe（复用 kkFileView 的渲染结果）。
   * ---------------------------------------------------------------------- */

  /** 生成一个「目录浏览器」DOM —— 不依赖 iframe，直接调代理 API 列目录 */
  function renderTreeBrowser(spec, plugin) {
    const wrap = document.createElement("div");
    wrap.className = "nb-embed nb-embed-tree";
    wrap.setAttribute("contenteditable", "false");
    wrap.dataset.nbEmbed = "tree";

    let currentPath = spec.path || "";

    const head = document.createElement("div");
    head.className = "nb-embed-head";
    head.innerHTML = `
      <span class="nb-embed-grip" title="按住拖动：调整本嵌入块在笔记中的位置">⠿</span>
      <span class="nb-embed-title">
        <svg><use xlink:href="#iconNebulaDisk"></use></svg>
        <span class="nb-embed-mount"></span>
        <span class="nb-embed-path"></span>
      </span>`;
    head.querySelector(".nb-embed-mount").textContent = spec.mount;
    const pathEl = head.querySelector(".nb-embed-path");

    const toolbar = document.createElement("span");
    toolbar.className = "nb-embed-tools";
    const upBtn = document.createElement("button");
    upBtn.className = "nb-embed-btn";
    upBtn.textContent = "↑ 上一级";
    upBtn.onclick = () => {
      const i = currentPath.lastIndexOf("/");
      currentPath = i < 0 ? "" : currentPath.slice(0, i);
      load();
    };
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "nb-embed-btn";
    refreshBtn.textContent = "刷新";
    refreshBtn.onclick = () => load();
    toolbar.appendChild(upBtn);
    toolbar.appendChild(refreshBtn);
    head.appendChild(toolbar);
    wrap.appendChild(head);

    // ★ 任务27：目录嵌入块也可拖动排序 ★
    makeEmbedDraggable(head.querySelector(".nb-embed-grip"), wrap, plugin);

    const list = document.createElement("div");
    list.className = "nb-embed-list";
    wrap.appendChild(list);

    async function load() {
      // ★ 任务26（第三轮/第四轮 · 真机截图定案）★
      //   头部是 `[盘符 .nb-embed-mount] + [路径 .nb-embed-path]` 并排显示，
      //   所以本元素**只放路径**。历史上这里写过两版错的：
      //     ① `:/${currentPath}`  → currentPath 已带前导斜杠 ⇒ `://`（用户报"多了一个 /"）
      //     ② `:${displayMountPath("", currentPath).slice(1)}` → 单斜杠对了，
      //        但仍带一个多余的冒号，跟文件嵌入的显示风格不一致
      //   现在与文件嵌入统一：只显示规范化后的路径，盘符交给 .nb-embed-mount。
      pathEl.textContent = currentPath ? displayMountPath("", currentPath).slice(1) : "";
      upBtn.style.visibility = currentPath ? "visible" : "hidden";
      list.innerHTML = `<div class="nb-embed-loading">加载中…</div>`;
      let data;
      try {
        data = await plugin.api.list(spec.mount, currentPath);
      } catch (e) {
        list.innerHTML = "";
        const err = document.createElement("div");
        err.className = "nb-embed-error";
        err.textContent = `读取失败：${e.message}`;
        list.appendChild(err);
        return;
      }
      const entries = data.entries || [];
      list.innerHTML = "";
      if (!entries.length) {
        list.innerHTML = `<div class="nb-embed-loading">（空文件夹）</div>`;
        return;
      }
      for (const e of entries) {
        const row = document.createElement("div");
        row.className = "nb-embed-row" + (e.isDir ? " is-dir" : "");
        const ico = document.createElement("span");
        ico.className = "nb-embed-ico";
        // ★ 任务25b ★ 以前这里是 emoji（📁 / 📄），与侧边栏/网格/选择器的
        //   彩色类型图标是两套视觉。用户要求「文件夹和文件图标需要调整一下」，
        //   所以统一走 typeIconEl()：目录给真正的文件夹图标，文件按扩展名给
        //   彩色徽标（PDF 红、3D 青、SRC 灰蓝…）。
        try {
          ico.appendChild(typeIconEl(e.ext || extOf(e.name), !!e.isDir));
        } catch { /* 图标失败不影响打开文件 */ }
        const nm = document.createElement("span");
        nm.className = "nb-embed-name";
        nm.textContent = e.name;
        const sz = document.createElement("span");
        sz.className = "nb-embed-size";
        sz.textContent = e.isDir ? "" : fmtSize(e.size);
        row.appendChild(ico);
        row.appendChild(nm);
        row.appendChild(sz);
        row.onclick = () => {
          if (e.isDir) {
            currentPath = currentPath ? `${currentPath}/${e.name}` : e.name;
            load();
          } else {
            plugin.openFile({
              mount: spec.mount,
              path: currentPath ? `${currentPath}/${e.name}` : e.name,
              name: e.name,
              ext: e.ext,
              size: e.size,
              mtime: e.mtime,
            }, { forceNew: true });
          }
        };
        list.appendChild(row);
      }
    }

    load();
    return wrap;
  }

  /**
   * ★★★ 任务27：嵌入块在笔记内「上下拖动排序」，拖动时视图跟随定位 ★★★
   *
   * 需求原话：「嵌入块可以上下拖动排序（笔记内），拖动的时候文档视图
   *           要跟着定位到这个嵌入块。」
   *
   * ── 拖动的是什么？不是 DOM，是**思源的块顺序** ──────────────────────
   *
   *   嵌入块在笔记里是一个 `type=custom` 的**真实块**（有 data-node-id）。
   *   如果把 .nb-embed 这个 div 在 DOM 里搬来搬去，只是个视觉假象：
   *   一刷新/一切页签，思源按内核里的块顺序重渲染，顺序就弹回去了。
   *   ⇒ 必须调内核 `/api/block/moveBlock {id, previousID, parentID}` 真的改顺序。
   *
   * ── 为什么要「视图跟随」────────────────────────────────────────────
   *
   *   moveBlock 之后块会被挪到别处，而编辑器的滚动位置不会自动跟。
   *   拖到文档末尾时块跑到屏幕外，用户看不到自己刚拖的结果，观感是"没生效"。
   *   ⇒ 每次落位后主动 scrollIntoView。
   *   （思源 v3.1.28 起 moveBlock 后会 ReloadProtyle 刷新编辑器，
   *     但**滚动位置仍不会自动跟随**，所以这里必须自己滚。）
   *
   * ── 落位判定：用「拖到了哪个兄弟块的哪半边」决定 previousID ──────────
   *
   *   拖动时监听 dragover，命中某个同级嵌入块的中线以上 ⇒ 插到它前面，
   *   中线以下 ⇒ 插到它后面。
   *   同级块的范围限定在**同一个文档**里、且都是本插件的嵌入块，
   *   避免把块挪进别的容器（moveBlock 对嵌套容器有额外校验，会失败）。
   *
   * @param {HTMLElement} handleEl 拖动手柄（放进头部）
   * @param {HTMLElement} wrapEl   整个嵌入块容器（用来找到自己 / 同级块）
   * @param {object} plugin        插件实例（取 api、日志）
   * @returns {{setDraggable: Function}}
   */
  function makeEmbedDraggable(handleEl, wrapEl, plugin) {
    /** 收集同一文档里的同级嵌入块（按 DOM 顺序 = 视觉顺序） */
    function siblingEmbeds() {
      const root = wrapEl.closest(".protyle-wysiwyg") || document;
      // 只取「直接挂在编辑区里」的嵌入块，排除嵌套在别的嵌入块里的
      return Array.from(root.querySelectorAll(".nb-embed"))
        .filter((el) => {
          // 排除自己内部嵌套的（避免把子块的 dragover 当成同级的）
          let p = el.parentElement;
          while (p && p !== root) {
            if (p.classList && p.classList.contains("nb-embed")) return false;
            p = p.parentElement;
          }
          return true;
        });
    }

    /** 找到承载本嵌入块的思源块（带 data-node-id 的最近祖先） */
    function ownBlockEl() {
      let p = wrapEl;
      while (p) {
        if (p.getAttribute && p.getAttribute("data-node-id")) return p;
        p = p.parentElement;
      }
      return null;
    }

    /** 同级思源块元素（带 data-node-id 的同层块） */
    function siblingBlockEls() {
      const self = ownBlockEl();
      if (!self || !self.parentElement) return [];
      return Array.from(self.parentElement.children)
        .filter((el) => el.getAttribute && el.getAttribute("data-node-id"));
    }

    async function kb(path, body) {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return r.json();
    }

    let dragging = false;

    handleEl.draggable = true;
    handleEl.classList.add("nb-embed-drag");

    handleEl.addEventListener("dragstart", (ev) => {
      dragging = true;
      handleEl.classList.add("is-dragging");
      wrapEl.classList.add("is-dragging");
      try {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", ownBlockEl() ? ownBlockEl().getAttribute("data-node-id") : "nb-embed");
      } catch { /* 忽略 */ }
      // 拖动期间禁止 iframe 抢事件（否则鼠标划到预览区就丢了 dragover）
      for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
        f.style.pointerEvents = "none";
      }
    });

    handleEl.addEventListener("dragend", () => {
      dragging = false;
      handleEl.classList.remove("is-dragging");
      wrapEl.classList.remove("is-dragging");
      for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
        f.style.pointerEvents = "";
      }
      clearMarks();
    });

    /** 清除所有落位提示线 */
    function clearMarks() {
      for (const el of Array.from(document.querySelectorAll(".nb-embed-drop-before, .nb-embed-drop-after"))) {
        el.classList.remove("nb-embed-drop-before", "nb-embed-drop-after");
      }
    }

    /**
     * 拖动到某个同级块的哪半边 ⇒ 决定 previousID。
     *
     * ★ 落位语义（已在 NAS 内核上实测确认，不猜）★
     *
     *   `/api/block/moveBlock {id, previousID}` 的语义是
     *   **把 id 移到 previousID 之后**（实测：C 移到 A 之后 ⇒ 顺序 …A,C…）。
     *   所以「插到某个块 X 之前」= 移到 **X 的前一个兄弟** 之后。
     *
     * ★ 为什么不做「插到文档最前面」★
     *
     *   当 X 已经是第一个兄弟时，它前面没有块 ⇒ 没有可用的 previousID。
     *   我试过「把当前的第一个块移到被拖块之后」的两步法，
     *   实测结果是错的（A 会落到倒数第二位，不是第一位）。
     *   ⇒ 与其塞一段会更错的补偿逻辑，不如把交互收敛到**永远成立**的形态：
     *     上半 ⇒ 插到 X 之前（要求 X 有前兄弟）；
     *     X 是第一个时，上半区**不响应**（等价于"已经是最前了"），
     *     用户想放最前，就拖到第二个块的上半区 —— 结果完全一样。
     *
     *   少一个分支，就少一类只在边界触发的 bug。
     */
    function resolveDropTarget(clientY) {
      const self = ownBlockEl();
      if (!self) return null;
      const blocks = siblingBlockEls()
        .filter((el) => el !== self && el.querySelector(".nb-embed"));
      if (!blocks.length) return null;

      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          if (clientY < r.top + r.height / 2) {
            // 上半区 ⇒ 插到 el 之前 = 移到 el 的前一个兄弟之后
            const prev = prevBlockOf(el);
            if (!prev) return null;   // el 已是第一个 ⇒ 无处可插
            return { previousID: prev.getAttribute("data-node-id") };
          }
          // 下半区 ⇒ 插到 el 之后
          return { previousID: el.getAttribute("data-node-id") };
        }
      }
      // 落在所有块之外（上方/下方留白）⇒ 不动
      return null;
    }

    function prevBlockOf(el) {
      let p = el.previousElementSibling;
      while (p && !(p.getAttribute && p.getAttribute("data-node-id"))) p = p.previousElementSibling;
      return p;
    }

    /** 执行落位（单次 moveBlock，语义已实测确认） */
    async function applyMove(clientY) {
      const self = ownBlockEl();
      if (!self) return;
      const target = resolveDropTarget(clientY);
      if (!target) return;

      const myId = self.getAttribute("data-node-id");
      if (target.previousID === myId) return;   // 拖到自己后面无意义

      const res = await kb("/api/block/moveBlock", { id: myId, previousID: target.previousID });
      if (!res || res.code !== 0) {
        try {
          console.log("[nebuladisk] [embed] moveBlock 失败: " + JSON.stringify(res && res.msg));
        } catch { /* 忽略 */ }
        return;
      }
      afterMoved();
    }

    /**
     * ★ 落位之后：让视图跟随到这个嵌入块 ★
     *   用 requestAnimationFrame 等内核把新结构渲染完再滚，
     *   否则滚动的是旧位置的盒子，滚完还是看不见。
     */
    function afterMoved() {
      const scroll = () => {
        try {
          const el = ownBlockEl() || wrapEl;
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch { /* 忽略 */ }
      };
      try {
        requestAnimationFrame(() => requestAnimationFrame(scroll));
      } catch {
        setTimeout(scroll, 50);
      }
    }

    // 在文档级监听拖动经过（比在每个兄弟块上挂 dragover 更稳，
    // 因为拖动时鼠标可能扫过空白/iframe 区域）
    document.addEventListener("dragover", (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      clearMarks();
      const self = ownBlockEl();
      if (!self) return;
      const blocks = siblingBlockEls().filter((el) => el !== self && el.querySelector(".nb-embed"));
      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          el.classList.add(ev.clientY < r.top + r.height / 2 ? "nb-embed-drop-before" : "nb-embed-drop-after");
          break;
        }
      }
    });

    document.addEventListener("drop", (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      dragging = false;
      handleEl.classList.remove("is-dragging");
      wrapEl.classList.remove("is-dragging");
      for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
        f.style.pointerEvents = "";
      }
      const y = ev.clientY;
      clearMarks();
      applyMove(y);
    });

    return {
      /** 允许外部（如设置项）开/关拖动 */
      setDraggable(on) {
        handleEl.draggable = !!on;
        handleEl.style.display = on ? "" : "none";
      },
    };
  }

  /**
   * 生成一个「单个文件」的嵌入视图。
   *
   * ★ 两条硬性要求（用户 2026-09-22 提出）★
   *
   *   ①「有的文件思源内置查看器不支持，要用 NebulaDisk 的网页来预览/编辑」
   *      ⇒ 预览**一律走 NebulaDisk 的预览链路**（plugin.api.previewUrl），
   *        它内部会按扩展名路由到 OnlyOffice / kkFileView / CAD 查看器，
   *        覆盖的格式远多于思源自带的 PDF/图片查看器。
   *        **绝不**把文件塞给思源自己的查看器。
   *
   *   ②「不要自动加载，点击预览」
   *      ⇒ 默认**只渲染一行文件信息 + 一个「点击预览」按钮**，
   *        不请求后端、不建 iframe。用户点一下才真正加载。
   *        这样一篇笔记里放十个嵌入块也不会一打开就并发十个预览请求
   *        （kkFileView 首屏要转换，十个一起转会明显卡）。
   *        加载后按钮变成「收起」，可以随时卸载 iframe 释放内存。
   */
  function renderFileEmbed(spec, plugin) {
    const wrap = document.createElement("div");
    wrap.className = "nb-embed nb-embed-file";
    wrap.setAttribute("contenteditable", "false");
    wrap.dataset.nbEmbed = "file";

    const head = document.createElement("div");
    head.className = "nb-embed-head";
    head.innerHTML = `
      <span class="nb-embed-grip" title="按住拖动：调整本嵌入块在笔记中的位置">⠿</span>
      <span class="nb-embed-title">
        <svg><use xlink:href="#iconNebulaDisk"></use></svg>
        <span class="nb-embed-mount"></span>
        <span class="nb-embed-path"></span>
      </span>`;
    head.querySelector(".nb-embed-mount").textContent = spec.mount;
    // ★ 任务26（四轮 · 真机截图定案）★
    //
    //  头部结构是：`[盘符元素 .nb-embed-mount] + [路径元素 .nb-embed-path]`
    //  两者**并排显示**。所以 .nb-embed-path 只能放**路径部分**，
    //  不能放 displayMountPath() 的完整返回（那个带盘符）。
    //
    //  历史三轮各自踩了一个坑，记下来免得再犯：
    //    ① 第一轮：`filePathRaw ? ":" + filePathRaw : ""`
    //       → path 带前导斜杠时拼出 `://`（用户报「多了一个 /」）
    //    ② 第二轮：`displayMountPath(spec.mount, filePathRaw)`
    //       → `://` 没了，但把盘符也塞进 path 元素 ⇒ 盘符显示**两次**
    //         （用户报「售前项目 售前项目:/托璞勒 宣传册.pdf」）
    //    ③ 本轮：只取 displayMountPath 的**斜杠之后**的部分，
    //       盘符交给 .nb-embed-mount 那份，两边各司其职。
    //
    //  ⚠️ displayMountPath("盘","") 返回 `盘:/` 而**不是**空串，
    //     所以必须先判空再调用，不能靠 `|| ""` 兜底（死兜底）。
    const filePathRaw = spec.path || spec.name || "";
    head.querySelector(".nb-embed-path").textContent =
      filePathRaw ? displayMountPath("", filePathRaw).slice(1) : "";

    const toolbar = document.createElement("span");
    toolbar.className = "nb-embed-tools";

    // ★★★ 任务①：「收起」前置到「在页签中打开」之前，且未预览时隐藏 ★★★
    //
    //   用户原话：「点击预览后出现的 收起按钮 放到在页签中打开 前面，
    //             没有预览前 隐藏，同时增加下载按钮。」
    //
    //   历史实现把「收起」建在 loadFrame() 里、挂在 frameBox（预览框）右上角，
    //   于是出现两个问题：
    //     · 按钮位置在预览区而不是工具栏，和「在页签中打开」不在一条线上
    //     · 按钮节点随 iframe 一起被 frameBox.innerHTML="" 干掉，
    //       收起/展开状态没法统一管理
    //   ⇒ 现在把「收起」固定在工具栏最左侧（第一个子元素），
    //     初始 display:none，只有真的加载出 iframe 之后才显示。
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "nb-embed-btn nb-embed-btn--collapse";
    collapseBtn.textContent = "收起";
    collapseBtn.title = "卸载预览内容，释放内存（不改变笔记里的嵌入块）";
    collapseBtn.style.display = "none";
    collapseBtn.onclick = () => renderPlaceholder("点击预览");
    toolbar.appendChild(collapseBtn);

    const openBtn = document.createElement("button");
    openBtn.className = "nb-embed-btn";
    openBtn.textContent = "在页签中打开";
    openBtn.onclick = () => plugin.openFile({
      mount: spec.mount, path: spec.path, name: spec.name || spec.path,
    }, { forceNew: true });
    toolbar.appendChild(openBtn);

    // ★ 任务①：新增「下载」按钮 ★
    //   必须异步拿**带签名的直链**：
    //     · 代理通道 ⇒ /api/download（代理持有 jar 会话）
    //     · 直连通道 ⇒ /api/raw?…&sig=…（跨源拿不到 Cookie，只能靠签名）
    //   旧代码用同步 downloadUrl()，直连时会拼出 127.0.0.1:6810
    //   ⇒ ERR_CONNECTION_REFUSED（用户报的「下载会报错」）。
    const dlBtn = document.createElement("button");
    dlBtn.className = "nb-embed-btn nb-embed-btn--download";
    dlBtn.textContent = "下载";
    dlBtn.title = "从 NebulaDisk 下载该文件";
    dlBtn.onclick = async () => {
      try {
        const url = await plugin.api.signedDownloadUrl(spec.mount, spec.path, false);
        const a = document.createElement("a");
        a.href = url;
        a.download = spec.name || (spec.path || "").split("/").pop() || "download";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) {
        console.log("[nebuladisk] [embed] 下载失败: " + (e && e.message));
      }
    };
    toolbar.appendChild(dlBtn);

    // ★ 「打开网盘」——跳到 NebulaDisk 自己的网页界面 ★
    //   需求原文：「有的文件思源内置查看器不支持，要用 nebuladisk 的网页，
    //             可以预览或编辑更多的文件格式」。
    //   嵌入块的 iframe 走的已经是 NebulaDisk 预览链路（OnlyOffice /
    //   kkFileView / CAD），但有些操作（浏览目录、上传、下载、多选、
    //   压缩包逐层进）只有**完整的网盘界面**才有。
    //
    // ★★★ 任务②：这里的地址曾经是错的（用户截图报的 bug）★★★
    //
    //   历史实现：`proxyBase() + "/?mount=…&path=…"`
    //   产出：    http://127.0.0.1:6810/?mount=售前项目&path=/…
    //
    //   三处都错：
    //     ① 主机错：proxyBase() 是**本地代理**（127.0.0.1:6810）。
    //        但「打开网盘」是要在浏览器里开**网盘网页版**，
    //        那在 serverUrl（http://172.16.30.128:8089）。
    //        桌面端 127.0.0.1 上恰好也有个代理在听，所以能开出一个页面，
    //        但那不是网盘界面（是代理），网页端/手机端则直接连接被拒。
    //     ② 端口错：6810 是插件代理端口，不是网盘端口（8089）。
    //     ③ 参数错（当时实测确认）：NebulaDisk 前端**当时**不解析这两个参数。
    //
    //   ⇒ 分两步修好：
    //     · 插件侧：用 serverBase()（浏览器可达地址），不再用 proxyBase()
    //     · 后端侧：**给 NebulaDisk 补上深链支持**（见下）
    //
    // ★★★ 任务③深链：现在带参数了，而且网盘真的会跳过去 ★★★
    //
    //   用户原话：「打开网盘 应该是 打开到对应嵌入块 对应文件所在的目录。」
    //
    //   我先把「网盘前端到底能不能深链」查清楚了（不猜）：
    //     四个 JS bundle 全是 locationSearch:false / locationHash:false /
    //     hashchange:false，四种候选 URL 形式都停在登录页。
    //     —— 但发现前端**已有现成能力**，只是没人从 URL 喂给它：
    //        Explorer.open(mountLabel, initialPath)
    //          └ navigate(win, S, initialPath || '/', {replace:true})
    //        而且同一映射已开窗时会 existing.opts.nav.go(initialPath)
    //        —— 原地跳转，不叠新窗口。
    //
    //   于是给网盘后端打了一个最小补丁（patch-deeplink.py）：
    //     app.js 的 enterDesktop() 末尾读一次 ?mount=&path= 交给 Explorer.open()。
    //   浏览器 E2E 已验证：面包屑落在目标目录、query 被 replaceState 清掉、
    //   未知盘名被拒、无参数时行为不变（6/0）。
    //
    //   ⇒ 所以这里重新带上参数，并且 path 用**文件所在目录**（不是文件本身）——
    //     网盘是文件管理器，落在目录上才能看到「这个文件在哪个位置」。
    const webBtn = document.createElement("button");
    webBtn.className = "nb-embed-btn";
    webBtn.textContent = "打开网盘";
    webBtn.title = "在浏览器中打开 NebulaDisk 网页版，并定位到该文件所在的目录";
    webBtn.onclick = () => {
      // ★ 用 serverBase()：那是**浏览器可达的网盘地址**（http://172.16.30.128:8089）
      //   绝不能用 proxyBase() —— 那是 127.0.0.1:6810 的插件本地代理。
      let base = "";
      try { base = serverBase(); } catch { /* 忽略 */ }
      if (!base) {
        // 没配 serverUrl 时退到 settings 上再从 location 推一次
        try {
          const st = window.__nebuladiskPlugin && window.__nebuladiskPlugin.settings;
          base = String((st && st.serverUrl) || "").trim();
        } catch { /* 忽略 */ }
      }
      if (!base) {
        console.log("[nebuladisk] [embed] 未配置网盘地址，无法打开网盘网页版");
        return;
      }

      // ★ 任务③：拼深链 —— 定位到「该文件所在的目录」★
      const url = webDiskUrl(base, spec.mount, spec.path);
      window.open(url, "_blank", "noopener");
    };
    toolbar.appendChild(webBtn);

    /* ★ 任务⑳：「定位到文件树」——
     *   用户原话：「点击插入后的嵌入块，右侧文档树转跳到这个路径所在位置。」
     *
     *   和「打开网盘」的区别：
     *     · 打开网盘  ⇒ 开**浏览器新页签**，去 NebulaDisk 网页版
     *     · 定位       ⇒ 在**思源内**把右侧 NebulaDisk 文件树展开并滚到该路径
     *   两个是不同需求，都要有。
     *
     *   实现：调 plugin 暴露的 revealTree(mount, path)（见 index.js），
     *   它转发到 TreePanel.revealPath()。插件没就绪/文件树没挂载时给个提示，
     *   不要让用户点了没反应。
     */
    const locateBtn = document.createElement("button");
    locateBtn.className = "nb-embed-btn nb-embed-btn--locate";
    locateBtn.textContent = "定位";
    locateBtn.title = "在右侧 NebulaDisk 文件树里定位到该路径";
    locateBtn.onclick = async () => {
      try {
        const fn = plugin.revealTree;
        if (typeof fn !== "function") {
          console.log("[nebuladisk] [embed] 插件未暴露 revealTree，无法定位");
          return;
        }
        const ok = await fn.call(plugin, spec.mount, spec.path);
        if (!ok) console.log("[nebuladisk] [embed] 文件树未能定位（可能需要先打开 NebulaDisk 面板）");
      } catch (e) {
        console.log("[nebuladisk] [embed] 定位失败: " + ((e && e.message) || e));
      }
    };
    toolbar.appendChild(locateBtn);
    head.appendChild(toolbar);
    wrap.appendChild(head);

    // ★ 任务27：文件嵌入块可拖动排序（拖动时视图跟随定位到本块）★
    makeEmbedDraggable(head.querySelector(".nb-embed-grip"), wrap, plugin);

    const frameBox = document.createElement("div");
    frameBox.className = "nb-embed-frame-box";
    wrap.appendChild(frameBox);

    /** 当前 iframe（null 表示还没加载） */
    let frame = null;
    /** 是否已在加载/已加载，避免重复请求 */
    let state = "idle"; // idle | loading | loaded
    /** OnlyOffice 用的 blob URL，需要在卸载时 revoke，否则内存泄漏 */
    let blobUrl = "";

    /** 释放 blob URL（每次卸载/重建 iframe 前都要调） */
    function releaseBlob() {
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch { /* 忽略 */ }
        blobUrl = "";
      }
    }

    /**
     * 按扩展名选预览链路 —— 目的是「能预览/编辑更多格式」。
     *
     *   · Office（doc/docx/xls/xlsx/ppt/pptx…）→ OnlyOffice：**可在线编辑**
     *     这是思源内置查看器做不到的（它只是只读渲染）。
     *   · 浏览器原生可直出的（图片/视频/音频/PDF/文本）→ **直出**（见下）
     *   · 其它（压缩包 / 3D / STEP / CAD / 未知）→ kkFileView / cad-viewer
     *
     * 拿不到 OnlyOffice 配置时自动降级到 kkFileView（后端 ooConfig 会抛错）。
     *
     * ★ 任务③/⑤：嵌入块是「轻量预览」—— 各链路都要收菜单栏 ★
     *
     *   Office ⇒ OnlyOffice 配置里下掉全部工具栏（见 liteOoConfig，
     *            必须由**后端在签名前**做，前端改不了，理由见 buildOoFrameUrl）
     *   其它   ⇒ 走 NebulaDisk 的 `/lite` 外壳页（见下方 api.liteUrl 注释）
     *
     *   ★★★ 为什么不再自己造宿主页（重要修正）★★★
     *     原先这里返回插件的 `buildLiteFrameUrl(...)`，即用 blob: 造宿主页、
     *     再往子 iframe 注入 CSS。**真机实测证明它不生效**：
     *       blob: 继承思源 origin (:6806)，预览页在 :8089 ⇒ 跨源
     *       ⇒ innerDocReadable === false ⇒ CSS/守卫都够不到子文档。
     *     现在改走服务端的 /lite —— 外壳页与预览页同在 :8089，
     *     同源才可能注入（实测 readable/hasCss/hasGuard 全 true）。
     *
     * ★★★ 任务⑧ 修复（2026-09-23）：图片/视频/音频/PDF/文本 必须「原生直出」★★★
     *
     *   问题（用户报的「图片在嵌入块里打不开」）：
     *     这个函数原来只分 OFFICE / CAD / **其余** 三支，**从不看 pickViewer()**，
     *     于是图片被当成「其它」塞进 kkFileView：
     *         /lite?kind=kk&target=%2Fpreview%2FonlinePreview%3Furl%3D<base64>
     *     多绕两层（/lite 外壳 → kk 的 onlinePreview → base64 里再套 /api/raw），
     *     而 kkFileView 对图片本就没有必要介入 —— 它只是个转发。
     *
     *   为什么必须改：**页签上的同类型文件是好的**（用户确认 + 真机实测）。
     *     viewer.js 的 render() 走 pickViewer() 分九类，图片走 renderImage()
     *     → `signedDownloadUrl(inline=1)` → 直接赋给 `<img>.src`，零转换。
     *     同一条正确链路，嵌入块却完全没接。**两条链路行为不一致**才是本质缺陷。
     *
     *   实测证据（headed Chrome 153，new Image() 真解码）：
     *     1329b53d….jpg → 1279×1706 ✅  提升机位置.bmp → 2420×884 ✅  1.png → 620×876 ✅
     *
     *   量化：共 **49 个扩展名**在嵌入块里被误路由
     *     image(9) / video(7) / audio(7) / text(25) / pdf(1)
     *
     *   改法：先过 pickViewer()，命中原生类型就返回 {kind:"native", media, url}，
     *         由 loadFrame() 建对应的 <img>/<video>/<audio>/<iframe>，
     *         **完全不经过 kkFileView**。
     *
     *   ★ 为什么 PDF 也归 native ★
     *     viewer.js 的 renderPdf() 目前仍走 renderKk()（注释说「部分环境内置
     *     PDF 插件不可用」）。但嵌入块场景下 /lite 外壳会再套一层 iframe，
     *     而浏览器原生 PDF 查看器本身就需要整个视口 —— 嵌入块里给个 iframe
     *     直连 /api/raw 反而更轻、更稳，且 <= 与页签行为不同是有意的：
     *     页签有 kk 的工具栏可用来翻页/下载，嵌入块只求「看到内容」。
     *     若本机浏览器确实不支持内联 PDF，用户仍可用「在页签中打开」。
     *
     *   ★ 文本为什么用 fetch 而不是 iframe ★
     *     /api/raw 返回的 content-type 是 text/plain（或具体 MIME），
     *     直接 iframe 会渲染成**一整片无换行折叠的裸文本**，且可能触发下载。
     *     页签里 renderText() 是 fetch + <pre>，嵌入块沿用同一做法（<pre> 带滚动）。
     */
    async function resolvePreviewUrl() {
      const name = spec.name || spec.path || "";
      const ext = String(name).slice(String(name).lastIndexOf(".") + 1).toLowerCase();
      const OFFICE = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "odt", "ods", "odp", "rtf"];
      const CAD = ["dwg", "dxf", "dwf"];
      const base = serverBase();

      /** 统一的「套 /lite 外壳」出口；拿不到就退回直连预览页（功能可用，只是收不掉菜单栏）。 */
      const wrap = (rawUrl, kind) => {
        const target = String(rawUrl || "");
        if (!target) return target;
        const lite = liteUrl(base, target, kind);
        if (lite) return lite;
        // 降级：/lite 不可用（老后端）或地址不合法 ⇒ 直连
        console.log("[nebuladisk] [embed] /lite 不可用，直连预览（菜单栏不会收起）");
        return target;
      };

      // ★★★ 任务⑧：浏览器能原生直出的类型，走直出，不碰 kkFileView ★★★
      //   放在 OFFICE 之前：这几类与 Office 集合**无交集**（已验证），
      //   但 pdf/txt 在别处可能被算作 Office 家族，这里先拦下更明确。
      const native = pickViewer(name);
      if (native === "image" || native === "video" || native === "audio" ||
          native === "pdf" || native === "text") {
        // 直连通道 ⇒ /api/raw?…&sig=…（跨源拿不到 Cookie，只能靠签名）
        // 代理通道 ⇒ /api/download?inline=true
        // inline=true 很关键：否则会带 Content-Disposition: attachment 触发下载
        const url = await plugin.api.signedDownloadUrl(spec.mount, spec.path, true);
        if (!url) throw new Error("后端未返回可用的直链");
        return { kind: "native", media: native, url };
      }

      if (OFFICE.indexOf(ext) >= 0) {
        // Office：优先 OnlyOffice（可编辑）
        //   后端返回结构（已核实 routers/onlyoffice.py）：
        //     { ok, config, apiJs, mode, title }
        //   —— 没有 documentServerUrl 字段；iframe 用 srcdoc 自建宿主页即可。
        try {
          // ★ 任务③：传 embed=1 让**后端**在签名前换成精简配置 ★
          //   （前端不能改 config —— token 签的是整份 config，见下方注释）
          const cfg = await plugin.api.ooConfig(spec.mount, spec.path, WANT_LITE_OFFICE);
          if (cfg && cfg.ok && cfg.config && cfg.apiJs && cfg.config.document) {
            return { url: buildOoFrameUrl(cfg, WANT_LITE_OFFICE), kind: "office", cfg };
          }
          console.log("[nebuladisk] [embed] ooConfig 返回不完整，降级 kkFileView");
        } catch (e) {
          // 忽略，降级 kkFileView
          console.log("[nebuladisk] [embed] OnlyOffice 不可用，降级 kkFileView: " + (e && e.message));
        }
      }

      if (CAD.indexOf(ext) >= 0) {
        try {
          const r = await plugin.api.cadUrl(spec.mount, spec.path);
          // ★★★ 任务31-rev（2026-09-23）：下面这段结论已被**实测推翻并纠正** ★★★
          //
          //  【曾经写在这里的错误结论】（任务31 第一版，已作废，留痕以防重犯）
          //     「查看器设置只在模块内部 Il.instance.settings，不是 localStorage，
          //       页面拿不到 ⇒ 只能 CSS display:none。」
          //  错在两处：
          //    ① 查错了 bundle。我读的是 cad-viewer-BAlsMkgn.js，而服务 /cad/ 的
          //       入口是 assets/main-CoLbfQ3X.js。
          //    ② 键名猜错。我往 localStorage["settings"] 写、发现无效，就断言
          //       「不读 localStorage」。真实键名见下。
          //
          //  【实测正确结论】
          //    main-CoLbfQ3X.js 的 App.setup 第一行就是：
          //        Qe.configure({ storageKey: "mlightcad.settings.cad-viewer" })
          //    存储类 Ms 用它当 localStorage 键读写；computeEffective() 里
          //        return { ...QL, ..._user, ..._session }
          //    默认表 QL = { isShowCommandLine:!0, isShowEntityInfo:!1, isShowRibbon:!0,
          //                  isShowToolbar:!0, isShowShortCutToolbar:!0,
          //                  isShowStats:!1, isShowCoordinate:!0, ... }
          //
          //    ⇒ 只要往 localStorage["mlightcad.settings.cad-viewer"] 写
          //      { isShowStats:false, isShowCommandLine:false, isShowEntityInfo:false,
          //        isShowRibbon:false, isShowToolbar:false, isShowShortCutToolbar:false,
          //        isShowCoordinate:false } 再加载，查看器**自己就不渲染**这些 UI
          //      （功能区/工具栏/坐标是 v-if 直接移除，不是 CSS 藏）。
          //
          //    而 /lite 与 /cad/ **同源**，所以由 /lite 在 iframe 之前播种即可。
          //    这正是「用户要的：通过 CAD viewer 设置来设置」。
          //    连左下角 canvas 上的 UCS 坐标轴也一起消失了（isShowCoordinate），
          //    那是 CSS 永远做不到的。
          //
          //  ⇒ 现在 CAD 走 /lite（kind=cad）；后端 pages.py 的 lite_shell 负责播种。
          //     CSS 那一组选择器退居**兜底**（老版本没有这些设置键时仍能盖住）。
          return { url: wrap(r.url, "cad"), kind: "cad" };
        } catch (e) { /* 降级 */ }
      }
      const r = await plugin.api.previewUrl(spec.mount, spec.path);
      // ★ 任务③：kkFileView 的 PDF/Office 分支是内嵌 PDF.js，自带一整套
      //   工具栏（#toolbarContainer 等）。嵌入块里同样要收掉。
      return { url: wrap(r.url, "kk"), kind: "kk" };
    }

    /**
     * ★★★ 任务③ 的重要限制：Office 的菜单栏**不能在前端隐藏** ★★★
     *
     * 需求原文：「嵌入块中 office、CAD 预览 隐藏所有菜单栏。」
     *
     * 曾经的（错误）做法：前端拿到 cfg 后改写
     *   cfg.config.editorConfig.customization.toolbar = false 等。
     *
     * 为什么不行 —— 后端 `integrations.build_editor_config()` 末尾有：
     *
     *     if settings.oo_secret:
     *         cfg["token"] = _sign(cfg)
     *
     * 解出 JWT payload 实测（2026-09-22，pptx 实测）：
     *
     *     payload = { documentType, document, editorConfig }   ← 就是整份配置
     *
     * 即 **token 对整份 config 做 HS256 签名**，而 compose 里
     * `JWT_ENABLED=true` ⇒ OnlyOffice 会强校验。
     * 前端改任何一个字段 ⇒ 签名与内容不一致 ⇒ OO 拒绝配置，编辑器白屏。
     *
     * ⇒ 结论：Office 的「嵌入块精简版」必须做在**后端签名之前**。
     *   做法：`/api/oo/config` 增加 `embed` 表单参数（0/1），
     *   `build_editor_config(..., embed=True)` 在签名前把
     *   customization 换成精简版。插件这里只负责**传参**，
     *   一字不改后端下发的 config。
     *
     * 下面这个函数保留为「是否要请求精简版」的判定，方便集中改开关。
     * 名字保留 embed 语义，避免调用点再散落判断。
     */
    const WANT_LITE_OFFICE = true;

    /* ------------------------------------------------------------------
     * ★★★ 为什么这里**没有** blob 宿主页了（2026-09-22 重要修正）★★★
     *
     * 这段代码原来在这里：用 URL.createObjectURL(new Blob([html])) 造一个
     * 宿主页，宿主页里 <iframe src=http://172.16.30.128:8089/preview/…>，
     * 再由宿主页的脚本往子 iframe 里注入隐藏 CSS + 中键守卫。
     * 它看起来完全合理，**但真机实测证明根本不生效**：
     *
     *   用 CDP 在真思源页面上量到（见 tools 里的 probe-origin）：
     *     hostSrcHead      = blob:http://172.16.30.128:6806/7d77a594-…
     *     innerOrigin      = http://172.16.30.128:8089
     *     innerDocReadable = false        ← ★ contentDocument === null ★
     *
     * 根因：blob: URL 继承的是**创建者**（思源，:6806）的 origin，
     * 而预览页由 NebulaDisk 提供（:8089）—— 两者**不同源**。
     * 跨源 ⇒ 宿主页拿不到子 iframe 的 document：
     *   · 隐藏菜单栏的 CSS        → 注入不到（任务③ 一直没真正生效）
     *   · 内层 document 的中键守卫 → 绑不上（任务⑤ 同样没生效）
     *
     * 而且这个错误**伪装得很好**：宿主页本身能加载、#nb-lite-frame 也在、
     * 隐藏 CSS 也写进了宿主页自己的 <style> —— 看上去一切正常，
     * 只有「子文档是否真的被改到」这一条是假的。静态读代码永远看不出来，
     * 必须真的进浏览器量 contentDocument 才能发现。
     *
     * ── 现在的做法 ────────────────────────────────────────────────
     * 把外壳页搬到**预览服务自己**的 origin 上：
     *   NebulaDisk 新增 GET /lite?kind=kk|cad&target=<本站相对路径>
     * （见 nebuladisk 的 app/routers/pages.py，函数 lite_shell）
     * 外壳页与 target 都在 :8089 ⇒ 同源 ⇒ contentDocument 可读
     * ⇒ CSS 与守卫都真正生效（实测 readable/hasCss/hasGuard 全 true）。
     *
     * 插件这边只需要拼地址：API.liteUrl(base, target, kind)，见 src/api.js。
     * ------------------------------------------------------------------ */

    /**
     *
     * ★★★ 为什么不用 data: URL（这是踩过的坑）★★★
     *
     *   最初写成 `iframe.src = "data:text/html,..."`，看着能用，其实不行：
     *   **data: URL 的 iframe 拿到的是 opaque origin（不透明源）**，
     *   于是里面：
     *     · `<script src="http://.../api.js">` 跨域加载被 CORS 拦
     *     · DocsAPI 内部对 OO 服务器的 fetch / iframe 嵌套 / postMessage
     *       全部因为「null origin」被拒
     *   表现就是白屏或 "OnlyOffice: 未知错误"。
     *
     * ★ 改为 blob: URL ★
     *   blob URL 继承**创建它的页面的 origin**（在这里就是思源页面的 origin：
     *   http://172.16.30.128:6806）。有真实 origin 之后：
     *     · 可以正常跨域加载 OO 的 api.js（它是 script 标签，不需要 CORS 头）
     *     · DocsAPI 发起的请求带上正常 Origin，OO 服务端能正常响应
     *   blob 用完要 revoke，这里在 iframe 卸载时由调用方负责。
     *
     * 注：OO 官方本身就是把编辑器放在 iframe 里的，所以这条路是正解。
     *
     * @param {object} cfg  后端 /api/oo/config 的返回体（**原样使用，不改一个字段**）
     * @param {boolean} [lite] 嵌入块精简模式：额外注入一段 CSS 兜底收掉
     *        OO 自己可能仍然渲染出来的边角（比如初始化的加载页留白）。
     *        注意：**真正的菜单栏隐藏是后端 embed=1 做的**，
     *        这里只是视觉收尾，不碰 cfg。
     */
    function buildOoFrameUrl(cfg, lite) {
      const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>html,body,#p{margin:0;padding:0;height:100%;width:100%;overflow:hidden}
  ${lite ? `
  /* ★ 任务③ 视觉收尾：OO 加载页/边角在嵌入块里多余的部分 ★
     只处理「外壳」，不碰编辑器内部（内部由后端精简 config 控制）。
     另：编辑区上方的浅灰留白来自 iframe 默认边框与外层 padding，
     这里一并归零，让预览真正贴着嵌入块边框。 */
  html, body { background: #fff !important; }
  #p { position: absolute; inset: 0; }
  #id_viewer, #viewport { padding: 0 !important; }
  ` : ""}
  </style>
  <script src="${cfg.apiJs}"><\/script></head>
  <body><div id="p"></div><script>
    var cfg = ${JSON.stringify(cfg.config)};
    cfg.width = "100%"; cfg.height = "100%";
    cfg.events = { onError: function(e){ document.body.innerHTML =
        '<pre style="color:#c00;padding:12px;white-space:pre-wrap">OnlyOffice: ' +
        ((e&&e.data&&e.data.errorDescription)||'未知错误') + '</pre>'; } };
    function boot(){ try { new DocsAPI.DocEditor("p", cfg); }
      catch(err){ document.body.innerHTML = '<pre style="color:#c00;padding:12px">'
        + err + '</pre>'; } }
    if (window.DocsAPI) boot();
    else { var s = document.querySelector("script"); s.onload = boot;
           s.onerror = function(){ document.body.innerHTML =
             '<pre style="color:#c00;padding:12px">api.js 加载失败：${cfg.apiJs}</pre>'; }; }
  <\/script></body></html>`;
      // blob: 继承思源页面的 origin（关键），data: 不行
      return URL.createObjectURL(new Blob([html], { type: "text/html" }));
    }

    /**
     * 渲染「未加载」时的占位：一行提示 + 一个「点击预览」按钮。
     */
    function renderPlaceholder(text) {
      state = "idle";
      frame = null;
      releaseBlob();          // ★ 卸载时回收 OO 的 blob URL
      // ★ 需求⑤：只要回到「未展开」状态，就从登记表里注销自己 ★
      //   放在这里而不是每个调用点，是为了保证「任何收起路径」都不会漏登记 —— 
      //   漏了会导致登记表里留着一个已经不在 DOM 里的死引用，
      //   下次展开别的块时去 collapse 它会抛错。
      unregisterOpenEmbed(wrap);
      frameBox.innerHTML = "";
      // ★ 任务①：回到未预览状态 ⇒ 隐藏工具栏里的「收起」★
      collapseBtn.style.display = "none";
      frameBox.classList.remove("is-loaded");

      const box = document.createElement("div");
      box.className = "nb-embed-placeholder";

      const btn = document.createElement("button");
      btn.className = "nb-embed-play";
      // 用 SVG 播放图标，避免 emoji 在各平台显示不一致
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14l11-7z"></path>
        </svg><span></span>`;
      btn.querySelector("span").textContent = text || "点击预览";

      const hint = document.createElement("div");
      hint.className = "nb-embed-placeholder-hint";
      // ★ 需求⑤：用大白话把「什么时候加载」讲清楚 ★
      //   用户明确说过没看懂原来的说法（「没有明白你的意思」），
      //   所以这里直接说人话：什么时候不加载、点了才加载、同一时刻只展开一个。
      hint.textContent = "打开笔记时不加载；点这里才加载（可同时展开多个，各自点「收起」卸载）";

      btn.onclick = () => loadFrame();
      box.appendChild(btn);
      box.appendChild(hint);
      frameBox.appendChild(box);
    }

    /** 渲染错误 */
    function renderError(msg) {
      state = "idle";
      frame = null;
      frameBox.innerHTML = "";
      frameBox.classList.remove("is-loaded");
      // ★ 任务①：出错时没有可收起的内容 ⇒ 隐藏「收起」★
      collapseBtn.style.display = "none";
      const box = document.createElement("div");
      box.className = "nb-embed-error";
      box.textContent = msg;
      frameBox.appendChild(box);
    }

    /**
     * ★ 任务⑧：原生直出渲染器 ★
     *
     * 与页签的 renderImage/renderVideo/renderAudio/renderText 对应，
     * 但**不共用代码** —— 两者宿主环境不同：
     *   · 页签挂在自己的 element 上，工具条由 Viewer 管
     *   · 嵌入块挂在 frameBox 上，且要参与「收起/展开」的 state 管理
     * 强行抽公共函数会让两边都变复杂，这里保持各自独立、行为对齐即可。
     *
     * @param {"image"|"video"|"audio"|"pdf"|"text"} media
     * @param {string} url 带签名的直链
     */
    function renderNative(media, url) {
      frameBox.innerHTML = "";

      if (media === "image") {
        const img = document.createElement("img");
        img.className = "nb-embed-image";
        img.alt = spec.name || spec.path || "图片";
        // ★ 不设 onerror 到 renderError：图片 404 时应保留工具栏，
        //   让用户还能点「下载」或「在页签中打开」自救。
        img.onerror = () => {
          frameBox.innerHTML = "";
          const box = document.createElement("div");
          box.className = "nb-embed-error";
          box.textContent = "图片加载失败（签名可能已过期，点「收起」后重新展开即可）";
          frameBox.appendChild(box);
        };
        img.src = url;
        frameBox.appendChild(img);
        return;
      }

      if (media === "video") {
        const v = document.createElement("video");
        v.className = "nb-embed-video";
        v.controls = true;
        v.preload = "metadata";
        // /api/raw 支持 Range ⇒ 可拖进度
        v.src = url;
        frameBox.appendChild(v);
        return;
      }

      if (media === "audio") {
        const box = document.createElement("div");
        box.className = "nb-embed-audio-wrap";
        const a = document.createElement("audio");
        a.controls = true;
        a.src = url;
        box.appendChild(a);
        frameBox.appendChild(box);
        return;
      }

      if (media === "pdf") {
        // ★ 为什么用 <iframe> 直连 /api/raw 而不是 /preview/onlinePreview ★
        //   嵌入块只求「看到内容」：浏览器内置 PDF 查看器零依赖、零转换。
        //   比 kk 少两层外壳（/lite → onlinePreview → pdf.js），更轻。
        //   ★ 注意：content-type 必须让浏览器愿意**内联**渲染 PDF。
        //     后端 /api/raw 的 inline 参数已保证这一点（实测 200 + application/pdf）。
        const f = document.createElement("iframe");
        f.className = "nb-embed-frame nb-embed-frame--pdf";
        f.src = url;
        frameBox.appendChild(f);
        return;
      }

      // text：fetch 后塞进 <pre>（与页签 renderText 一致）
      //   直接 iframe 文本会被压成一行、且可能触发下载，体验很差。
      const pre = document.createElement("pre");
      pre.className = "nb-embed-text";
      pre.textContent = "加载中…";
      frameBox.appendChild(pre);

      fetch(url, { credentials: "omit" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          /*
           * ★ 直接调用 decodeSmart，不要再写 `decodeSmart ? decodeSmart(buf) : …` ★
           *
           * 曾经的写法带了 falsy 兜底，结果**漏 import 时不报错**，只在运行时静默
           * 降级成 utf-8 硬解 —— 用户看到的是
           *   「读取失败：decodeSmart is not defined」
           * （更糟的是单测因为走兜底分支而全绿，真机才发现）。
           * 去掉兜底：漏 import 就该立刻 ReferenceError，暴露得越早越好。
           */
          pre.textContent = decodeSmart(buf);
          // 控制显示量：嵌入块里超长文本会撑爆高度，截断并提示
          const MAX = 20000;
          if (pre.textContent.length > MAX) {
            const total = pre.textContent.length;
            pre.textContent = pre.textContent.slice(0, MAX) +
              `\n\n……（共 ${total} 字符，已截断；完整内容请点「在页签中打开」）`;
          }
        })
        .catch((e) => {
          pre.textContent = `读取失败：${e.message}（可试「在页签中打开」）`;
        });
    }

    /** 真正去拿预览地址并建 iframe */
    async function loadFrame() {
      if (state === "loading" || state === "loaded") return;
      state = "loading";

      // ★ 校验块参数 ★
      //   后端 /api/preview 的 mount/path 都是必填，缺一个就回 422
      if (!spec.mount || !spec.path) {
        renderError("此嵌入块缺少「网盘/路径」参数。请删除后重新从侧边栏拖入。");
        return;
      }

      // ★★★ 任务④：展开新块时**不再**自动收起别的块 ★★★
      //
      //   用户原话：「当前页面中，点击预览后，再点击其他预览，原来的就会收起。
      //             这个需要调整一下。」
      //
      //   历史行为（已删除）：
      //     每个展开的嵌入块 = 一个 iframe，OnlyOffice 实例动辄几十上百 MB。
      //     当时的顾虑是「一篇笔记嵌 8 个文件全展开会拖垮电脑」，
      //     于是做了一个节流：同一篇文档里同时只允许展开 1 个，
      //     新的展开时先把旧的收起。
      //
      //   为什么这个节流要拿掉：
      //     · 用户实际要在同一篇文档里**对照看多个文件**（文档 + 表格 + 图纸），
      //       强制收起第一个是纯粹的干扰；
      //     · 展开/收起是用户主动动作，程序不该替他决定；
      //     · 真想省资源，工具栏上那个「收起」按钮就是出口，用户自己点。
      //
      //   现在多个嵌入块可以同时展开、互不干扰（见 openEmbeds 集合）。
      //   仍然由 registerOpenEmbed() 登记，供「全部收起」/ 插件卸载时统一释放。

      frameBox.innerHTML = `<div class="nb-embed-loading">加载中…</div>`;

      let resolved;
      try {
        // ★ 走 NebulaDisk 的预览链路 ★
        //   Office → OnlyOffice（可编辑）；其它 → kkFileView / CAD。
        //   覆盖格式远多于思源内置查看器 —— 这正是需求①。
        resolved = await resolvePreviewUrl();
      } catch (e) {
        renderError(`无法预览：${e.message}`);
        return;
      }
      const url = resolved && resolved.url;
      if (!url) { renderError("预览地址为空"); return; }

      frameBox.innerHTML = "";
      frameBox.classList.add("is-loaded");

      // ★★★ 任务⑧：原生直出（图片/视频/音频/PDF/文本）★★★
      //   不走 iframe，直接建对应元素 —— 与页签的 renderImage/renderVideo/
      //   renderAudio/renderText 行为一致，只是容器换成嵌入块的 frameBox。
      if (resolved.kind === "native") {
        renderNative(resolved.media, resolved.url);
        state = "loaded";
        // ★ 任务①：内容已就绪 ⇒ 显示工具栏里的「收起」★
        collapseBtn.style.display = "";
        registerOpenEmbed(wrap, () => renderPlaceholder("点击预览"));
        return;
      }

      frame = document.createElement("iframe");
      frame.className = "nb-embed-frame";
      // ★ 懒加载：iframe 本身就是用户点击后才建的，这里再叠一层 native lazy ★
      frame.loading = "lazy";
      frame.src = url;
      frame.setAttribute("allowfullscreen", "true");
      // ★ 任务③：轻量化 —— iframe 只保留必要的权限，不做全屏以外的放行 ★
      frame.setAttribute("allow", "fullscreen");
      frame.onload = () => { state = "loaded"; };
      frameBox.appendChild(frame);
      state = "loaded";
      // ★ 任务①：预览已就绪 ⇒ 显示工具栏里的「收起」★
      collapseBtn.style.display = "";

      // 登记：告诉登记表「我在展开」
      //   ★ 任务④：登记表**不再**用于自动收起别的块（用户明确要求取消），
      //     只保留「统一收起 / 插件卸载时统一释放」的用途。
      registerOpenEmbed(wrap, () => {
        // 统一收起时，同样要真正卸载
        renderPlaceholder("点击预览");
      });
    }

    // ★ 需求②：默认不加载，只显示「点击预览」
    //   旧块没补 path 的先补上（只影响按钮文案，不发请求）
    if (!spec.path && spec.name) spec.path = spec.name.startsWith("/") ? spec.name : "/" + spec.name;
    renderPlaceholder("点击预览");

    return wrap;
  }

  /* -------------------------------------------------------------------------
   * 注册入口
   *
   * ★★★ 关键：customBlockRenders 的键是「块类型」，不是插件名 ★★★
   *
   *   思源 main.js 里的真实逻辑（v3.8.4，已逐字核实）：
   *
   *     const h = info => {                       // 解析 data-info
   *       const i = info.indexOf("/");
   *       if (i < 1 || i !== info.lastIndexOf("/") || i === info.length - 1) return;
   *       const pluginName = decodeURIComponent(info.slice(0, i));
   *       const blockType  = decodeURIComponent(info.slice(i + 1));
   *       if (pluginName && blockType) return { pluginName, blockType };
   *     };
   *     const parsed = h(element.getAttribute("data-info") || "");
   *     const owner  = parsed && plugins.find(p => p.name === parsed.pluginName);
   *     const render = parsed ? owner?.customBlockRenders[parsed.blockType]?.render : undefined;
   *
   *   而 data-info 是内核从块内容推导出来的，推导规则（同 v3.8.4 前端）：
   *
   *     const l = (pluginName, blockType) =>
   *       `${encodeURIComponent(pluginName)}/${encodeURIComponent(blockType)}`;
   *
   *   ⇒ 所以块内容必须写成：
   *
   *       ;;;<插件名>/<块类型>
   *       {...}
   *       ;;;
   *
   *     其中 **插件名/块类型 恰好一个斜杠**。
   *
   *     ;;;nebuladisk                      ← h() 返回 undefined ⇒ 不渲染，裸 JSON
   *     ;;;plugin/siyuan-nebuladisk/demo    ← 两个斜杠 ⇒ h() 同样拒绝
   *     ;;;siyuan-nebuladisk/nebuladisk     ← 正确 ✓
   *
   *   注意：前端另有一个 `plugin/<name>/<type>` 三段式 helper（gV），
   *   但那只用于 command 快捷键 id（`(0,gV)(plugin.name, cmd.langKey)`），
   *   **与自定义块无关**，别被它误导。
   *
   *   为了同时兼容历史笔记，这里把同一个渲染器注册到两个块类型键上：
   *     · "nebuladisk"        ← 主键（;;;siyuan-nebuladisk/nebuladisk）
   *     · "siyuan-nebuladisk" ← 兼容极端历史写法
   * ---------------------------------------------------------------------- */

  /** 自定义块的「块类型」标识（data-info 斜杠后面的部分） */
  const BLOCK_TYPE = "nebuladisk";


  /** 历史遗留的备选块类型键（旧笔记里可能出现的写法） */
  const LEGACY_BLOCK_TYPES = ["nebuladisk"];

  /**
   * 生成写入笔记用的完整 data-info 串：`<插件名>/<块类型>`
   * @param {string} pluginName
   * @returns {string}
   */
  function embedLang(pluginName) {
    return `${pluginName || "siyuan-nebuladisk"}/${BLOCK_TYPE}`;
  }

  /**
   * 生成要插入笔记正文的**自定义块 markdown**（三引号分号围栏）。
   *
   * ★ 必须用 `;;;` 围栏，不能用反引号 ```` ``` ```` ★
   *   反引号只会生成普通代码块（type=c），自定义块渲染器不会被调用。
   *
   * @param {string} pluginName 插件名（data-info 的前半段）
   * @param {object} spec       嵌入参数（kind/mount/path/name/height）
   * @returns {string}
   */
  function buildEmbedMarkdown(pluginName, spec) {
    const md = `;;;${embedLang(pluginName)}\n${stringifyEmbed(spec)}\n;;;\n`;
    // ★ 自检：围栏必须顶格 ★
    //   实测（v3.8.4）围栏前多任何一个字符都会退化成 type=p 普通段落，
    //   笔记里就显示成一坨裸 JSON。这里断言一下，任何改动把它弄歪都会立刻暴露。
    if (!md.startsWith(";;;")) {
      throw new Error(`嵌入块 markdown 非法（围栏未顶格）：${JSON.stringify(md.slice(0, 40))}`);
    }
    return md;
  }

  /* -------------------------------------------------------------------------
   * ★★★ 嵌入块的「唯一插入通道」：内核 API ★★★
   *
   * ★ 为什么三处插入点都要走这里，而不能各写各的 ★
   *
   *   2026-09-22 在 NAS 实测发现：**前端 `protyle.insert(md)` 会把 `;;;`
   *   围栏存成普通段落（type=p）**，内核永远不会把它编译成 NodeCustomBlock。
   *   症状就是「笔记里显示一坨裸 JSON」，而且**桌面端偶发正常、浏览器端必然坏**
   *   —— 这正是「本地思源能看、NAS 网页端不行」的根因。
   *
   *   ⇒ 插入自定义块**一律**走 `/api/block/insertBlock {dataType:"markdown"}`，
   *     由内核用 lute 完整解析。
   *
   * ★ 为什么抽成一个函数 ★
   *   历史上插入点散落在三处（斜杠菜单、侧边栏、预览页），每处各写一遍，
   *   结果修了两处漏了一处 —— 用户点的是漏的那一处，白修。
   *   ⇒ 统一收敛到这里，**新增插入点必须调它**，不要再手写 protyle.insert。
   *
   * @param {object} plugin  插件实例（用来取名字、日志）
   * @param {any} protyle    当前编辑器（可为 null，会用 DOM 兜底找光标）
   * @param {object} spec    嵌入参数
   * @returns {Promise<boolean>} 是否插入成功
   * ---------------------------------------------------------------------- */

  /** 容器块类型：不能直接当 parentID 用，要往上挪一层 */
  const BOXED_TYPES = ["i", "l", "b", "s", "callout", "blockquote", "sb", "h", "t"];

  /** 从嵌入块 markdown 里抠出 JSON 正文（重建时用） */
  function extractJson(md) {
    const lines = String(md || "").split(/\r?\n/);
    const body = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === ";;;") break;
      body.push(lines[i]);
    }
    return body.join("\n").trim();
  }

  /** 内核 API 的薄封装（与 index.js 里风格一致，不引依赖） */
  async function kb(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  async function locateInsertPoint(protyle, anchorEl) {
    const dbg = [];
    let blockId = "";   // 光标所在的块（想插到它后面）
    let docId = "";     // 目标文档 id（插到文档末尾的兜底）
    let src = "";       // 命中的来源，用于诊断

    // ── 环境探针：失败时这几行就能说明问题 ──────────────────────────────
    try {
      if (typeof document !== "undefined") {
        const pf = document.querySelector(".protyle");
        dbg.push("protyle=" + document.querySelectorAll(".protyle").length +
                 " wysiwyg=" + document.querySelectorAll(".protyle-wysiwyg").length +
                 " focusWys=" + document.querySelectorAll(".protyle-wysiwyg--focus").length +
                 " selectWys=" + document.querySelectorAll(".protyle-wysiwyg--select").length);
        dbg.push("protyle.dataset.nodeId=" + ((pf && pf.dataset && pf.dataset.nodeId) || "(空)"));
      }
    } catch (e) { dbg.push("环境探针异常: " + (e && e.message)); }

    // ── 策略 0：★ 调用方直接给的「光标所在块元素」★ ─────────────────────
    //
    //   ★★★ 2026-09-22 从思源 main.js 里读出的**真实契约**（这是根治性发现）★★★
    //
    //   思源斜杠菜单的 plugin 分支（main.js，fill() 方法内）长这样：
    //
    //     cn.callback(D.getInstance(), ht), !0   // ← 只把 (protyle, 块元素) 交给插件
    //     return;                                // ← 然后就 return 了！
    //
    //   对照同一函数里**其它所有分支**（ZWSP/1/2/3、样式、普通插入…）：
    //     它们第一件事都是 `He.deleteContents()`，把用户敲的 `/` 和过滤词删掉，
    //     再插入真正的块。**唯独 plugin 分支没有这一步** ——
    //     思源把「清掉 /xxx」和「决定插到哪儿」这两件事**留给了插件自己做**。
    //
    //   ⇒ 所以历史实现有两个必然的 bug（同一个根因）：
    //     ① 位置错：把第 2 个参数 ht（**块元素**，带 data-node-id）当成 protyle
    //        传给 pickAndEmbed → locateInsertPoint 全部策略读不到 protyle.block
    //        → 退化成「插到文档末尾」。
    //     ② 残留 `/`：没人执行 He.deleteContents()，用户敲的 `/网盘` 就留在原地。
    //
    //   ht 的实证特征（从 main.js 用量反推）：
    //     ht.getAttribute("data-type")==="NodeParagraph"、
    //     ht.insertAdjacentHTML(...)、ht.nextElementSibling、ht.querySelector(...)
    //   ⇒ 它是带 data-node-id 的块元素。这里直接取 id 当光标块，最准。
    if (!blockId && anchorEl) {
      try {
        let el = anchorEl;
        // 容错：万一传进来的是 text node 或更深的节点，往上找到带 node-id 的块
        if (el && el.nodeType === 3) el = el.parentElement;
        if (el && el.nodeType === 1) {
          // anchorEl 本身可能就是个块；找不到就往上找
          const holder = el.getAttribute && el.getAttribute("data-node-id")
            ? el
            : (el.closest ? el.closest("[data-node-id]") : null);
          if (holder) {
            blockId = holder.getAttribute("data-node-id") || "";
            src = "anchorEl(closest[data-node-id])";
            dbg.push(src + "=" + (blockId || "(空)"));
          } else {
            dbg.push("anchorEl 上没有 data-node-id，也找不到祖先");
          }
        } else {
          dbg.push("anchorEl 类型=" + (anchorEl ? anchorEl.nodeName || typeof anchorEl : "空"));
        }
      } catch (e) { dbg.push("读 anchorEl 异常: " + (e && e.message)); }
    } else if (!anchorEl) {
      dbg.push("调用方未提供 anchorEl（非斜杠场景属正常）");
    }

    // ── 策略 1：调用方给的 protyle ─────────────────────────────────────
    //   注意：思源可能传入一个「复用过」的实例，所以只取 block 上的真值。
    //
    //   ★★★ 这里有个致命的细节（就是「插到末尾」的元凶）★★★
    //     protyle.block 在**文档级**编辑器上形如
    //       { id: "<文档id>", rootID: "<同一个文档id>", parentID: "<文档id>" }
    //     即 id === rootID —— 它描述的是「整篇文档」，**不是光标所在的那一段**。
    //     历史上这里无条件 `blockId = b.id`，于是：
    //       blockId = 文档 id → 后面 SQL 查到它的 type 是 "d"（文档块）
    //       → BOXED_TYPES 命中 → parentID 上移、previousID 清空
    //       → insertBlock 时没有任何 previousID ⇒ **追加到文档结尾**。
    //     用户看到的就是「我明明把光标放在第三段，块却跑到文末」。
    //
    //   ⇒ 只有当 block.id **不等于**文档 id 时，它才代表「光标所在的具体块」，
    //     那时才允许拿来当 previousID（插到它后面）。
    //     文档 id 只用来填 docId（插到文末的兜底）。
    try {
      if (protyle && protyle.block) {
        const b = protyle.block;
        const root = b.rootID || b.id || "";
        if (root) {
          docId = root;
          dbg.push("protyle.block: id=" + (b.id || "") + " rootID=" + (b.rootID || ""));
          if (b.id && b.id !== root) {
            // 光标在某个具体子块上 → 精确锚点
            blockId = b.id;
            src = "protyle.block(子块)";
          } else {
            dbg.push("protyle.block.id 就是文档 id ⇒ 不当锚点（避免插到文末）");
            if (!src) src = "protyle.block(仅文档级)";
          }
        }
      } else {
        dbg.push("调用方 protyle=" + (protyle ? "有但无 block" : "空"));
      }
    } catch (e) { dbg.push("读 protyle.block 异常: " + (e && e.message)); }

    // ── 策略 2：★ 纯 DOM：.protyle 的 dataset.nodeId ★ ─────────────────
    //
    //   ★ 2026-09-22 在真实环境实测确定的路径（前面几版全错在这里）：
    //     document.querySelector(".protyle").dataset = {
    //        nodeId: "20260415075745-bzytq2y",   ← 文档块 id，直接可用
    //        notebookId: "20240604102224-1z8hvmo",
    //        id: "7756f110-…"                    ← 这是 DOM 实例 uuid，不是块 id
    //     }
    //   全部都是**标准 data-* 属性**，不依赖任何思源内部对象 —— 最稳。
    //
    //   反面教材（这些都试过，全部拿不到）：
    //     · .protyle._protyle            → 属性不存在
    //     · .protyle-wysiwyg--focus      → 焦点在别的页签时不存在
    //     · .protyle-wysiwyg--select     → 没有选中块时不存在
    //     · 页签的 data-initdata          → 空对象 {}
    if (!docId && typeof document !== "undefined") {
      try {
        // 优先取「有 nodeId 的」.protyle（页面上可能有多个编辑器）
        const all = Array.from(document.querySelectorAll(".protyle"));
        for (const el of all) {
          const nid = el.dataset && el.dataset.nodeId;
          if (nid) {
            docId = nid;
            src = "DOM:.protyle[data-node-id]";
            dbg.push(src + "=" + nid);
            break;
          }
        }
        if (!docId) dbg.push("DOM 里没有带 data-node-id 的 .protyle");
      } catch (e) { dbg.push("读 .protyle dataset 异常: " + (e && e.message)); }
    }

    // ── 策略 3：★ siyuan.backStack —— 思源的「最近文档栈」★★ ───────────
    //
    //   ★ 实测结构（真实环境 dump 出来的）：
    //     window.siyuan.backStack = [ { position, id, zoomId, protyle: { block, … } } ]
    //   栈顶 [0] 就是**用户最后看的那个文档** —— 这正是「焦点被插件页签抢走」
    //   场景下最靠谱的线索：用户是从文档切到预览页的，那个文档就在栈顶。
    //
    //   实测值：backStack[0].protyle.block = {
    //     parentID: "20260415075745-bzytq2y",
    //     rootID:   "20260415075745-bzytq2y",
    //     id:       "20260415075745-bzytq2y", … }
    if (!docId && typeof window !== "undefined") {
      try {
        const bs = window.siyuan && window.siyuan.backStack;
        if (Array.isArray(bs) && bs.length) {
          for (let i = 0; i < bs.length; i++) {
            const pr = bs[i] && bs[i].protyle;
            const b = pr && pr.block;
            if (b && (b.rootID || b.id)) {
              docId = b.rootID || b.id;
              // 只有当 block.id 就是文档 id 时才当成光标块；否则别乱插
              if (b.id && b.id === docId) blockId = "";
              src = "siyuan.backStack[" + i + "]";
              dbg.push(src + ": rootID=" + (b.rootID || "") + " id=" + (b.id || ""));
              break;
            }
          }
        } else {
          dbg.push("siyuan.backStack=" + (bs === undefined ? "无" : (Array.isArray(bs) ? "空数组" : typeof bs)));
        }
      } catch (e) { dbg.push("读 backStack 异常: " + (e && e.message)); }
    }

    // ── 策略 4：layout.centerLayout 里逐层找编辑器 ──────────────────────
    //   实测：siyuan.layout 的键是 layout / centerLayout / leftDock / rightDock /
    //   bottomDock（**没有 children**）。centerLayout.children 长度 1，可继续下钻。
    //   这条路比前两条绕，只在前两条都失败时用。
    if (!docId && typeof window !== "undefined") {
      try {
        const layout = window.siyuan && window.siyuan.layout;
        const roots = [];
        if (layout) {
          if (layout.centerLayout) roots.push(layout.centerLayout);
          if (layout.layout) roots.push(layout.layout);
        }
        dbg.push("layout roots=" + roots.length);
        const seen = new Set();
        const stack = roots.map((n) => [n, "root"]);
        let scanned = 0;
        while (stack.length && scanned < 400) {
          const [n, path] = stack.shift();
          if (!n || typeof n !== "object" || seen.has(n)) continue;
          seen.add(n);
          scanned++;
          // 目标的几种可能挂法
          const ed = n.model && n.model.editor;
          if (ed && ed.protyle && ed.protyle.block &&
              (ed.protyle.block.rootID || ed.protyle.block.id)) {
            docId = ed.protyle.block.rootID || ed.protyle.block.id;
            src = "layout:" + path;
            dbg.push(src + "=" + docId);
            break;
          }
          if (Array.isArray(n.children)) {
            for (const c of n.children) stack.push([c, path + ">"]);
          }
        }
        if (!docId) dbg.push("layout 下钻 " + scanned + " 个节点，未找到编辑器");
      } catch (e) { dbg.push("layout 下钻异常: " + (e && e.message)); }
    }

    // ── 策略 5：DOM 里被选中的块（能拿到就更精确：插到它后面）───────────
    if (!blockId && typeof document !== "undefined") {
      try {
        const sel = document.querySelector(".protyle-wysiwyg--select");
        if (sel) {
          blockId = sel.getAttribute("data-node-id") || "";
          dbg.push("--select: blockId=" + (blockId || "(无)"));
        } else {
          dbg.push("DOM 里没有 .protyle-wysiwyg--select");
        }
      } catch (e) { dbg.push("读 --select 异常: " + (e && e.message)); }
    }

    // ── 策略 6：★ 深层回退 —— 从「当前光标/选区」反查所在块 ★───────────
    //
    //   ★ 为什么需要这一级 ★
    //     侧边栏 / 预览页这两个入口**没有** anchorEl（它们不是斜杠菜单触发的），
    //     用户此时的意图同样是「插到我光标所在的地方」。思源把光标放在哪个块里，
    //     浏览器里是有痕迹的：
    //       · 有选区时：selection.anchorNode 落在某个 [data-node-id] 块内
    //       · 没选区、但编辑器聚焦时：editor 上会带 .protyle-wysiwyg--focus，
    //         配合 document.activeElement 能定位到底哪个 .protyle 是活的
    //
    //   ⚠️ 这一级**只**在真的拿到 selection 时才用，不猜、不乱插。
    if (!blockId && typeof document !== "undefined" && typeof window !== "undefined") {
      try {
        const s = window.getSelection && window.getSelection();
        const node = s && s.anchorNode;
        if (node) {
          let el = node.nodeType === 3 ? node.parentElement : node;
          const holder = el && el.closest ? el.closest(".protyle-wysiwyg [data-node-id]") : null;
          if (holder && holder.getAttribute) {
            blockId = holder.getAttribute("data-node-id") || "";
            if (blockId) {
              src = "selection(closest[data-node-id])";
              dbg.push(src + "=" + blockId);
            }
          } else {
            dbg.push("selection 不在任何 [data-node-id] 块内");
          }
        } else {
          dbg.push("selection.anchorNode 为空");
        }
      } catch (e) { dbg.push("读 selection 异常: " + (e && e.message)); }
    }

    // ── 落到「父块 + 位置」────────────────────────────────────────────
    let parentID = docId;
    let previousID = "";

    // ★ 从锚点元素本身把文档 id 也捞出来 ★
    //   拖拽场景常见：用户在文档 A 里把文件拖到某个块上，
    //   此时 selection 可能已经丢了、protyle 也可能是复用实例，
    //   但**落点块元素还在我们手里**。顺着它往上找 .protyle[data-node-id]
    //   就能确定「这是哪个文档」，兜底也才有个像样的 parentID。
    if (!parentID && anchorEl) {
      try {
        const holder = anchorEl.nodeType === 1
          ? (anchorEl.closest ? anchorEl.closest(".protyle") : null)
          : null;
        const nid = holder && holder.dataset && holder.dataset.nodeId;
        if (nid) {
          parentID = nid;
          src = src || "anchorEl→.protyle[data-node-id]";
          dbg.push("锚点反查文档 id=" + nid);
        }
      } catch { /* 忽略 */ }
    }

    if (blockId) {
      let row = null;
      try {
        const info = await kb("/api/query/sql", {
          stmt: "SELECT parent_id, type, root_id FROM blocks WHERE id='" + blockId + "'",
        });
        row = info && info.data && info.data[0];
      } catch { /* 忽略 */ }
      if (row) {
        if (!parentID) parentID = row.root_id;
        if (BOXED_TYPES.indexOf(row.type) >= 0) {
          // 容器块内部不能直接插自定义块 ⇒ 插到容器的父层，位置不带 previousID
          parentID = row.parent_id || parentID;
          previousID = "";
          dbg.push("blockId 是容器块(" + row.type + ")，上移到 parent=" + parentID);
        } else {
          previousID = blockId;
        }
      } else {
        // 查不到这个块（可能刚被删/索引未到）：退化为插到文档末尾
        dbg.push("blockId=" + blockId + " 查不到，退化为文档级插入");
        previousID = "";
        if (!parentID) parentID = docId;
      }
    }

    const trace = dbg.join(" | ") +
      " ⇒ parentID=" + (parentID || "(空)") +
      " previousID=" + (previousID || "(空)") +
      " via=" + (src || "(无)");
    lastLocateTrace = trace;
    try {
      if (typeof console !== "undefined") {
        console.log("[nebuladisk] [locate] " + trace);
      }
    } catch { /* 忽略 */ }

    return { parentID, previousID, src };
  }

  /**
   * ★★★ 清掉斜杠菜单留在块里的 `/ 和过滤词` ★★★
   *
   * 背景（从思源 main.js 读出的契约，2026-09-22）：
   *   思源斜杠菜单的 **plugin 分支是唯一一个不调用 `He.deleteContents()` 的分支**：
   *
   *     }else if(n.startsWith("plugin") && Em(D)){
   *         D.app.plugins.find(... cn.callback(D.getInstance(), ht) ...);
   *         return;                       // ← 直接就返回了，没有删除 /xxx
   *     }else{
   *         He.deleteContents(),          // ← 其它所有分支都先删掉用户敲的字符
   *         ...
   *     }
   *
   *   ⇒ 「把 `/网盘` 这种触发文本清掉」是插件自己的责任。
   *     不清的后果就是用户看到的：插进来的块旁边**残留一个 `/及后面的字`**。
   *
   * 清理策略（由稳到激进，只在确实发现了斜杠残留时才动手）：
   *   ① 块内文本以 `/` 或 `、` 开头，且**去掉它之后就只剩空白** ⇒ **整块删掉**。
   *      这是最常见的情形：用户就是「空段落里敲 /」来唤起菜单的，那个块本身
   *      没有正文价值（嵌入块是插在它下面的）。详见 §3 的说明。
   *   ② 块内文本形如 `<前文>/<过滤词>` ⇒ 只删掉 `/` 及其后面的过滤词，保留前文。
   *   ③ 拿不准就**什么都不做** —— 宁可留个 `/`，也不能误删用户的正文。
   *
   * ★★★ 必须走内核，不能只擦 DOM（任务⑩ 的真正病根，2026-09-23 实测确认）★★★
   *
   *   旧实现是「Range 删 DOM + 往 protyle 派发一个 input 事件」，看着很合理，
   *   实际上**一个字都存不进去**。真机复现（NAS，headed 浏览器，逐条读回）：
   *
   *     内核 kramdown 初始： "前文/nb10probe"
   *     Range 清理 DOM 后：  inner div = "前文"        ← 看起来成功了
   *     等 2 秒后读内核：    "前文/nb10probe"          ← ★ 内核纹丝不动 ★
   *
   *   ⇒ 现象就是用户报的：「`/` 及后面的文字插入后不显示了，刷新一下又出来了」
   *     —— DOM 被改了（所以"不显示"），内核没改（所以一刷新又回来）。
   *     旧代码里那个 `dispatchEvent(input)` 打的是 `protyle.wysiwyg.element`，
   *     也就是**整个可编辑区的根**，思源的事务系统根本不认这次"编辑"。
   *
   *   更关键的是：`anchorEl` 是**外层 `.p`**，它的 textContent 里有
   *   `protyle-attr` 那个零宽空格（实测 `"前文/nb10probe\u200b"`），
   *   情形①的 `/^\s*[/、][^\s]*\s*$/` 对它**永远不成立**（`\u200b` 不是 `\s`），
   *   整个块只有 `/xxx` 时连分支都进不去。
   *
   *   ⇒ 所以现在改成：**先用内核 API 把块的内容改成目标文本，再让思源自己回写 DOM**。
   *     实测 `POST /api/block/updateBlock {dataType:"markdown"}` 一次就生效：
   *       updateBlock("前文") ⇒ 内核 "前文" + DOM inner "前文" ⇒ 刷新后不再复现。
   *
   *   几个必须做对的小细节：
   *     1. **取内层编辑区**（`[contenteditable="true"]`）来判读，避开零宽空格。
   *     2. **整块删除**（情形①）走 `deleteBlock`。
   *
   *        ★ 这里改过一次，值得记下思路的转变 ★
   *          早先写的是 `next = "<wbr>"`（把内容换成思源的空行占位），
   *          理由是「空串会让思源删掉整个段落块」，想"保护"用户的段落。
   *          但那个保护放错了对象：情形① 的块**就是用户敲 / 敲出来的临时块**，
   *          它没有任何正文，用户要的正是它消失。用 `<wbr>` 的结果是
   *          插入完嵌入块后，上面还挂着一个空行，用户得自己手动删 ——
   *          这正是 2026-09-23 反馈的「/文字 变成了 <wbr>」。
   *          ⇒ 现在直接 `deleteBlock`，删不掉才退化为清空。
   *        （情形② 不动块结构，因为它里面**有**用户的前文。）
   *     3. **只在该块真的还有斜杠残留时才写**，否则会平白多一次内核写、
   *        把用户光标位置弄乱。
   *
   *   顺带修掉的一个老毛病：**不再把过滤词长度当"是不是菜单触发"的判据**。
   *   旧代码有个 `m[2].length > 16 ⇒ 跳过` 的保险丝，看着保守，其实会误伤：
   *   用户搜「`/管理知识/责任`」这种较长的关键词时，残留反而清不掉。
   *   真正该防的误删（路径、URL）靠的是正则本身 —— m[1] 不允许出现 `/`，
   *   于是锚点必然是"块内最后一个斜杠"，`/usr/local/bin` 这类整段天然保留。
   *
   * @param {Element|null} anchorEl 斜杠菜单交给插件的「光标所在块元素」
   * @returns {Promise<boolean>} true=确实改写了内核
   */
  async function cleanupSlashText(anchorEl) {
    if (!anchorEl || anchorEl.nodeType !== 1) return false;
    try {
      const el = anchorEl;

      // ── 1. 拿块 id：没有 id 就不是真块，宁可不动 ──────────────────────
      const blockId = el.getAttribute("data-node-id") || "";
      if (!blockId) {
        console.log("[nebuladisk] [slash-cleanup] anchorEl 无 data-node-id，保守跳过");
        return false;
      }

      // ── 2. 读「内层编辑区」的文本，避开 protyle-attr 的零宽空格 ────────
      //     实测外层 .p 的 textContent = 正文 + "\u200b"，
      //     直接拿去匹配 `/^[\/、]/` 会永远失败。
      const editEl = el.querySelector('[contenteditable="true"]') || el;
      const raw = editEl.textContent || "";
      if (!raw) return false;
      if (raw.indexOf("/") < 0 && raw.indexOf("、") < 0) return false;

      // ── 3. 判定目标文本（拿不准就返回 null ⇒ 一个字都不改）────────────
      let next = null;
      let deleteBlock = false;

      // 情形 ①：全块只有 /xxx（可含空白）
      //
      //   ★ 应该是「整块删掉」，而不是留一个空段 ★（2026-09-23 按用户反馈改）
      //
      //   这个块本身就是用户**为了唤起斜杠菜单**而敲出来的：他只打了 `/关键词`，
      //   然后在菜单里选了「嵌入到文档」。此时这个块没有任何正文价值 ——
      //   嵌入块是插在它**下面**的（插在光标所在块之后）。
      //   早先我们用 `"<wbr>"` 去改写，理由是「空串会让思源删掉整个段落块」；
      //   但那个"保护"其实搞错了方向：这里**就是要它消失**。
      //   用户看到的是：插入完嵌入块，上面还挂着一个空行（<wbr> 只是个零宽占位），
      //   还得自己手动删掉 —— 这正是本轮反馈的「/文字 变成了 <wbr>」。
      //
      //   所以这里改成显式删除该块（deleteBlock），删不掉再退化为清空。
      //
      //   例外：整块是「路径形状」时不动 —— `/usr/local/bin` 斜杠多于一个，
      //   几乎一定是用户正文/路径（斜杠菜单的过滤词里不会再有斜杠）。
      if (/^\s*[/、]\S*\s*$/.test(raw)) {
        const slashCount = (raw.match(/\//g) || []).length;
        if (slashCount > 1) {
          console.log("[nebuladisk] [slash-cleanup] 整块是路径形状（斜杠 " +
                      slashCount + " 个），判定为正文，保守跳过");
          return false;
        }
        deleteBlock = true;
        next = "";                   // 删除失败时的兜底：清成空串
      } else {
        // 情形 ②：形如 `前文/过滤词` ⇒ 只删 `/` 及其后内容
        //
        // ⚠️ 这里必须严格，否则会**吃掉用户正文**。踩过的坑：
        //    最初写 `/^([\s\S]*?)\s*[/、]([^\s/、]*)\s*$/`，再用
        //    `m[2].indexOf("/") < 0` 兜底。看似严谨，实则**被回溯绕过**：
        //      `路径 /usr/local/bin`
        //        → 先试 m[1]="路径 " / m[2]="usr/local/bin"（含 / ⇒ 守卫拦下）
        //        → 正则引擎回溯，改试 m[1]="路径 /usr" / m[2]="local"
        //          —— 第二个斜杠被吃进了 m[1]，m[2] 反而不含斜杠，守卫失效！
        //    正确做法：**不允许 m[1] 里出现斜杠**（`[^/、]*?`），
        //    这样锚点必然是「块内最后一个斜杠」，路径/URL 自然整段保留。
        const m = raw.match(/^([^/、]*?)\s*[/、]([^\s/、]*)\s*$/);
        // 过滤词必须非空：`前文/` 这种（斜杠后已经没字了）交给它自己，
        // 我们只负责「斜杠 + 过滤词」这种明确的菜单残留。
        if (m && m[2].length > 0) next = m[1];
      }

      if (next === null) {
        console.log("[nebuladisk] [slash-cleanup] 无法确定斜杠位置，保守跳过（不误删）");
        return false;
      }

      // ── 3.5 整块删除分支（情形 ①）────────────────────────────────────
      if (deleteBlock) {
        const d = await kb("/api/block/deleteBlock", { id: blockId });
        if (d && d.code === 0) {
          console.log("[nebuladisk] [slash-cleanup] 已删除纯斜杠块 " + blockId);
          return true;
        }
        // 删不掉（例如只读块）就退化为清空内容，至少不留 /关键词 残渣
        console.log("[nebuladisk] [slash-cleanup] deleteBlock 失败：" +
                    ((d && d.msg) || "未知") + "，退化为清空内容");
      }

      // ── 4. 已经干净了就别写内核（避免平白扰动光标/事务）────────────────
      const cur = (raw || "").replace(/\u200b/g, "").trim();
      if (cur === next.trim()) {
        console.log("[nebuladisk] [slash-cleanup] 已是目标文本，无需改写");
        return false;
      }

      // ── 5. 走内核改写 —— 这一步才是「刷新后不再回来」的关键 ────────────
      const r = await kb("/api/block/updateBlock", {
        id: blockId,
        dataType: "markdown",
        data: next,
      });
      if (!r || r.code !== 0) {
        console.log("[nebuladisk] [slash-cleanup] updateBlock 失败：" +
                    ((r && r.msg) || "未知"), "（DOM 保持原样，不做半截清理）");
        return false;
      }
      console.log("[nebuladisk] [slash-cleanup] 内核已改写：" +
                  JSON.stringify(raw.slice(0, 24)) + " → " +
                  JSON.stringify(next.slice(0, 24)));
      return true;
    } catch (e) {
      console.log("[nebuladisk] [slash-cleanup] 异常，已忽略: " + (e && e.message));
      return false;
    }
  }

  async function writeTraceToKernel(trace) {
    try {
      const DOC_TITLE = "nebuladisk-diag";
      const HPH = "/" + DOC_TITLE;

      // 1) 找诊断文档（用 SQL 查，比 filetree API 少一次路径猜测）
      let docId = "";
      try {
        const r = await kb("/api/query/sql", {
          stmt: `SELECT id FROM blocks WHERE hpath='${HPH}' AND type='d' LIMIT 1`,
        });
        docId = (r && r.data && r.data[0] && r.data[0].id) || "";
      } catch { /* 忽略 */ }

      // 2) 没有就建（建在默认笔记本里）
      if (!docId) {
        try {
          const nb = await kb("/api/notebook/lsNotebooks", {});
          const box = nb && nb.data && nb.data.notebooks && nb.data.notebooks[0] &&
                      nb.data.notebooks[0].id;
          if (!box) return;
          const made = await kb("/api/filetree/createDocWithMd", {
            notebook: box,
            path: "/" + DOC_TITLE,
            markdown: "",
          });
          if (made && made.code === 0) {
            const r2 = await kb("/api/query/sql", {
              stmt: `SELECT id FROM blocks WHERE hpath='${HPH}' AND type='d' LIMIT 1`,
            });
            docId = (r2 && r2.data && r2.data[0] && r2.data[0].id) || "";
          }
        } catch { /* 忽略 */ }
      }
      if (!docId) return;

      // 3) 插一条带时间戳的轨迹（用 markdown 段落）
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      const md = `\`${ts}\` ${trace}`;
      await kb("/api/block/appendBlock", {
        dataType: "markdown",
        data: md,
        parentID: docId,
      });
    } catch { /* 诊断失败绝不影响主流程 */ }
  }

  /**
   * ★ 把 NebulaDisk 嵌入块插进当前文档（**唯一入口**）★
   *
   * 流程：定位 → 内核 insertBlock(markdown) → 回查 type 自校验 → 不是 custom 就重建。
   *
   * ★ 失败必须「吵闹且具体」★
   *   绝不用前端 `protyle.insert` 兜底 —— 它不报错，只会**静默产出一个坏块**
   *   （type=p + 字面围栏），用户看到「插入了、但是 JSON」，完全不知道失败过。
   *   ⇒ 这里一失败就 `throw`，并把原因（尤其「找不到文档」这种可自助解决的）
   *     原样带回给调用方显示。**宁可不插，也不插坏；宁可不插，也要说清为什么。**
   *
   * @param {object} plugin
   * @param {any} protyle 编辑器（可能为空/不可信，locateInsertPoint 会自行回退查找）
   * @param {object} spec
   * @returns {Promise<boolean>} true=已插入且校验通过
   * @throws {Error} 定位失败 / 内核失败 / 重建失败时抛出，`message` 是给人看的
   */
  async function insertEmbedIntoDoc(plugin, protyle, spec, opts) {
    const md = buildEmbedMarkdown(plugin && plugin.name, spec);
    const log = (m) => {
      try { console.log(`[nebuladisk] [embed-insert] ${m}`); } catch { /* 忽略 */ }
    };

    // ★★★ opts.anchorEl —— 解决了「插到文末」与「残留 /」两个 bug ★★★
    //
    //   思源斜杠菜单调用插件的契约（从 main.js 的 fill() 读出）：
    //     cn.callback(D.getInstance(), ht)   // (protyle, 光标所在块元素)
    //   并且**不**替我们执行 He.deleteContents()。
    //   ⇒ 谁从斜杠菜单进来，就必须把那个块元素一路传到这里。
    const anchorEl = (opts && opts.anchorEl) || null;
    // 斜杠场景 ⇒ 插入成功后需要清掉用户敲的 `/过滤词`
    const fromSlash = !!(opts && opts.fromSlash);

    // ★★★ 绝不使用前端 protyle.insert 兜底 ★★★
    //
    //   2026-09-22 NAS 实测（两条路径对照，已逐字复现）：
    //     前端把整段当「一个段落 DOM」提交 →
    //       type=p，content 是**字面围栏文本** ⇒ 笔记里就是一坨裸 JSON
    //     内核 insertBlock{dataType:"markdown"} →
    //       type=custom ⇒ 渲染器被触发，正常显示 ✓
    //
    //   历史上这里有个「内核失败就退回 protyle.insert」的兜底。它极其有害：
    //   内核一失败，兜底不会报错，而是**静默产出一个坏块**，
    //   用户看到的是「插入了、但是 JSON」，完全不知道失败过。
    //   ⇒ 现在改成一失败就报错（返回 false + 明确日志），宁可不插也不插坏。
    let newId = "";
    try {
      const { parentID, previousID, src } = await locateInsertPoint(protyle, anchorEl);
      if (!parentID) {
        // ★ 定位失败要说人话，并且要能自证卡在哪一级 ★
        //   历史上这里只写「定位不到插入位置」，用户看到的是「插入失败，请查看
        //   控制台日志」，完全不知道该干嘛。
        //   2026-09-22 改成具体文案后，用户报的是「找不到要插入的文档」——
        //   也就是**五级回退全落空了**。光说"请打开一个文档"没用（他明明开着），
        //   必须把逐级探测的轨迹交出来才能继续收敛。
        const trace = lastLocateTrace || "(无轨迹)";
        log("定位失败（protyle=" + (protyle ? "有" : "空") + "）");
        console.log("[nebuladisk] [locate-fail] " + trace);
        // ★ 把轨迹写进思源的内核日志，这样用户不开 DevTools 我也能读 ★
        await writeTraceToKernel(trace);
        const err = new Error(
          "找不到要插入的文档（已把诊断写入内核日志）。\n" +
          "定位轨迹：" + trace
        );
        err.stage = "locate";
        err.trace = trace;
        throw err;
      }
      log(`定位成功：parentID=${parentID} previousID=${previousID || "(无)"} via=${src || "?"}`);

      const body = { dataType: "markdown", data: md, parentID };
      if (previousID) body.previousID = previousID;

      const ins = await kb("/api/block/insertBlock", body);
      if (!ins || ins.code !== 0) throw new Error((ins && ins.msg) || "insertBlock 失败");

      // ★ 拿新块 id ★
      //   ⚠️ 注意：ins.data[0].doOperations[0].data 是**计划字符串**，不是落库结果，
      //   不能拿它当「已生成 custom 块」的证据（这里曾经误判过好几轮）。
      //   唯一可信的做法是回查 blocks 表 —— 但 SQL 索引有延迟，
      //   所以下面用「DOM 回查」优先，拿不到再退 SQL。
      newId =
        ins.data && ins.data[0] && ins.data[0].doOperations &&
        ins.data[0].doOperations[0] && ins.data[0].doOperations[0].id;
    } catch (e) {
      log(`内核 insertBlock 失败：${e && e.message}`);
      // ★ 把原因抛出去，不要吞掉 ★
      //   吞掉 ⇒ 调用方只能显示「插入失败，去看控制台」，
      //   用户既不知道原因、也没法自助。**失败要吵闹，且要说得具体。**
      const err = new Error((e && e.message) || "插入失败");
      err.stage = "insert";
      throw err;
    }

    // ★ 校验：确认内核真的生成了 custom 块 ★
    //   索引进度不保证，所以多探几次；只有「明确查到非 custom」才判定失败，
    //   「暂时查不到」不算失败（避免把自己刚插的好块误删）。
    const verdict = await verifyCustomBlock(newId);
    log(`新块 ${newId || "(无 id)"} 类型校验：${verdict}`);
    if (verdict === "not-custom" && newId) {
      log(`内核生成的不是 custom ⇒ 走重建路径`);
      try {
        await repairFenceBlock(newId, extractJson(md));
        const v2 = await verifyCustomBlock(newId);
        log(`重建后校验：${v2}`);
        if (v2 !== "not-custom") {
          if (fromSlash) await cleanupSlashText(anchorEl);
          return true;
        }
        return false;
      } catch (e) {
        log(`重建失败：${e && e.message}`);
        return false;
      }
    }

    // ★ 插入成功之后，清掉斜杠菜单留下的 `/过滤词` ★
    //   只在斜杠入口做；侧边栏/预览页/拖拽都没有这个残留，不能乱动内容。
    //   放在**块确实插好之后** —— 万一插入失败，用户至少还能看着 /xxx 重试。
    //
    //   ★ 这里现在只有一句 `await cleanupSlashText(anchorEl)` ★
    //     cleanupSlashText 内部走的是 `POST /api/block/updateBlock`，
    //     内核改完会自己把 DOM 回写下来 —— **不需要**再补一个手搓的
    //     `dispatchEvent(new UIEvent("input"))`。
    //     那个补丁是旧方案的残骸（旧方案只改 DOM，想靠假 input 事件骗内核落库），
    //     而实测它一个字都存不进去：事件打在 `protyle.wysiwyg.element`
    //     （整个可编辑区根节点）上，思源根本不认为那是一次编辑。
    //     留着它反而有害 —— 会在内核已经写完后再推一次空编辑，扰动事务。
    if (fromSlash) {
      const cleaned = await cleanupSlashText(anchorEl);
      log(cleaned ? "已清理斜杠残留（内核已改写）" : "无需清理斜杠残留");
    }
    return true;
  }

  /**
   * 校验某个块是不是 custom 块。
   *
   * ★ 为什么要有「未知」这个结论 ★
   *   思源的 SQL 索引是异步的，刚 insert 完立刻查常常查不到（实测 1.5s 后仍是空）。
   *   如果此时把「查不到」当成「不是 custom」，就会去删一个其实很正常的块，
   *   越修越乱（这个坑已经踩过）。所以必须三态：custom / not-custom / unknown。
   *
   * @param {string} id
   * @returns {Promise<"custom"|"not-custom"|"unknown">}
   */
  async function verifyCustomBlock(id) {
    if (!id) return "unknown";

    // ① 优先问 DOM —— 内核已经挂上去了，前端能立刻看到，不受 SQL 索引延迟影响
    if (typeof document !== "undefined") {
      try {
        for (let i = 0; i < 12; i++) {
          const el = document.querySelector(`[data-node-id="${id}"]`);
          if (el) {
            const t = el.getAttribute("data-type") || "";
            if (t === "NodeCustomBlock") return "custom";
            if (t) return "not-custom";
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      } catch { /* 忽略 */ }
    }

    // ② 再问 SQL（索引可能滞后，多试几次）
    for (let i = 0; i < 6; i++) {
      try {
        const chk = await kb("/api/query/sql", {
          stmt: `SELECT type FROM blocks WHERE id='${id}'`,
        });
        const t = chk && chk.data && chk.data[0] && chk.data[0].type;
        if (t) return t === "custom" ? "custom" : "not-custom";
      } catch { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return "unknown";
  }

  /**
   * 把「围栏躺在段落里」或「反引号残留」的块，重建为正确的自定义块。
   * 删 + 以 markdown 重插（实测这是唯一可靠的升级方式）。
   *
   * @param {string} blockId
   * @param {string} json 嵌入参数 JSON
   * @returns {Promise<void>}
   */
  async function repairFenceBlock(blockId, json) {
    const info = await kb("/api/query/sql", {
      stmt: `SELECT parent_id FROM blocks WHERE id='${blockId}'`,
    });
    const parentID = info && info.data && info.data[0] && info.data[0].parent_id;
    if (!parentID) throw new Error("拿不到父块 id，放弃重建");

    const sib = await kb("/api/query/sql", {
      stmt: `SELECT id FROM blocks WHERE parent_id='${parentID}' AND id < '${blockId}' ORDER BY id DESC LIMIT 1`,
    });
    const prevId = sib && sib.data && sib.data[0] && sib.data[0].id;

    const del = await kb("/api/block/deleteBlock", { id: blockId });
    if (!del || del.code !== 0) throw new Error((del && del.msg) || "deleteBlock 失败");

    let obj = null;
    try { obj = JSON.parse(json); } catch { /* 交给下面报错 */ }
    if (!obj || !obj.mount) throw new Error("嵌入参数无法解析，放弃重建");

    const md = buildEmbedMarkdown("siyuan-nebuladisk", obj);
    const insBody = { dataType: "markdown", data: md, parentID };
    if (prevId) insBody.previousID = prevId;
    const ins = await kb("/api/block/insertBlock", insBody);
    if (!ins || ins.code !== 0) throw new Error((ins && ins.msg) || "重建 insertBlock 失败");
  }


  /**
   * 把自定义块渲染器挂到插件上
   * @param {import("../index.js").default} plugin
   */
  function registerEmbed(plugin) {
    // 插件实例上暴露 api，供渲染器使用
    if (!plugin.api) {
      // 延迟绑定，避免 index.js 与 embed.js 循环依赖
      plugin.api = null;
    }

    const renderer = {
      render: ({ element, content }) => {
        const spec = parseEmbed(content);
        element.innerHTML = "";
        element.classList.add("nb-embed-host");

        if (!spec) {
          const bad = document.createElement("div");
          bad.className = "nb-embed-error";
          bad.textContent = "NebulaDisk 嵌入块内容无法解析（应为 JSON：{\"kind\":\"tree\",\"mount\":\"盘符\",\"path\":\"路径\"}）";
          element.appendChild(bad);
          return;
        }

        // 通道未就绪时给出可点击的提示
        const st = plugin.boot ? plugin.boot.status : { ok: false, detail: "未初始化" };
        if (!st.ok) {
          const warn = document.createElement("div");
          warn.className = "nb-embed-error";
          warn.textContent = `网盘通道未就绪：${st.detail}。请在插件设置中检查后重新打开本文档。`;
          element.appendChild(warn);
          return;
        }

        const node = spec.kind === "file"
          ? renderFileEmbed(spec, plugin)
          : renderTreeBrowser(spec, plugin);
        element.appendChild(node);
      },
    };

    plugin.customBlockRenders = plugin.customBlockRenders || {};
    // ★ 主键：思源真正会查的那个（data-info 斜杠后的 blockType）★
    plugin.customBlockRenders[BLOCK_TYPE] = renderer;
    // ★ 兼容：极端历史写法可能把块类型写成插件名 ★
    for (const k of LEGACY_BLOCK_TYPES) plugin.customBlockRenders[k] = renderer;
    // ★ 兼容：更早版本把整个插件名当键 ★
    plugin.customBlockRenders[plugin.name] = renderer;
  }

  /** 嵌入块渲染用的 api 绑定（由 index.js 在 onload 后调用） */
  function bindPluginApi(plugin, api) {
    plugin.api = api;
    /*
     * ★ 调试出口（只读，不改变任何行为）★
     *
     *   cleanupSlashText 是本模块的**私有**函数，只被 insertEmbedIntoDoc 内部调用。
     *   这带来一个验收盲区：想在真机上单独验它，只能「照着它重写一遍」，
     *   而那种验证证明的是**测试脚本**对，不是**实现**对 —— 2026-09-22 踩过：
     *   一个照着复现的探针报「anchor 不在 DOM」，看起来像实现坏了，其实是探针
     *   找了个编辑器还没渲染的块。
     *
     *   所以这里把它挂到 plugin 上，单纯为了能验到**真函数本身**。
     *   命名用 __nb 前缀标明是内部调试用途；它不接受外部输入去做别的事，
     *   也不被任何生产代码路径引用，删掉不影响功能。
     */
    plugin.__nbCleanupSlashText = cleanupSlashText;
  }

  /* -------------------------------------------------------------------------
   * 历史嵌入块自愈
   *
   * 历史包袱有两类，成因不同，处理方式也不同：
   *
   * ── 类型 A：反引号围栏残留（最常见的那个 bug）──────────────────────────
   *
   *   早期版本写成：
   *
   *     ```nebuladisk
   *     {"kind":"file",...}
   *     ```
   *
   *   但反引号围栏在思源里生成的是**普通代码块 type=c**，不是自定义块。
   *   结果：
   *     · 编辑器里显示成一段普通代码（用户看到裸 JSON）
   *     · kramdown 里连 ``` 行都一起存着
   *
   *   ⇒ 修复必须**改块内容**（把它换成 `;;;` 围栏的自定义块）。
   *     这里用内核 API 完成，因为纯前端无法把 type=c 升级成 type=custom。
   *     走 /api/block/updateBlock（dataType=dom），由内核负责序列化，
   *     不自己拼块 HTML —— 避免依赖会随版本变化的内部格式。
   *
   * ── 类型 B：dom 已就位但 data-info 是旧写法 ─────────────────────────────
   *
   *   如果某块已经是 NodeCustomBlock，但 data-info 没有斜杠（或插件名不对），
   *   思源解析不出渲染器，就会把 data-content 塞进 <pre> 里显示裸 JSON。
   *   这类**不用改笔记**，直接用本插件渲染器就地重绘即可（见 renderInPlace）。
   * ---------------------------------------------------------------------- */

  /** 从元素里找出（或补出）思源的 `.custom-block__content` 容器 */
  function contentBoxOf(el) {
    let box = Array.from(el.children).find((c) => c.classList && c.classList.contains("custom-block__content"));
    if (!box) {
      box = el.ownerDocument.createElement("div");
      box.className = "custom-block__content";
      const attr = Array.from(el.children).find((c) => c.classList && c.classList.contains("protyle-attr"));
      el.insertBefore(box, attr || null);
    }
    return box;
  }
  /**
   * 就地把一个 NodeCustomBlock 交给本插件渲染器重绘（不改笔记、不调后端）。
   *
   * 适用：块本身已经是 NodeCustomBlock（DOM 正确），只是 data-info 让思源
   * 找不到渲染器。这种情况前端就能救。
   *
   * @param {Element} el
   * @param {object} plugin
   * @returns {boolean} 是否重绘成功
   */
  function renderInPlace(el, plugin) {
    if (!el || !plugin) return false;
    const content = el.getAttribute("data-content") || "";
    const renderer = plugin.customBlockRenders && plugin.customBlockRenders[BLOCK_TYPE];
    if (!renderer || typeof renderer.render !== "function") return false;
    try {
      // ① 用思源自己的方式清出容器（移除除 protyle-attr 外的子元素）
      const attr = Array.from(el.children).find((c) => c.classList && c.classList.contains("protyle-attr"));
      Array.from(el.children).forEach((c) => { if (c !== attr) c.remove(); });
      const host = el.ownerDocument.createElement("div");
      host.className = "custom-block__content";
      el.insertBefore(host, attr || null);

      // ② 直接调本插件的渲染器（等价于思源在 data-info 正确时会做的事）
      renderer.render({ element: host, content });
      el.dataset.nbLegacyRendered = "1";
      return true;
    } catch (e) {
      console.log(`[nebuladisk] [legacy-embed] 就地重绘失败: ${e && e.message}`);
      return false;
    }
  }

  /**
   * 就地重绘「data-info 是旧写法」的自定义块。
   *
   * @param {import("../index.js").default} plugin
   * @param {boolean} [force] 默认只在本次会话还没处理过时才动它
   * @returns {number} 重绘的块数
   */
  function migrateLegacyEmbeds(plugin, force) {
    if (!plugin) return 0;
    const wanted = `${plugin.name}/${BLOCK_TYPE}`;
    const legacyTypes = new Set(LEGACY_BLOCK_TYPES.concat([plugin.name]));
    const nodes = Array.from(document.querySelectorAll('[data-type="NodeCustomBlock"]'));
    let fixed = 0;

    for (const el of nodes) {
      const info = el.getAttribute("data-info") || "";
      // 已经是新写法（恰好一个斜杠且插件名对）⇒ 思源自己会渲染，不用我们管
      if (info === wanted) continue;
      // 无斜杠的旧写法（nebuladisk / siyuan-nebuladisk）
      if (!legacyTypes.has(info)) continue;
      const content = el.getAttribute("data-content") || "";
      // 内容必须像本插件的 JSON，避免误伤用户自己的同名块
      if (content.indexOf('"mount"') < 0) continue;
      // 已被本次会话处理过
      if (!force && el.dataset.nbLegacyRendered === "1") continue;

      if (renderInPlace(el, plugin)) fixed++;
    }

    if (fixed) console.log(`[nebuladisk] [legacy-embed] 已就地重绘 ${fixed} 个旧自定义块（data-info 缺斜杠，已用本插件渲染器接管）`);
    return fixed;
  }

  /* -------------------------------------------------------------------------
   * 反引号围栏残留的扫描（类型 A）
   *
   * 扫描当前文档里的普通代码块，找出内容是「```<插件名> / ```nebuladisk /
   * ```nebuladisk\n{...}」这类本插件早期写法、且内含 "mount" 的 JSON。
   *
   * 这里只做**扫描**（返回清单），不动 DOM —— 改块内容要走内核 API，
   * 由 index.js 拿到清单后统一调用 /api/block/updateBlock 升级成自定义块。
   * ---------------------------------------------------------------------- */

  const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/;

  /**
   * 判断一段文本是否是本插件早期的反引号围栏写法。
   * @param {string} text
   * @returns {{oldInfo:string, json:string}|null}
   */
  function parseLegacyFence(text) {
    const raw = String(text || "").trim();
    const m = FENCE_RE.exec(raw);
    if (!m) return null;
    const lang = (m[1] || "").trim();
    const body = (m[2] || "").trim();
    if (!body || body.indexOf('"mount"') < 0) return null;
    // 语言串必须是本插件相关写法（或干脆为空，容错历史脏数据）
    const okLang =
      lang === "" ||
      lang === BLOCK_TYPE ||
      lang === "nebuladisk" ||
      lang === "siyuan-nebuladisk" ||
      lang.startsWith("siyuan-nebuladisk/") ||
      lang.startsWith("plugin/");
    if (!okLang) return null;
    return { oldInfo: lang, json: body };
  }

  /**
   * 扫描当前打开的文档里所有「反引号围栏残留」的代码块。
   *
   * ★ 代码块语言的真实 DOM 位置（实测思源 3.8.4 /api/block/getBlockDOM）★
   *
   *   <div data-type="NodeCodeBlock" class="code-block" data-node-id="…">
   *     <div class="protyle-action">
   *       <span class="protyle-action__language" contenteditable="false">
   *         siyuan-nebuladisk/nebuladisk          ← 语言在这里
   *       </span> …
   *     <div spellcheck="false">…代码正文…</div>   ← 正文在这里
   *     <div class="protyle-attr">…</div>
   *   </div>
   *
   *   ⚠️ **没有 data-language 属性**（早期实现假设错了）。必须读那个 span。
   *
   * @param {import("../index.js").default} plugin
   * @returns {Array<{id:string, json:string, oldInfo:string}>}
   */
  function findLegacyFenceBlocks(plugin) {
    const out = [];
    if (typeof document === "undefined") return out;
    const seen = new Set();
    // 只在当前活跃编辑器里扫，避免误伤其它文档
    const editors = document.querySelectorAll(".protyle-wysiwyg");
    editors.forEach((root) => {
      root.querySelectorAll('[data-type="NodeCodeBlock"]').forEach((el) => {
        const id = el.getAttribute("data-node-id");
        if (!id || seen.has(id)) return;
        seen.add(id);

        // ① 语言：读 protyle-action__language 这个 span
        let lang = "";
        const langEl = el.querySelector(".protyle-action__language");
        if (langEl) lang = (langEl.textContent || "").trim();
        // 兜底：某些版本可能把语言放在属性上
        if (!lang) lang = el.getAttribute("data-language") || "";
        // 渲染节点形态（未加载编辑器）时，语言在 data-content / data-subtype
        if (!lang) lang = el.getAttribute("data-subtype") || "";

        // ② 正文：代码块里带 spellcheck 的那个容器
        let body = "";
        const holder = el.querySelector("[spellcheck]");
        if (holder) body = holder.textContent || "";
        if (!body) {
          // 退化形态：整个块的 data-content 就是正文
          body = el.getAttribute("data-content") || "";
        }

        const hit = parseLegacyFence("```" + lang + "\n" + body + "\n```");
        if (hit) out.push({ id, json: hit.json, oldInfo: lang });
      });
    });
    return out;
  }

  /* -------------------------------------------------------------------------
   * 历史残留的第三种形态：`;;;` 围栏「没被识别」，整段留成了普通段落
   *
   * ★ 这是 2026-09-22 在 NAS 真实笔记里发现的 ★
   *
   *   症状：块是 type=p（普通段落），content 就是**字面的**围栏文本
   *
   *     ;;;siyuan-nebuladisk/nebuladisk
   *     {"kind":"file","mount":"售前项目","path":"/x.docx"}
   *     ;;;
   *
   *   —— 字面看着完全正确，但思源没把它编译成自定义块。
   *
   *   成因（实测 v3.8.4）：
   *     · 用 /api/filetree/createDocWithMd **新建文档**时，`;;;` 能正确
   *       生成 type=custom（已验证）。
   *     · 但如果这段文本是**后来粘贴/输入**进一个已存在的段落块，
   *       或者整段被当成一个段落提交，内核就用**段落**的方式存下来了，
   *       不会再回头重新解析成自定义块。
   *     · ⇒ 它既不是 NodeCodeBlock（第一种形态扫不到），
   *          也不是 NodeCustomBlock（第二种形态扫不到）。
   *
   *   为什么不能沿用「就地重绘」（姿势 B）：
   *     思源压根没给它 .custom-block__content 容器，data-info 也不存在，
   *     前端 DOM 上没有可用的入口。
   *
   *   为什么不能沿用「updateBlock(dom)」（姿势 A）：
   *     实测过了 —— 传 dataType="dom" 的 NodeCustomBlock 给一个
   *     type=p 的块，返回 code=0，但**块类型仍是 p**（DOM 被当段落属性吸收）。
   *     传 dataType="markdown" 也一样不升。
   *
   *   ⇒ 唯一可靠做法：**删掉这个段落块，再以 markdown 形式重新插入**。
   *     删除 + 插入都走内核 API，由内核负责生成正确的 NodeCustomBlock。
   * ---------------------------------------------------------------------- */

  /**
   * 识别「段落里躺着一段字面 `;;;` 围栏」的块。
   *
   * 判定条件（三条都要满足，防误伤）：
   *   ① 块的 textContent 去掉首尾空白后以 `;;;` 开头
   *   ② 能找到与开头配对的收尾 `;;;` 行
   *   ③ 中间那行是含 "mount" 的合法 JSON（本插件专属特征）
   *
   * @param {Element} el 一个 NodeParagraph
   * @returns {{id:string, json:string, info:string}|null}
   */
  function parseParagraphFence(el) {
    // 段落的正文可能在多个子节点里，用 textContent 拼回来
    let text = (el.textContent || "").trim();
    if (!text) return null;

    // ★★★ 容错：剥掉围栏开头的杂散字符 ★★★
    //
    //   2026-09-22 在 NAS 真实笔记里抓到过一个坏块，content 是：
    //       "[;;;siyuan-nebuladisk/nebuladisk\n{...}\n;;;"
    //        ^ 这个方括号
    //   实测（/api/filetree/createDocWithMd 对照）：
    //        ;;;siyuan-…      → type=custom ✓
    //       [;;;siyuan-…      → type=p      ✗   ← 围栏前面多一个字符就不认了
    //   也就是说**围栏必须顶格**，前面多任何一个字符都会退化成普通段落。
    //   （方括号来自更早版本的插入写法，可能是 markdown 链接拼接的残留。）
    //   这里主动剥掉，让自愈能救回这类历史坏块。
    text = text.replace(/^[\[\(\{【（「]+/, "");
    if (!text.startsWith(";;;")) return null;

    // 用 kramdown 的形态重新分行：开头行 / JSON / 结束行
    const lines = text.split(/\r?\n/);
    if (lines.length < 3) return null;
    const head = lines[0].trim();
    if (!head.startsWith(";;;")) return null;
    // 收尾的 ;;;（允许后面跟别的节点文字，所以从后往前找最后一行 ;;; ）
    let end = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].trim() === ";;;") { end = i; break; }
    }
    if (end < 2) return null;

    const info = head.slice(3).trim();
    const body = lines.slice(1, end).join("\n").trim();
    if (body.indexOf('"mount"') < 0) return null; // ★ 只认本插件的内容
    try {
      const o = JSON.parse(body);
      if (!o || !o.mount) return null;
    } catch {
      return null;
    }
    return { id: el.getAttribute("data-node-id") || "", json: body, info };
  }

  /**
   * 扫描当前编辑器里所有「段落形态的围栏残留」。
   * @param {import("../index.js").default} plugin
   * @returns {Array<{id:string, json:string, info:string}>}
   */
  function findParagraphFences(plugin) {
    const out = [];
    if (typeof document === "undefined") return out;
    const seen = new Set();
    const wanted = `${plugin.name}/${BLOCK_TYPE}`;
    document.querySelectorAll(".protyle-wysiwyg").forEach((root) => {
      root.querySelectorAll('[data-type="NodeParagraph"]').forEach((el) => {
        const id = el.getAttribute("data-node-id");
        if (!id || seen.has(id)) return;
        const hit = parseParagraphFence(el);
        if (!hit || !hit.id) return;
        // 已经是对的就别动
        if (hit.info === wanted) return;
        // 只处理本插件相关写法（或旧的无斜杠写法）
        const isOurs =
          hit.info === plugin.name ||
          hit.info === BLOCK_TYPE ||
          hit.info === wanted ||
          hit.info.indexOf(BLOCK_TYPE) >= 0;
        if (!isOurs) return;
        seen.add(id);
        out.push(hit);
      });
    });
    return out;
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }
  return {
    __cjs: false,
    collapseAllOpenEmbeds,
    parseEmbed,
    stringifyEmbed,
    BLOCK_TYPE,
    embedLang,
    buildEmbedMarkdown,
    extractJson,
    insertEmbedIntoDoc,
    repairFenceBlock,
    registerEmbed,
    bindPluginApi,
    renderInPlace,
    migrateLegacyEmbeds,
    parseLegacyFence,
    findLegacyFenceBlocks,
    parseParagraphFence,
    findParagraphFences,
  };
})();

/* ===== src/tree.js ===== */
const __mod_tree = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const showMessage = SIYUAN.showMessage;
  const confirm = SIYUAN.confirm;
  const Menu = SIYUAN.Menu;
  const API = __mod_api.API;
  const extOf = __mod_api.extOf;
  const isEditable = __mod_api.isEditable;
  const nodeKey = __mod_api.nodeKey;
  const webDiskUrl = __mod_api.webDiskUrl;
  const displayMountPath = __mod_api.displayMountPath;
  const displayCrumbPath = __mod_api.displayCrumbPath;
  const typeIconEl = __mod_icons.typeIconEl;
  const diag = __mod_proxy.__exports.diag;
  const insertEmbedIntoDoc = __mod_embed.insertEmbedIntoDoc;
  /* ==========================================================================
   * 侧边栏文件树（需求 ①）
   * --------------------------------------------------------------------------
   * 交互参照思源原生文档树：
   *   · 懒加载：展开才请求
   *   · 单击展开/收起目录，双击目录进入（与原生一致）
   *   · 单击文件 → 在当前页签预览；双击文件 → 新页签打开
   *   · 右键菜单：新建文件夹 / 重命名 / 删除 / 下载 / 复制路径 / 嵌入文档
   *   · 顶部：盘符切换 + 刷新 + 过滤
   *
   * 状态管理：不做全局 store，每个节点的展开状态挂在自身 DOM 上，
   * 只有「哪些路径展开过」用一个 Set 记录，刷新时据此恢复。
   * ========================================================================== */

  /* ★★★ 必须显式导入 Menu（2026-09-22 踩过的坑）★★★
   *
   *   思源**不会**把 UI 组件挂到 window 上 —— `new Menu("nbTreeNode")` 里的
   *   `Menu` 只是一个自由的标识符。原先这份文件只导入了
   *   `{ showMessage, confirm }`，于是 showNodeMenu / showMoreMenu 一被调用
   *   就抛：
   *
   *       ReferenceError: Menu is not defined
   *         at FileTree.showNodeMenu (plugin:siyuan-nebuladisk:5031:20)
   *
   *   而 `row.oncontextmenu = (ev) => this.showNodeMenu(ev, entry)` 是
   *   事件回调，异常被浏览器吞进控制台 ⇒ 表现就是**右键完全没反应、菜单不出来**，
   *   页面本身不报错、不白屏。用户的原话是「右键菜单…这个我没有看到」。
   *
   *   教训：**「UI 元素没出现」先怀疑 ReferenceError，而不是怀疑样式/定位。**
   *   菜单代码再完整，只要构造它的那个类没导入，就是一个死字面量。
   *   定位方式：直接把 handler 拿出来调（console 里
   *   `window.__nebuladiskPlugin.tree.showNodeMenu(ev, entry)`），
   *   异常会原样抛到调用方，比看被吞掉的事件回调快得多。
   */







  /* -------------------------------------------------------------------------
   * 菜单定位参数
   *
   * ★★★ Menu.open() 的真实契约（2026-09-22 实测 + 反编译确认）★★★
   *
   *   先说结论：**思源自己的每一处调用都是 `{ x, y, h, isLeft }`**。
   *   在思源前端 bundle（main.<hash>.js）里 grep 全部 open( 调用点，
   *   形如：
   *
   *       window.siyuan.menus.menu.popup({ x: W.right, y: W.bottom, h: W.height, isLeft: true })
   *       menu.open({ x: S.left, y: S.bottom, h: S.height, w: S.width, isLeft: true })
   *
   *   —— **`h` = 锚点元素的高度**，`isLeft` 决定向左还是向右展开。
   *   没有任何一处传 clientHeight。而定位逻辑里读的也是 `position.h`：
   *
   *       if (ae.h > 0) { ... 用 h 算向上/向下翻转 ... }
   *
   *   反过来，这几个写法都**实测失败**：
   *     · open({ x, y })                → 不抛，但**菜单不出现**（静默失败）
   *     · open({ clientX, clientY })    → TypeError（见下）
   *
   *   那个 TypeError 的来历（顺着 stack 反编译出来的）：
   *     思源内部有个「工具栏高度」helper：
   *
   *       const toolbarH = () => {
   *         if (document.getElementById("sidebar")) return 0;
   *         return document.getElementById("toolbar")?.clientHeight
   *                || document.querySelector(".layout-tab-bar").clientHeight;  // ← null!
   *       };
   *
   *     在没有侧边栏 / 没有 #toolbar 的上下文里，最后那个
   *     `.layout-tab-bar` 取到 null ⇒
   *       TypeError: Cannot read properties of null (reading 'clientHeight')
   *     这只是**定位兜底链断了**，跟我们的坐标参数无关。
   *
   *   ⇒ 所以正确姿势是：给足 `{ x, y, h }`，让思源走正常定位分支，
   *     不要让它去摸那条会断的兜底链。
   *
   *   返回 { x, y, h }：
   *     · x / y —— 鼠标位置；无事件时退回元素右下角
   *     · h     —— 锚点元素高度（思源拿来判断向上还是向下展开）
   */
  function menuAnchor(ev) {
    // 事件可能来自：真实鼠标事件 / 合成事件 / 定时器（无事件）。
    const hasCoords = ev && typeof ev.clientX === "number" && typeof ev.clientY === "number";
    const tgt =
      (ev && ev.currentTarget) ||
      (hasCoords && ev.target) ||
      document.querySelector(".nb-tree-bar") ||
      document.getElementById("sidebar") ||
      document.body;

    const rect = tgt && tgt.getBoundingClientRect
      ? tgt.getBoundingClientRect()
      : { left: 0, top: 0, bottom: 20, height: 20, right: 0, width: 0 };

    return {
      x: hasCoords ? ev.clientX : Math.round(rect.left + rect.width),
      y: hasCoords ? ev.clientY : Math.round(rect.bottom),
      // ★ 关键：思源用 h 做向上/向下翻转，缺了它就退回会断的兜底链
      h: Math.round(rect.height) || 20,
    };
  }

  class FileTree {
    /**
     * @param {import("../index.js").default} plugin
     * @param {HTMLElement} element 停靠面板容器
     */
    constructor(plugin, element) {
      this.plugin = plugin;
      this.el = element;
      this.mounts = [];
      this.currentMount = "";
      this.expanded = new Set();     // 展开过的节点 key，用于刷新后恢复
      this.filter = "";
      this.destroyed = false;
      this.proxyOk = true;
      this.sessionOk = true;
      this._renderToken = 0;
      /** bootstrap 重入保护（见 bootstrap） */
      this._bootstrapping = false;
      this._bootQueued = false;
      /** 是否已完成首次引导（render 复用判断） */
      this._booted = false;
      /** 需求 ④：拖拽插入。当前正在被拖的条目（拖完清空） */
      this._dragging = null;
      /** 拖拽插入相关监听器的引用，destroy 时要摘掉（否则面板重建会叠加监听） */
      this._dropBound = false;
      this._onDragOver = null;
      this._onDrop = null;
      this._onDragLeave = null;
      /** 任务⑫：从系统拖文件进来上传。当前高亮的落点目录路径（"" = 当前目录） */
      this._uploadTarget = null;
      this._uploadBound = false;
      this._uploadTargetEl = null;
      this._onUploadDragOver = null;
      this._onUploadDrop = null;
      this._onUploadDragLeave = null;
      /** 上传进行中标记：防手滑连点/连拖导致重复上传同一批文件 */
      this._uploading = false;

      // 拖拽是「文件树 → 正文」的跨面板交互，监听器必须挂在 document 上：
      // 文件树在右侧停靠栏，正文在中间，两者相邻但互不包含。
      this.bindDragDrop();
      // ⚠️ 任务⑫ 的上传监听**不能**在这里挂 ★
      //   它要挂在 `this.treeEl` 上，而 treeEl 是在 render() 里才创建的。
      //     · bindDragDrop 挂的是 document ⇒ 构造期就有，OK
      //     · bindUploadDrop 挂的是 treeEl ⇒ 构造期还是 undefined
      //   第一版我照着上面那行一起写在了构造函数里，直接炸：
      //     TypeError: Cannot read properties of undefined (reading 'addEventListener')
      //       at FileTree.bindUploadDrop
      //       at new FileTree        ← 构造就失败，整个侧边栏都起不来
      //   这个错在**单元测试里发现不了**（没有 DOM、也没有真的去 new），
      //   是真机打开面板时才暴露的。所以它必须紧跟在 treeEl 创建之后（见 render）。
    }

    /* =====================================================================
     * 需求 ④：从文件树拖拽到笔记正文，在落点处插入嵌入块
     *
     * 设计要点（每条都是踩过或推理过才定下来的）
     * ---------------------------------------------------------------------
     * ① 监听挂在 **document** 上，不是挂在文件树上。
     *    drop 发生在**正文**（中间区），跟文件树（右侧停靠栏）是两个相邻但
     *    互不包含的 DOM 子树。挂在树上永远收不到 drop。
     *
     * ② 用 capture 阶段监听 dragover，并且 `preventDefault()`。
     *    HTML5 DnD 的规矩：**只有 dragover 里 preventDefault，才会触发 drop**。
     *    这一条最容易漏，现象是「松手后毫无反应、控制台连日志都没有」。
     *
     * ③ 落点解析交给 `resolveDropBlock(el)`：
     *    el = document.elementFromPoint(x, y) → 往上找最近的 [data-node-id]。
     *    拿到的是**正文里那个块** ⇒ 插到它后面，这才是「拖哪儿插哪儿」。
     *    拿不到（拖到空白/页面外）⇒ 返回 null，走 locateInsertPoint 的常规兜底。
     *
     * ④ 只有携带我们自定义 MIME 的拖拽才处理。
     *    否则用户从 VS Code / 浏览器拖一段文本进来，也会被我们当成网盘文件。
     * ================================================================== */
    bindDragDrop() {
      if (this._dropBound) return;
      this._dropBound = true;
      const DND_MIME = "application/x-nebuladisk-embed";

      this._onDragOver = (ev) => {
        if (!this._dragging) return;              // 不是我们拖的，完全不干预
        // ★ #55：理论上拖拽源头已不再产出 isDir 载荷（attachEmbedDrag 直接不给
        //   文件夹开 draggable），这里是第二道闸：万一有陈旧载荷，也别显示落点高亮，
        //   否则会给出「松手就能插进去」的假承诺。
        if (this._dragging.isDir) return;
        // ★ 关键：必须 preventDefault，否则不触发 drop ★
        ev.preventDefault();
        try { ev.dataTransfer.dropEffect = "copy"; } catch { /* 某些环境只读 */ }
        // 高亮落点块，给用户「会插到这里」的即时反馈
        const block = this.resolveDropBlock(document.elementFromPoint(ev.clientX, ev.clientY));
        const prev = this._lastDropBlock;
        if (prev && prev !== block) prev.classList.remove("nb-drop-target");
        if (block) {
          block.classList.add("nb-drop-target");
          this._lastDropBlock = block;
        } else {
          this._lastDropBlock = null;
        }
      };

      this._onDrop = async (ev) => {
        if (!this._dragging) return;
        let payload = null;
        try {
          const raw = ev.dataTransfer.getData(DND_MIME);
          if (raw) payload = JSON.parse(raw);
        } catch (e) {
          diag(`[tree] drop 解析 payload 失败：${e && e.message}`);
        }
        if (!payload) payload = this._dragging;    // 退而用记住的那份
        if (!payload) return;

        ev.preventDefault();
        ev.stopPropagation();

        // 落点块：拖到哪就插到哪
        const targetEl = this.resolveDropBlock(document.elementFromPoint(ev.clientX, ev.clientY));
        this._dragging = null;
        if (this._lastDropBlock) {
          this._lastDropBlock.classList.remove("nb-drop-target");
          this._lastDropBlock = null;
        }

        diag(`[tree] drop：${payload.mount}:${payload.path} → 落点块 ${targetEl ? (targetEl.getAttribute("data-node-id") || "无id") : "（未命中，走兜底）"}`);

        // 复用唯一的插入通道；anchorEl 传落点块 ⇒ 先插到它后面
        try {
          // ★ #55：文件夹不再可拖，正常情况走不到这里。
          //   但保留这道闸门 —— 万一有**历史遗留**的 dataTransfer（比如从旧版页面
          //   拖过来的、或第三方伪造的 MIME），也不能把文件夹塞成嵌入块。
          if (payload.isDir) {
            diag(`[tree] drop 收到文件夹（#55 已不支持）：${payload.mount}:${payload.path}，忽略`);
            showToast("文件夹不支持拖拽插入（请拖单个文件）");
            return;
          }
          const editor = getActiveEditor();
          const spec = { kind: "file", mount: payload.mount, path: payload.path, name: payload.name };
          const ok = await insertEmbedIntoDoc(this.plugin, editor, spec, {
            anchorEl: targetEl || null,
            fromSlash: false,          // 拖拽没有斜杠残留，别去清正文
          });
          showToast(ok ? "已插入网盘嵌入块" : "插入失败：内核没有生成自定义块");
        } catch (e) {
          if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
          showToast(`嵌入失败：${(e && e.message) || "未知原因"}`);
        }
      };

      this._onDragLeave = (ev) => {
        // 拖出窗口时清掉高亮（拖到别的元素上 dragover 会继续更新，不用管）
        if (ev.relatedTarget) return;
        if (this._lastDropBlock) {
          this._lastDropBlock.classList.remove("nb-drop-target");
          this._lastDropBlock = null;
        }
      };

      document.addEventListener("dragover", this._onDragOver, true);
      document.addEventListener("drop", this._onDrop, true);
      document.addEventListener("dragleave", this._onDragLeave, true);
    }

    unbindDragDrop() {
      if (!this._dropBound) return;
      this._dropBound = false;
      document.removeEventListener("dragover", this._onDragOver, true);
      document.removeEventListener("drop", this._onDrop, true);
      document.removeEventListener("dragleave", this._onDragLeave, true);
      if (this._lastDropBlock) {
        this._lastDropBlock.classList.remove("nb-drop-target");
        this._lastDropBlock = null;
      }
    }

    /**
     * 把一个 DOM 元素解析成「正文里可以被锚定的块元素」。
     *
     * ★ 为什么是「往上找最近的 [data-node-id] 且必须在 .protyle-wysiwyg 内」★
     *   正文的块都带 data-node-id，但**外层容器**（页签头、工具栏、文档标题）
     *   也可能带。如果不限定在 .protyle-wysiwyg 内，用户把文件拖到页签头附近
     *   就会拿到一个非正文块，插出来的位置完全不可预期。
     *   限定之后：命中 ⇒ 一定是个真块；未命中 ⇒ 老实返回 null 走兜底。
     *
     * @param {Element|null} el
     * @returns {Element|null}
     */
    resolveDropBlock(el) {
      if (!el || el.nodeType !== 1) return null;
      try {
        const holder = el.closest ? el.closest("[data-node-id]") : null;
        if (!holder) return null;
        // 必须在某个编辑器的 wysiwyg 里，才算「正文块」
        const inWysiwyg = holder.closest ? holder.closest(".protyle-wysiwyg") : null;
        if (!inWysiwyg) return null;
        return holder;
      } catch { return null; }
    }

    /* =====================================================================
     * 任务⑫：从系统拖文件/文件夹到「文件树边框内」上传
     *
     * 用户原话：「支持在文件树边框内，拖拽文件或者文件夹进行上传至网盘。」
     *
     * 设计要点（每条都对应一个会踩的坑）
     * ---------------------------------------------------------------------
     * ① 与上面那个 bindDragDrop **方向相反**，所以不能共用一套判定。
     *    上面那个是「树 → 正文」，靠自定义 MIME `x-nebuladisk-embed` 识别，
     *    监听挂 document；这里是「系统 → 树」，识别依据是
     *    `dataTransfer.types` 里有没有 `Files`，监听只挂树容器。
     *    ⇒ 两者互不干扰的前提是：**各自都要把自己不认的拖拽放过去**。
     *    实测过的坏情况：两边都无脑 preventDefault，结果拖系统文件到树上，
     *    树去插嵌入块（因为 `this._dragging` 恰好没清），行为完全错乱。
     *
     * ② **必须挂 `dragover` 且 `preventDefault()`，否则永远不触发 `drop`。**
     *    HTML5 DnD 的硬规矩。漏了它的现象是「松手后毫无反应、控制台一条日志都没有」。
     *
     * ③ **落点目录的判定用 `closest`，不是 `elementFromPoint`。**
     *    拖到树上时，鼠标可能落在行内的图标/文字上，`elementFromPoint` 拿到的是
     *    那个小元素；往上找最近的 `.nb-node-wrap` 更稳。
     *    落点若是**目录**⇒传到该目录里；若是**文件**⇒传到它所在目录；
     *    落在树的**空白处** ⇒ 传根目录 `""`。
     *
     *    ⚠️ 这里**没有** `this.currentPath` 这种东西 —— 实测这份组件根本没有
     *       "当前目录"这个状态（它是整棵树，不是一层层进入的浏览器）。
     *       第一版我凭印象写了 `this.currentPath || ""`，它永远是 `undefined`，
     *       靠 `|| ""` 才没炸；但那是在掩盖一个不存在的前提，已删掉。
     *
     * ④ **目录递归要用 `webkitGetAsEntry()`，不能用 `dataTransfer.files`。**
     *    这是最容易漏的一条：拖一个文件夹进来时，`dataTransfer.files` 里
     *    **只有文件夹本身，一个子文件都没有**（而且各家浏览器行为还不一致）。
     *    要拿到里面的文件必须用 `Item.webkitGetAsEntry()` 得到 `FileSystemEntry`
     *    再自己 `createReader().readEntries()` 递归。
     *    ⚠️ `webkitGetAsEntry()` 会"消耗" item，必须在 `drop` 的**同步**阶段先把
     *       所有 entry 抓出来，异步操作放在抓完之后 —— 否则后面读不到。
     *
     * ⑤ **`readEntries()` 一次最多回 100 条**，必须循环读到返回空数组为止。
     *    这是 FileSystem API 的规范行为，不循环就会静默丢掉第 101 个之后的文件。
     *
     * ⑥ 落点目录**穿透性**：不建中间目录直接传会 404/500。
     *    所以每进一层都先 `mkdir`（目录已存在时后端返回错误，忽略即可）。
     * ================================================================== */
    bindUploadDrop() {
      if (!this._uploadBound) this._uploadBound = true;
      else return;

      /** 这批拖拽是不是「系统文件」——这是唯一的判据 */
      const isFileDrag = (ev) => {
        const dt = ev.dataTransfer;
        if (!dt) return false;
        try {
          // types 在 Safari 下可能是 DOMStringList，统一转数组
          const types = Array.from(dt.types || []);
          return types.indexOf("Files") >= 0;
        } catch { return false; }
      };

      /** 鼠标位置 → 该传到哪个目录。返回值保证是「相对 mount 的目录路径」 */
      const resolveTargetDir = (ev) => {
        try {
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const wrap = under && under.closest ? under.closest(".nb-node-wrap") : null;
          if (wrap && wrap._row) {
            const isDir = wrap._row.dataset.isDir === "1";
            const p = wrap._row.dataset.path || "";
            if (isDir) return p;                        // 拖到目录上 ⇒ 进这一层
            return parentOf(p);                         // 拖到文件上 ⇒ 进它所在的目录
          }
        } catch { /* 忽略，落到兜底 */ }
        // 落在树的空白处 ⇒ 根目录。
        //   （这份组件没有"当前目录"状态，见方法头注释 ③）
        return "";
      };

      /** 高亮掉这一个落点行，并只高亮这一个 */
      const highlight = (wrap) => {
        const prev = this._uploadTargetEl;
        if (prev === wrap) return;
        if (prev) prev.classList.remove("nb-drop-dir");
        if (wrap) wrap.classList.add("nb-drop-dir");
        this._uploadTargetEl = wrap || null;
      };
      const clearHighlight = () => highlight(null);

      this._onUploadDragOver = (ev) => {
        // ★ 不是系统文件就完全不干预 ★
        //   这一句是「不影响正文拖拽」的关键：树→正文的拖拽 types 里没有 Files，
        //   所以这里直接放行走人，绝不 preventDefault。
        if (!isFileDrag(ev)) return;
        // ★ 必须 preventDefault，否则不触发 drop ★
        ev.preventDefault();
        ev.stopPropagation();
        try { ev.dataTransfer.dropEffect = "copy"; } catch { /* 只读 */ }
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const wrap = under && under.closest ? under.closest(".nb-node-wrap") : null;
        highlight(wrap);
      };

      this._onUploadDragLeave = (ev) => {
        if (!isFileDrag(ev)) return;
        // relatedTarget 为空 = 真的离开了树（进了子元素的不算）
        if (ev.relatedTarget) return;
        clearHighlight();
      };

      this._onUploadDrop = async (ev) => {
        if (!isFileDrag(ev)) return;
        // ★ 到这里一定要拦住：否则浏览器会直接打开/下载这个文件 ★
        ev.preventDefault();
        ev.stopPropagation();

        const dir = resolveTargetDir(ev);
        clearHighlight();

        if (this._uploading) {
          showToast("已有上传在进行中，请稍候");
          return;
        }

        // ★ 必须在同步阶段抓 entry：webkitGetAsEntry() 一旦跨了 await 就取不到 ★
        let entries = [];
        try {
          const items = Array.from(ev.dataTransfer.items || []);
          entries = items
            .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
            .filter(Boolean);
        } catch (e) {
          diag(`[tree] webkitGetAsEntry 失败：${e && e.message}`);
        }

        // 兜底：拿不到 entry 就用扁平文件列表（拖多个平铺文件时够用；
        //       拖文件夹时这里只会拿到文件夹本身，所以只是兜底不是主路径）
        if (!entries.length) {
          const files = Array.from(ev.dataTransfer.files || []);
          if (!files.length) {
            showToast("没有识别到可上传的文件");
            return;
          }
          const tasks = files
            .filter((f) => f.name && f.size >= 0)
            .map((f) => ({ file: f, relDir: "" }));
          await this._runUploadBatch(tasks, dir);
          return;
        }

        this._uploading = true;
        try {
          showToast("正在读取拖入的内容…");
          const tasks = [];
          for (const entry of entries) {
            await collectEntry(entry, "", tasks);
          }
          if (!tasks.length) {
            showToast("拖入的内容里没有文件");
            return;
          }
          await this._runUploadBatch(tasks, dir);
        } catch (e) {
          diag(`[tree] 读取拖入内容失败：${e && e.message}`);
          showToast(`读取拖入内容失败：${e && e.message}`);
        } finally {
          this._uploading = false;
        }
      };

      this.treeEl.addEventListener("dragover", this._onUploadDragOver, true);
      this.treeEl.addEventListener("dragleave", this._onUploadDragLeave, true);
      this.treeEl.addEventListener("drop", this._onUploadDrop, true);
    }

    unbindUploadDrop() {
      if (!this._uploadBound) return;
      this._uploadBound = false;
      if (!this.treeEl) return;
      this.treeEl.removeEventListener("dragover", this._onUploadDragOver, true);
      this.treeEl.removeEventListener("dragleave", this._onUploadDragLeave, true);
      this.treeEl.removeEventListener("drop", this._onUploadDrop, true);
      if (this._uploadTargetEl) {
        this._uploadTargetEl.classList.remove("nb-drop-dir");
        this._uploadTargetEl = null;
      }
    }

    /**
     * 真正干活的：先把需要的目录建出来，再逐个传文件。
     *
     * ★ 为什么"先建全部目录、再传文件"而不是边传边建 ★
     *   拖进来的可能是 `a/b/c.png` 这种嵌套结构，同一个中间目录会被多次用到。
     *   边传边建就要求每次都判断"是不是已经建过"，逻辑分散且容易重复请求。
     *   一次性去重后先建完，后面传文件就是纯粹的顺序上传，心智负担小得多。
     *
     * @param {Array<{file: File, relDir: string}>} tasks  relDir 是相对落点目录的子目录
     * @param {string} baseDir 落点目录（相对 mount 的路径）
     */
    async _runUploadBatch(tasks, baseDir) {
      const total = tasks.length;

      // ── ① 收集需要创建的目录（含中间层），去重 ────────────────────────
      const dirs = new Set();
      for (const t of tasks) {
        if (!t.relDir) continue;
        const parts = String(t.relDir).split("/").filter(Boolean);
        let acc = "";
        for (const seg of parts) {
          acc = acc ? acc + "/" + seg : seg;
          dirs.add(acc);
        }
      }

      // 建目录：已存在时后端会报错，直接吞掉（这是**正常情况**，不是失败）
      //
      // ★ 必须逐级建 ★
      //   拖进来 `图纸/2024/a.step` 时，`图纸` 和 `图纸/2024` **都要存在**，
      //   少一层上传就会失败。所以按 "从浅到深" 的顺序逐级 mkdir。
      //   （之前写了两趟，第一趟只建第一段，是多余且容易看错的，已合并成一趟。）
      if (dirs.size) {
        const ordered = Array.from(dirs).sort(
          (a, b) => a.split("/").length - b.split("/").length,
        );
        let done = 0;
        for (const d of ordered) {
          done++;
          showToast(`准备目录 ${done}/${ordered.length}：${d}`);
          let parent = baseDir;
          for (const seg of d.split("/")) {
            try { await API.mkdir(this.currentMount, parent, seg); } catch { /* 已存在 */ }
            parent = parent ? parent + "/" + seg : seg;
          }
        }
      }

      // ── ② 逐个上传 ───────────────────────────────────────────────────
      let ok = 0;
      const failed = [];
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const label = `上传 ${i + 1}/${total}：${t.file.name}`;
        // 目标目录 = 落点目录 + 该文件所属子目录
        const targetDir = t.relDir
          ? (baseDir ? baseDir + "/" + t.relDir : t.relDir)
          : baseDir;
        try {
          await API.upload(
            { mount: this.currentMount, path: targetDir },
            t.file,
            (ratio) => {
              const pct = Math.round((ratio || 0) * 100);
              if (pct % 20 === 0) showToast(`${label} ${pct}%`);
            },
          );
          ok++;
        } catch (e) {
          failed.push(`${t.file.name}（${(e && e.message) || "未知"}）`);
          diag(`[tree] 上传失败 ${t.relDir}/${t.file.name}：${e && e.message}`);
        }
      }

      // ── ③ 汇报 + 刷新落点目录 ─────────────────────────────────────────
      if (failed.length) {
        showToast(`上传完成：成功 ${ok}/${total}，失败 ${failed.length} 个`);
        diag(`[tree] 上传失败清单：\n` + failed.join("\n"));
      } else {
        showToast(`上传完成：${ok} 个文件`);
      }
      await this.reloadDir(baseDir);
    }

    /* =====================================================================
     * 渲染
     * ================================================================== */
    render() {
      if (this.destroyed) return;
      this.el.innerHTML = "";
      this.el.classList.add("nb-tree");

      // ---- 顶部工具条 ----
      const bar = document.createElement("div");
      bar.className = "nb-tree-toolbar";

      this.mountSel = document.createElement("select");
      this.mountSel.className = "b3-select nb-tree-mount";
      this.mountSel.title = "切换盘符";
      this.mountSel.onchange = () => {
        this.currentMount = this.mountSel.value;
        this.expanded.clear();
        // 切换盘符时退出网格视图：不同盘的目录结构不同，
        // 留在网格里会让用户以为"新盘就是这个目录"。回到树视图最不容易误解。
        if (this.gridMode) {
          this.gridMode = false;
          if (this.gridBtn) {
            this.gridBtn.innerHTML = `<svg><use xlink:href="#iconNbGrid"></use></svg>`;
            this.gridBtn.setAttribute("aria-label", "切换到网格视图");
          }
        }
        this.clearResults();
        this.loadRoot();
      };
      bar.appendChild(this.mountSel);

      const mkBtn = (icon, title, handler) => {
        const b = document.createElement("button");
        b.className = "b3-tooltips b3-tooltips__s nb-tree-btn";
        b.setAttribute("aria-label", title);
        b.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
        b.onclick = handler;
        return b;
      };
      bar.appendChild(mkBtn("iconRefresh", "刷新", () => this.refresh(true)));
      bar.appendChild(mkBtn("iconSearch", "搜索（全盘，含未加载的子目录）", () => this.toggleFilter()));

      // ★ 任务㉑：网格 / 列表 视图切换 ★
      //   用户原话：「增加网格显示模式，双击进去下级文件夹。」
      //   网格模式下双击 = 进入该文件夹（列表模式的"双击目录 = 展开树"语义
      //   在网格里没有意义，因为网格不显示层级）。
      this.gridMode = false;
      this.gridBtn = mkBtn("iconNbGrid", "切换到网格视图", () => this.toggleGrid());
      bar.appendChild(this.gridBtn);

      bar.appendChild(mkBtn("iconMore", "更多", (ev) => this.showMoreMenu(ev)));
      this.el.appendChild(bar);

      // ---- 搜索框（默认隐藏）----
      //   ★ 任务㉑：从「前端过滤已加载节点」升级为「后端递归搜索」★
      //     用户原话：「搜索需要对所有文档进行搜索，包含之前没有加载的。」
      //     所以这里的输入会去调 GET /api/search（后端递归遍历），
      //     结果渲染到一个独立的结果面板里，而不是去 display:none 现有节点。
      this.filterWrap = document.createElement("div");
      this.filterWrap.className = "nb-tree-filter";
      this.filterWrap.style.display = "none";
      this.filterInput = document.createElement("input");
      this.filterInput.className = "b3-text-field fn__block";
      this.filterInput.placeholder = "搜索全部文件（含未展开的子目录），支持 pdf、*.png、zip,rar";
      this.filterInput.title =
        "递归搜索整个盘（不只是已展开的部分）。\n" +
        "支持扩展名；*.png 通配；逗号/空格分隔多个（任一命中即显示）。";
      let timer = null;
      this.filterInput.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          // ★ 保留原始串（含 * 、逗号），由后端 _search_terms 统一解析
          this.filter = this.filterInput.value.trim();
          this.applyFilter();
        }, 300);
      };
      this.filterInput.onkeydown = (ev) => {
        // Esc 收起搜索并清空（和原生过滤框的习惯一致）
        if (ev.key === "Escape") {
          ev.stopPropagation();
          this.toggleFilter();
        }
      };
      this.filterWrap.appendChild(this.filterInput);
      this.el.appendChild(this.filterWrap);

      // ---- 搜索结果面板（任务㉑）----
      //   为什么要独立面板而不是复用树：
      //     搜索结果里的条目来自**任意层级**，把它们硬塞进树会破坏
      //     树的结构不变量（父节点没加载、展开状态错乱）。
      //     结果面板是"扁平列表 + 完整路径"，点一下就直接打开，
      //     更符合"搜索 → 找到 → 打开"的用法。
      this.resultsEl = document.createElement("div");
      this.resultsEl.className = "nb-tree-results";
      this.resultsEl.style.display = "none";
      this.el.appendChild(this.resultsEl);

      // ---- 状态条（代理/会话异常时显示）----
      this.banner = document.createElement("div");
      this.banner.className = "nb-tree-banner";
      this.banner.style.display = "none";
      this.el.appendChild(this.banner);

      // ---- 树主体 ----
      this.treeEl = document.createElement("div");
      this.treeEl.className = "nb-tree-body fn__flex-1";
      this.el.appendChild(this.treeEl);

      // ★ 任务⑫：到这里 treeEl 才存在，上传监听必须挂在此处（不是构造函数）★
      //   bindUploadDrop 内部有 `_uploadBound` 幂等判断，render() 被重复调用
      //   也不会叠加监听器。
      this.bindUploadDrop();

      this.treeEl.innerHTML = `<div class="nb-tree-empty">加载中…</div>`;

      // ★ 只在首次渲染时引导 ★
      //   render() 会被重复调用（思源恢复布局、插件复用实例重绘等）。
      //   每次都 bootstrap 的话，同一个盘根会被反复请求（实测同一秒内
      //   几十次 GET /api/list?path=/ ），既浪费又刷日志。
      //   已经引导过就直接复用已有内容，不再重新拉数据。
      if (this._booted) {
        if (this.mounts && this.mounts.length) {
          this.treeEl.innerHTML = "";
          this.loadRoot();
        } else {
          this.bootstrap();
        }
        return;
      }
      this._booted = true;
      this.bootstrap();
    }

    onResize() { /* 原生滚动容器，无需处理 */ }

    destroy() {
      this.destroyed = true;
      // ★ 拖拽监听挂在 document 上，必须显式摘掉 ★
      //   否则每次面板重建都会叠加一组监听器：拖一次文件会插入 N 个块
      //   （N = 面板被重建过几次）。这类泄漏在「打开/关闭侧边栏」反复操作后
      //   才发作，非常难查，所以创建与销毁必须成对。
      this.unbindDragDrop();
      // ★ 任务⑫ 的上传监听也要成对摘掉（理由同上）★
      this.unbindUploadDrop();
      this.mountSel = null;
      this.treeEl = null;
    }

    /* =====================================================================
     * 引导
     * ================================================================== */
    async bootstrap() {
      // ★ 重入保护 ★
      //   render() 可能被连续调用（思源反复 init dock、用户连点刷新）。
      //   没有这道闸时，多个 bootstrap 会并行跑，各自都去 loadMounts →
      //   loadRoot → GET /api/list，请求数翻倍累积（实测刷出过 1600+ 次）。
      //   这里用一个自增 token 保证「只有最后一次调用的结果算数」，
      //   并且同时只允许一个在飞。
      if (this._bootstrapping) {
        this._bootQueued = true;
        return;
      }
      this._bootstrapping = true;
      try {
        // ★ 通道就绪判定必须分通道看 ★
        //   代理通道：代理是异步启动的，要给它时间（旧版只等这一条）。
        //   直连通道：根本不需要代理 —— 只要配了 serverUrl 就能直接开跑。
        //   早先这里无条件等 `boot.status.ok`，而 boot 是「代理启动进度」，
        //   于是配了可直连的地址、但代理因为端口占用起不来时，
        //   面板会一直卡在「通道未就绪」——明明网络是通的。
        if (!this.plugin.canSkipProxy || !this.plugin.canSkipProxy()) {
          for (let i = 0; i < 20; i++) {
            const st = this.plugin.boot ? this.plugin.boot.status : { ok: false };
            if (st.ok) break;
            if (i === 19) {
              // 代理没起来，但可能仍能直连 —— 交给 ensureLogin 去试，
              // 只有在它也确实失败时才提示用户。
              diag(`[tree] 代理未就绪（${st.detail}），改用直连通道尝试`);
              break;
            }
            await sleep(400);
            if (this.destroyed) return;
          }
        }

        // 确保登录
        const ok = await this.plugin.ensureLogin();
        if (this.destroyed) return;
        if (!ok) {
          this.renderLoginPrompt();
          return;
        }
        await this.loadMounts();
      } catch (e) {
        // ★ 兜底：以前这里没有 catch ★
        //   任何未捕获异常都会让面板永远停在「加载中…」，
        //   而错误只出现在控制台（用户看不到）。现在至少给个可见的原因。
        if (!this.destroyed) {
          diag(`[tree] bootstrap 异常：${e && e.message}`);
          this.treeEl.innerHTML = `<div class="nb-tree-empty">加载失败：${escapeHtml(
            (e && e.message) || String(e)
          )}</div>`;
          this.showBanner(`加载失败：${(e && e.message) || e}`, "warn", () => this.plugin.openSetting());
        }
      } finally {
        this._bootstrapping = false;
        if (this._bootQueued) {
          this._bootQueued = false;
          // 期间有新的请求进来 —— 只补跑一次，不叠加
          if (!this.destroyed) this.bootstrap();
        }
      }
    }

    renderLoginPrompt() {
      this.treeEl.innerHTML = "";
      const box = document.createElement("div");
      box.className = "nb-tree-login";
      box.innerHTML = `
        <div class="nb-tree-login-title">尚未登录 NebulaDisk</div>
        <div class="nb-tree-login-desc">请填写账号后登录，或直接在设置里配置自动登录。</div>`;
      const user = document.createElement("input");
      user.className = "b3-text-field fn__block";
      user.placeholder = "用户名";
      user.value = this.plugin.settings.username || "";
      const pass = document.createElement("input");
      pass.className = "b3-text-field fn__block";
      pass.type = "password";
      pass.placeholder = "密码";
      const btn = document.createElement("button");
      btn.className = "b3-button b3-button--text fn__block";
      btn.textContent = "登录";
      btn.onclick = async () => {
        const u = user.value.trim();
        const p = pass.value;
        // 空凭据直接本地拦下 —— 后端会回 422，提示信息不友好
        if (!u || !p) {
          this.showBanner("请填写用户名和密码", "warn");
          return;
        }
        btn.disabled = true;
        btn.textContent = "登录中…";
        try {
          await API.login(u, p);
          this.plugin.settings.username = u;
          this.plugin.settings.password = p;
          await this.plugin.saveSettings();
          this.treeEl.innerHTML = `<div class="nb-tree-empty">加载中…</div>`;
          await this.loadMounts();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "登录";
          this.showBanner(`登录失败：${e.message}`, "warn");
        }
      };
      pass.onkeydown = (e) => { if (e.key === "Enter") btn.click(); };

      const cfg = document.createElement("button");
      cfg.className = "b3-button b3-button--outline fn__block";
      cfg.textContent = "打开设置";
      cfg.onclick = () => this.plugin.openSetting();

      box.appendChild(user);
      box.appendChild(pass);
      box.appendChild(btn);
      box.appendChild(cfg);
      this.treeEl.appendChild(box);
    }

    async loadMounts() {
      try {
        const me = await API.me();
        this.mounts = me.mounts || [];
        this.ooEnabled = !!me.onlyoffice;
        this.cadEnabled = !!me.cad;
        this.sessionOk = true;
        this.hideBanner();
      } catch (e) {
        if (e.status === 401) {
          this.sessionOk = false;
          this.renderLoginPrompt();
          return;
        }
        this.showBanner(`无法读取网盘信息：${e.message}`, "warn", () => this.bootstrap());
        this.treeEl.innerHTML = `<div class="nb-tree-empty">读取失败</div>`;
        return;
      }

      this.mountSel.innerHTML = "";
      if (!this.mounts.length) {
        this.treeEl.innerHTML = `<div class="nb-tree-empty">没有可访问的网盘目录</div>`;
        return;
      }
      for (const m of this.mounts) {
        const o = document.createElement("option");
        o.value = m.label;
        o.textContent = m.label + (m.writable ? "" : "（只读）");
        this.mountSel.appendChild(o);
      }

      const prefer = this.plugin.settings.defaultMount;
      this.currentMount = this.mounts.some((m) => m.label === prefer)
        ? prefer
        : this.mounts[0].label;
      this.mountSel.value = this.currentMount;

      await this.loadRoot();
    }

    async loadRoot() {
      const token = ++this._renderToken;
      // 每轮重新渲染都把「展开调用计数」归零，避免累计误触发上限
      this._expandSeq = 0;
      // ★ 任务㉑：树视图渲染前先摘掉网格样式 ★
      //   grid 会把 .nb-tree-body 变成 CSS Grid（display:grid），
      //   树的层级结构在 grid 下会被摊平，看起来全乱。
      if (this.treeEl) {
        this.treeEl.classList.remove("is-grid");
        this.treeEl.style.display = "";
      }
      this.treeEl.innerHTML = "";
      const root = this.makeNode({
        name: this.currentMount,
        isDir: true,
        path: "",
        isMountRoot: true,
      }, 0);
      this.treeEl.appendChild(root);
      // 盘根默认展开
      await this.expandNode(root);
      if (token !== this._renderToken) return;
      // 恢复上次展开过的目录（迭代实现，见 restoreExpanded）
      if (this.expanded.size) {
        await this.restoreExpanded(root);
      }
      if (token !== this._renderToken) return;
    }

    /* =====================================================================
     * 节点
     * ================================================================== */

    /**
     * ★ 任务30：把任意一个 DOM 元素接上「拖进笔记正文 ⇒ 插入网盘嵌入块」的能力。
     *
     * 为什么要有这个方法
     * --------------------------------------------------------------------
     * 这套 DnD 接线原先只硬编码在 makeNode() 里。于是：
     *   · 文件树的行   → 能拖（因为只有它有这段代码）
     *   · 搜索结果的行 → **拖不动**（用户报的就是这个）
     *   · 网格的格子   → **拖不动**
     * 三处语义完全一样（都是「把 mount:path 塞进 dataTransfer」），
     * 复制三份必然漂移，所以抽成唯一实现，三处都调它。
     *
     * ★ 与 makeNode 里原来那段是**逐字等价**的 —— 搬家，不是重写。
     *   搬家后立刻用测试锁住（test/verify-drag-insert.cjs），
     *   断言「三处都接上了」而不是「至少一处接上了」。
     *
     * @param {HTMLElement} el    要变可拖的元素（行 / 格子）
     * @param {{name:string,isDir:boolean,path:string}} entry 条目信息
     */
    attachEmbedDrag(el, entry) {
      if (!el) return;

      // ★★★ #55：文件夹不再支持「拖拽插入文档」★★★
      //   用户原话：「拖拽插入 网盘嵌入块 取消 文件夹的支持。」
      //
      //   为什么必须在这里拦，而不是在 drop 端拦：
      //     · 只是 drop 端拒绝 ⇒ 用户仍能把文件夹"拖起来"（看到拖影、看到落点高亮），
      //       松手才被无声拒绝 ⇒ 体验比不能拖更差。
      //     · 拖不起来 ⇒ 从源头就没有误导。
      //   所以在**源头**就不给文件夹开 draggable，也不接任何 DnD 回调。
      //
      //   ⚠️ 关键：这**不会**影响任务⑫「从系统拖文件/文件夹到树里上传」。
      //      那条链路是**反方向**的（系统 → 树），判据是 dataTransfer.types 里的
      //      "Files"，落点靠 dataset.isDir / dataset.path，与 el.draggable 无关
      //      （见 bindUploadDrop 的注释 ①）。两者互不依赖，改这里不会碰坏它。
      if (entry && entry.isDir) {
        el.draggable = false;
        el.ondragstart = null;
        el.ondragend = null;
        return el;
      }

      const payloadFor = () => ({
        kind: "file",
        mount: this.currentMount,
        path: entry.path,
        name: entry.name,
        isDir: false,
      });

      // ⚠️ 实测坑：必须 setData 至少一种类型，否则部分浏览器直接不触发 dragstart。
      el.draggable = true;
      el.ondragstart = (ev) => {
        const payload = payloadFor();
        try {
          ev.dataTransfer.effectAllowed = "copy";
          ev.dataTransfer.setData("application/x-nebuladisk-embed",
                                  JSON.stringify(payload));
          // 保底：纯文本形式，落点不支持自定义 MIME 时也能落下点东西
          ev.dataTransfer.setData("text/plain", entry.name || entry.path || "");
        } catch (e) {
          diag(`[tree] dragstart setData 失败：${e && e.message}`);
        }
        // 记录来源，便于在 drop 时判断「这是我们自己拖的」
        this._dragging = payload;
        el.classList.add("is-dragging");
        diag(`[tree] 开始拖拽：文件 ${this.currentMount}:${entry.path}`);
      };
      el.ondragend = () => {
        this._dragging = null;
        el.classList.remove("is-dragging");
        // 拖拽结束后清掉所有高亮（drop 可能落在我们监听不到的地方）
        try {
          document.querySelectorAll(".nb-drop-target")
            .forEach((x) => x.classList.remove("nb-drop-target"));
        } catch { /* 忽略 */ }
      };
      return el;
    }

    /**
     * 生成一个节点 DOM
     * @param {{name:string,isDir:boolean,path:string,isMountRoot?:boolean,size?:number,mtime?:number,ext?:string,readonly?:boolean}} entry
     * @param {number} depth
     */
    makeNode(entry, depth) {
      // ★ 兜底：把 path 归一成字符串 ★
      //   后端列表条目不返回 path，正常路径由 expandNode 拼好再传进来。
      //   这里再做一次防御：万一别处（Picker/嵌入块/恢复展开）漏拼了，
      //   至少不会出现 undefined 落进 dataset 和被当成根目录请求的情况。
      if (entry && typeof entry.path !== "string") {
        entry = Object.assign({}, entry, { path: entry.isMountRoot ? "" : "" });
      }
      const key = nodeKey(this.currentMount, entry.path);
      const row = document.createElement("div");
      row.className = "nb-node" + (entry.isDir ? " is-dir" : " is-file");
      row.dataset.key = key;
      row.dataset.path = entry.path;
      row.dataset.name = entry.name;
      row.dataset.isDir = entry.isDir ? "1" : "0";
      row.dataset.depth = String(depth);
      row.style.paddingLeft = `${6 + depth * 14}px`;

      // ★★★ 需求 ④：把文件树里的条目「拖进笔记正文」★★★
      //
      //   ★ 为什么用 HTML5 DnD 而不是自定义鼠标事件 ★
      //     思源正文只是个 contenteditable，**不认**自定义拖拽协议；
      //     而 HTML5 DnD 的 drop 事件会带 clientX/clientY，能算出落点在哪个块，
      //     这正是「拖到哪儿就插到哪儿」需要的。
      //
      //   ★ 为什么必须同时写 text/plain 和自定义 MIME ★
      //     · 自定义 MIME（application/x-nebuladisk-*）是**我们自己的握手暗号**：
      //       只有本插件的 drop 处理器会读它，不会误伤用户从别处拖进来的文本。
      //     · text/plain 是**保底**：万一 drop 落在思源原生编辑器上（没有我们的
      //       处理器），用户至少得到一个可读的「网盘路径」，而不是一片死寂。
      //       这是刻意选择的降级行为 —— 无声失败比降级更糟。
      //
      //   ⚠️ 实测坑：必须 setData 至少一种类型，否则部分浏览器直接不触发 dragstart。
      //
      //   ★ 任务30：抽成 attachEmbedDrag()，树节点 / 搜索结果行 / 网格格子 三处共用 ★
      //     用户原话：「搜索结果需要支持拖拽插入文档功能」。
      //     之前这套接线只写在 makeNode 里，所以**搜索结果和网格格子根本拖不动**
      //     （实测 makeResultRow 里 draggable/ondragstart/setData 全为 false）。
      //     复制三份必然漂移，所以抽成一个方法，三处都调它。
      this.attachEmbedDrag(row, entry);

      // 展开箭头
      const arrow = document.createElement("span");
      arrow.className = "nb-node-arrow";
      if (entry.isDir && !entry.isMountRoot) arrow.innerHTML = `<svg><use xlink:href="#iconPlay"></use></svg>`;
      if (entry.isMountRoot) arrow.innerHTML = `<svg><use xlink:href="#iconPlay"></use></svg>`;
      row.appendChild(arrow);

      // 图标
      //   ★ 任务25b：目录也统一交给 icons.js 的 typeIconEl()，
      //     好处是 class 一致（.nb-type-icon--dir，颜色/尺寸只在 CSS 里定义一次），
      //     以后调图标只改一处。
      const ico = document.createElement("span");
      ico.className = "nb-node-icon";
      try {
        ico.appendChild(typeIconEl(entry.isDir ? "" : (entry.ext || extOf(entry.name)), !!entry.isDir));
      } catch {
        // 兜底：图标失败也不能让整行渲染不出来。
        //   ★ 任务29：原来这里 <use #iconNbFolderClosed>，但那个 symbol 已随
        //     「网盘风格图标」改造被移除（文件夹现在是 icons.js 里的内联 svg）。
        //     改用思源内置的 iconFolder —— 它比自定义 id 更稳（一定存在）。
        if (entry.isDir) ico.innerHTML = `<svg><use xlink:href="#iconFolder"></use></svg>`;
      }
      row.appendChild(ico);

      // 名称
      const name = document.createElement("span");
      name.className = "nb-node-name";
      name.textContent = entry.name;
      if (entry.name.length > 34) name.title = entry.name;
      row.appendChild(name);

      // 只读标记
      if (entry.readonly) {
        const ro = document.createElement("span");
        ro.className = "nb-node-ro";
        ro.textContent = "只读";
        row.appendChild(ro);
      }

      // 子容器
      const children = document.createElement("div");
      children.className = "nb-children";
      children.style.display = "none";

      const wrap = document.createElement("div");
      wrap.className = "nb-node-wrap";
      wrap.appendChild(row);
      wrap.appendChild(children);
      wrap._row = row;
      wrap._children = children;
      wrap._entry = entry;
      wrap._depth = depth;
      wrap._loaded = false;
      wrap._loading = false;

      // ---- 事件 ----
      //
      // ★★★ 单击 = 只选中；双击 = 才执行（2026-09-23 按用户要求改）★★★
      //
      //  改动前的行为：
      //    · 单击文件 ⇒ 直接打开预览/编辑页签
      //    · 单击目录 ⇒ 直接展开/收起
      //  用户反馈「需要双击才执行打开，目前是单击就打开了」—— 单击就打开确实太"热"：
      //  侧边栏是拿来浏览的，鼠标一路划过去会误开一堆页签；而且右键菜单/拖拽
      //  也都发生在这些行上，单击即打开会让那些操作更容易误触。
      //
      //  新行为（和桌面文件管理器一致）：
      //    · 单击        ⇒ 仅选中（高亮），不做任何打开动作
      //    · 双击文件    ⇒ 打开页签；双击目录 ⇒ 展开/收起
      //    · 目录前的箭头 ⇒ **保留单击**（它是明确的展开控件，双击会显得迟钝）
      //    · Ctrl/Cmd+单击 ⇒ 后台打开（保留原有便利，不破坏老习惯）
      //
      //  ⚠️ 别把双击再绑回"仅文件"：目录双击必须能展开，
      //     否则习惯双击进目录的用户会觉得树"点不动"。
      const isOpenModifier = (ev) => ev.ctrlKey || ev.metaKey;

      row.onclick = (ev) => {
        if (this._suppressClick) return;
        // ★ 单击不再打开任何东西。带修饰键的单击仍按老习惯后台打开，
        //   这样"一次点开"的快捷路径还在，只是默认动作变安全了。
        if (isOpenModifier(ev)) {
          if (entry.isDir) this.toggleNode(wrap);
          else this.activateFile(entry, true);
        }
        this.selectRow(row);
      };
      row.ondblclick = (ev) => {
        if (this._suppressClick) return;
        ev.stopPropagation();
        if (entry.isDir) {
          this.toggleNode(wrap);
        } else {
          // 双击 = 用户明确要打开 ⇒ 复用已有页签（newTab=false），
          // 避免点两次就开出两个重复页签。
          this.activateFile(entry, false);
        }
        this.selectRow(row);
      };
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        this.selectRow(row);
        this.showNodeMenu(ev, entry);
      };
      // 目录上的箭头单独响应，避免和 click 冲突。
      // ★ 箭头保持**单击**：它是明确的"展开/收起"控件，
      //   强制双击会让展开操作变得别扭（用户已明确指向了那个三角）。
      arrow.onclick = (ev) => {
        ev.stopPropagation();
        if (entry.isDir) this.toggleNode(wrap);
      };

      // 注意：这里**不**设置任何「需要恢复展开」的标记。
      // 恢复展开由 restoreExpanded() 统一按 this.expanded 驱动，
      // 早期在 makeNode 里打标 + 在 expandNode 里递归消费的写法导致过无界递归。

      return wrap;
    }

    selectRow(row) {
      if (this._selected) this._selected.classList.remove("is-selected");
      this._selected = row;
      row.classList.add("is-selected");
    }

    async toggleNode(wrap) {
      if (!wrap || !wrap._row || !wrap._children) return;
      const row = wrap._row;
      const open = wrap._children.style.display !== "none";
      if (open) {
        wrap._children.style.display = "none";
        row.classList.remove("is-expanded");
        this.expanded.delete(this.nodeKeyOf(wrap._entry));
      } else {
        await this.expandNode(wrap);
      }
    }

    /**
     * 校验一个节点是否「可展开的目录」——这是防请求风暴的最后一道闸。
     *
     * 实战踩坑（2026-09-22）：
     *   恢复展开状态时曾经把**文件节点**也当成目录去 expandNode，
     *   而文件节点没有 path（entry.path === undefined），于是
     *   API.list(mount, undefined) 被后端当成根目录 "/"，
     *   返回同一份根列表 → 继续注册更多子节点 → 每秒几十次重复请求。
     *   日志里表现为清一色的 `entries=34 path=/` 刷屏。
     *
     * 因此：isDir 必须显式为 true；盘根节点必须带 isMountRoot 标记；
     * 其余节点必须有一个**非空字符串** path 才允许请求。
     */
    canExpand(entry) {
      if (!entry || entry.isDir !== true) return false;
      if (entry.isMountRoot === true) return true;
      return typeof entry.path === "string" && entry.path.length > 0;
    }

    /** 节点在 this.expanded 里的 key（盘根与根目录统一为 "/"，与 nodeKey 语义一致） */
    nodeKeyOf(entry) {
      const p = entry && typeof entry.path === "string" && entry.path ? entry.path : "/";
      return nodeKey(this.currentMount, p);
    }

    async expandNode(wrap) {
      // ★ 入参校验（必须）★
      //   实测踩过：递归恢复展开状态时，box.children 里混进过非 wrap 节点
      //   （被 await 期间 DOM 被改写产生），于是 entry=undefined，
      //   expandNode 又拿 entry.path 去请求 /api/list → 参数为 undefined，
      //   然后继续向下递归 —— 表现为 18 秒内 1600+ 次请求的「刷新风暴」，
      //   调用栈是 expandNode 自己递归自己。
      if (!wrap || !wrap._entry || !wrap._row || !wrap._children) {
        return;
      }
      const entry = wrap._entry;
      // ★ 只有目录才允许展开 ★（文件/无 path 节点一律拒绝，见 canExpand 注释）
      if (!this.canExpand(entry)) {
        return;
      }
      const row = wrap._row;
      const box = wrap._children;
      const key = this.nodeKeyOf(entry);

      row.classList.add("is-expanded");
      box.style.display = "block";
      this.expanded.add(key);

      // ★ 已展开过 / 正在展开 → 直接复用，绝不重复请求 ★
      //   必须放在「标记 expanded」之后再判断，否则用户点开已缓存目录时
      //   箭头状态和缓存状态会不一致。顺序：先认领状态，再决定是否发请求。
      if (wrap._loaded || wrap._loading) return;
      // ★ 同节点并发保护 ★
      //   expandNode 可能在同一节点上被并发调用（用户连点箭头、
      //   恢复展开与手动展开撞一起）。没有这个标记时，同一个 path
      //   会被同时请求多次。宁可后面那次直接复用，也不要重复打网盘。
      wrap._loading = true;

      // ★ 兜底闸：单次刷新内 expandNode 的总调用次数上限 ★
      //   正常一棵树也就几十个目录；一旦超过 200，几乎一定是某个逻辑失控
      //   （递归没收敛 / 重复触发）。宁可停止加载也不要把网盘打爆。
      this._expandSeq = (this._expandSeq || 0) + 1;
      if (this._expandSeq > 200) {
        if (this._expandSeq === 201) {
          diag(`[tree] expandNode 调用超过 200 次，已停止继续展开（疑似失控）`);
        }
        return;
      }

      box.innerHTML = `<div class="nb-node-loading" style="padding-left:${
        6 + (wrap._depth + 1) * 14 + 18
      }px">加载中…</div>`;

      let data;
      try {
        data = await API.list(this.currentMount, entry.isMountRoot ? "" : entry.path);
      } catch (e) {
        wrap._loading = false;
        box.innerHTML = `<div class="nb-node-err" style="padding-left:${
          6 + (wrap._depth + 1) * 14 + 18
        }px">${escapeHtml(e.message)}</div>`;
        return;
      }
      wrap._loading = false;
      if (this.destroyed) return;

      box.innerHTML = "";
      const entries = data.entries || [];
      if (!entries.length) {
        box.innerHTML = `<div class="nb-node-empty" style="padding-left:${
          6 + (wrap._depth + 1) * 14 + 18
        }px">（空）</div>`;
      }

      // ★★★ 必须由插件自己拼出子节点的 path ★★★
      //   后端 /api/list 的每条 entry **只有**
      //     { name, isDir, size, mtime, ext, route, mime, readonly }
      //   —— 没有 path 字段（只有响应顶层带 path，即本次请求的目录）。
      //   旧代码直接把 e 丢给 makeNode，于是每个子节点 entry.path === undefined：
      //     · canExpand() 拒绝 ⇒ 子文件夹点不开、点开了也点不开第二层；
      //     · activateFile() 把 undefined 传给 openFile
      //       ⇒ requireMountPath 抛「缺少文件路径参数（path）」，文件无法预览。
      //   修正：用「响应顶层 path（父目录）」+ entry.name 自己合成。
      //   父路径优先用 data.path（后端权威值），拿不到就退回当前节点自己的 path。
      const parentFromData =
        typeof data.path === "string" && data.path ? data.path : null;
      const parentRaw =
        parentFromData !== null
          ? parentFromData
          : entry.isMountRoot
          ? ""
          : typeof entry.path === "string"
          ? entry.path
          : "";
      // 统一成「不以 / 结尾」，根目录归一成 ""
      const parent =
        parentRaw.replace(/\/+$/, "") === "" || parentRaw === "/"
          ? ""
          : parentRaw.replace(/\/+$/, "");

      for (const e of entries) {
        if (!e || typeof e.name !== "string" || !e.name) continue;
        const child = this.makeNode(
          Object.assign({}, e, { path: parent + "/" + e.name }),
          wrap._depth + 1
        );
        box.appendChild(child);
      }
      wrap._loaded = true;
      wrap._mountInfo = data.mount;

      // ★ 这里**不再**递归恢复子节点展开状态 ★
      //   旧写法在此处 `for (child of box.children) await this.expandNode(child)`
      //   ——换来的是一次**无界嵌套递归**：
      //     expandNode(root) → 子目录 expandNode → 孙目录 expandNode → …
      //   而每次递归内部又会重新收集「需要恢复」的子节点，形成自我延续。
      //   实测调用栈是 expandNode 套十几层，最终 entry 变成 undefined，
      //   请求 /api/list 上百次，还停不下来。
      //
      //   现在改成：展开就是展开（只加载这一层），
      //   「刷新后恢复展开状态」由 loadRoot 里一个**有 visited 去重的迭代循环**负责。
      // ★ 任务㉑ 之后这里不再需要「重新过滤」★
      //   旧实现是前端 display:none 过滤：新展开出来的子节点没被过滤过，
      //   所以必须重跑一次 applyFilter()。
      //   现在搜索结果在**独立面板**里（后端递归搜的），与树节点无关，
      //   展开目录不会让结果过时 ⇒ 再调 applyFilter() 只会白发一次网络请求。
      //   （保留注释是为了防止以后有人"顺手补回来"。）
    }

    /**
     * 恢复「上次展开过」的目录（迭代 + visited 去重，绝不再递归）。
     *
     * 做法：从根出发逐层推进 —— 只有当某个目录**真的被展开**时，
     * 才把它返回的子节点排进队列继续看（没展开的分支内部不可能有
     * 已展开的节点，不必往下走）。
     * visited 保证每个节点最多处理一次；expandCount 只统计真实展开次数。
     *
     * ★ 只有目录入队 ★
     *   踩过的坑：曾经把 box.children 里的**所有**节点都入队。
     *   文件节点也被当成待展开对象，而文件没有 path（undefined），
     *   于是 API.list(mount, undefined) 被后端解释成根目录 "/"，
     *   每次都返回同一份根列表，于是又注册出更多文件节点、又入队……
     *   日志里是几十次 `entries=34 path=/` 连刷。
     *   现在文件节点在**入队时**就被过滤掉，且 expandNode 内部还有第二道
     *   canExpand 闸门，双重保险。
     */
    async restoreExpanded(rootWrap) {
      if (!rootWrap) return;
      const visited = new Set();
      const queue = [rootWrap];
      let expandCount = 0;
      while (queue.length) {
        if (this.destroyed) return;
        const wrap = queue.shift();
        if (!wrap || !wrap._entry || visited.has(wrap)) continue;
        visited.add(wrap);
        if (!this.canExpand(wrap._entry)) continue;

        const key = this.nodeKeyOf(wrap._entry);
        // 盘根本身在 loadRoot 里已经展开过，不再重复处理
        if (!wrap._entry.isMountRoot && !this.expanded.has(key)) continue;

        // 硬上限：防御性闸门。正常一棵树几十个目录，上限设 300 足够宽，
        // 真触发了说明有异常逻辑，宁可少展开也不要打爆网盘。
        if (++expandCount > 300) {
          diag("[tree] 恢复展开状态的目录数超过 300，提前结束");
          return;
        }
        await this.expandNode(wrap);

        // ★ 只把「刚展开出来的目录子节点」入队 ★
        //   未展开的分支其内部节点还没被创建，也没有可恢复的对象。
        const box = wrap._children;
        if (box) {
          for (const child of Array.from(box.children)) {
            if (child && child._entry && child._entry.isDir === true) queue.push(child);
          }
        }
      }
    }

    /** 折叠所有已展开节点（简单做法：整树重建） */
    collapseAll() {
      this.expanded.clear();
      this.loadRoot();
    }

    /**
     * 把文件树展开并滚动到 `mount:/path`（任务⑳）。
     *
     * 用户原话：「嵌入文档树到文档这个功能需要调整一下：点击插入后的嵌入块
     *           右侧文档树转跳到这个路径所在位置。」
     *
     * 做法（逐段下钻，而不是整树重建 —— 小目录树才适合重建，网盘可能很深）：
     *   1) 确保树已加载（没挂载过就先 loadMounts）
     *   2) 切到目标 mount（现在树一次只显示一个盘：loadRoot 按 currentMount 取）
     *   3) 把 mount:/各层目录 逐个塞进 this.expanded，再走一次 loadRoot
     *      —— loadRoot → restoreExpanded 会自动把这条路径上的目录全展开
     *   4) 找到最深那层的节点，scrollIntoView + 高亮 + selectRow
     *
     * ★ 为什么用「塞 expanded + 重载」而不是逐层 await expandNode ★
     *   expandNode 每层都要发一次 /api/list，路径深时会有几十个串行请求，
     *   而且任何一层名字大小写/空格不一致就会中断整条链。
     *   反过来：this.expanded 是"要展开哪些 key"的**声明**，
     *   restoreExpanded 已经做了 300 次上限、visited 去重、只对 isDir 生效，
     *   把意图交给它，一次 loadRoot 就够，且失败也只是"没展开"而非"卡住"。
     *
     * @param {string} mount 挂载点名
     * @param {string} path  目录或文件路径（以 / 开头）；文件会取其父目录
     * @returns {Promise<boolean>} 是否成功定位到
     */
    async revealPath(mount, path) {
      const m = String(mount || "").trim();
      let p = String(path || "").replace(/\\/g, "/");
      if (!m) return false;
      if (p && !p.startsWith("/")) p = "/" + p;
      p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");

      // 目标可能是**文件**：树只能定位到目录，文件靠"在目录里高亮"实现。
      // 这里先把"要展开到哪一层"和"要高亮哪个名字"分开。
      const parts = p.split("/").filter(Boolean);
      const lastName = parts.length ? parts[parts.length - 1] : "";
      const lastIsFile = !!(lastName && /\.[^./\\]+$/.test(lastName));

      const dirParts = lastIsFile ? parts.slice(0, -1) : parts;

      try {
        // 1) 树还没建过 ⇒ 先初始化，否则后面找不到任何节点
        if (!this.treeEl.querySelector(".nb-node-wrap")) {
          await this.loadMounts();
        }
        // 2) 切盘（不同盘 ⇒ 必须重载；同盘也要重载才能吃到新的 expanded）
        const needSwitch = this.currentMount !== m;
        this.currentMount = m;

        // 3) 把「盘根 → 各层目录」的 key 全部登记为"应展开"
        //    nodeKey(mount, path) 的实现是 `${mount}::${path || "/"}`，
        //    所以要展开 key = mount::/a/b，逐级就是 mount::/a → mount::/a/b。
        this.expanded.add(nodeKey(m, ""));
        for (let i = 0; i < dirParts.length; i++) {
          this.expanded.add(nodeKey(m, "/" + dirParts.slice(0, i + 1).join("/")));
        }

        await this.loadRoot();

        // 4) 找到最深那层，滚过去 + 高亮
        await new Promise((r) => setTimeout(r, 60));
        const deepest = dirParts.length ? "/" + dirParts.join("/") : "";
        const wantKey = nodeKey(m, deepest);
        let hit = this.treeEl.querySelector(
          `.nb-node-wrap[data-key="${cssEscape(wantKey)}"]`
        );
        // 退一步：按名字找（key 里含 mount 前缀，偶尔会因归一化差异对不上）
        if (!hit && lastName) {
          const rows = Array.from(this.treeEl.querySelectorAll(".nb-node"));
          const row = rows.find((r) => {
            const w = r.closest(".nb-node-wrap");
            const e = w && w._entry;
            return e && e.name === lastName;
          });
          hit = row ? row.closest(".nb-node-wrap") : null;
        }
        if (!hit) return false;

        const row = hit._row || hit.querySelector(".nb-node");
        if (row) {
          this.selectRow(row);
          try {
            row.scrollIntoView({ block: "center", behavior: "smooth" });
          } catch { row.scrollIntoView(); }
          // 短暂闪一下，让用户看见"跳到这里了"
          row.classList.add("nb-node-flash");
          setTimeout(() => row.classList.remove("nb-node-flash"), 1200);
        }
        return true;
      } catch (e) {
        diag("[tree] revealPath 失败: " + ((e && e.message) || e));
        return false;
      }
    }

    async refresh(deep = false) {
      if (deep) this.expanded.clear();
      const keep = new Set(this.expanded);
      // 展开状态要保留 —— 先记下来再重建
      this.expanded = keep;
      await this.loadMounts();
    }

    /* =====================================================================
     * 打开文件
     * ================================================================== */
    activateFile(entry, newTab = false) {
      const item = {
        mount: this.currentMount,
        path: entry.path,
        name: entry.name,
        ext: entry.ext || extOf(entry.name),
        size: entry.size,
        mtime: entry.mtime,
      };

      if (newTab) {
        this.plugin.openFile(item, { forceNew: true });
        return;
      }
      // 优先复用已存在的查看页签
      const reused = tryReuseViewerTab(this.plugin, item);
      if (!reused) this.plugin.openFile(item, { forceNew: true });
    }

    /* =====================================================================
     * 菜  单
     * ================================================================== */

    /**
     * 算出「在浏览器中打开网盘」应该落到哪。
     *
     *   · 有选中行：
     *       文件夹 ⇒ 就是这个目录本身
     *       文件   ⇒ 它的**父目录**（网盘侧没有"高亮某个文件"的能力，
     *                开到它所在的目录已经是当前能做到的最精确落点）
     *   · 没有选中行 ⇒ null（调用方退回首页）
     *
     * ★ 为什么按父目录而不是直接给文件路径 ★
     *   网盘的深链契约是 `Explorer.open(mount, dir)` —— 只接受目录。
     *   直接把文件路径塞进去会让 Explorer 拿到一个不存在的"目录"，
     *   表现为打开一个空窗口。父目录计算与 api.js 的 webDiskUrl() 保持一致。
     */
    _deepLinkTarget() {
      // ★ 注意：this._selected 是 **row**（.nb-node），而 _entry 挂在它的父节点
      //   **wrap**（.nb-node-wrap）上。这里必须往上找一层，别直接读 row._entry。
      const row = this._selected || this.treeEl.querySelector(".nb-node.is-selected");
      if (!row) return null;
      const wrap = row.closest(".nb-node-wrap");
      const entry = (wrap && wrap._entry) || row.__nbEntry;
      if (!entry || !entry.path) return null;
      const mount = this.currentMount || (entry.mount || "");
      if (!mount) return null;
      if (entry.isDir) return { mount, path: entry.path };
      const p = String(entry.path);
      const cut = p.lastIndexOf("/");
      return { mount, path: cut > 0 ? p.slice(0, cut) : "/" };
    }

    showMoreMenu(ev) {
      const menu = new Menu("nbTreeMore");
      menu.addItem({
        icon: "iconRefresh",
        label: "刷新",
        click: () => this.refresh(),
      });
      menu.addItem({
        icon: "iconRefresh",
        label: "刷新并重置展开状态",
        click: () => this.refresh(true),
      });
      menu.addSeparator();
      menu.addItem({
        icon: "iconContract",
        label: "全部折叠",
        click: () => this.collapseAll(),
      });
      menu.addItem({
        icon: "iconSettings",
        label: "插件设置",
        click: () => this.plugin.openSetting(),
      });
      menu.addSeparator();
      // 任务⑰：原来这里是 window.open(settings.serverUrl) —— 打开的是**首页**，
      //   新页签没有会话 ⇒ 只会看到登录页（用户报的「还需要输入密码」）。
      //   现在改成「深链」：带上当前展开/选中节点的 mount+path，
      //   网盘前端 app.js 的 applyDeepLink() 会直接打开那个目录。
      //   有选中节点 ⇒ 开到它的父目录（文件）或它自己（文件夹）；
      //   没有选中 ⇒ 退回首页（保持原行为，至少不是坏链接）。
      menu.addItem({
        icon: "iconLink",
        label: "在浏览器中打开网盘",
        click: () => {
          const base = this.plugin.settings.serverUrl;
          if (!base) { showToast("请在插件设置中填写网盘地址"); return; }
          const target = this._deepLinkTarget();
          if (!target) { window.open(base, "_blank", "noopener"); return; }
          window.open(webDiskUrl(base, target.mount, target.path), "_blank", "noopener");
        },
      });
      menu.addItem({
        icon: "iconLogout",
        label: "退出登录",
        click: async () => {
          await API.logout();
          this.expanded.clear();
          this.treeEl.innerHTML = "";
          this.renderLoginPrompt();
        },
      });
      menu.open(menuAnchor(ev));
    }

    showNodeMenu(ev, entry) {
      const menu = new Menu("nbTreeNode");
      const isDir = entry.isDir;
      const fullPath = (isDir ? entry.path : entry.path);

      if (isDir) {
        menu.addItem({
          icon: "iconAdd",
          label: "新建文件夹",
          click: () => this.promptMkdir(entry.path),
        });
        menu.addSeparator();
      } else {
        menu.addItem({
          icon: "iconEye",
          label: isEditable(entry.name) ? "在线编辑" : "预览",
          click: () => this.activateFile(entry, true),
        });
        menu.addItem({
          icon: "iconDownload",
          label: "下载",
          click: () => this.download(entry),
        });
        // ★ 任务28：右键加「浏览器打开」★
        //   用户原话：「28 右键菜单增加 在浏览器中打开功能 名称为：浏览器打开」
        //
        //   和「在页签中打开」的区别（这两个很容易被混为一谈）：
        //     · 在页签中打开 ⇒ 在**思源内部**开一个 nbViewer 页签，用 iframe 预览。
        //       好处是留在思源里；坏处是某些格式（大 CAD、OO 编辑）受 iframe 限制。
        //     · 浏览器打开   ⇒ 取一条**浏览器可直达**的预览 URL（新窗口），
        //       拿到完整的浏览器能力：缩放、另存、复制地址栏分享、
        //       手机上也能开。用 API.previewUrl()，它内部已过 fixUrl()
        //       把容器内主机名（nebula:8088）换成浏览器可达的地址 ——
        //       这正是用户报过的「复制直链 http://nebula:8088/… 打不开」的根因，
        //       直接拼 raw 链接会重犯这个错。
        //
        //   ⚠️ 目录不提供：目录没有"单文件预览"这回事，
        //      传目录进 /api/preview 会拿到错误页。给目录打开网盘网页版更合理，
        //      但那已经在嵌入块/顶部按钮里有了，右键就不重复塞。
        menu.addItem({
          icon: "iconLink",
          label: "浏览器打开",
          click: () => this.openInBrowser(entry),
        });
        menu.addSeparator();
        menu.addItem({
          icon: "iconNebulaDisk",
          label: "嵌入到文档",
          click: () => this.embedToDoc(entry, "file"),
        });
        menu.addSeparator();
      }

      // ★ 任务27：删掉「复制路径」（用户 2026-09-22）★
      //
      //   原话：「27 复制路径这个功能好像没有什么用，取消，删除」
      //
      //   为什么同意删：
      //     · 路径 `售前项目:/2026年08月/…` 对用户没有可执行价值 ——
      //       粘到浏览器打不开、粘到网盘搜索框也要手工改造，
      //       真正想"分享/留档"用的都是旁边的「复制直链」。
      //     · 它此前还有个实锤 bug：写成 `${mount}:/${entry.path}`，
      //       而 entry.path **本身就以 / 开头**（makeNode 用 parent + "/" + name
      //       拼出来），于是渲染成 `售前项目://托璞勒 宣传册.pdf` —— 多一个斜杠。
      //       用户截图报的就是这个。一个"没什么用 + 还有 bug"的功能，删掉最干净，
      //       而不是修好它继续占菜单位置。
      //
      //   ⇒ 连带删掉了菜单项本身。如果将来要恢复，路径拼接必须写成
      //     `${mount}:${path}`（path 自带前导斜杠），或统一过一遍 normalizePath()。
      menu.addItem({
        icon: "iconLink",
        label: "复制直链",
        click: () => this.copyRawLink(entry),
      });
      menu.addItem({
        icon: "iconEdit",
        label: "重命名",
        click: () => this.promptRename(entry),
      });
      if (isDir) {
        menu.addItem({
          icon: "iconNebulaDisk",
          label: "嵌入到文档",
          click: () => this.embedToDoc(entry, "tree"),
        });
      }
      menu.addSeparator();
      menu.addItem({
        icon: "iconTrashcan",
        label: "删除",
        warning: true,
        click: () => this.confirmDelete(entry),
      });

      menu.open(menuAnchor(ev));
    }

    /* =====================================================================
     * 操  作
     * ================================================================== */
    promptMkdir(dirPath) {
      const name = prompt("新建文件夹名称：");
      if (!name || !name.trim()) return;
      API.mkdir(this.currentMount, dirPath, name.trim())
        .then(() => this.reloadDir(dirPath))
        .catch((e) => showToast(`创建失败：${e.message}`));
    }

    promptRename(entry) {
      const next = prompt("重命名为：", entry.name);
      if (!next || !next.trim() || next === entry.name) return;
      API.rename(this.currentMount, entry.path, next.trim())
        .then(() => this.reloadDir(parentOf(entry.path)))
        .catch((e) => showToast(`重命名失败：${e.message}`));
    }

    async confirmDelete(entry) {
      const yes = await confirmDialog(
        "删除确认",
        `确定要删除「${entry.name}」吗？` +
        (entry.isDir ? "目录会连同其中所有内容一并删除，" : "") +
        "此操作不可恢复。",
      );
      if (!yes) return;
      API.remove(this.currentMount, entry.path)
        .then(() => this.reloadDir(parentOf(entry.path)))
        .catch((e) => showToast(`删除失败：${e.message}`));
    }

    /**
     * 复制「直链」——带签名的 /api/raw 地址，粘到浏览器/别的设备直接能下。
     *
     * ★ 三个必须过的关（缺一个用户就拿不到能用的链接）：
     *
     *   1) **必须取签名直链，不能自己拼 `/api/raw/<name>?mount=&path=`**。
     *      后端 rawlink 路由是要校验 `exp` + `sig` 的，自己拼出来的是 403。
     *      ⇒ 走 API.signedRawUrl()，它内部问 /api/preview 拿签名。
     *
     *   2) **必须过 browserReachableUrl()**。后端 make_raw_url() 用的是
     *      `_internal_origin()` = NEBULA_BASE_URL，典型值 `http://nebula:8088`
     *      —— 这个主机名只有 docker 网内的 OnlyOffice/kkFileView 能解析。
     *      原样复制给用户，粘到浏览器就是 ERR_NAME_NOT_RESOLVED。
     *      这正是用户反馈过的那条打不开的直链：
     *        http://nebula:8088/api/raw/1.2.14.TFDF-6%23%20F%E5%90%91.STEP?...
     *      signedRawUrl() 已经把 browserReachableUrl 包在里面了，这里不用重复。
     *
     *   3) **目录没有直链**。rawlink 只服务文件；对目录就要明确拒绝，
     *      否则会拿回一个指向目录的 404 链接，用户以为复制成功了。
     */
    async copyRawLink(entry) {
      if (entry.isDir) {
        // ★ 任务27：「复制路径」已按用户要求删除，这里不能再引导用户去用它。
        //   目录本来就没有单文件直链（rawlink 只服务文件），
        //   所以要给一个**存在且真的有用**的替代动作：打开网盘网页版定位到该目录。
        showToast("文件夹没有直链，请用「在浏览器中打开网盘」");
        return;
      }
      try {
        const url = await API.signedRawUrl(this.currentMount, entry.path);
        if (!url) throw new Error("后端未返回直链");
        copyText(url, "直链已复制");
      } catch (e) {
        showToast(`取直链失败：${e.message}`);
      }
    }

    /**
     * 在**浏览器**里打开这个文件（任务28 → #62 统一）。
     *
     * ★ 和「在页签中打开」不是一回事 ★
     *   在页签中打开 = 在思源里开 nbViewer 页签，靠 iframe 预览。
     *   浏览器打开   = 另开**浏览器窗口**，拿到完整浏览器能力
     *                  （缩放/另存/复制地址栏发给同事/手机上打开）。
     *
     * ★★★ #62：这里原先用 API.previewUrl()（恒走 kkFileView），现在改用
     *     API.browserViewUrl() —— 与 viewer.openInBrowser() **同一套路由** ★★★
     *
     *   原因：用户报障「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
     *   onlyoffice 预览一样 kkviewer 也一样。」页签那边一律开 `/api/raw`
     *   （字节通道，非原生 MIME 必然变下载）；而本方法恒走 kkFileView。
     *   两处实现不一致，行为就不可预测。
     *
     *   现在两处都收敛到 browserViewUrl()：
     *     · pdf/图片/视频/音频/文本 → /api/raw（浏览器原生，零转换、最快）
     *     · office/压缩包/其它      → kkFileView /preview/onlinePreview（text/html）
     *     · cad                     → cad-viewer 深链
     *   统一过 browserReachableUrl() 改写 nebula:8088 这个容器内主机名。
     *
     * ⚠️ 绝对不要自己拼 `/api/raw/<name>?mount=&path=` ——
     *   后端 rawlink 校验 exp + sig，自己拼是 403。
     *
     * @param {{isDir:boolean,name:string,path:string}} entry
     */
    async openInBrowser(entry) {
      if (entry.isDir) {
        showToast("「浏览器打开」只支持文件；目录请用「打开网盘」");
        return;
      }
      try {
        const url = await API.browserViewUrl(this.currentMount, entry.path, entry.name);
        if (!url) throw new Error("后端未返回可预览的地址");
        const w = window.open(url, "_blank", "noopener,noreferrer");
        // 弹窗被拦截时要明确告诉用户，否则点了没反应像是坏了
        if (!w) showToast("浏览器拦截了新窗口，请允许本站弹出窗口后重试");
      } catch (e) {
        showToast(`浏览器打开失败：${e.message}`);
      }
    }

    async download(entry) {
      // ★ 必须 await 签名直链 ★
      //   直连通道下 /api/download 认 Cookie（跨源 ⇒ 401），
      //   旧的同步 downloadUrl() 更是直接拼 127.0.0.1:6810 ⇒ 连接被拒。
      //   这就是用户报的「下载会报错」。
      let url;
      try {
        url = await API.signedDownloadUrl(this.currentMount, entry.path, false);
      } catch (e) {
        showToast(`下载失败：${e.message}`);
        return;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 100);
    }

    /*
     * 「插入到当前文档」（插一个 markdown 链接）已于 2026-09-23 按用户要求**移除**。
     *
     * 为什么删而不是修：
     *   它和「嵌入到文档」在菜单里并排出现，功能名字又像（都是"放进当前文档"），
     *   用户很难分辨哪个是"插链接"、哪个是"插可预览的嵌入块"。而实际上
     *   「嵌入到文档」完全覆盖了它的使用场景 —— 嵌入块里本来就有「在页签中打开」
     *   和「打开网盘」两个出口。留着只会让人误点。
     *
     *   ⇒ 连带删掉了 insertLinkToDoc() 整个方法（它没有别的调用点）。
     *     如果哪天要恢复：拿 API.previewUrl() 的签名直链，
     *     过 browserReachableUrl()（后端签发的 raw 用容器内主机名 nebula:8088，
     *     浏览器解析不了），再 editor.insert(`[名](url)`) 即可。
     */

    /** 嵌入文件/目录到当前文档 */
    embedToDoc(entry, kind) {
      // ★★★ 不要「拿不到 editor 就提前返回」★★★
      //
      //   2026-09-22 教训（和 viewer.js 是同一个 bug）：
      //   从**侧边栏**点嵌入时，焦点在侧边栏，`getActiveEditor()` 可能返回 null
      //   ⇒ 原先这里直接 showToast("请先把光标放到文档编辑器中") 就 return 了，
      //     **locateInsertPoint 的多级回退（聚焦页签/data-initdata/layout 遍历）
      //     根本没机会执行**，用户明明开着文档却被要求"先把光标放到编辑器"。
      //
      //   ⇒ 定位是 embed.js 的职责，把 null 传下去让它自己回退。
      const editor = getActiveEditor();
      let p = String(entry.path || "");
      if (p && !p.startsWith("/")) p = "/" + p;
      // ★★★ 统一走 insertEmbedIntoDoc（内核 API），别用前端 editor.insert ★★★
      //   前端 insert 在浏览器端会把 `;;;` 围栏存成**普通段落(type=p)**，
      //   笔记里就显示成一坨裸 JSON（桌面端偶发正常，正是难查的原因）。
      //   内核 insertBlock(dataType:"markdown") 才会正确编译成自定义块。
      insertEmbedIntoDoc(this.plugin, editor, {
        kind,
        mount: this.currentMount,
        path: p,
        name: entry.name,
      }).then((ok) => {
        showToast(ok
          ? (kind === "tree" ? "已嵌入目录" : "已嵌入文件")
          : "嵌入失败：内核没有生成自定义块");
        // ★ 任务⑳：插入成功后把**本文件树**定位到该路径 ★
        //   用户原话：「点击插入后的嵌入块 右侧文档树转跳到这个路径所在位置。」
        //   注意这里是"插入之后"由**插件自己**跳 —— 网格/列表两种模式下
        //   用户刚在几十层深的目录里右键了一个文件，插完需要立刻看到
        //   "我插的就是这一个"，否则会怀疑插错。
        //   只在成功时跳；失败时跳过去反而误导。
        if (ok) {
          this.revealPath(this.currentMount, p).catch(() => { /* 定位失败不影响插入 */ });
        }
      }).catch((e) => {
        // ★ 把真实原因 + 定位轨迹显示/打出来 ★
        try {
          if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
        } catch { /* 忽略 */ }
        showToast(`嵌入失败：${(e && e.message) || "未知原因"}`);
      });
    }

    /** 重新加载某个目录（局部刷新） */
    async reloadDir(dirPath) {
      // 找到该目录节点；找不到就整树刷新
      const key = nodeKey(this.currentMount, dirPath);
      const node = this.treeEl.querySelector(`.nb-node-wrap[data-key="${cssEscape(key)}"]`);
      const wrap = dirPath === ""
        ? this.treeEl.firstElementChild
        : (node ? node.closest(".nb-node-wrap") || node : null);

      if (wrap && wrap._row) {
        wrap._loaded = false;
        await this.expandNode(wrap);
      } else {
        await this.loadRoot();
      }
    }

    /* =====================================================================
     * 过滤与状态
     * ================================================================== */
    toggleFilter() {
      const show = this.filterWrap.style.display === "none";
      this.filterWrap.style.display = show ? "block" : "none";
      if (show) {
        this.filterInput.focus();
      } else {
        this.filterInput.value = "";
        this.filter = "";
        this.clearResults();
      }
    }

    /** 收起结果面板，把树还回来（任务㉑） */
    clearResults() {
      if (!this.resultsEl) return;
      this.resultsEl.style.display = "none";
      this.resultsEl.innerHTML = "";
      if (this.treeEl) this.treeEl.style.display = "";
      this._searchToken = (this._searchToken || 0) + 1;
    }

    /**
     * 搜索（任务㉑）—— **后端递归**，不是前端过滤。
     *
     * 用户原话：
     *   「搜索需要对所有文档进行搜索，包含之前没有加载的。搜索前加载。
     *     或者打开时就一次性或者异步加载完成。
     *     增加网格显示模式，双击进去下级文件夹。
     *     网盘代码搜索功能支持子文件夹内所有文件。包括层级最深的。」
     *
     * ★ 能力边界（必须说清楚，否则会误以为还是没修好）★
     *   后端 GET /api/search 会在**服务端**递归遍历目录树，所以
     *     ✔ 没展开过的子目录里的文件 —— 搜得到
     *     ✔ 层级最深的文件 —— 搜得到
     *   但它有硬上限（hits 500 / depth 24 / scanned 20 万），
     *   超限时后端返回 truncated / depthCapped，这里会**明确提示**，
     *   不做"静默截断然后假装搜完了"。
     *
     * ★ 为什么要防竞态 ★
     *   输入是防抖 300ms 触发的，用户快速打字时会连发多次请求。
     *   旧响应晚到会把新结果覆盖掉（经典 async race）。用递增 token 丢弃过期响应。
     */
    async applyFilter() {
      if (!this.treeEl) return;
      const raw = this.filter;

      // 空查询 ⇒ 回到树视图
      if (!raw) {
        this.clearResults();
        return;
      }
      if (!this.currentMount) {
        // 还没选盘：退回前端过滤（这时候也没东西可搜）
        return;
      }

      const token = (this._searchToken || 0) + 1;
      this._searchToken = token;

      if (this.resultsEl) {
        this.resultsEl.style.display = "block";
        this.resultsEl.innerHTML = `<div class="nb-tree-empty">搜索中…</div>`;
      }

      let r;
      try {
        r = await API.search(this.currentMount, raw, "", 500);
      } catch (e) {
        if (token !== this._searchToken) return;
        if (this.resultsEl) {
          this.resultsEl.innerHTML = "";
          const err = document.createElement("div");
          err.className = "nb-tree-empty";
          err.textContent = `搜索失败：${(e && e.message) || e}`;
          this.resultsEl.appendChild(err);
        }
        return;
      }
      if (token !== this._searchToken) return;  // 过期响应，丢弃

      this.renderResults(r, raw);
    }

    /** 渲染搜索结果面板（任务㉑） */
    renderResults(r, raw) {
      const box = this.resultsEl;
      if (!box) return;
      box.innerHTML = "";

      const hits = (r && r.hits) || [];
      const head = document.createElement("div");
      head.className = "nb-results-head";
      const n = hits.length;
      // ★ 任务24b ★ 后端已返回真实命中总数 total（与 limit 无关）。
      //   只写 `${n} 个结果` 会把「上限 500」误报成「盘里就 500 个」。
      const total = (r && typeof r.total === "number") ? r.total : null;
      let msg = `${n} 个结果`;
      if (total !== null && total > n) msg = `${n} / ${total} 个结果`;
      if (r && r.scanned) msg += ` · 扫描 ${r.scanned} 项`;
      head.textContent = msg;
      box.appendChild(head);

      // ★ 截断/深度上限必须显式告诉用户 ★
      //   否则"只搜到一部分"会被误读成"盘里就这些"，从而漏掉目标文件。
      //   ★ 任务24b：判据从 truncated 换成「确实还有下一页」(hasMore / total>n)，
      //     避免 total<=limit 时的误报。
      const more = !!(r && (r.hasMore || (total !== null && total > n)));
      if (more || (r && r.depthCapped)) {
        const warn = document.createElement("div");
        warn.className = "nb-results-warn";
        const bits = [];
        if (more) {
          bits.push(total !== null
            ? `共 ${total} 条，当前最多显示 ${n} 条`
            : `结果超过 ${n} 条`);
          bits.push("缩小关键词可看到其余结果");
        }
        if (r && r.depthCapped) bits.push("目录过深/过多，未全部扫描");
        warn.textContent = "⚠ " + bits.join("；");
        box.appendChild(warn);
      }

      if (!hits.length) {
        const empty = document.createElement("div");
        empty.className = "nb-tree-empty";
        empty.textContent = "没有匹配的文件";
        box.appendChild(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "nb-results-list";
      for (const e of hits) {
        list.appendChild(this.makeResultRow(e, raw));
      }
      box.appendChild(list);

      // 搜索时收起树，避免两套列表同时在滚动
      if (this.treeEl) this.treeEl.style.display = "none";
    }

    /** 一条搜索结果（任务㉑）。样式复用树的节点行，保证观感一致。 */
    makeResultRow(e, raw) {
      const row = document.createElement("div");
      row.className = "nb-node nb-result-row" + (e.isDir ? " is-dir" : "");
      row.dataset.name = e.name || "";
      row.dataset.isDir = e.isDir ? "1" : "0";

      const icon = document.createElement("span");
      icon.className = "nb-node-icon";
      try {
        // ★ 任务25b：必须传 (ext, isDir)，不能传 name ★
        //   以前写的是 typeIconEl(e.name, e.isDir) ⇒ 图标退化成"名字前3个字、灰色"。
        //   搜索结果里后端已经给了 e.ext，直接用；兜底时从 name 现取。
        icon.appendChild(typeIconEl(e.ext || extOf(e.name), !!e.isDir));
      } catch { /* 图标失败不影响功能 */ }
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "nb-node-name";
      name.textContent = e.name || "";
      // 命中词高亮（简单子串高亮，够用且不引依赖）
      try { this._highlight(name, e.name || "", raw); } catch { /* 忽略 */ }
      row.appendChild(name);

      if (e.readonly) {
        const ro = document.createElement("span");
        ro.className = "nb-node-ro";
        ro.textContent = "只读";
        row.appendChild(ro);
      }

      /*
       * ★★★ #63：路径只显示「父目录名」，不再显示完整路径 ★★★
       *
       *   用户原话：「侧边栏文件树的搜索结果 路径显示太长了，把文件名都遮住了。」
       *          「要求，搜索结果显示 路径长度 到 文件上一级即可。
       *            即 只保留父目录名。」
       *
       *   ⇒ 用户要的是**内容**变短（只留父目录名），不是靠 CSS 截断。
       *     完整路径对「区分同名文件」有用，但一屏里长路径会把文件名挤没 ——
       *     而文件名才是用户扫视时找的目标。
       *
       *   两边兼顾的做法：
       *     · 展示文本 = **末级目录名**（`a/b/c/file.pdf` → `c`）
       *     · title     = **完整路径**（悬停即可确认到底是哪一个，信息不丢）
       *   这样既满足「只保留父目录名」，又不丢失定位能力。
       *
       *   ⚠️ 根目录下的文件：`e.path` = `/file.pdf` ⇒ dir = "" ⇒ 显示 `/`（表示在盘根）。
       */
      const segs = String(e.path || "").split("/").filter(Boolean);
      // 去掉最后一段（文件名本身），剩下的最后一段就是父目录名
      const parent = segs.length >= 2 ? segs[segs.length - 2] : "";
      const pathEl = document.createElement("span");
      pathEl.className = "nb-result-path";
      pathEl.textContent = parent || "/";
      pathEl.title = displayMountPath(this.currentMount, e.path);
      row.appendChild(pathEl);

      row.onclick = () => {
        // 单击只选中（与树节点一致，避免误触）
        this.resultsEl.querySelectorAll(".nb-result-row.is-selected")
          .forEach((n) => n.classList.remove("is-selected"));
        row.classList.add("is-selected");
      };
      row.ondblclick = (ev) => {
        ev.stopPropagation();
        if (e.isDir) {
          // 双击目录 ⇒ 退出搜索、跳到该目录（用户要在网格/树里浏览它）
          this._jumpToDir(e.path);
        } else {
          this.activateFile({
            path: e.path, name: e.name, ext: e.ext,
            size: e.size, mtime: e.mtime, isDir: false,
          }, false);
        }
      };
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.showNodeMenu(ev, {
          path: e.path, name: e.name, isDir: !!e.isDir,
          ext: e.ext, size: e.size, mtime: e.mtime, readonly: e.readonly,
        });
      };

      // ★★★ 任务30：搜索结果也要能拖进文档 ★★★
      //   用户原话：「搜索结果需要支持拖拽插入文档功能」。
      //   实测确认过：改之前这里 draggable/ondragstart/setData 全为 false，
      //   所以搜索结果的行确实是「看着像树节点、但拖不动」。
      //   现在复用与树节点**同一个** attachEmbedDrag，行为完全一致。
      this.attachEmbedDrag(row, {
        path: e.path, name: e.name, isDir: !!e.isDir,
      });
      return row;
    }

    /** 把关键词在名称里高亮（搜索结果用） */
    _highlight(span, name, raw) {
      const terms = this._filterTerms(raw).filter((t) => t.length > 0);
      if (!terms.length) return;
      const lower = name.toLowerCase();
      let best = -1, bestLen = 0;
      for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0 && (best < 0 || i < best)) { best = i; bestLen = t.length; }
      }
      if (best < 0) return;
      span.textContent = "";
      span.appendChild(document.createTextNode(name.slice(0, best)));
      const mark = document.createElement("mark");
      mark.className = "nb-hl";
      mark.textContent = name.slice(best, best + bestLen);
      span.appendChild(mark);
      span.appendChild(document.createTextNode(name.slice(best + bestLen)));
    }

    /** 搜索结果里双击目录 ⇒ 退出搜索并定位过去 */
    async _jumpToDir(dirPath) {
      this.filterInput.value = "";
      this.filter = "";
      this.clearResults();
      await this.revealPath(this.currentMount, dirPath);
    }

    /* =====================================================================
     * 网格视图（任务㉑）
     * ================================================================== */

    /**
     * 网格 / 列表 切换。
     *
     * 用户原话：「增加网格显示模式，双击进去下级文件夹。」
     *
     * ★ 语义差异（有意为之）★
     *   列表：双击目录 = 原地展开/收起（看层级）
     *   网格：双击目录 = **进入**下一级（像文件管理器），带「↑ 上一级」
     *   网格不显示层级，所以"展开"没有意义 —— 必须能上下走。
     *
     * ★ 为什么网格不重建树而是另起一套渲染 ★
     *   树节点之间有 _children / _loaded / expanded 等一大堆状态。
     *   在网格里复用它，两层语义会互相打架（网格"进入"到底算不算展开？）。
     *   所以网格用**单层目录视图**（只列当前目录的直接子项），
     *   状态只有一个 currentPath，简单且不会和树状态串味。
     *   代价是切回列表时要重新 loadRoot() —— 可接受。
     */
    async toggleGrid() {
      this.gridMode = !this.gridMode;
      if (this.gridBtn) {
        this.gridBtn.innerHTML =
          `<svg><use xlink:href="#${this.gridMode ? "iconNbList" : "iconNbGrid"}"></use></svg>`;
        this.gridBtn.setAttribute(
          "aria-label", this.gridMode ? "切换到列表视图" : "切换到网格视图");
      }
      this.clearResults();
      if (this.gridMode) {
        this.gridPath = "";
        await this.renderGrid();
      } else {
        await this.loadRoot();
      }
    }

    /** 渲染网格（单层，只列 gridPath 的直接子项） */
    async renderGrid() {
      if (!this.treeEl) return;
      this.treeEl.style.display = "";
      this.treeEl.classList.add("is-grid");
      this.treeEl.innerHTML = `<div class="nb-tree-empty">加载中…</div>`;

      let r;
      try {
        r = await API.list(this.currentMount, this.gridPath || "");
      } catch (e) {
        this.treeEl.innerHTML = "";
        const err = document.createElement("div");
        err.className = "nb-tree-empty";
        err.textContent = `加载失败：${(e && e.message) || e}`;
        this.treeEl.appendChild(err);
        return;
      }

      this.treeEl.innerHTML = "";

      // 面包屑 + 上一级
      const nav = document.createElement("div");
      nav.className = "nb-grid-nav";
      if (this.gridPath) {
        const up = document.createElement("button");
        up.className = "nb-grid-up";
        up.textContent = "↑ 上一级";
        up.onclick = () => {
          const i = String(this.gridPath).lastIndexOf("/");
          this.gridPath = i > 0 ? String(this.gridPath).slice(0, i) : "";
          this.renderGrid();
        };
        nav.appendChild(up);
      }
      // 网格里"在页签中打开当前目录"没有意义，但显示路径很有用
      const crumb = document.createElement("span");
      crumb.className = "nb-grid-crumb";
      // ★ #54：面包屑用 displayCrumbPath（与网盘 Web UI 同款：`售前项目 / a / b`）。
      //   不再用 displayMountPath —— 它给的是完整路径 `售前项目:/`，
      //   放进一行导航文本里就成了用户报的「/:售前项目」那种怪形。
      crumb.textContent = displayCrumbPath(this.currentMount, this.gridPath || "");
      // 悬浮提示仍给**完整路径**（需要精确复制时有用），两者刻意不同
      crumb.title = displayMountPath(this.currentMount, this.gridPath || "");
      nav.appendChild(crumb);
      this.treeEl.appendChild(nav);

      const grid = document.createElement("div");
      grid.className = "nb-grid";
      const entries = (r && r.entries) || [];
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "nb-tree-empty";
        empty.textContent = "空目录";
        grid.appendChild(empty);
      }
      for (const e of entries) {
        grid.appendChild(this.makeGridCell(e));
      }
      this.treeEl.appendChild(grid);
    }

    /** 网格里的一个格子 */
    makeGridCell(e) {
      const cell = document.createElement("div");
      cell.className = "nb-cell" + (e.isDir ? " is-dir" : "");
      cell.dataset.name = e.name || "";
      cell.title = `${e.name}\n${displayMountPath(this.currentMount, e.path || "")}`;

      const iconBox = document.createElement("div");
      iconBox.className = "nb-cell-icon";
      // ★ 任务25b：同上 —— 传 (ext, isDir)，目录走文件夹图标分支。
      try { iconBox.appendChild(typeIconEl(e.ext || extOf(e.name), !!e.isDir)); } catch { /* 忽略 */ }
      cell.appendChild(iconBox);

      const name = document.createElement("div");
      name.className = "nb-cell-name";
      name.textContent = e.name || "";
      cell.appendChild(name);

      // ★ 网格核心交互：双击进去下级文件夹 ★
      cell.ondblclick = (ev) => {
        ev.stopPropagation();
        if (e.isDir) {
          this.gridPath = String(e.path || "");
          this.renderGrid();
        } else {
          this.activateFile({
            path: e.path, name: e.name, ext: e.ext,
            size: e.size, mtime: e.mtime, isDir: false,
          }, false);
        }
      };
      // 单击只选中
      cell.onclick = (ev) => {
        ev.stopPropagation();
        this.treeEl.querySelectorAll(".nb-cell.is-selected")
          .forEach((n) => n.classList.remove("is-selected"));
        cell.classList.add("is-selected");
      };
      cell.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.showNodeMenu(ev, {
          path: e.path, name: e.name, isDir: !!e.isDir,
          ext: e.ext, size: e.size, mtime: e.mtime, readonly: e.readonly,
        });
      };

      // ★ 任务30 顺带：网格格子也能拖进文档 ★
      //   网格视图（任务㉑）是与搜索/树并列的第三个入口，同样缺这段接线。
      //   用户这次只点名了「搜索结果」，但三处语义一致，漏掉网格 = 下次还要再报一次。
      this.attachEmbedDrag(cell, {
        path: e.path, name: e.name, isDir: !!e.isDir,
      });
      return cell;
    }

    /**
     * 把输入解析成一组「小写子串」。
     *   `*.png`        → ["png"]
     *   `png,jpg`      → ["png","jpg"]
     *   `报告 pdf`     → ["报告","pdf"]   （空格分隔，OR）
     *   `.png`         → [".png"]         （保留点，便于精确匹配扩展名）
     *   `PNG`          → ["png"]          （统一小写）
     *
     * ★ 注意：后端 _search_terms 是这套规则的**权威实现**（真正去遍历目录的是它）。
     *   这里保留一份用于**本地高亮**（搜索结果里把命中的词标出来），
     *   两边规则必须一致，所以改动时请对照 /opt/nebula/app/routers/fileops.py。
     */
    _filterTerms(raw) {
      return String(raw || "")
        .split(/[,，|]+/)                 // 逗号 / 竖线 优先当分隔符
        .flatMap((chunk) => {
          const c = chunk.trim();
          if (!c) return [];
          // ★ 通配：`*.png` / `*png` —— 用户习惯写法。
          //   旧实现会去字面匹配 "*.png"，结果全部落空（这是本次修的一个真问题）。
          if (c.startsWith("*")) return [c.replace(/^\*\.?/, "").trim().toLowerCase()];
          // 含空格的整串：既当整体，也拆成词（两种都可能命中，OR 更宽容）
          const parts = [c];
          if (/\s/.test(c)) parts.push(...c.split(/\s+/));
          return parts;
        })
        .map((s) => s.toLowerCase())
        .filter(Boolean);
    }

    /* ---------------------------------------------------------------------
     * ★ 任务㉑（2026-09-23）：旧的「前端过滤」实现已删除 ★
     *
     *   原来的 applyFilter() 只对**已经渲染成 DOM 的节点**做 display:none，
     *   而文件树是懒加载的 ⇒ 没展开过的目录、层级最深的文件根本搜不到。
     *   用户要求「搜索需要对所有文档进行搜索，包含之前没有加载的」，
     *   所以改成了「后端递归搜索 + 独立结果面板」：
     *     · 后端：GET /api/search（见 NebulaDisk routers/fileops.py）
     *     · 前端：TreePanel.applyFilter() → API.search() → renderResults()
     *   本文件里现在只剩 _filterTerms()，供**本地高亮**复用。
     *   ⚠️ 别再把它改回前端过滤 —— 那等于把"搜不全"这个 bug 装回去。
     * ------------------------------------------------------------------ */

    showBanner(text, kind = "warn", action) {
      if (!this.banner) return;
      this.banner.className = `nb-tree-banner is-${kind}`;
      this.banner.innerHTML = "";
      const span = document.createElement("span");
      span.textContent = text;
      this.banner.appendChild(span);
      if (action) {
        const btn = document.createElement("button");
        btn.className = "b3-button b3-button--outline";
        btn.textContent = "处理";
        btn.onclick = action;
        this.banner.appendChild(btn);
      }
      this.banner.style.display = "flex";
    }

    hideBanner() {
      if (this.banner) this.banner.style.display = "none";
    }

    onProxyDown(detail) {
      this.proxyOk = false;
      this.showBanner(`网络通道未就绪：${detail}`, "warn", () => this.plugin.openSetting());
    }

    onProxyUp() {
      this.proxyOk = true;
      this.hideBanner();
    }

    onSessionLost() {
      this.sessionOk = false;
      this.renderLoginPrompt();
    }
  }

  /* -------------------------------------------------------------------------
   * 工具
   * ---------------------------------------------------------------------- */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function parentOf(p) {
    const i = String(p).lastIndexOf("/");
    return i <= 0 ? "" : String(p).slice(0, i);
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /**
   * 任务⑫ 的核心递归：把一个 `FileSystemEntry` 展开成「待上传任务」列表。
   *
   * ★ 为什么必须自己递归，不能直接用 dataTransfer.files ★
   *   拖**文件夹**进来时，`dataTransfer.files` 里**只有那个文件夹本身**，
   *   子文件一个都不在里面 —— 直接用它上传，用户看到的是"什么都没传上去"。
   *   要拿到真实文件必须走 FileSystem API。
   *
   * ★ readEntries() 一次最多回 100 条 ★
   *   这是规范行为（不是 bug）。必须循环读到返回空数组为止，
   *   否则目录里第 101 个之后的文件会被静默丢弃 —— 这种丢数据最难发现。
   *
   * ★ 不做软链接/超长路径的特殊处理 ★
   *   浏览器端 `isFile` / `isDirectory` 已经够用；遇到读不出来的条目
   *   （权限、已删除）就跳过并记日志，**不能让一个坏条目毁掉整批上传**。
   *
   * @param {any} entry FileSystemEntry（FileSystemFileEntry / FileSystemDirectoryEntry）
   * @param {string} relDir 相对落点目录的子目录路径（如 `图纸/2024`）
   * @param {Array<{file: File, relDir: string}>} out 收集结果
   * @returns {Promise<void>}
   */
  async function collectEntry(entry, relDir, out) {
    if (!entry) return;
    try {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => {
          entry.file(resolve, reject);
        });
        if (file) out.push({ file, relDir });
        return;
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const sub = relDir ? relDir + "/" + entry.name : entry.name;
        // ★ 循环读到空：不要只 readEntries 一次 ★
        for (;;) {
          const batch = await new Promise((resolve, reject) => {
            reader.readEntries(resolve, reject);
          });
          if (!batch || !batch.length) break;
          for (const child of batch) {
            await collectEntry(child, sub, out);
          }
        }
      }
    } catch (e) {
      diag(`[tree] 跳过无法读取的拖入条目「${entry && entry.name}」：${e && e.message}`);
    }
  }

  function showToast(msg) {
    showMessage(msg);
  }

  function copyText(text, okMsg = "已复制") {
    const done = () => showToast(okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { showToast("复制失败"); }
    ta.remove();
  }

  function confirmDialog(title, content) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      // 思源的 confirm 是回调式：只在「确定」时回调，取消没有回调。
      // 因此用「确定回调」+「对话框消失」两条路径兜底判定。
      confirm("⚠️ " + title, content, () => finish(true));

      const timer = setInterval(() => {
        if (settled) { clearInterval(timer); return; }
        // 思源的对话框容器
        const open = document.querySelector(".b3-dialog--open");
        if (!open) {
          clearInterval(timer);
          finish(false);
        }
      }, 300);

      // 兜底：极端情况下对话框一直存在（比如被其它层遮挡），30s 后放弃等待
      setTimeout(() => { clearInterval(timer); finish(false); }, 30000);
    });
  }

  /** 取当前聚焦的编辑器 */
  function getActiveEditor() {
    const el = document.querySelector(".protyle-wysiwyg--focus") ||
               document.querySelector(".protyle-wysiwyg");
    if (!el) return null;
    const protyle = el.closest(".protyle")?._protyle || window.siyuan?.editor;
    return protyle || null;
  }

  /**
   * 复用已有的查看页签
   * 思源没有「按 custom.data 查找已开页签」的公开 API，
   * 这里通过 getOpenedTab 拿到页签列表，按 data 匹配后重新激活。
   */
  function tryReuseViewerTab(plugin, item) {
    try {
      const tabs = plugin.getOpenedTab ? plugin.getOpenedTab() : null;
      if (!tabs) return false;
      // getOpenedTab 返回的形态在各版本间有差异，这里做宽松处理：
      // 只要能拿到 model 且带 custom 信息就尝试激活。
      const list = Array.isArray(tabs) ? tabs : Object.values(tabs);
      for (const t of list) {
        const d = t?.data || t?.model?.data;
        if (d && d.mount === item.mount && d.path === item.path) {
          if (typeof t.model?.activate === "function") {
            t.model.activate();
            return true;
          }
        }
      }
    } catch { /* 版本差异，忽略 */ }
    return false;
  }
  return {
    __cjs: false,
    FileTree,
  };
})();

/* ===== src/viewer.js ===== */
const __mod_viewer = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const showMessage = SIYUAN.showMessage;
  const API = __mod_api.API;
  const pickViewer = __mod_api.pickViewer;
  const extOf = __mod_api.extOf;
  const humanSize = __mod_api.humanSize;
  const humanTime = __mod_api.humanTime;
  const decodeSmart = __mod_api.decodeSmart;
  const serverBase = __mod_api.serverBase;
  const liteUrl = __mod_api.liteUrl;
  const displayMountPath = __mod_api.displayMountPath;
  const insertEmbedIntoDoc = __mod_embed.insertEmbedIntoDoc;
  /* ==========================================================================
   * 预览与在线编辑（需求 ②）
   * --------------------------------------------------------------------------
   * 分四条链路，按文件类型路由（与后端 files.route_of 的语义对齐）：
   *
   *   ① 浏览器原生类型（图片/视频/音频/PDF/文本）
   *        → 直接用 /api/download?inline=1 取流，<img>/<video>/<iframe>/<pre>
   *          零转换、零延迟，也不给 kkFileView 添负担。
   *
   *   ② Office（docx/xlsx/pptx…）
   *        → OnlyOffice。★ 这条链路天然不受 CORS 影响 ★
   *          因为文档是 OnlyOffice **服务端**回拉的（走容器网络里的
   *          NEBULA_BASE_URL），api.js 由浏览器直连 OO 的对外地址。
   *          写回走 /api/oo/callback，与插件无关。
   *
   *   ③ CAD（dwg/dxf）
   *        → cad-viewer 深链 /cad/?open=…
   *
   *   ④ 其它（压缩包/代码/未知）
   *        → kkFileView /preview/onlinePreview?url=…
   *
   * ★ iframe 的跨域现实 ★
   *   代理端口与思源端口不同，所以 iframe 内容严格说仍是跨 origin。
   *   但 kkFileView / cad-viewer 都是「无状态渲染」，不需要读 iframe 内部 DOM，
   *   只是展示，因此可用。代理已剥离 X-Frame-Options / CSP 并改写资源地址。
   * ========================================================================== */



  /**
   * ★ 2026-09-23：decodeSmart 从本文件搬到 api.js 并导出 ★
   *   任务⑧ 给嵌入块加了「文本直出」（embed.js 的 renderNative），它也需要同一套解码逻辑。
   *   不能直接在 embed.js 里引 viewer —— viewer 已经引了 embed 的 insertEmbedIntoDoc，
   *   反向依赖会形成**循环导入**。⇒ 下沉到 api.js：两边都只依赖 api.js，无环。
   *
   * ★ 注意：这段说明必须写在 import 语句**外面** ★
   *   早先它写在花括号里（`{ ..., 注释, decodeSmart }`），结果：
   *     ① 注释里的示例代码 `import { insertEmbedIntoDoc } from "./embed.js"`
   *        恰好落在行首，被 syntax.check.js 的 import 正则当成一条真实 import 匹配到，
   *        于是把这整段注释算成了「从 ./embed.js 导入的符号名」；
   *     ② 该字符串又被拿去 new RegExp → SyntaxError: Nothing to repeat，检查脚本崩溃。
   *   （检查器本身也已在同一次修复中改为「先剥注释再解析」，双保险。）
   */

  /*
   * ★ #62：`webDiskUrl` 已从 import 里移除 ★
   *   viewer.openInBrowser() 原先的「退回网盘深链/首页」两条兜底已删除
   *   （那条路径会把用户丢到网盘首页，正是任务⑰抱怨的「打开的不是文件」）。
   *   现在统一走 API.browserViewUrl()。
   *   ⚠️ 必须真的删掉这个导入名：test/syntax.check.js 的检查④会报
   *      「导入了 webDiskUrl 但从未使用」，把套件刷红。
   */


  class Viewer {
    /**
     * @param {HTMLElement} element 页签容器
     * @param {{mount:string,path:string,name:string,ext?:string}} data
     */
    constructor(element, data) {
      this.el = element;
      this.data = data || {};
      this.mount = data.mount;
      this.path = data.path;
      this.name = data.name || data.path;
      this.ext = data.ext || extOf(this.name);
      this.kind = pickViewer(this.name);
      this.destroyed = false;
      this._ooEditor = null;
      this._ooScript = null;
    }

    /* =====================================================================
     * 渲染
     * ================================================================== */
    async render() {
      if (this.destroyed) return;
      this.el.classList.add("nb-viewer");
      this.el.innerHTML = "";

      this.renderToolbar();

      this.body = document.createElement("div");
      this.body.className = "nb-viewer-body fn__flex-1";
      this.el.appendChild(this.body);

      // 顶部显示文件信息条
      this.renderInfo();

      try {
        switch (this.kind) {
          case "image":  return await this.renderImage();
          case "video":  return await this.renderVideo();
          case "audio":  return await this.renderAudio();
          case "pdf":    return await this.renderPdf();
          case "text":   return await this.renderText();
          case "office": return await this.renderOffice();
          case "cad":    return await this.renderCad();
          case "archive":return await this.renderKk();
          default:       return await this.renderKk();
        }
      } catch (e) {
        this.showError(e);
      }
    }

    /* ---- 工具条 ---- */
    renderToolbar() {
      const bar = document.createElement("div");
      bar.className = "nb-viewer-toolbar";

      const title = document.createElement("div");
      title.className = "nb-viewer-title";
      title.textContent = this.name;
      title.title = displayMountPath(this.mount, this.path);
      bar.appendChild(title);

      const spacer = document.createElement("div");
      spacer.className = "fn__flex-1";
      bar.appendChild(spacer);

      const mkBtn = (icon, label, handler) => {
        const b = document.createElement("button");
        b.className = "b3-tooltips b3-tooltips__sw nb-viewer-btn";
        b.setAttribute("aria-label", label);
        b.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
        b.onclick = handler;
        return b;
      };

      bar.appendChild(mkBtn("iconRefresh", "重新加载", () => this.render()));
      bar.appendChild(mkBtn("iconDownload", "下载", () => this.download()));
      bar.appendChild(mkBtn("iconCopy", "复制路径", () =>
        this.copy(displayMountPath(this.mount, this.path))));
      bar.appendChild(mkBtn("iconNebulaDisk", "嵌入到文档", () =>
        this.embedToDoc()));
      bar.appendChild(mkBtn("iconLink", "复制直链", () => this.copyLink()));
      bar.appendChild(mkBtn("iconOpen", "在浏览器中打开", () => this.openInBrowser()));

      this.el.appendChild(bar);
    }

    renderInfo() {
      const info = document.createElement("div");
      info.className = "nb-viewer-info";
      const chip = (t, cls) => {
        const s = document.createElement("span");
        s.className = "nb-chip" + (cls ? " " + cls : "");
        s.textContent = t;
        return s;
      };
      info.appendChild(chip(this.mount));
      info.appendChild(chip("/" + this.path));
      if (this.data.size) info.appendChild(chip(humanSize(this.data.size)));
      if (this.data.mtime) info.appendChild(chip(humanTime(this.data.mtime)));

      // 任务⑲：整条信息条可点即可复制「mount:/path」——
      //   用户想把这个页签对应的文件贴到别处（聊天/工单/另一个嵌入块）时，
      //   不必再回文件树找。这也是"如何知道嵌入的具体文档是哪个"的最短路径。
      const spacer = document.createElement("div");
      spacer.className = "fn__flex-1";
      info.appendChild(spacer);
      const copyChip = document.createElement("span");
      copyChip.className = "nb-chip nb-chip--copy";
      copyChip.textContent = "复制路径";
      copyChip.title = displayMountPath(this.mount, this.path);
      copyChip.onclick = () => this.copy(displayMountPath(this.mount, this.path));
      info.appendChild(copyChip);

      this.el.appendChild(info);
    }

    /* ---- ① 图片 ---- */
    async renderImage() {
      // ★ 必须用 signedDownloadUrl（异步拿签名直链）★
      //   直连通道下 /api/download 认 Cookie，而思源与网盘跨源 ⇒ 401；
      //   旧代码还用 proxyBase() ⇒ 浏览器打 127.0.0.1:6810 ⇒ 连接被拒。
      //   这正是任务⑧「图片打不开」的根因。
      const url = await API.signedDownloadUrl(this.mount, this.path, true);
      this.body.innerHTML = "";
      const box = document.createElement("div");
      box.className = "nb-media-wrap";
      const img = document.createElement("img");
      img.className = "nb-image";
      img.alt = this.name;
      img.src = url;
      img.onerror = () => this.showError(new Error("图片加载失败"));
      // 点击缩放
      let zoom = false;
      img.onclick = () => {
        zoom = !zoom;
        img.classList.toggle("is-zoom", zoom);
      };
      box.appendChild(img);
      this.body.appendChild(box);
    }

    /* ---- ① 视频 ---- */
    async renderVideo() {
      // 同 renderImage：必须走签名直链（跨源 /api/download 会 401；
      // 旧的 proxyBase() 会打到 127.0.0.1:6810 直接连不上）
      const url = await API.signedDownloadUrl(this.mount, this.path, true);
      const v = document.createElement("video");
      v.className = "nb-video";
      v.controls = true;
      v.preload = "metadata";
      v.src = url;
      // /api/raw 支持 Range，可拖动进度
      this.body.appendChild(v);
    }

    /* ---- ① 音频 ---- */
    async renderAudio() {
      const url = await API.signedDownloadUrl(this.mount, this.path, true);
      const box = document.createElement("div");
      box.className = "nb-audio-wrap";
      box.innerHTML = `<div class="nb-audio-name"></div>`;
      box.querySelector(".nb-audio-name").textContent = this.name;
      const a = document.createElement("audio");
      a.controls = true;
      a.src = url;
      box.appendChild(a);
      this.body.appendChild(box);
    }

    /* ---- ① PDF（浏览器内置阅读器）---- */
    async renderPdf() {
      // 走 kkFileView 更稳（部分环境的内置 PDF 插件不可用）：
      // 有 kk 就用 kk，没有就退回原生 embed
      return this.renderKk();
    }

    /* ---- ① 文本 ---- */
    async renderText() {
      const pre = document.createElement("pre");
      pre.className = "nb-text";
      pre.textContent = "加载中…";
      this.body.appendChild(pre);

      try {
        // 同图片/视频：走签名直链，避免 127.0.0.1 与跨源 Cookie
        const url = await API.signedDownloadUrl(this.mount, this.path, true);
        const resp = await fetch(url, { credentials: "omit" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        pre.textContent = decodeSmart(buf);
        this.maybeHighlight(pre);
      } catch (e) {
        pre.textContent = `读取失败：${e.message}`;
      }
    }

    /* ---- ② Office → OnlyOffice ---- */
    async renderOffice() {
      this.showLoading("正在连接 OnlyOffice…");
      let cfg;
      try {
        cfg = await API.ooConfig(this.mount, this.path);
      } catch (e) {
        // OnlyOffice 未配置时优雅降级到 kkFileView
        if (/未配置|403|503/.test(e.message + e.status)) {
          console.warn("[nebuladisk] OnlyOffice 不可用，降级到 kkFileView:", e.message);
          return this.renderKk(true);
        }
        throw e;
      }

      if (!cfg || !cfg.ok) throw new Error("OnlyOffice 配置获取失败");

      const editorBox = document.createElement("div");
      editorBox.className = "nb-oo-editor";
      editorBox.id = "nb-oo-" + Date.now();
      this.body.innerHTML = "";
      this.body.appendChild(editorBox);

      // 状态提示条已按需求移除。
      //   原来这里会插一条「● 在线编辑模式 —— 关闭编辑器后自动保存回网盘」
      //   （只读时显示「○ 只读模式（该目录无写权限）」）。
      //   用户 2026-09-22 明确要求：这一行及其内容不要显示。
      //   ⇒ 不再创建 .nb-oo-mode 节点，编辑器直接占满整个 body。
      //   注：只读/可写仍然由 cfg.mode 决定（见 API.ooConfig），只是不再提示。

      // 加载 api.js（跨域脚本加载是允许的，不需要 CORS 头）
      await this.loadScript(cfg.apiJs);

      const DocsAPI = window.DocsAPI;
      if (!DocsAPI) throw new Error("OnlyOffice api.js 已加载但 DocsAPI 不存在");

      const config = { ...cfg.config };

      // ★★★ 关于 OnlyOffice 自带的左栏（用户报的「两个画面」）★★★
      //
      //   现象：编辑器里左边一条窄栏（插件面板 / 反馈&支持），右边才是文档。
      //   那不是本插件的布局（本插件只有一条工具条 + 正文），是 OO 自己的内置面板。
      //
      //   ❌ 为什么**不**在 config 里加 customization.plugins = false ❌
      //     后端 build_editor_config() 的最后一步是 `cfg["token"] = _sign(cfg)`，
      //     **签名覆盖整个 config**（见 integrations.py:62 `_sign`，
      //     payload = json.dumps(cfg)）。
      //     前端拿到的 cfg.config 是**已签名**的，我们再加/改任何字段，
      //     都会让 token 与内容不匹配 → OnlyOffice 直接拒绝整个配置。
      //     本插件没有 oo_secret，无法重新签名，所以这条路走不通。
      //     （实测：拿回来的 config 里根本没有我们加的键 —— 顶层 customui 被忽略；
      //       而改 editorConfig.customization 则会让签名失效。）
      //
      //   ✅ 正确做法：CSS/DOM 兜底（hideOoPanels）✅
      //     不碰 config、不动签名，直接在外层把 OO 渲染出来的左栏藏掉。
      //     这是唯一「零风险 + 不改后端」的办法。
      //     若要根治，应在**后端**的 build_editor_config 的 customization 里
      //     加上 plugins/leftMenu/about/feedback = false，再重建 nebula 镜像
      //     （需要用户同意，且要重建镜像，代价较大）。

      // 让关闭按钮直接关掉思源页签
      config.events = {
        onError: (ev) => {
          console.error("[nebuladisk] OnlyOffice 错误:", ev);
          this.showError(new Error(`OnlyOffice: ${ev?.data?.errorDescription || "未知错误"}`));
        },
        onDocumentReady: () => {
          console.log("[nebuladisk] 文档已就绪");
          // OO 渲染完成后左栏 DOM 才真正存在 → 这时再清一次最有效
          this.hideOoPanels(editorBox);
        },
      };

      try {
        this._ooEditor = new DocsAPI.DocEditor(editorBox.id, config);
      } catch (e) {
        throw new Error(`创建编辑器失败：${e.message}`);
      }

      // ★ 兜底：等 OO 渲染完后，用 CSS 把左栏彻底藏掉 ★
      //   customui 在不同 OO 版本里字段名有差异，光靠配置不一定生效；
      //   这里再补一刀：把已知的左栏容器隐藏，确保只剩一个画面。
      this.hideOoPanels(editorBox);
    }

    /**
     * 尽量隐藏 OnlyOffice 自带的面板（左栏 / 右侧信息），只留文档正文。
     *
     * ★★★ 结论先行：跨域情况下这个函数**改不动 OO 内部** ★★★
     *
     *   OnlyOffice 的 DocEditor 会把自己渲染进一个 iframe，而这个 iframe 的
     *   origin 是 **NEBULA_OO_PUBLIC**（实测 http://192.168.193.70:8082），
     *   与思源页面的 origin（http://172.16.30.128:6806）**不同源**。
     *   同源策略下，父页面无法读取/修改跨域 iframe 的 DOM，
     *   所以「用 CSS 把 OO 左栏藏掉」在跨域部署里**做不到**。
     *
     *   那这个函数还有什么用？
     *     · OO 若因某种集成方式**没有**用 iframe（内联渲染）→ 可以生效
     *     · 把外层 iframe 的边框/内边距清掉，避免出现「一圈空白」被看成第二栏
     *   ⇒ 保留它是为了这两条，但不要把「消除两个画面」的责任压在它身上。
     *
     * ★ 真正能根治的做法（需要改后端，已单独说明）★
     *   在 nebula 后端 integrations.build_editor_config() 的
     *   editorConfig.customization 里补上：
     *       "plugins": False, "leftMenu": False,
     *       "about": False,   "feedback": False,
     *   然后重建 nebula 镜像。
     *
     *   为什么不能在前端补：
     *     后端 `cfg["token"] = _sign(cfg)` 是**对整份 config 签名**的，
     *     前端再改任何字段都会让 token 与内容不一致 → OO 拒绝整个配置。
     *     而 JWT_ENABLED: "true"（compose 已确认），所以 token 是强校验的。
     *     前端没有 oo_secret，无法重新签名。
     */
    hideOoPanels(box) {
      const kill = () => {
        if (this.destroyed || !box || !box.querySelectorAll) return;

        // 仅在同源（内联渲染）时才有可能命中；跨域 iframe 下这步会自然落空。
        const sel = [
          ".left-panel",
          ".left-menu",
          "#left-panel",
        ];
        for (const s of sel) {
          for (const el of box.querySelectorAll(s)) {
            if (/plugin|menu|panel/i.test(el.className || "")) {
              el.style.display = "none";
            }
          }
        }

        // 跨域也能做的：把 iframe 铺满，不要留边距/边框造成「第二栏」的错觉
        for (const f of box.querySelectorAll("iframe")) {
          f.style.display = "block";
          f.style.width = "100%";
          f.style.height = "100%";
          f.style.border = "0";
        }
        // 顺带把外层第一个 iframe 的父容器边距清零
        for (const w of box.querySelectorAll("div")) {
          const st = w.style;
          if (st && (st.padding || st.margin) && w.querySelector("iframe")) {
            st.padding = "0";
            st.margin = "0";
          }
        }
      };
      try { kill(); } catch { /* 忽略 */ }
      // OO 异步渲染，多补几次
      setTimeout(() => { try { kill(); } catch { /* 忽略 */ } }, 1500);
      setTimeout(() => { try { kill(); } catch { /* 忽略 */ } }, 4000);
    }

    loadScript(src) {
      return new Promise((resolve, reject) => {
        if (window.DocsAPI && this._ooScript && this._ooScript.src === src) return resolve();
        // 已存在同地址的 script（别的页签加载过）
        const existing = Array.from(document.querySelectorAll("script"))
          .find((s) => s.src === src);
        if (existing && window.DocsAPI) return resolve();

        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => { this._ooScript = s; resolve(); };
        s.onerror = () => reject(new Error(
          `无法加载 OnlyOffice：${src}\n请检查设置中的 OnlyOffice 对外地址是否可访问。`,
        ));
        document.head.appendChild(s);
      });
    }

    /* ---- ③ CAD ---- */
    async renderCad() {
      this.showLoading("正在加载 CAD 查看器…");
      let r;
      try {
        r = await API.cadUrl(this.mount, this.path);
      } catch (e) {
        if (/未配置|503/.test(e.message + e.status)) {
          console.warn("[nebuladisk] CAD 查看器不可用，降级到 kkFileView");
          return this.renderKk(true);
        }
        throw e;
      }
      // ★ 任务31：CAD 查看器自带整套 UI（功能区/命令行/状态栏/右上角箭头工具条/右侧工具栏），
      //   而它**不认任何 URL 参数**控制显示设置（已核实：设置存在模块内的 Il.instance.settings，
      //   页面拿不到；左下角坐标轴更是画在 canvas 上，CSS 也藏不掉）。
      //   所以统一走 /lite 外壳页注入隐藏 CSS —— 与嵌入块同一条通道，行为一致。
      //   拿不到 /lite（老后端）就退回直连，功能可用、只是收不掉菜单。
      const raw = String(r && r.url || "");
      let url = raw;
      try {
        const lite = raw ? liteUrl(serverBase(), raw, "cad") : "";
        if (lite) url = lite;
        else console.log("[nebuladisk] [viewer] /lite 不可用，CAD 直连预览（菜单栏不会收起）");
      } catch (e) {
        console.warn("[nebuladisk] [viewer] liteUrl 失败，CAD 直连：" + (e && e.message));
      }
      this.renderIframe(url, "CAD 图纸");
    }

    /* ---- ④ kkFileView ---- */
    async renderKk(silentFallback = false) {
      this.showLoading(silentFallback ? "该格式不支持在线编辑，改用预览…" : "正在转换预览…");
      let r;
      try {
        r = await API.previewUrl(this.mount, this.path);
      } catch (e) {
        throw new Error(`无法获取预览地址：${e.message}`);
      }
      if (!r || !r.url) throw new Error("预览地址为空");
      this.renderIframe(r.url, "kkFileView");

      // kkFileView 首屏要转换，可能较慢，给个耐心提示
      this._kkTimer = setTimeout(() => {
        if (this.destroyed) return;
        const tip = this.el.querySelector(".nb-viewer-tip");
        if (tip) tip.textContent = "首次转换较慢（大文件可能需要几十秒），请稍候…";
      }, 6000);
    }

    renderIframe(url, label) {
      this.body.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "nb-iframe-wrap";

      const frame = document.createElement("iframe");
      frame.className = "nb-iframe";
      frame.src = url;
      frame.setAttribute("allowfullscreen", "true");
      frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");

      const tip = document.createElement("div");
      tip.className = "nb-viewer-tip";
      tip.textContent = `${label} 加载中…`;

      frame.onload = () => { tip.textContent = ""; tip.style.display = "none"; };

      wrap.appendChild(frame);
      this.body.appendChild(wrap);
      this.el.appendChild(tip);
    }

    /* =====================================================================
     * 辅助
     * ================================================================== */
    showLoading(text) {
      this.body.innerHTML = `<div class="nb-viewer-loading">
        <div class="nb-spinner"></div><div>${escapeHtml(text)}</div></div>`;
    }

    showError(err) {
      if (this.destroyed) return;
      const msg = err && err.message ? err.message : String(err);
      this.body.innerHTML = "";
      const box = document.createElement("div");
      box.className = "nb-viewer-error";
      box.innerHTML = `<div class="nb-viewer-error-title">打开失败</div>`;
      const pre = document.createElement("pre");
      pre.className = "nb-viewer-error-msg";
      pre.textContent = msg;
      box.appendChild(pre);

      const hint = document.createElement("div");
      hint.className = "nb-viewer-error-hint";
      hint.textContent = "可尝试：下载后用本地应用打开，或在浏览器中打开网盘页面。";
      box.appendChild(hint);

      const actions = document.createElement("div");
      actions.className = "nb-viewer-error-actions";
      const dl = document.createElement("button");
      dl.className = "b3-button b3-button--outline";
      dl.textContent = "下载文件";
      dl.onclick = () => this.download();
      const br = document.createElement("button");
      br.className = "b3-button b3-button--outline";
      br.textContent = "在浏览器中打开";
      br.onclick = () => this.openInBrowser();
      const rt = document.createElement("button");
      rt.className = "b3-button b3-button--text";
      rt.textContent = "重试";
      rt.onclick = () => this.render();
      actions.appendChild(dl);
      actions.appendChild(br);
      actions.appendChild(rt);
      box.appendChild(actions);

      this.body.appendChild(box);
    }

    async download() {
      // ★ 必须 await 签名直链 ★
      //   直连通道下 /api/download 认 Cookie（跨源 ⇒ 401）；
      //   旧的同步 downloadUrl() 在直连时还会拼 127.0.0.1:6810 ⇒ 连接被拒。
      //   这就是用户报的「下载会报错」。
      let url;
      try {
        url = await API.signedDownloadUrl(this.mount, this.path, false);
      } catch (e) {
        showMsg(`下载失败：${e.message}`);
        return;
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = this.name;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 100);
    }

    /**
     * 预览栏「复制直链」—— **下载型**直链（任务⑱，2026-09-23 用户明确）。
     *
     * ★★★ 两个「复制直链」的语义是**故意不同**的，别再改回一致 ★★★
     *
     *   用户最终确认（原话）：
     *     「右键中的直连是打开和 预览上的直连是下载。修复 预览上的直连。」
     *
     *   · **右键菜单**（tree.js 的 copyRawLink）「复制直链」 = **打开**
     *     —— 粘到浏览器里直接看到文件内容（inline 渲染）。
     *     这是用户认可、要求保持不变的。
     *   · **本方法**（预览栏按钮）「复制直链」 = **下载**
     *     —— 粘到浏览器/下载器里应该触发下载（attachment）。
     *
     *   为什么必须走后端签发而不是在前端给 URL 加 `&dl=1`：
     *     后端把 dl 并入了 HMAC 签名串（见 nebula `routers/rawlink.py` 的
     *     `_wants_download` / `webutil._raw_token(..., dl=)`）。
     *     前端手动追加 ⇒ sig 与实参不匹配 ⇒ **恒 403**。
     *     所以要传 `download` 让后端签出一份带 dl 的链接。
     *     （已实测：v2 签名把 dl 并入 HMAC 输入，篡改必 403。）
     *
     *   signedRawUrl(mount, path, true) 已经内含 browserReachableUrl()，
     *   主机名改写（nebula:8088 → 172.16.30.128:8089）不用在这里重复做。
     */
    async copyLink() {
      try {
        const abs = await API.signedRawUrl(this.mount, this.path, true);
        if (!abs) throw new Error("后端未返回直链");
        this.copy(abs);
        showMsg("已复制下载直链");
      } catch (e) {
        showMsg(`获取直链失败：${e.message}`);
      }
    }

    copy(text) {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => showMsg("已复制"))
          .catch(() => showMsg("复制失败"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); showMsg("已复制"); }
        catch { showMsg("复制失败"); }
        ta.remove();
      }
    }

    /**
     * 在浏览器中打开（任务⑰ → #62 修正）。
     *
     * ★★★ #62：这里曾经**一律**打开 `/api/raw` 直链，那是错的 ★★★
     *
     *   用户报障（原话）：
     *     「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
     *       onlyoffice 预览一样 kkviewer 也一样。
     *       PDF 预览目前点击这个按钮是在网页中打开。」
     *
     *   实测各类型 `/api/raw` 的响应头，**`Content-Disposition: inline` 一直都下发了**：
     *     PDF  → application/pdf                        → 内嵌打开 ✅
     *     DOCX → application/vnd...wordprocessingml...  → 下载 ❌
     *     STEP → model/step                             → 下载 ❌
     *   ⇒ 问题不在 inline 头，而在**目标地址**：
     *     浏览器只内嵌渲染极少数 MIME（pdf/图片/视频/音频/text）；
     *     Office、CAD 这些专用 MIME 浏览器**没有渲染器**，inline 也只能下载。
     *     PDF 恰好原生支持，所以只有它「看起来是对的」。
     *
     *   ⇒ 现在统一走 `API.browserViewUrl()`：它按 `pickViewer()` 的**同一套路由**
     *     选「渲染通道」 —— 与页签里 viewer.render 的分流一一对齐：
     *       · pdf/图片/视频/音频/文本 → /api/raw（原生，零转换）
     *       · office/压缩包/其它      → kkFileView /preview/onlinePreview（text/html）
     *       · cad                     → cad-viewer 深链
     *     并统一过 browserReachableUrl() 把 nebula:8088 换成浏览器可达主机。
     *
     * ★ 为什么 office 不走 OnlyOffice ★
     *   OO 需要 document.key + callbackUrl，每次打开可能触发**回调写回**；
     *   用户只是要「看一眼」。⇒ 走只读的 kkFileView 更稳妥。
     */
    async openInBrowser() {
      try {
        const url = await API.browserViewUrl(this.mount, this.path, this.name);
        if (!url) throw new Error("后端未返回可预览的地址");
        const w = window.open(url, "_blank", "noopener");
        // 弹窗被拦截时要明确告诉用户，否则点了没反应像是坏了
        if (!w) showMsg("浏览器拦截了新窗口，请允许本站弹出窗口后重试");
      } catch (e) {
        showMsg(`在浏览器中打开失败：${(e && e.message) || "未知原因"}`);
      }
    }

    embedToDoc() {
      // ★★★ 不要在这里「拿不到 protyle 就提前返回」★★★
      //
      //   2026-09-22 的关键教训：用户在「NebulaDisk 预览页」点这个按钮时，
      //   **焦点在插件页签里**，`getActiveProtyle()`（它只看 .protyle-wysiwyg）
      //   很可能返回 null（文档页签不在前台、或一个编辑器都没有）。
      //
      //   原先这里 `if (!protyle) { showMsg("请先打开一个文档…"); return; }`
      //   ⇒ 直接拦掉了整条链路，**locateInsertPoint 的多级回退根本没机会跑**，
      //     用户明明开着文档却被要求"先打开一个文档"。
      //
      //   ⇒ 现在把 null 也照常传下去：定位是 embed.js 的职责，它有
      //     聚焦页签 / data-initdata / layout 遍历 五级回退，比这里靠谱得多。
      const protyle = getActiveProtyle();
      // ★★★ 这里曾经是「反引号围栏 + protyle.insert」，双重错误 ★★★
      //   ① 反引号（```nebuladisk）只会生成 type=c 普通代码块，不是自定义块
      //   ② 前端 protyle.insert 在浏览器端会把内容存成普通段落（type=p）
      //   ⇒ 结果就是用户看到的「笔记里一坨裸 JSON」。
      //   现在统一走 insertEmbedIntoDoc：内核 API + `;;;` 围栏。
      //   （用户实际点的是这个按钮，务必保持与其它插入点一致）
      const plugin = window.__nebuladiskPlugin;
      if (!plugin) {
        showMsg("插件未就绪，请稍后重试");
        return;
      }
      insertEmbedIntoDoc(plugin, protyle, {
        kind: "file",
        mount: this.mount,
        path: this.path,
        name: this.name,
      }).then((ok) => {
        showMsg(ok ? "已嵌入到当前文档"
                   : "嵌入失败：内核没有生成自定义块");
      }).catch((e) => {
        // ★ 把真实原因显示出来（尤其是「找不到文档」这种可自助解决的）★
        //   并把定位轨迹一并打到控制台，便于继续收敛。
        try {
          if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
        } catch { /* 忽略 */ }
        showMsg(`嵌入失败：${(e && e.message) || "未知原因"}`);
      });
    }

    /** 极简语法着色（仅对常见代码扩展名，纯前端、不引依赖） */
    maybeHighlight(pre) {
      const e = this.ext;
      if (!["js", "ts", "json", "py", "java", "go", "rs", "c", "cpp", "h", "sh", "sql", "css", "html", "xml", "yml", "yaml"].includes(e)) {
        return;
      }
      let text = pre.textContent;
      const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      text = esc(text);
      // 注释 → 字符串 → 数字/关键字（顺序很重要，避免互相污染）
      const box = [];
      const stash = (html) => { box.push(html); return `\u0000${box.length - 1}\u0000`; };

      text = text.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => stash(`<span class="nb-hl-c">${m}</span>`));
      text = text.replace(/(&quot;|")(?:[^"\\]|\\.)*?\1|'(?:[^'\\]|\\.)*?'/g, (m) => stash(`<span class="nb-hl-s">${m}</span>`));
      text = text.replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => stash(`<span class="nb-hl-n">${m}</span>`));
      text = text.replace(
        /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|def|self|None|True|False|public|private|void|int|string|bool|struct|fn|impl|use|package)\b/g,
        (m) => stash(`<span class="nb-hl-k">${m}</span>`),
      );
      pre.innerHTML = text.replace(/\u0000(\d+)\u0000/g, (_, i) => box[Number(i)]);
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this._kkTimer);
      if (this._ooEditor) {
        try { this._ooEditor.destroyEditor(); } catch { /* 已销毁 */ }
        this._ooEditor = null;
      }
    }
  }

  /* -------------------------------------------------------------------------
   * 工具
   * ---------------------------------------------------------------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /**
   * 智能解码文本（实现在 api.js，两边共用；见顶部 import 注释）
   */
  function showMsg(text) {
    showMessage(text);
  }

  function getActiveProtyle() {
    const el = document.querySelector(".protyle-wysiwyg--focus") ||
               document.querySelector(".protyle-wysiwyg");
    if (!el) return null;
    const p = el.closest(".protyle");
    return p?._protyle || null;
  }
  return {
    __cjs: false,
    Viewer,
  };
})();

/* ===== index.js ===== */
const __mod_index = (() => {
  const module = { exports: {} };
  const exports = module.exports;
  const Plugin = SIYUAN.Plugin;
  const getFrontend = SIYUAN.getFrontend;
  const showMessage = SIYUAN.showMessage;
  const openTab = SIYUAN.openTab;
  const Dialog = SIYUAN.Dialog;
  const API = __mod_api.API;
  const setUnauthorizedHandler = __mod_api.setUnauthorizedHandler;
  const displayMountPath = __mod_api.displayMountPath;
  const CUSTOM_ICONS = __mod_icons.CUSTOM_ICONS;
  const typeIconEl = __mod_icons.typeIconEl;
  const extOf = __mod_icons.extOf;
  const FileTree = __mod_tree.FileTree;
  const Viewer = __mod_viewer.Viewer;
  const registerEmbed = __mod_embed.registerEmbed;
  const bindPluginApi = __mod_embed.bindPluginApi;
  const migrateLegacyEmbeds = __mod_embed.migrateLegacyEmbeds;
  const buildEmbedMarkdown = __mod_embed.buildEmbedMarkdown;
  const findLegacyFenceBlocks = __mod_embed.findLegacyFenceBlocks;
  const findParagraphFences = __mod_embed.findParagraphFences;
  const insertEmbedIntoDoc = __mod_embed.insertEmbedIntoDoc;
  const collapseAllOpenEmbeds = __mod_embed.collapseAllOpenEmbeds;
  const NebulaProxy = __mod_proxy.__exports.NebulaProxy;
  const HAS_NODE = __mod_proxy.__exports.HAS_NODE;
  const setDiagFile = __mod_proxy.__exports.setDiagFile;
  const diag = __mod_proxy.__exports.diag;
  const dirExists = __mod_proxy.__exports.dirExists;
  const pickWorkspace = __mod_proxy.__exports.pickWorkspace;
  const normPath = __mod_proxy.__exports.normPath;
  const probeProxyPort = __mod_proxy.__exports.probeProxyPort;
  /* ==========================================================================
   * NebulaDisk 网盘 —— 思源笔记插件
   * --------------------------------------------------------------------------
   * 三项需求与实现位置：
   *   ① 侧边栏直接浏览网盘文件
   *        → addDock("nbDock") + FileTree（src/tree.js）
   *   ② 预览与在线编辑
   *        → addTab("nbViewer") + Viewer（src/viewer.js）
   *   ③ 笔记内无缝嵌入文件树 / 文件页面
   *        → 自定义块渲染 + 斜杠菜单 + 命令（src/embed.js）
   *
   * 跨域问题的解法见 src/proxy.js 顶部注释。
   * ========================================================================== */







  /**
   * ★ 不要在这个 import 里加回 repairFenceBlock / extractJson（2026-09-22 清理）★
   *
   *   这两个符号曾经被导入但从未使用 —— 死导入，会被 test/syntax.check.js 的
   *   【④ 未使用的 import】抓出来。
   *
   *   为什么它们是「没用」而不是「漏用」：
   *     src/embed.js 里的 repairFenceBlock() / extractJson() 是**通用版**
   *     （按 blockId 直接重建），而本文件走的是**另一条更早的实现路线**：
   *       · 反引号围栏残留 → 本文件的 upgradeFenceBlock()（内联 updateBlock）
   *       · 段落围栏残留   → 本文件的 repairParagraphFence()（内联 删+重插）
   *     两者都把逻辑内联在自己方法里了，不依赖 embed.js 的那两个函数。
   *     ⇒ 同一条逻辑存在两份实现，import 的那份从未被调用。
   *
   *   若将来要统一到 embed.js 的实现，**先删掉这里的内联版本**，
   *   否则会变成「两份代码同时生效」，行为和日志都会难以判断。
   */

  /*
   * 代理类必须在**编译期**就引入。
   *
   *   不能写成运行时的 require("./src/proxy.js")：
   *   思源给插件的 require 只认 "siyuan"，其余走 Electron 的 window.require，
   *   其解析基准是渲染进程 bundle 而非插件目录 ⇒ 必然 MODULE_NOT_FOUND，
   *   而且只报在浏览器 console，siyuan.log 里看不到。
   *   构建脚本会把它连同本文件一起打成一个 index.js。
   */


  /** 页签类型 */
  const TAB_TYPE = "nebuladisk_viewer";
  /** 停靠面板类型（传给 addDock 的 type，思源会自动补插件名前缀） */
  const DOCK_TYPE = "nebuladisk_tree";
  /** 插件名（思源内部把它拼在 dock type 前面，见 common.js 的 addDock） */
  const PLUGIN_NAME = "siyuan-nebuladisk";
  /** 思源实际用的 dock 标识 = 插件名 + type，用于查询侧栏图标 DOM */
  const DOCK_TYPE_FULL = PLUGIN_NAME + DOCK_TYPE;
  /** 自定义块类型（笔记内嵌） */
  const EMBED_BLOCK_TYPE = "nebuladisk";
  /** 设置持久化 key */
  const STORAGE_KEY = "settings";

  /* -------------------------------------------------------------------------
   * 默认设置
   * ---------------------------------------------------------------------- */
  /**
   * 推断一个合理的后端地址。
   *
   * ★ 为什么不写死 IP ★
   *   同一个插件会被两种完全不同的思源加载：
   *     · 桌面端（本机装，Electron）—— 页面在 127.0.0.1:6806
   *     · 服务端（NAS 上用 Docker 跑，浏览器访问）—— 页面在 172.16.30.128:6806
   *   写死 192.168.193.70（ZeroTier 地址）时，浏览器端经常解析不到，
   *   表现就是「图标有、点了连不上」，用户完全不知道为什么。
   *   实测：NAS 上的思源容器访问 172.16.30.128:8089 是通的。
   *
   *   因此默认值跟随**当前页面所在主机**：网盘和思源本来就部署在同一台机器上，
   *   用页面 hostname 拼 8089 在两种场景下都成立。
   *   用户仍可在设置里改成别的地址（例如走 ZeroTier 或域名）。
   *
   * ★ 端口 8089 从哪来 ★
   *   部署目录 .env 的 NB_HOST_PORT=8089（宿主机映射端口），
   *   容器内是 8088。插件从浏览器访问，必须用宿主机端口。
   */
  function guessServerUrl() {
    try {
      const h = (typeof location !== "undefined" && location.hostname) || "";
      // file:// 打开或拿不到 hostname 时，退回历史上一直在用的地址
      if (!h || h === "localhost" || h === "127.0.0.1") {
        // 桌面端：思源和网盘常常不在同一台机器（思源本机装、网盘在 NAS），
        // 保留 ZeroTier 地址作为本机场景的默认
        return "http://192.168.193.70:8089";
      }
      return `http://${h}:8089`;
    } catch (e) {
      return "http://192.168.193.70:8089";
    }
  }

  const DEFAULT_SETTINGS = {
    serverUrl: guessServerUrl(),
    username: "tao_zhang",
    password: "",
    autoLogin: true,
    proxyPort: 6810,
    defaultMount: "",
    confirmDelete: true,
  };

  /* -------------------------------------------------------------------------
   * 代理引导
   *
   * 难点：插件的 index.js 跑在「思源渲染进程（Electron renderer）」里。
   *   在 Electron 中，renderer 带有 node 集成时可以直接 require("http")；
   *   但如果思源的 renderer 关闭了 nodeIntegration（新版本倾向如此），
   *   require 就不可用。
   *
   * 策略（三级降级，逐级给出可操作提示）：
   *   ① 直接 require node 内建模块，在渲染进程内起代理 —— 最省事，首选
   *   ② 失败则提示用户粘贴「JS 代码片段」启动代理（片段在设置面板里一键复制）
   *   ③ 都不行则提示改用「反代统一入口」方案（把 /nb 交给 nginx）
   *
   * 关键点：不管哪条路，代理都必须监听 127.0.0.1。
   *   思源无论跑在宿主机还是容器里，插件 JS 都在思源自己的进程内，
   *   所以 127.0.0.1 对它永远可达。
   * ---------------------------------------------------------------------- */
  class ProxyBoot {
    constructor(plugin) {
      this.plugin = plugin;
      this.proxy = null;
      this.mode = "none";   // none | inline | external
    }

    /**
     * 尝试在渲染进程内直接启动代理。
     *
     * ★ 这里**不能**写 require("./src/proxy.js")。
     *
     *   思源给插件的 require 只处理 "siyuan"，其余委托给 Electron 的
     *   window.require，其解析基准是**渲染进程 bundle**，不是插件目录，
     *   所以相对路径必然 MODULE_NOT_FOUND。
     *   而且这个错误只写进浏览器 console，siyuan.log 里毫无痕迹。
     *
     *   ⇒ 插件被 tools/build.js 打成**单文件**，proxy 已是同文件内的
     *     模块命名空间，直接引用即可（见 import { NebulaProxy }）。
     *      真正的风险只剩「渲染进程没有 node 能力」这一种，
     *      此时 require("http") 会在 **加载 proxy 模块时**就抛错 ——
     *      所以下面用 try 包住构造，失败就降级到外部代理 / nginx 方案。
     */
    async startInline() {
      const s = this.plugin.settings;
      const port = Number(s.proxyPort) || 6810;

      // ★★★ 先判环境有没有 node 能力 ★★★
      //   服务端思源（NAS 上用 Docker 跑、浏览器访问）**没有 require/process/fs**。
      //   这时起代理是物理上不可能的，**不该报错、更不该让插件挂掉** ——
      //   必须干脆地降级为「直连通道」，并把原因讲清楚。
      //   历史教训：proxy.js 曾在模块顶层 require("http")，
      //   浏览器里脚本求值即抛 ⇒ 思源 console.error 后静默丢弃整个插件
      //   ⇒ 连诊断日志都不产生，表现为「插件在列表里但毫无反应」。
      if (!HAS_NODE) {
        // ★ 用 "direct" 而不是 "none" ★
        //   "none" 是「本该有代理却没有」的失败态；这里不是失败，
        //   而是「这个环境本来就不需要代理」。状态必须区分开，
        //   否则侧边栏会误判为通道不可用而不渲染文件树。
        this.mode = "direct";
        this._noNode = true;
        diag("[proxy] 当前环境无 node 能力（浏览器端思源）⇒ 使用直连通道（正常）");
        return true;
      }

      // ── 先探测：端口上是否已经有本插件的代理在跑 ──
      //  思源的渲染进程会**反复重建**（每次重载都会重新执行 onload），
      //  而上一轮的代理句柄随旧进程一起消失时端口未必立刻释放。
      //  旧实现直接 listen，撞上 EADDRINUSE 就判定「代理不可用」，
      //  实际那个代理是好的 —— 这个误判让通道白丢。
      //  所以先探一次，能复用就复用。
      const existing = await probeProxyPort(port);
      if (existing.ok) {
        this.mode = "external";
        this.externalPort = port;
        this._reused = true;
        diag(`复用已在运行的代理 :${port}（target=${existing.info && existing.info.target}）`);
        return true;
      }

      try {
        this.proxy = new NebulaProxy({
          target: s.serverUrl,
          port,
          host: "127.0.0.1",
          cookieFile: this.plugin.cookieFile(),
          log: (m) => console.log(m),
        });
        await this.proxy.start();
        this.mode = "inline";
        this.actualPort = this.proxy.actualPort;
        return true;
      } catch (e) {
        // 记全栈，便于从日志定位（端口占用 / 无 node 能力 / 配置错误）
        this.lastError = e && e.stack ? e.stack.split("\n")[0] + " | " + e.message : String(e.message || e);
        this.proxy = null;
        // ── 兜底：listen 失败的另一种可能是「刚好被别的进程抢在探测之后占了」，
        //    再探一次，仍能复用就不算失败。
        const again = await probeProxyPort(port);
        if (again.ok) {
          this.mode = "external";
          this.externalPort = port;
          this._reused = true;
          diag(`listen 失败但探测到可用代理 :${port}，改用复用模式`);
          return true;
        }
        return false;
      }
    }

    /**
     * 探测外部代理是否已经在跑。
     *
     * ★ 用 Node http 而不是浏览器 fetch ★
     *   fetch 受同源策略约束 —— 思源页面与代理端口不同即跨源，
     *   若那个代理是旧版（无 CORS 头），响应体会被浏览器丢弃，
     *   fetch 抛错 ⇒ 误判「没有代理」。见 proxy.js: probeProxyPort 的说明。
     */
    async probeExternal() {
      const s = this.plugin.settings;
      const port = Number(s.proxyPort) || 6810;
      const r = await probeProxyPort(port);
      if (!r.ok) return false;
      // 外部代理的端口与思源不同 ⇒ 插件要指向它，而不是 /nb 相对路径
      this.mode = "external";
      this.externalPort = port;
      this._reused = true;
      return true;
    }

    async stop() {
      // 复用来的代理不属于本实例，不能停 —— 否则会把别的渲染进程
      // （或用户自己起的代理）一起关掉。
      if (this.proxy) {
        await this.proxy.stop();
        this.proxy = null;
      }
      this._reused = false;
      // ★ 无 node 能力是环境属性，不因 stop 而改变 ★
      //   若这里无脑置 "none"，api.js 的 hasNode() 会读不到，
      //   又可能把请求带回 127.0.0.1:6810。
      this.mode = this._noNode ? "direct" : "none";
    }

    /**
     * 本环境有没有 node 能力（= 能不能起本地代理）。
     *
     * api.js 的 hasNode() 会读这个字段来锁定通道：
     * 浏览器端思源**永远不该**回退到 127.0.0.1:6810。
     */
    get noNode() {
      return !!this._noNode;
    }

    get status() {
      if (this.mode === "inline") return { ok: true, mode: "inline", detail: "插件内嵌代理运行中" };
      if (this.mode === "external") return { ok: true, mode: "external", detail: `外部代理运行中（端口 ${this.externalPort}）` };
      // ★★★ 「无 node 能力」是一种**正常可用状态**，不是失败 ★★★
      //   服务端思源（NAS Docker + 浏览器）就是这样：起不了代理，
      //   但只要网盘地址配好、后端开了 CORS，直连通道完全能用。
      //   这里若返回 ok:false，侧边栏会一直停在「通道未就绪」，
      //   明明能用却什么都不显示 —— 用户只会觉得插件坏了。
      //   所以单独给一个 direct 模式，并且 ok:true。
      if (this.mode === "direct") {
        return { ok: true, mode: "direct", detail: "直连通道（当前环境无需内置代理）" };
      }
      return { ok: false, mode: "none", detail: this.lastError || "代理未启动" };
    }
  }

  /* -------------------------------------------------------------------------
   * 插件主体
   * ---------------------------------------------------------------------- */
  class NebulaDiskPlugin extends Plugin {
    constructor(options) {
      super(options);
      this.settings = { ...DEFAULT_SETTINGS };
      /** @type {ProxyBoot} */
      this.boot = null;
      /** @type {FileTree|null} */
      this.tree = null;
      this._unauthorized = false;
    }

    /* =====================================================================
     * 生命周期
     * ================================================================== */
    async onload() {
      const frontend = getFrontend();
      const isDesktop = frontend === "desktop" || frontend === "desktop-window";

      // 0) 先把诊断日志接上，之后任何环节失败都能在磁盘上看到
      setDiagFile(this.diagFile());
      diag(`=== onload 开始 frontend=${frontend} ===`);
      diag(`node 能力: require=${typeof require} process=${typeof process} fetch=${typeof fetch}`);
      diag(`diagFile=${this.diagFile() || "(空！日志将不可见)"}`);

      // ★ 分步诊断 ★
      //   思源只把 onload 的异常打到浏览器 console，外部完全看不到。
      //   这里把每个阶段用 try 包起来，失败就把阶段名与完整栈写进日志，
      //   这样「跑到哪一步断的」在磁盘上就能读到。
      const step = (name, fn) => {
        try {
          diag(`  → ${name}`);
          const r = fn();
          diag(`  ✓ ${name}`);
          return r;
        } catch (e) {
          diag(`  ✗ ${name} 抛错: ${e && e.stack ? e.stack : e}`);
          throw e;
        }
      };

      try {
        // 0.1) 暴露给 src/ 下的模块使用（viewer 需要读网盘地址等设置）
        window.__nebuladiskPlugin = this;

        // 1) 载入设置（要先于代理启动，因为代理需要 serverUrl/port）
        await step("loadSettings", () => this.loadSettings());

        // 2) 注册自定义图标
        step("addIcons", () => this.addIcons(CUSTOM_ICONS));

        // 3) 注册自定义块渲染（笔记内嵌）—— 必须在 onload 同步段内完成
        //    同时把 API 绑定给渲染器，避免 index.js ↔ embed.js 循环依赖
        step("bindPluginApi", () => bindPluginApi(this, API));
        step("registerEmbed", () => registerEmbed(this));

        diag("  → addTab/addDock/addTopBar");

        // 4) 注册页签类型（预览 / 编辑）
        this.addTab({
        type: TAB_TYPE,
        init() {
          // this.element / this.data 由思源注入
          const viewer = new Viewer(this.element, this.data);
          this._viewer = viewer;
          viewer.render();
        },
        beforeDestroy() {
          if (this._viewer) this._viewer.destroy();
        },
        destroy() {
          if (this._viewer) this._viewer.destroy();
          this._viewer = null;
        },
      });

      // 5) 注册侧边栏停靠面板
      //    参照已在用的第三方插件写法（siyuan-canvas / siyuan-plugin-task-list /
      //    siyuan-table-master）：
      //      · config.show 必须显式给 false —— 否则思源不认为这个面板「还没被打开」，
      //        侧栏图标不会挂上去（这是们之前看不到入口的直接原因）
      //      · position 用 RightTop，与其它插件的停靠面板一致
      //    ⚠️ 注意：思源内部把 dock 的标识拼成 `插件名 + type`
      //       （common.js: addDock(){ const ze = this.name + se.type }），
      //       所以 data-type 实际是 "siyuan-nebuladisknebuladisk_tree"，
      //       查询图标时必须用 DOCK_TYPE_FULL。
      this.addDock({
        config: {
          position: "RightTop",
          size: { width: 280, height: 0 },
          icon: "iconNebulaDisk",
          title: this.i18n.dockTitle || "NebulaDisk",
          hotkey: isDesktop ? "⌥⌘N" : "",
          show: false,
        },
        data: {},
        type: DOCK_TYPE,
        init: (dock) => this.initDock(dock),
        destroy: () => {
          if (this.tree) {
            this.tree.destroy();
            this.tree = null;
          }
        },
        update: () => {
          if (this.tree) this.tree.refresh();
        },
        resize: () => {
          if (this.tree) this.tree.onResize();
        },
      });

      // 6) 顶栏按钮
      this.addTopBar({
        icon: "iconNebulaDisk",
        title: this.i18n.dockTitle || "NebulaDisk",
        position: "right",
        callback: () => this.openDockPanel(),
        contextMenu: (menu) => {
          menu.addItem({
            icon: "iconSettings",
            label: this.i18n.settingsTitle || "设置",
            click: () => this.openSetting(),
          });
          menu.addItem({
            icon: "iconRefresh",
            label: this.i18n.refreshAll || "刷新",
            click: () => this.tree && this.tree.refresh(true),
          });
          menu.addItem({
            icon: "iconLink",
            label: this.i18n.openInBrowser || "在浏览器中打开网盘",
            click: () => window.open(this.settings.serverUrl, "_blank"),
          });
        },
      });

      // 7) 命令
      //
      // ★ 不要用 globalCallback ★
      //   思源看到 globalCallback 会去注册**托盘菜单**项，内部访问 this._trayMenu；
      //   而在 onload 阶段托盘菜单尚未初始化，于是抛
      //       TypeError: Cannot read properties of undefined (reading '_trayMenu')
      //   这个异常只进浏览器 console，外部表现就是「插件加载了但什么都没发生」。
      //   实测（思源 3.8.4）在本插件里加 globalCallback 必崩，改用普通 callback。
      this.addCommand({
        langKey: "openNebulaDisk",
        hotkey: isDesktop ? "⌥⌘N" : "",
        callback: () => this.openDockPanel(),
      });
      this.addCommand({
        langKey: "refreshNebulaDisk",
        callback: () => this.tree && this.tree.refresh(true),
      });

      // 8) 斜杠菜单（笔记内嵌入口）
      //
      // ★★★ 2026-09-22 用户要求：删掉「嵌入文件树到文档」这一项 ★★★
      //
      //   原话：「20 嵌入文档树到文档这个功能取消删除不需要了。
      //          /网 跳出菜单 名称改为：嵌入文件到文档」
      //
      //   为什么删而不是保留：
      //     · 「嵌入文件树」= 把一整个网盘目录嵌进笔记。它的价值是"目录镜像"，
      //       但网盘目录随时会变，嵌入块里看到的永远是**那一刻**的列表快照，
      //       对不上号时用户会以为内容丢了。真正要"看目录"直接开侧边栏更合适。
      //     · 剩下的「嵌入文件」覆盖了实际用法：嵌单个文件，点开预览，
      //       旁边的「定位」按钮还能跳回它所在的目录 —— 目录信息并没有丢。
      //     · 两项在菜单里名字相近（都叫"嵌入…到文档"），并存只会让人误点。
      //       ⇒ 删掉 kind==="tree" 的入口。底层 renderTreeBrowser 仍保留，
      //         因为**历史笔记里已有的 tree 嵌入块**还要能正常渲染，
      //         删入口不等于删渲染能力（否则老笔记会变白块）。
      this.protyleSlash = [
        {
          filter: ["nebula", "wangpan", "网盘", "nb", "yunpan", "wenjian", "文件"],
          html: `<div class="b3-list-item__first">
                   <svg class="b3-list-item__graphic"><use xlink:href="#iconNebulaDisk"></use></svg>
                   <span class="b3-list-item__text">${this.i18n.embedFileName || "嵌入文件到文档"}</span>
                 </div>`,
          id: "nebulaEmbedFile",
          callback: (protyle, el) => this.pickAndEmbed(protyle, "file", el),
        },
      ];

      // 9) 401 统一处理
      setUnauthorizedHandler(() => {
        this._unauthorized = true;
        if (this.tree) this.tree.onSessionLost();
      });

      // 10) 启动代理（异步，不阻塞插件加载）
      this.boot = new ProxyBoot(this);
      this.bootReady = this.boot.startInline().then(async (ok) => {
        if (!ok) {
          diag(`startInline 失败: ${this.boot.lastError || "(无异常信息)"}`);
          // 退化：探测外部代理（用户用 JS 代码片段起的那种）
          const ext = await this.boot.probeExternal();
          if (!ext) {
            const detail = this.boot.status.detail;
            diag(`外部代理也探测不到 ⇒ 代理不可用。detail=${detail}`);
            console.warn("[nebuladisk] 代理未启动:", detail);
            if (this.tree) this.tree.onProxyDown(detail);
            return false;
          }
          diag("外部代理可用（mode=external）");
        }
        // 代理可用 → 尝试自动登录
        diag(`代理就绪 mode=${this.boot.mode} port=${this.boot.actualPort || ""}`);
        if (this.settings.autoLogin && this.settings.password) {
          await this.tryAutoLogin();
        }
        if (this.tree) this.tree.onProxyUp();
        return true;
      }).catch((e) => {
        diag(`bootReady 抛异常: ${e && e.stack ? e.stack : e}`);
        return false;
      });

        diag("=== onload 同步段结束（UI 已注册）===");
      } catch (e) {
        // 同步段任何一步抛错都会走到这里 —— 之前这些异常只进浏览器 console，
        // 外部完全看不到，排查时只知道「插件在、但没反应」。
        diag(`=== onload 同步段失败 ===\n${e && e.stack ? e.stack : e}`);
        throw e;
      }
    }

    onLayoutReady() {
      // 布局就绪时，如果面板已经存在（用户上次是展开的），
      // 主动把代理/会话状态同步给它 —— 因为面板的 bootstrap 可能在
      // 代理就绪之前就跑完了。
      if (this.tree) {
        this.bootReady?.then((ok) => {
          if (!this.tree) return;
          if (ok) this.tree.onProxyUp();
          else this.tree.onProxyDown(this.boot ? this.boot.status.detail : "未初始化");
        });
      }

      // ★ 自愈①：修复「data-info 缺斜杠」的自定义块 ★
      //   这类块 DOM 已经是 NodeCustomBlock，只是 data-info 让思源找不到
      //   渲染器 ⇒ 显示裸 JSON。可以直接在 DOM 里就地重绘（不改笔记）。
      //   → 见 embed.js 的 migrateLegacyEmbeds / renderInPlace 注释。
      //
      // ★ 自愈②：升级「反引号围栏残留」的普通代码块 ★
      //   早期实现用 ```nebuladisk，但反引号只会生成 type=c 普通代码块，
      //   前端无法把它变成自定义块 ⇒ 必须改块内容（走内核 API）。
      //   静默执行，失败只记日志，绝不影响正常使用。
      this.startLegacyEmbedWatch();
      this.startLegacyFenceUpgrade();
    }

    async onunload() {
      // ★ 任务④：先把所有已展开的嵌入块收起来 ★
      //   每个展开的块 = 一个 iframe（OO 编辑器可能有几十上百 MB）。
      //   插件卸载/重载时如果不管，这些 iframe 会挂在思源页面上泄漏 ——
      //   尤其开发期反复「关闭插件再打开」，不做这步很快就堆一堆。
      try { collapseAllOpenEmbeds(); } catch (e) { console.log("[nebuladisk] 收起嵌入块失败（忽略）: " + (e && e.message)); }
      if (this._legacyObserver) {
        try { this._legacyObserver.disconnect(); } catch { /* 忽略 */ }
        this._legacyObserver = null;
      }
      if (this._legacyTimer) {
        clearTimeout(this._legacyTimer);
        this._legacyTimer = null;
      }
      if (this._fenceObserver) {
        try { this._fenceObserver.disconnect(); } catch { /* 忽略 */ }
        this._fenceObserver = null;
      }
      if (this._fenceTimer) {
        clearTimeout(this._fenceTimer);
        this._fenceTimer = null;
      }
      if (this.tree) {
        this.tree.destroy();
        this.tree = null;
      }
      if (this.boot) {
        await this.boot.stop();
        this.boot = null;
      }
      if (window.__nebuladiskPlugin === this) {
        delete window.__nebuladiskPlugin;
      }
      console.log("[nebuladisk] 已卸载");
    }

    async uninstall() {
      await this.removeData(STORAGE_KEY).catch(() => {});
    }

    /* =====================================================================
     * 设置
     * ================================================================== */
    async loadSettings() {
      try {
        const d = await this.loadData(STORAGE_KEY);
        if (d && typeof d === "object") {
          this.settings = { ...DEFAULT_SETTINGS, ...d };
        }
      } catch {
        this.settings = { ...DEFAULT_SETTINGS };
      }
    }

    async saveSettings() {
      // ★ 地址/端口一变，通道结论就作废 ★
      //   通道是按 serverUrl 缓存的，改了地址必须重探，
      //   否则会拿着旧地址的探测结果去请求新地址（表现为莫名的连不上）。
      const prev = this._lastSavedServer;
      const now = String(this.settings.serverUrl || "").trim();
      if (prev !== undefined && prev !== now) {
        try {
          API.resetChannel();
          diag(`[设置] 网盘地址变更：${prev || "(空)"} → ${now || "(空)"}，已重置通道`);
        } catch { /* ignore */ }
      }
      this._lastSavedServer = now;
      await this.saveData(STORAGE_KEY, this.settings);
    }

    /** cookie 落盘路径（与思源工作区/data/storage 同级，便于清理） */
    cookieFile() {
      const wd = this.workspaceDir();
      if (!wd) return "";
      return `${wd}/storage/nebuladisk.cookie.json`;
    }

    /**
     * 解析思源工作区目录 —— 多级回退。
     *
     * ★ 为什么不能只认 window.siyuan.config.system.workDir ★
     *   实测思源 3.8.4 桌面端**没有** `config.system.workDir` 这个字段
     *   （那是 kernel 侧的 conf，不在前端 config 里）。
     *   只写这一个来源的后果：拿不到 → diagFile() 返回空 → diag() 全部静默，
     *   cookie 也只存内存不落盘。排查时只看到「插件在、但什么都不发生」，
     *   完全是个黑洞。
     *
     * 回退顺序：
     *   ① window.siyuan.config.system.workspaceDir / workDir
     *   ② 从 location 推断（file:///D:/Software/SiYuan/...）
     *   ③ process.cwd()（Electron 渲染进程的 cwd 常是工作区）
     *   逐个用 pickWorkspace 校验（必须含 data/ 或 storage/）后才采纳。
     */
    workspaceDir() {
      if (this._wsDir !== undefined) return this._wsDir;
      const cands = [];
      try {
        const sys = window.siyuan?.config?.system || {};
        cands.push(sys.workspaceDir, sys.workDir);
      } catch { /* 无 window.siyuan */ }

      try {
        const href = String(location.href || "");
        const m = href.match(/file:\/\/\/([A-Za-z]:\/[^/]+\/[^/]+)/);
        if (m) cands.push(decodeURIComponent(m[1]));
      } catch { /* 无 location */ }

      try {
        if (typeof process !== "undefined" && process.cwd) cands.push(process.cwd());
      } catch { /* 无 process */ }

      this._wsDir = pickWorkspace(cands);
      return this._wsDir;
    }

    /**
     * 诊断日志路径。
     *
     * 思源加载插件时抛的异常只进浏览器 console，siyuan.log 里什么都没有；
     * 代理启动失败也是同样下场 —— 外部只看到「插件在、但没数据」。
     * 把关键过程写进这个文件，脚本即可读出真正的错因。
     *
     * ★ 路径必须是「绝对且确定」的 ★
     *   不能用相对路径：思源渲染进程的 cwd 不一定是插件目录，
     *   写出来的文件会跑到莫名其妙的地方，排查时找不到。
     *   这里优先用已知的插件安装目录，其次才猜工作区。
     */
    diagFile() {
      if (this._diagFile !== undefined) return this._diagFile;

      // ★ 放 temp/ 而不是 plugins/ ★
      //   plugins/ 在思源的云同步范围里，诊断日志会被当成插件文件上传，
      //   既污染同步仓库、又会在别人机器上留下无意义的日志。
      //   temp/ 是本地临时目录，不参与同步。
      const wd = this.workspaceDir();
      if (wd) {
        this._diagFile = `${wd}/temp/nebuladisk.log`;
        return this._diagFile;
      }

      // 兜底：从 location 反推插件目录
      try {
        const m = String(location.href || "").match(
          /^(?:file|http[^:]*):\/\/[^/]*(\/[A-Za-z]:\/.*?\/data\/plugins\/[^/]+)/,
        );
        if (m) {
          const dir = normPath(decodeURIComponent(m[1]));
          if (dirExists(dir)) {
            this._diagFile = `${dir}/nebuladisk.log`;
            return this._diagFile;
          }
        }
      } catch { /* ignore */ }

      this._diagFile = "";
      return "";
    }

    openSetting() {
      const s = this.settings;

      /** 所有输入框，用于「点按钮前先同步一遍」 */
      const inputs = [];

      const mkInput = (label, key, type = "text", placeholder = "") => {
        const wrap = document.createElement("div");
        wrap.className = "nb-setting-item";
        wrap.innerHTML = `<label class="nb-setting-label">${label}</label>`;
        const input = document.createElement("input");
        input.className = "b3-text-field fn__block";
        input.type = type;
        input.value = s[key] ?? "";
        input.placeholder = placeholder;
        input.addEventListener("change", () => { s[key] = input.value; });
        // ★ 额外监听 input：边打字边同步，杜绝 change 不触发导致发旧值 ★
        input.addEventListener("input", () => { s[key] = input.value; });
        wrap.appendChild(input);
        inputs.push({ key, input });
        return wrap;
      };

      /**
       * 把 DOM 里的当前值写回 settings。
       * 点按钮时调用 —— 不依赖 change 的触发时机。
       */
      const syncInputs = () => {
        for (const { key, input } of inputs) {
          let v = input.value;
          if (key === "proxyPort") {
            const n = Number(v);
            if (v !== "" && Number.isFinite(n) && n > 0) s[key] = n;
            continue;
          }
          s[key] = v;
        }
      };

      /** 一段灰色说明文字（不参与取值，纯提示） */
      const hint = (text) => {
        const el = document.createElement("div");
        el.className = "nb-setting-hint";
        el.textContent = text;
        return el;
      };

      const box = document.createElement("div");
      box.className = "nb-settings";

      const status = this.boot ? this.boot.status : { ok: false, detail: "未初始化" };
      const banner = document.createElement("div");
      // ★ 徽标语义要区分「直连可用」与「代理可用」★
      //   旧的判断只看代理：地址填对了、后端也开了 CORS，
      //   但因为代理没起来就显示「未就绪」，误导用户去查网络。
      //   现在：有 serverUrl 且（直连探测通过 或 代理就绪）就算可用。
      const hasServer = !!String(s.serverUrl || "").trim();
      const directOk = hasServer && (API.currentKind ? API.currentKind() === "direct" : false);
      const usable = directOk || status.ok;
      banner.className = `nb-settings-banner ${usable ? "is-ok" : "is-warn"}`;
      if (directOk) {
        banner.textContent = `✓ 直连模式 —— ${s.serverUrl}（无需本地代理）`;
      } else if (status.ok) {
        banner.textContent = `✓ 代理模式 —— ${status.detail}`;
      } else {
        banner.textContent = `⚠ 通道未就绪 —— ${status.detail}`;
      }
      box.appendChild(banner);

      box.appendChild(mkInput("网盘地址", "serverUrl", "text", "http://192.168.193.70:8089"));
      box.appendChild(mkInput("用户名", "username"));
      box.appendChild(mkInput("密码（用于自动登录）", "password", "password", "留空则不自动登录"));
      box.appendChild(hint(
        "优先走「直连」：直接请求网盘地址，不需要本地代理，网页端/手机端也能用。" +
        "仅当直连失败（后端未开 CORS 等）时才回退到下面的本地代理。"
      ));
      box.appendChild(mkInput("代理端口（兜底通道）", "proxyPort", "number", "6810"));

      // 自动登录开关
      const rowAuto = document.createElement("div");
      rowAuto.className = "nb-setting-item nb-setting-inline";
      rowAuto.innerHTML = `<label class="nb-setting-label">启动时自动登录</label>`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!s.autoLogin;
      cb.addEventListener("change", () => { s.autoLogin = cb.checked; });
      rowAuto.appendChild(cb);
      box.appendChild(rowAuto);

      // 操作按钮
      const actions = document.createElement("div");
      actions.className = "nb-setting-actions";
      const testBtn = document.createElement("button");
      testBtn.className = "b3-button b3-button--outline";
      testBtn.textContent = this.i18n.settingsVerify || "测试连接";
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = "测试中…";
        try {
          // ★ 关键：先把输入框里的值同步回 settings ★
          //   mkInput 只在 change 事件里赋值，而 change 只在「失焦且值变了」时触发。
          //   点按钮虽然会先 blur，但同步顺序不保证，容易把旧值发出去。
          syncInputs();
          await this.saveSettings();

          // ★ 测试要按「实际会用的通道」来测 ★
          //   旧版无条件重启代理再测 —— 但直连模式压根不用代理，
          //   代理起不来时会把「网络明明是通的」误报成失败。
          //   现在先作废通道缓存、重新探测，让 pickChannel 自己决定。
          API.resetChannel();
          if (this.boot) { await this.boot.stop(); }
          this.boot = new ProxyBoot(this);
          // 探测是异步且非阻塞的：直连可用就不必真去起代理
          const kind = await API.currentKindAsync();

          if (kind === "proxy") {
            // 回退到代理时才需要它真的起来
            const ok = (await this.boot.startInline()) || (await this.boot.probeExternal());
            if (!ok) throw new Error(this.boot.status.detail);
          }

          const me = await API.me();
          diag(`[测试连接] 通道=${kind} /api/me 原始返回: ${JSON.stringify(me)}`);
          const name = me?.username || me?.display || this.settings.username || "已连接";
          const n = Array.isArray(me?.mounts) ? me.mounts.length : 0;
          showMessage(`✓ 连接成功（${kind === "direct" ? "直连" : "代理"}）：${name}，可见 ${n} 个盘`);
        } catch (e) {
          showMessage(`✗ ${e.message}`, 6000, "error");
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = this.i18n.settingsVerify || "测试连接";
        }
      };

      const loginBtn = document.createElement("button");
      loginBtn.className = "b3-button b3-button--outline";
      loginBtn.textContent = "立即登录";
      loginBtn.onclick = async () => {
        try {
          syncInputs();
          await this.saveSettings();
          if (!s.password) {
            throw new Error("请先填写密码（用于登录网盘）");
          }
          const r = await API.login(s.username, s.password);
          diag(`[立即登录] /api/login 原始返回: ${JSON.stringify(r)}`);
          const name = r?.display || r?.username || s.username;
          showMessage(`已登录：${name}`);
          // 登录成功后顺手把盘列表拉一次，便于立刻在侧边栏看到
          if (this.tree) this.tree.refresh(true);
        } catch (e) {
          showMessage(`登录失败：${e.message}`, 6000, "error");
        }
      };

      actions.appendChild(testBtn);
      actions.appendChild(loginBtn);
      box.appendChild(actions);

      const dlg = new Dialog({
        title: this.i18n.settingsTitle || "NebulaDisk 设置",
        content: `<div class="b3-dialog__content nb-dialog-content"></div>`,
        width: "620px",
        height: "560px",
      });
      dlg.element.querySelector(".nb-dialog-content").appendChild(box);

      dlg.bindInput(async () => {
        await this.saveSettings();
        dlg.destroy();
        if (this.tree) this.tree.refresh(true);
        return true;
      });
    }

    /* =====================================================================
     * 会话
     * ================================================================== */
    async tryAutoLogin() {
      const u = String(this.settings.username || "").trim();
      const p = String(this.settings.password || "");
      // ★ 凭据不全时不要发请求 ★
      //   后端 /api/login 的 username/password 都是 Form(...) 必填，
      //   空表单会被 FastAPI 直接判 422（detail: Field required）。
      //   以前不做检查就发，日志里平白多出一条 422，看着像故障。
      if (!u || !p) {
        diag(`[会话] 跳过自动登录：用户名/密码未填写（u=${u ? "有" : "空"} p=${p ? "有" : "空"}）`);
        return false;
      }
      try {
        const r = await API.login(u, p);
        const name = (r && (r.display || r.username)) || u;
        const ch = API.currentKind();
        diag(`[会话] 自动登录成功（通道=${ch}）：${name}${r && r.token ? "（已取得直连 token）" : ""}`);
        this._unauthorized = false;
        return true;
      } catch (e) {
        diag(`[会话] 自动登录失败：${e && e.message}`);
        return false;
      }
    }

    /** 供界面调用的「确保已登录」 */
    /**
     * 是否可以绕过本地代理直接用直连通道。
     *
     * 直连只需一个条件：**配了网盘地址**。
     * 不需要代理、不需要端口、不需要任何本地 Node 进程。
     *
     * ★ 为什么单独抽一个方法 ★
     *   bootstrap 里原本写死了「等 boot.status.ok」——
     *   那是**代理**的启动状态。但直连通道根本不用代理，
     *   于是"地址配好了、代理因端口占用没起来"时面板会卡死在
     *   「通道未就绪」，而网络其实是通的。
     *   把它抽出来，语义从「代理好了吗」变成「有路能走后端吗」。
     */
    canSkipProxy() {
      const u = String((this.settings && this.settings.serverUrl) || "").trim();
      return !!u;
    }

    async ensureLogin() {
      // 直连通道下不需要等任何本地服务 —— API.hasSession 会按通道自己判断
      try {
        const s = await API.hasSession();
        if (s && s.hasSession) return true;
      } catch (e) {
        // ★ 以前这里是静默 catch ★
        //   于是「通道不通」与「没登录」表现一样（都返回 false），
        //   界面永远渲染登录框，用户填了密码也登不上，却看不到原因。
        diag(`[会话] hasSession 检查失败：${e && e.message}`);
      }
      // 尝试用设置的账号自动登录
      if (this.settings.password) {
        const ok = await this.tryAutoLogin();
        if (ok) return true;
      }
      return false;
    }

    /* =====================================================================
     * 面板与页签
     * ================================================================== */
    /**
     * 初始化侧边栏面板。
     *
     * ★ 幂等保护 ★
     *   思源在「每次打开面板 / 切换页签 / 恢复布局」时都会重新 init 一次 dock，
     *   而 initDock 每次都 new 一个 FileTree，新实例会立刻 bootstrap() →
     *   loadMounts() → loadRoot() → GET /api/list。
     *   实测后果：18 秒内打了 1600+ 次 /api/list（诊断日志被刷爆，
     *   网盘连接数暴涨）。旧实例又没被销毁，等于越开越多。
     *
     *   这里的做法：
     *     ① 复用已有实例 —— 若它仍挂在同一 element 上，只做一次刷新；
     *     ② 换 element 了（思源重建了面板容器）才新建，并先销毁旧的。
     */
    initDock(dock) {
      const el = dock.element;
      const prev = this.tree;
      if (prev && !prev.destroyed && prev.el === el) {
        // 同一容器：不重建，只重绘一次即可
        diag("initDock: 复用已有 FileTree（避免重复 bootstrap）");
        prev.render();
        return;
      }
      if (prev && !prev.destroyed) {
        diag("initDock: 容器已变，销毁旧 FileTree 后重建");
        try { prev.destroy(); } catch { /* 忽略 */ }
      }
      this.tree = new FileTree(this, el);
      this.tree.render();
    }

    /**
     * 展开/聚焦侧边栏面板
     *
     * 思源没有公开「展开指定 dock」的 API，私有布局对象在各版本间形态不一。
     * 因此这里按可靠性从高到低依次尝试，最后退化为一句提示：
     *   ① 面板已在 DOM 里（用户之前展开过）→ 直接把它滚进视野
     *   ② 面板未展开 → 去点击思源侧栏上那个对应的图标按钮
     *   ③ 都失败 → 提示用户手动点击
     */
    openDockPanel() {
      // 侧栏上代表本面板的图标按钮（属 panel 类，点击即展开/收起）
      // 思源内部把 dock 标识拼成「插件名 + type」，所以优先按完整标识找；
      // 再退化为只按 type 找（不同版本前缀拼法可能不同）。
      const sels = [
        `.dock__item[data-type="${DOCK_TYPE_FULL}"]`,
        `.dock__item[data-type="${PLUGIN_NAME}${DOCK_TYPE}"]`,
        `.dock__item[data-type="${DOCK_TYPE}"]`,
        `.dock__item[data-type$="${DOCK_TYPE}"]`,
      ];
      for (const sel of sels) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.scrollIntoView({ block: "nearest", inline: "nearest" });
          btn.click();
          return;
        }
      }
      showMessage("请点击右侧边栏的 NebulaDisk 图标展开面板", 4000);
    }

    /**
     * 打开一个网盘文件（预览或编辑）
     * @param {{mount:string,path:string,name:string,ext?:string}} item
     */
    openFile(item, opts = {}) {
      // ★ 任务⑲：页签标题要能看出"这是哪个文档/哪条路径" ★
      //
      //   用户原话：「在页签中，如何知道嵌入的具体文档是那个？」
      //
      //   原来标题只有 `item.name`（纯文件名）。一篇笔记里嵌入
      //   「/研发立项/A项目/图纸/v1.dwg」和「/工艺/B项目/图纸/v1.dwg」时，
      //   两个页签都叫 "v1.dwg"，完全分不清。
      //
      //   改成「文件名 · 挂载点」，并在 title 属性/信息条里保留完整路径：
      //     · 页签宽度有限，把完整路径塞进标题会被思源截断成 "…"，
      //       反而看不清；所以标题给「name · mount」，信息条给全路径。
      //     · 文件名与人眼识别最相关，必须排在最前 —— 页签被截断时
      //       最先保住的就是它。
      //
      //   显式给了 title 就尊重调用方的（某些入口会自定义标题）。
      const mountTag = String(item.mount || "").trim();
      const base = item.name || item.path || "NebulaDisk";
      const title = opts.title
        || (mountTag ? `${base} · ${mountTag}` : base);
      openTab({
        app: this.app,
        custom: {
          id: this.name + TAB_TYPE,
          icon: "iconNebulaDisk",
          title,
          data: { ...item, ...opts },
        },
      });
    }

    /**
     * 在右侧文件树里定位到 `mount:/path`（任务⑳）。
     *
     * 嵌入块上的「定位」按钮走这里；插件的树面板随时可能没挂载
     *   （用户把 NebulaDisk 面板关了 / 还没打开），所以要给出明确反馈，
     *   而不是静默失败。
     *
     * @returns {Promise<boolean>} 是否真的定位到了
     */
    async revealTree(mount, path) {
      if (!this.tree) {
        showMessage("请先打开右侧的 NebulaDisk 文件树面板", 4000, "info");
        return false;
      }
      const ok = await this.tree.revealPath(mount, path);
      if (!ok) showMessage("文件树里没有找到该路径（可能需要先刷新）", 4000, "info");
      return ok;
    }

    /* =====================================================================
     * 笔记内嵌（需求 ③）
     * ================================================================== */
    /**
     * 持续修复「旧写法」的嵌入块。
     *
     * ★ 为什么要持续，而不是只做一次 ★
     *   思源是**按需渲染**的：滚动、切换文档、编辑都会重建块的 DOM，
     *   每次重建都会把旧写法的块又渲染成裸 JSON。
     *   所以不能只在启动时扫一遍，必须盯着 DOM 变化补渲染。
     *
     * 用 MutationObserver 监听整棵 body，回调里做一次廉价的
     * querySelectorAll（块数量很少），再调 migrateLegacyEmbeds。
     * 用节流把连续的 DOM 变动合成一次，避免频繁触发深度遍历。
     */
    startLegacyEmbedWatch() {
      const run = () => {
        try { migrateLegacyEmbeds(this); } catch (e) { diag(`[legacy-embed] 失败: ${e && e.message}`); }
      };

      // ① 首次：等布局稳定后扫一遍
      setTimeout(run, 1200);
      setTimeout(run, 3000);

      // ② 之后：DOM 变化就补一次（节流 400ms）
      if (this._legacyTimer) return;
      let pending = false;
      const schedule = () => {
        if (pending) return;
        pending = true;
        this._legacyTimer = setTimeout(() => {
          pending = false;
          run();
        }, 400);
      };
      try {
        this._legacyObserver = new MutationObserver((muts) => {
          // 只关心「新增了自定义块」这类变化，避免无谓开销
          for (const m of muts) {
            if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) { schedule(); return; }
          }
        });
        this._legacyObserver.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        diag(`[legacy-embed] MutationObserver 不可用: ${e && e.message}`);
      }
    }

    /* ---------------------------------------------------------------------
     * 反引号围栏残留的升级（必须走内核 API）
     *
     * 背景：早期实现往笔记里插的是
     *     ```nebuladisk
     *     {"kind":"file",...}
     *     ```
     * 但反引号围栏在思源里**只生成普通代码块 type=c**，不是自定义块
     * （实测确认），所以这些块永远显示裸 JSON。
     *
     * 前端 DOM 无法把 type=c 变成 type=custom，唯一办法是**改块内容**。
     * 这里用 /api/block/updateBlock（dataType="dom"）提交正确的块 HTML，
     * 让内核负责把内容重新序列化成 `;;;插件名/块类型 … ;;;` 的 kramdown。
     *
     * 为什么提交 dom 而不是 markdown：
     *   updateBlock 的 dataType 只接受 "markdown" 或 "dom"。
     *   传 "markdown" 时，`;;;` 围栏是**块级语法**，会被当成普通段落处理，
     *   不会升级成自定义块；只有传真正的 NodeCustomBlock DOM 才行。
     *   data-info / data-content 由我们给出，内核会原样收下（已验证）。
     *
     * 安全性：
     *   · 只处理「语言串是本插件相关写法 且 内容是含 mount 的 JSON」的块
     *   · 每个块只升级一次（记在内存 Set 里，避免反复提交抖动）
     *   · 任何异常都吞掉只记日志 —— 自愈功能绝不能影响正常编辑
     * ------------------------------------------------------------------- */
    startLegacyFenceUpgrade() {
      if (this._fenceUpgraded) return;
      this._fenceUpgraded = new Set();

      const run = () => {
        let found;
        try { found = findLegacyFenceBlocks(this); } catch (e) { diag(`[legacy-fence] 扫描失败: ${e && e.message}`); return; }
        for (const hit of found) {
          if (this._fenceUpgraded.has(hit.id)) continue;
          this._fenceUpgraded.add(hit.id);
          this.upgradeFenceBlock(hit).catch((e) => diag(`[legacy-fence] 升级 ${hit.id} 失败: ${e && e.message}`));
        }

        // ★ 第三种残留形态：`;;;` 围栏整段留成了普通段落 ★
        //   见 src/embed.js 的注释：段落无法原地升级，只能删掉再按 markdown 重插。
        let paras;
        try { paras = findParagraphFences(this); } catch (e) { diag(`[legacy-fence] 段落扫描失败: ${e && e.message}`); return; }
        for (const hit of paras) {
          if (this._fenceUpgraded.has(hit.id)) continue;
          this._fenceUpgraded.add(hit.id);
          this.repairParagraphFence(hit).catch((e) => diag(`[legacy-fence] 段落修复 ${hit.id} 失败: ${e && e.message}`));
        }
      };

      // 文档渲染是异步的，多探几次
      setTimeout(run, 1500);
      setTimeout(run, 3500);
      setTimeout(run, 7000);

      // 切换文档也会带来新的残留块
      if (!this._fenceObserver) {
        let t = null;
        try {
          this._fenceObserver = new MutationObserver(() => {
            if (t) return;
            t = setTimeout(() => { t = null; run(); }, 800);
            this._fenceTimer = t;
          });
          this._fenceObserver.observe(document.body, { childList: true, subtree: true });
        } catch (e) {
          diag(`[legacy-fence] MutationObserver 不可用: ${e && e.message}`);
        }
      }
    }

    /**
     * 把一个「反引号围栏残留」的代码块升级成自定义块。
     * @param {{id:string, json:string}} hit
     */
    async upgradeFenceBlock(hit) {
      const info = `${this.name}/nebuladisk`;
      const esc = (s) => String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      // 与内核自己序列化出来的形状一致：
      //   <div data-node-id data-type="NodeCustomBlock" data-info data-content
      //        class="custom-block">
      //     <div class="custom-block__content"><pre>…</pre></div>
      //     <div class="protyle-attr" contenteditable="false">ZWSP</div>
      //   </div>
      const html =
        `<div data-node-id="${hit.id}" data-type="NodeCustomBlock"` +
        ` data-info="${esc(info)}" data-content="${esc(hit.json)}"` +
        ` class="custom-block">` +
        `<div class="custom-block__content"><pre>${esc(hit.json)}</pre></div>` +
        `<div class="protyle-attr" contenteditable="false">\u200b</div>` +
        `</div>`;

      const r = await fetch("/api/block/updateBlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id, dataType: "dom", data: html }),
      });
      const j = await r.json();
      if (j.code !== 0) throw new Error(j.msg || "updateBlock 返回非 0");
      diag(`[legacy-fence] 已把 ${hit.id} 从代码块升级为 NebulaDisk 嵌入块`);
    }

    /**
     * 修复「`;;;` 围栏整段留成普通段落」的块。
     *
     * ★ 为什么不能用 updateBlock ★
     *   实测 v3.8.4：给一个 type=p 的块传 NodeCustomBlock DOM，
     *   updateBlock 返回 code=0，但块类型**仍然是 p**（DOM 被当段落吸收了）。
     *   传 dataType="markdown" 也一样 —— `;;;` 不会在已有段落里重新解析。
     *
     * ⇒ 唯一可靠做法：**删掉这个段落，再按 markdown 插到同一位置**。
     *   插入用 dataType="markdown"，内核会正确生成 NodeCustomBlock
     *   （已实测：新建文档时 `;;;` 能生成 type=custom）。
     *
     * 位置保持：先记住它的 parentID 和 previousID，删除后插回原位。
     *
     * @param {{id:string, json:string, info:string}} hit
     */
    async repairParagraphFence(hit) {
      // ① 记下位置（父块 + 前一个兄弟），删除后才能插回原处
      const info = await fetch("/api/query/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stmt: `SELECT parent_id, id FROM blocks WHERE id='${hit.id}'`,
        }),
      }).then((r) => r.json()).catch(() => null);

      const parentId = info && info.data && info.data[0] && info.data[0].parent_id;
      if (!parentId) throw new Error("拿不到父块 id，放弃修复");

      // ★ 不要把「文档自身」当父块来插 ★
      //   实测：root_id 与 id 相同的块就是文档根（type=d）。
      //   往文档根 insertBlock 是允许的，但如果 parentId 来自过时索引、
      //   指向了一个已被删除的块，insertBlock 会静默失败或者插到别处。
      const rootCheck = await fetch("/api/query/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stmt: `SELECT id, type FROM blocks WHERE id='${parentId}'`,
        }),
      }).then((r) => r.json()).catch(() => null);
      if (!rootCheck || !rootCheck.data || !rootCheck.data[0]) {
        throw new Error("父块已不存在，放弃修复");
      }

      // 找同父块里、排在它前面的那个兄弟（用来定位插入点）
      const sib = await fetch("/api/query/sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stmt:
            `SELECT id FROM blocks WHERE parent_id='${parentId}' ` +
            `AND id < '${hit.id}' ORDER BY id DESC LIMIT 1`,
        }),
      }).then((r) => r.json()).catch(() => null);
      const prevId = sib && sib.data && sib.data[0] && sib.data[0].id;

      // ② 先解析参数 —— 解析失败就别删了，避免「删掉了旧的、又插不进新的」把内容弄丢
      let obj = null;
      try { obj = JSON.parse(hit.json); } catch { /* 下面报错 */ }
      if (!obj || !obj.mount) throw new Error("嵌入参数无法解析，放弃修复（原块保留）");

      // ③ 删掉这个段落块
      const del = await fetch("/api/block/deleteBlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      }).then((r) => r.json());
      if (del.code !== 0) throw new Error((del.msg || "deleteBlock 失败"));

      // ④ 用正确的 markdown（`;;;` 围栏）插回原位置
      //    ★ 内核的 insertBlock 会自己管理插入产生的空段落，
      //      但若 previousID 指向的兄弟也刚被删掉，内核可能把内容插到
      //      文档末尾并留下一个空段。所以插完要回查确认，失败就把内容补回去。
      const md = buildEmbedMarkdown(this.name, obj);
      const body = { dataType: "markdown", data: md, parentID: parentId };
      if (prevId) body.previousID = prevId;

      const ins = await fetch("/api/block/insertBlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (ins.code !== 0) {
        throw new Error((ins.msg || "insertBlock 失败") + "（原段落已删除，请注意）");
      }

      // ⑤ 回查：确认文档里真的多了一个 custom 块
      const newId =
        ins.data && ins.data[0] && ins.data[0].doOperations &&
        ins.data[0].doOperations[0] && ins.data[0].doOperations[0].id;
      if (newId) {
        let ok = false;
        for (let i = 0; i < 8; i++) {
          const chk = await fetch("/api/query/sql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stmt: `SELECT type FROM blocks WHERE id='${newId}'` }),
          }).then((r) => r.json()).catch(() => null);
          const t = chk && chk.data && chk.data[0] && chk.data[0].type;
          if (t) { ok = t === "custom"; break; }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!ok) {
          diag(`[legacy-fence] ⚠️ 段落 ${hit.id} 重建后未查到 custom 块（${newId}），请检查该文档`);
          return;
        }
        diag(`[legacy-fence] ✅ 已把段落 ${hit.id} 重建成 NebulaDisk 嵌入块（新块 ${newId}）`);
        return;
      }
      diag(`[legacy-fence] 已把段落 ${hit.id} 重建成 NebulaDisk 嵌入块（拿不到新块 id，未校验）`);
    }

    /**
     * 弹出一个「选择网盘文件/目录」的对话框，选完插入嵌入块
     *
     * @param {any} protyle 当前编辑器（斜杠菜单会给）
     * @param {"tree"|"file"} kind
     * @param {Element|null} [anchorEl] ★ 斜杠菜单交过来的「光标所在块元素」
     *
     *   ★★★ 这个第三参数是 2026-09-22 修「插入位置错」与「残留 /」的关键 ★★★
     *
     *   从思源 main.js 里读出的斜杠菜单契约（唯一可信来源）：
     *
     *     }else if(n.startsWith("plugin") && Em(D)){
     *         D.app.plugins.find(on=>{ ... cn.callback(D.getInstance(), ht), !0 });
     *         return;                    // ← 直接返回，**不**执行 He.deleteContents()
     *     }else{
     *         He.deleteContents(),       // ← 思源自带的斜杠项都会先删掉用户敲的 /xxx
     *         ...
     *     }
     *
     *   ⇒ 两个后果，都是插件必须自己承担的：
     *     1. 位置：真正该插到哪儿，得由插件的 locateInsertPoint 自己判断。
     *        只传 protyle 不够 —— 文档级 protyle.block.id === rootID，
     *        会被误当成「文档块」→ previousID 为空 → **追加到文末**（用户报的 bug）。
     *     2. 残留：`/网盘` 这串触发文本没人删，就留在段落里（用户报的 bug）。
     *
     *   ⇒ 把 `el`（= ht，带 data-node-id 的块元素）原样传下去，
     *     embed.js 用它做「精确锚点」并在插好后清理斜杠残留。
     */
    async pickAndEmbed(protyle, kind, anchorEl) {
      // ★★★ 不再「拿不到 protyle 就 return」★★★
      //
      //   2026-09-22 教训：三处插入点（斜杠菜单 / 侧边栏 / 预览页）原先**各自**
      //   在入口处判空并直接 return，导致 locateInsertPoint 的多级回退
      //   （聚焦页签 data-id / data-initdata / layout 遍历）永远没机会跑。
      //   用户明明开着文档，却被提示"请在文档编辑器中执行此操作"。
      //
      //   ⇒ 定位收敛到 embed.js：这里把 protyle 原样传下去（可以为 null）。
      //     斜杠菜单场景 protyle 通常有值，但它也可能是被思源复用过的旧实例，
      //     所以依旧以 locateInsertPoint 的实际探测结果为准。
      const picker = new Picker(this, kind, (result) => {
        // ★ 任务26b：onPick 现在可能拿到**数组**（多选批量）。
        //   旧调用方传单个对象，这里统一成数组，走同一条批量插入路径 ——
        //   单选就是「长度为 1 的批量」，不必维护两套代码。
        const specs = (Array.isArray(result) ? result : [result]).map((r) =>
          kind === "tree"
            ? { kind, mount: r.mount, path: r.path }
            : { kind, mount: r.mount, path: r.path, name: r.name }
        );
        // ★ 逐个按顺序插入 ⇒ 笔记里就是按用户排好的顺序，从上到下多个嵌入块 ★
        (async () => {
          let okCount = 0;
          let firstErr = null;
          for (const spec of specs) {
            try {
              const ok = await insertEmbedIntoDoc(this, protyle, spec, {
                anchorEl: anchorEl || null,
                fromSlash: !!anchorEl,
              });
              if (ok) okCount++;
              else firstErr = firstErr || "内核没有生成自定义块";
            } catch (e) {
              try {
                if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
              } catch { /* 忽略 */ }
              firstErr = firstErr || ((e && e.message) || "未知原因");
            }
          }
          if (specs.length === 1) {
            showMessage(okCount ? "已插入网盘嵌入块"
                                : `插入失败：${firstErr || "未知原因"}`);
          } else {
            showMessage(okCount === specs.length
              ? `已插入 ${okCount} 个网盘嵌入块`
              : `插入 ${okCount}/${specs.length} 个成功${firstErr ? "：" + firstErr : ""}`);
          }
        })();
        return;
      });
      await picker.open();
    }
  }

  /* -------------------------------------------------------------------------
   * 文件 / 目录选择器
   *
   * 复用 API.list 逐层下钻，最后确认选择。
   * ---------------------------------------------------------------------- */
  class Picker {
    constructor(plugin, kind, onPick) {
      this.plugin = plugin;
      this.kind = kind;
      this.onPick = onPick;
      this.mount = null;
      this.path = "";
      this.dialog = null;
      this.mounts = [];
      // ★ 任务24a：搜索状态 ★
      this.query = "";          // 当前关键词（空 = 浏览模式）
      this._searchToken = 0;    // 丢弃过期响应（与侧边栏同一套防竞态手法）
      this._searchTimer = null; // 防抖
      // ★ 任务26b：多选状态 ★
      //   _picked 是**有序**数组（顺序 = 用户排列顺序 = 插入到笔记的顺序）。
      //   用数组而不是 Set：Set 保不住顺序，而「上下拖动排序」正是本任务的要点。
      //   每项形如 { mount, path, name, size, ext }，path 是相对挂载根的完整路径。
      this._picked = [];
      // 用于 Shift 连选：记住上一次点击的行索引（在当前可见列表里的下标）
      this._lastIdx = -1;
      this._rows = [];          // 当前列表的可见行数据（供 Shift 连选 / 全选）
    }

    async open() {
      let me;
      try {
        await this.plugin.ensureLogin();
        me = await API.me();
      } catch (e) {
        showMessage(`无法连接网盘：${e.message}`, 6000, "error");
        return;
      }
      this.mounts = me.mounts || [];
      if (!this.mounts.length) {
        showMessage("没有可访问的网盘目录");
        return;
      }
      this.mount = this.plugin.settings.defaultMount && this.mounts.some(m => m.label === this.plugin.settings.defaultMount)
        ? this.plugin.settings.defaultMount
        : this.mounts[0].label;

      const wrap = document.createElement("div");
      wrap.className = "nb-picker";
      // ★ 任务24a：新增搜索栏（和侧边栏搜索同一套后端 /api/search）★
      //   用户原话：「插入文档树 / 插入文档 弹出窗口上增加搜索功能，
      //             和侧边窗口搜索功能一样。」
      //   ⇒ 同一个 API.search(mount, q, "", limit)、同样的防抖 + token 防竞态、
      //     同样的"含未展开子目录、层级最深也能搜到"。
      wrap.innerHTML = `
        <div class="nb-picker-head">
          <select class="b3-select nb-picker-mount"></select>
          <span class="nb-picker-path">/</span>
        </div>
        <div class="nb-picker-search">
          <input class="b3-text-field fn__block nb-picker-q" type="text"
                 placeholder="搜索全部文件（含未展开的子目录），支持 pdf、*.png、zip,rar" />
        </div>
        <div class="nb-picker-list fn__flex-1"></div>
        <div class="nb-picker-tray">
          <div class="nb-picker-trayhead">
            <span class="nb-picker-traytitle">已选 0 项（可上下拖动调整插入顺序）</span>
            <button class="b3-button b3-button--outline nb-picker-clear" title="清空已选">清空</button>
          </div>
          <div class="nb-picker-traybody"></div>
        </div>
        <div class="nb-picker-foot">
          <span class="nb-picker-hint"></span>
          <button class="b3-button b3-button--outline nb-picker-cancel">取消</button>
          <button class="b3-button b3-button--text nb-picker-ok">选择当前目录</button>
        </div>`;

      const sel = wrap.querySelector(".nb-picker-mount");
      for (const m of this.mounts) {
        const o = document.createElement("option");
        o.value = m.label;
        o.textContent = m.label;
        if (m.label === this.mount) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        this.mount = sel.value;
        this.path = "";
        // 换盘时清空搜索，回到浏览模式（否则会拿着旧盘的搜索结果看新盘）
        this.query = "";
        if (this.qInput) this.qInput.value = "";
        this.load();
      };

      wrap.querySelector(".nb-picker-cancel").onclick = () => this.dialog.destroy();
      wrap.querySelector(".nb-picker-ok").onclick = () => this.finish();
      wrap.querySelector(".nb-picker-clear").onclick = () => {
        this._picked = [];
        this._lastIdx = -1;
        this.syncTray();
        this.load();
      };

      // ★ 搜索框接线 ★
      this.qInput = wrap.querySelector(".nb-picker-q");
      this.qInput.oninput = () => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
          this.query = this.qInput.value.trim();
          this.load();
        }, 300);
      };
      this.qInput.onkeydown = (ev) => {
        // Esc：先清搜索（回到浏览），再按一次才关窗 —— 与侧边栏习惯一致
        if (ev.key === "Escape" && this.query) {
          ev.stopPropagation();
          this.qInput.value = "";
          this.query = "";
          this.load();
        } else if (ev.key === "Enter") {
          ev.preventDefault();
        }
      };

      this.listEl = wrap.querySelector(".nb-picker-list");
      this.pathEl = wrap.querySelector(".nb-picker-path");
      this.hintEl = wrap.querySelector(".nb-picker-hint");
      // ★ 任务26b：已选区 ★
      this.trayBodyEl = wrap.querySelector(".nb-picker-traybody");
      this.trayTitleEl = wrap.querySelector(".nb-picker-traytitle");
      this._okBtn = wrap.querySelector(".nb-picker-ok");

      /*
       * ★★★ #64：对话框尺寸收窄 ★★★
       *
       *   用户原话：「插入嵌入块时，弹出的『选择要嵌入的文件』，
       *             每个文件太高了，而且宽度很长。」
       *
       *   行高在 index.css 的 .nb-picker-row 里压（30px → 24px）。
       *   这里管**宽度**：640px 对一个「盘名 + 路径 + 一列文件名 + 大小」
       *   的选择器来说偏宽 —— 文件名根本用不到那么长，反而让对话框在
       *   窄屏（或思源侧边栏并排时）显得很霸道。
       *   ⇒ 收到 520px：仍能容下「盘名下拉 160px + 路径」，
       *     长文件名照旧走 ellipsis，不影响信息量。
       *
       *   高度同时略降（560 → 500）：因为行变矮了，同样的文件数占用更少高度，
       *   整体看着更紧凑；列表本身是 flex-1 + overflow，少 60px 不影响可浏览性。
       */
      this.dialog = new Dialog({
        title: this.kind === "tree" ? "选择要嵌入的目录" : "选择要嵌入的文件",
        content: `<div class="b3-dialog__content nb-dialog-content"></div>`,
        width: "520px",
        height: "500px",
      });
      this.dialog.element.querySelector(".nb-dialog-content").appendChild(wrap);

      await this.load();
    }

    /**
     * 加载列表。
     *   · query 为空 ⇒ 浏览模式：API.list(mount, path)（和以前完全一样）
     *   · query 非空 ⇒ 搜索模式：API.search(mount, q, "", 500)（后端递归）
     *
     * ★ 任务24a ★ 搜索模式下不显示".. 上一级"和面包屑的层级含义会变淡，
     *   所以路径栏改成显示"搜索：关键词"。
     */
    async load() {
      // ★ 任务26b：每次重渲染都要重置可见行索引（Shift 连选依赖它）★
      this._rows = [];
      // ---- 搜索模式 ----
      if (this.query) {
        const token = (this._searchToken || 0) + 1;
        this._searchToken = token;
        this.listEl.innerHTML = `<div class="nb-picker-loading">搜索中…</div>`;
        this.pathEl.textContent = `搜索：${this.query}`;

        let r;
        try {
          r = await API.search(this.mount, this.query, "", 500);
        } catch (e) {
          if (token !== this._searchToken) return;
          this.listEl.innerHTML = `<div class="nb-picker-error">搜索失败：${(e && e.message) || e}</div>`;
          return;
        }
        if (token !== this._searchToken) return;   // 过期响应，丢弃
        this.renderSearch(r);
        return;
      }

      // ---- 浏览模式（原逻辑）----
      this._searchToken = (this._searchToken || 0) + 1;  // 作废在途搜索响应
      this.listEl.innerHTML = `<div class="nb-picker-loading">加载中…</div>`;
      let data;
      try {
        data = await API.list(this.mount, this.path);
      } catch (e) {
        this.listEl.innerHTML = `<div class="nb-picker-error">${e.message}</div>`;
        return;
      }
      this.path = data.path === "/" ? "" : (data.path || "").replace(/^\//, "");
      this.pathEl.textContent = "/" + this.path;

      const entries = data.entries || [];
      this.listEl.innerHTML = "";

      // 上级目录
      if (this.path) {
        const up = document.createElement("div");
        up.className = "nb-picker-row nb-picker-up";
        up.innerHTML = `<span class="nb-picker-ico">↰</span><span class="nb-picker-name">.. 上一级</span>`;
        up.onclick = () => {
          const i = this.path.lastIndexOf("/");
          this.path = i < 0 ? "" : this.path.slice(0, i);
          this.load();
        };
        this.listEl.appendChild(up);
      }

      if (!entries.length) {
        this.listEl.innerHTML = `<div class="nb-picker-loading">此文件夹为空</div>`;
      }

      for (const e of entries) {
        this.listEl.appendChild(this.makeRow(e, e.name));
      }

      this.hintEl.textContent = this.kind === "tree"
        ? `将嵌入目录：${displayMountPath(this.mount, this.path)}`
        : (this._picked.length
            ? `已选 ${this._picked.length} 项，点「插入」写入笔记`
            : "单击文件选入（Ctrl 多选 / Shift 连选），双击直接插入");
      // ★ 任务26b：列表重绘后同步「已选」区与确定按钮文案 ★
      this.syncTray();
    }

    /** 搜索模式的结果列表（任务24a）—— 与侧边栏结果面板同源数据 */
    renderSearch(r) {
      const hits = (r && r.hits) || [];
      this.listEl.innerHTML = "";

      const head = document.createElement("div");
      head.className = "nb-picker-shead";
      // ★ 任务24b ★ 后端现在会给真实命中总数 total（与 limit 无关）。
      //   原来这里只写 `${hits.length} 个结果`，页面上限 500 时会显示「500 个结果」，
      //   用户以为「就这么多」，其实是「只给你看了 500 个」。
      //   现在优先显示 `已显示 / 总数`。
      const shown = hits.length;
      const total = (r && typeof r.total === "number") ? r.total : null;
      let msg = `${shown} 个结果`;
      if (total !== null && total > shown) msg = `${shown} / ${total} 个结果`;
      if (r && r.scanned) msg += ` · 扫描 ${r.scanned} 项`;
      head.textContent = msg;
      this.listEl.appendChild(head);

      // ★ 提示语也必须基于 total 判断「是否真的还有更多」★
      //   以前用 hits.length 拼「结果超过 500 条已截断」，在 total=4526 时
      //   语义勉强对；但 total<=limit 时也会误报。现在只在确实有下一页时提示。
      const more = !!(r && (r.hasMore || (total !== null && total > shown)));
      if (more || (r && r.depthCapped)) {
        const warn = document.createElement("div");
        warn.className = "nb-picker-swarn";
        const bits = [];
        if (more) {
          bits.push(total !== null
            ? `共 ${total} 条，当前最多显示 ${shown} 条`
            : `结果超过 ${shown} 条`);
          bits.push("缩小关键词可看到其余结果");
        }
        if (r && r.depthCapped) bits.push("目录过深/过多，未全部扫描");
        warn.textContent = "⚠ " + bits.join("；");
        this.listEl.appendChild(warn);
      }

      if (!hits.length) {
        const empty = document.createElement("div");
        empty.className = "nb-picker-loading";
        empty.textContent = "没有匹配的文件";
        this.listEl.appendChild(empty);
        this.hintEl.textContent = `搜索「${this.query}」无结果`;
        return;
      }

      for (const e of hits) {
        // 搜索结果跨层级 ⇒ 副标题显示所在目录，用户才知道选的是哪一个
        const dir = String(e.path || "").replace(/\/[^/]*$/, "");
        this.listEl.appendChild(this.makeRow(e, e.name, dir || "/"));
      }
      this.hintEl.textContent = this.kind === "tree"
        ? `搜索「${this.query}」：双击目录进入，或用下方按钮选择当前目录`
        : `搜索「${this.query}」：单击选入，Ctrl 多选 / Shift 连选`;
      // ★ 任务26b：搜索结果重绘后同样要同步「已选」区 ★
      this.syncTray();
    }

    /** 一行（浏览 / 搜索共用）。sub = 副标题（搜索结果用来显示所在路径） */
    makeRow(e, label, sub) {
      const row = document.createElement("div");
      row.className = "nb-picker-row";
      // ★ 任务25b ★ 原来这里是 emoji（📁 / 📄），和侧边栏/网格的彩色类型图标
      //   完全两套视觉，用户明确要求「文件夹和文件图标需要调整一下」。
      //   ⇒ 统一走 typeIconEl()：目录拿真正的文件夹图标，文件按扩展名拿
      //     彩色徽标（PDF 红、3D 青、SRC 灰蓝…），与侧边栏一致。
      row.innerHTML = `<span class="nb-picker-ico"></span>
                       <span class="nb-picker-name"></span>
                       <span class="nb-picker-size"></span>`;
      try {
        row.querySelector(".nb-picker-ico").appendChild(
          typeIconEl(e.ext || extOf(e.name), !!e.isDir)
        );
      } catch { /* 图标失败不影响选择功能 */ }
      const nameEl = row.querySelector(".nb-picker-name");
      nameEl.textContent = label;
      if (sub) {
        const sub2 = document.createElement("span");
        sub2.className = "nb-picker-sub";
        sub2.textContent = sub;
        nameEl.appendChild(sub2);
        nameEl.title = displayMountPath(this.mount, e.path || "");
      }
      row.querySelector(".nb-picker-size").textContent = e.isDir ? "" : humanSize(e.size);

      if (e.isDir) {
        // 目录：单击进入（搜索结果里的目录也允许进去，语义一致）
        row.onclick = () => {
          if (this.query) {
            // 从搜索结果进入目录 ⇒ 退出搜索，定位到该目录浏览
            this.path = String(e.path || "").replace(/^\//, "");
            this.qInput.value = "";
            this.query = "";
          } else {
            this.path = this.path ? `${this.path}/${e.name}` : e.name;
          }
          this.load();
        };
      } else if (this.kind === "file") {
        // ★ 任务26b：文件行支持多选 ★
        //   · 单击      ⇒ 只选这一个（清掉其他），与旧行为兼容
        //   · Ctrl+单击 ⇒ 切换该行选中状态（追加 / 移除）
        //   · Shift+单击⇒ 从上次点击位置连选到当前行
        //   · 双击      ⇒ 直接确认（单选快速通道）
        const key = this._keyOf(e);
        const idx = this._rows.length;
        this._rows.push({ e, key });
        row.dataset.nbKey = key;
        if (this._picked.some((p) => p.key === key)) row.classList.add("is-picked");

        row.onclick = (ev) => {
          if (ev.ctrlKey || ev.metaKey) {
            this._togglePick(e, idx);
          } else if (ev.shiftKey && this._lastIdx >= 0) {
            const a = Math.min(this._lastIdx, idx);
            const b = Math.max(this._lastIdx, idx);
            for (let i = a; i <= b; i++) {
              const it = this._rows[i];
              if (it && !this._picked.some((p) => p.key === it.key)) {
                this._picked.push(this._specOf(it.e, it.key));
              }
            }
          } else {
            this._picked = [this._specOf(e, key)];
          }
          this._lastIdx = idx;
          this.syncTray();
          this.refreshPickedMarks();
        };
        row.ondblclick = (ev) => {
          ev.preventDefault();
          this._picked = [this._specOf(e, key)];
          this.finish();
        };
      } else {
        // kind === "tree"：只要目录，文件置灰不可选
        row.classList.add("is-disabled");
      }
      return row;
    }

    /** 唯一键：mount + 完整路径（跨挂载/跨目录都不冲突） */
    _keyOf(e) {
      const p = e.path
        ? String(e.path).replace(/^\//, "")
        : (this.path ? `${this.path}/${e.name}` : e.name);
      return displayMountPath(this.mount, p);
    }

    /** 把 entry 变成已选条目（含 key，供排序/去重） */
    _specOf(e, key) {
      const p = e.path
        ? String(e.path).replace(/^\//, "")
        : (this.path ? `${this.path}/${e.name}` : e.name);
      return {
        key: key || displayMountPath(this.mount, p),
        mount: this.mount,
        path: p,
        name: e.name,
        size: e.size,
        ext: e.ext || extOf(e.name),
      };
    }

    /** Ctrl 点击：切换单个 */
    _togglePick(e, idx) {
      const key = this._keyOf(e);
      const at = this._picked.findIndex((p) => p.key === key);
      if (at >= 0) this._picked.splice(at, 1);
      else this._picked.push(this._specOf(e, key));
      this._lastIdx = idx;
      this.syncTray();
      this.refreshPickedMarks();
    }

    /** 让列表行上的「已选」高亮与 _picked 保持一致 */
    refreshPickedMarks() {
      const set = new Set(this._picked.map((p) => p.key));
      this.listEl.querySelectorAll(".nb-picker-row").forEach((row) => {
        const k = row.dataset.nbKey;
        if (k) row.classList.toggle("is-picked", set.has(k));
      });
    }

    /**
     * ★ 任务26b：渲染「已选」区，并支持上下拖动排序 ★
     *
     *  顺序就是插入顺序 ⇒ 渲染成竖向列表，每项可拖。
     *  拖动用 HTML5 DnD（draggable + dragover 重排），
     *  在 dragover 时就地重排数组，视觉与数据同时更新，
     *  松手（dragend）不用再做二次同步 —— 少一个状态就少一类 bug。
     */
    syncTray() {
      if (!this.trayBodyEl) return;
      const n = this._picked.length;
      this.trayTitleEl.textContent = `已选 ${n} 项（可上下拖动调整插入顺序）`;
      this.trayBodyEl.innerHTML = "";

      if (!n) {
        const empty = document.createElement("div");
        empty.className = "nb-picker-trayempty";
        empty.textContent = this.kind === "file"
          ? "在上方列表里单击文件即可选入；Ctrl 点击可多选，Shift 点击连选"
          : "（目录模式不需要多选）";
        this.trayBodyEl.appendChild(empty);
        this._updateOkLabel();
        return;
      }

      this._picked.forEach((p, i) => {
        const it = document.createElement("div");
        it.className = "nb-picker-chip";
        it.draggable = true;
        it.dataset.idx = String(i);
        it.innerHTML = `<span class="nb-picker-grip" title="拖动调整顺序">⠿</span>
                        <span class="nb-picker-chipname"></span>
                        <span class="nb-picker-chipbtns">
                          <button class="b3-button b3-button--outline nb-up" title="上移">↑</button>
                          <button class="b3-button b3-button--outline nb-down" title="下移">↓</button>
                          <button class="b3-button b3-button--outline nb-del" title="移除">✕</button>
                        </span>`;
        it.querySelector(".nb-picker-chipname").textContent = `${i + 1}. ${p.name}`;
        it.querySelector(".nb-up").onclick = (ev) => { ev.stopPropagation(); this._movePick(i, -1); };
        it.querySelector(".nb-down").onclick = (ev) => { ev.stopPropagation(); this._movePick(i, 1); };
        it.querySelector(".nb-del").onclick = (ev) => {
          ev.stopPropagation();
          this._picked.splice(i, 1);
          this.syncTray();
          this.refreshPickedMarks();
        };

        // ---- HTML5 拖动排序 ----
        it.ondragstart = (ev) => {
          this._dragFrom = i;
          it.classList.add("is-dragging");
          try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(i)); } catch { /* 忽略 */ }
        };
        it.ondragend = () => {
          it.classList.remove("is-dragging");
          this._dragFrom = -1;
        };
        it.ondragover = (ev) => {
          ev.preventDefault();
          const from = this._dragFrom;
          if (from < 0 || from === i) return;
          // 就地重排：把 from 项移到 i 的位置
          const [moved] = this._picked.splice(from, 1);
          this._picked.splice(i, 0, moved);
          this._dragFrom = i;
          this.syncTray();
        };
        it.ondrop = (ev) => ev.preventDefault();

        this.trayBodyEl.appendChild(it);
      });
      this._updateOkLabel();
    }

    /** 上/下移一位 */
    _movePick(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= this._picked.length) return;
      const [m] = this._picked.splice(i, 1);
      this._picked.splice(j, 0, m);
      this.syncTray();
      this.refreshPickedMarks();
    }

    /** 确定按钮的动态文案 */
    _updateOkLabel() {
      if (!this._okBtn) return;
      const n = this._picked.length;
      if (this.kind === "tree") {
        this._okBtn.textContent = "选择当前目录";
      } else {
        this._okBtn.textContent = n > 1 ? `插入这 ${n} 个` : "插入";
      }
      // ★ 底部提示也要跟着已选数量走 ★
      //   踩过的坑：只在 load()/renderSearch() 里写 hint ⇒ 用户点选/取消选择时
      //   提示语不更新，看着像"没反应"。既然这里知道 n，就顺手一起刷新。
      //   注意浏览/搜索两种模式的措辞不同，用 this.query 区分。
      if (this.hintEl) {
        if (this.kind === "tree") {
          // 目录模式：hint 由 load()/renderSearch() 维护，别覆盖
        } else if (n) {
          this.hintEl.textContent = `已选 ${n} 项，点「插入」写入笔记`;
        } else if (this.query) {
          this.hintEl.textContent = `搜索「${this.query}」：单击选入，Ctrl 多选 / Shift 连选`;
        } else {
          this.hintEl.textContent = "单击文件选入（Ctrl 多选 / Shift 连选），双击直接插入";
        }
      }
    }

    finish(entry) {
      if (this.kind === "file") {
        // ★ 任务26b：优先用「已选」区的内容（有序、可多选）★
        //   entry 只在「双击直接确认」这条快速通道里传进来。
        let list = this._picked;
        if (entry) {
          const p = entry.path
            ? String(entry.path).replace(/^\//, "")
            : (this.path ? `${this.path}/${entry.name}` : entry.name);
          list = [{ mount: this.mount, path: p, name: entry.name }];
        }
        if (!list.length) {
          showMessage("请先选择至少一个文件");
          return;
        }
        // 多选 ⇒ 传数组；单选 ⇒ 也传数组（上层统一成批量，单选即长度 1）
        this.onPick(list.map((p) => ({ mount: p.mount, path: p.path, name: p.name })));
      } else {
        this.onPick({ mount: this.mount, path: this.path });
      }
      this.dialog.destroy();
    }
  }

  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }
  return {
    __cjs: false,
    default: NebulaDiskPlugin,
  };
})();

/* ---- 思源的加载契约：module.exports 必须直接是插件类 ---- */
module.exports = __mod_index.default;
module.exports.default = __mod_index.default;
/* 顺带暴露常量，便于外部/测试引用（不影响思源加载） */

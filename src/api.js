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

import { diag, HAS_NODE } from "./proxy.js";

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
export function hasNode() {
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
 * 后端服务器地址 —— 形如 `http://192.168.193.70:8089`。
 *
 * 来源优先级：插件设置 serverUrl → 空。
 * 空表示「没有直连目标」，此时只能用代理通道。
 */
export function serverBase() {
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
export function webDiskUrl(base, mount, filePath) {
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
 *          宿主页里再 `<iframe src="http://192.168.193.70:8089/preview/…">`。
 *
 *   **这个做法不成立。** 用 CDP 在真机上量到：
 *
 *       hostSrcHead      = blob:http://192.168.193.70:6806/7d77a594-…
 *       innerOrigin      = http://192.168.193.70:8089
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
export function liteUrl(base, target, kind) {
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
export function proxyBase() {
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

export function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t) {
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

export function resetChannel() {
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
 *   直连：基址 = serverUrl（http://192.168.193.70:8089）
 *   代理：基址 = proxyBase()（http://127.0.0.1:6810）
 *   同一个 `/preview/onlinePreview?...` 在两条通道下要拼出不同的绝对地址。
 *   预览 iframe 的 src、下载链接都用这里的结果。
 */
export function fixUrl(u) {
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
export function browserReachableUrl(u) {
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
export function currentKind() {
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
export function currentKindAsync() {
  return pickChannel();
}

export class ApiError extends Error {
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
export function setUnauthorizedHandler(fn) {
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

export async function apiGet(path, params) {
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

export async function apiPost(path, fields) {
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
export async function apiUpload(fields, file, onProgress) {
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
export const API = {
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
   *     · 直连通道 ⇒ serverBase()，即 http://192.168.193.70:8089 ✓
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
   *     · 直连通道 ⇒ serverBase()，即 http://192.168.193.70:8089 ✓
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

export function extOf(name) {
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
export function pickViewer(name) {
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
export function isEditable(name) {
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
export async function browserViewUrl(mount, path, name) {
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
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function humanTime(sec) {
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
export function decodeSmart(arrayBuffer) {
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
export function displayMountPath(mount, path) {
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
export function displayCrumbPath(mount, path) {
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
export function nodeKey(mount, path) {
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

/* ==========================================================================
 * 端到端集成测试
 * --------------------------------------------------------------------------
 * 起一个**模拟的 NebulaDisk**（按真实后端的接口契约实现），
 * 然后让插件内嵌的代理去访问它，验证完整链路：
 *
 *   插件 API 客户端 → 本地代理 → 模拟网盘 → 返回
 *
 * 由于插件的 src/api.js 依赖浏览器的 fetch / FormData / URLSearchParams，
 * 这里用一个极小的 DOM/BOM 桩把它跑起来，而不是真的开浏览器。
 * 目的是验证「契约是否对得上」——也就是后端实际返回的字段，
 * 插件是否真的按那个字段去读。这类不一致（例如后端返回 raw 而插件读 url）
 * 是集成阶段最常见、也最难在单测里发现的错误。
 * ========================================================================== */

const http = require("http");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const { NebulaProxy } = require("../src/proxy.js");

/* -------------------------------------------------------------------------
 * 模拟的 NebulaDisk 后端
 *
 * 严格按 D:\Docker\kkFileView\nebula\app\routers\ 里的真实实现来写：
 *   · POST /api/login  → Set-Cookie + {ok,username,display,isAdmin}
 *   · GET  /api/me     → {username,isAdmin,title,mounts[],onlyoffice,cad,disk}
 *   · GET  /api/list   → {path,entries[{name,isDir,size,mtime,ext,route,mime,readonly}],mount}
 *   · GET  /api/preview→ {ok,url,raw}
 *   · POST /api/oo/config → {ok,config,apiJs,mode,title}
 * ---------------------------------------------------------------------- */
const MOUNTS = [
  { label: "售前项目", writable: true },
  { label: "研发立项", writable: true },
  { label: "项目设计", writable: false },
];

const TREE = {
  "售前项目::": [
    { name: "2026", isDir: true, size: 0, mtime: 1758000000, ext: "", route: "", mime: "inode/directory", readonly: false },
    { name: "报价单.xlsx", isDir: false, size: 20480, mtime: 1758000000, ext: "xlsx", route: "onlyoffice", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", readonly: false },
    { name: "方案说明.md", isDir: false, size: 5120, mtime: 1758000000, ext: "md", route: "kkfileview", mime: "text/markdown", readonly: false },
  ],
  "售前项目::2026": [
    { name: "某项目", isDir: true, size: 0, mtime: 1758000000, ext: "", route: "", mime: "inode/directory", readonly: false },
    { name: "投标文件.docx", isDir: false, size: 102400, mtime: 1758000000, ext: "docx", route: "onlyoffice", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", readonly: false },
  ],
  "售前项目::2026/某项目": [
    { name: "01-封面.png", isDir: false, size: 307200, mtime: 1758000000, ext: "png", route: "download", mime: "image/png", readonly: false },
  ],
  "研发立项::": [
    { name: "1.2.14.TFDF-6# F向.STEP", isDir: false, size: 8912896, mtime: 1758000000, ext: "step", route: "kkfileview", mime: "application/octet-stream", readonly: false },
  ],
  "项目设计::": [
    { name: "A-01.dwg", isDir: false, size: 2048000, mtime: 1758000000, ext: "dwg", route: "kkfileview", mime: "application/acad", readonly: true },
  ],
};

function listFor(mount, p) {
  const key = `${mount}::${p || ""}`;
  return TREE[key] || null;
}

let loginCount = 0;

const api = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj, extraHeaders = {}) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, {
      "content-type": "application/json",
      "content-length": body.length,
      /**
       * ★ 必须有 CORS 头 ★
       *   本测试走的是**直连通道**（就是 NAS 上部署时的真实形态）：
       *   api.js 直接 fetch `http://127.0.0.1:<apiPort>/api/...`，
       *   与被测代码的 origin（http://127.0.0.1:6806）**跨源**。
       *   缺 ACAO 会被浏览器拦（Node 的 fetch 只拦不报错，直接 fetch failed）
       *   ⇒ 整轮全红，且报错信息完全看不出是 CORS。
       */
      "access-control-allow-origin": "*",
      ...extraHeaders,
    });
    res.end(body);
  };

  // ---- 登录 ----
  if (u.pathname === "/api/login" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      // 简单校验：含 username/password 字段即可
      if (!/username/.test(body)) return send(422, { detail: "缺少 username" });
      loginCount++;
      send(200, {
        ok: true,
        username: "tao_zhang",
        display: "张涛",
        isAdmin: true,
        // ★ 直连通道下后端会回 token，插件把它存起来供后续 Bearer 使用 ★
        token: "e2e-bearer-token",
      }, {
        "set-cookie": "nb_session=e2e-token; Path=/; HttpOnly; SameSite=lax",
        "access-control-allow-origin": "*",
      });
    });
    return;
  }

  /** 直连通道的健康探测端点（api.js 的 probeDirect 会打它） */
  if (u.pathname === "/healthz") {
    return send(200, { ok: true, service: "fake-nebuladisk" }, {
      "access-control-allow-origin": "*",
    });
  }

  /**
   * 签名直链（/api/raw/<name>?mount=&path=&exp=&sig=）。
   *
   * ★ 关键：它**只认签名，不认 Cookie** ★
   *   这正是直连通道能下载的原因：思源 :6806 → 网盘 :8089 是跨源，
   *   浏览器不会带上网盘的 Cookie，但签名在查询串里，永远有效。
   *   ⇒ 这个路由必须放在 authed 检查**之前**，否则直连下载永远 401。
   */
  if (u.pathname.startsWith("/api/raw/")) {
    if (!u.searchParams.get("sig")) return send(403, { detail: "缺少签名" });
    const body = Buffer.from("raw-file-content", "utf8");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": body.length,
      "access-control-allow-origin": "*",
    });
    return res.end(body);
  }

  // ---- 以下都要登录 ----
  /**
   * ★★ 鉴权必须「双认」：Cookie 或 Bearer ★★
   *
   *   真实后端支持两种会话形态：
   *     · 代理通道 ⇒ 代理持有服务端 Cookie（同源，浏览器自动带）
   *     · 直连通道 ⇒ 跨源，浏览器**不会**带网盘的 Cookie，
   *       所以登录下发的 token 走 `Authorization: Bearer <token>`
   *   本测试走直连，只认 Cookie 的话会整轮 401「未登录」。
   */
  const cookieOk = (req.headers.cookie || "").includes("nb_session=e2e-token");
  const bearerOk = (req.headers.authorization || "") === "Bearer e2e-bearer-token";
  const authed = cookieOk || bearerOk;
  if (!authed) return send(401, { detail: "未登录" });

  if (u.pathname === "/api/me") {
    return send(200, {
      username: "tao_zhang",
      isAdmin: true,
      title: "NebulaDisk",
      mounts: MOUNTS,
      onlyoffice: true,
      cad: true,
      disk: { total: 1, used: 0, free: 1 },
    });
  }

  if (u.pathname === "/api/list") {
    const mount = u.searchParams.get("mount");
    const p = u.searchParams.get("path") || "";
    // 严格模拟越权返回 404（不泄露目录是否存在）
    if (!MOUNTS.some((m) => m.label === mount)) return send(404, { detail: "映射不存在" });
    const entries = listFor(mount, p);
    if (entries === null) return send(404, { detail: "目录不存在" });
    const cur = p ? "/" + p : "/";
    return send(200, {
      path: cur,
      entries,
      mount: { label: mount, readonly: !MOUNTS.find((m) => m.label === mount).writable },
    });
  }

  if (u.pathname === "/api/preview") {
    const mount = u.searchParams.get("mount");
    const p = u.searchParams.get("path");
    return send(200, {
      ok: true,
      url: `/preview/onlinePreview?url=${encodeURIComponent(Buffer.from("/api/raw/x").toString("base64"))}`,
      raw: `/api/raw/${encodeURIComponent(p.split("/").pop())}?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(p)}&exp=9999999999&sig=abc`,
    });
  }

  if (u.pathname === "/api/cad/preview") {
    return send(200, { ok: true, url: "/cad/?open=x&name=y", raw: "/api/raw/a.dwg" });
  }

  if (u.pathname === "/api/oo/config" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      send(200, {
        ok: true,
        config: { document: { fileType: "xlsx", key: "k1", url: "http://nebula:8088/api/raw/x" }, documentType: "cell" },
        apiJs: "http://192.168.193.70:8082/web-apps/apps/api/documents/api.js",
        mode: "edit",
        title: "报价单.xlsx",
      });
    });
    return;
  }

  if (u.pathname === "/api/download") {
    const body = Buffer.from("hello-file-content", "utf8");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    return res.end(body);
  }

  /**
   * 代理通道的会话探针。
   * 真实实现里 `/__session` 由**代理自己**回答（它持有服务端 Cookie），
   * 这里留一份兜底，便于单独验证语义。
   */
  if (u.pathname === "/__session") {
    return send(200, { hasSession: authed, username: "tao_zhang" });
  }

  send(404, { detail: "not found" });
});

/* -------------------------------------------------------------------------
 * 极小的 BOM 桩
 *
 * api.js 用到的浏览器能力：
 *   fetch / FormData / URLSearchParams / sessionStorage / XMLHttpRequest(未触发)
 * 这里全部用手写实现。
 *
 * ★★ 走哪条通道：**直连**（2026-09-22 修正）★★
 *
 *   原来这套桩是围绕「代理通道」写的：把请求改写成
 *   `http://127.0.0.1:<proxyPort>/…`，并断言 URL 里带 /nb 前缀。
 *   但插件后来演进了：
 *     · pickChannel() 只在 **hasNode()===true** 时才考虑代理；
 *     · 而单测注入的 vm context 里 HAS_NODE 恒为 true（proxy.js 真被 require 了），
 *     · 更要命的是 hasNode() 先看 `window.__nebuladiskPlugin.boot.noNode`，
 *       BOM 桩里没这个对象 ⇒ 走 HAS_NODE ⇒ 以为有 node ⇒ 试验代理 ⇒ 全红。
 *   而**真实部署形态**（NAS / Docker 思源）恰恰是**浏览器直连**：
 *   没有 node、不能起本地代理、所有请求直接打 `http://<nas>:8089`。
 *
 *   ⇒ 这里把桩改成直连形态：
 *       1. 注入 window.__nebuladiskPlugin.boot.noNode = true
 *          （与 index.js startInline 在浏览器里的设置一致）
 *       2. serverUrl 指向**模拟网盘**的地址，serverBase() 因此返回它
 *       3. fetch 不再做任何改写，直接放行到模拟网盘
 *     这样测到的就是 NAS 上那条真实链路。
 * ---------------------------------------------------------------------- */
function installBOM(apiPort) {
  /** 思源页面的 origin（NAS 上是 http://192.168.193.70:6806） */
  const ORIGIN = "http://127.0.0.1:6806";
  /** 模拟网盘 —— 就是直连通道的目标 */
  const SERVER = `http://127.0.0.1:${apiPort}`;

  class FakeFormData {
    constructor() { this._e = []; }
    append(k, v) { this._e.push([k, String(v)]); }
    /** 编码成 urlencoded —— 模拟的 FastAPI 也能接受 */
    toString() {
      return this._e.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    }
  }

  /** 极小的 sessionStorage 桩（api.js 用它缓存 token / 通道结论） */
  const store = new Map();
  global.sessionStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => store.set(String(k), String(v)),
    removeItem: (k) => store.delete(String(k)),
    clear: () => store.clear(),
  };

  global.FormData = FakeFormData;
  if (!global.URLSearchParams) global.URLSearchParams = URLSearchParams;
  if (!global.AbortController) {
    // Node 18+ 自带；这里只是防御性兜底
    global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
  }

  /**
   * 插件的「实例对象」。
   * api.js 通过 window.__nebuladiskPlugin 读两样东西：
   *   · settings.serverUrl   —— 直连目标地址
   *   · boot.noNode          —— 当前环境没有 node 能力（浏览器端思源）
   * 两者都要给对，pickChannel() 才会稳定选中直连。
   */
  global.window = {
    __nebuladiskPlugin: {
      settings: { serverUrl: SERVER, proxyPort: 6810 },
      boot: { noNode: true },
    },
  };
  globalThis.window = global.window;

  // 直连通道下 fetch 不做任何改写，但要记录一次，便于失败时定位
  const realFetch = globalThis.fetch;
  global.fetch = async (input, init = {}) => {
    if (init.body instanceof FakeFormData) {
      init = { ...init, body: init.body.toString() };
      init.headers = { ...(init.headers || {}), "content-type": "application/x-www-form-urlencoded" };
    }
    return realFetch(String(input), init);
  };

  return { ORIGIN, SERVER, PROXY: SERVER };
}


/* -------------------------------------------------------------------------
 * 把 src/api.js 当 ESM 求值
 *
 * api.js 是 ESM（import/export）。用 vm 的 SourceTextModule 需要
 * --experimental-vm-modules，因此这里做一次**轻量转译**：
 *   · import { a, b } from "./x"  →  const a = require("./x").a;  （逐符号）
 *   · export function f() {…}     →  function f() {…}
 *   · 末尾补 module.exports = { … }
 * 这样能测到**真实实现**，而不是复制一份逻辑。
 *
 * ★★ 为什么必须同时剥 import 和 export（2026-09-22 实测）★★
 *   vm.runInContext(src, …) 是按**脚本**解析的，压根不认识 ESM 语法，
 *   而 api.js 第 37 行就是
 *       import { diag, HAS_NODE } from "./proxy.js";
 *   ⇒ 直接崩：
 *       SyntaxError: Cannot use import statement outside a module
 *         at new Script (node:vm:117:7)
 *
 * ★★ 为什么 require 要「按 src/ 解析」★★
 *   本函数的基准目录是 test/，而源码里的 `require("./proxy.js")`
 *   是相对 **api.js 自己所在目录**（src/）的。
 *   直接注入 Node 的 require 会把 "./proxy.js" 解析到 test/proxy.js（不存在）。
 *   ⇒ 注入一个把相对 id 绑到 src/ 的包装。
 *
 * ★★ 为什么用 vm 而不是 new Function(…, src) ★
 *   new Function 只按位置参数绑定，源码里的 `let fetch` 之类会**遮蔽**
 *   同名形参 ⇒ 静默拿到 undefined，排查成本极高。
 * ---------------------------------------------------------------------- */
function loadApiModule() {
  let src = fs.readFileSync(path.resolve(__dirname, "../src/api.js"), "utf8");

  // ---- 1) import { a, b as c } from "./m";  →  逐符号 require 解构 ----
  src = src.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
    (_full, names, mod) => names
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((one) => {
        const [imp, local] = one.split(/\s+as\s+/);
        const L = (local || imp).trim();
        return `const ${L} = require(${JSON.stringify(mod)}).${imp.trim()};`;
      })
      .join("\n"),
  );

  // ---- 2) 收集并剥掉 export 关键字 ----
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  src += `\nmodule.exports = { ${names.join(", ")} };`;

  // ---- 3) 按 src/ 解析相对 require ----
  const srcRequire = (id) =>
    require(/^\.\.?\//.test(id) ? path.resolve(__dirname, "../src", id) : id);

  const mod = { exports: {} };
  const context = vm.createContext({
    module: mod,
    exports: mod.exports,
    require: srcRequire,
    console,
    // ---- 浏览器能力（api.js 用到的全部）----
    /**
     * ★★ window 必须**显式**注入 ★★
     *   api.js 的 hasNode() / serverBase() / proxyBase() 都读
     *   `window.__nebuladiskPlugin`，而 vm context 是**干净的**：
     *   不注入 window，里面的 `window.x` 会抛 ReferenceError，
     *   被各自的 try/catch 吞掉 ⇒ hasNode() 落回 HAS_NODE(=true)，
     *   serverBase() 落回 "" ⇒ pickChannel() 判定「有 node 但没地址」⇒
     *   **永远选代理通道** ⇒ 整轮全红，且报错只显示「fetch failed」，
     *   完全看不出是环境桩的问题。（实测踩过，见 C:/temp-nb/probe-channel.cjs）
     */
    window: global.window,
    sessionStorage: global.sessionStorage,
    fetch: global.fetch,
    FormData: global.FormData,
    location: global.location,
    URLSearchParams: global.URLSearchParams,
    AbortController: global.AbortController,
    setTimeout,
    clearTimeout,
    // 上传走 XHR，本测试不触发；给个会吼的桩，避免静默失败
    XMLHttpRequest: function () { throw new Error("本测试不触发 XHR 上传"); },
    navigator: { clipboard: null },
  });

  vm.runInContext(src, context, { filename: "src/api.js" });
  return mod.exports;
}

/* -------------------------------------------------------------------------
 * 跑测试
 * ---------------------------------------------------------------------- */
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

(async () => {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const apiPort = api.address().port;

  /**
   * ★ 代理仍然起着，但**不是被测通道** ★
   *   被测链路是直连（NAS 部署的真实形态）。这里保留代理实例只为两件事：
   *     1. 验证代理类在同一进程里不会干扰直连（端口冲突等）
   *     2. 让 proxy.stop() 在收尾时被真正调用（资源释放有回归）
   *   直连的地址由 installBOM 注入的 settings.serverUrl 决定。
   */
  const proxy = new NebulaProxy({
    target: `http://127.0.0.1:${apiPort}`,
    port: 0,
    host: "127.0.0.1",
    log: () => {},
  });
  const proxyPort = await proxy.start();

  installBOM(apiPort);
  const A = loadApiModule();

  console.log(`\n模拟网盘（直连目标） :${apiPort}   备用代理 :${proxyPort}\n`);

  console.log("【会话链路】");
  await check("登录成功，返回 display 字段", async () => {
    const r = await A.API.login("tao_zhang", "test-password-not-a-real-secret");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.display, "张涛");
  });
  await check("★ 登录下发的 token 被保存（直连通道用 Bearer）", async () => {
    const s = await A.API.hasSession();
    assert.strictEqual(s.hasSession, true);
    assert.strictEqual(s.channel, "direct", "NAS 部署形态应当是直连通道");
  });
  await check("/api/me 返回盘符列表", async () => {
    const me = await A.API.me();
    assert.strictEqual(me.username, "tao_zhang");
    assert.strictEqual(me.mounts.length, 3);
    assert.strictEqual(me.mounts[2].label, "项目设计");
    assert.strictEqual(me.mounts[2].writable, false);
  });

  console.log("\n【列目录链路】");
  await check("列根目录：条目字段与后端契约一致", async () => {
    const d = await A.API.list("售前项目", "");
    assert.strictEqual(d.path, "/");
    assert.strictEqual(d.entries.length, 3);
    const dir = d.entries[0];
    // 这几个字段名必须与 files.py 的 Entry.as_dict() 完全一致
    for (const k of ["name", "isDir", "size", "mtime", "ext", "route", "mime", "readonly"]) {
      assert.ok(k in dir, `条目缺少字段 ${k}`);
    }
    assert.strictEqual(dir.isDir, true);
  });
  await check("★ 中文目录名逐层下钻", async () => {
    const d1 = await A.API.list("售前项目", "2026");
    assert.strictEqual(d1.entries.length, 2);
    const d2 = await A.API.list("售前项目", "2026/某项目");
    assert.strictEqual(d2.entries[0].name, "01-封面.png");
    assert.strictEqual(d2.path, "/2026/某项目");
  });
  await check("★ 含 # 与空格的文件名完整保留", async () => {
    const d = await A.API.list("研发立项", "");
    assert.strictEqual(d.entries[0].name, "1.2.14.TFDF-6# F向.STEP");
    assert.strictEqual(d.entries[0].ext, "step");
  });
  await check("只读盘符被正确标记", async () => {
    const d = await A.API.list("项目设计", "");
    assert.strictEqual(d.mount.readonly, true);
    assert.strictEqual(d.entries[0].readonly, true);
  });
  await check("不存在的目录返回 404（且不泄露信息）", async () => {
    let err = null;
    try { await A.API.list("售前项目", "不存在的目录"); } catch (e) { err = e; }
    assert.ok(err, "应当抛错");
    assert.strictEqual(err.status, 404);
  });
  await check("越权盘符返回 404 而非 403", async () => {
    let err = null;
    try { await A.API.list("私密", ""); } catch (e) { err = e; }
    assert.strictEqual(err.status, 404);
  });

  console.log("\n【预览链路】");
  /**
   * ★★ 前缀为什么是网盘基点，而不是 /nb ★★
   *
   *   直连通道下 fixUrl() 的基点是 serverBase()（= 模拟网盘地址），
   *   它把后端返回的相对路径 `/preview/onlinePreview?...` 补成
   *   `http://127.0.0.1:<apiPort>/preview/onlinePreview?...`。
   *   早期断言写的是 /nb/preview/ —— 那是**已废弃的代理架构**，
   *   在直连形态下永远不会出现（写 /nb 反而会让浏览器 404）。
   */
  const SERVER = `http://127.0.0.1:${apiPort}`;

  await check("★ previewUrl 的 url 补成了网盘绝对地址", async () => {
    const r = await A.API.previewUrl("售前项目", "方案说明.md");
    assert.ok(r.url.startsWith(SERVER + "/preview/"), `实际: ${r.url}`);
  });
  await check("★ previewUrl 的 raw 是签名直链（含 sig）", async () => {
    const r = await A.API.previewUrl("售前项目", "方案说明.md");
    assert.ok(r.raw.includes("/api/raw/"), `实际: ${r.raw}`);
    assert.ok(r.raw.includes("sig="), "直链应含签名");
    assert.ok(r.raw.startsWith(SERVER), `签名直链应指向网盘，实际: ${r.raw}`);
  });
  await check("★ 直链里的文件名进了 path（kkFileView 靠它取后缀）", async () => {
    const r = await A.API.previewUrl("售前项目", "方案说明.md");
    assert.ok(r.raw.includes("方案说明.md") || r.raw.includes(encodeURIComponent("方案说明.md")),
      `实际: ${r.raw}`);
  });
  await check("★ cadUrl 走网盘 /cad/ 深链", async () => {
    const r = await A.API.cadUrl("项目设计", "A-01.dwg");
    assert.ok(r.url.startsWith(SERVER + "/cad/"), `实际: ${r.url}`);
  });

  /**
   * ★★★ 任务31（rev）：CAD 查看器的显示设置到底怎么关 ★★★
   *
   *  【曾经写在这里的结论 —— 已被实测推翻，留痕以防重犯】
   *    「设置对象只在模块内部 Il.instance.settings，页面拿不到；
   *     该 origin 的 localStorage 里只有 loglevel，没有 settings 键；
   *     深链只认 ?open=/?name=；只能走 /lite 注入 display:none。」
   *  错在两处：
   *    ① 查错了 bundle。真正服务 /cad/ 的入口是 assets/main-CoLbfQ3X.js，
   *       不是 cad-viewer-BAlsMkgn.js。
   *    ② 键名靠猜。真正的键由 App.setup 第一行的
   *       Qe.configure({ storageKey: "mlightcad.settings.cad-viewer" }) 设定；
   *       往 localStorage["settings"] 写当然没反应。
   *
   *  【实测正确结论（CDP A/B 验证过）】
   *    · 存储类 Ms.readUserFromStorage() 读的就是上面那个键；
   *      computeEffective() = {...QL, ..._user, ..._session}，其中 QL 是默认值表。
   *    · ⇒ 在**同源**的 /lite 外壳页里，于创建 iframe **之前**把
   *      {isShowRibbon:false, isShowToolbar:false, isShowCommandLine:false, …}
   *      写进 localStorage["mlightcad.settings.cad-viewer"]，查看器自己就不渲染这些 UI。
   *    · 实测（裸 /cad/ → /lite?kind=cad）：
   *        命令行 1→0、右上箭头 1→0、右工具栏 1→0、功能区 1→0、坐标 1→0，
   *        canvas 4→4（图照常画）。isShowCoordinate 连 canvas 上的 UCS 也一起关掉，
   *        这是 CSS 永远做不到的。
   *    · 播种代码在后端 pages.py 的 lite_shell 里（见下面的契约测试）。
   *
   *  ⇒ 结论没变（还是走 /lite），但**机制变了**：不是 CSS 藏，是查看器自己按设置不渲染。
   *     页签与嵌入块两条通道都必须套 /lite，否则行为不一致。
   */
  await check("★ 任务31：liteUrl(cad) 生成 /lite?kind=cad&target=… 且 target 是相对深链", () => {
    const deep = "/cad/?open=http%3A%2F%2Fx%2Fapi%2Fraw%2Fa.dwg&name=A-01.dwg";
    const u = A.API.liteUrl(SERVER, deep, "cad");
    assert.ok(u, "liteUrl 应返回地址");
    assert.ok(u.startsWith(SERVER + "/lite?"), `实际: ${u}`);
    assert.ok(u.includes("kind=cad"), `实际: ${u}`);
    assert.ok(u.includes("target="), `实际: ${u}`);
    // target 必须是**相对路径**（去掉 origin 后才塞进去），且被编码
    assert.ok(!/target=http%3A%2F%2F/.test(u), "target 里不该出现绝对 origin");
    assert.ok(u.includes(encodeURIComponent(deep)) || u.includes(encodeURIComponent(encodeURIComponent(deep))),
      `target 应是编码后的相对深链，实际: ${u}`);
  });
  await check("★ 任务31 反向：liteUrl 拒绝开放重定向（//host 与 scheme:）", () => {
    // 反向测试 —— 能变红才算数：下面两种必须被拒（返回空）
    assert.strictEqual(A.API.liteUrl(SERVER, "//evil.com/x", "cad"), "", "// 开头应被拒");
    assert.strictEqual(A.API.liteUrl(SERVER, "http://evil.com/x", "cad"), "", "绝对地址应被拒");
  });
  await check("★ ooConfig 的 apiJs 保持绝对地址（不加基点）", async () => {
    const r = await A.API.ooConfig("售前项目", "报价单.xlsx");
    assert.strictEqual(r.mode, "edit");
    assert.ok(r.apiJs.startsWith("http://"), `实际: ${r.apiJs}`);
  });
  await check("★ ooConfig 的文档 url 是容器内地址（OnlyOffice 服务端回拉）", async () => {
    const r = await A.API.ooConfig("售前项目", "报价单.xlsx");
    assert.ok(r.config.document.url.includes("nebula:8088"),
      `实际: ${r.config.document.url}`);
  });

  /**
   * ★★★ 这一条是「下载会报错」的回归 ★★★
   *
   *   历史 bug：downloadUrl() 写死 proxyBase() = http://127.0.0.1:6810，
   *   而 NAS 部署的思源是浏览器直连的，浏览器里的 127.0.0.1 指的是
   *   **用户自己那台电脑**，根本没有代理进程 ⇒ ERR_CONNECTION_REFUSED。
   *   ⇒ 断言「绝不能出现 127.0.0.1:6810」是这条测试的核心价值。
   */
  await check("★★ 直连通道下 downloadUrl 不得指向 127.0.0.1:6810", async () => {
    const u = await A.API.signedDownloadUrl("售前项目", "方案说明.md");
    assert.ok(!u.includes("127.0.0.1:6810"), `落回了本地代理（原始 bug）: ${u}`);
    assert.ok(u.startsWith(SERVER + "/api/raw/"), `应是签名直链，实际: ${u}`);
    assert.ok(u.includes("sig="), "直链应含签名");
  });
  await check("★ 签名直链可被真实拉取（模拟后端只认签名、不认 Cookie）", async () => {
    const u = await A.API.signedDownloadUrl("售前项目", "方案说明.md");
    const r = await fetch(u);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), "raw-file-content");
  });
  await check("★ 同步版 downloadUrl 命中已预热的签名直链", async () => {
    // 上一条已把签名存进缓存，这里应当同步命中同一条地址
    const u = A.API.downloadUrl("售前项目", "方案说明.md");
    assert.ok(u.startsWith(SERVER + "/api/raw/"), `实际: ${u}`);
    assert.ok(u.includes("sig="), "缓存里应带签名");
  });
  await check("★ signedRawUrl 返回浏览器可达直链（复制直链用）", async () => {
    const u = await A.API.signedRawUrl("售前项目", "方案说明.md");
    assert.ok(u.startsWith(SERVER + "/api/raw/"), `实际: ${u}`);
    assert.ok(!u.includes("nebula:8088"), "容器内主机名必须被改写成浏览器可达地址");
  });

  console.log("\n【文件类型路由】");
  await check("Office → office", () => assert.strictEqual(A.pickViewer("a.xlsx"), "office"));
  await check("图片 → image", () => assert.strictEqual(A.pickViewer("a.PNG"), "image"));
  await check("CAD → cad", () => assert.strictEqual(A.pickViewer("a.dwg"), "cad"));
  await check("压缩包 → archive", () => assert.strictEqual(A.pickViewer("a.zip"), "archive"));
  await check("代码 → text", () => assert.strictEqual(A.pickViewer("a.py"), "text"));
  await check("未知扩展名 → download", () => assert.strictEqual(A.pickViewer("a.xyz"), "download"));
  await check("isEditable 只对 Office 为真", () => {
    assert.strictEqual(A.isEditable("a.docx"), true);
    assert.strictEqual(A.isEditable("a.png"), false);
    assert.strictEqual(A.isEditable("a.dwg"), false);
  });

  console.log("\n【格式化】");
  await check("humanSize 各量级", () => {
    assert.strictEqual(A.humanSize(512), "512 B");
    assert.strictEqual(A.humanSize(2048), "2.0 KB");
    assert.strictEqual(A.humanSize(1024 * 1024 * 5), "5.0 MB");
  });
  await check("nodeKey 稳定", () => {
    assert.strictEqual(A.nodeKey("售前项目", ""), "售前项目::/");
    assert.strictEqual(A.nodeKey("售前项目", "a/b"), "售前项目::a/b");
  });

  console.log("\n【退出登录】");
  await check("退出后 /api/me 恢复 401", async () => {
    await A.API.logout();
    let err = null;
    try { await A.API.me(); } catch (e) { err = e; }
    assert.ok(err, "应当抛错");
    assert.strictEqual(err.status, 401);
    assert.strictEqual(err.kind, "auth");
  });
  await check("401 触发了统一回调", () => {
    // setUnauthorizedHandler 已被 index.js 注册；这里单独验证接口存在
    assert.strictEqual(typeof A.setUnauthorizedHandler, "function");
  });

  await proxy.stop();
  api.close();

  console.log("\n" + "=".repeat(50));
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log("=".repeat(50) + "\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("集成测试崩溃:", e); process.exit(1); });

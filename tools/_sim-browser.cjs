/**
 * 模拟「浏览器端思源」（NAS 场景）：没有 require / process / fs。
 *
 * 思源加载插件的真实方式（复刻 common.js）：
 *   (function anonymous(require, module, exports){ <plugin js> })(req, module, exports)
 * 其中 req 只认 "siyuan"，其余走 window.require。
 *
 * 浏览器里 window.require 不存在 ⇒ 任何 require("<node内建>") 都抛。
 *
 * 用法：node tools/_sim-browser.cjs
 */
const fs = require("fs");
const path = require("path");

// ★ 产物路径用**候选列表**，不要硬编码单一路径 ★
//   本机思源安装位只在开发机存在；换台机器（或 CI）会直接 readFileSync 抛错。
//   顺序：命令行参数 > 仓库 dist/ > 本机思源安装位。
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_CANDIDATES = [
  ...(process.argv[2] ? [process.argv[2]] : []),
  path.join(ROOT, "dist", "index.js"),
  "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js",
];
let BUNDLE = null;
for (const c of BUNDLE_CANDIDATES) {
  if (fs.existsSync(c)) { BUNDLE = c; break; }
}
if (!BUNDLE) {
  console.log("找不到构建产物 index.js，请先运行 node tools/build.js --repo");
  process.exit(1);
}
const js = fs.readFileSync(BUNDLE, "utf8");

// ---- 构造一个「浏览器」环境 ----
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  Map,
  Set,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  document: {
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {}, appendChild() {}, remove() {},
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, innerHTML: "", textContent: "",
    }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
  },
  location: {
    // ★ 关键：NAS 思源是 http://192.168.193.70:6806，不是 file://
    href: "http://192.168.193.70:6806/stage/build/desktop/",
    origin: "http://192.168.193.70:6806",
    hostname: "192.168.193.70",
    protocol: "http:",
    port: "6806",
  },
  navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36" },
  fetch: async () => { throw new Error("fetch stub"); },
  // ★ 注意：这里【故意不提供】require / process / window.require ★
  window: {},
  siyuan: {},
};
sandbox.window = sandbox;          // 浏览器里 window === globalThis
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// siyuan 内建模块（内核注入的最小桩）
const siyuanStub = {
  Plugin: class Plugin {
    constructor(opts) { Object.assign(this, opts || {}); this.name = (opts && opts.name) || "x"; }
    addIcons() {} addTab() {} addDock() {} addTopBar() {} addCommand() {}
    loadData() { return Promise.resolve(null); }
    saveData() { return Promise.resolve(); }
    eventBus = { on() {}, off() {}, emit() {} };
  },
  showMessage() {}, confirm() { return Promise.resolve(true); },
  getFrontend: () => "browser-desktop",
  getBackend: () => "docker",
};

// ---- 复刻思源的加载器 ----
const req = (spec) => {
  if (spec === "siyuan") return siyuanStub;
  // 浏览器里没有 window.require
  if (typeof sandbox.window.require === "function") return sandbox.window.require(spec);
  throw new Error(`Cannot find module '${spec}'（浏览器环境没有 window.require）`);
};

console.log("=== 模拟 NAS 浏览器端加载插件 ===");
console.log(`bundle: ${BUNDLE}  (${js.length}B)`);
console.log(`页面: ${sandbox.location.href}`);
console.log("");

const moduleObj = { exports: {} };
const exportsObj = moduleObj.exports;

try {
  const factory = new Function("require", "module", "exports", "window", js);
  factory(req, moduleObj, exportsObj, sandbox.window);
  console.log("✅ 脚本执行成功（无 require 错误）");
} catch (e) {
  console.log("❌ 脚本执行抛错 —— 思源会 console.error 后静默放弃：");
  console.log("   " + (e && e.message));
  if (e && e.stack) {
    const line = e.stack.split("\n").find((l) => l.includes("anonymous"));
    if (line) console.log("   位置:" + line.trim());
  }
  process.exit(1);
}

const exp = (moduleObj.exports && moduleObj.exports.default) || moduleObj.exports;
console.log("导出类型:", typeof exp, exp && exp.name);

if (typeof exp !== "function") {
  console.log("❌ 导出不是函数");
  process.exit(1);
}

// 实例化 + onload
(async () => {
  try {
    const inst = new exp({
      app: null, name: "siyuan-nebuladisk",
      displayName: "NebulaDisk 网盘", i18n: {},
    });
    console.log("✅ 实例化成功");
    await inst.onload();
    console.log("✅ onload 执行完成");

    // ────────────────────────────────────────────────────────────
    // ★★ 关键回归：通道决策必须锁定「直连」，绝不能回退 127.0.0.1:6810 ★★
    //
    //   历史故障：探测 /healthz 时没带 Origin，Starlette 的 CORSMiddleware
    //   只在有 Origin 时才回 ACAO ⇒ 探测读到 ACAO=(无) ⇒ 误判直连不可用
    //   ⇒ 回退本地代理 ⇒ 浏览器端根本没有代理
    //   ⇒ 满屏 `POST http://127.0.0.1:6810/… ERR_CONNECTION_REFUSED`。
    // ────────────────────────────────────────────────────────────
    console.log("");
    console.log("=== 通道决策回归 ===");

    const boot = inst.boot;
    if (!boot) { console.log("❌ 没有 boot 对象"); process.exit(1); }
    console.log("  boot.noNode        =", boot.noNode);
    console.log("  boot.mode          =", boot.mode);
    console.log("  boot.status.ok     =", boot.status.ok, "| mode:", boot.status.mode);

    if (boot.noNode !== true) {
      console.log("❌ 浏览器端应判定 noNode=true");
      process.exit(1);
    }
    if (boot.mode !== "direct") {
      console.log("❌ 浏览器端 mode 应为 direct，实际: " + boot.mode);
      process.exit(1);
    }
    if (boot.status.ok !== true) {
      console.log("❌ 浏览器端 status.ok 应为 true（可用状态），实际: " + boot.status.ok);
      process.exit(1);
    }

    // 直接问 api 层：当前通道是什么？
    inst.settings.serverUrl = "http://192.168.193.70:8089";
    const kind = inst.api.currentKind();
    console.log("  api.currentKind()  =", kind);
    if (kind !== "direct") {
      console.log("❌ currentKind 必须是 direct（否则所有请求会打到 127.0.0.1:6810）");
      process.exit(1);
    }

    // 即使会话缓存里塞了错误的 "proxy"，也必须强制纠正
    const origSS = global.sessionStorage;
    global.sessionStorage = {
      getItem: () => JSON.stringify({ base: "http://192.168.193.70:8089", kind: "proxy" }),
      setItem() {}, removeItem() {},
    };
    const kind2 = inst.api.currentKind();
    console.log('  （缓存里塞了 "proxy" 后）currentKind =', kind2);
    global.sessionStorage = origSS;
    if (kind2 !== "direct") {
      console.log("❌ 无 node 能力时必须无视错误的 proxy 缓存，强制 direct");
      process.exit(1);
    }

    // 顺便验 URL 拼接用的是直连基址（用真实对外接口 previewUrl，
    // 它内部会调 fixUrl）。这里需要 stub 一次 fetch 让 previewUrl 能返回。
    let seenUrl = "";
    sandbox.fetch = async (u, opts) => {
      seenUrl = String(u);
      return {
        ok: true, status: 200,
        headers: {
          get: (k) => {
            const kk = String(k).toLowerCase();
            if (kk === "access-control-allow-origin") return "*";
            // ★ 必须是 application/json，否则 apiGet 走 asText 分支读不到字段
            if (kk === "content-type") return "application/json";
            return null;
          },
        },
        json: async () => ({ ok: true, url: "/preview/onlinePreview?url=abc", raw: "/preview/onlinePreview?url=abc" }),
        text: async () => JSON.stringify({ ok: true, url: "/preview/onlinePreview?url=abc", raw: "/preview/onlinePreview?url=abc" }),
      };
    };
    global.fetch = sandbox.fetch;
    const pv = await inst.api.previewUrl("售前项目", "/a.pdf");
    console.log("  previewUrl 请求地址 =", seenUrl);
    console.log("  previewUrl 返回 url =", pv && pv.url);
    if (!/^http:\/\/172\.16\.30\.128:8089\//.test(String(pv && pv.url))) {
      console.log("❌ previewUrl 应拼直连基址 192.168.193.70:8089");
      process.exit(1);
    }
    if (/127\.0\.0\.1:6810/.test(String(seenUrl) + String(pv && pv.url))) {
      console.log("❌ 绝不能出现 127.0.0.1:6810");
      process.exit(1);
    }

    console.log("");
    console.log("✅ 通道决策正确：浏览器端锁定直连，永不回退 127.0.0.1:6810");

    // ────────────────────────────────────────────────────────────
    // ★★ 任务2回归：browserReachableUrl 必须把「容器内服务名」改写成浏览器可达 ★★
    //
    //   历史故障：复制直链得到 http://nebula:8088/api/raw/...，
    //   `nebula` 是 docker 网络里的服务名，浏览器解析不了。
    //   后端 make_raw_url() 用的是容器内部 origin（给 OnlyOffice/kkFileView
    //   这些容器内引擎用），客户端拿到后必须自行改写主机。
    // ────────────────────────────────────────────────────────────
    console.log("");
    console.log("=== 任务2：直链主机改写回归 ===");

    if (typeof inst.api.browserReachableUrl !== "function") {
      console.log("❌ api 未导出 browserReachableUrl");
      process.exit(1);
    }

    const cases = [
      ["http://nebula:8088/api/raw/a.pdf?x=1", "容器服务名 nebula:8088"],
      ["http://nebuladisk-nebula-1:8088/api/raw/a.pdf", "compose 容器名"],
    ];
    for (const [inp, desc] of cases) {
      const out = inst.api.browserReachableUrl(inp);
      console.log(`  ${desc}`);
      console.log(`    in  = ${inp}`);
      console.log(`    out = ${out}`);
      if (/\/\/nebula[:/]/.test(out) || /nebuladisk-nebula-1/.test(out)) {
        console.log("❌ 仍然残留容器内主机名");
        process.exit(1);
      }
      if (!/^http:\/\/172\.16\.30\.128:8089\//.test(out)) {
        console.log("❌ 应改写为直连基址 192.168.193.70:8089");
        process.exit(1);
      }
      // 签名参数必须原样保留（否则直链失效）
      const inQuery = String(inp).split("?")[1] || "";
      const outQuery = String(out).split("?")[1] || "";
      if (inQuery !== outQuery) {
        console.log(`❌ 查询串被改动：\n    in  = ${inQuery}\n    out = ${outQuery}`);
        process.exit(1);
      }
    }

    // 已经是「正常公网/局域网主机」的 URL 不得被改写
    const keep = "http://192.168.193.70:8089/api/raw/a.pdf?sig=zz";
    const keepOut = inst.api.browserReachableUrl(keep);
    console.log("  正常主机保持原样");
    console.log(`    in  = ${keep}`);
    console.log(`    out = ${keepOut}`);
    if (keepOut !== keep) {
      console.log("❌ 正常主机不应被改写");
      process.exit(1);
    }

    // signedRawUrl 必须走改写后的结果（端到端）
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      headers: {
        get: (k) => {
          const kk = String(k).toLowerCase();
          if (kk === "access-control-allow-origin") return "*";
          if (kk === "content-type") return "application/json";
          return null;
        },
      },
      json: async () => ({
        ok: true,
        url: "http://nebula:8088/api/raw/a.pdf",
        raw: "http://nebula:8088/api/raw/a.pdf?mount=m&path=%2Fa.pdf&exp=1&sig=deadbeef",
      }),
      text: async () => JSON.stringify({
        ok: true,
        url: "http://nebula:8088/api/raw/a.pdf",
        raw: "http://nebula:8088/api/raw/a.pdf?mount=m&path=%2Fa.pdf&exp=1&sig=deadbeef",
      }),
    });
    global.fetch = sandbox.fetch;
    const signed = await inst.api.signedRawUrl("售前项目", "/a.pdf");
    console.log("  signedRawUrl 端到端 =", signed);
    if (/nebula:8088/.test(String(signed))) {
      console.log("❌ signedRawUrl 仍在返回容器内主机");
      process.exit(1);
    }
    if (!/^http:\/\/172\.16\.30\.128:8089\//.test(String(signed))) {
      console.log("❌ signedRawUrl 应改写为直连基址");
      process.exit(1);
    }
    if (!/sig=deadbeef/.test(String(signed))) {
      console.log("❌ signedRawUrl 丢掉了签名参数");
      process.exit(1);
    }

    console.log("");
    console.log("✅ 任务2通过：直链主机改写正确，签名参数保留");

    // ────────────────────────────────────────────────────────────
    // ★★ 任务2附：downloadUrl / signedDownloadUrl 通道正确性 ★★
    //
    //   历史故障：downloadUrl() 写死 proxyBase() ⇒ 浏览器端打出
    //   http://127.0.0.1:6810/api/download ⇒ ERR_CONNECTION_REFUSED。
    //   用户的「下载会报错」与任务⑧「图片/视频/文本打不开」同根。
    // ────────────────────────────────────────────────────────────
    console.log("");
    console.log("=== 任务2附：下载地址通道回归 ===");

    if (typeof inst.api.signedDownloadUrl !== "function") {
      console.log("❌ api 未导出 signedDownloadUrl");
      process.exit(1);
    }

    // 直连 + 未预热 ⇒ 同步 downloadUrl 也绝不能出现回环地址
    const syncDl = inst.api.downloadUrl("售前项目", "/a.pdf", false);
    console.log("  downloadUrl（直连，未预热） =", syncDl);
    if (/127\.0\.0\.1/.test(syncDl)) {
      console.log("❌ 直连通道绝不能拼出 127.0.0.1（这就是原 bug）");
      process.exit(1);
    }
    if (!/^http:\/\/172\.16\.30\.128:8089\//.test(syncDl)) {
      console.log("❌ 直连通道 downloadUrl 应指向 192.168.193.70:8089");
      process.exit(1);
    }

    // signedDownloadUrl 直连 ⇒ 签名直链
    // ★ exp 必须放进未来 —— rememberRawUrl 会按 exp 判过期，
    //   过期签名不该被同步接口复用（那是刻意的安全设计）。
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      headers: {
        get: (k) => {
          const kk = String(k).toLowerCase();
          if (kk === "access-control-allow-origin") return "*";
          if (kk === "content-type") return "application/json";
          return null;
        },
      },
      json: async () => ({
        ok: true,
        url: "http://nebula:8088/api/raw/a.pdf",
        raw: "http://nebula:8088/api/raw/a.pdf?mount=m&path=%2Fa.pdf&exp=" + futureExp + "&sig=deadbeef",
      }),
      text: async () => JSON.stringify({
        ok: true,
        url: "http://nebula:8088/api/raw/a.pdf",
        raw: "http://nebula:8088/api/raw/a.pdf?mount=m&path=%2Fa.pdf&exp=" + futureExp + "&sig=deadbeef",
      }),
    });
    global.fetch = sandbox.fetch;
    const sd = await inst.api.signedDownloadUrl("售前项目", "/a.pdf", false);
    console.log("  signedDownloadUrl（直连，下载） =", sd);
    if (/127\.0\.0\.1|\/\/nebula[:/]/.test(sd)) {
      console.log("❌ signedDownloadUrl 不得含回环或容器内主机");
      process.exit(1);
    }
    if (!/^http:\/\/172\.16\.30\.128:8089\/api\/raw\//.test(sd)) {
      console.log("❌ 直连通道应走 /api/raw 签名直链");
      process.exit(1);
    }
    if (/inline=true/.test(sd)) {
      console.log("❌ 下载（inline=false）不应带 inline=true");
      process.exit(1);
    }

    // 预热之后，同步 downloadUrl 必须命中同一条签名直链
    const syncAfter = inst.api.downloadUrl("售前项目", "/a.pdf", false);
    console.log("  downloadUrl（直连，已预热） =", syncAfter);
    if (syncAfter !== sd) {
      console.log("❌ 预热后同步 downloadUrl 应命中缓存里的同一条签名直链");
      process.exit(1);
    }

    // inline 预览：必须带上 inline=true（且签名仍在）
    const sdInline = await inst.api.signedDownloadUrl("售前项目", "/a.pdf", true);
    console.log("  signedDownloadUrl（直连，预览） =", sdInline);
    if (!/inline=true/.test(sdInline)) {
      console.log("❌ 预览（inline=true）必须带 inline=true");
      process.exit(1);
    }
    if (!/sig=/.test(sdInline)) {
      console.log("❌ inline 版丢了签名");
      process.exit(1);
    }

    // ★ 过期签名绝不能被复用（否则用户拿到一条已失效的地址）
    sandbox.fetch = async () => ({
      ok: true, status: 200,
      headers: {
        get: (k) => {
          const kk = String(k).toLowerCase();
          if (kk === "access-control-allow-origin") return "*";
          if (kk === "content-type") return "application/json";
          return null;
        },
      },
      json: async () => ({
        ok: true, url: "http://nebula:8088/api/raw/b.pdf",
        raw: "http://nebula:8088/api/raw/b.pdf?mount=m&path=%2Fb.pdf&exp=1000000000&sig=stale",
      }),
      text: async () => JSON.stringify({
        ok: true, url: "http://nebula:8088/api/raw/b.pdf",
        raw: "http://nebula:8088/api/raw/b.pdf?mount=m&path=%2Fb.pdf&exp=1000000000&sig=stale",
      }),
    });
    global.fetch = sandbox.fetch;
    const stale = await inst.api.signedDownloadUrl("售前项目", "/b.pdf", false);
    const staleSync = inst.api.downloadUrl("售前项目", "/b.pdf", false);
    console.log("  过期签名的异步结果 =", stale);
    console.log("  过期签名的同步结果 =", staleSync);
    if (/sig=stale/.test(staleSync)) {
      console.log("❌ 过期签名不得进入同步缓存（否则用户拿到失效地址）");
      process.exit(1);
    }

    console.log("");
    console.log("✅ 任务2附通过：下载/预览地址均按通道拼装，无回环地址");

    /* ==================================================================
     * 任务③：「打开网盘」深链地址（必须落在**文件所在目录**）
     * ================================================================== */
    console.log("");
    console.log("---- 任务3：打开网盘深链 ----");

    const wd = inst.api.webDiskUrl;
    if (typeof wd !== "function") {
      console.log("❌ inst.api.webDiskUrl 未导出");
      process.exit(1);
    }

    const dlCases = [
      // [说明, base, mount, 文件路径, 期望的 path 参数（解码后）]
      ["根目录下的文件 → 落在 /", "http://192.168.193.70:8089", "研发立项",
        "/除尘工程技术手册.pdf", "/"],
      ["一层目录下的文件", "http://192.168.193.70:8089", "研发立项",
        "/02 单机图纸/a.dwg", "/02 单机图纸"],
      ["深层目录", "http://192.168.193.70:8089", "售前项目",
        "/关于印发《非标设备技术档案资料管理要求》的通知.doc", "/"],
      ["多层路径", "http://192.168.193.70:8089", "项目设计",
        "/2026/09/方案/v2/final.docx", "/2026/09/方案/v2"],
      ["末尾多余斜杠的 base", "http://192.168.193.70:8089///", "研发立项",
        "/a/b/c.xlsx", "/a/b"],
      ["反斜杠路径（容错）", "http://192.168.193.70:8089", "研发立项",
        "\\a\\b\\c.xlsx", "/a/b"],
      ["空文件路径 → 根", "http://192.168.193.70:8089", "研发立项", "", "/"],
      ["无 mount → 仅根地址", "http://192.168.193.70:8089", "",
        "/a/b.pdf", null],
    ];

    let dlFail = 0;
    for (const [name, base, mount, file, wantPath] of dlCases) {
      const got = wd(base, mount, file);
      const u = new URL(got);
      const gotMount = u.searchParams.get("mount");
      const gotPath = u.searchParams.get("path");

      let good;
      if (wantPath === null) {
        good = gotMount === null && gotPath === null;
      } else {
        good = gotMount === mount && gotPath === wantPath;
      }

      console.log(
        (good ? "  ✅ " : "  ❌ ") + name +
        "\n       → " + got +
        "\n       mount=" + JSON.stringify(gotMount) + " path=" + JSON.stringify(gotPath)
      );
      if (!good) { dlFail++; console.log("       期望 path=" + JSON.stringify(wantPath)); }
    }

    // 关键护栏：绝不能再出现回环地址（那是任务②的原始 bug）
    const probe = wd("http://192.168.193.70:8089", "研发立项", "/02 单机图纸/a.dwg");
    console.log("");
    if (/127\.0\.0\.1|localhost/.test(probe)) {
      console.log("❌ 深链地址里出现了回环地址（任务②的原始 bug 复现）");
      dlFail++;
    } else {
      console.log("  ✅ 深链地址不含 127.0.0.1/localhost");
    }

    // 中文必须被百分号编码（否则某些网关会截断）
    if (!/mount=%E7%A0%94%E5%8F%91%E7%AB%8B%E9%A1%B9/.test(probe)) {
      console.log("❌ 中文挂载点未被编码");
      dlFail++;
    } else {
      console.log("  ✅ 中文挂载点已百分号编码");
    }

    if (dlFail) {
      console.log("❌ 任务3深链用例失败 " + dlFail + " 条");
      process.exit(1);
    }
    console.log("");
    console.log("✅ 任务3通过：打开网盘深链落在文件所在目录，参数编码正确");
    // ★ 标准汇总行（供 tools/run-all-tests.cjs 解析）★
    //   本套件采用「任一失败立即 exit(1)」的短路写法，走到这里即全部通过。
    //   没有这一行时上游只能退化成数 ✅/❌，计数会把「说明性 ✅」也算进去。
    console.log("");
    console.log("通过 3 / 失败 0");
  } catch (e) {
    console.log("❌ onload 抛错：");
    console.log("   " + (e && e.message));
    if (e && e.stack) console.log(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
})();

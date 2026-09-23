/* ==========================================================================
 * 安装状态自检
 * --------------------------------------------------------------------------
 * 在「思源已经打开」的情况下运行，回答三个问题：
 *   1. 插件文件是否在**正确的工作区**里（思源实际读的 dataDir）
 *   2. index.js 是不是思源能加载的 CommonJS（不是 ESM）
 *   3. 思源本次启动有没有把它列进已加载插件（loaded petals 日志）
 *
 * 为什么需要它
 *   思源只在**内核启动时**扫描 data/plugins/。新放入的插件不会被热加载，
 *   表现为「重启前插件列表里一直没有」——这个脚本能把这一点直接指出来，
 *   而不是让你反复点「重新加载插件」。
 *
 * 用法：node tools/verify-install.js
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

/** 思源默认监听地址（本机实测只绑内网 IP，不绑 127.0.0.1） */
const HOST_CANDIDATES = ["192.168.193.70", "127.0.0.1"];
const PORT = 6806;
const PLUGIN_NAME = "siyuan-nebuladisk";

const ok = (m) => console.log("  ✅ " + m);
const bad = (m) => console.log("  ❌ " + m);
const warn = (m) => console.log("  ⚠️  " + m);
const info = (m) => console.log("     " + m);

/** 读思源配置，拿到真实 workspaceDir / dataDir / api token */
function readSiYuanConf() {
  const candidates = [
    "D:/Software/SiYuan/conf/conf.json",
    path.join(os.homedir(), "SiYuan/conf/conf.json"),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(c, "utf8"));
      return {
        confPath: c,
        workspaceDir: j.system && j.system.workspaceDir,
        dataDir: j.system && j.system.dataDir,
        token: (j.api && j.api.token) || "",
      };
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

/** 探测思源内核在哪个地址上活着 */
function probeKernel() {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= HOST_CANDIDATES.length) return resolve(null);
      const host = HOST_CANDIDATES[i++];
      const req = http.get(
        { host, port: PORT, path: "/api/system/version", timeout: 3000 },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => {
            try {
              resolve({ host, version: JSON.parse(b).data });
            } catch {
              resolve({ host, version: "?" });
            }
          });
        },
      );
      req.on("error", next);
      req.on("timeout", () => {
        req.destroy();
        next();
      });
    };
    next();
  });
}

/** 调思源 API（带 token） */
function apiPost(host, p, token) {
  return new Promise((resolve) => {
    const data = "{}";
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (token) headers.Authorization = "Token " + token;
    const req = http.request(
      { host, port: PORT, path: p, method: "POST", headers },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e.code) }));
    req.write(data);
    req.end();
  });
}

/** 分析日志里最后一次 loaded petals，看插件在不在列表里 */
function checkLoadedFromLog(dataDir) {
  const lf = path.join(dataDir, "..", "temp", "siyuan.log");
  if (!fs.existsSync(lf)) return { ok: false, reason: "找不到 siyuan.log" };
  const lines = fs.readFileSync(lf, "utf8").split("\n");
  // 只看 frontend=desktop / browser-desktop 那类（排除 isKernel=true 的空列表行）
  const hits = lines.filter((l) => /loaded petals/.test(l) && !/isKernel=true/.test(l));
  if (!hits.length) return { ok: false, reason: "日志里没有前端 loaded petals 记录" };
  const last = hits[hits.length - 1];
  const t = (last.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || "?";
  const list = (last.match(/petals=\[([^\]]*)\]/) || [, ""])[1];
  const arr = list.split(",").map((s) => s.trim()).filter(Boolean);

  // 假阳性检测：内核可能推过 reloads=[我们]，但那不代表加载成功
  const reloadLine = [...lines].reverse().find((l) =>
    /push_reload/.test(l) && new RegExp(`reloads=\\[[^\\]]*${PLUGIN_NAME}`).test(l)
  );

  return {
    ok: true,
    time: t,
    epoch: parseLogTime(t),
    plugins: arr,
    hasOurs: arr.includes(PLUGIN_NAME),
    reloadOnly: reloadLine
      ? (reloadLine.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || "?"
      : null,
  };
}

/** 探活：插件的 onload() 会起本地转发代理。连不上 ⇒ onload 从未执行 */
function probeProxy(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = require("http").request(
        { host: "127.0.0.1", port, path: "/__ping", method: "GET", timeout: 1500 },
        (res) => { res.resume(); finish({ up: true, status: res.statusCode }); }
      );
      req.on("error", (e) => finish({ up: false, code: e.code }));
      req.on("timeout", () => { req.destroy(); finish({ up: false, code: "TIMEOUT" }); });
      req.end();
    } catch (e) {
      finish({ up: false, code: e.message });
    }
  });
}

/** 把 "2026/09/22 12:58:02" 解析成本地时间戳；失败返回 null */
function parseLogTime(s) {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** 插件目录里最新一个文件的 mtime —— 等价于「插件最后一次落盘的时间」 */
function newestMtime(dir) {
  let newest = 0;
  let which = "";
  const walk = (p) => {
    let ents;
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else {
        const t = fs.statSync(fp).mtimeMs;
        if (t > newest) {
          newest = t;
          which = path.relative(dir, fp).replace(/\\/g, "/");
        }
      }
    }
  };
  walk(dir);
  return { epoch: newest, which };
}

/** 本地时间戳 → "2026/09/22 13:21:55"，与日志同格式便于并排比较 */
function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/* -------------------------------------------------------------------------
 * 主流程
 * ---------------------------------------------------------------------- */
(async () => {
  console.log("\n================ 思源 NebulaDisk 插件 · 安装自检 ================\n");

  // ---- ① 定位工作区 ----
  console.log("【① 工作区定位】");
  const conf = readSiYuanConf();
  if (!conf) {
    bad("找不到思源配置 conf.json，无法确定工作区");
    return;
  }
  ok("配置文件: " + conf.confPath);
  info("workspaceDir = " + conf.workspaceDir);
  info("dataDir      = " + conf.dataDir);

  const pluginsDir = path.join(conf.dataDir, "plugins");
  const target = path.join(pluginsDir, PLUGIN_NAME);
  console.log();
  if (fs.existsSync(target)) ok("插件目录存在: " + target);
  else {
    bad("插件目录不存在: " + target);
    return;
  }

  // ---- ② 文件完整性 ----
  // 注意：插件**必须是单文件 bundle**。思源给插件的 require 只认 "siyuan"，
  // 其他 specifier 落到 Electron 的 window.require（基准是渲染进程 bundle），
  // 所以 require("./src/x.js") 必定 MODULE_NOT_FOUND ⇒ 插件被静默丢弃。
  // 因此这里只应存在 index.js，src/ 属于**源码**目录、不该出现在产物里。
  console.log("\n【② 文件清单】");
  const required = ["plugin.json", "index.js", "index.css", "icon.png"];
  for (const rel of required) {
    const f = path.join(target, rel);
    if (fs.existsSync(f)) ok(`${rel}  (${fs.statSync(f).size}B)`);
    else bad(`${rel} 缺失`);
  }
  // src/ 残留 = 构建脚本没清理干净，容易让人误以为是多文件加载
  if (fs.existsSync(path.join(target, "src"))) {
    warn("产物里残留 src/ 目录 —— 单文件打包后不应存在，建议删掉以免误解");
  } else {
    ok("src/ 已清理（单文件打包的正确状态）");
  }

  // ---- ③ 模块格式（关键）----
  console.log("\n【③ 模块格式（决定思源能否加载）】");
  const idxRaw = fs.readFileSync(path.join(target, "index.js"), "utf8");
  // 注释里可能出现 require("./x") 的**示例文字**，必须先去掉注释再判定
  const idx = idxRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");

  const isCJS = /module\.exports\s*=/.test(idx);
  const hasESM = /^\s*export\s+(default|const|function|class)\b/m.test(idx) ||
    /^\s*import\s+[\w{*]/m.test(idx);
  if (isCJS && !hasESM) ok("index.js 是 CommonJS（module.exports）—— 思源可加载");
  else if (hasESM) bad("index.js 仍是 ESM（import/export）—— 思源不会加载，且不报错");
  else warn("index.js 既无 module.exports 也无 ESM 语句，请检查");

  // ★ 最关键的一项：**相对** require 会让插件静默死掉
  const reqs = idx.match(/require\(["'][^"']+["']\)/g) || [];
  const relReqs = reqs.filter((r) => /["']\.{1,2}\//.test(r));
  if (relReqs.length) {
    bad(`产物里有 ${relReqs.length} 处相对 require —— 思源加载时必定 MODULE_NOT_FOUND：`);
    info([...new Set(relReqs)].join(", "));
  } else {
    ok("无相对 require（引擎自带模块如 fs/http/electron 不算）");
  }
  info("require 调用: " + (reqs.length ? [...new Set(reqs)].join(", ") : "无"));

  // ---- ④ 清单合法性 ----
  console.log("\n【④ plugin.json】");
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(target, "plugin.json"), "utf8"));
    ok("JSON 合法，name = " + pj.name);
    if (pj.name === PLUGIN_NAME) ok("name 与目录名一致");
    else bad(`name(${pj.name}) 与目录名(${PLUGIN_NAME}) 不一致`);
    if (pj.icon && !fs.existsSync(path.join(target, pj.icon))) bad("icon 指向的文件不存在: " + pj.icon);
    else if (pj.icon) ok("icon 存在: " + pj.icon);
    for (const [k, v] of Object.entries(pj.readme || {})) {
      if (!fs.existsSync(path.join(target, v))) bad(`readme.${k} 指向的文件不存在: ${v}`);
    }
  } catch (e) {
    bad("plugin.json 解析失败: " + e.message);
  }

  // ---- ⑤ 内核是否已加载 ----
  console.log("\n【⑤ 思源内核状态】");
  const k = await probeKernel();
  if (!k) {
    warn("内核未响应（思源可能已关闭）。启动思源后再跑一次本脚本。");
  } else {
    ok(`内核在线: ${k.host}:${PORT}  版本 ${k.version}`);
    const r = await apiPost(k.host, "/api/bazaar/getInstalledPlugin", conf.token);
    if (r.status === 401) warn("API 鉴权失败（token 可能是旧的），跳过接口检查");
    else info("getInstalledPlugin → HTTP " + r.status + " len=" + r.body.length);
  }

  const logr = checkLoadedFromLog(conf.dataDir);
  const proxyPort = 6810;
  const proxy = await probeProxy(proxyPort);
  info(
    proxy.up
      ? `转发代理在线: 127.0.0.1:${proxyPort} → HTTP ${proxy.status}  ⇒ onload() 已执行`
      : `转发代理未响应 (${proxy.code}) ⇒ onload() **没有**执行`
  );

  if (logr.ok) {
    info(`最近一次「loaded petals」于 ${logr.time}，共 ${logr.plugins.length} 个插件`);
    if (logr.hasOurs) {
      ok("★ 我们的插件在启动扫描列表里 —— 已加载");
    } else {
      bad("★ 我们的插件**不在**启动扫描列表里");
      if (logr.reloadOnly) {
        warn(
          `注意：日志里出现过 reloads=[${PLUGIN_NAME}] @ ${logr.reloadOnly}，` +
            `但那是**假阳性** —— 内核发现新目录后推的 reload，不等于前端加载成功。`
        );
      }
      // 关键：区分「没重启」和「重启在装之前」——只看在不在列表会误导用户反复重启
      const nm = newestMtime(target);
      info(`插件目录最新文件: ${nm.which}  @ ${fmt(nm.epoch)}`);
      const stale = logr.epoch && nm.epoch > logr.epoch;
      if (stale) {
        const secs = Math.round((nm.epoch - logr.epoch) / 1000);
        warn(
          `插件文件比那次启动**晚 ${secs} 秒**才写入 ⇒ 那次启动发生在安装之前，` +
            `所以「已经重启过」也可能看不到。`
        );
        info("请**现在再完全退出思源并重新打开一次**（这次是在文件已就位之后启动）。");
      } else if (!proxy.up) {
        // 文件早就在了却还是没加载 —— 常见于「启动时云同步与扫描竞争」
        warn(
          "文件写入早于那次启动，但启动扫描仍漏掉了它 —— " +
            "常见原因是**启动时的云同步与插件扫描竞争**（同步 remove/re-add 期间扫不到）。"
        );
        info("处理办法：等日志静止（不再有 sync/diff 行）后，**再做一次干净重启**。");
      } else {
        warn("文件写入时间早于那次启动，但列表里仍没有 —— 需要看内核日志详情。");
      }
      info("思源只在**内核启动时**扫描 data/plugins/，新增插件必须重启思源。");
      info(`重启后核对：新的 loaded petals 时间应 > ${fmt(nm.epoch)}`);
    }
  } else {
    warn("无法从日志判断: " + logr.reason);
  }

  console.log("\n================================================================");
  console.log(" 若插件仍需生效：完全退出思源 → 重新打开 → 看侧边栏是否出现网盘图标");
  console.log("================================================================\n");
})();

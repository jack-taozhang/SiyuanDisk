/* tools/_local.cjs —— 本地环境配置读取（★ 口令绝不入库 ★）
 *
 * 【为什么要有这个文件】
 *   CDP 端到端 / 探针脚本需要「思源地址 + 访问授权码」才能登录测试。
 *   早前这些值**硬编码在脚本里**（`const AUTH = "……"`）——
 *   一旦提交就泄露到公开仓库。现在统一从这里读，
 *   而配置源 `tools/.nb-local.json` 已被 .gitignore 排除。
 *
 *   2026-09-29 修正：提交前审计发现 5 个探针脚本硬编码了口令，已全部改为读本模块。
 *
 * 【配置优先级】环境变量 > tools/.nb-local.json > 报错
 *   NB_HOST      NAS / 思源 主机名或 IP
 *   NB_PORT      思源端口（默认 6806）
 *   NB_USER      SSH 登录用户
 *   NB_PASS      SSH / NebulaDisk 口令
 *   NB_AUTH      思源「访问授权码」（accessAuthCode）。
 *                本实例历史上与 SSH 口令相同，故缺省回退到 pass；
 *                但**语义是两件事**，可单独配。
 *   NB_SIYUAN    完整基址（覆盖 HOST/PORT，如 http://1.2.3.4:6806）
 *   NB_SERVERURL NebulaDisk 网盘后端基址（浏览器可达的那个，默认 :8089）。
 *                ★ 2026-09-30 新增 ★
 *                  排查「在浏览器中打开」的预览链路时，探针要直连网盘后端
 *                  （/api/login /api/preview /api/stat …）。此前只有思源的信息，
 *                  每次都手写地址 + 口令，正是泄漏的高发点。
 *                  缺省从 conf.serverUrl 读；再缺省由 HOST + :8089 拼。
 *   CHROME_PATH  Chrome 可执行文件路径
 *   NB_WS        ws 包的 require 路径（找不到时用）
 *
 * 【用法】
 *   const { SIYUAN, AUTH, CHROME, WS } = require("./_local.cjs");
 *
 * 依赖：ws（仅 CDP 脚本用）。本仓库不含 node_modules，
 *      默认会在若干常见位置找；找不到就设 NB_WS 指过去。
 */
const fs = require("fs");
const path = require("path");

const HERE = __dirname;

function loadConf() {
  const cands = [
    path.join(HERE, ".nb-local.json"),
    path.join(HERE, "tools", ".nb-local.json"),
    path.join(HERE, "..", "tools", ".nb-local.json"),
  ];
  for (const c of cands) {
    try {
      const d = JSON.parse(fs.readFileSync(c, "utf8"));
      if (d && (d.host || d.pass)) return d;
    } catch (e) { /* 试下一个 */ }
  }
  return {};
}

const conf = loadConf();

const HOST = process.env.NB_HOST || conf.host || "";
const USER = process.env.NB_USER || conf.user || "";
const PASS = process.env.NB_PASS || conf.pass || "";
const AUTH = process.env.NB_AUTH || conf.authCode || PASS;
const PORT = process.env.NB_PORT || "6806";
const SIYUAN = process.env.NB_SIYUAN || (HOST ? `http://${HOST}:${PORT}` : "");

/* ★ NebulaDisk 网盘后端基址（2026-09-30 新增）★
 *   优先级：NB_SERVERURL > conf.serverUrl > http://<HOST>:8089
 *   末项用 HOST 拼，是因为本实例两处地址同机（NAS 双网口），
 *   探针通常就在 NAS 同网段跑。
 *   ★ 注意末尾去斜杠 ★ —— 拼 `/api/preview` 时多一条斜杠会 404。
 */
const NEBULA = String(
  process.env.NB_SERVERURL || conf.serverUrl || (HOST ? `http://${HOST}:8089` : "")
).replace(/\/+$/, "");

/** 找一个能 require 到的 ws */
function resolveWs() {
  const tried = [];
  const cands = [
    process.env.NB_WS,
    "ws",
    path.join(HERE, "..", "node_modules", "ws"),
    // 常见"借别人 node_modules"的位置；不是必须，找不到就报错让你设 NB_WS
    "D:/Docker/diskcanvas/node_modules/ws",
  ].filter(Boolean);
  for (const c of cands) {
    try { return require(c); } catch (e) { tried.push(c); }
  }
  throw new Error(
    "找不到 ws 包。请 `npm i ws`，或设环境变量 NB_WS 指向它的目录。已尝试：" +
    tried.join(" | ")
  );
}

function resolveChrome() {
  const c = process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!fs.existsSync(c)) {
    throw new Error("找不到 Chrome：" + c + "（用 CHROME_PATH 指定）");
  }
  return c;
}

module.exports = {
  conf, HOST, USER, PASS, AUTH, PORT, SIYUAN, NEBULA,
  get WS() { return resolveWs(); },
  get CHROME() { return resolveChrome(); },
  /**
   * 用管理员口令登录 NebulaDisk，返回访问令牌（Bearer）。
   *
   * ★ 为什么要有它 ★
   *   网盘后端的 /api/login 走 **表单**（Form），不是 JSON ——
   *   发 JSON 会得到 422「Field required」。踩过一次，写在这里省得再犯。
   *   /api/me、/api/list、/api/preview 等都认 `Authorization: Bearer <token>`。
   */
  async nebulaLogin() {
    if (!NEBULA) throw new Error("未配置 NebulaDisk 地址（NB_SERVERURL）");
    if (!USER || !PASS) throw new Error("未配置 NebulaDisk 账号（NB_USER / NB_PASS）");
    const body = new URLSearchParams({ username: USER, password: PASS });
    const r = await fetch(`${NEBULA}/api/login`, { method: "POST", body });
    if (!r.ok) throw new Error(`登录失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (!j || !j.token) throw new Error("登录响应缺少 token：" + JSON.stringify(j).slice(0, 200));
    return j.token;
  },
  /** 缺关键配置时给一条人话错误，而不是让脚本在后面莫名失败 */
  assertReady() {
    const miss = [];
    if (!SIYUAN) miss.push("NB_HOST（或 tools/.nb-local.json 的 host）");
    if (!AUTH) miss.push("NB_AUTH（或 .nb-local.json 的 authCode/pass）");
    if (miss.length) {
      throw new Error("缺少本地配置：" + miss.join("、") +
        "。请复制 tools/.nb-local.json.example 为 tools/.nb-local.json 并填写。");
    }
  },
};

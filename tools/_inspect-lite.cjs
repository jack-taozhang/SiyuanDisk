/**
 * 用真实浏览器打开一个 URL，等指定毫秒后跑 _probe/inspect-lite.js，
 * 把「仍然可见的 UI 元素」打出来。
 *
 * ★ 全程由本脚本自己落盘到 _inspect.txt ★
 *   经 PowerShell 调用时它的 stdout 会被吞、stderr 会中断后续语句，
 *   所以不要依赖控制台输出。
 *
 * 用法: node _inspect-lite.cjs <url|@文件> [waitMs]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const AB = "C:/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node_modules/agent-browser/bin/agent-browser-win32-x64.exe";
const NODE_DIR = "C:/Users/HP/.workbuddy/binaries/node/versions/24.21.0";

const out = [];
const P = (s) => out.push(s);
const flush = () => fs.writeFileSync(path.join(__dirname, "_inspect.txt"), out.join("\n"), "utf8");

let url = process.argv[2];
const waitMs = Number(process.argv[3] || 30000);
if (!url) { P("用法: node _inspect-lite.cjs <url|@文件> [waitMs]"); flush(); process.exit(2); }
if (url.charAt(0) === "@") url = fs.readFileSync(path.join(__dirname, url.slice(1)), "utf8").trim();

P("URL  : " + url);
P("wait : " + waitMs + "ms");
P("AB   : " + AB + "  exists=" + fs.existsSync(AB));

const env = Object.assign({}, process.env, {
  PATH: `${NODE_DIR};C:\\Windows\\System32;C:\\Windows`,
  // ★ CAD 页面很重（WASM 渲染），open 常常等不到 load 事件 ★
  //   默认给 45s 就够了 —— 反正我们后面还会自己 wait。设太大只会白等。
  AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AB_TIMEOUT || "45000",
});

function ab(args, label, timeoutMs) {
  const r = spawnSync(AB, args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, cwd: __dirname, timeout: timeoutMs || 300000 });
  const o = (r.stdout || "").trim();
  const e = (r.stderr || "").split(/\r?\n/).filter((l) => !/shell-runtime|dirname/.test(l)).join("\n").trim();
  P("\n========== " + label + "   exit=" + r.status + (r.error ? "  err=" + r.error.message : "") + " ==========");
  if (o) P(o);
  if (e) P("[stderr] " + e);
  flush();
  return o;
}

try {
  // ★ 先落一次盘：被外部杀掉时也能看到「跑到哪一步」★
  flush();
  // ★ open 必须给硬预算 ★
  //   CAD 页面里要拉 DWG 并用 WASM 渲染，load 事件很久（甚至不）触发，
  //   open 会一直挂着。agent-browser 的守护进程与 CLI 是分开的 ——
  //   把 CLI 掐掉，页面照样在守护进程里活着，后面的 eval/screenshot 完全不受影响。
  //   踩过：不设硬预算 ⇒ 整个脚本卡死在 open，一分钟也走不到 probe。
  ab(["open", url], "open", Number(process.env.AB_OPEN_MS || 45000));
  ab(["wait", String(waitMs)], "wait");

  const jsFile = process.env.NB_PROBE || "_probe/inspect-cad-menu.js";
  const js = fs.readFileSync(path.join(__dirname, jsFile), "utf8");
  const raw = ab(["eval", js], "probe(" + jsFile + ")");

  // ★ 截图：有些问题（画布被挤扁 / 白屏）看数字看不出来，得看图 ★
  if (process.env.NB_SHOT !== "0") {
    ab(["screenshot", process.env.NB_SHOT || "_lite-shot.png"], "screenshot");
  }

  // ★ 直接读 origin 的 localStorage（外壳页自己那层的）★
  if (process.env.NB_STORAGE !== "0") {
    ab(["storage", "local"], "storage-local");
  }

  // ★ agent-browser 把返回值当 JSON 字符串回给我们（\n 是转义的两字符）★
  //   直接写文件会得到「一整行」，Read 工具会截断。
  //   所以尝试 JSON.parse 还原真换行，逐行落盘。
  let pretty = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") pretty = parsed;
  } catch (e) { /* 原样 */ }
  P("\n---------- 展开后的探针输出 ----------");
  P(pretty);

  ab(["errors"], "page-errors");
} catch (e) {
  P("\n!!! 异常: " + e.message);
}
flush();

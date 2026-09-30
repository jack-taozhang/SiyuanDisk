/* ==========================================================================
 * 重启思源（干净退出 → 重新启动 → 等插件加载）
 * --------------------------------------------------------------------------
 * 为什么需要它
 *   思源只在**内核启动时**扫描 data/plugins/。装完插件必须完全重启才会生效，
 *   而手动「关窗口」在 Windows 上常常留下后台进程（托盘/残留 Electron 进程），
 *   导致下次启动直接复用旧进程 —— 插件永远不会被重新扫描。
 *
 * 它做什么
 *   1. 记录重启前日志的字节位置（用来只读**新增**部分，避免被历史 reload 行干扰）
 *   2. 优雅关闭（先按主窗口，让思源正常写盘、结束同步），超时才强杀
 *   3. 等内核端口断开，确认真的退干净了
 *   4. 用原路径重新拉起（WindowsApps 目录不能直接 spawn，要走 shell 激活）
 *   5. 轮询日志，等新的 `loaded petals` 出现，报告我们的插件在不在里面
 *
 * 用法：node tools/restart-siyuan.js
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

/**
 * 思源工作区根目录。
 *
 * ★★ 2026-09-30 修正：下面 EXE / LOG 原来都**写死**了 ★★
 *     · EXE = `…SiYuan_3.8.4.0_x64__…`   ← WindowsApps 目录名**带版本号**
 *     · LOG = `D:/Software/SiYuan/temp/siyuan.log`  ← 那是个**旧工作区**
 *   而本机真实工作区是 `E:/思源笔记`、思源已升到 3.8.6 ⇒ 两个常量同时失效。
 *   要命的是失败点在**重启那一刻**才以「找不到可执行文件」冒出来，
 *   很容易被当成"重启工具坏了"。
 *
 *   现在统一从 `<工作区>/conf/conf.json` 推导 —— 那是思源自己写的，
 *   永远与当前版本一致；也允许用 SIYUAN_HOME 环境变量覆盖工作区。
 */
const SIYUAN_HOME = process.env.SIYUAN_HOME || "E:/思源笔记";

/** 兜底路径：conf.json 读不到时才用（版本号可能过期，仅作最后手段） */
const FALLBACK_EXE =
  "C:\\Program Files\\WindowsApps\\89C2A984.SiYuan_3.8.6.0_x64__1qfd3tsw4ngc2\\app\\SiYuan.exe";

/**
 * 从 conf.json 的 `system.appDir` 反推可执行文件。
 * appDir 形如 `…\app\resources` ⇒ SiYuan.exe 在它的上一级。
 */
function resolveExe() {
  try {
    const conf = JSON.parse(
      fs.readFileSync(path.join(SIYUAN_HOME, "conf", "conf.json"), "utf8"),
    );
    const appDir = conf && conf.system && conf.system.appDir;
    if (appDir) {
      const p = path.join(appDir, "..", "SiYuan.exe");
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 落回兜底值 */ }
  return FALLBACK_EXE;
}

const EXE = resolveExe();
const LOG = path.join(SIYUAN_HOME, "temp", "siyuan.log");
const DIAG = path.join(SIYUAN_HOME, "temp", "nebuladisk.log");
const PLUGIN_NAME = "siyuan-nebuladisk";
const PORT = 6806;
const HOSTS = ["192.168.193.70", "127.0.0.1"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * onload() 有没有真的跑过。
 *
 * ★ 判据换过一次（2026-09-30）★
 *   以前探本地转发代理 :6810/__ping —— 代理在 onload 里启动，连得上就说明跑过。
 *   内置代理已整体删除，改为看插件诊断日志里有没有 `=== onload 开始 ===`。
 */
function probeOnload() {
  try {
    if (!fs.existsSync(DIAG)) return { up: false, code: "诊断日志不存在" };
    const tail = fs.readFileSync(DIAG, "utf8").slice(-4000);
    const m = tail.match(/=== onload 开始[^\n]*/);
    if (!m) return { up: false, code: "日志里没有 onload 记录" };
    return { up: true, status: m[0].trim() };
  } catch (e) {
    return { up: false, code: e.message };
  }
}

/* ------------------------------------------------------------------ 进程 */

function listSiYuanPids() {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 20000,
    });
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split('","').map((s) => s.replace(/^"/, "").replace(/"$/, "")))
      .filter((r) => /^siyuan(-kernel)?\.exe$/i.test(r[0]))
      .map((r) => ({ name: r[0], pid: parseInt(r[1], 10) }));
  } catch {
    return [];
  }
}

/** 先优雅关闭：给主窗口发 WM_CLOSE，让思源正常落盘；WindowsApps 下的进程不能直接 taskkill /F 先打头阵 */
function gracefulClose() {
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  // ★ 多条语句必须用 **换行** 分隔。用空格 join 会让 New-Object 把下一条当成位置参数。
  const script = [
    "$procs = Get-Process SiYuan -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }",
    "foreach ($p in $procs) { $null = $p.CloseMainWindow() }",
    "Write-Output ('closed=' + @($procs).Count)",
  ].join("\n");
  try {
    const out = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 30000,
    });
    return out.trim();
  } catch (e) {
    return "ERR " + (e.stdout || e.message || "").toString().slice(0, 120);
  }
}

function forceKill() {
  // 先温和地请所有实例退出（不带 /F），给内核一点收尾时间
  for (const p of listSiYuanPids()) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid)], {
        encoding: "utf8", timeout: 15000, stdio: "ignore",
      });
    } catch { /* 已退出 */ }
  }
}

function forceKillHard() {
  for (const p of listSiYuanPids()) {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(p.pid)], {
        encoding: "utf8", timeout: 15000, stdio: "ignore",
      });
    } catch { /* 已退出 */ }
  }
}

/* ------------------------------------------------------------------ 网络 */

function probe(host, port, p) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get({ host, port, path: p, timeout: 1500 }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => fin({ up: true, status: res.statusCode, body: b }));
      });
      req.on("error", () => fin({ up: false }));
      req.on("timeout", () => { req.destroy(); fin({ up: false }); });
    } catch {
      fin({ up: false });
    }
  });
}

async function kernelAlive() {
  for (const h of HOSTS) {
    const r = await probe(h, PORT, "/api/system/version");
    if (r.up) return h;
  }
  return null;
}

/* -------------------------------------------------------------------- 日志 */

/** 返回当前日志字节数 —— 之后只读这之后的增量 */
function logMark() {
  try { return fs.statSync(LOG).size; } catch { return 0; }
}

/** 读 [mark, EOF) 的日志，分析里面的 loaded petals */
function readNewLog(mark) {
  try {
    const fd = fs.openSync(LOG, "r");
    const size = fs.fstatSync(fd).size;
    const len = size - mark;
    if (len <= 0) { fs.closeSync(fd); return ""; }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, mark);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/* -------------------------------------------------------------------- 主流程 */

(async () => {
  console.log("\n============ 重启思源以加载 NebulaDisk 插件 ============\n");

  // 记录起点
  const mark = logMark();
  console.log(`日志起点: byte ${mark}`);

  const before = listSiYuanPids();
  console.log(`重启前进程: ${before.length} 个 (${before.map((p) => p.pid).join(", ") || "无"})`);

  // ---- 1. 优雅关闭 ----
  if (before.length) {
    console.log("\n[1/4] 正在优雅关闭思源（先让它保存数据、结束同步）...");
    console.log("      关闭请求: " + gracefulClose());
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      if (!listSiYuanPids().length) break;
    }
    // ---- 2. 兜底：先温和 /PID，再 /F ----
    if (listSiYuanPids().length) {
      console.log(`      仍有 ${listSiYuanPids().length} 个进程，发送结束请求...`);
      forceKill();
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        if (!listSiYuanPids().length) break;
      }
    }
    if (listSiYuanPids().length) {
      console.log(`      仍在运行，强制结束...`);
      forceKillHard();
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        if (!listSiYuanPids().length) break;
      }
    }
    const still = listSiYuanPids();
    if (still.length) {
      console.log(`      ❌ 仍有进程残留: ${still.map((p) => p.pid).join(", ")}`);
      console.log("      → 请手动在任务管理器结束 SiYuan.exe / SiYuan-Kernel.exe 后重跑本脚本。");
      return;
    }
    console.log("      ✅ 已完全退出");
  } else {
    console.log("\n[1/4] 思源本来就没在运行，跳过关闭");
  }

  // 等端口彻底释放，否则新实例可能被旧 socket 挡住
  for (let i = 0; i < 15; i++) {
    if (!(await kernelAlive())) break;
    await sleep(1000);
  }

  // ---- 3. 重新启动 ----
  console.log("\n[2/4] 正在重新启动思源...");
  if (!fs.existsSync(EXE)) {
    console.log(`      ❌ 找不到可执行文件: ${EXE}`);
    console.log("      → 请手动打开思源，然后重跑 verify-install.js");
    return;
  }
  try {
    // WindowsApps 下的 exe 直接 spawn 会被 ACL 拦住 → 交给 explorer 做 shell 激活
    execFileSync("explorer.exe", [EXE], { timeout: 15000, stdio: "ignore" });
  } catch {
    /* explorer 常常返回非 0，不代表失败 */
  }

  console.log("\n[3/4] 等待内核起来...");
  let host = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    host = await kernelAlive();
    if (host) break;
  }
  if (!host) {
    console.log("      ❌ 90 秒内内核未就绪 —— 请手动确认思源已打开");
    return;
  }
  console.log(`      ✅ 内核在线: ${host}:${PORT}`);

  // ---- 4. 等插件扫描 ----
  console.log("\n[4/4] 等待插件扫描（loaded petals）...");
  let petals = null;
  let petalsTime = "";
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const txt = readNewLog(mark);
    const hits = txt
      .split("\n")
      .filter((l) => /loaded petals/.test(l) && !/isKernel=true/.test(l));
    if (hits.length) {
      const last = hits[hits.length - 1];
      petalsTime = (last.match(/(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || "?";
      const list = (last.match(/petals=\[([^\]]*)\]/) || [, ""])[1];
      petals = list.split(",").map((s) => s.trim()).filter(Boolean);
      break;
    }
  }

  // onload 探活 —— 真的跑过才会往诊断日志写 `=== onload 开始 ===`
  const probe = probeOnload();

  console.log("\n==================== 结果 ====================\n");
  if (petals) {
    console.log(`新一次启动扫描 @ ${petalsTime}，共 ${petals.length} 个插件`);
    if (petals.includes(PLUGIN_NAME)) {
      console.log(`✅ ★ ${PLUGIN_NAME} 在启动扫描列表里 —— 已加载`);
    } else {
      console.log(`❌ ★ ${PLUGIN_NAME} 不在启动扫描列表里`);
    }
  } else {
    console.log("⚠️  没等到新的 loaded petals（可能还在启动）。稍后跑 verify-install.js 复核。");
  }

  if (probe.up) {
    console.log(`✅ 插件诊断日志有 onload 记录：${probe.status} ⇒ onload() 已执行`);
    console.log("\n👉 现在看思源：**右侧**边栏应该出现「NebulaDisk」图标");
    console.log("   （也可以在「插件」右键菜单里找 NebulaDisk）");
  } else {
    console.log(`❌ 诊断日志无 onload 记录（${probe.code}）⇒ onload() 没有执行`);
    console.log("   → 把浏览器开发者控制台（Ctrl+Shift+I）里以 `plugin siyuan-nebuladisk run error` 开头的报错发给我");
  }
  console.log();
})();

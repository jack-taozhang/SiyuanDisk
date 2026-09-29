/* 提交前闸门：已跟踪文件里是否混入**明文口令**（致命）或**机器专属绝对路径**（警告）
 *
 * 为什么需要（本项目真实发生过的重复性错误）：
 *   「新写脚本硬编码口令」已经犯过多次（一次 5 个脚本，2026-09-29 又 1 个）。
 *   而 `git grep` 只查**已跟踪**文件 —— 新写的探针在 `git add` 之前根本查不到，
 *   等发现时往往已经推上公开仓库了。
 *   ⇒ 把「推送前扫一遍」从**人的记忆**变成**可执行的一道闸门**。
 *
 * 分级（重要：永远报错的闸门等于没有闸门）：
 *   ★ 致命：含明文口令  → 退出码 1，**不要推送**
 *     · 口令值从 tools/.nb-local.json（已被 .gitignore 排除）读，本文件不含任何明文
 *   · 警告：机器专属绝对路径 → 只统计并举例，退出码 0
 *     原因：仓库里**本来就有**合法用法 —— 测试夹具需要 `C:/Users/HP/Desktop`
 *     这样的字符串来验路径截断逻辑；部分老工具留了 `C:/temp-*` 作为可选兜底路径。
 *     这些是要慢慢收敛的历史债，不该把每一次推送都卡死。
 *
 * 用法：
 *   node tools/check-secrets.cjs           # 扫已跟踪文件（默认）
 *   node tools/check-secrets.cjs --staged  # 只扫暂存集合（git diff --cached 同义）
 * 退出码：0 = 无口令泄漏（可能有路径警告 / 可能未检查，见输出里的 ⚠️）；1 = 发现明文口令
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const LOCAL = path.join(__dirname, ".nb-local.json");

/* 读本机口令 —— **不写进本文件**。读不到则「口令」这一项**无法检查**（不是通过）。 */
function readSecrets() {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL, "utf8"));
    for (const k of ["pass", "authCode"]) {
      const v = j[k];
      if (typeof v === "string" && v.trim().length >= 4) out.push({ key: k, val: v.trim() });
    }
  } catch (e) { /* 见 main() 的提示 */ }
  const envPass = process.env.NB_PASS;
  if (envPass && envPass.length >= 4 && !out.some((o) => o.val === envPass)) {
    out.push({ key: "env:NB_PASS", val: envPass });
  }
  return out;
}

/* 机器专属路径：警告级 */
const PATH_RULES = [
  { name: "本机绝对路径 D:/Docker", re: /D:[\\/]Docker/ },
  { name: "本机绝对路径 C:/temp-*", re: /C:[\\/]temp[-\\/]/i },
  { name: "用户目录绝对路径", re: /(?:C:[\\/]Users|\/Users)\/[A-Za-z0-9._-]+/ },
];

/* 文件级白名单（写清理由，避免误伤） */
const ALLOW = [
  { file: "tools/.nb-local.json.example", why: "配置模板，值全是中文占位说明" },
  { file: "tools/check-secrets.cjs", why: "本检查脚本自身，规则里必然出现这些路径形态" },
];

function listFiles(stagedOnly) {
  const args = stagedOnly
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files"];
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function main() {
  const stagedOnly = process.argv.includes("--staged");
  const secrets = readSecrets();

  console.log("=".repeat(62));
  console.log("凭据闸门  ——  " + (stagedOnly ? "暂存集合" : "已跟踪文件"));
  console.log("=".repeat(62));

  const files = listFiles(stagedOnly).filter((f) => !ALLOW.some((a) => a.file === f));
  console.log("待扫 " + files.length + " 个文件" +
              (secrets.length ? "；口令项: " + secrets.map((s) => s.key).join(", ") + "（值不打印）"
                              : "；⚠️ 未取到口令，该项**无法检查**"));
  console.log();

  const secretHits = [];
  const pathHits = [];
  const cache = new Map();

  for (const f of files) {
    let text;
    try { text = cache.get(f) || fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { continue; }
    if (text.indexOf("\u0000") >= 0) continue;                 // 二进制
    cache.set(f, text);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      for (const s of secrets) {
        if (ln.includes(s.val)) secretHits.push({ f, n: i + 1, key: s.key, ln });
      }
      for (const r of PATH_RULES) {
        if (r.re.test(ln)) pathHits.push({ f, n: i + 1, name: r.name, ln });
      }
    }
  }

  if (secretHits.length) {
    console.log("❌ 致命：发现 " + secretHits.length + " 处**明文口令** —— 不要推送\n");
    // ★ 打印时把口令打码：文件:行 已经足够定位，没必要再把密文抄进终端/日志/截图
    const mask = (s, val) => s.split(val).join("«已隐藏»");
    for (const h of secretHits.slice(0, 30)) {
      const shown = mask(h.ln.trim(), (secrets.find((x) => x.key === h.key) || {}).val || "");
      console.log("  " + h.f + ":" + h.n + "   (" + h.key + ")");
      console.log("    " + shown.slice(0, 140));
    }
    if (secretHits.length > 30) console.log("\n  …还有 " + (secretHits.length - 30) + " 处");
    console.log("\n修法：口令一律走 require(\"./_secrets.cjs\") 或 require(\"./_local.cjs\")，");
    console.log("      绝不写字面量。见本文件顶部说明与工作记忆里的「安全铁律」。");
  } else if (secrets.length) {
    console.log("✅ 致命项：未发现明文口令");
  } else {
    console.log("⚠️ 致命项：**未能检查**（没有 tools/.nb-local.json 或 NB_PASS）");
    console.log("   复制 tools/.nb-local.json.example 为 tools/.nb-local.json 并填写后重跑，");
    console.log("   否则这道闸门对「口令泄漏」是瞎的。");
  }

  if (pathHits.length) {
    const byRule = {};
    for (const h of pathHits) (byRule[h.name] = byRule[h.name] || []).push(h);
    console.log("\n· 警告：机器专属绝对路径 " + pathHits.length + " 处（不阻塞）");
    for (const [name, arr] of Object.entries(byRule)) {
      const fs2 = [...new Set(arr.map((a) => a.f))];
      console.log("    " + name + "：" + arr.length + " 处，涉及 " + fs2.length + " 个文件");
      if (name === "本机绝对路径 D:/Docker") {
        // 这一类是真债，给具体位置；其余只给数量，避免刷屏
        for (const a of arr.slice(0, 8)) console.log("       " + a.f + ":" + a.n);
        if (arr.length > 8) console.log("       …还有 " + (arr.length - 8) + " 处");
      }
    }
    console.log("    （历史债：测试夹具里的路径字符串是**故意**的；老工具的可选兜底路径可逐步收敛）");
  }

  console.log();
  if (secretHits.length) return 1;
  return 0;   // 「未发现」与「未检查」都是 0：后者已在上面用 ⚠️ 明确标出，
              //   且新克隆的仓库本来就没有 .nb-local.json，不该因此让 npm test 变红。
}

/* ★ 输出一行「通过 N 失败 M」，让 tools/run-all-tests.cjs 能稳定解析本套结果 ★
   （它同时兼容「通过 N   失败 M」/「结果: N 通过, M 失败」两种写法。
     本套只有一个检查维度，所以 N/M 取 1/0 或 0/1。） */
const code = main();
console.log("结果: " + (code === 0 ? "1 通过, 0 失败" : "0 通过, 1 失败"));
process.exitCode = code;

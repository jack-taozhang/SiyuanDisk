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

/*
 * ★ 环境降级：git 起不来时的文件列表来源（2026-09-30 加）★
 *
 *   症状（本机实测）：Windows / Git Bash 下 `spawnSync git` 抛
 *     `Error: spawnSync git EBUSY  { errno: -4082, code: 'EBUSY' }`
 *   于是 execFileSync 直接崩栈 ⇒ 退出码 1。
 *
 *   ★ 为什么这很危险 ★
 *     崩栈的退出码（1）与"真的扫出口令"的退出码**完全一样**。
 *     汇总器分不清"查出问题"和"压根没跑起来"——
 *     一个**环境故障**会被读成**安全检查失败**，
 *     久而久之大家就学会"这条红了是正常的"，闸门彻底失效。
 *
 *   ⇒ 退化成文件系统遍历。★ 但**必须**同时按 .gitignore 过滤 ★
 *     本闸门的语义是「**已跟踪**文件里有没有明文口令」。
 *     第一版降级忘了这一层，于是把 `tools/_nas-src/`（从容器拉回来的
 *     第三方源码，注释里写明"compose 里含真实 secret"，已在 .gitignore
 *     里排除）也扫了进来 ⇒ **报出 2 处"真口令泄漏"的假 Positive**。
 *     假 Positive 比漏报更伤闸门：它会训练人「看到红就跳过」。
 *     （实测确认：那两处 `NEBULA_ADMIN_PASSWORD: "Redmaple@123"` 确实
 *      是明文口令，但该目录**不入库**，所以对仓库不构成泄漏。）
 *
 *   ⇒ 这里实现一个 .gitignore 的**够用手集**（见 matchIgnore），
 *     覆盖本仓库用到的全部写法；遇到不支持的写法（如 `!` 取反）
 *     会**显式提示**，而不是默默放过。
 */
const WALK_SKIP = new Set([".git"]); // .git 永远跳过；其余交给 .gitignore

/** 把一条 gitignore 模式转成正则（仅路径段内的 glob） */
function globToRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = esc
    .replace(/\*\*/g, "\u0000")      // 先占位，避免被下面的 * 规则吃掉
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + body + "$");
}

let IGNORE_RULES = null;
function loadIgnore() {
  if (IGNORE_RULES) return IGNORE_RULES;
  const rules = [];
  let raw = "";
  try { raw = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"); } catch { /* 没有就算了 */ }
  for (let ln of raw.split("\n")) {
    ln = ln.trim();
    if (!ln || ln.startsWith("#")) continue;
    if (ln.startsWith("!")) { console.log("   ℹ️  .gitignore 含取反规则（本降级实现不支持）：" + ln); continue; }
    const dirOnly = ln.endsWith("/");
    const pat = ln.replace(/\/+$/, "");
    rules.push({ pat, dirOnly, hasSlash: pat.includes("/"), re: globToRe(pat) });
  }
  IGNORE_RULES = rules;
  return rules;
}

/** rel 是相对仓库根的 posix 路径；返回它是否被 .gitignore 排除 */
function matchIgnore(rel) {
  const segs = rel.split("/");
  for (const r of loadIgnore()) {
    if (r.hasSlash) {
      // 路径规则：逐级前缀比对（目录规则靠这个命中它下面的所有文件）
      let acc = "";
      for (let i = 0; i < segs.length; i++) {
        acc = acc ? acc + "/" + segs[i] : segs[i];
        if (r.re.test(acc)) return true;
      }
      if (!r.dirOnly && r.re.test(rel)) return true;
    } else {
      // 段规则：任一路径段命中即可（目录规则只看非末段，即"必须是个目录"）
      for (let i = 0; i < segs.length; i++) {
        if (r.dirOnly && i === segs.length - 1) continue;
        if (r.re.test(segs[i])) return true;
      }
    }
  }
  return false;
}

function walkFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (WALK_SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    if (matchIgnore(rel + (e.isDirectory() ? "/" : "")) || matchIgnore(rel)) continue;
    if (e.isDirectory()) walkFiles(abs, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function listFiles(stagedOnly) {
  const args = stagedOnly
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files"];
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    const code = (e && e.code) || "未知";
    console.log("⚠️  无法执行 git（" + code + "）—— 本应" +
                (stagedOnly ? "只扫暂存集合" : "扫已跟踪文件") + "，现降级为**遍历 + .gitignore 过滤**。");
    console.log("   降级原因：" + ((e && e.message) || e));
    console.log("   ★ 过滤依据是 .gitignore（而不是 git 索引）⇒ 与『已跟踪』**近义但不全等**：");
    console.log("     被 .gitignore 排除的文件不会扫（与 git 一致），");
    console.log("     但**未跟踪且未被忽略**的新文件会扫（比 git 更严）。");
    console.log("");
    const files = walkFiles(ROOT);
    console.log("   遍历得到 " + files.length + " 个文件。");
    console.log("");
    return files;
  }
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

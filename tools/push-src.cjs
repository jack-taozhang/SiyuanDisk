/**
 * 把本机 3 个改过的后端文件推送到 NAS 源码目录。
 *
 * 流程：
 *   1) 远端把原文件备份成 .bak-<时间戳>
 *   2) 通过 stdin 管道把文件内容写进远端（避免 base64 膨胀与引号地狱）
 *   3) 远端 python3 -m py_compile 语法校验
 *
 * 用法：node push-src.cjs [--dry]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ★ 一律用正斜杠的 Windows 原生路径 ★
//   传参给 Node/Windows 程序时，/c/... 会被识别成「当前盘根下的 c 目录」。
const LOCAL_ROOT = "D:/Docker/kkFileView/nebula/app";
const REMOTE_ROOT = "/vol1/1000/Docker/NebulaDisk/nebula/app";
const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";

const FILES = [
  "routers/preview.py",
  "routers/cad.py",
  "routers/onlyoffice.py",
];

const DRY = process.argv.includes("--dry");

/** 跑一条远端命令，stdin 可选 */
function ssh(cmd, stdin) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
    input: stdin,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: r.stdout || "", err: r.stderr || "", code: r.status };
}

function ts() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const stamp = ts();
console.log(`时间戳: ${stamp}${DRY ? "  [DRY-RUN]" : ""}\n`);

// ---- 1) 备份 ----
for (const rel of FILES) {
  const remote = `${REMOTE_ROOT}/${rel}`;
  const cmd = `cp -p '${remote}' '${remote}.bak-${stamp}' && echo "已备份 ${rel} -> ${rel}.bak-${stamp}"`;
  if (DRY) {
    console.log(`[dry] ${cmd}`);
    continue;
  }
  const r = ssh(cmd);
  process.stdout.write(r.out);
  if (r.err.trim()) process.stderr.write(r.err);
}

if (DRY) {
  console.log("\n（dry-run，未推送）");
  process.exit(0);
}

// ---- 2) 推送 ----
console.log("");
const results = [];
for (const rel of FILES) {
  const local = path.join(LOCAL_ROOT, rel);
  const remote = `${REMOTE_ROOT}/${rel}`;
  const body = fs.readFileSync(local);
  // 用 cat > 文件 的方式写入：内容走 stdin，远端不经 shell 解析引号
  const r = ssh(`cat > '${remote}' && wc -c < '${remote}'`, body);
  const written = parseInt(r.out.trim(), 10);
  const ok = written === body.length;
  results.push({ rel, local: body.length, written, ok });
  console.log(`${ok ? "✓" : "✗"} ${rel}  本机 ${body.length}B → 远端 ${written}B`);
  if (r.err.trim()) process.stderr.write(r.err);
}

// ---- 3) 语法校验 ----
console.log("");
const pyr = ssh(
  `cd /vol1/1000/Docker/NebulaDisk/nebula && python3 -m py_compile ${FILES
    .map((f) => `app/${f}`)
    .join(" ")} && echo SYNTAX_OK`
);
process.stdout.write(pyr.out);
if (pyr.err.trim()) process.stderr.write(pyr.err);

const allOk = results.every((x) => x.ok) && pyr.out.includes("SYNTAX_OK");
console.log("");
console.log(allOk ? "✅ 推送完成且语法校验通过" : "❌ 推送或校验失败，请检查");
process.exit(allOk ? 0 : 1);

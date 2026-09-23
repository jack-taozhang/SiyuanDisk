/**
 * 对比本机与 NAS 上 nebula/app 的文件差异（大小 + mtime + 可选 hash）。
 *
 * 目的：在覆盖 NAS 源码前，先确认两边结构一致、并找出 NAS 侧独有的改动，
 * 避免把用户在 NAS 上手改的内容冲掉。
 *
 * 用法：node compare-src.cjs
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL_ROOT = "D:/Docker/kkFileView/nebula";
const REMOTE_ROOT = "/vol1/1000/Docker/NebulaDisk/nebula";
const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";

function ssh(cmd) {
  const r = spawnSync(process.execPath, [SSH, cmd], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout || "");
}

// ---- 本机：递归收集 nebula/app 下所有 .py 的相对路径 ----
function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "__pycache__") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ rel: path.relative(base, full).replace(/\\/g, "/"), size: st.size });
  }
}

const localFiles = [];
walk(path.join(LOCAL_ROOT, "app"), path.join(LOCAL_ROOT, "app"), localFiles);
localFiles.sort((a, b) => a.rel.localeCompare(b.rel));

// ---- 远端：用一条 find 命令拿到 size + mtime ----
const remoteRaw = ssh(
  `cd ${REMOTE_ROOT}/app && find . -type f -name '*.py' -printf '%s\\t%p\\n' | sed 's|^\\([0-9]*\\)\\t\\./|\\1\\t|'`
);
const remoteMap = new Map();
for (const line of remoteRaw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [sz, rel] = line.split("\t");
  if (rel) remoteMap.set(rel, Number(sz));
}

console.log(`本机 app 下 .py 文件: ${localFiles.length}`);
console.log(`远端 app 下 .py 文件: ${remoteMap.size}`);
console.log("");

console.log("=== 大小不一致（或远端缺失）的文件 ===");
let diff = 0;
for (const f of localFiles) {
  const r = remoteMap.get(f.rel);
  if (r === undefined) {
    console.log(`  [远端缺失] ${f.rel}  (本机 ${f.size}B)`);
    diff++;
  } else if (r !== f.size) {
    console.log(`  [大小不同] ${f.rel}  本机 ${f.size}B / 远端 ${r}B`);
    diff++;
  }
}

console.log("");
console.log("=== 远端独有的文件（本机没有）===");
const localSet = new Set(localFiles.map((f) => f.rel));
let onlyRemote = 0;
for (const [rel, sz] of remoteMap) {
  if (!localSet.has(rel)) {
    console.log(`  [仅远端] ${rel}  ${sz}B`);
    onlyRemote++;
  }
}
if (!diff && !onlyRemote) console.log("  （无）");
console.log("");
console.log(`小结：差异文件 ${diff} 个，远端独有 ${onlyRemote} 个`);

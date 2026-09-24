/**
 * 从 NAS 拉任意文件（base64）。用法:
 *   node _pull-bin.cjs <远端路径> <本地路径>            # 宿主文件（sudo）
 *   node _pull-bin.cjs <容器> <容器内路径> <本地路径>   # 容器内文件
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const a = process.argv.slice(2);
let remote, sizeCmd, label;
if (a.length === 3) {
  remote = `${SUDO}docker exec ${a[0]} base64 '${a[1]}'`;
  sizeCmd = `${SUDO}docker exec ${a[0]} wc -c < '${a[1]}'`;
  label = a[0] + ":" + a[1];
} else if (a.length === 2) {
  remote = `${SUDO}base64 -w0 '${a[0]}'`;
  sizeCmd = `${SUDO}wc -c < '${a[0]}'`;
  label = a[0];
} else {
  console.error("用法: node _pull-bin.cjs [容器] <远端路径> <本地路径>");
  process.exit(2);
}
const local = a[a.length - 1];

function run(cmd) {
  return spawnSync(process.execPath, [path.join(__dirname, "ssh-nb.cjs"), cmd], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// ★ 先问远端有多大，拉完必须对得上 ★
//   否则静默截断（maxBuffer 太小）会给出一个「看着正常、其实缺尾」的文件。
const rs = run(sizeCmd);
const remoteSize = parseInt(String(rs.stdout || "").trim(), 10);

const r = run(remote);
const out = String(r.stdout || "").replace(/\s+/g, "");
if (!out) {
  console.error("远端无输出（退出码 " + r.status + "）", String(r.stderr || "").slice(0, 300));
  process.exit(1);
}
const buf = Buffer.from(out, "base64");
fs.writeFileSync(local, buf);

console.log(`已拉取 ← ${label}`);
console.log(`  → ${local} (${buf.length}B)`);
if (Number.isFinite(remoteSize)) {
  console.log(`  远端 ${remoteSize}B  ${remoteSize === buf.length ? "✅ 一致" : "❌ 不一致（被截断！）"}`);
  if (remoteSize !== buf.length) process.exit(1);
} else {
  console.log("  ⚠️ 没拿到远端大小，未做校验");
}

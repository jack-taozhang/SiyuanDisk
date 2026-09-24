/**
 * 从 NAS 拉取文本文件（base64 传输，防 SSH 噪声与编码损坏）。
 * 用法: node _pull-remote.cjs <远端路径> <本地路径>
 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const remote = process.argv[2];
const local = process.argv[3];
if (!remote || !local) { console.error("用法: node _pull-remote.cjs <远端> <本地>"); process.exit(2); }

const r = spawnSync(process.execPath, ["./ssh-nb.cjs", `${SUDO}base64 -w0 '${remote}'`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const out = String(r.stdout || "").replace(/\s+/g, "");
if (!out) { console.error("远端无输出（退出码 " + r.status + "）"); process.exit(1); }
const buf = Buffer.from(out, "base64");
fs.writeFileSync(local, buf);
console.log(`已拉取 ${remote} → ${local} (${buf.length}B, sha256=${require("crypto").createHash("sha256").update(buf).digest("hex").slice(0, 12)})`);

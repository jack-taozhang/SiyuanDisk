/**
 * 把本地文件推到 NAS 指定路径（base64 传输，避免编码/引号问题）。
 * 用法: node _push-file.cjs <本地路径> <远端路径>
 *   远端会先留一份 .bak-<时间戳>（设 NB_NOBAK=1 可跳过）。
 * 适合中小文件（<~200KB）。大文件请用 _push-big.cjs。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const [local, remote] = process.argv.slice(2);
if (!local || !remote) { console.error("用法: node _push-file.cjs <本地> <远端>"); process.exit(2); }

const buf = fs.readFileSync(local);
const b64 = buf.toString("base64");
const localMd5 = crypto.createHash("md5").update(buf).digest("hex");
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function ssh(cmd, input) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "ssh-nb.cjs"), cmd],
    { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  return { out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}

if (!process.env.NB_NOBAK) {
  const b = ssh(`${SUDO}sh -c 'cp -a "${remote}" "${remote}.bak-${ts}" 2>/dev/null; echo ok'`);
  console.log("远端备份 ->", `${remote}.bak-${ts}`, b.out || b.err);
}

if (b64.length > 90000) {
  console.error("base64 过长（" + b64.length + "），请改用分块推送。");
  process.exit(3);
}

const r = ssh(`${SUDO}sh -c 'printf %s ${b64} | base64 -d > "${remote}"; md5sum "${remote}"'`);
console.log("远端写入:", r.out || r.err);
console.log("本地 md5:", localMd5);
if (!r.out.includes(localMd5)) { console.error("!! md5 不一致 !!"); process.exit(1); }
console.log("md5 一致 ✅");

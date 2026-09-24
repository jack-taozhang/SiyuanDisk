/**
 * 推送单个文件到 NAS（源码目录 + nebula 容器内 /opt/nebula）。
 * base64 分块传输（24KB/块，见 MEMORY §七：绝不用 stdin）。
 * 用法: node _push-nebula-patch.cjs <本地文件> <远端绝对路径> <容器内绝对路径>
 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const [local, remotePath, containerPath] = process.argv.slice(2);
if (!local || !remotePath || !containerPath) {
  console.error("用法: node _push-nebula-patch.cjs <本地> <远端路径> <容器内路径>");
  process.exit(2);
}

function ssh(cmd) {
  const r = spawnSync(process.execPath, ["./ssh-nb.cjs", cmd],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("ssh 失败: " + cmd + "\n" + (r.stderr || ""));
  return r.stdout || "";
}

const b64 = fs.readFileSync(local).toString("base64");
const tmp = "/tmp/_nb_patch_" + Date.now();
const CHUNK = 24 * 1024;
for (let off = 0, seg = 0; off < b64.length; off += CHUNK, seg++) {
  ssh(`printf '%s' '${b64.slice(off, off + CHUNK)}' >> ${tmp}`);
}
ssh(`${SUDO}base64 -d ${tmp} > ${remotePath} && rm -f ${tmp}`);
// 校验源码侧 md5
const crypto = require("crypto");
const localMd5 = crypto.createHash("md5").update(fs.readFileSync(local)).digest("hex");
const srcMd5 = ssh(`${SUDO}md5sum '${remotePath}'`).trim().split(/\s+/)[0];
if (srcMd5 !== localMd5) throw new Error(`源码 md5 不一致: 本地=${localMd5} 远端=${srcMd5}`);
console.log(`源码已更新并校验: ${remotePath} (${srcMd5})`);

// 备份容器内旧文件 → docker cp 新文件
//   ★ 备份名带时间戳 ★
//     原来写死 `.bak_20260924`，同一天第二次推送会把第一次的备份覆盖掉 ——
//     而那一次备份往往正是「回滚到改动前」唯一的那份。
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
ssh(`${SUDO}docker exec nebula sh -c "cp '${containerPath}' '${containerPath}.bak-${ts}'"`);
ssh(`${SUDO}docker cp '${remotePath}' nebula:'${containerPath}'`);
const cMd5 = ssh(`${SUDO}docker exec nebula md5sum '${containerPath}'`).trim().split(/\s+/)[0];
if (cMd5 !== localMd5) throw new Error(`容器内 md5 不一致: 本地=${localMd5} 容器=${cMd5}`);
console.log(`容器已补丁并校验: ${containerPath} (${cMd5})`);
console.log(`容器内备份: ${containerPath}.bak-${ts}`);

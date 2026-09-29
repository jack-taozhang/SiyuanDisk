/**
 * 把本地打包好的插件上传到 NAS 上思源（Docker）的 plugins 目录。
 *
 * 目标工作区（在 NAS 上）：
 *   /vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-nebuladisk/
 *
 * 思源容器以 root 跑，plugins 目录属主是 siyuan:siyuan，宿主侧写入后会
 * 变成当前 SSH 用户（tao_zhang）。思源读插件只要求可读，所以无需 chown；
 * 但为了让思源之后自己写的文件（比如安装/更新、petal 设置）不出权限问题，
 * 上传后统一 chmod 644/755。
 *
 * ★ 传输方式沿用 base64 + 命令行参数 ★
 *   绝不用 stdin —— askpass 会把它抢走，导致文件被清成 0 字节。
 *
 * 用法：node push-plugin.cjs
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const LOCAL_DIR = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk";
const REMOTE_DIR =
  "/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-nebuladisk";

// ★ 2026-09-28 实测：本脚本在当前环境**已不可用**，请改用 push-to-nas.py ★
//   两个独立故障叠加：
//     1) spawnSync(ssh.exe) 一律 EBUSY（沙箱 LiteSandbox 拦子进程，连 cmd.exe 都起不来）
//     2) 直接跑 ssh.exe 会 `ssh_askpass: pipe: Unknown error` → 密码读不进来
//        （.sh/.bat/.cmd 三种助手报错相同，关沙箱也一样）
//   → 用 tools/nbssh.py（paramiko，纯 Python，不经 Windows 管道）+ tools/push-to-nas.py
//
//   下面这行 SSH 常量原指向 D:/Docker/SiyuanDisk/...（**该目录不存在**），已修正为
//   D:/Docker/Siyuan/...，但即便路径对了，上面两个故障仍会让它失败。
const SSH = "D:/Docker/Siyuan/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";

// 必须是打包产物里真实存在的文件（不含 src/、tools/）
const FILES = [
  "index.js",
  "plugin.json",
  "index.css",
  "icon.png",
  "README.md",
  "README.zh_CN.md",
  "i18n/zh_CN.json",
];

const CHUNK = 24 * 1024;

function ssh(cmd) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: r.stdout || "", err: r.stderr || "", code: r.status };
}

const TMP = `/tmp/nb-plugin-${Date.now()}`;
ssh(`rm -rf ${TMP} && mkdir -p ${TMP}`);

// 目标目录：先建好 i18n
console.log("=== 准备远端目录 ===");
const mk = ssh(`mkdir -p '${REMOTE_DIR}/i18n' && echo ok`);
console.log(mk.out.trim() || mk.err.trim());

console.log("\n=== 上传文件 ===");
let allOk = true;

for (const rel of FILES) {
  const local = path.join(LOCAL_DIR, rel);
  if (!fs.existsSync(local)) {
    console.log(`✗ ${rel}  本地不存在，跳过`);
    allOk = false;
    continue;
  }
  const buf = fs.readFileSync(local);
  const b64 = buf.toString("base64");
  const safe = rel.replace(/[\/]/g, "__");
  const b64file = `${TMP}/${safe}.b64`;

  let off = 0;
  while (off < b64.length) {
    const chunk = b64.slice(off, off + CHUNK);
    ssh(`printf '%s' '${chunk}' >> ${b64file}`);
    off += CHUNK;
  }

  const remote = `${REMOTE_DIR}/${rel}`;
  const r = ssh(
    `base64 -d ${b64file} > '${remote}' && chmod 644 '${remote}' && wc -c < '${remote}'`
  );
  const written = parseInt(r.out.trim(), 10);
  const lhash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const rhash = ssh(`sha256sum '${remote}' | cut -c1-16`).out.trim();
  const ok = written === buf.length && rhash === lhash;
  if (!ok) allOk = false;
  console.log(
    `${ok ? "✓" : "✗"} ${rel.padEnd(20)} ${String(buf.length).padStart(7)}B  sha ${lhash}${ok ? "" : " vs " + rhash}`
  );
}

// 目录可读
ssh(`chmod -R a+rX '${REMOTE_DIR}'`);
ssh(`rm -rf ${TMP}`);

console.log("\n=== 远端结果 ===");
const ls = ssh(`ls -la '${REMOTE_DIR}' '${REMOTE_DIR}/i18n'`);
process.stdout.write(ls.out);

console.log(allOk ? "✅ 插件已上传到 NAS 思源" : "❌ 有文件校验失败");
process.exit(allOk ? 0 : 1);

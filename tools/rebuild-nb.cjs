/**
 * 在 NAS 上重建 nebula:1.0.0 镜像，并把改动固化进去。
 *
 * 策略：走 nebula/build.sh。因为源码与镜像的差异只有 nebula/app 下几个 .py，
 * Docker 会复用 apt/pip/kkFileView 那些层，只重跑 COPY app + compileall。
 *
 * ★ 构建前先打快照 ★
 *   记录当前镜像 ID 与容器使用的镜像，万一新镜像有问题可以回滚。
 *
 * 用法：
 *   node rebuild-nb.cjs --check   只做构建前检查
 *   node rebuild-nb.cjs           真正构建（后台，日志写文件）
 *   node rebuild-nb.cjs --tail    看构建进度
 */
const { spawnSync } = require("child_process");

const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";
const { SUDO } = require("./_secrets.cjs");
const LOG = "/tmp/nb-build.log";

function ssh(cmd, { timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout,
  });
  return { out: r.stdout || "", err: r.stderr || "", code: r.status };
}

const mode = process.argv[2] || "";

if (mode === "--tail") {
  // 只看构建进度末尾
  const r = ssh(`tail -25 ${LOG}; echo; echo "--- 是否还在构建 ---"; pgrep -f 'docker build' >/dev/null && echo "构建进行中" || echo "构建已结束"`);
  process.stdout.write(r.out);
  process.exit(0);
}

// ---- 构建前检查 ----
console.log("=== 构建前检查 ===");
const cur = ssh(
  `${SUDO}docker images nebula:1.0.0 --format '当前 nebula:1.0.0 = {{.ID}} ({{.CreatedSince}}, {{.Size}})' 2>/dev/null; ` +
  `${SUDO}docker images kkfileview:5.0.2 --format '基础 kkfileview:5.0.2 = {{.ID}}' 2>/dev/null; ` +
  `df -h /vol1 | tail -1`
);
process.stdout.write(cur.out);

// 源码一致性：容器内的 app 是否已经等于源码（热修后应一致）
const diff = ssh(
  `cd /vol1/1000/Docker/NebulaDisk/nebula/app && ok=1; ` +
  `for f in main.py files.py routers/preview.py routers/cad.py routers/onlyoffice.py; do ` +
  `  s=$(sha256sum $f | cut -c1-16); ` +
  `  c=$(${SUDO}docker exec nebula sha256sum /opt/nebula/app/$f 2>/dev/null | cut -c1-16); ` +
  `  [ "$s" = "$c" ] && echo "  same  $f" || { echo "  DIFF  $f  源码=$s 容器=$c"; ok=0; }; ` +
  `done; [ $ok = 1 ] && echo "容器内文件已与源码一致（热修已生效）"`
);
process.stdout.write(diff.out);

if (mode === "--check") {
  console.log("\n（--check 模式，未构建）");
  process.exit(0);
}

// ---- 构建 ----
console.log("\n=== 开始构建（后台）===");
const buildCmd =
  `cd /vol1/1000/Docker/NebulaDisk && ` +
  `rm -f ${LOG} && ` +
  `nohup bash -c "cd /vol1/1000/Docker/NebulaDisk && ${SUDO}bash nebula/build.sh" > ${LOG} 2>&1 & ` +
  `echo "已启动，pid=$!"`;

const started = ssh(buildCmd);
process.stdout.write(started.out);
if (started.err.trim()) process.stderr.write(started.err);

console.log(`\n日志: ${LOG}`);
console.log(`查看进度: node rebuild-nb.cjs --tail`);

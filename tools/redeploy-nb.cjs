/**
 * NAS 上重新部署 nebula 容器 —— 用权威 compose 文件重建并重启。
 *
 * ★ 两个踩过的坑 ★
 *   1) 直接 `docker compose up` 会报 `no such service: nebula`：
 *      运行中的栈用的是**部署目录**的 compose（项目名 nebuladisk），
 *      源目录里的那份 compose 是构建用的。必须带上正确的 -f 组合。
 *   2) `up.sh` 默认把部署目录当成 CWD：不给参数时会去读**源目录**的 .env，
 *      于是 NB_OO_SECRET 为空直接失败。→ 必须显式传部署目录。
 *
 * 用法：node redeploy-nb.cjs
 */
const { spawnSync } = require("child_process");

const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";
const { SUDO } = require("./_secrets.cjs");
const COMPOSE_SRC = "/vol1/1000/Docker/NebulaDisk/deploy/docker-compose.yml";
const COMPOSE_MOUNTS = "/vol1/1000/NebulaDisk/docker-compose.mounts.yml";
const DEPLOY_DIR = "/vol1/1000/NebulaDisk";

function ssh(cmd, { timeout = 300000 } = {}) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  return { out: r.stdout || "", err: r.stderr || "", code: r.status };
}

console.log("=== 1. 升级前快照 ===");
const before = ssh(
  `${SUDO}docker inspect nebula --format '容器镜像ID={{.Image}}  创建={{.Created}}' 2>/dev/null; ` +
  `${SUDO}docker images nebula:1.0.0 --format '镜像={{.ID}} {{.CreatedSince}}' 2>/dev/null`
);
process.stdout.write(before.out);

console.log("\n=== 2. 用 compose 重建容器 ===");
// ★ 必须带 --project-directory <部署目录> ★
//   compose 只会从**项目目录**（默认是第一个 -f 文件所在目录）读 .env。
//   我们第一个 -f 给的是源目录的 compose，于是它去源目录找 .env —— 找不到
//   NB_SRC_DIR，直接报「required variable NB_SRC_DIR is missing」。
//   显式指定 --project-directory 让 .env 与项目名都对上。
const up = ssh(
  `cd ${DEPLOY_DIR} && ` +
  `${SUDO}docker compose ` +
  `--project-directory ${DEPLOY_DIR} ` +
  `-f ${COMPOSE_SRC} -f ${COMPOSE_MOUNTS} ` +
  `--project-name nebuladisk ` +
  `up -d --force-recreate nebula 2>&1`,
  { timeout: 300000 }
);
process.stdout.write(up.out);
if (up.err.trim()) process.stderr.write(up.err);

console.log("\n=== 3. 等待健康 ===");
const health = ssh(
  `for i in $(seq 1 40); do ` +
  `  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8089/healthz 2>/dev/null); ` +
  `  if [ "$code" = "200" ]; then echo "健康检查通过（第 \${i} 次，HTTP 200）"; break; fi; ` +
  `  sleep 2; ` +
  `done; ` +
  `echo "---- 容器状态 ----"; ` +
  `${SUDO}docker ps --filter name=nebula --format '{{.Names}} | {{.Status}} | {{.Image}}' 2>/dev/null`,
  { timeout: 180000 }
);
process.stdout.write(health.out);

console.log("\n=== 4. 容器内文件是否等于源码 ===");
const cmp = ssh(
  `cd /vol1/1000/Docker/NebulaDisk/nebula/app && ok=1; ` +
  `for f in main.py files.py routers/preview.py routers/onlyoffice.py; do ` +
  `  s=$(sha256sum $f | cut -c1-16); c=$(${SUDO}docker exec nebula sha256sum /opt/nebula/app/$f 2>/dev/null | cut -c1-16); ` +
  `  [ "$s" = "$c" ] && echo "  same  $f" || { echo "  DIFF  $f  src=$s ctr=$c"; ok=0; }; ` +
  `done; [ $ok = 1 ] && echo "✔ 全部一致"`
);
process.stdout.write(cmp.out);

console.log("\n=== 5. CORS 头是否已下发 ===");
const cors = ssh(
  `curl -s -D - -o /dev/null -H 'Origin: http://172.16.30.128:6806' http://127.0.0.1:8089/healthz 2>/dev/null | tr -d '\\r' | grep -i 'access-control\\|HTTP/'`
);
process.stdout.write(cors.out || "  （未看到 access-control-* 响应头）\n");

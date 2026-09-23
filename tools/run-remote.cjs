/**
 * 把本地脚本推到 NAS 再执行 —— 彻底绕开多层引号。
 *
 * ★ 踩过的坑 ★
 *   `ssh host "python3 -c \"...\""` 这种嵌套会让远端只吃到半截脚本
 *   （syntax error / 空输出）。正确做法是：
 *   脚本以 base64 送上远端落到 /tmp/x.py，再单独一条命令去跑它。
 *
 * 用法：node run-remote.cjs <本地脚本路径> [远端解释器]
 */
const fs = require("fs");
const { SUDO } = require("./_secrets.cjs");
const { spawnSync } = require("child_process");

const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";
const local = process.argv[2];
const interp = process.argv[3] || "python3";

if (!local || !fs.existsSync(local)) {
  console.error("用法: node run-remote.cjs <本地脚本> [解释器]");
  process.exit(2);
}

function ssh(cmd) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: r.stdout || "", err: r.stderr || "", code: r.status };
}

const buf = fs.readFileSync(local);
const b64 = buf.toString("base64");
const CHUNK = 24 * 1024;
const remote = `/tmp/_nb_run_${Date.now()}.py`;

let off = 0;
let seg = 0;
while (off < b64.length) {
  const c = b64.slice(off, off + CHUNK);
  const r = ssh(`printf '%s' '${c}' >> ${remote}`);
  if (r.code !== 0) { console.error(`第 ${seg} 段写入失败`); process.exit(1); }
  off += CHUNK;
  seg++;
}

const mk = ssh(`printf '%s' '' >/dev/null; base64 -d ${remote} > ${remote}.py 2>/dev/null || cp ${remote} ${remote}.py; wc -c < ${remote}.py`);
const size = parseInt(mk.out.trim(), 10);
console.log(`脚本已上传: ${local} → ${remote}.py  (${buf.length}B → ${size}B)`);

const run = ssh(
  `${SUDO}${interp} ${remote}.py 2>&1; echo "退出码=$?"`
);
process.stdout.write(run.out);
ssh(`rm -f ${remote} ${remote}.py`);

/**
 * 把本机后端文件推送到 NAS —— 用 base64 + 命令行参数传输。
 *
 * ★ 为什么不用 stdin ★
 *   上一版用 spawnSync 的 input 走 stdin：ssh 的 askpass 也要读 stdin，
 *   两者互抢，结果远端 `cat > file` 收到 0 字节 —— **源文件被清空**。
 *   幸好推送前做了 cp 备份才没出事。
 *   现在改成：base64 编码后作为**命令行参数**传，stdin 完全留给 askpass。
 *
 * ★ 为什么分块 ★
 *   命令行长度有上限（Windows 约 32K）。按 24KB base64 一段切，
 *   每段 `echo <chunk> >> file.b64`，最后一次性 base64 -d 还原。
 *
 * 用法：node push-src2.cjs
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL_ROOT = "D:/Docker/kkFileView/nebula/app";
const REMOTE_ROOT = "/vol1/1000/Docker/NebulaDisk/nebula/app";
const SSH = "D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk/tools/ssh-nb.cjs";

const FILES = [
  "config.py",
  "main.py",
  "files.py",
  "routers/auth.py",
  "routers/preview.py",
  "routers/cad.py",
  "routers/onlyoffice.py",
];

const CHUNK = 24 * 1024; // 每段 base64 字符数

function ssh(cmd) {
  const r = spawnSync(process.execPath, [SSH, cmd], {
    encoding: "utf8",
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
console.log(`时间戳: ${stamp}`);
console.log(`传输方式: base64 + 命令行参数（stdin 留给 askpass）\n`);

const TMP = `/tmp/nb-push-${stamp}`;
ssh(`rm -rf ${TMP} && mkdir -p ${TMP} && echo ok`);

let allOk = true;

for (const rel of FILES) {
  const local = path.join(LOCAL_ROOT, rel);
  const remote = `${REMOTE_ROOT}/${rel}`;
  const buf = fs.readFileSync(local);
  const b64 = buf.toString("base64");
  const safeName = rel.replace(/\//g, "__");
  const b64file = `${TMP}/${safeName}.b64`;

  // 分段追加
  let offset = 0;
  let seg = 0;
  while (offset < b64.length) {
    const chunk = b64.slice(offset, offset + CHUNK);
    // base64 只含 A-Za-z0-9+/= ，不会和 shell 引号冲突，用单引号最稳
    const r = ssh(`printf '%s' '${chunk}' >> ${b64file}`);
    if (r.code !== 0) {
      console.log(`✗ ${rel} 第 ${seg} 段写入失败`);
      allOk = false;
    }
    offset += CHUNK;
    seg++;
  }

  // 解码到目标文件，并报告字节数
  const r = ssh(
    `base64 -d ${b64file} > '${remote}' && wc -c < '${remote}' && sha256sum '${remote}' | cut -c1-16`
  );
  const lines = r.out.trim().split(/\r?\n/);
  const written = parseInt(lines[0], 10);
  const rhash = (lines[1] || "").trim();

  // 本机 hash（用 node crypto 对齐）
  const crypto = require("crypto");
  const lhash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

  const ok = written === buf.length && rhash === lhash;
  if (!ok) allOk = false;
  console.log(
    `${ok ? "✓" : "✗"} ${rel}  本机 ${buf.length}B / 远端 ${written}B  sha ${lhash} vs ${rhash}`
  );
  if (r.err.trim()) process.stderr.write(r.err);
}

// 语法校验
console.log("");
const pyr = ssh(
  `cd /vol1/1000/Docker/NebulaDisk/nebula && rm -rf app/__pycache__ && python3 -m py_compile ${FILES
    .map((f) => `app/${f}`)
    .join(" ")} && echo SYNTAX_OK`
);
process.stdout.write(pyr.out);
if (allOk && !pyr.out.includes("SYNTAX_OK")) allOk = false;

ssh(`rm -rf ${TMP}`);

console.log("");
console.log(allOk ? "✅ 推送完成：字节数与 sha256 全部一致，语法校验通过" : "❌ 有文件校验不一致，请检查");
process.exit(allOk ? 0 : 1);

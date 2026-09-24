/**
 * 在 NAS 上以 sudo 执行任意命令（stdout 原样返回，便于 grep/管道）。
 * 用法: node _nb-run.cjs "<远端命令>"
 * 远端命令里若含双引号，请用单引号包外层由调用方处理。
 *
 * ★ 调用方强烈建议设 NB_OUT=<本地文件> ★
 *   本机 PowerShell 会把子进程 stderr 当成「终止性错误」，导致
 *   `$x = & node ... 2>&1 | Out-String` 之后的语句直接不执行。
 *   设了 NB_OUT 后由本脚本自己把 stdout+stderr 合写进文件，
 *   PowerShell 侧只看到 exit code，不再被 stderr 打断。
 *
 * ★ 远端命令只认「单行」★
 *   多行命令里只有第一行拿得到 sudo 前缀，其余行以普通用户跑
 *   （docker inspect 之类会 permission denied）。
 *   多行脚本请先推上去：node _push-file.cjs x.sh /tmp/x.sh && node _nb-run.cjs "sh /tmp/x.sh"
 *   另：远端命令里不要出现双引号（PowerShell 5.1 传参时会吞掉），
 *   需要引号就在推上去的脚本文件里写。
 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const cmd = process.argv.slice(2).join(" ");
if (!cmd) { console.error("用法: node _nb-run.cjs \"<远端命令>\""); process.exit(2); }

const r = spawnSync(process.execPath, ["./ssh-nb.cjs", SUDO + cmd],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, cwd: __dirname });

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) {
  const err = String(r.stderr)
    .split(/\r?\n/)
    .filter((l) => !/shell-runtime|command not found|dirname|Permanently added|Warning: Permanently/.test(l))
    .join("\n")
    .trim();
  if (err) process.stderr.write(err + "\n");
}

if (process.env.NB_OUT) {
  fs.writeFileSync(
    process.env.NB_OUT,
    String(r.stdout || "") + (r.stderr ? "\n---stderr---\n" + String(r.stderr) : ""),
    "utf8"
  );
}

process.exit(r.status === null ? 1 : r.status);

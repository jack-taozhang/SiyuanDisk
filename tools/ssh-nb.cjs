/**
 * 通过 SSH 在 NAS(172.16.30.128) 上执行命令。
 *
 * 本机没有 sshpass；Bash 工具的 PATH 在 WorkBuddy 里是坏的
 * （cat/chmod/dirname 全部 command not found），所以不能靠 shell 写 askpass。
 * 这里用 Node 自己落地 askpass.cmd + 一个无扩展名的 sh 脚本，
 * 再 spawn 真正的 ssh.exe，避免任何 MSYS 依赖。
 *
 * 用法：node ssh-nb.cjs "远端命令"
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const HOST = "172.16.30.128";
const USER = "tao_zhang";
const { PASS } = require("./_secrets.cjs");

const tmp = path.join(os.tmpdir(), "nb-ssh");
fs.mkdirSync(tmp, { recursive: true });

// 1) 无扩展名的 shell 脚本：ssh 会 exec 它，它把密码打到 stdout
const shPath = path.join(tmp, "askpass.sh");
fs.writeFileSync(shPath, `#!/bin/sh\necho ${PASS}\n`, { mode: 0o755 });

// 2) Windows 上 ssh 走 CreateProcess，需要 .cmd 包装（bat 不经 cmd.exe 不能直接执行）
const cmdPath = path.join(tmp, "askpass.cmd");
fs.writeFileSync(cmdPath, `@echo off\r\necho ${PASS}\r\n`);

const sshExe = process.env.SSH_EXE || "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const remote = process.argv.slice(2).join(" ");

const args = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=NUL",
  "-o", "PreferredAuthentications=password",
  "-o", "PubkeyAuthentication=no",
  "-o", "ConnectTimeout=10",
  `${USER}@${HOST}`,
  remote,
];

// ★ 两个变量都要给 ★
//   SSH_ASKPASS 让 ssh 知道去调谁；SSH_ASKPASS_REQUIRE=force
//   强制即使有 tty 也走 askpass（不加这条 ssh 会直接提示终端，读不到 stdin）。
//   DISPLAY 在 Windows 上非必需，但给了能规避某些旧版的判定。
const env = Object.assign({}, process.env, {
  SSH_ASKPASS: cmdPath,
  SSH_ASKPASS_REQUIRE: "force",
  DISPLAY: "localhost:0",
});

// ★ maxBuffer 必须显式给大 ★
//   spawnSync 默认只有 1MB。拉文件（_pull-bin.cjs）时会**静默截断**：
//   退出码 0、stderr 干净、base64 长度看着正常，只是尾部没了 ——
//   解出来的文件比远端小一截，而且很难发现。
//   实测：cad-viewer-BAlsMkgn.js 1820527B 被截到 774200B。
const r = spawnSync(sshExe, args, {
  env,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 256 * 1024 * 1024,
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) {
  const err = String(r.stderr)
    .split(/\r?\n/)
    .filter((l) => !/shell-runtime|command not found|dirname/.test(l))
    .join("\n")
    .trim();
  if (err) process.stderr.write(err + "\n");
}
process.exit(r.status === null ? 1 : r.status);

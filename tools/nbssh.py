#!/usr/bin/env python3
"""
用 paramiko 通过 SSH 在 NAS(192.168.193.70) 上执行命令。

为什么不用 Windows 原生 ssh：
  - spawnSync/execSync 在本机沙箱里一律 EBUSY（子进程起不来）
  - 直接用 ssh.exe 走 askpass 会报 `ssh_askpass: pipe: Unknown error`
    （沙箱内外都一样，与本机 ssh 的 askpass 管道机制有关）
  paramiko 是纯 Python 实现，自己建 socket + SSH 通道，不经 Windows 管道，
  因此绕开以上两个坑。

用法：
  python nbssh.py "远端命令"               # 执行并打印 stdout
  python nbssh.py --getlocal "远端路径"     # 拉文件到 stdout（二进制安全？否，用 base64）
  python nbssh.py --put <本地> <远端>       # 上传（base64 分块）
  python nbssh.py --sudo "远端命令"         # 以 root 执行（密码经 stdin 喂给 sudo -S）

★ 为什么要有 --sudo（2026-09-30 加）★
  本机没有 tty，`sudo docker ...` 直接报
      "sudo: a terminal is required to read the password"
  而 NAS 上 tao_zhang 不在 docker 组 ⇒ 免 sudo 访问 docker.sock 被拒。
  所以必须 `echo <pass> | sudo -S -p '' <cmd>`：-S 让 sudo 从 stdin 读密码，
  -p '' 去掉提示串（否则提示串会混进 stderr 被误当成错误）。
  注意远端命令整体要再包一层 sh -c，否则 sudo 只对第一个词生效。
"""
import sys
import os
import json
import base64
import shlex

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "C:/temp-paramiko")

import paramiko  # noqa: E402


def load_conf():
    """配置来源：环境变量 > tools/.nb-local.json

    ★ 2026-09-28 起 host/user/pass **全部**从 .nb-local.json 读，单一改动点 ★
      之前 HOST 是写死的默认值，NAS 一换 IP（192.168.193.70 → 192.168.193.70）
      就得改脚本 —— 已改成读配置，以后只改 .nb-local.json 一处。
    环境变量优先级：NB_HOST / NB_USER / NB_PASS。
    """
    conf = {"host": "", "user": "", "pass": ""}
    cands = [
        os.path.join(HERE, ".nb-local.json"),
        os.path.join(HERE, "tools", ".nb-local.json"),
        "D:/Docker/Siyuan/data/plugins/siyuan-nebuladisk/tools/.nb-local.json",
    ]
    for c in cands:
        try:
            with open(c, "r", encoding="utf-8") as f:
                d = json.load(f)
            conf["host"] = conf["host"] or (d.get("host") or "")
            conf["user"] = conf["user"] or (d.get("user") or "")
            conf["pass"] = conf["pass"] or (d.get("pass") or "")
            if conf["host"] and conf["pass"]:
                break
        except Exception:
            pass
    conf["host"] = os.environ.get("NB_HOST") or conf["host"]
    conf["user"] = os.environ.get("NB_USER") or conf["user"] or "tao_zhang"
    conf["pass"] = os.environ.get("NB_PASS") or conf["pass"]
    if not conf["host"]:
        raise SystemExit("缺少 SSH 主机（NB_HOST 或 .nb-local.json 的 host）")
    if not conf["pass"]:
        raise SystemExit("缺少 SSH 口令（NB_PASS 或 .nb-local.json 的 pass）")
    return conf


# 兼容旧引用：load_pass() 仍可用
def load_pass():
    return load_conf()["pass"]


_CONF = load_conf()
HOST = _CONF["host"]
USER = _CONF["user"]
PASS = _CONF["pass"]


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        hostname=HOST,
        username=USER,
        password=PASS,
        port=22,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return c


def run(cmd, timeout=600):
    c = connect()
    try:
        stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        return out, err, code
    finally:
        c.close()


def put(local, remote, mode=None):
    """上传本地文件到远端（base64 分块，避免命令行长度限制）。"""
    with open(local, "rb") as f:
        data = f.read()
    b64 = base64.b64encode(data).decode("ascii")
    tmp = "/tmp/nbput-%d-%s" % (os.getpid(), os.path.basename(local).replace("/", "_"))
    CHUNK = 65536
    c = connect()
    try:
        sftp = c.open_sftp()
        # 用 /tmp 中转：分块写入
        with sftp.open(tmp, "wb") as fh:
            for i in range(0, len(b64), CHUNK):
                fh.write(b64[i:i + CHUNK].encode("ascii"))
        # 远端解码落盘
        cmd = "base64 -d %s > %s" % (tmp, remote)
        if mode:
            cmd += " && chmod %s %s" % (mode, remote)
        cmd += " && rm -f %s && wc -c < %s" % (tmp, remote)
        stdin, stdout, stderr = c.exec_command(cmd, timeout=300)
        out = stdout.read().decode("utf-8", "replace").strip()
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        sftp.close()
        written = int(out) if out.isdigit() else -1
        return written, len(data), err, code
    finally:
        c.close()


def sudo_run(cmd, timeout=600):
    """以 root 执行远端命令。

    ★ 为什么是 `echo PASS | sudo -S -p '' sh -c '<cmd>'` ★
      · `-S`     让 sudo 从 stdin 读口令（无 tty 时唯一可行的办法）
      · `-p ''`  清掉提示串，否则 "[sudo] password for x:" 会混进 stderr
      · `sh -c`  把整条命令交给一个 shell，避免 sudo 只把第一个词提权、
                 后面的重定向/管道仍在普通用户下执行
      ★ 口令用 shlex.quote 包住 ★ —— NAS 口令含 `@` 等字符，
        不加引号会被 shell 当成重定向/特殊字符。
    """
    inner = "echo %s | sudo -S -p '' sh -c %s" % (
        shlex.quote(PASS), shlex.quote(cmd),
    )
    return run(inner, timeout=timeout)


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("用法: python nbssh.py \"远端命令\"\n      python nbssh.py --put <本地> <远端> [mode]\n      python nbssh.py --sudo \"远端命令\"")
    if args[0] == "--sudo":
        out, err, code = sudo_run(" ".join(args[1:]))
        sys.stdout.write(out)
        if err.strip():
            sys.stderr.write(err)
        sys.exit(code)
    if args[0] == "--put":
        local, remote = args[1], args[2]
        mode = args[3] if len(args) > 3 else None
        written, total, err, code = put(local, remote, mode)
        ok = written == total
        print("%s %s  %dB written / %dB total" % ("OK " if ok else "BAD", remote, written, total))
        if err.strip():
            sys.stderr.write(err)
        sys.exit(0 if ok else 1)
    cmd = " ".join(args)
    out, err, code = run(cmd)
    sys.stdout.write(out)
    if err.strip():
        sys.stderr.write(err)
    sys.exit(code)


if __name__ == "__main__":
    main()

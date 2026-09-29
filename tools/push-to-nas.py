#!/usr/bin/env python3
"""
把本地打包好的 siyuan-nebuladisk 插件推送到 NAS 上思源(Docker) 的 plugins 目录。

远端工作区：
  /vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-nebuladisk/

★ 源目录（LOCAL_DIR）必须是**开发仓库的 dist/**，不是本机思源安装位 ★
  踩过的坑（2026-09-28）：早先 LOCAL_DIR 写的是
    D:/Software/SiYuan/data/plugins/siyuan-nebuladisk   ← 本机思源安装位
  那是**上一次推送出去的旧产物**。于是 `--dry` 显示「4 个文件全部一致」，
  照此运行等于**把旧版当新版推一遍，什么都没改**，还会误以为「已同步」。
  正确源目录是构建输出：
    D:/Docker/Siyuan/data/plugins/siyuan-nebuladisk/dist

策略：
  1) 先把远端现有 index.js / index.css / plugin.json 备份到 .bak-<ts>/（可回滚）
  2) 逐文件上传（base64 分块），逐个校验 sha256
  3) 打印前后对比表

用法：python push-to-nas.py [--dry] [--src <目录>]
"""
import os
import sys
import hashlib
import subprocess
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
NBSSH = os.path.join(HERE, "nbssh.py")
PY = sys.executable

# 开发仓库根 → 产物目录
REPO_ROOT = os.path.dirname(HERE)
LOCAL_DIR = os.path.join(REPO_ROOT, "dist")
if "--src" in sys.argv:
    LOCAL_DIR = sys.argv[sys.argv.index("--src") + 1]

# 本机思源安装位（仅作「误用检测」用，不作源目录）
INSTALL_DIR = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk"
REMOTE_DIR = "/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-nebuladisk"

FILES = [
    ("index.js", "644"),
    ("index.css", "644"),
    ("plugin.json", "644"),
    ("icon.png", "644"),
]


def sh(cmd):
    r = subprocess.run([PY, NBSSH, cmd], capture_output=True, text=True)
    return r.stdout, r.stderr, r.returncode


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    dry = "--dry" in sys.argv
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

    # ---- 守卫 0：源目录必须是开发仓库产物，不能是本机安装位 ----
    src_abs = os.path.abspath(LOCAL_DIR).replace("\\", "/").lower()
    inst_abs = os.path.abspath(INSTALL_DIR).replace("\\", "/").lower()
    if src_abs == inst_abs:
        sys.exit(
            "❌ 源目录被设成了本机思源安装位（%s）。\n"
            "   那是上次推送出去的旧产物，拿它当源等于「把旧版推一遍」。\n"
            "   请指向开发仓库产物：%s/dist" % (INSTALL_DIR, REPO_ROOT))
    if not os.path.isdir(LOCAL_DIR):
        sys.exit("❌ 源目录不存在：%s\n   请先构建：node tools/build.js --repo" % LOCAL_DIR)

    # ---- 守卫 1：产物不得比源码旧（构建后被改过源码=忘了重构建） ----
    dist_js = os.path.join(LOCAL_DIR, "index.js")
    newest_src, newest_name = 0.0, ""
    for rel in ("src/tree.js", "src/embed.js", "src/icons.js", "src/api.js",
                "src/viewer.js", "src/external.js", "index.js", "index.css"):
        p = os.path.join(REPO_ROOT, rel)
        if os.path.exists(p):
            m = os.path.getmtime(p)
            if m > newest_src:
                newest_src, newest_name = m, rel
    if os.path.exists(dist_js):
        dm = os.path.getmtime(dist_js)
        if newest_src > dm + 1:  # 1s 容差
            sys.exit(
                "❌ 产物过期：dist/index.js 早于源码 %s\n"
                "   dist=%s  源码=%s\n"
                "   请先重构建：node tools/build.js --repo" % (
                    newest_name,
                    datetime.datetime.fromtimestamp(dm).strftime("%H:%M:%S"),
                    datetime.datetime.fromtimestamp(newest_src).strftime("%H:%M:%S")))

    print("=== 源目录 ===")
    print("  %s" % LOCAL_DIR)

    print("\n=== 0. 连通性 ===")
    out, err, code = sh("hostname; id -un")
    print(out.strip() or err.strip())
    if code != 0:
        sys.exit("SSH 不通，中止")

    print("\n=== 1. 远端当前状态 ===")
    out, _, _ = sh("ls -la '%s'" % REMOTE_DIR)
    print(out)

    print("=== 2. 本地待推文件 ===")
    plan = []
    for rel, mode in FILES:
        lp = os.path.join(LOCAL_DIR, rel)
        if not os.path.exists(lp):
            print("  ✗ 本地缺失: %s" % rel)
            continue
        lh = sha256(lp)
        size = os.path.getsize(lp)
        rp = "%s/%s" % (REMOTE_DIR, rel)
        rh = sh("sha256sum '%s' 2>/dev/null | cut -d' ' -f1" % rp)[0].strip()
        same = (lh == rh)
        plan.append((rel, lp, rp, mode, lh, rh, same, size))
        print("  %s %-14s %8dB  local=%s remote=%s" % (
            "=" if same else "→", rel, size, lh[:16], (rh[:16] or "(缺失)")))

    if dry:
        print("\n[dry] 仅预览，未推送")
        return

    print("\n=== 3. 备份远端旧版 ===")
    # ★ 曾经的 bug：写成 `mkdir -p '$REMOTE_DIR' && cp -a '$REMOTE_DIR'/*.js '$BAK'/`
    #   —— mkdir 建的是**插件目录本身**，$BAK 从未创建，cp 报
    #   `target '...bak-<ts>/': No such file or directory`，
    #   而脚本没检查这条错误就继续上传 → **旧版被直接覆盖**。
    #   现在：先建 bak 目录并**校验存在**，失败立即中止。
    bak = "%s.bak-%s" % (REMOTE_DIR, ts)
    out, err, code = sh("mkdir -p '%s' && test -d '%s' && echo BAK_OK" % (bak, bak))
    if "BAK_OK" not in out:
        sys.exit("备份目录创建失败，中止上传：%s %s" % (out.strip(), err.strip()))

    copied = []
    for rel, _m in FILES:
        src = "%s/%s" % (REMOTE_DIR, rel)
        out, err, code = sh("if [ -f '%s' ]; then cp -a '%s' '%s/' && echo COPIED; else echo MISSING; fi" % (
            src, src, bak))
        if "COPIED" in out:
            copied.append(rel)
        elif "MISSING" in out:
            print("  （远端原本无 %s，无需备份）" % rel)
        else:
            sys.exit("备份 %s 失败，中止：%s %s" % (rel, out.strip(), err.strip()))

    out, _, _ = sh("ls -la '%s'" % bak)
    print(out.strip())
    if not copied:
        sys.exit("备份目录为空（没有可备份文件），中止上传以免丢失旧版")
    print("  ✔ 已备份 %d 个文件到 %s" % (len(copied), bak))

    print("\n=== 4. 上传并校验 ===")
    allok = True
    for rel, lp, rp, mode, lh, _rh, same, size in plan:
        if same:
            print("  ⊘ %-14s 远端已一致，跳过" % rel)
            continue
        r = subprocess.run([PY, NBSSH, "--put", lp, rp, mode], capture_output=True, text=True)
        written_line = r.stdout.strip()
        rh2 = sh("sha256sum '%s' | cut -d' ' -f1" % rp)[0].strip()
        ok = (rh2 == lh)
        if not ok:
            allok = False
        print("  %s %-14s %s  remote=%s" % ("✓" if ok else "✗", rel, written_line, rh2[:16]))
        if r.stderr.strip():
            print("      stderr:", r.stderr.strip()[:200])

    print("\n=== 5. 统一权限（思源以 root 跑，只需可读）===")
    out, _, _ = sh("chmod -R a+rX '%s' && ls -la '%s'" % (REMOTE_DIR, REMOTE_DIR))
    print(out)

    print("=== 6. 最终 sha256 对照 ===")
    for rel, lp, rp, mode, lh, _rh, same, size in plan:
        rh2 = sh("sha256sum '%s' | cut -d' ' -f1" % rp)[0].strip()
        print("  %s %-14s local=%s remote=%s" % ("✓" if rh2 == lh else "✗", rel, lh[:16], rh2[:16]))
        if rh2 != lh:
            allok = False

    print("\n备份目录: %s" % bak)
    print("✅ 推送完成，全部校验通过" if allok else "❌ 存在校验失败项")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()

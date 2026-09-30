# =============================================================================
# app/webutil.py 的「读不出内容就报 503」补丁（快照，2026-09-30，nebula 1.2.3）
#
# ★ 为什么需要这一段 ★
#   Windows 上的**云端占位文件**（OneDrive / Nextcloud 按需同步、脱机文件）
#   会出现 stat 报出真实大小、read 却只拿到 0 字节的组合；WSL 的 drvfs/9p
#   挂载上连 `dd` 都读到 0 字节（容器里的 /mnt/d 正是把 WSL 的 drvfs 再 bind 进去）。
#
#   不设防时 FileResponse 先按 stat 发 Content-Length，再发 0 字节 ⇒
#   OnlyOffice 转圈约 20 秒后「下载文件失败」，服务端只留一条 ASGI 层的
#   `RuntimeError: Response content shorter than Content-Length`。
#   排查时就是被这一层假象挡住，才绕到"是文件本身读不出来"。
#
# 热修用法：
#   1) 把下面 `probe_readable` 整段贴进容器内 /opt/nebula/app/webutil.py
#      （放在 `_stream_file` 之前）。
#   2) 在 `_stream_file` 里 `if not p.is_file(): raise HTTPException(404, ...)`
#      之后加一行：  probe_readable(p)
#   3) 追加块（nebula-shortlink-page-block.py）里 `/f/<token>` 那段已经在
#      `shortlink.touch(token)` **之前**调了它 —— 顺序别调换，否则读不出内容的
#      文件会白烧 max_visits 配额。
#
# ★★ 正常情况下不要用本文件 ★★ 正式位置在 NebulaDisk 仓库 nebula/app/webutil.py。
# =============================================================================

def probe_readable(p: Path) -> None:
    """探测「文件内容是不是真的读得出来」；读不出来就抛 503。

    ★★ 为什么必须有这一步（2026-09-30，用户报「本机 OO 打开文件有问题」）★★
      Windows 上的**云端占位文件**（OneDrive / Nextcloud 等按需同步的文件、
      脱机文件）会出现一种极坑的组合：

        stat()   → 报出真实大小（实测 42943 字节）
        read()   → 读到 **0 字节**（或直接 EIO）

      WSL 的 drvfs/9p 挂载尤其明显：连 `dd if=… of=/dev/null` 都只拿到 0 字节，
      而本项目的 `/mnt/d` 就是把 WSL 的 drvfs 再 bind 进容器 ⇒ 容器内同样读不出。

      **不做这一步的后果（全部实测）**：
        `FileResponse` 先按 stat 发出 `Content-Length: 42943`，然后一个字节
        也发不出去 ⇒ 客户端拿到「HTTP 200 + 0 字节」。
          · OnlyOffice：转圈约 20 秒后报「下载文件失败」，
            OO 容器日志 `error downloadFile … ESOCKETTIMEDOUT`；
          · kkFileView：预览页一直转圈；
          · 服务端只留一条 ASGI 层的
            `RuntimeError: Response content shorter than Content-Length`
            —— 看不出是哪个文件、更看不出「是文件读不出来」。
        排查时就是从「OO 打不开」一层层穿过这些假象，才落到文件本身。

      ⇒ 先只读 1 个字节：
          读得到        → 正常返回，走 FileResponse（多一次 pread，代价可忽略）；
          读不到 / OSError → 503 + 人话，让日志和调用方一眼看懂。

    ⚠️ 空文件（size == 0）是合法的，直接放行 —— 不能把它和"读不出来"混为一谈。
    """
    try:
        st = p.stat()
    except OSError as e:
        raise HTTPException(503, f"无法读取文件信息：{e.strerror or e}") from e
    if st.st_size <= 0:
        return

    _HINT = (
        "常见于**云端占位文件**（OneDrive / Nextcloud 等按需同步的文件）"
        "或脱机文件：路径与大小都在，内容却读不出来。"
        "请先在 Windows 侧把它设为「始终保留在此设备上 / 下载到本地」再试。"
    )
    try:
        with open(p, "rb") as fh:
            head = fh.read(1)
    except OSError as e:
        print(f"[stream] ❌ 读不出内容 {p}：{type(e).__name__}: {e}", file=sys.stderr)
        raise HTTPException(503, f"文件内容不可读（{e.strerror or e}）。{_HINT}") from e
    if not head:
        print(f"[stream] ❌ 读出 0 字节 {p}（stat 报 {st.st_size} 字节）",
              file=sys.stderr)
        raise HTTPException(
            503, f"文件内容不可读（读到 0 字节，但大小是 {st.st_size} 字节）。{_HINT}")


def _stream_file(p: Path, download: bool = False, filename: str | None = None):
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    # ★ 所有取流路径（/api/raw、/api/download、/f/<token>、分享落地页…）都过这里 ★
    #   所以探测放在这一层：一处修，五条链路一起受益。
    probe_readable(p)

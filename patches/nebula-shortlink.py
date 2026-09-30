# -*- coding: utf-8 -*-
"""NebulaDisk —— 短链（`/f/<token>`）：给「在浏览器中打开」用的短地址。

## 为什么要有它（用户原话）

    「在浏览器中打开 地址这么复杂？是否有必要」
    「oo 打开的地址就是很简单，这个是不是不对」

原来的「在浏览器中打开」对**原生类型**（图片 / pdf / 视频 / 音频 / 文本）
走的是 `/api/raw/<文件名>?mount=..&path=..&exp=..&sig=..`，实测 **324 字符**。
拆开看，长度是**结构性的**，前端做不了减法：

    path=    109 字符（34%）  ★ 签名覆盖它，改一个字节就 403
    路径段    70 字符（22%）    只为让 kkFileView 能取到后缀
    sig=      69 字符（21%）    缺了直接 422
    mount=    43 字符（13%）
    exp=      15 字符（ 5%）

⇒ 要短，只能让**服务端记一份映射**：URL 里只留一个随机 token。

## 设计

  · 表 `links(token, owner, mount, path, name, created_at, hits)`
  · token = `secrets.token_urlsafe(9)` → **12 字符**（72 bit，不可枚举）
  · **(owner, mount, path) 唯一** ⇒ 同一文件永远同一个短链（幂等；
    不会"点一次生成一条"把库撑爆，也方便用户记住/复用）
  · 对外地址形如 `http://<host>:8089/f/xxxxxxxxxxxx` —— 约 **40 字符**

## ★ 安全模型：链接即凭证（capability URL）★

  `/f/<token>` **不要求登录** —— 谁拿到链接谁能看。这是用户明确选的：
  「免登录，链接即凭证 …… 可直接发同事」。边界与代价写清楚：

    · token 12 字符 base64url = 72 bit 随机 ⇒ 不可枚举、不可猜
    · 链接**长期有效**（不带 exp）⇒ 想收回只有两条路：
        ① 删除/改名文件时由 `revoke_by_path()` / `revoke_under_path()`
           一并清掉（fileops 侧要调，见下方"接线点"）
        ② 拥有者显式撤销（`revoke()` / `POST /api/shortlink/revoke`）
    · **危险扩展名**（exe/bat/js/ps1… 见 `config.DANGEROUS_EXT`）
      在 `/f` 里一律**强制 attachment**，绝不 inline ——
      否则相当于对外发了一个可执行的下载页。

  ★ 与既有「分享」`/s/<token>` 的分工（别混）★
      `/s/<token>` = 有落地页、可设有效期/密码/访问次数，给**正式分享**用
      `/f/<token>` = 直取字节、结构简单，给**自己在浏览器里打开**用，
                     顺带能发同事（这就是用户要的语义）

## 为什么不把建表塞进 main.py 的 startup

  `main.py` **不在**部署覆盖清单里（deploy compose 只单文件挂载了
  `routers/pages.py`，见 `/vol1/1000/NebulaDisk/docker-compose.yml`）。
  为了少挂一个文件、少一处漂移风险，这里改成**惰性 + 幂等**建表：
  第一次真正用到时才建，语义等价，也不受启动钩子注册顺序影响。

## 接线点（还没做，需要时补）

  `routers/fileops.py` 的 delete / rename / move 目前**不会**清理短链，
  于是删掉文件后旧短链会命中「文件不存在」的 404 页（不是 200 泄露内容，
  所以先不阻塞上线）。要彻底清干净，在那边调：
      shortlink.revoke_by_path(user, mount, path)          # 删单个文件
      shortlink.revoke_under_path(user, mount, path)       # 删目录
  注意 fileops.py 也不在覆盖清单里 ⇒ 要动它得再加一条单文件挂载。
"""

from __future__ import annotations

import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from . import users

# 9 字节 → token_urlsafe 出 12 个字符。够短（整条 URL 才几十字符），
# 也够长（2^72 ≈ 4.7e21，暴力枚举不现实）。
TOKEN_BYTES = 9

# 查询侧的长度闸门：超长 token 直接当不存在，免得拿畸形输入去查库
MAX_TOKEN_LEN = 64


SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
    token       TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    mount       TEXT NOT NULL,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_target ON links(owner, mount, path);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner, created_at DESC);
"""

# 惰性建表只做一次（进程级）
_ready = False


def _ensure() -> None:
    """惰性 + 幂等建表（理由见模块头「为什么不把建表塞进 main.py」）。"""
    global _ready
    if _ready:
        return
    with users._DB_LOCK:  # 复用同一把锁，避免与 users/shares 的 init 并发
        c = users.conn()
        try:
            c.executescript(SCHEMA)
            c.commit()
        finally:
            c.close()
    _ready = True


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
@dataclass
class Link:
    token: str
    owner: str
    mount: str
    path: str
    name: str
    created_at: int
    hits: int

    def as_dict(self, *, origin: str = "") -> dict[str, Any]:
        d = {
            "token": self.token,
            "owner": self.owner,
            "mount": self.mount,
            "path": self.path,
            "name": self.name,
            "createdAt": self.created_at,
            "hits": self.hits,
        }
        if origin:
            d["url"] = url_for(self.token, origin)
        return d


def _row(r: sqlite3.Row) -> Link:
    return Link(
        token=str(r["token"]),
        owner=str(r["owner"]),
        mount=str(r["mount"]),
        path=str(r["path"]),
        name=str(r["name"] or ""),
        created_at=int(r["created_at"]),
        hits=int(r["hits"] or 0),
    )


def url_for(token: str, origin: str = "") -> str:
    """短链的对外形态。origin 传空则返回站内相对路径。"""
    return f"{origin.rstrip('/')}/f/{token}" if origin else f"/f/{token}"


# ---------------------------------------------------------------------------
# 签发（幂等）
# ---------------------------------------------------------------------------
def get_or_create(owner: str, mount: str, path: str, name: str = "") -> Link:
    """取该 (owner, mount, path) 已有的短链；没有就签一条。

    ★ 为什么幂等 ★
      用户在浏览器里连点几次「在浏览器中打开」，若每次都新签一条，
      库里会堆出一串等价 token，撤销时也搞不清该撤哪条。
      唯一索引 (owner, mount, path) 从数据层保证"一个文件一条短链"。
    """
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute(
                "SELECT * FROM links WHERE owner = ? AND mount = ? AND path = ?",
                (owner, mount, path),
            ).fetchone()
            if r:
                return _row(r)

            now = int(time.time())
            for _ in range(5):
                tok = secrets.token_urlsafe(TOKEN_BYTES)
                try:
                    c.execute(
                        "INSERT INTO links (token, owner, mount, path, name, created_at, hits)"
                        " VALUES (?,?,?,?,?,?,0)",
                        (tok, owner, mount, path, name, now),
                    )
                    c.commit()
                    return Link(tok, owner, mount, path, name, now, 0)
                except sqlite3.IntegrityError:
                    # 两种可能：① token 撞车（概率极低）② 并发下
                    # (owner,mount,path) 刚被别人插进去 → 无论哪种都重查一次。
                    c.rollback()
                    r = c.execute(
                        "SELECT * FROM links WHERE owner = ? AND mount = ? AND path = ?",
                        (owner, mount, path),
                    ).fetchone()
                    if r:
                        return _row(r)
            raise RuntimeError("短链 token 连续 5 次冲突，放弃")
        finally:
            c.close()


# ---------------------------------------------------------------------------
# 查询 / 计数 / 撤销
# ---------------------------------------------------------------------------
def get(token: str) -> Link | None:
    if not token or len(token) > MAX_TOKEN_LEN:
        return None
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT * FROM links WHERE token = ?", (token,)).fetchone()
        finally:
            c.close()
    return _row(r) if r else None


def list_by_owner(owner: str) -> list[Link]:
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            rows = c.execute(
                "SELECT * FROM links WHERE owner = ? ORDER BY created_at DESC", (owner,)
            ).fetchall()
        finally:
            c.close()
    return [_row(r) for r in rows]


def bump(token: str) -> None:
    """访问计数。纯统计用途，失败不影响取流，所以吞掉异常。"""
    try:
        with users._DB_LOCK:
            c = users.conn()
            try:
                c.execute("UPDATE links SET hits = hits + 1 WHERE token = ?", (token,))
                c.commit()
            finally:
                c.close()
    except Exception:  # noqa: BLE001
        pass


def revoke(token: str, requester: str, is_admin: bool = False) -> bool:
    """撤销短链。只有 owner 或管理员可以。返回是否真的删掉了。"""
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            r = c.execute("SELECT owner FROM links WHERE token = ?", (token,)).fetchone()
            if not r:
                return False
            if not is_admin and str(r["owner"]) != requester:
                return False
            c.execute("DELETE FROM links WHERE token = ?", (token,))
            c.commit()
            return True
        finally:
            c.close()


def revoke_by_path(owner: str, mount: str, path: str) -> int:
    """文件被删除/改名/移动时，清掉指向它的短链（否则留下死链）。"""
    _ensure()
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM links WHERE owner = ? AND mount = ? AND path = ?",
                (owner, mount, path),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()


def revoke_under_path(owner: str, mount: str, path: str) -> int:
    """删除**目录**时，连同其下所有路径的短链一起清掉。

    用 prefix + '/' 匹配（加 '/' 是为了让 `a/b` 不会命中 `a/bc`）。
    """
    _ensure()
    pref = path.rstrip("/")
    with users._DB_LOCK:
        c = users.conn()
        try:
            cur = c.execute(
                "DELETE FROM links WHERE owner = ? AND mount = ?"
                " AND (path = ? OR path LIKE ?)",
                (owner, mount, pref, pref + "/%"),
            )
            c.commit()
            return cur.rowcount or 0
        finally:
            c.close()

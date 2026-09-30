# =============================================================================
# pages.py 的「统一链接」追加块（快照，2026-09-30，nebula 1.2.3）
#
# 用法（只在**旧镜像上做临时热修**时才需要）：
#   把本文件内容**追加**到容器内 /opt/nebula/app/routers/pages.py 末尾，
#   并把该文件顶部的 import 改成：
#       -from fastapi import APIRouter, Request
#       +from fastapi import APIRouter, Form, Query, Request
#       -from .. import shares
#       +from .. import shares, shortlink
#       -from ..config import settings
#       +from ..config import DANGEROUS_EXT, ext_of, settings
#       -from ..webutil import WEB_DIR
#       +from ..webutil import WEB_DIR, _mount, _origin, _stream_file, probe_readable
#
#   ⚠️ `probe_readable` 住在 `app/webutil.py`（1.2.3 新增）。做热修时那一侧也要补上，
#      否则本块会 NameError。见本目录 nebula-webutil-probe.py。
#
# ★ 本文件是**机械生成的原始区块**（`pages.py` 里 BEGIN..END 之间的原文）★
#   与早期那份**人工摘录**的旧快照不同：这里不再挑选函数、也不复述设计理由，
#   因为手抄必然与实现漂移（本项目已吃过这个亏）。
#   设计理由 / 安全模型 / 用户原话见 README.md 的「为什么需要」一节。
#   ⇒ 想看「某个函数长什么样」：直接在这份里搜函数名；
#     想看「为什么要这么做」：去 README.md。
#
# ★★ 正常情况下**不要**用这个文件 ★★
#   本块已编进 NebulaDisk 仓库（nebula/app/routers/pages.py），
#   正规做法是重建镜像再换 tag —— 见 README.md。
#
# =============================================================================

# ===== UNIFIED LINKS BEGIN =====
#
# 统一的「链接」出入口：短链 `/f/<token>` 与分享 `/s/<token>` 共用一张表
# （`links`，`kind='file'|'share'`）与**同一套管理接口**。
#
# 用户报障原话：
#   「在浏览器中打开 地址这么复杂？是否有必要」
#   「oo 打开的地址就是很简单，这个是不是不对」
#   「网盘里面自带的分享也纳入一起，采用短链的方式分享。管理纳入一起。」
#
# 前两句⇒ 原生类型（图片/pdf/视频/音频/文本）原先走
#   /api/raw/<文件名>?mount=..&path=..&exp=..&sig=..   实测 **324 字符**
# 长度是**结构性**的（path 与签名互相绑定、路径段还得为后缀重复一次），
# 前端减不掉 ⇒ 改由服务端记 (owner,mount,path) → 12 字符 token 的映射。
#
# 第三句⇒ 把「分享」也并进来：同表、同 token 规格（/s/ 的地址也跟着短了）、
# 同一个管理列表与同一个撤销入口。完整设计见 `app/shortlink.py` 的 docstring。
#
# ★ 为什么 /f/<token> 敢免登录（capability URL）★
#   · token 12 字符 base64url = 72 bit 随机 ⇒ 不可枚举、不可猜
#   · 危险扩展名（exe/bat/js/ps1…）一律强制 attachment，绝不 inline
#   · 映射可见性仍按链接的 owner 复核（owner 看不见该映射 ⇒ 链接同步失效）
#   · 收回手段：删/改名/移动文件时自动清 + 显式撤销
#
# ★ 为什么 /f 是「吐字节」而不是 302 跳到 /api/raw ★
#   302 一跟，地址栏立刻变回 324 字符那条 —— 等于白做。
#
# ★ 为什么签发接口（/api/shortlink）必须鉴权 ★
#   落地端不鉴权是因为"token 即凭证"；但**签发**必须鉴权，
#   否则任何人都能替别人的文件签一条长期有效的短链。


def _link_error(msg: str, status: int) -> HTMLResponse:
    """链接落地失败时的极简提示页（不依赖前端 SPA）。"""
    return HTMLResponse(
        '<!doctype html><meta charset="utf-8"><title>NebulaDisk</title>'
        '<div style="font:14px/1.7 system-ui,sans-serif;padding:48px;color:#444">'
        f'<h2 style="margin:0 0 8px">{msg}</h2>'
        '<p><a href="/">返回 NebulaDisk</a></p></div>',
        status_code=status,
    )


def _want_download(raw: str) -> bool:
    return str(raw).strip().lower() not in ("", "0", "false", "off", "no", "n")


@router.post("/api/shortlink")
async def api_shortlink(
    request: Request,
    mount: str = Form(""),
    path: str = Form(""),
    name: str = Form(""),
    ttl_days: float = Form(None),
):
    """为一个「映射 + 路径」签发/复用**直链**（kind='file'），返回可直接打开的短地址。

    ★ 有效期默认 **7 天**（与分享同规格）★
      用户要求（原话）：「直链 默认 也按7天来。」
      `ttl_days` 传 0 或负数表示永久；不传则用后端默认（7 天）。
      ⚠️ 复用已有直链时：**已过期**才会把到期时间往后推（token 不变），
        没过期就原样返回 —— 不会因为你多点一次"复制"就白送一轮有效期。

    ★ 入参用 Form 而不是 JSON body ★
      插件的 `apiPost()` 发的是 **multipart/form-data**；FastAPI 的 `Form()`
      对 multipart 与 urlencoded 都认，写成 JSON 模型会 422。
      （与 /api/login 同一约定，别改成 pydantic。）
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, files as _files, users as _users

    if not mount:
        raise _HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise _HTTPException(400, "缺少参数：path（文件路径）")

    # auth.current_user 是**同步**函数（不是 async）—— 不要 await
    user = _auth.current_user(request)

    # 签之前先按调用者权限解一遍 → 越权签不出来（与 /oo 同一道闸）
    m = _mount(user["username"], mount)
    p = _files.resolve(m, path)
    if p.is_dir():
        # 目录不走直链：正确入口是「分享」(/s/<token>)，它有落地页与浏览能力
        raise _HTTPException(400, "目录不支持直链，请使用「分享」功能")

    # None = 「没指定」⇒ 交给后端默认（新签用 7 天、已存在的不动它的有效期）
    ttl = None if ttl_days is None else (0 if ttl_days <= 0 else int(ttl_days * 86400))
    lk = shortlink.get_or_create(user["username"], mount, path,
                                 name or p.name, ttl=ttl)
    _users.audit(user["username"], "shortlink_create", f"{mount}:{path}", lk.token)

    return {
        "token": lk.token,
        "kind": lk.kind,
        "url": shortlink.url_for(lk.token, _origin(request), lk.kind),
        "name": p.name,
        # 直链现在默认 7 天 ⇒ 调用方要能显示"到什么时候失效"（0 = 永久）
        "expiresAt": lk.expires_at,
    }


@router.get("/f/{token}")
async def short_open(token: str, request: Request, dl: str = ""):
    """**直链**落地端：按 token 取到文件并内联吐字节。"""
    from .. import files as _files

    lk = shortlink.get_kind(token, shortlink.KIND_FILE)
    if not lk:
        return _link_error("短链不存在或已被撤销", 404)
    # ★ 直链也会过期（默认 7 天）★ —— 过期后不能再吐字节。
    #   行**保留**不删（否则面板里看不到它、也就没法"续期"）。
    if lk.expired:
        return _link_error("短链已过期（可到「链接管理」里续期）", 410)

    # ★ 用链接的 owner 去解映射，而不是"无条件放行" ★
    #   短链不绕过映射可见性：owner 已看不到该映射时，链接同步失效。
    try:
        m = _mount(lk.owner, lk.mount)
    except Exception:  # noqa: BLE001 —— 映射暂时不可用
        # ⚠️ 这里**绝不能**走到下面的自清逻辑：盘抖一下就把好链接全清空了。
        return _link_error("文件已不存在或不可访问", 404)

    try:
        p = _files.resolve(m, lk.path)
    except _files.FileError as e:  # noqa: PERF203
        # ★ 惰性自清死链（2026-09-30 补）★
        #   路径确实没了（404）⇒ 顺手删掉这一行，免得挂在管理列表里当"死链"。
        #   只认「文件真没了」（404）；403/500 是权限或盘的问题，不动数据。
        if int(getattr(e, "code", 400) or 400) == 404:
            shortlink.revoke_by_path(lk.owner, lk.mount, lk.path)
        return _link_error("文件已不存在或不可访问", 404)
    except Exception:  # noqa: BLE001
        return _link_error("文件已不存在或不可访问", 404)

    if p.is_dir():
        return _link_error("短链指向的是一个目录", 404)

    want_dl = _want_download(dl)
    # ★ 危险类型强制下载 ★
    #   否则 /f/<token> 就等同于"免登录 + 长期有效 + 可直接执行/落盘"的通道。
    if ext_of(p.name) in DANGEROUS_EXT:
        want_dl = True

    # ★ 先探「内容读不读得出来」，**再**计数 ★
    #   顺序反了的话：一个读不出内容的文件会白烧 max_visits 配额，
    #   访问次数也会虚高 —— 用户根本没看到内容。
    probe_readable(p)

    shortlink.touch(token)

    resp = _stream_file(p, download=want_dl)
    # 短链语义是"取当前内容"，别让浏览器/中间层把旧字节缓存住
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.get("/api/links")
async def api_links(request: Request, all: str = Query("")):
    """**统一列表**：当前用户的直链 + 分享（管理员加 `?all=1` 看所有人的）。

    ★ 这是「管理纳入一起」的落点 ★
      前端只用这一个接口就能列出全部链接，不必再分别查 /api/shares。
      排序按 `created_at DESC`，前端可再自行分组。
    """
    from .. import auth as _auth

    user = _auth.current_user(request)
    origin = _origin(request)
    every = str(all).strip().lower() in ("1", "true", "yes", "on")

    if every and user.get("is_admin"):
        lks = shortlink.list_all()
    else:
        lks = shortlink.list_by_owner(user["username"])

    items = [lk.as_dict(origin=origin) for lk in lks]
    return {
        "items": items,
        "total": len(items),
        "files": sum(1 for i in items if i["kind"] == shortlink.KIND_FILE),
        "shares": sum(1 for i in items if i["kind"] == shortlink.KIND_SHARE),
        "all": bool(every and user.get("is_admin")),
    }


@router.get("/api/shortlinks")
async def api_shortlinks(request: Request):
    """只列**直链**（`/api/links` 的子集）。

    ★ 保留是为了不破坏 2026-09-30 合并前的接口形状 ★
      当时这个端点的响应是 `{"items": [...], "total": n}`，
      且 items 只有 file 类。统一后仍按这个形状返回（只是多了 kind 字段）。
      新代码请直接用 `/api/links`。
    """
    from .. import auth as _auth

    user = _auth.current_user(request)
    origin = _origin(request)
    items = [
        lk.as_dict(origin=origin)
        for lk in shortlink.list_by_owner(user["username"], shortlink.KIND_FILE)
    ]
    return {"items": items, "total": len(items)}


@router.post("/api/links/revoke")
async def api_links_revoke(request: Request, token: str = Form("")):
    """**统一撤销**：直链与分享都用它（拥有者或管理员）。"""
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    if not token:
        raise _HTTPException(400, "缺少参数：token")
    user = _auth.current_user(request)
    if not shortlink.revoke(token, user["username"], bool(user.get("is_admin"))):
        raise _HTTPException(404, "链接不存在，或你没有权限撤销它")
    _users.audit(user["username"], "link_revoke", token, "")
    return {"ok": True}


@router.post("/api/links/update")
async def api_links_update(
    request: Request,
    token: str = Form(...),
    note: str = Form(None),
    ttl_days: float = Form(None),
    max_visits: int = Form(None),
    password: str = Form(None),
):
    """改备注 / 有效期 / 次数 / 提取码。

    ★ 备注与有效期两类都开放；次数 / 提取码只对分享有意义 ★
      直链**有有效期**（默认 7 天，用户要求「直链 默认 也按7天来」），
      所以 `ttl_days` 对两类都收 —— 「续期」「改为永久」都要能作用在直链上。
      但次数上限 / 提取码是分享特有的，直链传了就是调用方理解错了：
      明确 400 比静默忽略好（静默忽略会让前端以为改成功了）。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    user = _auth.current_user(request)
    lk = shortlink.get(token)
    if not lk:
        raise _HTTPException(404, "链接不存在")
    if not user.get("is_admin") and lk.owner != user["username"]:
        raise _HTTPException(403, "无权修改该链接")
    if lk.kind != shortlink.KIND_SHARE and (
            max_visits is not None or password is not None):
        raise _HTTPException(400, "直链没有次数 / 提取码，只能改备注与有效期")

    shortlink.update(
        token,
        note=note,
        ttl_days=ttl_days,
        max_visits=max_visits,
        password_hash=None if password is None
        else (_users.hash_password(password) if password else ""),
    )
    _users.audit(user["username"], "link_update", token, "")
    fresh = shortlink.get(token)
    return {"ok": True, "link": fresh.as_dict(origin=_origin(request)) if fresh else None}


@router.post("/api/links/rotate")
async def api_links_rotate(request: Request, token: str = Form("")):
    """**换一条地址**：撤销旧的并立刻签一条新地址（目标与参数不变）。

    ★ 使用场景 ★
      短链免登录、发出去就收不回。真发错了地方（贴到群里、误发），
      用户要的是「换一条继续用」，而不是「把这个文件对外关掉」。
      没有这个接口就得手动两步（撤销 + 重新创建），分享那条还得把
      提取码 / 有效期 / 次数原样再填一遍。

    返回新的 `{ok, link}`；旧地址**立刻失效**。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    if not token:
        raise _HTTPException(400, "缺少参数：token")
    user = _auth.current_user(request)
    fresh = shortlink.rotate(token, user["username"], bool(user.get("is_admin")))
    if not fresh:
        raise _HTTPException(404, "链接不存在，或你没有权限操作它")
    _users.audit(user["username"], "link_rotate", token, fresh.token)
    return {"ok": True, "link": fresh.as_dict(origin=_origin(request))}


@router.post("/api/links/revoke-dead")
async def api_links_revoke_dead(request: Request):
    """一键清理**已失效的链接**：过期的（两类都会过期）+ 次数用尽的（只有分享）。

    ★ 还剩下的死链怎么处理 ★
      直链指向的文件被删除 ⇒ 链接只是"打不开"，行还在（没到过期时间）。
      那种由 `/f/<token>` 命中「文件真的不存在」时**惰性自清** ——
      不在批量清理里做，因为判"文件真没了"要真去解析路径，映射抖动会误删好链接。
    """
    from .. import auth as _auth, users as _users

    user = _auth.current_user(request)
    n = shortlink.revoke_dead(user["username"])
    if n:
        _users.audit(user["username"], "link_revoke_dead", user["username"], f"{n} 条")
    return {"ok": True, "revoked": n}


@router.post("/api/shortlink/revoke")
async def api_shortlink_revoke(request: Request, token: str = Form("")):
    """旧入口，保留兼容 —— 语义与 `/api/links/revoke` 完全相同。"""
    return await api_links_revoke(request, token)


# ===== UNIFIED LINKS END =====

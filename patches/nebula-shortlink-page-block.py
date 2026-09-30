# ===== SHORT LINK (/f/<token>) BEGIN =====
#
# 「在浏览器中打开」的短地址。用户报障原话：
#   「在浏览器中打开 地址这么复杂？是否有必要」
#   「oo 打开的地址就是很简单，这个是不是不对」
#
# 原先原生类型（图片/pdf/视频/音频/文本）走
#   /api/raw/<文件名>?mount=..&path=..&exp=..&sig=..   ← 实测 324 字符
# 长度是**结构性**的（path= 与签名互相绑定、路径段还必须为后缀重复一次），
# 前端减不掉 ⇒ 改由服务端记一份 (mount,path) → token 的映射。
# 完整设计、安全模型（capability URL）、撤销方式见 ../shortlink.py 的 docstring。

def _short_error(msg: str, status: int) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=\"utf-8\"><title>NebulaDisk</title>"
        "<div style=\"font:14px/1.7 system-ui,sans-serif;padding:48px;color:#444\">"
        f"<h2 style=\"margin:0 0 8px\">{msg}</h2>"
        "<p><a href=\"/\">返回 NebulaDisk</a></p></div>",
        status_code=status,
    )


@router.post("/api/shortlink")
async def api_shortlink(
    request: Request,
    mount: str = Form(""),
    path: str = Form(""),
    name: str = Form(""),
):
    """为一个「映射 + 路径」签发/复用短链，返回浏览器可直接打开的短地址。

    ★ 入参用 Form 而不是 JSON body ★
      插件的 `apiPost()` 发的是 **multipart/form-data**；FastAPI 的 Form()
      对 multipart 与 urlencoded 都认，写成 JSON 模型会 422。
      （与 /api/login 同一约定，别改成 pydantic。）

    ★ 这是**登录侧**接口（与 /f/<token> 相反）★
      签发必须鉴权，否则任何人都能替别人的文件签一条长期有效的短链。
      落地端之所以敢不鉴权，是因为"token 即凭证"——见 shortlink.py。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, files as _files, users as _users
    from ..webutil import _mount as _resolve_mount, _origin as _req_origin

    if not mount:
        raise _HTTPException(400, "缺少参数：mount（网盘名称）")
    if not path:
        raise _HTTPException(400, "缺少参数：path（文件路径）")

    # auth.current_user 是**同步**函数（不是 async）—— 不要 await
    user = _auth.current_user(request)

    # 签之前先按调用者权限解一遍 → 越权签不出来（与 /oo 同一道闸）
    m = _resolve_mount(user["username"], mount)
    p = _files.resolve(m, path)
    if p.is_dir():
        # 目录不走短链：正确入口是「分享」(/s/<token>)，它有落地页与浏览能力
        raise _HTTPException(400, "目录不支持短链，请使用「分享」功能")

    lk = shortlink.get_or_create(user["username"], mount, path, name or p.name)
    _users.audit(user["username"], "shortlink_create", f"{mount}:{path}", lk.token)

    return {
        "token": lk.token,
        "url": shortlink.url_for(lk.token, _req_origin(request)),
        "name": p.name,
    }


@router.get("/api/shortlinks")
async def api_shortlinks(request: Request):
    """列出当前用户的短链（排查/审计用；前端暂未接）。"""
    from .. import auth as _auth
    from ..webutil import _origin as _req_origin

    user = _auth.current_user(request)
    origin = _req_origin(request)
    items = [lk.as_dict(origin=origin) for lk in shortlink.list_by_owner(user["username"])]
    return {"items": items, "total": len(items)}


@router.post("/api/shortlink/revoke")
async def api_shortlink_revoke(request: Request, token: str = Form("")):
    """撤销一条短链（拥有者或管理员）。

    ★ 为什么必须留这个口子 ★
      短链长期有效 ⇒ 没有撤销手段就等于"发出去就收不回"。
      理论上删文件也能让它失效，但那是副作用，不是可预期的手段。
    """
    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, users as _users

    if not token:
        raise _HTTPException(400, "缺少参数：token")
    user = _auth.current_user(request)
    if not shortlink.revoke(token, user["username"], bool(user.get("is_admin"))):
        raise _HTTPException(404, "短链不存在，或你没有权限撤销它")
    _users.audit(user["username"], "shortlink_revoke", token, "")
    return {"ok": True}


@router.get("/f/{token}")
async def short_open(token: str, request: Request, dl: str = ""):
    """短链落地端：按 token 取到文件并**内联吐字节**。

    ★ 为什么是"吐字节"而不是 302 跳到 /api/raw ★
      302 一跟，地址栏立刻变回 324 字符那条 —— 等于白做。
      直接在本路径回复内容，地址栏才留在 `/f/xxxxxxxxxxxx` 上。

    ★ 无鉴权（capability URL）—— 这是刻意的，不是漏了 ★
      · token 12 字符 base64url（72 bit）不可枚举
      · 危险扩展名一律强制 attachment，绝不 inline
      · 映射可见性仍按链接的 owner 复核（owner 看不见的映射，链接同步失效）
      完整论证见 ../shortlink.py。
    """
    from .. import files as _files
    from ..config import DANGEROUS_EXT, ext_of
    from ..webutil import _mount as _resolve_mount, _stream_file as _stream

    lk = shortlink.get(token)
    if not lk:
        return _short_error("短链不存在或已被撤销", 404)

    # ★ 用链接的 owner 去解映射，而不是"无条件放行" ★
    #   短链不绕过映射可见性：owner 已看不到该映射时，链接同步失效。
    try:
        m = _resolve_mount(lk.owner, lk.mount)
        p = _files.resolve(m, lk.path)
    except Exception:  # noqa: BLE001 —— FileError / HTTPException 都当"不可用"
        return _short_error("文件已不存在或不可访问", 404)

    if p.is_dir():
        return _short_error("短链指向的是一个目录", 404)

    want_dl = str(dl).strip().lower() not in ("", "0", "false", "off", "no", "n")
    # ★ 危险类型强制下载 ★
    #   否则 /f/<token> 就等同于"免登录 + 长期有效 + 可直接执行/落盘"的通道。
    if ext_of(p.name) in DANGEROUS_EXT:
        want_dl = True

    shortlink.bump(token)

    resp = _stream(p, download=want_dl)
    # 短链语义是"取当前内容"，别让浏览器/中间层把旧字节缓存住
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ===== SHORT LINK (/f/<token>) END =====

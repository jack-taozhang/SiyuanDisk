# ===== OO STANDALONE SHELL (diskcanvas "在浏览器中打开") BEGIN =====
#
# 为什么承载页必须放在后端（而不是插件里用 data:/blob: 造）：
#
#   2026-09-30 实测（headless Chrome，同 origin=http://192.168.193.70:6806、
#   同 isSecureContext=false）：
#
#     宿主文档              请求                       Origin  Referer   结果
#     --------------------  -------------------------  ------  --------  ------
#     真实 http :6806       script → :8082/api.js      (无)    有        ✅ 200
#     blob(:6806)           script → :8082/api.js      (无)    (无)      ❌ InsecureLocalNetwork
#     blob(:6806)           script → 同源 :6806        (无)    (无)      ❌ InsecureLocalNetwork
#     blob(:6806)           fetch  → :8082/api.js      (无)    (无)      ❌ InsecureLocalNetwork
#
#   ⇒ blob:（不透明来源）文档里发起的所有子资源请求**都不带 Origin/Referer**，
#     Chrome Private Network Access 判定为「非安全上下文 + 更私有地址空间」
#     一律拦截（corsError = InsecureLocalNetwork）。连同源资源都取不到。
#   ⇒ 这与 CORS 头、CSP、混合内容都无关，改前端无解。
#
#   ⇒ 正确解法：让承载页运行在**真实 http origin** 上。实测 :8089 / :8082 / :6806
#     三个真实文档里加载 :8082/api.js 全部 ✅（docs:true, cors=[]）。
#     本页就放在 :8089（网盘），与插件同源，且能自动带上 nebula_session Cookie。
#
# 与 /lite 同款先例（pages.py 里 lite_shell 的注释写过同样结论）。

_OO_HTML_TMPL = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#f5f5f5;}
  #nb-oo-host{position:absolute;inset:0;}
  #nb-oo-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
    color:#666;text-align:center;padding:24px;box-sizing:border-box;}
  #nb-oo-msg code{background:#ececec;border-radius:3px;padding:1px 5px;font-size:12px;
    word-break:break-all;}
</style></head>
<body>
<div id="nb-oo-host"></div>
<div id="nb-oo-msg">正在加载编辑器…</div>
<script>
(function(){
  var APIJS = __APIJS__;
  var CFG   = __CFG__;
  var host  = document.getElementById("nb-oo-host");
  var msg   = document.getElementById("nb-oo-msg");

  function fail(text){
    try{ msg.style.display = "flex"; }catch(e){}
    msg.innerHTML = text;
  }
  function boot(){
    try{
      if(!(window.DocsAPI && window.DocsAPI.DocEditor)){ fail("OnlyOffice 脚本已加载但未暴露 DocsAPI"); return; }
      msg.style.display = "none";
      new window.DocsAPI.DocEditor("nb-oo-host", CFG);
    }catch(e){
      fail("OnlyOffice 初始化失败：<code>" + String((e && e.message) || e) + "</code>");
    }
  }
  var s = document.createElement("script");
  s.src = APIJS;
  s.onload = boot;
  s.onerror = function(){
    fail("无法加载 OnlyOffice api.js：<code>" + APIJS + "</code><br>"
       + "请确认 OnlyOffice 服务可达，且浏览器未拦截本页的跨端口脚本请求。");
  };
  document.head.appendChild(s);
})();
</script>
</body></html>
"""


@router.get("/oo", response_class=HTMLResponse)
async def oo_standalone(mount: str = "", path: str = "", embed: str = "", request: Request = None):
    """OnlyOffice 独立承载页 —— 给「在浏览器中打开」用。

    为什么由后端渲染 config 而不是前端传进来：
      config 里含 HS256 签名（对整份 config 签名），前端改任何字段都会失配；
      且 config 序列化后约 2.9KB，塞进 URL 会超长并把 JWT 写进访问日志。
      本页与网盘同源 ⇒ 浏览器自动带 nebula_session Cookie ⇒ 可直接鉴权。
    """
    import json as _json
    import os as _os
    import html as _html
    from urllib.parse import urlencode as _urlencode

    from fastapi import HTTPException as _HTTPException

    from .. import auth as _auth, files as _files, integrations as _integrations, users as _users
    from ..webutil import (
        _origin as _req_origin,
        _internal_origin as _int_origin,
        _mount as _resolve_mount,
        make_raw_url as _make_raw_url,
    )

    if not mount:
        return HTMLResponse("<h1>缺少参数：mount</h1>", status_code=400)
    if not path:
        return HTMLResponse("<h1>缺少参数：path</h1>", status_code=400)

    # 鉴权：优先 Cookie（本页与网盘同源，浏览器会自动携带 nebula_session）
    # ★ auth.current_user 是**同步**函数（不是 async）—— 不要 await ★
    try:
        user = _auth.current_user(request)
    except _HTTPException:
        user = None
    except Exception:
        user = None
    if not user:
        return HTMLResponse(
            "<h1>未登录</h1><p>请先在 <a href=\"/\">NebulaDisk</a> 登录后重试。"
            "本页依赖站点的登录 Cookie。</p>",
            status_code=401,
        )

    if not settings.oo_enabled:
        return HTMLResponse("<h1>OnlyOffice 未配置</h1>", status_code=400)
    if not settings.oo_secret:
        return HTMLResponse("<h1>OnlyOffice 密钥未配置，无法签名</h1>", status_code=500)

    m = _resolve_mount(user["username"], mount)
    p = _files.resolve(m, path)
    if p.is_dir():
        return HTMLResponse("<h1>目录不能用 OnlyOffice 打开</h1>", status_code=400)

    st = p.stat()
    mode = "edit" if _os.access(p, _os.W_OK) else "view"
    doc_url = _make_raw_url(mount, path, ttl=3600)

    cb_base = settings.oo_callback_url or _int_origin()
    cb = f"{cb_base}/api/oo/callback?" + _urlencode({"mount": mount, "path": path})

    want_embed = str(embed).strip().lower() in ("1", "true", "yes", "on")

    cfg = _integrations.build_editor_config(
        file_key=_integrations.file_key(mount, path, int(st.st_mtime), st.st_size),
        title=p.name,
        doc_url=doc_url,
        callback_url=cb,
        mode=mode,
        user_id=user["username"],
        user_name=user["username"],
        embed=want_embed,
    )

    _users.audit(user["username"], "oo_open_browser", f"{mount}:{path}", mode)

    api_js = f"{_integrations.oo_public_base(_req_origin(request))}/web-apps/apps/api/documents/api.js"

    def _safe_json(obj):
        # 内联进 <script> 前必须掐死 </script> 与行分隔符
        t = _json.dumps(obj, ensure_ascii=False)
        return (
            t.replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        )

    import html as _html2
    out = (
        _OO_HTML_TMPL
        .replace("__TITLE__", _html2.escape(p.name))
        .replace("__APIJS__", _safe_json(api_js))
        .replace("__CFG__", _safe_json(cfg))
    )
    resp = HTMLResponse(out)
    # 承载页绝不能缓存：config 里的签名有过期时间
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


# ===== OO STANDALONE SHELL END =====

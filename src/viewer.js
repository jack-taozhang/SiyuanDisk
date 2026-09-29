/* ==========================================================================
 * 预览与在线编辑（需求 ②）
 * --------------------------------------------------------------------------
 * 分四条链路，按文件类型路由（与后端 files.route_of 的语义对齐）：
 *
 *   ① 浏览器原生类型（图片/视频/音频/PDF/文本）
 *        → 直接用 /api/download?inline=1 取流，<img>/<video>/<iframe>/<pre>
 *          零转换、零延迟，也不给 kkFileView 添负担。
 *
 *   ② Office（docx/xlsx/pptx…）
 *        → OnlyOffice。★ 这条链路天然不受 CORS 影响 ★
 *          因为文档是 OnlyOffice **服务端**回拉的（走容器网络里的
 *          NEBULA_BASE_URL），api.js 由浏览器直连 OO 的对外地址。
 *          写回走 /api/oo/callback，与插件无关。
 *
 *   ③ CAD（dwg/dxf）
 *        → cad-viewer 深链 /cad/?open=…
 *
 *   ④ 其它（压缩包/代码/未知）
 *        → kkFileView /preview/onlinePreview?url=…
 *
 * ★ iframe 的跨域现实 ★
 *   代理端口与思源端口不同，所以 iframe 内容严格说仍是跨 origin。
 *   但 kkFileView / cad-viewer 都是「无状态渲染」，不需要读 iframe 内部 DOM，
 *   只是展示，因此可用。代理已剥离 X-Frame-Options / CSP 并改写资源地址。
 * ========================================================================== */

import { showMessage } from "siyuan";

/**
 * ★ 2026-09-23：decodeSmart 从本文件搬到 api.js 并导出 ★
 *   任务⑧ 给嵌入块加了「文本直出」（embed.js 的 renderNative），它也需要同一套解码逻辑。
 *   不能直接在 embed.js 里引 viewer —— viewer 已经引了 embed 的 insertEmbedIntoDoc，
 *   反向依赖会形成**循环导入**。⇒ 下沉到 api.js：两边都只依赖 api.js，无环。
 *
 * ★ 注意：这段说明必须写在 import 语句**外面** ★
 *   早先它写在花括号里（`{ ..., 注释, decodeSmart }`），结果：
 *     ① 注释里的示例代码 `import { insertEmbedIntoDoc } from "./embed.js"`
 *        恰好落在行首，被 syntax.check.js 的 import 正则当成一条真实 import 匹配到，
 *        于是把这整段注释算成了「从 ./embed.js 导入的符号名」；
 *     ② 该字符串又被拿去 new RegExp → SyntaxError: Nothing to repeat，检查脚本崩溃。
 *   （检查器本身也已在同一次修复中改为「先剥注释再解析」，双保险。）
 */
import {
  API,
  pickViewer,
  extOf,
  humanSize,
  humanTime,
  decodeSmart,
  displayMountPath,
} from "./api.js";
/*
 * ★ 2026-09-24：`serverBase` / `liteUrl` 已从 import 里移除 ★
 *   页签 CAD 改为直连 cad-viewer 深链（需求：页签显示完整工具栏），
 *   /lite 外壳只留给嵌入块（embed.js）。test/syntax.check.js 的检查④
 *   会把「导入了但从未使用」刷红，所以必须真的删掉这两个名字。
 */
/*
 * ★ #62：`webDiskUrl` 已从 import 里移除 ★
 *   viewer.openInBrowser() 原先的「退回网盘深链/首页」两条兜底已删除
 *   （那条路径会把用户丢到网盘首页，正是任务⑰抱怨的「打开的不是文件」）。
 *   现在统一走 API.browserViewUrl()。
 *   ⚠️ 必须真的删掉这个导入名：test/syntax.check.js 的检查④会报
 *      「导入了 webDiskUrl 但从未使用」，把套件刷红。
 */
import { insertEmbedIntoDoc } from "./embed.js";

export class Viewer {
  /**
   * @param {HTMLElement} element 页签容器
   * @param {{mount:string,path:string,name:string,ext?:string}} data
   */
  constructor(element, data) {
    this.el = element;
    this.data = data || {};
    this.mount = data.mount;
    this.path = data.path;
    this.name = data.name || data.path;
    this.ext = data.ext || extOf(this.name);
    this.kind = pickViewer(this.name);
    this.destroyed = false;
    this._ooEditor = null;
    this._ooScript = null;
  }

  /* =====================================================================
   * 渲染
   * ================================================================== */
  async render() {
    if (this.destroyed) return;
    this.el.classList.add("nb-viewer");
    this.el.innerHTML = "";

    this.renderToolbar();

    this.body = document.createElement("div");
    this.body.className = "nb-viewer-body fn__flex-1";
    this.el.appendChild(this.body);

    // 顶部显示文件信息条
    this.renderInfo();

    try {
      switch (this.kind) {
        case "image":  return await this.renderImage();
        case "video":  return await this.renderVideo();
        case "audio":  return await this.renderAudio();
        case "pdf":    return await this.renderPdf();
        case "text":   return await this.renderText();
        case "office": return await this.renderOffice();
        case "cad":    return await this.renderCad();
        case "archive":return await this.renderKk();
        default:       return await this.renderKk();
      }
    } catch (e) {
      this.showError(e);
    }
  }

  /* ---- 工具条 ---- */
  renderToolbar() {
    const bar = document.createElement("div");
    bar.className = "nb-viewer-toolbar";

    const title = document.createElement("div");
    title.className = "nb-viewer-title";
    title.textContent = this.name;
    title.title = displayMountPath(this.mount, this.path);
    bar.appendChild(title);

    const spacer = document.createElement("div");
    spacer.className = "fn__flex-1";
    bar.appendChild(spacer);

    const mkBtn = (icon, label, handler) => {
      const b = document.createElement("button");
      b.className = "b3-tooltips b3-tooltips__sw nb-viewer-btn";
      b.setAttribute("aria-label", label);
      b.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
      b.onclick = handler;
      return b;
    };

    bar.appendChild(mkBtn("iconRefresh", "重新加载", () => this.render()));
    bar.appendChild(mkBtn("iconDownload", "下载", () => this.download()));
    bar.appendChild(mkBtn("iconCopy", "复制路径", () =>
      this.copy(displayMountPath(this.mount, this.path))));
    bar.appendChild(mkBtn("iconNebulaDisk", "嵌入到文档", () =>
      this.embedToDoc()));
    bar.appendChild(mkBtn("iconLink", "复制直链", () => this.copyLink()));
    bar.appendChild(mkBtn("iconOpen", "在浏览器中打开", () => this.openInBrowser()));

    this.el.appendChild(bar);
  }

  renderInfo() {
    const info = document.createElement("div");
    info.className = "nb-viewer-info";
    const chip = (t, cls) => {
      const s = document.createElement("span");
      s.className = "nb-chip" + (cls ? " " + cls : "");
      s.textContent = t;
      return s;
    };
    info.appendChild(chip(this.mount));
    info.appendChild(chip("/" + this.path));
    if (this.data.size) info.appendChild(chip(humanSize(this.data.size)));
    if (this.data.mtime) info.appendChild(chip(humanTime(this.data.mtime)));

    // 任务⑲：整条信息条可点即可复制「mount:/path」——
    //   用户想把这个页签对应的文件贴到别处（聊天/工单/另一个嵌入块）时，
    //   不必再回文件树找。这也是"如何知道嵌入的具体文档是哪个"的最短路径。
    const spacer = document.createElement("div");
    spacer.className = "fn__flex-1";
    info.appendChild(spacer);
    const copyChip = document.createElement("span");
    copyChip.className = "nb-chip nb-chip--copy";
    copyChip.textContent = "复制路径";
    copyChip.title = displayMountPath(this.mount, this.path);
    copyChip.onclick = () => this.copy(displayMountPath(this.mount, this.path));
    info.appendChild(copyChip);

    this.el.appendChild(info);
  }

  /* ---- ① 图片 ---- */
  async renderImage() {
    // ★ 必须用 signedDownloadUrl（异步拿签名直链）★
    //   直连通道下 /api/download 认 Cookie，而思源与网盘跨源 ⇒ 401；
    //   旧代码还用 proxyBase() ⇒ 浏览器打 127.0.0.1:6810 ⇒ 连接被拒。
    //   这正是任务⑧「图片打不开」的根因。
    const url = await API.signedDownloadUrl(this.mount, this.path, true);
    this.body.innerHTML = "";
    const box = document.createElement("div");
    box.className = "nb-media-wrap";
    const img = document.createElement("img");
    img.className = "nb-image";
    img.alt = this.name;
    img.src = url;
    img.onerror = () => this.showError(new Error("图片加载失败"));
    // 点击缩放
    let zoom = false;
    img.onclick = () => {
      zoom = !zoom;
      img.classList.toggle("is-zoom", zoom);
    };
    box.appendChild(img);
    this.body.appendChild(box);
  }

  /* ---- ① 视频 ---- */
  async renderVideo() {
    // 同 renderImage：必须走签名直链（跨源 /api/download 会 401；
    // 旧的 proxyBase() 会打到 127.0.0.1:6810 直接连不上）
    const url = await API.signedDownloadUrl(this.mount, this.path, true);
    const v = document.createElement("video");
    v.className = "nb-video";
    v.controls = true;
    v.preload = "metadata";
    v.src = url;
    // /api/raw 支持 Range，可拖动进度
    this.body.appendChild(v);
  }

  /* ---- ① 音频 ---- */
  async renderAudio() {
    const url = await API.signedDownloadUrl(this.mount, this.path, true);
    const box = document.createElement("div");
    box.className = "nb-audio-wrap";
    box.innerHTML = `<div class="nb-audio-name"></div>`;
    box.querySelector(".nb-audio-name").textContent = this.name;
    const a = document.createElement("audio");
    a.controls = true;
    a.src = url;
    box.appendChild(a);
    this.body.appendChild(box);
  }

  /* ---- ① PDF（浏览器内置阅读器）---- */
  async renderPdf() {
    // 走 kkFileView 更稳（部分环境的内置 PDF 插件不可用）：
    // 有 kk 就用 kk，没有就退回原生 embed
    return this.renderKk();
  }

  /* ---- ① 文本 ---- */
  async renderText() {
    const pre = document.createElement("pre");
    pre.className = "nb-text";
    pre.textContent = "加载中…";
    this.body.appendChild(pre);

    try {
      // 同图片/视频：走签名直链，避免 127.0.0.1 与跨源 Cookie
      const url = await API.signedDownloadUrl(this.mount, this.path, true);
      const resp = await fetch(url, { credentials: "omit" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      pre.textContent = decodeSmart(buf);
      this.maybeHighlight(pre);
    } catch (e) {
      pre.textContent = `读取失败：${e.message}`;
    }
  }

  /* ---- ② Office → OnlyOffice ---- */
  async renderOffice() {
    this.showLoading("正在连接 OnlyOffice…");
    let cfg;
    try {
      cfg = await API.ooConfig(this.mount, this.path);
    } catch (e) {
      // OnlyOffice 未配置时优雅降级到 kkFileView
      if (/未配置|403|503/.test(e.message + e.status)) {
        console.warn("[nebuladisk] OnlyOffice 不可用，降级到 kkFileView:", e.message);
        return this.renderKk(true);
      }
      throw e;
    }

    if (!cfg || !cfg.ok) throw new Error("OnlyOffice 配置获取失败");

    const editorBox = document.createElement("div");
    editorBox.className = "nb-oo-editor";
    editorBox.id = "nb-oo-" + Date.now();
    this.body.innerHTML = "";
    this.body.appendChild(editorBox);

    // 状态提示条已按需求移除。
    //   原来这里会插一条「● 在线编辑模式 —— 关闭编辑器后自动保存回网盘」
    //   （只读时显示「○ 只读模式（该目录无写权限）」）。
    //   用户 2026-09-22 明确要求：这一行及其内容不要显示。
    //   ⇒ 不再创建 .nb-oo-mode 节点，编辑器直接占满整个 body。
    //   注：只读/可写仍然由 cfg.mode 决定（见 API.ooConfig），只是不再提示。

    // 加载 api.js（跨域脚本加载是允许的，不需要 CORS 头）
    await this.loadScript(cfg.apiJs);

    const DocsAPI = window.DocsAPI;
    if (!DocsAPI) throw new Error("OnlyOffice api.js 已加载但 DocsAPI 不存在");

    const config = { ...cfg.config };

    // ★★★ 关于 OnlyOffice 自带的左栏（用户报的「两个画面」）★★★
    //
    //   现象：编辑器里左边一条窄栏（插件面板 / 反馈&支持），右边才是文档。
    //   那不是本插件的布局（本插件只有一条工具条 + 正文），是 OO 自己的内置面板。
    //
    //   ❌ 为什么**不**在 config 里加 customization.plugins = false ❌
    //     后端 build_editor_config() 的最后一步是 `cfg["token"] = _sign(cfg)`，
    //     **签名覆盖整个 config**（见 integrations.py:62 `_sign`，
    //     payload = json.dumps(cfg)）。
    //     前端拿到的 cfg.config 是**已签名**的，我们再加/改任何字段，
    //     都会让 token 与内容不匹配 → OnlyOffice 直接拒绝整个配置。
    //     本插件没有 oo_secret，无法重新签名，所以这条路走不通。
    //     （实测：拿回来的 config 里根本没有我们加的键 —— 顶层 customui 被忽略；
    //       而改 editorConfig.customization 则会让签名失效。）
    //
    //   ✅ 正确做法：CSS/DOM 兜底（hideOoPanels）✅
    //     不碰 config、不动签名，直接在外层把 OO 渲染出来的左栏藏掉。
    //     这是唯一「零风险 + 不改后端」的办法。
    //     若要根治，应在**后端**的 build_editor_config 的 customization 里
    //     加上 plugins/leftMenu/about/feedback = false，再重建 nebula 镜像
    //     （需要用户同意，且要重建镜像，代价较大）。

    // 让关闭按钮直接关掉思源页签
    config.events = {
      onError: (ev) => {
        console.error("[nebuladisk] OnlyOffice 错误:", ev);
        this.showError(new Error(`OnlyOffice: ${ev?.data?.errorDescription || "未知错误"}`));
      },
      onDocumentReady: () => {
        console.log("[nebuladisk] 文档已就绪");
        // OO 渲染完成后左栏 DOM 才真正存在 → 这时再清一次最有效
        this.hideOoPanels(editorBox);
      },
    };

    try {
      this._ooEditor = new DocsAPI.DocEditor(editorBox.id, config);
    } catch (e) {
      throw new Error(`创建编辑器失败：${e.message}`);
    }

    // ★ 兜底：等 OO 渲染完后，用 CSS 把左栏彻底藏掉 ★
    //   customui 在不同 OO 版本里字段名有差异，光靠配置不一定生效；
    //   这里再补一刀：把已知的左栏容器隐藏，确保只剩一个画面。
    this.hideOoPanels(editorBox);
  }

  /**
   * 尽量隐藏 OnlyOffice 自带的面板（左栏 / 右侧信息），只留文档正文。
   *
   * ★★★ 结论先行：跨域情况下这个函数**改不动 OO 内部** ★★★
   *
   *   OnlyOffice 的 DocEditor 会把自己渲染进一个 iframe，而这个 iframe 的
   *   origin 是 **NEBULA_OO_PUBLIC**（实测 http://192.168.193.70:8082），
   *   与思源页面的 origin（http://192.168.193.70:6806）**不同源**。
   *   同源策略下，父页面无法读取/修改跨域 iframe 的 DOM，
   *   所以「用 CSS 把 OO 左栏藏掉」在跨域部署里**做不到**。
   *
   *   那这个函数还有什么用？
   *     · OO 若因某种集成方式**没有**用 iframe（内联渲染）→ 可以生效
   *     · 把外层 iframe 的边框/内边距清掉，避免出现「一圈空白」被看成第二栏
   *   ⇒ 保留它是为了这两条，但不要把「消除两个画面」的责任压在它身上。
   *
   * ★ 真正能根治的做法（需要改后端，已单独说明）★
   *   在 nebula 后端 integrations.build_editor_config() 的
   *   editorConfig.customization 里补上：
   *       "plugins": False, "leftMenu": False,
   *       "about": False,   "feedback": False,
   *   然后重建 nebula 镜像。
   *
   *   为什么不能在前端补：
   *     后端 `cfg["token"] = _sign(cfg)` 是**对整份 config 签名**的，
   *     前端再改任何字段都会让 token 与内容不一致 → OO 拒绝整个配置。
   *     而 JWT_ENABLED: "true"（compose 已确认），所以 token 是强校验的。
   *     前端没有 oo_secret，无法重新签名。
   */
  hideOoPanels(box) {
    const kill = () => {
      if (this.destroyed || !box || !box.querySelectorAll) return;

      // 仅在同源（内联渲染）时才有可能命中；跨域 iframe 下这步会自然落空。
      const sel = [
        ".left-panel",
        ".left-menu",
        "#left-panel",
      ];
      for (const s of sel) {
        for (const el of box.querySelectorAll(s)) {
          if (/plugin|menu|panel/i.test(el.className || "")) {
            el.style.display = "none";
          }
        }
      }

      // 跨域也能做的：把 iframe 铺满，不要留边距/边框造成「第二栏」的错觉
      for (const f of box.querySelectorAll("iframe")) {
        f.style.display = "block";
        f.style.width = "100%";
        f.style.height = "100%";
        f.style.border = "0";
      }
      // 顺带把外层第一个 iframe 的父容器边距清零
      for (const w of box.querySelectorAll("div")) {
        const st = w.style;
        if (st && (st.padding || st.margin) && w.querySelector("iframe")) {
          st.padding = "0";
          st.margin = "0";
        }
      }
    };
    try { kill(); } catch { /* 忽略 */ }
    // OO 异步渲染，多补几次
    setTimeout(() => { try { kill(); } catch { /* 忽略 */ } }, 1500);
    setTimeout(() => { try { kill(); } catch { /* 忽略 */ } }, 4000);
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.DocsAPI && this._ooScript && this._ooScript.src === src) return resolve();
      // 已存在同地址的 script（别的页签加载过）
      const existing = Array.from(document.querySelectorAll("script"))
        .find((s) => s.src === src);
      if (existing && window.DocsAPI) return resolve();

      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => { this._ooScript = s; resolve(); };
      s.onerror = () => reject(new Error(
        `无法加载 OnlyOffice：${src}\n请检查设置中的 OnlyOffice 对外地址是否可访问。`,
      ));
      document.head.appendChild(s);
    });
  }

  /* ---- ③ CAD ---- */
  async renderCad() {
    this.showLoading("正在加载 CAD 查看器…");
    let r;
    try {
      r = await API.cadUrl(this.mount, this.path);
    } catch (e) {
      if (/未配置|503/.test(e.message + e.status)) {
        console.warn("[nebuladisk] CAD 查看器不可用，降级到 kkFileView");
        return this.renderKk(true);
      }
      throw e;
    }
    // ★ 2026-09-24 需求修订：**页签**打开 CAD 要显示完整工具栏 ★
    //
    //   曾经这里也套 /lite?kind=cad（与嵌入块同一条通道），导致页签里
    //   工具栏/命令行/状态栏全被 CSS 藏掉 —— 与「页签 = 完整视图」矛盾。
    //   /lite 只做 CSS 隐藏、不写 localStorage，所以页签直连即可恢复，
    //   与嵌入块（/lite 收菜单）互不影响。
    //
    //   行为对齐表（保持不变的部分）：
    //     · 嵌入块（embed.js）   → /lite?kind=cad，收掉工具栏
    //     · 页签（本函数）       → 直连 cad-viewer 深链，完整 UI
    this.renderIframe(r.url, "CAD 图纸");
  }

  /* ---- ④ kkFileView ---- */
  async renderKk(silentFallback = false) {
    this.showLoading(silentFallback ? "该格式不支持在线编辑，改用预览…" : "正在转换预览…");
    let r;
    try {
      r = await API.previewUrl(this.mount, this.path);
    } catch (e) {
      throw new Error(`无法获取预览地址：${e.message}`);
    }
    if (!r || !r.url) throw new Error("预览地址为空");
    this.renderIframe(r.url, "kkFileView");

    // kkFileView 首屏要转换，可能较慢，给个耐心提示
    this._kkTimer = setTimeout(() => {
      if (this.destroyed) return;
      const tip = this.el.querySelector(".nb-viewer-tip");
      if (tip) tip.textContent = "首次转换较慢（大文件可能需要几十秒），请稍候…";
    }, 6000);
  }

  renderIframe(url, label) {
    this.body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "nb-iframe-wrap";

    const frame = document.createElement("iframe");
    frame.className = "nb-iframe";
    frame.src = url;
    frame.setAttribute("allowfullscreen", "true");
    frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");

    const tip = document.createElement("div");
    tip.className = "nb-viewer-tip";
    tip.textContent = `${label} 加载中…`;

    frame.onload = () => { tip.textContent = ""; tip.style.display = "none"; };

    wrap.appendChild(frame);
    this.body.appendChild(wrap);
    this.el.appendChild(tip);
  }

  /* =====================================================================
   * 辅助
   * ================================================================== */
  showLoading(text) {
    this.body.innerHTML = `<div class="nb-viewer-loading">
      <div class="nb-spinner"></div><div>${escapeHtml(text)}</div></div>`;
  }

  showError(err) {
    if (this.destroyed) return;
    const msg = err && err.message ? err.message : String(err);
    this.body.innerHTML = "";
    const box = document.createElement("div");
    box.className = "nb-viewer-error";
    box.innerHTML = `<div class="nb-viewer-error-title">打开失败</div>`;
    const pre = document.createElement("pre");
    pre.className = "nb-viewer-error-msg";
    pre.textContent = msg;
    box.appendChild(pre);

    const hint = document.createElement("div");
    hint.className = "nb-viewer-error-hint";
    hint.textContent = "可尝试：下载后用本地应用打开，或在浏览器中打开网盘页面。";
    box.appendChild(hint);

    const actions = document.createElement("div");
    actions.className = "nb-viewer-error-actions";
    const dl = document.createElement("button");
    dl.className = "b3-button b3-button--outline";
    dl.textContent = "下载文件";
    dl.onclick = () => this.download();
    const br = document.createElement("button");
    br.className = "b3-button b3-button--outline";
    br.textContent = "在浏览器中打开";
    br.onclick = () => this.openInBrowser();
    const rt = document.createElement("button");
    rt.className = "b3-button b3-button--text";
    rt.textContent = "重试";
    rt.onclick = () => this.render();
    actions.appendChild(dl);
    actions.appendChild(br);
    actions.appendChild(rt);
    box.appendChild(actions);

    this.body.appendChild(box);
  }

  async download() {
    // ★ 必须 await 签名直链 ★
    //   直连通道下 /api/download 认 Cookie（跨源 ⇒ 401）；
    //   旧的同步 downloadUrl() 在直连时还会拼 127.0.0.1:6810 ⇒ 连接被拒。
    //   这就是用户报的「下载会报错」。
    let url;
    try {
      url = await API.signedDownloadUrl(this.mount, this.path, false);
    } catch (e) {
      showMsg(`下载失败：${e.message}`);
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = this.name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);
  }

  /**
   * 预览栏「复制直链」—— **下载型**直链（任务⑱，2026-09-23 用户明确）。
   *
   * ★★★ 两个「复制直链」的语义是**故意不同**的，别再改回一致 ★★★
   *
   *   用户最终确认（原话）：
   *     「右键中的直连是打开和 预览上的直连是下载。修复 预览上的直连。」
   *
   *   · **右键菜单**（tree.js 的 copyRawLink）「复制直链」 = **打开**
   *     —— 粘到浏览器里直接看到文件内容（inline 渲染）。
   *     这是用户认可、要求保持不变的。
   *   · **本方法**（预览栏按钮）「复制直链」 = **下载**
   *     —— 粘到浏览器/下载器里应该触发下载（attachment）。
   *
   *   为什么必须走后端签发而不是在前端给 URL 加 `&dl=1`：
   *     后端把 dl 并入了 HMAC 签名串（见 nebula `routers/rawlink.py` 的
   *     `_wants_download` / `webutil._raw_token(..., dl=)`）。
   *     前端手动追加 ⇒ sig 与实参不匹配 ⇒ **恒 403**。
   *     所以要传 `download` 让后端签出一份带 dl 的链接。
   *     （已实测：v2 签名把 dl 并入 HMAC 输入，篡改必 403。）
   *
   *   signedRawUrl(mount, path, true) 已经内含 browserReachableUrl()，
   *   主机名改写（nebula:8088 → 192.168.193.70:8089）不用在这里重复做。
   */
  async copyLink() {
    try {
      const abs = await API.signedRawUrl(this.mount, this.path, true);
      if (!abs) throw new Error("后端未返回直链");
      this.copy(abs);
      showMsg("已复制下载直链");
    } catch (e) {
      showMsg(`获取直链失败：${e.message}`);
    }
  }

  copy(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showMsg("已复制"))
        .catch(() => showMsg("复制失败"));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); showMsg("已复制"); }
      catch { showMsg("复制失败"); }
      ta.remove();
    }
  }

  /**
   * 在浏览器中打开（任务⑰ → #62 修正）。
   *
   * ★★★ #62：这里曾经**一律**打开 `/api/raw` 直链，那是错的 ★★★
   *
   *   用户报障（原话）：
   *     「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
   *       onlyoffice 预览一样 kkviewer 也一样。
   *       PDF 预览目前点击这个按钮是在网页中打开。」
   *
   *   实测各类型 `/api/raw` 的响应头，**`Content-Disposition: inline` 一直都下发了**：
   *     PDF  → application/pdf                        → 内嵌打开 ✅
   *     DOCX → application/vnd...wordprocessingml...  → 下载 ❌
   *     STEP → model/step                             → 下载 ❌
   *   ⇒ 问题不在 inline 头，而在**目标地址**：
   *     浏览器只内嵌渲染极少数 MIME（pdf/图片/视频/音频/text）；
   *     Office、CAD 这些专用 MIME 浏览器**没有渲染器**，inline 也只能下载。
   *     PDF 恰好原生支持，所以只有它「看起来是对的」。
   *
   *   ⇒ 现在统一走 `API.browserViewUrl()`：它按 `pickViewer()` 的**同一套路由**
   *     选「渲染通道」 —— 与页签里 viewer.render 的分流一一对齐：
   *       · pdf/图片/视频/音频/文本 → /api/raw（原生，零转换）
   *       · office                  → **OnlyOffice 独立承载页**（可编辑，与页签一致）
   *       · 压缩包/其它             → kkFileView /preview/onlinePreview（text/html）
   *       · cad                     → cad-viewer 深链
   *     并统一过 browserReachableUrl() 把 nebula:8088 换成浏览器可达主机。
   *
   * ★★ 2026-09-30：office 已由 kkFileView 改回 OnlyOffice ★★
   *   用户原话：「word 没有用 onlyoffice 打开。变成了PDF」
   *              「在浏览器中打开这个功能，现在是跳转到 kkfileview 了，
   *                CAD 预览功能是正常的，我需要跳转到 OnlyOffice」
   *   kkFileView 会把 docx **转成 PDF** 再显示（页面里 `…docx.pdf`），
   *   既不是 OO、也不能编辑，与「在浏览器中打开」的语义不符。
   *   详情与安全性论证见 api.js 的 browserViewUrl() 注释。
   */
  async openInBrowser() {
    try {
      const url = await API.browserViewUrl(this.mount, this.path, this.name);
      if (!url) throw new Error("后端未返回可预览的地址");
      const w = window.open(url, "_blank", "noopener");
      // 弹窗被拦截时要明确告诉用户，否则点了没反应像是坏了
      if (!w) showMsg("浏览器拦截了新窗口，请允许本站弹出窗口后重试");
    } catch (e) {
      showMsg(`在浏览器中打开失败：${(e && e.message) || "未知原因"}`);
    }
  }

  embedToDoc() {
    // ★★★ 不要在这里「拿不到 protyle 就提前返回」★★★
    //
    //   2026-09-22 的关键教训：用户在「NebulaDisk 预览页」点这个按钮时，
    //   **焦点在插件页签里**，`getActiveProtyle()`（它只看 .protyle-wysiwyg）
    //   很可能返回 null（文档页签不在前台、或一个编辑器都没有）。
    //
    //   原先这里 `if (!protyle) { showMsg("请先打开一个文档…"); return; }`
    //   ⇒ 直接拦掉了整条链路，**locateInsertPoint 的多级回退根本没机会跑**，
    //     用户明明开着文档却被要求"先打开一个文档"。
    //
    //   ⇒ 现在把 null 也照常传下去：定位是 embed.js 的职责，它有
    //     聚焦页签 / data-initdata / layout 遍历 五级回退，比这里靠谱得多。
    const protyle = getActiveProtyle();
    // ★★★ 这里曾经是「反引号围栏 + protyle.insert」，双重错误 ★★★
    //   ① 反引号（```nebuladisk）只会生成 type=c 普通代码块，不是自定义块
    //   ② 前端 protyle.insert 在浏览器端会把内容存成普通段落（type=p）
    //   ⇒ 结果就是用户看到的「笔记里一坨裸 JSON」。
    //   现在统一走 insertEmbedIntoDoc：内核 API + `;;;` 围栏。
    //   （用户实际点的是这个按钮，务必保持与其它插入点一致）
    const plugin = window.__nebuladiskPlugin;
    if (!plugin) {
      showMsg("插件未就绪，请稍后重试");
      return;
    }
    insertEmbedIntoDoc(plugin, protyle, {
      kind: "file",
      mount: this.mount,
      path: this.path,
      name: this.name,
    }).then((ok) => {
      showMsg(ok ? "已嵌入到当前文档"
                 : "嵌入失败：内核没有生成自定义块");
    }).catch((e) => {
      // ★ 把真实原因显示出来（尤其是「找不到文档」这种可自助解决的）★
      //   并把定位轨迹一并打到控制台，便于继续收敛。
      try {
        if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
      } catch { /* 忽略 */ }
      showMsg(`嵌入失败：${(e && e.message) || "未知原因"}`);
    });
  }

  /** 极简语法着色（仅对常见代码扩展名，纯前端、不引依赖） */
  maybeHighlight(pre) {
    const e = this.ext;
    if (!["js", "ts", "json", "py", "java", "go", "rs", "c", "cpp", "h", "sh", "sql", "css", "html", "xml", "yml", "yaml"].includes(e)) {
      return;
    }
    let text = pre.textContent;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    text = esc(text);
    // 注释 → 字符串 → 数字/关键字（顺序很重要，避免互相污染）
    const box = [];
    const stash = (html) => { box.push(html); return `\u0000${box.length - 1}\u0000`; };

    text = text.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => stash(`<span class="nb-hl-c">${m}</span>`));
    text = text.replace(/(&quot;|")(?:[^"\\]|\\.)*?\1|'(?:[^'\\]|\\.)*?'/g, (m) => stash(`<span class="nb-hl-s">${m}</span>`));
    text = text.replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => stash(`<span class="nb-hl-n">${m}</span>`));
    text = text.replace(
      /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|def|self|None|True|False|public|private|void|int|string|bool|struct|fn|impl|use|package)\b/g,
      (m) => stash(`<span class="nb-hl-k">${m}</span>`),
    );
    pre.innerHTML = text.replace(/\u0000(\d+)\u0000/g, (_, i) => box[Number(i)]);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._kkTimer);
    if (this._ooEditor) {
      try { this._ooEditor.destroyEditor(); } catch { /* 已销毁 */ }
      this._ooEditor = null;
    }
  }
}

/* -------------------------------------------------------------------------
 * 工具
 * ---------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * 智能解码文本（实现在 api.js，两边共用；见顶部 import 注释）
 */
function showMsg(text) {
  showMessage(text);
}

function getActiveProtyle() {
  const el = document.querySelector(".protyle-wysiwyg--focus") ||
             document.querySelector(".protyle-wysiwyg");
  if (!el) return null;
  const p = el.closest(".protyle");
  return p?._protyle || null;
}

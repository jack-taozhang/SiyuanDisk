/* ==========================================================================
 * 笔记内无缝嵌入（需求 ③）
 * --------------------------------------------------------------------------
 * 目标：把「文件树或特定文件页面」嵌进笔记正文，实现笔记与文件管理一体化。
 *
 * 实现方式：注册一个**自定义块（NodeCustomBlock）**。
 *
 * ★★★ 思源自定义块的 markdown 语法是「三个分号」围栏，不是反引号 ★★★
 *
 *   ;;;siyuan-nebuladisk/nebuladisk
 *   {"kind":"tree","mount":"售前项目","path":"2026/某项目"}
 *   ;;;
 *
 *   渲染时思源把块内 .custom-block__content 交给本插件的渲染器，
 *   渲染器把内容替换成一个可交互的目录浏览器，或一个文件预览 iframe。
 *   所有网络请求都走插件唯一的**直连**通道（src/api.js → 网盘 serverUrl）。
 *
 * ⚠️ 历史 bug（已定位并修复）：
 *   早期实现用 ```` ```nebuladisk ```` 反引号围栏，但**反引号围栏在思源里
 *   只会生成普通代码块（type=c）**，永远不是 NodeCustomBlock，因此
 *   自定义块渲染器根本不会被触发，笔记里就一直显示成一坨裸 JSON。
 *   实测（思源 3.8.4，/api/filetree/createDocWithMd）：
 *     ```nebuladisk                        → type=c   （普通代码块）
 *     ;;;siyuan-nebuladisk/nebuladisk      → type=custom ✓
 *   且反引号写法的整个围栏（含 ``` 行）会被原样存进 kramdown。
 *
 * 为什么选「自定义块」而不是挂件（widget）：
 *   · 挂件是独立目录 + 独立 iframe 沙箱，与本插件的登录态/session 隔离，拿不到会话
 *   · 自定义块渲染由本插件进程直接负责，可以复用同一个 sessionStorage 里的 token
 *   · 纯文本存储，跨设备同步、导出 Markdown 都不丢内容（最坏情况退化成一段 JSON）
 *
 * ★ 关于 iframe 与跨源 ★
 *   网盘端口（8089）≠ 思源端口（6806），所以 iframe 内容仍是跨 origin。
 *   网盘侧对预览地址**未下发 X-Frame-Options / CSP**（实测），
 *   且 iframe 直接指向网盘自身（同源于网盘），因此可以正常嵌入显示。
 *
 * ★ 关于编辑冲突 ★
 *   嵌入的是「只读浏览视图」。用户在嵌入内容里做的操作不会同步回笔记；
 *   笔记里保存的只是「指向哪个目录/文件」这一层信息。
 *   这是刻意的：笔记该是可移植的文本，不该背负网盘的状态。
 * ========================================================================== */

// ★ 跨模块依赖：网盘可达基点 ★
//   「打开网盘」按钮要拼出 NebulaDisk **网页版**的地址。
//   serverBase() 返回形如 http://192.168.193.70:8089 的**网盘地址**
//   （来自插件设置 serverUrl）。
//   ⚠️ 不要用 location.origin —— 那是思源自己的地址（6806）。
//      （历史提醒：以前还有个 proxyBase() 指 127.0.0.1:6810 的内置代理，
//        已于 2026-09-30 整体删除，不再是选项。）
/**
 * ★ 任务⑧（2026-09-23）：这里增加了 pickViewer 与 decodeSmart ★
 *   resolvePreviewUrl() 原来只按「扩展名数组」自己判 OFFICE / CAD，
 *   其余一律丢给 kkFileView ⇒ 图片/视频/音频/PDF/文本在嵌入块里全部
 *   绕道 kk 外壳（用户报的「图片在嵌入块里打不开」）。
 *   现在与 viewer.js 用**同一个** pickViewer() 判定，保证两条链路行为一致。
 *
 *   decodeSmart 是 renderNative() 的文本分支要用的（原文本解码 UTF-8/GBK 自动判）。
 *   ★ 曾漏配过一次：renderNative 里写了 `decodeSmart ? decodeSmart(buf) : …` 的
 *     兜底判断，于是**漏 import 时不会报错，只会在运行时静默降级**——
 *     页面上表现为「读取失败：decodeSmart is not defined」。
 *     靠真机跑一遍文本文件才发现（单测因为走了 falsy 分支而全绿）。
 *     ⇒ 教训：不要用 `typeof X !== 'undefined' ? X() : 兜底` 这种写法掩盖
 *        漏 import；真机验证必须覆盖每一个分支。
 */
import { serverBase, webDiskUrl, liteUrl, pickViewer, decodeSmart, displayMountPath } from "./api.js";
import { typeIconEl, extOf } from "./icons.js";
import { probeImageUrl, mountBlobImage, imageFailMessage, revokeBlobUrl } from "./media.js";
import { diag } from "./diag.js";

/**
 * ★ 最近一次「定位插入点」的逐步轨迹 ★
 *
 * locateInsertPoint() 是多级回退的，失败时必须能说清**卡在哪一级**，
 * 否则用户只能看到一句「找不到要插入的文档」，而他人明明开着文档 ——
 * 这种无从下手的报错是 2026-09-22 那一整轮排查的根源。
 * 这里把轨迹留在模块级，insertEmbedIntoDoc 失败时一并抛给调用方。
 * @type {string}
 */
let lastLocateTrace = "";

/* =========================================================================
 * 需求⑤：嵌入块的「按需加载」登记表
 * -------------------------------------------------------------------------
 * 用户原话：「需要考虑一下，什么时候这些插入的块载入？避免都是打开状态下，
 *           电脑性能、软件性能有影响。」
 *
 * 三层节流，从粗到细：
 *
 *   第 1 层 ─ 打开笔记时「一个都不加载」
 *     默认只渲染一个「点击预览」占位块。整整一篇嵌了 20 个文件的笔记，
 *     打开时对后端的请求数是 **0**。（见 renderPlaceholder）
 *
 *   第 2 层 ─ 手动控制加载（★ 任务④：不再自动收起 ★）
 *     由下面的 registry 实现。用户点开几个就是几个，互不干扰；
 *     之前「展开新的就自动收起旧的」已按用户要求删除（对照看两个文件很常用）。
 *     真要释放内存，用每个块自己的「收起」，或插件卸载时的 collapseAllOpenEmbeds()。
 *
 *   第 3 层 ─ 手动「收起」立即释放
 *     收起时销毁 iframe（iframe 一移除，浏览器就会回收它整个渲染上下文）
 *     并 revoke OnlyOffice 的 blob URL（否则那份 HTML 会一直挂在内存里）。
 *
 * 为什么不用 IntersectionObserver 做「滚到可视区才加载」：
 *   那会让「滚动 = 发请求」，用户在长笔记里上下滚两下就触发一串加载，
 *   反而更容易卡。显式点击是最可控、也最符合用户预期的方式。
 * ====================================================================== */

/**
 * 当前所有「已展开」的嵌入块。
 *
 * ★★★ 任务④：从「每文档一个」改成「每个块一个」★★★
 *
 *   用户原话：「当前页面中，点击预览后，再点击其他预览，原来的就会收起。
 *             这个需要调整一下。」
 *
 *   历史实现是 `Map<docKey, {wrap, collapse}>` —— **每篇文档只记一个**，
 *   于是展开第二个时必然要把第一个顶掉。那是当初为了「避免一篇笔记里
 *   挂八个重型编辑器拖垮电脑」而做的节流。
 *
 *   实际用下来这个节流是错的：
 *     · 用户经常要「左边文档、右边表格」对照着看，第一个被强制收起很烦；
 *     · 展开/收起本身是有成本的动作，用户没点就不该动；
 *     · 真要省资源，「收起」按钮本来就在，用户自己控制就行。
 *
 *   现在改成 `Set<{wrap, collapse}>`：登记所有已展开的块，**互不干扰**。
 *   每个块在自己的「收起」里注销自己，所以集合不会无限增长。
 *
 *   ★ 注意：集合里可能残留已经从 DOM 上消失的块（思源切页签/重渲染块
 *     会直接丢掉 DOM，不会回调我们）。所以 collapseAllOpenEmbeds() 里
 *     要跳过 `!isConnected` 的项 —— 否则对一个孤儿节点调用 collapse
 *     会抛错，把后面的清理也带崩。
 *
 * @type {Set<{wrap: Element, collapse: Function}>}
 */
const openEmbeds = new Set();

/** 登记「我展开了」 */
function registerOpenEmbed(self, collapse) {
  // 同一个块重复登记（先展开→收起→再展开）时，先清掉旧记录
  unregisterOpenEmbed(self);
  openEmbeds.add({ wrap: self, collapse });
}

/** 注销（收起时调） */
function unregisterOpenEmbed(self) {
  for (const rec of Array.from(openEmbeds)) {
    if (rec.wrap === self) openEmbeds.delete(rec);
  }
}

/**
 * 收起**全部**已展开的嵌入块。
 *
 * ★ 任务④：这个方法现在不在「展开新块」时调用了 ★
 *   保留它是因为两个合法场景还需要「一键全收」：
 *     ① 思源切换/关闭文档、插件 unload 时释放内存
 *     ② 将来若加「全部收起」按钮
 */
export function collapseAllOpenEmbeds() {
  for (const rec of Array.from(openEmbeds)) {
    try {
      // ★ 跳过已经脱离 DOM 的孤儿：思源重渲染块时不会通知我们，
      //   对孤儿调 collapse 会抛错并中断后面的清理。
      if (!rec.wrap || !rec.wrap.isConnected) { openEmbeds.delete(rec); continue; }
      rec.collapse && rec.collapse();
    } catch (e) {
      console.log("[nebuladisk] [embed] 收起失败（忽略）: " + (e && e.message));
    }
  }
  openEmbeds.clear();
}

/**
 * 解析代码块内容
 * @param {string} content
 * @returns {{kind:"tree"|"file", mount:string, path:string, name?:string, height?:number}|null}
 */
export function parseEmbed(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;

  // 期望是 JSON；容错处理「key=value 换行」的朴素写法
  let obj = null;
  if (raw.startsWith("{")) {
    try { obj = JSON.parse(raw); } catch { return null; }
  } else {
    obj = {};
    for (const line of raw.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  if (!obj || !obj.mount) return null;

  const kind = obj.kind === "file" ? "file" : "tree";
  let p = String(obj.path || "");
  // ★ 容错：早期版本写的嵌入块 path 没有前导斜杠 ★
  //   后端 /api/preview 的 path 以 "/" 开头（如 "/a/b.pdf"），缺了就补上，
  //   这样历史笔记里已经插入的旧块也能正常渲染，不必让用户手动重建。
  if (p && !p.startsWith("/")) p = "/" + p;
  return {
    kind,
    mount: String(obj.mount),
    path: p,
    name: obj.name ? String(obj.name) : "",
    height: Number(obj.height) || 0,
  };
}

/** 序列化回代码块内容（插入笔记时用） */
export function stringifyEmbed(spec) {
  const o = {
    kind: spec.kind,
    mount: spec.mount,
    path: spec.path || "",
  };
  if (spec.kind === "file" && spec.name) o.name = spec.name;
  if (spec.height) o.height = spec.height;
  return JSON.stringify(o);
}

/* -------------------------------------------------------------------------
 * 渲染器
 *
 * 注册到 plugin.customBlockRenders[<plugin name>]
 *
 * 说明：目录浏览**不走 iframe**，而是直接调用网盘 API 构建 DOM。原因：
 *   · 逐层交互需要与父文档通信，用 iframe 反而要多做一层消息桥
 *   · iframe 指向插件自身页面时，又多一层 origin 差异要处理
 * 只有「单个文件的完整预览」才用 iframe（复用 kkFileView 的渲染结果）。
 * ---------------------------------------------------------------------- */

/** 生成一个「目录浏览器」DOM —— 不依赖 iframe，直接调网盘 API 列目录 */
function renderTreeBrowser(spec, plugin) {
  const wrap = document.createElement("div");
  wrap.className = "nb-embed nb-embed-tree";
  wrap.setAttribute("contenteditable", "false");
  wrap.dataset.nbEmbed = "tree";

  let currentPath = spec.path || "";

  const head = document.createElement("div");
  head.className = "nb-embed-head";
  // ★ 需求2（2026-09-26）：与文件嵌入块一致 —— 去掉六点手柄 `⠿` ★
  head.innerHTML = `
    <span class="nb-embed-title">
      <svg><use xlink:href="#iconNebulaDisk"></use></svg>
      <span class="nb-embed-mount"></span>
      <span class="nb-embed-path"></span>
    </span>`;
  head.querySelector(".nb-embed-mount").textContent = spec.mount;
  const pathEl = head.querySelector(".nb-embed-path");

  const toolbar = document.createElement("span");
  toolbar.className = "nb-embed-tools";
  const upBtn = document.createElement("button");
  upBtn.className = "nb-embed-btn";
  upBtn.textContent = "↑ 上一级";
  upBtn.onclick = () => {
    const i = currentPath.lastIndexOf("/");
    currentPath = i < 0 ? "" : currentPath.slice(0, i);
    load();
  };
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "nb-embed-btn";
  refreshBtn.textContent = "刷新";
  refreshBtn.onclick = () => load();
  toolbar.appendChild(upBtn);
  toolbar.appendChild(refreshBtn);
  head.appendChild(toolbar);
  wrap.appendChild(head);

  // ★ 需求2（2026-09-26）：手柄已去掉 ⇒ 传 null，退化为整体拖动。
  makeEmbedDraggable(null, wrap, plugin);

  const list = document.createElement("div");
  list.className = "nb-embed-list";
  wrap.appendChild(list);

  async function load() {
    // ★ 任务26（第三轮/第四轮 · 真机截图定案）★
    //   头部是 `[盘符 .nb-embed-mount] + [路径 .nb-embed-path]` 并排显示，
    //   所以本元素**只放路径**。历史上这里写过两版错的：
    //     ① `:/${currentPath}`  → currentPath 已带前导斜杠 ⇒ `://`（用户报"多了一个 /"）
    //     ② `:${displayMountPath("", currentPath).slice(1)}` → 单斜杠对了，
    //        但仍带一个多余的冒号，跟文件嵌入的显示风格不一致
    //
    // ★ 需求3（2026-09-26）：**文件嵌入块**已改成一个元素显示
    //   `盘符:/路径`（见 renderFileEmbed）。但**目录浏览器**不动 ——
    //   它的路径是「随浏览实时变化」的，而工具条右边就跟着「↑ 上一级」，
    //   保持 `售前项目` + `/a/b` 两段反而更容易看出"当前在哪一级"。
    //   需求3 的原文只针对**文件**嵌入块（举例就是一个 .pdf），
    //   所以这里维持两段式，不跟着改。
    pathEl.textContent = currentPath ? displayMountPath("", currentPath).slice(1) : "";
    upBtn.style.visibility = currentPath ? "visible" : "hidden";
    list.innerHTML = `<div class="nb-embed-loading">加载中…</div>`;
    let data;
    try {
      data = await plugin.api.list(spec.mount, currentPath);
    } catch (e) {
      list.innerHTML = "";
      const err = document.createElement("div");
      err.className = "nb-embed-error";
      err.textContent = `读取失败：${e.message}`;
      list.appendChild(err);
      return;
    }
    const entries = data.entries || [];
    list.innerHTML = "";
    if (!entries.length) {
      list.innerHTML = `<div class="nb-embed-loading">（空文件夹）</div>`;
      return;
    }
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "nb-embed-row" + (e.isDir ? " is-dir" : "");
      const ico = document.createElement("span");
      ico.className = "nb-embed-ico";
      // ★ 任务25b ★ 以前这里是 emoji（📁 / 📄），与侧边栏/网格/选择器的
      //   彩色类型图标是两套视觉。用户要求「文件夹和文件图标需要调整一下」，
      //   所以统一走 typeIconEl()：目录给真正的文件夹图标，文件按扩展名给
      //   彩色徽标（PDF 红、3D 青、SRC 灰蓝…）。
      try {
        ico.appendChild(typeIconEl(e.ext || extOf(e.name), !!e.isDir));
      } catch { /* 图标失败不影响打开文件 */ }
      const nm = document.createElement("span");
      nm.className = "nb-embed-name";
      nm.textContent = e.name;
      const sz = document.createElement("span");
      sz.className = "nb-embed-size";
      sz.textContent = e.isDir ? "" : fmtSize(e.size);
      row.appendChild(ico);
      row.appendChild(nm);
      row.appendChild(sz);
      row.onclick = () => {
        if (e.isDir) {
          currentPath = currentPath ? `${currentPath}/${e.name}` : e.name;
          load();
        } else {
          plugin.openFile({
            mount: spec.mount,
            path: currentPath ? `${currentPath}/${e.name}` : e.name,
            name: e.name,
            ext: e.ext,
            size: e.size,
            mtime: e.mtime,
          }, { forceNew: true });
        }
      };
      list.appendChild(row);
    }
  }

  load();
  return wrap;
}

/**
 * ★★★ 任务27：嵌入块在笔记内「上下拖动排序」，拖动时视图跟随定位 ★★★
 *
 * 需求原话：「嵌入块可以上下拖动排序（笔记内），拖动的时候文档视图
 *           要跟着定位到这个嵌入块。」
 *
 * ── 拖动的是什么？不是 DOM，是**思源的块顺序** ──────────────────────
 *
 *   嵌入块在笔记里是一个 `type=custom` 的**真实块**（有 data-node-id）。
 *   如果把 .nb-embed 这个 div 在 DOM 里搬来搬去，只是个视觉假象：
 *   一刷新/一切页签，思源按内核里的块顺序重渲染，顺序就弹回去了。
 *   ⇒ 必须调内核 `/api/block/moveBlock {id, previousID, parentID}` 真的改顺序。
 *
 * ── 为什么要「视图跟随」────────────────────────────────────────────
 *
 *   moveBlock 之后块会被挪到别处，而编辑器的滚动位置不会自动跟。
 *   拖到文档末尾时块跑到屏幕外，用户看不到自己刚拖的结果，观感是"没生效"。
 *   ⇒ 每次落位后主动 scrollIntoView。
 *   （思源 v3.1.28 起 moveBlock 后会 ReloadProtyle 刷新编辑器，
 *     但**滚动位置仍不会自动跟随**，所以这里必须自己滚。）
 *
 * ── 落位判定：用「拖到了哪个兄弟块的哪半边」决定 previousID ──────────
 *
 *   拖动时监听 dragover，命中某个同级嵌入块的中线以上 ⇒ 插到它前面，
 *   中线以下 ⇒ 插到它后面。
 *   同级块的范围限定在**同一个文档**里、且都是本插件的嵌入块，
 *   避免把块挪进别的容器（moveBlock 对嵌套容器有额外校验，会失败）。
 *
 * ★ 需求2（2026-09-26）：handleEl 允许为 null ★
 *
 *   去掉六点手柄之后，调用方传 null —— 这时改用 **wrapEl 本身**作拖动源。
 *   仍然可拖，但语义变化要写清楚：
 *     · 手柄版：只有按住 `⠿` 才起拖 ⇒ 头部其余区域能正常选中文本
 *     · 整体版：整个嵌入块都是拖动源。嵌入块头上是按钮、下面常是 iframe，
 *       文本选择需求很低；而 `draggable=true` 只对**普通文本节点**的选中
 *       有影响，按钮/iframe 不受累（iframe 还会在 dragstart 里被禁指针）。
 *   ⇒ 功能不丢，视觉变干净，符合用户「去掉那个字」的意图。
 *
 * @param {HTMLElement|null} handleEl 拖动手柄（放进头部）；传 null 表示用整体
 * @param {HTMLElement} wrapEl   整个嵌入块容器（用来找到自己 / 同级块）
 * @param {object} plugin        插件实例（取 api、日志）
 * @returns {{setDraggable: Function}}
 */
function makeEmbedDraggable(handleEl, wrapEl, plugin) {
  // 无手柄时，`handle` 在下面被重新指向头部元素（let，可重新赋值）
  let handle = handleEl || null;
  /** 收集同一文档里的同级嵌入块（按 DOM 顺序 = 视觉顺序） */
  function siblingEmbeds() {
    const root = wrapEl.closest(".protyle-wysiwyg") || document;
    // 只取「直接挂在编辑区里」的嵌入块，排除嵌套在别的嵌入块里的
    return Array.from(root.querySelectorAll(".nb-embed"))
      .filter((el) => {
        // 排除自己内部嵌套的（避免把子块的 dragover 当成同级的）
        let p = el.parentElement;
        while (p && p !== root) {
          if (p.classList && p.classList.contains("nb-embed")) return false;
          p = p.parentElement;
        }
        return true;
      });
  }

  /** 找到承载本嵌入块的思源块（带 data-node-id 的最近祖先） */
  function ownBlockEl() {
    let p = wrapEl;
    while (p) {
      if (p.getAttribute && p.getAttribute("data-node-id")) return p;
      p = p.parentElement;
    }
    return null;
  }

  /** 同级思源块元素（带 data-node-id 的同层块） */
  function siblingBlockEls() {
    const self = ownBlockEl();
    if (!self || !self.parentElement) return [];
    return Array.from(self.parentElement.children)
      .filter((el) => el.getAttribute && el.getAttribute("data-node-id"));
  }

  async function kb(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  let dragging = false;

  // ★ 需求2（2026-09-26）：手柄 `⠿` 已从头部移除 ⇒ handleEl 传 null。
  //   退化策略：拿**头部 `.nb-embed-head`** 当拖动源，而不是整个 wrapEl。
  //     · 头部是信息条（图标 + 路径 + 按钮），没有 iframe ⇒ 拖动稳定
  //     · 主体（含 iframe 预览区）不加 draggable ⇒ 不影响预览内的交互
  //   `draggable=true` 需要「按下 + 位移」才触发 dragstart ⇒ 单击按钮不受影响。
  if (handleEl) {
    handleEl.draggable = true;
    handleEl.classList.add("nb-embed-drag");
    handle = handleEl;
  } else {
    const headEl = wrapEl.querySelector(".nb-embed-head") || wrapEl;
    headEl.draggable = true;
    headEl.classList.add("nb-embed-drag");
    handle = headEl;
  }

  handle.addEventListener("dragstart", (ev) => {
    dragging = true;
    handle.classList.add("is-dragging");
    wrapEl.classList.add("is-dragging");
    try {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", ownBlockEl() ? ownBlockEl().getAttribute("data-node-id") : "nb-embed");
    } catch { /* 忽略 */ }
    // 拖动期间禁止 iframe 抢事件（否则鼠标划到预览区就丢了 dragover）
    for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
      f.style.pointerEvents = "none";
    }
  });

  handle.addEventListener("dragend", () => {
    dragging = false;
    handle.classList.remove("is-dragging");
    wrapEl.classList.remove("is-dragging");
    for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
      f.style.pointerEvents = "";
    }
    clearMarks();
  });

  /** 清除所有落位提示线 */
  function clearMarks() {
    for (const el of Array.from(document.querySelectorAll(".nb-embed-drop-before, .nb-embed-drop-after"))) {
      el.classList.remove("nb-embed-drop-before", "nb-embed-drop-after");
    }
  }

  /**
   * 拖动到某个同级块的哪半边 ⇒ 决定 previousID。
   *
   * ★ 落位语义（已在 NAS 内核上实测确认，不猜）★
   *
   *   `/api/block/moveBlock {id, previousID}` 的语义是
   *   **把 id 移到 previousID 之后**（实测：C 移到 A 之后 ⇒ 顺序 …A,C…）。
   *   所以「插到某个块 X 之前」= 移到 **X 的前一个兄弟** 之后。
   *
   * ★ 为什么不做「插到文档最前面」★
   *
   *   当 X 已经是第一个兄弟时，它前面没有块 ⇒ 没有可用的 previousID。
   *   我试过「把当前的第一个块移到被拖块之后」的两步法，
   *   实测结果是错的（A 会落到倒数第二位，不是第一位）。
   *   ⇒ 与其塞一段会更错的补偿逻辑，不如把交互收敛到**永远成立**的形态：
   *     上半 ⇒ 插到 X 之前（要求 X 有前兄弟）；
   *     X 是第一个时，上半区**不响应**（等价于"已经是最前了"），
   *     用户想放最前，就拖到第二个块的上半区 —— 结果完全一样。
   *
   *   少一个分支，就少一类只在边界触发的 bug。
   */
  function resolveDropTarget(clientY) {
    const self = ownBlockEl();
    if (!self) return null;
    const blocks = siblingBlockEls()
      .filter((el) => el !== self && el.querySelector(".nb-embed"));
    if (!blocks.length) return null;

    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        if (clientY < r.top + r.height / 2) {
          // 上半区 ⇒ 插到 el 之前 = 移到 el 的前一个兄弟之后
          const prev = prevBlockOf(el);
          if (!prev) return null;   // el 已是第一个 ⇒ 无处可插
          return { previousID: prev.getAttribute("data-node-id") };
        }
        // 下半区 ⇒ 插到 el 之后
        return { previousID: el.getAttribute("data-node-id") };
      }
    }
    // 落在所有块之外（上方/下方留白）⇒ 不动
    return null;
  }

  function prevBlockOf(el) {
    let p = el.previousElementSibling;
    while (p && !(p.getAttribute && p.getAttribute("data-node-id"))) p = p.previousElementSibling;
    return p;
  }

  /** 执行落位（单次 moveBlock，语义已实测确认） */
  async function applyMove(clientY) {
    const self = ownBlockEl();
    if (!self) return;
    const target = resolveDropTarget(clientY);
    if (!target) return;

    const myId = self.getAttribute("data-node-id");
    if (target.previousID === myId) return;   // 拖到自己后面无意义

    const res = await kb("/api/block/moveBlock", { id: myId, previousID: target.previousID });
    if (!res || res.code !== 0) {
      try {
        console.log("[nebuladisk] [embed] moveBlock 失败: " + JSON.stringify(res && res.msg));
      } catch { /* 忽略 */ }
      return;
    }
    afterMoved();
  }

  /**
   * ★ 落位之后：让视图跟随到这个嵌入块 ★
   *   用 requestAnimationFrame 等内核把新结构渲染完再滚，
   *   否则滚动的是旧位置的盒子，滚完还是看不见。
   */
  function afterMoved() {
    const scroll = () => {
      try {
        const el = ownBlockEl() || wrapEl;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch { /* 忽略 */ }
    };
    try {
      requestAnimationFrame(() => requestAnimationFrame(scroll));
    } catch {
      setTimeout(scroll, 50);
    }
  }

  // 在文档级监听拖动经过（比在每个兄弟块上挂 dragover 更稳，
  // 因为拖动时鼠标可能扫过空白/iframe 区域）
  document.addEventListener("dragover", (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    clearMarks();
    const self = ownBlockEl();
    if (!self) return;
    const blocks = siblingBlockEls().filter((el) => el !== self && el.querySelector(".nb-embed"));
    for (const el of blocks) {
      const r = el.getBoundingClientRect();
      if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
        el.classList.add(ev.clientY < r.top + r.height / 2 ? "nb-embed-drop-before" : "nb-embed-drop-after");
        break;
      }
    }
  });

  document.addEventListener("drop", (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    dragging = false;
    handle.classList.remove("is-dragging");
    wrapEl.classList.remove("is-dragging");
    for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
      f.style.pointerEvents = "";
    }
    const y = ev.clientY;
    clearMarks();
    applyMove(y);
  });

  return {
    /** 允许外部（如设置项）开/关拖动 */
    setDraggable(on) {
      // ★ 需求2：无手柄模式下 handle === .nb-embed-head。
      //   此时**不能**用 display:none 关掉它 —— 那会把整个头部藏起来，
      //   用户连路径和按钮都看不见了。只摘掉 draggable 即可。
      handle.draggable = !!on;
      if (handleEl) handleEl.style.display = on ? "" : "none";
    },
  };
}

/**
 * 生成一个「单个文件」的嵌入视图。
 *
 * ★ 两条硬性要求（用户 2026-09-22 提出）★
 *
 *   ①「有的文件思源内置查看器不支持，要用 NebulaDisk 的网页来预览/编辑」
 *      ⇒ 预览**一律走 NebulaDisk 的预览链路**（plugin.api.previewUrl），
 *        它内部会按扩展名路由到 OnlyOffice / kkFileView / CAD 查看器，
 *        覆盖的格式远多于思源自带的 PDF/图片查看器。
 *        **绝不**把文件塞给思源自己的查看器。
 *
 *   ②「不要自动加载，点击预览」
 *      ⇒ 默认**只渲染一行文件信息 + 一个「点击预览」按钮**，
 *        不请求后端、不建 iframe。用户点一下才真正加载。
 *        这样一篇笔记里放十个嵌入块也不会一打开就并发十个预览请求
 *        （kkFileView 首屏要转换，十个一起转会明显卡）。
 *        加载后按钮变成「收起」，可以随时卸载 iframe 释放内存。
 */
function renderFileEmbed(spec, plugin) {
  const wrap = document.createElement("div");
  wrap.className = "nb-embed nb-embed-file";
  wrap.setAttribute("contenteditable", "false");
  wrap.dataset.nbEmbed = "file";

  const head = document.createElement("div");
  head.className = "nb-embed-head";
  // ★★★ 需求2（2026-09-26）：头部不再有六点拖动手柄 ★★★
  //
  //   用户原话：「去掉网盘文件嵌入块路径前面显示的那个6个点，
  //             分两列三排显示的那个字。」
  //   那就是 `⠿`（U+283F BRAILLE PATTERN DOTS-123456），
  //   浏览器里按 2 列 × 3 排渲染，视觉上「6 个点」。
  //
  //   手柄只是**拖动排序**的把手，去掉之后：
  //     · 嵌入块仍在文档里可选中 / 可剪切（思源原生块操作不受影响）
  //     · makeEmbedDraggable 明确支持 handleEl 为 null（见该函数注释），
  //       改用 wrapEl 自身作拖动源 ⇒ 拖动排序功能不丢
  head.innerHTML = `
    <span class="nb-embed-title">
      <svg><use xlink:href="#iconNebulaDisk"></use></svg>
      <span class="nb-embed-path"></span>
    </span>`;
  // ★★★ 需求3（2026-09-26）：路径显示「盘符:/路径」 ★★★
  //
  //   用户原话：「目前是 售前项目/FA&JG-项目评审会议规范要求.pdf
  //             调整为 售前项:/FA&JG-项目评审会议规范要求.pdf」
  //
  //   注意用户写的是 **`售前项:`**（少一个「目」字），那是**举例时的手误** ——
  //   盘符名本身不可能被截断，所以这里保留完整盘符 `售前项目:`。
  //
  //   历史四轮演进（前四轮都没走到这个形态，记下来免得再回头）：
  //    ① 第一轮：`filePathRaw ? ":" + filePathRaw : ""`
  //       → path 带前导斜杠时拼出 `://`（用户报「多了一个 /」）
  //    ② 第二轮：`displayMountPath(spec.mount, filePathRaw)` 塞进 path 元素
  //       → 盘符显示**两次**（`.nb-embed-mount` 一份 + path 一份）
  //    ③ 第三轮：`.nb-embed-mount` = 盘符、`.nb-embed-path` = 斜杠之后
  //       → 视觉上 `售前项目` 与 `/FA&JG-….pdf` 之间**有 5px 的 flex gap**，
  //         拼起来是「售前项目 /FA&JG-….pdf」，不是用户要的紧贴形态
  //    ④ 本轮：**合并为一个元素**，直接放 displayMountPath 的完整返回
  //       ⇒ `售前项目:/FA&JG-项目评审会议规范要求.pdf`（无空格、无重复）
  //
  //   ⚠️ displayMountPath("盘","") 返回 `盘:/` 而**不是**空串，
  //     所以必须先判空再调用，不能靠 `|| ""` 兜底（死兜底）。
  const filePathRaw = spec.path || spec.name || "";
  head.querySelector(".nb-embed-path").textContent =
    filePathRaw ? displayMountPath(spec.mount, filePathRaw) : spec.mount || "";

  const toolbar = document.createElement("span");
  toolbar.className = "nb-embed-tools";

  // ★★★ 任务①：「收起」前置到「在页签中打开」之前，且未预览时隐藏 ★★★
  //
  //   用户原话：「点击预览后出现的 收起按钮 放到在页签中打开 前面，
  //             没有预览前 隐藏，同时增加下载按钮。」
  //
  //   历史实现把「收起」建在 loadFrame() 里、挂在 frameBox（预览框）右上角，
  //   于是出现两个问题：
  //     · 按钮位置在预览区而不是工具栏，和「在页签中打开」不在一条线上
  //     · 按钮节点随 iframe 一起被 frameBox.innerHTML="" 干掉，
  //       收起/展开状态没法统一管理
  //   ⇒ 现在把「收起」固定在工具栏最左侧（第一个子元素），
  //     初始 display:none，只有真的加载出 iframe 之后才显示。
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "nb-embed-btn nb-embed-btn--collapse";
  collapseBtn.textContent = "收起";
  collapseBtn.title = "卸载预览内容，释放内存（不改变笔记里的嵌入块）";
  collapseBtn.style.display = "none";
  collapseBtn.onclick = () => renderPlaceholder("点击预览");
  toolbar.appendChild(collapseBtn);

  const openBtn = document.createElement("button");
  openBtn.className = "nb-embed-btn";
  openBtn.textContent = "在页签中打开";
  openBtn.onclick = () => plugin.openFile({
    mount: spec.mount, path: spec.path, name: spec.name || spec.path,
  }, { forceNew: true });
  toolbar.appendChild(openBtn);

  // ★ 任务①：新增「下载」按钮 ★
  //   必须异步拿**带签名的直链**：直连下走 /api/raw?…&sig=…
  //   （跨源拿不到 Cookie，只能靠签名）。
  //   旧代码用同步 downloadUrl()，直连时会拼出 127.0.0.1:6810
  //   ⇒ ERR_CONNECTION_REFUSED（用户报的「下载会报错」）。
  const dlBtn = document.createElement("button");
  dlBtn.className = "nb-embed-btn nb-embed-btn--download";
  dlBtn.textContent = "下载";
  dlBtn.title = "从 NebulaDisk 下载该文件";
  dlBtn.onclick = async () => {
    try {
      const url = await plugin.api.signedDownloadUrl(spec.mount, spec.path, false);
      const a = document.createElement("a");
      a.href = url;
      a.download = spec.name || (spec.path || "").split("/").pop() || "download";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.log("[nebuladisk] [embed] 下载失败: " + (e && e.message));
    }
  };
  toolbar.appendChild(dlBtn);

  // ★ 「打开网盘」——跳到 NebulaDisk 自己的网页界面 ★
  //   需求原文：「有的文件思源内置查看器不支持，要用 nebuladisk 的网页，
  //             可以预览或编辑更多的文件格式」。
  //   嵌入块的 iframe 走的已经是 NebulaDisk 预览链路（OnlyOffice /
  //   kkFileView / CAD），但有些操作（浏览目录、上传、下载、多选、
  //   压缩包逐层进）只有**完整的网盘界面**才有。
  //
  // ★★★ 任务②：这里的地址曾经是错的（用户截图报的 bug）★★★
  //
  //   历史实现：`proxyBase() + "/?mount=…&path=…"`
  //   产出：    http://127.0.0.1:6810/?mount=售前项目&path=/…
  //
  //   三处都错：
  //     ① 主机错：proxyBase() 是**本地代理**（127.0.0.1:6810）。
  //        但「打开网盘」是要在浏览器里开**网盘网页版**，
  //        那在 serverUrl（http://192.168.193.70:8089）。
  //        桌面端 127.0.0.1 上恰好也有个代理在听，所以能开出一个页面，
  //        但那不是网盘界面（是代理），网页端/手机端则直接连接被拒。
  //     ② 端口错：6810 是插件代理端口，不是网盘端口（8089）。
  //     ③ 参数错（当时实测确认）：NebulaDisk 前端**当时**不解析这两个参数。
  //
  //   ⇒ 分两步修好：
  //     · 插件侧：用 serverBase()（浏览器可达地址），不再用 proxyBase()
  //     · 后端侧：**给 NebulaDisk 补上深链支持**（见下）
  //
  // ★★★ 任务③深链：现在带参数了，而且网盘真的会跳过去 ★★★
  //
  //   用户原话：「打开网盘 应该是 打开到对应嵌入块 对应文件所在的目录。」
  //
  //   我先把「网盘前端到底能不能深链」查清楚了（不猜）：
  //     四个 JS bundle 全是 locationSearch:false / locationHash:false /
  //     hashchange:false，四种候选 URL 形式都停在登录页。
  //     —— 但发现前端**已有现成能力**，只是没人从 URL 喂给它：
  //        Explorer.open(mountLabel, initialPath)
  //          └ navigate(win, S, initialPath || '/', {replace:true})
  //        而且同一映射已开窗时会 existing.opts.nav.go(initialPath)
  //        —— 原地跳转，不叠新窗口。
  //
  //   于是给网盘后端打了一个最小补丁（patch-deeplink.py）：
  //     app.js 的 enterDesktop() 末尾读一次 ?mount=&path= 交给 Explorer.open()。
  //   浏览器 E2E 已验证：面包屑落在目标目录、query 被 replaceState 清掉、
  //   未知盘名被拒、无参数时行为不变（6/0）。
  //
  //   ⇒ 所以这里重新带上参数，并且 path 用**文件所在目录**（不是文件本身）——
  //     网盘是文件管理器，落在目录上才能看到「这个文件在哪个位置」。
  const webBtn = document.createElement("button");
  webBtn.className = "nb-embed-btn";
  webBtn.textContent = "打开网盘";
  webBtn.title = "在浏览器中打开 NebulaDisk 网页版，并定位到该文件所在的目录";
  webBtn.onclick = () => {
    // ★ 用 serverBase()：那是**浏览器可达的网盘地址**（http://192.168.193.70:8089）
    //   （历史：曾误用 proxyBase()，即 127.0.0.1:6810 的内置代理 —— 已删除。）
    let base = "";
    try { base = serverBase(); } catch { /* 忽略 */ }
    if (!base) {
      // 没配 serverUrl 时退到 settings 上再从 location 推一次
      try {
        const st = window.__nebuladiskPlugin && window.__nebuladiskPlugin.settings;
        base = String((st && st.serverUrl) || "").trim();
      } catch { /* 忽略 */ }
    }
    if (!base) {
      console.log("[nebuladisk] [embed] 未配置网盘地址，无法打开网盘网页版");
      return;
    }

    // ★ 任务③：拼深链 —— 定位到「该文件所在的目录」★
    const url = webDiskUrl(base, spec.mount, spec.path);
    window.open(url, "_blank", "noopener");
  };
  toolbar.appendChild(webBtn);

  /* ★ 任务⑳：「定位到文件树」——
   *   用户原话：「点击插入后的嵌入块，右侧文档树转跳到这个路径所在位置。」
   *
   *   和「打开网盘」的区别：
   *     · 打开网盘  ⇒ 开**浏览器新页签**，去 NebulaDisk 网页版
   *     · 定位       ⇒ 在**思源内**把右侧 NebulaDisk 文件树展开并滚到该路径
   *   两个是不同需求，都要有。
   *
   *   实现：调 plugin 暴露的 revealTree(mount, path)（见 index.js），
   *   它转发到 TreePanel.revealPath()。插件没就绪/文件树没挂载时给个提示，
   *   不要让用户点了没反应。
   */
  const locateBtn = document.createElement("button");
  locateBtn.className = "nb-embed-btn nb-embed-btn--locate";
  locateBtn.textContent = "定位";
  locateBtn.title = "在右侧 NebulaDisk 文件树里定位到该路径";
  locateBtn.onclick = async () => {
    try {
      const fn = plugin.revealTree;
      if (typeof fn !== "function") {
        console.log("[nebuladisk] [embed] 插件未暴露 revealTree，无法定位");
        return;
      }
      const ok = await fn.call(plugin, spec.mount, spec.path);
      if (!ok) console.log("[nebuladisk] [embed] 文件树未能定位（可能需要先打开 NebulaDisk 面板）");
    } catch (e) {
      console.log("[nebuladisk] [embed] 定位失败: " + ((e && e.message) || e));
    }
  };
  toolbar.appendChild(locateBtn);
  head.appendChild(toolbar);
  wrap.appendChild(head);

  // ★ 任务27：文件嵌入块可拖动排序（拖动时视图跟随定位到本块）★
  //   ★ 需求2（2026-09-26）：手柄已去掉 ⇒ 传 null，
  //     makeEmbedDraggable 会退化成用整个头部 wrapEl 当拖动源。
  makeEmbedDraggable(null, wrap, plugin);

  const frameBox = document.createElement("div");
  frameBox.className = "nb-embed-frame-box";
  wrap.appendChild(frameBox);

  /**
   * 本块自己创建的 blob URL（图片自愈时产生）。
   *
   * ★ 为什么不用全局表 ★
   *   同一篇文档可以同时展开多个嵌入块，各自可能持有 blob。
   *   用模块级集合统一回收的话，A 块重建会把 B 块正在用的 blob 也 revoke
   *   ⇒ B 的图突然变裂图。所以只回收「自己造的那些」。
   */
  const myBlobs = [];
  function rememberBlob(u) {
    if (u) myBlobs.push(String(u));
    return u;
  }
  function releaseMyBlobs() {
    for (const u of myBlobs.splice(0)) revokeBlobUrl(u);
  }

  /** 当前 iframe（null 表示还没加载） */
  let frame = null;
  /** 是否已在加载/已加载，避免重复请求 */
  let state = "idle"; // idle | loading | loaded
  /** OnlyOffice 用的 blob URL，需要在卸载时 revoke，否则内存泄漏 */
  let blobUrl = "";

  /** 释放 blob URL（每次卸载/重建 iframe 前都要调） */
  function releaseBlob() {
    if (blobUrl) {
      try { URL.revokeObjectURL(blobUrl); } catch { /* 忽略 */ }
      blobUrl = "";
    }
  }

  /**
   * 按扩展名选预览链路 —— 目的是「能预览/编辑更多格式」。
   *
   *   · Office（doc/docx/xls/xlsx/ppt/pptx…）→ OnlyOffice：**可在线编辑**
   *     这是思源内置查看器做不到的（它只是只读渲染）。
   *   · 浏览器原生可直出的（图片/视频/音频/PDF/文本）→ **直出**（见下）
   *   · 其它（压缩包 / 3D / STEP / CAD / 未知）→ kkFileView / cad-viewer
   *
   * 拿不到 OnlyOffice 配置时自动降级到 kkFileView（后端 ooConfig 会抛错）。
   *
   * ★ 任务③/⑤：嵌入块是「轻量预览」—— 各链路都要收菜单栏 ★
   *
   *   Office ⇒ OnlyOffice 配置里下掉全部工具栏（见 liteOoConfig，
   *            必须由**后端在签名前**做，前端改不了，理由见 buildOoFrameUrl）
   *   其它   ⇒ 走 NebulaDisk 的 `/lite` 外壳页（见下方 api.liteUrl 注释）
   *
   *   ★★★ 为什么不再自己造宿主页（重要修正）★★★
   *     原先这里返回插件的 `buildLiteFrameUrl(...)`，即用 blob: 造宿主页、
   *     再往子 iframe 注入 CSS。**真机实测证明它不生效**：
   *       blob: 继承思源 origin (:6806)，预览页在 :8089 ⇒ 跨源
   *       ⇒ innerDocReadable === false ⇒ CSS/守卫都够不到子文档。
   *     现在改走服务端的 /lite —— 外壳页与预览页同在 :8089，
   *     同源才可能注入（实测 readable/hasCss/hasGuard 全 true）。
   *
   * ★★★ 任务⑧ 修复（2026-09-23）：图片/视频/音频/PDF/文本 必须「原生直出」★★★
   *
   *   问题（用户报的「图片在嵌入块里打不开」）：
   *     这个函数原来只分 OFFICE / CAD / **其余** 三支，**从不看 pickViewer()**，
   *     于是图片被当成「其它」塞进 kkFileView：
   *         /lite?kind=kk&target=%2Fpreview%2FonlinePreview%3Furl%3D<base64>
   *     多绕两层（/lite 外壳 → kk 的 onlinePreview → base64 里再套 /api/raw），
   *     而 kkFileView 对图片本就没有必要介入 —— 它只是个转发。
   *
   *   为什么必须改：**页签上的同类型文件是好的**（用户确认 + 真机实测）。
   *     viewer.js 的 render() 走 pickViewer() 分九类，图片走 renderImage()
   *     → `signedDownloadUrl(inline=1)` → 直接赋给 `<img>.src`，零转换。
   *     同一条正确链路，嵌入块却完全没接。**两条链路行为不一致**才是本质缺陷。
   *
   *   实测证据（headed Chrome 153，new Image() 真解码）：
   *     1329b53d….jpg → 1279×1706 ✅  提升机位置.bmp → 2420×884 ✅  1.png → 620×876 ✅
   *
   *   量化：共 **49 个扩展名**在嵌入块里被误路由
   *     image(9) / video(7) / audio(7) / text(25) / pdf(1)
   *
   *   改法：先过 pickViewer()，命中原生类型就返回 {kind:"native", media, url}，
   *         由 loadFrame() 建对应的 <img>/<video>/<audio>/<iframe>，
   *         **完全不经过 kkFileView**。
   *
   *   ★ 为什么 PDF 也归 native ★
   *     viewer.js 的 renderPdf() 目前仍走 renderKk()（注释说「部分环境内置
   *     PDF 插件不可用」）。但嵌入块场景下 /lite 外壳会再套一层 iframe，
   *     而浏览器原生 PDF 查看器本身就需要整个视口 —— 嵌入块里给个 iframe
   *     直连 /api/raw 反而更轻、更稳，且 <= 与页签行为不同是有意的：
   *     页签有 kk 的工具栏可用来翻页/下载，嵌入块只求「看到内容」。
   *     若本机浏览器确实不支持内联 PDF，用户仍可用「在页签中打开」。
   *
   *   ★ 文本为什么用 fetch 而不是 iframe ★
   *     /api/raw 返回的 content-type 是 text/plain（或具体 MIME），
   *     直接 iframe 会渲染成**一整片无换行折叠的裸文本**，且可能触发下载。
   *     页签里 renderText() 是 fetch + <pre>，嵌入块沿用同一做法（<pre> 带滚动）。
   */
  async function resolvePreviewUrl() {
    const name = spec.name || spec.path || "";
    const ext = String(name).slice(String(name).lastIndexOf(".") + 1).toLowerCase();
    const OFFICE = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "odt", "ods", "odp", "rtf"];
    const CAD = ["dwg", "dxf", "dwf"];
    const base = serverBase();

    /** 统一的「套 /lite 外壳」出口；拿不到就退回直连预览页（功能可用，只是收不掉菜单栏）。 */
    const wrap = (rawUrl, kind) => {
      const target = String(rawUrl || "");
      if (!target) return target;
      const lite = liteUrl(base, target, kind);
      if (lite) return lite;
      // 降级：/lite 不可用（老后端）或地址不合法 ⇒ 直连
      console.log("[nebuladisk] [embed] /lite 不可用，直连预览（菜单栏不会收起）");
      return target;
    };

    // ★★★ 任务⑧：浏览器能原生直出的类型，走直出，不碰 kkFileView ★★★
    //   放在 OFFICE 之前：这几类与 Office 集合**无交集**（已验证），
    //   但 pdf/txt 在别处可能被算作 Office 家族，这里先拦下更明确。
    const native = pickViewer(name);
    if (native === "image" || native === "video" || native === "audio" ||
        native === "pdf" || native === "text") {
      // 直连下走 /api/raw?…&sig=…（跨源拿不到 Cookie，只能靠签名）
      // inline=true 很关键：否则会带 Content-Disposition: attachment 触发下载
      const url = await plugin.api.signedDownloadUrl(spec.mount, spec.path, true);
      if (!url) throw new Error("后端未返回可用的直链");
      return { kind: "native", media: native, url };
    }

    if (OFFICE.indexOf(ext) >= 0) {
      // Office：优先 OnlyOffice（可编辑）
      //   后端返回结构（已核实 routers/onlyoffice.py）：
      //     { ok, config, apiJs, mode, title }
      //   —— 没有 documentServerUrl 字段；iframe 用 srcdoc 自建宿主页即可。
      try {
        // ★ 任务③：传 embed=1 让**后端**在签名前换成精简配置 ★
        //   （前端不能改 config —— token 签的是整份 config，见下方注释）
        const cfg = await plugin.api.ooConfig(spec.mount, spec.path, WANT_LITE_OFFICE);
        if (cfg && cfg.ok && cfg.config && cfg.apiJs && cfg.config.document) {
          return { url: buildOoFrameUrl(cfg, WANT_LITE_OFFICE), kind: "office", cfg };
        }
        console.log("[nebuladisk] [embed] ooConfig 返回不完整，降级 kkFileView");
      } catch (e) {
        // 忽略，降级 kkFileView
        console.log("[nebuladisk] [embed] OnlyOffice 不可用，降级 kkFileView: " + (e && e.message));
      }
    }

    if (CAD.indexOf(ext) >= 0) {
      try {
        const r = await plugin.api.cadUrl(spec.mount, spec.path);
        // ★★★ 任务31-rev（2026-09-23）：下面这段结论已被**实测推翻并纠正** ★★★
        //
        //  【曾经写在这里的错误结论】（任务31 第一版，已作废，留痕以防重犯）
        //     「查看器设置只在模块内部 Il.instance.settings，不是 localStorage，
        //       页面拿不到 ⇒ 只能 CSS display:none。」
        //  错在两处：
        //    ① 查错了 bundle。我读的是 cad-viewer-BAlsMkgn.js，而服务 /cad/ 的
        //       入口是 assets/main-CoLbfQ3X.js。
        //    ② 键名猜错。我往 localStorage["settings"] 写、发现无效，就断言
        //       「不读 localStorage」。真实键名见下。
        //
        //  【实测正确结论】
        //    main-CoLbfQ3X.js 的 App.setup 第一行就是：
        //        Qe.configure({ storageKey: "mlightcad.settings.cad-viewer" })
        //    存储类 Ms 用它当 localStorage 键读写；computeEffective() 里
        //        return { ...QL, ..._user, ..._session }
        //    默认表 QL = { isShowCommandLine:!0, isShowEntityInfo:!1, isShowRibbon:!0,
        //                  isShowToolbar:!0, isShowShortCutToolbar:!0,
        //                  isShowStats:!1, isShowCoordinate:!0, ... }
        //
        //    ⇒ 只要往 localStorage["mlightcad.settings.cad-viewer"] 写
        //      { isShowStats:false, isShowCommandLine:false, isShowEntityInfo:false,
        //        isShowRibbon:false, isShowToolbar:false, isShowShortCutToolbar:false,
        //        isShowCoordinate:false } 再加载，查看器**自己就不渲染**这些 UI
        //      （功能区/工具栏/坐标是 v-if 直接移除，不是 CSS 藏）。
        //
        //    而 /lite 与 /cad/ **同源**，所以由 /lite 在 iframe 之前播种即可。
        //    这正是「用户要的：通过 CAD viewer 设置来设置」。
        //    连左下角 canvas 上的 UCS 坐标轴也一起消失了（isShowCoordinate），
        //    那是 CSS 永远做不到的。
        //
        //  ⇒ 现在 CAD 走 /lite（kind=cad）；后端 pages.py 的 lite_shell 负责播种。
        //     CSS 那一组选择器退居**兜底**（老版本没有这些设置键时仍能盖住）。
        return { url: wrap(r.url, "cad"), kind: "cad" };
      } catch (e) { /* 降级 */ }
    }
    const r = await plugin.api.previewUrl(spec.mount, spec.path);
    // ★ 任务③：kkFileView 的 PDF/Office 分支是内嵌 PDF.js，自带一整套
    //   工具栏（#toolbarContainer 等）。嵌入块里同样要收掉。
    return { url: wrap(r.url, "kk"), kind: "kk" };
  }

  /**
   * ★★★ 任务③ 的重要限制：Office 的菜单栏**不能在前端隐藏** ★★★
   *
   * 需求原文：「嵌入块中 office、CAD 预览 隐藏所有菜单栏。」
   *
   * 曾经的（错误）做法：前端拿到 cfg 后改写
   *   cfg.config.editorConfig.customization.toolbar = false 等。
   *
   * 为什么不行 —— 后端 `integrations.build_editor_config()` 末尾有：
   *
   *     if settings.oo_secret:
   *         cfg["token"] = _sign(cfg)
   *
   * 解出 JWT payload 实测（2026-09-22，pptx 实测）：
   *
   *     payload = { documentType, document, editorConfig }   ← 就是整份配置
   *
   * 即 **token 对整份 config 做 HS256 签名**，而 compose 里
   * `JWT_ENABLED=true` ⇒ OnlyOffice 会强校验。
   * 前端改任何一个字段 ⇒ 签名与内容不一致 ⇒ OO 拒绝配置，编辑器白屏。
   *
   * ⇒ 结论：Office 的「嵌入块精简版」必须做在**后端签名之前**。
   *   做法：`/api/oo/config` 增加 `embed` 表单参数（0/1），
   *   `build_editor_config(..., embed=True)` 在签名前把
   *   customization 换成精简版。插件这里只负责**传参**，
   *   一字不改后端下发的 config。
   *
   * 下面这个函数保留为「是否要请求精简版」的判定，方便集中改开关。
   * 名字保留 embed 语义，避免调用点再散落判断。
   */
  const WANT_LITE_OFFICE = true;

  /* ------------------------------------------------------------------
   * ★★★ 为什么这里**没有** blob 宿主页了（2026-09-22 重要修正）★★★
   *
   * 这段代码原来在这里：用 URL.createObjectURL(new Blob([html])) 造一个
   * 宿主页，宿主页里 <iframe src=http://192.168.193.70:8089/preview/…>，
   * 再由宿主页的脚本往子 iframe 里注入隐藏 CSS + 中键守卫。
   * 它看起来完全合理，**但真机实测证明根本不生效**：
   *
   *   用 CDP 在真思源页面上量到（见 tools 里的 probe-origin）：
   *     hostSrcHead      = blob:http://192.168.193.70:6806/7d77a594-…
   *     innerOrigin      = http://192.168.193.70:8089
   *     innerDocReadable = false        ← ★ contentDocument === null ★
   *
   * 根因：blob: URL 继承的是**创建者**（思源，:6806）的 origin，
   * 而预览页由 NebulaDisk 提供（:8089）—— 两者**不同源**。
   * 跨源 ⇒ 宿主页拿不到子 iframe 的 document：
   *   · 隐藏菜单栏的 CSS        → 注入不到（任务③ 一直没真正生效）
   *   · 内层 document 的中键守卫 → 绑不上（任务⑤ 同样没生效）
   *
   * 而且这个错误**伪装得很好**：宿主页本身能加载、#nb-lite-frame 也在、
   * 隐藏 CSS 也写进了宿主页自己的 <style> —— 看上去一切正常，
   * 只有「子文档是否真的被改到」这一条是假的。静态读代码永远看不出来，
   * 必须真的进浏览器量 contentDocument 才能发现。
   *
   * ── 现在的做法 ────────────────────────────────────────────────
   * 把外壳页搬到**预览服务自己**的 origin 上：
   *   NebulaDisk 新增 GET /lite?kind=kk|cad&target=<本站相对路径>
   * （见 nebuladisk 的 app/routers/pages.py，函数 lite_shell）
   * 外壳页与 target 都在 :8089 ⇒ 同源 ⇒ contentDocument 可读
   * ⇒ CSS 与守卫都真正生效（实测 readable/hasCss/hasGuard 全 true）。
   *
   * 插件这边只需要拼地址：API.liteUrl(base, target, kind)，见 src/api.js。
   * ------------------------------------------------------------------ */

  /**
   *
   * ★★★ 为什么不用 data: URL（这是踩过的坑）★★★
   *
   *   最初写成 `iframe.src = "data:text/html,..."`，看着能用，其实不行：
   *   **data: URL 的 iframe 拿到的是 opaque origin（不透明源）**，
   *   于是里面：
   *     · `<script src="http://.../api.js">` 跨域加载被 CORS 拦
   *     · DocsAPI 内部对 OO 服务器的 fetch / iframe 嵌套 / postMessage
   *       全部因为「null origin」被拒
   *   表现就是白屏或 "OnlyOffice: 未知错误"。
   *
   * ★ 改为 blob: URL ★
   *   blob URL 继承**创建它的页面的 origin**（在这里就是思源页面的 origin：
   *   http://192.168.193.70:6806）。有真实 origin 之后：
   *     · 可以正常跨域加载 OO 的 api.js（它是 script 标签，不需要 CORS 头）
   *     · DocsAPI 发起的请求带上正常 Origin，OO 服务端能正常响应
   *   blob 用完要 revoke，这里在 iframe 卸载时由调用方负责。
   *
   * 注：OO 官方本身就是把编辑器放在 iframe 里的，所以这条路是正解。
   *
   * @param {object} cfg  后端 /api/oo/config 的返回体（**原样使用，不改一个字段**）
   * @param {boolean} [lite] 嵌入块精简模式：额外注入一段 CSS 兜底收掉
   *        OO 自己可能仍然渲染出来的边角（比如初始化的加载页留白）。
   *        注意：**真正的菜单栏隐藏是后端 embed=1 做的**，
   *        这里只是视觉收尾，不碰 cfg。
   */
  function buildOoFrameUrl(cfg, lite) {
    const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#p{margin:0;padding:0;height:100%;width:100%;overflow:hidden}
${lite ? `
/* ★ 任务③ 视觉收尾：OO 加载页/边角在嵌入块里多余的部分 ★
   只处理「外壳」，不碰编辑器内部（内部由后端精简 config 控制）。
   另：编辑区上方的浅灰留白来自 iframe 默认边框与外层 padding，
   这里一并归零，让预览真正贴着嵌入块边框。 */
html, body { background: #fff !important; }
#p { position: absolute; inset: 0; }
#id_viewer, #viewport { padding: 0 !important; }
` : ""}
</style>
<script src="${cfg.apiJs}"><\/script></head>
<body><div id="p"></div><script>
  var cfg = ${JSON.stringify(cfg.config)};
  cfg.width = "100%"; cfg.height = "100%";
  cfg.events = { onError: function(e){ document.body.innerHTML =
      '<pre style="color:#c00;padding:12px;white-space:pre-wrap">OnlyOffice: ' +
      ((e&&e.data&&e.data.errorDescription)||'未知错误') + '</pre>'; } };
  function boot(){ try { new DocsAPI.DocEditor("p", cfg); }
    catch(err){ document.body.innerHTML = '<pre style="color:#c00;padding:12px">'
      + err + '</pre>'; } }
  if (window.DocsAPI) boot();
  else { var s = document.querySelector("script"); s.onload = boot;
         s.onerror = function(){ document.body.innerHTML =
           '<pre style="color:#c00;padding:12px">api.js 加载失败：${cfg.apiJs}</pre>'; }; }
<\/script></body></html>`;
    // blob: 继承思源页面的 origin（关键），data: 不行
    return URL.createObjectURL(new Blob([html], { type: "text/html" }));
  }

  /**
   * 渲染「未加载」时的占位：一行提示 + 一个「点击预览」按钮。
   */
  function renderPlaceholder(text) {
    state = "idle";
    frame = null;
    releaseBlob();          // ★ 卸载时回收 OO 的 blob URL
    releaseMyBlobs();       // ★ 一并回收图片自愈用掉的 blob
    // ★ 需求⑤：只要回到「未展开」状态，就从登记表里注销自己 ★
    //   放在这里而不是每个调用点，是为了保证「任何收起路径」都不会漏登记 —— 
    //   漏了会导致登记表里留着一个已经不在 DOM 里的死引用，
    //   下次展开别的块时去 collapse 它会抛错。
    unregisterOpenEmbed(wrap);
    frameBox.innerHTML = "";
    // ★ 任务①：回到未预览状态 ⇒ 隐藏工具栏里的「收起」★
    collapseBtn.style.display = "none";
    frameBox.classList.remove("is-loaded");

    const box = document.createElement("div");
    box.className = "nb-embed-placeholder";

    const btn = document.createElement("button");
    btn.className = "nb-embed-play";
    // 用 SVG 播放图标，避免 emoji 在各平台显示不一致
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z"></path>
      </svg><span></span>`;
    btn.querySelector("span").textContent = text || "点击预览";

    const hint = document.createElement("div");
    hint.className = "nb-embed-placeholder-hint";
    // ★ 需求⑤：用大白话把「什么时候加载」讲清楚 ★
    //   用户明确说过没看懂原来的说法（「没有明白你的意思」），
    //   所以这里直接说人话：什么时候不加载、点了才加载、同一时刻只展开一个。
    hint.textContent = "打开笔记时不加载；点这里才加载（可同时展开多个，各自点「收起」卸载）";

    btn.onclick = () => loadFrame();
    box.appendChild(btn);
    box.appendChild(hint);
    frameBox.appendChild(box);
  }

  /** 渲染错误 */
  function renderError(msg) {
    state = "idle";
    frame = null;
    releaseMyBlobs();
    frameBox.innerHTML = "";
    frameBox.classList.remove("is-loaded");
    // ★ 任务①：出错时没有可收起的内容 ⇒ 隐藏「收起」★
    collapseBtn.style.display = "none";
    const box = document.createElement("div");
    box.className = "nb-embed-error";
    box.textContent = msg;
    frameBox.appendChild(box);
  }

  /**
   * ★ 任务⑧：原生直出渲染器 ★
   *
   * 与页签的 renderImage/renderVideo/renderAudio/renderText 对应，
   * 但**不共用代码** —— 两者宿主环境不同：
   *   · 页签挂在自己的 element 上，工具条由 Viewer 管
   *   · 嵌入块挂在 frameBox 上，且要参与「收起/展开」的 state 管理
   * 强行抽公共函数会让两边都变复杂，这里保持各自独立、行为对齐即可。
   *
   * @param {"image"|"video"|"audio"|"pdf"|"text"} media
   * @param {string} url 带签名的直链
   */
  /**
   * ★ 图片挂载：直链优先，失败复诊 + 自愈 ★（2026-09-30）
   *
   * 背景（真机排查结论，完整推理见 src/media.js 顶部注释）：
   *   嵌入块里图片显示「图片加载失败（签名可能已过期，点「收起」后重新展开即可）」，
   *   但同一条直链在真机上被三种方式验证**全部成功**：
   *     curl 直取 / 页面里 new Image() / --disable-web-security 下再跑一遍
   *   ⇒ 链接和后端都没问题，失败只发生在 `img` 这一层；
   *     而旧代码一触发 onerror 就立刻清屏、把原因一律写成「签名过期」，
   *     既可能是误报，也把真正的失败原因盖掉了。
   *
   * 现在分三步：
   *   ① 元素已被移除（收起 / 块被重建导致的中断）⇒ 静默忽略，不报错
   *   ② fetch 复诊同一条直链 ⇒ 拿到字节就转 blob 挂回去（**自愈**）
   *   ③ 复诊也不行 ⇒ 再试认证兜底链路 `/api/download` + Bearer
   *      （它认 token、不认 URL 签名，与直链互为备份）
   *      两条都不行才报错，且写出**真实状态码 / 原因**
   */
  function attachImage(url) {
    const img = document.createElement("img");
    img.className = "nb-embed-image";
    img.alt = spec.name || spec.path || "图片";
    // ★ 不接 renderError：图片失败时应保留工具栏，
    //   让用户还能点「下载」或「在页签中打开」自救。
    img.onerror = () => {
      // 元素已脱离文档 ⇒ 这是收起/重建造成的加载中断，不是真失败
      if (!img.isConnected) return;
      void recoverImage(img, url);
    };
    img.src = url;
    frameBox.appendChild(img);
  }

  /**
   * 图片加载失败的复诊与自愈（见 attachImage 的说明）。
   *
   * @param {HTMLImageElement} img 触发 error 的那个元素
   * @param {string} url 它加载失败的地址（签名直链）
   */
  async function recoverImage(img, url) {
    diag(`[embed] 图片 onerror，开始复诊：${url}`);
    const probe = await probeImageUrl(url, "embed 图片");
    diag(`[embed] 图片复诊（签名直链）：${probe.detail}`);

    // ② 直链其实取得到 ⇒ 转 blob 挂回去
    if (probe.ok && probe.blob) {
      const next = mountBlobImage(img, probe.blob, "nb-embed-image", img.alt);
      rememberBlob(next.dataset.nbBlob);
      // 兜底元素的 onerror **绝不再复诊**，否则会无限递归
      next.onerror = () => diag("[embed] 图片自愈后仍失败（blob 无法解码）");
      diag(`[embed] 图片自愈成功（签名直链 → blob，${probe.bytes} 字节）`);
      return;
    }

    // ③ 认证兜底链路：/api/download 认 Bearer，不依赖 URL 签名
    let apiErr = "";
    try {
      const blob = await plugin.api.downloadBlob(spec.mount, spec.path, true);
      const next = mountBlobImage(img, blob, "nb-embed-image", img.alt);
      rememberBlob(next.dataset.nbBlob);
      next.onerror = () => diag("[embed] 图片自愈后仍失败（blob 无法解码）");
      diag(`[embed] 图片自愈成功（认证兜底 /api/download，${blob.size} 字节）`);
      return;
    } catch (e) {
      apiErr = (e && e.message) || String(e);
      diag(`[embed] 图片认证兜底也失败：${apiErr}`);
    }

    // ④ 两条链路都不通 ⇒ 给出可照着排查的提示（不再说「签名可能已过期」）
    const msg = imageFailMessage(
      { ...probe, detail: probe.detail + (apiErr ? `；认证链路：${apiErr}` : "") },
      { viaApi: true },
    );
    diag(`[embed] 图片加载最终失败：${msg}`);
    // 复诊期间用户可能已经点了「收起」⇒ 别再动 DOM
    if (!img.isConnected) return;
    frameBox.innerHTML = "";
    const box = document.createElement("div");
    box.className = "nb-embed-error";
    box.textContent = msg;
    frameBox.appendChild(box);
  }

  function renderNative(media, url) {
    frameBox.innerHTML = "";
    // 上一轮的图片 blob（若有）在这里回收，避免反复展开堆积内存
    releaseMyBlobs();

    if (media === "image") {
      attachImage(url);
      return;
    }

    if (media === "video") {
      const v = document.createElement("video");
      v.className = "nb-embed-video";
      v.controls = true;
      v.preload = "metadata";
      // /api/raw 支持 Range ⇒ 可拖进度
      v.src = url;
      frameBox.appendChild(v);
      return;
    }

    if (media === "audio") {
      const box = document.createElement("div");
      box.className = "nb-embed-audio-wrap";
      const a = document.createElement("audio");
      a.controls = true;
      a.src = url;
      box.appendChild(a);
      frameBox.appendChild(box);
      return;
    }

    if (media === "pdf") {
      // ★ 为什么用 <iframe> 直连 /api/raw 而不是 /preview/onlinePreview ★
      //   嵌入块只求「看到内容」：浏览器内置 PDF 查看器零依赖、零转换。
      //   比 kk 少两层外壳（/lite → onlinePreview → pdf.js），更轻。
      //   ★ 注意：content-type 必须让浏览器愿意**内联**渲染 PDF。
      //     后端 /api/raw 的 inline 参数已保证这一点（实测 200 + application/pdf）。
      const f = document.createElement("iframe");
      f.className = "nb-embed-frame nb-embed-frame--pdf";
      f.src = url;
      frameBox.appendChild(f);
      return;
    }

    // text：fetch 后塞进 <pre>（与页签 renderText 一致）
    //   直接 iframe 文本会被压成一行、且可能触发下载，体验很差。
    const pre = document.createElement("pre");
    pre.className = "nb-embed-text";
    pre.textContent = "加载中…";
    frameBox.appendChild(pre);

    fetch(url, { credentials: "omit" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        /*
         * ★ 直接调用 decodeSmart，不要再写 `decodeSmart ? decodeSmart(buf) : …` ★
         *
         * 曾经的写法带了 falsy 兜底，结果**漏 import 时不报错**，只在运行时静默
         * 降级成 utf-8 硬解 —— 用户看到的是
         *   「读取失败：decodeSmart is not defined」
         * （更糟的是单测因为走兜底分支而全绿，真机才发现）。
         * 去掉兜底：漏 import 就该立刻 ReferenceError，暴露得越早越好。
         */
        pre.textContent = decodeSmart(buf);
        // 控制显示量：嵌入块里超长文本会撑爆高度，截断并提示
        const MAX = 20000;
        if (pre.textContent.length > MAX) {
          const total = pre.textContent.length;
          pre.textContent = pre.textContent.slice(0, MAX) +
            `\n\n……（共 ${total} 字符，已截断；完整内容请点「在页签中打开」）`;
        }
      })
      .catch((e) => {
        pre.textContent = `读取失败：${e.message}（可试「在页签中打开」）`;
      });
  }

  /** 真正去拿预览地址并建 iframe */
  async function loadFrame() {
    if (state === "loading" || state === "loaded") return;
    state = "loading";

    // ★ 校验块参数 ★
    //   后端 /api/preview 的 mount/path 都是必填，缺一个就回 422
    if (!spec.mount || !spec.path) {
      renderError("此嵌入块缺少「网盘/路径」参数。请删除后重新从侧边栏拖入。");
      return;
    }

    // ★★★ 任务④：展开新块时**不再**自动收起别的块 ★★★
    //
    //   用户原话：「当前页面中，点击预览后，再点击其他预览，原来的就会收起。
    //             这个需要调整一下。」
    //
    //   历史行为（已删除）：
    //     每个展开的嵌入块 = 一个 iframe，OnlyOffice 实例动辄几十上百 MB。
    //     当时的顾虑是「一篇笔记嵌 8 个文件全展开会拖垮电脑」，
    //     于是做了一个节流：同一篇文档里同时只允许展开 1 个，
    //     新的展开时先把旧的收起。
    //
    //   为什么这个节流要拿掉：
    //     · 用户实际要在同一篇文档里**对照看多个文件**（文档 + 表格 + 图纸），
    //       强制收起第一个是纯粹的干扰；
    //     · 展开/收起是用户主动动作，程序不该替他决定；
    //     · 真想省资源，工具栏上那个「收起」按钮就是出口，用户自己点。
    //
    //   现在多个嵌入块可以同时展开、互不干扰（见 openEmbeds 集合）。
    //   仍然由 registerOpenEmbed() 登记，供「全部收起」/ 插件卸载时统一释放。

    frameBox.innerHTML = `<div class="nb-embed-loading">加载中…</div>`;

    let resolved;
    try {
      // ★ 走 NebulaDisk 的预览链路 ★
      //   Office → OnlyOffice（可编辑）；其它 → kkFileView / CAD。
      //   覆盖格式远多于思源内置查看器 —— 这正是需求①。
      resolved = await resolvePreviewUrl();
    } catch (e) {
      renderError(`无法预览：${e.message}`);
      return;
    }
    const url = resolved && resolved.url;
    if (!url) { renderError("预览地址为空"); return; }

    frameBox.innerHTML = "";
    frameBox.classList.add("is-loaded");

    // ★★★ 任务⑧：原生直出（图片/视频/音频/PDF/文本）★★★
    //   不走 iframe，直接建对应元素 —— 与页签的 renderImage/renderVideo/
    //   renderAudio/renderText 行为一致，只是容器换成嵌入块的 frameBox。
    if (resolved.kind === "native") {
      renderNative(resolved.media, resolved.url);
      state = "loaded";
      // ★ 任务①：内容已就绪 ⇒ 显示工具栏里的「收起」★
      collapseBtn.style.display = "";
      registerOpenEmbed(wrap, () => renderPlaceholder("点击预览"));
      return;
    }

    frame = document.createElement("iframe");
    frame.className = "nb-embed-frame";
    // ★ 懒加载：iframe 本身就是用户点击后才建的，这里再叠一层 native lazy ★
    frame.loading = "lazy";
    frame.src = url;
    frame.setAttribute("allowfullscreen", "true");
    // ★ 任务③：轻量化 —— iframe 只保留必要的权限，不做全屏以外的放行 ★
    frame.setAttribute("allow", "fullscreen");
    frame.onload = () => { state = "loaded"; };
    frameBox.appendChild(frame);
    state = "loaded";
    // ★ 任务①：预览已就绪 ⇒ 显示工具栏里的「收起」★
    collapseBtn.style.display = "";

    // 登记：告诉登记表「我在展开」
    //   ★ 任务④：登记表**不再**用于自动收起别的块（用户明确要求取消），
    //     只保留「统一收起 / 插件卸载时统一释放」的用途。
    registerOpenEmbed(wrap, () => {
      // 统一收起时，同样要真正卸载
      renderPlaceholder("点击预览");
    });
  }

  // ★ 需求②：默认不加载，只显示「点击预览」
  //   旧块没补 path 的先补上（只影响按钮文案，不发请求）
  if (!spec.path && spec.name) spec.path = spec.name.startsWith("/") ? spec.name : "/" + spec.name;
  renderPlaceholder("点击预览");

  return wrap;
}

/* -------------------------------------------------------------------------
 * 注册入口
 *
 * ★★★ 关键：customBlockRenders 的键是「块类型」，不是插件名 ★★★
 *
 *   思源 main.js 里的真实逻辑（v3.8.4，已逐字核实）：
 *
 *     const h = info => {                       // 解析 data-info
 *       const i = info.indexOf("/");
 *       if (i < 1 || i !== info.lastIndexOf("/") || i === info.length - 1) return;
 *       const pluginName = decodeURIComponent(info.slice(0, i));
 *       const blockType  = decodeURIComponent(info.slice(i + 1));
 *       if (pluginName && blockType) return { pluginName, blockType };
 *     };
 *     const parsed = h(element.getAttribute("data-info") || "");
 *     const owner  = parsed && plugins.find(p => p.name === parsed.pluginName);
 *     const render = parsed ? owner?.customBlockRenders[parsed.blockType]?.render : undefined;
 *
 *   而 data-info 是内核从块内容推导出来的，推导规则（同 v3.8.4 前端）：
 *
 *     const l = (pluginName, blockType) =>
 *       `${encodeURIComponent(pluginName)}/${encodeURIComponent(blockType)}`;
 *
 *   ⇒ 所以块内容必须写成：
 *
 *       ;;;<插件名>/<块类型>
 *       {...}
 *       ;;;
 *
 *     其中 **插件名/块类型 恰好一个斜杠**。
 *
 *     ;;;nebuladisk                      ← h() 返回 undefined ⇒ 不渲染，裸 JSON
 *     ;;;plugin/siyuan-nebuladisk/demo    ← 两个斜杠 ⇒ h() 同样拒绝
 *     ;;;siyuan-nebuladisk/nebuladisk     ← 正确 ✓
 *
 *   注意：前端另有一个 `plugin/<name>/<type>` 三段式 helper（gV），
 *   但那只用于 command 快捷键 id（`(0,gV)(plugin.name, cmd.langKey)`），
 *   **与自定义块无关**，别被它误导。
 *
 *   为了同时兼容历史笔记，这里把同一个渲染器注册到两个块类型键上：
 *     · "nebuladisk"        ← 主键（;;;siyuan-nebuladisk/nebuladisk）
 *     · "siyuan-nebuladisk" ← 兼容极端历史写法
 * ---------------------------------------------------------------------- */

/** 自定义块的「块类型」标识（data-info 斜杠后面的部分） */
export const BLOCK_TYPE = "nebuladisk";


/** 历史遗留的备选块类型键（旧笔记里可能出现的写法） */
const LEGACY_BLOCK_TYPES = ["nebuladisk"];

/**
 * 生成写入笔记用的完整 data-info 串：`<插件名>/<块类型>`
 * @param {string} pluginName
 * @returns {string}
 */
export function embedLang(pluginName) {
  return `${pluginName || "siyuan-nebuladisk"}/${BLOCK_TYPE}`;
}

/**
 * 生成要插入笔记正文的**自定义块 markdown**（三引号分号围栏）。
 *
 * ★ 必须用 `;;;` 围栏，不能用反引号 ```` ``` ```` ★
 *   反引号只会生成普通代码块（type=c），自定义块渲染器不会被调用。
 *
 * @param {string} pluginName 插件名（data-info 的前半段）
 * @param {object} spec       嵌入参数（kind/mount/path/name/height）
 * @returns {string}
 */
export function buildEmbedMarkdown(pluginName, spec) {
  const md = `;;;${embedLang(pluginName)}\n${stringifyEmbed(spec)}\n;;;\n`;
  // ★ 自检：围栏必须顶格 ★
  //   实测（v3.8.4）围栏前多任何一个字符都会退化成 type=p 普通段落，
  //   笔记里就显示成一坨裸 JSON。这里断言一下，任何改动把它弄歪都会立刻暴露。
  if (!md.startsWith(";;;")) {
    throw new Error(`嵌入块 markdown 非法（围栏未顶格）：${JSON.stringify(md.slice(0, 40))}`);
  }
  return md;
}

/* -------------------------------------------------------------------------
 * ★★★ 嵌入块的「唯一插入通道」：内核 API ★★★
 *
 * ★ 为什么三处插入点都要走这里，而不能各写各的 ★
 *
 *   2026-09-22 在 NAS 实测发现：**前端 `protyle.insert(md)` 会把 `;;;`
 *   围栏存成普通段落（type=p）**，内核永远不会把它编译成 NodeCustomBlock。
 *   症状就是「笔记里显示一坨裸 JSON」，而且**桌面端偶发正常、浏览器端必然坏**
 *   —— 这正是「本地思源能看、NAS 网页端不行」的根因。
 *
 *   ⇒ 插入自定义块**一律**走 `/api/block/insertBlock {dataType:"markdown"}`，
 *     由内核用 lute 完整解析。
 *
 * ★ 为什么抽成一个函数 ★
 *   历史上插入点散落在三处（斜杠菜单、侧边栏、预览页），每处各写一遍，
 *   结果修了两处漏了一处 —— 用户点的是漏的那一处，白修。
 *   ⇒ 统一收敛到这里，**新增插入点必须调它**，不要再手写 protyle.insert。
 *
 * ★★★ 需求5（2026-09-26）：插入位置 = 「光标所在块的上面」★★★
 *
 *   用户原话：「网盘拖拽插入嵌入块 和 / 插入 目前都在目前光标下一个位置，
 *             调整为当前位置插入。」
 *   追问后选定：「插在光标所在块的上面（推荐）」。
 *
 *   落位实现见 locateInsertPoint 的返回：`nextID = 光标块`（内核语义 =
 *   插到该块**之前**）。拖拽插入与 `/` 斜杠插入**共用这一条通道**，
 *   所以两处一次性同时生效 —— 这正是"抽成一个函数"的价值。
 *
 * @param {object} plugin  插件实例（用来取名字、日志）
 * @param {any} protyle    当前编辑器（可为 null，会用 DOM 兜底找光标）
 * @param {object} spec    嵌入参数
 * @returns {Promise<boolean>} 是否插入成功
 * ---------------------------------------------------------------------- */

/** 容器块类型：不能直接当 parentID 用，要往上挪一层 */
const BOXED_TYPES = ["i", "l", "b", "s", "callout", "blockquote", "sb", "h", "t"];

/** 从嵌入块 markdown 里抠出 JSON 正文（重建时用） */
export function extractJson(md) {
  const lines = String(md || "").split(/\r?\n/);
  const body = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === ";;;") break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/** 内核 API 的薄封装（与 index.js 里风格一致，不引依赖） */
async function kb(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

async function locateInsertPoint(protyle, anchorEl) {
  const dbg = [];
  let blockId = "";   // 光标所在的块（想插到它后面）
  let docId = "";     // 目标文档 id（插到文档末尾的兜底）
  let src = "";       // 命中的来源，用于诊断

  // ── 环境探针：失败时这几行就能说明问题 ──────────────────────────────
  try {
    if (typeof document !== "undefined") {
      const pf = document.querySelector(".protyle");
      dbg.push("protyle=" + document.querySelectorAll(".protyle").length +
               " wysiwyg=" + document.querySelectorAll(".protyle-wysiwyg").length +
               " focusWys=" + document.querySelectorAll(".protyle-wysiwyg--focus").length +
               " selectWys=" + document.querySelectorAll(".protyle-wysiwyg--select").length);
      dbg.push("protyle.dataset.nodeId=" + ((pf && pf.dataset && pf.dataset.nodeId) || "(空)"));
    }
  } catch (e) { dbg.push("环境探针异常: " + (e && e.message)); }

  // ── 策略 0：★ 调用方直接给的「光标所在块元素」★ ─────────────────────
  //
  //   ★★★ 2026-09-22 从思源 main.js 里读出的**真实契约**（这是根治性发现）★★★
  //
  //   思源斜杠菜单的 plugin 分支（main.js，fill() 方法内）长这样：
  //
  //     cn.callback(D.getInstance(), ht), !0   // ← 只把 (protyle, 块元素) 交给插件
  //     return;                                // ← 然后就 return 了！
  //
  //   对照同一函数里**其它所有分支**（ZWSP/1/2/3、样式、普通插入…）：
  //     它们第一件事都是 `He.deleteContents()`，把用户敲的 `/` 和过滤词删掉，
  //     再插入真正的块。**唯独 plugin 分支没有这一步** ——
  //     思源把「清掉 /xxx」和「决定插到哪儿」这两件事**留给了插件自己做**。
  //
  //   ⇒ 所以历史实现有两个必然的 bug（同一个根因）：
  //     ① 位置错：把第 2 个参数 ht（**块元素**，带 data-node-id）当成 protyle
  //        传给 pickAndEmbed → locateInsertPoint 全部策略读不到 protyle.block
  //        → 退化成「插到文档末尾」。
  //     ② 残留 `/`：没人执行 He.deleteContents()，用户敲的 `/网盘` 就留在原地。
  //
  //   ht 的实证特征（从 main.js 用量反推）：
  //     ht.getAttribute("data-type")==="NodeParagraph"、
  //     ht.insertAdjacentHTML(...)、ht.nextElementSibling、ht.querySelector(...)
  //   ⇒ 它是带 data-node-id 的块元素。这里直接取 id 当光标块，最准。
  if (!blockId && anchorEl) {
    try {
      let el = anchorEl;
      // 容错：万一传进来的是 text node 或更深的节点，往上找到带 node-id 的块
      if (el && el.nodeType === 3) el = el.parentElement;
      if (el && el.nodeType === 1) {
        // anchorEl 本身可能就是个块；找不到就往上找
        const holder = el.getAttribute && el.getAttribute("data-node-id")
          ? el
          : (el.closest ? el.closest("[data-node-id]") : null);
        if (holder) {
          blockId = holder.getAttribute("data-node-id") || "";
          src = "anchorEl(closest[data-node-id])";
          dbg.push(src + "=" + (blockId || "(空)"));
        } else {
          dbg.push("anchorEl 上没有 data-node-id，也找不到祖先");
        }
      } else {
        dbg.push("anchorEl 类型=" + (anchorEl ? anchorEl.nodeName || typeof anchorEl : "空"));
      }
    } catch (e) { dbg.push("读 anchorEl 异常: " + (e && e.message)); }
  } else if (!anchorEl) {
    dbg.push("调用方未提供 anchorEl（非斜杠场景属正常）");
  }

  // ── 策略 1：调用方给的 protyle ─────────────────────────────────────
  //   注意：思源可能传入一个「复用过」的实例，所以只取 block 上的真值。
  //
  //   ★★★ 这里有个致命的细节（就是「插到末尾」的元凶）★★★
  //     protyle.block 在**文档级**编辑器上形如
  //       { id: "<文档id>", rootID: "<同一个文档id>", parentID: "<文档id>" }
  //     即 id === rootID —— 它描述的是「整篇文档」，**不是光标所在的那一段**。
  //     历史上这里无条件 `blockId = b.id`，于是：
  //       blockId = 文档 id → 后面 SQL 查到它的 type 是 "d"（文档块）
  //       → BOXED_TYPES 命中 → parentID 上移、previousID 清空
  //       → insertBlock 时没有任何 previousID ⇒ **追加到文档结尾**。
  //     用户看到的就是「我明明把光标放在第三段，块却跑到文末」。
  //
  //   ⇒ 只有当 block.id **不等于**文档 id 时，它才代表「光标所在的具体块」，
  //     那时才允许拿来当 previousID（插到它后面）。
  //     文档 id 只用来填 docId（插到文末的兜底）。
  try {
    if (protyle && protyle.block) {
      const b = protyle.block;
      const root = b.rootID || b.id || "";
      if (root) {
        docId = root;
        dbg.push("protyle.block: id=" + (b.id || "") + " rootID=" + (b.rootID || ""));
        if (b.id && b.id !== root) {
          // 光标在某个具体子块上 → 精确锚点
          blockId = b.id;
          src = "protyle.block(子块)";
        } else {
          dbg.push("protyle.block.id 就是文档 id ⇒ 不当锚点（避免插到文末）");
          if (!src) src = "protyle.block(仅文档级)";
        }
      }
    } else {
      dbg.push("调用方 protyle=" + (protyle ? "有但无 block" : "空"));
    }
  } catch (e) { dbg.push("读 protyle.block 异常: " + (e && e.message)); }

  // ── 策略 2：★ 纯 DOM：.protyle 的 dataset.nodeId ★ ─────────────────
  //
  //   ★ 2026-09-22 在真实环境实测确定的路径（前面几版全错在这里）：
  //     document.querySelector(".protyle").dataset = {
  //        nodeId: "20260415075745-bzytq2y",   ← 文档块 id，直接可用
  //        notebookId: "20240604102224-1z8hvmo",
  //        id: "7756f110-…"                    ← 这是 DOM 实例 uuid，不是块 id
  //     }
  //   全部都是**标准 data-* 属性**，不依赖任何思源内部对象 —— 最稳。
  //
  //   反面教材（这些都试过，全部拿不到）：
  //     · .protyle._protyle            → 属性不存在
  //     · .protyle-wysiwyg--focus      → 焦点在别的页签时不存在
  //     · .protyle-wysiwyg--select     → 没有选中块时不存在
  //     · 页签的 data-initdata          → 空对象 {}
  if (!docId && typeof document !== "undefined") {
    try {
      // 优先取「有 nodeId 的」.protyle（页面上可能有多个编辑器）
      const all = Array.from(document.querySelectorAll(".protyle"));
      for (const el of all) {
        const nid = el.dataset && el.dataset.nodeId;
        if (nid) {
          docId = nid;
          src = "DOM:.protyle[data-node-id]";
          dbg.push(src + "=" + nid);
          break;
        }
      }
      if (!docId) dbg.push("DOM 里没有带 data-node-id 的 .protyle");
    } catch (e) { dbg.push("读 .protyle dataset 异常: " + (e && e.message)); }
  }

  // ── 策略 3：★ siyuan.backStack —— 思源的「最近文档栈」★★ ───────────
  //
  //   ★ 实测结构（真实环境 dump 出来的）：
  //     window.siyuan.backStack = [ { position, id, zoomId, protyle: { block, … } } ]
  //   栈顶 [0] 就是**用户最后看的那个文档** —— 这正是「焦点被插件页签抢走」
  //   场景下最靠谱的线索：用户是从文档切到预览页的，那个文档就在栈顶。
  //
  //   实测值：backStack[0].protyle.block = {
  //     parentID: "20260415075745-bzytq2y",
  //     rootID:   "20260415075745-bzytq2y",
  //     id:       "20260415075745-bzytq2y", … }
  if (!docId && typeof window !== "undefined") {
    try {
      const bs = window.siyuan && window.siyuan.backStack;
      if (Array.isArray(bs) && bs.length) {
        for (let i = 0; i < bs.length; i++) {
          const pr = bs[i] && bs[i].protyle;
          const b = pr && pr.block;
          if (b && (b.rootID || b.id)) {
            docId = b.rootID || b.id;
            // 只有当 block.id 就是文档 id 时才当成光标块；否则别乱插
            if (b.id && b.id === docId) blockId = "";
            src = "siyuan.backStack[" + i + "]";
            dbg.push(src + ": rootID=" + (b.rootID || "") + " id=" + (b.id || ""));
            break;
          }
        }
      } else {
        dbg.push("siyuan.backStack=" + (bs === undefined ? "无" : (Array.isArray(bs) ? "空数组" : typeof bs)));
      }
    } catch (e) { dbg.push("读 backStack 异常: " + (e && e.message)); }
  }

  // ── 策略 4：layout.centerLayout 里逐层找编辑器 ──────────────────────
  //   实测：siyuan.layout 的键是 layout / centerLayout / leftDock / rightDock /
  //   bottomDock（**没有 children**）。centerLayout.children 长度 1，可继续下钻。
  //   这条路比前两条绕，只在前两条都失败时用。
  if (!docId && typeof window !== "undefined") {
    try {
      const layout = window.siyuan && window.siyuan.layout;
      const roots = [];
      if (layout) {
        if (layout.centerLayout) roots.push(layout.centerLayout);
        if (layout.layout) roots.push(layout.layout);
      }
      dbg.push("layout roots=" + roots.length);
      const seen = new Set();
      const stack = roots.map((n) => [n, "root"]);
      let scanned = 0;
      while (stack.length && scanned < 400) {
        const [n, path] = stack.shift();
        if (!n || typeof n !== "object" || seen.has(n)) continue;
        seen.add(n);
        scanned++;
        // 目标的几种可能挂法
        const ed = n.model && n.model.editor;
        if (ed && ed.protyle && ed.protyle.block &&
            (ed.protyle.block.rootID || ed.protyle.block.id)) {
          docId = ed.protyle.block.rootID || ed.protyle.block.id;
          src = "layout:" + path;
          dbg.push(src + "=" + docId);
          break;
        }
        if (Array.isArray(n.children)) {
          for (const c of n.children) stack.push([c, path + ">"]);
        }
      }
      if (!docId) dbg.push("layout 下钻 " + scanned + " 个节点，未找到编辑器");
    } catch (e) { dbg.push("layout 下钻异常: " + (e && e.message)); }
  }

  // ── 策略 5：DOM 里被选中的块（能拿到就更精确：插到它后面）───────────
  if (!blockId && typeof document !== "undefined") {
    try {
      const sel = document.querySelector(".protyle-wysiwyg--select");
      if (sel) {
        blockId = sel.getAttribute("data-node-id") || "";
        dbg.push("--select: blockId=" + (blockId || "(无)"));
      } else {
        dbg.push("DOM 里没有 .protyle-wysiwyg--select");
      }
    } catch (e) { dbg.push("读 --select 异常: " + (e && e.message)); }
  }

  // ── 策略 6：★ 深层回退 —— 从「当前光标/选区」反查所在块 ★───────────
  //
  //   ★ 为什么需要这一级 ★
  //     侧边栏 / 预览页这两个入口**没有** anchorEl（它们不是斜杠菜单触发的），
  //     用户此时的意图同样是「插到我光标所在的地方」。思源把光标放在哪个块里，
  //     浏览器里是有痕迹的：
  //       · 有选区时：selection.anchorNode 落在某个 [data-node-id] 块内
  //       · 没选区、但编辑器聚焦时：editor 上会带 .protyle-wysiwyg--focus，
  //         配合 document.activeElement 能定位到底哪个 .protyle 是活的
  //
  //   ⚠️ 这一级**只**在真的拿到 selection 时才用，不猜、不乱插。
  if (!blockId && typeof document !== "undefined" && typeof window !== "undefined") {
    try {
      const s = window.getSelection && window.getSelection();
      const node = s && s.anchorNode;
      if (node) {
        let el = node.nodeType === 3 ? node.parentElement : node;
        const holder = el && el.closest ? el.closest(".protyle-wysiwyg [data-node-id]") : null;
        if (holder && holder.getAttribute) {
          blockId = holder.getAttribute("data-node-id") || "";
          if (blockId) {
            src = "selection(closest[data-node-id])";
            dbg.push(src + "=" + blockId);
          }
        } else {
          dbg.push("selection 不在任何 [data-node-id] 块内");
        }
      } else {
        dbg.push("selection.anchorNode 为空");
      }
    } catch (e) { dbg.push("读 selection 异常: " + (e && e.message)); }
  }

  // ── 落到「父块 + 位置」────────────────────────────────────────────
  let parentID = docId;
  // ★★★ 需求5（2026-09-26）：锚点语义从 previousID 改为 nextID ★★★
  //
  //   用户原话：「网盘拖拽插入嵌入块 和 / 插入 目前都在目前光标下一个位置，
  //             调整为当前位置插入。」
  //   （追问后用户选定：「插在光标所在块的上面」）
  //
  //   内核语义（两条都**实测过**，不是推断）：
  //     · `/api/block/insertBlock {parentID, previousID}` ⇒ 插到 previousID **之后**
  //     · `/api/block/insertBlock {parentID, nextID}`     ⇒ 插到 nextID **之前**
  //   实测：AAA|BBB|CCC 以 previousID=BBB 插 XXX ⇒ AAA|BBB|XXX|CCC
  //         以 nextID=CCC 插 BEFORE_CCC     ⇒ …|XXX|BEFORE_CCC|CCC
  //
  //   ⇒ 「插在光标所在块的上面」= 插到**光标块之前** = `nextID = 光标块`。
  //     旧实现给的是 previousID = 光标块 ⇒ 落到光标块下面，正是用户抱怨的
  //     「下一个位置」。
  //
  //   ★ 命名沿用历史（anchorBlockId），因为它是「光标所在的锚点块」，
  //     而不再暗示"插到它后面"。下面的分支只决定它进 nextID 还是被丢弃。
  let anchorBlockId = "";
  let nextID = "";

  // ★ 从锚点元素本身把文档 id 也捞出来 ★
  //   拖拽场景常见：用户在文档 A 里把文件拖到某个块上，
  //   此时 selection 可能已经丢了、protyle 也可能是复用实例，
  //   但**落点块元素还在我们手里**。顺着它往上找 .protyle[data-node-id]
  //   就能确定「这是哪个文档」，兜底也才有个像样的 parentID。
  if (!parentID && anchorEl) {
    try {
      const holder = anchorEl.nodeType === 1
        ? (anchorEl.closest ? anchorEl.closest(".protyle") : null)
        : null;
      const nid = holder && holder.dataset && holder.dataset.nodeId;
      if (nid) {
        parentID = nid;
        src = src || "anchorEl→.protyle[data-node-id]";
        dbg.push("锚点反查文档 id=" + nid);
      }
    } catch { /* 忽略 */ }
  }

  if (blockId) {
    let row = null;
    try {
      const info = await kb("/api/query/sql", {
        stmt: "SELECT parent_id, type, root_id FROM blocks WHERE id='" + blockId + "'",
      });
      row = info && info.data && info.data[0];
    } catch { /* 忽略 */ }
    if (row) {
      if (!parentID) parentID = row.root_id;
      if (BOXED_TYPES.indexOf(row.type) >= 0) {
        // ★ 容器块特殊处理（需求5 起语义变化，务必读清）★
        //
        //   「容器块」（列表项 l / 引用块 b / 超级块 s / 引述 i / 标题 h /
        //     表格 t / 标注 callout …）**不能直接当兄弟锚点**：
        //     它的子块挂在它内部，把 nextID=容器块 插进去会变成
        //     「插到容器内部的第一个子块之前」，那会破坏容器结构、
        //     甚至在列表里造出层级错乱。
        //
        //   ⇒ 仍然只上移到**容器的父层**，且**不带任何兄弟锚点**
        //     ⇒ 落点是「容器块之前的那个位置」的表末（即追加到父层末尾）。
        //
        //   ⚠️ 这与需求5「插到光标块上面」**不完全一致** —— 是刻意的降级：
        //     精确到"容器上面"需要「容器的前一个兄弟」当 nextID，
        //     但容器若是父层的第一个兄弟，就不存在前一个兄弟
        //     （与 makeEmbedDraggable 里 previousID 的边界问题同源）。
        //     与其塞一段在边界上会更错的补偿，不如收敛到永远成立的形态。
        //     待真机验证后，如果用户要更精确，再补「前兄弟的 nextID / 父层头插」。
        parentID = row.parent_id || parentID;
        nextID = "";
        anchorBlockId = "";
        dbg.push("blockId 是容器块(" + row.type + ")，上移到 parent=" + parentID + "（不带锚点）");
      } else {
        // ★ 需求5 核心：普通块 ⇒ 用 nextID，插到它**之前** ★
        nextID = blockId;
        anchorBlockId = blockId;
        dbg.push("普通块(" + row.type + ") ⇒ nextID=" + blockId + "（插到它之前）");
      }
    } else {
      // 查不到这个块（可能刚被删/索引未到）：退化为插到文档末尾
      dbg.push("blockId=" + blockId + " 查不到，退化为文档级插入");
      nextID = "";
      anchorBlockId = "";
      if (!parentID) parentID = docId;
    }
  }

  const trace = dbg.join(" | ") +
    " ⇒ parentID=" + (parentID || "(空)") +
    " nextID=" + (nextID || "(空)") +
    " via=" + (src || "(无)");
  lastLocateTrace = trace;
  try {
    if (typeof console !== "undefined") {
      console.log("[nebuladisk] [locate] " + trace);
    }
  } catch { /* 忽略 */ }

  // ★ 返回值同时给出 nextID 与 previousID（恒空）★
  //   previousID 保留在返回结构里是为了**兼容既有调用方/测试**：
  //   需求5 之后它永远是空串，任何还读它的代码都会走"没有兄弟锚点"的分支
  //   （= 追加到 parentID 末尾），而不是静默插错位置。
  return { parentID, nextID, previousID: "", anchorBlockId, src };
}

/**
 * ★★★ 清掉斜杠菜单留在块里的 `/ 和过滤词` ★★★
 *
 * 背景（从思源 main.js 读出的契约，2026-09-22）：
 *   思源斜杠菜单的 **plugin 分支是唯一一个不调用 `He.deleteContents()` 的分支**：
 *
 *     }else if(n.startsWith("plugin") && Em(D)){
 *         D.app.plugins.find(... cn.callback(D.getInstance(), ht) ...);
 *         return;                       // ← 直接就返回了，没有删除 /xxx
 *     }else{
 *         He.deleteContents(),          // ← 其它所有分支都先删掉用户敲的字符
 *         ...
 *     }
 *
 *   ⇒ 「把 `/网盘` 这种触发文本清掉」是插件自己的责任。
 *     不清的后果就是用户看到的：插进来的块旁边**残留一个 `/及后面的字`**。
 *
 * 清理策略（由稳到激进，只在确实发现了斜杠残留时才动手）：
 *   ① 块内文本以 `/` 或 `、` 开头，且**去掉它之后就只剩空白** ⇒ **整块删掉**。
 *      这是最常见的情形：用户就是「空段落里敲 /」来唤起菜单的，那个块本身
 *      没有正文价值（嵌入块是插在它下面的）。详见 §3 的说明。
 *   ② 块内文本形如 `<前文>/<过滤词>` ⇒ 只删掉 `/` 及其后面的过滤词，保留前文。
 *   ③ 拿不准就**什么都不做** —— 宁可留个 `/`，也不能误删用户的正文。
 *
 * ★★★ 必须走内核，不能只擦 DOM（任务⑩ 的真正病根，2026-09-23 实测确认）★★★
 *
 *   旧实现是「Range 删 DOM + 往 protyle 派发一个 input 事件」，看着很合理，
 *   实际上**一个字都存不进去**。真机复现（NAS，headed 浏览器，逐条读回）：
 *
 *     内核 kramdown 初始： "前文/nb10probe"
 *     Range 清理 DOM 后：  inner div = "前文"        ← 看起来成功了
 *     等 2 秒后读内核：    "前文/nb10probe"          ← ★ 内核纹丝不动 ★
 *
 *   ⇒ 现象就是用户报的：「`/` 及后面的文字插入后不显示了，刷新一下又出来了」
 *     —— DOM 被改了（所以"不显示"），内核没改（所以一刷新又回来）。
 *     旧代码里那个 `dispatchEvent(input)` 打的是 `protyle.wysiwyg.element`，
 *     也就是**整个可编辑区的根**，思源的事务系统根本不认这次"编辑"。
 *
 *   更关键的是：`anchorEl` 是**外层 `.p`**，它的 textContent 里有
 *   `protyle-attr` 那个零宽空格（实测 `"前文/nb10probe\u200b"`），
 *   情形①的 `/^\s*[/、][^\s]*\s*$/` 对它**永远不成立**（`\u200b` 不是 `\s`），
 *   整个块只有 `/xxx` 时连分支都进不去。
 *
 *   ⇒ 所以现在改成：**先用内核 API 把块的内容改成目标文本，再让思源自己回写 DOM**。
 *     实测 `POST /api/block/updateBlock {dataType:"markdown"}` 一次就生效：
 *       updateBlock("前文") ⇒ 内核 "前文" + DOM inner "前文" ⇒ 刷新后不再复现。
 *
 *   几个必须做对的小细节：
 *     1. **取内层编辑区**（`[contenteditable="true"]`）来判读，避开零宽空格。
 *     2. **整块删除**（情形①）走 `deleteBlock`。
 *
 *        ★ 这里改过一次，值得记下思路的转变 ★
 *          早先写的是 `next = "<wbr>"`（把内容换成思源的空行占位），
 *          理由是「空串会让思源删掉整个段落块」，想"保护"用户的段落。
 *          但那个保护放错了对象：情形① 的块**就是用户敲 / 敲出来的临时块**，
 *          它没有任何正文，用户要的正是它消失。用 `<wbr>` 的结果是
 *          插入完嵌入块后，上面还挂着一个空行，用户得自己手动删 ——
 *          这正是 2026-09-23 反馈的「/文字 变成了 <wbr>」。
 *          ⇒ 现在直接 `deleteBlock`，删不掉才退化为清空。
 *        （情形② 不动块结构，因为它里面**有**用户的前文。）
 *     3. **只在该块真的还有斜杠残留时才写**，否则会平白多一次内核写、
 *        把用户光标位置弄乱。
 *
 *   顺带修掉的一个老毛病：**不再把过滤词长度当"是不是菜单触发"的判据**。
 *   旧代码有个 `m[2].length > 16 ⇒ 跳过` 的保险丝，看着保守，其实会误伤：
 *   用户搜「`/管理知识/责任`」这种较长的关键词时，残留反而清不掉。
 *   真正该防的误删（路径、URL）靠的是正则本身 —— m[1] 不允许出现 `/`，
 *   于是锚点必然是"块内最后一个斜杠"，`/usr/local/bin` 这类整段天然保留。
 *
 * @param {Element|null} anchorEl 斜杠菜单交给插件的「光标所在块元素」
 * @returns {Promise<boolean>} true=确实改写了内核
 */
async function cleanupSlashText(anchorEl) {
  if (!anchorEl || anchorEl.nodeType !== 1) return false;
  try {
    const el = anchorEl;

    // ── 1. 拿块 id：没有 id 就不是真块，宁可不动 ──────────────────────
    const blockId = el.getAttribute("data-node-id") || "";
    if (!blockId) {
      console.log("[nebuladisk] [slash-cleanup] anchorEl 无 data-node-id，保守跳过");
      return false;
    }

    // ── 2. 读「内层编辑区」的文本，避开 protyle-attr 的零宽空格 ────────
    //     实测外层 .p 的 textContent = 正文 + "\u200b"，
    //     直接拿去匹配 `/^[\/、]/` 会永远失败。
    const editEl = el.querySelector('[contenteditable="true"]') || el;
    const raw = editEl.textContent || "";
    if (!raw) return false;
    if (raw.indexOf("/") < 0 && raw.indexOf("、") < 0) return false;

    // ── 3. 判定目标文本（拿不准就返回 null ⇒ 一个字都不改）────────────
    let next = null;
    let deleteBlock = false;

    // 情形 ①：全块只有 /xxx（可含空白）
    //
    //   ★ 应该是「整块删掉」，而不是留一个空段 ★（2026-09-23 按用户反馈改）
    //
    //   这个块本身就是用户**为了唤起斜杠菜单**而敲出来的：他只打了 `/关键词`，
    //   然后在菜单里选了「嵌入到文档」。此时这个块没有任何正文价值 ——
    //   嵌入块是插在它**下面**的（插在光标所在块之后）。
    //   早先我们用 `"<wbr>"` 去改写，理由是「空串会让思源删掉整个段落块」；
    //   但那个"保护"其实搞错了方向：这里**就是要它消失**。
    //   用户看到的是：插入完嵌入块，上面还挂着一个空行（<wbr> 只是个零宽占位），
    //   还得自己手动删掉 —— 这正是本轮反馈的「/文字 变成了 <wbr>」。
    //
    //   所以这里改成显式删除该块（deleteBlock），删不掉再退化为清空。
    //
    //   例外：整块是「路径形状」时不动 —— `/usr/local/bin` 斜杠多于一个，
    //   几乎一定是用户正文/路径（斜杠菜单的过滤词里不会再有斜杠）。
    if (/^\s*[/、]\S*\s*$/.test(raw)) {
      const slashCount = (raw.match(/\//g) || []).length;
      if (slashCount > 1) {
        console.log("[nebuladisk] [slash-cleanup] 整块是路径形状（斜杠 " +
                    slashCount + " 个），判定为正文，保守跳过");
        return false;
      }
      deleteBlock = true;
      next = "";                   // 删除失败时的兜底：清成空串
    } else {
      // 情形 ②：形如 `前文/过滤词` ⇒ 只删 `/` 及其后内容
      //
      // ⚠️ 这里必须严格，否则会**吃掉用户正文**。踩过的坑：
      //    最初写 `/^([\s\S]*?)\s*[/、]([^\s/、]*)\s*$/`，再用
      //    `m[2].indexOf("/") < 0` 兜底。看似严谨，实则**被回溯绕过**：
      //      `路径 /usr/local/bin`
      //        → 先试 m[1]="路径 " / m[2]="usr/local/bin"（含 / ⇒ 守卫拦下）
      //        → 正则引擎回溯，改试 m[1]="路径 /usr" / m[2]="local"
      //          —— 第二个斜杠被吃进了 m[1]，m[2] 反而不含斜杠，守卫失效！
      //    正确做法：**不允许 m[1] 里出现斜杠**（`[^/、]*?`），
      //    这样锚点必然是「块内最后一个斜杠」，路径/URL 自然整段保留。
      const m = raw.match(/^([^/、]*?)\s*[/、]([^\s/、]*)\s*$/);
      // 过滤词必须非空：`前文/` 这种（斜杠后已经没字了）交给它自己，
      // 我们只负责「斜杠 + 过滤词」这种明确的菜单残留。
      if (m && m[2].length > 0) next = m[1];
    }

    if (next === null) {
      console.log("[nebuladisk] [slash-cleanup] 无法确定斜杠位置，保守跳过（不误删）");
      return false;
    }

    // ── 3.5 整块删除分支（情形 ①）────────────────────────────────────
    if (deleteBlock) {
      const d = await kb("/api/block/deleteBlock", { id: blockId });
      if (d && d.code === 0) {
        console.log("[nebuladisk] [slash-cleanup] 已删除纯斜杠块 " + blockId);
        return true;
      }
      // 删不掉（例如只读块）就退化为清空内容，至少不留 /关键词 残渣
      console.log("[nebuladisk] [slash-cleanup] deleteBlock 失败：" +
                  ((d && d.msg) || "未知") + "，退化为清空内容");
    }

    // ── 4. 已经干净了就别写内核（避免平白扰动光标/事务）────────────────
    const cur = (raw || "").replace(/\u200b/g, "").trim();
    if (cur === next.trim()) {
      console.log("[nebuladisk] [slash-cleanup] 已是目标文本，无需改写");
      return false;
    }

    // ── 5. 走内核改写 —— 这一步才是「刷新后不再回来」的关键 ────────────
    const r = await kb("/api/block/updateBlock", {
      id: blockId,
      dataType: "markdown",
      data: next,
    });
    if (!r || r.code !== 0) {
      console.log("[nebuladisk] [slash-cleanup] updateBlock 失败：" +
                  ((r && r.msg) || "未知"), "（DOM 保持原样，不做半截清理）");
      return false;
    }
    console.log("[nebuladisk] [slash-cleanup] 内核已改写：" +
                JSON.stringify(raw.slice(0, 24)) + " → " +
                JSON.stringify(next.slice(0, 24)));
    return true;
  } catch (e) {
    console.log("[nebuladisk] [slash-cleanup] 异常，已忽略: " + (e && e.message));
    return false;
  }
}

async function writeTraceToKernel(trace) {
  try {
    const DOC_TITLE = "nebuladisk-diag";
    const HPH = "/" + DOC_TITLE;

    // 1) 找诊断文档（用 SQL 查，比 filetree API 少一次路径猜测）
    let docId = "";
    try {
      const r = await kb("/api/query/sql", {
        stmt: `SELECT id FROM blocks WHERE hpath='${HPH}' AND type='d' LIMIT 1`,
      });
      docId = (r && r.data && r.data[0] && r.data[0].id) || "";
    } catch { /* 忽略 */ }

    // 2) 没有就建（建在默认笔记本里）
    if (!docId) {
      try {
        const nb = await kb("/api/notebook/lsNotebooks", {});
        const box = nb && nb.data && nb.data.notebooks && nb.data.notebooks[0] &&
                    nb.data.notebooks[0].id;
        if (!box) return;
        const made = await kb("/api/filetree/createDocWithMd", {
          notebook: box,
          path: "/" + DOC_TITLE,
          markdown: "",
        });
        if (made && made.code === 0) {
          const r2 = await kb("/api/query/sql", {
            stmt: `SELECT id FROM blocks WHERE hpath='${HPH}' AND type='d' LIMIT 1`,
          });
          docId = (r2 && r2.data && r2.data[0] && r2.data[0].id) || "";
        }
      } catch { /* 忽略 */ }
    }
    if (!docId) return;

    // 3) 插一条带时间戳的轨迹（用 markdown 段落）
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const md = `\`${ts}\` ${trace}`;
    await kb("/api/block/appendBlock", {
      dataType: "markdown",
      data: md,
      parentID: docId,
    });
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/**
 * ★ 把 NebulaDisk 嵌入块插进当前文档（**唯一入口**）★
 *
 * 流程：定位 → 内核 insertBlock(markdown) → 回查 type 自校验 → 不是 custom 就重建。
 *
 * ★ 失败必须「吵闹且具体」★
 *   绝不用前端 `protyle.insert` 兜底 —— 它不报错，只会**静默产出一个坏块**
 *   （type=p + 字面围栏），用户看到「插入了、但是 JSON」，完全不知道失败过。
 *   ⇒ 这里一失败就 `throw`，并把原因（尤其「找不到文档」这种可自助解决的）
 *     原样带回给调用方显示。**宁可不插，也不插坏；宁可不插，也要说清为什么。**
 *
 * @param {object} plugin
 * @param {any} protyle 编辑器（可能为空/不可信，locateInsertPoint 会自行回退查找）
 * @param {object} spec
 * @returns {Promise<boolean>} true=已插入且校验通过
 * @throws {Error} 定位失败 / 内核失败 / 重建失败时抛出，`message` 是给人看的
 */
export async function insertEmbedIntoDoc(plugin, protyle, spec, opts) {
  const md = buildEmbedMarkdown(plugin && plugin.name, spec);
  const log = (m) => {
    try { console.log(`[nebuladisk] [embed-insert] ${m}`); } catch { /* 忽略 */ }
  };

  // ★★★ opts.anchorEl —— 解决了「插到文末」与「残留 /」两个 bug ★★★
  //
  //   思源斜杠菜单调用插件的契约（从 main.js 的 fill() 读出）：
  //     cn.callback(D.getInstance(), ht)   // (protyle, 光标所在块元素)
  //   并且**不**替我们执行 He.deleteContents()。
  //   ⇒ 谁从斜杠菜单进来，就必须把那个块元素一路传到这里。
  const anchorEl = (opts && opts.anchorEl) || null;
  // 斜杠场景 ⇒ 插入成功后需要清掉用户敲的 `/过滤词`
  const fromSlash = !!(opts && opts.fromSlash);

  // ★★★ 绝不使用前端 protyle.insert 兜底 ★★★
  //
  //   2026-09-22 NAS 实测（两条路径对照，已逐字复现）：
  //     前端把整段当「一个段落 DOM」提交 →
  //       type=p，content 是**字面围栏文本** ⇒ 笔记里就是一坨裸 JSON
  //     内核 insertBlock{dataType:"markdown"} →
  //       type=custom ⇒ 渲染器被触发，正常显示 ✓
  //
  //   历史上这里有个「内核失败就退回 protyle.insert」的兜底。它极其有害：
  //   内核一失败，兜底不会报错，而是**静默产出一个坏块**，
  //   用户看到的是「插入了、但是 JSON」，完全不知道失败过。
  //   ⇒ 现在改成一失败就报错（返回 false + 明确日志），宁可不插也不插坏。
  let newId = "";
  try {
    const { parentID, nextID, previousID, src } = await locateInsertPoint(protyle, anchorEl);
    if (!parentID) {
      // ★ 定位失败要说人话，并且要能自证卡在哪一级 ★
      //   历史上这里只写「定位不到插入位置」，用户看到的是「插入失败，请查看
      //   控制台日志」，完全不知道该干嘛。
      //   2026-09-22 改成具体文案后，用户报的是「找不到要插入的文档」——
      //   也就是**五级回退全落空了**。光说"请打开一个文档"没用（他明明开着），
      //   必须把逐级探测的轨迹交出来才能继续收敛。
      const trace = lastLocateTrace || "(无轨迹)";
      log("定位失败（protyle=" + (protyle ? "有" : "空") + "）");
      console.log("[nebuladisk] [locate-fail] " + trace);
      // ★ 把轨迹写进思源的内核日志，这样用户不开 DevTools 我也能读 ★
      await writeTraceToKernel(trace);
      const err = new Error(
        "找不到要插入的文档（已把诊断写入内核日志）。\n" +
        "定位轨迹：" + trace
      );
      err.stage = "locate";
      err.trace = trace;
      throw err;
    }
    log(`定位成功：parentID=${parentID} nextID=${nextID || "(无)"} previousID=${previousID || "(无)"} via=${src || "?"}`);

    const body = { dataType: "markdown", data: md, parentID };
    // ★ 需求5：nextID = 光标所在块 ⇒ 插到它**之前**（= 光标当前位置）★
    if (nextID) body.nextID = nextID;
    if (previousID) body.previousID = previousID;

    const ins = await kb("/api/block/insertBlock", body);
    if (!ins || ins.code !== 0) throw new Error((ins && ins.msg) || "insertBlock 失败");

    // ★ 拿新块 id ★
    //   ⚠️ 注意：ins.data[0].doOperations[0].data 是**计划字符串**，不是落库结果，
    //   不能拿它当「已生成 custom 块」的证据（这里曾经误判过好几轮）。
    //   唯一可信的做法是回查 blocks 表 —— 但 SQL 索引有延迟，
    //   所以下面用「DOM 回查」优先，拿不到再退 SQL。
    newId =
      ins.data && ins.data[0] && ins.data[0].doOperations &&
      ins.data[0].doOperations[0] && ins.data[0].doOperations[0].id;
  } catch (e) {
    log(`内核 insertBlock 失败：${e && e.message}`);
    // ★ 把原因抛出去，不要吞掉 ★
    //   吞掉 ⇒ 调用方只能显示「插入失败，去看控制台」，
    //   用户既不知道原因、也没法自助。**失败要吵闹，且要说得具体。**
    const err = new Error((e && e.message) || "插入失败");
    err.stage = "insert";
    throw err;
  }

  // ★ 校验：确认内核真的生成了 custom 块 ★
  //   索引进度不保证，所以多探几次；只有「明确查到非 custom」才判定失败，
  //   「暂时查不到」不算失败（避免把自己刚插的好块误删）。
  const verdict = await verifyCustomBlock(newId);
  log(`新块 ${newId || "(无 id)"} 类型校验：${verdict}`);
  if (verdict === "not-custom" && newId) {
    log(`内核生成的不是 custom ⇒ 走重建路径`);
    try {
      await repairFenceBlock(newId, extractJson(md));
      const v2 = await verifyCustomBlock(newId);
      log(`重建后校验：${v2}`);
      if (v2 !== "not-custom") {
        if (fromSlash) await cleanupSlashText(anchorEl);
        return true;
      }
      return false;
    } catch (e) {
      log(`重建失败：${e && e.message}`);
      return false;
    }
  }

  // ★ 插入成功之后，清掉斜杠菜单留下的 `/过滤词` ★
  //   只在斜杠入口做；侧边栏/预览页/拖拽都没有这个残留，不能乱动内容。
  //   放在**块确实插好之后** —— 万一插入失败，用户至少还能看着 /xxx 重试。
  //
  //   ★ 这里现在只有一句 `await cleanupSlashText(anchorEl)` ★
  //     cleanupSlashText 内部走的是 `POST /api/block/updateBlock`，
  //     内核改完会自己把 DOM 回写下来 —— **不需要**再补一个手搓的
  //     `dispatchEvent(new UIEvent("input"))`。
  //     那个补丁是旧方案的残骸（旧方案只改 DOM，想靠假 input 事件骗内核落库），
  //     而实测它一个字都存不进去：事件打在 `protyle.wysiwyg.element`
  //     （整个可编辑区根节点）上，思源根本不认为那是一次编辑。
  //     留着它反而有害 —— 会在内核已经写完后再推一次空编辑，扰动事务。
  if (fromSlash) {
    const cleaned = await cleanupSlashText(anchorEl);
    log(cleaned ? "已清理斜杠残留（内核已改写）" : "无需清理斜杠残留");
  }
  return true;
}

/**
 * 校验某个块是不是 custom 块。
 *
 * ★ 为什么要有「未知」这个结论 ★
 *   思源的 SQL 索引是异步的，刚 insert 完立刻查常常查不到（实测 1.5s 后仍是空）。
 *   如果此时把「查不到」当成「不是 custom」，就会去删一个其实很正常的块，
 *   越修越乱（这个坑已经踩过）。所以必须三态：custom / not-custom / unknown。
 *
 * @param {string} id
 * @returns {Promise<"custom"|"not-custom"|"unknown">}
 */
async function verifyCustomBlock(id) {
  if (!id) return "unknown";

  // ① 优先问 DOM —— 内核已经挂上去了，前端能立刻看到，不受 SQL 索引延迟影响
  if (typeof document !== "undefined") {
    try {
      for (let i = 0; i < 12; i++) {
        const el = document.querySelector(`[data-node-id="${id}"]`);
        if (el) {
          const t = el.getAttribute("data-type") || "";
          if (t === "NodeCustomBlock") return "custom";
          if (t) return "not-custom";
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch { /* 忽略 */ }
  }

  // ② 再问 SQL（索引可能滞后，多试几次）
  for (let i = 0; i < 6; i++) {
    try {
      const chk = await kb("/api/query/sql", {
        stmt: `SELECT type FROM blocks WHERE id='${id}'`,
      });
      const t = chk && chk.data && chk.data[0] && chk.data[0].type;
      if (t) return t === "custom" ? "custom" : "not-custom";
    } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return "unknown";
}

/**
 * 把「围栏躺在段落里」或「反引号残留」的块，重建为正确的自定义块。
 * 删 + 以 markdown 重插（实测这是唯一可靠的升级方式）。
 *
 * @param {string} blockId
 * @param {string} json 嵌入参数 JSON
 * @returns {Promise<void>}
 */
export async function repairFenceBlock(blockId, json) {
  const info = await kb("/api/query/sql", {
    stmt: `SELECT parent_id FROM blocks WHERE id='${blockId}'`,
  });
  const parentID = info && info.data && info.data[0] && info.data[0].parent_id;
  if (!parentID) throw new Error("拿不到父块 id，放弃重建");

  const sib = await kb("/api/query/sql", {
    stmt: `SELECT id FROM blocks WHERE parent_id='${parentID}' AND id < '${blockId}' ORDER BY id DESC LIMIT 1`,
  });
  const prevId = sib && sib.data && sib.data[0] && sib.data[0].id;

  const del = await kb("/api/block/deleteBlock", { id: blockId });
  if (!del || del.code !== 0) throw new Error((del && del.msg) || "deleteBlock 失败");

  let obj = null;
  try { obj = JSON.parse(json); } catch { /* 交给下面报错 */ }
  if (!obj || !obj.mount) throw new Error("嵌入参数无法解析，放弃重建");

  const md = buildEmbedMarkdown("siyuan-nebuladisk", obj);
  const insBody = { dataType: "markdown", data: md, parentID };
  if (prevId) insBody.previousID = prevId;
  const ins = await kb("/api/block/insertBlock", insBody);
  if (!ins || ins.code !== 0) throw new Error((ins && ins.msg) || "重建 insertBlock 失败");
}


/**
 * 把自定义块渲染器挂到插件上
 * @param {import("../index.js").default} plugin
 */
export function registerEmbed(plugin) {
  // 插件实例上暴露 api，供渲染器使用
  if (!plugin.api) {
    // 延迟绑定，避免 index.js 与 embed.js 循环依赖
    plugin.api = null;
  }

  const renderer = {
    render: ({ element, content }) => {
      const spec = parseEmbed(content);
      element.innerHTML = "";
      element.classList.add("nb-embed-host");

      if (!spec) {
        const bad = document.createElement("div");
        bad.className = "nb-embed-error";
        bad.textContent = "NebulaDisk 嵌入块内容无法解析（应为 JSON：{\"kind\":\"tree\",\"mount\":\"盘符\",\"path\":\"路径\"}）";
        element.appendChild(bad);
        return;
      }

      /* ★★ 就绪判据 = 「有没有一条能走到后端的路」★★
       *   （2026-09-30 的真 bug 修复）
       *
       *   原先这里直接读 `plugin.boot.status.ok`，那是**内置代理**的启动状态。
       *   于是「配了可直连的地址、但代理没起来（或被用户关掉）」时，
       *   嵌入块**直接拒绝渲染**，显示:
       *     网盘通道未就绪：代理未启动。请在插件设置中检查后重新打开本文档。
       *   而同一时刻直连完全正常（/healthz 200、/api/list 也拿得到）。
       *
       *   现在内置代理已整体删除，判据只剩一条：**配了 serverUrl 没有**。
       *   请求真通不通由请求本身回答（失败会带可读原因），不再靠猜。
       *
       *   ★ 还有一层时序 ★
       *     自动登录是异步的；文档里的嵌入块可能在这之前就渲染
       *     ⇒ 必须容忍「还在连接中」，等引导结束后再决定是渲染还是报错 ——
       *     否则每篇含嵌入块的文档在打开瞬间都会闪一句「通道未就绪」。
       */
      const readyNow = () => {
        try {
          if (typeof plugin.channelReady === "function") return Boolean(plugin.channelReady());
        } catch { /* 判据异常时按未就绪处理，走占位/提示分支 */ }
        return false;
      };

      const statusDetail = () =>
        "未配置网盘地址（请在插件设置里填写网盘地址，例如 http://192.168.193.70:8089）";

      const renderBody = () => {
        element.innerHTML = "";
        element.classList.add("nb-embed-host");
        element.appendChild(
          spec.kind === "file"
            ? renderFileEmbed(spec, plugin)
            : renderTreeBrowser(spec, plugin)
        );
      };

      const renderNotReady = (detail) => {
        element.innerHTML = "";
        element.classList.add("nb-embed-host");
        const warn = document.createElement("div");
        warn.className = "nb-embed-error";
        warn.textContent = `网盘通道未就绪：${detail}。请在插件设置中检查后重新打开本文档。`;
        element.appendChild(warn);
      };

      if (readyNow()) {
        renderBody();
        return;
      }

      // 尚未就绪：可能只是「引导还在跑」，也可能是真的没配置 —— 先占位再定夺
      const pending = plugin.bootReady;
      if (pending && typeof pending.then === "function") {
        element.innerHTML = "";
        element.classList.add("nb-embed-host");
        const loading = document.createElement("div");
        loading.className = "nb-embed-loading";
        loading.textContent = "正在连接网盘…";
        element.appendChild(loading);
        Promise.resolve(pending)
          .then(() => {
            if (!element.isConnected) return;   // 块已销毁 / 文档已切换
            if (readyNow()) renderBody();
            else renderNotReady(statusDetail());
          })
          .catch(() => {
            if (element.isConnected) renderNotReady("通道初始化异常");
          });
        return;
      }

      renderNotReady(statusDetail());
    },
  };

  plugin.customBlockRenders = plugin.customBlockRenders || {};
  // ★ 主键：思源真正会查的那个（data-info 斜杠后的 blockType）★
  plugin.customBlockRenders[BLOCK_TYPE] = renderer;
  // ★ 兼容：极端历史写法可能把块类型写成插件名 ★
  for (const k of LEGACY_BLOCK_TYPES) plugin.customBlockRenders[k] = renderer;
  // ★ 兼容：更早版本把整个插件名当键 ★
  plugin.customBlockRenders[plugin.name] = renderer;
}

/** 嵌入块渲染用的 api 绑定（由 index.js 在 onload 后调用） */
export function bindPluginApi(plugin, api) {
  plugin.api = api;
  /*
   * ★ 调试出口（只读，不改变任何行为）★
   *
   *   cleanupSlashText 是本模块的**私有**函数，只被 insertEmbedIntoDoc 内部调用。
   *   这带来一个验收盲区：想在真机上单独验它，只能「照着它重写一遍」，
   *   而那种验证证明的是**测试脚本**对，不是**实现**对 —— 2026-09-22 踩过：
   *   一个照着复现的探针报「anchor 不在 DOM」，看起来像实现坏了，其实是探针
   *   找了个编辑器还没渲染的块。
   *
   *   所以这里把它挂到 plugin 上，单纯为了能验到**真函数本身**。
   *   命名用 __nb 前缀标明是内部调试用途；它不接受外部输入去做别的事，
   *   也不被任何生产代码路径引用，删掉不影响功能。
   */
  plugin.__nbCleanupSlashText = cleanupSlashText;
}

/* -------------------------------------------------------------------------
 * 历史嵌入块自愈
 *
 * 历史包袱有两类，成因不同，处理方式也不同：
 *
 * ── 类型 A：反引号围栏残留（最常见的那个 bug）──────────────────────────
 *
 *   早期版本写成：
 *
 *     ```nebuladisk
 *     {"kind":"file",...}
 *     ```
 *
 *   但反引号围栏在思源里生成的是**普通代码块 type=c**，不是自定义块。
 *   结果：
 *     · 编辑器里显示成一段普通代码（用户看到裸 JSON）
 *     · kramdown 里连 ``` 行都一起存着
 *
 *   ⇒ 修复必须**改块内容**（把它换成 `;;;` 围栏的自定义块）。
 *     这里用内核 API 完成，因为纯前端无法把 type=c 升级成 type=custom。
 *     走 /api/block/updateBlock（dataType=dom），由内核负责序列化，
 *     不自己拼块 HTML —— 避免依赖会随版本变化的内部格式。
 *
 * ── 类型 B：dom 已就位但 data-info 是旧写法 ─────────────────────────────
 *
 *   如果某块已经是 NodeCustomBlock，但 data-info 没有斜杠（或插件名不对），
 *   思源解析不出渲染器，就会把 data-content 塞进 <pre> 里显示裸 JSON。
 *   这类**不用改笔记**，直接用本插件渲染器就地重绘即可（见 renderInPlace）。
 * ---------------------------------------------------------------------- */

/** 从元素里找出（或补出）思源的 `.custom-block__content` 容器 */
function contentBoxOf(el) {
  let box = Array.from(el.children).find((c) => c.classList && c.classList.contains("custom-block__content"));
  if (!box) {
    box = el.ownerDocument.createElement("div");
    box.className = "custom-block__content";
    const attr = Array.from(el.children).find((c) => c.classList && c.classList.contains("protyle-attr"));
    el.insertBefore(box, attr || null);
  }
  return box;
}
/**
 * 就地把一个 NodeCustomBlock 交给本插件渲染器重绘（不改笔记、不调后端）。
 *
 * 适用：块本身已经是 NodeCustomBlock（DOM 正确），只是 data-info 让思源
 * 找不到渲染器。这种情况前端就能救。
 *
 * @param {Element} el
 * @param {object} plugin
 * @returns {boolean} 是否重绘成功
 */
export function renderInPlace(el, plugin) {
  if (!el || !plugin) return false;
  const content = el.getAttribute("data-content") || "";
  const renderer = plugin.customBlockRenders && plugin.customBlockRenders[BLOCK_TYPE];
  if (!renderer || typeof renderer.render !== "function") return false;
  try {
    // ① 用思源自己的方式清出容器（移除除 protyle-attr 外的子元素）
    const attr = Array.from(el.children).find((c) => c.classList && c.classList.contains("protyle-attr"));
    Array.from(el.children).forEach((c) => { if (c !== attr) c.remove(); });
    const host = el.ownerDocument.createElement("div");
    host.className = "custom-block__content";
    el.insertBefore(host, attr || null);

    // ② 直接调本插件的渲染器（等价于思源在 data-info 正确时会做的事）
    renderer.render({ element: host, content });
    el.dataset.nbLegacyRendered = "1";
    return true;
  } catch (e) {
    console.log(`[nebuladisk] [legacy-embed] 就地重绘失败: ${e && e.message}`);
    return false;
  }
}

/**
 * 就地重绘「data-info 是旧写法」的自定义块。
 *
 * @param {import("../index.js").default} plugin
 * @param {boolean} [force] 默认只在本次会话还没处理过时才动它
 * @returns {number} 重绘的块数
 */
export function migrateLegacyEmbeds(plugin, force) {
  if (!plugin) return 0;
  const wanted = `${plugin.name}/${BLOCK_TYPE}`;
  const legacyTypes = new Set(LEGACY_BLOCK_TYPES.concat([plugin.name]));
  const nodes = Array.from(document.querySelectorAll('[data-type="NodeCustomBlock"]'));
  let fixed = 0;

  for (const el of nodes) {
    const info = el.getAttribute("data-info") || "";
    // 已经是新写法（恰好一个斜杠且插件名对）⇒ 思源自己会渲染，不用我们管
    if (info === wanted) continue;
    // 无斜杠的旧写法（nebuladisk / siyuan-nebuladisk）
    if (!legacyTypes.has(info)) continue;
    const content = el.getAttribute("data-content") || "";
    // 内容必须像本插件的 JSON，避免误伤用户自己的同名块
    if (content.indexOf('"mount"') < 0) continue;
    // 已被本次会话处理过
    if (!force && el.dataset.nbLegacyRendered === "1") continue;

    if (renderInPlace(el, plugin)) fixed++;
  }

  if (fixed) console.log(`[nebuladisk] [legacy-embed] 已就地重绘 ${fixed} 个旧自定义块（data-info 缺斜杠，已用本插件渲染器接管）`);
  return fixed;
}

/* -------------------------------------------------------------------------
 * 反引号围栏残留的扫描（类型 A）
 *
 * 扫描当前文档里的普通代码块，找出内容是「```<插件名> / ```nebuladisk /
 * ```nebuladisk\n{...}」这类本插件早期写法、且内含 "mount" 的 JSON。
 *
 * 这里只做**扫描**（返回清单），不动 DOM —— 改块内容要走内核 API，
 * 由 index.js 拿到清单后统一调用 /api/block/updateBlock 升级成自定义块。
 * ---------------------------------------------------------------------- */

const FENCE_RE = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/;

/**
 * 判断一段文本是否是本插件早期的反引号围栏写法。
 * @param {string} text
 * @returns {{oldInfo:string, json:string}|null}
 */
export function parseLegacyFence(text) {
  const raw = String(text || "").trim();
  const m = FENCE_RE.exec(raw);
  if (!m) return null;
  const lang = (m[1] || "").trim();
  const body = (m[2] || "").trim();
  if (!body || body.indexOf('"mount"') < 0) return null;
  // 语言串必须是本插件相关写法（或干脆为空，容错历史脏数据）
  const okLang =
    lang === "" ||
    lang === BLOCK_TYPE ||
    lang === "nebuladisk" ||
    lang === "siyuan-nebuladisk" ||
    lang.startsWith("siyuan-nebuladisk/") ||
    lang.startsWith("plugin/");
  if (!okLang) return null;
  return { oldInfo: lang, json: body };
}

/**
 * 扫描当前打开的文档里所有「反引号围栏残留」的代码块。
 *
 * ★ 代码块语言的真实 DOM 位置（实测思源 3.8.4 /api/block/getBlockDOM）★
 *
 *   <div data-type="NodeCodeBlock" class="code-block" data-node-id="…">
 *     <div class="protyle-action">
 *       <span class="protyle-action__language" contenteditable="false">
 *         siyuan-nebuladisk/nebuladisk          ← 语言在这里
 *       </span> …
 *     <div spellcheck="false">…代码正文…</div>   ← 正文在这里
 *     <div class="protyle-attr">…</div>
 *   </div>
 *
 *   ⚠️ **没有 data-language 属性**（早期实现假设错了）。必须读那个 span。
 *
 * @param {import("../index.js").default} plugin
 * @returns {Array<{id:string, json:string, oldInfo:string}>}
 */
export function findLegacyFenceBlocks(plugin) {
  const out = [];
  if (typeof document === "undefined") return out;
  const seen = new Set();
  // 只在当前活跃编辑器里扫，避免误伤其它文档
  const editors = document.querySelectorAll(".protyle-wysiwyg");
  editors.forEach((root) => {
    root.querySelectorAll('[data-type="NodeCodeBlock"]').forEach((el) => {
      const id = el.getAttribute("data-node-id");
      if (!id || seen.has(id)) return;
      seen.add(id);

      // ① 语言：读 protyle-action__language 这个 span
      let lang = "";
      const langEl = el.querySelector(".protyle-action__language");
      if (langEl) lang = (langEl.textContent || "").trim();
      // 兜底：某些版本可能把语言放在属性上
      if (!lang) lang = el.getAttribute("data-language") || "";
      // 渲染节点形态（未加载编辑器）时，语言在 data-content / data-subtype
      if (!lang) lang = el.getAttribute("data-subtype") || "";

      // ② 正文：代码块里带 spellcheck 的那个容器
      let body = "";
      const holder = el.querySelector("[spellcheck]");
      if (holder) body = holder.textContent || "";
      if (!body) {
        // 退化形态：整个块的 data-content 就是正文
        body = el.getAttribute("data-content") || "";
      }

      const hit = parseLegacyFence("```" + lang + "\n" + body + "\n```");
      if (hit) out.push({ id, json: hit.json, oldInfo: lang });
    });
  });
  return out;
}

/* -------------------------------------------------------------------------
 * 历史残留的第三种形态：`;;;` 围栏「没被识别」，整段留成了普通段落
 *
 * ★ 这是 2026-09-22 在 NAS 真实笔记里发现的 ★
 *
 *   症状：块是 type=p（普通段落），content 就是**字面的**围栏文本
 *
 *     ;;;siyuan-nebuladisk/nebuladisk
 *     {"kind":"file","mount":"售前项目","path":"/x.docx"}
 *     ;;;
 *
 *   —— 字面看着完全正确，但思源没把它编译成自定义块。
 *
 *   成因（实测 v3.8.4）：
 *     · 用 /api/filetree/createDocWithMd **新建文档**时，`;;;` 能正确
 *       生成 type=custom（已验证）。
 *     · 但如果这段文本是**后来粘贴/输入**进一个已存在的段落块，
 *       或者整段被当成一个段落提交，内核就用**段落**的方式存下来了，
 *       不会再回头重新解析成自定义块。
 *     · ⇒ 它既不是 NodeCodeBlock（第一种形态扫不到），
 *          也不是 NodeCustomBlock（第二种形态扫不到）。
 *
 *   为什么不能沿用「就地重绘」（姿势 B）：
 *     思源压根没给它 .custom-block__content 容器，data-info 也不存在，
 *     前端 DOM 上没有可用的入口。
 *
 *   为什么不能沿用「updateBlock(dom)」（姿势 A）：
 *     实测过了 —— 传 dataType="dom" 的 NodeCustomBlock 给一个
 *     type=p 的块，返回 code=0，但**块类型仍是 p**（DOM 被当段落属性吸收）。
 *     传 dataType="markdown" 也一样不升。
 *
 *   ⇒ 唯一可靠做法：**删掉这个段落块，再以 markdown 形式重新插入**。
 *     删除 + 插入都走内核 API，由内核负责生成正确的 NodeCustomBlock。
 * ---------------------------------------------------------------------- */

/**
 * 识别「段落里躺着一段字面 `;;;` 围栏」的块。
 *
 * 判定条件（三条都要满足，防误伤）：
 *   ① 块的 textContent 去掉首尾空白后以 `;;;` 开头
 *   ② 能找到与开头配对的收尾 `;;;` 行
 *   ③ 中间那行是含 "mount" 的合法 JSON（本插件专属特征）
 *
 * @param {Element} el 一个 NodeParagraph
 * @returns {{id:string, json:string, info:string}|null}
 */
export function parseParagraphFence(el) {
  // 段落的正文可能在多个子节点里，用 textContent 拼回来
  let text = (el.textContent || "").trim();
  if (!text) return null;

  // ★★★ 容错：剥掉围栏开头的杂散字符 ★★★
  //
  //   2026-09-22 在 NAS 真实笔记里抓到过一个坏块，content 是：
  //       "[;;;siyuan-nebuladisk/nebuladisk\n{...}\n;;;"
  //        ^ 这个方括号
  //   实测（/api/filetree/createDocWithMd 对照）：
  //        ;;;siyuan-…      → type=custom ✓
  //       [;;;siyuan-…      → type=p      ✗   ← 围栏前面多一个字符就不认了
  //   也就是说**围栏必须顶格**，前面多任何一个字符都会退化成普通段落。
  //   （方括号来自更早版本的插入写法，可能是 markdown 链接拼接的残留。）
  //   这里主动剥掉，让自愈能救回这类历史坏块。
  text = text.replace(/^[\[\(\{【（「]+/, "");
  if (!text.startsWith(";;;")) return null;

  // 用 kramdown 的形态重新分行：开头行 / JSON / 结束行
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return null;
  const head = lines[0].trim();
  if (!head.startsWith(";;;")) return null;
  // 收尾的 ;;;（允许后面跟别的节点文字，所以从后往前找最后一行 ;;; ）
  let end = -1;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].trim() === ";;;") { end = i; break; }
  }
  if (end < 2) return null;

  const info = head.slice(3).trim();
  const body = lines.slice(1, end).join("\n").trim();
  if (body.indexOf('"mount"') < 0) return null; // ★ 只认本插件的内容
  try {
    const o = JSON.parse(body);
    if (!o || !o.mount) return null;
  } catch {
    return null;
  }
  return { id: el.getAttribute("data-node-id") || "", json: body, info };
}

/**
 * 扫描当前编辑器里所有「段落形态的围栏残留」。
 * @param {import("../index.js").default} plugin
 * @returns {Array<{id:string, json:string, info:string}>}
 */
export function findParagraphFences(plugin) {
  const out = [];
  if (typeof document === "undefined") return out;
  const seen = new Set();
  const wanted = `${plugin.name}/${BLOCK_TYPE}`;
  document.querySelectorAll(".protyle-wysiwyg").forEach((root) => {
    root.querySelectorAll('[data-type="NodeParagraph"]').forEach((el) => {
      const id = el.getAttribute("data-node-id");
      if (!id || seen.has(id)) return;
      const hit = parseParagraphFence(el);
      if (!hit || !hit.id) return;
      // 已经是对的就别动
      if (hit.info === wanted) return;
      // 只处理本插件相关写法（或旧的无斜杠写法）
      const isOurs =
        hit.info === plugin.name ||
        hit.info === BLOCK_TYPE ||
        hit.info === wanted ||
        hit.info.indexOf(BLOCK_TYPE) >= 0;
      if (!isOurs) return;
      seen.add(id);
      out.push(hit);
    });
  });
  return out;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

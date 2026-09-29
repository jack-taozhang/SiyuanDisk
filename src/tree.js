/* ==========================================================================
 * 侧边栏文件树（需求 ①）
 * --------------------------------------------------------------------------
 * 交互参照思源原生文档树：
 *   · 懒加载：展开才请求
 *   · 单击展开/收起目录，双击目录进入（与原生一致）
 *   · 单击文件 → 在当前页签预览；双击文件 → 新页签打开
 *   · 右键菜单：新建文件夹 / 重命名 / 删除 / 下载 / 复制路径 / 嵌入文档
 *   · 顶部：盘符切换 + 刷新 + 过滤
 *
 * 状态管理：不做全局 store，每个节点的展开状态挂在自身 DOM 上，
 * 只有「哪些路径展开过」用一个 Set 记录，刷新时据此恢复。
 * ========================================================================== */

/* ★★★ 必须显式导入 Menu（2026-09-22 踩过的坑）★★★
 *
 *   思源**不会**把 UI 组件挂到 window 上 —— `new Menu("nbTreeNode")` 里的
 *   `Menu` 只是一个自由的标识符。原先这份文件只导入了
 *   `{ showMessage, confirm }`，于是 showNodeMenu / showMoreMenu 一被调用
 *   就抛：
 *
 *       ReferenceError: Menu is not defined
 *         at FileTree.showNodeMenu (plugin:siyuan-nebuladisk:5031:20)
 *
 *   而 `row.oncontextmenu = (ev) => this.showNodeMenu(ev, entry)` 是
 *   事件回调，异常被浏览器吞进控制台 ⇒ 表现就是**右键完全没反应、菜单不出来**，
 *   页面本身不报错、不白屏。用户的原话是「右键菜单…这个我没有看到」。
 *
 *   教训：**「UI 元素没出现」先怀疑 ReferenceError，而不是怀疑样式/定位。**
 *   菜单代码再完整，只要构造它的那个类没导入，就是一个死字面量。
 *   定位方式：直接把 handler 拿出来调（console 里
 *   `window.__nebuladiskPlugin.tree.showNodeMenu(ev, entry)`），
 *   异常会原样抛到调用方，比看被吞掉的事件回调快得多。
 */
import { showMessage, confirm, Menu } from "siyuan";

import {
  API,
  extOf,
  isEditable,
  nodeKey,
  webDiskUrl,
  displayMountPath,
  // ★ 2026-09-28：displayCrumbPath 的导入已移除 ★
  //   它唯一的调用点是网格视图的面包屑（renderGrid）。网格整体删除后，
  //   这里变成「导入了但从未使用」的死导入 —— syntax.check.js 的
  //   ⑤ 号检查会直接报错（实测确认过，不是推测）。
  //   ⚠️ 函数本身**仍保留在 src/api.js 里**并继续导出，
  //     它是通用的路径格式化工具（test/verify-drag-insert.cjs 的测试 11
  //     仍在直接验证它的行为）。若日后恢复网格：把这一行加回即可。
} from "./api.js";
import { typeIconEl } from "./icons.js";
import { diag } from "./proxy.js";
import { insertEmbedIntoDoc } from "./embed.js";

/* -------------------------------------------------------------------------
 * 菜单定位参数
 *
 * ★★★ 菜单显示入口：走 `openMenuAt(menu, ev)`，内部 **`open()` 优先** ★★★
 *
 *   【2026-09-28 定案 —— 本条曾写错，现按实测改正，请勿再改回去】
 *
 *   思源里有**两个都叫 Menu 的类**，早前把它们的性质搞混了，导致结论张冠李戴：
 *
 *   ── 类 A：内部菜单（`window.siyuan.menus.menu` 的类，bundle 里叫 `te`）──
 *      从容器内 /opt/siyuan/stage/build/app/common.<hash>.js 反编译 + 浏览器里
 *      `Object.getPrototypeOf(window.siyuan.menus.menu)` 实测，该类**恰好 24 个方法**：
 *        addItem, append, canDragSheet, closeSheet, emitCommonMenu,
 *        finishSheetTouch, fullscreen, getFullscreenScrim, hideFullscreenScrim,
 *        popup, preventDefault, remove, removeImmediately, removeScrollEvent,
 *        resetPosition, setPopupPosition, setSheetHeight, showFullscreenScrim,
 *        showSubMenu, startTrackingSheetViewport, startTrackingTargetPosition,
 *        stopTrackingTargetPosition, updateMaxHeight, updateSheetTitle
 *      ⇒ 类 A **有 `popup`，没有 `open`，也没有 `addSeparator`**。
 *      `popup(T)` 里那句 `this.element.classList.remove("fn__none")` 才是真正显示。
 *
 *   ── 类 B：插件 API 包装类（main.<hash>.js 模块 6959 导出 `W`）★★ 我们用的就是这个 ★★──
 *      `new Menu(id, closeCallback, isStandalone)`。源码（关键部分）：
 *
 *        constructor(c, a, C = !1) {
 *          if (C) {                                  // 独立菜单：克隆一份
 *            const h = window.siyuan.menus.menu.element.cloneNode(!0);
 *            h.setAttribute("data-menu", "true");     // ★ 独立时才显式加此标记
 *            ...; this.menu = new W1(h);
 *          } else {
 *            this.menu = window.siyuan.menus.menu;    // ★ 默认复用共享单例
 *          }
 *          this.element = this.menu.element;
 *          if (c && !C) {                             // 传了 id 且复用单例
 *            const h = this.menu.element.getAttribute("data-name");
 *            h && h === c && (this.isOpen = !0);      // ★ 同名已开 ⇒ isOpen=true
 *          }
 *          if (this.menu.remove(), !this.isOpen) ...
 *        }
 *        addItem(c){ if(!this.isOpen) return this.menu.addItem(c) }
 *        addSeparator(c, a = !1){ ... return this.menu.addItem({id, type:"separator", index}) }
 *        showSubMenu(c){ this.menu.showSubMenu(c) }
 *        open(c){ this.isOpen || this.menu.popup(c) }   // ★★★ 公开入口就是 open() ★★★
 *        fullscreen(c = "all"){ this.isOpen || this.menu.fullscreen(c) }
 *        close(){ this.menu.remove() }
 *
 *      ⇒ 类 B 只有 6 个公开方法：`addItem / addSeparator / showSubMenu /
 *        open / fullscreen / close`（外加 `element` / `isOpen` / `menu` 属性）。
 *        **它有 `open()`，反而没有 `popup`**；`open(c)` 内部才去调 A 的 `popup(c)`。
 *
 *   ★ 怎么确定我们用的是 B（不是 A）—— 用**调用栈**实测，不靠猜：
 *
 *       at proto.popup (<anonymous>)                            ← A 的 popup
 *       at $.open (main.<hash>.js:4239:16357)                   ← B 的 open
 *       at openMenuAt (plugin:siyuan-nebuladisk:5813)           ← 我们的封装
 *       at FileTree.showMoreMenu (plugin:siyuan-nebuladisk:7619)
 *
 *     注意 `openMenuAt` 的**下一帧直接是 B 的 `open`**，中间没有我们自己调 popup 的帧
 *     ⇒ 走的是 open 分支；而 `openMenuAt` 里 `popup` 分支之所以没走，正是因为
 *     我们的对象**没有 `popup`**（B 没有）。另一条独立证据：`menu.addSeparator()`
 *     有效（菜单里真的出现了 `.b3-menu__separator`），而 `addSeparator` 只存在于 B。
 *
 *     这两个探针就干这事，要复核/换思源版本时直接跑：
 *       · tools/_probe-menu-which-class.cjs —— 把 A 的 popup 包一层抓调用栈，
 *         一眼看出走的是哪条分支（**定案靠这个**）
 *       · tools/_probe-menu-prototype.cjs  —— 枚举原型链方法 + 逐项测
 *         open/popup/addSeparator 是否存在（拿类 A 的 24 个方法就靠它）
 *
 *   ⚠️ 所以：**早前「思源 Menu 没有 open()，所以 menu.open 抛 TypeError」的说法是错的**
 *      —— 那是类 A 的性质，却被拿去解释类 B 的调用。
 *      旧代码 `menu.open(menuAnchor(ev))` **本来就是合法调用**；用户最初
 *      「点了什么都不显示」的真正原因见下面 ② —— **按钮缺 `data-menu="true"`**。
 *      （换句话说：当时那个 bug 只有一层根因，不是两层。）
 *
 *   ★ 但仍然保留「open 优先、popup 兜底」的双分支，理由不是"修 bug"，而是**防御**：
 *     插件 API 是外部契约，思源改版可能换名；两个分支都试，任一侧改名都不会变成
 *     静默失效。若两个都没有则 `console.error` + toast（失败必须说出来）。
 *
 *   ★ 参数形状 `{ x, y, h }`（实测 B 的 `open` 收到的入参 keys 就是这三个）：
 *     · `x` / `y` —— 锚点坐标（鼠标位置，或元素右下角）
 *     · `h`       —— 锚点元素**高度**，A 的 setPopupPosition 里 `if (T.h > 0)`
 *                    用它算向上/向下翻转；缺了不崩，只是不翻转。
 *
 *   ★★ 另一个必须知道的坑：类 B 的构造里 `if (this.menu.remove(), !this.isOpen) ...`
 *      —— 它**每次 new 都会先 remove() 掉共享单例里已有的内容**，
 *      而同名菜单已打开时会置 `isOpen = true`，此后 `addItem` / `open` **全部静默忽略**。
 *      所以：**不要复用同一个 Menu 实例反复 open**，每次弹菜单都要 `new Menu(...)`。
 *
 * ---- 以下为历史排查记录（定位兜底链为何会断，仍然有效）----
 *
 *   那个 TypeError 的来历（顺着 stack 反编译出来的）：
 *     思源内部有个「工具栏高度」helper：
 *
 *       const toolbarH = () => {
 *         if (document.getElementById("sidebar")) return 0;
 *         return document.getElementById("toolbar")?.clientHeight
 *                || document.querySelector(".layout-tab-bar").clientHeight;  // ← null!
 *       };
 *
 *     在没有侧边栏 / 没有 #toolbar 的上下文里，最后那个
 *     `.layout-tab-bar` 取到 null ⇒
 *       TypeError: Cannot read properties of null (reading 'clientHeight')
 *     这只是**定位兜底链断了**，跟我们的坐标参数无关。
 *
 *   ⇒ 所以正确姿势是：给足 `{ x, y, h }`，让思源走正常定位分支，
 *     不要让它去摸那条会断的兜底链。
 *
 *   返回 { x, y, h }：
 *     · x / y —— 鼠标位置；无事件时退回元素右下角
 *     · h     —— 锚点元素高度（思源拿来判断向上还是向下展开）
 */
function menuAnchor(ev) {
  // 事件可能来自：真实鼠标事件 / 合成事件 / 定时器（无事件）。
  const hasCoords = ev && typeof ev.clientX === "number" && typeof ev.clientY === "number";
  const tgt =
    (ev && ev.currentTarget) ||
    (hasCoords && ev.target) ||
    document.querySelector(".nb-tree-bar") ||
    document.getElementById("sidebar") ||
    document.body;

  // ★ getBoundingClientRect 会**抛异常**，不只是可能不存在 ★
  //   元素已脱离 DOM（刷新后重建、菜单锚点在条件渲染里被换掉）时，
  //   Chrome/Electron 抛 "Failed to execute 'getBoundingClientRect'"。
  //   早先只判了 `tgt && tgt.getBoundingClientRect`（存在性），
  //   没包 try —— 于是异常一路上抛到 click 回调被吞，
  //   **菜单又变成「点了什么都不显示」**（与 2026-09-28 那个 bug 同类现象）。
  //   行为级测试 tools/_sim-menu-open-behavior.cjs 的用例5 抓到了这一点。
  let rect = { left: 0, top: 0, bottom: 20, height: 20, right: 0, width: 0 };
  if (tgt && typeof tgt.getBoundingClientRect === "function") {
    try {
      const r = tgt.getBoundingClientRect();
      if (r && typeof r.height === "number") rect = r;
    } catch (e) {
      console.warn(
        "[siyuan-nebuladisk] menuAnchor: 锚点 getBoundingClientRect 失败，" +
        "退回默认坐标。原因：" + (e && e.message)
      );
    }
  }

  return {
    x: hasCoords ? ev.clientX : Math.round(rect.left + rect.width),
    y: hasCoords ? ev.clientY : Math.round(rect.bottom),
    // ★ 关键：思源用 h 做向上/向下翻转，缺了它就退回会断的兜底链
    h: Math.round(rect.height) || 20,
  };
}

/**
 * 打开菜单 —— ★ 所有菜单显示都走这里，不要在各处直接调 open/popup ★
 *
 * 【2026-09-28 定案，修正了本条早前的错误叙述】
 *
 *   ★ **`open()` 优先** —— 插件 API 的 Menu（包装类，见文件顶部长注释）
 *     公开方法就叫 `open`，它内部才去调内部类的 `popup`。
 *     实测调用栈（决定性证据）：
 *        at proto.popup (<anonymous>)                    ← 内部类 A
 *        at $.open (main.<hash>.js:4239:16357)           ← 包装类 B（我们用的）
 *        at openMenuAt (plugin:siyuan-nebuladisk:5813)   ← 本函数
 *     注意本函数的下一帧**直接就是 B 的 open**，中间没有我们自己调 popup 的帧
 *     ⇒ 真实走的是 open 分支。
 *
 *   ⚠️ 早前这里写的是「popup 优先」，理由是「Menu 没有 open」——那个理由**是错的**
 *      （那是内部类 A 的性质，被误当成插件 API）。
 *      好消息是这个错误**没有造成行为问题**：popup 分支对我们的对象永远为假
 *      （B 没有 popup），会自动落到 open 兜底分支，结果是对的。
 *      但留着错的理由更危险 —— 下次有人照它去「修」就会踩坑，故改正。
 *
 *   ★ 为什么仍保留两个分支（**这是防御，不是修 bug**）：
 *     插件 API 是外部契约，思源改版可能换名。两个都试，任一侧改名都不会退化成
 *     「静默失效」。两个都没有则 `console.error` + toast —— 失败必须说出来。
 *
 *   ★ 顺带记一条构造侧的坑（见文件顶部）：同名 Menu 若已开着，
 *     包装类的 `isOpen` 会是 true，此后 `addItem` / `open` **全部静默忽略**。
 *     ⇒ 每次弹菜单都要 `new Menu(...)`，不要复用实例。
 *
 * @param {object} menu    Menu 实例（来自 require("siyuan")）
 * @param {object|null} ev 触发事件（可为 null，此时用 .nb-tree-bar 的右下角）
 */
function openMenuAt(menu, ev) {
  const pos = menuAnchor(ev);
  // ★ open 优先：那是插件 API 的公开入口（包装类），参数同为 {x, y, h}
  if (typeof menu.open === "function") {
    menu.open(pos);
    return;
  }
  // 兜底：内部菜单类的显示方法；将来思源若把插件 API 直接换成它也能用
  if (typeof menu.popup === "function") {
    menu.popup(pos);
    return;
  }
  // 两条路都没有 —— 明确报出来，别让它变成"点了没反应"
  console.error(
    "[siyuan-nebuladisk] 菜单无法打开：Menu 实例既没有 open() 也没有 popup()。" +
    " 思源版本可能变更了菜单 API。实例方法：" +
    Object.getOwnPropertyNames(Object.getPrototypeOf(menu) || {}).join(",")
  );
  showToast("菜单打开失败：思源菜单接口不兼容（详见控制台）");
}

/**
 * 菜单打开期间，抑制触发按钮自己那个 tooltip（否则它一直显示「更多」盖在菜单上）
 *
 * 【2026-09-28 实测定案】
 *   用户反馈：「弹出后 一直显示『更多』这俩字」。
 *   复现 + 量化（tools/_probe-tooltip-repro.cjs，读 ::after 的 computed 样式）：
 *     初始            :focus-within=false  ::after opacity=0
 *     合成 hover      :focus-within=false  ::after opacity=0   （合成事件不触发 CSS :hover）
 *     点击后          :focus-within=TRUE   ::after opacity=1   ← tooltip 显示了
 *   原因全在思源 base.css 原文：
 *     .b3-tooltips::after{
 *       z-index:1000000;            ← 比菜单的 z-index（++window.siyuan.zIndex）还高
 *       content:attr(aria-label);   ← 内容就是 aria-label="更多"
 *     }
 *     .b3-tooltips:hover::after,
 *     .b3-tooltips:focus-within::after{ opacity:1 }
 *     .b3-tooltips__s::after{ top:100%; right:50%; margin-top:5px }  ← 按钮正下方=菜单位置
 *   ⇒ 点按钮时浏览器先把焦点给它（mousedown 的默认行为），**焦点不丢 ⇒ `:focus-within`
 *     恒为真 ⇒ tooltip 一直显示**；真实鼠标还会同时满足 `:hover`。
 *     这正是「一直」二字（不是闪一下，是赖着不走）。
 *
 * 修法：给按钮打一个临时类 `is-menu-open`，配合 index.css 的
 *     .nb-tree-btn.is-menu-open::after{ display:none !important }
 * 在菜单开着的这段时间把 tooltip 关掉；下一次点击 / 按键时恢复，
 * 于是**平时 hover 仍然有 tooltip（可用性不丢）**，只是不再盖菜单。
 *
 * 为什么用 document 捕获阶段的 click/keydown 来恢复（而不是监听菜单关闭）：
 *   思源菜单是复用的单例元素，没有对外的事件可订阅；
 *   而「关菜单」的用户动作必然是「点了某处」或「按了键」，覆盖这两者即可。
 *   注册延后一拍（setTimeout 0），避免被**本次**点击立刻清掉。
 *
 * @param {HTMLElement} btn 触发菜单的按钮
 */
function suppressTooltipWhileMenuOpen(btn) {
  if (!btn || !btn.classList) return;
  btn.classList.add("is-menu-open");
  const restore = () => {
    btn.classList.remove("is-menu-open");
    document.removeEventListener("click", restore, true);
    document.removeEventListener("keydown", restore, true);
  };
  setTimeout(() => {
    document.addEventListener("click", restore, true);
    document.addEventListener("keydown", restore, true);
  }, 0);
}

export class FileTree {
  /**
   * @param {import("../index.js").default} plugin
   * @param {HTMLElement} element 停靠面板容器
   */
  constructor(plugin, element) {
    this.plugin = plugin;
    this.el = element;
    this.mounts = [];
    this.currentMount = "";
    this.expanded = new Set();     // 展开过的节点 key，用于刷新后恢复
    this.filter = "";
    this.destroyed = false;
    this.proxyOk = true;
    this.sessionOk = true;
    this._renderToken = 0;
    /** bootstrap 重入保护（见 bootstrap） */
    this._bootstrapping = false;
    this._bootQueued = false;
    /** 是否已完成首次引导（render 复用判断） */
    this._booted = false;
    /** 需求 ④：拖拽插入。当前正在被拖的条目（拖完清空） */
    this._dragging = null;
    /** 拖拽插入相关监听器的引用，destroy 时要摘掉（否则面板重建会叠加监听） */
    this._dropBound = false;
    this._onDragOver = null;
    this._onDrop = null;
    this._onDragLeave = null;
    /** 任务⑫：从系统拖文件进来上传。当前高亮的落点目录路径（"" = 当前目录） */
    this._uploadTarget = null;
    this._uploadBound = false;
    this._uploadTargetEl = null;
    this._onUploadDragOver = null;
    this._onUploadDrop = null;
    this._onUploadDragLeave = null;
    /** 上传进行中标记：防手滑连点/连拖导致重复上传同一批文件 */
    this._uploading = false;

    // 拖拽是「文件树 → 正文」的跨面板交互，监听器必须挂在 document 上：
    // 文件树在右侧停靠栏，正文在中间，两者相邻但互不包含。
    this.bindDragDrop();
    // ⚠️ 任务⑫ 的上传监听**不能**在这里挂 ★
    //   它要挂在 `this.treeEl` 上，而 treeEl 是在 render() 里才创建的。
    //     · bindDragDrop 挂的是 document ⇒ 构造期就有，OK
    //     · bindUploadDrop 挂的是 treeEl ⇒ 构造期还是 undefined
    //   第一版我照着上面那行一起写在了构造函数里，直接炸：
    //     TypeError: Cannot read properties of undefined (reading 'addEventListener')
    //       at FileTree.bindUploadDrop
    //       at new FileTree        ← 构造就失败，整个侧边栏都起不来
    //   这个错在**单元测试里发现不了**（没有 DOM、也没有真的去 new），
    //   是真机打开面板时才暴露的。所以它必须紧跟在 treeEl 创建之后（见 render）。
  }

  /* =====================================================================
   * 需求 ④：从文件树拖拽到笔记正文，在落点处插入嵌入块
   *
   * 设计要点（每条都是踩过或推理过才定下来的）
   * ---------------------------------------------------------------------
   * ① 监听挂在 **document** 上，不是挂在文件树上。
   *    drop 发生在**正文**（中间区），跟文件树（右侧停靠栏）是两个相邻但
   *    互不包含的 DOM 子树。挂在树上永远收不到 drop。
   *
   * ② 用 capture 阶段监听 dragover，并且 `preventDefault()`。
   *    HTML5 DnD 的规矩：**只有 dragover 里 preventDefault，才会触发 drop**。
   *    这一条最容易漏，现象是「松手后毫无反应、控制台连日志都没有」。
   *
   * ③ 落点解析交给 `resolveDropBlock(el)`：
   *    el = document.elementFromPoint(x, y) → 往上找最近的 [data-node-id]。
   *    拿到的是**正文里那个块** ⇒ 作为锚点交给插入通道。
   *    拿不到（拖到空白/页面外）⇒ 返回 null，走 locateInsertPoint 的常规兜底。
   *
   *    ★ 需求5（2026-09-26）：锚点语义 = 「插到该块**上面**」★
   *      用户原话：「网盘拖拽插入嵌入块 … 目前都在目前光标下一个位置，
   *                调整为当前位置插入。」
   *      落点块元素经 insertEmbedIntoDoc → locateInsertPoint 变成
   *      `nextID = 落点块`（内核语义：插到它之前），见 embed.js 的说明。
   *      这里**只负责把元素交出去**，不再自己决定"前/后"。
   *
   * ④ 只有携带我们自定义 MIME 的拖拽才处理。
   *    否则用户从 VS Code / 浏览器拖一段文本进来，也会被我们当成网盘文件。
   * ================================================================== */
  bindDragDrop() {
    if (this._dropBound) return;
    this._dropBound = true;
    const DND_MIME = "application/x-nebuladisk-embed";

    /*
     * ★★★ 需求①：落点不在笔记正文里 ⇒ 什么都不做（含不提示）★★★
     *
     * 用户原话：「网盘文件拖拽不放回到 dock 位置，那就什么都不做。
     *           也不用提示插入失败。（参照盘绘插件）」
     *
     * 为什么必须加这道闸：
     *   本监听挂在 **document 捕获阶段**，会看到全站的所有拖放 ——
     *   包括用户把文件拖回右侧 dock（想取消/换个盘再拖）、拖到文件树自己身上、
     *   拖到工具栏/页签头/页面空白。这些落点都不是「拖进笔记正文」。
     *
     * 判据必须是「真实笔记正文」，不能图省事写成 `closest(".protyle-wysiwyg")`：
     *   思源正文里可能出现**嵌套的 wysiwyg 伪正文**（例如别的插件渲染的
     *   文档预览块本身带 `protyle-wysiwyg` 且内容含 `data-node-id`），
     *   用它当判据会误命中 ⇒ 拿到一个**不属于本文档的块 id** 交给内核 ⇒
     *   内核 `transaction.go doInsert0` 找不到节点 ⇒ **PANIC**。
     *   （画布插件 2026-09-26 在 NAS 内核日志里实测到过这条崩溃路径：
     *     `PANIC RECOVERED: invalid memory address or nil pointer dereference`
     *     ... `Transaction.doInsert0 (transaction.go:1793)`）
     *
     * 因此判据收紧为两条同时成立：
     *   ① 落点在 `.protyle-wysiwyg` 内；
     *   ② 该 wysiwyg **不是**某个 `.protyle[data-node-id]` 之外的东西 ——
     *      即它必须能上溯到一个真正的编辑器容器 `.protyle[data-node-id]`。
     * 这样「伪正文」（挂在插件自己的容器里，上溯不到 .protyle[data-node-id]）
     * 会被自然排除。
     *
     * ★ 只读判断，不 preventDefault ⇒ 不会有 drop 事件 ⇒ 自然「什么都不做」★
     *   而且不 preventDefault 才让文件树自己的上传逻辑、其它插件能正常收到
     *   那次 drop（那才是用户丢回 dock 时的本意）。
     */
    const resolveNoteEditorBody = (el) => {
      if (!el || el.nodeType !== 1) return null;
      try {
        const body = el.closest ? el.closest(".protyle-wysiwyg") : null;
        if (!body) return null;
        // ② 必须能上溯到真正的编辑器容器（.protyle 且带 data-node-id）
        const host = body.closest ? body.closest(".protyle[data-node-id]") : null;
        if (!host) return null;
        return body;
      } catch { return null; }
    };

    this._onDragOver = (ev) => {
      if (!this._dragging) return;              // 不是我们拖的，完全不干预
      // ★ #55：理论上拖拽源头已不再产出 isDir 载荷（attachEmbedDrag 直接不给
      //   文件夹开 draggable），这里是第二道闸：万一有陈旧载荷，也别显示落点高亮，
      //   否则会给出「松手就能插进去」的假承诺。
      if (this._dragging.isDir) return;
      // ★★★ 需求①：落点不在正文（拖回 dock / 拖到树上 / 拖到空白）★★★
      //   直接 return，**不 preventDefault**、**不清高亮之外不做任何事**。
      //   后面的旧代码会 preventDefault ⇒ 产生 drop ⇒ 触发插入（用户的 bug）。
      if (!resolveNoteEditorBody(ev.target)) return;
      // ★ 关键：必须 preventDefault，否则不触发 drop ★
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "copy"; } catch { /* 某些环境只读 */ }
      // 高亮落点块，给用户「会插到这里」的即时反馈
      const block = this.resolveDropBlock(document.elementFromPoint(ev.clientX, ev.clientY));
      const prev = this._lastDropBlock;
      if (prev && prev !== block) prev.classList.remove("nb-drop-target");
      if (block) {
        block.classList.add("nb-drop-target");
        this._lastDropBlock = block;
      } else {
        this._lastDropBlock = null;
      }
    };

    this._onDrop = async (ev) => {
      if (!this._dragging) return;
      // ★★★ 需求①：与 dragover 完全同一道判据（必须一致）★★★
      //   正常情况下 dragover 已拦住非正文落点（它们不会被 preventDefault，
      //   因而根本不产生 drop）。这里再判一次是兜底：事件也可能由别处合成派发，
      //   或 dragover 与 drop 之间光标移到了别处。
      //   两次判据若不一致，会出现「dragover 放行、drop 却拒绝」的半途状态。
      if (!resolveNoteEditorBody(ev.target)) {
        // 静默放弃：不 preventDefault、不 stopPropagation、不提示
        this._dragging = null;
        if (this._lastDropBlock) {
          this._lastDropBlock.classList.remove("nb-drop-target");
          this._lastDropBlock = null;
        }
        return;
      }
      let payload = null;
      try {
        const raw = ev.dataTransfer.getData(DND_MIME);
        if (raw) payload = JSON.parse(raw);
      } catch (e) {
        diag(`[tree] drop 解析 payload 失败：${e && e.message}`);
      }
      if (!payload) payload = this._dragging;    // 退而用记住的那份
      if (!payload) return;

      ev.preventDefault();
      ev.stopPropagation();

      // 落点块：拖到哪就插到哪
      const targetEl = this.resolveDropBlock(document.elementFromPoint(ev.clientX, ev.clientY));
      this._dragging = null;
      if (this._lastDropBlock) {
        this._lastDropBlock.classList.remove("nb-drop-target");
        this._lastDropBlock = null;
      }

      diag(`[tree] drop：${payload.mount}:${payload.path} → 落点块 ${targetEl ? (targetEl.getAttribute("data-node-id") || "无id") : "（未命中，走兜底）"}`);

      // 复用唯一的插入通道；anchorEl 传落点块 ⇒ 插到它**上面**（需求5）
      try {
        // ★ #55：文件夹不再可拖，正常情况走不到这里。
        //   但保留这道闸门 —— 万一有**历史遗留**的 dataTransfer（比如从旧版页面
        //   拖过来的、或第三方伪造的 MIME），也不能把文件夹塞成嵌入块。
        if (payload.isDir) {
          diag(`[tree] drop 收到文件夹（#55 已不支持）：${payload.mount}:${payload.path}，忽略`);
          showToast("文件夹不支持拖拽插入（请拖单个文件）");
          return;
        }
        const editor = getActiveEditor();
        const spec = { kind: "file", mount: payload.mount, path: payload.path, name: payload.name };
        const ok = await insertEmbedIntoDoc(this.plugin, editor, spec, {
          anchorEl: targetEl || null,
          fromSlash: false,          // 拖拽没有斜杠残留，别去清正文
        });
        showToast(ok ? "已插入网盘嵌入块" : "插入失败：内核没有生成自定义块");
      } catch (e) {
        if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
        showToast(`嵌入失败：${(e && e.message) || "未知原因"}`);
      }
    };

    this._onDragLeave = (ev) => {
      // 拖出窗口时清掉高亮（拖到别的元素上 dragover 会继续更新，不用管）
      if (ev.relatedTarget) return;
      if (this._lastDropBlock) {
        this._lastDropBlock.classList.remove("nb-drop-target");
        this._lastDropBlock = null;
      }
    };

    document.addEventListener("dragover", this._onDragOver, true);
    document.addEventListener("drop", this._onDrop, true);
    document.addEventListener("dragleave", this._onDragLeave, true);
  }

  unbindDragDrop() {
    if (!this._dropBound) return;
    this._dropBound = false;
    document.removeEventListener("dragover", this._onDragOver, true);
    document.removeEventListener("drop", this._onDrop, true);
    document.removeEventListener("dragleave", this._onDragLeave, true);
    if (this._lastDropBlock) {
      this._lastDropBlock.classList.remove("nb-drop-target");
      this._lastDropBlock = null;
    }
  }

  /**
   * 把一个 DOM 元素解析成「正文里可以被锚定的块元素」。
   *
   * ★ 为什么是「往上找最近的 [data-node-id] 且必须在 .protyle-wysiwyg 内」★
   *   正文的块都带 data-node-id，但**外层容器**（页签头、工具栏、文档标题）
   *   也可能带。如果不限定在 .protyle-wysiwyg 内，用户把文件拖到页签头附近
   *   就会拿到一个非正文块，插出来的位置完全不可预期。
   *   限定之后：命中 ⇒ 一定是个真块；未命中 ⇒ 老实返回 null 走兜底。
   *
   * @param {Element|null} el
   * @returns {Element|null}
   */
  resolveDropBlock(el) {
    if (!el || el.nodeType !== 1) return null;
    try {
      const holder = el.closest ? el.closest("[data-node-id]") : null;
      if (!holder) return null;
      // 必须在某个编辑器的 wysiwyg 里，才算「正文块」
      const inWysiwyg = holder.closest ? holder.closest(".protyle-wysiwyg") : null;
      if (!inWysiwyg) return null;
      return holder;
    } catch { return null; }
  }

  /* =====================================================================
   * 任务⑫：从系统拖文件/文件夹到「文件树边框内」上传
   *
   * 用户原话：「支持在文件树边框内，拖拽文件或者文件夹进行上传至网盘。」
   *
   * 设计要点（每条都对应一个会踩的坑）
   * ---------------------------------------------------------------------
   * ① 与上面那个 bindDragDrop **方向相反**，所以不能共用一套判定。
   *    上面那个是「树 → 正文」，靠自定义 MIME `x-nebuladisk-embed` 识别，
   *    监听挂 document；这里是「系统 → 树」，识别依据是
   *    `dataTransfer.types` 里有没有 `Files`，监听只挂树容器。
   *    ⇒ 两者互不干扰的前提是：**各自都要把自己不认的拖拽放过去**。
   *    实测过的坏情况：两边都无脑 preventDefault，结果拖系统文件到树上，
   *    树去插嵌入块（因为 `this._dragging` 恰好没清），行为完全错乱。
   *
   * ② **必须挂 `dragover` 且 `preventDefault()`，否则永远不触发 `drop`。**
   *    HTML5 DnD 的硬规矩。漏了它的现象是「松手后毫无反应、控制台一条日志都没有」。
   *
   * ③ **落点目录的判定用 `closest`，不是 `elementFromPoint`。**
   *    拖到树上时，鼠标可能落在行内的图标/文字上，`elementFromPoint` 拿到的是
   *    那个小元素；往上找最近的 `.nb-node-wrap` 更稳。
   *    落点若是**目录**⇒传到该目录里；若是**文件**⇒传到它所在目录；
   *    落在树的**空白处** ⇒ 传根目录 `""`。
   *
   *    ⚠️ 这里**没有** `this.currentPath` 这种东西 —— 实测这份组件根本没有
   *       "当前目录"这个状态（它是整棵树，不是一层层进入的浏览器）。
   *       第一版我凭印象写了 `this.currentPath || ""`，它永远是 `undefined`，
   *       靠 `|| ""` 才没炸；但那是在掩盖一个不存在的前提，已删掉。
   *
   * ④ **目录递归要用 `webkitGetAsEntry()`，不能用 `dataTransfer.files`。**
   *    这是最容易漏的一条：拖一个文件夹进来时，`dataTransfer.files` 里
   *    **只有文件夹本身，一个子文件都没有**（而且各家浏览器行为还不一致）。
   *    要拿到里面的文件必须用 `Item.webkitGetAsEntry()` 得到 `FileSystemEntry`
   *    再自己 `createReader().readEntries()` 递归。
   *    ⚠️ `webkitGetAsEntry()` 会"消耗" item，必须在 `drop` 的**同步**阶段先把
   *       所有 entry 抓出来，异步操作放在抓完之后 —— 否则后面读不到。
   *
   * ⑤ **`readEntries()` 一次最多回 100 条**，必须循环读到返回空数组为止。
   *    这是 FileSystem API 的规范行为，不循环就会静默丢掉第 101 个之后的文件。
   *
   * ⑥ 落点目录**穿透性**：不建中间目录直接传会 404/500。
   *    所以每进一层都先 `mkdir`（目录已存在时后端返回错误，忽略即可）。
   * ================================================================== */
  bindUploadDrop() {
    if (!this._uploadBound) this._uploadBound = true;
    else return;

    /** 这批拖拽是不是「系统文件」——这是唯一的判据 */
    const isFileDrag = (ev) => {
      const dt = ev.dataTransfer;
      if (!dt) return false;
      try {
        // types 在 Safari 下可能是 DOMStringList，统一转数组
        const types = Array.from(dt.types || []);
        return types.indexOf("Files") >= 0;
      } catch { return false; }
    };

    /** 鼠标位置 → 该传到哪个目录。返回值保证是「相对 mount 的目录路径」 */
    const resolveTargetDir = (ev) => {
      try {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const wrap = under && under.closest ? under.closest(".nb-node-wrap") : null;
        if (wrap && wrap._row) {
          const isDir = wrap._row.dataset.isDir === "1";
          const p = wrap._row.dataset.path || "";
          if (isDir) return p;                        // 拖到目录上 ⇒ 进这一层
          return parentOf(p);                         // 拖到文件上 ⇒ 进它所在的目录
        }
      } catch { /* 忽略，落到兜底 */ }
      // 落在树的空白处 ⇒ 根目录。
      //   （这份组件没有"当前目录"状态，见方法头注释 ③）
      return "";
    };

    /** 高亮掉这一个落点行，并只高亮这一个 */
    const highlight = (wrap) => {
      const prev = this._uploadTargetEl;
      if (prev === wrap) return;
      if (prev) prev.classList.remove("nb-drop-dir");
      if (wrap) wrap.classList.add("nb-drop-dir");
      this._uploadTargetEl = wrap || null;
    };
    const clearHighlight = () => highlight(null);

    this._onUploadDragOver = (ev) => {
      // ★ 不是系统文件就完全不干预 ★
      //   这一句是「不影响正文拖拽」的关键：树→正文的拖拽 types 里没有 Files，
      //   所以这里直接放行走人，绝不 preventDefault。
      if (!isFileDrag(ev)) return;
      // ★ 必须 preventDefault，否则不触发 drop ★
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.dataTransfer.dropEffect = "copy"; } catch { /* 只读 */ }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const wrap = under && under.closest ? under.closest(".nb-node-wrap") : null;
      highlight(wrap);
    };

    this._onUploadDragLeave = (ev) => {
      if (!isFileDrag(ev)) return;
      // relatedTarget 为空 = 真的离开了树（进了子元素的不算）
      if (ev.relatedTarget) return;
      clearHighlight();
    };

    this._onUploadDrop = async (ev) => {
      if (!isFileDrag(ev)) return;
      // ★ 到这里一定要拦住：否则浏览器会直接打开/下载这个文件 ★
      ev.preventDefault();
      ev.stopPropagation();

      const dir = resolveTargetDir(ev);
      clearHighlight();

      if (this._uploading) {
        showToast("已有上传在进行中，请稍候");
        return;
      }

      // ★ 必须在同步阶段抓 entry：webkitGetAsEntry() 一旦跨了 await 就取不到 ★
      let entries = [];
      try {
        const items = Array.from(ev.dataTransfer.items || []);
        entries = items
          .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
          .filter(Boolean);
      } catch (e) {
        diag(`[tree] webkitGetAsEntry 失败：${e && e.message}`);
      }

      // 兜底：拿不到 entry 就用扁平文件列表（拖多个平铺文件时够用；
      //       拖文件夹时这里只会拿到文件夹本身，所以只是兜底不是主路径）
      if (!entries.length) {
        const files = Array.from(ev.dataTransfer.files || []);
        if (!files.length) {
          showToast("没有识别到可上传的文件");
          return;
        }
        const tasks = files
          .filter((f) => f.name && f.size >= 0)
          .map((f) => ({ file: f, relDir: "" }));
        await this._runUploadBatch(tasks, dir);
        return;
      }

      this._uploading = true;
      try {
        showToast("正在读取拖入的内容…");
        const tasks = [];
        for (const entry of entries) {
          await collectEntry(entry, "", tasks);
        }
        if (!tasks.length) {
          showToast("拖入的内容里没有文件");
          return;
        }
        await this._runUploadBatch(tasks, dir);
      } catch (e) {
        diag(`[tree] 读取拖入内容失败：${e && e.message}`);
        showToast(`读取拖入内容失败：${e && e.message}`);
      } finally {
        this._uploading = false;
      }
    };

    this.treeEl.addEventListener("dragover", this._onUploadDragOver, true);
    this.treeEl.addEventListener("dragleave", this._onUploadDragLeave, true);
    this.treeEl.addEventListener("drop", this._onUploadDrop, true);
  }

  unbindUploadDrop() {
    if (!this._uploadBound) return;
    this._uploadBound = false;
    if (!this.treeEl) return;
    this.treeEl.removeEventListener("dragover", this._onUploadDragOver, true);
    this.treeEl.removeEventListener("dragleave", this._onUploadDragLeave, true);
    this.treeEl.removeEventListener("drop", this._onUploadDrop, true);
    if (this._uploadTargetEl) {
      this._uploadTargetEl.classList.remove("nb-drop-dir");
      this._uploadTargetEl = null;
    }
  }

  /**
   * 真正干活的：先把需要的目录建出来，再逐个传文件。
   *
   * ★ 为什么"先建全部目录、再传文件"而不是边传边建 ★
   *   拖进来的可能是 `a/b/c.png` 这种嵌套结构，同一个中间目录会被多次用到。
   *   边传边建就要求每次都判断"是不是已经建过"，逻辑分散且容易重复请求。
   *   一次性去重后先建完，后面传文件就是纯粹的顺序上传，心智负担小得多。
   *
   * @param {Array<{file: File, relDir: string}>} tasks  relDir 是相对落点目录的子目录
   * @param {string} baseDir 落点目录（相对 mount 的路径）
   */
  async _runUploadBatch(tasks, baseDir) {
    const total = tasks.length;

    // ── ① 收集需要创建的目录（含中间层），去重 ────────────────────────
    const dirs = new Set();
    for (const t of tasks) {
      if (!t.relDir) continue;
      const parts = String(t.relDir).split("/").filter(Boolean);
      let acc = "";
      for (const seg of parts) {
        acc = acc ? acc + "/" + seg : seg;
        dirs.add(acc);
      }
    }

    // 建目录：已存在时后端会报错，直接吞掉（这是**正常情况**，不是失败）
    //
    // ★ 必须逐级建 ★
    //   拖进来 `图纸/2024/a.step` 时，`图纸` 和 `图纸/2024` **都要存在**，
    //   少一层上传就会失败。所以按 "从浅到深" 的顺序逐级 mkdir。
    //   （之前写了两趟，第一趟只建第一段，是多余且容易看错的，已合并成一趟。）
    if (dirs.size) {
      const ordered = Array.from(dirs).sort(
        (a, b) => a.split("/").length - b.split("/").length,
      );
      let done = 0;
      for (const d of ordered) {
        done++;
        showToast(`准备目录 ${done}/${ordered.length}：${d}`);
        let parent = baseDir;
        for (const seg of d.split("/")) {
          try { await API.mkdir(this.currentMount, parent, seg); } catch { /* 已存在 */ }
          parent = parent ? parent + "/" + seg : seg;
        }
      }
    }

    // ── ② 逐个上传 ───────────────────────────────────────────────────
    let ok = 0;
    const failed = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const label = `上传 ${i + 1}/${total}：${t.file.name}`;
      // 目标目录 = 落点目录 + 该文件所属子目录
      const targetDir = t.relDir
        ? (baseDir ? baseDir + "/" + t.relDir : t.relDir)
        : baseDir;
      try {
        await API.upload(
          { mount: this.currentMount, path: targetDir },
          t.file,
          (ratio) => {
            const pct = Math.round((ratio || 0) * 100);
            if (pct % 20 === 0) showToast(`${label} ${pct}%`);
          },
        );
        ok++;
      } catch (e) {
        failed.push(`${t.file.name}（${(e && e.message) || "未知"}）`);
        diag(`[tree] 上传失败 ${t.relDir}/${t.file.name}：${e && e.message}`);
      }
    }

    // ── ③ 汇报 + 刷新落点目录 ─────────────────────────────────────────
    if (failed.length) {
      showToast(`上传完成：成功 ${ok}/${total}，失败 ${failed.length} 个`);
      diag(`[tree] 上传失败清单：\n` + failed.join("\n"));
    } else {
      showToast(`上传完成：${ok} 个文件`);
    }
    await this.reloadDir(baseDir);
  }

  /* =====================================================================
   * 渲染
   * ================================================================== */
  render() {
    if (this.destroyed) return;
    this.el.innerHTML = "";
    this.el.classList.add("nb-tree");

    // ---- 顶部工具条 ----
    const bar = document.createElement("div");
    bar.className = "nb-tree-toolbar";

    this.mountSel = document.createElement("select");
    this.mountSel.className = "b3-select nb-tree-mount";
    this.mountSel.title = "切换盘符";
    this.mountSel.onchange = () => {
      this.currentMount = this.mountSel.value;
      this.expanded.clear();
      // ★ 2026-09-28：这里原有「切换盘符时退出网格视图」的一段重置逻辑，
      //   网格模式已整体移除（用户要求），故一并删除。
      this.clearResults();
      this.loadRoot();
    };
    bar.appendChild(this.mountSel);

    // ★★★ 会打开菜单的按钮必须带 data-menu="true" ★★★
    //
    // 【2026-09-28 实测定案 —— 这就是「点更多什么都不显示」的**根因**】
    //
    //   bundle 里思源的全局「点击外部关闭菜单」处理器（common.js 模块 6987）：
    //     const a = y => {
    //       !window.siyuan.menus.menu.element.contains(y)
    //       && !Th(y, "data-menu", "true")          // ← 关键判定
    //       && ( … || window.siyuan.menus.menu.remove() )   // ← 关掉菜单
    //     }
    //     const b = y => { …; a(y.target); … }      // 全局 click 处理器
    //
    //   菜单是**复用的单例元素**（`window.siyuan.menus.menu`，
    //   实测其 element 就是 DOM 里那个 `b3-menu fn__none`）。
    //   我们点按钮时：onclick 先跑 ⇒ open()→popup() 把菜单项装进单例并显示；
    //   **随后同一个 click 事件继续冒泡到 document** ⇒ 思源的 a() 判定
    //   「目标不在菜单内，且没有 data-menu=true」⇒ 立刻 remove()。
    //   而 remove() → removeImmediately() 做的事正是
    //     `element.lastElementChild.innerHTML = ""` + `classList.add("fn__none")`
    //   —— 与 MutationObserver 实测到的现象**逐条吻合**：
    //     +21ms 内 `added b3-menu__item ×6 + b3-menu__separator ×2`
    //     → `childList-in b3-menu__items {added:0, removed:8}`
    //     → `attr:class b3-menu fn__none`
    //   ⇒ 菜单「开了一下就被同一击关掉」，用户看到的就是「什么都不显示」。
    //
    //   ★ 这条**就是唯一根因**。早前一度以为还有「第一层：Menu 没有 open()」
    //     ——那个判断**是错的**（见文件顶部长注释：那是内部类的性质，
    //     插件 API 的包装类是有 open 的），已改正。别再去"修"那个不存在的问题。
    //
    //   ★ 独立菜单自带这个标记（反证共享单例没有）★
    //     包装类构造里，只有 `isStandalone = true` 分支克隆元素时才显式
    //     `h.setAttribute("data-menu", "true")`；复用共享单例时不加。
    //     所以用单例弹菜单的元素，**必须自己把标记打在触发按钮上**。
    //
    //   思源自身的同类按钮就是这么标的（common.js 原文）：
    //     <span data-type="more" data-menu="true" class="block__icon ariaLabel"
    //           aria-label="更多"><svg><use xlink:href="#iconMore"></use></svg>
    //
    //   ⇒ 凡 handler 里会弹菜单的按钮，一律加 `data-menu="true"`。
    const mkBtn = (icon, title, handler, opensMenu) => {
      const b = document.createElement("button");
      b.className = "b3-tooltips b3-tooltips__s nb-tree-btn";
      b.setAttribute("aria-label", title);
      // ★ 弹菜单的按钮必须打这个标记，否则菜单会被思源的全局 click 处理器秒关
      if (opensMenu) b.setAttribute("data-menu", "true");
      b.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
      b.onclick = (ev) => {
        handler(ev);
        // ★ 弹了菜单就顺手把自身 tooltip 压住 —— 否则「更多」会一直浮在菜单上
        //   （原因见 suppressTooltipWhileMenuOpen 的长注释）
        if (opensMenu) suppressTooltipWhileMenuOpen(b);
      };
      return b;
    };
    // ★ 工具条「刷新」= 普通刷新，**保留展开状态** ★
    //   这里原本是 `this.refresh(true)`（会 clear 掉 expanded ⇒ 刷新后整棵树收起），
    //   与 README 承诺的「展开状态会记住，刷新后回到原处」相反 —— 长期笔误。
    //   2026-09-28：随「刷新并重置展开状态」菜单项的删除，deep 能力整体移除，
    //   本按钮改为 this.refresh()。详见 refresh() 的注释。
    bar.appendChild(mkBtn("iconRefresh", "刷新", () => this.refresh()));
    bar.appendChild(mkBtn("iconSearch", "搜索（全盘，含未加载的子目录）", () => this.toggleFilter()));

    // ★ 2026-09-28：网格 / 列表视图切换按钮已删除（用户要求）★
    //
    //   用户原话：「去掉文件夹 网格视图方式，同时去掉这个按钮。」
    //
    //   连带删除的东西（全部核对过，无残留引用）：
    //     · 本文件：gridMode / gridBtn / toggleGrid() / renderGrid() /
    //       makeGridCell()、loadRoot() 里的 is-grid 类移除
    //     · src/icons.js：iconNbGrid / iconNbList 两个 <symbol>
    //     · index.css：.nb-tree-body.is-grid / .nb-grid-nav / .nb-grid-up /
    //       .nb-grid-crumb / .nb-grid / .nb-cell* 全部样式
    //
    //   ⚠️ 唯一值得担心的连带影响 —— **搜索结果双击目录**：
    //     它的落点是 _jumpToDir() → revealPath()，而 revealPath 走的是
    //     **树展开**路线（loadRoot + this.expanded 逐级登记 + 找 DOM 高亮），
    //     **完全不依赖 gridMode**。所以删掉网格后双击目录照常工作。
    //     （这一条是逐个函数读过来确认的，不是推测。）

    // 「更多」按钮：handler 里会弹菜单 ⇒ 必须 opensMenu=true（见上方长注释）
    bar.appendChild(mkBtn("iconMore", "更多", (ev) => this.showMoreMenu(ev), true));
    this.el.appendChild(bar);

    // ---- 搜索框（默认隐藏）----
    //   ★ 任务㉑：从「前端过滤已加载节点」升级为「后端递归搜索」★
    //     用户原话：「搜索需要对所有文档进行搜索，包含之前没有加载的。」
    //     所以这里的输入会去调 GET /api/search（后端递归遍历），
    //     结果渲染到一个独立的结果面板里，而不是去 display:none 现有节点。
    this.filterWrap = document.createElement("div");
    this.filterWrap.className = "nb-tree-filter";
    this.filterWrap.style.display = "none";
    this.filterInput = document.createElement("input");
    this.filterInput.className = "b3-text-field fn__block";
    this.filterInput.placeholder = "搜索全部文件（含未展开的子目录），支持 pdf、*.png、zip,rar";
    this.filterInput.title =
      "递归搜索整个盘（不只是已展开的部分）。\n" +
      "支持扩展名；*.png 通配；逗号/空格分隔多个（任一命中即显示）。";
    let timer = null;
    this.filterInput.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // ★ 保留原始串（含 * 、逗号），由后端 _search_terms 统一解析
        this.filter = this.filterInput.value.trim();
        this.applyFilter();
      }, 300);
    };
    this.filterInput.onkeydown = (ev) => {
      // Esc 收起搜索并清空（和原生过滤框的习惯一致）
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.toggleFilter();
      }
    };
    this.filterWrap.appendChild(this.filterInput);
    this.el.appendChild(this.filterWrap);

    // ---- 搜索结果面板（任务㉑）----
    //   为什么要独立面板而不是复用树：
    //     搜索结果里的条目来自**任意层级**，把它们硬塞进树会破坏
    //     树的结构不变量（父节点没加载、展开状态错乱）。
    //     结果面板是"扁平列表 + 完整路径"，点一下就直接打开，
    //     更符合"搜索 → 找到 → 打开"的用法。
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "nb-tree-results";
    this.resultsEl.style.display = "none";
    this.el.appendChild(this.resultsEl);

    // ---- 状态条（代理/会话异常时显示）----
    this.banner = document.createElement("div");
    this.banner.className = "nb-tree-banner";
    this.banner.style.display = "none";
    this.el.appendChild(this.banner);

    // ---- 树主体 ----
    this.treeEl = document.createElement("div");
    this.treeEl.className = "nb-tree-body fn__flex-1";
    this.el.appendChild(this.treeEl);

    // ★ 任务⑫：到这里 treeEl 才存在，上传监听必须挂在此处（不是构造函数）★
    //   bindUploadDrop 内部有 `_uploadBound` 幂等判断，render() 被重复调用
    //   也不会叠加监听器。
    this.bindUploadDrop();

    this.treeEl.innerHTML = `<div class="nb-tree-empty">加载中…</div>`;

    // ★ 只在首次渲染时引导 ★
    //   render() 会被重复调用（思源恢复布局、插件复用实例重绘等）。
    //   每次都 bootstrap 的话，同一个盘根会被反复请求（实测同一秒内
    //   几十次 GET /api/list?path=/ ），既浪费又刷日志。
    //   已经引导过就直接复用已有内容，不再重新拉数据。
    if (this._booted) {
      if (this.mounts && this.mounts.length) {
        this.treeEl.innerHTML = "";
        this.loadRoot();
      } else {
        this.bootstrap();
      }
      return;
    }
    this._booted = true;
    this.bootstrap();
  }

  onResize() { /* 原生滚动容器，无需处理 */ }

  destroy() {
    this.destroyed = true;
    // ★ 拖拽监听挂在 document 上，必须显式摘掉 ★
    //   否则每次面板重建都会叠加一组监听器：拖一次文件会插入 N 个块
    //   （N = 面板被重建过几次）。这类泄漏在「打开/关闭侧边栏」反复操作后
    //   才发作，非常难查，所以创建与销毁必须成对。
    this.unbindDragDrop();
    // ★ 任务⑫ 的上传监听也要成对摘掉（理由同上）★
    this.unbindUploadDrop();
    this.mountSel = null;
    this.treeEl = null;
  }

  /* =====================================================================
   * 引导
   * ================================================================== */
  async bootstrap() {
    // ★ 重入保护 ★
    //   render() 可能被连续调用（思源反复 init dock、用户连点刷新）。
    //   没有这道闸时，多个 bootstrap 会并行跑，各自都去 loadMounts →
    //   loadRoot → GET /api/list，请求数翻倍累积（实测刷出过 1600+ 次）。
    //   这里用一个自增 token 保证「只有最后一次调用的结果算数」，
    //   并且同时只允许一个在飞。
    if (this._bootstrapping) {
      this._bootQueued = true;
      return;
    }
    this._bootstrapping = true;
    try {
      // ★ 通道就绪判定必须分通道看 ★
      //   代理通道：代理是异步启动的，要给它时间（旧版只等这一条）。
      //   直连通道：根本不需要代理 —— 只要配了 serverUrl 就能直接开跑。
      //   早先这里无条件等 `boot.status.ok`，而 boot 是「代理启动进度」，
      //   于是配了可直连的地址、但代理因为端口占用起不来时，
      //   面板会一直卡在「通道未就绪」——明明网络是通的。
      if (!this.plugin.canSkipProxy || !this.plugin.canSkipProxy()) {
        for (let i = 0; i < 20; i++) {
          const st = this.plugin.boot ? this.plugin.boot.status : { ok: false };
          if (st.ok) break;
          if (i === 19) {
            // 代理没起来，但可能仍能直连 —— 交给 ensureLogin 去试，
            // 只有在它也确实失败时才提示用户。
            diag(`[tree] 代理未就绪（${st.detail}），改用直连通道尝试`);
            break;
          }
          await sleep(400);
          if (this.destroyed) return;
        }
      }

      // 确保登录
      const ok = await this.plugin.ensureLogin();
      if (this.destroyed) return;
      if (!ok) {
        this.renderLoginPrompt();
        return;
      }
      await this.loadMounts();
    } catch (e) {
      // ★ 兜底：以前这里没有 catch ★
      //   任何未捕获异常都会让面板永远停在「加载中…」，
      //   而错误只出现在控制台（用户看不到）。现在至少给个可见的原因。
      if (!this.destroyed) {
        diag(`[tree] bootstrap 异常：${e && e.message}`);
        this.treeEl.innerHTML = `<div class="nb-tree-empty">加载失败：${escapeHtml(
          (e && e.message) || String(e)
        )}</div>`;
        this.showBanner(`加载失败：${(e && e.message) || e}`, "warn", () => this.plugin.openSetting());
      }
    } finally {
      this._bootstrapping = false;
      if (this._bootQueued) {
        this._bootQueued = false;
        // 期间有新的请求进来 —— 只补跑一次，不叠加
        if (!this.destroyed) this.bootstrap();
      }
    }
  }

  renderLoginPrompt() {
    this.treeEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = "nb-tree-login";
    box.innerHTML = `
      <div class="nb-tree-login-title">尚未登录 NebulaDisk</div>
      <div class="nb-tree-login-desc">请填写账号后登录，或直接在设置里配置自动登录。</div>`;
    const user = document.createElement("input");
    user.className = "b3-text-field fn__block";
    user.placeholder = "用户名";
    user.value = this.plugin.settings.username || "";
    const pass = document.createElement("input");
    pass.className = "b3-text-field fn__block";
    pass.type = "password";
    pass.placeholder = "密码";
    const btn = document.createElement("button");
    btn.className = "b3-button b3-button--text fn__block";
    btn.textContent = "登录";
    btn.onclick = async () => {
      const u = user.value.trim();
      const p = pass.value;
      // 空凭据直接本地拦下 —— 后端会回 422，提示信息不友好
      if (!u || !p) {
        this.showBanner("请填写用户名和密码", "warn");
        return;
      }
      btn.disabled = true;
      btn.textContent = "登录中…";
      try {
        await API.login(u, p);
        this.plugin.settings.username = u;
        this.plugin.settings.password = p;
        await this.plugin.saveSettings();
        this.treeEl.innerHTML = `<div class="nb-tree-empty">加载中…</div>`;
        await this.loadMounts();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "登录";
        this.showBanner(`登录失败：${e.message}`, "warn");
      }
    };
    pass.onkeydown = (e) => { if (e.key === "Enter") btn.click(); };

    const cfg = document.createElement("button");
    cfg.className = "b3-button b3-button--outline fn__block";
    cfg.textContent = "打开设置";
    cfg.onclick = () => this.plugin.openSetting();

    box.appendChild(user);
    box.appendChild(pass);
    box.appendChild(btn);
    box.appendChild(cfg);
    this.treeEl.appendChild(box);
  }

  async loadMounts() {
    try {
      const me = await API.me();
      this.mounts = me.mounts || [];
      this.ooEnabled = !!me.onlyoffice;
      this.cadEnabled = !!me.cad;
      this.sessionOk = true;
      this.hideBanner();
    } catch (e) {
      if (e.status === 401) {
        this.sessionOk = false;
        this.renderLoginPrompt();
        return;
      }
      this.showBanner(`无法读取网盘信息：${e.message}`, "warn", () => this.bootstrap());
      this.treeEl.innerHTML = `<div class="nb-tree-empty">读取失败</div>`;
      return;
    }

    this.mountSel.innerHTML = "";
    if (!this.mounts.length) {
      this.treeEl.innerHTML = `<div class="nb-tree-empty">没有可访问的网盘目录</div>`;
      return;
    }
    for (const m of this.mounts) {
      const o = document.createElement("option");
      o.value = m.label;
      o.textContent = m.label + (m.writable ? "" : "（只读）");
      this.mountSel.appendChild(o);
    }

    const prefer = this.plugin.settings.defaultMount;
    this.currentMount = this.mounts.some((m) => m.label === prefer)
      ? prefer
      : this.mounts[0].label;
    this.mountSel.value = this.currentMount;

    await this.loadRoot();
  }

  async loadRoot() {
    const token = ++this._renderToken;
    // 每轮重新渲染都把「展开调用计数」归零，避免累计误触发上限
    this._expandSeq = 0;
    // ★ 2026-09-28：这里原有「树视图渲染前先摘掉 .is-grid 类」的一段
    //   （网格模式会把 .nb-tree-body 变成 CSS Grid，需在渲染树前还原）。
    //   网格模式已整体移除，该还原动作随之删除。
    //   ⚠️ style.display="" 这一句**必须保留** —— 它不只是给网格用的：
    //     搜索结果面板打开时会把 treeEl 设成 display:none（见 renderResults），
    //     回到树视图时正靠这一句把 display 复位。删了会导致树"回来但看不见"。
    if (this.treeEl) {
      this.treeEl.style.display = "";
    }
    this.treeEl.innerHTML = "";

    // ★★★ 需求4（2026-09-26）：不再显示「盘根」那一行 ★★★
    //
    //   用户原话：「网盘文件树上面选择对应的盘符，下面就不要显示根目录了。」
    //
    //   真机截图确认了要删的是哪一行：
    //     ┌─ 顶部下拉框：售前项目        ← 盘符选择器（保留）
    //     ├─ 📁 售前项目  ▾            ← ★ 就是这一行，与上一行完全重复
    //     │   ├─ 📁 0000解密文件
    //     │   └─ …
    //
    //   ⇒ 做法：把**根目录的内容直接铺到树的顶层**，不再先造一个
    //     `isMountRoot` 的行再展开它。
    //
    //   ⚠️ 这里刻意**不再调用 expandNode(root)**，而是复用同一个
    //     `loadChildrenInto(box, {isMountRoot:true, path:""}, depth)`。
    //     理由：expandNode 的职责是「给某个**已存在的行**加载并挂子节点」，
    //     它需要 wrap._row 来加 is-expanded、也需要一个 wrap 来承接
    //     _loaded/_loading 状态。既然那一行已经不存在，就没有 wrap 可给；
    //     硬造一个「隐藏的 wrap」会让 restoreExpanded / 折叠逻辑里
    //     到处都要判断"这个 wrap 是不是隐形的"，那是给未来埋雷。
    //     ⇒ 抽一个纯加载函数，两处共用，语义各自清晰。
    //
    //   ★ 展开状态 key 保持一致 ★
    //     过去盘根节点的 key 是 nodeKey(mount, "") ⇒ `mount::/`。
    //     现在这层"内容"仍然登记在同一个 key 下，所以：
    //       · 收起的语义变成「整棵树的顶层目录」⇒ 顶层目录就是第一层
    //       · this.expanded 里的历史数据不用迁移（revealPath 依然先 add 它）
    //     唯一区别：没有那一行可以点，所以"折叠盘根"这个操作自然消失了
    //     （这正合用户意图 —— 那一行本来就不该存在）。
    // ★ 注意：this._renderToken 的并发保护由调用方 loadRoot 负责，
    //   这里只管把这一层的内容渲染出来。
    await this.loadChildrenInto(this.treeEl, {
      isMountRoot: true,
      isDir: true,
      path: "",
      name: this.currentMount,
    }, -1);
    if (token !== this._renderToken) return;

    // 恢复上次展开过的目录（迭代实现，见 restoreExpanded）
    //   ★ 需求4 之后恢复的入口从「盘根 wrap」变成 treeEl 本身 ——
    //     restoreExpanded 只用了 rootWrap._children 来取第一层子节点，
    //     所以传 treeEl（它本身就是子节点的容器）语义完全等价。
    if (this.expanded.size) {
      await this.restoreExpanded(this.treeEl);
    }
    if (token !== this._renderToken) return;
  }

  /**
   * ★★★ 需求4（2026-09-26）新抽出的纯加载函数 ★★★
   *
   * 把「某个目录（或盘根）的子条目渲染进 box」这件事从 expandNode 里
   * 拆出来，让 loadRoot（无盘根行）和 expandNode（有行）两条路径共用。
   *
   * ## depth 的语义
   *   · expandNode 调用时传 `wrap._depth` ⇒ 子节点 depth = _depth + 1
   *   · loadRoot 调用时传 **-1** ⇒ 子节点 depth = 0（顶层）
   *   盘根没有可见的行，所以它的"层级"要算在 0 之下，用 -1 表示。
   *
   * ## 为什么必须由这里拼 path
   *   后端 /api/list 的每条 entry **只有**
   *     { name, isDir, size, mtime, ext, route, mime, readonly }
   *   —— 没有 path 字段（只有响应顶层带 path，即本次请求的目录）。
   *   直接用 e 会让每个子节点 entry.path === undefined ⇒ canExpand()
   *   拒绝（子文件夹点不开）、activateFile() 抛「缺少文件路径参数」。
   *   ⇒ 用「响应顶层 path（父目录）」+ entry.name 自己合成。
   *
   * @param {HTMLElement} box   子节点的挂载容器（treeEl 或某个 .nb-children）
   * @param {object} dirEntry   目录条目（支持 isMountRoot 标记）
   * @param {number} parentDepth 父层 depth（盘根传 -1）
   * @returns {Promise<{ok:boolean, wrap?:object}>} ok=false 表示加载失败/被拒
   */
  async loadChildrenInto(box, dirEntry, parentDepth) {
    const entry = dirEntry;
    // ★ 闸门复用 canExpand 的判据，不另写一套 ★
    if (!entry || entry.isDir !== true) return { ok: false };
    if (entry.isMountRoot !== true) {
      if (!(typeof entry.path === "string" && entry.path.length > 0)) {
        return { ok: false };
      }
    }
    const childDepth = parentDepth + 1;

    let data;
    try {
      data = await API.list(this.currentMount, entry.isMountRoot ? "" : entry.path);
    } catch (e) {
      box.innerHTML = `<div class="nb-node-err" style="padding-left:${
        6 + childDepth * 14 + 18
      }px">${escapeHtml(e.message)}</div>`;
      return { ok: false };
    }
    if (this.destroyed) return { ok: false };
    if (box !== this.treeEl) box.innerHTML = "";

    const entries = (data && data.entries) || [];
    if (!entries.length) {
      // 盘根为空时给出更明确的文案（顶层空树看着像坏了）
      box.innerHTML = `<div class="nb-node-empty" style="padding-left:${
        6 + childDepth * 14 + 18
      }px">${entry.isMountRoot ? "（这个盘里没有任何文件）" : "（空）"}</div>`;
      return { ok: true };
    }

    // 统一成「不以 / 结尾」，根目录归一成 ""
    const parentFromData =
      typeof data.path === "string" && data.path ? data.path : null;
    const parentRaw =
      parentFromData !== null
        ? parentFromData
        : entry.isMountRoot
        ? ""
        : typeof entry.path === "string"
        ? entry.path
        : "";
    const parent =
      parentRaw.replace(/\/+$/, "") === "" || parentRaw === "/"
        ? ""
        : parentRaw.replace(/\/+$/, "");

    for (const e of entries) {
      if (!e || typeof e.name !== "string" || !e.name) continue;
      const child = this.makeNode(
        Object.assign({}, e, { path: parent + "/" + e.name }),
        childDepth
      );
      box.appendChild(child);
    }
    return { ok: true, mount: data.mount };
  }

  /* =====================================================================
   * 节点
   * ================================================================== */

  /**
   * ★ 任务30：把任意一个 DOM 元素接上「拖进笔记正文 ⇒ 插入网盘嵌入块」的能力。
   *
   * 为什么要有这个方法
   * --------------------------------------------------------------------
   * 这套 DnD 接线原先只硬编码在 makeNode() 里。于是：
   *   · 文件树的行   → 能拖（因为只有它有这段代码）
   *   · 搜索结果的行 → **拖不动**（用户报的就是这个）
   *   · 网格的格子   → **拖不动**
   * 三处语义完全一样（都是「把 mount:path 塞进 dataTransfer」），
   * 复制三份必然漂移，所以抽成唯一实现，三处都调它。
   *
   * ★ 与 makeNode 里原来那段是**逐字等价**的 —— 搬家，不是重写。
   *   搬家后立刻用测试锁住（test/verify-drag-insert.cjs），
   *   断言「三处都接上了」而不是「至少一处接上了」。
   *
   * @param {HTMLElement} el    要变可拖的元素（行 / 格子）
   * @param {{name:string,isDir:boolean,path:string}} entry 条目信息
   */
  attachEmbedDrag(el, entry) {
    if (!el) return;

    // ★★★ #55：文件夹不再支持「拖拽插入文档」★★★
    //   用户原话：「拖拽插入 网盘嵌入块 取消 文件夹的支持。」
    //
    //   为什么必须在这里拦，而不是在 drop 端拦：
    //     · 只是 drop 端拒绝 ⇒ 用户仍能把文件夹"拖起来"（看到拖影、看到落点高亮），
    //       松手才被无声拒绝 ⇒ 体验比不能拖更差。
    //     · 拖不起来 ⇒ 从源头就没有误导。
    //   所以在**源头**就不给文件夹开 draggable，也不接任何 DnD 回调。
    //
    //   ⚠️ 关键：这**不会**影响任务⑫「从系统拖文件/文件夹到树里上传」。
    //      那条链路是**反方向**的（系统 → 树），判据是 dataTransfer.types 里的
    //      "Files"，落点靠 dataset.isDir / dataset.path，与 el.draggable 无关
    //      （见 bindUploadDrop 的注释 ①）。两者互不依赖，改这里不会碰坏它。
    if (entry && entry.isDir) {
      el.draggable = false;
      el.ondragstart = null;
      el.ondragend = null;
      return el;
    }

    const payloadFor = () => ({
      kind: "file",
      mount: this.currentMount,
      path: entry.path,
      name: entry.name,
      isDir: false,
    });

    // ⚠️ 实测坑：必须 setData 至少一种类型，否则部分浏览器直接不触发 dragstart。
    el.draggable = true;
    el.ondragstart = (ev) => {
      const payload = payloadFor();
      try {
        ev.dataTransfer.effectAllowed = "copy";
        ev.dataTransfer.setData("application/x-nebuladisk-embed",
                                JSON.stringify(payload));
        // 保底：纯文本形式，落点不支持自定义 MIME 时也能落下点东西
        ev.dataTransfer.setData("text/plain", entry.name || entry.path || "");
      } catch (e) {
        diag(`[tree] dragstart setData 失败：${e && e.message}`);
      }
      // 记录来源，便于在 drop 时判断「这是我们自己拖的」
      this._dragging = payload;
      el.classList.add("is-dragging");
      diag(`[tree] 开始拖拽：文件 ${this.currentMount}:${entry.path}`);
    };
    el.ondragend = () => {
      this._dragging = null;
      el.classList.remove("is-dragging");
      // 拖拽结束后清掉所有高亮（drop 可能落在我们监听不到的地方）
      try {
        document.querySelectorAll(".nb-drop-target")
          .forEach((x) => x.classList.remove("nb-drop-target"));
      } catch { /* 忽略 */ }
    };
    return el;
  }

  /**
   * 生成一个节点 DOM
   * @param {{name:string,isDir:boolean,path:string,isMountRoot?:boolean,size?:number,mtime?:number,ext?:string,readonly?:boolean}} entry
   * @param {number} depth
   */
  makeNode(entry, depth) {
    // ★ 兜底：把 path 归一成字符串 ★
    //   后端列表条目不返回 path，正常路径由 expandNode 拼好再传进来。
    //   这里再做一次防御：万一别处（Picker/嵌入块/恢复展开）漏拼了，
    //   至少不会出现 undefined 落进 dataset 和被当成根目录请求的情况。
    if (entry && typeof entry.path !== "string") {
      entry = Object.assign({}, entry, { path: entry.isMountRoot ? "" : "" });
    }
    const key = nodeKey(this.currentMount, entry.path);
    const row = document.createElement("div");
    row.className = "nb-node" + (entry.isDir ? " is-dir" : " is-file");
    row.dataset.key = key;
    row.dataset.path = entry.path;
    row.dataset.name = entry.name;
    row.dataset.isDir = entry.isDir ? "1" : "0";
    row.dataset.depth = String(depth);
    row.style.paddingLeft = `${6 + depth * 14}px`;

    // ★★★ 需求 ④：把文件树里的条目「拖进笔记正文」★★★
    //
    //   ★ 为什么用 HTML5 DnD 而不是自定义鼠标事件 ★
    //     思源正文只是个 contenteditable，**不认**自定义拖拽协议；
    //     而 HTML5 DnD 的 drop 事件会带 clientX/clientY，能算出落点在哪个块，
    //     这正是「拖到哪儿就插到哪儿」需要的。
    //
    //   ★ 为什么必须同时写 text/plain 和自定义 MIME ★
    //     · 自定义 MIME（application/x-nebuladisk-*）是**我们自己的握手暗号**：
    //       只有本插件的 drop 处理器会读它，不会误伤用户从别处拖进来的文本。
    //     · text/plain 是**保底**：万一 drop 落在思源原生编辑器上（没有我们的
    //       处理器），用户至少得到一个可读的「网盘路径」，而不是一片死寂。
    //       这是刻意选择的降级行为 —— 无声失败比降级更糟。
    //
    //   ⚠️ 实测坑：必须 setData 至少一种类型，否则部分浏览器直接不触发 dragstart。
    //
    //   ★ 任务30：抽成 attachEmbedDrag()，树节点 / 搜索结果行 / 网格格子 三处共用 ★
    //     用户原话：「搜索结果需要支持拖拽插入文档功能」。
    //     之前这套接线只写在 makeNode 里，所以**搜索结果和网格格子根本拖不动**
    //     （实测 makeResultRow 里 draggable/ondragstart/setData 全为 false）。
    //     复制三份必然漂移，所以抽成一个方法，三处都调它。
    this.attachEmbedDrag(row, entry);

    // 展开箭头
    const arrow = document.createElement("span");
    arrow.className = "nb-node-arrow";
    if (entry.isDir && !entry.isMountRoot) arrow.innerHTML = `<svg><use xlink:href="#iconPlay"></use></svg>`;
    if (entry.isMountRoot) arrow.innerHTML = `<svg><use xlink:href="#iconPlay"></use></svg>`;
    row.appendChild(arrow);

    // 图标
    //   ★ 任务25b：目录也统一交给 icons.js 的 typeIconEl()，
    //     好处是 class 一致（.nb-type-icon--dir，颜色/尺寸只在 CSS 里定义一次），
    //     以后调图标只改一处。
    const ico = document.createElement("span");
    ico.className = "nb-node-icon";
    try {
      ico.appendChild(typeIconEl(entry.isDir ? "" : (entry.ext || extOf(entry.name)), !!entry.isDir));
    } catch {
      // 兜底：图标失败也不能让整行渲染不出来。
      //   ★ 任务29：原来这里 <use #iconNbFolderClosed>，但那个 symbol 已随
      //     「网盘风格图标」改造被移除（文件夹现在是 icons.js 里的内联 svg）。
      //     改用思源内置的 iconFolder —— 它比自定义 id 更稳（一定存在）。
      if (entry.isDir) ico.innerHTML = `<svg><use xlink:href="#iconFolder"></use></svg>`;
    }
    row.appendChild(ico);

    // 名称
    const name = document.createElement("span");
    name.className = "nb-node-name";
    name.textContent = entry.name;
    if (entry.name.length > 34) name.title = entry.name;
    row.appendChild(name);

    // 只读标记
    if (entry.readonly) {
      const ro = document.createElement("span");
      ro.className = "nb-node-ro";
      ro.textContent = "只读";
      row.appendChild(ro);
    }

    // 子容器
    const children = document.createElement("div");
    children.className = "nb-children";
    children.style.display = "none";

    const wrap = document.createElement("div");
    wrap.className = "nb-node-wrap";
    wrap.appendChild(row);
    wrap.appendChild(children);
    wrap._row = row;
    wrap._children = children;
    wrap._entry = entry;
    wrap._depth = depth;
    wrap._loaded = false;
    wrap._loading = false;

    // ---- 事件 ----
    //
    // ★★★ 单击 = 只选中；双击 = 才执行（2026-09-23 按用户要求改）★★★
    //
    //  改动前的行为：
    //    · 单击文件 ⇒ 直接打开预览/编辑页签
    //    · 单击目录 ⇒ 直接展开/收起
    //  用户反馈「需要双击才执行打开，目前是单击就打开了」—— 单击就打开确实太"热"：
    //  侧边栏是拿来浏览的，鼠标一路划过去会误开一堆页签；而且右键菜单/拖拽
    //  也都发生在这些行上，单击即打开会让那些操作更容易误触。
    //
    //  新行为（和桌面文件管理器一致）：
    //    · 单击        ⇒ 仅选中（高亮），不做任何打开动作
    //    · 双击文件    ⇒ 打开页签；双击目录 ⇒ 展开/收起
    //    · 目录前的箭头 ⇒ **保留单击**（它是明确的展开控件，双击会显得迟钝）
    //    · Ctrl/Cmd+单击 ⇒ 后台打开（保留原有便利，不破坏老习惯）
    //
    //  ⚠️ 别把双击再绑回"仅文件"：目录双击必须能展开，
    //     否则习惯双击进目录的用户会觉得树"点不动"。
    const isOpenModifier = (ev) => ev.ctrlKey || ev.metaKey;

    row.onclick = (ev) => {
      if (this._suppressClick) return;
      // ★ 单击不再打开任何东西。带修饰键的单击仍按老习惯后台打开，
      //   这样"一次点开"的快捷路径还在，只是默认动作变安全了。
      if (isOpenModifier(ev)) {
        if (entry.isDir) this.toggleNode(wrap);
        else this.activateFile(entry, true);
      }
      this.selectRow(row);
    };
    row.ondblclick = (ev) => {
      if (this._suppressClick) return;
      ev.stopPropagation();
      if (entry.isDir) {
        this.toggleNode(wrap);
      } else {
        // 双击 = 用户明确要打开 ⇒ 复用已有页签（newTab=false），
        // 避免点两次就开出两个重复页签。
        this.activateFile(entry, false);
      }
      this.selectRow(row);
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      this.selectRow(row);
      this.showNodeMenu(ev, entry);
    };
    // 目录上的箭头单独响应，避免和 click 冲突。
    // ★ 箭头保持**单击**：它是明确的"展开/收起"控件，
    //   强制双击会让展开操作变得别扭（用户已明确指向了那个三角）。
    arrow.onclick = (ev) => {
      ev.stopPropagation();
      if (entry.isDir) this.toggleNode(wrap);
    };

    // 注意：这里**不**设置任何「需要恢复展开」的标记。
    // 恢复展开由 restoreExpanded() 统一按 this.expanded 驱动，
    // 早期在 makeNode 里打标 + 在 expandNode 里递归消费的写法导致过无界递归。

    return wrap;
  }

  selectRow(row) {
    if (this._selected) this._selected.classList.remove("is-selected");
    this._selected = row;
    row.classList.add("is-selected");
  }

  async toggleNode(wrap) {
    if (!wrap || !wrap._row || !wrap._children) return;
    const row = wrap._row;
    const open = wrap._children.style.display !== "none";
    if (open) {
      wrap._children.style.display = "none";
      row.classList.remove("is-expanded");
      this.expanded.delete(this.nodeKeyOf(wrap._entry));
    } else {
      await this.expandNode(wrap);
    }
  }

  /**
   * 校验一个节点是否「可展开的目录」——这是防请求风暴的最后一道闸。
   *
   * 实战踩坑（2026-09-22）：
   *   恢复展开状态时曾经把**文件节点**也当成目录去 expandNode，
   *   而文件节点没有 path（entry.path === undefined），于是
   *   API.list(mount, undefined) 被后端当成根目录 "/"，
   *   返回同一份根列表 → 继续注册更多子节点 → 每秒几十次重复请求。
   *   日志里表现为清一色的 `entries=34 path=/` 刷屏。
   *
   * 因此：isDir 必须显式为 true；盘根节点必须带 isMountRoot 标记；
   * 其余节点必须有一个**非空字符串** path 才允许请求。
   */
  canExpand(entry) {
    if (!entry || entry.isDir !== true) return false;
    if (entry.isMountRoot === true) return true;
    return typeof entry.path === "string" && entry.path.length > 0;
  }

  /** 节点在 this.expanded 里的 key（盘根与根目录统一为 "/"，与 nodeKey 语义一致） */
  nodeKeyOf(entry) {
    const p = entry && typeof entry.path === "string" && entry.path ? entry.path : "/";
    return nodeKey(this.currentMount, p);
  }

  async expandNode(wrap) {
    // ★ 入参校验（必须）★
    //   实测踩过：递归恢复展开状态时，box.children 里混进过非 wrap 节点
    //   （被 await 期间 DOM 被改写产生），于是 entry=undefined，
    //   expandNode 又拿 entry.path 去请求 /api/list → 参数为 undefined，
    //   然后继续向下递归 —— 表现为 18 秒内 1600+ 次请求的「刷新风暴」，
    //   调用栈是 expandNode 自己递归自己。
    if (!wrap || !wrap._entry || !wrap._row || !wrap._children) {
      return;
    }
    const entry = wrap._entry;
    // ★ 只有目录才允许展开 ★（文件/无 path 节点一律拒绝，见 canExpand 注释）
    if (!this.canExpand(entry)) {
      return;
    }
    const row = wrap._row;
    const box = wrap._children;
    const key = this.nodeKeyOf(entry);

    row.classList.add("is-expanded");
    box.style.display = "block";
    this.expanded.add(key);

    // ★ 已展开过 / 正在展开 → 直接复用，绝不重复请求 ★
    //   必须放在「标记 expanded」之后再判断，否则用户点开已缓存目录时
    //   箭头状态和缓存状态会不一致。顺序：先认领状态，再决定是否发请求。
    if (wrap._loaded || wrap._loading) return;
    // ★ 同节点并发保护 ★
    //   expandNode 可能在同一节点上被并发调用（用户连点箭头、
    //   恢复展开与手动展开撞一起）。没有这个标记时，同一个 path
    //   会被同时请求多次。宁可后面那次直接复用，也不要重复打网盘。
    wrap._loading = true;

    // ★ 兜底闸：单次刷新内 expandNode 的总调用次数上限 ★
    //   正常一棵树也就几十个目录；一旦超过 200，几乎一定是某个逻辑失控
    //   （递归没收敛 / 重复触发）。宁可停止加载也不要把网盘打爆。
    this._expandSeq = (this._expandSeq || 0) + 1;
    if (this._expandSeq > 200) {
      if (this._expandSeq === 201) {
        diag(`[tree] expandNode 调用超过 200 次，已停止继续展开（疑似失控）`);
      }
      return;
    }

    box.innerHTML = `<div class="nb-node-loading" style="padding-left:${
      6 + (wrap._depth + 1) * 14 + 18
    }px">加载中…</div>`;

    // ★★★ 需求4（2026-09-26）：加载逻辑已抽到 loadChildrenInto ★★★
    //   抽出原因：loadRoot 现在**不再创建盘根行**（用户要求下面不显示根目录），
    //   所以它拿不到 wrap，没法走 expandNode ⇒ 两条路径必须共用同一段加载代码，
    //   否则「path 拼接 / 错误文案 / 空目录文案」会出现两份，必然漂移。
    //
    //   这里保留 wrap 侧的职责（状态标记、_loaded、_mountInfo），
    //   只把「请求 + 建子节点 DOM」交给 helper。
    const res = await this.loadChildrenInto(box, entry, wrap._depth);
    wrap._loading = false;
    if (this.destroyed) return;
    if (!res.ok) return;
    wrap._loaded = true;
    wrap._mountInfo = res.mount;

    // ★ 这里**不再**递归恢复子节点展开状态 ★
    //   旧写法在此处 `for (child of box.children) await this.expandNode(child)`
    //   ——换来的是一次**无界嵌套递归**：
    //     expandNode(root) → 子目录 expandNode → 孙目录 expandNode → …
    //   而每次递归内部又会重新收集「需要恢复」的子节点，形成自我延续。
    //   实测调用栈是 expandNode 套十几层，最终 entry 变成 undefined，
    //   请求 /api/list 上百次，还停不下来。
    //
    //   现在改成：展开就是展开（只加载这一层），
    //   「刷新后恢复展开状态」由 loadRoot 里一个**有 visited 去重的迭代循环**负责。
    // ★ 任务㉑ 之后这里不再需要「重新过滤」★
    //   旧实现是前端 display:none 过滤：新展开出来的子节点没被过滤过，
    //   所以必须重跑一次 applyFilter()。
    //   现在搜索结果在**独立面板**里（后端递归搜的），与树节点无关，
    //   展开目录不会让结果过时 ⇒ 再调 applyFilter() 只会白发一次网络请求。
    //   （保留注释是为了防止以后有人"顺手补回来"。）
  }

  /**
   * 恢复「上次展开过」的目录（迭代 + visited 去重，绝不再递归）。
   *
   * 做法：从根出发逐层推进 —— 只有当某个目录**真的被展开**时，
   * 才把它返回的子节点排进队列继续看（没展开的分支内部不可能有
   * 已展开的节点，不必往下走）。
   * visited 保证每个节点最多处理一次；expandCount 只统计真实展开次数。
   *
   * ★ 只有目录入队 ★
   *   踩过的坑：曾经把 box.children 里的**所有**节点都入队。
   *   文件节点也被当成待展开对象，而文件没有 path（undefined），
   *   于是 API.list(mount, undefined) 被后端解释成根目录 "/"，
   *   每次都返回同一份根列表，于是又注册出更多文件节点、又入队……
   *   日志里是几十次 `entries=34 path=/` 连刷。
   *   现在文件节点在**入队时**就被过滤掉，且 expandNode 内部还有第二道
   *   canExpand 闸门，双重保险。
   */
  async restoreExpanded(rootWrap) {
    if (!rootWrap) return;
    const visited = new Set();
    const queue = [rootWrap];
    let expandCount = 0;
    while (queue.length) {
      if (this.destroyed) return;
      const wrap = queue.shift();
      if (!wrap || visited.has(wrap)) continue;
      visited.add(wrap);

      // ★★★ 需求4（2026-09-26）：根节点现在可能是**容器**而不是 wrap ★★★
      //   loadRoot 不再造「盘根行」，所以它把 `this.treeEl` 传进来 ——
      //   容器没有 `_entry` / `_children`，只有直接子节点（都是 wrap）。
      //   ⇒ 容器的职责只是「把它下面第一层目录入队」，自己不展开。
      //   过去这里写 `if (!wrap._entry) continue`，那会把整棵树直接放弃恢复。
      if (!wrap._entry) {
        for (const child of Array.from(wrap.children || [])) {
          if (child && child._entry && child._entry.isDir === true) queue.push(child);
        }
        continue;
      }

      if (!this.canExpand(wrap._entry)) continue;

      const key = this.nodeKeyOf(wrap._entry);
      // 盘根本身在 loadRoot 里已经展开过，不再重复处理
      //   ⚠️ 需求4 之后**正常情况下不会再遇到 isMountRoot 的 wrap**
      //      （它不再被创建）。这段保留是为了兼容 / 防御：
      //      万一别处（如测试）仍造了盘根节点，行为与改造前一致。
      if (!wrap._entry.isMountRoot && !this.expanded.has(key)) continue;

      // 硬上限：防御性闸门。正常一棵树几十个目录，上限设 300 足够宽，
      // 真触发了说明有异常逻辑，宁可少展开也不要打爆网盘。
      if (++expandCount > 300) {
        diag("[tree] 恢复展开状态的目录数超过 300，提前结束");
        return;
      }
      await this.expandNode(wrap);

      // ★ 只把「刚展开出来的目录子节点」入队 ★
      //   未展开的分支其内部节点还没被创建，也没有可恢复的对象。
      const box = wrap._children;
      if (box) {
        for (const child of Array.from(box.children)) {
          if (child && child._entry && child._entry.isDir === true) queue.push(child);
        }
      }
    }
  }

  /** 折叠所有已展开节点（简单做法：整树重建） */
  collapseAll() {
    this.expanded.clear();
    this.loadRoot();
  }

  /**
   * 把文件树展开并滚动到 `mount:/path`（任务⑳）。
   *
   * 用户原话：「嵌入文档树到文档这个功能需要调整一下：点击插入后的嵌入块
   *           右侧文档树转跳到这个路径所在位置。」
   *
   * 做法（逐段下钻，而不是整树重建 —— 小目录树才适合重建，网盘可能很深）：
   *   1) 确保树已加载（没挂载过就先 loadMounts）
   *   2) 切到目标 mount（现在树一次只显示一个盘：loadRoot 按 currentMount 取）
   *   3) 把 mount:/各层目录 逐个塞进 this.expanded，再走一次 loadRoot
   *      —— loadRoot → restoreExpanded 会自动把这条路径上的目录全展开
   *      ★ 需求4 之后树顶不再有「盘根行」，但 `mount::/` 这个 key 依然登记着
   *        （loadRoot 把第一层铺到顶层时沿用同一个 key 语义），不需要改。
   *   4) 找到最深那层的节点，scrollIntoView + 高亮 + selectRow
   *
   * ★ 为什么用「塞 expanded + 重载」而不是逐层 await expandNode ★
   *   expandNode 每层都要发一次 /api/list，路径深时会有几十个串行请求，
   *   而且任何一层名字大小写/空格不一致就会中断整条链。
   *   反过来：this.expanded 是"要展开哪些 key"的**声明**，
   *   restoreExpanded 已经做了 300 次上限、visited 去重、只对 isDir 生效，
   *   把意图交给它，一次 loadRoot 就够，且失败也只是"没展开"而非"卡住"。
   *
   * @param {string} mount 挂载点名
   * @param {string} path  目录或文件路径（以 / 开头）；文件会取其父目录
   * @returns {Promise<boolean>} 是否成功定位到
   */
  async revealPath(mount, path) {
    const m = String(mount || "").trim();
    let p = String(path || "").replace(/\\/g, "/");
    if (!m) return false;
    if (p && !p.startsWith("/")) p = "/" + p;
    p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");

    // 目标可能是**文件**：树只能定位到目录，文件靠"在目录里高亮"实现。
    // 这里先把"要展开到哪一层"和"要高亮哪个名字"分开。
    const parts = p.split("/").filter(Boolean);
    const lastName = parts.length ? parts[parts.length - 1] : "";
    const lastIsFile = !!(lastName && /\.[^./\\]+$/.test(lastName));

    const dirParts = lastIsFile ? parts.slice(0, -1) : parts;

    try {
      // 1) 树还没建过 ⇒ 先初始化，否则后面找不到任何节点
      if (!this.treeEl.querySelector(".nb-node-wrap")) {
        await this.loadMounts();
      }
      // 2) 切盘（不同盘 ⇒ 必须重载；同盘也要重载才能吃到新的 expanded）
      const needSwitch = this.currentMount !== m;
      this.currentMount = m;

      // 3) 把「盘根 → 各层目录」的 key 全部登记为"应展开"
      //    nodeKey(mount, path) 的实现是 `${mount}::${path || "/"}`，
      //    所以要展开 key = mount::/a/b，逐级就是 mount::/a → mount::/a/b。
      this.expanded.add(nodeKey(m, ""));
      for (let i = 0; i < dirParts.length; i++) {
        this.expanded.add(nodeKey(m, "/" + dirParts.slice(0, i + 1).join("/")));
      }

      await this.loadRoot();

      // 4) 找到最深那层，滚过去 + 高亮
      await new Promise((r) => setTimeout(r, 60));
      const deepest = dirParts.length ? "/" + dirParts.join("/") : "";
      const wantKey = nodeKey(m, deepest);
      let hit = this.treeEl.querySelector(
        `.nb-node-wrap[data-key="${cssEscape(wantKey)}"]`
      );
      // 退一步：按名字找（key 里含 mount 前缀，偶尔会因归一化差异对不上）
      if (!hit && lastName) {
        const rows = Array.from(this.treeEl.querySelectorAll(".nb-node"));
        const row = rows.find((r) => {
          const w = r.closest(".nb-node-wrap");
          const e = w && w._entry;
          return e && e.name === lastName;
        });
        hit = row ? row.closest(".nb-node-wrap") : null;
      }
      if (!hit) return false;

      const row = hit._row || hit.querySelector(".nb-node");
      if (row) {
        this.selectRow(row);
        try {
          row.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch { row.scrollIntoView(); }
        // 短暂闪一下，让用户看见"跳到这里了"
        row.classList.add("nb-node-flash");
        setTimeout(() => row.classList.remove("nb-node-flash"), 1200);
      }
      return true;
    } catch (e) {
      diag("[tree] revealPath 失败: " + ((e && e.message) || e));
      return false;
    }
  }

  /**
   * 刷新：重新拉取盘符与当前目录。
   *
   * ★ 展开状态**刻意保留**（2026-09-28 定案）★
   *   原签名是 `refresh(deep = false)`，`deep=true` 时 `this.expanded.clear()`
   *   —— 那是给「更多」菜单里那一项「刷新并重置展开状态」用的。
   *   该菜单项已按用户要求删除，**这个「重置展开」能力也一并删掉**
   *   （用户原话：「删除 刷新并重置展开状态 按钮及其功能」），所以这里不再有 deep 参数。
   *
   *   ⚠️ 连带修正了一处长期笔误：工具条那个「刷新」按钮原本调的是
   *      `this.refresh(true)` —— 也就是说**每次点「刷新」，整棵目录树都会全部收起**。
   *      而 README 明确承诺的是「展开状态会记住，刷新后回到原处」
   *      （README.zh_CN.md 第 20 行 / README.md 第 25 行：
   *        "Expansion state is remembered across refreshes"）。
   *      即按钮行为与文档承诺相反。删掉 deep 之后，工具条「刷新」变回
   *      `this.refresh()`，与 README 一致。
   *
   *   顺带清掉的死代码：原来还有
   *      const keep = new Set(this.expanded); this.expanded = keep;
   *   这只是把 Set 复制一份再赋回去 —— 前后完全等价，没有任何作用。
   */
  async refresh() {
    await this.loadMounts();
  }

  /* =====================================================================
   * 打开文件
   * ================================================================== */
  activateFile(entry, newTab = false) {
    const item = {
      mount: this.currentMount,
      path: entry.path,
      name: entry.name,
      ext: entry.ext || extOf(entry.name),
      size: entry.size,
      mtime: entry.mtime,
    };

    if (newTab) {
      this.plugin.openFile(item, { forceNew: true });
      return;
    }
    // 优先复用已存在的查看页签
    const reused = tryReuseViewerTab(this.plugin, item);
    if (!reused) this.plugin.openFile(item, { forceNew: true });
  }

  /* =====================================================================
   * 菜  单
   * ================================================================== */

  /**
   * 算出「打开网盘」应该落到哪。
   * （该菜单项 2026-09-28 前叫「在浏览器中打开网盘」。）
   *
   *   · 有选中行：
   *       文件夹 ⇒ 就是这个目录本身
   *       文件   ⇒ 它的**父目录**（网盘侧没有"高亮某个文件"的能力，
   *                开到它所在的目录已经是当前能做到的最精确落点）
   *   · 没有选中行 ⇒ null（调用方退回首页）
   *
   * ★ 为什么按父目录而不是直接给文件路径 ★
   *   网盘的深链契约是 `Explorer.open(mount, dir)` —— 只接受目录。
   *   直接把文件路径塞进去会让 Explorer 拿到一个不存在的"目录"，
   *   表现为打开一个空窗口。父目录计算与 api.js 的 webDiskUrl() 保持一致。
   */
  _deepLinkTarget() {
    // ★ 注意：this._selected 是 **row**（.nb-node），而 _entry 挂在它的父节点
    //   **wrap**（.nb-node-wrap）上。这里必须往上找一层，别直接读 row._entry。
    const row = this._selected || this.treeEl.querySelector(".nb-node.is-selected");
    if (!row) return null;
    const wrap = row.closest(".nb-node-wrap");
    const entry = (wrap && wrap._entry) || row.__nbEntry;
    if (!entry || !entry.path) return null;
    const mount = this.currentMount || (entry.mount || "");
    if (!mount) return null;
    if (entry.isDir) return { mount, path: entry.path };
    const p = String(entry.path);
    const cut = p.lastIndexOf("/");
    return { mount, path: cut > 0 ? p.slice(0, cut) : "/" };
  }

  showMoreMenu(ev) {
    const menu = new Menu("nbTreeMore");
    menu.addItem({
      icon: "iconRefresh",
      label: "刷新",
      click: () => this.refresh(),
    });

    // ★ 2026-09-28：删除「刷新并重置展开状态」菜单项及其功能 ★
    //
    //   用户原话：「删除 刷新并重置展开状态 按钮及其功能」。
    //
    //   连带删除的东西（全部核对过，无残留引用）：
    //     · 本菜单项本身（原 click 为 this.refresh(true)）
    //     · Tree.refresh() 的 `deep` 形参 —— 以及 `if (deep) this.expanded.clear()`
    //       ⇒ 「重置展开状态」这个能力在插件里**整体不存在了**
    //     · 原实现里那段等价于空操作的死代码
    //       （const keep = new Set(this.expanded); this.expanded = keep;）
    //     · 工具条「刷新」按钮由 this.refresh(true) 改回 this.refresh()
    //       （它原本会清空展开，与 README 承诺相反，见 refresh() 注释）
    //
    //   ⚠️ 连带调用点**共 4 处**，全部已改（踩过一次：只 grep 了 src/ 与 tools/，
    //      漏掉根文件 index.js，于是在注释里错写成「全仓确认过，没有别处调用」；
    //      实际 index.js 里还有 3 处 this.tree.refresh(true)：
    //        ① addCommand("refreshNebulaDisk") 的 callback
    //        ② 设置面板「立即登录」成功后
    //        ③ 保存设置后
    //      教训：**grep 要覆盖 index.js 根文件**，别只扫 src/ 和 tools/。
    //      现在 index.js 里这三处都是 refresh()，K7i2 断言会兜住回退）。
    menu.addSeparator();
    menu.addItem({
      icon: "iconContract",
      label: "全部折叠",
      click: () => this.collapseAll(),
    });
    menu.addItem({
      icon: "iconSettings",
      label: "插件设置",
      click: () => this.plugin.openSetting(),
    });
    menu.addSeparator();
    // 任务⑰：原来这里是 window.open(settings.serverUrl) —— 打开的是**首页**，
    //   新页签没有会话 ⇒ 只会看到登录页（用户报的「还需要输入密码」）。
    //   现在改成「深链」：带上当前展开/选中节点的 mount+path，
    //   网盘前端 app.js 的 applyDeepLink() 会直接打开那个目录。
    //   有选中节点 ⇒ 开到它的父目录（文件）或它自己（文件夹）；
    //   没有选中 ⇒ 退回首页（保持原行为，至少不是坏链接）。
    //
    //   2026-09-28：标签由「在浏览器中打开网盘」改名为「打开网盘」（用户要求）。
    menu.addItem({
      icon: "iconLink",
      label: "打开网盘",
      click: () => {
        const base = this.plugin.settings.serverUrl;
        if (!base) { showToast("请在插件设置中填写网盘地址"); return; }
        const target = this._deepLinkTarget();
        if (!target) { window.open(base, "_blank", "noopener"); return; }
        window.open(webDiskUrl(base, target.mount, target.path), "_blank", "noopener");
      },
    });
    // ★ 2026-09-28：图标 iconLogout → iconQuit ★
    //
    //   用户反馈「退出登录前面增加图标」（= 这一项没有图标）。
    //   实测根因：`iconLogout` 这个 symbol 在思源里**根本不存在**
    //   —— 思源运行时雪碧图共 263–270 个 symbol，同菜单其余 5 项的图标
    //   （iconRefresh / iconContract / iconSettings / iconLink）全部命中，
    //   唯独 iconLogout 命不中（document.getElementById('iconLogout') === null），
    //   于是 <use xlink:href="#iconLogout"> 渲染成空白。
    //   实测方法见 tools/_probe-icon-diag.cjs（在真实页面里逐项报 href 与
    //   symbolExists，而不是靠肉眼看截图）。
    //
    //   换成 iconQuit —— 雪碧图里真实存在，且正是思源自己给「退出」用的名字。
    //   ⚠️ 别再改回 iconLogout；这一类错误的特征是**静默空白**，
    //      不报错、不白屏，只能靠 symbolExists 检查抓出来。
    menu.addItem({
      icon: "iconQuit",
      label: "退出登录",
      click: async () => {
        await API.logout();
        this.expanded.clear();
        this.treeEl.innerHTML = "";
        this.renderLoginPrompt();
      },
    });
    openMenuAt(menu, ev);
  }

  showNodeMenu(ev, entry) {
    const menu = new Menu("nbTreeNode");
    const isDir = entry.isDir;
    const fullPath = (isDir ? entry.path : entry.path);

    if (isDir) {
      menu.addItem({
        icon: "iconAdd",
        label: "新建文件夹",
        click: () => this.promptMkdir(entry.path),
      });
      menu.addSeparator();
    } else {
      menu.addItem({
        icon: "iconEye",
        label: isEditable(entry.name) ? "在线编辑" : "预览",
        click: () => this.activateFile(entry, true),
      });
      menu.addItem({
        icon: "iconDownload",
        label: "下载",
        click: () => this.download(entry),
      });
      // ★ 任务28：右键加「浏览器打开」★
      //   用户原话：「28 右键菜单增加 在浏览器中打开功能 名称为：浏览器打开」
      //
      //   和「在页签中打开」的区别（这两个很容易被混为一谈）：
      //     · 在页签中打开 ⇒ 在**思源内部**开一个 nbViewer 页签，用 iframe 预览。
      //       好处是留在思源里；坏处是某些格式（大 CAD、OO 编辑）受 iframe 限制。
      //     · 浏览器打开   ⇒ 取一条**浏览器可直达**的预览 URL（新窗口），
      //       拿到完整的浏览器能力：缩放、另存、复制地址栏分享、
      //       手机上也能开。用 API.previewUrl()，它内部已过 fixUrl()
      //       把容器内主机名（nebula:8088）换成浏览器可达的地址 ——
      //       这正是用户报过的「复制直链 http://nebula:8088/… 打不开」的根因，
      //       直接拼 raw 链接会重犯这个错。
      //
      //   ⚠️ 目录不提供：目录没有"单文件预览"这回事，
      //      传目录进 /api/preview 会拿到错误页。给目录打开网盘网页版更合理，
      //      但那已经在嵌入块/顶部按钮里有了，右键就不重复塞。
      menu.addItem({
        icon: "iconLink",
        label: "浏览器打开",
        click: () => this.openInBrowser(entry),
      });
      menu.addSeparator();
      menu.addItem({
        icon: "iconNebulaDisk",
        label: "嵌入到文档",
        click: () => this.embedToDoc(entry, "file"),
      });
      menu.addSeparator();
    }

    // ★ 任务27：删掉「复制路径」（用户 2026-09-22）★
    //
    //   原话：「27 复制路径这个功能好像没有什么用，取消，删除」
    //
    //   为什么同意删：
    //     · 路径 `售前项目:/2026年08月/…` 对用户没有可执行价值 ——
    //       粘到浏览器打不开、粘到网盘搜索框也要手工改造，
    //       真正想"分享/留档"用的都是旁边的「复制直链」。
    //     · 它此前还有个实锤 bug：写成 `${mount}:/${entry.path}`，
    //       而 entry.path **本身就以 / 开头**（makeNode 用 parent + "/" + name
    //       拼出来），于是渲染成 `售前项目://托璞勒 宣传册.pdf` —— 多一个斜杠。
    //       用户截图报的就是这个。一个"没什么用 + 还有 bug"的功能，删掉最干净，
    //       而不是修好它继续占菜单位置。
    //
    //   ⇒ 连带删掉了菜单项本身。如果将来要恢复，路径拼接必须写成
    //     `${mount}:${path}`（path 自带前导斜杠），或统一过一遍 normalizePath()。
    menu.addItem({
      icon: "iconLink",
      label: "复制直链",
      click: () => this.copyRawLink(entry),
    });
    menu.addItem({
      icon: "iconEdit",
      label: "重命名",
      click: () => this.promptRename(entry),
    });
    if (isDir) {
      menu.addItem({
        icon: "iconNebulaDisk",
        label: "嵌入到文档",
        click: () => this.embedToDoc(entry, "tree"),
      });
    }
    menu.addSeparator();
    menu.addItem({
      icon: "iconTrashcan",
      label: "删除",
      warning: true,
      click: () => this.confirmDelete(entry),
    });

    openMenuAt(menu, ev);
  }

  /* =====================================================================
   * 操  作
   * ================================================================== */
  promptMkdir(dirPath) {
    const name = prompt("新建文件夹名称：");
    if (!name || !name.trim()) return;
    API.mkdir(this.currentMount, dirPath, name.trim())
      .then(() => this.reloadDir(dirPath))
      .catch((e) => showToast(`创建失败：${e.message}`));
  }

  promptRename(entry) {
    const next = prompt("重命名为：", entry.name);
    if (!next || !next.trim() || next === entry.name) return;
    API.rename(this.currentMount, entry.path, next.trim())
      .then(() => this.reloadDir(parentOf(entry.path)))
      .catch((e) => showToast(`重命名失败：${e.message}`));
  }

  async confirmDelete(entry) {
    const yes = await confirmDialog(
      "删除确认",
      `确定要删除「${entry.name}」吗？` +
      (entry.isDir ? "目录会连同其中所有内容一并删除，" : "") +
      "此操作不可恢复。",
    );
    if (!yes) return;
    API.remove(this.currentMount, entry.path)
      .then(() => this.reloadDir(parentOf(entry.path)))
      .catch((e) => showToast(`删除失败：${e.message}`));
  }

  /**
   * 复制「直链」——带签名的 /api/raw 地址，粘到浏览器/别的设备直接能下。
   *
   * ★ 三个必须过的关（缺一个用户就拿不到能用的链接）：
   *
   *   1) **必须取签名直链，不能自己拼 `/api/raw/<name>?mount=&path=`**。
   *      后端 rawlink 路由是要校验 `exp` + `sig` 的，自己拼出来的是 403。
   *      ⇒ 走 API.signedRawUrl()，它内部问 /api/preview 拿签名。
   *
   *   2) **必须过 browserReachableUrl()**。后端 make_raw_url() 用的是
   *      `_internal_origin()` = NEBULA_BASE_URL，典型值 `http://nebula:8088`
   *      —— 这个主机名只有 docker 网内的 OnlyOffice/kkFileView 能解析。
   *      原样复制给用户，粘到浏览器就是 ERR_NAME_NOT_RESOLVED。
   *      这正是用户反馈过的那条打不开的直链：
   *        http://nebula:8088/api/raw/1.2.14.TFDF-6%23%20F%E5%90%91.STEP?...
   *      signedRawUrl() 已经把 browserReachableUrl 包在里面了，这里不用重复。
   *
   *   3) **目录没有直链**。rawlink 只服务文件；对目录就要明确拒绝，
   *      否则会拿回一个指向目录的 404 链接，用户以为复制成功了。
   */
  async copyRawLink(entry) {
    if (entry.isDir) {
      // ★ 任务27：「复制路径」已按用户要求删除，这里不能再引导用户去用它。
      //   目录本来就没有单文件直链（rawlink 只服务文件），
      //   所以要给一个**存在且真的有用**的替代动作：打开网盘网页版定位到该目录。
      // ★ 2026-09-28：文案里的菜单名同步改名 —— 原写「在浏览器中打开网盘」，
      //   而那一项已按用户要求改名为「打开网盘」。留着旧名会把用户
      //   指向一个**菜单上根本找不到的名字**。
      //   （这条是 K7i6 反向断言在剥注释后抓出来的，不是靠肉眼扫。）
      showToast("文件夹没有直链，请用「打开网盘」");
      return;
    }
    try {
      const url = await API.signedRawUrl(this.currentMount, entry.path);
      if (!url) throw new Error("后端未返回直链");
      copyText(url, "直链已复制");
    } catch (e) {
      showToast(`取直链失败：${e.message}`);
    }
  }

  /**
   * 在**浏览器**里打开这个文件（任务28 → #62 统一）。
   *
   * ★ 和「在页签中打开」不是一回事 ★
   *   在页签中打开 = 在思源里开 nbViewer 页签，靠 iframe 预览。
   *   浏览器打开   = 另开**浏览器窗口**，拿到完整浏览器能力
   *                  （缩放/另存/复制地址栏发给同事/手机上打开）。
   *
   * ★★★ #62：这里原先用 API.previewUrl()（恒走 kkFileView），现在改用
   *     API.browserViewUrl() —— 与 viewer.openInBrowser() **同一套路由** ★★★
   *
   *   原因：用户报障「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
   *   onlyoffice 预览一样 kkviewer 也一样。」页签那边一律开 `/api/raw`
   *   （字节通道，非原生 MIME 必然变下载）；而本方法恒走 kkFileView。
   *   两处实现不一致，行为就不可预测。
   *
   *   现在两处都收敛到 browserViewUrl()：
   *     · pdf/图片/视频/音频/文本 → /api/raw（浏览器原生，零转换、最快）
   *     · office/压缩包/其它      → kkFileView /preview/onlinePreview（text/html）
   *     · cad                     → cad-viewer 深链
   *   统一过 browserReachableUrl() 改写 nebula:8088 这个容器内主机名。
   *
   * ⚠️ 绝对不要自己拼 `/api/raw/<name>?mount=&path=` ——
   *   后端 rawlink 校验 exp + sig，自己拼是 403。
   *
   * @param {{isDir:boolean,name:string,path:string}} entry
   */
  async openInBrowser(entry) {
    if (entry.isDir) {
      showToast("「浏览器打开」只支持文件；目录请用「打开网盘」");
      return;
    }
    try {
      const url = await API.browserViewUrl(this.currentMount, entry.path, entry.name);
      if (!url) throw new Error("后端未返回可预览的地址");
      const w = window.open(url, "_blank", "noopener,noreferrer");
      // 弹窗被拦截时要明确告诉用户，否则点了没反应像是坏了
      if (!w) showToast("浏览器拦截了新窗口，请允许本站弹出窗口后重试");
    } catch (e) {
      showToast(`浏览器打开失败：${e.message}`);
    }
  }

  async download(entry) {
    // ★ 必须 await 签名直链 ★
    //   直连通道下 /api/download 认 Cookie（跨源 ⇒ 401），
    //   旧的同步 downloadUrl() 更是直接拼 127.0.0.1:6810 ⇒ 连接被拒。
    //   这就是用户报的「下载会报错」。
    let url;
    try {
      url = await API.signedDownloadUrl(this.currentMount, entry.path, false);
    } catch (e) {
      showToast(`下载失败：${e.message}`);
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = entry.name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);
  }

  /*
   * 「插入到当前文档」（插一个 markdown 链接）已于 2026-09-23 按用户要求**移除**。
   *
   * 为什么删而不是修：
   *   它和「嵌入到文档」在菜单里并排出现，功能名字又像（都是"放进当前文档"），
   *   用户很难分辨哪个是"插链接"、哪个是"插可预览的嵌入块"。而实际上
   *   「嵌入到文档」完全覆盖了它的使用场景 —— 嵌入块里本来就有「在页签中打开」
   *   和「打开网盘」两个出口。留着只会让人误点。
   *
   *   ⇒ 连带删掉了 insertLinkToDoc() 整个方法（它没有别的调用点）。
   *     如果哪天要恢复：拿 API.previewUrl() 的签名直链，
   *     过 browserReachableUrl()（后端签发的 raw 用容器内主机名 nebula:8088，
   *     浏览器解析不了），再 editor.insert(`[名](url)`) 即可。
   */

  /** 嵌入文件/目录到当前文档 */
  embedToDoc(entry, kind) {
    // ★★★ 不要「拿不到 editor 就提前返回」★★★
    //
    //   2026-09-22 教训（和 viewer.js 是同一个 bug）：
    //   从**侧边栏**点嵌入时，焦点在侧边栏，`getActiveEditor()` 可能返回 null
    //   ⇒ 原先这里直接 showToast("请先把光标放到文档编辑器中") 就 return 了，
    //     **locateInsertPoint 的多级回退（聚焦页签/data-initdata/layout 遍历）
    //     根本没机会执行**，用户明明开着文档却被要求"先把光标放到编辑器"。
    //
    //   ⇒ 定位是 embed.js 的职责，把 null 传下去让它自己回退。
    const editor = getActiveEditor();
    let p = String(entry.path || "");
    if (p && !p.startsWith("/")) p = "/" + p;
    // ★★★ 统一走 insertEmbedIntoDoc（内核 API），别用前端 editor.insert ★★★
    //   前端 insert 在浏览器端会把 `;;;` 围栏存成**普通段落(type=p)**，
    //   笔记里就显示成一坨裸 JSON（桌面端偶发正常，正是难查的原因）。
    //   内核 insertBlock(dataType:"markdown") 才会正确编译成自定义块。
    insertEmbedIntoDoc(this.plugin, editor, {
      kind,
      mount: this.currentMount,
      path: p,
      name: entry.name,
    }).then((ok) => {
      showToast(ok
        ? (kind === "tree" ? "已嵌入目录" : "已嵌入文件")
        : "嵌入失败：内核没有生成自定义块");
      // ★ 任务⑳：插入成功后把**本文件树**定位到该路径 ★
      //   用户原话：「点击插入后的嵌入块 右侧文档树转跳到这个路径所在位置。」
      //   注意这里是"插入之后"由**插件自己**跳 —— 网格/列表两种模式下
      //   用户刚在几十层深的目录里右键了一个文件，插完需要立刻看到
      //   "我插的就是这一个"，否则会怀疑插错。
      //   只在成功时跳；失败时跳过去反而误导。
      if (ok) {
        this.revealPath(this.currentMount, p).catch(() => { /* 定位失败不影响插入 */ });
      }
    }).catch((e) => {
      // ★ 把真实原因 + 定位轨迹显示/打出来 ★
      try {
        if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
      } catch { /* 忽略 */ }
      showToast(`嵌入失败：${(e && e.message) || "未知原因"}`);
    });
  }

  /** 重新加载某个目录（局部刷新） */
  async reloadDir(dirPath) {
    // 找到该目录节点；找不到就整树刷新
    const key = nodeKey(this.currentMount, dirPath);
    const node = this.treeEl.querySelector(`.nb-node-wrap[data-key="${cssEscape(key)}"]`);
    const wrap = dirPath === ""
      ? this.treeEl.firstElementChild
      : (node ? node.closest(".nb-node-wrap") || node : null);

    if (wrap && wrap._row) {
      wrap._loaded = false;
      await this.expandNode(wrap);
    } else {
      await this.loadRoot();
    }
  }

  /* =====================================================================
   * 过滤与状态
   * ================================================================== */
  toggleFilter() {
    const show = this.filterWrap.style.display === "none";
    this.filterWrap.style.display = show ? "block" : "none";
    if (show) {
      this.filterInput.focus();
    } else {
      this.filterInput.value = "";
      this.filter = "";
      this.clearResults();
    }
  }

  /** 收起结果面板，把树还回来（任务㉑） */
  clearResults() {
    if (!this.resultsEl) return;
    this.resultsEl.style.display = "none";
    this.resultsEl.innerHTML = "";
    if (this.treeEl) this.treeEl.style.display = "";
    this._searchToken = (this._searchToken || 0) + 1;
  }

  /**
   * 搜索（任务㉑）—— **后端递归**，不是前端过滤。
   *
   * 用户原话：
   *   「搜索需要对所有文档进行搜索，包含之前没有加载的。搜索前加载。
   *     或者打开时就一次性或者异步加载完成。
   *     增加网格显示模式，双击进去下级文件夹。
   *     网盘代码搜索功能支持子文件夹内所有文件。包括层级最深的。」
   *
   * ★ 能力边界（必须说清楚，否则会误以为还是没修好）★
   *   后端 GET /api/search 会在**服务端**递归遍历目录树，所以
   *     ✔ 没展开过的子目录里的文件 —— 搜得到
   *     ✔ 层级最深的文件 —— 搜得到
   *   但它有硬上限（hits 500 / depth 24 / scanned 20 万），
   *   超限时后端返回 truncated / depthCapped，这里会**明确提示**，
   *   不做"静默截断然后假装搜完了"。
   *
   * ★ 为什么要防竞态 ★
   *   输入是防抖 300ms 触发的，用户快速打字时会连发多次请求。
   *   旧响应晚到会把新结果覆盖掉（经典 async race）。用递增 token 丢弃过期响应。
   */
  async applyFilter() {
    if (!this.treeEl) return;
    const raw = this.filter;

    // 空查询 ⇒ 回到树视图
    if (!raw) {
      this.clearResults();
      return;
    }
    if (!this.currentMount) {
      // 还没选盘：退回前端过滤（这时候也没东西可搜）
      return;
    }

    const token = (this._searchToken || 0) + 1;
    this._searchToken = token;

    if (this.resultsEl) {
      this.resultsEl.style.display = "block";
      this.resultsEl.innerHTML = `<div class="nb-tree-empty">搜索中…</div>`;
    }

    let r;
    try {
      r = await API.search(this.currentMount, raw, "", 500);
    } catch (e) {
      if (token !== this._searchToken) return;
      if (this.resultsEl) {
        this.resultsEl.innerHTML = "";
        const err = document.createElement("div");
        err.className = "nb-tree-empty";
        err.textContent = `搜索失败：${(e && e.message) || e}`;
        this.resultsEl.appendChild(err);
      }
      return;
    }
    if (token !== this._searchToken) return;  // 过期响应，丢弃

    this.renderResults(r, raw);
  }

  /** 渲染搜索结果面板（任务㉑） */
  renderResults(r, raw) {
    const box = this.resultsEl;
    if (!box) return;
    box.innerHTML = "";

    const hits = (r && r.hits) || [];
    const head = document.createElement("div");
    head.className = "nb-results-head";
    const n = hits.length;
    // ★ 任务24b ★ 后端已返回真实命中总数 total（与 limit 无关）。
    //   只写 `${n} 个结果` 会把「上限 500」误报成「盘里就 500 个」。
    const total = (r && typeof r.total === "number") ? r.total : null;
    let msg = `${n} 个结果`;
    if (total !== null && total > n) msg = `${n} / ${total} 个结果`;
    if (r && r.scanned) msg += ` · 扫描 ${r.scanned} 项`;
    head.textContent = msg;
    box.appendChild(head);

    // ★ 截断/深度上限必须显式告诉用户 ★
    //   否则"只搜到一部分"会被误读成"盘里就这些"，从而漏掉目标文件。
    //   ★ 任务24b：判据从 truncated 换成「确实还有下一页」(hasMore / total>n)，
    //     避免 total<=limit 时的误报。
    const more = !!(r && (r.hasMore || (total !== null && total > n)));
    if (more || (r && r.depthCapped)) {
      const warn = document.createElement("div");
      warn.className = "nb-results-warn";
      const bits = [];
      if (more) {
        bits.push(total !== null
          ? `共 ${total} 条，当前最多显示 ${n} 条`
          : `结果超过 ${n} 条`);
        bits.push("缩小关键词可看到其余结果");
      }
      if (r && r.depthCapped) bits.push("目录过深/过多，未全部扫描");
      warn.textContent = "⚠ " + bits.join("；");
      box.appendChild(warn);
    }

    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "nb-tree-empty";
      empty.textContent = "没有匹配的文件";
      box.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "nb-results-list";
    for (const e of hits) {
      list.appendChild(this.makeResultRow(e, raw));
    }
    box.appendChild(list);

    // 搜索时收起树，避免两套列表同时在滚动
    if (this.treeEl) this.treeEl.style.display = "none";
  }

  /** 一条搜索结果（任务㉑）。样式复用树的节点行，保证观感一致。 */
  makeResultRow(e, raw) {
    const row = document.createElement("div");
    row.className = "nb-node nb-result-row" + (e.isDir ? " is-dir" : "");
    row.dataset.name = e.name || "";
    row.dataset.isDir = e.isDir ? "1" : "0";

    const icon = document.createElement("span");
    icon.className = "nb-node-icon";
    try {
      // ★ 任务25b：必须传 (ext, isDir)，不能传 name ★
      //   以前写的是 typeIconEl(e.name, e.isDir) ⇒ 图标退化成"名字前3个字、灰色"。
      //   搜索结果里后端已经给了 e.ext，直接用；兜底时从 name 现取。
      icon.appendChild(typeIconEl(e.ext || extOf(e.name), !!e.isDir));
    } catch { /* 图标失败不影响功能 */ }
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "nb-node-name";
    name.textContent = e.name || "";
    // 命中词高亮（简单子串高亮，够用且不引依赖）
    try { this._highlight(name, e.name || "", raw); } catch { /* 忽略 */ }
    row.appendChild(name);

    if (e.readonly) {
      const ro = document.createElement("span");
      ro.className = "nb-node-ro";
      ro.textContent = "只读";
      row.appendChild(ro);
    }

    /*
     * ★★★ #63：路径只显示「父目录名」，不再显示完整路径 ★★★
     *
     *   用户原话：「侧边栏文件树的搜索结果 路径显示太长了，把文件名都遮住了。」
     *          「要求，搜索结果显示 路径长度 到 文件上一级即可。
     *            即 只保留父目录名。」
     *
     *   ⇒ 用户要的是**内容**变短（只留父目录名），不是靠 CSS 截断。
     *     完整路径对「区分同名文件」有用，但一屏里长路径会把文件名挤没 ——
     *     而文件名才是用户扫视时找的目标。
     *
     *   两边兼顾的做法：
     *     · 展示文本 = **末级目录名**（`a/b/c/file.pdf` → `c`）
     *     · title     = **完整路径**（悬停即可确认到底是哪一个，信息不丢）
     *   这样既满足「只保留父目录名」，又不丢失定位能力。
     *
     *   ⚠️ 根目录下的文件：`e.path` = `/file.pdf` ⇒ dir = "" ⇒ 显示 `/`（表示在盘根）。
     */
    const segs = String(e.path || "").split("/").filter(Boolean);
    // 去掉最后一段（文件名本身），剩下的最后一段就是父目录名
    const parent = segs.length >= 2 ? segs[segs.length - 2] : "";
    const pathEl = document.createElement("span");
    pathEl.className = "nb-result-path";
    pathEl.textContent = parent || "/";
    pathEl.title = displayMountPath(this.currentMount, e.path);
    row.appendChild(pathEl);

    row.onclick = () => {
      // 单击只选中（与树节点一致，避免误触）
      this.resultsEl.querySelectorAll(".nb-result-row.is-selected")
        .forEach((n) => n.classList.remove("is-selected"));
      row.classList.add("is-selected");
    };
    row.ondblclick = (ev) => {
      ev.stopPropagation();
      if (e.isDir) {
        // 双击目录 ⇒ 退出搜索、跳到该目录（用户要在网格/树里浏览它）
        this._jumpToDir(e.path);
      } else {
        this.activateFile({
          path: e.path, name: e.name, ext: e.ext,
          size: e.size, mtime: e.mtime, isDir: false,
        }, false);
      }
    };
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.showNodeMenu(ev, {
        path: e.path, name: e.name, isDir: !!e.isDir,
        ext: e.ext, size: e.size, mtime: e.mtime, readonly: e.readonly,
      });
    };

    // ★★★ 任务30：搜索结果也要能拖进文档 ★★★
    //   用户原话：「搜索结果需要支持拖拽插入文档功能」。
    //   实测确认过：改之前这里 draggable/ondragstart/setData 全为 false，
    //   所以搜索结果的行确实是「看着像树节点、但拖不动」。
    //   现在复用与树节点**同一个** attachEmbedDrag，行为完全一致。
    this.attachEmbedDrag(row, {
      path: e.path, name: e.name, isDir: !!e.isDir,
    });
    return row;
  }

  /** 把关键词在名称里高亮（搜索结果用） */
  _highlight(span, name, raw) {
    const terms = this._filterTerms(raw).filter((t) => t.length > 0);
    if (!terms.length) return;
    const lower = name.toLowerCase();
    let best = -1, bestLen = 0;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0 && (best < 0 || i < best)) { best = i; bestLen = t.length; }
    }
    if (best < 0) return;
    span.textContent = "";
    span.appendChild(document.createTextNode(name.slice(0, best)));
    const mark = document.createElement("mark");
    mark.className = "nb-hl";
    mark.textContent = name.slice(best, best + bestLen);
    span.appendChild(mark);
    span.appendChild(document.createTextNode(name.slice(best + bestLen)));
  }

  /** 搜索结果里双击目录 ⇒ 退出搜索并定位过去 */
  async _jumpToDir(dirPath) {
    this.filterInput.value = "";
    this.filter = "";
    this.clearResults();
    await this.revealPath(this.currentMount, dirPath);
  }


  /**
   * 把输入解析成一组「小写子串」。
   *   `*.png`        → ["png"]
   *   `png,jpg`      → ["png","jpg"]
   *   `报告 pdf`     → ["报告","pdf"]   （空格分隔，OR）
   *   `.png`         → [".png"]         （保留点，便于精确匹配扩展名）
   *   `PNG`          → ["png"]          （统一小写）
   *
   * ★ 注意：后端 _search_terms 是这套规则的**权威实现**（真正去遍历目录的是它）。
   *   这里保留一份用于**本地高亮**（搜索结果里把命中的词标出来），
   *   两边规则必须一致，所以改动时请对照 /opt/nebula/app/routers/fileops.py。
   */
  _filterTerms(raw) {
    return String(raw || "")
      .split(/[,，|]+/)                 // 逗号 / 竖线 优先当分隔符
      .flatMap((chunk) => {
        const c = chunk.trim();
        if (!c) return [];
        // ★ 通配：`*.png` / `*png` —— 用户习惯写法。
        //   旧实现会去字面匹配 "*.png"，结果全部落空（这是本次修的一个真问题）。
        if (c.startsWith("*")) return [c.replace(/^\*\.?/, "").trim().toLowerCase()];
        // 含空格的整串：既当整体，也拆成词（两种都可能命中，OR 更宽容）
        const parts = [c];
        if (/\s/.test(c)) parts.push(...c.split(/\s+/));
        return parts;
      })
      .map((s) => s.toLowerCase())
      .filter(Boolean);
  }

  /* ---------------------------------------------------------------------
   * ★ 任务㉑（2026-09-23）：旧的「前端过滤」实现已删除 ★
   *
   *   原来的 applyFilter() 只对**已经渲染成 DOM 的节点**做 display:none，
   *   而文件树是懒加载的 ⇒ 没展开过的目录、层级最深的文件根本搜不到。
   *   用户要求「搜索需要对所有文档进行搜索，包含之前没有加载的」，
   *   所以改成了「后端递归搜索 + 独立结果面板」：
   *     · 后端：GET /api/search（见 NebulaDisk routers/fileops.py）
   *     · 前端：TreePanel.applyFilter() → API.search() → renderResults()
   *   本文件里现在只剩 _filterTerms()，供**本地高亮**复用。
   *   ⚠️ 别再把它改回前端过滤 —— 那等于把"搜不全"这个 bug 装回去。
   * ------------------------------------------------------------------ */

  showBanner(text, kind = "warn", action) {
    if (!this.banner) return;
    this.banner.className = `nb-tree-banner is-${kind}`;
    this.banner.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = text;
    this.banner.appendChild(span);
    if (action) {
      const btn = document.createElement("button");
      btn.className = "b3-button b3-button--outline";
      btn.textContent = "处理";
      btn.onclick = action;
      this.banner.appendChild(btn);
    }
    this.banner.style.display = "flex";
  }

  hideBanner() {
    if (this.banner) this.banner.style.display = "none";
  }

  onProxyDown(detail) {
    this.proxyOk = false;
    this.showBanner(`网络通道未就绪：${detail}`, "warn", () => this.plugin.openSetting());
  }

  onProxyUp() {
    this.proxyOk = true;
    this.hideBanner();
  }

  onSessionLost() {
    this.sessionOk = false;
    this.renderLoginPrompt();
  }
}

/* -------------------------------------------------------------------------
 * 工具
 * ---------------------------------------------------------------------- */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parentOf(p) {
  const i = String(p).lastIndexOf("/");
  return i <= 0 ? "" : String(p).slice(0, i);
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

/**
 * 任务⑫ 的核心递归：把一个 `FileSystemEntry` 展开成「待上传任务」列表。
 *
 * ★ 为什么必须自己递归，不能直接用 dataTransfer.files ★
 *   拖**文件夹**进来时，`dataTransfer.files` 里**只有那个文件夹本身**，
 *   子文件一个都不在里面 —— 直接用它上传，用户看到的是"什么都没传上去"。
 *   要拿到真实文件必须走 FileSystem API。
 *
 * ★ readEntries() 一次最多回 100 条 ★
 *   这是规范行为（不是 bug）。必须循环读到返回空数组为止，
 *   否则目录里第 101 个之后的文件会被静默丢弃 —— 这种丢数据最难发现。
 *
 * ★ 不做软链接/超长路径的特殊处理 ★
 *   浏览器端 `isFile` / `isDirectory` 已经够用；遇到读不出来的条目
 *   （权限、已删除）就跳过并记日志，**不能让一个坏条目毁掉整批上传**。
 *
 * @param {any} entry FileSystemEntry（FileSystemFileEntry / FileSystemDirectoryEntry）
 * @param {string} relDir 相对落点目录的子目录路径（如 `图纸/2024`）
 * @param {Array<{file: File, relDir: string}>} out 收集结果
 * @returns {Promise<void>}
 */
async function collectEntry(entry, relDir, out) {
  if (!entry) return;
  try {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      if (file) out.push({ file, relDir });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = relDir ? relDir + "/" + entry.name : entry.name;
      // ★ 循环读到空：不要只 readEntries 一次 ★
      for (;;) {
        const batch = await new Promise((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        if (!batch || !batch.length) break;
        for (const child of batch) {
          await collectEntry(child, sub, out);
        }
      }
    }
  } catch (e) {
    diag(`[tree] 跳过无法读取的拖入条目「${entry && entry.name}」：${e && e.message}`);
  }
}

function showToast(msg) {
  showMessage(msg);
}

function copyText(text, okMsg = "已复制") {
  const done = () => showToast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { showToast("复制失败"); }
  ta.remove();
}

function confirmDialog(title, content) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // 思源的 confirm 是回调式：只在「确定」时回调，取消没有回调。
    // 因此用「确定回调」+「对话框消失」两条路径兜底判定。
    confirm("⚠️ " + title, content, () => finish(true));

    const timer = setInterval(() => {
      if (settled) { clearInterval(timer); return; }
      // 思源的对话框容器
      const open = document.querySelector(".b3-dialog--open");
      if (!open) {
        clearInterval(timer);
        finish(false);
      }
    }, 300);

    // 兜底：极端情况下对话框一直存在（比如被其它层遮挡），30s 后放弃等待
    setTimeout(() => { clearInterval(timer); finish(false); }, 30000);
  });
}

/** 取当前聚焦的编辑器 */
function getActiveEditor() {
  const el = document.querySelector(".protyle-wysiwyg--focus") ||
             document.querySelector(".protyle-wysiwyg");
  if (!el) return null;
  const protyle = el.closest(".protyle")?._protyle || window.siyuan?.editor;
  return protyle || null;
}

/**
 * 复用已有的查看页签
 * 思源没有「按 custom.data 查找已开页签」的公开 API，
 * 这里通过 getOpenedTab 拿到页签列表，按 data 匹配后重新激活。
 */
function tryReuseViewerTab(plugin, item) {
  try {
    const tabs = plugin.getOpenedTab ? plugin.getOpenedTab() : null;
    if (!tabs) return false;
    // getOpenedTab 返回的形态在各版本间有差异，这里做宽松处理：
    // 只要能拿到 model 且带 custom 信息就尝试激活。
    const list = Array.isArray(tabs) ? tabs : Object.values(tabs);
    for (const t of list) {
      const d = t?.data || t?.model?.data;
      if (d && d.mount === item.mount && d.path === item.path) {
        if (typeof t.model?.activate === "function") {
          t.model.activate();
          return true;
        }
      }
    }
  } catch { /* 版本差异，忽略 */ }
  return false;
}

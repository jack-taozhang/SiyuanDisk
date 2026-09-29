import {
  Plugin,
  getFrontend,
  showMessage,
  openTab,
  Dialog,
} from "siyuan";

import { API, setUnauthorizedHandler, displayMountPath, pickViewer } from "./src/api.js";
import { CUSTOM_ICONS, typeIconEl, extOf } from "./src/icons.js";
import { FileTree } from "./src/tree.js";
import { Viewer } from "./src/viewer.js";
import { registerEmbed, bindPluginApi, migrateLegacyEmbeds, buildEmbedMarkdown, findLegacyFenceBlocks, findParagraphFences, insertEmbedIntoDoc, collapseAllOpenEmbeds } from "./src/embed.js";
import { createExternalContract } from "./src/external.js";
import { NebulaProxy, HAS_NODE, setDiagFile, diag, dirExists, pickWorkspace, normPath, probeProxyPort } from "./src/proxy.js";
/* ==========================================================================
 * NebulaDisk 网盘 —— 思源笔记插件
 * --------------------------------------------------------------------------
 * 三项需求与实现位置：
 *   ① 侧边栏直接浏览网盘文件
 *        → addDock("nbDock") + FileTree（src/tree.js）
 *   ② 预览与在线编辑
 *        → addTab("nbViewer") + Viewer（src/viewer.js）
 *   ③ 笔记内无缝嵌入文件树 / 文件页面
 *        → 自定义块渲染 + 斜杠菜单 + 命令（src/embed.js）
 *
 * 跨域问题的解法见 src/proxy.js 顶部注释。
 * ========================================================================== */







/**
 * ★ 不要在这个 import 里加回 repairFenceBlock / extractJson（2026-09-22 清理）★
 *
 *   这两个符号曾经被导入但从未使用 —— 死导入，会被 test/syntax.check.js 的
 *   【④ 未使用的 import】抓出来。
 *
 *   为什么它们是「没用」而不是「漏用」：
 *     src/embed.js 里的 repairFenceBlock() / extractJson() 是**通用版**
 *     （按 blockId 直接重建），而本文件走的是**另一条更早的实现路线**：
 *       · 反引号围栏残留 → 本文件的 upgradeFenceBlock()（内联 updateBlock）
 *       · 段落围栏残留   → 本文件的 repairParagraphFence()（内联 删+重插）
 *     两者都把逻辑内联在自己方法里了，不依赖 embed.js 的那两个函数。
 *     ⇒ 同一条逻辑存在两份实现，import 的那份从未被调用。
 *
 *   若将来要统一到 embed.js 的实现，**先删掉这里的内联版本**，
 *   否则会变成「两份代码同时生效」，行为和日志都会难以判断。
 */

/*
 * 代理类必须在**编译期**就引入。
 *
 *   不能写成运行时的 require("./src/proxy.js")：
 *   思源给插件的 require 只认 "siyuan"，其余走 Electron 的 window.require，
 *   其解析基准是渲染进程 bundle 而非插件目录 ⇒ 必然 MODULE_NOT_FOUND，
 *   而且只报在浏览器 console，siyuan.log 里看不到。
 *   构建脚本会把它连同本文件一起打成一个 index.js。
 */


/** 页签类型 */
const TAB_TYPE = "nebuladisk_viewer";
/** 停靠面板类型（传给 addDock 的 type，思源会自动补插件名前缀） */
const DOCK_TYPE = "nebuladisk_tree";
/** 插件名（思源内部把它拼在 dock type 前面，见 common.js 的 addDock） */
const PLUGIN_NAME = "siyuan-nebuladisk";
/** 思源实际用的 dock 标识 = 插件名 + type，用于查询侧栏图标 DOM */
const DOCK_TYPE_FULL = PLUGIN_NAME + DOCK_TYPE;
/** 自定义块类型（笔记内嵌） */
const EMBED_BLOCK_TYPE = "nebuladisk";
/** 设置持久化 key */
const STORAGE_KEY = "settings";

/* -------------------------------------------------------------------------
 * 默认设置
 * ---------------------------------------------------------------------- */
/**
 * 推断一个合理的后端地址。
 *
 * ★ 为什么不写死 IP ★
 *   同一个插件会被两种完全不同的思源加载：
 *     · 桌面端（本机装，Electron）—— 页面在 127.0.0.1:6806
 *     · 服务端（NAS 上用 Docker 跑，浏览器访问）—— 页面在 192.168.193.70:6806
 *   写死 192.168.193.70（ZeroTier 地址）时，浏览器端经常解析不到，
 *   表现就是「图标有、点了连不上」，用户完全不知道为什么。
 *   实测：NAS 上的思源容器访问 192.168.193.70:8089 是通的。
 *
 *   因此默认值跟随**当前页面所在主机**：网盘和思源本来就部署在同一台机器上，
 *   用页面 hostname 拼 8089 在两种场景下都成立。
 *   用户仍可在设置里改成别的地址（例如走 ZeroTier 或域名）。
 *
 * ★ 端口 8089 从哪来 ★
 *   部署目录 .env 的 NB_HOST_PORT=8089（宿主机映射端口），
 *   容器内是 8088。插件从浏览器访问，必须用宿主机端口。
 */
function guessServerUrl() {
  try {
    const h = (typeof location !== "undefined" && location.hostname) || "";
    // file:// 打开或拿不到 hostname 时，退回历史上一直在用的地址
    if (!h || h === "localhost" || h === "127.0.0.1") {
      // 桌面端：思源和网盘常常不在同一台机器（思源本机装、网盘在 NAS），
      // 保留 ZeroTier 地址作为本机场景的默认
      return "http://192.168.193.70:8089";
    }
    return `http://${h}:8089`;
  } catch (e) {
    return "http://192.168.193.70:8089";
  }
}

const DEFAULT_SETTINGS = {
  serverUrl: guessServerUrl(),
  username: "tao_zhang",
  password: "",
  autoLogin: true,
  proxyPort: 6810,
  defaultMount: "",
  confirmDelete: true,
};

/* -------------------------------------------------------------------------
 * 代理引导
 *
 * 难点：插件的 index.js 跑在「思源渲染进程（Electron renderer）」里。
 *   在 Electron 中，renderer 带有 node 集成时可以直接 require("http")；
 *   但如果思源的 renderer 关闭了 nodeIntegration（新版本倾向如此），
 *   require 就不可用。
 *
 * 策略（三级降级，逐级给出可操作提示）：
 *   ① 直接 require node 内建模块，在渲染进程内起代理 —— 最省事，首选
 *   ② 失败则提示用户粘贴「JS 代码片段」启动代理（片段在设置面板里一键复制）
 *   ③ 都不行则提示改用「反代统一入口」方案（把 /nb 交给 nginx）
 *
 * 关键点：不管哪条路，代理都必须监听 127.0.0.1。
 *   思源无论跑在宿主机还是容器里，插件 JS 都在思源自己的进程内，
 *   所以 127.0.0.1 对它永远可达。
 * ---------------------------------------------------------------------- */
class ProxyBoot {
  constructor(plugin) {
    this.plugin = plugin;
    this.proxy = null;
    this.mode = "none";   // none | inline | external
  }

  /**
   * 尝试在渲染进程内直接启动代理。
   *
   * ★ 这里**不能**写 require("./src/proxy.js")。
   *
   *   思源给插件的 require 只处理 "siyuan"，其余委托给 Electron 的
   *   window.require，其解析基准是**渲染进程 bundle**，不是插件目录，
   *   所以相对路径必然 MODULE_NOT_FOUND。
   *   而且这个错误只写进浏览器 console，siyuan.log 里毫无痕迹。
   *
   *   ⇒ 插件被 tools/build.js 打成**单文件**，proxy 已是同文件内的
   *     模块命名空间，直接引用即可（见 import { NebulaProxy }）。
   *      真正的风险只剩「渲染进程没有 node 能力」这一种，
   *      此时 require("http") 会在 **加载 proxy 模块时**就抛错 ——
   *      所以下面用 try 包住构造，失败就降级到外部代理 / nginx 方案。
   */
  async startInline() {
    const s = this.plugin.settings;
    const port = Number(s.proxyPort) || 6810;

    // ★★★ 先判环境有没有 node 能力 ★★★
    //   服务端思源（NAS 上用 Docker 跑、浏览器访问）**没有 require/process/fs**。
    //   这时起代理是物理上不可能的，**不该报错、更不该让插件挂掉** ——
    //   必须干脆地降级为「直连通道」，并把原因讲清楚。
    //   历史教训：proxy.js 曾在模块顶层 require("http")，
    //   浏览器里脚本求值即抛 ⇒ 思源 console.error 后静默丢弃整个插件
    //   ⇒ 连诊断日志都不产生，表现为「插件在列表里但毫无反应」。
    if (!HAS_NODE) {
      // ★ 用 "direct" 而不是 "none" ★
      //   "none" 是「本该有代理却没有」的失败态；这里不是失败，
      //   而是「这个环境本来就不需要代理」。状态必须区分开，
      //   否则侧边栏会误判为通道不可用而不渲染文件树。
      this.mode = "direct";
      this._noNode = true;
      diag("[proxy] 当前环境无 node 能力（浏览器端思源）⇒ 使用直连通道（正常）");
      return true;
    }

    // ── 先探测：端口上是否已经有本插件的代理在跑 ──
    //  思源的渲染进程会**反复重建**（每次重载都会重新执行 onload），
    //  而上一轮的代理句柄随旧进程一起消失时端口未必立刻释放。
    //  旧实现直接 listen，撞上 EADDRINUSE 就判定「代理不可用」，
    //  实际那个代理是好的 —— 这个误判让通道白丢。
    //  所以先探一次，能复用就复用。
    const existing = await probeProxyPort(port);
    if (existing.ok) {
      this.mode = "external";
      this.externalPort = port;
      this._reused = true;
      diag(`复用已在运行的代理 :${port}（target=${existing.info && existing.info.target}）`);
      return true;
    }

    try {
      this.proxy = new NebulaProxy({
        target: s.serverUrl,
        port,
        host: "127.0.0.1",
        cookieFile: this.plugin.cookieFile(),
        log: (m) => console.log(m),
      });
      await this.proxy.start();
      this.mode = "inline";
      this.actualPort = this.proxy.actualPort;
      return true;
    } catch (e) {
      // 记全栈，便于从日志定位（端口占用 / 无 node 能力 / 配置错误）
      this.lastError = e && e.stack ? e.stack.split("\n")[0] + " | " + e.message : String(e.message || e);
      this.proxy = null;
      // ── 兜底：listen 失败的另一种可能是「刚好被别的进程抢在探测之后占了」，
      //    再探一次，仍能复用就不算失败。
      const again = await probeProxyPort(port);
      if (again.ok) {
        this.mode = "external";
        this.externalPort = port;
        this._reused = true;
        diag(`listen 失败但探测到可用代理 :${port}，改用复用模式`);
        return true;
      }
      return false;
    }
  }

  /**
   * 探测外部代理是否已经在跑。
   *
   * ★ 用 Node http 而不是浏览器 fetch ★
   *   fetch 受同源策略约束 —— 思源页面与代理端口不同即跨源，
   *   若那个代理是旧版（无 CORS 头），响应体会被浏览器丢弃，
   *   fetch 抛错 ⇒ 误判「没有代理」。见 proxy.js: probeProxyPort 的说明。
   */
  async probeExternal() {
    const s = this.plugin.settings;
    const port = Number(s.proxyPort) || 6810;
    const r = await probeProxyPort(port);
    if (!r.ok) return false;
    // 外部代理的端口与思源不同 ⇒ 插件要指向它，而不是 /nb 相对路径
    this.mode = "external";
    this.externalPort = port;
    this._reused = true;
    return true;
  }

  async stop() {
    // 复用来的代理不属于本实例，不能停 —— 否则会把别的渲染进程
    // （或用户自己起的代理）一起关掉。
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = null;
    }
    this._reused = false;
    // ★ 无 node 能力是环境属性，不因 stop 而改变 ★
    //   若这里无脑置 "none"，api.js 的 hasNode() 会读不到，
    //   又可能把请求带回 127.0.0.1:6810。
    this.mode = this._noNode ? "direct" : "none";
  }

  /**
   * 本环境有没有 node 能力（= 能不能起本地代理）。
   *
   * api.js 的 hasNode() 会读这个字段来锁定通道：
   * 浏览器端思源**永远不该**回退到 127.0.0.1:6810。
   */
  get noNode() {
    return !!this._noNode;
  }

  get status() {
    if (this.mode === "inline") return { ok: true, mode: "inline", detail: "插件内嵌代理运行中" };
    if (this.mode === "external") return { ok: true, mode: "external", detail: `外部代理运行中（端口 ${this.externalPort}）` };
    // ★★★ 「无 node 能力」是一种**正常可用状态**，不是失败 ★★★
    //   服务端思源（NAS Docker + 浏览器）就是这样：起不了代理，
    //   但只要网盘地址配好、后端开了 CORS，直连通道完全能用。
    //   这里若返回 ok:false，侧边栏会一直停在「通道未就绪」，
    //   明明能用却什么都不显示 —— 用户只会觉得插件坏了。
    //   所以单独给一个 direct 模式，并且 ok:true。
    if (this.mode === "direct") {
      return { ok: true, mode: "direct", detail: "直连通道（当前环境无需内置代理）" };
    }
    return { ok: false, mode: "none", detail: this.lastError || "代理未启动" };
  }
}

/* -------------------------------------------------------------------------
 * 插件主体
 * ---------------------------------------------------------------------- */
export default class NebulaDiskPlugin extends Plugin {
  constructor(options) {
    super(options);
    this.settings = { ...DEFAULT_SETTINGS };
    /** @type {ProxyBoot} */
    this.boot = null;
    /** @type {FileTree|null} */
    this.tree = null;
    this._unauthorized = false;
  }

  /* =====================================================================
   * 生命周期
   * ================================================================== */
  async onload() {
    const frontend = getFrontend();
    const isDesktop = frontend === "desktop" || frontend === "desktop-window";

    // 0) 先把诊断日志接上，之后任何环节失败都能在磁盘上看到
    setDiagFile(this.diagFile());
    diag(`=== onload 开始 frontend=${frontend} ===`);
    diag(`node 能力: require=${typeof require} process=${typeof process} fetch=${typeof fetch}`);
    diag(`diagFile=${this.diagFile() || "(空！日志将不可见)"}`);

    // ★ 分步诊断 ★
    //   思源只把 onload 的异常打到浏览器 console，外部完全看不到。
    //   这里把每个阶段用 try 包起来，失败就把阶段名与完整栈写进日志，
    //   这样「跑到哪一步断的」在磁盘上就能读到。
    const step = (name, fn) => {
      try {
        diag(`  → ${name}`);
        const r = fn();
        diag(`  ✓ ${name}`);
        return r;
      } catch (e) {
        diag(`  ✗ ${name} 抛错: ${e && e.stack ? e.stack : e}`);
        throw e;
      }
    };

    try {
      // 0.1) 暴露给 src/ 下的模块使用（viewer 需要读网盘地址等设置）
      window.__nebuladiskPlugin = this;

      // 0.2) 挂载对外能力契约 `external`（F-201 定稿，2026-09-24）
      //
      //   ★ 用途 ★ 让「其它插件」能消费网盘能力，而**网盘不认识任何消费方**。
      //     · 契约只描述「我能做什么」：list / stat / search / viewerKind /
      //       预览地址构造 / 健康检查
      //     · 绝不描述「谁在调我」—— 这里不出现 canvas / 画布 之类的词（C-5）
      //     · URL 一律由网盘侧构造（C-4）：后端可能是容器内名（nebula:8088），
      //       必须经 browserReachableUrl() 改写成浏览器可达地址；
      //       消费方自己拼必然踩这个坑，所以干脆不暴露地址拼接能力。
      //     · 方法**不抛异常**穿过边界，统一返回 `{ok, data|error, reason}`；
      //       reason 严格区分 missing(404) / denied(403) / unreachable(网络)
      //       —— 否则消费方会把「网盘暂时连不上」误报成「文件被删了」。
      //
      //   为什么是「冻结」的：契约一旦挂出就是公开接口，防止被运行时改写。
      try {
        this.external = createExternalContract({ API, pickViewer, diag });
        diag("[external] 对外契约已挂载（version=" + this.external.version + "）");
      } catch (e) {
        // 契约挂载失败不能阻断插件自身启动 —— 画布那边会优雅降级
        diag("[external] 契约挂载失败：" + (e && e.message));
      }

      // 1) 载入设置（要先于代理启动，因为代理需要 serverUrl/port）
      await step("loadSettings", () => this.loadSettings());

      // 2) 注册自定义图标
      step("addIcons", () => this.addIcons(CUSTOM_ICONS));

      // 3) 注册自定义块渲染（笔记内嵌）—— 必须在 onload 同步段内完成
      //    同时把 API 绑定给渲染器，避免 index.js ↔ embed.js 循环依赖
      step("bindPluginApi", () => bindPluginApi(this, API));
      step("registerEmbed", () => registerEmbed(this));

      // ★ 2026-09-28：日志里去掉 addTopBar —— 顶栏按钮已整段移除，
      //   留着这个词会让今后看日志的人以为"顶栏还有按钮"（实测会误导）。
      diag("  → addTab/addDock（顶栏按钮已移除）");

      // 4) 注册页签类型（预览 / 编辑）
      this.addTab({
      type: TAB_TYPE,
      init() {
        // this.element / this.data 由思源注入
        const viewer = new Viewer(this.element, this.data);
        this._viewer = viewer;
        viewer.render();
      },
      beforeDestroy() {
        if (this._viewer) this._viewer.destroy();
      },
      destroy() {
        if (this._viewer) this._viewer.destroy();
        this._viewer = null;
      },
    });

    // 5) 注册侧边栏停靠面板
    //    参照已在用的第三方插件写法（siyuan-canvas / siyuan-plugin-task-list /
    //    siyuan-table-master）：
    //      · config.show 必须显式给 false —— 否则思源不认为这个面板「还没被打开」，
    //        侧栏图标不会挂上去（这是们之前看不到入口的直接原因）
    //      · position 用 RightTop，与其它插件的停靠面板一致
    //    ⚠️ 注意：思源内部把 dock 的标识拼成 `插件名 + type`
    //       （common.js: addDock(){ const ze = this.name + se.type }），
    //       所以 data-type 实际是 "siyuan-nebuladisknebuladisk_tree"，
    //       查询图标时必须用 DOCK_TYPE_FULL。
    this.addDock({
      config: {
        position: "RightTop",
        size: { width: 280, height: 0 },
        icon: "iconNebulaDisk",
        title: this.i18n.dockTitle || "NebulaDisk",
        hotkey: isDesktop ? "⌥⌘N" : "",
        show: false,
      },
      data: {},
      type: DOCK_TYPE,
      init: (dock) => this.initDock(dock),
      destroy: () => {
        if (this.tree) {
          this.tree.destroy();
          this.tree = null;
        }
      },
      update: () => {
        if (this.tree) this.tree.refresh();
      },
      resize: () => {
        if (this.tree) this.tree.onResize();
      },
    });

    // 6) 顶栏按钮 —— ★ 已按用户要求整段移除（2026-09-28）★
    //
    //   用户原话：「界面上有两个按钮，删除顶部那个。」
    //
    //   删掉的是 **思源主窗口最顶栏右侧** 那个 NebulaDisk 云朵图标
    //   （原 addTopBar({ position: "right" })，含它的右键菜单：
    //     设置 / 刷新 / 在浏览器中打开网盘）。
    //
    //   ⚠️ 为什么整段删而不是隐藏：
    //     用户要的是"界面上不要这个按钮"。做成 display:none 会让
    //     顶栏留下一个看不见但占位的热点，鼠标划过去还会触发 tooltip，
    //     比直接不注册更让人困惑。
    //
    //   ★ 功能没有丢失（入口仍在，逐条核对过）★
    //     · 打开面板  ⇒ 右侧停靠栏图标（addDock，见上）
    //                    + 命令面板「打开 NebulaDisk」+ 快捷键 ⌥⌘N
    //     · 插件设置  ⇒ 停靠栏「更多」菜单里的「插件设置」
    //                    + 思源「设置 → 集市 → 已下载 → NebulaDisk」的齿轮
    //     · 刷新      ⇒ 停靠栏「更多」菜单（刷新 / 刷新并重置展开状态）
    //     · 打开网盘  ⇒ 停靠栏「更多」菜单里的「在浏览器中打开网盘」
    //                    + 每个文件右键菜单的「浏览器打开」
    //
    //   ⇒ 若日后要恢复：把 addTopBar 那段原样贴回本行下方即可，
    //     上面四条入口是**冗余**的，恢复后不会冲突。

    // 7) 命令
    //
    // ★ 不要用 globalCallback ★
    //   思源看到 globalCallback 会去注册**托盘菜单**项，内部访问 this._trayMenu；
    //   而在 onload 阶段托盘菜单尚未初始化，于是抛
    //       TypeError: Cannot read properties of undefined (reading '_trayMenu')
    //   这个异常只进浏览器 console，外部表现就是「插件加载了但什么都没发生」。
    //   实测（思源 3.8.4）在本插件里加 globalCallback 必崩，改用普通 callback。
    this.addCommand({
      langKey: "openNebulaDisk",
      hotkey: isDesktop ? "⌥⌘N" : "",
      callback: () => this.openDockPanel(),
    });
    this.addCommand({
      langKey: "refreshNebulaDisk",
      // ★ 2026-09-28：原本是 this.tree.refresh(true) —— 那个 true 会让
      //   「刷新」顺带清空目录树的展开状态（与 README「刷新后回到原处」相反）。
      //   「重置展开」能力已随菜单项一起删除，refresh() 现在也不接受该参数，
      //   留着 true 只会是**看着有效、实则被忽略**的死参数，故一并清掉。
      callback: () => this.tree && this.tree.refresh(),
    });

    // 8) 斜杠菜单（笔记内嵌入口）
    //
    // ★★★ 2026-09-22 用户要求：删掉「嵌入文件树到文档」这一项 ★★★
    //
    //   原话：「20 嵌入文档树到文档这个功能取消删除不需要了。
    //          /网 跳出菜单 名称改为：嵌入文件到文档」
    //
    //   为什么删而不是保留：
    //     · 「嵌入文件树」= 把一整个网盘目录嵌进笔记。它的价值是"目录镜像"，
    //       但网盘目录随时会变，嵌入块里看到的永远是**那一刻**的列表快照，
    //       对不上号时用户会以为内容丢了。真正要"看目录"直接开侧边栏更合适。
    //     · 剩下的「嵌入文件」覆盖了实际用法：嵌单个文件，点开预览，
    //       旁边的「定位」按钮还能跳回它所在的目录 —— 目录信息并没有丢。
    //     · 两项在菜单里名字相近（都叫"嵌入…到文档"），并存只会让人误点。
    //       ⇒ 删掉 kind==="tree" 的入口。底层 renderTreeBrowser 仍保留，
    //         因为**历史笔记里已有的 tree 嵌入块**还要能正常渲染，
    //         删入口不等于删渲染能力（否则老笔记会变白块）。
    this.protyleSlash = [
      {
        filter: ["nebula", "wangpan", "网盘", "nb", "yunpan", "wenjian", "文件"],
        html: `<div class="b3-list-item__first">
                 <svg class="b3-list-item__graphic"><use xlink:href="#iconNebulaDisk"></use></svg>
                 <span class="b3-list-item__text">${this.i18n.embedFileName || "嵌入文件到文档"}</span>
               </div>`,
        id: "nebulaEmbedFile",
        callback: (protyle, el) => this.pickAndEmbed(protyle, "file", el),
      },
    ];

    // 9) 401 统一处理
    setUnauthorizedHandler(() => {
      this._unauthorized = true;
      if (this.tree) this.tree.onSessionLost();
    });

    // 10) 启动代理（异步，不阻塞插件加载）
    this.boot = new ProxyBoot(this);
    this.bootReady = this.boot.startInline().then(async (ok) => {
      if (!ok) {
        diag(`startInline 失败: ${this.boot.lastError || "(无异常信息)"}`);
        // 退化：探测外部代理（用户用 JS 代码片段起的那种）
        const ext = await this.boot.probeExternal();
        if (!ext) {
          const detail = this.boot.status.detail;
          diag(`外部代理也探测不到 ⇒ 代理不可用。detail=${detail}`);
          console.warn("[nebuladisk] 代理未启动:", detail);
          if (this.tree) this.tree.onProxyDown(detail);
          return false;
        }
        diag("外部代理可用（mode=external）");
      }
      // 代理可用 → 尝试自动登录
      diag(`代理就绪 mode=${this.boot.mode} port=${this.boot.actualPort || ""}`);
      if (this.settings.autoLogin && this.settings.password) {
        await this.tryAutoLogin();
      }
      if (this.tree) this.tree.onProxyUp();
      return true;
    }).catch((e) => {
      diag(`bootReady 抛异常: ${e && e.stack ? e.stack : e}`);
      return false;
    });

      diag("=== onload 同步段结束（UI 已注册）===");
    } catch (e) {
      // 同步段任何一步抛错都会走到这里 —— 之前这些异常只进浏览器 console，
      // 外部完全看不到，排查时只知道「插件在、但没反应」。
      diag(`=== onload 同步段失败 ===\n${e && e.stack ? e.stack : e}`);
      throw e;
    }
  }

  onLayoutReady() {
    // 布局就绪时，如果面板已经存在（用户上次是展开的），
    // 主动把代理/会话状态同步给它 —— 因为面板的 bootstrap 可能在
    // 代理就绪之前就跑完了。
    if (this.tree) {
      this.bootReady?.then((ok) => {
        if (!this.tree) return;
        if (ok) this.tree.onProxyUp();
        else this.tree.onProxyDown(this.boot ? this.boot.status.detail : "未初始化");
      });
    }

    // ★ 自愈①：修复「data-info 缺斜杠」的自定义块 ★
    //   这类块 DOM 已经是 NodeCustomBlock，只是 data-info 让思源找不到
    //   渲染器 ⇒ 显示裸 JSON。可以直接在 DOM 里就地重绘（不改笔记）。
    //   → 见 embed.js 的 migrateLegacyEmbeds / renderInPlace 注释。
    //
    // ★ 自愈②：升级「反引号围栏残留」的普通代码块 ★
    //   早期实现用 ```nebuladisk，但反引号只会生成 type=c 普通代码块，
    //   前端无法把它变成自定义块 ⇒ 必须改块内容（走内核 API）。
    //   静默执行，失败只记日志，绝不影响正常使用。
    this.startLegacyEmbedWatch();
    this.startLegacyFenceUpgrade();
  }

  async onunload() {
    // ★ 任务④：先把所有已展开的嵌入块收起来 ★
    //   每个展开的块 = 一个 iframe（OO 编辑器可能有几十上百 MB）。
    //   插件卸载/重载时如果不管，这些 iframe 会挂在思源页面上泄漏 ——
    //   尤其开发期反复「关闭插件再打开」，不做这步很快就堆一堆。
    try { collapseAllOpenEmbeds(); } catch (e) { console.log("[nebuladisk] 收起嵌入块失败（忽略）: " + (e && e.message)); }
    if (this._legacyObserver) {
      try { this._legacyObserver.disconnect(); } catch { /* 忽略 */ }
      this._legacyObserver = null;
    }
    if (this._legacyTimer) {
      clearTimeout(this._legacyTimer);
      this._legacyTimer = null;
    }
    if (this._fenceObserver) {
      try { this._fenceObserver.disconnect(); } catch { /* 忽略 */ }
      this._fenceObserver = null;
    }
    if (this._fenceTimer) {
      clearTimeout(this._fenceTimer);
      this._fenceTimer = null;
    }
    if (this.tree) {
      this.tree.destroy();
      this.tree = null;
    }
    if (this.boot) {
      await this.boot.stop();
      this.boot = null;
    }
    if (window.__nebuladiskPlugin === this) {
      // ★ 必须连 external 一起清 ★
      //   契约是挂在实例上的，但消费方（画布等）探测的是
      //   `window.__nebuladiskPlugin.external`。只删单例而留实例引用，
      //   消费方手上那个陈旧引用仍能调到已卸载插件的 API ⇒ 幽灵请求。
      try {
        if (this.external) this.external = null;
      } catch { /* 冻结对象可能拒绝写入，忽略 */ }
      delete window.__nebuladiskPlugin;
    }
    console.log("[nebuladisk] 已卸载");
  }

  async uninstall() {
    await this.removeData(STORAGE_KEY).catch(() => {});
  }

  /* =====================================================================
   * 设置
   * ================================================================== */
  async loadSettings() {
    try {
      const d = await this.loadData(STORAGE_KEY);
      if (d && typeof d === "object") {
        this.settings = { ...DEFAULT_SETTINGS, ...d };
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings() {
    // ★ 地址/端口一变，通道结论就作废 ★
    //   通道是按 serverUrl 缓存的，改了地址必须重探，
    //   否则会拿着旧地址的探测结果去请求新地址（表现为莫名的连不上）。
    const prev = this._lastSavedServer;
    const now = String(this.settings.serverUrl || "").trim();
    if (prev !== undefined && prev !== now) {
      try {
        API.resetChannel();
        diag(`[设置] 网盘地址变更：${prev || "(空)"} → ${now || "(空)"}，已重置通道`);
      } catch { /* ignore */ }
    }
    this._lastSavedServer = now;
    await this.saveData(STORAGE_KEY, this.settings);
  }

  /** cookie 落盘路径（与思源工作区/data/storage 同级，便于清理） */
  cookieFile() {
    const wd = this.workspaceDir();
    if (!wd) return "";
    return `${wd}/storage/nebuladisk.cookie.json`;
  }

  /**
   * 解析思源工作区目录 —— 多级回退。
   *
   * ★ 为什么不能只认 window.siyuan.config.system.workDir ★
   *   实测思源 3.8.4 桌面端**没有** `config.system.workDir` 这个字段
   *   （那是 kernel 侧的 conf，不在前端 config 里）。
   *   只写这一个来源的后果：拿不到 → diagFile() 返回空 → diag() 全部静默，
   *   cookie 也只存内存不落盘。排查时只看到「插件在、但什么都不发生」，
   *   完全是个黑洞。
   *
   * 回退顺序：
   *   ① window.siyuan.config.system.workspaceDir / workDir
   *   ② 从 location 推断（file:///D:/Software/SiYuan/...）
   *   ③ process.cwd()（Electron 渲染进程的 cwd 常是工作区）
   *   逐个用 pickWorkspace 校验（必须含 data/ 或 storage/）后才采纳。
   */
  workspaceDir() {
    if (this._wsDir !== undefined) return this._wsDir;
    const cands = [];
    try {
      const sys = window.siyuan?.config?.system || {};
      cands.push(sys.workspaceDir, sys.workDir);
    } catch { /* 无 window.siyuan */ }

    try {
      const href = String(location.href || "");
      const m = href.match(/file:\/\/\/([A-Za-z]:\/[^/]+\/[^/]+)/);
      if (m) cands.push(decodeURIComponent(m[1]));
    } catch { /* 无 location */ }

    try {
      if (typeof process !== "undefined" && process.cwd) cands.push(process.cwd());
    } catch { /* 无 process */ }

    this._wsDir = pickWorkspace(cands);
    return this._wsDir;
  }

  /**
   * 诊断日志路径。
   *
   * 思源加载插件时抛的异常只进浏览器 console，siyuan.log 里什么都没有；
   * 代理启动失败也是同样下场 —— 外部只看到「插件在、但没数据」。
   * 把关键过程写进这个文件，脚本即可读出真正的错因。
   *
   * ★ 路径必须是「绝对且确定」的 ★
   *   不能用相对路径：思源渲染进程的 cwd 不一定是插件目录，
   *   写出来的文件会跑到莫名其妙的地方，排查时找不到。
   *   这里优先用已知的插件安装目录，其次才猜工作区。
   */
  diagFile() {
    if (this._diagFile !== undefined) return this._diagFile;

    // ★ 放 temp/ 而不是 plugins/ ★
    //   plugins/ 在思源的云同步范围里，诊断日志会被当成插件文件上传，
    //   既污染同步仓库、又会在别人机器上留下无意义的日志。
    //   temp/ 是本地临时目录，不参与同步。
    const wd = this.workspaceDir();
    if (wd) {
      this._diagFile = `${wd}/temp/nebuladisk.log`;
      return this._diagFile;
    }

    // 兜底：从 location 反推插件目录
    try {
      const m = String(location.href || "").match(
        /^(?:file|http[^:]*):\/\/[^/]*(\/[A-Za-z]:\/.*?\/data\/plugins\/[^/]+)/,
      );
      if (m) {
        const dir = normPath(decodeURIComponent(m[1]));
        if (dirExists(dir)) {
          this._diagFile = `${dir}/nebuladisk.log`;
          return this._diagFile;
        }
      }
    } catch { /* ignore */ }

    this._diagFile = "";
    return "";
  }

  openSetting() {
    const s = this.settings;

    /** 所有输入框，用于「点按钮前先同步一遍」 */
    const inputs = [];

    const mkInput = (label, key, type = "text", placeholder = "") => {
      const wrap = document.createElement("div");
      wrap.className = "nb-setting-item";
      wrap.innerHTML = `<label class="nb-setting-label">${label}</label>`;
      const input = document.createElement("input");
      input.className = "b3-text-field fn__block";
      input.type = type;
      input.value = s[key] ?? "";
      input.placeholder = placeholder;
      input.addEventListener("change", () => { s[key] = input.value; });
      // ★ 额外监听 input：边打字边同步，杜绝 change 不触发导致发旧值 ★
      input.addEventListener("input", () => { s[key] = input.value; });
      wrap.appendChild(input);
      inputs.push({ key, input });
      return wrap;
    };

    /**
     * 把 DOM 里的当前值写回 settings。
     * 点按钮时调用 —— 不依赖 change 的触发时机。
     */
    const syncInputs = () => {
      for (const { key, input } of inputs) {
        let v = input.value;
        if (key === "proxyPort") {
          const n = Number(v);
          if (v !== "" && Number.isFinite(n) && n > 0) s[key] = n;
          continue;
        }
        s[key] = v;
      }
    };

    /** 一段灰色说明文字（不参与取值，纯提示） */
    const hint = (text) => {
      const el = document.createElement("div");
      el.className = "nb-setting-hint";
      el.textContent = text;
      return el;
    };

    const box = document.createElement("div");
    box.className = "nb-settings";

    const status = this.boot ? this.boot.status : { ok: false, detail: "未初始化" };
    const banner = document.createElement("div");
    // ★ 徽标语义要区分「直连可用」与「代理可用」★
    //   旧的判断只看代理：地址填对了、后端也开了 CORS，
    //   但因为代理没起来就显示「未就绪」，误导用户去查网络。
    //   现在：有 serverUrl 且（直连探测通过 或 代理就绪）就算可用。
    const hasServer = !!String(s.serverUrl || "").trim();
    const directOk = hasServer && (API.currentKind ? API.currentKind() === "direct" : false);
    const usable = directOk || status.ok;
    banner.className = `nb-settings-banner ${usable ? "is-ok" : "is-warn"}`;
    if (directOk) {
      banner.textContent = `✓ 直连模式 —— ${s.serverUrl}（无需本地代理）`;
    } else if (status.ok) {
      banner.textContent = `✓ 代理模式 —— ${status.detail}`;
    } else {
      banner.textContent = `⚠ 通道未就绪 —— ${status.detail}`;
    }
    box.appendChild(banner);

    box.appendChild(mkInput("网盘地址", "serverUrl", "text", "http://192.168.193.70:8089"));
    box.appendChild(mkInput("用户名", "username"));
    box.appendChild(mkInput("密码（用于自动登录）", "password", "password", "留空则不自动登录"));
    box.appendChild(hint(
      "优先走「直连」：直接请求网盘地址，不需要本地代理，网页端/手机端也能用。" +
      "仅当直连失败（后端未开 CORS 等）时才回退到下面的本地代理。"
    ));
    box.appendChild(mkInput("代理端口（兜底通道）", "proxyPort", "number", "6810"));

    // 自动登录开关
    const rowAuto = document.createElement("div");
    rowAuto.className = "nb-setting-item nb-setting-inline";
    rowAuto.innerHTML = `<label class="nb-setting-label">启动时自动登录</label>`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!s.autoLogin;
    cb.addEventListener("change", () => { s.autoLogin = cb.checked; });
    rowAuto.appendChild(cb);
    box.appendChild(rowAuto);

    // 操作按钮
    const actions = document.createElement("div");
    actions.className = "nb-setting-actions";
    const testBtn = document.createElement("button");
    testBtn.className = "b3-button b3-button--outline";
    testBtn.textContent = this.i18n.settingsVerify || "测试连接";
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      try {
        // ★ 关键：先把输入框里的值同步回 settings ★
        //   mkInput 只在 change 事件里赋值，而 change 只在「失焦且值变了」时触发。
        //   点按钮虽然会先 blur，但同步顺序不保证，容易把旧值发出去。
        syncInputs();
        await this.saveSettings();

        // ★ 测试要按「实际会用的通道」来测 ★
        //   旧版无条件重启代理再测 —— 但直连模式压根不用代理，
        //   代理起不来时会把「网络明明是通的」误报成失败。
        //   现在先作废通道缓存、重新探测，让 pickChannel 自己决定。
        API.resetChannel();
        if (this.boot) { await this.boot.stop(); }
        this.boot = new ProxyBoot(this);
        // 探测是异步且非阻塞的：直连可用就不必真去起代理
        const kind = await API.currentKindAsync();

        if (kind === "proxy") {
          // 回退到代理时才需要它真的起来
          const ok = (await this.boot.startInline()) || (await this.boot.probeExternal());
          if (!ok) throw new Error(this.boot.status.detail);
        }

        const me = await API.me();
        diag(`[测试连接] 通道=${kind} /api/me 原始返回: ${JSON.stringify(me)}`);
        const name = me?.username || me?.display || this.settings.username || "已连接";
        const n = Array.isArray(me?.mounts) ? me.mounts.length : 0;
        showMessage(`✓ 连接成功（${kind === "direct" ? "直连" : "代理"}）：${name}，可见 ${n} 个盘`);
      } catch (e) {
        showMessage(`✗ ${e.message}`, 6000, "error");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = this.i18n.settingsVerify || "测试连接";
      }
    };

    const loginBtn = document.createElement("button");
    loginBtn.className = "b3-button b3-button--outline";
    loginBtn.textContent = "立即登录";
    loginBtn.onclick = async () => {
      try {
        syncInputs();
        await this.saveSettings();
        if (!s.password) {
          throw new Error("请先填写密码（用于登录网盘）");
        }
        const r = await API.login(s.username, s.password);
        diag(`[立即登录] /api/login 原始返回: ${JSON.stringify(r)}`);
        const name = r?.display || r?.username || s.username;
        showMessage(`已登录：${name}`);
        // 登录成功后顺手把盘列表拉一次，便于立刻在侧边栏看到
        if (this.tree) this.tree.refresh();
      } catch (e) {
        showMessage(`登录失败：${e.message}`, 6000, "error");
      }
    };

    actions.appendChild(testBtn);
    actions.appendChild(loginBtn);
    box.appendChild(actions);

    const dlg = new Dialog({
      title: this.i18n.settingsTitle || "NebulaDisk 设置",
      content: `<div class="b3-dialog__content nb-dialog-content"></div>`,
      width: "620px",
      height: "560px",
    });
    dlg.element.querySelector(".nb-dialog-content").appendChild(box);

    dlg.bindInput(async () => {
      await this.saveSettings();
      dlg.destroy();
      // ★ 2026-09-28：原为 refresh(true)（会清空展开状态）。该能力已随
      //   「刷新并重置展开状态」菜单项一起移除，refresh() 也不再接受该参数
      //   —— 留着 true 是"看着有效、实则被忽略"的死参数。
      if (this.tree) this.tree.refresh();
      return true;
    });
  }

  /* =====================================================================
   * 会话
   * ================================================================== */
  async tryAutoLogin() {
    const u = String(this.settings.username || "").trim();
    const p = String(this.settings.password || "");
    // ★ 凭据不全时不要发请求 ★
    //   后端 /api/login 的 username/password 都是 Form(...) 必填，
    //   空表单会被 FastAPI 直接判 422（detail: Field required）。
    //   以前不做检查就发，日志里平白多出一条 422，看着像故障。
    if (!u || !p) {
      diag(`[会话] 跳过自动登录：用户名/密码未填写（u=${u ? "有" : "空"} p=${p ? "有" : "空"}）`);
      return false;
    }
    try {
      const r = await API.login(u, p);
      const name = (r && (r.display || r.username)) || u;
      const ch = API.currentKind();
      diag(`[会话] 自动登录成功（通道=${ch}）：${name}${r && r.token ? "（已取得直连 token）" : ""}`);
      this._unauthorized = false;
      return true;
    } catch (e) {
      diag(`[会话] 自动登录失败：${e && e.message}`);
      return false;
    }
  }

  /** 供界面调用的「确保已登录」 */
  /**
   * 是否可以绕过本地代理直接用直连通道。
   *
   * 直连只需一个条件：**配了网盘地址**。
   * 不需要代理、不需要端口、不需要任何本地 Node 进程。
   *
   * ★ 为什么单独抽一个方法 ★
   *   bootstrap 里原本写死了「等 boot.status.ok」——
   *   那是**代理**的启动状态。但直连通道根本不用代理，
   *   于是"地址配好了、代理因端口占用没起来"时面板会卡死在
   *   「通道未就绪」，而网络其实是通的。
   *   把它抽出来，语义从「代理好了吗」变成「有路能走后端吗」。
   */
  canSkipProxy() {
    const u = String((this.settings && this.settings.serverUrl) || "").trim();
    return !!u;
  }

  async ensureLogin() {
    // 直连通道下不需要等任何本地服务 —— API.hasSession 会按通道自己判断
    try {
      const s = await API.hasSession();
      if (s && s.hasSession) return true;
    } catch (e) {
      // ★ 以前这里是静默 catch ★
      //   于是「通道不通」与「没登录」表现一样（都返回 false），
      //   界面永远渲染登录框，用户填了密码也登不上，却看不到原因。
      diag(`[会话] hasSession 检查失败：${e && e.message}`);
    }
    // 尝试用设置的账号自动登录
    if (this.settings.password) {
      const ok = await this.tryAutoLogin();
      if (ok) return true;
    }
    return false;
  }

  /* =====================================================================
   * 面板与页签
   * ================================================================== */
  /**
   * 初始化侧边栏面板。
   *
   * ★ 幂等保护 ★
   *   思源在「每次打开面板 / 切换页签 / 恢复布局」时都会重新 init 一次 dock，
   *   而 initDock 每次都 new 一个 FileTree，新实例会立刻 bootstrap() →
   *   loadMounts() → loadRoot() → GET /api/list。
   *   实测后果：18 秒内打了 1600+ 次 /api/list（诊断日志被刷爆，
   *   网盘连接数暴涨）。旧实例又没被销毁，等于越开越多。
   *
   *   这里的做法：
   *     ① 复用已有实例 —— 若它仍挂在同一 element 上，只做一次刷新；
   *     ② 换 element 了（思源重建了面板容器）才新建，并先销毁旧的。
   */
  initDock(dock) {
    const el = dock.element;
    const prev = this.tree;
    if (prev && !prev.destroyed && prev.el === el) {
      // 同一容器：不重建，只重绘一次即可
      diag("initDock: 复用已有 FileTree（避免重复 bootstrap）");
      prev.render();
      return;
    }
    if (prev && !prev.destroyed) {
      diag("initDock: 容器已变，销毁旧 FileTree 后重建");
      try { prev.destroy(); } catch { /* 忽略 */ }
    }
    this.tree = new FileTree(this, el);
    this.tree.render();
  }

  /**
   * 展开/聚焦侧边栏面板
   *
   * 思源没有公开「展开指定 dock」的 API，私有布局对象在各版本间形态不一。
   * 因此这里按可靠性从高到低依次尝试，最后退化为一句提示：
   *   ① 面板已在 DOM 里（用户之前展开过）→ 直接把它滚进视野
   *   ② 面板未展开 → 去点击思源侧栏上那个对应的图标按钮
   *   ③ 都失败 → 提示用户手动点击
   */
  openDockPanel() {
    // 侧栏上代表本面板的图标按钮（属 panel 类，点击即展开/收起）
    // 思源内部把 dock 标识拼成「插件名 + type」，所以优先按完整标识找；
    // 再退化为只按 type 找（不同版本前缀拼法可能不同）。
    const sels = [
      `.dock__item[data-type="${DOCK_TYPE_FULL}"]`,
      `.dock__item[data-type="${PLUGIN_NAME}${DOCK_TYPE}"]`,
      `.dock__item[data-type="${DOCK_TYPE}"]`,
      `.dock__item[data-type$="${DOCK_TYPE}"]`,
    ];
    for (const sel of sels) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.scrollIntoView({ block: "nearest", inline: "nearest" });
        btn.click();
        return;
      }
    }
    showMessage("请点击右侧边栏的 NebulaDisk 图标展开面板", 4000);
  }

  /**
   * 打开一个网盘文件（预览或编辑）
   * @param {{mount:string,path:string,name:string,ext?:string}} item
   */
  openFile(item, opts = {}) {
    // ★ 任务⑲：页签标题要能看出"这是哪个文档/哪条路径" ★
    //
    //   用户原话：「在页签中，如何知道嵌入的具体文档是那个？」
    //
    //   原来标题只有 `item.name`（纯文件名）。一篇笔记里嵌入
    //   「/研发立项/A项目/图纸/v1.dwg」和「/工艺/B项目/图纸/v1.dwg」时，
    //   两个页签都叫 "v1.dwg"，完全分不清。
    //
    //   改成「文件名 · 挂载点」，并在 title 属性/信息条里保留完整路径：
    //     · 页签宽度有限，把完整路径塞进标题会被思源截断成 "…"，
    //       反而看不清；所以标题给「name · mount」，信息条给全路径。
    //     · 文件名与人眼识别最相关，必须排在最前 —— 页签被截断时
    //       最先保住的就是它。
    //
    //   显式给了 title 就尊重调用方的（某些入口会自定义标题）。
    const mountTag = String(item.mount || "").trim();
    const base = item.name || item.path || "NebulaDisk";
    const title = opts.title
      || (mountTag ? `${base} · ${mountTag}` : base);
    openTab({
      app: this.app,
      custom: {
        id: this.name + TAB_TYPE,
        icon: "iconNebulaDisk",
        title,
        data: { ...item, ...opts },
      },
    });
  }

  /**
   * 在右侧文件树里定位到 `mount:/path`（任务⑳）。
   *
   * 嵌入块上的「定位」按钮走这里；插件的树面板随时可能没挂载
   *   （用户把 NebulaDisk 面板关了 / 还没打开），所以要给出明确反馈，
   *   而不是静默失败。
   *
   * @returns {Promise<boolean>} 是否真的定位到了
   */
  async revealTree(mount, path) {
    if (!this.tree) {
      showMessage("请先打开右侧的 NebulaDisk 文件树面板", 4000, "info");
      return false;
    }
    const ok = await this.tree.revealPath(mount, path);
    if (!ok) showMessage("文件树里没有找到该路径（可能需要先刷新）", 4000, "info");
    return ok;
  }

  /* =====================================================================
   * 笔记内嵌（需求 ③）
   * ================================================================== */
  /**
   * 持续修复「旧写法」的嵌入块。
   *
   * ★ 为什么要持续，而不是只做一次 ★
   *   思源是**按需渲染**的：滚动、切换文档、编辑都会重建块的 DOM，
   *   每次重建都会把旧写法的块又渲染成裸 JSON。
   *   所以不能只在启动时扫一遍，必须盯着 DOM 变化补渲染。
   *
   * 用 MutationObserver 监听整棵 body，回调里做一次廉价的
   * querySelectorAll（块数量很少），再调 migrateLegacyEmbeds。
   * 用节流把连续的 DOM 变动合成一次，避免频繁触发深度遍历。
   */
  startLegacyEmbedWatch() {
    const run = () => {
      try { migrateLegacyEmbeds(this); } catch (e) { diag(`[legacy-embed] 失败: ${e && e.message}`); }
    };

    // ① 首次：等布局稳定后扫一遍
    setTimeout(run, 1200);
    setTimeout(run, 3000);

    // ② 之后：DOM 变化就补一次（节流 400ms）
    if (this._legacyTimer) return;
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      this._legacyTimer = setTimeout(() => {
        pending = false;
        run();
      }, 400);
    };
    try {
      this._legacyObserver = new MutationObserver((muts) => {
        // 只关心「新增了自定义块」这类变化，避免无谓开销
        for (const m of muts) {
          if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) { schedule(); return; }
        }
      });
      this._legacyObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      diag(`[legacy-embed] MutationObserver 不可用: ${e && e.message}`);
    }
  }

  /* ---------------------------------------------------------------------
   * 反引号围栏残留的升级（必须走内核 API）
   *
   * 背景：早期实现往笔记里插的是
   *     ```nebuladisk
   *     {"kind":"file",...}
   *     ```
   * 但反引号围栏在思源里**只生成普通代码块 type=c**，不是自定义块
   * （实测确认），所以这些块永远显示裸 JSON。
   *
   * 前端 DOM 无法把 type=c 变成 type=custom，唯一办法是**改块内容**。
   * 这里用 /api/block/updateBlock（dataType="dom"）提交正确的块 HTML，
   * 让内核负责把内容重新序列化成 `;;;插件名/块类型 … ;;;` 的 kramdown。
   *
   * 为什么提交 dom 而不是 markdown：
   *   updateBlock 的 dataType 只接受 "markdown" 或 "dom"。
   *   传 "markdown" 时，`;;;` 围栏是**块级语法**，会被当成普通段落处理，
   *   不会升级成自定义块；只有传真正的 NodeCustomBlock DOM 才行。
   *   data-info / data-content 由我们给出，内核会原样收下（已验证）。
   *
   * 安全性：
   *   · 只处理「语言串是本插件相关写法 且 内容是含 mount 的 JSON」的块
   *   · 每个块只升级一次（记在内存 Set 里，避免反复提交抖动）
   *   · 任何异常都吞掉只记日志 —— 自愈功能绝不能影响正常编辑
   * ------------------------------------------------------------------- */
  startLegacyFenceUpgrade() {
    if (this._fenceUpgraded) return;
    this._fenceUpgraded = new Set();

    const run = () => {
      let found;
      try { found = findLegacyFenceBlocks(this); } catch (e) { diag(`[legacy-fence] 扫描失败: ${e && e.message}`); return; }
      for (const hit of found) {
        if (this._fenceUpgraded.has(hit.id)) continue;
        this._fenceUpgraded.add(hit.id);
        this.upgradeFenceBlock(hit).catch((e) => diag(`[legacy-fence] 升级 ${hit.id} 失败: ${e && e.message}`));
      }

      // ★ 第三种残留形态：`;;;` 围栏整段留成了普通段落 ★
      //   见 src/embed.js 的注释：段落无法原地升级，只能删掉再按 markdown 重插。
      let paras;
      try { paras = findParagraphFences(this); } catch (e) { diag(`[legacy-fence] 段落扫描失败: ${e && e.message}`); return; }
      for (const hit of paras) {
        if (this._fenceUpgraded.has(hit.id)) continue;
        this._fenceUpgraded.add(hit.id);
        this.repairParagraphFence(hit).catch((e) => diag(`[legacy-fence] 段落修复 ${hit.id} 失败: ${e && e.message}`));
      }
    };

    // 文档渲染是异步的，多探几次
    setTimeout(run, 1500);
    setTimeout(run, 3500);
    setTimeout(run, 7000);

    // 切换文档也会带来新的残留块
    if (!this._fenceObserver) {
      let t = null;
      try {
        this._fenceObserver = new MutationObserver(() => {
          if (t) return;
          t = setTimeout(() => { t = null; run(); }, 800);
          this._fenceTimer = t;
        });
        this._fenceObserver.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        diag(`[legacy-fence] MutationObserver 不可用: ${e && e.message}`);
      }
    }
  }

  /**
   * 把一个「反引号围栏残留」的代码块升级成自定义块。
   * @param {{id:string, json:string}} hit
   */
  async upgradeFenceBlock(hit) {
    const info = `${this.name}/nebuladisk`;
    const esc = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    // 与内核自己序列化出来的形状一致：
    //   <div data-node-id data-type="NodeCustomBlock" data-info data-content
    //        class="custom-block">
    //     <div class="custom-block__content"><pre>…</pre></div>
    //     <div class="protyle-attr" contenteditable="false">ZWSP</div>
    //   </div>
    const html =
      `<div data-node-id="${hit.id}" data-type="NodeCustomBlock"` +
      ` data-info="${esc(info)}" data-content="${esc(hit.json)}"` +
      ` class="custom-block">` +
      `<div class="custom-block__content"><pre>${esc(hit.json)}</pre></div>` +
      `<div class="protyle-attr" contenteditable="false">\u200b</div>` +
      `</div>`;

    const r = await fetch("/api/block/updateBlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: hit.id, dataType: "dom", data: html }),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.msg || "updateBlock 返回非 0");
    diag(`[legacy-fence] 已把 ${hit.id} 从代码块升级为 NebulaDisk 嵌入块`);
  }

  /**
   * 修复「`;;;` 围栏整段留成普通段落」的块。
   *
   * ★ 为什么不能用 updateBlock ★
   *   实测 v3.8.4：给一个 type=p 的块传 NodeCustomBlock DOM，
   *   updateBlock 返回 code=0，但块类型**仍然是 p**（DOM 被当段落吸收了）。
   *   传 dataType="markdown" 也一样 —— `;;;` 不会在已有段落里重新解析。
   *
   * ⇒ 唯一可靠做法：**删掉这个段落，再按 markdown 插到同一位置**。
   *   插入用 dataType="markdown"，内核会正确生成 NodeCustomBlock
   *   （已实测：新建文档时 `;;;` 能生成 type=custom）。
   *
   * 位置保持：先记住它的 parentID 和 previousID，删除后插回原位。
   *
   * @param {{id:string, json:string, info:string}} hit
   */
  async repairParagraphFence(hit) {
    // ① 记下位置（父块 + 前一个兄弟），删除后才能插回原处
    const info = await fetch("/api/query/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stmt: `SELECT parent_id, id FROM blocks WHERE id='${hit.id}'`,
      }),
    }).then((r) => r.json()).catch(() => null);

    const parentId = info && info.data && info.data[0] && info.data[0].parent_id;
    if (!parentId) throw new Error("拿不到父块 id，放弃修复");

    // ★ 不要把「文档自身」当父块来插 ★
    //   实测：root_id 与 id 相同的块就是文档根（type=d）。
    //   往文档根 insertBlock 是允许的，但如果 parentId 来自过时索引、
    //   指向了一个已被删除的块，insertBlock 会静默失败或者插到别处。
    const rootCheck = await fetch("/api/query/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stmt: `SELECT id, type FROM blocks WHERE id='${parentId}'`,
      }),
    }).then((r) => r.json()).catch(() => null);
    if (!rootCheck || !rootCheck.data || !rootCheck.data[0]) {
      throw new Error("父块已不存在，放弃修复");
    }

    // 找同父块里、排在它前面的那个兄弟（用来定位插入点）
    const sib = await fetch("/api/query/sql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stmt:
          `SELECT id FROM blocks WHERE parent_id='${parentId}' ` +
          `AND id < '${hit.id}' ORDER BY id DESC LIMIT 1`,
      }),
    }).then((r) => r.json()).catch(() => null);
    const prevId = sib && sib.data && sib.data[0] && sib.data[0].id;

    // ② 先解析参数 —— 解析失败就别删了，避免「删掉了旧的、又插不进新的」把内容弄丢
    let obj = null;
    try { obj = JSON.parse(hit.json); } catch { /* 下面报错 */ }
    if (!obj || !obj.mount) throw new Error("嵌入参数无法解析，放弃修复（原块保留）");

    // ③ 删掉这个段落块
    const del = await fetch("/api/block/deleteBlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: hit.id }),
    }).then((r) => r.json());
    if (del.code !== 0) throw new Error((del.msg || "deleteBlock 失败"));

    // ④ 用正确的 markdown（`;;;` 围栏）插回原位置
    //    ★ 内核的 insertBlock 会自己管理插入产生的空段落，
    //      但若 previousID 指向的兄弟也刚被删掉，内核可能把内容插到
    //      文档末尾并留下一个空段。所以插完要回查确认，失败就把内容补回去。
    const md = buildEmbedMarkdown(this.name, obj);
    const body = { dataType: "markdown", data: md, parentID: parentId };
    if (prevId) body.previousID = prevId;

    const ins = await fetch("/api/block/insertBlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (ins.code !== 0) {
      throw new Error((ins.msg || "insertBlock 失败") + "（原段落已删除，请注意）");
    }

    // ⑤ 回查：确认文档里真的多了一个 custom 块
    const newId =
      ins.data && ins.data[0] && ins.data[0].doOperations &&
      ins.data[0].doOperations[0] && ins.data[0].doOperations[0].id;
    if (newId) {
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const chk = await fetch("/api/query/sql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stmt: `SELECT type FROM blocks WHERE id='${newId}'` }),
        }).then((r) => r.json()).catch(() => null);
        const t = chk && chk.data && chk.data[0] && chk.data[0].type;
        if (t) { ok = t === "custom"; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!ok) {
        diag(`[legacy-fence] ⚠️ 段落 ${hit.id} 重建后未查到 custom 块（${newId}），请检查该文档`);
        return;
      }
      diag(`[legacy-fence] ✅ 已把段落 ${hit.id} 重建成 NebulaDisk 嵌入块（新块 ${newId}）`);
      return;
    }
    diag(`[legacy-fence] 已把段落 ${hit.id} 重建成 NebulaDisk 嵌入块（拿不到新块 id，未校验）`);
  }

  /**
   * 弹出一个「选择网盘文件/目录」的对话框，选完插入嵌入块
   *
   * @param {any} protyle 当前编辑器（斜杠菜单会给）
   * @param {"tree"|"file"} kind
   * @param {Element|null} [anchorEl] ★ 斜杠菜单交过来的「光标所在块元素」
   *
   *   ★★★ 这个第三参数是 2026-09-22 修「插入位置错」与「残留 /」的关键 ★★★
   *
   *   从思源 main.js 里读出的斜杠菜单契约（唯一可信来源）：
   *
   *     }else if(n.startsWith("plugin") && Em(D)){
   *         D.app.plugins.find(on=>{ ... cn.callback(D.getInstance(), ht), !0 });
   *         return;                    // ← 直接返回，**不**执行 He.deleteContents()
   *     }else{
   *         He.deleteContents(),       // ← 思源自带的斜杠项都会先删掉用户敲的 /xxx
   *         ...
   *     }
   *
   *   ⇒ 两个后果，都是插件必须自己承担的：
   *     1. 位置：真正该插到哪儿，得由插件的 locateInsertPoint 自己判断。
   *        只传 protyle 不够 —— 文档级 protyle.block.id === rootID，
   *        会被误当成「文档块」→ previousID 为空 → **追加到文末**（用户报的 bug）。
   *     2. 残留：`/网盘` 这串触发文本没人删，就留在段落里（用户报的 bug）。
   *
   *   ⇒ 把 `el`（= ht，带 data-node-id 的块元素）原样传下去，
   *     embed.js 用它做「精确锚点」并在插好后清理斜杠残留。
   */
  async pickAndEmbed(protyle, kind, anchorEl) {
    // ★★★ 不再「拿不到 protyle 就 return」★★★
    //
    //   2026-09-22 教训：三处插入点（斜杠菜单 / 侧边栏 / 预览页）原先**各自**
    //   在入口处判空并直接 return，导致 locateInsertPoint 的多级回退
    //   （聚焦页签 data-id / data-initdata / layout 遍历）永远没机会跑。
    //   用户明明开着文档，却被提示"请在文档编辑器中执行此操作"。
    //
    //   ⇒ 定位收敛到 embed.js：这里把 protyle 原样传下去（可以为 null）。
    //     斜杠菜单场景 protyle 通常有值，但它也可能是被思源复用过的旧实例，
    //     所以依旧以 locateInsertPoint 的实际探测结果为准。
    const picker = new Picker(this, kind, (result) => {
      // ★ 任务26b：onPick 现在可能拿到**数组**（多选批量）。
      //   旧调用方传单个对象，这里统一成数组，走同一条批量插入路径 ——
      //   单选就是「长度为 1 的批量」，不必维护两套代码。
      const specs = (Array.isArray(result) ? result : [result]).map((r) =>
        kind === "tree"
          ? { kind, mount: r.mount, path: r.path }
          : { kind, mount: r.mount, path: r.path, name: r.name }
      );
      // ★ 逐个按顺序插入 ⇒ 笔记里就是按用户排好的顺序，从上到下多个嵌入块 ★
      (async () => {
        let okCount = 0;
        let firstErr = null;
        for (const spec of specs) {
          try {
            const ok = await insertEmbedIntoDoc(this, protyle, spec, {
              anchorEl: anchorEl || null,
              fromSlash: !!anchorEl,
            });
            if (ok) okCount++;
            else firstErr = firstErr || "内核没有生成自定义块";
          } catch (e) {
            try {
              if (e && e.trace) console.log("[nebuladisk] 定位轨迹: " + e.trace);
            } catch { /* 忽略 */ }
            firstErr = firstErr || ((e && e.message) || "未知原因");
          }
        }
        if (specs.length === 1) {
          showMessage(okCount ? "已插入网盘嵌入块"
                              : `插入失败：${firstErr || "未知原因"}`);
        } else {
          showMessage(okCount === specs.length
            ? `已插入 ${okCount} 个网盘嵌入块`
            : `插入 ${okCount}/${specs.length} 个成功${firstErr ? "：" + firstErr : ""}`);
        }
      })();
      return;
    });
    await picker.open();
  }
}

/* -------------------------------------------------------------------------
 * 文件 / 目录选择器
 *
 * 复用 API.list 逐层下钻，最后确认选择。
 * ---------------------------------------------------------------------- */
class Picker {
  constructor(plugin, kind, onPick) {
    this.plugin = plugin;
    this.kind = kind;
    this.onPick = onPick;
    this.mount = null;
    this.path = "";
    this.dialog = null;
    this.mounts = [];
    // ★ 任务24a：搜索状态 ★
    this.query = "";          // 当前关键词（空 = 浏览模式）
    this._searchToken = 0;    // 丢弃过期响应（与侧边栏同一套防竞态手法）
    this._searchTimer = null; // 防抖
    // ★ 任务26b：多选状态 ★
    //   _picked 是**有序**数组（顺序 = 用户排列顺序 = 插入到笔记的顺序）。
    //   用数组而不是 Set：Set 保不住顺序，而「上下拖动排序」正是本任务的要点。
    //   每项形如 { mount, path, name, size, ext }，path 是相对挂载根的完整路径。
    this._picked = [];
    // 用于 Shift 连选：记住上一次点击的行索引（在当前可见列表里的下标）
    this._lastIdx = -1;
    this._rows = [];          // 当前列表的可见行数据（供 Shift 连选 / 全选）
  }

  async open() {
    let me;
    try {
      await this.plugin.ensureLogin();
      me = await API.me();
    } catch (e) {
      showMessage(`无法连接网盘：${e.message}`, 6000, "error");
      return;
    }
    this.mounts = me.mounts || [];
    if (!this.mounts.length) {
      showMessage("没有可访问的网盘目录");
      return;
    }
    this.mount = this.plugin.settings.defaultMount && this.mounts.some(m => m.label === this.plugin.settings.defaultMount)
      ? this.plugin.settings.defaultMount
      : this.mounts[0].label;

    const wrap = document.createElement("div");
    wrap.className = "nb-picker";
    // ★ 任务24a：新增搜索栏（和侧边栏搜索同一套后端 /api/search）★
    //   用户原话：「插入文档树 / 插入文档 弹出窗口上增加搜索功能，
    //             和侧边窗口搜索功能一样。」
    //   ⇒ 同一个 API.search(mount, q, "", limit)、同样的防抖 + token 防竞态、
    //     同样的"含未展开子目录、层级最深也能搜到"。
    wrap.innerHTML = `
      <div class="nb-picker-head">
        <select class="b3-select nb-picker-mount"></select>
        <span class="nb-picker-path">/</span>
      </div>
      <div class="nb-picker-search">
        <input class="b3-text-field fn__block nb-picker-q" type="text"
               placeholder="搜索全部文件（含未展开的子目录），支持 pdf、*.png、zip,rar" />
      </div>
      <div class="nb-picker-list fn__flex-1"></div>
      <div class="nb-picker-tray">
        <div class="nb-picker-trayhead">
          <span class="nb-picker-traytitle">已选 0 项（可上下拖动调整插入顺序）</span>
          <button class="b3-button b3-button--outline nb-picker-clear" title="清空已选">清空</button>
        </div>
        <div class="nb-picker-traybody"></div>
      </div>
      <div class="nb-picker-foot">
        <span class="nb-picker-hint"></span>
        <button class="b3-button b3-button--outline nb-picker-cancel">取消</button>
        <button class="b3-button b3-button--text nb-picker-ok">选择当前目录</button>
      </div>`;

    const sel = wrap.querySelector(".nb-picker-mount");
    for (const m of this.mounts) {
      const o = document.createElement("option");
      o.value = m.label;
      o.textContent = m.label;
      if (m.label === this.mount) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      this.mount = sel.value;
      this.path = "";
      // 换盘时清空搜索，回到浏览模式（否则会拿着旧盘的搜索结果看新盘）
      this.query = "";
      if (this.qInput) this.qInput.value = "";
      this.load();
    };

    wrap.querySelector(".nb-picker-cancel").onclick = () => this.dialog.destroy();
    wrap.querySelector(".nb-picker-ok").onclick = () => this.finish();
    wrap.querySelector(".nb-picker-clear").onclick = () => {
      this._picked = [];
      this._lastIdx = -1;
      this.syncTray();
      this.load();
    };

    // ★ 搜索框接线 ★
    this.qInput = wrap.querySelector(".nb-picker-q");
    this.qInput.oninput = () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.query = this.qInput.value.trim();
        this.load();
      }, 300);
    };
    this.qInput.onkeydown = (ev) => {
      // Esc：先清搜索（回到浏览），再按一次才关窗 —— 与侧边栏习惯一致
      if (ev.key === "Escape" && this.query) {
        ev.stopPropagation();
        this.qInput.value = "";
        this.query = "";
        this.load();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
      }
    };

    this.listEl = wrap.querySelector(".nb-picker-list");
    this.pathEl = wrap.querySelector(".nb-picker-path");
    this.hintEl = wrap.querySelector(".nb-picker-hint");
    // ★ 任务26b：已选区 ★
    this.trayBodyEl = wrap.querySelector(".nb-picker-traybody");
    this.trayTitleEl = wrap.querySelector(".nb-picker-traytitle");
    this._okBtn = wrap.querySelector(".nb-picker-ok");

    /*
     * ★★★ #64：对话框尺寸收窄 ★★★
     *
     *   用户原话：「插入嵌入块时，弹出的『选择要嵌入的文件』，
     *             每个文件太高了，而且宽度很长。」
     *
     *   行高在 index.css 的 .nb-picker-row 里压（30px → 24px）。
     *   这里管**宽度**：640px 对一个「盘名 + 路径 + 一列文件名 + 大小」
     *   的选择器来说偏宽 —— 文件名根本用不到那么长，反而让对话框在
     *   窄屏（或思源侧边栏并排时）显得很霸道。
     *   ⇒ 收到 520px：仍能容下「盘名下拉 160px + 路径」，
     *     长文件名照旧走 ellipsis，不影响信息量。
     *
     *   高度同时略降（560 → 500）：因为行变矮了，同样的文件数占用更少高度，
     *   整体看着更紧凑；列表本身是 flex-1 + overflow，少 60px 不影响可浏览性。
     */
    this.dialog = new Dialog({
      title: this.kind === "tree" ? "选择要嵌入的目录" : "选择要嵌入的文件",
      content: `<div class="b3-dialog__content nb-dialog-content"></div>`,
      width: "520px",
      height: "500px",
    });
    this.dialog.element.querySelector(".nb-dialog-content").appendChild(wrap);

    await this.load();
  }

  /**
   * 加载列表。
   *   · query 为空 ⇒ 浏览模式：API.list(mount, path)（和以前完全一样）
   *   · query 非空 ⇒ 搜索模式：API.search(mount, q, "", 500)（后端递归）
   *
   * ★ 任务24a ★ 搜索模式下不显示".. 上一级"和面包屑的层级含义会变淡，
   *   所以路径栏改成显示"搜索：关键词"。
   */
  async load() {
    // ★ 任务26b：每次重渲染都要重置可见行索引（Shift 连选依赖它）★
    this._rows = [];
    // ---- 搜索模式 ----
    if (this.query) {
      const token = (this._searchToken || 0) + 1;
      this._searchToken = token;
      this.listEl.innerHTML = `<div class="nb-picker-loading">搜索中…</div>`;
      this.pathEl.textContent = `搜索：${this.query}`;

      let r;
      try {
        r = await API.search(this.mount, this.query, "", 500);
      } catch (e) {
        if (token !== this._searchToken) return;
        this.listEl.innerHTML = `<div class="nb-picker-error">搜索失败：${(e && e.message) || e}</div>`;
        return;
      }
      if (token !== this._searchToken) return;   // 过期响应，丢弃
      this.renderSearch(r);
      return;
    }

    // ---- 浏览模式（原逻辑）----
    this._searchToken = (this._searchToken || 0) + 1;  // 作废在途搜索响应
    this.listEl.innerHTML = `<div class="nb-picker-loading">加载中…</div>`;
    let data;
    try {
      data = await API.list(this.mount, this.path);
    } catch (e) {
      this.listEl.innerHTML = `<div class="nb-picker-error">${e.message}</div>`;
      return;
    }
    this.path = data.path === "/" ? "" : (data.path || "").replace(/^\//, "");
    this.pathEl.textContent = "/" + this.path;

    const entries = data.entries || [];
    this.listEl.innerHTML = "";

    // 上级目录
    if (this.path) {
      const up = document.createElement("div");
      up.className = "nb-picker-row nb-picker-up";
      up.innerHTML = `<span class="nb-picker-ico">↰</span><span class="nb-picker-name">.. 上一级</span>`;
      up.onclick = () => {
        const i = this.path.lastIndexOf("/");
        this.path = i < 0 ? "" : this.path.slice(0, i);
        this.load();
      };
      this.listEl.appendChild(up);
    }

    if (!entries.length) {
      this.listEl.innerHTML = `<div class="nb-picker-loading">此文件夹为空</div>`;
    }

    for (const e of entries) {
      this.listEl.appendChild(this.makeRow(e, e.name));
    }

    this.hintEl.textContent = this.kind === "tree"
      ? `将嵌入目录：${displayMountPath(this.mount, this.path)}`
      : (this._picked.length
          ? `已选 ${this._picked.length} 项，点「插入」写入笔记`
          : "单击文件选入（Ctrl 多选 / Shift 连选），双击直接插入");
    // ★ 任务26b：列表重绘后同步「已选」区与确定按钮文案 ★
    this.syncTray();
  }

  /** 搜索模式的结果列表（任务24a）—— 与侧边栏结果面板同源数据 */
  renderSearch(r) {
    const hits = (r && r.hits) || [];
    this.listEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "nb-picker-shead";
    // ★ 任务24b ★ 后端现在会给真实命中总数 total（与 limit 无关）。
    //   原来这里只写 `${hits.length} 个结果`，页面上限 500 时会显示「500 个结果」，
    //   用户以为「就这么多」，其实是「只给你看了 500 个」。
    //   现在优先显示 `已显示 / 总数`。
    const shown = hits.length;
    const total = (r && typeof r.total === "number") ? r.total : null;
    let msg = `${shown} 个结果`;
    if (total !== null && total > shown) msg = `${shown} / ${total} 个结果`;
    if (r && r.scanned) msg += ` · 扫描 ${r.scanned} 项`;
    head.textContent = msg;
    this.listEl.appendChild(head);

    // ★ 提示语也必须基于 total 判断「是否真的还有更多」★
    //   以前用 hits.length 拼「结果超过 500 条已截断」，在 total=4526 时
    //   语义勉强对；但 total<=limit 时也会误报。现在只在确实有下一页时提示。
    const more = !!(r && (r.hasMore || (total !== null && total > shown)));
    if (more || (r && r.depthCapped)) {
      const warn = document.createElement("div");
      warn.className = "nb-picker-swarn";
      const bits = [];
      if (more) {
        bits.push(total !== null
          ? `共 ${total} 条，当前最多显示 ${shown} 条`
          : `结果超过 ${shown} 条`);
        bits.push("缩小关键词可看到其余结果");
      }
      if (r && r.depthCapped) bits.push("目录过深/过多，未全部扫描");
      warn.textContent = "⚠ " + bits.join("；");
      this.listEl.appendChild(warn);
    }

    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "nb-picker-loading";
      empty.textContent = "没有匹配的文件";
      this.listEl.appendChild(empty);
      this.hintEl.textContent = `搜索「${this.query}」无结果`;
      return;
    }

    for (const e of hits) {
      // 搜索结果跨层级 ⇒ 副标题显示所在目录，用户才知道选的是哪一个
      const dir = String(e.path || "").replace(/\/[^/]*$/, "");
      this.listEl.appendChild(this.makeRow(e, e.name, dir || "/"));
    }
    this.hintEl.textContent = this.kind === "tree"
      ? `搜索「${this.query}」：双击目录进入，或用下方按钮选择当前目录`
      : `搜索「${this.query}」：单击选入，Ctrl 多选 / Shift 连选`;
    // ★ 任务26b：搜索结果重绘后同样要同步「已选」区 ★
    this.syncTray();
  }

  /** 一行（浏览 / 搜索共用）。sub = 副标题（搜索结果用来显示所在路径） */
  makeRow(e, label, sub) {
    const row = document.createElement("div");
    row.className = "nb-picker-row";
    // ★ 任务25b ★ 原来这里是 emoji（📁 / 📄），和侧边栏/网格的彩色类型图标
    //   完全两套视觉，用户明确要求「文件夹和文件图标需要调整一下」。
    //   ⇒ 统一走 typeIconEl()：目录拿真正的文件夹图标，文件按扩展名拿
    //     彩色徽标（PDF 红、3D 青、SRC 灰蓝…），与侧边栏一致。
    row.innerHTML = `<span class="nb-picker-ico"></span>
                     <span class="nb-picker-name"></span>
                     <span class="nb-picker-size"></span>`;
    try {
      row.querySelector(".nb-picker-ico").appendChild(
        typeIconEl(e.ext || extOf(e.name), !!e.isDir)
      );
    } catch { /* 图标失败不影响选择功能 */ }
    const nameEl = row.querySelector(".nb-picker-name");
    nameEl.textContent = label;
    if (sub) {
      const sub2 = document.createElement("span");
      sub2.className = "nb-picker-sub";
      sub2.textContent = sub;
      nameEl.appendChild(sub2);
      nameEl.title = displayMountPath(this.mount, e.path || "");
    }
    row.querySelector(".nb-picker-size").textContent = e.isDir ? "" : humanSize(e.size);

    if (e.isDir) {
      // 目录：单击进入（搜索结果里的目录也允许进去，语义一致）
      row.onclick = () => {
        if (this.query) {
          // 从搜索结果进入目录 ⇒ 退出搜索，定位到该目录浏览
          this.path = String(e.path || "").replace(/^\//, "");
          this.qInput.value = "";
          this.query = "";
        } else {
          this.path = this.path ? `${this.path}/${e.name}` : e.name;
        }
        this.load();
      };
    } else if (this.kind === "file") {
      // ★ 任务26b：文件行支持多选 ★
      //   · 单击      ⇒ 只选这一个（清掉其他），与旧行为兼容
      //   · Ctrl+单击 ⇒ 切换该行选中状态（追加 / 移除）
      //   · Shift+单击⇒ 从上次点击位置连选到当前行
      //   · 双击      ⇒ 直接确认（单选快速通道）
      const key = this._keyOf(e);
      const idx = this._rows.length;
      this._rows.push({ e, key });
      row.dataset.nbKey = key;
      if (this._picked.some((p) => p.key === key)) row.classList.add("is-picked");

      row.onclick = (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          this._togglePick(e, idx);
        } else if (ev.shiftKey && this._lastIdx >= 0) {
          const a = Math.min(this._lastIdx, idx);
          const b = Math.max(this._lastIdx, idx);
          for (let i = a; i <= b; i++) {
            const it = this._rows[i];
            if (it && !this._picked.some((p) => p.key === it.key)) {
              this._picked.push(this._specOf(it.e, it.key));
            }
          }
        } else {
          this._picked = [this._specOf(e, key)];
        }
        this._lastIdx = idx;
        this.syncTray();
        this.refreshPickedMarks();
      };
      row.ondblclick = (ev) => {
        ev.preventDefault();
        this._picked = [this._specOf(e, key)];
        this.finish();
      };
    } else {
      // kind === "tree"：只要目录，文件置灰不可选
      row.classList.add("is-disabled");
    }
    return row;
  }

  /** 唯一键：mount + 完整路径（跨挂载/跨目录都不冲突） */
  _keyOf(e) {
    const p = e.path
      ? String(e.path).replace(/^\//, "")
      : (this.path ? `${this.path}/${e.name}` : e.name);
    return displayMountPath(this.mount, p);
  }

  /** 把 entry 变成已选条目（含 key，供排序/去重） */
  _specOf(e, key) {
    const p = e.path
      ? String(e.path).replace(/^\//, "")
      : (this.path ? `${this.path}/${e.name}` : e.name);
    return {
      key: key || displayMountPath(this.mount, p),
      mount: this.mount,
      path: p,
      name: e.name,
      size: e.size,
      ext: e.ext || extOf(e.name),
    };
  }

  /** Ctrl 点击：切换单个 */
  _togglePick(e, idx) {
    const key = this._keyOf(e);
    const at = this._picked.findIndex((p) => p.key === key);
    if (at >= 0) this._picked.splice(at, 1);
    else this._picked.push(this._specOf(e, key));
    this._lastIdx = idx;
    this.syncTray();
    this.refreshPickedMarks();
  }

  /** 让列表行上的「已选」高亮与 _picked 保持一致 */
  refreshPickedMarks() {
    const set = new Set(this._picked.map((p) => p.key));
    this.listEl.querySelectorAll(".nb-picker-row").forEach((row) => {
      const k = row.dataset.nbKey;
      if (k) row.classList.toggle("is-picked", set.has(k));
    });
  }

  /**
   * ★ 任务26b：渲染「已选」区，并支持上下拖动排序 ★
   *
   *  顺序就是插入顺序 ⇒ 渲染成竖向列表，每项可拖。
   *  拖动用 HTML5 DnD（draggable + dragover 重排），
   *  在 dragover 时就地重排数组，视觉与数据同时更新，
   *  松手（dragend）不用再做二次同步 —— 少一个状态就少一类 bug。
   */
  syncTray() {
    if (!this.trayBodyEl) return;
    const n = this._picked.length;
    this.trayTitleEl.textContent = `已选 ${n} 项（可上下拖动调整插入顺序）`;
    this.trayBodyEl.innerHTML = "";

    if (!n) {
      const empty = document.createElement("div");
      empty.className = "nb-picker-trayempty";
      empty.textContent = this.kind === "file"
        ? "在上方列表里单击文件即可选入；Ctrl 点击可多选，Shift 点击连选"
        : "（目录模式不需要多选）";
      this.trayBodyEl.appendChild(empty);
      this._updateOkLabel();
      return;
    }

    this._picked.forEach((p, i) => {
      const it = document.createElement("div");
      it.className = "nb-picker-chip";
      it.draggable = true;
      it.dataset.idx = String(i);
      it.innerHTML = `<span class="nb-picker-grip" title="拖动调整顺序">⠿</span>
                      <span class="nb-picker-chipname"></span>
                      <span class="nb-picker-chipbtns">
                        <button class="b3-button b3-button--outline nb-up" title="上移">↑</button>
                        <button class="b3-button b3-button--outline nb-down" title="下移">↓</button>
                        <button class="b3-button b3-button--outline nb-del" title="移除">✕</button>
                      </span>`;
      it.querySelector(".nb-picker-chipname").textContent = `${i + 1}. ${p.name}`;
      it.querySelector(".nb-up").onclick = (ev) => { ev.stopPropagation(); this._movePick(i, -1); };
      it.querySelector(".nb-down").onclick = (ev) => { ev.stopPropagation(); this._movePick(i, 1); };
      it.querySelector(".nb-del").onclick = (ev) => {
        ev.stopPropagation();
        this._picked.splice(i, 1);
        this.syncTray();
        this.refreshPickedMarks();
      };

      // ---- HTML5 拖动排序 ----
      it.ondragstart = (ev) => {
        this._dragFrom = i;
        it.classList.add("is-dragging");
        try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", String(i)); } catch { /* 忽略 */ }
      };
      it.ondragend = () => {
        it.classList.remove("is-dragging");
        this._dragFrom = -1;
      };
      it.ondragover = (ev) => {
        ev.preventDefault();
        const from = this._dragFrom;
        if (from < 0 || from === i) return;
        // 就地重排：把 from 项移到 i 的位置
        const [moved] = this._picked.splice(from, 1);
        this._picked.splice(i, 0, moved);
        this._dragFrom = i;
        this.syncTray();
      };
      it.ondrop = (ev) => ev.preventDefault();

      this.trayBodyEl.appendChild(it);
    });
    this._updateOkLabel();
  }

  /** 上/下移一位 */
  _movePick(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= this._picked.length) return;
    const [m] = this._picked.splice(i, 1);
    this._picked.splice(j, 0, m);
    this.syncTray();
    this.refreshPickedMarks();
  }

  /** 确定按钮的动态文案 */
  _updateOkLabel() {
    if (!this._okBtn) return;
    const n = this._picked.length;
    if (this.kind === "tree") {
      this._okBtn.textContent = "选择当前目录";
    } else {
      this._okBtn.textContent = n > 1 ? `插入这 ${n} 个` : "插入";
    }
    // ★ 底部提示也要跟着已选数量走 ★
    //   踩过的坑：只在 load()/renderSearch() 里写 hint ⇒ 用户点选/取消选择时
    //   提示语不更新，看着像"没反应"。既然这里知道 n，就顺手一起刷新。
    //   注意浏览/搜索两种模式的措辞不同，用 this.query 区分。
    if (this.hintEl) {
      if (this.kind === "tree") {
        // 目录模式：hint 由 load()/renderSearch() 维护，别覆盖
      } else if (n) {
        this.hintEl.textContent = `已选 ${n} 项，点「插入」写入笔记`;
      } else if (this.query) {
        this.hintEl.textContent = `搜索「${this.query}」：单击选入，Ctrl 多选 / Shift 连选`;
      } else {
        this.hintEl.textContent = "单击文件选入（Ctrl 多选 / Shift 连选），双击直接插入";
      }
    }
  }

  finish(entry) {
    if (this.kind === "file") {
      // ★ 任务26b：优先用「已选」区的内容（有序、可多选）★
      //   entry 只在「双击直接确认」这条快速通道里传进来。
      let list = this._picked;
      if (entry) {
        const p = entry.path
          ? String(entry.path).replace(/^\//, "")
          : (this.path ? `${this.path}/${entry.name}` : entry.name);
        list = [{ mount: this.mount, path: p, name: entry.name }];
      }
      if (!list.length) {
        showMessage("请先选择至少一个文件");
        return;
      }
      // 多选 ⇒ 传数组；单选 ⇒ 也传数组（上层统一成批量，单选即长度 1）
      this.onPick(list.map((p) => ({ mount: p.mount, path: p.path, name: p.name })));
    } else {
      this.onPick({ mount: this.mount, path: this.path });
    }
    this.dialog.destroy();
  }
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * NebulaDisk 对外能力契约（`window.__nebuladiskPlugin.external`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 这份契约唯一的硬约束：**网盘不认识画布**（C-5）★
 * ══════════════════════════════════════════════════════════════════
 *
 * 契约只描述「我能做什么」（list / stat / search / 预览地址构造 / 类型分流），
 * **绝不描述**「谁在调我」。这里不出现 canvas / diskcanvas / node / edge
 * 之类的消费方词汇。
 *
 * 为什么这么设计：
 *   网盘是**通用**资料层，消费方可能有很多（画布、思源侧栏、外部工具、脚本）。
 *   一旦契约里写死了某个消费方的语义，网盘就被绑死，失去通用性 ——
 *   这正是 `05-EMPOWERMENT.md` 里强调的「依赖必须单向：消费方 → 网盘」。
 *
 * 另一条约束（C-4）：**URL 一律由本侧构造**，消费方禁止自己拼后端地址。
 *   原因：后端地址可能是容器内名（如 `nebula:8088`），需要经
 *   `browserReachableUrl()` 改写为浏览器可达地址；签名逻辑也可能变化。
 *   让消费方自己拼 URL = 把这些内部知识泄漏出去，且必然漂移。
 *
 * 本模块是**纯函数构造器**，不持有状态、不发起请求 —— 便于单测。
 */

/**
 * 构造 external 契约对象。
 *
 * @param {object} deps 依赖注入（便于单测与解耦）
 * @param {object} deps.API          src/api.js 导出的 API 总表
 * @param {Function} deps.pickViewer (name) => 类型字符串
 * @param {Function} deps.diag       日志函数
 * @returns {object} 冻结的能力对象
 */
export function createExternalContract({ API, pickViewer, diag } = {}) {
  if (!API || typeof API !== "object") {
    throw new Error("createExternalContract: 缺少 API 依赖");
  }
  if (typeof pickViewer !== "function") {
    throw new Error("createExternalContract: 缺少 pickViewer 依赖");
  }

  /**
   * 统一的参数校验。所有对外方法都**不允许**抛异常穿过边界 ——
   * 消费方（画布）不希望因为网盘侧的一个参数问题让整个渲染挂掉。
   * 失败一律返回 `{ ok: false, error, reason }` 形态。
   */
  const guard = async (fn, label) => {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (error) {
      const status = error && typeof error.status === "number" ? error.status : 0;
      // 404 = 不存在；403 = 无权限；0/其它 = 网络或未知（**必须与 404 区分**，
      // 否则消费方会把「网盘暂时连不上」误报成「文件已被删除」）
      const reason =
        status === 404 ? "missing" : status === 403 ? "denied" : "unreachable";
      diag && diag(`[external] ${label} 失败: status=${status} ${error && error.message}`);
      return { ok: false, error: (error && error.message) || String(error), reason, status };
    }
  };

  const contract = {
    /** 契约版本。消费方据此判断能力是否存在，不靠探测方法名。 */
    version: 1,

    /** 契约标识，便于日志排查（不表示消费方） */
    id: "nebuladisk.external",

    // ──────────────────────────────────────────────
    // 挂载点
    // ──────────────────────────────────────────────

    /**
     * 列出挂载点。
     * 后端**没有** `/api/mounts`（实测 404），挂载点只能从 `/api/me` 取。
     * @returns {{ok:boolean, data?:Array<{label:string,writable:boolean}>, error?:string}}
     */
    listMounts: () =>
      guard(async () => {
        const me = await API.me();
        const mounts = (me && me.mounts) || [];
        return mounts.map((m) => ({
          label: String(m.label || ""),
          writable: !!m.writable,
        }));
      }, "listMounts"),

    // ──────────────────────────────────────────────
    // 目录与元数据
    // ──────────────────────────────────────────────

    /**
     * 列目录。
     * @param {string} mount 挂载点名
     * @param {string} path  挂载点内路径（`/` 为根）
     */
    list: (mount, path) =>
      guard(async () => {
        const r = await API.list(mount, path);
        // 后端可能返回数组，也可能返回 {entries:[...]} —— 统一成数组
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.entries)) return r.entries;
        if (r && Array.isArray(r.items)) return r.items;
        return [];
      }, "list"),

    /**
     * 取单个文件/目录的元数据。
     *
     * ⚠️ 后端**没有稳定文件 ID**（`Entry` 只有 name/is_dir/size/mtime/ext/route/mime/path，
     *    实测确认），所以返回里不会有 id 字段。消费方不要依赖「文件身份」，
     *    只能依赖「地址坐标」——这是已拍板的 D-1b 决策（不做身份表）。
     */
    stat: (mount, path) =>
      guard(async () => {
        const r = await API.stat(mount, path);
        return r || null;
      }, "stat"),

    /**
     * 搜索。端点实测存在（2026-09-24 复验 200）。
     * @param {string} mount
     * @param {string} q      关键词（空格/逗号/中文逗号/竖线分隔 = OR）
     * @param {string} path   搜索起点
     * @param {number} limit  上限（后端硬上限 500）
     */
    search: (mount, q, path = "", limit = 500) =>
      guard(async () => {
        const r = await API.search(mount, q, path, limit);
        return r || null;
      }, "search"),

    // ──────────────────────────────────────────────
    // 类型分流（消费方据此决定怎么渲染）
    // ──────────────────────────────────────────────

    /**
     * 按文件名判断渲染通道。
     * @returns {"image"|"video"|"audio"|"pdf"|"office"|"cad"|"text"|"archive"|"download"}
     */
    viewerKind: (name) => {
      try {
        return pickViewer(String(name || ""));
      } catch {
        return "download";
      }
    },

    // ──────────────────────────────────────────────
    // URL 构造（★ 消费方禁止自己拼 ★ C-4）
    // ──────────────────────────────────────────────

    /**
     * 预览地址（内嵌用）。
     * 内部已处理：容器内主机名 → 浏览器可达地址的改写。
     * @returns {Promise<string>}
     */
    previewUrl: (mount, path) =>
      guard(async () => String(await API.previewUrl(mount, path) || ""), "previewUrl"),

    /** CAD 预览地址。 */
    cadUrl: (mount, path) =>
      guard(async () => String(await API.cadUrl(mount, path) || ""), "cadUrl"),

    /** 网页直连地址（可选走 `/lite` 外壳，用于收第三方 UI）。 */
    webUrl: (mount, path, name) =>
      guard(async () => String(API.browserViewUrl(mount, path, name) || ""), "webUrl"),

    /**
     * 签名直链（下载/原始字节）。
     * @param {boolean} download true=强制下载，false=内联
     */
    signedRawUrl: (mount, path, download = false) =>
      guard(async () => String(await API.signedRawUrl(mount, path, download) || ""), "signedRawUrl"),

    /** 下载地址（非签名，保留原语义）。 */
    downloadUrl: (mount, path, inline = false) =>
      guard(async () => String(API.downloadUrl(mount, path, inline) || ""), "downloadUrl"),

    // ──────────────────────────────────────────────
    // 能力探测（可选，消费方一般不需要）
    // ──────────────────────────────────────────────

    /** 三个预览子服务的健康状态。 */
    health: () =>
      guard(async () => {
        const out = {};
        for (const [key, fn] of [
          ["onlyoffice", API.ooHealth],
          ["kkfileview", API.kkHealth],
          ["cad", API.cadHealth],
        ]) {
          try {
            out[key] = await fn();
          } catch (e) {
            out[key] = { ok: false, error: (e && e.message) || String(e) };
          }
        }
        return out;
      }, "health"),
  };

  return Object.freeze(contract);
}

/* ==========================================================================
 * 图标
 * --------------------------------------------------------------------------
 * 思源内置图标用 <svg><use xlink:href="#iconXxx"></use></svg> 引用。
 * 自定义图标用 plugin.addIcons() 注册 <symbol>，然后同样用 #id 引用。
 *
 * ★★ 任务29（2026-09-23）：按**网盘风格**重做文件/文件夹图标 ★★
 *
 *   参考对象 = NebulaDisk 自己的 Web UI（容器内 /opt/nebula/web/js/icons.js）。
 *   那边是 Windows-11 资源管理器风格，两套图标分工明确：
 *     · UI 线性图标      —— 1.5px 描边、currentColor 上色（按钮/工具栏用）
 *     · 文件类型图标     —— **自带配色、不跟主题**：白纸底 + 折角 + 类型色 + 标记
 *
 *   之前插件的做法是「一个小色块 + 扩展名文字」（.nb-type-icon 是个 <span>
 *   带背景色），文件夹只是一个细细的描边 path —— 用户评价「太难看了」。
 *   现在**照搬网盘那套**：目录 = 琥珀色实心文件夹；
 *   文件 = 白纸+折角+类型色+字母/图形标记（W/X/P/PDF/MD/…）。
 *
 *   ★ 兼容性 ★
 *     对外 API 一个都没变（typeBadge / extOf / typeIconEl / CUSTOM_ICONS），
 *     只是 typeIconEl 返回的 DOM 从「<span>色块」变成了「<svg>彩色图标」。
 *     调用方一律走 appendChild，因此无需改动任何调用点。
 * ========================================================================== */

/** 需要注册到思源的自定义 symbol（addIcons 用） */
export const CUSTOM_ICONS = `
<symbol id="iconNebulaDisk" viewBox="0 0 32 32">
  <path fill="currentColor" d="M16 3.2c-4.2 0-7.7 2.8-8.9 6.6A6.4 6.4 0 0 0 7.4 22.4h2.3a1.2 1.2 0 0 0 0-2.4H7.4a4 4 0 0 1-.1-8 4 4 0 0 1 .5.03l1.2.16.4-1.14A6.7 6.7 0 0 1 16 5.6c3 0 5.6 2 6.5 4.7l.35 1.06 1.1.1a4.3 4.3 0 0 1 3.9 4.3 4.3 4.3 0 0 1-1.3 3.1 1.2 1.2 0 0 0 1.7 1.7A6.7 6.7 0 0 0 30.2 15.8a6.7 6.7 0 0 0-5.6-6.6A9.2 9.2 0 0 0 16 3.2Z"/>
  <path fill="currentColor" d="M13.1 16.3a1.2 1.2 0 0 1 1.7 0l.4.4V11a1.2 1.2 0 0 1 2.4 0v5.7l.4-.4a1.2 1.2 0 0 1 1.7 1.7l-2.6 2.6a1.2 1.2 0 0 1-1.7 0L13.1 18a1.2 1.2 0 0 1 0-1.7Z"/>
  <path fill="currentColor" d="M11 23.2a1.2 1.2 0 0 1 1.2-1.2h7.6a1.2 1.2 0 0 1 0 2.4h-7.6A1.2 1.2 0 0 1 11 23.2Z"/>
</symbol>
<!-- ★ 2026-09-28：iconNbGrid / iconNbList 两个网格/列表切换图标已删除 ★
     网格视图整体移除（用户要求），这两个 symbol 已无任何 <use> 引用。
     ⚠️ 删自定义 symbol 是安全的：思源对未注册的 id 只会渲染成空白，
        不存在"注册了却不用"的副作用。反过来如果留着它们，
        每次 addIcons 都要多解析两个 SVG，属于无谓开销。 -->
`;

/* ==========================================================================
 * 一、文件类型图标（Windows 风格彩色文档）
 * --------------------------------------------------------------------------
 * 与网盘 Web UI 的 _paper()/_folder() 保持同一套画法，只是内联成字符串，
 * 由 typeIconEl() 解析成真实 <svg> DOM（思源插件里用 innerHTML 拼更省事，
 * 但 currentColor / 主题色那种场景仍需要 DOM，所以统一走 DOM 出口）。
 * ========================================================================== */

/** 纸张底 + 折角 + 类型色里的自定义内容 */
function _paperSvg(color, inner) {
  return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">`
    + `<path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h12L26 8.5v20a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 6 28.5z" `
    + `fill="#fff" stroke="${color}" stroke-width="1.4"/>`
    + `<path d="M19.5 2v5a1.5 1.5 0 0 0 1.5 1.5h5" fill="${color}" opacity=".22" `
    + `stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`
    + inner
    + `</svg>`;
}

/** 琥珀色实心文件夹（与网盘 _folder('#e8a33d') 同一套路径） */
function _folderSvg(color) {
  return `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">`
    + `<path d="M2 7.5A2.5 2.5 0 0 1 4.5 5h6.2a2 2 0 0 1 1.6.8L14 8h13.5A2.5 2.5 0 0 1 30 10.5v14A2.5 2.5 0 0 1 27.5 27h-23A2.5 2.5 0 0 1 2 24.5z" `
    + `fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.5"/>`
    + `<path d="M2 12h28" stroke="${color}" stroke-width="1.2" opacity=".5"/>`
    + `</svg>`;
}

/** 纸张里一个字母标记（Word 的 W、Excel 的 X、PPT 的 P…） */
function _letter(color, ch, size) {
  const s = size || 9.5;
  return `<text x="16" y="25" font-size="${s}" font-weight="700" fill="${color}" `
    + `text-anchor="middle" font-family="Segoe UI,Helvetica,Arial,sans-serif">${ch}</text>`;
}

/**
 * 类型 → svg 字符串。
 * ★ 配色沿用网盘的品牌色（Word 蓝 / Excel 绿 / PPT 橙红 …），
 *   这些是**内容语义色**，故意不跟随思源主题（资源管理器就是这么做的）。
 */
const FILE_SVG = {
  folder: _folderSvg("#e8a33d"),

  doc: _paperSvg("#2b579a", _letter("#2b579a", "W")),
  xls: _paperSvg("#217346", _letter("#217346", "X")),
  ppt: _paperSvg("#c43e1c", _letter("#c43e1c", "P")),

  pdf: _paperSvg("#c8102e", _letter("#c8102e", "PDF", 8)),

  txt: _paperSvg("#5c6b7a",
    `<path d="M10 15h12M10 18.5h12M10 22h8" stroke="#5c6b7a" stroke-width="1.5" stroke-linecap="round"/>`),
  md: _paperSvg("#3b6ea5", _letter("#3b6ea5", "MD", 8)),

  code: _paperSvg("#7b3fa0",
    `<path d="M13 18l-3 3 3 3M19 18l3 3-3 3" stroke="#7b3fa0" stroke-width="1.6" `
    + `stroke-linecap="round" stroke-linejoin="round"/>`),

  image: _paperSvg("#0f7b0f",
    `<rect x="9.5" y="15" width="13" height="10" rx="1" stroke="#0f7b0f" stroke-width="1.4"/>`
    + `<circle cx="12.8" cy="18.2" r="1.3" fill="#0f7b0f"/>`
    + `<path d="M9.5 23.5l3.6-3.2 2.4 2.1 2.3-2 3.7 3.4" stroke="#0f7b0f" stroke-width="1.4" `
    + `stroke-linecap="round" stroke-linejoin="round"/>`),

  video: _paperSvg("#a4262c",
    `<rect x="9" y="15" width="14" height="10" rx="1.4" stroke="#a4262c" stroke-width="1.4"/>`
    + `<path d="M14.4 17.6 20 20l-5.6 2.4z" fill="#a4262c"/>`),

  audio: _paperSvg("#8764b8",
    `<circle cx="13" cy="23" r="2.2" stroke="#8764b8" stroke-width="1.4"/>`
    + `<circle cx="20" cy="21.4" r="2.2" stroke="#8764b8" stroke-width="1.4"/>`
    + `<path d="M15.2 23v-7.4l7-1.7v7.5" stroke="#8764b8" stroke-width="1.4"/>`),

  zip: _paperSvg("#b8860b",
    `<path d="M16 14.5v2M16 17.6v2M16 20.7v1.9" stroke="#b8860b" stroke-width="1.7" stroke-linecap="round"/>`
    + `<rect x="13.8" y="22.6" width="4.4" height="3.4" rx=".8" fill="#b8860b" fill-opacity=".3" `
    + `stroke="#b8860b" stroke-width="1.3"/>`),

  cad: _paperSvg("#0b6a8f",
    `<path d="M11 24 16 14.5 21 24z" stroke="#0b6a8f" stroke-width="1.4" stroke-linejoin="round"/>`),

  // 3D 模型（step/stl/obj/3mf/gltf…）—— 等轴测立方体
  model: _paperSvg("#00838f",
    `<path d="M16 13.6 24.5 18l-8.5 4.4L7.5 18z" stroke="#00838f" stroke-width="1.4" stroke-linejoin="round"/>`
    + `<path d="M7.5 18v5.6L16 28l8.5-4.4V18" stroke="#00838f" stroke-width="1.4" stroke-linejoin="round"/>`
    + `<path d="M16 22.4V28" stroke="#00838f" stroke-width="1.4"/>`),

  eml: _paperSvg("#4a5568",
    `<rect x="9.5" y="15.5" width="13" height="9.5" rx="1.1" stroke="#4a5568" stroke-width="1.4"/>`
    + `<path d="M9.8 16.3 16 20.4l6.2-4.1" stroke="#4a5568" stroke-width="1.4" stroke-linejoin="round"/>`),

  unknown: _paperSvg("#8a8a8a", ""),
};

/* -------------------------------------------------------------------------
 * 文件类型配色（保留原有 TABLE 结构 —— 单测与外部都在按 label/color 读）
 *   ★ 这里同时给出两个东西：
 *     · kind —— 决定用 FILE_SVG 里的哪一张图
 *     · label/color —— 兼容旧调用（typeBadge 的返回值契约没变）
 * ---------------------------------------------------------------------- */
const TYPE_TABLE = [
  { exts: ["doc", "docx", "docm", "dot", "dotx", "odt", "rtf", "wps"], kind: "doc", label: "DOC", color: "#2b579a" },
  { exts: ["xls", "xlsx", "xlsm", "xlt", "ods", "csv", "et"],          kind: "xls", label: "XLS", color: "#217346" },
  { exts: ["ppt", "pptx", "pptm", "pot", "potx", "odp", "dps"],        kind: "ppt", label: "PPT", color: "#c43e1c" },
  { exts: ["pdf"],                                                     kind: "pdf", label: "PDF", color: "#c8102e" },
  { exts: ["dwg", "dxf", "dwf"],                                       kind: "cad", label: "CAD", color: "#0b6a8f" },
  { exts: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso"], kind: "zip", label: "ZIP", color: "#b8860b" },
  { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff"],
                                                                        kind: "image", label: "IMG", color: "#0f7b0f" },
  { exts: ["mp4", "webm", "mkv", "mov", "avi", "m4v", "flv", "wmv"],   kind: "video", label: "VID", color: "#a4262c" },
  { exts: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "wma"],          kind: "audio", label: "AUD", color: "#8764b8" },
  { exts: ["txt", "log", "ini", "conf", "properties"],                 kind: "txt", label: "TXT", color: "#5c6b7a" },
  { exts: ["md", "markdown"],                                          kind: "md", label: "MD", color: "#3b6ea5" },
  { exts: ["json", "xml", "yml", "yaml", "toml"],                      kind: "code", label: "CFG", color: "#7b3fa0" },
  { exts: ["js", "ts", "py", "java", "go", "rs", "c", "cpp", "h", "sh", "sql", "vue", "html", "css", "jsx", "tsx",
           "cs", "php", "rb", "bat"],                                  kind: "code", label: "SRC", color: "#7b3fa0" },
  { exts: ["step", "stp", "iges", "igs", "brep", "stl", "obj", "off", "ply", "wrl", "3mf", "amf",
           "3ds", "3dm", "dae", "fbx", "gltf", "glb", "fcstd", "bim", "ifc"],
                                                                        kind: "model", label: "3D", color: "#00838f" },
  { exts: ["eml", "msg"],                                              kind: "eml", label: "EML", color: "#4a5568" },
];

/**
 * 取文件类型描述
 *   ★ 契约保持不变：仍然返回 { label, color }。
 *     额外多给一个 kind（内部用来挑 svg），旧调用方忽略它即可。
 * @param {string} ext 扩展名（小写，不带点）
 * @returns {{label:string,color:string,kind:string}}
 */
export function typeBadge(ext) {
  const e = String(ext || "").toLowerCase();
  if (!e) return { label: "?", color: "#9ca3af", kind: "unknown" };
  for (const row of TYPE_TABLE) {
    if (row.exts.includes(e)) return { label: row.label, color: row.color, kind: row.kind };
  }
  return { label: e.slice(0, 3).toUpperCase(), color: "#9ca3af", kind: "unknown" };
}

/**
 * 从文件名里取扩展名（小写、不带点）。
 *   "报告.PDF"  → "pdf"
 *   "a.tar.gz"  → "gz"
 *   "没有扩展名" → ""
 * ★ 点开头的隐藏文件（".gitignore"）不算有扩展名。
 */
export function extOf(name) {
  const n = String(name || "");
  const i = n.lastIndexOf(".");
  if (i <= 0 || i === n.length - 1) return "";
  return n.slice(i + 1).toLowerCase();
}

/** 把一小段 svg 源码解析成真实 SVG 元素（不依赖 innerHTML 的 HTML 解析差异） */
function svgFromString(src) {
  const wrap = document.createElement("div");
  wrap.innerHTML = src;
  const svg = wrap.firstElementChild;
  return svg || document.createElementNS("http://www.w3.org/2000/svg", "svg");
}

/**
 * 生成一个「文件/目录」图标 DOM。
 *
 * ★★★ 2026-09-23（任务25b）修了一个长期存在的真 bug ★★★
 *
 *   本函数签名一直是 `typeIconEl(ext)` —— 只吃**扩展名**。
 *   但 grid / 搜索结果两处调用写的是 `typeIconEl(e.name, e.isDir)`，
 *   传进来的是**整个文件名**。于是 typeBadge 拿着 "报告.pdf" 去比对
 *   TYPE_TABLE（里面是 "pdf"），永远匹配不上，退化到
 *   `label = 名字前 3 个字符`、颜色恒为灰。
 *
 *   ⇒ 现在做两件事：
 *     ① 参数宽容化：既能收 ext，也能收 (name, isDir) —— 传错也不再退化；
 *     ② 目录真正给一个文件夹图标。
 *
 * ★★★ 任务29（2026-09-23）★★★
 *   返回的 DOM 从「<span> 色块 + 文字」换成**网盘风格的彩色 <svg>**
 *   （目录 = 琥珀色文件夹；文件 = 白纸 + 折角 + 类型色 + 标记）。
 *   出口仍是 HTMLElement，调用方（grid / 搜索结果 / 文件树）不用改。
 *
 * @param {string}  extOrName 扩展名（推荐）或文件名（兼容旧调用）
 * @param {boolean} [isDir]   是否目录；传 true 时强制返回文件夹图标
 * @returns {HTMLElement}  <svg class="nb-type-icon …">
 */
export function typeIconEl(extOrName, isDir) {
  const raw = String(extOrName || "");

  // 目录：琥珀色实心文件夹
  if (isDir) {
    const svg = svgFromString(FILE_SVG.folder);
    svg.setAttribute("class", "nb-type-icon nb-type-icon--dir");
    return svg;
  }

  // ★ 兼容层：区分「传的是 ext」还是「传的是文件名」。
  //
  //   判据（简单可靠，不做玄学猜测）：
  //     · 扩展名里**不可能**有路径分隔符，也不可能有点 —— 有点的是文件名。
  //     · 含 "/" 或 "\" ⇒ 一定是文件名。
  //     · 含 "." 且不是以 "." 开头 ⇒ 一定是文件名（"报告.pdf" / "a.tar.gz"）。
  //     · 其余（"pdf" / "png" / "step" / ""）⇒ 就是扩展名，原样用。
  let ext = raw;
  if (raw.includes("/") || raw.includes("\\") || raw.lastIndexOf(".") > 0) {
    ext = extOf(raw);
  }

  const badge = typeBadge(ext);
  const svg = svgFromString(FILE_SVG[badge.kind] || FILE_SVG.unknown);
  svg.setAttribute("class", "nb-type-icon nb-type-icon--file");
  // 类型色额外挂到 style 上：便于 CSS 需要时（如整体低饱和）取用
  svg.style.setProperty("--nb-type-color", badge.color);
  return svg;
}

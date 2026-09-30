/* ==========================================================================
 * 图片加载：复诊 + 自愈
 * --------------------------------------------------------------------------
 * 为什么需要这一层（2026-09-30 真机排查结论）
 *
 *   嵌入块 / 页签 里的图片直链（`/api/raw/…?exp=…&sig=…`）在真机上会出现
 *   「图片加载失败（签名可能已过期，点「收起」后重新展开即可）」，
 *   但同一条 URL 在真机上被反复验证**完全可用**：
 *     · curl 直接取    ⇒ HTTP 200 + image/jpeg + 完整字节
 *     · 页面里 new Image() ⇒ onload，naturalWidth/naturalHeight 正常
 *     · 连 `--disable-web-security`（等价思源主窗口的 webSecurity:false）
 *       跑一遍也一样成功
 *   ⇒ 所以问题**不在链接、也不在后端**，而在 `img` 这个元素这一层。
 *
 *   失败其实有两种，性质完全不同，旧代码却把它们混成同一句话：
 *     ① **假失败** —— 元素被移除 / 所在块被重新渲染，导致加载被中断（abort）。
 *        这时 URL 是好的，图片本身也能取到，只是没人接住。
 *     ② **真失败** —— 真的取不到（403 签名被拒 / 404 文件已不在 / 网络不通）。
 *        这时必须把**真实原因**摆出来，否则用户只能按「签名过期」去瞎试。
 *
 *   于是统一走这里：
 *     img.onerror ⇒ 复诊（fetch 同一条直链）
 *       · 拿到字节 ⇒ 转 blob 重新挂载（**自愈**，用户直接看到图）
 *       · 拿不到   ⇒ 再试**认证兜底链路**（`/api/download` 带 Bearer，
 *                     它认 token、不认签名，与签名直链互为备份）
 *       · 两条都不行 ⇒ 按真实状态码给出可定位的提示
 *
 *   ★ 为什么兜底用 `/api/download` ★
 *     直连（思源 :6806 → 网盘 :8089）是跨源的，`/api/download` 认 Cookie
 *     会话会 401；但它**同时认 `Authorization: Bearer`**，而 token 就在
 *     插件手里 ⇒ 用 fetch 带 Bearer 取字节是可行的，实测 200 + image/jpeg。
 *     它不依赖 URL 签名，所以能兜住「签名链路出问题」的所有情况。
 * ========================================================================== */

import { diag } from "./diag.js";

/**
 * 回收单个 blob URL。
 *
 * ★ 故意**不做**全局登记表 ★
 *   一篇文档里可以同时展开多个嵌入块，各自可能持有 blob。
 *   若用一个模块级的集合统一回收，A 块重建时会把 B 块正在用的 blob 也 revoke
 *   ⇒ B 的图片突然变成裂图。所以回收的责任交给**创建它的那个块自己**
 *   （见 embed.js / viewer.js 里的 blob 列表）。
 */
export function revokeBlobUrl(url) {
  const s = String(url || "");
  if (!s) return;
  try { URL.revokeObjectURL(s); } catch { /* 已回收过 */ }
}

/**
 * 复诊：用 `fetch` 取同一条图片直链，把「能不能真的拿到字节」量出来。
 *
 * 刻意读成 arrayBuffer 而不是只看状态码：真机上出现过
 * 「状态 200 但 body 是错误页」的情况，只看 `r.ok` 会误判成功。
 *
 * @param {string} url 图片直链（含签名或 blob）
 * @param {string} [label] 日志前缀
 * @returns {Promise<{ok:boolean,status:number,type:string,bytes:number,
 *                    blob:Blob|null,detail:string,ms:number,url:string}>}
 *          永不抛错 —— 失败信息在 `detail` 里。
 */
export async function probeImageUrl(url, label = "图片") {
  const started = Date.now();
  const meta = {
    url: String(url || ""),
    ok: false, status: 0, type: "", bytes: 0,
    blob: null, detail: "", ms: 0,
  };
  if (!meta.url) {
    meta.detail = "地址为空";
    return meta;
  }
  try {
    // cache:no-store —— 复诊要的是「现在到底行不行」，
    // 不能让浏览器把上一次失败的缓存结果端回来
    const r = await fetch(meta.url, { credentials: "omit", cache: "no-store" });
    meta.status = r.status;
    meta.type = r.headers.get("content-type") || "";
    const buf = await r.arrayBuffer();
    meta.bytes = buf.byteLength;
    meta.ms = Date.now() - started;

    if (!r.ok) {
      // 错误响应体通常是一小段 JSON/文本，取出来给用户看，比状态码有用得多
      let tail = "";
      try { tail = new TextDecoder().decode(buf.slice(0, 160)); } catch { /* 非文本 */ }
      meta.detail = `HTTP ${meta.status}${tail ? " " + tail : ""}`;
      return meta;
    }
    if (!meta.bytes) {
      meta.detail = `HTTP ${meta.status} 但响应体为 0 字节`;
      return meta;
    }
    meta.ok = true;
    meta.blob = new Blob([buf], { type: meta.type || "image/jpeg" });
    meta.detail = `HTTP ${meta.status} ${meta.type || "(无 content-type)"} ${meta.bytes} 字节 / ${meta.ms}ms`;
    return meta;
  } catch (e) {
    meta.ms = Date.now() - started;
    meta.detail = `请求抛错：${(e && e.message) || e}`;
    diag(`[media] ${label} 复诊失败：${meta.detail}`);
    return meta;
  }
}

/**
 * 把 blob 塞进一个新的 `<img>` 并替换掉旧的失败元素。
 *
 * @param {HTMLImageElement} oldImg 触发了 error 的那个 img（用来定位替换点）
 * @param {Blob} blob
 * @param {string} className 沿用原样式类，保证视觉不变
 * @param {string} alt
 * @returns {HTMLImageElement} 新的 img（已挂到与原元素相同的位置）
 */
export function mountBlobImage(oldImg, blob, className, alt) {
  const url = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.className = className || "nb-embed-image";
  img.alt = alt || "";
  img.src = url;
  // 记在自己身上：容器重建时按这个字段回收（谁创建谁回收）
  img.dataset.nbBlob = url;
  if (oldImg && oldImg.parentNode) oldImg.parentNode.replaceChild(img, oldImg);
  return img;
}

/**
 * 把复诊结果翻译成「用户能照着排查」的一句话。
 *
 * 原则：**不要再说「签名可能已过期」** —— 那是旧代码的推测，
 * 真机上被反复证伪（同一条链接 curl / new Image() 都成功）。
 * 现在有什么证据就说什么。
 *
 * @param {object} probe probeImageUrl / downloadBlob 的结果
 * @param {{viaApi?:boolean}} [opts] 是否已经试过认证兜底链路
 */
export function imageFailMessage(probe, opts = {}) {
  const p = probe || {};
  const tried = opts.viaApi ? "（签名直链与认证链路都试过了）" : "";

  if (!p.status) {
    return `图片加载失败${tried}：${p.detail || "无法访问网盘"}。` +
      "请检查本机能否访问网盘地址、网盘服务是否在运行。";
  }
  if (p.status === 401 || p.status === 403) {
    return `图片加载失败${tried}：网盘拒绝了这次取图（HTTP ${p.status}）。` +
      "多半是登录态或签名校验的问题，请到插件设置里点「测试连接」确认登录正常。";
  }
  if (p.status === 404) {
    return `图片加载失败${tried}：网盘上找不到该文件（HTTP 404），可能已被移动或删除。`;
  }
  if (p.status >= 500) {
    return `图片加载失败${tried}：网盘服务出错（HTTP ${p.status}）。` +
      "请稍后重试；若持续失败请查看网盘服务日志。";
  }
  if (p.bytes > 0 && !/^image\//i.test(p.type || "") && !/octet-stream/i.test(p.type || "")) {
    return `图片加载失败${tried}：网盘返回的不是图片` +
      `（content-type=${p.type || "未知"}，${p.bytes} 字节）。` +
      "该文件可能已损坏，或不是真正的图片格式。";
  }
  return `图片加载失败${tried}：${p.detail || "未知原因"}。`;
}

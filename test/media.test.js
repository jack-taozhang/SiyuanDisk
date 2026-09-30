/* ==========================================================================
 * 图片复诊 / 自愈 单元测试
 * --------------------------------------------------------------------------
 * 覆盖的是 2026-09-30 那次真机故障的修复：
 *
 *   现象：嵌入块 / 页签里的 jpg 显示
 *         「图片加载失败（签名可能已过期，点「收起」后重新展开即可）」，
 *         而重新展开也没用。
 *
 *   真机结论：**链接根本没坏** —— 同一条直链
 *     · curl 直取           ⇒ 200 + image/jpeg + 完整字节
 *     · 页面里 new Image()  ⇒ onload，naturalWidth/naturalHeight 正常
 *     · `--disable-web-security`（等价思源主窗口 webSecurity:false）下同样成功
 *   ⇒ 失败发生在 `img` 这一层；而旧代码一 onerror 就把原因写成「签名过期」，
 *     既可能是误报（元素被移除导致加载中断），也把真实原因盖掉了。
 *
 * 所以这里要盯死四件事：
 *   ① 复诊（probeImageUrl）能区分「真拿到字节」和「各种失败」，且错误可读
 *   ② 自愈（mountBlobImage）确实替换掉坏元素、并留下可回收的 blob 标记
 *   ③ 文案（imageFailMessage）按状态码给不同提示，**且不再出现「签名可能已过期」**
 *   ④ 反向注入：把上面任意一条改坏，测试必须变红
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/media.js");
const raw = fs.readFileSync(SRC, "utf8");

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log("  ✅ " + m); };
const bad = (m) => { failed++; console.log("  ❌ " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/* ------------------------------------------------------------------ 加载 */

/**
 * 轻量转译：剥掉 import / export 关键字后在沙箱里求值。
 *
 * ★ 为什么不用 `require("../src/media.js")` ★
 *   它是 ESM（`import {...} from "./diag.js"`），而本套件是 CJS，
 *   Node 的 require 会直接抛 `SyntaxError: Unexpected token 'export'`。
 *   （同一个坑 2026-09-30 在 test/e2e.test.js 里也踩过。）
 */
function loadMedia(srcOverride, stubs = {}) {
  const src = String(srcOverride || raw)
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+"\.\/diag\.js";?\s*$/m, "")
    .replace(/^export\s+/gm, "");

  const logs = [];
  const sandbox = {
    diag: (m) => logs.push(String(m)),
    fetch: stubs.fetch,
    URL: stubs.URL || URL,
    Blob: stubs.Blob || Blob,
    TextDecoder,
    document: stubs.document || { createElement: () => fakeEl() },
    Date,
    console: { log: () => {}, warn: () => {} },
  };
  const names = ["probeImageUrl", "mountBlobImage", "imageFailMessage", "revokeBlobUrl"];
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...Object.keys(sandbox),
    src + `\nreturn { ${names.join(", ")} };`,
  );
  return { mod: factory(...Object.values(sandbox)), logs };
}

/** 极简元素桩：够 mountBlobImage 用（className / alt / src / dataset / replaceChild） */
function fakeEl() {
  return {
    className: "", alt: "", src: "", dataset: {},
    parentNode: null,
    _children: [],
    appendChild(c) { c.parentNode = this; this._children.push(c); return c; },
    replaceChild(next, old) {
      const i = this._children.indexOf(old);
      if (i >= 0) this._children[i] = next; else this._children.push(next);
      next.parentNode = this;
      old.parentNode = null;
      return old;
    },
  };
}

/** 造一个「成功」的 fetch 响应桩 */
function respOf(bytes, { status = 200, type = "image/jpeg", okFlag } = {}) {
  const buf = new Uint8Array(bytes);
  return {
    status,
    ok: okFlag === undefined ? status >= 200 && status < 300 : okFlag,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? type : null) },
    arrayBuffer: async () => buf.buffer,
    text: async () => new TextDecoder().decode(buf),
    blob: async () => new Blob([buf], { type }),
    _buf: buf,
  };
}

console.log("\n【① 复诊 probeImageUrl：能否区分真拿到字节 / 各种失败】");

(async () => {
  // --- 1) 成功 ---
  {
    const { mod } = loadMedia(raw, { fetch: async () => respOf([1, 2, 3, 4, 5]) });
    const r = await mod.probeImageUrl("http://nas/api/raw/a.jpg", "t");
    check(r.ok === true && r.bytes === 5 && r.status === 200 && !!r.blob,
      "拿到 200 + 字节 ⇒ ok=true，并带回 blob");
    check(/image\/jpeg/.test(r.detail), "detail 里写明 content-type（可读）");
  }

  // --- 2) 403 ---
  {
    const { mod } = loadMedia(raw, { fetch: async () => respOf([123, 34, 101], { status: 403, type: "application/json", okFlag: false }) });
    const r = await mod.probeImageUrl("http://nas/api/raw/a.jpg");
    check(r.ok === false && r.status === 403 && /403/.test(r.detail),
      "403 ⇒ ok=false，detail 带状态码与响应体片段");
  }

  // --- 3) 200 但 0 字节 ---
  {
    const { mod } = loadMedia(raw, { fetch: async () => respOf([], {}) });
    const r = await mod.probeImageUrl("http://nas/api/raw/a.jpg");
    check(r.ok === false && /0 字节/.test(r.detail),
      "200 但响应体为空 ⇒ 判失败（只看 r.ok 会误判成功）");
  }

  // --- 4) fetch 抛错（网络） ---
  {
    const { mod, logs } = loadMedia(raw, { fetch: async () => { throw new Error("Failed to fetch"); } });
    const r = await mod.probeImageUrl("http://nas/api/raw/a.jpg");
    check(r.ok === false && r.status === 0 && /请求抛错/.test(r.detail),
      "网络抛错 ⇒ ok=false、status=0、detail 含原因");
    check(logs.some((l) => /复诊失败/.test(l)), "同时写进诊断日志（排查要靠它）");
  }

  // --- 5) 非图片类型 ---
  {
    const { mod } = loadMedia(raw, { fetch: async () => respOf([60, 104, 116, 109, 108], { type: "text/html" }) });
    const r = await mod.probeImageUrl("http://nas/api/raw/a.jpg");
    check(r.ok === true && r.type === "text/html",
      "probe 如实报告 content-type（是否算失败交给文案层判断）");
  }

  console.log("\n【② 自愈 mountBlobImage：替换坏元素 + 留下可回收标记】");
  {
    const { mod } = loadMedia(raw, {});
    const parent = fakeEl();
    const broken = fakeEl();
    broken.className = "nb-embed-image";
    parent.appendChild(broken);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const next = mod.mountBlobImage(broken, blob, "nb-embed-image", "图.jpg");

    check(parent._children[0] === next && broken.parentNode === null,
      "新 img 顶替了坏元素的位置，旧元素被摘掉");
    check(next.className === "nb-embed-image" && next.alt === "图.jpg",
      "沿用原样式类与 alt（视觉不变）");
    check(/^blob:/.test(next.src) && /^blob:/.test(next.dataset.nbBlob || ""),
      "src 指向 blob，并把 blob URL 记在 dataset.nbBlob（供回收）");
    next.dataset.nbBlob && mod.revokeBlobUrl(next.dataset.nbBlob);
  }

  console.log("\n【③ 文案 imageFailMessage：按证据说话，不再提「签名过期」】");
  {
    const { mod } = loadMedia(raw, {});
    const cases = [
      [{ status: 0, detail: "请求抛错：Failed to fetch" }, "网络", /能否访问网盘|网盘服务/],
      [{ status: 403, detail: "HTTP 403" }, "403", /拒绝|登录态|签名校验/],
      [{ status: 404, detail: "HTTP 404" }, "404", /找不到|移动或删除/],
      [{ status: 500, detail: "HTTP 500" }, "500", /网盘服务出错|稍后重试/],
      [{ status: 200, type: "text/html", bytes: 20, detail: "HTTP 200 text/html 20 字节" }, "非图片", /不是图片|损坏/],
    ];
    let allOk = true, allNoStale = true;
    for (const [probe, label, re] of cases) {
      const msg = mod.imageFailMessage(probe, { viaApi: true });
      if (!re.test(msg) || !/都试过了/.test(msg)) { allOk = false; bad(`「${label}」文案不合预期：${msg}`); }
      if (/签名可能已过期/.test(msg)) allNoStale = false;
    }
    if (allOk) ok("5 种失败状态各自给出可照着排查的提示，且标明两条链路都试过");
    check(allNoStale, "★ 任何分支都不再出现「签名可能已过期」（那正是被证伪的旧推测）");

    // ★ 更关键的一条：这句推断不能再出现在**任何**渲染路径里。
    //   （注释里保留「曾经这么写过」的留痕是有价值的，所以只查「当文案用」的写法。）
    const srcFiles = ["media.js", "embed.js", "viewer.js", "api.js"]
      .map((f) => path.resolve(__dirname, "../src", f))
      .filter((p) => fs.existsSync(p));
    const asText = srcFiles.filter((p) =>
      /textContent\s*=[^;]{0,240}签名可能已过期/.test(fs.readFileSync(p, "utf8")));
    check(asText.length === 0,
      "★ 没有任何渲染路径再把它当文案输出（查了 " + srcFiles.length + " 个源文件）");
  }

  console.log("\n【④ 反向注入：把判据改坏，测试必须变红】");
  {
    // 注入 1：把 403/404/5xx 全并成一句模糊提示 —— 文案断言应失败
    const brokenMsg = raw.replace(
      /if \(p\.status === 401 \|\| p\.status === 403\) \{[\s\S]*?\n  \}/,
      "if (p.status === 401 || p.status === 403) { return \"图片加载失败（签名可能已过期）\"; }",
    );
    check(brokenMsg !== raw, "（注入点存在：403 分支可被替换）");
    if (brokenMsg !== raw) {
      const { mod } = loadMedia(brokenMsg, {});
      const msg = mod.imageFailMessage({ status: 403, detail: "HTTP 403" }, { viaApi: true });
      check(/签名可能已过期/.test(msg),
        "把 403 分支改回旧文案后，断言确实能抓到（证明③不是空过）");
    }

    // 注入 2：复诊不再读 body（退回「只看状态码」）—— 0 字节断言应失败
    const brokenProbe = raw.replace(
      /if \(!meta\.bytes\) \{[\s\S]*?\n    \}/,
      "if (false) { }",
    );
    check(brokenProbe !== raw, "（注入点存在：0 字节判据可被去掉）");
    if (brokenProbe !== raw) {
      const { mod } = loadMedia(brokenProbe, { fetch: async () => respOf([], {}) });
      mod.probeImageUrl("http://nas/x.jpg").then((r) => {
        check(r.ok === true,
          "去掉「0 字节」判据后，空响应会被误判成功（证明①该断言有效）");
        finish();
      });
      return;
    }
  }

  finish();
})();

function finish() {
  console.log("\n====================================================");
  console.log(`  通过 ${passed}   失败 ${failed}`);
  console.log("====================================================");
  process.exit(failed ? 1 : 0);
}

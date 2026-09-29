/* tools/_probe-cdn-reach.cjs —— 外网 CDN 可达性对照探针
 *
 * 【为什么需要它】
 *   「在浏览器中打开」DWG 时，cad-viewer 会**卡在「正在解析BTRs...」**，
 *   页面报：
 *     无法从 "https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/fonts/"
 *     获取可用的字体信息！
 *   cad-viewer 的字体/形文件**只从这一个 CDN 取**，容器内没有任何本地副本
 *   （实测 `find /app/dist -iname "*font*"` 为空）。该 CDN 一旦不可达，
 *   图纸就永远打不开 —— 而**取流本身是成功的**（/api/raw 返回 200 + dwg 字节），
 *   所以「服务端一切正常、浏览器就是打不开」。
 *
 * 【为什么不能只看一个域名】
 *   本网络里 `cdn.jsdelivr.net` 被阻断时，`unpkg.com` / `baidu.com` **仍然正常**。
 *   只测 jsdelivr 得到 000，很容易误判成「没网」。必须做**同期对照**。
 *   实测（2026-09-30）：jsdelivr 000，unpkg 200，baidu 200，内网 nebula 200
 *   ⇒ 网络正常，唯独 jsdelivr 被阻断。且**阻断是间歇的**
 *   （同一分钟内：先 200/0.5s，随后连续 6 次 000）。
 *
 * 【怎么用】
 *   node tools/_probe-cdn-reach.cjs
 *   可选：NB_CAD_FONT=<url> 换被测的字体地址
 *         NB_REPEAT=<n>     每个目标重复次数（默认 3，用于观察间歇性）
 *
 * 【判读】
 *   jsdelivr 出现 000 / time_connect=0 ⇒ DWG 打不开就是它的锅。
 *   若三个外网目标全 000 而内网 200 ⇒ 是整体断网，不是 CDN 问题。
 */
const { NEBULA } = require("./_local.cjs");

const FONT_URL = process.env.NB_CAD_FONT ||
  "https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/fonts/fonts.json";
const REPEAT = Math.max(1, Number(process.env.NB_REPEAT || 3));

// ★ 必须同批测「本可用的外网」与「内网」，否则无法区分 CDN 阻断 vs 断网 ★
const TARGETS = [
  { name: "jsdelivr(CDN)", url: FONT_URL },
  { name: "unpkg(CDN)", url: "https://unpkg.com/" },
  { name: "baidu(外网)", url: "https://www.baidu.com/" },
  { name: "nebula(内网)", url: NEBULA + "/" },
];

const once = async (url) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    const ms = Date.now() - t0;
    // 读一点 body，确保不是「头到了、体挂了」
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, status: r.status, ms, bytes: buf.length };
  } catch (e) {
    return { ok: false, err: e.name === "TimeoutError" ? "TIMEOUT" : e.message, ms: Date.now() - t0 };
  }
};

(async () => {
  console.log(`被测 CDN 字体地址：${FONT_URL}`);
  console.log(`每个目标 ${REPEAT} 次（观察间歇性阻断）\n`);

  const summary = [];
  for (const t of TARGETS) {
    const rs = [];
    for (let i = 0; i < REPEAT; i++) rs.push(await once(t.url));
    const okN = rs.filter((r) => r.ok).length;
    const detail = rs
      .map((r) => (r.ok ? `${r.status}(${r.ms}ms,${r.bytes}B)` : `✗${r.err}(${r.ms}ms)`))
      .join("  ");
    console.log(`${t.name.padEnd(16)} ${okN}/${REPEAT}  ${detail}`);
    summary.push({ name: t.name, okN, total: REPEAT });
  }

  console.log("\n---------------- 判读 ----------------");
  const g = (n) => summary.find((s) => s.name.startsWith(n));
  const cdn = g("jsdelivr");
  const outer = g("unpkg");
  const inner = g("nebula");

  if (cdn && cdn.okN === 0 && outer && outer.okN > 0) {
    console.log("[结论] cdn.jsdelivr.net 被阻断，而其它外网可用。");
    console.log("       ⇒ DWG 打不开（卡「正在解析BTRs...」）就是此因。");
    console.log("       ⇒ 修法：把 cad-viewer 内的 CDN 基址换成本地/可达镜像");
    console.log("         （/app/dist/assets/main-*.js 里的");
    console.log("          https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/ ）");
  } else if (cdn && cdn.okN > 0 && cdn.okN < cdn.total) {
    console.log("[结论] jsdelivr 间歇性可达 —— 属不稳定阻断。");
    console.log("       ⇒ DWG 会时好时坏，仍应换本地字体源。");
  } else if (outer && outer.okN === 0 && inner && inner.okN > 0) {
    console.log("[结论] 外网整体不可达（内网正常）⇒ 不是 CDN 特有问题。");
  } else if (cdn && cdn.okN === cdn.total) {
    console.log("[结论] jsdelivr 当前可达 ⇒ DWG 若仍打不开，去查别的环节");
    console.log("       （用 tools/_probe-open-in-browser.cjs 抓浏览器报错）。");
  } else {
    console.log("[结论] 结果不典型，请人工判读上面的逐条输出。");
  }
})();

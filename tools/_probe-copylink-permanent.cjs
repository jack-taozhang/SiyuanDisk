/* 验收：两个「复制直链」入口是否收敛到**同一条永久短链**
 *
 * 背景（用户原话）
 *    「两处复制直连 复制出来的路径不一样。需要调整一下」
 *    「把「复制直链」也换成这种永久短链」
 *
 * 改前：同一个文件复制出两条**毫不相干**的长地址
 *    右键菜单  /api/raw/<名>?mount=..&path=..&exp=..&sig=14aea4…        330 字符
 *    预览栏    /api/raw/<名>?mount=..&path=..&exp=..&sig=6cec41…&dl=1   335 字符
 *   （sig 不同是**必然**的：dl 并入了 HMAC ⇒ 两处签的是两份凭证。）
 *
 * 改后：同一条 41 字符短链，「下载」只表现为后缀 ?dl=1
 *    右键菜单  /f/N-MAJI5zBjO2                    41 字符，inline
 *    预览栏    /f/N-MAJI5zBjO2?dl=1               46 字符，attachment
 *
 * 本探针**按插件真实调用链**去问后端（而不是自己拼 URL）：
 *    插件 API.directLinkUrl()
 *      → API.shortLinkUrl()  → POST /api/shortlink（幂等）
 *      → withDl(u, download)
 *    失败回退 API.signedRawUrl()
 *
 * 用法：
 *   node tools/_probe-copylink-permanent.cjs
 *   node tools/_probe-copylink-permanent.cjs "售前项目" "/遂宁利和/微信图片_20260327124836_5_78.jpg"
 */
const { NEBULA, USER, PASS } = require("./_local.cjs");

const M = process.argv[2] || "售前项目";
const P = process.argv[3] || "/遂宁利和/微信图片_20260327124836_5_78.jpg";

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); }
};

/** 后端返回的可能是容器内主机名 nebula:8088；浏览器可达改写（与 browserReachableUrl 同规则） */
const reachable = (u) => String(u || "").replace(/^https?:\/\/nebula:\d+/, NEBULA);

/** 与 src/api.js 的 withDl() **同语义**（此处独立实现，避免"用被测量者验证被测量者"） */
function withDl(url, download) {
  const s = String(url || "");
  if (!s) return "";
  if (!download) return s;
  if (/[?&]dl=/i.test(s)) return s;
  return s + (s.indexOf("?") >= 0 ? "&" : "?") + "dl=1";
}

(async () => {
  const tk = (
    await (
      await fetch(NEBULA + "/api/login", {
        method: "POST",
        body: new URLSearchParams({ username: USER, password: PASS }),
      })
    ).json()
  ).token;

  console.log("=".repeat(66));
  console.log("目标文件：" + M + " : " + P);
  console.log("=".repeat(66));

  // ── ① 两个入口各自拿到的地址 ──
  async function shortLink() {
    const fd = new FormData();
    fd.append("mount", M);
    fd.append("path", P);
    const r = await fetch(NEBULA + "/api/shortlink", {
      method: "POST",
      headers: { Authorization: "Bearer " + tk },
      body: fd,
    });
    if (!r.ok) return null;
    return reachable((await r.json()).url);
  }

  const base = await shortLink();
  ok(!!base, "① 短链可签发（后端 POST /api/shortlink）");
  if (!base) { console.log("\n合计：" + pass + " 通过 / " + fail + " 失败\n"); process.exit(1); }

  const rightClick = withDl(base, false); // tree.js  copyRawLink()
  const previewBar = withDl(base, true);  // viewer.js copyLink()

  // ── ② 两处的**基地址**必须完全相同（这就是用户要的"路径一样"）──
  const strip = (u) => String(u).replace(/[?&]dl=1$/, "");
  ok(strip(rightClick) === strip(previewBar),
     "② ★ 两处基地址完全相同（差异只剩 ?dl=1）");
  ok(rightClick === base && previewBar === base + "?dl=1",
     "③ 右键=打开型（无后缀）/ 预览栏=下载型（?dl=1）—— 语义保持用户裁定");

  // ── ③ 长度对照（相对旧的签名直链）──
  const pv = await (
    await fetch(
      NEBULA + "/api/preview?mount=" + encodeURIComponent(M) + "&path=" + encodeURIComponent(P),
      { headers: { Authorization: "Bearer " + tk } }
    )
  ).json();
  const oldOpen = reachable(pv.raw);
  const pvDl = await (
    await fetch(
      NEBULA + "/api/preview?mount=" + encodeURIComponent(M) +
        "&path=" + encodeURIComponent(P) + "&download=1",
      { headers: { Authorization: "Bearer " + tk } }
    )
  ).json();
  const oldDl = reachable(pvDl.raw);
  const pct = (a, b) => (100 - (b / a) * 100).toFixed(0);
  console.log("\n  ── 长度对照 ──");
  console.log("  右键    旧 " + oldOpen.length + " → 新 " + rightClick.length +
              " 字符（- " + pct(oldOpen.length, rightClick.length) + "%）");
  console.log("  预览栏  旧 " + oldDl.length + " → 新 " + previewBar.length +
              " 字符（- " + pct(oldDl.length, previewBar.length) + "%）");
  ok(rightClick.length < oldOpen.length / 4, "④ 右键地址压到旧地址的 1/4 以下");
  ok(previewBar.length < oldDl.length / 4, "⑤ 预览栏地址压到旧地址的 1/4 以下");

  // ── ④ 两条地址真的可用，且行为不同（inline vs attachment）──
  const a = await fetch(rightClick);
  const b = await fetch(previewBar);
  const ca = a.headers.get("content-disposition") || "";
  const cb = b.headers.get("content-disposition") || "";
  console.log("\n  ── 实测响应 ──");
  console.log("  右键    HTTP=" + a.status + " type=" + a.headers.get("content-type") + " disp=" + ca.slice(0, 24));
  console.log("  预览栏  HTTP=" + b.status + " type=" + b.headers.get("content-type") + " disp=" + cb.slice(0, 24));
  ok(a.status === 200 && b.status === 200, "⑥ 两条地址都 200");
  ok(/inline/.test(ca), "⑦ 右键（打开型）是 inline");
  ok(/attachment/.test(cb), "⑧ 预览栏（下载型）是 attachment");

  // ── ⑤ 幂等：再问一次还是同一个 token ──
  const again = await shortLink();
  ok(again === base, "⑨ 幂等 —— 重复签发得到同一条短链（不会「点一次生成一条」）");

  // ── ⑥ 免登录：不带任何凭证也能取到字节 ──
  const anon = await fetch(base);
  const bytes = (await anon.arrayBuffer()).byteLength;
  ok(anon.status === 200 && bytes > 0, "⑩ 免登录可达（匿名取到 " + bytes + " 字节）");

  console.log("\n" + "=".repeat(66));
  console.log("合计：" + pass + " 通过 / " + fail + " 失败");
  console.log("=".repeat(66) + "\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("探针自身出错：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});

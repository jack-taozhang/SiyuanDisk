/**
 * 找一张真实存在的 CAD 图纸，并生成新鲜的 /lite 深链。
 * 步骤：login → /api/me 取 mounts → /api/search 搜 .dwg → /api/cad/preview
 * 用法: node _find-cad.cjs
 */
const fs = require("fs");
const { PASS } = require("./_secrets.cjs");

const B = "http://172.16.30.128:8089";
const out = [];
const P = (s) => out.push(s);

async function J(path, opt) {
  const r = await fetch(B + path, opt);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = { __raw: t.slice(0, 300) }; }
  return { status: r.status, j };
}

(async () => {
  const lr = await fetch(B + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=tao_zhang&password=" + encodeURIComponent(PASS),
  });
  const lj = await lr.json();
  const auth = { Authorization: "Bearer " + lj.token };
  P("login HTTP " + lr.status);

  const me = await J("/api/me", { headers: auth });
  P("me HTTP " + me.status);
  const mounts = (me.j && me.j.mounts) || [];
  P("mounts(" + mounts.length + "): " + mounts.map((m) => (m.label || m.name || JSON.stringify(m))).join(" | "));

  // 逐个挂载点搜 .dwg
  const hits = [];
  for (const m of mounts) {
    const label = m.label || m.name;
    if (!label) continue;
    const s = await J("/api/search?mount=" + encodeURIComponent(label) +
      "&q=" + encodeURIComponent(".dwg") + "&path=" + encodeURIComponent("/") + "&limit=5",
      { headers: auth });
    const arr = (s.j && (s.j.hits || s.j.entries || s.j.results)) || [];
    P("  [" + label + "] search HTTP " + s.status + " hits=" + arr.length +
      (arr.length ? "  首个: " + (arr[0].path || arr[0].name) : "  " + JSON.stringify(s.j).slice(0, 160)));
    for (const h of arr.slice(0, 5)) {
      // ★ 只看**文件**：搜索会把名为 DWG 的目录也命中 ★
      const p = String(h.path || "");
      if (!/\.(dwg|dxf|dwf)$/i.test(p)) continue;
      hits.push({ mount: label, path: p, name: h.name || p });
    }
  }

  if (!hits.length) { P("没搜到 .dwg"); fs.writeFileSync(__dirname + "/_find-cad.txt", out.join("\n"), "utf8"); return; }

  const pick = hits[0];
  P("");
  P("选用: mount=" + pick.mount);
  P("      path=" + pick.path);

  const pv = await J("/api/cad/preview?mount=" + encodeURIComponent(pick.mount) +
    "&path=" + encodeURIComponent(pick.path), { headers: auth });
  P("cad/preview HTTP " + pv.status + "  " + JSON.stringify(pv.j).slice(0, 300));

  const url = (pv.j && pv.j.url) || "";
  if (url) {
    const direct = B + url;
    const lite = B + "/lite?kind=cad&target=" + encodeURIComponent(url);
    fs.writeFileSync(__dirname + "/_nas-src/_cad-direct.url", direct, "utf8");
    fs.writeFileSync(__dirname + "/_nas-src/_cad-lite.url", lite, "utf8");
    P("");
    P("direct: " + direct);
    P("lite  : " + lite);

    // 验签名是否新鲜
    const open = new URL(url, B).searchParams.get("open") || "";
    const hr = await fetch(open, { method: "HEAD", headers: auth });
    P("raw HEAD HTTP " + hr.status + "  bytes=" + hr.headers.get("content-length"));
  }
  fs.writeFileSync(__dirname + "/_find-cad.txt", out.join("\n"), "utf8");
})();

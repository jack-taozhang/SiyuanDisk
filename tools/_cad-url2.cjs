/**
 * 生成一条**新鲜的** CAD 深链（签名有时效，缓存的会过期）。
 * 中文完全写在文件里（UTF-8），不经 shell 传参 —— 避免 PowerShell 改编码。
 *
 * 用法: node _cad-url2.cjs [mount] [path]
 * 默认用上次实测过的那张图；不给参数即用默认值。
 */
const fs = require("fs");
const { PASS } = require("./_secrets.cjs");

const B = "http://192.168.193.70:8089";
const MOUNT = process.argv[2] || "售前项目";
const PATH = process.argv[3] || "/2025年08月/250501+中国铁建项目/CL2-图块.dwg";

(async () => {
  const out = [];
  const P = (s) => out.push(s);

  // 1) 登录拿 token
  const lr = await fetch(B + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=tao_zhang&password=" + encodeURIComponent(PASS),
  });
  const lj = await lr.json().catch(() => ({}));
  P("login: HTTP " + lr.status + " token=" + (lj.token ? "有(" + String(lj.token).length + ")" : "无"));
  if (!lj.token) { P(JSON.stringify(lj)); fs.writeFileSync(__dirname + "/_cad-url2.txt", out.join("\n"), "utf8"); return; }

  // 2) 取 CAD 深链
  const q = "/api/cad/preview?mount=" + encodeURIComponent(MOUNT) + "&path=" + encodeURIComponent(PATH);
  const pr = await fetch(B + q, { headers: { Authorization: "Bearer " + lj.token } });
  const pj = await pr.json().catch(() => ({}));
  P("preview: HTTP " + pr.status);
  P(JSON.stringify(pj).slice(0, 500));

  const url = pj.url || "";
  if (!url) { fs.writeFileSync(__dirname + "/_cad-url2.txt", out.join("\n"), "utf8"); return; }

  const direct = B + url;
  const lite = B + "/lite?kind=cad&target=" + encodeURIComponent(url);
  fs.writeFileSync(__dirname + "/_nas-src/_cad-direct.url", direct, "utf8");
  fs.writeFileSync(__dirname + "/_nas-src/_cad-lite.url", lite, "utf8");

  // 3) 顺手验证深链里的图纸 raw 是否可拉（签名是否新鲜）
  const open = new URL(url, B).searchParams.get("open") || "";
  if (open) {
    const hr = await fetch(open, { method: "HEAD" });
    P("raw HEAD: HTTP " + hr.status + "  content-length=" + hr.headers.get("content-length") +
      "  type=" + hr.headers.get("content-type"));
  }

  P("");
  P("direct: " + direct);
  P("lite  : " + lite);
  fs.writeFileSync(__dirname + "/_cad-url2.txt", out.join("\n"), "utf8");
})();

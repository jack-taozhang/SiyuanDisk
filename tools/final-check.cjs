/* 最终验收：验证思源内嵌代理 (6810) 的完整能力 */
const http = require("http");
const { PASS } = require("./_secrets.cjs");
const fs = require("fs");
const O = (s) => process.stdout.write(String(s) + "\n");

function call(method, p, body, ctype, hdr, port = 6810) {
  return new Promise((res) => {
    let data = null, headers = Object.assign({}, hdr || {});
    if (body) {
      data = ctype === "json" ? Buffer.from(JSON.stringify(body)) : Buffer.from(new URLSearchParams(body).toString());
      headers["content-type"] = ctype === "json" ? "application/json" : "application/x-www-form-urlencoded";
      headers["content-length"] = data.length;
    }
    const r = http.request({ host: "127.0.0.1", port, path: p, method, timeout: 25000, headers }, (resp) => {
      let b = ""; resp.on("data", (c) => (b += c));
      resp.on("end", () => res({ code: resp.statusCode, h: resp.headers, body: b }));
    });
    r.on("error", (e) => res({ code: -1, body: e.message, h: {} }));
    r.on("timeout", () => { r.destroy(); res({ code: -2, body: "timeout", h: {} }); });
    if (data) r.write(data);
    r.end();
  });
}

const ORIGIN = "http://127.0.0.1:6806";

(async () => {
  O("╔═══════════════════════════════════════════════════════════╗");
  O("║   最终验收：思源内嵌代理 127.0.0.1:6810（实机运行中）     ║");
  O("╚═══════════════════════════════════════════════════════════╝");
  O("");

  O("【1】代理健康");
  let r = await call("GET", "/__ping");
  O(`  ${r.code}  ${r.body.replace(/\s+/g, " ").slice(0, 250)}`);

  O("");
  O("【2】CORS 头（思源页面跨源必需）");
  r = await call("GET", "/__ping", null, null, { Origin: ORIGIN });
  O(`  ACAO = ${r.h["access-control-allow-origin"]}`);
  r = await call("OPTIONS", "/api/list", null, null, {
    Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "content-type",
  });
  O(`  OPTIONS /api/list = ${r.code}  ACAO=${r.h["access-control-allow-origin"]}  ACAM=${r.h["access-control-allow-methods"]}`);

  O("");
  O("【3】登录 + 挂载点");
  r = await call("POST", "/api/login", { username: "tao_zhang", password: PASS }, "form", { Origin: ORIGIN });
  O(`  login = ${r.code}  ${r.body.replace(/\s+/g, " ").slice(0, 100)}`);
  r = await call("GET", "/api/me", null, null, { Origin: ORIGIN });
  const me = JSON.parse(r.body);
  O(`  me    = ${r.code}  用户=${me.username}  管理员=${me.isAdmin}`);
  O(`  挂载点: ${me.mounts.map((m) => m.label + (m.writable ? "" : "(只读)")).join(" / ")}`);
  O(`  磁盘: 可用 ${(me.disk.free / 1024 ** 4).toFixed(2)} TB / 共 ${(me.disk.total / 1024 ** 4).toFixed(2)} TB`);
  O(`  引擎: OnlyOffice=${me.onlyoffice}  CAD=${me.cad}`);

  O("");
  O("【4】逐挂载点列目录（侧边栏数据源）");
  for (const m of me.mounts) {
    r = await call("GET", `/api/list?mount=${encodeURIComponent(m.label)}&path=`, null, null, { Origin: ORIGIN });
    let d;
    try { d = JSON.parse(r.body); } catch { O(`  [${m.label}] 解析失败 ${r.body.slice(0, 120)}`); continue; }
    const ents = d.entries || [];
    const dirs = ents.filter((e) => e.isDir).length;
    const files = ents.length - dirs;
    O(`  [${m.label}] ${r.code}  共 ${ents.length} 项（目录 ${dirs} / 文件 ${files}）`);
    ents.slice(0, 5).forEach((e) => {
      O(`        ${e.isDir ? "[D]" : "   "} ${e.name}  ${e.isDir ? "" : (e.size / 1024).toFixed(1) + "KB"}  ${e.route || ""}`);
    });
    if (ents.length > 5) O(`        … 其余 ${ents.length - 5} 项`);
  }

  O("");
  O("【5】预览能力实测（找文件取 kkFileView / OnlyOffice 地址）");
  let tested = 0;
  for (const m of me.mounts) {
    r = await call("GET", `/api/list?mount=${encodeURIComponent(m.label)}&path=`, null, null, { Origin: ORIGIN });
    let d; try { d = JSON.parse(r.body); } catch { continue; }
    const files = (d.entries || []).filter((e) => !e.isDir);
    for (const f of files.slice(0, 2)) {
      const path = f.path || f.name;
      r = await call("GET", `/api/preview?mount=${encodeURIComponent(m.label)}&path=${encodeURIComponent(path)}`, null, null, { Origin: ORIGIN });
      let pj; try { pj = JSON.parse(r.body); } catch { pj = null; }
      O(`  ${m.label}/${f.name}  (route=${f.route || "?"})`);
      O(`      /api/preview => ${r.code}  ${pj && pj.ok ? "✅ " + String(pj.url).slice(0, 90) : r.body.slice(0, 100)}`);
      tested++;
      if (tested >= 4) break;
    }
    if (tested >= 4) break;
  }

  O("");
  O("【6】引擎健康");
  for (const p of ["/api/kk/health", "/api/oo/health", "/api/cad/health"]) {
    r = await call("GET", p, null, null, { Origin: ORIGIN });
    O(`  ${p} => ${r.code}  ${r.body.replace(/\s+/g, " ").slice(0, 120)}`);
  }

  O("");
  O("【7】下载直链（附件取流）");
  r = await call("GET", `/api/list?mount=${encodeURIComponent(me.mounts[0].label)}&path=`, null, null, { Origin: ORIGIN });
  const d0 = JSON.parse(r.body);
  const one = (d0.entries || []).find((e) => !e.isDir);
  if (one) {
    r = await call("GET", `/api/download?mount=${encodeURIComponent(me.mounts[0].label)}&path=${encodeURIComponent(one.path || one.name)}&inline=true`, null, null, { Origin: ORIGIN });
    O(`  ${one.name} => ${r.code}  type=${r.h["content-type"]}  len=${r.h["content-length"]}  disp=${String(r.h["content-disposition"] || "").slice(0, 60)}`);
  }

  O("");
  O("【8】cookie 落盘");
  for (const p of [
    "D:/Software/SiYuan/storage/nebuladisk.cookie.json",
    "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/nebuladisk.cookie.json",
  ]) {
    try {
      const c = fs.readFileSync(p, "utf8");
      O(`  ✅ ${p}`);
      O(`     ${c.slice(0, 150)}`);
    } catch { O(`  ✗ ${p}`); }
  }
})();

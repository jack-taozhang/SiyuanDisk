/**
 * 找 nebula 的文件列表接口：读 FastAPI 的 /openapi.json，列出所有路径。
 * 用法: node _api-map.cjs
 */
const fs = require("fs");
const B = "http://172.16.30.128:8089";

(async () => {
  const out = [];
  const r = await fetch(B + "/openapi.json");
  out.push("openapi HTTP " + r.status);
  const j = await r.json().catch(() => null);
  if (!j) { out.push("拿不到 openapi.json"); fs.writeFileSync(__dirname + "/_api-map.txt", out.join("\n"), "utf8"); return; }

  const paths = Object.keys(j.paths || {}).sort();
  out.push("共 " + paths.length + " 个路径：");
  for (const p of paths) {
    const methods = Object.keys(j.paths[p]).map((m) => m.toUpperCase()).join(",");
    out.push("  " + methods.padEnd(28) + " " + p);
  }

  // 单独把文件相关的挑出来
  out.push("");
  out.push("== 文件/目录相关 ==");
  for (const p of paths) {
    if (/list|ls|dir|file|mount|tree|search|browse/i.test(p)) {
      const op = j.paths[p];
      for (const m of Object.keys(op)) {
        const prm = (op[m].parameters || []).map((x) => x.name + (x.required ? "*" : "")).join(", ");
        out.push("  " + m.toUpperCase() + " " + p + "   params: " + prm);
      }
    }
  }
  fs.writeFileSync(__dirname + "/_api-map.txt", out.join("\n"), "utf8");
})();

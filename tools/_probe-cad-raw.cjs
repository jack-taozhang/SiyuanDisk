/**
 * 证明「CAD 预览页面本身」没有被注入任何 CSS/JS：
 *   把 nebula 反代出的 /cad/ HTTP 响应，与 cad-viewer 容器里那份
 *   /app/cad/index.html 做逐字节比对（md5 + 长度 + 首尾）。
 *
 * 若两者一致 ⇒ 反代链路（nebula /cad/ → cad-viewer）是**纯透传**，
 *            页面上没有任何我们后来塞进去的东西。
 *
 * 用法: node _probe-cad-raw.cjs
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const { spawnSync } = require("child_process");

const BASE = "http://172.16.30.128:8089";

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get(BASE + path, { timeout: 20000 }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => res({ status: r.statusCode, buf: Buffer.concat(chunks), headers: r.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
  });
}

function ssh(cmd) {
  const r = spawnSync(process.execPath, [__dirname + "/ssh-nb.cjs", cmd], { encoding: "utf8" });
  return String(r.stdout || "").trim();
}

(async () => {
  const out = [];
  const P = (s) => out.push(s);

  // 1) 容器内原始文件
  const remoteMd5 = ssh("docker exec cad-viewer md5sum /app/cad/index.html");
  const remoteSize = ssh("docker exec cad-viewer wc -c /app/cad/index.html");
  P("容器内 /app/cad/index.html :");
  P("   " + remoteMd5);
  P("   " + remoteSize);

  // 2) 经 nebula 反代取 /cad/
  const r = await get("/cad/");
  const m = crypto.createHash("md5").update(r.buf).digest("hex");
  P("");
  P("HTTP /cad/ : status=" + r.status + " bytes=" + r.buf.length);
  P("   md5=" + m);
  P("   content-type=" + r.headers["content-type"]);
  P("   server=" + r.headers["server"] + "  x-powered-by=" + r.headers["x-powered-by"]);

  // 3) 判据
  const body = r.buf.toString("utf8");
  P("");
  P("== 判据 ==");
  P("长度一致            : " + (remoteSize.endsWith(String(r.buf.length)) ? "✅ 一致" : "❌ 不一致"));
  P("md5 一致            : " + (remoteMd5.includes(m) ? "✅ 一致（纯透传，无注入）" : "❌ 不一致（存在注入/改写）"));
  P("含 nb- 注入标记     : " + /nb-lite-css|nb-cad-hide|nb-lite-frame/.test(body));
  P("含 mlightcad 播种   : " + /mlightcad\.settings/.test(body));
  P("style 标签数        : " + (body.match(/<style/g) || []).length);
  P("script 标签数       : " + (body.match(/<script/g) || []).length);
  P("含 inline display:none 强塞 : " + /setProperty\(\s*['"]display['"]/.test(body));

  // 4) 同时看看 /cad/index.html 直连
  const r2 = await get("/cad/index.html");
  const m2 = crypto.createHash("md5").update(r2.buf).digest("hex");
  P("");
  P("HTTP /cad/index.html : status=" + r2.status + " bytes=" + r2.buf.length + " md5=" + m2 +
    (m2 === m ? "  ✅ 与 /cad/ 同一份" : "  ❌ 不同"));

  fs.writeFileSync(__dirname + "/_probe-cad-raw.txt", out.join("\n"), "utf8");
  fs.writeFileSync(__dirname + "/_cad-live.html", body, "utf8");
  console.log(out.join("\n"));
})();

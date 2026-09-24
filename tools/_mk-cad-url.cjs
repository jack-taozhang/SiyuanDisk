/**
 * 取 CAD 预览深链（以及 /lite 外壳地址），用于浏览器实况复现。
 * 用法: node _mk-cad-url.cjs "<mount>" "<path>"
 */
const { spawnSync } = require("child_process");
const { PASS } = require("./_secrets.cjs");

const B = "http://172.16.30.128:8089";
const MOUNT = process.argv[2] || "售前项目";
const FILEPATH = process.argv[3];

function curl(a) {
  const r = spawnSync("curl", ["-s", ...a], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}

const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;

const raw = curl(["-H", "Authorization: Bearer " + tok,
  B + "/api/cad/preview?mount=" + encodeURIComponent(MOUNT) + "&path=" + encodeURIComponent(FILEPATH)]);
console.log("=== /api/cad/preview ===");
console.log(raw.slice(0, 900));

let url = "";
try { const j = JSON.parse(raw); url = j.url || j.deep || ""; } catch (e) {}
console.log("\n=== raw url ===");
console.log(url);
if (url) {
  const direct = B + url;
  const lite = B + "/lite?kind=cad&target=" + encodeURIComponent(url);
  console.log("\n=== 直连（页签用） ===");
  console.log(direct);
  console.log("\n=== /lite 外壳（嵌入块用） ===");
  console.log(lite);
  require("fs").writeFileSync(__dirname + "/_nas-src/_cad-direct.url", direct, "utf8");
  require("fs").writeFileSync(__dirname + "/_nas-src/_cad-lite.url", lite, "utf8");
  console.log("\n(已写入 tools/_nas-src/_cad-direct.url 与 _cad-lite.url)");
}

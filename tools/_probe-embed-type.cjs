/**
 * 临时探针：api.js 里 type=embedded 的路由逻辑。
 */
const { SUDO } = require("./_secrets.cjs");
const { spawnSync } = require("child_process");

function run(cmd) {
  const r = spawnSync(process.execPath, ["./ssh-nb.cjs", cmd], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}

// api.js 下载到本地再分析，避免嵌套引号地狱
const b64 = run(SUDO + "docker exec onlyoffice base64 -w0 /var/www/onlyoffice/documentserver/web-apps/apps/api/documents/api.js");
const fs = require("fs");
fs.writeFileSync("_nas-src/api.js", Buffer.from(b64.replace(/\s+/g, ""), "base64"));
const js = fs.readFileSync("_nas-src/api.js", "utf8");
console.log("api.js bytes:", js.length);

// embedded 相关行
const lines = js.split(/\n/);
lines.forEach((l, i) => {
  if (/embedded/i.test(l)) {
    console.log(i + 1 + ": " + l.trim().slice(0, 200));
  }
});

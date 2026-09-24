/**
 * 探针：找一个 >100MB 的 Office 文件，跑 OO conversion（= 打开文档的核心链路），
 * 看大文件是否真的被放行。用法: node _probe-bigfile.cjs [最小MB]
 */
const crypto = require("crypto");
const { PASS, SUDO } = require("./_secrets.cjs");
const { spawnSync } = require("child_process");
const B = "http://172.16.30.128:8089";
const SECRET = process.env.NB_OO_SECRET || "";
if (!SECRET) { console.error("缺少 NB_OO_SECRET（= compose 里 NEBULA_OO_SECRET）"); process.exit(2); }
const MIN_MB = Number(process.argv[2] || 100);

const b64u = (s) => Buffer.from(s).toString("base64url");
function curl(args) {
  const r = spawnSync("curl", ["-s", ...args], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}
function ssh(cmd) {
  const r = spawnSync(process.execPath, ["./ssh-nb.cjs", cmd], { encoding: "utf8", maxBuffer: 1e8 });
  return (r.stdout || "").trim();
}

// 宿主上直接找大文件（挂载点 /vol1/1000/<盘>）
const out = ssh(SUDO + `find /vol1/1000/售前项目 /vol1/1000/研发立项 /vol1/1000/项目设计 -type f -size +${MIN_MB}M -regex '.*\\.\\(docx\\|xlsx\\|pptx\\|doc\\|xls\\|ppt\\)' 2>/dev/null | head -5`);
const files = out.split("\n").filter(Boolean);
console.log(`>${MIN_MB}MB 的 Office 文件:`, files.length ? "\n  " + files.join("\n  ") : "(未找到)");
if (!files.length) process.exit(0);

const abs = files[0];
// 反推 mount / path
const m = abs.match(/^\/vol1\/1000\/([^/]+)(\/.*)$/);
const mount = m[1], path = m[2];
console.log("测试目标:", mount, path);

const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;
const cfg = JSON.parse(curl(["-X", "POST", B + "/api/oo/config",
  "-H", "Authorization: Bearer " + tok,
  "-d", "mount=" + encodeURIComponent(mount) + "&path=" + encodeURIComponent(path)]));
if (!cfg.config) { console.log("config 获取失败:", JSON.stringify(cfg).slice(0, 200)); process.exit(1); }
const docUrl = cfg.config.document.url;
console.log("doc_url host:", docUrl.split("/api/")[0]);

// 1) 容器内直接下载（测 nebula → OO 拉取）
const inner = ssh(SUDO + `docker exec onlyoffice curl -s -o /dev/null -w 'HTTP:%{http_code} bytes:%{size_download} time:%{time_total}' "${docUrl}"`);
console.log("容器内下载:", inner);

// 2) 通过 OO conversion（open 链路的核心）
const payload = { async: false, key: "bigprobe-" + Date.now(), url: docUrl, outputtype: "pdf", title: "bigprobe" };
const header = { alg: "HS256", typ: "JWT" };
const sig = crypto.createHmac("sha256", SECRET)
  .update(b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload))).digest("base64url");
const jwt = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload)) + "." + sig;
require("fs").writeFileSync("_nas-src/_big-body.json", JSON.stringify(Object.assign({}, payload, { token: jwt })));
console.log("conversion 请求中（大文件可能要几十秒）...");
const res = curl(["-X", "POST", "http://172.16.30.128:8082/converter",
  "-H", "Content-Type: application/json", "--data-binary", "@_nas-src/_big-body.json", "-m", "180"]);
console.log("conversion 响应:", res.slice(0, 400));

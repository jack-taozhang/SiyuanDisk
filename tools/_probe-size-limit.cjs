/**
 * 探针：验证 OnlyOffice 真实的下载大小上限（EMSGSIZE 阈值）。
 * 用法: node _probe-size-limit.cjs "<mount>" "<path>"
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PASS, SUDO } = require("./_secrets.cjs");

const B = "http://192.168.193.70:8089";
// ★ JWT secret 不入库（仓库是公开的）：从环境变量取，缺了直接退出 ★
const SECRET = process.env.NB_OO_SECRET || "";
if (!SECRET) { console.error("缺少 NB_OO_SECRET（= compose 里 NEBULA_OO_SECRET）。export NB_OO_SECRET='…' 后重跑"); process.exit(2); }
const MOUNT = process.argv[2] || "售前项目";
const FILEPATH = process.argv[3] || "/物流方案宣传册.pptx";

const TMP = path.join(__dirname, "_nas-src");
fs.mkdirSync(TMP, { recursive: true });

function curl(args, opts) {
  const r = spawnSync("curl", ["-s", ...args], Object.assign({ encoding: "utf8", maxBuffer: 1e8 }, opts));
  return r.stdout || "";
}
function ssh(cmd) {
  const r = spawnSync(process.execPath, ["./ssh-nb.cjs", cmd], { encoding: "utf8", maxBuffer: 1e8, cwd: __dirname });
  return (r.stdout || "").trim();
}

const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;

const cfgRaw = curl(["-X", "POST", B + "/api/oo/config",
  "-H", "Authorization: Bearer " + tok,
  "-d", "mount=" + encodeURIComponent(MOUNT) + "&path=" + encodeURIComponent(FILEPATH)]);
let cfg;
try { cfg = JSON.parse(cfgRaw); } catch (e) { console.log("config 解析失败:", cfgRaw.slice(0, 300)); process.exit(1); }
if (!cfg.config) { console.log("config 获取失败:", JSON.stringify(cfg).slice(0, 300)); process.exit(1); }

const containerUrl = cfg.config.document.url;
// 浏览器/宿主机可达地址：只换主机端口，签名参数原样保留
const hostUrl = containerUrl.replace("http://nebula:8088", B);
const key = cfg.config.document.key;

console.log("文件:", MOUNT + ":" + FILEPATH);
console.log("doc.key:", key, " fileType:", cfg.config.document.fileType, " type:", cfg.config.type || "(无)");

// ① 宿主量 content-length
const head = curl(["-sI", hostUrl]);
const cl = (head.match(/content-length:\s*(\d+)/i) || [])[1] || "?";
console.log("\n[① 宿主 HEAD] content-length =", cl, "=", (Number(cl) / 1048576).toFixed(1), "MiB");

// ② 容器内 HEAD（用 base64 传 URL，避开远端 shell 的引号/& 问题）
const urlB64 = Buffer.from(containerUrl, "utf8").toString("base64");
const inner = ssh(SUDO + `docker exec onlyoffice sh -c "echo '${urlB64}' | base64 -d > /tmp/_u.txt; curl -s -o /dev/null -w 'HTTP:%{http_code} content_length:%{size_header} bytes:%{size_download}' -I \\"$(cat /tmp/_u.txt)\\""`);
console.log("[② OO 容器 HEAD]", inner);

// ③ 走 OO /converter（= OO 自己的 downloadFile，EMSGSIZE 真正来源）
const b64u = (s) => Buffer.from(s).toString("base64url");
const payload = { async: false, key: "sizeprobe-" + Date.now(), url: containerUrl, outputtype: "pdf", title: "sizeprobe" };
const header = { alg: "HS256", typ: "JWT" };
const sig = crypto.createHmac("sha256", SECRET)
  .update(b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload))).digest("base64url");
const jwt = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload)) + "." + sig;
const bodyFile = path.join(TMP, "_size-body.json");
fs.writeFileSync(bodyFile, JSON.stringify(Object.assign({}, payload, { token: jwt })));

console.log("\n[③ /converter 请求中…]");
const t0 = Date.now();
const res = curl(["-X", "POST", "http://192.168.193.70:8082/converter",
  "-H", "Content-Type: application/json", "--data-binary", "@" + bodyFile, "-m", "300"]);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，响应:`, res.slice(0, 400) || "(空)");

// ④ 读 OO 日志里刚刚产生的 downloadFile 结果
console.log("\n[④ docservice 日志尾 8 行]");
console.log(ssh(SUDO + "docker exec onlyoffice tail -8 /var/log/onlyoffice/documentserver/docservice/out.log"));

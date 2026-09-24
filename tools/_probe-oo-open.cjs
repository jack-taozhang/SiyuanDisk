/**
 * 复现「OO 编辑器打开文档」这一步（= 前端 sdkjs 调 CommandService c=open，
 * 由 docservice 去 document.url 下载）。EMSGSIZE / 下载失败 就发生在这里。
 *
 * 用法: node _probe-oo-open.cjs "<mount>" "<path>" [--fresh]
 *   --fresh  用一个新的 document.key（证明「同 key 的失败缓存」是否在作祟）
 */
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { PASS, SUDO } = require("./_secrets.cjs");

const B = "http://172.16.30.128:8089";
const OO = "http://172.16.30.128:8082";
const SECRET = process.env.NB_OO_SECRET || "";
if (!SECRET) { console.error("缺少 NB_OO_SECRET（= compose 里 NEBULA_OO_SECRET）"); process.exit(2); }

const args = process.argv.slice(2);
const FRESH = args.includes("--fresh");
const [MOUNT, FILEPATH] = args.filter((a) => !a.startsWith("--"));

function curl(a) {
  const r = spawnSync("curl", ["-s", ...a], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}
function ssh(cmd) {
  const r = spawnSync(process.execPath, ["./ssh-nb.cjs", cmd], { encoding: "utf8", maxBuffer: 1e8, cwd: __dirname });
  return (r.stdout || "").trim();
}
const b64u = (s) => Buffer.from(s).toString("base64url");
function sign(payload) {
  const h = { alg: "HS256", typ: "JWT" };
  const sig = crypto.createHmac("sha256", SECRET).update(b64u(JSON.stringify(h)) + "." + b64u(JSON.stringify(payload))).digest("base64url");
  return b64u(JSON.stringify(h)) + "." + b64u(JSON.stringify(payload)) + "." + sig;
}

const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;

const cfg = JSON.parse(curl(["-X", "POST", B + "/api/oo/config",
  "-H", "Authorization: Bearer " + tok,
  "-d", "mount=" + encodeURIComponent(MOUNT) + "&path=" + encodeURIComponent(FILEPATH)]));
const c = cfg.config;
const key = FRESH ? crypto.randomBytes(16).toString("hex") : c.document.key;

console.log("文件:", MOUNT + ":" + FILEPATH);
console.log("document.key:", key, FRESH ? "(fresh)" : "(原始)");
console.log("document.url:", c.document.url);

const before = ssh(SUDO + "docker exec onlyoffice wc -l < /var/log/onlyoffice/documentserver/docservice/out.log").trim();
console.log("调用前 docservice 日志行数:", before);

// 前端 sdkjs 打开文档时发的请求
const payload = { c: "open", key, url: c.document.url, title: c.document.title || "probe", userid: "tao_zhang" };
const jwt = sign(payload);
const res = curl(["-X", "POST", OO + "/coauthoring/CommandService.ashx",
  "-H", "Content-Type: application/json",
  "-H", "Authorization: Bearer " + jwt,
  "--data-binary", JSON.stringify(Object.assign({}, payload, { token: jwt })), "-m", "240"]);
console.log("\nCommandService(c=open) 响应:", res.slice(0, 400) || "(空)");

console.log("\n--- 调用后新增的 docservice 日志 ---");
console.log(ssh(SUDO + `docker exec onlyoffice tail -n +${Number(before) + 1} /var/log/onlyoffice/documentserver/docservice/out.log`));

/**
 * 验证 NAS nebula 的 CORS 改动。
 *
 * 检查项：
 *   1) OPTIONS 预检 → 204/200 且带 Access-Control-Allow-Origin / -Methods / -Headers
 *   2) 实际 GET 带 Origin → 响应里有 Allow-Origin
 *   3) ★ 关键安全项：绝不能出现 Access-Control-Allow-Credentials: true ★
 *      （"*" + credentials 组合会被浏览器拒收，且等于全员 CSRF）
 *   4) /api/login 响应体里带 token，且该 token 可直接用于 Bearer 鉴权
 *   5) Bearer 鉴权 + CORS 的真实组合能取到 /api/me
 *
 * 用法：node verify-cors.cjs
 */
const http = require("http");

const HOST = "172.16.30.128";
const PORT = 8089;
const USER = "tao_zhang";
const { PASS } = require("./_secrets.cjs");
const ORIGIN = "http://127.0.0.1:6806"; // 模拟思源页面

function req(method, path, { body, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(payload);
    } else if (form) {
      payload = new URLSearchParams(form).toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h["Content-Length"] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: HOST, port: PORT, path, method, headers: h }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data.slice(0, 200) });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let fail = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
}

(async () => {
  console.log(`目标: http://${HOST}:${PORT}   模拟来源: ${ORIGIN}\n`);

  // ---- 1) 预检 ----
  console.log("--- 1) OPTIONS 预检 ---");
  const pre = await req("OPTIONS", "/api/me", {
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  const acao = pre.headers["access-control-allow-origin"];
  const acam = pre.headers["access-control-allow-methods"];
  const acah = pre.headers["access-control-allow-headers"];
  check("预检状态码", pre.status === 200 || pre.status === 204, `status=${pre.status}`);
  check("Allow-Origin", !!acao, `= ${acao}`);
  check("Allow-Methods", !!acam, `= ${acam}`);
  check("Allow-Headers", !!acah, `= ${acah}`);

  // ---- 2) 实际请求带 Origin ----
  console.log("\n--- 2) 实际 GET 带 Origin ---");
  const real = await req("GET", "/healthz", { headers: { Origin: ORIGIN } });
  check("GET 响应含 Allow-Origin", !!real.headers["access-control-allow-origin"], `= ${real.headers["access-control-allow-origin"]}`);

  // ---- 3) ★ 安全：绝不允许凭据 ★ ----
  console.log("\n--- 3) 安全：Allow-Credentials 必须不为 true ---");
  const credPre = pre.headers["access-control-allow-credentials"];
  const credReal = real.headers["access-control-allow-credentials"];
  check("预检无 Allow-Credentials=true", String(credPre) !== "true", `= ${credPre}`);
  check("实际无 Allow-Credentials=true", String(credReal) !== "true", `= ${credReal}`);

  // ---- 4) 登录返回 token ----
  console.log("\n--- 4) /api/login 返回 token ---");
  const login = await req("POST", "/api/login", {
    form: { username: USER, password: PASS },
    headers: { Origin: ORIGIN },
  });
  const token = login.json && login.json.token;
  check("登录成功", login.status === 200 && login.json && login.json.ok, `status=${login.status}`);
  check("响应体含 token", typeof token === "string" && token.length > 40, `len=${token ? token.length : 0}`);
  check("登录响应含 Allow-Origin", !!login.headers["access-control-allow-origin"], `= ${login.headers["access-control-allow-origin"]}`);

  // ---- 5) Bearer + CORS 组合 ----
  console.log("\n--- 5) Bearer token 跨域取 /api/me ---");
  if (token) {
    const me = await req("GET", "/api/me", {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    const n = me.json && Array.isArray(me.json.mounts) ? me.json.mounts.length : -1;
    check("Bearer 鉴权通过", me.status === 200 && n >= 0, `status=${me.status} mounts=${n}`);
    check("该响应含 Allow-Origin", !!me.headers["access-control-allow-origin"]);
  } else {
    check("Bearer 测试（跳过：无 token）", false);
  }

  // ---- 6) 错误响应也应带 CORS 头（否则前端读不到错误信息）----
  console.log("\n--- 6) 错误响应也要有 CORS 头 ---");
  const bad = await req("GET", "/api/preview", { headers: { Origin: ORIGIN } });
  check("400 响应含 Allow-Origin", !!bad.headers["access-control-allow-origin"], `status=${bad.status} origin=${bad.headers["access-control-allow-origin"]}`);
  check("400 错误体可读", !!(bad.json && (bad.json.error || bad.json.detail)), JSON.stringify(bad.json));

  console.log("");
  console.log(fail ? `❌ ${fail} 项未通过` : "✅ 全部通过");
  process.exit(fail ? 1 : 0);
})();

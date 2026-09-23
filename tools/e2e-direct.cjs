/**
 * 模拟「思源插件在浏览器里用直连通道」的完整链路。
 *
 * ★ 为什么不用 Node 的 fetch 直接测 ★
 *   Node 的 fetch **不做同源策略检查**，也不会因为缺 CORS 头而失败 ——
 *   所以它能"测通"，但浏览器里依然会被拦。这样测等于没测。
 *
 * 这里改成**手工模拟 CORS 的判定规则**：
 *   1) 按浏览器的方式发预检（OPTIONS + Origin + Access-Control-Request-*）
 *   2) 自己检查响应头是否满足 CORS 规范
 *   3) 再发实际请求，检查响应是否带 ACAO
 * 任何一步不合规就判定「浏览器会拦」，等价于插件里会失败。
 *
 * 同时验证 Bearer 流程：登录拿 token → 用 token 请求受保护接口。
 *
 * 用法：node e2e-direct.cjs
 */
const http = require("http");

const BASE = { host: "172.16.30.128", port: 8089 };
const SERVER_URL = "http://172.16.30.128:8089";
// 思源页面的 origin：桌面端是 http://127.0.0.1:6806
const ORIGIN = "http://127.0.0.1:6806";
const USER = "tao_zhang";
const { PASS } = require("./_secrets.cjs");
const MOUNT = "售前项目";

function call(method, path, { headers = {}, form, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    let payload = null;
    if (form) {
      payload = new URLSearchParams(form).toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
      h["Content-Length"] = Buffer.byteLength(payload);
    } else if (body) {
      payload = JSON.stringify(body);
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(payload);
    }
    const r = http.request(
      { host: BASE.host, port: BASE.port, path, method, headers: h },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* ignore */ }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: data.slice(0, 300) });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 按 CORS 规范判断一个「简单/预检请求」浏览器会不会放行 */
function corsVerdict(res, { preflight = false, wantHeaders = [] } = {}) {
  const acao = res.headers["access-control-allow-origin"];
  const acc = res.headers["access-control-allow-credentials"];
  const problems = [];

  if (!acao) {
    problems.push("缺少 Access-Control-Allow-Origin");
  } else if (acao !== "*" && acao !== ORIGIN) {
    problems.push(`Allow-Origin="${acao}" 既不匹配请求来源也不为 *`);
  } else if (acao === "*" && String(acc) === "true") {
    // 规范禁止：通配来源 + 允许凭据
    problems.push("Allow-Origin=* 与 Allow-Credentials=true 组合被规范禁止");
  }

  if (preflight) {
    const methods = (res.headers["access-control-allow-methods"] || "").toUpperCase();
    if (!methods.includes("GET")) problems.push("预检未允许 GET");
    const allowH = (res.headers["access-control-allow-headers"] || "").toLowerCase();
    for (const w of wantHeaders) {
      if (!allowH.includes(w.toLowerCase())) problems.push(`预检未允许请求头 ${w}`);
    }
  }
  return problems;
}

let fail = 0;
function log(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
}

(async () => {
  console.log(`模拟插件直连通道（浏览器视角）`);
  console.log(`  后端: ${SERVER_URL}`);
  console.log(`  页面来源: ${ORIGIN}\n`);

  // ===== 1. 插件启动时的通道探测 =====
  console.log("--- 1) 通道探测：GET /healthz ---");
  const hz = await call("GET", "/healthz", { headers: { Origin: ORIGIN } });
  const hzProb = corsVerdict(hz);
  log("healthz 可达", hz.status === 200, `status=${hz.status}`);
  log("healthz 可被跨域读取", hzProb.length === 0, hzProb.join("；") || `ACAO=${hz.headers["access-control-allow-origin"]}`);

  // ===== 2. 登录（Form POST，会触发预检，因为 Content-Type 是 urlencoded 属于简单请求……=====
  // fetch 里用 FormData 时 Content-Type 由浏览器生成 multipart，同样是简单请求；
  // 但我们仍发预检，覆盖更严的情况。
  console.log("\n--- 2) 登录预检 + 登录 ---");
  const preLogin = await call("OPTIONS", "/api/login", {
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const pv = corsVerdict(preLogin, { preflight: true, wantHeaders: ["content-type"] });
  log("登录预检通过", pv.length === 0, pv.join("；") || `status=${preLogin.status}`);

  const login = await call("POST", "/api/login", {
    headers: { Origin: ORIGIN },
    form: { username: USER, password: PASS },
  });
  log("登录成功", login.status === 200 && login.json && login.json.ok, `status=${login.status} user=${login.json && login.json.username}`);
  const token = login.json && login.json.token;
  log("拿到 Bearer token", typeof token === "string" && token.split(".").length === 3, `len=${token ? token.length : 0}`);

  // ===== 3. 带预检的受保护请求：Authorization 属于非简单头，必然预检 =====
  console.log("\n--- 3) 受保护接口预检（Authorization 头）---");
  const preMe = await call("OPTIONS", "/api/me", {
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  const pv2 = corsVerdict(preMe, { preflight: true, wantHeaders: ["authorization"] });
  log("me 预检允许 Authorization", pv2.length === 0, pv2.join("；") || `status=${preMe.status}`);

  // ===== 4. Bearer 实际请求 =====
  console.log("\n--- 4) Bearer 取 /api/me ---");
  const me = await call("GET", "/api/me", {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  });
  const meProb = corsVerdict(me);
  const mounts = me.json && me.json.mounts ? me.json.mounts : [];
  log("Bearer 鉴权通过", me.status === 200, `status=${me.status}`);
  log("响应可跨域读取", meProb.length === 0, meProb.join("；") || "ok");
  log("拿到网盘列表", mounts.length > 0, `mounts=[${mounts.map((m) => m.label).join(", ")}]`);

  // ===== 5. 列目录（插件的核心调用）=====
  console.log("\n--- 5) 列目录 GET /api/list（插件侧边栏主路径）---");
  const list = await call("GET", `/api/list?mount=${encodeURIComponent(MOUNT)}&path=/`, {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
  });
  const entries = (list.json && list.json.entries) || [];
  log("列目录成功", list.status === 200 && entries.length >= 0, `entries=${entries.length}`);
  log("列目录响应可跨域读取", corsVerdict(list).length === 0);

  // ===== 6. 预览地址（iframe 要用）=====
  console.log("\n--- 6) 预览地址 /api/preview ---");
  const f = entries.find((e) => !e.isDir);
  if (f) {
    const pvRes = await call("GET", `/api/preview?mount=${encodeURIComponent(MOUNT)}&path=${encodeURIComponent("/" + f.name)}`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` },
    });
    log(
      `预览地址（${f.name}）`,
      pvRes.status === 200 && pvRes.json && pvRes.json.url,
      `url=${((pvRes.json && pvRes.json.url) || "").slice(0, 55)}…`
    );
    // iframe 加载的是这个 url，需要拼上后端基址
    const abs = SERVER_URL + pvRes.json.url;
    console.log(`    → 插件里 iframe src = ${abs.slice(0, 90)}…`);
  } else {
    console.log("（无文件，跳过）");
  }

  // ===== 7. 无 token 必须 401（安全回归）=====
  console.log("\n--- 7) 无 token 应被拒 ---");
  const noTok = await call("GET", "/api/me", { headers: { Origin: ORIGIN } });
  log("无 token → 401", noTok.status === 401, `status=${noTok.status}`);
  log("401 响应也有 CORS 头", !!noTok.headers["access-control-allow-origin"]);

  console.log("");
  console.log(fail ? `❌ ${fail} 项未通过` : "✅ 插件直连通道全链路通过（浏览器视角）");
  process.exit(fail ? 1 : 0);
})();

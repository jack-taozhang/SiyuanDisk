/**
 * 验证 NAS 上 nebula 后端改动的实际效果。
 *
 * 检查项：
 *   1) 登录拿会话
 *   2) /api/list 正常
 *   3) ★ /api/preview 缺参数 → 400 + {"error":"..."}（改动前是 422）★
 *   4) ★ /api/cad/preview 缺参数 → 400 ★
 *   5) ★ /api/oo/config 缺参数 → 400 ★
 *   6) 正常参数的三个接口仍工作（未回归）
 *
 * 用法：node verify-backend.cjs
 */
const http = require("http");

const HOST = "192.168.193.70";
const PORT = 8089;
const USER = "tao_zhang";
const { PASS } = require("./_secrets.cjs");
const MOUNT = "售前项目";

let cookies = [];

function req(method, path, { body, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (cookies.length) h.Cookie = cookies.join("; ");
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
      const setc = res.headers["set-cookie"];
      if (setc) cookies = setc.map((c) => c.split(";")[0]);
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, raw: data.slice(0, 300) });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function line(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  console.log(`目标: http://${HOST}:${PORT}  用户: ${USER}\n`);

  // 1) 登录
  const login = await req("POST", "/api/login", { form: { username: USER, password: PASS } });
  line("登录", login.status === 200 && login.json && login.json.ok, `status=${login.status} user=${login.json && login.json.username}`);

  // 2) 列表
  const list = await req("GET", `/api/list?mount=${encodeURIComponent(MOUNT)}&path=/`);
  const n = list.json && Array.isArray(list.json.entries) ? list.json.entries.length : -1;
  line("列目录", list.status === 200 && n >= 0, `entries=${n}`);

  // 3-5) ★ 缺参数：期望 400 + 统一的 {"error":...}，而不是 422 ★
  console.log("\n--- 缺参数行为（改动重点）---");

  const noMount = await req("GET", "/api/preview");
  const is400 = noMount.status === 400 && !!(noMount.json && (noMount.json.error || noMount.json.detail));
  line(
    "/api/preview 无参数",
    is400,
    `status=${noMount.status} body=${JSON.stringify(noMount.json || noMount.raw)}`
  );

  const onlyMount = await req("GET", `/api/preview?mount=${encodeURIComponent(MOUNT)}`);
  const is400b = onlyMount.status === 400 && !!(onlyMount.json && (onlyMount.json.error || onlyMount.json.detail));
  line(
    "/api/preview 只有 mount",
    is400b,
    `status=${onlyMount.status} body=${JSON.stringify(onlyMount.json || onlyMount.raw)}`
  );

  const cadNo = await req("GET", "/api/cad/preview");
  line(
    "/api/cad/preview 无参数",
    cadNo.status === 400 && !!(cadNo.json && (cadNo.json.error || cadNo.json.detail)),
    `status=${cadNo.status} body=${JSON.stringify(cadNo.json || cadNo.raw)}`
  );

  const ooNo = await req("POST", "/api/oo/config", { form: {} });
  line(
    "/api/oo/config 无参数",
    ooNo.status === 400 && !!(ooNo.json && (ooNo.json.error || ooNo.json.detail)),
    `status=${ooNo.status} body=${JSON.stringify(ooNo.json || ooNo.raw)}`
  );

  // 6) 正常参数不回归
  console.log("\n--- 正常路径（回归检查）---");
  const entries = (list.json && list.json.entries) || [];
  const aFile = entries.find((e) => !e.isDir);
  if (aFile) {
    const pv = await req(
      "GET",
      `/api/preview?mount=${encodeURIComponent(MOUNT)}&path=${encodeURIComponent("/" + aFile.name)}`
    );
    const ok = pv.status === 200 && pv.json && pv.json.ok && pv.json.url;
    line(`/api/preview 正常（${aFile.name}）`, !!ok, `status=${pv.status} url=${(pv.json && pv.json.url || "").slice(0, 60)}…`);
  } else {
    console.log("（该目录下没有文件，跳过预览正常路径检查）");
  }

  const health = await req("GET", "/api/kk/health");
  line("/api/kk/health", health.status === 200, `status=${health.status}`);

  console.log("");
  console.log(process.exitCode ? "❌ 有检查未通过" : "✅ 全部通过");
})();

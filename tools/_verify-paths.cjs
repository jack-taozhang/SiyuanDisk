/*
 * 用真实后端列表数据，验证「父路径 + name」合成规则是否正确。
 * 目标：模拟 expandNode 的两层下钻，确认每个子节点的 path 都是完整的
 *      绝对（相对挂载根）路径，而不是 undefined。
 */
const http = require("http");
const BASE = "http://172.16.30.128:8089";
const MOUNT = process.env.NB_MOUNT || "";

function req(method, path, { token, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    let payload = null;
    const headers = { Accept: "application/json" };
    if (form) {
      payload = new URLSearchParams(form).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(payload);
    } else if (body) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (token) headers["Authorization"] = "Bearer " + token;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let data = null;
          try { data = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, data, raw: buf });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/* ---- 复刻修复后的 expandNode 拼路径规则 ---- */
function synthChildren(data, mountRootPath) {
  const parentFromData = typeof data.path === "string" && data.path ? data.path : null;
  const parentRaw =
    parentFromData !== null
      ? parentFromData
      : typeof mountRootPath === "string"
      ? mountRootPath
      : "";
  const parent =
    parentRaw.replace(/\/+$/, "") === "" || parentRaw === "/"
      ? ""
      : parentRaw.replace(/\/+$/, "");
  return (data.entries || []).map((e) => Object.assign({}, e, { path: parent + "/" + e.name }));
}

(async () => {
  console.log("== 后端:", BASE, "==\n");

  // 1) 登录（后端用的是 FastAPI Form 字段，必须表单编码）
  const login = await req("POST", "/api/login", {
    form: { username: process.env.NB_USER || "tao_zhang", password: process.env.NB_PASS || "" },
  });
  if (login.status !== 200) {
    console.log("登录失败", login.status, login.raw.slice(0, 200));
    process.exit(1);
  }
  const token = login.data && (login.data.token || login.data.access_token);
  console.log("登录 OK  有 token:", !!token);

  // 2) 取挂载点（后端是 /api/me → { mounts:[{label,writable}] }，没有 /api/mounts）
  const me = await req("GET", "/api/me", { token });
  console.log("me 状态:", me.status, " username =", me.data && me.data.username);
  const list = (me.data && me.data.mounts) || [];
  console.log("挂载点:", list.map((m) => m.label).join(", ") || "(空)");
  const mount = MOUNT || (list[0] && (list[0].label || list[0].name)) || "";
  if (!mount) { console.log("没有可用挂载点，退出"); process.exit(1); }
  console.log("使用挂载点:", mount, "\n");

  // 3) 第一层
  const r1 = await req("GET", `/api/list?mount=${encodeURIComponent(mount)}&path=`, { token });
  console.log("-- 第 1 层 --  HTTP", r1.status, " 顶层 path =", JSON.stringify(r1.data.path),
    " entries =", (r1.data.entries || []).length);

  const e0 = (r1.data.entries || [])[0];
  console.log("   原始首条字段:", e0 ? Object.keys(e0).join(",") : "(无)");
  console.log("   原始首条自带 path =", e0 ? JSON.stringify(e0.path) : "(无)");

  const kids1 = synthChildren(r1.data, "");
  const undef1 = kids1.filter((k) => typeof k.path !== "string" || !k.path).length;
  console.log("   合成后: 样例 path =", JSON.stringify(kids1[0] && kids1[0].path));
  console.log("   合成后缺失 path 的条数 =", undef1, undef1 === 0 ? "✔" : "✘");

  // 4) 找一个目录继续下钻
  const dir = kids1.find((k) => k.isDir);
  if (!dir) { console.log("\n根目录下没有子目录，跳过下钻测试"); process.exit(0); }

  const r2 = await req("GET", `/api/list?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(dir.path)}`, { token });
  console.log("\n-- 第 2 层 --  请求 path =", JSON.stringify(dir.path), " HTTP", r2.status);
  if (r2.status !== 200) {
    console.log("   失败:", JSON.stringify(r2.data).slice(0, 300));
    process.exit(1);
  }
  console.log("   顶层 path =", JSON.stringify(r2.data.path), " entries =", (r2.data.entries || []).length);

  const kids2 = synthChildren(r2.data, dir.path);
  const undef2 = kids2.filter((k) => typeof k.path !== "string" || !k.path).length;
  console.log("   合成后: 样例 path =", JSON.stringify(kids2[0] && kids2[0].path));
  console.log("   合成后缺失 path 的条数 =", undef2, undef2 === 0 ? "✔" : "✘");

  // 5) 用最深的一个文件验证 preview 不再报「缺少 path」
  const file = kids2.find((k) => !k.isDir) || kids1.find((k) => !k.isDir);
  if (file) {
    const pv = await req("GET", `/api/preview?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(file.path)}`, { token });
    const d = pv.data && (pv.data.detail || pv.data.error || pv.data.url);
    console.log("\n-- 预览探测 --", JSON.stringify(file.path), "HTTP", pv.status,
      "  detail/url =", JSON.stringify(d).slice(0, 160));
    if (pv.status === 400 && /缺少文件路径参数/.test(JSON.stringify(pv.data))) {
      console.log("   ✘ 仍然报「缺少文件路径参数」——拼路径有问题");
    } else if (pv.status < 400 || pv.status === 404 || pv.status === 403) {
      console.log("   ✔ 未再出现「缺少 path」类报错");
    }
  }

  console.log("\n完成。");
})().catch((e) => { console.error("异常:", e.message); process.exit(1); });

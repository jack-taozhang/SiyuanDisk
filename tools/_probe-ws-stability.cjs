/* 实测：思源 WebSocket 到底稳不稳（区分「真掉线」还是「页面没自愈」）
 *
 * 背景：用户浏览器报「与内核的连接已断开」。
 * 已知：容器 Up、无重启、无 OOM；HTTP 200；未认证的 /ws 升级返回 101。
 *       日志有 `closed an unauthenticated session [192.168.193.90]`。
 *
 * 本脚本做两件事，给出可判定的结论：
 *   A. 未认证握手  —— 不带头，看是否被立刻关闭（预期：升级成功但随即被关）
 *   B. 已认证长连  —— 先登录拿 siyuan cookie，再带 Cookie 连 /ws，保持 40 秒，
 *                     统计收到的消息 / 关闭时间 / 关闭码。
 *      若 40 秒内**一直不断** ⇒ WS 稳定，用户那边的断开是「重启导致的一次性断开，
 *                              页面未自愈」⇒ 刷新页面即可。
 *      若几十秒内反复被关 ⇒ 真故障，需继续查（网络/代理/会话）。
 */
const http = require("http");
const crypto = require("crypto");
// ★ 口令 / 主机 / ws 模块路径全部从 tools/_local.cjs 读 —— 仓库里不存明文口令，
//   也不写机器专属绝对路径（这两条都是本项目踩过并记录在案的坑）。
const LOCAL = require("./_local.cjs");
const WS = LOCAL.WS;

const HOST = LOCAL.HOST || "127.0.0.1";
const PORT = Number(LOCAL.PORT || 6806);
const AUTH = LOCAL.AUTH;
LOCAL.assertReady();

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: HOST, port: PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ status: x.statusCode, headers: x.headers, body: b })); });
    r.on("error", rej); r.write(data); r.end();
  });
}
function get(path, cookie) {
  return new Promise((res, rej) => {
    const r = http.request({ host: HOST, port: PORT, path, method: "GET",
      headers: cookie ? { Cookie: cookie } : {} },
      (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ status: x.statusCode, body: b })); });
    r.on("error", rej); r.end();
  });
}

/* 用 ws 库做一次握手（可带 Cookie），返回一个受控的连接对象 */
function wsProbe(cookie, label, holdMs) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const started = Date.now();
    const ev = { label, opened: false, closed: false, code: null, reason: null, msgs: 0,
                 err: null, firstMsg: null, sinceOpen: null };
    let ws;
    try {
      ws = new WS(`ws://${HOST}:${PORT}/ws`, {
        headers: cookie ? { Cookie: cookie } : {},
        handshakeTimeout: 8000,
        perMessageDeflate: false,
      });
    } catch (e) { ev.err = "ctor: " + e.message; return resolve(ev); }

    const t = setTimeout(() => {
      // 到点仍连着 ⇒ 判定稳定
      ev.stable = ev.opened && !ev.closed;
      try { ws.close(); } catch (e) {}
      resolve(ev);
    }, holdMs);

    ws.on("open", () => { ev.opened = true; ev.sinceOpen = Date.now(); });
    ws.on("message", (d) => { ev.msgs++; if (!ev.firstMsg) ev.firstMsg = String(d).slice(0, 160); });
    ws.on("unexpected-response", (req, res) => {
      ev.err = "unexpected-response HTTP " + res.statusCode; clearTimeout(t);
      res.resume(); resolve(ev);
    });
    ws.on("error", (e) => { ev.err = String(e && e.message); });
    ws.on("close", (code, reason) => {
      ev.closed = true; ev.code = code; ev.reason = String(reason || "").slice(0, 120);
      ev.holdMs = Date.now() - started;
      clearTimeout(t); resolve(ev);
    });
  });
}

(async () => {
  console.log("=".repeat(66));
  console.log("思源 WebSocket 稳定性实测  @ " + HOST + ":" + PORT);
  console.log("=".repeat(66));

  // 登录拿 cookie
  const login = await post("/api/system/loginAuth", { authCode: AUTH });
  const setC = login.headers["set-cookie"] || [];
  const m = setC.map((c) => /^siyuan=([^;]+)/.exec(c)).find(Boolean);
  const cookie = m ? "siyuan=" + m[1] : null;
  console.log("\n登录: HTTP " + login.status + "  cookie=" + (cookie ? "已获取" : "❌ 无"));
  console.log("  Set-Cookie 原文: " + JSON.stringify(setC.map((c) => c.replace(/siyuan=[^;]+/, "siyuan=<...>"))));

  const ver = await get("/api/system/version", cookie);
  console.log("带 cookie 访问 /api/system/version: HTTP " + ver.status + " " + ver.body.slice(0, 80));

  // A. 未认证
  console.log("\n── A. 未认证握手（不带 Cookie）──");
  const a = await wsProbe(null, "no-auth", 12000);
  console.log("   " + JSON.stringify(a));

  // B. 已认证长连
  console.log("\n── B. 已认证长连（带 Cookie，保持 40 秒）──");
  const b = await wsProbe(cookie, "auth", 40000);
  console.log("   " + JSON.stringify(b));

  console.log("\n" + "=".repeat(66));
  console.log("判定");
  console.log("=".repeat(66));
  console.log("  未认证连接: opened=" + a.opened + " closed=" + a.closed +
              " code=" + a.code + " err=" + a.err);
  console.log("  已认证连接: opened=" + b.opened + " closed=" + b.closed +
              " code=" + b.code + " 存活=" + (b.holdMs || 40000) + "ms 收到消息=" + b.msgs);
  if (b.opened && !b.closed) {
    console.log("\n  ✅ 已认证 WS 在 40 秒内**始终稳定** ⇒ 内核侧 WS 没有问题。");
    console.log("     用户那边的「与内核断开」是重启/网络变更导致的**一次性**断开，");
    console.log("     页面应 3 秒自愈；不自愈就是那个标签页已经陈旧 ⇒ 刷新页面即可。");
  } else if (b.opened && b.closed) {
    console.log("\n  ⚠️ 已认证 WS 也被关闭（code=" + b.code + "，" + (b.holdMs) + "ms）⇒ 需继续排查。");
  } else {
    console.log("\n  ❌ 已认证 WS 根本没连上：" + b.err + " ⇒ 需继续排查。");
  }
})().catch((e) => { console.error("异常:", e && e.stack || e); process.exitCode = 2; });

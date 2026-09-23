/* 代理自测：起一个假上游，验证 白名单 / Cookie 保管 / HTML 改写 / 流式回传 */
const http = require("http");
const assert = require("assert");
const { NebulaProxy } = require("../src/proxy.js");

const log = [];

// ---- 假 NebulaDisk ----
const upstream = http.createServer((req, res) => {
  if (req.url === "/api/login") {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["nb_session=fake-token-123; Path=/; HttpOnly; SameSite=lax"],
    });
    return res.end(JSON.stringify({ ok: true, username: "tao_zhang" }));
  }
  if (req.url === "/api/me") {
    // 只有带上 cookie 才返回真实数据，否则 401
    const ck = req.headers.cookie || "";
    if (!ck.includes("nb_session=fake-token-123")) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "未登录" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      username: "tao_zhang",
      mounts: [{ label: "售前项目" }, { label: "研发立项" }],
    }));
  }
  if (req.url.startsWith("/preview/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<html><head>
      <link href="/preview/css/kk.css" rel="stylesheet">
      <script src="http://127.0.0.1:9999/website/libs/o3dv.js"></script>
      <style>body{background:url("/preview/img/bg.png")}</style>
      </head><body><script>
        fetch("/preview/api/x").then(r=>r.json());
        document.write('inner');
        if (window.top !== self) { window.top.location = self.location; }
      </script></body></html>`);
  }
  if (req.url === "/api/raw/secret.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("SECRET");
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ detail: "not found" }));
});

function get(port, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method: opts.method || "GET", headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const proxy = new NebulaProxy({
    target: `http://127.0.0.1:${upPort}`,
    port: 0,               // 让系统分配，避免占用固定端口
    host: "127.0.0.1",
    log: (m) => log.push(m),
  });
  const port = await proxy.start();

  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
  };

  console.log(`\n假上游 :${upPort}   代理 :${port}\n`);

  // 1. 白名单
  console.log("【白名单】");
  const r403 = await get(port, "/etc/passwd");
  check("非白名单路径被拒 403", () => assert.strictEqual(r403.status, 403));

  const rRaw = await get(port, "/api/raw/secret.txt");
  check("/api/raw/ 被明确拒绝 403", () => assert.strictEqual(rRaw.status, 403));
  check("/api/raw/ 未泄露内容", () => assert.ok(!rRaw.body.includes("SECRET")));

  const rCtl = await get(port, "/__ping");
  check("控制接口 /__ping 可达", () => {
    assert.strictEqual(rCtl.status, 200);
    assert.strictEqual(JSON.parse(rCtl.body).ok, true);
  });

  // 2. Cookie 保管（核心）
  console.log("\n【Cookie 保管】");
  const before = await get(port, "/api/me");
  check("未登录时上游返回 401", () => assert.strictEqual(before.status, 401));

  const login = await get(port, "/api/login", { method: "POST" });
  check("登录成功", () => {
    assert.strictEqual(login.status, 200);
    assert.strictEqual(JSON.parse(login.body).ok, true);
  });
  check("Set-Cookie 未被透传给客户端", () =>
    assert.ok(!login.headers["set-cookie"], "不应下发 set-cookie"));

  const after = await get(port, "/api/me");
  check("★ 代理自动补 Cookie，第二次请求 200", () => assert.strictEqual(after.status, 200));
  check("★ 取到网盘数据（盘符齐全）", () => {
    const d = JSON.parse(after.body);
    assert.strictEqual(d.username, "tao_zhang");
    assert.strictEqual(d.mounts.length, 2);
  });

  const sess = await get(port, "/__session");
  check("/__session 报告已登录", () => assert.strictEqual(JSON.parse(sess.body).hasSession, true));

  // 3. 客户端伪造 cookie 不应覆盖 jar
  console.log("\n【Cookie 隔离】");
  const faked = await get(port, "/api/me", { headers: { cookie: "nb_session=evil" } });
  check("★ 浏览器带来的 cookie 被丢弃，仍用 jar 内的", () =>
    assert.strictEqual(faked.status, 200));

  // 4. HTML 改写
  //
  // ★ 断言已按**当前架构**修正（2026-09-22）★
  //
  //   早期这里断言的是 href="/nb/preview/..."，那是「把代理挂在思源 origin
  //   的 /nb 子路径下」这套**已废弃**架构的产物。
  //   架构改成**独立端口代理**（http://127.0.0.1:6810 自己就是一个 origin）后，
  //   _rewriteHtml 的 PREFIX 变成了空串 —— 因为页面里的根路径资源
  //   /js/x.js 直接落到代理根下即可，而代理白名单
  //   （ALLOW_PREFIX：/preview/ /cad/ /website/ /s/ /api/）里**根本没有 /nb/ 前缀**。
  //   若仍按老断言加上 /nb，代理会直接 403，预览页只剩骨架没有样式/脚本。
  //   ⇒ 所以「不带 /nb」才是**正确行为**，断言必须跟着架构走。
  console.log("\n【HTML 改写】");
  const html = await get(port, "/preview/onlinePreview?url=x");
  check("HTML 请求成功", () => assert.strictEqual(html.status, 200));
  check("★ 根路径资源保持 /preview/ 前缀（独立端口代理，不再加 /nb）", () =>
    assert.ok(html.body.includes('href="/preview/css/kk.css"'),
      `实际: ${html.body.match(/href="[^"]*"/)?.[0]}`));
  check("★ 绝对 origin 的资源地址被改写成根路径（同源代理才取得到）", () =>
    assert.ok(html.body.includes('src="/website/libs/o3dv.js"'),
      `实际: ${html.body.match(/src="[^"]*"/)?.[0]}`));
  check("★ 绝对 origin 不再残留（否则浏览器直连上游 9999，跨源失败）", () =>
    assert.ok(!/src="https?:\/\/127\.0\.0\.1:9999\/website\//.test(html.body),
      "仍有绝对 origin 未改写"));
  check("★ CSS 内 url() 已改写", () =>
    assert.ok(html.body.includes('url("/preview/img/bg.png")')));
  check("★ 内联 fetch 路径保留可被代理识别的根路径", () =>
    assert.ok(html.body.includes('fetch("/preview/api/x")')));
  check("★ frame busting 已被中和", () =>
    assert.ok(html.body.includes("if(false)")));
  check("content-type 保留 charset", () =>
    assert.ok(html.headers["content-type"].includes("charset=utf-8")));
  check("x-frame-options 已剥离", () =>
    assert.ok(!html.headers["x-frame-options"]));

  // 5. 退出登录
  console.log("\n【退出登录】");
  await get(port, "/__session", { method: "DELETE" });
  const out = await get(port, "/api/me");
  check("清空会话后恢复 401", () => assert.strictEqual(out.status, 401));

  // 6. 上游不可达的报错可读性
  console.log("\n【错误可读性】");
  const dead = new NebulaProxy({ target: "http://127.0.0.1:1", port: 0, host: "127.0.0.1", log: () => {} });
  const dp = await dead.start();
  const err = await get(dp, "/api/me");
  check("上游不可达返回 502", () => assert.strictEqual(err.status, 502));
  check("★ 错误信息是中文可读提示", () =>
    assert.ok(err.body.includes("无法连接网盘服务"), `实际: ${err.body}`));
  await dead.stop();

  await proxy.stop();
  upstream.close();

  console.log(`\n${"=".repeat(46)}`);
  console.log(`  通过 ${pass}   失败 ${fail}`);
  console.log("=".repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("自测崩溃:", e); process.exit(1); });

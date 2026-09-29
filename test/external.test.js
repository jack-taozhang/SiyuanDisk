/* ==========================================================================
 * 对外契约 external.js 的测试
 * --------------------------------------------------------------------------
 * ★ 为什么用 vm 而不是直接 import ★
 *   package.json 是 `"type": "commonjs"`，而 src/external.js 是 ESM
 *   （用了 import/export）。直接 `await import(...)` 会被 Node 当成 CJS 解析
 *   并抛 `SyntaxError: Unexpected token 'export'`。
 *
 *   本仓库既有测试（test/embed.test.js）的做法就是：把源文件读进来，
 *   在一个干净的 vm 上下文里求值，再把需要的符号取出来。
 *   external.js 没有任何外部依赖（不 import "siyuan"、不 import api.js），
 *   所以 vm 求值非常干净 —— 这也是它被单独拆成模块的好处之一。
 *
 * 覆盖重点：
 *   1. 契约形状（方法齐全、冻结、版本号）
 *   2. ★ 不抛异常 ★ —— 所有失败都收敛成 {ok:false, reason}
 *   3. ★ reason 严格区分 missing / denied / unreachable ★
 *      （这是最关键的语义：网盘连不上 ≠ 文件被删了）
 *   4. ★ 契约里不出现任何消费方词汇 ★（C-5：网盘不认识画布）
 *   5. C-4：URL 一律由本侧构造，不把拼接能力漏出去
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

let pass = 0;
let fail = 0;

/**
 * vm 上下文里的数组/对象有**自己的 realm**（不同的 Array/Object 原型），
 * 直接 deepStrictEqual 会因为原型不同而失败。
 * 统一用 JSON 往返把跨 realm 的值拉回本 realm 再比较。
 */
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n      ${e && e.message}`); });
}

/** 造一个可控的 API 桩 */
function makeApi(overrides = {}) {
  return Object.assign({
    me: async () => ({ mounts: [{ label: "研发立项", writable: true }, { label: "只读盘", writable: false }] }),
    list: async () => [{ name: "a.pdf", is_dir: false }],
    stat: async () => ({ name: "a.pdf", size: 123, mtime: 1, isDir: false, ext: "pdf", route: "kk", mime: "application/pdf" }),
    search: async () => ({ ok: true, total: 1, hits: [] }),
    previewUrl: async () => "http://192.168.193.70:8089/lite?kind=kk&target=x",
    cadUrl: async () => "http://192.168.193.70:8089/cad/?target=x",
    /**
     * ★ 必须是 async —— 与真实实现一致（src/api.js 的 browserViewUrl 是 async）★
     *
     * 原来写成同步函数，于是「external.js 漏了 await」在测试里**完全看不出来**：
     * 同步桩下 `String(API.browserViewUrl(...))` 与 `String(await …)` 结果相同。
     * 桩的形态必须跟真实现同构，否则测的是桩、不是代码。
     */
    browserViewUrl: async () => "http://192.168.193.70:8089/view?x",
    signedRawUrl: async () => "http://192.168.193.70:8089/api/raw?t=x",
    downloadUrl: () => "http://192.168.193.70:8089/api/download?x",
    mkdir: async () => ({ ok: true }),
    rename: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    move: async () => ({ ok: true }),
    ooHealth: async () => ({ ok: true }),
    kkHealth: async () => ({ ok: true }),
    cadHealth: async () => ({ ok: true }),
  }, overrides);
}

/** 造一个带 status 的错误（模拟 api.js 的 ApiError） */
function apiError(status, message = "err") {
  const e = new Error(message);
  e.status = status;
  return e;
}

function stubPickViewer(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["pdf"].includes(ext)) return "pdf";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "office";
  if (["dwg", "dxf"].includes(ext)) return "cad";
  if (["txt", "md", "json"].includes(ext)) return "text";
  if (["zip", "tar", "gz"].includes(ext)) return "archive";
  return "download";
}

/**
 * 在 vm 上下文里求值 src/external.js，取出 createExternalContract。
 *
 * external.js 是纯 ESM、零依赖，所以这一步不需要任何桩模块。
 */
function loadExternalModule() {
  const file = path.resolve(__dirname, "../src/external.js");
  const src = fs.readFileSync(file, "utf8");
  // ESM 的 `export function` / `export const` 在 vm 里没有意义，
  // 统一改写为挂到 sandbox 上的赋值语句。
  const transformed = src
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "const ")
    + "\n;__exports.createExternalContract = createExternalContract;\n";
  const sandbox = { __exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(transformed, sandbox, { filename: file });
  return sandbox.__exports;
}

async function main() {
  const mod = loadExternalModule();
  const { createExternalContract } = mod;

  console.log("\n[external] 契约形状");

  await test("构造需要 API 与 pickViewer 依赖", async () => {
    assert.throws(() => createExternalContract({}), /API/);
    assert.throws(() => createExternalContract({ API: {} }), /pickViewer/);
  });

  const contract = createExternalContract({ API: makeApi(), pickViewer: stubPickViewer, diag: () => {} });

  await test("带版本号与标识", async () => {
    assert.strictEqual(contract.version, 1);
    assert.strictEqual(contract.id, "nebuladisk.external");
  });

  await test("对象被冻结（契约是公开接口，禁止运行时改写）", async () => {
    assert.ok(Object.isFrozen(contract));
    assert.throws(() => { "use strict"; contract.version = 99; }, TypeError);
  });

  await test("承诺的方法全部存在", async () => {
    for (const m of [
      "listMounts", "list", "stat", "search", "viewerKind",
      "previewUrl", "cadUrl", "webUrl", "signedRawUrl", "downloadUrl", "health",
      // F-300 新增写操作（让消费方能新建/改名/删除/移动）
      "mkdir", "rename", "remove", "move",
    ]) {
      assert.strictEqual(typeof contract[m], "function", `缺少方法 ${m}`);
    }
  });

  console.log("\n[external] 成功路径");

  await test("listMounts 从 /api/me 取挂载点（后端无 /api/mounts）", async () => {
    const r = await contract.listMounts();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(r.data), [
      { label: "研发立项", writable: true },
      { label: "只读盘", writable: false },
    ]);
  });

  await test("list 统一成数组（兼容裸数组 / entries / items）", async () => {
    assert.strictEqual((await contract.list("m", "/")).data.length, 1);
    const c2 = createExternalContract({
      API: makeApi({ list: async () => ({ entries: [{ name: "x" }, { name: "y" }] }) }),
      pickViewer: stubPickViewer,
    });
    assert.strictEqual((await c2.list("m", "/")).data.length, 2);
    const c3 = createExternalContract({
      API: makeApi({ list: async () => ({ items: [{ name: "z" }] }) }),
      pickViewer: stubPickViewer,
    });
    assert.strictEqual((await c3.list("m", "/")).data.length, 1);
  });

  await test("list 遇到无法识别的形状返回空数组而不是崩溃", async () => {
    const c = createExternalContract({
      API: makeApi({ list: async () => null }),
      pickViewer: stubPickViewer,
    });
    const r = await c.list("m", "/");
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(r.data), []);
  });

  await test("stat 返回元数据，且**不含稳定 ID**（D-1b 已拍板不做身份表）", async () => {
    const r = await contract.stat("m", "/a.pdf");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.name, "a.pdf");
    for (const idField of ["id", "uuid", "inode", "hash"]) {
      assert.ok(!(idField in r.data), `不该有 ${idField} 字段`);
    }
  });

  await test("viewerKind 按名字分流", async () => {
    assert.strictEqual(contract.viewerKind("a.png"), "image");
    assert.strictEqual(contract.viewerKind("a.docx"), "office");
    assert.strictEqual(contract.viewerKind("a.dwg"), "cad");
    assert.strictEqual(contract.viewerKind("a.unknown"), "download");
    assert.strictEqual(contract.viewerKind(""), "download");
  });

  await test("viewerKind 遇到抛错的 pickViewer 也返回 download（不抛出去）", async () => {
    const c = createExternalContract({
      API: makeApi(),
      pickViewer: () => { throw new Error("boom"); },
    });
    assert.strictEqual(c.viewerKind("a.png"), "download");
  });

  /**
   * ★★★ 断言「内容」而不只是「类型」（2026-09-29 修）★★★
   *
   * 原来的写法是 `assert.strictEqual(typeof r.data, "string")`。
   * 而 `webUrl` 当时漏了 `await`，`String(promise)` 得到的是字符串
   * `"[object Promise]"` —— **它也是字符串**，所以这条断言一路绿灯，
   * 直到画布独立页双击网盘卡片才暴露（浏览器去开一个叫 [object Promise] 的地址）。
   *
   * ⇒ 现在逐项断言**返回的就是桩里给的那个 URL**。
   *   "类型对"与"值对"是两件事，凡是"形状相同但内容可能错"的地方都要断言内容。
   */
  await test("URL 方法返回**桩里给的那个地址**（由网盘侧构造，C-4）", async () => {
    const cases = [
      ["previewUrl", () => contract.previewUrl("m", "/a.pdf"), "http://192.168.193.70:8089/lite?kind=kk&target=x"],
      ["cadUrl", () => contract.cadUrl("m", "/a.dwg"), "http://192.168.193.70:8089/cad/?target=x"],
      ["webUrl", () => contract.webUrl("m", "/a.pdf", "a.pdf"), "http://192.168.193.70:8089/view?x"],
      ["signedRawUrl", () => contract.signedRawUrl("m", "/a.pdf"), "http://192.168.193.70:8089/api/raw?t=x"],
      ["downloadUrl", () => contract.downloadUrl("m", "/a.pdf"), "http://192.168.193.70:8089/api/download?x"],
    ];
    for (const [label, run, expected] of cases) {
      const r = await run();
      assert.strictEqual(r.ok, true, `${label} 应 ok`);
      assert.strictEqual(typeof r.data, "string", `${label} 应返回字符串`);
      assert.strictEqual(r.data, expected, `${label} 应返回真实地址（不是 [object Promise] 之类的占位）`);
    }
  });

  /**
   * ★ 专项回归：漏 await 时 `String(promise)` 会静默变成 "[object Promise]" ★
   *
   * 与上一条的区别：这里把 `API.browserViewUrl` 换成一个**真 async** 的桩
   * （上面 makeApi 里的同名字段曾是同步函数，所以漏 await 也测不出来）。
   * 两条一起构成"防漏 await"的护栏：值断言 + async 桩。
   */
  await test("webUrl 对 async 的 browserViewUrl 不会退化成 [object Promise]", async () => {
    const c = createExternalContract({
      API: makeApi({ browserViewUrl: async () => "http://192.168.193.70:8089/view?async=1" }),
      pickViewer: stubPickViewer,
    });
    const r = await c.webUrl("m", "/a.pdf", "a.pdf");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data, "http://192.168.193.70:8089/view?async=1");
    assert.ok(!String(r.data).includes("object Promise"), "不得返回 [object Promise]");
  });

  await test("health 聚合三个子服务，单个失败不拖垮整体", async () => {
    const c = createExternalContract({
      API: makeApi({ cadHealth: async () => { throw new Error("cad down"); } }),
      pickViewer: stubPickViewer,
    });
    const r = await c.health();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.onlyoffice.ok, true);
    assert.strictEqual(r.data.cad.ok, false);
  });

  console.log("\n[external] ★ 失败语义（最关键）★");

  await test("404 → reason=missing（文件真的不在了）", async () => {
    const c = createExternalContract({
      API: makeApi({ stat: async () => { throw apiError(404, "not found"); } }),
      pickViewer: stubPickViewer,
    });
    const r = await c.stat("m", "/gone.pdf");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "missing");
    assert.strictEqual(r.status, 404);
  });

  await test("403 → reason=denied（没权限，不是不存在）", async () => {
    const c = createExternalContract({
      API: makeApi({ stat: async () => { throw apiError(403, "forbidden"); } }),
      pickViewer: stubPickViewer,
    });
    assert.strictEqual((await c.stat("m", "/x")).reason, "denied");
  });

  await test("★ 网络错误 → reason=unreachable，绝不能是 missing ★", async () => {
    const c = createExternalContract({
      API: makeApi({ stat: async () => { throw new Error("Failed to fetch"); } }),
      pickViewer: stubPickViewer,
    });
    const r = await c.stat("m", "/x");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "unreachable");
    // 这条断言是契约的核心价值：消费方据此才能不误报「文件已删除」
    assert.notStrictEqual(r.reason, "missing");
  });

  await test("★ 500 也算 unreachable，不算 missing ★", async () => {
    const c = createExternalContract({
      API: makeApi({ list: async () => { throw apiError(500, "server error"); } }),
      pickViewer: stubPickViewer,
    });
    assert.strictEqual((await c.list("m", "/")).reason, "unreachable");
  });

  await test("任何方法的异常都不会穿透边界（逐个方法验证）", async () => {
    const boom = async () => { throw apiError(500, "boom"); };
    const c = createExternalContract({
      API: makeApi({
        me: boom, list: boom, stat: boom, search: boom,
        previewUrl: boom, cadUrl: boom, signedRawUrl: boom,
        mkdir: boom, rename: boom, remove: boom, move: boom,
      }),
      pickViewer: stubPickViewer,
    });
    const calls = [
      () => c.listMounts(), () => c.list("m", "/"), () => c.stat("m", "/x"),
      () => c.search("m", "q"), () => c.previewUrl("m", "/x"),
      () => c.cadUrl("m", "/x"), () => c.signedRawUrl("m", "/x"),
      () => c.mkdir("m", "/d", "n"), () => c.rename("m", "/x", "y"),
      () => c.remove("m", "/x"), () => c.move("m", "/x", "/d"),
    ];
    for (const run of calls) {
      const r = await run();
      assert.strictEqual(r.ok, false, "应返回 ok:false 而不是抛异常");
      assert.ok(typeof r.error === "string");
    }
  });

  console.log("\n[external] 写操作（F-300）");

  await test("mkdir 把 name 与父目录原样透传给 API", async () => {
    const seen = {};
    const c = createExternalContract({
      API: makeApi({ mkdir: async (mount, path, name) => { Object.assign(seen, { mount, path, name }); return { ok: true }; } }),
      pickViewer: stubPickViewer,
    });
    const r = await c.mkdir("研发立项", "/合同", "2026");
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(plain(seen), { mount: "研发立项", path: "/合同", name: "2026" });
  });

  await test("rename 把「完整路径 + 新名」透传（name 是单段，不是路径）", async () => {
    const seen = {};
    const c = createExternalContract({
      API: makeApi({ rename: async (mount, path, name) => { Object.assign(seen, { mount, path, name }); return { ok: true }; } }),
      pickViewer: stubPickViewer,
    });
    await c.rename("研发立项", "/合同/a.pdf", "b.pdf");
    assert.deepStrictEqual(plain(seen), { mount: "研发立项", path: "/合同/a.pdf", name: "b.pdf" });
  });

  await test("remove 只传 mount + path", async () => {
    const seen = {};
    const c = createExternalContract({
      API: makeApi({ remove: async (mount, path) => { Object.assign(seen, { mount, path }); return { ok: true }; } }),
      pickViewer: stubPickViewer,
    });
    await c.remove("研发立项", "/合同/a.pdf");
    assert.deepStrictEqual(plain(seen), { mount: "研发立项", path: "/合同/a.pdf" });
  });

  await test("move 默认 isMove=true，显式 false 时透传为复制", async () => {
    const seen = [];
    const c = createExternalContract({
      API: makeApi({ move: async (mount, path, target, isMove) => { seen.push(isMove); return { ok: true }; } }),
      pickViewer: stubPickViewer,
    });
    await c.move("m", "/x", "/d");
    await c.move("m", "/x", "/d", false);
    assert.deepStrictEqual(seen, [true, false]);
  });

  await test("契约层不做名称校验（校验是消费方的责任，契约只透传）", async () => {
    // ★ 设计说明：契约是「通用资料层」，不该替消费方决定什么名字合法；
    //   但**消费方必须校验**（见画布侧 nebula-write.ts 的 sanitizeNebulaName）。
    //   这里断言「透传」这一契约行为，防止未来有人把业务规则塞进契约。
    const seen = {};
    const c = createExternalContract({
      API: makeApi({ rename: async (mount, path, name) => { Object.assign(seen, { name }); return { ok: true }; } }),
      pickViewer: stubPickViewer,
    });
    await c.rename("m", "/x", "任意 名字.pdf");
    assert.strictEqual(seen.name, "任意 名字.pdf");
  });

  await test("写操作失败同样收敛成 {ok:false, reason}（不抛异常）", async () => {
    const c = createExternalContract({
      API: makeApi({ remove: async () => { throw apiError(403, "denied"); } }),
      pickViewer: stubPickViewer,
    });
    const r = await c.remove("m", "/x");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "denied");
    assert.strictEqual(r.status, 403);
  });

  console.log("\n[external] ★ 通用性（C-5：网盘不认识画布）★");

  await test("契约源码里不出现任何消费方词汇", async () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/external.js"), "utf8");
    // 去掉注释再检查——注释里可以（也应该）解释设计意图
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const word of ["canvas", "Canvas", "画布", "diskcanvas", "obsidian", "Obsidian"]) {
      assert.ok(!codeOnly.includes(word), `代码里不该出现消费方词汇：${word}`);
    }
  });

  await test("契约导出的方法名都是通用资料层语义", async () => {
    const names = Object.keys(contract).filter((k) => typeof contract[k] === "function");
    for (const n of names) {
      for (const word of ["canvas", "node", "edge", "group"]) {
        assert.ok(!n.toLowerCase().includes(word), `方法名 ${n} 含消费方语义 ${word}`);
      }
    }
  });

  await test("契约不暴露后端地址/通道等内部细节（C-4）", async () => {
    const keys = Object.keys(contract);
    for (const leak of ["baseUrl", "serverUrl", "proxyBase", "token", "rawUrl"]) {
      assert.ok(!keys.includes(leak), `不该暴露内部字段 ${leak}`);
    }
  });

  console.log(`\n[external] 结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

/* reverse-task31.cjs — REVERSE TEST for the task-31 assertions.
 *
 * An assertion that can never fail is worthless. Here we INJECT two independent
 * faults and confirm the e2e suite goes RED:
 *
 *   INJ-1: make liteUrl() return a direct link instead of /lite  (kills "必须套 /lite")
 *   INJ-2: make liteUrl() accept "//" open redirects            (kills "必须拒绝")
 *
 * We do NOT modify the real source: we copy src/api.js to a temp file, mutate the
 * copy, run the same loader against it, and assert the relevant contract fails.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const API = path.resolve(__dirname, "../src/api.js");
const orig = fs.readFileSync(API, "utf8");

/**
 * 把 src/ 下的 ESM 依赖也按同一套轻量转译跑起来。
 *
 * ★ 为什么需要（2026-09-30）★
 *   api.js 以前只 import ./proxy.js（CommonJS，Node require 能直接加载）。
 *   内置代理删除后改为 import ./diag.js（ESM）⇒ Node require 直接抛
 *   `SyntaxError: Unexpected token 'export'`。相对依赖必须一起转译。
 */
const srcCache = new Map();
function loadSrcFile(abs) {
  if (srcCache.has(abs)) return srcCache.get(abs);
  let code = fs.readFileSync(abs, "utf8");
  code = code.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
    (_f, ns, mod) => ns.split(",").map((x) => x.trim()).filter(Boolean)
      .map((one) => { const [imp, local] = one.split(/\s+as\s+/);
        return `const ${(local || imp).trim()} = require(${JSON.stringify(mod)}).${imp.trim()};`; }).join("\n"),
  );
  const exported = [];
  const re2 = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let mm; while ((mm = re2.exec(code))) exported.push(mm[1]);
  code = code.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  code += `\nmodule.exports = { ${exported.join(", ")} };`;

  const m2 = { exports: {} };
  const c2 = vm.createContext({ module: m2, exports: m2.exports, require: srcRequire, console });
  vm.runInContext(code, c2, { filename: abs });
  srcCache.set(abs, m2.exports);
  return m2.exports;
}

const srcRequire = (id) =>
  /^\.\.?\//.test(id)
    ? loadSrcFile(path.resolve(__dirname, "../src", id))
    : require(id);

function loadWith(src) {
  let s = src;
  s = s.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
    (_f, names, mod) => names.split(",").map((x) => x.trim()).filter(Boolean)
      .map((one) => { const [imp, local] = one.split(/\s+as\s+/);
        return `const ${(local || imp).trim()} = require(${JSON.stringify(mod)}).${imp.trim()};`; }).join("\n"),
  );
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m; while ((m = re.exec(s))) names.push(m[1]);
  s = s.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  s += `\nmodule.exports = { ${names.join(", ")} };`;

  const mod = { exports: {} };
  const store = new Map();
  const ctx = vm.createContext({
    module: mod, exports: mod.exports, require: srcRequire, console,
    window: { __nebuladiskPlugin: { settings: { serverUrl: "http://127.0.0.1:9" } } },
    sessionStorage: { getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
                      setItem: (k, v) => store.set(String(k), String(v)),
                      removeItem: (k) => store.delete(String(k)), clear: () => store.clear() },
    fetch: globalThis.fetch, FormData: globalThis.FormData, location: { origin: "http://127.0.0.1:6806" },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    XMLHttpRequest: function () { throw new Error("no xhr"); }, navigator: { clipboard: null },
  });
  vm.runInContext(s, ctx, { filename: "src/api.js" });
  return mod.exports;
}

const SERVER = "http://127.0.0.1:9999";
const DEEP = "/cad/?open=http%3A%2F%2Fx%2Fapi%2Fraw%2Fa.dwg&name=A-01.dwg";

function assertSuite(name, api) {
  const results = [];
  const t = (label, fn) => { try { fn(api); results.push([true, label]); } catch (e) { results.push([false, label, e.message]); } };

  // the two task-31 contract assertions
  t("T31-A liteUrl 必须套 /lite", (A) => {
    const u = A.API.liteUrl(SERVER, DEEP, "cad");
    assert.ok(u && u.startsWith(SERVER + "/lite?"), `实际: ${u}`);
  });
  t("T31-B liteUrl 必须拒绝 //", (A) => {
    assert.strictEqual(A.API.liteUrl(SERVER, "//evil.com/x", "cad"), "");
  });
  return results;
}

let pass = 0, fail = 0;
console.log("=== 基线（原始源码，两条断言应全绿）===");
for (const [ok, label, msg] of assertSuite("base", loadWith(orig))) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${msg ? "  -> " + msg : ""}`); ok ? pass++ : fail++;
}

console.log("\n=== 注入1：把 /lite 换成直连（断言 T31-A 必须变红）===");
const inj1 = orig.replace(
  /return root \+ "\/lite\?kind=" \+ k \+ "&target=" \+ encodeURIComponent\(rel\);/,
  'return t; // INJECTED: direct link, no /lite',
);
if (inj1 === orig) { console.log("  (注入失败：没找到目标行)"); process.exit(2); }
let inj1Red = 0;
for (const [ok, label, msg] of assertSuite("inj1", loadWith(inj1))) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${msg ? "  -> " + msg : ""}`); if (!ok) inj1Red++;
}

console.log("\n=== 注入2：放行 // 开放重定向（断言 T31-B 必须变红）===");
const inj2 = orig.replace(
  /if \(!rel\.startsWith\("\/"\) \|\| rel\.indexOf\("\/\/"\) === 0 \|\| rel\.indexOf\(":"\) >= 0\) return "";/,
  'if (false) return ""; // INJECTED: accept everything',
);
if (inj2 === orig) { console.log("  (注入失败：没找到目标行)"); process.exit(2); }
let inj2Red = 0;
for (const [ok, label, msg] of assertSuite("inj2", loadWith(inj2))) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${msg ? "  -> " + msg : ""}`); if (!ok) inj2Red++;
}

console.log("\n=== 结论 ===");
console.log("基线通过:", pass, " 失败:", fail);
console.log("注入1 变红条数:", inj1Red, inj1Red >= 1 ? "✅ 断言有效" : "❌ 断言是死的");
console.log("注入2 变红条数:", inj2Red, inj2Red >= 1 ? "✅ 断言有效" : "❌ 断言是死的");
process.exit((fail === 0 && inj1Red >= 1 && inj2Red >= 1) ? 0 : 1);

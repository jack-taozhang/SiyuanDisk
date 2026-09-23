/* ==========================================================================
 * 静态自检
 * --------------------------------------------------------------------------
 * 目的：在没有思源运行环境的情况下，尽可能早地发现错误。
 *
 * 检查项：
 *   ① 每个 .js 文件语法可解析（node --check 等价）
 *   ② ESM 的 import 目标文件真实存在（拼错路径是高频错误）
 *   ③ 导出的符号在目标文件里确实导出过（"用了但没导出" 这类错误）
 *   ④ import 了但没用到的符号（噪音清理）
 *   ⑤ plugin.json 清单字段完整、被 index.js 引用的资源文件存在
 *
 * 这套检查是有意模仿 nebula/tools/check_undefined.py 的思路：
 *   「只在调用路径上炸」的错误靠运行是抓不到的，必须静态解析。
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const problems = [];

function ok(name) { console.log(`  ✅ ${name}`); pass++; }
function bad(name, detail) { console.log(`  ❌ ${name}\n       ${detail}`); fail++; problems.push(`${name}: ${detail}`); }

/** 收集仓库里的所有 js（排除构建/调试工具与已安装产物） */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    /*
     * tools/ 下是「构建与排查脚本」，不是插件产物：
     *   · build.js 负责打包
     *   · sim-load.js / sim-loader.js 是 Node 一次性脚本，
     *     里面会用到顶层 return（在 CommonJS 脚本里合法，
     *     但用 ESM 语法校验时会报 "Illegal return statement"）
     * 它们不参与思源加载，纳入语法检查只会产生假阳性。
     */
    if (e.name === "tools") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/** 从源码里抽出 export 的名字（同时支持 ESM 与 CommonJS） */
function exportsOf(src) {
  const names = new Set();
  const re1 = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re1.exec(src))) names.add(m[1]);
  // export { a, b as c }
  // ★ 用 [\s\S]*? 而不是 [^}]* ★
  //   [^}] 匹配任意非 `}` 字符，**换行也算**，于是当花括号本身跨行、或
  //   中间夹着注释时，正则会一路向后吞到「下一个 }」(往往是几百行外的另一个
  //   元素的结尾)，把夹在中间的注释文字当成导出名。
  //   实测：viewer.js 的 `import { ..., decodeSmart, } from "./api.js"` 花括号内
  //   有一段说明性块注释，被吞进来后：
  //     ① 报「未导出: /** ★ 2026-09-23：decodeSmart …」这种幽灵符号；
  //     ② 该字符串又被拿去 new RegExp → SyntaxError: Nothing to repeat
  //        （检查脚本整个崩溃，而不是报告失败）。
  //   [\s\S]*? 是**惰性**的，且能匹配换行，遇到第一个 `}` 就停 —— 正确。
  const re2 = /export\s*\{([\s\S]*?)\}/g;
  while ((m = re2.exec(src))) {
    // 同上：先把注释剥掉再切分，避免注释里的逗号/括号污染导出名
    const body2 = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const part of body2.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export default
  if (/export\s+default\s/.test(src)) names.add("default");

  /*
   * ★ CommonJS 形式（src/proxy.js 就是这种）
   *   module.exports = { A, B }        → 导出 A、B
   *   module.exports.X = X             → 导出 X
   *   module.exports = X               → 导出 default
   * 不识别的话会报「用了但没导出」的假阳性。
   */
  const cjsObj = src.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (cjsObj) {
    for (const part of cjsObj[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const kv = t.split(":");
      names.add((kv.length > 1 ? kv[0] : kv[0]).trim());
    }
  }
  const re3 = /module\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = re3.exec(src))) names.add(m[1]);
  if (/module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;/.test(src)) names.add("default");

  return names;
}

/** 抽出 import 语句 */
function importsOf(src) {
  const out = [];
  /*
   * ★★ 先剥注释，再解析 import ★★（2026-09-23 修）
   *
   * 这是个**根本性**的正确性问题，不是格式洁癖：
   *   import 正则用 `^\s*import\s+` 锚定行首。而注释里**完全可能**在行首写出
   *   import 示例 ——本项目的 viewer.js 就写了这么一行，用来解释循环导入：
   *
   *       *   `import { insertEmbedIntoDoc } from "./embed.js"`，会形成循环导入。
   *
   *   这一行会被当成**真实**的 import 匹配到，于是：
   *     ① 它切出的 spec 是 "./embed.js"，把上一段真正属于 "./api.js" 的
   *        多行 import 的花括号内容一起吞掉 → 报「从 embed.js 导入 API/…」
   *        这种指错文件的假错；
   *     ② 注释正文混进符号名列表 → 拿去 new RegExp 直接抛
   *        SyntaxError: Invalid regular expression: /\b/**…/: Nothing to repeat，
   *        检查脚本**整个崩掉**（不是报失败），后续所有检查都不跑了。
   *
   *   注释永远不该影响语法解析，所以在入口处剥离。
   *   注意 stripComments 只删块注释与整行 `//` 注释，不会碰到字符串里的 import。
   */
  const clean = stripComments(src);

  // ★ 必须支持多行 import：
  //    import {
  //      a, b,
  //    } from "./x.js";
  //   用 [\s\S]*? 跨行匹配，并用 ^\s*import 锚定行首，避免误匹配注释里的词。
  const re = /^\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  let m;
  while ((m = re.exec(clean))) {
    const clause = m[1].trim();
    const spec = m[2];
    if (clause.startsWith("{")) {
      // 去掉结尾的悬挂逗号（`a, b,\n}` 切成 ["a","b",""] 会多一个空名）
      const names = clause.replace(/[{}]/g, "").replace(/^\s*,|,\s*$/g, "").split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      out.push({ spec, names, kind: "named" });
    } else if (clause.startsWith("*")) {
      out.push({ spec, names: [], kind: "star", alias: clause.replace(/^\*\s*as\s*/, "").trim() });
    } else {
      out.push({ spec, names: [clause.split(",")[0].trim()], kind: "default" });
    }
  }
  return out;
}

/**
 * 从源码里剥掉「注释 + import 语句」，只留可执行主体。
 * 不做剥离的话，文件头注释里出现的符号名会被误判为「已使用」。
 */
/**
 * 只剥离注释（块注释 + 整行行注释），保留其余代码。
 *
 * 为什么在「找导出」之前必须剥注释：
 *   像 `// export const NAME / export function NAME` 这样的**说明性注释**，
 *   会被 exportsOf 的正则当成真实导出，于是报出一个名叫 NAME 的幽灵死代码。
 *   （本文件就曾经被自己的注释坑过一次。）
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(src) {
  return stripComments(src)
    // 多行 import
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?/gm, "");
}

console.log("\n【① 语法】");
const files = walk(ROOT).filter((f) => !f.includes("node_modules"));
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, "utf8");
  // ESM 文件不能直接用 vm.Script 编译（import 是保留字），
  // 因此把它转成可解析的脚本形式做语法检查：
  //   import ... from "x"  →  const ... = 0
  const stripped = src
    .replace(/^\s*import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "const __d = ")
    .replace(/^\s*export\s+/gm, "");
  try {
    new vm.Script(stripped, { filename: f });
    ok(rel);
  } catch (e) {
    bad(rel, e.message);
  }
}

console.log("\n【② import 目标存在 & ③ 导出符号匹配】");
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, "utf8");
  const imps = importsOf(src);

  for (const imp of imps) {
    // 只检查相对路径（"siyuan" 是宿主提供的，跳过）
    if (!imp.spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(f), imp.spec);
    if (!fs.existsSync(target)) {
      bad(`${rel} → ${imp.spec}`, "目标文件不存在");
      continue;
    }
    const tsrc = fs.readFileSync(target, "utf8");
    // 同样先剥注释，避免注释里的示例写法被当成真实导出
    const avail = exportsOf(stripComments(tsrc));
    const missing = imp.names.filter((n) => !avail.has(n));
    if (missing.length) {
      bad(`${rel} → ${imp.spec}`, `未导出: ${missing.join(", ")}（该文件导出: ${[...avail].join(", ") || "无"}）`);
    } else {
      ok(`${rel} → ${imp.spec} (${imp.names.join(", ") || "*"})`);
    }
  }
}

console.log("\n【④ 未使用的 import】");
let unusedCount = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const src = fs.readFileSync(f, "utf8");
  const body = bodyOf(src);
  for (const imp of importsOf(src)) {
    for (const n of imp.names) {
      if (!n || n === "default") continue;
      const re = new RegExp(`\\b${n.replace(/[$]/g, "\\$&")}\\b`, "g");
      const count = (body.match(re) || []).length;
      if (count === 0) {
        bad(`${rel}`, `导入了 ${n} 但从未使用`);
        unusedCount++;
      }
    }
  }
}
if (unusedCount === 0) ok("没有未使用的 import");

console.log("\n【④b 无人引用的导出（死代码）】");
// 判定「死」的条件：该导出名在**全项目任何地方**都不再出现（除它自己的定义处）。
//   · 被别的文件 import  → 活的
//   · 只在自己文件内部使用 → 活的（内部助手，导出只是为了就近组织代码）
//   · 只出现在测试里      → 活的（测试也是消费者）
// 这样才不至于把 apiGet / fixUrl 这类内部助手误报成死代码。
//
// ★ 只扫描「会随插件一起发布」的源码（index.js + src/*），不算 tools/ 与 test/ ★
//   理由：tools/ 是构建脚本、test/ 是测试，它们都不是插件运行时会加载的代码，
//   没有导出是正常的。把它们纳进来只会产生假阳性。
//   （曾经因为 tools/build.js 注释里写了 "export const NAME" 这种**示例文本**，
//     被 exportsOf 的正则当成真实导出，报出一个名叫 NAME 的幽灵死代码。）
const SHIPPED = (rel) =>
  rel === "index.js" || rel.replace(/\\/g, "/").startsWith("src/");

let deadCount = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (!SHIPPED(rel)) continue;
  if (rel === "index.js") continue;   // 入口，导出供宿主使用
  if (rel === "src\\proxy.js" || rel === "src/proxy.js") continue; // CommonJS，单独处理

  const src = fs.readFileSync(f, "utf8");
  // ★ 必须先剔注释再找导出 ★
  //   注释里写 "export const NAME" 之类的说明文字会被正则误当成真实导出。
  const avails = exportsOf(stripComments(src));
  if (!avails.size) continue;

  for (const n of avails) {
    if (n === "default") continue;
    const nameRe = new RegExp(`\\b${n.replace(/[$]/g, "\\$&")}\\b`, "g");
    let occurrences = 0;
    for (const g of files) {
      const text = g === f ? bodyOf(fs.readFileSync(g, "utf8")) : fs.readFileSync(g, "utf8");
      occurrences += (text.match(nameRe) || []).length;
    }
    // 定义处本身算 1 次；>1 说明还有别处用到
    if (occurrences <= 1) {
      bad(rel, `导出了 ${n} 但全项目无人引用（死代码）`);
      deadCount++;
    }
  }
}
if (deadCount === 0) ok("没有无人引用的导出");

// proxy.js 是 CommonJS（module.exports），单独查一遍
{
  const p = path.join(ROOT, "src", "proxy.js");
  if (fs.existsSync(p)) {
    const src = fs.readFileSync(p, "utf8");
    const m = /module\.exports\s*=\s*\{([^}]*)\}/.exec(src);
    if (m) {
      const names = m[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean);
      let dead = 0;
      for (const n of names) {
        const re = new RegExp(`\\b${n}\\b`, "g");
        let count = 0;
        for (const g of files) count += (fs.readFileSync(g, "utf8").match(re) || []).length;
        if (count <= 1) {
          // NebulaProxy 由 index.js 用 require 动态取，DEFAULTS/ALLOW_PREFIX/DENY_PREFIX 仅作文档用途
          bad("src\\proxy.js", `module.exports 里的 ${n} 无人使用`);
          dead++;
        }
      }
      if (dead === 0) ok("proxy.js 导出的符号均被使用");
    }
  }
}

console.log("\n【⑤ 清单与资源】");
const mf = path.join(ROOT, "plugin.json");
if (!fs.existsSync(mf)) {
  bad("plugin.json", "缺失");
} else {
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, "utf8")); ok("plugin.json 是合法 JSON"); }
  catch (e) { bad("plugin.json", `JSON 解析失败: ${e.message}`); }

  if (m) {
    for (const k of ["name", "version", "minAppVersion", "displayName", "description"]) {
      if (!m[k]) bad("plugin.json", `缺少必填字段 ${k}`);
      else ok(`plugin.json.${k}`);
    }
    // 清单里的资源要真实存在
    for (const k of ["icon", "readme"]) {
      const v = m[k];
      if (!v) continue;
      const paths = typeof v === "object" ? Object.values(v) : [v];
      for (const p of paths) {
        if (!fs.existsSync(path.join(ROOT, p))) bad("plugin.json", `${k} 指向的文件不存在: ${p}`);
        else ok(`plugin.json.${k} → ${p}`);
      }
    }
    // 目录名必须等于 name（思源按目录名加载插件）
    if (path.basename(ROOT) !== m.name) {
      bad("plugin.json", `name(${m.name}) 与目录名(${path.basename(ROOT)}) 不一致，思源将无法正确加载`);
    } else ok(`目录名与 name 一致 (${m.name})`);

    // 前端入口必须存在
    if (!fs.existsSync(path.join(ROOT, "index.js"))) bad("入口", "index.js 缺失");
    else ok("index.js 存在");
  }
}

/*
 * ★ 为什么这里【没有】「裸标识符 / 漏 import」检查 ★（2026-09-23 记录）
 *
 * 背景：曾出过一次「decodeSmart is not defined」——embed.js 的 renderNative()
 *   用了 decodeSmart，但我只给 viewer.js 加了 import、函数搬进了 api.js，
 *   漏了给 embed.js 加。又因为渲染代码写成了
 *     `decodeSmart ? decodeSmart(buf) : new TextDecoder(...).decode(buf)`
 *   这种带兜底的写法，运行时**不报错**，单测全绿（走的正是兜底分支），
 *   真机点开一个 .log 才炸出来。
 *
 * 我尝试在这里用正则做「名字必须有来源」的静态检查，结论是**不划算**：
 *   用正则无法可靠区分「函数调用」与「方法定义/对象字面量键/解构属性」，
 *   实测对 clean 的代码库报出 200+ 条假阳性（constructor、render、if、String…）。
 *   一个满是假阳性的检查比没有检查更糟 —— 它会训练人忽略红色输出。
 *
 * 真正有效的兜底放在两处（都已落地）：
 *   ① tools/build.js 的 dependenciesOf()：依赖从「挖空注释的副本」里取，
 *      且发射绑定名时按名去重 —— 杜绝「注释里的 import 示例」变成真实依赖、
 *      以及同名 const 重复声明导致的整包 SyntaxError。
 *   ② 真机验证（headed Chrome + CDP）：必须**逐个类型**跑一遍，
 *      文本分支同样要跑到（本次正是它暴露了漏 import）。
 *      ⇒ 单测走 fallback 分支"全绿"不能作为通过依据。
 *
 * 另一个直接改进：那次还把 `X ? X() : 兜底` 改成了**直接调用** X()
 *   （漏 import 就该立刻 ReferenceError，而不是静默降级）。
 *   这类「用兜底掩盖配置错误」的写法本身要警惕。
 */

console.log("\n" + "=".repeat(52));
console.log(`  通过 ${pass}   失败 ${fail}`);
if (problems.length) {
  console.log("\n  问题清单：");
  problems.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
}
console.log("=".repeat(52) + "\n");
process.exit(fail ? 1 : 0);

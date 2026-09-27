/* ==========================================================================
 * 构建脚本：把 ESM 源码打包成**单个** index.js，供思源直接加载
 * --------------------------------------------------------------------------
 * 为什么必须打成单文件（★ 这是本插件装不进去的真正原因 ★）
 *
 *   思源执行插件的方式（从 common.js 反读出来的原文）：
 *
 *     const Ue = Ve => Ve === "siyuan" ? P() : window.require?.(Ve);
 *     const ce = (Ve, Xe) => window.eval(
 *       "(function anonymous(require, module, exports){" + Ve + " }) //# sourceURL=" + Xe
 *     );
 *     const He = (Ve, Xe) => {
 *       const ft = {}, Tt = { exports: ft };
 *       try { ce(Xe.js, "plugin:" + encodeURIComponent(Xe.name))(Ue, Tt, ft) }
 *       catch (Et) {                                    // ★ 只进浏览器 console
 *         document.getElementById("pluginsStyle" + Xe.name)?.remove();
 *         console.error(`plugin ${Xe.name} run error:`, Et);
 *         return;
 *       }
 *       const mt = (Tt.exports || ft).default || Tt.exports;
 *       if (typeof mt != "function") { console.error(`plugin ${Xe.name} has no export`); return }
 *       if (!(mt.prototype instanceof Plugin)) { console.error(`plugin ${Xe.name} does not extends Plugin`); return }
 *       return new mt({ app, displayName, name, i18n });
 *     }
 *
 *   关键：插件拿到的 require 是 Ue —— **只认 "siyuan"**，
 *   其它一律委托给 Electron 注入的 window.require。
 *   而 window.require 的解析基准是**渲染进程自己的 bundle 路径**，
 *   不是插件目录 ⇒ 插件里写 require("./src/api.js") **必然 MODULE_NOT_FOUND**。
 *
 *   佐证：data/plugins 下已装的 12 个插件里，**没有任何一个**用相对 require。
 *   多文件插件（siyuan-cloud-document-suite 有 20 个 .js）也是打成单文件的。
 *
 *   后果链：脚本抛错 → 只写浏览器 console（siyuan.log 里干干净净）
 *          → SiYuan 放弃这个插件 → 没有 addDock → 侧栏无图标、插件菜单里也没有。
 *
 *   所以本脚本把 src/*.js 与 index.js **按依赖顺序拼进一个文件**，
 *   并给每个模块加一个私有命名空间，模拟模块作用域。
 *
 * 用法：
 *   node tools/build.js                    → 输出到本机思源（DEFAULT_OUT）
 *   node tools/build.js <目录>              → 输出到指定目录
 *   node tools/build.js --repo              → 输出到仓库的 dist/（用于留档 / 同步）
 *
 * ★ 为什么根目录的 index.js 是「入口源码」而不是产物 ★
 *   build 的输出文件名也叫 index.js，但**绝不能**写回仓库根目录 ——
 *   那会把入口源码覆盖掉（2026-09-22 真出过，且没有 git 可回滚）。
 *   所以仓库里的产物一律放 dist/，并由 assertEntryIsSource() 在每次构建前兜底。
 * ========================================================================== */

const fs = require("fs");
const path = require("path");

const SRC_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk";

/**
 * 仓库内的产物目录。**不要**用 path.join(SRC_ROOT) 本身 ——
 * 根目录下的 index.js 是入口源码，产物写这里会把源码覆盖掉。
 */
const REPO_DIST = path.join(SRC_ROOT, "dist");

/** 入口 */
const ENTRY = "index.js";

/** 需要打进 bundle 的模块（相对 SRC_ROOT），顺序由依赖分析决定 */
const MODULES = [
  "src/proxy.js",
  "src/api.js",
  "src/external.js",
  "src/icons.js",
  "src/tree.js",
  "src/viewer.js",
  "src/embed.js",
  ENTRY,
];

/** 原样拷贝的静态资源 */
const STATIC = [
  "plugin.json",
  "index.css",
  "icon.png",
  "README.md",
  "README.zh_CN.md",
  "DEVELOPMENT.md",
  "REPORT-t67.md",
  "i18n/zh_CN.json",
  "i18n/en_US.json",
];

/* -------------------------------------------------------------------------
 * 1) import / export 文本级转换
 * ---------------------------------------------------------------------- */

/**
 * ★★★ 把注释「挖空」成等长空格，再交给 import/export 正则 ★★★（2026-09-23 修）
 *
 * 为什么必须这么做 —— 这是本构建器一个隐蔽了很久的正确性缺陷：
 *
 *   import 正则（`import\s*\{([\s\S]*?)\}\s*from\s*["']…`）是**纯文本**匹配，
 *   它不认识注释。而源码注释里**完全可能**写出合法的 import 示例语句。
 *   本项目 src/viewer.js 就写了（用来解释循环导入）：
 *
 *       *     ① 注释里的示例代码 `import { insertEmbedIntoDoc } from "./embed.js"`
 *
 *   这一行被构建器当成**真实依赖**匹配到，于是同一个 ./embed.js 被 push 了两次，
 *   产物里就出现两行：
 *       const insertEmbedIntoDoc = __mod_embed.insertEmbedIntoDoc;
 *       const insertEmbedIntoDoc = __mod_embed.insertEmbedIntoDoc;   ← 重复！
 *   → 执行产物直接 `SyntaxError: Identifier 'insertEmbedIntoDoc' has already been declared`
 *     （思源加载插件即失败；因为 const 重复声明是**语法错误**，整包不执行）。
 *
 *   这不是格式问题，是「注释能改变产物语义」的根因。所以在转换前统一把注释
 *   变成空格（**保持长度与换行**，这样后面报错的行号仍然是准的）。
 *
 * 注意：这里只需处理「块注释 + 整行 // 注释」。
 *   不去处理行尾 `// xxx`，因为源码里字符串字面量中的 `//`（如 URL http://）
 *   会被误伤；而本项目所有说明性注释都是块注释或独占整行的 //，覆盖已足够。
 */
function maskComments(code) {
  // 块注释：整段替换成等长空白，但保留其中的换行符，避免行号漂移
  code = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // 独占整行的 // 注释（^\s*// 开头）
  code = code.replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
  return code;
}

/**
 * ★★★ 只在「检测依赖」时挖空注释，正文原样保留 ★★★
 *
 * 关键区分（一开始写错过一次，值得记下来）：
 *   · dependenciesOf() —— 只在**挖空注释的副本**上跑正则。
 *   · stripImports()   —— 在**原文**上删掉真实 import 语句。
 * 如果图省事在 stripImports 里对 code 本身挖空，产物里**全部文档注释都会被
 * 抹成空格**（本项目大量设计说明都写在注释里，那是留给后续维护者的），
 * 所以两者必须分开。
 */
function dependenciesOf(code) {
  const masked = maskComments(code);
  const deps = [];
  const push = (d) => { if (!deps.some((x) => JSON.stringify(x) === JSON.stringify(d))) deps.push(d); };

  // 具名导入（含多行）
  let m;
  const reNamed = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']\s*;?/g;
  while ((m = reNamed.exec(masked))) {
    push({ mod: m[2], names: m[1].split(",").map((s) => s.trim()).filter(Boolean) });
  }
  // 默认导入
  const reDefault = /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']\s*;?/g;
  while ((m = reDefault.exec(masked))) push({ mod: m[2], default: m[1] });
  // 副作用导入
  const reSide = /import\s*["']([^"']+)["']\s*;?/g;
  while ((m = reSide.exec(masked))) push({ mod: m[1], sideEffect: true });

  return deps;
}

/** import {A,B} from "m" → 从正文里删掉（依赖已由 dependenciesOf 收集） */
function stripImports(code, fromRel) {
  // ── 具名导入（含多行）──
  //   ★ 这里的正则不锚行首、也不认注释，于是「注释里的 import 示例」会被它
  //     一并删掉（表现为注释被吃掉一块）。为把误伤降到最低，先把**注释区间**
  //     记下来，删除时跳过落在注释内的匹配。
  const commentRanges = findCommentRanges(code);
  const inComment = (idx) => commentRanges.some(([a, b]) => idx >= a && idx < b);

  const del = (re) => {
    code = code.replace(re, (full, ...args) => {
      const offset = args[args.length - 2]; // 最后一个参数是 offset
      return inComment(offset) ? full : "";
    });
  };

  del(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["']\s*;?/g);
  del(/import\s+[A-Za-z_$][\w$]*\s+from\s*["'][^"']+["']\s*;?/g);
  del(/import\s*["'][^"']+["']\s*;?/g);

  return code;
}

/** 找出所有注释区间 [start, end)，供 stripImports 跳过注释内的匹配 */
function findCommentRanges(code) {
  const ranges = [];
  const re = /\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm;
  let m;
  while ((m = re.exec(code))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** export 声明 → 普通声明 + 记录导出名 */
function stripExports(code) {
  const named = [];
  let defaultName = null;

  code = code.replace(
    /^export\s+default\s+class\s+([A-Za-z_$][\w$]*)?/m,
    (_m, name) => {
      defaultName = name || "DefaultExport";
      return name ? `class ${name}` : `class ${defaultName}`;
    },
  );
  code = code.replace(
    /^export\s+default\s+([A-Za-z_$][\w$]*(?:\s*\([\s\S]*?\))?)\s*;?/m,
    (_m, expr) => {
      defaultName = expr;
      return "";
    },
  );
  code = code.replace(
    /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      named.push(name);
      return `${kind} ${name}`;
    },
  );

  return { code, named, defaultName };
}

/* -------------------------------------------------------------------------
 * ★ CommonJS 兼容层
 *
 *   src/proxy.js 是**用 CommonJS 写的**（结尾 module.exports = {...}），
 *   而其余文件是 ESM。若直接用命名空间 IIFE 包起来，
 *   proxy.js 里的 `module` 就是个未定义变量 → 加载即抛错。
 *
 *   解决办法：给每个模块在自己的作用域里提供 module/exports 两个局部变量，
 *   模块内的 module.exports 赋值照常工作，之后我们再把它作为该模块的导出。
 *   这样 ESM 与 CJS 两种风格的模块都能进同一个 bundle。
 * ---------------------------------------------------------------------- */
function extractCjsExports(code) {
  // 记录是否出现过 module.exports（含 module.exports.X = ... 的形式）
  const hasCjs =
    /\bmodule\.exports\b/.test(
      code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    );
  return hasCjs;
}

/* -------------------------------------------------------------------------
 * 2) 依赖排序（拓扑）。源码里的相对 import 决定顺序。
 * ---------------------------------------------------------------------- */
function resolveDep(fromRel, mod) {
  if (!mod.startsWith(".")) return null; // 外部模块（siyuan / node 内建）
  const base = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(base, mod));
  if (!p.endsWith(".js")) p += ".js";
  return p;
}

function topoSort() {
  const visited = new Set();
  const order = [];

  const visit = (rel, stack) => {
    if (visited.has(rel)) return;
    if (stack.includes(rel)) return; // 循环依赖：跳过，靠提升的声明解决
    const abs = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`模块不存在: ${rel}`);
    // ★ 依赖只从「挖空注释」的副本里取（注释里的 import 示例不算依赖）★
    const deps = dependenciesOf(fs.readFileSync(abs, "utf8"));
    stack.push(rel);
    for (const d of deps) {
      const r = resolveDep(rel, d.mod);
      if (r && MODULES.includes(r)) visit(r, stack);
    }
    stack.pop();
    visited.add(rel);
    order.push(rel);
  };

  for (const m of MODULES) visit(m, []);
  return order;
}

/* -------------------------------------------------------------------------
 * 3) 打包
 * ---------------------------------------------------------------------- */
function bundle() {
  const order = topoSort();
  const parts = [];

  // 每个模块的导出信息
  const exportMap = new Map(); // rel → { named:[], defaultName, cjs:bool }

  /*
   * 每个模块内「已经发射过 const」的绑定名，用于防止重复声明。
   * 见下方 internal 分支的说明：同名 const 重复 = SyntaxError = 整包加载失败。
   */
  const declaredNames = new Map(); // rel → Set<string>

  for (const rel of order) {
    const abs = path.join(SRC_ROOT, rel);
    const raw = fs.readFileSync(abs, "utf8");

    // ★ 依赖（挖空注释后取）与正文删语句（原文上删、跳过注释）分开做 ★
    const deps = dependenciesOf(raw);
    const noImp = stripImports(raw, rel);
    const { code, named, defaultName } = stripExports(noImp);
    const cjs = extractCjsExports(code);

    exportMap.set(rel, { named, defaultName, cjs });

    /*
     * ★ 本模块内「已发射过的 const 绑定名」★
     *   同一个模块里重复 `const x = ...;` 是 SyntaxError（不是覆盖），
     *   会让整包在思源里加载即失败。这里贯穿 external / internal 两个分支统一记账。
     */
    const declared = declaredNames.get(rel) || new Set();
    declaredNames.set(rel, declared);

    const external = deps.filter((d) => !resolveDep(rel, d.mod));
    const internal = deps.filter((d) => resolveDep(rel, d.mod));

    const ns = nsName(rel);
    const lines = [];
    lines.push(`/* ===== ${rel}${cjs ? "  [CommonJS]" : ""} ===== */`);
    lines.push(`const ${ns} = (() => {`);

    /*
     * 给本模块一个私有的 module/exports，让 CommonJS 风格的模块
     * （如 proxy.js）能正常赋值；ESM 模块用不到它，留着也无害。
     */
    lines.push(`  const module = { exports: {} };`);
    lines.push(`  const exports = module.exports;`);

    // 外部依赖：node 内建 / siyuan
    for (const d of external) {
      if (d.mod === "siyuan") {
        const binds = (d.names || []).map((n) => `  const ${n} = SIYUAN.${n};`).filter((line) => {
          const n = line.slice("  const ".length, line.indexOf(" ="));
          if (declared.has(n)) return false;
          declared.add(n);
          return true;
        });
        lines.push(...binds);
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = SIYUAN;`);
        }
      } else if (d.mod.startsWith("node:") || isBuiltin(d.mod)) {
        for (const n of d.names || []) {
          if (declared.has(n)) continue;
          declared.add(n);
          lines.push(`  const ${n} = require(${JSON.stringify(d.mod)}).${n};`);
        }
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = require(${JSON.stringify(d.mod)});`);
        }
      } else {
        // 其它 npm 包（如 @electron/remote）：原样 require
        for (const n of d.names || []) {
          if (declared.has(n)) continue;
          declared.add(n);
          lines.push(`  const ${n} = require(${JSON.stringify(d.mod)}).${n};`);
        }
        if (d.default && !declared.has(d.default)) {
          declared.add(d.default);
          lines.push(`  const ${d.default} = require(${JSON.stringify(d.mod)});`);
        }
      }
    }

    // 内部依赖：从已生成的命名空间取
    for (const d of internal) {
      const target = resolveDep(rel, d.mod);
      const tns = nsName(target);
      const tinfo = exportMap.get(target) || {};
      /*
       * 被依赖的模块若是 CommonJS（如 proxy.js），它的导出在 __exports 上；
       * 若是 ESM，导出就是直接挂在命名空间上的名字。
       */
      const from = tinfo.cjs ? `${tns}.__exports` : tns;
      /*
       * ★ 按「已在本模块声明过的绑定名」去重 ★（2026-09-23）
       *   产物里出现两行同名 `const x = ...;` 是**致命**的 ——
       *   const 重复声明是 SyntaxError，整个插件包会加载失败。
       *   前面 dependenciesOf 已按整条 dep 去重，但同一模块可能被合法地
       *   分两条语句导入同一个名字（如 `import {a} from "m"` 出现两次），
       *   那样的 dep 对象不完全相同，仍会各发射一行。
       *   这里以「绑定名」为唯一键兜底，保证任一模块内每个名字只声明一次。
       */
      for (const n of d.names || []) {
        if (declared.has(n)) {
          // 已声明过：跳过重复发射，避免 SyntaxError
          continue;
        }
        declared.add(n);
        lines.push(`  const ${n} = ${from}.${n};`);
      }
      if (d.default && !declared.has(d.default)) {
        declared.add(d.default);
        lines.push(`  const ${d.default} = ${from}.default;`);
      }
    }

    lines.push(indent(code.trim(), 2));

    // 导出：CJS 模块用它自己的 module.exports；ESM 模块按收集到的名字组装
    lines.push(`  return {`);
    lines.push(`    __cjs: ${cjs},`);
    if (cjs) {
      lines.push(`    __exports: module.exports,`);
    }
    for (const n of named) lines.push(`    ${n},`);
    if (defaultName) lines.push(`    default: ${defaultName},`);
    lines.push(`  };`);
    lines.push(`})();`);

    parts.push(lines.join("\n"));
  }

  // ---- 组装最终文件 ----
  const head = [];
  head.push(`/* -------------------------------------------------------------------------`);
  head.push(` * siyuan-nebuladisk —— 由 tools/build.js 打包生成，请勿直接编辑。`);
  head.push(` *`);
  head.push(` * ★ 必须是单文件：思源给插件的 require 只认 "siyuan"，`);
  head.push(` *   其余委托给 Electron 的 window.require（解析基准是渲染进程 bundle，`);
  head.push(` *   不是插件目录），所以 require("./src/x.js") 必然失败，且**只报在浏览器 console**，`);
  head.push(` *   siyuan.log 里看不到任何痕迹。`);
  head.push(` *`);
  head.push(` * 源码：<项目根>/index.js 与 <项目根>/src/*.js（模块见下方 // ===== 分隔）`);
  head.push(` * ---------------------------------------------------------------------- */`);
  head.push(`"use strict";`);
  head.push(``);
  head.push(`/** 内核为插件提供的 siyuan 内建模块 */`);
  head.push(`const SIYUAN = require("siyuan");`);
  head.push(``);

  const entryNs = nsName(ENTRY);
  const entryMod = exportMap.get(ENTRY) || {};

  /*
   * ★ 入口导出必须是插件类。
   *
   *   入口是 ESM，命名空间的 return 里挂的是
   *     { __cjs:false, <具名导出...>, default: <类名> }
   *   所以插件类位于 **.default**，而不是以类名为键。
   *
   *   早期写成 `${entryNs}.${defaultName}` 会取到 undefined，
   *   于是 module.exports = undefined; module.exports.default = ... 
   *   直接抛 "Cannot set properties of undefined"，插件静默加载失败。
   */
  if (entryMod.cjs) {
    throw new Error(`入口 ${ENTRY} 不应是 CommonJS（需要 export default class）`);
  }
  if (!entryMod.defaultName) {
    throw new Error(
      `入口 ${ENTRY} 没有找到 export default —— 无法确定插件类。` +
        `请确认源码里有 "export default class XxxPlugin"。`
    );
  }
  const entryRef = `${entryNs}.default`;

  const tail = [];
  tail.push(``);
  tail.push(`/* ---- 思源的加载契约：module.exports 必须直接是插件类 ---- */`);
  tail.push(`module.exports = ${entryRef};`);
  tail.push(`module.exports.default = ${entryRef};`);
  tail.push(`/* 顺带暴露常量，便于外部/测试引用（不影响思源加载） */`);
  for (const n of entryMod.named || []) {
    tail.push(`module.exports.${n} = ${entryNs}.${n};`);
  }
  tail.push(``);

  return head.join("\n") + parts.join("\n\n") + "\n" + tail.join("\n");
}

const nsName = (rel) => {
  const base = rel.replace(/^src\//, "").replace(/\.js$/, "").replace(/[^\w$]/g, "_");
  return `__mod_${base}`;
};

const NODE_BUILTINS = [
  "http", "https", "url", "fs", "path", "crypto", "os", "stream", "zlib",
  "net", "tls", "events", "util", "querystring", "buffer", "child_process",
  "worker_threads", "assert", "dns",
];
const isBuiltin = (m) => NODE_BUILTINS.includes(m) || m.startsWith("node:");

function indent(code, n) {
  const pad = " ".repeat(n);
  return code.split("\n").map((l) => (l.trim() ? pad + l : l)).join("\n");
}

/* -------------------------------------------------------------------------
 * 4) 自检
 * ---------------------------------------------------------------------- */
function selfCheck(outDir, bundleCode) {
  const problems = [];

  /*
   * 先去掉注释再扫 —— 否则我自己写的说明文字（里面举例提到
   * require("./src/x.js")）会被当成真的 require 而误报。
   */
  const stripped = bundleCode
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  // ★ 最关键：产物里不能再有「非 siyuan」的相对 require
  const badReqs = [];
  const re = /require\(\s*["'](\.\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(stripped))) badReqs.push(m[1]);
  if (badReqs.length) {
    problems.push(
      `产物里仍有相对 require（思源无法解析，会静默失败）: ${[...new Set(badReqs)].join(", ")}`
    );
  }

  // 不得残留 ESM
  if (/^\s*export\s+(default|const|function|class)\b/m.test(stripped)) {
    problems.push("产物仍含 export 语句");
  }
  if (/^\s*import\s+[\w{*]/m.test(stripped)) {
    problems.push("产物仍含 import 语句");
  }

  // 必须导出插件类
  if (!/module\.exports\s*=/.test(stripped)) {
    problems.push("产物没有 module.exports");
  }

  /* ★★★ 围栏自检：嵌入块的 markdown 必须「顶格 ;;;」★★★
   *
   *   2026-09-22 在 NAS 实测（/api/filetree/createDocWithMd 逐字对照）：
   *       ;;;siyuan-nebuladisk/nebuladisk  → type=custom ✓
   *      [;;;siyuan-nebuladisk/nebuladisk  → type=p      ✗（裸 JSON）
   *   围栏前面多任何一个字符，思源就不把它编译成自定义块了。
   *   这里在构建期断言模板字面量顶格，避免哪天顺手加个空格/前缀就把功能弄坏。
   */
  if (!/`;;;\$\{embedLang\(/.test(bundleCode)) {
    problems.push(
      "buildEmbedMarkdown 的围栏模板不再顶格 —— " +
      "必须是 `;;;${embedLang(...)}\\n…\\n;;;\\n`；" +
      "围栏前多任何字符都会退化成普通段落，笔记里显示成裸 JSON"
    );
  }
  // 活动代码里不能出现前端 protyle.insert 兜底（它会静默产出坏块）
  if (/typeof\s+protyle\.insert/.test(stripped)) {
    problems.push(
      "产物里仍有前端 protyle.insert 兜底 —— 实测它只会产出 type=p 的字面围栏段落（裸 JSON），且失败静默"
    );
  }

  // 清单合法性
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(outDir, "plugin.json"), "utf8"));
    const dirName = path.basename(outDir);
    /*
     * 目录名 == plugin.json.name。思源靠这个配对加载插件。
     * 例外：仓库内的 dist/ 只是**留档产物**，不直接给思源加载，
     * 目录名自然不叫 siyuan-nebuladisk，这里跳过这条检查（其余照查）。
     */
    const isRepoDist = path.resolve(outDir) === path.resolve(REPO_DIST);
    if (!isRepoDist && pj.name !== dirName) {
      problems.push(`plugin.json.name(${pj.name}) 与目录名(${dirName}) 不一致`);
    }
    if (pj.icon && !fs.existsSync(path.join(outDir, pj.icon))) problems.push(`icon 缺失: ${pj.icon}`);
    for (const [k, v] of Object.entries(pj.readme || {})) {
      if (!fs.existsSync(path.join(outDir, v))) problems.push(`readme.${k} 缺失: ${v}`);
    }
  } catch (e) {
    problems.push("plugin.json 无法解析: " + e.message);
  }

  return problems;
}

/* -------------------------------------------------------------------------
 * 主流程
 * ---------------------------------------------------------------------- */

/**
 * ★ 入口完整性前置断言 ★（2026-09-22 加，因为真出过一次事）
 *
 *   仓库根 `index.js` 有两个**同名但性质完全不同**的副本：
 *     · 它是 build.js 的 ENTRY **源码**（ESM，有 export default class）
 *     · 它同时又是 build 的**输出文件名**（bundle，CommonJS，有 module.exports）
 *   两者同名是历史包袱。踩过的坑：有人把 `D:/Software/SiYuan/.../index.js`
 *   （打包产物）拷回来「同步仓库」，结果入口源码被产物覆盖 ⇒ 下次 build
 *   报「入口不应是 CommonJS」，而且真正的入口源码**无处可寻**（没有 git）。
 *
 *   这里在打包前先查一遍，把「入口被产物覆盖」变成一条**一眼能看懂**的报错，
 *   而不是让人去猜 bundle() 里那句 CommonJS 断言是什么意思。
 */
function assertEntryIsSource() {
  const entryAbs = path.join(SRC_ROOT, ENTRY);
  if (!fs.existsSync(entryAbs)) {
    throw new Error(
      `入口源码不存在: ${entryAbs}\n` +
      `  （注意：仓库根的 index.js 必须是 **ESM 入口源码**，不是打包产物。）`
    );
  }
  const text = fs.readFileSync(entryAbs, "utf8");
  const hasEsm = /^\s*export\s+default\s+class\b/m.test(text);
  const looksLikeBundle =
    /由 tools\/build\.js 打包生成，请勿直接编辑/.test(text) ||
    /^"use strict";$/m.test(text.split("\n").slice(0, 30).join("\n")) &&
      /const __mod_/.test(text);

  if (looksLikeBundle) {
    throw new Error(
      `★ 仓库根的 ${ENTRY} 看起来是**打包产物**，而不是入口源码！★\n` +
      `  它同时是 build 的输出文件名，所以很可能被「同步产物」这一步覆盖了。\n` +
      `  修复：从上一版 bundle 逆向还原入口（build 的变换是可逆的），\n` +
      `  或是从备份/版本库取回 export default class 那份。\n` +
      `  提示：还原后文件应以 import … from "./src/xxx.js" 开头。`
    );
  }
  if (!hasEsm) {
    throw new Error(
      `入口 ${ENTRY} 里找不到 "export default class" —— 它不像合法入口源码。`
    );
  }
  return text;
}

/**
 * ★★★ 清单完整性前置断言（2026-09-26 加，因为真出过第二次）★★★
 *
 *   现象：仓库根的 `plugin.json` 被**另一个插件（画布 siyuan-diskcanvas）的
 *   manifest 整体覆盖**了 —— name/displayName/url/version/description/readme
 *   全变成画布插件的值（`name: "siyuan-diskcanvas"`、`README_zh_CN.md`）。
 *
 *   后果链（比 index.js 那次更隐蔽）：
 *     · plugin.json 被原样拷进安装目录 ⇒ 目录叫 siyuan-nebuladisk，
 *       而 name 是 siyuan-diskcanvas ⇒ **思源靠 name==目录名 配对，加载不起来**
 *     · readme.zh_CN 指向 README_zh_CN.md（本项目里是 README.zh_CN.md）⇒ 缺文件
 *     · 而且 build.js **不会报错**：它只拷静态文件，两份清单都是合法 JSON，
 *       自检里那条 name==目录名 检查在 `--repo` 目标下还被刻意跳过了
 *     ⇒ 典型症状是「构建成功、装上去没反应」，又一次"语法通过≠能跑"。
 *
 *   注意这是**同一类事故的第三次**（前两次：index.js 入口被产物覆盖、
 *   index.css 被画布插件 CSS 覆盖）。三个文件的共同点是被"跨项目同步"
 *   误伤 ⇒ 所以这条断言也顺带校验「清单里所有引用的文件真实存在」。
 */
function assertManifestIsThisPlugin() {
  const p = path.join(SRC_ROOT, "plugin.json");
  const raw = fs.readFileSync(p, "utf8");
  let mj;
  try {
    mj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`plugin.json 不是合法 JSON：${e.message}`);
  }
  const problems = [];

  // ① name 必须是本项目
  if (mj.name !== "siyuan-nebuladisk") {
    problems.push(
      `name = ${JSON.stringify(mj.name)}，期望 "siyuan-nebuladisk"`
    );
  }
  // ② 反例哨兵：画布插件的特征值一个都不该出现
  const canvasMarks = [
    mj.name === "siyuan-diskcanvas",
    /diskcanvas/i.test(String(mj.url || "")),
    /盘绘|DiskCanvas/i.test(JSON.stringify(mj.displayName || {})),
    /README_zh_CN\.md$/.test(String((mj.readme || {}).zh_CN || "")),
  ];
  if (canvasMarks.some(Boolean)) {
    problems.push("检测到**画布插件(siyuan-diskcanvas)** 的清单特征（疑似被跨项目同步覆盖）");
  }
  // ③ 引用的文件必须存在（README/icon 缺失时思源会静默跳过插件）
  for (const [k, v] of Object.entries(mj.readme || {})) {
    if (!fs.existsSync(path.join(SRC_ROOT, v))) {
      problems.push(`readme.${k} 指向的文件不存在：${v}`);
    }
  }
  if (mj.icon && !fs.existsSync(path.join(SRC_ROOT, mj.icon))) {
    problems.push(`icon 不存在：${mj.icon}`);
  }

  if (problems.length) {
    throw new Error(
      `★ 仓库根的 plugin.json 看起来**不是本插件的清单**！★\n` +
      problems.map((x) => `    · ${x}`).join("\n") + "\n" +
      `  它很可能被「跨插件/跨项目同步」覆盖了（本项目已发生 3 次同类事故：\n` +
      `  index.js 入口被产物覆盖、index.css 被画布插件 CSS 覆盖、plugin.json 被画布清单覆盖）。\n` +
      `  修复：从版本库取回 —— git checkout -- plugin.json`
    );
  }
  return mj;
}

/**
 * ★★★ 断言 i18n 词表属于本插件（第 4 类跨项目污染）★★★
 *
 * 背景（2026-09-27 实测）：`i18n/zh_CN.json` 被画布插件整份覆盖 ——
 * 476 条 `canvasHelper` / `untitledCanvas` / `toolbarNew` 之类的画布词条，
 * 而本插件真正引用的 `dockTitle` / `embedFileName` / `openInBrowser` /
 * `refreshAll` / `settingsTitle` / `settingsVerify` **一个都没有**。
 *
 * 为什么危险且难发现：
 *   - 插件每处调用都写了中文兜底（`this.i18n.dockTitle || "NebulaDisk"`），
 *     所以**中文环境下完全看不出问题**；
 *   - 只有在非中文界面才会退化成兜底值 ⇒ 长期潜伏。
 *
 * 判据（不依赖词表内容语义，只依赖「代码真的在用」）：
 *   ① i18n 里至少要有 N 个「源码里真实引用」的 key —— 一个都没有必是污染；
 *   ② 画布插件的标志性 key 不得出现。
 */
function assertI18nIsThisPlugin() {
  const I18N_USED = [
    "dockTitle",
    "embedFileName",
    "openInBrowser",
    "refreshAll",
    "settingsTitle",
    "settingsVerify",
  ];
  // 画布插件（siyuan-diskcanvas）的标志词条，任一出现即判定为被覆盖
  const CANVAS_KEYS = [
    "canvasHelper",
    "untitledCanvas",
    "toolbarNew",
    "dockEmptySelectionTip",
    "openCanvasPath",
  ];

  const dir = path.join(SRC_ROOT, "i18n");
  if (!fs.existsSync(dir)) return;

  const problems = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const fp = path.join(dir, f);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
      problems.push(`i18n/${f} 不是合法 JSON：${e.message}`);
      continue;
    }
    const keys = Object.keys(obj || {});
    const hit = I18N_USED.filter((k) => keys.includes(k));
    const canvasHit = CANVAS_KEYS.filter((k) => keys.includes(k));
    if (canvasHit.length) {
      problems.push(
        `i18n/${f} 出现**画布插件**词条 ${canvasHit.join(", ")}（疑似被跨项目同步覆盖）`
      );
    }
    if (hit.length === 0) {
      problems.push(
        `i18n/${f} 里**没有任何**本插件源码引用的 key（${I18N_USED.join(", ")}）` +
        ` ⇒ 整份词表都不是本插件的（共 ${keys.length} 条）`
      );
    }
  }

  if (problems.length) {
    throw new Error(
      `★ i18n 词表看起来**不属于本插件**！★\n` +
      problems.map((x) => `    · ${x}`).join("\n") + "\n" +
      `  修复：从版本库取回 —— git checkout -- i18n/`
    );
  }
}

function main() {
  let outDir = process.argv[2] || DEFAULT_OUT;
  if (outDir === "--repo") outDir = REPO_DIST;

  assertEntryIsSource();
  assertManifestIsThisPlugin();
  assertI18nIsThisPlugin();

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "i18n"), { recursive: true });

  const code = bundle();
  fs.writeFileSync(path.join(outDir, "index.js"), code, "utf8");

  console.log(`输出目录：${outDir}\n`);
  console.log(`  ✓ index.js  (打包，${code.length} 字节)`);

  for (const rel of STATIC) {
    const src = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(src)) {
      console.log(`  ! ${rel} 不存在，跳过`);
      continue;
    }
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${rel}  (拷贝)`);
  }

  // ★ 清理旧的 src/ 目录：改造前是多文件布局，留着会让思源误以为还需要它，
  //   而且旧文件里的相对 require 会继续误导排查。用覆盖式写空再删目录。
  const oldSrc = path.join(outDir, "src");
  if (fs.existsSync(oldSrc)) {
    for (const f of fs.readdirSync(oldSrc)) {
      const fp = path.join(oldSrc, f);
      if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
    }
    fs.rmdirSync(oldSrc);
    console.log(`  ✓ 已移除旧的 src/ 目录（改为单文件打包）`);
  }

  const problems = selfCheck(outDir, code);

  console.log("\n---------------- 自检 ----------------");
  if (problems.length === 0) {
    console.log("  ✅ 单文件打包完成；无相对 require；module.exports 已设置");
  } else {
    console.log("  ❌ 发现 " + problems.length + " 个问题:");
    for (const p of problems) console.log("     · " + p);
  }
  console.log("--------------------------------------\n");

  process.exitCode = problems.length ? 1 : 0;
}

main();

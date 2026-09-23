/* ==========================================================================
 * 嵌入块解析测试
 * --------------------------------------------------------------------------
 * embed.js 是 ESM，且 import 了 "siyuan"（宿主提供，node 里不存在）。
 * 因此这里不去 import 它，而是**从源码里抽取 parseEmbed / stringifyEmbed**
 * 单独求值 —— 这两个函数是纯函数，不依赖任何外部符号。
 *
 * 这样既能测到真实实现（不是复制一份），又不需要造一个 siyuan 桩模块。
 * ========================================================================== */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.resolve(__dirname, "../src/embed.js"), "utf8");

/** 从源码里切出一个具名函数的完整定义（大括号配平，跳过字符串与注释） */
function extractFunction(src, name) {
  const re = new RegExp(`export\\s+function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`找不到函数 ${name}`);

  // 从函数名之后开始找「函数体的 {」：先跳过参数列表的括号对
  let i = m.index + m[0].length - 1;   // 指向 "("
  let paren = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(") paren++;
    else if (c === ")") {
      paren--;
      if (paren === 0) { i++; break; }
    }
  }
  // 然后是返回类型/空白，真正的函数体 { 在这里
  while (i < src.length && src[i] !== "{") i++;
  const start = i;

  let depth = 0;
  let mode = "code";   // code | line | block | str | tmpl
  for (; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === "line") {
      if (c === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; i++; }
      continue;
    }
    if (mode === "str") {
      if (c === "\\") { i++; continue; }
      if (c === '"') mode = "code";
      continue;
    }
    if (mode === "tmpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") mode = "code";
      continue;
    }

    // code
    if (c === "/" && next === "/") { mode = "line"; i++; continue; }
    if (c === "/" && next === "*") { mode = "block"; i++; continue; }
    if (c === '"') { mode = "str"; continue; }
    if (c === "'") { mode = "str"; continue; }
    if (c === "`") { mode = "tmpl"; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配平`);
}

const fnSrc = [
  extractFunction(SRC, "parseEmbed"),
  extractFunction(SRC, "stringifyEmbed"),
]
  // vm.Script 按脚本解析，不支持 export 关键字 —— 剥掉它
  .map((s) => s.replace(/^export\s+/, ""))
  .join("\n");

const ctx = {};
vm.createContext(ctx);
new vm.Script(`${fnSrc}\nthis.parseEmbed = parseEmbed; this.stringifyEmbed = stringifyEmbed;`)
  .runInContext(ctx);
const { parseEmbed, stringifyEmbed } = ctx;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

console.log("\n【parseEmbed】");

/*
 * ★ 关于 path 的前导斜杠（2026-09-22 修正断言）★
 *
 *   parseEmbed 会**主动补上前导 "/"**：后端 /api/preview 的 path 形如
 *   "/a/b.pdf"，而早期版本插入的嵌入块里存的是没有前导斜杠的路径。
 *   补斜杠让历史笔记里的旧块也能正常渲染，不必让用户手动重建。
 *   ⇒ 所以断言必须期望 **带前导斜杠** 的归一化结果，而不是原样保留。
 *   统一用 helper pathOf() 表达这个约定，免得每处重复。
 */
const pathOf = (p) => (p && !p.startsWith("/") ? "/" + p : p);

console.log("\n  —— path 归一化（补前导斜杠）——");
check("缺前导斜杠时补上", () => {
  assert.strictEqual(parseEmbed('{"kind":"tree","mount":"m","path":"2026/x"}').path, "/2026/x");
});
check("已有前导斜杠时保持不变（不重复补）", () => {
  assert.strictEqual(parseEmbed('{"kind":"tree","mount":"m","path":"/2026/x"}').path, "/2026/x");
});
check("空 path 保持空串（不补成 \"/\"）", () => {
  assert.strictEqual(parseEmbed('{"kind":"tree","mount":"m","path":""}').path, "");
});

check("标准 tree 块", () => {
  const r = parseEmbed('{"kind":"tree","mount":"售前项目","path":"2026/某项目"}');
  assert.strictEqual(r.kind, "tree");
  assert.strictEqual(r.mount, "售前项目");
  assert.strictEqual(r.path, pathOf("2026/某项目"));
});

check("标准 file 块（带 name）", () => {
  const r = parseEmbed('{"kind":"file","mount":"项目设计","path":"图纸/A-01.dwg","name":"A-01.dwg"}');
  assert.strictEqual(r.kind, "file");
  assert.strictEqual(r.name, "A-01.dwg");
});

check("★ 中文盘符与路径不丢失", () => {
  const r = parseEmbed('{"kind":"tree","mount":"研发立项","path":"子目录/更深一层"}');
  assert.strictEqual(r.mount, "研发立项");
  assert.strictEqual(r.path, pathOf("子目录/更深一层"));
});

check("★ 路径里含 # 空格等特殊字符", () => {
  const r = parseEmbed('{"kind":"file","mount":"项目设计","path":"1.2.14.TFDF-6# F向.STEP","name":"1.2.14.TFDF-6# F向.STEP"}');
  assert.strictEqual(r.path, pathOf("1.2.14.TFDF-6# F向.STEP"));
  assert.strictEqual(r.name, "1.2.14.TFDF-6# F向.STEP");
});

check("kind 缺省时默认为 tree", () => {
  const r = parseEmbed('{"mount":"售前项目","path":"x"}');
  assert.strictEqual(r.kind, "tree");
});

check("非法 kind 归一化为 tree", () => {
  const r = parseEmbed('{"kind":"weird","mount":"a","path":"b"}');
  assert.strictEqual(r.kind, "tree");
});

check("path 缺省为空串", () => {
  const r = parseEmbed('{"kind":"tree","mount":"售前项目"}');
  assert.strictEqual(r.path, "");
});

check("留白不影响解析", () => {
  const r = parseEmbed('  \n {"kind":"tree","mount":"m","path":"p"}  \n ');
  assert.strictEqual(r.mount, "m");
});

check("height 被解析为数字", () => {
  const r = parseEmbed('{"kind":"tree","mount":"m","path":"p","height":"520"}');
  assert.strictEqual(r.height, 520);
});

check("包容 key=value 朴素写法", () => {
  const r = parseEmbed("kind=tree\nmount=售前项目\npath=a/b");
  assert.strictEqual(r.kind, "tree");
  assert.strictEqual(r.mount, "售前项目");
  assert.strictEqual(r.path, pathOf("a/b"));
});

check("空内容返回 null", () => {
  assert.strictEqual(parseEmbed(""), null);
  assert.strictEqual(parseEmbed("   \n  "), null);
});

check("损坏 JSON 返回 null 而非抛异常", () => {
  assert.strictEqual(parseEmbed('{"kind":"tree",'), null);
});

check("缺 mount 返回 null", () => {
  assert.strictEqual(parseEmbed('{"kind":"tree","path":"p"}'), null);
});

console.log("\n【stringifyEmbed 往返】");

check("★ tree 往返一致", () => {
  const spec = { kind: "tree", mount: "售前项目", path: "/2026/某项目" };
  const r = parseEmbed(stringifyEmbed(spec));
  // 注意：r 来自 vm 创建的另一个 realm，其 Object 原型与主 realm 不同，
  //       deepStrictEqual 会因此判定不等。这里逐字段比较。
  assert.strictEqual(r.kind, spec.kind);
  assert.strictEqual(r.mount, spec.mount);
  assert.strictEqual(r.path, spec.path);
});

check("★ 无前导斜杠的旧 block 往返后也被归一化", () => {
  // 历史笔记里存的是 "2026/某项目"，往返一轮后应稳定为 "/2026/某项目"
  const spec = { kind: "tree", mount: "售前项目", path: "2026/某项目" };
  const once = parseEmbed(stringifyEmbed(spec));
  assert.strictEqual(once.path, "/2026/某项目");
  // 再往返一次必须**幂等**（不能变成 "//2026/某项目"）
  const twice = parseEmbed(stringifyEmbed(once));
  assert.strictEqual(twice.path, "/2026/某项目", "二次往返不幂等，前导斜杠被重复添加");
});

check("★ file 往返保留 name", () => {
  const spec = { kind: "file", mount: "项目设计", path: "/图纸/A-01.dwg", name: "A-01.dwg" };
  const r = parseEmbed(stringifyEmbed(spec));
  assert.strictEqual(r.name, "A-01.dwg");
  assert.strictEqual(r.kind, "file");
});

check("tree 不写入多余的 name 字段", () => {
  const s = stringifyEmbed({ kind: "tree", mount: "m", path: "/p", name: "无关" });
  assert.ok(!s.includes('"name"'), `实际: ${s}`);
});

check("★ 含 # 的路径往返后仍是完整路径", () => {
  const spec = { kind: "file", mount: "m", path: "/a/b#c/d.step", name: "d.step" };
  const r = parseEmbed(stringifyEmbed(spec));
  assert.strictEqual(r.path, "/a/b#c/d.step");
});

check("输出是单行合法 JSON", () => {
  const s = stringifyEmbed({ kind: "tree", mount: "m", path: "/p" });
  assert.ok(!s.includes("\n"));
  assert.doesNotThrow(() => JSON.parse(s));
});

console.log("\n" + "=".repeat(46));
console.log(`  通过 ${pass}   失败 ${fail}`);
console.log("=".repeat(46) + "\n");
process.exit(fail ? 1 : 0);

/* reverse-icons.cjs — REVERSE TEST for task29's icon assertions.
 *
 * 一个"永远绿"的断言等于没有断言。这里注入 3 个人为故障，确认对应断言变红：
 *   INJ-1: 把目录图标颜色改回主题色 → 断言 A 必须红
 *   INJ-2: 让未知扩展名退回「名字前 3 个字符」老 bug → 断言 D 必须红
 *   INJ-3: 把 svg 换成带背景色的 span 老做法 → 断言 G 必须红
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.resolve(__dirname, "../src/icons.js"), "utf8");

function makeDom() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), _children: [], _attrs: {}, _style: {}, _inner: "",
      className: "",
      setAttribute(k, v) { this._attrs[k] = v; if (k === "class") this.className = v; },
      getAttribute(k) { return this._attrs[k]; },
      appendChild(c) { this._children.push(c); this._first = c; return c; },
      get firstElementChild() { return this._first || null; },
      get innerHTML() { return this._inner; },
      set innerHTML(v) {
        this._inner = v;
        const m = /<svg\b[^>]*>[\s\S]*<\/svg>/.exec(v);
        if (m) { const cls = /class="([^"]*)"/.exec(m[0]); const s = makeEl("svg");
          if (cls) s.className = cls[1]; s._inner = m[0]; this._first = s; }
      },
      outerHTML() { return this._inner || ("<" + tag + ">"); },
    };
    el.style = { setProperty(k, v) { el._style[k] = v; }, getPropertyValue(k) { return el._style[k]; } };
    return el;
  }
  return { createElement: (t) => makeEl(t), createElementNS: (_n, t) => makeEl(t) };
}

function load(src0) {
  let src = src0.replace(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm, () => "");
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m; while ((m = re.exec(src))) names.push(m[1]);
  src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  src += `\nmodule.exports = { ${names.join(", ")} };`;
  const mod = { exports: {} };
  vm.runInContext(src, vm.createContext({ module: mod, exports: mod.exports, console, document: makeDom() }),
                  { filename: "src/icons.js" });
  return mod.exports;
}

const CASES = [
  ["A 目录是琥珀色", (I) => {
    const el = I.typeIconEl("", true);
    assert.ok(/nb-type-icon--dir/.test(el.className), "缺 --dir 类");
    assert.ok(el.innerHTML.includes("#e8a33d"), "文件夹应是琥珀色");
  }],
  ["D 未知扩展名是灰纸", (I) => {
    const el = I.typeIconEl("xyzzy", false);
    assert.ok(el.innerHTML.includes("#8a8a8a"), "未知类型应是灰纸");
    assert.ok(!el.innerHTML.includes("XYZ"), "不该把扩展名当文字画上去");
  }],
  ["G 是 svg 且不用背景色", (I) => {
    const el = I.typeIconEl("dwg", false);
    assert.ok(/svg/i.test(el.tagName), "必须是 svg");
    assert.ok(!/background/.test(el.innerHTML), "不该靠背景色上色");
    assert.ok(el.innerHTML.includes('fill="none"'), "应 fill=none");
  }],
];

function runSuite(label, src) {
  const I = load(src);
  let red = 0;
  const lines = [];
  for (const [name, fn] of CASES) {
    try { fn(I); lines.push(["ok", name]); }
    catch (e) { lines.push(["RED", name + " -> " + e.message.split("\n")[0]]); red++; }
  }
  console.log("=== " + label + " ===");
  for (const [st, l] of lines) console.log(`  ${st === "ok" ? "✅" : "❌"} ${l}`);
  return red;
}

// 基线
const baseRed = runSuite("基线（原始源码，应全绿）", SRC);

// INJ-1：目录颜色改回主题色
const inj1 = SRC.replace(/folder: _folderSvg\("#e8a33d"\)/, 'folder: _folderSvg("#123456")');
console.log("\n注入1 命中:", inj1 !== SRC);
const red1 = runSuite("注入1：目录改成 #123456（断言 A 应变红）", inj1);

// INJ-2：未知扩展名退回老 bug（把扩展名当前缀文字画上去）
const inj2 = SRC.replace(
  /unknown: _paperSvg\("#8a8a8a", ""\)/,
  'unknown: _paperSvg("#8a8a8a", _letter("#8a8a8a", "XYZ"))',
);
console.log("\n注入2 命中:", inj2 !== SRC);
const red2 = runSuite("注入2：未知类型画上 XYZ（断言 D 应变红）", inj2);

// INJ-3：改回「带背景色的 span」老做法
const inj3 = SRC.replace(
  /const svg = svgFromString\(FILE_SVG\[badge\.kind\] \|\| FILE_SVG\.unknown\);/,
  'const svg = document.createElement("span"); svg.innerHTML = `<span style="background:${badge.color}">${badge.label}</span>`;',
);
console.log("\n注入3 命中:", inj3 !== SRC);
const red3 = runSuite("注入3：退回背景色 span（断言 G 应变红）", inj3);

console.log("\n=== 结论 ===");
console.log("基线红条数:", baseRed, baseRed === 0 ? "OK" : "FAIL");
console.log("注入1 红:", red1, red1 >= 1 ? "OK 断言有效" : "FAIL 死的");
console.log("注入2 红:", red2, red2 >= 1 ? "OK 断言有效" : "FAIL 死的");
console.log("注入3 红:", red3, red3 >= 1 ? "OK 断言有效" : "FAIL 死的");

// ★ 汇总行必须用「通过 N / 失败 M」的固定格式 ★
//   —— 反向测试**故意**在注入阶段打印 ❌，跑测器若按 ❌ 计数会把注入红条当失败。
//      这里显式输出自身判定结果，让 run-all-tests.cjs 正则稳定命中。
const bad = (baseRed !== 0 ? 1 : 0) + (red1 < 1 ? 1 : 0) + (red2 < 1 ? 1 : 0) + (red3 < 1 ? 1 : 0);
const checks = 4;
console.log(`\n通过 ${checks - bad} / 失败 ${bad}`);
process.exit(bad === 0 ? 0 : 1);

/* verify-icons.cjs — task29 检查：新的 icons.js 是否产出「网盘风格」图标。
 *
 * icons.js 是 ESM 且用了 document（DOM）。这里用 vm + 一个极小的 DOM 桩来求值，
 * 从而直接测**真实实现**，而不是复制一份逻辑。
 *
 * 断言（契约）：
 *   A. 目录 → svg.nb-type-icon--dir，内含琥珀色 #e8a33d
 *   B. Word/xlsx/ppt/pdf 各自带品牌色
 *   C. CAD → #0b6a8f；3D(step) → #00838f 且是立方体路径
 *   D. 未知扩展名 → unknown 纸（灰 #8a8a8a），**不再退化成「名字前3个字」**
 *   E. 传文件名（"报告.PDF"）与传扩展名（"pdf"）结果一致（兼容层）
 *   F. typeBadge 契约不变：仍返回 {label,color}
 *   G. 输出的 svg **不带** 会被污染的裸 span/背景色
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SRC = fs.readFileSync(path.resolve(__dirname, "../src/icons.js"), "utf8");

/** 极简 DOM 桩：够 icons.js 用（createElement / createElementNS / innerHTML→firstElementChild） */
function makeDom() {
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _children: [],
      _attrs: {},
      _style: {},
      _inner: "",
      className: "",
      setAttribute(k, v) { this._attrs[k] = v; if (k === "class") this.className = v; },
      getAttribute(k) { return this._attrs[k]; },
      appendChild(c) { this._children.push(c); this._first = c; return c; },
      get firstElementChild() { return this._first || null; },
      get innerHTML() { return this._inner; },
      set innerHTML(v) {
        this._inner = v;
        // 只实现「一段 svg」这一种：把最外层 <svg …> 抠成元素
        const m = /<svg\b[^>]*>[\s\S]*<\/svg>/.exec(v);
        if (m) {
          const svgText = m[0];
          const cls = /class="([^"]*)"/.exec(svgText);
          const s = makeEl("svg");
          if (cls) s.className = cls[1];
          s._inner = svgText;
          this._first = s;
        }
      },
      outerHTML() { return this._inner || ("<" + tag + ">"); },
    };
    // ★ style 必须是**对象**且 setProperty 可写：
    //   早期版本把 style 放进了对象字面量，setProperty 里的 this 指向
    //   字面量而不是 el，于是 "Cannot set properties of undefined"。
    el.style = { setProperty(k, v) { el._style[k] = v; }, getPropertyValue(k) { return el._style[k]; } };
    return el;
  }
  return {
    createElement: (t) => makeEl(t),
    createElementNS: (_ns, t) => makeEl(t),
  };
}

function loadIcons() {
  let src = SRC;
  // ESM → CJS（与 e2e 的做法一致）
  src = src.replace(
    /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?[ \t]*$/gm,
    () => "",
  );
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let m; while ((m = re.exec(src))) names.push(m[1]);
  src = src.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, "");
  src += `\nmodule.exports = { ${names.join(", ")} };`;

  const mod = { exports: {} };
  const dom = makeDom();
  const ctx = vm.createContext({ module: mod, exports: mod.exports, console, document: dom });
  vm.runInContext(src, ctx, { filename: "src/icons.js" });
  return mod.exports;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n       " + e.message); fail++; }
}

const I = loadIcons();

console.log("【任务29：网盘风格图标】");

check("A 目录 → svg.nb-type-icon--dir 且含琥珀色 #e8a33d", () => {
  const el = I.typeIconEl("", true);
  assert.ok(/svg/i.test(el.tagName), "应是 svg，实际 " + el.tagName);
  assert.ok(/nb-type-icon--dir/.test(el.className), "缺 --dir 类，实际 " + el.className);
  assert.ok(el.innerHTML.includes("#e8a33d"), "文件夹应是琥珀色 #e8a33d");
});

check("B Word/Excel/PPT/PDF 各带品牌色", () => {
  const cases = [["doc", "#2b579a"], ["xlsx", "#217346"], ["pptx", "#c43e1c"], ["pdf", "#c8102e"]];
  for (const [ext, color] of cases) {
    const el = I.typeIconEl(ext, false);
    assert.ok(el.innerHTML.includes(color), ext + " 应含 " + color + "，实际 " + el.innerHTML.slice(0, 80));
  }
});

check("C CAD=#0b6a8f，3D(step)=#00838f 且是立方体（3 条路径以上）", () => {
  const cad = I.typeIconEl("dwg", false);
  assert.ok(cad.innerHTML.includes("#0b6a8f"), "CAD 色不对");
  const st = I.typeIconEl("step", false);
  assert.ok(st.innerHTML.includes("#00838f"), "3D 色不对");
  const paths = (st.innerHTML.match(/<path/g) || []).length;
  assert.ok(paths >= 3, "3D 应画出等轴测立方体（>=3 条 path），实际 " + paths);
});

check("D 未知扩展名 → 灰纸 #8a8a8a（不再退化成名字前3字）", () => {
  const el = I.typeIconEl("xyzzy", false);
  assert.ok(el.innerHTML.includes("#8a8a8a"), "未知类型应是灰色纸张");
  assert.ok(!el.innerHTML.includes("XYZ"), "不应把扩展名当文字画上去");
});

check("E 传文件名与传扩展名结果一致（兼容层）", () => {
  const a = I.typeIconEl("报告.PDF", false);
  const b = I.typeIconEl("pdf", false);
  assert.strictEqual(a.innerHTML, b.innerHTML, "文件名/扩展名应产出同一张图");
});

check("F typeBadge 契约不变：返回 {label,color}", () => {
  const r = I.typeBadge("pdf");
  assert.strictEqual(r.label, "PDF");
  assert.strictEqual(r.color, "#c8102e");
  const u = I.typeBadge("");
  assert.strictEqual(u.label, "?");
});

check("G 输出的是 svg，且没有旧的色块 span 痕迹", () => {
  const el = I.typeIconEl("dwg", false);
  assert.ok(/svg/i.test(el.tagName), "必须是 svg");
  assert.ok(!/background/.test(el.innerHTML), "不该再靠背景色上色");
  assert.ok(el.innerHTML.includes('fill="none"'), "应使用 fill=none + 显式描边（网盘画法）");
});

console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

/* verify-cad-unpoison.cjs — /cad/ 反代的「一次性解污染」契约测试
 *
 * ★ 为什么需要这段代码（真实返工）★
 *   /lite 曾用「往 localStorage 播种 isShowXxx=false」收掉嵌入块的 CAD 工具条。
 *   因为 /lite 与 /cad/ **同源**，播种把「页签直连 /cad/」和「浏览器直连 /cad/」
 *   也一起改了，而且**持久化**。改回纯 CSS 只止住了新污染，**旧脏值不会自己消失**。
 *   ⇒ 由 /cad/ 反代注入一段一次性脚本，把**我们当初改过的那 8 个键删掉**。
 *
 * ★ 本测试只读后端源码（tools/ref/cad.patched.py），不碰网络。
 *   锁住六件事：
 *     A. 常量与注入点都在
 *     B. 只清那 8 个 isShow* 键（不能变成「整体清空」）
 *     C. 用 delete 回落默认值，**不能**写 true（会凭空多出图元信息/性能面板）
 *     D. 有一次性闸 —— 否则用户自己关掉工具条会被反复清回来
 *     E. _inject_unpoison 的三个守卫：仅 HTML / 需 </body> / 已注入不重复
 *     F. proxy_cad 里真的把它用上了，且注入失败要退回原始字节
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const CANDIDATES = [
  path.join(ROOT, "tools/ref/cad.patched.py"),
  path.join(ROOT, "tools/ref/cad.py"),
];

let SRC = null, USED = null;
for (const p of CANDIDATES) {
  if (fs.existsSync(p)) { SRC = fs.readFileSync(p, "utf8"); USED = p; break; }
}

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log("  ✅ " + name); pass++; }
  catch (e) { console.log("  ❌ " + name + "\n       " + e.message); fail++; }
};

console.log("【/cad/ 反代「一次性解污染」契约】");

if (!SRC) {
  console.log("  ⚠️ 未找到参考文件（tools/ref/cad.patched.py）—— 跳过");
  console.log("\n通过 0 / 失败 0");
  process.exit(0);
}
console.log("  · 使用参考文件：" + path.relative(ROOT, USED));

/** 取 _CAD_UNPOISON_JS 这段 JS 字符串字面量 */
function jsBlock() {
  const i = SRC.indexOf("_CAD_UNPOISON_JS = ");
  assert.ok(i >= 0, "缺 _CAD_UNPOISON_JS 常量");
  const a = SRC.indexOf('"""', i), b = SRC.indexOf('"""', a + 3);
  assert.ok(a > 0 && b > a, "_CAD_UNPOISON_JS 不是三引号字符串");
  return SRC.slice(a, b);
}

check("A 常量与注入函数都在", () => {
  assert.ok(/_CAD_UNPOISON_MARK\s*=\s*"nb-cad-unpoison"/.test(SRC),
    "缺 _CAD_UNPOISON_MARK = \"nb-cad-unpoison\"（幂等判据要用它）");
  assert.ok(/def _inject_unpoison\(/.test(SRC), "缺 _inject_unpoison() 实现");
  assert.ok(/<script id="%s">/.test(jsBlock()), "注入的 <script> 没有 id（无法自证是否已注入）");
});

check("B 只清那 8 个 isShow* 键，不是整体清空", () => {
  const js = jsBlock();
  const must = ["isShowStats", "isShowCommandLine", "isShowEntityInfo", "isShowRibbon",
                "isShowToolbar", "isShowShortCutToolbar", "isShowCoordinate",
                "isShowLanguageSelector"];
  for (const k of must) assert.ok(js.includes('"' + k + '"'), `清理名单里少了 ${k}`);
  // 反面：绝不能出现 localStorage.removeItem(KEY) / clear() —— 那会把用户的
  //       字体映射、捕捉模式、主题等一起清掉
  assert.ok(!/removeItem\s*\(\s*KEY\s*\)/.test(js), "出现了 removeItem(KEY) —— 会连用户其它设置一起删");
  assert.ok(!/localStorage\.clear\s*\(/.test(js), "出现 localStorage.clear() —— 会清掉整站设置");
  // 必须只对名单里、且值恰好为 false 的键动手
  assert.ok(/hasOwnProperty\.call\(\s*o\s*,\s*k\s*\)/.test(js) || /hasOwnProperty\(k\)/.test(js),
    "没有 hasOwnProperty 守卫 —— 会误删不存在/继承来的键");
  assert.ok(/o\[k\]\s*===\s*false/.test(js), "没有 `o[k] === false` 判据 —— 会删掉用户主动设的值");
});

check("C 用 delete 回落默认值，不能写 true", () => {
  const js = jsBlock();
  assert.ok(/delete\s+o\[k\]/.test(js),
    "没有 `delete o[k]` —— 必须是「删掉 → 用查看器默认值」，不是写死某个值");
  // 反面：绝不允许把 isShow* 写成 true
  for (const k of ["isShowRibbon", "isShowToolbar", "isShowCommandLine", "isShowShortCutToolbar"]) {
    const re = new RegExp(k + '"[^\\n]*=\\s*true');
    assert.ok(!re.test(js), `${k} 被写成 true —— 图元信息/性能面板之类的默认值会被顶掉`);
  }
});

check("D 有一次性闸 nb.cad.unpoison.v1", () => {
  const js = jsBlock();
  assert.ok(/nb\.cad\.unpoison\.v1/.test(js), "缺一次性闸 key");
  assert.ok(/if\s*\(\s*ls\.getItem\(GUARD\)\s*\)\s*return/.test(js),
    "闸没有生效（缺少「已跑过就直接 return」）—— 用户自己关掉工具条会被反复清回来");
  assert.ok(/ls\.setItem\(GUARD/.test(js), "没有把闸写回 localStorage");
});

check("E _inject_unpoison 的三个守卫（仅 HTML / 需 </body> / 不重复注入）", () => {
  const i = SRC.indexOf("def _inject_unpoison(");
  assert.ok(i > 0, "缺 _inject_unpoison");
  const seg = SRC.slice(i, SRC.indexOf("\n@router", i) > 0 ? SRC.indexOf("\n@router", i) : i + 1200);
  assert.ok(/text\/html/.test(seg), "没有 content-type 守卫 —— 会对 JS/CSS 也做 replace");
  assert.ok(/b"<\/body>"\s+not\s+in\s+content/.test(seg), "没有 </body> 守卫");
  assert.ok(/_CAD_UNPOISON_MARK\.encode\(\)\s+in\s+content/.test(seg),
    "没有「已注入就跳过」守卫 —— 会重复注入");
  // ★ 不能用 [^)]* —— 第二个参数里有 _CAD_UNPOISON_JS.encode("utf-8")，
  //   它自己带括号，[^)]* 会在那里就停住 ⇒ 假红（踩过一次）。
  assert.ok(/\.replace\([\s\S]*?,\s*1\s*\)/.test(seg),
    "replace 没有限定次数 1 —— 有多个 </body> 时会插多次");
});

check("F proxy_cad 用上了它，且注入失败要退回原始字节", () => {
  const i = SRC.indexOf("async def proxy_cad(");
  assert.ok(i > 0, "缺 proxy_cad");
  const seg = SRC.slice(i);
  assert.ok(/_inject_unpoison\(/.test(seg), "proxy_cad 里没有调用 _inject_unpoison");
  assert.ok(/r\.status_code\s*==\s*200/.test(seg), "没有 status_code==200 守卫");
  assert.ok(/except\s+Exception\s*:\s*\n\s*content\s*=\s*r\.content/.test(seg),
    "注入失败没有回退到原始字节 —— 反代报错会直接把页面搞挂");
  // content-length / content-encoding 必须已被剔除，否则改长度会错位
  assert.ok(/"content-encoding",\s*"content-length"/.test(SRC),
    "没有剔除 content-length/content-encoding —— 改写后长度对不上会截断");
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

/* 行为级验证：菜单到底能不能弹出来（用户报「点开什么都不显示」）
 *
 * 为什么需要这个测试：
 *   `_sim-embed-contract.cjs` 的 K7 组是**静态文本断言** —— 它只能证明
 *   「源码里写了 open」，不能证明「调用后菜单真的会显示」。
 *   「静态断言通过 ≠ 运行正确」是本项目踩过多次的坑。
 *
 * 做法：
 *   1) 从**构建产物** dist/index.js 里抽出真实的 openMenuAt / menuAnchor 函数体
 *      （不是抄一份，是抽真的 —— 抄一份就变成测自己写的副本了）
 *   2) 按实测结果造假 Menu。★ 这里曾经假错过，务必看清两个类 ★
 *
 *      ── 类 A：内部菜单（window.siyuan.menus.menu 的类，bundle 里叫 te）──
 *         24 个方法：popup / addItem / append / remove / removeImmediately / …
 *         **有 popup，没有 open，也没有 addSeparator**
 *
 *      ── 类 B：插件 API 包装类（main.<hash>.js 模块 6959 导出 W）──
 *         ★ 插件 `require("siyuan").Menu` 拿到的就是这个 ★
 *         只有 6 个公开方法：addItem / addSeparator / showSubMenu /
 *         **open** / fullscreen / close
 *         open(c){ this.isOpen || this.menu.popup(c) }   ← 内部才去调 A 的 popup
 *         **有 open，反而没有 popup**
 *         构造函数默认 `this.menu = window.siyuan.menus.menu`（复用共享单例）
 *
 *      ⇒ 早前本文件把 B 当成 A 来造假菜单（「只有 popup，无 open」），
 *        于是得出「旧写法 menu.open 必然抛 TypeError」——**那是错的**。
 *        现在按 B 的真实形状造，并把真相反过来钉住（用例 2）。
 *
 *   3) 调用 openMenuAt(fakeMenu, fakeEv)，断言：
 *        - 菜单容器上的 "fn__none" 被移除（= 真的显示了）
 *        - 入参是 {x, y, h}
 *   4) 反向 / 优先级：
 *        - 对象**同时**有 open 和 popup → 必须走 **open**（行为级钉住优先级）
 *        - 只有 popup（类 A 形状）→ 仍能开（兜底分支有效）
 *        - 两个都删掉 → 必须走告警分支，而不是静默
 *
 * ★ 注意：本测试读的是**产物** dist/index.js，不是源码 src/ ★
 *   改了 src 之后必须先 `node tools/build.js --repo` 再跑本测试，
 *   否则测的是旧产物（假绿）。做反向注入验证时也应注入**产物**，
 *   或改完 src 后重建 —— 否则断言不会变红。
 *   这是刻意的：用户实际运行的是产物，产物才是真相。
 *
 * 用法：node tools/_sim-menu-open-behavior.cjs [bundle.js]
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DIST = process.argv[2] || path.join(ROOT, "dist", "index.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  \u2705 " + msg); }
  else { fail++; console.log("  \u274c " + msg); }
}

const src = fs.readFileSync(DIST, "utf8");

console.log("=".repeat(58));
console.log("行为级：菜单显示入口（openMenuAt）—— 直接跑真函数");
console.log("=".repeat(58));

/* ---- 1. 抽出真实的 openMenuAt 与 menuAnchor 函数体 ---- */
function extractFn(name) {
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1; // 指向 '{'
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j], p = src[j - 1], n = src[j + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; j++; } continue; }
    if (inStr) { if (c === inStr && p !== "\\") inStr = null; continue; }
    if (c === "/" && n === "/") { inLine = true; j++; continue; }
    if (c === "/" && n === "*") { inBlock = true; j++; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  return null;
}

const fnOpen = extractFn("openMenuAt");
const fnAnchor = extractFn("menuAnchor");
ok(!!fnOpen, "从产物抽出真实的 openMenuAt（非副本）");
ok(!!fnAnchor, "从产物抽出真实的 menuAnchor");

if (!fnOpen || !fnAnchor) {
  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(1);
}
console.log("  \u2139\ufe0f  openMenuAt 函数体 " + fnOpen.length + " 字符");

/* ---- 2. 组装沙箱：注入 showToast / console，执行两个真函数 ---- */
function buildScope(logs, toasts) {
  const sandbox = {
    console: {
      log: (...a) => logs.push(["log", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
    },
    showToast: (m) => toasts.push(m),
    Object, Math, JSON, String, Number, Boolean, Array, Error, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(fnAnchor, sandbox);
  vm.runInContext(fnOpen, sandbox);
  return sandbox;
}

/* ---- 3. 按**实测结果**造假 Menu（两个类都造得出来）----
 *
 * kind:
 *   "B"    插件 API 包装类 —— **真实形状**：有 open / addSeparator / addItem，
 *          无 popup；open(c) 内部调 this.menu.popup(c)（this.menu = 内部类 A）
 *   "A"    内部菜单类 —— 有 popup，无 open
 *   "both" 两个方法都有（用来验证**优先级**：必须走 open）
 *   "none" 两个都没有（验证告警分支）
 */
function makeMenu(kind, shown) {
  // ---- 内部类 A（B 的 this.menu 指向它的实例）----
  const protoA = {
    popup(T) {                       // ★ 照抄 bundle：这一句才让菜单可见
      this.position = T; shown.pos = T; shown.visible = true; shown.viaPopup = true;
      this.element.classList.remove("fn__none");
      return this;
    },
    setPopupPosition() {}, addItem() { return this; }, append() { return this; },
    remove() { return this; }, removeImmediately() { return this; },
    showSubMenu() { return this; }, resetPosition() {}, fullscreen() { return this; },
    closeSheet() { return this; }, updateMaxHeight() {}, emitCommonMenu() {},
  };
  const mkEl = () => ({
    classList: {
      _s: new Set(["fn__none"]),
      remove(c) { this._s.delete(c); },
      add(c) { this._s.add(c); },
      contains(c) { return this._s.has(c); },
    },
  });
  const innerA = Object.create(protoA);
  innerA.element = mkEl();

  const menu = {};
  menu.element = innerA.element;
  menu.menu = innerA;                 // B 的属性：指向内部实例

  if (kind === "B" || kind === "both") {
    // ---- 包装类 B 的公开方法（只有 6 个）----
    menu.addItem = function () { return this; };
    menu.addSeparator = function () { return this; };
    menu.showSubMenu = function () { return this; };
    menu.fullscreen = function () { return this; };
    menu.close = function () { return this; };
    menu.open = function (T) {        // open(c){ this.isOpen || this.menu.popup(c) }
      shown.openCalled = true;
      if (this.isOpen) return;
      return this.menu.popup(T);      // ★ 真实实现就是委派给 A 的 popup
    };
  }
  if (kind === "both") {
    // 同对象上再放一个 popup，用来验证 openMenuAt 到底先试哪个
    menu.popup = function (T) {
      shown.popupCalledDirectly = true;
      shown.pos = T; shown.visible = true;
      this.element.classList.remove("fn__none");
      return this;
    };
  }
  if (kind === "A") {
    // 内部类形状（没有 open / addSeparator）
    Object.assign(menu, {
      popup: function (T) {
        shown.popupCalledDirectly = true;
        this.element.classList.remove("fn__none");
        this.position = T; shown.pos = T; shown.visible = true;
        return this;
      },
      addItem: function () { return this; },
    });
  }
  return menu;
}

function makeEv() {
  return {
    clientX: 100, clientY: 200,
    target: {
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 24, height: 24, right: 124, bottom: 224 }),
    },
    currentTarget: {
      getBoundingClientRect: () => ({ left: 100, top: 200, width: 24, height: 24, right: 124, bottom: 224 }),
    },
    preventDefault() {}, stopPropagation() {},
  };
}

/* ---- 用例 1：★ 真实插件 API 形状（包装类 B：有 open，无 popup）---- */
console.log("\n【1】真实插件 API 形状：包装类 B（有 open，无 popup）");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("B", shown);
  ok(typeof menu.open === "function" && typeof menu.popup === "undefined",
     "造假对象符合实测：有 open、**没有** popup（这就是 B）");
  ok(typeof menu.addSeparator === "function",
     "B 有 addSeparator（内部类 A 没有；这条正是判定我们用 B 的独立证据）");
  let threw = null;
  try { sb.openMenuAt(menu, makeEv()); } catch (e) { threw = e; }
  ok(!threw, "openMenuAt 不抛异常");
  ok(shown.visible === true, "★★ 菜单真的显示了（open → 内部 popup → 摘掉 fn__none）");
  ok(shown.openCalled === true, "★ 走的是 open 分支（B 的公开入口）");
  ok(shown.pos && typeof shown.pos.h === "number",
     "入参含 h=" + (shown.pos && shown.pos.h) + "（思源用它算向上/向下翻转）");
  ok(shown.pos && shown.pos.x === 100 && shown.pos.y === 200,
     "入参坐标正确 ({x:100, y:200})");
  ok(logs.filter(l => l[0] === "error").length === 0, "无 error 日志");
}

/* ---- 用例 1b：★ 优先级 —— 两个方法都在时必须走 open ★ ---- */
console.log("\n【1b】优先级：对象同时有 open 和 popup ⇒ 必须走 open");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("both", shown);
  ok(typeof menu.open === "function" && typeof menu.popup === "function",
     "造假对象两个方法都有");
  let threw = null;
  try { sb.openMenuAt(menu, makeEv()); } catch (e) { threw = e; }
  ok(!threw, "不抛异常");
  ok(shown.openCalled === true, "★★ 调用了 open（优先级正确）");
  ok(shown.popupCalledDirectly !== true,
     "★★ 没有直接调 popup —— 证明 open 排在前面，不是靠 popup 抢先");
  ok(shown.visible === true, "菜单显示了");
}

/* ---- 用例 2：★ 反过来的真相：旧写法 menu.open(...) 在 B 上**合法** ---- */
//
//  这条曾经写反过：早前以为「B 没有 open ⇒ 旧代码抛 TypeError ⇒ 这是根因」。
//  实测（调用栈 + B 的源码）证明 B **有 open**，所以旧写法本来就能用。
//  用户那个 bug 的**唯一根因**是按钮缺 data-menu="true"（见 K7g 组）。
//  这条用例把真相钉住，免得以后有人再去"修"一个不存在的问题。
console.log("\n【2】真相：旧写法 menu.open(menuAnchor(ev)) 在插件 API（B）上是合法的");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("B", shown);   // 真实的插件 API 形状
  let threw = null, msg = "";
  try {
    // 这就是旧产物在 7383 / 7480 行做的事
    menu.open(sb.menuAnchor(makeEv()));
  } catch (e) { threw = e; msg = e.message; }
  ok(!threw, "★ 旧写法**不抛异常**（" + (threw ? "实际:" + msg : "确认无异常") + "）");
  ok(shown.visible === true, "★★ 旧写法本来就能让菜单显示 ⇒ 「Menu 没有 open」是被证伪的误判");
  ok(shown.popupCalledDirectly !== true, "旧写法走的是 open → 内部 popup（与实测调用栈一致）");
}

/* ---- 用例 3：兜底分支 —— 只有 popup 的对象（内部类 A 形状）---- */
console.log("\n【3】兜底：对象只有 popup、没有 open（内部类 A 的形状）");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("A", shown);
  ok(typeof menu.open === "undefined", "造假对象没有 open");
  let threw = null;
  try { sb.openMenuAt(menu, makeEv()); } catch (e) { threw = e; }
  ok(!threw, "openMenuAt 不抛异常（兜底分支生效）");
  ok(shown.visible === true, "菜单仍然打开了（走 popup 兜底）");
  ok(shown.popupCalledDirectly === true, "确实是走 popup 打开的");
}

/* ---- 用例 4：两者都无 → 必须告警，不能静默 ---- */
console.log("\n【4】异常版本：Menu 既无 popup 也无 open");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("none", shown);
  let threw = null;
  try { sb.openMenuAt(menu, makeEv()); } catch (e) { threw = e; }
  ok(!threw, "不抛异常（失败要可诊断，不是崩溃）");
  const errs = logs.filter(l => l[0] === "error");
  ok(errs.length === 1, "打了一条 console.error（" + errs.length + " 条）");
  ok(/没有 popup|既没有/.test(errs[0] ? errs[0][1] : ""), "错误信息指出了原因");
  ok(/实例方法：/.test(errs[0] ? errs[0][1] : ""), "错误信息列出了实际方法（便于定版本）");
  ok(toasts.length === 1, "给了用户可见的 toast（不是只在控制台）");
}

/* ---- 用例 5：坐标 h 缺失时的防御 ---- */
console.log("\n【5】坐标兜底：锚点拿不到 rect 时 h 不能为 undefined");
{
  const logs = [], toasts = [], shown = { visible: false, pos: null };
  const sb = buildScope(logs, toasts);
  const menu = makeMenu("A", shown);
  const ev = {
    clientX: 5, clientY: 6,
    target: { getBoundingClientRect: () => { throw new Error("detached"); } },
    currentTarget: null,
  };
  let threw = null;
  try { sb.openMenuAt(menu, ev); } catch (e) { threw = e; }
  ok(!threw, "不抛异常（目标元素已脱离 DOM 也要能开菜单）");
  ok(shown.visible === true, "菜单仍然打开");
  ok(shown.pos && typeof shown.pos.h === "number" && shown.pos.h > 0,
     "h 有正数兜底，实际 h=" + (shown.pos && shown.pos.h));
}

console.log("\n" + "=".repeat(58));
console.log("结果: " + pass + " 通过, " + fail + " 失败");
console.log("=".repeat(58));
process.exit(fail === 0 ? 0 : 1);

/**
 * CAD 查看器 UI 机制分析：这些「编辑栏 / 菜单栏 / 工具条」到底怎么实现的、受什么控制。
 *
 * 输入：已拉到本地的 chunk（_nas-src/）
 * 输出：_ui-mech.txt
 *
 * 分析维度：
 *   1. 所有 Vue 组件名（__name:"Xxx"）—— 找 MlRibbon / MlMenuBar / MlCommandLine 之类
 *   2. 所有 isShow* 开关 + 各自门控了什么（±260 字符上下文）
 *   3. 所有 ml-* 类名清单（频次）
 *   4. 菜单相关关键字命中（menu / menubar / ribbon / cli / toolbar）
 */
const fs = require("fs");
const path = require("path");

const FILES = [
  "cad-viewer-BAlsMkgn.js",
  "cad-simple-viewer-A2Zqm7aO.js",
  "cad-main.js",
];

const out = [];
const P = (s) => out.push(s);

for (const f of FILES) {
  const p = path.join(__dirname, "_nas-src", f);
  if (!fs.existsSync(p)) { P("### 缺文件: " + f); continue; }
  const s = fs.readFileSync(p, "utf8");
  P("\n\n############################################################");
  P("### " + f + "   (" + s.length + "B)");
  P("############################################################");

  // 1) 组件名
  const names = new Set();
  let m;
  const reName = /__name:"([A-Za-z0-9_]+)"/g;
  while ((m = reName.exec(s))) names.add(m[1]);
  P("\n== 组件名(" + names.size + ") ==");
  P([...names].sort().join(", "));

  // 2) isShow* 开关
  const switches = new Set();
  const reSw = /isShow[A-Za-z]+/g;
  while ((m = reSw.exec(s))) switches.add(m[0]);
  P("\n== isShow* 开关(" + switches.size + ") ==");
  for (const k of [...switches].sort()) {
    const cnt = (s.match(new RegExp(k, "g")) || []).length;
    // 抓第一处上下文（优先带 v-if / ? 的）
    let idx = -1;
    const re2 = new RegExp(k, "g");
    let mm;
    while ((mm = re2.exec(s))) {
      const ctx = s.slice(mm.index, mm.index + 160);
      if (/isShow/.test(ctx) && (/\?|&&|\|\|/.test(ctx))) { idx = mm.index; break; }
      if (idx < 0) idx = mm.index;
    }
    const ctx = idx >= 0 ? s.slice(Math.max(0, idx - 120), idx + 160).replace(/\s+/g, " ") : "";
    P("  · " + k.padEnd(26) + " ×" + String(cnt).padEnd(4) + "  " + ctx.slice(0, 230));
  }

  // 3) ml-* 类名
  const cls = new Map();
  const reCls = /class:"(ml-[a-zA-Z0-9_ -]+)"/g;
  while ((m = reCls.exec(s))) {
    const k = m[1].trim();
    cls.set(k, (cls.get(k) || 0) + 1);
  }
  P("\n== class:\"ml-*\" 类名(" + cls.size + ") ==");
  P([...cls.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + "×" + v).join("\n"));

  // 4) 关键字
  P("\n== 关键字命中 ==");
  for (const kw of ["menuBar", "MlMenu", "ml-menu", "ribbon", "Ribbon", "commandLine", "CommandLine",
                    "cli-", "shortcutToolbar", "ShortcutToolbar", "ex-ui-toolbar", "editor-bar", "editorBar"]) {
    const n = (s.match(new RegExp(kw, "g")) || []).length;
    if (n) P("  " + kw.padEnd(18) + " ×" + n);
  }
}

fs.writeFileSync(__dirname + "/_ui-mech.txt", out.join("\n"), "utf8");
console.log("ok");

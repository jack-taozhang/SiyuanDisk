/**
 * 在本地 chunk 里定位状态栏结构，回答：
 *   「v2 的 [class*='status-bar'] 会不会把布局页签一起藏掉？」
 * 用法: node _sb.cjs
 */
const fs = require("fs");
const P = __dirname + "/_nas-src/cad-viewer-BAlsMkgn.js";
const s = fs.readFileSync(P, "utf8");
const out = [];
const P_ = (x) => out.push(x);

P_("chunk bytes = " + s.length);

// 1) ml-status-bar 节点附近（含 class 定义）
const marks = ["ml-status-bar-left", "ml-status-bar-right-button-group", "ml-status-bar\""];
for (const m of marks) {
  const i = s.indexOf(m);
  P_("\n===== " + m + "  idx=" + i + " =====");
  if (i >= 0) P_(s.slice(Math.max(0, i - 900), i + 900));
}

// 2) 布局页签：找 layout 相关 class
P_("\n===== layout 相关 class =====");
const re = /class:"([^"]*layout[^"]*)"/gi;
const found = new Set();
let m2;
while ((m2 = re.exec(s))) found.add(m2[1]);
P_([...found].join("\n") || "（无）");

// 3) isShowCoordinate 用法
P_("\n===== isShowCoordinate 出现次数 =====");
P_(String((s.match(/isShowCoordinate/g) || []).length));
const i3 = s.indexOf("isShowCoordinate");
P_(s.slice(Math.max(0, i3 - 400), i3 + 400));

fs.writeFileSync(__dirname + "/_sb.txt", out.join("\n"), "utf8");
console.log("ok");

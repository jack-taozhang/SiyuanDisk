/** 确认 .ml-layout-tabs 是否在 status-bar-left 里 */
const fs = require("fs");
const s = fs.readFileSync(__dirname + "/_nas-src/cad-viewer-BAlsMkgn.js", "utf8");
const out = [];
const P = (x) => out.push(x);

for (const key of ['class:"ml-layout-tabs"', 'ml-layout-tabs-list', 'mke=jt']) {
  const i = s.indexOf(key);
  P("\n===== " + key + "  idx=" + i + " =====");
  if (i >= 0) P(s.slice(Math.max(0, i - 700), i + 700));
}

// 左槽位用的组件名
const i2 = s.indexOf('{class:"ml-status-bar-left"}');
P("\n===== status-bar-left 前后 =====");
if (i2 >= 0) P(s.slice(i2 - 300, i2 + 900));

fs.writeFileSync(__dirname + "/_sb2.txt", out.join("\n"), "utf8");
console.log("ok");

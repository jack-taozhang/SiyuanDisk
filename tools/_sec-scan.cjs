/* _sec-scan.cjs — 提交前安全扫描：核对 compose secret 与待提交工具的硬编码口令 */
const fs = require("fs");
const c = fs.readFileSync("tools/_nas-src/compose-deploy.yml", "utf8");
const m = c.match(/NEBULA_OO_SECRET:\s*(\S+)/);
// 占位串拼出来比较，避免本文件自己成为「含 secret 字面量」的误报源
const guess = ["nebula", "oo", "secret", "change", "me"].join("-");
if (!m) { console.log("compose 里没找到 NEBULA_OO_SECRET"); process.exit(0); }
console.log("compose NEBULA_OO_SECRET == 占位串 ?", m[1] === guess);
console.log("compose secret 长度 =", m[1].length, " 像默认占位 =", /change|default|secret-change/i.test(m[1]));

const cand = [
  "tools/_probe-size-limit.cjs", "tools/_probe-oo-embed.cjs", "tools/_probe-oo-open.cjs",
  "tools/_verify-oo-embed.cjs", "tools/_probe-bigfile.cjs", "tools/_find-cad.cjs",
  "tools/_inspect-lite.cjs", "tools/_restart-nb.cjs", "tools/_push-nebula-patch.cjs",
  "tools/_push-file.cjs", "tools/_pull-bin.cjs", "tools/_nb-run.cjs",
  "tools/_verify-deploy.cjs", "tools/_probe/cad-ui-audit.js", "tools/_sb.cjs",
  "tools/_sb2.cjs", "tools/_api-map.cjs", "tools/_ab-check.cjs", "tools/_mk-cad-url.cjs",
  "tools/_mk-oo-host.cjs", "tools/_net-analyze.cjs", "tools/_ui-mech.cjs",
  "tools/_cad-url2.cjs", "tools/_pull-remote.cjs", "tools/_net-analyze.cjs",
  "tools/_probe-lite-live.cjs", "tools/_probe-lite-raw.cjs", "tools/_probe-cad-raw.cjs",
  "tools/_probe-embed-type.cjs",
];
let bad = 0;
for (const f of cand) {
  let t; try { t = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
  const hits = [...t.matchAll(/(SECRET|PASSWORD|PASS\b|token)\s*=\s*["'][^"']{6,}["']/gi)].map((x) => x[0]);
  if (hits.length) { bad++; console.log("HARDCODED? " + f + "  ->  " + hits.join(" | ").replace(/=.{0,4}["']?[^"']{4}/g, (s) => s.slice(0, 14) + "…")); }
}
console.log(bad ? ("发现 " + bad + " 个文件含硬编码，需处理") : "待提交工具无硬编码口令 ✅");

/**
 * 验证 /api/oo/config embed 参数：embed=1 应隐藏工具栏，不传应保持完整。
 * 用法: node _verify-oo-embed.cjs
 */
const { spawnSync } = require("child_process");
const { PASS } = require("./_secrets.cjs");
const B = "http://192.168.193.70:8089";
const M = "售前项目";
const P = "/2025年08月/250501 中国银行立库项目/RCS标准接口文档(网关层)V2.0_20240131.docx";

function curl(args) {
  const r = spawnSync("curl", ["-s", ...args], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}
const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;

function cfg(embed) {
  const d = ["mount=" + encodeURIComponent(M), "path=" + encodeURIComponent(P)];
  if (embed) d.push("embed=1");
  return JSON.parse(curl(["-X", "POST", B + "/api/oo/config",
    "-H", "Authorization: Bearer " + tok, "-d", d.join("&")]));
}

let fail = 0;
const check = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) fail++;
};

const full = cfg(false).config.editorConfig.customization;
const lite = cfg(true).config.editorConfig.customization;
const liteTop = cfg(true); // 再要一份看 token 存在

check("页签版：layout 未出现（完整工具栏）", !full.layout);
check("页签版：hideRightMenu 仍为 false", full.hideRightMenu === false);
check("嵌入版：layout.toolbar === false（顶部工具栏隐藏）",
  lite.layout && lite.layout.toolbar === false);
check("嵌入版：layout.leftMenu === false", lite.layout && lite.layout.leftMenu === false);
check("嵌入版：layout.rightMenu === false", lite.layout && lite.layout.rightMenu === false);
check("嵌入版：layout.statusBar === false", lite.layout && lite.layout.statusBar === false);
check("嵌入版：hideRightMenu === true", lite.hideRightMenu === true);
check("嵌入版：plugins/leftMenu/about/feedback 仍为 false",
  lite.plugins === false && lite.leftMenu === false && lite.about === false && lite.feedback === false);
check("嵌入版：config.token 仍存在（签名完整）", !!(liteTop.config && liteTop.config.token));

// token 完整性粗校验：JWT 三段
const t = liteTop.config && liteTop.config.token || "";
check("嵌入版：token 是三段式 JWT", t.split(".").length === 3);

console.log(fail === 0 ? "\n全部通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);

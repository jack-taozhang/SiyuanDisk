/**
 * 生成一个最小 OnlyOffice 宿主页（复刻插件 renderOffice 的做法），
 * 用于在真实浏览器里复现「下载失败 / EMSGSIZE」。
 *
 * 用法: node _mk-oo-host.cjs "<mount>" "<path>" [embed]
 * 产出: tools/_oo-live/index.html
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PASS } = require("./_secrets.cjs");

const B = "http://172.16.30.128:8089";
const MOUNT = process.argv[2];
const FILEPATH = process.argv[3];
const EMBED = process.argv[4] === "embed";

function curl(a) {
  const r = spawnSync("curl", ["-s", ...a], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}

const tok = JSON.parse(curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)])).token;

const r = JSON.parse(curl(["-X", "POST", B + "/api/oo/config",
  "-H", "Authorization: Bearer " + tok,
  "-d", "mount=" + encodeURIComponent(MOUNT) + "&path=" + encodeURIComponent(FILEPATH) +
       (EMBED ? "&embed=1" : "")]));
if (!r.config) { console.error("取 config 失败:", JSON.stringify(r).slice(0, 300)); process.exit(1); }

const apiJs = r.apiJs || (r.apiJsUrl && r.apiJsUrl) || "";
const cfg = r.config;
cfg.events = {
  onError: (e) => { console.error("OO onError:", JSON.stringify(e)); document.title = "OO-ERROR:" + JSON.stringify(e && e.data); },
  onDocumentReady: () => { console.log("OO ready"); document.title = "OO-READY"; },
};

const dir = path.join(__dirname, "_oo-live");
fs.mkdirSync(dir, { recursive: true });
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>OO-LOADING</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#ph{width:100vw;height:100vh}</style>
<script src="${apiJs}"></script>
</head><body>
<div id="ph"></div>
<script>
window.__err=[];
window.addEventListener("error",e=>window.__err.push(String(e.message)));
try{
  new DocsAPI.DocEditor("ph", ${JSON.stringify(cfg)});
}catch(e){ window.__err.push("ctor:"+e.message); }
</script>
</body></html>`;
fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");

console.log("apiJs:", apiJs);
console.log("document.url:", cfg.document.url);
console.log("document.key:", cfg.document.key);
console.log("type:", cfg.type || "(默认 main)", " mode:", cfg.editorConfig.mode || "(无)");
console.log("已生成:", path.join(dir, "index.html"));

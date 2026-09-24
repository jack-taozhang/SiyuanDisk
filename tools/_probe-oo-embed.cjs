/**
 * 临时探针：实测 /api/oo/config 带/不带 embed 的 customization 差异。
 * 用法: node _probe-oo-embed.cjs
 */
const { spawnSync } = require("child_process");
const { PASS } = require("./_secrets.cjs");
const B = "http://172.16.30.128:8089";

function curl(args) {
  const r = spawnSync("curl", ["-s", ...args], { encoding: "utf8", maxBuffer: 1e8 });
  return r.stdout || "";
}

const login = curl(["-X", "POST", B + "/api/login",
  "-d", "username=tao_zhang&password=" + encodeURIComponent(PASS)]);
let tok = "";
try { const j = JSON.parse(login); tok = j.token || j.access_token || ""; } catch (e) {}
console.log("token len:", tok.length);
if (!tok) { console.log("login raw:", login.slice(0, 300)); process.exit(1); }

// 找一个 docx/xlsx 文件
const listing = curl(["-H", "Authorization: Bearer " + tok,
  B + "/api/list?mount=" + encodeURIComponent("售前项目") + "&path=/"]);
let found = null;
try {
  const j = JSON.parse(listing);
  const walk = (path, entries) => {
    for (const e of entries || []) {
      if (found) return;
      const p = e.path || (path + "/" + e.name);
      if (e.isDir) {
        if ((e.name || "").startsWith(".")) continue;
        const sub = curl(["-H", "Authorization: Bearer " + tok,
          B + "/api/list?mount=" + encodeURIComponent("售前项目") + "&path=" + encodeURIComponent(p)]);
        try { walk(p, JSON.parse(sub).entries); } catch (er) {}
      } else if (/\.(docx|xlsx|pptx|doc|xls|ppt)$/i.test(e.name || "")) {
        found = p;
      }
    }
  };
  walk("/", j.entries);
} catch (e) { console.log("list err:", e.message, listing.slice(0, 200)); }
console.log("office file:", found);
if (!found) process.exit(1);

function ooConfig(embed) {
  const d = ["mount=售前项目", "path=" + encodeURIComponent(found)];
  if (embed) d.push("embed=1");
  const raw = curl(["-X", "POST", B + "/api/oo/config",
    "-H", "Authorization: Bearer " + tok, "-d", d.join("&")]);
  try {
    const j = JSON.parse(raw);
    const c = j.config && j.config.editorConfig && j.config.editorConfig.customization;
    return { ok: j.ok, hasToken: !!(j.config && j.config.token), customization: c };
  } catch (e) { return { parseError: raw.slice(0, 300) }; }
}

console.log("\n=== 不带 embed（页签用） ===");
console.log(JSON.stringify(ooConfig(false), null, 1));
console.log("\n=== 带 embed=1（嵌入块用） ===");
console.log(JSON.stringify(ooConfig(true), null, 1));

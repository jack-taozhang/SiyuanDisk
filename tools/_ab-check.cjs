/** 拿 agent-browser 的完整命令表 */
const fs = require("fs");
const { spawnSync } = require("child_process");
const AB = "C:/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node_modules/agent-browser/bin/agent-browser-win32-x64.exe";
const r = spawnSync(AB, ["--help"], { encoding: "utf8", maxBuffer: 1e7, timeout: 30000 });
fs.writeFileSync(__dirname + "/_ab.txt", (r.stdout || "") + "\n[stderr]\n" + (r.stderr || ""), "utf8");

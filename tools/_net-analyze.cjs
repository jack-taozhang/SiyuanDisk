const fs = require("fs");
const t = fs.readFileSync("D:/Docker/_net.txt", "utf8");
const lines = t.split(/\r?\n/);
console.log("LINES", lines.length);
const pats = {
  "doc-path": /\/doc\//i,
  "socket.io": /socket\.io/i,
  "ws-scheme": /ws:\/\//i,
  coauthoring: /coauthoring/i,
  cmdservice: /CommandService/i,
  "nebula-raw": /8089\/api\/raw/i,
  xhr: /\(XHR\)/i,
  websocket: /\(WebSocket\)/i,
};
for (const k of Object.keys(pats)) {
  const h = lines.filter((l) => pats[k].test(l));
  console.log("--- " + k + " : " + h.length);
  h.slice(0, 6).forEach((l) => console.log("    " + l.slice(0, 220)));
}

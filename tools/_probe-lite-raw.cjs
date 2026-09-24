/**
 * 把线上 /lite?kind=cad 的**原始响应**存盘，便于逐字核对。
 * 用法: node _probe-lite-raw.cjs
 */
const http = require("http");
const fs = require("fs");

http.get("http://172.16.30.128:8089/lite?kind=cad&target=%2Fcad%2F", { timeout: 15000 }, (r) => {
  let b = "";
  r.setEncoding("utf8");
  r.on("data", (c) => (b += c));
  r.on("end", () => {
    fs.writeFileSync(__dirname + "/_lite-cad-live.html", b, "utf8");
    console.log("status=" + r.statusCode + " bytes=" + Buffer.byteLength(b));
    // 把 <script> 里的注入段摘出来看
    const i = b.indexOf("var SEL");
    console.log("SEL idx=" + i);
    if (i >= 0) console.log(b.slice(i, i + 200));
  });
}).on("error", (e) => console.log("ERR " + e.message));

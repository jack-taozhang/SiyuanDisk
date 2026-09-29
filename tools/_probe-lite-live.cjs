/**
 * 抓线上 /lite?kind=cad 的真实响应，验「CAD 预览到底靠什么收 UI」。
 * 本机直连 NAS 即可（无需 SSH）。
 * 用法: node _probe-lite-live.cjs
 */
const http = require("http");

const BASE = "http://192.168.193.70:8089";

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get(BASE + path, { timeout: 15000 }, (r) => {
      let b = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (b += c));
      r.on("end", () => res({ status: r.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", rej);
  });
}

(async () => {
  const out = [];
  const P = (s) => out.push(s);

  const r = await get("/lite?kind=cad&target=%2Fcad%2F");
  P("HTTP " + r.status + "  bytes=" + r.body.length);

  // 1) CSS 注入 marker
  const mv = /nb-cad-hide-v(\d+)/.exec(r.body);
  P("CSS marker        : " + (mv ? "nb-cad-hide-v" + mv[1] : "（无）"));

  // 2) 设置播种
  P("seed 函数存在     : " + /__nbSeedCad/.test(r.body));
  P("storageKey 出现   : " + /mlightcad\.settings\.cad-viewer/.test(r.body));
  P("isShowCommandLine : " + /isShowCommandLine/.test(r.body));
  P("isShowToolbar     : " + /isShowToolbar/.test(r.body));

  // 3) iframe 内注入的 style 元素 id
  P("注入 style id     : " + (/nb-lite-css/.test(r.body) ? "nb-lite-css ✅" : "（无）"));

  // 4) 顺序：seed 脚本 vs iframe
  const seedIdx = r.body.search(/__nbSeedCad|mlightcad\.settings\.cad-viewer/);
  const ifrIdx = r.body.indexOf("<iframe");
  P("iframe 位置       : " + ifrIdx);
  P("seed 位置         : " + seedIdx + (seedIdx < 0 ? "  → 线上没有播种" : seedIdx < ifrIdx ? "  → 在 iframe 之前 ✅" : "  → 在 iframe 之后 ❌"));

  // 5) 隐藏选择器清单
  const m = /var SEL=(\[.*?\]);/.exec(r.body);
  if (m) {
    try {
      const sels = JSON.parse(m[1]);
      P("隐藏选择器条数    : " + sels.length);
      P("  " + sels.join("\n  "));
    } catch (e) { P("SEL 解析失败: " + e.message); }
  } else {
    P("找不到 var SEL=");
  }

  // 6) 是否还留着旧的一组
  P("旧选择器 [class*='ml-compass'] : " + /ml-compass/.test(r.body));
  P("新选择器 .ml-cli-container     : " + /ml-cli-container/.test(r.body));
  P("新选择器 .ml-ui-shortcut-toolbar-shell : " + /ml-ui-shortcut-toolbar-shell/.test(r.body));
  P("新选择器 .ml-status-bar-right  : " + /ml-status-bar-right/.test(r.body));

  require("fs").writeFileSync(__dirname + "/_probe-lite-live.txt", out.join("\n"), "utf8");
  console.log(out.join("\n"));
})();

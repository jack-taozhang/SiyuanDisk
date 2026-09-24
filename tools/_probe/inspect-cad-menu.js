(function () {
  var V2 = ".ml-ui-simple-toolbar,.ml-ui-simple-toolbar__menu,[class*='simple-toolbar']," +
    "[class*='ml-ui-toolbar'],.ml-ui-panel,[class*='ml-ui-panel'],.ml-aci-loupe," +
    "[class*='ml-aci-loupe'],[class*='ml-polar-tra'],[class*='ml-compass'],[class*='ml-axis']," +
    "[class*='status-bar'],[class*='statusbar'],.ml-cad-header,.ml-ribbon-toolbar-container," +
    ".ml-ribbon,.ml-ribbon__header,.ml-ribbon__panel,.ml-cad-footer";

  var KEY = "mlightcad.settings.cad-viewer";
  var out = [];
  var L = function (s) { out.push(s); };

  function cls(e) {
    try { return (e.className || "").toString().replace(/\s+/g, " ").trim(); } catch (x) { return ""; }
  }
  function vis(e, doc) {
    var cs;
    try { cs = doc.defaultView.getComputedStyle(e); } catch (x) { return false; }
    if (!cs || cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    var r;
    try { r = e.getBoundingClientRect(); } catch (x) { return false; }
    return r.width >= 6 && r.height >= 6;
  }

  var fr = document.getElementById("nb-lite-frame");
  var doc = null;
  try { doc = fr ? fr.contentDocument : null; } catch (x) { doc = null; }
  L("innerDocReadable = " + !!doc);
  if (!doc || !doc.documentElement) return "ERROR: 拿不到 CAD iframe 文档";

  // ---- 1. 查看器设置（localStorage）----
  L("");
  L("### 1. 查看器设置 localStorage[" + KEY + "]");
  var raw = null;
  try { raw = doc.defaultView.localStorage.getItem(KEY); } catch (x) { raw = "ERR:" + x.message; }
  L("  top.localStorage 也查一遍:");
  var rawTop = null;
  try { rawTop = localStorage.getItem(KEY); } catch (x) { rawTop = "ERR:" + x.message; }
  L("    iframe(key) = " + raw);
  L("    top(key)    = " + rawTop);

  // ---- 2. 可见元素按「菜单/工具条特征」筛 ----
  L("");
  L("### 2. 仍然可见的 UI 元素（按位置/形状分类）");
  var els;
  try { els = doc.querySelectorAll("*"); } catch (x) { els = []; }
  var rows = [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var t = e.tagName;
    if (t === "CANVAS" || t === "HTML" || t === "BODY" || t === "PATH" || t === "svg" || t === "SPAN" || t === "svg" || t === "A") continue;
    if (!vis(e, doc)) continue;
    var r = e.getBoundingClientRect();
    var c = cls(e);
    var ratio = r.width / Math.max(1, r.height);
    var g = doc.defaultView.getComputedStyle(e);
    var geo = g.position + "/" + g.top + "," + g.left;
    var isMenuish = /ribbon|menu|toolbar|cli|header|footer|panel|status|tab/i.test(c);
    var shape = ratio > 6 ? "横条" : (ratio < 0.2 ? "竖条" : "");
    var m2 = "";
    try { m2 = e.matches(V2) ? "v2覆盖=是" : "v2覆盖=否"; } catch (x) { m2 = "v2覆盖=?"; }
    var txt = "";
    try { txt = (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40); } catch (x) { }
    var title = "";
    try { title = e.getAttribute("title") || e.getAttribute("aria-label") || ""; } catch (x) { }
    if (!isMenuish && !shape) continue;
    rows.push("  " + t + " [" + c + "]  " + Math.round(r.width) + "x" + Math.round(r.height) +
      "@" + Math.round(r.left) + "," + Math.round(r.top) + "  " + (shape || "-") + "  " + m2 +
      (title ? "  T:" + title : "") + (txt ? "  «" + txt + "»" : ""));
  }
  L("  候选行数 = " + rows.length);
  out = out.concat(rows);

  // ---- 3. 被 v2 藏掉的（对照组）----
  L("");
  L("### 3. 已被 v2 CSS 藏掉的（对照组，应不可见）");
  var ks = ["ml-ribbon", "ml-ribbon__header", "ml-ribbon-toolbar-container", "ml-cad-header",
            "ml-cad-footer", "ml-status-bar", "ml-status-bar-left", "ml-layout-tabs",
            "ml-ui-simple-toolbar", "ml-ui-panel"];
  for (var j = 0; j < ks.length; j++) {
    var n = 0, v = 0;
    var q;
    try { q = doc.querySelectorAll("." + ks[j]); } catch (x) { q = []; }
    for (var k = 0; k < q.length; k++) { n++; if (vis(q[k], doc)) v++; }
    L("  ." + ks[j] + "  节点=" + n + "  可见=" + v);
  }

  return out.join("\n");
})()

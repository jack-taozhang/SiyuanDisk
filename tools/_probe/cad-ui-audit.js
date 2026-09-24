(function () {
  var KEY = "mlightcad.settings.cad-viewer";
  var BLOCKS = [
    ["命令行", ".ml-cli-container"],
    ["顶部功能区", ".ml-ribbon"],
    ["功能区容器", ".ml-ribbon-toolbar-container"],
    ["cad-header", ".ml-cad-header"],
    ["右侧垂直工具栏", ".ml-ex-ui-toolbar"],
    ["右上角箭头", ".ml-ui-shortcut-toolbar-shell"],
    ["状态栏(整条)", ".ml-status-bar"],
    ["布局页签", ".ml-layout-tabs"],
    ["状态栏坐标", ".ml-status-bar-current-pos"],
    ["cad-footer", ".ml-cad-footer"]
  ];

  var out = [];
  var L = function (s) { out.push(s); };

  var fr = document.getElementById("nb-lite-frame");
  var doc = document;
  var where = "TOP(直连/页签)";
  if (fr) {
    try { if (fr.contentDocument && fr.contentDocument.documentElement) { doc = fr.contentDocument; where = "IFRAME(/lite 嵌入块)"; } } catch (x) { }
  }
  L("审计文档 = " + where);

  L("");
  L("### localStorage[" + KEY + "]");
  var vs = [];
  try { vs.push("  top        = " + localStorage.getItem(KEY)); } catch (e) { vs.push("  top ERR " + e.message); }
  try { vs.push("  audit-doc  = " + doc.defaultView.localStorage.getItem(KEY)); } catch (e) { vs.push("  audit-doc ERR " + e.message); }
  out = out.concat(vs);

  function vis(e) {
    var cs;
    try { cs = doc.defaultView.getComputedStyle(e); } catch (x) { return false; }
    if (!cs || cs.display === "none" || cs.visibility === "hidden") return false;
    var r;
    try { r = e.getBoundingClientRect(); } catch (x) { return false; }
    return r.width >= 6 && r.height >= 6;
  }

  L("");
  L("### UI 区块可见性（节点数 / 可见数）");
  var totalNodes = 0, totalVis = 0;
  for (var i = 0; i < BLOCKS.length; i++) {
    var name = BLOCKS[i][0], sel = BLOCKS[i][1];
    var q;
    try { q = doc.querySelectorAll(sel); } catch (x) { q = []; }
    var n = 0, v = 0, dims = "";
    for (var k = 0; k < q.length; k++) {
      n++;
      if (vis(q[k])) {
        v++;
        if (!dims) { var r = q[k].getBoundingClientRect(); dims = Math.round(r.width) + "x" + Math.round(r.height); }
      }
    }
    totalNodes += n; totalVis += v;
    L("  " + name.padEnd(14, " ") + " " + sel.padEnd(32, " ") + " 节点=" + n + "  可见=" + v + (dims ? "  " + dims : ""));
  }
  L("  ---- 合计: 节点=" + totalNodes + " 可见=" + totalVis);
  return out.join("\n");
})()

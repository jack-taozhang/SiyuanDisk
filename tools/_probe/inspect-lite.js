(function () {
  var out = [];
  function cls(e) {
    var c = "";
    try { c = e.className && e.className.toString ? e.className.toString() : ""; } catch (x) { }
    return c.replace(/\s+/g, " ").slice(0, 110);
  }
  function scan(doc, tag) {
    if (!doc) return;
    var els;
    try { els = doc.querySelectorAll("*"); } catch (x) { return; }
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (!e.tagName) continue;
      var cs;
      try { cs = doc.defaultView.getComputedStyle(e); } catch (x) { continue; }
      if (!cs) continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (cs.opacity === "0") continue;
      var r;
      try { r = e.getBoundingClientRect(); } catch (x) { continue; }
      if (r.width < 6 || r.height < 6) continue;
      var t = e.tagName;
      if (t === "CANVAS" || t === "HTML" || t === "BODY") continue;
      var c = cls(e);
      var txt = "";
      try { txt = (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 26); } catch (x) { }
      var title = e.getAttribute && (e.getAttribute("title") || e.getAttribute("aria-label") || e.getAttribute("data-tip") || "");
      if (!c && !title && t !== "BUTTON" && t !== "INPUT" && r.width * r.height < 2500) continue;
      out.push([
        tag, t, c,
        Math.round(r.width) + "x" + Math.round(r.height) +
        "@" + Math.round(r.left) + "," + Math.round(r.top),
        title ? "T:" + String(title).slice(0, 30) : "",
        txt
      ].join(" | "));
    }
    var subs;
    try { subs = doc.querySelectorAll("iframe"); } catch (x) { return; }
    for (var j = 0; j < subs.length; j++) {
      var sd = null;
      try { sd = subs[j].contentDocument; } catch (x) { sd = null; }
      scan(sd, tag + ">F" + j);
    }
  }
  var fr = document.getElementById("nb-lite-frame");
  scan(fr ? fr.contentDocument : document, "TOP");
  var uniq = {};
  var res = [];
  for (var k = 0; k < out.length; k++) { if (!uniq[out[k]]) { uniq[out[k]] = 1; res.push(out[k]); } }
  return "COUNT=" + res.length + "\n" + res.slice(0, 220).join("\n");
})()

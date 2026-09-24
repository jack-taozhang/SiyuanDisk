#!/bin/sh
J=/app/cad/assets/cad-viewer-BAlsMkgn.js
echo "== left half (grep -E) =="
docker exec cad-viewer sh -c "grep -oE '.{0,60}ml-status-bar-left.{0,500}' $J | head -3"
echo ""
echo "== 找布局页签关键字 =="
for k in Model Layout1 layoutName layout-tabs layoutTabs; do
  n=$(docker exec cad-viewer sh -c "grep -c '$k' $J")
  printf '%-12s : %s\n' "$k" "$n"
done
echo ""
echo "== around Layout1 =="
docker exec cad-viewer sh -c "grep -oE '.{0,150}Layout1.{0,250}' $J | head -3"
echo ""
echo "== done =="

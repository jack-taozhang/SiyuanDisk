/**
 * 清掉 nebula 容器里过期的 pages 字节码 + 重启 nebula + 抓线上 /lite 验证。
 * 全程自己落盘 _restart.txt。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { SUDO } = require("./_secrets.cjs");

const B = "http://172.16.30.128:8089";
const out = [];
const P = (s) => out.push(s);
const flush = () => fs.writeFileSync(path.join(__dirname, "_restart.txt"), out.join("\n"), "utf8");

function ssh(cmd) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "ssh-nb.cjs"), cmd],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { out: (r.stdout || "").trim(), code: r.status, err: (r.stderr || "").trim() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) 清过期 pyc（pages 与 cad 都要清：两边都改过）
  const rm = ssh(`${SUDO}docker exec nebula sh -c "rm -f /opt/nebula/app/routers/__pycache__/pages.cpython-*.pyc /opt/nebula/app/routers/__pycache__/cad.cpython-*.pyc; ls /opt/nebula/app/routers/__pycache__/ | grep -cE 'pages|cad' || echo 0"`);
  P("清 pages/cad pyc: " + (rm.out || "") + (rm.err ? "  [err] " + rm.err : ""));

  // 2) 重启 nebula
  const rs = ssh(`${SUDO}docker restart nebula`);
  P("restart: " + (rs.out || "") + "  exit=" + rs.code + (rs.err ? "  [err] " + rs.err : ""));

  // 3) 等起来
  for (let i = 1; i <= 20; i++) {
    await sleep(2000);
    try {
      const r = await fetch(B + "/healthz", { signal: AbortSignal.timeout(4000) });
      if (r.ok) { P("healthz OK @ " + i * 2 + "s  " + (await r.text()).slice(0, 200)); break; }
    } catch (e) { /* 还没起 */ }
    if (i === 20) P("!! healthz 20 次都没通");
  }

  // 4) 抓 /lite 验证
  const lr = await fetch(B + "/lite?kind=cad&target=%2Fcad%2F");
  const body = await lr.text();
  fs.writeFileSync(path.join(__dirname, "_lite-cad-live.html"), body, "utf8");
  P("");
  P("GET /lite?kind=cad  HTTP " + lr.status + "  bytes=" + Buffer.byteLength(body));
  P("  marker      : " + (((/nb-cad-hide-v(\d+)/.exec(body) || [])[1]) ? "v" + /nb-cad-hide-v(\d+)/.exec(body)[1] : "（无）"));
  // ★ v6：禁用任何 localStorage 写入 ★
  P("  localStorage 写入痕迹: " + (/localStorage/.test(body) ? "❌ 仍有 localStorage" : "✅ 无"));
  P("  __nbSeedCad : " + /__nbSeedCad/.test(body));
  P("  storageKey  : " + /mlightcad\.settings\.cad-viewer/.test(body));
  P("  isShowCommandLine: " + /isShowCommandLine/.test(body));
  P("  isShowToolbar    : " + /isShowToolbar/.test(body));
  P("  isShowShortCutToolbar: " + /isShowShortCutToolbar/.test(body));
  // ★ 五块 UI 的选择器都要在 ★
  P("  .ml-cli-container 选择器: " + /ml-cli-container/.test(body));
  P("  .ml-ribbon 选择器       : " + /ml-ribbon/.test(body));
  P("  .ml-ex-ui-toolbar 选择器: " + /ml-ex-ui-toolbar/.test(body));
  P("  .ml-ui-shortcut-toolbar-shell: " + /ml-ui-shortcut-toolbar-shell/.test(body));
  P("  .ml-status-bar 选择器   : " + /ml-status-bar/.test(body));
  P("  .ml-layout-tabs 选择器  : " + /ml-layout-tabs/.test(body));
  P("  笼统 [class*='status-bar']: " + /\[class\*='status-bar'\]/.test(body));
  const ifrIdx = body.indexOf("<iframe");
  const sIdx = body.indexOf("<script>(function(){");
  P("  顺序: iframe@" + ifrIdx + "  hideScript@" + sIdx + "  → " +
    (ifrIdx >= 0 && sIdx >= 0 && ifrIdx < sIdx ? "iframe 在脚本之前 ✅" : "❌ 顺序不对"));

  // 5) 抓 /cad/ 首页，验证「解污染」脚本已注入（且幂等）
  const cr = await fetch(B + "/cad/");
  const cbody = await cr.text();
  P("");
  P("GET /cad/  HTTP " + cr.status + "  bytes=" + Buffer.byteLength(cbody));
  P("  nb-cad-unpoison 注入: " + /nb-cad-unpoison/.test(cbody));
  P("  含 </body>          : " + /<\/body>/.test(cbody));
  P("  含 mlightcad.settings.cad-viewer: " + /mlightcad\.settings\.cad-viewer/.test(cbody));
  P("  含 nb.cad.unpoison.v1 闸        : " + /nb\.cad\.unpoison\.v1/.test(cbody));

  flush();
})();

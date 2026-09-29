/* 全量测试跑一遍，汇总通过/失败。
 * 用法: node tools/run-all-tests.cjs
 *
 * ★ 为什么要有这个脚本 ★
 *   测试分散在 test/（单元/集成）与 tools/（模拟器里的契约测试），
 *   之前每次都靠手写 for 循环拼命令，容易漏掉 tools/ 那几个
 *   （实测漏过一次：_sim-embed-contract.cjs 123 条断言整批没跑）。
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;

const SUITES = [
  // ★★ 第 0 道闸门：凭据泄漏 —— 放最前面，fail fast ★★
  //   理由：一旦命中「明文口令」，后面的测试跑得再绿也没意义 —— 这份代码不该被推出去。
  //   本项目真实踩过多次（一次 5 个脚本同时硬编码口令；2026-09-29 又 1 个）。
  //   它只把「明文口令」判为失败；机器专属路径只作警告（仓库里本来就有合法用法），
  //   详见 tools/check-secrets.cjs 顶部说明。
  ["tools/check-secrets.cjs", "★ 凭据闸门（明文口令）"],
  ["test/syntax.check.js", "静态检查（模块/导入/清单）"],
  ["test/proxy.test.js", "代理单元测试"],
  ["test/embed.test.js", "嵌入块单元测试"],
  ["test/e2e.test.js", "端到端集成（直连通道）"],
  // ★ 模拟「浏览器端思源」（NAS 场景，无 require/process/fs）。
  //   它锁的是**另一条通道**：浏览器端必须锁定直连、永不回退 127.0.0.1:6810；
  //   还管「容器内名 nebula:8088 → 浏览器可达主机」的改写、以及「打开网盘」深链。
  //   ★ 曾被漏挂在测试入口之外 —— 这类资产漏挂等于没有。
  ["tools/_sim-browser.cjs", "浏览器端直连通道 / 主机改写 / 打开网盘深链"],
  // ★ 回归：旧写法嵌入块（data-info 缺斜杠）的就地重绘。
  //   保护 migrateLegacyEmbeds 不因重构而失效——否则老笔记的嵌入块会退化成裸 JSON。
  ["tools/_sim-legacy-embed.cjs", "旧写法嵌入块就地重绘回归"],
  ["tools/_sim-embed-contract.cjs", "嵌入块契约模拟"],
  ["tools/_sim-embed-insert.cjs", "插入链路模拟"],
  ["tools/_sim-embed-syntax.cjs", "嵌入块语法模拟"],
  ["tools/_sim-embed-lookup.cjs", "嵌入块查找模拟"],
  ["tools/_sim-tasks-9-10-12.cjs", "⑨⑩⑫ 回归契约"],
  // ★ 渲染冒烟：把真实 bundle 当模块跑起来，断言真的渲染出搜索框/图标/网格行高。
  //   其它套件都是「源码文本静态断言」，证明不了运行时行为，所以这一套必要。
  //   缺 jsdom 时会自己跳过（输出「通过 0 失败 0」，不算失败）。
  ["tools/_sim-picker-render.cjs", "选择器搜索/网格图标渲染冒烟"],
  // ★ 任务20/26/27/28：菜单项增删 + 路径显示归一化。
  //   独立成一套，因为它横跨 tree/api/index/viewer/embed 五个文件，
  //   和上面的嵌入块契约关注点不同（那套管嵌入渲染，这套管菜单与路径文本）。
  ["tools/_sim-menu-path.cjs", "菜单/路径显示契约（任务20/26/27/28）"],
  // ★ 任务29：图标美化（网盘风格）。
  //   verify-icons 是「契约/行为」测试（vm 里真跑 typeIconEl，断言返回的是 SVG、配色正确）；
  //   reverse-icons 是「能否变红」测试（3 次注入各红一条，证明断言不是常绿）。
  ["test/verify-icons.cjs", "网盘风格图标契约（任务29）"],
  ["test/reverse-icons.cjs", "网盘风格图标 · 反向注入（任务29）"],
  // ★ 任务29 final：L11g 系列的注入测试（旧 symbol 移除 / _folderSvg / #e8a33d）。
  ["test/reverse-icons-contract.cjs", "图标契约 · 反向注入 L11g（任务29）"],
  // ★ 任务30 / #54 / #55：拖拽插入 + 网格面包屑。
  //   verify-drag-insert 用**真 DOM 桩**把 tree.js 跑起来，真的调 makeGridCell /
  //     makeResultRow / makeNode，断言返回元素上的 draggable/ondragstart ——
  //     因为任务30 的 bug 恰恰是「代码有、但只在 makeNode 里」，纯 grep 测不出。
  //   reverse-drag 负责证明上面每条断言都能被注入搞红（含产物级 DIST-*）。
  ["test/verify-drag-insert.cjs", "拖拽插入 + 网格面包屑契约（任务30/#54/#55）"],
  ["test/reverse-drag.cjs", "拖拽/面包屑 · 反向注入（任务30/#54/#55）"],
  // ★ 任务31(rev)：/lite CAD 播种（localStorage["mlightcad.settings.cad-viewer"]）。
  //   只读后端参考源码 tools/ref/pages.patched.py，锁住 storageKey / 设置项 / 顺序 / marker。
  ["test/verify-lite-cad.cjs", "/lite CAD 播种契约（任务31rev）"],
  // ★ #62：「在浏览器中打开」按类型选渲染通道。
  //   用户报障：CAD/OO/kk 全都变成**下载**，只有 PDF 正常。
  //   根因实测：/api/raw 是字节通道，Office/CAD 的 MIME 浏览器无渲染器 ⇒ 只能下载。
  //   verify 是契约测试，reverse 逐个注入证明每条契约都能变红。
  ["test/verify-t62-browser-open.cjs", "浏览器打开 · 类型路由契约（#62）"],
  ["test/reverse-t62-browser-open.cjs", "浏览器打开 · 反向注入（#62）"],
  // ★ #63/#64/#65：UI 密度收敛（picker 行高/宽度 + 侧栏结果路径不遮挡文件名）。
  ["test/verify-density.cjs", "UI 密度契约（#63/#64/#65）"],
  ["test/reverse-density.cjs", "UI 密度 · 反向注入（#63/#64/#65）"],
  // ★ #67：交付包自检 —— 这个 zip 包本身对不对（清单/产物/能被思源加载）。
  //   它需要一个「解压后的包目录」：优先本机思源安装位，没有就回退仓库 dist/。
  //   dist/ 里没有 plugin.json 的完整包形态时该套会自报缺失 —— 属正常，
  //   跑一次 `node tools/pack.js` 解压后即可全绿。
  ["tools/verify-package.cjs", "交付包自检（#67）"],
];

let totalPass = 0;
let totalFail = 0;
const rows = [];

for (const [rel, desc] of SUITES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    rows.push({ rel, desc, status: "缺失", pass: 0, fail: 0 });
    totalFail++;
    continue;
  }
  const r = spawnSync(NODE, [abs], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  // 兼容两种表述：「通过 23   失败 0」/「结果: 123 通过, 0 失败」/「通过 10 / 失败 0」
  let pass = null, fail = null;
  let m = /通过\s+(\d+)\s*(?:\/|,|\s)\s*失败\s+(\d+)/.exec(out);
  if (m) { pass = +m[1]; fail = +m[2]; }
  if (pass === null) {
    m = /结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败/.exec(out);
    if (m) { pass = +m[1]; fail = +m[2]; }
  }
  if (pass === null) {
    // 有些脚本用 ✅/❌ 计数
    const p = (out.match(/✅/g) || []).length;
    const f = (out.match(/❌/g) || []).length;
    if (p || f) { pass = p; fail = f; }
  }
  if (pass === null) { pass = 0; fail = 1; }
  totalPass += pass;
  totalFail += fail;
  rows.push({ rel, desc, status: fail === 0 ? "✅" : "❌", pass, fail });

  // 失败时把该套的失败行打出来，省得再跑一次
  if (fail > 0) {
    const lines = out.split("\n").filter((l) => l.includes("❌") || l.includes("失败"));
    console.log(`\n──── ${rel} 失败明细 ────`);
    console.log(lines.slice(0, 25).join("\n"));
  }
}

console.log("\n" + "=".repeat(64));
for (const r of rows) {
  console.log(
    `${r.status}  ${String(r.pass).padStart(4)} 通过  ${String(r.fail).padStart(2)} 失败   ${r.desc}`,
  );
}
console.log("=".repeat(64));
console.log(`\n合计：${totalPass} 通过 / ${totalFail} 失败\n`);
process.exit(totalFail ? 1 : 0);

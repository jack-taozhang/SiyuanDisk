/**
 * 反向测试 —— 任务29 的 L11g 系列断言（tools/_sim-embed-contract.cjs）
 *
 * 硬规矩：常绿断言 = 没有断言。每个新断言都必须有一次对应的"注入"能把它变红。
 *
 * 本文件针对 L11g / L11g2 / L11g3 三条：
 *   L11g   旧 symbol iconNbFolderClosed 已从 icons.js 彻底移除
 *   L11g2  icons.js 里存在 _folderSvg 构建器
 *   L11g3  目录图标使用网盘同款琥珀色 #e8a33d
 *
 * 做法：把 icons.js 的**真实内容**读进来，做字符串级注入，再跑同一套正则。
 * 不 mock、不重写正则 —— 直接复用契约文件里的判定条件（同步维护）。
 */
const fs = require("fs");
const path = require("path");

const PLUGIN = path.join(__dirname, "..");
const ICONS = path.join(PLUGIN, "src", "icons.js");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + name); }
}

/** 与契约文件一致：剥注释（否则断言会被注释里的字面量骗绿/骗红） */
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 契约文件里的三条判定条件，逐字同源 */
function judge(iconsCode) {
  return {
    L11g: /iconNbFolderClosed/.test(iconsCode) === false,
    L11g2: /_folderSvg\s*\(/.test(iconsCode),
    L11g3: /#e8a33d/.test(iconsCode),
  };
}

function run(label, iconsCode) {
  const r = judge(iconsCode);
  const n = Object.values(r).filter(Boolean).length;
  console.log(`\n【${label}】绿 ${n}/3`);
  console.log(`   L11g(旧symbol已移除)=${r.L11g ? "绿" : "红"}  L11g2(_folderSvg)=${r.L11g2 ? "绿" : "红"}  L11g3(#e8a33d)=${r.L11g3 ? "绿" : "红"}`);
  return r;
}

const raw = fs.readFileSync(ICONS, "utf8");
const base = strip(raw);
console.log("icons.js 原始 " + raw.length + " 字节，剥注释后 " + base.length + " 字节");

// ---------- 基线：必须 3/3 绿 ----------
const b = run("基线（未注入）", base);
ok(b.L11g && b.L11g2 && b.L11g3, "基线：三条断言全部为绿");

// ---------- 注入 1：把旧 symbol 加回去 ⇒ L11g 必须变红 ----------
//   模拟"有人回滚了任务29，目录图标又指回 SiYuan 的 symbol"
{
  const inj = base + '\nconst _legacy = "#iconNbFolderClosed";\n';
  const r = run("注入1：把 iconNbFolderClosed 写回 icons.js", inj);
  ok(r.L11g === false, "注入1：L11g 确实变红（旧 symbol 回归被抓到）");
  ok(r.L11g2 === true && r.L11g3 === true, "注入1：L11g2/L11g3 不受影响（定位精准）");
}

// ---------- 注入 2：删掉 _folderSvg 构建器 ⇒ L11g2 必须变红 ----------
//   模拟"有人把文件夹图标实现删了，用自己的方式画"
{
  const inj = base.replace(/_folderSvg/g, "_myFolderThing");
  const r = run("注入2：把 _folderSvg 改名成 _myFolderThing", inj);
  ok(r.L11g2 === false, "注入2：L11g2 确实变红（工厂函数被换掉被抓到）");
  ok(r.L11g === true, "注入2：L11g 仍绿（没误伤）");
}

// ---------- 注入 3：把琥珀色换掉 ⇒ L11g3 必须变红 ----------
//   模拟"有人把文件夹颜色改成主题色/灰色，不再是网盘风格"
{
  const inj = base.replace(/#e8a33d/g, "#123456");
  const r = run("注入3：把 #e8a33d 全部换成 #123456", inj);
  ok(r.L11g3 === false, "注入3：L11g3 确实变红（配色偏离网盘风格被抓到）");
  ok(r.L11g2 === true, "注入3：L11g2 仍绿（没误伤）");
}

// ---------- 注入 4：真回滚 —— 目录图标退回"灰底色块 span" ----------
//   这是 L11f + L11g 的联合回滚：把目录分支的 class 也一起改回旧写法，
//   验证 L11f 与 L11g 两条断言能同时报警。
{
  let inj = base;
  // 1) 目录分支不再返回文件夹 SVG，而是旧的底色块
  inj = inj.replace(
    /const svg = svgFromString\(FILE_SVG\.folder\);/,
    'const span = document.createElement("span"); span.className = "nb-type-icon"; return span;'
  );
  // 2) 类名也退回旧写法（不再有 --dir 专属分支）
  inj = inj.replace(/nb-type-icon--dir/g, "nb-type-icon");
  // 3) 旧 symbol 也"顺便"加回来
  inj = inj + '\nconst _x = "#iconNbFolderClosed";\n';
  const r = run("注入4：目录图标整体回滚成灰底色块 + 旧 symbol", inj);
  ok(r.L11g === false, "注入4：L11g 变红（旧 symbol 回来了）");
  const l11f = /nb-type-icon--dir/.test(inj);
  ok(l11f === false, "注入4：L11f 也变红（--dir 专属分支被移除，与 L11g 联合报警）");
  ok(inj.includes('span.className = "nb-type-icon"'), "注入4：替换确实命中目录分支（注入有效）");
}

// ==========================================================================
//  L11g4 / L11g5 / L11g6 —— 针对「打包产物 dist/index.js」的三条断言
//
//  ★ 为什么必须单独验这三条 ★
//    L11g~L11g3 只看 src/icons.js，而**真正上线的是 bundle**。
//    实测就踩到过：src 已干净，而 dist/index.js 里仍留着 iconNbFolderClosed
//    的**注释残留**（我在 tree.js 写了说明性注释）。
//    → 只查源码 = 给自己假安心。所以要连产物一起锁，且断言前必须剥注释。
// ==========================================================================
const DIST_JS = path.join(PLUGIN, "dist", "index.js");
if (!fs.existsSync(DIST_JS)) {
  ok(false, "L11g4-6：dist/index.js 不存在（请先跑 node tools/build.js --repo）");
} else {
  const distRaw = fs.readFileSync(DIST_JS, "utf8");
  const distCode = strip(distRaw);

  function judgeDist(c) {
    return {
      L11g4: !/iconNbFolderClosed/.test(c),   // 产物(剥注释)不许再有旧 symbol
      L11g5: /#iconFolder/.test(c),            // 兜底用思源内置 symbol
      L11g6: /e8a33d/.test(c),                 // 网盘风格琥珀色进了 bundle
    };
  }
  function runDist(label, c) {
    const r = judgeDist(c);
    const n = Object.values(r).filter(Boolean).length;
    console.log(`\n【${label}】绿 ${n}/3`);
    console.log(`   L11g4(无旧symbol)=${r.L11g4 ? "绿" : "红"}  L11g5(#iconFolder)=${r.L11g5 ? "绿" : "红"}  L11g6(琥珀色)=${r.L11g6 ? "绿" : "红"}`);
    return r;
  }

  // --- 基线：3/3 绿 ---
  const db = runDist("dist 基线（未注入）", distCode);
  ok(db.L11g4 && db.L11g5 && db.L11g6, "dist 基线：L11g4/5/6 全部为绿");

  // --- 注入 A：旧 symbol 以「真代码」形式回到 bundle ⇒ L11g4 红 ---
  {
    const inj = distCode + '\nvar _legacy = "#iconNbFolderClosed";\n';
    const r = runDist("注入A：旧 symbol 以真代码进入 bundle", inj);
    ok(r.L11g4 === false, "注入A：L11g4 变红（产物里的旧 symbol 被抓到）");
    ok(r.L11g5 === true && r.L11g6 === true, "注入A：L11g5/L11g6 不受影响（定位精准）");
  }

  // --- 注入 B：兜底 symbol 换回自定义 id ⇒ L11g5 红 ---
  {
    const inj = distCode.replace(/#iconFolder/g, "#myCustomFolder");
    const r = runDist("注入B：兜底 #iconFolder 换成自定义 id", inj);
    ok(r.L11g5 === false, "注入B：L11g5 变红（兜底不再用内置 symbol 被抓到）");
    ok(r.L11g4 === true, "注入B：L11g4 仍绿（没误伤）");
  }

  // --- 注入 C：琥珀色丢失 ⇒ L11g6 红 ---
  {
    const inj = distCode.replace(/e8a33d/g, "123456");
    const r = runDist("注入C：把琥珀色 #e8a33d 换掉", inj);
    ok(r.L11g6 === false, "注入C：L11g6 变红（网盘风格配色丢失被抓到）");
  }

  // --- 注入 D：★ 剥注释对照 ★ ---
  //   直接把「含注释的原文」交给判定（不剥注释）。若断言前**没有**剥注释，
  //   tree.js 里那句说明性注释会让 L11g4 假红。这里验证：
  //     · 不剥注释的原文 ⇒ L11g4 假红（证明注释里确实有该字符串，剥注释不是多余的）
  //     · 同一份内容剥掉注释 ⇒ L11g4 恢复绿（证明剥注释这一步是有效的）
  {
    const rawJudge = judgeDist(distRaw);          // 不剥注释
    const codeJudge = judgeDist(distCode);        // 剥注释
    ok(rawJudge.L11g4 === false,
       "注入D：不剥注释时 L11g4 会假红（证明 tree.js 注释里确有 iconNbFolderClosed）");
    ok(codeJudge.L11g4 === true,
       "注入D：剥掉注释后 L11g4 转绿（证明「先剥注释」这一步不可省）");
  }
}

console.log("\n" + "=".repeat(56));
// ★ 汇总行格式固定为「通过 N / 失败 M」★
//   反向测试会在注入阶段**故意**打印 ✗（那是预期行为，不是失败），
//   跑测器必须读这一行而不是数 ✗ 的个数。
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
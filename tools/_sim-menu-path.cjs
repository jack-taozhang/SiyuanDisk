/* ==========================================================================
 * 契约测试：任务 20 / 26 / 27(删) / 28 —— 菜单与路径显示
 * --------------------------------------------------------------------------
 * 这一组断言全部来自用户 2026-09-22 的原话，每条都对应一个可验证的代码事实：
 *
 *   26  复制路径 结果是「售前项目://托璞勒 宣传册.pdf」，是不是多了一个 /
 *   20  嵌入文档树到文档这个功能取消删除不需要了。 /网 跳出菜单 名称改为：嵌入文件到文档
 *   27  复制路径这个功能好像没有什么用，取消，删除
 *   28  右键菜单增加 在浏览器中打开功能 名称为：浏览器打开
 *
 * ★ 断言纪律（本项目铁律）★
 *   · 匹配源码/样式前**必须剥注释**，否则说明性注释里写着的属性名会被当真。
 *     （本项目已经栽过三次。）
 *   · 每条断言都要有一个反向注入能把它变红（见 tools/_reverse-menu.py）。
 *   · 只断言"出现过某字符串"是不够的 —— 要断言**在正确的函数里**、
 *     以及**旧写法确实消失了**（禁止性断言）。
 * ========================================================================== */
const fs = require("fs");
const path = require("path");

const PLUGIN = path.resolve(__dirname, "..");

let pass = 0, fail = 0, skip = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (extra ? "\n         " + extra : "")); }
}
function note(msg) { console.log("  ℹ️  " + msg); }

/** 剥掉块注释与整行行注释 —— 匹配前必须做 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 取一个函数的函数体（用花括号配平，而不是固定窗口）
 *
 *  ⚠️ 两个坑（都被反向测试暴露过）：
 *    ① `indexOf(名字)` 可能先命中**调用点**而不是**定义**。
 *       调用方应尽量传带 `{` 的锚点（`"foo(a, b) {"`）。
 *    ② 找到锚点后不能无脑取"第一个 { " —— 若锚点尾部已经有 `{`，
 *       再往后找会跨过函数体。这里先判断尾部。
 */
function sliceBlock(src, from) {
  const i = src.indexOf(from);
  if (i < 0) return null;
  if (from.trimEnd().endsWith("{")) {
    const open = i + from.trimEnd().length - 1;
    const body = src.slice(i);
    let depth = 0;
    for (let k = open - i; k < body.length; k++) {
      const c = body[k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return body.slice(0, k + 1);
      }
    }
    return body;
  }
  const open = src.indexOf("{", i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  return src.slice(i);
}

(function main() {
  console.log("=".repeat(58));
  console.log("契约：任务20/26/27/28（菜单 + 路径显示）");
  console.log("=".repeat(58));

  const treeRaw = fs.readFileSync(path.join(PLUGIN, "src", "tree.js"), "utf8");
  const tree = stripComments(treeRaw);
  const apiRaw = fs.readFileSync(path.join(PLUGIN, "src", "api.js"), "utf8");
  const api = stripComments(apiRaw);
  const indexRaw = fs.readFileSync(path.join(PLUGIN, "index.js"), "utf8");
  const index = stripComments(indexRaw);
  const viewer = stripComments(fs.readFileSync(path.join(PLUGIN, "src", "viewer.js"), "utf8"));
  const embed = stripComments(fs.readFileSync(path.join(PLUGIN, "src", "embed.js"), "utf8"));
  const i18n = JSON.parse(fs.readFileSync(path.join(PLUGIN, "i18n", "zh_CN.json"), "utf8"));

  /* -----------------------------------------------------------------
   * M1：任务26 —— 路径显示必须归一化，不能再出现 `mount://path`
   * ----------------------------------------------------------------- */
  {
    // ① 归一化函数存在，且是导出的（三个模块都要用）
    ok(/export function displayMountPath\(/.test(api),
       "M1a：★ api.js 导出 displayMountPath()（唯一的路径显示归一化入口）");

    // ② 归一化行为正确 —— 这是本题的核心不变量，必须真跑一遍
    //    用一个沙箱把函数体抽出来执行（不 import，避免 ESM/CJS 互操作麻烦）
    const body = sliceBlock(api, "export function displayMountPath(");
    ok(!!body, "M1b：截取到 displayMountPath 函数体");
    if (body) {
      const src = body.replace("export function", "function") + "\nreturn displayMountPath;";
      let fn = null;
      try { fn = new Function(src)(); } catch (e) {
        ok(false, "M1c：displayMountPath 可执行", String(e && e.message));
      }
      if (fn) {
        // ★ 两种真实输入形状都要正确（这是我从活内核里查到的两种历史数据）
        const cases = [
          ["售前项目", "托璞勒 宣传册.pdf",  "售前项目:/托璞勒 宣传册.pdf"],   // 无前导 /
          ["售前项目", "/托璞勒 宣传册.pdf", "售前项目:/托璞勒 宣传册.pdf"],   // 有前导 /
          ["售前项目", "//a//b.pdf",        "售前项目:/a/b.pdf"],            // 重复斜杠
          ["售前项目", "",                  "售前项目:/"],                   // 盘根
          ["售前项目", "/",                 "售前项目:/"],                   // 根
          ["售前项目", "/a/b/",             "售前项目:/a/b"],                // 尾斜杠
          ["售前项目", undefined,           "售前项目:/"],                   // 缺省
        ];
        let allOk = true, bad = null;
        for (const [m, p, want] of cases) {
          const got = fn(m, p);
          if (got !== want) { allOk = false; bad = JSON.stringify([m, p, got, want]); break; }
        }
        ok(allOk,
           "M1c：★★ displayMountPath 对「有/无前导斜杠」两种真实数据都给出唯一正确输出（7 组用例）",
           bad ? "反例 " + bad : "");

        // ★ 关键不变量：输出里绝不能出现 `://`
        let noDouble = true;
        for (const [m, p] of cases) {
          if (String(fn(m, p)).includes("://")) { noDouble = false; break; }
        }
        ok(noDouble, "M1d：★★ 输出里绝不出现 `://`（这正是用户截图报的「多了一个 /」）");
      }
    }

    // ③ 旧的裸拼接写法必须全部消失（禁止性断言）
    //    ⚠️ 但 api.js 的**注释里**会举例提到它（那是根因说明，有价值），
    //      所以这里只看代码、不看注释。
    const oldForms = [
      /\$\{[a-zA-Z_$][\w.]*\}:\/\$\{[^}]*\}/,          // `${x}:/${y}`
      /"":\s*\+\s*[a-zA-Z_$][\w.]*/,
    ];
    let leftovers = [];
    for (const [name, code] of [["tree.js", tree], ["viewer.js", viewer],
                                ["index.js", index], ["embed.js", embed]]) {
      for (const re of oldForms) {
        const m = code.match(re);
        if (m) leftovers.push(name + " → " + m[0]);
      }
    }
    ok(leftovers.length === 0,
       "M1e：★★ 四个模块里都不再有 `mount:/${path}` 裸拼接（全部走 displayMountPath）",
       leftovers.length ? "残留：" + leftovers.join(" | ") : "");

    // ④ 四个模块都真的用了归一化函数
    for (const [name, code, min] of [["tree.js", tree, 1], ["viewer.js", viewer, 1],
                                     ["index.js", index, 1], ["embed.js", embed, 1]]) {
      const n = (code.match(/displayMountPath\(/g) || []).length;
      ok(n >= min, `M1f：${name} 调用了 displayMountPath（${n} 处）`);
    }
  }

  /* -----------------------------------------------------------------
   * M2：任务27 —— 「复制路径」必须彻底删除
   * ----------------------------------------------------------------- */
  {
    ok(!/label:\s*"复制路径"/.test(tree),
       "M2a：★★ 右键菜单里没有「复制路径」这一项（label 已删）");
    ok(!/复制路径/.test(tree),
       "M2b：★ tree.js 代码里完全没有「复制路径」字样 —— 连提示文案也不许再引导用户去用它",
       (/复制路径/.test(tree) ? "仍出现在：" + (tree.match(/.{0,60}复制路径.{0,30}/) || [""])[0] : ""));
    ok(!/iconCopy/.test(tree),
       "M2c：★ 「复制路径」用的 iconCopy 图标引用也一并清掉（不留悬空引用）");
    // 不能误删「复制直链」
    ok(/label:\s*"复制直链"/.test(tree),
       "M2d：★ 「复制直链」必须保留（用户只说删「复制路径」，别连坐）");
  }

  /* -----------------------------------------------------------------
   * M3：任务28 —— 右键增加「浏览器打开」
   * ----------------------------------------------------------------- */
  {
    // ⚠️ 锚点必须是**定义**而不是调用点。
    //   最初写成 "showNodeMenu(ev, entry)"，indexOf 先命中的是
    //   `this.showNodeMenu(ev, entry);` 那个**调用点**，
    //   取的片段里根本没有菜单项 —— 于是 M3b/M3c 假红（而 M3d 假绿）。
    //   ⇒ 用 "showNodeMenu(ev, entry) {"（带花括号）精确定位定义。
    const seg = sliceBlock(tree, "showNodeMenu(ev, entry) {");
    ok(!!seg, "M3a：截取到 showNodeMenu 函数体");
    if (seg) {
      ok(/label:\s*"浏览器打开"/.test(seg),
         "M3b：★★ showNodeMenu 里有 label 为「浏览器打开」的菜单项（用户指定的名字）");
      ok(/this\.openInBrowser\(entry\)/.test(seg),
         "M3c：★ 该项的 click 真的调用 openInBrowser(entry)（不是空壳菜单项）");

      // 目录不许有这个项 —— 目录没有单文件预览
      const dirBranch = seg.slice(0, seg.indexOf("} else {") + 1);
      ok(!/浏览器打开/.test(dirBranch),
         "M3d：★ 「浏览器打开」只在**文件**分支里（目录没有单文件预览，给了就是坏链接）");
    }

    const fn = sliceBlock(tree, "async openInBrowser(entry)");
    ok(!!fn, "M3e：★ openInBrowser 方法存在");
    if (fn) {
      /*
       * ★ M3f 已按 #62 改写（原断言是 API.previewUrl，现已过期）★
       *
       *   2026-09-23 用户报障：
       *     「CAD 页签中的预览，在浏览器打开 功能是变成了下载。
       *       onlyoffice 预览一样 kkviewer 也一样。
       *       PDF 预览目前点击这个按钮是在网页中打开。」
       *
       *   实测根因：`/api/raw` 是**字节通道**不是渲染通道，
       *   `Content-Disposition: inline` 一直有，但浏览器对 Office/CAD 的
       *   专用 MIME **没有渲染器**，只能下载（PDF 恰好原生支持 ⇒ 只有它正常）。
       *
       *   ⇒ 现在统一走 API.browserViewUrl()：按 pickViewer() 的同一套路由
       *     选渲染通道（原生→raw；office/其它→kkFileView；cad→cad-viewer 深链）。
       *   ⚠️ 原断言 `API.previewUrl(` 必须换掉 —— previewUrl 恒走 kkFileView，
       *      对 pdf/图片/视频这些原生类型是多余的二次转换。
       */
      ok(/API\.browserViewUrl(?![\w$])\s*\(/.test(fn),
         "M3f：★★ 走 API.browserViewUrl()（按类型选渲染通道，避免 Office/CAD 变下载）");
      ok(!/API\.previewUrl\(/.test(fn),
         "M3f2：★ 不再直接调 API.previewUrl()（那是恒走 kk 的旧写法）");
      ok(/window\.open\(/.test(fn),
         "M3g：★ 用 window.open 真正开新窗口");
      ok(/entry\.isDir/.test(fn),
         "M3h：★ 对目录给出明确提示而不是硬开（防御性，与菜单分支双保险）");
      // ★ 关键的**禁止性**断言：不许自己拼 raw 链接
      ok(!/\/api\/raw\//.test(fn),
         "M3i：★★ openInBrowser 里没有自己拼 /api/raw/ —— 那是 403 / 容器内主机名，用户报过的坏链接形状");
      ok(!/nebula:8088/.test(fn),
         "M3j：★★ openInBrowser 里没有硬编码 nebula:8088（只有 docker 网内能解析）");
    }
  }

  /* -----------------------------------------------------------------
   * M4：任务20 —— 斜杠菜单只留一项，且名字是「嵌入文件到文档」
   * ----------------------------------------------------------------- */
  {
    // 找到 protyleSlash 数组
    const i = index.indexOf("this.protyleSlash = [");
    ok(i >= 0, "M4a：找到 protyleSlash 定义");
    if (i >= 0) {
      // 取到数组结束（配平方括号）
      let depth = 0, end = -1;
      for (let k = index.indexOf("[", i); k < index.length; k++) {
        const c = index[k];
        if (c === "[") depth++;
        else if (c === "]") { depth--; if (depth === 0) { end = k; break; } }
      }
      const arr = end > 0 ? index.slice(i, end + 1) : index.slice(i, i + 4000);
      const ids = (arr.match(/id:\s*"[^"]+"/g) || []);
      ok(ids.length === 1,
         `M4b：★★ 斜杠菜单只剩 **1** 项（任务20：删掉「嵌入文件树到文档」）—— 实际 ${ids.length} 项：${ids.join(", ")}`);
      ok(!/nebulaEmbedTree/.test(arr),
         "M4c：★★ 「嵌入文件树到文档」的 id(nebulaEmbedTree) 已从菜单里删除");
      ok(/id:\s*"nebulaEmbedFile"/.test(arr),
         "M4d：★ 保留的是 nebulaEmbedFile（嵌入文件）");
      ok(/pickAndEmbed\(protyle,\s*"file",\s*el\)/.test(arr),
         "M4e：★ 保留项的 callback 传的是 kind=\"file\"");
      ok(!/pickAndEmbed\(protyle,\s*"tree",\s*el\)/.test(arr),
         "M4f：★★ 菜单里不再有 kind=\"tree\" 的入口（但渲染能力必须保留，见 M4h）");

      // ★ 删入口 ≠ 删渲染能力：历史笔记里的 tree 嵌入块还要能显示
      ok(/renderTreeBrowser/.test(embed),
         "M4g：★★ embed.js 仍保留 renderTreeBrowser —— 删入口不能连渲染能力一起删，" +
         "否则**历史笔记里已有的目录嵌入块会变成白块**");
      ok(/kind\s*===\s*"tree"|"tree"\s*===/.test(embed) || /nbEmbedTree|nb-embed-tree/.test(embed),
         "M4h：★ 嵌入渲染仍按 kind 分派 tree 分支（老数据可渲染）");
    }

    // 名称必须是「嵌入文件到文档」
    ok(i18n.embedFileName === "嵌入文件到文档",
       "M4i：★★ i18n.embedFileName ===「嵌入文件到文档」（用户指定的名字）",
       "实际 = " + JSON.stringify(i18n.embedFileName));
    ok(/\|\|\s*"嵌入文件到文档"/.test(index),
       "M4j：★ 斜杠菜单 label 的兜底默认值也是「嵌入文件到文档」（i18n 缺失时不能退回旧名）");
    // 禁止性：不许再出现旧名
    ok(!/嵌入文件树到文档/.test(index),
       "M4k：★ index.js 里不再出现旧名「嵌入文件树到文档」",
       (/嵌入文件树到文档/.test(index) ? "仍出现" : ""));
  }

  console.log("\n" + "=".repeat(58));
  console.log(`结果: ${pass} 通过, ${fail} 失败${skip ? ", " + skip + " 跳过" : ""}`);
  console.log("=".repeat(58));
  process.exit(fail ? 1 : 0);
})();

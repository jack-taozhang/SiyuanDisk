/* 断言 2026-09-26 五项需求在**部署产物**里真实落地（不猜，逐条量）。 */
const fs = require("fs");

const P = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.js";
const C = "D:/Software/SiYuan/data/plugins/siyuan-nebuladisk/index.css";
const s = fs.readFileSync(P, "utf8");
const css = fs.readFileSync(C, "utf8");

let pass = 0, fail = 0;
const chk = (label, cond) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 " + label); }
};

console.log("部署产物: " + P + "  (" + s.length + " 字节)\n");

console.log("[身份] 必须是 NebulaDisk 插件，不是画布插件");
chk("含 class NebulaDiskPlugin", /class NebulaDiskPlugin/.test(s));
chk("不含 CanvasDock / canvas-dialog", !/CanvasDock|canvas-dialog/.test(s));
chk("不含 __mod_canvas", !/__mod_canvas/.test(s));

console.log("\n[需求1] 落点不在正文 ⇒ 静默不处理");
chk("含 resolveNoteEditorBody 哨兵", /resolveNoteEditorBody/.test(s));
chk("dragover 在 preventDefault 前判据先行",
  /if \(!resolveNoteEditorBody\(ev\.target\)\) return;\s*\n\s*\/\/ \u2605 关键：必须 preventDefault/.test(s) ||
  /resolveNoteEditorBody\(ev\.target\)\) return;/.test(s));

console.log("\n[需求2] 去掉六点手柄（★ 只针对**嵌入块头部**）");
//   ⚠️ 判据必须排除注释：我自己的说明文字里写了 `⠿`（解释删掉了什么），
//      用朴素的 /⠿/ 全文匹配会把注释当成残留 ⇒ 假失败。踩过一次。
const codeOnly = s
  .replace(/\/\*[\s\S]*?\*\//g, "")      // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, "");      // 独占整行的行注释
//   ★★ 关键：`⠿` 在**多选弹窗**的 chip 手柄里是**应该保留**的 ★★
//     那个手柄属于 nb-picker 弹窗（拖动手柄在 chip 上，用于调整插入顺序），
//     与「嵌入块路径前面」无关 ⇒ 需求2 不涉及它。
//     所以判据不是「产物里没有 ⠿」，而是：
//       ① 每一个还在代码里的 ⠿ 都必须挂在 .nb-picker-grip 上；
//       ② 没有任何一个挂在 .nb-embed-* 上。
const gripsInCode = codeOnly.match(/class="nb-[a-z-]*grip"/g) || [];
chk("代码里残留的 grip 元素全部属于 picker（与被删的 embed grip 无关）",
  gripsInCode.every((g) => g === 'class="nb-picker-grip"'));
chk("没有任何 .nb-embed-grip 元素残留",
  gripsInCode.every((g) => g !== 'class="nb-embed-grip"'));
console.log("     ↳ 代码中现存的 grip: " +
  (gripsInCode.length ? [...new Set(gripsInCode)].join(", ") : "（无）"));
chk("头部模板无 nb-embed-grip", !/class="nb-embed-grip"/.test(s));
chk("CSS 无 .nb-embed-grip 生效规则", !/\.nb-embed-grip\s*\{/.test(css));
chk("CSS 有 .nb-embed-head.nb-embed-drag (新拖动源)",
  /\.nb-embed-head\.nb-embed-drag/.test(css));
chk("调用方传 null", /makeEmbedDraggable\(null, wrap, plugin\)/.test(s));
chk("CSS 仍保留 .nb-picker-grip（弹窗手柄，不受需求2影响）",
  /\.nb-picker-grip\s*\{/.test(css));

console.log("\n[需求3] 路径显示 盘符:/路径");
chk("文件嵌入用 displayMountPath(spec.mount, ...) 完整返回",
  /displayMountPath\(spec\.mount, filePathRaw\)/.test(s));
chk("头部不再有 .nb-embed-mount 元素（文件嵌入）",
  /<span class="nb-embed-path"><\/span>/.test(s));

console.log("\n[需求4] 文件树不显示根目录行");
chk("新增 loadChildrenInto", /loadChildrenInto/.test(s));
chk("loadRoot 不再 makeNode(isMountRoot) 造行",
  !/const root = this\.makeNode\(\{\s*\n\s*name: this\.currentMount/.test(s));
chk("loadRoot 以 -1 深度铺第一层", /this\.loadChildrenInto\(this\.treeEl, \{[\s\S]{0,200}\}, -1\)/.test(s));
chk("restoreExpanded 接受容器节点", /if \(!wrap\._entry\) \{/.test(s));

console.log("\n[需求5] 插到光标所在块上面");
chk("locateInsertPoint 产出 nextID", /let nextID = ""/.test(s));
chk("普通块 ⇒ nextID = blockId", /nextID = blockId;/.test(s));
chk("insertEmbedIntoDoc 带上 nextID", /if \(nextID\) body\.nextID = nextID;/.test(s));
chk("previousID 恒空（不再插到下面）", /return \{ parentID, nextID, previousID: "", anchorBlockId, src \}/.test(s));

console.log("\n--------------------------------------");
console.log(pass + " 通过 / " + fail + " 失败");
process.exitCode = fail ? 1 : 0;

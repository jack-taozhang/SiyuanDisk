# -*- coding: utf-8 -*-
"""
反向测试：任务27（嵌入块拖动排序 + 视图跟随）

规则（本项目铁律）：
  · 永远绿的断言 = 没有断言。
  · 每个新断言都必须有一条注入让它变红。
  · ★ 每个 case 之前必须把**所有**被注入的文件恢复基线，
    否则 case N+1 会跑在 case N 的脏文件上 → 假红。

做法：
  1) 备份 src/embed.js + index.css
  2) 对每个 case：恢复基线 → 注入 → 跑契约测试 → 断言「指定编号必须红、其它编号不许红」
  3) 最后恢复基线，跑一遍确认全绿
"""
import io, os, re, shutil, subprocess, sys, tempfile

PLUGIN = r"D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk"
EMBED = os.path.join(PLUGIN, "src", "embed.js")
CSS = os.path.join(PLUGIN, "index.css")
CONTRACT = os.path.join(PLUGIN, "tools", "_sim-embed-contract.cjs")

NODE = r"C:/Users/HP/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
NODE_PATH = r"C:/Users/HP/.workbuddy/binaries/node/workspace/node_modules"


def read(p):
    return io.open(p, encoding="utf-8").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


BASE_EMBED = read(EMBED)
BASE_CSS = read(CSS)


def restore():
    write(EMBED, BASE_EMBED)
    write(CSS, BASE_CSS)


def run_contract():
    env = dict(os.environ)
    env["NODE_PATH"] = NODE_PATH
    p = subprocess.run([NODE, CONTRACT], cwd=PLUGIN, env=env,
                       capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    # ⚠️ 边界必须排除字母数字，否则 "L14o2" 会被切成 "L14o"（前缀吞并），
    #    导致断言编号识别错位 —— 这是本 harness 自己踩过的坑。
    reds = sorted(set(re.findall(r"❌\s*(L\d+[a-z]\d?)(?![A-Za-z0-9])", out)))
    ok_codes = sorted(set(re.findall(r"✅\s*(L\d+[a-z]\d?)(?![A-Za-z0-9])", out)))
    m = re.search(r"结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败", out)
    passed = int(m.group(1)) if m else -1
    failed = int(m.group(2)) if m else -1
    return reds, ok_codes, passed, failed, out


def inject_simple(path, old, new, label):
    s = read(path)
    if s.count(old) < 1:
        raise SystemExit("[%s] 注入锚点未找到：%r" % (label, old[:80]))
    write(path, s.replace(old, new))


CASES = []


def case(name, expect_red, fn):
    CASES.append((name, set(expect_red), fn))


# ---- 1. 手柄 span 被删（目录嵌入） ----
def c1():
    s = read(EMBED)
    old = '''    <span class="nb-embed-grip" title="按住拖动：调整本嵌入块在笔记中的位置">⠿</span>
    <span class="nb-embed-title">
      <svg><use xlink:href="#iconNebulaDisk"></use></svg>
      <span class="nb-embed-mount"></span>
      <span class="nb-embed-path"></span>
    </span>`;'''
    assert s.count(old) == 2, "期望两处相同头部，实际 %d" % s.count(old)
    write(EMBED, s.replace(old, old.replace('<span class="nb-embed-grip" title="按住拖动：调整本嵌入块在笔记中的位置">⠿</span>\n    ', "")))
case("1 删掉一处 grip span", ["L14b"], c1)


# ---- 2. 接线被删（只剩 span，手柄是死的） ----
def c2():
    inject_simple(EMBED,
        "  makeEmbedDraggable(head.querySelector(\".nb-embed-grip\"), wrap, plugin);\n",
        "", "2")
case("2 删掉两处 makeEmbedDraggable 接线", ["L14c"], c2)


# ---- 3. moveBlock 传了 parentID（语义会变） ----
def c3():
    inject_simple(EMBED,
        'kb("/api/block/moveBlock", { id: myId, previousID: target.previousID })',
        'kb("/api/block/moveBlock", { id: myId, previousID: target.previousID, parentID: target.parentID || "" })',
        "3")
case("3 moveBlock 多传 parentID", ["L14e"], c3)


# ---- 4. 两步法（已被实测证伪的错解）复活 ----
def c4():
    s = read(EMBED)
    anchor = "  /** 执行落位（单次 moveBlock，语义已实测确认） */"
    assert anchor in s
    write(EMBED, s.replace(anchor,
        "  async function moveToFirst(id) {\n"
        "    const first = siblingBlockEls()[0];\n"
        "    if (!first) return;\n"
        "    await kb(\"/api/block/moveBlock\", { id: first.getAttribute(\"data-node-id\"), previousID: id });\n"
        "  }\n\n" + anchor))
case("4 注入 moveToFirst 两步法残留", ["L14f"], c4)


# ---- 5. 不分上下半区（永远追加到末尾） ----
def c5():
    s = read(EMBED)
    # 把上半区判定改成永假 ⇒ 只剩"插到之后"
    n = s.count("if (clientY < r.top + r.height / 2) {")
    assert n == 1, "期望 1 处，实际 %d" % n
    write(EMBED, s.replace("if (clientY < r.top + r.height / 2) {", "if (false) {"))
case("5 去掉上下半区判定", ["L14g"], c5)


# ---- 6. 上半区没有前兄弟时不返回 null（硬凑） ----
def c6():
    inject_simple(EMBED,
        "          const prev = prevBlockOf(el);\n          if (!prev) return null;   // el 已是第一个 ⇒ 无处可插\n",
        "          const prev = prevBlockOf(el);\n", "6")
case("6 上半区不判空（硬凑 previousID）", ["L14h"], c6)


# ---- 7. 不判自己 ----
def c7():
    inject_simple(EMBED,
        "    if (target.previousID === myId) return;   // 拖到自己后面无意义\n",
        "", "7")
case("7 去掉 target===self 守卫", ["L14i"], c7)


# ---- 8. 去掉 scrollIntoView（视图不跟随） ----
def c8():
    inject_simple(EMBED,
        '        el.scrollIntoView({ block: "center", behavior: "smooth" });\n',
        "", "8")
case("8 去掉 scrollIntoView", ["L14j"], c8)


# ---- 9. 只滚一次 rAF（不等重渲染） ----
def c9():
    inject_simple(EMBED,
        "      requestAnimationFrame(() => requestAnimationFrame(scroll));\n",
        "      requestAnimationFrame(scroll);\n", "9")
case("9 单 rAF（不等重建完成）", ["L14k"], c9)


# ---- 10. 去掉 iframe pointerEvents 抑制 ----
def c10():
    s = read(EMBED)
    old = '''    for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
      f.style.pointerEvents = "none";
    }'''
    assert s.count(old) == 1, "期望 1 处，实际 %d" % s.count(old)
    write(EMBED, s.replace(old, ""))
case("10 去掉 iframe pointerEvents 抑制", ["L14m"], c10)


# ---- 11. dragend 不恢复 pointerEvents ----
def c11():
    s = read(EMBED)
    old = '''    for (const f of Array.from(wrapEl.querySelectorAll("iframe"))) {
      f.style.pointerEvents = "";
    }'''
    assert s.count(old) == 2, "期望 2 处（dragend + drop），实际 %d" % s.count(old)
    write(EMBED, s.replace(old, "", 1))  # 只删 dragend 那处
case("11 dragend 不恢复 pointerEvents", ["L14n"], c11)


# ---- 12. drop 不调 clearMarks（提示线残留） ----
def c12():
    s = read(EMBED)
    i = s.index('addEventListener("drop"')
    j = s.index("applyMove(y);", i)
    seg = s[i:j]
    assert "clearMarks();" in seg
    write(EMBED, s[:i] + seg.replace("clearMarks();", "", 1) + s[j:])
case("12 drop 不清落位线", ["L14s"], c12)


# ---- 13. clearMarks 函数被删 ----
#  说明：这里**只**预期 L14r 变红。L14s 断言的是"drop 处理器里**调用了**
#  clearMarks()" —— 调用点还在（只是函数没了），所以 L14s 保持绿是**正确**的。
#  L14r 与 L14s 是两条独立断言：一个管"实现了没有"，一个管"接上了没有"。
def c13():
    s = read(EMBED)
    old = '''  /** 清除所有落位提示线 */
  function clearMarks() {
    for (const el of Array.from(document.querySelectorAll(".nb-embed-drop-before, .nb-embed-drop-after"))) {
      el.classList.remove("nb-embed-drop-before", "nb-embed-drop-after");
    }
  }
'''
    assert s.count(old) == 1
    write(EMBED, s.replace(old, ""))
case("13 删掉 clearMarks 实现", ["L14r"], c13)


# ---- 14. CSS 提示线的伪元素背景被删（没背景 = 看不见的线） ----
def c14():
    inject_simple(CSS, "  background: var(--b3-theme-primary);\n  border-radius: 1px;\n",
                  "  border-radius: 1px;\n", "14")
case("14 CSS 提示线去掉 background", ["L14o"], c14)


# ---- 14b. CSS 提示线的上/下沿偏移被删（两条线分不出前/后） ----
def c14b():
    inject_simple(CSS, ".nb-embed-drop-before::before { top: -2px; }",
                  ".nb-embed-drop-before::before { top: 0; }", "14b")
case("14b CSS 提示线删掉 top:-2px", ["L14o2"], c14b)


# ---- 14c. 只改 before 那一半的选择器 ----
#  说明：L14o 断言的是 (before::before + after::after) 的**合并**声明文本里有 background。
#  只把 `.nb-embed-drop-before` 改掉，`-after::after` 那条规则还在且仍有 background
#  ⇒ L14o 绿是**正确**的（上半区的线坏了，下半区的线还在）。
#  真正会变红的是 L14o2 —— 它分别检查 before 的 top 与 after 的 bottom。
def c14c():
    s = read(CSS)
    n = s.count(".nb-embed-drop-before")
    assert n >= 1, "未找到 .nb-embed-drop-before"
    write(CSS, s.replace(".nb-embed-drop-before", ".zz-drop-before-x"))
case("14c CSS 只改 before 半边的选择器", ["L14o2"], c14c)


# ---- 14d. 两边一起改名（整条功能消失） ----
def c14d():
    s = read(CSS)
    assert s.count(".nb-embed-drop-after") >= 1
    write(CSS, s.replace(".nb-embed-drop-before", ".zz-before-x")
              .replace(".nb-embed-drop-after", ".zz-after-x"))
case("14d CSS 提示线两边全改名", ["L14o", "L14o2"], c14d)


# ---- 15. CSS is-dragging 透明被删 ----
def c15():
    inject_simple(CSS, ".nb-embed.is-dragging { opacity: 0.5; }", ".nb-embed.zzz { opacity: 0.5; }", "15")
case("15 CSS is-dragging 改名", ["L14p"], c15)


# ---- 16. CSS grip cursor 被删 ----
def c16():
    inject_simple(CSS, "  cursor: grab;", "  cursor: default;", "16")
case("16 CSS grip 不是 grab", ["L14q"], c16)


# ---- 17. makeEmbedDraggable 函数被删 ----
#  说明：删掉函数定义后，两处**调用点**仍然在文本里 ——
#    · L14c 断言的是"调用了 makeEmbedDraggable(...)"，调用点没删 ⇒ 绿是**正确**的
#    · L14f 断言的是"没有出现被证伪的两步法"（一个**禁止性**断言），
#      删函数不会引入禁忌写法 ⇒ 绿是**正确**的
#  这两条本来就不该由"删函数"来触发。用 L14a 抓函数存在性，用 L14d/n 抓函数体内容。
def c17():
    s = read(EMBED)
    i = s.index("function makeEmbedDraggable(")
    j = s.index("/**\n * 生成一个「单个文件」的嵌入视图。", i)
    write(EMBED, s[:i] + s[j:])
case("17 删掉 makeEmbedDraggable 整个函数",
     ["L14a","L14d","L14e","L14g","L14h","L14i","L14j","L14k","L14l","L14m","L14n","L14r","L14s"],
     c17)


# ---- 18. 负对照：只改注释，不许变红 ----
def c18():
    inject_simple(EMBED,
        "  /** 执行落位（单次 moveBlock，语义已实测确认） */",
        "  /** 执行落位（单次 moveBlock；注释说明：实测 moveBlock 是「移到 previousID 之后」） */",
        "18")
case("18 负对照：只加说明性注释", [], c18)


print("=" * 60)
print("反向测试：任务27")
print("=" * 60)

results = []
for name, expect_red, fn in CASES:
    restore()
    fn()
    reds, oks, passed, failed, out = run_contract()
    if expect_red:
        ok_case = (reds == sorted(expect_red))
    else:
        ok_case = (len(reds) == 0)
    results.append((ok_case, name, reds, sorted(expect_red), failed, out))
    mark = "✅" if ok_case else "❌"
    print("%s %-34s 红=%-46s 期望红=%s (失败数=%d)" %
          (mark, name, ",".join(reds) or "-", ",".join(sorted(expect_red)) or "-", failed))

# 恢复基线并确认全绿
restore()
reds, oks, passed, failed, out = run_contract()
print("-" * 60)
print("基线恢复后：%d 通过 / %d 失败  红=%s" % (passed, failed, ",".join(reds) or "-"))
print("=" * 60)

bad = [r for r in results if not r[0]]
print("反向测试：%d/%d 符合预期，%d 不符合" % (len(results) - len(bad), len(results), len(bad)))
for r in bad:
    print("\n--- 不符合：%s ---" % r[1])
    print("  实际红：" + (",".join(r[2]) or "-"))
    print("  期望红：" + (",".join(r[3]) or "-"))
    print(r[5][-2500:])

sys.exit(1 if (bad or failed) else 0)

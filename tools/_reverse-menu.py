# -*- coding: utf-8 -*-
"""反向测试：任务20/26/27/28（菜单 + 路径显示）

铁律：永远绿的断言 = 没有断言。每条断言都要有一条注入把它变红。
★ 每个 case 之前把**所有**被注入的文件恢复基线。
"""
import io, os, re, subprocess, sys

PLUGIN = r"D:/Docker/SiyuanDisk/data/plugins/siyuan-nebuladisk"
FILES = {
    "tree":   PLUGIN + "/src/tree.js",
    "api":    PLUGIN + "/src/api.js",
    "index":  PLUGIN + "/index.js",
    "viewer": PLUGIN + "/src/viewer.js",
    "embed":  PLUGIN + "/src/embed.js",
}
I18N = PLUGIN + "/i18n/zh_CN.json"
CONTRACT = PLUGIN + "/tools/_sim-menu-path.cjs"
NODE = r"C:/Users/HP/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
NODE_PATH = r"C:/Users/HP/.workbuddy/binaries/node/workspace/node_modules"

BASE = {k: io.open(v, encoding="utf-8").read() for k, v in FILES.items()}
BASE_I18N = io.open(I18N, encoding="utf-8").read()


def restore():
    for k, v in FILES.items():
        io.open(v, "w", encoding="utf-8", newline="\n").write(BASE[k])
    io.open(I18N, "w", encoding="utf-8", newline="\n").write(BASE_I18N)


def run():
    env = dict(os.environ); env["NODE_PATH"] = NODE_PATH
    p = subprocess.run([NODE, CONTRACT], cwd=PLUGIN, env=env,
                       capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    # ⚠️ 编号边界：M1f/M3b 这种 a-z 后面可能带数字，必须排字母数字
    reds = sorted(set(re.findall(r"❌\s*(M\d+[a-z]\d?)(?![A-Za-z0-9])", out)))
    m = re.search(r"结果:\s*(\d+)\s*通过,\s*(\d+)\s*失败", out)
    return reds, (int(m.group(1)) if m else -1), (int(m.group(2)) if m else -1), out


def sub(key, old, new, label, expect=1):
    s = BASE[key]
    n = s.count(old)
    if n != expect:
        raise SystemExit("[%s] 锚点命中 %d，期望 %d：%r" % (label, n, expect, old[:70]))
    io.open(FILES[key], "w", encoding="utf-8", newline="\n").write(s.replace(old, new))


CASES = []
def case(name, red, fn): CASES.append((name, set(red), fn))


# ---------- M1：路径归一化 ----------
def c1():
    # 让 displayMountPath 退化成旧的裸拼接
    sub("api",
        'return `${m}:${p || "/"}`;',
        'return `${m}:/${p || ""}`;', "1")
case("1 displayMountPath 退回裸拼接（出现 ://）", ["M1c", "M1d"], c1)


def c2():
    # 不归一化前导斜杠
    sub("api",
        'if (p && !p.startsWith("/")) p = "/" + p;',
        '', "2")
case("2 去掉前导斜杠归一化", ["M1c"], c2)


def c3():
    # 函数不再导出
    sub("api", "export function displayMountPath(", "function displayMountPath(", "3")
case("3 displayMountPath 取消导出", ["M1a","M1b"], c3)


def c4():
    # tree.js 退回裸拼接
    sub("tree",
        'displayMountPath(this.currentMount, e.path)',
        '`${this.currentMount}:/${e.path}`', "4")
case("4 tree.js 退回 `mount:/${path}` 裸拼接", ["M1e"], c4)


def c5():
    # viewer.js 退回裸拼接（4 处一起）
    s = BASE["viewer"]
    n = s.count("displayMountPath(this.mount, this.path)")
    if n != 4: raise SystemExit("[5] viewer 命中 %d" % n)
    io.open(FILES["viewer"], "w", encoding="utf-8", newline="\n").write(
        s.replace("displayMountPath(this.mount, this.path)", "`${this.mount}:/${this.path}`"))
case("5 viewer.js 退回裸拼接（4 处）", ["M1e","M1f"], c5)


# ---------- M2：删除复制路径 ----------
def c6():
    # 把「复制路径」菜单项加回来
    sub("tree",
        '    menu.addItem({\n      icon: "iconLink",\n      label: "复制直链",',
        '    menu.addItem({\n      icon: "iconCopy",\n      label: "复制路径",\n'
        '      click: () => copyText(`${this.currentMount}:/${entry.path}`, "路径已复制"),\n'
        '    });\n    menu.addItem({\n      icon: "iconLink",\n      label: "复制直链",', "6")
case("6 加回「复制路径」菜单项", ["M1e","M2a","M2b","M2c"], c6)


def c7():
    # 只在 toast 文案里提一句（容易漏掉的那种残留）
    sub("tree", "文件夹没有直链，请用「在浏览器中打开网盘」",
        "文件夹没有直链，请用「复制路径」", "7")
case("7 只在提示文案里残留「复制路径」", ["M2b"], c7)


def c8():
    # 误删「复制直链」
    sub("tree", '      label: "复制直链",\n', "", "8")
case("8 误删「复制直链」", ["M2d"], c8)


# ---------- M3：浏览器打开 ----------
def c9():
    sub("tree", '        label: "浏览器打开",', '        label: "用浏览器打开",', "9")
case("9 菜单名改成「用浏览器打开」", ["M3b"], c9)


def c10():
    sub("tree", "        click: () => this.openInBrowser(entry),", "        click: () => {},", "10")
case("10 「浏览器打开」click 变空", ["M3c"], c10)


def c11():
    # 自己拼 raw 链接（用户报过的坏链接形状）
    s = BASE["tree"]
    old = "      const { url } = await API.previewUrl(this.currentMount, entry.path);"
    if s.count(old) != 1: raise SystemExit("[11] 锚点命中 %d" % s.count(old))
    io.open(FILES["tree"], "w", encoding="utf-8", newline="\n").write(
        s.replace(old, "      const url = `${serverBase}nebula:8088/api/raw/${entry.name}?mount=${this.currentMount}`;"))
case("11 openInBrowser 自己拼 /api/raw + nebula:8088", ["M3f", "M3i", "M3j"], c11)


def c12():
    # 不再用 window.open
    sub("tree", 'window.open(url, "_blank", "noopener,noreferrer")', "void url", "12")
case("12 不再 window.open", ["M3g"], c12)


def c13():
    # 把「浏览器打开」也塞进目录分支
    sub("tree",
        '      menu.addItem({\n        icon: "iconAdd",\n        label: "新建文件夹",',
        '      menu.addItem({\n        icon: "iconLink",\n        label: "浏览器打开",\n'
        '        click: () => this.openInBrowser(entry),\n      });\n'
        '      menu.addItem({\n        icon: "iconAdd",\n        label: "新建文件夹",', "13")
case("13 「浏览器打开」被放进目录分支", ["M3d"], c13)


# ---------- M4：斜杠菜单 ----------
def c14():
    # 把 tree 菜单项加回来
    sub("index",
        '        id: "nebulaEmbedFile",\n        callback: (protyle, el) => this.pickAndEmbed(protyle, "file", el),\n      },\n    ];',
        '        id: "nebulaEmbedFile",\n        callback: (protyle, el) => this.pickAndEmbed(protyle, "file", el),\n      },\n'
        '      {\n        filter: ["nebula"],\n        html: `<div></div>`,\n'
        '        id: "nebulaEmbedTree",\n        callback: (protyle, el) => this.pickAndEmbed(protyle, "tree", el),\n      },\n    ];',
        "14")
case("14 斜杠菜单加回 tree 入口", ["M4b", "M4c", "M4f"], c14)


def c15():
    # 名字退回旧名
    io.open(I18N, "w", encoding="utf-8", newline="\n").write(
        BASE_I18N.replace('"embedFileName": "嵌入文件到文档"', '"embedFileName": "嵌入文件树到文档"'))
case("15 i18n.embedFileName 退回旧名", ["M4i"], c15)


def c16():
    # label 兜底值退回旧名
    sub("index", '|| "嵌入文件到文档"', '|| "嵌入文件树到文档"', "16")
case("16 label 兜底值退回旧名", ["M4j", "M4k"], c16)


def c17():
    # 把 kind="file" 改成 "tree"（保留项传错 kind）
    sub("index", 'this.pickAndEmbed(protyle, "file", el)',
        'this.pickAndEmbed(protyle, "tree", el)', "17")
case("17 保留项 callback 传错 kind=tree", ["M4e", "M4f"], c17)


def c18():
    # 删掉 renderTreeBrowser —— 模拟"删入口连渲染能力一起删"
    s = BASE["embed"]
    i = s.find("function renderTreeBrowser(")
    if i < 0: raise SystemExit("[18] 未找到 renderTreeBrowser")
    j = s.find("function renderFileEmbed(")
    if j < i: raise SystemExit("[18] 顺序异常")
    io.open(FILES["embed"], "w", encoding="utf-8", newline="\n").write(s[:i] + s[j:])
case("18 删掉 renderTreeBrowser（老笔记会白块）", ["M4h"], c18)


# ---------- 负对照 ----------
def c19():
    # 只在注释里写旧写法，代码不动 —— 不许变红（注释里有价值的根因说明）
    sub("api",
        " *   根因：各处都在写",
        " *   根因：各处都在写（示例 `${mount}:/${path}` —— 注释不算代码）\n *   备注：",
        "19")
case("19 负对照：注释里保留旧写法例子", [], c19)


def c20():
    # 负对照：只加空行
    sub("tree", "  showNodeMenu(ev, entry) {",
        "  // 说明性注释：菜单顺序按使用频率排\n  showNodeMenu(ev, entry) {", "20")
case("20 负对照：只加说明性注释", [], c20)


print("=" * 62)
print("反向测试：任务20/26/27/28（菜单 + 路径显示）")
print("=" * 62)

results = []
for name, expect, fn in CASES:
    restore()
    fn()
    reds, passed, failed, out = run()
    good = (reds == sorted(expect)) if expect else (len(reds) == 0)
    results.append((good, name, reds, sorted(expect), out))
    print("%s %-42s 红=%-24s 期望=%s" % ("✅" if good else "❌", name,
          ",".join(reds) or "-", ",".join(sorted(expect)) or "-"))

restore()
reds, passed, failed, out = run()
print("-" * 62)
print("基线恢复后：%d 通过 / %d 失败  红=%s" % (passed, failed, ",".join(reds) or "-"))
print("=" * 62)

bad = [r for r in results if not r[0]]
print("反向测试：%d/%d 符合预期，%d 不符合" % (len(results) - len(bad), len(results), len(bad)))
for r in bad:
    print("\n--- 不符合：%s ---" % r[1])
    print("  实际红：" + (",".join(r[2]) or "-"))
    print("  期望红：" + (",".join(r[3]) or "-"))
    print(r[4][-1800:])
sys.exit(1 if (bad or failed) else 0)

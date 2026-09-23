"""任务26 反向测试：证明 L13 断言真的会在缺陷回归时变红。

为什么要单独写成文件：heredoc + 多层引号在 Git Bash 里容易炸（项目踩过多次）。
用文件跑，路径与断言都清清楚楚。

用法:
  python tools/_reverse-task26.py
"""
import os
import re
import subprocess
import sys

PLUG = r"D:\Docker\SiyuanDisk\data\plugins\siyuan-nebuladisk"
CSS = os.path.join(PLUG, "index.css")
EMB = os.path.join(PLUG, "src", "embed.js")
NODE = r"C:/Users/HP/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
NODE_CWD = r"C:\Users\HP\.workbuddy\binaries\node\workspace"


def run():
    env = dict(os.environ)
    env["NODE_PATH"] = r"C:\Users\HP\.workbuddy\binaries\node\workspace\node_modules"
    p = subprocess.run(
        [NODE, os.path.join(PLUG, "tools", "_sim-embed-contract.cjs")],
        capture_output=True, text=True, env=env, cwd=NODE_CWD,
    )
    out = p.stdout + p.stderr
    fails = re.findall(r"❌ (L13[a-z][^<\n]*)", out)
    passes = re.findall(r"✅ (L13[a-z][^<\n]*)", out)
    return fails, passes


def drop_decl(css, selector, prop):
    """删除某选择器**(所有)**规则里的某个声明（逐条规则处理，可跨注释）。"""
    changed = [False]
    re_sel = re.compile(
        r"(" + re.escape(selector) + r"\s*\{)([^}]*)(\})", re.S
    )

    def repl(m):
        head, body, tail = m.group(1), m.group(2), m.group(3)
        nb = re.sub(
            r"^\s*" + re.escape(prop) + r"\s*:\s*[^;]+;\s*$",
            "", body, flags=re.M,
        )
        if nb != body:
            changed[0] = True
        return head + nb + tail

    return re_sel.sub(repl, css), changed[0]


def set_decl(css, selector, prop, newval):
    changed = [False]
    re_sel = re.compile(
        r"(" + re.escape(selector) + r"\s*\{)([^}]*)(\})", re.S
    )

    def repl(m):
        head, body, tail = m.group(1), m.group(2), m.group(3)
        nb = re.sub(
            r"^(\s*)" + re.escape(prop) + r"\s*:\s*[^;]+;",
            r"\g<1>" + prop + ": " + newval + ";",
            body, count=1, flags=re.M,
        )
        if nb != body:
            changed[0] = True
        return head + nb + tail

    return re_sel.sub(repl, css), changed[0]


css_bak = open(CSS, encoding="utf-8").read()
emb_bak = open(EMB, encoding="utf-8").read()

cases = []


def build_cases():
    out = []

    # 1. head 换行回归
    s, okc = set_decl(css_bak, ".nb-embed-head", "flex-wrap", "wrap")
    out.append(("注入1  .nb-embed-head → flex-wrap: wrap", okc, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 2. 标题不能收缩（删 min-width:0）
    s, okc = drop_decl(css_bak, ".nb-embed-title", "min-width")
    out.append(("注入2  .nb-embed-title 删除 min-width:0", okc, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 3. 标题不吃剩余空间（删 flex:1 1 auto）
    s, okc = drop_decl(css_bak, ".nb-embed-title", "flex")
    out.append(("注入3  .nb-embed-title 删除 flex:1 1 auto", okc, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 4. 路径不能收缩（删 min-width:0）
    s, okc = drop_decl(css_bak, ".nb-embed-path", "min-width")
    out.append(("注入4  .nb-embed-path 删除 min-width:0", okc, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 5. 路径不截断（删 text-overflow:ellipsis）
    s, okc = drop_decl(css_bak, ".nb-embed-path", "text-overflow")
    out.append(("注入5  .nb-embed-path 删除 text-overflow:ellipsis", okc, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 6. 文件嵌入又自己拼「:」+ path（会拼出 `://`）
    #
    #   ⚠️ 锚点跟着源码走过两轮：
    #      第一版目标是 `filePathRaw ? ":" + filePathRaw : ""`；
    #      任务26 第二轮把实现改成 displayMountPath 归一化后，
    #      这条注入就"未生效"了 —— 于是它从"能证明断言有效"退化成了噪音。
    #      ⇒ 现在锚定**当前真实实现**，注入成旧的拼接写法。
    old = (
        'const filePathRaw = spec.path || spec.name || "";\n'
        '  head.querySelector(".nb-embed-path").textContent =\n'
        '    filePathRaw ? displayMountPath("", filePathRaw).slice(1) : "";'
    )
    new = (
        'const filePathRaw = spec.path || spec.name || "";\n'
        '  head.querySelector(".nb-embed-path").textContent =\n'
        '    filePathRaw ? ":" + filePathRaw : "";'
    )
    s = emb_bak.replace(old, new)
    out.append(("注入6  file embed 退回自己拼「:」", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 6b. 用 `|| ""` 给 displayMountPath 兜底（死兜底：空路径会被渲染成 `盘:/`）
    old6b = 'filePathRaw ? displayMountPath("", filePathRaw).slice(1) : "";'
    new6b = 'displayMountPath("", filePathRaw) || "";'
    s = emb_bak.replace(old6b, new6b)
    out.append(("注入6b file embed 改用 `|| \"\"` 死兜底", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 6c. ★ 第四轮（用户报盘符重复）：把完整 displayMountPath(spec.mount, ...) 塞回 path 元素 ★
    #   这正是第二轮的错误写法 —— 盘符会显示两次。
    old6c = 'filePathRaw ? displayMountPath("", filePathRaw).slice(1) : "";'
    new6c = 'filePathRaw ? displayMountPath(spec.mount, filePathRaw) : "";'
    s = emb_bak.replace(old6c, new6c)
    out.append(("注入6c file embed 重回「盘符塞进 path 元素」（盘符重复）", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 7. 目录嵌入又自己拼「冒号斜杠 + currentPath」（会拼出 `://`）
    #
    #   ⚠️ 锚点必须跟着**当前真实实现**走，否则 replace 不生效 →
    #      退化成"注入未生效"的噪音（本文件踩过一次，见上面注入6 的注释）。
    #      任务26 第四轮把实现改成「只取路径部分」后，这里同步换成新版锚点。
    old7 = 'pathEl.textContent = currentPath ? displayMountPath("", currentPath).slice(1) : "";'
    new7 = 'pathEl.textContent = currentPath ? `:/${currentPath}` : "";'
    s = emb_bak.replace(old7, new7)
    out.append(("注入7  tree embed 退回自己拼「冒号斜杠」（拼出 ://）", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 7a. 目录嵌入把盘符/冒号又拼回去（盘符重复或冒号冗余）
    old7a = 'pathEl.textContent = currentPath ? displayMountPath("", currentPath).slice(1) : "";'
    new7a = 'pathEl.textContent = currentPath ? `:${displayMountPath("", currentPath).slice(1)}` : "";'
    s = emb_bak.replace(old7a, new7a)
    out.append(("注入7a tree embed 又把冒号拼回去（风格不一致）", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 7b. ★ 新增（真机 Bug B 的根因）：删掉 displayMountPath 的 import ★
    #   漏 import ⇒ 打包器不生成 `const displayMountPath = __mod_api.displayMountPath`
    #   ⇒ 调用处 ReferenceError("displayMountPath is not defined")
    #   ⇒ 真机上文件嵌入块渲染不出来、显示裸 JSON。
    #   这条注入专门证明 L13i3 不是永远绿的装饰。
    imp_old = 'import { serverBase, webDiskUrl, liteUrl, pickViewer, decodeSmart, displayMountPath } from "./api.js";'
    imp_new = 'import { serverBase, webDiskUrl, liteUrl, pickViewer, decodeSmart } from "./api.js";'
    s = emb_bak.replace(imp_old, imp_new)
    out.append(("注入7b embed.js 删掉 displayMountPath 的 import", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 7c. 对照：把 import 里的名字换成不相关的符号（语法合法、语义错误）→ 也必须变红
    imp_old_c = 'decodeSmart, displayMountPath }'
    imp_new_c = 'decodeSmart, humanSize }'
    s = emb_bak.replace(imp_old_c, imp_new_c)
    out.append(("注入7c embed.js 把 import 的名字换成 humanSize", s != emb_bak, lambda s=s: open(EMB, "w", encoding="utf-8").write(s)))

    # 8. 注释「现在时」撒谎：声称已经有 flex-wrap:wrap（会诱使维护者改回 wrap）
    #
    #   ⚠️ 锚点要跟着源码走：注入的 old 串必须是**当前文件里真实存在**的文本，
    #      否则 replace 不生效 → 变成"注入未生效"，而不是"断言假绿"。
    old8 = "  /* ★ 任务26：头部已改为 nowrap（见上方主规则），这里只补充收缩所需的"
    new8 = "  /* ★ 任务26：头部现在是 flex-wrap:wrap（靠 min-width:0 兜住）"
    s = css_bak.replace(old8, new8)
    out.append(("注入8  注释撒谎「现在时 flex-wrap:wrap」", s != css_bak, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    # 9. 反例对照：注释写「原来是 wrap」（过去时复盘）→ 必须保持绿，不许误报
    old9 = "  /* ★ 任务26：头部已改为 nowrap（见上方主规则），这里只补充收缩所需的"
    new9 = "  /* ★ 任务26：原来这里是 flex-wrap:wrap，现改为 nowrap（见上方主规则）"
    s = css_bak.replace(old9, new9)
    out.append(("注入9  对照：过去时复盘「原来是 wrap」应保持绿", s != css_bak, lambda s=s: open(CSS, "w", encoding="utf-8").write(s)))

    return out


try:
    cases = build_cases()
    results = []
    for name, applied, write in cases:
        if not applied:
            results.append((name, None, None, "注入未生效（脚本自身问题）"))
            continue
        # ★★ 每个用例开始前先**复位到 baseline** ★★
        #   否则注入会互相污染：用例6/7 改的是 embed.js，跑到用例8/9（只改 CSS）
        #   时那份坏掉的 embed.js 还在盘上，于是"无辜的 L13i"变红 →
        #   误判成"对照用例误报"。复位是一次性、廉价的，必须做。
        open(CSS, "w", encoding="utf-8").write(css_bak)
        open(EMB, "w", encoding="utf-8").write(emb_bak)
        write()
        f, p = run()
        results.append((name, f, p, None))
finally:
    open(CSS, "w", encoding="utf-8").write(css_bak)
    open(EMB, "w", encoding="utf-8").write(emb_bak)

print("=" * 62)
print("反向测试（任务26 / L13）：缺陷回归时断言必须变红")
print("=" * 62)
allred = True
for name, f, p, err in results:
    if err:
        allred = False
        print("⚠️  " + name + "  —— " + err)
        continue
    # 「对照」类注入：期望**保持绿**（断言不许误报）
    if "对照" in name:
        if not f:
            print(f"✅ 保持绿 {name}   (红0/绿{len(p)})")
        else:
            allred = False
            print(f"❌ 误报！  {name}   (红{len(f)}/绿{len(p)})")
            for x in f[:3]:
                print("       └ " + x[:96])
        continue
    if f:
        print(f"✅ 变红   {name}   (红{len(f)}/绿{len(p)})")
        for x in f[:3]:
            print("       └ " + x[:96])
    else:
        allred = False
        print(f"❌ 假绿！  {name}   (红0/绿{len(p)})")

f, p = run()
print("-" * 62)
print(f"还原后 baseline：L13 红={len(f)} 绿={len(p)}（应为 0 / 14）")
print("结论：" + ("全部注入都能被检出 ✅" if allred else "存在假绿，断言需加强 ⚠️"))
sys.exit(0 if allred and not f else 1)

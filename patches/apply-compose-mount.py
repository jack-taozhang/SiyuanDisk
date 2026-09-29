"""在 docker-compose.yml 的 nebula.volumes 末尾插入 app-overrides 单文件挂载。

用 Python 做「锚点插入」，不用 sed —— 避免缩进/编码踩坑。
幂等：已存在则跳过。
"""
import io, sys, re

PATH = "/vol1/1000/NebulaDisk/docker-compose.yml"
ANCHOR = '      - "/vol1/1000/项目设计:/mnt/项目设计"\n'
ADD = (
    "\n"
    "      # ★ /oo 承载页修复（2026-09-30）：OnlyOffice「在浏览器中打开」\n"
    "      #   为什么覆盖单个 pages.py 而不是整个 app/ 目录：\n"
    "      #     单文件挂载只遮蔽这一个文件，镜像里其余 app/*.py 照旧可用；\n"
    "      #     挂目录会把镜像里的其他模块一起遮掉。\n"
    "      #   为什么需要这个覆盖：\n"
    "      #     blob:/data: 承载页是不透明来源，不带 Origin/Referer，\n"
    "      #     Chrome PNA 判 InsecureLocalNetwork ⇒ api.js 加载失败。\n"
    "      #     修法是把承载页放到真实 http origin（本站 :8088）。\n"
    "      #   ⚠️ 宿主机文件必须存在且完整：Docker 对「不存在的单文件挂载」\n"
    "      #      会**创建同名目录**，届时容器里 pages.py 变成目录 ⇒ 起不来。\n"
    "      - ./app-overrides/pages.py:/opt/nebula/app/routers/pages.py:ro\n"
)

src = io.open(PATH, encoding="utf-8").read()

if "app-overrides/pages.py" in src:
    print("ALREADY PRESENT (幂等跳过)")
    sys.exit(0)

if ANCHOR not in src:
    print("FAIL: 找不到锚点行：%r" % ANCHOR)
    sys.exit(2)

# 只替换第一处（nebula 服务内的），且确认它确实在 volumes 段里
idx = src.find(ANCHOR)
before = src[:idx]
if "NEBULA_MOUNTS" in before.split("services:")[-1] and before.count("volumes:") < 1:
    print("WARN: 锚点上下文可疑，仍继续")

out = before + ANCHOR.rstrip("\n") + "\n" + ADD + src[idx + len(ANCHOR):]
io.open(PATH, "w", encoding="utf-8", newline="").write(out)
print("INSERTED at offset", idx)
print("新文件行数:", out.count("\n") + 1)

#!/bin/sh
# ============================================================================
# NebulaDisk 后端 /oo 承载页 —— 一键部署（在 NAS 上以 root 执行）
#
# 用途：给 nebula 容器打上「OnlyOffice 在浏览器中打开」所需的 /oo 路由。
#
# ★ 幂等 ★：已打过补丁会跳过，不会重复追加。
# ★ 已验证 ★：本脚本对应的补丁在本实例实测通过
#   （无 Cookie→401；带 Cookie→200，docsAPI:true、零失败请求、OO 完整渲染）。
#
# 用法：
#   sh deploy-oo-patch.sh              # 只热改（docker restart，容器重建会丢）
#   sh deploy-oo-patch.sh --persist    # 热改 + 落盘 + 改 compose 挂载 + 重建容器
#
# ⚠️ --persist 会重建 nebula 容器（网盘中断约 10-20 秒）。
# ============================================================================
set -eu

PATCH_SRC="${1:-}"
MODE="${2:-}"
C=nebula
APP=/opt/nebula/app/routers/pages.py
HOSTDIR=/vol1/1000/NebulaDisk/app-overrides
COMPOSE=/vol1/1000/NebulaDisk/docker-compose.yml
MARK="OO STANDALONE SHELL"

die() { echo "❌ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

[ "$(id -u)" = "0" ] || die "请以 root 运行（sudo sh $0 ...）"

command -v docker >/dev/null || die "找不到 docker"

# ---------------------------------------------------------------- 1. 热改
echo "=== 1. 容器内追加补丁（幂等）==="
if docker exec "$C" grep -q "$MARK" "$APP" 2>/dev/null; then
  ok "已存在 $MARK —— 跳过"
else
  [ -n "$PATCH_SRC" ] && [ -f "$PATCH_SRC" ] || die "未指定补丁文件：$0 <patch.py> [--persist]"
  docker cp "$PATCH_SRC" "$C:/tmp/oo-patch.py" || die "docker cp 失败"
  docker exec "$C" python3 - <<'PY'
src = open("/opt/nebula/app/routers/pages.py", encoding="utf-8").read()
patch = open("/tmp/oo-patch.py", encoding="utf-8").read()
if "OO STANDALONE SHELL" in src:
    print("ALREADY PATCHED")
else:
    open("/opt/nebula/app/routers/pages.py", "a", encoding="utf-8").write("\n\n" + patch)
    print("PATCHED len=%d -> %d" % (len(src), len(src) + len(patch)))
PY
  ok "补丁已追加"
fi

# 语法自检（改坏了就别重启）
docker exec "$C" python3 -c "import ast;ast.parse(open('$APP',encoding='utf-8').read());print('SYNTAX OK')" \
  || die "语法检查失败，已中止（容器未重启）"

# ---------------------------------------------------------------- 2. 重启
echo
echo "=== 2. 重启 nebula 后端 ==="
docker restart "$C" >/dev/null
for i in $(seq 1 30); do
  sleep 2
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:8089/healthz" 2>/dev/null; then break; fi
done
ok "后端已起"

# ---------------------------------------------------------------- 3. 验证
echo
echo "=== 3. 验证 /oo 路由 ==="
CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8089/oo?mount=x&path=y" || echo 000)
echo "  /oo 无 Cookie => $CODE (期望 401)"
[ "$CODE" = "401" ] || die "/oo 路由异常（期望 401，实得 $CODE）"
ok "路由存在且鉴权生效"

# ---------------------------------------------------------------- 4. 持久化
if [ "$MODE" = "--persist" ]; then
  echo
  echo "=== 4. 持久化（落盘 + compose 挂载 + 重建）==="
  mkdir -p "$HOSTDIR"
  docker cp "$C:$APP" "$HOSTDIR/pages.py"
  # 单文件挂载要求宿主机文件存在且非空
  [ -s "$HOSTDIR/pages.py" ] || die "导出 pages.py 失败"
  ok "已导出 $HOSTDIR/pages.py ($(wc -c < "$HOSTDIR/pages.py") 字节)"

  if grep -q "app-overrides/pages.py" "$COMPOSE"; then
    ok "compose 已含挂载，跳过"
  else
    cp "$COMPOSE" "$COMPOSE.bak-oo-$(date +%Y%m%d-%H%M%S)"
    python3 - "$COMPOSE" <<'PY'
import io, sys
p = sys.argv[1]
ANCHOR = '      - "/vol1/1000/项目设计:/mnt/项目设计"\n'
ADD = ('\n      # ★ /oo 承载页（OnlyOffice 在浏览器中打开）；见 patches/README.md\n'
       '      #   单文件挂载：只遮蔽这一个文件，镜像里其余 app/*.py 照旧。\n'
       '      #   ⚠️ 宿主机文件必须先存在，否则 Docker 会创建同名目录。\n'
       '      - ./app-overrides/pages.py:/opt/nebula/app/routers/pages.py:ro\n')
s = io.open(p, encoding="utf-8").read()
if "app-overrides/pages.py" in s:
    print("ALREADY"); raise SystemExit(0)
if ANCHOR not in s:
    print("ANCHOR NOT FOUND"); raise SystemExit(2)
i = s.find(ANCHOR)
io.open(p, "w", encoding="utf-8", newline="").write(s[:i] + ANCHOR.rstrip("\n") + "\n" + ADD + s[i+len(ANCHOR):])
print("INSERTED")
PY
    ok "compose 已加挂载"
  fi

  ( cd /vol1/1000/NebulaDisk && docker compose config >/dev/null ) || die "compose 语法错误"
  ( cd /vol1/1000/NebulaDisk && docker compose up -d --force-recreate "$C" ) || die "重建失败"
  for i in $(seq 1 30); do sleep 2; curl -s -m 3 -o /dev/null "http://127.0.0.1:8089/healthz" 2>/dev/null && break; done

  echo "  --- 重建后复验 ---"
  docker exec "$C" md5sum "$APP"
  md5sum "$HOSTDIR/pages.py"
  CODE=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8089/oo?mount=x&path=y" || echo 000)
  echo "  /oo 无 Cookie => $CODE (期望 401)"
  [ "$CODE" = "401" ] || die "重建后 /oo 失效（实得 $CODE）"
  ok "持久化完成：容器重建后 /oo 仍在，且 md5 与宿主机一致"
fi

echo
echo "✅ 完成。插件侧需把「在浏览器中打开」指向 <网盘地址>/oo?mount=&path="

# patches/ —— 对**兄弟项目 NebulaDisk 后端**的补丁

> ⚠️ 这里不是本插件（`siyuan-nebuladisk`）的代码。
> 这些文件要应用到 **NebulaDisk 网盘后端**（另一个仓库 / 镜像）。
> 放在这里只是因为「改动是因本插件而起」，便于一起追溯。

## 为什么需要跨仓库补丁

`siyuan-nebuladisk` 的「在浏览器中打开」Office 文档时，需要一个**承载页**
来挂载 OnlyOffice。这个承载页**不能**由插件在前端生成 —— 原因见下。

### 三代承载页的失败史（都实测过，别再退回去）

| 代 | 承载页形态 | 结果 |
|---|---|---|
| 1 | `data:text/html;charset=utf-8,…` | ❌ 不透明来源（origin=null）⇒ Chrome 拒载 http 子资源 |
| 2 | `blob:http://<思源主机>/…` | ❌ **被 Chrome PNA 拦（`InsecureLocalNetwork`）** |
| 3 | **后端 `/oo?mount=&path=`（真实 http origin）** | ✅ 实测全绿 |

### 第 2 代失败的真根因（headless Chrome 矩阵实验）

同一 `origin=http://192.168.193.70:6806`、同一 `isSecureContext=false`：

| 宿主文档 | 请求 | Origin | Referer | 结果 |
|---|---|---|---|---|
| 真实 http `:6806` | script → `:8082/api.js` | 无 | **有** | ✅ |
| blob(`:6806`) | script → `:8082/api.js` | 无 | **无** | ❌ |
| blob(`:6806`) | script → **同源** `:6806` | 无 | **无** | ❌ |
| blob(`:6806`) | fetch → `:8082/api.js` | 无 | **无** | ❌ |

**blob（不透明来源）文档里发起的所有子资源请求都不带 `Origin`/`Referer`**，
Chrome Private Network Access 判定为「非安全上下文 + 更私有地址空间」，
**一律拦截 —— 连同源资源都取不到**。

⇒ 与 CORS 响应头、CSP、混合内容、端口**全都无关**，**改前端无解**。
⇒ 唯一出路：让承载页跑在**真实 http origin** 上。

实测 `:8089` / `:8082` / `:6806` 三个真实 origin 加载 `:8082/api.js` 全部成功。

---

## `nebula-oo-standalone-page.py`

一段**追加**到 NebulaDisk 后端 `app/routers/pages.py` **末尾**的代码，
新增路由：

```
GET /oo?mount=<网盘名>&path=<文件路径>[&embed=1]
```

要点：

- **鉴权走 Cookie**：`auth.current_user` **是同步函数（不要 `await`！）**。
  该页与网盘同源（`:8088`），浏览器**自动携带** `nebula_session` Cookie，
  所以**无需把 token 放进 URL**。
- **config 由后端生成**，不塞 URL：config 含 HS256 签名、约 2.9 KB，
  进 URL 会超长，还会把 JWT 写进浏览器历史与访问日志。
- 响应带 `Cache-Control: no-store`（config 里的签名有时效）。
- `</script>` / `U+2028` / `U+2029` 均已转义后再内联。

### 部署（容器内热改，**不持久**）

```bash
# 1) 追加补丁（幂等：已打过会打印 ALREADY PATCHED）
ssh <nas> "echo <pw> | sudo -S docker exec nebula \
  python3 -c \"
src=open('/opt/nebula/app/routers/pages.py').read()
...\""   # 见 tools/push-to-nas.py 同款的 python 追加写法
# 2) 重启后端
ssh <nas> "echo <pw> | sudo -S docker restart nebula"
```

⚠️ **容器内改文件不持久**：`/opt/nebula/app` 不是 bind mount，
镜像 `nebula:1.2.0` 来自 `docker load` 的 tar ⇒ 容器重建即丢失。

### 持久化（推荐，已在本实例实施）

把打好补丁的 `pages.py` 放到宿主机，并在 `docker-compose.yml` 的
`nebula.volumes` 末尾加**单文件挂载**：

```yaml
      - ./app-overrides/pages.py:/opt/nebula/app/routers/pages.py:ro
```

为什么是单文件而不是整目录：单文件只遮蔽这一个文件，
镜像里其余 `app/*.py` 照旧可用；挂目录会把其他模块一起遮掉。

⚠️ **宿主机文件必须先存在且完整** —— Docker 对「不存在的单文件挂载」
会**创建同名目录**，届时容器里 `pages.py` 变成目录 ⇒ 服务起不来。

### 验证

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://<nas>:8089/oo?mount=x&path=y'
# 期望 401（未登录）—— 说明路由在、鉴权生效

# 带 Cookie 时期望 200 且页面含 DocsAPI 引导脚本
```

真机端到端（headless Chrome）期望：
`docsAPI:true`、**零失败请求**、OnlyOffice iframe 尺寸非 0。

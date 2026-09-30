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

---

## `nebula-shortlink.py` + `nebula-shortlink-page-block.py`

「在浏览器中打开」的**短地址** `GET /f/<token>`。

### 为什么需要

用户报障原话：

    「在浏览器中打开 地址这么复杂？是否有必要」
    「oo 打开的地址就是很简单，这个是不是不对」

原生类型（图片 / pdf / 视频 / 音频 / 文本）原先走
`/api/raw/<文件名>?mount=..&path=..&exp=..&sig=..`，实测 **324 字符**。
长度是**结构性**的，前端做不了减法：

| 片段 | 长度 | 占比 | 能不能砍 |
|---|---|---|---|
| `path=` | 109 | 34% | 不能 —— 签名覆盖它，改一个字节就 403 |
| 路径段（文件名后缀重复一次） | 70 | 22% | 不能 —— kkFileView 靠它取后缀 |
| `sig=` | 69 | 21% | 不能 —— 缺了直接 422 |
| `mount=` | 43 | 13% | 能（挪进服务端映射） |
| `exp=` | 15 | 5% | 能（短链不带时间维度） |

⇒ 要短，只能让**服务端记一份映射**，URL 里只留一个随机 token。
所以用户那句判断是**对的**：`/oo`（Office）本来就是 Cookie 鉴权 + 短地址，
「OO 的很简单」没问题 —— **错的是图片 / pdf 那条走错了路**。

顺带修掉两个毛病：原来 1 小时就过期、且没法发给别人。

### 要改的后端文件（2 处）

| # | 文件 | 动作 |
|---|---|---|
| 1 | `app/shortlink.py` | **新增**，全文见 `nebula-shortlink.py` |
| 2 | `app/routers/pages.py` | **追加** `nebula-shortlink-page-block.py` 到**文件末尾**；另改 2 行 import |

`pages.py` 的两处 import 改动（漏了不是 422 就是 `NameError`）：

```diff
-from fastapi import APIRouter, Request
+from fastapi import APIRouter, Form, Request
-from .. import shares
+from .. import shares, shortlink
```

为什么要 `Form`：插件的 `apiPost()` 发的是 **multipart/form-data**，
FastAPI 写成 pydantic JSON 模型会 422（与 `/api/login` 同一约定，别改）。

### 新增的路由

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/api/shortlink` | 要登录 | 签发 / 复用短链（**幂等**） |
| `GET` | `/api/shortlinks` | 要登录 | 列出自己的短链（前端暂未接） |
| `POST` | `/api/shortlink/revoke` | 要登录 | 撤销一条 |
| `GET` | `/f/<token>` | **免登录** | 落地端：内联吐字节 |

数据落在**同一个 `nebula.db`**（`settings.data_dir/nebula.db`，WAL 模式），
`links` 表**惰性 + 幂等**创建 —— 这样不必改 `main.py`，也就少一处覆盖挂载。
`(owner, mount, path)` 上有唯一索引 ⇒ 同一个文件永远同一条短链
（不会「点一次生成一条」把库撑爆）。

### 安全模型：链接即凭证（capability URL）

`/f/<token>` **不要求登录** —— 谁拿到链接谁能看。这是**刻意**选的
（用户选的是「免登录，链接即凭证 …… 可直接发同事」）。代价与边界写清楚：

- token = `secrets.token_urlsafe(9)` = **12 字符 / 72 bit** ⇒ 不可枚举、不可猜
- **长期有效**：URL 里没有 `exp`，表里也没有过期字段
- **危险扩展名强制 `attachment`**：命中 `config.DANGEROUS_EXT`
  （exe / bat / js / ps1…）时绝不 inline —— 否则等于对外发了一个可执行的下载页
- 映射可见性仍按链接的 owner 复核 ⇒ owner 已看不到该映射时，链接同步失效
- 撤销只有 `POST /api/shortlink/revoke`（**还没有 UI 入口**）
- `?dl=1` 可强制下载（与 `/api/raw` 不同：这里的 `dl` **不进签名**，
  所以前端可以自由拼 —— 插件侧已收敛到 `withDl()` 一处）

⚠️ **别把短链贴到不受控的地方**：它免登录、且永久有效。

与既有「分享」`/s/<token>` 的分工（**别混**）：

| | `/s/<token>` | `/f/<token>` |
|---|---|---|
| 落地页 | 有 | 无（直取字节） |
| 有效期 | 可设（默认 7 天） | 永久 |
| 密码 / 访问次数上限 | 可设 | 无 |
| 场景 | **正式分享** | **自己在浏览器里打开**（顺带能发同事） |

### 部署

**路线 A：改源码（你手上那台有源码的机器走这条）**

1. 把 `nebula-shortlink.py` 放成 `app/shortlink.py`
2. 把 `nebula-shortlink-page-block.py` 追加到 `app/routers/pages.py` 末尾
3. 改上面那 2 行 import
4. 重启后端

⚠️ **先确认你的源码树不比运行中的容器旧。** 本实例实测：容器 `/opt/nebula/app`
有 **9 个文件比源码目录新**，还多一个 `routers/settings.py` ⇒ 上一轮的后端改动
（含 `/oo`）是**热补丁进容器的，没回写源码**。直接照源码改再重建镜像，
会把这些线上改动**回退掉**。所以：先 diff，再改。

**路线 B：单文件挂载（本实例在用的热补丁方式）**

```yaml
      - ./app-overrides/pages.py:/opt/nebula/app/routers/pages.py:ro
      - ./app-overrides/shortlink.py:/opt/nebula/app/shortlink.py:ro
```

为什么是单文件而不是整个目录：单文件只遮蔽这一个文件，
镜像里其余 `app/*.py` 照旧可用；挂目录会把其他模块一起遮掉。

⚠️ **宿主机文件必须先存在且完整** —— Docker 对「不存在的单文件挂载」
会**创建同名目录**，届时容器里 `pages.py` 变成目录 ⇒ 服务起不来。

### 验证

```bash
B=http://<nas>:8089

# 1) 签发要登录：未登录**绝不能** 200（否则谁都能替别人签长期链接）
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -F 'mount=售前项目' -F 'path=/some/file.jpg' "$B/api/shortlink"   # 期望 401/403

# 2) 落地端免登录，且是**吐字节**不是 302（302 会把地址栏变回那条长链，等于白做）
curl -s -D- -o /dev/null "$B/f/<token>"    # 期望 200 + image/jpeg，且**无** location 头

# 3) 危险扩展名强制下载（拿一个 .exe 的 token 试）
curl -s -D- -o /dev/null "$B/f/<token>"    # 期望 content-disposition: attachment

# 4) 幂等：同一文件签两次，token 必须相同
# 5) 撤销后立刻失效：POST /api/shortlink/revoke 之后 /f/<token> 应 404
```

本实例实测结论（`tools/_probe-copylink-permanent.cjs`，10/10）：

- **322 → 41 字符（-87%）**；`?dl=1` 形态 46 字符
- 短链与签名直链取到的字节**完全一致**
- `.exe` 强制 `attachment`、图片 `inline`
- 幂等、撤销即失效、负例 404

### 回滚

删掉 `app/shortlink.py` 与 `pages.py` 里的 SHORT LINK 区块（以及那 2 行 import），
重启即可。**插件侧会自动降级** —— `directLinkUrl()` 短链失败就静默回退到签名直链，
不会因为后端没这功能而报错。

---

### 还没做的（按性价比排序，供后续决定）

**P0-a 死链惰性自清（后端，改动最小）**

实测：删掉文件后旧短链变成「文件不存在」的 404 页（**不泄露内容**），
**但那条记录仍留在库里**（`hits` 照记）。对照同一条 `/api/delete`：
它**明确调了** `shares.revoke_under_path()`（响应带 `sharesRevoked` 字段），
而 `shortlink.revoke_under_path()` **零调用点** —— 同一个删除动作，
分享被清了、短链没清。

最小改法：`/f/<token>` 命中「文件不存在」时顺手删掉那一行。
好处是覆盖**所有**删除路径（含插件之外的删除 / 改名 / 移动），
且不用动 `fileops.py`（它不在覆盖清单里，动它要再加一条挂载）。

⚠️ 必须区分「文件真没了」与「盘挂了」—— 否则 NAS 抖动会把好链接误删。

**P0-b 短链管理面板（插件侧，用户可见收益最大）**

后端 4 个接口都现成，但**插件里没有任何入口**能看到「我到底有哪些短链」。
建议入口放 dock 工具条，列表给：文件名 / 路径 / 短链 / 创建时间 / 访问次数 /
操作（复制 · 打开 · 撤销），加**批量撤销**与**一键清理死链**。

**P1 补 `last_access_at`**

现在的字段是 `token/owner/mount/path/name/created_at/hits` —— 有访问次数，
但**没有**「最后一次访问时间」，也**没有** `expires_at`。
⇒ 你无法判断「哪条被外人看过」「哪条该清」。`bump()` 里顺手多写一列即可，
列表再按最近访问排序。

**P2 表加可空 `expires_at`**

这样「1 小时 / 7 天 / 永久」三档能用同一套字段表达，把 `/s/` 也统一进来。
现在不建议做（会牵动 `/s/` 的既有语义）。

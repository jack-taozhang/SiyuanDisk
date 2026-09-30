# 开发技术沉淀 · siyuan-nebuladisk

> 这份文档记录 **NebulaDisk 思源插件** 从零到可交付的完整技术过程：
> 架构决策、每一个真 Bug 的根因与取证方式、踩过的环境陷阱、以及可复用的验证方法论。
>
> **它不是使用说明** —— 使用说明见 [README.zh_CN.md](README.zh_CN.md)。
> 这份文档的目标读者是**未来要改这个插件的人**（包括几个月后的你自己）。

---

## 一、项目定位与不可逾越的边界

| 项 | 内容 |
|---|---|
| 目标 | 在思源笔记里浏览 / 预览 / 编辑 / 内嵌 NebulaDisk 网盘 |
| **硬边界 1** | **不修改思源笔记任何内容**（源码、配置、主题都不动） |
| **硬边界 2** | **不修改 NebulaDisk 前端与后端**（只通过它公开的 API 交互） |
| 部署目标 | 必须支持 **Docker 部署**的思源（NAS 场景是一等公民，不是兼顾） |
| 交付形态 | 一个思源可直接导入的插件包 |

> 这两条硬边界决定了后面绝大多数架构选择。任何时候想"顺手改一下服务端"，
> 先回来看看这一节——**它不在授权范围内**。

---

## 二、架构决策：为什么是这样的形状

### 2.1 为什么必须有本地转发层（`src/proxy.js`）

思源 `:6806` 与 NebulaDisk `:8089` 是**两个 origin**，而 NebulaDisk 侧：

- **没有 CORS 中间件** → 跨域 `fetch` 读不到响应体
- 会话 Cookie 是 **`SameSite=lax`** → 跨站请求不带 Cookie

这不是配置疏漏，是浏览器安全模型的必然。两条出路：

| 方案 | 做法 | 为什么不选 |
|---|---|---|
| 反代统一入口 | nginx 把两者变同源 | 要动 NAS 上已有的 nginx 与思源入口，超出插件范围 |
| **插件内起本地代理** | `127.0.0.1:6810` 截 Cookie 再补回 | ✅ 选定 |

**★ 关键设计点**：代理**不转发**，而是**保管 Cookie**。登录时截住 `Set-Cookie` 存进内存，
后续请求补回去。这样就同时绕开了 `SameSite=lax` **和**"必须给 NebulaDisk 加 CORS 头"两件事。

**安全约束**（代理绝不能变成开放转发器）：
- 只放行白名单前缀：`/api/`、`/preview/`、`/cad/`、`/website/`、`/s/`
- 绑 `127.0.0.1`，不绑 `0.0.0.0`
- 剥离 `X-Frame-Options` / CSP，并改写 HTML 内资源地址（否则 kkFileView、cad-viewer 无法被 iframe 嵌入）

> **为什么绑 `127.0.0.1` 在 Docker 里也能用？**
> 插件 JS 无论思源跑在宿主机还是容器里，**都在思源进程内执行**，
> `127.0.0.1` 对它永远指向思源自己所在的环境。

### 2.2 为什么嵌入用「代码块」而不是「挂件」

| 方案 | 问题 |
|---|---|
| 挂件（widget） | 跑在独立 iframe 沙箱，**拿不到插件登录态**，等于要从头再做一遍认证 |
| **自定义块**（`;;;siyuan-nebuladisk/nebuladisk`） | ✅ 由插件进程直接渲染，复用同一通道 |

代码块还有两个白送的好处：
1. **纯文本** —— 同步、导出 markdown 都不丢；最坏情况退化成一段可读的 JSON
2. 渲染契约由 **`data-info`** 属性驱动，插件在 `customBlockRenders` 里注册即可

**★ 围栏必须是 `;;;` 且必须顶格**：反引号 ```` ```nebuladisk ```` 只会生成普通代码块
（`type=c`），自定义块渲染器**根本不会被触发**；而 `;;;` 前面有前导空格或任何字符
也会不认（`[;;;siyuan-…` → `type=p`，裸 JSON）。这一条踩了整整一轮，见 §4.3。

### 2.3 三层按需加载（性能设计）

嵌入块里跑的是 kkFileView / OnlyOffice 真实预览页，都很重。一篇笔记嵌十几个，
若打开即全部加载，思源会被拖垮。所以：

| 层 | 规则 | 效果 |
|---|---|---|
| 1 | 打开笔记时**一个都不加载**，只显示「点击预览」 | 打开笔记对后端请求数 = **0** |
| 2 | 点击后才加载；**想展开几个就几个，互不干扰** | 内存 ∝ **用户实际展开的个数** |
| 3 | 「收起」**销毁 iframe**（非隐藏）+ 回收 OO blob | 手动即时释放 |

上层的实现要点：维护 `openEmbeds: Set<{wrap, collapse}>` —— **每个块各登记一条**。

> ★ 曾被误写成「同一篇文档里只允许展开**一个**、展开新的会把旧的顶掉」。那是**早期**的节流实现
> （`Map<docKey, …>`，每文档只记一个），**已按用户要求删除**：同一篇笔记里对照看
> 文档 + 表格是刚需，程序不该替用户收起。现在任何时刻都不会自动收起别的块；
> `collapseAllOpenEmbeds()` 只在**插件卸载**时统一释放（且跳过已脱离 DOM 的孤儿节点）。
> 详见 `src/embed.js` 顶部注释与 `registerOpenEmbed` / `openEmbeds`。

---

## 三、类型路由：本插件最容易出 Bug 的地方

### 3.1 路由表（唯一真相源）

`src/api.js` 的 `pickViewer(name)` 是**所有类型判断的唯一入口**，返回：

```
image | video | audio | pdf | office | cad | text | archive | download
```

页签渲染（`viewer.js`）与"在浏览器打开"（`browserViewUrl`）**必须走同一套路由** ——
两处判断逻辑分叉，正是任务 #62 那个 Bug 的温床。

### 3.2 ★ `/api/raw` 是「字节通道」，不是「渲染通道」★

这是**本项目最重要的一条认知**，代价是一轮完整的用户报障。

**现象**（用户原话）：
> CAD 页签的「在浏览器打开」变成了下载；OnlyOffice 一样；kkViewer 一样；
> 只有 PDF 是在网页中打开。

**实测响应头**（裸 socket 读 NAS，非推断）：

| 类型 | Content-Type | Content-Disposition | 浏览器行为 |
|---|---|---|---|
| PDF | `application/pdf` | `inline` | 内嵌打开 ✅ |
| DOCX | `…wordprocessingml.document` | `inline` | **下载** ❌ |
| DOC | `application/msword` | `inline` | **下载** ❌ |
| STEP | `model/step` | `inline` | **下载** ❌ |

**⇒ 结论：`Content-Disposition: inline` 一直都有，它从来不是问题。**

> 浏览器**只原生渲染极少数 MIME**：`application/pdf`、图片、视频、音频、`text/*`。
> Office / CAD 这类专用 MIME **浏览器没有渲染器**，即使 `inline` 也只能下载。
> PDF 恰好被支持 ⇒ 同一段代码只有 PDF "看起来是对的"。

**正确做法**：按 `pickViewer()` 的分流选**渲染通道**，而不是一律开 raw。

| kind | 浏览器打开用哪条地址 |
|---|---|
| `pdf` / `image` / `video` / `audio` / `text` | `/api/raw` 签名直链（原生渲染、零转换） |
| `office` / `archive` / `download` | `/api/preview` → kkFileView `/preview/onlinePreview`（返回 `text/html`） |
| `cad` | `/api/cad/preview` → cad-viewer 深链 |

**为什么不把 office 送给 OnlyOffice？**
OO **不是无状态查看页** —— 它需要 `document.key` + `callbackUrl`，每次打开都可能触发回调写回。
用户要的是"看一眼"，不该为此起一个编辑会话。kkFileView 是只读渲染、无副作用。

### 3.3 主机名改写：`nebula:8088` 绝不能给浏览器

后端返回的 raw / OO 配置里的地址是 **`http://nebula:8088/...`** —— 这是
**容器内主机名**，给 OO 容器服务端回拉用的。

**直接丢给浏览器 = `ERR_NAME_NOT_RESOLVED`。**

所以所有要交给浏览器的地址都必须过 `browserReachableUrl()` 把主机改写成外部可达地址
（`192.168.193.70:8089`）。

### 3.4 单一通道：直连

**插件只有一条通道**（2026-09-30 起）：直接请求网盘地址，带 `Authorization: Bearer <token>`。
后端已开 CORS（`allow_origins=["*"]` + `allow_credentials=False`），跨源不需要任何本地中转。

| 通道 | 何时使用 | 基点 |
|---|---|---|
| `direct` | **唯一的通道**（桌面端 / NAS / Docker 都一样） | `serverBase()` = `http://192.168.193.70:8089` |

> **★★ 内置代理已整体删除（2026-09-30）★★**
> 它曾是「后端还没开 CORS」时代的兜底：插件在思源渲染进程里起一个
> `127.0.0.1:6810` 的转发代理（`proxyBase()`）。
> 删除理由：
>   · 直连端到端可用，代理是**纯增的失败面**（会死、会占端口、会被复用）
>   · 它的启动状态一度被误当成「通道就绪」的判据 ⇒ 直连明明可用时，
>     嵌入块却拒绝渲染并显示「网盘通道未就绪：代理未启动」
>   · 唯一不可替代的职责（改写预览 HTML 里的资源地址）在直连下不需要 ——
>     iframe 直接指向网盘自身（同源）
> 若要回看，见 git 历史里的 `src/proxy.js`。

> **★ 历史故障（值得反复看）★**
> `downloadUrl()` 里曾**写死** `proxyBase()`（`127.0.0.1:6810`）。
> 在 NAS 部署（浏览器直连）下，`127.0.0.1` 指的是**用户自己那台电脑**，
> 那里根本没有代理进程 ⇒ 所有下载、图片/视频/文本预览全变成
> `ERR_CONNECTION_REFUSED`。
> 用户报的"下载会报错"、任务⑧"图片/视频/文本都打不开"，根因都是这一行。

**为什么不用 `/api/download`？**
它认 Cookie 会话，而直连是**跨源**的（思源 :6806 → 网盘 :8089），拿不到 Cookie ⇒ 401。
所以直连走签名直链 `/api/raw/<name>?mount=&path=&exp=&sig=` ——
签名校验与 Cookie 无关，且 raw 支持 `Range`（视频能拖进度）。

---

## 四、真 Bug 根因档案（每一个都经过实测取证）

> 这一节的每个结论都有**可复现的实测证据**，不是推断。
> 凡是我猜过又被推翻的假设，也一并记下来——**证伪同样是知识**。

### 4.1 搜索结果永远不对（后端真 Bug）

**根因**：`nebula/app/routers/fileops.py::api_search` 里
```python
if len(hits) >= cap: break      # ← 在【收集阶段】就提前退出
```
于是返回的是 `os.walk` 顺序下的**前 cap 条**，之后才排序 ——
一个**任意子集**，却看起来像"全部结果"。且**没有分页**，剩下的永远拿不到。

实测：盘里 4,520 个 `*.pdf`，接口回 500 条、无 total、`scanned=5399`（提前退出）。

**修复**：改成「收集 → 排序 → 分页」三段式
- 收集上限（`_SEARCH_MAX_COLLECT = 5000`）与返回上限**解耦**
- `total` 在循环里累加 = **真实命中总数**，与 limit 无关
- 新增 `_hit_rank()`：1=同名 2=前缀 3=扩展名精确 4=子串
- 新增 `offset`，返回 `hasMore` / `truncated`
- 提前退出**只允许**由 `scanned > _SEARCH_MAX_SCANNED` 触发（防爆），不再由命中数触发

实测：`pdf` → `total=4526`；offset 0/5/10 三页**零重叠零缺口**；同请求两次 MD5 相同。

> **★ 这条修复越出了「不改 NebulaDisk」的边界，是经用户明确授权后做的。**
> 插件侧只做 UI 对齐（显示 `已显示 / 总数`）。

### 4.2 静态检查的价值：「只在调用路径上炸」的错误

现象：`typeIconEl(ext)` 只接受**扩展名**，但四个调用点里有三个传的是**文件名**
（`typeIconEl(e.name, e.isDir)`）⇒ 永远匹配不上 `TYPE_TABLE` ⇒ 静默退化成
"名字前 3 字符 + 灰色"。

**这四类检查都抓不到它**：
- `node --check`（只查语法，不查名字）
- 单元测试（可能没覆盖那条模块）
- 手动点几下（没触发那条路径就看不见）

**修法**：`test/syntax.check.js` 把每个 `import { X } from "./y.js"` 与
`y.js` 实际导出做**交叉比对**，这类错误在写代码当下就报出来。

> 同时新增 `tools/_sim-picker-render.cjs` —— 用 jsdom 加载**真实 bundle**、
> 真的 `new Picker()` → `open()` → 输入关键词 → 断言 DOM。
> 纯文本静态断言证明不了运行时行为，必须有一个真渲染冒烟。

### 4.3 「裸 JSON」事件：一个契约问题查了十几轮

症状：嵌入块渲染出来是**一坨裸 JSON 文本**，不是预览。

**先后被证伪的假设**（都在日志里留了痕）：
1. `customBlockRenders` 注册键不对
2. `data-info` 契约不对
3. `viewer.js` 反引号转义问题
4. 前端 insert 通道没走对

**真凶（两个，叠加）**：
- **围栏必须是 `;;;` 且顶格** —— 反引号 ```` ```nebuladisk ```` 只生成 `type=c` 普通代码块；
  即便用了 `;;;`，前面有任何空格或字符也不认（`[;;;siyuan-…` → `type=p`）
- **三处插入点各有"前置判空拦截"** —— 静默 return，不报错

> **这个事件的方法论教训**：
> 一个症状背后往往是**多个独立缺陷叠加**。
> 修好其中一个，症状不变，于是你误以为"猜错了"→ 继续瞎猜。
> **正确姿势**：每一轮只改一处，改完**立刻实测**，逐条排除。
> 这也是用户反复强调「你不要猜了，一步一步验证」的由来。

### 4.4 「构建了但从未部署」（#56 网格拖拽全死）

**我先证伪了自己的第一假设**：怀疑 `user-select: none` 掐死了拖拽。
用真 Chrome（CDP `Input.dispatchMouseEvent` 完整 drag 序列）打**真实 CSS + 真实嵌套 DOM**
→ **`dragstart` / `dragend` 都正常触发** ⇒ **CSS/DOM 从来不是问题**。

**真因（活体测量）**：
- 容器内 `index.js` = 470,383 字节 `sha 89ec5880...`
- 关键指纹 `attachEmbedDrag` 出现次数 = **0**
- ⇒ 部署的是**任务30 重构之前**的产物

**这一条事实同时解释了两个现象**：网格拖拽全死 + 搜索结果拖拽无效。
（#56 和任务30 是**同一个根因**，不是两个 bug。）

**修复** = 重新构建 + 重新部署。

> **教训**：报"功能没生效"时，**先量部署产物的指纹**（大小 / sha / 关键符号计数），
> 再去看代码。代码可能早就对了，只是没上线。

### 4.5 图标契约：`typeIconEl` 的四个调用点

`typeIconEl(ext, isDir)` 修正后，**必须找齐所有调用点**，这是最容易漏的地方：

| # | 位置 | 原状 |
|---|---|---|
| 1 | `tree.js` 搜索结果行 | 传错参数 |
| 2 | `tree.js` 网格单元 | 传错参数 |
| 3 | `tree.js` 文件树节点行 | ★ 目录走另一套裸 `<svg>`，后才发现 |
| 4 | 根 `index.js` 的 `Picker.makeRow` | ★ 用 emoji 📁/📄 |
| 5 | `src/embed.js` 嵌入块文件树 | ★ 也是 emoji |

> **教训**：同一类 UI 元素（图标）在项目里往往有多套**历史实现**。
> 改之前先全局 grep 一遍"这个元素还有哪里有"，不然改一半等于没改。

### 4.6 网格图标撑满高度：Grid 的 `align-content` 默认值

根因：`.nb-grid { flex:1 }` 没写 `grid-auto-rows` ⇒ Grid 的 `align-content`
默认 `stretch` ⇒ **每行被拉伸去填满容器**。

修法：`grid-auto-rows: 92px` + `align-content: start` + `.nb-cell { height:92px }`（双保险）。

---

## 五、验证方法论（本项目最值钱的部分）

### 5.1 ★ 反向测试：恒为真的断言等于没有断言 ★

每一条断言都必须配一个**能让它变红**的注入。否则你无法区分
"功能正确" 与 "断言写错了/根本没执行"。

**反面教材（真发生过）**：第一版"旧 CSS"反向注入里，
`.nb-result-path` 只写了 `overflow`，**没写 `max-width` / `flex-shrink`**。
结果线上 CSS 的 `42%` / `999` 依然生效 ⇒ D5/D6/D7 显示"仍绿"，
看起来像"注入无效"，实际是**我没覆盖到**。

> **CSS 不会因为"我没写"而还原成默认值；"没写" = 不干预 = 保持原值。**

⇒ 反向注入必须**显式覆盖每一个被测属性**（必要时 `!important`）。

修正后：D1/D2/D5/D6/D7 共 **5/7 变红**；D4/D8 保持绿是**应当如此**
（D4 阈值 ≤18px，旧值 15px 本就合规；D8 在隔离探针里两种 CSS 都有 overflow 省略，
不会触发截断 —— 该判据在此场景下偏弱，**已知局限，如实记录**）。

### 5.2 ★ 真机验证：静态断言证明不了运行时行为 ★

| 层次 | 能证明什么 | 不能证明什么 |
|---|---|---|
| `node --check` | 语法对 | 名字对、行为对 |
| 源码文本断言 | 代码里"写了这句话" | 运行时真的走到 |
| jsdom 冒烟 | 真实 bundle 的渲染逻辑 | CSS 布局、真实网络 |
| **真浏览器 CDP** | **真实浏览器里的真实行为** | —— 这是最终判据 |

**#62 的验收就是这么做的**：headless Chrome + CDP，访问**真实的 NAS**，
对新路径四种类型全部渲染、**下载事件 = 0**；
反向对照（旧 `/api/raw` 路径）**DOCX/DOC/STEP 各触发 2 个下载事件**，PDF 不下载
—— **与用户描述完全吻合**，证明断言真的能变红。

### 5.3 ★ 部署验证：比对字节，而不是比对"我拷贝了" ★

"文件拷过去了" ≠ "服务在用它"。验证方式：
**从线上服务端把文件拉回来算 sha256**，与本地构建产物比对。

```
http://192.168.193.70:6806/plugins/siyuan-nebuladisk/index.js  →  sha256 逐字节一致
```
这才是"部署生效"的证明。

### 5.4 几何归属 ≠ 功能正确

一个元素在 DOM 里的**位置/归属**正确，不代表**功能**正确。
比如"按钮在正确的容器里" 与 "点它有反应" 是两件事。
判据要设计成**能区分这两者**的形式。

---

## 六、环境陷阱档案（这台机器 / 这套网络专有）

> 这些坑与业务无关，但每次踩都要花时间。记在这里，下次直接绕过。

### 6.1 SSH 到 NAS（`192.168.193.70`）

- **没有 `sshpass`**，`paramiko` 也是坏的 ⇒ 用 **`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`**
- ★ `SSH_ASKPASS` 的值必须是 **Windows 原生路径**（`.bat`）；
  用 MSYS 形式 `/c/...` 会 `posix_spawnp: No such file or directory`
- ★ **多层引号必炸**：`ssh host "sudo bash -c \"...\""` 会让远端吃到半截脚本
  ⇒ 正确姿势：**把脚本写成本地文件 → `ssh host 'cat > /tmp/x.sh' < 本地文件` → 执行文件**
- ★ `docker exec -i sh < script` 会与 `sudo -S` 的密码 stdin 打架 ⇒ **静默空输出**
  ⇒ 必须 `docker cp` 脚本进容器，再 `docker exec sh /tmp/script.sh`

### 6.2 本机 Bash 工具链残缺

`dirname` / `ls` / `cd` / `cat` / `head` / `tail` / `grep` / `wc` / `tr` 全都没有。
⇒ **一律走「显式解释器绝对路径 + Python/Node 脚本文件」**。

- ★ **多行 Python 绝不能塞进 `python -c "..."`** —— bash 会先吃掉
  `$(...)`、反引号、成对引号 ⇒ 脚本被切碎成几十条 `command not found`，
  而且**静默不写文件**。
  ⇒ 超过 3 行的脚本/文本，**一律先 Write 成文件再执行**。

- ★ **Windows 原生程序要 `C:/...` 路径，不要 MSYS 的 `/c/...`**
  （`/c/...` 会被当成"当前盘根下的 c 目录"）

### 6.3 本机有「批量删除守卫」

`sitecustomize.py` 对**一次 turn 内超过 50 个文件**的删除直接 `SystemExit(1)`。
它会连带拦住这些**看起来与删除无关**的操作：

| 操作 | 为什么被拦 |
|---|---|
| `rm -rf <大目录>` | 本身就是删除 |
| **`pip install --upgrade <已存在的包>`** | pip 要**先删旧文件** |
| **`pip download`** | pip 会清理临时构建目录 |
| **`pip install --force-reinstall`** | 卸载+重装，删除量最大 |

> **★ 最危险的坑**：`--force-reinstall` 中途被掐断会**把包删残**，
> 而且**"import 还能过"** —— 空目录退化成**命名空间包**，
> 症状是 `AttributeError: module 'X' has no attribute 'Y'`，
> **看起来完全不像安装问题**。
> ⇒ **在这个环境里永远不要用 `--force-reinstall`。**

### 6.4 探测容器内文件

**先 `docker cp` 进容器再 `docker exec sh /tmp/x.sh`**。
直接 `docker exec -i sh < script` 会与 `sudo -S` 的密码 stdin 打架 ⇒ 静默无输出
（即使用 `echo pw | sudo -S docker exec -i` 也一样抢 stdin）。

### 6.5 compose 有 `.env` 陷阱

缺变量时 compose 会**报缺值但继续跑**（有时用空值），导致卷挂载到意外路径。
⇒ 起栈前先 `docker compose config` 检查。

### 6.6 `http.client` 拿不全响应头

chunked / gzip 时 `Content-Length`、`Content-Type` 可能是空。
⇒ 要拿**真实**响应头就用**裸 socket** 发 `GET ... HTTP/1.1` 再原样读回。
**#62 的关键证据就是这么拿到的。**

### 6.7 CDP 探针

- `Target.createTarget` **不接受** `width` / `height`
  （传了会不返回 `targetId` ⇒ `TypeError: Cannot read properties of undefined`）
  ⇒ 尺寸走 `Emulation.setDeviceMetricsOverride`
- `cdp-helper.cjs` 的 `ws.send(method, params)` **返回 Promise**；
  自己捏 `{id,...}` 帧会**静默挂死**
- `goto` 之后**必须 sleep** 再取，否则读到旧 document
- **探针隔离容器会让元素继承宿主 `body` 的字号** ——
  量插件自己的字号必须放进插件作用域（如 `.nb-picker`）再 `getComputedStyle`

---

## 七、测试体系

### 7.1 套件清单

```bash
node tools/run-all-tests.cjs     # 全量（21 套件）
node test/syntax.check.js        # 语法 + import 目标 + 导出符号匹配 + 清单完整性
node test/proxy.test.js          # 代理单元测试（白名单 / Cookie / HTML 改写 / 错误可读性）
node test/embed.test.js          # 嵌入块解析
```

当前状态：**726 通过 / 0 失败**（21 个套件）。

### 7.2 命名约定

| 前缀 | 含义 |
|---|---|
| `verify-*.cjs` | **契约/行为**断言（正向） |
| `reverse-*.cjs` | **反向注入**测试（证明正向断言能变红） |
| `_sim-*.cjs` | 模拟器（真 bundle + jsdom 跑渲染逻辑） |
| `_*.py` | 一次性排查脚本（通常不长期保留） |

### 7.3 ★ 构建必须两条都跑 ★

`tools/build.js` **默认只写** `D:\Software\SiYuan\...`，**不写 `dist/`**。
必须显式加 `--repo` 才同步仓库 `dist/`。

本轮因此让冒烟测试读到**旧产物**、误判 3 条失败，排查了一会儿才想到是产物 stale。

⇒ **以后重建一律两条都跑**（本机环 + `--repo`）。

---

## 八、部署（四环 + 镜像）

### 8.1 插件的四个环

| 环 | 路径 |
|---|---|
| ① 源码 | `D:\Docker\SiyuanDisk\data\plugins\siyuan-nebuladisk\` |
| ② 仓库留档 | `<repo>/dist/` |
| ③ 本机思源 | `D:\Software\SiYuan\data\plugins\siyuan-nebuladisk\` |
| ④ **NAS 思源** | `/vol1/docker/project/dk_app/siyuan/siyuan_E4Xr/data/data/plugins/siyuan-nebuladisk/` |

> ★ NAS 宿主路径有**双层 `data`**（`data/data/`），实测确认。

### 8.2 规范部署脚本

`C:\temp-nb\deploy-plugin.py`：
本地 `tarfile` 打包 → `scp`（3 次重试）→ `sudo tar -xf` 到 `/tmp/nb-plugin-stage`
→ NAS 上 `sha256sum` 比对 → 容器内留旧档 `index.js.bak-tXX`
→ `docker cp stage/. CONTAINER:CPATH` → 容器内 `sha256sum` 再比对
→ `docker restart` → 轮询。

### 8.3 NebulaDisk 镜像（`nebula:1.0.0`）

**★ 构建上下文是 NAS 宿主，不是容器 ★**
`/vol1/1000/Docker/NebulaDisk/nebula/` 放源码（`Dockerfile` / `web/` / `app/` / `build.sh`）。
`build.sh` 里：

```bash
IMAGE="nebula:1.0.0"
MSYS_NO_PATHCONV=1 $DK build --network=host -f "$DOCKERFILE_DOCKER" -t "$IMAGE" "$CTX_DOCKER"
```

> `build.sh` 同时兼容 **Git Bash**（`pwd -W` → `D:/...`）与 **Linux**（`pwd` → `/vol1/...`）。
> 在 NAS 上直接 `bash nebula/build.sh` 可用；`--check` 可先干跑。

**★ 重建容器必须用正确的 compose 项目 ★**

容器 `nebula` 的 compose 标签指向 **`/vol1/1000/NebulaDisk/docker-compose.yml`**
（注意：**旧的** `/vol1/1000/NebulaDisk/`，不是 `/vol1/1000/Docker/NebulaDisk/`）。

```bash
cd /vol1/1000/NebulaDisk
docker compose -p nebuladisk -f docker-compose.yml -f docker-compose.mounts.yml \
  up -d --force-recreate --no-deps nebula
```

> 用错文件（如 `nebula/docker-compose.yml`）会报
> `network deploy_default declared as external, but could not be found`
> 而**容器根本没被重建** —— 必须核对重建前后的 image ID。

**`image: nebula:1.0.0` + `pull_policy: never` 的语义**：
只要本地存在这个 tag 就复用。重新 `docker build` 会刷新 tag → 指向新 image ID，
但它**不会自动重建正在运行的容器**，必须显式 `--force-recreate`。

**容器热补丁 ≠ 镜像变更**：
直接改容器内 `/opt/nebula/web/index.html` 是**临时的**，下次重建会被新镜像 `COPY` 覆盖。
补丁必须**固化进宿主源码树**（`nebula/web/index.html`），否则重建即丢失。

**镜像产物**：`docker save nebula:1.0.0 -o /vol1/1000/Docker/nebula-1.0.0.tar`
（约 1.8GB；同时生成 `.sha256`）。

### 8.4 首页品牌图标的位置

NebulaDisk Web UI 里的"云 + 上箭头"品牌图标**有 5 处**，各自独立：

| 位置 | 文件行 | 尺寸 |
|---|---|---|
| 启动遮罩 | `index.html:33` | 64×64 |
| **任务栏开始按钮 `#btn-start`** | `index.html:71-76` | 22×22 |
| 登录页 logo | `index.html:193` | 大 |
| `js/icons.js:236` `Icons.app()` | —— | **0 个调用点（死代码）** |
| `share.html:27` | 分享页 | —— |

> **★ `Icons.app()` 注释写着「应用图标（任务栏 / 开始菜单）」，但 grep 证明它
> 一个调用点都没有。** 真正的开始按钮图标是 `index.html` 里的**内联 HTML**。
> ⇒ **注释会撒谎，grep 不会。**

---

## 九、SVG 处理的一条硬规矩

**★ 绝不能对 SVG 的 `d` 字符串做数字正则缩放 ★**

`d` 里含标志位（`a3 3 0 0 0`）、隐式分隔符、以及像 `0.7-13.9` 这样的数字连写。
天真的 `re.sub(r'(-?\d*\.?\d+)', ...)` 会把**跨分隔符的数字合并**，产出坏数据
（实测得到 `a3 3 0 0 0.75-0.075`、`0.750.3750.022`）。

**正确做法：不缩放路径，改 `viewBox`** —— SVG 自己会缩。

> 这次是靠**往返自检**（scale → unscale 应还原）发现损坏的（报 `❌ 不一致`）。
> 如果当时"看着差不多就存了"，就会往产品里塞一个坏图标。

---

## 十、版本历史（任务编号 → 内容）

| 阶段 | 内容 |
|---|---|
| 需求 ①②③ | 侧边栏文件树 / 预览与在线编辑 / 笔记内嵌 —— 主体三大功能 |
| 任务③④ | 嵌入块后端支持 + 「打开网盘」深链 |
| 任务⑦ | 右键菜单 |
| 任务⑧ | 格式路由完整梳理（图片/视频/音频/文本原生） |
| 任务⑨⑩⑫ | `.txt` 轻量直出 + 相关修复 |
| ⑬–㉑ | 交付自洽性、OnlyOffice 地址、ref 快照 |
| 任务 24 | 搜索正确性（后端真 Bug）+ Picker 加搜索 |
| 任务 25 | 图标模式固定高度 + 文件/文件夹图标 |
| 任务 29 | 图标美化（网盘风格） |
| 任务 30 | 拖拽重构（`attachEmbedDrag` 统一接线） |
| 任务 31 | 嵌入块 CAD 预览「只留图纸」 |
| #54 | 网格面包屑语义（`displayCrumbPath`） |
| #55 | 文件夹取消拖拽（在**源头**掐） |
| #56 | 网格拖拽全死（= 构建了但没部署） |
| **#62** | **「在浏览器打开」变成下载 → `browserViewUrl` 类型路由** |
| #63 / #64 / #65 | 结果行密度 / Picker 尺寸 / 长文件名不遮挡 |
| **#67** | **网盘开始菜单图标 → 换成插件网盘图标；重建镜像并导出 tar** |
| 1.0.1 | 插件版本 1.0.0 → 1.0.1（类型路由 + UI 密度 + 图标变更的归集），按 `build.js` → `pack.js` 全链重建 |
| 文档勘误 | **修正 README / DEVELOPMENT 里嵌入块的围栏写法**：反引号 ```` ```nebuladisk ```` 是**错的**（只生成 `type=c`），正确是 `;;;siyuan-nebuladisk/nebuladisk` 且**顶格** |
| 文档勘误 ② | **修正「同一篇文档里只允许展开一个 / 展开新的会把旧的顶掉」**：这是**已删除**的早期节流，现为多块互不干扰（`openEmbeds` 集合）；连带改正「内存=常数」→「内存 ∝ 实际展开数」 |

---

## 十一、下次改代码前的检查清单

- [ ] 改动是否触碰了思源或 NebulaDisk 的源码？（**不该碰**）
- [ ] 新增断言配了能让它**变红**的注入吗？
- [ ] 类型判断是否仍**统一走 `pickViewer()`**？（别新增第二套分支）
- [ ] URL 构造是否**按通道选基点**？（别写死 `127.0.0.1`）
- [ ] 交给浏览器的地址是否过了 `browserReachableUrl()`？
- [ ] 是否有**多套历史实现**的同类 UI 需要一起改？（先 grep）
- [ ] 构建是否**两条都跑**（本机环 + `--repo`）？
- [ ] 部署后用**线上 sha256** 验证了吗？
- [ ] 若改了 Web UI，**固化进宿主源码树**了吗？
- [ ] 重建容器后**核对了 image ID** 变了吗？

---

*本文件随代码一起维护。改动架构或发现新根因时，请同步更新。*

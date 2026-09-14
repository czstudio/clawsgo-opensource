# AGENTS.md

> **AI 代理的仓库说明书。** 人类读者请先看 [README.md](./README.md)。

这个文件的目标：让任何一个 AI 代理在**不读完全部源码**的前提下，准确知道
「这是什么、东西在哪、怎么跑、怎么改、改完怎么验」。

---

## 0. 三个决定性事实

读任何一行代码之前，先记住这三点。它们决定了你该用什么姿势读这个仓库：

| # | 事实 | 对你的影响 |
|---|---|---|
| ① | **前端是原样产物，不是源码。** `app/assets/` 与 `site/` 是生产构建的 minified 文件（`api-pyi_9PXn.js`、`_shell-CSlH67JO.js` 这种带 hash 的名字） | 不要试图「修改前端源码」。要理解前端行为只能做**静态分析**（grep 字符串、还原调用点）。改前端行为的正确做法是在 `server/` 侧适配 |
| ② | **后端是重写的，不是抓下来的。** `server/` 下约 10.6k 行零依赖 Node 代码 | 线上后端源码不可得。这里每一条命令都是「按前端调用点反推出的契约」重写的。**契约的唯一权威是 bundle 里的调用点，不是你的直觉** |
| ③ | **验收是可执行的硬门槛。** `tools/e2e.mjs` 219 项断言 | 改任何东西之后必须重跑，必须 `失败 0`。这不是建议，是这个仓库的完成定义 |

---

## 1. 60 秒上手

```bash
node server/serve.mjs          # 零依赖，只需 Node 18+
```

| 地址 | 是什么 |
|---|---|
| http://localhost:5180 | 营销站（5 页静态） |
| http://localhost:5181 | 应用端 + 全部 API |

登录 `13800000000` / 验证码任意 6 位 / 密码 `clawsgo2026`；管理员 `13900000000` 可进 `/admin`。

```bash
node tools/e2e.mjs             # 219 项断言，约 25s，输出 docs/e2e-run.log + docs/e2e-report.json
node tools/glob.test.mjs       # glob→regex 回归（改 workspace.mjs 后必跑）
```

**验收可重复**：每轮开头自动调 `POST /__reset` 恢复出厂状态（清主机盘/工作区、重播种子）。
所以连跑十遍结果一致 —— 如果你看到「第二遍才失败」，那是幂等性 bug，不是测试问题。

### 开发时常用的三个隐藏端点

| 端点 | 用途 |
|---|---|
| `GET /__commands` | 自省：列出**真正注册进去**的全部命令名。文档生成与 e2e 覆盖检查都读它 |
| `POST /__reset` | 恢复出厂状态（`NODE_ENV=production` 下自动 404） |
| `GET /__shutdown` | 落盘后退出。**改了 `server/**` 必须重启**，没有热重载 |

---

## 2. 仓库地图

```
clawsgo-opensource/
├── AGENTS.md               ← 你正在读的文件
├── README.md               人类入口
├── NOTICE.md               权属 / 许可 / 发布前检查清单（⚠️ 公开前必读）
├── .gitignore              server/data 是运行时产物，已排除
│
├── site/                   营销站产物（Next.js 静态导出）：5 页 + _next 资源 + 图片
├── app/                    应用端产物（React SPA）
│   ├── index.html          SPA 外壳
│   ├── assets/             924 个产物文件（742 JS / 8 CSS / 174 字体·图片·wasm）
│   └── root/               站点根杂项
│
├── server/                 ★ 复刻后端（全部要改的东西都在这）
│   ├── serve.mjs           312 行。双端口启动、路由分发、SPA 回落、WS upgrade
│   ├── api/                HTTP 层：11 个域模块，导出 commands 注册表
│   └── lib/                基础设施：数据库/种子/形状/SSE/WS/agent/工作区/ZIP/multipart
│
├── tools/                  验收与生成脚本（见 §13）
├── contracts/              从 bundle 静态分析出的机器可读契约（见 §4）
└── docs/                   深度文档（见 §3 的阅读顺序）
```

### `server/` 逐文件职责

| 文件 | 行数 | 职责 | 什么时候动它 |
|---|---|---|---|
| `serve.mjs` | 312 | 双端口、`/__*` 开发端点、`/files/*` 网关、`/api/*` 转发、`/__pay/*` 收银台、DocsAPI 替身挂载、SPA 回落、WS upgrade | 加新路由 / 改静态托管 |
| `api/index.mjs` | 652 | **分发器**：命令注册表、四条传输通道解析、SSE 双通道入口、错误信封、token 轮换、`/files/*` 网关实现 | 加新命令 / 改信封与 CORS |
| `api/chat.mjs` | 858 | 会话、消息、发送、工作区入口、终端票据、分享 | 对话主链路 |
| `api/admin.mjs` | 1445 | 后台 67 条命令（用户/订单/邀请码/推广分佣/迁移/审计） | 后台功能 |
| `api/account.mjs` | 561 | 个人资料、项目、设备、智能体记忆 | 账号域 |
| `api/skills.mjs` | 624 | 技能安装/卸载/启停/文件读写 | 技能库 |
| `api/billing.mjs` | 479 | 套餐、订阅、充值、订单、发票、退款、兑换码 | 计费域 |
| `api/hosts.mjs` | 463 | 主机列表/状态/环境/存储/目录树/虚拟盘 | 主机域 |
| `api/support.mjs` | 346 | 工单、工单消息、附件（multipart） | 客服域 |
| `api/teams.mjs` | 319 | 团队、成员、邀请 | 团队域 |
| `api/auth.mjs` | 251 | 登录、OTP、会话探针、`userFromRequest`、token 签发 | 认证 |
| `api/files.mjs` | 183 | 头像、附件下载、二进制响应 | 文件直出 |
| `lib/agent.mjs` | 694 | **智能体循环**：工具调用、审批、流式 part、子智能体编排、标题生成 | 智能体行为 |
| `lib/workspace.mjs` | 923 | 会话工作区：目录树、读写信、Glob/Grep/Bash 工具、**迷你 shell** | 工作区与工具 |
| `lib/db.mjs` | 173 | 单文件 JSON 库、防抖落盘、`db$()` / `save()` / `load({force})` | 数据层 |
| `lib/seed.mjs` | 488 | 演示数据播种（用户/团队/主机/技能/订单…）+ `DEMO` 常量 | 改演示数据 |
| `lib/shapes.mjs` | 448 | **响应形状白名单**：把内部行转成前端期望的字段集 | 前端说「字段是 undefined」时 |
| `lib/plans.mjs` | 330 | 套餐价目、额度、模型倍率、年付/分佣/发票公式 | 计费规则 |
| `lib/reset.mjs` | 61 | `/__reset` 的实现（e2e 可重复的关键） | — |
| `lib/sse.mjs` | 177 | SSE 中枢：连接管理、运行态、11 种帧 | 加帧类型 |
| `lib/ws.mjs` | 223 | 自写 WebSocket（RFC 6455 握手/帧解析） | 终端协议 |
| `lib/zip.mjs` | 98 | 自写 ZIP 编码器（STORE 无压缩） | 打包下载 |
| `lib/multipart.mjs` | 71 | 自写 multipart/form-data 解析 | 附件上传 |
| `lib/office.mjs` | 246 | 文件签名直链 + ONLYOFFICE 会话构造 | Office 预览 |
| `lib/office-stub.mjs` | 158 | 本地 DocsAPI 替身（只读预览） | Office 预览 |
| `lib/errors.mjs` | 34 | `ApiError`、`req()` 取参、`need/notFound/conflict/badRequest` | 错误语义 |

---

## 3. docs/ 阅读顺序

| 文档 | 什么时候读 |
|---|---|
| `06-复现指南.md` | **想重跑整套还原流程** —— 含抓取脚本与端口/环境变量 |
| `01-架构总览.md` | 想理解线上三个域名的技术栈与还原思路 |
| `02-路由表.md` | 33 条前端路由 ↔ chunk 的对应 |
| `03-API契约.md` | 契约的来源、传输层、命令分组全表 |
| `07-数据形状.md` | **改后端前必读** —— 字段名、单位、分页、公式，每条附证据 |
| `08-命令实现对照表.md` | 211 条命令 ↔ `文件:行号`。**自动生成，不要手改** |
| `04-功能与依赖清单.md` | 前端用到的库与版本 |
| `05-动画与动效.md` | CSS 关键帧与 Framer Motion 参数 |
| `e2e-report.json` / `e2e-run.log` | 最近一次验收的机器可读报告与完整日志 |

---

## 4. 契约：三种查法

想确认「某条命令收什么参数、返回什么形状」时，按可信度从高到低：

| 优先级 | 来源 | 怎么用 |
|---|---|---|
| ① | **前端 bundle 的调用点** | 最高权威。`app/assets/` 里 grep 命令名，看它传什么、解构什么 |
| ② | `contracts/commands.json` | 静态分析产物，含 `command_count` / `commands_by_group` / `transport`，适合快速定位归属域 |
| ③ | `docs/08-命令实现对照表.md` | 想改实现时，直接跳 `文件:行号` |

**为什么 ① 是最高权威**：后端可以随便写，但前端是既成事实。这个仓库里若干次「看起来合理」的实现都是错的，
只有反解调用点才发现（见 §14 的坑表）。

`contracts/` 四个文件：

- `commands.json` — 211 条命令的域名分组 + 传输契约（生产/全球区 base URL、信封格式）
- `routes.json` — 33 条前端路由
- `app_analysis.json` — bundle 静态分析汇总
- `mirror-manifest.json` — 镜像元信息

---

## 5. 请求生命周期

一次前端调用的完整路径：

```
前端 api('getConversations', {...})
  ↓ fetch POST /api/getConversations, body {"data":{...}}, header Authorization
serve.mjs :5181                                  ← 按前缀分发
  ↓ p.startsWith('/api/')
api/index.mjs  handleApiRequest()
  ├─ seedIfEmpty()                               ← ⚠️ 注意：这里**故意不调 load()**，见 §14
  ├─ 特殊前缀先处理：/api/ticketAttachment, /api/avatar/*, /api/subscribeEvents, /api/watchConversationFiles, /api/auth/*
  ├─ readRawBody(req)                            ← 上限 64MB
  ├─ payloadFrom(req, buf, url)                  ← 按 Content-Type 解析四条通道
  ├─ userFromRequest(req)                        ← 无用户且非白名单 → 401
  ├─ COMMANDS[cmd]                               ← 未注册 → 501 NOT_IMPLEMENTED + 服务端 warn
  ├─ handler(payload, ctx)                       ← ctx 含 {user, teamId, req, res, url, files, rawBody}
  └─ 响应分支：
       result.streaming  → 已接管响应（SSE/WS），直接 return
       result.__binary   → sendRaw()，带 Content-Disposition
       普通对象           → {data: result} + set-auth-token 头（token 轮换）
       抛 ApiError       → {error:{code,message}} + 对应 HTTP 状态
```

### 四条传输通道（还原自 `app/assets/api-pyi_9PXn.js`）

| 通道 | 前端签名 | HTTP | body | 响应 |
|---|---|---|---|---|
| ① JSON | `Q(cmd, payload)` | `POST /api/{cmd}` | `{"data": payload}` | `resp.data` |
| ② 二进制 | `_e(cmd, payload)` | `POST /api/{cmd}` | `{"data": payload}` | 原始字节 + `content-disposition` |
| ③ 上传 | `ye(cmd, query, raw)` | `POST /api/{cmd}?query` | 原始字节 | `resp.data` |
| ④ 表单 | `ve(cmd, raw)` | `POST /api/{cmd}` | 原始字节 | `resp.data` |

**③ 是个坑**：它的参数在 **query string** 里，不在 body。`payloadFrom()` 的第三个参数 `url` 就是为它准备的 ——
早先漏传 `url` 时，上传报「缺少参数 conversationId」。

### 错误与认证

- 统一信封：`{error: {code, message}}`，HTTP 状态由 `ApiError.status` 决定
- 未登录 → `401 UNAUTHORIZED`，前端据此清 token 跳 `/login?redirect=`
- **token 轮换**：每个业务响应都带 `set-auth-token` 头，前端换新 token。
  CORS 必须 `Expose-Headers: set-auth-token`，否则前端读不到
- **免登录白名单**只有两类：
  1. 固定三条：`getSharedConversation` / `getSharedMessages` / `getSharedConversationCosts`
  2. `downloadConversationFile` **且带 `payload.token`** —— 签名直链会被 `<img src>` / `<iframe src>` / DocumentServer 直接 GET，
     带不上 `Authorization` 头，token 本身就是凭证。**只放行有 token 的分支**，匿名时 `ctx.teamId` 被强制置 null

---

## 6. 数据层

**内存是唯一真相源，磁盘只是 write-behind 快照。**

```js
import { db$, save, load } from './lib/db.mjs';

db$()                 // 取内存库（注意：db$ 是函数，必须调用！db$.users 恒为 undefined）
db$().users.find(...)
save()                // 防抖 150ms 落盘
load({ force: true }) // 强制重读磁盘 —— 只在确实需要时用
```

落盘结构：`server/data/db.json`（单文件，键即「表」）+ 真实目录（`workspace/` `hosts/` `skills/` `files/` `attachments/`）。
**整个 `server/data/` 已被 gitignore**，首次启动自动播种。

### 响应必须过 `shapes.mjs`

`db.json` 里的行是「内部结构」，前端要的是「契约形状」。两者**不要混用**。
`lib/shapes.mjs` 每个函数返回一个白名单对象，例如 `conversation(row)` / `message(row)` / `paymentOrder(row)`。

> **症状 → 病因**：前端拿到 `undefined` 字段，或某功能点了没反应 ——
> 十有八九是 `shapes.mjs` 的白名单漏了字段（这个仓库真的踩过两次：`order.payUrl`、`skill.installed`）。

单位与公式（完整版见 `docs/07-数据形状.md`）：

- `UNIT = 1e3` —— 额度用 **milli** 存储，`creditToMilli()/milliToCredit()` 换算
- 月付价（分）：`free 0 / plus 990 / pro 2990 / ultra 9990 / team 29990 / enterprise 99900`
- **年付 = `round(monthly × 12 × 0.6)`**（6 折，`ANNUAL_DISCOUNT_BP = 6000`）
  → pro 年付 = `2990×12×0.6 = 21528` 分 = ¥215.28
- 充值档位赠送比例 `TOPUP_TIERS`；推广分佣按 3 个月 × 30%

---

## 7. 智能体运行时

`lib/agent.mjs`。两种引擎，由环境变量决定：

```bash
CLAWSGO_LLM_BASE_URL=... CLAWSGO_LLM_API_KEY=... CLAWSGO_LLM_MODEL=...
```

- 配了 → `llmAgent()`，走真实模型
- 没配 → `demoAgent()`（默认）。**注意：工具调用链是真的**，只是「决定调什么工具」由规则而非模型给出

### 工具

| 工具 | 实现 | 说明 |
|---|---|---|
| `Read` / `Write` | `workspace.mjs` | 真读写会话工作区 |
| `Glob` / `Grep` | `workspace.mjs` | 真遍历真匹配 |
| `Bash` | `workspace.mjs` 的**迷你 shell** | 见下 |
| `WebSearch` / `WebFetch` | `workspace.mjs` | 网络工具 |

**Bash 的迷你 shell**（`workspace.mjs` 内 `case` 分支，纯 JS 实现，不是真 spawn）：
`ls tree cat head tail wc grep find echo pwd cd mkdir touch cp mv rm rmdir stat du basename dirname sort uniq cut awk sed date help`
外带 `git`（status/diff 简化实现）、`python`/`python3`、`node`（透传）。

### 工具审批

`Bash` 执行前会发 SSE `permission` 帧并**阻塞等待** `answerPermission {conversationId, requestId, behavior}`。
`allow` / `deny` 都真实生效。

### 子智能体编排

按提问内容触发（正则 + 关键词数），内部步骤走 `track-part` 通道并带 `agentId`。
**改触发条件时小心**：正则过窄会导致「该编排的没编排」，e2e 有对应断言。

### 一次运行的生命周期

```
sendMessage → hub.startRun() → 帧 run-started
  → 循环：executeTool() → toolPart() → hub.part()（含 state: input-available → output-available）
         文本/推理 → hub.delta() 逐块推送
         Bash → hub.permission() 阻塞等审批
  → 标题生成 → hub.titleUpdated()
  → 落库 → hub.finish() → 帧 done
```

> **硬要求**：无论中途发生什么异常，都必须发出 `done` 帧，否则前端永久转圈。
> 落库阶段整体包在 try/catch 里，并在 db 结构异常时 `load({force:true})` 兜底。

---

## 8. SSE 帧参考表

`lib/sse.mjs`，通道 `POST /api/subscribeEvents`（body `{}`）。帧格式 `data: {json}\n\n`。

| `t` | 触发 | 载荷要点 |
|---|---|---|
| `channel-ack` | 连接建立 | `{running: [{conversationId, messageId}]}` |
| `run-started` | 开始运行 | `{conversationId, teamId, messageId}` |
| `snapshot` | 连接建立时对运行中会话 | 完整 `parts` + `permissions`（刷新后恢复用） |
| `part` | part 整体更新 | `{conversationId, index, part}` |
| `part-delta` | 流式增量 | `{conversationId, index, delta}` |
| `track-part` | 子智能体内部步骤 | `{conversationId, index, at, part, agentId?}` |
| `permission` | 请求审批 | `{conversationId, request}` |
| `permission-answered` | 审批已回 | `{conversationId, requestId}` |
| `title-updated` | 标题生成 | `{teamId, conversationId, title}` |
| `done` | 运行结束 | `{conversationId, messageId, metadata}`；运行态保留 30s 供重连 |
| `ping` | 25s 心跳 | `{at}` |

第二条 SSE 通道 `POST /api/watchConversationFiles`（body `{data:{conversationId}}`）推文件变更，
基于真 `fs.watch`，帧类型 `change`。

**parts 类型**：`text` / `reasoning` / `tool` / `block` / `compaction` / `file` / `resume` / `structured`。

---

## 9. 其他关键机制

### 桌面直连文件回退

前端优先尝试直连。`createFileLink` → `{link: {url, token, expiresAt}}`：

- `url` **必须自带 `?`** —— 前端会拼 `` `${url}&download=1` ``。少个问号 → 下载按钮点了没反应
- 必须是 `{link: {...}}` 包装 —— 前端写的是 `let {link} = await api('createFileLink', ...)`

### 终端 WebSocket

`/api/terminal/ws?ticket={t}&cols={c}&rows={r}`，自写 RFC 6455（`lib/ws.mjs`）+ 迷你 shell。
票据由 `createConversationTerminal` 签发。

### Office 预览

`createOfficeSession` 必须返回 ONLYOFFICE 的形状：`session = {serverUrl, config}`，
其中 `config.editorConfig.mode` 与 `config.document.key` 被 React 用作 key。
本地 DocumentServer 用 `lib/office-stub.mjs` 顶替。接真实实例：

```bash
CLAWSGO_ONLYOFFICE_URL=https://your-document-server node server/serve.mjs   # 代码不用改
```

### ZIP 下载

自写编码器（STORE 无压缩）。**外部属性字段写过 `0o100644 << 16`，在 32 位有符号下溢成负数**
→ 必须 `>>> 0`，否则下载报 `value is out of range`。

---

## 10. 「我要改 X」→ 动哪里

| 想改的东西 | 动这里 |
|---|---|
| 加一条新命令 | 对应 `api/*.mjs` 的 `commands` 导出加键 + 实现函数 → 重启 → `gen_command_map.mjs` 刷新对照表 |
| 前端拿到 `undefined` 字段 | `lib/shapes.mjs` 加白名单字段 |
| 演示数据 | `lib/seed.mjs` + `DEMO` 常量 |
| 登录账号/验证码规则 | `api/auth.mjs` + `lib/seed.mjs` |
| 套餐价格 / 额度 / 年付折扣 | `lib/plans.mjs`（**改完必须同步 e2e 里的金额断言**） |
| 智能体的话术与规则 | `lib/agent.mjs` 的 `demoAgent()` / `buildAnswer()` |
| 智能体工具行为 | `lib/workspace.mjs`（注意 glob 与 shell 的回归测试） |
| 端口 / 静态托管 / 新路由 | `serve.mjs` |
| SSE 帧 | `lib/sse.mjs` 加方法 + `lib/agent.mjs` 调用点 |
| 前端产物（如 API 基址） | 直接改 `app/assets/api-*.js` 里的常量（这是唯一允许改前端的场景） |

---

## 11. 验收

```bash
node tools/e2e.mjs        # 219 项，17 节
```

覆盖：认证与会话 / 资料团队不变量 / 会话分页契约 / 发消息·SSE·审批·子智能体·标题 / 消息与费用 /
工作区文件全操作（读写信、上传、下载、ZIP、重命名、复制、移动、删除、git、figure）/
文件变更推送 / 会话维护·分享·归档·搜索 / 技能库 / 主机探针 / 计费 / 工单附件 / 终端 WS /
桌面直连网关 / 后台 67 条 / 命令注册表覆盖 / 静态托管与 SPA 外壳。

**验收脚本自身的约定**（写新断言时遵守）：

- 每节开头 `section('N. 标题')`，单条用 `check('描述', 条件, 附注)`
- 断言要**过滤 `state === 'output-available'`** 再取 `part.output`，否则会命中执行前的 `input-available` 帧拿到 `undefined`
- 日志镜像到 `docs/e2e-run.log`（本环境 shell 重定向不可靠，所以脚本自己写文件）
- 结束时写 `docs/e2e-report.json`

### 添加一条断言的标准动作

1. 在对应 `section` 内加 `await api('cmd', {...})` + `check(...)`
2. 如果新命令，确认它出现在 `/__commands` 里（末节会做覆盖检查）
3. 重启服务 → 跑 e2e → **连跑两遍**确认幂等

---

## 12. 已知边界

| 项 | 状态 |
|---|---|
| 营销站 5 页 + 应用端 924 个产物文件 | ✅ 完整离线可跑 |
| 211 条命令 / 219 项断言 | ✅ 全绿，可重复 |
| 智能体工具链 | ✅ 真实执行；无 LLM 时"决定调什么"用规则代替 |
| Office 页内编辑 | ⚠️ 本地是**只读预览替身**；设 `CLAWSGO_ONLYOFFICE_URL` 可换真编辑器 |
| 支付 | ⚠️ 本地收银台 + 自动确认，未接微信/支付宝 |
| 短信 / 邮件 | ⚠️ 验证码固定并在响应里返回 `devCode` |
| 数据持久化 | ⚠️ 单文件 JSON，够用非生产级 |
| 浏览器 UI 自动化 | ⚠️ 未进 CI（受限环境无法启动 Chromium）；API/服务层已全绿 |

---

## 13. 陷阱清单（都真实踩过，别重踩）

| 症状 | 根因 |
|---|---|
| 刚登录就 401 | 每请求调 `load()`，用磁盘快照覆盖了「刚写内存还没落盘」的数据。**内存才是真相源**，默认 `load()` 必须幂等 |
| `db$.users` 恒为 `undefined` | `db$` 是**函数**，写漏了括号 |
| 工作区「看起来是空的」 | `globToRegex` 里 `?` → `[^/]` 的替换顺序放在插入 `(?:.*/)?` 分组**之后**，正则自毁 |
| 上传报「缺少参数 conversationId」 | 通道 ③ 的参数在 query string，`payloadFrom` 没合并 `url.searchParams` |
| ZIP 下载 `value is out of range` | `0o100644 << 16` 有符号溢出 → `>>> 0` |
| 缺个 chunk 却拿到 HTML，浏览器报 `Unexpected token '<'` | SPA 回落把不存在的静态资源也吞成 `index.html`。**`/assets/` 与带扩展名的路径必须老实 404** |
| 新建文件夹 409 | 前端没有冲突提示，语义应是 `mkdir -p`（幂等返回） |
| `/files/*` 全 403 | 网关调用时 `ctx` 传 null，团队校验 `conv.teamId !== undefined` 恒真 |
| 子智能体该触发却没触发 | 触发正则太窄（只匹配「检索/文献」却漏了「统计/生成/对比」） |
| 迁移进度条永远停住 | 状态回落用了合成空壳而不是**最近一次作业的真实状态** |
| `/api/...` 全 500 | 未捕获异常 → 看服务端 `[api]` 日志；`serve.mjs` 外层还有一层 500 兜底 |
| 注释里写了 `*/` | 块注释被提前终止。**在注释里描述 glob 时不要写 `(?:.*/)?` 这种字面量** |

---

## 14. 禁止事项

- ❌ **不要提交 `server/data/`** —— 运行时数据，已在 `.gitignore`
- ❌ **不要手改 `docs/08-命令实现对照表.md`** —— 由 `tools/gen_command_map.mjs` 生成
- ❌ **不要为了让测试通过而放宽断言** —— 先确认真相（查 bundle 调用点），再决定是改实现还是改断言
- ❌ **不要在 `handleApiRequest` 里加 `load()`** —— 见陷阱清单第一条
- ❌ **不要把 `site/logos/` 与 `site/join-us-poster.jpg` 用于公开分发** —— 高校校徽属商标、海报可能含肖像，
  详见 `NOTICE.md` 第 1 节第 ③ 条
- ❌ **不要删除 `docs/e2e-run.log` 与 `docs/e2e-report.json`** —— 它们是验收证据

---

## 15. 一句话总结

> 前端是不可变的事实，后端是可改的实现，契约以调用点为准，验收以 `tools/e2e.mjs` 全绿为准。

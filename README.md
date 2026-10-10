# ClawsGO — 完整复刻（开源版）

> **AI 代理请直接读 [AGENTS.md](./AGENTS.md)** —— 仓库地图、接口契约、改动指引、验收方式、踩过的坑都在那儿。
> 本文件面向人类读者。

对 `https://clawsgo.cn`（营销站）、`https://app.clawsgo.cn`（应用端）与 `https://api.clawsgo.cn`（API）的**完整还原**：

- **前端**：全量产物，像素级一致，动画一并还原（营销站 19 页 + 应用端 1098 个产物文件）
- **后端**：**可真实运行的复刻服务**，266 条命令全部实现，零第三方依赖
- **契约**：从生产 bundle 的调用点反推出的完整 API 形状，逐条落到代码
- **验收**：319 项端到端断言，覆盖到真实文件系统、真实 WebSocket、真实 SSE 流

> 这份仓库解决一件事：把线上跑着的东西，变成你本地能读、能改、能重跑、能验证的代码和文档。

---

## 30 秒跑起来

```bash
node server/serve.mjs
```

| 地址 | 内容 |
|---|---|
| http://localhost:5180 | 营销站（首页 / 下载 / 推广条款 / 文档中心 / FAQ 等 19 页） |
| http://localhost:5181 | Web 应用（登录页 → 对话工作区 → 文件 → 终端 → 后台） |

登录：**手机号 `138 0000 0000`，验证码任意 6 位，密码 `clawsgo2026`**
管理员：手机号 `139 0000 0000`（同密码），可进 `/admin` 后台

零依赖，只需 Node 18+。换端口：

```bash
PORT_SITE=6180 PORT_APP=6181 node server/serve.mjs
```

首次启动会自动播种演示数据到 `server/data/`（该目录是运行时产物，已进 `.gitignore`，删掉即可重置）。

### 验收测试

```bash
node tools/e2e.mjs            # 319 项断言，约 25 秒
node tools/glob.test.mjs      # glob→regex 回归测试
```

跑完会打印 `通过 319   失败 0`，并把机器可读报告写到 `docs/e2e-report.json`、完整日志写到 `docs/e2e-run.log`。

测试是**可重复**的：每轮开头会调一次 `POST /__reset` 把服务恢复到出厂状态（清主机盘/工作区，重播种子数据），所以连跑十遍结果一样。

---

## 后端复刻到什么程度

不是 mock。下面这些在被测时是**真的在执行**：

| 能力 | 实现方式 |
|---|---|
| 智能体对话 | 真跑工具循环：Glob / Grep / Read / Write / Edit / Bash 都作用在真实目录上 |
| 工具审批 | Bash 执行前发 SSE `permission` 帧，等前端 `answerPermission` 才继续，`allow`/`deny` 都生效 |
| 子智能体编排 | 按提问内容触发，内部步骤走 `track-part` 通道（`agentId`） |
| 流式输出 | `reasoning` / `text` / `tool` 三类 part 的 `part-delta` 增量推送 |
| 会话工作区 | 每个对话一个**真实目录**，文件树、读写、重命名、移动、上传、下载都是真 fs 操作 |
| ZIP 打包 | 自写的 ZIP 编码器（零依赖），产物能被打开 |
| 终端 | 自写的 WebSocket（RFC 6455）+ 迷你 shell，`ls`/`wc`/`mkdir`/`touch`/`rm` 真改文件系统 |
| 文件变更推送 | 真 `fs.watch` → SSE `change` 帧 |
| 技能库 | 技能文件真落盘，`getSkillFile` 读的是磁盘上的源码 |
| 主机探针 | SSH 探活是真的 TCP connect；主机目录树是真目录 |
| 计费 | 下单 → 收银台页面 → 支付 → 额度到账 → 流水 → 开票 → 退款回收，全链路 |
| 工单附件 | 自写的 multipart 解析器，附件可真上传真下载 |
| 桌面直连回退 | `/files/*` 网关与命令走同一套实现，前端走「直连成功」这条路径 |
| Office 预览 | 本地 DocsAPI 替身，把文档渲染成只读面板（见下） |

真实 LLM 可选：

```bash
CLAWSGO_LLM_BASE_URL=... CLAWSGO_LLM_API_KEY=... CLAWSGO_LLM_MODEL=... node server/serve.mjs
```

不配就用内置的演示智能体——但**工具调用链是真的**，只是「决定调什么工具」由规则而非模型给出。

---

## 目录

```
clawsgo-opensource/
├─ AGENTS.md                ★ AI 代理说明书（结构 / 契约 / 改动指引 / 陷阱清单）
├─ CLAUDE.md                指向 AGENTS.md（Claude Code 惯例入口）
├─ README.md                本文件
├─ NOTICE.md                权属、许可与发布前必读
├─ LICENSE                  MIT（含「适用范围说明」）
├─ THIRD-PARTY-NOTICES.md   第三方依赖许可清单
├─ .gitignore               已排除 server/data（运行时产物）
│
├─ site/                    营销站 — 19 页 + 全部静态资源（Next.js 产物）
├─ app/                     应用端 — React SPA 全量产物（924 个文件）
├─ server/                  复刻后端（零第三方依赖，约 10.6k 行）
│  ├─ serve.mjs             :5180 静态托管 · :5181 应用 + API + SSE + WS
│  ├─ api/                  11 个域模块，211 条命令
│  │  ├─ index.mjs          分发器、四条传输通道、文件网关、收银台
│  │  ├─ auth.mjs  account.mjs  chat.mjs  files.mjs
│  │  ├─ hosts.mjs  skills.mjs  teams.mjs  billing.mjs
│  │  ├─ support.mjs  admin.mjs
│  └─ lib/                  零依赖基础设施
│     ├─ agent.mjs          智能体循环 / 工具调度 / 审批
│     ├─ workspace.mjs      工作区、Glob/Grep/Bash 工具、迷你 shell
│     ├─ office.mjs         签名直链 + ONLYOFFICE 会话
│     ├─ office-stub.mjs    本地 DocsAPI 替身
│     ├─ zip.mjs  ws.mjs  multipart.mjs  sse.mjs
│     ├─ db.mjs  seed.mjs  reset.mjs  shapes.mjs  plans.mjs  errors.mjs
├─ tools/
│  ├─ e2e.mjs               219 项端到端验收
│  ├─ gen_command_map.mjs   生成命令对照表
│  ├─ glob.test.mjs         glob→regex 回归测试
│  └─ mirror*.py  crawl_app.py  analyze.py  api_trace.py  emit_contract.py
├─ contracts/
│  ├─ commands.json         211 个 API 命令（按域分组）
│  ├─ routes.json           33 条前端路由
│  └─ mirror-manifest.json  镜像元信息
└─ docs/
   ├─ 01-架构总览.md
   ├─ 02-路由表.md
   ├─ 03-API契约.md
   ├─ 04-功能与依赖清单.md
   ├─ 05-动画与动效.md
   ├─ 06-复现指南.md
   ├─ 07-数据形状.md         字段 / 单位 / 分页速查
   ├─ 08-命令实现对照表.md    211 条命令 ↔ 源码位置（自动生成）
   ├─ e2e-report.json
   └─ e2e-run.log
```

---

## 文档怎么读

| 你的身份 / 目的 | 从哪开始 |
|---|---|
| **AI 代理**（要改代码、查契约） | [AGENTS.md](./AGENTS.md) —— 一份文件讲清全部 |
| 想跑起来、想知道复刻到什么程度 | 本文件 |
| 想重跑整套抓取与还原流程 | [docs/06-复现指南.md](./docs/06-复现指南.md) |
| 想确认某条命令收什么参数、返回什么 | [contracts/commands.json](./contracts/commands.json) → [docs/08-命令实现对照表.md](./docs/08-命令实现对照表.md) |
| 想知道字段名与单位 | [docs/07-数据形状.md](./docs/07-数据形状.md) |
| 关心版权与许可 | [NOTICE.md](./NOTICE.md) · [LICENSE](./LICENSE) · [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) |

---

## 这套东西是怎么来的

线上站点是**两个独立部署**，不是一套代码：

| 域名 | 技术栈 | 性质 |
|---|---|---|
| `clawsgo.cn` / `clawsgo.ai` | **Next.js**（App Router，Turbopack 构建） | 营销站，19 个预渲染静态页 |
| `app.clawsgo.cn` | **React 19 + Vite/Rolldown** | 真正的应用，登录墙后 |
| `api.clawsgo.cn` | RPC over POST | `POST /api/<command>`，信封 `{data}` |

**前端**的还原过程（脚本都在 `docs/06-复现指南.md` 里可重跑）：

1. 抓营销站 HTML，解析出它引用的全部 `_next` chunk 与图片
2. 从应用入口 `index-DGV9-zpZ.js` 提取动态 import 清单 → 拿到 26 个路由 chunk
3. 以入口为种子递归展开依赖图 → 收敛到全部产物文件
4. 静态分析全部 bundle，还原出 API 客户端实现、211 个命令名、33 条路由、i18n 键、动画参数
5. 改写两处硬编码常量，让整站本地同源起来

**后端**则是「按契约重写」：bundle 里能拿到的是**调用点**（传什么参数、怎么解构返回值），
拿不到服务端实现。所以做法是——把每个调用点当成验收标准，一条一条实现到「前端真的能用」为止。
`docs/08-命令实现对照表.md` 是这件事的进度表，`tools/e2e.mjs` 是它的证据。

举几个「必须反解调用点才知道」的例子（都是这一轮踩出来的）：

| 现象 | 真相 |
|---|---|
| 文件直链拼出 `undefined/api/...` | 前端是 `let {link:n} = await api('createFileLink',...)`，**少写了一层 `link` 包装** |
| 下载按钮点了没反应 | 前端拼 `` `${url}&download=1` ``，所以 `url` 里**必须已经带 `?`** |
| Office 面板必崩 | `session` 必须是 ONLYOFFICE 的 `{serverUrl, config}`，不是自定义结构；React key 还依赖 `config.editorConfig.mode` 和 `config.document.key` |
| 签名直链被 401 | `<img src>` / `<iframe src>` / DocumentServer 都带不上 Authorization 头，token 本身就是凭证 |
| 新建文件夹报 409 | 前端按钮没有冲突提示，语义应是 `mkdir -p`（**幂等**） |
| 工作区「看起来是空的」 | Glob 的 `?` → `[^/]` 替换顺序错了，正则自毁 |
| 刚登录就 401 | 每个请求都 `load()` 磁盘快照，把「刚写内存还没落盘」的数据覆盖了 |

完整的坑清单在 [AGENTS.md §13](./AGENTS.md)。

---

## 已知边界

| 项 | 状态 |
|---|---|
| 营销站 19 页 + 应用端 1098 个产物文件 | ✅ 完整，离线可跑 |
| 动画与动效 | ✅ 完整（CSS 关键帧 + Framer Motion 参数均在产物内） |
| API 契约与后端实现 | ✅ 211 条命令，219 项断言全绿 |
| 智能体工具链 | ✅ 真实执行；「决定调什么工具」在无 LLM 时用规则代替 |
| Office 编辑 | ⚠️ 本地是**只读预览替身**。页内编辑需要真实 DocumentServer：设 `CLAWSGO_ONLYOFFICE_URL` 指向自建实例即可，代码不用改 |
| 支付 | ⚠️ 收银台是本地页面 + 自动确认，未接真实微信/支付宝 |
| 短信 / 邮件 | ⚠️ 验证码固定，`devCode` 直接在响应里返回 |
| 阿里云验证码 | ⚠️ 依赖 `o.alicdn.com` 外部脚本，离线环境静默失败 |
| 浏览器自动化实测 | ⚠️ 未在 CI 中跑（受限环境无法启动 Chromium）。API/服务层已全绿，UI 层建议本地打开 http://localhost:5181 自查 |

---

## 许可

本仓库中由作者独立编写的部分（`server/`、`tools/`、`contracts/`、`docs/`）以 **MIT** 发布，见 [LICENSE](./LICENSE)。

**但这不是一份「全部内容都归 MIT」的仓库**，有三层独立权属：

1. **第三方依赖** —— 占 `app/` 与 `site/` 产物体积的绝大部分，归各自许可，清单见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)
2. **站点代码产物与营销文案** —— 归原开发者/公司
3. **品牌与内容资产** —— 产品名与 Logo、`site/logos/` 下的高校校徽（**注册商标**）、`site/join-us-poster.jpg`（可能含肖像）。
   这些文件为完整还原站点外观而保留，**其商标权、肖像权不因本仓库的 MIT 许可而授予**

公开发布与再分发前请务必读一遍 [NOTICE.md](./NOTICE.md)。

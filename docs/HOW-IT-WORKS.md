# 全链路实现全景（证据版 · 2026-10-09）

> 本文回答四个问题：**云主机是怎么实现的、网页是怎么实现的、Agent 引擎（提示词/模型/工具）怎么跑、每个模块干什么**。
> 证据分级，全文严格标注：
> - **[A] 线上实测**：对 `app.clawsgo.cn` 的真实抓包（127 条请求/响应，`work/noviprod-sync/live-capture/prod-requests.json`）
> - **[B] 生产 bundle 字节证据**：`app/assets` 与线上逐字节哈希一致（1096/1098，2 处为声明的本地重写），分析它=分析生产代码；引用格式 `chunk@偏移`
> - **[C] 本地复刻源码**：`server/**`，可直接打开核对
> - **[D] 推断/客户端不可知**：明确说清，不编造
>
> 采集方法：reverse-skill js-reverse 五阶段（Observe→Capture→Rebuild），案卷 `work/noviprod-sync/`（own-system 授权）。

---

## 1. 线上总架构 [A][B]

| 层 | 实测证据 |
|---|---|
| 入口 | `server: nginx/1.31.6`（app.clawsgo.cn 响应头，prod-requests.json） |
| 云厂商 | 阿里云华北2（北京）+ 香港，双区 `VITE_REGION = cn\|global`（region-B-TY-5rL.js@491：cn 区微信支付+手机号，global 区 Stripe+Google），三子域共用一个出口 IP = 单入口反代 |
| 营销站 | `x-powered-by: Next.js` 自托管预渲染（clawsgo.cn 与 API 同 IP，非 Vercel） |
| 登录风控 | **阿里云验证码全链**（实测抓包）：`o.alicdn.com/captcha-frontend/AliyunCaptcha.js` + FeiLin 滑块 1.5.1 + `w2cj5a.captcha-open.aliyuncs.com` `InitCaptchaV3`（SceneId `18clmrek`）+ `cloudauth-device-dualstack.cn-shanghai.aliyuncs.com` Log1/Log2 **设备指纹上报**。与 bundle 内 `PhoneOtpFields` 的 `AliyunCaptchaConfig={region:'cn',prefix:'w2cj5a'}` 互证 [B] |
| API 错误语义 | 业务错误也走 HTTP 200 + `{error:{code,message}}`（复刻件 api/index.mjs 按此实现并注明还原自 api-pyi chunk）[B] |

## 2. 网页前端是怎么实现的 [B]

构建与栈（全部从生产 chunk 反证）：

- **打包**：rolldown-vite（入口 `index-QbJOivX-.js` + `rolldown-runtime-hePW80VL.js`），1291 个按路由/组件分裂的 chunk，`modulepreload` 预载图
- **UI**：React + **Base UI**（`createBaseUIEventDetails/useRenderElement/FloatingPortal` 等 chunk）+ Hugeicons（`HugeiconsIcon-*`）+ Tailwind 原子类
- **路由**：TanStack Router（`route/Match/useParams/useSearch/useNavigate/redirect/lazyRouteComponent` chunks），33 条路由：3 公开 / 14 登录态 / 16 后台
- **状态**：TanStack Query（`useMutation/useQuery` chunks，queryKey 形如 `[projects, teamId, host]`）
- **输入框**：TipTap ProseMirror（`.composer-editor`，`data-placeholder="Describe your task, / for commands and skills, @ for files, tasks, software & databases"`）；`/` 唤起命令/技能面板、`@` 唤起文件/任务/主机提及菜单（ChatStatusBar-CMXxaPi9.js 内 `ir=y(Pn?.id,{query},…)` 全套）
- **图表**：recharts（chart-*.js）、mermaid（mermaid-*.js）、Monaco（editor.worker/*.worker chunk，代码高亮 textmate 语法包按语言懒加载）
- **i18n**：每条文案双闭包 `(e,t)=>(t.locale??R())==='en'?En(e):Zh(e)`，`R()` 取 locale
- **传输封装**（api-pyi chunk，复刻 server/api/index.mjs 头注逐字还原）：
  - `Q(cmd,payload)` → `POST /api/{cmd}`，body `{"data":payload}` → `resp.data`
  - `_e` 二进制下载变体（content-disposition）、`ye`/`ve` raw body 变体
  - 认证 `POST /api/auth/{cmd}`，token 走 **`set-auth-token` 响应头轮换**；未授权 401 `{error:{code:'UNAUTHORIZED'}}` → 前端清 token 跳 `/login?redirect=`
- **实时**：`POST /api/subscribeEvents`（SSE）+ `POST /api/watchConversationFiles`（文件变更 SSE）+ `/api/terminal/ws`（终端 WebSocket，票据制）
- **关键 localStorage**：`clawsgo_upgrade_notice_20261001_seen`（1.5 升级公告一次性弹窗）、`clawsgo_announcements_dismissed`（db 公告已读 id 列表）、`clawsgo_sidebar_scope/project`、`clawsgo_notified`、`clawsgo_terminal_height`、`clawsgo_long_run_hint_dismissed`

## 3. 云主机是怎么实现的

### 3.1 线上真实模型 [A][B][D]

- **不是每用户一台 VM**。是**团队级共享的常驻实例**：`镜像(rootfs) + 持久化主目录云盘 + 一块与 Agent 共用的桌面`，按套餐给 CPU/内存/磁盘/并发额度（04-INFRASTRUCTURE §2.1-2.7，用户可见文案逐条原文佐证：「创建团队，与协作者共享主机、文件与任务」「清理缓存不影响项目文件」「并行、规格与成员上限全面提升」）[B]
- 桌面送到浏览器 = **noVNC**（已验证的客户端契约）[B]；`openHostView` 无桌面宿主进程时前端退化为浏览器内视图（本地复刻同款响应：`available:false, reason:'local-reproduction: no desktop host process'`）[C]
- **主机两种来源**：云主机 or 自有电脑（BYO 桌面 daemon 配对）[B]
- 生命周期状态机（前端消费）：`provisioning → running`、`rebuilding`、`offline`；派单资格 = `canDispatchTask` 且 `online`（api-DYG_whnY.js `Ee(host,…)`：`!canDispatchTask→'private'`，`!online→'offline'`，会话中途 `run-host {offline}` 帧 → `'paused'`）[B]
- 是 VM 还是容器：**强推断为常驻容器/轻量实例 + 云盘**，客户端无法定论 [D]

### 3.2 本地复刻实现 [C]（server/api/hosts.mjs，零依赖 Node）

| 线上概念 | 复刻实现 |
|---|---|
| 开通 provisioning→running | `createHost` 落库后 2s `setTimeout` 转 running（前端 10s 轮询 getHostStatus 感知），同款状态机 |
| 主机云盘 | `server/data/hosts/<hostId>/` **真实目录树**（`seedHostDirs` 预置 home/clawsgo/workspace、datasets、notebooks、data/lab、opt/models、var/cache 等），目录选择器真实可浏览，越界用 `path.resolve+sep 边界` 防护 |
| 规格与存储 | spec{cpu,memoryGb,diskGb,gpu}；用量 = 对 hostId 做稳定哈希投影（避免数字乱跳），`cleanHostCache` 真删 `var/cache/clawsgo` |
| 环境探针 | `getHostEnvironment` 返回 os/kernel/python/node/git/latex/cuda/包清单（云端主机为声明值；ssh 主机 os 标 linux (remote)） |
| BYO SSH | `sshServers` 表 + **真 TCP 探活**（`net.connect` 测 host:port 延迟），探活结果同步回主机 status |
| 终端 | 复用会话终端那套票据 + WebSocket（terminalTickets），目录落在同一工作区 |
| 22 条命令 | getHosts/createHost/updateHost/deleteHost/rebuildHost/cleanHostCache/getHostStatus/getHostEnvironment/getHostStorage/getHostDirectories/createHostDirectory/getHostSkills/getHostSkillDetail/getSshServers/createSshServer/updateSshServer/deleteSshServer/probeSshServers/openHostView/pickHostDirectory/adminGetCloudHosts/adminRebuildHost |

## 4. Agent 引擎：提示词、模型、工具循环

### 4.1 模型面（线上）[B]

生产 bundle 提取的真实模型 ID：`clawsgo-1.5-lithium / -silicon / -titanium`（现行三代）+ `clawsgo-1.0-lithium/silicon/titanium`（上一代）+ **`clawsgo-vector-1.0/1.5`**（向量/检索模型）。
计费倍率（1.5 升级公告原文）：Lithium `x0.5/x1.0`、Silicon `x1.0/x2.0`、Titanium `x1.5/x3.0`（输入/输出档），文案「三档费用均较上一代减半」。
**线上服务端的 system prompt、工具编排与模型供给：客户端不可见 [D]** —— bundle 里不存在，任何"线上提示词全文"都是编造。线上行为边界只能从帧协议与 parts 结构反推。

### 4.2 本地复刻引擎 [C]（server/lib/agent.mjs，694 行，全文可核）

双大脑，**输出帧协议完全一致**：

1. **LLM 模式**：env `CLAWSGO_LLM_BASE_URL / CLAWSGO_LLM_API_KEY / CLAWSGO_LLM_MODEL` → OpenAI 兼容 `/chat/completions` 流式，最多 **8 轮**工具循环，`reasoning_content` → reasoning part，`tool_calls` 增量拼装
2. **内置演示智能体**（默认）：真实执行 Glob/Grep/Read/Bash/Write（真盘真目录），演示权限审批与子智能体编排

**系统提示词全文 [C]**：

```text
你是 ClawsGO Science 的长时程科研智能体。工作区是一台隔离沙箱，你只能用给定工具操作它。
先用工具核对事实，再给出结构化结论：结论 → 证据 → 复现步骤。中文回答，Markdown 排版。
```

**工具 schema 全 7 件 [C]**：Read(file_path)、Write(file_path,content)、Glob(pattern,path)、Grep(pattern,path)、Bash(command,description)、WebSearch(query)、WebFetch(url)——输出截断策略：Read 400 行、tool result 8000 字符入上下文。

**权限审批**：仅 Bash 过门 —— `requestPermission()` 发 `permission {request:{requestId,toolName,input}}` 帧 → 前端权限卡 → `answerPermission(behavior)` → `permission-answered {requestId}`；**120s 无应答超时**按拒绝处理，工具回 `output-error` + 上下文注入 "Permission denied by user."

**子智能体编排**：`Task` 工具 part 携带 `agents:[{agentId,label,state,parts,summary}]`，子步骤经 `track-part {index,at,part,agentId}` 逐帧推进（复刻件以 WebSearch/WebFetch 演示两路并行，触发条件：研究/多步意图正则 或 ≥3 关键词）。

**其他机制**：中止（abort → parts 停写 + `aborted` 落库）；token 计量（演示模式按字符数 /2.2 估算并写 `metadata.usage`）；标题生成（首轮后 `title-updated`，>24 字截断，尊重用户改名）；落库兜底（finally 内强制 try，DB 异常重载磁盘，保证 `done` 帧必达——注释原话："落库出问题也绝不能把进程带走"）。

## 5. SSE 帧协议全表

解析器真源：`useConversationStream-Bfce93ac.js` [B]。**线上 15 帧**，本地复刻实现其中 10 帧 + ping：

| 帧 | 载荷（实测） | 语义 | 复刻 |
|---|---|---|---|
| channel-ack | `{running:[{conversationId,messageId}]}` | 订阅确认+在跑清单 | ✅ |
| snapshot | `{conversationId,messageId,parts,permissions}` | 断线重连恢复 | ✅ |
| run-started | `{conversationId,teamId,messageId}` | 开始 | ✅ |
| part | `{index,part}` | 新 part（text/reasoning/tool） | ✅ |
| part-delta | `{index,delta}` | 文本增量 | ✅ |
| track-part | `{index,at,part,agentId}` | 子智能体轨道 | ✅ |
| permission | `{request:{requestId,toolName,input}}` | 审批卡 | ✅ |
| permission-answered | `{requestId}` | 审批完成 | ✅ |
| title-updated | `{title}` | 标题覆盖 | ✅ |
| done | `{messageId,metadata:{usage,durationMs,…}}` | 结算 | ✅ |
| **run-context** | `{tokens}` | 上下文用量（前端写 contextTokens） | ➖缺 |
| **run-host** | `{offline}` | 主机离线→任务 paused | ➖缺 |
| **host-presence** | — | 主机在线粗粒度刷新 | ➖缺 |
| **image-updated / conversation-read** | — | 生图更新/已读回执 | ➖缺 |
| ping | `{at}` | 25s 心跳 | ✅ |

part 形状（两端一致）：`{type:'text'|'reasoning', text}` / `{type:'tool', toolUseId, toolName, input, state:'input-available'|'output-available'|'output-error', output?, errorText?, durationMs?, notRun?}`。

## 6. 模块 × 命令全景（本地复刻注册 273 条 [C]；前端可静态提取 157+ 处调用点 [B]）

| 模块 | 命令数 | 功能一句话 |
|---|---|---|
| auth | 7 | 手机 OTP + 密码双通道、one-time-token；token `cgt_` 前缀 30 天，`set-auth-token` 头轮换 |
| account | 27 | profile/overview/usage、设备注册与吊销、agent 记忆读写、项目 CRUD/归档/克隆、积分流水、头像 |
| chat | 52 | 会话/消息/已读、sendMessage 运行入口、权限应答、终端（票据+WS）、Git 全套（status/diff/history/snapshot/compare）、LaTeX 编译、文件直链/Office 会话、分享页、图版 |
| files | 3 | 会话文件上传/下载/打包（multipart + 直连网关 /files/*） |
| projects | 15 | 主机项目、项目文件索引/下载（单文件+ZIP）、项目终端、Git 状态、拖拽排序 |
| hosts | 22 | 云主机全生命周期 + 虚拟盘 + SSH 探活（见 §3.2） |
| teams | 17 | 团队 CRUD、邀请接受/拒绝/取消、成员角色/上限、 ownership 转移、邀请码核销 |
| billing | 15 | 套餐、订阅、升级报价 quote、支付订单（收银台 `/__pay/<id>`）、发票、兑换码、邀请码 |
| cards | 8 | 周卡/礼包：发放、领取、核销、作废、后台报表 |
| skills | 12 | 技能市场搜索/安装/卸载/启停、GitHub 技能源、主机技能上传（含归档包）、技能文件读取 |
| support | 18 | 工单（用户/后台双面）、公告（后台 CRUD + getActiveAnnouncements 驱动登录弹窗） |
| agents | 8 | 子智能体配置、MCP 服务器登记与连通性探测 |
| images | 6 | 生图任务：生成/重试/删除/下载（消耗算力） |
| admin | 65 | 16 个后台页的数据面：用户/团队/主机/订单/发票/兑换码/邀请裂变（cohorts/risk）/promoters/工单/公告/审计/迁移/渠道报表/会话成本透视 |

## 7. 安全与隔离 [C]

- 每命令 `ctx = {user, teamId}`；资源归属校验 `ownHost/ownProject`：`need(p.teamId===ctx.teamId || super_admin)`
- 文件路径全部走 `safeJoin` + root 前缀断言（含 `sep` 边界，防 `/root-evil` 绕过）
- Bash 沙箱：会话工作区内执行；生产语义需授权（本地演示引擎同样过审批门）
- 密钥不落库不进前端；LLM key 只在 server env

## 8. 模型体系与真实供给（workbuddy 车道交叉验证版，双向复现 ✅）

> 本节由 workbuddy（CodeBuddy）车道率先逆向（其 `docs/09-红队逆向分析.md`，在途文件），zcode 车道按证据合同逐条独立复现，**全部 CONFIRMED**，并补充新发现。

### 8.1 完整模型注册表 [B]（ChatStatusBar-CMXxaPi9.js @356932–357720，逐字提取）

- **自有三档**：`clawsgo-1.5-lithium / -silicon / -titanium`（1.0 代同名单独成列，picker 里有 1.0→1.5 迁移映射）
- **原生模型直连**（描述符逐字在册）：`deepseek-v4.1-flash / deepseek-v4-flash / deepseek-v4-flash-vision / deepseek-v4-pro`、`glm-5.3 / glm-5.3-flash`、`claude-opus-5-5 / -5-5-fast / -5 / -sonnet-5-5 / -sonnet-5 / -opus-4-8 / -4-7 / -4-6 / -fable-5 / -fable-5-1`、`gpt-5.5 / gpt-5.6-luna / -terra / -sol / gpt-6-sol / gpt-6.1-sol / gpt-6-astra`、`gemini-3.8-flash`、内部测试位 `clawsgo-test-1..5`
- **自有名↔底层描述绑定**（i18n 闭包逐字核过）：lithium 档 = "DeepSeek 最新轻量模型。低延迟、低消耗"；titanium 档 = "Anthropic 最新 Mythos 级模型。为最难的科研问题打造"；计费锚点文案 = "${model} 的算力消耗约为 Claude Opus 5.5 的 ${ratio} 倍"
- **管理员特权**：`模型菜单里可选 Opus 5.5 Fast 专线`（AdminUserDetailDialog，后台可按用户开通）
- **跑分表** [B]（_app-BgTMFHYY.js @65680）：`['lithium','silicon','titanium','glm','kimi','opus','fable']` 对照 `HLE (w/ tools)` 等基准：lithium 48.2 / silicon 51.5 / titanium 60 / glm 54.7 / kimi 56 / opus 57.9 / fable 63 —— 自有档与原生旗舰同榜
- **上下文档位**：128K（默认）/ 512K / 1M，切换模型重置上下文缓存（"next turn costs more, then back to normal"）

### 8.2 终端 WebSocket 协议 [B]（_shell-DLMlr5Wy.js @167739）

`attachTerminal/attachProjectTerminal` 取 **ticket** → WS 连接（URL 带 ticket）→ 帧 `{t:'data',bytes}` / `{t:'exit'}` / `{t:'reason'}`；状态机 `connected / link_lost / failed / session_gone`；错误码 `NOT_FOUND / HOST_OFFLINE`。云主机**按需唤醒**（"Reading files, waking the cloud host may take a moment"）——与 `run-host {offline}` 帧和 `paused` 态互证。

### 8.3 图像生成 [B]

前端 `generateImage` 直调，模板库（mechanism/flat/academic/chemistry/anatomy…）+ aspectRatio `auto/1:1/16:9/9:16`（ImageTemplateLibrary chunk）；线上为真实 AI 生图，本地复刻为零依赖 PNG 编码器（自写 CRC + deflate，HSL→RGB 占位图）。

### 8.4 两车道合并后的复刻差距总表（要 100% 真实还差的清单）

| 维度 | 线上 | 本地复刻现状 | 补齐路径 |
|---|---|---|---|
| LLM 供给 | 自有三档 + 原生直连（§9.1） | 演示引擎；env `CLAWSGO_LLM_*` 可接任意 OpenAI 兼容真模型，帧协议不变 | 配 env 即真 |
| SSE 帧 | 15 帧 | 10 帧 + ping；缺 `run-context/run-host/host-presence/image-updated/conversation-read` | server/lib/sse.mjs 补 5 发射点 |
| 云主机 | 真 SSH 远程主机 + 按需唤醒 + noVNC 桌面 | 虚拟盘 + 2s 模拟开通 + 真 TCP 探活 | 接真 SSH exec / noVNC 代理 |
| 终端 | xterm.js ↔ WS ↔ SSH | ticket+WS+本地 exec（协议同形） | 后端 exec→SSH 通道 |
| 生图 | 真实 AI 模型 | PNG 占位图 | images.mjs 接生图 API |
| 计费 | 微信/Stripe 真实支付 | 模拟收银台页 | 对接支付回调 |
| 验证码 | 阿里云 FeiLin 滑块 + cloudauth 指纹 | 任意 6 位 | 前端引 AliyunCaptcha + SceneId |

### 8.5 交叉验证台账

| 声称（workbuddy） | zcode 独立复现 | 结论 |
|---|---|---|
| 模型映射三档（deepseek/deepseek/claude） | ChatStatusBar i18n 闭包逐字核过 + `IC` 描述符表 @356932 | CONFIRMED |
| 完整底层模型列表 | @357243–357720 逐字提取（含 gpt-6.1-sol、claude-fable-5-1 等新增） | CONFIRMED+扩充 |
| 终端 WS 协议/状态机 | 与 server 端 ticket 实现同构核对 | CONFIRMED |
| 云主机=真 SSH 按需唤醒 | `run-host {offline}` 帧 + 唤醒文案互证 | CONFIRMED |
| e2e 319 断言 | docs/e2e-report.json `pass:319, fail:0`（其 5181 实例） | CONFIRMED |
| 跑分表数值 | _app @65680 数组逐字 | CONFIRMED |

## 9. 证据索引

- 线上抓包：`work/noviprod-sync/live-capture/prod-requests.json`（127 条）、`prod-login-wall.png`
- bundle 证据：`live-capture/bundle-evidence{,-2,-3}.json`（chunk@偏移级引用）
- 哈希对账：`/tmp/clawsgo-audit-results.txt` 结论见根 FINDINGS（work/noviprod-sync/FINDINGS.md）
- 本地端到端：`/tmp/clawsgo-verify/network-v3/live-run-full.json`（run-started→done 全帧）
- 线上基础设施深逆向上游：主仓 `docs/research/2026-10-08-clawsgo-novix-1to1/03/04 号文档`

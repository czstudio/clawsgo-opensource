# 双站复现蓝图（REPLICATION-BLUEPRINT · 终版 2026-10-10）

> 十三轮逆向的复现级总纲：数据模型 / pod 生命周期 / 模式-模型映射 / 多用户隔离 / 端到端请求生命周期。
> 证据链：`docs/10-红黑对抗-全功能实现对照.md` §1-18 + `work/noviprod-sync/` 原始轨迹/交付物。

---

## 一、数据模型 Schema（响应字段级聚合）

### novix（任务中心模型）

```
users:        {id, email, googleEmail, githubEmail, name, level(free|pro), subscriptionStatus, credits, referralCode}
sessions:     {id(32hex), title, titleType(user), version:2, creatorUserId, isAnonymous,
               storageTier(HOT), share(bool), enableGpu, createdAt, updatedAt, visitType}
tasks:        {id(数字全局递增), sessionId, agentName, query(@Mode 前缀), queryContent,
               enableGpu, enableBrainstorming, questionMode(task|discuss), fileIds[],
               modelOverride, status(processing|finish|error), errorCode, errorInfo,
               steps[], version(乐观并发)}
steps:        {id(数字全局递增~1.6e7), taskId, createAt, updateAt,
               content: '{"type":"trajectory","content":"[<OpenAI message JSON>]"}'}  ← 双层 JSON 编码
message:      {role(user|assistant|tool), content, tool_calls[{id,function{name,arguments}}],
               agent_name(NovixAgentMain|NovixWriterAgent|NovixCodeAgent)}
workspace 节点: {name, path, type(dir|file), fileKey(nova_agent_v1/user_data/session_<id>/workspace/...),
               mtime, previewType, previewStatus, previewFileKey}
credits 流水:  {userId, taskId, task, agentName, creditUsage, createdAt}
billing 账单:  {id, provider(stripe), statementType(subscription_cycle), sku, amount(USD),
               currency, periodStart/End, paidAt, invoiceAccessMode(hosted_invoice), hostedInvoiceUrl}
```

### clawsgo（团队中心模型）

```
users:        {id, phone(+86…), password, name, roles[], role, plan, banned, locale, theme}
teams:        {id, name, creditBalance, planId}   teamMembers: {teamId, userId, role(owner|member)}
conversations: {id, teamId, userId, projectId, projectKind, title, hostId, modelId(clawsgo-1.5-lithium),
               context(128k|256k|512k), effort, mode, streamId, lastMessagePreview,
               creatorName, projectTitle, sharedSlug}
messages:     {id, conversationId, role, parts[{type:text|reasoning|tool, text?, toolUseId,
               toolName, input, state(input-available|output-available|output-error), output?, errorText?,
               durationMs?, notRun?}], streamId, metadata{usage{inputTokens,outputTokens,contextTokens},
               durationMs, aborted, engine}}
projects:     {id, teamId, userId, name, kind(explicit), instruction, taskCount, myTaskCount,
               creatorName, orderIndex, pinnedAt, archivedAt}
hosts:        {id, teamId, userId, name, kind(cloud|ssh|local), status(running|offline|provisioning|
               rebuilding), spec{cpu,memoryGb,diskGb,gpu}, image, workdir, canDispatchTask, online,
               canOpenTerminal, sshServerId, lastSeenAt, cacheClearedAt}
orders:       {id, kind(plan|topup), planId, months, priceCents(分), provider(stripe|wechat|alipay),
               payUrl, status(pending|paid|closed|refunded), returnOrigin}
models:       自有三档(1.5/1.0 × lithium/silicon/titanium × x0.5~x3 倍率) + 原生直连
               (deepseek-v4 系/glm-5.3/claude-opus-fable 系/gpt-5.6/6.1/gemini-3.8) + vector + test-1..5
```

## 二、pod 生命周期时序（五任务实测分布）

| 阶段 | 时长 | 判定 |
|---|---|---|
| create_task → steps[0]（user 落轨迹） | **3-5s** | **会话常驻 pod 预热绑定**（非每任务冷启；session_<id> PV 多任务复用，fork 案例同目录多 run 佐证） |
| steps[0] → steps[1]（首轮 LLM） | 22-38s | gpt-6.1-sol 长思考首轮 |
| 稳态每步 | ~18s（22 步 2.1min / 174 步 53min 线性） | 工具执行+LLM 往返 |
| 前端轮询 | **首拍 500ms → 稳态 2000ms**（TASK_STATUS_POLL_INTERVAL_INITIAL_MS/MS，bundle 常量），终态集 {finish, error} | |
| 容器形态 | K8s pod，`/mnt/novix-k8s-workspace-root/session_<id>/workspace` PV 挂载 | GCP/GKE，T4 PCIe 直通 |

## 三、模式 → 提示词 → 模型 映射（每模块）

### novix（七模式统一模板 = 类型段+技能清单+用户任务）

| 模式 | agentName | 身族 | 模板核心 | 模型 |
|---|---|---|---|---|
| Auto Pilot | ""(默认) | NovixAgentMain | 裸 query | 用户选或默认 |
| Deep Survey | Deep Search Agent | NovixWriterAgent | paper-style LaTeX→PDF + 12 技能 | 同上 + **writeUpType(paper/report/ppt)** |
| Idea Spark | Idea Agent | NovixWriterAgent | novix-ideaspark skill + treejson CLI + 四道门 | 同上 |
| Method Design | Proposal Agent | NovixWriterAgent | proposal 论文 + writeUpType | 同上 |
| Auto Experiment | ML Agent | NovixCodeAgent | 端到端实验 + entrypoint.sh | 同上 |
| Data Analysis | Notebook Agent | NovixCodeAgent | notebook-first + mcp__notebook__ 逐 cell | 同上 |
| Reproduce Paper | Reproduce Paper Agent | NovixCodeAgent | 复现三约束 + 偏差记录 | 同上 |

**模型规则（bundle 逐字）**：`enableBrainstorming(Discuss) → modelOverride=DISCUSS_MODE_MODEL_OVERRIDE(=默认)`；否则 `selectedModel` 存在则用之。MODEL_OPTIONS 六选 = gemini-3.1-pro-preview(litellm) / claude-sonnet-4.6(openrouter) / kimi-k2.5(kimi) / gpt-5.6-sol / **gpt-6.1-sol(novix_proxy，默认)** / glm-5.1(zai)。
**Skill 权限信封**：`Skill{name}` → `{commandName, allowedTools[]}` → 工具面收窄；三层目录 `/app/skills/novix`(出厂) + `~/.claude_data/skills`(运行时) + `/tmp/claude-10001/bundled-skills/2.1.221/<hash>`(按任务打包)。

### clawsgo（模式=模型选择器 + 上下文档位）

模型注册表（toolMeta + billing chunk）：自有 `clawsgo-1.5-{lithium(x0.5/x1.0), silicon(x1/x2), titanium(x1.5/x3)}` + 原生直连（deepseek-v4.1-flash/flash-vision/pro、glm-5.3/flash、claude-opus-5-5(-fast)/sonnet/fable 系、gpt-5.6-luna/terra/sol、gpt-6-sol/6.1-sol/astra、gemini-3.8-flash）+ clawsgo-vector + test-1..5（内部位）；上下文档位 128k/256k/512k/1M；effort high/…；计费锚 = Claude Opus 5.5 倍率。Agent 工具面 = 原生九件 + MCP 四件（computer 24 动作/deliver_files/generate_image/web_search）+ agent-browser CLI 特判。

## 四、多用户隔离（全貌）

| 层 | novix | clawsgo |
|---|---|---|
| 认证 | 44B 不透明 token（服务端会话表）+ **fingerprint 头**（匿名）+ FingerprintJS Pro | cgt_ token（set-auth-token 头轮换，30 天滚动，**重登录失效旧 token**）+ 阿里云验证码（cn 区） |
| 资源归属 | tasks.createdBy / sessions.creatorUserId；越权读 `{code:"5100","not your task"}` | teams + teamMembers 双表；ctx.teamId=resolveTeamId（membership 校验，fallback 仅本人个人团队） |
| 工作区 | 物理 PV 隔离 `session_<id>/workspace` | 每会话 `workspace/<conversationId>` 真目录 |
| 档位门 | UI locked + 服务端 5016（Auto Experiment/Reproduce 需付费档；USER_FREE_NOT_USE_CODE_AGENT） | 套餐四档定并发/规格；GPU 主机需 team owner 开通 |
| 广播域 | SSE/轮询按用户/会话 | SSE hub 按 teamId publish |
| 已修漏洞（本车道） | pub fork 越权读（待修 F1） | IDOR fallback/Math.random/多活 token/OTP 泄露/admin 越权/CORS 六修 |

## 五、端到端请求生命周期（从发指令到返回）

### novix（任务式）
```
用户输入(模式页/双字段) → POST chat_session/create {query} → {id:32hex}
→ POST task/create_task {agentName, chatSessionId, query:"@Mode …", queryContent,
   enableGpu, enableBrainstorming, questionMode, fileIds[], modelOverride, tempUrl?}
→ [3-5s] 调度器绑定会话常驻 K8s pod（session PV）
→ agent（Claude Code 式）循环：steps 落库（双层 JSON trajectory）+ tool 真执行
   （Bash/GPU cuda/超时递增看护/MCP 检索/notebook 逐 cell/Skill 权限信封）
→ 前端并发：get_task 轮询（500ms→2s，version 乐观并发）+ workspace/subtree 周期刷新
→ AskUserQuestion 挂起（可选）→ POST task/submit_user_question {toolCallId,result} 回填
→ 终态 finish/error → deliver_to_user（delivery/MANIFEST）→ 计费落流水（用量制≈50步/credit）
```

### clawsgo（流式）
```
composer(Send) → POST sendMessage {conversationId, teamId, text, modelId, subagentModelId,
   effort, mode, context, ensure}
→ SSE hub.startRun → 帧：run-started → [run-context(初始)] → part/part-delta(文本流)
   → part(tool 状态机 input-available→output-available|output-error) → run-context(每工具回合)
   → permission(Bash 审批卡) ⇄ answerPermission → permission-answered
   → track-part(子agent 轨道) → title-updated(首轮) → host-presence/run-host(主机事件)
   → image-updated/conversation-read(粗粒度 onCoarse) → done{metadata.usage,durationMs}
→ 落库：messages.parts 全量 + conversations 预览/未读 + streamId 清空（前端退出 streaming）
→ 中断恢复：重连 subscribeEvents → channel-ack{running[]} + snapshot{parts,permissions,hostOffline,contextTokens}
```

## 六、复现检查单（对照两复刻仓）

- [x] novix-open：自治 agent 循环/六 MCP 域/AskUserQuestion/模板七件/notebook 执行/terminal CSV
- [x] clawsgo-open：271 命令/15 帧/双大脑 agent/权限门/云主机虚拟盘/三通道支付壳/e2e 319
- [ ] novix-open：数据模型字段名对齐本蓝图 §一（sessions.version/storageTier 等签名位）
- [ ] clawsgo-open：支付通道壳 → 真 Stripe/微信 Native QR（payUrl 渲染 180px QR 已知）
- [ ] 两仓：pod 常驻语义（当前为进程内执行器；K8s 化时按 §二 3-5s 绑定+session PV）

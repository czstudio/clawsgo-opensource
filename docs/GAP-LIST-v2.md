# GAP-LIST v2 —— 三席位批判会 + REA 语义图（2026-10-10 终版差距清单）

> 来源：kimi（派 3 个 explore 子代理逐 file:line 核实，最狠）+ grok（务实验收派）+ deepseek-v4.1-flash（架构重排派）三席位独立批判；REA 6.4.0 语义图增量（17961 节点/26746 关系，`work/noviprod-sync/novix/live/rea-semantic-graph.json`）。
> 结论句（kimi 原话）：**"骨架真、招牌假"——循环/命令注册表/SSE 帧/前端壳是真的；产品差异点（GPU、九技能、三档模型、权限信封、提问闭环）几乎全是装饰实现或死代码。**

---

## 一、被判死刑的核心差距（按用户可感知重排，三席位合并）

### P0-1 论文全链（deepseek 排第一，kimi/grok 同意）
- 九技能只 3 桩；`export_pdf.py`/`report-quality-gate` 验收门/`publication-plots`/`scientific-schematics`/`dataviz+validate_palette.js` 全缺
- **`LIVE_TEMPLATES` 重复 key 死代码**（autoexperiment 定义两次，后者覆盖前者——kimi 抓的 bug）
- wrapper 提示词点名不存在的技能 → LLM 每轮吃"未安装"（自相矛盾）
- **无 LLM 时 deepsurvey 永不产 PDF**（fallback kernel 停在 manuscript.md）
- PNG 逐页自审零实现；bib 去重/DOI/arXiv 校验零实现
- clawsgo `compileLatex`="跳过编译"占位（**本机有 tectonic 未接**——grok 验收：响应 pdf 非空、%PDF 开头、pdffonts 退出码 0）
- grok 硬验收："deepsurvey finish 时工作区必须有 v1/v2 草稿、bib、真编译进 PDF 的图、pdfinfo/pdffonts、页数相等的 PNG；拿 685029 那份 3 页无图 PDF 出来算失败"

### P0-2 GPU 真实实验（kimi 判"比说的糟：enableGpu 是死参数"）
- `enableGpu` 存 → 传 → **agent-loop 全文从不读**；fallback kernel 还主动 `CUDA_VISIBLE_DEVICES=""`
- sandbox 无 `--gpus`；无 GPU 镜像
- **Bash 一刀切 120s 超时**——线上 300/480/600 递增看护不存在，>2 分钟训练必被砍死（kimi 判 P0）
- 无训练日志活体流（进程 close 才一次性返回）
- grok 验收：有 N 卡机器上轨迹含 `Device: cuda` + 数值指标；"本机跑过不算过"

### P0-3 Code Agent 与身族（kimi："换标签的同一只 agent"）
- `/call_agent` = `/start_code_agent` = `createTask(mode:'auto')` 同循环同 prompt——**三身族零行为分化**（只差轨迹里的字符串标签）
- `allowedTools` 权限信封**全仓零命中**（没有任何执行点消费它）
- Task 子 agent 工具 = 零实现（grep 无派发代码，kimi 把我"演示态"的措辞证伪为"零实现"）

### P0-4 检索三件套
- `get_paper_fulltext`（literature.mjs 有 arXiv 元数据但不下载 PDF、未挂工具）
- 真 `web_search` 全域无搜索能力（只有 url2text 抓已知 URL；clawsgo `workspace.mjs:857` 有真实现可搬）
- `google_scholar_search` 是死代码（web_tools.py:606，server 零 import）
- deepseek 补刀：引用真实性校验（防幻觉引用）缺

### P0-5 沙箱/运行时镜像（deepseek 新增席位 B 判 P0）
- sandbox=`docker python:3.11-slim`：**无 CUDA、无 TeX、无 pdfinfo/pdffonts、无 Poppler、无字体**——论文链和 GPU 实验都不可能在这镜像上真跑
- 需要一台"全能实验镜像"（或分层：base/latex/gpu 三档）

### P1（第二批）
- 提问闭环断在前端：服务端回填链路真，**dist 里 `submit_user_question` 出现 0 次**——用户没路可答，agent 挂 10 分钟拿超时自答（kimi）
- phase 指示器是 `elapsed/8s` 轮换的**假动画**（kimi）
- 持久化：cancel 不停 agent（`ctx.signal` 恒 null）、重启后 processing 永久烂尾、跨轮不注入对话历史、notebook 内核态跨 task 丢
- clawsgo 三档模型/原生直连全系摆设：**modelId 存进会话后无人消费**（选什么都打同一 env 端点）；token usage = 字符数/2.2+Math.random() 编造；credit 只进不出；computer 枚举 17 非 24 且纯回显；probeMcpServer stdio 假成功（kimi 席位逐条 file:line）
- canned 回退伪装真实执行（XOR 玩具 MLP / 9 行 iris 与 query 无关）——无 LLM 用户得到"跑过实验"假象
- usage 计量缺失（支付可不做，用量事件必须有——deepseek）
- 测试缺口：novix 缺 GPU e2e、论文 114 步 e2e、MCP 契约、回填测试（clawsgo 319 只证命令层）

### 明确不做（grok"不要做"清单 + 共识）
- 不重写十二份技能散文（图没出来是完成条件没要求，不是缺 SKILL.md）
- 不把 paper_agent/research_agent 接进 server（上游批处理，不跑 train.py）
- 不上 K8s、不重做 Vue、不做满 computer 24 动作、支付暂缓

---

## 二、REA 语义图增量（本轮新增复现底册）

`rea analyze-javascript-application`（7 chunk，374632 AST 节点，17961 图节点/26746 关系）产出**可直接消费的语义图**：
- **SKU 全表 13 常量**：`{LITE,PRO,LAB}×{SUB_MONTHLY, TERM_1M, TERM_3M, TERM_12M}` + `PRO_TERM_{1M,3M}_BOGO`（买一送一变体）——**三档套餐×四时长矩阵 + BOGO**（此前只知 PRO_SUB_MONTHLY 一个）
- UpgradeTab 98 slots / useSettingsData 187 slots 全量状态字段面（billingMode/subscriptionPlans/promotionCode/originalPrice/percentOff/entitlementEndsAt/nextMonthCredit/portalUrl/payUrl/inviteInfoList…）
- 图关系型：aliases/reads/captures/defines/argument-to-parameter/returns-to-call/calls/awaits——**Vue 源码级重建的现成输入**（node_id 级可回溯 source_range）
- REA 工具定位：`analyze-web-bundle`（CDP 抓线上）/`analyze-javascript-application`（本地 dist）/`compare`（版本 diff）——已入工具矩阵（v6.4.0，npm 全局）

## 三、执行总序（给执行对话）

1. **P0-1 论文链**（deepseek/kimi 双第一）：九技能脚本化 + tectonic 接线 + 质检门 + PNG 自审 + 修 LIVE_TEMPLATES 重复 key + fallback 也产 PDF
2. **P0-2 GPU**：enableGpu 全链接通 + sandbox `--gpus` + 梯子超时 + 日志流
3. **P0-4 检索三件套**（捆进 1 一起修——论文链的输入）
4. **P0-5 实验镜像**：base/latex/gpu 三档 Dockerfile
5. **P0-3 身族分化**：Writer/Code 两套工具面+提示词真分化 + allowedTools 消费
6. P1 批次按上文顺序
每项验收标准见各席位原文（grok 五条硬验收已内嵌上文）。

# ClawsGO 真实执行模型：云主机 / CPU-GPU 实验 / 论文生成

> 本文件只记录**生产前端 bundle 里可验证的事实**，每条结论都带出处文件与原始字符串。
> 分析时间：2026-10-10
> 数据源：`.live/app/assets/*.js`（与线上哈希一致的生产构建产物）
> 纪律：拿不准的显式标注 `UNVERIFIED`，不把本地重写后端的实现当成线上证据。

---

## 0. 一句话结论

ClawsGO **没有一个 ClawsGO 自建的 GPU 集群调度器**。它的执行模型是：

1. **云主机（Cloud Host）** = 平台提供的 **纯 CPU** 常驻实例（规格按订阅档位给 vCPU/内存/云盘），预装 **350+ 科研软件与参考数据库** + 完整 TeX Live；
2. **GPU / 超算** = 用户**自带**（BYO），通过 **SSH 连接器**把实验室服务器、GPU 节点、计算集群接进来，agent 在任务里直接登入执行；
3. **实验** = agent 在这些载体上跑 **shell / Python / R / nf-core** 等真实命令（不是可视化"实验编排器"）；
4. **论文** = agent 用 **LaTeX（TeX Live + latexmk + biber + XeLaTeX）** 写 `.tex`，配 `.clawsgo/figures/` 里的图，最后导出 PDF。

> 关键纠正：早期把 `clawsgo-open/server/lib/agent.mjs`（本地演示后端）当成线上证据，得出"没有 GPU 调度、集群模式是模拟"的结论。**那份代码是本地复刻，不是线上实现**。本文件的结论全部改由生产 bundle 支撑。

---

## 1. 三类执行载体（Task 运行在哪里）

bundle 里明确区分三种主机，UI 文案（`hosts-*.js` / `_app-*.js`）：

| 载体 | 原文证据 | 含义 |
|------|----------|------|
| **云主机** | `一台独立的云主机，供你的任务使用。云主机的使用成本由 ClawsGO 承担。` | 平台出资的常驻实例，CPU |
| **本地设备** | `直接读写此电脑上的项目、使用本地终端，让它作为主机运行任务。` / `此电脑自动连接失败，可在「主机」页里手动连接` | 用户自己的电脑装桌面端，当作 host |
| **远程节点** | `智能体在任务中能直接登入的实验室服务器、GPU 节点与计算集群，全队共用。` / `经 SSH 接入组里的服务器或超算` | BYO SSH，团队共享 |

任务派发时的选择文案：
> `在输入框上方选择任务运行的主机。本地设备上的任务需要电脑保持开机在线；需要持续运行时，也可以选择云主机。`

**证据文件**：`hosts-Bn4J1VDx.js`、`hosts-B0wX8YS_.js`、`hosts-BtbCiVuh.js`、`hosts-B6L6Uegf.js`、`HostTerminal-DHcsVxVM.js`

---

## 2. 云主机规格：**纯 CPU，没有任何 GPU 档**

这是最关键的一条硬证据。bundle 里订阅档位 → 主机规格的映射是**硬编码**的：

```js
// billing-Bitt_SRn.js（生产 bundle 内联常量，已用 node 定位验证）
var ve = {
  free:       { cpus: 2,  memoryGb: 4  },
  plus:       { cpus: 2,  memoryGb: 4  },
  pro:        { cpus: 4,  memoryGb: 8  },
  max:        { cpus: 8,  memoryGb: 16 },
  ultra:      { cpus: 8,  memoryGb: 16 },
  business:   { cpus: 16, memoryGb: 32 },
  enterprise: { cpus: 16, memoryGb: 32 },
};
var ye = { free: 10, plus: 20, pro: 50, max: 100, ultra: /*…*/ };  // 云盘 GB
```

UI 渲染格式（同一文件）：
```js
$ = e => e ? `${e.cpus} vCPU · ${e.memoryGb} GiB · ${e.diskGb} GB` : `—`
`${e?.cpus}CPU ${e?.memory}GiB 云主机 · ${e?.disk}GB 云盘`
```

**结论（CONFIRMED）**：
- 最高档 enterprise = **16 vCPU / 32 GiB / 大云盘**，字段只有 `cpus / memoryGb / diskGb`，**没有 `gpu` 字段**。
- 所以"云主机跑 GPU 实验"在平台侧**不成立**——云主机是 CPU 实例。

> 注意：`samsung-*` 里出现的 `gpu` 字样（如 `texture units while this GPU supports only`、`EXT_MESH_GPU_INSTANCING`）属于 **Three.js / 3Dmol / Mol\*** 等前端渲染库的 WebGL 代码，与后端算力无关。**不要把它们当成 GPU 调度证据**。

---

## 3. 云主机生命周期（睡眠 / 唤醒 / 重建）

| 行为 | 原文证据 | 语义 |
|------|----------|------|
| 空闲休眠 | `休眠期间不产生任何消耗，新任务到来时自动唤醒。` | 按需计费，空闲不计费 |
| 唤醒 | `云主机正在唤醒，需要 10 到 30 秒` / `正在唤醒${e?.name}` | 冷启动 10–30s |
| 重建 | `重建会杀掉实例上运行中的全部进程并按引擎账本的当前期望规格（${e?.spec}）开新壳——未保存的输入不算数；用户数据（/home/user）原样保留。` | 换规格 = 重建容器，`/home/user` 持久化 |
| 重装系统 | `确定重装「${e?.name}」的系统吗？主目录中的文件、项目与自装环境保留，正在运行的任务将被强制停止，此操作无法撤销。` | 系统盘可重装，home 保留 |
| 规格变更 | `保存只记账不打扰运行中的实例；实例停止后的下次冷启动或重建时按新规格开壳（暂停唤醒不换壳）。` | 规格变更延迟到下次冷启动生效 |

**推断（INFERRED，有强证据）**：云主机是一个**带持久化 `/home/user` 的容器/轻量 VM**，平台维护一份"**引擎账本**"记录期望规格，重建时按账本开新壳。这解释了"唤醒 10–30s""重建保留 home""规格下次冷启动生效"三条一致行为。

---

## 4. 云主机预装：350+ 科研软件与参考数据库

bundle 里有一份**巨大的软件目录**（中英双语），文案前缀：
> `云主机已预装生物信息、化学与材料、工程计算、医学等领域的常用软件、工具与参考数据库。无需任何配置，打开即可开始研究。在输入框键入 @，即可按名称调用。`

提取统计：`UserMessage-DCBTYUAE.js` 中带句号的中文条目 **350 条**（去重后）。抽样（真实字符串）：

| 领域 | 条目（原文） |
|------|--------------|
| 排版 | `完整 TeX Live，含 latexmk、biber 与支持中文的 XeLaTeX。` |
| 通用 | `预装 Python · R · LaTeX 与数百个科研组件，全部可直接使用。` |
| 统计 | `线性与广义线性混合模型及边际均值。` / `计量经济：高维固定效应、面板与工具变量、双重机器学习。` |
| 生信 | `人类参考基因组，含注释与比对、定量索引。比对需 Pro 及以上方案。` / `宏基因组分箱与 MAG 质量评估，数据库已内置。` |
| 化学 | `化学格式互转与 3D 构象生成。` / `AiZynthFinder 的 USPTO 逆合成策略、模板与 ZINC 库存。` |
| 材料/物理 | `平面波 DFT，支持 MPI 并行，赝势库已内置。` / `基于 Geant4 的蒙特卡洛模拟：PET、SPECT 成像与放疗剂量。` |
| 天文 | `宇宙学参数推断，含 CAMB 与 CLASS，内置 Planck 似然。` / `引力波参数推断，含 gwpy、PyCBC 与 LALSuite。` |
| 地学 | `从 Python 调用 GMT 绘制地学图。` / `下载 ERA5、NASA Earthdata 与哥白尼数据，需自备账号。` |
| 工程 | `有限元求解偏微分方程，支持 MPI 并行。` / `电路原理图与 PCB 设计，含官方元件库，另有 Qucs-S 仿真。` |
| HPC | `流程引擎与 nf-core 流水线，大型任务可提交到 SSH 集群。` |

**结论（CONFIRMED）**：云主机镜像 = conda/系统级预装的多学科科研环境；"软件与数据库"在输入框用 `@` 引用（`描述你的任务，/ 触发指令或技能，@ 引用文件、任务、软件与数据库`）。

### 4.1 目录分类（bundle 内联 taxonomy，共 17 类）

从 `UserMessage-B0GIA-My.js` 提取的分类注册表：

```js
// group = "discipline"（学科，10 类）
research-methods, medicine, life-sciences, chemistry-materials,
physics-engineering, computing, math-statistics, social-sciences,
humanities, earth-environment
// group = "profession"（职业，7 类）
law, business, finance, product, marketing, teaching, cross-domain
```

### 4.2 完整目录已导出

`work/deep-reverse/software-catalog-zh.txt`（从 bundle 提取，含来源锚点）。
提取脚本锚点：`UserMessage-B0GIA-My.js` 内 `H2O` / `GluonTS` 定位，解析 `X=()=>\`…\`` 形式的中文描述。
去重后 **624 条**（其中约 350 条为明确的科研软件/数据库条目，其余为同类文案）。

---

## 5. 实验到底怎么跑（执行模型）

### 5.1 不是"实验编排器"，是 shell 执行

bundle 里**没有任何**"实验调度器 / job 提交 / 资源配额分配"的前端组件。实验的执行主体是 **agent 的工具循环**，落到主机上就是**真实命令**：

- 终端组件：`HostTerminal-*.js`（xterm.js 风格，走 WebSocket）
- 终端文案：`终端数量已达上限`、`确定终止「${e?.name}」？其中正在运行的程序会一并结束，无法恢复。`
- 提示词级证据（`ChatProjectDialog-*.js`）：`读取 figures/ 下已有图的配色与字号` —— 这是 agent 在任务里"读工作区文件"的真实指令。

### 5.2 资源上限 = 内存/进程数（不是 GPU 配额）

最有力的"执行模型"证据来自**报错文案**（`*.js`）：

```
并行进程或线程数达到了云主机上限，主机已自动恢复，文件均无损。
回复「继续」即可恢复运行，建议减少并行进程与线程数（如 n_jobs、线程池大小）。

计算任务耗尽了云主机的内存或进程数上限，主机已自动恢复，文件均无损。
回复「继续」即可恢复运行，建议让大数据分块处理、减少并行进程与线程数。
```

**结论（CONFIRMED）**：
- 平台的资源约束维度是 **内存 + 进程/线程数**（典型 CPU 容器），**没有 GPU 显存配额**。
- 超限后平台**自动恢复主机**（进程被杀但文件无损），agent 用「继续」续跑 —— 这解释了任务"可恢复"的机制。
- 建议用户"减少 `n_jobs`/线程池" —— 说明跑的是 **Python/科学计算** 负载。

### 5.3 单变量循环 / baseline 之类的"研究法"

在**前端 bundle 里没有** `results.tsv`、`program.md`、`baseline` 这类 Auto-Research 概念（这些出现在另一个项目 `idea2paper` 的 AGENTS.md 里，**不是 ClawsGO**）。
**ClawsGO 的做法是把方法论写进 prompt/技能**（如 `把《Attention Is All You Need》… 产出一套结构清晰的幻灯片… 幻灯片用 LaTeX Beamer 制作`），由 agent 自行执行。标注：**ClawsGO 无独立实验框架**（CONFIRMED，全 bundle 无相关组件）。

---

## 6. GPU 到底怎么接入（BYO SSH）

### 6.1 SSH 连接器（团队共享）

UI 文案：
> `智能体在任务中能直接登入的实验室服务器、GPU 节点与计算集群，全队共用。`
> `经 SSH 接入组里的服务器或超算`
> `Connect your lab's servers or HPC cluster over SSH`

SSH 服务器表单字段（bundle 内联）：
```js
{ sshHost, sshPort /* 默认 22 */, sshUser, /* 私钥 */ }
// 端口转发 / 跳板：
{ sourceHost, targetHost, fromPort, toPort }
// 私钥粘贴框提示：
-----BEGIN OPENSSH PRIVATE KEY-----
```

**结论（CONFIRMED）**：
- GPU 能力 = **用户自带节点**，通过 SSH 连接器登记（host/port/user/私钥），支持**端口转发（隧道）**。
- 描述字段会告诉 agent 用途：`服务器用途（会告知智能体，用于分配任务）`。
- 有数量上限：`服务器数量已达上限`。

### 6.2 其他连接器

| 类型 | 证据 |
|------|------|
| MCP 服务器 | `添加 MCP 服务器` / `在主机上以进程运行，适合 npx / uvx 一行命令的服务器` / `.mcp.json`（项目级） |
| 文献库/数据库/实验平台 | `智能体在这台主机上能直接读写的文献库、数据库、实验平台与内部系统。` |
| 向量数据库 | `向量数据库与近邻检索，用于 RAG。` |

作用域：主机级（全队）+ 项目级（`.mcp.json`）+ 子智能体级（`只给这个子智能体用`）。

---

## 7. 论文生成链路（LaTeX）

### 7.1 产物是 LaTeX

| 证据 | 出处 |
|------|------|
| `\\begin{figure}[htbp]` / `\\end{figure}` | bundle 内联 LaTeX 模板 |
| `完整 TeX Live，含 latexmk、biber 与支持中文的 XeLaTeX。` | 软件目录 |
| `把 PDF 转成 LaTeX` | 技能 |
| `回归结果出表，导出 Word、LaTeX 与 HTML。` | 统计技能 |
| `把《Attention Is All You Need》… 幻灯片用 LaTeX Beamer 制作，学术风格。` | 工作流模板 |

**结论（CONFIRMED）**：论文/汇报走 **LaTeX → PDF**（XeLaTeX 支持中文，biber 管参考文献）。

### 7.2 图（Figure）系统

| 证据 | 含义 |
|------|------|
| `.clawsgo/figures/` | 图存放目录 |
| `application/vnd.clawsgo.figure+json` | 自定义图格式（可编辑） |
| `读取 figures/ 下已有图的配色与字号` | agent 复用已有图风格 |
| `[figure] persist failed:` | 图持久化错误 |
| `从插图到可编辑 SVG，让想法成图，让细节可改。` | 矢量图可编辑 |
| `交互式图表，经 Kaleido 导出静态图。` | Plotly → 静态图 |
| `在矢量图编辑器里修改文字、颜色、形状与布局，下载 SVG 或导出 PNG。` | SVG 编辑器 |

**论文配图链路（INFERRED）**：agent 用 matplotlib/Plotly → Kaleido 出静态图 → 存 `.clawsgo/figures/` → LaTeX `\begin{figure}` 引用 → XeLaTeX 编译。

### 7.3 导出与交付

- `交付物` / `Artifact`（产物面板）
- `导出 PDF`、`导出 PNG`、`导出 CSV`、`导出 Excel（${e?.count}）`
- `为保留文字或效果的外观，已按位图导出 PDF`（矢量转位图提示）
- 下载桌面端：`下载 Mac / Windows 桌面端`

---

## 8. 记忆 / 人格 / 子智能体

| 概念 | 证据 | 存储 |
|------|------|------|
| 人格与指令（主机级） | `智能体在这台主机上的性格、习惯与长期须知。` | 主机 |
| 项目须知 | `智能体在这个项目里的性格、习惯与课题须知，叠在主机人格与指令之上。` | 项目 |
| 记忆 | `还没有记忆，智能体会在任务中自行积累` / `记忆三阶段模型` | 主机/项目 |
| 子智能体（主机级） | `对这台主机上的每个任务可用。主智能体按「描述」判断何时把子任务交给它；它在独立上下文里工作，只带回结论。` | `AGENTS.md` 风格 |
| 子智能体（项目级） | `只对这个项目可用，写在项目目录的 .clawsgo/agents 里。` | `.clawsgo/agents` |
| 迁移 | `把这个项目的工作目录与记忆复制到另一台主机，成为那里的一个新项目；任务记录留在当前项目。` | 跨主机 |

三种运行模式（UI）：
- `单体`（solo）
- `主从模式`（delegate）
- `智能体集群模式（研究级深度）`（cluster）

> 子智能体**在主从和集群模式下生效**（`在主从和集群模式下生效`）。集群模式的实现细节在**服务端**，前端只暴露 UI。标注：**服务端编排实现 UNVERIFIED**（前端 bundle 不可见）。

---

## 9. 任务生命周期与容错（完整文案表）

| 状态 | 原文 |
|------|------|
| 暂停 | `任务已暂停，主机恢复在线后自动继续` / `进度已保存，回复「继续」恢复运行` |
| 中断 | `任务已中断，待主机恢复在线后回复「继续」` |
| 超时中断 | `长时间无响应，已由平台中断，回复「继续」恢复运行` |
| 运行时长超限 | `运行时长达上限已停止，回复「继续」恢复运行` |
| 内存/进程超限 | `计算任务耗尽了云主机的内存或进程数上限，主机已自动恢复，文件均无损。回复「继续」即可恢复运行…` |
| 并行超限 | `并行进程或线程数达到了云主机上限，主机已自动恢复，文件均无损。…建议减少并行进程与线程数（如 n_jobs、线程池大小）。` |
| 模型限流 | `模型服务限流或过载，稍候片刻再回复「继续」恢复运行` |
| 上下文满 | `对话已达模型上下文上限，无法在此继续。请新建任务，工作区文件仍然保留` |
| 主机离线 | `主机离线，暂时无法查看其技能` / `${e?.name} 离线，上线后才能预览和下载` |
| 并行上限 | `当前并行任务数已达到上限。等待正在运行的任务完成，或查看方案详情。` |
| 用户停止 | `用户主动停止（metadata.stopped）：不算错误，一行 muted 文本。` |

**结论**：任务是**异步、可恢复、可审计**的；中断统一用「继续」续跑，工作区文件跨中断保留。

---

## 10. 计费：算力（Credits）

| 证据 | 含义 |
|------|------|
| `算力每 30 天发放，月付当期有效` / `未用完的转入永久算力` | 订阅按 30 天发算力 |
| `${e?.name} 每个计费周期（30 天）可消耗的算力上限…留空表示不限。` | 团队可设算力上限 |
| `云主机的使用成本由 ClawsGO 承担。` | 云主机成本平台承担（用户花的是算力） |
| `切换模型会重置上下文缓存。下一轮消耗更高，之后恢复正常。` | 计费按 token/上下文 |
| `切换模式会改变可用工具，并重置上下文缓存。` | 模式切换影响成本 |
| `在智能体消息、总览与团队用量中显示算力与 token 明细` | 双维度计费（算力 + token） |

**结论**：计费 = **算力额度（30 天周期）+ token 明细**；云主机本身对用户不单独计费。

---

## 11. 与本地复刻仓的差异（必须修的地方）

本地 `clawsgo-open/server/` 目前是**演示级**实现，与线上真实模型有差距：

| 维度 | 线上（生产 bundle 证据） | 本地复刻现状 | 处理建议 |
|------|--------------------------|--------------|----------|
| 云主机规格 | 硬编码 7 档 CPU 规格（2–16 vCPU） | 无主机规格模型 | 补 `hostSpec` 命令 + 档位表 |
| 主机生命周期 | sleep/wake/rebuild/reinstall | 无 | 补状态机 + 唤醒延迟 |
| 预装软件目录 | 350+ 条 | 无 | 补目录数据（可作静态资源） |
| GPU | BYO SSH 连接器 | 无 | 补 SSH 连接器 CRUD |
| 论文 | LaTeX/TeX Live | Write 工具写 `.md` | 保留，但补 LaTeX 模板与图目录 |
| 记忆/人格 | 主机级 + 项目级 + 子智能体级 | 部分 | 补三级作用域 |
| 任务容错 | 内存/进程/时长/并行/限流 5 类中断 | 无 | 补中断文案与恢复语义 |

> 本地 `server/lib/agent.mjs` 的 `SYSTEM_PROMPT`（`你是 ClawsGO Science 的长时程科研智能体…`）**在生产 bundle 里搜不到** —— 系统提示词在**服务端**，前端不可见。**不要**把它当作已还原的线上 prompt，标注为 **UNVERIFIED**。

---

## 12. 证据索引（file → 结论）

| 文件 | 支撑结论 |
|------|----------|
| `billing-Bitt_SRn.js` | **主机规格档位常量 `ve`（2–16 vCPU，无 GPU）**、云盘档位 `ye` |
| `ChatProjectDialog-BFiN_W03.js` | 子智能体/连接器/记忆 UI、**GPU 节点文案**、**SSH 字段 `sshUser/sshHost`** |
| `hosts-Bn4J1VDx.js` | 主机管理 UI、规格编辑 |
| `hosts-B0wX8YS_.js` / `hosts-BtbCiVuh.js` / `hosts-B6L6Uegf.js` | 主机页、软件目录、连接器 |
| `HostTerminal-DHcsVxVM.js` / `HostTerminal-C2gI5ol9.js` | 终端组件（WebSocket） |
| `UserMessage-DCBTYUAE.js` | 350+ 软件目录、LaTeX、figure 指令 |
| `ChatProjectDialog-BFiN_W03.js` / `ChatProjectDialog-Dakya2RD.js` | 子智能体/连接器/记忆 UI、`读取 figures/` 指令 |
| `data-Wutd3uY5.js` | 6 个种子工作流模板（lit-review / paper-slides / health-trends / clinical-trials / ml-pipeline / due-diligence） |
| `_app-BgTMFHYY.js` / `_app-M3AACWPz.js` | 应用壳、模型基准表、onboarding |
| `ChatStatusBar-CMXxaPi9.js` / `ChatStatusBar-CuMzXsvM.js` | 模型注册表、上下文/effort 选项 |
| `chunk-BO2N2NFS-BB-a2-Vs.js` | 软件目录副本（435KB） |
| `api-DYG_whnY.js` / `api-DCTmFum4.js` | 4 条传输通道、token 旋转 |

---

## 13. 未证实 / 待补（诚实清单）

1. **服务端编排实现**（集群模式如何真正并发、子智能体如何隔离上下文）—— 前端不可见，`UNVERIFIED`。
2. **云主机的底层供应商**（TKE / CVM / 自建 K8s）—— bundle 无证据；仅知阿里云验证码链路（`cloudauth.aliyuncs.com`）。
3. **系统提示词全文** —— 服务端持有，`UNVERIFIED`。
4. **SSH 连接器是否支持 GPU 直通/显存上报** —— 前端只登记 host/port/user，`UNVERIFIED`。
5. **算力↔token 的换算率** —— 前端只显示明细，无换算公式。
6. **主机重建的具体容器运行时** —— "开新壳/引擎账本"是文案级证据，`INFERRED`。

---

*本文件由生产 bundle 逐条字符串提取，所有引用均可按上表文件复现。*

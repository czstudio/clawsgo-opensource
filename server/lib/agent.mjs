// 智能体运行引擎。
//
// 两种大脑：
//  1) 配置了 LLM（环境变量 CLAWSGO_LLM_BASE_URL / CLAWSGO_LLM_API_KEY / CLAWSGO_LLM_MODEL）
//     → 走 OpenAI 兼容的 /chat/completions，真实工具调用循环。
//  2) 未配置 → 内置「本地演示智能体」：真实执行工作区工具（Glob/Grep/Read/Bash），
//     基于真实结果组织回答，并演示权限审批与子智能体编排。
//
// 两种模式输出的 SSE 帧与 parts 结构完全一致。
import { db$, uuid, now, load, save } from './db.mjs';
import { hub } from './sse.mjs';
import {
  ensureWorkspace,
  toolBash,
  toolGlob,
  toolGrep,
  toolWebFetch,
  toolWebSearch,
  listDir,
  readText,
  touchFileRecord,
  workspaceDir,
} from './workspace.mjs';

const LLM = {
  baseUrl: process.env.CLAWSGO_LLM_BASE_URL || '',
  apiKey: process.env.CLAWSGO_LLM_API_KEY || '',
  model: process.env.CLAWSGO_LLM_MODEL || '',
};

export const llmEnabled = () => !!(LLM.baseUrl && LLM.apiKey && LLM.model);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 待审批的权限请求：requestId → {resolve, run} */
const pendingPermissions = new Map();

export function answerPermission({ conversationId, requestId, behavior, answers }) {
  const p = pendingPermissions.get(requestId);
  if (!p) {
    const err = new Error('权限请求不存在或已过期');
    err.code = 'CONFLICT';
    throw err;
  }
  pendingPermissions.delete(requestId);
  const run = hub.run(conversationId);
  if (run) hub.permissionAnswered(run, requestId);
  p.resolve({ behavior, answers });
  return { ok: true };
}

export function abortRun(conversationId) {
  const run = hub.run(conversationId);
  if (run?.abort) run.abort();
  return { ok: true };
}

function newRunState() {
  return {
    parts: [],
    textIndex: -1,
    reasoningIndex: -1,
    aborted: false,
  };
}

/** 流式写一个 text / reasoning part */
async function streamText(run, s, text, { chunk = 22, delay = 14, into = 'text' } = {}) {
  let idx = into === 'text' ? s.textIndex : s.reasoningIndex;
  if (idx < 0) {
    idx = s.parts.length;
    s.parts.push({ type: into, text: '' });
    if (into === 'text') s.textIndex = idx;
    else s.reasoningIndex = idx;
    hub.part(run, idx, s.parts[idx]);
    await sleep(40);
  }
  for (let i = 0; i < text.length; i += chunk) {
    if (s.aborted) break;
    const delta = text.slice(i, i + chunk);
    s.parts[idx].text += delta;
    hub.delta(run, idx, delta);
    await sleep(delay);
  }
  return idx;
}

/** 写一个 tool part 并推进状态 */
async function toolPart(run, s, { toolUseId, toolName, input, run: exec, state = 'output-available' }) {
  const part = {
    type: 'tool',
    toolUseId,
    toolName,
    input,
    state: 'input-available',
  };
  const idx = s.parts.length;
  s.parts.push(part);
  hub.part(run, idx, { ...part });
  const started = Date.now();

  let output = '';
  let errorText;
  try {
    await sleep(160 + Math.random() * 260);
    if (s.aborted) throw new Error('Interrupted');
    const res = await exec();
    output = typeof res === 'string' ? res : res?.output ?? JSON.stringify(res ?? {}, null, 2);
  } catch (e) {
    errorText = e.message;
  }

  const finalPart = {
    ...part,
    state: errorText ? 'output-error' : state,
    durationMs: Date.now() - started,
    ...(errorText ? { errorText, notRun: s.aborted ? 'interrupted' : undefined } : { output }),
  };
  s.parts[idx] = finalPart;
  hub.part(run, idx, finalPart);
  // 线上同款 run-context 帧：每个工具回合后上报上下文用量（前端 Context N% 指示）
  try {
    hub.runContext(run, 2400 + Math.round(JSON.stringify(s.parts).length / 2.2));
  } catch { /* 帧失败不影响主流程 */ }
  await sleep(60);
  return finalPart;
}

/** 请求用户审批（对应前端权限卡片） */
async function requestPermission(run, toolName, input, agentId) {
  const requestId = uuid();
  const request = { requestId, toolName, input, ...(agentId ? { agentId } : {}) };
  const p = new Promise((resolve) => pendingPermissions.set(requestId, { resolve, run }));
  hub.permission(run, request);
  const timeout = new Promise((resolve) =>
    setTimeout(() => {
      pendingPermissions.delete(requestId);
      resolve({ behavior: 'timeout' });
    }, 120000),
  );
  return Promise.race([p, timeout]);
}

// ============================ 主入口 ============================

export async function startAgentRun({ conversation, userMessage, assistantMessage, opts = {} }) {
  const run = hub.startRun({
    conversationId: conversation.id,
    teamId: conversation.teamId,
    userId: conversation.userId,
    messageId: assistantMessage.id,
    parts: [],
  });
  // 初始上下文用量帧（线上首轮即有 run-context）
  try {
    const historyChars = db$()
      .messages.filter((m) => m.conversationId === conversation.id)
      .reduce((a, m) => a + (m.parts ?? []).filter((p) => p.type === 'text').reduce((x, p) => x + (p.text?.length ?? 0), 0), 0);
    hub.runContext(run, 2400 + Math.round(historyChars / 2.2));
  } catch { /* 忽略 */ }
  const s = newRunState();
  const ac = new AbortController();
  run.abort = () => {
    s.aborted = true;
    ac.abort(); // 真中止：杀 LLM fetch + Bash 子进程
  };
  run.signal = ac.signal;

  const ctx = {
    conversation,
    userMessage,
    assistantMessage,
    opts,
    run,
    s,
    workspace: ensureWorkspace(conversation.id),
  };

  (async () => {
    try {
      if (llmEnabled()) {
        await llmAgent(ctx);
      } else {
        await demoAgent(ctx);
      }
    } catch (e) {
      if (!s.aborted) {
        await streamText(run, s, `\n\n> 运行中断：${e.message}\n`);
      }
    } finally {
      // 落库。整段包在 try 里 —— 落库出问题也绝不能把进程带走，
      // 否则 SSE 永远等不到 done 帧，前端会一直停在「思考中」。
      try {
        const db = db$();
        if (!Array.isArray(db?.messages) || !Array.isArray(db?.conversations)) {
          console.error(
            '[agent] db 内存结构异常，已强制从磁盘重载；当前 keys =',
            db ? Object.keys(db).join(',') : String(db),
          );
          load({ force: true });
        }
        const live = db$();

        // 助手消息：写入 parts、清空 streamId（前端据此结束 streaming 态）
        const msg = live.messages.find((m) => m.id === assistantMessage.id);
        if (msg) {
          msg.parts = s.parts;
          msg.streamId = null;
          msg.metadata = {
            usage: {
              inputTokens: Math.max(120, Math.round((userMessage.parts?.[0]?.text ?? '').length / 2.2)),
              outputTokens: Math.max(80, Math.round(s.parts.filter((p) => p.type === 'text').reduce((a, p) => a + p.text.length, 0) / 2.2)),
              contextTokens: 2400 + Math.round(Math.random() * 900),
            },
            durationMs: Date.now() - Date.parse(assistantMessage.createdAt),
            aborted: s.aborted,
            engine: llmEnabled() ? `llm:${LLM.model}` : 'builtin-demo',
          };
        }

        const conv = live.conversations.find((c) => c.id === conversation.id);
        if (conv) {
          conv.streamId = null;
          conv.updatedAt = now();
          conv.lastMessageAt = now();
          const lastText = [...s.parts].reverse().find((p) => p.type === 'text')?.text ?? '';
          conv.lastMessagePreview = lastText.replace(/[#>*`|\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
          conv.lastMessageAttachments = s.parts.filter((p) => p.type === 'tool').length;
        }

        save({ immediate: true });
        hub.finish(run, msg?.metadata ?? { durationMs: 0 });
      } catch (e) {
        console.error('[agent] 落库失败', e);
        hub.finish(run, { durationMs: 0 });
      }
    }
  })();

  return run;
}

// ============================ 内置演示智能体 ============================

async function demoAgent(ctx) {
  const { run, s, conversation, userMessage, workspace } = ctx;
  const question = (userMessage.parts?.find((p) => p.type === 'text')?.text ?? '').trim();
  const files = toolGlob(conversation.id, { pattern: '**/*' });

  await sleep(220);
  await streamText(
    run,
    s,
    pickReasoning(question, files),
    { into: 'reasoning', chunk: 16, delay: 12 },
  );

  // 1) 先摸清工作区
  await toolPart(run, s, {
    toolUseId: 'call_' + uuid().slice(0, 8),
    toolName: 'Glob',
    input: { pattern: '**/*', description: '扫描工作区文件' },
    run: async () => (files.length ? files.join('\n') : '(工作区为空)'),
  });

  // 2) 关键词检索（真实 grep）
  const keywords = extractKeywords(question);
  if (keywords.length) {
    await toolPart(run, s, {
      toolUseId: 'call_' + uuid().slice(0, 8),
      toolName: 'Grep',
      input: { pattern: keywords.join('|'), description: '在工作区中检索关键词' },
      run: async () => {
        const hits = toolGrep(conversation.id, { pattern: keywords.join('|') });
        return hits.length
          ? hits.slice(0, 12).map((h) => `${h.path}:${h.line}: ${h.text.trim()}`).join('\n')
          : '(无命中)';
      },
    });
  }

  // 3) 读关键文件（真实读盘）
  const target = files.find((f) => /\.(csv|md)$/i.test(f)) ?? files[0];
  if (target) {
    await toolPart(run, s, {
      toolUseId: 'call_' + uuid().slice(0, 8),
      toolName: 'Read',
      input: { file_path: target, description: '读取数据文件' },
      run: async () => {
        const buf = readText(conversation.id, target);
        return buf.toString('utf8').split('\n').slice(0, 40).join('\n');
      },
    });
  }

  // 4) 需要执行命令时，走一次真实权限审批
  const wantsRun = /脚本|执行|运行|统计|compute|run|script|分析/.test(question);
  if (wantsRun) {
    const cmd = 'python scripts/humidity_expose.py --rh 85 --temp 85 --hours 0,24,96,240';
    const decision = await requestPermission(run, 'Bash', { command: cmd, description: '执行实验编排脚本' });
    if (decision.behavior === 'allow') {
      await toolPart(run, s, {
        toolUseId: 'call_' + uuid().slice(0, 8),
        toolName: 'Bash',
        input: { command: cmd, description: '执行实验编排脚本' },
        run: async () => (await toolBash(conversation.id, { command: cmd }, run.signal)).output,
      });
      // 真实落一个产出文件
      const outName = 'data/processed/exposure_plan.csv';
      const content =
        'rh,temp_c,hours,state\n' +
        [0, 24, 96, 240].map((h) => `85,85,${h},pending`).join('\n') +
        '\n';
      await toolPart(run, s, {
        toolUseId: 'call_' + uuid().slice(0, 8),
        toolName: 'Write',
        input: { file_path: outName, description: '写入暴露计划' },
        run: async () => {
          const { writeText } = await import('./workspace.mjs');
          writeText(conversation.id, outName, content);
          touchFileRecord(conversation.id, outName);
          return `已写入 ${outName}（${content.split('\n').length - 1} 行）`;
        },
      });
    } else {
      await streamText(run, s, `\n（已跳过命令执行：${decision.behavior === 'timeout' ? '审批超时' : '用户拒绝'}）\n`);
    }
  }

  // 5) 子智能体编排演示
  //    演示引擎要让「子智能体编排」这一核心能力可被稳定观察到，触发条件覆盖两类意图：
  //      a) 研究 / 资料类   —— 检索、文献、调研、综述、review、search…
  //      b) 多步分析类      —— 统计、分析、生成、整理、汇总、对比、规划、拆解…
  //    另外，只要能从提问里抽出 ≥3 个关键词，就说明这是个有实质内容的任务，同样走编排。
  const ORCHESTRATION_RX =
    /检索|文献|资料|调研|综述|review|search|统计|分析|生成|整理|汇总|对比|规划|计划|编排|多步|拆解/i;
  const wantsOrchestration = ORCHESTRATION_RX.test(question) || keywords.length >= 3;
  if (wantsOrchestration) {
    const parent = {
      type: 'tool',
      toolUseId: 'call_' + uuid().slice(0, 8),
      toolName: 'Task',
      input: { description: '并行检索外部资料', prompt: question },
      state: 'input-available',
      agents: [
        { agentId: 'sa_1', label: '文献检索', prompt: '检索与本问题相关的公开文献', state: 'running', parts: [], summary: '正在检索…' },
        { agentId: 'sa_2', label: '数据核对', prompt: '核对工作区数据与结论一致性', state: 'running', parts: [], summary: '正在核对…' },
      ],
    };
    const parentIdx = s.parts.length;
    s.parts.push(parent);
    hub.part(run, parentIdx, { ...parent });

    for (const [i, sub] of parent.agents.entries()) {
      for (let k = 0; k < 2; k++) {
        const step = {
          type: 'tool',
          toolUseId: `${sub.agentId}_step_${k}`,
          toolName: k === 0 ? 'WebSearch' : 'WebFetch',
          input:
            k === 0
              ? { query: keywords[0] ?? question.slice(0, 40) }
              : { url: `https://example.org/${sub.agentId}` },
          state: 'output-available',
          output: k === 0 ? '命中 5 条公开结果' : '正文已抓取（摘要见下）',
          durationMs: 300 + k * 120,
        };
        sub.parts.push(step);
        hub.trackPart(run, parentIdx, 0, step, sub.agentId);
        await sleep(240);
      }
      sub.state = 'completed';
      sub.durationMs = 900 + i * 320;
      sub.summary = '已完成';
      sub.parts.forEach((p, k) => hub.trackPart(run, parentIdx, k, p, sub.agentId));
      await sleep(200);
    }
    parent.state = 'output-available';
    parent.output = parent.agents.map((a) => `${a.label}: ${a.summary}`).join('\n');
    parent.durationMs = 1420;
    s.parts[parentIdx] = parent;
    hub.part(run, parentIdx, parent);
    await sleep(120);
  }

  // 6) 组织答案
  const answer = buildAnswer({ question, files, conversation, workspace, ranScript: wantsRun });
  await streamText(run, s, answer, { chunk: 26, delay: 12 });

  // 7) 首轮对话自动生成标题
  //    前端在新建会话时送来的是 text.slice(0,50) 的**占位标题**，服务端在首轮结束后
  //    产出正式标题并下发 title-updated 覆盖它（首轮之后不再改，尊重用户手动改名）。
  const dbr = db$();
  const conv = dbr.conversations.find((c) => c.id === conversation.id);
  if (conv) {
    const userTurns = dbr.messages.filter(
      (m) => m.conversationId === conversation.id && m.role === 'user',
    ).length;
    if (isDefaultTitle(conv.title) || userTurns <= 1) {
      const title = makeTitle(question);
      if (title && title !== conv.title) {
        conv.title = title;
        hub.titleUpdated(run, title);
      }
    }
  }
}

function isDefaultTitle(t) {
  return !t || t === '未命名任务' || t === '新对话' || t.trim() === '';
}

function makeTitle(q) {
  const clean = q.replace(/\s+/g, ' ').trim();
  if (!clean) return '未命名任务';
  return clean.length > 24 ? clean.slice(0, 24) + '…' : clean;
}

function extractKeywords(q) {
  const zh = q.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  const en = q.match(/[A-Za-z][A-Za-z0-9_\-\.]{3,}/g) ?? [];
  return [...new Set([...zh, ...en])].slice(0, 6);
}

function pickReasoning(q, files) {
  if (!files.length) return '工作区是空的，先建立最小可复现结构再回答。';
  return `先看工作区现状（${files.length} 个文件），再决定是直接回答还是先补数据。\n关键是别凭印象下判断，先用真实文件内容对齐事实。`;
}

function buildAnswer({ question, files, conversation, ranScript }) {
  const csvs = files.filter((f) => f.endsWith('.csv'));
  const scripts = files.filter((f) => f.endsWith('.py'));
  return [
    '## 结论',
    '',
    `针对「${question.slice(0, 60) || '你的问题'}」，我在当前工作区里做了实测核查：`,
    '',
    `- 工作区共 **${files.length}** 个文件，其中数据文件 ${csvs.length} 个、脚本 ${scripts.length} 个。`,
    `- 数据文件：${csvs.slice(0, 5).map((f) => `\`${f}\``).join('、') || '（无）'}`,
    `- 脚本：${scripts.slice(0, 5).map((f) => `\`${f}\``).join('、') || '（无）'}`,
    '',
    '### 我实际做了什么',
    '',
    '| 步骤 | 工具 | 结果 |',
    '| --- | --- | --- |',
    '| 扫描工作区 | `Glob` | 列出全部文件 |',
    '| 关键词检索 | `Grep` | 命中相关行 |',
    '| 读取数据 | `Read` | 确认字段与量级 |',
    ranScript ? '| 执行脚本 | `Bash`（已获授权） | 生成 `data/processed/exposure_plan.csv` |' : '| 执行脚本 | — | 本次无需执行 |',
    '',
    '### 复现步骤',
    '',
    '```bash',
    '# 在会话工作区目录下直接运行',
    'python scripts/humidity_expose.py --rh 85 --temp 85 --hours 0,24,96,240',
    'python scripts/xrd_scan.py --dir data/raw --out data/processed/xrd_summary.csv',
    '```',
    '',
    '> 本次回答由内置演示智能体产出（未配置外部模型）。',
    '> 配置 `CLAWSGO_LLM_BASE_URL` / `CLAWSGO_LLM_API_KEY` / `CLAWSGO_LLM_MODEL` 后，',
    '> 同一套工具会被真实模型驱动，帧协议与 parts 结构完全一致。',
    '',
    '需要我把结论整理成可直接投稿的图表吗？',
  ].join('\n');
}

// ============================ LLM 驱动 ============================

const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: '读取工作区中的文本文件',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: '写入文件（覆盖）',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: '按 glob 模式列文件',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: '在工作区中正则检索',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: '执行 shell 命令（需要用户授权）',
      parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: '联网检索',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: '抓取网页正文',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  // ---- MCP 自家四件（新版 bundle toolMeta-CTpTBZ9v.js 注册表，2026-10-10 判明）----
  {
    type: 'function',
    function: {
      name: 'mcp__clawsgo__web_search',
      description: 'ClawsGO 联网检索（与 WebSearch 同义，线上 MCP 命名）',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__clawsgo__generate_image',
      description: '生成图像（描述生图，本地复刻调 images 域占位渲染）',
      parameters: { type: 'object', properties: { description: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['auto', '1:1', '16:9', '9:16'] } }, required: ['description'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__clawsgo__deliver_files',
      description: '把工作区文件登记为交付物（写入 delivery 清单，前端交付面板消费）',
      parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: '工作区相对路径列表' }, note: { type: 'string' } }, required: ['files'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__clawsgo__computer',
      description: '计算机操控（线上 24 动作）。本地复刻为回显执行器：记录动作序列并返回确认',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['left_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'middle_click', 'right_click', 'double_click', 'triple_click', 'mouse_move', 'cursor_position', 'scroll', 'zoom', 'screenshot', 'key', 'hold_key', 'type', 'wait'] },
          coordinate: { type: 'array', items: { type: 'number' } },
          text: { type: 'string' },
          key: { type: 'string' },
          ms: { type: 'number' },
        },
        required: ['action'],
      },
    },
  },
];

const SYSTEM_PROMPT =
  '你是 ClawsGO Science 的长时程科研智能体。工作区是一台隔离沙箱，你只能用给定工具操作它。' +
  '先用工具核对事实，再给出结构化结论：结论 → 证据 → 复现步骤。中文回答，Markdown 排版。';

async function llmAgent(ctx) {
  const { run, s, conversation, userMessage } = ctx;
  const question = userMessage.parts?.find((p) => p.type === 'text')?.text ?? '';
  const history = db$()
    .messages.filter((m) => m.conversationId === conversation.id)
    .slice(-20)
    .map((m) => ({
      role: m.role,
      content: (m.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
    }))
    .filter((m) => m.content);

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];

  let rounds = 0;
  while (rounds++ < 8 && !s.aborted) {
    const res = await fetch(`${LLM.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM.apiKey}`,
      },
      body: JSON.stringify({
        model: LLM.model,
        stream: true,
        messages,
        tools: TOOL_SCHEMA,
        tool_choice: 'auto',
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`LLM 调用失败：${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    const calls = [];
    let textIdx = -1;
    let reasonIdx = -1;

    const ensurePart = async (kind) => {
      if (kind === 'text') {
        if (textIdx < 0) {
          textIdx = s.parts.length;
          s.parts.push({ type: 'text', text: '' });
          hub.part(run, textIdx, s.parts[textIdx]);
        }
        return textIdx;
      }
      if (reasonIdx < 0) {
        reasonIdx = s.parts.length;
        s.parts.push({ type: 'reasoning', text: '' });
        hub.part(run, reasonIdx, s.parts[reasonIdx]);
      }
      return reasonIdx;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          const i = await ensurePart('reasoning');
          s.parts[i].text += delta.reasoning_content;
          hub.delta(run, i, delta.reasoning_content);
        }
        if (typeof delta.content === 'string' && delta.content) {
          const i = await ensurePart('text');
          content += delta.content;
          s.parts[i].text += delta.content;
          hub.delta(run, i, delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: tc.id ?? `call_${uuid().slice(0, 8)}`, name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    }

    const realCalls = calls.filter(Boolean);
    if (!realCalls.length) break;

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: realCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });

    for (const c of realCalls) {
      let input = {};
      try {
        input = JSON.parse(c.args || '{}');
      } catch { /* keep {} */ }
      const exec = () => executeTool(conversation.id, c.name, input, run.signal);
      if (c.name === 'Bash') {
        const decision = await requestPermission(run, 'Bash', input);
        if (decision.behavior !== 'allow') {
          await toolPart(run, s, {
            toolUseId: c.id,
            toolName: 'Bash',
            input,
            state: 'output-error',
            run: async () => {
              throw new Error(decision.behavior === 'timeout' ? 'Permission request timed out' : 'User rejected');
            },
          });
          messages.push({ role: 'tool', tool_call_id: c.id, content: 'Permission denied by user.' });
          continue;
        }
      }
      const part = await toolPart(run, s, { toolUseId: c.id, toolName: c.name, input, run: exec });
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: String(part.output ?? part.errorText ?? '').slice(0, 8000),
      });
    }
  }
}

async function executeTool(conversationId, name, input, signal) {
  // 纠偏（verify-04-negative-v3）：signal 必须是调用所属原 run 的（调用处闭包传入），
  // 不得从 hub.run(conversationId) 反查后继 run 的 signal。
  const originalSignal = signal;
  switch (name) {
    case 'Read':
      return readText(conversationId, input.file_path).toString('utf8').split('\n').slice(0, 400).join('\n');
    case 'Write': {
      const { writeText } = await import('./workspace.mjs');
      writeText(conversationId, input.file_path, input.content ?? '');
      touchFileRecord(conversationId, input.file_path);
      return `已写入 ${input.file_path}`;
    }
    case 'Glob':
      return toolGlob(conversationId, { pattern: input.pattern ?? '**/*', path: input.path ?? '' }).join('\n') || '(空)';
    case 'Grep': {
      const hits = toolGrep(conversationId, { pattern: input.pattern, path: input.path ?? '' });
      return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') || '(无命中)';
    }
    case 'Bash': {
      // 纠偏（verify-04-negative-v3）：必须用调用所属原 run 的 signal，
      // 不能从 hub.run(conversationId) 反查（会拿到后继 run 的 signal）。
      // executeTool 增加第三参 originalSignal，由调用处（runAgentRun 闭包内）显式传入。
      return (await toolBash(conversationId, input, signal ?? null)).output;
    }
    case 'WebSearch':
      return JSON.stringify(await toolWebSearch({ query: input.query }), null, 2);
    case 'WebFetch':
      return JSON.stringify(await toolWebFetch({ url: input.url }), null, 2);
    case 'mcp__clawsgo__web_search':
      return JSON.stringify(await toolWebSearch({ query: input.query }), null, 2);
    case 'mcp__clawsgo__generate_image': {
      const seed = (input.description ?? '').length + (input.aspect_ratio ?? 'auto').length;
      const w = input.aspect_ratio === '9:16' ? 512 : input.aspect_ratio === '16:9' ? 1024 : 768;
      const h = input.aspect_ratio === '9:16' ? 1024 : input.aspect_ratio === '16:9' ? 512 : 768;
      const out = `delivery/gen-${Date.now().toString(36)}.svg`;
      const { writeText } = await import('./workspace.mjs');
      const hue = seed * 47 % 360;
      writeText(conversationId, out, `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue},45%,18%)"/><text x="50%" y="50%" fill="hsl(${hue},80%,80%)" font-family="sans-serif" font-size="28" text-anchor="middle">${(input.description ?? '').slice(0, 60).replace(/[<>&]/g, ' ')}</text></svg>`);
      return JSON.stringify({ generated: true, path: out, size: { w, h }, note: '本地复刻为占位 SVG；接真实生图时替换为 images.mjs 调用' });
    }
    case 'mcp__clawsgo__deliver_files': {
      const files = Array.isArray(input.files) ? input.files : [];
      const results = [];
      const { writeText } = await import('./workspace.mjs');
      for (const f of files) {
        const abs = workspaceDir(conversationId);
        const safe = String(f).replace(/\.\./g, '');
        results.push({ file: safe, ok: true });
      }
      writeText(conversationId, 'delivery/MANIFEST.md',
        `# 交付清单\n\n生成时间：${new Date().toISOString()}\n\n${files.map((f) => `- \`${String(f)}\``).join('\n')}\n${input.note ? `\n> ${input.note}\n` : ''}`);
      return JSON.stringify({ delivered: results.length, files: results, manifest: 'delivery/MANIFEST.md' });
    }
    case 'mcp__clawsgo__computer': {
      // 线上是 24 动作 computer-use；本地复刻记录动作轨迹（不接真桌面），保持工具卡渲染同形
      const a = input.action ?? 'unknown';
      const detail = input.coordinate ? `@${input.coordinate.join(',')}` : input.text ? `"${String(input.text).slice(0, 40)}"` : input.key ? `[${input.key}]` : '';
      return JSON.stringify({ action: a, detail, acknowledged: true, note: '本地复刻为回显执行器' });
    }
    default:
      return `未实现的工具：${name}`;
  }
}

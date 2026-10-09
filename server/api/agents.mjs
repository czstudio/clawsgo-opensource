// /api/agents —— 子智能体（subagent）与 MCP 服务器配置。
//
// 两块都是线上新版才有的能力，契约来自 ChatProjectDialog-BFiN_W03.js：
//
//   子智能体
//     var p_ = e => ['subagents', e.scope, e.hostId ?? e.projectId]
//     getSubagents({scope, hostId|projectId})  → .then(e => e.subagents)
//     createSubagent({...e, fields})            fields: {name, description, prompt, skills, model?}
//     updateSubagent({...e, ...t})
//     deleteSubagent({...e, filename})
//     校验：y_ = {name:64, description:1000, prompt:50000, skills:50}
//           x_ = e => 非空 && 不以 '-' 开头 && 不含 ':' && 长度<=64 && 不含 \r\n/\
//     → 子智能体是**以文件名为键**的 Markdown（带 frontmatter），删改都按 filename。
//
//   MCP 服务器
//     getMcpServers({scope, hostId|projectId}) → .then(e => e.mcpServers)
//     upsertMcpServer({...e, ...t})             幂等写入
//     removeMcpServer({...e, name})
//     probeMcpServer({...e, config})            → .then(e => e.result)
//     传输类型：['stdio','http','sse']；stdio 用 command+args+env，http/sse 用 url+headers
//     名字校验：/^[A-Za-z0-9_-]{1,64}$/
//
// 存储口径：scope + (hostId|projectId) 是作用域键，同一作用域下名字唯一。
import { db$, uuid, now, save } from '../lib/db.mjs';
import { req, need, notFound, badRequest, conflict } from '../lib/errors.mjs';

const NAME_MAX = 64;
const DESC_MAX = 1000;
const PROMPT_MAX = 50000;
const SKILLS_MAX = 50;
const MCP_NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_TRANSPORTS = ['stdio', 'http', 'sse'];

/* ------------------------------------------------------------------ */
/* 作用域                                                              */
/* ------------------------------------------------------------------ */

/**
 * 前端的查询键是 [scope, hostId ?? projectId]，也就是说 hostId 与 projectId 二选一。
 * 这里把作用域规范化成 {scope, hostId, projectId}，两侧比较用同一个函数。
 */
function scopeOf(p) {
  const scope = p?.scope ?? 'project';
  const hostId = p?.hostId ?? null;
  const projectId = p?.projectId ?? null;
  if (!hostId && !projectId) throw badRequest('缺少作用域：需要 hostId 或 projectId');
  return { scope, hostId, projectId };
}

function inScope(row, s) {
  return row.scope === s.scope && row.hostId === s.hostId && row.projectId === s.projectId;
}

function assertWritable(p, ctx) {
  // 项目作用域要属于自己团队；主机作用域要属于自己团队。管理员放行。
  if (ctx.user.role === 'super_admin') return;
  const db = db$();
  if (p?.projectId) {
    const pr = db.projects.find((x) => x.id === p.projectId);
    if (!pr) notFound('项目');
    need(pr.teamId === ctx.teamId || pr.userId === ctx.user.id, 'FORBIDDEN', '无权访问该项目', 403);
  }
  if (p?.hostId) {
    const h = db.hosts.find((x) => x.id === p.hostId);
    if (!h) notFound('主机');
    need(h.teamId === ctx.teamId || h.userId === ctx.user.id, 'FORBIDDEN', '无权访问该主机', 403);
  }
}

/* ------------------------------------------------------------------ */
/* 子智能体                                                            */
/* ------------------------------------------------------------------ */

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('-') &&
    !name.normalize('NFKC').includes(':') &&
    name.length <= NAME_MAX &&
    !/[\r\n/\\]/.test(name)
  );
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function subagentShape(row) {
  return {
    id: row.id,
    scope: row.scope,
    hostId: row.hostId ?? null,
    projectId: row.projectId ?? null,
    filename: row.filename,
    name: row.name,
    description: row.description ?? '',
    prompt: row.prompt ?? '',
    skills: row.skills ?? [],
    model: row.model ?? null,
    // 前端在编辑器里直接展示这份 Markdown
    content: row.content ?? serialize(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

/** 子智能体落盘形态：YAML frontmatter + 正文 prompt */
function serialize(row) {
  const skills = (row.skills ?? []).slice(0, SKILLS_MAX);
  const head = [
    '---',
    `name: ${row.name}`,
    `description: ${row.description ?? ''}`,
    ...(row.model ? [`model: ${row.model}`] : []),
    ...(skills.length ? [`skills: ${skills.join(', ')}`] : []),
    '---',
    '',
  ].join('\n');
  return `${head}${row.prompt ?? ''}\n`;
}

async function getSubagents(p, ctx) {
  const s = scopeOf(p);
  const rows = db$().subagents.filter((r) => inScope(r, s));
  return { subagents: rows.map(subagentShape), total: rows.length };
}

async function createSubagent(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const f = p?.fields ?? {};
  const name = String(f.name ?? '').trim();
  need(validName(name), 'BAD_REQUEST', '子智能体名称不合法');
  const description = String(f.description ?? '').slice(0, DESC_MAX);
  const prompt = String(f.prompt ?? '').slice(0, PROMPT_MAX);
  const skills = Array.isArray(f.skills) ? f.skills.slice(0, SKILLS_MAX).map(String) : [];

  const db = db$();
  const filename = `${slugify(name) || 'subagent'}.md`;
  if (db.subagents.some((r) => inScope(r, s) && r.filename === filename)) {
    throw conflict('同名子智能体已存在');
  }
  const row = {
    id: uuid(),
    ...s,
    filename,
    name,
    description,
    prompt,
    skills,
    model: f.model ?? null,
    userId: ctx.user.id,
    createdAt: now(),
    updatedAt: now(),
  };
  row.content = serialize(row);
  db.subagents.push(row);
  save();
  return { subagent: subagentShape(row), subagents: db.subagents.filter((r) => inScope(r, s)).map(subagentShape) };
}

async function updateSubagent(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const db = db$();
  const filename = req(p, 'filename');
  const row = db.subagents.find((r) => inScope(r, s) && r.filename === filename);
  if (!row) notFound('子智能体');

  if (p?.name !== undefined) {
    need(validName(String(p.name)), 'BAD_REQUEST', '子智能体名称不合法');
    row.name = String(p.name).trim();
  }
  if (p?.description !== undefined) row.description = String(p.description).slice(0, DESC_MAX);
  if (p?.prompt !== undefined) row.prompt = String(p.prompt).slice(0, PROMPT_MAX);
  if (p?.skills !== undefined) row.skills = (Array.isArray(p.skills) ? p.skills : []).slice(0, SKILLS_MAX).map(String);
  if (p?.model !== undefined) row.model = p.model ?? null;
  if (p?.content !== undefined) row.content = String(p.content);
  else row.content = serialize(row);
  row.updatedAt = now();
  save();
  return { subagent: subagentShape(row) };
}

async function deleteSubagent(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const db = db$();
  const filename = req(p, 'filename');
  const before = db.subagents.length;
  db.subagents = db.subagents.filter((r) => !(inScope(r, s) && r.filename === filename));
  if (db.subagents.length === before) notFound('子智能体');
  save();
  return { ok: true, filename };
}

/* ------------------------------------------------------------------ */
/* MCP 服务器                                                          */
/* ------------------------------------------------------------------ */

function mcpShape(row) {
  return {
    id: row.id,
    scope: row.scope,
    hostId: row.hostId ?? null,
    projectId: row.projectId ?? null,
    name: row.name,
    transport: row.transport ?? 'stdio',
    type: row.transport ?? 'stdio',
    command: row.command ?? null,
    args: row.args ?? [],
    url: row.url ?? null,
    env: row.env ?? {},
    headers: row.headers ?? {},
    enabled: row.enabled !== false,
    status: row.status ?? 'unknown',
    lastProbeAt: row.lastProbeAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

function normalizeConfig(cfg = {}) {
  const transport = MCP_TRANSPORTS.includes(cfg.transport ?? cfg.type) ? cfg.transport ?? cfg.type : 'stdio';
  const env = {};
  const headers = {};
  for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = String(v);
  for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = String(v);
  return {
    transport,
    command: cfg.command ? String(cfg.command) : null,
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    url: cfg.url ? String(cfg.url) : null,
    env,
    headers,
    enabled: cfg.enabled !== false,
  };
}

async function getMcpServers(p, ctx) {
  const s = scopeOf(p);
  const rows = db$().mcpServers.filter((r) => inScope(r, s));
  return { mcpServers: rows.map(mcpShape), total: rows.length };
}

async function upsertMcpServer(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const name = String(p?.name ?? '').trim();
  need(MCP_NAME_RX.test(name), 'BAD_REQUEST', 'MCP 名称需匹配 /^[A-Za-z0-9_-]{1,64}$/');

  const db = db$();
  let row = db.mcpServers.find((r) => inScope(r, s) && r.name === name);
  const cfg = normalizeConfig(p?.config ?? p);
  if (row) {
    Object.assign(row, cfg, { updatedAt: now() });
  } else {
    row = {
      id: uuid(),
      ...s,
      name,
      ...cfg,
      status: 'unknown',
      userId: ctx.user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    db.mcpServers.push(row);
  }
  save();
  return { mcpServer: mcpShape(row), mcpServers: db.mcpServers.filter((r) => inScope(r, s)).map(mcpShape) };
}

async function removeMcpServer(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const db = db$();
  const name = req(p, 'name');
  const before = db.mcpServers.length;
  db.mcpServers = db.mcpServers.filter((r) => !(inScope(r, s) && r.name === name));
  if (db.mcpServers.length === before) notFound('MCP 服务器');
  save();
  return { ok: true, name };
}

/**
 * 探活。http/sse 真的发一次 HTTP 请求（走 fetch，失败即 offline）；
 * stdio 检查 command 是否有值并尝试 `which` 不到的降级提示。
 * 返回 { result } —— 前端 `.then(e => e.result)`。
 */
async function probeMcpServer(p, ctx) {
  const s = scopeOf(p);
  assertWritable(p, ctx);
  const cfg = normalizeConfig(p?.config ?? p ?? {});
  const started = Date.now();

  if (cfg.transport === 'stdio') {
    const ok = !!cfg.command;
    return {
      result: {
        ok,
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args,
        latencyMs: Date.now() - started,
        tools: [],
        error: ok ? null : '缺少 command',
        message: ok
          ? '本地复刻不启动子进程；命令已记录，可在终端里自行运行验证'
          : 'stdio 传输必须提供 command',
      },
    };
  }

  if (!cfg.url) {
    return { result: { ok: false, transport: cfg.transport, latencyMs: 0, tools: [], error: '缺少 url' } };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(cfg.url, {
      method: 'GET',
      headers: { ...(cfg.headers ?? {}) },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    return {
      result: {
        ok: resp.ok,
        transport: cfg.transport,
        url: cfg.url,
        status: resp.status,
        latencyMs: Date.now() - started,
        tools: [],
        error: resp.ok ? null : `HTTP ${resp.status}`,
      },
    };
  } catch (e) {
    return {
      result: {
        ok: false,
        transport: cfg.transport,
        url: cfg.url,
        latencyMs: Date.now() - started,
        tools: [],
        error: String(e?.message ?? e),
      },
    };
  }
}

export const commands = {
  getSubagents,
  createSubagent,
  updateSubagent,
  deleteSubagent,
  getMcpServers,
  upsertMcpServer,
  removeMcpServer,
  probeMcpServer,
};

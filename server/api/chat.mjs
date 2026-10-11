// /api/chat —— 对话、消息、工作区条目、终端、搜索、分享、归档。
//
// 契约来源：app/assets/useSendTurns-bTlrxw4M.js、ChatMessages-*.js、
//           chat-C8Un6iHY.js（新会话欢迎页）、_shell-CSlH67JO.js（列表分页）。
//
// 关键还原点：
//  · getConversations 走分页工厂 V()：客户端传 limit = pageSize+1，用 offset 翻页，
//    取响应里的 `conversations` 数组（扁平数组，不需要 total）。
//  · getMessages **倒序**返回（第 0 页是最新消息），offset 以累计条数递增。
//  · sendMessage 在会话不存在时由后端按 ensure 参数建档（新会话欢迎页 URL
//    /chat 本身不建会话，客户端已用 crypto.randomUUID() 预生成 conversationId）。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save, rid, insert } from '../lib/db.mjs';
import { conversation, message, project, announcement } from '../lib/shapes.mjs';
import { startAgentRun, abortRun, answerPermission } from '../lib/agent.mjs';
import {
  ensureWorkspace,
  fileIndex,
  listDir,
  readText,
  writeText,
  removeEntry,
  copyEntry,
  renameEntry,
  gitStatus,
  gitDiff,
  entryType,
  isTextFile,
} from '../lib/workspace.mjs';
import { hub } from '../lib/sse.mjs';
import { createFileLinkRecord, officeSessionFor, officeKindOf } from '../lib/office.mjs';
import { need, notFound, conflict, req, ApiError } from '../lib/errors.mjs';

const DEFAULT_MODEL = 'clawsgo-1.0-lithium';
const DEFAULT_TITLE = '未命名任务';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 会话必须属于请求者的团队 */
function ownConversation(conversationId, ctx) {
  const c = db$().conversations.find((x) => x.id === conversationId);
  if (!c) notFound('会话');
  if (c.teamId !== ctx.teamId && ctx.user.role !== 'super_admin') {
    throw new ApiError('FORBIDDEN', '无权访问该会话', 403);
  }
  return c;
}

function nextSeq(conversationId) {
  const rows = db$().messages.filter((m) => m.conversationId === conversationId);
  return rows.reduce((a, m) => Math.max(a, m.seq ?? 0), 0) + 1;
}

const convTime = (c) => Date.parse(c.lastMessageAt || c.updatedAt || c.createdAt || 0) || 0;

function sortsConversations(list) {
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt ? 1 : 0;
    const pb = b.pinnedAt ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (pa && pb) return Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt);
    return convTime(b) - convTime(a);
  });
}

/** 用户消息 parts：文本 + 上传文件（file part 至少带 path） */
function userParts({ text, files }) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const f of files ?? []) {
    parts.push({
      type: 'file',
      path: f.path,
      name: f.name ?? f.title ?? String(f.path ?? '').split('/').pop(),
      title: f.title ?? f.name ?? String(f.path ?? '').split('/').pop(),
      fileName: f.fileName ?? f.name ?? String(f.path ?? '').split('/').pop(),
      mimeType: f.mimeType ?? null,
      size: f.size ?? null,
      ...(f.hash ? { hash: f.hash } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
    });
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* 会话列表 / 消息                                                     */
/* ------------------------------------------------------------------ */

async function getConversations(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  let rows = db$().conversations.filter((c) => c.teamId === teamId);
  // 默认不返回已归档的（归档走 getArchivedItems）
  if (!p?.includeArchived) rows = rows.filter((c) => !c.archivedAt);
  if (p?.archivedOnly) rows = db$().conversations.filter((c) => c.teamId === teamId && c.archivedAt);
  if (p?.mineOnly) rows = rows.filter((c) => c.userId === ctx.user.id);
  if (p?.projectId) rows = rows.filter((c) => c.projectId === p.projectId);
  if (p?.pinnedOnly) rows = rows.filter((c) => !!c.pinnedAt);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((c) => (c.title ?? '').toLowerCase().includes(q));
  }
  const sorted = sortsConversations(rows);
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 50));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const page = sorted.slice(offset, offset + limit);
  return {
    conversations: page.map(conversation),
    total: sorted.length,
    limit,
    offset,
  };
}

async function getMessages(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const all = db$()
    .messages.filter((m) => m.conversationId === c.id)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // 倒序：第 0 页 = 最新
  const desc = all.reverse();
  const limit = Math.max(1, Math.min(500, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  return {
    messages: desc.slice(offset, offset + limit).map(message),
    total: all.length,
  };
}

async function getConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  return { conversation: conversation(c) };
}

/* ------------------------------------------------------------------ */
/* 发送消息（核心）                                                    */
/* ------------------------------------------------------------------ */

async function sendMessage(p, ctx) {
  const db = db$();
  const conversationId = req(p, 'conversationId');
  const text = String(p?.text ?? '');
  const teamId = p?.teamId || ctx.teamId;

  let conv = db.conversations.find((c) => c.id === conversationId);

  // ---- 新会话建档（欢迎页首次发送）----
  if (!conv) {
    const isCloud = !p?.hostId;
    conv = {
      id: conversationId,
      teamId,
      userId: ctx.user.id,
      projectId: p?.projectId ?? null,
      title: p?.title ?? (text.slice(0, 50) || DEFAULT_TITLE),
      hostId: p?.hostId ?? null,
      workdir: p?.workdir ?? null,
      modelId: p?.modelId ?? DEFAULT_MODEL,
      context: p?.context ?? 'standard',
      effort: p?.effort ?? null,
      mode: p?.mode ?? 'regular',
      permission: p?.permission ?? (isCloud ? 'full' : 'auto'),
      streamId: null,
      createdAt: now(),
      updatedAt: now(),
      lastMessageAt: now(),
      lastMessagePreview: text.replace(/\s+/g, ' ').slice(0, 120),
      lastMessageAttachments: (p?.files ?? []).length,
      pinnedAt: null,
      archivedAt: null,
      sharedAt: null,
      sharedSlug: null,
      compactedAt: null,
      createdAtMs: Date.now(),
    };
    db.conversations.push(conv);
    ensureWorkspace(conv.id);
  } else {
    need(conv.teamId === teamId || ctx.user.role === 'super_admin', 'FORBIDDEN', '无权在该会话发送消息', 403);
    if (p?.title && (!conv.title || conv.title === DEFAULT_TITLE)) conv.title = p.title;
    if (p?.modelId) conv.modelId = p.modelId;
    if (p?.effort != null) conv.effort = p.effort;
    if (p?.mode) conv.mode = p.mode;
    if (p?.context) conv.context = p.context;
    if (p?.projectId && !conv.projectId) conv.projectId = p.projectId;
    if (p?.hostId && !conv.hostId) conv.hostId = p.hostId;
    if (p?.workdir && !conv.workdir) conv.workdir = p.workdir;
  }

  const seq = nextSeq(conv.id);
  const ts = now();

  // ---- 用户消息 ----
  const userMsg = {
    id: p?.messageId ?? uuid(),
    conversationId: conv.id,
    role: 'user',
    seq,
    modelId: p?.modelId ?? conv.modelId,
    context: p?.context ?? conv.context,
    parts: userParts({ text, files: p?.files }),
    streamId: null,
    metadata: null,
    createdAt: ts,
  };

  // ---- 助手占位消息（streamId 非空 → 前端显示为 streaming）----
  const assistantMsg = {
    id: p?.assistantMessageId ?? uuid(),
    conversationId: conv.id,
    role: 'assistant',
    seq: seq + 1,
    modelId: p?.modelId ?? conv.modelId,
    context: p?.context ?? conv.context,
    parts: [],
    streamId: 'stream_' + rid(20),
    metadata: { modelId: p?.modelId ?? conv.modelId, effort: p?.effort ?? null, mode: p?.mode ?? 'regular' },
    createdAt: now(),
  };

  db.messages.push(userMsg, assistantMsg);

  conv.streamId = assistantMsg.streamId;
  conv.updatedAt = now();
  conv.lastMessageAt = now();
  conv.lastMessagePreview = text.replace(/\s+/g, ' ').slice(0, 120);
  conv.lastMessageAttachments = (p?.files ?? []).length;
  conv.messageCount = db.messages.filter((m) => m.conversationId === conv.id).length;
  save();

  // ---- 启动智能体运行（异步推 SSE）----
  await startAgentRun({
    conversation: conv,
    userMessage: userMsg,
    assistantMessage: assistantMsg,
    opts: {
      modelId: p?.modelId ?? conv.modelId,
      effort: p?.effort ?? null,
      mode: p?.mode ?? 'regular',
      context: p?.context ?? 'standard',
      permission: p?.permission ?? null,
      compact: !!p?.compact,
      resume: !!p?.resume,
      llmEnabled: null,
    },
  });

  return {
    userMessage: message(userMsg),
    assistantMessage: message(assistantMsg),
    conversation: conversation(conv),
  };
}

async function stopMessage(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  abortRun(c.id);
  return { ok: true, stopped: true };
}

async function answerPermissionCmd(p, ctx) {
  ownConversation(req(p, 'conversationId'), ctx);
  return answerPermission({
    conversationId: p.conversationId,
    requestId: req(p, 'requestId'),
    behavior: p?.behavior ?? 'deny',
    answers: p?.answers,
  });
}

/* ------------------------------------------------------------------ */
/* 会话维护                                                            */
/* ------------------------------------------------------------------ */

async function updateConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const fields = ['title', 'modelId', 'effort', 'mode', 'context', 'projectId', 'hostId', 'workdir'];
  for (const f of fields) if (p?.[f] !== undefined) c[f] = p[f];
  if (p?.pinned !== undefined) c.pinnedAt = p.pinned ? now() : null;
  c.updatedAt = now();
  save();
  return { conversation: conversation(c) };
}

async function deleteConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  db.conversations = db.conversations.filter((x) => x.id !== c.id);
  db.messages = db.messages.filter((m) => m.conversationId !== c.id);
  db.terminals = (db.terminals ?? []).filter((t) => t.conversationId !== c.id);
  save();
  return { ok: true, id: c.id };
}

async function archiveConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  c.archivedAt = now();
  c.updatedAt = now();
  save();
  return { ok: true };
}

async function unarchiveConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  c.archivedAt = null;
  c.updatedAt = now();
  save();
  return { ok: true };
}

async function getArchivedItems(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const convs = db.conversations
    .filter((c) => c.teamId === teamId && c.archivedAt)
    .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
  const projs = db.projects
    .filter((x) => x.teamId === teamId && x.archivedAt)
    .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
  return {
    items: [
      ...convs.map((c) => ({ kind: 'conversation', id: c.id, title: c.title, archivedAt: c.archivedAt })),
      ...projs.map((x) => ({ kind: 'project', id: x.id, title: x.name, archivedAt: x.archivedAt })),
    ],
    conversations: convs.map(conversation),
    projects: projs.map(project),
    total: convs.length + projs.length,
  };
}

/* ------------------------------------------------------------------ */
/* 分享                                                                */
/* ------------------------------------------------------------------ */

async function shareConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const enabled = p?.shared !== false;
  if (enabled) {
    if (!c.sharedSlug) c.sharedSlug = rid(12);
    c.sharedAt = c.sharedAt ?? now();
    const url = `/share/${c.sharedSlug}`;
    save();
    return { isShared: true, shared: true, slug: c.sharedSlug, url, sharedAt: c.sharedAt };
  }
  c.sharedAt = null;
  save();
  return { isShared: false, shared: false, slug: c.sharedSlug ?? null, url: null };
}

async function getSharedConversation(p) {
  const db = db$();
  const slug = req(p, 'slug', 'NOT_FOUND');
  const c =
    db.conversations.find((x) => x.sharedSlug === slug && x.sharedAt) ??
    db.conversations.find((x) => x.id === slug && x.sharedAt);
  if (!c) notFound('分享');
  return { conversation: conversation(c) };
}

async function getSharedMessages(p) {
  const db = db$();
  const slug = req(p, 'slug', 'NOT_FOUND');
  const c = db.conversations.find((x) => x.sharedSlug === slug || x.id === slug);
  if (!c) notFound('分享');
  const rows = db.messages
    .filter((m) => m.conversationId === c.id)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map(message);
  return { messages: rows, total: rows.length };
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

async function searchAll(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const q = String(p?.query ?? '').trim();
  if (!q) return { conversations: [], messages: [], files: [], projects: [], skills: [], total: 0 };
  const rx = new RegExp(escapeRx(q), 'i');
  const db = db$();

  const conversations_ = db.conversations
    .filter((c) => c.teamId === teamId && !c.archivedAt && (rx.test(c.title ?? '') || rx.test(c.lastMessagePreview ?? '')))
    .slice(0, 20)
    .map((c) => ({ ...conversation(c), kind: 'conversation', excerpt: c.lastMessagePreview ?? '' }));

  const msgs = [];
  for (const c of db.conversations.filter((x) => x.teamId === teamId)) {
    for (const m of db.messages.filter((x) => x.conversationId === c.id)) {
      const text = (m.parts ?? []).map((x) => x.text ?? '').join('\n');
      if (text && rx.test(text)) {
        msgs.push({
          kind: 'message',
          id: m.id,
          conversationId: c.id,
          conversationTitle: c.title,
          role: m.role,
          createdAt: m.createdAt,
          excerpt: excerptOf(text, q),
        });
        if (msgs.length >= 40) break;
      }
    }
  }

  const projects_ = db.projects
    .filter((x) => x.teamId === teamId && !x.archivedAt && rx.test(x.name ?? ''))
    .slice(0, 20)
    .map((x) => ({ ...project(x), kind: 'project' }));

  return {
    conversations: conversations_,
    messages: msgs,
    files: [],
    projects: projects_,
    skills: [],
    total: conversations_.length + projects_.length + msgs.length,
  };
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function excerptOf(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + 160).replace(/\s+/g, ' ').trim() + '…';
}

/* ------------------------------------------------------------------ */
/* 工作区条目（文件树）                                                */
/* ------------------------------------------------------------------ */

async function getConversationFiles(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  return listDir(c.id, p?.path ?? '');
}

async function getConversationFileIndex(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  return fileIndex(c.id, { limit: Number(p?.limit) || 2000 });
}

async function createConversationEntry(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const parentPath = p?.parentPath ?? '';
  const name = req(p, 'name');
  const kind = p?.kind ?? 'file';
  const rel = [parentPath, name].filter(Boolean).join('/');
  if (kind === 'dir') {
    const { workspaceDir } = await import('../lib/workspace.mjs');
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(workspaceDir(c.id), rel), { recursive: true });
    return { exists: true, entry: listDir(c.id, parentPath).entries.find((e) => e.name === name) ?? null };
  }
  writeText(c.id, rel, '');
  return { exists: true, entry: listDir(c.id, parentPath).entries.find((e) => e.name === name) ?? null };
}

async function updateConversationFile(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = req(p, 'path');
  const entry = writeText(c.id, rel, p?.content ?? '');
  return { ok: true, entry, path: rel };
}

async function deleteConversationEntry(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = req(p, 'path');
  const removed = removeEntry(c.id, rel);
  if (!removed) notFound('文件');
  return { ok: true, path: rel };
}

async function moveConversationEntry(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const entry = copyEntry(c.id, req(p, 'path'), p?.destDir ?? '');
  removeEntry(c.id, p.path);
  return { ok: true, entry };
}

async function renameConversationEntry(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const entry = renameEntry(c.id, req(p, 'path'), req(p, 'newName'));
  return { ok: true, entry };
}

async function copyConversationEntry(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const entry = copyEntry(c.id, req(p, 'path'), p?.destDir ?? '');
  return { ok: true, entry };
}

async function openConversationEntryLocally(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = req(p, 'path');
  return {
    ok: true,
    path: rel,
    // 本地复刻没有 Electron 宿主，返回一个可被前端识别的「不可用」结果
    available: false,
    reason: 'local-reproduction: no desktop host process',
    url: `http://localhost:${process.env.PORT_APP || 5181}/api/downloadConversationFile?conversationId=${encodeURIComponent(c.id)}&path=${encodeURIComponent(rel)}`,
  };
}

async function downloadConversationDir(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = p?.path ?? '';
  const { workspaceDir, safeJoin } = await import('../lib/workspace.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const abs = safeJoin(workspaceDir(c.id), rel);
  const files = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const a = path.join(d, n);
      if (fs.statSync(a).isDirectory()) walk(a);
      else files.push({ path: path.relative(workspaceDir(c.id), a).replace(/\\/g, '/'), content: fs.readFileSync(a) });
    }
  };
  if (fs.existsSync(abs)) walk(abs);
  return { __zip: true, dir: rel, files };
}

async function getConversationGitStatus(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  return gitStatus(c.id);
}

async function getConversationGitDiff(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const target = p?.target ?? {};
  const rel = typeof target === 'string' ? target : target.path ?? '';
  return gitDiff(c.id, rel);
}

/* ------------------------------------------------------------------ */
/* 图表 / 费用                                                         */
/* ------------------------------------------------------------------ */

async function listFigures(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const idx = fileIndex(c.id);
  const figures = idx.entries
    .filter((e) => /\.(png|jpe?g|svg|webp|gif|pdf|eps)$/i.test(e.path))
    .map((e) => ({
      id: e.path,
      path: e.path,
      name: e.name,
      title: e.name,
      kind: /\.pdf$/i.test(e.path) ? 'pdf' : 'image',
      size: e.size,
      createdAt: e.mtime,
      updatedAt: e.mtime,
      // 本地复刻直接给出可访问 URL（生产走签名链接）
      url: `/api/downloadConversationFile?conversationId=${encodeURIComponent(c.id)}&path=${encodeURIComponent(e.path)}`,
    }));
  return { figures, items: figures, total: figures.length };
}

async function getConversationCosts(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rows = db$().messages.filter((m) => m.conversationId === c.id);
  let inputTokens = 0;
  let outputTokens = 0;
  let credits = 0;
  const byModel = new Map();
  for (const m of rows) {
    const u = m.metadata?.usage;
    if (!u) continue;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    const modelId = m.modelId ?? 'unknown';
    const cur = byModel.get(modelId) ?? { modelId, inputTokens: 0, outputTokens: 0, runs: 0 };
    cur.inputTokens += u.inputTokens ?? 0;
    cur.outputTokens += u.outputTokens ?? 0;
    cur.runs += 1;
    byModel.set(modelId, cur);
  }
  credits = Math.round((inputTokens * 1.0 + outputTokens * 4.0) / 1000);
  return {
    costs: {
      conversationId: c.id,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      credits,
      runs: rows.filter((m) => m.metadata?.usage).length,
      byModel: [...byModel.values()],
    },
    inputTokens,
    outputTokens,
    credits,
  };
}

/* ------------------------------------------------------------------ */
/* 终端（真实命令执行 + WS 通道）                                      */
/* ------------------------------------------------------------------ */

function terminalShape(t) {
  return {
    id: t.id,
    conversationId: t.conversationId,
    title: t.title,
    cwd: t.cwd ?? '',
    state: t.state ?? 'running',
    cols: t.cols ?? 80,
    rows: t.rows ?? 24,
    createdAt: t.createdAt,
    exitedAt: t.exitedAt ?? null,
    exitCode: t.exitCode ?? null,
  };
}

async function getConversationTerminals(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const terminals = (db$().terminals ?? []).filter((t) => t.conversationId === c.id).map(terminalShape);
  return { terminals, items: terminals, total: terminals.length };
}

async function createConversationTerminal(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  const terminalId = p?.terminalId ?? uuid();
  let t = (db.terminals ?? []).find((x) => x.id === terminalId && x.conversationId === c.id);
  if (!t) {
    t = {
      id: terminalId,
      conversationId: c.id,
      title: p?.title ?? 'bash',
      cwd: c.workdir ?? '',
      state: 'running',
      cols: Number(p?.cols) || 80,
      rows: Number(p?.rows) || 24,
      createdAt: now(),
      buffer: [],
    };
    db.terminals.push(t);
  }
  const ticket = issueTerminalTicket(t.id, ctx.user.id);
  save();
  return { terminal: terminalShape(t), ticket };
}

async function attachConversationTerminal(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const t = (db$().terminals ?? []).find((x) => x.id === p?.terminalId && x.conversationId === c.id);
  if (!t) notFound('终端');
  return { ticket: issueTerminalTicket(t.id, ctx.user.id), terminal: terminalShape(t) };
}

async function closeConversationTerminal(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  const t = (db.terminals ?? []).find((x) => x.id === p?.terminalId && x.conversationId === c.id);
  if (t) {
    t.state = 'exited';
    t.exitedAt = now();
    save();
  }
  return { ok: true };
}

async function createTerminalTicket(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const terminalId = p?.terminalId ?? uuid();
  const db = db$();
  if (!(db.terminals ?? []).some((x) => x.id === terminalId)) {
    (db.terminals ??= []).push({
      id: terminalId,
      conversationId: c.id,
      title: 'bash',
      cwd: c.workdir ?? '',
      state: 'running',
      cols: Number(p?.cols) || 80,
      rows: Number(p?.rows) || 24,
      createdAt: now(),
    });
    save();
  }
  return { ticket: issueTerminalTicket(terminalId, ctx.user.id) };
}

/** terminalId → {userId, expiresAt}；WS 握手用它换句柄 */
export const terminalTickets = new Map();
function issueTerminalTicket(terminalId, userId) {
  const ticket = rid(32);
  terminalTickets.set(ticket, { terminalId, userId, expiresAt: Date.now() + 5 * 60e3 });
  return ticket;
}

/* ------------------------------------------------------------------ */
/* 桌面直连票据 / 浏览器视图 / Office 会话                              */
/* ------------------------------------------------------------------ */

async function createFileDirectTicket(p, ctx) {
  // 本地复刻没有桌面守护进程，返回 127.0.0.1 上的同源文件网关。
  // 前端拿到 direct 后会尝试 http://127.0.0.1:<port>/files/*，失败自动回落云端命令。
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const port = Number(process.env.PORT_APP || 5181);
  return {
    direct: {
      port,
      ticket: rid(28),
      ttlMs: 300000,
      baseUrl: `http://127.0.0.1:${port}`,
      conversationId: c.id,
    },
  };
}

async function createFileLink(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  // 形状由前端决定：ModelIcon-ACnHMn8i.js 里是 `let {link:n} = await o('createFileLink',...)`
  // 然后 `` `${base}${n.url}` ``，所以必须返回 { link: { url } }，少这层前端会拼出 "undefined"。
  return createFileLinkRecord(c.id, req(p, 'path'), { createdBy: ctx.user.id });
}

async function openBrowserView(p, ctx) {
  const url = req(p, 'url', 'BAD_URL');
  return {
    ok: true,
    url,
    // 没有桌面宿主进程，前端会退化为新标签打开
    available: false,
    reason: 'local-reproduction: no desktop host process',
  };
}

async function createOfficeSession(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = req(p, 'path');
  // 形状由 Office 预览组件决定（ChatTeamUsage-CqW9fk-p.js）：
  //   function rh({session:e}){ let {serverUrl:c, config:l} = e; new DocsAPI.DocEditor(id, l) }
  // 即必须是 ONLYOFFICE 的 { serverUrl, config }，而不是自定义的 { id, url, kind }。
  // 注意前两个参数 n = { lang, theme } 会整体透传过来。
  return officeSessionFor(c.id, rel, { ...(p ?? {}), user: ctx.user }, {});
}

function guessOfficeKind(rel) {
  return officeKindOf(rel);
}

async function copyAgentInstructions(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const idx = fileIndex(c.id);
  const agents = idx.entries.filter((e) => /(^|\/)(AGENTS?|CLAUDE|README)\.md$/i.test(e.path));
  const content = agents
    .map((e) => `### ${e.path}\n\n${readText(c.id, e.path).toString('utf8')}`)
    .join('\n\n---\n\n');
  return { content: content || '(会话内没有智能体说明文件)', files: agents.map((e) => e.path), length: content.length };
}

/* ------------------------------------------------------------------ */
/* LaTeX（本地复刻：返回可用的最小实现）                               */
/* ------------------------------------------------------------------ */

async function compileTypst(p, ctx) {
  // 新版前端契约（ChatFilePreview chunk @98683）：.typ 预览时 POST compileTypst
  // {conversationId, path} → {compile:{pdfPath, pdfChanged,...}}，编译产物落工作区
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = String(req(p, 'path', 'file'));
  const ws = ensureWorkspace(c.id);
  const abs = safeJoin(ws, rel);
  if (!abs) throw badRequest('路径越界');
  if (!fs.existsSync(abs)) notFound('Typst 源文件');
  const pdfRel = rel.replace(/\.typ$/i, '.pdf');
  const pdfAbs = safeJoin(ws, pdfRel);
  const had = fs.existsSync(pdfAbs);
  const { execFile } = await import('node:child_process');
  const typst = await new Promise((resolve) => {
    execFile('typst', ['compile', abs, pdfAbs], { timeout: 60_000 }, (err) => resolve(!err));
  });
  if (!typst) {
    // 本地无 typst 引擎：同形降级（生产为真实编译）
    return { compile: { pdfPath: null, pdfChanged: false, ok: false, log: 'local-reproduction: typst 引擎未安装，brew install typst 后可用' } };
  }
  return { compile: { pdfPath: pdfRel, pdfChanged: !had, ok: true } };
}

async function compileLatex(p, ctx) {
  const source = String(p?.source ?? '');
  return {
    ok: true,
    log: 'local-reproduction: LaTeX 引擎未内置，已跳过编译。',
    engine: 'none',
    html: `<pre>${source.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`,
    pdf: null,
    errors: [],
    warnings: [],
  };
}

async function getLatexCompletions(p, ctx) {
  // 常用命令补全表（生产由服务端 LaTeX 索引提供）
  const COMMANDS = [
    'begin', 'end', 'documentclass', 'usepackage', 'section', 'subsection', 'subsubsection',
    'paragraph', 'title', 'author', 'date', 'maketitle', 'textbf', 'textit', 'emph', 'texttt',
    'footnote', 'cite', 'ref', 'label', 'includegraphics', 'caption', 'item', 'frac', 'sqrt',
    'sum', 'int', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'pi',
    'sigma', 'phi', 'omega', 'infty', 'partial', 'nabla', 'rightarrow', 'leftarrow', 'times',
    'cdot', 'leq', 'geq', 'neq', 'approx', 'propto', 'matrix', 'pmatrix', 'bmatrix', 'align',
    'equation', 'figure', 'table', 'tabular', 'center', 'itemize', 'enumerate', 'bibliography',
  ];
  const prefix = String(p?.prefix ?? p?.query ?? '').replace(/^\\+/, '');
  const matches = COMMANDS.filter((c) => c.startsWith(prefix)).map((c) => ({
    label: '\\' + c,
    insertText: '\\' + c,
    kind: 'command',
    detail: 'LaTeX command',
  }));
  return { items: matches, completions: matches, total: matches.length };
}

async function syncTexForward(p, ctx) {
  return { ok: true, file: p?.file ?? null, line: p?.line ?? 0, page: 1, x: 0, y: 0, available: false };
}
async function syncTexInverse(p, ctx) {
  return { ok: true, file: null, line: 0, available: false };
}

/* ------------------------------------------------------------------ */
/* 导出命令表                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Git 面板（线上新版）：快照 / 对比 / 历史 / 文件                      */
/* ------------------------------------------------------------------ */

/**
 * 本地工作区不是真 git 仓库，所以「提交历史」按工作区里**真实文件的修改时间**
 * 推导：每次落盘视作一次变更。这样面板里看到的条数与时间都对应真实文件，
 * 而不是凭空编的假数据。
 */
function workspaceCommits(conversationId) {
  const root = ensureWorkspace(conversationId);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === '.git' || n === '.seeded') continue;
      const abs = path.join(dir, n);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs, depth + 1); continue; }
      out.push({
        path: path.relative(root, abs).replace(/\\/g, '/'),
        mtime: st.mtime.toISOString(),
        size: st.size,
      });
    }
  };
  walk(root, 0);
  return out
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
    .map((f) => ({
      hash: fnv1a(`${f.path}@${f.mtime}`).toString(16).padStart(8, '0').slice(0, 8) + fnv1a(f.path).toString(16).padStart(8, '0').slice(0, 8),
      shortHash: fnv1a(`${f.path}@${f.mtime}`).toString(16).padStart(8, '0').slice(0, 7),
      author: 'ClawsGO',
      email: 'noreply@clawsgo.local',
      date: f.mtime,
      message: `更新 ${f.path}`,
      files: [{ path: f.path, status: 'M' }],
    }));
}

function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function getConversationGitSnapshot(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const st = gitStatus(c.id);
  const changes = st.changes ?? [];
  return {
    ...st,
    conversationId: c.id,
    changes,
    stashes: [],
    // 前端下拉框直接枚举这些 target
    targets: [
      { kind: 'worktree' },
      ...changes.map((x) => ({ kind: 'change', path: x.path, from: x.from ?? null })),
    ],
    generatedAt: now(),
  };
}

async function getConversationGitCompare(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const t = p?.target ?? {};
  const rel = String(t.path ?? '');
  const d = gitDiff(c.id, rel);
  const root = ensureWorkspace(c.id);
  let size = 0;
  try { size = fs.statSync(path.join(root, rel)).size; } catch { size = 0; }
  return {
    ...d,
    conversationId: c.id,
    target: t,
    binary: rel ? !isTextFile(rel) : false,
    tooLarge: size > 512 * 1024,
    size,
  };
}

async function getConversationGitFiles(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const t = p?.target ?? {};
  const st = gitStatus(c.id);
  const changes = st.changes ?? [];
  const files = changes.map((x) => ({
    path: x.path,
    status: x.status ?? 'M',
    from: x.from ?? null,
    additions: 0,
    deletions: 0,
  }));
  return { conversationId: c.id, target: t, files, changes, total: files.length };
}

async function getConversationGitHistory(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const all = workspaceCommits(c.id);
  const scope = p?.scope ?? 'all';
  const skip = Math.max(0, Number(p?.skip ?? 0));
  const take = 20;
  const page = all.slice(skip, skip + take);
  return {
    conversationId: c.id,
    scope,
    commits: page,
    hasMore: skip + page.length < all.length,
    total: all.length,
  };
}

/* ------------------------------------------------------------------ */
/* 已读标记与会话重排（线上新版）                                       */
/* ------------------------------------------------------------------ */

async function markConversationRead(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  c.lastReadAt = now();
  c.unreadCount = 0;
  save();
  hub.conversationRead(c.teamId, c.id);
  return { ok: true, conversationId: c.id, lastReadAt: c.lastReadAt };
}

/** 按 afterId 重排；afterId 为 null 表示排到最前。顺序落在 conversation.orderIndex 上。 */
function reorderWithin(list, id, afterId) {
  const rest = list.filter((x) => x.id !== id);
  const at = afterId === null || afterId === undefined ? 0 : rest.findIndex((x) => x.id === afterId) + 1;
  rest.splice(at < 0 ? rest.length : at, 0, { id });
  const rank = new Map(rest.map((x, i) => [x.id, i]));
  return rank;
}

async function reorderConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  const sibs = db.conversations.filter((x) => x.teamId === c.teamId && !x.archivedAt);
  const rank = reorderWithin(sibs, c.id, p?.afterId ?? null);
  for (const x of sibs) x.orderIndex = rank.get(x.id) ?? 0;
  c.orderIndex = rank.get(c.id) ?? 0;
  save();
  return { ok: true };
}

async function reorderPinnedConversation(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  // 置顶区只对 pinnedAt 非空的会话排序
  const pinned = db.conversations.filter((x) => x.teamId === c.teamId && !x.archivedAt && x.pinnedAt);
  if (!pinned.some((x) => x.id === c.id)) {
    c.pinnedAt = now();
    pinned.push(c);
  }
  const rank = reorderWithin(pinned, c.id, p?.afterId ?? null);
  for (const x of pinned) x.pinOrder = rank.get(x.id) ?? 0;
  save();
  return { ok: true };
}

async function prepareConversationUpload(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const db = db$();
  const rec = {
    id: uuid(),
    conversationId: c.id,
    userId: ctx.user.id,
    size: Number(p?.size ?? 0),
    seat: {
      hostId: p?.hostId ?? null,
      deviceId: p?.deviceId ?? null,
      projectId: p?.projectId ?? null,
    },
    status: 'prepared',
    createdAt: now(),
  };
  (db.uploadIntents ??= []).push(rec);
  save();
  return { ok: true, uploadId: rec.id };
}

export const commands = {
  // 会话
  getConversations,
  getConversation,
  getMessages,
  sendMessage,
  stopMessage,
  answerPermission: answerPermissionCmd,
  updateConversation,
  deleteConversation,
  archiveConversation,
  unarchiveConversation,
  getArchivedItems,
  shareConversation,
  getSharedConversation,
  getSharedMessages,
  getSharedConversationCosts: getConversationCosts,
  getConversationCosts,
  searchAll,
  // 工作区
  getConversationFiles,
  getConversationFileIndex,
  createConversationEntry,
  updateConversationFile,
  deleteConversationEntry,
  moveConversationEntry,
  renameConversationEntry,
  copyConversationEntry,
  openConversationEntryLocally,
  downloadConversationDir,
  getConversationGitStatus,
  getConversationGitDiff,
  getConversationGitSnapshot,
  getConversationGitCompare,
  getConversationGitFiles,
  getConversationGitHistory,
  markConversationRead,
  reorderConversation,
  reorderPinnedConversation,
  prepareConversationUpload,
  listFigures,
  // 终端 / 宿主交互
  getConversationTerminals,
  createConversationTerminal,
  attachConversationTerminal,
  closeConversationTerminal,
  createTerminalTicket,
  createFileDirectTicket,
  createFileLink,
  openBrowserView,
  createOfficeSession,
  copyAgentInstructions,
  // LaTeX
  compileLatex,
  compileTypst,
  getLatexCompletions,
  syncTexForward,
  syncTexInverse,
};

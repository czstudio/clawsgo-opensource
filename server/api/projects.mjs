// /api/projects —— 项目域：项目文件、项目终端、项目 Git。
//
// 这一整块是线上新版才有的能力（旧版只有「会话工作区」）。契约来自新构建 bundle：
//
//   useFiles-CJXQ3VXE.js
//     getHostProjects({hostId, projectId?, kind?, limit?}) → { projects }
//     getProjectFiles({projectId, path})                   → 目录列表
//     getProjectFileIndex({projectId})                     → 索引
//     downloadProjectFile({projectId, path})               → Blob（走通道 ②）
//     downloadProjectDir({projectId, path})                → ZIP Blob
//     createProjectFileLink({projectId, path}) → { link }   前端拼 `${base}${link.url}`，再 &download=1
//     createProjectOfficeSession({projectId, path, ...}) → { session }
//
//   SkillDetailDialog-D-ED20FY.js
//     getProjectTerminals({projectId})                     → { shell, terminals }
//     createProjectTerminal({projectId, terminalId, ...})  → { terminal }
//     attachProjectTerminal({projectId, terminalId, direct}) → { ticket, direct }
//     updateProjectTerminal({projectId, terminalId, ...})  → { terminal }
//     closeProjectTerminal({projectId, terminalId})
//     reorderProjectTerminal({projectId, terminalId, afterId})
//
//   ChatFilePreview-DHu8on2w.js
//     getProjectGitStatus({projectId})                     → Git 状态
//
// 实现上的关键取舍：项目工作区复用 `workspace/<projectId>` 这套真实目录，
// 所以「文件读写 / 打包 / Git」与会话工作区是同一份真实 fs 实现，不是 mock。
// 项目终端也复用会话终端那套票据 + WebSocket：终端行里记 projectId，
// 同时把 conversationId 设成同一个 id，让 WS 那侧的 toolBash 落到同一个目录。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save, rid, paginate } from '../lib/db.mjs';
import { req, need, notFound, badRequest } from '../lib/errors.mjs';
import {
  ensureWorkspace,
  safeJoin,
  listDir,
  fileIndex,
  gitStatus,
  entryType,
  isTextFile,
} from '../lib/workspace.mjs';
import { makeZip } from '../lib/zip.mjs';
import { createFileLinkRecord, officeSessionFor } from '../lib/office.mjs';
import { project as projectShape } from '../lib/shapes.mjs';

/* ------------------------------------------------------------------ */
/* 归属校验                                                            */
/* ------------------------------------------------------------------ */

function ownProject(projectId, ctx) {
  const p = db$().projects.find((x) => x.id === projectId);
  if (!p) notFound('项目');
  need(p.teamId === ctx.teamId || p.userId === ctx.user.id || ctx.user.role === 'super_admin',
    'FORBIDDEN', '无权访问该项目', 403);
  return p;
}

function resolveInProject(projectId, rel) {
  const root = ensureWorkspace(projectId);
  const abs = safeJoin(root, rel ?? '');
  if (!path.resolve(abs).startsWith(path.resolve(root))) throw badRequest('路径越界');
  return { root, abs };
}

function disposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const MIME_BY_EXT = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tex': 'text/x-tex; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/* ------------------------------------------------------------------ */
/* 项目列表                                                            */
/* ------------------------------------------------------------------ */

/**
 * getHostProjects —— 主机上的项目。
 * 线上语义是「主机工作区里跑出来的项目」；本地没有真主机，
 * 所以按 hostId 找到主机 → 取该主机团队下的项目，projectId 命中时只返回那一条。
 */
async function getHostProjects(p, ctx) {
  const db = db$();
  const hostId = p?.hostId ?? null;
  let rows = db.projects.filter((x) => !x.archivedAt);

  if (hostId) {
    const host = db.hosts.find((h) => h.id === hostId);
    if (!host) notFound('主机');
    need(host.teamId === ctx.teamId || ctx.user.role === 'super_admin', 'FORBIDDEN', '无权访问该主机', 403);
    rows = rows.filter((x) => x.hostId === hostId || x.teamId === host.teamId);
  } else {
    rows = rows.filter((x) => x.teamId === ctx.teamId);
  }
  if (p?.projectId) rows = rows.filter((x) => x.id === p.projectId);
  if (p?.kind) rows = rows.filter((x) => (x.kind ?? 'implicit') === p.kind);

  rows = rows.slice().sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  const limit = Number(p?.limit ?? 0);
  const page = limit ? paginate(rows, { limit, offset: p?.offset ?? 0 }) : rows;
  return { projects: page.map((x) => projectShape(x, ctx.user.id)), total: rows.length };
}

/* ------------------------------------------------------------------ */
/* 项目文件                                                            */
/* ------------------------------------------------------------------ */

async function getProjectFiles(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const rel = p?.path ?? '';
  const listing = listDir(pr.id, rel);
  return {
    ...listing,
    projectId: pr.id,
    path: rel,
    workdir: pr.workdir ?? null,
  };
}

async function getProjectFileIndex(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const idx = fileIndex(pr.id, { limit: p?.limit ?? 2000 });
  return { ...idx, projectId: pr.id };
}

async function downloadProjectFile(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const rel = req(p, 'path');
  const { abs } = resolveInProject(pr.id, rel);
  if (!fs.existsSync(abs)) notFound('文件');
  if (entryType(abs) === 'dir') throw badRequest('目标是目录，请使用 downloadProjectDir', 'IS_DIRECTORY');
  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  return {
    __binary: buf,
    contentType: MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    filename: name,
    disposition: disposition(name),
  };
}

async function downloadProjectDir(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const rel = p?.path ?? '';
  const { root, abs } = resolveInProject(pr.id, rel);
  if (!fs.existsSync(abs)) notFound('目录');

  const entries = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      if (n === '.seeded' || n === '.git') continue;
      const a = path.join(dir, n);
      const st = fs.statSync(a);
      if (st.isDirectory()) walk(a);
      else entries.push({ path: path.relative(abs, a).replace(/\\/g, '/'), content: fs.readFileSync(a) });
    }
  };
  walk(abs);

  const baseName = path.basename(abs) || path.basename(root);
  return {
    __binary: makeZip(entries),
    contentType: 'application/zip',
    filename: `${baseName}.zip`,
    disposition: disposition(`${baseName}.zip`),
  };
}

async function createProjectFileLink(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  // 与会话侧同一个坑：前端是 `let {link} = await api(...)`，少这层会拼出 "undefined/..."
  return createFileLinkRecord(pr.id, req(p, 'path'), { createdBy: ctx.user.id });
}

async function createProjectOfficeSession(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  return officeSessionFor(pr.id, req(p, 'path'), { ...(p ?? {}), user: ctx.user }, {});
}

async function getProjectGitStatus(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const st = gitStatus(pr.id);
  return { ...st, projectId: pr.id };
}

/* ------------------------------------------------------------------ */
/* 项目终端                                                            */
/* ------------------------------------------------------------------ */

function terminalShape(t) {
  return {
    id: t.id,
    projectId: t.projectId ?? null,
    conversationId: t.conversationId ?? null,
    name: t.title ?? 'bash',
    title: t.title ?? 'bash',
    shell: t.title ?? 'bash',
    cwd: t.cwd ?? '',
    state: t.state ?? 'running',
    status: t.state ?? 'running',
    cols: t.cols ?? 80,
    rows: t.rows ?? 24,
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt ?? t.updatedAt ?? t.createdAt,
    exitedAt: t.exitedAt ?? null,
    exitCode: t.exitCode ?? null,
    pending: false,
  };
}

function projectTerminals(projectId) {
  return (db$().terminals ?? []).filter((t) => t.projectId === projectId);
}

/**
 * 票据直接复用 chat.mjs 的 terminalTickets —— WS 握手是同一张表。
 * 这里 import 进来而不是自己再建一张，否则项目终端连不上。
 */
async function issueTicket(terminalId, userId) {
  const { terminalTickets } = await import('./chat.mjs');
  const ticket = rid(32);
  terminalTickets.set(ticket, { terminalId, userId, expiresAt: Date.now() + 5 * 60e3 });
  return ticket;
}

async function getProjectTerminals(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const list = projectTerminals(pr.id).filter((t) => t.state !== 'exited').map(terminalShape);
  return { terminals: list, items: list, total: list.length, shell: 'bash' };
}

async function createProjectTerminal(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const db = db$();
  const terminalId = p?.terminalId ?? uuid();
  let t = projectTerminals(pr.id).find((x) => x.id === terminalId);
  if (!t) {
    t = {
      id: terminalId,
      projectId: pr.id,
      // WS 那侧按 conversationId 取工作区根目录，这里指向同一个 id，让终端落在项目目录里
      conversationId: pr.id,
      title: p?.title ?? p?.name ?? 'bash',
      cwd: pr.workdir ?? '',
      state: 'running',
      cols: Number(p?.cols) || 80,
      rows: Number(p?.rows) || 24,
      createdAt: now(),
      lastActivityAt: now(),
    };
    (db.terminals ??= []).push(t);
  }
  const ticket = await issueTicket(t.id, ctx.user.id);
  save();
  return { terminal: terminalShape(t), ticket, direct: !!p?.direct };
}

async function attachProjectTerminal(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const t = projectTerminals(pr.id).find((x) => x.id === p?.terminalId);
  if (!t) notFound('终端');
  t.lastActivityAt = now();
  save();
  return { ticket: await issueTicket(t.id, ctx.user.id), direct: !!p?.direct, terminal: terminalShape(t) };
}

async function updateProjectTerminal(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const t = projectTerminals(pr.id).find((x) => x.id === req(p, 'terminalId'));
  if (!t) notFound('终端');
  if (p?.name !== undefined) t.title = String(p.name).slice(0, 120);
  if (p?.title !== undefined) t.title = String(p.title).slice(0, 120);
  if (p?.cols) t.cols = Number(p.cols);
  if (p?.rows) t.rows = Number(p.rows);
  t.lastActivityAt = now();
  save();
  return { terminal: terminalShape(t) };
}

async function closeProjectTerminal(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const t = projectTerminals(pr.id).find((x) => x.id === req(p, 'terminalId'));
  if (t) {
    t.state = 'exited';
    t.exitedAt = now();
    save();
  }
  return { ok: true };
}

/**
 * 重排：afterId 为 null 表示排到最前。
 * 顺序落在 projectTerminalOrder 表上（{projectId, order:[terminalId]}），
 * getProjectTerminals 会按它排序 —— 否则前端拖完一刷新就回原样。
 */
async function reorderProjectTerminal(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const db = db$();
  const terminalId = req(p, 'terminalId');
  const afterId = p?.afterId ?? null;
  need(projectTerminals(pr.id).some((t) => t.id === terminalId), 'NOT_FOUND', '终端不存在', 404);

  (db.projectTerminalOrder ??= []);
  let rec = db.projectTerminalOrder.find((r) => r.projectId === pr.id);
  if (!rec) {
    rec = { projectId: pr.id, order: projectTerminals(pr.id).map((t) => t.id) };
    db.projectTerminalOrder.push(rec);
  }
  const order = rec.order.filter((id) => id !== terminalId);
  const at = afterId === null ? 0 : order.indexOf(afterId) + 1;
  order.splice(at < 0 ? order.length : at, 0, terminalId);
  rec.order = order;
  save();
  return { ok: true, order };
}

/** 项目重排：语义同终端，顺序落在 project.orderIndex 上 */
async function reorderProject(p, ctx) {
  const pr = ownProject(req(p, 'projectId'), ctx);
  const afterId = p?.afterId ?? null;
  const db = db$();
  const siblings = db.projects
    .filter((x) => x.teamId === pr.teamId && !x.archivedAt)
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const rest = siblings.filter((x) => x.id !== pr.id);
  const at = afterId === null ? 0 : rest.findIndex((x) => x.id === afterId) + 1;
  rest.splice(at < 0 ? rest.length : at, 0, pr);
  rest.forEach((x, i) => {
    x.orderIndex = i;
  });
  save();
  return { ok: true };
}

export const commands = {
  getHostProjects,
  getProjectFiles,
  getProjectFileIndex,
  downloadProjectFile,
  downloadProjectDir,
  createProjectFileLink,
  createProjectOfficeSession,
  getProjectGitStatus,
  getProjectTerminals,
  createProjectTerminal,
  attachProjectTerminal,
  updateProjectTerminal,
  closeProjectTerminal,
  reorderProjectTerminal,
  reorderProject,
};

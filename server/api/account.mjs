// /api/account —— 个人资料、设备、用量、智能体记忆、项目。
//
// 契约来源：app/assets/api-pyi_9PXn.js（客户端）、_shell-CSlH67JO.js（查询键）、
//           设置页 / 用量页 / 项目面板组件。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save } from '../lib/db.mjs';
import { profile, device, project, team, agentMemoryEntry } from '../lib/shapes.mjs';
import { workspaceDir, safeJoin } from '../lib/workspace.mjs';
import { req, notFound, need, badRequest } from '../lib/errors.mjs';

const badReq = (m) => badRequest(m);

/* ------------------------------------------------------------------ */
/* 资料                                                                */
/* ------------------------------------------------------------------ */

async function getProfile(p, ctx) {
  return { profile: profile(ctx.user.id) };
}

async function updateProfile(p, ctx) {
  const u = ctx.user;
  for (const f of ['name', 'email', 'avatarUrl', 'locale', 'theme']) {
    if (p?.[f] !== undefined) u[f] = p[f];
  }
  if (p?.onboarded !== undefined) u.onboardedAt = p.onboarded ? u.onboardedAt ?? now() : null;
  save();
  return { profile: profile(u.id) };
}

async function uploadAvatar(p, ctx) {
  const u = ctx.user;
  const body = ctx.rawBody && ctx.rawBody.length ? ctx.rawBody : null;
  if (body) {
    const dir = path.join(workspaceDir('__avatars__'));
    fs.mkdirSync(dir, { recursive: true });
    const ext = /^image\/png/.test(String(ctx.contentType)) ? '.png'
      : /^image\/jpe?g/.test(String(ctx.contentType)) ? '.jpg'
      : /^image\/webp/.test(String(ctx.contentType)) ? '.webp'
      : '.bin';
    const file = path.join(dir, `${u.id}${ext}`);
    fs.writeFileSync(file, body);
    u.avatarUrl = `/api/avatar/${u.id}${ext}`;
  } else if (p?.avatarUrl !== undefined) {
    u.avatarUrl = p.avatarUrl;
  }
  save();
  return { profile: profile(u.id), url: u.avatarUrl };
}

/* ------------------------------------------------------------------ */
/* 设备                                                                */
/* ------------------------------------------------------------------ */

async function getDevices(p, ctx) {
  const rows = db$().devices.filter((d) => d.userId === ctx.user.id && !d.revokedAt);
  return { devices: rows.map(device), items: rows.map(device), total: rows.length };
}

async function getDevicePresence(p, ctx) {
  const rows = db$().devices.filter((d) => d.userId === ctx.user.id && !d.revokedAt);
  return {
    online: rows.length > 0,
    devices: rows.map(device),
    activeDeviceId: rows[0]?.id ?? null,
    count: rows.length,
  };
}

async function registerDevice(p, ctx) {
  const db = db$();
  const d = {
    id: uuid(),
    userId: ctx.user.id,
    name: p?.name ?? 'Desktop',
    platform: p?.platform ?? 'web',
    appVersion: p?.appVersion ?? null,
    workspaceRoot: p?.workspaceRoot ?? null,
    status: 'active',
    lastSeenAt: now(),
    createdAt: now(),
    revokedAt: null,
  };
  db.devices.push(d);
  save();
  return { device: device(d), token: 'dev_' + uuid().replace(/-/g, '') };
}

async function revokeDevice(p, ctx) {
  const d = db$().devices.find(
    (x) => x.id === p?.deviceId && (x.userId === ctx.user.id || ctx.user.role === 'super_admin'),
  );
  if (d) {
    d.revokedAt = now();
    save();
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 用量                                                                */
/* ------------------------------------------------------------------ */

function rangeStart(days) {
  return Date.now() - Math.max(1, Number(days) || 30) * 864e5;
}

/** 把生产消息里记录的 usage 汇总成前端要的曲线 */
function aggregateUsage(teamId, { rangeDays = 30, memberId, modelId } = {}) {
  const db = db$();
  const since = rangeStart(rangeDays);
  const convOfTeam = new Set(db.conversations.filter((c) => c.teamId === teamId).map((c) => c.id));

  const byDayMap = new Map();
  const byModelMap = new Map();
  const byMemberMap = new Map();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let credits = 0;
  let runs = 0;

  for (const m of db.messages) {
    if (!convOfTeam.has(m.conversationId)) continue;
    const u = m.metadata?.usage;
    if (!u) continue;
    if (Date.parse(m.createdAt) < since) continue;
    const conv = db.conversations.find((c) => c.id === m.conversationId);
    if (memberId && conv?.userId !== memberId) continue;
    if (modelId && m.modelId !== modelId) continue;

    const i = u.inputTokens ?? 0;
    const o = u.outputTokens ?? 0;
    const cr = u.cacheReadTokens ?? Math.round(i * 0.35);
    const c = u.credits ?? Math.round((i * 1 + o * 4) / 1000);

    input += i;
    output += o;
    cacheRead += cr;
    credits += c;
    runs += 1;

    const day = String(m.createdAt).slice(0, 10);
    const d = byDayMap.get(day) ?? { date: day, input: 0, output: 0, cacheRead: 0, credits: 0, runs: 0 };
    d.input += i; d.output += o; d.cacheRead += cr; d.credits += c; d.runs += 1;
    byDayMap.set(day, d);

    const mid = m.modelId ?? 'unknown';
    const mo = byModelMap.get(mid) ?? { modelId: mid, model: mid, input: 0, output: 0, cacheRead: 0, credits: 0, runs: 0 };
    mo.input += i; mo.output += o; mo.cacheRead += cr; mo.credits += c; mo.runs += 1;
    byModelMap.set(mid, mo);

    const uid2 = conv?.userId ?? 'unknown';
    const mu = byMemberMap.get(uid2) ?? { userId: uid2, input: 0, output: 0, cacheRead: 0, credits: 0, runs: 0 };
    mu.input += i; mu.output += o; mu.cacheRead += cr; mu.credits += c; mu.runs += 1;
    byMemberMap.set(uid2, mu);
  }

  const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    input,
    output,
    cacheRead,
    totalTokens: input + output + cacheRead,
    credits,
    runs,
    byDay,
    series: byDay,
    byModel: [...byModelMap.values()].sort((a, b) => b.credits - a.credits),
    models: [...byModelMap.values()].sort((a, b) => b.credits - a.credits),
    byMember: [...byMemberMap.values()].sort((a, b) => b.credits - a.credits),
    members: [...byMemberMap.values()].sort((a, b) => b.credits - a.credits),
  };
}

async function getUsageStats(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const agg = aggregateUsage(teamId, {
    rangeDays: p?.rangeDays ?? 30,
    memberId: p?.memberId,
    modelId: p?.modelId,
  });
  const t = db$().teams.find((x) => x.id === teamId);
  const usageStats = {
    teamId,
    rangeDays: p?.rangeDays ?? 30,
    ...agg,
    balance: t?.creditBalance ?? 0,
    creditBalance: t?.creditBalance ?? 0,
    plan: t?.plan ?? 'free',
    periodStart: new Date(rangeStart(p?.rangeDays ?? 30)).toISOString(),
    periodEnd: now(),
  };
  return { usageStats, ...usageStats };
}

async function getOverview(p, ctx) {
  const db = db$();
  const days = Number(p?.days) || 30;
  const teamId = p?.teamId || ctx.teamId;
  const agg = aggregateUsage(teamId, { rangeDays: days });
  const teamRow = db.teams.find((x) => x.id === teamId);

  // 管理后台的全局总览
  const users = db.users.length;
  const activeUsers = new Set(
    db.conversations.filter((c) => Date.parse(c.lastMessageAt ?? c.updatedAt ?? 0) >= rangeStart(days)).map((c) => c.userId),
  ).size;
  const conversations = db.conversations.filter((c) => c.teamId === teamId).length;

  return {
    // ---- 管理后台口径 ----
    days,
    users,
    activeUsers,
    newUsers: db.users.filter((u) => Date.parse(u.createdAt) >= rangeStart(days)).length,
    teams: db.teams.length,
    conversations,
    hosts: db.hosts.filter((h) => h.teamId === teamId).length,
    tickets: db.tickets.filter((t) => t.teamId === teamId).length,
    openTickets: db.tickets.filter((t) => t.teamId === teamId && t.status !== 'closed').length,
    credits: agg.credits,
    runs: agg.runs,
    tokens: agg.totalTokens,
    revenue: db.paymentOrders.filter((o) => o.status === 'paid').reduce((a, o) => a + (o.amount ?? 0), 0) / 100,
    series: agg.byDay,
    byDay: agg.byDay,
    byModel: agg.byModel,
    // ---- 个人面板口径 ----
    overview: {
      credits: teamRow?.creditBalance ?? 0,
      plan: teamRow?.plan ?? 'free',
      activeConversations: conversations,
      hosts: db.hosts.filter((h) => h.teamId === teamId).length,
      teams: db.teams.length,
      storageUsedGb: 0.8,
      storageTotalGb: 200,
      periodStart: new Date(rangeStart(days)).toISOString(),
      periodEnd: now(),
    },
  };
}

async function getCreditLedger(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const rows = db$()
    .creditLedger.filter((r) => r.teamId === teamId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const page = rows.slice(offset, offset + limit).map((r) => ({
    id: r.id,
    teamId: r.teamId,
    userId: r.userId,
    delta: r.delta,
    reason: r.reason,
    balanceAfter: r.balanceAfter,
    balance: r.balanceAfter,
    note: r.note ?? null,
    createdAt: r.createdAt,
  }));
  return { entries: page, items: page, total: rows.length, limit, offset };
}

/* ------------------------------------------------------------------ */
/* 智能体记忆文件（AGENTS.md / CLAUDE.md 一类）                        */
/* ------------------------------------------------------------------ */

/** scope: global | project | team | user */
function agentFileCandidates(scope, projectId) {
  const base = path.join(workspaceDir('__agent__'));
  const names = {
    global: ['AGENTS.md'],
    team: ['team/AGENTS.md'],
    user: ['user/AGENTS.md'],
    project: [projectId ? `projects/${projectId}/AGENTS.md` : null],
  }[scope ?? 'global'] ?? ['AGENTS.md'];
  return { base, names: names.filter(Boolean) };
}

async function readAgentFile(p, ctx) {
  const scope = p?.scope ?? 'global';
  const { base, names } = agentFileCandidates(scope, p?.projectId);
  const abs = safeJoin(base, names[0]);
  if (!fs.existsSync(abs)) {
    return {
      exists: false,
      content: '',
      scope,
      path: names[0],
      updatedAt: null,
    };
  }
  const st = fs.statSync(abs);
  return {
    exists: true,
    content: fs.readFileSync(abs, 'utf8'),
    scope,
    path: names[0],
    updatedAt: st.mtime.toISOString(),
  };
}

async function writeAgentFile(p, ctx) {
  const scope = p?.scope ?? 'global';
  const { base, names } = agentFileCandidates(scope, p?.projectId);
  const abs = safeJoin(base, names[0]);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(p?.content ?? ''), 'utf8');
  return { exists: true, content: String(p?.content ?? ''), scope, path: names[0], updatedAt: now() };
}

async function listAgentMemory(p, ctx) {
  // 项目级记忆条目
  const projectId = p?.projectId ?? null;
  const rows = db$()
    .agentMemory.filter((m) => (projectId ? m.projectId === projectId : m.teamId === ctx.teamId))
    .map(agentMemoryEntry);
  const file = await readAgentFile({ scope: projectId ? 'project' : 'global', projectId }, ctx);
  return { items: rows, entries: rows, total: rows.length, file, exists: file.exists, content: file.content };
}

async function createAgentMemory(p, ctx) {
  const row = {
    id: uuid(),
    teamId: ctx.teamId,
    userId: ctx.user.id,
    projectId: p?.projectId ?? null,
    scope: p?.scope ?? (p?.projectId ? 'project' : 'global'),
    key: p?.key ?? p?.title ?? 'memory',
    content: p?.content ?? '',
    createdAt: now(),
    updatedAt: now(),
  };
  db$().agentMemory.push(row);
  save();
  return { item: agentMemoryEntry(row), ...agentMemoryEntry(row) };
}

async function updateAgentMemory(p, ctx) {
  const row = db$().agentMemory.find((m) => m.id === req(p, 'id'));
  if (!row) notFound('记忆条目');
  if (p?.key !== undefined) row.key = p.key;
  if (p?.content !== undefined) row.content = p.content;
  row.updatedAt = now();
  save();
  return { item: agentMemoryEntry(row) };
}

async function deleteAgentMemory(p, ctx) {
  const db = db$();
  const id = req(p, 'id');
  db.agentMemory = db.agentMemory.filter((m) => m.id !== id);
  save();
  return { ok: true, id };
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

async function getProjects(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  let rows = db$().projects.filter((x) => x.teamId === teamId);
  if (!p?.includeArchived && !p?.archivedOnly) rows = rows.filter((x) => !x.archivedAt);
  if (p?.archivedOnly) rows = db$().projects.filter((x) => x.teamId === teamId && x.archivedAt);
  if (p?.mineOnly) rows = rows.filter((x) => x.userId === ctx.user.id);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((x) => (x.name ?? '').toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => {
    const pa = a.pinnedAt ? 1 : 0;
    const pb = b.pinnedAt ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return Date.parse(b.updatedAt ?? b.createdAt) - Date.parse(a.updatedAt ?? a.createdAt);
  });
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 50));
  const offset = Math.max(0, Number(p?.offset) || 0);
  return {
    projects: rows.slice(offset, offset + limit).map(project),
    total: rows.length,
    limit,
    offset,
  };
}

async function getProject(p, ctx) {
  const row = db$().projects.find((x) => x.id === req(p, 'projectId'));
  if (!row) notFound('项目');
  return { project: project(row) };
}

async function createProject(p, ctx) {
  const row = {
    id: uuid(),
    teamId: p?.teamId || ctx.teamId,
    userId: ctx.user.id,
    name: p?.name ?? p?.title ?? '未命名项目',
    kind: p?.kind ?? 'explicit',
    instruction: p?.instruction ?? null,
    createdAt: now(),
    updatedAt: now(),
    archivedAt: null,
    pinnedAt: null,
  };
  db$().projects.push(row);
  save();
  return { project: project(row), id: row.id };
}

async function updateProject(p, ctx) {
  const row = db$().projects.find((x) => x.id === req(p, 'projectId'));
  if (!row) notFound('项目');
  for (const f of ['name', 'instruction', 'kind']) if (p?.[f] !== undefined) row[f] = p[f];
  if (p?.pinned !== undefined) row.pinnedAt = p.pinned ? now() : null;
  row.updatedAt = now();
  save();
  return { project: project(row) };
}

async function deleteProject(p, ctx) {
  const db = db$();
  const id = req(p, 'projectId');
  db.projects = db.projects.filter((x) => x.id !== id);
  for (const c of db.conversations) if (c.projectId === id) c.projectId = null;
  save();
  return { ok: true, id };
}

async function archiveProject(p, ctx) {
  const row = db$().projects.find((x) => x.id === req(p, 'projectId'));
  if (!row) notFound('项目');
  row.archivedAt = now();
  row.updatedAt = now();
  save();
  return { ok: true };
}

async function unarchiveProject(p, ctx) {
  const row = db$().projects.find((x) => x.id === req(p, 'projectId'));
  if (!row) notFound('项目');
  row.archivedAt = null;
  row.updatedAt = now();
  save();
  return { ok: true };
}

async function cloneProject(p, ctx) {
  const src = db$().projects.find((x) => x.id === req(p, 'projectId'));
  if (!src) notFound('项目');
  const row = {
    ...src,
    id: uuid(),
    userId: ctx.user.id,
    name: p?.name ?? `${src.name} 副本`,
    createdAt: now(),
    updatedAt: now(),
    archivedAt: null,
    pinnedAt: null,
  };
  db$().projects.push(row);
  save();
  return { project: project(row) };
}

/* ------------------------------------------------------------------ */
/* 用户查询（普通用户可见的轻量版；完整版在 admin.mjs）                */
/* ------------------------------------------------------------------ */

async function getUsers(p, ctx) {
  const rows = db$().users.map((u) => ({
    id: u.id,
    userId: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    avatarUrl: u.avatarUrl ?? null,
    role: u.role,
    banned: !!u.banned,
    createdAt: u.createdAt,
  }));
  return { users: rows, items: rows, total: rows.length };
}

async function getUserDetail(p, ctx) {
  const db = db$();
  const u = db.users.find((x) => x.id === (p?.userId ?? p?.id));
  if (!u) notFound('用户');

  // 后台「用户详情」抽屉一次拿全：团队 / 主机 / 会话 / 订单 / 统计。
  // 命令注释（server/api/admin.mjs 顶部）写明了是**直接对象**，
  // 即这些分组挂在顶层，而不是塞进 detail 里 —— 前端抽屉直接解构顶层字段。
  const teams = db.teams.filter((t) => db.teamMembers.some((m) => m.teamId === t.id && m.userId === u.id));
  const hosts = db.hosts.filter((h) => h.userId === u.id);
  const conversations = db.conversations.filter((c) => c.userId === u.id);
  const orders = db.paymentOrders.filter((o) => o.userId === u.id);
  const tickets = db.tickets.filter((t) => t.userId === u.id);

  const stats = {
    teams: teams.length,
    hosts: hosts.length,
    conversations: conversations.length,
    messages: db.messages.filter((m) => conversations.some((c) => c.id === m.conversationId)).length,
    orders: orders.length,
    spentCents: orders.filter((o) => o.status === 'paid').reduce((s, o) => s + (o.amountCents ?? 0), 0),
    tickets: tickets.length,
    creditBalanceMilli: db.creditLedger.filter((r) => r.userId === u.id).reduce((s, r) => s + (r.deltaMilli ?? 0), 0),
  };

  return {
    user: {
      id: u.id,
      userId: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      avatarUrl: u.avatarUrl ?? null,
      role: u.role,
      banned: !!u.banned,
      banReason: u.banReason ?? null,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt ?? null,
    },
    teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.ownerId === u.id ? 'owner' : 'member' })),
    hosts: hosts.map((h) => ({ id: h.id, name: h.name, kind: h.kind, status: h.status })),
    conversations: conversations.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt ?? c.createdAt })),
    orders: orders.map((o) => ({ id: o.id, orderNo: o.orderNo, amountCents: o.amountCents, status: o.status, createdAt: o.createdAt })),
    stats,
    // 兼容早期本地页面用过的 detail 分组
    detail: { teams: teams.length, conversations: conversations.length },
  };
}


/* ------------------------------------------------------------------ */
/* 链接预览（线上新版，markdown-D1ENAiuX.js）                          */
/* ------------------------------------------------------------------ */

/**
 * 前端：n('getLinkPreview',{url}).then(e => e.preview)
 * 缓存键 ['linkPreview', url]，staleTime 无穷、retry:false ——
 * 所以失败也必须给个 preview 对象，否则 UI 会一直挂在 loading。
 */
async function getLinkPreview(p, ctx) {
  const url = req(p, 'url');
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw badReq('链接不合法');
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { preview: { url: String(url), title: null, description: null, image: null, siteName: parsed.hostname, error: 'unsupported-scheme' } };
  }
  const fallback = {
    url: String(url),
    title: parsed.hostname,
    description: null,
    image: null,
    siteName: parsed.hostname,
    fetched: false,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(String(url), {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'ClawsGO-LinkPreview/1.0', Accept: 'text/html,*/*' },
    }).finally(() => clearTimeout(timer));
    const ctype = resp.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain/i.test(ctype)) {
      return { preview: { ...fallback, fetched: true, kind: 'binary', contentType: ctype } };
    }
    const html = (await resp.text()).slice(0, 400000);
    const meta = (name) => {
      const m =
        new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html) ??
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i').exec(html);
      return m ? decodeEntities(m[1]) : null;
    };
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return {
      preview: {
        url: String(url),
        title: meta('og:title') ?? (titleM ? decodeEntities(titleM[1].trim()) : null) ?? parsed.hostname,
        description: meta('og:description') ?? meta('description'),
        image: meta('og:image'),
        siteName: meta('og:site_name') ?? parsed.hostname,
        favicon: meta('og:image') ? null : `${parsed.origin}/favicon.ico`,
        fetched: true,
        status: resp.status,
      },
    };
  } catch (e) {
    return { preview: { ...fallback, fetched: false, error: String(e?.message ?? e) } };
  }
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export const commands = {
  getProfile,
  updateProfile,
  uploadAvatar,
  getDevices,
  getDevicePresence,
  registerDevice,
  revokeDevice,
  getUsageStats,
  getOverview,
  getCreditLedger,
  readAgentFile,
  writeAgentFile,
  listAgentMemory,
  createAgentMemory,
  updateAgentMemory,
  deleteAgentMemory,
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  archiveProject,
  unarchiveProject,
  cloneProject,
  getUsers,
  getUserDetail,
  getLinkPreview,
};

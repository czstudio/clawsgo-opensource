// /api/support —— 工单与公告。
//
// 契约来源：app/assets/useTickets-CC7qLODn.js（权威）
//   getMyTickets({limit,offset}) → 直接返回对象，前端取 .tickets
//   getTicket({id})              → { ticket:{status}, messages:[{attachments:[{url}]}], truncated }
//   uploadTicketAttachment(FormData:'file') → { attachment:{url} }
//   getTicketUnreadCount()       → { count }
//   getActiveAnnouncements()     → { announcements: [...] }
//
// 细节还原：useTickets 的 s() 会用 `new URL(attachment.url)` 解析附件地址并读
//   X-Amz-Date / X-Amz-Expires 判断签名是否过期。这意味着**附件 URL 必须是绝对地址**
//   （相对路径会让 new URL 抛异常），且最好带上合法的预签名参数，否则前端每 10 秒
//   就会判定「过期」并强制刷新。这里按 S3 预签名格式生成。
import { db$, uuid, now, save, rid } from '../lib/db.mjs';
import { ticket, ticketMessage, announcement } from '../lib/shapes.mjs';
import { req, notFound, need, badRequest, conflict } from '../lib/errors.mjs';

const ATTACH_TTL_SECONDS = 7 * 24 * 3600;

const ORIGIN = () =>
  process.env.CLAWSGO_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT_APP || 5181}`;

/** YYYYMMDDTHHMMSSZ —— 前端按这个格式切片解析 */
function amzDate(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** 生成预签名风格附件地址（绝对 URL + 合法 X-Amz-* 参数） */
function signedAttachmentUrl(attachmentId, filename) {
  const q = new URLSearchParams({
    attachmentId,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': 'local/' + amzDate().slice(0, 8) + '/cn-north-1/s3/aws4_request',
    'X-Amz-Date': amzDate(),
    'X-Amz-Expires': String(ATTACH_TTL_SECONDS),
    'X-Amz-SignedHeaders': 'host',
    'X-Amz-Signature': rid(64),
    'response-content-disposition': `attachment; filename="${filename}"`,
  });
  return `${ORIGIN()}/api/ticketAttachment?${q.toString()}`;
}

function ownTicket(id, ctx) {
  const t = db$().tickets.find((x) => x.id === id);
  if (!t) notFound('工单');
  const isAdmin = ['admin', 'super_admin'].includes(ctx.user.role);
  need(t.userId === ctx.user.id || t.teamId === ctx.teamId || isAdmin, 'FORBIDDEN', '无权访问该工单', 403);
  return t;
}

/* ------------------------------------------------------------------ */

async function getMyTickets(p, ctx) {
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 50));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const db = db$();
  const rows = db.tickets
    .filter((t) => t.userId === ctx.user.id || t.teamId === ctx.teamId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const page = rows.slice(offset, offset + limit).map((t) => ({
    ...ticket(t),
    messages: db.ticketMessages
      .filter((m) => m.ticketId === t.id)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(ticketMessage),
  }));
  return { tickets: page, items: page, total: rows.length, limit, offset };
}

async function getTicket(p, ctx) {
  const t = ownTicket(req(p, 'id'), ctx);
  const rows = db$()
    .ticketMessages.filter((m) => m.ticketId === t.id)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(ticketMessage);
  return {
    ticket: ticket(t),
    messages: rows,
    truncated: false,
    unreadCount: t.unreadForUser ?? 0,
  };
}

async function createTicket(p, ctx) {
  const subject = String(p?.subject ?? '').trim();
  if (!subject) throw badRequest('请填写工单标题', 'INVALID_SUBJECT');
  const body = String(p?.body ?? p?.content ?? '').trim();
  if (!body) throw badRequest('请填写工单内容', 'INVALID_BODY');

  const db = db$();
  db.counters.ticket = (db.counters.ticket ?? 1000) + 1;
  const t = {
    id: uuid(),
    seq: db.counters.ticket,
    teamId: ctx.teamId,
    userId: ctx.user.id,
    type: p?.type ?? 'general',
    subject,
    status: 'open',
    priority: ['low', 'normal', 'high', 'urgent'].includes(p?.priority) ? p.priority : 'normal',
    createdAt: now(),
    updatedAt: now(),
    lastMessagePreview: body.slice(0, 120),
    lastMessageAttachments: (p?.attachments ?? []).length,
    unreadForUser: 0,
    unreadForAdmin: 1,
  };
  db.tickets.push(t);
  db.ticketMessages.push({
    id: uuid(),
    ticketId: t.id,
    authorId: ctx.user.id,
    authorRole: ctx.user.role,
    body,
    attachments: normalizeAttachments(p?.attachments),
    createdAt: now(),
  });
  save();
  return { ticket: ticket(t), id: t.id };
}

async function replyTicket(p, ctx) {
  const t = ownTicket(req(p, 'id'), ctx);
  const body = String(p?.body ?? p?.content ?? '').trim();
  if (!body) throw badRequest('回复内容不能为空', 'INVALID_BODY');
  if (['closed', 'resolved'].includes(t.status)) {
    throw badRequest('工单已关闭，无法回复', 'TICKET_CLOSED');
  }
  const db = db$();
  db.ticketMessages.push({
    id: uuid(),
    ticketId: t.id,
    authorId: ctx.user.id,
    authorRole: ctx.user.role,
    body,
    attachments: normalizeAttachments(p?.attachments),
    createdAt: now(),
  });
  t.status = 'open';
  t.updatedAt = now();
  t.lastMessagePreview = body.slice(0, 120);
  t.lastMessageAttachments = (p?.attachments ?? []).length;
  t.unreadForAdmin = (t.unreadForAdmin ?? 0) + 1;
  t.unreadForUser = 0;
  save();
  return { ok: true, ticket: ticket(t) };
}

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => {
    if (typeof a === 'string') {
      const id = rid(20);
      return { id, name: a.split('/').pop(), size: 0, url: signedAttachmentUrl(id, a.split('/').pop()) };
    }
    const id = a?.id ?? rid(20);
    return {
      id,
      name: a?.name ?? 'attachment',
      size: a?.size ?? 0,
      mimeType: a?.mimeType ?? 'application/octet-stream',
      url: a?.url ?? signedAttachmentUrl(id, a?.name ?? 'attachment'),
    };
  });
}

async function uploadTicketAttachment(p, ctx) {
  // 走 FormData：ctx.formFields.file / ctx.rawBody 里是文件字节
  const file = ctx.files?.file?.[0] ?? null;
  const id = rid(20);
  const name = file?.filename ?? p?.name ?? 'attachment';
  let url = signedAttachmentUrl(id, name);

  if (file?.data?.length) {
    const dir = (await import('node:path')).join(
      (await import('node:path')).resolve(import.meta.dirname, '..'),
      'data',
      'attachments',
    );
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    const path = (await import('node:path')).join(dir, `${id}__${name.replace(/[/\\]/g, '_')}`);
    fs.writeFileSync(path, file.data);
    db$().attachments ??= [];
    db$().attachments.push({ id, ticketId: null, name, path, size: file.data.length, createdAt: now() });
    save();
  }
  const attachment = {
    id,
    name,
    size: file?.data?.length ?? 0,
    mimeType: file?.mimeType ?? 'application/octet-stream',
    url,
  };
  return { attachment, id, url };
}

async function markTicketSeen(p, ctx) {
  const t = ownTicket(req(p, 'id'), ctx);
  t.unreadForUser = 0;
  save();
  return { ok: true };
}

async function getTicketUnreadCount(p, ctx) {
  const rows = db$().tickets.filter((t) => t.userId === ctx.user.id);
  return { count: rows.reduce((a, t) => a + (t.unreadForUser ?? 0), 0) };
}

async function getActiveAnnouncements(p, ctx) {
  const rows = db$()
    .announcements.filter((a) => a.active !== false)
    .sort((a, b) => Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt));
  const announcements = rows.map(announcement);
  return { announcements, items: announcements, total: announcements.length };
}

export const commands = {
  getMyTickets,
  getTickets: getMyTickets,
  getTicket,
  createTicket,
  replyTicket,
  uploadTicketAttachment,
  markTicketSeen,
  getTicketUnreadCount,
  getActiveAnnouncements,
  // admin 别名
  adminGetTickets: async (p, ctx) => {
    const limit = Math.max(1, Math.min(200, Number(p?.limit) || 20));
    const offset = Math.max(0, Number(p?.offset) || 0);
    let rows = db$().tickets;
    if (p?.status) rows = rows.filter((t) => t.status === p.status);
    if (p?.query) {
      const q = String(p.query).toLowerCase();
      rows = rows.filter((t) => t.subject.toLowerCase().includes(q) || String(t.seq).includes(q));
    }
    rows = [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const page = rows.slice(offset, offset + limit).map(ticket);
    return { tickets: page, items: page, total: rows.length, limit, offset };
  },
  adminGetTicket: async (p, ctx) => {
    const t = db$().tickets.find((x) => x.id === (p?.ticketId ?? p?.id));
    if (!t) notFound('工单');
    const messages = db$()
      .ticketMessages.filter((m) => m.ticketId === t.id)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(ticketMessage);
    return { ticket: ticket(t), messages, truncated: false };
  },
  adminReplyTicket: async (p, ctx) => {
    const t = db$().tickets.find((x) => x.id === (p?.ticketId ?? p?.id));
    if (!t) notFound('工单');
    const body = String(p?.body ?? '').trim();
    if (!body) throw badRequest('回复内容不能为空', 'INVALID_BODY');
    db$().ticketMessages.push({
      id: uuid(),
      ticketId: t.id,
      authorId: ctx.user.id,
      authorRole: ctx.user.role,
      body,
      attachments: normalizeAttachments(p?.attachments),
      createdAt: now(),
    });
    t.status = p?.status ?? 'answered';
    t.updatedAt = now();
    t.lastMessagePreview = body.slice(0, 120);
    t.unreadForUser = (t.unreadForUser ?? 0) + 1;
    t.unreadForAdmin = 0;
    save();
    return { ok: true, ticket: ticket(t) };
  },
  adminCloseTicket: async (p, ctx) => {
    const t = db$().tickets.find((x) => x.id === (p?.ticketId ?? p?.id));
    if (!t) notFound('工单');
    t.status = 'closed';
    t.updatedAt = now();
    save();
    return { ok: true, ticket: ticket(t) };
  },
  adminGetTicketStats: async () => {
    const rows = db$().tickets;
    const by = (s) => rows.filter((t) => t.status === s).length;
    return {
      stats: {
        total: rows.length,
        open: by('open'),
        answered: by('answered'),
        resolved: by('resolved'),
        closed: by('closed'),
        unread: rows.reduce((a, t) => a + (t.unreadForAdmin ?? 0), 0),
        byPriority: {
          low: rows.filter((t) => t.priority === 'low').length,
          normal: rows.filter((t) => t.priority === 'normal').length,
          high: rows.filter((t) => t.priority === 'high').length,
          urgent: rows.filter((t) => t.priority === 'urgent').length,
        },
      },
    };
  },

  /* ---------- 公告（管理端） ---------- */
  adminGetAnnouncements: async () => {
    const rows = db$()
      .announcements.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(announcement);
    return { announcements: rows, items: rows, total: rows.length };
  },
  adminCreateAnnouncement: async (p, ctx) => {
    const row = {
      id: uuid(),
      titleZh: req(p, 'titleZh'),
      titleEn: p?.titleEn ?? p.titleZh,
      contentZh: p?.contentZh ?? '',
      contentEn: p?.contentEn ?? p.contentZh ?? '',
      level: ['info', 'warning', 'critical'].includes(p?.level) ? p.level : 'info',
      active: p?.active !== false,
      publishedAt: now(),
      createdAt: now(),
      createdBy: ctx.user.id,
    };
    db$().announcements.push(row);
    save();
    return { announcement: announcement(row), ok: true };
  },
  adminUpdateAnnouncement: async (p) => {
    const row = db$().announcements.find((a) => a.id === req(p, 'announcementId'));
    if (!row) notFound('公告');
    for (const f of ['titleZh', 'titleEn', 'contentZh', 'contentEn', 'level', 'active']) {
      if (p?.[f] !== undefined) row[f] = p[f];
    }
    save();
    return { announcement: announcement(row), ok: true };
  },
  adminDeleteAnnouncement: async (p) => {
    const db = db$();
    const id = req(p, 'announcementId');
    db.announcements = db.announcements.filter((a) => a.id !== id);
    save();
    return { ok: true };
  },
};

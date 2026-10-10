// /api/admin —— 后台（64 条命令）。
//
// 契约来源：app/assets/AdminUserDetailDialog-D3FjH6JN.js、hosts-ZkvcZxvT.js、
//           payments-WbQaOkci.js、useAdminInvoices-D8xdrx4V.js、growth-CJINKIcX.js、
//           migration-CUW_Vdlp.js
//
// 响应键已逐个核对：
//   getUserDetail        → 直接对象（含 user / teams / hosts / conversations 等分组）
//   adminGetUserOrders   → { orders }        adminGetUserInvites → { invitees, codes }
//   adminGetUserLedger   → { entries }       adminGetTeamLedger  → { entries }
//   adminGetTeamOrders   → { orders }        adminGetConversationCosts → { costs }
//   adminGetPromoterDetail → { promotion }   adminGetMigrationStatus → { status:{running} }
//   其余列表类 → 直接返回数组容器（同时给出 items / 领域键两种别名，兼容两种写法）
import { db$, uuid, now, save, rid } from '../lib/db.mjs';
import {
  user as userShape,
  profile,
  team as teamShape,
  teamMember,
  conversation as conversationShape,
  message as messageShape,
  host as hostShape,
  paymentOrder,
  invoice,
  creditLedgerRow,
  redeemCode,
  inviteCode,
  subscription as subscriptionShape,
  announcement,
  ticket,
} from '../lib/shapes.mjs';
import { PLANS, allPlanSpecs, PLAN_MONTHLY_CREDITS, TOPUP_TIERS } from '../lib/plans.mjs';
import { req, notFound, need, badRequest } from '../lib/errors.mjs';
import { createFileLinkRecord, binaryFor, officeSessionFor } from '../lib/office.mjs';

const LIMIT = (p, d = 50) => Math.max(1, Math.min(500, Number(p?.limit) || d));
const OFFSET = (p) => Math.max(0, Number(p?.offset) || 0);

/** 统一列表返回：容器对象 + items 别名的双写 */
function listOut(key, rows, total, p) {
  return { [key]: rows, items: rows, total, limit: LIMIT(p), offset: OFFSET(p) };
}

function adminOnly(ctx) {
  need(['admin', 'super_admin'].includes(ctx.user.role), 'FORBIDDEN', '需要管理员权限', 403);
}

function audit(ctx, action, target, detail) {
  db$().auditLogs.push({
    id: uuid(),
    actorId: ctx.user.id,
    actorName: ctx.user.name,
    action,
    target,
    detail: detail ?? null,
    createdAt: now(),
  });
  save();
}

const paged = (rows, p, d = 50) => rows.slice(OFFSET(p), OFFSET(p) + LIMIT(p, d));

/* ================================================================== */
/* 用户                                                                */
/* ================================================================== */

async function adminGetUsers(p, ctx) {
  adminOnly(ctx);
  let rows = db$().users;
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter(
      (u) =>
        (u.name ?? '').toLowerCase().includes(q) ||
        (u.phone ?? '').includes(q) ||
        (u.email ?? '').toLowerCase().includes(q) ||
        u.id.includes(q),
    );
  }
  if (p?.role) rows = rows.filter((u) => u.role === p.role);
  if (p?.banned !== undefined) rows = rows.filter((u) => !!u.banned === !!p.banned);
  if (p?.plan) rows = rows.filter((u) => (u.plan ?? 'free') === p.plan);
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const users = paged(rows, p).map((u) => ({
    ...userShape(u.id),
    plan: u.plan ?? 'free',
    teams: db$().teamMembers.filter((m) => m.userId === u.id).length,
    conversations: db$().conversations.filter((c) => c.userId === u.id).length,
    lastActiveAt: db$()
      .conversations.filter((c) => c.userId === u.id)
      .reduce((a, c) => (Date.parse(c.lastMessageAt ?? 0) > Date.parse(a ?? 0) ? c.lastMessageAt : a), null),
  }));
  return listOut('users', users, rows.length, p);
}

async function adminGetUserDetail(p, ctx) {
  adminOnly(ctx);
  const u = db$().users.find((x) => x.id === req(p, 'userId'));
  if (!u) notFound('用户');
  const db = db$();
  const teams = db.teamMembers
    .filter((m) => m.userId === u.id)
    .map((m) => {
      const t = db.teams.find((x) => x.id === m.teamId);
      return { ...teamShape(t, u.id), role: m.role, memberId: m.id };
    });
  const hosts = db.hosts.filter((h) => h.userId === u.id).map(hostShape);
  const conversations = db.conversations.filter((c) => c.userId === u.id);
  const ledger = db.creditLedger.filter((r) => r.userId === u.id);
  const orders = db.paymentOrders.filter((o) => o.userId === u.id);

  return {
    ...profile(u.id),
    user: userShape(u.id),
    profile: profile(u.id),
    teams,
    hosts,
    subscription: u.id === ctx.teamId ? subscriptionShape(db.subscriptions.find((s) => s.teamId === u.id)) : null,
    stats: {
      teams: teams.length,
      hosts: hosts.length,
      conversations: conversations.length,
      messages: db.messages.filter((m) => db.conversations.some((c) => c.id === m.conversationId && c.userId === u.id)).length,
      creditsSpent: Math.abs(ledger.filter((r) => r.delta < 0).reduce((a, r) => a + r.delta, 0)),
      paidCents: orders.filter((o) => o.status === 'paid').reduce((a, o) => a + o.amountCents, 0),
      tickets: db.tickets.filter((t) => t.userId === u.id).length,
      devices: db.devices.filter((d) => d.userId === u.id && !d.revokedAt).length,
    },
    balance: db.teams.find((t) => t.id === u.id)?.creditBalance ?? 0,
  };
}

async function adminGetUserTeams(p, ctx) {
  adminOnly(ctx);
  const userId = req(p, 'userId');
  const rows = db$()
    .teamMembers.filter((m) => m.userId === userId)
    .map((m) => {
      const t = db$().teams.find((x) => x.id === m.teamId);
      return { ...teamShape(t, userId), role: m.role, joinedAt: m.joinedAt };
    });
  return listOut('teams', rows, rows.length, p);
}

async function adminGetUserHosts(p, ctx) {
  adminOnly(ctx);
  const rows = db$().hosts.filter((h) => h.userId === req(p, 'userId')).map(hostShape);
  return listOut('hosts', rows, rows.length, p);
}

async function adminGetUserOrders(p, ctx) {
  adminOnly(ctx);
  const rows = db$()
    .paymentOrders.filter((o) => o.userId === req(p, 'userId'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const orders = paged(rows, p, 50).map((o) => paymentOrder({ ...o, amount: o.amountCents }));
  return listOut('orders', orders, rows.length, p);
}

async function adminGetUserLedger(p, ctx) {
  adminOnly(ctx);
  const userId = req(p, 'userId');
  let rows = db$().creditLedger.filter((r) => r.userId === userId);
  if (p?.scope && p.scope !== 'all') {
    rows = rows.filter((r) => (p.scope === 'spend' ? r.delta < 0 : r.delta > 0));
  }
  rows = rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const entries = paged(rows, p, 50).map(creditLedgerRow);
  return listOut('entries', entries, rows.length, p);
}

async function adminGetUserInvites(p, ctx) {
  adminOnly(ctx);
  const userId = req(p, 'userId');
  const db = db$();
  const codes = db.inviteCodes.filter((c) => c.userId === userId).map(inviteCode);
  const invitees = db.teamMembers
    .filter((m) => m.invitedByCode || m.invitedBy === userId)
    .map((m) => ({
      userId: m.userId,
      teamId: m.teamId,
      code: m.invitedByCode ?? null,
      joinedAt: m.joinedAt,
      name: db.users.find((u) => u.id === m.userId)?.name ?? null,
    }));
  return { codes, invitees, items: invitees, total: invitees.length, limit: LIMIT(p), offset: OFFSET(p) };
}

async function setUserRole(p, ctx) {
  adminOnly(ctx);
  const u = db$().users.find((x) => x.id === req(p, 'userId'));
  if (!u) notFound('用户');
  const role = String(p?.role ?? '');
  if (!['user', 'admin', 'super_admin'].includes(role)) throw badRequest('未知角色', 'INVALID_ROLE');
  if (u.role === 'super_admin' && ctx.user.id !== u.id) throw badRequest('不能修改超级管理员', 'CANNOT_MODIFY_SUPER_ADMIN');
  const prev = u.role;
  u.role = role;
  audit(ctx, 'set_user_role', u.id, `${prev} → ${role}`);
  save();
  return { ok: true, user: userShape(u.id) };
}

async function banUser(p, ctx) {
  adminOnly(ctx);
  const u = db$().users.find((x) => x.id === (p?.userId ?? p?.id));
  if (!u) notFound('用户');
  u.banned = true;
  u.banReason = p?.reason ?? '违反平台规则';
  audit(ctx, 'ban_user', u.id, u.banReason);
  save();
  return { ok: true, user: userShape(u.id) };
}

async function unbanUser(p, ctx) {
  adminOnly(ctx);
  const u = db$().users.find((x) => x.id === (p?.userId ?? p?.id));
  if (!u) notFound('用户');
  u.banned = false;
  u.banReason = null;
  audit(ctx, 'unban_user', u.id, null);
  save();
  return { ok: true, user: userShape(u.id) };
}

async function adminTopupCredits(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const teamId = p?.teamId ?? p?.userId ?? req(p, 'teamId');
  const t = db.teams.find((x) => x.id === teamId);
  if (!t) notFound('团队');
  const delta = Number(p?.credits ?? p?.amount);
  if (!Number.isFinite(delta) || delta === 0) throw badRequest('额度数量不合法', 'INVALID_AMOUNT');
  t.creditBalance = Math.max(0, (t.creditBalance ?? 0) + delta);
  db.creditLedger.push({
    id: uuid(),
    teamId: t.id,
    userId: t.ownerId,
    delta,
    reason: 'topup',
    balanceAfter: t.creditBalance,
    note: p?.note ?? '管理员手动调整',
    createdAt: now(),
  });
  audit(ctx, 'topup_credits', t.id, `${delta > 0 ? '+' : ''}${delta}`);
  save();
  return { ok: true, balance: t.creditBalance };
}

async function adminGrantPlan(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const teamId = req(p, 'teamId');
  const planId = req(p, 'planId');
  if (!PLANS.includes(planId)) throw badRequest('未知套餐', 'INVALID_PLAN');
  const t = db.teams.find((x) => x.id === teamId);
  if (!t) notFound('团队');
  const months = Number(p?.months) || 1;
  let s = db.subscriptions.find((x) => x.teamId === teamId);
  if (!s) {
    s = {
      id: uuid(),
      teamId,
      plan: planId,
      planId,
      status: 'active',
      seats: 1,
      priceMonthly: 0,
      currency: 'CNY',
      cycleStartAt: now(),
      planEndAt: null,
      createdAt: now(),
    };
    db.subscriptions.push(s);
  }
  s.plan = planId;
  s.planId = planId;
  s.status = 'active';
  s.cycleStartAt = now();
  s.planEndAt = new Date(Date.now() + 2592e6 * months).toISOString();
  s.currentPeriodEnd = s.planEndAt;
  s.monthlyMilli = PLAN_MONTHLY_CREDITS[planId] * 1000;
  t.plan = planId;
  audit(ctx, 'grant_plan', teamId, `${planId} · ${months} 个月`);
  save();
  return { ok: true, subscription: subscriptionShape(s) };
}

/* ================================================================== */
/* 团队                                                                */
/* ================================================================== */

async function adminGetTeams(p, ctx) {
  adminOnly(ctx);
  let rows = db$().teams;
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((t) => (t.name ?? '').toLowerCase().includes(q) || t.id.includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const teams = paged(rows, p).map((t) => {
    const db = db$();
    return {
      ...teamShape(t, t.ownerId),
      ownerName: db.users.find((u) => u.id === t.ownerId)?.name ?? null,
      memberCount: db.teamMembers.filter((m) => m.teamId === t.id).length,
      conversations: db.conversations.filter((c) => c.teamId === t.id).length,
      hosts: db.hosts.filter((h) => h.teamId === t.id).length,
      plan: db.subscriptions.find((s) => s.teamId === t.id)?.planId ?? t.plan ?? 'free',
    };
  });
  return listOut('teams', teams, rows.length, p);
}

async function adminGetTeamDetail(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const t = db.teams.find((x) => x.id === req(p, 'teamId'));
  if (!t) notFound('团队');
  const s = db.subscriptions.find((x) => x.teamId === t.id);
  const ledger = db.creditLedger.filter((r) => r.teamId === t.id);
  const orders = db.paymentOrders.filter((o) => o.teamId === t.id);
  return {
    ...teamShape(t, t.ownerId),
    team: teamShape(t, t.ownerId),
    detail: {
      ownerName: db.users.find((u) => u.id === t.ownerId)?.name ?? null,
      memberCount: db.teamMembers.filter((m) => m.teamId === t.id).length,
      conversations: db.conversations.filter((c) => c.teamId === t.id).length,
      projects: db.projects.filter((x) => x.teamId === t.id).length,
      hosts: db.hosts.filter((h) => h.teamId === t.id).length,
      storageUsedGb: 0,
      creditsSpent: Math.abs(ledger.filter((r) => r.delta < 0).reduce((a, r) => a + r.delta, 0)),
      paidCents: orders.filter((o) => o.status === 'paid').reduce((a, o) => a + o.amountCents, 0),
      tickets: db.tickets.filter((x) => x.teamId === t.id).length,
      createdAt: t.createdAt,
    },
    subscription: subscriptionShape(s),
    balance: t.creditBalance ?? 0,
  };
}

async function adminGetTeamMembers(p, ctx) {
  adminOnly(ctx);
  const rows = db$().teamMembers.filter((m) => m.teamId === req(p, 'teamId')).map(teamMember);
  return listOut('members', rows, rows.length, p);
}

async function adminGetTeamHosts(p, ctx) {
  adminOnly(ctx);
  const rows = db$().hosts.filter((h) => h.teamId === req(p, 'teamId')).map(hostShape);
  return listOut('hosts', rows, rows.length, p);
}

async function adminGetTeamOrders(p, ctx) {
  adminOnly(ctx);
  const rows = db$()
    .paymentOrders.filter((o) => o.teamId === req(p, 'teamId'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const orders = paged(rows, p, 50).map((o) => paymentOrder({ ...o, amount: o.amountCents }));
  return listOut('orders', orders, rows.length, p);
}

async function adminGetTeamLedger(p, ctx) {
  adminOnly(ctx);
  const rows = db$()
    .creditLedger.filter((r) => r.teamId === req(p, 'teamId'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const entries = paged(rows, p, 50).map(creditLedgerRow);
  return listOut('entries', entries, rows.length, p);
}

/* ================================================================== */
/* 对话                                                                */
/* ================================================================== */

async function adminGetChatConversations(p, ctx) {
  adminOnly(ctx);
  let rows = db$().conversations;
  if (p?.teamId) rows = rows.filter((c) => c.teamId === p.teamId);
  if (p?.userId) rows = rows.filter((c) => c.userId === p.userId);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((c) => (c.title ?? '').toLowerCase().includes(q) || c.id.includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.lastMessageAt ?? b.updatedAt) - Date.parse(a.lastMessageAt ?? a.updatedAt));
  const conversations = paged(rows, p).map((c) => {
    const db = db$();
    const msgs = db.messages.filter((m) => m.conversationId === c.id);
    return {
      ...conversationShape(c),
      messageCount: msgs.length,
      userName: db.users.find((u) => u.id === c.userId)?.name ?? null,
      credits: Math.round(
        msgs.reduce((a, m) => a + ((m.metadata?.usage?.inputTokens ?? 0) * 1 + (m.metadata?.usage?.outputTokens ?? 0) * 4) / 1000, 0),
      ),
    };
  });
  return listOut('conversations', conversations, rows.length, p);
}

async function adminGetConversation(p, ctx) {
  adminOnly(ctx);
  const c = db$().conversations.find((x) => x.id === req(p, 'conversationId'));
  if (!c) notFound('会话');
  return { conversation: conversationShape(c) };
}

async function adminGetConversationMessages(p, ctx) {
  adminOnly(ctx);
  const id = req(p, 'conversationId');
  const rows = db$()
    .messages.filter((m) => m.conversationId === id)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map(messageShape);
  return listOut('messages', rows, rows.length, p);
}

async function adminGetConversationCosts(p, ctx) {
  adminOnly(ctx);
  const id = req(p, 'conversationId');
  const rows = db$().messages.filter((m) => m.conversationId === id && m.metadata?.usage);
  let inputTokens = 0;
  let outputTokens = 0;
  const byModel = new Map();
  for (const m of rows) {
    const u = m.metadata.usage;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    const key = m.modelId ?? 'unknown';
    const cur = byModel.get(key) ?? { modelId: key, inputTokens: 0, outputTokens: 0, runs: 0, credits: 0 };
    cur.inputTokens += u.inputTokens ?? 0;
    cur.outputTokens += u.outputTokens ?? 0;
    cur.runs += 1;
    cur.credits += Math.round(((u.inputTokens ?? 0) * 1 + (u.outputTokens ?? 0) * 4) / 1000);
    byModel.set(key, cur);
  }
  const credits = [...byModel.values()].reduce((a, x) => a + x.credits, 0);
  return {
    costs: {
      conversationId: id,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      credits,
      runs: rows.length,
      byModel: [...byModel.values()],
      byMessage: rows.map((m) => ({
        messageId: m.id,
        modelId: m.modelId,
        createdAt: m.createdAt,
        inputTokens: m.metadata.usage.inputTokens ?? 0,
        outputTokens: m.metadata.usage.outputTokens ?? 0,
        credits: Math.round(((m.metadata.usage.inputTokens ?? 0) * 1 + (m.metadata.usage.outputTokens ?? 0) * 4) / 1000),
      })),
    },
  };
}

async function adminGetConversationFiles(p, ctx) {
  adminOnly(ctx);
  const id = req(p, 'conversationId');
  const { fileIndex } = await import('../lib/workspace.mjs');
  return fileIndex(id);
}

async function adminGetChatProjects(p, ctx) {
  adminOnly(ctx);
  let rows = db$().projects;
  if (p?.teamId) rows = rows.filter((x) => x.teamId === p.teamId);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((x) => (x.name ?? '').toLowerCase().includes(q));
  }
  const projects = paged(rows, p).map((x) => {
    const db = db$();
    return {
      id: x.id,
      teamId: x.teamId,
      name: x.name,
      kind: x.kind,
      ownerName: db.users.find((u) => u.id === x.userId)?.name ?? null,
      conversationCount: db.conversations.filter((c) => c.projectId === x.id).length,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
    };
  });
  return listOut('projects', projects, rows.length, p);
}

/* ================================================================== */
/* 支付 / 发票                                                         */
/* ================================================================== */

async function adminGetPaymentOrders(p, ctx) {
  adminOnly(ctx);
  let rows = db$().paymentOrders;
  if (p?.teamId) rows = rows.filter((o) => o.teamId === p.teamId);
  if (p?.status) rows = rows.filter((o) => o.status === p.status);
  if (p?.provider) rows = rows.filter((o) => o.provider === p.provider);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((o) => o.orderNo.toLowerCase().includes(q) || o.id.includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const orders = paged(rows, p).map((o) => ({
    ...paymentOrder({ ...o, amount: o.amountCents }),
    teamName: db$().teams.find((t) => t.id === o.teamId)?.name ?? null,
    userName: db$().users.find((u) => u.id === o.userId)?.name ?? null,
    kind: o.kind ?? 'plan',
    refundedAt: o.refundedAt ?? null,
  }));
  return listOut('orders', orders, rows.length, p);
}

async function adminSyncPaymentOrder(p, ctx) {
  adminOnly(ctx);
  const o = db$().paymentOrders.find((x) => x.id === req(p, 'orderId'));
  if (!o) notFound('订单');
  audit(ctx, 'sync_order', o.id, o.status);
  return { ok: true, order: paymentOrder({ ...o, amount: o.amountCents }) };
}

async function adminSyncPaymentRefund(p, ctx) {
  adminOnly(ctx);
  const o = db$().paymentOrders.find((x) => x.id === req(p, 'orderId'));
  if (!o) notFound('订单');
  return { ok: true, order: paymentOrder({ ...o, amount: o.amountCents }), refundSynced: !!o.refundedAt };
}

async function adminRefundPaymentOrder(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const o = db.paymentOrders.find((x) => x.id === req(p, 'orderId'));
  if (!o) notFound('订单');
  if (o.status !== 'paid') throw badRequest('只有已支付的订单可以退款', 'ORDER_NOT_PAID');
  o.status = 'refunded';
  o.refundedAt = now();
  o.refundReason = p?.reason ?? null;

  // 回收额度
  const t = db.teams.find((x) => x.id === o.teamId);
  const credits =
    o.kind === 'plan'
      ? (PLAN_MONTHLY_CREDITS[o.planId] ?? 0) * (o.months ?? 1)
      : Math.round((o.creditMilli + o.bonusMilli) / 1000);
  if (t && credits > 0) {
    t.creditBalance = Math.max(0, (t.creditBalance ?? 0) - credits);
    db.creditLedger.push({
      id: uuid(),
      teamId: t.id,
      userId: o.userId,
      delta: -credits,
      reason: 'refund',
      balanceAfter: t.creditBalance,
      note: `订单 ${o.orderNo} 退款`,
      createdAt: now(),
    });
  }
  // 套餐订单退款后降回 free
  if (o.kind === 'plan') {
    const s = db.subscriptions.find((x) => x.teamId === o.teamId);
    if (s && s.planId === o.planId) {
      s.planId = 'free';
      s.plan = 'free';
      s.status = 'cancelled';
      s.planEndAt = null;
      s.currentPeriodEnd = null;
    }
    if (t) t.plan = 'free';
  }
  audit(ctx, 'refund_order', o.id, `¥${(o.amountCents / 100).toFixed(2)}`);
  save();
  return { ok: true, order: paymentOrder({ ...o, amount: o.amountCents }), reclaimedCredits: credits };
}

async function adminGetInvoices(p, ctx) {
  adminOnly(ctx);
  let rows = db$().invoices;
  if (p?.teamId) rows = rows.filter((i) => i.teamId === p.teamId);
  if (p?.status) rows = rows.filter((i) => i.status === p.status);
  if (p?.type) rows = rows.filter((i) => i.type === p.type);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((i) => (i.title ?? '').toLowerCase().includes(q) || (i.taxNo ?? '').includes(q) || i.id.includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const invoices = paged(rows, p).map((i) => ({
    ...invoice(i),
    teamName: db$().teams.find((t) => t.id === i.teamId)?.name ?? null,
  }));
  return { ...listOut('invoices', invoices, rows.length, p), stats: invoiceStats() };
}

function invoiceStats() {
  const rows = db$().invoices;
  const sum = (f) => rows.filter(f).reduce((a, i) => a + i.amount, 0);
  return {
    total: rows.length,
    requested: rows.filter((i) => i.status === 'requested').length,
    issued: rows.filter((i) => i.status === 'issued').length,
    rejected: rows.filter((i) => i.status === 'rejected').length,
    amountRequested: sum((i) => i.status === 'requested'),
    amountIssued: sum((i) => i.status === 'issued'),
    amountRejected: sum((i) => i.status === 'rejected'),
    normal: rows.filter((i) => i.type === 'normal').length,
    vatSpecial: rows.filter((i) => i.type === 'vat_special').length,
  };
}

async function adminGetInvoiceStats(p, ctx) {
  adminOnly(ctx);
  return { stats: invoiceStats(), ...invoiceStats() };
}

async function adminIssueInvoice(p, ctx) {
  adminOnly(ctx);
  const i = db$().invoices.find((x) => x.id === req(p, 'invoiceId'));
  if (!i) notFound('发票');
  if (i.status === 'issued') throw badRequest('发票已开具', 'INVOICE_ISSUED');
  i.status = 'issued';
  i.issuedAt = now();
  i.invoiceNo = p?.invoiceNo ?? 'INV' + Date.now().toString(36).toUpperCase();
  i.fileUrl = p?.fileUrl ?? null;
  audit(ctx, 'issue_invoice', i.id, i.invoiceNo);
  save();
  return { ok: true, invoice: invoice(i) };
}

async function adminRejectInvoice(p, ctx) {
  adminOnly(ctx);
  const i = db$().invoices.find((x) => x.id === req(p, 'invoiceId'));
  if (!i) notFound('发票');
  i.status = 'rejected';
  i.rejectReason = p?.reason ?? null;
  audit(ctx, 'reject_invoice', i.id, i.rejectReason);
  save();
  return { ok: true, invoice: invoice(i) };
}

async function adminRegisterRedInvoice(p, ctx) {
  adminOnly(ctx);
  const i = db$().invoices.find((x) => x.id === req(p, 'invoiceId'));
  if (!i) notFound('发票');
  i.redInvoiceNo = p?.redInvoiceNo ?? 'RED' + Date.now().toString(36).toUpperCase();
  i.redRegisteredAt = now();
  i.status = 'rejected';
  audit(ctx, 'register_red_invoice', i.id, i.redInvoiceNo);
  save();
  return { ok: true, invoice: invoice(i), redInvoiceNo: i.redInvoiceNo };
}

/* ================================================================== */
/* 兑换码 / 邀请 / 渠道                                                 */
/* ================================================================== */

async function adminGetRedeemCodes(p, ctx) {
  adminOnly(ctx);
  let rows = db$().redeemCodes;
  if (p?.batch) rows = rows.filter((c) => c.batch === p.batch);
  if (p?.status === 'unused') rows = rows.filter((c) => !c.usedBy && !c.disabled);
  if (p?.status === 'used') rows = rows.filter((c) => !!c.usedBy);
  if (p?.status === 'disabled') rows = rows.filter((c) => !!c.disabled);
  if (p?.query) {
    const q = String(p.query).toUpperCase();
    rows = rows.filter((c) => c.code.includes(q) || (c.batch ?? '').toUpperCase().includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const codes = paged(rows, p).map(redeemCode);
  return {
    ...listOut('codes', codes, rows.length, p),
    redeemCodes: codes,
    batches: [...new Set(db$().redeemCodes.map((c) => c.batch).filter(Boolean))],
  };
}

async function adminCreateRedeemCodes(p, ctx) {
  adminOnly(ctx);
  const count = Math.max(1, Math.min(1000, Number(p?.count) || 1));
  const credits = Number(p?.credits) || 0;
  if (credits <= 0) throw badRequest('兑换额度必须大于 0', 'INVALID_AMOUNT');
  const batch = p?.batch ?? 'B' + Date.now().toString(36).toUpperCase();
  const db = db$();
  const created = [];
  for (let i = 0; i < count; i++) {
    const row = {
      id: uuid(),
      code: 'CG-' + rid(4) + '-' + rid(4) + '-' + rid(4),
      credits,
      batch,
      disabled: false,
      usedBy: null,
      usedAt: null,
      expiresAt: p?.expiresAt ?? null,
      createdAt: now(),
      createdBy: ctx.user.id,
    };
    db.redeemCodes.push(row);
    created.push(redeemCode(row));
  }
  audit(ctx, 'create_redeem_codes', batch, `${count} × ${credits}`);
  save();
  return { ok: true, batch, count: created.length, codes: created, items: created };
}

async function adminDisableRedeemCode(p, ctx) {
  adminOnly(ctx);
  const c = db$().redeemCodes.find((x) => x.id === (p?.redeemCodeId ?? p?.id) || x.code === p?.code);
  if (!c) notFound('兑换码');
  c.disabled = true;
  audit(ctx, 'disable_redeem_code', c.code, null);
  save();
  return { ok: true, code: redeemCode(c) };
}

async function adminGetInviters(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const map = new Map();
  for (const ic of db.inviteCodes) {
    const ownerId = ic.userId ?? db.teams.find((t) => t.id === ic.teamId)?.ownerId;
    if (!ownerId) continue;
    const cur = map.get(ownerId) ?? {
      userId: ownerId,
      name: db.users.find((u) => u.id === ownerId)?.name ?? null,
      phone: db.users.find((u) => u.id === ownerId)?.phone ?? null,
      codes: 0,
      used: 0,
      invitees: 0,
      rewardCredits: 0,
    };
    cur.codes += 1;
    cur.used += ic.usedCount ?? 0;
    cur.invitees += ic.usedCount ?? 0;
    cur.rewardCredits += (ic.rewardCredits ?? 0) * (ic.usedCount ?? 0);
    map.set(ownerId, cur);
  }
  const rows = [...map.values()].sort((a, b) => b.invitees - a.invitees);
  return listOut('inviters', rows, rows.length, p);
}

async function adminGetInviteCodeDetail(p, ctx) {
  adminOnly(ctx);
  const c = db$().inviteCodes.find((x) => x.id === req(p, 'inviteCodeId') || x.code === p?.code);
  if (!c) notFound('邀请码');
  return { inviteCode: inviteCode(c), detail: inviteCode(c) };
}

async function adminGetInviteCodeInvitees(p, ctx) {
  adminOnly(ctx);
  const c = db$().inviteCodes.find((x) => x.id === req(p, 'inviteCodeId') || x.code === p?.code);
  if (!c) notFound('邀请码');
  const db = db$();
  const rows = db.teamMembers
    .filter((m) => m.invitedByCode === c.code)
    .map((m) => ({
      userId: m.userId,
      name: db.users.find((u) => u.id === m.userId)?.name ?? null,
      phone: db.users.find((u) => u.id === m.userId)?.phone ?? null,
      joinedAt: m.joinedAt,
      code: c.code,
    }));
  return listOut('invitees', rows, rows.length, p);
}

async function adminGetInviteOverview(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const days = Number(p?.days) || 30;
  const since = Date.now() - days * 864e5;
  const recent = db.teamMembers.filter((m) => Date.parse(m.joinedAt) >= since && m.invitedByCode);
  const byCode = new Map();
  for (const m of recent) {
    const cur = byCode.get(m.invitedByCode) ?? { code: m.invitedByCode, count: 0 };
    cur.count += 1;
    byCode.set(m.invitedByCode, cur);
  }
  return {
    days,
    overview: {
      totalCodes: db.inviteCodes.length,
      activeCodes: db.inviteCodes.filter((c) => c.active !== false).length,
      totalInvitees: db.teamMembers.filter((m) => m.invitedByCode).length,
      newInvitees: recent.length,
      rewardCredits: db.creditLedger.filter((r) => r.reason === 'invite_reward').reduce((a, r) => a + r.delta, 0),
      conversionRate: db.inviteCodes.length ? recent.length / Math.max(1, db.inviteCodes.length) : 0,
    },
    byCode: [...byCode.values()].sort((a, b) => b.count - a.count),
    series: buildSeries(days, (dayStart, dayEnd) =>
      db.teamMembers.filter((m) => {
        const t = Date.parse(m.joinedAt);
        return t >= dayStart && t < dayEnd && m.invitedByCode;
      }).length,
    ),
  };
}

async function adminGetInviteCohorts(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const weeks = 8;
  const cohorts = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = Date.now() - (w + 1) * 7 * 864e5;
    const end = Date.now() - w * 7 * 864e5;
    const cohortUsers = db.users.filter((u) => {
      const t = Date.parse(u.createdAt);
      return t >= start && t < end;
    });
    cohorts.push({
      label: new Date(start).toISOString().slice(0, 10),
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      size: cohortUsers.length,
      invited: cohortUsers.filter((u) => db.teamMembers.some((m) => m.userId === u.id && m.invitedByCode)).length,
      active: cohortUsers.filter((u) =>
        db.conversations.some((c) => c.userId === u.id && Date.parse(c.lastMessageAt ?? c.updatedAt ?? 0) >= end - 7 * 864e5),
      ).length,
      paid: cohortUsers.filter((u) => db.paymentOrders.some((o) => o.userId === u.id && o.status === 'paid')).length,
    });
  }
  return { cohorts, items: cohorts, total: cohorts.length };
}

async function adminGetInviteRiskReport(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const rules = (await import('../lib/plans.mjs')).REFERRAL_RULES;
  const mvno = (await import('../lib/plans.mjs')).MVNO_PREFIX_RX;
  const flags = [];
  for (const u of db.users) {
    const digits = String(u.phone ?? '').replace(/^\+86/, '');
    const prefix = digits.slice(0, 3);
    const invited = db.teamMembers.filter((m) => m.userId === u.id && m.invitedByCode).length;
    const msgs = db.messages.filter(
      (m) => db.conversations.some((c) => c.id === m.conversationId && c.userId === u.id),
    ).length;
    const reasons = [];
    if (mvno.test(prefix) && rules.mvnoPrefixes.includes(prefix)) reasons.push('mvno_prefix');
    if (invited > 0 && msgs <= rules.maxMsgs) reasons.push('invited_but_inactive');
    if (reasons.length) flags.push({ userId: u.id, name: u.name, phone: u.phone, reasons, invited, messages: msgs, risk: reasons.length });
  }
  flags.sort((a, b) => b.risk - a.risk);
  return {
    rules,
    flags,
    items: flags,
    total: flags.length,
    summary: {
      mvno: flags.filter((f) => f.reasons.includes('mvno_prefix')).length,
      inactiveInvitees: flags.filter((f) => f.reasons.includes('invited_but_inactive')).length,
    },
  };
}

async function adminGetChannelReport(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const days = Number(p?.days) || 30;
  const since = Date.now() - days * 864e5;
  const channels = new Map();
  for (const u of db.users) {
    const key = u.inviteCode ? 'invite' : u.phone ? 'phone' : 'organic';
    const cur = channels.get(key) ?? { channel: key, users: 0, paid: 0, revenueCents: 0, active: 0 };
    cur.users += 1;
    if (db.paymentOrders.some((o) => o.userId === u.id && o.status === 'paid')) {
      cur.paid += 1;
      cur.revenueCents += db.paymentOrders
        .filter((o) => o.userId === u.id && o.status === 'paid')
        .reduce((a, o) => a + o.amountCents, 0);
    }
    if (db.conversations.some((c) => c.userId === u.id && Date.parse(c.lastMessageAt ?? 0) >= since)) cur.active += 1;
    channels.set(key, cur);
  }
  return {
    days,
    channels: [...channels.values()],
    items: [...channels.values()],
    total: channels.size,
  };
}

/* ================================================================== */
/* 主机（管理端）                                                      */
/* ================================================================== */

async function adminGetCloudHosts(p, ctx) {
  adminOnly(ctx);
  let rows = db$().hosts.filter((h) => h.kind === 'cloud');
  if (p?.teamId) rows = rows.filter((h) => h.teamId === p.teamId);
  if (p?.status) rows = rows.filter((h) => h.status === p.status);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((h) => h.name.toLowerCase().includes(q) || h.id.includes(q));
  }
  const hosts = paged(rows, p).map((h) => ({
    ...hostShape(h),
    teamName: db$().teams.find((t) => t.id === h.teamId)?.name ?? null,
    userName: db$().users.find((u) => u.id === h.userId)?.name ?? null,
  }));
  return listOut('hosts', hosts, rows.length, p);
}

async function adminGetHostSpec(p, ctx) {
  adminOnly(ctx);
  const h = db$().hosts.find((x) => x.id === req(p, 'hostId'));
  if (!h) notFound('主机');
  return { ...hostShape(h), spec: h.spec, host: hostShape(h) };
}

async function adminUpdateHostSpec(p, ctx) {
  adminOnly(ctx);
  const h = db$().hosts.find((x) => x.id === req(p, 'hostId'));
  if (!h) notFound('主机');
  h.spec = {
    cpu: Number(p?.cpu ?? p?.spec?.cpu ?? h.spec?.cpu ?? 2),
    memoryGb: Number(p?.memoryGb ?? p?.spec?.memoryGb ?? h.spec?.memoryGb ?? 4),
    diskGb: Number(p?.diskGb ?? p?.spec?.diskGb ?? h.spec?.diskGb ?? 50),
    gpu: p?.gpu ?? p?.spec?.gpu ?? h.spec?.gpu ?? null,
  };
  audit(ctx, 'update_host_spec', h.id, JSON.stringify(h.spec));
  save();
  return { ok: true, host: hostShape(h), spec: h.spec };
}

/* ================================================================== */
/* 审计 / 订阅 / 迁移                                                   */
/* ================================================================== */

async function adminGetAuditLogs(p, ctx) {
  adminOnly(ctx);
  let rows = db$().auditLogs;
  if (p?.action) rows = rows.filter((l) => l.action === p.action);
  if (p?.actorId) rows = rows.filter((l) => l.actorId === p.actorId);
  if (p?.query) {
    const q = String(p.query).toLowerCase();
    rows = rows.filter((l) => l.action.includes(q) || (l.target ?? '').toLowerCase().includes(q));
  }
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const logs = paged(rows, p).map((l) => ({
    id: l.id,
    actorId: l.actorId,
    actorName: l.actorName,
    action: l.action,
    target: l.target,
    detail: l.detail,
    createdAt: l.createdAt,
  }));
  return listOut('logs', logs, rows.length, p);
}

async function adminGetExpiringSubscriptions(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const withinDays = Number(p?.days) || 7;
  const limitMs = Date.now() + withinDays * 864e5;
  const rows = db.subscriptions
    .filter((s) => s.planEndAt && Date.parse(s.planEndAt) <= limitMs)
    .sort((a, b) => Date.parse(a.planEndAt) - Date.parse(b.planEndAt))
    .map((s) => ({
      ...subscriptionShape(s),
      teamName: db.teams.find((t) => t.id === s.teamId)?.name ?? null,
      ownerName: db.users.find((u) => u.id === db.teams.find((t) => t.id === s.teamId)?.ownerId)?.name ?? null,
      daysLeft: Math.floor((Date.parse(s.planEndAt) - Date.now()) / 864e5),
      expired: Date.parse(s.planEndAt) < Date.now(),
    }));
  return listOut('subscriptions', rows, rows.length, p);
}

/* ---------------- 后台文件直链 / Office 会话 ---------------- */
// 后台的会话文件浏览器与用户端共用同一套文件适配器，只是把权限从「本团队」
// 放宽到「管理员可看任意会话」。返回形状必须与用户端完全一致，否则
// AdminUserDetailDialog 会拼出 `undefined/...` 的地址。

/** 管理员可以访问任意会话；不存在则 404 */
function anyConversation(conversationId) {
  const c = db$().conversations.find((x) => x.id === conversationId);
  if (!c) notFound('会话');
  return c;
}

async function adminCreateFileLink(p, ctx) {
  adminOnly(ctx);
  const c = anyConversation(req(p, 'conversationId'));
  const rec = createFileLinkRecord(c.id, req(p, 'path'), { createdBy: ctx.user.id });
  audit(ctx, 'create_file_link', c.id, String(p?.path));
  return rec;
}

async function adminDownloadConversationFile(p, ctx) {
  adminOnly(ctx);
  const c = anyConversation(req(p, 'conversationId'));
  // 返回 __binary，分发器会转成带 content-disposition 的原始响应；
  // 前端 _e() 通道正是靠这个头判断「这是文件而不是 JSON」。
  return binaryFor(c.id, req(p, 'path'));
}

async function adminCreateOfficeSession(p, ctx) {
  adminOnly(ctx);
  const c = anyConversation(req(p, 'conversationId'));
  return officeSessionFor(c.id, req(p, 'path'), { ...(p ?? {}), user: ctx.user }, {});
}

/* ---------------- 邀请码报表 ---------------- */

/**
 * 邀请码维度的报表。
 * 前端参数（invites 页 La()）：{ q?, sort: 'invited'|'revenue'|'lastInvited', limit, offset }
 * 前端读取字段（表格列）：codeId / code / isDefault / title / ownerId / ownerName /
 *                        invited / activated / payers / revenueCnyFen / revenueUsdCents / lastInvitedAt
 */
async function adminGetInviteCodeReport(p, ctx) {
  adminOnly(ctx);
  const db = db$();
  const q = String(p?.q ?? '').trim().toLowerCase();
  const sort = String(p?.sort ?? 'invited');

  const members = db.teamMembers.filter((m) => m.invitedByCode);
  const rows = db.inviteCodes.map((ic) => {
    const owner =
      db.users.find((u) => u.id === ic.userId) ??
      db.users.find((u) => u.id === db.teams.find((t) => t.id === ic.teamId)?.ownerId);
    const invitees = members.filter((m) => m.invitedByCode === ic.code);
    const inviteeIds = new Set(invitees.map((m) => m.userId));
    const paidOrders = db.paymentOrders.filter((o) => o.userId && inviteeIds.has(o.userId) && o.status === 'paid');
    const payers = new Set(paidOrders.map((o) => o.userId)).size;
    const revenueCnyFen = paidOrders.filter((o) => (o.currency ?? 'CNY') === 'CNY').reduce((a, o) => a + o.amountCents, 0);
    const revenueUsdCents = paidOrders.filter((o) => o.currency === 'USD').reduce((a, o) => a + o.amountCents, 0);
    // 激活：被邀请人自己产生过消息（真用过产品），不只是注册
    const activated = invitees.filter((m) =>
      db.conversations.some((c) => c.userId === m.userId && db.messages.some((x) => x.conversationId === c.id)),
    ).length;
    const lastInvitedAt = invitees.map((m) => m.joinedAt).filter(Boolean).sort().at(-1) ?? null;

    return {
      codeId: ic.id,
      code: ic.code,
      isDefault: ic.name === '默认邀请码' || /DEMO/i.test(ic.code),
      title: ic.name ?? null,
      ownerId: owner?.id ?? ic.userId ?? null,
      ownerName: owner?.name ?? null,
      active: ic.active !== false,
      maxUses: ic.maxUses ?? 0,
      invited: invitees.length,
      activated,
      payers,
      revenueCnyFen,
      revenueUsdCents,
      lastInvitedAt,
      createdAt: ic.createdAt,
    };
  });

  const filtered = q
    ? rows.filter(
        (r) =>
          r.code.toLowerCase().includes(q) ||
          String(r.title ?? '').toLowerCase().includes(q) ||
          String(r.ownerName ?? '').toLowerCase().includes(q),
      )
    : rows;

  const cmp = {
    invited: (a, b) => b.invited - a.invited,
    revenue: (a, b) => b.revenueCnyFen - a.revenueCnyFen,
    lastInvited: (a, b) => String(b.lastInvitedAt ?? '').localeCompare(String(a.lastInvitedAt ?? '')),
  }[sort] ?? ((a, b) => b.invited - a.invited);

  filtered.sort(cmp);
  const page = filtered.slice(OFFSET(p), OFFSET(p) + LIMIT(p, 20));

  return {
    codes: page,
    items: page,
    total: filtered.length,
    totals: {
      invited: filtered.reduce((a, r) => a + r.invited, 0),
      activated: filtered.reduce((a, r) => a + r.activated, 0),
      payers: filtered.reduce((a, r) => a + r.payers, 0),
      revenueCnyFen: filtered.reduce((a, r) => a + r.revenueCnyFen, 0),
    },
    sort,
    limit: LIMIT(p, 20),
    offset: OFFSET(p),
  };
}

/* ---------------- 推广员（分佣） ---------------- */
// 前端契约（promoters-BHsPDXsE.js）：
//   adminGetPromoters({ limit, offset })   → { promoters, total, currency }
//   adminGetPromoterDetail({ userId })     → { promotion }，promotion 含 currency /
//                                            months[{month,base,commission}] /
//                                            settlements[{id,period,amount,note,createdAt}] / dueAmount
//   adminSettlePromoter({ userId, period, amount, note })  → 登记打款
// 分成规则：被邀请人付费的前 3 个月，按 30% 计佣（前端页头就是这么写的）。

const PROMOTER_MONTHS = 3;
const PROMOTER_RATE_BP = 3000; // 30.00%

/** 算出某个码主下、每个被邀请人每个月的分佣明细（前 3 个月） */
function commissionMonthsFor(ownerId) {
  const db = db$();
  const codes = new Set(
    db.inviteCodes.filter((ic) => (ic.userId ?? db.teams.find((t) => t.id === ic.teamId)?.ownerId) === ownerId).map((ic) => ic.code),
  );
  const inviteeIds = [
    ...new Set(db.teamMembers.filter((m) => m.invitedByCode && codes.has(m.invitedByCode)).map((m) => m.userId)),
  ];
  const months = [];
  for (const uid of inviteeIds) {
    const orders = db.paymentOrders
      .filter((o) => o.userId === uid && o.status === 'paid')
      .sort((a, b) => Date.parse(a.paidAt ?? a.createdAt) - Date.parse(b.paidAt ?? b.createdAt));
    for (const [i, o] of orders.slice(0, PROMOTER_MONTHS).entries()) {
      const at = o.paidAt ?? o.createdAt;
      months.push({
        month: String(at).slice(0, 7),
        userId: uid,
        orderNo: o.orderNo,
        base: o.amountCents,
        commission: Math.round((o.amountCents * PROMOTER_RATE_BP) / 1e4),
        index: i + 1,
      });
    }
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
  return months;
}

/** 有推广资格的码主：种子里的 promoters + 所有邀请码的归属人 */
function promoterOwnerIds() {
  const db = db$();
  const ids = new Set(db.promoters.map((x) => x.userId).filter(Boolean));
  for (const ic of db.inviteCodes) {
    const ownerId = ic.userId ?? db.teams.find((t) => t.id === ic.teamId)?.ownerId;
    if (ownerId) ids.add(ownerId);
  }
  return [...ids];
}

function promoterRow(ownerId) {
  const db = db$();
  const u = db.users.find((x) => x.id === ownerId);
  const months = commissionMonthsFor(ownerId);
  const settled = db.promoterSettlements.filter((s) => s.userId === ownerId);
  const settledAmount = settled.reduce((a, s) => a + (s.amount ?? 0), 0);
  const current = months.filter((m) => m.month >= new Date().toISOString().slice(0, 7)).reduce((a, m) => a + m.commission, 0);
  const total = months.reduce((a, m) => a + m.commission, 0);
  const since = db.teamMembers
    .filter((m) => m.userId === ownerId)
    .map((m) => m.joinedAt)
    .sort()[0] ?? u?.createdAt ?? null;
  return {
    userId: ownerId,
    displayName: u?.name ?? null,
    name: u?.name ?? null,
    phoneNumber: u?.phone ?? null,
    avatarUrl: u?.avatarUrl ?? null,
    since,
    invitees: months.length ? new Set(months.map((m) => m.userId)).size : 0,
    settleableCommission: Math.max(0, total - settledAmount),
    currentCommission: current,
    settledAmount,
    dueAmount: Math.max(0, total - settledAmount),
    monthsCount: PROMOTER_MONTHS,
    rateBp: PROMOTER_RATE_BP,
    currency: 'cny',
  };
}

async function adminGetPromoters(p, ctx) {
  adminOnly(ctx);
  const all = promoterOwnerIds().map(promoterRow).sort((a, b) => b.dueAmount - a.dueAmount);
  const rows = all.slice(OFFSET(p), OFFSET(p) + LIMIT(p, 50));
  return { promoters: rows, items: rows, total: all.length, currency: 'cny', rateBp: PROMOTER_RATE_BP, months: PROMOTER_MONTHS };
}

async function adminGetPromoterDetail(p, ctx) {
  adminOnly(ctx);
  const userId = req(p, 'userId');
  const u = db$().users.find((x) => x.id === userId);
  if (!u) notFound('用户');

  const months = commissionMonthsFor(userId);
  const settlements = db$().promoterSettlements
    .filter((s) => s.userId === userId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const settledAmount = settlements.reduce((a, s) => a + (s.amount ?? 0), 0);
  const total = months.reduce((a, m) => a + m.commission, 0);

  // 按月聚合给前端列表用（前端直接列 n.months，逐条渲染 month/base/commission）
  const byMonth = new Map();
  for (const m of months) {
    const cur = byMonth.get(m.month) ?? { month: m.month, base: 0, commission: 0, count: 0 };
    cur.base += m.base;
    cur.commission += m.commission;
    cur.count += 1;
    byMonth.set(m.month, cur);
  }

  return {
    promotion: {
      userId,
      displayName: u.name,
      dueAmount: Math.max(0, total - settledAmount),
      settledAmount,
      currency: 'cny',
      rateBp: PROMOTER_RATE_BP,
      monthsCount: PROMOTER_MONTHS,
      months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
      settlements: settlements.map((s) => ({
        id: s.id,
        period: s.period,
        amount: s.amount,
        note: s.note ?? '',
        createdAt: s.createdAt,
      })),
    },
  };
}

async function adminSettlePromoter(p, ctx) {
  adminOnly(ctx);
  const userId = req(p, 'userId');
  const amount = Math.round(Number(req(p, 'amount')));
  if (!Number.isFinite(amount) || amount < 1) badRequest('打款金额必须大于 0');
  const u = db$().users.find((x) => x.id === userId);
  if (!u) notFound('用户');

  const row = {
    id: uuid(),
    userId,
    period: String(p?.period ?? new Date().toISOString().slice(0, 7)),
    amount,
    currency: 'cny',
    note: String(p?.note ?? '').slice(0, 200),
    actorId: ctx.user.id,
    createdAt: now(),
  };
  db$().promoterSettlements.push(row);
  // 同步维护 seed 里的 promoters 汇总行，避免两处数据打架
  const agg = db$().promoters.find((x) => x.userId === userId);
  if (agg) {
    agg.settledAmount = (agg.settledAmount ?? 0) + amount;
    agg.unsettledAmount = Math.max(0, (agg.unsettledAmount ?? 0) - amount / 100);
  }
  audit(ctx, 'settle_promoter', userId, `${(amount / 100).toFixed(2)} 元 · ${row.period}`);
  save();
  return { ok: true, settlement: row, promoter: promoterRow(userId) };
}

/* ---------------- 数据迁移 ---------------- */

const MIGRATIONS = [];

async function adminGetMigrationStatus(p, ctx) {
  adminOnly(ctx);
  const running = MIGRATIONS.find((m) => m.running) ?? null;
  // 没有正在跑的作业时，status 要回落到**最近一次**作业的最终状态，
  // 而不是一个合成的空壳：后台页面靠 done/total 画进度条、靠 reportFile 拉报告，
  // 空壳会让「刚刚跑完的迁移」在页面上显示成 0/0 且没有报告可看。
  const last = MIGRATIONS[MIGRATIONS.length - 1] ?? null;
  return {
    status: running ?? last ?? {
      running: false,
      progress: 0,
      total: 0,
      done: 0,
      mode: null,
      startedAt: null,
      finishedAt: null,
      reportFile: null,
      steps: [],
    },
    history: MIGRATIONS.slice(-20),
  };
}

async function adminRunMigration(p, ctx) {
  adminOnly(ctx);
  const mode = p?.mode === 'apply' ? 'apply' : 'dry-run';
  // 迁移是单例作业：启动新的之前必须把上一个标记为结束，
  // 否则 find(m => m.running) 会一直命中那个「僵尸作业」，
  // 状态轮询永远停在旧的进度上。
  for (const m of MIGRATIONS) {
    if (m.running) {
      m.running = false;
      m.supersededBy = 'new-run';
      m.finishedAt = m.finishedAt ?? now();
    }
  }
  const job = {
    id: 'mig-' + new Date().toISOString().replace(/[:.]/g, '-'),
    mode,
    running: true,
    progress: 0,
    total: 4,
    done: 0,
    startedAt: now(),
    startedBy: ctx.user.id,
    steps: [],
  };
  MIGRATIONS.push(job);

  const steps = [
    { name: 'index.rebuild', apply: () => '重建搜索索引完成' },
    { name: 'ledger.reconcile', apply: () => `核对 ${db$().creditLedger.length} 条额度流水` },
    { name: 'storage.compact', apply: () => '压缩工作区归档' },
    { name: 'stats.snapshot', apply: () => `快照 ${db$().users.length} 名用户统计` },
  ];

  const cursor = (async () => {
    for (const [i, step] of steps.entries()) {
      await new Promise((r) => setTimeout(r, 350));
      job.steps.push({ name: step.name, mode, ok: true, detail: step.apply(), at: now() });
      job.done = i + 1;
      job.progress = job.done / job.total;
    }
    job.running = false;
    job.progress = 1;
    job.finishedAt = now();
    job.reportFile = `${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}Z-${mode}.json`;
    audit(ctx, 'run_migration', job.id, `${mode} 完成`);
    save();
  })();
  if (cursor.catch) cursor.catch(() => {});

  return { ok: true, status: job };
}

async function adminStopMigration(p, ctx) {
  adminOnly(ctx);
  const job = MIGRATIONS.find((m) => m.running);
  if (!job) return { ok: true, stopped: false };
  job.running = false;
  job.stoppedAt = now();
  job.progress = job.done / job.total;
  audit(ctx, 'stop_migration', job.id, null);
  save();
  return { ok: true, stopped: true, status: job };
}

async function adminGetMigrationReport(p, ctx) {
  adminOnly(ctx);
  const file = req(p, 'file');
  const job = MIGRATIONS.find((m) => m.reportFile === file) ?? MIGRATIONS[MIGRATIONS.length - 1] ?? null;
  if (!job) notFound('迁移报告');
  return {
    file,
    report: {
      id: job.id,
      mode: job.mode,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      steps: job.steps,
      totals: {
        users: db$().users.length,
        teams: db$().teams.length,
        conversations: db$().conversations.length,
        messages: db$().messages.length,
        ledgerRows: db$().creditLedger.length,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 抽样辅助                                                            */
/* ------------------------------------------------------------------ */

/** 按天生成时间序列（用于增长类报表） */
function buildSeries(days, countAt) {
  const out = [];
  const DAY = 864e5;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today.getTime() - i * DAY;
    out.push({ date: new Date(dayStart).toISOString().slice(0, 10), value: countAt(dayStart, dayStart + DAY) });
  }
  return out;
}


/* ------------------------------------------------------------------ */
/* 线上新版后台：工单删除 / 消息撤回 / 参与度与收入报表 / 角色           */
/* ------------------------------------------------------------------ */


async function adminCloseTicket(p, ctx) {
  adminOnly(ctx);
  const t = db$().tickets.find((x) => x.id === req(p, 'id'));
  if (!t) notFound('工单');
  t.status = 'closed';
  t.closedAt = now();
  t.updatedAt = t.closedAt;
  save();
  return { ok: true, id: t.id, status: t.status };
}

async function adminGetAnnouncements(p, ctx) {
  adminOnly(ctx);
  let rows = db$().announcements ?? [];
  rows = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const items = paged(rows, p).map(announcement);
  return { announcements: items, items, total: rows.length, limit: LIMIT(p), offset: OFFSET(p) };
}

async function adminDeleteTicket(p, ctx) {
  const t = db$().tickets.find((x) => x.id === req(p, 'id'));
  if (!t) notFound('工单');
  t.status = 'deleted';
  t.deletedAt = now();
  t.updatedAt = t.deletedAt;
  save();
  return { ok: true, id: t.id, status: t.status };
}

/** 撤回：保留条目但抹掉正文，前端靠 recalled 标记渲染「已撤回」 */
async function adminRecallTicketMessage(p, ctx) {
  const db = db$();
  const m = db.ticketMessages.find((x) => x.id === req(p, 'messageId') ?? x.id === req(p, 'id'));
  const msg = db.ticketMessages.find(
    (x) => x.id === (p?.messageId ?? p?.id) || x.id === p?.id,
  );
  const row = msg ?? m;
  if (!row) notFound('工单消息');
  row.recalledAt = now();
  row.recalledBy = ctx.user.id;
  row.body = '';
  row.attachments = [];
  save();
  return { ok: true, id: row.id, recalledAt: row.recalledAt };
}

/** 参与度报表。前端 engagement-*.js 用 {items:[{key,total,value}], total} 渲染条形榜。 */
async function adminGetEngagementReport(p, ctx) {
  const db = db$();
  const days = Math.max(1, Math.min(180, Number(p?.days ?? 30)));
  const since = Date.now() - days * 864e5;
  const convs = db.conversations.filter((c) => Date.parse(c.createdAt) >= since);
  const users = db.users.filter((u) => Date.parse(u.createdAt) >= since);
  const active = new Set(convs.map((c) => c.userId).filter(Boolean));

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, value: 0 }));
  for (const c of convs) {
    const h = new Date(Date.parse(c.createdAt)).getHours();
    byHour[h].value += 1;
  }
  const items = [
    { key: 'conversations', label: '任务数', total: convs.length, value: convs.length },
    { key: 'activeUsers', label: '活跃用户', total: active.size, value: active.size },
    { key: 'newUsers', label: '新增用户', total: users.length, value: users.length },
    { key: 'messages', label: '消息数', total: db.messages.filter((m) => Date.parse(m.createdAt) >= since).length, value: 0 },
  ];
  for (const it of items) it.value = it.total;
  return {
    days,
    timeZone: p?.timeZone ?? null,
    total: convs.length,
    items,
    byHour,
    bySegment: [
      { key: 'research', label: '科研', value: Math.round(convs.length * 0.4) },
      { key: 'engineering', label: '工程', value: Math.round(convs.length * 0.25) },
      { key: 'data', label: '数据', value: Math.round(convs.length * 0.2) },
      { key: 'student', label: '学生', value: Math.round(convs.length * 0.1) },
      { key: 'professional', label: '职场', value: Math.round(convs.length * 0.05) },
    ],
    generatedAt: now(),
  };
}

/** 收入报表。前端 revenue-*.js 用 {items:[{key,value}], total} 渲染。 */
async function adminGetRevenueReport(p, ctx) {
  const db = db$();
  const days = Math.max(1, Math.min(180, Number(p?.days ?? 30)));
  const since = Date.now() - days * 864e5;
  const paid = db.paymentOrders.filter((o) => o.status === 'paid' && Date.parse(o.paidAt ?? o.createdAt) >= since);
  const cents = paid.reduce((a, o) => a + (o.amountCents ?? o.amount ?? 0), 0);

  const byPlan = {};
  for (const o of paid) {
    const k = o.planId ?? o.kind ?? 'topup';
    byPlan[k] = (byPlan[k] ?? 0) + (o.amountCents ?? o.amount ?? 0);
  }
  const items = Object.entries(byPlan)
    .map(([key, value]) => ({ key, value, amountCents: value }))
    .sort((a, b) => b.value - a.value);

  const topups = paid.filter((o) => o.kind === 'topup').length;
  const plans = paid.filter((o) => o.kind === 'plan').length;
  const refunded = db.paymentOrders.filter((o) => o.refundedAt).length;

  return {
    days,
    timeZone: p?.timeZone ?? null,
    total: cents,
    totalCents: cents,
    currency: 'CNY',
    items,
    plans,
    topups,
    refunded,
    orders: paid.length,
    generatedAt: now(),
  };
}

async function updateUserRoles(p, ctx) {
  const u = db$().users.find((x) => x.id === req(p, 'userId'));
  if (!u) notFound('用户');
  const roles = Array.isArray(p?.roles) ? p.roles : p?.roles ? [p.roles] : [];
  u.roles = roles;
  if (roles.includes('admin') || roles.includes('super_admin')) u.role = 'super_admin';
  else if (roles.length) u.role = roles[0];
  u.updatedAt = now();
  save();
  return { ok: true, userId: u.id, roles: u.roles, role: u.role };
}

export const commands = {
  adminGetUsers,
  adminGetUserDetail,
  adminGetUserTeams,
  adminGetUserHosts,
  adminGetUserOrders,
  adminGetUserLedger,
  adminGetUserInvites,
  setUserRole,
  banUser,
  unbanUser,
  adminTopupCredits,
  adminGrantPlan,
  adminGetTeams,
  adminGetTeamDetail,
  adminGetTeamMembers,
  adminGetTeamHosts,
  adminGetTeamOrders,
  adminGetTeamLedger,
  adminGetChatConversations,
  adminGetConversation,
  adminGetConversationMessages,
  adminGetConversationCosts,
  adminGetConversationFiles,
  adminGetChatProjects,
  adminGetPaymentOrders,
  adminSyncPaymentOrder,
  adminSyncPaymentRefund,
  adminRefundPaymentOrder,
  adminGetInvoices,
  adminGetInvoiceStats,
  adminIssueInvoice,
  adminRejectInvoice,
  adminRegisterRedInvoice,
  adminGetRedeemCodes,
  adminCreateRedeemCodes,
  adminDisableRedeemCode,
  adminGetInviters,
  adminGetInviteCodeDetail,
  adminGetInviteCodeReport,
  adminGetPromoters,
  adminGetPromoterDetail,
  adminSettlePromoter,
  adminCreateFileLink,
  adminDownloadConversationFile,
  adminCreateOfficeSession,
  adminGetInviteCodeInvitees,
  adminGetInviteOverview,
  adminGetInviteCohorts,
  adminGetInviteRiskReport,
  adminGetChannelReport,
  adminGetCloudHosts,
  adminGetHostSpec,
  adminUpdateHostSpec,
  adminGetAuditLogs,
  adminGetExpiringSubscriptions,
  adminGetMigrationStatus,
  adminRunMigration,
  adminStopMigration,
  adminGetMigrationReport,
  // 供后台直接复用的只读项
  adminGetPlans: async () => ({ plans: allPlanSpecs(), topupTiers: TOPUP_TIERS }),
  adminDeleteTicket,
  adminCloseTicket,
  adminGetAnnouncements,
  adminRecallTicketMessage,
  adminGetEngagementReport,
  adminGetRevenueReport,
  updateUserRoles,
};

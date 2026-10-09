// /api/cards —— 卡包（赠送卡 / 升级卡）。
//
// 契约全部来自新构建 bundle 的调用点（app/assets，入口 index-QbJOivX-.js）：
//
//   billing-Bitt_SRn.js
//     var Y = { upgrade_20261001: { type: 'week', validDays: 30 } }
//     Le = ['active','used','expired','voided']
//     Re = e => e.usedAt ? 'used' : e.voidedAt ? 'voided'
//              : new Date(e.expiresAt).getTime() <= Date.now() ? 'expired' : 'active'
//   → 卡状态是**派生值**，不是存的字段；expiresAt 一定存在。
//
//   onboardingPreviewStore-Xo7GLpbE.js
//     getCards({})                       → { cards: [...] }
//     claimCard(e)                       → { card, claimed }
//     applyCard(e)  onSuccess 只失效 subscription + creditLedger
//   → applyCard 要真正改额度/订阅，否则前端刷新后看不到任何变化。
//
//   AdminUserDetailDialog-Cj635dgN.js
//     adminGetCards({userId?, limit, offset}) → { cards: [...] }
//     adminGetCardReport({})                  → 报表
//     adminSearchCardRecipients({identifiers})→ { users, missing }
//     adminIssueCards({userIds, type, validDays, note}) → { cards: [...] }
//     adminVoidCard({cardId})                 → 作废
//
//   ChatTeamUsage-oaaeLxEz.js
//     e.kind === 'card' ? w(n.cardType) : ...
//   → 用卡要写一条 kind='card' 的 creditLedger，带 cardType。
import { db$, uuid, now, save, paginate } from '../lib/db.mjs';
import { req, need, notFound, badRequest, conflict } from '../lib/errors.mjs';
import { UNIT, PLAN_MONTHLY_CREDITS } from '../lib/plans.mjs';
import { personalTeamFor } from '../lib/shapes.mjs';

/** 卡的来源/类型：type 决定「用掉时给什么」。 */
export const CARD_TYPES = {
  // 一周体验：把团队套餐临时升到 pro，并给一周的额度
  week: { planId: 'pro', days: 7, label: '周卡' },
  // 额度卡：直接充额度（credits 单位 = 积分，不是 milli）
  credit: { planId: null, days: 0, label: '额度卡' },
};

const CARD_STATUSES = ['active', 'used', 'expired', 'voided'];

function cardStatus(row, at = Date.now()) {
  if (row.voidedAt) return 'voided';
  if (row.usedAt) return 'used';
  if (row.expiresAt && Date.parse(row.expiresAt) <= at) return 'expired';
  return 'active';
}

/** 卡对外形状。status 是派生的，claimable 让前端决定能不能点「领取」。 */
export function card(row) {
  if (!row) return null;
  const status = cardStatus(row);
  return {
    id: row.id,
    code: row.code ?? null,
    userId: row.userId ?? null,
    teamId: row.teamId ?? null,
    source: row.source ?? null,
    type: row.type ?? 'week',
    cardType: row.type ?? 'week', // ChatTeamUsage 读的是 ledger 上的 cardType
    validDays: row.validDays ?? 30,
    status,
    // 未领取也能用；前端 claimCard 后只是把 claimed=true
    claimed: !!row.claimedAt,
    claimedAt: row.claimedAt ?? null,
    usedAt: row.usedAt ?? null,
    voidedAt: row.voidedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    note: row.note ?? null,
    issuedBy: row.issuedBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

function mineCards(ctx) {
  const db = db$();
  const team = personalTeamFor(ctx.user.id);
  return db.cards.filter((c) => c.userId === ctx.user.id || (team && c.teamId === team.id));
}

function findCard(idOrCode) {
  const db = db$();
  return (
    db.cards.find((c) => c.id === idOrCode) ??
    db.cards.find((c) => c.code && c.code.toLowerCase() === String(idOrCode).toLowerCase())
  );
}

function ownCard(idOrCode, ctx) {
  const row = findCard(idOrCode);
  if (!row) notFound('卡');
  const team = personalTeamFor(ctx.user.id);
  need(
    row.userId === ctx.user.id || (team && row.teamId === team.id) || ctx.user.role === 'super_admin',
    'FORBIDDEN',
    '无权访问该卡',
    403,
  );
  return row;
}

function cardCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (i < 3) s += '-';
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 用户侧                                                              */
/* ------------------------------------------------------------------ */

async function getCards(p, ctx) {
  const db = db$();
  // 演示数据：新用户进来卡包是空的，前端的「升级礼 / 领取卡」流程就没东西可领。
  // 这里在**首次查询时**补一张可领的周卡，之后的领取 / 使用就是真实状态流转。
  if (!db.cards.some((c) => c.userId === ctx.user.id)) {
    const team = personalTeamFor(ctx.user.id);
    db.cards.push({
      id: uuid(),
      code: cardCode(),
      userId: ctx.user.id,
      teamId: team?.id ?? null,
      source: 'upgrade_20261001',
      type: 'week',
      validDays: 30,
      note: '新用户升级礼',
      issuedBy: null,
      claimedAt: null,
      usedAt: null,
      voidedAt: null,
      expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
      createdAt: now(),
      updatedAt: now(),
    });
    save();
  }
  const rows = mineCards(ctx).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const limit = Number(p?.limit ?? 0);
  const offset = Number(p?.offset ?? 0);
  const page = limit ? paginate(rows, { limit, offset }) : rows;
  return { cards: page.map(card), total: rows.length };
}

/**
 * 领卡。语义是**幂等**的：已经领过就返回 claimed=false，不报错。
 * 前端 onSuccess 靠 `claimed` 决定弹「领取成功」还是「你已经领过了」。
 */
async function claimCard(p, ctx) {
  const row = ownCard(req(p, 'cardId') ?? req(p, 'id') ?? req(p, 'code'), ctx);
  const status = cardStatus(row);
  need(status !== 'voided', 'CONFLICT', '卡已作废', 409);
  need(status !== 'expired', 'CONFLICT', '卡已过期', 409);

  const already = !!row.claimedAt;
  if (!already) {
    row.claimedAt = now();
    row.updatedAt = row.claimedAt;
  }
  save();
  return { card: card(row), claimed: !already };
}

/**
 * 用卡：把权益真正落到团队上。
 *   week   → 团队套餐升到 pro，并按 PLAN_MONTHLY_CREDITS 折算 validDays 天额度
 *   其他   → 按 row.credits 充额度
 * 两种情况都写一条 kind='card' 的流水，前端 ChatTeamUsage 靠 cardType 显示名称。
 */
async function applyCard(p, ctx) {
  const row = ownCard(req(p, 'cardId') ?? req(p, 'id') ?? req(p, 'code'), ctx);
  const status = cardStatus(row);
  need(status !== 'voided', 'CONFLICT', '卡已作废', 409);
  need(status !== 'expired', 'CONFLICT', '卡已过期', 409);
  need(!row.usedAt, 'CONFLICT', '卡已使用', 409);

  const db = db$();
  const team = db.teams.find((t) => t.id === row.teamId) ?? personalTeamFor(row.userId ?? ctx.user.id);
  if (!team) notFound('团队');

  const spec = CARD_TYPES[row.type] ?? CARD_TYPES.week;
  const days = row.validDays ?? spec.days ?? 7;

  // 1) 套餐升级：只在 rank 更高时生效，绝不降档
  let planId = team.plan ?? 'free';
  if (spec.planId) {
    const rank = { free: 0, plus: 1, pro: 2, ultra: 3, team: 4, enterprise: 5 };
    if ((rank[spec.planId] ?? 0) > (rank[planId] ?? 0)) planId = spec.planId;
    team.plan = planId;
    const sub = db.subscriptions.find((s) => s.teamId === team.id);
    if (sub) {
      sub.planId = planId;
      sub.plan = planId;
      sub.planEndAt = new Date(Date.now() + days * 864e5).toISOString();
      sub.currentPeriodEnd = sub.planEndAt;
      sub.updatedAt = now();
    } else {
      db.subscriptions.push({
        id: uuid(),
        teamId: team.id,
        planId,
        plan: planId,
        status: 'active',
        seats: 1,
        priceMonthly: 0,
        currency: 'CNY',
        cycleStartAt: now(),
        currentPeriodEnd: new Date(Date.now() + days * 864e5).toISOString(),
        planEndAt: new Date(Date.now() + days * 864e5).toISOString(),
        createdAt: now(),
      });
    }
  }

  // 2) 额度到账：按天折算月额度
  const monthly = PLAN_MONTHLY_CREDITS[planId] ?? 0;
  const grantMilli = Math.round((monthly * days) / 30) || UNIT * 100;
  team.creditBalance = (team.creditBalance ?? 0) + grantMilli;

  db.creditLedger.push({
    id: uuid(),
    teamId: team.id,
    userId: row.userId ?? ctx.user.id,
    delta: grantMilli,
    reason: 'card',
    kind: 'card',
    cardType: row.type ?? 'week',
    cardId: row.id,
    balanceAfter: team.creditBalance,
    note: row.note ?? `卡 ${row.source ?? row.type} 到账`,
    createdAt: now(),
  });

  row.usedAt = now();
  row.claimedAt = row.claimedAt ?? row.usedAt;
  row.updatedAt = row.usedAt;
  save();

  return {
    card: card(row),
    applied: true,
    planId,
    grantedMilli: grantMilli,
    balance: team.creditBalance,
  };
}

/* ------------------------------------------------------------------ */
/* 管理侧                                                              */
/* ------------------------------------------------------------------ */

function isAdmin(ctx) {
  return ctx.user.role === 'super_admin' || ctx.user.role === 'admin';
}

function adminGuard(ctx) {
  need(isAdmin(ctx), 'FORBIDDEN', '需要管理员权限', 403);
}

async function adminGetCards(p, ctx) {
  adminGuard(ctx);
  const db = db$();
  let rows = db.cards.slice();
  if (p?.userId) rows = rows.filter((c) => c.userId === p.userId);
  if (p?.teamId) rows = rows.filter((c) => c.teamId === p.teamId);
  if (p?.status && CARD_STATUSES.includes(p.status)) {
    rows = rows.filter((c) => cardStatus(c) === p.status);
  }
  if (p?.type) rows = rows.filter((c) => c.type === p.type);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const page = paginate(rows, { limit: p?.limit ?? 50, offset: p?.offset ?? 0 });
  return { cards: page.map(card), total: rows.length, limit: Number(p?.limit ?? 50), offset: Number(p?.offset ?? 0) };
}

async function adminGetCardReport(p, ctx) {
  adminGuard(ctx);
  const db = db$();
  const all = db.cards;
  const byStatus = {};
  const byType = {};
  for (const s of CARD_STATUSES) byStatus[s] = 0;
  for (const c of all) {
    byStatus[cardStatus(c)] = (byStatus[cardStatus(c)] ?? 0) + 1;
    byType[c.type ?? 'week'] = (byType[c.type ?? 'week'] ?? 0) + 1;
  }
  const weekAgo = Date.now() - 7 * 864e5;
  const monthAgo = Date.now() - 30 * 864e5;
  return {
    total: all.length,
    byStatus,
    byType,
    issued7d: all.filter((c) => Date.parse(c.createdAt) >= weekAgo).length,
    issued30d: all.filter((c) => Date.parse(c.createdAt) >= monthAgo).length,
    used30d: all.filter((c) => c.usedAt && Date.parse(c.usedAt) >= monthAgo).length,
    expiringSoon: all.filter((c) => {
      if (c.usedAt || c.voidedAt || !c.expiresAt) return false;
      const t = Date.parse(c.expiresAt);
      return t > Date.now() && t <= Date.now() + 7 * 864e5;
    }).length,
    generatedAt: now(),
  };
}

/**
 * 按手机号 / 邮箱 / 用户 id 批量找收卡人。
 * 前端拿到后渲染 `users`，并把 `missing` 用 Intl.ListFormat 列出来提示。
 */
async function adminSearchCardRecipients(p, ctx) {
  adminGuard(ctx);
  const db = db$();
  const identifiers = Array.isArray(p?.identifiers) ? p.identifiers : [];
  need(identifiers.length > 0, 'BAD_REQUEST', '缺少参数 identifiers');
  const users = [];
  const missing = [];
  const seen = new Set();
  for (const raw of identifiers) {
    const key = String(raw ?? '').trim();
    if (!key) continue;
    const u = db.users.find(
      (x) => x.id === key || x.phone === key || (x.email && x.email.toLowerCase() === key.toLowerCase()),
    );
    if (!u) {
      missing.push(key);
      continue;
    }
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    users.push({
      id: u.id,
      userId: u.id,
      displayName: u.name ?? null,
      phone: u.phone ?? null,
      email: u.email ?? null,
      plan: u.plan ?? 'free',
    });
  }
  return { users, missing };
}

async function adminIssueCards(p, ctx) {
  adminGuard(ctx);
  const db = db$();
  const userIds = Array.isArray(p?.userIds) ? p.userIds : [];
  need(userIds.length > 0, 'BAD_REQUEST', '缺少参数 userIds');
  const type = p?.type ?? 'week';
  need(!!CARD_TYPES[type], 'BAD_REQUEST', `未知卡类型 ${type}`);
  const validDays = Number(p?.validDays ?? CARD_TYPES[type].days ?? 30);
  need(Number.isInteger(validDays) && validDays >= 1 && validDays <= 365, 'BAD_REQUEST', 'validDays 需在 1..365');

  const created = [];
  for (const uid of userIds) {
    const u = db.users.find((x) => x.id === uid);
    if (!u) continue;
    const team = personalTeamFor(uid);
    const row = {
      id: uuid(),
      code: cardCode(),
      userId: u.id,
      teamId: team?.id ?? null,
      source: p?.source ?? null,
      type,
      validDays,
      note: p?.note ?? null,
      issuedBy: ctx.user.id,
      claimedAt: null,
      usedAt: null,
      voidedAt: null,
      expiresAt: new Date(Date.now() + validDays * 864e5).toISOString(),
      createdAt: now(),
      updatedAt: now(),
    };
    db.cards.push(row);
    created.push(row);
    db.auditLogs.push({
      id: uuid(),
      actorId: ctx.user.id,
      action: 'adminIssueCards',
      targetId: u.id,
      detail: `发卡 ${type} ×${validDays}天`,
      createdAt: now(),
    });
  }
  save();
  return { cards: created.map(card), count: created.length };
}

async function adminVoidCard(p, ctx) {
  adminGuard(ctx);
  const row = findCard(req(p, 'cardId') ?? req(p, 'id'));
  if (!row) notFound('卡');
  need(!row.voidedAt, 'CONFLICT', '卡已作废', 409);
  row.voidedAt = now();
  row.updatedAt = row.voidedAt;
  db$().auditLogs.push({
    id: uuid(),
    actorId: ctx.user.id,
    action: 'adminVoidCard',
    targetId: row.id,
    detail: `作废卡 ${row.code ?? row.id}`,
    createdAt: now(),
  });
  save();
  return { card: card(row), voided: true };
}

export const commands = {
  getCards,
  claimCard,
  applyCard,
  adminGetCards,
  adminGetCardReport,
  adminSearchCardRecipients,
  adminIssueCards,
  adminVoidCard,
};

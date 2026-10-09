// /api/billing —— 订阅、订单、发票、额度流水、邀请码、兑换码。
//
// 契约来源：app/assets/billing-D3pmhdeW.js（域模型，已 1:1 还原到 lib/plans.mjs）
//           + _shell-CSlH67JO.js 结账弹窗（createPaymentOrder / syncPaymentOrder）。
//
// createPaymentOrder 入参（还原自结账弹窗提交处）：
//   {teamId, provider, kind:'plan'|'topup', planId?, months?, priceCents?, returnOrigin?}
// 出参 `{order}`，order.payUrl 会被渲染成二维码；stripe 分支直接
//   window.location.href = order.payUrl。
import { db$, uuid, now, save, rid } from '../lib/db.mjs';
import { invoice, paymentOrder, subscription, inviteCode, redeemCode } from '../lib/shapes.mjs';
import {
  PLANS,
  GATEWAYS,
  MONTH_OPTIONS,
  SELF_SERVE_PLANS,
  INVOICE_PLANS,
  INVOICE_STATUSES,
  INVOICE_SINCE,
  TAX_NO_RX,
  TOPUP_TIERS,
  PLAN_MONTHLY_CREDITS,
  planCycleCents,
  planMonthlyCents,
  planMonthlyMilli,
  planSpec,
  allPlanSpecs,
  creditToMilli,
  milliToCredit,
  prorationQuote,
  invoiceAvailable,
  planRank,
  isValidPlan,
} from '../lib/plans.mjs';
import { req, notFound, need, conflict, badRequest, forbidden, ApiError as ApiErrorB } from '../lib/errors.mjs';

/** 演示用支付超时后自动置为已付（前端以 1s 轮询 syncPaymentOrder 感知） */
const AUTO_PAY_MS = Number(process.env.CLAWSGO_AUTO_PAY_MS ?? 6000);

function ownTeam(teamId, ctx) {
  const t = db$().teams.find((x) => x.id === teamId);
  if (!t) notFound('团队');
  need(t.id === ctx.teamId || ctx.user.role === 'super_admin', 'FORBIDDEN', '无权访问该团队', 403);
  return t;
}

function subscriptionFor(teamId) {
  const db = db$();
  let s = db.subscriptions.find((x) => x.teamId === teamId);
  if (!s) {
    s = {
      id: uuid(),
      teamId,
      plan: 'free',
      planId: 'free',
      status: 'active',
      seats: 1,
      priceMonthly: 0,
      currency: 'CNY',
      cycleStartAt: now(),
      currentPeriodEnd: null,
      planEndAt: null,
      createdAt: now(),
    };
    db.subscriptions.push(s);
    save();
  }
  return s;
}

function normalizePlanId(s) {
  if (!s) return 'free';
  return isValidPlan(s.planId) ? s.planId : isValidPlan(s.plan) ? s.plan : 'free';
}

function grantPlan(teamId, planId, months, note = 'plan_purchase') {
  const db = db$();
  const t = db.teams.find((x) => x.id === teamId);
  const s = subscriptionFor(teamId);
  const start = now();
  const cycleMs = 2592e6 * (Number(months) || 1);

  s.plan = planId;
  s.planId = planId;
  s.status = 'active';
  s.priceMonthly = planMonthlyCents(planId);
  s.cycleStartAt = Date.parse(s.planEndAt ?? '') > Date.now() ? s.cycleStartAt : start;
  s.planEndAt = new Date(Math.max(Date.now(), Date.parse(s.planEndAt ?? '') || 0) + cycleMs).toISOString();
  s.currentPeriodEnd = s.planEndAt;
  if (t) t.plan = planId;

  const monthly = PLAN_MONTHLY_CREDITS[planId] ?? 0;
  if (monthly > 0) {
    t.creditBalance = (t.creditBalance ?? 0) + monthly;
    db.creditLedger.push({
      id: uuid(),
      teamId,
      userId: t.ownerId,
      delta: monthly,
      reason: note,
      balanceAfter: t.creditBalance,
      note: `${planId} · ${months} 个月`,
      createdAt: now(),
    });
  }
  save();
  return s;
}

function grantTopup(teamId, userId, priceCents, creditMilli, bonusMilli) {
  const db = db$();
  const t = db.teams.find((x) => x.id === teamId);
  const credits = Math.round(milliToCredit(creditMilli + bonusMilli));
  t.creditBalance = (t.creditBalance ?? 0) + credits;
  db.creditLedger.push({
    id: uuid(),
    teamId,
    userId,
    delta: credits,
    reason: 'topup',
    balanceAfter: t.creditBalance,
    note: bonusMilli > 0 ? `充值 ${(priceCents / 100).toFixed(2)} 元（含赠送）` : `充值 ${(priceCents / 100).toFixed(2)} 元`,
    createdAt: now(),
  });
  save();
  return credits;
}

/* ------------------------------------------------------------------ */
/* 订阅与套餐                                                          */
/* ------------------------------------------------------------------ */

async function getSubscription(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const t = ownTeam(teamId, ctx);
  const s = subscriptionFor(teamId);
  const planId = normalizePlanId(s);
  const sub = {
    ...subscription(s),
    planId,
    plan: planId,
    planLabel: planSpec(planId).label,
    seats: db$().teamMembers.filter((m) => m.teamId === teamId).length,
    creditBalance: t.creditBalance ?? 0,
    monthlyCredits: PLAN_MONTHLY_CREDITS[planId] ?? 0,
    spec: planSpec(planId),
    canUpgrade: planRank(planId) < planRank('ultra'),
    canInvoice: INVOICE_PLANS.includes(planId),
    autoRenew: s.status === 'active' && !!s.planEndAt,
  };
  return { subscription: sub };
}

/** 套餐表（结账弹窗用；生产把这张表打进 bundle，本地复刻由服务端提供） */
async function getPlans() {
  return { plans: allPlanSpecs(), topupTiers: TOPUP_TIERS, gateways: GATEWAYS, monthOptions: MONTH_OPTIONS, selfServe: SELF_SERVE_PLANS };
}

/** 升级抵扣试算 */
async function quoteUpgrade(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  ownTeam(teamId, ctx);
  const s = subscriptionFor(teamId);
  return {
    quote: prorationQuote({
      target: { planId: req(p, 'planId'), months: Number(p?.months) || 1 },
      current: {
        planId: normalizePlanId(s),
        period: p?.period ?? 'month',
        planEndAt: s.planEndAt,
        cycleStartAt: s.cycleStartAt,
        monthlyMilli: s.monthlyMilli ?? planMonthlyMilli(normalizePlanId(s)),
      },
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 支付订单                                                            */
/* ------------------------------------------------------------------ */

function makePayUrl(order) {
  // 本地复刻没有真实支付网关，payUrl 指向同源的一张「收银台」页面（可直接被二维码渲染）
  const base = process.env.CLAWSGO_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT_APP || 5181}`;
  return `${base}/__pay/${order.id}?amount=${order.amountCents}&provider=${order.provider}`;
}

async function createPaymentOrder(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const t = ownTeam(teamId, ctx);
  const provider = GATEWAYS.includes(p?.provider) ? p.provider : 'wechat';
  const kind = p?.kind === 'topup' ? 'topup' : 'plan';

  let amountCents;
  let creditMilli = 0;
  let bonusMilli = 0;
  let planId = null;
  let months = 1;

  if (kind === 'plan') {
    planId = req(p, 'planId');
    if (!isValidPlan(planId)) throw badRequest('未知套餐', 'INVALID_PLAN');
    if (planRank(planId) <= planRank(normalizePlanId(subscriptionFor(teamId)))) {
      throw badRequest('目标套餐不高于当前套餐', 'PLAN_NOT_UPGRADE');
    }
    months = Number(p?.months) || 1;
    if (!MONTH_OPTIONS.includes(months)) throw badRequest('不识别的付费周期', 'INVALID_CYCLE');
    amountCents = planCycleCents(planId, months);
  } else {
    amountCents = Number(p?.priceCents);
    const tier = TOPUP_TIERS.find((x) => x.priceCents === amountCents);
    if (!tier) throw badRequest('不支持的充值档位', 'INVALID_TOPUP_AMOUNT');
    creditMilli = tier.creditMilli;
    bonusMilli = tier.bonusMilli;
  }

  const order = {
    id: uuid(),
    orderNo: 'CG' + Date.now().toString(36).toUpperCase() + rid(4).toUpperCase(),
    teamId,
    userId: ctx.user.id,
    amountCents,
    currency: 'CNY',
    provider,
    gateway: provider,
    kind,
    planId,
    months,
    creditMilli,
    bonusMilli,
    returnOrigin: p?.returnOrigin ?? null,
    status: 'pending',
    providerTradeNo: null,
    createdAt: now(),
    paidAt: null,
    expiresAt: new Date(Date.now() + 30 * 60e3).toISOString(),
  };
  order.payUrl = makePayUrl(order);

  const db = db$();
  db.paymentOrders.push(order);
  save();

  // 演示：若干秒后自动置为已付（生产由支付网关回调驱动）
  if (AUTO_PAY_MS > 0) {
    const timer = setTimeout(() => {
      const row = db$().paymentOrders.find((x) => x.id === order.id);
      if (row && row.status === 'pending') settleOrder(row);
    }, AUTO_PAY_MS);
    if (timer.unref) timer.unref();
  }

  return { order: paymentOrder({ ...order, amount: amountCents }), payUrl: order.payUrl };
}

/** 结算：置为已付 + 发额度 */
function settleOrder(order) {
  if (order.status === 'paid') return order;
  order.status = 'paid';
  order.paidAt = now();
  order.providerTradeNo = 'TP' + rid(16).toUpperCase();
  if (order.kind === 'plan') {
    grantPlan(order.teamId, order.planId, order.months, 'plan_purchase');
  } else {
    grantTopup(order.teamId, order.userId, order.amountCents, order.creditMilli, order.bonusMilli);
  }
  save();
  return order;
}

async function syncPaymentOrder(p, ctx) {
  const order = db$().paymentOrders.find((x) => x.id === req(p, 'orderId'));
  if (!order) notFound('订单');
  ownTeam(order.teamId, ctx);

  // 演示模式下即使定时器已被回收，也按「创建满 N 秒」补一次结算
  if (order.status === 'pending' && AUTO_PAY_MS > 0 && Date.now() - Date.parse(order.createdAt) >= AUTO_PAY_MS) {
    settleOrder(order);
  }
  return { order: paymentOrder({ ...order, amount: order.amountCents }) };
}

async function recheckPaymentOrders(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const db = db$();
  const pending = db.paymentOrders.filter((x) => x.teamId === teamId && x.status === 'pending');
  let recovered = 0;
  for (const o of pending) {
    if (AUTO_PAY_MS > 0 && Date.now() - Date.parse(o.createdAt) >= AUTO_PAY_MS) {
      settleOrder(o);
      recovered += 1;
    }
  }
  return { checked: pending.length, recovered, ok: true };
}

async function getPaymentOrders(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const rows = db$()
    .paymentOrders.filter((o) => o.teamId === teamId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const orders = rows.slice(offset, offset + limit).map((o) => paymentOrder({ ...o, amount: o.amountCents }));
  return { orders, items: orders, total: rows.length, limit, offset };
}

/* ------------------------------------------------------------------ */
/* 发票                                                                */
/* ------------------------------------------------------------------ */

async function getInvoices(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const rows = db$()
    .invoices.filter((i) => i.teamId === teamId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const limit = Math.max(1, Math.min(200, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const page = rows.slice(offset, offset + limit).map(invoice);
  return {
    invoices: page,
    items: page,
    total: rows.length,
    limit,
    offset,
    // 发票可用额度（生产 Z()：已收款 - 已开票 - 已申请）
    available: availableInvoiceCents(teamId),
  };
}

function availableInvoiceCents(teamId) {
  const db = db$();
  const paid = db.paymentOrders.filter((o) => o.teamId === teamId && o.status === 'paid');
  const received = paid.reduce((a, o) => a + o.amountCents, 0);
  const issued = db.invoices.filter((i) => i.teamId === teamId && i.status === 'issued').reduce((a, i) => a + i.amount, 0);
  const requested = db.invoices.filter((i) => i.teamId === teamId && i.status === 'requested').reduce((a, i) => a + i.amount, 0);
  return invoiceAvailable({ received, issued, requested });
}

async function createInvoice(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const t = ownTeam(teamId, ctx);
  const s = subscriptionFor(teamId);
  const planId = normalizePlanId(s);
  if (!INVOICE_PLANS.includes(planId)) throw badRequest('当前套餐不支持开票', 'INVOICE_PLAN_NOT_ELIGIBLE');

  const amount = Number(p?.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('开票金额不合法', 'INVALID_AMOUNT');
  const avail = availableInvoiceCents(teamId);
  if (amount > avail) throw badRequest('开票金额超过可开票额度', 'AMOUNT_EXCEEDS_AVAILABLE');

  const type = p?.type === 'vat_special' ? 'vat_special' : 'normal';
  const taxNo = p?.taxNo ? String(p.taxNo).trim() : '';
  if (type === 'vat_special') {
    if (!TAX_NO_RX.test(taxNo)) throw badRequest('纳税人识别号格式不正确（15–20 位字母数字）', 'INVALID_TAX_NO');
  }

  const row = {
    id: uuid(),
    teamId,
    userId: ctx.user.id,
    orderId: p?.orderId ?? null,
    amount,
    currency: 'CNY',
    title: p?.title ?? t.name,
    taxNo,
    type,
    status: 'requested',
    email: p?.email ?? ctx.user.email ?? null,
    note: p?.note ?? null,
    createdAt: now(),
    issuedAt: null,
  };
  db$().invoices.push(row);
  save();
  return { invoice: invoice(row) };
}

async function deleteInvoice(p, ctx) {
  const db = db$();
  const row = db.invoices.find((i) => i.id === req(p, 'invoiceId'));
  if (!row) notFound('发票');
  ownTeam(row.teamId, ctx);
  if (row.status === 'issued') throw badRequest('已开具的发票不能删除', 'INVOICE_ISSUED');
  db.invoices = db.invoices.filter((i) => i.id !== row.id);
  save();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 兑换码 / 邀请码                                                     */
/* ------------------------------------------------------------------ */

async function redeemCodeCmd(p, ctx) {
  const code = String(p?.code ?? '').trim().toUpperCase();
  if (!code) throw badRequest('请输入兑换码', 'REDEEM_CODE_NOT_FOUND');
  const db = db$();
  const row = db.redeemCodes.find((c) => c.code.toUpperCase() === code);
  if (!row) throw badRequest('兑换码不存在', 'REDEEM_CODE_NOT_FOUND');
  if (row.disabled) throw badRequest('兑换码已作废', 'REDEEM_CODE_INVALID');
  if (row.usedBy) throw badRequest('兑换码已被使用', 'REDEEM_CODE_EXHAUSTED');

  const t = db.teams.find((x) => x.id === ctx.teamId);
  row.usedBy = ctx.user.id;
  row.usedAt = now();
  t.creditBalance = (t.creditBalance ?? 0) + (row.credits ?? 0);
  db.creditLedger.push({
    id: uuid(),
    teamId: ctx.teamId,
    userId: ctx.user.id,
    delta: row.credits ?? 0,
    reason: 'redeem_code',
    balanceAfter: t.creditBalance,
    note: code,
    createdAt: now(),
  });
  save();
  return { ok: true, credits: row.credits ?? 0, balance: t.creditBalance };
}

async function getMyInviteCodes(p, ctx) {
  const rows = db$()
    .inviteCodes.filter((c) => c.teamId === ctx.teamId)
    .map((c) => ({
      ...inviteCode(c),
      invitees: db$()
        .teamMembers.filter((m) => m.teamId === c.teamId && m.invitedByCode === c.code)
        .map((m) => m.userId),
      url: `http://localhost:${process.env.PORT_APP || 5181}/claim?code=${c.code}`,
    }));
  return { inviteCodes: rows, items: rows, total: rows.length, codes: rows };
}

async function createInviteCode(p, ctx) {
  const db = db$();
  const row = {
    id: uuid(),
    teamId: ctx.teamId,
    userId: ctx.user.id,
    code: (p?.code ?? 'CG' + rid(6)).toUpperCase(),
    name: p?.name ?? '',
    usedCount: 0,
    maxUses: Number(p?.maxUses) || 0,
    rewardCredits: Number(p?.rewardCredits) || 0,
    active: true,
    createdAt: now(),
  };
  db.inviteCodes.push(row);
  save();
  return { inviteCode: inviteCode(row), ok: true };
}

async function renameInviteCode(p, ctx) {
  const row = db$().inviteCodes.find((c) => c.id === req(p, 'inviteCodeId') || c.code === p?.code);
  if (!row) notFound('邀请码');
  ownTeam(row.teamId, ctx);
  if (p?.name !== undefined) row.name = String(p.name);
  if (p?.maxUses !== undefined) row.maxUses = Number(p.maxUses) || 0;
  if (p?.active !== undefined) row.active = !!p.active;
  save();
  return { inviteCode: inviteCode(row), ok: true };
}


/* ------------------------------------------------------------------ */
/* 支付凭证（线上新版，usePaymentOrder-DzPn7xyI.js）                    */
/* ------------------------------------------------------------------ */

/** 前端：r('getPaymentDocuments',{teamId, orderId}) → 直接把结果塞给凭证面板 */
async function getPaymentDocuments(p, ctx) {
  const db = db$();
  const orderId = req(p, 'orderId');
  const teamId = p?.teamId ?? ctx.teamId;
  const order = db.paymentOrders.find((o) => o.id === orderId);
  if (!order) notFound('订单');
  if (order.teamId !== teamId && ctx.user.role !== 'super_admin') {
    throw new ApiErrorB('FORBIDDEN', '无权访问该订单', 403);
  }
  const invoices = db.invoices.filter((i) => i.orderId === orderId);
  const documents = [
    {
      id: `order_${order.id}`,
      kind: 'order',
      title: `订单 ${order.orderNo ?? order.id}`,
      amountCents: order.amountCents ?? order.amount ?? 0,
      status: order.status,
      issuedAt: order.paidAt ?? order.createdAt,
      url: `/__pay/${order.id}`,
    },
    ...invoices.map((i) => ({
      id: i.id,
      kind: 'invoice',
      title: i.title,
      amountCents: i.amount,
      status: i.status,
      issuedAt: i.issuedAt ?? i.createdAt,
      url: `/api/downloadInvoice?id=${encodeURIComponent(i.id)}`,
    })),
  ];
  return { documents, order: paymentOrder(order), invoices: invoices.map(invoice), total: documents.length };
}

export const commands = {
  getSubscription,
  getPlans,
  quoteUpgrade,
  createPaymentOrder,
  syncPaymentOrder,
  recheckPaymentOrders,
  getPaymentOrders,
  getInvoices,
  createInvoice,
  deleteInvoice,
  redeemCode: redeemCodeCmd,
  getMyInviteCodes,
  createInviteCode,
  renameInviteCode,
  getPaymentDocuments,
};

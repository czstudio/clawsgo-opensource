// 计费域模型 —— 从生产 bundle `app/assets/billing-D3pmhdeW.js` 逐字段还原。
//
// 原文件导出符号 ↔ 本模块命名对照（变量名是压缩后的，语义按使用点推断并交叉验证）：
//   e = UNIT(1e3)                     毫单位：1 credit = 1000 milliCredit
//   i(t) = Math.round(t*UNIT)         credit → milliCredit（整数）
//   r(t) = t/UNIT                     milliCredit → credit
//   n(t) = t*(3e3*e/100)              milliCredit → 标价微元（价格换算链）
//   a  = PLANS                        ['free','plus','pro','ultra','team','enterprise']
//   s  = PLAN_RANK
//   c  = PLAN_LABEL
//   l  = PLAN_PRICE_CENTS             月付标价（单位：分）
//   u  = PLAN_MONTHLY_CREDITS         月赠额度（credit）
//   d  = PLAN_MONTHLY_MILLI           u 换成 milli
//   f  = CYCLE_MS = 2592e6            「一个月」= 30 天
//   p  = MODELS_BY_PLAN               各套餐可用的模型白名单
//   g  = HOST_CPU                     「并发/CPU」配额
//   _  = HOST_CONCURRENCY
//   b  = HOST_SPEC                    {cpus, memoryGb}
//   x  = HOST_DISK_GB
//   w  = AGENT_MEMORY_BYTES           智能体记忆文件配额（MB 基数）
//   F  = MODEL_MULTIPLIER             模型计费倍率
//   I  = GATEWAYS                     ['stripe','wechat','alipay']
//   L  = SELF_SERVE_PLANS             ['plus','pro','ultra']
//   R  = MONTH_OPTIONS                [1, 12]
//   z  = ANNUAL_DISCOUNT_BP = 6e3     年付按 6000/10000 = 6 折
//   K  = TOPUP_TIERS                  [[元, 赠送 bp]] → priceCents/bonusBp/creditMilli/bonusMilli
//   q  = INVOICE_PLANS                ['pro','ultra','team','enterprise']
//   J  = INVOICE_STATUSES             ['requested','issued','rejected']
//   Y  = INVOICE_SINCE                2026-09-10T00:00:00+08:00
//   X  = TAX_NO_RX                    /^[0-9A-Za-z]{15,20}$/
//   O  = CREDITS_WEB_SEARCH = 5
//   A  = CREDITS_IMAGE = 100
//   M  = REFERRAL_RULES
//   N  = REFERRAL_BOUNDS
//   ee = MVNO_PREFIX_RX  /^1\d{2}$/

export const UNIT = 1e3;

export const PLANS = ['free', 'plus', 'pro', 'ultra', 'team', 'enterprise'];
export const PLAN_RANK = { free: 0, plus: 1, pro: 2, ultra: 3, team: 4, enterprise: 5 };
export const PLAN_LABEL = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  team: 'Team',
  enterprise: 'Enterprise',
};
export const PLAN_LABEL_ZH = {
  free: '免费版',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  team: '团队版',
  enterprise: '企业版',
};

/** 月付标价（单位：分）→ ¥0 / ¥9.9 / ¥29.9 / ¥99.9 / ¥299.9 / ¥999 */
export const PLAN_PRICE_CENTS = { free: 0, plus: 990, pro: 2990, ultra: 9990, team: 29990, enterprise: 99900 };

/** 每月赠送额度（credit） */
export const PLAN_MONTHLY_CREDITS = { free: 0, plus: 3e4, pro: 12e4, ultra: 5e5, team: 15e5, enterprise: 5e6 };

/** 一个月 = 30 天 */
export const CYCLE_MS = 2592e6;

/** 各套餐可用的模型（由低到高累加） */
export const MODELS_BY_PLAN = (() => {
  const free = ['clawsgo-1.0-lithium'];
  const plus = [...free, 'clawsgo-1.0-silicon', 'claude-sonnet-5', 'gpt-5.6-terra'];
  const pro = [
    ...plus,
    'clawsgo-1.0-titanium',
    'claude-opus-5',
    'gpt-5.6-sol',
    'gpt-6-astra',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'gpt-5.5',
  ];
  const ultra = pro;
  const team = [...pro, 'claude-fable-5-1', 'claude-fable-5'];
  const enterprise = team;
  return { free, plus, pro, ultra, team, enterprise };
})();

export const HOST_CPU = { free: 2, plus: 3, pro: 10, ultra: 20, team: 50, enterprise: 100 };
export const HOST_CONCURRENCY = { free: 1, plus: 3, pro: 10, ultra: null, team: null, enterprise: null };
export const HOST_SPEC = {
  free: { cpus: 2, memoryGb: 4 },
  plus: { cpus: 2, memoryGb: 4 },
  pro: { cpus: 4, memoryGb: 8 },
  ultra: { cpus: 8, memoryGb: 16 },
  team: { cpus: 8, memoryGb: 16 },
  enterprise: { cpus: 16, memoryGb: 32 },
};
export const HOST_DISK_GB = { free: 10, plus: 20, pro: 50, ultra: 100, team: 200, enterprise: 500 };

const MB = 1048576;
/** 智能体记忆文件配额（字节） */
export const AGENT_MEMORY_BYTES = {
  free: 50 * MB,
  plus: 200 * MB,
  pro: 1024 * MB,
  ultra: 1024 * MB,
  team: 1024 * MB,
  enterprise: 1024 * MB,
};

/** 模型计费倍率 */
export const MODEL_MULTIPLIER = {
  'clawsgo-1.0-lithium': 1,
  'clawsgo-1.0-silicon': 2,
  'clawsgo-1.0-titanium': 3,
  'deepseek-v4.1-flash': 1,
  'deepseek-v4-flash': 1,
  'deepseek-v4-flash-vision': 1,
  'deepseek-v4-pro': 2,
  'glm-5.3-flash': 1,
  'glm-5.3': 3,
  'claude-sonnet-5': 1.5,
  'claude-opus-5': 3,
  'claude-fable-5-1': 25,
  'gpt-5.6-luna': 0.2,
  'gpt-5.6-terra': 1,
  'gpt-5.6-sol': 3,
  'gpt-6-astra': 5,
  'claude-opus-4-8': 3,
  'claude-opus-4-7': 3,
  'claude-opus-4-6': 3,
  'claude-fable-5': 25,
  'gpt-5.5': 3,
};

export const GATEWAYS = ['stripe', 'wechat', 'alipay'];
export const SELF_SERVE_PLANS = ['plus', 'pro', 'ultra'];
export const MONTH_OPTIONS = [1, 12];
/** 年付系数：6000/10000 = 6 折 */
export const ANNUAL_DISCOUNT_BP = 6e3;

/** 充值档位：[[元, 赠送万分比]] */
export const TOPUP_TIERS = [
  [10, 500],
  [50, 1000],
  [100, 1500],
  [500, 2000],
  [1000, 3000],
].map(([yuan, bonusBp]) => {
  const priceCents = yuan * 100;
  const creditMilli = creditToMilli(priceCents);
  return {
    priceCents,
    bonusBp,
    creditMilli,
    bonusMilli: (creditMilli * bonusBp) / 1e4,
    yuan,
  };
});

export const INVOICE_PLANS = ['pro', 'ultra', 'team', 'enterprise'];
export const INVOICE_STATUSES = ['requested', 'issued', 'rejected'];
export const INVOICE_SINCE = new Date('2026-09-10T00:00:00+08:00');
export const TAX_NO_RX = /^[0-9A-Za-z]{15,20}$/;

/** 工具计费：按次 */
export const CREDITS_WEB_SEARCH = creditToMilli(5);
export const CREDITS_IMAGE = creditToMilli(100);

export const REFERRAL_RULES = {
  days: 30,
  minInvited: 5,
  maxMsgs: 1,
  deadMinutes: 10,
  burstMinutes: 10,
  mvnoPrefixes: ['162', '165', '167', '170', '171'],
};
export const REFERRAL_BOUNDS = {
  days: [0, 365],
  minInvited: [1, 1e3],
  maxMsgs: [0, 100],
  deadMinutes: [1, 1440],
  burstMinutes: [1, 1440],
};
export const MVNO_PREFIX_RX = /^1\d{2}$/;

/* ------------------------------------------------------------------ */
/* 换算与派生                                                          */
/* ------------------------------------------------------------------ */

/** credit → milliCredit */
export function creditToMilli(credits) {
  return Math.round(Number(credits) * UNIT);
}

/** milliCredit → credit */
export function milliToCredit(milli) {
  return Number(milli) / UNIT;
}

/** milliCredit → 标价微元（生产的价格换算链） */
export function milliToPriceMicro(milli) {
  return Number(milli) * ((3e3 * UNIT) / 100);
}

/** 月付标价（分） */
export function planMonthlyCents(planId) {
  return PLAN_PRICE_CENTS[planId] ?? 0;
}

/** 按周期计价（分）：12 个月走年付 6 折 */
export function planCycleCents(planId, months) {
  const monthly = planMonthlyCents(planId);
  if (Number(months) === 12) return Math.round((monthly * 12 * ANNUAL_DISCOUNT_BP) / 1e4);
  return monthly * (Number(months) || 1);
}

/** 折算成「每月」标价（分），用于展示「相当于 ¥x/月」 */
export function planMonthlyEquivalentCents(planId, period) {
  if (period === 'year') return planCycleCents(planId, 12) / 12;
  return planMonthlyCents(planId);
}

export function planMonthlyMilli(planId) {
  return creditToMilli(PLAN_MONTHLY_CREDITS[planId] ?? 0);
}

export const planRank = (planId) => PLAN_RANK[planId] ?? 0;
export const isInvoicePlan = (planId) => INVOICE_PLANS.includes(planId);
export const isSelfServePlan = (planId) => SELF_SERVE_PLANS.includes(planId);
export const isValidPlan = (planId) => PLANS.includes(planId);

/** 该模型是否包含在套餐里 */
export function planIncludesModel(planId, modelId) {
  return (MODELS_BY_PLAN[planId] ?? []).includes(modelId);
}

/** 反查：某个模型最低需要哪个套餐 */
export function minPlanForModel(modelId) {
  for (const p of PLANS) if ((MODELS_BY_PLAN[p] ?? []).includes(modelId)) return p;
  return null;
}

export const modelMultiplier = (modelId) => MODEL_MULTIPLIER[modelId] ?? 1;

/** 字节配额格式化（GB / MB 自适应） */
export function formatBytesQuota(bytes) {
  const mb = bytes / MB;
  return mb >= 1024 ? `${mb / 1024}GB` : `${mb}MB`;
}

export const MAX_AGENT_MEMORY_BYTES = Math.max(...Object.values(AGENT_MEMORY_BYTES));

/**
 * 升级抵扣试算（生产 G() 的等价实现）
 * @param {{target:{planId:string,months:number}, current:{planId:string,period?:'month'|'year',planEndAt?:string,cycleStartAt?:string,monthlyMilli?:number}}} input
 * @returns {{listCents:number,prorationCents:number,dueCents:number}}
 */
export function prorationQuote(input) {
  const target = input?.target ?? {};
  const current = input?.current ?? {};
  const listCents = planCycleCents(target.planId, target.months);
  const currentMonthlyMilli = planMonthlyMilli(current.planId);
  let prorationCents = 0;

  if (current.planEndAt && currentMonthlyMilli > 0) {
    const monthly = planMonthlyEquivalentCents(current.planId, current.period);
    const ratio = Math.min(1, Math.max(0, Number(current.monthlyMilli) / currentMonthlyMilli));
    const ms = toMs(current.planEndAt) - toMs(current.cycleStartAt);
    const usedMonths = Math.round(ms / CYCLE_MS);
    const monthsLeft = Math.min(24, Math.max(0, usedMonths - 1));
    prorationCents = Math.floor(monthly * (ratio + monthsLeft));
  }
  const dueCents = Math.max(1, listCents - prorationCents);
  return { listCents, prorationCents, dueCents };
}

function toMs(v) {
  return typeof v === 'string' ? Date.parse(v) : v?.getTime?.() ?? 0;
}

/** 发票可用额度（生产 Z()）：已收款 - 已开票 - 已申请 */
export function invoiceAvailable(summary) {
  return Math.max(0, (summary?.received ?? 0) - (summary?.issued ?? 0) - (summary?.requested ?? 0));
}

/** 金额格式化（¥，<1 显示 <1） */
export function formatCredits(milli) {
  const sign = milli < 0 ? '-' : '';
  const v = Math.abs(milli) / UNIT;
  if (v > 0 && v < 0.5) return `${sign}<1`;
  return sign + Math.round(v).toLocaleString('en-US');
}

export function formatCreditsPrecise(milli) {
  const sign = milli < 0 ? '-' : '';
  const v = Math.round((Math.abs(milli) / (UNIT / 10))) / 10;
  if (milli !== 0 && v === 0) return `${sign}<0.1`;
  return sign + v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export const formatCents = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatCentsCompact = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/** 套餐规格摘要（前端套餐卡直接展示） */
export function planSpec(planId) {
  return {
    planId,
    label: PLAN_LABEL[planId],
    monthlyCents: planMonthlyCents(planId),
    yearlyCents: planCycleCents(planId, 12),
    monthlyCredits: PLAN_MONTHLY_CREDITS[planId] ?? 0,
    cpus: HOST_SPEC[planId]?.cpus ?? null,
    memoryGb: HOST_SPEC[planId]?.memoryGb ?? null,
    diskGb: HOST_DISK_GB[planId] ?? null,
    concurrency: HOST_CONCURRENCY[planId] ?? null,
    hostCpu: HOST_CPU[planId] ?? null,
    agentMemory: formatBytesQuota(AGENT_MEMORY_BYTES[planId] ?? 0),
    models: MODELS_BY_PLAN[planId] ?? [],
    highlight: planId === 'pro',
    invoice: isInvoicePlan(planId),
    selfServe: isSelfServePlan(planId),
  };
}

export function allPlanSpecs() {
  return PLANS.map(planSpec);
}

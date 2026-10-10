// 响应序列化：把内部行转成前端期望的 JSON 形状。
// 字段名来自对生产包静态分析的还原（见 docs/07-数据形状.md）。
import { db$ } from './db.mjs';

export function user(userId) {
  const u = db$().users.find((x) => x.id === userId);
  if (!u) return null;
  return {
    id: u.id,
    userId: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    avatarUrl: u.avatarUrl ?? null,
    locale: u.locale ?? 'zh-CN',
    theme: u.theme ?? 'dark',
    role: u.role ?? 'user',
    banned: !!u.banned,
    banReason: u.banReason ?? null,
    createdAt: u.createdAt,
  };
}

/** getProfile → { profile } */
export function profile(userId) {
  const u = db$().users.find((x) => x.id === userId);
  if (!u) return null;
  const team = personalTeamFor(userId);
  return {
    // 注意：前端可能读 id，也可能读 userId（社区/团队比较都用 userId）
    id: u.id,
    userId: u.id,
    teamId: team?.id ?? null,
    name: u.name,
    // 新版前端 greeting/creatorName 读 displayName（person helper: displayName||email||phone）
    displayName: u.name ?? u.email ?? u.phone ?? '',
    email: u.email,
    phone: u.phone,
    avatarUrl: u.avatarUrl ?? null,
    role: u.role,
    // 新版前端（billing/access chunk）从 profile 直接解构 roles 数组做权限判断，
    // 缺失即 .some() 崩溃；老数据只有 role 字段，这里归一化派生。
    roles: Array.isArray(u.roles) && u.roles.length ? u.roles : u.role ? [u.role] : ['user'],
    locale: u.locale ?? 'zh-CN',
    theme: u.theme ?? 'dark',
    plan: u.plan ?? 'free',
    onboardedAt: u.onboardedAt ?? null,
    createdAt: u.createdAt,
    banned: !!u.banned,
    banReason: u.banReason ?? null,
    credits: team?.creditBalance ?? 0,
  };
}

export function personalTeamFor(userId) {
  const db = db$();
  // 优先级：成员关系里 owner 的团队 → id 等于 userId 的团队 → 任意团队
  const mem = db.teamMembers.find((m) => m.userId === userId && m.role === 'owner');
  if (mem) return db.teams.find((t) => t.id === mem.teamId) ?? null;
  return db.teams.find((t) => t.id === userId) ?? db.teams[0] ?? null;
}

/** getTeams → { teams }；teamId 需要带请求者 userId，个人团队 id === userId */
export function team(t, requesterId) {
  if (!t) return null;
  const db = db$();
  const mem = db.teamMembers.find((m) => m.teamId === t.id && m.userId === requesterId);
  const memberCount = db.teamMembers.filter((m) => m.teamId === t.id).length;
  return {
    id: t.id,
    userId: requesterId,
    name: t.name,
    ownerId: t.ownerId,
    role: mem?.role ?? 'member',
    plan: t.plan,
    memberLimit: t.memberLimit ?? 10,
    memberCount,
    creditBalance: t.creditBalance ?? 0,
    seatsUsed: memberCount,
    createdAt: t.createdAt,
  };
}

/** getTeamMembers → { members } */
export function teamMember(m) {
  const u = db$().users.find((x) => x.id === m.userId);
  return {
    id: m.id,
    userId: m.userId,
    teamId: m.teamId,
    role: m.role,
    joinedAt: m.joinedAt,
    name: u?.name ?? '(已注销)',
    email: u?.email ?? null,
    phone: u?.phone ?? null,
    avatarUrl: u?.avatarUrl ?? null,
    banned: !!u?.banned,
  };
}

/** teamInvitation */
export function teamInvitation(inv) {
  const u = db$().users.find((x) => x.id === inv.inviteeId);
  const inviter = db$().users.find((x) => x.id === inv.inviterId);
  return {
    id: inv.id,
    teamId: inv.teamId,
    inviterId: inv.inviterId,
    inviterName: inviter?.name ?? null,
    inviteeId: inv.inviteeId ?? null,
    email: inv.email ?? u?.email ?? null,
    phone: inv.phone ?? u?.phone ?? null,
    role: inv.role,
    status: inv.status,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt ?? null,
  };
}

export function project(p, viewerId = null) {
  if (!p) return null;
  const db = db$();
  const convs = db.conversations.filter((c) => c.projectId === p.id && !c.archivedAt);
  // 新版前端项目卡/侧栏读 taskCount / myTaskCount / creatorName（createProject 缓存同构）
  const creator = db.users.find((x) => x.id === p.userId);
  return {
    id: p.id,
    teamId: p.teamId,
    userId: p.userId,
    name: p.name,
    kind: p.kind,
    instruction: p.instruction ?? null,
    conversationCount: convs.length,
    taskCount: convs.length,
    myTaskCount: viewerId ? convs.filter((c) => c.userId === viewerId).length : convs.length,
    creatorName: creator?.name ?? '',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt ?? null,
    pinnedAt: p.pinnedAt ?? null,
  };
}

export function conversation(c) {
  if (!c) return null;
  const db = db$();
  const p = db.projects.find((x) => x.id === c.projectId);
  return {
    id: c.id,
    teamId: c.teamId,
    userId: c.userId,
    projectId: c.projectId ?? null,
    projectKind: p?.kind ?? 'implicit',
    // 侧栏条目消费字段（_shell chunk x(e)：creatorName/projectTitle/kind/taskCount）
    creatorName: db.users.find((x) => x.id === c.userId)?.name ?? '',
    projectTitle: p?.name ?? null,
    title: c.title ?? '',
    hostId: c.hostId ?? null,
    workdir: c.workdir ?? null,
    modelId: c.modelId ?? null,
    context: c.context ?? 'default',
    effort: c.effort ?? null,
    mode: c.mode ?? 'agent',
    streamId: c.streamId ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessageAt: c.lastMessageAt ?? null,
    lastMessagePreview: c.lastMessagePreview ?? '',
    lastMessageAttachments: c.lastMessageAttachments ?? 0,
    pinnedAt: c.pinnedAt ?? null,
    archivedAt: c.archivedAt ?? null,
  };
}

export function message(m) {
  if (!m) return null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    seq: m.seq ?? 0,
    modelId: m.modelId ?? null,
    context: m.context ?? null,
    parts: m.parts ?? [],
    streamId: m.streamId ?? null,
    metadata: m.metadata ?? null,
    createdAt: m.createdAt,
  };
}

/** 主机对外形状（含前端可能读取的展示字段） */
export function host(h) {
  if (!h) return null;
  const db = db$();
  const spec = h.spec ?? {};
  return {
    id: h.id,
    teamId: h.teamId,
    userId: h.userId,
    name: h.name,
    kind: h.kind,
    status: h.status,
    // 新版前端主机选择器用 canDispatchTask 过滤可派单主机（chat chunk: hosts.filter(e=>e.canDispatchTask)），
    // 缺失时聊天页显示 "No available host in this team" 且 Send 恒禁用；canOpenTerminal 同批补齐。
    canDispatchTask: h.status === 'running' || h.status === 'online',
    canOpenTerminal: h.kind === 'local' || h.status === 'running',
    // api chunk Ee(host,...)：!canDispatchTask→'private'，!online→'offline'，非空即禁用 Send
    online: h.status === 'running' || h.status === 'online',
    image: h.image ?? null,
    workdir: h.workdir ?? null,
    createdAt: h.createdAt,
    lastSeenAt: h.lastSeenAt ?? null,
    spec,
    cpu: spec.cpu ?? null,
    memoryGb: spec.memoryGb ?? null,
    diskGb: spec.diskGb ?? null,
    gpu: spec.gpu ?? null,
    specLabel: [spec.cpu ? `${spec.cpu} vCPU` : null, spec.memoryGb ? `${spec.memoryGb} GB` : null, spec.gpu]
      .filter(Boolean)
      .join(' · '),
    cacheClearedAt: h.cacheClearedAt ?? null,
    sshServerId: db.sshServers.find((s) => s.name === h.name && s.teamId === h.teamId)?.id ?? null,
  };
}

export function sshServer(s) {
  if (!s) return null;
  return {
    id: s.id,
    teamId: s.teamId,
    userId: s.userId,
    name: s.name,
    hostname: s.hostname,
    port: s.port ?? 22,
    username: s.username,
    authType: s.authType ?? 'key',
    status: s.status ?? 'unknown',
    latencyMs: s.latencyMs ?? null,
    lastProbeAt: s.lastProbeAt ?? null,
    createdAt: s.createdAt,
  };
}

export function skill(s) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    slug: s.slug ?? s.name,
    title: s.title ?? s.name,
    description: s.description ?? '',
    version: s.version ?? '1.0.0',
    source: s.source ?? 'official',
    repo: s.repo ?? null,
    tags: s.tags ?? [],
    // installed / enabled 必须在形状里统一下发：
    // 安装、卸载、启停三条命令都直接返回 skill(row)，漏了字段前端就看不到状态变化。
    installed: s.installed !== false,
    enabled: !!s.enabled,
    installedAt: s.installedAt ?? null,
    hostId: s.hostId ?? null,
    fileCount: (s.files ?? []).length,
    files: s.files ?? [],
    readme: s.readme ?? '',
  };
}

export function ticket(t) {
  if (!t) return null;
  return {
    id: t.id,
    seq: t.seq,
    teamId: t.teamId,
    userId: t.userId,
    type: t.type,
    subject: t.subject,
    status: t.status,
    priority: t.priority ?? 'normal',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastMessageAt: t.updatedAt,
    lastMessagePreview: t.lastMessagePreview ?? '',
    lastMessageAttachments: t.lastMessageAttachments ?? 0,
    unreadCount: t.unreadForUser ?? 0,
    unreadForUser: t.unreadForUser ?? 0,
    unreadForAdmin: t.unreadForAdmin ?? 0,
  };
}

export function ticketMessage(m) {
  return {
    id: m.id,
    ticketId: m.ticketId,
    authorId: m.authorId,
    authorRole: m.authorRole,
    body: m.body,
    attachments: m.attachments ?? [],
    createdAt: m.createdAt,
  };
}

export function invoice(i) {
  return {
    id: i.id,
    teamId: i.teamId,
    userId: i.userId,
    orderId: i.orderId ?? null,
    amount: i.amount,
    currency: i.currency ?? 'CNY',
    title: i.title,
    taxNo: i.taxNo ?? '',
    type: i.type,
    status: i.status,
    email: i.email ?? null,
    note: i.note ?? null,
    createdAt: i.createdAt,
    issuedAt: i.issuedAt ?? null,
  };
}

/**
 * 支付订单形状。
 * 字段清单依据原始 bundle `_shell-CSlH67JO.js` 里的结账弹窗与订单详情：
 *   a.kind === 'plan' ? a.planId : X((a.creditMilli ?? 0) + a.bonusMilli)
 * 也就是说 `kind / planId / creditMilli / bonusMilli` 必须下发，
 * `payUrl` 也要在 order 内（会被渲染成二维码；stripe 分支直接 location.href）。
 */
export function paymentOrder(o) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    teamId: o.teamId,
    userId: o.userId,
    kind: o.kind ?? 'plan',
    planId: o.planId ?? null,
    months: o.months ?? 1,
    amount: o.amount,
    amountCents: o.amountCents ?? o.amount ?? 0,
    creditMilli: o.creditMilli ?? 0,
    bonusMilli: o.bonusMilli ?? 0,
    payUrl: o.payUrl ?? null,
    currency: o.currency ?? 'CNY',
    gateway: o.gateway ?? o.provider,
    provider: o.provider ?? o.gateway,
    plan: o.plan ?? null,
    status: o.status,
    providerTradeNo: o.providerTradeNo ?? null,
    refundedAt: o.refundedAt ?? null,
    createdAt: o.createdAt,
    paidAt: o.paidAt ?? null,
  };
}

export function announcement(a) {
  return {
    id: a.id,
    titleZh: a.titleZh,
    titleEn: a.titleEn ?? a.titleZh,
    // 前端读的是 contentZh / contentEn
    contentZh: a.contentZh ?? a.bodyZh ?? '',
    contentEn: a.contentEn ?? a.bodyEn ?? a.contentZh ?? a.bodyZh ?? '',
    bodyZh: a.bodyZh ?? a.contentZh ?? '',
    bodyEn: a.bodyEn ?? a.contentEn ?? '',
    level: a.level ?? 'info',
    active: !!a.active,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
    createdBy: a.createdBy ?? null,
  };
}

export function device(d) {
  return {
    id: d.id,
    userId: d.userId,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion ?? null,
    status: d.revokedAt ? 'revoked' : 'active',
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    revokedAt: d.revokedAt ?? null,
  };
}

export function inviteCode(c) {
  return {
    id: c.id,
    teamId: c.teamId,
    userId: c.userId,
    code: c.code,
    name: c.name ?? '',
    usedCount: c.usedCount ?? 0,
    maxUses: c.maxUses ?? 0,
    rewardCredits: c.rewardCredits ?? 0,
    active: c.active !== false,
    createdAt: c.createdAt,
  };
}

export function redeemCode(c) {
  return {
    id: c.id,
    code: c.code,
    credits: c.credits,
    batch: c.batch ?? null,
    status: c.disabled ? 'disabled' : c.usedBy ? 'used' : 'unused',
    usedBy: c.usedBy ?? null,
    usedAt: c.usedAt ?? null,
    createdAt: c.createdAt,
  };
}

export function creditLedgerRow(r) {
  return {
    id: r.id,
    teamId: r.teamId,
    userId: r.userId,
    delta: r.delta,
    reason: r.reason,
    balanceAfter: r.balanceAfter,
    note: r.note ?? null,
    createdAt: r.createdAt,
  };
}

export function subscription(s) {
  if (!s) return null;
  const start = s.cycleStartAt ?? s.createdAt ?? new Date().toISOString();
  const end =
    s.planEndAt ??
    (s.currentPeriodEnd ?? new Date(Date.parse(start) + 30 * 864e5).toISOString());
  return {
    id: s.id,
    teamId: s.teamId,
    // 前端以 planId 查套餐表
    planId: s.planId ?? s.plan ?? 'free',
    plan: s.planId ?? s.plan ?? 'free',
    status: s.status,
    seats: s.seats ?? 1,
    priceMonthly: s.priceMonthly ?? 0,
    currency: s.currency ?? 'CNY',
    cycleStartAt: start,
    currentPeriodEnd: end,
    planEndAt: end,
    createdAt: s.createdAt,
  };
}

export function agentMemoryEntry(m) {
  return {
    id: m.id,
    teamId: m.teamId,
    userId: m.userId,
    scope: m.scope ?? 'global',
    key: m.key,
    content: m.content,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export function hostSkillFromHost(h) {
  const db = db$();
  const prefix = `skill_${h.id}_`;
  return db.skills
    .filter((s) => s.hostId === h.id || s.id.startsWith(prefix))
    .map(skill);
}

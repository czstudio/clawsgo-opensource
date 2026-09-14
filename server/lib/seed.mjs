// 首次启动播种的演示数据。
// 演示账号：手机号 13800000000，验证码任意 6 位（默认 123456），密码 clawsgo2026
import { db$, uuid, now, save, flush } from './db.mjs';

export const DEMO = {
  phone: '13800000000',
  phoneE164: '+8613800000000',
  otp: '123456',
  password: 'clawsgo2026',
  adminPhone: '13900000000',
  adminPassword: 'clawsgo2026',
};

const HOUR = 3600e3;
const DAY = 24 * HOUR;

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

export function seedIfEmpty() {
  const db = db$();
  if (db.users.length > 0) return false;
  seed(db);
  flush();
  return true;
}

function seed(db) {
  // ---------- 用户 ----------
  const owner = {
    id: uuid(),
    phone: DEMO.phoneE164,
    email: 'demo@clawsgo.local',
    name: '演示用户',
    avatarUrl: null,
    role: 'user',
    locale: 'zh-CN',
    theme: 'dark',
    onboardedAt: ago(9 * DAY),
    createdAt: ago(30 * DAY),
    banned: false,
    banReason: null,
    password: DEMO.password,
    plan: 'pro',
  };
  const admin = {
    id: uuid(),
    phone: '+8613900000000',
    email: 'admin@clawsgo.local',
    name: '平台管理员',
    avatarUrl: null,
    role: 'super_admin',
    locale: 'zh-CN',
    theme: 'dark',
    onboardedAt: ago(40 * DAY),
    createdAt: ago(60 * DAY),
    banned: false,
    banReason: null,
    password: DEMO.adminPassword,
    plan: 'ultimate',
  };
  db.users.push(owner, admin);

  // ---------- 团队 ----------
  // 关键：个人团队的 id 必须等于 owner 的用户 id。
  // 前端 useCurrentTeam 在 localStorage 无选择时用 `team.id === team.userId` 兜底定位默认团队。
  const team = {
    id: owner.id,
    name: '演示实验室',
    ownerId: owner.id,
    plan: 'pro',
    memberLimit: 10,
    creditBalance: 4820,
    createdAt: ago(30 * DAY),
  };
  db.teams.push(team);
  db.teamMembers.push(
    { id: uuid(), teamId: team.id, userId: owner.id, role: 'owner', joinedAt: ago(30 * DAY) },
    { id: uuid(), teamId: team.id, userId: admin.id, role: 'admin', joinedAt: ago(25 * DAY) },
  );
  db.subscriptions.push({
    id: uuid(),
    teamId: team.id,
    plan: 'pro',
    status: 'active',
    seats: 5,
    priceMonthly: 299,
    currency: 'CNY',
    currentPeriodEnd: new Date(Date.now() + 21 * DAY).toISOString(),
    createdAt: ago(30 * DAY),
  });

  db.creditLedger.push(
    { id: uuid(), teamId: team.id, userId: owner.id, delta: 5000, reason: 'topup', balanceAfter: 5000, createdAt: ago(30 * DAY), note: '首次充值' },
    { id: uuid(), teamId: team.id, userId: owner.id, delta: -180, reason: 'usage', balanceAfter: 4820, createdAt: ago(2 * DAY), note: '对话用量结算' },
  );

  // ---------- 主机 ----------
  const host = {
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    name: 'cloud-default',
    kind: 'cloud',
    status: 'running',
    spec: { cpu: 8, memoryGb: 32, diskGb: 200, gpu: 'RTX 4090 24GB' },
    image: 'clawsgo/science-runtime:2026.09',
    workdir: '/home/clawsgo/workspace',
    createdAt: ago(30 * DAY),
    lastSeenAt: ago(3 * 60e3),
    cacheClearedAt: null,
  };
  db.hosts.push(host);
  db.hosts.push({
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    name: 'lab-a100',
    kind: 'ssh',
    status: 'offline',
    spec: { cpu: 64, memoryGb: 256, diskGb: 4000, gpu: 'A100 80GB x4' },
    image: null,
    workdir: '/data/lab',
    createdAt: ago(12 * DAY),
    lastSeenAt: ago(2 * DAY),
    cacheClearedAt: null,
  });

  db.sshServers.push({
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    name: 'lab-a100',
    hostname: '10.0.12.31',
    port: 22,
    username: 'researcher',
    authType: 'key',
    status: 'unreachable',
    lastProbeAt: ago(2 * DAY),
    latencyMs: null,
    createdAt: ago(12 * DAY),
  });

  db.folders.push(
    { id: uuid(), hostId: host.id, path: '/home/clawsgo/workspace', createdAt: ago(28 * DAY) },
    { id: uuid(), hostId: host.id, path: '/home/clawsgo/data', createdAt: ago(20 * DAY) },
  );

  // ---------- 技能 ----------
  const skillDefs = [
    { name: 'arxiv-search', description: '检索 arXiv 预印本，支持按作者、分类、时间窗过滤，返回 BibTeX。', source: 'official', tags: ['research', 'literature'] },
    { name: 'pdf-extract', description: '从 PDF 中抽取正文、表格与公式，输出结构化 Markdown。', source: 'official', tags: ['document', 'parsing'] },
    { name: 'bio-seq-align', description: '序列比对与系统发生树构建（ClustalW/MAFFT 后端）。', source: 'official', tags: ['biology'] },
    { name: 'figure-studio', description: '把数据表一键绘制成出版级图表，自动匹配期刊配色与字体。', source: 'official', tags: ['visualization'] },
    { name: 'matlab-bridge', description: '通过 MATLAB Engine 调用本地 MATLAB 脚本并回收工作区变量。', source: 'github', repo: 'clawsgo/skill-matlab-bridge', tags: ['matlab'] },
    { name: 'rdkit-chem', description: '分子式解析、相似性计算与 2D 结构渲染。', source: 'github', repo: 'clawsgo/skill-rdkit', tags: ['chemistry'] },
    { name: 'wandb-track', description: '把训练指标同步到 Weights & Biases 并生成对比报告。', source: 'github', repo: 'clawsgo/skill-wandb', tags: ['ml', 'tracking'] },
    { name: 'lab-notebook', description: '按实验记录规范生成电子实验记录本条目，支持签名留痕。', source: 'official', tags: ['workflow'] },
  ];
  for (const d of skillDefs) {
    db.skills.push({
      id: uuid(),
      ...d,
      version: '1.0.' + Math.floor(Math.random() * 9),
      enabled: d.source === 'official',
      installedAt: d.source === 'official' ? ago(30 * DAY) : null,
      hostId: d.source === 'official' ? host.id : null,
      files: [
        { path: 'SKILL.md', size: 1200 + Math.floor(Math.random() * 3000) },
        { path: 'scripts/run.py', size: 800 + Math.floor(Math.random() * 5000) },
      ],
      readme: `# ${d.name}\n\n${d.description}\n\n## 用法\n\n在被调用的工作区内直接触发该技能，智能体会自动读取 SKILL.md 并按其流程执行。\n`,
    });
  }

  // ---------- 项目 ----------
  const proj = {
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    name: '钙钛矿太阳能电池稳定性',
    kind: 'explicit',
    instruction: '长期跟踪 MAPbI3 薄膜在湿热条件下的降解路径，产出可复现的实验与仿真对照报告。',
    createdAt: ago(20 * DAY),
    updatedAt: ago(2 * DAY),
    archivedAt: null,
    pinnedAt: ago(19 * DAY),
  };
  db.projects.push(proj);
  const implicit = {
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    name: '未归类',
    kind: 'implicit',
    instruction: null,
    createdAt: ago(30 * DAY),
    updatedAt: ago(1 * HOUR),
    archivedAt: null,
    pinnedAt: null,
  };
  db.projects.push(implicit);

  // ---------- 对话 ----------
  const convDefs = [
    {
      title: '钙钛矿薄膜湿度降解机制梳理',
      projectId: proj.id,
      age: 2 * HOUR,
      q: '帮我梳理 MAPbI3 薄膜在 85%RH / 85℃ 条件下的主要降解路径，并给出可验证的实验判据。',
    },
    {
      title: 'XRD 峰位随退火温度漂移分析',
      projectId: proj.id,
      age: 26 * HOUR,
      q: '我有一组 XRD 数据，退火温度从 80℃ 到 180℃。峰位出现系统性漂移，帮我分析可能原因。',
    },
    {
      title: '写一个批量重命名脚本',
      projectId: implicit.id,
      age: 3 * DAY,
      q: '把 data/raw 下所有 *.csv 按 日期_样品编号.csv 重命名，日期取文件 mtime。',
    },
  ];

  for (const c of convDefs) {
    const conv = {
      id: uuid(),
      teamId: team.id,
      userId: owner.id,
      projectId: c.projectId,
      title: c.title,
      hostId: host.id,
      workdir: '/home/clawsgo/workspace',
      modelId: 'clawsgo-1.0-lithium',
      context: 'default',
      effort: 'high',
      mode: 'agent',
      pinnedAt: null,
      archivedAt: null,
      streamId: null,
      createdAt: ago(c.age + 12 * 60e3),
      updatedAt: ago(c.age),
      lastMessageAt: ago(c.age),
      lastMessagePreview: '',
      lastMessageAttachments: 0,
    };
    db.conversations.push(conv);

    const um = {
      id: uuid(),
      conversationId: conv.id,
      role: 'user',
      seq: 1,
      modelId: null,
      context: null,
      parts: [{ type: 'text', text: c.q }],
      streamId: null,
      metadata: null,
      createdAt: ago(c.age + 11 * 60e3),
    };
    const am = {
      id: uuid(),
      conversationId: conv.id,
      role: 'assistant',
      seq: 2,
      modelId: conv.modelId,
      context: 'default',
      parts: demoAssistantParts(c),
      streamId: null,
      metadata: { usage: { inputTokens: 1840, outputTokens: 962, contextTokens: 2802 }, durationMs: 18400 },
      createdAt: ago(c.age + 10 * 60e3),
    };
    db.messages.push(um, am);
    conv.lastMessagePreview = '已完成降解路径梳理，给出 4 条可验证判据与实验设计。';
    conv.lastMessageAttachments = 1;
  }

  // ---------- 工单 ----------
  const t1 = {
    id: uuid(),
    seq: ++db.counters.ticket,
    teamId: team.id,
    userId: owner.id,
    type: 'technical',
    subject: 'SSH 主机 lab-a100 一直显示离线',
    status: 'open',
    priority: 'normal',
    createdAt: ago(26 * HOUR),
    updatedAt: ago(20 * HOUR),
    lastMessagePreview: '已收到，我们在排查出口网络策略。',
    lastMessageAttachments: 0,
    unreadForUser: 1,
    unreadForAdmin: 0,
  };
  db.tickets.push(t1);
  db.ticketMessages.push(
    { id: uuid(), ticketId: t1.id, authorId: owner.id, authorRole: 'user', body: 'lab-a100 从昨天开始一直离线，probeSshServers 也失败。同网段其他机器正常。', attachments: [], createdAt: ago(26 * HOUR) },
    { id: uuid(), ticketId: t1.id, authorId: admin.id, authorRole: 'admin', body: '已收到，我们在排查出口网络策略。请提供 `ssh -vvv` 的前 30 行输出。', attachments: [], createdAt: ago(20 * HOUR) },
  );

  const t2 = {
    id: uuid(),
    seq: ++db.counters.ticket,
    teamId: team.id,
    userId: owner.id,
    type: 'billing',
    subject: '咨询：Pro 套餐额度如何计费',
    status: 'closed',
    priority: 'low',
    createdAt: ago(9 * DAY),
    updatedAt: ago(8 * DAY),
    lastMessagePreview: '按输出 token 折算点数，明细可在「用量」页查看。',
    lastMessageAttachments: 0,
    unreadForUser: 0,
    unreadForAdmin: 0,
  };
  db.tickets.push(t2);
  db.ticketMessages.push(
    { id: uuid(), ticketId: t2.id, authorId: owner.id, authorRole: 'user', body: 'Pro 套餐的额度是按什么口径扣的？', attachments: [], createdAt: ago(9 * DAY) },
    { id: uuid(), ticketId: t2.id, authorId: admin.id, authorRole: 'admin', body: '按输出 token 折算点数，明细可在「用量」页查看。', attachments: [], createdAt: ago(8 * DAY) },
  );

  // ---------- 公告 ----------
  db.announcements.push({
    id: uuid(),
    titleZh: 'ClawsGO 1.0 Titanium 已上线',
    titleEn: 'ClawsGO 1.0 Titanium is live',
    bodyZh: '新模型在长时程任务上的稳定性提升明显，欢迎在模型选择器中切换体验。',
    bodyEn: 'The new model is noticeably more stable on long-horizon tasks.',
    level: 'info',
    active: true,
    publishedAt: ago(3 * DAY),
    createdAt: ago(3 * DAY),
    createdBy: admin.id,
  });

  // ---------- 邀请码 / 兑换码 ----------
  db.inviteCodes.push(
    { id: uuid(), teamId: team.id, userId: owner.id, code: 'CG-DEMO-2026', name: '默认邀请码', usedCount: 3, maxUses: 20, rewardCredits: 200, active: true, createdAt: ago(30 * DAY) },
  );
  db.redeemCodes.push(
    { id: uuid(), code: 'CLAWSGO-DEMO-1000', credits: 1000, batch: 'demo', usedBy: null, usedAt: null, disabled: false, createdAt: ago(30 * DAY) },
    { id: uuid(), code: 'CLAWSGO-DEMO-2500', credits: 2500, batch: 'demo', usedBy: null, usedAt: null, disabled: false, createdAt: ago(30 * DAY) },
  );

  // ---------- 支付 / 发票 ----------
  // 注意：金额一律用**分**（前端 te(e) = `$${(e/100).toFixed(2)}`）。
  db.paymentOrders.push({
    id: uuid(),
    orderNo: 'CG' + Date.now().toString(36).toUpperCase(),
    teamId: team.id,
    userId: owner.id,
    amountCents: 2990,
    currency: 'CNY',
    provider: 'wechat',
    gateway: 'wechat',
    kind: 'plan',
    planId: 'pro',
    months: 1,
    creditMilli: 12e4 * 1000,
    bonusMilli: 0,
    status: 'paid',
    payUrl: null,
    refundedAt: null,
    paidAt: ago(30 * DAY),
    createdAt: ago(30 * DAY),
    providerTradeNo: 'wx' + Math.random().toString(36).slice(2, 14),
  });
  db.invoices.push({
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    orderId: db.paymentOrders[0].id,
    amount: 2990,
    title: '演示实验室',
    taxNo: '',
    type: 'normal',
    status: 'issued',
    email: 'demo@clawsgo.local',
    invoiceNo: 'INV2026DEMO001',
    createdAt: ago(29 * DAY),
    issuedAt: ago(28 * DAY),
  });

  // ---------- 推广员 ----------
  db.promoters.push({
    id: uuid(),
    userId: owner.id,
    name: '演示用户',
    code: 'CG-DEMO-2026',
    invitedCount: 3,
    paidCount: 2,
    revenue: 598,
    settledAmount: 0,
    unsettledAmount: 59.8,
    createdAt: ago(30 * DAY),
  });

  // ---------- 设备 ----------
  db.devices.push({
    id: uuid(),
    userId: owner.id,
    name: 'Windows 11 Desktop',
    platform: 'win32',
    appVersion: '1.0.0',
    lastSeenAt: ago(4 * 60e3),
    createdAt: ago(20 * DAY),
    revokedAt: null,
  });

  db.auditLogs.push(
    { id: uuid(), actorId: admin.id, action: 'admin.grantPlan', target: owner.id, detail: '授予 pro 套餐', ip: '127.0.0.1', createdAt: ago(29 * DAY) },
    { id: uuid(), actorId: owner.id, action: 'auth.signIn', target: owner.id, detail: '手机号密码登录', ip: '127.0.0.1', createdAt: ago(2 * HOUR) },
  );

  db.agentMemory.push({
    id: uuid(),
    teamId: team.id,
    userId: owner.id,
    scope: 'global',
    key: 'report-format',
    content: '产出实验报告时优先给出「结论 → 证据 → 复现步骤」三段式，图表统一 300dpi。',
    createdAt: ago(18 * DAY),
    updatedAt: ago(18 * DAY),
  });
}

/** 生成演示用的助手消息 parts（含 text / reasoning / tool） */
function demoAssistantParts(c) {
  const parts = [
    { type: 'reasoning', text: '先界定问题边界，再按「机制 → 判据 → 实验」三层组织回答。' },
    {
      type: 'tool',
      toolUseId: 'call_' + Math.random().toString(36).slice(2, 10),
      toolName: 'Glob',
      input: { pattern: 'data/**/*.csv', description: '扫描工作区数据文件' },
      output: 'data/raw/20260301_S1.csv\ndata/raw/20260302_S2.csv\ndata/processed/xrd_summary.csv',
      state: 'output-available',
      durationMs: 420,
    },
    {
      type: 'tool',
      toolUseId: 'call_' + Math.random().toString(36).slice(2, 10),
      toolName: 'TaskCreate',
      input: { subject: '整理降解路径', activeForm: '整理降解路径' },
      output: 'Task #1 created successfully: 整理降解路径',
      state: 'output-available',
      durationMs: 180,
    },
  ];
  parts.push({
    type: 'text',
    text: [
      '## 结论',
      '',
      '在 85%RH / 85℃ 条件下，MAPbI3 的失效**不是单一路径**，而是三条通道耦合的结果：',
      '',
      '1. **水合 → 相变**：生成一水合物 MAPbI3·H2O，晶格膨胀后不可逆分解。',
      '2. **碘空位迁移**：水分显著降低离子迁移活化能，碘空位向界面富集。',
      '3. **界面化学反应**：与 Spiro-OMeTAD 掺杂剂或金属电极发生氧化还原。',
      '',
      '### 可验证判据',
      '',
      '| 判据 | 观测手段 | 预期信号 |',
      '| --- | --- | --- |',
      '| 一水合物生成 | XRD | 2θ ≈ 8.7° 出现新峰 |',
      '| 碘空位富集 | XPS | I 3d 结合能负移 0.2–0.4 eV |',
      '| 界面氧化 | ToF-SIMS | Ag/Au 电极处出现 I⁻ 深度分布 |',
      '',
      '### 复现步骤',
      '',
      '```bash',
      '# 1. 恒定湿热暴露',
      'python scripts/humidity_expose.py --rh 85 --temp 85 --hours 0,24,96,240',
      '',
      '# 2. 逐点 XRD',
      'python scripts/xrd_scan.py --dir data/exposed --out data/processed/xrd_summary.csv',
      '```',
      '',
      '需要我把第 2 步的峰位漂移也一并做定量拟合吗？',
    ].join('\n'),
  });
  return parts;
}

export { demoAssistantParts };

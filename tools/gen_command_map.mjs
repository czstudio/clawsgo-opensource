/**
 * tools/gen_command_map.mjs —— 生成 docs/08-命令实现对照表.md
 *
 * 做法：
 *   1. 从运行中的服务器拉 /__commands 拿到**真实注册表**（不是靠静态分析猜）
 *   2. 在 server/**\/*.mjs 里按名字定位定义处（function / const = async 都可能）
 *   3. 分组成 markdown 表
 *
 * 用法：
 *   node tools/gen_command_map.mjs
 *   BASE=http://127.0.0.1:5181 node tools/gen_command_map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:5181';

const res = await fetch(`${BASE}/__commands`);
if (!res.ok) {
  console.error(`拿不到命令列表（HTTP ${res.status}）—— 服务器在跑吗？`);
  process.exit(1);
}
const { commands } = await res.json();

/* ---------- 收集源码索引 ---------- */
const files = [];
const walk = (dir) => {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === 'data' || n.startsWith('.')) continue;
    const a = path.join(dir, n);
    const st = fs.statSync(a);
    if (st.isDirectory()) walk(a);
    else if (n.endsWith('.mjs')) files.push(a);
  }
};
walk(path.join(ROOT, 'server'));

const index = new Map();
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m =
      line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/) ||
      line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[\w,\s{}]*\)?\s*=>/);
    if (!m) return;
    const name = m[1];
    if (!index.has(name)) index.set(name, { file: rel, line: i + 1 });
  });
}

/* ---------- 分组（顺序即优先级） ---------- */
const CONV_RX =
  /^(get|list|search|update|create|delete|archive|clone|unarchive|move|copy|rename)Conversation|^getMessages|^sendMessage|^getProjects?|^createProject|^updateProject|^deleteProject|^archiveProject|^unarchiveProject|^cloneProject|^getShared|^shareConversation|^searchAll|^getArchived|^getModels|^getModelUsage|^answerPermission|^abort|^getConversation/;
const FILE_RX =
  /File|Entry|Dir|Figure|Zip|Upload|Download|Glob|Grep|Bash|Todo|WebFetch|WebSearch|Terminal|Latex|Tex|Office|Link|Direct/;
const HOST_RX = /^(get|create|update|delete|rebuild|clean|probe)Host|^getSsh|^createSsh|^updateSsh|^deleteSsh|Directory/;
const BILL_RX = /Plan|Subscription|Payment|Invoice|Credit|Topup|Redeem|Quote|Billing|Usage/;
const TEAM_RX = /Team|Member|Invitation|Invite|Promoter|Referral|Cohort/;
const TICKET_RX = /Ticket|Announcement|Support|Feedback/;
const ACCT_RX = /Profile|Device|AgentMemory|AgentFile|Avatar|Auth|Session|Phone|Password|Otp/;
const OPS_RX = /Migration|AuditLog|^getUsers$|Overview|Dashboard|Stats/;

const GROUP_RX = [
  [/^admin/, '管理后台'],
  [CONV_RX, '会话与消息'],
  [FILE_RX, '工作区 / 文件 / 终端'],
  [/Skill/i, '技能库'],
  [HOST_RX, '主机与 SSH'],
  [BILL_RX, '计费与订单'],
  [TEAM_RX, '团队与增长'],
  [TICKET_RX, '工单与公告'],
  [ACCT_RX, '账号与设备'],
  [OPS_RX, '后台运维'],
];

const groupOf = (cmd) => {
  for (const [rx, name] of GROUP_RX) if (rx.test(cmd)) return name;
  return '其它';
};

const groups = new Map();
for (const cmd of [...commands].sort()) {
  const g = groupOf(cmd);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(cmd);
}

/* ---------- 输出 ---------- */
const order = [
  '会话与消息',
  '工作区 / 文件 / 终端',
  '技能库',
  '主机与 SSH',
  '计费与订单',
  '团队与增长',
  '工单与公告',
  '账号与设备',
  '管理后台',
  '后台运维',
  '其它',
];

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
let md = `# 命令实现对照表

本文件由 \`tools/gen_command_map.mjs\` 自动生成（${now}），**不要手改**。

- 命令清单来自运行中服务的 \`/__commands\` 自省端点 → 就是真正注册进去的那批，不是静态分析猜的
- 实现位置由源码扫描得到（\`server/**/*.mjs\` 里的 \`function name(\` / \`const name = (...)\`)
- 共 **${commands.length}** 条命令

> 说明：同一条命令可能有「注册别名」。例如 \`adminCreateFileLink\` 与 \`createFileLink\`
> 共用 \`server/lib/office.mjs\` 里的 \`createFileLinkRecord\`，只是权限校验不同，
> 因此下表会看到同一条命令名不是函数名、而是走别名映射的情况。

`;

for (const g of order) {
  const rows = groups.get(g);
  if (!rows?.length) continue;
  md += `## ${g}（${rows.length}）\n\n| 命令 | 实现位置 |\n| --- | --- |\n`;
  for (const cmd of rows) {
    const hit = index.get(cmd);
    md += `| \`${cmd}\` | ${hit ? `\`${hit.file}:${hit.line}\`` : '别名 / 组合实现'} |\n`;
  }
  md += '\n';
}

const out = path.join(ROOT, 'docs', '08-命令实现对照表.md');
fs.writeFileSync(out, md, 'utf8');
console.log(`已写入 ${path.relative(ROOT, out)}：${commands.length} 条命令，${groups.size} 个分组`);
for (const g of order) if (groups.get(g)) console.log(`  · ${g}: ${groups.get(g).length}`);

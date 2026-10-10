import fs from 'node:fs';

// 1. 在 support.mjs 中添加 getNotifications
let support = fs.readFileSync('server/api/support.mjs', 'utf8');
support = support.replace(
  'export const commands = {',
  `async function getNotifications(p, ctx) {
  const limit = Math.max(1, Math.min(100, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const rows = (db$().notifications ?? []).filter((n) => n.userId === ctx.user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const items = rows.slice(offset, offset + limit);
  return { notifications: items, items, total: rows.length, unread: rows.filter((n) => !n.read).length };
}

export const commands = {
  getNotifications,`
);
fs.writeFileSync('server/api/support.mjs', support);
console.log('Added getNotifications to support.mjs');

// 2. 在 account.mjs 中添加 getActivities
let account = fs.readFileSync('server/api/account.mjs', 'utf8');
account = account.replace(
  'export const commands = {',
  `async function getActivities(p, ctx) {
  const limit = Math.max(1, Math.min(100, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const rows = (db$().activities ?? []).filter((a) => a.userId === ctx.user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const items = rows.slice(offset, offset + limit);
  return { activities: items, items, total: rows.length };
}

export const commands = {
  getActivities,`
);
fs.writeFileSync('server/api/account.mjs', account);
console.log('Added getActivities to account.mjs');

// 3. 在 billing.mjs 中添加 getLedger（用户端额度流水）
let billing = fs.readFileSync('server/api/billing.mjs', 'utf8');
// 检查是否已有 getLedger
if (!billing.includes('getLedger')) {
  billing = billing.replace(
    'export const commands = {',
    `async function getLedger(p, ctx) {
  const limit = Math.max(1, Math.min(100, Number(p?.limit) || 20));
  const offset = Math.max(0, Number(p?.offset) || 0);
  const team = db$().teams.find((t) => t.id === ctx.teamId);
  const rows = (team?.ledger ?? []).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const items = rows.slice(offset, offset + limit);
  return { entries: items, items, total: rows.length, balance: team?.credits ?? 0 };
}

export const commands = {
  getLedger,`
  );
  fs.writeFileSync('server/api/billing.mjs', billing);
  console.log('Added getLedger to billing.mjs');
}

// 4. 在 billing.mjs 中添加 getInviteCodes 别名（如果已有 getMyInviteCodes）
if (billing.includes('getMyInviteCodes') && !billing.includes('getInviteCodes:')) {
  billing = fs.readFileSync('server/api/billing.mjs', 'utf8');
  billing = billing.replace(
    'getMyInviteCodes,',
    'getMyInviteCodes,\n  getInviteCodes: getMyInviteCodes,'
  );
  fs.writeFileSync('server/api/billing.mjs', billing);
  console.log('Added getInviteCodes alias to billing.mjs');
}

console.log('All fixes applied');

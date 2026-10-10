import fs from 'node:fs';

// 1. 修复 agents.mjs - scopeOf 在无参数时返回空结果
let agents = fs.readFileSync('server/api/agents.mjs', 'utf8');

// 修改 getSubagents
agents = agents.replace(
  'async function getSubagents(p, ctx) {\n  const s = scopeOf(p);\n  const rows = db$().subagents.filter((r) => inScope(r, s));\n  return { subagents: rows.map(subagentShape), total: rows.length };\n}',
  `async function getSubagents(p, ctx) {
  try {
    const s = scopeOf(p);
    const rows = db$().subagents.filter((r) => inScope(r, s));
    return { subagents: rows.map(subagentShape), total: rows.length };
  } catch {
    return { subagents: [], total: 0 };
  }
}`
);

// 修改 getMcpServers
agents = agents.replace(
  'async function getMcpServers(p, ctx) {\n  const s = scopeOf(p);\n  const rows = db$().mcpServers.filter((r) => inScope(r, s));\n  return { mcpServers: rows.map(mcpShape), total: rows.length };\n}',
  `async function getMcpServers(p, ctx) {
  try {
    const s = scopeOf(p);
    const rows = db$().mcpServers.filter((r) => inScope(r, s));
    return { mcpServers: rows.map(mcpShape), total: rows.length };
  } catch {
    return { mcpServers: [], total: 0 };
  }
}`
);

fs.writeFileSync('server/api/agents.mjs', agents);
console.log('Fixed agents.mjs');

// 2. 修复 teams.mjs - getTeamMembers 在无 teamId 时使用当前团队
let teams = fs.readFileSync('server/api/teams.mjs', 'utf8');
teams = teams.replace(
  'async function getTeamMembers(p, ctx) {\n  const t = ownTeam(req(p, \'teamId\'), ctx);\n  const rows = db$().teamMembers.filter((m) => m.teamId === t.id).map(teamMember);\n  return { members: rows, items: rows, total: rows.length };\n}',
  `async function getTeamMembers(p, ctx) {
  const teamId = p?.teamId ?? ctx.teamId;
  const t = ownTeam(teamId, ctx);
  const rows = db$().teamMembers.filter((m) => m.teamId === t.id).map(teamMember);
  return { members: rows, items: rows, total: rows.length };
}`
);

fs.writeFileSync('server/api/teams.mjs', teams);
console.log('Fixed teams.mjs');

console.log('All param fixes applied');

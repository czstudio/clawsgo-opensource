// /api/teams —— 团队、成员、邀请。
//
// 契约来源：app/assets 团队设置页（getTeams / getTeamMembers / getTeamInvitations /
//           getMyInvitations）+ _shell-CSlH67JO.js 的 useCurrentTeam 兜底逻辑。
//
// 关键还原点：**个人团队的 id 必须等于 owner 的用户 id**。
// 前端 useCurrentTeam 在 localStorage 没有选中团队时，用 `team.id === team.userId`
// 来定位默认团队；不满足这个不变量，登录后会没有当前团队、整个应用空白。
import { db$, uuid, now, save } from '../lib/db.mjs';
import { team, teamMember, teamInvitation, profile } from '../lib/shapes.mjs';
import { req, notFound, need, conflict, forbidden, badRequest } from '../lib/errors.mjs';

function memberOf(teamId, userId) {
  return db$().teamMembers.find((m) => m.teamId === teamId && m.userId === userId);
}

function ownTeam(teamId, ctx, { requireAdmin = false } = {}) {
  const t = db$().teams.find((x) => x.id === teamId);
  if (!t) notFound('团队');
  const mem = memberOf(teamId, ctx.user.id);
  if (!mem && ctx.user.role !== 'super_admin') forbidden('不属于该团队');
  if (requireAdmin && !['owner', 'admin'].includes(mem?.role) && ctx.user.role !== 'super_admin') {
    forbidden('需要管理员权限');
  }
  return t;
}

/* ------------------------------------------------------------------ */

async function getTeams(p, ctx) {
  const db = db$();
  const ids = db.teamMembers.filter((m) => m.userId === ctx.user.id).map((m) => m.teamId);
  const rows = db.teams.filter((t) => ids.includes(t.id) || t.ownerId === ctx.user.id || ctx.user.role === 'super_admin');
  const teams = rows.map((t) => team(t, ctx.user.id));
  return { teams, items: teams, total: teams.length };
}

async function createTeam(p, ctx) {
  const name = String(p?.name ?? '').trim();
  if (!name) throw badRequest('团队名称不能为空', 'INVALID_TEAM_NAME');
  const t = {
    id: uuid(),
    name,
    ownerId: ctx.user.id,
    plan: 'free',
    memberLimit: Number(p?.memberLimit) || 3,
    creditBalance: 0,
    createdAt: now(),
  };
  db$().teams.push(t);
  db$().teamMembers.push({ id: uuid(), teamId: t.id, userId: ctx.user.id, role: 'owner', joinedAt: now() });
  save();
  return { team: team(t, ctx.user.id) };
}

async function updateTeam(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx, { requireAdmin: true });
  if (p?.name !== undefined) {
    const name = String(p.name).trim();
    if (!name) throw badRequest('团队名称不能为空', 'INVALID_TEAM_NAME');
    t.name = name;
  }
  save();
  return { team: team(t, ctx.user.id) };
}

async function deleteTeam(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx);
  if (t.id === ctx.user.id) throw badRequest('个人空间不可删除', 'PERSONAL_TEAM');
  need(t.ownerId === ctx.user.id || ctx.user.role === 'super_admin', 'FORBIDDEN', '只有所有者可以解散团队', 403);
  const db = db$();
  db.teams = db.teams.filter((x) => x.id !== t.id);
  db.teamMembers = db.teamMembers.filter((m) => m.teamId !== t.id);
  db.teamInvitations = db.teamInvitations.filter((i) => i.teamId !== t.id);
  save();
  return { ok: true, id: t.id };
}

async function setMemberLimit(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx, { requireAdmin: true });
  const limit = Number(p?.memberLimit);
  if (!Number.isFinite(limit) || limit < 1) throw badRequest('成员上限不合法');
  const count = db$().teamMembers.filter((m) => m.teamId === t.id).length;
  if (limit < count) conflict(`当前已有 ${count} 名成员，上限不能低于此数`);
  t.memberLimit = limit;
  save();
  return { team: team(t, ctx.user.id), ok: true };
}

/* ------------------------------------------------------------------ */
/* 成员                                                                */
/* ------------------------------------------------------------------ */

async function getTeamMembers(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx);
  const rows = db$().teamMembers.filter((m) => m.teamId === t.id).map(teamMember);
  return { members: rows, items: rows, total: rows.length };
}

async function removeTeamMember(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx, { requireAdmin: true });
  const userId = req(p, 'userId');
  if (userId === t.ownerId) throw badRequest('不能移除团队所有者', 'CANNOT_REMOVE_OWNER');
  const db = db$();
  const before = db.teamMembers.length;
  db.teamMembers = db.teamMembers.filter((m) => !(m.teamId === t.id && m.userId === userId));
  if (db.teamMembers.length === before) notFound('成员');
  save();
  return { ok: true };
}

async function updateTeamMemberRole(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx, { requireAdmin: true });
  const role = req(p, 'role');
  if (!['admin', 'member'].includes(role)) throw badRequest('角色只能是 admin 或 member');
  const m = memberOf(t.id, req(p, 'userId'));
  if (!m) notFound('成员');
  if (m.role === 'owner') throw badRequest('不能修改所有者的角色', 'CANNOT_CHANGE_OWNER');
  need(m.role !== 'owner', 'FORBIDDEN', '不能修改所有者角色', 403);
  m.role = role;
  save();
  return { ok: true, member: teamMember(m) };
}

async function transferTeamOwnership(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx);
  need(t.ownerId === ctx.user.id || ctx.user.role === 'super_admin', 'FORBIDDEN', '只有所有者可以转让团队', 403);
  const target = memberOf(t.id, req(p, 'userId'));
  if (!target) notFound('成员');
  const me = memberOf(t.id, ctx.user.id);
  if (me) me.role = 'admin';
  target.role = 'owner';
  t.ownerId = target.userId;
  save();
  return { ok: true, team: team(t, ctx.user.id) };
}

async function leaveTeam(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx);
  if (t.ownerId === ctx.user.id) throw badRequest('所有者不能直接退出，请先转让团队', 'OWNER_CANNOT_LEAVE');
  const db = db$();
  db.teamMembers = db.teamMembers.filter((m) => !(m.teamId === t.id && m.userId === ctx.user.id));
  save();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 邀请                                                                */
/* ------------------------------------------------------------------ */

async function getTeamInvitations(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx);
  const rows = db$().teamInvitations.filter((i) => i.teamId === t.id).map(teamInvitation);
  return { invitations: rows, items: rows, total: rows.length };
}

async function createTeamInvitation(p, ctx) {
  const t = ownTeam(req(p, 'teamId'), ctx, { requireAdmin: true });
  const phone = p?.phone ? normalizePhone(p.phone) : null;
  const email = p?.email ? String(p.email).trim().toLowerCase() : null;
  if (!phone && !email) throw badRequest('需要手机号或邮箱', 'INVALID_INVITEE');

  const db = db$();
  // 已是成员就不必邀请
  const targetUser = phone
    ? db.users.find((u) => u.phone === phone)
    : db.users.find((u) => (u.email ?? '').toLowerCase() === email);
  if (targetUser && memberOf(t.id, targetUser.id)) conflict('该用户已是团队成员');
  if (db.teamInvitations.some((i) => i.teamId === t.id && i.status === 'pending' && ((phone && i.phone === phone) || (email && i.email === email)))) {
    conflict('已存在待接受的邀请');
  }

  const inv = {
    id: uuid(),
    teamId: t.id,
    inviterId: ctx.user.id,
    inviteeId: targetUser?.id ?? null,
    phone,
    email,
    role: ['admin', 'member'].includes(p?.role) ? p.role : 'member',
    status: 'pending',
    createdAt: now(),
    expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
  };
  db.teamInvitations.push(inv);
  save();
  return { invitation: teamInvitation(inv), ok: true };
}

async function cancelTeamInvitation(p, ctx) {
  const inv = db$().teamInvitations.find((i) => i.id === req(p, 'invitationId'));
  if (!inv) notFound('邀请');
  ownTeam(inv.teamId, ctx, { requireAdmin: true });
  inv.status = 'cancelled';
  save();
  return { ok: true };
}

async function getMyInvitations(p, ctx) {
  const db = db$();
  const phone = ctx.user.phone;
  const email = (ctx.user.email ?? '').toLowerCase();
  const rows = db.teamInvitations
    .filter((i) => i.status === 'pending' && (i.inviteeId === ctx.user.id || (phone && i.phone === phone) || (email && i.email === email)))
    .map((i) => {
      const base = teamInvitation(i);
      const t = db.teams.find((x) => x.id === i.teamId);
      const inviter = db.users.find((u) => u.id === i.inviterId);
      return {
        ...base,
        teamName: t?.name ?? null,
        team: t ? team(t, t.ownerId) : null,
        inviterName: inviter?.name ?? null,
        inviter: inviter ? profile(inviter.id) : null,
      };
    });
  return { invitations: rows, items: rows, total: rows.length };
}

async function acceptTeamInvitation(p, ctx) {
  const db = db$();
  const inv = db.teamInvitations.find((i) => i.id === req(p, 'invitationId'));
  if (!inv) notFound('邀请');
  if (inv.status !== 'pending') throw badRequest('邀请已失效', 'INVITATION_NOT_PENDING');
  if (inv.expiresAt && Date.parse(inv.expiresAt) < Date.now()) {
    inv.status = 'expired';
    save();
    throw badRequest('邀请已过期', 'INVITATION_EXPIRED');
  }
  const t = db.teams.find((x) => x.id === inv.teamId);
  if (!t) notFound('团队');
  const count = db.teamMembers.filter((m) => m.teamId === t.id).length;
  if (count >= (t.memberLimit ?? 3)) conflict('团队席位已满', 'TEAM_FULL');

  if (!memberOf(t.id, ctx.user.id)) {
    db.teamMembers.push({
      id: uuid(),
      teamId: t.id,
      userId: ctx.user.id,
      role: inv.role ?? 'member',
      joinedAt: now(),
    });
  }
  inv.status = 'accepted';
  inv.inviteeId = ctx.user.id;
  save();
  return { ok: true, team: team(t, ctx.user.id) };
}

async function rejectTeamInvitation(p, ctx) {
  const inv = db$().teamInvitations.find((i) => i.id === req(p, 'invitationId'));
  if (!inv) notFound('邀请');
  inv.status = 'rejected';
  save();
  return { ok: true };
}

/** 邀请码加入（claimInvite）：用邀请码把自己的账号挂进某个团队 */
async function claimInvite(p, ctx) {
  const code = String(p?.code ?? '').trim().toUpperCase();
  if (!code) throw badRequest('缺少邀请码', 'INVALID_INVITE_CODE');
  const db = db$();
  const ic = db.inviteCodes.find((c) => c.code.toUpperCase() === code && c.active !== false);
  if (!ic) throw badRequest('邀请码无效', 'INVALID_INVITE_CODE');
  if (ic.maxUses && (ic.usedCount ?? 0) >= ic.maxUses) throw badRequest('邀请码已用尽', 'INVITE_CODE_EXHAUSTED');

  let t = db.teams.find((x) => x.id === ic.teamId);
  if (!t) notFound('团队');
  if (!memberOf(t.id, ctx.user.id)) {
    db.teamMembers.push({ id: uuid(), teamId: t.id, userId: ctx.user.id, role: 'member', joinedAt: now() });
  }
  ic.usedCount = (ic.usedCount ?? 0) + 1;
  ic.usedBy = ctx.user.id;

  if (ic.rewardCredits) {
    t.creditBalance = (t.creditBalance ?? 0) + ic.rewardCredits;
    db.creditLedger.push({
      id: uuid(),
      teamId: t.id,
      userId: ctx.user.id,
      delta: ic.rewardCredits,
      reason: 'invite_reward',
      balanceAfter: t.creditBalance,
      note: `邀请码 ${code}`,
      createdAt: now(),
    });
  }
  save();
  return { ok: true, team: team(t, ctx.user.id), credits: ic.rewardCredits ?? 0 };
}

/* ------------------------------------------------------------------ */

function normalizePhone(v) {
  const digits = String(v).replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+86' + digits;
  if (digits.length === 13 && digits.startsWith('86')) return '+' + digits;
  return '+' + digits;
}

export const commands = {
  getTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  setMemberLimit,
  getTeamMembers,
  removeTeamMember,
  updateTeamMemberRole,
  transferTeamOwnership,
  leaveTeam,
  getTeamInvitations,
  createTeamInvitation,
  cancelTeamInvitation,
  getMyInvitations,
  acceptTeamInvitation,
  rejectTeamInvitation,
  claimInvite,
};

// /api/auth/* —— 认证、会话、设备注册。
// 响应不加 {data} 包装（前端 auth 客户端直接返回整个 JSON 体）。
// 错误以 {code, message} 顶层返回；token 通过 set-auth-token 响应头轮换。
import { db$, uuid, now, save, rid } from '../lib/db.mjs';
import { seedIfEmpty, DEMO } from '../lib/seed.mjs';
import { profile } from '../lib/shapes.mjs';

/** requestId → {phoneNumber, code, expiresAt, attempts} */
export const otpStore = new Map();
/** token → {userId, createdAt, expiresAt}；持久化进 db.json（生产滚动重启不掉登录的对应语义） */
export const tokens = new Map();
try {
  for (const [k, v] of Object.entries(db$().authTokens ?? {})) {
    if (!v?.expiresAt || v.expiresAt > Date.now()) tokens.set(k, v);
  }
} catch { /* 首次启动 db 未加载时忽略 */ }
/** 一次性登录码 */
const oneTimeTokens = new Map();

const OTP_TTL = 5 * 60e3;
const OTP_MAX_ATTEMPTS = 5;
let lastSendAt = 0;

const isPhone = (p) => /^\+86\d{11}$/.test(String(p ?? ''));

function ok(res, body, token) {
  if (token) res.setHeader('set-auth-token', token);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function fail(res, code, message, status = 400, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, message, ...extra }));
}

/** token 有效期：30 天（生产为滚动续期，这里用 expiresAt 实现同样的语义） */
const TOKEN_TTL = 30 * 864e5;

export function issueToken(userId) {
  const token = 'cgt_' + rid(40);
  tokens.set(token, { userId, createdAt: now(), expiresAt: Date.now() + TOKEN_TTL });
  try {
    const db = db$();
    db.authTokens = Object.fromEntries(tokens);
    save({ immediate: true });
  } catch { /* 持久化失败不影响登录 */ }
  return token;
}

export function userFromAuthHeader(header) {
  const m = /^Bearer\s+(.+)$/.exec(String(header ?? ''));
  if (!m) return null;
  const key = m[1].trim();
  const rec = tokens.get(key);
  if (!rec) return null;
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    tokens.delete(key);
    return null;
  }
  return db$().users.find((u) => u.id === rec.userId) ?? null;
}

export function userFromRequest(req) {
  return userFromAuthHeader(req.headers.authorization);
}

function ensureUser(phoneE164) {
  const db = db$();
  let u = db.users.find((x) => x.phone === phoneE164);
  if (!u) {
    u = {
      id: uuid(),
      phone: phoneE164,
      email: null,
      name: '用户' + phoneE164.slice(-4),
      avatarUrl: null,
      role: 'user',
      locale: 'zh-CN',
      theme: 'dark',
      plan: 'free',
      onboardedAt: null,
      createdAt: now(),
      banned: false,
      banReason: null,
      password: null,
      inviteCode: null,
    };
    db.users.push(u);
    // 新用户自动获得个人团队，team.id === user.id
    const team = {
      id: u.id,
      name: u.name + ' 的空间',
      ownerId: u.id,
      plan: 'free',
      memberLimit: 3,
      creditBalance: 500,
      createdAt: now(),
    };
    db.teams.push(team);
    db.teamMembers.push({ id: uuid(), teamId: team.id, userId: u.id, role: 'owner', joinedAt: now() });
    db.creditLedger.push({
      id: uuid(),
      teamId: team.id,
      userId: u.id,
      delta: 500,
      reason: 'signup_bonus',
      balanceAfter: 500,
      note: '注册赠送',
      createdAt: now(),
    });
    db.subscriptions.push({
      id: uuid(),
      teamId: team.id,
      plan: 'free',
      status: 'active',
      seats: 1,
      priceMonthly: 0,
      currency: 'CNY',
      currentPeriodEnd: null,
      createdAt: now(),
    });
    save();
  }
  return u;
}

function loginResponse(user) {
  return {
    userId: user.id,
    token: null, // 由 set-auth-token 头承载
    user: profile(user.id),
    needOnboard: !user.onboardedAt,
  };
}

/** 分发 /api/auth/<cmd>。返回 true 表示已处理。 */
export async function handleAuth(req, res, cmd, body, query) {
  seedIfEmpty();
  const db = db$();

  // ---------- GET：会话探针 ----------
  if (req.method === 'GET') {
    const u = userFromRequest(req);
    if (cmd === 'session') {
      if (!u) return fail(res, 'UNAUTHORIZED', '未登录', 401), true;
      return ok(res, { user: profile(u.id) }), true;
    }
    if (!u) return fail(res, 'UNAUTHORIZED', '未登录', 401), true;
    return fail(res, 'NOT_FOUND', `未知 auth 命令 ${cmd}`, 404), true;
  }

  // ---------- POST ----------
  if (cmd === 'phone-number/send-otp') {
    const phone = body?.phoneNumber;
    if (!isPhone(phone)) return fail(res, 'INVALID_PHONE_NUMBER', '手机号格式不正确'), true;
    const nowMs = Date.now();
    if (nowMs - lastSendAt < 1000) return fail(res, 'SEND_OTP_RATE_LIMITED', '发送过于频繁，请稍后再试', 429), true;
    lastSendAt = nowMs;
    const requestId = uuid();
    otpStore.set(requestId, {
      phoneNumber: phone,
      code: DEMO.otp,
      expiresAt: nowMs + OTP_TTL,
      attempts: 0,
    });
    // 演示环境把验证码直接回给客户端（生产不返回）
    return ok(res, { requestId, expiresAt: new Date(nowMs + OTP_TTL).toISOString(), devCode: DEMO.otp }), true;
  }

  if (cmd === 'phone-number/verify') {
    const phone = body?.phoneNumber;
    const code = String(body?.code ?? '');
    if (!isPhone(phone)) return fail(res, 'INVALID_PHONE_NUMBER', '手机号格式不正确'), true;
    const rec = [...otpStore.values()].reverse().find((r) => r.phoneNumber === phone);
    if (!rec) return fail(res, 'OTP_NOT_FOUND', '验证码已失效，请重新获取'), true;
    if (Date.now() > rec.expiresAt) {
      otpStore.delete([...otpStore.keys()].find((k) => otpStore.get(k) === rec));
      return fail(res, 'OTP_EXPIRED', '验证码已过期'), true;
    }
    if (rec.attempts >= OTP_MAX_ATTEMPTS) return fail(res, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请重新获取'), true;
    if (rec.code !== code) {
      rec.attempts++;
      return fail(res, 'INVALID_OTP', '验证码不正确'), true;
    }
    const u = ensureUser(phone);
    if (u.banned) return fail(res, 'USER_BANNED', '账号已被封禁', 403, { banReason: u.banReason ?? '' }), true;
    return ok(res, loginResponse(u), issueToken(u.id)), true;
  }

  if (cmd === 'sign-in/phone-number') {
    const phone = body?.phoneNumber;
    const password = String(body?.password ?? '');
    if (!isPhone(phone)) return fail(res, 'INVALID_PHONE_NUMBER', '手机号格式不正确'), true;
    if (password.length < 8) return fail(res, 'PASSWORD_TOO_SHORT', '密码至少 8 位'), true;
    const u = db.users.find((x) => x.phone === phone);
    if (!u || u.password !== password) {
      return fail(res, 'INVALID_PHONE_NUMBER_OR_PASSWORD', '手机号或密码不正确'), true;
    }
    if (u.banned) return fail(res, 'USER_BANNED', '账号已被封禁', 403, { banReason: u.banReason ?? '' }), true;
    return ok(res, loginResponse(u), issueToken(u.id)), true;
  }

  if (cmd === 'phone-number/request-password-reset') {
    const phone = body?.phoneNumber;
    if (!isPhone(phone)) return fail(res, 'INVALID_PHONE_NUMBER', '手机号格式不正确'), true;
    const requestId = uuid();
    otpStore.set(requestId, {
      phoneNumber: phone,
      code: DEMO.otp,
      expiresAt: Date.now() + OTP_TTL,
      attempts: 0,
      reset: true,
    });
    return ok(res, { requestId, devCode: DEMO.otp }), true;
  }

  if (cmd === 'phone-number/reset-password') {
    const phone = body?.phoneNumber;
    const code = String(body?.code ?? '');
    const password = String(body?.password ?? '');
    if (!isPhone(phone)) return fail(res, 'INVALID_PHONE_NUMBER', '手机号格式不正确'), true;
    if (password.length < 8) return fail(res, 'PASSWORD_TOO_SHORT', '密码至少 8 位'), true;
    const rec = [...otpStore.values()].reverse().find((r) => r.phoneNumber === phone && r.reset);
    if (!rec) return fail(res, 'OTP_NOT_FOUND', '验证码已失效'), true;
    if (rec.code !== code) return fail(res, 'INVALID_OTP', '验证码不正确'), true;
    const u = db.users.find((x) => x.phone === phone);
    if (!u) return fail(res, 'INVALID_PHONE_NUMBER', '手机号未注册'), true;
    u.password = password;
    save();
    return ok(res, { ok: true }), true;
  }

  if (cmd === 'one-time-token/generate') {
    const u = userFromRequest(req);
    if (!u) return fail(res, 'UNAUTHORIZED', '未登录', 401), true;
    const token = rid(8).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2');
    oneTimeTokens.set(token, { userId: u.id, expiresAt: Date.now() + 3 * 60e3, used: false });
    return ok(res, { token, expiresAt: new Date(Date.now() + 3 * 60e3).toISOString() }), true;
  }

  if (cmd === 'one-time-token/verify') {
    const token = String(body?.token ?? '').trim().toUpperCase();
    const rec = oneTimeTokens.get(token);
    if (!rec || rec.used || Date.now() > rec.expiresAt) {
      return fail(res, 'INVALID_OTP', '登录代码无效或已过期，请重新获取。'), true;
    }
    rec.used = true;
    const u = db.users.find((x) => x.id === rec.userId);
    if (!u) return fail(res, 'UNAUTHORIZED', '用户不存在', 401), true;
    return ok(res, loginResponse(u), issueToken(u.id)), true;
  }

  if (cmd === 'sign-out') {
    const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization ?? ''));
    if (m) tokens.delete(m[1].trim());
    return ok(res, { ok: true }), true;
  }

  return fail(res, 'NOT_FOUND', `未知 auth 命令 ${cmd}`, 404), true;
}

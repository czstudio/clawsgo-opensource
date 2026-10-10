// /api 分发器 —— 把 204 条 RPC 命令、SSE 双通道、桌面直连文件网关、终端 WS 接到一起。
//
// 传输契约（还原自 app/assets/api-pyi_9PXn.js）：
//   Q(cmd, payload)   POST /api/{cmd}       body {"data": payload}   → resp.data
//   _e(cmd, payload)  POST /api/{cmd}       body {"data": payload}   → 二进制（带 content-disposition）
//   ye(cmd, query, raw) POST /api/{cmd}?query  原始 body             → resp.data
//   ve(cmd, raw)      POST /api/{cmd}      原始 body                 → resp.data
//   认证             POST /api/auth/{cmd}  顶层 {code,message} 错误 + set-auth-token 头
//   SSE              POST /api/subscribeEvents        body {}                       （raw）
//                    POST /api/watchConversationFiles body {"data":{conversationId}}（raw）
//
// 未授权统一返回 {error:{code:'UNAUTHORIZED'}} 401，前端据此清 token 并跳 /login?redirect=..
import fs from 'node:fs';
import path from 'node:path';
import { db$, save } from '../lib/db.mjs';
import { seedIfEmpty } from '../lib/seed.mjs';
import { personalTeamFor } from '../lib/shapes.mjs';
import { hub } from '../lib/sse.mjs';
import { workspaceDir, safeJoin } from '../lib/workspace.mjs';
import { ApiError } from '../lib/errors.mjs';
import { handleAuth, userFromRequest, issueToken, tokens } from './auth.mjs';
import { parseMultipart, textFields } from '../lib/multipart.mjs';

import { commands as chatCommands } from './chat.mjs';
import { commands as fileCommands } from './files.mjs';
import { commands as accountCommands } from './account.mjs';
import { commands as hostCommands } from './hosts.mjs';
import { commands as skillCommands } from './skills.mjs';
import { commands as teamCommands } from './teams.mjs';
import { commands as billingCommands } from './billing.mjs';
import { commands as supportCommands } from './support.mjs';
import { commands as adminCommands } from './admin.mjs';
import { commands as cardCommands } from './cards.mjs';
import { commands as projectCommands } from './projects.mjs';
import { commands as agentCommands } from './agents.mjs';
import { commands as imageCommands } from './images.mjs';

/* ------------------------------------------------------------------ */
/* 命令注册表                                                          */
/* ------------------------------------------------------------------ */

export const COMMANDS = Object.assign(
  Object.create(null),
  accountCommands,
  teamCommands,
  hostCommands,
  skillCommands,
  chatCommands,
  fileCommands,
  billingCommands,
  supportCommands,
  adminCommands,
  cardCommands,
  projectCommands,
  agentCommands,
  imageCommands,
);

export const commandNames = () => Object.keys(COMMANDS).sort();

/* ------------------------------------------------------------------ */
/* HTTP 小工具                                                         */
/* ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Expose-Headers':
    'set-auth-token,content-disposition,content-type,content-length,authorization',
};

export function sendJSON(res, payload, status = 200, extra = {}) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...CORS,
    ...extra,
  });
  res.end(buf);
}

function sendRaw(res, buf, { status = 200, contentType, disposition } = {}) {
  res.writeHead(status, {
    'Content-Type': contentType ?? 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...(disposition ? { 'Content-Disposition': disposition } : {}),
    ...CORS,
  });
  res.end(buf);
}

function fail(res, err) {
  const code = err instanceof ApiError ? err.code : err?.code ?? 'INTERNAL';
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) console.error('[api]', err);
  return sendJSON(res, { error: { code, message: String(err?.message ?? err) } }, status);
}

/* ------------------------------------------------------------------ */
/* 请求解析                                                            */
/* ------------------------------------------------------------------ */

const MAX_BODY = 64 * 1024 * 1024;

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      const e = new ApiError('PAYLOAD_TOO_LARGE', '请求体过大（上限 64MB）', 413);
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseJSONBody(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ApiError('BAD_JSON', '请求体不是合法 JSON', 400);
  }
}

/**
 * 决定命令的 payload。四条通道分别对应前端 api-pyi 的四种调用方式：
 *   application/json          → Q(cmd, payload)  信封 {"data": payload}，取 .data
 *   multipart/form-data       → ve(cmd, formData) 取文本字段（文件在 files 里）
 *   application/x-www-form-urlencoded → 表单
 *   其它（原始 body）          → ye(cmd, query, raw) **参数在 query string 上**，body 是原始字节
 * 最后这条很关键：漏了 query 回退，上传类命令就会报「缺少参数 conversationId」。
 */
function payloadFrom(req, buf, url) {
  const ct = String(req.headers['content-type'] ?? '');
  const q = url ? Object.fromEntries(url.searchParams.entries()) : {};
  if (ct.includes('application/json')) {
    const body = parseJSONBody(buf);
    return { payload: body?.data ?? body, raw: null, files: null };
  }
  if (ct.includes('multipart/form-data')) {
    const fields = parseMultipart(buf, ct);
    return { payload: { ...q, ...textFields(fields) }, raw: null, files: fields };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return { payload: { ...q, ...Object.fromEntries(new URLSearchParams(buf.toString('utf8'))) }, raw: null, files: null };
  }
  return { payload: q, raw: buf, files: null };
}

/* ------------------------------------------------------------------ */
/* 上下文                                                              */
/* ------------------------------------------------------------------ */

function resolveTeamId(user, payload) {
  const db = db$();
  const wanted = payload?.teamId;
  if (wanted) {
    const t = db.teams.find((x) => x.id === wanted);
    const mem = db.teamMembers.find((m) => m.teamId === wanted && m.userId === user.id);
    if (t && (mem || user.role === 'super_admin')) return t.id;
    // 前端可能传 userId 当 teamId（个人团队 id === userId）
    const byId = db.teams.find((x) => x.id === wanted);
    if (byId) return byId.id;
  }
  return personalTeamFor(user.id)?.id ?? null;
}

function buildContext({ req, res, url, user, payload, raw, files, cmd }) {
  return {
    req,
    res,
    url,
    query: Object.fromEntries(url.searchParams.entries()),
    user,
    teamId: resolveTeamId(user, payload),
    payload,
    rawBody: raw,
    files,
    contentType: req.headers['content-type'] ?? '',
    cmd,
    /** 供需要直接吐二进制的 handler 使用 */
    respond(fn) {
      fn();
    },
  };
}

/* ------------------------------------------------------------------ */
/* SSE：对话事件                                                        */
/* ------------------------------------------------------------------ */

async function handleSubscribeEvents(req, res, user, ctx) {
  await readRawBody(req); // 丢弃 '{}' body
  hub.subscribe({ res, userId: user.id, teamId: ctx.teamId });
  // 连上后不要再走普通响应流程
  return { streaming: true };
}

/* ------------------------------------------------------------------ */
/* SSE：工作区文件变更                                                  */
/* ------------------------------------------------------------------ */

const watchers = new Map(); // conversationId → {watcher, clients:Set, timer, pending:Set}

function watchConversation(conversationId, client) {
  let entry = watchers.get(conversationId);
  if (!entry) {
    const dir = workspaceDir(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    const state = { watcher: null, clients: new Set(), timer: null, pending: new Set() };
    try {
      state.watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        const rel = String(filename ?? '').replace(/\\/g, '/');
        if (!rel || rel === '.seeded' || rel.startsWith('.git/')) return;
        state.pending.add(rel);
        if (state.timer) return;
        state.timer = setTimeout(() => {
          state.timer = null;
          const events = [...state.pending].map((p) => ({ path: p }));
          state.pending.clear();
          if (!events.length) return;
          const frame = `data: ${JSON.stringify({ type: 'change', events, truncated: false })}\n\n`;
          for (const c of state.clients) {
            try {
              c.res.write(frame);
            } catch {
              state.clients.delete(c);
            }
          }
        }, 120);
        if (state.timer.unref) state.timer.unref();
      });
    } catch (e) {
      console.warn('[fileWatch] 无法监听', conversationId, e.message);
    }
    entry = state;
    watchers.set(conversationId, entry);
  }
  entry.clients.add(client);
  return () => {
    entry.clients.delete(client);
    if (entry.clients.size === 0) {
      try {
        entry.watcher?.close();
      } catch { /* ignore */ }
      if (entry.timer) clearTimeout(entry.timer);
      watchers.delete(conversationId);
    }
  };
}

async function handleWatchConversationFiles(req, res, user, ctx) {
  const payload = ctx.payload ?? {};
  const conversationId = payload?.conversationId ?? ctx.query.conversationId;
  if (!conversationId) {
    return sendJSON(res, { error: { code: 'BAD_REQUEST', message: '缺少 conversationId' } }, 400);
  }
  const conv = db$().conversations.find((c) => c.id === conversationId);
  if (conv && conv.teamId !== ctx.teamId && user.role !== 'super_admin') {
    return sendJSON(res, { error: { code: 'FORBIDDEN', message: '无权访问该会话' } }, 403);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS,
  });
  res.write(': connected\n\n');
  res.write(`data: ${JSON.stringify({ type: 'ready', conversationId })}\n\n`);

  const client = { res };
  const unwatch = watchConversation(conversationId, client);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch { /* ignore */ }
  }, 25000);
  if (ping.unref) ping.unref();

  const close = () => {
    clearInterval(ping);
    unwatch();
  };
  res.on('close', close);
  res.on('error', close);
  return { streaming: true };
}

/* ------------------------------------------------------------------ */
/* 桌面直连文件网关  /files/*                                          */
/* ------------------------------------------------------------------ */

/**
 * 桌面客户端会先调 createFileDirectTicket 拿 {direct:{port,ticket,ttlMs}}，
 * 然后尝试 http://127.0.0.1:{port}/files/<op>；失败（返回 falsy）即回落云端命令。
 * 本地复刻把这个网关也实现在同一个进程里，于是前端走的是「直连成功」这条路径。
 */
export async function handleFilesGateway(req, res, url, { user, ctx }) {
  const op = url.pathname.replace(/^\/files\/?/, '').split('/')[0];
  const buf = req.method === 'POST' ? await readRawBody(req) : Buffer.alloc(0);
  const body = buf.length ? parseJSONBody(buf) : {};
  const p = body?.data ?? body;
  const conversationId = p?.conversationId ?? url.searchParams.get('conversationId');
  if (!conversationId) return sendJSON(res, { error: { code: 'BAD_REQUEST', message: '缺少 conversationId' } }, 400);

  // 网关和普通命令走同一套鉴权：没带有效 token 一律 401。
  if (!user || !user.id) {
    return sendJSON(res, { error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
  }

  // 关键：调用方（serve.mjs）不一定能提前拿到 teamId —— 它必须从 user + payload 推导，
  // 这正是 buildContext 干的事。少了这一步 ctx.teamId 会是 undefined，
  // 于是「会话的 teamId !== undefined」恒为真，任何直连请求都被误判成 403。
  const effCtx = ctx && ctx.teamId !== undefined
    ? ctx
    : buildContext({ req, res, url, user, payload: p, raw: buf, files: null, cmd: `files/${op}` });

  const conv = db$().conversations.find((c) => c.id === conversationId);
  if (conv && conv.teamId !== effCtx.teamId && user.role !== 'super_admin') {
    return sendJSON(res, { error: { code: 'FORBIDDEN', message: '无权访问' } }, 403);
  }

  const cmdFor = {
    list: 'getConversationFiles',
    index: 'getConversationFileIndex',
    read: 'downloadConversationFile',
    write: 'updateConversationFile',
    create: 'createConversationEntry',
    remove: 'deleteConversationEntry',
    copy: 'copyConversationEntry',
    rename: 'renameConversationEntry',
    move: 'moveConversationEntry',
    dir: 'downloadConversationDir',
    status: 'getConversationGitStatus',
    diff: 'getConversationGitDiff',
  }[op];
  if (!cmdFor) return sendJSON(res, { error: { code: 'NOT_FOUND', message: `未知文件操作 ${op}` } }, 404);

  const handler = COMMANDS[cmdFor];
  if (!handler) return sendJSON(res, { error: { code: 'NOT_FOUND', message: '网关未实现' } }, 404);
  try {
    const result = await handler(p ?? {}, { ...effCtx, req, res, rawBody: buf });
    if (result && result.__binary) {
      return sendRaw(res, result.__binary, {
        contentType: result.contentType,
        disposition: result.disposition ?? `attachment; filename="${result.filename}"`,
      });
    }
    return sendJSON(res, { data: result });
  } catch (e) {
    return fail(res, e);
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<{streaming?:boolean}|void>} streaming=true 表示响应已由本函数接管
 */
export async function handleApiRequest(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // 注意：这里**不能**调用 load()。
  // load() 会用磁盘快照覆盖内存库，而 save() 是防抖写盘的；
  // 每次请求前 load() 会吃掉「刚写入内存、还没落盘」的数据（例如刚建的会话/用户），
  // 表现为同一进程内「刚登录就 401」。内存才是真相源，磁盘只是快照。
  seedIfEmpty();

  const pathname = url.pathname;

  // ---------- 附件下载（预签名直链） ----------
  if (pathname === '/api/ticketAttachment') {
    return serveTicketAttachment(res, url);
  }

  // ---------- 头像 ----------
  if (pathname.startsWith('/api/avatar/')) {
    return serveAvatar(res, pathname.replace('/api/avatar/', ''));
  }

  // ---------- SSE ----------
  if (pathname === '/api/subscribeEvents' || pathname === '/api/watchConversationFiles') {
    const user = userFromRequest(req);
    if (!user) return sendJSON(res, { error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
    const buf = pathname === '/api/watchConversationFiles' ? await readRawBody(req) : Buffer.alloc(0);
    const { payload } = buf.length ? payloadFrom(req, buf) : { payload: {} };
    const ctx = buildContext({ req, res, url, user, payload, raw: buf, files: null, cmd: pathname.split('/').pop() });
    if (pathname === '/api/subscribeEvents') return handleSubscribeEvents(req, res, user, ctx);
    return handleWatchConversationFiles(req, res, user, ctx);
  }

  // ---------- 认证命名空间 ----------
  if (pathname.startsWith('/api/auth/')) {
    const cmd = pathname.slice('/api/auth/'.length);
    if (req.method === 'GET') {
      return handleAuth(req, res, cmd, {}, Object.fromEntries(url.searchParams.entries()));
    }
    const buf = await readRawBody(req);
    const { payload } = payloadFrom(req, buf);
    return handleAuth(req, res, cmd, payload, Object.fromEntries(url.searchParams.entries()));
  }

  // ---------- 命令命名空间 ----------
  if (!pathname.startsWith('/api/')) {
    return sendJSON(res, { error: { code: 'NOT_FOUND', message: 'Not an API route' } }, 404);
  }

  const cmd = pathname.slice('/api/'.length);
  if (!cmd) return sendJSON(res, { error: { code: 'NOT_FOUND', message: '缺少命令名' } }, 404);

  const buf = await readRawBody(req);
  const { payload, raw, files } = payloadFrom(req, buf, url);

  // 未注册的命令：登录态下返回空成功，避免前端整页报错
  const handler = COMMANDS[cmd];

  const user = userFromRequest(req);

  // 免登录白名单（分享页）
  const PUBLIC = new Set(['getSharedConversation', 'getSharedMessages', 'getSharedConversationCosts']);
  // 签名直链：createFileLink / adminCreateFileLink 产出的 `?token=xxx` 就是凭证本身。
  // 这条链接会被 <img src> / <iframe src> / DocumentServer 直接 GET，带不上 Authorization 头，
  // 所以必须允许匿名访问 —— 但**只放行 token 分支**，没有 token 仍然 401。
  const tokenLink = cmd === 'downloadConversationFile' && typeof payload?.token === 'string' && payload.token.length > 0;
  if (!user && !PUBLIC.has(cmd) && !tokenLink) {
    return sendJSON(res, { error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
  }

  const ctx = buildContext({ req, res, url, user: user ?? { id: null, role: 'guest', teamId: null }, payload, raw, files, cmd });
  // 匿名的签名直链不允许借 ctx 拿到任何团队数据
  if (!user) ctx.teamId = null;

  if (!handler) {
    console.warn(`[api] 未实现的命令：${cmd}`);
    return sendJSON(res, {
      error: { code: 'NOT_IMPLEMENTED', message: `命令 ${cmd} 尚未在本地复刻中实现` },
    }, 501);
  }

  try {
    const result = await handler(payload, ctx);
    if (result && result.streaming) return; // 已接管响应

    // 二进制响应（下载）
    if (result && result.__binary) {
      return sendRaw(res, result.__binary, {
        contentType: result.contentType,
        disposition: result.disposition ?? `attachment; filename="${result.filename}"`,
      });
    }

    // token 轮换：每次业务响应都下发一个新 token（对齐生产的 set-auth-token 行为）
    const headers = user ? { 'set-auth-token': rotateToken(req, user) } : {};
    return sendJSON(res, { data: result ?? {}, error: null }, 200, headers);
  } catch (e) {
    return fail(res, e);
  }
}

/** 轮换 token：把旧 token 续期、下发新的（与生产一致，前端 X(res) 会自动落盘） */
function rotateToken(req, user) {
  const auth = String(req.headers.authorization ?? '');
  const old = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (old) {
    const rec = tokens.get(old);
    // 旧 token 再宽限 3 分钟，避免并发请求用旧 token 被打回登录页
    if (rec) rec.expiresAt = Date.now() + 3 * 60e3;
  }
  return issueToken(user.id);
}

/* ------------------------------------------------------------------ */
/* 附件 / 头像                                                        */
/* ------------------------------------------------------------------ */

function serveTicketAttachment(res, url) {
  const id = url.searchParams.get('attachmentId');
  const rec = (db$().attachments ?? []).find((a) => a.id === id);
  if (!rec || !fs.existsSync(rec.path)) {
    // 生产会返回 403（签名过期）；这里给一个明确的 404 文本，前端不会崩溃
    return sendRaw(res, Buffer.from('attachment not found'), { status: 404, contentType: 'text/plain; charset=utf-8' });
  }
  const buf = fs.readFileSync(rec.path);
  return sendRaw(res, buf, {
    contentType: 'application/octet-stream',
    disposition: `attachment; filename="${encodeURIComponent(rec.name)}"`,
  });
}

function serveAvatar(res, name) {
  const dir = workspaceDir('__avatars__');
  const abs = safeJoin(dir, name);
  if (!fs.existsSync(abs)) return sendRaw(res, Buffer.from(''), { status: 404 });
  const ext = path.extname(abs).toLowerCase();
  const ct = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[ext] ?? 'application/octet-stream';
  return sendRaw(res, fs.readFileSync(abs), { contentType: ct, disposition: '' });
}

/* ------------------------------------------------------------------ */
/* 收银台页面（payUrl 指向这里，前端把它渲染成二维码）                  */
/* ------------------------------------------------------------------ */

export function payPageHTML(order) {
  const yuan = (order.amountCents / 100).toFixed(2);
  const kinds = { wechat: '微信支付', alipay: '支付宝', stripe: 'Stripe' };
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>收银台 · ¥${yuan}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#f5f5f7;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:340px;padding:28px;border:1px solid rgba(255,255,255,.09);border-radius:20px;background:#131316;text-align:center}
  h1{margin:0 0 6px;font-size:17px;font-weight:600}
  .sub{margin:0 0 18px;color:#8b8b93;font-size:12.5px}
  .amount{font-size:34px;font-weight:650;letter-spacing:-.02em;margin:6px 0 20px}
  .amount span{font-size:18px;font-weight:500;color:#8b8b93;margin-right:4px}
  .qr{width:190px;height:190px;margin:0 auto;border-radius:14px;background:#fff;display:grid;place-items:center}
  .qr svg{width:170px;height:170px}
  .note{margin-top:18px;font-size:12px;color:#8b8b93}
  .pill{display:inline-block;margin-top:14px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.07);font-size:11.5px}
  code{color:#c9c9d1}
</style></head>
<body>
  <div class="card">
    <h1>${kinds[order.provider] ?? order.provider}</h1>
    <p class="sub">订单号 <code>${order.orderNo}</code></p>
    <div class="amount"><span>¥</span>${yuan}</div>
    <div class="qr">${fakeQR(order.payUrl)}</div>
    <p class="note">本地复刻环境 · 无需真实付款<br/>约 6 秒后自动置为已支付</p>
    <div class="pill">状态：${order.status}</div>
  </div>
</body></html>`;
}

/** 确定性伪二维码（仅用于视觉占位，不是可扫码的真二维码） */
function fakeQR(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const N = 21;
  const cell = 170 / N;
  let rects = '';
  const rnd = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const finder =
        (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
      const on = finder
        ? x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5)
        : rnd() > 0.52;
      if (on) rects += `<rect x="${(x * cell).toFixed(2)}" y="${(y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="#000"/>`;
    }
  }
  return `<svg viewBox="0 0 170 170" xmlns="http://www.w3.org/2000/svg"><rect width="170" height="170" fill="#fff"/>${rects}</svg>`;
}

/* ------------------------------------------------------------------ */
/* 终端（WebSocket）                                                    */
/* ------------------------------------------------------------------ */

export function handleTerminalUpgrade(req, socket, head, deps) {
  const { acceptUpgrade, wrapSocket } = deps.ws;
  const { toolBash } = deps.workspace;
  const { terminalTickets } = deps.chat;

  if (!acceptUpgrade(req, socket)) return;

  const url = new URL(req.url, 'http://localhost');
  const ticket = url.searchParams.get('ticket');
  const rec = terminalTickets.get(ticket);
  if (!rec || rec.expiresAt < Date.now()) {
    const ws0 = wrapSocket(socket, { onMessage: () => {} });
    ws0.send('\r\n\x1b[31m终端票据无效或已过期\x1b[0m\r\n');
    ws0.close(1008, 'invalid ticket');
    return;
  }
  terminalTickets.delete(ticket);

  const db = db$();
  const term = (db.terminals ?? []).find((t) => t.id === rec.terminalId) ?? null;
  const conversationId = term?.conversationId ?? null;
  let buffer = '';
  let cwd = term?.cwd || '';

  const ws = wrapSocket(socket, {
    onMessage: (text) => {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          const line = buffer.trim();
          buffer = '';
          ws.send('\r\n');
          if (!line) {
            prompt();
            continue;
          }
          if (line === 'exit' || line === 'logout') {
            ws.send('\x1b[33m(本地复刻终端：已忽略 exit)\x1b[0m\r\n');
            prompt();
            continue;
          }
          const res = toolBash(conversationId, { command: line });
          const out = (res.output ?? '').replace(/\n/g, '\r\n');
          if (out) ws.send(out.endsWith('\r\n') ? out : out + '\r\n');
          if (res.error) ws.send(`\x1b[31m${res.error.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
          prompt();
        } else if (ch === '\x7f' || ch === '\b') {
          if (buffer.length) {
            buffer = buffer.slice(0, -1);
            ws.send('\b \b');
          }
        } else if (ch === '\u0003') {
          buffer = '';
          ws.send('^C\r\n');
          prompt();
        } else if (ch >= ' ') {
          buffer += ch;
          ws.send(ch);
        }
      }
    },
    onClose: () => {
      if (term) {
        term.state = 'exited';
        term.exitedAt = new Date().toISOString();
        save();
      }
    },
  });

  function prompt() {
    const label = cwd ? cwd.split('/').pop() : 'workspace';
    ws.send(`\x1b[32m${label}\x1b[0m \x1b[36m$\x1b[0m `);
  }

  ws.send('\x1b[1mClawsGO 本地复刻终端\x1b[0m\r\n');
  ws.send('命令由 server/lib/workspace.mjs 的 toolBash 在白名单内真实执行。\r\n');
  ws.send('输入 help 查看可用命令。\r\n\r\n');
  prompt();
}

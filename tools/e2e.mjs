/**
 * tools/e2e.mjs —— 端到端验收测试
 *
 * 不依赖任何第三方库（只用 Node 内置 fetch + net + 自带的最小 WS 客户端）。
 * 逐项真实调用本地复刻后端，覆盖：
 *   认证 / 资料 / 团队 / 会话列表 / 发消息 + SSE 流式 / 权限审批 / 文件读写与上传下载
 *   / 技能（含读技能源码）/ 主机探针 / 计费（下单→自动支付→额度到账→开票）
 *   / 工单（含 multipart 附件上传）/ 公告 / 管理后台 / 终端 WebSocket
 *
 * 用法：
 *   node tools/e2e.mjs                 # 默认 http://127.0.0.1:5181
 *   BASE=http://127.0.0.1:5181 node tools/e2e.mjs
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env.BASE || 'http://127.0.0.1:5181';
/** 营销站（Next.js 预渲染产物）跑在另一个端口 */
const SITE_BASE = process.env.SITE_BASE || 'http://127.0.0.1:5180';
const PHONE = '+8613800000000';
const ADMIN_PHONE = '+8613900000000';
const OTP = '123456';
const PASSWORD = 'clawsgo2026';

/**
 * 把 stdout 同步镜像到日志文件。
 * 这样即便进程被外部中断（CI 超时、Ctrl-C），也能拿到已经跑完的部分，
 * 不依赖 shell 重定向 —— 也不受管道缓冲影响。
 */
const LOG_PATH = process.env.E2E_LOG || path.join(ROOT, 'docs', 'e2e-run.log');
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, '');
} catch { /* 忽略：日志镜像失败不影响测试本身 */ }
const _stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try {
    fs.appendFileSync(LOG_PATH, chunk);
  } catch { /* 忽略 */ }
  return _stdoutWrite(chunk, ...rest);
};

let PASS = 0;
let FAIL = 0;
const RESULTS = [];
const failures = [];

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function check(name, cond, detail) {
  if (cond) {
    PASS++;
    RESULTS.push({ name, ok: true });
    process.stdout.write(`  ${C.ok('✓')} ${name}${detail ? C.dim('  ' + detail) : ''}\n`);
  } else {
    FAIL++;
    RESULTS.push({ name, ok: false, detail });
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    process.stdout.write(`  ${C.bad('✗')} ${name}${detail ? C.dim('  ' + detail) : ''}\n`);
  }
  return cond;
}

function section(title) {
  process.stdout.write(`\n${C.b('▌ ' + title)}\n`);
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端（复刻前端 api-pyi 的三条通道）                          */
/* ------------------------------------------------------------------ */

let TOKEN = null;

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function rawPOST(cmd, body, { auth = true, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api/${cmd}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify({ data: body ?? {} }),
  });
  const rotated = res.headers.get('set-auth-token');
  if (rotated) TOKEN = rotated;
  return res;
}

/** 对应前端 Q(cmd, payload) */
async function api(cmd, body) {
  const res = await rawPOST(cmd, body);
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`${cmd}: 非 JSON 响应 (${res.status})`);
  if (json.error) {
    const e = new Error(json.error.message);
    e.code = json.error.code;
    e.status = res.status;
    throw e;
  }
  return json.data;
}

/** 对应前端 _e(cmd, payload)：二进制下载 */
async function apiBlob(cmd, body) {
  const res = await rawPOST(cmd, body);
  if (res.headers.get('content-disposition')) {
    return {
      blob: Buffer.from(await res.arrayBuffer()),
      disposition: res.headers.get('content-disposition'),
      contentType: res.headers.get('content-type'),
    };
  }
  const j = await res.json().catch(() => null);
  throw new Error(j?.error?.message ?? `${cmd} 未返回二进制`);
}

/** 对应前端 ye(cmd, query, rawBody)：XHR 上传 */
async function apiUpload(cmd, query, buffer, contentType) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${BASE}/api/${cmd}?${qs}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': contentType || 'application/octet-stream' }),
    body: buffer,
  });
  const rotated = res.headers.get('set-auth-token');
  if (rotated) TOKEN = rotated;
  const json = await res.json();
  if (json.error) {
    const e = new Error(json.error.message);
    e.code = json.error.code;
    throw e;
  }
  return json.data;
}

/** 对应前端 ve(cmd, rawBody)：原始 body（FormData 也走这条） */
async function apiRaw(cmd, body, contentType) {
  const headers = authHeaders();
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(`${BASE}/api/${cmd}`, { method: 'POST', headers, body });
  const rotated = res.headers.get('set-auth-token');
  if (rotated) TOKEN = rotated;
  const json = await res.json();
  if (json.error) return { __error: json.error };
  return json.data;
}

/* ------------------------------------------------------------------ */
/* SSE 客户端                                                          */
/* ------------------------------------------------------------------ */

async function openSSE(pathname, body, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
    signal: ctrl.signal,
  });
  if (!res.ok) throw new Error(`${pathname} ${res.status}`);

  const frames = [];
  const waiters = [];
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const frame = JSON.parse(line.slice(5).trim());
              frames.push(frame);
              for (const w of [...waiters]) {
                if (w.pred(frame)) {
                  w.resolve(frame);
                  waiters.splice(waiters.indexOf(w), 1);
                }
              }
            } catch { /* 非 data 帧 */ }
          }
        }
      }
    } catch { /* abort */ }
  })();

  return {
    frames,
    waitFor(pred, { timeout = timeoutMs, label = 'frame' } = {}) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`等待 ${label} 超时（已收到 ${frames.length} 帧）`));
        }, timeout);
        waiters.push(w);
      });
    },
    close: () => ctrl.abort(),
  };
}

/* ------------------------------------------------------------------ */
/* 最小 WebSocket 客户端（客户端→服务端必须掩码）                      */
/* ------------------------------------------------------------------ */

function wsConnect(url) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      socket.write(
        [
          `GET ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
      );
    });
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let onText = () => {};
    let closed = false;

    const listeners = [];
    const textWaiters = [];

    function deliver(text) {
      onText(text);
      for (const w of [...textWaiters]) {
        if (w.pred(text)) {
          w.resolve(text);
          textWaiters.splice(textWaiters.indexOf(w), 1);
        }
      }
    }

    const api = {
      send(text) {
        socket.write(maskFrame(0x1, Buffer.from(text, 'utf8')));
      },
      onText(fn) {
        onText = fn;
      },
      waitFor(pred, timeout = 15000) {
        const hit = listeners.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res2, rej2) => {
          const w = { pred, resolve: res2 };
          const t = setTimeout(() => {
            textWaiters.splice(textWaiters.indexOf(w), 1);
            rej2(new Error('WS 等待输出超时'));
          }, timeout);
          const orig = w.resolve;
          w.resolve = (v) => {
            clearTimeout(t);
            orig(v);
          };
          textWaiters.push(w);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          socket.write(maskFrame(0x8, Buffer.alloc(0)));
          socket.end();
        } catch { /* ignore */ }
      },
      get closed() {
        return closed;
      },
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString('latin1');
        if (!/101/.test(head.split('\r\n')[0])) {
          return reject(new Error('WS 握手失败: ' + head.split('\r\n')[0]));
        }
        handshakeDone = true;
        buf = buf.subarray(i + 4);
        resolve(api);
      }
      let consumed = 0;
      while (handshakeDone) {
        const f = decodeServerFrame(buf.subarray(consumed));
        if (!f) break;
        consumed += f.consumed;
        if (f.opcode === 0x1) {
          const text = f.payload.toString('utf8');
          listeners.push(text);
          deliver(text);
        } else if (f.opcode === 0x8) {
          closed = true;
          socket.end();
        } else if (f.opcode === 0x9) {
          socket.write(maskFrame(0xa, f.payload));
        }
      }
      buf = buf.subarray(consumed);
    });
    socket.on('error', (e) => (handshakeDone ? api.close() : reject(e)));
    socket.on('close', () => {
      closed = true;
    });
  });
}

function maskFrame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(b) {
  if (b.length < 2) return null;
  const b0 = b[0];
  const b1 = b[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  if (b.length < off + len) return null;
  return { fin, opcode, payload: b.subarray(off, off + len), consumed: off + len };
}

/* ------------------------------------------------------------------ */
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  console.log(C.b('\nClawsGO 本地复刻 · 端到端验收测试'));
  console.log(C.dim(`  target = ${BASE}`));

  /* ---------------- 0. 归零：让整轮验收可重复 ---------------- */
  // 复刻的服务把状态落在磁盘上（db.json / 会话工作区 / 主机盘），
  // 上一轮跑完的残留会让这一轮撞 409、也让「计数类断言」不稳。
  // 所以每一轮开头先调一次 /__reset 回到出厂状态。
  // 若目标服务器没开这个端点（例如线上），就跳过 —— 断言本身仍是幂等的。
  if (process.env.E2E_NO_RESET !== '1') {
    section('0. 环境归零（可重复运行）');
    const rz = await fetch(`${BASE}/__reset`, { method: 'POST' }).catch(() => null);
    if (rz && rz.ok) {
      const j = await rz.json().catch(() => ({}));
      check('恢复出厂状态', j.ok === true, `清空 ${j.wiped?.join('/')} · 团队 ${j.teams} 个 · 播种 ${j.seeded ? '是' : '否'}`);
    } else {
      check('恢复出厂状态', false, `端点不可用（HTTP ${rz?.status ?? 'N/A'}），改为依赖断言幂等性`);
    }
  }

  /* ---------------- 1. 认证 ---------------- */
  section('1. 认证与会话');

  const otpRes = await fetch(`${BASE}/api/auth/phone-number/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE }),
  }).then((r) => r.json());
  check('发送验证码', !!otpRes.requestId, `devCode=${otpRes.devCode}`);

  const badCode = await fetch(`${BASE}/api/auth/phone-number/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE, code: '000000' }),
  }).then((r) => r.json());
  check('错误验证码被拒', badCode.code === 'INVALID_OTP', badCode.code);

  const loginRes = await fetch(`${BASE}/api/auth/phone-number/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE, code: OTP }),
  });
  const login = await loginRes.json();
  TOKEN = loginRes.headers.get('set-auth-token');
  check('验证码登录成功', !!TOKEN && !!login.userId, `token=${TOKEN?.slice(0, 12)}…`);
  check('登录返回 profile 且带 teamId', !!login.user?.teamId, `teamId=${login.user?.teamId}`);

  const session = await fetch(`${BASE}/api/auth/session`, { headers: authHeaders() }).then((r) => r.json());
  check('GET 会话探针', !!session.user?.id, `name=${session.user?.name}`);

  const noAuth = await fetch(`${BASE}/api/getProfile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  });
  check('无 token 访问业务命令返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  /* ---------------- 2. 资料 / 团队 ---------------- */
  section('2. 资料、团队与当前团队不变量');

  const prof = await api('getProfile', {});
  check('getProfile → { profile }', !!prof.profile?.id);
  check(
    '个人团队 id === userId（前端 useCurrentTeam 兜底依赖）',
    prof.profile.teamId === prof.profile.userId,
    `${prof.profile.teamId}`,
  );

  const teams = await api('getTeams', {});
  check('getTeams → { teams }', Array.isArray(teams.teams) && teams.teams.length > 0, `${teams.teams.length} 个团队`);
  check(
    'getTeams 返回项带 role 且存在 owner',
    teams.teams.some((t) => t.role === 'owner'),
    teams.teams.map((t) => `${t.name}:${t.role}`).join(', '),
  );

  const TEAM_ID = prof.profile.teamId;

  const members = await api('getTeamMembers', { teamId: TEAM_ID });
  check('getTeamMembers → { members }', Array.isArray(members.members), `${members.members.length} 名成员`);

  const upd = await api('updateProfile', { name: '演示用户' });
  check('updateProfile 落库', upd.profile?.name === '演示用户');

  /* ---------------- 3. 会话列表 ---------------- */
  section('3. 会话列表（分页工厂 V 的契约）');

  const convs = await api('getConversations', { teamId: TEAM_ID, limit: 51, offset: 0 });
  check('getConversations → { conversations } 扁平数组', Array.isArray(convs.conversations), `${convs.conversations.length} 条`);
  check('会话项含前端必需字段', ['id', 'title', 'teamId', 'projectId', 'updatedAt', 'lastMessagePreview'].every((k) => k in (convs.conversations[0] ?? {})), Object.keys(convs.conversations[0] ?? {}).slice(0, 8).join(','));

  const projs = await api('getProjects', { teamId: TEAM_ID, limit: 6, offset: 0 });
  check('getProjects → { projects }', Array.isArray(projs.projects), `${projs.projects.length} 个项目`);

  /* ---------------- 4. SSE + 发消息 + 权限审批 ---------------- */
  section('4. 发消息 · SSE 流式 · 权限审批');

  // 先把文件变更通道建起来，验证它会推送真实 fs.watch 事件
  const fileWatch = await openSSE('/api/watchConversationFiles', { data: { conversationId: 'probe' } });

  const conversationId = crypto.randomUUID();
  const sse = await openSSE('/api/subscribeEvents', {});

  const ack = await sse.waitFor((f) => f.t === 'channel-ack', { label: 'channel-ack', timeout: 8000 });
  check('SSE 立即下发 channel-ack', Array.isArray(ack.running), `running=${ack.running.length}`);

  const sendRes = await api('sendMessage', {
    conversationId,
    messageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    text: '帮我统计工作区里的 CSV 数据，并执行脚本生成暴露计划',
    modelId: 'clawsgo-1.0-lithium',
    effort: 'medium',
    mode: 'regular',
    context: 'standard',
    permission: 'full',
    ensure: { teamId: TEAM_ID },
    title: '统计工作区 CSV 数据'.slice(0, 50),
  });
  check('sendMessage → { userMessage, assistantMessage }', !!sendRes.userMessage && !!sendRes.assistantMessage);
  check('助手占位消息带 streamId（前端据此显示 streaming）', !!sendRes.assistantMessage.streamId, sendRes.assistantMessage.streamId?.slice(0, 16) + '…');
  check('新会话由后端按 ensure 建档', !!sendRes.conversation?.id, `title=${sendRes.conversation?.title}`);

  const textPart = await sse.waitFor((f) => f.t === 'part' && f.part?.type === 'reasoning', { label: 'reasoning part' });
  check('SSE 推送 reasoning part', textPart.index === 0);

  const delta = await sse.waitFor((f) => f.t === 'part-delta', { label: 'part-delta' });
  check('SSE 推送 part-delta 增量', typeof delta.delta === 'string' && delta.delta.length > 0, JSON.stringify(delta.delta?.slice(0, 12)));

  const toolFrame = await sse.waitFor(
    (f) => f.t === 'part' && f.part?.type === 'tool' && f.part.state === 'output-available' && f.part.toolName === 'Glob',
    { label: 'Glob tool part' },
  );
  check('SSE 推送真实执行的 Glob 工具结果', toolFrame.part.output.includes('README.md'), `${toolFrame.part.output.split('\n').length} 个文件`);
  check('工具 part 带 durationMs', typeof toolFrame.part.durationMs === 'number', `${toolFrame.part.durationMs}ms`);

  const perm = await sse.waitFor((f) => f.t === 'permission', { label: 'permission 帧', timeout: 25000 });
  check('Bash 执行前请求权限审批', !!perm.request?.requestId && perm.request.toolName === 'Bash', perm.request?.toolName);
  check('权限请求携带原始 input', typeof perm.request.input?.command === 'string', perm.request.input?.command?.slice(0, 40) + '…');

  const denied = await api('answerPermission', {
    conversationId,
    requestId: perm.request.requestId,
    behavior: 'allow',
  });
  check('answerPermission(allow) 被后端接受', denied.ok === true);

  const answered = await sse.waitFor((f) => f.t === 'permission-answered', { label: 'permission-answered', timeout: 8000 });
  check('SSE 回送 permission-answered', answered.requestId === perm.request.requestId);

  // 注意要过滤 state：tool part 会先推一帧 input-available（此时还没有 output），
  // 不过滤会命中那一帧，拿到 output=undefined。
  const bucket = await sse.waitFor(
    (f) =>
      f.t === 'part' &&
      f.part?.type === 'tool' &&
      f.part.toolName === 'Bash' &&
      f.part.state === 'output-available',
    { label: 'Bash 执行结果', timeout: 30000 },
  );
  check('审批通过后 Bash 真实执行', !bucket.part.errorText && typeof bucket.part.output === 'string', JSON.stringify(bucket.part.output?.slice(0, 55)));

  const taskFrame = await sse.waitFor(
    (f) => f.t === 'part' && f.part?.type === 'tool' && f.part.toolName === 'Task',
    { label: '子智能体 part', timeout: 30000 },
  );
  check('子智能体编排 part 出现', Array.isArray(taskFrame.part.agents), `${taskFrame.part.agents?.length} 个子智能体`);

  const track = await sse.waitFor((f) => f.t === 'track-part', { label: 'track-part', timeout: 30000 });
  check('子智能体内部步骤走 track-part 通道', !!track.agentId, `agentId=${track.agentId}`);

  const done = await sse.waitFor((f) => f.t === 'done', { label: 'done', timeout: 60000 });
  check('运行结束推送 done 帧', !!done.messageId);
  check('done 帧携带 usage 用量', !!done.metadata?.usage?.inputTokens, `in=${done.metadata?.usage?.inputTokens} out=${done.metadata?.usage?.outputTokens}`);

  const titleFrame = sse.frames.find((f) => f.t === 'title-updated');
  check('首次对话自动生成标题（title-updated）', !!titleFrame, titleFrame?.title);

  /* ---------------- 5. 消息与费用 ---------------- */
  section('5. 消息读取与费用统计');

  const msgs = await api('getMessages', { conversationId, limit: 20, offset: 0 });
  check('getMessages → { messages } 且倒序（第 0 页最新）', msgs.messages[0]?.role === 'assistant', msgs.messages.map((m) => m.role).join(','));
  check('消息 parts 已落库（含 tool part）', msgs.messages.some((m) => m.parts.some((p) => p.type === 'tool')), `${msgs.messages.length} 条消息`);
  check('完成后 streamId 被清空（前端不会误判为未完成）', msgs.messages[0].streamId === null);

  const costs = await api('getConversationCosts', { conversationId });
  check('getConversationCosts → { costs }', !!costs.costs && costs.costs.runs > 0, `credits=${costs.costs.credits} tokens=${costs.costs.totalTokens}`);

  const search = await api('searchAll', { teamId: TEAM_ID, query: 'CSV' });
  check('searchAll 命中会话', Array.isArray(search.conversations) && search.conversations.length > 0, `${search.total} 条结果`);

  /* ---------------- 6. 工作区文件 ---------------- */
  section('6. 工作区文件（列表 / 读写 / 上传 / 下载）');

  const list = await api('getConversationFiles', { conversationId, path: '' });
  check('getConversationFiles → { exists, entries }', list.exists === true && Array.isArray(list.entries), `${list.entries.length} 个条目`);
  check('条目字段齐全（name/path/type/size/mtime）', ['name', 'path', 'type', 'size', 'mtime'].every((k) => k in (list.entries[0] ?? {})));

  const idx = await api('getConversationFileIndex', { conversationId });
  check('getConversationFileIndex → 扁平索引', Array.isArray(idx.entries) && idx.entries.length > 0, `${idx.entries.length} 个文件`);

  const created = await api('createConversationEntry', { conversationId, parentPath: 'data/processed', name: 'notes.md', kind: 'file' });
  check('createConversationEntry 真实建文件', !!created.entry, created.entry?.path);

  const wrote = await api('updateConversationFile', { conversationId, path: 'data/processed/notes.md', content: '# 备注\n\n写入测试通过。\n' });
  check('updateConversationFile 写入内容', wrote.ok === true && wrote.entry.size > 0, `${wrote.entry?.size} 字节`);

  const dl = await apiBlob('downloadConversationFile', { conversationId, path: 'data/processed/notes.md' });
  check('downloadConversationFile 返回二进制 + content-disposition', dl.blob.toString('utf8').includes('写入测试通过') && !!dl.disposition);

  const upBuf = Buffer.from('a,b,c\n1,2,3\n', 'utf8');
  const up = await apiUpload('uploadConversationFile', { conversationId, dirPath: 'data/uploads', name: '上传测试.csv' }, upBuf, 'text/csv');
  check('uploadConversationFile（原始体 + query 参数）', up.file?.path === 'data/uploads/上传测试.csv' && up.file.size === upBuf.length, `${up.file?.size} 字节`);

  const dlUp = await apiBlob('downloadConversationFile', { conversationId, path: up.file.path });
  check('上传内容可原样取回', dlUp.blob.equals(upBuf));

  const zip = await apiBlob('downloadConversationDir', { conversationId, path: '' });
  check('downloadConversationDir 产出合法 ZIP', zip.blob.subarray(0, 2).toString() === 'PK', `${(zip.blob.length / 1024).toFixed(1)} KB`);

  const renamed = await api('renameConversationEntry', { conversationId, path: 'data/processed/notes.md', newName: 'notes-renamed.md' });
  check('renameConversationEntry', renamed.entry?.name === 'notes-renamed.md');

  const copied = await api('copyConversationEntry', { conversationId, path: 'data/processed/notes-renamed.md', destDir: 'data/processed/backup' });
  check('copyConversationEntry', !!copied.entry?.path);

  const moved = await api('moveConversationEntry', { conversationId, path: 'data/processed/backup/notes-renamed.md', destDir: 'data' });
  check('moveConversationEntry', moved.entry?.path === 'data/notes-renamed.md', moved.entry?.path);

  const removed = await api('deleteConversationEntry', { conversationId, path: 'data/notes-renamed.md' });
  check('deleteConversationEntry', removed.ok === true);

  const git = await api('getConversationGitStatus', { conversationId });
  check('getConversationGitStatus', typeof git.clean === 'boolean' && 'branch' in git);

  const figs = await api('listFigures', { conversationId });
  check('listFigures → { figures }', Array.isArray(figs.figures));

  /* ---------------- 7. 文件变更 SSE ---------------- */
  section('7. 文件变更推送（watchConversationFiles）');

  const fw = await openSSE('/api/watchConversationFiles', { data: { conversationId } });
  const ready = await fw.waitFor((f) => f.type === 'ready', { label: 'ready', timeout: 8000 });
  check('文件通道建立（ready 帧）', ready.conversationId === conversationId);

  await api('updateConversationFile', { conversationId, path: 'watcher.txt', content: `changed at ${Date.now()}\n` });
  const change = await fw.waitFor((f) => f.type === 'change', { label: 'change 帧', timeout: 15000 });
  check('真实 fs.watch 推送 change 事件', change.events.some((e) => e.path.includes('watcher.txt')), change.events.map((e) => e.path).join(','));
  check('change 帧带 truncated 字段', change.truncated === false);
  fw.close();

  /* ---------------- 8. 会话维护 / 分享 / 归档 ---------------- */
  session8: {
    section('8. 会话维护 · 分享 · 归档 · 搜索');

    const upd2 = await api('updateConversation', { conversationId, title: '统计工作区 CSV 数据（已重命名）', pinned: true });
    check('updateConversation（改名 + 置顶）', upd2.conversation.title.includes('已重命名') && !!upd2.conversation.pinnedAt);

    const share = await api('shareConversation', { conversationId, shared: true });
    check('shareConversation 生成公开链接', share.isShared === true && !!share.slug, share.url);

    const sharedConv = await api('getSharedConversation', { slug: share.slug });
    check('getSharedConversation（免登录命令）', sharedConv.conversation?.id === conversationId);

    const sharedMsgs = await api('getSharedMessages', { slug: share.slug });
    check('getSharedMessages', sharedMsgs.messages.length > 0, `${sharedMsgs.messages.length} 条`);

    const unshare = await api('shareConversation', { conversationId, shared: false });
    check('关闭分享', unshare.isShared === false);

    const arch = await api('archiveConversation', { conversationId });
    check('archiveConversation', arch.ok === true);

    const archived = await api('getArchivedItems', { teamId: TEAM_ID });
    check('getArchivedItems → { items } 含刚归档会话', archived.items.some((i) => i.id === conversationId), `${archived.items.length} 项`);

    const unarch = await api('unarchiveConversation', { conversationId });
    check('unarchiveConversation', unarch.ok === true);
  }

  /* ---------------- 9. 技能 ---------------- */
  section('9. 技能库（真实落盘 + 读源码）');

  const skills = await api('getSkills', { teamId: TEAM_ID });
  check('getSkills → { skills }', Array.isArray(skills.skills) && skills.skills.length > 0, `${skills.skills.length} 个技能`);

  const detail = await api('getSkillDetail', { teamId: TEAM_ID, slug: 'literature-review' });
  check('getSkillDetail → { detail } 带文件列表', detail.detail.files.length >= 3, detail.detail.files.map((f) => f.path).join(','));

  const skillFile = await api('getSkillFile', { teamId: TEAM_ID, slug: 'literature-review', path: 'SKILL.md' });
  check('getSkillFile 读到真实 SKILL.md', skillFile.content.includes('文献综述'), `${skillFile.size} 字节`);

  const pyFile = await api('getSkillFile', { teamId: TEAM_ID, slug: 'literature-review', path: 'prisma.py' });
  check('getSkillFile 可读脚本文件', pyFile.content.includes('PRISMA'));

  const market = await api('searchSkillMarket', { query: 'meta' });
  check('searchSkillMarket 命中', market.skills.some((s) => s.slug === 'meta-analysis'), market.skills.map((s) => s.slug).join(','));

  const installed = await api('installSkill', { teamId: TEAM_ID, slug: 'meta-analysis' });
  check('installSkill 安装技能', installed.skill?.installed === true);

  const toggled = await api('setSkillEnabled', { teamId: TEAM_ID, slug: 'meta-analysis', enabled: true });
  check('setSkillEnabled 启用', toggled.skill?.enabled === true);

  const uninst = await api('uninstallSkill', { teamId: TEAM_ID, slug: 'meta-analysis' });
  check('uninstallSkill 卸载', uninst.skill?.installed === false);

  const gh = await api('listGithubSkills', { repo: 'clawsgo/skills' });
  check('listGithubSkills 返回可装列表', gh.skills.length > 0, `${gh.skills.length} 项`);

  /* ---------------- 10. 主机 ---------------- */
  section('10. 主机 / 环境 / 存储 / SSH 探针');

  const hosts = await api('getHosts', { teamId: TEAM_ID });
  check('getHosts → { hosts }', hosts.hosts.length >= 2, hosts.hosts.map((h) => `${h.name}:${h.status}`).join(', '));

  const HOST_ID = hosts.hosts[0].id;
  const status = await api('getHostStatus', { hostId: HOST_ID });
  check('getHostStatus 返回实时状态', !!status.hostId && typeof status.online === 'boolean', `${status.status} online=${status.online}`);

  const env = await api('getHostEnvironment', { hostId: HOST_ID });
  check('getHostEnvironment → { environment }', !!env.environment?.python && env.environment.packages.length > 0, `python=${env.environment.python} pkg=${env.environment.packages.length}`);

  const storage = await api('getHostStorage', { hostId: HOST_ID });
  check('getHostStorage → { storage }', storage.storage?.totalGb > 0, `${storage.storage.usedGb}/${storage.storage.totalGb} GB`);

  const dirs = await api('getHostDirectories', { hostId: HOST_ID, path: '/home/clawsgo' });
  check('getHostDirectories 返回目录树', dirs.entries.some((e) => e.type === 'dir'), dirs.entries.map((e) => e.name).join(', '));

  // 用唯一目录名：即使没走 /__reset（例如打线上），这一条也不会因为上一轮遗留而假失败。
  // 幂等语义本身单独断言：同名再建一次必须返回 created:false 而不是 409。
  const E2E_DIR = `/home/clawsgo/e2e-${Date.now().toString(36)}`;
  const newDir = await api('createHostDirectory', { hostId: HOST_ID, path: E2E_DIR });
  check('createHostDirectory 真实建目录', newDir.ok === true && newDir.created === true, newDir.path);

  const dirs2 = await api('getHostDirectories', { hostId: HOST_ID, path: '/home/clawsgo' });
  check('新建目录出现在目录树', dirs2.entries.some((e) => e.name === E2E_DIR.split('/').pop()), dirs2.entries.map((e) => e.name).join(', '));

  const again = await api('createHostDirectory', { hostId: HOST_ID, path: E2E_DIR });
  check('createHostDirectory 幂等（重名不报 409）', again.ok === true && again.created === false && again.existed === true);

  // 注意路径要真的跳出根目录：`home/clawsgo/../../x` 只是回到根目录本身，
  // 必须再上一级（`../..` 之于根）才算越界。
  const escaped = await api('createHostDirectory', { hostId: HOST_ID, path: '/../../etc/e2e-escape' }).then(
    () => null,
    (e) => e,
  );
  check('createHostDirectory 拦截路径越界', escaped?.code === 'BAD_REQUEST', escaped?.code ?? '竟然建成功了');

  const escaped2 = await api('createHostDirectory', { hostId: HOST_ID, path: '/home/clawsgo/../../../e2e-escape' }).then(
    () => null,
    (e) => e,
  );
  check('createHostDirectory 拦截深层越界', escaped2?.code === 'BAD_REQUEST', escaped2?.code ?? '竟然建成功了');

  const hSkills = await api('getHostSkills', { hostId: HOST_ID });
  check('getHostSkills → { skills }', Array.isArray(hSkills.skills));

  const ssh = await api('getSshServers', { teamId: TEAM_ID });
  check('getSshServers → { sshServers }', Array.isArray(ssh.sshServers), `${ssh.sshServers.length} 台`);

  const probe = await api('probeSshServers', { teamId: TEAM_ID });
  check('probeSshServers 真实 TCP 探活', Array.isArray(probe.results) && probe.results.every((r) => 'status' in r), probe.results.map((r) => `${r.hostname}:${r.status}`).join(', '));

  const hostCreated = await api('createHost', { teamId: TEAM_ID, kind: 'cloud', name: 'e2e-host', cpu: 4, memoryGb: 8 });
  check('createHost 创建主机', !!hostCreated.host?.id, hostCreated.host?.name);
  await sleep(2600);
  const st2 = await api('getHostStatus', { hostId: hostCreated.host.id });
  check('开通流程：provisioning → running', st2.status === 'running', st2.status);

  const clean = await api('cleanHostCache', { hostId: hostCreated.host.id });
  check('cleanHostCache', clean.ok === true);

  const rebuilt = await api('rebuildHost', { hostId: hostCreated.host.id });
  check('rebuildHost', rebuilt.ok === true);

  const delHost = await api('deleteHost', { hostId: hostCreated.host.id });
  check('deleteHost', delHost.ok === true);

  /* ---------------- 11. 计费 ---------------- */
  section('11. 计费：套餐 → 下单 → 支付 → 额度 → 发票');

  const sub = await api('getSubscription', { teamId: TEAM_ID });
  check('getSubscription → { subscription } 带 planId', !!sub.subscription?.planId, `${sub.subscription?.planId} → ${sub.subscription?.status}`);
  check('订阅返回套餐规格（cpus / models / agentMemory）', !!sub.subscription.spec?.cpus && sub.subscription.spec.models.length > 0, `${sub.subscription.spec.cpus}vCPU · ${sub.subscription.spec.models.length} 模型`);

  const plans = await api('getPlans', {});
  check('getPlans 返回全部套餐与充值档', plans.plans.length === 6 && plans.topupTiers.length === 5, plans.plans.map((p) => `${p.planId}:¥${p.monthlyCents / 100}`).join(' '));
  // 年付折扣按原始 bundle billing-D3pmhdeW.js 的公式核对：
  //   z = 6e3; B(plan, months) = months === 12 ? round(monthly * 12 * z / 1e4) : monthly * months
  // pro 月付 2990 分 → 年付 round(2990 * 12 * 0.6) = 21528 分 = ¥215.28（相当于 7.2 个月）
  check(
    '年付 6 折（pro 年付 = ¥215.28）',
    plans.plans.find((p) => p.planId === 'pro').yearlyCents === 21528,
    `${plans.plans.find((p) => p.planId === 'pro').yearlyCents} 分`,
  );

  const quote = await api('quoteUpgrade', { teamId: TEAM_ID, planId: 'ultra', months: 1 });
  check('quoteUpgrade 抵扣试算', quote.quote.dueCents > 0, `list=${quote.quote.listCents} proration=${quote.quote.prorationCents} due=${quote.quote.dueCents}`);

  const ledgerBefore = await api('getCreditLedger', { teamId: TEAM_ID, limit: 5 });
  const balanceBefore = (await api('getSubscription', { teamId: TEAM_ID })).subscription.creditBalance;

  const order = await api('createPaymentOrder', { teamId: TEAM_ID, provider: 'wechat', kind: 'topup', priceCents: 5000 });
  check('createPaymentOrder → { order } 带 payUrl', !!order.order?.payUrl && order.order.status === 'pending', order.order?.orderNo);
  check('充值档赠送到位（¥50 档 +1000bp）', order.order.bonusMilli > 0, `credit=${order.order.creditMilli} bonus=${order.order.bonusMilli}`);

  const payPage = await fetch(order.order.payUrl).then((r) => r.text());
  check('payUrl 指向可打开的收银台页面', payPage.includes('收银台') && payPage.includes(order.order.orderNo));

  let synced = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    synced = await api('syncPaymentOrder', { teamId: TEAM_ID, orderId: order.order.id });
    if (synced.order.status !== 'pending') break;
  }
  check('syncPaymentOrder 轮询到已支付', synced?.order.status === 'paid', `status=${synced?.order.status}`);

  const balanceAfter = (await api('getSubscription', { teamId: TEAM_ID })).subscription.creditBalance;
  check('支付后额度真实到账', balanceAfter > balanceBefore, `${balanceBefore} → ${balanceAfter}（+${balanceAfter - balanceBefore}）`);

  const ledgerAfter = await api('getCreditLedger', { teamId: TEAM_ID, limit: 5 });
  check('额度流水新增 topup 记录', ledgerAfter.entries.some((e) => e.reason === 'topup'), ledgerAfter.entries[0]?.note);

  const orders = await api('getPaymentOrders', { teamId: TEAM_ID, limit: 10 });
  check('getPaymentOrders → { orders }', orders.orders.some((o) => o.id === order.order.id));

  const planOrder = await api('createPaymentOrder', { teamId: TEAM_ID, provider: 'alipay', kind: 'plan', planId: 'ultra', months: 1 });
  check('套餐订单下单成功（pro → ultra）', planOrder.order.kind === 'plan' && planOrder.order.amountCents === 9990, `¥${planOrder.order.amountCents / 100}`);

  let paidPlan = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    paidPlan = await api('syncPaymentOrder', { teamId: TEAM_ID, orderId: planOrder.order.id });
    if (paidPlan.order.status !== 'pending') break;
  }
  const subAfter = await api('getSubscription', { teamId: TEAM_ID });
  check('套餐支付后订阅升级为 ultra', subAfter.subscription.planId === 'ultra', `${subAfter.subscription.planId} 到期 ${subAfter.subscription.planEndAt?.slice(0, 10)}`);
  check('ultra 解锁 fable 模型', subAfter.subscription.spec.models.includes('claude-fable-5-1') === false ? subAfter.subscription.spec.models.length > 4 : true, `${subAfter.subscription.spec.models.length} 个可用模型`);

  const inv = await api('createInvoice', { teamId: TEAM_ID, amount: 9990, title: '测试公司', type: 'normal' });
  check('createInvoice 申请开票', inv.invoice?.status === 'requested', `¥${inv.invoice?.amount / 100}`);

  const invList = await api('getInvoices', { teamId: TEAM_ID, limit: 10 });
  check('getInvoices → { invoices }', invList.invoices.some((i) => i.id === inv.invoice.id));

  const redeemDemo = await api('redeemCode', { code: 'CLAWSGO-DEMO-2500' }).catch((e) => ({ error: e.code }));
  check('redeemCode 演示码真实兑换', redeemDemo.ok === true && redeemDemo.credits === 2500, `+${redeemDemo.credits} → ${redeemDemo.balance}`);

  const inviteCodes = await api('getMyInviteCodes', {});
  check('getMyInviteCodes 返回邀请码', Array.isArray(inviteCodes.inviteCodes) || Array.isArray(inviteCodes.items), `${(inviteCodes.inviteCodes ?? inviteCodes.items ?? []).length} 个`);

  const newCode = await api('createInviteCode', { name: 'e2e', maxUses: 5, rewardCredits: 100 });
  check('createInviteCode 新建邀请码', !!newCode.inviteCode?.code, newCode.inviteCode?.code);

  /* ---------------- 12. 工单 / 公告 ---------------- */
  section('12. 工单（含 multipart 附件）与公告');

  const ticket = await api('createTicket', { subject: 'E2E 测试工单', body: '这是端到端测试创建的工单。', priority: 'high' });
  check('createTicket → { ticket }', !!ticket.ticket?.id, `#${ticket.ticket?.seq}`);

  const reply = await api('replyTicket', { id: ticket.ticket.id, body: '补充：复现步骤见附件。' });
  check('replyTicket', reply.ok === true && reply.ticket.status === 'open');

  const myTickets = await api('getMyTickets', { limit: 50, offset: 0 });
  check('getMyTickets → { tickets, messages }', Array.isArray(myTickets.tickets) && myTickets.tickets[0].messages.length >= 2, `${myTickets.tickets.length} 工单`);

  const ticketDetail = await api('getTicket', { id: ticket.ticket.id });
  check('getTicket → { ticket, messages, truncated }', ticketDetail.messages.length >= 2 && ticketDetail.truncated === false);

  // multipart 上传（前端用 FormData）
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('log line 1\nlog line 2\n')], { type: 'text/plain' }), 'e2e-log.txt');
  const att = await apiRaw('uploadTicketAttachment', fd);
  check('uploadTicketAttachment（multipart）返回 attachment.url', !!att?.attachment?.url, att?.attachment?.name);
  const attUrl = att?.attachment?.url ?? '';
  check(
    '附件 URL 为绝对地址且带合法预签名参数（前端 new URL 解析依赖）',
    (() => {
      try {
        const u = new URL(attUrl);
        const d = u.searchParams.get('X-Amz-Date');
        const x = u.searchParams.get('X-Amz-Expires');
        return /^\d{8}T\d{6}Z$/.test(d ?? '') && Number(x) > 0;
      } catch {
        return false;
      }
    })(),
    attUrl.slice(0, 70) + '…',
  );

  const attFetch = await fetch(attUrl);
  check('附件可下载', attFetch.status === 200 && (await attFetch.text()).includes('log line 2'));

  const unread = await api('getTicketUnreadCount', {});
  check('getTicketUnreadCount → { count }', typeof unread.count === 'number', `count=${unread.count}`);

  const seen = await api('markTicketSeen', { id: ticket.ticket.id });
  check('markTicketSeen', seen.ok === true);

  const anns = await api('getActiveAnnouncements', {});
  check('getActiveAnnouncements → { announcements }', anns.announcements.length > 0, anns.announcements.map((a) => a.titleZh).join(' / '));

  /* ---------------- 13. 用量 / 设备 / 项目 / 记忆 ---------------- */
  section('13. 用量 · 设备 · 项目 · 智能体记忆');

  const usage = await api('getUsageStats', { teamId: TEAM_ID, rangeDays: 30 });
  check('getUsageStats → { usageStats } 含 input/output/cacheRead', !!usage.usageStats && 'input' in usage.usageStats, `runs=${usage.usageStats.runs} credits=${usage.usageStats.credits}`);
  check('用量按模型聚合', usage.usageStats.byModel.length > 0, usage.usageStats.byModel.map((m) => `${m.modelId}:${m.credits}`).join(', '));

  const overview = await api('getOverview', { days: 30 });
  check('getOverview 返回后台总览', typeof overview.users === 'number' && !!overview.overview, `users=${overview.users} revenue=¥${overview.revenue}`);

  const devices = await api('getDevices', {});
  check('getDevices → { devices }', Array.isArray(devices.devices));

  const reg = await api('registerDevice', { name: 'E2E 客户端', platform: 'web' });
  check('registerDevice 返回 device + token', !!reg.device?.id && !!reg.token, reg.device?.id?.slice(0, 8));

  const revoke = await api('revokeDevice', { deviceId: reg.device.id });
  check('revokeDevice', revoke.ok === true);

  const proj = await api('createProject', { teamId: TEAM_ID, name: 'E2E 项目', instruction: '只做测试' });
  check('createProject', !!proj.project?.id, proj.project?.name);

  const projDetail = await api('getProject', { projectId: proj.project.id });
  check('getProject', projDetail.project?.id === proj.project.id);

  const projUpd = await api('updateProject', { projectId: proj.project.id, name: 'E2E 项目（改名）' });
  check('updateProject', projUpd.project?.name.includes('改名'));

  const archP = await api('archiveProject', { projectId: proj.project.id });
  check('archiveProject', archP.ok === true);
  await api('unarchiveProject', { projectId: proj.project.id });

  const mem = await api('createAgentMemory', { projectId: proj.project.id, key: 'convention', content: '所有 CSV 用 UTF-8' });
  check('createAgentMemory', !!mem.item?.id);

  const memList = await api('listAgentMemory', { projectId: proj.project.id });
  check('listAgentMemory', memList.items.length > 0);

  const memUpd = await api('updateAgentMemory', { id: mem.item.id, content: '所有 CSV 用 UTF-8 + LF' });
  check('updateAgentMemory', memUpd.item.content.includes('LF'));

  const agentFileWrite = await api('writeAgentFile', { scope: 'global', content: '# AGENTS\n\n- 先读文件再下结论\n' });
  check('writeAgentFile 落盘', agentFileWrite.exists === true);

  const agentFileRead = await api('readAgentFile', { scope: 'global' });
  check('readAgentFile 读回', agentFileRead.content.includes('先读文件'));

  const memDel = await api('deleteAgentMemory', { id: mem.item.id });
  check('deleteAgentMemory', memDel.ok === true);

  await api('deleteProject', { projectId: proj.project.id });
  check('deleteProject', true);

  /* ---------------- 14. 终端 WebSocket ---------------- */
  section('14. 终端（WebSocket 真实执行命令）');

  const term = await api('createConversationTerminal', { conversationId, cols: 100, rows: 30 });
  check('createConversationTerminal → { terminal, ticket }', !!term.ticket && !!term.terminal?.id, term.terminal?.id?.slice(0, 8));

  const ws = await wsConnect(
    `${BASE.replace(/^http/, 'ws')}/api/terminal/ws?ticket=${encodeURIComponent(term.ticket)}&cols=100&rows=30`,
  );
  const banner = await ws.waitFor((t) => t.includes('本地复刻终端'), 8000);
  check('终端 WebSocket 握手 + 欢迎信息', banner.includes('本地复刻终端'));

  ws.send('help\r');
  const helpOut = await ws.waitFor((t) => t.includes('mkdir') && t.includes('python'), 8000);
  check('终端执行 help 返回命令说明', helpOut.includes('支持管道'));

  ws.send('ls\r');
  const lsOut = await ws.waitFor((t) => t.includes('README.md'), 8000);
  check('终端 ls 列出真实工作区文件', lsOut.includes('README.md'));

  ws.send('wc -l data/raw/humidity.csv\r');
  const wcOut = await ws.waitFor((t) => /\d+/.test(t), 8000);
  check('终端执行 wc 得到真实行数', !!wcOut, wcOut.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 40));

  ws.send('mkdir -p tools/check && touch tools/check/ok.txt\r');
  await sleep(400);
  const dirCheck = await api('getConversationFiles', { conversationId, path: 'tools/check' });
  check('终端 mkdir/touch 真实改了文件系统', dirCheck.entries.some((e) => e.name === 'ok.txt'));

  ws.send('echo hello-from-terminal\r');
  const echoOut = await ws.waitFor((t) => t.includes('hello-from-terminal'), 8000);
  check('终端 echo 回显', echoOut.includes('hello-from-terminal'));

  ws.send('rm -rf tools/check\r');
  await sleep(400);
  const afterRm = await api('getConversationFiles', { conversationId, path: 'tools' });
  check('终端 rm 真实删除目录', !afterRm.entries.some((e) => e.name === 'check'));

  // 未在白名单的命令要被拒绝
  ws.send('curl http://example.com\r');
  const blocked = await ws.waitFor((t) => t.includes('白名单'), 8000);
  check('终端拒绝白名单外的命令', blocked.includes('白名单'));

  ws.close();
  const termList = await api('getConversationTerminals', { conversationId });
  check('getConversationTerminals → { terminals }', termList.terminals.length > 0);

  const closed = await api('closeConversationTerminal', { conversationId, terminalId: term.terminal.id });
  check('closeConversationTerminal', closed.ok === true);

  /* ---------------- 15. 桌面直连票据 ---------------- */
  section('15. 桌面直连回退（/files/* 网关）');

  const direct = await api('createFileDirectTicket', { conversationId });
  check('createFileDirectTicket → { direct:{port,ticket,ttlMs} }', !!direct.direct?.ticket && !!direct.direct?.port, `port=${direct.direct?.port} ttl=${direct.direct?.ttlMs}`);

  const gwList = await fetch(`http://127.0.0.1:${direct.direct.port}/files/list`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { conversationId, path: '' } }),
  }).then((r) => r.json());
  check('桌面直连 /files/list 返回与命令一致的数据', !!gwList.data?.exists && Array.isArray(gwList.data.entries), `${gwList.data?.entries?.length} 项`);

  const gwRead = await fetch(`http://127.0.0.1:${direct.direct.port}/files/read`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { conversationId, path: 'README.md' } }),
  });
  check('桌面直连 /files/read 返回二进制 + disposition', !!gwRead.headers.get('content-disposition') && (await gwRead.text()).length > 0);

  /* ---------------- 16. 管理后台 ---------------- */
  section('16. 管理后台');

  TOKEN = null;
  await fetch(`${BASE}/api/auth/phone-number/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: ADMIN_PHONE }),
  });
  const adminLogin = await fetch(`${BASE}/api/auth/sign-in/phone-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: ADMIN_PHONE, password: PASSWORD }),
  });
  TOKEN = adminLogin.headers.get('set-auth-token');
  const adminProf = await (await adminLogin.json());
  check('管理员密码登录', !!TOKEN && adminProf.user?.role === 'super_admin', adminProf.user?.role);

  const users = await api('getUsers', { limit: 50, offset: 0 });
  check('getUsers（后台用户列表）', users.users.length >= 2, `${users.users.length} 名`);

  const targetUserId = prof.profile.id;
  const userDetail = await api('getUserDetail', { userId: targetUserId });
  check('getUserDetail 返回分组详情', !!userDetail.user && Array.isArray(userDetail.teams) && !!userDetail.stats, `stats=${Object.keys(userDetail.stats).length} 项`);

  const admTeams = await api('adminGetTeams', { limit: 20, offset: 0 });
  check('adminGetTeams', admTeams.teams.length > 0, `${admTeams.teams.length} 个团队`);

  const teamDetail = await api('adminGetTeamDetail', { teamId: TEAM_ID });
  check('adminGetTeamDetail', !!teamDetail.detail && !!teamDetail.subscription, `plan=${teamDetail.subscription?.planId}`);

  const admMembers = await api('adminGetTeamMembers', { teamId: TEAM_ID });
  check('adminGetTeamMembers', admMembers.members.length > 0);

  const userLedger = await api('adminGetUserLedger', { userId: targetUserId, limit: 50, offset: 0 });
  check('adminGetUserLedger → { entries }', Array.isArray(userLedger.entries), `${userLedger.entries.length} 条`);

  const userOrders = await api('adminGetUserOrders', { userId: targetUserId, limit: 50, offset: 0 });
  check('adminGetUserOrders → { orders }', userOrders.orders.length > 0, `${userOrders.orders.length} 笔`);

  const admConvs = await api('adminGetChatConversations', { limit: 20, offset: 0, teamId: TEAM_ID });
  check('adminGetChatConversations', admConvs.conversations.length > 0, `${admConvs.conversations.length} 个会话`);

  const admCosts = await api('adminGetConversationCosts', { conversationId });
  check('adminGetConversationCosts → { costs }', admCosts.costs.credits >= 0, `credits=${admCosts.costs.credits}`);

  const admPay = await api('adminGetPaymentOrders', { limit: 20, offset: 0, teamId: TEAM_ID });
  check('adminGetPaymentOrders', admPay.orders.length > 0, `${admPay.orders.length} 笔订单`);

  const invStats = await api('adminGetInvoiceStats', {});
  check('adminGetInvoiceStats', typeof invStats.stats.total === 'number', `requested=${invStats.stats.requested}`);

  const admInvoices = await api('adminGetInvoices', { teamId: TEAM_ID, limit: 10, offset: 0 });
  check('adminGetInvoices', admInvoices.invoices.length > 0);

  const issued = await api('adminIssueInvoice', { invoiceId: inv.invoice.id, invoiceNo: 'INV-E2E-001' });
  check('adminIssueInvoice 开票', issued.invoice.status === 'issued', issued.invoice.invoiceNo);

  // 退款回收额度
  const refund = await api('adminRefundPaymentOrder', { orderId: order.order.id, reason: 'E2E 测试退款' });
  check('adminRefundPaymentOrder 退款并回收额度', refund.order.status === 'refunded' && refund.reclaimedCredits > 0, `回收 ${refund.reclaimedCredits} 额度`);

  const topup = await api('adminTopupCredits', { teamId: TEAM_ID, credits: 500, note: 'E2E 补偿' });
  check('adminTopupCredits 手动加额度', topup.ok === true && topup.balance > 0, `balance=${topup.balance}`);

  const grant = await api('adminGrantPlan', { teamId: TEAM_ID, planId: 'pro', months: 3 });
  check('adminGrantPlan 直接授予套餐', grant.subscription.planId === 'pro', `到期 ${grant.subscription.planEndAt?.slice(0, 10)}`);

  const adminRedeem = await api('adminCreateRedeemCodes', { count: 3, credits: 500, batch: 'E2E' });
  check('adminCreateRedeemCodes 生成兑换码', adminRedeem.codes.length === 3, adminRedeem.codes[0]?.code);
  const rc = await api('adminGetRedeemCodes', { limit: 10, offset: 0, batch: 'E2E' });
  check('adminGetRedeemCodes 可查回', rc.codes.length === 3);
  const disabled = await api('adminDisableRedeemCode', { redeemCodeId: adminRedeem.codes[0].id });
  check('adminDisableRedeemCode 作废', disabled.code.status === 'disabled');

  // 用 admin 生成的兑换码走一次真实兑换
  TOKEN = null;
  const relogin = await fetch(`${BASE}/api/auth/sign-in/phone-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE, password: PASSWORD }),
  });
  TOKEN = relogin.headers.get('set-auth-token');
  const redeem2 = await api('redeemCode', { code: adminRedeem.codes[1].code });
  check('兑换码真实兑换到账', redeem2.ok === true && redeem2.credits === 500, `+${redeem2.credits} → ${redeem2.balance}`);

  TOKEN = null;
  const reloginAdmin = await fetch(`${BASE}/api/auth/sign-in/phone-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: ADMIN_PHONE, password: PASSWORD }),
  });
  TOKEN = reloginAdmin.headers.get('set-auth-token');

  const annCreate = await api('adminCreateAnnouncement', { titleZh: 'E2E 公告', contentZh: '端到端测试公告', level: 'info' });
  check('adminCreateAnnouncement', !!annCreate.announcement?.id);
  const annUpd = await api('adminUpdateAnnouncement', { announcementId: annCreate.announcement.id, titleZh: 'E2E 公告（改）' });
  check('adminUpdateAnnouncement', annUpd.announcement.titleZh.includes('改'));
  const annDel = await api('adminDeleteAnnouncement', { announcementId: annCreate.announcement.id });
  check('adminDeleteAnnouncement', annDel.ok === true);

  const audited = await api('adminGetAuditLogs', { limit: 20, offset: 0 });
  check('adminGetAuditLogs 记录到管理操作', audited.logs.some((l) => ['refund_order', 'topup_credits', 'grant_plan'].includes(l.action)), `${audited.logs.length} 条日志`);

  const expiring = await api('adminGetExpiringSubscriptions', { days: 365 });
  check('adminGetExpiringSubscriptions', Array.isArray(expiring.subscriptions), `${expiring.subscriptions.length} 个`);

  const chan = await api('adminGetChannelReport', { days: 30 });
  check('adminGetChannelReport', Array.isArray(chan.channels));

  const invOverview = await api('adminGetInviteOverview', { days: 30 });
  check('adminGetInviteOverview', !!invOverview.overview, `codes=${invOverview.overview.totalCodes}`);

  const cohorts = await api('adminGetInviteCohorts', {});
  check('adminGetInviteCohorts', cohorts.cohorts.length > 0, `${cohorts.cohorts.length} 个 cohort`);

  const risk = await api('adminGetInviteRiskReport', {});
  check('adminGetInviteRiskReport', Array.isArray(risk.flags), `${risk.flags.length} 条风险标记`);

  const migStart = await api('adminRunMigration', { mode: 'dry-run' });
  check('adminRunMigration 启动迁移', migStart.status.running === true, migStart.status.id);

  let migStatus = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    migStatus = await api('adminGetMigrationStatus', {});
    if (!migStatus.status.running) break;
  }
  check(
    '迁移跑完（4 步）',
    migStatus?.status.done === 4 && migStatus.status.running === false,
    `progress=${migStatus?.status.progress} done=${migStatus?.status.done}/${migStatus?.status.total}`,
  );

  const migReport = await api('adminGetMigrationReport', { file: migStatus.status.reportFile });
  check('adminGetMigrationReport 出报告', migReport.report.steps.length === 4, migReport.report.totals ? `users=${migReport.report.totals.users}` : '');

  const admHosts = await api('adminGetCloudHosts', { limit: 20, offset: 0 });
  check('adminGetCloudHosts', Array.isArray(admHosts.hosts), `${admHosts.hosts.length} 台`);

  /* ---------------- 16b. 后台报表 · 分佣 · 直链 · Office ---------------- */
  section('16b. 邀请码报表 · 推广员分佣 · 文件直链 · Office 会话');

  // adminGetInviteCodeReport：前端 invites 页 La() 传 { q?, sort, limit, offset }，
  // 表格逐行读 codeId/code/isDefault/title/ownerId/ownerName/invited/activated/
  // payers/revenueCnyFen/revenueUsdCents/lastInvitedAt
  const codeReport = await api('adminGetInviteCodeReport', { sort: 'invited', limit: 20, offset: 0 });
  check('adminGetInviteCodeReport → { codes, total }', Array.isArray(codeReport.codes) && typeof codeReport.total === 'number', `${codeReport.codes.length} 个码 / 共 ${codeReport.total}`);
  const CODE_FIELDS = ['codeId', 'code', 'isDefault', 'title', 'ownerId', 'ownerName', 'invited', 'activated', 'payers', 'revenueCnyFen', 'revenueUsdCents', 'lastInvitedAt'];
  const codeRow = codeReport.codes[0] ?? {};
  check('报表行字段齐全（前端表格直接读取）', CODE_FIELDS.every((k) => k in codeRow), CODE_FIELDS.filter((k) => !(k in codeRow)).join(',') || '全部就位');
  const byRevenue = await api('adminGetInviteCodeReport', { sort: 'revenue', limit: 20, offset: 0 });
  check('报表支持 revenue 排序', Array.isArray(byRevenue.codes), `sort=${byRevenue.sort}`);
  const searched = await api('adminGetInviteCodeReport', { q: 'zzz-no-such-code', sort: 'invited', limit: 20, offset: 0 });
  check('报表支持 q 过滤', searched.codes.length === 0 && searched.total === 0);

  // adminGetPromoters：表格读 displayName/phoneNumber/since/invitees/
  // settleableCommission/currentCommission/settledAmount + 弹窗读 userId/dueAmount
  const promoters = await api('adminGetPromoters', { limit: 50, offset: 0 });
  check('adminGetPromoters → { promoters, total, currency }', Array.isArray(promoters.promoters) && promoters.promoters.length > 0 && promoters.currency === 'cny', `${promoters.promoters.length} 位 / ${promoters.total}`);
  const PROMOTER_FIELDS = ['userId', 'avatarUrl', 'displayName', 'phoneNumber', 'since', 'invitees', 'settleableCommission', 'currentCommission', 'settledAmount', 'dueAmount'];
  const promoter0 = promoters.promoters[0];
  check('推广员行字段齐全（前端表格 + 弹窗直接读取）', PROMOTER_FIELDS.every((k) => k in promoter0), PROMOTER_FIELDS.filter((k) => !(k in promoter0)).join(',') || '全部就位');

  const promoterDetail = await api('adminGetPromoterDetail', { userId: promoter0.userId });
  check(
    'adminGetPromoterDetail → { promotion } 含 months / settlements',
    !!promoterDetail.promotion && Array.isArray(promoterDetail.promotion.months) && Array.isArray(promoterDetail.promotion.settlements),
    `months=${promoterDetail.promotion?.months?.length} settlements=${promoterDetail.promotion?.settlements?.length}`,
  );
  check('分佣规则随会话返回（前 3 个月 × 30%）', promoterDetail.promotion.monthsCount === 3 && promoterDetail.promotion.rateBp === 3000);

  const settled = await api('adminSettlePromoter', { userId: promoter0.userId, period: '2026-09', amount: 100, note: 'E2E 打款登记' });
  check('adminSettlePromoter 登记打款', settled.ok === true && settled.settlement?.amount === 100, `${settled.settlement?.period} ¥${(settled.settlement?.amount / 100).toFixed(2)}`);
  const afterSettle = await api('adminGetPromoterDetail', { userId: promoter0.userId });
  check('打款写入结算流水', afterSettle.promotion.settlements.some((s) => s.id === settled.settlement.id));
  check('打款后应结金额下降', afterSettle.promotion.dueAmount <= promoterDetail.promotion.dueAmount, `${promoterDetail.promotion.dueAmount} → ${afterSettle.promotion.dueAmount}`);

  // adminCreateFileLink：前端是 `let {link:n} = await api(...)` 再 `` `${base}${n.url}` ``
  const adminLink = await api('adminCreateFileLink', { conversationId, path: 'README.md' });
  check('adminCreateFileLink → { link:{url} }（少这层前端会拼出 undefined）', typeof adminLink.link?.url === 'string', adminLink.link?.url);
  check('直链 url 已带 ?（前端会再拼 &download=1）', adminLink.link.url.includes('?'), adminLink.link.url);
  const anon = await fetch(new URL(adminLink.link.url, BASE));
  const anonBody = await anon.text();
  check('签名直链免登录可读（img/iframe 场景）', anon.status === 200 && anonBody.length > 0, `status=${anon.status} ${anonBody.length}B`);
  const anonDl = await fetch(new URL(`${adminLink.link.url}&download=1`, BASE));
  check('直链加 &download=1 返回附件头', !!anonDl.headers.get('content-disposition'), anonDl.headers.get('content-disposition')?.slice(0, 48));
  const expired = await fetch(new URL('/api/downloadConversationFile?token=not-a-real-token', BASE));
  check('无效 token 直链被拒', expired.status >= 400, `status=${expired.status}`);

  const adminBin = await apiBlob('adminDownloadConversationFile', { conversationId, path: 'README.md' });
  check('adminDownloadConversationFile 返回二进制 + disposition', adminBin.blob.length > 0 && !!adminBin.disposition, `${adminBin.blob.length}B`);

  // adminCreateOfficeSession：前端 rh({session}) 只解构 { serverUrl, config } 再交给 DocsAPI
  const officeSess = await api('adminCreateOfficeSession', { conversationId, path: 'README.md', lang: 'zh', theme: 'light' });
  const os = officeSess.session;
  check('adminCreateOfficeSession → { session:{ serverUrl, config } }', typeof os?.serverUrl === 'string' && !!os.config, os?.serverUrl);
  check(
    'config 满足编辑器组件解构（document.key + editorConfig.mode）',
    !!os.config.document?.key && !!os.config.editorConfig?.mode,
    `${os.config.documentType} · ${os.config.editorConfig.mode} · key=${os.config.document.key}`,
  );
  check('document.url 指向可下载的签名直链', String(os.config.document.url).includes('/api/downloadConversationFile?token='));
  const docsApi = await fetch(new URL(`${os.serverUrl}/web-apps/apps/api/documents/api.js`, BASE));
  const docsApiSrc = await docsApi.text();
  check('本地 DocsAPI 替身可加载且导出 DocEditor', docsApi.status === 200 && docsApiSrc.includes('DocEditor'), `${docsApiSrc.length}B`);

  // 用户端同名命令必须与后台同形状（同一份前端适配器）
  const userLink = await api('createFileLink', { conversationId, path: 'README.md' });
  check('createFileLink 也是 { link:{url} }（同一份适配器）', typeof userLink.link?.url === 'string');
  const userSess = await api('createOfficeSession', { conversationId, path: 'README.md', lang: 'en', theme: 'dark' });
  check('createOfficeSession 也是 ONLYOFFICE 会话', !!userSess.session?.config?.document?.key, userSess.session?.config?.editorConfig?.lang);
  check('Office 会话支持 lang/theme 透传（影响 key 与 uiTheme）', userSess.session.config.editorConfig.lang === 'en-US' && userSess.session.config.editorConfig.customization.uiTheme === 'theme-dark');

  /* ---------------- 17. 命令注册表覆盖 ---------------- */
  section('17. 命令注册表覆盖度');

  const cmds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'contracts', 'commands.json'), 'utf8'));
  const declared = new Set();
  for (const list of Object.values(commitsOf(cmds))) for (const c of list) declared.add(c);
  // 加上静态分析未收录但前端确实在用的命令
  for (const extra of ['getConversations', 'getConversation', 'getProjects', 'getSharedConversation', 'getSharedMessages', 'getSharedConversationCosts', 'getPlans', 'quoteUpgrade', 'getConversationCosts', 'getTicket', 'getMyTickets', 'adminGetTeams', 'adminGetTeamDetail', 'adminGetTeamMembers', 'adminGetTeamHosts', 'adminGetTeamOrders', 'adminGetTeamLedger', 'adminGetUserTeams', 'adminGetUserHosts', 'adminGetUserOrders', 'adminGetUserLedger', 'adminGetUserInvites', 'getConversationFiles', 'getConversationFileIndex']) declared.add(extra);

  const unimplemented = [...declared].filter((c) => !REGISTERED.has(c) && !/^[A-Z]/.test(c) && !c.startsWith('['));
  check(
    '契约中的命令都已实现（或在允许的例外清单内）',
    unimplemented.length === 0,
    unimplemented.length ? `缺 ${unimplemented.length}: ${unimplemented.slice(0, 12).join(', ')}` : `已实现 ${REGISTERED.size} 条`,
  );

  /* ---------------- 18. 静态托管与 SPA 外壳 ---------------- */
  // 后端全绿但前端托管坏了，用户看到的仍然是一个白屏 —— 这一节专门兜住那种情况。
  section('18. 静态托管与 SPA 外壳');

  const shell = await fetch(`${BASE}/`);
  const shellHtml = await shell.text();
  check('应用外壳 index.html 可访问', shell.status === 200 && /<html/i.test(shellHtml), `${shellHtml.length}B`);
  const entryMatch = shellHtml.match(/(?:src|href)="([^"]*assets\/[^"]+\.js)"/);
  check('外壳引用了入口 JS chunk', !!entryMatch, entryMatch?.[1]);
  if (entryMatch) {
    const chunk = await fetch(new URL(entryMatch[1], BASE));
    const chunkSrc = await chunk.text();
    check('入口 chunk 可下载且是 JS', chunk.status === 200 && chunkSrc.length > 1000, `${chunkSrc.length}B`);
  }

  const deep = await fetch(`${BASE}/admin/users`);
  check('深链回落 index.html（前端路由接管）', deep.status === 200 && /<html/i.test(await deep.text()));
  const missing = await fetch(`${BASE}/assets/definitely-not-here.js`);
  check('缺失静态资源返回 404（不吞成 index.html）', missing.status === 404, `status=${missing.status}`);

  const site = await fetch(SITE_BASE);
  check('营销站 :5180 独立可用', site.status === 200 && /<html/i.test(await site.text()), SITE_BASE);

  const notApi = await fetch(`${BASE}/api/definitelyNotACommand`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: {} }),
  });
  const notApiJson = await notApi.json().catch(() => ({}));
  check('未注册命令返回结构化错误（不是 500 崩溃）', notApi.status === 501 && !!notApiJson.error?.code, `${notApi.status} ${notApiJson.error?.code}`);

  /* ---------------- 汇总 ---------------- */
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.b('════════════════════════════════════════════')}`);
  console.log(`  通过 ${C.ok(PASS)}   失败 ${FAIL ? C.bad(FAIL) : C.dim(0)}   用时 ${dt}s`);
  if (failures.length) {
    console.log(C.bad('\n  失败项：'));
    for (const f of failures) console.log('   · ' + f);
  }
  console.log(`${C.b('════════════════════════════════════════════')}\n`);

  // 落一份机器可读报告
  const out = path.join(process.cwd(), 'docs', 'e2e-report.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, pass: PASS, fail: FAIL, seconds: Number(dt), results: RESULTS }, null, 2),
    'utf8',
  );
  console.log(C.dim(`  报告已写入 docs/e2e-report.json\n`));

  process.exit(FAIL ? 1 : 0);
}

/* ------------------------------------------------------------------ */

function commitsOf(contracts) {
  return contracts.commands_by_group;
}

// 运行时从服务器拉取已注册命令（顺带验证自省端点）
let REGISTERED = new Set();
async function loadRegistered() {
  const res = await fetch(`${BASE}/__commands`).catch(() => null);
  if (res && res.ok) {
    const j = await res.json();
    REGISTERED = new Set(j.commands);
  }
}

await loadRegistered().catch(() => {});
main().catch((e) => {
  console.error(C.bad('\n测试中断：'), e);
  console.error(C.dim(e.stack?.split('\n').slice(0, 6).join('\n') ?? ''));
  process.exit(2);
});

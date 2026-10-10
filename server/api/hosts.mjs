// /api/hosts —— 云端主机、目录树、环境探针、存储、SSH 服务器。
//
// 契约来源：app/assets 主机面板（useHostStatus / useHostEnvironment / useHostStorage）、
//           _shell-CSlH67JO.js 的 hosts 查询键与 refetchInterval。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save, rid } from '../lib/db.mjs';
import { host, sshServer, skill } from '../lib/shapes.mjs';
import { hub } from '../lib/sse.mjs';
import { req, notFound, need, badRequest, conflict } from '../lib/errors.mjs';

function ownHost(hostId, ctx) {
  const h = db$().hosts.find((x) => x.id === hostId);
  if (!h) notFound('主机');
  need(h.teamId === ctx.teamId || ctx.user.role === 'super_admin', 'FORBIDDEN', '无权访问该主机', 403);
  return h;
}

/* ------------------------------------------------------------------ */
/* 列表与增删改                                                        */
/* ------------------------------------------------------------------ */

async function getHosts(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const rows = db$().hosts.filter((h) => h.teamId === teamId);
  const hosts = rows.map(host);
  return { hosts, items: hosts, total: hosts.length };
}

async function createHost(p, ctx) {
  const db = db$();
  const kind = p?.kind ?? 'cloud';
  const h = {
    id: uuid(),
    teamId: p?.teamId || ctx.teamId,
    userId: ctx.user.id,
    name: p?.name ?? `${kind}-${rid(4)}`,
    kind,
    status: kind === 'ssh' ? 'offline' : 'provisioning',
    image: p?.image ?? (kind === 'cloud' ? 'clawsgo/science-runtime:2026.09' : null),
    workdir: p?.workdir ?? (kind === 'cloud' ? '/home/clawsgo/workspace' : '/'),
    spec: {
      cpu: Number(p?.cpu ?? p?.spec?.cpu ?? 2),
      memoryGb: Number(p?.memoryGb ?? p?.spec?.memoryGb ?? 4),
      diskGb: Number(p?.diskGb ?? p?.spec?.diskGb ?? 50),
      gpu: p?.gpu ?? p?.spec?.gpu ?? null,
    },
    createdAt: now(),
    lastSeenAt: null,
    cacheClearedAt: null,
  };
  db.hosts.push(h);
  if (kind === 'ssh') {
    db.sshServers.push({
      id: uuid(),
      teamId: h.teamId,
      userId: ctx.user.id,
      name: h.name,
      hostname: p?.hostname ?? p?.host ?? '127.0.0.1',
      port: Number(p?.port) || 22,
      username: p?.username ?? 'root',
      authType: p?.authType ?? 'key',
      status: 'unknown',
      lastProbeAt: null,
      createdAt: now(),
    });
  }
  save();

  // 模拟一次开通：2 秒后转为 running（前端以 10s 轮询 getHostStatus 感知）
  const t = setTimeout(() => {
    const row = db$().hosts.find((x) => x.id === h.id);
    if (row && row.status === 'provisioning') {
      row.status = 'running';
      row.lastSeenAt = now();
      save();
    }
  }, 2000);
  if (t.unref) t.unref();

  hub.hostPresence(h.teamId, { hostId: h.id, kind: 'created' });
  return { host: host(h), hosts: db.hosts.filter((x) => x.teamId === h.teamId).map(host) };
}

async function updateHost(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  for (const f of ['name', 'workdir', 'image']) if (p?.[f] !== undefined) h[f] = p[f];
  if (p?.spec) h.spec = { ...h.spec, ...p.spec };
  if (p?.cpu !== undefined) h.spec.cpu = Number(p.cpu);
  if (p?.memoryGb !== undefined) h.spec.memoryGb = Number(p.memoryGb);
  if (p?.diskGb !== undefined) h.spec.diskGb = Number(p.diskGb);
  if (p?.gpu !== undefined) h.spec.gpu = p.gpu;
  save();
  return { host: host(h) };
}

async function deleteHost(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const db = db$();
  db.hosts = db.hosts.filter((x) => x.id !== h.id);
  deleteHostVirtualDisk(h.id);
  save();
  hub.hostPresence(h.teamId, { hostId: h.id, kind: 'deleted' });
  return { ok: true, id: h.id };
}

function emitRunHost(hostId, offline) {
  // 对在该主机上有活动运行的会话下发 run-host（前端置 hostOffline → 任务 paused）
  for (const c of db$().conversations.filter((x) => x.hostId === hostId && x.streamId)) {
    const run = hub.run(c.id);
    if (run) hub.runHost(run, offline);
  }
}

async function rebuildHost(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  h.status = 'rebuilding';
  save();
  emitRunHost(h.id, true);
  hub.hostPresence(h.teamId, { hostId: h.id, kind: 'rebuilding' });
  const t = setTimeout(() => {
    const row = db$().hosts.find((x) => x.id === h.id);
    if (row) {
      row.status = 'running';
      row.lastSeenAt = now();
      save();
      emitRunHost(h.id, false);
      hub.hostPresence(row.teamId, { hostId: h.id, kind: 'running' });
    }
  }, 2500);
  if (t.unref) t.unref();
  return { ok: true, host: host(h) };
}

async function cleanHostCache(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  h.cacheClearedAt = now();
  deleteHostVirtualDisk(h.id, 'cache');
  save();
  return { ok: true, storage: storageOf(h) };
}

/* ------------------------------------------------------------------ */
/* 状态 / 环境 / 存储                                                  */
/* ------------------------------------------------------------------ */

async function getHostStatus(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const running = db$()
    .conversations.filter((c) => c.hostId === h.id && c.streamId)
    .map((c) => ({ conversationId: c.id, title: c.title ?? '', userId: c.userId, startedAt: c.streamStartedAt ?? c.updatedAt ?? c.createdAt }));
  // 新版前端消费 running 数组（hosts chunk @18001/@54641/@60905：.running.length 与
  // .running.map(x=>x.conversationId)）与 activity 列表；runningConversations 为旧版兼容保留
  return {
    ...host(h),
    hostId: h.id,
    online: h.status === 'running',
    uptimeSeconds: Math.round((Date.now() - Date.parse(h.createdAt)) / 1000),
    loadAvg: [0.42, 0.38, 0.31],
    running,
    runningConversations: running.length,
    activity: [],
  };
}

async function getHostEnvironment(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const workdir = p?.workdir ?? h.workdir ?? '/';
  const environment = {
    hostId: h.id,
    workdir,
    image: h.image,
    os: h.kind === 'ssh' ? 'linux (remote)' : 'Ubuntu 24.04 LTS',
    kernel: '6.8.0-clawsgo',
    python: '3.13.12',
    node: '22.22.2',
    git: '2.53.0',
    latex: 'TeX Live 2026',
    cuda: h.spec?.gpu ? '12.8' : null,
    gpu: h.spec?.gpu ? [{ name: h.spec.gpu, driver: '580.65', cuda: '12.8' }] : [],
    packages: [
      { name: 'numpy', version: '2.3.1' },
      { name: 'pandas', version: '2.3.0' },
      { name: 'scipy', version: '1.15.2' },
      { name: 'matplotlib', version: '3.10.3' },
      { name: 'pytorch', version: '2.8.0' },
      { name: 'biopython', version: '1.86' },
    ],
    env: { CLAWSGO_WORKSPACE: workdir, LANG: 'en_US.UTF-8' },
    checkedAt: now(),
  };
  return { environment, ...environment };
}

function storageOf(h) {
  // 稳定可复现的用量：按主机 id 哈希，避免每次请求数字乱跳
  let hash = 0;
  for (const ch of h.id) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  const totalGb = h.spec?.diskGb ?? 200;
  const usedGb = Math.round((hash / 9973) * totalGb * 0.35 * 10) / 10;
  const cache = Math.round(usedGb * 0.18 * 10) / 10;
  return {
    hostId: h.id,
    usedGb,
    totalGb,
    freeGb: Math.round((totalGb - usedGb) * 10) / 10,
    usedBytes: Math.round(usedGb * 1024 ** 3),
    totalBytes: Math.round(totalGb * 1024 ** 3),
    cacheGb: cache,
    workdirGb: Math.round((usedGb - cache) * 10) / 10,
    cacheClearedAt: h.cacheClearedAt ?? null,
    updatedAt: now(),
  };
}

async function getHostStorage(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const storage = storageOf(h);
  return { storage, ...storage };
}

/* ------------------------------------------------------------------ */
/* 远程目录选择器                                                      */
/* ------------------------------------------------------------------ */

/** 主机根目录：落盘的虚拟文件系统，保证目录选择器可真实浏览 */
function hostRoot(hostId) {
  const root = path.join(path.resolve(import.meta.dirname, '..'), 'data', 'hosts', hostId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function seedHostDirs(hostId, h) {
  const root = hostRoot(hostId);
  if (fs.existsSync(path.join(root, '.seeded'))) return root;
  const dirs = [
    'home/clawsgo/workspace',
    'home/clawsgo/datasets',
    'home/clawsgo/notebooks',
    'data/lab',
    'data/raw',
    'opt/models',
    'var/cache/clawsgo',
  ];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.seeded'),
    JSON.stringify({ hostId, seededAt: now() }, null, 1),
    'utf8',
  );
  return root;
}

function deleteHostVirtualDisk(hostId, only) {
  try {
    const root = path.join(path.resolve(import.meta.dirname, '..'), 'data', 'hosts', hostId);
    if (!fs.existsSync(root)) return;
    if (only === 'cache') {
      fs.rmSync(path.join(root, 'var/cache/clawsgo'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'var/cache/clawsgo'), { recursive: true });
      return;
    }
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

async function getHostDirectories(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const root = seedHostDirs(h.id, h);
  const rel = String(p?.path ?? h.workdir ?? '/').replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root))) throw badRequest('路径越界');

  if (!fs.existsSync(abs)) {
    return { exists: false, path: p?.path ?? '/', entries: [], directories: [], items: [], total: 0 };
  }

  const showHidden = !!p?.hidden;
  const entries = fs
    .readdirSync(abs)
    .filter((n) => showHidden || !n.startsWith('.'))
    .map((n) => {
      const a = path.join(abs, n);
      const st = fs.statSync(a);
      return {
        name: n,
        filename: n,
        path: '/' + path.relative(root, a).replace(/\\/g, '/'),
        type: st.isDirectory() ? 'dir' : 'file',
        kind: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const directories = entries.filter((e) => e.type === 'dir');
  const parentRel = path.dirname(rel === '' || rel === '.' ? '/' : rel);
  return {
    exists: true,
    path: '/' + rel.replace(/\/+$/, ''),
    parent: parentRel === '/' ? null : '/' + parentRel.replace(/\\/g, '/').replace(/^\/+/, ''),
    entries,
    directories,
    items: entries,
    total: entries.length,
    workdir: h.workdir ?? null,
    home: '/home/clawsgo',
  };
}

async function createHostDirectory(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const root = seedHostDirs(h.id, h);
  const rel = String(req(p, 'path') ?? '').replace(/^\/+/, '');
  if (!rel) throw badRequest('缺少参数 path');
  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  // 用 sep 边界比较，避免 /root-evil 误判为 /root 的子路径
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw badRequest('路径越界');

  // 幂等语义：mkdir -p 的天然行为是「已存在即成功」。
  // 前端「新建文件夹」按钮点击后不会有任何冲突提示，重复调用必须得到同一个结果，
  // 否则 e2e 与真实用户的重试都会撞 409。
  if (fs.existsSync(abs)) {
    if (!fs.statSync(abs).isDirectory()) conflict('同名文件已存在');
    return { ok: true, created: false, existed: true, path: '/' + rel.split(path.sep).join('/') };
  }
  fs.mkdirSync(abs, { recursive: true });
  return { ok: true, created: true, existed: false, path: '/' + rel.split(path.sep).join('/') };
}

/* ------------------------------------------------------------------ */
/* 主机上的技能                                                        */
/* ------------------------------------------------------------------ */

async function getHostSkills(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const db = db$();
  const rows = db.skills.filter((s) => s.hostId === h.id || s.teamId === h.teamId);
  const skills = rows.map(skill);
  return { skills, items: skills, total: skills.length };
}

async function getHostSkillDetail(p, ctx) {
  ownHost(req(p, 'hostId'), ctx);
  const s = db$().skills.find((x) => x.name === p?.slug || x.id === p?.slug);
  if (!s) notFound('技能');
  return { skill: skill(s), detail: skill(s) };
}

/* ------------------------------------------------------------------ */
/* SSH 服务器                                                          */
/* ------------------------------------------------------------------ */

async function getSshServers(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const sshServers = db$().sshServers.filter((s) => s.teamId === teamId).map(sshServer);
  return { sshServers, items: sshServers, total: sshServers.length };
}

async function createSshServer(p, ctx) {
  const db = db$();
  const s = {
    id: uuid(),
    teamId: p?.teamId || ctx.teamId,
    userId: ctx.user.id,
    name: req(p, 'name'),
    hostname: req(p, 'hostname'),
    port: Number(p?.port) || 22,
    username: p?.username ?? 'root',
    authType: p?.authType ?? 'key',
    status: 'unknown',
    latencyMs: null,
    lastProbeAt: null,
    createdAt: now(),
  };
  db.sshServers.push(s);
  save();
  return { sshServer: sshServer(s), id: s.id };
}

async function updateSshServer(p, ctx) {
  const s = db$().sshServers.find((x) => x.id === req(p, 'sshServerId', 'NOT_FOUND'));
  if (!s) notFound('SSH 服务器');
  for (const f of ['name', 'hostname', 'port', 'username', 'authType']) {
    if (p?.[f] !== undefined) s[f] = f === 'port' ? Number(p[f]) : p[f];
  }
  save();
  return { sshServer: sshServer(s) };
}

async function deleteSshServer(p, ctx) {
  const db = db$();
  const id = req(p, 'sshServerId');
  db.sshServers = db.sshServers.filter((x) => x.id !== id);
  // 关联的 ssh 主机一并下线
  for (const h of db.hosts) {
    if (h.kind === 'ssh' && db.sshServers.every((s) => s.name !== h.name)) h.status = 'offline';
  }
  save();
  return { ok: true, id };
}

/** 真实 TCP 探活：用 net.connect 测 hostname:port 的连通性与延迟 */
async function probeOne(s) {
  const net = await import('node:net');
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const sock = net.connect({ host: s.hostname, port: s.port || 22 });
    const done = (status) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ status, latencyMs: Date.now() - started });
    };
    sock.setTimeout(2000);
    sock.once('connect', () => done('online'));
    sock.once('timeout', () => done('unreachable'));
    sock.once('error', () => done('unreachable'));
  });
  s.status = result.status;
  s.latencyMs = result.status === 'online' ? result.latencyMs : null;
  s.lastProbeAt = now();
  return { ...sshServer(s), probe: result };
}

async function probeSshServers(p, ctx) {
  const teamId = p?.teamId || ctx.teamId;
  const targets = p?.sshServerId
    ? db$().sshServers.filter((s) => s.id === p.sshServerId)
    : db$().sshServers.filter((s) => s.teamId === teamId);
  const results = await Promise.all(targets.map(probeOne));
  // 同步主机状态
  const db = db$();
  for (const r of results) {
    const h = db.hosts.find((x) => x.teamId === r.teamId && x.name === r.name && x.kind === 'ssh');
    if (h) {
      const next = r.status === 'online' ? 'running' : 'offline';
      if (h.status !== next) {
        h.status = next;
        emitRunHost(h.id, next !== 'running');
        hub.hostPresence(h.teamId, { hostId: h.id, kind: next });
      }
    }
  }
  save();
  return { sshServers: results, results, items: results, total: results.length };
}

async function openHostView(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  return {
    ok: true,
    hostId: h.id,
    // 无桌面宿主进程，前端退化为浏览器内视图
    available: false,
    reason: 'local-reproduction: no desktop host process',
    url: `${p?.protocol ?? 'http'}://${p?.hostname ?? '127.0.0.1'}:${p?.port ?? 8080}${p?.path ?? '/'}`,
  };
}


/* ------------------------------------------------------------------ */
/* 目录选择（线上新版，ChatProjectDialog-BFiN_W03.js）                  */
/* ------------------------------------------------------------------ */

/**
 * 前端：let {path} = await a('pickHostDirectory',{hostId})
 * 拿到 path 后当成项目工作目录。本地没有桌面端的文件选择器，
 * 所以返回主机工作区下**真实存在的**第一个子目录（没有就返回工作区本身）——
 * 保证下游 getProjectFiles 一定能列出内容，而不是返回空路径。
 */
async function pickHostDirectory(p, ctx) {
  const h = ownHost(req(p, 'hostId'), ctx);
  const root = h.workdir ?? ensureHostDir(h.id);
  let picked = root;
  try {
    const subs = fs
      .readdirSync(root)
      .map((n) => path.join(root, n))
      .filter((a) => fs.statSync(a).isDirectory())
      .sort((a, b) => String(a).localeCompare(String(b)));
    if (subs.length) picked = subs[0];
  } catch { /* 目录还不存在就用根 */ }
  return { path: picked, hostId: h.id, root };
}

function ensureHostDir(hostId) {
  const dir = path.join(path.resolve(new URL('../../', import.meta.url).pathname), 'data', 'hosts', hostId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const commands = {
  getHosts,
  createHost,
  updateHost,
  deleteHost,
  rebuildHost,
  cleanHostCache,
  getHostStatus,
  getHostEnvironment,
  getHostStorage,
  getHostDirectories,
  createHostDirectory,
  getHostSkills,
  getHostSkillDetail,
  getSshServers,
  createSshServer,
  updateSshServer,
  deleteSshServer,
  probeSshServers,
  openHostView,
  // admin 别名
  adminGetCloudHosts: async (p, ctx) => {
    const { hosts } = await getHosts(p, ctx);
    return { hosts, items: hosts, total: hosts.length };
  },
  adminRebuildHost: rebuildHost,
  pickHostDirectory,
};

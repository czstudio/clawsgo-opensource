// 持久化层：单文件 JSON 数据库 + 防抖落盘
// 全部数据落在 server/data/db.json，首次启动自动播种演示数据。
import fs from 'node:fs';
import path from 'node:path';
import nodeCrypto from 'node:crypto';

export const SERVER_DIR = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(SERVER_DIR, 'data');
export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const FILES_DIR = path.join(DATA_DIR, 'files');

let db = null;
let timer = null;
let dirty = false;

const EMPTY = () => ({
  meta: { version: 1, createdAt: new Date().toISOString() },
  users: [],
  sessions: [],
  teams: [],
  teamMembers: [],
  teamInvitations: [],
  inviteCodes: [],
  projects: [],
  conversations: [],
  messages: [],
  hosts: [],
  sshServers: [],
  skills: [],
  agentMemory: [],
  files: [],          // 虚拟工作区文件 {id, conversationId, path, content, encoding, updatedAt}
  devices: [],
  registrations: [],  // 设备注册
  paymentOrders: [],
  invoices: [],
  creditLedger: [],
  subscriptions: [],
  tickets: [],
  ticketMessages: [],
  announcements: [],
  auditLogs: [],
  redeemCodes: [],
  promoters: [],
  promoterSettlements: [],
  folders: [],        // 主机目录
  terminalTickets: [],
  terminals: [],
  migrations: [],
  // ---- 线上新版新增的能力（2026-10 抓取的构建）----
  cards: [],                // 卡包 {id, code, userId, teamId, type, validDays, usedAt, voidedAt, expiresAt}
  images: [],               // 生成的图片 {id, teamId, kind, prompt, status, url, svg, size}
  subagents: [],            // 子智能体 {id, scope, hostId|projectId, filename, name, prompt, skills}
  mcpServers: [],           // MCP 服务器 {id, scope, hostId|projectId, name, transport, command|url}
  projectTerminalOrder: [], // 项目终端顺序 {projectId, order:[terminalId]}
  uploadIntents: [],        // 上传预检（prepareConversationUpload）
  counters: { ticket: 1000 },
});

export function db$() {
  if (!db) load();
  return db;
}

/**
 * 加载数据库。**内存是唯一真相源，磁盘只是 write-behind 快照**，
 * 因此默认只在进程启动时真正读盘；已经加载过就直接返回内存实例。
 *
 * 这一点非常关键：save() 是防抖写盘的，如果在每次请求前都 load()，
 * 会把「刚写入内存、尚未落盘」的数据用磁盘旧内容覆盖掉 —— 表现为
 * 同一进程内「刚登录就 401」。需要强制重读磁盘时必须显式传 { force: true }。
 */
export function load({ force = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  if (db && !force) return db;
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // 补齐新增集合，保证向后兼容
      const base = EMPTY();
      for (const k of Object.keys(base)) {
        if (parsed[k] === undefined) parsed[k] = base[k];
      }
      if (!parsed.counters) parsed.counters = base.counters;
      db = parsed;
      return db;
    } catch (e) {
      console.error('[db] 解析失败，重建：', e.message);
      backupBroken();
    }
  }
  db = EMPTY();
  return db;
}

function backupBroken() {
  try {
    if (fs.existsSync(DB_FILE)) {
      fs.renameSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
    }
  } catch { /* ignore */ }
}

export function save({ immediate = false } = {}) {
  dirty = true;
  if (immediate) return flush();
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 150);
  if (timer.unref) timer.unref();
}

export function flush() {
  if (!dirty || !db) return;
  dirty = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

export function reset() {
  db = EMPTY();
  dirty = true;
  flush();
  return db;
}

// ---- 通用小工具 ----

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function rid(len = 12) {
  // ARTEX medium 2026-10-10：Math.random 可预测 → crypto 安全随机
  const bytes = nodeCrypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** 与生产一致的 UUID v4 风格 id */
export function uuid() {
  const b = nodeCrypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function now() {
  return new Date().toISOString();
}

export function find(coll, pred) {
  return db$()[coll].find(pred);
}

export function filter(coll, pred) {
  const arr = db$()[coll];
  return pred ? arr.filter(pred) : arr.slice();
}

export function insert(coll, row) {
  db$()[coll].push(row);
  save();
  return row;
}

export function remove(coll, pred) {
  const arr = db$()[coll];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) arr.splice(i, 1);
  }
  save();
}

export function paginate(rows, { limit = 20, offset = 0 } = {}) {
  const l = Math.max(0, Math.min(200, Number(limit) || 20));
  const o = Math.max(0, Number(offset) || 0);
  return rows.slice(o, o + l);
}

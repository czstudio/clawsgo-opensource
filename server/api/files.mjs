// /api/files —— 二进制进出：下载单个文件、打包目录、上传文件。
//
// 契约（还原自 app/assets/api-pyi_9PXn.js）：
//   下载 _e(cmd, payload)：POST 带 JSON 信封 {data:{...}}，
//       响应必须带 content-disposition，前端把它当 Blob 读。
//   上传 ye(cmd, query, body, onProgress)：POST /api/uploadConversationFile?conversationId=..&dirPath=..&name=..
//       请求体是**原始文件字节**（不是 JSON），响应是 JSON {data:{file}}。
import fs from 'node:fs';
import path from 'node:path';
import { db$, uuid, now, save } from '../lib/db.mjs';
import { workspaceDir, safeJoin, ensureWorkspace, entryType, isTextFile } from '../lib/workspace.mjs';
import { makeZip } from '../lib/zip.mjs';
import { req, notFound, need, badRequest } from '../lib/errors.mjs';

/** 允许下载/上传的相对路径必须落在工作区内且非隐藏控制文件 */
function resolveInWorkspace(conversationId, rel) {
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, rel);
  const normRoot = path.resolve(root);
  if (!path.resolve(abs).startsWith(normRoot)) {
    throw badRequest('路径越界');
  }
  return { root, abs };
}

function ownConversation(conversationId, ctx) {
  const c = db$().conversations.find((x) => x.id === conversationId);
  if (!c) notFound('会话');
  need(c.teamId === ctx.teamId || ctx.user.role === 'super_admin', 'FORBIDDEN', '无权访问该会话', 403);
  return c;
}

/** 中文文件名要按 RFC 5987 编码，同时保留 ASCII 退化形式 */
function disposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const MIME_BY_EXT = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.tex': 'text/x-tex; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/* ------------------------------------------------------------------ */

async function downloadConversationFile(p, ctx) {
  // 支持 token 直链（来自 createFileLink）
  if (p?.token) {
    const rec = db$().files.find((f) => f.id === p.token && f.kind === 'link');
    if (!rec) notFound('链接');
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
      throw badRequest('链接已过期', 'LINK_EXPIRED');
    }
    const { abs } = resolveInWorkspace(rec.conversationId, rec.path);
    if (!fs.existsSync(abs)) notFound('文件');
    const buf = fs.readFileSync(abs);
    return {
      __binary: buf,
      contentType: MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      filename: path.basename(abs),
    };
  }

  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = req(p, 'path');
  const { abs } = resolveInWorkspace(c.id, rel);
  if (!fs.existsSync(abs)) notFound('文件');
  if (entryType(abs) === 'dir') {
    // 前端对目录走 downloadConversationDir；这里给个明确错误
    throw badRequest('目标是目录，请使用 downloadConversationDir', 'IS_DIRECTORY');
  }
  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  return {
    __binary: buf,
    contentType: MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    filename: name,
    disposition: disposition(name),
  };
}

async function downloadConversationDir(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const rel = p?.path ?? '';
  const { root, abs } = resolveInWorkspace(c.id, rel);
  if (!fs.existsSync(abs)) notFound('目录');

  const entries = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      if (n === '.seeded' || n === '.git') continue;
      const a = path.join(dir, n);
      const st = fs.statSync(a);
      if (st.isDirectory()) walk(a);
      else entries.push({ path: path.relative(abs, a).replace(/\\/g, '/'), content: fs.readFileSync(a) });
    }
  };
  walk(abs);

  const buf = makeZip(entries);
  const baseName = path.basename(abs) || path.basename(root);
  return {
    __binary: buf,
    contentType: 'application/zip',
    filename: `${baseName}.zip`,
    disposition: disposition(`${baseName}.zip`),
  };
}

async function uploadConversationFile(p, ctx) {
  const c = ownConversation(req(p, 'conversationId'), ctx);
  const dirPath = p?.dirPath ?? p?.path ?? '';
  const rawName = req(p, 'name');
  // 只取文件名部分，杜绝 ../../ 注入
  const name = path.basename(String(rawName).replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..') throw badRequest('非法文件名');

  const rel = [dirPath, name].filter(Boolean).join('/');
  const { root, abs } = resolveInWorkspace(c.id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const body = ctx.rawBody && ctx.rawBody.length ? ctx.rawBody : Buffer.alloc(0);
  if (!body.length) throw badRequest('上传内容为空');
  fs.writeFileSync(abs, body);

  const st = fs.statSync(abs);
  const file = {
    name,
    filename: name,
    path: path.relative(root, abs).replace(/\\/g, '/'),
    type: 'file',
    size: st.size,
    mimeType: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream',
    mtime: st.mtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
    ext: path.extname(name).replace('.', '').toLowerCase(),
    binary: !isTextFile(name),
  };

  // 记录到 files 集合，便于审计
  db$().files.push({
    id: uuid(),
    conversationId: c.id,
    path: file.path,
    kind: 'upload',
    size: file.size,
    createdAt: now(),
  });
  save();

  return { file, entry: file };
}

export const commands = {
  downloadConversationFile,
  downloadConversationDir,
  uploadConversationFile,
};

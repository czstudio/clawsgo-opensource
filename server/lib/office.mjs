/**
 * server/lib/office.mjs —— 文件直链与 Office 编辑会话
 * ------------------------------------------------------------------
 * 这两件事的**返回形状完全由前端 bundle 决定**，不是我们自己设计的，
 * 所以单独抽出来，保证普通用户路径（chat.mjs）和后台路径（admin.mjs）产出的形状一致。
 *
 * 证据一：app/assets/ModelIcon-ACnHMn8i.js
 *   async function ar(e,t){ let {link:n} = await o(`createFileLink`,{conversationId:e,path:t});
 *                           return `${ee}${n.url}` }        // ← link 包了一层
 *   async function sr(e,t,n){ let {session:r} = await o(`createOfficeSession`,{conversationId:e,path:t,...n});
 *                             return r }
 *
 * 证据二：app/assets/AdminUserDetailDialog-D3FjH6JN.js（后台是同一套）
 *   async function xa(e,t){ let {link:n} = await a(`adminCreateFileLink`,{conversationId:e,path:t});
 *                           return `${s}${n.url}` }
 *   async function Sa(e,t,n){ let {session:r} = await a(`adminCreateOfficeSession`,{conversationId:e,path:t,...n});
 *                             return r }
 *   下载：`${await xa(e,t)}&download=1`   ← url 里必须已经带 `?`，否则 `&download=1` 是死参数
 *
 * 证据三：app/assets/ChatTeamUsage-CqW9fk-p.js（Office 预览组件的真实消费方式）
 *   function Jp(e,t,n){ ... fetchOfficeSession(e,t,n) ... }   // n = { lang, theme }
 *   function bh(...){
 *     let {data:o} = Jp(e,t,{lang:i,theme:a});
 *     <rh session={o} />   key = `${o.config.editorConfig.mode}:${o.config.document.key}:${lang}:${theme}`
 *   }
 *   function rh({session:e}){
 *     let {serverUrl:c, config:l} = e;            // ← 只解构这两个字段
 *     nh(c).then(DocsAPI => new DocsAPI.DocEditor(id, {...l, events:{...}}));
 *   }
 *   → session 必须是 ONLYOFFICE DocumentServer 的 { serverUrl, config } 结构。
 */
import fs from 'node:fs';
import path from 'node:path';

import { db$, now, save, rid } from './db.mjs';
import { ensureWorkspace, safeJoin, entryType } from './workspace.mjs';
import { notFound, badRequest } from './errors.mjs';

/** 直链有效期：与原站一致，24 小时 */
export const FILE_LINK_TTL_MS = 24 * 3600e3;

export const MIME_BY_EXT = {
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

export const mimeOf = (name) => MIME_BY_EXT[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';

/** 中文文件名要按 RFC 5987 编码，同时保留 ASCII 退化形式 */
export function dispositionOf(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 把相对路径解析成工作区内的真实文件路径（目录/越界/不存在都直接报错） */
export function resolveWorkspaceFile(conversationId, rel) {
  const r = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r) throw badRequest('缺少参数 path');
  if (r.split('/').includes('..')) throw badRequest('路径越界');
  const root = ensureWorkspace(conversationId);
  const abs = safeJoin(root, r);
  if (!fs.existsSync(abs)) notFound('文件');
  if (entryType(abs) === 'dir') throw badRequest('目标是目录，请使用 downloadConversationDir', 'IS_DIRECTORY');
  return abs;
}

/** 读成可以直接吐给 HTTP 的二进制响应体 */
export function binaryFor(conversationId, rel) {
  const abs = resolveWorkspaceFile(conversationId, rel);
  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  return {
    __binary: buf,
    contentType: mimeOf(name),
    filename: name,
    disposition: dispositionOf(name),
    size: buf.length,
  };
}

/* ------------------------------------------------------------------ */
/* 文件直链                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成短时下载直链。
 * 返回 `{ link: { url, ... } }` —— 外层的 `link` 是前端硬约定，不能省。
 * url 里带 `?token=`，所以前端拼 `&download=1` 才有意义。
 */
export function createFileLinkRecord(conversationId, rel, { ttlMs = FILE_LINK_TTL_MS, createdBy = null } = {}) {
  const abs = resolveWorkspaceFile(conversationId, rel);
  const token = rid(28);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db$().files.push({
    id: token,
    conversationId,
    path: String(rel).replace(/\\/g, '/').replace(/^\/+/, ''),
    kind: 'link',
    filename: path.basename(abs),
    createdBy,
    createdAt: now(),
    expiresAt,
  });
  save();
  return {
    link: {
      url: `/api/downloadConversationFile?token=${token}`,
      token,
      expiresAt,
      ttlMs,
      path: String(rel),
      filename: path.basename(abs),
      size: fs.statSync(abs).size,
    },
    // 兼容老调用方（早期本地页面直接读顶层 url）
    url: `/api/downloadConversationFile?token=${token}`,
    token,
    expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* Office 编辑会话（ONLYOFFICE DocumentServer 协议）                    */
/* ------------------------------------------------------------------ */

const OFFICE_KIND = {
  docx: 'word', doc: 'word', odt: 'word', rtf: 'word', txt: 'word', md: 'word',
  xlsx: 'cell', xls: 'cell', ods: 'cell', csv: 'cell',
  pptx: 'slide', ppt: 'slide', odp: 'slide',
  pdf: 'pdf',
};

export const officeKindOf = (rel) =>
  OFFICE_KIND[String(rel).toLowerCase().split('.').pop()] ?? 'word';

/** 内容指纹：文件一变 key 就得变，否则 DocumentServer 会命中旧缓存 */
function contentKey(conversationId, rel) {
  const abs = resolveWorkspaceFile(conversationId, rel);
  const st = fs.statSync(abs);
  let h = 5381;
  const seed = `${conversationId}|${rel}|${st.size}|${st.mtimeMs}`;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + st.size.toString(36);
}

/**
 * 构建 Office 编辑会话。
 * @param {string} conversationId
 * @param {string} rel       工作区相对路径
 * @param {object} opts      { lang, theme, mode, editable, user }
 * @param {object} host      { serverUrl, callbackUrl }
 */
export function officeSessionFor(conversationId, rel, opts = {}, host = {}) {
  const abs = resolveWorkspaceFile(conversationId, rel);
  const filename = path.basename(abs);
  const ext = path.extname(filename).replace('.', '').toLowerCase() || 'docx';
  const kind = opts.kind ?? officeKindOf(rel);

  const editable = opts.editable !== false && opts.mode !== 'view';
  const lang = opts.lang === 'en' ? 'en-US' : 'zh-CN';
  const theme = opts.theme === 'dark' ? 'theme-dark' : 'theme-light';

  // 文档本体也走签名直链：DocumentServer 需要能匿名 GET 到它
  const { link } = createFileLinkRecord(conversationId, rel, { createdBy: opts.user?.id ?? null });

  const serverUrl = host.serverUrl ?? process.env.CLAWSGO_ONLYOFFICE_URL ?? '/office-docs';
  const callbackUrl = host.callbackUrl ?? '/api/officeCallback';

  return {
    session: {
      serverUrl,
      kind,
      conversationId,
      path: String(rel),
      filename,
      config: {
        documentType: kind,
        document: {
          key: contentKey(conversationId, rel),
          title: filename,
          url: link.url,
          fileType: ext,
          permissions: {
            edit: editable,
            download: true,
            print: true,
            review: editable,
            comment: editable,
            fillForms: editable,
            copy: true,
          },
        },
        editorConfig: {
          mode: editable ? 'edit' : 'view',
          lang,
          callbackUrl,
          user: {
            id: String(opts.user?.id ?? 'anonymous'),
            name: String(opts.user?.name ?? 'ClawsGO'),
          },
          customization: {
            uiTheme: theme,
            compactHeader: true,
            compactToolbar: true,
            autosave: true,
            forcesave: true,
            hideRightMenu: true,
            toolbarNoTabs: true,
            // 本地复刻没有真实文档服务，隐藏「关于/反馈」等外链按钮，避免点出 404
            hideAbout: true,
            feedback: false,
          },
        },
        width: '100%',
        height: '100%',
      },
    },
    // 兼容老调用方
    sessionId: `${conversationId}:${rel}`,
  };
}

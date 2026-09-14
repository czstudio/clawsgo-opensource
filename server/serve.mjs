/**
 * clawsgo-opensource / server / serve.mjs
 * ------------------------------------------------------------------
 * 本地复刻服务器（零依赖，只用 Node 内置模块）。
 *
 *   :5180  marketing  —— 营销站（Next.js 预渲染产物，静态托管）
 *   :5181  app        —— React SPA 外壳 + 真实后端
 *          /api/*              业务 RPC（204 条命令）
 *          /api/auth/*         认证（含 GET 会话探针）
 *          /api/subscribeEvents             SSE 对话事件通道
 *          /api/watchConversationFiles      SSE 文件变更通道
 *          /api/terminal/ws                 WebSocket 终端通道
 *          /files/*             桌面直连文件网关（前端优先走这条路径）
 *          /__pay/<orderId>     收银台页面（订单 payUrl 指向这里）
 *
 * 启动：
 *   node server/serve.mjs
 *   PORT_SITE=5180 PORT_APP=5181 node server/serve.mjs
 *   CLAWSGO_LLM_BASE_URL=... CLAWSGO_LLM_API_KEY=... CLAWSGO_LLM_MODEL=... node server/serve.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApiRequest, handleFilesGateway, handleTerminalUpgrade, payPageHTML, commandNames } from './api/index.mjs';
import { userFromRequest } from './api/auth.mjs';
import { terminalTickets } from './api/chat.mjs';
import { db$, load, flush } from './lib/db.mjs';
import { seedIfEmpty, DEMO } from './lib/seed.mjs';
import { resetAll } from './lib/reset.mjs';
import { docsApiScript, DOCS_API_PATH } from './lib/office-stub.mjs';
import { llmEnabled } from './lib/agent.mjs';
import { ensureTeamSkills, seedSkillsForTeam } from './api/skills.mjs';
import { hub } from './lib/sse.mjs';
import * as ws from './lib/ws.mjs';
import * as workspace from './lib/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const APP_DIR = path.join(ROOT, 'app');

const PORT_SITE = Number(process.env.PORT_SITE || 5180);
const PORT_APP = Number(process.env.PORT_APP || 5181);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function safeFile(baseDir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const abs = path.resolve(baseDir, clean.replace(/^\/+/, ''));
  if (abs !== path.resolve(baseDir) && !abs.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return abs;
}

function serveFile(res, abs, { spaFallback = null } = {}) {
  if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    if (spaFallback && fs.existsSync(spaFallback)) return serveFile(res, spaFallback);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const ext = path.extname(abs).toLowerCase();
  const immutable = /\.[0-9a-f]{8}\./i.test(path.basename(abs)) || abs.includes('_next');
  const buf = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(buf);
}

/* ==================================================================
 * marketing site :5180
 * ================================================================== */

function startSite() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let p = url.pathname;
    if (p === '/' || p === '') p = '/index.html';

    let abs = safeFile(SITE_DIR, p);
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
    if (!abs || !fs.existsSync(abs)) {
      // /terms → /terms/index.html（Next.js 的 out 目录形态）
      const alt = safeFile(SITE_DIR, p.replace(/\/$/, '') + '/index.html');
      if (alt && fs.existsSync(alt)) abs = alt;
    }
    if (!abs || !fs.existsSync(abs)) {
      const alt2 = safeFile(SITE_DIR, p.replace(/\/$/, '') + '.html');
      if (alt2 && fs.existsSync(alt2)) abs = alt2;
    }
    serveFile(res, abs);
  });
  srv.on('error', (e) => reportPortError(e, PORT_SITE, 'PORT_SITE'));
  srv.listen(PORT_SITE, HOST, () => console.log(`  营销站      http://localhost:${PORT_SITE}`));
  return srv;
}

/* ==================================================================
 * app + api :5181
 * ================================================================== */

function startApp() {
  const srv = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const p = url.pathname;

    try {
      // ---------- 自省端点：列出已注册命令（给 e2e 与文档生成用） ----------
      if (p === '/__commands') {
        const body = Buffer.from(JSON.stringify({ count: commandNames().length, commands: commandNames() }));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      // ---------- 开发/测试：恢复出厂状态（仅非生产环境暴露） ----------
      if (p === '/__reset') {
        if (process.env.NODE_ENV === 'production') {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
        }
        const result = resetAll({ reseedSkills: seedSkillsForTeam, ensureSkills: ensureTeamSkills });
        console.log(`[reset] 已恢复出厂状态：清空 ${result.wiped.join('/')}，播种 ${result.seeded ? '是' : '否'}，团队 ${result.teams} 个`);
        const body = Buffer.from(JSON.stringify(result));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      // ---------- 开发用优雅关停（落盘后退出，方便重启加载新代码） ----------
      if (p === '/__shutdown') {
        const body = Buffer.from(JSON.stringify({ ok: true, pid: process.pid }));
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        setTimeout(() => process.exit(0), 120);
        return;
      }

      // ---------- 收银台页面 ----------
      if (p.startsWith('/__pay/')) {
        const id = p.slice('/__pay/'.length);
        const order = db$().paymentOrders.find((o) => o.id === id);
        if (!order) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<h1>订单不存在</h1>');
        }
        const html = payPageHTML(order);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      // ---------- 本地 ONLYOFFICE DocsAPI 替身 ----------
      // 前端按 `${session.serverUrl}/web-apps/apps/api/documents/api.js` 加载编辑器；
      // 本地没有真 DocumentServer，这里发一个只读预览版替身，保证面板能渲染而不是报错。
      if (p === `/office-docs${DOCS_API_PATH}`) {
        const body = Buffer.from(docsApiScript(), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      // ---------- 桌面直连文件网关 ----------
      if (p.startsWith('/files/')) {
        const user = userFromRequest(req);
        return await handleFilesGateway(req, res, url, { user: user ?? { id: null, role: 'user' }, ctx: null });
      }

      // ---------- API ----------
      if (p.startsWith('/api/')) {
        await handleApiRequest(req, res, url);
        return;
      }

      // ---------- 静态资源 ----------
      if (req.method === 'GET' || req.method === 'HEAD') {
        const abs = safeFile(APP_DIR, p);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) return serveFile(res, abs);

        // SPA 回落只对「看起来像前端路由」的路径生效。
        // 缺一个 /assets/xxx-hash.js 时必须老实返回 404 ——
        // 否则浏览器拿到的是 HTML，报的是 "Unexpected token '<'"，排查成本极高。
        const looksLikeAsset = p.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(p);
        if (looksLikeAsset) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not found');
        }
        return serveFile(res, path.join(APP_DIR, 'index.html'));
      }

      res.writeHead(405, { Allow: 'GET,POST,OPTIONS' }).end('Method Not Allowed');
    } catch (e) {
      console.error('[app] 未捕获错误', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: String(e?.message ?? e) } }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  // ---------- WebSocket 升级：终端 ----------
  srv.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return socket.destroy();
    }
    if (url.pathname === '/api/terminal/ws' || url.pathname === '/terminal/ws') {
      return handleTerminalUpgrade(req, socket, head, { ws, workspace, chat: { terminalTickets } });
    }
    socket.destroy();
  });

  srv.on('error', (e) => reportPortError(e, PORT_APP, 'PORT_APP'));
  srv.listen(PORT_APP, HOST, () => console.log(`  应用 + API  http://localhost:${PORT_APP}`));
  return srv;
}

function reportPortError(e, port, envName) {
  if (e.code === 'EADDRINUSE') {
    console.error(`  端口 ${port} 已被占用 —— 用 ${envName}=<其他端口> 覆盖，或先关掉占用进程`);
  } else {
    console.error(e);
  }
}

/* ==================================================================
 * 启动
 * ================================================================== */

const fresh = seedIfEmpty();
load();
{
  const db = db$();
  for (const t of db.teams) {
    seedSkillsForTeam(t.id, t.ownerId);
    ensureTeamSkills(t.id);
  }
  flush();
}

console.log('\nClawsGO —— 本地复刻环境\n');
startSite();
startApp();

const total = commandNames().length;
console.log('');
console.log(`  · 已注册命令        ${total} 条`);
console.log(`  · 智能体引擎        ${llmEnabled() ? `LLM(${process.env.CLAWSGO_LLM_MODEL})` : '内置演示智能体（真实执行工作区工具）'}`);
console.log(`  · 数据文件          server/data/db.json${fresh ? '（本次已播种演示数据）' : ''}`);
console.log('');
console.log('  登录方式：手机号 138 0000 0000，验证码任意 6 位（默认 ' + DEMO.otp + '），密码 ' + DEMO.password);
console.log('  管理员：  手机号 139 0000 0000（同一个密码），可用于 /admin 后台');
console.log('');

// 退出时落盘
const bye = () => {
  try { flush(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);

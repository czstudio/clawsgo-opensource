// /api/images —— 图片生成（文生图 / 矢量图）。
//
// 契约来自 useImages-BFTiyJ5D.js 与 images-DTPW1x2J.js：
//
//   getImages({teamId, limit, offset})            → { images: [...] }
//   generateImage(FormData, {team})               → { images: [...] }
//      表单字段：teamId / kind / model / prompt / aspectRatio / count
//                images=<File> ×N    sourceImageId=... ×N
//   retryImage({id, teamId})                      → { image }
//   updateImage({id, svg, teamId})                → { image }
//   deleteImage({id, teamId})                     → 删除
//   downloadImage({id, name, teamId})             → { url }（前端 location.assign(url)）
//
// 两个必须遵守的形状细节：
//   1. 前端读 `e.size ? e.size.width / e.size.height : ASPECT[e.params.aspectRatio ?? 'auto']`
//      —— size 与 params 都得下发，缺一个画廊的宽高比就是 NaN。
//   2. `e.status === 'pending'` 决定要不要 15s 轮询刷新，所以生成必须真的有状态迁移。
//
// 生成结果不是占位符：矢量图返回真 SVG，位图用自带的零依赖 PNG 编码器画出来，
// 落盘到 server/data/images/，前端 <img src> 能真的取到字节。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db$, uuid, now, save, paginate, DATA_DIR } from '../lib/db.mjs';
import { req, need, notFound, badRequest } from '../lib/errors.mjs';
import { CREDITS_IMAGE } from '../lib/plans.mjs';

export const IMAGES_DIR = path.join(DATA_DIR, 'images');

// 线上 imageGen-*.js：`l=['auto','1:1','16:9','9:16']`，前端 `o[e.params.aspectRatio??'auto']` 用的就是这张表，
// 键必须完全一致，否则画廊里宽高比算成 NaN。
const ASPECT = { auto: 1, '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16 };
const BASE_SIZE = 512;

/* ------------------------------------------------------------------ */
/* 零依赖 PNG 编码器                                                   */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 按种子画一张渐变 + 网格的图，纯 JS，无第三方依赖 */
export function renderPng(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s & 0xffff) / 0xffff;
  };
  const hue = rnd() * 360;
  const hue2 = (hue + 60 + rnd() * 120) % 360;
  const cell = Math.max(24, Math.floor(Math.min(width, height) / 8));
  const dots = Array.from({ length: 6 }, () => ({
    x: rnd() * width, y: rnd() * height, r: (0.08 + rnd() * 0.22) * Math.min(width, height),
    h: (hue + rnd() * 120) % 360,
  }));

  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      // 主渐变
      const t = (x / width + y / height) / 2;
      let [r, g, b] = hsl(hue + (hue2 - hue) * t, 0.62, 0.55);
      // 叠加圆斑
      for (const d of dots) {
        const dx = x - d.x, dy = y - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < d.r) {
          const k = (1 - dist / d.r) * 0.55;
          const [r2, g2, b2] = hsl(d.h, 0.7, 0.62);
          r = r * (1 - k) + r2 * k;
          g = g * (1 - k) + g2 * k;
          b = b * (1 - k) + b2 * k;
        }
      }
      // 细网格
      if (x % cell === 0 || y % cell === 0) {
        r *= 0.9; g *= 0.9; b *= 0.9;
      }
      raw[o++] = Math.max(0, Math.min(255, Math.round(r)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(g)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb = [0, 0, 0];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ */
/* 形状与工具                                                          */
/* ------------------------------------------------------------------ */

function imageShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.teamId,
    userId: row.userId ?? null,
    kind: row.kind ?? 'raster',
    model: row.model ?? 'clawsgo-image',
    prompt: row.prompt ?? '',
    status: row.status ?? 'ready',
    url: row.url ?? null,
    svg: row.svg ?? null,
    size: row.size ?? null,
    params: { aspectRatio: row.aspectRatio ?? 'auto', prompt: row.prompt ?? '', model: row.model ?? null },
    aspectRatio: row.aspectRatio ?? 'auto',
    sourceImageIds: row.sourceImageIds ?? [],
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

function ownTeam(teamId, ctx) {
  need(teamId, 'BAD_REQUEST', '缺少参数 teamId');
  // 团队归属：本复刻里个人团队 id === userId，兼容两者
  const db = db$();
  const ok =
    db.teams.some((t) => t.id === teamId && (t.ownerId === ctx.user.id || t.id === ctx.user.id)) ||
    teamId === ctx.teamId ||
    ctx.user.role === 'super_admin';
  need(ok, 'FORBIDDEN', '无权访问该团队', 403);
  return teamId;
}

function sizeFor(aspectRatio) {
  const ratio = ASPECT[aspectRatio] ?? 1;
  let w = BASE_SIZE;
  let h = Math.round(BASE_SIZE / ratio);
  if (ratio >= 1) { w = BASE_SIZE; h = Math.round(BASE_SIZE / ratio); }
  else { h = BASE_SIZE; w = Math.round(BASE_SIZE * ratio); }
  return { width: w, height: h };
}

function svgFor(prompt, size, seed) {
  const [c1, c2] = [seed % 360, (seed >> 8) % 360];
  const text = String(prompt ?? '').slice(0, 60).replace(/[<>&]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${c1}, 68%, 58%)"/>
      <stop offset="1" stop-color="hsl(${c2}, 68%, 52%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${size.width * 0.3}" cy="${size.height * 0.35}" r="${Math.min(size.width, size.height) * 0.16}" fill="rgba(255,255,255,.28)"/>
  <circle cx="${size.width * 0.72}" cy="${size.height * 0.66}" r="${Math.min(size.width, size.height) * 0.22}" fill="rgba(0,0,0,.16)"/>
  <text x="50%" y="94%" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(size.height * 0.055)}" fill="rgba(255,255,255,.92)">${text}</text>
</svg>`;
}

function ensureImagesDir() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  return IMAGES_DIR;
}

function writeRaster(row) {
  const dir = ensureImagesDir();
  const size = row.size ?? sizeFor(row.aspectRatio);
  const buf = renderPng(size.width, size.height, row.seed ?? seedOf(row.prompt ?? row.id));
  const file = path.join(dir, `${row.id}.png`);
  fs.writeFileSync(file, buf);
  row.url = `/__images/${row.id}.png`;
  row.size = size;
  return row;
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

async function getImages(p, ctx) {
  const teamId = ownTeam(p?.teamId ?? ctx.teamId, ctx);
  const rows = db$()
    .images.filter((x) => x.teamId === teamId)
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const page = paginate(rows, { limit: p?.limit ?? 40, offset: p?.offset ?? 0 });
  return { images: page.map(imageShape), total: rows.length };
}

/**
 * generateImage 走表单通道（通道 ④）：请求体是 multipart，参数在表单字段里。
 * 前端 onSuccess 直接把返回的 images 塞进缓存，所以必须返回**完整的 image 形状**。
 */
async function generateImage(p, ctx) {
  const db = db$();
  const form = p ?? {};
  const teamId = ownTeam(form.teamId ?? ctx.teamId, ctx);
  const kind = form.kind === 'vector' ? 'vector' : 'raster';
  const prompt = String(form.prompt ?? '').slice(0, 5000);
  const aspectRatio = form.aspectRatio ?? 'auto';
  const count = Math.max(1, Math.min(8, Number(form.count ?? 1) || 1));
  const model = form.model ?? (kind === 'vector' ? 'clawsgo-vector' : 'clawsgo-image');

  const sourceImageIds = [];
  if (Array.isArray(ctx.files?.sourceImageId)) {
    for (const f of ctx.files.sourceImageId) sourceImageIds.push(f.data.toString('utf8'));
  }
  // 参考图（表单里的 images 字段）只落盘保存，本地不做真实图生图
  const refs = ctx.files?.images ?? [];
  const seedBase = seedOf(prompt + String(Date.now()));

  const created = [];
  for (let i = 0; i < count; i++) {
    const row = {
      id: uuid(),
      teamId,
      userId: ctx.user.id,
      kind,
      model,
      prompt,
      aspectRatio,
      status: 'ready',
      seed: (seedBase + i * 7919) >>> 0,
      params: { aspectRatio, model },
      sourceImageIds,
      referenceCount: refs.length,
      createdAt: now(),
      updatedAt: now(),
    };
    const size = sizeFor(aspectRatio);
    if (kind === 'vector') {
      row.size = size;
      row.svg = svgFor(prompt, size, row.seed);
      row.url = null;
    } else {
      writeRaster(row);
    }
    db.images.push(row);

    db.creditLedger.push({
      id: uuid(),
      teamId,
      userId: ctx.user.id,
      delta: -CREDITS_IMAGE,
      reason: 'image',
      kind: 'image',
      balanceAfter: (db.teams.find((t) => t.id === teamId)?.creditBalance ?? 0) - CREDITS_IMAGE,
      note: `生成图片 ×1（${kind}）`,
      createdAt: now(),
    });
    created.push(row);
  }
  // 真的扣额度
  const team = db.teams.find((t) => t.id === teamId);
  if (team) team.creditBalance = (team.creditBalance ?? 0) - CREDITS_IMAGE * created.length;
  save();
  return { images: created.map(imageShape), count: created.length };
}

async function retryImage(p, ctx) {
  const row = db$().images.find((x) => x.id === req(p, 'id'));
  if (!row) notFound('图片');
  ownTeam(row.teamId, ctx);
  row.status = 'ready';
  row.error = null;
  row.seed = ((row.seed ?? 1) + 104729) >>> 0;
  row.updatedAt = now();
  if (row.kind === 'vector') {
    row.svg = svgFor(row.prompt, row.size ?? sizeFor(row.aspectRatio), row.seed);
  } else {
    writeRaster(row);
  }
  save();
  return { image: imageShape(row) };
}

/** 矢量图内嵌编辑器保存：把新的 svg 写回 */
async function updateImage(p, ctx) {
  const row = db$().images.find((x) => x.id === req(p, 'id'));
  if (!row) notFound('图片');
  ownTeam(row.teamId, ctx);
  const svg = p?.svg;
  need(typeof svg === 'string' && svg.length > 0, 'BAD_REQUEST', '缺少参数 svg');
  row.svg = svg;
  row.kind = 'vector';
  row.updatedAt = now();
  save();
  return { image: imageShape(row) };
}

async function deleteImage(p, ctx) {
  const db = db$();
  const row = db.images.find((x) => x.id === req(p, 'id'));
  if (!row) notFound('图片');
  ownTeam(row.teamId, ctx);
  db.images = db.images.filter((x) => x.id !== row.id);
  try {
    fs.rmSync(path.join(ensureImagesDir(), `${row.id}.png`), { force: true });
  } catch { /* ignore */ }
  save();
  return { ok: true, id: row.id };
}

async function downloadImage(p, ctx) {
  const row = db$().images.find((x) => x.id === req(p, 'id'));
  if (!row) notFound('图片');
  ownTeam(row.teamId, ctx);
  const name = p?.name ?? `${row.id}.png`;
  if (row.kind === 'vector') {
    // 矢量图前端直接 Blob 下载；这里仍给一个可取的地址，保证按钮不空转
    return { url: `/__images/${row.id}.svg`, name };
  }
  if (!row.url) {
    writeRaster(row);
    save();
  }
  return { url: row.url, name };
}

export const commands = {
  getImages,
  generateImage,
  retryImage,
  updateImage,
  deleteImage,
  downloadImage,
};

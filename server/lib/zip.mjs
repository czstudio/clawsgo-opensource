// 最小 ZIP 写入器（STORE，不压缩）
// 用途：downloadConversationDir 打包工作区目录，保持零依赖。
// 生成的 ZIP 遵循 PKWARE APPNOTE 6.3.x，可被 Windows 资源管理器 / macOS 归档实用工具 / unzip 正常打开。
import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';

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

/** DOS 时间戳 */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * @param {{path:string, content:Buffer|string}[]} entries
 * @param {{mtime?:Date}} [opts]
 * @returns {Buffer}
 */
export function makeZip(entries, { mtime = new Date() } = {}) {
  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(String(e.path).replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content ?? ''), 'utf8');
    const crc = crc32(data);

    // ---- local file header ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: UTF-8 文件名
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    // ---- central directory record ----
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    // 注意：`0o100644 << 16` 会溢出成有符号负数（0x81A40000 → -2119958528），
    // writeUInt32LE 会直接抛 "value is out of range"。必须 >>> 0 转回无符号。
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (unix 权限位 + 普通文件)
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 最小 ZIP 读取器（STORE / DEFLATE）。
 * 用途：uploadHostSkillArchive 解析用户上传的技能包 zip。
 * @param {Buffer} buf
 * @returns {{path:string, content:Buffer}[]}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('readZip 需要 Buffer');
  // ---- 1. 从尾部倒着找 EOCD (0x06054b50) ----
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（未找到 EOCD）');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // zip64：0xffff 哨兵值 → 从 zip64 EOCD locator 取真值
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const out = [];
  let off = cdOffset;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    let localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (localOff === 0xffffffff) {
      // zip64 extra field (header id 0x0001) 里取真实 local header 偏移
      let e = off + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const sz = buf.readUInt16LE(e + 2);
        if (id === 0x0001 && sz >= 8) { localOff = Number(buf.readBigUInt64LE(e + 4)); break; }
        e += 4 + sz;
      }
    }

    let data = Buffer.alloc(0);
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, Math.min(start + compSize, buf.length));
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`zip 不支持的压缩方式: ${method}`);
    }

    out.push({ path: name, content: data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

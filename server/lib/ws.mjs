// 最小 WebSocket 服务端（RFC 6455），零依赖。
// 用途：/api/terminal/ws?ticket=..&cols=..&rows=.. 上的终端通道。
//
// 支持：握手（Sec-WebSocket-Accept）、文本帧收发、ping/pong、关闭帧、分片消息累积。
// 不支持：扩展协商（permessage-deflate）、二进制帧透传（终端只走 UTF-8 文本）。
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 完成握手；返回 false 表示请求不是合法 WS 升级 */
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || String(version) !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return false;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
  socket.setNoDelay?.(true);
  return true;
}

const OPCODE = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 编码一个文本帧（服务端→客户端，不掩码） */
export function encodeText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | OPCODE.TEXT;
  return Buffer.concat([header, payload]);
}

function encodeClose(code = 1000, reason = '') {
  const r = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  const header = Buffer.alloc(2);
  header[0] = 0x80 | OPCODE.CLOSE;
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

export function encodePong(data = Buffer.alloc(0)) {
  const header = Buffer.alloc(2);
  header[0] = 0x80 | OPCODE.PONG;
  header[1] = data.length;
  return Buffer.concat([header, data]);
}

/**
 * 把 WS 连接包成一个易用对象。
 * @param {import('node:net').Socket} socket
 * @param {{onMessage:(text:string)=>void, onClose?:()=>void}} handlers
 */
export function wrapSocket(socket, { onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  let fragOpcode = null;
  let fragParts = [];
  let closed = false;

  const api = {
    socket,
    get closed() {
      return closed;
    },
    send(text) {
      if (closed) return;
      try {
        socket.write(encodeText(text));
      } catch {
        api.close();
      }
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      try {
        socket.write(encodeClose(code, reason));
        socket.end();
      } catch {
        /* ignore */
      }
      onClose?.();
    },
    ping(data = Buffer.alloc(0)) {
      if (closed) return;
      const header = Buffer.alloc(2);
      header[0] = 0x80 | OPCODE.PING;
      header[1] = data.length;
      try {
        socket.write(Buffer.concat([header, data]));
      } catch {
        /* ignore */
      }
    },
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      handleFrame(frame);
    }
  });

  socket.on('error', () => api.close(1011, 'socket error'));
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });

  function handleFrame(frame) {
    switch (frame.opcode) {
      case OPCODE.PING:
        try {
          socket.write(encodePong(frame.payload));
        } catch { /* ignore */ }
        break;
      case OPCODE.PONG:
        break;
      case OPCODE.CLOSE:
        api.close(1000, '');
        break;
      case OPCODE.TEXT:
      case OPCODE.BIN:
        if (frame.fin) {
          if (fragParts.length) {
            fragParts.push(frame.payload);
            const full = Buffer.concat(fragParts);
            fragParts = [];
            fragOpcode = null;
            onMessage(full.toString('utf8'));
          } else {
            onMessage(frame.payload.toString('utf8'));
          }
        } else {
          fragOpcode = frame.opcode;
          fragParts = [frame.payload];
        }
        break;
      case OPCODE.CONT:
        if (fragOpcode === null) break;
        fragParts.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(fragParts);
          fragParts = [];
          fragOpcode = null;
          onMessage(full.toString('utf8'));
        }
        break;
      default:
        break;
    }
  }

  return api;
}

/** 从缓冲区尝试解出一帧；不足一帧返回 null */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(64 * 1024 * 1024)) return null; // 拒绝超长帧
    len = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { fin, opcode, payload, consumed: offset + len };
}

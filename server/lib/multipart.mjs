// 最小 multipart/form-data 解析器（零依赖）。
// 用途：uploadTicketAttachment 走 FormData，浏览器发的是 multipart 体。
// 只处理本项目实际用到的形态：普通字段 + 文件字段，不做嵌套 multipart。

/**
 * @param {Buffer} body 原始请求体
 * @param {string} contentType 形如 `multipart/form-data; boundary=----WebKitFormBoundaryX`
 * @returns {Record<string, {filename?:string, mimeType?:string, data:Buffer}[]>}
 */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''));
  if (!m) return {};
  const boundary = (m[1] ?? m[2]).trim();
  const delimiter = Buffer.from('--' + boundary);
  const fields = {};

  let pos = body.indexOf(delimiter);
  if (pos < 0) return {};

  while (pos >= 0) {
    let cursor = pos + delimiter.length;
    // 结束标记 `--`
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    // 跳过 CRLF
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) break;
    const rawHeaders = body.subarray(cursor, headerEnd).toString('utf8');
    const partStart = headerEnd + 4;

    const next = body.indexOf(delimiter, partStart);
    const partEnd = next < 0 ? body.length : next - 2; // 去掉尾随 CRLF
    const data = Buffer.from(body.subarray(partStart, Math.max(partStart, partEnd)));

    const nameM = /name="([^"]*)"/i.exec(rawHeaders);
    const fileM = /filename="([^"]*)"/i.exec(rawHeaders);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    const name = nameM?.[1] ?? '';

    if (name) {
      const entry = {
        filename: fileM ? decodeRfc5987(fileM[1]) : undefined,
        mimeType: typeM?.[1]?.trim() ?? 'application/octet-stream',
        data,
      };
      (fields[name] ??= []).push(entry);
    }
    pos = next;
  }
  return fields;
}

function decodeRfc5987(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** 把 fields 里的文本字段转成普通对象（忽略文件） */
export function textFields(fields) {
  const out = {};
  for (const [k, arr] of Object.entries(fields)) {
    for (const v of arr) {
      if (v.filename === undefined) out[k] = v.data.toString('utf8');
    }
  }
  return out;
}

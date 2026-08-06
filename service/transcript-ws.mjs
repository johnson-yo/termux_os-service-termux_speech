/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A Framework-authenticated WebSocket upgrade plus a reader that only answers when something changed.
 * [OUTPUT]: RFC 6455 text frames — transcript observations and Package state deltas.
 * [POS]: Same-origin Browser Session adapter; it forwards text metadata only, never WAV or tensors.
 * [PROTOCOL]: ⛔ 这里**不许**出现固定间隔的轮询。`readFeed` 必须是「等到有变化再回答」，
 *             否则每一个打开的页面都会变成一条 5Hz 的空转回路（docs/056 记过同型问题）。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const frame = (opcode, payload = Buffer.alloc(0)) => {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (value.length < 126) {
    header = Buffer.from([0x80 | opcode, value.length]);
  } else if (value.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(value.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(value.length), 2);
  }
  return Buffer.concat([header, value]);
};

const decodeFrames = (buffer) => {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const wide = buffer.readBigUInt64BE(offset + 2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
      length = Number(wide);
      header = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskBytes = masked ? 4 : 0;
    if (offset + header + maskBytes + length > buffer.length) break;
    const maskOffset = offset + header;
    const payloadOffset = maskOffset + maskBytes;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= buffer[maskOffset + (index % 4)];
      }
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = payloadOffset + length;
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
};

/**
 * 一个最小 WS 桥。
 *
 * @param {object} options
 * @param {(cursor: unknown) => Promise<{frames: unknown[], next: unknown}>} options.pump
 *   等到有东西可发再 resolve。**它自己负责阻塞**，这里绝不加定时器。
 * @param {unknown} options.after 初始游标。
 * @param {object} options.ready 握手后立刻发出去的第一帧。
 */
export function serveWebSocketFeed(req, socket, head, { after = 0, pump, ready } = {}) {
  const key = String(req.headers['sec-websocket-key'] ?? '');
  if (!key || String(req.headers['sec-websocket-version'] ?? '') !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  socket.setNoDelay(true);

  let cursor = after;
  let incoming = Buffer.alloc(0);
  let closed = false;
  const sendJson = (value) => {
    if (!closed && !socket.destroyed) socket.write(frame(0x1, JSON.stringify(value)));
  };
  const sendRaw = (text) => {
    if (!closed && !socket.destroyed) socket.write(frame(0x1, text));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.end();
  };
  const consume = (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    let decoded;
    try { decoded = decodeFrames(incoming); } catch { return close(); }
    incoming = decoded.rest;
    for (const item of decoded.frames) {
      if (!item.fin) return close();
      if (item.opcode === 0x8) {
        if (!socket.destroyed) socket.write(frame(0x8, item.payload.subarray(0, 125)));
        return close();
      }
      if (item.opcode === 0x9 && !socket.destroyed) {
        socket.write(frame(0xA, item.payload.subarray(0, 125)));
      }
    }
  };
  socket.on('data', consume);
  socket.on('close', close);
  socket.on('end', close);
  socket.on('error', close);
  if (head?.length) consume(head);
  if (ready) sendJson(ready);

  /**
   * ⭐ 一个**串行**的循环：上一次没回来之前不会有第二次请求在飞。
   * 慢客户端因此不会让上游堆积——它只是拿到更少、更新的快照。
   */
  const loop = async () => {
    while (!closed) {
      let result;
      try {
        result = await pump(cursor);
      } catch (error) {
        sendJson({ type: 'error', error: String(error?.message ?? error) });
        // 上游出错就退避一下再试，不要变成忙等。
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
        continue;
      }
      if (closed) return;
      for (const item of result?.frames ?? []) {
        if (typeof item === 'string') sendRaw(item); else sendJson(item);
      }
      if (result?.next !== undefined) cursor = result.next;
    }
  };
  void loop();
}

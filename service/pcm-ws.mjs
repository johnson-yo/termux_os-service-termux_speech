/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A short-lived termux-os.app.api descriptor converted to `/api/android/mic/stream`.
 * [OUTPUT]: A reconnecting authenticated binary PCM client plus truthful transport counters.
 * [POS]: Direct App→Termux Speech hot path; credentials and PCM never pass through Framework Core or the browser.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export const MIC_ANCHOR_SCHEMA = 'termux-os.mic-frame-anchor.v1';

export const PCM_STREAM_FORMAT = Object.freeze({
  encoding: 'pcm_s16le',
  sample_rate_hz: 16_000,
  channels: 1,
  frame_ms: 100,
  frame_bytes: 3_200,
});

export const pcmWebSocketDescriptor = (descriptor) => {
  const endpoint = new URL(descriptor.baseUrl);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.pathname = '/api/android/mic/stream';
  endpoint.search = '';
  endpoint.hash = '';
  return {
    endpoint: endpoint.toString(),
    headers: { Authorization: descriptor.authorization },
    provider: 'termux-os.app.api',
  };
};

export class PcmWs {
  constructor({ onFrame = null, onState = null } = {}) {
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    this.onState = typeof onState === 'function' ? onState : null;
    this.endpoint = '';
    this.headers = {};
    this.provider = null;
    this.fingerprint = '';
    this.host = null;
    this.port = null;
    this.path = null;
    this.secure = false;
    this.authority = null;
    this.configError = 'speech PCM endpoint unavailable';
    this.socket = null;
    this.connected = false;
    this.handshakeComplete = false;
    this.buffer = Buffer.alloc(0);
    this.wantOpen = false;
    this.reconnectTimer = null;
    this.lastError = this.configError;
    this.frameSeq = 0;
    this.bytesTotal = 0;
    this.invalidFrames = 0;
    this.lastFrameAtMs = null;
    this.anchor = null;
    this.anchorsReceived = 0;
    this.unknownTextFrames = 0;
    this.framesSinceAnchor = 0;
    this.pendingGap = false;
  }

  configure(next = {}) {
    const fingerprint = JSON.stringify([
      next.endpoint ?? '',
      next.headers ?? {},
      next.provider ?? null,
    ]);
    if (fingerprint === this.fingerprint) return false;
    const wanted = this.wantOpen;
    this.wantOpen = false;
    clearTimeout(this.reconnectTimer);
    try { this.socket?.destroy(); } catch { /* Already closed. */ }
    this.socket = null;
    this.connected = false;
    this.handshakeComplete = false;
    this.buffer = Buffer.alloc(0);
    this.endpoint = next.endpoint ?? '';
    this.headers = next.headers ?? {};
    this.provider = next.provider ?? null;
    this.fingerprint = fingerprint;
    this.configError = null;
    try {
      const parsed = new URL(this.endpoint);
      if (!['ws:', 'wss:'].includes(parsed.protocol)) {
        throw new Error(`unsupported protocol ${parsed.protocol}`);
      }
      this.host = parsed.hostname;
      this.secure = parsed.protocol === 'wss:';
      this.port = Number(parsed.port || (this.secure ? 443 : 80));
      this.path = `${parsed.pathname || '/'}${parsed.search}`;
      this.authority = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch (error) {
      this.configError = `invalid speech PCM endpoint: ${String(error?.message ?? error)}`;
    }
    this.lastError = this.configError;
    this.wantOpen = wanted;
    if (wanted) this.ensure();
    this.emitState();
    return true;
  }

  ensure() {
    this.wantOpen = true;
    if (!this.configError && !this.connected && !this.socket) this.connect();
  }

  close() {
    this.wantOpen = false;
    clearTimeout(this.reconnectTimer);
    try { this.socket?.destroy(); } catch { /* Already closed. */ }
    this.socket = null;
    this.connected = false;
    this.emitState();
  }

  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = this.secure
      ? tls.connect({ port: this.port, host: this.host, servername: this.host })
      : net.connect(this.port, this.host);
    this.socket = socket;
    this.handshakeComplete = false;
    this.buffer = Buffer.alloc(0);
    // 上一条连接的锚对这一条毫无意义（帧计数从头开始），留着它会算出偏了整段的时刻。
    // App 会在新连接的第一帧前重新发锚，在那之前如实没有时间基准。
    this.anchor = null;
    this.framesSinceAnchor = 0;
    this.pendingGap = true;
    const extraHeaders = Object.entries(this.headers)
      .filter(([name, value]) => /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(String(value)))
      .map(([name, value]) => `${name}: ${String(value)}\r\n`)
      .join('');
    socket.on(this.secure ? 'secureConnect' : 'connect', () => socket.write(
      `GET ${this.path} HTTP/1.1\r\nHost: ${this.authority}\r\n`
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
    ));
    socket.on('data', (data) => {
      if (this.socket === socket) this.onData(data);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.lastError = error.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      this.emitState();
      if (!this.wantOpen) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 1000);
    });
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (!this.handshakeComplete) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const head = this.buffer.subarray(0, headerEnd).toString();
      if (!head.includes(' 101 ')) {
        this.lastError = `handshake: ${head.split('\r\n')[0]}`;
        try { this.socket?.destroy(); } catch { /* Already closed. */ }
        return;
      }
      this.handshakeComplete = true;
      this.connected = true;
      this.lastError = null;
      this.buffer = this.buffer.subarray(headerEnd + 4);
      this.emitState();
    }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = second & 0x80 ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) break;
      const mask = this.buffer.subarray(offset, offset + maskLength);
      const payload = Buffer.from(this.buffer.subarray(
        offset + maskLength,
        offset + maskLength + length,
      ));
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      if (maskLength) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      if (opcode === 2) this.handlePcm(payload);
      else if (opcode === 1) this.handleAnchor(payload);
      else if (opcode === 8) {
        try { this.socket?.destroy(); } catch { /* Already closed. */ }
      } else if (opcode === 9) {
        this.writeControl(0xA, payload);
      }
    }
  }

  writeControl(opcode, payload) {
    const body = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const header = body.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | body.length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, body.length >> 8, body.length & 0xff]);
    const masked = Buffer.alloc(body.length);
    for (let index = 0; index < body.length; index += 1) {
      masked[index] = body[index] ^ mask[index % 4];
    }
    try { this.socket?.write(Buffer.concat([header, mask, masked])); } catch { /* Close handler reconnects. */ }
  }

  /**
   * 时间锚（docs/061 §四.4）。App 在连接、丢帧、采集重建时各穿插一帧文本，此后每帧固定
   * +100ms——于是每一帧 PCM 都能换算成 **App 单调时钟**上的时刻，而这正是判断
   * 「这段音频是不是我们自己的 TTS」唯一可用的共同时基。
   *
   * ⚠ 认不出的文本帧只记不猜：把一个读不懂的载荷当成锚，比没有锚更糟。
   */
  handleAnchor(payload) {
    let anchor;
    try { anchor = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (anchor?.schema !== MIC_ANCHOR_SCHEMA) {
      this.unknownTextFrames += 1;
      return;
    }
    this.anchor = {
      frame_seq: Number(anchor.frame_seq) || 0,
      mono_ms: Number(anchor.mono_ms) || 0,
      frame_ms: Number(anchor.frame_ms) || PCM_STREAM_FORMAT.frame_ms,
      capture_generation: Number(anchor.capture_generation) || 0,
      boot_id: typeof anchor.boot_id === 'string' ? anchor.boot_id : null,
      gap: anchor.gap === true,
    };
    this.anchorsReceived += 1;
    this.framesSinceAnchor = 0;
    // 锚自己声明「此前有个洞」时，把这个事实交给下游一次——正在形成的段必须为此作废。
    this.pendingGap = this.anchor.gap;
  }

  handlePcm(frame) {
    if (frame.length === 0 || frame.length % 2 !== 0) {
      this.invalidFrames += 1;
      this.lastError = `invalid PCM frame: ${frame.length} bytes`;
      this.emitState();
      return;
    }
    this.frameSeq += 1;
    this.bytesTotal += frame.length;
    this.lastFrameAtMs = Date.now();
    const anchor = this.anchor;
    const monoMs = anchor
      ? anchor.mono_ms + this.framesSinceAnchor * anchor.frame_ms
      : null;
    const appFrameSeq = anchor ? anchor.frame_seq + this.framesSinceAnchor : null;
    const gap = this.pendingGap;
    this.pendingGap = false;
    this.framesSinceAnchor += 1;
    if (this.onFrame) this.onFrame(frame, {
      frame_seq: this.frameSeq,
      bytes_total: this.bytesTotal,
      observed_at_ms: this.lastFrameAtMs,
      // 以下四项只有在 App 发过锚之后才有值；没有锚时如实为 null 而不是编一个。
      mono_ms: monoMs,
      app_frame_seq: appFrameSeq,
      capture_generation: anchor?.capture_generation ?? null,
      boot_id: anchor?.boot_id ?? null,
      gap,
    });
  }

  snapshot(nowMs = Date.now()) {
    return {
      schema: 'termux-os.pcm-stream.v1',
      connected: this.connected,
      provider: this.provider,
      endpoint: this.endpoint ? '/api/android/mic/stream' : null,
      ...PCM_STREAM_FORMAT,
      frame_seq: this.frameSeq,
      bytes_total: this.bytesTotal,
      invalid_frames: this.invalidFrames,
      last_frame_age_ms: this.lastFrameAtMs === null ? null : Math.max(0, nowMs - this.lastFrameAtMs),
      anchor: this.anchor ? { ...this.anchor } : null,
      anchors_received: this.anchorsReceived,
      unknown_text_frames: this.unknownTextFrames,
      frames_since_anchor: this.framesSinceAnchor,
      last_error: this.lastError,
    };
  }

  emitState() {
    if (this.onState) this.onState(this.snapshot());
  }
}

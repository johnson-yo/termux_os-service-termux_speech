/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A short-lived App descriptor converted to a WebSocket endpoint plus termux-os.pinyin-stream.v1 text frames.
 * [OUTPUT]: Reconnecting capture and incremental profile-detection operations with frame observation.
 * [POS]: Credential-safe hot-feed client migrated from Wake Words 0.5.0; it receives pinyin text, never PCM.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { scorePinyin } from './pinyin-scorer.mjs';

export const PINYIN_STREAM_FORMAT = 'termux-os.pinyin-stream.v1';

export class PinyinWs {
  constructor({ endpoint = '', headers = {}, provider = null, onFrame = null } = {}) {
    this.endpoint = '';
    this.headers = {};
    this.provider = null;
    this.fingerprint = null;
    this.host = null;
    this.port = null;
    this.path = null;
    this.secure = false;
    this.authority = null;
    this.configError = null;
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.lastError = null;
    this.reconnectTimer = null;
    this.wantOpen = false;
    this.currentSegment = null;
    this.capture = null;
    this.detect = null;
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    this.applyConfig({ endpoint, headers, provider });
  }

  applyConfig({ endpoint = '', headers = {}, provider = null }) {
    this.endpoint = endpoint;
    this.headers = headers;
    this.provider = provider;
    this.host = null;
    this.port = null;
    this.path = null;
    this.secure = false;
    this.authority = null;
    this.configError = null;
    if (!endpoint) {
      this.configError = 'speech.pinyin endpoint unavailable';
    } else {
      try {
        const parsed = new URL(endpoint);
        if (!['ws:', 'wss:'].includes(parsed.protocol)) {
          throw new Error(`unsupported protocol ${parsed.protocol}`);
        }
        this.host = parsed.hostname;
        this.secure = parsed.protocol === 'wss:';
        this.port = Number(parsed.port || (this.secure ? 443 : 80));
        this.path = `${parsed.pathname || '/'}${parsed.search}`;
        this.authority = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      } catch (error) {
        this.configError = `invalid speech.pinyin endpoint: ${String(error?.message ?? error)}`;
      }
    }
    this.lastError = this.configError;
    this.fingerprint = JSON.stringify([endpoint, headers, provider]);
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
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.applyConfig(next);
    this.wantOpen = wanted;
    if (wanted) this.ensure();
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
  }

  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = this.secure
      ? tls.connect({ port: this.port, host: this.host, servername: this.host })
      : net.connect(this.port, this.host);
    this.socket = socket;
    this.handshakeComplete = false;
    this.buffer = Buffer.alloc(0);
    const extraHeaders = Object.entries(this.headers ?? {})
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
      const payload = this.buffer.subarray(
        offset + maskLength,
        offset + maskLength + length,
      );
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      if (opcode === 1) {
        try { this.handleFrame(JSON.parse(payload.toString('utf8'))); } catch { /* Ignore malformed provider frame. */ }
      } else if (opcode === 8) {
        try { this.socket?.destroy(); } catch { /* Already closed. */ }
      }
    }
  }

  handleFrame(frame) {
    if (frame.event === 'start') {
      this.currentSegment = { seg: frame.seg, tokens: [], text: '' };
      if (this.capture?.armed) this.capture.heard = true;
      if (this.detect) {
        this.detect.speaking = true;
        this.detect.hitThisSegment = false;
        this.detect.score = 0;
        this.detect.scores = {};
        this.detect.pendingHit = null;
      }
    } else if (frame.event === 'token' && this.currentSegment) {
      this.currentSegment.tokens.push(frame.tok);
      this.currentSegment.text += frame.tok;
      if (this.detect) {
        let best = null;
        for (const profile of this.detect.profiles) {
          const score = scorePinyin(profile.templates, this.currentSegment.tokens, {
            initialWeight: profile.initialWeight,
          });
          this.detect.scores[profile.profileId] = score.score;
          if (!best || score.score > best.score) best = { ...profile, ...score };
        }
        this.detect.score = best?.score ?? 0;
        this.detect.decodedText = this.currentSegment.text;
        if (best && best.score >= best.threshold && !this.detect.hitThisSegment) {
          this.detect.hitThisSegment = true;
          this.detect.count += 1;
          this.detect.lastHit = {
            profile_id: best.profileId,
            display_name: best.displayName,
            score: best.score,
            text: this.currentSegment.text,
            segment: this.currentSegment.seg,
          };
          this.detect.pendingHit = this.detect.lastHit;
        }
      }
    } else if (frame.event === 'final' && this.currentSegment) {
      const segment = this.currentSegment;
      this.currentSegment = null;
      if (this.capture?.armed) {
        this.capture.armed = false;
        this.capture.result = {
          tokens: segment.tokens,
          text: segment.text,
          duration_ms: Number(frame.dur_ms) || null,
        };
      }
      if (this.detect) {
        this.detect.speaking = false;
        const hit = this.detect.pendingHit;
        this.detect.pendingHit = null;
        if (hit && typeof this.detect.onHit === 'function') {
          Promise.resolve(this.detect.onHit({ ...hit })).catch((error) => {
            this.lastError = `wake hit callback: ${String(error?.message ?? error)}`;
          });
        }
      }
    }
    if (this.onFrame) {
      try {
        this.onFrame(frame, {
          segment: this.currentSegment ? { ...this.currentSegment } : null,
          detect: this.detectStatus(),
        });
      } catch (error) {
        this.lastError = `frame observer: ${String(error?.message ?? error)}`;
      }
    }
  }

  armCapture() {
    this.ensure();
    this.detect = null;
    this.capture = { armed: true, heard: false, result: null };
  }

  cancelCapture() {
    this.capture = null;
  }

  pollCapture() {
    const capture = this.capture;
    if (capture?.result) return { finalized: true, ...capture.result };
    return {
      finalized: false,
      heard: Boolean(capture?.heard),
      connected: this.connected,
    };
  }

  startDetect(templates, threshold, initialWeight = 2) {
    this.startDetectMany([{
      profileId: 'manual',
      displayName: 'manual',
      templates,
      threshold,
      initialWeight,
    }], { mode: 'manual' });
  }

  startDetectMany(profiles, { mode = 'production', onHit = null } = {}) {
    this.ensure();
    this.capture = null;
    this.detect = {
      profiles,
      mode,
      onHit,
      score: 0,
      scores: {},
      count: 0,
      speaking: false,
      lastHit: null,
      pendingHit: null,
      decodedText: '',
      hitThisSegment: false,
    };
  }

  detectStatus() {
    const detect = this.detect;
    return {
      running: Boolean(detect),
      mode: detect?.mode ?? null,
      profiles: detect?.profiles?.length ?? 0,
      threshold: detect?.profiles?.length === 1 ? detect.profiles[0].threshold : null,
      score: detect?.score ?? 0,
      scores: detect?.scores ?? {},
      count: detect?.count ?? 0,
      speaking: detect?.speaking ?? false,
      feed_connected: this.connected,
      last_hit: detect?.lastHit ?? null,
      decoded_text: detect?.decodedText ?? '',
      last_error: this.lastError,
    };
  }

  captureActive() {
    return this.capture?.armed === true || this.capture?.result != null;
  }

  stopDetect() {
    const status = this.detectStatus();
    this.detect = null;
    return { ...status, running: false };
  }
}

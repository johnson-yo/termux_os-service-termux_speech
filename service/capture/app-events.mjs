/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App 的 `/ws/android/events` 推送帧（schema/boot_id/seq/mono_ms + 全域快照）
 * [OUTPUT]: 当前采集事实、TTS 播放区间、连接状态；以及一条低频有界退避的 freshness watchdog
 * [POS]: docs/061 §三.5。**事件为主、watchdog 为保险**——不是把 watchdog 变成轮询主流程。
 *        速率取决于事实变化几次，而不是取决于页面开了多久（docs/056）。
 * [PROTOCOL]: boot_id 变了整份状态作废（App 重生，旧事实与旧单调时刻都没有意义）；
 *             同一 boot_id 内 seq 不前进的帧一律丢弃，故重复推送天然幂等。
 *             断线**不清空**已知事实，只把它标记为陈旧——「不知道」与「没在播」不是同一件事。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import { TtsIntervals } from './tts-intervals.mjs';

const BACKOFF_MS = Object.freeze([2000, 5000, 10_000, 30_000]);
const RECONNECT_MS = Object.freeze([500, 1000, 2000, 5000]);

export class AppEventsClient {
  constructor({
    onChange = () => {},
    now = () => Date.now(),
    WebSocketImpl = globalThis.WebSocket,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.onChange = onChange;
    this.now = now;
    this.WebSocketImpl = WebSocketImpl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervals = new TtsIntervals();
    this.endpoint = null;
    this.socket = null;
    this.connected = false;
    this.wantOpen = false;
    this.bootId = null;
    this.lastSeq = 0;
    this.capture = null;
    this.lastFrameAtMs = null;
    this.lastEvent = null;
    this.lastError = 'not_started';
    this.framesReceived = 0;
    this.framesDiscarded = 0;
    this.generationChanges = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  /** 描述符来自 termux-os.app.api，凭证不落盘也不进日志。 */
  configure(descriptor) {
    const token = String(descriptor?.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!descriptor?.baseUrl || !token) {
      this.endpoint = null;
      this.lastError = 'termux-os.app.api descriptor unavailable';
      return null;
    }
    const url = new URL('/ws/android/events', descriptor.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // ⚠ token 走 query 是 App 明确为 WS 升级开的口子（浏览器的 WebSocket API 设不了请求头）。
    // 仅限 loopback 的这一条 WS；普通 HTTP 一律不接受 `?token=`。
    url.searchParams.set('token', token);
    const next = url.toString();
    if (next !== this.endpoint) {
      this.endpoint = next;
      if (this.wantOpen) this.reconnect(0);
    }
    return this.endpoint;
  }

  start() {
    this.wantOpen = true;
    this.ensure();
  }

  ensure() {
    if (!this.wantOpen || !this.endpoint || this.socket) return;
    if (typeof this.WebSocketImpl !== 'function') {
      this.lastError = 'WebSocket unavailable in this runtime';
      return;
    }
    let socket;
    try {
      socket = new this.WebSocketImpl(this.endpoint);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.reconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.onChange();
    };
    socket.onmessage = (message) => this.ingest(message?.data);
    socket.onerror = (event) => {
      this.lastError = String(event?.message ?? 'app events websocket error');
    };
    socket.onclose = () => {
      this.connected = false;
      this.socket = null;
      // 断线不清空 capture/intervals：它们变成**陈旧**，而不是变成「一切正常」。
      this.onChange();
      this.reconnect();
    };
  }

  reconnect(delayMs = null) {
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    if (!this.wantOpen) return;
    const wait = delayMs ?? RECONNECT_MS[Math.min(this.reconnectAttempt, RECONNECT_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.ensure();
    }, wait);
  }

  /** 帧解析与去重。分开写是为了让单测能直接喂帧，不必起 WebSocket。 */
  ingest(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { this.framesDiscarded += 1; return null; }
    const bootId = typeof frame?.boot_id === 'string' ? frame.boot_id : null;
    const seq = Number(frame?.seq) || 0;
    if (!bootId) { this.framesDiscarded += 1; return null; }
    if (bootId !== this.bootId) {
      // App 重生：旧 seq 与旧单调时刻一律作废，不是「乱序」而是「另一个世界的编号」。
      this.bootId = bootId;
      this.lastSeq = 0;
      this.generationChanges += 1;
      this.intervals.reset(bootId);
    } else if (seq <= this.lastSeq) {
      this.framesDiscarded += 1;
      return null;
    }
    this.lastSeq = seq;
    this.framesReceived += 1;
    this.lastFrameAtMs = this.now();
    this.lastEvent = typeof frame?.event === 'string' ? frame.event : null;
    const data = frame?.data ?? {};
    if (data.capture && typeof data.capture === 'object') this.capture = data.capture;
    this.intervals.ingest(data.playing, bootId);
    this.onChange();
    return frame;
  }

  /** watchdog 用：读 `/api/android/mic/status` 得到的那份 capture 快照同样喂进来。 */
  observeSnapshot(capture, bootId = null) {
    if (!capture || typeof capture !== 'object') return;
    if (bootId && bootId !== this.bootId) {
      this.bootId = bootId;
      this.lastSeq = 0;
      this.generationChanges += 1;
      this.intervals.reset(bootId);
    }
    this.capture = capture;
    this.lastFrameAtMs = this.now();
    this.onChange();
  }

  captureState() {
    return typeof this.capture?.state === 'string' ? this.capture.state : 'unknown';
  }

  captureGeneration() {
    return Number(this.capture?.capture_generation) || 0;
  }

  validPcm() {
    return this.capture?.valid_pcm_emitting === true;
  }

  snapshot(nowMs = this.now()) {
    return {
      schema: 'termux-os.speech-capture-observer.v1',
      connected: this.connected,
      transport: 'app_events_ws',
      boot_id: this.bootId,
      last_seq: this.lastSeq,
      frames_received: this.framesReceived,
      frames_discarded: this.framesDiscarded,
      generation_changes: this.generationChanges,
      last_event: this.lastEvent,
      last_frame_age_ms: this.lastFrameAtMs === null ? null : Math.max(0, nowMs - this.lastFrameAtMs),
      // 断线后这份 capture 仍是我们最后知道的事实，但它已经**陈旧**。
      stale: !this.connected,
      capture: this.capture,
      tts: this.intervals.snapshot(),
      last_error: this.lastError,
    };
  }

  close() {
    this.wantOpen = false;
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.socket?.close(); } catch { /* Already closed. */ }
    this.socket = null;
    this.connected = false;
  }
}

/**
 * 低频有界退避的兜底。**只在「按需求本该有 PCM，却长时间没有有效帧」时**才去读一次快照，
 * 状态一恢复立刻停。它不是主路径——主路径是事件。
 */
export class CaptureWatchdog {
  constructor({ readSnapshot, now = () => Date.now(), staleAfterMs = 3000 }) {
    this.readSnapshot = readSnapshot;
    this.now = now;
    this.staleAfterMs = staleAfterMs;
    this.step = 0;
    this.nextProbeAtMs = 0;
    this.probes = 0;
    this.lastProbeAtMs = null;
    this.lastResult = null;
    this.inFlight = false;
  }

  reset() {
    this.step = 0;
    this.nextProbeAtMs = 0;
  }

  /**
   * @param expected  按当前需求，此刻本来应该有有效 PCM 吗
   * @param lastFrameAgeMs  本地看到的最后一帧有多久以前（本地事实，不必过 HTTP）
   */
  async poll({ expected, lastFrameAgeMs }, nowMs = this.now()) {
    if (!expected || (lastFrameAgeMs !== null && lastFrameAgeMs < this.staleAfterMs)) {
      // 恢复了就立刻停止退避查询——否则一次抖动会留下一条永远慢下去的探测节奏。
      this.reset();
      return null;
    }
    if (this.inFlight || nowMs < this.nextProbeAtMs) return null;
    this.inFlight = true;
    this.probes += 1;
    this.lastProbeAtMs = nowMs;
    const waitMs = BACKOFF_MS[Math.min(this.step, BACKOFF_MS.length - 1)];
    this.step += 1;
    this.nextProbeAtMs = nowMs + waitMs;
    try {
      this.lastResult = await this.readSnapshot();
      return this.lastResult;
    } catch (error) {
      this.lastResult = { error: String(error?.message ?? error) };
      return this.lastResult;
    } finally {
      this.inFlight = false;
    }
  }

  snapshot() {
    return {
      backoff_ms: BACKOFF_MS,
      step: this.step,
      probes: this.probes,
      last_probe_at_ms: this.lastProbeAtMs,
      next_probe_at_ms: this.nextProbeAtMs || null,
    };
  }
}

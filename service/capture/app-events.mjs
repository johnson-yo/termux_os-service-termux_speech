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
    /**
     * 拍手开门的回调。⭐ 判据是**计数递增**而不是布尔：
     * 布尔无法区分「新的一次」与「同一次的重复推送」，而事件总线本就允许重复。
     */
    this.onGateOpen = () => {};
    /**
     * 每收到一次 gate 事实就调用（⛔ 不只在开门时）。
     * ⚠ 模式必须**每一帧都跟随**：只在开门时同步的话，切到拍掌之后
     *   在第一次拍掌之前，音量那条路仍然开着。
     */
    this.onGateFacts = () => {};
    /**
     * App 内说话人活动执行体的低频事实（docs/087 P3）。
     * ⛔ 与 gate 同一形状：**载荷带着递增计数**，消费方据此做 exactly-once。
     */
    this.onActivity = () => {};
    this.activity = null;
    /**
     * App 侧 policy 的**生效**事实。⭐ 本包据此调自己的 `UserWatchdog` 长度——
     * ⛔ 不轮询、⛔ 不各存一份（各存一份的症状是「界面上倒计时变了，门却按旧的关」）。
     */
    this.onPolicy = () => {};
    this.policy = null;
    /** App 的 segment 结果事实（docs/088 P4）。⛔ 只转发，判断在消费方。 */
    this.onSegment = () => {};
    /**
     * Speech2 的 transcript 紧凑事实（SPEECH17）。⭐ 只作唤醒：权威在
     * `/api/speech2/transcripts?after_seq=`，因为这条总线队列满丢最旧、⛔ 不保证送达。
     */
    this.onTranscript = () => {};
    this.transcriptFrames = 0;
    this.transcript = null;
    this.segment = null;
    this.gateOpens = null;
    this.gate = null;
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
    if (data.gate && typeof data.gate === 'object') this.observeGate(data.gate);
    if (data.activity && typeof data.activity === 'object') this.observeActivity(data.activity, bootId);
    if (data.policy && typeof data.policy === 'object') this.observePolicy(data.policy);
    if (data.segment && typeof data.segment === 'object') this.observeSegment(data.segment, bootId);
    /**
     * ⭐ App 把 `transcript` 放在**帧的顶层**（与 `data` 并列，AppEvents.frame()），⛔ 不在 `data` 里。
     * ⚠ WEBUI18 真机抓到：只读 `data.transcript` ⇒ 事件唤醒**从 SPEECH17 起一次都没发生过**，
     *   transcript 全靠 10 s 兜底同步送达——而兜底链的泄漏（start() 叠加）恰好把延迟掩盖了。
     */
    const transcript = (frame?.transcript && typeof frame.transcript === 'object') ? frame.transcript
      : (data.transcript && typeof data.transcript === 'object') ? data.transcript : null;
    if (transcript) {
      this.transcript = transcript;
      this.transcriptFrames += 1;
      try { this.onTranscript(transcript, bootId); } catch { /* 观测不得影响事件流 */ }
    }
    this.intervals.ingest(data.playing, bootId);
    this.onChange();
    return frame;
  }

  /**
   * App 的 Gate 事实。
   *
   * ⭐ **P2：volume 与 feature 对本包完全等价。** 两种模式都由 App 判定，
   *   本包只消费「开了第几次」。⚠ P1 时这里还有一句 `mode !== 'feature' → return`——
   *   那时 volume 仍由本包的 RmsGate 判，不挡住就会同一扇门被开两次。
   *   P2 把 admission 整个收回 App 之后那句必须删：留着的话
   *   **volume 模式下门永远不会开**，而两边看起来都正常。
   *   `mode` 从此只是 metadata，⛔ 不参与判断。
   * ⚠ 计数**倒退**说明 App 重生过（计数器归零），此时只重新对齐基线，⛔ 不当成一次开门。
   */
  observeGate(gate) {
    this.gate = gate;
    try { this.onGateFacts(gate); } catch { /* 观测不得影响事件流 */ }
    const opens = Number(gate.opens);
    if (!Number.isFinite(opens)) return;
    const previous = this.gateOpens;
    this.gateOpens = opens;
    if (previous === null || opens <= previous) return;
    if (gate.testing === true) return;      // 测试模式只打分，⛔ 不驱动任何下游
    try { this.onGateOpen(gate); } catch { /* 观测不得影响事件流 */ }
  }

  /** App 的 segment 结果事实。⛔ 只转发，exactly-once 在消费方（它才知道自己消费到哪）。 */
  observeSegment(segment, bootId = null) {
    this.segment = segment;
    try { this.onSegment(segment, bootId ?? this.bootId); } catch { /* 观测不得影响事件流 */ }
  }

  /** App 的 policy 事实。⛔ 只转发，判断在调用方。 */
  observePolicy(policy) {
    this.policy = policy;
    try { this.onPolicy(policy); } catch { /* 观测不得影响事件流 */ }
  }

  /**
   * App 执行体的活动事实。⛔ 这里**只转发**——exactly-once 与回填的判据在
   * `speaker/app-activity.mjs` 里，因为那是它自己的状态；观测层不许持有产品判据。
   */
  observeActivity(activity, bootId = null) {
    this.activity = activity;
    try { this.onActivity(activity, bootId ?? this.bootId); } catch { /* 观测不得影响事件流 */ }
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

  /**
   * ⭐ **麦克风此刻还在录吗** —— 由持有它的 App 回答。
   *
   * ⚠ 这与本包那条 RMS 观测流的新鲜度是两件事。P2 把 admission 搬进 App 之后，
   *   观测流可以整条不在而麦克风好好的；拿观测流当麦克风的生死判据，
   *   会让 `openFromRequest` 的安全兜底每次都静默拒绝开门。
   * @returns `true`/`false` = App 明确的事实；`null` = 不知道（没连上、
   *   事实已陈旧、或 App 压根没报这个字段），此时调用方该退回自己的观测。
   */
  captureLive() {
    if (!this.connected) return null;                 // 断线 ⇒ 手里的事实已陈旧
    const capture = this.capture;
    if (!capture || typeof capture !== 'object') return null;
    if (typeof capture.recording === 'boolean') return capture.recording;
    const state = this.captureState();
    if (state === 'unknown') return null;
    return state === 'active';
  }

  snapshot(nowMs = this.now()) {
    return {
      schema: 'termux-os.speech-capture-observer.v1',
      connected: this.connected,
      transport: 'app_events_ws',
      boot_id: this.bootId,
      last_seq: this.lastSeq,
      frames_received: this.framesReceived,
      transcript_frames: this.transcriptFrames,
      frames_discarded: this.framesDiscarded,
      generation_changes: this.generationChanges,
      last_event: this.lastEvent,
      last_frame_age_ms: this.lastFrameAtMs === null ? null : Math.max(0, nowMs - this.lastFrameAtMs),
      // 断线后这份 capture 仍是我们最后知道的事实，但它已经**陈旧**。
      stale: !this.connected,
      capture: this.capture,
      /**
       * App 的 Gate 事实。⭐ 让它可见，否则「拍掌为什么没开门」只能靠猜——
       * 是没收到事件、还是收到了但 App 处在 volume 模式、还是模板没就绪，
       * 这三件事在没有这份快照时长得一模一样。
       */
      gate: this.gate,
      gate_opens_seen: this.gateOpens,
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

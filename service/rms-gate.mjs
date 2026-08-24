/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Normalized RMS/PCM liveness plus the current Pipeline owner's accepted speech.idle command.
 * [OUTPUT]: A deterministic RMS-open/Pipeline-idle admission latch with rolling live statistics.
 * [POS]: Front door; RMS opens, the last downstream owner closes, and PCM loss is a safety override.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const clampRms = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
};

const average = (samples) => samples.length
  ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length
  : null;

const DECISION_WINDOW_MS = 100;

export class RmsGate {
  constructor(config) {
    this.config = { ...config };
    this.samples = [];
    this.current = null;
    this.recording = false;
    this.available = false;
    this.state = 'closed';
    this.openArmed = true;
    this.transitionSeq = 0;
    this.openedAtMs = null;
    this.closedAtMs = null;
    this.lastTransition = null;
    this.lastFrameSeq = 0;
    this.lastObservedAtMs = null;
    this.upstreamSampleAgeMs = null;
    /**
     * P2：**谁是这扇门的执行者**。
     *
     * ⭐ `app`（默认，也是正式路径）= 开门判断**全部**在 App：
     *   volume 与 feature 两种模式都由 App 的 GateController 判定，
     *   本包只消费它发出的低频 `gate.open` 事实。
     * ⭐ `legacy_speech` = 开发态回退：本包按 RMS 阈值自己判。
     *
     * ⚠ 它是**二选一**，不是「两条都留着看谁先到」。
     *   加而不换的后果在 P1 之前已经真实发生过：切成拍掌之后音量照样开门，
     *   使用者看到的是「切了没用」，而两条路各自都在正常工作。
     * ⛔ 只影响**开门**：可用性安全兜底、关门、采样与统计一律不变——
     *   **RMS observation ≠ RMS admission**。
     */
    this.gateExecutor = 'app';
    /**
     * ⭐ P2 修正：**麦克风还活着吗，由持有它的那一侧回答。**
     *
     * `available` 的语义一直是「本包这条 RMS 观测流够不够新」，在 P1 之前它恰好
     * 也等于「麦克风活着」——因为那时本包自己判开门，观测流断了本来就不该开。
     * P2 把 admission 整个搬进 App 之后这两件事分家了：App 持着麦克风、
     * 每帧都在算 RMS、门开了 92 次，而本包这条**可有可无的观测流**只要慢过
     * 1000 ms，`available` 就是 false。
     *
     * ⛔ 于是那句「PCM 不可用时不开门」的安全兜底**每一次都静默拒绝开门**：
     *   App 报 `recording=true frame_seq=55463`，本包同时报 `recording=false`，
     *   两边对同一件事给出相反的答案，而错的是没有麦克风的那一边。
     *   症状是「拍了没反应」——门开了、事件到了、计数涨了，就是不动。
     *
     * ⚠ 兜底本身没错，错的是**判据**：它问的是「我看得见吗」，
     *   该问的是「它还在录吗」。`null` = 还不知道，此时退回 `available`。
     */
    this.captureLive = null;
  }

  /**
   * App 的采集事实（来自 AppEvents 的 `capture`）。
   * @param live `true`/`false` = App 明确说在录/没在录；`null` = 事实不可信
   *   （事件流断了或已陈旧），退回本包自己的观测。
   */
  setCaptureLive(live) {
    this.captureLive = typeof live === 'boolean' ? live : null;
  }

  /**
   * 这扇门此刻该不该认为「音频还在」。
   * ⭐ 执行者是谁，就听谁的：`app` 模式下 App 是唯一持麦者。
   */
  pcmLive() {
    if (this.gateExecutor === 'app' && this.captureLive !== null) return this.captureLive;
    return this.available;
  }

  /** @param who 'app' | 'legacy_speech'（后者仅供开发态回退，⛔ 不给普通设置） */
  setGateExecutor(who) {
    const next = who === 'legacy_speech' ? 'legacy_speech' : 'app';
    if (next === this.gateExecutor) return false;
    this.gateExecutor = next;
    // 换执行者时重新 arm：否则回退到 legacy 时门可能停在「已解除武装」。
    this.openArmed = true;
    return true;
  }

  configure(config) {
    this.config = { ...config };
  }

  transition(next, nowMs, { owner, reason }) {
    if (this.state === next) return;
    this.state = next;
    this.transitionSeq += 1;
    if (next === 'open') this.openedAtMs = nowMs;
    else this.closedAtMs = nowMs;
    this.lastTransition = {
      state: next,
      owner,
      reason,
      at_ms: nowMs,
    };
  }

  closeFromDownstream(owner, reason, nowMs = Date.now()) {
    if (!['speech.vad', 'speech.asr'].includes(owner)) {
      throw new Error(`unsupported RMS Gate close owner: ${owner}`);
    }
    if (this.state === 'open') {
      this.openArmed = false;
      this.transition('closed', nowMs, { owner, reason });
    }
    return this.snapshot(nowMs);
  }

  /** Explicit listen requests may open an available gate immediately. */
  openFromRequest(reason = 'explicit_listen', nowMs = Date.now()) {
    // PCM 不可用时不开门：那是安全兜底，不是策略。
    // ⚠ 判据是 `pcmLive()` 而**不是** `this.available`——见构造器里那段。
    if (!this.pcmLive()) return this.snapshot(nowMs);
    this.openArmed = false;
    this.transition('open', nowMs, { owner: 'speech.vad', reason });
    return this.snapshot(nowMs);
  }

  ingest({ rms, recording, frameSeq, sampleAgeMs }, nowMs = Date.now()) {
    const current = clampRms(rms);
    const age = Number(sampleAgeMs);
    this.current = current;
    this.recording = recording === true;
    this.lastObservedAtMs = nowMs;
    this.upstreamSampleAgeMs = Number.isFinite(age) && age >= 0 ? age : 0;
    this.available = this.recording && current !== null && this.upstreamSampleAgeMs <= 1000;

    const sequence = Math.max(0, Number(frameSeq) || 0);
    if (this.available && (sequence === 0 || sequence !== this.lastFrameSeq)) {
      this.samples.push({ at: nowMs, value: current });
      this.lastFrameSeq = sequence;
    }
    this.prune(nowMs);

    if (!this.pcmLive()) {
      this.openArmed = true;
      this.transition('closed', nowMs, {
        owner: 'upstream_safety',
        reason: 'pcm_unavailable',
      });
      return this.snapshot(nowMs);
    }
    const decisionValue = average(this.samples.filter(
      (sample) => sample.at > nowMs - DECISION_WINDOW_MS,
    ));
    // ⭐ P2：只有开发态回退才在这里判开门。正式路径下**本包不做 admission**，
    //   但上面的采样、可用性与统计照常——observation 与 admission 是两件事。
    if (this.state === 'closed' && this.gateExecutor === 'legacy_speech') {
      if (!this.openArmed && decisionValue < this.config.open_threshold) {
        this.openArmed = true;
      }
      if (this.openArmed && decisionValue >= this.config.open_threshold) {
        this.openArmed = false;
        this.transition('open', nowMs, {
          owner: 'rms_gate',
          reason: 'open_threshold_crossed',
        });
      }
    }
    return this.snapshot(nowMs);
  }

  prune(nowMs) {
    const firstLiveIndex = this.samples.findIndex((sample) => sample.at >= nowMs - 10_000);
    if (firstLiveIndex > 0) this.samples.splice(0, firstLiveIndex);
    else if (firstLiveIndex === -1) this.samples.length = 0;
  }

  snapshot(nowMs = Date.now()) {
    this.prune(nowMs);
    const oneSecond = this.samples.filter((sample) => sample.at >= nowMs - 1000);
    const avgOneSecond = average(oneSecond);
    const decisionSamples = this.samples.filter(
      (sample) => sample.at > nowMs - DECISION_WINDOW_MS,
    );
    const avgDecision = average(decisionSamples);
    const sampleAge = this.lastObservedAtMs === null
      ? null
      : this.upstreamSampleAgeMs + Math.max(0, nowMs - this.lastObservedAtMs);
    const observed = this.available && sampleAge <= 1000;
    /**
     * ⭐ 快照里的 `available` 决定 `state` 与 `pcm_admission`，所以它必须和
     *   开门用的是**同一个判据**——否则门开着而快照说 closed，
     *   下游读到的是一个自相矛盾的事实。
     */
    const available = this.gateExecutor === 'app' && this.captureLive !== null
      ? this.captureLive
      : observed;
    return {
      schema: 'termux-os.rms-gate.v2',
      source: 'android_app_mic_rms_stream',
      available,
      recording: this.recording,
      current: this.current,
      /** 保留 1 秒统计供诊断/趋势使用；它不参与开门。 */
      avg_1s: avgOneSecond,
      avg_100ms: avgDecision,
      peak_10s: this.samples.length
        ? Math.max(...this.samples.map((sample) => sample.value))
        : null,
      decision_metric: 'avg_100ms',
      decision_window_ms: DECISION_WINDOW_MS,
      decision_value: avgDecision,
      open_threshold: this.config.open_threshold,
      /** ⭐ 说出来：否则「音量为什么不开门」与「事件没到」在界面上分不清。 */
      gate_executor: this.gateExecutor,
      /** ⭐ 两边分开报：它们不一致过一次，就该永远看得见。 */
      rms_stream_fresh: observed,
      capture_live: this.captureLive,
      /** 兼容旧读者：P2 之后正式路径恒为 external（开门只来自 App 的显式请求）。 */
      open_source: this.gateExecutor === 'legacy_speech' ? 'rms' : 'external',
      sample_interval_ms: this.config.sample_interval_ms,
      state: available ? this.state : 'closed',
      pcm_admission: available && this.state === 'open' ? 'allow' : 'block',
      open_armed: this.openArmed,
      close_control: 'current_pipeline_lease_owner',
      open_keys: ['rms_threshold', 'explicit_listen'],
      probe_retention: 'none',
      frame_seq: this.lastFrameSeq,
      sample_age_ms: sampleAge,
      transition_seq: this.transitionSeq,
      opened_at_ms: this.openedAtMs,
      closed_at_ms: this.closedAtMs,
      last_transition: this.lastTransition,
      observed_at_ms: this.lastObservedAtMs,
    };
  }
}

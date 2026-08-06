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
    if (!['speech.kws', 'speech.vad', 'speech.asr'].includes(owner)) {
      throw new Error(`unsupported RMS Gate close owner: ${owner}`);
    }
    if (this.state === 'open') {
      this.openArmed = false;
      this.transition('closed', nowMs, { owner, reason });
    }
    return this.snapshot(nowMs);
  }

  closeFromKws(reason = 'kws_timeout', nowMs = Date.now()) {
    return this.closeFromDownstream('speech.kws', reason, nowMs);
  }

  /**
   * 第二把钥匙：KWS HIT 直接开门。
   *
   * 门的唯一正当职责是「避免下游白干」。RMS 是便宜的、always-on 的那把钥匙；
   * KWS HIT 是昂贵但**确定性**的那把——拼音已经算完，代价已经付掉了，再拦它是纯亏。
   *
   * 这一条同时消灭四种「门外命中」（此前全部被静默丢弃）：
   *   A 上一轮余波：`closeFromDownstream` 置 openArmed=false，须先掉回阈值以下才重新 arm，
   *     而 App 侧 pinyin 一秒没停 → 「结束→立刻再叫一次」必被丢。
   *   B 阈值倒挂：App 的 openRms 低于本门阈值时，轻声说话每一次都丢，且无诊断。
   *   C PCM 抖动：帧龄 >1000ms 注入不可用 → owner 被拍回 rms。
   *   D KWS 自身倒计时到点关门后，再开口又落回 A/B。
   */
  openFromKeyword(reason = 'kws_hit', nowMs = Date.now()) {
    // PCM 不可用时不开门：那是安全兜底，不是策略。
    if (!this.available) return this.snapshot(nowMs);
    this.openArmed = false;
    this.transition('open', nowMs, { owner: 'speech.kws', reason });
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

    if (!this.available) {
      this.openArmed = true;
      this.transition('closed', nowMs, {
        owner: 'upstream_safety',
        reason: 'pcm_unavailable',
      });
      return this.snapshot(nowMs);
    }
    const decisionValue = average(this.samples.filter((sample) => sample.at >= nowMs - 1000));
    if (this.state === 'closed') {
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
    const sampleAge = this.lastObservedAtMs === null
      ? null
      : this.upstreamSampleAgeMs + Math.max(0, nowMs - this.lastObservedAtMs);
    const available = this.available && sampleAge <= 1000;
    return {
      schema: 'termux-os.rms-gate.v2',
      source: 'android_app_mic_status',
      available,
      recording: this.recording,
      current: this.current,
      avg_1s: avgOneSecond,
      peak_10s: this.samples.length
        ? Math.max(...this.samples.map((sample) => sample.value))
        : null,
      decision_metric: 'avg_1s',
      decision_value: avgOneSecond,
      open_threshold: this.config.open_threshold,
      sample_interval_ms: this.config.sample_interval_ms,
      state: available ? this.state : 'closed',
      pcm_admission: available && this.state === 'open' ? 'allow' : 'block',
      open_armed: this.openArmed,
      close_control: 'current_pipeline_lease_owner',
      open_keys: ['rms_threshold', 'kws_hit'],
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

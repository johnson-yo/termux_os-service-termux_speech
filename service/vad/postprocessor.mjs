/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: FireRedVAD posterior probabilities in 10 ms frame order.
 * [OUTPUT]: Speech start/end transitions plus gradient cut points inside a still-active segment.
 * [POS]: Pure VAD cut policy; it has no PCM transport, storage, HTP, KWS, or ASR responsibility.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 梯度式切句（参数取自一套先前的实测回归，六个 session）。
 *
 * 官方状态机只有两种出口：真静默结束，或撞上 `maxSpeechFrames` 硬切。连续语流里几乎永远
 * 走后者，于是结果全是贴着上限的长段——实测曾经「几乎全是 9.99–10.04s」，正是这个病。
 *
 * 梯度式不在「当前时刻」硬切，而是**回选窗内已知最优停顿谷**下刀，残尾滚入下一段与新音频
 * 一起重算。三件事让它比阈值切分更接近人的断句：
 *
 *   ① 谷质量 = 谷长(ms) × 平均深度。真停顿又长又深，连读弱尾又短又浅，一个标量把两者分开。
 *   ② 压力斜坡：段越长，对谷质量的要求越低（need 曲线）。能断先断，断不到就继续等好站。
 *   ③ 切点取谷内**深核尾部**而不是整谷尾部——`0.995` 的谷可能是「深静音 + 浅弱语音起始」
 *      连成的一条长谷，切谷尾会落进语音里（原作实测切碎过「盒饭」）。
 *
 * 全程只用已收到的音频，回选的是**已经观察到**的谷，因此仍是流式因果，且不丢字。
 */
/** 段头回看深度：`padStartFrames + minSpeechFrames` 的上界，留足余量。 */
const HISTORY_FRAMES = 64;

const GRADIENT = Object.freeze({
  valleyThreshold: 0.995,   // 高阈值找谷：连续语流在 0.95 下可能一个谷都没有
  coreThreshold: 0.5,       // 谷内「真静音」核心
  minSegmentFrames: 30,     // 段头 300 ms 内不切
  tailGuardFrames: 30,      // 距今 300 ms 内仍归尾部逻辑管，不回选
  startFrames: 150,         // 1.5 s 起即可下车（v8：能断先断）
  pressureFrames: 650,      // 6.5 s 起压力上升
  limitFrames: 900,         // 9 s 起 best-effort
  needAtStart: 300,         // [1.5s, 6.5s) 300 → 60
  needAtPressure: 60,       // [6.5s, 9s)   60 → 30
  needAtLimit: 30,          // [9s, 12s)    30 → 0
  decayFrames: 300,         // 限位后 3 s 内线性归零
  backoffFrames: 10,        // 切点自深核尾部前移，最多 100 ms
});

/** 压力斜坡：段越长越不挑。三段折线，端点与 v8 生产值一致。 */
const needFor = (activeFrames, o) => {
  if (activeFrames < o.pressureFrames) {
    const span = Math.max(1, o.pressureFrames - o.startFrames);
    const ratio = (activeFrames - o.startFrames) / span;
    return o.needAtStart - (o.needAtStart - o.needAtPressure) * ratio;
  }
  if (activeFrames < o.limitFrames) {
    const span = Math.max(1, o.limitFrames - o.pressureFrames);
    const ratio = (activeFrames - o.pressureFrames) / span;
    return o.needAtPressure - (o.needAtPressure - o.needAtLimit) * ratio;
  }
  const decayed = 1 - (activeFrames - o.limitFrames) / o.decayFrames;
  return Math.max(0, o.needAtLimit * decayed);
};

export class StreamVadPost {
  constructor({
    smoothWindow = 5,
    threshold = 0.5,
    padStartFrames = 5,
    minSpeechFrames = 8,
    minSilenceFrames = 30,
    maxSpeechFrames = 1200,
    gradient = true,
    ...overrides
  } = {}) {
    this.options = {
      smoothWindow,
      threshold,
      padStartFrames,
      minSpeechFrames,
      minSilenceFrames,
      maxSpeechFrames,
      gradient,
      ...GRADIENT,
      ...Object.fromEntries(
        Object.keys(GRADIENT).filter((key) => key in overrides).map((key) => [key, overrides[key]]),
      ),
    };
    this.reset();
  }

  reset() {
    this.smooth = [];
    this.smoothSum = 0;
    this.state = 'silence';
    this.speechCount = 0;
    this.silenceCount = 0;
    this.lastEnd = -1;
    this.frameCount = 0;
    // 平滑窗只有 5 帧，段头（padStart + minSpeech）够不着。另留一小段 raw 历史，
    // 让 `openSegment` 能从**真正的段起点**建立回选窗口，而不是从平滑窗能看到的地方。
    this.history = [];
    this.segStartFrame = null;
    this.probs = [];
    this.probsBaseFrame = 0;
    this.lastCut = null;
  }

  /** 段内 raw posterior 历史。回选谷必须看得见过去，滑窗看不见。 */
  rememberProbability(probability) {
    this.history.push(probability);
    if (this.history.length > HISTORY_FRAMES) this.history.shift();
    if (this.segStartFrame === null) return;
    if (!this.probs.length) this.probsBaseFrame = this.frameCount;
    this.probs.push(probability);
  }

  openSegment(startFrame) {
    this.segStartFrame = startFrame;
    const want = Math.max(1, Math.min(this.history.length, this.frameCount - startFrame + 1));
    this.probs = this.history.slice(-want);
    this.probsBaseFrame = this.frameCount - this.probs.length + 1;
  }

  /** 从绝对帧号切到那里之前的历史，残尾留给下一段重算。 */
  advanceSegment(cutFrame) {
    const drop = cutFrame - this.probsBaseFrame + 1;
    if (drop > 0) this.probs.splice(0, drop);
    this.probsBaseFrame = cutFrame + 1;
    this.segStartFrame = cutFrame + 1;
  }

  closeSegment() {
    this.segStartFrame = null;
    this.probs = [];
    this.probsBaseFrame = 0;
  }

  /**
   * @returns 绝对切点帧号；`null` = 这一刻没有值得下刀的站。
   */
  gradientCut() {
    const o = this.options;
    if (!o.gradient || this.segStartFrame === null) return null;
    const activeFrames = this.frameCount - this.segStartFrame + 1;
    if (activeFrames < o.startFrames) return null;
    const lo = o.minSegmentFrames;
    const hi = this.probs.length - o.tailGuardFrames;
    if (hi <= lo) return null;

    let bestScore = -1;
    let bestStart = 0;
    let bestEnd = 0;
    for (let i = lo; i < hi;) {
      if (this.probs[i] >= o.valleyThreshold) { i += 1; continue; }
      const start = i;
      let sum = 0;
      while (i < hi && this.probs[i] < o.valleyThreshold) { sum += this.probs[i]; i += 1; }
      const depth = o.valleyThreshold - sum / (i - start);
      const score = (i - start) * 10 * depth;
      if (score > bestScore) { bestScore = score; bestStart = start; bestEnd = i; }
    }
    if (bestScore < 0) return null;
    const need = needFor(activeFrames, o);
    if (bestScore < need) return null;

    // 谷内深核：p<0.5 的最长真静音段。无深核时退回谷内最低点。
    let coreStart = -1;
    let coreEnd = -1;
    let runStart = -1;
    let lowest = bestStart;
    for (let i = bestStart; i <= bestEnd; i += 1) {
      const deep = i < bestEnd && this.probs[i] < o.coreThreshold;
      if (deep && runStart < 0) runStart = i;
      if (!deep && runStart >= 0) {
        if (i - runStart > coreEnd - coreStart) { coreStart = runStart; coreEnd = i; }
        runStart = -1;
      }
      if (i < bestEnd && this.probs[i] < this.probs[lowest]) lowest = i;
    }
    const relative = coreStart >= 0
      ? coreEnd - Math.min(o.backoffFrames, Math.floor((coreEnd - coreStart) / 4))
      : lowest + 1;
    this.lastCut = {
      valley_ms: [bestStart * 10, bestEnd * 10],
      core_ms: coreStart >= 0 ? [coreStart * 10, coreEnd * 10] : null,
      score: Number(bestScore.toFixed(1)),
      need: Number(need.toFixed(1)),
      active_ms: activeFrames * 10,
      roll_ms: (this.probs.length - relative) * 10,
    };
    return this.probsBaseFrame + relative;
  }

  process(raw) {
    this.frameCount += 1;
    const probability = Math.max(0, Math.min(1, Number(raw) || 0));
    this.smooth.push(probability);
    this.smoothSum += probability;
    if (this.smooth.length > this.options.smoothWindow) {
      this.smoothSum -= this.smooth.shift();
    }
    this.rememberProbability(probability);
    const speech = this.smoothSum / this.smooth.length >= this.options.threshold;
    if (this.state === 'silence') {
      if (speech) {
        this.state = 'possible_speech';
        this.speechCount = 1;
      } else {
        this.silenceCount += 1;
        this.speechCount = 0;
      }
      return {};
    }
    if (this.state === 'possible_speech') {
      if (!speech) {
        this.state = 'silence';
        this.silenceCount = 1;
        this.speechCount = 0;
        return {};
      }
      this.speechCount += 1;
      if (this.speechCount < this.options.minSpeechFrames) return {};
      this.state = 'speech';
      this.silenceCount = 0;
      const startFrame = Math.max(
        1,
        this.frameCount - this.speechCount + 1 - this.options.padStartFrames,
        this.lastEnd + 1,
      );
      this.openSegment(startFrame);
      return { start_frame: startFrame };
    }
    if (this.state === 'speech') {
      this.speechCount += 1;
      if (speech) {
        this.silenceCount = 0;
        if (this.speechCount >= this.options.maxSpeechFrames) {
          this.lastEnd = this.frameCount;
          this.state = 'silence';
          this.speechCount = 0;
          this.closeSegment();
          return { end_frame: this.frameCount };
        }
        // 梯度式：段仍在说话，但窗内已经出现足够好的停顿谷 → 回选它下刀，残尾滚入下一段。
        const cutFrame = this.gradientCut();
        if (cutFrame !== null) {
          this.speechCount = Math.max(1, this.frameCount - cutFrame);
          this.advanceSegment(cutFrame);
          return { cut_frame: cutFrame, cut: { ...this.lastCut } };
        }
        return {};
      }
      this.state = 'possible_silence';
      this.silenceCount = 1;
      return {};
    }
    this.speechCount += 1;
    if (speech) {
      this.state = 'speech';
      this.silenceCount = 0;
      return {};
    }
    this.silenceCount += 1;
    if (this.silenceCount < this.options.minSilenceFrames) return {};
    this.lastEnd = this.frameCount;
    this.state = 'silence';
    this.speechCount = 0;
    this.closeSegment();
    return { end_frame: this.frameCount };
  }
}

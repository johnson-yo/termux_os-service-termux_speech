/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个完整 segment 的逐帧 RMS（dB）+ 两个显式校准出来的参考层 B* / R*
 * [OUTPUT]: 对外提供「这一段里有没有主体说话人」的整段 KEEP / DROP 判定（相对电平版）
 * [POS]: docs/079。docs/076 的绝对 band 版在**连续人声背景**下失效，这是它的替代判据。
 *
 * ⭐ 为什么换掉绝对 band（真机实测，背景是一档持续播放的中文访谈播客）：
 *   band = R* ± 6 dB 的**下沿**离背景太近——实测背景 p90 = -32.5 dB，而 band 下沿
 *   -32.19 dB，只差 0.3 dB。帧长 10 ms，一个 4 秒 segment 有 400 帧，只要 8% 的背景帧
 *   越过下沿就凑满 `min_in_band_ms = 300` ⇒ **任何长于约 3.5 秒的段，纯背景也必然 KEEP**。
 *   真机 10 个 epoch 里 9 个 KEEP，其中大部分 median 在 -40 dB 附近（远低于参考 -26.19）。
 *
 * ⭐ 判据换成「相对背景层」而不是「落在绝对带内」：
 *     G = R* - B*          T = B* + alpha * G
 *     每 10 ms 帧：db >= T ? → 累计 foreground-like 时间 → 超过 min_ms ⇒ KEEP 整段
 *   理由是 presence 的物理含义是「**有没有比这个房间更响的东西**」——这个量自校准，
 *   房间整体变吵/变安静时两个参考一起动，判据不变；绝对 band 则整体失效。
 *
 * ⭐ 单侧，不设上沿：docs/076 的上沿会把「说得比平时大声」判成不在带内。
 *   presence 问的是「有没有足够响的东西」，响过头从来不是理由。
 *
 * ⛔ 三条红线（与 docs/076 相同，一条没松）：
 *   · 只决定**整段** KEEP/DROP，绝不裁剪 segment 内的 PCM。
 *     「背景 → 用户 → 背景」只要中间越过 T 足够久，整段保留。
 *   · 参考没准备好、或两层分不开时一律 KEEP——**宁可放过背景，不误杀用户**。
 *   · 判定**永不**回写参考。docs/078 真机上正是这条反过来出的事：KEEP 段整段被
 *     absorb 进 reference，而几乎全是 KEEP，于是 R* 一路滑向背景层、越滑越 KEEP。
 *
 * ⚠ 不要用 segment 的 p90/p95 当主判据。4 秒背景里夹 300 ms 用户说话，用户只占 7.5%，
 *   即使他非常响，segment p90 描述的仍然是背景。**主判据必须是逐帧越线时间的累计**，
 *   分位数只进 telemetry。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const SILENCE_DB = -70;

export const RELATIVE_DEFAULTS = Object.freeze({
  /** T = B* + alpha × (R* − B*)。0.5 = 两层正中间，先不做参数搜索。 */
  alpha: 0.5,
  /** 累计越线多久算「这一段里有人」。 */
  foreground_min_ms: 200,
  /**
   * 两层至少要差这么多 dB 才敢判。差不到就是 `insufficient_separation`，
   * ⛔ 判 KEEP 而不是 DROP——分不开的时候放过背景，不误杀用户。
   */
  min_separation_db: 6,
  /** 太短的段不判（VAD 抖动，判也判不准）。 */
  min_segment_ms: 200,
});

/**
 * 参考层从校准窗口的哪个分位数取。
 *
 * ⭐ 这两个取值比 alpha 重要得多，真机数据可以直接证明：
 *   背景 p50 -39.0 / p60 -37.5 / p90 -32.5 / p95 -31.4 / max -27.4
 *   sample p50 -32.1 / p60 -29.3 / p75 -24.1 / p90 -18.7 / p95 -16.3 / max -8.8
 *   · 两边都取 p60 ⇒ T = -33.4，而背景 p90 = -32.5 在它上面
 *     ⇒ 12% 的背景帧越线，4 秒段凑出 480 ms ⇒ **纯背景 false KEEP**。
 *   · B* 取 p95、R* 取 p90 ⇒ T = -25.1，而背景 **max 只有 -27.4，一帧都过不去**。
 *   所以 B* 必须取背景的**尾部**（阈值要压过背景最响的那部分），
 *   而 R* 取 p90 是因为用户校准窗口里本来就混着背景（背景 VAD 概率 85% > 0.6，
 *   靠 VAD 筛不掉），用中位数会把背景一起算进「用户层」。
 */
export const REFERENCE_STATS = Object.freeze({
  background: 'p95',
  user: 'p90',
});

export const percentileOf = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
};

/** 一个校准窗口/一段音频的完整分布，两处（校准候选与 epoch telemetry）共用。 */
export const distributionOf = (values) => {
  const usable = values.filter((v) => v > SILENCE_DB);
  if (!usable.length) return null;
  const p = (q) => Number(percentileOf(usable, q).toFixed(2));
  return {
    n: usable.length,
    p10: p(0.10), p25: p(0.25), p50: p(0.50), p60: p(0.60),
    p75: p(0.75), p90: p(0.90), p95: p(0.95),
    min: Number(Math.min(...usable).toFixed(2)),
    max: Number(Math.max(...usable).toFixed(2)),
  };
};

/** 从一个分布里按名字取值：`'p95'` / `'p60'` / `'max'` / `'median'`。 */
export const statFrom = (dist, name) => {
  if (!dist) return null;
  if (name === 'median') return dist.p50;
  return Object.prototype.hasOwnProperty.call(dist, name) ? dist[name] : null;
};

export class RelativeForegroundGate {
  constructor(config = {}) {
    this.config = { ...RELATIVE_DEFAULTS, ...config };
    this.backgroundDb = null;
    this.userDb = null;
    this.keepCount = 0;
    this.dropCount = 0;
    this.lastDecision = null;
  }

  configure(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.config && Number.isFinite(Number(v))) this.config[k] = Number(v);
    }
    return this.config;
  }

  /**
   * ⛔ 参考只从这里进来，**只有显式校准会调用它**。
   * `decide()` 永远不碰这两个值——docs/078 的正反馈就是从「判定回写参考」开始的。
   */
  setReferences({ backgroundDb = undefined, userDb = undefined } = {}) {
    if (backgroundDb !== undefined) this.backgroundDb = backgroundDb === null ? null : Number(backgroundDb);
    if (userDb !== undefined) this.userDb = userDb === null ? null : Number(userDb);
    return this.references();
  }

  get gapDb() {
    if (this.backgroundDb === null || this.userDb === null) return null;
    return Number((this.userDb - this.backgroundDb).toFixed(2));
  }

  get thresholdDb() {
    const gap = this.gapDb;
    if (gap === null) return null;
    return Number((this.backgroundDb + this.config.alpha * gap).toFixed(2));
  }

  /** `ready` = 有两个参考**且**它们分得开。分不开时判据不成立，不是「阈值更难达到」。 */
  get ready() {
    const gap = this.gapDb;
    return gap !== null && gap >= this.config.min_separation_db;
  }

  references() {
    return {
      background_db: this.backgroundDb,
      user_db: this.userDb,
      gap_db: this.gapDb,
      alpha: this.config.alpha,
      threshold_db: this.thresholdDb,
      foreground_min_ms: this.config.foreground_min_ms,
      min_separation_db: this.config.min_separation_db,
      ready: this.ready,
      /** 分不开时明说是哪一种「没准备好」，否则两种都长成 `ready:false`。 */
      not_ready_reason: this.ready
        ? null
        : (this.gapDb === null ? 'reference_not_ready' : 'insufficient_separation'),
    };
  }

  /**
   * 判一整段。
   * @param frames 该 segment 的逐帧 dB
   * @param frameMs 每帧毫秒
   */
  decide(frames, frameMs, meta = {}) {
    const c = this.config;
    const durationMs = frames.length * frameMs;
    const dist = distributionOf(frames);
    const T = this.thresholdDb;

    let aboveFrames = 0;
    let run = 0;
    let maxRun = 0;
    if (T !== null) {
      for (const v of frames) {
        if (v >= T) { aboveFrames += 1; run += 1; if (run > maxRun) maxRun = run; }
        else run = 0;
      }
    }
    const aboveMs = aboveFrames * frameMs;

    const base = {
      gate: 'relative',
      segment_id: meta.segment_id ?? null,
      segment_duration_ms: durationMs,
      // ⭐ C3：判决现场必须完整落盘，否则「页面显示一套、判决用另一套」这种事
      //   在事后完全不可查（docs/078 §9 那次就是这样）。
      background_reference_db: this.backgroundDb,
      user_reference_db: this.userDb,
      reference_gap_db: this.gapDb,
      alpha: c.alpha,
      foreground_threshold_db: T,
      foreground_min_ms: c.foreground_min_ms,
      segment_p50_db: dist?.p50 ?? null,
      segment_p75_db: dist?.p75 ?? null,
      segment_p90_db: dist?.p90 ?? null,
      segment_p95_db: dist?.p95 ?? null,
      segment_max_db: dist?.max ?? null,
      time_above_threshold_ms: aboveMs,
      max_contiguous_above_threshold_ms: maxRun * frameMs,
      at_ms: Date.now(),
    };

    // ⛔ 分不开 / 没参考 ⇒ KEEP。本轮不许在无法区分时强行 DROP。
    if (!this.ready) {
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: this.references().not_ready_reason };
      return this.lastDecision;
    }
    if (durationMs < c.min_segment_ms) {
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: 'segment_too_short_to_judge' };
      return this.lastDecision;
    }

    if (aboveMs >= c.foreground_min_ms) {
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: 'foreground_present' };
    } else {
      this.dropCount += 1;
      this.lastDecision = { ...base, decision: 'DROP', keep_reason: null,
                            drop_reason: 'background_only' };
    }
    return this.lastDecision;
  }

  stats() {
    return { keep: this.keepCount, drop: this.dropCount, last: this.lastDecision };
  }

  resetCounts() { this.keepCount = 0; this.dropCount = 0; this.lastDecision = null; }
}

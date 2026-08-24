/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一串滑窗 CAM++ similarity（每 step_ms 一个）
 * [OUTPUT]: 对外提供 USER / OTHER 时间轴、按场景标签的分数分布、以及一个**建议**阈值
 * [POS]: docs/080 §USER-VAD。⛔ 这里没有 IO、没有模型、没有设备——判据长什么样就在这一层钉死。
 *
 * ⭐ 这一层存在的理由是离线 PoC 的结论：**判定粒度必须从「段」降到「窗」**。
 *   FireRedVAD 判的是「有没有人在说话」，背景一直说话时段边界由背景决定，
 *   用户那一句只是被包在中间 ⇒ 整段 embedding 被背景主导 ⇒ 误杀使用者。
 *   ⛔ 所以 **FireRedVAD 绝不参与切 CAM++ 的窗**，它只是一个可显示的旁证。
 *
 * ⚠ 阈值与窗长**绑定**，不可互换：同一个人在安静房间里
 *   6 秒的段是 0.95，而 1.5 秒的窗只有 0.487（真机实测）。
 *   换了 window_ms 就必须重新校准 threshold——`configure()` 会把这件事说出来。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const USERVAD_DEFAULTS = Object.freeze({
  /** 离线 PoC 的可用区间是 1000–2000 ms；1500 有 0.16 的余量。 */
  window_ms: 1500,
  step_ms: 250,
  /** ⚠ 只是 1.5 s 滑窗的实验初值，**不是**通用 speaker verification 阈值。 */
  threshold: 0.30,
  on_windows: 2,
  off_windows: 2,
});

/** 页面推荐的窗长。500 允许手输但不推荐——离线实测它的 margin 基本归零。 */
export const RECOMMENDED_WINDOWS = Object.freeze([750, 1000, 1500, 2000]);

export const LABELS = Object.freeze(
  ['UNLABELED', 'USER', 'BACKGROUND', 'OTHER_NEAR', 'OVERLAP']);

const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  : null);

export const describe = (values) => {
  if (!values.length) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const r = (x) => (x === null ? null : Number(x.toFixed(4)));
  return { n: s.length, min: r(s[0]), p10: r(pct(s, 0.10)), p50: r(pct(s, 0.50)),
           p90: r(pct(s, 0.90)), p95: r(pct(s, 0.95)), max: r(s[s.length - 1]) };
};

/**
 * USER / OTHER 迟滞状态机。
 * ⭐ `raw_match` / `on_streak` / `off_streak` / `state` 四个都要吐出来——
 *   少了它们，「模型没认出来」与「迟滞还没数够」在页面上长得一模一样。
 */
export class UserVadState {
  constructor(config = {}) {
    this.config = { ...USERVAD_DEFAULTS, ...config };
    this.reset();
  }

  /**
   * 实时改参数。返回是否需要重新校准阈值——**换窗长就必须重校**。
   */
  configure(patch = {}) {
    const before = this.config.window_ms;
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.config && Number.isFinite(Number(v))) this.config[k] = Number(v);
    }
    this.config.on_windows = Math.max(1, Math.round(this.config.on_windows));
    this.config.off_windows = Math.max(1, Math.round(this.config.off_windows));
    const changed = this.config.window_ms !== before;
    if (changed) this.calibrationStale = true;
    return { config: { ...this.config }, window_changed: changed,
             recalibrate_hint: this.calibrationStale };
  }

  reset() {
    this.state = 'OTHER';
    this.onStreak = 0;
    this.offStreak = 0;
    this.seq = 0;
    this.transitions = [];
    this.calibrationStale = false;
    this.lastEnteredUserAtMs = null;
  }

  /** 阈值被显式确认过 ⇒ 不再提示重校。 */
  acknowledgeCalibration() { this.calibrationStale = false; }

  /**
   * 喂一个窗的结果。⛔ 只根据 similarity 与迟滞计数决定状态，
   * **不看 VAD 概率、不看标签**——标签只是给人看的，绝不参与判决。
   */
  push({ similarity, monoMs = null, windowStartMs = null, windowEndMs = null,
         inferenceMs = null, vadProbability = null }) {
    const c = this.config;
    const raw = similarity >= c.threshold;
    this.onStreak = raw ? this.onStreak + 1 : 0;
    this.offStreak = raw ? 0 : this.offStreak + 1;
    const before = this.state;
    if (this.state === 'OTHER' && this.onStreak >= c.on_windows) this.state = 'USER';
    else if (this.state === 'USER' && this.offStreak >= c.off_windows) this.state = 'OTHER';
    this.seq += 1;
    const entry = {
      seq: this.seq, mono_ms: monoMs,
      window_start_ms: windowStartMs, window_end_ms: windowEndMs,
      window_ms: c.window_ms, step_ms: c.step_ms,
      similarity: Number(Number(similarity).toFixed(4)),
      threshold: c.threshold,
      raw_match: raw, on_streak: this.onStreak, off_streak: this.offStreak,
      state: this.state,
      inference_ms: inferenceMs, vad_probability: vadProbability,
    };
    if (before !== this.state) {
      entry.transition = `${before}->${this.state}`;
      this.transitions.push({ seq: this.seq, at_ms: monoMs, transition: entry.transition });
      if (this.transitions.length > 50) this.transitions.shift();
      if (this.state === 'USER') this.lastEnteredUserAtMs = monoMs;
    }
    return entry;
  }

  snapshot() {
    return {
      config: { ...this.config },
      state: this.state,
      on_streak: this.onStreak,
      off_streak: this.offStreak,
      seq: this.seq,
      recalibrate_hint: this.calibrationStale,
      recent_transitions: this.transitions.slice(-8),
    };
  }
}

/**
 * 按人工场景标签统计分数。
 * ⛔ 标签**只用于统计和回看**，绝不进入判决——一个能看见标签的判据，
 *   测出来的是「我告诉它答案的能力」。
 */
export class LabelStats {
  constructor(speechThreshold = 0.5) {
    this.label = 'UNLABELED';
    this.speechThreshold = speechThreshold;
    this.values = Object.fromEntries(LABELS.map((l) => [l, []]));
    /**
     * ⭐ 只含「当时确实有人在说话」的窗。
     *
     * ⚠ 这一层是真机逼出来的：按相位打标签会把**相位内的静默**一起算进去。
     *   实测一相 40 秒里只有约 25 秒在出声，于是 USER 的 p10/p50 描述的是**静默**
     *   （−0.02 / 0.03），拿它去和别人的 max 比，规则永远只会报「重叠」。
     *   判据要问的是「**这个人说话时**多少分」对「**别人说话时**多少分」，
     *   静默窗与两者都无关。
     * ⛔ VAD 只进这一层**统计**，绝不进 USER/OTHER 的判决——判决只看 similarity 与迟滞。
     */
    this.speech = Object.fromEntries(LABELS.map((l) => [l, []]));
    this.changedAtMs = null;
    this.impureDropped = 0;
  }

  setLabel(next) {
    if (LABELS.includes(next) && next !== this.label) {
      this.label = next;
      this.changedAtMs = Date.now();
    }
    return this.label;
  }

  /**
   * ⭐ 这一窗的音频是不是**完全**属于当前标签。
   *
   * ⚠ 真机实测：1500 ms 的窗会跨过标签切换点——使用者切到 BACKGROUND 之后，
   *   接下来约 6 个窗（window/step）里仍然含着他自己刚说完的话，
   *   于是 similarity 0.565/0.419 被记成「背景」，把建议阈值整个卡死。
   *   **那不是模型错，是统计把两类音频混进了一个窗。**
   */
  isPure(windowMs, nowMs = Date.now()) {
    return this.changedAtMs === null || (nowMs - this.changedAtMs) >= windowMs;
  }

  add(similarity, vadProbability = null, pure = true) {
    // ⛔ 跨越标签切换的窗一律不进统计：它里面混着两类音频，记进任何一栏都是错的。
    if (!pure) { this.impureDropped += 1; return; }
    for (const bucket of [this.values[this.label],
      ...(vadProbability !== null && vadProbability >= this.speechThreshold
        ? [this.speech[this.label]] : [])]) {
      bucket.push(similarity);
      if (bucket.length > 20_000) bucket.shift();
    }
  }

  clear(label = null) {
    if (label && LABELS.includes(label)) { this.values[label] = []; this.speech[label] = []; }
    else {
      this.values = Object.fromEntries(LABELS.map((l) => [l, []]));
      this.speech = Object.fromEntries(LABELS.map((l) => [l, []]));
    }
  }

  /**
   * ⭐ 用**运行时真正用的那套判据**去评一个候选阈值：迟滞跑在**有序**的窗序列上。
   *
   * ⚠ 这一层是真机逼出来的。旧规则拿 `USER p10` 比 `OTHER p95`，两个都是
   *   **逐窗分位数**——而运行时从来不逐窗判决，它要的是 `on_windows` 个**连续**越阈。
   *   真机那份数据里：背景 101 个窗只有 13 个越过 0.45，而且挤在两段连续的尖峰里；
   *   逐窗分位数把这 13 个摊进 p95，于是报「重叠、没有干净阈值」，
   *   而真正该回答的是「背景会不会**触发**，用户会不会**被认出来**」。
   *   **判据的单位必须和系统的单位一致**（docs/079 同一条）。
   * @returns {{ enters: number, on_ratio: number, n: number }}
   */
  static simulate(series, { threshold, onWindows = 2, offWindows = 2 } = {}) {
    let state = 'OTHER';
    let on = 0;
    let off = 0;
    let enters = 0;
    let onCount = 0;
    for (const value of series) {
      const raw = value >= threshold;
      on = raw ? on + 1 : 0;
      off = raw ? 0 : off + 1;
      if (state === 'OTHER' && on >= onWindows) { state = 'USER'; enters += 1; }
      else if (state === 'USER' && off >= offWindows) state = 'OTHER';
      if (state === 'USER') onCount += 1;
    }
    return { enters, on_ratio: series.length ? Number((onCount / series.length).toFixed(4)) : 0,
             n: series.length };
  }

  /**
   * 建议阈值。⛔ **绝不自动应用**，而且分不开时明说分不开，不给一个假装有意义的数。
   *
   * ⭐ 判据 = 「背景一次都不触发」中，让用户被认出得最多的那个阈值。
   *   ⚠ 用**全部窗**（含静默）而不是只用说话中的窗——运行时看见的就是全部窗，
   *   静默会把 `on_streak` 打断，那是真实行为的一部分，不该被统计悄悄抹平。
   */
  suggestedThreshold(config = this.config ?? {}) {
    const onWindows = Math.max(1, Math.round(Number(config.on_windows) || 2));
    const offWindows = Math.max(1, Math.round(Number(config.off_windows) || 2));
    const user = this.values.USER;
    const other = [...this.values.OTHER_NEAR, ...this.values.BACKGROUND];
    if (user.length < 10 || other.length < 10) {
      return { ok: false, reason: 'not_enough_samples',
               user_n: user.length, other_n: other.length };
    }
    const table = [];
    for (let t = 20; t <= 80; t += 1) {
      const threshold = Number((t / 100).toFixed(2));
      const u = LabelStats.simulate(user, { threshold, onWindows, offWindows });
      const o = LabelStats.simulate(other, { threshold, onWindows, offWindows });
      table.push({ threshold, user_on_ratio: u.on_ratio, user_enters: u.enters,
                   other_on_ratio: o.on_ratio, other_enters: o.enters });
    }
    const clean = table.filter((r) => r.other_enters === 0 && r.user_enters > 0);
    /**
     * ⭐ **取可用带的中点，不取它的边缘。**
     *
     * ⚠ 第一版选「背景零触发里用户覆盖最高的那个」，真机数据上它给出 0.35——
     *   而背景的地板是 0.36，也就是**紧贴悬崖**：房间里换一个人说话、
     *   或者电视换一段音乐，它立刻开始误收。而同一份数据的可用带是 0.36–0.54，
     *   中点 0.45 两侧各有约 0.09 的余量。
     * 带的两端分别是两种失败：低端 = 背景开始触发；高端 = 使用者自己开始被挡。
     * 用户覆盖 90% 是高端的判据——低于它就说明这个阈值已经在吃掉使用者。
     */
    const band = clean.filter((r) => r.user_on_ratio >= 0.9);
    if (band.length) {
      const low = band[0].threshold;
      const high = band[band.length - 1].threshold;
      const mid = Number(((low + high) / 2).toFixed(2));
      const best = band.reduce((a, b) => (
        Math.abs(b.threshold - mid) < Math.abs(a.threshold - mid) ? b : a));
      return { ok: true, strict: true, threshold: best.threshold,
               basis: '可用带的中点（下沿=背景开始触发，上沿=用户覆盖跌破 90%）',
               band_low: low, band_high: high,
               margin_below: Number((best.threshold - low).toFixed(2)),
               margin_above: Number((high - best.threshold).toFixed(2)),
               user_on_ratio: best.user_on_ratio, user_enters: best.user_enters,
               other_enters: 0, user_n: user.length, other_n: other.length,
               on_windows: onWindows, table };
    }
    if (clean.length) {
      /**
       * 背景分得开，但没有一个阈值能同时让用户覆盖到 90%。
       * ⛔ 如实说这是**退而求其次**，不要让它长得跟上面那条一样。
       */
      const best = clean.reduce((a, b) => (b.user_on_ratio > a.user_on_ratio ? b : a));
      return { ok: true, strict: false, threshold: best.threshold,
               basis: '背景零触发，但用户覆盖到不了 90%——取覆盖最高的那个',
               user_on_ratio: best.user_on_ratio, user_enters: best.user_enters,
               other_enters: 0, user_n: user.length, other_n: other.length,
               on_windows: onWindows, table };
    }
    // 没有干净点就如实说，并给出最省的那个折中，⛔ 不自动应用。
    const usable = table.filter((r) => r.user_enters > 0);
    const least = usable.length
      ? usable.reduce((a, b) => (b.other_enters < a.other_enters
        || (b.other_enters === a.other_enters && b.user_on_ratio > a.user_on_ratio) ? b : a))
      : null;
    return { ok: false, reason: 'overlap',
             detail: '没有一个阈值能让背景零触发同时还认得出用户',
             best_effort: least, user_n: user.length, other_n: other.length,
             on_windows: onWindows, table };
  }

  /** 旧的逐窗分位数判据，保留只为对照——⛔ 它不是运行时用的那套。 */
  windowPercentileSuggestion() {
    const user = this.speech.USER;
    const other = [...this.speech.OTHER_NEAR, ...this.speech.BACKGROUND];
    if (user.length < 5 || other.length < 5) {
      return { ok: false, reason: 'not_enough_samples',
               user_n: user.length, other_n: other.length };
    }
    const u = describe(user);
    const o = describe(other);
    /**
     * ⭐ 严格判据用 `other.max`，但**单个离群窗就能把它废掉**（真机遇到过：
     *   49 个背景窗 p90 才 0.24，一个 0.5648 直接让规则报「重叠」）。
     *   所以同时给一个抗离群的实用判据（p95），并**如实说出有几个窗超过它**——
     *   ⛔ 不把离群点悄悄丢掉，只是不让它一票否决。
     */
    const over = (T) => other.filter((v) => v >= T).length;
    if (o.max < u.p10) {
      return { ok: true, strict: true, threshold: Number(((o.max + u.p10) / 2).toFixed(4)),
               basis: 'other_max < user_p10', user_p10: u.p10, other_max: o.max,
               margin: Number((u.p10 - o.max).toFixed(4)), other_over_threshold: 0 };
    }
    /**
     * ⚠ 样本太少时 p95 **就等于 max**（最近秩法：n=10 时 p95 落在第 10 个），
     *   抗离群规则会静默退化成严格规则，看起来「用了 p95」其实没有。
     *   少于 20 个就明说做不到，不假装。
     */
    if (other.length >= 20 && o.p95 < u.p10) {
      const T = Number(((o.p95 + u.p10) / 2).toFixed(4));
      return { ok: true, strict: false, threshold: T,
               basis: 'other_p95 < user_p10（max 有离群点）',
               user_p10: u.p10, other_p95: o.p95, other_max: o.max,
               margin: Number((u.p10 - o.p95).toFixed(4)),
               other_over_threshold: over(T), other_n: other.length };
    }
    return {
      ok: false,
      reason: other.length < 20 && o.max >= u.p10 && o.p50 < u.p10
        ? 'overlap_but_too_few_other_samples' : 'overlap',
      user_p10: u.p10, other_p95: o.p95, other_max: o.max, other_n: other.length,
      overlap: Number((Math.min(o.p95, o.max) - u.p10).toFixed(4)),
    };
  }

  snapshot(config = {}) {
    this.config = { ...(this.config ?? {}), ...config };
    return {
      current: this.label,
      speech_threshold: this.speechThreshold,
      impure_dropped: this.impureDropped,
      labels: Object.fromEntries(LABELS.map((l) => [l, describe(this.values[l])])),
      /** ⭐ 定阈值只该看这一组——上面那组含静默，p10/p50 描述的不是说话人。 */
      labels_speech: Object.fromEntries(LABELS.map((l) => [l, describe(this.speech[l])])),
      suggested: this.suggestedThreshold(),
      /** ⛔ 只为对照留着：逐窗分位数不是运行时用的判据。 */
      window_percentiles: this.windowPercentileSuggestion(),
    };
  }
}

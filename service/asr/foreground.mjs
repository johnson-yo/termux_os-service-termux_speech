/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个完整 FireRedVAD segment 的逐帧 RMS（dB）
 * [OUTPUT]: 对外提供 session-local 的「这一段里有没有主体说话人」整段 KEEP / DROP 判定
 * [POS]: docs/076。装在 VAD segment 与 SenseVoice 之间，**只在 SenseVoice 这条处理门上**。
 *
 * ⭐ 上一轮 PoC（tmp/rms-foreground-presence-poc）量出两件事，这一版直接按结论写：
 *   ① 参考直方图**没有明显主峰**（modal 只占 14–16% 时长、比次高桶只高 3–31%，
 *      而且**纯背景那条长得一模一样**）——形状不携带 presence 信息，只有位置携带。
 *      故 R* 用**稳健分位数**（p60），modal 只留作 telemetry，判定不依赖它。
 *   ② `min_in_band` 用绝对毫秒会**结构性误杀短段**：真机上 DROP 段时长 p50 470 ms、
 *      KEEP 段 1180 ms，24 个假 DROP 里 19 个短于 600 ms、11 个的主体层其实就在带内。
 *      故判据改成「比例 **或** 绝对下限」二者取或。
 *
 * ⛔ 三条红线：
 *   · 只决定**整段** KEEP/DROP，绝不裁剪 segment 内的 PCM
 *     （「背景 → 用户 → 背景」只要中间命中主体层，整段保留）。
 *   · reference 没稳之前一律 KEEP——**宁可放过背景，不误杀用户**。
 *   · DROP 段**永不**更新 reference，否则背景会把主体层拖走。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const SILENCE_DB = -70;

export const DEFAULTS = Object.freeze({
  /** 带宽：R* 两侧各多少 dB 算「同一层」。 */
  band_half_db: 6,
  /** 参考攒够多少毫秒**语音**才允许开始 DROP。 */
  reference_min_ms: 3000,
  /** 参考最多记多少毫秒（滚动窗口，跟得上使用者移动）。 */
  reference_window_ms: 20000,
  /**
   * 命中判据（二者取或）：**累计**落在带内的时长，或占比。
   *
   * ⚠ 这里我差点把一个**刻意的安全偏置**当成缺陷改掉。真机上看到
   *   「3840 ms 的段只有 630 ms 在带内也 KEEP」，第一反应是收紧成「长段只看占比」——
   *   但那会直接违背任务的红线：**「用户+背景重叠时，只要检测到主体 reference，
   *   整段保留」**。一个人在电视声里说一句话，占比天然就低。
   *   `decide` 问的是「**有没有**足够的主体能量」，不是「主体能量占不占多数」。
   *   故绝对下限对所有时长都生效，只把它从 200 抬到 300 ms
   *   （真机三次真 DROP 的带内时长是 0 / 110 / 80 ms，离 300 还很远）。
   */
  min_in_band_ratio: 0.35,
  min_in_band_ms: 300,
  /** 已确认 KEEP 的段允许以这个系数缓慢更新 R*。 */
  reference_ema: 0.1,
  /** 太短的段不判，直接 KEEP（VAD 抖动，判也判不准）。 */
  min_segment_ms: 200,
  /**
   * ⭐ C1（docs/079）：`fixed = true` 时 R* **完全冻结**，KEEP 与 DROP 都改不动它。
   *
   * ⚠ 这条是真机查出来的：Lab 的 `reference_fixed` 只冻结了**页面显示的**那个值，
   *   而 `#absorb()` 照旧在每次 KEEP 时用 EMA 改 `rStar` ⇒ 页面写着 -26.19、
   *   判决用的却已经滑到约 -34（由 seq23「median -34.28 却有 87.8% 帧在带内」反推，
   *   若带真是 [-32.19,-20.19] 这两件事不可能同时成立）。
   *   **显示值与判决值分家，比数值不对更难查**——它看起来完全正常。
   */
  fixed: false,
  /** telemetry 用的直方图桶宽。 */
  bin_db: 2,
});

const percentile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
};

/** 众数只进 telemetry：上一轮已证它在宽平分布上既不显著也不稳。 */
const modalDb = (values, binDb) => {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) {
    const k = Math.round(v / binDb);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bestK = null;
  let best = -1;
  let second = 0;
  for (const [k, c] of counts) {
    if (c > best) { second = best; bestK = k; best = c; }
    else if (c > second) second = c;
  }
  return {
    db: Number((bestK * binDb).toFixed(2)),
    share: Number((best / values.length).toFixed(3)),
    prominence: second > 0 ? Number((best / second).toFixed(2)) : null,
  };
};

export class ForegroundGate {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.reset('init');
  }

  configure(patch = {}) {
    this.config = { ...this.config, ...patch };
    return this.config;
  }

  /**
   * 一次新的会话（进入 listen）。⛔ **session-local**：
   * 换个房间、换个距离，上一次的主体层就不成立了，绝不跨 session 复用。
   */
  reset(source = 'listen') {
    this.source = source;
    this.refValues = [];          // 参考段的逐帧 dB（滚动）
    this.refMs = 0;
    this.rStar = null;
    this.keepCount = 0;
    this.dropCount = 0;
    this.lastDecision = null;
    this.startedAtMs = Date.now();
  }

  get ready() {
    return this.rStar !== null && this.refMs >= this.config.reference_min_ms;
  }

  band() {
    if (this.rStar === null) return null;
    const h = this.config.band_half_db;
    return [Number((this.rStar - h).toFixed(2)), Number((this.rStar + h).toFixed(2))];
  }

  /** 只有 KEEP 的段能走到这里。 */
  #absorb(frames, frameMs) {
    // ⛔ C1：冻结模式下一个字节都不许改。`ready` 由调用方在 apply 时置好。
    if (this.config.fixed) return;
    const usable = frames.filter((v) => v > SILENCE_DB);
    if (!usable.length) return;
    this.refValues.push(...usable);
    this.refMs += usable.length * frameMs;
    const cap = Math.ceil(this.config.reference_window_ms / frameMs);
    if (this.refValues.length > cap) {
      this.refValues.splice(0, this.refValues.length - cap);
      this.refMs = this.refValues.length * frameMs;
    }
    const sorted = [...this.refValues].sort((a, b) => a - b);
    // ⭐ p60 而不是众数：偏高一点是刻意的——主体说话人的能量分布上半段
    //   比下半段更少被背景污染，取 p60 让 band 更贴住「他在说话时」的层。
    const next = percentile(sorted, 0.6);
    this.rStar = this.rStar === null
      ? next
      : this.rStar + this.config.reference_ema * (next - this.rStar);
  }

  /**
   * 判一整段。
   * @param frames 该 segment 的逐帧 dB
   * @param frameMs 每帧毫秒
   */
  decide(frames, frameMs, meta = {}) {
    const c = this.config;
    const durationMs = frames.length * frameMs;
    const usable = frames.filter((v) => v > SILENCE_DB);
    const sorted = [...usable].sort((a, b) => a - b);
    const medianDb = percentile(sorted, 0.5);
    const modal = modalDb(usable, c.bin_db);

    const base = {
      segment_id: meta.segment_id ?? null,
      segment_duration_ms: durationMs,
      segment_median_rms_db: medianDb === null ? null : Number(medianDb.toFixed(2)),
      segment_modal_rms_db: modal?.db ?? null,
      modal_share: modal?.share ?? null,
      modal_prominence: modal?.prominence ?? null,
      reference_db: this.rStar === null ? null : Number(this.rStar.toFixed(2)),
      reference_band: this.band(),
      reference_ready: this.ready,
      reference_source: this.source,
      reference_sample_ms: this.refMs,
      time_in_reference_band_ms: 0,
      in_reference_band_ratio: 0,
    };

    // ⛔ 没准备好就一律放行，并且**照样吸收**——不这样的话参考永远建不起来。
    if (!this.ready) {
      this.#absorb(frames, frameMs);
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: 'reference_not_ready', at_ms: Date.now() };
      return this.lastDecision;
    }
    if (durationMs < c.min_segment_ms) {
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: 'segment_too_short_to_judge', at_ms: Date.now() };
      return this.lastDecision;
    }

    const [lo, hi] = this.band();
    const inBandFrames = frames.reduce((n, v) => n + (v >= lo && v <= hi ? 1 : 0), 0);
    const inBandMs = inBandFrames * frameMs;
    const ratio = durationMs ? inBandMs / durationMs : 0;
    base.time_in_reference_band_ms = inBandMs;
    base.in_reference_band_ratio = Number(ratio.toFixed(3));

    // ⭐ 「有没有足够的主体能量」——绝对累计为主，占比只用来救短段。
    //   ⛔ 反过来（长段只看占比）会把「电视声里说一句话」判掉，那是红线。
    const keep = inBandMs >= c.min_in_band_ms || ratio >= c.min_in_band_ratio;
    if (keep) {
      this.#absorb(frames, frameMs);
      this.keepCount += 1;
      this.lastDecision = { ...base, decision: 'KEEP', drop_reason: null,
                            keep_reason: inBandMs >= c.min_in_band_ms ? 'in_band_ms' : 'ratio',
                            at_ms: Date.now() };
    } else {
      this.dropCount += 1;
      // ⛔ 这里**没有** #absorb：DROP 段绝不更新 reference。
      this.lastDecision = {
        ...base,
        decision: 'DROP',
        keep_reason: null,
        drop_reason: medianDb !== null && medianDb < lo ? 'below_reference_band'
          : medianDb !== null && medianDb > hi ? 'above_reference_band'
            : 'insufficient_time_in_band',
        at_ms: Date.now(),
      };
    }
    return this.lastDecision;
  }

  snapshot() {
    return {
      schema: 'termux-os.speech-foreground-gate.v1',
      reference_ready: this.ready,
      reference_db: this.rStar === null ? null : Number(this.rStar.toFixed(2)),
      reference_band: this.band(),
      reference_source: this.source,
      reference_sample_ms: this.refMs,
      reference_min_ms: this.config.reference_min_ms,
      foreground_keep_count: this.keepCount,
      foreground_drop_count: this.dropCount,
      last_decision: this.lastDecision,
      config: { ...this.config },
      session_age_ms: Date.now() - this.startedAtMs,
    };
  }
}

/** s16le 单声道样本 → 逐帧 dB（窗 25 ms / 步 10 ms，与 VAD 同栅格）。 */
export function framesToDb(samples, sampleRate = 16000, frameMs = 10, windowMs = 25) {
  const hop = Math.round(sampleRate * frameMs / 1000);
  const win = Math.round(sampleRate * windowMs / 1000);
  const out = [];
  for (let start = 0; start + 1 < samples.length; start += hop) {
    const end = Math.min(samples.length, start + win);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      const v = samples[i] / 32768;
      sum += v * v;
    }
    const n = end - start;
    const rms = n > 0 ? Math.sqrt(sum / n) : 0;
    out.push(rms > 1e-9 ? 20 * Math.log10(rms) : SILENCE_DB);
  }
  return out;
}

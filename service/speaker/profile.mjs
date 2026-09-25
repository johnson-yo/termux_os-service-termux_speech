/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一串 CAM++ embedding（192 维）
 * [OUTPUT]: 对外提供「登记声纹 → 对一段音频打分 → KEEP/DROP」的纯逻辑
 * [POS]: docs/080 声纹门。⛔ 这里**没有任何 IO、没有模型、没有设备**，
 *        全部是可在 host 上毫秒级测的纯函数——判据长什么样，就该在这一层钉死。
 *
 * ⭐ 与 docs/079 的 RMS 门共用同一套安全语义，一条没松：
 *   · 没有登记声纹 ⇒ **KEEP**（`no_profile`），绝不因为「不知道你是谁」就丢掉；
 *   · 段太短（<`min_segment_ms`）⇒ **KEEP**（`too_short`），短段的 embedding 不可信；
 *   · 判定**永不**回写声纹——docs/078 的正反馈就是从「判定改参考」开始的。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const EMBEDDING_DIM = 192;

/** CAM++ profile identity shared with the Android App's fixed-window path. */
export const SPEAKER_ALGORITHM = Object.freeze({
  model_id: 'campplus',
  backend: 'htp',
  embedding_contract: 'campplus-htp-t148-v1',
  feature_protocol: 'campplus-kaldi-cmn-v1',
  window_ms: 1500,
  frames: 148,
  aggregation: 'sentence-window-unique-coverage-v1',
});

export const PROFILE_DEFAULTS = Object.freeze({
  /**
   * ⚠ 这是个**默认值，不是调出来的值**，而且真机已经证明它对「另一个说话人」不够：
   *   同音色 0.964–0.968 / **另一个音色 0.583–0.639**——两者分得开（间隔约 0.33），
   *   但 0.5 放行了后者，**PoC 定的 0.5703 同样放行**。这份材料下可用值在 0.8 附近。
   *
   * ⛔ 那为什么默认值仍然留在 0.5？因为**安全方向不对称**：
   *   偏低 ⇒ 别人被放进来（门没用，但不伤人）；偏高 ⇒ **使用者自己被丢掉**。
   *   默认值必须站在不伤人那一侧。真正的阈值由使用者**看着自己的分布**定，
   *   页面把分布摆出来就是为了这件事。
   */
  threshold: 0.5,
  /** 短于这么长的段不判（任务书 §4 的 TOO_SHORT 规则）。 */
  min_segment_ms: 1000,
  /** 至少要几段才允许生成声纹——一段就登记，等于把一次口误钉成身份。 */
  min_enrollments: 3,
});

export const l2norm = (v) => {
  const arr = Float64Array.from(v);
  let sum = 0;
  for (const x of arr) sum += x * x;
  const n = Math.sqrt(sum);
  if (!(n > 0)) return null;
  return Array.from(arr, (x) => x / n);
};

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  : null);

export const describe = (values) => {
  if (!values.length) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const r = (x) => (x === null ? null : Number(x.toFixed(4)));
  return {
    n: s.length, min: r(s[0]), p10: r(pct(s, 0.10)), p25: r(pct(s, 0.25)),
    p50: r(pct(s, 0.50)), p75: r(pct(s, 0.75)), p90: r(pct(s, 0.90)), max: r(s[s.length - 1]),
  };
};

export class SpeakerProfile {
  constructor(config = {}) {
    this.config = { ...PROFILE_DEFAULTS, ...config };
    this.algorithm = { ...SPEAKER_ALGORITHM };
    this.legacy = false;
    this.legacyReason = null;
    this.reset();
  }

  configure(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.config && Number.isFinite(Number(v))) this.config[k] = Number(v);
    }
    return this.config;
  }

  reset() {
    this.enrollments = [];       // { id, duration_ms, embedding(L2), metadata, at_ms }
    this.reference = null;       // L2 归一化后的平均
    this.builtAtMs = null;
    this.pairwise = [];
  }

  /** ⛔ 只在登记模式下调用。它**不会**自动生成声纹——生成必须是一次显式动作。 */
  addEnrollment(embedding, meta = {}) {
    const unit = l2norm(embedding);
    if (!unit || unit.length !== EMBEDDING_DIM) {
      return { ok: false, reason: 'bad_embedding' };
    }
    this.enrollments.push({
      id: meta.id ?? `enroll-${this.enrollments.length + 1}`,
      duration_ms: meta.duration_ms ?? null,
      embedding: unit,
      at_ms: Date.now(),
      window_count: Number.isFinite(Number(meta.window_count)) ? Number(meta.window_count) : null,
      valid_window_count: Number.isFinite(Number(meta.valid_window_count))
        ? Number(meta.valid_window_count) : null,
      vad_coverage: Number.isFinite(Number(meta.vad_coverage)) ? Number(meta.vad_coverage) : null,
      inference_ms: Number.isFinite(Number(meta.inference_ms)) ? Number(meta.inference_ms) : null,
      embedding_contract: meta.embedding_contract ?? this.algorithm.embedding_contract,
      feature_protocol: meta.feature_protocol ?? this.algorithm.feature_protocol,
      aggregation: meta.aggregation ?? this.algorithm.aggregation,
    });
    return { ok: true, count: this.enrollments.length };
  }

  removeEnrollment(id) {
    const before = this.enrollments.length;
    this.enrollments = this.enrollments.filter((e) => e.id !== id);
    return { ok: this.enrollments.length !== before, count: this.enrollments.length };
  }

  /**
   * 生成声纹：逐段 L2 → 平均 → 再 L2（官方做法）。
   * 同时算登记样本**两两之间**的 cosine——先确认登记素材自身一致，
   * 否则日后分数低时分不清是「模型不行」还是「登记就散了」。
   */
  build() {
    if (this.enrollments.length < this.config.min_enrollments) {
      return { ok: false, reason: 'not_enough_enrollments',
               have: this.enrollments.length, need: this.config.min_enrollments };
    }
    const dim = EMBEDDING_DIM;
    const mean = new Array(dim).fill(0);
    for (const e of this.enrollments) {
      for (let i = 0; i < dim; i += 1) mean[i] += e.embedding[i];
    }
    for (let i = 0; i < dim; i += 1) mean[i] /= this.enrollments.length;
    this.reference = l2norm(mean);
    this.builtAtMs = Date.now();
    this.pairwise = [];
    for (let i = 0; i < this.enrollments.length; i += 1) {
      for (let j = i + 1; j < this.enrollments.length; j += 1) {
        this.pairwise.push(Number(
          cosine(this.enrollments[i].embedding, this.enrollments[j].embedding).toFixed(4)));
      }
    }
    return { ok: true, n: this.enrollments.length, pairwise: describe(this.pairwise) };
  }

  clear() {
    this.reset();
    return { ok: true };
  }

  get ready() { return !this.legacy && Array.isArray(this.reference); }

  /**
   * 这份声纹的身份。⭐ 存在的理由只有一个：**阈值绑在 (声纹, 窗长) 上**，
   * 所以生产链必须能回答「使用者确认过的那个阈值，是不是给现在这份声纹定的」。
   * ⛔ 不用 `built_at_ms` 当身份——删掉再用同样的素材重建会得到同一份声纹却换一个时间，
   *   而**参考向量变了没有**才是这个问题真正要问的。
   * FNV-1a over 量化后的参考向量；纯计算，不引入 crypto。
   */
  get fingerprint() {
    if (!this.ready) return null;
    let h = 2166136261;
    for (const x of this.reference) {
      const v = Math.round(x * 1e6) | 0;
      h = Math.imul(h ^ (v & 0xffff), 16777619);
      h = Math.imul(h ^ ((v >>> 16) & 0xffff), 16777619);
    }
    return `spk-${(h >>> 0).toString(16)}-${this.enrollments.length}`;
  }

  /**
   * 只算相似度，不做判决——滑窗 USER-VAD 的判决在 `uservad.mjs` 里，
   * 那里的阈值与**窗长绑定**，与这里 `decide()` 用的段级阈值不是一回事。
   */
  score(embedding) {
    if (!this.ready) return null;
    const unit = l2norm(embedding);
    return unit === null ? null : Number(cosine(this.reference, unit).toFixed(4));
  }

  /**
   * 判一段。⛔ 不改动声纹，也不因为判定结果学习任何东西。
   * @param embedding 该段的 CAM++ embedding
   * @param durationMs 段时长
   */
  decide(embedding, durationMs, meta = {}) {
    const base = {
      id: meta.id ?? null,
      duration_ms: durationMs,
      threshold: this.config.threshold,
      similarity: null,
      at_ms: Date.now(),
    };
    if (durationMs < this.config.min_segment_ms) {
      return { ...base, verdict: 'KEEP', reason: 'too_short' };
    }
    if (!this.ready) {
      return { ...base, verdict: 'KEEP', reason: 'no_profile' };
    }
    const unit = l2norm(embedding);
    if (!unit) return { ...base, verdict: 'KEEP', reason: 'bad_embedding' };
    const sim = Number(cosine(this.reference, unit).toFixed(4));
    return {
      ...base,
      similarity: sim,
      verdict: sim >= this.config.threshold ? 'KEEP' : 'DROP',
      reason: sim >= this.config.threshold ? 'speaker_match' : 'other_speaker',
    };
  }

  toJSON() {
    return {
      version: 2,
      config: { ...this.config },
      algorithm: { ...this.algorithm },
      legacy: this.legacy,
      legacy_reason: this.legacyReason,
      built_at_ms: this.builtAtMs,
      reference: this.reference,
      pairwise: this.pairwise,
      enrollments: this.enrollments.map((e) => ({
        id: e.id, duration_ms: e.duration_ms, at_ms: e.at_ms, embedding: e.embedding,
        window_count: e.window_count, valid_window_count: e.valid_window_count,
        vad_coverage: e.vad_coverage, inference_ms: e.inference_ms,
        embedding_contract: e.embedding_contract, feature_protocol: e.feature_protocol,
        aggregation: e.aggregation,
      })),
    };
  }

  static fromJSON(raw) {
    const p = new SpeakerProfile(raw?.config ?? {});
    const algorithm = raw?.algorithm;
    const compatible = algorithm && Object.entries(SPEAKER_ALGORITHM).every(([key, expected]) => (
      algorithm[key] === expected
    ));
    if (!compatible) {
      p.legacy = true;
      p.legacyReason = 'profile_algorithm_missing_or_incompatible';
    } else {
      p.algorithm = { ...SPEAKER_ALGORITHM };
    }
    if (!p.legacy && Array.isArray(raw?.reference) && raw.reference.length === EMBEDDING_DIM) {
      p.reference = raw.reference;
      p.builtAtMs = raw.built_at_ms ?? null;
      p.pairwise = Array.isArray(raw.pairwise) ? raw.pairwise : [];
    }
    for (const e of raw?.enrollments ?? []) {
      if (Array.isArray(e?.embedding) && e.embedding.length === EMBEDDING_DIM) {
        p.enrollments.push({ id: e.id, duration_ms: e.duration_ms ?? null,
          embedding: e.embedding, at_ms: e.at_ms ?? null,
          window_count: e.window_count ?? null, valid_window_count: e.valid_window_count ?? null,
          vad_coverage: e.vad_coverage ?? null, inference_ms: e.inference_ms ?? null,
          embedding_contract: e.embedding_contract ?? null,
          feature_protocol: e.feature_protocol ?? null,
          aggregation: e.aggregation ?? null,
        });
      }
    }
    return p;
  }

  snapshot() {
    return {
      ready: this.ready,
      built_at_ms: this.builtAtMs,
      fingerprint: this.fingerprint,
      enrollment_count: this.enrollments.length,
      /**
       * ⭐ 每段对质心的相似度——**发现污染就靠它**。
       * 真机上踩过：背景连续说话时 VAD 切不出干净的登记段，五段里混进了背景，
       * pairwise 变成双峰（0.16 / 0.90），质心成了一团涂抹，对谁都不像。
       * 只看 pairwise 的汇总值只能知道「有问题」，看每段才知道**该删哪一段**。
       */
      enrollments: this.enrollments.map((e) => ({
        id: e.id, duration_ms: e.duration_ms,
        similarity_to_centroid: this.reference === null ? null
          : Number(cosine(this.reference, e.embedding).toFixed(4)),
      })),
      pairwise: describe(this.pairwise),
      config: { ...this.config },
      embedding_dim: EMBEDDING_DIM,
      algorithm: { ...this.algorithm },
      legacy: this.legacy,
      legacy_reason: this.legacyReason,
    };
  }
}

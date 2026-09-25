/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一句连续的 16 kHz PCM 样本与 FireRedVAD 的相对时间轴
 * [OUTPUT]: 固定 1.5 s CAM++ 窗、VAD 覆盖率和句内窗口聚合
 * [POS]: docs/132 P1。纯算法；不读文件、不调用 App、不改变登记状态。
 *
 * ⛔ CAM++ HTP 的输入契约只有这一种：24,000 samples → [1,148,80]。
 * 不足一窗不补零，长句只取完整窗；尾窗可以对齐到句尾，但重叠部分按唯一覆盖权重计一次。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const CAMPLUS_WINDOW_MS = 1_500;
export const CAMPLUS_WINDOW_SAMPLES = 24_000;
export const CAMPLUS_FRAMES = 148;
export const CAMPLUS_VAD_COVERAGE = 0.80;

const finite = (value) => Number.isFinite(Number(value));

const unionLength = (spans) => {
  const sorted = spans
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!sorted.length) return 0;
  let total = 0;
  let [start, end] = sorted[0];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart > end) {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    } else if (nextEnd > end) {
      end = nextEnd;
    }
  }
  return total + end - start;
};

const speechSpans = (vadFrames, threshold) => {
  const spans = [];
  let known = false;
  for (const frame of vadFrames ?? []) {
    const start = Number(frame?.start_ms);
    const end = Number(frame?.end_ms);
    const probability = Number(frame?.probability ?? frame?.prob ?? frame?.score);
    if (!(end > start) || !finite(probability)) continue;
    known = true;
    if (probability >= threshold) spans.push([start, end]);
  }
  return { known, spans };
};

/**
 * 生成不重复的完整固定窗。返回值保留所有候选，调用者可显示被覆盖率拒绝的原因。
 * `vad_frames` 的时间坐标必须从这句 PCM 的第一个 sample 开始。
 */
export const selectFixedWindows = ({
  sampleCount,
  vadFrames = [],
  vadThreshold = 0.60,
  minCoverage = CAMPLUS_VAD_COVERAGE,
} = {}) => {
  const n = Math.max(0, Math.floor(Number(sampleCount) || 0));
  if (n < CAMPLUS_WINDOW_SAMPLES) return [];

  const { known, spans } = speechSpans(vadFrames, Number(vadThreshold));
  const starts = [];
  for (let start = 0; start + CAMPLUS_WINDOW_SAMPLES <= n; start += CAMPLUS_WINDOW_SAMPLES) {
    starts.push(start);
  }
  const tail = n - CAMPLUS_WINDOW_SAMPLES;
  if (tail > starts.at(-1)) starts.push(tail);

  return starts.map((start) => {
    const end = start + CAMPLUS_WINDOW_SAMPLES;
    const startMs = start / 16;
    const endMs = end / 16;
    const speechMs = unionLength(spans.map(([a, b]) => [
      Math.max(startMs, a), Math.min(endMs, b),
    ]));
    const coverage = known ? speechMs / CAMPLUS_WINDOW_MS : null;
    const valid = known && coverage >= Number(minCoverage);
    return {
      start_sample: start,
      end_sample: end,
      start_ms: Math.round(startMs),
      end_ms: Math.round(endMs),
      coverage: coverage === null ? null : Number(coverage.toFixed(4)),
      coverage_known: known,
      valid,
      reason: !known ? 'vad_timeline_unavailable'
        : valid ? null : 'insufficient_vad_coverage',
    };
  });
};

const normalize = (embedding) => {
  if (!Array.isArray(embedding) || embedding.length !== 192) return null;
  let norm = 0;
  for (const value of embedding) {
    const x = Number(value);
    if (!Number.isFinite(x)) return null;
    norm += x * x;
  }
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const scale = Math.sqrt(norm);
  return embedding.map((value) => Number(value) / scale);
};

/**
 * 按所有保留窗口的 sample 区间做唯一覆盖计权。
 * 返回的 `weights` 与 `items` 一一对应，权重和等于窗口并集长度。
 */
export const coverageWeights = (items = []) => {
  const valid = items.map((item, index) => ({ item, index })).filter(({ item }) => (
    Number(item?.window?.end_sample) > Number(item?.window?.start_sample)
  ));
  const points = [...new Set(valid.flatMap(({ item }) => [
    Number(item.window.start_sample), Number(item.window.end_sample),
  ]))].sort((a, b) => a - b);
  const weights = Array(items.length).fill(0);
  let unionSamples = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (!(end > start)) continue;
    const covering = valid.filter(({ item }) => (
      Number(item.window.start_sample) <= start && Number(item.window.end_sample) >= end
    ));
    if (!covering.length) continue;
    unionSamples += end - start;
    const share = (end - start) / covering.length;
    for (const { index } of covering) weights[index] += share;
  }
  return { weights, union_samples: unionSamples };
};

/** 一句的多个固定窗只生成一个句级 embedding。 */
export const aggregateWindowEmbeddings = (items = []) => {
  const normalized = items.map((item) => ({
    ...item,
    embedding: normalize(item?.embedding),
  }));
  if (normalized.some((item) => item.embedding === null)) {
    return { ok: false, reason: 'bad_window_embedding' };
  }
  if (!normalized.length) return { ok: false, reason: 'no_valid_window' };
  const { weights, union_samples: unionSamples } = coverageWeights(normalized);
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return { ok: false, reason: 'no_unique_window_coverage' };
  const mean = Array(192).fill(0);
  for (let row = 0; row < normalized.length; row += 1) {
    const weight = weights[row];
    for (let i = 0; i < mean.length; i += 1) {
      mean[i] += normalized[row].embedding[i] * weight;
    }
  }
  const embedding = normalize(mean.map((value) => value / total));
  if (!embedding) return { ok: false, reason: 'bad_aggregate_embedding' };
  return {
    ok: true,
    embedding,
    window_count: normalized.length,
    union_samples: unionSamples,
    weights: weights.map((value) => Number(value.toFixed(3))),
  };
};

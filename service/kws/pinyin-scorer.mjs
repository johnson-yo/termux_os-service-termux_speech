/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Voice-enrolled pinyin token sequences and one live query token sequence.
 * [OUTPUT]: Template construction plus a continuous 0..1 approximate-substring coverage score.
 * [POS]: KWS matching core migrated from Wake Words 0.5.0; it owns no PCM, model, runtime, or transport.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const COMBINING = /[̀-ͯ]/g;
const HAS_VOWEL = /[aeiouv]/;

export function toneStrip(value) {
  return String(value).normalize('NFD').replace(COMBINING, '').toLowerCase();
}

export function pinyinStr(tokens) {
  return toneStrip((tokens ?? []).join('')).replace(/[^a-z]/g, '');
}

export function pinyinWeightedStr(tokens, initialWeight = 2) {
  let output = '';
  for (const token of tokens ?? []) {
    const normalized = toneStrip(token).replace(/[^a-z]/g, '');
    if (!normalized) continue;
    output += HAS_VOWEL.test(normalized)
      ? normalized
      : normalized.repeat(Math.max(1, initialWeight | 0));
  }
  return output;
}

export function subCoverage(pattern, text) {
  const patternLength = pattern.length;
  const textLength = text.length;
  if (!patternLength) return 1;
  if (!textLength) return 0;
  let previous = new Array(textLength + 1).fill(0);
  for (let i = 1; i <= patternLength; i += 1) {
    const current = new Array(textLength + 1);
    current[0] = i;
    for (let j = 1; j <= textLength; j += 1) {
      current[j] = Math.min(
        previous[j - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1),
        previous[j] + 1,
        current[j - 1] + 1,
      );
    }
    previous = current;
  }
  return 1 - Math.min(...previous) / patternLength;
}

const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function buildTemplates(candidates, { initialWeight = 2 } = {}) {
  const items = (candidates ?? [])
    .map((candidate) => ({
      ...candidate,
      py: pinyinWeightedStr(
        candidate.tokens || candidate.keyword?.split(' ') || [],
        initialWeight,
      ),
    }))
    .filter((candidate) => candidate.py.length >= 3);
  const unique = [];
  const seen = new Set();
  for (const candidate of items) {
    if (seen.has(candidate.py)) continue;
    seen.add(candidate.py);
    unique.push(candidate);
  }
  if (!unique.length) {
    return {
      templates: [],
      representative: null,
      consistency: 0,
      syllables: 0,
      initialWeight,
      dropped: [],
    };
  }

  const lengths = unique.map((candidate) => candidate.py.length).sort((a, b) => a - b);
  const medianLength = lengths[lengths.length >> 1];
  const minimumLength = Math.max(3, medianLength * 0.7);
  const kept = unique.filter((candidate) => candidate.py.length >= minimumLength);
  const dropped = unique.filter((candidate) => candidate.py.length < minimumLength);
  const similarity = (a, b) => {
    const maximum = Math.max(a.length, b.length);
    return maximum ? 1 - levenshtein(a, b) / maximum : 1;
  };

  let representativeIndex = 0;
  let bestAverage = -1;
  for (let i = 0; i < kept.length; i += 1) {
    const average = kept.length === 1
      ? 1
      : kept.reduce((sum, candidate, j) => (
        sum + (j === i ? 0 : similarity(kept[i].py, candidate.py))
      ), 0) / (kept.length - 1);
    if (average > bestAverage) {
      bestAverage = average;
      representativeIndex = i;
    }
  }

  const pairwise = kept.flatMap((candidate, i) => kept
    .filter((_, j) => j !== i)
    .map((other) => similarity(candidate.py, other.py)));
  const consistency = kept.length <= 1 ? 1 : Math.round(median(pairwise) * 100) / 100;
  const representative = kept[representativeIndex] ?? null;
  const syllables = representative
    ? (pinyinStr(representative.tokens || []).match(/[aeiouv]+/g) || []).length
    : 0;

  return {
    templates: kept.map((candidate) => ({
      index: candidate.index,
      text: candidate.text,
      py: candidate.py,
    })),
    representative: representative ? { text: representative.text } : null,
    consistency,
    syllables,
    initialWeight,
    dropped: dropped.map((candidate) => ({ index: candidate.index, text: candidate.text })),
  };
}

export function scorePinyin(templates, queryTokens, { initialWeight = 2 } = {}) {
  const query = pinyinWeightedStr(queryTokens, initialWeight);
  if (!query) return { score: 0, query, best: null };
  let bestScore = 0;
  let bestTemplate = null;
  for (const template of templates ?? []) {
    const score = subCoverage(template.py, query);
    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }
  return {
    score: Math.round(bestScore * 1000) / 1000,
    query,
    best: bestTemplate
      ? { index: bestTemplate.index, text: bestTemplate.text }
      : null,
  };
}

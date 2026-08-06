/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package-private v4 configuration path plus an optional v3/v2 migration source.
 * [OUTPUT]: Mode-0600 RMS, KWS/cue, VAD Pool, and ASR ending configuration with atomic updates.
 * [POS]: The only persistent configuration owned by Termux Speech.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  schema: 'termux-os-framework.termux-speech.conf.v4',
  enabled: true,
  poll_interval_ms: 2000,
  /**
   * 停链是使用者的决定，服务重启不该替他撤销它（docs/061 §三.1）。
   * ⚠ 但重启**绝不**因此 undeclare：启动时按 App 的真实常驻列表对账，不 churn 会话。
   */
  chain_desired: 'started',
  /** 听写 requester 全部释放后，VAD+ASR 保温多久才卸载（docs/061 §二.5）。 */
  dictation_warm_timeout_seconds: 300,
  /**
   * ⭐ 三张 HTP 图（KWS/VAD/ASR）的常驻策略。默认 **`service`**：服务起来就挂着，
   * 服务在就一直在。
   *
   * 理由是**闲置常驻几乎不要钱**：图不用时匿名页被内核换进 ZRAM，物理驻留极小
   * （docs/046 §6 实测闲置 12 分钟后匿名堆只剩 3.5 MB，换回是惰性的）。
   * 而反复 load/unload 是真花钱——ORT-QNN 的分配器高水位只增不减（docs/053：churn 过的
   * ort_worker 在 **0 个 session 时仍占 612 MB**，`unload` 治不了，只在进程退出时归还），
   * 本轮真机上几轮 churn 就把 ort_rss 从 220 推到 692 MB。
   * **为省内存而周期性卸载，净效果是费内存**；顺带还让每次唤醒多付约 2.5 秒。
   *
   * 取值：
   *   `service` 服务在就一直挂着——停链与保温到期都不卸（默认）
   *   `chain`   停链时卸载；保温到期不卸（唤醒组还守着，随时会叫醒它）
   *   `warm`    docs/061 §二.5 的严格语义：停链与保温到期都卸
   */
  graph_residency: 'service',
  rms_gate: {
    open_threshold: 0.05,
    sample_interval_ms: 200,
  },
  kws: {
    active_profile_id: null,
    idle_timeout_ms: 15_000,
    cue_enabled: true,
    positive_target: 6,
    score_threshold: 0.8,
    initial_weight: 2,
  },
  vad: {
    pcm_pool_ms: 6000,
    no_output_timeout_ms: 15_000,
  },
  asr: {
    enabled: true,
    // 轉寫模型。sensevoice = 既有常駐 HTP 圖（快、省記憶體）；
    // qwen3-q4 / qwen3-q8 = App 的 /api/asr 端到端（更準、更多語言，但峰值記憶體高得多）。
    // 實測峰值：sensevoice 1210MB / qwen3-q4 1899MB / qwen3-q8 2037MB（htp/asr/CLAUDE.md）。
    model: 'sensevoice',
    language: 'auto',
    text_normalization: true,
    keyword_end_enabled: true,
    end_keywords: ['结束'],
    timeout_end_enabled: true,
    idle_timeout_ms: 15_000,
    output_name: null,
  },
};

const bounded = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const normalizeGate = (value = {}) => {
  return {
    open_threshold: bounded(
      value.open_threshold,
      DEFAULTS.rms_gate.open_threshold,
      0.001,
      1,
    ),
    sample_interval_ms: Math.round(bounded(
      value.sample_interval_ms,
      DEFAULTS.rms_gate.sample_interval_ms,
      100,
      1000,
    )),
  };
};

const normalizeKws = (value = {}) => ({
  active_profile_id: typeof value.active_profile_id === 'string' && value.active_profile_id
    ? value.active_profile_id
    : null,
  idle_timeout_ms: Math.round(bounded(
    value.idle_timeout_ms,
    DEFAULTS.kws.idle_timeout_ms,
    1000,
    60_000,
  )),
  cue_enabled: value.cue_enabled !== false,
  positive_target: Math.round(bounded(
    value.positive_target,
    DEFAULTS.kws.positive_target,
    1,
    20,
  )),
  score_threshold: bounded(
    value.score_threshold,
    DEFAULTS.kws.score_threshold,
    0.3,
    0.98,
  ),
  initial_weight: Math.round(bounded(
    value.initial_weight,
    DEFAULTS.kws.initial_weight,
    1,
    4,
  )),
});

const normalizeVad = (value = {}) => ({
  pcm_pool_ms: Math.round(bounded(
    value.pcm_pool_ms,
    DEFAULTS.vad.pcm_pool_ms,
    500,
    6000,
  )),
  no_output_timeout_ms: Math.round(bounded(
    value.no_output_timeout_ms,
    DEFAULTS.vad.no_output_timeout_ms,
    1000,
    60_000,
  )),
  // ⛔ `max_saved_wavs` 已删除（docs/061 §七）。WAV 的保留量现在由记录组回答：
  // 盘上稳定态最多两组、每组 50 条，更旧的先归档进 SQLite 再删。
});

const normalizeKeywords = (value) => {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(/[,，\n]/) : DEFAULTS.asr.end_keywords;
  return [...new Set(source
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((item) => item.slice(0, 64)))];
};

export const ASR_MODELS = ['sensevoice', 'qwen3-q4', 'qwen3-q8'];

const normalizeAsr = (value = {}) => ({
  enabled: value.enabled !== false,
  model: ASR_MODELS.includes(value.model) ? value.model : DEFAULTS.asr.model,
  language: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(value.language)
    ? value.language
    : DEFAULTS.asr.language,
  text_normalization: value.text_normalization !== false,
  keyword_end_enabled: value.keyword_end_enabled !== false,
  end_keywords: normalizeKeywords(value.end_keywords),
  timeout_end_enabled: value.timeout_end_enabled !== false,
  idle_timeout_ms: Math.round(bounded(
    value.idle_timeout_ms,
    DEFAULTS.asr.idle_timeout_ms,
    1000,
    120_000,
  )),
  // SenseVoice 的 CTC 输出名（`ctc_logits` 或 `_ctc_logits`）是**模型的静态属性**。
  // 记住它，App 常驻声明就能一次带对 heal，探名仪式永久消失（docs/054 §4.4）。
  // 不是用户可调项：不进设置页，只由首次探测写入。
  output_name: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(value.output_name ?? ''))
    ? String(value.output_name)
    : null,
});

const readSaved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const atomicWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Best effort on filesystems without modes. */ }
};

const normalizeConfig = (raw = {}) => ({
  ...raw,
  schema: DEFAULTS.schema,
  enabled: raw.enabled !== false,
  poll_interval_ms: Math.round(bounded(
    raw.poll_interval_ms,
    DEFAULTS.poll_interval_ms,
    500,
    10_000,
  )),
  chain_desired: raw.chain_desired === 'stopped' ? 'stopped' : DEFAULTS.chain_desired,
  graph_residency: ['service', 'chain', 'warm'].includes(raw.graph_residency)
    ? raw.graph_residency
    : DEFAULTS.graph_residency,
  // 0 = 不保温（释放即卸载）。上界一小时：保温本身要占着 VAD+ASR 两张图。
  dictation_warm_timeout_seconds: Math.round(bounded(
    raw.dictation_warm_timeout_seconds,
    DEFAULTS.dictation_warm_timeout_seconds,
    0,
    3600,
  )),
  rms_gate: normalizeGate(raw.rms_gate),
  kws: normalizeKws(raw.kws),
  vad: normalizeVad(raw.vad),
  asr: normalizeAsr(raw.asr),
});

const migrateLegacy = (legacy = {}) => normalizeConfig({
  enabled: legacy.enabled,
  poll_interval_ms: legacy.poll_interval_ms,
  rms_gate: {
    open_threshold: legacy.rms_gate?.open_threshold,
    sample_interval_ms: legacy.rms_gate?.sample_interval_ms,
  },
  kws: {
    ...DEFAULTS.kws,
    ...legacy.kws,
  },
  vad: {
    ...DEFAULTS.vad,
    ...legacy.vad,
  },
  asr: {
    ...DEFAULTS.asr,
    ...legacy.asr,
  },
});

export function loadConfig(file, legacyFile = null) {
  if (!fs.existsSync(file)) {
    const initial = legacyFile && fs.existsSync(legacyFile)
      ? migrateLegacy(readSaved(legacyFile))
      : normalizeConfig(DEFAULTS);
    atomicWrite(file, initial);
  } else {
    const saved = readSaved(file);
    if (saved.schema !== DEFAULTS.schema) {
      const source = legacyFile && fs.existsSync(legacyFile)
        ? readSaved(legacyFile)
        : saved;
      atomicWrite(file, migrateLegacy(source));
    }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Best effort on filesystems without modes. */ }
  return normalizeConfig(readSaved(file));
}

/** 生命周期配置：停链意图与保温时长。两者都必须跨服务重启存活。 */
export function saveLifecycleConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  if (patch.chain_desired !== undefined
    && !['started', 'stopped'].includes(patch.chain_desired)) {
    throw new RangeError('chain_desired must be "started" or "stopped"');
  }
  if (patch.graph_residency !== undefined
    && !['service', 'chain', 'warm'].includes(patch.graph_residency)) {
    throw new RangeError('graph_residency must be "service", "chain" or "warm"');
  }
  if (patch.dictation_warm_timeout_seconds !== undefined) {
    const value = Number(patch.dictation_warm_timeout_seconds);
    if (!Number.isFinite(value)) {
      throw new RangeError('dictation_warm_timeout_seconds must be a finite number');
    }
    if (value < 0 || value > 3600) {
      throw new RangeError('dictation_warm_timeout_seconds must be between 0 and 3600');
    }
  }
  atomicWrite(file, normalizeConfig({ ...raw, ...patch }));
  return loadConfig(file);
}

export function saveRmsGateConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeGate(raw.rms_gate);
  const candidate = { ...current, ...patch };
  for (const key of ['open_threshold']) {
    if (patch[key] !== undefined && !Number.isFinite(Number(patch[key]))) {
      throw new RangeError(`${key} must be a finite number`);
    }
  }
  const next = normalizeGate(candidate);
  if (Number(candidate.open_threshold) !== next.open_threshold) {
    throw new RangeError('RMS Gate OPEN threshold is outside its supported range');
  }
  const saved = normalizeConfig({ ...raw, rms_gate: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

export function saveKwsConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeKws(raw.kws);
  const candidate = { ...current, ...patch };
  if (patch.active_profile_id !== undefined
    && patch.active_profile_id !== null
    && (typeof patch.active_profile_id !== 'string' || !patch.active_profile_id)) {
    throw new RangeError('active_profile_id must be a non-empty string or null');
  }
  if (patch.idle_timeout_ms !== undefined
    && !Number.isFinite(Number(patch.idle_timeout_ms))) {
    throw new RangeError('idle_timeout_ms must be a finite number');
  }
  if (patch.cue_enabled !== undefined && typeof patch.cue_enabled !== 'boolean') {
    throw new RangeError('cue_enabled must be boolean');
  }
  const next = normalizeKws(candidate);
  if (Number(candidate.idle_timeout_ms) !== next.idle_timeout_ms) {
    throw new RangeError('KWS countdown is outside its supported range');
  }
  const saved = normalizeConfig({ ...raw, kws: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

export function saveVadConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeVad(raw.vad);
  const candidate = { ...current, ...patch };
  for (const key of ['pcm_pool_ms', 'no_output_timeout_ms']) {
    if (patch[key] !== undefined && !Number.isFinite(Number(patch[key]))) {
      throw new RangeError(`${key} must be a finite number`);
    }
  }
  const next = normalizeVad(candidate);
  if (Number(candidate.pcm_pool_ms) !== next.pcm_pool_ms) {
    throw new RangeError('PCM Pool must be between 500 and 6000 ms');
  }
  if (Number(candidate.no_output_timeout_ms) !== next.no_output_timeout_ms) {
    throw new RangeError('VAD countdown is outside its supported range');
  }
  const saved = normalizeConfig({ ...raw, vad: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

export function saveAsrConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeAsr(raw.asr);
  const candidate = { ...current, ...patch };
  for (const key of [
    'enabled',
    'text_normalization',
    'keyword_end_enabled',
    'timeout_end_enabled',
  ]) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new RangeError(`${key} must be boolean`);
    }
  }
  if (patch.language !== undefined
    && !['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(patch.language)) {
    throw new RangeError('unsupported SenseVoice language');
  }
  if (patch.end_keywords !== undefined
    && !Array.isArray(patch.end_keywords)
    && typeof patch.end_keywords !== 'string') {
    throw new RangeError('end_keywords must be an array or comma-separated string');
  }
  if (patch.idle_timeout_ms !== undefined
    && !Number.isFinite(Number(patch.idle_timeout_ms))) {
    throw new RangeError('ASR idle_timeout_ms must be a finite number');
  }
  const next = normalizeAsr(candidate);
  if (Number(candidate.idle_timeout_ms) !== next.idle_timeout_ms) {
    throw new RangeError('ASR countdown is outside its supported range');
  }
  const saved = normalizeConfig({ ...raw, asr: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

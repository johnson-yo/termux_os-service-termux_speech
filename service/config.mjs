/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package-private v4 configuration path plus an optional v3/v2 migration source.
 * [OUTPUT]: Mode-0600 RMS, FireRedVAD Pool, ASR, and speaker-activity configuration with atomic updates.
 * [POS]: The only persistent configuration owned by Termux Speech.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { normalizeSpeakerGate } from './speaker/gate.mjs';
import { normalizeActivityConfig } from './speaker/activity-fsm.mjs';

import { SPEECH2_INPUT_SOURCES } from './speech2.mjs';
const DEFAULTS = {
  schema: 'termux-os-framework.termux-speech.conf.v4',
  enabled: true,
  poll_interval_ms: 2000,
  /**
   * ⭐ CP-SPEECH2-WEBUI18：Speech2 是唯一产品后端。Start 时由本包启动的 App AudioRing 输入源。
   *   ⛔ 不是旧 PersistentMic 的 input_device（那条链已退出产品面）。
   */
  speech2: { input_source: 'SYSTEM_BUILTIN_MIC' },
  /**
   * 停链是使用者的决定，服务重启不该替他撤销它（docs/061 §三.1）。
   * ⚠ 但重启**绝不**因此 undeclare：启动时按 App 的真实常驻列表对账，不 churn 会话。
   */
  chain_desired: 'started',
  /** 听写 requester 全部释放后，VAD+ASR 保温多久才卸载（docs/061 §二.5）。 */
  dictation_warm_timeout_seconds: 300,
  /**
   * ⭐ VAD/ASR 图的常驻策略。默认 **`service`**：服务起来就挂着，
   * 服务在就一直在。
   *
   * 理由是**闲置常驻几乎不要钱**：图不用时匿名页被内核换进 ZRAM，物理驻留极小
   * （docs/046 §6 实测闲置 12 分钟后匿名堆只剩 3.5 MB，换回是惰性的）。
   * 而反复 load/unload 是真花钱——ORT-QNN 的分配器高水位只增不减（docs/053：churn 过的
   * ort_worker 在 **0 个 session 时仍占 612 MB**，`unload` 治不了，只在进程退出时归还），
   * 本轮真机上几轮 churn 就把 ort_rss 从 220 推到 692 MB。
   * **为省内存而周期性卸载，净效果是费内存**；顺带还让每次重新进入处理多付约 2.5 秒。
   *
   * 取值：
   *   `service` 服务在就一直挂着——停链与保温到期都不卸（默认）
   *   `chain`   停链时卸载；保温到期不卸
   *   `warm`    docs/061 §二.5 的严格语义：停链与保温到期都卸
   */
  graph_residency: 'service',
  /**
   * docs/076：SenseVoice 侧的主体音量层 gate。默认开启是为了让使用者在真实环境里踩它；
   * ⛔ 关掉必须**立刻**恢复原行为，故它只是一个布尔，没有别的状态挂在上面。
   */
  foreground_gate_enabled: true,
  /**
   * docs/079：`relative` = 双参考单侧阈值（会话内自动校准两个参考层，默认）；
   * `absolute` = docs/076 的 `R*±6` 旧 band，只作回退。
   */
  foreground_gate_mode: 'relative',
  /**
   * docs/081：CAM++ 滑窗 USER-VAD 前景门。⛔ 默认 OFF，关掉必须**逐字**恢复旧行为。
   *
   * ⭐ 它与上面那个 RMS 前景门是**互斥的权威**，不是串联的两道门：
   *   开着时由声纹判段（`foreground_authority = 'speaker'`），RMS 那条完全不参与。
   *   两个 DROP gate 串起来只会互相制造误杀，而查起来分不清是谁丢的（任务书 §十四）。
   * ⚠ 阈值/窗长**不在这里**——那是 Speaker Lab 的校准结果，生产链只读不存第二份。
   */
  speaker_gate: {
    enabled: false,
    min_coverage: 0.5,
    rms_activity: 0.008,
    inference_timeout_ms: 3000,
    timeline_ms: 120_000,
  },
  /**
   * docs/083：CAM++ 目标说话人活动状态机的 **shadow** 链。⛔ 默认 OFF。
   * OFF 时不产生任何 CAM++ 工作、不留 mic holder，普通 FireRedVAD/ASR 行为逐字不变。
   * ⚠ 参数来自 `PoC/campplus-activity-fsm`（`CAMPLUS_TARGET_ACTIVITY_GO=1`），本轮不重调；
   *   尤其 `step_ms` 保持 250——实测 500 会让 1 秒的讲话从 3/3 掉到 1/3。
   */
  /**
   * 正式 CAM++VAD（常驻说话人切段）。⛔ 默认关：它要一张 HTP ctx，
   * 而本机 HTP 会话预算很紧——打开它是使用者的决定，不是默认值的决定。
   */
  speaker_activity: {
    enabled: false,
    /**
     * ⭐ docs/087 P3 的**开发态执行器开关**（⛔ 普通用户设置面不暴露）：
     *   `app`          = CAM++ 的高频执行在 App 内（正式新路径）；
     *   `legacy_speech` = 仍由本包执行（回退）；
     *   `shadow`       = 两边都跑，但只有 legacy 驱动产品行为（只做对照）。
     * ⚠ 默认 `app`：P3 的验收标准就是「默认切到 App executor 并保留开发态回退」。
     */
    executor: 'app',
  },
  target_activity_shadow: {
    enabled: false,
    window_ms: 1500,
    step_ms: 250,
    enter_threshold: 0.40,
    exit_threshold: 0.35,
    enter_confirm: 2,
    exit_confirm: 2,
    pre_roll_ms: 500,
    post_roll_ms: 400,
    intra_pause_grace_ms: 1200,
    vad_gates_speaker: true,
    keep_events: 30,
  },
  rms_gate: {
    open_threshold: 0.05,
    sample_interval_ms: 200,
  },
  vad: {
    /** 当前唯一 VAD 执行方：CAM++ 或 FireRedVAD；两种模式不并行。 */
    provider: 'campplus',
    pcm_pool_ms: 6000,
    no_output_timeout_ms: 15_000,
  },
  asr: {
    enabled: true,
    /**
     * ASR 引擎。当前产品只有 SenseVoice 一个正式值；选择值直接决定
     * WAV 交给哪条 App 正式转写 endpoint。
     */
    model: 'sensevoice',
    language: 'auto',
    text_normalization: true,
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

const normalizeVad = (value = {}) => ({
  provider: ['campplus', 'camplus'].includes(String(value.provider ?? '').toLowerCase())
    ? 'campplus'
    : String(value.provider ?? '').toLowerCase() === 'fireredvad'
      ? 'fireredvad'
      : DEFAULTS.vad.provider,
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

export const ASR_MODELS = ['sensevoice'];
/**
 * 下线的旧值：读到就迁移到默认值并**警告一次**，不静默、不崩、不偷偷跑旧后端。
 * ⚠ `audio8` 随 App 0.25.x 退役——它那条链的 App 端点（`/api/asr/audio8/*`）**已被删除**，
 *   所以一个还存着 `audio8` 的设备如果不迁移，会去调一个不存在的端点，
 *   ⭐ 而那个失败看起来像「转写坏了」，不像「这个后端已经没有了」。
 */
export const ASR_DEPRECATED_MODELS = ['qwen3-q4', 'qwen3-q8', 'audio8'];
/** 迁移是否已经警告过——只提醒一次，不要每次读配置都刷屏。 */
let deprecationWarned = false;

/**
 * 把配置里的 ASR 引擎收敛到当前产品值。
 * @returns {{ model: string, migratedFrom: string|null }}
 */
export function resolveAsrModel(value, fallback = DEFAULTS.asr.model) {
  if (ASR_MODELS.includes(value)) return { model: value, migratedFrom: null };
  if (ASR_DEPRECATED_MODELS.includes(value)) {
    if (!deprecationWarned) {
      deprecationWarned = true;
      console.warn(`[termux-speech] ASR engine "${value}" has been retired; `
        + `falling back to "${fallback}".`);
    }
    return { model: fallback, migratedFrom: value };
  }
  return { model: fallback, migratedFrom: value === undefined ? null : String(value) };
}

const normalizeAsr = (value = {}) => ({
  enabled: value.enabled !== false,
  model: resolveAsrModel(value.model).model,
  language: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(value.language)
    ? value.language
    : DEFAULTS.asr.language,
  text_normalization: value.text_normalization !== false,
  /** ⚠ 白名单投影：不在这里的字段读不出去（`model` 曾栽在这条上）。 */
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
  schema: DEFAULTS.schema,
  enabled: raw.enabled !== false,
  poll_interval_ms: Math.round(bounded(
    raw.poll_interval_ms,
    DEFAULTS.poll_interval_ms,
    500,
    10_000,
  )),
  chain_desired: raw.chain_desired === 'stopped' ? 'stopped' : DEFAULTS.chain_desired,
  speech2: {
    input_source: SPEECH2_INPUT_SOURCES.includes(raw.speech2?.input_source)
      ? raw.speech2.input_source : DEFAULTS.speech2.input_source,
  },
  /**
   * ⭐ docs/096：使用者想要的 App 三层 Pipeline（**desired，⛔ 不是 effective**）。
   * ⚠ `normalizeConfig` 是**白名单**——它重建一个只含已知键的新对象。
   *   不在这里登记的键会被**静默丢掉**：保存不报错，读回来就是没有。
   */
  pipeline: {
    // ⭐ WEBUI18：旧 App pipeline 已退出产品面；存盘值只剩三项（旧的第四项读回即归 stop）。
    trigger: ['stop', 'passthrough', 'volume'].includes(raw.pipeline?.trigger)
      ? raw.pipeline.trigger : 'stop',
    /**
     * ⭐ docs/099：`camplus` 作为独立断句器已退役 ⇒ 规范化成 `fireredvad_camplus`。
     * ⚠ **必须继续读得懂旧值**：conf 里存着的就是它，认不出会让一次重启把人挡在门外。
     */
    segment: (() => {
      const raw0 = raw.pipeline?.segment;
      const canonical = raw0 === 'camplus' ? 'fireredvad_camplus' : raw0;
      return ['fireredvad', 'fireredvad_camplus'].includes(canonical) ? canonical : 'fireredvad';
    })(),
    /** ⚠ 与 [resolveAsrModel] 同一条规则：认不出的（含已退役的 `audio8`）一律回默认值。 */
    asr: ASR_MODELS.includes(raw.pipeline?.asr) ? raw.pipeline.asr : 'sensevoice',
  },
  graph_residency: ['service', 'chain', 'warm'].includes(raw.graph_residency)
    ? raw.graph_residency
    : DEFAULTS.graph_residency,
  foreground_gate_enabled: raw.foreground_gate_enabled !== false,
  foreground_gate_mode: raw.foreground_gate_mode === 'absolute' ? 'absolute' : 'relative',
  speaker_gate: normalizeSpeakerGate(raw.speaker_gate ?? DEFAULTS.speaker_gate),
  speaker_activity: {
    enabled: raw.speaker_activity?.enabled === true,
    executor: ['app', 'legacy_speech', 'shadow'].includes(raw.speaker_activity?.executor)
      ? raw.speaker_activity.executor
      : DEFAULTS.speaker_activity.executor,
  },
  target_activity_shadow: {
    ...normalizeActivityConfig(raw.target_activity_shadow ?? DEFAULTS.target_activity_shadow),
    enabled: (raw.target_activity_shadow ?? DEFAULTS.target_activity_shadow).enabled === true,
  },
  // 0 = 不保温（释放即卸载）。上界一小时：保温本身要占着 VAD+ASR 两张图。
  dictation_warm_timeout_seconds: Math.round(bounded(
    raw.dictation_warm_timeout_seconds,
    DEFAULTS.dictation_warm_timeout_seconds,
    0,
    3600,
  )),
  rms_gate: normalizeGate(raw.rms_gate),
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
  const saved = readSaved(file);
  const normalized = normalizeConfig(saved);
  // Each load is also a schema-boundary cleanup. This removes fields from
  // retired versions even when the schema number itself is still current.
  if (JSON.stringify(saved) !== JSON.stringify(normalized)) atomicWrite(file, normalized);
  return normalized;
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

export function saveVadConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeVad(raw.vad);
  const candidate = { ...current, ...patch };
  if (patch.provider !== undefined
    && !['campplus', 'camplus', 'fireredvad'].includes(String(patch.provider).toLowerCase())) {
    throw new RangeError('VAD provider must be campplus or fireredvad');
  }
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
  ]) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new RangeError(`${key} must be boolean`);
    }
  }
  if (patch.language !== undefined
    && !['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(patch.language)) {
    throw new RangeError('unsupported ASR language');
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

/**
 * docs/081 声纹前景门。⚠ 这里**不存**阈值/窗长——那是 Speaker Lab 的校准结果，
 * 生产链只读。存第二份的后果在 docs/056 已经付过一次：读得出值、对不上、答案错得很安静。
 */
export function saveSpeakerGateConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = normalizeSpeakerGate(raw.speaker_gate);
  for (const key of ['enabled']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new RangeError(`${key} must be boolean`);
    }
  }
  for (const key of ['min_coverage', 'rms_activity', 'inference_timeout_ms', 'timeline_ms']) {
    if (patch[key] !== undefined && !Number.isFinite(Number(patch[key]))) {
      throw new RangeError(`${key} must be a finite number`);
    }
  }
  const candidate = { ...current, ...patch };
  const next = normalizeSpeakerGate(candidate);
  for (const key of ['min_coverage', 'rms_activity', 'inference_timeout_ms', 'timeline_ms']) {
    if (patch[key] !== undefined && Number(candidate[key]) !== Number(next[key])) {
      throw new RangeError(`speaker gate ${key} is outside its supported range`);
    }
  }
  const saved = normalizeConfig({ ...raw, speaker_gate: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

/**
 * 正式 CAM++VAD 的开关。⛔ 只有一个字段：窗长/阈值/裁剪都是实测定下来的默认值，
 * 改它们属于调参界面，不属于这个开关。
 */
export function saveSpeakerActivityConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new RangeError('enabled must be boolean');
  }
  if (patch.executor !== undefined
      && !['app', 'legacy_speech', 'shadow'].includes(patch.executor)) {
    throw new RangeError('executor must be app / legacy_speech / shadow');
  }
  const current = raw.speaker_activity ?? {};
  const saved = normalizeConfig({
    ...raw,
    speaker_activity: {
      // ⚠ 只改被指名的那个字段：`enabled` 与 `executor` 是两个独立的决定，
      //   一次调用把另一个悄悄重置回默认值，是使用者看不见的配置丢失。
      enabled: patch.enabled === undefined ? current.enabled === true : patch.enabled === true,
      executor: patch.executor ?? current.executor,
    },
  });
  atomicWrite(file, saved);
  return loadConfig(file);
}

/** docs/083 shadow 链的开关与参数。⛔ 它不参与任何正式判决。 */
export function saveActivityShadowConfig(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  const current = { ...normalizeActivityConfig(raw.target_activity_shadow),
                    enabled: raw.target_activity_shadow?.enabled === true };
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new RangeError('enabled must be boolean');
  }
  if (patch.vad_gates_speaker !== undefined && typeof patch.vad_gates_speaker !== 'boolean') {
    throw new RangeError('vad_gates_speaker must be boolean');
  }
  const candidate = { ...current, ...patch };
  const next = { ...normalizeActivityConfig(candidate),
                 enabled: candidate.enabled === true };
  for (const key of ['window_ms', 'step_ms', 'enter_threshold', 'exit_threshold',
    'enter_confirm', 'exit_confirm', 'pre_roll_ms', 'post_roll_ms', 'intra_pause_grace_ms']) {
    if (patch[key] !== undefined && Number(candidate[key]) !== Number(next[key])) {
      throw new RangeError(`target_activity_shadow ${key} is outside its supported range`);
    }
  }
  const saved = normalizeConfig({ ...raw, target_activity_shadow: next });
  atomicWrite(file, saved);
  return loadConfig(file);
}

/** Speech2 输入源（WEBUI18）。⛔ 认不出的源显式拒绝，不静默回落。 */
export function saveSpeech2Config(file, patch) {
  const raw = fs.existsSync(file) ? readSaved(file) : {};
  if (patch.input_source !== undefined && !SPEECH2_INPUT_SOURCES.includes(patch.input_source)) {
    throw new RangeError(`input_source must be one of ${SPEECH2_INPUT_SOURCES.join(', ')}`);
  }
  atomicWrite(file, normalizeConfig({ ...raw, speech2: { ...(raw.speech2 ?? {}), ...patch } }));
  return loadConfig(file);
}

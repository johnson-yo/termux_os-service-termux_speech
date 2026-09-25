/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The independent Android App Speech2 API client (plus the App AudioRing source API).
 * [OUTPUT]: Status/policy/start/stop, USER voice collection, the transcript read
 *           surface, the Speech2 input source (App AudioRing), the product Trigger mapping
 *           (Stop / Passthrough / Volume), the product policy field map, and `speech2Overview()` —
 *           the layered projection the WebUI renders (including a compact per-poll activity fact).
 * [POS]: Transport-only boundary. No microphone, model, CAM++, VAD, chunking, or ASR logic lives
 *        here. Model readiness is **relayed** from the App (the only authority); this module never
 *        inspects model files.
 * [PROTOCOL]: Update this header when changed, then check AGENTS.md and public-files.txt.
 */

/**
 * ⭐ Speech2 的输入源是 **App AudioRing** 的一个源（CP-SPEECH2-WEBUI18）。
 *   ⛔ 不是旧 PersistentMic：那条链归旧 speech，并且它开着时 App 会拒绝系统麦克风源
 *   （`AUDIO_SOURCE_BUSY: PersistentMic owns the system microphone`）。
 *   WAV_API / WS_LIVE_API 是测试源，⛔ 不出现在产品选项里。
 */
export const SPEECH2_INPUT_SOURCES = Object.freeze([
  'SYSTEM_BUILTIN_MIC',
  'SYSTEM_WIRED_HEADSET_MIC',
  'SYSTEM_BLUETOOTH_HFP',
  'SYSTEM_BLUETOOTH_LE_AUDIO',
  'SYSTEM_USB_AUDIO',
  'USB_AUDIO_APP_MANAGED',
]);
export const SPEECH2_DEFAULT_INPUT_SOURCE = 'SYSTEM_BUILTIN_MIC';
/** 由 Speech2 Start 负责启停的麦克风类源（测试源由测试工具自己管）。 */
export const isMicSource = (type) => SPEECH2_INPUT_SOURCES.includes(String(type ?? ''));

export function createSpeech2Client(android) {
  return Object.freeze({
    status: () => android.json('/api/speech2/status'),
    policy: () => android.json('/api/speech2/policy'),
    applyPolicy: (policy) => android.json('/api/speech2/policy', {
      method: 'PUT',
      body: policy,
    }),
    /**
     * ⚠ 真机实测：Stop 之后再 Start 要 **23–34 s**（App 重新声明并载入 ~500 MB 的 T267 ctx）。
     *   默认 8 s 的超时会把一次正常的启动报成失败，而且让后面「起麦克风源」那一步根本不跑。
     */
    start: () => android.json('/api/speech2/start', { method: 'POST', body: {}, timeoutMs: 90_000 }),
    stop: () => android.json('/api/speech2/stop', { method: 'POST', body: {}, timeoutMs: 30_000 }),
    transcriptsSince: (afterSeq, limit = 256) =>
      android.json(`/api/speech2/transcripts?after_seq=${Number(afterSeq) || 0}&limit=${limit}`),
    myVoice: () => android.json('/api/speech2/my-voice'),
    registerMyVoice: (body = {}) => android.json('/api/speech2/my-voice', {
      method: 'POST',
      body: { duration_ms: Number(body?.duration_ms) || 8000 },
    }),
    deleteMyVoice: () => android.json('/api/speech2/my-voice', { method: 'DELETE' }),
    voices: () => android.json('/api/speech2/voices'),
    addVoice: (body) => android.json('/api/speech2/voices', { method: 'POST', body }),
    testVoice: (enrollmentId) => android.json('/api/speech2/voices/test', {
      method: 'POST', body: { enrollment_id: enrollmentId },
    }),
    rerecordVoice: (id, body) => android.json(`/api/speech2/voices/${encodeURIComponent(id)}/record`, {
      method: 'POST', body,
    }),
    renameVoice: (id, label) => android.json(`/api/speech2/voices/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: { label },
    }),
    removeVoice: (id) => android.json(`/api/speech2/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // ── input source (App AudioRing) ─────────────────────────────────────
    ringStatus: () => android.json('/api/audio-ring/status'),
    ringSources: () => android.json('/api/audio-ring/sources'),
    startSource: (sourceType) => android.json('/api/audio-ring/source/start', {
      method: 'POST', body: { source_type: sourceType }, timeoutMs: 20_000,
    }),
    stopSource: () => android.json('/api/audio-ring/source/stop', { method: 'POST', body: {}, timeoutMs: 15_000 }),
  });
}

/** The five product scenes. ⭐ Selected through `policy.segmentation.scene`, never a new endpoint. */
export const SPEECH2_SCENES = Object.freeze([
  'VOICE_INPUT', 'CONVERSATION', 'MEDIA_STREAM', 'AI_BARGE_IN', 'MEDIA_FILE',
]);
/** Scenes whose segments only open on an enrolled USER (CAM fails closed without USER voices). */
export const SPEECH2_USER_ONLY_SCENES = Object.freeze(['VOICE_INPUT', 'AI_BARGE_IN']);

/**
 * ⭐ 产品 Trigger 只有三项（WEBUI18）。映射**逐项写死、只有这一处**：
 *   Stop        = Speech2 **运行态** stopped（`POST /api/speech2/stop`）——⛔ 不是 trigger.mode 取值；
 *   Passthrough = `policy.trigger.mode = "passthrough"` + running（没有第一层 Volume 门）；
 *   Volume      = `policy.trigger.mode = "volume"` + running（冻结的 RMS Volume trigger）。
 * ⛔ `feature`（拍掌双峰）是 App 内部实现，产品面不出现。
 */
export const SPEECH2_TRIGGERS = Object.freeze(['stop', 'passthrough', 'volume']);
export const SPEECH2_TRIGGER_POLICY_MODES = Object.freeze(['passthrough', 'volume']);

/** 产品 Trigger 的当前值：由**运行态 + policy** 推出，⛔ 本包不存第二份。 */
export const speech2Trigger = (running, policyMode) => {
  if (running !== true) return 'stop';
  return SPEECH2_TRIGGER_POLICY_MODES.includes(policyMode) ? policyMode : 'volume';
};

/**
 * ⭐ Settings 的 Speech2 Policy 映射（schema_version 4 / speech2-policy.v3）。
 *   只有**运行期真的读取**的字段才进产品面（一个改了不生效的旋钮比没有更糟）。
 *   CAM window/step 是 HTP 固定几何，只显示 effective/declaration 对账，不做输入控件。
 *   未展示的字段在 PUT 时**原样保留**（GET→改→PUT 完整文档）。
 */
export const SPEECH2_POLICY_SCHEMA_VERSION = 4;
export const SPEECH2_POLICY_FIELDS = Object.freeze({
  overview: ['trigger.mode', 'segmentation.scene', 'segmentation.target_enrollment_id'],
  settings: ['trigger.mode', 'trigger.pre_roll_ms', 'volume.rms_window_ms', 'volume.threshold', 'volume.frames',
    'cam.enter_threshold', 'cam.exit_threshold', 'cam.enter_confirm', 'cam.exit_confirm',
    'vad.speech_threshold', 'vad.smooth_frames', 'vad.min_speech_frames', 'vad.end_mode',
    'vad.hangover_ms', 'vad.hangover_max_ms', 'vad.hangover_min_ms', 'vad.pressure_start_ms',
    'vad.final_confirm_ms', 'vad.half_resume_speech_ms', 'asr.language'],
  fixed_geometry: ['cam.window_ms', 'cam.step_ms'],
  internal_trigger: ['feature.*'],
  declared_not_consumed: ['speech2_enabled', 'vad.natural_end_ms', 'chunking.hard_cap_ms',
    'chunking.shadow_before_ms', 'chunking.shadow_after_ms', 'asr.max_audio_ms'],
});

const model = (m) => ({
  installed: m?.installed === true,
  ready: m?.ready === true,
  reason: m?.reason ?? null,
});

const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);

/**
 * ⭐ LIVE 图表每次轮询的一格事实：只取 App status 里**已有**的字段，⛔ 本包不推断。
 *   rms = Volume frontend 最近一窗（passthrough 下为 null，如实）；gate/segment/role 来自
 *   Scene policy；vad 来自 FireRed；user 来自 CAM ownership。
 */
export function speech2Activity(status, policy = null) {
  const segmentation = status?.segmentation ?? {};
  const pol = status?.segmentation?.engine?.policy ?? {};
  const fr = segmentation.firered ?? {};
  const frState = fr.segmenter ?? {};
  const cam = status?.cam ?? {};
  const frontState = status?.frontend?.frontend_state ?? {};
  const volumeTrigger = frontState.trigger ?? {};
  const camThresholds = cam.cam_policy_thresholds ?? {};
  const camPolicy = camThresholds.policy ?? {};
  const camRuntime = camThresholds.runtime_active ?? {};
  const segState = pol.current_segment_state ?? pol.segment_state ?? null;
  const decisions = segmentation.recent_segment_decisions ?? [];
  const latestDecision = segmentation.latest_decision
    ?? (decisions.length ? decisions[decisions.length - 1] : null);
  const asrEngine = segmentation.asr?.engine ?? {};
  const latestType = String(latestDecision?.decision_type ?? '').replace(/^SEGMENT_/, '');
  return {
    running: status?.running === true,
    trigger_mode: status?.trigger_mode ?? status?.frontend?.trigger_mode ?? null,
    rms: num(status?.frontend?.last_rms),
    threshold: num(policy?.volume?.threshold),
    volume_window_ms: num(status?.frontend?.window_ms ?? policy?.volume?.rms_window_ms),
    volume_state: status?.frontend?.volume_state ?? null,
    volume_effective_threshold: num(volumeTrigger.threshold),
    volume_effective_frames: num(volumeTrigger.frames),
    trigger_pre_roll_ms: num(segmentation.gate?.pre_roll_ms ?? policy?.trigger?.pre_roll_ms),
    gate_open: pol.gate_open === true,
    gate_held: pol.gate_held === true,
    segment_active: segState === 'SEGMENT_ACTIVE' || segState === 'SEGMENT_HALF_PENDING',
    segment_state: segState,
    speaker_role: pol.current_speaker_role ?? null,
    vad_active: fr.segmenter?.active === true,
    vad_probability: num(fr.last_posterior),
    firered_state: frState.state ?? null,
    firered_pending_end: frState.pending_end === true,
    firered_half_pending: frState.half_pending === true,
    cam_ownership: cam.cam_ownership ?? cam.ownership?.ownership ?? null,
    cam_cosine: num(cam.cam_best_cosine ?? cam.cam_last_cosine),
    cam_best_enrollment_id: cam.cam_best_enrollment_id ?? null,
    cam_best_enrollment_label: cam.cam_best_enrollment_label ?? null,
    cam_identity_margin: num(cam.cam_identity_margin),
    cam_window_ms: num(cam.cam_window_ms),
    cam_step_ms: num(cam.cam_step_ms),
    cam_policy_geometry: cam.cam_policy_geometry ?? null,
    cam_policy_enter_threshold: num(camPolicy.enter_threshold),
    cam_policy_exit_threshold: num(camPolicy.exit_threshold),
    cam_runtime_enter_threshold: num(camRuntime.enter_threshold),
    cam_runtime_exit_threshold: num(camRuntime.exit_threshold),
    cam_runtime_enter_confirm: num(camRuntime.enter_confirm),
    cam_runtime_exit_confirm: num(camRuntime.exit_confirm),
    cam_thresholds_match: camThresholds.matches === true,
    firered_config: fr.effective_config ?? null,
    firered_pending_config: fr.pending_config ?? null,
    asr_language: asrEngine.last_language ?? asrEngine.configured_language ?? policy?.asr?.language ?? 'auto',
    asr_language_id: num(asrEngine.last_language_id),
    policy_state: segState,
    segment_id: latestDecision?.segment_id ?? null,
    segment_revision: num(latestDecision?.revision),
    segment_role: pol.current_speaker_role ?? latestDecision?.speaker_role ?? null,
    segment_decision: latestType || null,
    asr_in_flight: Number(segmentation.asr?.asr_in_flight ?? 0) > 0,
  };
}

/**
 * ⭐ Layered status (§28): installed / app reachable / models ready / running / analysis active /
 *   error are separate answers — ⛔ never collapsed into one green dot.
 *   WEBUI18 adds: trigger (derived), input (AudioRing source), USER voice presence, warnings, activity.
 */
export function speech2Overview(status, error = null, extra = {}) {
  const ring = extra.ring ?? null;
  const policy = extra.policy ?? null;
  const input = {
    configured: extra.inputSource ?? SPEECH2_DEFAULT_INPUT_SOURCE,
    active_source: ring?.active_source ?? null,
    source_active: ring?.source_active === true,
    capture_class: ring?.capture_class ?? null,
    last_error: extra.inputError ?? null,
  };
  if (!status) {
    return {
      installed: true,
      app_reachable: false,
      running: false,
      analysis_active: false,
      models_ready: false,
      models: null,
      scene: null,
      trigger: 'stop',
      trigger_mode: null,
      input,
      voices_registered: null,
      user_voice_count: null,
      warnings: [],
      activity: null,
      error: error ?? 'speech2_status_unavailable',
      state: 'unavailable',
    };
  }
  const models = status.models ?? null;
  const cam = model(models?.campplus);
  const fr = model(models?.fireredvad);
  const sv = model(models?.sensevoice_t267);
  const running = status.running === true;
  const gateOpen = Array.isArray(status.recent_gates) && status.recent_gates.length > 0;
  const analysisActive = running && (status.segmentation?.running === true || status.cam_active === true);
  const modelsInstalled = cam.installed && fr.installed && sv.installed;
  const modelsReady = cam.ready && fr.ready && sv.ready;
  const policyMode = policy?.trigger?.mode ?? status.trigger_mode ?? null;
  const scene = status.scene_policy_id ?? policy?.segmentation?.scene ?? null;
  const userVoiceCount = status.cam?.enrollment_store?.user_count;
  const voicesRegistered = Number.isInteger(userVoiceCount) ? userVoiceCount > 0 : null;
  let state;
  if (!modelsInstalled) state = 'model_missing';
  else if (!running) state = 'stopped';
  else if (!modelsReady) state = 'starting';
  else if (!input.source_active) state = 'no_input';
  else state = 'running';
  /** ⭐ 「一切都在跑但什么都不会发生」必须说出来（docs/087 的 gate_blocked 同一形状）。 */
  const warnings = [];
  if (running && !input.source_active) warnings.push('no_input_source');
  if (SPEECH2_USER_ONLY_SCENES.includes(scene) && voicesRegistered === false) {
    warnings.push('voices_required_for_scene');
  }
  if (input.last_error) warnings.push('input_error');
  return {
    installed: true,
    app_reachable: true,
    running,
    analysis_active: analysisActive,
    gate_seen: gateOpen,
    models_installed: modelsInstalled,
    models_ready: modelsReady,
    models: { campplus: cam, fireredvad: fr, sensevoice_t267: sv, authority: models?.authority ?? null },
    scene,
    selected_target_enrollment_id: policy?.segmentation?.target_enrollment_id ?? null,
    trigger: speech2Trigger(running, policyMode),
    trigger_mode: policyMode,
    policy_revision: status.policy_revision ?? null,
    input,
    voices_registered: voicesRegistered,
    user_voice_count: Number.isInteger(userVoiceCount) ? userVoiceCount : null,
    warnings,
    activity: speech2Activity(status, policy),
    error,
    state,
  };
}

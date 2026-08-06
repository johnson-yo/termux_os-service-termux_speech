/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App pinyin provider, profiles, Pipeline close authority, KWS/cue config, and cue outcomes.
 * [OUTPUT]: Wake setup/matching, KWS hit handoffs, owner-scoped countdown, and wake-cue status.
 * [POS]: KWS coordinator; it never owns the VAD Pool and loses close authority at VAD handoff.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import {
  createProfile,
  deleteProfile,
  deleteSample,
  getProfile,
  listProfiles,
  saveSamplePinyin,
  setProfileModel,
} from './profile-store.mjs';
import { buildTemplates, scorePinyin } from './pinyin-scorer.mjs';
import { KwsGateLease } from './gate-lease.mjs';
import { PINYIN_STREAM_FORMAT, PinyinWs } from './pinyin-ws.mjs';

const MODEL_ASSET_ID = 'model.wake-pinyin.app-htp';
const DEFAULT_PROVIDER = {
  protocol: PINYIN_STREAM_FORMAT,
  provider_ready: false,
  models_ready: false,
  sessions_ready: false,
  running: false,
  max_seg_ms: 6000,
  hangover_ms: 500,
  model_asset: MODEL_ASSET_ID,
  model_version: null,
  last_error: null,
};

const webSocketDescriptor = (descriptor) => {
  const endpoint = new URL(descriptor.baseUrl);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.pathname = '/ws/android/pinyin';
  endpoint.search = '';
  endpoint.hash = '';
  return {
    endpoint: endpoint.toString(),
    headers: { Authorization: descriptor.authorization },
    provider: 'termux-os.app.api',
  };
};

const publicProfile = (profile, activeProfileId) => profile ? {
  profile_id: profile.profile_id,
  display_name: profile.display_name,
  sample_count: profile.samples?.length ?? profile.sample_count ?? 0,
  built: Boolean(profile.model?.templates?.length ?? profile.built),
  threshold: profile.model?.threshold ?? profile.threshold ?? null,
  active: profile.profile_id === activeProfileId,
} : null;

export class KwsController {
  constructor({
    android,
    dataRoot,
    config,
    persistConfig,
    onHit = async () => {},
    onChange = () => {},
  }) {
    this.android = android;
    this.dataRoot = dataRoot;
    this.config = { ...config };
    this.persistConfig = persistConfig;
    this.onHit = onHit;
    this.onChange = onChange;
    this.provider = { ...DEFAULT_PROVIDER };
    this.providerError = null;
    this.lastFrameAtMs = null;
    this.lastHit = null;
    this.pendingHit = null;
    this.rejectedHits = 0;
    this.lastRejectedHit = null;
    this.lastCue = null;
    this.captureTarget = null;
    this.captureCommitted = false;
    this.captureOutcome = null;
    this.manualDetect = false;
    /** 停链期间为 true：refresh 不再重连 pinyin WS，也不重开检测。 */
    this.suspended = false;
    /** 停链时是否保留了 App 的拼音订阅（保留 = App 那三张图不会被拆掉）。 */
    this.subscriptionKept = false;
    this.productionFingerprint = '';
    this.lease = new KwsGateLease({
      idleTimeoutMs: this.config.idle_timeout_ms,
    });
    this.pinyin = new PinyinWs({
      onFrame: (frame, context) => this.handleFrame(frame, context),
    });
    fs.mkdirSync(this.dataRoot, { recursive: true });
  }

  configure(config) {
    this.config = { ...this.config, ...config };
    this.lease.configure({
      idleTimeoutMs: this.config.idle_timeout_ms,
    });
    this.productionFingerprint = '';
    this.syncProduction();
    return this.publicConfig();
  }

  setConfig(patch) {
    const next = this.persistConfig(patch);
    return this.configure(next);
  }

  publicConfig() {
    return {
      active_profile_id: this.config.active_profile_id ?? null,
      idle_timeout_ms: this.config.idle_timeout_ms,
      cue_enabled: this.config.cue_enabled !== false,
      positive_target: this.config.positive_target,
      score_threshold: this.config.score_threshold,
      initial_weight: this.config.initial_weight,
    };
  }

  /**
   * 唤醒组的资源开关（docs/061 §二.6）。
   *
   * ⚠ **不要把这叫「卸载 KWS」**：拼音那三张 HTP 图是 **App 自己**声明的常驻，App 内还有
   * 别的消费者。这里能撤销的只有 speech 自己的那份订阅——检测停掉、WS 关掉，
   * App 侧的图原样留着。停链报告必须如实说清楚哪些是共享而保留的。
   */
  suspend({ keepSubscription = false } = {}) {
    this.pinyin.stopDetect();
    this.productionFingerprint = '';
    this.suspended = true;
    // ⚠ 停订阅与停检测是两件事。App 的 `PinyinKws.unsubscribe` 在**最后一个订阅者离开时
    // 拆掉 worker**，于是「关掉 WS」等于把它那三张拼音图也一并卸了——下次启动要重载。
    // `keepSubscription` 只停匹配、留着订阅：图继续挂在 App 里，而没有模板在匹配就不会命中。
    // 麦克风此时已被释放，没有帧进来，故留着订阅几乎不产生成本。
    if (!keepSubscription) this.pinyin.close();
    this.subscriptionKept = keepSubscription;
    this.onChange();
    return this.snapshot();
  }

  resume() {
    this.suspended = false;
    this.subscriptionKept = false;
    this.onChange();
    return this.snapshot();
  }

  async refresh() {
    if (this.suspended) return this.snapshot();
    try {
      const [provider, descriptor] = await Promise.all([
        this.android.json('/api/android/pinyin/status'),
        this.android.describe(),
      ]);
      this.provider = { ...DEFAULT_PROVIDER, ...provider };
      this.providerError = null;
      this.pinyin.configure(webSocketDescriptor(descriptor));
      this.pinyin.ensure();
    } catch (error) {
      this.providerError = String(error?.message ?? error);
      this.provider = { ...this.provider, provider_ready: false, last_error: this.providerError };
    }
    this.lease.configure({
      idleTimeoutMs: this.config.idle_timeout_ms,
    });
    this.syncProduction();
    return this.snapshot();
  }

  activeProfile() {
    const id = this.config.active_profile_id;
    if (!id) return null;
    try { return getProfile(this.dataRoot, id); } catch { return null; }
  }

  builtProfileDescriptor(profile) {
    const templates = profile?.model?.templates ?? [];
    if (!templates.length) return null;
    return {
      profileId: profile.profile_id,
      displayName: profile.display_name,
      templates,
      threshold: Number(profile.model?.threshold ?? this.config.score_threshold),
      initialWeight: Number(profile.model?.initial_weight ?? this.config.initial_weight),
    };
  }

  syncProduction() {
    if (this.manualDetect || this.captureTarget || this.pinyin.captureActive()) return;
    const descriptor = this.builtProfileDescriptor(this.activeProfile());
    if (!descriptor) {
      if (this.pinyin.detectStatus().mode === 'production') this.pinyin.stopDetect();
      this.productionFingerprint = '';
      return;
    }
    const fingerprint = JSON.stringify([
      descriptor.profileId,
      descriptor.threshold,
      descriptor.initialWeight,
      descriptor.templates.map((template) => template.py),
    ]);
    if (fingerprint === this.productionFingerprint
      && this.pinyin.detectStatus().mode === 'production') return;
    this.pinyin.startDetectMany([descriptor], {
      mode: 'production',
      onHit: async (hit) => {
        // 结果未定之前不推给页面。旧顺序是「先写 lastHit + onChange，再判 owner」，
        // 于是被丢弃的 HIT 也会让页面闪 3.5 秒的绿色 HIT，而流水线毫无动静、零证据。
        this.pendingHit = { ...hit, at: new Date().toISOString() };
        await this.onHit({ ...this.pendingHit });
        // 兜底：调用方没显式记录结果时，至少把这次 HIT 如实标为未裁决。
        if (this.pendingHit) this.recordHitOutcome(hit, false, 'no_outcome_reported');
      },
    });
    this.productionFingerprint = fingerprint;
  }

  /** HIT 的结果由裁决方（main 的 onHit）显式回填，页面只看已裁决的事实。 */
  recordHitOutcome(hit, accepted, reason) {
    this.lastHit = {
      ...(this.pendingHit ?? { ...hit, at: new Date().toISOString() }),
      accepted: accepted === true,
      outcome: reason,
    };
    this.pendingHit = null;
    if (accepted !== true) {
      this.rejectedHits = Math.max(0, Number(this.rejectedHits) || 0) + 1;
      this.lastRejectedHit = { ...this.lastHit };
    }
    this.onChange();
    return { ...this.lastHit };
  }

  handleFrame(frame, context) {
    const nowMs = Date.now();
    this.lastFrameAtMs = nowMs;
    const segment = context.segment;
    if (frame.event === 'start') {
      this.lease.onSegmentStart(frame.seg, nowMs);
    } else if (frame.event === 'token') {
      this.lease.onSegmentToken({
        segmentId: frame.seg,
        text: segment?.text ?? context.detect.decoded_text,
        tokenCount: segment?.tokens?.length ?? 0,
      }, nowMs);
    } else if (frame.event === 'final') {
      const hit = context.detect.last_hit?.segment === frame.seg;
      const reason = this.captureTarget
        ? (this.captureTarget.kind === 'test' ? 'kws_test_final' : 'kws_enrollment_final')
        : !this.config.active_profile_id
          ? 'kws_no_active_keyword'
          : hit ? 'kws_hit' : 'kws_miss';
      this.lease.onSegmentFinal({
        segmentId: frame.seg,
        hit,
        reason,
        score: context.detect.score,
        text: context.detect.decoded_text,
        durationMs: frame.dur_ms,
      }, nowMs);
    }
    this.onChange();
  }

  observeGate(gate, nowMs = Date.now()) {
    this.lease.configure({
      idleTimeoutMs: this.config.idle_timeout_ms,
    });
    return this.lease.observeGate(gate, nowMs);
  }

  pollClose(nowMs = Date.now()) {
    return this.lease.pollClose(nowMs);
  }

  setCloseAuthority(active) {
    return this.lease.setCloseAuthority(active);
  }

  recordCue(outcome) {
    this.lastCue = {
      enabled: this.config.cue_enabled !== false,
      ok: outcome?.ok === true,
      playback: outcome?.playback ?? null,
      error: outcome?.error ?? null,
      at: new Date().toISOString(),
    };
    this.onChange();
    return { ...this.lastCue };
  }

  list() {
    return {
      profiles: listProfiles(this.dataRoot).map((profile) => ({
        ...profile,
        active: profile.profile_id === this.config.active_profile_id,
      })),
      config: this.publicConfig(),
    };
  }

  profile(id) {
    return getProfile(this.dataRoot, id);
  }

  create(displayName) {
    const profile = createProfile(this.dataRoot, displayName);
    this.onChange();
    return profile;
  }

  remove(profileId) {
    const result = deleteProfile(this.dataRoot, profileId);
    if (this.config.active_profile_id === profileId) {
      this.setConfig({ active_profile_id: null });
    }
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    return result;
  }

  removeSample(profileId, sampleId) {
    const result = deleteSample(this.dataRoot, profileId, sampleId);
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    return result;
  }

  build(profileId) {
    const profile = getProfile(this.dataRoot, profileId);
    const candidates = profile.samples
      .filter((sample) => sample.bpe?.tokens?.length)
      .map((sample) => ({
        index: sample.index,
        text: sample.bpe.text,
        tokens: sample.bpe.tokens,
      }));
    const built = buildTemplates(candidates, { initialWeight: this.config.initial_weight });
    if (!built.templates.length) {
      const error = new Error('没有可用样本（解码为空，换个词或说清楚重录）');
      error.status = 409;
      throw error;
    }
    const model = {
      schema: 'termux-os.wake-words.model.v3',
      built_at: new Date().toISOString(),
      threshold: this.config.score_threshold,
      initial_weight: built.initialWeight,
      consistency: built.consistency,
      representative: built.representative,
      syllables: built.syllables,
      decoded: candidates.length,
      empty: profile.samples.length - candidates.length,
      templates: built.templates,
      dropped: built.dropped,
    };
    setProfileModel(this.dataRoot, profileId, model);
    this.setConfig({ active_profile_id: profileId });
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    const { templates, ...publicModel } = model;
    return {
      model: {
        ...publicModel,
        kept: templates.map((template) => ({
          index: template.index,
          text: template.text,
        })),
      },
      active_profile_id: profileId,
    };
  }

  select(profileId) {
    if (profileId !== null) {
      const profile = getProfile(this.dataRoot, profileId);
      if (!profile.model?.templates?.length) {
        const error = new Error('请先为这个唤醒词生成匹配');
        error.status = 409;
        throw error;
      }
    }
    this.setConfig({ active_profile_id: profileId });
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    return this.publicConfig();
  }

  resetCapture(target) {
    this.captureTarget = target;
    this.captureCommitted = false;
    this.captureOutcome = null;
  }

  startCapture({ profileId, index, kind = 'enroll', threshold = null }) {
    const profile = getProfile(this.dataRoot, profileId);
    if (kind === 'test' && !profile.samples.length) {
      const error = new Error('该唤醒词还没有正样本，无法测试');
      error.status = 409;
      throw error;
    }
    this.manualDetect = false;
    this.resetCapture({
      profile_id: profileId,
      kind,
      index: Number.isInteger(index) ? index : undefined,
      threshold: Number.isFinite(Number(threshold)) ? Number(threshold) : null,
    });
    this.pinyin.armCapture();
    this.onChange();
    return { finalized: false, heard: false };
  }

  commitCapture() {
    if (this.captureCommitted) return { ...this.captureOutcome };
    const status = this.pinyin.pollCapture();
    if (!status.finalized) return { ...status, saved: false };
    const target = this.captureTarget;
    const settle = (outcome) => {
      this.captureCommitted = true;
      this.captureOutcome = { ...status, ...outcome };
      this.pinyin.cancelCapture();
      this.captureTarget = null;
      this.productionFingerprint = '';
      this.syncProduction();
      this.onChange();
      return { ...this.captureOutcome };
    };
    if (!target?.profile_id || !status.tokens?.length) {
      return settle({ saved: false, error: 'no captured pinyin' });
    }
    if (target.kind === 'test') {
      const profile = getProfile(this.dataRoot, target.profile_id);
      const templates = profile.model?.templates ?? [];
      const built = templates.length > 0;
      const threshold = target.threshold ?? this.config.score_threshold;
      const score = built
        ? scorePinyin(templates, status.tokens, {
            initialWeight: profile.model?.initial_weight ?? this.config.initial_weight,
          })
        : { score: 0, best: null };
      return settle({
        saved: false,
        test: {
          built,
          score: score.score,
          matched: score.score >= threshold,
          best: score.best,
          threshold,
          decoded_text: status.text,
        },
      });
    }
    const { sample } = saveSamplePinyin(
      this.dataRoot,
      target.profile_id,
      target.index,
      {
        text: status.text,
        tokens: status.tokens,
        provider: 'termux-os.app.api',
      },
    );
    return settle({ saved: true, sample });
  }

  stopCapture() {
    const result = this.commitCapture();
    if (!result.finalized) {
      this.pinyin.cancelCapture();
      this.captureTarget = null;
      this.productionFingerprint = '';
      this.syncProduction();
      this.onChange();
      return { ...result, finalized: true, saved: false, aborted: true };
    }
    return result;
  }

  cancelCapture() {
    this.resetCapture(null);
    this.pinyin.cancelCapture();
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    return { canceled: true };
  }

  startStreamTest(profileId, threshold) {
    const profile = getProfile(this.dataRoot, profileId);
    const templates = profile.model?.templates ?? [];
    if (!templates.length) {
      const error = new Error('还没有生成匹配（先录几条正样本并生成）');
      error.status = 409;
      throw error;
    }
    this.manualDetect = true;
    this.resetCapture(null);
    this.pinyin.cancelCapture();
    this.pinyin.startDetect(
      templates,
      Number.isFinite(Number(threshold)) ? Number(threshold) : this.config.score_threshold,
      profile.model?.initial_weight ?? this.config.initial_weight,
    );
    this.onChange();
    return this.pinyin.detectStatus();
  }

  stopStreamTest() {
    const stopped = this.pinyin.stopDetect();
    this.manualDetect = false;
    this.productionFingerprint = '';
    this.syncProduction();
    this.onChange();
    return stopped;
  }

  snapshot(nowMs = Date.now()) {
    const stream = this.pinyin.detectStatus();
    const lease = this.lease.snapshot();
    const active = this.activeProfile();
    const profile = publicProfile(active, this.config.active_profile_id);
    const providerReady = this.provider.provider_ready === true
      && this.pinyin.connected
      && this.provider.protocol === PINYIN_STREAM_FORMAT;
    const modelReady = this.provider.models_ready === true
      || this.provider.sessions_ready === true;
    const ready = providerReady && modelReady && profile?.built === true;
    const state = this.captureTarget
      ? 'setup'
      : !this.pinyin.connected ? 'connecting'
        : !profile?.built ? 'setup_required'
          : stream.speaking ? 'listening'
            : 'ready';
    const reason = ready ? null
      : !providerReady ? (this.providerError || this.pinyin.lastError || 'pinyin_provider_not_ready')
        : !modelReady ? 'model_loading'
          : 'active_keyword_not_built';
    return {
      schema: 'termux-os.speech-kws.v1',
      capability: 'speech.kws',
      state,
      ready,
      reason,
      provider: {
        format: this.provider.protocol,
        connected: this.pinyin.connected,
        provider_ready: this.provider.provider_ready === true,
        running: this.provider.running === true || this.pinyin.connected,
        models_ready: modelReady,
        model_asset: this.provider.model_asset ?? MODEL_ASSET_ID,
        model_version: this.provider.model_version ?? null,
        open_rms: Number(this.provider.open_rms) || null,
        internal_close_rms: Number(this.provider.close_rms) || null,
        internal_hangover_ms: Number(this.provider.hangover_ms) || null,
        max_seg_ms: Number(this.provider.max_seg_ms) || 6000,
        last_error: this.provider.last_error ?? this.providerError ?? this.pinyin.lastError,
      },
      profile,
      stream,
      last_hit: this.lastHit ?? stream.last_hit,
      rejected_hits: this.rejectedHits,
      last_rejected_hit: this.lastRejectedHit ? { ...this.lastRejectedHit } : null,
      countdown: {
        owner: 'speech.kws',
        authoritative: lease.close_authority === true,
        timeout_ms: this.config.idle_timeout_ms,
        deadline_ms: lease.deadline_ms,
        remaining_ms: lease.remaining_ms,
        last_qualified_pcm_at_ms: lease.last_qualified_pcm_at_ms,
        resets_on: lease.resets_on,
        last: lease.last_close,
      },
      cue: {
        enabled: this.config.cue_enabled !== false,
        kind: 'wake',
        last: this.lastCue ? { ...this.lastCue } : null,
      },
      lease,
      observed_at_ms: nowMs,
    };
  }

  close() {
    this.pinyin.close();
  }
}

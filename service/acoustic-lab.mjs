/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 与正式链**同一条** PCM WS 上分流来的帧（consumer `lab`）+ 自己那张 FireRedVAD 常驻图
 * [OUTPUT]: 对外提供「录参考值 → 看实时 RMS/VAD → 看 KEEP/DROP → 听 HALF/FULL WAV」的实验工具
 * [POS]: docs/078。⛔ **这条链到 WAV 为止**——不进 SenseVoice、
 *        不 `records.admit`、不占 50 句 group。所有事件都带 `source=acoustic_lab, debug_only=true`。
 *
 * ⭐ 为什么要有自己的一张 VAD 图：正式 `VadController` 那张是**有状态的流**
 *   （`state_links: caches_packed`），两个消费者共用一条流会互相污染 recurrent state。
 *   独立 consumer 的代价就是独立的图（实测五图同驻共 115 MB，多一张 VAD 约 24 MB）。
 * ⛔ 它**不是** mic 总开关：`lab` 只是 `PcmConsumers` 里的一个名字，
 *   开它不关别人，关它不动别人（docs/077）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeFbank, loadCmvn } from './vad/fbank.mjs';
import { ForegroundGate } from './asr/foreground.mjs';
import {
  RelativeForegroundGate, REFERENCE_STATS, distributionOf, statFrom,
} from './asr/relative-foreground.mjs';
import { ResidentGraph } from './residents.mjs';

const SR = 16_000;
const FRAME_MS = 10;
const HOP = SR * FRAME_MS / 1000;          // 160
const WIN = SR * 25 / 1000;                // 400
const BATCH_FRAMES = 40;
const LAB_EST_MEM_MB = 24;
const EPOCH_KEEP = 10;
const TIMELINE_KEEP = 1200;                // 最近 12 秒（10 ms 一格）

/** 端点参数默认值：⛔ 直接沿用已 PoC 验证过的那一组，不凭空重设计（docs/075/076）。 */
export const ENDPOINT_DEFAULTS = Object.freeze({
  vad_speech: 0.60,
  vad_arm: 0.50,
  vad_slope: -0.02,
  half_hold_ms: 30,
  min_speech_ms: 200,
  new_speech_ms: 200,
  acoustic_full_ms: 500,
  hard_cap_ms: 8000,
  max_half: 2,
});

export const FOREGROUND_DEFAULTS = Object.freeze({
  band_half_db: 6,
  min_in_band_ms: 300,
  min_in_band_ratio: 0.35,
});

/**
 * 相对 foreground gate（docs/079）。⭐ 两条门**同时**跑在同一段帧上，
 * 每个 epoch 都把两边的判决一起记下来——§11 那张新旧对照表因此是**同一次运行**
 * 的结果，不是两次运行拼起来的（两次运行之间背景内容已经变了，不可比）。
 * `active_gate` 只决定「谁是这一轮的权威判决」，不影响另一条门照样被记录。
 */
export const RELATIVE_LAB_DEFAULTS = Object.freeze({
  alpha: 0.5,
  foreground_min_ms: 200,
  min_separation_db: 6,
});

const SILENCE_DB = -70;

const wavHeader = (bytes) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
};

const percentile = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  : null);

const modalOf = (values, binDb = 2) => {
  if (!values.length) return { db: null, share: null };
  const counts = new Map();
  for (const v of values) {
    const k = Math.round(v / binDb);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bestK = null; let best = -1;
  for (const [k, c] of counts) if (c > best) { bestK = k; best = c; }
  return { db: Number((bestK * binDb).toFixed(2)), share: Number((best / values.length).toFixed(3)) };
};

export class AcousticLab {
  /** @param graph 已经路由好的图参数（见 `executableGraphArgs`）；⛔ 不是裸路径。 */
  constructor({ android, graph = null, cmvnFile = null, dataRoot, residentId, onChange = () => {} }) {
    this.android = android;
    /** 两条路径都来自 FireRedVAD logical descriptor，⛔ 类内不拼 source 文件名。 */
    this.executable = graph ?? null;
    this.modelPath = graph?.path ?? null;
    this.cmvnPath = cmvnFile;
    /** ⭐ 与 [VadController.applyLogical] 同一件事：可执行体是会迟到的事实。 */
    this.applyLogical = ({ graph: g, cmvnFile: c } = {}) => {
      if (this.modelPath && this.cmvnPath) return false;
      if (!g?.path || !c) return false;
      this.executable = g; this.modelPath = g.path; this.cmvnPath = c;
      return true;
    };
    this.dataRoot = path.resolve(dataRoot);
    this.onChange = onChange;
    this.graph = new ResidentGraph({
      android, id: residentId, model: 'fireredvad',
      modelPath: graph?.modelPath ?? null,
      ctxPath: graph?.ctxPath ?? null,
      ctxKey: graph?.ctxKey ?? null,
      estMemMb: LAB_EST_MEM_MB,
    });
    this.cmvn = null;

    this.mode = 'idle';                    // idle | calibrating | testing
    this.calibTarget = 'user';             // user | background —— 校准的是哪一层
    this.config = { ...ENDPOINT_DEFAULTS, ...FOREGROUND_DEFAULTS, ...RELATIVE_LAB_DEFAULTS };
    this.referenceStats = { ...REFERENCE_STATS };
    this.activeGate = 'relative';          // relative | absolute（两条都记，这只决定权威）
    this.reference = null;                 // 用户层 { db, band, stat, dist, applied_at_ms }
    this.backgroundReference = null;       // 背景层 { db, stat, dist, applied_at_ms }
    this.candidate = null;                 // 用户候选
    this.backgroundCandidate = null;       // 背景候选
    // ⛔ 恒为 true：Lab 是**可重复实验台**，参考只能由显式 apply 改变。
    //   docs/078 那次正反馈就是从「判定回写参考」开始的。
    this.referenceFixed = true;
    this.gate = new ForegroundGate({ ...FOREGROUND_DEFAULTS, fixed: true });
    this.relativeGate = new RelativeForegroundGate(RELATIVE_LAB_DEFAULTS);

    this.phase = null;                     // 三阶段测试的相位标签，不参与判决
    this.reset('init');
    this.epochs = [];
    this.epochSeq = 0;
    this.lastError = null;
    this.inferenceInFlight = false;
    this.pendingFeatures = [];
    this.pendingSamples = 0;
    this.resetNext = true;
    this.tail = Buffer.alloc(0);           // 不足一帧的样本
    this.timeline = [];
    this.asrInvocations = 0;               // 恒为 0；用来证明「本页不跑 ASR」
  }

  // ────────────────────────────────────────────────────────── 生命周期
  ensureFiles() {
    if (!this.modelPath) throw new Error('FireRedVAD logical executable is unavailable');
    if (!this.cmvnPath) throw new Error('FireRedVAD logical companion cmvn is unavailable');
    if (!fs.existsSync(this.modelPath)) throw new Error(`FireRedVAD model missing: ${this.modelPath}`);
    if (!fs.existsSync(this.cmvnPath)) throw new Error(`FireRedVAD CMVN missing: ${this.cmvnPath}`);
    if (!this.cmvn) this.cmvn = loadCmvn(fs.readFileSync(this.cmvnPath));
  }

  async ensureResident() {
    this.ensureFiles();
    await this.graph.declare();
    return this.graph.snapshot();
  }

  reset(reason = 'reset') {
    this.state = 'IDLE';
    this.epoch = null;
    this.halfIndex = 0;
    this.speechMs = 0;
    this.newSpeechMs = 0;
    this.lowRun = 0;
    this.silSinceHalf = null;
    this.lastReason = reason;
    this.audioMs = 0;
    this.smoothWindow = [];
    this.recentSm = [];
    this.calib = { db: [], ms: 0, speechDb: [] };
  }

  // ────────────────────────────────────────────────────────── PCM 入口
  /** ⚠ 与正式链共用同一条 WS，在 `ingestPcmFrame` 里分流；这里只处理属于 lab 的那份。 */
  ingest(frame) {
    if (this.mode === 'idle') return;
    const buf = Buffer.concat([this.tail, frame]);
    const total = buf.length / 2;
    const nFrames = Math.max(0, Math.floor((total - WIN) / HOP) + 1);
    if (nFrames <= 0) { this.tail = buf; return; }

    /**
     * ⚠ RMS 与 fbank **必须逐帧对齐**：两边都以 `i*HOP` 起、取 `WIN` 个样本，
     *   并且喂给 `computeFbank` 的是**同一个** buffer——只喂「已消费的那一段」会让
     *   它少算几帧，于是 `pendingDb` 与 probs 从第一批就开始错位，而错位不会报错。
     */
    const samples = new Int16Array(total);
    for (let i = 0; i < total; i += 1) samples[i] = buf.readInt16LE(i * 2);
    for (let i = 0; i < nFrames; i += 1) {
      let sum = 0;
      const start = i * HOP;
      for (let s = 0; s < WIN; s += 1) {
        const v = samples[start + s] / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / WIN);
      this.pushDb(rms > 1e-9 ? 20 * Math.log10(rms) : SILENCE_DB);
    }
    // ⚠ `computeFbank` 返回的是 `{ feat, frames }`，**不是数组**。
    //   写成 `if (feats?.length)` 会恒为假——特征一帧都进不了队，而没有任何报错
    //   （docs/056 那个形状：读得出值、型别不对、答案错得很安静）。真机上就是这么坏的。
    const { feat } = computeFbank(samples, this.cmvn);
    if (feat.length) this.pendingFeatures.push(...feat);
    const consumed = nFrames * HOP * 2;
    if (this.epoch) this.epoch.pcm.push(Buffer.from(buf.subarray(0, consumed)));
    this.tail = Buffer.from(buf.subarray(consumed));
    void this.pump();
  }

  pushDb(db) { this.pendingDb = this.pendingDb ?? []; this.pendingDb.push(db); }

  async pump() {
    if (this.inferenceInFlight || this.pendingFeatures.length === 0) return;
    this.inferenceInFlight = true;
    const batch = this.pendingFeatures.splice(0, BATCH_FRAMES);
    const reset = this.resetNext;
    try {
      const r = await this.graph.stream({
        reset,
        state_links: { caches_packed: 'new_caches_packed' },
        outputs: ['probs'],
        steps: batch.map((row) => ({
          inputs: {
            feat: {
              dtype: 'float32', shape: [1, 1, row.length],
              data_b64: Buffer.from(Float32Array.from(row).buffer).toString('base64'),
            },
          },
        })),
      });
      this.resetNext = false;
      const probs = r?.values?.probs ?? r?.probs;
      if (!Array.isArray(probs)) throw new Error('lab VAD returned no probs');
      this.lastError = null;
      for (const p of probs) this.step(Number(p));
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      if (error?.retryable === true) this.pendingFeatures.unshift(...batch);
      else this.resetNext = true;
    } finally {
      this.inferenceInFlight = false;
      if (this.pendingFeatures.length >= BATCH_FRAMES) void this.pump();
    }
  }

  // ────────────────────────────────────────────────────────── 逐帧状态机
  step(prob) {
    const c = this.config;
    const db = (this.pendingDb ?? []).shift() ?? SILENCE_DB;
    this.smoothWindow.push(prob);
    if (this.smoothWindow.length > 5) this.smoothWindow.shift();
    const sm = this.smoothWindow.reduce((a, b) => a + b, 0) / this.smoothWindow.length;
    this.recentSm.push(sm);
    if (this.recentSm.length > 4) this.recentSm.shift();
    const slope = this.recentSm.length >= 4
      ? (this.recentSm[3] - this.recentSm[0]) / 3 : 0;
    const isSpeech = sm >= c.vad_speech;
    this.audioMs += FRAME_MS;

    this.timeline.push({ t: this.audioMs, db: Number(db.toFixed(1)), p: Number(sm.toFixed(3)), s: isSpeech ? 1 : 0 });
    if (this.timeline.length > TIMELINE_KEEP) this.timeline.shift();
    this.lastFrame = { rms_db: Number(db.toFixed(2)), vad_probability: Number(prob.toFixed(4)),
                       vad_smoothed: Number(sm.toFixed(4)), vad_speech: isSpeech,
                       in_band: this.inBand(db) };

    if (this.mode === 'calibrating') {
      /**
       * ⭐ 两个窗口用**同一把尺**：一律收 `db > SILENCE_DB` 的全部帧，不按 VAD 过滤。
       *
       * ⚠ 上一版只收 `isSpeech` 的帧，理由是「避免静音把参考拖低」。在**安静背景**下
       *   那是对的；在这一轮的场景下它同时是无效和有害的：
       *   · 无效——背景就是一档持续播放的访谈，VAD 概率 85% 的时间 > 0.6，筛不掉任何东西；
       *   · 有害——背景窗口与用户窗口若用不同的筛选规则，B* 与 R* 就不在同一个尺度上，
       *     而 T = B* + α(R*−B*) 的全部意义都建立在「两个数可比」上。
       *   VAD-speech 子集仍然算出来放进 telemetry，只是不参与定 T。
       */
      if (db > SILENCE_DB) {
        this.calib.db.push(db);
        this.calib.ms += FRAME_MS;
        if (isSpeech) this.calib.speechDb.push(db);
      }
      const cand = this.candidateFrom(this.calib.db, this.calib.ms, this.calib.speechDb);
      if (this.calibTarget === 'background') this.backgroundCandidate = cand;
      else this.candidate = cand;
      return;
    }
    if (this.mode !== 'testing') return;

    if (isSpeech) {
      this.speechMs += FRAME_MS;
      if (this.halfIndex >= 1) this.newSpeechMs += FRAME_MS;
      this.silSinceHalf = null;
      if (!this.epoch) this.openEpoch();
    }
    if (this.halfIndex >= 1 && !isSpeech && this.silSinceHalf !== null) this.silSinceHalf += FRAME_MS;
    if (!this.epoch) return;

    this.epoch.frames.push(db);
    const activeMs = this.audioMs - this.epoch.start_ms;

    if (activeMs >= c.hard_cap_ms) return this.closeEpoch('hard_cap');
    if (this.halfIndex === 1 && this.silSinceHalf !== null && this.silSinceHalf >= c.acoustic_full_ms) {
      return this.closeEpoch('acoustic_full');
    }
    const allowed = (this.halfIndex === 0 && this.speechMs >= c.min_speech_ms)
      || (this.halfIndex === 1 && this.newSpeechMs >= c.new_speech_ms);
    if (allowed && sm < c.vad_arm && slope < c.vad_slope) {
      this.lowRun += FRAME_MS;
      if (this.lowRun >= c.half_hold_ms) {
        this.lowRun = 0;
        this.halfIndex += 1;
        this.state = this.halfIndex === 1 ? 'HALF_1' : 'HALF_2';
        // ⚠ 从 HALF 这一刻开始数静默，否则 `silSinceHalf` 永远是 null，
        //   `acoustic_full` 一次都不会触发——真机上三个 epoch 全部走到 hard_cap 就是这个。
        this.silSinceHalf = 0;
        this.markHalf();
        if (this.halfIndex >= c.max_half) this.closeEpoch('half_limit');
      }
    } else {
      this.lowRun = 0;
      this.state = isSpeech ? 'SPEECH' : (this.halfIndex ? this.state : 'EDGE_CANDIDATE');
    }
    return undefined;
  }

  // ────────────────────────────────────────────────────────── epoch / WAV
  openEpoch() {
    this.epochSeq += 1;
    this.epoch = {
      seq: this.epochSeq, start_ms: this.audioMs, pcm: [], frames: [],
      halves: [], full: null, dir: path.join(this.dataRoot, `epoch-${this.epochSeq}`),
    };
    this.state = 'SPEECH';
    this.halfIndex = 0; this.speechMs = 0; this.newSpeechMs = 0; this.silSinceHalf = null;
  }

  /** HALF 保存「本 epoch 起点 → 此刻」；FULL 保存整段。 */
  writeWav(name) {
    const pcm = Buffer.concat(this.epoch.pcm);
    fs.mkdirSync(this.epoch.dir, { recursive: true });
    const file = path.join(this.epoch.dir, `${name}.wav`);
    fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length), pcm]));
    return { file, bytes: pcm.length, duration_ms: Math.round(pcm.length / 2 / SR * 1000) };
  }

  markHalf() {
    const w = this.writeWav(`half${this.halfIndex}`);
    this.epoch.halves.push({
      index: this.halfIndex, at_ms: this.audioMs - this.epoch.start_ms,
      duration_ms: w.duration_ms, wav: `half${this.halfIndex}`,
    });
    this.onChange();
  }

  closeEpoch(reason) {
    const w = this.writeWav('full');
    const frames = this.epoch.frames;
    const segmentId = `lab-${this.epoch.seq}`;
    /**
     * ⭐ 两条门跑在**同一段帧**上，两边的判决一起落盘。§11 的新旧对照因此来自
     * 同一次运行——分两次跑的话背景内容早就变了，那张表不可比。
     */
    const absolute = this.reference
      ? this.gate.decide(frames, FRAME_MS, { segment_id: segmentId })
      : { decision: 'KEEP', keep_reason: 'no_reference' };
    const relative = this.relativeGate.decide(frames, FRAME_MS, { segment_id: segmentId });
    const authoritative = this.activeGate === 'absolute' ? absolute : relative;
    this.epochs.push({
      seq: this.epoch.seq, start_ms: this.epoch.start_ms,
      duration_ms: w.duration_ms, full_reason: reason,
      halves: this.epoch.halves, full: { wav: 'full', duration_ms: w.duration_ms },
      /** 权威判决（由 `active_gate` 决定是哪条门），页面与统计都读这个。 */
      foreground: {
        gate: this.activeGate,
        decision: authoritative.decision,
        reason: authoritative.drop_reason ?? authoritative.keep_reason ?? null,
        // ⭐ C3：判决现场完整落盘。少了这些，「页面一套、判决另一套」事后无法查证。
        background_reference_db: this.backgroundReference?.db ?? null,
        user_reference_db: this.reference?.db ?? null,
        reference_gap_db: relative.reference_gap_db ?? null,
        foreground_threshold_db: relative.foreground_threshold_db ?? null,
        alpha: relative.alpha ?? null,
        foreground_min_ms: relative.foreground_min_ms ?? null,
        segment_p50_db: relative.segment_p50_db ?? null,
        segment_p75_db: relative.segment_p75_db ?? null,
        segment_p90_db: relative.segment_p90_db ?? null,
        segment_p95_db: relative.segment_p95_db ?? null,
        segment_max_db: relative.segment_max_db ?? null,
        time_above_threshold_ms: relative.time_above_threshold_ms ?? null,
        max_contiguous_above_threshold_ms: relative.max_contiguous_above_threshold_ms ?? null,
        // 旧门的现场同样留着，否则对照表里只有结论没有依据。
        segment_median_rms_db: absolute.segment_median_rms_db ?? null,
        time_in_reference_band_ms: absolute.time_in_reference_band_ms ?? null,
        in_reference_band_ratio: absolute.in_reference_band_ratio ?? null,
        reference_band: absolute.reference_band ?? null,
      },
      /** 两条门各自的原始判决，供 §11 对照表直接统计。 */
      gates: {
        absolute: { decision: absolute.decision,
                    reason: absolute.drop_reason ?? absolute.keep_reason ?? null },
        relative: { decision: relative.decision,
                    reason: relative.drop_reason ?? relative.keep_reason ?? null },
      },
      phase: this.phase ?? null,
      // ⛔ 明确打标：这些事件绝不许被正式 handler 当成真结果。
      source: 'acoustic_lab', debug_only: true,
    });
    // 只留最新 10 个；第 11 个到来时**连 WAV 一起删**，否则长测会一直涨。
    while (this.epochs.length > EPOCH_KEEP) {
      const old = this.epochs.shift();
      try { fs.rmSync(path.join(this.dataRoot, `epoch-${old.seq}`), { recursive: true, force: true }); }
      catch { /* 已经不在了。 */ }
    }
    this.epoch = null;
    this.state = 'FULL';
    this.halfIndex = 0; this.speechMs = 0; this.newSpeechMs = 0; this.silSinceHalf = null;
    this.onChange();
  }

  // ────────────────────────────────────────────────────────── 参考值
  candidateFrom(values, ms, speechValues = []) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const modal = modalOf(values);
    const p60 = percentile(sorted, 0.6);
    const dist = distributionOf(values);
    // 这个候选是给哪一层用的，就按哪一层配置的分位数取 `candidate_db`。
    const statName = this.referenceStats[this.calibTarget] ?? 'p60';
    const picked = statFrom(dist, statName);
    return {
      target: this.calibTarget,
      sample_ms: ms,
      /** ⭐ 完整分布摆出来：两个参考层取哪个分位数是本轮最关键的判断，不能只给一个数。 */
      distribution: dist,
      /** VAD=speech 子集只做对照，不参与定 T（背景本身就是语音，它筛不掉东西）。 */
      speech_only_distribution: distributionOf(speechValues),
      median_db: Number(percentile(sorted, 0.5).toFixed(2)),
      p60_db: Number(p60.toFixed(2)),
      modal_db: modal.db,
      modal_share: modal.share,
      min_db: Number(sorted[0].toFixed(2)),
      max_db: Number(sorted[sorted.length - 1].toFixed(2)),
      stat: statName,
      candidate_db: picked === null ? null : Number(picked.toFixed(2)),
      /** 旧的绝对 band 只对用户层有意义，背景层不画带。 */
      band: this.calibTarget === 'user' ? this.bandOf(picked) : null,
    };
  }

  bandOf(db) {
    const h = this.config.band_half_db;
    return db === null ? null : [Number((db - h).toFixed(2)), Number((db + h).toFixed(2))];
  }

  inBand(db) {
    if (!this.reference) return null;
    const [lo, hi] = this.reference.band;
    return db >= lo && db <= hi;
  }

  /** @param target 'user' | 'background' —— 应用哪一层的候选。 */
  applyReference(target = 'user') {
    const which = target === 'background' ? 'background' : 'user';
    const cand = which === 'background' ? this.backgroundCandidate : this.candidate;
    if (!cand || cand.candidate_db === null) return { ok: false, reason: 'no_candidate', target: which };
    const applied = {
      db: cand.candidate_db,
      stat: cand.stat,
      distribution: cand.distribution,
      applied_at_ms: Date.now(),
      source: 'calibration',
      sample_ms: cand.sample_ms,
    };
    if (which === 'background') {
      this.backgroundReference = applied;
    } else {
      this.reference = { ...applied, band: this.bandOf(cand.candidate_db) };
      // 旧的绝对 band 门：参考固定（`fixed: true`），KEEP/DROP 都改不动它（C1）。
      this.gate.reset('lab');
      this.gate.rStar = this.reference.db;
      this.gate.refMs = Math.max(cand.sample_ms, this.gate.config.reference_min_ms);
      this.gate.refValues = [this.reference.db];
    }
    this.syncRelativeGate();
    this.referenceFixed = true;
    this.onChange();
    return { ok: true, target: which, reference: which === 'background' ? this.backgroundReference : this.reference };
  }

  /** ⛔ 参考只从这里进 relativeGate；`decide()` 永远不回写（docs/079）。 */
  syncRelativeGate() {
    this.relativeGate.setReferences({
      backgroundDb: this.backgroundReference?.db ?? null,
      userDb: this.reference?.db ?? null,
    });
  }

  clearReference(target = 'all') {
    if (target === 'all' || target === 'user') {
      this.reference = null; this.candidate = null; this.gate.reset('lab');
    }
    if (target === 'all' || target === 'background') {
      this.backgroundReference = null; this.backgroundCandidate = null;
    }
    this.syncRelativeGate();
    this.onChange();
    return { ok: true, target };
  }

  configure(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.config && Number.isFinite(Number(v))) this.config[k] = Number(v);
    }
    if (patch.active_gate === 'absolute' || patch.active_gate === 'relative') {
      this.activeGate = patch.active_gate;
    }
    // 分位数可改，但只认分布里真有的那几个名字——写错一个名字会让参考静默变成 null。
    for (const layer of ['background', 'user']) {
      const name = patch[`${layer}_stat`];
      if (typeof name === 'string' && ['p10', 'p25', 'p50', 'p60', 'p75', 'p90', 'p95', 'max', 'median'].includes(name)) {
        this.referenceStats[layer] = name;
      }
    }
    this.gate.configure({
      band_half_db: this.config.band_half_db,
      min_in_band_ms: this.config.min_in_band_ms,
      min_in_band_ratio: this.config.min_in_band_ratio,
    });
    this.relativeGate.configure({
      alpha: this.config.alpha,
      foreground_min_ms: this.config.foreground_min_ms,
      min_separation_db: this.config.min_separation_db,
    });
    /**
     * ⚠ 改分位数要**重新从已存的分布里取值**，而不是等下一次校准。
     *   否则页面上 `background_stat` 已经是 p95、判决用的 B* 还是上一次 p60 的数——
     *   docs/078 §9 那个「显示一套、判决一套」的形状，换个地方又长出来。
     */
    if (this.backgroundReference?.distribution) {
      const v = statFrom(this.backgroundReference.distribution, this.referenceStats.background);
      if (v !== null) { this.backgroundReference.db = v; this.backgroundReference.stat = this.referenceStats.background; }
    }
    if (this.reference?.distribution) {
      const v = statFrom(this.reference.distribution, this.referenceStats.user);
      if (v !== null) { this.reference.db = v; this.reference.stat = this.referenceStats.user; }
    }
    if (this.reference) {
      this.reference.band = this.bandOf(this.reference.db);
      this.gate.rStar = this.reference.db;
      this.gate.refValues = [this.reference.db];
    }
    if (this.backgroundCandidate) {
      const v = statFrom(this.backgroundCandidate.distribution, this.referenceStats.background);
      this.backgroundCandidate.stat = this.referenceStats.background;
      this.backgroundCandidate.candidate_db = v === null ? null : Number(v.toFixed(2));
    }
    if (this.candidate) {
      const v = statFrom(this.candidate.distribution, this.referenceStats.user);
      this.candidate.stat = this.referenceStats.user;
      this.candidate.candidate_db = v === null ? null : Number(v.toFixed(2));
      this.candidate.band = this.bandOf(this.candidate.candidate_db);
    }
    this.syncRelativeGate();
    this.onChange();
    return this.config;
  }

  /**
   * 三阶段测试的相位标记（A 只背景 / B 背景+sample / C sample 停）。
   * ⛔ 它只是给 epoch 打标签，**不参与任何判决**——判据不许知道现在是哪一相，
   *   否则测出来的就不是判据的能力，是我告诉它答案的能力。
   */
  setPhase(phase) {
    this.phase = typeof phase === 'string' && phase ? phase.slice(0, 32) : null;
    this.onChange();
    return this.phase;
  }

  snapshot() {
    return {
      schema: 'termux-os.acoustic-lab.v1',
      source: 'acoustic_lab', debug_only: true,
      mode: this.mode,
      calibration_target: this.mode === 'calibrating' ? this.calibTarget : null,
      phase: this.phase ?? null,
      state: this.state,
      audio_ms: this.audioMs,
      last_frame: this.lastFrame ?? null,
      reference: this.reference,
      background_reference: this.backgroundReference,
      reference_fixed: this.referenceFixed,
      reference_stats: { ...this.referenceStats },
      active_gate: this.activeGate,
      /** B* / R* / gap / alpha / T 一次给全——页面直接照抄，不许各自算一遍。 */
      relative: this.relativeGate.references(),
      candidate: this.candidate,
      background_candidate: this.backgroundCandidate,
      calibration_ms: this.calib?.ms ?? 0,
      config: { ...this.config },
      epoch: this.epoch ? {
        seq: this.epoch.seq,
        active_ms: this.audioMs - this.epoch.start_ms,
        half_index: this.halfIndex,
      } : null,
      epochs: this.epochs.slice().reverse(),
      // ⛔ 恒为 0：本页任何路径都不调 ASR。它出现在状态里就是为了能被验收断言。
      asr_invocations: this.asrInvocations,
      resident: this.graph.snapshot?.() ?? null,
      last_error: this.lastError,
    };
  }

  timelineSlice(n = 400) { return this.timeline.slice(-n); }

  audioPath(seq, which) {
    const dir = path.join(this.dataRoot, `epoch-${Number(seq)}`);
    const file = path.join(dir, `${String(which).replace(/[^a-z0-9]/gi, '')}.wav`);
    return fs.existsSync(file) ? file : null;
  }

  diskBytes() {
    let total = 0;
    try {
      for (const d of fs.readdirSync(this.dataRoot)) {
        const dir = path.join(this.dataRoot, d);
        for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size;
      }
    } catch { /* 目录还没建。 */ }
    return total;
  }

  purge() {
    try { fs.rmSync(this.dataRoot, { recursive: true, force: true }); } catch { /* noop */ }
    this.epochs = [];
  }
}

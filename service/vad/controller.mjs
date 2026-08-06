/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RMS/PCM, KWS handoff, Pipeline close authority, App HTP runtime, and VAD config.
 * [OUTPUT]: Bounded pre-roll, FireRedVAD cuts, atomic WAV records, ASR callbacks, and owner-scoped idle requests.
 * [POS]: VAD/WAV stage; first WAV hands close authority to ASR while VAD keeps cutting later WAVs.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeFbank, FBANK_FRAME_SAMPLES, loadCmvn } from './fbank.mjs';
import { StreamVadPost } from './postprocessor.mjs';
import { ResidentGraph } from '../residents.mjs';

const DEFAULT_RESIDENT_ID = 'tsp-vad-local';
// 五图同驻实测合计 115 MB（docs/051 §2.2）；这里给准入用的保守估值，
// 上机后按 `GET /api/inference/memory` 校正。
const VAD_EST_MEM_MB = 24;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = SAMPLE_RATE * BYTES_PER_SAMPLE / 1000;
const INFERENCE_BATCH_FRAMES = 40;
const ACTIVITY_CAP = 256;

const wavHeader = (pcmBytes) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
};

const tensorStep = (row) => {
  const bytes = Buffer.alloc(row.length * 4);
  for (let index = 0; index < row.length; index += 1) {
    bytes.writeFloatLE(row[index], index * 4);
  }
  return {
    inputs: {
      feat: {
        dtype: 'float32',
        shape: [1, 1, row.length],
        data_b64: bytes.toString('base64'),
      },
    },
  };
};

const cloneJson = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

export class VadController {
  constructor({
    android,
    dataRoot,
    config,
    /**
     * ⛔ **没有默认值**。模型位置由 Framework 的 Asset map 解析
     * （`context.assets.resolve('model.fireredvad')`），不是一条写死的裸路径。
     *
     * 一个「资产缺失时悄悄回落到旧路径」的默认值，会让依赖门禁形同虚设：
     * 声明的东西没装上，服务照样跑起来，而问题要到别人的机器上才暴露。
     * 拿不到就 throw——起不来比带着未知状态跑更容易查。
     */
    modelRoot,
    residentId = DEFAULT_RESIDENT_ID,
    onSegment = () => {},
    onChange = () => {},
    /**
     * docs/061 §四.3：段**完成时**才判断要不要丢，且必须在写 WAV 之前——
     * 「不保存 WAV、不 enqueue ASR、不产生 transcript」是三件事，写了再删只做到了一件。
     */
    dropPolicy = () => null,
  }) {
    this.android = android;
    this.dataRoot = dataRoot;
    /**
     * ⭐ **暂存区**，不是水库（docs/061 §八）。
     *
     * 每个被接受的段在这里落一次盘，随即被记录组 `accept()` **移动**进它那一组的目录——
     * 于是全流程只有一份 WAV。旧的 `segments.v1.jsonl` 索引、FIFO 上限与孤儿清扫
     * 一并删除：那套机制的所有者语义已经由记录组接管，两套并存只会让
     * 「这条音频归谁管」再也说不清。⛔ 旧文件本身不删、不迁、不读。
     */
    this.wavRoot = path.join(dataRoot, 'wav');
    this.onChange = onChange;
    this.onSegment = onSegment;
    this.dropPolicy = dropPolicy;
    this.config = { ...config };
    if (!modelRoot) throw new Error('VadController requires a resolved modelRoot from the asset map');
    this.modelRoot = modelRoot;
    this.modelPath = path.join(modelRoot, 'model.onnx');
    this.cmvnPath = path.join(modelRoot, 'cmvn.bin');
    this.graph = new ResidentGraph({
      android,
      id: residentId,
      model: 'fireredvad',
      // ⭐ 给绝对路径，不只给名字。只给名字时 App 会按它自己的 htp_models_dir 去拼，
      // 于是 cmvn 来自 asset store 而**图来自旧裸路径**——两份都在时看起来完全正常。
      modelPath: this.modelPath,
      estMemMb: VAD_EST_MEM_MB,
    });
    this.transport = null;
    this.pool = [];
    this.poolBytes = 0;
    this.poolFloorMs = 0;
    this.admitted = false;
    this.gateTransitionSeq = 0;
    this.poolOpenedAtMs = null;
    this.active = false;
    this.runId = null;
    this.trigger = null;
    this.armedAtMs = null;
    this.lastOutputAtMs = null;
    this.closeRequested = false;
    this.closeAuthority = false;
    this.timeline = Buffer.alloc(0);
    this.timelineStartedAtMs = null;
    // App 单调时钟上的 timeline 起点（来自 PCM 锚）。跨进程判定相交只能用它，
    // 墙上时间在两个进程里不是同一把尺（docs/061 §四.4）。
    this.timelineStartedMonoMs = null;
    this.captureGeneration = null;
    /** 本次运行中采集中断过的时刻。跨过任何一个的段都必须作废。 */
    this.captureBreaks = [];
    this.drops = { total: 0, tts_overlap: 0, capture_interrupted: 0, last: null };
    this.timelineBaseFrame = 1;
    this.sampleQueue = [];
    this.pendingFeatures = [];
    this.resetNext = true;
    this.inferenceInFlight = false;
    this.retryTimer = null;
    this.sessionReady = false;
    this.modelsReady = false;
    this.post = new StreamVadPost();
    this.speechStartFrame = null;
    this.vadActive = false;
    this.lastProbability = null;
    this.lastGradientCut = null;
    this.gradientCuts = 0;
    this.lastInferenceMs = null;
    this.lastError = null;
    this.lastDownstreamError = null;
    this.segmentsTotal = 0;
    this.lastSegment = null;
    this.activityRing = [];
    this.activitySeq = 0;
    this.cmvn = null;
    this.presenceCache = null;
    // ⚠ `segments_total` 现在只数**本次运行发布了几段**。它曾经是索引文件的行数，
    // 即一个全生命周期累计值——那正是这一轮要拿掉的东西（docs/061 §七）。
  }

  configure(config) {
    this.config = { ...this.config, ...config };
    this.prunePool();
    return this.publicConfig();
  }

  publicConfig() {
    return {
      pcm_pool_ms: this.config.pcm_pool_ms,
      no_output_timeout_ms: this.config.no_output_timeout_ms,
    };
  }

  /**
   * 模型文件在不在。⚠ **必须缓存**：`snapshot()` 是高频域，而这两个 `existsSync`
   * 会随着它一起被拉进音频路径——观测不该有资格让处理链去碰磁盘（docs/061 §1）。
   * 2 秒的过期时间足够让「文件被删了」在页面上看得见，又不会变成每帧两次系统调用。
   */
  filesPresent(nowMs = Date.now()) {
    if (this.presenceCache && nowMs - this.presenceCache.at_ms < 2000) {
      return this.presenceCache.value;
    }
    const value = fs.existsSync(this.modelPath) && fs.existsSync(this.cmvnPath);
    this.presenceCache = { value, at_ms: nowMs };
    return value;
  }

  setCloseAuthority(active) {
    this.closeAuthority = active === true;
    if (!this.closeAuthority) this.closeRequested = false;
    return this.snapshot();
  }

  /**
   * 启动即声明，不等第一次调用。
   *
   * 产品形态是「KWS 前待机不卸载，KWS 通过后立刻工作」（docs/053）。若声明发生在第一次
   * `stream()` 里，那么第一次唤醒要现场付载入——恰好把代价放在唯一在意延迟的那条路径上。
   */
  async ensureResident() {
    this.ensureModelFiles();
    await this.graph.declare();
    return this.graph.snapshot();
  }

  /**
   * 卸载常驻。⛔ **只有两个调用方**：使用者明确停链，和听写保温到期（docs/061 §一）。
   * 服务重启、dev reload、PCM 断流、Mic 被抢占、requester 短暂切换——一律不许走到这里，
   * 那些正是 docs/046 记下的「反复 create/delete 污染 QNN context 致 SIGSEGV」的来源。
   */
  async unloadResident() {
    this.resetRun('resident_unload');
    await this.graph.undeclare();
    this.sessionReady = false;
    this.onChange();
    return this.graph.snapshot();
  }

  observeTransport(snapshot) {
    this.transport = snapshot ? { ...snapshot } : null;
  }

  /**
   * Gate 转换只影响 VAD 的**运行**，不再影响 Pool 的**滚动**。
   *
   * 旧行为是「RMS OPEN 后才开始写 Pool」，而 `avg_1s` 的固有滞后让 OPEN 比说话起点晚
   * 300–400 ms——于是 VAD 拿到的 timeline 开头本来就缺了唤醒词的前 300–400 ms。
   * 现在 Pool 是一条恒定滚动的 6 秒环形缓冲（约 192 KB），代价可忽略，而
   * pre-roll 永远完整；这同时也是「KWS HIT 作为第二把钥匙」能成立的前提——
   * 那条路径开门时 Pool 里必须已经有音频。
   */
  observeGate(gate, nowMs = Date.now()) {
    const open = gate?.state === 'open' && gate?.pcm_admission === 'allow';
    const transitionSeq = Math.max(0, Number(gate?.transition_seq) || 0);
    if (open && (!this.admitted || transitionSeq !== this.gateTransitionSeq)) {
      this.resetRun('new_rms_admission');
      this.admitted = true;
      this.gateTransitionSeq = transitionSeq;
      this.poolOpenedAtMs = Number(gate?.opened_at_ms) || nowMs;
      this.lastError = null;
      this.onChange();
    } else if (!open && this.admitted) {
      this.admitted = false;
      this.poolOpenedAtMs = null;
      this.resetRun(gate?.last_transition?.reason ?? 'rms_gate_closed');
      this.onChange();
    }
    return this.snapshot(nowMs);
  }

  ingestPcm(frame, meta = {}) {
    if (!Buffer.isBuffer(frame) || frame.length === 0 || frame.length % 2 !== 0) return;
    const atMs = Number(meta.observed_at_ms) || Date.now();
    const monoMs = Number.isFinite(Number(meta.mono_ms)) ? Number(meta.mono_ms) : null;
    const generation = Number.isFinite(Number(meta.capture_generation))
      ? Number(meta.capture_generation) : null;
    // 采集断过（丢帧 / AudioRecord 重建 / 被静音后恢复）：记下这个时刻。
    // 不清空 timeline——一段横跨这个洞的音频**中间少了一截**，它不该被识别成一句连贯的话。
    const broke = meta.gap === true
      || (generation !== null && this.captureGeneration !== null && generation !== this.captureGeneration);
    if (generation !== null) this.captureGeneration = generation;
    if (broke) this.noteCaptureBreak(monoMs ?? atMs);
    const saved = Buffer.from(frame);
    this.pool.push({ pcm: saved, at_ms: atMs, mono_ms: monoMs });
    this.poolBytes += saved.length;
    this.prunePool(atMs);
    if (!this.active) return;
    this.timeline = Buffer.concat([this.timeline, frame]);
    this.appendFeatureSamples(frame);
    this.extractReadyFeatures();
    this.scheduleInference();
  }

  noteCaptureBreak(monoMs) {
    if (!Number.isFinite(Number(monoMs))) return;
    this.captureBreaks.push(Number(monoMs));
    while (this.captureBreaks.length > 64) this.captureBreaks.shift();
  }

  /** 本次会话可用的 pre-roll：Pool 里晚于上一次会话结束的那部分。 */
  eligiblePool() {
    return this.pool.filter((item) => item.at_ms >= this.poolFloorMs);
  }

  async arm(trigger, nowMs = Date.now()) {
    if (this.active) return this.snapshot(nowMs);
    // Pool 恒滚，所以这里只可能因为「刚开机还没收到帧」而为空。
    const preRoll = this.eligiblePool();
    if (preRoll.length === 0) {
      this.lastError = 'KWS hit arrived before any PCM frame was buffered';
      this.onChange();
      return this.snapshot(nowMs);
    }
    try {
      this.ensureModelFiles();
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.onChange();
      return this.snapshot(nowMs);
    }
    this.active = true;
    this.runId = `vad_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.trigger = cloneJson(trigger);
    this.armedAtMs = nowMs;
    this.lastOutputAtMs = null;
    this.closeRequested = false;
    this.timeline = Buffer.concat(preRoll.map((item) => item.pcm));
    this.timelineStartedAtMs = preRoll[0]?.at_ms ?? nowMs;
    this.timelineStartedMonoMs = Number.isFinite(Number(preRoll[0]?.mono_ms))
      ? Number(preRoll[0].mono_ms) : null;
    this.timelineBaseFrame = 1;
    this.sampleQueue = [];
    this.pendingFeatures = [];
    this.resetNext = true;
    this.post.reset();
    this.speechStartFrame = null;
    this.vadActive = false;
    this.lastProbability = null;
    this.lastGradientCut = null;
    this.gradientCuts = 0;
    this.lastError = null;
    this.appendFeatureSamples(this.timeline);
    this.extractReadyFeatures();
    this.emitActivity(false, nowMs, 'kws_handoff');
    this.scheduleInference();
    this.onChange();
    return this.snapshot(nowMs);
  }

  pollReset(nowMs = Date.now()) {
    if (!this.closeAuthority || !this.active || this.closeRequested) return null;
    const base = this.lastOutputAtMs ?? this.armedAtMs;
    if (base === null || nowMs - base < this.config.no_output_timeout_ms) return null;
    this.closeRequested = true;
    return {
      owner: 'speech.vad',
      reason: 'vad_no_wav_timeout',
      requested_at_ms: nowMs,
    };
  }

  resetRun(reason = 'reset') {
    const wasActive = this.active || this.vadActive;
    // Pool 不清（它是恒滚的），改为抬高地板：上一轮的尾音不再进入下一轮 timeline。
    // 清空 Pool 会把「刚刚说出的唤醒词」一起丢掉，正是我们要修的那个病。
    if (wasActive) this.poolFloorMs = Date.now();
    this.active = false;
    this.runId = null;
    this.trigger = null;
    this.armedAtMs = null;
    this.lastOutputAtMs = null;
    this.closeRequested = false;
    this.closeAuthority = false;
    this.timeline = Buffer.alloc(0);
    this.timelineStartedAtMs = null;
    this.timelineStartedMonoMs = null;
    this.captureBreaks = [];
    this.timelineBaseFrame = 1;
    this.sampleQueue = [];
    this.pendingFeatures = [];
    this.resetNext = true;
    this.post.reset();
    this.speechStartFrame = null;
    this.vadActive = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (wasActive) this.emitActivity(false, Date.now(), reason);
  }

  prunePool(nowMs = Date.now()) {
    const durationMs = Math.max(0, Number(this.config.pcm_pool_ms) || 0);
    const maxBytes = Math.round(durationMs * BYTES_PER_MS);
    const cutoff = nowMs - durationMs;
    while (this.pool.length
      && (this.poolBytes > maxBytes || this.pool[0].at_ms < cutoff)) {
      this.poolBytes -= this.pool.shift().pcm.length;
    }
  }

  ensureModelFiles() {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`FireRedVAD model missing: ${this.modelPath}`);
    }
    if (!fs.existsSync(this.cmvnPath)) {
      throw new Error(`FireRedVAD CMVN missing: ${this.cmvnPath}`);
    }
    if (!this.cmvn) this.cmvn = loadCmvn(fs.readFileSync(this.cmvnPath));
    this.modelsReady = true;
  }

  appendFeatureSamples(pcm) {
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      this.sampleQueue.push(pcm.readInt16LE(offset));
    }
  }

  extractReadyFeatures() {
    if (!this.cmvn || this.sampleQueue.length < 400) return;
    const { feat, frames } = computeFbank(Float64Array.from(this.sampleQueue), this.cmvn);
    if (!frames) return;
    this.pendingFeatures.push(...feat);
    this.sampleQueue.splice(0, frames * FBANK_FRAME_SAMPLES);
  }

  scheduleInference(delayMs = 0) {
    if (!this.active || this.inferenceInFlight || this.pendingFeatures.length === 0) return;
    if (this.retryTimer && delayMs === 0) return;
    if (delayMs > 0) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.pumpInference();
      }, delayMs);
      return;
    }
    setImmediate(() => void this.pumpInference());
  }

  async pumpInference() {
    if (!this.active || this.inferenceInFlight || this.pendingFeatures.length === 0) return;
    this.inferenceInFlight = true;
    const runId = this.runId;
    const batch = this.pendingFeatures.splice(0, INFERENCE_BATCH_FRAMES);
    const reset = this.resetNext;
    let retryDelayMs = 0;
    try {
      const started = Date.now();
      const result = await this.graph.stream({
        reset,
        state_links: { caches_packed: 'new_caches_packed' },
        outputs: ['probs'],
        steps: batch.map(tensorStep),
      });
      this.sessionReady = true;
      if (!this.active || this.runId !== runId) return;
      const probs = result?.values?.probs ?? result?.probs;
      if (!Array.isArray(probs)) throw new Error('FireRedVAD stream returned no probs');
      this.resetNext = false;
      this.lastInferenceMs = Date.now() - started;
      this.lastError = null;
      for (const probability of probs) this.handleProbability(Number(probability));
    } catch (error) {
      if (this.active && this.runId === runId) {
        this.pendingFeatures.unshift(...batch);
        // 可重试的失败（常驻还没对账完 / 有界准入拒绝）意味着这批 step **从未送达 worker**，
        // recurrent state 没有前进。此时强制 `resetNext` 会白扔掉之前所有帧的上下文，
        // 把一次「稍后再来」变成一次真实的精度损失。只有无法归因的失败才保守重置。
        if (error?.retryable !== true) {
          this.sessionReady = false;
          this.resetNext = true;
        }
        this.lastError = String(error?.message ?? error);
        retryDelayMs = Number(error?.retryAfterMs) || 1000;
      }
    } finally {
      this.inferenceInFlight = false;
      this.onChange();
      this.scheduleInference(retryDelayMs);
    }
  }

  handleProbability(probability) {
    this.lastProbability = probability;
    const transition = this.post.process(probability);
    if (transition.start_frame != null && this.speechStartFrame === null) {
      this.speechStartFrame = transition.start_frame;
      this.vadActive = true;
      this.emitActivity(true, Date.now(), 'speech_start');
    }
    // 梯度切点：说话还在继续，只是窗内出现了值得下刀的停顿谷。发布 [start, cut]，
    // 残尾从 cut+1 起继续累计——这正是「回选已观察到的谷、不丢字」的落点。
    if (transition.cut_frame != null && this.speechStartFrame !== null) {
      const startFrame = this.speechStartFrame;
      const segment = this.publishSegment(startFrame, transition.cut_frame);
      if (segment) {
        // 被丢掉的段同样是「已消费」：时间线已经裁过，起点必须跟着走。
        this.speechStartFrame = transition.cut_frame + 1;
        if (!segment.dropped) {
          this.lastGradientCut = { ...transition.cut, segment_id: segment.segment_id };
          this.gradientCuts += 1;
          this.emitActivity(true, Date.now(), 'gradient_cut', segment.segment_id);
        }
      }
    }
    if (transition.end_frame != null && this.speechStartFrame !== null) {
      const startFrame = this.speechStartFrame;
      this.speechStartFrame = null;
      this.vadActive = false;
      const segment = this.publishSegment(startFrame, transition.end_frame);
      this.emitActivity(false, Date.now(), 'speech_end', segment?.segment_id ?? null);
      void segment;
    }
  }

  publishSegment(startFrame, endFrame) {
    const totalSamples = Math.floor(this.timeline.length / BYTES_PER_SAMPLE);
    const relativeStartFrame = Math.max(1, startFrame - this.timelineBaseFrame + 1);
    const relativeEndFrame = Math.max(relativeStartFrame, endFrame - this.timelineBaseFrame + 1);
    const startSample = Math.min(
      totalSamples,
      Math.max(0, (relativeStartFrame - 1) * FBANK_FRAME_SAMPLES),
    );
    const endSample = Math.max(
      startSample,
      Math.min(totalSamples, (relativeEndFrame - 1) * FBANK_FRAME_SAMPLES + 400),
    );
    const pcm = this.timeline.subarray(
      startSample * BYTES_PER_SAMPLE,
      endSample * BYTES_PER_SAMPLE,
    );
    if (pcm.length < SAMPLE_RATE / 5 * BYTES_PER_SAMPLE) return null;

    const durationFromSamples = (samples) => Math.round(samples * 1000 / SAMPLE_RATE);
    const startMonoMs = this.timelineStartedMonoMs === null
      ? null : this.timelineStartedMonoMs + durationFromSamples(startSample);
    const endMonoMs = this.timelineStartedMonoMs === null
      ? null : this.timelineStartedMonoMs + durationFromSamples(endSample);
    const dropped = this.evaluateDrop(startMonoMs, endMonoMs);
    if (dropped) {
      // ⭐ 在这里返回意味着：没有 WAV、没有 enqueue、没有 transcript。
      // 时间线照常向前，故下一段仍然完整。
      this.drops.total += 1;
      this.drops[dropped.reason] = (this.drops[dropped.reason] ?? 0) + 1;
      this.drops.last = { ...dropped, start_mono_ms: startMonoMs, end_mono_ms: endMonoMs, at_ms: Date.now() };
      this.lastOutputAtMs = Date.now();
      this.closeRequested = false;
      this.trimPublishedTimeline(endFrame);
      this.emitActivity(false, Date.now(), `dropped:${dropped.reason}`);
      this.onChange();
      // ⚠ 必须与成功一样返回一个「已消费」的信号：这段音频**已经从 timeline 里裁掉了**，
      // 调用方若因为拿到 null 而不推进 speechStartFrame，下一段就会从一个早于
      // timelineBaseFrame 的帧号起算，被钳到时间线开头——切出来的音频从此对不上。
      // 「太短所以没发」与「发过了但丢掉」必须是两个不同的答案。
      return { dropped: true, reason: dropped.reason };
    }

    fs.mkdirSync(this.wavRoot, { recursive: true });
    const segmentId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const wavPath = path.join(this.wavRoot, `${segmentId}.wav`);
    const temporary = `${wavPath}.${process.pid}.tmp`;
    const file = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeSync(file, wavHeader(pcm.length));
      fs.writeSync(file, pcm);
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(temporary, wavPath);
    try { fs.chmodSync(wavPath, 0o600); } catch { /* Shared storage modes are best effort. */ }
    const startAt = (this.timelineStartedAtMs ?? Date.now()) + Math.round(startSample * 1000 / SAMPLE_RATE);
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const record = {
      schema: 'termux-os.vad-wav.v1',
      segment_id: segmentId,
      wav_path: wavPath,
      start_ms: startAt,
      end_ms: startAt + durationMs,
      // App 单调时钟上的区间。墙上时间保留在上面（旧消费者仍读得到），
      // 但跨进程的相交判定只认这两个（docs/061 §四.4）。
      start_mono_ms: startMonoMs,
      end_mono_ms: endMonoMs,
      capture_generation: this.captureGeneration,
      duration_ms: durationMs,
      sample_rate_hz: SAMPLE_RATE,
      channels: 1,
      encoding: 'pcm_s16le',
      trim: {
        leading_non_speech_ms: Math.round(startSample * 1000 / SAMPLE_RATE),
        start_frame: startFrame,
        end_frame: endFrame,
      },
      trigger: cloneJson(this.trigger),
      created_at: new Date().toISOString(),
    };
    // ⛔ 这里曾经再 append 一条 `segments.v1.jsonl`。删掉了：记录组已经拥有这个段，
    // 两份索引意味着两个所有者，而删除的时候只有一个会知道。
    this.segmentsTotal += 1;
    this.lastSegment = record;
    this.lastOutputAtMs = Date.now();
    this.closeRequested = false;
    this.trimPublishedTimeline(endFrame);
    try {
      this.onSegment(cloneJson(record));
      this.lastDownstreamError = null;
    } catch (error) {
      this.lastDownstreamError = String(error?.message ?? error);
    }
    return record;
  }

  /**
   * 两类作废，判据不同但后果一样：
   *  - `capture_interrupted`——这段音频**中间少了一截**（丢帧 / 采集重建 / 静音过），
   *    它已经不是一句连贯的话了。这个判断在本地做，不依赖任何策略。
   *  - `tts_overlap`——与我们自己的 TTS 播放区间相交，由注入的策略回答。
   *
   * ⚠ 没有单调时刻时（App 还没发过锚）**不丢**：宁可多转写一句，也不要因为
   * 「不知道」就静默吃掉使用者真的说过的话。
   */
  evaluateDrop(startMonoMs, endMonoMs) {
    if (startMonoMs === null || endMonoMs === null) return null;
    const broke = this.captureBreaks.find((at) => at >= startMonoMs && at <= endMonoMs);
    if (broke !== undefined) return { reason: 'capture_interrupted', at_mono_ms: broke };
    let verdict = null;
    try {
      verdict = this.dropPolicy({
        start_mono_ms: startMonoMs,
        end_mono_ms: endMonoMs,
        capture_generation: this.captureGeneration,
      });
    } catch (error) {
      this.lastError = `drop policy failed: ${String(error?.message ?? error)}`;
      return null;
    }
    if (!verdict) return null;
    return typeof verdict === 'string' ? { reason: verdict } : verdict;
  }

  trimPublishedTimeline(endFrame) {
    const completedFrames = Math.max(0, endFrame - this.timelineBaseFrame + 1);
    const dropSamples = Math.min(
      Math.floor(this.timeline.length / BYTES_PER_SAMPLE),
      completedFrames * FBANK_FRAME_SAMPLES,
    );
    if (dropSamples <= 0) return;
    this.timeline = Buffer.from(this.timeline.subarray(dropSamples * BYTES_PER_SAMPLE));
    const advancedMs = Math.round(dropSamples * 1000 / SAMPLE_RATE);
    if (this.timelineStartedAtMs !== null) this.timelineStartedAtMs += advancedMs;
    if (this.timelineStartedMonoMs !== null) this.timelineStartedMonoMs += advancedMs;
    this.timelineBaseFrame = endFrame + 1;
  }

  emitActivity(active, observedMs, reason, segmentId = null) {
    const observation = {
      schema: 'termux-os.speech-activity.v1',
      seq: ++this.activitySeq,
      observed_ms: Math.max(Number(observedMs) || Date.now(), this.activityRing.at(-1)?.observed_ms + 1 || 0),
      active: active === true,
      recording_ms: this.speechStartFrame === null
        ? 0
        : Math.max(0, (this.post.frameCount - this.speechStartFrame) * 10),
      last_segment_id: segmentId ?? this.lastSegment?.segment_id ?? null,
      source: 'termux-speech-fireredvad',
      reason,
    };
    this.activityRing.push(observation);
    while (this.activityRing.length > ACTIVITY_CAP) this.activityRing.shift();
  }

  activity(after = 0) {
    const cursor = Math.max(0, Number(after) || 0);
    const observations = this.activityRing
      .filter((item) => item.observed_ms > cursor)
      .map((item) => ({ ...item }));
    return {
      schema: 'termux-os.speech-activity-feed.v1',
      observations,
      next: observations.at(-1)?.observed_ms ?? cursor,
    };
  }

  snapshot(nowMs = Date.now()) {
    const countdownBase = this.lastOutputAtMs ?? this.armedAtMs;
    const deadline = this.closeAuthority && this.active && countdownBase !== null
      ? countdownBase + this.config.no_output_timeout_ms
      : null;
    const poolDurationMs = Math.round(this.poolBytes / BYTES_PER_MS);
    const state = !this.admitted
      ? 'standby'
      : !this.active ? 'pooling'
        : this.vadActive ? 'speech'
          : 'processing';
    return {
      schema: 'termux-os.speech-vad.v1',
      capability: 'speech.activity',
      state,
      ready: this.modelsReady && this.sessionReady && this.transport?.connected === true,
      model: {
        id: 'fireredvad',
        model_path: this.modelPath,
        cmvn_path: this.cmvnPath,
        files_present: this.filesPresent(),
        runtime: 'android-app-ort-qnn-htp',
        // 常驻 id 即 worker 侧 session 名——同一个字符串，两个视角。
        session: this.graph.id,
        residency: this.graph.snapshot(),
        sessions_ready: this.sessionReady,
      },
      pcm_pool: {
        owner: 'termux-speech-vad',
        purpose: 'vad_preroll',
        used_by_kws: false,
        scope: 'package-memory',
        transport: 'authenticated_app_loopback_ws',
        connected: this.transport?.connected === true,
        // Pool 恒滚：只要 PCM 到得来就在写，与 Gate 无关。
        writing: this.transport?.connected === true,
        rolling: 'always',
        admission: this.admitted ? 'allow' : 'block',
        floor_at_ms: this.poolFloorMs || null,
        eligible_ms: Math.round(
          this.eligiblePool().reduce((sum, item) => sum + item.pcm.length, 0) / BYTES_PER_MS,
        ),
        configured_ms: this.config.pcm_pool_ms,
        max_ms: 6000,
        duration_ms: Math.min(this.config.pcm_pool_ms, poolDurationMs),
        retained_bytes: this.poolBytes,
        started_at_ms: this.poolOpenedAtMs,
      },
      handoff: {
        active: this.active,
        close_authority: this.closeAuthority,
        run_id: this.runId,
        trigger: cloneJson(this.trigger),
        armed_at_ms: this.armedAtMs,
        pre_roll_ms: this.active && this.timelineStartedAtMs !== null && this.armedAtMs !== null
          ? Math.max(0, this.armedAtMs - this.timelineStartedAtMs)
          : 0,
      },
      activity: {
        active: this.vadActive,
        probability: this.lastProbability,
        processed_frames: this.post.frameCount,
      },
      // 梯度式切句：段越长对停顿谷的质量要求越低，回选窗内最优谷下刀。
      gradient: {
        enabled: this.post.options.gradient !== false,
        cuts: this.gradientCuts,
        last: cloneJson(this.lastGradientCut),
        need_curve_ms: [
          this.post.options.startFrames * 10,
          this.post.options.pressureFrames * 10,
          this.post.options.limitFrames * 10,
        ],
      },
      countdown: {
        owner: 'speech.vad',
        authoritative: this.closeAuthority,
        timeout_ms: this.config.no_output_timeout_ms,
        deadline_ms: deadline,
        remaining_ms: deadline === null ? null : Math.max(0, deadline - nowMs),
        resets_on: 'wav_output',
      },
      wav: {
        owner: 'termux-speech-records',
        staging_root: this.wavRoot,
        format: 'wav_pcm_s16le_16khz_mono',
        // 本次运行发布的段数。⚠ 不是累计：盘上有几组、留了多少条由记录组回答。
        segments_published: this.segmentsTotal,
        last_segment: cloneJson(this.lastSegment),
        downstream: 'speech.asr',
        downstream_connected: this.lastDownstreamError === null,
        downstream_error: this.lastDownstreamError,
      },
      // docs/061 §四.3：只保留**本次运行**的计数与最后原因，不建立新的永久累计历史。
      drops: {
        total: this.drops.total,
        tts_overlap: this.drops.tts_overlap,
        capture_interrupted: this.drops.capture_interrupted,
        last: cloneJson(this.drops.last),
        capture_breaks: this.captureBreaks.length,
      },
      timeline: {
        started_mono_ms: this.timelineStartedMonoMs,
        capture_generation: this.captureGeneration,
        // 没有锚就没有时基——如实说「判不了」，而不是让相交判定静默地永远返回否。
        mono_available: this.timelineStartedMonoMs !== null,
      },
      last_inference_ms: this.lastInferenceMs,
      last_error: this.lastError,
      observed_at_ms: nowMs,
    };
  }

  close() {
    this.resetRun('service_stop');
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: PCM 分流（consumer `speaker`）+ 自己那张 FireRedVAD 常驻图 + CAM++ CPU 图
 * [OUTPUT]: 声纹登记 + **实时滑窗 USER-VAD 时间轴**（similarity / 迟滞 / USER-OTHER / episode）
 * [POS]: docs/080。⛔ 到 similarity 与 episode WAV 为止：不进 SenseVoice、
 *        不 `records.admit`、不占 50 句 group。全部事件带 `debug_only=true`。
 *
 * ⭐ 本轮最重要的结构改变：**CAM++ 的窗不再由 FireRedVAD 的 segment 决定。**
 *   离线 PoC 证明了那样会误杀使用者——背景持续说话时段边界由背景决定，
 *   用户那一句只是被包在中间，整段 embedding 被背景主导。
 *   现在是：连续 PCM → rolling buffer → 每 step_ms 取最近 window_ms → CAM++。
 *   FireRedVAD 仍然跑，但**只提供一个可显示的概率**，不参与切窗、不参与判决。
 *
 * ⛔ 它不是 mic 总开关：`speaker` 只是 `PcmConsumers` 里的一个名字（docs/077）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { computeFbank, loadCmvn } from './vad/fbank.mjs';
import { ResidentGraph } from './residents.mjs';
import { SpeakerProfile, describe } from './speaker/profile.mjs';
import { calibrationStatus } from './speaker/gate.mjs';
import { PcmRing, SR } from './speaker/pcm-ring.mjs';

/** 孤儿录音的去处。⛔ 不与登记录音同目录——否则 glob 又会把它们混在一起。 */
const ORPHAN_DIR = 'orphans';
import { UserVadState, LabelStats, USERVAD_DEFAULTS, RECOMMENDED_WINDOWS }
  from './speaker/uservad.mjs';

const FRAME_MS = 10;
const HOP = SR * FRAME_MS / 1000;
const WIN = SR * 25 / 1000;
const BATCH_FRAMES = 40;
const VAD_EST_MEM_MB = 24;

const KEEP_EPISODES = 10;
const KEEP_TIMELINE = 400;                 // 最近 100 秒 @ 250 ms
const PRE_ROLL_MS = 1500;
const POST_ROLL_MS = 1000;
/** 登记仍然按「一段连续人声」切——登记要的就是完整一句，与实时判定无关。 */
export const ENROLL_DEFAULTS = Object.freeze({
  vad_speech: 0.60, close_silence_ms: 500, hard_cap_ms: 10_000, min_segment_ms: 1000,
});

const wavHeader = (bytes) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
};

export class SpeakerLab {
  /** @param vadGraph 已经路由好的图参数（见 `executableGraphArgs`）；⛔ 不是裸路径。 */
  constructor({ android, vadGraph = null, vadCmvnFile = null, residentId, embedder, dataRoot, onChange = () => {} }) {
    this.android = android;
    this.executable = vadGraph ?? null;
    /** 「文件在不在」与报错用的那一份；⛔ 不拿它去当 model_path。 */
    this.modelPath = vadGraph?.path ?? null;
    /** ⭐ 与 [VadController.applyLogical] 同一件事：可执行体是会迟到的事实。 */
    this.applyLogical = ({ graph: g, cmvnFile: c } = {}) => {
      if (this.modelPath) return false;
      if (!g?.path) return false;
      this.executable = g; this.modelPath = g.path;
      if (c) this.vadCmvnFile = c;
      return true;
    };
    this.cmvnPath = vadCmvnFile;
    this.dataRoot = path.resolve(dataRoot);
    this.profilePath = path.join(this.dataRoot, 'profile.json');
    this.onChange = onChange;
    this.embedder = embedder;
    /**
     * ⭐ 登记台自己那张 VAD 是**临时会话**：只在使用者点「登记 / 测试」期间存在。
     * ⛔ 不是常驻（docs/096 把常驻所有权收给 App 了），而退役常驻时这条路径被一起
     *   切断——症状是登记时 `no such resident`，一个没有人再声明的 id。
     */
    this.vad = new ResidentGraph({
      android, id: residentId, model: 'fireredvad',
      modelPath: vadGraph?.modelPath ?? null,
      ctxPath: vadGraph?.ctxPath ?? null,
      ctxKey: vadGraph?.ctxKey ?? null,
      estMemMb: VAD_EST_MEM_MB, ephemeral: true,
    });
    this.cmvn = null;

    this.mode = 'idle';                    // idle | enrolling | testing
    this.enrollConfig = { ...ENROLL_DEFAULTS };
    this.profile = this.#loadProfile();
    this.uservad = new UserVadState(this.#loadRuntimeConfig());
    this.labels = new LabelStats();

    /**
     * ⭐ **登记样本索引必须能挺过重启。**
     *
     * ⚠ 这里原本是 `[]`，且**只在一次现场登记过程中**被填充。于是服务一重启：
     *   盘上 7 个 WAV 还在、`profile.enrollments` 还是 7、`/speaker/audio` 照样 200，
     *   而页面上的样本列表**空的**——使用者看到「已登记 7 段」却一个也点不了、听不了、删不了。
     * ⭐ 修法不需要新的持久化格式：`profile.json` 里已经存着 `id / duration_ms / at_ms`，
     *   而 WAV 的文件名就是 `${id}.wav`。索引是**可以从既有事实重建**的，
     *   ⛔ 再存一份等于给同一件事造第二个真相。
     */
    this.enrollClips = this.#restoreEnrollClips();
    /**
     * ⭐ **开机把孤儿录音扫进 `orphans/`。**
     *
     * ⚠ 这不是洁癖：`speaker-lab/` 下曾同时躺着 17 个 `enroll-*.wav` 而 profile 只认 7 个，
     *   于是任何 `ls enroll-*` 选出来的文件都**可能不是登记过的那段**——
     *   一次真机排障就因此把「CAM++ 坏了」的结论追了整整一轮，而 CAM++ 一直是好的。
     * ⛔ 只**移动**不删除：它们是使用者的录音，删不删是他的决定（`/speaker/enroll/orphans`）。
     */
    this.sweptOrphans = this.#sweepOrphanEnrollWavs();
    this.timeline = [];
    this.episodes = this.#loadEpisodes();
    this.episodeSeq = this.episodes.reduce((m, e) => Math.max(m, e.seq), 0);
    this.lastError = null;
    this.lastVadProb = null;
    this.inferenceMs = [];
    this.skippedWindows = 0;
    this.startedAtMs = null;

    this.#resetStream();
  }

  // ────────────────────────────────────────────────────── 状态
  #resetStream() {
    this.pendingFeatures = [];
    this.tail = Buffer.alloc(0);
    this.resetNext = true;
    this.smooth = [];
    this.audioMs = 0;
    this.vadInFlight = false;
    // 滑窗
    this.ring = new PcmRing(this.uservad?.config?.window_ms ?? 1500);
    this.preRoll = new PcmRing(PRE_ROLL_MS + 2000);
    this.msSinceWindow = 0;
    this.camInFlight = false;
    this.episode = null;
    // 登记
    this.segment = null;
    this.silenceMs = 0;
  }

  /**
   * 从磁盘重建 episode 索引。
   *
   * ⚠ 真机踩到：WAV 落盘、列表只在内存里，服务一重启页面就**再也够不到它们**——
   *   而那几段音频正是「刚才那个高分到底是不是本人」的唯一证据，文件还在，入口没了。
   * ⛔ 恢复出来的条目**不补造**它当时的 similarity 与标签：那两样只存在于内存，
   *   猜一个数比没有更糟。`recovered: true` 明说这一条是从文件重建的。
   */
  #loadEpisodes() {
    try {
      return fs.readdirSync(this.dataRoot)
        .filter((name) => /^episode-\d+\.wav$/.test(name))
        .map((wav) => {
          const stat = fs.statSync(path.join(this.dataRoot, wav));
          return {
            seq: Number(wav.match(/(\d+)/)[1]),
            wav,
            recovered: true,
            label: null,
            close_reason: 'recovered_from_disk',
            duration_ms: Math.round(Math.max(0, stat.size - 44) / 2 / SR * 1000),
            user_duration_ms: null,
            peak_similarity: null,
            mean_similarity: null,
            at_ms: stat.mtimeMs,
            source: 'speaker_lab', debug_only: true,
          };
        })
        .sort((a, b) => b.seq - a.seq)
        .slice(0, KEEP_EPISODES);
    } catch { return []; }
  }

  #loadProfile() {
    try {
      return SpeakerProfile.fromJSON(JSON.parse(fs.readFileSync(this.profilePath, 'utf8')));
    } catch { return new SpeakerProfile(); }
  }

  /**
   * ⭐ runtime 配置与声纹**分开存**：声纹是「你是谁」，
   *   window/threshold 是「这次实验怎么判」。混在一起会让人以为
   *   段级的 0.57 和 1.5 s 滑窗的 0.30 是同一个东西。
   */
  #runtimePath() { return path.join(this.dataRoot, 'uservad.json'); }

  /**
   * ⚠ `acked_for` 与滑窗参数存在同一个文件里，但**不是配置的一部分**——
   *   它是「使用者确认过这个阈值配这份声纹」这件事的记录。
   *   混进 `config` 会被 `UserVadState.configure()` 当成一个可调数字，
   *   然后在某次 `{...DEFAULTS, ...config}` 里悄悄变成判决的一部分。
   */
  #loadRuntimeConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#runtimePath(), 'utf8'));
      const { acked_for: acked, ...config } = raw ?? {};
      this.ackedFor = acked && typeof acked === 'object' ? acked : null;
      return config;
    } catch { this.ackedFor = null; return { ...USERVAD_DEFAULTS }; }
  }

  #saveRuntimeConfig() {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(this.#runtimePath(),
      JSON.stringify({ ...this.uservad.config, acked_for: this.ackedFor ?? null }));
  }

  /**
   * 生产链读的那一份。⭐ **校准台只有一个**：正式声纹门不另存声纹、不另存阈值，
   *   于是「页面上看到的」与「判决用的」不可能是两个数（docs/056 那个形状）。
   */
  calibration() {
    const config = { ...this.uservad.config };
    const fingerprint = this.profile.fingerprint;
    return {
      profile: this.profile,
      profile_ready: this.profile.ready,
      profile_fingerprint: fingerprint,
      config,
      acked_for: this.ackedFor ?? null,
      status: calibrationStatus({
        profileReady: this.profile.ready, fingerprint, config, ackedFor: this.ackedFor ?? null,
      }),
    };
  }

  saveProfile() {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(this.profilePath, JSON.stringify(this.profile.toJSON()));
  }

  ensureFiles() {
    if (!this.modelPath) throw new Error('FireRedVAD logical executable is unavailable');
    if (!this.cmvnPath) throw new Error('FireRedVAD logical companion cmvn is unavailable');
    if (!fs.existsSync(this.modelPath)) throw new Error(`FireRedVAD model missing: ${this.modelPath}`);
    if (!fs.existsSync(this.cmvnPath)) throw new Error(`FireRedVAD CMVN missing: ${this.cmvnPath}`);
    if (!this.cmvn) this.cmvn = loadCmvn(fs.readFileSync(this.cmvnPath));
  }

  async ensureResidents() {
    this.ensureFiles();
    await this.vad.declare();
    await this.embedder.ensure();
    return { vad: this.vad.snapshot(), campplus: this.embedder.snapshot() };
  }

  async start(mode) {
    await this.ensureResidents();
    this.#resetStream();
    this.uservad.reset();
    /**
     * ⭐ 标签复位。真机踩过：上一轮脚本把标签留在 `OTHER_NEAR`，
     *   使用者接着登记自己的声纹并测试，**说的每一句都被记进「另一个人」那一栏**——
     *   判决是对的（8 次 OTHER→USER），错的是统计，而统计又喂给建议阈值。
     *   标签是对「**这一次**录音」的陈述，带进下一次就是替别人说谎。
     */
    this.labels.setLabel('UNLABELED');
    this.mode = mode;
    this.startedAtMs = Date.now();
    this.onChange();
    return this.snapshot();
  }

  /**
   * ⭐ **临时会话必须真的走。**
   *
   * ⚠ 「用完就走」是这两张图存在的**全部理由**：`tsp-*-spk` 是一个 HTP 会话，
   *   而 docs/096 收走 speech 的常驻所有权，正是因为这种图会一直占着而没人说得出来。
   *   建了不删 = 换了个名字的常驻。⛔ 不许只把 `mode` 置成 idle 就算收工。
   * ⚠ 失败只记不抛：登记已经结束了，「没删掉」不该表现成「登记失败」。
   */
  async #releaseGraphs(reason) {
    for (const [name, g] of [['vad', this.vad], ['campplus', this.embedder]]) {
      try {
        await g.release?.() ?? await g.undeclare?.();
      } catch (error) {
        this.lastError = `release ${name} (${reason}): ${String(error?.message ?? error)}`;
      }
    }
  }

  async stop() {
    if (this.segment) void this.#closeEnrollSegment('stopped');
    if (this.episode) this.#finishEpisode('stopped');
    this.mode = 'idle';
    await this.#releaseGraphs('stopped');
    this.onChange();
    return this.snapshot();
  }

  /** Mic 总开关关掉时调用：回 idle，**且不自行恢复**（要人再点一次）。 */
  forceIdle(reason = 'mic_off') {
    if (this.mode === 'idle') return;
    this.lastError = null;
    if (this.episode) this.#finishEpisode(reason);
    this.segment = null;
    this.mode = 'idle';
    // ⛔ 同上：回 idle 也必须把那两个临时会话交回去。
    void this.#releaseGraphs(reason);
    this.onChange();
  }

  // ────────────────────────────────────────────────────── PCM
  ingest(frame) {
    if (this.mode === 'idle') return;
    this.preRoll.push(frame);
    if (this.mode === 'testing') {
      this.ring.push(frame);
      this.msSinceWindow += frame.length / 2 / SR * 1000;
      if (this.msSinceWindow >= this.uservad.config.step_ms) {
        this.msSinceWindow = 0;
        void this.#runWindow();
      }
      if (this.episode) this.episode.pcm.push(Buffer.from(frame));
    }
    // FireRedVAD 只为显示概率（以及登记时切段）而跑——⛔ 不参与切 CAM++ 的窗。
    const buf = Buffer.concat([this.tail, frame]);
    const total = buf.length / 2;
    const n = Math.max(0, Math.floor((total - WIN) / HOP) + 1);
    if (n <= 0) { this.tail = buf; return; }
    const samples = new Int16Array(total);
    for (let i = 0; i < total; i += 1) samples[i] = buf.readInt16LE(i * 2);
    const { feat } = computeFbank(samples, this.cmvn);
    if (feat.length) this.pendingFeatures.push(...feat);
    const consumed = n * HOP * 2;
    if (this.segment) this.segment.pcm.push(Buffer.from(buf.subarray(0, consumed)));
    this.tail = Buffer.from(buf.subarray(consumed));
    void this.#pumpVad();
  }

  /**
   * 跑一个滑窗。⛔ **单飞**：上一次还没回来就跳过并计数——
   *   排队会让延迟越积越大，而「跳过了几次」必须说出来，不能假装每步都算了。
   */
  async #runWindow() {
    if (this.camInFlight) { this.skippedWindows += 1; return; }
    const wMs = this.uservad.config.window_ms;
    const chunk = this.ring.tail(wMs);
    if (!chunk) return;                     // 还没攒够一个窗
    if (!this.profile.ready) return;        // 没有声纹就不必推理（也不会有判决）
    this.camInFlight = true;
    try {
      const samples = new Int16Array(chunk.length / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = chunk.readInt16LE(i * 2);
      const e = await this.embedder.embed(samples);
      const sim = this.profile.score(e.embedding);
      const endMs = this.audioMs;
      const entry = this.uservad.push({
        similarity: sim, monoMs: Date.now(),
        windowStartMs: Math.max(0, Math.round(endMs - wMs)), windowEndMs: Math.round(endMs),
        inferenceMs: e.inference_ms, vadProbability: this.lastVadProb,
      });
      entry.label = this.labels.label;      // 只是标注，不参与判决
      // ⛔ 跨越标签切换的窗不进统计——窗里混着两类音频。
      this.labels.add(sim, this.lastVadProb, this.labels.isPure(this.uservad.config.window_ms));
      this.inferenceMs.push(e.inference_ms);
      if (this.inferenceMs.length > 400) this.inferenceMs.shift();
      this.timeline.push(entry);
      if (this.timeline.length > KEEP_TIMELINE) this.timeline.shift();
      this.#driveEpisode(entry);
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
    } finally {
      this.camInFlight = false;
      this.onChange();
    }
  }

  async #pumpVad() {
    if (this.vadInFlight || !this.pendingFeatures.length) return;
    this.vadInFlight = true;
    const batch = this.pendingFeatures.splice(0, BATCH_FRAMES);
    const reset = this.resetNext;
    try {
      const r = await this.vad.stream({
        reset,
        state_links: { caches_packed: 'new_caches_packed' },
        outputs: ['probs'],
        steps: batch.map((row) => ({
          inputs: { feat: { dtype: 'float32', shape: [1, 1, row.length],
                            data_b64: Buffer.from(Float32Array.from(row).buffer).toString('base64') } },
        })),
      });
      this.resetNext = false;
      const probs = r?.values?.probs ?? r?.probs;
      if (!Array.isArray(probs)) throw new Error('speaker VAD returned no probs');
      for (const p of probs) this.#vadStep(Number(p));
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      if (error?.retryable === true) this.pendingFeatures.unshift(...batch);
      else this.resetNext = true;
    } finally {
      this.vadInFlight = false;
      if (this.pendingFeatures.length >= BATCH_FRAMES) void this.#pumpVad();
    }
  }

  #vadStep(prob) {
    this.smooth.push(prob);
    if (this.smooth.length > 5) this.smooth.shift();
    const sm = this.smooth.reduce((a, b) => a + b, 0) / this.smooth.length;
    this.lastVadProb = Number(sm.toFixed(4));
    this.audioMs += FRAME_MS;
    if (this.mode !== 'enrolling') return;
    const c = this.enrollConfig;
    const speech = sm >= c.vad_speech;
    if (speech) {
      this.silenceMs = 0;
      if (!this.segment) this.segment = { start_ms: this.audioMs, pcm: [] };
    } else if (this.segment) {
      this.silenceMs += FRAME_MS;
      if (this.silenceMs >= c.close_silence_ms) { void this.#closeEnrollSegment('silence'); return; }
    }
    if (this.segment && this.audioMs - this.segment.start_ms >= c.hard_cap_ms) {
      void this.#closeEnrollSegment('hard_cap');
    }
  }

  // ────────────────────────────────────────────────────── 登记
  async #closeEnrollSegment(reason) {
    const seg = this.segment;
    this.segment = null;
    this.silenceMs = 0;
    if (!seg) return;
    const pcm = Buffer.concat(seg.pcm);
    const durationMs = Math.round(pcm.length / 2 / SR * 1000);
    if (durationMs < this.enrollConfig.min_segment_ms) return;   // 太短，连 WAV 都不留
    const id = `enroll-${this.enrollClips.length + 1}-${Date.now() % 100000}`;
    const wav = `${id}.wav`;
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(path.join(this.dataRoot, wav), Buffer.concat([wavHeader(pcm.length), pcm]));
    try {
      const samples = new Int16Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2);
      const e = await this.embedder.embed(samples);
      this.profile.addEnrollment(e.embedding, { id, duration_ms: durationMs });
      this.saveProfile();
      this.enrollClips.unshift({ id, duration_ms: durationMs, wav, status: 'OK', at_ms: Date.now(),
                                 inference_ms: e.inference_ms, close_reason: reason });
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      // ⛔ 算不出来记 ERROR，绝不悄悄丢掉——使用者要知道这一段没进声纹。
      this.enrollClips.unshift({ id, duration_ms: durationMs, wav, status: 'ERROR', at_ms: Date.now(),
                                 error: this.lastError, close_reason: reason });
    }
    while (this.enrollClips.length > 24) this.enrollClips.pop();
    this.onChange();
  }

  // ────────────────────────────────────────────────────── episode
  #driveEpisode(entry) {
    if (entry.transition === 'OTHER->USER' && !this.episode) {
      this.episodeSeq += 1;
      const pre = this.preRoll.tail(PRE_ROLL_MS);
      this.episode = {
        seq: this.episodeSeq, label: this.labels.label, started_at_ms: Date.now(),
        pcm: pre ? [Buffer.from(pre)] : [], sims: [], user_windows: 0, closing: null,
      };
    }
    if (!this.episode) return;
    this.episode.sims.push(entry.similarity);
    if (entry.state === 'USER') this.episode.user_windows += 1;
    if (entry.transition === 'USER->OTHER') this.episode.closing = Date.now();
    // post-roll：USER_OFF 之后再收一段再落盘，否则尾音被切掉。
    if (this.episode.closing && Date.now() - this.episode.closing >= POST_ROLL_MS) {
      this.#finishEpisode('user_off');
    }
  }

  #finishEpisode(reason) {
    const ep = this.episode;
    this.episode = null;
    if (!ep) return;
    const pcm = Buffer.concat(ep.pcm);
    if (!pcm.length) return;
    const wav = `episode-${String(ep.seq).padStart(4, '0')}.wav`;
    fs.mkdirSync(this.dataRoot, { recursive: true });
    fs.writeFileSync(path.join(this.dataRoot, wav), Buffer.concat([wavHeader(pcm.length), pcm]));
    const step = this.uservad.config.step_ms;
    this.episodes.unshift({
      seq: ep.seq, label: ep.label, wav, close_reason: reason,
      duration_ms: Math.round(pcm.length / 2 / SR * 1000),
      user_duration_ms: ep.user_windows * step,
      peak_similarity: ep.sims.length ? Number(Math.max(...ep.sims).toFixed(4)) : null,
      mean_similarity: ep.sims.length
        ? Number((ep.sims.reduce((a, b) => a + b, 0) / ep.sims.length).toFixed(4)) : null,
      at_ms: Date.now(), source: 'speaker_lab', debug_only: true,
    });
    while (this.episodes.length > KEEP_EPISODES) {
      const old = this.episodes.pop();
      // ⛔ 连 WAV 一起删，否则 tmp/debug 会一直涨。
      try { fs.rmSync(path.join(this.dataRoot, old.wav), { force: true }); } catch { /* 已不在 */ }
    }
    this.onChange();
  }

  // ────────────────────────────────────────────────────── 对外
  buildProfile() {
    const r = this.profile.build();
    if (r.ok) {
      this.saveProfile();
      /**
       * ⭐ 阈值绑的是 **(声纹, 窗长)**，不只是窗长。
       *   真机对照：TTS 声纹下使用者说话 p50 0.83，换成真人声纹后 p50 只有 0.59——
       *   同一个 0.70 在前者是干净工作点，在后者会把本人挡在门外。
       */
      this.uservad.calibrationStale = true;
    }
    this.onChange();
    return r;
  }

  clearProfile() {
    this.profile.clear();
    this.enrollClips = [];
    // ⛔ 声纹没了，那份「我确认过」也就没有对象了——留着它会让生产链拿旧确认放行新声纹。
    this.ackedFor = null;
    this.#saveRuntimeConfig();
    try { fs.rmSync(this.profilePath, { force: true }); } catch { /* noop */ }
    this.onChange();
    return { ok: true };
  }

  /**
   * 从 profile + 盘上的文件重建登记样本索引。
   *
   * ⚠ 三种不一致都要如实表达，⛔ 不许悄悄跳过：
   *   · profile 里有、文件没了 ⇒ 列出来但标 `MISSING`（使用者要知道那一段听不了了）；
   *   · 文件在、profile 里没有（orphan）⇒ **不进产品列表**（它不属于任何声纹），
   *     只在诊断里报个数——删掉是不可逆的，本轮不做。
   *   · 顺序按 `at_ms` 倒序，与现场登记时 `unshift` 的顺序一致。
   */
  #restoreEnrollClips() {
    const enrollments = this.profile?.enrollments ?? [];
    const clips = [];
    for (const e of enrollments) {
      const wav = `${e.id}.wav`;
      let present = false;
      try { present = fs.statSync(path.join(this.dataRoot, wav)).size > 44; } catch { present = false; }
      clips.push({
        id: e.id,
        duration_ms: e.duration_ms ?? null,
        wav,
        status: present ? 'OK' : 'MISSING',
        at_ms: e.at_ms ?? null,
        restored: true,
        ...(present ? {} : { error: 'wav_missing' }),
      });
    }
    clips.sort((a, b) => (b.at_ms ?? 0) - (a.at_ms ?? 0));
    return clips;
  }

  /** 诊断用：盘上有但不属于任何登记的 WAV。⛔ 只报数，不删。 */
  /** 孤儿现在住在 `orphans/`。⚠ 仍然要数得出来——搬走不等于让它消失。 */
  orphanEnrollWavs() {
    try {
      return fs.readdirSync(path.join(this.dataRoot, ORPHAN_DIR))
        .filter((f) => f.startsWith('enroll-') && f.endsWith('.wav'));;
    } catch { return []; }
  }

  /**
   * 把不属于 profile 的 `enroll-*.wav` 移进 `orphans/`。
   *
   * ⛔ **profile 为空时什么都不做。** 「使用者还没登记」与「profile 没读出来」
   *   在这一层长得一模一样，而按后者行动会把他全部录音一次扫光。
   *   ⚠ 判据必须是「我确实知道哪些是登记过的」，不是「我没看到登记」。
   */
  #sweepOrphanEnrollWavs() {
    const enrollments = this.profile?.enrollments ?? [];
    if (enrollments.length === 0) return { moved: [], skipped: 'no_profile' };
    const known = new Set(enrollments.map((e) => `${e.id}.wav`));
    const moved = [];
    try {
      const dest = path.join(this.dataRoot, ORPHAN_DIR);
      for (const f of fs.readdirSync(this.dataRoot)) {
        if (!f.startsWith('enroll-') || !f.endsWith('.wav') || known.has(f)) continue;
        fs.mkdirSync(dest, { recursive: true });
        try { fs.renameSync(path.join(this.dataRoot, f), path.join(dest, f)); moved.push(f); }
        catch { /* 移不动就留着，⛔ 不要为了整洁去删使用者的录音 */ }
      }
    } catch { /* 目录还不存在是正常的 */ }
    if (moved.length) {
      console.log(`[termux-speech] swept ${moved.length} orphan enrollment wav(s) into ${ORPHAN_DIR}/`);
    }
    return { moved, skipped: null };
  }

  /** 真的删掉孤儿。⚠ 只有使用者显式要求时才走到这里。 */
  purgeOrphanEnrollWavs() {
    const dir = path.join(this.dataRoot, ORPHAN_DIR);
    const removed = [];
    for (const f of this.orphanEnrollWavs()) {
      try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* 已经不在了 */ }
    }
    return { removed, remaining: this.orphanEnrollWavs().length };
  }

  removeEnrollment(id) {
    const r = this.profile.removeEnrollment(id);
    const clip = this.enrollClips.find((c) => c.id === id);
    this.enrollClips = this.enrollClips.filter((c) => c.id !== id);
    if (r.ok) {
      this.saveProfile();
      /** ⚠ 连 WAV 一起删：只摘索引会让每次删除都在盘上留下一个孤儿。 */
      if (clip?.wav) { try { fs.unlinkSync(path.join(this.dataRoot, clip.wav)); } catch { /* 已经不在了 */ } }
    }
    this.onChange();
    return r;
  }

  /** 实时改参数：下一个窗立刻生效，不重启。 */
  configure(patch = {}) {
    const r = this.uservad.configure(patch);
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.enrollConfig && Number.isFinite(Number(v))) this.enrollConfig[k] = Number(v);
    }
    if (r.window_changed) this.ring.resize(this.uservad.config.window_ms);
    this.#saveRuntimeConfig();
    this.onChange();
    return { ...r, enroll: { ...this.enrollConfig } };
  }

  setLabel(label) { const l = this.labels.setLabel(label); this.onChange(); return l; }
  clearLabelStats(label = null) { this.labels.clear(label); this.onChange(); return { ok: true }; }
  /**
   * 「这个阈值我确认了」。⭐ 这是**生产链唯一**的开门钥匙：在它之前，
   *   正式声纹门一律安全放行（`calibration_not_acknowledged`）。
   * ⛔ 刻意不自动触发——改阈值、改窗长、重建声纹都会让它失效，
   *   而替使用者按下这个按钮，等于替他担保一个他没看过的判决。
   */
  acknowledgeCalibration() {
    this.uservad.acknowledgeCalibration();
    if (!this.profile.ready) {
      this.onChange();
      return { ok: false, reason: 'profile_missing' };
    }
    this.ackedFor = {
      profile_fingerprint: this.profile.fingerprint,
      window_ms: this.uservad.config.window_ms,
      threshold: this.uservad.config.threshold,
      at_ms: Date.now(),
    };
    this.#saveRuntimeConfig();
    this.onChange();
    return { ok: true, acked_for: { ...this.ackedFor } };
  }

  audioPath(name) {
    const file = path.join(this.dataRoot, String(name).replace(/[^a-z0-9.-]/gi, ''));
    return fs.existsSync(file) ? file : null;
  }

  purge() {
    for (const e of this.episodes) {
      try { fs.rmSync(path.join(this.dataRoot, e.wav), { force: true }); } catch { /* noop */ }
    }
    this.episodes = [];
    this.timeline = [];
    this.onChange();
    return { ok: true };
  }

  /** 轻量时间轴：⛔ 不塞进 `/live`，页面按游标只取增量。 */
  timelineSince(after = 0, limit = 200) {
    const rows = this.timeline.filter((r) => r.seq > Number(after) || 0);
    return { rows: rows.slice(-limit), next: this.uservad.seq };
  }

  cpu() {
    const s = [...this.inferenceMs].sort((a, b) => a - b);
    const q = (p) => (s.length ? Number(s[Math.min(s.length - 1,
      Math.round((s.length - 1) * p))].toFixed(1)) : null);
    // ⚠ 按**配置的节拍**报，不要在 idle 时报 0——报告里读到 0 会以为没在跑。
    //   当前是不是真的在跑，由 `running` 说，不要靠一个被清零的速率暗示。
    const perSec = 1000 / this.uservad.config.step_ms;
    return {
      last_inference_ms: this.inferenceMs.at(-1) ?? null,
      p50_inference_ms: q(0.5), p90_inference_ms: q(0.9),
      running: this.mode === 'testing',
      inferences_per_s: Number(perSec.toFixed(2)),
      cpu_ms_per_s: q(0.5) === null ? null : Number((q(0.5) * perSec).toFixed(1)),
      skipped_windows: this.skippedWindows,
      samples: s.length,
    };
  }

  snapshot() {
    return {
      schema: 'termux-os.speaker-lab.v2',
      source: 'speaker_lab', debug_only: true,
      mode: this.mode,
      audio_ms: this.audioMs,
      vad_probability: this.lastVadProb,
      /** ⭐ 说给人看的一句：VAD 一直是 speech 也不会影响 CAM++ 的窗。 */
      vad_role: 'display_only__does_not_cut_campplus_windows',
      profile: this.profile.snapshot(),
      enroll_clips: this.enrollClips,
      /** ⚠ 只报数不删：盘上有但不属于任何登记的 WAV（诊断用）。 */
      orphan_enroll_wavs: this.orphanEnrollWavs().length,
      enroll_config: { ...this.enrollConfig },
      uservad: this.uservad.snapshot(),
      /** 生产链读的那份校准状态。页面显示它，⛔ 不要自己再判一次「算不算 stale」。 */
      calibration: (() => { const c = this.calibration(); return { ...c.status,
        acked_for: c.acked_for, profile_fingerprint: c.profile_fingerprint }; })(),
      recommended_windows: RECOMMENDED_WINDOWS,
      labels: this.labels.snapshot(this.uservad.config),
      episodes: this.episodes,
      episode_active: this.episode
        ? { seq: this.episode.seq, closing: this.episode.closing !== null } : null,
      cpu: this.cpu(),
      campplus: this.embedder.snapshot(),
      buffered_ms: Math.round(this.ring.ms),
      last_error: this.lastError,
    };
  }
}

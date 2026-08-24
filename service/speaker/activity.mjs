/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 正式链的连续 PCM + 已登记的 CPU 声纹 profile + CAM++ **QNN 2.47 HTP ctx**
 * [OUTPUT]: 实时 similarity / Activity 状态 / repeated confirmed-USER events /
 *           每次 commit 切出来的**可试听 WAV**；
 *           RMS 关门时重置 CAM++ 判定流、保留连续滚动 PCM 带和 resident 图
 * [POS]: **正式 CAM++VAD**（docs/084 的验收模式转正）。PCM 带持续滚动，只有 RMS
 *        admission 开放时才推理；切出来的段带 `status`/`revision` 交给 ASR spool。
 *
 * ⭐ 半快门与全快门是**同一句话的两次交付**，不是两句话：
 *   · 半快门（小停顿）→ 立刻切一段 `incomplete` 先送去转写；
 *   · 全快门（确认无后续）→ 切最终段 `complete`，**segment_id 不变**，revision 单调递增。
 *   等待的是判决，不是切点——所以多等并不会让尾巴变长，但**先处理**这件事必须真的发生：
 *   只写一个字段而什么都不产出，那段等待就纯粹是延迟。
 * ⛔ WAV 每个 revision 一个独立文件，⛔ 绝不原地覆盖——ASR 可能正在读上一版。
 * ⛔ **不许静默回落 CPU**：backend 与 ctx 是否真的生效必须能在 API/UI 上看到
 *   （`backend` / `graph_loaded` / `ctx_path`），因为「CPU 也能算出一个分数」
 *   正是这类验收最容易骗人的地方。
 *
 * ⭐ 复用而不是重写：FSM 用 `activity-fsm.mjs`（已验证的那份），
 *   PCM 环、profile、登记流程、WAV 试听全部沿用 Speaker Lab 既有的东西。
 * ⚠ `step_ms` 本轮**诚实写 300**：真机 PCM 是 100 ms 一帧，累加器只在帧边界判，
 *   所以配置 250 从来就是跑 300（docs/083 实测 10/10 个窗间隔精确 300 ms）。
 *   与其让配置说谎，不如让代码/UI/日志都说 300。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { TargetActivityFsm, normalizeActivityConfig } from './activity-fsm.mjs';
import { SR, toInt16 } from './pcm-ring.mjs';

/** 本轮固定的产品参数（任务书点名，⛔ 不自动调）。 */
export const TEST_DEFAULTS = Object.freeze({
  window_ms: 1500,
  step_ms: 300,            // ⭐ 诚实值，见头部
  enter_threshold: 0.40,
  exit_threshold: 0.35,
  enter_confirm: 2,
  exit_confirm: 2,
  pre_roll_ms: 500,
  /**
   * ⛔ legacy：本模式**不再**用它补尾。
   * 留 0 是为了让 FSM 算出来的 `pcm_end_ms` 就等于 `commit_ms`，
   * 这样「检测边界」与「音频边界」在数据上不会互相污染（见 `#cutEnd`）。
   * ⚠ 绝不能既留 post_roll 又加 tail_margin —— 那是两条尾巴叠加。
   */
  post_roll_ms: 0,
  vad_gates_speaker: false, // 本轮 CAM++ 是唯一权威，FireRedVAD 不参与判决
  /**
   * ⭐ 使用者定的判据：**小停顿只是半快门，「无后续」才是全快门（commit 条件）**。
   * 1200 ms 覆盖「停一下再接着说」；⛔ 等的是判决不是切点，尾巴不会因此变长。
   */
  continuation_grace_ms: 1200,
  keep_events: 50,
});

/** 使用者可选的尾部余量（ms）。默认取保守的 700：宁可多一点，也不切掉最后一个字。 */
export const TAIL_MARGIN_CHOICES = Object.freeze([300, 500, 700, 900]);
export const DEFAULT_TAIL_MARGIN_MS = 700;

/**
 * 头部裁掉多少（ms）。
 *
 * ⚠ **纠正一个我自己的误读**：第一版以为头部那一秒是「空白」，按固定长度砍。
 *   逐 50 ms 量 RMS 之后发现**从第 0 ms 就有能量** —— 那一秒是**别人的话/背景**，
 *   不是静音。所以判据不是「砍掉静音」，而是「估计用户何时开口」。
 * ⭐ 与尾部同源：`first_maybe_user` 是**第一个越过 enter 的窗**，覆盖
 *   `[fmu − 1500, fmu]`；用户显然是在这个窗的**中后段**才开口的（前半段还没到阈值），
 *   所以真实开口点通常在 `fmu − 300 … − 600` 附近。
 *   起点 = `(fmu − window − pre_roll) + head_trim`，默认 1300 ⇒ 起点 ≈ `fmu − 700`。
 * ⚠ 护栏：绝不切到 `fmu − 200` 之后 —— 宁可多留一点，也不啃掉开口那一下。
 */
/** 半快门等待期可选值（ms）。 */
export const GRACE_CHOICES = Object.freeze([0, 600, 1200, 1800, 2500]);

export const HEAD_TRIM_CHOICES = Object.freeze([0, 300, 700, 1000, 1300, 1600]);
/**
 * ⛔ **默认回到 0（Safe）**。上一轮把它默认成 1300 是我的错：
 *   真实开口点取决于「用户的声音要在 1500 ms 窗里占多大比例才能把 cosine 顶过 0.40」，
 *   而这个比例随音量/距离/背景而变 ⇒ **固定位移必然有时切早**，使用者实测「切头吃字」。
 * ⭐ 原则回到：**宁可多录句首，不允许吃第一个字。**
 *   固定 trim 保留为 debug 参数，但不再是产品默认。
 */
/**
 * ⭐ 转正默认值改为 **1300**：使用者实测「开头只要设成 1300ms，开头也切得准」。
 * ⚠ 之前默认 0（Safe）是因为那时 `PcmTape` 还在漂移，裁剪叠在漂移上会吃字——
 *   漂移修掉之后同一个 1300 从「吃字」变成「切得准」，**改变的是前提，不是这个数**。
 */
export const DEFAULT_HEAD_TRIM_MS = 1300;

/** 句首模式：safe = 不裁；trim = 固定位移（debug）。 */
export const HEAD_MODES = Object.freeze(['safe', 'trim']);
/** 与上同源：漂移修复后 trim 已被实测认可，故转正默认 trim；safe 仍可选。 */
export const DEFAULT_HEAD_MODE = 'trim';

export const KEEP_SEGMENTS = 30;          // ⛔ 有界保留，不许无限积累
const TAPE_MS = 25_000;                   // 覆盖 hard_cap(15s) + pre/post 还有富余
const KEEP_HISTORY = 120;                 // 实时分数历史 ≈ 最近 36 秒（300ms 一点）

const wavHeader = (bytes) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
};

/**
 * 带**音频时间戳**的滚动 PCM 磁带。
 * ⭐ 这是「连续录音」那条要求的实现：环一直在滚，确认 USER 之后**回看** pre-roll，
 *   ⛔ 而不是「确认之后才开始录」——后者必然丢句首。
 */
class PcmTape {
  constructor(ms = TAPE_MS) { this.cap = Math.ceil(SR * ms / 1000) * 2; this.reset(); }

  reset() { this.buf = Buffer.alloc(0); this.endMs = null; }

  push(frame, endMonoMs) {
    this.buf = Buffer.concat([this.buf, frame]);
    this.endMs = endMonoMs;
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - this.cap);
  }

  /**
   * ⭐ 起点由**实际字节数**反推，⛔ 绝不累加维护。
   *
   * ⚠ 真机付过代价：第一版把 `baseMs` 存下来、每次裁剪 `+= drop/SR` 地累加，
   *   而 `mono_ms` 是设备真实时间戳、每帧并非精确 100 ms。二者会缓慢发散 ——
   *   实测 25 秒的环里 `end − baseMs = 25002 ms` 而字节只有 25000 ms，**差 2 ms**。
   *   于是按时间算出的终点被 `buf.length` 钳住，每个窗都短几十字节 →
   *   `skipped_short` → **窗停产、图谱卡住**（336 个 due 掉了 187 个）。
   *   ⇒ 「时间戳 → 字节偏移」的映射只要有一丝漂移就会整条失效；
   *      唯一稳的办法是**让映射永远由当前真实内容定义**。
   */
  get baseMs() {
    return this.endMs === null ? null : this.endMs - (this.buf.length / 2 / SR) * 1000;
  }

  /** 取 [startMs, endMs) 的 PCM；磁带没盖住就按能给的给，并如实报实际区间。 */
  slice(startMs, endMs) {
    if (this.baseMs === null) return null;
    const from = Math.max(0, Math.round((startMs - this.baseMs) / 1000 * SR)) * 2;
    const to = Math.min(this.buf.length,
      Math.max(0, Math.round((endMs - this.baseMs) / 1000 * SR)) * 2);
    if (to <= from) return null;
    return {
      pcm: this.buf.subarray(from, to),
      actual_start_ms: Math.round(this.baseMs + (from / 2 / SR) * 1000),
      actual_end_ms: Math.round(this.baseMs + (to / 2 / SR) * 1000),
    };
  }
}

export class SpeakerActivity {
  /**
   * @param embedder    CAM++ **HTP** 实例（与既有 CPU 声纹门是两个不同的 resident）
   * @param calibration `() => { profile, profile_ready }` —— 复用既有 CPU 登记的声纹
   * @param freeSessions/restoreSessions  进入/离开测试模式时腾出、还回 HTP 会话
   */
  /**
   * @param pauseRival/resumeRival 进入/离开测试模式时暂停、恢复旧 CPU 声纹门。
   *   ⭐ 恢复的是**进入之前的原状态**，⛔ 不是「总是打开」——
   *   使用者本来就关着的东西，不该因为跑了一次测试而被打开。
   */
  /**
   * @param onSegment `({segment_id, wav_path, status, revision, ...}) => void`
   *   正式下游。⛔ 本模块**不认识** ASR：它只说「这一段是谁的、到哪为止、是不是最终版」。
   *   谁来转写、要不要计入 50 句，都由调用方决定。
   */
  constructor({ embedder, calibration, dataRoot, onChange = () => {},
                onSegment = () => {},
                onConfirmedUser = () => {},
                freeSessions = async () => ({}), restoreSessions = async () => ({}),
                pauseRival = async () => null, resumeRival = async () => null }) {
    this.onSegment = onSegment;
    this.onConfirmedUser = onConfirmedUser;
    /** 当前 CAM++ 准入流的句子编号空间。segment_id 由它 + candidate_id 构成。 */
    this.epochId = null;
    this.embedder = embedder;
    this.readCalibration = calibration;
    this.dataRoot = dataRoot;
    this.onChange = onChange;
    this.freeSessions = freeSessions;
    this.restoreSessions = restoreSessions;
    this.pauseRival = pauseRival;
    this.resumeRival = resumeRival;
    this.rivalPrev = null;
    this.config = normalizeActivityConfig(TEST_DEFAULTS);
    this.tailMarginMs = DEFAULT_TAIL_MARGIN_MS;
    this.headTrimMs = DEFAULT_HEAD_TRIM_MS;
    this.headMode = DEFAULT_HEAD_MODE;
    this.graceMs = TEST_DEFAULTS.continuation_grace_ms;
    this.enabled = false;
    this.graphLoaded = false;
    this.lastError = null;
    this.computeUnit = null;
    this.releasedSessions = null;
    this.fsm = new TargetActivityFsm(this.config, {
      onCommit: (e) => this.#onCommit(e),
      onHalfShutter: (e) => this.#onHalfShutter(e),
    });
    this.tape = new PcmTape();
    /** RMS 每次重新准入都开一个新的流代次；迟到的 HTP 结果不得写回新门。 */
    this.streamGeneration = 0;
    this.inflightCount = 0;
    this.#resetStream();
    this.segments = this.#loadSegments();
    this.segSeq = this.segments.reduce((m, s) => Math.max(m, s.seq), 0);
  }

  #resetStream({ preserveTape = false } = {}) {
    this.streamGeneration += 1;
    /**
     * 每一次 RMS 准入都必须拥有新的 segment_id 命名空间。
     *
     * candidate_id 会在 FSM reset 后从 1 重新开始；如果只用一次性的 epochId，
     * 第二次 RMS 开门就会重新产生 `...-c1`，ASR 的 `(segment_id, revision)` 去重
     * 会把真实的新句子当成旧句子。streamGeneration 同时是迟到 HTP 结果的代次，
     * 因而正好也是这个命名空间的稳定递增部分。
     */
    this.epochId = `spk${Date.now().toString(36)}-${this.streamGeneration}`;
    if (!preserveTape) this.tape.reset();
    this.msSinceWindow = 0;
    /** 旧窗仍在 HTP 中时保持 busy，避免新 RMS 会话与它并发。 */
    this.camInFlight = this.inflightCount > 0;
    this.pcmMonoMs = null;
    if (preserveTape && this.tape.endMs !== null) {
      this.pcmMonoMs = this.tape.endMs;
    }
    this.pending = [];
    this.history = [];
    this.lastSimilarity = null;
    this.inferMs = [];
    this.e2eMs = [];
    this.windows = 0;
    this.frames = 0;
    this.due = 0;
    this.skippedBusy = 0;
    this.skippedShort = 0;
    this.skippedNoProfile = 0;
    /** 半快门时磁带还没录到切点 ⇒ 这一版跳过（不是失败，见 #onHalfShutter）。 */
    this.halfSkippedNotRecorded = 0;
    this.lastShort = null;
    this.admittedFrames = 0;
    this.closedFrames = 0;
    this.lastInferenceAdmitted = false;
    this.confirmedUserAtMs = null;
    /**
     * ⭐ 「卡住」必须能分层定位，⛔ 不许只凭页面视觉判断：
     *   frames 不涨      → 断在 PCM 输入
     *   frames 涨 due 不涨 → 断在累加器
     *   due 涨 windows 不涨 + busy 猛增 → worker 争用
     *   windows 涨但 UI 不动 → StateHub/UI 轮询
     * 所以这里要记「一次推理最久卡了多久」和「最后一个窗是什么时候出的」。
     */
    if (this.inflightCount === 0) this.inflightSince = null;
    this.maxInflightMs = 0;
    this.stalls = 0;
    this.lastWindowAtMs = null;
  }

  /**
   * ⚠ 列表必须能从磁盘重建：真机踩过（Speaker Lab 同一处）——
   *   WAV 落了盘而列表只在内存里，服务一重启页面就**再也够不到那些片段**。
   */
  #loadSegments() {
    try {
      const meta = path.join(this.dataRoot, 'segments.json');
      if (fs.existsSync(meta)) {
        const rows = JSON.parse(fs.readFileSync(meta, 'utf8'));
        return rows.filter((r) => fs.existsSync(path.join(this.dataRoot, r.wav)));
      }
    } catch { /* 读不回来就从空列表开始，⛔ 不让它把服务带崩 */ }
    return [];
  }

  #saveSegments() {
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      fs.writeFileSync(path.join(this.dataRoot, 'segments.json'),
        JSON.stringify(this.segments));
    } catch (error) { this.lastError = `segments persist: ${error?.message}`; }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async start() {
    if (this.enabled) return this.snapshot();
    const cal = this.readCalibration?.() ?? {};
    if (cal.profile_ready !== true) {
      throw new Error('no speaker profile — 先在①登记声纹');
    }
    // ⭐ 先腾位子再加载：设备常态是 10 个 HTP 会话而上限 8，不腾必然 409。
    // ⭐ 先把同一个 :ort_worker 上的 **CPU CAM++**（旧声纹门）停掉：
    //   它由 RMS 触发，背景说话时会持续提交 56 ms 的 CPU 推理，与本模式抢 worker。
    //   ⛔ 测试模式里只应存在**一个** CAM++ 推理消费者。
    this.rivalPrev = await this.pauseRival();
    this.releasedSessions = await this.freeSessions();
    try {
      await this.embedder.ensure();
      this.graphLoaded = true;
      this.lastError = null;
    } catch (error) {
      // ⛔ QNN 失败契约：不在污染的 worker 里盲目重试，把失败如实抛出去。
      this.graphLoaded = false;
      this.lastError = String(error?.message ?? error);
      await this.restoreSessions(this.releasedSessions).catch(() => null);
      this.releasedSessions = null;
      await this.resumeRival(this.rivalPrev).catch(() => null);
      this.rivalPrev = null;
      throw error;
    }
    this.enabled = true;
    this.#resetStream();
    this.fsm.reset();
    this.onChange();
    return this.snapshot();
  }

  async stop(reason = 'user') {
    if (!this.enabled && !this.graphLoaded) return this.snapshot();
    this.enabled = false;
    this.fsm.flush(this.pcmMonoMs ?? 0);
    this.#resetStream();
    this.fsm.reset();
    try { await this.embedder.release?.(); } catch { /* 释放失败不该挡住停机 */ }
    this.graphLoaded = false;
    this.lastStopReason = reason;
    if (this.releasedSessions) {
      await this.restoreSessions(this.releasedSessions).catch(() => null);
      this.releasedSessions = null;
    }
    if (this.rivalPrev !== null) {
      await this.resumeRival(this.rivalPrev).catch(() => null);
      this.rivalPrev = null;
    }
    this.onChange();
    return this.snapshot();
  }

  /**
   * RMS 关门只结束当前 CAM++ 判定流，⛔ 不释放 resident 图，也不清掉滚动 PCM 带。
   *
   * 这和 `stop()` 的语义不同：下一次 RMS 开门要能回看门前 PCM；同时，旧窗的
   * 异步结果必须作废。低音量本身不会调用这里。
   */
  resetAdmission(reason = 'rms_gate_closed') {
    if (!this.enabled) return this.snapshot();
    this.#resetStream({ preserveTape: true });
    this.fsm.reset();
    this.lastStopReason = reason;
    this.lastError = null;
    this.onChange();
    return this.snapshot();
  }

  /** 只调尾部余量；⭐ 下一段立即生效，不需要重启。 */
  setTailMargin(ms) {
    const v = Number(ms);
    if (!TAIL_MARGIN_CHOICES.includes(v)) {
      throw new RangeError(`tail_margin_ms must be one of ${TAIL_MARGIN_CHOICES.join('/')}`);
    }
    this.tailMarginMs = v;
    this.onChange();
    return v;
  }

  /** 半快门等待期。⭐ 下一段立即生效。 */
  setGrace(ms) {
    const v = Number(ms);
    if (!GRACE_CHOICES.includes(v)) {
      throw new RangeError(`continuation_grace_ms must be one of ${GRACE_CHOICES.join('/')}`);
    }
    this.graceMs = v;
    this.config = normalizeActivityConfig({ ...this.config, continuation_grace_ms: v });
    this.fsm.configure(this.config);
    this.onChange();
    return v;
  }

  /** 句首模式：safe（默认，不裁）/ trim（固定位移，debug）。 */
  setHeadMode(mode) {
    if (!HEAD_MODES.includes(String(mode))) {
      throw new RangeError(`head_mode must be one of ${HEAD_MODES.join('/')}`);
    }
    this.headMode = String(mode);
    this.onChange();
    return this.headMode;
  }

  /** 只调头部裁剪量；⭐ 下一段立即生效。⚠ 只在 head_mode=trim 时起作用。 */
  setHeadTrim(ms) {
    const v = Number(ms);
    if (!HEAD_TRIM_CHOICES.includes(v)) {
      throw new RangeError(`head_trim_ms must be one of ${HEAD_TRIM_CHOICES.join('/')}`);
    }
    this.headTrimMs = v;
    this.onChange();
    return v;
  }

  /** Mic 总开关关掉 / 停链：⛔ 停下并且**不自行恢复**。 */
  forceIdle(reason = 'mic_off') {
    if (!this.enabled) return;
    void this.stop(reason);
  }

  // ── PCM ────────────────────────────────────────────────────────────────
  ingest(frame, meta = null, { infer = true } = {}) {
    if (!this.enabled) return;
    const frameMs = frame.length / 2 / SR * 1000;
    const anchored = Number(meta?.mono_ms);
    const end = Number.isFinite(anchored) ? anchored + frameMs
      : (this.pcmMonoMs === null ? frameMs : this.pcmMonoMs + frameMs);
    this.pcmMonoMs = end;
    this.tape.push(frame, end);          // ⭐ 磁带常时滚动，与推不推理无关
    this.#drainPending();

    this.frames += 1;
    this.lastInferenceAdmitted = infer === true;
    if (infer !== true) {
      this.closedFrames += 1;
      return;
    }
    this.admittedFrames += 1;
    this.msSinceWindow += frameMs;
    if (this.msSinceWindow < this.config.step_ms) return;
    this.msSinceWindow = 0;
    this.due += 1;
    // ⚠ 下面每一条早退**都要计数**：上一轮就是因为「短窗」和「没声纹」两条无声丢弃，
    //   而 tick 已经被 `msSinceWindow = 0` 消费掉了 —— 于是窗率掉到 70% 而
    //   `skipped_busy` 看起来一切正常。**无声的丢弃 = 查不出来的丢弃。**
    if (this.camInFlight) { this.skippedBusy += 1; return; }
    const need = Math.ceil(SR * this.config.window_ms / 1000) * 2;
    const win = this.tape.slice(end - this.config.window_ms, end);
    if (!win || win.pcm.length < need) {
      this.skippedShort += 1;
      this.lastShort = { need, got: win ? win.pcm.length : 0,
                         buf: this.tape.buf.length, baseMs: this.tape.baseMs, end };
      return;
    }
    const cal = this.readCalibration?.() ?? {};
    if (cal.profile_ready !== true) { this.skippedNoProfile += 1; return; }
    void this.#runWindow(Buffer.from(win.pcm), Math.round(end), cal);
  }

  async #runWindow(chunk, endMono, cal) {
    const generation = this.streamGeneration;
    this.inflightCount += 1;
    this.camInFlight = true;
    const t0 = Date.now();
    if (this.inflightCount === 1) this.inflightSince = t0;
    try {
      const r = await this.embedder.embed(toInt16(chunk));
      if (!this.enabled || generation !== this.streamGeneration) return;
      const sim = cal.profile?.score?.(r.embedding);
      if (sim === null || sim === undefined) throw new Error('profile produced no score');
      this.e2eMs.push(Date.now() - t0);
      if (typeof r.inference_ms === 'number') this.inferMs.push(r.inference_ms);
      // ⭐ App 自报的 compute_unit 是「真的跑在 HTP 上」唯一的运行期证据
      if (r.compute_unit) this.computeUnit = r.compute_unit;
      if (this.e2eMs.length > 200) this.e2eMs.shift();
      if (this.inferMs.length > 200) this.inferMs.shift();
      this.windows += 1;
      this.lastSimilarity = Number(sim.toFixed(4));
      const before = this.fsm.state;
      const result = this.fsm.onWindow(endMono, sim);
      // 每个仍处于正式 USER 的 CAM 窗都是一次 confirmed USER：连续真人语音
      // 必须持续喂活上游 watchdog；初次确认和 MAYBE_END→USER 回弹同样刷新。
      // OTHER/MAYBE_USER/MAYBE_END 或尚未完成确认的高相似度不能刷新它。
      const confirmedUser = this.fsm.state === 'USER'
        && (before !== 'USER' || result?.transition === null);
      if (confirmedUser) {
        this.confirmedUserAtMs = endMono;
        try {
          this.onConfirmedUser({
            state: 'USER',
            confirmed_user_at_ms: endMono,
            mono_ms: endMono,
          });
        } catch { /* 上游状态投影不得影响 CAM++ 判定 */ }
      }
      this.history.push({ t: endMono, sim: this.lastSimilarity, state: this.fsm.state });
      while (this.history.length > KEEP_HISTORY) this.history.shift();
      this.lastError = null;
    } catch (error) {
      if (this.enabled && generation === this.streamGeneration) {
        this.lastError = String(error?.message ?? error);
      }
    } finally {
      this.inflightCount = Math.max(0, this.inflightCount - 1);
      if (generation === this.streamGeneration) {
        const held = Date.now() - (this.inflightSince ?? t0);
        if (held > this.maxInflightMs) this.maxInflightMs = held;
        if (held >= 2000) this.stalls += 1;          // 一次推理卡超过 2 秒＝一次可疑停顿
        this.lastWindowAtMs = Date.now();
      }
      if (this.inflightCount === 0) {
        this.inflightSince = null;
        this.camInFlight = false;
      } else {
        this.camInFlight = true;
      }
      /** 旧代次也要通知一次：它可能正是 reset 后把 busy 清掉的最后一个窗。 */
      this.onChange();
    }
  }

  // ── COMMIT → WAV ───────────────────────────────────────────────────────
  /**
   * ⚠ `pcm_end_ms = commit + post_roll` 落在**未来**，此刻磁带还没录到。
   *   所以先挂起，等磁带真的盖过那一刻再切 —— 否则 post-roll 是空的，
   *   而 WAV 长度看起来还挺正常。
   */
  #onCommit(event) {
    this.pending.push(event);
    this.#drainPending();
    this.onChange();
  }

  /** 这句话的稳定身份。⭐ 半快门与全快门共用它——revision 变，身份不变。 */
  #segmentId(event) { return `${this.epochId}-c${event.candidate_id}`; }

  /**
   * 半快门：**先处理**。
   *
   * ⛔ 不进 `pending`、不动 FSM、不算 commit。它切的是「到目前为止」的前缀，
   *   终点用与全快门同源的反推（分数记在窗尾，那一窗已不由用户主导）。
   * ⚠ 磁带还没盖到切点就**不发**——发一段还没录到的音频，长度看起来正常而内容是空的。
   *   这一版就此丢弃：下一次半快门或全快门会带着更大的 revision 再来，
   *   incomplete 本来就是「尽力而为」的中间品。
   */
  #onHalfShutter(event) {
    const end = Math.round(event.pcm_end_ms + this.tailMarginMs);
    if (this.tape.endMs === null || this.tape.endMs < end) {
      this.halfSkippedNotRecorded += 1;
      return;
    }
    this.#writeSegment({ ...event, commit_ms: event.half_shutter_ms },
      { status: 'incomplete', revision: event.revision, endOverride: end });
  }

  #drainPending() {
    if (!this.pending.length || this.tape.endMs === null) return;
    // ⚠ 等的是**反推之后**的切点，不是 FSM 给的 pcm_end：
    //   回切之后终点常常已经在磁带里了，这时不该再空等 400 ms。
    const due = (e) => this.#cutEnd(e).end;
    const ready = this.pending.filter((e) => this.tape.endMs >= due(e));
    if (!ready.length) return;
    this.pending = this.pending.filter((e) => this.tape.endMs < due(e));
    // ⚠ revision 必须从事件里取。用默认值 1 会让**最终版**的号码比它自己
    //   之前发过的 incomplete 还小，于是下游按「更大的才算数」判断时，
    //   永远收不到定稿——而两条路径都「成功」，从状态上看不出任何异常。
    for (const e of ready) {
      this.#writeSegment(e, { status: 'complete', revision: e.revision ?? 1 });
    }
  }

  /**
   * ⭐ 反推真实句尾（retroactive boundary correction）。
   *
   * 为什么 `first_maybe_end − window_ms` 是对的：CAM++ 的分数记在**窗的结尾**，
   * 而窗长 1500 ms。`first_maybe_end` 是**第一个掉到 exit 以下**的窗，它覆盖
   * `[first_maybe_end − 1500, first_maybe_end]` 且已经**不再由用户主导** ——
   * 所以用户大致就在这个窗的**起点附近**停的。上一个窗还高分，说明那时用户还在说。
   * ⇒ 用户真实句尾 ≈ `first_maybe_end − window_ms`，再加一点余量兜住尾音。
   *
   * ⛔ 检测可以晚，音频边界不必跟着晚 —— 这两件事本轮正式解耦。
   * ⚠ 回弹已在 FSM 层处理：`MAYBE_END → USER` 时 `first_maybe_end_ms` 被清空，
   *   所以这里拿到的永远是**最后一轮**有效 anchor（activity-fsm.mjs:207）。
   */
  #cutEnd(event) {
    const c = this.config;
    const margin = this.tailMarginMs;
    const anchored = Number.isFinite(event.first_maybe_end_ms);
    let end = anchored
      ? event.first_maybe_end_ms - c.window_ms + margin
      // 没有 anchor（hard_cap / stream_end）：退回「commit + 余量」，⛔ 不硬套公式
      : event.commit_ms + margin;
    // ⛔ 安全下界：不许切到确认成 USER 之前，也不许切出负长度/极短片段
    const floor = Math.max(
      (event.confirmed_user_ms ?? event.first_maybe_user_ms ?? event.candidate_start_ms) + 200,
      event.pcm_start_ms + 500,
    );
    if (end < floor) end = floor;
    // ⛔ 安全上界：不许比旧行为还长（那样就白改了）
    const ceil = event.commit_ms + margin;
    if (end > ceil) end = ceil;
    return { end: Math.round(end), anchored, margin };
  }

  /**
   * 头部切点。⛔ 判据与尾部同源：`first_maybe_user` 那个窗是**第一个**越过 enter 的，
   *   用户显然是在这个窗的中后段才开口的，窗的前半段基本没有他的声音。
   * ⚠ 上界护栏：绝不允许切到「已经确认成 USER」之后 —— 那就是在吃正文了。
   */
  #cutStart(event) {
    const base = event.pcm_start_ms;                  // = first_maybe_user − window − pre_roll
    // ⛔ Safe 模式**永不**应用任何实验性裁剪 —— 一个实验算法不许静默变成默认。
    if (this.headMode === 'safe') return Math.round(base);
    let start = base + this.headTrimMs;
    const ceil = (event.first_maybe_user_ms ?? event.candidate_start_ms) - 200;
    if (start > ceil) start = ceil;
    if (start < base) start = base;
    return Math.round(start);
  }

  #writeSegment(event, { status = 'complete', revision = 1, endOverride = null } = {}) {
    const est = endOverride === null
      ? this.#cutEnd(event)
      : { end: endOverride, anchored: true, margin: this.tailMarginMs };
    const startAt = this.#cutStart(event);
    const cut = this.tape.slice(startAt, est.end);
    if (!cut) return;
    this.segSeq += 1;
    const segmentId = this.#segmentId(event);
    /**
     * ⭐ 每个 revision 一个**不可变**文件。
     * ⛔ 绝不原地覆盖：ASR 可能正拿着上一版的路径在读，而一个内容中途变了的文件
     *   会让「转的是哪一段」永远说不清。旧版的回收交给调用方在 complete 之后决定。
     */
    const wav = `${segmentId}.r${revision}.${status === 'incomplete' ? 'part' : 'final'}.wav`;
    try {
      fs.mkdirSync(this.dataRoot, { recursive: true });
      fs.writeFileSync(path.join(this.dataRoot, wav),
        Buffer.concat([wavHeader(cut.pcm.length), cut.pcm]));
    } catch (error) { this.lastError = `wav: ${error?.message}`; return; }
    this.segments.unshift({
      seq: this.segSeq,
      segment_id: segmentId,
      status,
      revision,
      candidate_id: event.candidate_id,
      wav,
      commit_reason: event.commit_reason ?? 'half_shutter',
      at_ms: event.at_ms,
      duration_ms: cut.actual_end_ms - cut.actual_start_ms,
      max_similarity: event.max_similarity,
      mean_user_similarity: event.mean_user_similarity,
      // ⭐ 六个时刻都留着：使用者要能直接看出 pre-roll/post-roll 是否合理
      marks: {
        pcm_start_ms: cut.actual_start_ms,
        candidate_start_ms: event.candidate_start_ms,
        first_maybe_user_ms: event.first_maybe_user_ms,
        confirmed_user_ms: event.confirmed_user_ms,
        first_maybe_end_ms: event.first_maybe_end_ms,
        commit_ms: event.commit_ms,
        pcm_end_ms: cut.actual_end_ms,
      },
      pre_roll_ms: event.candidate_start_ms - cut.actual_start_ms,
      head_mode: this.headMode,
      head_trim_ms: this.headTrimMs,
      /**
       * ⭐ 只**采集证据**，不据此改切点。
       * 句首估计需要「分数从背景基线抬起来」的形状，而这只能用真实数据定
       * （⛔ 不能用 RMS：前面那一秒本来就是有声的别人的话，RMS 分不出谁在说）。
       * 这里把 `first_maybe_user` 前后各若干窗的 (t, sim) 存下来，
       * 供下一轮离线拟合 onset estimator —— 拟合出来之前**默认永远是 Safe**。
       */
      rise: this.history
        .filter((h) => h.t >= event.first_maybe_user_ms - 2400
                    && h.t <= event.first_maybe_user_ms + 600)
        .map((h) => [h.t - event.first_maybe_user_ms, h.sim]),
      old_pcm_start_ms: event.pcm_start_ms,
      trimmed_head_ms: Math.round(cut.actual_start_ms - event.pcm_start_ms),
      /**
       * ⭐ 使用者要的两个 gap，**分开报**，别混成一个数：
       *   detection_tail_ms —— 音频域：系统晚多久才「知道」用户结束了
       *   gap_commit_to_wav_ms —— 墙钟：从 commit 到 WAV 真的写完
       * 回切之后终点常常已经在磁带里，所以第二个通常很小；
       * 只有 tail_margin 大到超过磁带当前进度时才需要等。
       */
      commit_at_ms: event.at_ms,
      wav_at_ms: Date.now(),
      gap_commit_to_wav_ms: Math.max(0, Date.now() - event.at_ms),
      // ⭐ 两个语义**必须分开**：一个是音频切到哪，一个是检测判到哪。
      //   混用会让「裁短 WAV」把防重开的边界也一起裁短，于是刚提交的 USER
      //   又被 1500 ms 窗看见、重开一个 candidate。
      segment_audio_end_ms: cut.actual_end_ms,
      detection_committed_until_ms: event.commit_ms,
      tail_margin_ms: est.margin,
      retroactive: est.anchored,
      estimated_user_end_ms: est.end,
      // 系统晚了多久才知道用户已经结束（≈ window + exit confirm）
      detection_tail_ms: Math.round(event.commit_ms - est.end),
      old_pcm_end_ms: event.pcm_end_ms,
      saved_tail_ms: Math.round(event.pcm_end_ms - cut.actual_end_ms),
    });
    while (this.segments.length > KEEP_SEGMENTS) {
      const gone = this.segments.pop();
      try { fs.unlinkSync(path.join(this.dataRoot, gone.wav)); } catch { /* 已经不在就算了 */ }
      // 下游没接走的那份也要回收，否则 spool/ 会随时间无界增长。
      try { fs.unlinkSync(path.join(this.dataRoot, 'spool', gone.wav)); } catch { /* 已被接管 */ }
    }
    this.#saveSegments();
    /**
     * 交给下游。⛔ 放在**文件写完之后**——先发路径再写文件，接收方有一段时间会拿到
     * 一个还不存在（或只有半个）的 WAV，而那种失败看起来像是模型的问题。
     */
    /**
     * ⭐ **归属**：下游会把音频搬走。
     *
     * `records.admit()` 对 `wav_path` 做的是 `renameSync` —— 记录组接管这段音频，
     * 这对 VAD 那条链完全正确（切段器在那里只是一个暂存区）。但本模块**同时**是
     * 「最近切出来的段，可试听」的来源：交出去的那一份被搬走之后，页面上的按钮
     * 就指向一个不存在的文件，而切段那一侧一切正常——于是问题看起来在音频上。
     *
     * 所以写两份，并把归属写死在这里：
     *   · `dataRoot/<name>`         切段器自己的，按 KEEP_SEGMENTS 滚动回收，⛔ 谁都别搬；
     *   · `dataRoot/spool/<name>`   交给 spool 的，下游想搬想删都行。
     * ⚠ 代价是每句话多一份拷贝，上限 30 段；换来的是「谁拥有这个文件」不再有歧义。
     */
    let spoolWav = path.join(this.dataRoot, wav);
    try {
      const spoolDir = path.join(this.dataRoot, 'spool');
      fs.mkdirSync(spoolDir, { recursive: true });
      spoolWav = path.join(spoolDir, wav);
      fs.copyFileSync(path.join(this.dataRoot, wav), spoolWav);
    } catch (error) {
      // 拷不出来就把自己那份交出去（旧行为）。⚠ 如实记下来：这会让试听失效。
      this.lastError = `spool copy: ${error?.message}`;
    }
    try {
      this.onSegment({
        schema: 'termux-os.speech-segment.v2',
        segment_id: segmentId,
        revision,
        status,
        wav_path: spoolWav,
        source: 'campplus',
        start_ms: cut.actual_start_ms,
        end_ms: cut.actual_end_ms,
        duration_ms: cut.actual_end_ms - cut.actual_start_ms,
        max_similarity: event.max_similarity,
        mean_user_similarity: event.mean_user_similarity,
      });
    } catch (error) { this.lastError = `sink: ${error?.message}`; }
  }

  removeSegment(seq) {
    const i = this.segments.findIndex((s) => s.seq === Number(seq));
    if (i < 0) return false;
    const [gone] = this.segments.splice(i, 1);
    try { fs.unlinkSync(path.join(this.dataRoot, gone.wav)); } catch { /* 同上 */ }
    this.#saveSegments();
    this.onChange();
    return true;
  }

  /**
   * 试听用的绝对路径，或 null。
   *
   * ⛔ 判据是**解析之后还在不在 dataRoot 里面**，不是文件名长什么样。
   * ⚠ 上一版写的是 `/^seg-[\w.-]+\.wav$/` —— 它想防的是路径穿越，实际却顺带把
   *   「文件名以 seg- 开头」变成了契约。改名之后每一次试听都静默返回 null，
   *   页面上表现为「段切出来了但放不了」，而**切段那一侧完全正常**，
   *   于是问题看起来在音频上。一个用命名规则冒充安全检查的守卫，
   *   会在下一次改名时以「功能坏了」的形式失败。
   */
  wavPath(name) {
    const raw = String(name ?? '');
    if (!raw.endsWith('.wav') || raw.includes('/') || raw.includes('\\')) return null;
    const root = path.resolve(this.dataRoot);
    const p = path.resolve(root, raw);
    // 真正的不变式：解析后必须仍在 dataRoot 之内（`..` 与符号链接都逃不掉）。
    if (p !== path.join(root, path.basename(p)) || !p.startsWith(`${root}${path.sep}`)) return null;
    return fs.existsSync(p) ? p : null;
  }

  // ── 观测 ───────────────────────────────────────────────────────────────
  snapshot() {
    const cal = this.readCalibration?.() ?? {};
    const p50 = (a) => (a.length
      ? Number([...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1)) : null);
    const f = this.fsm.snapshot();
    return {
      schema: 'termux-os.speech-speaker-activity.v1',
      enabled: this.enabled,
      /** ⛔ 这三个必须说出来：CPU 也能算出一个分数，不写明就分不清跑在哪。 */
      backend: this.embedder?.backend ?? 'unknown',
      compute_unit: this.computeUnit ?? null,
      graph_loaded: this.graphLoaded,
      /** 图常驻不等于当前有 PCM 准入；这是 CAM++ 异步窗口是否在飞的内部事实。 */
      stream_generation: this.streamGeneration,
      inference_active: this.enabled && this.inflightCount > 0,
      ctx_path: this.embedder?.ctxPath ?? null,
      profile_ready: cal.profile_ready === true,
      profile_enrollments: cal.profile?.enrollments?.length
        ?? cal.enrollment_count ?? null,
      state: f.state,
      similarity: this.lastSimilarity,
      /**
       * ⭐ 相似度时序。**这一条以前不在快照里**，只有 `scoreHistory()` 方法能拿到——
       *   于是概览那张「最近的声纹匹配」图读 `cam.history` 永远读到 `undefined`，
       *   即使常驻助手开着也画不出一根柱子。⛔ 又一个「读得出值、答的不是那个问题」。
       * ⚠ 只给最近 60 点（约 18 秒）：它进的是每秒推送的热域，
       *   120 点会让这个域的体积翻倍，而屏幕上也画不下。
       */
      history: this.history.slice(-60).map((row) => ({
        t: row.t, sim: row.sim, state: row.state,
      })),
      user_seen: f.user_seen,
      confirmed_user_at_ms: this.confirmedUserAtMs,
      current_candidate_id: f.current_candidate_id,
      last_commit: f.last_commit,
      counters: f.counters,
      config: {
        window_ms: this.config.window_ms,
        step_ms: this.config.step_ms,
        enter_threshold: this.config.enter_threshold,
        exit_threshold: this.config.exit_threshold,
        enter_confirm: this.config.enter_confirm,
        exit_confirm: this.config.exit_confirm,
        pre_roll_ms: this.config.pre_roll_ms,
        tail_margin_ms: this.tailMarginMs,
        tail_margin_choices: TAIL_MARGIN_CHOICES,
        head_mode: this.headMode,
        head_modes: HEAD_MODES,
        head_trim_ms: this.headTrimMs,
        head_trim_choices: HEAD_TRIM_CHOICES,
        continuation_grace_ms: this.config.continuation_grace_ms,
        grace_choices: GRACE_CHOICES,
        post_roll_ms_legacy: this.config.post_roll_ms,
      },
      timing: {
        windows: this.windows,
        frames: this.frames,
        admitted_frames: this.admittedFrames,
        closed_frames: this.closedFrames,
        due: this.due,
        skipped_busy: this.skippedBusy,
        skipped_short: this.skippedShort,
        skipped_no_profile: this.skippedNoProfile,
        last_short: this.lastShort,
        /** 现在正卡着多久（null＝没有在飞的推理）——⭐ 分辨「卡住」与「安静」 */
        inflight_ms: this.inflightSince === null ? null : Date.now() - this.inflightSince,
        max_inflight_ms: this.maxInflightMs,
        stalls_over_2s: this.stalls,
        /** 最后一个窗产出到现在多久 —— UI 不动时先看它，⛔ 别先怪 UI */
        since_last_window_ms: this.lastWindowAtMs === null
          ? null : Date.now() - this.lastWindowAtMs,
        infer_last_ms: this.inferMs.at(-1) ?? null,
        infer_p50_ms: p50(this.inferMs),
        e2e_last_ms: this.e2eMs.at(-1) ?? null,
        e2e_p50_ms: p50(this.e2eMs),
        pending_wavs: this.pending.length,
      },
      pcm_tape: {
        rolling: this.enabled,
        capacity_ms: TAPE_MS,
        duration_ms: Math.round(this.tape.buf.length / 2 / SR * 1000),
        base_ms: this.tape.baseMs,
        end_ms: this.tape.endMs,
        inference_admitted: this.lastInferenceAdmitted,
      },
      released_sessions: this.releasedSessions ?? null,
      /** 进入测试前旧声纹门是开还是关（离开时按这个恢复）。 */
      rival_gate_was: this.rivalPrev,
      last_error: this.lastError,
      segments_kept: this.segments.length,
      segments_limit: KEEP_SEGMENTS,
    };
  }

  /** 最近的分数轨迹（给页面画滚动列表/折线）。 */
  scoreHistory(limit = KEEP_HISTORY) { return this.history.slice(-limit); }

  /**
   * ⚠ `wav_available` **现读磁盘**，不信内存里的那条记录。
   * 一个「列表里有、点下去 404」的按钮，比一个明说「音频已不在」的条目更难查。
   */
  recentSegments(limit = KEEP_SEGMENTS) {
    return this.segments.slice(0, limit).map((s) => ({
      ...s,
      wav_available: fs.existsSync(path.join(this.dataRoot, s.wav)),
    }));
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 正式链的连续 PCM（consumer `speaker_gate`）+ Speaker Lab 那一份声纹与校准
 * [OUTPUT]: ① 一条以 App 单调时钟为坐标的 USER/OTHER presence 时间轴；
 *           ② 每个 FireRedVAD segment 的 KEEP/DROP；③ 说话人门是否放行
 * [POS]: docs/081 正式声纹门。Speaker Lab 是**校准台**，这里是**生产线**——
 *        两者共用同一份 profile 与同一套滑窗判据，⛔ 不再开第二套登记系统。
 *
 * ⭐ 结构上只有一条不能动的红线：**CAM++ 的窗跑在连续 PCM 上，与 FireRedVAD 的段边界无关。**
 *   离线 PoC 已经证明「按 VAD 段切 CAM++」会误杀使用者——背景持续说话时段边界由背景决定，
 *   用户那一句被包在中间，整段 embedding 被背景主导。所以这里的时间轴是**独立**的：
 *   即使 VAD 连续几十秒判 speech，USER-VAD 仍然可以是 OTHER → USER → OTHER。
 *
 * ⭐ 安全语义与 docs/079 的 RMS 门同侧，一条没松：**能 DROP 的条件是穷举出来的**，
 *   其余一切（没开、没声纹、没校准、推理出错、超时、时间轴盖不住这一段）一律 KEEP。
 *   一个能把使用者说的话吃掉的门，比没有门糟得多。
 * [PROTOCOL]: 判据全在纯函数里（`decideSegment` / `calibrationStatus`），单测直接驱动。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import { PcmRing, SR, toInt16 } from './pcm-ring.mjs';
import { UserVadState } from './uservad.mjs';

const FRAME_MS_FALLBACK = 100;

export const SPEAKER_GATE_DEFAULTS = Object.freeze({
  /** ⛔ 默认 OFF。开着的实验功能不叫实验功能。 */
  enabled: false,
  /**
   * 时间轴至少要盖住这一段的多少比例才敢判。盖不住 ⇒ KEEP。
   * ⚠ 这不是「宁可少判」的洁癖：CAM++ 在安静期不跑（§六），段头可能没有窗，
   *   而一个只看见段尾的判决，判的是别的东西。
   */
  min_coverage: 0.5,
  /** 单次 CAM++ 的上限。超时算错误 ⇒ 该段 KEEP。 */
  inference_timeout_ms: 3000,
  /**
   * ⭐ 「这一步值不值得调 CAM++」的判据。**刻意与 RMS 开门阈值分开。**
   *
   * ⚠ 第一版复用了 `rms_gate.open_threshold`（0.05），真机当场付出代价：
   *   背景谈话节目的逐帧 RMS 大多落在 0.015–0.04，**低于 RMS 开门阈值**，
   *   于是 CAM++ 整段不跑 ⇒ 段上没有窗 ⇒ `no_coverage` / `insufficient_coverage`
   *   ⇒ 安全放行 ⇒ **背景照进 ASR**。757 秒里只有 3.8% 的时间在跑。
   *   两个阈值回答的是不同的问题：RMS 门问「响到值得打开处理链吗」，
   *   这里问「有没有声音可听」，后者必须低得多。
   */
  rms_activity: 0.008,
  /** presence 时间轴保留多久（只留最近的，⛔ 不进 `/live`）。 */
  timeline_ms: 120_000,
});

const clampNumber = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export const normalizeSpeakerGate = (raw = {}) => ({
  enabled: raw.enabled === true,
  min_coverage: clampNumber(raw.min_coverage, SPEAKER_GATE_DEFAULTS.min_coverage, 0, 1),
  rms_activity: clampNumber(raw.rms_activity, SPEAKER_GATE_DEFAULTS.rms_activity, 0, 1),
  inference_timeout_ms: Math.round(clampNumber(raw.inference_timeout_ms,
    SPEAKER_GATE_DEFAULTS.inference_timeout_ms, 200, 30_000)),
  timeline_ms: Math.round(clampNumber(raw.timeline_ms,
    SPEAKER_GATE_DEFAULTS.timeline_ms, 10_000, 600_000)),
});

/**
 * 校准是否成立。⭐ 阈值**不是模型常数**，它绑在 (声纹, 窗长) 上：
 * 真机对照——TTS 声纹下使用者 p50 0.83，换成真人声纹只有 0.59，同一个 0.70
 * 在前者是干净工作点，在后者会把本人挡在门外。所以换声纹、换窗长、换阈值
 * 都必须由人**重新确认一次**，在那之前生产链一律安全放行。
 *
 * ⚠ 这是一条**持久**判据（落在 Speaker Lab 的 `uservad.json`），
 *   不是 `UserVadState.calibrationStale` 那个「本次会话内改过窗长」的内存提示。
 * @returns {{ ok: boolean, reason: string }}
 */
export const calibrationStatus = ({
  profileReady = false, fingerprint = null, config = {}, ackedFor = null,
} = {}) => {
  if (!profileReady || !fingerprint) return { ok: false, reason: 'profile_missing' };
  if (!ackedFor) return { ok: false, reason: 'calibration_not_acknowledged' };
  if (ackedFor.profile_fingerprint !== fingerprint) {
    return { ok: false, reason: 'profile_changed' };
  }
  if (Number(ackedFor.window_ms) !== Number(config.window_ms)) {
    return { ok: false, reason: 'window_changed' };
  }
  if (Number(ackedFor.threshold) !== Number(config.threshold)) {
    return { ok: false, reason: 'threshold_changed' };
  }
  return { ok: true, reason: 'calibrated' };
};

/** 把一组 [start,end) 合并后求总长——⛔ 窗是重叠的（step < window），不能直接相加。 */
const unionMs = (spans) => {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    if (s > curEnd) { total += curEnd - curStart; curStart = s; curEnd = e; }
    else if (e > curEnd) curEnd = e;
  }
  return total + (curEnd - curStart);
};

const round4 = (x) => (x === null || x === undefined ? null : Number(Number(x).toFixed(4)));

/**
 * 判一个 FireRedVAD segment。**纯函数**——判据长什么样就在这一层钉死。
 *
 * ⭐ 判据刻意只有一句：**这段时间里出现过最终 USER 状态就整段 KEEP。**
 *   `user_present_ratio` 只记录、**绝不**当硬规则——「5 秒背景 + 1 秒用户」的占比天然很低，
 *   而那正是必须留下的那一段（任务书 §十一）。
 * ⛔ 绝不在段内裁 PCM：USER-VAD 只回答整段的去留（§十）。
 *
 * @param windows presence 窗，每个 { start_mono_ms, end_mono_ms, state, similarity }
 * @param errors  推理失败的时刻 [{ start_mono_ms, end_mono_ms }]
 */
export const decideSegment = ({
  windows = [], errors = [], startMonoMs = null, endMonoMs = null,
  minCoverage = SPEAKER_GATE_DEFAULTS.min_coverage, segmentId = null,
} = {}) => {
  const base = {
    gate: 'speaker',
    segment_id: segmentId,
    segment_start_mono_ms: startMonoMs,
    segment_end_mono_ms: endMonoMs,
    at_ms: Date.now(),
    windows_in_range: 0,
    user_windows: 0,
    user_present_ms: 0,
    user_present_ratio: null,
    coverage_ratio: 0,
    peak_similarity: null,
    mean_similarity: null,
  };
  const t0 = Number(startMonoMs);
  const t1 = Number(endMonoMs);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
    return { ...base, decision: 'KEEP', keep_reason: 'timeline_unaligned', drop_reason: null };
  }
  const durationMs = t1 - t0;
  base.segment_duration_ms = durationMs;

  // ⛔ 这一段期间推理出过错 ⇒ 不判。「量不了」绝不能变成「不听了」。
  for (const e of errors) {
    if (Number(e.end_mono_ms) > t0 && Number(e.start_mono_ms) < t1) {
      return { ...base, decision: 'KEEP', keep_reason: 'inference_error', drop_reason: null };
    }
  }

  const overlapping = windows.filter(
    (w) => Number(w.end_mono_ms) > t0 && Number(w.start_mono_ms) < t1);
  if (!overlapping.length) {
    return { ...base, decision: 'KEEP', keep_reason: 'no_coverage', drop_reason: null };
  }
  const clip = (w) => [Math.max(t0, Number(w.start_mono_ms)), Math.min(t1, Number(w.end_mono_ms))];
  const coveredMs = unionMs(overlapping.map(clip));
  const userWindows = overlapping.filter((w) => w.state === 'USER');
  const userMs = unionMs(userWindows.map(clip));
  const sims = overlapping.map((w) => Number(w.similarity)).filter(Number.isFinite);

  const facts = {
    ...base,
    windows_in_range: overlapping.length,
    user_windows: userWindows.length,
    user_present_ms: Math.round(userMs),
    user_present_ratio: round4(userMs / durationMs),
    coverage_ratio: round4(coveredMs / durationMs),
    peak_similarity: sims.length ? round4(Math.max(...sims)) : null,
    mean_similarity: sims.length ? round4(sims.reduce((a, b) => a + b, 0) / sims.length) : null,
  };

  if (coveredMs / durationMs < minCoverage) {
    return { ...facts, decision: 'KEEP', keep_reason: 'insufficient_coverage', drop_reason: null };
  }
  if (userWindows.length) {
    return { ...facts, decision: 'KEEP', keep_reason: 'user_present', drop_reason: null };
  }
  return { ...facts, decision: 'DROP', keep_reason: null, drop_reason: 'other_speaker_only' };
};

/**
 * 正式声纹门。持有环、滑窗节拍、presence 时间轴与统计；判据全部委托给上面的纯函数。
 */
export class SpeakerGate {
  /**
   * @param embedder     CAM++（与 Speaker Lab **同一个**实例，只有一张 CPU 图）
   * @param calibration  `() => { profile, profile_ready, profile_fingerprint, config, acked_for }`
   */
  constructor({ embedder, calibration, config = {}, onChange = () => {} }) {
    this.embedder = embedder;
    this.readCalibration = calibration;
    this.config = normalizeSpeakerGate(config);
    this.onChange = onChange;
    this.uservad = new UserVadState();
    this.ring = new PcmRing(this.uservad.config.window_ms);
    this.windows = [];
    this.errors = [];
    this.monoMs = null;
    this.lastActiveMonoMs = null;
    this.msSinceWindow = 0;
    this.camInFlight = false;
    this.lastError = null;
    this.lastDecision = null;
    this.running = false;
    /**
     * ⭐ **这道门有没有当场证明过自己认得出使用者。**
     *
     * ⚠ 真机付过代价：阈值 0.45 是给上一份声纹定的，换声纹后使用者本人只打到
     *   0.34–0.38，于是 9933 个窗里 **USER 一个都没有**——而门照样以
     *   `other_speaker_only` 连续拒绝时，使用者会把它理解成语音入口失效。
     *   使用者看到的是「叫不动」，而门的状态一路写着 `calibrated`。
     * ⭐ 规则：**一个从来没说过一次「是」的判据，没有资格说「不是」。**
     *   在它至少判出过一个 USER 窗之前，一律放行——与「没声纹/没校准」同一类。
     */
    this.userSeen = false;
    this.armKey = null;
    this.resetTelemetry();
  }

  configure(patch = {}) {
    this.config = normalizeSpeakerGate({ ...this.config, ...patch });
    this.onChange();
    return { ...this.config };
  }

  resetTelemetry() {
    this.counters = {
      since_ms: Date.now(),
      pcm_ms: 0,
      rms_active_ms: 0,
      windows_run: 0,
      windows_skipped_idle: 0,
      windows_skipped_busy: 0,
      windows_skipped_short: 0,
      cam_ms_total: 0,
      cam_errors: 0,
      user_windows: 0,
      other_windows: 0,
      decisions: { keep: 0, drop: 0, bypass: 0 },
      /**
       * ⭐ KEEP 的**理由**要分开数。都记成一个 `keep`，
       *   「判过了，是本人」与「根本没判成」在数字上完全一样——
       *   而后者正是真机上背景漏进 ASR 的那条路。
       */
      keep_reasons: {},
    };
    return this.counters;
  }

  /** 判断门/处理门都要用的那一句：这门现在能不能真的判？ */
  status() {
    const cal = this.readCalibration?.() ?? {};
    const check = calibrationStatus({
      profileReady: cal.profile_ready === true,
      fingerprint: cal.profile_fingerprint ?? null,
      config: cal.config ?? {},
      ackedFor: cal.acked_for ?? null,
    });
    const enabled = this.config.enabled === true;
    /**
     * 校准身份一变（换声纹 / 换窗长 / 换阈值），此前那些 USER 证据就不再作数——
     * 它们是**另一套判据**下的结论。
     */
    const key = check.ok
      ? `${cal.profile_fingerprint}|${cal.config?.window_ms}|${cal.config?.threshold}` : null;
    if (key !== this.armKey) {
      /**
       * ⚠ 「第一次读到」不是「变了」。第一版在这里无条件清零，于是**每次 `status()`
       *   都会把刚攒到的证据擦掉**——`userSeen` 在实例上是 true，而 `status()` 报 false。
       *   单测抓到了（`armed` 恒 false）。
       */
      if (this.armKey !== null || key === null) this.userSeen = false;
      this.armKey = key;
    }
    return {
      enabled,
      /** ⭐ `ok` 才有资格 DROP。其余一律安全放行，理由**具名**，不压成一个 false。 */
      ok: enabled && check.ok,
      reason: !enabled ? 'gate_disabled' : check.reason,
      profile_ready: cal.profile_ready === true,
      profile_fingerprint: cal.profile_fingerprint ?? null,
      acked_for: cal.acked_for ?? null,
      uservad_config: { ...(cal.config ?? {}) },
      /** 这套校准下有没有认出过使用者一次。false ⇒ 门只放行，不拒绝。 */
      user_seen: this.userSeen,
      /** ⭐ `ok` 说的是「校准齐了」，`armed` 说的是「可以拒绝了」。两件事。 */
      armed: enabled && check.ok && this.userSeen,
    };
  }

  /** 让滑窗参数跟着 Speaker Lab 的校准走——⛔ 生产链不另存一份阈值。 */
  #syncRuntime(cal) {
    const c = cal?.config ?? {};
    const before = this.uservad.config.window_ms;
    this.uservad.configure({
      window_ms: c.window_ms, step_ms: c.step_ms, threshold: c.threshold,
      on_windows: c.on_windows, off_windows: c.off_windows,
    });
    if (this.uservad.config.window_ms !== before) {
      this.ring.resize(this.uservad.config.window_ms);
    }
  }

  /**
   * 喂一帧 PCM。
   * @param meta        PCM WS 的锚（`mono_ms` 与 VAD segment 的 `start/end_mono_ms` 同一时钟）
   * @param rms         这一帧的 RMS（由调用方算一次，⛔ 不在这里重算第二遍）
   * @param rmsThreshold 低于它就不调 CAM++（§六，复用既有 RMS 门的阈值）
   */
  ingest(frame, meta = null, { rms = null, rmsThreshold = null } = {}) {
    const activity = rmsThreshold === null ? this.config.rms_activity : Number(rmsThreshold);
    if (this.config.enabled !== true) return;
    const cal = this.readCalibration?.() ?? {};
    this.#syncRuntime(cal);

    const frameMs = frame.length / 2 / SR * 1000;
    /**
     * ⭐ 坐标只认 App 的 `mono_ms`。⛔ 不用 `Date.now()`——段的时间戳来自 App，
     *   两套时钟对齐出来的 presence 是**看起来对的错答案**。
     */
    const anchored = Number(meta?.mono_ms);
    const endMono = Number.isFinite(anchored) ? anchored + frameMs
      : (this.monoMs === null ? null : this.monoMs + frameMs);
    this.monoMs = endMono;
    this.ring.push(frame);          // ⛔ 环常时维护，与推理开不开无关
    this.counters.pcm_ms += frameMs;

    const active = rms !== null && Number(rms) >= activity;
    if (active) {
      this.counters.rms_active_ms += frameMs;
      if (endMono !== null) this.lastActiveMonoMs = endMono;
    }
    this.running = true;

    this.msSinceWindow += frameMs;
    if (this.msSinceWindow < this.uservad.config.step_ms) return;
    /**
     * ⚠ 归零而不是减去 `step_ms`——于是 100ms 帧 + 250ms 步的**实际节拍是 300ms**。
     * ⛔ 这是刻意与 Speaker Lab 保持逐字一致：使用者的阈值与迟滞
     *   （`on_windows=2` ⇒ 600ms 才进 USER）是在这个节拍下校准出来的。
     *   把生产链单独「修」成 250ms，等于让确认过的那个数配上没确认过的时序。
     */
    this.msSinceWindow = 0;

    /**
     * §六：安静时不跑 CAM++，但环照样在填。判据是「最近一个窗长之内有没有活动」——
     * 用 `window_ms` 而不是 0，因为窗尾静下来时窗里那一秒半仍然装着刚说完的话。
     */
    const wMs = this.uservad.config.window_ms;
    if (endMono === null || this.lastActiveMonoMs === null
      || endMono - this.lastActiveMonoMs > wMs) {
      this.counters.windows_skipped_idle += 1;
      return;
    }
    const chunk = this.ring.tail(wMs);
    if (!chunk) { this.counters.windows_skipped_short += 1; return; }
    if (this.camInFlight) { this.counters.windows_skipped_busy += 1; return; }
    if (cal.profile_ready !== true) { this.counters.windows_skipped_idle += 1; return; }
    // ⛔ 窗的时间范围必须在**取样的这一刻**定下来：await 回来时 `monoMs` 已经往前走了。
    void this.#runWindow(Buffer.from(chunk), Math.round(endMono - wMs), Math.round(endMono), cal);
  }

  async #runWindow(chunk, startMono, endMono, cal) {
    this.camInFlight = true;
    const t0 = Date.now();
    try {
      const embedding = await this.#embedWithTimeout(toInt16(chunk));
      const similarity = cal.profile?.score?.(embedding) ?? null;
      if (similarity === null) throw new Error('speaker profile produced no score');
      const entry = this.uservad.push({
        similarity, monoMs: endMono,
        windowStartMs: startMono, windowEndMs: endMono,
        inferenceMs: Date.now() - t0,
      });
      this.windows.push({
        seq: entry.seq,
        start_mono_ms: startMono, end_mono_ms: endMono,
        state: entry.state, similarity: entry.similarity,
        raw_match: entry.raw_match,
      });
      this.#prune(endMono);
      this.counters.windows_run += 1;
      this.counters.cam_ms_total += Date.now() - t0;
      if (entry.state === 'USER') { this.counters.user_windows += 1; this.userSeen = true; }
      else this.counters.other_windows += 1;
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.counters.cam_errors += 1;
      // ⛔ 错误也要落在时间轴上：盖住这一段的错误 ⇒ 该段 KEEP，而不是当作「没人说话」。
      this.errors.push({ start_mono_ms: startMono, end_mono_ms: endMono, error: this.lastError });
      if (this.errors.length > 50) this.errors.shift();
    } finally {
      this.camInFlight = false;
      this.onChange();
    }
  }

  #embedWithTimeout(samples) {
    const limit = this.config.inference_timeout_ms;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CAM++ timeout after ${limit}ms`)), limit);
      if (typeof timer.unref === 'function') timer.unref();
      Promise.resolve(this.embedder.embed(samples)).then(
        (r) => { clearTimeout(timer); resolve(r.embedding); },
        (e) => { clearTimeout(timer); reject(e); });
    });
  }

  #prune(nowMonoMs) {
    const floor = nowMonoMs - this.config.timeline_ms;
    while (this.windows.length && this.windows[0].end_mono_ms < floor) this.windows.shift();
    while (this.errors.length && this.errors[0].end_mono_ms < floor) this.errors.shift();
  }

  /**
   * 处理门：判一个 FireRedVAD segment。
   * ⭐ 只有「门开着 + 校准成立 + 时间轴盖得住 + 全程 OTHER」才 DROP，其余全部 KEEP。
   */
  decideSegment(segment = {}) {
    const st = this.status();
    if (st.ok && !st.user_seen) {
      const d = {
        gate: 'speaker', segment_id: segment.segment_id ?? null,
        decision: 'KEEP', keep_reason: 'bypass_no_user_evidence_yet', drop_reason: null,
        bypass: true, at_ms: Date.now(),
      };
      this.counters.decisions.bypass += 1;
      this.#countKeepReason(d.keep_reason);
      this.lastDecision = d;
      return d;
    }
    if (!st.ok) {
      const d = {
        gate: 'speaker', segment_id: segment.segment_id ?? null,
        decision: 'KEEP', keep_reason: `bypass_${st.reason}`, drop_reason: null,
        bypass: true, at_ms: Date.now(),
      };
      this.counters.decisions.bypass += 1;
      this.#countKeepReason(d.keep_reason);
      this.lastDecision = d;
      return d;
    }
    const d = decideSegment({
      windows: this.windows, errors: this.errors,
      startMonoMs: segment.start_mono_ms, endMonoMs: segment.end_mono_ms,
      minCoverage: this.config.min_coverage, segmentId: segment.segment_id ?? null,
    });
    d.threshold = this.uservad.config.threshold;
    d.window_ms = this.uservad.config.window_ms;
    if (d.decision === 'DROP') this.counters.decisions.drop += 1;
    else { this.counters.decisions.keep += 1; this.#countKeepReason(d.keep_reason); }
    this.lastDecision = d;
    this.onChange();
    return d;
  }

  #countKeepReason(reason) {
    const key = String(reason ?? 'unknown');
    this.counters.keep_reasons[key] = (this.counters.keep_reasons[key] ?? 0) + 1;
  }

  /** Mic 关掉 / 停链：把流状态清干净，⛔ 不自行恢复。 */
  forceIdle(reason = 'mic_off') {
    this.running = false;
    this.ring.clear();
    this.windows = [];
    this.errors = [];
    this.monoMs = null;
    this.lastActiveMonoMs = null;
    this.msSinceWindow = 0;
    this.uservad.reset();
    this.userSeen = false;          // ⛔ 证据随时间轴一起清掉，不跨会话沿用
    this.lastError = null;
    this.lastIdleReason = reason;
    this.onChange();
  }

  /** ⛔ 刻意不含时间轴：正式 `/live` 只要当前状态与少量统计（§十七）。 */
  snapshot() {
    const st = this.status();
    const c = this.counters;
    const elapsed = Math.max(1, Date.now() - c.since_ms);
    return {
      schema: 'termux-os.speech-speaker-gate.v1',
      ...st,
      running: this.running,
      state: this.uservad.state,
      last_similarity: this.windows.at(-1)?.similarity ?? null,
      last_window_end_mono_ms: this.windows.at(-1)?.end_mono_ms ?? null,
      mono_ms: this.monoMs,
      rms_active: this.lastActiveMonoMs !== null && this.monoMs !== null
        && this.monoMs - this.lastActiveMonoMs <= this.uservad.config.window_ms,
      timeline_windows: this.windows.length,
      config: { ...this.config },
      last_decision: this.lastDecision,
      last_error: this.lastError,
      telemetry: {
        ...c,
        elapsed_ms: elapsed,
        /** duty cycle proxy：**推理占的墙钟比例**，不是 CPU 占用率。 */
        cam_duty: round4(c.cam_ms_total / elapsed),
        rms_active_ratio: c.pcm_ms > 0 ? round4(c.rms_active_ms / c.pcm_ms) : null,
      },
    };
  }
}

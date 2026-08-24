/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 正式链的连续 PCM（consumer `activity_shadow`）+ 生产那张 FireRedVAD 的逐帧概率
 * [OUTPUT]: shadow candidate / USER_SEEN / endpoint / COMMIT **元数据**与真机 workload
 * [POS]: docs/083。⛔ **只观测，不判决**：不调 SenseVoice、不写 records、不占 50 句、
 *        不改 listen session。默认 OFF。
 *
 * ⛔ 不为 shadow 新开第二套麦克风，也不新开第二张 FireRedVAD——
 *   VAD 概率来自生产控制器的观测钩子（有状态的流，两个消费者会互相污染 recurrent state）。
 * ⭐ PCM **从候选之前就一直保留**：环常时滚动，确认 USER 之后回看加 pre-roll，句首不丢。
 *   ⛔ 「确认之后才开始记录」正是这套设计要避免的东西。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { PcmRing, SR, toInt16 } from './pcm-ring.mjs';
import { TargetActivityFsm, normalizeActivityConfig } from './activity-fsm.mjs';

/**
 * 采样**本进程**（node）的 CPU 时间。⛔ 墙钟不是 CPU 时间，报告里两者必须分开。
 *
 * ⚠ 但它**不是 CAM++ 的 CPU 时间**，别按名字用：CAM++ 的 ONNX 跑在 App 的
 *   `:ort_worker` 里（`CamPlusEmbedder` 是 `backend:'cpu'` 的 ResidentGraph），
 *   node 这边只有 fbank 和 Binder 往返；而 `await` 期间事件循环还在干**别的**活，
 *   这些也一并计进来了。所以字段名一律带 `node_`，
 *   真正要回答「CAM++ 花了多少 CPU」必须去读两个进程的 `/proc/<pid>/stat` 并 OFF/ON 配对相减。
 */
const readCpuMs = () => {
  try {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1000;
  } catch { return null; }
};

export class TargetActivityShadow {
  /**
   * @param embedder    CAM++（与 Speaker Lab / 正式声纹门**同一个**实例，只有一张 CPU 图）
   * @param calibration `() => { profile, profile_ready, ... }`（复用既有真人声纹，⛔ 不另登记）
   */
  constructor({ embedder, calibration, config = {}, onChange = () => {} }) {
    this.embedder = embedder;
    this.readCalibration = calibration;
    this.onChange = onChange;
    this.config = normalizeActivityConfig(config);
    this.fsm = new TargetActivityFsm(this.config, { onCommit: () => this.onChange() });
    this.enabled = false;
    this.#resetStream();
    this.stats = this.#zeroStats();
  }

  #zeroStats() {
    return {
      since_ms: Date.now(),
      pcm_ms: 0,
      cam_calls: 0,
      cam_skipped_silent: 0,
      /**
       * ⛔ 与 `silent` 分开：「没登记声纹所以没法算」和「静音所以不必算」是两件事。
       *   混在一起，`silent_skip_ratio`（本轮要回答的省电问题）会把「压根没在工作」
       *   报成「VAD gating 省下来的」——一个看起来很好看的错误答案。
       */
      cam_skipped_no_profile: 0,
      cam_skipped_busy: 0,
      cam_skipped_short: 0,
      cam_wall_ms: [],
      cam_wall_total_ms: 0,
      node_cpu_ms_during_cam: 0,
      cam_errors: 0,
      vad_frames: 0,
      vad_skew_ms_max: 0,
    };
  }

  #resetStream() {
    this.ring = new PcmRing(this.config.window_ms);
    this.msSinceWindow = 0;
    this.camInFlight = false;
    this.pcmMonoMs = null;
    this.firstPcmMonoMs = null;
    this.vadAnchorMs = null;
    this.lastError = null;
  }

  configure(patch = {}) {
    this.config = normalizeActivityConfig({ ...this.config, ...patch });
    this.fsm.configure(this.config);
    this.ring.resize(this.config.window_ms);
    this.onChange();
    return { ...this.config };
  }

  setEnabled(on) {
    const next = on === true;
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    // ⛔ 关掉即清空：留着旧时间轴，下次开机第一个 candidate 会拿关机前的证据。
    this.#resetStream();
    this.fsm.reset();
    this.onChange();
    return this.enabled;
  }

  /** Mic 关掉 / 停链。⛔ 不自行恢复。 */
  forceIdle(reason = 'mic_off') {
    if (!this.enabled && this.pcmMonoMs === null) return;
    this.fsm.flush(this.pcmMonoMs ?? 0);
    this.#resetStream();
    this.fsm.reset();
    this.lastIdleReason = reason;
    this.onChange();
  }

  /**
   * 生产 VAD 的每一帧概率。
   * ⚠ 帧序号即音频时间（10 ms/帧），但 VAD 推理是**成批**的、落后 PCM 一段。
   *   所以时间戳取 `anchor + i*10`，并用当前 PCM 时刻**封顶**——
   *   ⛔ 不能让观测的时间戳跑到已经收到的音频前面去。偏差如实记进 `vad_skew_ms_max`。
   */
  onVadProbability(probability, frameIndex) {
    if (!this.enabled || this.pcmMonoMs === null) return;
    if (this.vadAnchorMs === null) this.vadAnchorMs = this.firstPcmMonoMs;
    const ideal = this.vadAnchorMs + frameIndex * 10;
    const monoMs = Math.min(ideal, this.pcmMonoMs);
    this.stats.vad_frames += 1;
    this.stats.vad_skew_ms_max = Math.max(this.stats.vad_skew_ms_max, ideal - monoMs);
    this.fsm.onVad(monoMs, Number(probability));
  }

  /**
   * 一帧 PCM。⛔ 环**常时**滚动，与推理开不开无关
   *   （VAD gate inference ≠ VAD gate PCM buffer）。
   */
  ingest(frame, meta = null) {
    if (!this.enabled) return;
    const frameMs = frame.length / 2 / SR * 1000;
    const anchored = Number(meta?.mono_ms);
    const end = Number.isFinite(anchored) ? anchored + frameMs
      : (this.pcmMonoMs === null ? null : this.pcmMonoMs + frameMs);
    this.pcmMonoMs = end;
    if (this.firstPcmMonoMs === null) this.firstPcmMonoMs = end;
    this.ring.push(frame);
    this.stats.pcm_ms += frameMs;

    this.msSinceWindow += frameMs;
    if (this.msSinceWindow < this.config.step_ms) return;
    this.msSinceWindow = 0;
    if (end === null) return;

    // ⭐ 静默时不调 CAM++（省电），但**环照样在滚**——重新活跃时第一个窗当场就有。
    if (!this.fsm.shouldInfer(end)) { this.stats.cam_skipped_silent += 1; return; }
    const chunk = this.ring.tail(this.config.window_ms);
    if (!chunk) { this.stats.cam_skipped_short += 1; return; }
    if (this.camInFlight) { this.stats.cam_skipped_busy += 1; return; }
    const cal = this.readCalibration?.() ?? {};
    if (cal.profile_ready !== true) { this.stats.cam_skipped_no_profile += 1; return; }
    void this.#runWindow(Buffer.from(chunk), Math.round(end), cal);
  }

  async #runWindow(chunk, endMono, cal) {
    this.camInFlight = true;
    const t0 = Date.now();
    const cpu0 = readCpuMs();
    try {
      const e = await this.embedder.embed(toInt16(chunk));
      const sim = cal.profile?.score?.(e.embedding);
      if (sim === null || sim === undefined) throw new Error('profile produced no score');
      const wall = Date.now() - t0;
      const cpu1 = readCpuMs();
      this.stats.cam_calls += 1;
      this.stats.cam_wall_total_ms += wall;
      if (cpu0 !== null && cpu1 !== null) this.stats.node_cpu_ms_during_cam += Math.max(0, cpu1 - cpu0);
      this.stats.cam_wall_ms.push(wall);
      if (this.stats.cam_wall_ms.length > 500) this.stats.cam_wall_ms.shift();
      this.fsm.onWindow(endMono, sim);
      this.lastSimilarity = sim;
      this.lastError = null;
    } catch (error) {
      this.stats.cam_errors += 1;
      this.lastError = String(error?.message ?? error);
    } finally {
      this.camInFlight = false;
      this.onChange();
    }
  }

  resetStats() {
    this.stats = this.#zeroStats();
    return this.stats;
  }

  snapshot() {
    const s = this.stats;
    const w = [...s.cam_wall_ms].sort((a, b) => a - b);
    const q = (p) => (w.length ? w[Math.min(w.length - 1, Math.round((w.length - 1) * p))] : null);
    const elapsed = Math.max(1, Date.now() - s.since_ms);
    const fsm = this.fsm.snapshot();
    return {
      ...fsm,
      enabled: this.enabled,
      similarity: this.lastSimilarity ?? null,
      last_error: this.lastError ?? null,
      workload: {
        pcm_s: Math.round(s.pcm_ms / 1000),
        cam_calls: s.cam_calls,
        cam_wall_p50_ms: q(0.5), cam_wall_p90_ms: q(0.9),
        cam_wall_total_s: Number((s.cam_wall_total_ms / 1000).toFixed(1)),
        /**
         * ⭐ CPU 时间与墙钟分开：`embed()` 的墙钟里包含 Binder 往返与排队。
         * ⚠ 名字里的 `node_` 是认真的——这是 **node 进程**在 CAM++ 调用未返回期间的 CPU，
         *   ⛔ 不是 CAM++ 的 CPU（那在 `:ort_worker`），也不是纯净的（事件循环还在干别的）。
         */
        node_cpu_during_cam_s: Number((s.node_cpu_ms_during_cam / 1000).toFixed(1)),
        cam_wall_duty: Number((s.cam_wall_total_ms / elapsed).toFixed(4)),
        node_cpu_during_cam_duty: Number((s.node_cpu_ms_during_cam / elapsed).toFixed(4)),
        cam_errors: s.cam_errors,
        skipped: { silent: s.cam_skipped_silent, busy: s.cam_skipped_busy,
                   short: s.cam_skipped_short, no_profile: s.cam_skipped_no_profile },
        /** 静默时不调 CAM++ 实际省掉的比例（本实现已经在省）。 */
        silent_skip_ratio: (s.cam_calls + s.cam_skipped_silent)
          ? Number((s.cam_skipped_silent / (s.cam_calls + s.cam_skipped_silent)).toFixed(4))
          : null,
        vad_frames: s.vad_frames,
        vad_skew_ms_max: s.vad_skew_ms_max,
        elapsed_s: Math.round(elapsed / 1000),
      },
    };
  }

  history(limit = 30) { return this.fsm.history(limit); }
}

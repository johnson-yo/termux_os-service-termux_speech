/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 按时间到达的两种事件——CAM++ 滑窗分数、FireRedVAD 逐帧概率
 * [OUTPUT]: OTHER / MAYBE_USER / USER / MAYBE_END 状态机 + candidate 生命周期 + COMMIT（带理由）
 * [POS]: docs/083 Target Activity **shadow** 链。⛔ **纯逻辑：没有 IO、没有模型、没有音频。**
 *        判据长什么样就在这一层钉死，单测毫秒级驱动。
 *
 * ⭐ 它回答的是三个**产品**问题，不是「把 USER 的每一帧裁出来」：
 *   ① 用户开口后多久能确认是他 ② 说完后多久能 commit ③ 背景会不会误触发。
 *   所以 candidate 允许 `[短背景][USER 主体][短背景]` 一起提交。
 *
 * ⭐ 两条被 PoC 真机数据逼出来的规则，改动前请先读它们的理由：
 *   ① **同一段音频不许开出第二个 candidate**——判据是「这个窗的**起点**是不是已经提交过」，
 *      ⛔ 不是任何形式的冷却时间。没有它，一次 1 秒的讲话会被切成 3 个 commit：
 *      commit 之后 1.5 s 的窗里还装着刚提交的音频，分数照样 0.63，于是当场又开一个。
 *   ② **非语音就肯定不是用户**——VAD 判这一带没有语音时，CAM++ 那个窗没有资格抬状态。
 *      它比事后加冷却干净，顺带让静默期可以不调 CAM++。
 *
 * 参数来自 `PoC/campplus-activity-fsm/REPORT.md`（marker `CAMPLUS_TARGET_ACTIVITY_GO=1`），
 * ⛔ 本轮不重新调：window 1500 / step 250 / enter 0.40 / exit 0.35 / 2-2 / pre 500 / post 400。
 * ⚠ `step_ms` 刻意保持 250：PoC 实测 500 会让 1 秒的讲话从 3/3 掉到 1/3，
 *   而且降阈值与 `enter_confirm=1` 都救不回——那是窗落点的限制，不是阈值的。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const OTHER = 'OTHER';
export const MAYBE_USER = 'MAYBE_USER';
export const USER = 'USER';
export const MAYBE_END = 'MAYBE_END';

export const ACTIVITY_DEFAULTS = Object.freeze({
  window_ms: 1500,
  step_ms: 250,
  enter_threshold: 0.40,
  exit_threshold: 0.35,
  enter_confirm: 2,
  exit_confirm: 2,
  pre_roll_ms: 500,
  post_roll_ms: 400,
  intra_pause_grace_ms: 1200,
  hard_cap_ms: 15_000,
  vad_speech_threshold: 0.5,
  /** VAD 否决权的回看窗：窗尾这么久之内没有语音，就不认这个窗。 */
  vad_gate_lookback_ms: 400,
  vad_gates_speaker: true,
  /**
   * ⭐ 半快门 → 全快门的等待期（ms，音频时钟）。
   *   0 = 旧行为：退出确认之后立刻 commit。
   *   >0 = 退出确认只算**半快门**（先记下句尾锚点但不封段）；
   *        在这段时间内分数若重新越过 enter，就**并回同一段**（小停顿不切句）；
   *        真的没有后续了才落**全快门** → commit。
   * ⚠ 关键：等待的是**判决**，不是**切点** —— 句尾锚点仍是最后一轮的
   *   `first_maybe_end`，所以多等并不会让尾巴变长。
   */
  continuation_grace_ms: 0,
  /** 事件保留条数——⛔ 必须有界，shadow 不许无限增长。 */
  keep_events: 30,
});

const clamp = (v, fallback, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

export const normalizeActivityConfig = (raw = {}) => ({
  window_ms: Math.round(clamp(raw.window_ms, ACTIVITY_DEFAULTS.window_ms, 500, 4000)),
  step_ms: Math.round(clamp(raw.step_ms, ACTIVITY_DEFAULTS.step_ms, 100, 1000)),
  enter_threshold: clamp(raw.enter_threshold, ACTIVITY_DEFAULTS.enter_threshold, -1, 1),
  exit_threshold: clamp(raw.exit_threshold, ACTIVITY_DEFAULTS.exit_threshold, -1, 1),
  enter_confirm: Math.round(clamp(raw.enter_confirm, ACTIVITY_DEFAULTS.enter_confirm, 1, 10)),
  exit_confirm: Math.round(clamp(raw.exit_confirm, ACTIVITY_DEFAULTS.exit_confirm, 1, 10)),
  pre_roll_ms: Math.round(clamp(raw.pre_roll_ms, ACTIVITY_DEFAULTS.pre_roll_ms, 0, 5000)),
  post_roll_ms: Math.round(clamp(raw.post_roll_ms, ACTIVITY_DEFAULTS.post_roll_ms, 0, 5000)),
  intra_pause_grace_ms: Math.round(clamp(raw.intra_pause_grace_ms,
    ACTIVITY_DEFAULTS.intra_pause_grace_ms, 100, 10_000)),
  hard_cap_ms: Math.round(clamp(raw.hard_cap_ms, ACTIVITY_DEFAULTS.hard_cap_ms, 2000, 60_000)),
  vad_speech_threshold: clamp(raw.vad_speech_threshold,
    ACTIVITY_DEFAULTS.vad_speech_threshold, 0, 1),
  vad_gate_lookback_ms: Math.round(clamp(raw.vad_gate_lookback_ms,
    ACTIVITY_DEFAULTS.vad_gate_lookback_ms, 0, 5000)),
  vad_gates_speaker: raw.vad_gates_speaker !== false,
  continuation_grace_ms: Math.round(clamp(raw.continuation_grace_ms,
    ACTIVITY_DEFAULTS.continuation_grace_ms, 0, 5000)),
  keep_events: Math.round(clamp(raw.keep_events, ACTIVITY_DEFAULTS.keep_events, 5, 200)),
});

/**
 * ⛔ 只吃两种事件，且都带**音频时间戳**（App 的 `mono_ms`）：
 *   `onWindow(monoMs, similarity)` 与 `onVad(monoMs, probability)`。
 */
export class TargetActivityFsm {
  constructor(config = {}, { onCommit = () => {}, onHalfShutter = () => {} } = {}) {
    this.config = normalizeActivityConfig(config);
    this.onCommit = onCommit;
    /**
     * ⭐ 半快门要**发事件**，不能只写一个字段。
     *
     * 「小停顿只是半快门，可以先处理；无后续才是全快门」——前半句在只写字段的版本里
     * 从来没有兑现过：等待期内什么都不产出，于是那 `continuation_grace_ms` 毫秒
     * 纯粹变成了延迟。事件让上游可以立刻切一段 `incomplete` 去转写，
     * 而判决仍然等到全快门。
     * ⚠ 回弹时 `half_shutter_at_ms` 会被清空，所以下一次停顿会**再发一次** ——
     *   那是对的：那是同一句话的下一个 revision，不是新的一句。
     */
    this.onHalfShutter = onHalfShutter;
    this.reset();
  }

  configure(patch = {}) {
    this.config = normalizeActivityConfig({ ...this.config, ...patch });
    return { ...this.config };
  }

  reset() {
    this.state = OTHER;
    this.enterStreak = 0;
    this.exitStreak = 0;
    this.candidate = null;
    this.silenceSinceMs = null;
    this.speechUntilMs = null;
    this.committedUntilMs = null;
    this.nCandidates = 0;
    this.events = [];
    this.counters = {
      windows: 0, windows_voiced: 0, windows_silent: 0,
      candidates: 0, discarded: 0, commits: 0,
      by_reason: {}, vad_frames: 0, vad_speech_frames: 0,
    };
    this.lastCommit = null;
    this.monoMs = null;
  }

  // ── FireRedVAD（辅助：静音 endpoint + 否决权）────────────────────────────
  onVad(monoMs, probability) {
    const c = this.config;
    this.counters.vad_frames += 1;
    this.monoMs = Math.max(this.monoMs ?? monoMs, monoMs);
    if (probability >= c.vad_speech_threshold) {
      this.counters.vad_speech_frames += 1;
      this.speechUntilMs = monoMs;
      this.silenceSinceMs = null;
      return;
    }
    if (this.silenceSinceMs === null) this.silenceSinceMs = monoMs;
    if (!this.candidate?.user_seen) return;
    // ⭐ 句内自然停顿不算结束：确认过 USER 之后，静默要长于 grace 才认。
    if (monoMs - this.silenceSinceMs >= c.intra_pause_grace_ms) {
      this.#commit(monoMs, 'vad_silence');
    }
  }

  /**
   * 这一刻要不要调 CAM++。⭐ 静默时返回 false —— 调用方据此省掉推理。
   *
   * ⛔ **一帧 VAD 都没收到过 ⇒ 不许否决。**
   *   真机踩到：生产的 FireRedVAD 在**待机期根本不推理**（那正是 gated pipeline 的设计），
   *   而 shadow 要工作的恰恰是待机期。于是「非语音就不是用户」这条规则把自己饿死了——
   *   30 秒里 99 个窗全按静默跳过、CAM++ 一次没跑，而状态显示一切正常。
   *   ⭐ 与「没有证据就不许拒绝」是同一条：**否决权的前提是这个否决者真的在说话。**
   */
  shouldInfer(monoMs) {
    const c = this.config;
    if (!c.vad_gates_speaker) return true;
    if (!this.vadAvailable()) return true;          // VAD 不在线 ⇒ 退回「一直算」
    if (this.speechUntilMs === null) return false;
    return monoMs - this.speechUntilMs <= c.window_ms;
  }

  /** VAD 到底有没有在供数。⛔ 让「没有 VAD」可见，而不是表现为「一直很安静」。 */
  vadAvailable() { return this.counters.vad_frames > 0; }

  // ── CAM++ 滑窗 ──────────────────────────────────────────────────────────
  onWindow(monoMs, similarity) {
    const c = this.config;
    this.monoMs = Math.max(this.monoMs ?? monoMs, monoMs);
    this.counters.windows += 1;
    const before = this.state;

    /** ⭐ 否决权：窗尾附近没有语音 ⇒ 分数再高也不算数。 */
    const voiced = !c.vad_gates_speaker || !this.vadAvailable()
      || (this.speechUntilMs !== null
        && monoMs - this.speechUntilMs <= c.vad_gate_lookback_ms);
    if (voiced) this.counters.windows_voiced += 1;
    else this.counters.windows_silent += 1;

    const aboveEnter = voiced && similarity >= c.enter_threshold;
    const belowExit = similarity < c.exit_threshold;
    this.enterStreak = aboveEnter ? this.enterStreak + 1 : 0;
    this.exitStreak = belowExit ? this.exitStreak + 1 : 0;

    /** ⭐ 窗的起点落在已提交区间内 ⇒ 它讲的是旧事，⛔ 不许据此开新 candidate。 */
    const stale = this.committedUntilMs !== null
      && (monoMs - c.window_ms) < this.committedUntilMs;

    if (this.state === OTHER) {
      if (aboveEnter && !stale) {
        this.nCandidates += 1;
        this.counters.candidates += 1;
        this.state = MAYBE_USER;
        this.candidate = {
          candidate_id: this.nCandidates,
          // candidate 从**窗的起点**开始：PCM 一直留着，确认之后回看，句首不丢。
          candidate_start_ms: Math.max(0, monoMs - c.window_ms),
          first_maybe_user_ms: monoMs,
          confirmed_user_ms: null, first_maybe_end_ms: null, confirmed_user_end_ms: null,
          user_seen: false, max_similarity: similarity, sum_user_sim: 0, user_windows: 0,
          half_shutter_at_ms: null,
          /**
           * 这句话到此为止发过几次半快门。⭐ 它就是 revision 的来源：
           * `revision = half_shutters` 给 incomplete，全快门再 +1 给 complete，
           * 于是同一句话的修订号单调递增，而**句子身份（candidate_id）不变**。
           */
          half_shutters: 0,
          window_count: 0, vad_speech_frames: 0, vad_frames: 0,
        };
      }
    } else if (this.state === MAYBE_USER) {
      if (this.enterStreak >= c.enter_confirm) {
        this.state = USER;
        this.candidate.user_seen = true;
        this.candidate.confirmed_user_ms = monoMs;
      } else if (belowExit) {
        this.counters.discarded += 1;      // ⛔ 没确认过就掉回去 ⇒ 作废，不 commit
        this.candidate = null;
        this.state = OTHER;
      }
    } else if (this.state === USER) {
      if (belowExit) {
        this.state = MAYBE_END;
        if (this.candidate.first_maybe_end_ms === null) {
          this.candidate.first_maybe_end_ms = monoMs;
        }
      }
    } else if (this.state === MAYBE_END) {
      if (aboveEnter) {
        this.state = USER;                  // 只是抖了一下 / 半快门期内又开口了
        this.candidate.first_maybe_end_ms = null;
        this.candidate.half_shutter_at_ms = null;      // ⛔ 旧锚点作废，见 §半快门
      } else if (this.exitStreak >= c.exit_confirm) {
        if (c.continuation_grace_ms > 0) {
          // ⭐ 半快门：记下「可能结束了」，但**不封段**——等看有没有后续。
          if (this.candidate.half_shutter_at_ms === null) {
            this.candidate.half_shutter_at_ms = monoMs;
            this.candidate.half_shutters += 1;
            this.#emitHalfShutter(monoMs);
          } else if (monoMs - this.candidate.half_shutter_at_ms >= c.continuation_grace_ms) {
            // ⭐ 全快门：真的没有后续了才落闸。
            this.candidate.confirmed_user_end_ms = monoMs;
            this.#commit(monoMs, 'speaker_exit');
          }
        } else {
          this.candidate.confirmed_user_end_ms = monoMs;
          this.#commit(monoMs, 'speaker_exit');
        }
      }
    }

    if (this.candidate) {
      const cd = this.candidate;
      cd.window_count += 1;
      cd.max_similarity = Math.max(cd.max_similarity, similarity);
      if (this.state === USER || this.state === MAYBE_END) {
        cd.sum_user_sim += similarity; cd.user_windows += 1;
      }
      if (monoMs - cd.candidate_start_ms >= c.hard_cap_ms) this.#commit(monoMs, 'hard_cap');
    }
    return { state: this.state, transition: before === this.state ? null : `${before}->${this.state}` };
  }

  /**
   * 半快门事件：**这句话到目前为止**的样子。
   *
   * ⛔ 它不改任何状态——不封段、不清 candidate、不计 commit。状态机的判决仍然
   *   只在全快门发生；这里只是把「已经可以先处理的那一段」交出去。
   * ⚠ `end_ms` 用的是半快门时刻减一个窗长，与 `#cutEnd` 的反推同源：分数记在窗尾，
   *   而这一窗已经不由用户主导，所以用户大约停在窗的起点附近。
   */
  #emitHalfShutter(monoMs) {
    const cd = this.candidate;
    if (!cd || !cd.user_seen) return;
    const c = this.config;
    const event = {
      ...cd,
      half_shutter_ms: monoMs,
      revision: cd.half_shutters,
      pcm_start_ms: Math.max(0, cd.candidate_start_ms - c.pre_roll_ms),
      // 反推与全快门同一条规则；上游还会再叠一个 tail margin。
      pcm_end_ms: Math.max(cd.candidate_start_ms, (cd.first_maybe_end_ms ?? monoMs) - c.window_ms),
      mean_user_similarity: cd.user_windows
        ? Number((cd.sum_user_sim / cd.user_windows).toFixed(4)) : null,
      max_similarity: Number(cd.max_similarity.toFixed(4)),
      at_ms: Date.now(),
    };
    delete event.sum_user_sim;
    this.counters.half_shutters = (this.counters.half_shutters ?? 0) + 1;
    try { this.onHalfShutter(event); } catch { /* ⛔ 观测不许影响状态机 */ }
  }

  #commit(monoMs, reason) {
    const cd = this.candidate;
    this.candidate = null;
    this.state = OTHER;
    this.enterStreak = 0;
    this.exitStreak = 0;
    this.silenceSinceMs = null;
    if (!cd || !cd.user_seen) return null;
    const c = this.config;
    this.committedUntilMs = monoMs;
    const event = {
      ...cd,
      commit_ms: monoMs,
      commit_reason: reason,
      // 全快门永远比这句话发过的最后一个 incomplete 大一号。
      revision: (cd.half_shutters ?? 0) + 1,
      pcm_start_ms: Math.max(0, cd.candidate_start_ms - c.pre_roll_ms),
      pcm_end_ms: monoMs + c.post_roll_ms,
      mean_user_similarity: cd.user_windows
        ? Number((cd.sum_user_sim / cd.user_windows).toFixed(4)) : null,
      max_similarity: Number(cd.max_similarity.toFixed(4)),
      at_ms: Date.now(),
      shadow: true,          // ⛔ 永远为 true：本轮不许有人拿它去写 records
    };
    event.duration_ms = event.pcm_end_ms - event.pcm_start_ms;
    delete event.sum_user_sim;
    this.counters.commits += 1;
    this.counters.by_reason[reason] = (this.counters.by_reason[reason] ?? 0) + 1;
    this.events.push(event);
    while (this.events.length > c.keep_events) this.events.shift();
    this.lastCommit = event;
    try { this.onCommit(event); } catch { /* ⛔ 观测不许影响状态机 */ }
    return event;
  }

  /** 流结束/停机：还挂着的 candidate 收尾。 */
  flush(monoMs = this.monoMs) {
    if (this.candidate?.user_seen) return this.#commit(monoMs, 'stream_end');
    this.candidate = null;
    this.state = OTHER;
    return null;
  }

  /** ⛔ 不含长时间轴：正式 `/live` 只要当前状态与少量统计。 */
  snapshot() {
    const c = this.counters;
    return {
      schema: 'termux-os.speech-target-activity.v1',
      state: this.state,
      /** ⭐ VAD 在不在线要**说出来**：它离线时否决权是关着的，行为与设计不同。 */
      vad_available: this.vadAvailable(),
      user_seen: this.candidate?.user_seen === true,
      /** 半快门中＝已经看到疑似句尾，但还在等有没有后续。 */
      half_shutter: this.candidate?.half_shutter_at_ms != null,
      current_candidate_id: this.candidate?.candidate_id ?? null,
      last_commit: this.lastCommit && {
        candidate_id: this.lastCommit.candidate_id,
        commit_reason: this.lastCommit.commit_reason,
        duration_ms: this.lastCommit.duration_ms,
        max_similarity: this.lastCommit.max_similarity,
        at_ms: this.lastCommit.at_ms,
      },
      counters: {
        ...c,
        /** ⭐ 静默时若不调 CAM++ 能省多少——这是本轮要回答的省电问题。 */
        vad_gated_savings: c.windows
          ? Number((c.windows_silent / c.windows).toFixed(4)) : null,
        vad_speech_ratio: c.vad_frames
          ? Number((c.vad_speech_frames / c.vad_frames).toFixed(4)) : null,
      },
      config: { ...this.config },
    };
  }

  history(limit = 30) {
    return this.events.slice(-limit);
  }
}

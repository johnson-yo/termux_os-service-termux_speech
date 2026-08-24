/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 常时滚动的逐帧 RMS（dB）+ 「会话从此刻开始」这一个事件
 * [OUTPUT]: 对外提供本次会话的两个参考层 B* / R*，供 RelativeForegroundGate 定阈值
 * [POS]: docs/079 §生产链。⭐ 生产**不能**要求使用者先录一段背景——
 *        两个锚点都从既有工作流里自动取得：
 *          · 进入处理前的那几秒 = 背景（此刻按定义没人在对它说话）
 *          · 进入处理后收集到的合格语音 = 用户素材
 *
 * ⛔ 三条红线（与 Lab 相同）：
 *   · 参考一旦定下就**冻结到会话结束**，KEEP/DROP 都改不动它
 *     （docs/078 的正反馈正是从「判定回写参考」开始的）；
 *   · 两层分不开 ⇒ 判据不成立 ⇒ **KEEP**，绝不硬 DROP；
 *   · 参考是 **session-local**：换个房间、换个距离、换个人，上一次的层就不成立了。
 *
 * ⭐ 两层自我保护，方向都是「宁可没有 gate，不要误杀使用者」：
 *   ① 一段音频要比 `B*` 高出 `user_min_above_background_db` 才**有资格**定义 R*
 *      ——否则 listen 模式下开门瞬间的第一段背景就会把 R* 定死（真机实测 §生产链）；
 *   ② 即便 R* 还是被定坏了，gap 达不到 `min_separation_db` ⇒ `insufficient_separation`
 *      ⇒ 整场全 KEEP。**判据失效时退化成「没有 gate」，而不是「误杀使用者」。**
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { distributionOf, statFrom, REFERENCE_STATS, SILENCE_DB } from './relative-foreground.mjs';

export const CALIBRATION_DEFAULTS = Object.freeze({
  /** 取会话开始前这么长的一段当背景素材。 */
  background_window_ms: 6000,
  /**
   * ⭐ 紧挨着会话开始的这一段**不算背景**，把使用者的声音算进背景层会让 B* 偏高、
   *   gap 变窄、gate 直接失效。
   */
  background_exclude_ms: 1500,
  /** 背景素材少于这么多就不定 B*（宁可没有 gate，也不要一个乱定的 gate）。 */
  background_min_ms: 2000,
  /** 攒够这么多**合格的**用户素材才定 R*。 */
  user_min_ms: 1500,
  /**
   * ⭐ 一段音频要高出 `B*` 这么多 dB 才**有资格**参与定义 R*。
   *
   * ⚠ 这条是真机逼出来的。第一版没有它，listen 模式下开门 2 秒内 VAD 就published 了一段
   *   **背景**（背景本身是连续人声，段是源源不断的），于是 `R* = -31.96` 被它定死，
   *   比 `B* = -30.83` 还低 ⇒ gap 为负 ⇒ 整场 `insufficient_separation` ⇒ 门等于不存在。
   *   自我保护是对的（没有误杀），但门也永远启用不了。
   *   **「谁算用户素材」必须由一个独立测得的量来判，不能先到先得。**
   *   B* 正是那个独立测得的量：**比背景高出足够多的，才可能是使用者。**
   */
  user_min_above_background_db: 6,
  background_stat: REFERENCE_STATS.background,
  user_stat: REFERENCE_STATS.user,
});

/** 滚动保留最近 N 毫秒的逐帧 dB。⛔ 只存数字，不存 PCM。 */
class DbRing {
  constructor(capacityMs, frameMs) {
    this.frameMs = frameMs;
    this.capacity = Math.max(1, Math.ceil(capacityMs / frameMs));
    this.values = [];
  }

  push(dbFrames) {
    for (const v of dbFrames) this.values.push(v);
    if (this.values.length > this.capacity) {
      this.values.splice(0, this.values.length - this.capacity);
    }
  }

  /** 取最近 `[fromMsAgo, toMsAgo)` 这一段（0 = 现在）。 */
  slice(fromMsAgo, toMsAgo) {
    const n = this.values.length;
    const from = Math.max(0, n - Math.ceil(fromMsAgo / this.frameMs));
    const to = Math.max(from, n - Math.ceil(toMsAgo / this.frameMs));
    return this.values.slice(from, to);
  }

  get ms() { return this.values.length * this.frameMs; }
  clear() { this.values = []; }
}

export class SessionCalibrator {
  constructor(config = {}, frameMs = 10) {
    this.config = { ...CALIBRATION_DEFAULTS, ...config };
    this.frameMs = frameMs;
    this.ring = new DbRing(
      this.config.background_window_ms + this.config.background_exclude_ms,
      frameMs,
    );
    this.reset('init');
  }

  configure(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in this.config)) continue;
      if (k.endsWith('_stat')) { if (typeof v === 'string') this.config[k] = v; }
      else if (Number.isFinite(Number(v))) this.config[k] = Number(v);
    }
    return this.config;
  }

  reset(source = 'reset') {
    this.source = source;
    this.startedAtMs = null;
    this.backgroundDb = null;
    this.backgroundDist = null;
    this.userDb = null;
    this.userDist = null;
    this.userFrames = [];
    this.userMs = 0;
    this.rejectedMs = 0;
    this.frozen = false;
    this.note = 'idle';
  }

  /** ⛔ 门外门内都要喂：B* 的素材**只能**来自会话开始之前。 */
  ingestAmbient(dbFrames) {
    if (dbFrames?.length) this.ring.push(dbFrames);
  }

  /**
   * ⭐ **整窗预置**：用一段外部测得的、已经按时间排好的逐帧 dB **替换**整个环。
   *
   * ⚠ 与 `ingestAmbient` 的差别不是「批量」而是**对齐**：`beginSession` 取的是
   *   `[background_window+exclude, exclude)`，这个区间是**相对环尾**算的。
   *   若在已有内容后面追加，环尾就落在「追加完成的那一刻」，而素材实际截止于
   *   App 采样的那一刻——两者差多少取决于这次 HTTP 花了多久，
   *   于是**背景窗会随网络抖动整体平移**。清空再写，环尾就是素材的尾，
   *   对齐由构造保证而不是由时序碰巧成立。
   *
   * ⚠ 素材不够时**不补齐**：`beginSession` 自己会因为不足而拒绝定 B*
   *   （`background_too_short`），那正是设计好的失败模式——⛔ 没有 gate 好过一个乱定的 gate。
   */
  primeAmbient(dbFrames) {
    this.ring.clear();
    if (dbFrames?.length) this.ring.push(dbFrames);
    return this.ring.ms;
  }

  /**
   * 会话开始。开始前的排除窗只用于保护背景参考，用户素材从正式段中收集。
   */
  beginSession(reason = 'listen', nowMs = Date.now()) {
    this.reset(reason);
    this.startedAtMs = nowMs;
    const c = this.config;
    const bg = this.ring.slice(c.background_window_ms + c.background_exclude_ms, c.background_exclude_ms)
      .filter((v) => v > SILENCE_DB);
    if (bg.length * this.frameMs >= c.background_min_ms) {
      this.backgroundDist = distributionOf(bg);
      this.backgroundDb = statFrom(this.backgroundDist, c.background_stat);
      this.note = 'background_ready';
    } else {
      // ⛔ 素材不够就不定 B*。没有 gate 好过一个乱定的 gate。
      this.note = `background_too_short(${Math.round(bg.length * this.frameMs)}ms)`;
    }
    return this.snapshot();
  }

  /**
   * 这一段够不够格当用户素材：它的 p90 必须比 `B*` 高出 `user_min_above_background_db`。
   * ⛔ `B*` 还没定就一律不收——没有尺子的时候不要量。
   */
  #qualifies(frames) {
    if (this.backgroundDb === null) return false;
    const dist = distributionOf(frames);
    if (!dist) return false;
    return dist.p90 >= this.backgroundDb + this.config.user_min_above_background_db;
  }

  #addUser(frames) {
    if (this.frozen) return;
    if (!this.#qualifies(frames)) {
      this.rejectedMs += frames.length * this.frameMs;
      this.note = `user_material_too_quiet(${Math.round(this.rejectedMs)}ms rejected)`;
      return;
    }
    this.userFrames.push(...frames);
    this.userMs = this.userFrames.length * this.frameMs;
    if (this.userMs >= this.config.user_min_ms) {
      this.userDist = distributionOf(this.userFrames);
      this.userDb = statFrom(this.userDist, this.config.user_stat);
      this.frozen = true;                       // ⛔ 定下就冻结，本会话不再变
      this.note = 'user_ready';
    } else {
      this.note = `user_building(${Math.round(this.userMs)}/${this.config.user_min_ms}ms)`;
    }
  }

  /**
   * 会话内一段音频的逐帧 dB。⛔ 只在 R* 还没定下来时用于建参考；
   * 一旦冻结，后续任何段都**不会**再改动参考——这条就是不回写。
   */
  ingestSegment(dbFrames) {
    if (this.frozen || !dbFrames?.length) return;
    this.#addUser(dbFrames.filter((v) => v > SILENCE_DB));
  }

  references() {
    return { backgroundDb: this.backgroundDb, userDb: this.userDb };
  }

  snapshot() {
    return {
      source: this.source,
      started_at_ms: this.startedAtMs,
      background_db: this.backgroundDb,
      background_stat: this.config.background_stat,
      background_distribution: this.backgroundDist,
      user_db: this.userDb,
      user_stat: this.config.user_stat,
      user_distribution: this.userDist,
      user_sample_ms: this.userMs,
      user_rejected_ms: this.rejectedMs,
      user_min_above_background_db: this.config.user_min_above_background_db,
      frozen: this.frozen,
      ambient_ms: this.ring.ms,
      note: this.note,
    };
  }
}

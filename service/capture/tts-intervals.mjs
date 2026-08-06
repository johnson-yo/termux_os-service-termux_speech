/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App `/ws/android/events` 里的 `data.playing`（当前区间 + 最近若干个已结束区间）与 boot_id
 * [OUTPUT]: `overlaps(startMonoMs, endMonoMs)`——一段音频是否与我们自己的 TTS 播放相交
 * [POS]: docs/061 §四。回灌不再靠关 RMS Gate 解决（那会让整条输入链在播放期间失聪，
 *        而使用者可能正想识别 YouTube 里的话）——改为在 VAD segment **完成时**判断相交。
 *        ⚠ 只处理 Termux-OS 自己明确知道的 TTS；外部媒体一律不拦。
 * [PROTOCOL]: 时刻一律是 App 的 `SystemClock.elapsedRealtime()`。boot_id 变了整份作废——
 *             跨进程的单调时钟在对方重生后没有任何可比性。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */

const CAPACITY = 64;

/**
 * ⚠ 不能写成 `Number.isFinite(Number(value))`——`Number(null)` 是 **0**，
 * 于是「没有时刻」会变成「时刻 0」，而时刻 0 早于一切区间，段就被无条件判为相交。
 * 一个缺失的值伪装成一个合法的值，正是 docs/056 那个形状。
 */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class TtsIntervals {
  constructor({ capacity = CAPACITY } = {}) {
    this.capacity = Math.max(4, capacity);
    this.bootId = null;
    this.intervals = [];
    this.current = null;
  }

  /** App 重生 = 之前记住的所有单调时刻全部失去意义，不是「旧数据」而是「无意义的数据」。 */
  reset(bootId = null) {
    this.bootId = bootId;
    this.intervals = [];
    this.current = null;
  }

  ingest(playing, bootId = null) {
    if (bootId && bootId !== this.bootId) this.reset(bootId);
    if (!playing || typeof playing !== 'object') return;
    const open = playing.current && typeof playing.current === 'object' ? playing.current : null;
    this.current = open
      ? { playback_id: open.playback_id ?? null, start_mono_ms: finite(open.start_mono_ms), end_mono_ms: null }
      : null;
    for (const raw of Array.isArray(playing.recent) ? playing.recent : []) {
      const start = finite(raw?.start_mono_ms);
      const end = finite(raw?.end_mono_ms);
      if (start === null || end === null) continue;
      // 幂等：App 每次都重发同一批 recent，重复的不该堆积。
      if (this.intervals.some((item) => item.start_mono_ms === start && item.end_mono_ms === end)) continue;
      this.intervals.push({ playback_id: raw?.playback_id ?? null, start_mono_ms: start, end_mono_ms: end });
    }
    this.intervals.sort((a, b) => a.start_mono_ms - b.start_mono_ms);
    while (this.intervals.length > this.capacity) this.intervals.shift();
  }

  /**
   * 区间相交，**不是只看开头**：TTS 在一段话中途开始、或只压到结尾，同样是回灌。
   * 正在播的那一段视为 [start, +∞)——它还没结束，谁也不知道会播到什么时候。
   */
  overlaps(startMonoMs, endMonoMs) {
    const start = finite(startMonoMs);
    const end = finite(endMonoMs);
    if (start === null || end === null) return null;
    for (const item of this.intervals) {
      if (item.start_mono_ms <= end && item.end_mono_ms >= start) return item;
    }
    if (this.current && this.current.start_mono_ms !== null && this.current.start_mono_ms <= end) {
      return this.current;
    }
    return null;
  }

  snapshot() {
    return {
      boot_id: this.bootId,
      current: this.current ? { ...this.current } : null,
      retained: this.intervals.length,
      last: this.intervals.at(-1) ? { ...this.intervals.at(-1) } : null,
    };
  }
}

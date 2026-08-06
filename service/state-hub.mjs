/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 每个状态域的构造函数（都是既有快照的投影，不新增状态机）
 * [OUTPUT]: 带 boot_id/version 的完整 snapshot、按域的增量、以及一个「等到有变化再回答」的观测者
 * [POS]: docs/061 §五。**观测的成本正比于事实的变化次数，不正比于时间**——
 *        没有观测者时这里一行都不算；有观测者时状态没变也不重新构造、不重新序列化。
 * [PROTOCOL]: ⛔ 三条不可退让：
 *             ① 新连接必须先拿到**完整** snapshot，否则它会带着一张空表等增量；
 *             ② 版本只增不减，重连后旧 sequence 绝不能覆盖新 snapshot；
 *             ③ 慢客户端不许让服务端堆积——状态只需要**最新事实**，中间值可以丢。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';

export const STATE_SCHEMA = 'termux-os.speech-state.v1';

/** 观测者最长挂多久。比它更久没有变化就返回一次空 delta，让传输层确认链路还活着。 */
export const WATCH_TIMEOUT_MS = 25_000;

/** 两次推送之间的最小间隔。UI 用不到比这更快的更新，而这条上限与载荷是否稳定无关。 */
export const MIN_PUSH_INTERVAL_MS = 200;

/**
 * ⭐ **只随时钟走、不代表任何事实变化的字段**（真机实测得来，不是猜的）。
 *
 * 这一轮我自己踩过：变化检测按整份 JSON 逐字节比，而几乎每个域都带一个
 * `observed_at_ms`——于是「状态变了吗」这个问题**永远**回答是，实测推成
 * 169 帧/秒、1.5 MB/s，比它要取代的 250ms 轮询还糟三倍。
 * ⛔ 判断「变了没有」必须先把时钟摘掉，否则测的是时间不是状态。
 * ⚠ 这份名单不可能穷尽，所以它**不是唯一防线**——`MIN_PUSH_INTERVAL_MS` 才是
 * 那条与载荷无关的硬上限。漏掉一个字段的后果因此是「多推几帧」，不是「推爆」。
 */
const CLOCK_ONLY_KEYS = new Set([
  'observed_at_ms',
  'last_frame_age_ms',
  'owner_age_ms',
  'session_age_ms',
  'sample_age_ms',
  'remaining_ms',
  'age_ms',
  'uptime_ms',
  'elapsed_ms',
  'engaged_for_ms',
]);

/**
 * ⭐ **自由奔跑的计数器**：只要采集还活着它们就每 100ms 加一次，
 * 但没有任何界面因为它们变了而需要重画——帧号从 2072 变成 2073 不是一个事实的变化。
 *
 * 真机实测：把它们算进变化判据，`pcm_stream` 与 `input` 就会跟着 `rms_gate` 一起
 * 每秒推五次，帧从 700 字节涨到 1708，而且概览区被白白重画。
 * ⚠ 它们仍然**在载荷里**且是当下的真值——只是不再由它们决定「要不要推」。
 * 于是诊断页上的计数器会随下一次真实变化一起更新，而不是自己驱动一条回路。
 */
const FREE_RUNNING_COUNTERS = new Set([
  'frame_seq',
  'app_frame_seq',
  'bytes_total',
  'frames_since_anchor',
  'anchors_received',
  'invalid_frames',
  'unknown_text_frames',
  'processed_frames',
  'pcm_frame_count',
]);

/** 比较用的规范形：把纯时钟字段与自由计数器抹平，其余原样。 */
const comparisonKey = (value) => JSON.stringify(
  value,
  (key, item) => (CLOCK_ONLY_KEYS.has(key) || FREE_RUNNING_COUNTERS.has(key) ? 0 : item),
);

export class StateHub {
  /**
   * @param {object} options
   * @param {Record<string, () => unknown>} options.builders 每个域怎么构造。必须是纯投影。
   * @param {string[]} options.hot 随音频持续变化的域。其余为 cold。
   */
  constructor({
    builders, hot = [], now = () => Date.now(), minIntervalMs = MIN_PUSH_INTERVAL_MS,
  }) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.lastPushMs = 0;
    this.pushTimer = null;
    this.builders = builders;
    this.hot = new Set(hot);
    this.now = now;
    this.bootId = crypto.randomUUID();
    this.version = 0;
    /**
     * 域名 → { version, json, key }。`json` 是要发出去的原文（多个订阅者复用同一份），
     * `key` 是**摘掉时钟之后**的比较形。两者必须分开：发出去的要带真实时刻，
     * 用来判断「变了没有」的不能带。
     */
    this.cache = new Map();
    this.waiters = new Set();
    this.dirty = { hot: true, cold: true };
    this.scheduled = false;
    this.builds = 0;
    this.pushes = 0;
    this.lastBuildMs = null;
  }

  /** 有人在看吗。没人看时调用方不必构造任何东西。 */
  get watching() { return this.waiters.size > 0; }

  markHot() { this.dirty.hot = true; }

  /**
   * ⭐ **观测与处理链解耦**（docs/061 §1）。
   *
   * 音频路径每 100ms 调一次，绝不能在那里同步构造状态：一个域的构造哪怕只慢 1ms，
   * 也变成了 PCM 回调的固定开销，而观测本来就不该有资格拖慢处理。
   * 这里只登记「该重算了」，真正的构造交给下一个 `setImmediate` 合并执行。
   */
  schedule() {
    if (this.scheduled || !this.watching) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  markCold() { this.dirty.cold = true; }

  markAll() { this.dirty.hot = true; this.dirty.cold = true; }

  /**
   * 按需重建。**状态没变就不加版本**——这正是「状态不变时不得持续发送完整树」的落点。
   * @returns {boolean} 是否有任何域真的变了
   */
  build(kinds = ['hot', 'cold']) {
    let changed = false;
    for (const [name, make] of Object.entries(this.builders)) {
      const kind = this.hot.has(name) ? 'hot' : 'cold';
      if (!kinds.includes(kind)) continue;
      let json;
      let key;
      try {
        const value = make() ?? null;
        json = JSON.stringify(value);
        key = comparisonKey(value);
      } catch (error) {
        // 一个域构造失败不能让整份状态消失：如实把错误放进那个域。
        json = JSON.stringify({ error: String(error?.message ?? error) });
        key = json;
      }
      const previous = this.cache.get(name);
      if (previous && previous.key === key) {
        // 只有时钟走了：更新原文让下一次全量 snapshot 不陈旧，但**不动版本**。
        this.cache.set(name, { version: previous.version, json, key });
        continue;
      }
      this.version += 1;
      this.cache.set(name, { version: this.version, json, key });
      changed = true;
    }
    this.builds += 1;
    this.lastBuildMs = this.now();
    for (const kind of kinds) this.dirty[kind] = false;
    return changed;
  }

  /**
   * 只在**有人在看**且确实脏了的时候重建，然后叫醒等待者。
   *
   * ⛔ 硬上限：两次推送之间至少隔 `minIntervalMs`。这条与载荷是否稳定**无关**——
   * 它保证「某个字段其实一直在变」最多让我们多睡一会儿，而不会变成一条满速回路。
   */
  pump() {
    if (!this.watching) return false;
    const waited = this.now() - this.lastPushMs;
    if (this.minIntervalMs > 0 && waited < this.minIntervalMs) {
      if (!this.pushTimer) {
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          this.pump();
        }, this.minIntervalMs - waited);
        if (typeof this.pushTimer.unref === 'function') this.pushTimer.unref();
      }
      return false;
    }
    const kinds = [
      ...(this.dirty.hot ? ['hot'] : []),
      ...(this.dirty.cold ? ['cold'] : []),
    ];
    if (!kinds.length) return false;
    const changed = this.build(kinds);
    if (changed) {
      this.lastPushMs = this.now();
      this.wake();
    }
    return changed;
  }

  wake() {
    for (const waiter of [...this.waiters]) {
      if (this.version > waiter.after) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(this.since(waiter.after));
      }
    }
  }

  /**
   * 完整 snapshot。⚠ 它自己就是**用缓存的每域 JSON 拼出来的**，不重新序列化任何东西。
   */
  snapshotJson() {
    if (!this.cache.size) this.build();
    const parts = [...this.cache.entries()]
      .map(([name, entry]) => `${JSON.stringify(name)}:${entry.json}`);
    // ⚠ `"ok":true` 必须在里面。Framework 的 proxy 判成功看的是这个字段，不是 HTTP 状态码——
    // 少了它会得到 `HTTP 200` 却报失败，一条读得出值、含义却相反的响应。
    return `{"ok":true,"schema":${JSON.stringify(STATE_SCHEMA)}`
      + `,"boot_id":${JSON.stringify(this.bootId)}`
      + `,"version":${this.version},"full":true,"domains":{${parts.join(',')}}}`;
  }

  /**
   * 增量。`after` 大于当前版本（例如客户端拿着上一条命的版本重连）时**退回完整 snapshot**——
   * 这正是「重连后以前的 sequence 不得覆盖新 snapshot」：boot_id 变了就必须从头来。
   */
  since(after, bootId = this.bootId) {
    const cursor = Number(after);
    if (bootId !== this.bootId || !Number.isFinite(cursor) || cursor < 0 || cursor > this.version) {
      return { json: this.snapshotJson(), full: true, version: this.version };
    }
    const parts = [...this.cache.entries()]
      .filter(([, entry]) => entry.version > cursor)
      .map(([name, entry]) => `${JSON.stringify(name)}:${entry.json}`);
    return {
      json: `{"ok":true,"schema":${JSON.stringify(STATE_SCHEMA)}`
        + `,"boot_id":${JSON.stringify(this.bootId)}`
        + `,"version":${this.version},"full":false,"domains":{${parts.join(',')}}}`,
      full: false,
      version: this.version,
      changed: parts.length,
    };
  }

  /**
   * 等到有变化。已经有变化就立刻返回，没有就挂着，最长 `timeoutMs`。
   * ⛔ 不排队：每个观测者只持有一个游标，醒来时拿到的永远是**当下**的事实，
   *    而不是一串补发的中间值。这就是慢客户端不会让服务端堆积的原因。
   */
  watch(after, bootId, timeoutMs = WATCH_TIMEOUT_MS) {
    const cursor = Number(after);
    const known = bootId === this.bootId && Number.isFinite(cursor) && cursor >= 0;
    if (!known || cursor > this.version) {
      if (!this.cache.size) this.build();
      return Promise.resolve(this.since(after, bootId));
    }
    if (this.version > cursor) return Promise.resolve(this.since(cursor));
    return new Promise((resolve) => {
      const waiter = { after: cursor, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(this.since(cursor));
      }, Math.max(1000, Number(timeoutMs) || WATCH_TIMEOUT_MS));
      // Node 的定时器不该把进程钉住。
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.waiters.add(waiter);
      // 挂上之后立刻拉一次：这个观测者可能是**第一个**，在他到来之前没有人构造过状态。
      this.markAll();
      this.pump();
    });
  }

  stats() {
    return {
      schema: STATE_SCHEMA,
      boot_id: this.bootId,
      version: this.version,
      watchers: this.waiters.size,
      builds: this.builds,
      domains: this.cache.size,
      last_build_ms: this.lastBuildMs,
    };
  }

  close() {
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.since(waiter.after));
    }
    this.waiters.clear();
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 注入的 mic 需求端、唤醒组、听写组、单调时钟与定时器；外部的 start/stop/engage/release 请求
 * [OUTPUT]: 唯一一份 chain / wake / dictation 状态，requester lease，以及 warm 倒计时
 * [POS]: docs/061 §五。此前「模型在不在」只能从「当前 owner 是谁」去猜，而那两件事本来就不是
 *        同一个问题——lease 说的是谁有资格关门，跟 VAD 图在不在内存里毫无关系。
 *        所有资源开关都必须经过这里，**串行**执行：并发的 stop 与 engage 如果各自跑一半，
 *        会留下「VAD 卸了 ASR 还在」这种没有名字的状态。
 * [PROTOCOL]: 纯逻辑，无 fs/http/timer 全局依赖——时钟与定时器都是注入的，故单测不必真等 300 秒。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */

export const CHAIN = Object.freeze({
  STARTED: 'started',
  STARTING: 'starting',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
});

export const WAKE = Object.freeze({
  UNLOADED: 'unloaded',
  LOADING: 'loading',
  READY: 'ready',
  UNLOADING: 'unloading',
  ERROR: 'error',
});

export const DICTATION = Object.freeze({
  UNLOADED: 'unloaded',
  LOADING: 'loading',
  READY: 'ready',
  ACTIVE: 'active',
  WARM: 'warm',
  UNLOADING: 'unloading',
  ERROR: 'error',
});

export const MIC_REQUESTER = 'termux-speech';

const nowDefault = () => Date.now();

/**
 * 一次只跑一个状态迁移。用 promise 链而不是标志位——标志位只能拒绝并发请求，
 * 而这里的并发请求（stop 撞上 engage）必须**排队执行**，不能丢。
 */
class Serializer {
  constructor() { this.tail = Promise.resolve(); }

  run(task) {
    const result = this.tail.then(task, task);
    // 队列本身不能因为某一个任务失败就断掉。
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

export class LifecycleController {
  constructor({
    mic,
    wake,
    dictation,
    warmTimeoutMs = 300_000,
    /**
     * ⭐ 三张 HTP 图的常驻策略：`service`（默认）/ `chain` / `warm`。
     *
     * 默认让它们**服务在就一直挂着**，因为闲置常驻几乎不要钱（图不用时匿名页被换进
     * ZRAM，docs/046 §6 实测闲置 12 分钟后物理驻留只剩 3.5 MB），而反复 load/unload
     * 是真花钱：ORT-QNN 分配器高水位只增不减（docs/053：0 session 仍占 612 MB），
     * 真机上几轮 churn 就把 ort_rss 从 220 推到 692 MB，且每次唤醒多付约 2.5 秒。
     * **为省内存而周期性卸载，净效果是费内存。**
     */
    residency = 'service',
    now = nowDefault,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onChange = () => {},
    onWarmUnload = () => {},
  }) {
    this.mic = mic;
    this.wake = wake;
    this.dictation = dictation;
    this.warmTimeoutMs = Math.max(0, Number(warmTimeoutMs) || 0);
    this.residency = ['service', 'chain', 'warm'].includes(residency) ? residency : 'service';
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onChange = onChange;
    this.onWarmUnload = onWarmUnload;

    this.chain = CHAIN.STOPPED;
    this.wakeState = WAKE.UNLOADED;
    this.dictationState = DICTATION.UNLOADED;
    /** 听写资源的代龄。每一次 load/unload 都 +1，故过期的 warm timer 认得出自己已经过时。 */
    this.dictationGeneration = 0;
    this.leases = new Map();
    this.leaseSeq = 0;
    this.warmDeadlineMs = null;
    this.warmTimer = null;
    this.micHeld = false;
    this.lastError = null;
    this.lastTransition = null;
    this.serializer = new Serializer();
  }

  // ------------------------------------------------------------------ 只读

  activeRequesters() {
    return [...this.leases.keys()].sort();
  }

  hasExternalRequester(excluding = []) {
    const skip = new Set(excluding);
    return [...this.leases.keys()].some((id) => !skip.has(id));
  }

  warmRemainingMs(nowMs = this.now()) {
    if (this.warmDeadlineMs === null) return null;
    return Math.max(0, this.warmDeadlineMs - nowMs);
  }

  /** 听写资源是否已经在内存里（ready/active/warm 三态都算）。 */
  dictationLoaded() {
    return this.dictationState === DICTATION.READY
      || this.dictationState === DICTATION.ACTIVE
      || this.dictationState === DICTATION.WARM;
  }

  /** 需要 PCM 的条件：唤醒组在守着，或者有人在听写。 */
  wantsPcm() {
    return this.micHeld;
  }

  snapshot(nowMs = this.now()) {
    return {
      schema: 'termux-os.speech-lifecycle.v1',
      chain: this.chain,
      wake: this.wakeState,
      dictation: this.dictationState,
      dictation_generation: this.dictationGeneration,
      residency: this.residency,
      mic_demand: { requester: MIC_REQUESTER, held: this.micHeld },
      requesters: this.activeRequesters(),
      requester_count: this.leases.size,
      warm: {
        timeout_ms: this.warmTimeoutMs,
        deadline_ms: this.warmDeadlineMs,
        remaining_ms: this.warmRemainingMs(nowMs),
      },
      last_transition: this.lastTransition,
      last_error: this.lastError,
      observed_at_ms: nowMs,
    };
  }

  // ------------------------------------------------------------ 内部工具

  mark(transition) {
    this.lastTransition = { transition, at_ms: this.now() };
    this.onChange();
  }

  cancelWarm() {
    if (this.warmTimer !== null) this.clearTimer(this.warmTimer);
    this.warmTimer = null;
    this.warmDeadlineMs = null;
  }

  /**
   * 起 warm 倒计时。⚠ 回调必须带着**当时的**代龄：一个在途的 timer 与一次新的
   * load 撞上时，若不比对代龄，旧 timer 会把刚刚载入的新资源卸掉。
   */
  armWarm() {
    this.cancelWarm();
    if (this.warmTimeoutMs <= 0) return;
    const generation = this.dictationGeneration;
    this.warmDeadlineMs = this.now() + this.warmTimeoutMs;
    this.warmTimer = this.setTimer(() => {
      this.warmTimer = null;
      void this.expireWarm(generation);
    }, this.warmTimeoutMs);
  }

  async loadDictation() {
    if (this.dictationLoaded()) return { ok: true, reason: 'already_loaded' };
    this.dictationState = DICTATION.LOADING;
    this.mark('dictation_loading');
    let vadLoaded = false;
    try {
      await this.dictation.loadVad();
      vadLoaded = true;
      await this.dictation.loadAsr();
    } catch (error) {
      const message = String(error?.message ?? error);
      // ⭐ VAD 成功而 ASR 失败必须回滚：留下一个只有 VAD 的半状态，表现是「一直在听但
      // 永远转不出字」——它看起来是在工作的，这比明确失败糟糕得多。
      if (vadLoaded) {
        try { await this.dictation.unloadVad(); } catch { /* 回滚失败不能盖掉真正的原因。 */ }
      }
      this.dictationState = DICTATION.UNLOADED;
      this.lastError = `dictation load failed: ${message}`;
      this.mark('dictation_load_failed');
      return { ok: false, reason: 'load_failed', error: message };
    }
    this.dictationGeneration += 1;
    this.dictationState = DICTATION.READY;
    this.lastError = null;
    this.mark('dictation_ready');
    return { ok: true, reason: 'loaded' };
  }

  async unloadDictation(reason) {
    if (this.dictationState === DICTATION.UNLOADED) return { ok: true, reason: 'already_unloaded' };
    this.cancelWarm();
    this.dictationState = DICTATION.UNLOADING;
    this.mark(`dictation_unloading:${reason}`);
    const errors = [];
    for (const [name, task] of [['asr', () => this.dictation.unloadAsr()], ['vad', () => this.dictation.unloadVad()]]) {
      try { await task(); } catch (error) { errors.push(`${name}: ${String(error?.message ?? error)}`); }
    }
    this.dictationGeneration += 1;
    this.dictationState = errors.length ? DICTATION.ERROR : DICTATION.UNLOADED;
    this.lastError = errors.length ? errors.join('; ') : null;
    this.mark(`dictation_unloaded:${reason}`);
    return { ok: errors.length === 0, reason, error: this.lastError };
  }

  async expireWarm(generation) {
    return this.serializer.run(async () => {
      // 三道闸门，任何一道不成立都说明这个 timer 已经无关：代龄变了（资源被重载过）、
      // 已经有人在用（不得在 active requester 非零时卸载）、或者状态早就不是 warm 了。
      if (generation !== this.dictationGeneration) return { ok: false, reason: 'stale_generation' };
      if (this.leases.size > 0) return { ok: false, reason: 'requesters_active' };
      if (this.dictationState !== DICTATION.WARM) return { ok: false, reason: `state_${this.dictationState}` };
      // 只有 `warm` 策略才让保温到期真的卸载；其余两种退回 ready。
      if (this.residency !== 'warm') {
        this.dictationState = DICTATION.READY;
        this.cancelWarm();
        this.mark(`warm_kept:${this.residency}`);
        return { ok: true, reason: `kept_${this.residency}` };
      }
      const result = await this.unloadDictation('warm_timeout');
      this.onWarmUnload(result);
      return result;
    });
  }

  // -------------------------------------------------------------- 对外动作

  startChain(reason = 'api') {
    return this.serializer.run(async () => {
      if (this.chain === CHAIN.STARTED) return { ok: true, reason: 'already_started', value: this.snapshot() };
      this.chain = CHAIN.STARTING;
      this.mark(`chain_starting:${reason}`);
      const mic = await this.acquireMic();
      if (!mic.ok) {
        this.chain = CHAIN.STOPPED;
        this.lastError = mic.error;
        this.mark('chain_start_failed');
        return { ok: false, reason: mic.reason, error: mic.error, value: this.snapshot() };
      }
      this.wakeState = WAKE.LOADING;
      try {
        await this.wake.load();
        this.wakeState = WAKE.READY;
      } catch (error) {
        this.wakeState = WAKE.ERROR;
        this.lastError = `wake load failed: ${String(error?.message ?? error)}`;
        this.chain = CHAIN.ERROR;
        this.mark('chain_start_failed');
        return { ok: false, reason: 'wake_load_failed', error: this.lastError, value: this.snapshot() };
      }
      this.chain = CHAIN.STARTED;
      this.lastError = null;
      /**
       * ⭐ 预载听写组。docs/061 §二.3 说 Chain Start「**不要求**立即加载 VAD+ASR」——
       * 是不要求，不是不许。真机实测两条理由都指向预载：
       *   ① 不预载时每次唤醒现场付 2558ms，而这正是唯一在意延迟的那条路径；
       *   ② 反复 load/unload 把 ort_worker 的分配器高水位推上去（220 → 692MB），
       *      为省内存而周期性卸载，净效果是费内存。
       * 载入失败**不算启动失败**：唤醒组照样守着，第一次唤醒时再试一次即可。
       */
      const preloaded = await this.loadDictation();
      if (preloaded.ok && this.leases.size === 0) this.dictationState = DICTATION.READY;
      this.mark(`chain_started:${reason}`);
      return { ok: true, reason: 'started', preloaded: preloaded.ok, value: this.snapshot() };
    });
  }

  /**
   * @param force 外部 requester（termux-ime 等）还持着听写时，普通请求会被拒绝，
   *              只有明确的「强制停链」才收走全部 lease。误触不该静默掐掉别人的听写。
   */
  stopChain({ reason = 'api', force = false } = {}) {
    return this.serializer.run(async () => {
      if (this.chain === CHAIN.STOPPED && !this.micHeld && !this.dictationLoaded()) {
        return { ok: true, reason: 'already_stopped', value: this.snapshot() };
      }
      if (this.leases.size > 0 && !force) {
        return {
          ok: false,
          reason: 'requesters_active',
          requesters: this.activeRequesters(),
          value: this.snapshot(),
        };
      }
      this.chain = CHAIN.STOPPING;
      this.mark(`chain_stopping:${reason}`);
      const revoked = this.activeRequesters();
      this.leases.clear();
      this.cancelWarm();

      const errors = [];
      try { await this.wake.unload(); this.wakeState = WAKE.UNLOADED; }
      catch (error) { this.wakeState = WAKE.ERROR; errors.push(`wake: ${String(error?.message ?? error)}`); }

      // `service` 策略下停链**不动那三张图**：它们闲着几乎不占物理内存，而卸了再载既慢
      // 又会把分配器高水位推高。停链真正要放的是麦克风与唤醒组订阅，那两样才是持续成本。
      if (this.residency !== 'service') {
        const unloaded = await this.unloadDictation(`chain_stop:${reason}`);
        if (!unloaded.ok && unloaded.error) errors.push(unloaded.error);
      } else {
        this.cancelWarm();
        if (this.dictationLoaded()) this.dictationState = DICTATION.READY;
        this.mark(`dictation_kept_resident:${reason}`);
      }

      const released = await this.releaseMic();
      if (!released.ok && released.error) errors.push(released.error);

      this.chain = errors.length ? CHAIN.ERROR : CHAIN.STOPPED;
      this.lastError = errors.length ? errors.join('; ') : null;
      this.mark(`chain_stopped:${reason}`);
      return {
        ok: errors.length === 0,
        reason: 'stopped',
        revoked,
        error: this.lastError,
        value: this.snapshot(),
      };
    });
  }

  /**
   * 取得听写。停链状态下同样可用——这正是 docs/061 §四要的：
   * 载入 VAD → 载入 ASR → 请求 Mic → 确认 Mic 有效，任何一步失败都不得进入 ready。
   */
  engage(requester, { reason = 'listen' } = {}) {
    return this.serializer.run(async () => {
      const id = String(requester ?? '').trim();
      if (!id) return { ok: false, reason: 'requester_required', value: this.snapshot() };
      if (this.leases.has(id)) {
        // 重复 engage 幂等：不重新载模、不重置代龄、不动 lease 的 generation。
        return { ok: true, reason: 'already_engaged', lease: this.leases.get(id), value: this.snapshot() };
      }
      this.cancelWarm();
      const loaded = await this.loadDictation();
      if (!loaded.ok) {
        // 载入失败不能留下 mic 需求：那会让一次失败变成一直亮着的麦克风。
        if (this.chain !== CHAIN.STARTED && this.leases.size === 0) await this.releaseMic();
        return { ok: false, reason: loaded.reason, error: loaded.error, value: this.snapshot() };
      }
      const mic = await this.acquireMic();
      if (!mic.ok) {
        if (this.chain !== CHAIN.STARTED && this.leases.size === 0) {
          await this.unloadDictation('engage_mic_failed');
        }
        return { ok: false, reason: mic.reason, error: mic.error, value: this.snapshot() };
      }
      this.leaseSeq += 1;
      const lease = { requester: id, generation: this.leaseSeq, reason, at_ms: this.now() };
      this.leases.set(id, lease);
      this.dictationState = DICTATION.ACTIVE;
      this.mark(`engaged:${id}`);
      return { ok: true, reason: 'engaged', lease, value: this.snapshot() };
    });
  }

  /**
   * @param generation 只有持有者本人（且是同一次 lease）能普通释放。
   *                   App/speech 重连后带着旧 generation 的 release 一律不认。
   */
  release(requester, { generation = null, force = false, reason = 'listen_release' } = {}) {
    return this.serializer.run(async () => {
      const id = String(requester ?? '').trim();
      const lease = this.leases.get(id);
      if (!lease) return { ok: true, reason: 'not_engaged', value: this.snapshot() };
      if (!force && generation !== null && Number(generation) !== lease.generation) {
        return { ok: false, reason: 'stale_generation', value: this.snapshot() };
      }
      this.leases.delete(id);
      if (this.leases.size > 0) {
        return { ok: true, reason: 'still_engaged', value: this.snapshot() };
      }
      // 全部释放：听写资源转 warm，Mic 的去留由**停链前的基线**决定。
      this.dictationState = DICTATION.WARM;
      this.armWarm();
      if (this.chain === CHAIN.STARTED) {
        // 基线是 Chain Started：Mic 继续供唤醒组使用，回到 RMS+KWS。
        this.mark(`released_to_wake:${id}`);
      } else {
        // 基线是 Chain Stopped：立刻放 Mic，且**不得**顺手把唤醒组打开。
        await this.releaseMic();
        this.mark(`released_to_warm:${id}`);
      }
      return { ok: true, reason: reason ?? 'released', warm_remaining_ms: this.warmRemainingMs(), value: this.snapshot() };
    });
  }

  // ------------------------------------------------------------------ Mic

  async acquireMic() {
    if (this.micHeld) return { ok: true, reason: 'already_held' };
    try {
      const result = await this.mic.request(MIC_REQUESTER, true);
      if (result?.ok === false) {
        return { ok: false, reason: result.reason ?? 'mic_failed', error: result.error ?? result.reason ?? 'mic request failed' };
      }
      this.micHeld = true;
      return { ok: true, reason: 'acquired' };
    } catch (error) {
      const message = String(error?.message ?? error);
      // requires_user_foreground 原样上抛：它是**唯一**需要使用者动手的失败，
      // 压成一句通用错误就等于把「去点一下 App」这个唯一出路藏起来了。
      return {
        ok: false,
        reason: /requires_user_foreground/.test(message) ? 'requires_user_foreground' : 'mic_failed',
        error: message,
      };
    }
  }

  async releaseMic() {
    if (!this.micHeld) return { ok: true, reason: 'not_held' };
    try {
      await this.mic.request(MIC_REQUESTER, false);
      this.micHeld = false;
      return { ok: true, reason: 'released' };
    } catch (error) {
      return { ok: false, reason: 'mic_release_failed', error: String(error?.message ?? error) };
    }
  }

  /**
   * 用 App 的真实常驻列表校准，而不是假设自己重启前是什么样。
   *
   * 服务重启 / dev reload **绝不**能 churn HTP 会话，所以这里既不 declare 也不 undeclare，
   * 只把内部状态收敛到已经存在的事实上——与 docs/051 「不写崩溃恢复分支」是同一条原则。
   */
  reconcile({ vadLoaded, asrLoaded, micHeld }) {
    if (typeof micHeld === 'boolean') this.micHeld = micHeld;
    if (vadLoaded === true && asrLoaded === true) {
      if (!this.dictationLoaded()) {
        this.dictationGeneration += 1;
        this.dictationState = this.leases.size > 0 ? DICTATION.ACTIVE : DICTATION.WARM;
        // ⛔ **不起保温倒计时**。保温的语义是「刚用完，先留着」；一次服务重启没有「用完」
        // 这回事，在这里起表会让**重启本身**在 300 秒后导致一次 undeclare——
        // 那正是红线禁止的 churn，只是绕了个弯。倒计时只由 release 起。
      }
    } else if (vadLoaded === false && asrLoaded === false && this.dictationState !== DICTATION.UNLOADED) {
      // 两张图都不在了（App 被重装/声明被清）——如实退回 unloaded，别继续宣称 warm。
      this.cancelWarm();
      this.dictationGeneration += 1;
      this.dictationState = DICTATION.UNLOADED;
    }
    this.mark('reconciled');
    return this.snapshot();
  }
}

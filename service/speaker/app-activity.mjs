/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App 的 `/api/speech/activity` 控制面 + AppEvents 帧里的 `activity` 域
 * [OUTPUT]: 对外提供 AppSpeakerActivity —— 把 CAM++ 的**高频执行**交给 App，
 *           本包只做低频的策略下发、准入通知与段落消费
 * [POS]: docs/087 P3。⭐ 一句话：**App 决定「谁在说、说到哪」，本包决定「这一段算不算数」。**
 *
 * ⭐ 与旧的 `activity.mjs` 是同一份判据的两个执行位置，⛔ 不是两套算法：
 *   FSM / fbank / cosine 已经逐位对照过（App 的 `ActivityParityTest` 用**本包这份实现**
 *   跑出来的黄金数据做断言）。这里只负责把参数送过去、把结果收回来。
 * ⭐ **PCM 不再出 App**：本模块一个音频字节都不搬，收到的是 `wav_path` 与元数据。
 * ⚠ exactly-once 的判据是**递增的 `seq`**，⛔ 不是布尔也不是「最后一段变了」——
 *   事件总线本就允许重复推送，而同一句话的两个 revision 只差一个数字。
 * ⚠ `boot_id` 变了（App 重生）计数器归零：那时只重新对齐基线，⛔ 不把历史重放一遍。
 * ⚠ 帧可能丢（队列满时丢最旧）：所以计数跳跃时**回填**——
 *   低频事实通道允许丢中间值，但一句话的定稿不能丢。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const APP_ACTIVITY_MODES = Object.freeze(['app', 'legacy_speech', 'shadow']);

export class AppSpeakerActivity {
  /**
   * @param android      `createAndroidAppClient()` 的实例
   * @param calibration  `() => { profile, profile_ready }`（复用既有 CPU 登记的声纹）
   * @param modelPath    CAM++ 源图绝对路径（Asset 解析后的结果）
   * @param ctxPath      QNN 2.47 EPContext wrapper 绝对路径（可为 null）
   * @param onSegment    `(segment) => void` 正式下游；⛔ 本模块不认识 ASR
   */
  constructor({
    android, calibration, modelPath, ctxPath = null, mode = 'legacy_speech',
    onSegment = () => {}, onChange = () => {}, now = () => Date.now(),
    onUserConfirmed = () => {},
    wantRunning = () => false,
    setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    this.android = android;
    this.readCalibration = calibration;
    this.modelPath = modelPath;
    this.ctxPath = ctxPath;
    this.onSegment = onSegment;
    /**
     * ⭐ 「刚才确认到用户在说话」。上游拿它给关门倒计时续命。
     * ⚠ P3 把高频判决搬进 App 之后，legacy 那条
     *   `SpeakerActivity.onConfirmedUser → UserWatchdog.confirm()` 的线**断了**：
     *   watchdog 照常在开门时起跑，而没有任何东西再喂它 ⇒ 使用者一直在说话，
     *   门还是在开门后第 8 秒关掉。这条回调就是把它接回来。
     */
    this.onUserConfirmed = onUserConfirmed;
    /** 已经据此续过命的那个时刻。⛔ 判据是**时间戳前进**，不是「收到一帧」。 */
    this.lastUserMonoMs = null;
    this.userConfirmsSeen = 0;
    this.onChange = onChange;
    this.now = now;

    /**
     * ⚠ 必须由**配置**决定初值。写死 `legacy_speech` 会让「配置说 app、执行体说 speech」
     *   这件事在启动后一直成立：App 那侧图已经载入、声纹已经同步、事件也在推，
     *   而 `active()` 永远是 false ⇒ 本包既不把门交给它，也不把自己那份打开——
     *   **两条链都在正常工作，而没有一条在处理声音**。真机第一次上电就是这样。
     */
    this.mode = APP_ACTIVITY_MODES.includes(mode) ? mode : 'legacy_speech';
    this.started = false;
    this.admitted = false;
    this.lastError = null;
    this.lastFacts = null;
    /** 已经消费到第几段（按 App 的 `seq`）。⛔ 每个 boot_id 一份。 */
    this.bootId = null;
    this.lastSegmentSeq = 0;
    this.segmentsDelivered = 0;
    this.segmentsBackfilled = 0;
    this.duplicatesDropped = 0;
    this.ghostTransitionsAvoided = 0;
    this.lastTransitions = null;
    this.profileGeneration = 0;
    this.profileFingerprint = null;
    this.profileSyncedAtMs = null;
    this.backfillInFlight = false;

    /**
     * ⭐ **对账收敛器**（docs/087 §修订）。
     *
     * ⚠ 真机症状：「一开始没反应，切换一下触发方式就好了」。根因是启动是**一次性**的——
     *   `start()` 在开机那一刻失败（App 还没起来 / HTP 会话预算满 / worker 正在重连）
     *   之后就**永远**停在 `started=false`，而切换触发方式恰好会重跑一次链的 consumer
     *   收敛、顺带重试了一次。⛔ 一个只在开机试一次的启动，等于把一次瞬时故障
     *   变成一次永久故障，而两边的状态读起来都正常。
     * ⭐ 修法与 `ResidentGraphs` 同形：**不写「失败后恢复」分支**——
     *   冷启、App 重生、执行器切换全都走同一条 `ensureRunning()`，
     *   它只把实际态收敛到「此刻应该跑吗」。
     */
    this.wantRunning = wantRunning;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.startInFlight = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.restarts = 0;
    this.startFailures = 0;
    this.lastStartError = null;
    /** 下发给 App 的判据由调用方在 `ensureRunning` 时给；这里只记住最后一份。 */
    this.lastConfig = {};
    this.profileSyncInFlight = false;
  }

  /** 有界退避：⛔ 不无限快速重试，也⛔ 不放弃。 */
  static RETRY_MS = Object.freeze([1000, 2000, 5000, 10_000, 30_000]);

  #scheduleRetry() {
    if (this.retryTimer !== null) return;
    const wait = AppSpeakerActivity.RETRY_MS[
      Math.min(this.retryAttempt, AppSpeakerActivity.RETRY_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      void this.ensureRunning();
    }, wait);
    if (typeof this.retryTimer?.unref === 'function') this.retryTimer.unref();
  }

  #cancelRetry() {
    if (this.retryTimer === null) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.retryAttempt = 0;
  }

  /**
   * 把实际态收敛到「此刻该不该跑」。**幂等**，可以随便调。
   *
   * ⚠ 判据里必须包含 App 自己报的 `running`：App 被 LMK 杀掉重生之后，
   *   本包这边的 `started` 还是 true，而那边什么都没有——
   *   **两边都以为对方在跑，于是没有人在跑**，且没有任何错误。
   * ⚠ 重试计时器**只在坏着的时候存在**，好了立刻撤——它不是心跳。
   */
  async ensureRunning(config = null) {
    if (config) this.lastConfig = config;
    if (this.mode !== 'app') { this.#cancelRetry(); return { ok: true, reason: 'not_app_executor' }; }
    let want = false;
    try { want = this.wantRunning() === true; } catch { want = false; }
    if (!want) { this.#cancelRetry(); return { ok: true, reason: 'not_wanted' }; }
    const appDead = this.started && this.lastFacts && this.lastFacts.running === false;
    if (this.started && !appDead) {
      /**
       * ⭐ 起来了不等于**声纹也送到了**。
       *
       * ⚠ 真机上抓到：服务冷启时 `speakerLab` 还没把声纹读回来，于是 `start()` 里那次
       *   `syncProfile()` 返回 `no_profile` 就**再也没有第二次**——App 侧沿用着上一次
       *   留下的旧副本，一切看起来正常，直到使用者重新登记而那份新的永远送不过去。
       * ⛔ 所以「在跑」这件事的对账里必须包含声纹，而不只是包含进程。
       */
      await this.#ensureProfile();
      this.#cancelRetry();
      return { ok: true, reason: 'already_running' };
    }
    if (this.startInFlight) return this.startInFlight;
    if (appDead) {
      // App 重生过：本地那份「已启动」是上一辈子的事实。
      this.started = false;
      this.admitted = false;
      this.restarts += 1;
    }
    this.startInFlight = (async () => {
      try {
        await this.start(this.lastConfig);
        this.#cancelRetry();
        this.lastStartError = null;
        return { ok: true, reason: appDead ? 'restarted' : 'started' };
      } catch (error) {
        this.startFailures += 1;
        this.lastStartError = String(error?.message ?? error);
        this.lastError = `start: ${this.lastStartError}`;
        this.#scheduleRetry();
        this.onChange();
        return { ok: false, reason: this.lastStartError };
      } finally {
        this.startInFlight = null;
      }
    })();
    return this.startInFlight;
  }

  /**
   * 声纹的对账：本包有、而 App 那边没有（或指纹对不上）⇒ 补送一次。
   * ⚠ 幂等且**便宜**：什么都不缺时它一个请求都不发。
   */
  async #ensureProfile() {
    const cal = this.readCalibration?.() ?? {};
    if (cal.profile_ready !== true) return;               // 本包自己都还没有，⛔ 没什么可送
    const mine = cal.profile?.fingerprint ?? null;
    if (!mine) return;
    /**
     * ⭐ 判据是 **App 自己报的指纹**，⛔ 不是「我上次送了什么」。
     * ⚠ 猜错的两个方向都不好：没证据就送 ⇒ 每次开门都白送一次；
     *   拿本地记录当证据 ⇒ App 换过进程之后永远不会重送。
     * ⚠ 还没收到过任何事实时**什么都不做**：事实一秒内就会到，
     *   而在此之前的每一次「以防万一」都是白发的请求。
     */
    if (!this.lastFacts) return;
    if (this.lastFacts.profile_fingerprint === mine) return;
    if (this.profileSyncInFlight) return;
    this.profileSyncInFlight = true;
    try { await this.syncProfile(); } finally { this.profileSyncInFlight = false; }
  }

  /** 明确停止时也要把重试撤掉——⛔ 停掉的东西不该自己回来。 */
  #stopRetrying() { this.#cancelRetry(); }

  active() { return this.mode === 'app' && this.started; }

  // ── 低频控制面 ─────────────────────────────────────────────────────────
  /**
   * 把声纹送过去。⭐ **一次登记一次同步**，⛔ 不在每个 CAM++ 窗上查询。
   * @returns `{ ok, reason? }`——⛔ 失败不抛：没有声纹时 App 侧 fail closed，
   *   而一个同步失败不该把整条链拽停。
   */
  async syncProfile() {
    const cal = this.readCalibration?.() ?? {};
    const profile = cal.profile;
    if (cal.profile_ready !== true || !Array.isArray(profile?.reference)) {
      return { ok: false, reason: 'no_profile' };
    }
    /**
     * ⭐ **generation 必须从持久的那一侧取**，⛔ 不能从本包的内存计数器推。
     *
     * ⚠ 真机付过代价：本包每次重启都从 0 开始数，于是第二次重启之后送出去的永远是
     *   `generation=1`，而 App 那边已经存到 2 —— `1 < 2` 被判为过期，
     *   **此后每一次同步都被拒绝**。而它不报错：App 手里还有一份能用的旧副本，
     *   一切看起来正常，直到使用者重新登记而那份新的永远送不过去。
     * ⭐ 一个要跨重启单调的计数器，不能存在一个不跨重启的地方。
     */
    let stored = 0;
    try {
      const current = await this.android.json('/api/speech/speaker/profile');
      stored = Number(current?.generation) || 0;
    } catch { /* 读不到就退回本地计数；⛔ 不因此放弃这次同步 */ }
    const generation = Math.max(stored, this.profileGeneration) + 1;
    const body = {
      schema: 'termux-os.speaker-profile.v1',
      reference: profile.reference,
      threshold: Number(profile.config?.threshold ?? 0.5),
      enrollments: profile.enrollments?.length ?? 0,
      fingerprint: profile.fingerprint ?? null,
      generation,
      built_at_ms: profile.builtAtMs ?? 0,
    };
    // ⛔ 指纹给了就必须与 App 本地重算的一致；对不上 App 会拒收，这正是要的。
    try {
      const data = await this.android.json('/api/speech/speaker/profile',
        { method: 'POST', body });
      this.profileGeneration = generation;
      this.profileFingerprint = data?.profile?.fingerprint ?? body.fingerprint;
      this.profileSyncedAtMs = this.now();
      this.lastError = null;
      this.onChange();
      return { ok: true, fingerprint: this.profileFingerprint, generation };
    } catch (error) {
      this.lastError = `profile sync: ${error?.message ?? error}`;
      this.onChange();
      return { ok: false, reason: this.lastError };
    }
  }

  /** 使用者删掉声纹时把 App 那份也清掉——⛔ 不留一份没人维护的旧身份。 */
  async clearProfile() {
    try {
      await this.android.json('/api/speech/speaker/profile', { method: 'DELETE' });
      this.profileFingerprint = null;
      return { ok: true };
    } catch (error) {
      this.lastError = `profile clear: ${error?.message ?? error}`;
      return { ok: false, reason: this.lastError };
    }
  }

  /** 判据下发。取值与本包 `activity.mjs` 的 TEST_DEFAULTS 同源。 */
  async pushConfig(config = {}) {
    const body = {
      window_ms: config.window_ms ?? 1500,
      step_ms: config.step_ms ?? 300,
      enter_threshold: config.enter_threshold ?? 0.40,
      exit_threshold: config.exit_threshold ?? 0.35,
      enter_confirm: config.enter_confirm ?? 2,
      exit_confirm: config.exit_confirm ?? 2,
      pre_roll_ms: config.pre_roll_ms ?? 500,
      post_roll_ms: 0,
      continuation_grace_ms: config.continuation_grace_ms ?? 1200,
      vad_gates_speaker: config.vad_gates_speaker === true,
      tail_margin_ms: config.tail_margin_ms ?? 700,
      head_trim_ms: config.head_trim_ms ?? 1300,
      head_mode: config.head_mode ?? 'trim',
    };
    return this.android.json('/api/speech/activity/config', { method: 'POST', body });
  }

  async setMode(mode) {
    if (!APP_ACTIVITY_MODES.includes(mode)) {
      throw new RangeError(`mode must be one of ${APP_ACTIVITY_MODES.join('/')}`);
    }
    this.mode = mode;
    await this.android.json('/api/speech/activity/mode', { method: 'POST', body: { mode } });
    this.onChange();
    return mode;
  }

  /**
   * 启动 App 侧执行体：声明模型 → 下发判据 → 同步声纹 → start。
   * ⚠ 顺序不能换：先 start 再给声纹，那段窗口里每个窗都会被 fail-closed 丢掉，
   *   而计数器上只表现为 `skipped_no_profile` 涨了一点。
   */
  async start(config = {}) {
    /**
     * ⭐ 先把执行器模式同步过去：App 侧的 `mode` 决定它的窗回路跑不跑，
     * ⛔ 不能假设它还记得上一次的值——App 可能刚被 LMK 杀过重生。
     */
    await this.android.json('/api/speech/activity/mode',
      { method: 'POST', body: { mode: this.mode } });
    await this.android.json('/api/speech/activity/model', {
      method: 'POST',
      body: { model_path: this.modelPath, ctx_path: this.ctxPath, backend: 'htp' },
    });
    await this.pushConfig(config);
    await this.syncProfile();
    const data = await this.android.json('/api/speech/activity/start', { method: 'POST', body: {} });
    this.started = true;
    this.lastError = null;
    this.onChange();
    return data;
  }

  async stop(reason = 'user') {
    this.#stopRetrying();
    if (!this.started) return null;
    this.started = false;
    this.admitted = false;
    try {
      return await this.android.json('/api/speech/activity/stop',
        { method: 'POST', body: { reason } });
    } catch (error) {
      this.lastError = `stop: ${error?.message ?? error}`;
      return null;
    } finally {
      this.onChange();
    }
  }

  /**
   * ⭐ 门的开关仍由本包驱动——它已经在消费 `gate.open` 并持有 8 秒 USER watchdog。
   * ⛔ 不把 App 的 Gate 直接接到执行体上：同一个事实有两个写者，迟早给出不同答案。
   * ⚠ 幂等：状态没变就不发请求，否则每帧都会打一次控制面。
   */
  async admit(on, reason = 'gate') {
    const want = on === true;
    if (!this.started || this.admitted === want) return null;
    this.admitted = want;
    // ⛔ 新一轮准入不继承上一轮的「他还在说」——那会让倒计时一开门就被续过一次。
    if (want) { this.lastUserMonoMs = null; }
    try {
      return await this.android.json('/api/speech/activity/admission',
        { method: 'POST', body: { admitted: want, reason } });
    } catch (error) {
      this.lastError = `admission: ${error?.message ?? error}`;
      // ⚠ 请求失败时把本地状态退回去，否则下一次同向调用会被幂等判据吃掉，
      //   而 App 侧其实从来没收到过。
      this.admitted = !want;
      return null;
    }
  }

  // ── 低频事实消费 ───────────────────────────────────────────────────────
  /**
   * AppEvents 帧里的 `activity` 域。
   * ⛔ 只在这里做 exactly-once，⛔ 不在任何别的地方读 `last_segment`。
   */
  observe(activity, bootId = null) {
    if (!activity || typeof activity !== 'object') return;
    this.lastFacts = activity;
    if (bootId && bootId !== this.bootId) {
      // App 重生：计数器归零，⛔ 这不是「倒退」也不是一批新段落。
      const firstSight = this.bootId === null;
      this.bootId = bootId;
      this.lastSegmentSeq = Number(activity.segments) || 0;
      this.lastTransitions = Number(activity.transitions) || 0;
      this.ghostTransitionsAvoided += 1;
      // ⭐ 换了一个 boot_id 就是换了一个 App 进程：它身上没有我们声明的东西。
      //   ⛔ 第一次看见不算重生（那只是我们刚连上）。
      if (!firstSight) {
        if (this.started) this.restarts += 1;
        this.started = false;
        this.admitted = false;
      }
      this.onChange();
      void this.ensureRunning();
      return;
    }
    // ⭐ App 说它没在跑，而我们以为它在跑 ⇒ 立刻对账，⛔ 不等下一次门。
    if (this.started && activity.running === false) void this.ensureRunning();
    this.#observeUser(activity);
    const segments = Number(activity.segments);
    if (!Number.isFinite(segments)) return;
    if (segments < this.lastSegmentSeq) {
      // 同一个 boot_id 内计数倒退只可能是乱序帧；重新对齐，⛔ 不重放。
      this.lastSegmentSeq = segments;
      this.ghostTransitionsAvoided += 1;
      return;
    }
    if (segments === this.lastSegmentSeq) { this.duplicatesDropped += 1; return; }
    const last = activity.last_segment;
    const lastSeq = Number(last?.seq);
    if (segments === this.lastSegmentSeq + 1 && lastSeq === segments) {
      this.lastSegmentSeq = segments;
      this.#deliver(last);
      return;
    }
    // ⭐ 计数跳了不止一格 ⇒ 中间有帧被丢掉了。低频通道允许丢中间值，
    //   但**一句话的定稿不能丢**，所以这里回填一次。
    void this.#backfill(segments);
  }

  /**
   * ⭐ 关门倒计时的续命。
   *
   * ⚠ 判据是**时间戳前进**，⛔ 不是「收到了一帧」也不是「计数器变了」：
   *   低频通道允许重复推送，而每一次重复都会把倒计时再往后推一次——
   *   那样门就永远不会关了。时间戳是幂等的：同一个值喂多少次都只等于一次。
   * ⚠ 也不能只在**状态转移**时喂：连续说话恰恰是没有转移的那段时间，
   *   而那正是最需要续命的时候（App 侧因此有一条限速 1 Hz 的心跳）。
   */
  #observeUser(activity) {
    /**
     * ⚠ **`Number(null) === 0`，不是 NaN。**
     *   App 在还没确认过 USER 时把这个字段报成 JSON `null`，直接 `Number()` 会得到 0，
     *   而 `Number.isFinite(0)` 为真 ⇒ 门一开就凭空续了一次命（真机实测：
     *   `user_confirms_seen=1 / last_user_mono_ms=0`，那一刻根本没人说话）。
     *   ⛔ 这正是 docs/056 那个形状：**读得出值、型别对不上、答案错得很安静**。
     */
    const raw = activity?.last_user_mono_ms;
    if (raw === null || raw === undefined) return;
    const at = Number(raw);
    if (!Number.isFinite(at) || at <= 0) return;
    if (this.lastUserMonoMs !== null && at <= this.lastUserMonoMs) return;
    this.lastUserMonoMs = at;
    this.userConfirmsSeen += 1;
    try {
      this.onUserConfirmed({ state: 'USER', confirmed_user_at_ms: at, mono_ms: at });
    } catch { /* ⛔ 观测不得影响事件流 */ }
  }

  async #backfill(target) {
    if (this.backfillInFlight) return;
    this.backfillInFlight = true;
    try {
      const data = await this.android.json(
        `/api/speech/activity/segments?limit=40`, { method: 'GET' });
      const rows = Array.isArray(data?.segments) ? data.segments : [];
      const missed = rows
        .filter((r) => Number(r?.seq) > this.lastSegmentSeq)
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      for (const row of missed) {
        this.lastSegmentSeq = Number(row.seq);
        this.segmentsBackfilled += 1;
        this.#deliver(row);
      }
      if (this.lastSegmentSeq < target) this.lastSegmentSeq = target;
    } catch (error) {
      this.lastError = `backfill: ${error?.message ?? error}`;
    } finally {
      this.backfillInFlight = false;
    }
  }

  #deliver(segment) {
    if (!segment || typeof segment !== 'object' || !segment.wav_path) return;
    this.segmentsDelivered += 1;
    try {
      this.onSegment({
        segment_id: segment.segment_id,
        revision: Number(segment.revision) || 1,
        status: segment.status === 'incomplete' ? 'incomplete' : 'complete',
        wav_path: segment.wav_path,
        duration_ms: Number(segment.duration_ms) || 0,
        start_mono_ms: Number(segment.start_mono_ms) || null,
        end_mono_ms: Number(segment.end_mono_ms) || null,
        commit_reason: segment.commit_reason ?? null,
        max_similarity: segment.max_similarity ?? null,
        mean_user_similarity: segment.mean_user_similarity ?? null,
        executor: 'app',
      });
    } catch (error) {
      this.lastError = `segment consumer: ${error?.message ?? error}`;
    }
    this.onChange();
  }

  /** ⭐ 状态里必须说得出「谁在执行」——⛔ 不是「谁被配置成执行」。 */
  snapshot() {
    const facts = this.lastFacts ?? {};
    return {
      schema: 'termux-os.speech-app-activity.v1',
      executor: this.active() ? 'app' : 'speech',
      mode: this.mode,
      started: this.started,
      admitted: this.admitted,
      app_state: facts.state ?? null,
      app_running: facts.running === true,
      app_admitted: facts.admitted === true,
      app_profile_ready: facts.profile_ready === true,
      last_similarity: facts.last_similarity ?? null,
      current_activity_state: facts.state ?? null,
      last_user_mono_ms: this.lastUserMonoMs ?? facts.last_user_mono_ms ?? null,
      app_user_confirms: facts.user_confirms ?? null,
      last_segment: facts.last_segment ?? null,
      transitions: facts.transitions ?? null,
      last_user_mono_ms: this.lastUserMonoMs,
      user_confirms_seen: this.userConfirmsSeen,
      app_user_confirms: facts.user_confirms ?? null,
      segments_seq: this.lastSegmentSeq,
      segments_delivered: this.segmentsDelivered,
      segments_backfilled: this.segmentsBackfilled,
      duplicates_dropped: this.duplicatesDropped,
      ghost_transitions_avoided: this.ghostTransitionsAvoided,
      profile_generation: this.profileGeneration,
      profile_fingerprint: this.profileFingerprint,
      profile_synced_at_ms: this.profileSyncedAtMs,
      restarts: this.restarts,
      start_failures: this.startFailures,
      retrying: this.retryTimer !== null,
      last_start_error: this.lastStartError,
      boot_id: this.bootId,
      model_path: this.modelPath,
      ctx_path: this.ctxPath,
      last_error: this.lastError ?? facts.last_error ?? null,
    };
  }
}

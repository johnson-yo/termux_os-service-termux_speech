/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Browser Session routes/WS for live state, listen mode, transcripts, and the four config sections.
 * [OUTPUT]: Three-page navigation, the live poll loop, listen/model safety flows, grouped settings saves,
 *           and a manual FireRedVAD counter driven only by the VAD activity fact (not RMS gate-open state).
 *           `cfg.asr.model` is the sole model selector; the policy card never exposes a second ASR backend.
 * [POS]: I/O half of the Package page; it renders through `window.SpeechViews` and holds no credentials.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const V = window.SpeechViews;
const { $, qs, number, fixed, setNote, setText, modelLabel } = V;

const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const ACTIVE_PACKAGE_ID = /^[\w.@-]+$/.test(pathPackageId)
  ? pathPackageId
  : 'github.termux-os.service.termux-speech';
const PKG = `/api/packages/${ACTIVE_PACKAGE_ID}`;
window.TERMUX_SPEECH_PKG = PKG;
const api = (path, options = {}) => window.TermuxOS.api(path, options);

// 概览只留最近这么多条。后端环形水库上限是 256，但手机屏上再多就是噪音。
const TRANSCRIPT_KEEP = 10;

let busy = false;
let fullLoadBusy = false;
let recoveryNeeded = true;
let nextRecoveryAt = 0;
let listenState = null;
let listenPending = null;
let chainPending = null;
let chainFailure = null;
let chainFailureAt = 0;
const activeChainFailure = () => (chainFailure && Date.now() - chainFailureAt < 8000 ? chainFailure : null);
let listenFailure = null;
let listenFailureAt = 0;
// 「上一次操作失败」值得一个可见的节拍，但它不是当前状态——过了这段时间，
// 徽章必须回去说真话（消息本身留在 listen-note 里，不会被抹掉）。
const LISTEN_FAILURE_VISIBLE_MS = 6000;
const activeListenFailure = () => (
  listenFailure && Date.now() - listenFailureAt < LISTEN_FAILURE_VISIBLE_MS ? listenFailure : null
);
let transcripts = [];
let transcriptCursor = 0;

const request = async (path, { method = 'GET', body } = {}) => {
  const response = await api(PKG + path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
};

/* ============================================================
   三页导航
   页面全都留在 DOM 里只切 hidden —— 切走再切回来不会丢掉没保存的输入。
   ============================================================ */
/**
 * ⚠ 这里少一个页面 = 那个标签**点了没反应**（`selectPage` 静默回落到 overview）。
 *   HTML 里的 tab 按钮、页面容器、全套 JS 处理器都在，唯独没登记到这张表里，
 *   于是「功能没做」和「功能做了但进不去」在界面上长得一模一样。
 */
const PAGES = Object.freeze(['overview', 'settings', 'voice']);
/**
 * 换页之后要做的事（补画诊断区、拉声纹状态……）。
 *
 * ⛔ **绝不能在 `selectPage` 里直接调那些函数。** `selectPage(location.hash…)` 在模块
 * 顶层就会执行一次，而 `renderVisible` / `setVoicePolling` 是后面才声明的 `const`——
 * 那是**时间死区**，不是 `undefined`：`typeof` 挡得住，`?.` 挡不住，直接调用会抛
 * `ReferenceError` 并掐掉后面所有初始化（docs/083 H1–H3 就是这个形状）。
 * ⭐ 所以留一个默认什么都不做的钩子，等一切都定义完了再接上去。
 */
let onPageSelected = () => {};

const selectPage = (page) => {
  const target = PAGES.includes(page) ? page : 'overview';
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.page === target;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = $(`page-${tab.dataset.page}`);
    if (panel) panel.hidden = !on;
  }
  if (location.hash.slice(1) !== target) history.replaceState(null, '', `#${target}`);
  onPageSelected(target);
};
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => selectPage(tab.dataset.page));
  tab.addEventListener('keydown', (event) => {
    const index = PAGES.indexOf(tab.dataset.page);
    if (event.key === 'ArrowRight') selectPage(PAGES[(index + 1) % PAGES.length]);
    if (event.key === 'ArrowLeft') selectPage(PAGES[(index - 1 + PAGES.length) % PAGES.length]);
  });
}
selectPage(location.hash.slice(1));

/* ============================================================
   剪贴板
   ⚠ 页面走 http（LAN，非安全上下文），`navigator.clipboard` 在那里是 undefined。
   只用它就会得到一个「点了没反应也不报错」的按钮 —— 所以必须有回退，
   而且成败都要说出来。
   ============================================================ */
const copyText = async (text) => {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 落到下面的回退。 */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
};
const reportCopy = async (text) => {
  const ok = await copyText(text);
  setNote($('tx-note'), ok ? '已复制到剪贴板。' : '复制失败：浏览器拒绝了剪贴板访问，请手动长按选取。',
    ok ? 'good' : 'bad');
};

/* ============================================================
   转写历史
   ============================================================ */
/**
 * ⚠ 认不出的结构必须**显式报错**，不能返回空数组。
 * 「后端换了字段名」与「还没有人说过话」在空数组上长得一模一样（docs/056 同一形状）。
 */
const parseTranscriptFeed = (payload) => {
  if (payload?.schema !== 'termux-os.speech-transcript-feed.v1' || !Array.isArray(payload.observations)) {
    const shape = payload && typeof payload === 'object'
      ? Object.keys(payload).join(', ') || '(空对象)'
      : String(payload);
    throw new Error(`转写接口返回了不认识的结构（schema=${payload?.schema ?? '缺失'}；字段：${shape}）`);
  }
  return payload.observations;
};

const rememberTranscripts = (records) => {
  for (const record of records) {
    const seq = Number(record?.seq) || 0;
    if (seq && transcripts.some((item) => Number(item.seq) === seq)) continue;
    transcripts.push(record);
    transcriptCursor = Math.max(transcriptCursor, seq);
  }
  transcripts.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  while (transcripts.length > TRANSCRIPT_KEEP) transcripts.shift();
  V.renderTranscripts(transcripts, reportCopy);
};

/**
 * 取最近 N 条。
 * ⚠ feed 是 `filter(seq > after).slice(0, limit)` 升序，从 0 读永远拿到**最旧**那批。
 * 旧版靠「累计总数」倒推游标，而累计总数正是这一轮删掉的东西——所以改为直接读
 * 记录组的 `recent`（它本来就按最新在前返回），再把游标推到队尾。
 */
const loadTranscripts = async () => {
  const payload = await request(`/records?limit=${TRANSCRIPT_KEEP}`);
  if (!Array.isArray(payload?.recent)) {
    throw new Error(`记录接口返回了不认识的结构（字段：${Object.keys(payload ?? {}).join(', ') || '空'}）`);
  }
  const records = payload.recent
    .filter((item) => item.status === 'succeeded')
    .map((item) => ({
      seq: Number(item.feed_seq) || 0,
      segment_id: item.segment_id,
      text: item.text ?? '',
      observed_ms: Number(item.observed_ms) || Date.parse(item.completed_at) || null,
      completed_at: item.completed_at ?? null,
      model: item.model ?? null,
      backend: item.backend ?? item.model?.id ?? null,
      // ⭐ 音频在不在是**记录自己说的**（App 的 retention 淘汰后它会变 false）。
      //   ⛔ 不许由页面从「有没有 segment_id」去推——那推出来的永远是 true。
      audio_available: item.audio_available === true,
      audio_source: item.audio_source ?? null,
      timing: { inference_ms: item.inference_ms ?? null },
    }))
    .sort((a, b) => a.seq - b.seq);
  transcripts = [];
  transcriptCursor = records.at(-1)?.seq ?? 0;
  rememberTranscripts(records);
  setNote($('tx-note'), records.length ? `最近 ${records.length} 条` : '尚无转写记录。', '');
};

/* ============================================================
   Live 渲染：按域分区，只更新真的变了的那一块
   ⭐ 旧版每 250ms 跑一次 renderAll（8 个 render + 一次 14KB 的 JSON.stringify），
   不论有没有东西变。现在每一帧只带变化的域，各区域各自订阅自己的域。
   ============================================================ */
const domains = Object.create(null);
let stateVersion = 0;
let stateBootId = null;
/** 本页真的执行过几次区域重绘。硬门槛「页面隐藏期间 DOM update 必须为 0」量的就是它。 */
let domUpdates = 0;

/** 区域 → 它依赖哪些域。⚠ 依赖列错的后果是「那一块永远不更新」，所以每条都对着 render 写。 */
/**
 * ⭐ 产品页的**唯一数据源**：后端的 `public` 域。
 *
 * ⛔ 这里不读 rms_gate / pcm_stream / speaker_gate 内部字段去拼状态——
 *   那是后端的职责，页面猜出来的状态迟早与事实分岔（任务书 §六）。
 * ⚠ 人话映射在这里做，⛔ 不在后端：公共状态要给别的语言的界面用，所以它只有枚举。
 */
const USER_STATE_TEXT = {
  user: '检测到你的声音',
  other: '检测到其他人的声音',
  unknown: '有人在说话',
};
const REASON_TEXT = {
  disabled: '已关闭',
  no_voice_profile: '还没有登记你的声音',
  microphone_unavailable: '麦克风不可用',
  chain_unavailable: '语音链不可用',
  asr_not_ready: '识别模型未就绪',
  manager_unreachable: '模型管理暂不可用',
};
const humanReason = (reason) => REASON_TEXT[reason] ?? reason ?? '';

/**
 * ⭐ 声音活动。**使用者一开口，第一屏立刻动**——这就是本轮 Overview 的核心。
 *
 * ⚠ 三个信号，三个不同的问题，⛔ 不能互相替代：
 *   · `rms_gate.current/avg_100ms` —— 有没有声音（**不需要 VAD 触发就动**）
 *   · `public.activity` —— 系统认定「有人在说话」以及是不是本人
 *   · `speaker_activity` —— 常驻 CAM++VAD 的相似度走势与 USER/OTHER 判定
 *   Overview 直接显示 RMS 的 100ms 判据与 threshold；这些是当前 pipeline 的事实，不是可编辑设置。
 */
const ACT_LEVEL = 0.2;   // 条形满格对应的音量（与诊断页 RMS 显示范围一致）
let speechSegmentStartMs = 0;
let lastWavSegmentId = null;
let lastGradientCutCount = -1;

function renderActivity(rms, pub, cam, pipeline) {
  const current = Number(rms?.current) || 0;
  const avg = Number(rms?.avg_100ms ?? rms?.decision_value) || 0;
  const level = Math.max(current, avg);
  const pct = Math.max(0, Math.min(100, Math.round((level / ACT_LEVEL) * 100)));
  const fill = $('act-fill');
  if (fill) {
    fill.style.width = `${pct}%`;
    // 有声音就亮起来——⚠ 这一格的判据刻意比 VAD 松：它回答的是「听见了吗」。
    fill.className = `meter-fill${level >= 0.02 ? ' live' : ''}`;
  }
  const meter = $('act-meter');
  if (meter) meter.title = `当前 ${current.toFixed(4)} · 100ms 均值 ${avg.toFixed(4)}`;
  setText($('rms-threshold'), Number.isFinite(Number(rms?.open_threshold))
    ? Number(rms.open_threshold).toFixed(3) : '—');
  setText($('rms-admission'), rms?.state === 'open' && rms?.pcm_admission === 'allow'
    ? 'open · PCM 进入 CAM++ / VAD' : 'waiting · PCM 只进滚动环');

  const act = pub?.activity ?? {};
  const tx = pub?.transcription ?? {};
  const speaking = act.active === true;
  const listening = rms?.recording === true;
  /**
   * ⭐ **门开了就是「听到了」，哪怕这一刻的电平不够。**
   *   真机实测过一次相反的画面：音量门已经开着、流水线已经推进到 VAD，
   *   而概览还写着「待命 · 安静」——判据只看瞬时电平，就漏掉了系统自己已经
   *   下过的那个判断。⚠ 电平是**我们的**观测，门开是**它的**结论；
   *   两者不一致时，该信的是结论。
   * ⚠ 反过来不成立：电平够而门没开是正常的（门有它自己的阈值），
   *   所以这里是「或」，不是「以门为准」。
   */
  const heard = level >= 0.02 || rms?.state === 'open';
  /** ⭐ 五个阶段各有一句人话：声音进入 → 正在听 → 正在判断 → 正在识别 → 得到文字。 */
  const stage = tx.status === 'incomplete' || tx.active ? '正在识别'
    : speaking ? '正在听'
      : heard ? '听到声音'
        : listening ? '待命' : '未在收音';
  V.setBadge($('act-badge'), stage, speaking || tx.active ? 'good' : '');
  setText($('act-hint'), heard ? '有声音' : (listening ? '安静' : '麦克风未开启'));

  /** ⚠ 人话，⛔ 不显示 `state=USER`。 */
  setText($('act-who'), speaking
    ? (USER_STATE_TEXT[act.user_state] ?? '有人在说话')
    : (act.source === null && listening ? '等待声音' : '—'));

  /**
   * CAM++ USER 准入倒计时。它来自服务端 RMS/CAM 投影，不由浏览器自己计时，
   * 这样页面显示的 8 秒和真正执行 `camplus_no_user_timeout` 的时钟是同一个。
   */
  const admission = rms?.automatic_cam_admission ?? cam?.automatic_cam_admission ?? {};
  const camLive = rms?.automatic_cam_live === true || cam?.automatic_cam_live === true;
  setText($('cam-live'), camLive ? 'live inference' : 'waiting · graph 可 resident');
  setText($('cam-owner'), pipeline?.owner ?? 'speech.rms');

  /**
   * ⭐ 门被彻底堵住时**必须在 Overview 上说出来**（判据由后端给，见 `gate_blocked`）。
   * ⚠ 使用者实测：拍掌模板被「重置」清掉之后，门此后永远关着，
   *   而这一页上没有任何东西说得出这件事——于是现象是「一开始没反应，
   *   切一下触发方式就好了」（切到音量当然就好了，那条路不需要模板）。
   * ⚠ 这一段必须待在**有 `rms` 的那个渲染函数里**：第一版我把它放进了
   *   `updateHeaderStatus()`，那里根本没有 `rms` 这个名字——
   *   一个恒为 `undefined` 的判据只会让横幅永远不显示，而且不报错。
   */
  const blockedBanner = $('ov-gate-blocked');
  if (blockedBanner) {
    const blocked = rms?.gate_blocked === true;
    blockedBanner.hidden = !blocked;
    if (blocked) {
      blockedBanner.textContent = '⚠ 当前是「拍掌触发」，但还没有录入手势——门不会打开，'
        + '说什么都不会有反应。请去 My Voice 页录制拍掌手势，或到 Settings 切回「音量触发」。';
    }
  }

  /**
   * 顶部流水线 Gate 状态条：RMS -(N%)- VAD(Ns) -(N%)- ASR
   * - 两个 N% 是与各自阈值的比例（RMS 比例与 CAM++/FireRedVAD 比例）
   * - (Ns) 在自动模式为关门倒计时，在手动模式为 FireRedVAD 累积池实际秒数
   */
  const openThreshold = Number(rms?.open_threshold ?? rms?.threshold ?? rms?.config?.open_threshold ?? 0.015);
  const currentRms = Number(level) || 0;
  const enterThreshold = Number(cam?.config?.enter_threshold ?? 0.4);
  const exitThreshold = Number(cam?.config?.exit_threshold ?? 0.35);
  // 服务端 projection 已经把 App/legacy 的事实统一成 last_similarity；页面不再
  // 用 legacy `enabled` 字段猜 App executor 是否真的在判定。
  const sim = Number(cam?.last_similarity ?? cam?.similarity);
  const camState = cam?.state ?? '—';
  const camReady = cam?.projection_ready === true
    || (cam?.executor === 'app' && cam?.app?.app_running === true)
    || (cam?.executor !== 'app' && cam?.enabled === true);
  const camOn = camReady && Number.isFinite(sim);

  const isManual = pub?.service?.features?.manual?.engaged === true
    || pub?.activity?.source === 'manual'
    || pipeline?.owner === 'speech.manual'
    || domains.listen?.engaged === true;

  const VAD_HARD_LIMIT_SEC = 12.0;
  let poolSec = 0;
  if (isManual) {
    /**
     * ⛔ `heard` is deliberately broad: in manual listen the RMS gate is held
     * open, so it remains true during silence.  Using it as FireRedVAD speech
     * would start a browser-side stopwatch at listen entry and pin the node at
     * the 12s hard-cap forever.  The manual counter must follow the VAD fact;
     * CAM/public activity belongs only to the automatic path.
     */
    const isSpeaking = domains.vad?.activity?.active === true;
    const curCut = domains.vad?.gradient?.cuts ?? 0;
    const curSeg = domains.vad?.wav?.segments_published ?? 0;
    if (curCut !== lastGradientCutCount || curSeg !== lastWavSegmentId) {
      lastGradientCutCount = curCut;
      lastWavSegmentId = curSeg;
      speechSegmentStartMs = isSpeaking ? Date.now() : 0;
    }

    if (Number(domains.vad?.activity?.segment_ms) > 0 && isSpeaking) {
      poolSec = Number(domains.vad.activity.segment_ms) / 1000;
    } else if (isSpeaking) {
      if (!speechSegmentStartMs) speechSegmentStartMs = Date.now();
      poolSec = Math.max(0, (Date.now() - speechSegmentStartMs) / 1000);
    } else {
      speechSegmentStartMs = 0;
      poolSec = 0;
    }
    if (poolSec > VAD_HARD_LIMIT_SEC) poolSec = VAD_HARD_LIMIT_SEC;
  } else {
    speechSegmentStartMs = 0;
  }

  const owner = pipeline?.owner ?? (isManual ? 'speech.vad' : 'speech.rms');
  const asrActive = owner === 'speech.asr' || domains.asr?.authority?.active === true || tx.active;
  const vadActive = !asrActive && (owner === 'speech.vad' || domains.vad?.activity?.active === true || speaking || isManual);
  const rmsActive = !asrActive && !vadActive;

  // 1. RMS 比例柱/百分比 -(N%)-
  const rmsRatio = openThreshold > 0 ? Math.round((currentRms / openThreshold) * 100) : 0;
  const elRmsRatio = $('gr-rms');
  if (elRmsRatio) {
    setText(elRmsRatio, `(${rmsRatio}%)`);
    elRmsRatio.className = `gate-ratio${rmsRatio >= 100 ? ' over-threshold' : ''}`;
  }

  // 2. VAD 节点：手动听写模式显示当前句累积秒数 VAD(Ns)；自动模式显示关门倒计时 (Ns)
  const elVadCountdown = $('gc-vad');
  if (elVadCountdown) {
    if (isManual) {
      setText(elVadCountdown, `(${poolSec.toFixed(1)}s)`);
    } else if (admission.active === true && Number.isFinite(Number(admission.remaining_seconds))) {
      const sec = Math.max(0, Math.ceil(Number(admission.remaining_seconds)));
      setText(elVadCountdown, `(${sec}s)`);
    } else if (domains.vad?.countdown?.remaining_ms > 0) {
      const sec = Math.max(0, Math.ceil(Number(domains.vad.countdown.remaining_ms) / 1000));
      setText(elVadCountdown, `(${sec}s)`);
    } else if (heard || rms?.state === 'open') {
      setText(elVadCountdown, '(8s)');
    } else {
      setText(elVadCountdown, '(0s)');
    }
  }

  // 3. 第二段比例 -(N%)-：手动模式为累积池/硬切上限比例；自动模式为 CAM++ 相似度比例
  const elCamRatio = $('gr-cam');
  if (elCamRatio) {
    if (isManual) {
      const poolPct = Math.round((poolSec / VAD_HARD_LIMIT_SEC) * 100);
      setText(elCamRatio, `(${poolPct}%)`);
      elCamRatio.className = `gate-ratio${poolPct >= 100 ? ' over-threshold' : ''}`;
    } else if (camOn && Number.isFinite(sim)) {
      const camRatio = enterThreshold > 0 ? Math.round((sim / enterThreshold) * 100) : 0;
      setText(elCamRatio, `(${camRatio}%)`);
      elCamRatio.className = `gate-ratio${camRatio >= 100 ? ' over-threshold' : ''}`;
    } else {
      setText(elCamRatio, '(0%)');
      elCamRatio.className = 'gate-ratio';
    }
  }

  // Gate 节点高亮激活
  const nodeRms = $('gn-rms');
  const nodeVad = $('gn-vad');
  const nodeAsr = $('gn-asr');
  if (nodeRms) nodeRms.className = `gate-box${rmsActive ? ' active' : ''}`;
  if (nodeVad) nodeVad.className = `gate-box${vadActive ? ' active' : ''}`;
  if (nodeAsr) nodeAsr.className = `gate-box${asrActive ? ' active' : ''}`;

  /** 兼容测试保留节点 */
  const countdown = $('rms-cam-countdown');
  if (countdown) {
    countdown.hidden = true;
    const seconds = Number(admission.remaining_seconds);
    setText(countdown, admission.active === true && Number.isFinite(seconds)
      ? `CAM++ 等待确认 USER · ${Math.max(0, Math.ceil(seconds))} 秒` : '');
  }

  /**
   * RMS 能量与 CAM++ / FireRedVAD 复合时序柱状图：
   * - 手动听写模式：底层 RMS 灰柱 + 顶层 FireRedVAD 浅蓝波浪柱（硬切上限 12s 满格）
   * - 自动模式：底层 RMS 灰柱 + 顶层 CAM++ 声纹相似度柱（绿/橙/灰）
   */
  /**
   * ⭐ **一秒一根柱**，⛔ 不是「一帧一根」。
   *
   * 状态流在 Overview 上是 400ms（2.5Hz），照单push 会让 60 根柱只覆盖 24 秒，
   * 而且节奏会随 `interval_ms` 变——**同一张图在不同页面状态下代表不同的时间跨度**。
   * 现在固定 1Hz：同一秒内的多帧合并成一根，RMS 取**峰值**（不是均值）——
   * ⚠ 开门判据看的就是瞬时越线，均值会把那一下抹平，于是图上永远看不到
   * 「刚才那一下到底有没有过线」。CAM++ 相似度取该秒**最后一个**有效值（它本来就是 3.3Hz）。
   */
  const bucket = Math.floor(Date.now() / 1000);

  /**
   * ⭐ **产品意义的「语音」，⛔ 不是 CAM++ 相似度高**（docs/091 PART C）。
   *
   * 判据三条同时成立：
   *   ① 判断门**真的开了**（`speaker_activity.active` 就是「Gate admitted 且 CAM 在跑」）；
   *   ② 状态机此刻判为 `USER`；
   *   ③ 这一秒**确实有一条 activity 事实**——App 的 USER 心跳时间戳往前走过。
   *
   * ⚠ 少了 ③，一个静止的 `state=USER` 会被每一秒复制成一根新柱，
   *   于是图上画出的是「状态」而不是「发生过的事」。
   * ⚠ 少了 ①，未过门的高相似度也会画成语音——使用者实测到的正是这个。
   *   raw similarity 仍然留在 tooltip 与诊断页，⛔ 但它不是产品事实。
   */
  const gateAdmitted = cam?.active === true || cam?.inference_admitted === true;
  const userTs = Number(cam?.last_user_mono_ms);
  if (Number.isFinite(userTs) && userTs > lastUserMonoSeen) {
    lastUserMonoSeen = userTs;
    lastUserAdvanceAtMs = Date.now();
  }
  const userFresh = lastUserAdvanceAtMs > 0
    && (Date.now() - lastUserAdvanceAtMs) < USER_FACT_FRESH_MS;
  const speechNow = gateAdmitted && camState === 'USER' && userFresh;

  const slot = liveSlots.get(bucket) ?? {
    bucket,
    rms: 0,
    threshold: openThreshold,
    gate: false,
    speech: false,
    sim: null,
    camState: null,
    isManual,
    poolSec: 0,
    hardLimit: VAD_HARD_LIMIT_SEC,
    enter: enterThreshold,
    exit: exitThreshold,
  };
  // ⭐ RMS 取该秒**峰值**：开门判据看的就是瞬时越线，均值会把那一下抹平。
  slot.rms = Math.max(Number(slot.rms) || 0, currentRms);
  slot.threshold = openThreshold;
  slot.gate = slot.gate || heard || gateAdmitted;
  slot.speech = slot.speech || speechNow;
  slot.isManual = isManual;
  slot.poolSec = Math.max(Number(slot.poolSec) || 0, poolSec);
  slot.enter = enterThreshold;
  slot.exit = exitThreshold;
  if (camOn && Number.isFinite(sim)) { slot.sim = sim; slot.camState = camState; }
  liveSlots.set(bucket, slot);
  // 只留窗口内的；⛔ 不按数组长度裁剪——slot 的身份是**秒**，不是下标。
  for (const key of liveSlots.keys()) {
    if (key <= bucket - LIVE_WINDOW_SECONDS) liveSlots.delete(key);
  }

  const off = $('cam-off');
  if (off) {
    off.hidden = false;
    setText(off, isManual
      ? `1 秒一柱 · 浅灰＝RMS 峰值 · 浅蓝＝当前句累积 PCM 时长（上限 ${VAD_HARD_LIMIT_SEC.toFixed(1)}s）`
      : `1 秒一柱 · 浅灰＝RMS 峰值（阈值 ${openThreshold.toFixed(4)}）· 绿/橙/灰＝CAM++ 相似度（阈值 ${enterThreshold.toFixed(2)}）`);
  }

  if (isManual) {
    V.setBadge($('cam-now'), `FireRedVAD ${poolSec.toFixed(1)}s · RMS ${currentRms.toFixed(4)}`,
      poolSec > 0 ? 'good' : '');
  } else {
    V.setBadge($('cam-now'), camOn && Number.isFinite(sim)
      ? `${camState} · sim ${sim.toFixed(2)} | RMS ${currentRms.toFixed(4)}`
      : `RMS ${currentRms.toFixed(4)}`,
      (camOn && sim >= enterThreshold) || heard ? 'good' : '');
  }

  renderCamBars($('ov-cam-history'), bucket);

  /** 1. 表顶浅蓝色虚线（80px 高度对应 100% 阈值） */
  const rmsLine = $('rms-threshold-line');
  if (rmsLine) {
    rmsLine.style.bottom = '80px';
    rmsLine.title = isManual
      ? `FireRedVAD 硬切上限 (100%): ${VAD_HARD_LIMIT_SEC.toFixed(1)}s`
      : `RMS 开门阈值 (100%): ${openThreshold.toFixed(4)}`;
  }

  /** 2. 橙色虚线（CAM++ 准入阈值线，手动模式隐藏） */
  const camLine = $('cam-threshold');
  if (camLine) {
    if (isManual) {
      camLine.hidden = true;
    } else {
      const camH = Math.max(10, Math.min(76, Math.round(((enterThreshold + 0.2) / 1.0) * 80)));
      camLine.style.bottom = `${camH}px`;
      camLine.hidden = !camReady;
      camLine.title = `CAM++ 准入阈值: ${enterThreshold.toFixed(2)}`;
    }
  }
}

/**
 * ⭐ **固定时间轴**（docs/091 PART B）：60 个 slot × 1 秒 = 最近一分钟。
 *
 * ⚠ 旧实现是一个数组 + `flex:1`：柱宽 = 100% ÷ 当前条数，于是刚打开页面时
 *   1 条占满整幅、2 条各半、3 条各三分之一……**同一根柱在两秒之间宽度就变了**。
 *   现在 slot 数量恒为 60，缺的那些留空；新的一秒从**右边**进来，旧的往左走，
 *   宽度从第一帧起就是最终宽度。
 * ⭐ slot 的身份是**那一秒**（`Math.floor(Date.now()/1000)`），⛔ 不是数组下标——
 *   所以锁屏回来时旧 slot 自然滑出窗口，⛔ 不需要补几十根空柱，宽度也不会变。
 */
const LIVE_WINDOW_SECONDS = 60;
/** bucket(秒) → slot 事实。 */
const liveSlots = new Map();
/** App 的 USER 心跳最近一次**前进**的时刻（页面本地钟）。见 speechNow 的判据 ③。 */
let lastUserMonoSeen = 0;
let lastUserAdvanceAtMs = 0;
/** 心跳限速 1Hz，故 1.5 秒的新鲜窗刚好覆盖一次正常间隔。 */
const USER_FACT_FRESH_MS = 1500;

/**
 * ⭐ **固定 slot 的复合时序图**（docs/091 PART B/C）。
 *
 * 契约（这三条是本函数存在的理由，⛔ 不许被"看起来差不多"的写法替掉）：
 *   ① 永远渲染 [LIVE_WINDOW_SECONDS] 个格子，缺数据的格子**留空**——
 *      柱宽因此从第一帧起就是最终宽度，⛔ 不随当前条数重新平均分配；
 *   ② 第 i 个格子代表**第 `nowBucket - (N-1) + i` 秒**：新的在右、旧的向左，
 *      ⛔ 不是"数组第 i 项"；
 *   ③ 同一格里的所有图层 **left:0 / right:0**，宽度与 x 完全相同，
 *      只有高度/颜色/层序不同——⛔ 不许某一层画得更窄。
 */
function renderCamBars(box, nowBucket) {
  if (!box) return;
  const PLOT_H = 80;
  const first = nowBucket - (LIVE_WINDOW_SECONDS - 1);
  const cols = [];
  for (let i = 0; i < LIVE_WINDOW_SECONDS; i += 1) {
    const bucket = first + i;
    const r = liveSlots.get(bucket);
    const col = document.createElement('i');
    col.className = 'cam-col';
    col.dataset.bucket = String(bucket);
    if (!r) {
      // ⭐ 空格子仍然占一整格：时间轴不会因为没数据而挤在一起。
      col.classList.add('cam-col-empty');
      cols.push(col);
      continue;
    }

    // 底层：RMS 峰值（浅灰参照量）
    const th = Number(r.threshold) > 0 ? Number(r.threshold) : 0.015;
    const val = Number(r.rms) || 0;
    const rmsRatio = val / th;
    const rmsH = Math.max(2, Math.min(PLOT_H, Math.round(rmsRatio * PLOT_H)));
    const rmsBar = document.createElement('span');
    rmsBar.className = 'bar-rms';
    rmsBar.style.height = `${rmsH}px`;
    col.appendChild(rmsBar);

    // 中层：判断门开着的那几秒（一条贴底的细线，⛔ 不抢高度）
    if (r.gate) {
      const gateBar = document.createElement('span');
      gateBar.className = 'bar-gate';
      col.appendChild(gateBar);
    }

    if (r.isManual) {
      // 手动听写：FireRedVAD 累积池
      const poolSec = Number(r.poolSec) || 0;
      const hardLimit = Number(r.hardLimit) || 12.0;
      const vadH = Math.max(0, Math.min(PLOT_H, Math.round((poolSec / hardLimit) * PLOT_H)));
      if (vadH > 0) {
        const vadBar = document.createElement('span');
        vadBar.className = 'bar-firered';
        vadBar.style.height = `${vadH}px`;
        col.appendChild(vadBar);
      }
      col.title = `RMS 峰值 ${val.toFixed(4)} (${Math.round(rmsRatio * 100)}%) · `
        + `FireRedVAD 累积 ${poolSec.toFixed(1)}s / ${hardLimit.toFixed(1)}s`;
    } else {
      /**
       * ⭐ **顶层只画产品意义的「语音」**：门开了 **且** 判为 USER **且**
       *   这一秒真有一条 activity 事实。⛔ 未过门的 CAM++ 相似度不画成语音——
       *   raw similarity 只进 tooltip 与诊断页。
       */
      if (r.speech) {
        const simVal = Number(r.sim);
        const enterTh = Number(r.enter ?? 0.4);
        const h = Number.isFinite(simVal)
          ? Math.max(8, Math.min(PLOT_H, Math.round(((simVal + 0.2) / 1.0) * PLOT_H)))
          : Math.round(PLOT_H * 0.6);
        const speechBar = document.createElement('span');
        speechBar.className = 'bar-speech';
        speechBar.style.height = `${h}px`;
        col.appendChild(speechBar);
        col.title = `语音 · RMS 峰值 ${val.toFixed(4)} (${Math.round(rmsRatio * 100)}%)`
          + (Number.isFinite(simVal) ? ` · CAM++ ${simVal.toFixed(2)} (阈值 ${enterTh.toFixed(2)})` : '');
      } else {
        const simVal = Number(r.sim);
        col.title = `RMS 峰值 ${val.toFixed(4)} / 阈值 ${th.toFixed(4)} (${Math.round(rmsRatio * 100)}%)`
          + (r.gate ? ' · 门已开' : ' · 门未开')
          + (Number.isFinite(simVal) ? ` · CAM++ ${simVal.toFixed(2)}（未计为语音）` : '');
      }
    }
    cols.push(col);
  }
  box.replaceChildren(...cols);
}

function renderProduct(pub) {
  if (!pub) return;
  const svc = pub.service ?? {};
  const f = svc.features ?? {};
  const act = pub.activity ?? {};
  const tx = pub.transcription ?? {};
  const latest = pub.latest ?? {};

  setNote($('pd-service-note'), svc.ready
    ? (svc.degraded ? '核心功能正常，部分功能不可用。' : '一切正常。')
    : '核心功能不可用。', svc.ready ? (svc.degraded ? '' : 'good') : 'bad');
  V.setBadge($('pd-service-badge'), svc.ready ? (svc.degraded ? '部分可用' : '正常') : '不可用',
    svc.ready ? (svc.degraded ? 'warn' : 'good') : 'bad');

  /** ⚠ 「现在怎么样」搬进了「声音活动」卡（那里才是一开口就动的地方）。 */
  /** ⚠ `disabled` 的人话就是「关闭」，⛔ 不要拼成「关闭 · 已关闭」。 */
  setText($('pd-resident'), f.resident?.ready ? '开启'
    : f.resident?.reason === 'disabled' ? '关闭' : `关闭 · ${humanReason(f.resident?.reason)}`);
  setText($('pd-manual'), f.manual?.ready
    ? (act.source === 'manual' && act.active ? '工作中' : '待命')
    : humanReason(f.manual?.reason));
  setText($('pd-asr'), f.transcription?.ready
    ? `${modelLabel(f.transcription?.backend)} · 就绪`
    : humanReason(f.transcription?.reason));

  /**
   * ⚠ 概览那两行文字（正在识别 / 最近识别）**不在这里写**——
   *   它们与诊断页那两行由 `renderAsrLive` 一个函数统一写（docs/075）。
   *   ⛔ 在这里再写一次，就是把刚合并好的两个写入点重新拆开。
   */
  setNote($('asr-live-note'), tx.active ? '正在识别…' : '', '');

  // 语音功能页的三张卡（同一份状态，⛔ 不另开数据源）
  V.setBadge($('res-badge'), f.resident?.ready ? '开启' : '关闭', f.resident?.ready ? 'good' : '');
  setText($('res-state'), act.source === 'resident' && act.active
    ? USER_STATE_TEXT[act.user_state] ?? '有人在说话' : '待命中');
  setText($('res-profile'), f.resident?.reason === 'no_voice_profile'
    ? '尚未登记我的声音' : '已登记我的声音');
  V.setBadge($('man-badge'), act.source === 'manual' && act.active ? '工作中' : '待命',
    act.source === 'manual' && act.active ? 'good' : '');
  setText($('man-state'), f.manual?.ready ? '' : humanReason(f.manual?.reason));
  setText($('man-text'), tx.status === 'incomplete'
    ? (tx.provisional_text || '正在识别…')
    : (latest.latest_final_text ?? '—'));
}

const REGIONS = [
  ['product', ['public'], () => renderProduct(domains.public)],
  ['overview-activity', ['rms_gate', 'public', 'speaker_activity', 'pipeline', 'vad', 'asr'],
    () => renderActivity(domains.rms_gate, domains.public, domains.speaker_activity, domains.pipeline, domains.vad, domains.asr)],
  ['settings-chain', ['lifecycle', 'capture'],
    () => V.renderChain(domains, { pending: chainPending, failure: activeChainFailure() })],
  ['settings-audio-control', ['lifecycle', 'pcm_consumers', 'input', 'listen'],
    () => V.renderAudioControl(domains.lifecycle, domains.pcm_consumers,
      domains.input, domains.listen)],
  ['settings-speaker-gate', ['speaker_gate', 'foreground'],
    () => V.renderSpeakerGate(domains.speaker_gate, domains.foreground)],
  ['overview-asr-live', ['asr_live'], () => {
    V.renderAsrLive(domains.asr_live);
    if (wantedInterval() !== socketIntervalMs) retuneStateSocket();
  }],
  ['overview-summary', ['service', 'input', 'rms_gate', 'vad', 'asr', 'states', 'listen', 'speaker_activity'],
    () => V.renderDiagSummary(domains, listenState)],
  ['overview-input', ['input'], () => V.renderInputDiag(domains.input)],
  ['overview-rms', ['rms_gate'], () => V.renderRms(domains.rms_gate)],
  ['overview-vad', ['vad', 'speaker_activity', 'listen', 'pipeline'],
    () => V.renderVad(domains.vad, domains.speaker_activity, domains.listen, domains.pipeline)],
  ['overview-asr', ['asr', 'pipeline', 'asr_backend'],
    () => V.renderAsr(domains.asr, domains.pipeline, domains.asr_backend)],
  ['mem-badge', ['memory'], () => V.renderMemory(domains.memory)],
];

/** 页面区域真正属于哪个产品 tab；隐藏页不进行 DOM 更新。 */
const REGION_PAGES = Object.freeze({
  product: ['overview', 'settings'],
  'overview-activity': ['overview'],
  'settings-chain': ['settings'],
  'settings-audio-control': ['settings'],
  'settings-speaker-gate': ['settings'],
  'overview-asr-live': ['overview'],
  'overview-summary': ['overview'],
  'overview-input': ['overview'],
  'overview-rms': ['overview'],
  'overview-vad': ['overview'],
  'overview-asr': ['overview'],
  'mem-badge': ['overview', 'settings', 'voice'],
});
const regionVisible = (name) => (REGION_PAGES[name] ?? []).some(
  (page) => $(`page-${page}`)?.hidden === false,
);

/**
 * ⭐ **一个区域坏掉只坏它自己。**
 *
 * 0.21.4 真机上：`renderChain` 往一个已被删除的节点写 `textContent` 抛了 TypeError，
 * 而这个循环没有隔离——于是**它后面的每一个区域都不画**。表现出来不是「语音链那块坏了」，
 * 而是 INPUT 空白、页头永远停在「正在读取 Live 状态…」、MEM 一直是「—」。
 * ⚠ 一个渲染错误看起来像一个数据错误，是这一类 bug 最贵的地方。
 *
 * ⛔ 但**不许静默吞掉**：坏掉的区域名要显示出来，否则「这块没数据」和
 *   「这块的渲染器炸了」在界面上又一次长得一模一样（docs/078 §9 同一条）。
 */
const regionFailures = new Map();

/**
 * 页头那一行。⭐ 它回答的是「这一页现在在说的是**什么时候**的事」——
 * ⛔ 不是流水线状态（那是概览的活），也不是内部枚举。
 */
const stateSummary = () => {
  const chain = domains.lifecycle?.chain;
  const recording = domains.input?.pcm?.recording === true;
  if (chain !== 'started') return '语音链已停止 · 实时状态正常';
  return recording ? '正在收音 · 实时状态正常' : '语音链运行中 · 麦克风未在采集';
};

const applyDomains = (changed) => {
  if (document.visibilityState !== 'visible') return;
  const touched = new Set(Object.keys(changed ?? {}));
  for (const [name, needs, render] of REGIONS) {
    if (!regionVisible(name)) continue;
    if (!needs.some((domain) => touched.has(domain))) continue;
    try {
      render();
      if (regionFailures.delete(name)) renderRegionFailures();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (regionFailures.get(name) !== message) {
        regionFailures.set(name, message);
        console.error(`[speech-ui] region "${name}" 渲染失败：`, error);
        renderRegionFailures();
      }
    }
    domUpdates += 1;
  }
};

/** 把坏掉的区域摆到页头。⚠ 它必须自己**不会**抛，否则就是一个会自杀的错误处理器。 */
function renderRegionFailures() {
  const box = $('region-failures');
  if (!box) return;
  const rows = [...regionFailures.entries()];
  box.hidden = rows.length === 0;
  box.textContent = rows.length
    ? `⚠ ${rows.length} 个界面区域渲染失败：${rows.map(([n, m]) => `${n}（${m}）`).join('；')}`
    : '';
}

/** 页面重新可见、或切 tab 时，把当前产品区域重画一次。 */
const renderVisible = () => {
  if (document.visibilityState !== 'visible') return;
  applyDomains(Object.fromEntries(Object.keys(domains).map((name) => [name, true])));
};

const ingestStateFrame = (frame) => {
  if (frame?.schema !== 'termux-os.speech-state.v1' || !frame.domains) {
    // 认不出的结构是**显式失败**，不是空状态（docs/056 同一形状）。
    throw new Error(`状态帧结构不认识（schema=${frame?.schema ?? '缺失'}）`);
  }
  if (frame.full === true || frame.boot_id !== stateBootId) {
    // 服务重启：旧版本号绝不能盖在新 snapshot 上。整份换掉。
    for (const key of Object.keys(domains)) delete domains[key];
    stateBootId = frame.boot_id;
  }
  Object.assign(domains, frame.domains);
  stateVersion = Number(frame.version) || stateVersion;
  // listen 归属随时被外部调用方改变；自己的请求还在飞时不接管。
  if (domains.listen && !listenPending) listenState = domains.listen;
  applyDomains(frame.domains);
};

/* ============================================================
   状态 WebSocket
   ⛔ 没有定时器。服务端挂到真的有变化才回一帧。
   ============================================================ */
let stateSocket = null;
let stateReconnect = null;
let stateBackoffMs = 1000;
let stateConnectionGeneration = 0;
let stateLastMessageAt = 0;
let stateWatchdog = null;
const STATE_WATCHDOG_MS = 45_000;

const closeStateSocket = () => {
  clearTimeout(stateReconnect);
  stateReconnect = null;
  clearTimeout(stateWatchdog);
  stateWatchdog = null;
  stateConnectionGeneration += 1;
  const socket = stateSocket;
  stateSocket = null;
  if (socket) {
    // 先摘监听器再关：否则 close 事件会安排一次我们并不想要的重连。
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try { socket.close(); } catch { /* 已经关了。 */ }
  }
};

const armStateWatchdog = (socket, generation) => {
  clearTimeout(stateWatchdog);
  stateWatchdog = setTimeout(() => {
    if (stateSocket !== socket || stateConnectionGeneration !== generation) return;
    // OPEN 只代表 TCP/WebSocket 尚未报错，不代表服务端仍在送状态；主动拆掉
    // zombie 连接，走同一条 onclose 重连路径。
    closeStateSocket();
    connectStateSocket();
  }, STATE_WATCHDOG_MS);
};

/**
 * ⭐ 要多快，由**这一页在看什么**决定。
 *
 * Overview 上有真的 RMS/CAM/VAD 音量与趋势，400ms（2.5Hz）已经足够；其它页面以 1 秒状态为主。
 * ⚠ 这不只是省流量：真机实测每一次推送都要把渲染进程从空闲里叫醒，而那件事
 * 本身的固定代价比解析和重绘都大（页面零推送时 Chrome 4.24%，5Hz 推送时 9.78%）。
 */
/** 半快门 provisional 是产品路径的实时事实；静息时 Overview 仍保留实时 RMS。 */
const STATE_INTERVAL_MS = { overview: 400, live: 400, other: 1000 };
// ⚠ 半快门 provisional 是这条产品路径的实时事实；没有它时回到静息节奏。
const liveDoorOpen = () => domains.asr_live?.current_status === 'incomplete';
const wantedInterval = () => (
  $('page-overview')?.hidden === false
    ? (liveDoorOpen() ? STATE_INTERVAL_MS.live : STATE_INTERVAL_MS.overview)
    : STATE_INTERVAL_MS.other
);
let socketIntervalMs = null;

/** 需要的节奏变了才换订阅。重连会拿到完整 snapshot，不会漏状态。 */
const retuneStateSocket = () => {
  if (wantedInterval() === socketIntervalMs) return;
  closeStateSocket();
  connectStateSocket();
};

const updateHeaderStatus = (liveTone = 'ok') => {
  const liveDot = $('st-dot-live');
  if (liveDot) {
    liveDot.className = `status-dot ${liveTone}`;
    liveDot.title = liveTone === 'ok' ? '实时状态正常' : liveTone === 'warn' ? '正在重连' : '连接异常';
  }
  const chainDot = $('st-dot-chain');
  if (chainDot) {
    const chain = domains.lifecycle?.chain;
    const isStarted = chain === 'started';
    chainDot.className = `status-dot ${isStarted ? 'ok' : 'off'}`;
    chainDot.title = isStarted ? '语音链运行中' : '语音链已停止';
  }
  const micDot = $('st-dot-mic');
  if (micDot) {
    const isRecording = domains.input?.recording === true
      || (domains.input?.holders && domains.input.holders.length > 0)
      || domains.lifecycle?.capture?.state === 'recording'
      || domains.lifecycle?.chain === 'started';
    micDot.className = `status-dot ${isRecording ? 'ok' : 'off'}`;
    micDot.title = isRecording ? '收音中（麦克风已占用）' : '未在收音（麦克风已释放）';
  }

  // 1. VAD: M / A (手动 / 自动)
  const isManual = domains.listen?.engaged === true
    || domains.public?.service?.features?.manual?.engaged === true
    || domains.public?.activity?.source === 'manual'
    || domains.pipeline?.owner === 'speech.manual';
  const vadVal = $('st-val-vad');
  if (vadVal) {
    setText(vadVal, isManual ? 'M' : 'A');
    vadVal.title = isManual ? 'VAD：手动 (FireRedVAD)' : 'VAD：自动 (CAM++VAD)';
  }

  // 2. ASR: SenseVoice
  const asrVal = $('st-val-asr');
  if (asrVal) {
    setText(asrVal, 'SV');
    asrVal.title = 'ASR 模型：SenseVoice';
  }

  // 3. GATE: RMS / VAD
  const gateVal = $('st-val-gate');
  if (gateVal) {
    const owner = domains.pipeline?.owner ?? 'speech.rms';
    const isVad = owner === 'speech.vad' || owner === 'speech.asr' || domains.vad?.activity?.active === true;
    setText(gateVal, isVad ? 'VAD' : 'RMS');
    gateVal.title = isVad ? '当前 Gate 控制：VAD 语音活动判定' : '当前 Gate 控制：RMS 能量开门';
  }

  // 4. 更新概览顶部模式切换 tablist（自动转录 / 手动转录 / 停止收音，三选一）
  const isAuto = !isManual && (
    domains.speaker_activity?.enabled === true
    || domains.public?.service?.features?.resident?.engaged === true
    || $('res-enabled')?.checked === true
  );
  const currentMode = isManual ? 'manual' : isAuto ? 'auto' : 'stop';

  const btnAuto = $('btn-mode-auto');
  if (btnAuto) {
    btnAuto.classList.toggle('active', currentMode === 'auto');
    btnAuto.setAttribute('aria-selected', String(currentMode === 'auto'));
  }
  const btnMan = $('man-toggle');
  if (btnMan) {
    btnMan.classList.toggle('active', currentMode === 'manual');
    btnMan.setAttribute('aria-selected', String(currentMode === 'manual'));
  }
  const btnStop = $('ac-mic');
  if (btnStop) {
    btnStop.classList.toggle('active', currentMode === 'stop');
    btnStop.setAttribute('aria-selected', String(currentMode === 'stop'));
  }
};

const connectStateSocket = () => {
  clearTimeout(stateReconnect);
  stateReconnect = null;
  // ⛔ 同一时刻只允许存在一个订阅。刷新、切页、重连都走这里。
  if (stateSocket || document.visibilityState !== 'visible') return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socketIntervalMs = wantedInterval();
  const socket = new WebSocket(
    `${protocol}//${location.host}${PKG}/state/ws?interval_ms=${socketIntervalMs}`,
  );
  const generation = ++stateConnectionGeneration;
  stateSocket = socket;
  document.documentElement.dataset.stateSocket = 'connecting';
  socket.onopen = () => {
    if (stateSocket !== socket || stateConnectionGeneration !== generation) return;
    stateBackoffMs = 1000;
    stateLastMessageAt = Date.now();
    document.documentElement.dataset.stateSocket = 'live';
    armStateWatchdog(socket, generation);
    setNote($('connection-note'), 'Android App API · PCM WS · RMS · VAD · ASR 已连接', 'good');
    updateHeaderStatus('ok');
  };
  socket.onmessage = (event) => {
    if (stateSocket !== socket || stateConnectionGeneration !== generation) return;
    try {
      ingestStateFrame(JSON.parse(event.data));
      stateLastMessageAt = Date.now();
      armStateWatchdog(socket, generation);
      /**
       * ⭐ **成功也要说出来。**
       *
       * 这两个节点此前**只在出错时**才有人写：顺利的时候页头永远停在
       * 「正在读取 Live 状态…」、徽章永远是 `CONNECTING`——于是「一切正常」和
       * 「一帧都没收到」在页面上长得一模一样，而使用者只能读到后者那句话。
       * ⚠ 一个只在失败时更新的状态指示，等于把成功也显示成失败。
       */
      V.setBadge($('pipeline-live'), 'LIVE', 'ok');
      setNote($('pipeline-note'), stateSummary(), '');
      updateHeaderStatus('ok');
      if (recoveryNeeded && Date.now() >= nextRecoveryAt) {
        nextRecoveryAt = Date.now() + 2000;
        void loadAll();
      }
    } catch (error) {
      V.setBadge($('pipeline-live'), 'ERROR', 'bad');
      setNote($('pipeline-note'), `状态流不可用：${error.message}`, 'bad');
      updateHeaderStatus('bad');
    }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* 已经关了。 */ } };
  socket.onclose = () => {
    if (stateSocket !== socket || stateConnectionGeneration !== generation) return;
    stateSocket = null;
    clearTimeout(stateWatchdog);
    stateWatchdog = null;
    document.documentElement.dataset.stateSocket = 'offline';
    V.setBadge($('pipeline-live'), 'STALE', 'warn');
    setNote($('pipeline-note'), '状态流断开，正在重连…', 'warn');
    updateHeaderStatus('warn');
    if (document.visibilityState !== 'visible') return;
    stateReconnect = setTimeout(connectStateSocket, stateBackoffMs);
    stateBackoffMs = Math.min(15_000, stateBackoffMs * 2);
  };
};

/* ============================================================
   设置：分组填充与保存
   ⚠ 正在编辑的分组不许被后台刷新覆盖 —— 一次自动恢复把用户刚敲的数字擦掉，
   而且不留任何痕迹，是最难被发现的那种失败。
   ============================================================ */
const dirty = new Set();
const forms = Object.freeze({ daily: 'form-daily' });
for (const [group, id] of Object.entries(forms)) {
  $(id)?.addEventListener('input', () => {
    if (dirty.has(group)) return;
    dirty.add(group);
    setNote($(`${group}-note`), '有未保存的修改。', 'warn');
  });
}
const markSaved = (group) => dirty.delete(group);

function populateDaily(asr) {
  if (dirty.has('daily')) return;
  $('asr-model').value = asr.model ?? 'sensevoice';
  $('asr-language').value = asr.language ?? 'auto';
}
function renderDevices(payload) {
  const configured = payload?.configured?.input_device ?? 'system_default';
  $('input-device').replaceChildren(
    new Option('系统默认 · Android 自动选择', 'system_default'),
    ...(payload?.inputs ?? []).map((device) => new Option(V.labelDevice(device), device.selector)),
  );
  $('input-device').value = configured;
}
function renderAdvanced(value) {
  $('selected').textContent = value?.selection?.selector ?? '—';
  $('routed').textContent = V.labelDevice(value?.selection?.routed_device);
  $('pcm-state').textContent = value?.pcm?.transport_connected
    ? `${value.pcm.sample_rate_hz} Hz · frame ${value.pcm.frame_seq} · ${value.pcm.last_frame_age_ms ?? '—'} ms`
    : value?.pcm?.recording ? '等待鉴权 PCM WS' : '未采集';
  renderMicHolders(value?.demand);
}

/**
 * ⭐「采集中」回答不了「凭什么在采集」。停链之后麦克风仍然开着是完全可能的——
 * 只要还有别人要它。把持有者原样列出来，那句「我明明停了链」才有地方对质。
 */
function renderMicHolders(demand) {
  const holders = demand?.holders ?? [];
  const label = ({
    'user.persistent': '你（永久收音）',
    'termux-speech': '语音链',
  });
  $('mic-holders').textContent = holders.length
    ? holders.map((id) => label[id] ?? id).join('、')
    : '无人持有 · 已释放';
}

/** 一个分组一次保存，可能落到多个后端端点——分组是按用途划的，端点是按模块划的。 */
const saveGroup = async (group, button, steps) => {
  if (busy) return;
  busy = true;
  button.disabled = true;
  setNote($(`${group}-note`), '正在保存…', '');
  try {
    for (const step of steps) await step();
    markSaved(group);
    setNote($(`${group}-note`), '已保存并立即应用。', 'good');
    await loadAll();
  } catch (error) {
    setNote($(`${group}-note`), `保存失败：${error.message}`, 'bad');
  } finally {
    busy = false;
    button.disabled = false;
  }
};

$('form-daily').addEventListener('submit', (event) => {
  event.preventDefault();
  /**
   * ⭐ **保存就是切换**（使用者反馈③）。⛔ 不再有一个单独的「切换」按钮——
   *   两个按钮意味着「选了但没切」是一个合法状态，而没有人想要那个状态。
   * ⚠ 切换可能要载入一张图，所以先切模型再存语言：
   *   模型切失败时整组保存失败并如实报出来，⛔ 不会留下「语言存了、模型没换」。
   * ⚠ 成功也必须**回读**：前端改了 selected 不等于后端真的换了档位。
   */
  const wantedModel = $('asr-model').value;
  void saveGroup('daily', $('save-daily'), [
    async () => {
      await request('/asr/config', { method: 'POST', body: { model: wantedModel } });
      const confirmed = await request('/asr/config');
      $('asr-model').value = confirmed.value.model;
      if (confirmed.value.model !== wantedModel) {
        throw new Error(`后端保留了 ${modelLabel(confirmed.value.model)}——切换未生效`);
      }
      setNote($('asr-model-note'),
        `已切换到 ${modelLabel(confirmed.value.model)}，下一段语音起生效。`, 'good');
    },
    () => request('/asr/config', {
      method: 'POST',
      body: {
        language: $('asr-language').value,
      },
    }),
  ]);
});

// ⛔ 曾经的 `bindPair(range, number)` 已删除：唯一的使用者是
//   `open-threshold`/`open-number`，而它们的联动现在归 policy 卡自己管
//   （见 `policy-save` 附近）。⚠ 两处都绑会让 dirty 标记在其中一条路径上丢掉。


/* ============================================================
   听写 Listen
   ⚠ 后端不区分调用方：`POST /listen {enabled:false}` 无条件退出。
   所以「不得把别人持有的听写静默关掉」这条保护只能落在这里 —— 二次确认。
   ============================================================ */
const readListen = async () => {
  const payload = await request('/listen');
  listenState = payload.value;
  return listenState;
};

/* ============================================================
   语音链 Chain Start / Stop
   ⚠ 停链是**真的**释放资源：撤销 Mic 需求、关闭语音消费者、卸载 VAD/ASR 常驻。
   服务本身不停，API 仍然可用，随时可以直接开始听写。
   ============================================================ */
/**
 * ⚠ 可选绑定不是防御性洁癖：这个按钮换过两次页面，而**顶层的一个 TypeError
 *   会静默掐掉它后面的全部监听器**——页面还在，只是什么都不响应。
 *   一个只在某些页面存在的节点，绑定就必须是 `?.`。
 */
$('ac-chain')?.addEventListener('click', async () => {
  if (busy || chainPending) return;
  const lifecycle = domains.lifecycle;
  const started = lifecycle?.chain === 'started';
  const holders = (lifecycle?.requesters ?? []).filter((id) => id !== 'webui');
  let force = false;
  if (started && holders.length) {
    // ⛔ 后端对普通停链会直接 409 并报出是谁；这里先问一次，让「误触」和「明知故犯」
    // 分得开。强制停链会收走对方的听写——那是使用者的决定，不是我们的。
    const confirmed = window.confirm(
      `听写正被「${holders.join('、')}」持有。\n\n`
      + '停止语音链会强行收走它们的听写，对方的输入会立刻断掉。确定要停止吗？',
    );
    if (!confirmed) return;
    force = true;
  }
  chainPending = started ? 'stop' : 'start';
  chainFailure = null;
  V.renderChain(domains, { pending: chainPending });
  setNote($('ac-note'), started ? '正在释放麦克风并卸载模型…' : '正在启动语音链…', '');
  try {
    const payload = await request(started ? '/chain/stop' : '/chain/start', {
      method: 'POST',
      body: started ? { reason: 'webui', force } : { reason: 'webui' },
    });
    const revoked = payload.revoked ?? [];
    const dictation = payload.value?.dictation;
    setNote(
      $('chain-note'),
      started
        ? `语音链已停止：麦克风已释放${
          dictation === 'unloaded' ? '，VAD/ASR 已卸载' : '，识别图按常驻策略保留在内存里'
        }${revoked.length ? `（收走了 ${revoked.join('、')} 的听写）` : ''}。`
        : '语音链已启动，正在等待 RMS 通过。',
      'good',
    );
  } catch (error) {
    chainFailure = error.message;
    chainFailureAt = Date.now();
    setNote($('ac-note'), `操作失败：${error.message}`, 'bad');
  } finally {
    chainPending = null;
    // 不猜结果：状态流会带回后端的真实状态。这里只是把 pending 徽章立刻撤掉。
    V.renderChain(domains, { pending: null, failure: activeChainFailure() });
  }
});

/**
 * ⭐ 顶部模式选择 tablist（自动转录 / 手动转录 / 停止收音，三选一）
 */
$('btn-mode-auto')?.addEventListener('click', async () => {
  if (busy || manualBusy) return;
  busy = true;
  try {
    // 1. 如果手动听写开着，先退出手动
    if (domains.listen?.engaged === true || domains.public?.activity?.source === 'manual') {
      await request('/listen', {
        method: 'POST',
        body: { enabled: false, requester: 'webui', reason: 'switch_to_auto' },
      }).catch(() => {});
    }
    // 2. 开启自动常驻
    await request('/speaker-activity/config', { method: 'POST', body: { enabled: true } });
    if ($('res-enabled')) $('res-enabled').checked = true;
    // 3. 确保语音链运行
    if (domains.lifecycle?.chain !== 'started') {
      await request('/chain/start', { method: 'POST', body: { reason: 'webui_auto' } }).catch(() => {});
    }
    setNote($('res-state'), '自动转录已开启。', 'good');
  } catch (error) {
    setNote($('res-state'), `开启自动转录失败：${error.message}`, 'bad');
  } finally {
    busy = false;
    await loadAll().catch(() => {});
  }
});

let manualBusy = false;
$('man-toggle')?.addEventListener('click', async () => {
  if (manualBusy || busy) return;
  manualBusy = true;
  try {
    // 1. 如果自动转录开着，先关掉自动常驻
    if (domains.speaker_activity?.enabled === true || $('res-enabled')?.checked === true) {
      await request('/speaker-activity/config', { method: 'POST', body: { enabled: false } }).catch(() => {});
      if ($('res-enabled')) $('res-enabled').checked = false;
    }
    // 2. 确保语音链运行
    if (domains.lifecycle?.chain !== 'started') {
      await request('/chain/start', { method: 'POST', body: { reason: 'webui_manual' } });
    }
    // 3. 开启手动听写
    await request('/listen', {
      method: 'POST',
      body: { enabled: true, requester: 'webui', reason: 'webui_manual' },
    });
    await readListen().catch(() => {});
  } catch (error) {
    setNote($('man-state'), `操作失败：${error.message}`, 'bad');
  } finally {
    manualBusy = false;
    await loadAll().catch(() => {});
  }
});

$('ac-mic')?.addEventListener('click', async () => {
  if (busy || manualBusy) return;
  busy = true;
  try {
    // 1. 如果手动听写开着，退出手动
    if (domains.listen?.engaged === true || domains.public?.activity?.source === 'manual') {
      await request('/listen', {
        method: 'POST',
        body: { enabled: false, requester: 'webui', reason: 'webui_stop' },
      }).catch(() => {});
    }
    // 2. 如果自动转录开着，关闭自动常驻
    if (domains.speaker_activity?.enabled === true || $('res-enabled')?.checked === true) {
      await request('/speaker-activity/config', { method: 'POST', body: { enabled: false } }).catch(() => {});
      if ($('res-enabled')) $('res-enabled').checked = false;
    }
    // 3. 停止语音链消费（不处理传入 PCM，但保留底层 mic 配置）
    if (domains.lifecycle?.chain === 'started') {
      await request('/chain/stop', { method: 'POST', body: { reason: 'webui_stop' } }).catch(() => {});
    }
    setNote($('ac-note'), '已停止处理语音输入。', 'good');
  } catch (error) {
    setNote($('ac-note'), `停止失败：${error.message}`, 'bad');
  } finally {
    busy = false;
    await loadAll().catch(() => {});
  }
});

/** 常驻语音助手：正式配置开关（⛔ 不是 Activity Test 那个调试端点）。 */
/** ⭐ 只留一个复制按钮（旧 Overview 有 10 个）。 */
$('copy-latest')?.addEventListener('click', () => {
  // ⚠ 复制的必须是**页面上显示的那一句**，而唯一知道那是哪一句的是渲染器本身。
  void reportCopy(V.latestText());
});

$('res-enabled')?.addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    await request('/speaker-activity/config', { method: 'POST', body: { enabled } });
    setNote($('res-state'), enabled ? '已开启。' : '已关闭。', 'good');
  } catch (error) {
    setNote($('res-state'), `操作失败：${error.message}`, 'bad');
    event.target.checked = !enabled;   // ⚠ 失败就退回去，⛔ 不留一个说谎的勾
  }
});

/* ============================================================
   进阶控制
   ============================================================ */
async function runAction(path, body, success) {
  if (busy) return null;
  busy = true;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  setNote($('action-note'), '处理中…', '');
  try {
    const payload = await request(path, { method: 'POST', body });
    setNote($('action-note'), success, 'good');
    await loadAll();
    return payload;
  } catch (error) {
    setNote($('action-note'), error.message === 'requires_user_foreground'
      ? '请先把 Termux-os App 切到前台，再开启输入。'
      : `失败：${error.message}`, 'bad');
    return null;
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}
$('input-device').addEventListener('change', () => {
  void runAction('/input-device', { selector: $('input-device').value }, '输入设备已更新');
});
/**
 * ⚠ 开启的是 App 的 `user.persistent`——一份**跨停链、跨重启**的需求，除了这里
 * 没有别的地方会撤销它。所以它必须是一次明确的选择，而不是一个看起来像
 * 「开始听」的普通按钮（那正是真机上那份无主需求的来历）。
 */
$('enable').addEventListener('click', () => {
  const confirmed = window.confirm(
    '开启永久收音后，麦克风会一直由你持有：\n\n'
    + '· 停止语音链不会关闭它\n'
    + '· App 重启后依然生效\n'
    + '· 只有在这里再次关闭才会释放\n\n'
    + '只想使用语音链的话不需要开启它。确定要开启吗？',
  );
  if (!confirmed) return;
  void runAction('/mic/enable', {}, '永久收音已开启');
});
$('disable').addEventListener('click', () => void runAction('/mic/disable', {}, '永久收音已关闭'));
/* ============================================================
   声纹前景门（docs/081）
   ⚠ 两个开关都**即时生效**，没有「保存」按钮：它们各只是一个布尔，
   而一个需要额外点一次保存的开关，会让人以为自己已经关掉了。
   ⛔ 这里不写阈值——阈值在 Speaker Lab 校准并确认，页面只显示。
   ============================================================ */
const applySpeakerGate = async (patch, label) => {
  if (busy) return;
  busy = true;
  setNote($('spkgate-note'), '正在应用…', '');
  try {
    const payload = await request('/speaker-gate/config', { method: 'POST', body: patch });
    /**
     * ⭐ 回读，不要按本地勾选状态写结论。开与「真的能判」是两件事：
     *   门开了但没校准，后端会如实报 bypass，而页面若照抄勾选就会说「已启用」。
     */
    const gate = payload.value;
    setNote($('spkgate-note'), gate.enabled
      ? (gate.ok ? `${label}：正在按声纹判段。`
        : `${label}：已开启，但校准未完成，现在只会安全放行。`)
      : `${label}：已关闭，恢复原来的音量门行为。`,
    gate.enabled && !gate.ok ? 'warn' : 'good');
    await loadAll();
  } catch (error) {
    setNote($('spkgate-note'), `应用失败：${error.message}`, 'bad');
    await loadAll();          // 勾选框回到后端的真实状态，⛔ 不留一个假的已开启
  } finally {
    busy = false;
  }
};
$('spkgate-enabled').addEventListener('change', () => void applySpeakerGate(
  { enabled: $('spkgate-enabled').checked }, '声纹前景门'));

$('refresh').addEventListener('click', () => void loadAll());

/* ============================================================
   加载
   ============================================================ */
async function loadAll() {
  if (fullLoadBusy) return false;
  fullLoadBusy = true;
  try {
    const [devices, input, asr, listen] = await Promise.all([
      request('/devices'),
      request('/speech-input'),
      request('/asr/config'),
      request('/listen'),
    ]);
    // 闸门取不到不该让整页加载失败——它住在 App，App 可能正在重启。
    listenState = listen.value;
    renderDevices(devices);
    renderAdvanced(input.value);
    populateDaily(asr.value);
    /**
     * 常驻助手开关的**真值在配置里**，⛔ 不是页面记的一个布尔。
     * ⚠ 读的是 `enabled_in_config` 而不是 consumer 状态：链停着的时候 consumer 是关的，
     *   而使用者的设定仍然是「开」——两者不是一回事。
     */
    request('/speaker-activity/state')
      .then((r) => { if ($('res-enabled')) $('res-enabled').checked = r.enabled_in_config === true; })
      .catch(() => {});
    try {
      await loadTranscripts();
    } catch (error) {
      // 结构不认识是**显式失败**，不是空历史。
      setNote($('tx-note'), error.message, 'bad');
    }
    setNote($('connection-note'), 'Android App API · PCM WS · RMS · VAD · ASR 已连接', 'good');
    recoveryNeeded = false;
    return true;
  } catch (error) {
    recoveryNeeded = true;
    nextRecoveryAt = Date.now() + 2000;
    setNote($('connection-note'), `不可用：${error.message}`, 'bad');
    V.setBadge($('pipeline-live'), 'ERROR', 'bad');
    return false;
  } finally {
    fullLoadBusy = false;
  }
}

/* ============================================================
   Transcript WebSocket
   ============================================================ */
let transcriptSocket = null;
let transcriptReconnect = null;
let transcriptConnectionGeneration = 0;
let transcriptLastMessageAt = 0;
let transcriptWatchdog = null;
const TRANSCRIPT_WATCHDOG_MS = 60_000;

const closeTranscriptSocket = () => {
  clearTimeout(transcriptReconnect);
  transcriptReconnect = null;
  clearTimeout(transcriptWatchdog);
  transcriptWatchdog = null;
  transcriptConnectionGeneration += 1;
  const socket = transcriptSocket;
  transcriptSocket = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try { socket.close(); } catch { /* 已经关了。 */ }
  }
};

const armTranscriptWatchdog = (socket, generation) => {
  clearTimeout(transcriptWatchdog);
  transcriptWatchdog = setTimeout(() => {
    if (transcriptSocket !== socket || transcriptConnectionGeneration !== generation) return;
    closeTranscriptSocket();
    connectTranscriptSocket();
  }, TRANSCRIPT_WATCHDOG_MS);
};

const connectTranscriptSocket = () => {
  clearTimeout(transcriptReconnect);
  transcriptReconnect = null;
  // ⛔ 同一时刻只允许一个订阅。
  if (transcriptSocket || document.visibilityState !== 'visible') return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}${PKG}/asr/transcripts/ws?after=${transcriptCursor}`);
  const generation = ++transcriptConnectionGeneration;
  transcriptSocket = socket;
  document.documentElement.dataset.transcriptSocket = 'connecting';
  V.setBadge($('asr-ws'), 'WS CONNECTING', 'warn');
  socket.onopen = () => {
    if (transcriptSocket !== socket || transcriptConnectionGeneration !== generation) return;
    transcriptLastMessageAt = Date.now();
    document.documentElement.dataset.transcriptSocket = 'live';
    armTranscriptWatchdog(socket, generation);
    V.setBadge($('asr-ws'), 'WS LIVE', 'ok');
  };
  socket.onmessage = (event) => {
    if (transcriptSocket !== socket || transcriptConnectionGeneration !== generation) return;
    try {
      const frame = JSON.parse(event.data);
      transcriptLastMessageAt = Date.now();
      armTranscriptWatchdog(socket, generation);
      if (frame.type === 'transcript') rememberTranscripts([frame.value]);
      if (frame.type === 'error') {
        V.setBadge($('asr-ws'), 'WS DEGRADED', 'warn');
        setNote($('tx-note'), `Transcript WS：${frame.error}`, 'bad');
      }
    } catch { /* Ignore a malformed observation and keep the feed alive. */ }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* 已经关了。 */ } };
  socket.onclose = () => {
    if (transcriptSocket !== socket || transcriptConnectionGeneration !== generation) return;
    transcriptSocket = null;
    clearTimeout(transcriptWatchdog);
    transcriptWatchdog = null;
    document.documentElement.dataset.transcriptSocket = 'offline';
    V.setBadge($('asr-ws'), 'WS OFFLINE', 'warn');
    if (document.visibilityState !== 'visible') return;
    transcriptReconnect = setTimeout(connectTranscriptSocket, 1000);
  };
};

/**
 * 页面恢复的唯一入口。⛔ readyState===OPEN 不是健康证明：锁屏/后台后的半死连接
 * 可能永远不触发 close，却也不再交付 final 或 RMS。每次 resume 都先废弃两条旧
 * socket，REST 重建最新 cursor/baseline，再按 state → transcript 顺序重新订阅。
 */
let resumeInFlight = null;
let lastResumeAt = 0;
const resumeLive = async (reason = 'resume') => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (resumeInFlight) return resumeInFlight;
  if (now - lastResumeAt < 2000 && stateSocket && transcriptSocket) {
    renderVisible();
    return;
  }
  lastResumeAt = now;
  closeStateSocket();
  closeTranscriptSocket();
  resumeInFlight = (async () => {
    try {
      await loadTranscripts();
    } catch (error) {
      setNote($('tx-note'), `恢复 ${reason} 时历史同步失败：${error.message}`, 'bad');
    }
    if (document.visibilityState !== 'visible') return;
    // 新 state WS 会重新取得 RMS observer lease；PCM product demand 仍由后端
    // consumer 聚合决定，这里不打开 PCM，也不把 observer 当成 product capture。
    connectStateSocket();
    connectTranscriptSocket();
    renderVisible();
  })().finally(() => { resumeInFlight = null; });
  return resumeInFlight;
};

/** 页面隐藏 = 完全静默；回到前台统一走 REST + 两条 socket 的恢复路径。 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void resumeLive('visibilitychange');
  else {
    closeStateSocket();
    closeTranscriptSocket();
  }
});
window.addEventListener('pageshow', () => void resumeLive('pageshow'));
window.addEventListener('focus', () => void resumeLive('focus'));

/**
 * ⛔ 这里曾经是 `setInterval(loadLive, 250)`——每秒四次把整份 28.8KB 的状态
 * 从服务端搬到浏览器再整页重绘一遍，不管有没有东西变。它没有了。
 */
/* ============================================================
   我的声音 —— 声纹登记（tab，不是另开一页）
   ⭐ 与 `speaker.html` 的产品区打同一组 `/speaker/*` 端点，⛔ 不是第二套流程。
   ⚠ 它**不订状态流**：登记是低频的、有明确起止的操作，
     `/speaker/state` 只在这一页可见时按需拉取——把它塞进每秒推送的热域，
     等于让一个一年用一次的功能常驻在热路径上。
   ============================================================ */
let voiceTimer = null;
let voiceBusy = false;
let voiceTestActive = false;

const voiceNotice = (message, type = '') => {
  const box = $('vc-error');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message ? message : '';
  box.className = type === 'good' || message.startsWith('✅')
    ? 'note good'
    : message ? 'note bad' : 'note';
};

const voiceError = (message) => voiceNotice(message ? `⚠ ${message}` : '', 'bad');

/** ⚠ 一律走 `request()`：它认 Browser Session，且失败是**显式**的。 */
const voiceCall = async (path, body) => {
  const payload = await request(path, body === undefined
    ? {} : { method: 'POST', body });
  voiceError('');
  return payload;
};

const VOICE_REASON = {
  profile_missing: '还没有声纹', calibration_not_acknowledged: '还没有启用',
  profile_changed: '声纹重建过，需要重新启用',
  window_changed: '参数改过，需要重新启用',
  threshold_changed: '参数改过，需要重新启用', calibrated: '已启用',
};

function renderVoice(payload) {
  const v = payload?.value ?? {};
  /**
   * ⭐ **只在正在录样本时才轮询**，`idle` 立刻停。
   * ⚠ 录样本期间必须轮询：段是后端按停顿切出来的，不轮询的话使用者要等到
   *   按下「停止」才看见自己刚说的那几段——那时候错了也来不及重说。
   * ⛔ 但它不是常驻心跳：`1.2s`、只打 `/speaker/state`、离开这一页就 clear。
   */
  setVoicePolling(String(v.mode ?? 'idle') !== 'idle');
  const profile = v.profile ?? {};
  const cal = v.calibration ?? {};
  const armed = payload?.speaker_gate?.armed === true;
  // The server-side gate acknowledgement is the source of truth. Do not use
  // browser storage for product state; it can outlive the profile it describes.
  const isTested = Boolean(cal.ok && armed);

  V.setBadge($('vc-badge'), !cal.ok ? '未启用' : isTested ? '已激活' : '就绪',
    isTested ? 'ok' : cal.ok ? 'warn' : '');
  setText($('vc-note'), '用平时音量说几句话，停顿自动切段（建议 5 段，至少 3 段）。');

  const count = profile.enrollment_count ?? 0;
  const minNeeded = profile.config?.min_enrollments ?? 3;
  const canBuild = count >= minNeeded;
  const canClear = Boolean(profile.ready || count > 0);

  // 1. 录制按钮：蓝色（录制） vs 红色（停止）
  const isEnrolling = String(v.mode ?? 'idle') !== 'idle';
  const startBtn = $('vc-start');
  if (startBtn && !voiceTestActive) {
    startBtn.textContent = isEnrolling ? '停止' : '录制';
    startBtn.className = isEnrolling ? 'danger' : 'primary';
    startBtn.disabled = false;
    startBtn.title = isEnrolling ? '停止录制样本' : '开始录制样本';
  }

  // 2. 生成按钮：蓝色（可点） vs 灰色（不可点）
  const buildBtn = $('vc-build');
  if (buildBtn && !voiceTestActive) {
    buildBtn.disabled = !canBuild;
    buildBtn.className = 'primary';
    buildBtn.title = canBuild ? '生成声纹并启用' : `至少需要 ${minNeeded} 段样本（当前 ${count} 段）`;
  }

  // 3. 测试按钮：蓝色（可点） vs 灰色（不可点）
  const testBtn = $('vc-test');
  if (testBtn && !voiceTestActive) {
    testBtn.disabled = !profile.ready;
    testBtn.className = 'primary';
    testBtn.title = profile.ready ? '录音 5 秒测试声纹识别' : '请先录制样本并生成声纹';
  }

  // 4. 重置按钮：红色（可点） vs 灰色（不可点）
  const clearBtn = $('vc-clear');
  if (clearBtn && !voiceTestActive) {
    clearBtn.disabled = !canClear;
    clearBtn.className = 'danger';
    clearBtn.title = canClear ? '重置声纹与全部录音样本' : '暂无声纹或样本可重置';
  }

  V.setBadge($('vc-mode'), String(v.mode ?? 'idle').toUpperCase(),
    String(v.mode ?? 'idle') === 'idle' ? '' : 'ok');

  const facts = $('vc-facts');
  if (facts) {
    // 1. 我的声纹
    const row1 = document.createElement('div');
    const key1 = document.createElement('span'); key1.textContent = '我的声纹';
    const val1 = document.createElement('strong');
    if (profile.ready) {
      val1.textContent = '已生成';
      const detailVal = profile.pairwise?.p50 !== undefined && profile.pairwise?.p50 !== null
        ? profile.pairwise.p50
        : profile.fingerprint;
      if (detailVal) {
        const sub = document.createElement('small');
        sub.className = 'muted vc-detail-val';
        sub.textContent = ` (${detailVal})`;
        val1.appendChild(sub);
      }
    } else {
      val1.textContent = '未生成';
      val1.className = 'muted';
    }
    row1.append(key1, val1);

    // 2. 已录样本
    const row2 = document.createElement('div');
    const key2 = document.createElement('span'); key2.textContent = '已录样本';
    const val2 = document.createElement('strong');
    val2.textContent = `${count} / ${minNeeded}`;
    val2.className = count >= minNeeded ? 'good' : 'muted';
    row2.append(key2, val2);

    facts.replaceChildren(row1, row2);
  }

  /**
   * ⭐ 每段样本都能试听与删除。
   * ⚠ `MISSING` 是带内取值：登记记录还在、录音没了，是两件不同的事实。
   */
  const list = $('vc-clips');
  if (!list) return;
  const clips = v.enroll_clips ?? [];
  list.replaceChildren(...clips.map((clip, index) => {
    const li = document.createElement('li');
    const headerRow = document.createElement('div');
    headerRow.className = 'clip-header';
    const missing = clip.status !== 'OK';
    const title = document.createElement('span');
    title.className = missing ? 'clip-title drop' : 'clip-title';
    title.textContent = `样本 ${clips.length - index} · ${(clip.duration_ms ?? 0) / 1000} 秒`
      + (missing ? ' (文件丢失)' : '');
    headerRow.append(title);

    const playRow = document.createElement('div');
    playRow.className = 'clip-play-row';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.setAttribute('controlslist', 'nodownload noplaybackrate nofullscreen');
    audio.setAttribute('disableremoteplayback', '');
    audio.disableRemotePlayback = true;
    audio.src = `${PKG}/speaker/audio?clip=${encodeURIComponent(clip.wav)}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-del-circle';
    del.setAttribute('aria-label', '删除');
    del.title = '删除此样本';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10" fill="#e0403f" stroke="#e0403f"/><line x1="7" y1="12" x2="17" y2="12" stroke="#ffffff"/></svg>';
    del.onclick = () => voiceAction(async () => {
      await voiceCall('/speaker/profile/remove', { id: clip.id });
    });

    playRow.append(audio, del);
    li.append(headerRow, playRow);
    return li;
  }));
}

async function refreshVoice() {
  if ($('page-voice')?.hidden !== false) return;
  try {
    renderVoice(await request('/speaker/state'));
  } catch (error) {
    voiceError(`读不到声纹状态：${error.message}`);
  }
}

/* ==================================================================
   拍手手势（App Feature Gate）—— 与声纹并列的第二种触发方式。
   ⭐ 判定、模板、DSP 全在 App 内；这一页只做**低频**的录入与调参。
   ⚠ 形状刻意与声纹那张卡一致（录制 / 生成 / 测试 / 重置），
     因为它们回答的是同一个问题：「这是不是我」。
   ================================================================== */
let clapBusy = false;
let clapTesting = false;
let clapTimer = null;

const clapNotice = (message, type = '') => {
  const box = $('cl-error');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message || '';
  box.className = type === 'good' ? 'note good' : message ? 'note bad' : 'note';
};

const clapCall = async (path, body) => {
  const payload = await request(path, body === undefined ? {} : { method: 'POST', body });
  clapNotice('');
  return payload;
};

const setClapPolling = (wanted) => {
  if (!wanted) { clearInterval(clapTimer); clapTimer = null; return; }
  if (clapTimer !== null) return;
  clapTimer = setInterval(refreshClap, 1200);
};

const CLAP_VERDICT = {
  good: ['一致', 'ok'],
  weak: ['勉强一致', 'warn'],
  inconsistent: ['样本不一致', 'bad'],
  none: ['—', ''],
};

function renderClap(payload) {
  const v = payload?.value ?? {};
  const profile = v.profile ?? {};
  const enroll = v.enroll ?? {};
  const enrolling = enroll.enrolling === true;
  const testing = v.testing === true;
  // ⭐ 只在录制或测试时轮询；idle 立刻停——它不是常驻心跳。
  setClapPolling(enrolling || testing);

  const ready = profile.ready === true;
  const verdict = CLAP_VERDICT[profile.verdict] ?? CLAP_VERDICT.none;
  V.setBadge($('cl-badge'),
    !ready ? '未录入' : verdict[0],
    ready ? verdict[1] : '');
  setText($('cl-note'),
    enrolling ? `连拍「啪-啪」，已捕获 ${enroll.captured ?? 0} / ${enroll.max ?? 8} 组。`
      : testing ? '现在拍给它看，下面会显示每次的相似度，⛔ 不会触发任何下游。'
      : '用你习惯的节奏连拍两下，录 5～8 组。触发方式要在设置里选「特征」才会生效。');

  const captured = enrolling ? (enroll.captured ?? 0) : (profile.samples ?? 0);
  const minNeeded = enroll.min_required ?? 5;

  /**
   * ⭐ **一条通用规则：退出某个状态的按钮，永远不能被「进入那个状态的前提」禁用。**
   *
   * ⚠ 真机报的缺陷：测试中按「重置」→ 模板没了 → `ready=false` →
   *   「停止测试」跟着变灰 → 而 `testing` 还是 true，于是**四个按钮全部禁用且退不出来**。
   *   根因已在 App 侧修掉（清模板会退出测试模式），这里再补一道结构性的：
   *   只要一个按钮此刻的语义是「停止」，它就必须可点。
   */
  const startBtn = $('cl-start');
  if (startBtn) {
    startBtn.textContent = enrolling ? '停止' : '录制';
    startBtn.className = enrolling ? 'danger' : 'primary';
    startBtn.disabled = clapBusy || (enrolling ? false : testing);
  }
  const buildBtn = $('cl-build');
  if (buildBtn) {
    buildBtn.disabled = !enrolling || captured < minNeeded;
    buildBtn.title = enrolling
      ? (captured >= minNeeded ? '用 median/MAD 汇总并保存' : `至少 ${minNeeded} 组（当前 ${captured}）`)
      : '先开始录制';
  }
  const testBtn = $('cl-test');
  if (testBtn) {
    testBtn.textContent = testing ? '停止测试' : '测试';
    testBtn.className = testing ? 'danger' : 'primary';
    // ⭐ 见上：`testing` 时它是「停止」，⛔ 不许因为没有模板而禁用。
    testBtn.disabled = testing ? clapBusy : (!ready || enrolling || clapBusy);
    testBtn.title = testing ? '退出测试模式'
      : ready ? '拍给它看，只打分不开门' : '请先录制并生成';
  }
  const clearBtn = $('cl-clear');
  if (clearBtn) {
    clearBtn.disabled = clapBusy || (!ready && captured === 0);
    clearBtn.className = 'danger';
  }

  const facts = $('cl-facts');
  if (facts) {
    const row = (label, text, cls) => {
      const d = document.createElement('div');
      const k = document.createElement('span'); k.textContent = label;
      const val = document.createElement('strong'); val.textContent = text;
      if (cls) val.className = cls;
      d.append(k, val);
      return d;
    };
    const rows = [
      row('已录手势', `${captured} / ${minNeeded}`, captured >= minNeeded ? 'good' : 'muted'),
      row('权威来源', v.source === 'app_gate_profile' ? 'App Feature Gate profile' : '—',
        v.source === 'app_gate_profile' ? 'good' : 'bad'),
      row('本次读取', v.observed_at_ms ? new Date(v.observed_at_ms).toLocaleTimeString() : '—', 'muted'),
      row('触发模式', v.mode ?? '—', 'muted'),
    ];
    if (ready) {
      /**
       * ⭐ **一致度必须显示出来**。`ready` 只说明「有个文件」，不说明它好不好——
       * 真机上有人录了 31 组节奏各异的样本，模板宽到几乎什么都收，
       * 而界面照样只显示「已录入」。
       */
      const c = Number(profile.consistency ?? 0);
      rows.push(row('一致度', `${(c * 100).toFixed(0)}%`,
        c >= 0.75 ? 'good' : c >= 0.55 ? 'muted' : 'bad'));
      rows.push(row('双拍间隔',
        `${Math.round(profile.interval_center_ms ?? 0)} ± ${Math.round(profile.interval_spread_ms ?? 0)} ms`,
        'muted'));
    }
    const feature = v.feature ?? {};
    rows.push(row('背景 / 信噪比',
      `${Math.round(feature.noise_floor_db ?? 0)} / ${Math.round(feature.last_snr_db ?? 0)} dB`, 'muted'));
    facts.replaceChildren(...rows);
  }

  const list = $('cl-clips');
  if (!list) return;
  // 录制中看本次捕获；平时看已保存的样本。⚠ 两者是不同的事实，⛔ 不混成一个列表。
  const items = enrolling ? (enroll.samples ?? [])
    : (profile.sample_details ?? []);
  const recent = (v.recent ?? []).filter((e) => e.kind === 'test_pass' || e.kind === 'test_fail');
  const rendered = testing ? recent : items;
  list.replaceChildren(...rendered.map((item, index) => {
    const li = document.createElement('li');
    const header = document.createElement('div');
    header.className = 'clip-header';
    const title = document.createElement('span');
    if (testing) {
      const f = item.feature ?? {};
      const pass = item.kind === 'test_pass';
      title.textContent = `${pass ? '✓' : '✗'} 相似度 ${((item.match_score ?? 0) * 100).toFixed(0)}%`
        + ` · 间隔 ${Math.round(f.interval_ms ?? 0)} ms`;
      title.className = pass ? 'good' : 'bad';
    } else {
      const score = Number(item.score ?? 0);
      title.textContent = `#${index + 1} 间隔 ${Math.round(item.interval_ms ?? 0)} ms`
        + (enrolling ? '' : ` · 与模板 ${(score * 100).toFixed(0)}%`);
      // ⭐ 离群样本要显眼：它就是把模板拉宽的那一条。
      if (!enrolling && score < 0.5) title.className = 'bad';
    }
    header.append(title);
    if (!testing) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.textContent = '删除';
      del.addEventListener('click', () => clapAction(async () => {
        await clapCall('/clap/enroll/drop', { index });
      }));
      header.append(del);
    }
    li.append(header);
    return li;
  }));
}

/* ---- Settings：触发方式（音量 / 拍掌）----
   ⭐ 只有一个真相：App 的 `gate_mode`。这一栏读它、写它，⛔ 本包不另存一份，
      否则两边会各说各的，而症状是「切了没用」。 */
/**
 * ⭐ P1：低频设置的写入路径是**一次完整 policy PUT**。
 * ⚠ 逐字段 setter 会让 App 与本包各改各的，而中途失败会留下一个
 *   谁也描述不出来的混合状态——那正是本轮要消灭的形态。
 */
let policyCache = null;

async function putPolicy(mutate) {
  const current = (await request('/policy'))?.value ?? {};
  const next = JSON.parse(JSON.stringify(current));
  mutate(next);
  // ⭐ policy.asr.backend 是 App 的内部投影，不是第二个设置；保存其它 policy 时
  //   也要把它钉回 cfg.asr.model，避免一次无关的保存把自动链切到旧默认值。
  const asrConfig = await request('/asr/config');
  const selectedModel = asrConfig?.value?.model;
  if (typeof selectedModel === 'string' && selectedModel) {
    (next.asr ??= {}).backend = selectedModel;
  }
  next.generation = Number(current.generation ?? 0) + 1;
  next.updated_at_ms = Date.now();
  const r = await request('/policy/put', { method: 'POST', body: next });
  policyCache = (await request('/policy'))?.value ?? next;
  return r?.value ?? r;
}

async function refreshTrigger() {
  if ($('page-settings')?.hidden !== false) return;
  try {
    const v = (await request('/clap/state'))?.value ?? {};
    // ⭐ 同时读**那扇门自己**报告的开门源，⛔ 不假设切换一定已经生效。
    const door = await request('/rms').catch(() => null);
    renderTrigger(v, door?.value?.gate?.open_source ?? door?.value?.open_source ?? null);
    policyCache = (await request('/policy'))?.value ?? null;
    renderPolicy(policyCache, (await request('/policy/status'))?.value ?? null);
  } catch (error) {
    setText($('trg-note'), `读不到触发方式：${error.message}`);
  }
}

/**
 * ⭐ **policy 的每个可调字段在界面上只出现一次，且映射只写一遍。**
 *
 * `[元素 id, 域, 字段, 类型]`。读、写、脏检查全部走这张表——
 * ⚠ 手写两遍（一遍填表、一遍收集）必然漂：加了字段却忘了在另一边加，
 *   症状是「这个值永远保存不上」或者「保存时被默认值覆盖」，而且不报错。
 */
const POLICY_FIELDS = Object.freeze([
  // ⭐ 触发方式就是 policy 的一个字段；它在这张表里出现一次，别处不再有入口。
  ['pol-gate-mode', 'gate', 'mode', 'str'],
  ['open-number', 'gate', 'volume_threshold', 'float'],
  ['pol-gate-frames', 'gate', 'volume_frames', 'int'],
  ['pol-gate-tol', 'gate', 'feature_tolerance', 'str'],
  ['pol-spk-enter', 'speaker', 'enter_threshold', 'float'],
  ['pol-spk-exit', 'speaker', 'exit_threshold', 'float'],
  ['pol-spk-encf', 'speaker', 'enter_confirm', 'int'],
  ['pol-spk-excf', 'speaker', 'exit_confirm', 'int'],
  ['pol-spk-window', 'speaker', 'window_ms', 'int'],
  ['pol-spk-step', 'speaker', 'step_ms', 'int'],
  ['pol-spk-headmode', 'speaker', 'head_mode', 'str'],
  ['pol-spk-usertimeout', 'speaker', 'user_timeout_ms', 'int'],
  ['pol-vad-provider', 'vad', 'provider', 'str'],
  ['pol-vad-th', 'vad', 'speech_threshold', 'float'],
  ['pol-vad-look', 'vad', 'gate_lookback_ms', 'int'],
  ['pol-vad-gates', 'vad', 'gates_speaker', 'bool'],
  ['pol-seg-head', 'segment', 'head_lookback_ms', 'int'],
  ['pol-seg-tail', 'segment', 'tail_keep_ms', 'int'],
  ['pol-seg-grace', 'segment', 'continuation_grace_ms', 'int'],
  ['pol-hist-keep', 'history', 'wav_keep', 'int'],
]);

/** 正在编辑时不许被后台刷新覆盖——⚠ 一次自动回填把刚敲的数字擦掉是最气人的那种 bug。 */
let policyDirty = false;
const markPolicyDirty = () => {
  policyDirty = true;
  setNote($('policy-note'), '有未保存的修改。', 'warn');
};

function fillPolicyForm(policy) {
  if (!policy || policyDirty) return;
  for (const [id, domain, key, type] of POLICY_FIELDS) {
    const el = $(id);
    if (!el) continue;
    const value = policy[domain]?.[key];
    if (value === undefined || value === null) continue;
    if (type === 'bool') el.checked = value === true;
    else el.value = String(value);
  }
  // range 与 number 是同一个字段的两个视图，⛔ 只填一个会让滑块停在旧位置。
  const range = $('open-threshold');
  if (range && policy.gate?.volume_threshold !== undefined) {
    range.value = String(policy.gate.volume_threshold);
  }
}

/** ⭐ 收集时对每个字段做一次范围检查——后端会**拒绝**越界值而不是钳制，先在这里说清楚。 */
function collectPolicy(next) {
  for (const [id, domain, key, type] of POLICY_FIELDS) {
    const el = $(id);
    if (!el) continue;
    const target = (next[domain] ??= {});
    if (type === 'bool') { target[key] = el.checked === true; continue; }
    if (type === 'str') { target[key] = String(el.value); continue; }
    const raw = Number(el.value);
    if (!Number.isFinite(raw)) throw new Error(`${domain}.${key} 不是一个数字`);
    const min = el.min === '' ? null : Number(el.min);
    const max = el.max === '' ? null : Number(el.max);
    if ((min !== null && raw < min) || (max !== null && raw > max)) {
      throw new Error(`${domain}.${key} 必须在 ${el.min}～${el.max} 之间（当前 ${raw}）`);
    }
    target[key] = type === 'int' ? Math.round(raw) : raw;
  }
}

/** 版本行：⭐ desired 与 applied 分开显示——段落进行中时它们会不同，而那**不是错误**。 */
function renderPolicy(policy, status) {
  fillPolicyForm(policy);
  const box = $('policy-facts');
  if (!box) return;
  if (!policy) { box.replaceChildren(); return; }
  const row = (label, text, cls) => {
    const d = document.createElement('div');
    const k = document.createElement('span'); k.textContent = label;
    const v = document.createElement('strong'); v.textContent = text;
    if (cls) v.className = cls;
    d.append(k, v); return d;
  };
  const inSync = status?.in_sync === true;
  const ex = status?.executors ?? {};
  box.replaceChildren(
    row('policy 版本',
      `${status?.desired_generation ?? '—'} → ${status?.applied_generation ?? '—'}`
      + (inSync ? '' : `（${status?.status ?? ''}${status?.deferred_reason ? ' · ' + status.deferred_reason : ''}）`),
      inSync ? 'good' : 'muted'),
    row('执行方 gate / vad / speaker',
      `${ex.gate ?? '—'} / ${ex.vad ?? '—'} / ${ex.speaker ?? '—'}`,
      ex.vad === 'app' && ex.speaker === 'app' ? 'good' : 'muted'),
  );
}

function renderTrigger(v, doorSource) {
  const mode = String(v.mode ?? 'volume');
  const ready = v.profile?.ready === true;
  const note = $('trg-note');
  if (!note) return;
  if (mode === 'feature' && !ready) {
    // ⚠ 这是「门永远关着」的状态，必须说出来：否则使用者会以为自己拍得不对。
    note.className = 'message bad';
    note.textContent = '⚠ 已选拍掌触发，但还没有录入手势——门不会打开。请去 My Voice 页录制。';
  } else if (mode === 'feature') {
    const c = Number(v.profile?.consistency ?? 0);
    note.className = c >= 0.55 ? 'message good' : 'message bad';
    note.textContent = `拍两下手打开「自动转录」。当前模板一致度 ${(c * 100).toFixed(0)}%`
      + `，双拍间隔 ${Math.round(v.profile?.interval_center_ms ?? 0)} ms。`
      + (c < 0.55 ? ' 一致度偏低，建议回 My Voice 删掉离群样本或重录。' : '');
  } else {
    note.className = 'message';
    note.textContent = '按音量阈值开门（现有行为）。切到拍掌触发前请先在 My Voice 录入手势。';
  }
  /**
   * ⭐ 把**那扇门实际听谁的**也说出来。
   * ⚠ 「我选了拍掌」与「门真的改听拍掌了」是两件事：它们之间隔着一条 WS，
   *   而这正是上一版出错的地方——选了拍掌，门却还在按音量开。
   */
  if (doorSource) {
    const want = mode === 'feature' ? 'external' : 'rms';
    const label = doorSource === 'external' ? '拍掌' : '音量';
    if (doorSource !== want) {
      note.className = 'message bad';
      note.textContent += `　⚠ 但前门此刻仍听「${label}」——App 事件还没到，稍候或检查连接。`;
    } else {
      note.textContent += `　（前门当前听「${label}」）`;
    }
  }
}

/**
 * ⛔ 触发方式**没有**独立的切换按钮了：它是 policy 卡里的一个字段，
 *   随「保存策略」一起提交。⚠ 留着一组 tab 就等于留着第二个写入点。
 */

for (const [id] of POLICY_FIELDS) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener('input', markPolicyDirty);
  el.addEventListener('change', markPolicyDirty);
}
$('open-threshold')?.addEventListener('input', () => {
  const n = $('open-number');
  if (n) n.value = Number($('open-threshold').value).toFixed(3);
  markPolicyDirty();
});

$('policy-save')?.addEventListener('click', async () => {
  const btn = $('policy-save');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    // ⭐ 一次完整 PUT（generation+1），⛔ 不是逐字段 setter。
    const result = await putPolicy((p) => { collectPolicy(p); });
    policyDirty = false;
    const applied = result?.status === 'applied';
    setNote($('policy-note'), applied
      ? `已保存（版本 ${result?.desired_generation ?? '—'}）。`
      : `已收下，等段落结束再生效（${result?.status ?? ''}${result?.deferred_reason ? ' · ' + result.deferred_reason : ''}）。`,
    applied ? 'good' : '');
    await refreshTrigger();
  } catch (error) {
    // ⚠ 后端**拒绝**越界值而不是钳制它——所以失败必须原样说出来，⛔ 不替它编一个近似值。
    setNote($('policy-note'), `保存失败，策略原地不动：${error.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('policy-reload')?.addEventListener('click', async () => {
  policyDirty = false;
  setNote($('policy-note'), '', '');
  await refreshTrigger();
});

async function refreshClap() {
  if ($('page-voice')?.hidden !== false) return;
  try {
    renderClap(await request('/clap/state'));
  } catch (error) {
    clapNotice(`读不到拍手状态：${error.message}`);
  }
}

const clapAction = async (fn) => {
  if (clapBusy) return;
  clapBusy = true;
  try { await fn(); } catch (error) { clapNotice(error.message); } finally {
    clapBusy = false;
    await refreshClap();
  }
};

$('cl-start')?.addEventListener('click', () => clapAction(async () => {
  const st = await request('/clap/state');
  const enrolling = st?.value?.enroll?.enrolling === true;
  await clapCall(enrolling ? '/clap/enroll/cancel' : '/clap/enroll/start', {});
}));

$('cl-build')?.addEventListener('click', () => clapAction(async () => {
  const r = await clapCall('/clap/enroll/finish', {});
  const v = r?.value ?? {};
  const c = Number(v.consistency ?? 0);
  // ⚠ 生成成功不等于生成得好：不一致时**当场说出来**，⛔ 不让它安静地留下一个坏模板。
  if (v.verdict === 'inconsistent') {
    clapNotice(`已生成，但样本一致度只有 ${(c * 100).toFixed(0)}%：`
      + '几次拍的节奏差太多，建议删掉离群的几条或重录。');
  } else {
    clapNotice(`✅ 已生成，一致度 ${(c * 100).toFixed(0)}%`, 'good');
  }
}));

$('cl-test')?.addEventListener('click', () => clapAction(async () => {
  clapTesting = !clapTesting;
  await clapCall('/clap/test', { enabled: clapTesting });
}));

$('cl-clear')?.addEventListener('click', () => clapAction(async () => {
  if (!confirm('删除已录的拍手模板？「特征」触发方式将不再开门，需要重新录入。')) return;
  await clapCall('/clap/reset', {});
  clapTesting = false;
}));

/** 每个动作都是「做 → 立刻回读」：⛔ 不猜结果，后端说了算。 */
const voiceAction = async (fn) => {
  if (voiceBusy || voiceTestActive) return;
  voiceBusy = true;
  try { await fn(); } catch (error) { voiceError(error.message); } finally {
    voiceBusy = false;
    await refreshVoice();
  }
};

/** ⚠ `wanted=false` 就是**不留定时器**，⛔ 不是「换个慢一点的心跳」。 */
const setVoicePolling = (wanted) => {
  if (!wanted) { clearInterval(voiceTimer); voiceTimer = null; return; }
  if (voiceTimer !== null) return;
  voiceTimer = setInterval(refreshVoice, 1200);
};

$('vc-start')?.addEventListener('click', () => voiceAction(async () => {
  const st = await request('/speaker/state');
  const isEnrolling = String(st?.value?.mode ?? 'idle') !== 'idle';
  if (isEnrolling) {
    await voiceCall('/speaker/enroll/stop', {});
  } else {
    await voiceCall('/speaker/enroll/start', {});
  }
}));
$('vc-stop')?.addEventListener('click', () => voiceAction(async () => {
  await voiceCall('/speaker/enroll/stop', {});
}));
$('vc-build')?.addEventListener('click', () => voiceAction(async () => {
  const payload = await voiceCall('/speaker/profile/build', {});
  if (payload?.reason === 'not_enough_enrollments') {
    voiceError(`只有 ${payload.have} 段，至少要 ${payload.need} 段`);
  } else {
    await voiceCall('/speaker/threshold/ack', {});
  }
}));
$('vc-test')?.addEventListener('click', async () => {
  if (voiceBusy || voiceTestActive) return;
  voiceTestActive = true;
  const testBtn = $('vc-test');
  const startBtn = $('vc-start');
  const buildBtn = $('vc-build');
  const clearBtn = $('vc-clear');

  if (testBtn) testBtn.disabled = true;
  if (startBtn) startBtn.disabled = true;
  if (buildBtn) buildBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;

  try {
    // 1. 启动测试
    await voiceCall('/speaker/test/start', {});
    let maxScore = -1;
    let userSeen = false;
    let cursor = 0;

    // 2. 5 秒倒计时与持续监测
    for (let remaining = 5; remaining > 0; remaining--) {
      if (testBtn) testBtn.textContent = `测试 (${remaining}s)`;
      voiceNotice(`🎤 请对着手机说话… (剩余 ${remaining} 秒)`);

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          const tl = await request(`/speaker/timeline?after=${cursor}&limit=100`);
          if (tl?.ok) {
            cursor = tl.next ?? cursor;
            if (tl.uservad?.state === 'USER') userSeen = true;
            for (const r of tl.rows ?? []) {
              if (typeof r.similarity === 'number' && r.similarity > maxScore) {
                maxScore = r.similarity;
              }
              if (r.state === 'USER') userSeen = true;
            }
          }
        } catch { /* 忽略瞬时错误 */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // 3. 停止测试
    await voiceCall('/speaker/test/stop', {});

    // 4. 判定结果并更新状态
    const st = await request('/speaker/state');
    const cfg = st?.value?.config ?? {};
    const threshold = Number(cfg.threshold) || 0.40;
    const passed = userSeen || (maxScore >= threshold && maxScore > 0);

    if (passed) {
      // 通过后即更新/激活状态
      await voiceCall('/speaker/threshold/ack', {});
      const scoreStr = maxScore > 0 ? `最高相似度 ${maxScore.toFixed(2)}` : '识别成功';
      voiceNotice(`✅ 测试通过（${scoreStr}）！已激活专属声纹识别。`, 'good');
    } else {
      const scoreStr = maxScore > 0
        ? `最高相似度 ${maxScore.toFixed(2)}（阈值 ${threshold.toFixed(2)}）`
        : '未检测到有效语音';
      voiceNotice(`❌ 未通过测试（${scoreStr}）。请靠近麦克风重新测试，或重录样本。`, 'bad');
    }
  } catch (error) {
    voiceError(`测试出错：${error.message}`);
  } finally {
    voiceTestActive = false;
    if (testBtn) testBtn.textContent = '测试';
    await refreshVoice();
  }
});
$('vc-clear')?.addEventListener('click', () => voiceAction(async () => {
  if (!window.confirm('重置声纹与全部登记样本？\n\n录音会一起删除，之后需要重新录制。')) return;
  await voiceCall('/speaker/profile/clear', {});
  await voiceCall('/speaker/threshold/ack', {});
}));
$('vc-enable')?.addEventListener('click', () => voiceAction(async () => {
  const payload = await voiceCall('/speaker/threshold/ack', {});
  if (payload?.reason === 'profile_missing') voiceError('还没有声纹，先录样本并生成。');
}));

/** ⭐ 一切都定义完了，把换页钩子接上去。⚠ 位置就是它的正确性条件。 */
onPageSelected = (target) => {
  renderVisible();
  if (target === 'voice') { void refreshVoice(); void refreshClap(); }
  else { setVoicePolling(false); setClapPolling(false); }
  if (target === 'settings') void refreshTrigger();
};
onPageSelected(location.hash.slice(1) || 'overview');

window.TermuxOS.ready.then(() => {
  void (async () => {
    // 先完成首屏 REST 基线，再让 resumeLive 建立两条增量连接，避免并发
    // loadTranscripts 让新 cursor 被旧请求覆盖。
    await loadAll();
    await resumeLive('ready');
  })();
});

/**
 * 切页：把新露出来的区域补画一次（隐藏时我们**故意**没有画它），
 * 并且在需要的节奏变了的时候换一条订阅——重连会拿到完整 snapshot，不会漏状态。
 */
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    renderVisible();
    retuneStateSocket();
  });
}

// 测试与诊断用的只读观测点。⚠ 只读：页面行为绝不依赖它。
window.SpeechDebug = {
  domUpdates: () => domUpdates,
  stateVersion: () => stateVersion,
  sockets: () => [stateSocket, transcriptSocket].filter(Boolean).length,
  state: () => ({
    generation: stateConnectionGeneration,
    last_message_at: stateLastMessageAt || null,
    socket: stateSocket ? 'live-or-connecting' : 'offline',
  }),
  transcript: () => ({
    generation: transcriptConnectionGeneration,
    last_message_at: transcriptLastMessageAt || null,
    socket: transcriptSocket ? 'live-or-connecting' : 'offline',
  }),
};

/* ============================================================
   模型架
   ⭐ 这是唯一能取得或删除语音模型的地方。资产包不在 Framework 的 Package 页面里。
   ============================================================ */

/**
 * Model Settings is a logical requirements view. Artifact names, paths and
 * target choices belong to Manager and never become browser-facing copy.
 */
const REQUIREMENT_LABEL = {
  required: '当前需要', alternative: '可切换', optional: '当前不需要',
};
const MODEL_STATE_LABEL = {
  enabled: '已启用', downloaded: '已下载', not_downloaded: '未下载',
  failed: '上次失败', preparing: '准备中', downloading: '下载中',
};

const modelStateText = (item, managerAvailable) => {
  if (item.ready) return { label: '已就绪', cls: 'is-present', detail: '' };
  if (!managerAvailable) return {
    label: '未就绪', cls: 'is-blocked', detail: '模型管理服务暂不可用，稍后可重试。',
  };
  if (item.manager?.state === 'failed') return {
    label: '需要重试', cls: 'is-blocked', detail: item.manager.diagnostics?.last_error ?? '上次操作失败。',
  };
  const state = MODEL_STATE_LABEL[item.manager?.state] ?? '未准备好';
  return { label: state, cls: item.requirement === 'required' ? 'is-blocked' : '',
    detail: item.ready_reason ?? '' };
};

let modelsBusy = false;

function renderModels(data) {
  const list = $('models-list');
  list.replaceChildren();
  const managerAvailable = data.manager?.available === true;
  const managerLink = $('models-manager-link');
  if (managerLink) {
    const path = data.management_path;
    managerLink.hidden = typeof path !== 'string' || !path;
    if (path) managerLink.href = path;
  }

  for (const item of data.requirements ?? []) {
    const row = document.createElement('div');
    const state = modelStateText(item, managerAvailable);
    row.className = `model-row ${state.cls}`;

    const main = document.createElement('div');
    main.className = 'model-main';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = `${item.name} · ${REQUIREMENT_LABEL[item.requirement] ?? item.requirement}`;
    const sub = document.createElement('span');
    sub.className = 'model-state';
    sub.textContent = state.detail ? `${state.label} · ${state.detail}` : state.label;
    const feat = document.createElement('span');
    feat.className = 'model-state';
    feat.textContent = `${item.description} ${item.reason}`;
    main.append(name, sub, feat);
    row.append(main);

    if (managerAvailable && item.actions?.download) {
      const action = document.createElement('button');
      action.type = 'button'; action.className = 'primary';
      action.textContent = item.actions.retry ? '重试' : '下载';
      action.addEventListener('click', () => void modelAction('download', item, action));
      row.append(action);
    }
    if (managerAvailable && item.actions?.use) {
      const action = document.createElement('button');
      action.type = 'button'; action.className = 'primary'; action.textContent = '启用';
      action.addEventListener('click', () => void modelAction('use', item, action));
      row.append(action);
    }
    if (item.manager?.operation?.state && !['complete', 'failed'].includes(item.manager.operation.state)) {
      const progress = document.createElement('span');
      progress.className = 'model-state';
      progress.textContent = item.manager.operation.stage ?? item.manager.operation.state;
      row.append(progress);
    }
    list.append(row);
  }

  const summary = data.summary ?? {};
  const speech = summary.ready
    ? '当前 policy 所需模型已就绪。'
    : `当前需要 ${summary.required_count ?? '—'} 个模型，已就绪 ${summary.ready_count ?? '—'} 个。`;
  setNote($('models-summary'), managerAvailable ? speech
    : `${speech}（${data.manager?.message ?? '模型管理服务暂不可用'}）`, summary.ready ? 'good' : 'bad');
  const freshness = data.manager_catalog ?? {};
  setText($('models-freshness'), freshness.known
    ? `目录状态：${freshness.stale ? '可能较旧' : '新鲜'}；本地模型状态与目录新鲜度分开显示。`
    : '目录状态未知；已安装/运行状态仍按本机事实显示。');
  setNote($('asr-model-dependency'), (data.requirements ?? [])
    .filter((item) => item.feature === 'asr')
    .map((item) => `${item.name}：${REQUIREMENT_LABEL[item.requirement] ?? item.requirement}`)
    .join(' · '), '');
  setNote($('vad-model-hint'), (data.requirements ?? []).find((item) => item.feature === 'vad')?.reason ?? '模型需求按当前 ASR 配置判断。', '');
  setNote($('speaker-model-hint'), (data.requirements ?? []).find((item) => item.feature === 'speaker_activity')?.reason ?? '模型需求按当前 policy 判断。', '');
}

async function modelAction(kind, item, button) {
  if (modelsBusy) return;
  modelsBusy = true;
  button.disabled = true;
  const was = button.textContent;
  const busyLabel = { download: '下载中…', use: '启用中…' };
  const busyNote = {
    download: `正在下载「${item.name}」，大文件可能要一段时间，可以离开这一页。`,
    use: `正在启用「${item.name}」，会先由 Manager 验证实际可用性。`,
  };
  button.textContent = busyLabel[kind];
  setNote($('models-summary'), busyNote[kind], '');
  try {
    const response = await api(`${PKG}/models/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: item.model_id }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      if (payload.degraded) throw new Error(payload.message ?? '模型管理服务暂不可用');
      throw new Error(`${payload.error}${payload.detail ? ` — ${payload.detail}` : ''}`);
    }
    if (payload.operation_id) {
      modelsBusy = false;
      button.disabled = false;
      button.textContent = was;
      void trackOperation(payload.operation_id, item);
      return;
    }
  } catch (error) {
    const verb = { download: '下载', use: '启用' }[kind] ?? kind;
    setNote($('models-summary'), `${verb}失败：${error.message}`, 'bad');
    button.textContent = was;
    button.disabled = false;
    modelsBusy = false;
    return;
  }
  modelsBusy = false;
  await loadModels();
}

const STAGE_TEXT = { resolving: '解析中', downloading: '下载中', verifying: '校验中', done: '完成' };

/**
 * 按阶段跟一个作业。⛔ 不做第二个作业状态机——只是定期问 Manager 一次。
 * ⚠ 有上限：一个永远问不完的轮询比不轮询更糟，它会让页面看起来永远在忙。
 */
async function trackOperation(operationId, item) {
  for (let i = 0; i < 240; i += 1) {
    await new Promise((r) => { setTimeout(r, 2000); });
    let op;
    try {
      const response = await api(`${PKG}/models/operation?operation_id=${encodeURIComponent(operationId)}`);
      op = (await response.json()).operation ?? null;
    } catch { continue; }          // 一次读不到不代表作业没了
    if (!op) continue;
    const stages = Array.isArray(op.stages) ? op.stages : [];
    const idx = stages.indexOf(op.stage);
    const step = idx >= 0 && stages.length ? `第 ${idx + 1}/${stages.length} 步：` : '';
    if (op.state === 'complete') {
      setNote($('models-summary'), `「${item.name}」已完成。`, 'good');
      await loadModels();
      return;
    }
    if (op.state === 'failed') {
      setNote($('models-summary'), `「${item.name}」失败：${op.error ?? '未知原因'}`, 'bad');
      await loadModels();
      return;
    }
    setNote($('models-summary'), `${step}${STAGE_TEXT[op.stage] ?? op.stage ?? op.state}…`, '');
  }
  setNote($('models-summary'), '作业仍在进行，可以稍后刷新查看。', '');
}

async function loadModels() {
  try {
    const response = await api(`${PKG}/models`);
    renderModels(await response.json());
  } catch (error) {
    setNote($('models-summary'), `读取模型状态失败：${error.message}`, 'bad');
  }
}

$('models-refresh').addEventListener('click', () => void loadModels());
void loadModels();

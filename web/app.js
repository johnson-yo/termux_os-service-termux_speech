/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Browser Session routes/WS for live state, listen mode, transcripts, and the four config sections.
 * [OUTPUT]: Three-page navigation, the live poll loop, listen/model safety flows, grouped settings saves,
 *           and a selected-provider VAD overlay driven only by VAD/activity facts (not RMS gate-open state).
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
/** 断句层单段的硬切上限（秒）。柱高按它归一。 */
/** ⚠ 只在读不到 App 的 `hard_cap_ms` 时兜底；⛔ 不是产品默认值。 */
const VAD_HARD_LIMIT_SEC = 12.0;

/** 页面上的 VAD 颜色、图例与状态文字必须来自同一个已选 provider。 */
/**
 * ⭐ 当前**真的在断句**的是谁。唯一来处是 App effective（docs/097 §七）。
 * ⛔ 旧实现从 `speech_input.downstream.vad_mode` / `speaker_activity.vad_mode` /
 *   `vad.config.provider` 三个本包字段里挑——那三个描述的是**已经不在跑**的执行体，
 *   真机上它们与 App 的 effective 早已分家（Header 说 CAM++、Overview 说 FireRedVAD）。
 * ⚠ 读不到时回落 `null` 而不是 `campplus`：一个猜出来的 provider 会让 LIVE
 *   画出一整套属于另一个 provider 的图层，而画面上看不出是猜的。
 */
/**
 * ⭐ docs/099：**断句器永远是 FireRedVAD**。segment 那一层现在回答的是
 *   「要不要开 CAM++ 本人过滤」，⛔ 不是「谁在断句」。
 */
const currentSegment = () => domains.app_pipeline?.effective?.segment ?? null;
const camFilterOn = () => currentSegment() === 'fireredvad_camplus';

/**
 * ⭐ **Overview 的 Flow 与 LIVE：数据源全部换成 App telemetry**（docs/097 §五/§七）。
 *
 * ⚠ 换掉的是这几个：本包的 `rms_gate.current`（真机上 `rms.last_frame_age_ms`
 *   是三个半小时前的最后一帧）、`vad.activity`（那条 VAD 早已不在本包跑）、
 *   `speaker_activity.last_similarity`（同上）、`pipeline.owner`（22 小时前的租约）。
 *   它们**读得出值、类型也对**，于是图照样画得出来——画的是一台停着的机器。
 * ⭐ **视觉一格没改**：60 柱 / 1 秒一柱 / RMS 底层 / gate 细线 / 顶层活动 /
 *   两条阈值虚线 / badge / tooltip，全部保留（任务书 §六 硬要求）。
 *
 * @param rms 旧 `rms_gate` 域，⚠ 只用于兼容隐藏节点，⛔ 不再参与任何判据
 * @param ap  `app_pipeline` 域 —— 本函数**唯一**的事实来源
 */
function renderActivity(rms, pub, cam, pipeline, vad, asr, ap) {
  const eff = ap?.effective ?? null;
  const trigger = eff?.trigger ?? null;
  const provider = eff?.segment ?? null;
  /**
   * ⭐ **FR 永远是断句层**（docs/099 §十七）：LIVE 的 segment telemetry
   *   一律读 FR，⛔ CAM 不再替代它。CAM 开着时只是**额外**显示相似度。
   */
  const fireRedSelected = provider != null;
  const camOn = provider === 'fireredvad_camplus';
  const stopped = trigger === 'stop' || ap?.state === 'stopped' || ap?.ok === false;
  const fresh = ap?.fresh !== false;
  const apTrigger = ap?.trigger ?? {};
  const apSegment = ap?.segment ?? {};
  const apAsr = ap?.asr ?? {};

  /** ⭐ RMS 只有一个来处：App 自报的麦克风电平。 */
  const level = Number.isFinite(Number(ap?.mic?.rms)) ? Number(ap.mic.rms) : 0;
  const listening = ap?.mic?.recording === true;
  const openThreshold = Number.isFinite(apTrigger.threshold) && apTrigger.threshold > 0
    ? apTrigger.threshold : 0.05;

  /**
   * ⭐ 「门开着吗」按 **trigger 的产品语义**回答，⛔ 不再一律拿 RMS 比阈值：
   *   · 直通 = 永远开着（⚠ 再显示"门已开/未开"的阈值判定是在说另一件事）；
   *   · 停止 = 永远关着；
   *   · 音量 / 拍掌 = App 说了算（`admitted`）。
   */
  const gateOpen = stopped ? false
    : trigger === 'passthrough' ? true
      : apTrigger.open === true || apSegment.admitted === true;

  const pct = Math.max(0, Math.min(100, Math.round((level / ACT_LEVEL) * 100)));
  const fill = $('act-fill');
  if (fill) {
    fill.style.width = `${pct}%`;
    fill.className = `meter-fill${level >= 0.02 ? ' live' : ''}`;
  }
  const meter = $('act-meter');
  if (meter) meter.title = `RMS ${level.toFixed(4)}${fresh ? '' : ' · 读数已陈旧'}`;
  setText($('rms-threshold'), openThreshold.toFixed(3));
  setText($('rms-admission'), gateOpen ? 'open · 音频进入断句层' : 'waiting · 只进滚动环');

  const tx = pub?.transcription ?? {};
  /** ⭐ 「有没有人在说话」由**断句层**回答（CAM++ 判 USER / FireRedVAD 判 speech）。 */
  const segmentSpeaking = !stopped && gateOpen && (fireRedSelected
    ? Number(apSegment.vad_probability ?? 0) >= Number(apSegment.vad_threshold ?? 0.5)
    : apSegment.state === 'USER');
  const asrBusy = apAsr.active === true || Number(apAsr.in_flight ?? 0) > 0
    || tx.status === 'incomplete' || tx.active === true;
  const heard = level >= 0.02 || gateOpen;

  const stage = stopped ? '已停止'
    : asrBusy ? '正在识别'
      : segmentSpeaking ? '正在听'
        : heard ? '听到声音'
          : listening ? '待命' : '未在收音';
  V.setBadge($('act-badge'), stage, segmentSpeaking || asrBusy ? 'good' : '');
  setText($('act-hint'), stopped ? '触发层已停止'
    : heard ? '有声音' : (listening ? '安静' : '麦克风未开启'));
  setText($('act-who'), segmentSpeaking
    ? (fireRedSelected ? '检测到语音' : '本人正在说话')
    : (listening && !stopped ? '等待声音' : '—'));

  /** 兼容隐藏节点：⛔ 不再冒充 legacy 的 owner 字符串。 */
  setText($('cam-live'), apSegment.running ? 'live inference' : 'idle');
  setText($('cam-owner'), provider ?? '—');

  /**
   * ⭐ 门被彻底堵住时**必须在 Overview 上说出来**。
   * ⚠ 判据换成 App 的事实：触发=拍掌 而拍掌模板没录（`profile.ready !== true`）。
   *   旧判据读本包的 `rms.gate_blocked`，而那扇门已经不在本包手里。
   */
  /**
   * ⭐ 断句层挂了要**说出来**：这正是使用者问「为何看上去像是已经挂上了一样」的那件事。
   * ⚠ 它与拍掌横幅是**两个独立的原因**，⛔ 不合并成一个槽——两者可以同时成立。
   */
  const stalledBanner = $('ov-segment-stalled');
  if (stalledBanner) {
    const stalled = apSegment.stalled === true;
    stalledBanner.hidden = !stalled;
    if (stalled) {
      const why = apSegment.stall_error ? String(apSegment.stall_error).slice(0, 160) : '未知原因';
      const st = apSegment.worker_health && apSegment.worker_health !== 'healthy'
        ? `（NPU 恢复状态：${apSegment.worker_health}）` : '';
      stalledBanner.textContent = `⚠ 断句层（${apSegment.label ?? '断句'}）图执行失败，`
        + `说话不会有任何反应${st}。App 正在自动重建；若持续不恢复，`
        + `可在设定页手动回收推理进程。原因：${why}`;
    }
  }

  const blockedBanner = $('ov-gate-blocked');
  if (blockedBanner) {
    const blocked = apTrigger.blocked === true;
    blockedBanner.hidden = !blocked;
    if (blocked) {
      blockedBanner.textContent = '⚠ 当前是「拍掌触发」，但还没有录入手势——门不会打开，'
        + '说什么都不会有反应。请去 My Voice 页录制拍掌手势，或到 Settings 切回其它触发方式。';
    }
  }

  /* ── 三层流水线状态条：[触发] -(N%)- [断句](Ns) -(N%)- [转录] ────────────── */
  const nodeRms = $('gn-rms');
  const nodeVad = $('gn-vad');
  const nodeAsr = $('gn-asr');
  const nameVad = nodeVad?.querySelector('.gate-name');
  const labels = ap?.labels ?? {};
  if (nodeRms) setText(nodeRms, labels.trigger ?? '触发');
  if (nameVad) setText(nameVad, labels.segment ?? '断句');
  if (nodeAsr) setText(nodeAsr, labels.asr ?? '转录');

  /**
   * ⭐ 点亮的是「这一层此刻在干活」。
   * ⚠ 停止时后两层一律暗着——⛔ 不许因为 CAM++ 图还挂在内存里就画成 active。
   */
  const triggerActive = !stopped;
  /**
   * ⭐ ⛔ **`running` 不是「在干活」**：它只说执行体线程活着。
   *   真机 SSR 事故里它全程为 true，而链路一帧都没在处理。
   */
  const segmentActive = !stopped && gateOpen
    && apSegment.running === true && apSegment.stalled !== true;
  const asrActive = !stopped && asrBusy;
  if (nodeRms) nodeRms.className = `gate-box${triggerActive && !segmentActive && !asrActive ? ' active' : ''}`;
  if (nodeVad) nodeVad.className = `gate-box${segmentActive && !asrActive ? ' active' : ''}`;
  if (nodeAsr) nodeAsr.className = `gate-box${asrActive ? ' active' : ''}`;

  // 1. 第一段比例：⭐ 触发层"离开门还差多少"。直通/停止没有阈值可比。
  const rmsRatio = trigger === 'passthrough' ? 100
    : stopped ? 0
      : openThreshold > 0 ? Math.round((level / openThreshold) * 100) : 0;
  const elRmsRatio = $('gr-rms');
  if (elRmsRatio) {
    setText(elRmsRatio, trigger === 'passthrough' ? '(直通)' : `(${rmsRatio}%)`);
    elRmsRatio.className = `gate-ratio${rmsRatio >= 100 && !stopped ? ' over-threshold' : ''}`;
  }

  /**
   * ⭐ **断句节点的括号 = 当前 ASR chunk 距硬切还剩多久**（docs/099 §十八）。
   *
   * ⚠ 它以前有两个数据源，而**两个都是死域**：
   *   · CAM 档读 `speaker_activity.automatic_cam_admission.remaining_seconds`
   *     —— 那个对象的每一个字段都是 `null`（那扇 RMS 门早搬进 App，
   *     legacy admission 从没打开过），而 `Number(null)` 是 **0 不是 NaN**
   *     ⇒ 掉进 `'(0s)'` 分支。使用者看到的「一直显示 0」就是这么来的。
   *   · FR 档读 `vad.activity.segment_ms` —— 本包那份 legacy 控制器
   *     `processed_frames: 0`，一帧都没处理过 ⇒ 恒 0。
   * ⭐ 新来源是**活的**：App 自报的 `segmenter.active_ms` 与 `config.hard_cap_ms`。
   * ⛔ 读不到时显示 `—`，**不是 `(0s)`** —— 「不知道」与「还剩 0 秒」是两件事。
   */
  const segmenter = apSegment.segmenter ?? null;
  const hardCapMs = Number(segmenter?.config?.hard_cap_ms);
  const activeMs = Number(segmenter?.active_ms);
  const chunkOpen = segmenter?.active === true;
  /**
   * ⭐ **当前 chunk 已经进行了多久**（秒）——LIVE 的柱高用它。
   * ⚠ 它以前来自本包 legacy 的 `vad.activity.segment_ms`（恒 0）；
   *   现在来自 App 自报的 `segmenter.active_ms`，与 countdown **同一个来源**。
   *   ⛔ 两个来源迟早会各说各的，而症状只是「柱子高度和倒计时对不上」。
   */
  const poolSec = chunkOpen && Number.isFinite(activeMs) ? activeMs / 1000 : 0;
  const elVadCountdown = $('gc-vad');
  if (elVadCountdown) {
    if (stopped || !chunkOpen || !Number.isFinite(hardCapMs) || !Number.isFinite(activeMs)) {
      setText(elVadCountdown, '(—)');
    } else {
      const remainMs = Math.max(0, hardCapMs - activeMs);
      setText(elVadCountdown, `(${(remainMs / 1000).toFixed(1)}s)`);
    }
    elVadCountdown.title = chunkOpen && Number.isFinite(hardCapMs)
      ? `当前 ASR 段落已进行 ${(activeMs / 1000).toFixed(1)}s，硬切上限 ${(hardCapMs / 1000).toFixed(1)}s`
      : '当前没有进行中的 ASR 段落';
  }

  // 3. 第二段比例：CAM++ = similarity/enter；FireRedVAD = probability/threshold。
  const enterThreshold = Number(apSegment.enter_threshold ?? 0.4);
  const exitThreshold = Number(apSegment.exit_threshold ?? 0.35);
  const sim = Number(apSegment.similarity);
  const vadProb = Number(apSegment.vad_probability);
  const vadThreshold = Number(apSegment.vad_threshold ?? 0.5);
  const elCamRatio = $('gr-cam');
  if (elCamRatio) {
    let ratio = null;
    if (stopped) ratio = 0;
    else if (fireRedSelected && Number.isFinite(vadProb)) {
      ratio = vadThreshold > 0 ? Math.round((vadProb / vadThreshold) * 100) : 0;
    } else if (!fireRedSelected && Number.isFinite(sim)) {
      ratio = enterThreshold > 0 ? Math.round((sim / enterThreshold) * 100) : 0;
    }
    setText(elCamRatio, ratio === null ? '(—)' : `(${ratio}%)`);
    elCamRatio.className = `gate-ratio${(ratio ?? 0) >= 100 ? ' over-threshold' : ''}`;
  }

  /** 兼容测试保留节点 */
  const countdown = $('rms-cam-countdown');
  if (countdown) {
    countdown.hidden = true;
    setText(countdown, '');
  }

  /* ── LIVE：一秒一根柱，⛔ 不是一帧一根 ──────────────────────────────────── */
  const bucket = Math.floor(Date.now() / 1000);

  /**
   * ⭐ **产品意义的「语音」**：门开了 **且** 断句层判为「在说话」**且**
   *   这一秒确实有一条新的活动事实。
   * ⚠ 少了第三条，一个静止的状态会被每一秒复制成一根新柱——
   *   画出来的就成了「状态」而不是「发生过的事」。
   * ⭐ 两个 provider 的"新事实"是不同的量：CAM++ 是 App 的 USER 心跳时间戳，
   *   FireRedVAD 是 `vad_frames_run` 计数器。⛔ 不共用一个。
   */
  const userTs = Number(apSegment.last_user_mono_ms);
  if (Number.isFinite(userTs) && userTs > lastUserMonoSeen) {
    lastUserMonoSeen = userTs;
    lastUserAdvanceAtMs = Date.now();
  }
  const vadFrames = Number(apSegment.vad_frames_run);
  if (Number.isFinite(vadFrames) && vadFrames > lastVadFramesSeen) {
    lastVadFramesSeen = vadFrames;
    lastVadAdvanceAtMs = Date.now();
  }
  const userFresh = lastUserAdvanceAtMs > 0
    && (Date.now() - lastUserAdvanceAtMs) < USER_FACT_FRESH_MS;
  const vadFresh = lastVadAdvanceAtMs > 0
    && (Date.now() - lastVadAdvanceAtMs) < USER_FACT_FRESH_MS;

  /**
   * ⭐ **语音柱的判据永远是 FR**（它是断句层）。
   *   开了本人过滤时**再多一个条件**：CAM 判为 USER —— 那正是「只画本人说的话」。
   * ⚠ 两个 provider 的「这一秒真有新事实」用的是**不同的量**：
   *   CAM 看 USER 心跳时间戳，FR 看 `vad_frames_run` 计数器。⛔ 不共用。
   */
  const camSpeechNow = camOn && apSegment.state === 'USER' && userFresh;
  const vadSpeechNow = !stopped && gateOpen
    && Number.isFinite(vadProb) && vadProb >= vadThreshold && vadFresh
    && (!camOn || camSpeechNow);

  const slot = liveSlots.get(bucket) ?? {
    bucket,
    rms: 0,
    threshold: openThreshold,
    trigger,
    gate: false,
    speech: false,
    sim: null,
    camState: null,
    vadProvider: provider,
    camOn,
    vadActive: false,
    vadProb: null,
    vadThreshold,
    vadProgressSec: 0,
    poolSec: 0,
    // ⭐ 柱高归一用**真实的**硬切时长（可调），⛔ 不是一个写死的 12 秒。
    hardLimit: Number.isFinite(hardCapMs) ? hardCapMs / 1000 : VAD_HARD_LIMIT_SEC,
    enter: enterThreshold,
    exit: exitThreshold,
    inferMs: null,
    computeUnit: apSegment.compute_unit ?? null,
    stopped,
  };
  // ⭐ RMS 取该秒**峰值**：开门判据看的就是瞬时越线，均值会把那一下抹平。
  slot.rms = Math.max(Number(slot.rms) || 0, level);
  slot.threshold = openThreshold;
  slot.trigger = trigger;
  slot.stopped = stopped;
  slot.vadProvider = provider;
  slot.vadThreshold = vadThreshold;
  if (Number.isFinite(hardCapMs)) slot.hardLimit = hardCapMs / 1000;
  slot.enter = enterThreshold;
  slot.exit = exitThreshold;
  slot.computeUnit = apSegment.compute_unit ?? slot.computeUnit;
  if (Number.isFinite(Number(apSegment.last_infer_ms))) slot.inferMs = Number(apSegment.last_infer_ms);
  /**
   * ⚠ **trigger=stop 时这一秒不再制造 activity**（任务书 §八）：
   *   已经画出来的旧数据留在窗口里慢慢滑走，⛔ 但当前 bucket 不加新的 gate/语音层。
   */
  if (!stopped) {
    slot.gate = slot.gate || gateOpen;
    slot.vadActive = slot.vadActive || vadSpeechNow;
    slot.poolSec = Math.max(Number(slot.poolSec) || 0, poolSec);
    slot.vadProgressSec = Math.max(Number(slot.vadProgressSec) || 0, poolSec);
    if (Number.isFinite(vadProb)) slot.vadProb = vadProb;
    // ⭐ CAM 的相似度是**附加信息**（开了过滤才有），⛔ 不再替代 FR 的活动层。
    slot.camOn = camOn;
    if (camOn && Number.isFinite(sim)) { slot.sim = sim; slot.camState = apSegment.state; }
  }
  liveSlots.set(bucket, slot);
  // 只留窗口内的；⛔ 不按数组长度裁剪——slot 的身份是**秒**，不是下标。
  for (const key of liveSlots.keys()) {
    if (key <= bucket - LIVE_WINDOW_SECONDS) liveSlots.delete(key);
  }

  const off = $('cam-off');
  if (off) {
    off.hidden = false;
    setText(off, `RMS · FireRedVAD${camOn ? ' · CAM++ 本人过滤' : ''} · 1秒/柱`);
  }

  /**
   * ⭐ badge：**FR 的 telemetry 永远在**（它是断句层），
   *   开了本人过滤时**额外**追加 CAM++ 的相似度与本人/非本人（docs/099 §十七）。
   * ⛔ 不再让 CAM 替代 FR 的 segment telemetry。
   */
  if (stopped) {
    V.setBadge($('cam-now'), `已停止 · RMS ${level.toFixed(4)}`, '');
  } else {
    const frPart = `FR ${Number.isFinite(vadProb) ? vadProb.toFixed(3) : '—'}`;
    const camPart = camOn
      ? ` · CAM++ ${Number.isFinite(sim) ? sim.toFixed(2) : '—'}`
        + ` ${apSegment.state === 'USER' ? '本人' : '非本人'}`
      : '';
    V.setBadge($('cam-now'), `${frPart}${camPart} · RMS ${level.toFixed(4)}`,
      vadSpeechNow ? 'good' : '');
  }

  renderCamBars($('ov-cam-history'), bucket);

  /** 1. 表顶浅蓝色虚线（80px 高度对应 100%） */
  const rmsLine = $('rms-threshold-line');
  if (rmsLine) {
    rmsLine.style.bottom = '80px';
    rmsLine.hidden = trigger === 'passthrough' || stopped;
    rmsLine.title = `触发阈值 (100%): ${openThreshold.toFixed(4)}`;
  }

  /** 2. 橙色虚线：⭐ 永远是 FireRedVAD 的语音概率阈值（它是断句层）。 */
  const camLine = $('cam-threshold');
  if (camLine) {
    if (stopped) {
      camLine.hidden = true;
    } else {
      const h = Math.max(10, Math.min(76, Math.round(vadThreshold * 80)));
      camLine.style.bottom = `${h}px`;
      camLine.hidden = false;
      camLine.title = `FireRedVAD 语音阈值: ${vadThreshold.toFixed(2)}`
        + (camOn ? ` · CAM++ 本人过滤开启（进入阈值 ${enterThreshold.toFixed(2)}）` : '');
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
/**
 * FireRedVAD 的"这一秒真的发生了事"。⭐ 与 CAM++ 用的**不是**同一个量：
 * CAM++ 看 USER 心跳时间戳，FireRedVAD 看 `vad_frames_run` 计数器往前走过。
 * ⛔ 共用一个会让换 provider 之后的第一秒判据永远为假（另一个量根本不动）。
 */
let lastVadFramesSeen = 0;
let lastVadAdvanceAtMs = 0;
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

    const triggerText = ({
      stop: '触发=停止', passthrough: '触发=直通', volume: '触发=音量', clap: '触发=拍掌',
    })[r.trigger] ?? '触发=—';
    const head = `RMS 峰值 ${val.toFixed(4)} (${Math.round(rmsRatio * 100)}%)`;

    if (r.stopped) {
      // ⭐ 停止时不画后两层：⛔ 不许因为图还挂在内存里就画出活动。
      col.title = `${head} · ${triggerText} · 流水线已停止`;
    } else {
      /**
       * ⭐ FireRedVAD 的顶层柱高 = **语音概率**，⛔ 不是 CAM++ 的相似度。
       * ⚠ tooltip 曾经无论选了谁都写「CAM++ 0.00（未计为语音）」——
       *   那不是显示错了一个数，那是在描述另一个模型。
       */
      const prob = Number(r.vadProb);
      const poolSec = Math.max(Number(r.vadProgressSec) || 0, Number(r.poolSec) || 0);
      const hardLimit = Number(r.hardLimit) || 12.0;
      const vadH = Number.isFinite(prob) && r.vadActive
        ? Math.max(4, Math.min(PLOT_H, Math.round(prob * PLOT_H)))
        : 0;
      if (vadH > 0) {
        const vadBar = document.createElement('span');
        vadBar.className = 'bar-firered';
        vadBar.style.height = `${vadH}px`;
        col.appendChild(vadBar);
      }
      const simVal = Number(r.sim);
      const inferText = Number.isFinite(Number(r.inferMs))
        ? ` · infer ${Number(r.inferMs).toFixed(1)}ms${r.computeUnit ? `（${r.computeUnit}）` : ''}` : '';
      col.title = `${head} · ${triggerText} · ${r.gate ? '门已开' : '门未开'}`
        + ` · FireRedVAD ${r.vadActive ? '活动' : '非活动'}`
        + (Number.isFinite(prob) ? ` · probability ${prob.toFixed(3)}（阈值 ${Number(r.vadThreshold ?? 0.5).toFixed(2)}）` : '')
        + (poolSec > 0 ? ` · 本段 ${poolSec.toFixed(1)}s / ${hardLimit.toFixed(1)}s` : '')
        // ⭐ CAM++ 只在开了本人过滤时**追加**，⛔ 不替代上面的 FR 事实。
        + (r.camOn
          ? ` · CAM++ ${Number.isFinite(simVal) ? simVal.toFixed(2) : '—'}`
            + ` ${r.camState === 'USER' ? '本人' : '非本人'}${inferText}`
          : '');
    }
    /**
     * ⭐ **本人过滤开着时，额外画一层「本人」柱**（docs/099 §十七）。
     * ⛔ 它是 FR 活动层之上的**附加**信息，不替代 FR ——
     *   旧实现里 CAM 一开就把 FR 的整条 telemetry 挤掉了。
     */
    if (!r.stopped && r.camOn && r.camState === 'USER' && r.vadActive) {
      const simVal = Number(r.sim);
      const h = Number.isFinite(simVal)
        ? Math.max(8, Math.min(PLOT_H, Math.round(((simVal + 0.2) / 1.0) * PLOT_H)))
        : Math.round(PLOT_H * 0.6);
      const speechBar = document.createElement('span');
      speechBar.className = 'bar-speech';
      speechBar.style.height = `${h}px`;
      col.appendChild(speechBar);
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
  /** ⭐ `app_pipeline` 是这一区的**主**来源；前面几个只喂兼容隐藏节点。 */
  ['overview-activity', ['app_pipeline', 'public', 'speaker_activity', 'vad'],
    () => renderActivity(domains.rms_gate, domains.public, domains.speaker_activity,
      domains.pipeline, domains.vad, domains.asr, domains.app_pipeline)],
  /** Header 六格 + Overview/Settings 六个 selector + 状态字：一个渲染器写完。 */
  ['pipeline-selectors', ['app_pipeline'], () => {
    renderPipeline(domains.app_pipeline ?? null);
    pipelineBind();
  }],
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
  ['overview-asr', ['asr', 'pipeline', 'asr_backend', 'app_pipeline'],
    () => V.renderAsr(domains.asr, domains.pipeline, domains.asr_backend, domains.app_pipeline)],
  ['mem-badge', ['memory'], () => V.renderMemory(domains.memory)],
];

/** 页面区域真正属于哪个产品 tab；隐藏页不进行 DOM 更新。 */
const REGION_PAGES = Object.freeze({
  product: ['overview', 'settings'],
  'overview-activity': ['overview'],
  /** ⭐ Header 在每一页都可见，Settings 里也有三个 selector ⇒ 三页全要更新。 */
  'pipeline-selectors': ['overview', 'settings', 'voice'],
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

/**
 * ⭐ **Header 的六格全部来自 `app_pipeline`**（docs/097 §四）。
 *
 * ⚠ 修的是一件很具体的事：旧实现读 `lifecycle.chain`（本包的链）、`pipeline.owner`
 *   （PipelineLease 的持有者）、`listen.engaged`（手动听写）、`asr.model.selected`
 *   （本包 conf）。这四个字段今天全部描述**已经不在跑**的旧执行体——
 *   真机实录：`lifecycle.chain="stopped"` 而 App pipeline `state="running"`，
 *   `pipeline.owner="speech.vad"` 是 22 小时前的一次租约，
 *   于是同一个页面上 Header 说"语音链已停止 / GATE=VAD"、Overview 说"运行中 / 直通"。
 * ⭐ 读得出值、类型也对、答案安静地错——这一类只能靠**换来源**修，
 *   ⛔ 不能靠在旧来源上再加一层判断。
 */
const updateHeaderStatus = (liveTone = 'ok') => {
  const ap = domains.app_pipeline ?? null;
  const eff = ap?.effective ?? null;
  const labels = ap?.labels ?? {};
  const fresh = ap?.fresh !== false;

  const liveDot = $('st-dot-live');
  if (liveDot) {
    liveDot.className = `status-dot ${liveTone}`;
    liveDot.title = liveTone === 'ok' ? '实时状态正常' : liveTone === 'warn' ? '正在重连' : '连接异常';
  }

  // 1. 语音链 = App pipeline 的运行状态（⛔ 不是本包的 chain）。
  const chainDot = $('st-dot-chain');
  if (chainDot) {
    const state = ap?.state ?? null;
    const tone = !ap || !ap.ok ? 'off'
      : ap.transitioning ? 'warn'
        : state === 'error' ? 'bad'
          : state === 'running' ? 'ok' : 'off';
    chainDot.className = `status-dot ${tone}`;
    chainDot.title = !ap || !ap.ok ? `App pipeline 读不到${ap?.error ? `：${ap.error}` : ''}`
      : ap.transitioning ? 'Pipeline 正在切换'
        : state === 'error' ? `Pipeline 失败：${ap.last_error ?? '未知'}`
          : state === 'running' ? `Pipeline 运行中 · gen ${ap.generation ?? '—'}`
            : 'Pipeline 已停止（触发=停止）';
  }

  // 2. 收音 = App 自报的麦克风事实（⛔ 不从 holders 里猜）。
  const micDot = $('st-dot-mic');
  if (micDot) {
    const mic = ap?.mic ?? null;
    const recording = mic?.recording === true;
    micDot.className = `status-dot ${!mic ? 'off' : recording ? 'ok' : 'off'}`;
    micDot.title = !mic ? '麦克风状态读不到'
      : recording ? `收音中 · ${mic.rate ?? 16000} Hz${mic.rms !== null ? ` · RMS ${Number(mic.rms).toFixed(4)}` : ''}`
        : mic.enabled ? '已请求收音，但 App 报告未在采集' : '未在收音（麦克风已释放）';
  }

  const stale = (node) => { if (node) node.className = 'status-val text-muted'; };
  const setLayer = (id, layer, prefix) => {
    const node = $(id);
    if (!node) return;
    if (!eff) { setText(node, '—'); node.title = `${prefix}：正在读取…`; stale(node); return; }
    setText(node, labels[`${layer}_short`] ?? '—');
    node.title = `${prefix}：${labels[layer] ?? eff[layer]}${
      ap.transitioning ? '（正在切换…）' : ''}${fresh ? '' : ' · 读数已陈旧'}`;
    node.className = `status-val ${!fresh ? 'text-muted' : ap.transitioning ? 'text-warn' : 'text-good'}`;
  };
  // 3/4/5. 三层：⭐ 与 Overview 的三个下拉、Flow 的三个节点、LIVE 的 provider 同源。
  setLayer('st-val-gate', 'trigger', '触发层');
  setLayer('st-val-vad', 'segment', '断句层');
  setLayer('st-val-asr', 'asr', '转录层');
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
    setNote($('connection-note'), '语音服务连接正常', 'good');
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

/**
 * ⚠ **只填语言**。转写模型由 `renderPipeline` 从 App effective 写，
 *   ⛔ 这里不再写第二次：旧 `asr.model` 是本包 conf 里的另一个真相，
 *   而使用者切的是 Pipeline 的第三层。两个写入点会让下拉在两个值之间抖。
 */
function populateDaily(asr) {
  if (dirty.has('daily')) return;
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

const MIC_HOLDER_LABEL = {
  'user.persistent': '你（永久收音）',
  'termux-speech': '语音链',
  'speech.pipeline': '语音流水线',
};
const micHolderLabel = (id) => MIC_HOLDER_LABEL[id] ?? id;

/**
 * ⭐「采集中」回答不了「凭什么在采集」。停链之后麦克风仍然开着是完全可能的——
 * 只要还有别人要它。把持有者原样列出来，那句「我明明停了链」才有地方对质。
 *
 * ⚠ **`undefined` 与 `[]` 必须分开**：投影缺这个字段时 `?? []` 会给出一个合法的空数组，
 *   于是页面理直气壮地写「无人持有 · 已释放」，而麦克风正在录——
 *   ⭐ **「我不知道」不能显示成「没有人」。**
 */
function renderMicHolders(demand) {
  const persistent = demand?.user_persistent;
  $('mic-persistent').textContent = persistent === true ? '开启'
    : persistent === false ? '关闭' : '—';

  if (!demand || !Array.isArray(demand.holders)) {
    $('mic-holders').textContent = '—';
    return;
  }
  $('mic-holders').textContent = demand.holders.length
    ? demand.holders.map(micHolderLabel).join('、')
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
    /**
     * ⭐ **转写模型走 Pipeline PUT**（docs/097 §十五），⛔ 不再写旧 `asr.model`——
     *   那是第二个真相：使用者在 Overview 切的是 Pipeline 的第三层，
     *   而这里曾经改的是本包 conf 里的另一个字段，两者能长期不一致而毫无提示。
     * ⚠ 必须**等 App 的 effective 真的变成它**才算成功：desired 冒充 effective
     *   会让使用者在 App 还在换图（5–7 秒）时以为已经可以说话了。
     */
    async () => {
      const current = domains.app_pipeline?.effective?.asr ?? null;
      if (current === wantedModel) return;
      await pipelineApply('asr-model');
      const deadline = Date.now() + 240_000;
      for (;;) {
        const r = await request('/pipeline');
        const app = (r?.value ?? r)?.app ?? null;
        if (app?.effective?.asr === wantedModel && app?.state !== 'transitioning') {
          setNote($('asr-model-note'),
            `已切换到 ${modelLabel(wantedModel)}，下一段语音起生效。`, 'good');
          return;
        }
        if (app?.state === 'error') throw new Error(app.last_error ?? 'App 切换失败');
        if (Date.now() > deadline) throw new Error('切换超时：App 仍未报告新的 effective');
        await new Promise((resolve) => { setTimeout(resolve, 700); });
      }
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
 * ⛔ 三个旧模式按钮（`btn-mode-auto` / `man-toggle` / `ac-mic`）的处理器已删。
 *
 * ⭐ 理由是**它们绑的节点在页面上根本不存在**——上一轮把三按钮换成三层 selector 时
 *   只删了 DOM，`?.addEventListener` 于是安静地什么都没绑。留着它们的代价不是运行时
 *   开销，是**概念**：那三段代码是"自动转录 / 手动转录 / 停止收音"这套旧模型在源码里
 *   的最后一处完整表述，而这套模型已经被三层 Pipeline 取代。
 * ⚠ 删除前逐个确认过 `index.html` 里 0 处出现这三个 id（⛔ 不是"看起来没人用"）。
 *
 * 现在开/停由 `trigger` 那一层回答：`stop` = 全停，其余三档 = 在跑。
 */

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
/**
 * ⭐ **关闭之后麦克风可能仍然开着，那句提示必须说出来。**
 *
 * 「永久收音」只是需求聚合里的**一项**（`user.persistent`）。语音链在跑时它自己也持有
 * 麦克风，于是关掉这一项完全不会让绿点熄灭——而一句光秃秃的「已关闭」会让这个按钮
 * 在使用者眼里就是坏的（docs/101 §4）。
 */
$('disable').addEventListener('click', () => {
  void runAction('/mic/disable', {}, '永久收音已关闭').then((payload) => {
    const others = payload?.value?.demand?.other_holders
      ?? payload?.demand?.other_holders;
    if (Array.isArray(others) && others.length) {
      setNote($('action-note'),
        `永久收音已关闭；麦克风仍由 ${others.map(micHolderLabel).join('、')} 持有。`
        + '要完全停止采集，把「触发方式」设为「停止」。', 'bad');
    }
  });
});
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
    setNote($('connection-note'), '语音服务连接正常', 'good');
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
  const isTested = Boolean(
    cal.ok && (armed || (profile.fingerprint && localStorage.getItem(`vc_tested_${profile.fingerprint}`) === '1'))
  );

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

/* ---- Settings：策略参数的低频写入路径 ----
   ⚠ 触发方式**不在这里**：它是 Pipeline 的第一层，走 `PUT /pipeline`。
      ⛔ 这张卡只写"参数"（阈值、帧数、窗长、回溯…），不写"选哪一层"。 */
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
  /**
   * ⛔ 不再把本包 `cfg.asr.model` 钉进 `policy.asr.backend`（任务书 §十五）。
   * ⭐ 那个钉法存在的理由是"本包另存了一份模型选择"，而现在**没有第二份**：
   *   转录层由 Pipeline 拥有，`current` 里那个 backend 就是 App 自己刚写的。
   *   原样带过去即可——⚠ 从别处读一个值再钉回来，正是"第二个真相"的造法。
   */
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
    renderTrigger(v);
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
  /**
   * ⛔ `pol-gate-mode`（volume|feature）已删：它是 trigger 的一个**真子集**，
   *   而 trigger 有四档（stop/passthrough/volume/clap）。两个入口写同一件事的结果
   *   使用者亲眼见过——Settings 写着「触发方式=音量」、Overview 写着「直通」、
   *   提示又说「前门听拍掌」，同一页三个答案。
   * ⭐ 触发方式现在由 `set-pipe-trigger` 走 Pipeline PUT，与 Overview 同源。
   */
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
  /** ⛔ `pol-vad-provider` 已删：断句方式由 `set-pipe-segment` 走 Pipeline PUT。 */
  ['pol-seg-head', 'segment', 'head_lookback_ms', 'int'],
  ['pol-seg-tail', 'segment', 'tail_keep_ms', 'int'],
  ['pol-seg-grace', 'segment', 'continuation_grace_ms', 'int'],
  /** ⭐ 硬切时长：两个句尾方案共用，也是阶梯曲线的终点（docs/098）。 */
  ['pol-seg-hardcap', 'segment', 'hard_cap_ms', 'int'],
  ['pol-vad-endmode', 'vad', 'end_mode', 'str'],
  ['pol-vad-hangover', 'vad', 'hangover_ms', 'int'],
  ['pol-vad-hgmax', 'vad', 'hangover_max_ms', 'int'],
  ['pol-vad-hgmin', 'vad', 'hangover_min_ms', 'int'],
  ['pol-vad-pressure', 'vad', 'pressure_start_ms', 'int'],
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
  const ap = domains.app_pipeline ?? null;
  /**
   * ⛔ 「执行方 gate / vad / speaker = app / app / app」这一行已删（任务书 §十六）。
   *   新架构里执行方**只有一个**，向使用者展示 executor ownership 只是在展示
   *   一段过渡期的内部状态；三个都写着 `app` 时它一年到头不会变。
   * ⭐ 换成两条真的会变、也真的有用的事实：Pipeline 的代次与 runtime 来源。
   */
  box.replaceChildren(
    row('policy 版本',
      `${status?.desired_generation ?? '—'} → ${status?.applied_generation ?? '—'}`
      + (inSync ? '' : `（${status?.status ?? ''}${status?.deferred_reason ? ' · ' + status.deferred_reason : ''}）`),
      inSync ? 'good' : 'muted'),
    row('Pipeline generation', String(ap?.generation ?? '—'), ap?.ok ? 'good' : 'muted'),
    row('Runtime source', ap?.ok ? `App${ap.fresh === false ? '（读数已陈旧）' : ''}` : 'App 不可达',
      ap?.ok && ap.fresh !== false ? 'good' : 'muted'),
  );
}

/**
 * 触发层的说明行。
 * ⭐ **判据换成 App effective 的 trigger**（四档），⛔ 不再是 policy 的 `gate.mode`
 *   （两档）。旧实现下 Settings 说"音量"、Overview 说"直通"、这一行说"前门听拍掌"——
 *   三个答案，因为它们读的是三个不同的字段。
 * ⚠ `doorSource` 那条"前门实际听谁"的对账也一并去掉：它对账的是 policy 与本包 RMS 门，
 *   而那扇门已经不在本包手里；⭐ 现在的对账在更上一层——**Pipeline 的 effective 就是
 *   App 真的在跑的东西**，`transitioning` 期间页面会说"正在切换"。
 */
function renderTrigger(v) {
  const note = $('trg-note');
  if (!note) return;
  const ap = domains.app_pipeline ?? null;
  const trigger = ap?.effective?.trigger ?? null;
  const ready = v?.profile?.ready === true;
  if (!trigger) {
    note.className = 'message';
    note.textContent = '正在读取 App 的触发层…';
    return;
  }
  if (trigger === 'clap' && !ready) {
    // ⚠ 这是「门永远关着」的状态，必须说出来：否则使用者会以为自己拍得不对。
    note.className = 'message bad';
    note.textContent = '⚠ 已选拍掌触发，但还没有录入手势——门不会打开。请去 My Voice 页录制。';
  } else if (trigger === 'clap') {
    const c = Number(v?.profile?.consistency ?? 0);
    note.className = c >= 0.55 ? 'message good' : 'message bad';
    note.textContent = `拍两下手打开处理门。当前模板一致度 ${(c * 100).toFixed(0)}%`
      + `，双拍间隔 ${Math.round(v?.profile?.interval_center_ms ?? 0)} ms。`
      + (c < 0.55 ? ' 一致度偏低，建议回 My Voice 删掉离群样本或重录。' : '');
  } else if (trigger === 'volume') {
    note.className = 'message';
    note.textContent = '按音量阈值开门。切到拍掌触发前请先在 My Voice 录入手势。';
  } else if (trigger === 'passthrough') {
    note.className = 'message good';
    note.textContent = '直通：处理门常开，音量阈值与拍掌模板此刻都不参与判定。';
  } else {
    note.className = 'message';
    note.textContent = '已停止：不采集、不断句、不转录。下面的参数改了会保存，但此刻不生效。';
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
      const fp = st?.value?.profile?.fingerprint;
      if (fp) {
        try { localStorage.setItem(`vc_tested_${fp}`, '1'); } catch {}
      }
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
  try {
    const st = await request('/speaker/state');
    const fp = st?.value?.profile?.fingerprint;
    if (fp) localStorage.removeItem(`vc_tested_${fp}`);
  } catch {}
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

/**
 * ⚠ 这里曾为 Audio8 单独写一整套文案（「Audio8 尚未下载」…）。Audio8 退役后一并删除——
 * ⭐ 一个只服务某一个模型的文案分支，下一个模型只会照抄它，而它对那个模型是错的。
 * 名字由 `item.name` 给，⛔ 不在文案里硬编码模型名。
 */
const modelStateText = (item, managerAvailable) => {
  if (item.ready) return { label: '已就绪', cls: 'is-present', detail: '' };
  if (!managerAvailable) return {
    label: '未就绪',
    cls: 'is-blocked', detail: '模型管理服务暂不可用，稍后可重试。',
  };
  if (item.manager?.state === 'failed') return {
    label: '需要重试',
    cls: 'is-blocked', detail: item.manager.diagnostics?.last_error ?? '上次操作失败。',
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
    ? '当前 Pipeline 所需模型已就绪。'
    : `当前 Pipeline 需要 ${summary.required_count ?? '—'} 个模型，已就绪 ${summary.ready_count ?? '—'} 个。`;
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
  /**
   * ⭐ 「谁是当前需要的」由 **App effective 的断句层**回答（任务书 §十八），
   *   ⛔ 不再读本包 conf 的 `vad_provider`——那是第二个真相。
   * ⚠ 另一档写「可切换」而不是沉默：使用者要知道换过去要不要先下模型。
   */
  const effSegment = domains.app_pipeline?.effective?.segment ?? data.config?.vad_provider ?? null;
  // ⭐ FR 永远需要；CAM++ 只在开了本人过滤时需要（docs/099）。
  const camNeeded = effSegment === 'fireredvad_camplus';
  const segmentModelId = effSegment ? 'model.fireredvad' : null;
  const reasonOf = (id) => (data.requirements ?? []).find((item) => item.model_id === id)?.reason ?? null;
  setNote($('vad-model-hint'), segmentModelId
    ? `FireRedVAD 当前需要（唯一断句器） · CAM++ ${camNeeded ? '当前需要（本人过滤）' : '可选'}`
      + (reasonOf(segmentModelId) ? ` · ${reasonOf(segmentModelId)}` : '')
    : '正在读取当前 Pipeline 的断句层…', '');
  const camRuntime = domains.app_pipeline?.segment ?? {};
  setNote($('speaker-model-hint'), camNeeded
    ? `CAM++ 当前需要（本人过滤）${camRuntime.compute_unit ? ` · runtime ${String(camRuntime.compute_unit).toUpperCase()}` : ''}`
      + (reasonOf('model.campplus') ? ` · ${reasonOf('model.campplus')}` : '')
    : `CAM++ 未启用（可开启本人过滤）${reasonOf('model.campplus') ? ` · ${reasonOf('model.campplus')}` : ''}`, '');
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
    const detail = `${verb}失败：${error.message}`;
    setNote($('models-summary'), detail, 'bad');
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

/**
 * ⭐ 最近一次的模型清单。⚠ 模型需求的那两行提示**依赖当前 Pipeline**，
 *   而 Pipeline 随时会变；只在页面加载时算一次，切换之后它就在说上一档的事。
 *   ⛔ 但也不该每次 render 都去打一次 HTTP —— 所以缓存载荷、只重算提示。
 */
let lastModelsData = null;

async function loadModels() {
  try {
    const response = await api(`${PKG}/models`);
    lastModelsData = await response.json();
    renderModels(lastModelsData);
  } catch (error) {
    setNote($('models-summary'), `读取模型状态失败：${error.message}`, 'bad');
  }
}

$('models-refresh').addEventListener('click', () => void loadModels());
void loadModels();


/* ─────────────────────────────────────────────────────────────────────────
 * docs/096/097 · 三层 Pipeline 控件（Overview + Settings 是同一个控件的两个视图）
 *
 * ⭐ **desired 与 effective 是两件事**：下拉框显示的是 App 的 **effective**
 *   （切换途中它仍是旧值），状态字说明正在 transitioning。
 *   ⚠ 提前把下拉切到目标值会让使用者以为已经生效——而 App 还在换图（5–7 秒）。
 * ⭐ 每次切换都 **merge 三层 → 一次 PUT**，⛔ 不分三次调用。
 * ⭐ **一个渲染器写五个位置**（Overview 三个 select、Settings 三个 select、
 *   Header 三格、Flow 三个节点、LIVE 的 provider 语义）。
 *   ⛔ 这不是"把五处改成一样"——是**只留一个写入点**：五处各写各的，
 *   迟早在某个分支上再次分岔，而分岔的那天没人会记得。
 * ───────────────────────────────────────────────────────────────────────── */
/** Overview 顶部与 Settings 里的两组 id。同一层两个节点，⛔ 但只有一个数据源。 */
const PIPE_IDS = {
  trigger: ['pipe-trigger', 'set-pipe-trigger'],
  segment: ['pipe-segment', 'set-pipe-segment'],
  asr: ['pipe-asr', 'asr-model'],
};
const PIPE_CURRENT_IDS = {
  trigger: 'set-trigger-current',
  segment: 'set-segment-current',
  asr: 'set-asr-current',
};
const PIPE_LAYER_LABEL = { trigger: '触发', segment: '断句', asr: '转录' };

/** ⭐ 使用者正在动的那个下拉不许被后台刷新覆盖（⚠ 否则选到一半会被弹回去）。 */
let pipeApplyInFlight = false;
/** 上一次按哪个 segment 渲染过模型需求。⛔ 不重算就会一直说上一档的事。 */
let lastSegmentForModels = null;

/**
 * ⭐ **Pipeline 的唯一渲染器**。输入只有 `app_pipeline` 域，⛔ 没有第二个来源。
 * @param {object|null} ap `domains.app_pipeline`
 */
function renderPipeline(ap) {
  const st = $('pipe-state');
  if (!ap) {
    if (st) { setText(st, '正在读取 App pipeline…'); st.className = 'ov-pipe-state'; }
    return;
  }
  const eff = ap.effective ?? null;
  if (!ap.ok || !eff) {
    if (st) {
      setText(st, ap.error ? `App 不可达：${ap.error}` : 'App 状态未知');
      st.className = 'ov-pipe-state is-bad';
    }
    return;
  }
  // ⭐ 下拉一律跟随 effective，⛔ 不跟随 desired，⛔ 也不在 PUT 在途时被覆盖。
  if (!pipeApplyInFlight) {
    for (const [layer, ids] of Object.entries(PIPE_IDS)) {
      const want = eff[layer];
      if (!want) continue;
      for (const id of ids) {
        const el = $(id);
        if (el && el.value !== want) el.value = want;
      }
    }
  }
  const labels = ap.labels ?? {};
  for (const [layer, id] of Object.entries(PIPE_CURRENT_IDS)) {
    const node = $(id);
    if (!node) continue;
    const running = labels[layer] ?? eff[layer] ?? '—';
    setText(node, ap.transitioning
      ? `当前运行：${running}（正在切换到目标值…）`
      : `当前运行：${PIPE_LAYER_LABEL[layer]} = ${running}`);
  }
  if (st) {
    const transition = ap.transition ? `（${ap.transition}）` : '';
    const text = ap.transitioning ? `切换中${transition}…`
      : ap.state === 'error' ? `失败：${ap.last_error ?? '未知'}`
        : ap.state === 'running' ? `运行中 · gen ${ap.generation ?? '—'}`
          : `已停止 · gen ${ap.generation ?? '—'}`;
    setText(st, ap.fresh === false ? `${text} · 读数已陈旧` : text);
    st.className = `ov-pipe-state ${ap.transitioning ? 'is-transitioning'
      : ap.state === 'error' ? 'is-bad'
        : ap.state === 'running' ? 'is-running' : 'is-stopped'}`;
  }
  // ⭐ Pipeline 变了 ⇒ 模型需求的措辞跟着变（⛔ 不重新打 HTTP，只重算文字）。
  if (lastModelsData && lastSegmentForModels !== eff.segment) {
    lastSegmentForModels = eff.segment;
    try { renderModels(lastModelsData); } catch { /* 区域失败隔离已在上层 */ }
  }

  // CAM++ 参数当前用不用得上，说清楚（⛔ 但不禁用输入：不用≠不能改）。
  // ⭐ CAM++ 参数用不用得上，判据是**本人过滤开没开**，⛔ 不是「谁在断句」。
  const camIdle = $('set-camplus-idle');
  if (camIdle) camIdle.hidden = eff.segment === 'fireredvad_camplus';

  /**
   * ⭐ FireRedVAD 句尾方案的说明行（docs/098）。
   * ⚠ 判据是 **App 报回来的实况**（`segment.segmenter.config.end_mode`），
   *   ⛔ 不是 policy 里那个值——policy 是「我想要什么」，这里要说的是「正在跑什么」。
   *   两者在保存后到下一次对账之间会不同，而那正是使用者需要看见的一段。
   */
  const endHint = $('set-vad-end-hint');
  const endNote = $('vad-end-note');
  const segRt = ap.segment ?? {};
  const sc = segRt.segmenter?.config ?? null;
  if (endHint) {
    endHint.textContent = eff.segment === 'fireredvad'
      ? `当前生效：${sc ? (sc.end_mode === 'hangover' ? '固定悬停' : '阶梯式悬停') : '读取中…'}`
      : '当前断句是 CAM++，这一组此刻不生效；改了仍会保存。';
  }
  if (endNote) {
    if (!sc) {
      endNote.textContent = '';
    } else if (sc.end_mode === 'hangover') {
      endNote.textContent = `句尾 = 最后一个语音帧 + ${sc.hangover_ms} ms。`
        + `⛔ 不回选历史停顿谷：只在真静音或硬切（${sc.hard_cap_ms} ms）处结束。`;
    } else {
      const now = segRt.segmenter?.need_ms_now;
      endNote.textContent = `要求的停顿从 ${sc.hangover_max_ms} ms 阶梯降到 ${sc.hangover_min_ms} ms`
        + `（${sc.pressure_start_ms} ms 起，终点就是硬切 ${sc.hard_cap_ms} ms）`
        + `${Number.isFinite(Number(now)) ? ` · 此刻需要 ${now} ms` : ''}`
        + ` · 刻度 ${sc.step_unit_ms} ms。`;
    }
  }
}

async function pipelineApply(sourceId) {
  const pick = (layer) => {
    for (const id of PIPE_IDS[layer]) {
      if (id === sourceId) return $(id)?.value;
    }
    return null;
  };
  const ap = domains.app_pipeline ?? null;
  const base = ap?.requested ?? ap?.effective ?? {};
  const target = {
    trigger: pick('trigger') ?? base.trigger,
    segment: pick('segment') ?? base.segment,
    asr: pick('asr') ?? base.asr,
  };
  if (!target.trigger || !target.segment || !target.asr) {
    setText($('pipe-state'), '尚未读到当前 Pipeline，请稍候重试。');
    return;
  }
  pipeApplyInFlight = true;
  const st = $('pipe-state');
  if (st) { setText(st, '切换中…'); st.className = 'ov-pipe-state is-transitioning'; }
  setNote($('asr-model-note'), '', '');
  try {
    await request('/pipeline', { method: 'PUT', body: target });
  } catch (error) {
    if (st) { setText(st, `切换失败：${error.message}`); st.className = 'ov-pipe-state is-bad'; }
    setNote($('asr-model-note'), `切换失败：${error.message}`, 'bad');
  } finally {
    pipeApplyInFlight = false;
  }
  // ⚠ 立刻拉一次 App 的真状态；随后由 `app_pipeline` 域接管（⛔ 不另起计时器）。
  try {
    const r = await request('/pipeline');
    const v = r?.value ?? r;
    if (v?.app) {
      domains.app_pipeline = {
        ...(domains.app_pipeline ?? {}),
        ok: true,
        effective: v.app.effective ?? null,
        requested: v.app.requested ?? null,
        state: v.app.state ?? null,
        generation: v.app.generation ?? null,
        transition: v.app.transition ?? null,
        transitioning: v.app.state === 'transitioning' || v.app.transition != null,
      };
      renderPipeline(domains.app_pipeline);
    }
  } catch { /* 域推送会补上，这里失败不必打扰使用者 */ }
}

function pipelineBind() {
  for (const ids of Object.values(PIPE_IDS)) {
    for (const id of ids) {
      const el = $(id);
      if (el && !el.dataset.pipeBound) {
        el.dataset.pipeBound = '1';
        el.addEventListener('change', () => { void pipelineApply(id); });
      }
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  pipelineBind();
  renderPipeline(domains.app_pipeline ?? null);
});

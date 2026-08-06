/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Browser Session routes/WS for live state, listen mode, transcripts, and the four config sections.
 * [OUTPUT]: Three-page navigation, the live poll loop, listen/model safety flows, and grouped settings saves.
 * [POS]: I/O half of the Package page; it renders through `window.SpeechViews` and holds no credentials.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const V = window.SpeechViews;
const { $, qs, number, fixed, setNote, modelLabel } = V;

const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const ACTIVE_PACKAGE_ID = /^[\w.@-]+$/.test(pathPackageId)
  ? pathPackageId
  : 'github.termux-os.service.termux-speech';
const PKG = `/api/packages/${ACTIVE_PACKAGE_ID}`;
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
const PAGES = Object.freeze(['overview', 'settings', 'diagnostics']);
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
      model: item.model ?? null,
      timing: { inference_ms: item.inference_ms ?? null },
      end_gate: { keyword_matched: item.keyword_matched ?? null },
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
const REGIONS = [
  ['overview', ['service', 'input', 'states', 'asr', 'vad', 'kws', 'memory'],
    () => V.renderOverview(domains)],
  ['chain', ['lifecycle', 'capture'],
    () => V.renderChain(domains, { pending: chainPending, failure: activeChainFailure() })],
  ['records', ['records'], () => V.renderRecords(domains.records)],
  ['stages', ['input', 'pcm_stream', 'rms_gate', 'kws', 'vad', 'asr', 'pipeline', 'listen'],
    () => V.renderStages(domains, listenState)],
  ['listen', ['listen'],
    () => V.renderListen(listenState, { pending: listenPending, failure: activeListenFailure() })],
  ['memory', ['memory'], () => V.renderMemory(domains.memory)],
  /**
   * ⭐ 诊断页也按域拆。整块重画时，一次音量变化会把九个渲染器全跑一遍，
   * 而其中八个的数据一个字都没变——真机实测这件事值 18.4% 的一个核
   * （诊断页可见 22.84%，同一页零推送 4.40%）。
   */
  ['diag-summary', ['service', 'input', 'rms_gate', 'kws', 'vad', 'asr', 'states', 'listen'],
    () => V.renderDiagSummary(domains, listenState)],
  ['diag-input', ['input'], () => V.renderInputDiag(domains.input)],
  ['diag-rms', ['rms_gate'], () => V.renderRms(domains.rms_gate)],
  ['diag-kws', ['kws', 'pipeline'], () => V.renderKws(domains.kws, domains.pipeline)],
  ['diag-vad', ['vad'], () => V.renderVad(domains.vad)],
  ['diag-asr', ['asr', 'pipeline'], () => V.renderAsr(domains.asr, domains.pipeline)],
  ['diag-states', ['states'], () => V.renderStates(domains.states)],
  ['diag-memory', ['memory'], () => V.renderMemoryDetail(domains.memory)],
  ['diag-raw', ['service', 'input', 'rms_gate', 'kws', 'vad', 'asr', 'pipeline', 'listen',
    'states', 'memory', 'lifecycle', 'capture', 'records', 'pcm_stream'],
  () => V.renderRaw(domains)],
];

/** 诊断页那一组区域的名字前缀。它们只在诊断页可见时才画。 */
const DIAGNOSTIC_REGION = (name) => name.startsWith('diag-');

const applyDomains = (changed) => {
  if (document.visibilityState !== 'visible') return;
  const touched = new Set(Object.keys(changed ?? {}));
  const diagnosticsVisible = $('page-diagnostics')?.hidden === false;
  for (const [name, needs, render] of REGIONS) {
    // 诊断区很贵，看不见就不画。它在重新可见时由 renderVisible 补上。
    if (DIAGNOSTIC_REGION(name) && !diagnosticsVisible) continue;
    if (!needs.some((domain) => touched.has(domain))) continue;
    render();
    domUpdates += 1;
  }
};

/** 页面重新可见、或切到诊断页时，把全部区域重画一次。 */
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

const closeStateSocket = () => {
  clearTimeout(stateReconnect);
  stateReconnect = null;
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

/**
 * ⭐ 要多快，由**这一页在看什么**决定。
 *
 * 诊断页上有真的音量表，值得 200ms；概览页上那是一行文字，1 秒一次足够。
 * ⚠ 这不只是省流量：真机实测每一次推送都要把渲染进程从空闲里叫醒，而那件事
 * 本身的固定代价比解析和重绘都大（页面零推送时 Chrome 4.24%，5Hz 推送时 9.78%）。
 */
const STATE_INTERVAL_MS = { diagnostics: 200, other: 1000 };
const wantedInterval = () => (
  $('page-diagnostics')?.hidden === false ? STATE_INTERVAL_MS.diagnostics : STATE_INTERVAL_MS.other
);
let socketIntervalMs = null;

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
  stateSocket = socket;
  socket.onopen = () => {
    stateBackoffMs = 1000;
    setNote($('connection-note'), 'Android App API · PCM WS · KWS · VAD · ASR 已连接', 'good');
  };
  socket.onmessage = (event) => {
    try {
      ingestStateFrame(JSON.parse(event.data));
      if (recoveryNeeded && Date.now() >= nextRecoveryAt) {
        nextRecoveryAt = Date.now() + 2000;
        void loadAll();
      }
    } catch (error) {
      V.setBadge($('pipeline-live'), 'ERROR', 'bad');
      setNote($('pipeline-note'), `状态流不可用：${error.message}`, 'bad');
    }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* 已经关了。 */ } };
  socket.onclose = () => {
    if (stateSocket !== socket) return;
    stateSocket = null;
    V.setBadge($('pipeline-live'), 'STALE', 'warn');
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
const forms = Object.freeze({ daily: 'form-daily', detect: 'form-detect', recognition: 'form-recognition' });
for (const [group, id] of Object.entries(forms)) {
  $(id)?.addEventListener('input', () => {
    if (dirty.has(group)) return;
    dirty.add(group);
    setNote($(`${group}-note`), '有未保存的修改。', 'warn');
  });
}
const markSaved = (group) => dirty.delete(group);

function populateDaily(asr, kws) {
  if (dirty.has('daily')) return;
  $('asr-model').value = asr.model ?? 'sensevoice';
  $('asr-language').value = asr.language ?? 'auto';
  $('asr-end-keywords').value = (asr.end_keywords ?? []).join('，');
  $('asr-keyword-enabled').checked = asr.keyword_end_enabled !== false;
  $('kws-cue-enabled').checked = kws.cue_enabled !== false;
}
function populateDetect(rms, kws, vad) {
  if (dirty.has('detect')) return;
  $('open-threshold').value = String(rms.open_threshold);
  $('open-number').value = Number(rms.open_threshold).toFixed(3);
  $('kws-timeout-seconds').value = String(Number(kws.idle_timeout_ms) / 1000);
  $('vad-timeout-seconds').value = String(Number(vad.no_output_timeout_ms) / 1000);
  $('pcm-pool-seconds').value = String(Number(vad.pcm_pool_ms) / 1000);
}
function populateRecognition(asr) {
  if (dirty.has('recognition')) return;
  $('asr-timeout-seconds').value = String(Number(asr.idle_timeout_ms) / 1000);
  $('asr-timeout-enabled').checked = asr.timeout_end_enabled !== false;
}
function renderProfiles(payload) {
  const select = $('active-keyword');
  // ⚠ `replaceChildren` 会把当前选择一起扔掉。只用 `if (!dirty)` 守住**赋值**那一步，
  // 结果是脏表单既不被后端覆盖、也保不住自己的值——守卫反而保证了它被抹掉。
  // 所以先记下现在选的是什么，重建之后再放回去。
  const keep = select.value;
  select.replaceChildren(
    new Option('尚未设置', ''),
    ...(payload?.profiles ?? [])
      .filter((profile) => profile.built)
      .map((profile) => new Option(
        `${profile.display_name} · ${profile.sample_count} samples`, profile.profile_id,
      )),
  );
  const wanted = dirty.has('daily') ? keep : (payload?.config?.active_profile_id ?? '');
  select.value = wanted;
  // 想要的那个唤醒词已经不在列表里（被删了），就如实回到「尚未设置」。
  if (select.value !== wanted) select.value = '';
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

const endKeywords = () => $('asr-end-keywords').value
  .split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);

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
  void saveGroup('daily', $('save-daily'), [
    () => request('/asr/config', {
      method: 'POST',
      body: {
        language: $('asr-language').value,
        end_keywords: endKeywords(),
        keyword_end_enabled: $('asr-keyword-enabled').checked,
      },
    }),
    () => request('/kws/config', {
      method: 'POST',
      body: {
        active_profile_id: $('active-keyword').value || null,
        cue_enabled: $('kws-cue-enabled').checked,
      },
    }),
  ]);
});

$('form-detect').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveGroup('detect', $('save-detect'), [
    () => request('/rms/config', { method: 'POST', body: { open_threshold: Number($('open-number').value) } }),
    () => request('/kws/config', {
      method: 'POST',
      body: { idle_timeout_ms: Number($('kws-timeout-seconds').value) * 1000 },
    }),
    () => request('/vad/config', {
      method: 'POST',
      body: {
        pcm_pool_ms: Number($('pcm-pool-seconds').value) * 1000,
        no_output_timeout_ms: Number($('vad-timeout-seconds').value) * 1000,
      },
    }),
  ]);
});

$('form-recognition').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveGroup('recognition', $('save-recognition'), [
    () => request('/asr/config', {
      method: 'POST',
      body: {
        idle_timeout_ms: Number($('asr-timeout-seconds').value) * 1000,
        timeout_end_enabled: $('asr-timeout-enabled').checked,
      },
    }),
  ]);
});

const bindPair = (rangeId, numberId) => {
  $(rangeId).addEventListener('input', () => { $(numberId).value = Number($(rangeId).value).toFixed(3); });
  $(numberId).addEventListener('input', () => {
    const value = number($(numberId).value);
    if (value !== null) $(rangeId).value = String(Math.min(V.RMS_BAR_MAX, Math.max(0, value)));
  });
};
bindPair('open-threshold', 'open-number');

/* ============================================================
   模型切换
   ⚠ 后端不会在失败时替你换一个模型：切换失败就是失败，旧档位原地不动。
   所以失败时只把真实错误摆出来，并把下拉框拨回后端的真值——
   页面上永远不会出现一句「已经替你换成小模型了」，因为那件事根本没有发生。
   ============================================================ */
const MODEL_RISK = Object.freeze({
  sensevoice: '常驻 HTP 图，实测峰值约 1.2 GB。',
  'qwen3-q4': '走 App /api/asr 端到端，实测峰值约 1.9 GB；首次调用要在设备上编译 EPContext，可能数分钟。',
  'qwen3-q8': '走 App /api/asr 端到端，实测峰值约 2.0 GB；首次调用要在设备上编译 EPContext，可能数分钟。',
});

$('asr-model-apply').addEventListener('click', async () => {
  if (busy) return;
  const wanted = $('asr-model').value;
  const memory = $('mem-avail').textContent;
  const confirmed = window.confirm(
    `切换转写模型到「${modelLabel(wanted)}」？\n\n${MODEL_RISK[wanted] ?? ''}\n\n当前内存：${memory}\n`
    + '⚠ 可用内存不预测大模型能否载入，只作参考。切换失败时会保留原模型。',
  );
  if (!confirmed) return;
  busy = true;
  $('asr-model-apply').disabled = true;
  $('asr-model').disabled = true;
  setNote($('asr-model-note'), '正在切换 / 载入中…', '');
  try {
    await request('/asr/config', { method: 'POST', body: { model: wanted } });
    // 成功也必须回读：前端改了 selected 不等于后端真的换了档位。
    const confirmedConfig = await request('/asr/config');
    $('asr-model').value = confirmedConfig.value.model;
    setNote($('asr-model-note'), confirmedConfig.value.model === wanted
      ? `已切换到 ${modelLabel(confirmedConfig.value.model)}，下一段语音起生效。`
      : `后端保留了 ${modelLabel(confirmedConfig.value.model)}——切换未生效。`,
    confirmedConfig.value.model === wanted ? 'good' : 'bad');
    await loadAll();
  } catch (error) {
    setNote($('asr-model-note'), `切换失败，仍在使用原模型：${error.message}`, 'bad');
    try {
      const current = await request('/asr/config');
      $('asr-model').value = current.value.model;
    } catch { /* 回读也失败时保持现状，下一轮 loadAll 会纠正。 */ }
  } finally {
    busy = false;
    $('asr-model-apply').disabled = false;
    $('asr-model').disabled = false;
  }
});

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
   ⚠ 停链是**真的**释放资源：撤销 Mic 需求、退订唤醒组、卸载 VAD/ASR 常驻。
   服务本身不停，API 仍然可用，随时可以直接开始听写。
   ============================================================ */
$('chain-toggle').addEventListener('click', async () => {
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
  setNote($('chain-note'), started ? '正在释放麦克风并卸载模型…' : '正在启动唤醒组…', '');
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
        : '语音链已启动，唤醒组正在守候。',
      'good',
    );
  } catch (error) {
    chainFailure = error.message;
    chainFailureAt = Date.now();
    setNote($('chain-note'), `操作失败：${error.message}`, 'bad');
  } finally {
    chainPending = null;
    // 不猜结果：状态流会带回后端的真实状态。这里只是把 pending 徽章立刻撤掉。
    V.renderChain(domains, { pending: null, failure: activeChainFailure() });
  }
});

$('listen-toggle').addEventListener('click', async () => {
  if (busy || listenPending) return;
  const engaged = listenState?.engaged === true;
  const requester = listenState?.requester ?? null;
  if (engaged && requester !== 'webui') {
    const confirmed = window.confirm(
      `听写正由「${requester ?? '未知调用方'}」持有（原因：${listenState?.reason ?? '未提供'}）。\n\n`
      + '强行停止会让对方的输入立刻断掉。确定要停止吗？',
    );
    if (!confirmed) return;
  }
  listenPending = engaged ? 'exit' : 'enter';
  listenFailure = null;
  V.renderListen(listenState, { pending: listenPending });
  try {
    const payload = await request('/listen', {
      method: 'POST',
      body: { enabled: !engaged, requester: 'webui', reason: engaged ? 'webui_stop' : 'webui_manual' },
    });
    // 后端的返回值就是它的真实状态，但仍然再读一次 —— 这条按钮的全部意义是「别骗人」。
    listenState = payload.value;
    await readListen();
    setNote($('listen-note'), listenState?.engaged ? '听写已启动。' : '听写已停止。', 'good');
  } catch (error) {
    listenFailure = error.message;
    listenFailureAt = Date.now();
    setNote($('listen-note'), `操作失败：${error.message}`, 'bad');
    // 失败后必须回读：我们不知道后端走到了哪一步，猜一个状态出来正是这条按钮要避免的事。
    await readListen().catch(() => {});
  } finally {
    listenPending = null;
    V.renderListen(listenState, { pending: null, failure: activeListenFailure() });
  }
});

/* ============================================================
   开发者工具（防误触）
   ============================================================ */
$('dev-unlock').addEventListener('change', () => {
  $('force-idle').disabled = !$('dev-unlock').checked;
});
$('force-idle').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('force-idle').disabled = true;
  try {
    await request('/idle', {
      method: 'POST',
      body: { reason: 'developer_ui_speech_idle', requested_by: 'speech_page' },
    });
    setNote($('dev-note'), 'speech.idle 已发送：流水线回到音量门前。', 'good');
    await loadAll();
  } catch (error) {
    setNote($('dev-note'), `speech.idle 失败：${error.message}`, 'bad');
  } finally {
    busy = false;
    $('dev-unlock').checked = false;
    $('force-idle').disabled = true;
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
    $('force-idle').disabled = !$('dev-unlock').checked;
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
$('refresh').addEventListener('click', () => void loadAll());

/* ============================================================
   加载
   ============================================================ */
async function loadAll() {
  if (fullLoadBusy) return false;
  fullLoadBusy = true;
  try {
    const [devices, input, rms, kws, vad, asr, profiles, listen] = await Promise.all([
      request('/devices'),
      request('/speech-input'),
      request('/rms/config'),
      request('/kws/config'),
      request('/vad/config'),
      request('/asr/config'),
      request('/wake-words/profiles'),
      request('/listen'),
    ]);
    listenState = listen.value;
    renderDevices(devices);
    renderAdvanced(input.value);
    populateDaily(asr.value, kws.value);
    populateDetect(rms.value, kws.value, vad.value);
    populateRecognition(asr.value);
    renderProfiles(profiles);
    try {
      await loadTranscripts();
    } catch (error) {
      // 结构不认识是**显式失败**，不是空历史。
      setNote($('tx-note'), error.message, 'bad');
    }
    setNote($('connection-note'), 'Android App API · PCM WS · KWS · VAD · ASR 已连接', 'good');
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

const closeTranscriptSocket = () => {
  clearTimeout(transcriptReconnect);
  transcriptReconnect = null;
  const socket = transcriptSocket;
  transcriptSocket = null;
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try { socket.close(); } catch { /* 已经关了。 */ }
  }
};

const connectTranscriptSocket = () => {
  clearTimeout(transcriptReconnect);
  transcriptReconnect = null;
  // ⛔ 同一时刻只允许一个订阅。
  if (transcriptSocket || document.visibilityState !== 'visible') return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}${PKG}/asr/transcripts/ws?after=${transcriptCursor}`);
  transcriptSocket = socket;
  V.setBadge($('asr-ws'), 'WS CONNECTING', 'warn');
  socket.onopen = () => V.setBadge($('asr-ws'), 'WS LIVE', 'ok');
  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data);
      if (frame.type === 'transcript') rememberTranscripts([frame.value]);
      if (frame.type === 'error') {
        V.setBadge($('asr-ws'), 'WS DEGRADED', 'warn');
        setNote($('tx-note'), `Transcript WS：${frame.error}`, 'bad');
      }
    } catch { /* Ignore a malformed observation and keep the feed alive. */ }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* 已经关了。 */ } };
  socket.onclose = () => {
    if (transcriptSocket !== socket) return;
    transcriptSocket = null;
    V.setBadge($('asr-ws'), 'WS OFFLINE', 'warn');
    if (document.visibilityState !== 'visible') return;
    transcriptReconnect = setTimeout(connectTranscriptSocket, 1000);
  };
};

/**
 * ⭐ 页面隐藏 = **完全静默**（docs/061 §六）：两条 WS 都关掉，不再重绘。
 * 重新可见时不去补隐藏期间的每一个中间事件——直接重新取一份完整 snapshot，
 * 因为状态要的只是「现在是什么」。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connectStateSocket();
    connectTranscriptSocket();
    renderVisible();
  } else {
    closeStateSocket();
    closeTranscriptSocket();
  }
});

/*
 * Dev Runtime 会在 body 上挂一条 `position:fixed` 的横幅，高度随文案换行而变。
 * 一屏布局要「不滚动」，就必须把这块被占掉的高度**量出来**让开——写死一个数字
 * 会在换行数改变的那天悄悄开始遮挡内容，而遮挡是看不见的失败。
 */
const measureOverlay = () => {
  const overlay = [...document.body.children].find((el) => (
    el !== qs('main')
    && el.nodeType === 1
    && getComputedStyle(el).position === 'fixed'
    && el.getBoundingClientRect().top < 4
  ));
  const height = overlay ? Math.ceil(overlay.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--chrome-top', `${height}px`);
};
measureOverlay();
window.addEventListener('resize', measureOverlay);
setTimeout(measureOverlay, 800);

$('tx-copy-latest').addEventListener('click', () => {
  void reportCopy(transcripts.at(-1)?.text ?? '');
});

/**
 * ⛔ 这里曾经是 `setInterval(loadLive, 250)`——每秒四次把整份 28.8KB 的状态
 * 从服务端搬到浏览器再整页重绘一遍，不管有没有东西变。它没有了。
 */
window.TermuxOS.ready.then(() => {
  void loadAll();
  connectStateSocket();
  connectTranscriptSocket();
});

/**
 * 原始 JSON 只在展开时格式化。⚠ `<details>` 折叠时 DOM 节点仍在，
 * 所以「看不见」不等于「不用算」——必须显式地不算。
 */
$('raw-details')?.addEventListener('toggle', (event) => {
  V.setRawOpen(event.target.open, domains);
});

/**
 * 切页：把新露出来的区域补画一次（隐藏时我们**故意**没有画它），
 * 并且在需要的节奏变了的时候换一条订阅——重连会拿到完整 snapshot，不会漏状态。
 */
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    renderVisible();
    if (wantedInterval() !== socketIntervalMs) {
      closeStateSocket();
      connectStateSocket();
    }
  });
}

// 测试与诊断用的只读观测点。⚠ 只读：页面行为绝不依赖它。
window.SpeechDebug = {
  domUpdates: () => domUpdates,
  stateVersion: () => stateVersion,
  sockets: () => [stateSocket, transcriptSocket].filter(Boolean).length,
};

/* ============================================================
   模型架
   ⭐ 这是唯一能取得或删除语音模型的地方。资产包不在 Framework 的 Package 页面里。
   ============================================================ */

const MODEL_STATE = {
  present: { label: '已就绪', cls: 'is-present' },
  missing: { label: '未下载', cls: '' },
  no_variant: { label: '本机没有可用版本', cls: 'is-blocked' },
  no_provider: { label: '资产包未安装', cls: 'is-blocked' },
};

let modelsBusy = false;

function renderModels(data) {
  const list = $('models-list');
  list.replaceChildren();
  for (const item of data.items ?? []) {
    const row = document.createElement('div');
    const state = MODEL_STATE[item.state] ?? { label: item.state, cls: '' };
    row.className = `model-row ${state.cls}`;

    const main = document.createElement('div');
    main.className = 'model-main';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = item.name + (item.required ? '' : '（可选）');
    const sub = document.createElement('span');
    sub.className = 'model-state';
    /**
     * ⚠ 三种「没有」显示成三句不同的话，因为下一步动作完全不同：
     * 能下的就下，本机没有对应硬件版本的下了也没用，资产包没装的要先装包。
     */
    sub.textContent = item.detail ? `${state.label} · ${item.detail}` : state.label;
    main.append(name, sub);
    row.append(main);

    if (item.state === 'no_provider') {
      /**
       * ⭐ 按钮说的是使用者要的那件事，不是它背后要装哪个包。
       * 包名由框架从目录里查出来——页面写死一个包名，迟早会跟目录说不一样的话。
       */
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'primary'; add.textContent = '启用';
      add.addEventListener('click', () => void modelAction('install-provider', item, add));
      row.append(add);
    } else if (item.state === 'missing') {
      const get = document.createElement('button');
      get.type = 'button'; get.className = 'primary'; get.textContent = '下载';
      get.addEventListener('click', () => void modelAction('fetch', item, get));
      row.append(get);
    } else if (item.state === 'present' && item.removable) {
      const drop = document.createElement('button');
      drop.type = 'button'; drop.className = 'ghost'; drop.textContent = '删除';
      drop.addEventListener('click', () => void modelAction('delete', item, drop));
      row.append(drop);
    }
    list.append(row);
  }
  setNote($('models-summary'),
    data.ready ? '模型齐了，可以转写。' : '还缺模型，暂时不能转写。',
    data.ready ? 'good' : 'bad');
}

async function modelAction(kind, item, button) {
  if (modelsBusy) return;
  if (kind === 'delete' && !window.confirm(`删除「${item.name}」？下次要用还得重新下载。`)) return;
  modelsBusy = true;
  button.disabled = true;
  const was = button.textContent;
  const busyLabel = { fetch: '下载中…', delete: '删除中…', 'install-provider': '安装中…' };
  const busyNote = {
    fetch: `正在下载「${item.name}」，大文件可能要几十分钟，可以离开这一页。`,
    delete: `正在删除「${item.name}」…`,
    'install-provider': `正在安装提供「${item.name}」的资产包，装好后这一行会变成「未下载」。`,
  };
  // 下载没有服务端进度事件，所以这里只如实说「在做」，不画一根假的进度条。
  button.textContent = busyLabel[kind];
  setNote($('models-summary'), busyNote[kind], '');
  try {
    const response = await api(`${PKG}/models/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      const extra = payload.candidates?.length ? `（已有的版本：${payload.candidates.join(', ')}）` : '';
      throw new Error(`${payload.error}${payload.detail ? ' — ' + payload.detail : ''}${extra}`);
    }
  } catch (error) {
    const verb = { fetch: '下载', delete: '删除', 'install-provider': '安装' }[kind];
    setNote($('models-summary'), `${verb}失败：${error.message}`, 'bad');
    button.textContent = was;
    button.disabled = false;
    modelsBusy = false;
    return;
  }
  modelsBusy = false;
  /**
   * ⚠ 装资产包是一个**后台作业**，202 只表示已经开始。立刻重读会看到还没变的状态，
   * 而那看起来就像什么都没发生——所以先如实说一句，再隔几秒读一次。
   */
  if (kind === 'install-provider') {
    setNote($('models-summary'), '资产包正在安装，稍后这一行会变成「未下载」。', '');
    setTimeout(() => void loadModels(), 6000);
    return;
  }
  await loadModels();
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

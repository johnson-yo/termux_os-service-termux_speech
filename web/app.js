/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Browser Session routes /speech2/{overview,policy,start,stop,input,history,voices}, the
 *          `speech2` state domain for transcript wakeups, and `memory` for the Header readout.
 * [OUTPUT]: Recovery20B product pages plus compact Header, merged Overview controls and 60-second
 *           LIVE timeline: MEM/ZRAM, Speech, Input, Live state, Trigger, Scene, Models, Sound/RMS,
 *           FireRed and CAM. A raw policy editor exists only under ?dev=1.
 * [POS]: The whole I/O + presentation of the Package page. It renders App-authored facts only; it
 *        never decides model readiness, never stores a second copy of Trigger/Scene, and never holds
 *        credentials.
 * ⭐ Product facts are rendered from the App/service contract; event frames only wake transcript sync.
 *    Voice Input target changes write the current complete policy immediately; My Voices Test is
 *    CAM-only/read-only and shows best voice, score and verdict; its prompt clears on completion.
 *    LIVE has exactly two text slots: current provisional and latest final; History remains the list.
 * [PROTOCOL]: Update this header when changed, then check AGENTS.md and public-files.txt.
 */
const $ = (id) => document.getElementById(id);

const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const ACTIVE_PACKAGE_ID = /^[\w.@-]+$/.test(pathPackageId)
  ? pathPackageId
  : 'github.termux-os.service.termux-speech';
const PKG = `/api/packages/${ACTIVE_PACKAGE_ID}`;
const api = (path, options = {}) => window.TermuxOS.api(path, options);
const DEV = new URLSearchParams(location.search).get('dev') === '1';

/* ------------------------------------------------------------------ helpers */
const setText = (element, text) => {
  if (!element) return false;
  const value = String(text);
  if (element.textContent === value) return false;
  element.textContent = value;
  return true;
};
const setBadge = (element, text, tone = '') => {
  if (!element) return;
  setText(element, text);
  const className = `badge ${tone}`.trim();
  if (element.className !== className) element.className = className;
};
const setNote = (element, text, tone = '') => {
  if (!element) return;
  setText(element, text ?? '');
  const className = `note ${tone}`.trim();
  if (element.className !== className) element.className = className;
};
const setMessage = (element, text, tone = '') => {
  if (!element) return;
  element.hidden = !text;
  setText(element, text ?? '');
  const className = `message ${tone}`.trim();
  if (element.className !== className) element.className = className;
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const clockText = (ms) => {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const SPEAKER_COLOR_CLASSES = Object.freeze(['speaker-color-0', 'speaker-color-1', 'speaker-color-2', 'speaker-color-3']);
const SPEAKER_COLOR_KEY = 'termux-speech.speaker-colors.v1';
function voiceColorMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(SPEAKER_COLOR_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function speakerColor(enrollmentId, matched = true) {
  if (!matched || !enrollmentId) return 'speaker-other';
  const map = voiceColorMap();
  let index = Number(map[enrollmentId]);
  if (!Number.isInteger(index) || index < 0 || index >= SPEAKER_COLOR_CLASSES.length) {
    const used = new Set(Object.values(map).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 4));
    index = SPEAKER_COLOR_CLASSES.findIndex((_, i) => !used.has(i));
    if (index < 0) index = [...enrollmentId].reduce((n, c) => n + c.charCodeAt(0), 0) % 4;
    map[enrollmentId] = index;
    try { localStorage.setItem(SPEAKER_COLOR_KEY, JSON.stringify(map)); } catch { /* colors still render this session */ }
  }
  return SPEAKER_COLOR_CLASSES[index];
}

/** ⭐ Browser Session request; failures are explicit (never an empty value). */
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
    const error = new Error(payload?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.details = Array.isArray(payload?.details) ? payload.details : [];
    throw error;
  }
  return payload;
};
const errorText = (error) => [error?.message, ...(error?.details ?? [])].filter(Boolean).join(' · ');

/* ============================================================
   Host-independent confirmation UI (reused unchanged).
   `window.confirm()` belongs to the browser host; an Android WebView only renders it when the
   host implements WebChromeClient, so destructive actions use this async DOM modal instead.
   ============================================================ */
const confirmInPage = (() => {
  const root = $('tos-confirm');
  const panel = $('tos-confirm-panel');
  const title = $('tos-confirm-title');
  const message = $('tos-confirm-message');
  const cancel = $('tos-confirm-cancel');
  const accept = $('tos-confirm-accept');
  if (!root || !panel || !title || !message || !cancel || !accept) {
    // A stale cached document must fail closed: a destructive action never proceeds without
    // a visible affirmative choice.
    return () => Promise.resolve(false);
  }

  let pending = null;
  let previousFocus = null;
  let historyOwned = false;
  let historyCleanupPending = false;

  const focusable = () => [...panel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
      + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === document.activeElement);

  const restoreFocus = () => {
    const node = previousFocus;
    previousFocus = null;
    if (!node?.isConnected || typeof node.focus !== 'function') return;
    try { node.focus({ preventScroll: true }); } catch { node.focus(); }
  };

  const settle = (answer, fromHistory = false) => {
    const current = pending;
    if (!current) return;
    pending = null;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    panel.classList.remove('is-danger');
    document.body.classList.remove('tos-confirm-open');

    // A history entry lets Android WebView's Back button reach this page and cancel the
    // modal through popstate.  Remove the synthetic entry after a button/backdrop choice.
    if (historyOwned && !fromHistory) {
      historyOwned = false;
      historyCleanupPending = true;
      try { history.back(); } catch { historyCleanupPending = false; }
    }
    restoreFocus();
    current.resolve(Boolean(answer));
  };

  const onKeyDown = (event) => {
    if (!pending) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      settle(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = focusable();
    if (!nodes.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  cancel.addEventListener('click', () => settle(false));
  accept.addEventListener('click', () => settle(true));
  root.addEventListener('click', (event) => {
    if (event.target === root || event.target === root.querySelector('.tos-confirm-backdrop')) {
      settle(false);
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('popstate', () => {
    if (historyCleanupPending) {
      historyCleanupPending = false;
      return;
    }
    if (!historyOwned || !pending) return;
    historyOwned = false;
    settle(false, true);
  });

  return ({
    title: nextTitle = 'Confirm',
    message: nextMessage = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = {}) => {
    // There is deliberately only one outstanding decision.  Callers already serialize their
    // destructive actions; a second request must not steal the first resolver.
    if (pending || historyCleanupPending) return Promise.resolve(false);
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.textContent = String(nextTitle);
    message.textContent = String(nextMessage);
    accept.textContent = String(confirmLabel);
    cancel.textContent = String(cancelLabel);
    panel.classList.toggle('is-danger', danger === true);
    document.body.appendChild(root); // keep the modal above the App's injected escape marker
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tos-confirm-open');
    try {
      history.pushState({ __termuxOsConfirm: true }, '', location.href);
      historyOwned = true;
    } catch {
      historyOwned = false;
    }
    return new Promise((resolve) => {
      pending = { resolve };
      // setTimeout is intentional: it is available on old Android WebView versions too,
      // while focus must still wait until the visible modal has entered the layout.
      setTimeout(() => {
        if (pending) cancel.focus();
      }, 0);
    });
  };
})();


/* ============================================================
   Three product pages: Overview / History / Settings.
   Pages stay in the DOM and only toggle `hidden`, so switching never loses pending UI state.
   ============================================================ */
const PAGES = Object.freeze(['overview', 'history', 'settings']);
/** ⭐ A no-op until everything below is declared (TDZ: see the legacy page, docs/083 H1–H3). */
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
  if (location.hash.slice(1) !== target) history.replaceState(null, '', `${location.search}#${target}`);
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
   Product vocabulary. ⭐ Trigger has exactly three values; Stop is the Speech run state.
   ============================================================ */
const TRIGGER_LABEL = Object.freeze({ stop: 'Stop', passthrough: 'Passthrough', volume: 'Volume' });
const SCENE_LABEL = Object.freeze({
  VOICE_INPUT: 'Voice input', CONVERSATION: 'Conversation', MEDIA_STREAM: 'Media stream',
  AI_BARGE_IN: 'AI barge-in', MEDIA_FILE: 'Media file',
});
/** ⭐ MEDIA scenes carry UNSPECIFIED: no speaker badge is shown for them. */
const ROLE_LABEL = Object.freeze({ USER: 'You', OTHER: 'Other', UNKNOWN: 'Unknown' });
const INPUT_LABEL = Object.freeze({
  SYSTEM_BUILTIN_MIC: 'Built-in microphone', SYSTEM_WIRED_HEADSET_MIC: 'Wired headset microphone',
  SYSTEM_BLUETOOTH_HFP: 'Bluetooth headset (HFP)', SYSTEM_BLUETOOTH_LE_AUDIO: 'Bluetooth LE Audio',
  SYSTEM_USB_AUDIO: 'USB audio (system)', USB_AUDIO_APP_MANAGED: 'USB audio (App-managed)',
  WAV_API: 'Test file (WAV)', WS_LIVE_API: 'Test stream',
});
const STATE_TEXT = Object.freeze({
  running: ['RUNNING', 'ok'], stopped: ['STOPPED', ''], starting: ['STARTING', 'warn'],
  no_input: ['NO INPUT', 'bad'], model_missing: ['MODEL MISSING', 'bad'], unavailable: ['UNAVAILABLE', 'bad'],
});
const INPUT_ERROR_TEXT = Object.freeze({
  FGS_REQUIRED: 'Android only lets the App start the microphone while it is in the foreground — open the Termux-os App once, then press Start again.',
  RECORD_AUDIO_REQUIRED: 'The App has no microphone permission — grant it in Android settings.',
  AUDIO_SOURCE_BUSY: 'Another capture owns the microphone (persistent capture or another source).',
  USB_PERMISSION_REQUIRED: 'USB audio needs permission — accept the Android USB dialog.',
});
const roleBadge = (role) => {
  const label = ROLE_LABEL[role];
  if (!label) return null;
  const b = el('span', `s2-role s2-role-${String(role).toLowerCase()}`, label);
  b.dataset.role = role;
  return b;
};

/* ============================================================
   Page state. ⭐ Trigger/Scene/running/registered voice count always come back from the backend;
   the page keeps only "what the user picked but has not applied yet".
   ============================================================ */
let overview = null;
let live = null;
let busy = false;
let triggerDirty = false;
let sceneDirty = false;
let lastFinals = -1;

/* ============================================================
   Header (reused grid): Speech / Input / Live state / Trigger / Scene / Models.
   ============================================================ */
const dot = (id, tone, title) => {
  const node = $(id);
  if (!node) return;
  node.className = `status-dot ${tone}`;
  node.title = title;
};
const headerVal = (id, text, tone, title) => {
  const node = $(id);
  if (!node) return;
  setText(node, text);
  node.className = `status-val ${tone}`;
  node.title = title;
};
function renderHeader(o) {
  if (!o) return;
  dot('st-dot-speech2', !o.app_reachable ? 'bad' : o.running ? (o.state === 'running' ? 'ok' : 'warn') : 'off',
    !o.app_reachable ? `App Speech unavailable${o.error ? `: ${o.error}` : ''}` : `Speech ${o.state}`);
  const inp = o.input ?? {};
  dot('st-dot-input', inp.source_active ? 'ok' : o.running ? 'bad' : 'off',
    inp.source_active ? `Input: ${INPUT_LABEL[inp.active_source] ?? inp.active_source}` : 'No active input source');
  headerVal('st-val-trigger', TRIGGER_LABEL[o.trigger] ?? '—', o.trigger === 'stop' ? 'text-muted' : 'text-good',
    `Trigger: ${TRIGGER_LABEL[o.trigger] ?? '—'}`);
  headerVal('st-val-scene', o.scene ? (SCENE_LABEL[o.scene] ?? o.scene).split(' ')[0] : '—', 'text-good',
    `Scene: ${SCENE_LABEL[o.scene] ?? o.scene ?? '—'}`);
  headerVal('st-val-models', o.models_ready ? 'Ready' : o.models_installed ? 'Loading' : 'Missing',
    o.models_ready ? 'text-good' : 'text-warn', 'Models (reported by the App)');
}

/* ============================================================
   Overview.
   ============================================================ */
const inputErrorText = (err) => {
  if (!err) return '';
  return INPUT_ERROR_TEXT[err.code] ?? err.message ?? err.code;
};
function renderOverview(o) {
  overview = o;
  renderHeader(o);
  const running = o?.running === true;
  const input = o?.input ?? {};
  const error = !o?.app_reachable || o?.error || o?.state === 'model_missing'
    ? (o?.error ?? 'Speech service is unavailable or not ready.') : '';
  const stateText = error ? 'Error' : running && input.source_active ? 'Listening'
    : running ? 'Error' : 'Stopped';
  setText($('ov-state-text'), stateText);
  const badge = $('ov-state');
  setBadge(badge, stateText.toUpperCase(), stateText === 'Listening' || stateText === 'Ready' ? 'ok'
    : stateText === 'Error' ? 'bad' : '');
  if (badge) badge.dataset.state = stateText.toLowerCase();
  const inp = o?.input ?? {};
  const warns = o?.warnings ?? [];
  setMessage($('ov-warn-input'), warns.includes('no_input_source') || (warns.includes('input_error') && o?.running)
    ? `No audio is coming in. ${inputErrorText(inp.last_error) || 'Check the microphone in Settings.'}`
    : '', 'bad');
  const voices = Array.isArray(voice?.voices) ? voice.voices : [];
  const targetId = o?.selected_target_enrollment_id ?? '';
  const targetVoice = voices.find((v) => v.enrollment_id === targetId);
  const needsVoice = o?.scene === 'VOICE_INPUT' && (!voices.length || !targetVoice);
  setMessage($('ov-warn-voice'), warns.includes('voices_required_for_scene') || needsVoice
    ? 'Choose a voice profile to use Voice input.'
    : '', 'warn');
  setMessage($('ov-error'), error ? 'Speech service is not ready. Open the Termux-os app and try again.' : '', 'bad');
  const start = $('ov-start'); const stop = $('ov-stop');
  if (start) { start.hidden = running; start.disabled = busy || o?.app_reachable !== true || error !== '' || needsVoice; }
  if (stop) { stop.hidden = !running; stop.disabled = busy; }
  const trig = $('ov-trigger');
  if (trig && document.activeElement !== trig) trig.value = o?.trigger_mode === 'passthrough' ? 'passthrough' : 'volume';
  const scene = $('ov-scene');
  if (scene && document.activeElement !== scene && o?.scene && SCENE_LABEL[o.scene]) scene.value = o.scene;
  const wrap = $('ov-target-wrap');
  if (wrap) wrap.hidden = o?.scene !== 'VOICE_INPUT';
  const targetSelect = $('ov-target');
  if (targetSelect && document.activeElement !== targetSelect) {
    const options = [new Option('Choose a voice', ''), ...voices.map((v) => new Option(v.label || v.enrollment_id, v.enrollment_id))];
    targetSelect.replaceChildren(...options);
    targetSelect.value = voices.some((v) => v.enrollment_id === targetId) ? targetId : '';
    targetSelect.hidden = !voices.length;
  }
  const empty = $('ov-target-empty'); if (empty) empty.hidden = voices.length > 0;
  const setup = $('ov-setup-voice'); if (setup) setup.hidden = voices.length > 0;
  const targetName = targetVoice?.label ?? null;
  const descriptions = {
    VOICE_INPUT: targetName ? `Only ${targetName} will be transcribed.` : 'Choose or set up a voice profile to use Voice input.',
    CONVERSATION: 'Everyone is transcribed. Known voices are named.',
    MEDIA_STREAM: 'Speech is transcribed without speaker filtering.',
    AI_BARGE_IN: 'Speech is transcribed with voice-aware interruption behavior.',
    MEDIA_FILE: 'Speech in the media file is transcribed without speaker filtering.',
  };
  setText($('ov-mode-note'), descriptions[o?.scene] ?? 'Choose how speech should be transcribed.');
  renderLiveMeters(o?.activity, o?.scene);
  sampleLive(o);
  renderModels(o?.models);
}

function meterValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Math.max(0, Math.min(1, Number(value))) : null;
}
function setMeter(valueId, barId, value, digits = 2) {
  const v = meterValue(value);
  setText($(valueId), v === null ? '—' : v.toFixed(digits));
  const bar = $(barId);
  if (bar) bar.style.width = `${v === null ? 0 : v * 100}%`;
}
function renderLiveMeters(a, scene) {
  const activity = a ?? {};
  const sound = meterValue(activity.rms);
  const speech = meterValue(activity.vad_probability);
  const match = meterValue(activity.cam_cosine);
  const percent = (v) => v === null ? '—' : `${Math.round(v * 100)}%`;
  setText($('live-rms-value'), percent(sound));
  setText($('live-fr-value'), percent(speech));
  setText($('live-cam-value'), percent(match));
  for (const [id, v] of [['live-rms-meter', sound], ['live-fr-meter', speech], ['live-cam-meter', match]]) {
    const bar = $(id);
    if (bar) bar.style.width = `${v === null ? 0 : v * 100}%`;
  }
  const bestId = activity.cam_best_enrollment_id ?? null;
  const bestLabel = activity.cam_best_enrollment_label
    || voice?.voices?.find((v) => v.enrollment_id === bestId)?.label
    || (bestId ? String(bestId) : 'Other');
  const matched = activity.cam_ownership === 'USER' && Boolean(bestId);
  const who = matched ? bestLabel
    : `${bestLabel} · Not matched${activity.cam_ownership === 'OTHER' && bestLabel !== 'Other' ? ' (Other)' : ''}`;
  setText($('live-cam-name'), who);
  const camName = $('live-cam-name');
  if (camName) camName.title = `Best voice: ${who} · cosine ${percent(match)}`;
  const meter = $('live-cam-meter')?.parentElement;
  if (meter) {
    meter.classList.remove(...SPEAKER_COLOR_CLASSES, 'speaker-other');
    meter.classList.add(speakerColor(bestId, matched));
  }
  const state = activity.running !== true ? 'Waiting for sound…'
    : activity.asr_in_flight ? 'Transcribing…'
      : activity.segment_active ? 'Speaking'
        : activity.gate_open || activity.gate_held ? 'Listening'
          : scene === 'VOICE_INPUT' && overview?.selected_target_enrollment_id
            ? `Listening for ${voice?.voices?.find((v) => v.enrollment_id === overview.selected_target_enrollment_id)?.label ?? 'your voice'}`
            : 'Waiting';
  setText($('live-summary'), state);
  setBadge($('live-now'), activity.running === true ? state.replace('…', '').toUpperCase() : 'STOPPED',
    activity.running === true ? 'ok' : '');
}

/* ============================================================
   LIVE: fixed one-second buckets; empty seconds never reflow.
   Sound/RMS, FireRed probability and CAM cosine retain their actual scales.
   ============================================================ */
const LIVE_WINDOW_SECONDS = 60;
const LIVE_PLOT_HEIGHT = 80;
const liveSlots = new Map();

function sampleLive(o) {
  const a = o?.activity;
  if (!a) return;
  const bucket = Math.floor(Date.now() / 1000);
  const prev = liveSlots.get(bucket);
  const rms = meterValue(a.rms) ?? 0;
  const prob = meterValue(a.vad_probability);
  const cosine = meterValue(a.cam_cosine);
  liveSlots.set(bucket, {
    stopped: a.running !== true,
    trigger: o.trigger,
    rms: Math.max(prev?.rms ?? 0, rms),
    threshold: meterValue(a.threshold) ?? prev?.threshold ?? 0.08,
    gate: (prev?.gate ?? false) || a.gate_open === true || a.gate_held === true,
    vad: (prev?.vad ?? false) || a.vad_active === true,
    probability: prob === null ? prev?.probability ?? null : Math.max(prev?.probability ?? 0, prob),
    cosine: cosine === null ? prev?.cosine ?? null : Math.max(prev?.cosine ?? 0, cosine),
    ownership: a.cam_ownership ?? prev?.ownership ?? null,
    voiceName: a.cam_best_enrollment_label ?? prev?.voiceName ?? null,
  });
  for (const key of liveSlots.keys()) if (key < bucket - LIVE_WINDOW_SECONDS + 1) liveSlots.delete(key);
  renderLiveBars($('live-history'), bucket);
  const line = $('rms-threshold-line');
  if (line) line.hidden = o.trigger !== 'volume';
}

function renderLiveBars(box, nowBucket) {
  if (!box) return;
  const first = nowBucket - (LIVE_WINDOW_SECONDS - 1);
  const cols = [];
  for (let i = 0; i < LIVE_WINDOW_SECONDS; i += 1) {
    const bucket = first + i;
    const r = liveSlots.get(bucket);
    const col = el('i', 'cam-col');
    col.dataset.bucket = String(bucket);
    if (!r) { col.classList.add('cam-col-empty'); cols.push(col); continue; }

    const ratio = r.threshold > 0 ? r.rms / r.threshold : 0;
    const rmsBar = el('span', 'bar-rms');
    rmsBar.style.height = `${Math.max(0, Math.min(LIVE_PLOT_HEIGHT, Math.round(ratio * LIVE_PLOT_HEIGHT)))}px`;
    col.append(rmsBar);
    if (r.stopped) {
      col.title = `RMS ${r.rms.toFixed(4)} · Speech stopped`;
      cols.push(col);
      continue;
    }
    if (r.gate) col.append(el('span', 'bar-gate'));
    if (r.vad && r.probability !== null) {
      const frBar = el('span', 'bar-firered');
      frBar.dataset.probability = r.probability.toFixed(4);
      frBar.style.height = `${Math.round(r.probability * LIVE_PLOT_HEIGHT)}px`;
      col.append(frBar);
    }
    if (r.cosine !== null) {
      const camBar = el('span', `bar-cam${r.ownership === 'USER' ? ' user' : r.ownership === 'OTHER' ? ' other' : ''}`);
      camBar.dataset.cosine = r.cosine.toFixed(4);
      camBar.style.height = `${Math.round(r.cosine * LIVE_PLOT_HEIGHT)}px`;
      col.append(camBar);
    }
    col.title = `RMS ${r.rms.toFixed(4)} (${Math.round(ratio * 100)}% of threshold)`
      + ` · FireRedVAD ${r.vad ? 'speech' : 'silence'}`
      + (r.probability === null ? '' : ` p ${r.probability.toFixed(2)}`)
      + ` · CAM cosine ${r.cosine === null ? '—' : r.cosine.toFixed(3)}`
      + (r.ownership ? ` · ${r.ownership}${r.voiceName ? ` (${r.voiceName})` : ''}` : '');
    cols.push(col);
  }
  box.replaceChildren(...cols);
}

function renderCamGeometry(a) {
  const node = $('pol-cam-geometry');
  if (!node || !a) return;
  const g = a.cam_policy_geometry;
  if (g) {
    setText(node, `Effective fixed HTP geometry: ${g.model_window_ms} ms / ${g.model_step_ms} ms `
      + `(model [1,${g.model_frames},80]); policy declaration `
      + `${g.policy_window_ms ?? '—'} / ${g.policy_step_ms ?? '—'} ms; match=${g.matches}. Geometry is not tunable.`);
    return;
  }
  setText(node, `Effective fixed HTP geometry: ${a.cam_window_ms ?? 1500} ms / ${a.cam_step_ms ?? 300} ms. Geometry is not tunable.`);
}
function renderPolicyRuntime(o) {
  const box = $('policy-runtime-facts');
  if (!box) return;
  const a = o?.activity ?? {};
  const row = (k, v) => { const d = el('div'); d.append(el('span', '', k), el('strong', '', v)); return d; };
  const n = (v, digits = 3) => v === null || v === undefined || !Number.isFinite(Number(v))
    ? '—' : Number(v).toFixed(digits);
  const fr = a.firered_config ?? {};
  const pending = a.firered_pending_config;
  const camMatch = a.cam_thresholds_match === true ? 'matches saved policy'
    : a.cam_thresholds_match === false ? 'waiting for next window/policy boundary' : 'not active yet';
  const frValue = `threshold ${n(fr.speech_threshold)} · smooth ${fr.smooth_frames ?? '—'} · min ${fr.min_speech_frames ?? '—'} · ${fr.end_mode ?? '—'} · hangover ${fr.hangover_ms ?? '—'} / stepped ${fr.hangover_max_ms ?? '—'}→${fr.hangover_min_ms ?? '—'} ms · final ${fr.final_confirm_ms ?? '—'} ms`
    + (pending ? ' · pending batch update' : '');
  const lang = a.asr_language ?? 'auto';
  const langId = a.asr_language_id === null || a.asr_language_id === undefined ? 'not run yet' : `tensor id ${a.asr_language_id}`;
  box.replaceChildren(
    row('Runtime trigger', `${a.trigger_mode ?? '—'} · ${a.volume_state ?? '—'}`),
    row('Runtime Volume', `${a.volume_window_ms ?? '—'} ms · threshold ${n(a.volume_effective_threshold)} · ${a.volume_effective_frames ?? '—'} windows · pre-roll ${a.trigger_pre_roll_ms ?? '—'} ms`),
    row('Runtime CAM', `enter ${n(a.cam_runtime_enter_threshold)} / exit ${n(a.cam_runtime_exit_threshold)} · confirms ${a.cam_runtime_enter_confirm ?? '—'} / ${a.cam_runtime_exit_confirm ?? '—'} · ${camMatch}`),
    row('FireRed effective', frValue),
    row('SenseVoice language', `${lang} · ${langId} · scene ${o?.scene ?? '—'}`),
  );
}

/* ============================================================
   LIVE's two fixed transcript slots (speech2 domain, pushed by /state/ws).
   ⭐ Current is the newest provisional; previous is the newest complete. No transcript list here.
   ============================================================ */
function renderLive(s) {
  live = s;
  const currentText = String(s?.current?.text ?? '').trim();
  const previous = (Array.isArray(s?.live) ? s.live : []).find((row) => row?.complete === true
    && String(row.text ?? '').trim());
  setText($('live-current-half'), currentText || 'Waiting for speech…');
  setText($('live-previous-final'), previous?.text ?? 'No completed sentence yet.');
  const finals = Number(s?.counters?.finals_admitted ?? 0);
  if (finals !== lastFinals) {
    lastFinals = finals;
    if ($('page-history')?.hidden === false) void refreshHistory();
  }
}

/** "Audio 2.4s / ASR 0.25s / Latency 1.2s / Final 2.1s / Speed 9.6×"; -1/null ⇒ "—". */
function metricsText(m) {
  const sec = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? `${(Number(v) / 1000).toFixed(2)}s` : '—');
  const x = Number(m.realtime_x);
  return `Audio ${sec(m.audio_duration_ms)} / ASR ${sec(m.asr_processing_ms)} / `
    + `Latency ${sec(m.speech_end_to_first_text_ms)} / Final ${sec(m.speech_end_to_final_text_ms)} / `
    + `Speed ${Number.isFinite(x) && x > 0 ? `${x.toFixed(1)}×` : '—'}`;
}

let historyItems = [];
let historyCursor = null;
let historyHasMore = false;
let historyLoading = false;
function renderHistoryItem(it) {
  const li = el('li', 'tx-history-item');
  li.dataset.key = it.segment_id ?? '';
  li.dataset.source = it.source_kind ?? '';
  const observed = it.observed_ms === null || it.observed_ms === undefined || it.observed_ms === ''
    ? NaN : Number(it.observed_ms);
  const parsed = Date.parse(it.completed_at ?? it.created_at ?? '');
  const at = Number.isFinite(observed) ? observed : Number.isFinite(parsed) ? parsed : NaN;
  const time = new Date(at);
  const timeLabel = Number.isFinite(time.getTime())
    ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  const meta = it.meta ?? {};
  const matched = meta.matched === true && Boolean(meta.enrollment_id);
  const name = matched && meta.voice_name ? String(meta.voice_name) : 'Other';
  const color = speakerColor(meta.enrollment_id, matched);
  const head = el('div', 'tx-time');
  head.append(el('time', '', timeLabel));
  const mark = el('span', `speaker-mark ${color}`, name);
  mark.dataset.enrollmentId = matched ? meta.enrollment_id : '';
  head.append(mark);
  if (matched && Number.isFinite(Number(meta.cosine))) {
    head.append(el('span', 'speaker-confidence', `${Math.round(Number(meta.cosine) * 100)}%`));
  }
  li.append(head, el('div', 'tx-text', it.text || ''));
  const audioRef = it.audio_ref;
  if (audioRef?.source === 'app' && audioRef.segment_id && it.audio_available === true) {
    const audioWrap = el('div', 'tx-audio-wrap');
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.setAttribute('controlslist', 'nodownload noplaybackrate nofullscreen');
    audio.src = `${PKG}/records/audio?segment_id=${encodeURIComponent(audioRef.segment_id)}`;
    audio.addEventListener('error', () => {
      audio.remove();
      audioWrap.replaceChildren(el('span', 'tx-audio-gone', 'Audio is no longer available'));
    }, { once: true });
    audioWrap.append(audio);
    li.append(audioWrap);
  } else if (audioRef?.source === 'app') {
    li.append(el('span', 'tx-audio-gone', 'Audio expired'));
  }
  const m = meta.metrics;
  if (m) {
    const details = el('details', 'tx-details');
    details.append(el('summary', '', 'Details'), el('div', 'tx-metrics', metricsText(m)));
    li.append(details);
  }
  return li;
}
/** Speech history from live RecordGroups + the existing SQLite archive, in keyset pages. */
async function refreshHistory({ append = false } = {}) {
  if (historyLoading) return;
  historyLoading = true;
  try {
    const query = new URLSearchParams({ limit: '50' });
    if (append && historyCursor) {
      query.set('before_at', historyCursor.before_at);
      query.set('before_id', historyCursor.before_id);
    }
    const value = (await request(`/speech2/history?${query}`))?.value ?? {};
    const items = Array.isArray(value.items) ? value.items : [];
    historyItems = append ? [...historyItems, ...items] : items;
    historyCursor = value.next_cursor ?? null;
    historyHasMore = value.has_more === true;
    const list = $('history-list');
    if (list) list.replaceChildren(...historyItems.map(renderHistoryItem));
    const more = $('history-more');
    if (more) { more.hidden = !historyHasMore; more.disabled = historyLoading; }
    setNote($('history-note'), historyItems.length
      ? `${historyItems.length} saved ${historyItems.length === 1 ? 'sentence' : 'sentences'}`
      : 'No saved transcripts yet.');
  } catch (error) {
    setNote($('history-note'), `History unavailable: ${errorText(error)}`, 'bad');
  } finally {
    historyLoading = false;
    const more = $('history-more'); if (more) more.disabled = false;
  }
}
$('history-more')?.addEventListener('click', () => { void refreshHistory({ append: true }); });

/* ============================================================
   Overview actions. ⭐ Every policy write is GET current → change the selected field → PUT the
   complete policy (the App validates and applies atomically; unknown fields are preserved).
   ============================================================ */
const refreshOverview = async () => {
  try {
    renderOverview((await request('/speech2/overview'))?.value);
  } catch (error) {
    renderOverview({ installed: true, app_reachable: false, error: errorText(error), state: 'unavailable',
      warnings: [], input: {} });
  }
};
const act = async (fn, okText) => {
  if (busy) return;
  busy = true;
  renderOverview(overview ?? {});
  try {
    const text = await fn();
    setMessage($('ov-note'), text ?? okText ?? '', 'good');
  } catch (error) {
    setMessage($('ov-note'), errorText(error), 'bad');
  } finally {
    busy = false;
    await refreshOverview();
  }
};
const startSpeech2 = async () => {
  // ⭐ Say it up front: after a Stop the App reloads its models, which takes about half a minute.
  setMessage($('ov-note'), 'Starting Speech — loading models, this can take about 30 s…', 'warn');
  const r = (await request('/speech2/start', { method: 'POST', body: {} }))?.value;
  if (r?.input_error) return `Speech started, but the input did not: ${inputErrorText(r.input_error)}`;
  return `Speech started · input ${INPUT_LABEL[r?.ring?.active_source] ?? r?.ring?.active_source ?? '—'}`;
};
const stopSpeech2 = async () => {
  await request('/speech2/stop', { method: 'POST', body: {} });
  return 'Speech stopped';
};
const writePolicy = async (mutate) => {
  const doc = (await request('/speech2/policy'))?.value;
  if (!doc?.policy) throw new Error('Speech policy unavailable');
  const next = clone(doc.policy);
  if (!mutate(next)) return { changed: false, revision: doc.revision };
  try {
    const r = (await request('/speech2/policy', { method: 'PUT', body: next }))?.value;
    return { changed: r?.changed === true, revision: r?.revision ?? null };
  } catch (error) {
    // ⭐ No merge: re-read the latest and say what happened.
    await refreshOverview();
    throw new Error(`Policy was not saved (${errorText(error)}); the page now shows the latest policy.`);
  }
};
const applyActivation = () => {
  const mode = $('ov-trigger').value;
  return act(async () => {
    await writePolicy((p) => {
      if (!p.trigger || p.trigger.mode === mode) return false;
      p.trigger.mode = mode;
      return true;
    });
    return 'Activation updated.';
  });
};
const applyMode = () => {
  const scene = $('ov-scene').value;
  return act(async () => {
    await writePolicy((p) => {
      if (!p.segmentation || p.segmentation.scene === scene) return false;
      p.segmentation.scene = scene;
      return true;
    });
    return 'Mode updated.';
  });
};
const applyTarget = () => {
  const id = $('ov-target').value || null;
  return act(async () => {
    await writePolicy((p) => {
      if (!p.segmentation || p.segmentation.target_enrollment_id === id) return false;
      p.segmentation.target_enrollment_id = id;
      return true;
    });
    return id ? 'Target voice updated.' : 'Target voice cleared.';
  });
};
$('ov-trigger')?.addEventListener('change', applyActivation);
$('ov-scene')?.addEventListener('change', applyMode);
$('ov-target')?.addEventListener('change', applyTarget);
$('ov-setup-voice')?.addEventListener('click', () => {
  selectPage('settings');
  requestAnimationFrame(() => {
    $('card-voice')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('vc-label')?.focus({ preventScroll: true });
  });
});
$('ov-start')?.addEventListener('click', () => act(startSpeech2));
$('ov-stop')?.addEventListener('click', () => act(stopSpeech2));

/* ============================================================
   Settings · My Voices — reuse the existing recording card and job polling for N USER voices.
   App /api/speech2/voices is the authority; no single-slot UI state is persisted here.
   ============================================================ */
const VOICE_ERROR_TEXT = Object.freeze({
  MY_VOICE_AUDIO_TIMEOUT: 'No audio reached Speech during the recording — check the input on Overview.',
  MY_VOICE_TOO_LITTLE_SPEECH: 'Too little speech was heard — speak continuously for the whole recording.',
  MY_VOICE_SOURCE_CHANGED: 'The audio source changed during the recording — try again.',
  MY_VOICE_PCM_UNAVAILABLE: 'The recorded audio was no longer available — try again.',
  MY_VOICE_EMBEDDING_FAILED: 'The voice model failed on this recording — try again.',
  MY_VOICE_BUSY: 'Another voice operation is already in progress.',
  MY_VOICE_REFERENCE_INVALID: 'The recording did not produce a valid voice profile — try again.',
  MY_VOICE_BUSY: 'A recording is already in progress.',
  VOICE_NOT_FOUND: 'That voice no longer exists — refresh the list.',
  VOICE_LABEL_INVALID: 'Enter a label of 1–64 characters.',
  VOICE_ID_EXISTS: 'That voice ID is already registered.',
  VOICE_CAPACITY_REACHED: 'The App has reached its 64 voice safety limit.',
  SPEECH2_NOT_RUNNING: 'Speech is not running.',
  SPEECH2_STOPPED_DURING_RECORDING: 'Speech was stopped during the recording.',
});
let voice = null;
let voiceTimer = null;
let voiceBusy = false;
let recordingStartedAt = 0;
const voiceNotice = (message, tone = 'bad') => {
  const box = $('vc-error');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message ?? '';
  box.className = message ? `note ${tone}` : 'note';
};
function renderVoice(v) {
  voice = v;
  const voices = Array.isArray(v?.voices) ? v.voices : [];
  const job = v?.job ?? {};
  const active = job.state === 'recording' || job.state === 'computing' || job.state === 'testing';
  const notice = $('vc-error')?.textContent ?? '';
  if (job.mode === 'test' && !active
      && ['Speak normally for five seconds.', 'Starting listening for the 5-second test…'].includes(notice)) {
    voiceNotice('');
  }
  setBadge($('vc-badge'), `${voices.length} ${voices.length === 1 ? 'voice' : 'voices'}`,
    voices.length ? 'ok' : 'warn');
  setText($('vc-note'), 'Add a voice profile, or test it with a short recording.');
  const add = $('vc-add');
  if (add) add.disabled = active || voiceBusy;
  const facts = $('vc-facts');
  if (facts) {
    const row = (k, val, cls = '') => {
      const d = el('div');
      const s = el('strong', cls, val);
      d.append(el('span', '', k), s);
      return d;
    };
    facts.replaceChildren(
      row('Registered voices', String(voices.length), voices.length ? 'good' : 'muted'),
      row('Voice job', active ? (job.state === 'testing' ? 'Testing' : job.state === 'recording' ? 'Recording' : 'Preparing') : 'Idle', active ? 'warn' : 'muted'),
    );
  }
  const voiceList = $('vc-voices');
  if (voiceList) {
    const rows = voices.map((e) => {
      const li = el('li', 'vc-voice-row');
      li.dataset.enrollmentId = e.enrollment_id;
      const detail = el('div', 'vc-voice-detail');
      const markClass = speakerColor(e.enrollment_id, true);
      detail.append(el('strong', `vc-voice-name speaker-mark ${markClass}`, e.label || e.enrollment_id),
        el('span', 'note', e.built_at_ms ? `Recorded ${clockText(e.built_at_ms)}` : e.enrollment_id));
      const actions = el('div', 'vc-voice-actions');
      const button = (label, action, cls = 'secondary') => {
        const b = el('button', cls, label);
        b.type = 'button'; b.dataset.action = action; b.disabled = active || voiceBusy;
        return b;
      };
      const rerecord = button('Re-record', 'rerecord');
      rerecord.addEventListener('click', () => { void startVoiceRecording(e.enrollment_id); });
      const test = button('Test · 5 s', 'test');
      test.addEventListener('click', () => { void startVoiceTest(e.enrollment_id); });
      const rename = button('Rename', 'rename');
      const remove = button('Delete', 'delete', 'danger');
      actions.append(test, rerecord, rename, remove);
      if (job.mode === 'test' && job.enrollment_id === e.enrollment_id) {
        const tr = job.test_result;
        const score = Number.isFinite(Number(tr?.cosine)) ? `Match ${Math.round(Number(tr.cosine) * 100)}%` : 'Match unavailable';
        const best = tr?.best_voice_name ? `Best ${tr.best_voice_name}` : 'Best voice unavailable';
        const matched = tr?.matched === true;
        detail.append(el('span', `vc-test-result ${matched ? 'good' : tr ? 'bad' : 'warn'}`,
          tr ? `${best} · ${score} · ${matched ? 'Matched' : 'Not matched'}`
            : job.state === 'testing' ? 'Speak naturally for 5 seconds…' : job.error || 'Test in progress…'));
      }
      const editor = el('div', 'vc-rename-editor');
      editor.hidden = true;
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = 64; input.value = e.label || '';
      input.setAttribute('aria-label', `New label for ${e.label || e.enrollment_id}`);
      const save = button('Save', 'save');
      const cancel = button('Cancel', 'cancel');
      rename.addEventListener('click', () => { editor.hidden = false; input.focus(); input.select(); });
      cancel.addEventListener('click', () => { editor.hidden = true; });
      save.addEventListener('click', () => {
        const label = input.value.trim();
        if (!label) { voiceNotice(VOICE_ERROR_TEXT.VOICE_LABEL_INVALID); return; }
        void changeVoice('PATCH', { enrollment_id: e.enrollment_id, label }, 'Voice renamed.');
      });
      remove.addEventListener('click', async () => {
        const ok = await confirmInPage({ title: `Delete ${e.label || e.enrollment_id}?`,
          message: 'This removes only this voice. Other registered voices remain available.',
          confirmLabel: 'Delete', danger: true });
        if (ok) void changeVoice('DELETE', { enrollment_id: e.enrollment_id }, 'Voice deleted.');
      });
      editor.append(input, save, cancel);
      li.append(detail, actions, editor);
      return li;
    });
    voiceList.replaceChildren(...rows);
  }
  const list = $('vc-clips');
  if (list) {
    const items = [];
    if (job.state && job.state !== 'idle') {
      const li = el('li');
      const header = el('div', 'clip-header');
      const secs = Math.round((Number(job.duration_ms) || 0) / 1000);
      let text;
      if (job.state === 'recording') {
        const left = Math.max(0, secs - Math.floor((Date.now() - recordingStartedAt) / 1000));
        text = `Recording ${secs} s — keep speaking${recordingStartedAt ? ` (${left} s left)` : ''}`;
      } else if (job.state === 'testing') text = `Testing ${job.enrollment_id ?? 'voice'} · speak naturally for 5 s…`;
      else if (job.state === 'computing') text = 'Building your voice profile…';
      else if (job.state === 'failed') text = `Failed: ${VOICE_ERROR_TEXT[job.error] ?? job.error}`;
      else if (job.state === 'done') text = `Saved · ${job.voiced_windows ?? 0} voiced windows from ${secs} s`;
      else text = job.state;
      const t = el('span', `clip-title${job.state === 'failed' ? ' drop' : ''}`, text);
      header.append(t);
      li.dataset.state = job.state;
      li.append(header);
      items.push(li);
    }
    list.replaceChildren(...items);
    list.dataset.state = job.state ?? 'idle';
  }
  if (overview) renderOverview(overview);
  clearTimeout(voiceTimer);
  if (active) voiceTimer = setTimeout(refreshVoice, 1000);
}
async function refreshVoice() {
  try {
    renderVoice((await request('/speech2/voices'))?.value);
  } catch (error) {
    voiceNotice(`Voices unavailable: ${errorText(error)}`);
  }
}
async function startVoiceRecording(id = null) {
  if (voiceBusy) return;
  const label = id ? null : $('vc-label')?.value?.trim();
  if (!id && !label) { voiceNotice(VOICE_ERROR_TEXT.VOICE_LABEL_INVALID); return; }
  voiceBusy = true;
  voiceNotice('');
  renderVoice(voice);
  try {
    // ⭐ Recording needs Speech2 running with a live input; start it rather than fail.
    if (overview?.running !== true || overview?.input?.source_active !== true) {
      voiceNotice('Starting Speech for the recording — this can take about 30 s…', 'warn');
      const r = (await request('/speech2/start', { method: 'POST', body: {} }))?.value;
      if (r?.input_error) throw new Error(inputErrorText(r.input_error));
      voiceNotice('');
    }
    const durationMs = Number($('vc-duration')?.value) || 8000;
    const route = id ? '/speech2/voices/record' : '/speech2/voices';
    const body = id ? { enrollment_id: id, duration_ms: durationMs } : { label, duration_ms: durationMs };
    const v = (await request(route, { method: 'POST', body }))?.value;
    if (!id) $('vc-label').value = '';
    recordingStartedAt = Date.now();
    voiceBusy = false;
    renderVoice(v);
  } catch (error) {
    voiceBusy = false;
    voiceNotice(VOICE_ERROR_TEXT[error?.message] ?? errorText(error));
    renderVoice(voice);
  } finally {
    void refreshOverview();
  }
}
$('vc-add')?.addEventListener('click', () => { void startVoiceRecording(); });
async function startVoiceTest(id) {
  if (voiceBusy) return;
  voiceBusy = true;
  voiceNotice('');
  renderVoice(voice);
  try {
    await refreshOverview();
    if (overview?.running !== true || overview?.input?.source_active !== true) {
      voiceNotice('Starting listening for the 5-second test…', 'warn');
      const r = (await request('/speech2/start', { method: 'POST', body: {} }))?.value;
      if (r?.input_error) throw new Error(inputErrorText(r.input_error));
    }
    voiceNotice('Speak normally for five seconds.', 'warn');
    recordingStartedAt = Date.now();
    renderVoice((await request('/speech2/voices/test', {
      method: 'POST', body: { enrollment_id: id },
    }))?.value);
  } catch (error) {
    voiceNotice(VOICE_ERROR_TEXT[error?.message] ?? errorText(error));
  } finally {
    voiceBusy = false;
    renderVoice(voice);
    void refreshOverview();
  }
}
async function changeVoice(method, body, success) {
  if (voiceBusy) return;
  voiceBusy = true;
  renderVoice(voice);
  try {
    renderVoice((await request('/speech2/voices/item', { method, body }))?.value);
    voiceNotice(success, 'good');
  } catch (error) {
    voiceNotice(errorText(error));
  } finally {
    voiceBusy = false;
    renderVoice(voice);
    void refreshOverview();
  }
}

/* ============================================================
   Settings · Speech2 policy. ⭐ Each editable control maps to a policy field consumed by App runtime.
   ============================================================ */
const POLICY_SCHEMA_VERSION = 4;
let policyDirty = false;
const POLICY_CONTROL_IDS = [
  'pol-trigger-mode', 'pol-volume-window', 'pol-volume-threshold', 'pol-volume-frames', 'pol-pre-roll',
  'pol-cam-enter', 'pol-cam-exit', 'pol-cam-enter-confirm', 'pol-cam-exit-confirm',
  'pol-vad-threshold', 'pol-vad-smooth', 'pol-vad-min-speech', 'pol-vad-end-mode',
  'pol-vad-hangover', 'pol-vad-hangover-max', 'pol-vad-hangover-min', 'pol-vad-pressure',
  'pol-vad-final-confirm', 'pol-vad-half-resume', 'pol-asr-language',
];
const putControl = (id, value) => { if ($(id) && value !== undefined && value !== null) $(id).value = String(value); };
function fillPolicy(doc) {
  const p = doc?.policy;
  if (!p) return;
  if (!policyDirty) {
    putControl('pol-trigger-mode', p.trigger?.mode);
    putControl('pol-volume-window', p.volume?.rms_window_ms);
    putControl('pol-volume-threshold', p.volume?.threshold);
    putControl('pol-volume-range', Math.min(0.2, Number(p.volume?.threshold) || 0.08));
    putControl('pol-volume-frames', p.volume?.frames);
    putControl('pol-pre-roll', p.trigger?.pre_roll_ms);
    putControl('pol-cam-enter', p.cam?.enter_threshold);
    putControl('pol-cam-exit', p.cam?.exit_threshold);
    putControl('pol-cam-enter-confirm', p.cam?.enter_confirm);
    putControl('pol-cam-exit-confirm', p.cam?.exit_confirm);
    putControl('pol-vad-threshold', p.vad?.speech_threshold);
    putControl('pol-vad-smooth', p.vad?.smooth_frames);
    putControl('pol-vad-min-speech', p.vad?.min_speech_frames);
    putControl('pol-vad-end-mode', p.vad?.end_mode);
    putControl('pol-vad-hangover', p.vad?.hangover_ms);
    putControl('pol-vad-hangover-max', p.vad?.hangover_max_ms);
    putControl('pol-vad-hangover-min', p.vad?.hangover_min_ms);
    putControl('pol-vad-pressure', p.vad?.pressure_start_ms);
    putControl('pol-vad-final-confirm', p.vad?.final_confirm_ms);
    putControl('pol-vad-half-resume', p.vad?.half_resume_speech_ms);
    putControl('pol-asr-language', p.asr?.language);
  }
  const facts = $('policy-facts');
  if (facts) {
    const row = (k, v) => { const d = el('div'); d.append(el('span', '', k), el('strong', '', v)); return d; };
    const schemaOk = p.schema_version === POLICY_SCHEMA_VERSION;
    facts.replaceChildren(
      row('Policy revision', String(doc.revision ?? '—')),
      row('Schema', schemaOk ? `v${p.schema_version}` : `v${p.schema_version} (page knows v${POLICY_SCHEMA_VERSION})`),
      row('Saved ASR language', String(p.asr?.language ?? '—')),
      row('CAM geometry', `${p.cam?.window_ms ?? '—'} / ${p.cam?.step_ms ?? '—'} ms · fixed by HTP shape`),
    );
  }
}
async function loadPolicy() {
  try {
    fillPolicy((await request('/speech2/policy'))?.value);
  } catch (error) {
    setMessage($('policy-note'), `Policy unavailable: ${errorText(error)}`, 'bad');
  }
}
for (const id of POLICY_CONTROL_IDS) {
  $(id)?.addEventListener('input', () => { policyDirty = true; });
  $(id)?.addEventListener('change', () => { policyDirty = true; });
}
$('pol-volume-range')?.addEventListener('input', (event) => {
  policyDirty = true;
  $('pol-volume-threshold').value = event.target.value;
});
$('pol-volume-threshold')?.addEventListener('input', (event) => {
  const v = Number(event.target.value);
  if (Number.isFinite(v)) $('pol-volume-range').value = String(Math.min(0.2, v));
});
$('policy-reload')?.addEventListener('click', async () => {
  policyDirty = false;
  await loadPolicy();
  setMessage($('policy-note'), 'Changes discarded.', '');
});
$('policy-save')?.addEventListener('click', async () => {
  const readNumber = (id, label) => {
    const node = $(id);
    if (!node || node.value.trim() === '') throw new Error(`${label} is required`);
    const value = Number(node.value);
    if (!Number.isFinite(value) || node.validity.badInput || node.validity.rangeUnderflow
      || node.validity.rangeOverflow || node.validity.stepMismatch) {
      throw new Error(`${label} is outside its allowed range/step`);
    }
    return value;
  };
  try {
    const v = {
      triggerMode: $('pol-trigger-mode').value,
      rmsWindow: readNumber('pol-volume-window', 'RMS window'),
      threshold: readNumber('pol-volume-threshold', 'Volume threshold'),
      volumeFrames: readNumber('pol-volume-frames', 'Consecutive windows'),
      preRoll: readNumber('pol-pre-roll', 'Pre-roll'),
      camEnter: readNumber('pol-cam-enter', 'CAM enter threshold'),
      camExit: readNumber('pol-cam-exit', 'CAM exit threshold'),
      camEnterConfirm: readNumber('pol-cam-enter-confirm', 'CAM enter confirms'),
      camExitConfirm: readNumber('pol-cam-exit-confirm', 'CAM exit confirms'),
      speechThreshold: readNumber('pol-vad-threshold', 'Speech threshold'),
      smoothFrames: readNumber('pol-vad-smooth', 'Smoothing frames'),
      minSpeechFrames: readNumber('pol-vad-min-speech', 'Minimum speech frames'),
      endMode: $('pol-vad-end-mode').value,
      hangover: readNumber('pol-vad-hangover', 'Fixed hangover'),
      hangoverMax: readNumber('pol-vad-hangover-max', 'Stepped initial hangover'),
      hangoverMin: readNumber('pol-vad-hangover-min', 'Stepped final hangover'),
      pressureStart: readNumber('pol-vad-pressure', 'Stepping start'),
      finalConfirm: readNumber('pol-vad-final-confirm', 'HALF to FULL confirmation'),
      halfResumeSpeech: readNumber('pol-vad-half-resume', 'Speech after HALF'),
      language: $('pol-asr-language').value,
    };
    const w = await writePolicy((p) => {
      p.trigger.mode = v.triggerMode;
      p.trigger.pre_roll_ms = v.preRoll;
      p.volume.rms_window_ms = v.rmsWindow;
      p.volume.threshold = v.threshold;
      p.volume.frames = v.volumeFrames;
      p.cam.enter_threshold = v.camEnter;
      p.cam.exit_threshold = v.camExit;
      p.cam.enter_confirm = v.camEnterConfirm;
      p.cam.exit_confirm = v.camExitConfirm;
      p.vad.speech_threshold = v.speechThreshold;
      p.vad.smooth_frames = v.smoothFrames;
      p.vad.min_speech_frames = v.minSpeechFrames;
      p.vad.end_mode = v.endMode;
      p.vad.hangover_ms = v.hangover;
      p.vad.hangover_max_ms = v.hangoverMax;
      p.vad.hangover_min_ms = v.hangoverMin;
      p.vad.pressure_start_ms = v.pressureStart;
      p.vad.final_confirm_ms = v.finalConfirm;
      p.vad.half_resume_speech_ms = v.halfResumeSpeech;
      p.asr.language = v.language;
      return true;
    });
    policyDirty = false;
    await loadPolicy();
    await refreshOverview();
    setMessage($('policy-note'), w.changed ? `Saved (policy r${w.revision}).` : 'No change.', 'good');
  } catch (error) {
    setMessage($('policy-note'), errorText(error), 'bad');
  }
});

/* ============================================================
   Settings · Audio input (App AudioRing source for Speech2).
   ============================================================ */
async function loadInput() {
  try {
    const v = (await request('/speech2/input'))?.value;
    const sel = $('in-source');
    if (sel && document.activeElement !== sel) {
      const available = new Map((v?.sources ?? []).map((s) => [s.type ?? s.source_type, s]));
      sel.replaceChildren(...(v?.product_sources ?? []).map((type) => {
        const s = available.get(type);
        const label = `${INPUT_LABEL[type] ?? type}${s && s.available === false ? ' (unavailable)' : ''}`;
        const opt = new Option(label, type);
        return opt;
      }));
      sel.value = v?.configured ?? 'SYSTEM_BUILTIN_MIC';
    }
    setText($('in-configured'), INPUT_LABEL[v?.configured] ?? v?.configured ?? '—');
    const active = v?.ring?.active_source;
    setText($('in-active'), active ? (INPUT_LABEL[active] ?? active) : 'none');
    if (v?.last_error) setMessage($('in-note'), inputErrorText(v.last_error), 'bad');
  } catch (error) {
    setMessage($('in-note'), `Input unavailable: ${errorText(error)}`, 'bad');
  }
}
$('in-save')?.addEventListener('click', async () => {
  try {
    const v = (await request('/speech2/input', { method: 'POST', body: { input_source: $('in-source').value } }))?.value;
    setMessage($('in-note'), v?.last_error ? inputErrorText(v.last_error)
      : `Input set to ${INPUT_LABEL[v?.configured] ?? v?.configured}${v?.switched ? ' (switched now)' : ''}.`,
    v?.last_error ? 'bad' : 'good');
  } catch (error) {
    setMessage($('in-note'), errorText(error), 'bad');
  }
  await loadInput();
  await refreshOverview();
});

/* ============================================================
   Settings · Models — relayed App readiness (load + one real inference).
   ============================================================ */
function renderModels(m) {
  const list = $('models-list');
  if (!list || !m) return;
  const names = [['campplus', 'Speaker (CAM++)'], ['fireredvad', 'Voice activity (FireRedVAD)'],
    ['sensevoice_t267', 'Transcription (SenseVoice 16 s)']];
  list.replaceChildren(...names.map(([key, label]) => {
    const v = m[key];
    const li = el('li', 's2-model');
    li.dataset.model = key;
    li.dataset.ready = String(v?.ready === true);
    const verdict = v?.ready ? 'ready' : v?.installed ? `installed · ${v?.reason ?? 'not ready'}`
      : `not installed${v?.reason ? ` · ${v.reason}` : ''}`;
    li.append(el('span', `status-dot ${v?.ready ? 'ok' : v?.installed ? 'warn' : 'bad'}`),
      el('span', 's2-model-name', label), el('span', 's2-model-verdict', verdict));
    return li;
  }));
  setText($('models-authority'), m.authority === 'app' ? 'Readiness is reported by the App (load + a real inference).' : '');
}

/* ============================================================
   ?dev=1 only: complete policy editor (never a product tab).
   ============================================================ */
if (DEV) {
  const tpl = $('dev-policy-template');
  if (tpl) $('page-settings').append(tpl.content.cloneNode(true));
  const load = async () => {
    try {
      const doc = (await request('/speech2/policy'))?.value;
      $('dev-policy-json').value = JSON.stringify(doc?.policy ?? {}, null, 2);
      setMessage($('dev-policy-note'), `revision ${doc?.revision}`, '');
    } catch (error) { setMessage($('dev-policy-note'), errorText(error), 'bad'); }
  };
  $('dev-policy-reload')?.addEventListener('click', load);
  $('dev-policy-apply')?.addEventListener('click', async () => {
    try {
      const body = JSON.parse($('dev-policy-json').value);
      const r = (await request('/speech2/policy', { method: 'PUT', body }))?.value;
      setMessage($('dev-policy-note'), `applied revision ${r?.revision}`, 'good');
    } catch (error) { setMessage($('dev-policy-note'), errorText(error), 'bad'); }
  });
  void load();
}

/* ============================================================
   Header MEM/ZRAM, sourced from the existing memory state domain.
   ============================================================ */
function renderMemory(memory) {
  const box = $('mem-avail');
  if (!box) return;
  const mb = Number(memory?.avail_mb);
  if (!Number.isFinite(mb) || mb <= 0) {
    box.innerHTML = '<span class="muted" style="font-size:0.62rem;">MEM —</span>';
    return;
  }
  const toG = (v) => Number.isFinite(Number(v)) ? `${(Number(v) / 1024).toFixed(2)}G` : '—';
  const used = Number(memory?.used_mb);
  const total = Number(memory?.total_mb);
  const swap = Number(memory?.swap_used_mb);
  const swapTotal = Number(memory?.swap_total_mb) || 8192;
  const memPct = total > 0 && Number.isFinite(used) ? Math.min(100, Math.max(0, used / total * 100)) : 0;
  const memTone = memory?.low_memory || mb < 1200 || memPct >= 88 ? 'bad' : (mb < 2000 || memPct >= 75) ? 'warn' : 'ok';
  const swapVal = Number.isFinite(swap) ? swap : 0;
  const swapPct = swapTotal > 0 ? Math.min(100, Math.max(0, swapVal / swapTotal * 100)) : 0;
  const swapTone = swapPct >= 80 ? 'bad' : swapPct >= 50 ? 'warn' : 'ok';
  box.className = 'mem-cols';
  box.innerHTML = `
    <div class="mem-item mem-${memTone}">
      <span class="mem-lbl">MEM</span>
      <span class="mem-bracket">[</span><div class="mem-bar"><div class="mem-fill" style="width:${memPct.toFixed(1)}%;"></div><span class="mem-val">${toG(used)}</span></div><span class="mem-bracket">]</span>
      <span class="mem-total">${toG(total)}</span>
    </div>
    <div class="mem-item mem-${swapTone}">
      <span class="mem-lbl">ZRAM</span>
      <span class="mem-bracket">[</span><div class="mem-bar"><div class="mem-fill" style="width:${swapPct.toFixed(1)}%;"></div><span class="mem-val">${toG(swapVal)}</span></div><span class="mem-bracket">]</span>
      <span class="mem-total">${toG(swapTotal)}</span>
    </div>`;
  box.title = `MEM used ${used} MB / ${total} MB · available ${mb} MB`;
}

/* ============================================================
   /state/ws reconnect + watchdog. AppEvents wakes transcript syncing; memory remains a readout.
   ============================================================ */
let stateSocket = null;
let stateReconnect = null;
let stateBackoffMs = 1000;
let stateGeneration = 0;
let stateWatchdog = null;
let stateBootId = null;
const STATE_WATCHDOG_MS = 45_000;
const closeStateSocket = () => {
  clearTimeout(stateReconnect); stateReconnect = null;
  clearTimeout(stateWatchdog); stateWatchdog = null;
  stateGeneration += 1;
  const socket = stateSocket;
  stateSocket = null;
  if (socket) {
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
    try { socket.close(); } catch { /* already closed */ }
  }
};
const liveDot = (tone, title) => dot('st-dot-live', tone, title);
const connectStateSocket = () => {
  clearTimeout(stateReconnect);
  stateReconnect = null;
  if (stateSocket || document.visibilityState !== 'visible') return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}${PKG}/state/ws?interval_ms=400`);
  const generation = ++stateGeneration;
  stateSocket = socket;
  const arm = () => {
    clearTimeout(stateWatchdog);
    stateWatchdog = setTimeout(() => {
      if (stateSocket !== socket || stateGeneration !== generation) return;
      closeStateSocket();
      connectStateSocket();
    }, STATE_WATCHDOG_MS);
  };
  socket.onopen = () => {
    if (stateSocket !== socket || stateGeneration !== generation) return;
    stateBackoffMs = 1000;
    document.documentElement.dataset.stateSocket = 'live';
    liveDot('ok', 'Live state connected');
    arm();
  };
  socket.onmessage = (event) => {
    if (stateSocket !== socket || stateGeneration !== generation) return;
    try {
      const frame = JSON.parse(event.data);
      if (frame?.schema !== 'termux-os.speech-state.v1' || !frame.domains) {
        throw new Error(`unrecognized state frame (schema=${frame?.schema ?? 'missing'})`);
      }
      if (frame.full === true || frame.boot_id !== stateBootId) stateBootId = frame.boot_id;
      if ('speech2' in frame.domains) renderLive(frame.domains.speech2);
      if ('memory' in frame.domains) renderMemory(frame.domains.memory);
      liveDot('ok', 'Live state connected');
      arm();
    } catch (error) {
      liveDot('bad', `State stream error: ${error.message}`);
    }
  };
  socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
  socket.onclose = () => {
    if (stateSocket !== socket || stateGeneration !== generation) return;
    stateSocket = null;
    clearTimeout(stateWatchdog);
    document.documentElement.dataset.stateSocket = 'offline';
    liveDot('warn', 'Live state disconnected; reconnecting…');
    if (document.visibilityState !== 'visible') return;
    stateReconnect = setTimeout(connectStateSocket, stateBackoffMs);
    stateBackoffMs = Math.min(15_000, stateBackoffMs * 2);
  };
};

/* ============================================================
   Polling: /speech2/overview once per second while the page is visible (LIVE chart + status).
   ============================================================ */
let pollTimer = null;
const startPolling = () => {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!busy) void refreshOverview(); }, 1000);
};
onPageSelected = (page) => {
  if (page === 'settings') {
    void refreshVoice();
    void loadPolicy();
    void loadInput();
  } else if (page === 'history') {
    void refreshHistory();
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    connectStateSocket();
    startPolling();
    void refreshOverview();
  } else {
    clearInterval(pollTimer);
    closeStateSocket();
  }
});

void (async () => {
  await refreshOverview();
  connectStateSocket();
  startPolling();
  onPageSelected(PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
  void refreshVoice();
  void loadPolicy();
  void loadInput();
})();
window.TermuxSpeech2Page = Object.freeze({
  refreshOverview, refreshHistory, refreshVoice, renderLiveMeters, renderHistoryItem, speakerColor,
});

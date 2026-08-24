/**
 * docs/080 声纹登记 + 实时滑窗 USER-VAD 前端。
 * ⚠ 三条在 docs/078 §9 用真机代价学到的，照抄不再重犯：
 *  ① API base 是 `/api/packages/<id>`，**不是**静态挂载点（后者 404）；
 *  ② 必须走 `window.TermuxOS.api`（Browser Session），裸 fetch 一律 401；
 *  ③ 失败必须**看得见**——静默吞掉会让「路径写错」和「没人说话」长得一样。
 * ⭐ 时间轴走**专用增量端点**按游标取，⛔ 不塞进 `/live`（那是整份状态，docs/056 刚杀掉那种空转）。
 */
const $ = (id) => document.getElementById(id);

const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const PKG = `/api/packages/${/^[\w.@-]+$/.test(pathPackageId) ? pathPackageId
  : 'github.termux-os.service.termux-speech'}`;

const api = async (p, body) => {
  try {
    const r = await window.TermuxOS.api(PKG + p, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await r.json().catch(() => null);
    if (!r.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${r.status}`);
    return payload;
  } catch (error) {
    /**
     * ⚠ 报错要落在使用者**此刻看得见**的地方。0.21.4 把校准台折进 `<details>` 之后，
     *   `#test-note` 默认是不可见的——继续只写它，等于回到了「静默吞掉」。
     */
    const box = $('page-error');
    if (box) { box.textContent = `⚠ ${p}: ${String(error?.message ?? error)}`; box.className = 'note bad'; box.hidden = false; }
    const note = $('test-note');
    if (note) { note.textContent = `⚠ ${p}: ${String(error?.message ?? error)}`; note.className = 'note bad'; }
    throw error;
  }
};

const CFG = ['window_ms', 'step_ms', 'threshold', 'on_windows', 'off_windows'];
const LABELS = ['UNLABELED', 'USER', 'BACKGROUND', 'OTHER_NEAR', 'OVERLAP'];
let built = false;
let slowTimer = null;
let fastTimer = null;
let cursor = 0;
let rows = [];
let epSig = '';

const facts = (node, list) => {
  node.replaceChildren(...list.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => {
    const d = document.createElement('div');
    const s = document.createElement('span'); s.textContent = k;
    const b = document.createElement('strong'); b.textContent = String(v);
    d.append(s, b); return d;
  }));
};

/** similarity / threshold / VAD / USER-OTHER 四条同图。 */
function draw(threshold) {
  const c = $('tl');
  const w = c.clientWidth || 600;
  if (c.width !== w) c.width = w;
  const h = c.height;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!rows.length) return;
  const n = Math.min(rows.length, Math.max(20, Math.floor(w / 3)));
  const view = rows.slice(-n);
  const top = h * 0.58;
  const lo = -0.2; const hi = 1.0;
  const y = (v) => top - ((v - lo) / (hi - lo)) * (top - 6);
  // threshold
  g.strokeStyle = '#e0a33f'; g.setLineDash([4, 3]); g.beginPath();
  g.moveTo(0, y(threshold)); g.lineTo(w, y(threshold)); g.stroke(); g.setLineDash([]);
  // similarity
  g.strokeStyle = '#5aa9e6'; g.lineWidth = 1; g.beginPath();
  view.forEach((r, i) => {
    const x = (i / n) * w;
    i ? g.lineTo(x, y(r.similarity)) : g.moveTo(x, y(r.similarity));
  });
  g.stroke();
  // VAD 概率（下半）
  const vy = (p) => h - 18 - p * (h - top - 26);
  g.strokeStyle = '#3f7f5f'; g.beginPath();
  view.forEach((r, i) => {
    const x = (i / n) * w; const p = r.vad_probability ?? 0;
    i ? g.lineTo(x, vy(p)) : g.moveTo(x, vy(p));
  });
  g.stroke();
  // USER/OTHER 底条
  view.forEach((r, i) => {
    g.fillStyle = r.state === 'USER' ? '#5fd08a' : '#2b3440';
    g.fillRect((i / n) * w, h - 12, Math.ceil(w / n) + 1, 10);
  });
}

function renderEpisodes(eps) {
  const sig = eps.map((e) => e.seq).join(',');
  if (sig === epSig) return;                     // 别把正在播的 <audio> 重建掉
  epSig = sig;
  $('episodes').replaceChildren(...eps.map((e) => {
    const li = document.createElement('li');
    const t = document.createElement('h3');
    /**
     * ⚠ 从磁盘重建的条目**没有**当时的 similarity 与标签（那些只在内存里）。
     *   ⛔ 不拿 `null` 冒充 0——「不知道」和「很低」是两回事。
     */
    t.textContent = e.recovered
      ? `#${e.seq} · ${e.duration_ms} ms · 重启前录的`
      : `#${e.seq} · ${e.label} · ${e.duration_ms} ms（USER ${e.user_duration_ms} ms）`;
    const m = document.createElement('p'); m.className = 'note';
    m.textContent = e.recovered
      ? '服务重启后从文件恢复：当时的 similarity 与标签已不可考，音频仍可试听'
      : `peak ${e.peak_similarity} · mean ${e.mean_similarity} · ${e.close_reason}`;
    const a = document.createElement('audio');
    a.controls = true; a.preload = 'none';
    a.src = `${PKG}/speaker/audio?clip=${encodeURIComponent(e.wav)}`;
    li.append(t, m, a); return li;
  }));
}

/** 快节拍：只取时间轴增量。 */
async function tickFast() {
  const d = await api(`/speaker/timeline?after=${cursor}&limit=200`).catch(() => null);
  if (!d?.ok) return;
  cursor = d.next ?? cursor;
  if (d.rows?.length) {
    rows.push(...d.rows);
    if (rows.length > 600) rows = rows.slice(-600);
  }
  const u = d.uservad ?? {};
  $('state-badge').textContent = u.state ?? '—';
  $('state-badge').className = `badge ${u.state === 'USER' ? 'ok' : ''}`;
  $('vad-badge').textContent = `VAD ${d.vad_probability ?? '—'}`;
  // ⭐ 当前标签必须和状态一样醒目：它决定这一段被记进哪一栏。
  const st = d.labels ?? {};
  const cur = st.current;
  if (cur) {
    $('label-badge').textContent = `标签 ${cur}`;
    $('label-badge').className = `badge ${cur === 'UNLABELED' ? 'tag' : 'ok'}`;
  }
  const last = rows.at(-1);
  facts($('live-facts'), [
    ['similarity', last?.similarity ?? '—'],
    ['threshold', u.config?.threshold],
    ['raw ≥ T', last ? String(last.raw_match) : '—'],
    ['on / off streak', `${u.on_streak ?? 0} / ${u.off_streak ?? 0}`],
    ['state', u.state ?? '—'],
    ['inference', last?.inference_ms ? `${last.inference_ms} ms` : '—'],
    ['inferences/s', d.cpu?.inferences_per_s],
    ['CAM++ ms/s', d.cpu?.cpu_ms_per_s],
    ['p50 / p90', `${d.cpu?.p50_inference_ms ?? '—'} / ${d.cpu?.p90_inference_ms ?? '—'}`],
    ['跳过的窗', d.cpu?.skipped_windows],
  ]);
  // ⭐ 展示**说话中**那一组：含静默的那组 p10/p50 描述的是静默，不是说话人。
  facts($('label-stats'), LABELS.map((l) => {
    const s = st.labels_speech?.[l]; const all = st.labels?.[l];
    return [l, s?.n
      ? `说话中 n=${s.n} p10 ${s.p10} p50 ${s.p50} p90 ${s.p90} max ${s.max}（含静默 n=${all?.n ?? 0}）`
      : `n=0（含静默 n=${all?.n ?? 0}）`];
  }));
  const curStat = st.labels_speech?.[cur] ?? {};
  $('label-count').textContent = cur && cur !== 'UNLABELED'
    ? `${cur}：说话中 ${curStat.n ?? 0} 个窗（约 ${(((curStat.n ?? 0) * (u.config?.step_ms ?? 250)) / 1000).toFixed(1)} 秒）`
      + ` · 跨切换点丢弃 ${st.impure_dropped ?? 0}`
    : '当前未打标签，窗记进 UNLABELED（不参与建议阈值）';
  /**
   * ⭐ 建议阈值按**运行时那台状态机**评（迟滞跑在有序窗序列上），
   *   不是逐窗分位数——背景的孤立高点不该让判据崩掉，
   *   而背景里一段**连续**的高分才是真的没解。
   */
  const sg = st.suggested ?? {};
  const wp = st.window_percentiles ?? {};
  $('suggest-note').textContent = sg.ok
    ? `建议阈值 ${sg.threshold}`
      + (sg.band_low !== undefined
        ? ` —— 可用带 ${sg.band_low}~${sg.band_high}，取中点（下沿背景开始触发 / `
          + `上沿你自己开始被挡），两侧余量 ${sg.margin_below} / ${sg.margin_above}。`
        : ` —— ${sg.basis}。`)
      + `背景 ${sg.other_n} 个窗**零触发**，`
      + `你有 ${(sg.user_on_ratio * 100).toFixed(0)}% 的窗被认出（进 USER ${sg.user_enters} 次）。`
      + `（逐窗分位数那套旧规则会说：${wp.ok ? '也分得开' : wp.reason ?? '—'}）`
    : sg.reason === 'overlap'
      ? `⚠ 没有一个阈值能让背景零触发、同时还认得出你。`
        + (sg.best_effort
          ? `最省的折中是 T=${sg.best_effort.threshold}：背景仍会触发 `
            + `${sg.best_effort.other_enters} 次，用户覆盖 `
            + `${(sg.best_effort.user_on_ratio * 100).toFixed(0)}%。`
            + '⚠ 多半是背景里有一段声音真的很像你——去⑤听那几个 episode 确认一下。'
          : '')
      : `样本还不够（USER ${sg.user_n ?? 0} / OTHER ${sg.other_n ?? 0}，各需 ≥10 个窗）`;
  draw(u.config?.threshold ?? 0.3);
}

/** 慢节拍：整份状态（声纹、登记片段、episode、模式）。 */
async function tickSlow() {
  const d = await api('/speaker/state').catch(() => null);
  if (!d?.ok) return;
  const v = d.value;
  const p = v.profile;
  $('mode-badge').textContent = v.mode.toUpperCase();
  /**
   * ⭐ 产品区只放使用者能据此**做决定**的两件事：声纹在不在、样本够不够。
   * ⛔ pairwise similarity / backend / 缓冲毫秒数搬进开发者工具——
   *   它们是实现细节，摆在产品流程里只会让人以为自己需要看懂它们。
   */
  facts($('profile-facts'), [
    ['我的声纹', p.ready ? '已生成' : '未生成'],
    ['已录样本', `${p.enrollment_count} 段（至少需要 ${p.config.min_enrollments} 段）`],
  ]);
  facts($('lab-facts'), [
    ['登记内部 similarity', p.pairwise.n
      ? `${p.pairwise.min} ~ ${p.pairwise.max}（中位 ${p.pairwise.p50}）` : '—'],
    ['CAM++ 模型', v.campplus.files_present ? `在位（${v.campplus.backend}）` : '⚠ 缺失'],
    ['缓冲', `${v.buffered_ms} ms`],
    ['consumer', d.consumer_enabled ? 'speaker ON' : 'speaker OFF'],
  ]);
  /**
   * ⭐ 每一段样本都能**试听 / 删除 / 重录**。
   * ⚠ `MISSING` 是带内取值而不是「这条不存在」：登记记录还在、WAV 没了，
   *   两者是不同的事实，压成一个「不显示」会让使用者以为样本自己丢了。
   *   重启后这个列表由服务端从 profile 重建（0.21.4 修的就是这个）。
   */
  $('enrollments').replaceChildren(...v.enroll_clips.map((c, i) => {
    const li = document.createElement('li');
    const h = document.createElement('h3');
    const missing = c.status !== 'OK';
    h.textContent = `样本 ${v.enroll_clips.length - i} · ${(c.duration_ms ?? 0) / 1000} 秒`
      + (missing ? ' · ⚠ 录音文件已丢失' : '');
    if (missing) h.className = 'drop';
    const a = document.createElement('audio');
    a.controls = true; a.preload = 'none';
    a.src = `${PKG}/speaker/audio?clip=${encodeURIComponent(c.wav)}`;
    const row = document.createElement('div'); row.className = 'row';
    const del = document.createElement('button'); del.className = 'secondary'; del.textContent = '删除';
    del.onclick = guard(async () => { await api('/speaker/profile/remove', { id: c.id }); await tickSlow(); });
    /** ⚠ 「重录」= 删掉这一段并立刻回到录音状态，⛔ 不是另一个后端动作。 */
    const again = document.createElement('button'); again.className = 'secondary'; again.textContent = '重录';
    again.onclick = guard(async () => {
      await api('/speaker/profile/remove', { id: c.id });
      await api('/speaker/enroll/start', {});
      setRate(true); await tickSlow();
    });
    row.append(del, again);
    li.append(h, a, row); return li;
  }));
  if (!built) {
    const sel = $('cfg-window_ms');
    sel.replaceChildren(...v.recommended_windows.map((n) => {
      const o = document.createElement('option'); o.value = n; o.textContent = `${n} ms`; return o;
    }));
    // ⚠ 500 允许手输但不推荐——离线实测它的 user/background margin 基本归零。
    const o = document.createElement('option'); o.value = 500; o.textContent = '500 ms（不推荐）';
    sel.append(o);
    for (const k of CFG) if (v.uservad.config[k] !== undefined) $(`cfg-${k}`).value = v.uservad.config[k];
    $('label-row').replaceChildren(...LABELS.map((l) => {
      const b = document.createElement('button');
      b.className = 'secondary'; b.dataset.label = l; b.textContent = l;
      /**
       * ⚠ 点了标签必须**当场有回执**。真机反馈：「添加标签时没有任何成功信息」——
       *   而当时 `tickFast()` 每次都在这之前抛 TDZ，整块实时区（标签徽章、分数分布、
       *   建议阈值、画布）一个字都没画过，点与不点看起来完全一样。
       */
      b.onclick = async () => {
        const r = await api('/speaker/label', { label: l });
        $('label-ack').textContent = `已切到 ${r?.label ?? l} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
          + '（从这一刻起的窗记进这一栏；⚠ 跨越切换点的那几个窗会被丢掉，不进任何一栏）';
        $('label-ack').className = 'note good';
        await tickFast(); await tickSlow();
      };
      return b;
    }));
    built = true;
  }
  for (const b of $('label-row').children) {
    b.className = b.dataset.label === v.labels.current ? '' : 'secondary';
  }
  $('cfg-note').textContent = `当前 ${v.uservad.config.window_ms} ms / ${v.uservad.config.step_ms} ms`
    + ` / T=${v.uservad.config.threshold} / on ${v.uservad.config.on_windows} / off ${v.uservad.config.off_windows}`;
  // ⭐ 阈值与窗长绑定：换了窗长必须重新校准，页面要明说。
  $('recal-note').textContent = v.uservad.recalibrate_hint
    ? '⚠ 声纹或 window_ms 变了 —— 当前 threshold 需要重新校准。'
      + '阈值绑的是「声纹 + 窗长」这一对：真机实测同一段话，TTS 声纹下 p50 0.83、真人声纹下只有 0.59；'
      + '同一个 0.70 在前者干净、在后者会把本人挡在门外。'
      + '先按标签录几段 USER 与 OTHER，再点「采用建议阈值」。'
    : '';
  $('recal-note').className = v.uservad.recalibrate_hint ? 'note bad' : 'note';
  /**
   * 正式声纹门（docs/081）在这一页的投影。⛔ 只读服务端算好的 `calibration`，
   * 页面**不自己判**「算不算 stale」——两处各判一次就会有两个答案。
   */
  const cal = v.calibration ?? {};
  const gate = d.speaker_gate ?? null;
  const REASON = {
    profile_missing: '还没有声纹', calibration_not_acknowledged: '阈值尚未确认',
    profile_changed: '声纹重建过，阈值需要重新确认',
    window_changed: '窗长改过，阈值需要重新确认',
    threshold_changed: '阈值改过，需要重新确认', calibrated: '已确认',
  };
  const armed = gate?.armed === true;
  /**
   * ⭐ 三档说的是**使用者能看懂的事实**，⛔ 不是内部枚举：
   *   未启用（全放行）/ 已启用但还没认出过你 / 已启用并在用。
   * ⚠ 「还没认出过你一次」这一档必须留着——真机上阈值对声纹太高时，
   *   门会以「不是你」连续拒绝使用者自己的语音，而那时它看起来是「已启用」。
   */
  $('prod-badge').textContent = !cal.ok ? '未启用' : armed ? '已启用' : '待确认';
  $('prod-badge').className = `badge ${armed ? 'ok' : 'warn'}`;
  $('prod-note').textContent = !cal.ok
    ? `${REASON[cal.reason] ?? cal.reason} —— 现在常驻助手**所有声音都放进来**，`
      + '不会漏掉你，也挡不住背景。录好样本、生成声纹后点「完成登记并启用」。'
    : armed
      ? '常驻助手现在只认你的声音。重录样本、重新生成声纹之后，需要再点一次「完成登记并启用」。'
      : '已启用，但它「还没有认出过你一次」—— 在认出你之前仍然全部放行。'
        + '请对着手机正常说一句话；如果一直认不出，删掉噪音大的样本重新生成。';
  $('prod-note').className = armed ? 'note' : 'note bad';
  renderEpisodes(v.episodes ?? []);
  if (v.last_error) { $('test-note').textContent = `⚠ ${v.last_error}`; $('test-note').className = 'note bad'; }
  else if (!p.ready) {
    $('test-note').textContent = '还没有声纹：先登记至少三段并点「生成声纹」。'
      + '没有声纹时不会跑 CAM++，也不会有任何判决。';
    $('test-note').className = 'note';
  } else {
    $('test-note').textContent = 'CAM++ 在连续 PCM 上滑窗，'
      + '⛔ 不由 FireRedVAD 的 segment 决定窗边界。';
    $('test-note').className = 'note';
  }
}

const setRate = (live) => {
  clearInterval(fastTimer); clearInterval(slowTimer);
  fastTimer = setInterval(tickFast, live ? 400 : 2000);
  slowTimer = setInterval(tickSlow, live ? 1500 : 4000);
};
const guard = (fn) => async () => { try { await fn(); } catch { /* api() 已报出 */ } };

$('enroll-start').onclick = guard(async () => { await api('/speaker/enroll/start', {}); setRate(true); await tickSlow(); });
$('enroll-stop').onclick = guard(async () => { await api('/speaker/enroll/stop', {}); setRate(false); await tickSlow(); });
$('test-start').onclick = guard(async () => { rows = []; cursor = 0; await api('/speaker/test/start', {}); setRate(true); await tickSlow(); });
$('test-stop').onclick = guard(async () => { await api('/speaker/test/stop', {}); setRate(false); await tickSlow(); });
$('profile-build').onclick = guard(async () => {
  const r = await api('/speaker/profile/build', {});
  if (r.reason === 'not_enough_enrollments') {
    $('enroll-note').textContent = `⚠ 只有 ${r.have} 段，至少要 ${r.need} 段`;
    $('enroll-note').className = 'note bad';
  }
  await tickSlow();
});
$('profile-clear').onclick = guard(async () => { await api('/speaker/profile/clear', {}); await tickSlow(); });
$('purge').onclick = guard(async () => { await api('/speaker/purge', {}); epSig = ''; rows = []; await tickSlow(); });
$('labels-clear').onclick = guard(async () => { await api('/speaker/labels/clear', {}); await tickFast(); });
$('cfg-save').onclick = guard(async () => {
  const patch = {};
  for (const k of CFG) patch[k] = Number($(`cfg-${k}`).value);
  await api('/speaker/config', patch);
  await tickSlow(); await tickFast();
});
/** ⛔ 单独的一次确认：不改任何数字，只说「我看过了，就用这个」。 */
$('prod-ack').onclick = guard(async () => {
  const r = await api('/speaker/threshold/ack', {});
  if (r?.reason === 'profile_missing') {
    $('prod-note').textContent = '⚠ 还没有声纹，先登记并生成。';
    $('prod-note').className = 'note bad';
  }
  await tickSlow();
});
$('suggest-apply').onclick = guard(async () => {
  // ⛔ 建议阈值**绝不自动应用**——必须使用者主动点这一下。
  const d = await api('/speaker/timeline?after=0&limit=1');
  const sg = d?.labels?.suggested;
  if (!sg?.ok) { $('suggest-note').className = 'note bad'; return; }
  await api('/speaker/config', { threshold: sg.threshold });
  await api('/speaker/threshold/ack', {});
  await tickSlow();
});


// ── docs/084 CAM++ Activity Test（HTP） ─────────────────────────────────────
// ⚠ 与②那套 CPU USER-VAD 是两条独立的链，共用这一页但不共用状态。
let camSegSig = '';

const camColor = (sim, enter, exit) => (sim >= enter ? '#2e9e5b'
  : sim >= exit ? '#c9902a' : '#8a8f98');

const renderCam = (v, holders) => {
  const on = v.enabled === true;
  $('cam-badge').textContent = on ? 'ON' : 'OFF';
  $('cam-badge').className = `badge ${on ? 'keep' : ''}`;
  // ⛔ 三件事必须说出来，不能只显示一个分数
  $('cam-backend').textContent = `backend ${v.backend ?? '—'}`
    + (v.compute_unit ? ` (${v.compute_unit})` : '');
  $('cam-backend').className = `badge tag ${v.backend === 'htp' ? 'keep' : 'bad'}`;
  $('cam-graph').textContent = `graph ${v.graph_loaded ? 'loaded' : 'no'}`;
  $('cam-graph').className = `badge tag ${v.graph_loaded ? 'keep' : ''}`;
  $('cam-profile').textContent = `profile ${v.profile_ready ? 'ready' : 'missing'}`;
  $('cam-profile').className = `badge tag ${v.profile_ready ? 'keep' : 'bad'}`;
  $('cam-state').textContent = v.state ?? '—';
  $('cam-state').style.color = v.state === 'USER' ? '#2e9e5b'
    : v.state === 'MAYBE_USER' || v.state === 'MAYBE_END' ? '#c9902a' : '';
  $('cam-sim').textContent = v.similarity === null || v.similarity === undefined
    ? '—' : Number(v.similarity).toFixed(4);
  $('cam-userseen').textContent = v.half_shutter
    ? '⏳ 半快门（等后续）' : `USER_SEEN ${v.user_seen ? 'yes' : 'no'}`;
  $('cam-userseen').className = `badge tag${v.half_shutter ? ' keep' : ''}`;
  $('cam-cand').textContent = `candidate ${v.current_candidate_id ?? '—'}`;
  const c = v.config ?? {};
  const t = v.timing ?? {};
  facts($('cam-facts'), [
    ['enter / exit', `${c.enter_threshold} / ${c.exit_threshold}`],
    ['window / step', `${c.window_ms} ms / ${c.step_ms} ms`],
    ['confirm', `${c.enter_confirm}-${c.exit_confirm}`],
    ['句首模式', `${c.head_mode}${c.head_mode === 'trim' ? ` (${c.head_trim_ms} ms)` : '（不裁）'}`],
    ['尾部余量', `${c.tail_margin_ms} ms`],
    ['半快门等待', `${c.continuation_grace_ms} ms`],
    ['CAM 推理 last / p50', `${t.infer_last_ms ?? '—'} / ${t.infer_p50_ms ?? '—'} ms`],
    ['端到端 last / p50', `${t.e2e_last_ms ?? '—'} / ${t.e2e_p50_ms ?? '—'} ms`],
    ['窗数 / 忙跳过', `${t.windows ?? 0} / ${t.skipped_busy ?? 0}`],
    ['commits', String(v.counters?.commits ?? 0)],
    ['mic holders', (holders ?? []).join(', ') || '（无）'],
  ]);
  if (!v.profile_ready) {
    $('cam-note').textContent = '⚠ 还没有声纹：先在①登记并「生成声纹」，'
      + '否则不会启动（⛔ 不拿空 profile 编分数）。';
    $('cam-note').className = 'note bad';
  } else if (v.last_error) {
    $('cam-note').textContent = `⚠ ${v.last_error}`;
    $('cam-note').className = 'note bad';
  }
  // 两个下拉：只在选项变化时重建，⛔ 否则会把使用者正在选的值冲掉（docs/060 踩过）
  const fill = (id, choices, cur) => {
    const el = $(id);
    if (!el) return;
    if (choices.length && el.options.length !== choices.length) {
      el.textContent = '';
      for (const ms of choices) {
        const o = document.createElement('option');
        o.value = String(ms); o.textContent = `${ms} ms`;
        el.appendChild(o);
      }
    }
    if (document.activeElement !== el && cur !== undefined) el.value = String(cur);
  };
  // 句首模式：safe = 不裁（默认）。⛔ 实验性算法不许静默变默认。
  const hm = $('cam-headmode');
  if (hm && (c.head_modes ?? []).length && hm.options.length !== c.head_modes.length) {
    hm.textContent = '';
    for (const m of c.head_modes) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m === 'safe' ? 'Safe（不裁，不吃字）' : 'Trim（固定位移·实验）';
      hm.appendChild(o);
    }
  }
  if (hm && document.activeElement !== hm && c.head_mode) hm.value = c.head_mode;
  fill('cam-head', c.head_trim_choices ?? [], c.head_trim_ms);
  const headSel = $('cam-head');
  if (headSel) headSel.disabled = c.head_mode !== 'trim';
  fill('cam-tail', c.tail_margin_choices ?? [], c.tail_margin_ms);
  fill('cam-grace', c.grace_choices ?? [], c.continuation_grace_ms);
  const lc = v.last_commit;
  $('cam-last').textContent = lc
    ? `最近 commit：#${lc.candidate_id} · ${lc.commit_reason} · ${lc.duration_ms} ms `
      + `· max_sim ${lc.max_similarity}`
    : '还没有 commit。';
};

const renderCamHistory = (rowsIn, cfg) => {
  const box = $('cam-history');
  if (!box) return;
  box.textContent = '';
  const enter = cfg?.enter_threshold ?? 0.4;
  const exit = cfg?.exit_threshold ?? 0.35;
  for (const r of rowsIn) {
    const i = document.createElement('i');
    // sim 可能为负；映射到 0..1 再取高度，⛔ 别让负分画成 0 高看不出区别
    const h = Math.max(2, Math.min(54, Math.round(((r.sim + 0.2) / 1.0) * 54)));
    i.style.height = `${h}px`;
    i.style.background = camColor(r.sim, enter, exit);
    i.title = `${r.sim} · ${r.state}`;
    box.appendChild(i);
  }
  box.scrollLeft = box.scrollWidth;
};

const renderCamSegments = (segs) => {
  const sig = segs.map((x) => x.seq).join(',');
  if (sig === camSegSig) return;
  camSegSig = sig;
  const ul = $('cam-segments');
  ul.textContent = '';
  for (const g of segs) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.innerHTML = `<b>#${g.candidate_id}</b> · ${g.commit_reason} · ${g.duration_ms} ms`
      + ` · max ${g.max_similarity} · mean ${g.mean_user_similarity ?? '—'}`;
    const a = document.createElement('audio');
    a.controls = true;
    a.preload = 'none';
    // ⚠ 包这层用 query，service 那层才是路径段——两层形状故意不同（docs/079）
    a.src = `${PKG}/activity-test/audio?wav=${encodeURIComponent(g.wav)}`;
    const m = g.marks ?? {};
    const det = document.createElement('p');
    det.className = 'note';
    det.textContent = `疑似 ${m.first_maybe_user_ms} · 确认 ${m.confirmed_user_ms}`
      + ` · 转出 ${m.first_maybe_end_ms ?? '—'} · commit ${m.commit_ms}`
      + ` ｜ 反推句尾 ${g.estimated_user_end_ms}（余量 ${g.tail_margin_ms}ms，`
      + `${g.retroactive ? '锚点回切' : '无锚点·退回 commit'}）`
      + ` ｜ 旧切点 ${g.old_pcm_end_ms} → 新切点 ${g.segment_audio_end_ms}`
      + `（**省掉 ${g.saved_tail_ms}ms 尾巴**）`
      + ` ｜ 头部裁掉 ${g.trimmed_head_ms}ms（${g.old_pcm_start_ms}→${g.marks.pcm_start_ms}）`
      + ` ｜ ⏱ 检测滞后 ${g.detection_tail_ms}ms（音频域：多久才知道你结束）`
      + ` · commit→WAV ${g.gap_commit_to_wav_ms}ms（墙钟：切段落盘耗时）`;
    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = '删除';
    del.onclick = guard(async () => {
      await api('/activity-test/segments/remove', { seq: g.seq });
      camSegSig = '';
      await tickCam();
    });
    li.append(head, a, det, del);
    ul.appendChild(li);
  }
};

const tickCam = async () => {
  const st = await api('/activity-test/state').catch(() => null);
  if (!st) return;
  renderCam(st.value ?? {}, st.mic?.holders);
  if (st.value?.enabled) {
    const h = await api('/activity-test/history?limit=120').catch(() => null);
    if (h) renderCamHistory(h.history ?? [], st.value?.config);
  }
  const sg = await api('/activity-test/segments').catch(() => null);
  if (sg) renderCamSegments(sg.segments ?? []);
};

$('cam-tail').onchange = guard(async () => {
  await api('/activity-test/config', { tail_margin_ms: Number($('cam-tail').value) });
  await tickCam();
});
$('cam-headmode').onchange = guard(async () => {
  await api('/activity-test/config', { head_mode: $('cam-headmode').value });
  await tickCam();
});
$('cam-head').onchange = guard(async () => {
  await api('/activity-test/config', { head_trim_ms: Number($('cam-head').value) });
  await tickCam();
});
$('cam-grace').onchange = guard(async () => {
  await api('/activity-test/config',
    { continuation_grace_ms: Number($('cam-grace').value) });
  await tickCam();
});
$('cam-start').onclick = guard(async () => {
  $('cam-note').textContent = '正在腾出 HTP 会话并加载 CAM++ ctx…';
  $('cam-note').className = 'note';
  await api('/activity-test/start', {});
  await tickCam();
});
$('cam-stop').onclick = guard(async () => {
  await api('/activity-test/stop', {});
  await tickCam();
});

// ⚠ `window.TermuxOS` 由 /admin/session.js 异步就绪；不等它就发请求会全部 401。
window.TermuxOS.ready.then(async () => {
  setRate(false); await tickSlow(); await tickFast(); await tickCam();
  // ⭐ similarity 必须**实时**：CAM 每 300 ms 出一个新分，页面按 500 ms 跟。
  setInterval(() => { void tickCam(); }, 500);
});

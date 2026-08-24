/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The state domains map (`/state/ws`) plus `/listen` and record payloads, already fetched.
 * [OUTPUT]: `window.SpeechViews` — shared formatters plus the three product-page render functions.
 * [POS]: Pure presentation half of the Package page; it performs no I/O and holds no credentials.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(() => {
  const RMS_BAR_MAX = 0.2;
  const $ = (id) => document.getElementById(id);
  const qs = (selector) => document.querySelector(selector);

  /* ------------------------------------------------------------------
     格式化
     ------------------------------------------------------------------ */
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const fixed = (value, digits = 4) => {
    const parsed = number(value);
    return parsed === null ? '—' : parsed.toFixed(digits);
  };
  const percent = (value, maximum = 1) => `${
    Math.max(0, Math.min(100, (number(value) ?? 0) / maximum * 100))
  }%`;
  const seconds = (milliseconds) => {
    const value = number(milliseconds);
    return value === null ? '—' : `${(Math.max(0, value) / 1000).toFixed(1)} s`;
  };
  const clock = (ms) => {
    const value = number(ms);
    if (value === null) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const deviceName = (device) => {
    if (!device) return '系统默认';
    return String(device.product_name || device.type_name || '未知输入设备');
  };
  const deviceDetail = (device) => {
    if (!device) return 'Android 自动选择实际路由';
    return [device.type_name, device.address].filter(Boolean).join(' · ') || 'Android 输入设备';
  };
  const labelDevice = (device) => {
    if (!device) return '系统默认';
    const title = deviceName(device);
    const detail = deviceDetail(device);
    return title === detail ? title : `${title} · ${detail}`;
  };

  /**
   * ⭐ 写之前先比一下。
   *
   * 把一个节点的 `textContent` 设成**它已经是的那个字符串**，浏览器照样要走一遍
   * 失效与重排——而推送是按域来的，一次 rms 变化会把整排阶段行重写一遍，其中
   * 通常只有一格真的变了。⚠ 这不是微优化：它决定了「一次推送」在浏览器那边
   * 到底是一格重排还是一整排。
   */
  const setText = (element, text) => {
    if (!element) return false;
    const value = String(text);
    if (element.textContent === value) return false;
    element.textContent = value;
    return true;
  };
  /** 内联样式同理：写进去一个它已经是的值，照样要重算样式。 */
  const setStyle = (element, property, value) => {
    if (!element) return;
    if (element.style[property] !== value) element.style[property] = value;
  };
  const setClass = (element, name, on) => {
    if (!element) return;
    if (element.classList.contains(name) !== (on === true)) element.classList.toggle(name, on === true);
  };
  const setBadge = (element, text, tone = '') => {
    if (!element) return;
    setText(element, text);
    const className = `badge ${tone}`.trim();
    if (element.className !== className) element.className = className;
  };
  const setNote = (element, text, tone = '') => {
    if (!element) return;
    setText(element, text);
    const className = `note ${tone}`.trim();
    if (element.className !== className) element.className = className;
  };
  const recentHit = (hit) => {
    const at = Date.parse(hit?.at ?? '');
    return Number.isFinite(at) && Date.now() - at < 3500;
  };

  const getPkgPrefix = () => {
    if (typeof window !== 'undefined' && window.TERMUX_SPEECH_PKG) return window.TERMUX_SPEECH_PKG;
    if (typeof location !== 'undefined') {
      const match = location.pathname.match(/^(\/api\/packages\/[^\/]+)/);
      if (match) return match[1];
    }
    return '/api/packages/github.termux-os.service.termux-speech';
  };

  const MODEL_LABELS = Object.freeze({
    sensevoice: 'SenseVoice',
  });
  const modelLabel = (id) => MODEL_LABELS[id] ?? String(id ?? '—');

  const ROUTE_LABELS = Object.freeze({
    built_in: '内建',
    bluetooth: '蓝牙',
    wired: '有线',
    usb: 'USB',
    unknown: '未识别',
  });

  const shown = (value) => (
    value === null || value === undefined || value === '' ? '—' : String(value)
  );

  /**
   * ⭐ 行数没变就**只改文字**，不重建节点。
   *
   * 诊断页有九组这样的表格，旧写法每次刷新都 `replaceChildren` 全部重建——真机实测
   * 诊断页可见时 Chrome 要 24.7% 的一个核，而概览页只要 4.5%，差的就是这些重建。
   * 行的**名字**决定结构，值只决定文字；名字没变就没有结构需要重来。
   */
  const facts = (container, rows) => {
    if (!container) return;
    const signature = rows.map(([name]) => name).join('\u0000');
    if (container.dataset.factSignature === signature) {
      const cells = container.children;
      for (let index = 0; index < rows.length; index += 1) {
        setText(cells[index]?.lastElementChild, shown(rows[index][1]));
      }
      return;
    }
    container.dataset.factSignature = signature;
    container.replaceChildren(...rows.map(([name, value]) => {
      const cell = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = name;
      const strong = document.createElement('strong');
      strong.textContent = shown(value);
      cell.append(label, strong);
      return cell;
    }));
  };

  /** 文本列表：内容逐条相同就一个节点都不动。 */
  const textList = (container, items, className = () => '') => {
    if (!container) return;
    const signature = items.map((item) => `${className(item)}\u0001${item.text}`).join('\u0000');
    if (container.dataset.listSignature === signature) return;
    container.dataset.listSignature = signature;
    container.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = item.text;
      const tone = className(item);
      if (tone) li.className = tone;
      return li;
    }));
  };

  /* ------------------------------------------------------------------
     派生：麦克风 / 健康 / 警告
     ⚠ 每一条都必须由后端已有的事实推出。资料不够就说「无法判定」，不猜。
     ------------------------------------------------------------------ */
  const REASON_TEXT = Object.freeze({
    microphone_not_recording: '麦克风未在录音',
    authenticated_pcm_stream_not_connected: 'PCM WebSocket 未连接',
    pcm_stream_stale: 'PCM 帧停滞',
  });

  const micState = (value) => {
    const pcm = value?.pcm;
    if (!pcm) return { label: '无法判定', tone: 'unknown', detail: '尚未读到 speech.input 投影' };
    if (pcm.recording !== true) return { label: '未开启', tone: 'bad', detail: 'Persistent Mic 没有在录音' };
    if (pcm.transport_connected !== true) {
      return { label: '已开启 · 未直连', tone: 'warn', detail: '等待鉴权 PCM WebSocket' };
    }
    const age = number(pcm.last_frame_age_ms);
    if (age === null || age >= 1000) {
      return { label: '停滞 Stale', tone: 'bad', detail: `最后一帧 ${age ?? '—'} ms 前` };
    }
    return { label: '收音中', tone: 'ok', detail: `${pcm.sample_rate_hz} Hz · 帧龄 ${age} ms` };
  };

  /**
   * 收集当前所有**有后端证据的**故障与警告。
   * 顺序即严重度：坏掉的排在「只是还没好」的前面。
   */
  const collectAlerts = (live) => {
    const value = live?.input;
    const alerts = [];
    const push = (tone, text) => alerts.push({ tone, text });
    if (live?.service?.state === 'error') push('bad', `服务错误：${live.service.last_error ?? '未提供原因'}`);
    if (value && value.ready !== true && value.reason) {
      push('bad', `收音不可用：${REASON_TEXT[value.reason] ?? value.reason}`);
    }
    if (live?.vad?.model?.files_present === false) push('bad', 'FireRedVAD 模型文件缺失');
    // 问的是「我选的 backend 能不能工作」，文件型和 App session 型各自回答。
    const selected = live?.asr?.model?.selected;
    if (selected?.ready === false) {
      push('bad', `${modelLabel(selected.id)} 未就绪：${(selected.missing ?? []).join('、')
        || selected.reason || '无法判定'}`);
    }
    if (live?.vad?.last_error) push('bad', `VAD 异常：${live.vad.last_error}`);
    if (live?.asr?.last_error) push('bad', `ASR 异常：${live.asr.last_error}`);
    if (live?.states?.last_error) push('warn', `状态总线异常：${live.states.last_error}`);
    if (live?.memory?.low_memory === true) push('warn', '系统报告低内存');
    if (live?.memory?.error) push('warn', `内存读数取不到：${live.memory.error}`);
    return alerts;
  };

  const deriveHealth = (live, alerts) => {
    const value = live?.input;
    if (!value) return { label: '启动中', tone: 'warn', note: '尚未读到第一笔 speech.input 投影' };
    if (alerts.some((item) => item.tone === 'bad')) {
      return { label: '错误', tone: 'bad', note: alerts.find((item) => item.tone === 'bad').text };
    }
    if (alerts.length) {
      return { label: '降级', tone: 'warn', note: alerts[0].text };
    }
    if (value.ready !== true) {
      return { label: '启动中', tone: 'warn', note: REASON_TEXT[value.reason] ?? '正在就绪' };
    }
    return { label: '正常', tone: 'ok', note: '收音、切段、识别全部就绪' };
  };

  /* ------------------------------------------------------------------
     概览
     ------------------------------------------------------------------ */

  const DROP_REASONS = Object.freeze({
    tts_overlap: '与本机 TTS 播放重叠',
    capture_interrupted: '采集中途断了',
  });

  const CHAIN_LABELS = Object.freeze({
    started: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停链', error: '错误',
  });
  const DICTATION_LABELS = Object.freeze({
    unloaded: '未加载', loading: '加载中', ready: '就绪', active: '听写中',
    warm: '保温', unloading: '卸载中', error: '错误',
  });
  const CAPTURE_LABELS = Object.freeze({
    not_requested: '无需求', acquiring: '取得中', active: '正常', silenced: '被系统静音',
    stalled: '无帧', released: '已释放', error: '错误', unknown: '无法判定',
  });

  /**
   * 语音链。⚠ 三行回答三个**不同的**问题，任何两行都不能互相推断：
   * 采集被电话抢占时仍然保留处理需求（需求没变，只是听不见）；
   * 听写 `warm` 时模型在内存里但没有人在用。把它们合成一个「开/关」会让停链前后
   * 看起来一模一样，而那正是这一轮要修的东西。
   */
  function renderChain(live, { pending = null, failure = null } = {}) {
    const lifecycle = live?.lifecycle;
    const capture = live?.capture;
    const chain = lifecycle?.chain ?? null;
    const started = chain === 'started';
    const label = pending === 'stop' ? '正在停止'
      : pending === 'start' ? '正在启动'
        : failure ? '操作失败'
          : CHAIN_LABELS[chain] ?? '无法判定';
    setBadge($('chain-state'), label, failure ? 'bad' : pending ? 'warn'
      : started ? 'ok' : chain === 'stopped' ? 'warn' : chain ? 'bad' : '');

    const warmMs = lifecycle?.warm?.remaining_ms ?? null;
    // ⚠ 不许替后端说「模型已卸载」——常驻策略是 service 时它们根本没卸，
    // 而一句说错的状态比不说更糟。文案按 `dictation` 的实际取值写。
    const resident = lifecycle && lifecycle.dictation !== 'unloaded';
    const detail = failure ? `失败：${failure}`
      : !lifecycle ? '正在读取…'
        : started
          ? '麦克风与识别链在运行；检测到语音后进入切段与识别。'
          : `服务仍在运行、API 仍可用；麦克风已释放。${
            resident ? '三张识别图仍挂在内存里（闲置几乎不占用），故随时可直接开始听写。'
              : '模型已卸载，第一次听写需要现场加载。'}`;
    setNote($('chain-detail'), detail, failure ? 'bad' : '');

    $('ov-capture').textContent = capture
      ? `${CAPTURE_LABELS[capture.capture?.state ?? 'unknown'] ?? '无法判定'}${
        capture.stale ? ' · 事件断线，读数已陈旧' : ''}`
      : '无法判定';
    $('ov-dictation').textContent = lifecycle
      ? `${DICTATION_LABELS[lifecycle.dictation] ?? '无法判定'}${
        lifecycle.dictation === 'warm' && warmMs !== null ? ` · 剩 ${seconds(warmMs)}` : ''}`
      : '—';

    const card = qs('.chain-card');
    if (card) card.classList.toggle('stopped', chain === 'stopped');
    return { chain, started, requesters: lifecycle?.requesters ?? [] };
  }


  /*
   * 点亮有两个**互不相同**的维度，混为一谈就会说谎：
   *
   *   active —— 这一站此刻真的在干活
   *   owner  —— 这一站此刻持有关门权（PipelineLease）
   *
   * CAM++ USER 确认后 owner 仍可留在 VAD，而 VAD **仍在切下一段**。用
   * `owner === stage` 当唯一依据，ASR 一开始转写 VAD 就无故变暗——
   * 那是把「谁能关门」误读成了「谁在工作」。lease 从来只回答后一个问题。
   */
  const STAGES = Object.freeze(['input', 'rms', 'vad', 'asr']);
  const stageCells = new Map();


  /* ------------------------------------------------------------------
     转写
     ------------------------------------------------------------------ */
  const transcriptMeta = (record) => [
    clock(record?.observed_ms),
    modelLabel(record?.backend ?? record?.model?.id),
    record?.timing?.inference_ms !== undefined && record?.timing?.inference_ms !== null
      ? `${record.timing.inference_ms} ms` : null,
    record?.segment_id ? `segment=${record.segment_id}` : null,
  ].filter(Boolean).join(' · ');

  /**
   * 记录分组。⛔ **不显示全生命周期累计**——旧页面顶着一个「累计 3032」，
   * 而那个数字对「现在怎么样」不提供任何信息，只会单调上涨。
   * 这里说的是：当前第几组、收了多少、盘上留着哪两组、音频还在不在。
   */
  /** 复制按钮要的那句话。由 [renderAsrLive] 唯一写入，见下。 */
  let latestForCopy = '';
  const latestText = () => latestForCopy;

  /**
   * ⭐ **概览与诊断的 ASR 文字由这一个函数写**（docs/075 收尾）。
   *
   * ⚠ 修的是两件事：
   *   ① 页面此前只看得见 commit；现在统一显示上游半快门的 incomplete 当前句，
   *      说话人不必等整句定稿才看到已经识别到的文字。
   *   ② 概览读记录组、诊断读 `asr.transcripts.last`（旧版控制器自己的最后一条），
   *      这两者必须保持同一份公共事实。
   * ⛔ 所以这里不是「把两处改成一样」——是**只留一个写入点**。两处各写各的，
   *   迟早会在某个分支上再次分岔，而分岔的那天没人会记得。
   */
  function renderAsrLive(value) {
    const current = value?.current?.status === 'incomplete' ? value.current : null;
    const committed = value?.committed ?? null;
    const currentText = String(current?.text ?? '');
    const currentBackend = current?.backend ?? value?.current_backend ?? value?.backend;

    // 半快门是正在识别；没有半快门时不要把上一句 final 挂在 current 上。
    const liveText = currentText || (current ? '正在识别…' : '等待语音…');
    const liveMeta = '';

    // 已定稿那一行：优先用记录组；记录组尚未刷新时用同一份 public.latest 兜底。
    const latest = value?.latest ?? null;
    const doneText = committed?.text || latest?.text || '尚未产生转写';

    // ⚠ `duration_ms` 是记录组投影里那个名字（docs/087 §15）；前面几个是旧形状的兼容读法。
    const audioMs = Number(committed?.duration_ms ?? committed?.audio?.duration_ms
      ?? committed?.audio_duration_ms ?? latest?.audio_duration_ms
      ?? latest?.audio?.duration_ms ?? latest?.duration_ms);
    const inferMs = Number(committed?.timing?.inference_ms ?? committed?.inference_ms ?? latest?.inference_ms ?? latest?.timing?.inference_ms);
    let doneMeta = '—';
    if (Number.isFinite(audioMs) && audioMs > 0 && Number.isFinite(inferMs) && inferMs > 0) {
      const speed = (audioMs / inferMs).toFixed(1).replace(/\.0$/, '');
      doneMeta = `${Math.round(audioMs)}ms => ${Math.round(inferMs)}ms | ${speed}x`;
    } else if (Number.isFinite(inferMs) && inferMs > 0) {
      doneMeta = `${Math.round(inferMs)}ms`;
    }

    /**
     * ⭐ **一个写入点写所有位置**（docs/075）。0.21.4 把概览那一对 id 从
     * `tx-*` 换成了 `ov-current` / `ov-latest`——⛔ 换 id 不等于可以再开一个渲染器：
     * 两处各写各的，迟早在某个分支上再次分岔。
     */
    for (const [textId, metaId] of [['ov-current', 'tx-live-meta'], ['asr-live-text', 'asr-live-meta']]) {
      const node = $(textId);
      if (!node) continue;
      node.textContent = liveText;
      node.closest('.live-fact')?.classList.toggle('is-idle', !current);
      if ($(metaId)) $(metaId).textContent = liveMeta;
    }
    for (const [textId, metaId] of [['ov-latest', 'tx-latest-meta'], ['asr-last-text', 'asr-last-detail']]) {
      if ($(textId)) $(textId).textContent = doneText;
      if ($(metaId)) $(metaId).textContent = doneMeta;
    }
    /**
     * ⭐ 复制按钮读的是**同一个渲染器算出来的那一份**，⛔ 不是从 DOM 里抠字符串：
     *   页面上的占位文案（「尚未产生转写」）是文案，不是转写结果。
     * ⚠ 没有 commit 时按钮 disabled——一个按下去什么都不发生的按钮，
     *   和一个复制了「尚未产生转写」六个字的按钮，都在骗人。
     */
    latestForCopy = committed?.text ?? latest?.text ?? '';
    for (const id of ['tx-copy-latest', 'copy-latest']) {
      if ($(id)) $(id).disabled = !committed;
    }
    return committed;
  }

  function renderTranscripts(records, onCopy) {
    const list = $('tx-history-list') || $('tx-list');
    if (!list) return records.at(-1) ?? null;

    // 最新 10 条，上新下旧（10条以后的不显示）
    const rows = [...records].slice(-10).reverse();
    list.replaceChildren(...rows.map((record) => {
      const li = document.createElement('li');
      li.className = 'tx-history-item';

      // 1. 日期时间
      const timeDiv = document.createElement('div');
      timeDiv.className = 'tx-time';
      const atMs = Number(record.observed_ms) || (record.completed_at ? Date.parse(record.completed_at) : null) || Date.now();
      const d = new Date(atMs);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      timeDiv.textContent = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;

      // 2. 内容
      const textDiv = document.createElement('div');
      textDiv.className = 'tx-text';
      textDiv.textContent = record.text || '（空白结果）';

      // 3. 音频 audio tag (格式参考 My Voice)
      /**
       * ⭐ **音频不在了就不要画播放器**（docs/091 PART G）。
       * ⚠ 旧行为是「只要有 segment_id 就画」——于是被 `history.wav_keep` 淘汰掉的
       *   那些句子仍然带着一个**必然 404/410** 的播放器：点下去没有任何反应，
       *   而使用者没有任何办法知道那是「过期了」还是「坏了」。
       */
      const audioWrap = document.createElement('div');
      audioWrap.className = 'tx-audio-wrap';
      if (record.segment_id && record.audio_available === false) {
        const gone = document.createElement('span');
        gone.className = 'tx-audio-gone';
        gone.textContent = '音频已过期';
        audioWrap.append(gone);
      } else if (record.segment_id) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.setAttribute('controlslist', 'nodownload noplaybackrate nofullscreen');
        audio.setAttribute('disableremoteplayback', '');
        audio.disableRemotePlayback = true;
        audio.src = `${getPkgPrefix()}/records/audio?segment_id=${encodeURIComponent(record.segment_id)}`;
        audioWrap.append(audio);
      }

      li.append(timeDiv, textDiv, audioWrap);
      return li;
    }));
    return records.at(-1) ?? null;
  }

  /* ------------------------------------------------------------------
     诊断
     ------------------------------------------------------------------ */
  function renderMemory(memory) {
    const el = $('mem-avail');
    if (!el) return;
    const mb = Number(memory?.avail_mb);
    if (!Number.isFinite(mb) || mb <= 0) {
      el.innerHTML = '<span class="muted" style="font-size:0.62rem;">MEM —</span>';
      el.title = memory?.error
        ? `内存读数取不到：${memory.error}`
        : '内存读数（尚未取到第一笔）';
      return;
    }
    const toG = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) / 1024).toFixed(2)}G` : '—');
    const used = Number(memory?.used_mb);
    const total = Number(memory?.total_mb);
    const swap = Number(memory?.swap_used_mb);
    const swapTotal = Number(memory?.swap_total_mb) || 8192; // 8.00GB ZRAM baseline

    // MEM 独立负载与比例（绿，橙，红）
    const memPct = total > 0 && Number.isFinite(used) ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
    const memTone = memory?.low_memory || mb < 1200 || memPct >= 88 ? 'bad' : (mb < 2000 || memPct >= 75) ? 'warn' : 'ok';

    // ZRAM 独立负载与比例（绿，橙，红）
    const swapVal = Number.isFinite(swap) ? swap : 0;
    const swapPct = swapTotal > 0 && Number.isFinite(swap) ? Math.min(100, Math.max(0, (swapVal / swapTotal) * 100)) : 0;
    const swapTone = swapPct >= 80 ? 'bad' : swapPct >= 50 ? 'warn' : 'ok';

    el.className = 'mem-cols';
    el.innerHTML = `
      <div class="mem-item mem-${memTone}">
        <span class="mem-lbl">MEM</span>
        <span class="mem-bracket">[</span><div class="mem-bar"><div class="mem-fill" style="width:${memPct.toFixed(1)}%;"></div><span class="mem-val">${toG(used)}</span></div><span class="mem-bracket">]</span>
        <span class="mem-total">${toG(total)}</span>
      </div>
      <div class="mem-item mem-${swapTone}">
        <span class="mem-lbl">ZRAM</span>
        <span class="mem-bracket">[</span><div class="mem-bar"><div class="mem-fill" style="width:${swapPct.toFixed(1)}%;"></div><span class="mem-val">${Number.isFinite(swap) ? toG(swap) : '0.00G'}</span></div><span class="mem-bracket">]</span>
        <span class="mem-total">${toG(swapTotal)}</span>
      </div>
    `;

    el.title = [
      `MEM 已用 ${used} MB / 总量 ${total} MB (${memPct.toFixed(1)}%)`,
      `可用 ${mb} MB —— MemAvailable`,
      Number.isFinite(swap) ? `ZRAM 已用 ${swap} MB / 总量 ${swapTotal} MB (${swapPct.toFixed(1)}%)` : '',
      Number.isFinite(Number(memory?.app_avail_mb))
        ? `App 口径 availMem ${memory.app_avail_mb} MB` : '',
    ].filter(Boolean).join('\n');
  }

  /**
   * 声纹前景门（docs/081）。⭐ 只显示，**不判断**：`ok` / `reason` / `authority`
   * 都由服务端算好，页面照抄。自己再判一次「算不算 stale」，就会出现两个答案。
   * ⚠ 「未校准」必须**明说会安全放行**——一个写着「未校准」却不说后果的提示，
   *   使用者会以为它正在丢东西。
   */
  const SPKGATE_REASON = Object.freeze({
    gate_disabled: '未启用',
    profile_missing: '还没有声纹',
    calibration_not_acknowledged: '阈值尚未确认',
    profile_changed: '声纹已重建，阈值需要重新确认',
    window_changed: '窗长改过，阈值需要重新确认',
    threshold_changed: '阈值改过，需要重新确认',
    calibrated: '已校准',
  });

  function renderSpeakerGate(gate, foreground) {
    const enabled = gate?.enabled === true;
    const ok = gate?.ok === true;
    /**
     * ⭐ 三态，不是两态：`ok` 说「校准齐了」，`armed` 说「可以拒绝了」。
     *   ⚠ 真机上这两者差了一整轮事故——门写着 `calibrated` 却一次都没认出使用者，
     *   于是连拒 4 段输入。把它们压成一个徽章，那一轮就完全看不出来。
     */
    const armed = gate?.armed === true;
    setBadge($('spkgate-badge'), !enabled ? 'OFF' : !ok ? 'BYPASS' : armed ? 'ARMED' : 'WATCHING',
      !enabled ? '' : armed ? 'ok' : 'warn');
    $('spkgate-authority').textContent = ({
      speaker: '声纹门', rms: '音量门（docs/079）', off: '不判段，全部放行',
    })[foreground?.authority] ?? '—';
    $('spkgate-profile').textContent = gate?.profile_ready
      ? `已登记 · ${String(gate.profile_fingerprint ?? '').slice(0, 12)}` : '未登记';
    const cfg = gate?.uservad_config ?? {};
    $('spkgate-calib').textContent = number(cfg.threshold) === null ? '—'
      : `${fixed(cfg.threshold, 2)} / ${cfg.window_ms} ms`;
    $('spkgate-state').textContent = !enabled ? '未启用'
      : !gate?.running ? '未在收音'
        : `${gate?.state === 'USER' ? '登记用户' : '其他'} · ${fixed(gate?.last_similarity, 3)}`;
    const warn = $('spkgate-warning');
    if (enabled && ok && !armed) {
      warn.hidden = false;
      warn.className = 'message warn';
      warn.textContent = '已启用，但这套校准下「还没认出过你一次」—— '
        + '在它至少判出一个「是你」之前，一律放行（既不挡背景，也不会挡你的语音输入）。'
        + '如果说了话仍然一直不 ARMED，多半是阈值对这份声纹太高，去 Speaker Lab 重新定。';
    } else if (enabled && !ok) {
      warn.hidden = false;
      warn.className = 'message warn';
      warn.textContent = `${SPKGATE_REASON[gate?.reason] ?? gate?.reason}`
        + ' —— 现在会安全放行，不会丢掉任何一段。到 Speaker Lab 确认阈值后才会开始判。';
    } else {
      warn.hidden = true;
      warn.textContent = '';
    }
    $('spkgate-enabled').checked = enabled;
  }

  /**
   * 「收音与语音链」——产品侧的两个动作与它们的前提。
   *
   * ⭐ 它回答的是**使用者的**问题：现在还在收音吗、还有谁在用、按下去会发生什么。
   * ⛔ 不显示 lease id、consumer 名、graph、holder——那些在诊断页。
   * ⚠ 「还在收音」的判据是 `pcm_consumers` 的**聚合**（docs/077），
   *   ⛔ 不是「语音链起没起」：链停了别人照样可以持有麦克风。
   */
  function renderAudioControl(lifecycle, consumers, input, listen) {
    const chain = lifecycle?.chain ?? null;
    const started = chain === 'started';
    const recording = input?.pcm?.recording === true;
    const holders = consumers?.pcm_holders ?? [];
    const others = (input?.demand?.holders ?? []).filter((id) => !String(id).startsWith('termux-speech'));

    setBadge($('ac-badge'), recording ? '正在收音' : '未收音', recording ? 'ok' : '');
    facts($('ac-facts'), [
      ['麦克风', recording ? '开着' : '已停'],
      ['语音链', started ? '运行中' : chain === 'stopped' ? '已停止' : '无法判定'],
      ['本包在用', holders.length ? `${holders.length} 项` : '无'],
      /**
       * ⭐ **语音输入此刻归谁**（docs/060）：它随时会被别的 package（如 termux-ime）
       *   接管，而一个显示着几分钟前归属的页面，比不显示更糟。
       * ⚠ `直通` 指调用方直接请求听写——那是它进来的方式，不是别的状态。
       */
      ['语音输入归谁', listen?.engaged === true
        ? `${listen.requester ?? '未知调用方'}`
        : '无人'],
      /** ⚠ 别人也持着麦克风时必须说出来：那时「停止收音」不会让绿点熄灭。 */
      ['其他持有者', others.length ? others.join('、') : '无'],
    ]);

    const chainBtn = $('ac-chain');
    if (chainBtn) {
      setText(chainBtn, started ? '停止语音链' : '启动语音链');
      chainBtn.className = started ? 'secondary' : 'primary';
      chainBtn.disabled = chain === null;
    }
  }

  function renderInputDiag(value) {
    const mic = micState(value);
    setBadge($('input-state'), mic.label, mic.tone === 'unknown' ? '' : mic.tone);
    setNote($('input-note'), mic.detail);
    const pcm = value?.pcm;
    facts(qs('#diag-input .facts'), [
      ['配置选择', value?.selection?.selector],
      ['实际路由', labelDevice(value?.selection?.routed_device)],
      ['编码', pcm?.encoding],
      ['采样率', pcm?.sample_rate_hz ? `${pcm.sample_rate_hz} Hz` : null],
      ['帧序号', pcm?.frame_seq],
      ['帧龄', pcm?.last_frame_age_ms !== null && pcm?.last_frame_age_ms !== undefined
        ? `${pcm.last_frame_age_ms} ms` : null],
    ]);
  }

  function renderRms(gate) {
    const current = number(gate?.current) ?? 0;
    const gateOpen = gate?.available === true && gate?.pcm_admission === 'allow';
    /** 兼容已打开的旧 DOM：dev 版直改文件后，节点缺失也不能让倒计时消失。 */
    let camCountdown = $('rms-cam-countdown');
    if (!camCountdown) {
      const card = qs('.rms-card');
      const bar = card?.querySelector('.rms-bar');
      if (card && bar) {
        camCountdown = document.createElement('p');
        camCountdown.id = 'rms-cam-countdown';
        camCountdown.className = 'note';
        card.insertBefore(camCountdown, bar);
      }
    }
    const admission = gate?.automatic_cam_admission ?? {};
    const remaining = number(admission.remaining_seconds);
    setText(camCountdown, admission.active === true && remaining !== null
      ? `CAM++ 等待确认 USER 倒计时：${Math.max(0, Math.ceil(remaining))} 秒`
      : admission.confirmed_user_at_ms
        ? `CAM++ USER 已确认（${admission.user_state ?? 'USER'}）`
        : gateOpen ? 'CAM++ 等待确认 USER' : 'CAM++ 等待确认 USER：等待 RMS 开门');
    $('rms-current').textContent = fixed(gate?.current);
    $('rms-avg').textContent = fixed(gate?.avg_100ms ?? gate?.decision_value);
    $('rms-peak').textContent = fixed(gate?.peak_10s);
    setText($('rms-threshold'), fixed(gate?.open_threshold));
    setText($('rms-admission'), gateOpen
      ? 'open · PCM 进入 CAM++ / VAD' : 'waiting · PCM 只进滚动环');
    $('rms-bar-value').textContent = current.toFixed(4);
    setStyle($('rms-fill'), 'width', percent(current, RMS_BAR_MAX));
    setStyle($('rms-open-marker'), 'left', percent(gate?.open_threshold, RMS_BAR_MAX));
    qs('.rms-bar')?.setAttribute('aria-valuenow', String(current));
    setBadge(
      $('rms-state'),
      gateOpen ? 'OPEN' : gate?.open_armed === false ? 'REARM' : 'ARMED',
      gateOpen ? 'ok' : gate?.open_armed === false ? 'warn' : '',
    );
    qs('.rms-card')?.classList.toggle('gate-open', gateOpen);
  }

  function renderVad(vad, cam, listen, pipeline) {
    const probability = number(vad?.activity?.probability);
    const active = vad?.activity?.active === true;
    const handoff = vad?.handoff?.active === true;
    const camLive = cam?.active === true || cam?.automatic_cam_live === true;
    const last = vad?.wav?.last_segment;
    const mode = listen?.engaged === true ? 'FireRedVAD · 手动'
      : cam?.vad_mode === 'camplus_automatic' ? 'CAM++VAD · 自动' : '未启用';
    setText($('vad-mode'), `VAD 模式：${mode}`);
    $('vad-probability').textContent = fixed(probability, 3);
    $('vad-countdown').textContent = seconds(vad?.countdown?.remaining_ms);
    $('vad-wav-total').textContent = String(vad?.wav?.segments_published ?? 0);
    setStyle($('vad-fill'), 'width', percent(probability));
    $('vad-fill').className = `vad-fill ${active ? 'speech' : ''}`.trim();
    $('vad-live-label').textContent = active ? '语音中' : handoff ? '寻找切点' : '待机';
    setText($('vad-owner'), pipeline?.owner ?? (listen?.engaged ? 'speech.vad' : 'speech.rms'));
    setText($('vad-live'), listen?.engaged
      ? (active || handoff ? 'FireRedVAD 正在处理' : 'FireRedVAD 等待声音')
      : camLive ? 'CAM++ live inference' : 'CAM++ waiting for RMS');
    qs('.vad-meter')?.setAttribute('aria-valuenow', String(probability ?? 0));
    setBadge($('vad-state'), active ? 'SPEECH' : handoff ? 'PROCESSING' : 'IDLE', active || handoff ? 'ok' : '');
    setNote($('vad-note'), vad?.last_error
      ? `VAD 异常：${vad.last_error}`
      : handoff
        ? `回溯 ${seconds(vad?.handoff?.pre_roll_ms)} · 推理 ${vad?.last_inference_ms ?? '—'} ms · 梯度切句 ${
          vad?.gradient?.cuts ?? 0} 次`
        : `模型${vad?.model?.files_present ? '已就绪' : '缺失'} · ${
          listen?.engaged ? '手动 FireRedVAD' : camLive ? '自动 CAM++ live' : '等待 RMS 准入'}`,
    vad?.last_error ? 'bad' : vad?.model?.files_present ? 'good' : 'bad');
    $('vad-last-wav').textContent = last?.wav_path ?? '尚未产出';
    $('vad-last-wav-detail').textContent = last
      ? `${last.duration_ms} ms · trim ${last.trim?.leading_non_speech_ms ?? 0} ms · 本次运行第 ${
        vad?.wav?.segments_published ?? 0} 段`
      : '—';

    // 被丢弃的段没有 WAV、没有进 ASR、也没有转写——不在这里说出来它就彻底不可见。
    const drops = vad?.drops;
    $('vad-drops').textContent = String(drops?.total ?? 0);
    const lastDrop = drops?.last;
    $('vad-drop-detail').textContent = !drops
      ? '—'
      : drops.total === 0
        ? (vad?.timeline?.mono_available === false
          ? '尚无 · ⚠ 还没收到 PCM 时间锚，此刻无法判定 TTS 重叠'
          : `尚无 · TTS 重叠 ${drops.tts_overlap ?? 0} / 采集中断 ${drops.capture_interrupted ?? 0}`)
        : `TTS 重叠 ${drops.tts_overlap ?? 0} / 采集中断 ${drops.capture_interrupted ?? 0}${
          lastDrop ? ` · 最后一次：${DROP_REASONS[lastDrop.reason] ?? lastDrop.reason}` : ''}`;
  }

  function renderAsr(asr, pipeline, asrBackend) {
    const owner = pipeline?.owner ?? 'speech.rms';
    const authoritative = asr?.authority?.active === true && owner === 'speech.asr';
    const state = asr?.state?.toUpperCase() ?? 'IDLE';
    const selected = asr?.model?.selected;
    const runtimeReady = selected?.ready === true;
    setBadge($('asr-state'), state,
      asr?.last_error ? 'bad' : ['QUEUED', 'TRANSCRIBING', 'LISTENING'].includes(state) ? 'ok' : '');
    $('asr-owner').textContent = authoritative ? 'speech.asr' : owner;
    $('asr-countdown').textContent = seconds(asr?.ending?.remaining_ms);
    $('asr-total').textContent = String(asr?.transcripts?.total ?? 0);
    const modelName = modelLabel(selected?.id ?? asr?.model?.model ?? 'sensevoice');
    const htp = asr?.model?.htp ?? 'v73';
    const qnn = asr?.model?.qnn ? `QNN ${asr?.model?.qnn}` : 'QNN 2.47';
    setBadge($('asr-precision'), `${modelName} (${htp}|${qnn})`, 'tag');
    const elNote = $('asr-note');
    if (elNote) {
      if (asr?.last_error) {
        setNote(elNote, `ASR 异常：${asr.last_error}`, 'bad');
      } else {
        const depth = Math.max(0, Math.min(5, Number(asr?.queue?.depth) || 0));
        const qHtml = Array.from({ length: 5 }, (_, i) => (i < depth
          ? '<span class="q-sq full">■</span>'
          : '<span class="q-sq empty">□</span>'
        )).join(' ');
        if (elNote.innerHTML !== qHtml) {
          elNote.innerHTML = qHtml;
        }
        elNote.className = 'note asr-queue-note';
      }
    }
    /**
     * ⭐ **automatic 与「本包觉得自己 ready」是两行**（docs/090 §5）。
     * ⚠ 真机上它们曾经一个说已就绪、一个一个字都跑不出来；写成一行就永远看不见那件事。
     */
    // ⚠ 本函数里 `state` 已经是 ASR 状态字符串（第一行就被占了）——
    //   readiness 必须作为参数传进来，⛔ 不许在这里再造一个同名的东西。
    const executable = asrBackend?.app_executable ?? null;
    const autoReady = asrBackend?.automatic_ready;
    const lastAsrError = asrBackend?.app_asr_error ?? null;
    facts($('asr-model-facts'), [
      ['当前档位', modelLabel(selected?.id ?? asr?.model?.model)],
      ['选中档位状态', selected?.ready === true ? '已就绪'
        : selected?.reason ?? '无法判定'],
      ['自动转写可执行', autoReady === true ? '可执行'
        : autoReady === false ? `未就绪：${executable?.reason ?? executable?.state ?? '未知'}`
          : 'App 尚未上报'],
      ['执行体', executable?.resident_id ?? executable?.session ?? null],
      ...(executable?.ambiguous === true
        // 同一个模型有多个已加载常驻：不是错误，但必须看得见——⛔ 静默取第一个会让
        // 一次重复声明泄漏永远查不出来。
        ? [['⚠ 重复常驻', (executable.candidates ?? []).join(' / ')]]
        : []),
      ...(lastAsrError
        ? [['最近一次自动转写错误',
          `${lastAsrError.kind}×${lastAsrError.count}：${lastAsrError.error}`]]
        : []),
      ['运行时', asr?.model?.runtime],
      ['当前 session', asr?.model?.session ?? (selected?.session_loaded ? 'App session' : null)],
      ['SenseVoice 资产', asr?.model?.files_present === true ? '已就位'
        : asr?.model?.files_present === false ? '缺失' : null],
      ['CTC 输出名', asr?.model?.output_name],
      ['队列深度', asr?.queue?.depth],
      // ⭐ 空白丢弃数。它一直在涨而「本次转写」不动 = 流水线在空转（多半是误触发），
      // 这件事在空白被当成正常转写写进记录组的时候完全看不见。
      ['空白已丢弃', blankLabel(asr?.transcripts?.blank_discarded)],
    ]);
  }

  const BLANK_REASONS = {
    empty: '解码为空',
    whitespace_only: '只有空白',
    invisible_only: '只有不可见字符',
  };

  function blankLabel(blank) {
    const count = Number(blank?.count) || 0;
    if (!count) return '0 条';
    const reason = BLANK_REASONS[blank?.last_reason] ?? blank?.last_reason ?? '—';
    return `${count} 条 · 最近：${reason}`;
  }

  /**
   * 人类可读的诊断结论。
   * ⚠ 每一条要么由后端事实推出，要么明说「无法判定」——前端不许猜故障原因。
   */
  function renderDiagSummary(live, listen) {
    const value = live?.input;
    const lines = [];
    const add = (tone, text) => lines.push({ tone, text });

    if (!value) add('unknown', '无法判定：尚未读到 speech.input 投影。');
    else {
      const mic = micState(value);
      add(mic.tone === 'ok' ? 'ok' : mic.tone, `麦克风${mic.label}——${mic.detail}。`);
      const gate = live.rms_gate;
      const gateOpen = gate?.available === true && gate?.pcm_admission === 'allow';
      add(gateOpen ? 'ok' : '',
        gate?.available === false
          ? '音量门不可用：PCM 不可用是安全兜底，此时不会向下游送入语音段。'
          : gateOpen
            ? `音量门已开（AVG 100ms ${fixed(gate?.decision_value, 3)} ≥ 阈值 ${fixed(gate?.open_threshold, 3)}）。`
            : `音量门闭合中，等待 AVG 100ms ${fixed(gate?.decision_value, 3)} 越过阈值 ${
              fixed(gate?.open_threshold, 3)}${gate?.open_armed === false ? '（且需先掉回阈值以下重置）' : ''}。`);

      const vad = live.vad;
      if (vad?.model?.files_present !== true) add('bad', 'FireRedVAD 模型文件缺失，切段无法工作。');
      else if (vad?.last_error) add('bad', `切段异常：${vad.last_error}`);
      else if (vad?.activity?.processed_frames > 0) {
        add('ok', `切段正常：已处理 ${vad.activity.processed_frames} 帧，本次运行产出 ${
          vad?.wav?.segments_published ?? 0} 段。`);
      } else add('unknown', '切段无法判定：本次运行还没有处理过任何一帧。');

      const asr = live.asr;
      const selected = asr?.model?.selected;
      if (asr?.last_error) add('bad', `识别异常：${asr.last_error}`);
      else if (!selected) {
        add('unknown', '识别档位的资产无法判定：后端没有报告被选中的那一档。');
      } else if (selected.ready !== true) {
        // 文件型 backend 报缺哪个文件；App 型 backend 报 session 的真实原因。
        const detail = (selected.missing ?? []).join('、') || selected.reason || '未就绪';
        add('bad', `${modelLabel(selected.id)} 未就绪：${detail}`);
      } else {
        add('ok', `识别就绪：${modelLabel(selected.id)}，本次运行 ${
          asr?.transcripts?.published_this_run ?? 0} 条。`);
      }

      /** 常驻图是资源事实，不能冒充当前 active；当前活动看明确的 live 投影。 */
      const cam = live.speaker_activity;
      if (cam?.vad_mode === 'camplus_automatic') {
        add(cam.active === true ? 'ok' : 'warn', cam.active === true
          ? 'CAM++ 正在接收 RMS 准入的 PCM。'
          : 'CAM++ 图已就绪，但 RMS 未准入，当前没有 CAM++ 推理。');
      } else if (listen?.engaged) {
        add('ok', '手动模式由 FireRedVAD 接收 PCM。');
      }

      /**
       * ⭐ 谁在执行高频判决。**这一行是事实陈述**：`executor` 由后端按
       * 「执行体真的在跑吗」算出来，⛔ 页面不许从配置值去猜（docs/087 P3）。
       */
      if (cam?.executor === 'app') {
        const app = cam.app ?? {};
        add(app.app_profile_ready === true ? 'ok' : 'warn',
          `VAD / 声纹执行者：App（状态 ${app.app_state ?? '—'} · 声纹${
            app.app_profile_ready === true ? `已同步 ${app.profile_fingerprint ?? ''}` : '未就绪'
          } · 转移 ${app.transitions ?? 0} 次 · 段落 ${app.segments_delivered ?? 0} 段）。`);
        // ⭐ 这条正是 P3 的目的：平时不再搬 PCM。把它摆出来，好过让人去猜。
        const holders = live.pcm_consumers?.pcm_holders ?? [];
        add(holders.length === 0 ? 'ok' : 'warn', holders.length === 0
          ? '官方链当前没有任何 PCM 消费者（PCM 不出 App）。'
          : `仍有 PCM 消费者：${holders.join('、')}。`);
        if (app.last_error) add('bad', `App 执行体异常：${app.last_error}`);
      } else if (cam?.executor_mode && cam.executor_mode !== 'legacy_speech') {
        add('warn', `VAD / 声纹执行者：本包（已选 ${cam.executor_mode}，但 App 执行体没有接手）。`);
      }

      const observed = live.states?.observed ?? {};
      const tts = observed['speech.tts'];
      if (!tts) add('unknown', '状态总线：还没读过输出侧（门未接近阈值时不读，这是设计如此）。');
      else if (tts.live !== true) add('warn', `状态总线：speech.tts 不新鲜（${tts.stale_reason ?? 'unknown'}）。`);
      else add('ok', `状态总线正常：speech.tts=${tts.value}，已推送 ${live.states?.writes ?? 0} 次。`);
    }

    textList($('diag-summary'), lines, (item) => item.tone);
    const ready = value?.ready === true;
    setBadge($('ready-badge'), ready ? 'READY' : 'NOT READY', ready ? 'ok' : 'warn');
  }

  window.SpeechViews = {
    $,
    /** ⚠ 产品页也要写文本；⛔ 不在 app.js 再抄一份「只在变了时才写」的守卫。 */
    setText,
    qs,
    number,
    fixed,
    seconds,
    labelDevice,
    setBadge,
    setNote,
    modelLabel,
    MODEL_LABELS,
    RMS_BAR_MAX,
    renderChain,
    renderTranscripts,
    renderAsrLive,
    latestText,
    renderMemory,
    // ⭐ 按域拆开暴露。整块重画意味着一次音量变化要跑九个渲染器，
    // 而其中八个的数据一个字都没变（真机实测：诊断页可见时这件事值 18.4% 的一个核）。
    renderDiagSummary,
    renderAudioControl,
    renderInputDiag,
    renderRms,
    renderVad,
    renderAsr,
    renderSpeakerGate,
  };
})();

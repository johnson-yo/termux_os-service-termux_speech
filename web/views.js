/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The state domains map (`/state/ws`) plus `/listen` and record payloads, already fetched.
 * [OUTPUT]: `window.SpeechViews` — shared formatters plus every Overview/Diagnostics render function.
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

  const MODEL_LABELS = Object.freeze({
    sensevoice: 'SenseVoice',
    'qwen3-q4': 'Qwen3-ASR Q4',
    'qwen3-q8': 'Qwen3-ASR Q8',
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
    // 问的是「我选的这个模型在不在」，所以看 selected 而不是那个只答 SenseVoice 的 files_present。
    const selected = live?.asr?.model?.selected;
    if (selected?.files_present === false) {
      push('bad', `${modelLabel(selected.id)} 模型文件缺失：${(selected.missing ?? []).join('、') || '清单未提供'}`);
    }
    if (live?.vad?.last_error) push('bad', `VAD 异常：${live.vad.last_error}`);
    if (live?.asr?.last_error) push('bad', `ASR 异常：${live.asr.last_error}`);
    if (live?.kws?.ready === false && live.kws.reason) push('warn', `唤醒未就绪：${live.kws.reason}`);
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
    return { label: '正常', tone: 'ok', note: '收音、唤醒、切段、识别全部就绪' };
  };

  /* ------------------------------------------------------------------
     概览
     ------------------------------------------------------------------ */
  function renderOverview(live) {
    const value = live?.input;
    const alerts = collectAlerts(live);
    const health = deriveHealth(live, alerts);
    setBadge($('health-badge'), health.label, health.tone);
    setNote($('health-note'), health.note, health.tone === 'ok' ? 'good' : health.tone === 'bad' ? 'bad' : '');

    const mic = micState(value);
    $('ov-mic').textContent = `${mic.label} · ${mic.detail}`;
    const routed = value?.selection?.routed_device ?? value?.selection?.preferred_device;
    const routeClass = live?.states?.published?.['audio.input.route'];
    $('ov-route').textContent = `${labelDevice(routed)}（${ROUTE_LABELS[routeClass] ?? '无法判定'}）`;
    const model = live?.asr?.model;
    // ⚠ 说的是**被选中的那一档**在不在，不是 SenseVoice 在不在。
    $('ov-model').textContent = model
      ? `${modelLabel(model.selected?.id ?? model.model)}${
        model.selected?.files_present === false ? ' · ⚠ 模型文件缺失' : ''}`
      : '无法判定';

    const list = $('alert-list');
    $('alerts').hidden = alerts.length === 0;
    if (list) {
      textList(list, alerts, (item) => item.tone);
    }
  }

  const DROP_REASONS = Object.freeze({
    tts_overlap: '与本机 TTS 播放重叠',
    capture_interrupted: '采集中途断了',
  });

  const CHAIN_LABELS = Object.freeze({
    started: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停链', error: '错误',
  });
  const WAKE_LABELS = Object.freeze({
    unloaded: '未加载', loading: '加载中', ready: '守候中', unloading: '卸载中', error: '错误',
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
   * 采集被电话抢占时是 `silenced` 而唤醒组仍然 ready（需求没变，只是听不见）；
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
          ? '麦克风与唤醒组在守着；说出唤醒词即可进入听写。'
          : `服务仍在运行、API 仍可用；麦克风已释放。${
            resident ? '三张识别图仍挂在内存里（闲置几乎不占用），故随时可直接开始听写。'
              : '模型已卸载，第一次听写需要现场加载。'}`;
    setNote($('chain-detail'), detail, failure ? 'bad' : '');

    $('ov-capture').textContent = capture
      ? `${CAPTURE_LABELS[capture.capture?.state ?? 'unknown'] ?? '无法判定'}${
        capture.stale ? ' · 事件断线，读数已陈旧' : ''}`
      : '无法判定';
    $('ov-wake').textContent = lifecycle ? (WAKE_LABELS[lifecycle.wake] ?? '无法判定') : '—';
    $('ov-dictation').textContent = lifecycle
      ? `${DICTATION_LABELS[lifecycle.dictation] ?? '无法判定'}${
        lifecycle.dictation === 'warm' && warmMs !== null ? ` · 剩 ${seconds(warmMs)}` : ''}`
      : '—';

    const toggle = $('chain-toggle');
    if (toggle) {
      toggle.textContent = pending === 'stop' ? '正在停止…'
        : pending === 'start' ? '正在启动…'
          : started ? '停止语音链' : '启动语音链';
      toggle.className = started ? 'wide danger' : 'wide';
      toggle.disabled = pending !== null || chain === null;
    }
    const card = qs('.chain-card');
    if (card) card.classList.toggle('stopped', chain === 'stopped');
    return { chain, started, requesters: lifecycle?.requesters ?? [] };
  }

  /**
   * 听写 Listen 的状态显示。
   *
   * ⚠ 「正在启动 / 正在退出」不是后端状态——后端的 enter/exit 是同步的一次 HTTP，
   * 没有中间态可读。它们是**本页自己的请求还在飞**，所以由调用方用 `pending` 传进来，
   * 而不是从 `/listen` 里读一个不存在的字段（那正是 docs/056 的形状）。
   */
  function renderListen(listen, { pending = null, failure = null } = {}) {
    const card = qs('.listen-card');
    const engaged = listen?.engaged === true;
    const requester = listen?.requester ?? null;
    const mine = requester === 'webui';
    const held = engaged && !mine;

    const label = pending === 'enter' ? '正在启动'
      : pending === 'exit' ? '正在退出'
        : failure ? '操作失败'
          : !engaged ? '未听写'
            : mine ? '本页听写中' : '外部持有';
    const tone = failure ? 'bad' : pending ? 'warn' : engaged ? (mine ? 'ok' : 'warn') : '';
    setBadge($('listen-state'), label, tone);

    const detail = failure ? `失败：${failure}`
      : !engaged ? '流水线按正常的唤醒词流程工作。'
        : `由 ${requester ?? '未知调用方'} 持有 · 原因 ${listen?.reason ?? '未提供'} · 已持续 ${
          listen?.engaged_at_ms ? seconds(Date.now() - listen.engaged_at_ms) : '—'}`;
    setNote($('listen-detail'), detail, failure ? 'bad' : '');

    const toggle = $('listen-toggle');
    if (toggle) {
      toggle.textContent = pending === 'enter' ? '正在启动…'
        : pending === 'exit' ? '正在退出…'
          : engaged ? (mine ? '停止听写' : `停止听写（${requester} 持有）`) : '开始听写';
      toggle.className = engaged ? 'wide danger' : 'wide';
      toggle.disabled = pending !== null;
    }
    if (card) {
      card.classList.toggle('engaged', engaged && mine);
      card.classList.toggle('held', held);
    }
    return { engaged, requester, mine, held };
  }

  /*
   * 点亮有两个**互不相同**的维度，混为一谈就会说谎：
   *
   *   active —— 这一站此刻真的在干活
   *   owner  —— 这一站此刻持有关门权（PipelineLease）
   *
   * 首个 WAV 发布后 owner 就交给了 ASR，但 VAD **仍在切下一段**。用
   * `owner === stage` 当唯一依据，ASR 一开始转写 VAD 就无故变暗——
   * 那是把「谁能关门」误读成了「谁在工作」。lease 从来只回答后一个问题。
   */
  const STAGES = Object.freeze(['input', 'rms', 'kws', 'vad', 'asr']);
  const stageCells = new Map();

  /**
   * ⚠ 这些字段现在直接读**顶层的域**。它们过去是从 `live.value`（speech.input 投影）里读的，
   * 而那份投影只是把顶层这五个对象原样嵌了一遍——同一批数据每次都发两份。
   */
  function renderStages(live, listen) {
    const value = live?.input;
    const stream = live?.pcm_stream;
    const gate = live?.rms_gate;
    const kws = live?.kws;
    const vad = live?.vad;
    const asr = live?.asr;
    const owner = (live?.pipeline?.owner ?? 'speech.rms').replace('speech.', '');
    const bypassed = listen?.engaged === true;

    const frameFresh = value?.pcm?.recording === true
      && stream?.connected === true
      && number(stream.last_frame_age_ms) !== null
      && number(stream.last_frame_age_ms) < 1000;
    const gateOpen = gate?.available === true && gate?.pcm_admission === 'allow';
    const hit = recentHit(kws?.last_hit);
    const vadArmed = vad?.handoff?.active === true;
    const asrBusy = ['queued', 'transcribing'].includes(asr?.state);

    const active = {
      input: frameFresh,
      rms: gateOpen,
      kws: owner === 'kws',
      vad: vadArmed,                       // ← 交权给 ASR 之后依然为真
      asr: asrBusy || owner === 'asr',
    };
    const ownerStage = STAGES.includes(owner) ? owner : 'rms';

    const detail = {
      input: frameFresh
        ? `${deviceName(value?.selection?.routed_device)} · 帧龄 ${stream.last_frame_age_ms} ms`
        : value?.pcm?.recording ? '已开启但帧不新鲜' : '未采集',
      rms: `${gateOpen ? '已开' : gate?.open_armed === false ? '待重置' : '待命'} · AVG ${
        fixed(gate?.decision_value, 3)} / 阈值 ${fixed(gate?.open_threshold, 3)}`,
      // 直通必须说清楚是直通。把它画成一次 HIT 是纯粹的谎话。
      kws: bypassed
        ? '直通／已绕过唤醒'
        : `${hit ? '刚刚命中' : owner === 'kws' ? '正在聆听'
          : STAGES.indexOf(owner) > 2 ? '本轮已通过'
            : kws?.profile?.built ? '等待音量门' : '唤醒词尚未生成'} · ${
          kws?.profile?.display_name ? `「${kws.profile.display_name}」` : '未设置'} ${fixed(kws?.stream?.score, 2)}`,
      vad: `${vad?.activity?.active === true ? '检测到语音' : vadArmed ? '寻找切点' : '待机'} · p=${
        fixed(vad?.activity?.probability, 2)} · ${vad?.wav?.segments_published ?? 0} 段`,
      asr: `${(asr?.state ?? 'standby')
        .replace('transcribing', '转写中')
        .replace('queued', '排队中')
        .replace('listening', '聆听中')
        .replace('standby', '待机')} · ${asr?.transcripts?.published_this_run ?? 0} 条 · ${
        asr?.last_inference_ms ?? '—'} ms`,
    };

    for (const stage of STAGES) {
      // 节点引用缓存：`querySelector` 每次都要重新遍历 DOM，而这五格从不改变身份。
      let cell = stageCells.get(stage);
      if (!cell) {
        cell = qs(`.stage-row[data-stage="${stage}"]`);
        if (!cell) continue;
        stageCells.set(stage, cell);
      }
      setText(cell.querySelector('small'), detail[stage]);
      setClass(cell, 'active', active[stage] === true);
      setClass(cell, 'owner', stage === ownerStage);
      // 流进这一站的那段连线。第一站没有入边。
      setClass(cell, 'flow', active[stage] === true && STAGES.indexOf(stage) > 0);
    }

    const remaining = owner === 'kws' ? kws?.countdown?.remaining_ms
      : owner === 'vad' ? vad?.countdown?.remaining_ms
        : owner === 'asr' ? asr?.ending?.remaining_ms : null;
    setNote($('stage-note'), owner === 'rms'
      ? (frameFresh ? `待机于音量门 · 关门权 rms` : 'PCM 未采集，流水线停在收音')
      : `${owner} 持关门权${bypassed ? '（听写模式：不自动收工）' : ` · 倒计时 ${seconds(remaining)}`}`);

    const badge = owner === 'rms' ? (frameFresh ? 'IDLE' : value?.pcm?.recording ? 'STALE' : 'IDLE')
      : owner.toUpperCase();
    setBadge($('pipeline-live'), badge, owner === 'rms' ? (frameFresh ? '' : 'warn') : 'ok');
    setText($('pipeline-note'), owner === 'rms'
      ? (frameFresh ? `待机 · AVG ${fixed(gate?.decision_value, 3)}` : 'PCM 未采集')
      : `${owner.toUpperCase()} 持关门权 · 倒计时 ${seconds(remaining)}`);
  }

  /* ------------------------------------------------------------------
     转写
     ------------------------------------------------------------------ */
  const transcriptMeta = (record) => [
    clock(record?.observed_ms),
    modelLabel(record?.model?.id),
    record?.timing?.inference_ms !== undefined && record?.timing?.inference_ms !== null
      ? `${record.timing.inference_ms} ms` : null,
    record?.segment_id ? `segment=${record.segment_id}` : null,
    record?.end_gate?.keyword_matched ? `结束词「${record.end_gate.keyword_matched}」` : null,
  ].filter(Boolean).join(' · ');

  /**
   * 记录分组。⛔ **不显示全生命周期累计**——旧页面顶着一个「累计 3032」，
   * 而那个数字对「现在怎么样」不提供任何信息，只会单调上涨。
   * 这里说的是：当前第几组、收了多少、盘上留着哪两组、音频还在不在。
   */
  function renderRecords(records) {
    const active = records?.active;
    $('rec-group').textContent = active
      ? `第 ${active.group_seq} 组（${active.group_id}）` : '尚未开始';
    // ⚠ 「转写中」不再从组里读：组里每一条都已经有结论了（准入后移之后没有 pending）。
    // 还在转写的段是 ASR 队列的事实，由 `renderAsr` 那边显示。
    $('rec-progress').textContent = active ? active.progress : '—';

    const list = $('rec-groups');
    if (list) {
      list.replaceChildren(...(records?.groups ?? []).map((group) => {
        const li = document.createElement('li');
        const name = document.createElement('strong');
        name.textContent = `第 ${group.group_seq} 组`;
        const meta = document.createElement('small');
        const stateText = group.state === 'completed' ? '已完成'
          : group.state === 'active' ? '收集中' : group.state;
        meta.textContent = `${stateText} · ${group.item_count}/${records.group_size} · 音频${
          group.wav_available ? '在盘上' : '已归档'}`;
        li.append(name, meta);
        return li;
      }));
    }

    const archive = records?.archive;
    const rotation = records?.last_rotation;
    $('rec-note').textContent = !records ? '—'
      : archive && archive.available === false
        ? `⚠ 归档不可用（${archive.last_error ?? '未提供原因'}）：轮转已暂停，音频不会被删除。`
        : `更旧的组已归档：${archive?.groups ?? 0} 组 / ${archive?.items ?? 0} 条**只剩文字**，音频已删除。${
          rotation?.skipped ? ` 上次轮转跳过 ${rotation.skipped}（${rotation.reason}）。` : ''}`;
  }

  function renderTranscripts(records, onCopy) {
    const latest = records.at(-1) ?? null;
    $('tx-latest-text').textContent = latest
      ? (latest.text || '（空白结果）')
      : '尚未产生转写';
    $('tx-latest-meta').textContent = latest ? transcriptMeta(latest) : '—';
    $('tx-copy-latest').disabled = !latest;

    const list = $('tx-list');
    // 最新的在上面：日常使用最关心的永远是刚说完的那一句。
    const rows = [...records].slice(0, -1).reverse();
    list.replaceChildren(...rows.map((record) => {
      const li = document.createElement('li');
      const body = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = record.text || '（空白结果）';
      const meta = document.createElement('small');
      meta.textContent = transcriptMeta(record);
      body.append(text, meta);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = '复制';
      copy.addEventListener('click', () => onCopy(record.text ?? ''));
      li.append(body, copy);
      return li;
    }));
    return latest;
  }

  /* ------------------------------------------------------------------
     诊断
     ------------------------------------------------------------------ */
  function renderMemory(memory) {
    const el = $('mem-avail');
    if (!el) return;
    const mb = Number(memory?.avail_mb);
    if (!Number.isFinite(mb) || mb <= 0) {
      setBadge(el, 'MEM —', '');
      el.title = memory?.error
        ? `内存读数取不到：${memory.error}`
        : '内存读数（尚未取到第一笔）';
      return;
    }
    const g = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) / 1024).toFixed(2)}G` : '—');
    const used = Number(memory?.used_mb);
    const total = Number(memory?.total_mb);
    const swap = Number(memory?.swap_used_mb);
    // 显示「已用 / 总量」而不是只显示可用：使用者的心智模型就是这个。
    // ZRAM 并列，因为模型的匿名脏页大多在那儿——不显示它，就会看到
    // 「换了更大的模型，可用内存反而变多」这种自相矛盾的读数。
    const swapPart = Number.isFinite(swap) && swap > 0 ? ` · ZRAM ${g(swap)}` : '';
    const tone = memory?.low_memory || mb < 1900 ? 'bad' : mb < 2100 ? 'warn' : 'ok';
    setBadge(el, `MEM ${g(used)}/${g(total)}${swapPart}`, tone);
    el.title = [
      `已用 ${used} MB / 总量 ${total} MB（读自 /proc/meminfo）`,
      `可用 ${mb} MB —— 这是 MemAvailable，含可回收的页快取，不等于「总量减去已用」`,
      Number.isFinite(swap) ? `ZRAM 已用 ${swap} MB —— 闲置的模型权重大多被压在这里` : '',
      Number.isFinite(Number(memory?.app_avail_mb))
        ? `App 口径 availMem ${memory.app_avail_mb} MB（与上面的 MemAvailable 不是同一个数）` : '',
      '',
      '⚠ 载入更大的模型时这个数可能不降反升：内核为腾地方回收掉的，',
      '   比模型实际驻留的还多。要看单个模型的代价请用下面的实测峰值。',
      '转写峰值实测：SenseVoice≈1.2G / Qwen3-Q4≈1.9G / Qwen3-Q8≈2.0G',
    ].filter(Boolean).join('\n');
  }

  function renderMemoryDetail(memory) {
    facts($('memory-grid'), [
      ['MemTotal', memory?.total_mb ? `${memory.total_mb} MB` : null],
      ['MemAvailable', memory?.avail_mb ? `${memory.avail_mb} MB` : null],
      ['已用（总量−可用）', memory?.used_mb ? `${memory.used_mb} MB` : null],
      ['ZRAM / Swap 已用', memory?.swap_used_mb !== null && memory?.swap_used_mb !== undefined
        ? `${memory.swap_used_mb} MB` : null],
      ['App availMem', memory?.app_avail_mb ? `${memory.app_avail_mb} MB` : null],
      ['App low_memory', memory?.low_memory === true ? '是' : memory?.low_memory === false ? '否' : null],
    ]);
    setNote($('memory-note'), memory?.error
      ? `App 内存接口取不到：${memory.error}（/proc 读数仍然有效）`
      : '读自 /proc/meminfo；仅供参考，不参与任何自动决策。', memory?.error ? 'bad' : '');
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
    $('rms-current').textContent = fixed(gate?.current);
    $('rms-avg').textContent = fixed(gate?.avg_1s);
    $('rms-peak').textContent = fixed(gate?.peak_10s);
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

  function renderKws(kws, pipeline) {
    const owner = pipeline?.owner ?? 'speech.rms';
    const stream = kws?.stream;
    const score = number(stream?.score) ?? 0;
    const threshold = number(stream?.threshold ?? kws?.profile?.threshold) ?? 0.8;
    const hit = recentHit(kws?.last_hit);
    const connected = kws?.provider?.connected === true;
    const built = kws?.profile?.built === true;
    $('kws-keyword').textContent = kws?.profile?.display_name ?? '未设置';
    $('kws-score').textContent = score.toFixed(3);
    $('kws-countdown').textContent = seconds(kws?.countdown?.remaining_ms);
    setStyle($('kws-fill'), 'width', percent(score));
    $('kws-fill').className = `kws-fill ${score >= threshold ? 'hit' : ''}`.trim();
    setStyle($('kws-threshold'), 'left', percent(threshold));
    $('kws-decoded').textContent = stream?.decoded_text || '等待拼音 token';
    qs('.kws-meter')?.setAttribute('aria-valuenow', String(score));
    // 状态取自 lease：GATED 表示门还没开，KWS 此刻并不工作。
    const stateText = hit ? 'HIT'
      : owner === 'speech.kws' ? 'LISTEN'
        : !connected ? 'CONNECTING'
          : !built ? 'SETUP' : 'GATED';
    setBadge($('kws-state'), stateText, hit || owner === 'speech.kws' ? 'ok' : connected ? '' : 'warn');
    setNote($('kws-note'), !connected
      ? `Provider 未连接：${kws?.reason ?? kws?.provider?.last_error ?? 'connecting'}`
      : !kws?.provider?.models_ready ? 'HTP 拼音模型加载中'
        : !built ? '请到设置页录入并生成唤醒词'
          : `Provider ${stream?.speaking ? '分段中' : '空闲'} · 拼音 ${stream?.count ?? 0} 次命中 · 已拒绝 ${
            kws?.rejected_hits ?? 0} 次门外命中`, connected ? 'good' : 'bad');
  }

  function renderVad(vad) {
    const probability = number(vad?.activity?.probability);
    const active = vad?.activity?.active === true;
    const handoff = vad?.handoff?.active === true;
    const last = vad?.wav?.last_segment;
    $('vad-probability').textContent = fixed(probability, 3);
    $('vad-countdown').textContent = seconds(vad?.countdown?.remaining_ms);
    $('vad-wav-total').textContent = String(vad?.wav?.segments_published ?? 0);
    setStyle($('vad-fill'), 'width', percent(probability));
    $('vad-fill').className = `vad-fill ${active ? 'speech' : ''}`.trim();
    $('vad-live-label').textContent = active ? '语音中' : handoff ? '寻找切点' : '待机';
    qs('.vad-meter')?.setAttribute('aria-valuenow', String(probability ?? 0));
    setBadge($('vad-state'), active ? 'SPEECH' : handoff ? 'PROCESSING' : 'IDLE', active || handoff ? 'ok' : '');
    setNote($('vad-note'), vad?.last_error
      ? `VAD 异常：${vad.last_error}`
      : handoff
        ? `回溯 ${seconds(vad?.handoff?.pre_roll_ms)} · 推理 ${vad?.last_inference_ms ?? '—'} ms · 梯度切句 ${
          vad?.gradient?.cuts ?? 0} 次`
        : `模型${vad?.model?.files_present ? '已就位' : '缺失'} · 常驻 ${
          vad?.model?.residency?.declared ? '已声明' : '未声明'}`,
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

  function renderAsr(asr, pipeline) {
    const owner = pipeline?.owner ?? 'speech.rms';
    const authoritative = asr?.authority?.active === true && owner === 'speech.asr';
    const last = asr?.transcripts?.last;
    const state = asr?.state?.toUpperCase() ?? 'IDLE';
    setBadge($('asr-state'), state,
      asr?.last_error ? 'bad' : ['QUEUED', 'TRANSCRIBING', 'LISTENING'].includes(state) ? 'ok' : '');
    $('asr-owner').textContent = authoritative ? 'speech.asr' : owner;
    $('asr-countdown').textContent = seconds(asr?.ending?.remaining_ms);
    $('asr-total').textContent = String(asr?.transcripts?.total ?? 0);
    $('asr-last-text').textContent = last?.text || '尚未产生转写';
    $('asr-last-detail').textContent = last
      ? `segment=${last.segment_id} · ${last.timing?.inference_ms ?? '—'} ms · ${last.model?.precision ?? 'unknown'}`
      : '—';
    setBadge($('asr-precision'),
      `${asr?.model?.precision ?? '—'} · ${asr?.model?.htp ?? '—'} · QNN ${asr?.model?.qnn ?? '—'}`, 'tag');
    setNote($('asr-note'), asr?.last_error
      ? `ASR 异常：${asr.last_error}`
      : authoritative
        ? `关键词=${asr?.ending?.keyword_enabled ? 'ON' : 'OFF'} · 超时=${asr?.ending?.timeout_enabled ? 'ON' : 'OFF'}`
        : `队列 ${asr?.queue?.depth ?? 0} · 常驻 ${asr?.model?.residency?.declared ? '已声明' : '未声明'}`,
    asr?.last_error ? 'bad' : 'good');
    const selected = asr?.model?.selected;
    facts($('asr-model-facts'), [
      ['当前档位', modelLabel(selected?.id ?? asr?.model?.model)],
      ['选中档位资产', selected
        ? (selected.files_present ? '已就位' : `缺失：${(selected.missing ?? []).join('、')}`)
        : null],
      ['常驻运行时', asr?.model?.runtime],
      ['常驻 session', asr?.model?.session],
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

  // 状态总线：我们写出去的事实 + 读回来的别人的事实。写者只有一个，读者随意——
  // 这个分工必须在页面上看得见。
  function renderStates(states) {
    const rows = [
      ...Object.entries(states?.published ?? {}).map(([k, v]) => [`↑ ${k}`, v]),
      ...Object.entries(states?.observed ?? {}).map(([k, v]) => [
        `↓ ${k}`,
        v?.live ? v.value : `${v?.value ?? '—'}（${v?.stale_reason ?? 'not live'}）`,
      ]),
    ];
    facts($('states-grid'), rows);
    if (!rows.length) $('states-grid').textContent = '尚未推送';
    // ⚠ 回传抑制不再落在门上（docs/061 §四.2），这里也就不该再显示一个不存在的 echo_guard——
    // 读一个后端已经不发的字段，永远得到 undefined，而 undefined 看起来和「一切正常」一样。
    setNote($('states-note'),
      `已推送 ${states?.writes ?? 0} 次${states?.last_error ? ` · 总线异常：${states.last_error}` : ''}`,
      states?.last_error ? 'bad' : 'good');
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
          ? '音量门不可用：PCM 不可用是安全兜底，此时两把钥匙都不开门。'
          : gateOpen
            ? `音量门已开（AVG ${fixed(gate?.decision_value, 3)} ≥ 阈值 ${fixed(gate?.open_threshold, 3)}）。`
            : `音量门闭合中，等待 AVG ${fixed(gate?.decision_value, 3)} 越过阈值 ${
              fixed(gate?.open_threshold, 3)}${gate?.open_armed === false ? '（且需先掉回阈值以下重置）' : ''}。`);

      const kws = live.kws;
      if (listen?.engaged) add('ok', '听写模式已启用：唤醒被直通绕过，自动收工全部让位。');
      else if (kws?.provider?.connected !== true) {
        add('bad', `唤醒不可用：拼音 Provider 未连接（${kws?.provider?.last_error ?? kws?.reason ?? '原因未提供'}）。`);
      } else if (kws?.profile?.built !== true) add('warn', '唤醒词尚未生成，请到设置页录入。');
      else add('ok', `唤醒就绪：「${kws.profile.display_name}」，已拒绝 ${kws.rejected_hits ?? 0} 次门外命中。`);

      const vad = live.vad;
      if (vad?.model?.files_present !== true) add('bad', 'FireRedVAD 模型文件缺失，切段无法工作。');
      else if (vad?.last_error) add('bad', `切段异常：${vad.last_error}`);
      else if (vad?.activity?.processed_frames > 0) {
        add('ok', `切段正常：已处理 ${vad.activity.processed_frames} 帧，本次运行产出 ${
          vad?.wav?.segments_published ?? 0} 段。`);
      } else add('unknown', '切段无法判定：本次运行还没有处理过任何一帧（尚未被唤醒过）。');

      const asr = live.asr;
      const selected = asr?.model?.selected;
      if (asr?.last_error) add('bad', `识别异常：${asr.last_error}`);
      else if (!selected) {
        add('unknown', '识别档位的资产无法判定：后端没有报告被选中的那一档。');
      } else if (selected.files_present !== true) {
        // 缺失要说出缺的是哪个文件——只说「缺失」等于让人自己去猜。
        add('bad', `${modelLabel(selected.id)} 模型文件缺失：${(selected.missing ?? []).join('、') || '未提供清单'}`);
      } else {
        add('ok', `识别就绪：${modelLabel(selected.id)}，本次运行 ${
          asr?.transcripts?.published_this_run ?? 0} 条。`);
      }

      // 常驻声明。App 侧 worker 重生或 recycle 之后要靠它自动补齐，
      // 「未声明」意味着下一次唤醒要现场付载入——恰好把代价放在唯一在意延迟的那条路径上。
      const residents = live.service?.residents;
      if (!residents) add('unknown', '常驻声明无法判定：本轮还没有跑过一次对账。');
      else if (/=declared(;|$)/.test(residents) && !/=(?!declared)/.test(residents)) {
        add('ok', `常驻已声明：${residents}`);
      } else add('warn', `常驻声明未完成：${residents}`);

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

  /**
   * ⭐ 原始 JSON **只在使用者展开时才格式化**（docs/061 §六）。
   *
   * 它曾经无条件跑 `JSON.stringify(value, null, 2)`——14KB 的对象、每秒四次、
   * 而且诊断页是 `hidden` 不是卸载，所以看不见的时候照跑。真机实测：诊断页可见时
   * Chrome renderer 从 6.35% 涨到 14.26%，这一句是主因。
   */
  let rawOpen = false;
  const renderRaw = (live) => {
    const box = $('speech-input');
    if (!box) return;
    if (!rawOpen) { box.textContent = '（已折叠：点上方按钮展开原始 JSON）'; return; }
    box.textContent = live ? JSON.stringify(live, null, 2) : '—';
  };
  const setRawOpen = (open, live) => { rawOpen = open === true; renderRaw(live); };

  function renderDiagnostics(live, listen) {
    renderDiagSummary(live, listen);
    renderInputDiag(live?.input);
    renderRms(live?.rms_gate);
    renderKws(live?.kws, live?.pipeline);
    renderVad(live?.vad);
    renderAsr(live?.asr, live?.pipeline);
    if (live?.states) renderStates(live.states);
    renderMemoryDetail(live?.memory);
    renderRaw(live);
  }

  window.SpeechViews = {
    setRawOpen,
    $,
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
    renderOverview,
    renderChain,
    renderRecords,
    renderListen,
    renderStages,
    renderTranscripts,
    renderMemory,
    renderDiagnostics,
    // ⭐ 诊断页按域拆开暴露。整块重画意味着一次音量变化要跑九个渲染器，
    // 而其中八个的数据一个字都没变（真机实测：诊断页可见时这件事值 18.4% 的一个核）。
    renderDiagSummary,
    renderInputDiag,
    renderRms,
    renderKws,
    renderVad,
    renderAsr,
    renderStates,
    renderMemoryDetail,
    renderRaw,
  };
})();

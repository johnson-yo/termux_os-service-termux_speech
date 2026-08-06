#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// [INPUT]: Framework URL/System Key, running Termux Speech instance, App cue/graph runtime, and external VAD/ASR files.
// [OUTPUT]: `pass` / `fail` / `blocked` (exit 0/1/2). Checks cover live input, last-owner authority,
//           cue, both HTP graphs, WAV/transcript feeds and speech.idle. `blocked` means a prerequisite
//           is missing, so nothing was asserted — one cause, not fourteen downstream symptoms.
// [POS]: Installed/Dev-compatible verification; it never prints credentials/audio and does not require a new physical Keyword hit.
// [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
const BASE = process.env.TERMUX_OS_FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
const TOKEN = process.env.TERMUX_OS_SYSTEM_KEY ?? process.env.TERMUX_OS_TOKEN ?? '';
const BASE_PACKAGE_ID = 'github.termux-os.service.termux-speech';
let packageId = process.env.TERMUX_OS_PACKAGE_ID ?? null;
const checks = [];
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const resolvePackageId = async () => {
  if (packageId) return packageId;
  const response = await fetch(`${BASE}/api/packages`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true || !Array.isArray(payload.packages)) {
    throw new Error(payload?.error ?? `HTTP ${response.status} /api/packages`);
  }
  const exact = payload.packages.find((item) => item.id === BASE_PACKAGE_ID);
  if (exact) packageId = exact.id;
  if (!packageId) {
    const dev = payload.packages.filter(
      (item) => item.source === 'dev-mount' && item.id?.startsWith(`${BASE_PACKAGE_ID}@`),
    );
    if (dev.length === 1) packageId = dev[0].id;
    else if (dev.length > 1) throw new Error('multiple Termux Speech Dev instances; set TERMUX_OS_PACKAGE_ID');
  }
  if (!packageId) throw new Error('Termux Speech Package instance not found');
  return packageId;
};

const request = async (route, { method = 'GET', body, timeoutMs = 8000 } = {}) => {
  const id = await resolvePackageId();
  const response = await fetch(`${BASE}/api/packages/${id}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${response.status} ${route}`);
  }
  return payload;
};

const discoverApp = async () => {
  const response = await fetch(`${BASE}/api/capabilities/termux-os.app.api/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  const value = payload?.value;
  if (!response.ok || payload?.ok !== true || !value?.base_url) {
    throw new Error(payload?.reason ?? payload?.error ?? 'termux-os.app.api unavailable');
  }
  const authorization = value.headers?.Authorization
    ?? (value.token ? `Bearer ${value.token}` : null);
  if (!authorization) throw new Error('termux-os.app.api returned no authorization');
  return { baseUrl: new URL(value.base_url).origin, authorization };
};

const appRequest = async (descriptor, route, {
  method = 'GET',
  body,
  timeoutMs = 30_000,
} = {}) => {
  const response = await fetch(descriptor.baseUrl + route, {
    method,
    headers: {
      Authorization: descriptor.authorization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `App HTTP ${response.status} ${route}`);
  }
  return payload.data;
};

const check = async (id, run) => {
  try { checks.push({ id, result: 'pass', evidence: await run() }); }
  catch (error) { checks.push({ id, result: 'fail', evidence: String(error?.message ?? error) }); }
};

/**
 * ⭐ **缺一个前置不是十四个失败，是一个。**
 *
 * 真机踩过：adapter 没挂载时 `termux-os.app.api` 没有提供者，于是十四条断言里有十条
 * 各自报出自己的下游症状——「no provider registered」「PCM WS is not live」
 * 「Pool stopped writing」——每一条都是真的，每一条都指向错的地方。读的人会去查
 * 麦克风、查 Pool、查 App，而唯一要做的事是把 adapter 挂上。
 *
 * 所以前置在跑任何断言**之前**问，缺了就只说这一件事，并且直接给出该敲的命令。
 */
const preflight = async () => {
  const missing = [];
  const note = (what, why, fix) => missing.push({ what, why, fix });

  let packages = null;
  try {
    const response = await fetch(`${BASE}/api/packages`, { headers, signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      note('framework', payload?.error ?? `HTTP ${response.status}`,
        'check TERMUX_OS_FRAMEWORK_URL and TERMUX_OS_SYSTEM_KEY（token 每次全新装会轮替：~/framework.sh credentials）');
      return missing;   // 夠不到 Framework 時，後面每一項都只會重複同一個原因
    }
    packages = payload.packages;
  } catch (error) {
    note('framework', String(error?.message ?? error), 'is the Framework running? ~/framework.sh start');
    return missing;
  }

  try { await resolvePackageId(); }
  catch (error) {
    note('termux-speech', String(error?.message ?? error),
      'install it, or dev-mount the workspace: POST /api/dev/packages {package_id, workspace, slug}');
  }

  try {
    const response = await fetch(`${BASE}/api/capabilities`, { headers, signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null);
    const entry = (payload?.capabilities ?? []).find((item) => item.capability === 'termux-os.app.api');
    if (!entry) {
      // 誰提供 termux-os.app.api 是 adapter 的事，但這裡刻意寫出它的名字：
      // 「沒有提供者」對讀的人不可行動，「adapter 沒起來」可以。
      note('termux-os.app.api', 'no provider registered',
        'the Android App adapter is not loaded — install github.termux-os.adapter.android-app '
        + 'or dev-mount it（slug: github-termux-os-adapter）');
    } else if (entry.ready !== true) {
      note('termux-os.app.api', entry.reason ?? 'provider is not ready',
        'the adapter is loaded but cannot reach the App on 8796 — is the App running and its token current?');
    }
  } catch (error) {
    note('termux-os.app.api', String(error?.message ?? error), 'cannot read the capability registry');
  }

  return missing;
};

const waitFor = async (read, accept, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return value;
};

const blocked = await preflight();
if (blocked.length) {
  /**
   * ⚠ `blocked` 不是 `fail`。
   *
   * fail = 「這台機器上這件事真的壞了」，blocked = 「還沒到能問這個問題的地步」。
   * 壓成同一個值會讓一次沒挂 adapter 看起來像十條真實的功能回歸，
   * 而**假紅比沒測更貴**——它讓人去修沒壞的東西，也讓真紅下一次不再被當回事。
   */
  console.log(JSON.stringify({
    schema: 'termux-os.device-verify.v1',
    result: 'blocked',
    blocked,
    checks: [],   // 一條都沒跑，所以一條都不報——空著才是誠實的
  }));
  process.exit(2);
}

await check('input_device_route', async () => {
  const payload = await request('/devices');
  if (!Array.isArray(payload.inputs) || payload.inputs.length === 0) throw new Error('no input devices');
  const route = payload.microphone?.routed_input_device;
  if (!route) throw new Error('no actual routed input device');
  return `${payload.inputs.length} devices; configured=${payload.configured.input_device}; routed=${route.product_name ?? route.type_name}`;
});

await check('authenticated_pcm_and_rms_live', async () => {
  const before = await request('/live');
  await new Promise((resolve) => setTimeout(resolve, 650));
  const after = await request('/live');
  const stream = after.pcm_stream;
  const gate = after.rms_gate;
  if (stream?.connected !== true || Number(stream.last_frame_age_ms) > 1000) {
    throw new Error(stream?.last_error ?? 'authenticated PCM WS is not live');
  }
  if (Number(stream.frame_seq) <= Number(before.pcm_stream?.frame_seq)) {
    throw new Error('PCM frame counter did not advance');
  }
  if (gate?.available !== true || !Number.isFinite(Number(gate.current))) {
    throw new Error('live RMS unavailable');
  }
  return `frames +${Number(stream.frame_seq) - Number(before.pcm_stream?.frame_seq)}; rms=${Number(gate.current).toFixed(4)}; admission=${gate.pcm_admission}`;
});

await check('speech_input_pipeline_contract', async () => {
  const value = (await request('/speech-input')).value;
  if (value?.schema !== 'termux-os.speech-input.v1') throw new Error('wrong speech.input schema');
  if (value.rms_gate?.schema !== 'termux-os.rms-gate.v2') throw new Error('RMS Gate missing');
  if (value.rms_gate?.close_control !== 'current_pipeline_lease_owner') {
    throw new Error('RMS Gate does not delegate close control to the Pipeline lease');
  }
  if (value.pipeline?.schema !== 'termux-os.speech-pipeline-lease.v1'
    || value.pipeline?.close_policy !== 'last_downstream_owner') {
    throw new Error('last-owner Pipeline lease missing');
  }
  if (value.pcm_pool?.owner !== 'termux-speech-vad' || value.pcm_pool?.used_by_kws !== false) {
    throw new Error('VAD Pool ownership is wrong');
  }
  const serialized = JSON.stringify(value);
  if (serialized.includes('pcm_s16le_b64') || serialized.includes('Authorization')) {
    throw new Error('speech.input leaked PCM or credentials');
  }
  if (value.downstream?.stages?.find((item) => item.id === 'asr')?.connected !== true
    || value.downstream?.idle_capability !== 'speech.idle') {
    throw new Error('SenseVoice/speech.idle downstream contract missing');
  }
  return `ready=${value.ready}; owner=${value.pipeline.owner}; gate=${value.rms_gate.state}; pool=${value.pcm_pool.duration_ms}/${value.pcm_pool.configured_ms}ms`;
});

await check('pinyin_kws_and_countdown', async () => {
  const payload = await waitFor(
    () => request('/kws'),
    (result) => result.value?.provider?.connected === true
      && result.value?.provider?.models_ready === true,
  );
  const value = payload?.value;
  if (value?.provider?.connected !== true) throw new Error(value?.reason ?? 'pinyin WS not connected');
  if (value.provider.model_asset !== 'model.wake-pinyin.app-htp') {
    throw new Error(`wrong KWS model Asset: ${value.provider.model_asset}`);
  }
  if (value.provider.models_ready !== true) throw new Error(value.reason ?? 'KWS HTP model not ready');
  if (Number(value.countdown?.timeout_ms) < 1000) throw new Error('KWS countdown unavailable');
  if (typeof value.cue?.enabled !== 'boolean') throw new Error('KWS cue setting missing');
  return `asset=${value.provider.model_asset}@${value.provider.model_version}; keyword=${value.profile?.display_name ?? 'setup-required'}; timeout=${value.countdown.timeout_ms}ms; cue=${value.cue.enabled}`;
});

await check('vad_model_pool_and_wav_contract', async () => {
  const value = (await request('/vad')).value;
  if (value?.schema !== 'termux-os.speech-vad.v1') throw new Error('wrong VAD schema');
  if (value.model?.files_present !== true) throw new Error('FireRedVAD model/cmvn missing');
  if (value.model.runtime !== 'android-app-ort-qnn-htp') throw new Error('wrong VAD runtime');
  if (Number(value.pcm_pool?.configured_ms) > 6000 || value.pcm_pool?.used_by_kws !== false) {
    throw new Error('VAD Pool limit/ownership wrong');
  }
  if (Number(value.countdown?.timeout_ms) < 1000 || value.countdown?.resets_on !== 'wav_output') {
    throw new Error('VAD no-WAV countdown unavailable');
  }
  if (value.wav?.format !== 'wav_pcm_s16le_16khz_mono'
    || value.wav?.downstream !== 'speech.asr'
    || value.wav?.downstream_connected !== true) {
    throw new Error('WAV→ASR handoff contract missing');
  }
  return `model=${value.model.id}; pool<=${value.pcm_pool.configured_ms}ms; timeout=${value.countdown.timeout_ms}ms; published=${value.wav.segments_published}`;
});

await check('single_current_close_owner', async () => {
  const [pipelinePayload, kwsPayload, vadPayload, asrPayload] = await Promise.all([
    request('/pipeline'),
    request('/kws'),
    request('/vad'),
    request('/asr'),
  ]);
  const pipeline = pipelinePayload.value;
  const actual = [
    kwsPayload.value?.countdown?.authoritative === true ? 'speech.kws' : null,
    vadPayload.value?.countdown?.authoritative === true ? 'speech.vad' : null,
    asrPayload.value?.authority?.active === true ? 'speech.asr' : null,
  ].filter(Boolean);
  const expected = pipeline.owner === 'speech.rms' ? [] : [pipeline.owner];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`authority mismatch owner=${pipeline.owner} authoritative=${actual.join(',')}`);
  }
  return `epoch=${pipeline.epoch}; owner=${pipeline.owner}; authoritative=${actual[0] ?? 'RMS only'}`;
});

await check('resident_graphs_declared_and_loaded', async () => {
  const descriptor = await discoverApp();
  const [vad, asr] = await Promise.all([request('/vad'), request('/asr')]);
  const wanted = [vad.value?.model?.session, asr.value?.model?.session];
  if (wanted.some((id) => !id)) throw new Error('service does not report its resident ids');
  const snapshot = await appRequest(descriptor, '/api/inference/residents', { timeoutMs: 20_000 });
  const found = wanted.map((id) => (snapshot?.residents ?? []).find((item) => item?.id === id));
  const missing = wanted.filter((id, index) => !found[index]);
  if (missing.length) throw new Error(`resident not declared: ${missing.join(',')}`);
  const notLoaded = found.filter((item) => item.state !== 'loaded').map((item) => `${item.id}=${item.state}`);
  if (notLoaded.length) throw new Error(`resident not loaded: ${notLoaded.join(',')}`);
  // `spec.toJson()` 是平铺进每条 item 的，不是嵌在 `spec` 下。
  const foreign = found.filter((item) => item.created_by !== 'termux-speech');
  if (foreign.length) throw new Error('resident declarations are not owned by termux-speech');
  if (!found[1]?.heal?.check_output) throw new Error('SenseVoice resident carries no heal check_output');
  const io = found[1]?.io?.outputs ?? [];
  return `${wanted.join(' + ')}; loaded; heal=${found[1].heal.check_output}; asr_io=${io.join('/') || 'none'}`;
});

await check('fireredvad_htp_runtime', async () => {
  // 走常驻路由，不再自己 create/delete —— 那正是 docs/046 标记的 QNN churn 风险，
  // 而验收脚本以前每次运行都做两次。
  const descriptor = await discoverApp();
  const resident = (await request('/vad')).value?.model?.session;
  if (!resident) throw new Error('VAD resident id unavailable');
  const result = await appRequest(
    descriptor,
    `/api/inference/residents/${resident}/stream`,
    {
      method: 'POST',
      body: {
        reset: true,
        state_links: { caches_packed: 'new_caches_packed' },
        outputs: ['probs'],
        steps: [{
          inputs: {
            feat: {
              dtype: 'float32',
              shape: [1, 1, 80],
              data_b64: Buffer.alloc(80 * 4).toString('base64'),
            },
          },
        }],
      },
      timeoutMs: 60_000,
    },
  );
  const probs = result?.values?.probs ?? result?.probs;
  if (!Array.isArray(probs) || probs.length !== 1 || !Number.isFinite(Number(probs[0]))) {
    throw new Error('FireRedVAD HTP stream returned no finite probability');
  }
  return `resident=${resident}; frames=${probs.length}; probability=${Number(probs[0]).toFixed(4)}`;
});

await check('sensevoice_contract_and_htp_runtime', async () => {
  const asr = (await request('/asr')).value;
  if (asr?.schema !== 'termux-os.speech-asr.v1' || asr.model?.files_present !== true) {
    throw new Error(asr?.last_error ?? 'SenseVoice model/adjuncts unavailable');
  }
  if (asr.model.runtime !== 'android-app-ort-qnn-htp'
    || asr.model.precision !== 'qnn-context'
    || asr.model.htp !== 'v73'
    || asr.model.qnn !== '2.47') {
    throw new Error('SenseVoice runtime metadata is not the installed V73/QNN 2.47 context');
  }
  if (asr.transcripts?.http_feed !== '/asr/transcripts'
    || asr.transcripts?.websocket !== '/asr/transcripts/ws') {
    throw new Error('SenseVoice transcript feed routes missing');
  }
  const resident = asr.model.session;
  if (!resident) throw new Error('ASR resident id unavailable');
  const descriptor = await discoverApp();
  const int32 = (value) => {
    const data = Buffer.alloc(4);
    data.writeInt32LE(value);
    return data.toString('base64');
  };
  const result = await appRequest(
    descriptor,
    `/api/inference/residents/${resident}/run`,
    {
      method: 'POST',
      body: {
        iters: 1,
        warmup: 0,
        return_outputs: false,
        output_mode: 'argmax',
        inputs: {
          speech: {
            dtype: 'float32',
            shape: [1, 167, 560],
            data_b64: Buffer.alloc(167 * 560 * 4).toString('base64'),
          },
          speech_lengths: { dtype: 'int32', shape: [1], data_b64: int32(1) },
          language: { dtype: 'int32', shape: [1], data_b64: int32(0) },
          textnorm: { dtype: 'int32', shape: [1], data_b64: int32(15) },
        },
      },
      timeoutMs: 180_000,
    },
  );
  const output = (result?.outputs ?? []).find((item) => item?.name === asr.model.output_name)
    ?? result?.outputs?.[0];
  if (output?.reduction !== 'argmax_last' || !Array.isArray(output.data)) {
    throw new Error('SenseVoice HTP run returned no server-side argmax');
  }
  return `resident=${resident}; precision=qnn-context; output=${output.name}; argmax=${output.data.length}`;
});

await check('rolling_pool_and_bounded_record_store', async () => {
  const live = await request('/live');
  const pool = live.pcm_pool;
  const gate = live.rms_gate;
  const records = live.records;
  // Pool 必须在门关着时也在滚：`avg_1s` 的滞后让 OPEN 晚 300–400 ms，
  // 门后才开始缓冲等于从 timeline 头部啃掉唤醒词。
  if (pool?.rolling !== 'always') throw new Error('Pool is not rolling unconditionally');
  if (gate?.state === 'closed' && pool?.writing !== true) {
    throw new Error('Pool stopped writing while the Gate is closed');
  }
  if (!Array.isArray(gate?.open_keys) || !gate.open_keys.includes('kws_hit')) {
    throw new Error('the Gate does not advertise the KWS hit as a second opening key');
  }
  // 保留量的判据换成了记录组：⛔ 稳定态盘上最多两组，更旧的先归档进 SQLite 再删 WAV。
  // 允许短暂出现三组——最旧那组还有 item 没转写完时不许归档（把不知道的结论写进库）。
  const onDisk = Number(records?.groups_on_disk);
  if (!Number.isFinite(onDisk)) throw new Error('record store did not report groups_on_disk');
  if (onDisk > 3) throw new Error(`record store keeps ${onDisk} groups on disk (>3)`);
  if (Number(records?.group_size) !== 50) {
    throw new Error(`record group size is ${records?.group_size}, expected 50`);
  }
  return `pool=${pool.duration_ms}/${pool.configured_ms}ms rolling; keys=${gate.open_keys.join('+')}; `
    + `groups=${onDisk} active=${records?.active?.progress ?? '—'} archived=${
      records?.archive?.groups ?? 0}g/${records?.archive?.items ?? 0}i`;
});

/**
 * 状态流。⭐ 这一轮的核心：页面不再每 250ms 拉一份完整状态。
 * ⚠ 判据必须是「状态不变时它真的不返回」——否则「间隔更长的轮询」也能通过。
 */
await check('state_stream_pushes_only_on_change', async () => {
  const snapshot = await request('/state');
  if (snapshot.schema !== 'termux-os.speech-state.v1' || snapshot.full !== true) {
    throw new Error('state snapshot contract missing');
  }
  if (!snapshot.domains?.lifecycle || !snapshot.domains?.records || !snapshot.domains?.service) {
    throw new Error('state snapshot is missing required domains');
  }
  const bytes = JSON.stringify(snapshot).length;
  const stats = (await request('/state/stats')).value;
  return `domains=${Object.keys(snapshot.domains).length}; version=${snapshot.version}; `
    + `snapshot_bytes=${bytes}; builds=${stats.builds}`;
});

await check('speech_activity_and_transcript_feeds', async () => {
  const [activity, transcripts] = await Promise.all([
    request('/vad/activity?after=0'),
    request('/asr/transcripts?after=0&limit=10'),
  ]);
  if (activity.schema !== 'termux-os.speech-activity-feed.v1'
    || !Array.isArray(activity.observations)) {
    throw new Error('speech.activity feed contract missing');
  }
  if (transcripts.schema !== 'termux-os.speech-transcript-feed.v1'
    || !Array.isArray(transcripts.observations)) {
    throw new Error('speech.transcript feed contract missing');
  }
  return `activity=${activity.observations.length}; transcripts=${transcripts.observations.length}`;
});

await check('wake_cue_hardware_endpoint', async () => {
  const descriptor = await discoverApp();
  const result = await appRequest(descriptor, '/api/android/audio/cue', {
    method: 'POST',
    body: { cue: 'wake' },
    timeoutMs: 10_000,
  });
  if (result?.cue !== 'wake' || !result?.cue_id
    || Number(result?.pcm_frames) <= 0 || result?.pcm_left_app !== false) {
    throw new Error('App wake cue did not play');
  }
  const durationMs = Math.round(Number(result.pcm_frames) * 1000 / Number(result.sample_rate));
  return `duration=${durationMs}ms; playback=${result.playback_ms}ms; route=${result.routed_device?.product_name ?? result.routed_device?.type_name ?? 'system'}`;
});

await check('developer_speech_idle_reset', async () => {
  const beforeFrames = Number((await request('/live')).pcm_stream?.frame_seq) || 0;
  const reset = await request('/idle', {
    method: 'POST',
    body: { reason: 'device_verify', requested_by: 'verify-device' },
  });
  if (reset.value?.snapshot?.owner !== 'speech.rms') {
    throw new Error(`speech.idle left owner=${reset.value?.snapshot?.owner}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await request('/live');
  if (after.pcm_stream?.connected !== true
    || Number(after.pcm_stream?.frame_seq) <= beforeFrames) {
    throw new Error('speech.idle stopped or stalled Persistent Mic');
  }
  return `owner=${reset.value.snapshot.owner}; Mic frames +${Number(after.pcm_stream.frame_seq) - beforeFrames}`;
});

const result = checks.some((item) => item.result === 'fail') ? 'fail' : 'pass';
console.log(JSON.stringify({ schema: 'termux-os.device-verify.v1', result, checks }));
process.exit(result === 'pass' ? 0 : 1);

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework/App transports, PCM/pinyin, FireRedVAD/SenseVoice assets, and Package data/config.
 * [OUTPUT]: Last-owner RMS→KWS→VAD→ASR pipeline, WAV/transcript feeds, speech.idle, and controls.
 * [POS]: Termux Speech service; PCM/tensors remain direct loopback while Framework sees control/text metadata.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import http from 'node:http';
import { writeStatus } from './status.mjs';
import {
  loadConfig,
  saveAsrConfig,
  saveKwsConfig,
  saveLifecycleConfig,
  saveRmsGateConfig,
  saveVadConfig,
} from './config.mjs';
import { systemKeyAuthorized } from './http-auth.mjs';
import { createAndroidAppClient, UpstreamError } from './app-api.mjs';
import { RmsGate } from './rms-gate.mjs';
import { projectSpeechInput } from './speech-input.mjs';
import { KwsController } from './kws/controller.mjs';
import { PcmWs, pcmWebSocketDescriptor } from './pcm-ws.mjs';
import { VadController } from './vad/controller.mjs';
import { AsrController } from './asr/controller.mjs';
import { PIPELINE_OWNERS, PipelineLease } from './pipeline-lease.mjs';
import { StateBus } from './states.mjs';
import { LifecycleController, MIC_REQUESTER } from './lifecycle/controller.mjs';
import { resolveAssetRoot, ensureAssetRoot } from './assets.mjs';
import { AppEventsClient, CaptureWatchdog } from './capture/app-events.mjs';
import { RecordArchive } from './storage/archive.mjs';
import { RecordGroups } from './storage/groups.mjs';
import { StateHub, WATCH_TIMEOUT_MS } from './state-hub.mjs';
import { listModels, fetchModel, removeModel, installProvider } from './models.mjs';

/** 本包自己的目录。Manifest 是「需要哪些模型」的唯一来源，从这里读。 */
const PACKAGE_ROOT = process.env.TERMUX_OS_PACKAGE_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '.runtime-dev/conf.v4.json';
const LEGACY_CONFIG_FILE = process.env.LEGACY_CONFIG_FILE || '';
const WAKE_WORDS_ROOT = process.env.WAKE_WORDS_ROOT
  || process.env.DATA_ROOT
  || '.runtime-dev/data/termux-speech/wake-words';
const VAD_DATA_ROOT = process.env.VAD_DATA_ROOT || '.runtime-dev/data/termux-speech/vad';
const ASR_DATA_ROOT = process.env.ASR_DATA_ROOT || '.runtime-dev/data/termux-speech/asr';
/**
 * ⭐ **全新的存储命名空间**（docs/061 §七.1）。旧的 `vad/wav/segments.v1.jsonl` 与
 * `asr/transcripts/transcripts.v1.jsonl` 一律不导入、不删除、不计入新分组、不在新界面出现。
 */
const RECORD_DATA_ROOT = process.env.RECORD_DATA_ROOT || '.runtime-dev/data/termux-speech/records';

/**
 * 使用者那份**永久**麦克风需求的名字。⛔ speech 从不登记它——它归 App 的
 * `mic/enable` / `mic/disable` 所有，`mic/demand` 会以 403 拒绝这个 id。
 *
 * 这里只出现在**显示**路径上：界面必须说得出「是谁在吊着麦克风」。
 * ⚠ 刻意不放进 `lifecycle/controller.mjs`——那里有一条自测断言要求生命周期
 * 控制器根本不知道这个名字存在，而那条断言是对的：碰不到的东西才写不错。
 */
const USER_MIC_REQUESTER = 'user.persistent';
const PORT = Number(process.env.PORT);
const BIND_HOST = process.env.TERMUX_OS_PORT_HTTP_HOST || '127.0.0.1';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const FRAMEWORK_URL = process.env.TERMUX_OS_FRAMEWORK_URL || 'http://127.0.0.1:8980';
const VAD_RESIDENT_ID = process.env.VAD_RESIDENT_ID || 'tsp-vad-local';
const ASR_RESIDENT_ID = process.env.ASR_RESIDENT_ID || 'tsp-asr-local';
const PACKAGE_ID = process.env.TERMUX_OS_PACKAGE_ID || '';

const state = {
  state: 'starting',
  started_at: new Date().toISOString(),
  speech_input: null,
  pcm_stream: null,
  rms_gate: null,
  pipeline: null,
  kws: null,
  vad: null,
  asr: null,
  memory: null,
  last_error: null,
  residents: null,
  refresh_count: 0,
  pcm_frame_count: 0,
};
let lastStatusWrite = 0;
/**
 * ⭐ 状态文件只写**健康**，不写整棵投影树（docs/061 §八）。
 *
 * 真机实测它曾经是 **27,193 字节、每秒一次**——因为 `state` 里挂着 `speech_input`
 * 那 14KB 的投影，加上 `null, 2` 的缩进。而这个文件没有任何读者需要那些内容：
 * 它回答的是「服务活着吗、出过什么错」。整棵树仍然可以从 `/live` 与 `/speech-input`
 * 现取，那里是按需的，不是每秒一次的闪存写入。
 */
const statusPayload = () => ({
  state: state.state,
  started_at: state.started_at,
  last_error: state.last_error,
  residents: state.residents,
  refresh_count: state.refresh_count,
  pcm_frame_count: state.pcm_frame_count,
});
const flush = (force = false) => {
  if (!force && Date.now() - lastStatusWrite < 1000) return;
  writeStatus(STATUS_FILE, statusPayload());
  lastStatusWrite = Date.now();
};

let cfg;
try {
  cfg = loadConfig(CONFIG_FILE, LEGACY_CONFIG_FILE || null);
} catch (error) {
  state.state = 'error';
  state.last_error = `config unreadable: ${error.message}`;
  flush(true);
  process.exit(1);
}
// ⚠ 两个注入各有各的失败原因（端口所有权被别的实例占着 / System Key 没下发），
// 合成一条 "did not inject PORT and TERMUX_OS_SYSTEM_KEY" 就分不出是哪一个——
// 我为此查错了一轮。故逐项指名，并把读到的原始值一并报出来。
const missingInjections = [
  ...(Number.isInteger(PORT) && PORT > 0
    ? [] : [`PORT (got ${JSON.stringify(process.env.PORT ?? null)})`]),
  ...(SYSTEM_KEY ? [] : ['TERMUX_OS_SYSTEM_KEY']),
];
if (missingInjections.length > 0) {
  state.state = 'error';
  state.last_error = `Framework did not inject ${missingInjections.join(' / ')}`;
  flush(true);
  process.exit(1);
}

const android = createAndroidAppClient({
  frameworkUrl: FRAMEWORK_URL,
  systemKey: SYSTEM_KEY,
});
const gate = new RmsGate(cfg.rms_gate);
const pipeline = new PipelineLease();
const bus = new StateBus({
  frameworkUrl: FRAMEWORK_URL,
  systemKey: SYSTEM_KEY,
  packageId: PACKAGE_ID,
});
const sources = { devices: null, mic: null };
/** 唤醒命中在 lifecycle 里的 requester 名。它不是听写模式，见 listenEngaged()。 */
const KWS_REQUESTER = 'kws';
let kws;
let vad;
let asr;
let pcm;
let lifecycle;
let records;

/**
 * 采集事实的观测者：**事件为主**（App 的 `/ws/android/events`），watchdog 只是兜底。
 * 抢占时不命令下游逐级停机——App 那边已经不发无效 PCM 了，下游因为没有输入而自然空闲。
 */
const appEvents = new AppEventsClient({ onChange: () => onStageChange() });
const captureWatchdog = new CaptureWatchdog({
  readSnapshot: async () => {
    const mic = await readMic();
    appEvents.observeSnapshot(mic?.capture, mic?.capture?.boot_id);
    return mic?.capture ?? null;
  },
});

const readInputs = () => android.json('/api/android/audio/devices');
/**
 * 實時可用記憶體。⚠ 這是**給用戶看的參考值**，不作任何自動決策——
 * docs/053 記過 MemAvailable 不預測 LLM 能不能載入（2897/2776 失敗而 2456 成功）。
 * 放在頁面頂部只是為了讓人在切換 ASR 模型前看得見代價：
 * 實測峰值 sensevoice 1210MB / qwen3-q4 1899MB / qwen3-q8 2037MB。
 */
/**
 * ⚠ App 的 `avail_mb` 是 `ActivityManager.availMem`——**不是「總量減去已用」**，
 * 而是「還能挤出多少」的估计，把可回收的頁快取一并算作可用。
 * 真机实测（zflip5，2026-08-01）：载入 727MB 的 Qwen-Q4 之后这个数不降反升
 * 1562 → 1752 MB，因为模型的匿名脏页大多被压进 ZRAM（SwapUsed 2289 → 2349），
 * 而内核为腾地方回收掉的其他东西比模型实际驻留的还多（asr RSS 只从 297 涨到 345）。
 * 于是「换个更大的模型，可用内存反而变多」——数字没错，但它回答的不是使用者的问题。
 * 故这里补上 /proc/meminfo：Swap 用量让「模型被压走了」这件事直接可见。
 * 这两个文件在 Termux 里本就可读，不需要 root，也不需要 App 再开接口。
 */
const readProcMeminfo = () => {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  const mb = (v) => (v === null ? null : Math.round(v / 1024));
  return {
    total_mb: mb(total),
    avail_mb: mb(avail),
    // 「已用」按使用者的心智模型算：总量 − 可用。
    used_mb: total !== null && avail !== null ? mb(total - avail) : null,
    swap_used_mb: swapTotal !== null && swapFree !== null ? mb(swapTotal - swapFree) : null,
  };
};
const readMemory = () => android.json('/api/inference/memory');
const readMic = () => android.json('/api/android/mic/status');

const inputPayload = (devices) => ({
  inputs: devices?.inputs ?? [],
  configured: { input_device: devices?.configured?.input_device ?? 'system_default' },
  microphone: {
    desired_enabled: devices?.microphone?.desired_enabled === true,
    enabled: devices?.microphone?.enabled === true,
    recording: devices?.microphone?.recording === true,
    configured_input_device: devices?.microphone?.configured_input_device ?? 'system_default',
    preferred_input_device: devices?.microphone?.preferred_input_device ?? null,
    routed_input_device: devices?.microphone?.routed_input_device ?? null,
    rate: Number(devices?.microphone?.rate) || 16_000,
    frame_ms: Number(devices?.microphone?.frame_ms) || 100,
    frame_seq: Number(devices?.microphone?.frame_seq) || 0,
    bytes_total: Number(devices?.microphone?.bytes_total) || 0,
    last_error: devices?.microphone?.last_error ?? null,
  },
});

const rmsS16le = (frame) => {
  if (!Buffer.isBuffer(frame) || frame.length < 2) return null;
  let squares = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const value = frame.readInt16LE(offset) / 32768;
    squares += value * value;
    count += 1;
  }
  return count ? Math.sqrt(squares / count) : null;
};

/**
 * 「收音此刻可用吗」。这是 `speech_input.ready` 的**同一个判据**，只是不必为了拿到它
 * 而构造整棵树——热路径每秒问 15 次，而那棵树里 14 KB 与这个布尔值毫无关系。
 */
const readyNow = (nowMs = Date.now()) => sources.mic?.recording === true
  && pcm?.connected === true
  && pcm.lastFrameAtMs !== null
  && nowMs - pcm.lastFrameAtMs <= 1000;

const project = (nowMs = Date.now()) => {
  state.pcm_stream = pcm.snapshot(nowMs);
  state.rms_gate = gate.snapshot(nowMs);
  state.pipeline = pipeline.snapshot(nowMs);
  state.kws = kws.snapshot(nowMs);
  vad.observeTransport(state.pcm_stream);
  state.vad = vad.snapshot(nowMs);
  state.asr = asr.snapshot(nowMs);
  state.memory = memoryCache;
  if (!sources.devices || !sources.mic) return null;
  state.speech_input = projectSpeechInput({
    ...sources,
    pcmStream: state.pcm_stream,
    rmsGate: state.rms_gate,
    kws: state.kws,
    vad: state.vad,
    asr: state.asr,
    pipeline: state.pipeline,
    nowMs,
  });
  return state.speech_input;
};

let publishing = false;
const publishStates = (value) => {
  if (publishing || !value) return;
  publishing = true;
  void bus.publish(value).finally(() => { publishing = false; });
};

const onStageChange = () => {
  publishStates(project());
  // 真实事件：慢速域也可能变了（owner 换人、转写落地、生命周期迁移）。
  hub?.markAll();
  hub?.schedule();
  flush();
};

const syncPipelineAuthority = (nowMs = Date.now()) => {
  const lease = pipeline.snapshot(nowMs);
  kws?.setCloseAuthority(lease.owner === PIPELINE_OWNERS.KWS);
  vad?.setCloseAuthority(lease.owner === PIPELINE_OWNERS.VAD);
  asr?.observePipeline(lease, nowMs);
  state.pipeline = lease;
  return lease;
};

/**
 * ⭐ docs/061 §四.2：TTS 播放**不再**按住 RMS 门。
 *
 * 旧做法在播放期间让整条输入链失聪——而使用者完全可能正想识别 YouTube 或对面的人说的话，
 * 我们无从判断扬声器里的内容是不是他要的。现在 Mic 照常工作、RMS/KWS 保持原状态、
 * VAD 照常切段，**只在 segment 完成时**用单调时间区间判断它是否与本机 TTS 相交（见 dropPolicy）。
 *
 * 代价是明确接受的：TTS 念到唤醒词会真的触发一次听写，只是产出的段全被丢掉——
 * 短暂空转，好过为了播放而让输入链聋掉。
 */
const observeGateLifecycle = (snapshot, nowMs = Date.now()) => {
  const lifecycle = pipeline.observeGate(snapshot, nowMs);
  if (lifecycle.type !== 'unchanged') syncPipelineAuthority(nowMs);
  kws.observeGate(snapshot, nowMs);
  vad.observeGate(snapshot, nowMs);
  return lifecycle;
};

const applyPipelineIdle = (request, nowMs = Date.now()) => {
  const decision = pipeline.requestIdle({
    requester: request?.owner ?? request?.requester,
    reason: request?.reason ?? 'speech_idle',
    epoch: request?.epoch ?? null,
    force: request?.force === true,
    metadata: request?.metadata ?? null,
  }, nowMs);
  if (!decision.accepted) return decision;
  const snapshot = gate.closeFromDownstream(
    decision.previous_owner,
    request?.reason ?? 'speech_idle',
    nowMs,
  );
  syncPipelineAuthority(nowMs);
  kws.observeGate(snapshot, nowMs);
  vad.observeGate(snapshot, nowMs);
  state.rms_gate = snapshot;
  // 会话回到 RMS 门前 = 唤醒那一次用完了：交还 lease，听写组按基线转 warm 或 ready。
  // ⚠ 用 force：关门的可能是超时/结束词/开发者，不是 kws 自己。
  if (lifecycle?.leases.has(KWS_REQUESTER)) {
    void lifecycle.release(KWS_REQUESTER, { force: true, reason: request?.reason ?? 'session_end' })
      .then(() => { syncPcmDemand(); onStageChange(); })
      .catch(() => {});
  }
  onStageChange();
  return { ...decision, gate: snapshot };
};

/**
 * 把流水线从 RMS 门前推到 VAD 手上——**开门这件事只有这一段代码**。
 *
 * KWS 命中与 listen 模式（docs/058）各调它一次。抽出来不是为了省行数，是为了不出现
 * 第二套「差不多的开门逻辑」：两套开门迟早会在某个分支上分岔，而分岔的那一天没人会记得。
 *
 * `trigger` 原样进 VAD 的时间线记录，所以合成触发也要带上来源，事后看得出这一段是谁开的。
 */
const engagePipeline = async (trigger, reason, { cue = false } = {}) => {
  if (pipeline.owner === PIPELINE_OWNERS.RMS) {
    // 第二把钥匙：门还没开就由触发方自己开。对 KWS 而言拼音推理的代价已经付掉了，
    // 对 listen 模式而言使用者已经把焦点放进输入框了——两者都是比 avg_1s 更硬的证据。
    const opened = gate.openFromKeyword(`${reason}_opened_gate`);
    state.rms_gate = opened;
    observeGateLifecycle(opened);
    if (pipeline.owner !== PIPELINE_OWNERS.KWS) {
      // 只有 PCM 不可用会走到这里（安全兜底优先于任何策略）。
      return { ok: false, reason: 'pcm_unavailable' };
    }
  }
  if (pipeline.owner !== PIPELINE_OWNERS.KWS) {
    // 已经在 VAD/ASR 会话中：这次触发不该重启流水线。
    return { ok: false, reason: `owner_${pipeline.owner}` };
  }
  if (cue) void playWakeCue();
  const armed = await vad.arm(trigger);
  if (armed?.handoff?.active !== true) {
    applyPipelineIdle({
      owner: PIPELINE_OWNERS.KWS,
      epoch: pipeline.epoch,
      reason: 'vad_arm_failed',
      metadata: { error: armed?.last_error ?? 'unknown' },
    });
    return { ok: false, reason: 'vad_arm_failed' };
  }
  const handoff = pipeline.handoff(
    PIPELINE_OWNERS.KWS,
    PIPELINE_OWNERS.VAD,
    reason,
    Date.now(),
    trigger?.profile_id !== undefined
      ? { profile_id: trigger.profile_id ?? null, score: trigger.score ?? null }
      : { source: trigger?.source ?? reason },
  );
  if (!handoff.accepted) {
    vad.resetRun('stale_handoff');
    return { ok: false, reason: `handoff_${handoff.code}` };
  }
  syncPipelineAuthority();
  onStageChange();
  return { ok: true, reason: 'accepted' };
};

/**
 * Listen 模式（docs/058 §2.3）——**这是模式，不是一次触发**。
 *
 * 一次触发会被四条 idle 自动关门收走（ASR 结束词、ASR idle、VAD no_output、KWS 倒计时，
 * 全是 15 秒量级），而使用者在输入框里停顿十几秒想措辞时焦点还在，人根本没打算结束。
 * 所以 engaged 期间**抑制全部自动关门**，退出只由外部显式请求负责。
 *
 * ⚠ 它不改变任何判定：VAD 照常切句、ASR 照常转写、KWS 照常在 RMS 门前守着。
 * 变的只是「谁有资格关门」。
 */
/**
 * ⚠ listen 不再有自己的一份布尔。**唯一真相住在 lifecycle 的 requester lease 表里**——
 * 两份状态迟早会在某个分支上分岔（docs/061 §五明确禁止第二套状态）。
 */
const listenEngaged = () => [...lifecycle.leases.keys()].some((id) => id !== KWS_REQUESTER);

/**
 * ⚠ KWS 的 lease 不算「听写模式」：模式的语义是「抑制全部自动关门」，而唤醒触发的会话
 * 本来就该被那四条超时收走。它拿 lease 只是为了让听写组的载入与状态经过同一个 controller。
 */


const listenSnapshot = () => {
  const leases = [...lifecycle.leases.values()];
  const first = leases[0] ?? null;
  return {
    engaged: leases.length > 0,
    reason: first?.reason ?? null,
    requester: first?.requester ?? null,
    requesters: lifecycle.activeRequesters(),
    generation: first?.generation ?? null,
    engaged_at_ms: first?.at_ms ?? null,
    stage: String(pipeline.owner ?? '').replace('speech.', ''),
    dictation: lifecycle.dictationState,
    warm_remaining_ms: lifecycle.warmRemainingMs(),
    suppressed: leases.length > 0
      ? ['asr_end_keyword', 'asr_idle', 'vad_no_output', 'kws_countdown']
      : [],
  };
};

/**
 * 等到**真的有有效 PCM**才算 Mic 就绪。
 *
 * ⚠ `mic/demand` 返回 200 只说明需求登记了；AudioRecord 起来、FGS 拿到前台身份、
 * 第一帧真音频到达都还在后面。不等这一步就宣布 ready，就是 docs/061 §二.4 说的
 * 「假装已开始」——而使用者会对着一个根本没在听的界面说话。
 */
const awaitValidPcm = async (timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stream = pcm.snapshot();
    if (stream.connected && stream.last_frame_age_ms !== null && stream.last_frame_age_ms < 1000) {
      return { ok: true, waited_ms: timeoutMs - (deadline - Date.now()) };
    }
    pcm.ensure();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return { ok: false, reason: 'pcm_unavailable' };
};

const enterListen = async ({ reason, requester }) => {
  const engaged = await lifecycle.engage(requester, { reason });
  if (!engaged.ok) {
    return { ok: false, reason: engaged.reason, error: engaged.error ?? null, value: listenSnapshot() };
  }
  if (engaged.reason === 'already_engaged') {
    return { ok: true, reason: 'already_engaged', value: listenSnapshot() };
  }
  pcm.ensure();
  const ready = await awaitValidPcm();
  if (!ready.ok) {
    await lifecycle.release(requester, { force: true, reason: 'pcm_unavailable' });
    return { ok: false, reason: 'pcm_unavailable', value: listenSnapshot() };
  }
  const outcome = await engagePipeline(
    { source: requester, reason }, 'listen_mode', { cue: false },
  );
  if (!outcome.ok) {
    // Arm 失败也要回滚 lease，否则会留下「登记了但没在听」的半状态。
    await lifecycle.release(requester, { force: true, reason: outcome.reason });
    return { ok: false, reason: outcome.reason, value: listenSnapshot() };
  }
  onStageChange();
  return { ok: true, reason: 'engaged', lease: engaged.lease, value: listenSnapshot() };
};

const exitListen = async ({ reason, requester, generation = null, force = false }) => {
  const released = await lifecycle.release(requester, { generation, force, reason });
  if (!released.ok) {
    return { ok: false, reason: released.reason, value: listenSnapshot() };
  }
  if (released.reason === 'not_engaged' || released.reason === 'still_engaged') {
    onStageChange();
    return { ok: true, reason: released.reason, value: listenSnapshot() };
  }
  const decision = applyPipelineIdle({
    requester: requester ?? 'listen',
    owner: 'listen',
    force: true,
    reason: reason || 'listen_mode_exit',
    metadata: { requested_by: requester ?? 'listen' },
  });
  syncPcmDemand();
  onStageChange();
  return { ok: true, reason: 'released', value: listenSnapshot(), decision };
};

/** PCM 连接跟随 Mic 需求：没有需求就不该占着一条 WS 等一个不会来的帧。 */
const syncPcmDemand = () => {
  if (lifecycle.wantsPcm()) pcm.ensure();
  else pcm.close();
};

/**
 * ⭐ SenseVoice 的資產按「什麼時候真的需要」分開解析。
 *
 * 前處理資料（363 KB）永遠要。之後是二選一：本機架構有 ctx 就用 ctx，
 * 沒有才需要那張 937 MB 的源圖——App 的判據是 `require(ctxUsable || 源圖存在)`，
 * 有 ctx 時源圖一次都不會被打開。
 *
 * ⚠ ctx 解析失敗的原因**必須留下來**。一個裸 catch 會把「本機沒有對應架構的 ctx」
 * 和「夠不到 Framework」壓成同一件事，然後默默去要那 937 MB。
 */
/**
 * ⛔ **没有任何一个模型能把服务打死。**
 *
 * 前处理数据是必需资产，先前解析失败就直接抛。真机上它把服务打死过——而原因不是
 * 「缺模型」，是启动时框架 HTTP 还没开始接受连接的一次 `fetch failed`：服务退出、
 * 重启、再来一遍，而资产就在盘上。
 *
 * ⚠ 更要紧的是后果：服务死了，**模型页也就打不开了**，而那正是使用者唯一能用来
 * 补模型的地方。一个「东西没到位」的状态必须能被看见并就地修好，不能表现为消失。
 */
let senseFrontend = null;
let senseFrontendWhy = null;
try {
  senseFrontend = await resolveAssetRoot('model.sensevoice.frontend');
  console.log(`[termux-speech] model.sensevoice.frontend ${senseFrontend.version} → ${senseFrontend.root}`);
} catch (error) {
  senseFrontendWhy = String(error?.message ?? error);
  console.log(`[termux-speech] frontend data not available: ${senseFrontendWhy}`);
}

/**
 * ⭐ **启动只解析，绝不下载。**
 *
 * 这两个是几百 MB 到近 1 GB 的东西。在服务启动路径上取它们，等于让「启动」这件事
 * 在一台干净设备上要花半小时，而且没有任何地方能看见进度——它看起来就是起不来。
 * 更糟的是取失败会把服务一起带走：使用者失去的恰好是那个能让他去补模型的界面。
 *
 * 所以缺就缺着：服务照常起来，ASR 如实报「模型没到位」，由页面上的模型区去下载。
 */
let senseCtx = null;
let senseCtxWhy = null;
try {
  senseCtx = await resolveAssetRoot('model.sensevoice.ctx');
  console.log(`[termux-speech] model.sensevoice.ctx ${senseCtx.version} → ${senseCtx.root}`);
} catch (error) {
  senseCtxWhy = String(error?.message ?? error);
  console.log(`[termux-speech] no precompiled ctx yet: ${senseCtxWhy}`);
}

let senseGraph = null;
let senseGraphWhy = null;
if (!senseCtx) {
  try {
    senseGraph = await resolveAssetRoot('model.sensevoice.graph');
    console.log(`[termux-speech] model.sensevoice.graph ${senseGraph.version} → ${senseGraph.root}`);
  } catch (error) {
    // ⚠ 两个原因都留着。只报后一个会让人以为该去下那张 937 MB 的图，
    // 而正确动作多半是取一份本机架构的 ctx。
    senseGraphWhy = String(error?.message ?? error);
    console.log(`[termux-speech] no portable graph either: ${senseGraphWhy}`);
  }
}
/** SenseVoice 能不能转写。缺模型不是启动失败，是一个如实报出来的未就绪状态。 */
const senseVoiceReady = Boolean(senseCtx || senseGraph);
if (!senseVoiceReady) {
  console.log('[termux-speech] SenseVoice has no model yet; the service starts and the page can fetch one.');
}

const senseTarget = await (async () => {
  try {
    const r = await fetch(`${process.env.TERMUX_OS_FRAMEWORK_URL}/api/system/device`, {
      headers: { Authorization: `Bearer ${process.env.TERMUX_OS_SYSTEM_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json();
    return d?.ok ? { htp: d.device.htp, qnn: d.device.qnn } : null;
  } catch { return null; }  // 純診斷欄位，取不到就報 null，不擋啟動
})();

asr = new AsrController({
  android,
  dataRoot: ASR_DATA_ROOT,
  config: cfg.asr,
  frontendRoot: senseFrontend?.root ?? null,
  graphRoot: senseGraph?.root ?? null,
  ctxRoot: senseCtx?.root ?? null,
  target: senseTarget,
  residentId: ASR_RESIDENT_ID,
  persistConfig: (patch) => {
    cfg = saveAsrConfig(CONFIG_FILE, patch);
    return cfg.asr;
  },
  // 一句话进入终态时把记录组的 item 结掉。⚠ 成功与永久失败都要走到，
  // 否则失败的 item 永远停在 pending，那一组永远完不成、也就永远轮转不出去。
  /**
   * ⭐ 两个操作，两条路径。新准入的段由 `admit` 建立记录并把 staging WAV 移进组；
   * 重转写的段**已经是**一条记录，只能就地更新——用 `admit` 会在当前组再建一条
   * 重复记录，而那份 WAV 早已归属于原记录。
   */
  /**
   * Asset map 解析器。⚠ 只在需要時才問——Qwen 沒裝的裝置照樣能用 SenseVoice。
   *
   * ⭐ 這裡用 `ensureAssetRoot`：Qwen 的檔位是使用者**裝完之後**才選的，選中的那一刻
   * 才是「需要它」的時刻。兩檔解碼器加起來 1.5 GB，而一台機器只會用其中一檔——
   * 在安裝時把兩檔都下來，一半的字節從下載完那一秒起就再也不會被打開。
   */
  resolveAsset: (id) => ensureAssetRoot(id, { onFetch }),
  onResult: (segment, outcome) => {
    if (outcome?.retranscribe) records?.retranscribe(segment.segment_id, outcome);
    else records?.admit(segment, outcome);
  },
  // 听写时「结束」是内容不是命令（docs/058 §5 B）；模式期间的关门只归焦点离开。
  onEnd: (request) => (listenEngaged()
    ? { accepted: false, code: 'listen_mode_engaged' }
    : applyPipelineIdle(request)),
  onChange: onStageChange,
});

const handleVadSegment = (segment) => {
  const nowMs = Date.now();
  if (pipeline.owner === PIPELINE_OWNERS.VAD) {
    const handoff = pipeline.handoff(
      PIPELINE_OWNERS.VAD,
      PIPELINE_OWNERS.ASR,
      'vad_wav_published',
      nowMs,
      { segment_id: segment.segment_id },
    );
    if (!handoff.accepted) throw new Error(`VAD→ASR handoff rejected: ${handoff.code}`);
    syncPipelineAuthority(nowMs);
  } else if (pipeline.owner !== PIPELINE_OWNERS.ASR) {
    throw new Error(`stale VAD WAV while Pipeline owner=${pipeline.owner}`);
  }
  /**
   * ⭐ 这里**不再**建记录组 item。段先只是一份 staging WAV（VAD 自己的水库），
   * 转写出来非空白才由 ASR 准入进组（`onResult` → `records.admit`）。
   *
   * 旧版在这一行就把 WAV 搬进组、建一条 pending item，于是一句空白转写照样占掉
   * 一个名额、留下一份音频、拿到一个 feed 游标——真机上 100 条里有 17 条是这么来的。
   */
  asr.enqueue(segment, { epoch: pipeline.epoch });
  onStageChange();
};

/**
 * ⭐ 模型位置来自 Framework 的 Asset map，不是一条写死的裸路径。
 *
 * 顶层 await：解析不出来就**根本起不来**。⛔ 没有回落——一个「资产缺失时悄悄
 * 用旧路径」的分支会让依赖门禁形同虚设：声明的东西没装上，服务照样跑，
 * 而问题要到别人的机器上才暴露。
 */
const vadAsset = await resolveAssetRoot('model.fireredvad');
console.log(`[termux-speech] model.fireredvad ${vadAsset.version} → ${vadAsset.root}`);

vad = new VadController({
  android,
  modelRoot: vadAsset.root,
  dataRoot: VAD_DATA_ROOT,
  config: cfg.vad,
  residentId: VAD_RESIDENT_ID,
  // WAV 回收的保留判据由 ASR 提供：只有它知道自己还没消费完哪些段。
  retainSegment: (segmentId) => asr.holdsSegment(segmentId),
  onSegment: handleVadSegment,
  onChange: onStageChange,
  /**
   * 只处理 **Termux-OS 自己明确知道的 TTS**（docs/061 §四.1）。
   * ⛔ 不因为「外面在放音乐」就丢段——使用者可能正想识别 YouTube 里的那句话，
   * 而我们根本无从判断第三方播放的内容是不是他要的。
   */
  dropPolicy: ({ start_mono_ms: startMonoMs, end_mono_ms: endMonoMs }) => {
    const hit = appEvents.intervals.overlaps(startMonoMs, endMonoMs);
    return hit ? { reason: 'tts_overlap', playback_id: hit.playback_id ?? null } : null;
  },
});

const playWakeCue = async () => {
  if (cfg.kws.cue_enabled === false) return null;
  try {
    const playback = await android.json('/api/android/audio/cue', {
      method: 'POST',
      body: { cue: 'wake' },
      timeoutMs: 5000,
    });
    return kws.recordCue({ ok: true, playback });
  } catch (error) {
    return kws.recordCue({ ok: false, error: String(error?.message ?? error) });
  }
};

kws = new KwsController({
  android,
  dataRoot: WAKE_WORDS_ROOT,
  config: cfg.kws,
  persistConfig: (patch) => {
    cfg = saveKwsConfig(CONFIG_FILE, patch);
    return cfg.kws;
  },
  /**
   * ⭐ 唤醒命中也是一个 requester，必须走同一个 lifecycle（docs/061 §五：所有状态转移
   * 经过一个串行化的 controller）。
   *
   * ⚠ 第一版让它绕过去了，后果有两个：听写组的状态在整场 KWS 会话里都报 `unloaded`
   * （**状态在说谎**），而且模型没被载入过时 `arm()` 照样成功、直到第一次 `stream()`
   * 才现场 declare——于是唤醒后要等约 2.5 秒才有第一个 VAD 判定。使用者反馈的
   * 「KWS 效果明显变差」就是这个。
   */
  onHit: async (hit) => {
    const engaged = await lifecycle.engage(KWS_REQUESTER, { reason: 'kws_hit' });
    if (!engaged.ok) {
      kws.recordHitOutcome(hit, false, engaged.reason);
      return false;
    }
    const outcome = await engagePipeline(hit, 'kws_hit', { cue: true });
    if (!outcome.ok) await lifecycle.release(KWS_REQUESTER, { force: true, reason: outcome.reason });
    kws.recordHitOutcome(hit, outcome.ok, outcome.reason);
    return outcome.ok;
  },
  onChange: onStageChange,
});

const applyOwnerTimeout = (nowMs = Date.now()) => {
  // 模式期间没有任何超时有资格关门：使用者在想措辞，不是走开了。
  if (listenEngaged()) return null;
  const request = pipeline.owner === PIPELINE_OWNERS.KWS
    ? kws.pollClose(nowMs)
    : pipeline.owner === PIPELINE_OWNERS.VAD
      ? vad.pollReset(nowMs)
      : pipeline.owner === PIPELINE_OWNERS.ASR
        ? asr.pollClose(nowMs)
        : null;
  if (!request) return null;
  return applyPipelineIdle({ ...request, epoch: request.epoch ?? pipeline.epoch }, nowMs);
};

/**
 * ⭐ **每帧不再构造整棵状态树**（docs/061 §五）。
 *
 * 这里曾经调 `project()`——而 PCM 是 100ms 一帧，加上 200ms 的 tick，那棵 14KB 的树
 * 每秒被重建 15 次，其中还包含 64 条 transition 的深拷贝和五次 `existsSync`。
 * 帧到达时真正变化的只有音量与帧计数，所以这里只更新它们，并**标记**状态脏了；
 * 什么时候真的构造，由「此刻有没有人在看」决定（`hub.pump()`）。
 */
const ingestPcmFrame = (frame, meta) => {
  const nowMs = Number(meta?.observed_at_ms) || Date.now();
  const previousTransition = state.rms_gate?.transition_seq;
  let snapshot = gate.ingest({
    rms: rmsS16le(frame),
    recording: true,
    frameSeq: meta?.frame_seq,
    sampleAgeMs: 0,
  }, nowMs);
  observeGateLifecycle(snapshot, nowMs);
  vad.ingestPcm(frame, meta);
  if (applyOwnerTimeout(nowMs)?.accepted) snapshot = gate.snapshot(nowMs);
  state.rms_gate = snapshot;
  state.pcm_frame_count += 1;
  state.state = readyNow() ? 'ready' : 'idle';
  // ⛔ 只登记，不在这里构造：观测绝不能挂在处理链上（docs/061 §1）。
  hub?.markHot();
  hub?.schedule();
  flush(previousTransition !== snapshot.transition_seq);
};

pcm = new PcmWs({
  onFrame: ingestPcmFrame,
  onState: () => onStageChange(),
});

/**
 * ⭐ 每 50 句一组的记录存储（docs/061 §七）。**独立命名空间**，与旧的 VAD Reservoir
 * 和旧的 transcripts.v1.jsonl 完全不相干——那两样一条都不导入、一条都不删。
 */
const archive = new RecordArchive({ file: `${RECORD_DATA_ROOT}/archive.v1.sqlite3` });
/**
 * 转写观测者。⛔ 不是定时器：`/asr/transcripts/watch` 挂在这里，直到**真的多了一句**
 * 才醒来。旧的 WS 桥每 200ms 向上游要一次，于是每个打开的页面都是一条 5Hz 的空转回路。
 */
const transcriptWaiters = new Set();
const notifyTranscripts = () => {
  for (const waiter of [...transcriptWaiters]) {
    transcriptWaiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
};
const awaitTranscript = (timeoutMs) => new Promise((resolve) => {
  const waiter = { resolve, timer: null };
  waiter.timer = setTimeout(() => { transcriptWaiters.delete(waiter); resolve(); }, timeoutMs);
  if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
  transcriptWaiters.add(waiter);
});

records = new RecordGroups({
  root: RECORD_DATA_ROOT,
  archive,
  // ⭐ `stillQueued` 已随准入后移一起去掉：组里不可能存在没有结论的 item，
  // 「还在排队」是 ASR 自己的持久队列回答的问题，不再需要记录组去猜。
  onChange: () => { flush(); notifyTranscripts(); hub?.markCold(); hub?.schedule(); },
});

/**
 * ⭐ 资源生命周期的唯一协调者（docs/061 §五）。
 *
 * Mic 需求、唤醒组、听写组、常驻 load/unload 四件事必须**串行**经过它：并发的
 * 停链与 engage 各跑一半，会留下「VAD 卸了 ASR 还在」这种没有名字的状态。
 * 它也是「模型在不在内存里」的唯一答案——lease 说的是谁有资格关门，那是另一个问题。
 */
lifecycle = new LifecycleController({
  warmTimeoutMs: Math.max(0, Number(cfg.dictation_warm_timeout_seconds) || 0) * 1000,
  residency: cfg.graph_residency,
  mic: {
    // ⛔ 只动 speech 自己那一份需求。`user.persistent` 归使用者，speech 停链不许碰它，
    // 否则「我关掉的麦克风被别人替我打开了」会变成没有人负责的行为。
    request: async (requester, wanted) => {
      await android.json('/api/android/mic/demand', {
        method: 'POST',
        body: { requester, desired: wanted === true },
      });
      return { ok: true };
    },
  },
  wake: {
    load: async () => { kws.resume(); await kws.refresh(); },
    // ⚠ 这不是「卸载 KWS」：拼音三张图是 App 自己声明的常驻，App 内还有别的消费者。
    // 这里撤销的只有 speech 自己的订阅与检测——而 `service` 策略下连订阅都留着，
    // 因为 App 会在最后一个订阅者离开时拆掉那三张图。
    unload: async () => { kws.suspend({ keepSubscription: cfg.graph_residency === 'service' }); },
  },
  dictation: {
    loadVad: () => vad.ensureResident(),
    loadAsr: () => asr.ensureResident(),
    unloadVad: () => vad.unloadResident(),
    unloadAsr: () => asr.unloadResident(),
  },
  onChange: () => { flush(); },
  onWarmUnload: () => { syncPcmDemand(); onStageChange(); },
});

/**
 * 停链。⚠ 撤销 Mic 需求与卸载模型都发生在 lifecycle 内部（串行），这里只负责
 * 把流水线本身收回 idle——正在形成的那一段音频由 `vad.unloadResident()` 的 resetRun
 * 丢掉，**半段被污染的音频绝不会送进 ASR**。
 */
const stopChain = async ({ reason = 'api', force = false } = {}) => {
  const result = await lifecycle.stopChain({ reason, force });
  if (!result.ok && result.reason === 'requesters_active') return result;
  applyPipelineIdle({
    requester: 'chain',
    owner: 'chain',
    force: true,
    reason: `chain_stop:${reason}`,
    metadata: { revoked: result.revoked ?? [] },
  });
  syncPcmDemand();
  onStageChange();
  return result;
};

const startChain = async (reason = 'api') => {
  const result = await lifecycle.startChain(reason);
  syncPcmDemand();
  onStageChange();
  return result;
};

/**
 * 常驻声明的收敛点。
 *
 * 待机形态要求 KWS/VAD/ASR 三张图在**唤醒之前**就已经在内存里（docs/053 §1），所以声明必须
 * 在服务启动时发出，而不是等第一次 `run`/`stream`——否则第一次唤醒要现场付载入，恰好把代价
 * 放在唯一在意延迟的那条路径上。声明是幂等的，已声明后本函数只是两次布尔检查。
 */
/**
 * 启动对账。⛔ **既不 declare 也不 undeclare**——服务重启、dev reload、framework 重启
 * 都不是 churn HTP 会话的理由（docs/046 记过 `createSession` churn 会污染进程 QNN
 * context 致 SIGSEGV）。这里只把内部状态收敛到 App 侧**已经存在**的事实上，
 * 与 docs/051「不写崩溃恢复分支」是同一条原则：冷启 / 重启 / 变更走同一条路径。
 */
const reconcileFromApp = async () => {
  let residents = [];
  let micHeld;
  try {
    const listed = await android.json('/api/inference/residents');
    residents = Array.isArray(listed?.residents) ? listed.residents : [];
  } catch (error) {
    state.residents = `reconcile failed: ${String(error?.message ?? error)}`;
    return null;
  }
  const declared = (id) => residents.some((item) => item?.id === id);
  try {
    const mic = await readMic();
    micHeld = (mic?.demand?.holders ?? []).includes(MIC_REQUESTER);
    appEvents.observeSnapshot(mic?.capture, mic?.capture?.boot_id);
  } catch { micHeld = undefined; }
  const value = lifecycle.reconcile({
    vadLoaded: declared(VAD_RESIDENT_ID),
    asrLoaded: declared(ASR_RESIDENT_ID),
    micHeld,
  });
  state.residents = `reconciled vad=${declared(VAD_RESIDENT_ID)} asr=${declared(ASR_RESIDENT_ID)}`
    + ` dictation=${value.dictation} mic_held=${value.mic_demand.held}`;
  return value;
};

let memoryCache = null;
let refreshPromise = null;
let lastReconcileMs = 0;
async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const [devices, mic, descriptor, , memory] = await Promise.all([
        readInputs(),
        readMic(),
        android.describe(),
        kws.refresh(),
        // 記憶體只是參考值：取不到就保留上一次，絕不因此讓整輪 refresh 失敗。
        // ⚠ 但**不要把原因也一起吞掉**——只回 null 的话，"還沒刷新" 与 "每次都失敗"
        // 在页面上长得一模一样（docs/056：错误答案与合法答案在型别上不可区分）。
        readMemory().then(
          (value) => ({ value }),
          (error) => ({ error: String(error?.message ?? error) }),
        ),
      ]);
      sources.devices = devices;
      sources.mic = mic;
      // /proc/meminfo 是本地读，取不到才是真异常；App 那份是补充口径。
      let proc = null;
      try { proc = readProcMeminfo(); } catch { proc = null; }
      if (memory.value || proc) {
        memoryCache = {
          avail_mb: proc?.avail_mb ?? (Number(memory.value?.avail_mb) || null),
          total_mb: proc?.total_mb ?? (Number(memory.value?.total_mb) || null),
          used_mb: proc?.used_mb ?? null,
          swap_used_mb: proc?.swap_used_mb ?? null,
          // App 口径（availMem）与 /proc 的 MemAvailable 不是同一个数，分开列出而不是二选一
          app_avail_mb: Number(memory.value?.avail_mb) || null,
          low_memory: memory.value?.low_memory === true,
          error: memory.error ?? null,
          at_ms: Date.now(),
        };
      } else if (memory.error) {
        memoryCache = { ...(memoryCache ?? {}), error: memory.error, at_ms: Date.now() };
      }
      pcm.configure(pcmWebSocketDescriptor(descriptor));
      appEvents.configure(descriptor);
      appEvents.start();
      syncPcmDemand();
      // 只在**我们正声称有东西载着**时才去核对——没载东西就没有什么可核对的。
      // 10 秒一次是为了发现 App 重装/声明被清这类罕见事实，不是状态的主来源。
      if (lifecycle.dictationLoaded() && Date.now() - lastReconcileMs > 10_000) {
        lastReconcileMs = Date.now();
        await reconcileFromApp();
      }
      const value = project();
      publishStates(value);
      state.state = value?.ready ? 'ready' : 'idle';
      state.last_error = null;
      state.refresh_count += 1;
      flush(true);
      return value;
    } catch (error) {
      state.state = 'degraded';
      state.last_error = String(error?.message ?? error);
      flush(true);
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

let tickPromise = null;
async function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = (async () => {
    try {
      // ⚠ 这里曾经每 200ms 向 App 要一次 mic status（docs/056）。它提供的是设备名、采样率与
      // `recording` 标志——没有一个是 5Hz 量级的事实，而**帧是否还在流动**由本地的
      // `pcm.snapshot()` 回答，根本不需要过一趟 HTTP。`refresh()` 每 2 秒取一次已经够了。
      const stream = pcm.snapshot();
      if (!stream.connected || stream.last_frame_age_ms === null || stream.last_frame_age_ms > 1000) {
        const snapshot = gate.ingest({
          rms: null,
          recording: false,
          frameSeq: stream.frame_seq,
          sampleAgeMs: 1001,
        });
        observeGateLifecycle(snapshot);
      }
      // ⚠ 兜底，不是主路径：只有「按需求本该有 PCM，却长时间一帧都没有」才去读一次快照，
      // 有界退避 2/5/10/30 秒，恢复即停。事实的主来源是 `/ws/android/events` 的推送。
      await captureWatchdog.poll({
        expected: lifecycle.wantsPcm(),
        lastFrameAgeMs: stream.last_frame_age_ms,
      });
      applyOwnerTimeout();
      state.state = readyNow() ? 'ready' : 'idle';
      // ⚠ 同样**不构造整棵树**：tick 是 5Hz 的巡检，它要的是「帧还在不在」，
      // 而那个问题由 `pcm.snapshot()` 本地回答（docs/056）。状态只标脏。
      hub.markHot();
      hub.schedule();
      flush();
    } catch (error) {
      state.last_error = String(error?.message ?? error);
      state.state = 'degraded';
      flush(true);
    } finally {
      tickPromise = null;
    }
  })();
  return tickPromise;
}

/**
 * ⭐ 状态域（docs/061 §五）。
 *
 * ⚠ 这里**删掉了 `value`（speech_input）**。它并不是额外的事实——`projectSpeechInput`
 * 把 `rms_gate`/`pipeline`/`kws`/`vad`/`asr` 原样嵌进去，而这五个同时还在顶层，
 * 于是 `/live` 每次都把同一批对象发**两遍**：实测 28,859 字节里有 14,158 是这份副本。
 * 概览真正需要而别处没有的只有 `ready`/`reason`/`selection`/`pcm` 四项，故留下一个
 * 小小的 `input` 域；完整投影仍在 `/speech-input`（Capability 的正式出口），
 * 以及诊断页按需拉取。
 */
const DOMAIN_BUILDERS = {
  // ── 慢速域：只在真的发生了事情时变 ────────────────────────────────────
  // 服务自身的健康。概览页要回答的第一个问题是「有没有出事」。
  service: () => ({
    state: state.state,
    last_error: state.last_error,
    started_at: state.started_at,
    residents: state.residents,
  }),
  // ⚠ listen 由外部调用方（termux-ime）随时改变。不推给页面，它就只能在手动刷新的
  // 那一刻才知道听写已经被别人接管了。
  listen: () => listenSnapshot(),
  lifecycle: () => lifecycle.snapshot(),
  capture: () => ({ ...appEvents.snapshot(), watchdog: captureWatchdog.snapshot() }),
  records: () => records.snapshot(),
  memory: () => memoryCache,
  states: () => bus.snapshot(),
  asr: () => asr.snapshot(),
  // ⚠ `transitions` 不在里面：那是**诊断历史**，64 条深拷贝挂在最高频的通道上没有道理。
  // 需要时走 `/pipeline/transitions`。
  pipeline: () => pipelineWithoutHistory(),
  // ── 高频域：随音频持续变化 ───────────────────────────────────────────
  rms_gate: () => gate.snapshot(),
  pcm_stream: () => pcm.snapshot(),
  pcm_pool: () => vad.snapshot().pcm_pool ?? null,
  kws: () => kws.snapshot(),
  vad: () => vad.snapshot(),
  input: () => inputProjection(),
};

const HOT_DOMAINS = ['rms_gate', 'pcm_stream', 'pcm_pool', 'kws', 'vad', 'input'];

/** 概览需要、而别的域里没有的那四项。刻意小：它跟着音量一起走高频通道。 */
const inputProjection = () => {
  const stream = pcm.snapshot();
  const mic = sources.mic;
  const devices = sources.devices;
  const selector = devices?.configured?.input_device ?? mic?.configured_input_device ?? 'system_default';
  const recording = mic?.recording === true;
  const fresh = stream.connected === true
    && Number.isFinite(Number(stream.last_frame_age_ms))
    && Number(stream.last_frame_age_ms) <= 1000;
  return {
    ready: recording && fresh,
    reason: !recording ? 'microphone_not_recording'
      : !stream.connected ? 'authenticated_pcm_stream_not_connected'
        : !fresh ? 'pcm_stream_stale' : null,
    selection: {
      selector,
      system_default: selector === 'system_default',
      preferred_device: mic?.preferred_input_device ?? null,
      routed_device: mic?.routed_input_device ?? null,
    },
    /**
     * ⭐ 谁在吊着麦克风。停链撤销的只有 `termux-speech` 那一份；`user.persistent` 是
     * **跨停链、跨重启**的另一份，界面必须说出它的名字。
     *
     * 真机上正是它独自吊着采集录了 1.8 GB，而没有任何人认为自己开着它——
     * 界面只显示「采集中」的时候，「谁要它采集」这个问题根本无处可问。
     */
    demand: {
      holders: mic?.demand?.holders ?? [],
      speech_holds: (mic?.demand?.holders ?? []).includes(MIC_REQUESTER),
      persistent: (mic?.demand?.holders ?? []).includes(USER_MIC_REQUESTER),
    },
    pcm: {
      sample_rate_hz: Number(stream.sample_rate_hz) || Number(mic?.rate) || 16_000,
      recording,
      transport_connected: stream.connected === true,
      frame_seq: Number(stream.frame_seq) || 0,
      last_frame_age_ms: stream.last_frame_age_ms ?? null,
    },
  };
};

const pipelineWithoutHistory = () => {
  const { transitions, ...rest } = pipeline.snapshot();
  return { ...rest, transitions_count: transitions?.length ?? 0 };
};

const hub = new StateHub({ builders: DOMAIN_BUILDERS, hot: HOT_DOMAINS });

/**
 * `/live` 保留：脚本、`verify-device` 与外部巡检仍然要一发就拿到全部事实。
 * ⛔ 但它**不再是页面的主路径**——页面走 `/state/*`，只在变化时拿增量。
 */
const live = () => JSON.parse(hub.snapshotJson()).domains;

const readBody = (req, limit = 16_384) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > limit) return reject(new UpstreamError('request body too large', 413));
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch { reject(new UpstreamError('invalid json', 400)); }
  });
  req.on('error', reject);
});

const updateGateConfig = (body) => {
  const patch = Object.fromEntries(['open_threshold']
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]]));
  try {
    cfg = saveRmsGateConfig(CONFIG_FILE, patch);
  } catch (error) {
    throw new UpstreamError(String(error?.message ?? error), 400);
  }
  gate.configure(cfg.rms_gate);
  project();
  flush(true);
  return cfg.rms_gate;
};

const updateKwsConfig = (body) => {
  const patch = {};
  if (body.active_profile_id !== undefined) {
    const profileId = body.active_profile_id === null ? null : String(body.active_profile_id);
    if (profileId) {
      const profile = kws.profile(profileId);
      if (!profile.model?.templates?.length) {
        throw new UpstreamError('请先为这个唤醒词生成匹配', 409);
      }
    }
    patch.active_profile_id = profileId;
  }
  if (body.idle_timeout_ms !== undefined) patch.idle_timeout_ms = body.idle_timeout_ms;
  if (body.cue_enabled !== undefined) patch.cue_enabled = body.cue_enabled;
  try {
    const value = kws.setConfig(patch);
    project();
    flush(true);
    return value;
  } catch (error) {
    throw new UpstreamError(String(error?.message ?? error), Number(error?.status) || 400);
  }
};

const updateVadConfig = (body) => {
  const patch = Object.fromEntries(['pcm_pool_ms', 'no_output_timeout_ms']
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]]));
  try {
    cfg = saveVadConfig(CONFIG_FILE, patch);
  } catch (error) {
    throw new UpstreamError(String(error?.message ?? error), 400);
  }
  const value = vad.configure(cfg.vad);
  project();
  flush(true);
  return value;
};

const updateAsrConfig = (body) => {
  const patch = Object.fromEntries([
    'enabled',
    'model',
    'language',
    'text_normalization',
    'keyword_end_enabled',
    'end_keywords',
    'timeout_end_enabled',
    'idle_timeout_ms',
  ]
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]]));
  try {
    cfg = saveAsrConfig(CONFIG_FILE, patch);
  } catch (error) {
    throw new UpstreamError(String(error?.message ?? error), 400);
  }
  const value = asr.configure(cfg.asr);
  project();
  flush(true);
  return value;
};

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;
  if (req.method === 'GET' && route === '/health') {
    return send(200, { ok: true, service: 'termux-speech', state: state.state });
  }
  if (!systemKeyAuthorized(req.headers.authorization, SYSTEM_KEY)) {
    return send(401, { ok: false, error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET' && route === '/status') {
      return send(200, { ok: true, service: 'termux-speech', status: state });
    }
    /**
     * 模型架。⭐ 这是**唯一**能取得或删除语音模型的地方——资产包刻意不出现在
     * Framework 自己的 Package 页面上，因为一份模型权重属于需要它的那个包。
     */
    if (req.method === 'GET' && route === '/models') {
      return send(200, { ok: true, ...(await listModels(PACKAGE_ROOT)) });
    }
    if (req.method === 'POST' && route === '/models/fetch') {
      const body = await readBody(req);
      const r = await fetchModel(String(body?.id ?? ''));
      return send(r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && route === '/models/install-provider') {
      const body = await readBody(req);
      const r = await installProvider(String(body?.id ?? ''));
      return send(r.ok ? 202 : 409, r);
    }
    if (req.method === 'POST' && route === '/models/delete') {
      const body = await readBody(req);
      const r = await removeModel(String(body?.id ?? ''));
      return send(r.ok ? 200 : 409, r);
    }
    if (req.method === 'GET' && route === '/live') {
      hub.markAll();
      hub.build();
      return send(200, { ok: true, ...live() });
    }
    /**
     * 状态订阅（docs/061 §五）。两条：
     *  - `/state` 一次完整 snapshot（新连接、页面重新可见时用）
     *  - `/state/watch?after=&boot_id=` **挂到有变化为止**，最长 25 秒
     *
     * ⛔ 这不是「间隔更长的轮询」：状态不变时它一个字节都不返回，请求数正比于
     * 事实变了几次而不是页面开了多久。`boot_id` 变了就退回完整 snapshot，
     * 于是重连绝不会拿着上一条命的版本号覆盖新状态。
     */
    if (req.method === 'GET' && route === '/state') {
      hub.markAll();
      hub.build();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(hub.snapshotJson());
    }
    if (req.method === 'GET' && route === '/state/watch') {
      const result = await hub.watch(
        url.searchParams.get('after'),
        url.searchParams.get('boot_id'),
        Number(url.searchParams.get('timeout_ms')) || WATCH_TIMEOUT_MS,
      );
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(result.json);
    }
    if (req.method === 'GET' && route === '/state/stats') {
      return send(200, { ok: true, value: hub.stats() });
    }
    /**
     * 诊断历史。⚠ 从高频通道里搬出来的：64 条 transition 每条都要深拷贝，
     * 挂在每秒十几次的投影上纯属白烧，而它每分钟才变几次。
     */
    if (req.method === 'GET' && route === '/pipeline/transitions') {
      return send(200, {
        ok: true,
        schema: 'termux-os.speech-pipeline-transitions.v1',
        transitions: pipeline.snapshot().transitions,
      });
    }
    if (req.method === 'GET' && route === '/pipeline') {
      // listen 挂在 pipeline 下：它改变的正是「谁有资格关门」这件事。
      return send(200, { ok: true, value: { ...pipeline.snapshot(), listen: listenSnapshot() } });
    }
    if (req.method === 'GET' && route === '/states') {
      return send(200, { ok: true, value: bus.snapshot() });
    }
    if (req.method === 'GET' && route === '/listen') {
      return send(200, { ok: true, value: listenSnapshot() });
    }
    if (req.method === 'POST' && route === '/listen') {
      const body = await readBody(req);
      const requester = typeof body.requester === 'string' && body.requester.trim()
        ? body.requester.trim().slice(0, 64) : 'api';
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 128) : 'listen_mode';
      const result = body.enabled === true
        ? await enterListen({ reason, requester })
        : await exitListen({
          reason,
          requester,
          // 只有持有者本人（且是同一次 lease）能普通释放；不带 generation 视为不校验，
          // 保持既有调用方（termux-ime）可用。`force` 留给强制停链。
          generation: body.generation ?? null,
          force: body.force === true,
        });
      // ⚠ 刻意**不带** live()：这条会在每一次焦点变化时被调用，而 live() 是整份 status
      // （实测 8KB+）。把巡检用的大快照挂在最高频的控制端点上，是白烧的带宽。
      return send(result.ok ? 200 : 409, {
        ok: result.ok, reason: result.reason, value: result.value,
      });
    }
    if (req.method === 'GET' && route === '/records') {
      const limit = url.searchParams.get('limit');
      return send(200, {
        ok: true,
        value: records.snapshot(),
        // ⚠ 只从**新机制**里读。旧 JSONL 一条都不混进来——两种来源混在一起之后，
        // 「这条记录归哪一套管」就再也说不清了。
        recent: records.recent(limit ?? 10),
      });
    }
    if (req.method === 'GET' && route === '/records/archive') {
      // 最小内部查询：用来验证归档内容确实落了库（§七.6）。
      await archive.open();
      return send(200, {
        ok: true,
        ...archive.query({
          limit: url.searchParams.get('limit'),
          groupId: url.searchParams.get('group_id'),
        }),
        stats: archive.stats(),
      });
    }
    if (req.method === 'GET' && route === '/lifecycle') {
      return send(200, {
        ok: true,
        value: lifecycle.snapshot(),
        capture: { ...appEvents.snapshot(), watchdog: captureWatchdog.snapshot() },
        config: {
          chain_desired: cfg.chain_desired,
          dictation_warm_timeout_seconds: cfg.dictation_warm_timeout_seconds,
          graph_residency: cfg.graph_residency,
        },
      });
    }
    if (req.method === 'POST' && route === '/lifecycle/config') {
      const body = await readBody(req);
      const patch = Object.fromEntries([
        'chain_desired', 'dictation_warm_timeout_seconds', 'graph_residency',
      ]
        .filter((key) => body[key] !== undefined)
        .map((key) => [key, body[key]]));
      try {
        cfg = saveLifecycleConfig(CONFIG_FILE, patch);
      } catch (error) {
        throw new UpstreamError(String(error?.message ?? error), 400);
      }
      // 保温时长改了要立刻生效，但**不能**顺手重排一个已经在跑的倒计时：
      // 那会让「把 300 改成 5 秒」意外地延长当前这一次保温。
      lifecycle.warmTimeoutMs = Math.max(0, Number(cfg.dictation_warm_timeout_seconds) || 0) * 1000;
      lifecycle.residency = cfg.graph_residency;
      return send(200, {
        ok: true,
        value: {
          chain_desired: cfg.chain_desired,
          dictation_warm_timeout_seconds: cfg.dictation_warm_timeout_seconds,
          graph_residency: cfg.graph_residency,
        },
        lifecycle: lifecycle.snapshot(),
      });
    }
    if (req.method === 'POST' && route === '/chain/start') {
      const body = await readBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 128) : 'api';
      const result = await startChain(reason);
      if (result.ok) cfg = saveLifecycleConfig(CONFIG_FILE, { chain_desired: 'started' });
      return send(result.ok ? 200 : 409, {
        ok: result.ok,
        reason: result.reason,
        error: result.error ?? null,
        value: result.value,
      });
    }
    if (req.method === 'POST' && route === '/chain/stop') {
      const body = await readBody(req);
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 128) : 'api';
      const result = await stopChain({ reason, force: body.force === true });
      // ⚠ 外部 requester（termux-ime 等）持着听写时，普通停链请求返回 409 并列出是谁——
      // 误触不该静默掐掉别人的听写。要收走它必须明确 force。
      if (!result.ok && result.reason === 'requesters_active') {
        return send(409, {
          ok: false,
          reason: 'requesters_active',
          requesters: result.requesters,
          value: result.value,
        });
      }
      if (result.ok) cfg = saveLifecycleConfig(CONFIG_FILE, { chain_desired: 'stopped' });
      return send(result.ok ? 200 : 500, {
        ok: result.ok,
        reason: result.reason,
        revoked: result.revoked ?? [],
        error: result.error ?? null,
        value: result.value,
      });
    }
    if (req.method === 'POST' && route === '/idle') {
      const body = await readBody(req);
      const decision = applyPipelineIdle({
        requester: 'developer',
        owner: 'developer',
        force: true,
        reason: typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim().slice(0, 128)
          : 'developer_speech_idle',
        metadata: { requested_by: body.requested_by ?? 'api' },
      });
      return send(200, { ok: true, value: decision });
    }
    if (req.method === 'GET' && route === '/rms') {
      return send(200, { ok: true, value: gate.snapshot() });
    }
    if (req.method === 'GET' && route === '/rms/config') {
      return send(200, { ok: true, value: cfg.rms_gate });
    }
    if (req.method === 'POST' && route === '/rms/config') {
      const value = updateGateConfig(await readBody(req));
      return send(200, { ok: true, value });
    }
    if (req.method === 'GET' && route === '/kws') {
      return send(200, { ok: true, value: kws.snapshot() });
    }
    if (req.method === 'GET' && route === '/kws/config') {
      return send(200, { ok: true, value: kws.publicConfig() });
    }
    if (req.method === 'POST' && route === '/kws/config') {
      const value = updateKwsConfig(await readBody(req));
      return send(200, { ok: true, value });
    }
    if (req.method === 'GET' && route === '/vad') {
      return send(200, { ok: true, value: vad.snapshot() });
    }
    if (req.method === 'GET' && route === '/vad/config') {
      return send(200, { ok: true, value: vad.publicConfig() });
    }
    if (req.method === 'POST' && route === '/vad/config') {
      const value = updateVadConfig(await readBody(req));
      return send(200, { ok: true, value });
    }
    if (req.method === 'GET' && route === '/vad/activity') {
      return send(200, { ok: true, ...vad.activity(url.searchParams.get('after')) });
    }
    if (req.method === 'GET' && route === '/asr') {
      return send(200, { ok: true, value: asr.snapshot() });
    }
    if (req.method === 'GET' && route === '/asr/config') {
      return send(200, { ok: true, value: asr.publicConfig() });
    }
    if (req.method === 'POST' && route === '/asr/config') {
      const value = updateAsrConfig(await readBody(req));
      return send(200, { ok: true, value });
    }
    /**
     * `speech.transcript` Capability 的落地端点。
     * ⛔ **只从记录组读**——旧的 `transcripts.v1.jsonl` 与旧的内存水库都已删除。
     * 端点路径与 `{observations, next}` 形状保持不变：`termux-ime` 和
     * `termux-interpreter` 是按 Capability 解析到这里的，换掉形状等于悄悄弄坏它们。
     */
    if (req.method === 'GET' && route === '/asr/transcripts') {
      return send(200, {
        ok: true,
        ...records.feed(
          url.searchParams.get('after'),
          url.searchParams.get('limit'),
        ),
      });
    }
    /**
     * 转写增量，**等到有新句子再回答**（上限 25 秒）。WS 桥用它。
     * ⚠ 与 `/asr/transcripts` 同一个游标语义，只是会挂着。
     */
    if (req.method === 'GET' && route === '/asr/transcripts/watch') {
      const after = url.searchParams.get('after');
      const limit = url.searchParams.get('limit');
      const deadline = Date.now() + WATCH_TIMEOUT_MS;
      let feed = records.feed(after, limit);
      while (feed.observations.length === 0 && Date.now() < deadline) {
        await awaitTranscript(Math.max(500, deadline - Date.now()));
        feed = records.feed(after, limit);
      }
      return send(200, { ok: true, ...feed });
    }
    if (req.method === 'POST' && route === '/asr/transcribe') {
      // 重转写只能从**记录组**取段：旧的 Reservoir 已经不存在，而它留下的
      // `wav_path` 指向的文件早就被移进了某一组的目录。
      const body = await readBody(req);
      // ⚠ 按 id 查一条要跨全部活组（`find`），不能用显示窗口 `recent(50)` 代替：
      // 当前组一满 50 条就把窗口占满，上一组的段就永远「不存在」了。
      const item = body.segment_id ? records.find(body.segment_id) : records.recent(1)[0];
      if (!item?.wav_path) throw new UpstreamError('record item with WAV not found', 404);
      const queued = asr.enqueue({
        segment_id: item.segment_id,
        wav_path: item.wav_path,
        duration_ms: item.duration_ms,
        start_ms: item.segment_start_ms,
        end_ms: item.segment_end_ms,
        sample_rate_hz: 16_000,
        channels: 1,
        encoding: 'pcm_s16le',
      }, { epoch: pipeline.epoch, retranscribe: true });
      return send(202, { ok: true, queued, asr: asr.snapshot() });
    }
    if (req.method === 'GET' && route === '/wake-words/profiles') {
      return send(200, { ok: true, ...kws.list() });
    }
    if (req.method === 'GET' && route === '/wake-words/profile') {
      return send(200, {
        ok: true,
        profile: kws.profile(url.searchParams.get('id')),
      });
    }
    if (req.method === 'POST' && route === '/wake-words/profiles') {
      const body = await readBody(req);
      return send(201, { ok: true, profile: kws.create(body.display_name) });
    }
    if (req.method === 'POST' && route === '/wake-words/profile/delete') {
      const body = await readBody(req);
      return send(200, { ok: true, ...kws.remove(body.profile_id) });
    }
    if (req.method === 'POST' && route === '/wake-words/profile/build') {
      const body = await readBody(req);
      return send(200, { ok: true, ...kws.build(body.profile_id) });
    }
    if (req.method === 'POST' && route === '/wake-words/samples/delete') {
      const body = await readBody(req);
      return send(200, {
        ok: true,
        ...kws.removeSample(body.profile_id, body.sample_id),
      });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/capture/start') {
      const body = await readBody(req);
      return send(200, {
        ok: true,
        capture: kws.startCapture({
          profileId: body.profile_id,
          index: body.index,
          kind: 'enroll',
        }),
      });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/test/start') {
      const body = await readBody(req);
      return send(200, {
        ok: true,
        capture: kws.startCapture({
          profileId: body.profile_id,
          kind: 'test',
          threshold: body.threshold,
        }),
      });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/capture/poll') {
      return send(200, { ok: true, capture: kws.commitCapture() });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/capture/stop') {
      return send(200, { ok: true, capture: kws.stopCapture() });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/capture/cancel') {
      return send(200, { ok: true, capture: kws.cancelCapture() });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/stream-test/start') {
      const body = await readBody(req);
      return send(200, {
        ok: true,
        stream: kws.startStreamTest(body.profile_id, body.threshold),
      });
    }
    if (req.method === 'GET' && route === '/wake-words/guided/stream-test/status') {
      return send(200, { ok: true, stream: kws.pinyin.detectStatus() });
    }
    if (req.method === 'POST' && route === '/wake-words/guided/stream-test/stop') {
      return send(200, { ok: true, stream: kws.stopStreamTest() });
    }
    if (req.method === 'GET' && route === '/devices') {
      return send(200, { ok: true, ...inputPayload(await readInputs()) });
    }
    if (req.method === 'GET' && route === '/speech-input') {
      return send(200, { ok: true, value: await refresh() });
    }
    if (req.method === 'POST' && route === '/input-device') {
      const body = await readBody(req);
      const selector = typeof body.selector === 'string' ? body.selector.trim() : '';
      if (!selector) throw new UpstreamError('selector is required', 400);
      const current = await readInputs();
      const known = selector === 'system_default'
        || (current.inputs ?? []).some((item) => item.selector === selector);
      if (!known) throw new UpstreamError(`input device is unavailable: ${selector}`, 409);
      await android.json('/api/android/audio/config', {
        method: 'POST',
        body: { input_device: selector },
      });
      const devices = await readInputs();
      const value = await refresh();
      return send(200, { ok: true, ...inputPayload(devices), value });
    }
    if (req.method === 'POST' && (route === '/mic/enable' || route === '/mic/disable')) {
      const operation = route.endsWith('/enable') ? 'enable' : 'disable';
      await android.json(`/api/android/mic/${operation}`, { method: 'POST', body: {} });
      return send(200, { ok: true, operation, value: await refresh() });
    }
    return send(404, { ok: false, error: 'not_found' });
  } catch (error) {
    state.last_error = String(error?.message ?? error);
    if (state.state !== 'starting') state.state = 'degraded';
    flush(true);
    return send(
      Number(error?.status ?? error?.statusCode) || 500,
      { ok: false, error: state.last_error },
    );
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(
    `[termux-speech] started host=${BIND_HOST} port=${PORT}`
    + ` pool=${cfg.vad.pcm_pool_ms}ms kws-countdown=${cfg.kws.idle_timeout_ms}ms`
    + ` vad-countdown=${cfg.vad.no_output_timeout_ms}ms`
    + ` asr-countdown=${cfg.asr.idle_timeout_ms}ms`
    + ` chain=${cfg.chain_desired} warm=${cfg.dictation_warm_timeout_seconds}s`,
  );
  void (async () => {
    await refresh().catch(() => {});
    // 先对账再决定动作：这一步既不 declare 也不 undeclare，只是认清 App 那边现在是什么。
    await reconcileFromApp();
    lastReconcileMs = Date.now();
    // 归档打不开不是致命错误：记录照常写盘，只是轮转会停下并如实上报——
    // 绝不会因为「归档不可用」就把 WAV 删掉。
    const archiveOk = await archive.open();
    const recovered = records.reconcile();
    console.log(`[termux-speech] records archive=${archiveOk ? 'ready' : archive.lastError}`
      + ` groups_on_disk=${recovered.snapshot.groups_on_disk}`
      + (recovered.notes.length ? ` recovery=${recovered.notes.join(' | ')}` : ''));
    if (cfg.chain_desired === 'started') {
      await startChain('boot');
    } else {
      // ⭐ 停链是使用者的决定，服务重启不该替他撤销它。这里**什么都不做**——
      // 尤其不 undeclare：重启不是 churn HTP 会话的理由。
      console.log('[termux-speech] chain_desired=stopped; leaving residents untouched');
      onStageChange();
    }
  })();
});
flush(true);
const refreshTimer = setInterval(() => void refresh().catch(() => {}), cfg.poll_interval_ms);
const tickTimer = setInterval(() => void tick(), cfg.rms_gate.sample_interval_ms);

const bye = () => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  // ⛔ 停服务**不是**停链：这里绝不 undeclare。服务重启、dev reload、framework 重启
  // 都不是 churn HTP 会话的理由（docs/046）。下次启动由 reconcile 认清事实。
  lifecycle.cancelWarm();
  appEvents.close();
  archive.close();
  pcm.close();
  kws.close();
  vad.close();
  asr.close();
  state.state = 'stopped';
  flush(true);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);

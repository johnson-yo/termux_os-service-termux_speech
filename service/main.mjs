/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework/App transports, PCM, FireRedVAD/SenseVoice assets, and Package data/config.
 * [OUTPUT]: Mutually exclusive RMS→CAM++VAD→ASR and manual RMS→FireRedVAD→ASR paths,
 *           a monotonic rolling CAM++ USER watchdog, WAV/transcript feeds, speech.idle,
 *           and the loopback-only Android Assistant primary action. `cfg.asr.model` is the
 *           single ASR selector; App segment policy is only its low-frequency projection.
 * [POS]: Termux Speech service; PCM/tensors remain direct loopback while Framework sees control/text metadata.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { writeStatus } from './status.mjs';
import {
  loadConfig,
  saveAsrConfig,
  saveLifecycleConfig,
  saveRmsGateConfig,
  saveActivityShadowConfig,
  saveSpeakerActivityConfig,
  saveSpeakerGateConfig,
  saveVadConfig,
} from './config.mjs';
import { systemKeyAuthorized } from './http-auth.mjs';
import { createAndroidAppClient, UpstreamError } from './app-api.mjs';
import { ForegroundGate, framesToDb } from './asr/foreground.mjs';
import { RelativeForegroundGate } from './asr/relative-foreground.mjs';
import { SessionCalibrator } from './asr/session-calibrator.mjs';
import { readWavMono16 } from './asr/features.mjs';
import { RmsGate } from './rms-gate.mjs';
import { projectSpeechInput } from './speech-input.mjs';
import { SpeechPublicState, featureReadiness, SOURCE_RESIDENT, SOURCE_MANUAL } from './public-state.mjs';
import {
  PcmWs,
  RmsWs,
  pcmWebSocketDescriptor,
  rmsWebSocketDescriptor,
} from './pcm-ws.mjs';
import { VadController } from './vad/controller.mjs';
import { AsrController } from './asr/controller.mjs';
import { PIPELINE_OWNERS, PipelineLease } from './pipeline-lease.mjs';
import { PcmConsumers } from './pcm-consumers.mjs';
import { AcousticLab } from './acoustic-lab.mjs';
import { SpeakerLab } from './speaker-lab.mjs';
import { CamPlusEmbedder } from './speaker/campplus.mjs';
import { SpeakerGate } from './speaker/gate.mjs';
import { TargetActivityShadow } from './speaker/activity-shadow.mjs';
import { SpeakerActivity, TEST_DEFAULTS as ACTIVITY_TEST_DEFAULTS } from './speaker/activity.mjs';
import { AppSpeakerActivity } from './speaker/app-activity.mjs';
import { AppSegments } from './speaker/app-segments.mjs';
import {
  DEFAULT_USER_WATCHDOG_TIMEOUT_MS,
  UserWatchdog,
  monotonicNowMs,
} from './speaker/user-watchdog.mjs';
import { StateBus } from './states.mjs';
import { LifecycleController, MIC_REQUESTER } from './lifecycle/controller.mjs';
import { resolveAssetRoot } from './assets.mjs';
import { resolveLogicalModel, companionFile, companionRoot } from './logical-models.mjs';
import { AppEventsClient, CaptureWatchdog } from './capture/app-events.mjs';
import { RecordArchive } from './storage/archive.mjs';
import { RecordGroups } from './storage/groups.mjs';
import { normalizeTranscript } from './storage/text.mjs';
import {
  DEFAULT_WATCH_INTERVAL_MS,
  StateHub,
  WATCH_TIMEOUT_MS,
  normalizeWatchInterval,
} from './state-hub.mjs';
import { listModels, downloadModel, useModel, modelOperation } from './models.mjs';

/** Model absence is a capability state, not a package boot failure. */
const resolveOptionalAssetRoot = async (id) => {
  try { return await resolveAssetRoot(id); }
  catch (error) {
    console.log(`[termux-speech] optional asset ${id} unavailable: ${error?.message ?? error}`);
    return null;
  }
};

/**
 * ⭐ 状态总线的**前向引用**，真正构造在本文件很靠后（`new StateHub(...)`）。
 *
 * ⛔ 必须是 `let … = null`，**不能**是靠后的 `const`：本模块有顶层 `await`，
 *   于是模块体会在中途挂起，而挂起期间已经构造好的组件**会真的回调进来**
 *   （shadow 的 `setEnabled` 就在其中）。此时若 `hub` 还是个未初始化的 `const`，
 *   `hub?.markCold()` **不会**短路——`?.` 挡的是 `null`/`undefined`，
 *   而 TDZ 里的绑定两者都不是，读它直接 `ReferenceError` 把服务打死。
 *   真机付过这个代价：shadow 一旦被持久化成 ON，服务每次启动即崩、整包 API 全线
 *   `fetch failed`，而 14 处 `hub?.` 看上去全都写了保护。
 * ⭐ 可迁移的一条：**`?.` 保护不了「还没初始化」，只保护「初始化成了空」。**
 */
let hub = null;

/** 本包自己的目录。Manifest 是「需要哪些模型」的唯一来源，从这里读。 */
const PACKAGE_ROOT = process.env.TERMUX_OS_PACKAGE_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATUS_FILE = process.env.STATUS_FILE || '.runtime-dev/status.json';
const CONFIG_FILE = process.env.CONFIG_FILE || '.runtime-dev/conf.v4.json';
const LEGACY_CONFIG_FILE = process.env.LEGACY_CONFIG_FILE || '';
const VAD_DATA_ROOT = process.env.VAD_DATA_ROOT || '.runtime-dev/data/termux-speech/vad';
/**
 * CAM++ 的位置由 **Asset** 回答，⛔ 不再有裸路径。
 *
 * 两个档位刻意分开（`github.termux-os.asset.campplus`）：
 *   · `model.campplus.graph` 必需、generic、动态 T —— 登记走 CPU，每人只做一次；
 *   · `model.campplus.ctx`   可选、绑 `android-arm64-v73-qnn247`、固定 [1,148,80] —— 运行时。
 * ⛔ 没有匹配本机的 ctx 就如实报不可用，**绝不静默回落 CPU**：
 *   CPU 也能算出一个分数，而那正是这类验收最容易骗人的地方。
 */
const campplusGraph = await resolveOptionalAssetRoot('model.campplus.graph');
if (campplusGraph) {
  console.log(`[termux-speech] model.campplus.graph ${campplusGraph.version} → ${campplusGraph.root}`);
}
/** ⭐ 按 **role** 取；没有 role 就保持 capability unavailable，⛔ 不拼文件名。 */
const CAMPLUS_MODEL_PATH = campplusGraph?.files?.model
  ? path.join(campplusGraph.root, campplusGraph.files.model)
  : null;
/**
 * ⭐ **docs/093：CAM++ 的可执行体由模型管理器给出。**
 *
 * ⛔ 迁移前这里自己 `ensureAssetRoot('model.campplus.ctx')` 再拼 `model_ir11.onnx` ——
 *   那是 speech 在替 Asset 层做「用哪一份」的决定。而 CAM++ 现在按小模型策略
 *   **不再提供预制 CTX**，正确的可执行体来自本机准备。
 * ⚠ 没准备好就留 null：由 `SpeakerActivity.start()` 明确拒绝，
 *   ⛔ 不在这里让整个服务起不来，也⛔ 不静默回落 CPU（CPU 也能算出一个分数，
 *   而那正是这类验收最容易骗人的地方）。
 */
let CAMPLUS_CTX_PATH = null;
{
  const m = await resolveLogicalModel('model.campplus');
  if (m?.available === true) {
    CAMPLUS_CTX_PATH = m.executable.path;
    console.log(`[termux-speech] model.campplus → ${CAMPLUS_CTX_PATH} (${m.executable.kind})`);
  } else {
    console.log(`[termux-speech] model.campplus not usable: ${m?.reason} — ${m?.hint ?? ''}`);
  }
}
const ASR_DATA_ROOT = process.env.ASR_DATA_ROOT || '.runtime-dev/data/termux-speech/asr';
/**
 * ⭐ **全新的存储命名空间**（docs/061 §七.1）。旧的 `vad/wav/segments.v1.jsonl` 与
 * `asr/transcripts/transcripts.v1.jsonl` 一律不导入、不删除、不计入新分组、不在新界面出现。
 */
const RECORD_DATA_ROOT = process.env.RECORD_DATA_ROOT || '.runtime-dev/data/termux-speech/records';

/**
 * ⛔ 使用者的声音不进相册。
 *
 * 这些目录装的是**这个人说过的话**——登记录音、切出来的段、记录组里的 WAV。
 * 它们落在 /sdcard 上，而 Android 的媒体扫描器会把音频文件收进「文件」与相册类应用，
 * 于是一段声纹登记录音会出现在与家庭照片同一个列表里。`.nomedia` 是唯一的开关。
 * ⚠ 只创建、不删除任何东西；已经被扫进去的条目会在下一次扫描时随之消失。
 */
const shieldFromMediaScanner = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, '.nomedia');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
    return true;
  } catch { return false; }        // 挡不住就如实不挡，⛔ 不因此让服务起不来
};
/** 数据根一层就够：`.nomedia` 对整棵子树生效。 */
const SPEECH_DATA_ROOT = path.dirname(RECORD_DATA_ROOT);
const nomediaOk = shieldFromMediaScanner(SPEECH_DATA_ROOT);
console.log(`[termux-speech] media-scanner shield at ${SPEECH_DATA_ROOT}: ${nomediaOk ? 'ok' : 'FAILED'}`);

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
const PACKAGE_ID = process.env.TERMUX_OS_PACKAGE_ID || '';
/**
 * ⭐ **常驻 id 只能有一个来源**（docs/091 P6）。
 *
 * 正常路径是 `package.mjs` 注入 `tsp-*-<sha256(packageId).slice(0,8)>`。
 * ⚠ 但兜底常量 `tsp-*-local` 曾经真的落到过设备上：某一次**没有经 Framework 注入 env**
 * 的运行按兜底名声明了一套图，而 App 的声明态是**落盘**的——于是那套孤儿被对赈器
 * 永远补回来，两份同图各占一个 HTP session，没有任何界面说得出这件事。
 *
 * 现在只要知道 `packageId`，就**自己算出同一个摘要**，⛔ 不再回落到一个谁也不认识的名字。
 * 真正的裸跑（连 packageId 都没有，只在单测里发生）才用 `-local`。
 */
const instanceResidentSuffix = PACKAGE_ID
  ? crypto.createHash('sha256').update(String(PACKAGE_ID)).digest('hex').slice(0, 8)
  : 'local';
const VAD_RESIDENT_ID = process.env.VAD_RESIDENT_ID || `tsp-vad-${instanceResidentSuffix}`;
const ASR_RESIDENT_ID = process.env.ASR_RESIDENT_ID || `tsp-asr-${instanceResidentSuffix}`;

const state = {
  state: 'starting',
  started_at: new Date().toISOString(),
  speech_input: null,
  rms_stream: null,
  pcm_stream: null,
  rms_gate: null,
  pipeline: null,
  vad: null,
  asr: null,
  memory: null,
  last_error: null,
  residents: null,
  refresh_count: 0,
  rms_frame_count: 0,
  pcm_frame_count: 0,
};
/**
 * Android Assistant 的一次 primary action 只负责把输入链收口到自动模式。
 * 这里仅保存最近一次结果，绝不保存 action body、文本或凭据；完整诊断从 live/state 读。
 */
const assistantCallState = {
  in_flight: false,
  call_count: 0,
  last: null,
};
let assistantCallPromise = null;
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
  rms_frame_count: state.rms_frame_count,
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

/**
 * ⭐ **一个水源、多个水龙头**（docs/077）。source 是否运行只由这张表的聚合决定；
 *   chain / backend / 处理门都只是「谁开了哪些 consumer」，它们**不是总开关**。
 * ⚠ `foreground` 登记但 `wants_pcm=false`——它吃的是 VAD segment 不是 PCM。
 *   把它记下来，是为了让状态说得出「它没有把着水源」。
 */
const consumers = new PcmConsumers([
  { name: 'rms', wantsRms: true, wantsPcm: false, note: 'RMS-only gate（判断门第一把钥匙）' },
  { name: 'vad', wantsPcm: true, note: 'FireRedVAD → segment → WAV' },
  { name: 'foreground', wantsPcm: false, note: '主体音量层：只吃 VAD segment' },
  { name: 'lab', wantsPcm: true, note: '声学校准实验页（docs/078）：到 WAV 为止，不进 ASR' },
  { name: 'speaker', wantsPcm: true, note: '声纹登记页（docs/080）：到 similarity 为止，不进 ASR' },
  { name: 'speaker_gate', wantsPcm: true, note: '声纹前景门（docs/081，正式链，默认关）' },
  { name: 'speaker_activity', wantsPcm: true,
    note: '正式 CAM++VAD：说话人切段 → incomplete/complete → ASR spool（默认 OFF）' },
  { name: 'activity_shadow', wantsPcm: true,
    note: '目标说话人活动状态机 shadow（docs/083，只观测不判决，默认关）' },
]);
/**
 * ⭐ 产品状态的唯一权威（任务书 §四/§六）。
 *
 * 它由**产生事实的那一方**喂：转写结果来自 `onResult`，活动来自判定链，
 * 转写与活动来自各自的判定方。⛔ 页面与下游都不许自己从 RMS/holders 猜。
 */
const publicState = new SpeechPublicState();

let vad;
let asr;
let rms;
let pcm;
let lifecycle;
let records;
let speakerActivity = null;
/**
 * ⭐ docs/087 P3：CAM++ 的**高频执行**搬进 App 之后，本包这一侧只剩低频控制与消费。
 * ⛔ 与 `speakerActivity`（旧的 legacy 执行体）是**二选一**，⛔ 不是叠加的两条链：
 *   `cfg.speaker_activity.executor` 决定此刻谁在执行，`executorClaims` 决定状态里怎么说。
 */
let appActivity = null;
/**
 * ⭐ docs/088 P4：自动模式的断句 / A-B / ASR 全在 App，本包只**消费结果**。
 * ⛔ 它不 enqueue 任何模型、不切 WAV、不碰 PCM。
 */
let appSegments = null;
/**
 * ⭐ **automatic ASR 到底能不能跑，由 App 说了算**（docs/090 §5/§7）。
 *
 * ⚠ 本包自己那份 `asr.snapshot().ready` 描述的是「resident 声明/资产在不在」——
 * 它曾经为 true 而 App 的 SliceTranscriber 一个可执行 session 都找不到，
 * 于是连续 8 段「有声音、没有字、没有任何提示」。**镜像不是事实。**
 * 这里只保存 App 推过来的事实，⛔ 不自己推断、⛔ 不轮询。
 */
let appExecutable = null;
/**
 * automatic ASR 的最近一次错误。⭐ **有界**：只留最后一条 + 同类连续计数，
 * ⛔ 不留音频、不留历史列表——它是给人看的一句解释，不是第二份日志。
 */
let appAsrError = null;
/** 自动 CAM++ 的唯一 USER-loss watchdog；FireRedVAD/ASR 事实不能刷新它。 */
/**
 * ⭐ 关门倒计时的长度。⚠ 它此前是**写死的产品规则**，现在由 policy 的
 * `speaker.user_timeout_ms` 给（使用者明确要求可调）。
 * ⛔ 但仍然只有**一个来源**：watchdog 与 App 执行体读的是同一个数，
 *   ⚠ 两侧各存一份 8000 的话，改了其中一个的人会看到「倒计时变了但门没跟着变」。
 */
let AUTOMATIC_CAM_TIMEOUT_MS = DEFAULT_USER_WATCHDOG_TIMEOUT_MS;
const automaticCamWatchdog = new UserWatchdog({ timeoutMs: AUTOMATIC_CAM_TIMEOUT_MS });

/**
 * policy 改了倒计时长度。⚠ **不重置正在跑的那一轮**：使用者正说着话时改参数，
 * 不该把他这一句掐掉——新的长度从下一次续命/下一次开门起生效。
 */
const applyUserTimeout = (ms) => {
  const next = Math.max(2000, Math.min(120_000, Number(ms) || DEFAULT_USER_WATCHDOG_TIMEOUT_MS));
  // ⛔ 没变就明确说没变：调用方据此决定要不要惊动状态流。
  if (next === AUTOMATIC_CAM_TIMEOUT_MS) return null;
  AUTOMATIC_CAM_TIMEOUT_MS = next;
  automaticCamWatchdog.timeoutMs = next;
  return next;
};
/** CAM++ start/stop 必须串行，避免手动切入时与自动启动交叉。 */
let speakerActivityTransition = Promise.resolve();

/**
 * ⭐ 自动 CAM++ 的三个事实分开投影：
 *   ① `automatic_cam_live`：RMS 已开门，当前帧才有资格进入 CAM++；
 *   ② `automatic_cam_admission.active`：CAM++ 尚未确认 USER，8 秒倒计时还在；
 *   ③ `speaker_activity`：CAM++ 自己的相似度/FSM 快照。
 *
 * ⛔ 不能只看 `speakerActivity.enabled`。它表示模型已加载，不表示 RMS 已准许当前
 * PCM；只看它会把上一次开门留下的 USER/相似度误投影到 RMS 门前。
 */
const automaticCamModeActive = () =>
  lifecycle?.leases?.size === 0 && cfg.speaker_activity?.enabled === true;

/** 使用者选的执行器（⛔ 不代表它此刻真的在跑，见 `appActivityActive`）。 */
const activityExecutorMode = () => cfg.speaker_activity?.executor ?? 'app';

/**
 * ⭐ 此刻**真的**由 App 执行吗。
 * ⚠ 判据必须包含「App 侧真的起来了」——只看配置的话，一次启动失败会让本包
 *   把自己那份关掉而 App 那份没起来，**两边都以为对方在跑，于是没有人在跑**。
 */
const appActivityActive = () => activityExecutorMode() === 'app' && appActivity?.active() === true;

/** legacy 执行体此刻该不该跑：只有 App 没接手时才轮到它。 */
const legacyActivityWanted = () => activityExecutorMode() !== 'app';

/**
 * 自动 CAM++ 此刻有没有 live 输入资格。
 *
 * ⚠ **P3 之后这里有两种执行体**，判据必须分开问：
 *   · App executor：音频从来不出 App，本包**没有** `speaker_activity` 这个 PCM 消费者，
 *     ⛔ 所以不能再拿它当判据——那样门永远开不了而每个指示灯都正常；
 *   · legacy executor：仍然按 consumer 是否持有 PCM 判。
 */
const automaticCamExecutorLive = () =>
  appActivityActive()
  || (consumers.enabled('speaker_activity') && consumers.pcmAdmitted('speaker_activity'));

const automaticCamLiveAdmitted = (current = null) => {
  const snapshot = current ?? gate.snapshot();
  return automaticCamModeActive()
    && automaticCamExecutorLive()
    && pipeline.owner === PIPELINE_OWNERS.VAD
    && snapshot?.state === 'open'
    && snapshot?.pcm_admission === 'allow';
};

const automaticCamAdmissionSnapshot = (nowMs = monotonicNowMs(), current = null) => {
  const empty = {
    active: false,
    waiting_user: false,
    timeout_ms: AUTOMATIC_CAM_TIMEOUT_MS,
    opened_at_ms: null,
    deadline_ms: null,
    timeout_remaining_ms: null,
    remaining_ms: null,
    remaining_seconds: null,
    confirmed_user_at_ms: null,
    last_confirmed_user_at_ms: null,
    last_confirmed_user_app_mono_ms: null,
    user_watchdog_active: false,
    user_watchdog_deadline_ms: null,
    user_watchdog_remaining_ms: null,
    cam_inference_active: false,
    cam_generation: null,
    pipeline_owner: pipeline.owner,
    clock: 'service_monotonic_ms',
    user_state: null,
  };
  const snapshot = current ?? gate.snapshot(nowMs);
  const watchdog = automaticCamWatchdog.snapshot(nowMs);
  const valid = watchdog.active
    && automaticCamModeActive()
    && pipeline.owner === PIPELINE_OWNERS.VAD
    && pipeline.epoch === watchdog.round_id
    && snapshot?.state === 'open'
    && snapshot?.pcm_admission === 'allow';
  if (!valid) return empty;
  const cam = speakerActivity?.snapshot?.() ?? {};
  const remainingMs = watchdog.remaining_ms;
  const waitingUser = watchdog.last_confirmed_user_at_ms === null;
  return {
    active: true,
    waiting_user: waitingUser,
    timeout_ms: AUTOMATIC_CAM_TIMEOUT_MS,
    opened_at_ms: watchdog.opened_at_ms,
    deadline_ms: watchdog.deadline_ms,
    timeout_remaining_ms: remainingMs,
    remaining_ms: remainingMs,
    /** 非时钟字段：StateHub 会在每秒跨越时更新页面，而不是把毫秒抖动全推上去。 */
    remaining_seconds: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
    confirmed_user_at_ms: watchdog.last_confirmed_user_app_mono_ms,
    last_confirmed_user_at_ms: watchdog.last_confirmed_user_at_ms,
    last_confirmed_user_app_mono_ms: watchdog.last_confirmed_user_app_mono_ms,
    user_watchdog_active: true,
    user_watchdog_deadline_ms: watchdog.deadline_ms,
    user_watchdog_remaining_ms: remainingMs,
    cam_inference_active: cam.inference_active === true,
    cam_generation: cam.stream_generation ?? null,
    pipeline_owner: pipeline.owner,
    clock: watchdog.clock,
    user_state: cam.state ?? null,
  };
};

/**
 * CAM++ 可能在 RMS 已经开门后才完成启用/加载（例如切回自动模式或 worker 重连）。
 * 这时不会再有一次新的 `open_threshold_crossed` 事件，不能因此漏建 USER admission。
 * 计时仍从本次 RMS 门的 opened_at_ms 算，不能因为模型晚到就把 8 秒窗口重新赠送一次。
 */
const ensureAutomaticCamAdmission = (snapshot, nowMs = monotonicNowMs()) => {
  const watchdog = automaticCamWatchdog.snapshot(nowMs);
  const open = automaticCamModeActive()
    && pipeline.owner === PIPELINE_OWNERS.VAD
    && snapshot?.state === 'open'
    && snapshot?.pcm_admission === 'allow';
  if (!open) return false;
  if (watchdog.active && watchdog.round_id === pipeline.epoch) return false;
  automaticCamWatchdog.open({ roundId: pipeline.epoch, openedAtMs: nowMs });
  return true;
};

/**
 * ⭐ P2 的诊断面：一眼看出**谁在执行、消费了几次、RMS 传输为什么开着**。
 * ⚠ 没有它，「门为什么不开」有四五种原因而它们在界面上长得一样。
 */
const gateExecutionFacts = (nowMs = Date.now()) => ({
  gate_executor: 'app',
  gate_mode: lastGateMode,
  app_gate_opens: appEvents.gate?.opens ?? null,
  consumed_opens: gateOpensConsumed,
  /**
   * ⭐ **「拍掌触发选着，但没有模板」是一个门永远不会开的状态**，而它在界面上
   * 与「一切正常，只是没人说话」长得一模一样。
   * ⚠ 使用者实测报的「一开始无反应」有一半就是它：按了「重置」把模板清掉之后，
   *   门此后永远关着，而 Overview 上没有任何东西说得出这件事。
   * ⛔ 不由页面自己从两个字段推：判据只写一遍，页面照抄。
   */
  gate_blocked: lastGateMode === 'feature' && appEvents.gate?.profile_ready !== true,
  gate_profile_ready: appEvents.gate?.profile_ready ?? null,
  // 传输需求：product 与 observer 分开说，⛔ 不混成一个 boolean
  rms_product_demand: false,
  rms_observer_demand: rmsObserverActive(nowMs),
  rms_transport_open: consumers.enabled('rms'),
  pcm_product_demand: consumers.wantsPcm(),
  legacy_threshold: cfg.rms_gate?.open_threshold ?? null,
  legacy_threshold_executing: false,
});

const rmsGateSnapshot = (nowMs = Date.now()) => {
  const snapshot = gate.snapshot(nowMs);
  return {
    ...snapshot,
    /**
     * ⭐ 执行事实**并进同一个域**。⚠ 它们此前只挂在 `GET /rms` 上，而页面读的是
     *   `/live` 与状态流的 `rms_gate`——于是「门为什么不开」那几个判据在页面上
     *   恒为 `undefined`，而 `undefined === true` 就是 `false`：横幅永远不显示，
     *   且不报错（docs/056 的同一形状）。
     */
    ...gateExecutionFacts(nowMs),
    automatic_cam_live: automaticCamLiveAdmitted(snapshot),
    automatic_cam_admission: automaticCamAdmissionSnapshot(monotonicNowMs(), snapshot),
  };
};

/**
 * 采集事实的观测者：**事件为主**（App 的 `/ws/android/events`），watchdog 只是兜底。
 * 抢占时不命令下游逐级停机——App 那边已经不发无效 PCM 了，下游因为没有输入而自然空闲。
 */
/**
 * ⭐ 每次 App 事件到达都把「麦克风还活着吗」转告那扇门。
 * ⚠ 这一步不能只在开门时做：门的安全兜底、快照的 `state` 与 `pcm_admission`
 *   都读它，只在开门时同步会让三者各自停在不同时刻的事实上。
 */
const syncGateCaptureLive = () => {
  try { gate.setCaptureLive(appEvents.captureLive()); } catch { /* 观测不得影响事件流 */ }
};
const appEvents = new AppEventsClient({
  onChange: () => { syncGateCaptureLive(); onStageChange(); },
});
/**
 * ⭐ 拍手开门：App 的 Feature Gate 一命中就把本包的 RMS 门显式打开。
 *
 * ⚠ 走的是既有的 `openFromRequest()`，**不是**另开一条并行的准入路径——
 *   门只有一扇，「谁把它推开的」才是变的那件事。
 * ⛔ 曾经写在这里的「PCM 不可用时它自己会拒绝开门，那条安全兜底因此原样保留」
 *   是错的：兜底的判据是**本包那条 RMS 观测流的新鲜度**，而 P2 之后它已经不再
 *   等于「麦克风还活着」——实测 App 报 recording=true 而本包同时报 false，
 *   于是每一次开门请求都被静默拒绝。判据现在由 `setCaptureLive()` 提供。
 * ⛔ 只在 App 处于 feature 模式时才会被调用（判据在 AppEventsClient 里）。
 */
/**
 * ⭐ **一扇门，一个开门源。**
 *
 * App 的 `gate_mode` 是唯一真相：feature ⇒ 本包的 RMS 门**不再按音量开**，
 * 只认拍掌那条显式请求。⛔ 不是「两条都留着看谁先到」——那正是使用者报的
 * 「切成拍掌还是音量触发」，两条路当时都在正常工作，而规则只在 App 内部执行了一半。
 * ⚠ 音量的采样、统计与 telemetry 一律不变：不开门不等于不测量。
 */
/**
 * ⭐ P2：**mode 不再改变本包的 admission 算法**。
 *
 * volume 与 feature 现在对下游完全等价：两种都由 App 判定、经同一条低频事实到达，
 * 本包只等 `gate.open`。⚠ P1 时这里还要按 mode 切 `open_source`，
 * 那是迁移中途的兼容桥；继续留着就会变成「两套 admission 各自正常」。
 * 这里只把 mode 记进遥测，⛔ 不参与判断。
 */
appEvents.onGateFacts = (appGate) => {
  const mode = String(appGate?.mode ?? '');
  if (mode && mode !== lastGateMode) {
    lastGateMode = mode;
    state.rms_gate = rmsGateSnapshot();
    onStageChange();
  }
};
let lastGateMode = null;

let gateOpensConsumed = 0;
appEvents.onGateOpen = (appGate) => {
  // ⚠ 参数刻意不叫 `gate`：本文件里 `gate` 已经是那个 RmsGate 实例，
  //   同名会把它遮蔽掉，而症状是「拍掌没反应」而不是一个错误。
  try {
    gateOpensConsumed += 1;
    // ⭐ 在决定的那一刻取最新事实：门要用它判「该不该开」。
    syncGateCaptureLive();
    /**
     * ⭐ 开门**不等于**流水线前进。`openFromRequest` 只把门的状态改成 open；
     * 真正把所有权从 RMS 交给 VAD、并让 `syncPcmDemand()` 放 raw PCM 进来的，
     * 是 `observeGateLifecycle`。
     *
     * ⚠ P2 之前这一步是**搭便车**搭出来的：10 Hz 的 `ingestRmsFrame` 每帧都调一次
     *   `observeGateLifecycle(snapshot)`，所以门一开 100 ms 内就被捡起来了。
     *   P2 把 RMS 流从正式链上撤掉之后，那趟车没了——于是门照常开、计数照常涨、
     *   日志照常打，而**流水线永远停在 rms 阶段**，表现为「拍了没反应」。
     *   ⛔ 一个必要的副作用绝不能靠某个高频循环顺带完成：循环一撤，它就静默消失。
     * ⭐ 与 `engagePipeline` 走同一套动作，两条开门路径从此形状相同。
     */
    openProductGate('app_gate');
    console.log(`[termux-speech] app gate opened the front door `
      + `(opens=${appGate?.opens} consumed=${gateOpensConsumed} mode=${appGate?.mode} `
      + `owner=${pipeline.owner})`);
    onStageChange();
  } catch (error) {
    console.log(`[termux-speech] app gate open failed: ${error?.message ?? error}`);
  }
};
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
 * 实测 SenseVoice 峰值约 1210MB。
 */
/**
 * ⚠ App 的 `avail_mb` 是 `ActivityManager.availMem`——**不是「總量減去已用」**，
 * 而是「還能挤出多少」的估计，把可回收的頁快取一并算作可用。
 * 设备的可用内存与 swap 只是诊断事实，不能用来推断模型是否可用。
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
/**
 * ⭐ **背景锚点素材**：App RAM 环里最近一段的逐帧 dB（⛔ 不含 PCM）。
 *
 * ⚠ 这是本包**唯一**的 ambient 输入，而且只在一次会话开始时问一次——
 *   `观测的成本正比于会话次数，不正比于时间`。⛔ 不订阅、不轮询、不常驻。
 *
 * ⚠ 它替代的是 P2 之前那条隐性依赖：ambient 曾挂在 10 Hz 的 `ingestRmsFrame` 上，
 *   而 P2 之后那条 RMS WS 只在 WebUI 观察时才开 ⇒ **没人看页面时背景锚点没有素材**，
 *   且不报错（`beginSession` 只安静地写下 `background_too_short`）。
 * ⛔ 修法不是把 RMS WS 变回正式链路，而是把连续统计留在唯一一直有音频的一侧（App）。
 */
const AMBIENT_WINDOW_MS = 8000;
let ambientReads = 0;
let ambientLast = null;
const readAmbient = async (windowMs = AMBIENT_WINDOW_MS) => {
  const r = await android.json(`/api/android/mic/ambient?window_ms=${windowMs}`);
  ambientReads += 1;
  return r ?? null;
};

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

/**
 * 100 ms 的 s16le buffer → `Int16Array`，喂给 `framesToDb`。
 * ⚠ 逐帧 dB 必须与 gate 判段时用的是**同一把尺**（同样的 10 ms hop / 25 ms 窗），
 *   否则 B* 与 segment 的电平不在一个刻度上，而 T 的全部意义都建立在两者可比上。
 */
const pcmToInt16 = (frame) => {
  const n = Math.floor(frame.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = frame.readInt16LE(i * 2);
  return out;
};

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

/** RMS-only transport没有PCM可供framesToDb重算；用同一App RMS扩展到10ms栅格。 */
const rmsToDbFrames = (rmsValue) => {
  const value = Number(rmsValue);
  const db = Number.isFinite(value) && value > 1e-9 ? 20 * Math.log10(value) : -100;
  return Array(10).fill(db);
};

/**
 * 「收音此刻可用吗」。这是 `speech_input.ready` 的**同一个判据**，只是不必为了拿到它
 * 而构造整棵树——热路径每秒问 15 次，而那棵树里 14 KB 与这个布尔值毫无关系。
 */
const transportFresh = (stream, nowMs = Date.now()) => stream?.connected === true
  && stream.lastFrameAtMs !== null
  && nowMs - stream.lastFrameAtMs <= 1000;

/** RMS-only 是待机/自动模式的实时输入；raw PCM 只在实际处理门打开后存在。 */
const readyNow = (nowMs = Date.now()) => sources.mic?.recording === true
  && (transportFresh(rms, nowMs) || transportFresh(pcm, nowMs));

const project = (nowMs = Date.now()) => {
  state.rms_stream = rms.snapshot(nowMs);
  state.pcm_stream = pcm.snapshot(nowMs);
  state.rms_gate = rmsGateSnapshot(nowMs);
  state.pipeline = pipeline.snapshot(nowMs);
  vad.observeTransport(state.pcm_stream);
  state.vad = vad.snapshot(nowMs);
  state.asr = asr.snapshot(nowMs);
  state.memory = memoryCache;
  if (!sources.devices || !sources.mic) return null;
  state.speech_input = projectSpeechInput({
    ...sources,
    rmsStream: state.rms_stream,
    pcmStream: state.pcm_stream,
    rmsGate: state.rms_gate,
    vad: state.vad,
    asr: state.asr,
    pipeline: state.pipeline,
    vadMode: currentVadMode(),
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

/**
 * ⭐ 「有没有人在说话，是不是本人」——由**判定方**的事实归一，⛔ 不是页面猜的。
 *
 * 两条链的权威不同，所以来源也不同：
 *   · 常驻链由 CAM++ 判 USER/OTHER ⇒ `source=resident`，`user_state` 有意义；
 *   · 手动链只有 FireRedVAD（它只回答「有没有人声」）⇒ `source=manual`，
 *     `user_state=unknown`——⚠ **不假装做了声纹判断**。
 * ⛔ CAM++ 的 similarity 分数不进公共状态：那是实现细节，下游读了也没法用。
 */
const syncPublicActivity = () => {
  /**
   * ⭐ P3：CAM++ 的判决可能来自 App，也可能来自 legacy 执行体。
   * ⚠ 判据不能再是 `consumers.enabled('speaker_activity')`——选 App executor 时那个
   *   consumer 是关着的（它不需要 PCM），于是这里会掉进「手动 FireRedVAD」那一支，
   *   把 CAM++ 的 USER 判决整个投影成 `unknown`，**而两边都不报错**。
   */
  if (appActivityActive()) {
    if (!automaticCamLiveAdmitted()) {
      return publicState.setActivity({ active: false, source: null, userState: 'unknown' });
    }
    const fsm = String(appActivity.snapshot().app_state ?? '');
    const active = fsm === 'USER' || fsm === 'MAYBE_USER' || fsm === 'MAYBE_END';
    return publicState.setActivity({
      active,
      source: SOURCE_RESIDENT,
      userState: fsm === 'USER' || fsm === 'MAYBE_END' ? 'user'
        : fsm === 'MAYBE_USER' ? 'unknown' : 'other',
    });
  }
  const camEnabled = consumers.enabled('speaker_activity');
  const cam = camEnabled ? speakerActivity.snapshot() : null;
  /**
   * RMS 关门时 CAM 的模型可以仍然 resident，但它没有 live 输入资格。
   * 先清掉公共活动，再读 CAM 快照；否则上一次门内的 USER 会一直挂在页面上。
   */
  if (camEnabled && !automaticCamLiveAdmitted()) {
    return publicState.setActivity({ active: false, source: null, userState: 'unknown' });
  }
  if (cam?.enabled) {
    const fsm = String(cam.state ?? '');
    const active = fsm === 'USER' || fsm === 'MAYBE_USER' || fsm === 'MAYBE_END';
    return publicState.setActivity({
      active,
      source: SOURCE_RESIDENT,
      userState: fsm === 'USER' || fsm === 'MAYBE_END' ? 'user'
        : fsm === 'MAYBE_USER' ? 'unknown' : 'other',
    });
  }
  const vadActive = vad?.snapshot()?.activity?.active === true;
  return publicState.setActivity({
    active: vadActive,
    source: vadActive ? SOURCE_MANUAL : null,
    userState: 'unknown',
  });
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
  vad?.setCloseAuthority(lease.owner === PIPELINE_OWNERS.VAD);
  asr?.observePipeline(lease, nowMs);
  state.pipeline = lease;
  return lease;
};

/**
 * ⭐ docs/061 §四.2：TTS 播放**不再**按住 RMS 门。
 *
 * 旧做法在播放期间让整条输入链失聪——而使用者完全可能正想识别 YouTube 或对面的人说的话，
 * 我们无从判断扬声器里的内容是不是他要的。现在 Mic 照常工作、RMS 保持原状态、
 * VAD 照常切段，**只在 segment 完成时**用单调时间区间判断它是否与本机 TTS 相交（见 dropPolicy）。
 *
 * 代价是明确接受的：TTS 期间的声音可能进入 VAD，只是产出的段全被丢掉——
 * 短暂空转，好过为了播放而让输入链聋掉。
 */

const observeGateLifecycle = (snapshot, nowMs = Date.now()) => {
  const lifecycle = pipeline.observeGate(snapshot, nowMs);
  if (lifecycle.type !== 'unchanged') {
    syncPipelineAuthority(nowMs);
    // RMS 开门/下游关门是 raw PCM 订阅的唯一切换点。
    syncPcmDemand();
  }
  vad.observeGate(snapshot, nowMs);
  if (lifecycle.type === 'idle') {
    automaticCamWatchdog.clear();
    /** 清掉门内残留的相似度/FSM；不释放 CAM 图，只结束这次 RMS 准入。 */
    if (consumers.enabled('speaker_activity')) {
      speakerActivity.resetAdmission('rms_gate_closed');
    }
    syncPublicActivity();
  }
  /**
   * RMS 是 admission，不是自动启动 FireRedVAD 的命令。
   * 自动模式的唯一处理者是 CAM++；这里仅建立它的 8 秒 USER 准入窗口。
   * FireRedVAD 的 arm 只允许从显式 listen 路径进入。
   *
   * 不把建立动作绑死在 open 事件上：CAM++ 可能晚于 RMS 开门完成加载，
   * `ensureAutomaticCamAdmission` 会沿用本次门的 opened_at_ms，不重置计时。
   */
  ensureAutomaticCamAdmission(snapshot, monotonicNowMs());
  // ⭐ P3：门的开关低频告诉 App 执行体。⛔ 只在生命周期真的变了的这一点上调。
  syncAppActivityAdmission(lifecycle.type === 'idle' ? 'rms_gate_closed' : 'rms_gate');
  return lifecycle;
};

/**
 * ⭐ **正式开门的唯一入口。** 所有 product Gate Open 路径都必须走这里。
 *
 * 一次开门是**三件事**，缺一件就是一个安静的坏状态：
 *   ① `openFromRequest` —— 把门的状态改成 open（安全兜底也在这里判）；
 *   ② `observeGateLifecycle` —— 交接所有权，并在其内部 `syncPcmDemand()` 放 PCM 进来；
 *   ③ 把快照写回 `state.rms_gate` —— 否则页面与 `/live` 停在开门之前的事实上。
 *
 * ⚠ 这个 helper 存在的理由是真机事故：`onGateOpen` 只做了 ①，②③ 靠 10 Hz 的
 *   `ingestRmsFrame` 顺带完成；P2 把那条流撤出正式链之后，**门开了而流水线不走**——
 *   门的计数照涨、日志照打、四个指示灯全绿，没有任何东西报错。
 * ⛔ 不要在别处再写一遍这三步：写第二遍就意味着以后可能只改其中一遍。
 *
 * @returns 开门后的快照（⚠ 门可能**没开**——安全兜底会拒绝；调用方按 `pipeline.owner` 判）
 */
const openProductGate = (reason, nowMs = Date.now()) => {
  const opened = gate.openFromRequest(reason, nowMs);
  state.rms_gate = opened;
  observeGateLifecycle(opened, nowMs);
  state.rms_gate = rmsGateSnapshot(nowMs);
  return opened;
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
  automaticCamWatchdog.clear();
  const snapshot = gate.closeFromDownstream(
    decision.previous_owner,
    request?.reason ?? 'speech_idle',
    nowMs,
  );
  syncPipelineAuthority(nowMs);
  vad.observeGate(snapshot, nowMs);
  if (consumers.enabled('speaker_activity')) {
    speakerActivity.resetAdmission(request?.reason ?? 'speech_idle');
  }
  syncAppActivityAdmission(request?.reason ?? 'speech_idle');
  /** ⭐ 产品状态回到待机。⚠ `latest` **不清**——那正是下游要读的东西。 */
  publicState.idle();
  state.rms_gate = rmsGateSnapshot(nowMs);
  syncPcmDemand();
  // 会话回到 RMS 门前；听写 requester 的释放由 listen API 自己负责。
  onStageChange();
  return { ...decision, gate: snapshot };
};

/**
 * RMS admission 后的唯一 VAD 启动动作。
 *
 * 这段与显式 listen 共用，保证两条入口都做同样的 session-local 校准与失败回滚。
 * `epoch` 守卫用来挡住 arm 期间发生的关门/换会话：旧的异步结果不能把新会话污染。
 */
/**
 * ⭐ 会话开始前，把背景锚点的素材一次性取回来。
 *
 * ⚠ 顺序是硬的：**必须在 `beginSession()` 之前**。`beginSession` 当场就把
 *   `[background_window+exclude, exclude)` 这一段切出来定 `B*`，之后整场冻结——
 *   晚一步取回来的素材，这一场再也用不上了。
 * ⚠ 取不到就**不定 B\***（`background_too_short`），而 docs/079 的失败保护是
 *   `insufficient_separation ⇒ 整场 KEEP`。⛔ 所以这里失败绝不能抛：
 *   宁可这一场没有 gate，也不能让取素材失败把整条会话打断。
 */
async function primeAmbientForSession(reason) {
  try {
    const data = await readAmbient();
    const db = Array.isArray(data?.db) ? data.db.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
    /**
     * App 的一帧是 100 ms，校准器的一帧是 10 ms——**这不是新引入的近似**：
     * 移除掉的 `rmsToDbFrames()` 一直在把一个 RMS 复制成 10 个相同的 dB。
     * ⛔ 不做插值：真实分辨率从来就是采集帧长，这里只是如实展开。
     */
    const frameMs = Number(data?.frame_ms) > 0 ? Number(data.frame_ms) : 100;
    const repeat = Math.max(1, Math.round(frameMs / calibrator.frameMs));
    const frames = [];
    for (const v of db) for (let i = 0; i < repeat; i += 1) frames.push(v);
    const ms = calibrator.primeAmbient(frames);
    ambientLast = {
      at_ms: Date.now(),
      reason,
      ok: true,
      source: 'app_mic_ambient',
      app_frames: db.length,
      app_frame_ms: frameMs,
      primed_ms: ms,
    };
    return ambientLast;
  } catch (error) {
    // ⛔ 素材取不到 ≠ 会话失败。如实记下来，让「为什么没有 gate」可回答。
    calibrator.primeAmbient([]);
    ambientLast = {
      at_ms: Date.now(),
      reason,
      ok: false,
      source: 'app_mic_ambient',
      error: String(error?.message ?? error),
      primed_ms: 0,
    };
    return ambientLast;
  }
}

async function armVadForCurrentPipeline(trigger, reason) {
  const epoch = pipeline.epoch;
  if (!listenEngaged()) {
    return { ok: false, reason: 'manual_listen_required' };
  }
  if (pipeline.owner !== PIPELINE_OWNERS.VAD) {
    return { ok: false, reason: `owner_${pipeline.owner}` };
  }
  foreground.reset(reason);
  await primeAmbientForSession(reason);
  calibrator.beginSession(reason);
  relativeForeground.setReferences(calibrator.references());
  const armed = await vad.arm(trigger);
  if (pipeline.owner !== PIPELINE_OWNERS.VAD || pipeline.epoch !== epoch) {
    // arm 可能恰好跨过了关门；不让迟到的成功继续跑，也不动已经接管的新 owner。
    if (armed?.handoff?.active === true) vad.resetRun('stale_vad_arm');
    return { ok: false, reason: 'stale_pipeline' };
  }
  if (armed?.handoff?.active !== true) {
    applyPipelineIdle({
      owner: PIPELINE_OWNERS.VAD,
      epoch,
      reason: 'vad_arm_failed',
      metadata: { error: armed?.last_error ?? 'unknown' },
    });
    return { ok: false, reason: 'vad_arm_failed' };
  }
  syncPipelineAuthority();
  onStageChange();
  return { ok: true, reason: 'accepted', owner: PIPELINE_OWNERS.VAD };
}

/**
 * 把流水线从 RMS 门前推到 VAD 手上——**开门这件事只有这一段代码**。
 *
 * 显式 listen 请求是普通 FireRedVAD 路径的入口。RMS 只负责 admission；VAD
 * 负责阶梯式切段，ASR 只消费已发布的 WAV。
 */
const engagePipeline = async (trigger, reason) => {
  if (pipeline.owner === PIPELINE_OWNERS.RMS) {
    // 显式进入处理时，RMS 仍必须先确认 PCM 可用；只把 gate 打开，不绕过它的安全检查。
    openProductGate(`${reason}_opened_gate`);
    if (pipeline.owner !== PIPELINE_OWNERS.VAD) {
      return { ok: false, reason: 'pcm_unavailable' };
    }
  }
  if (pipeline.owner !== PIPELINE_OWNERS.VAD) {
    // 已经在 ASR 会话中：这次请求不该重启流水线。
    return { ok: false, reason: `owner_${pipeline.owner}` };
  }
  return armVadForCurrentPipeline(trigger, reason);
};

/** 处理门只有一条：VAD 切段 → spool WAV → SenseVoice。 */
const engageProcessing = (trigger, reason) => engagePipeline(trigger, reason);

/**
 * Listen 模式（docs/058 §2.3）——**这是模式，不是一次触发**。
 *
 * 一次处理会被 ASR idle 或 VAD no_output 自动关门收走，而使用者在输入框里停顿十几秒
 * 想措辞时焦点还在，人根本没打算结束。
 * 所以 engaged 期间**抑制全部自动关门**，退出只由外部显式请求负责。
 *
 * ⚠ 它不改变任何判定：FireRedVAD 照常按阶梯策略切句，ASR 照常转写。
 * 变的只是「谁有资格关门」。
 */
/**
 * ⚠ listen 不再有自己的一份布尔。**唯一真相住在 lifecycle 的 requester lease 表里**——
 * 两份状态迟早会在某个分支上分岔（docs/061 §五明确禁止第二套状态）。
 */
const listenEngaged = () => lifecycle?.leases?.size > 0;

const currentVadMode = () => listenEngaged()
  ? 'fireredvad_manual'
  : consumers.enabled('speaker_activity') ? 'camplus_automatic' : 'idle';

/**
 * 两个处理模式的唯一分界：没有 listen lease 时由 CAM++ 工作，
 * 有 listen lease 时由 FireRedVAD 工作。
 */
const camPlusOwnsAutomaticSpeech = () =>
  automaticCamModeActive();

/**
 * CAM++ 的 start/stop 不能和模式切换并行。consumer 先切到目标状态，
 * 模型迁移再串行完成；这样手动模式不会在 CAM++ 释放期间 arm FireRedVAD。
 */
const transitionSpeakerActivity = (enabled, reason) => {
  speakerActivityTransition = speakerActivityTransition.then(async () => {
    const wantApp = enabled && activityExecutorMode() === 'app';
    const wantLegacy = enabled && legacyActivityWanted();
    /**
     * ⛔ 两个执行体**同一时刻只许一个驱动产品行为**。先停不要的那个，再起要的那个：
     *   反过来会让两份 CAM++ 常驻同时在场，而本机 HTP 会话预算只有 8 个。
     */
    if (!wantApp && appActivity?.started) await appActivity.stop(reason);
    if (!wantLegacy && (speakerActivity.enabled || speakerActivity.graphLoaded)) {
      await speakerActivity.stop(reason);
    }
    if (wantApp) {
      // ⭐ 走对账而不是一次性 start：失败会自己有界重试，⛔ 不再变成永久故障。
      await appActivity.ensureRunning(activityRuntimeConfig());
      // ⚠ 起来之后立刻把当前门的状态补一次：门可能**先于**执行体开着，
      //   而 admission 是边沿触发的——不补的话这一轮永远等不到开门。
      await appActivity.admit(automaticCamLiveAdmitted(), 'executor_started');
    }
    if (wantLegacy && !speakerActivity.enabled) await speakerActivity.start();
  }).catch((error) => {
    if (enabled) {
      consumers.setEnabled('speaker_activity', false);
      syncPcmDemand();
    }
    console.log(`[termux-speech] campplus vad transition failed: ${error?.message ?? error}`);
  });
  return speakerActivityTransition;
};

/**
 * 下发给执行体的判据。⭐ 与 legacy 那份**同源**：取的就是 `TEST_DEFAULTS` 与使用者
 * 调过的三个切点参数，⛔ 不在这里另立一套默认值——两套默认值必然漂开。
 */
const activityRuntimeConfig = () => ({
  ...ACTIVITY_TEST_DEFAULTS,
  continuation_grace_ms: speakerActivity?.graceMs ?? ACTIVITY_TEST_DEFAULTS.continuation_grace_ms,
  tail_margin_ms: speakerActivity?.tailMarginMs ?? 700,
  head_trim_ms: speakerActivity?.headTrimMs ?? 1300,
  head_mode: speakerActivity?.headMode ?? 'trim',
});

/**
 * ⭐ 把门的开关低频告诉 App 执行体。⛔ 每帧不调：`admit()` 自己幂等，
 *   而这里只在生命周期真的变化的那几个点被调用。
 */
const syncAppActivityAdmission = (reason) => {
  /**
   * ⭐ 每一次门的生命周期变化都顺带对一次账。
   * ⚠ 这是「一开始没反应、切一下触发方式就好」那个症状的正面修法：
   *   开机那一刻的一次瞬时失败不该变成永久失败，而使用者能观察到的
   *   最频繁的事实就是「他拍了一下手」——把对账挂在它上面，成本正比于使用次数。
   */
  if (activityExecutorMode() === 'app') void appActivity?.ensureRunning(activityRuntimeConfig());
  // ⭐ App 段落 backend 固定跟随当前唯一的 SenseVoice 事实。
  void syncAppSegmentBackend(configuredBackend(), reason).catch((error) => {
    console.log(`[termux-speech] App ASR backend sync (${reason}) failed: ${error?.message ?? error}`);
  });
  if (!appActivityActive()) return;
  void appActivity.admit(automaticCamLiveAdmitted(), reason);
};

const automaticCamSegmentAllowed = () => {
  return automaticCamLiveAdmitted();
};

const noteAutomaticCamUser = (event) => {
  if (!camPlusOwnsAutomaticSpeech()) return;
  if (pipeline.owner !== PIPELINE_OWNERS.VAD) return;
  if (event?.state !== 'USER') return;
  const accepted = automaticCamWatchdog.confirm({
    roundId: pipeline.epoch,
    atMs: monotonicNowMs(),
    appMonoMs: event.confirmed_user_at_ms ?? event.mono_ms,
  });
  if (!accepted) return;
  hub?.markHot();
  hub?.schedule();
};


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
      ? ['asr_idle', 'vad_no_output']
      : [],
  };
};

/** Android Assistant action 的小型诊断投影；不把 App 原始响应整份回显到状态。 */
const assistantMicProjection = (mic) => {
  const first = (...values) => values.find((value) => value !== undefined && value !== null) ?? null;
  const bool = (...values) => {
    const value = first(...values);
    return typeof value === 'boolean' ? value : null;
  };
  const capture = mic?.capture ?? mic?.microphone ?? {};
  const demand = mic?.demand ?? {};
  const holders = Array.isArray(demand.holders)
    ? demand.holders.filter((item) => typeof item === 'string')
    : [];
  return {
    recording: bool(mic?.recording, capture?.recording),
    desired_enabled: bool(mic?.desired_enabled, capture?.desired_enabled),
    enabled: bool(mic?.enabled, capture?.enabled),
    fgs_running: bool(
      mic?.fgs_running,
      capture?.fgs_running,
      capture?.foreground_service?.running,
      mic?.foreground_service?.running,
    ),
    last_error: first(mic?.last_error, capture?.last_error),
    demand: { holders, count: holders.length },
  };
};

const assistantMode = () => {
  if (listenEngaged()) return 'manual';
  if (lifecycle?.chain === 'started' && consumers.enabled('speaker_activity')) return 'automatic';
  return 'stop';
};

const assistantCallProjection = () => {
  const cam = speakerActivity?.snapshot?.() ?? {};
  const mic = assistantMicProjection(sources.mic);
  return {
    schema: 'termux-os.speech-assistant-call.v1',
    target_mode: 'automatic',
    mode: assistantMode(),
    in_flight: assistantCallState.in_flight,
    call_count: assistantCallState.call_count,
    last: assistantCallState.last,
    mic,
    automatic: {
      enabled_in_config: cfg?.speaker_activity?.enabled === true,
      consumer_enabled: consumers.enabled('speaker_activity'),
      graph_enabled: cam.enabled === true,
      graph_loaded: cam.graph_loaded === true || cam.graphLoaded === true,
      inference_admitted: automaticCamLiveAdmitted(),
      watchdog: automaticCamAdmissionSnapshot(),
    },
    manual: {
      requesters: lifecycle?.activeRequesters?.() ?? [],
      requester_count: lifecycle?.leases?.size ?? 0,
    },
  };
};

const assistantMicHeldFrom = (mic) =>
  (mic?.demand?.holders ?? []).includes(MIC_REQUESTER);

/**
 * 等到**真的有有效 PCM**才算 Mic 就绪。
 *
 * ⚠ `mic/demand` 返回 200 只说明需求登记了；AudioRecord 起来、FGS 拿到前台身份、
 * 第一帧真音频到达都还在后面。不等这一步就宣布 ready，就是 docs/061 §二.4 说的
 * 「假装已开始」——而使用者会对着一个根本没在听的界面说话。
 */
const awaitValidPcm = async (timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let transportReady = false;
  while (Date.now() < deadline) {
    const stream = pcm.snapshot();
    const streamFresh = stream.connected
      && stream.last_frame_age_ms !== null
      && stream.last_frame_age_ms < 1000;
    transportReady ||= streamFresh;
    /**
     * `pcm.last_frame_age_ms` 只证明 App→Package 的 WS 已收到一帧；
     * FireRedVAD.arm() 读的是它自己的滚动池。两者之间有一次异步 fan-out，
     * 原来只等前者就立刻 arm，首帧尚未进入 `eligiblePool()` 时稳定撞 409。
     * 手动 listen 必须等到**可供本次 gate 使用的** prebuffer，而不是任意旧帧。
     */
    const pool = vad.snapshot()?.pcm_pool;
    const prebufferReady = Number(pool?.eligible_ms) > 0;
    if (streamFresh && prebufferReady) {
      return {
        ok: true,
        waited_ms: timeoutMs - (deadline - Date.now()),
        prebuffer_ms: Number(pool.eligible_ms),
      };
    }
    pcm.ensure();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return {
    ok: false,
    // transport 已经起来但 fan-out/pool 没有就绪时，报告真实的 prebuffer 超时；
    // 没有任何有效帧则仍报告 Mic/PCM 不可用。
    reason: transportReady ? 'pcm_prebuffer_unavailable' : 'pcm_unavailable',
  };
};

const enterListen = async ({ reason, requester }) => {
  // 先关 CAM++，再打开 FireRedVAD consumer；两个推理者不能重叠。
  automaticCamWatchdog.clear();
  consumers.setEnabled('speaker_activity', false);
  syncPcmDemand();
  await transitionSpeakerActivity(false, 'manual_listen');
  // SpeakerActivity.stop() 会按进入前状态恢复旧的声纹门；手动模式仍要再明确关掉它。
  consumers.setEnabled('speaker_gate', false);
  speakerGate.forceIdle('manual_listen');
  // 停链状态下也允许 listen：它要 PCM，就自己登记成 consumer（而不是绕过聚合去要麦克风）。
  consumers.setEnabled('rms', true);
  consumers.setEnabled('vad', true);
  syncPcmDemand();
  const engaged = await lifecycle.engage(requester, { reason });
  if (!engaged.ok) {
    syncChainConsumers();          // 进不去就把临时打开的那两个收回去
    return { ok: false, reason: engaged.reason, error: engaged.error ?? null, value: listenSnapshot() };
  }
  if (engaged.reason === 'already_engaged') {
    return { ok: true, reason: 'already_engaged', value: listenSnapshot() };
  }
  pcm.ensure();
  const ready = await awaitValidPcm();
  if (!ready.ok) {
    await lifecycle.release(requester, { force: true, reason: ready.reason });
    syncChainConsumers();
    return { ok: false, reason: ready.reason, value: listenSnapshot() };
  }
  const outcome = await engageProcessing(
    { source: requester, reason }, 'listen_mode', { cue: false },
  );
  if (!outcome.ok) {
    // Arm 失败也要回滚 lease，否则会留下「登记了但没在听」的半状态。
    await lifecycle.release(requester, { force: true, reason: outcome.reason });
    syncChainConsumers();
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
  syncChainConsumers();
  onStageChange();
  return { ok: true, reason: 'released', value: listenSnapshot(), decision };
};

/**
 * ⭐ **聚合是唯一判据**（docs/077 §3）：还有一个开着的 PCM consumer，水源就开着；
 *   一个都没有了，`termux-speech` 这份需求就交回去，App 侧最后一个 holder 消失时
 *   `stopForNoDemand` 才真的 `AudioRecord.stop()/release()` 并停 Mic FGS。
 * ⚠ 这个函数是**幂等**的，任何 consumer 开关之后都可以直接调；
 *   它自己判断要不要真的动硬件需求（`lifecycle.acquireMic/releaseMic` 内部也幂等）。
 */
/**
 * 「此刻处在自动等待（门还没开）」这件事。
 * ⚠ P2 之前它是用 `consumers.enabled('rms')` 代理的——因为那时链一开 RMS 就常驻。
 *   现在 RMS 变成了 observer 驱动的 telemetry，**再拿它当代理就会在 WebUI 一关时反转**：
 *   PCM 会被无条件准入。代理量必须换成它本来要表达的那件事。
 */
const automaticWaiting = () => lifecycle?.chain === 'started' && !listenEngaged();

const syncPcmAdmission = () => {
  const gateOpen = gate.snapshot().state === 'open'
    && gate.snapshot().pcm_admission === 'allow';
  for (const name of ['vad', 'lab', 'speaker', 'speaker_gate', 'speaker_activity', 'activity_shadow']) {
    if (!consumers.has(name)) continue;
    let admitted = consumers.enabled(name);
    if (name !== 'vad' && automaticWaiting()) {
      // 自动等待期间不放 raw PCM；手动 listen 的 vad 是唯一例外。
      admitted = consumers.enabled(name) && gateOpen;
    }
    consumers.setPcmAdmitted(name, admitted);
  }
};

const syncPcmDemand = () => {
  syncPcmAdmission();
  // RMS 是独立的 transport；raw PCM 只由真正被准入的 consumer 聚合决定。
  const wantRms = consumers.wantsRms() || consumers.wantsPcm();
  const wantPcm = consumers.wantsPcm();
  if (wantRms) rms?.ensure();
  else rms?.close();
  if (wantPcm) pcm?.ensure();
  else pcm?.close();
  /**
   * ⭐ P2：**麦克风需求与传输需求是两件事**。
   *
   * 链开着就要持麦——即使本包一条 WS 都不订阅：门现在由 App 判，
   * 而 App 要判就得有音频。⚠ 把两者绑在一起的后果是致命的：
   * P2 关掉 RMS product consumer 之后，自动等待期本包**一条传输都不需要**，
   * 于是麦克风被释放、App 的 Gate 再也拿不到帧——
   * 「关掉一条遥测」变成了「把整条链弄哑」。
   */
  const wantMic = wantRms || wantPcm || lifecycle?.chain === 'started';
  if (wantMic) {
    if (!lifecycle.micHeld) void lifecycle.acquireMic().catch(() => {});
  } else if (lifecycle.micHeld) {
    void lifecycle.releaseMic().catch(() => {});
  }
};

/**
 * RMS 传输的需求方。P2 之后它**只**服务观察者：
 * WebUI 打开（`/live` 心跳）、声学校准台、或显式 observer。
 * ⛔ 自动转录**不再**为了开门订阅它。
 */
/**
 * ⚠ 30 秒不是随便定的：`/state/watch` 在**什么都没变**时最长挂 25 秒才返回，
 *   而它正是「页面开着」的证据。TTL 短于那个上限会形成一个自锁：
 *   租约要靠状态变化来续，而最主要的状态变化（RMS）又要靠租约才有——
 *   于是页面开着却永远等不到第一帧 RMS。
 * ⚠ 代价是页面关掉后最多多录 30 秒的 RMS telemetry（不含 PCM），明确接受。
 */
const RMS_OBSERVER_TTL_MS = 30_000;
let rmsObserverUntilMs = 0;

/**
 * ⭐ 「有人在看」就续一次租约——⛔ 不造新的 observer 框架，直接把**页面真的在读状态**
 * 这件既有事实当作证据。
 * ⚠ 只挂 `/live` 是不够的：WebUI 走的是 `/state/ws`（桥到 `/state/watch`），
 *   从来不打 `/live`。⇒ **页面开着而 RMS 传输一直是关的**，图表上表现为
 *   「只有触发之后才有数」，而每个指示灯都正常。使用者实测报的就是这个。
 */
const noteRmsObserver = (nowMs = Date.now()) => { rmsObserverUntilMs = nowMs + RMS_OBSERVER_TTL_MS; };

const rmsObserverActive = (nowMs = Date.now()) => nowMs < rmsObserverUntilMs;

const syncRmsObserver = (nowMs = Date.now()) => {
  // lab/speaker 这些校准台自己也要 RMS；它们是显式 observer。
  const want = rmsObserverActive(nowMs)
    || consumers.enabled('lab') || consumers.enabled('speaker');
  if (consumers.enabled('rms') !== want) {
    consumers.setEnabled('rms', want);
    syncPcmDemand();
  }
};

/**
 * 把 chain 自己的 consumer 收敛到 `chain` 的状态上。
 * ⚠ listen 可以在停链状态下临时把 rms/vad 打开，退出时必须收敛回来——
 *   否则一次 listen 就会把水源永久吊着，而使用者并没有开任何东西。
 */
/**
 * ⭐ **链自己那几个 consumer 只有这一份定义。**
 *
 * ⚠ 真机抓到过：`startChain` 与 `stopChain` 各自写死 consumer 清单，
 *   于是新增的 `speaker_gate` 在**开机自动起链**这条路径上永远不会被打开——
 *   门是 authority、判决却因为拿不到 PCM 而恒为 `no_coverage`。
 *   失效方向是安全的（不误杀），但功能**看起来开着而实际什么都没做**，
 *   这正是最难发现的那一类（docs/075 §4：一条门的设施不该由另一条门的代码顺手管）。
 * @param on 链此刻应该是开的还是关的
 */
const applyChainConsumers = (on) => {
  /**
   * ⭐ P2：链**不再**因为要开门而订阅 RMS。
   * 开门由 App 判定并经 AppEvents 低频通知；RMS 从此只服务观察者（见 syncRmsObserver）。
   * ⚠ 麦克风仍然要持——那是 `syncPcmDemand` 里的 `wantMic`，与传输需求分开。
   */
  syncRmsObserver();
  consumers.setEnabled('vad', on && listenEngaged());
  /**
   * ⭐ 正式 CAM++VAD 跟着链走，⛔ **不再由 `/activity-test/start` 决定**。
   *
   * 一条正式链的存亡不该系在一个调试端点上：那个端点是给人**手动验收**用的，
   * 它不在配置里、不随服务重启回来、也不会出现在任何一份「这台机器现在开着什么」
   * 的清单里。现在它由 `cfg.speaker_activity.enabled` 决定，与声纹门同一种形状。
   * ⚠ 默认**关**：它要吃一张 HTP ctx，而本机的 HTP 会话预算已经很紧
   *   （§容量问题）。使用者显式打开，才算他愿意为它腾位子。
   */
  const wantActivity = on && cfg.speaker_activity?.enabled === true && !listenEngaged();
  /**
   * ⭐ P3：**只有 legacy 执行体才需要 PCM**。选 App executor 时这个 consumer 保持关闭，
   *   于是聚合表算出的 `wants_pcm` 在自动等待与自动转写期间都是 false——
   *   这就是「WebUI 不看时官方链不再搬 PCM」那条验收标准的落点。
   * ⚠ consumer 仍然登记着（docs/077 的形状）：状态里必须说得出「它没有把着水源」。
   */
  consumers.setEnabled('speaker_activity', wantActivity && legacyActivityWanted());
  void transitionSpeakerActivity(wantActivity, on ? 'mode_switch' : 'chain_stopped');
  /**
   * 手动 FireRedVAD 模式不允许旧的段后 CAM++ 门继续推理；自动模式由 CAM++VAD 自己判定。
   *
   * ⭐ P3：自动模式下**必须也让开**（legacy 执行体是用 `pauseRival()` 做这件事的，
   *   App 执行体没有那条路径，于是它一直开着）。让开的理由有两条，都是硬的：
   *   ① 它吃的是 **FireRedVAD 的段**，而自动模式根本不产生那种段——它什么也判不了；
   *   ② 它 `wants_pcm`，一开门就把 PCM 拉出 App，**直接推翻 P3 那条验收标准**，
   *      而现象只是「待机时看起来一切正常」。
   * ⚠ 判据是「自动 CAM++ 模式此刻成立」，⛔ 不是「App 执行体在不在跑」——
   *   legacy 与 app 两条路都不需要它。
   */
  const wantSpeakerGate = on && cfg.speaker_gate?.enabled === true
    && !listenEngaged() && !camPlusOwnsAutomaticSpeech();
  consumers.setEnabled('speaker_gate', wantSpeakerGate);
  if (!consumers.enabled('speaker_gate')) speakerGate.forceIdle(on ? 'mode_switch' : 'chain_stopped');
  consumers.setEnabled('activity_shadow', on && cfg.target_activity_shadow?.enabled === true);
  if (!consumers.enabled('activity_shadow')) {
    activityShadow.forceIdle(on ? 'shadow_disabled' : 'chain_stopped');
  }
};

const syncChainConsumers = () => {
  applyChainConsumers(lifecycle?.chain === 'started');
  syncPcmDemand();
};

/** 开/关一个 consumer，并让聚合去决定水源。⛔ consumer 之间互不调用。 */
const setConsumer = (name, on) => {
  if (name === 'vad' && on === true && !listenEngaged()) {
    throw new UpstreamError('FireRedVAD is available only in manual listen mode', 409);
  }
  if (name === 'speaker_activity' && on === true && listenEngaged()) {
    throw new UpstreamError('CAM++VAD is disabled during manual listen mode', 409);
  }
  const changed = consumers.setEnabled(name, on);
  syncPcmDemand();
  if (changed) { hub?.markCold(); hub?.schedule(); }
  return consumers.snapshot();
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
/**
 * ⭐ **docs/093：这里只问一句「model.sensevoice 现在能不能跑」。**
 *
 * 迁移前这一段有三个 `resolveAssetRoot`：先试 `.ctx`、不行再试 `.graph`，
 * 还要各自记下失败原因。那套判断**本身是对的**，但它属于 Asset 层——
 * ⛔ speech 不该知道预制与源图的存在，更不该知道哪个更适合这台机器。
 *
 * 现在：`resolveLogicalModel` 返回一个 **executable descriptor**，
 * 里面已经是「当前可用的那一份」。⛔ 不再有 ctx / graph / v73 / QNN 这些词。
 * ⚠ 仍然**只解析不下载**：几百 MB 的东西不许出现在启动路径上，
 *   缺就缺着，如实报「模型没到位」，由模型管理器去准备。
 */
let senseModel = await resolveLogicalModel('model.sensevoice');
let senseFrontend = null;
let senseFrontendWhy = null;
if (senseModel?.available === true) {
  console.log(`[termux-speech] model.sensevoice → ${senseModel.executable.path}`
    + ` (${senseModel.executable.kind})`);
  const root = companionRoot(senseModel, 'model.sensevoice.frontend');
  if (root) {
    senseFrontend = {
      root,
      version: senseModel.version,
      /** ⭐ 按 **role** 取文件，⛔ 不拼 `am.mvn` / `tokens.json`。 */
      files: senseModel.companions['model.sensevoice.frontend']?.files ?? {},
    };
  } else {
    senseFrontendWhy = 'frontend companion is not installed';
  }
} else {
  senseFrontendWhy = senseModel?.hint ?? senseModel?.reason ?? 'model not enabled';
  console.log(`[termux-speech] model.sensevoice not usable: ${senseModel?.reason} — ${senseFrontendWhy}`);
}

/** SenseVoice 能不能转写。缺模型不是启动失败，是一个如实报出来的未就绪状态。 */
const senseVoiceReady = senseModel?.available === true && Boolean(senseFrontend);
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
  frontendFiles: senseFrontend?.files ?? null,
  executablePath: senseModel?.executable?.path ?? null,
  executableKind: senseModel?.executable?.kind ?? null,
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
  onResult: (segment, outcome) => {
    /**
     * ⛔ 互斥：结果必须属于当前 SenseVoice 代次才能进库。
     * ⭐ 判据由结果携带的 backend/generation 回答，不能由完成时的 UI 配置猜。
     */
    const resultGeneration = Number.isFinite(Number(outcome?.backend_generation))
      ? Number(outcome.backend_generation) : backendGeneration;
    if (!backendOwns(outcome?.backend ?? 'sensevoice', resultGeneration)) return;
    if (outcome?.retranscribe) { records?.retranscribe(segment.segment_id, outcome); return; }
    /**
     * ⭐ `incomplete` 是**中间品**：能看、能用，但不是这句话的最终样子。
     *
     * 它绝不 `admit()`——admit 建的是终态 item，会占掉 50 句里的一格，而这一格
     * 稍后还要被同一句话的 complete 再占一次。所以：
     *   · 第一次 incomplete → 什么都不写进组，只更新「实时那一行」；
     *   · complete       → 正常 admit，占它应得的那一格。
     * ⚠ 判据是 `segment_status`，⛔ 不是 `status`——后者说的是「识别成功没有」。
     */
    /**
     * ⭐ 产品状态先记：它是下游唯一订阅的那一份，⛔ 不能等切段判定完再更新。
     * ⚠ `blank` 由 ASR 侧的空结果判定带过来——空白不进 `latest`（见 public-state.mjs）。
     */
    publicState.noteTranscript(segment, {
      ...outcome,
      source: segment?.source ?? null,
      blank: outcome?.blank === true || String(outcome?.text ?? '').trim() === '',
    });
    if (outcome?.segment_status === 'incomplete') {
      provisional.set(segment.segment_id, {
        segment_id: segment.segment_id,
        revision: outcome.revision ?? 1,
        text: outcome.text ?? '',
        at_ms: Date.now(),
      });
      while (provisional.size > PROVISIONAL_CAP) {
        provisional.delete(provisional.keys().next().value);
      }
      // ⛔ 临时结果不进 records：同上，`RecordGroups` 上没有 noteProvisional，
      //    留一个恒为 no-op 的调用只会让人以为它被记下来了。
      onStageChange();
      return;
    }
    provisional.delete(segment.segment_id);
    records?.admit(segment, outcome);
  },
  // 听写时「结束」是内容不是命令（docs/058 §5 B）；模式期间的关门只归焦点离开。
  onEnd: (request) => (listenEngaged()
    ? { accepted: false, code: 'listen_mode_engaged' }
    : applyPipelineIdle(request)),
  onChange: onStageChange,
  /** ASR 在 job 开始时冻结这一个代次；发布时不能拿当前配置冒充历史事实。 */
  getBackendGeneration: () => backendGeneration,
});

/**
 * ⭐ session-local 主体音量层 gate（docs/076），只装在 SenseVoice 处理门上。
 * ⚠ 默认开启是为了让使用者能在真实环境里踩它；`foreground_gate_enabled=false`
 *   立刻恢复原行为，**一行判定都不会执行**。
 */
/**
 * 尚未定稿的句子：`segment_id → 最近一次 incomplete 的文字`。
 * ⛔ **不是第二个 records**：它不持久化、不发号、不进 50 句，complete 一到就删。
 *   页面拿它显示「机器已经听到什么」，而定稿仍然只有一个来源。
 */
const PROVISIONAL_CAP = 16;
const provisional = new Map();

const foreground = new ForegroundGate();
/**
 * ⭐ 生产链的相对门（docs/079）。两个参考由 `calibrator` 从既有工作流自动取得——
 *   **不要求使用者先录一段背景**。`decide()` 永不回写参考。
 */
const relativeForeground = new RelativeForegroundGate();
const calibrator = new SessionCalibrator();
const foregroundLog = [];
const foregroundEnabled = () => cfg.foreground_gate_enabled !== false;
/** `relative`（默认）| `absolute`（docs/076 的旧 band，留作回退）。 */
const foregroundMode = () => (cfg.foreground_gate_mode === 'absolute' ? 'absolute' : 'relative');
/**
 * ⭐ 处理门的 DROP 权威**只有一个**（docs/081，任务书 §十四）：
 *   `speaker` 开着就由声纹判，RMS 那条完全不参与；`speaker` 关着才轮到 `rms`；
 *   都关就是 `off` 全放行。
 * ⛔ 刻意不让两个 DROP gate 串联：串起来只会互相制造误杀，
 *   而事后从一条 `decision: 'DROP'` 里看不出是谁丢的。
 * ⚠ 这是**派生值**，不是第四个配置项——两处各存一份就会有两个答案。
 */
const foregroundAuthority = () => (consumers.enabled('speaker_gate') && cfg.speaker_gate?.enabled === true ? 'speaker'
  : foregroundEnabled() ? 'rms' : 'off');
/** duty cycle 对照的基线（`POST /speaker-gate/telemetry/reset` 时拍一张）。 */
let telemetryBaseline = null;
/**
 * 判一整段。⛔ 只回答 KEEP/DROP，**绝不裁剪段内 PCM**。
 * ⚠ 读不出 WAV 就 KEEP：一个「量不了」绝不能变成「不听了」。
 */
const foregroundDecide = (segment) => {
  if (foregroundAuthority() === 'speaker') {
    const d = speakerGate.decideSegment(segment);
    foregroundLog.push(d);
    if (foregroundLog.length > 100) foregroundLog.shift();
    return d;
  }
  if (!foregroundEnabled()) return { decision: 'KEEP', keep_reason: 'gate_disabled' };
  try {
    const samples = readWavMono16(segment.wav_path);
    const db = framesToDb(samples);
    let d;
    if (foregroundMode() === 'absolute') {
      d = foreground.decide(db, 10, { segment_id: segment.segment_id });
    } else {
      /**
       * ⚠ 顺序有意义：**先**用这一段去补 R*（它可能就是建参考的素材），
       *   **再**把参考推给 gate 去判。反过来的话第一段永远拿不到自己贡献的参考。
       *   ⛔ 一旦 `frozen`，`ingestSegment` 是个空操作——这就是「判定不回写」。
       */
      calibrator.ingestSegment(db);
      relativeForeground.setReferences(calibrator.references());
      d = relativeForeground.decide(db, 10, { segment_id: segment.segment_id });
    }
    foregroundLog.push(d);
    if (foregroundLog.length > 100) foregroundLog.shift();
    return d;
  } catch (error) {
    return { decision: 'KEEP', keep_reason: 'measure_failed',
             error: String(error?.message ?? error) };
  }
};

const handleVadSegment = (segment) => {
  /**
   * 这是第二道硬护栏。正常情况下第一道护栏（VadController.dropPolicy）已经在
   * 写 WAV 之前丢弃；若时间锚缺失或旧代码漏过这里，也绝不能让自动 VAD 段进入 ASR。
   */
  if (camPlusOwnsAutomaticSpeech()) {
    try { fs.rmSync(segment.wav_path, { force: true }); } catch { /* 安全收口 */ }
    onStageChange();
    return;
  }
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
  /**
   * ⭐ gate 在这里，**在 SenseVoice 之前**：DROP 就不推理、不 admit、不占 50 句的名额。
   * ⚠ staging WAV 要就地删掉——它没有归属者了（记录组只收有结论的段）。
   */
  const fg = foregroundDecide(segment);
  if (fg.decision === 'DROP') {
    try { fs.rmSync(segment.wav_path, { force: true }); } catch { /* 已经不在了。 */ }
    hub?.markCold(); hub?.schedule();
    onStageChange();
    return;
  }
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
/**
 * ⭐ **docs/093/当前任务：FireRedVAD 完整消费 logical descriptor。**
 *
 * descriptor 同时给出 App 要跑的 executable 与 runtime `cmvn` companion。
 * ⛔ 这里不再解析 source asset root，不自己拼 `model.onnx` / `cmvn.bin`，
 * 也不在模型缺失时让 package import 失败。
 */
const vadModel = await resolveLogicalModel('model.fireredvad');
const VAD_MODEL_PATH = vadModel?.available === true ? vadModel.executable?.path ?? null : null;
const VAD_CMVN_PATH = vadModel?.available === true ? companionFile(vadModel, 'cmvn') : null;
const fireRedVadReady = Boolean(VAD_MODEL_PATH && VAD_CMVN_PATH);
console.log(`[termux-speech] model.fireredvad ${fireRedVadReady ? 'ready' : 'degraded'}`
  + ` reason=${fireRedVadReady ? 'logical_descriptor' : (vadModel?.reason ?? 'cmvn_companion_missing')}`);

/**
 * ⭐ 声学校准 / Endpoint Lab（docs/078）。**只是多开一个水龙头**：
 *   `lab` 是 `PcmConsumers` 里的一个名字，开它不关别人、关它不动别人。
 * ⛔ 它自带一张 FireRedVAD 常驻图——正式那张是有状态的流，两个消费者共用会互相污染。
 */
const lab = new AcousticLab({
  android,
  modelFile: VAD_MODEL_PATH,
  cmvnFile: VAD_CMVN_PATH,
  dataRoot: `${VAD_DATA_ROOT}/../acoustic-lab`,
  residentId: `${VAD_RESIDENT_ID}-lab`,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
});

/**
 * ⭐ 声纹登记 / 实时 similarity（docs/080）。与 lab 并列的**第三个水龙头**，
 *   自带一张 FireRedVAD（第三个消费者共用有状态的流会互相污染）+ 一张 CAM++ **CPU** 图。
 * ⛔ 到 similarity 为止：不进 SenseVoice、不写记录、不占 50 句 group。
 */
const speakerEmbedder = new CamPlusEmbedder({
  android,
  residentId: `${VAD_RESIDENT_ID}-spk-emb`,
  modelPath: CAMPLUS_MODEL_PATH,
});
const speakerLab = new SpeakerLab({
  android,
  vadModelFile: VAD_MODEL_PATH,
  vadCmvnFile: VAD_CMVN_PATH,
  residentId: `${VAD_RESIDENT_ID}-spk`,
  embedder: speakerEmbedder,
  dataRoot: `${VAD_DATA_ROOT}/../speaker-lab`,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
});

/**
 * ⭐ 正式声纹门（docs/081）。与 Speaker Lab **共用同一张 CAM++ CPU 图和同一份声纹**——
 *   Lab 是校准台，这里是生产线。⛔ 不再开第二套登记系统，也不另存一份阈值。
 * ⚠ 它是第八个 consumer，默认关；开着时它自己把着水源（待机判断门要在 RMS 放行**之前**就知道
 *   现在说话的是不是登记用户）。
 */
const speakerGate = new SpeakerGate({
  embedder: speakerEmbedder,
  calibration: () => speakerLab.calibration(),
  config: cfg.speaker_gate,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
});

/**
 * ⭐ 目标说话人活动状态机 **shadow**（docs/083）。⛔ 只观测不判决：
 *   不调 SenseVoice、不写 records、不占 50 句、不改 listen。默认 OFF。
 * ⛔ 与 Speaker Lab / 正式声纹门**共用同一张 CAM++ CPU 图和同一份真人声纹**——
 *   不新开麦克风、不新开 VAD、不另登记。
 */
const activityShadow = new TargetActivityShadow({
  embedder: speakerEmbedder,
  calibration: () => speakerLab.calibration(),
  config: cfg.target_activity_shadow,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
});
activityShadow.setEnabled(cfg.target_activity_shadow?.enabled === true);

/**
 * ⭐ docs/084 CAM-only 验收模式：**第二张 CAM++ 图，backend=htp、吃 QNN 2.47 ctx**。
 * ⛔ 与上面那张 CPU 图刻意分开：CPU 那张是动态 T（登记要整段算），
 *   HTP ctx 是固定 [1,148,80]（只吃 1500 ms）——**能力不同，不能共用一个 resident**。
 */
const camHtpEmbedder = new CamPlusEmbedder({
  android,
  residentId: `${VAD_RESIDENT_ID}-cam-htp`,
  modelPath: CAMPLUS_MODEL_PATH,
  backend: 'htp',
  ctxPath: CAMPLUS_CTX_PATH,
  estMemMb: 64,
});

/**
 * ⭐ 进入验收模式时**腾 HTP 位子**：设备常态 10 个 HTP 会话而上限 8，不腾必然 409。
 * ⛔ 只撤**本包自己**声明的常驻图（vad / asr），不去动别人的会话——
 *   那些不属于这个包，越权卸别人的图是另一类事故。
 */
const freeHtpForCam = async () => {
  const released = [];
  for (const [name, ctl] of [['vad', vad], ['asr', asr]]) {
    try {
      if (ctl?.graph?.declared) { await ctl.graph.undeclare(); released.push(name); }
    } catch { /* 撤不掉就如实少撤一个，让 start 那边的 409 说话 */ }
  }
  return { released, at_ms: Date.now() };
};
const restoreHtpAfterCam = async (info) => {
  for (const name of info?.released ?? []) {
    const ctl = name === 'vad' ? vad : asr;
    try { await ctl?.graph?.declare({ force: true }); } catch { /* 对账器会兜底 */ }
  }
  return true;
};

speakerActivity = new SpeakerActivity({
  embedder: camHtpEmbedder,
  calibration: () => speakerLab.calibration(),
  dataRoot: `${VAD_DATA_ROOT}/../speaker-activity`,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
  onConfirmedUser: noteAutomaticCamUser,
  /**
 * ⭐ 正式下游：CAM++ 切出来的段直接进 SenseVoice ASR spool。
   *
   * ⛔ 这里**不判断** incomplete 该不该转写——它当然该转，「先处理」就是它存在的理由。
   *   要不要计入 50 句是 `onResult` 那一侧的事（见 `segment_status`）。
 * ⛔ 只有当前唯一的 SenseVoice backend 消费这些段；不再有第二个 ASR backend。
  */
  onSegment: (segment) => {
    // 模式切换或 8 秒关门后，正在飞行的 CAM++ 窗可能迟到；迟到段不能越过
    // 当前 RMS/模式边界进入 ASR。只删除 spool 副本，保留活动页自己的试听文件。
    if (!automaticCamSegmentAllowed()) {
      try { fs.rmSync(segment.wav_path, { force: true }); } catch { /* 安全收口 */ }
      onStageChange();
      return;
    }
    try {
      asr.enqueue(segment, { epoch: pipeline.epoch });
    } catch (error) {
      console.log(`[termux-speech] campplus segment rejected: ${error?.message ?? error}`);
    }
  },
  freeSessions: freeHtpForCam,
  restoreSessions: restoreHtpAfterCam,
  /**
   * ⭐ 旧 CPU 声纹门（docs/081）与本模式共用 `:ort_worker`，且由 RMS 活动触发 ——
   *   背景语音时它会持续提交 56 ms 的 **CPU** CAM++，与 5 ms 的 HTP 抢同一个 worker。
   * ⛔ 恢复时按**进入前的原状态**，不是无脑打开。
   */
  pauseRival: async () => {
    const was = consumers.enabled('speaker_gate');
    if (was) {
      consumers.setEnabled('speaker_gate', false);
      speakerGate.forceIdle('speaker_activity');
      syncPcmDemand();
    }
    return was;
  },
  resumeRival: async (was) => {
    if (was === true) { consumers.setEnabled('speaker_gate', true); syncPcmDemand(); }
    return was;
  },
});

/**
 * ⭐ docs/087 P3：App 侧执行体的本包端。
 * ⛔ `onSegment` 与 legacy 那条**共用同一个下游判据**：迟到的段不得越过当前
 *   RMS/模式边界进入 ASR。两条门共用一个准入判据，⛔ 不各写一份。
 */
/**
 * ⭐ 低频事实通道：`/ws/android/events` 上多一个 `activity` 域，⛔ 不新开 WS、⛔ 不新增 MQTT。
 * boot_id / seq / stale / reconnect 全部沿用既有那一套。
 */
appEvents.onActivity = (activity, bootId) => appActivity?.observe(activity, bootId);
/** docs/088 P4：App 的 segment 结果（provisional/final）走同一条低频通道。 */
appEvents.onSegment = (segment, bootId) => {
  // readiness 与段落事实同路而来：它变化的次数正比于「有人换了 backend / worker 重生」。
  if (segment && typeof segment === 'object' && segment.readiness) {
    appExecutable = { ...segment.readiness, at_ms: Date.now() };
  }
  return appSegments?.observe(segment, bootId);
};
/**
 * ⭐ 关门倒计时的长度由 App 的 policy 推过来，⛔ 本包不另存一份。
 * ⚠ 用**生效**的那一份（`applied`）：段落进行中 desired 与 applied 会不同，
 *   而门该按哪个关，答案是「正在执行的那个」。
 */
appEvents.onPolicy = (policy) => {
  if (applyUserTimeout(policy?.user_timeout_ms) !== null) onStageChange();
};

appActivity = new AppSpeakerActivity({
  android,
  calibration: () => speakerLab.calibration(),
  modelPath: CAMPLUS_MODEL_PATH,
  ctxPath: CAMPLUS_CTX_PATH,
  mode: activityExecutorMode(),
  /**
   * ⭐ 把 App 的「他还在说」接回 `UserWatchdog`——与 legacy 那条
   * `SpeakerActivity.onConfirmedUser` 走的是**同一个函数**，⛔ 不另写一份判据。
   */
  onUserConfirmed: noteAutomaticCamUser,
  /** ⭐ 「此刻该不该跑」的唯一定义；对账器只读它，⛔ 不自己判断链的状态。 */
  wantRunning: () => lifecycle?.chain === 'started'
    && cfg.speaker_activity?.enabled === true
    && !listenEngaged(),
  onChange: () => { hub?.markCold(); hub?.schedule(); },
  /**
   * ⚠ **P4 之后这条路只在 `segment_executor != app` 时才有东西进来**：
   *   App 那侧接管产品交付后就不再切 WAV，也就不会调用它。
   * ⛔ 刻意不加一句 `if (appSegmentsOwn()) return`——那会变成第二个判据，
   *   而真正的保证是**上游根本不发**（结构性，不靠这里记得挡）。
   */
  onSegment: (segment) => {
    if (!automaticCamSegmentAllowed()) {
      // ⚠ 段落文件由 App 持有并有界回收，本包**不删别人的文件**——
      //   只是不消费它。删掉会让 App 的保留窗口与本包的判断互相打架。
      onStageChange();
      return;
    }
    try {
      asr.enqueue(segment, { epoch: pipeline.epoch });
    } catch (error) {
      console.log(`[termux-speech] app activity segment rejected: ${error?.message ?? error}`);
    }
  },
});

/**
 * ⭐ docs/088 P4：App 交付的一条 segment 结果进产品层。
 *
 * ⭐ **upsert 不是 append**：A（provisional）与 B（final）是**同一句话的两次交付**。
 *   · provisional 只更新「实时那一行」，⛔ 绝不 `admit()`——admit 建的是终态 item，
 *     会占掉 50 句里的一格，而这一格稍后还要被同一句的 complete 再占一次；
 *   · complete 先 `find(segment_id)`：已经在组里就**就地更新**，⛔ 不新建一条。
 *   ⇒ 「A 出一次、B 又新增一次」在结构上不可能发生。
 * ⚠ 空结果不进 records、不占名额（既有产品规则，⛔ 不因为换了执行方就变）。
 */
const ingestAppSegmentResult = (r) => {
  /**
   * App-owned audio is an opaque reference, never a local pathname.
   * ⛔ `archive_wav` belongs to App's private sandbox; passing it to RecordGroups would
   * make speech try `existsSync/rename` across package sandboxes and turn a valid record
   * into a false "WAV unavailable" result. The actual bytes are fetched on playback.
   */
  const appAudioAvailable = typeof r.archive_wav === 'string' && r.archive_wav.length > 0;
  const normalized = normalizeTranscript(r.text);
  const blank = r.blank === true || normalized.isBlank;
  const segment = {
    segment_id: r.segment_id,
    source: 'app_segment',
    source_kind: 'app_segment',
    audio_available: appAudioAvailable,
    audio_ref: { source: 'app', segment_id: r.segment_id },
    wav_path: null,
  };
  /**
   * ⭐ **error 与 blank 是两件事**（docs/090 §10）。
   *
   * ⚠ 旧代码把两者压在 `blank` 一格里：App 侧错误结果带着 `blank=true` 到达，
   * 于是下面那句 `if (blank) return;` **静默丢弃**了它——使用者看到的是
   * 「有声音、没有字、没有任何原因」，而计数器里只有一个说不出所以然的 `errors`。
   *
   * 现在：错误一律低频记账并如实上报，⛔ 不进 records、⛔ 不占 50 句名额、
   * ⛔ 不重跑历史语音；readiness 恢复后**下一句**自然就正常了。
   */
  if (r.error) {
    const kind = r.error_kind ?? 'asr_failed';
    appAsrError = {
      at_ms: Date.now(),
      segment_id: r.segment_id ?? null,
      backend: r.backend ?? null,
      kind,
      error: String(r.error).slice(0, 400),
      count: (appAsrError?.kind === kind ? (appAsrError.count ?? 0) : 0) + 1,
    };
    onStageChange();
    return;
  }
  const outcome = {
    status: r.error ? 'failed' : 'succeeded',
    text: normalized.text,
    revision: r.revision,
    segment_status: r.complete ? 'complete' : 'incomplete',
    backend: r.backend,
    inference_ms: r.inference_ms,
    duration_ms: r.duration_ms,
    blank,
    error: r.error ?? null,
    source: 'app_segment',
    source_kind: 'app_segment',
    model: { id: r.backend, runtime: 'app-segment' },
  };
  // App is authoritative, but this defense keeps old App/producers from admitting
  // punctuation-only output while the package is being upgraded independently.
  if (blank) {
    onStageChange();
    return;
  }
  publicState.noteTranscript(segment, outcome);
  if (!r.complete) {
    /**
     * ⭐ **临时结果到「正在识别」为止**：⛔ 不进 records、⛔ 不占 50 句里的一格、
     * ⛔ 不进 history feed。这一格稍后还要被同一段的 final 占一次。
     * ⚠ 这里曾经调 `records?.noteProvisional?.(...)`——`RecordGroups` 上**根本没有
     *   这个方法**，可选链把它变成一个永远什么都不做的调用；读代码的人会以为
     *   临时结果被记下来了。既然不该记，就不要留一个看起来像在记的调用。
     */
    onStageChange();
    return;
  }
  // ⛔ 空结果不进 records（与既有 ASR 侧同一条规则）。
  if (r.blank || !String(r.text ?? '').trim()) { onStageChange(); return; }
  const existing = records?.find?.(r.segment_id) ?? null;
  if (existing) records.retranscribe(r.segment_id, outcome);
  else {
    records?.admit({
      ...segment,
      start_ms: r.start_mono_ms,
      end_ms: r.end_mono_ms,
      duration_ms: r.duration_ms,
    }, outcome);
  }
  onStageChange();
};

appSegments = new AppSegments({
  android,
  onResult: ingestAppSegmentResult,
  onChange: () => { hub?.markCold(); hub?.schedule(); },
});

/** 正式状态域的 CAM++ 投影：模型 resident、RMS live 与当前 VAD 模式必须同时可见。 */
const speakerActivityProjection = () => {
  const snapshot = speakerActivity.snapshot();
  const live = automaticCamLiveAdmitted();
  const app = appActivity?.snapshot?.() ?? null;
  const appLastSimilarity = app?.last_similarity ?? null;
  const appLastSegment = app?.last_segment ?? null;
  return {
  ...snapshot,
  /** ⭐ 谁在执行是**事实**，不是配置。⛔ 页面不许从 `executor` 配置值去猜。 */
  executor: appActivityActive() ? 'app' : 'speech',
  executor_mode: activityExecutorMode(),
  app,
  /**
   * App executor 下这些事实来自 App；⛔ 不要读 legacy 那份陈旧快照。
   *
   * ⚠ 使用者实测：LIVE 图上一根 CAM++ 柱都没有，而 ASR 明明有结果。
   *   根因是图表读的是 `enabled` 与 `similarity` —— 那是 **legacy 执行体**的字段，
   *   App executor 下分别恒为 `false` 与 `null`，于是「有没有在判决」被投影成「没开」。
   * ⭐ 修在这一层而不是页面：**页面不该知道哪个执行体在跑**。
   */
  ...(appActivityActive() && app ? {
    enabled: app.app_running === true,
    graph_loaded: app.app_running === true,
    state: app.app_state ?? snapshot.state,
    similarity: appLastSimilarity,
    last_similarity: appLastSimilarity,
    profile_ready: app.app_profile_ready === true,
    last_error: app.last_error ?? null,
    current_activity_state: app.app_state ?? null,
    last_user_mono_ms: app.last_user_mono_ms ?? null,
    user_confirms: app.app_user_confirms ?? app.user_confirms_seen ?? 0,
    last_segment: appLastSegment,
    last_activity_interval: appLastSegment ? {
      seq: appLastSegment.seq ?? null,
      start_mono_ms: appLastSegment.start_mono_ms ?? null,
      end_mono_ms: appLastSegment.end_mono_ms ?? null,
      status: appLastSegment.status ?? null,
    } : null,
  } : {}),
  projection_ready: appActivityActive() ? app?.app_running === true : speakerActivity.enabled === true,
  vad_mode: listenEngaged() ? 'fireredvad_manual'
    : (consumers.enabled('speaker_activity') || appActivityActive()) ? 'camplus_automatic' : 'idle',
  /** `active`/`inference_admitted` are the product fact; graph_loaded is resident only. */
  active: live,
  inference_admitted: live,
  automatic_cam_live: live,
  automatic_cam_admission: automaticCamAdmissionSnapshot(),
  };
};

vad = new VadController({
  android,
  modelFile: VAD_MODEL_PATH,
  cmvnFile: VAD_CMVN_PATH,
  dataRoot: VAD_DATA_ROOT,
  config: cfg.vad,
  residentId: VAD_RESIDENT_ID,
  // WAV 回收的保留判据由 ASR 提供：只有它知道自己还没消费完哪些段。
  retainSegment: (segmentId) => asr.holdsSegment(segmentId),
  onSegment: handleVadSegment,
  onChange: onStageChange,
  /**
   * ⭐ shadow 复用**生产这一张** FireRedVAD 的逐帧概率。
   * ⛔ 不新开第二张：它是有状态的流，两个消费者会互相污染 recurrent state（docs/078）。
   */
  onProbability: (probability, frameIndex) =>
    activityShadow.onVadProbability(probability, frameIndex),
  /**
   * 只处理 **Termux-OS 自己明确知道的 TTS**（docs/061 §四.1）。
   * ⛔ 不因为「外面在放音乐」就丢段——使用者可能正想识别 YouTube 里的那句话，
   * 而我们根本无从判断第三方播放的内容是不是他要的。
   */
  dropPolicy: ({ start_mono_ms: startMonoMs, end_mono_ms: endMonoMs }) => {
    if (camPlusOwnsAutomaticSpeech()) return { reason: 'camplus_gate' };
    if (startMonoMs === null || endMonoMs === null) return null;
    const hit = appEvents.intervals.overlaps(startMonoMs, endMonoMs);
    return hit ? { reason: 'tts_overlap', playback_id: hit.playback_id ?? null } : null;
  },
});

const applyOwnerTimeout = (nowMs = Date.now()) => {
  // 模式期间没有任何超时有资格关门：使用者在想措辞，不是走开了。
  if (listenEngaged()) return null;
  const watchdogNowMs = monotonicNowMs();
  const watchdog = automaticCamWatchdog.snapshot(watchdogNowMs);
  if (watchdog.active) {
    if (!camPlusOwnsAutomaticSpeech()
      || pipeline.owner !== PIPELINE_OWNERS.VAD
      || pipeline.epoch !== watchdog.round_id) {
      automaticCamWatchdog.clear(watchdog.round_id);
    } else if (automaticCamWatchdog.expired(watchdogNowMs, pipeline.epoch)) {
      return applyPipelineIdle({
        owner: PIPELINE_OWNERS.VAD,
        epoch: pipeline.epoch,
        reason: 'camplus_no_user_timeout',
        metadata: {
          timeout_ms: AUTOMATIC_CAM_TIMEOUT_MS,
          clock: watchdog.clock,
          opened_at_mono_ms: watchdog.opened_at_ms,
          last_confirmed_user_at_mono_ms: watchdog.last_confirmed_user_at_ms,
          deadline_mono_ms: watchdog.deadline_ms,
          criterion: 'confirmed_user',
        },
      }, nowMs);
    }
  }
  /**
   * 统一处理门的空闲判据。⚠ 两个 backend 共用同一个 `asr.idle_timeout_ms`——
   * 使用者调的是「说完多久算结束」，那是一条产品设定，不该因为门后换了实现就变成两个数。
   * ⛔ 判据看的是 spool 是否还有 pending/in-flight segment，不由 backend 自己另造一套。
   */
  const request = pipeline.owner === PIPELINE_OWNERS.VAD
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
/** 验证用 replay 的进度。⛔ 与实时链路无关，只在被调用过之后非 null。 */
let replayState = null;

const ingestRmsFrame = (meta) => {
  if (!consumers.enabled('rms')) return;
  const nowMs = Number(meta?.observed_at_ms) || Date.now();
  const previousTransition = state.rms_gate?.transition_seq;
  const frameRms = Number(meta?.rms);
  if (!Number.isFinite(frameRms)) return;
  rmsFromApp += 1;
  const snapshot = gate.ingest({
    rms: frameRms,
    recording: true,
    frameSeq: meta?.frame_seq,
    sampleAgeMs: 0,
  }, nowMs);
  /**
   * ⛔ 这里**曾经**喂 `calibrator.ingestAmbient(...)`，已移除。
   *
   * ⚠ 它是一条**未声明的产品正确性副作用**：整条函数的其它效果（`applyOwnerTimeout`、
   *   `observeGateLifecycle`、`state.state`、`syncRmsObserver`）在 5 Hz 巡检上都有对等调用，
   *   唯独 ambient 只有这一个喂食者——而 P2 之后这条 10 Hz 流只在 WebUI 观察时才开。
   *   于是「有没有背景锚点」取决于**有没有人开着页面**，并且不会报错。
   * ⭐ 现在由 `primeAmbientForSession()` 在会话开始时向 App 取一次整窗，见 `readAmbient`。
   */
  observeGateLifecycle(snapshot, nowMs);
  // CAM 尚未 attach raw PCM 时也要能走到 8 秒 USER watchdog 的安全关门。
  if (applyOwnerTimeout(nowMs)?.accepted) state.rms_gate = gate.snapshot(nowMs);
  state.rms_gate = rmsGateSnapshot(nowMs);
  state.rms_frame_count += 1;
  state.state = readyNow() ? 'ready' : 'idle';
  hub?.markHot();
  hub?.schedule();
  flush(previousTransition !== state.rms_gate?.transition_seq);
};

const ingestPcmFrame = (frame, meta) => {
  const nowMs = Number(meta?.observed_at_ms) || Date.now();
  const previousTransition = state.rms_gate?.transition_seq;
  /**
   * raw PCM 到达本身就证明某个 consumer 已获准；它不再负责 RMS admission。
   * RMS 的权威值已由独立的 App RMS-only WS 提供，这里仅为旧 App/辅助门保留本地回落。
   */
  const needRms = consumers.enabled('speaker_gate') || consumers.enabled('rms');
  const frameRms = needRms
    ? (Number.isFinite(meta?.rms) ? (rmsFromApp += 1, meta.rms)
      : (rmsComputedLocally += 1, rmsS16le(frame)))
    : null;
  if (consumers.enabled('vad')) vad.ingestPcm(frame, meta);
  // ⛔ lab 与正式链**并列**，互不知道对方存在。
  if (consumers.enabled('lab')) lab.ingest(frame);
  if (consumers.enabled('speaker')) speakerLab.ingest(frame);
  /**
   * ⭐ 正式声纹门吃的是**连续 PCM**，与 FireRedVAD 的段边界无关（任务书 §十五）。
   *   即使背景谈话节目让 VAD 连续几十秒判 speech，这条时间轴仍可以 OTHER→USER→OTHER。
   */
  if (consumers.enabled('speaker_gate')) {
    /**
     * ⚠ 用门**自己**的 `rms_activity`，不是 RMS 门的 `open_threshold`。
     *   两者回答不同的问题，混用会让声纹门在「有人说话但没到 RMS 音量」时整段失明，
     *   于是段上没有窗、按安全语义放行、背景照进 ASR（真机付过这个代价）。
     */
    speakerGate.ingest(frame, meta,
      { rms: frameRms, rmsThreshold: cfg.speaker_gate.rms_activity });
  }
  // ⛔ shadow 只是又一个水龙头：开它不关别人，关它不动别人（docs/077）。
  if (consumers.enabled('activity_shadow')) activityShadow.ingest(frame, meta);
  // ⛔ 又一个水龙头：开它不关别人，关它不动别人（docs/077）。
  if (consumers.enabled('speaker_activity')) {
    speakerActivity.ingest(frame, meta, { infer: automaticCamSegmentAllowed() });
  }
  syncPublicActivity();
  state.rms_gate = rmsGateSnapshot(nowMs);
  state.pcm_frame_count += 1;
  state.state = readyNow() ? 'ready' : 'idle';
  // ⛔ 只登记，不在这里构造：观测绝不能挂在处理链上（docs/061 §1）。
  hub?.markHot();
  hub?.schedule();
  flush(previousTransition !== state.rms_gate?.transition_seq);
};

rms = new RmsWs({
  onRms: ingestRmsFrame,
  onState: () => onStageChange(),
});
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

/** VAD→WAV→SenseVoice spool 的结果按 `incomplete` / `complete` contract 入组。 */

/**
 * ⭐ docs/074：产品面只有两条 pipeline，**同一时刻只许一条 commit**。
 *   两条各自持有已验证成熟的 VAD（Package 的 / App 的），刻意不合并。
 * ⚠ `backendGeneration` 是唯一的防串线判据：切换时它 +1，
 *   任何迟到的结果都要带着切换前的代次，于是能被认出来而不是被当成新结果。
 */
let activeBackend = 'sensevoice';
let backendGeneration = 0;
let staleBackendDropped = 0;
/** RMS 来自哪一侧。⭐ 让「已经归 App 了」这句话可以被证伪。 */
let rmsFromApp = 0;
let rmsComputedLocally = 0;
/** 本包动过的具名需求；只用于自检与状态展示，`user.persistent` 永不在内。 */
const micRequestersHeld = new Set();

/**
 * 具名麦克风需求的唯一出口。⛔ 本包在任何路径上都不得调用 `mic/enable` / `mic/disable`——
 * 那两条归使用者所有，`mic/demand` 对 `user.persistent` 也会明确 403。
 */
const setMicDemand = async (requester, desired) => {
  if (requester === USER_MIC_REQUESTER) {
    throw new UpstreamError('termux-speech must never touch user.persistent', 500);
  }
  const r = await android.json('/api/android/mic/demand', {
    method: 'POST', body: { requester, desired: desired === true },
  }).then((value) => ({ ok: true, value }), (error) => ({
    ok: false, error: String(error?.message ?? error),
  }));
  if (r.ok) {
    if (desired) micRequestersHeld.add(requester);
    else micRequestersHeld.delete(requester);
  }
  return r;
};

/**
 * ⭐ 撤销**不属于当下这条命**的具名需求（docs/077 §1）。
 *
 * ⚠ 为什么非要有这一段：本包自己的 transient demand 只有 happy path 会被撤销，
 *   而 Package 重启（framework restart / dev reload / 崩溃）不会经过那条路径；
 *   App 侧 `demands.clearTransient()` 又只在 **App 进程**启动时跑一次。
 *   于是一次异常退出就留下一个**没有任何界面能清掉**的 holder，麦克风永远关不上。
 * ⛔ 只碰以 `termux-speech` 开头的名字——别人的需求不归我们撤。
 *   `user.persistent` 也绝不碰（`setMicDemand` 会硬拒）。
 */
const OWNED_PREFIX = 'termux-speech';
const revokeOrphanMicHolders = async (reason) => {
  const mic = await readMic().catch(() => null);
  const holders = mic?.demand?.holders ?? [];
  const keep = new Set(consumers.wantsPcm() ? [MIC_REQUESTER] : []);
  const orphans = holders.filter((h) => h.startsWith(OWNED_PREFIX) && !keep.has(h));
  const revoked = [];
  for (const h of orphans) {
    const r = await setMicDemand(h, false);
    revoked.push({ requester: h, ok: r.ok, error: r.error ?? null });
  }
  if (revoked.length) console.log(`[termux-speech] revoked orphan mic holders (${reason}): `
    + revoked.map((x) => x.requester).join(', '));
  return revoked;
};

/**
 * 等到麦克风**真的在录**。⚠ `mic/demand` 返回 200 只说明需求登记了；
 * AudioRecord 起来、FGS 拿到前台身份都还在后面，而后台重启 microphone 类型的 FGS
 * 会被 Android 拒绝（docs/074 实测重试 969 次、40 秒才成功）。
 * 拿不到就如实返回，不假装已就绪。
 */
const awaitMicRecording = async (timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readMic().catch(() => null);
    if (last?.recording === true) return { ok: true, waited_ms: timeoutMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return { ok: false, reason: last?.last_error ?? 'microphone_not_recording' };
};

/** cfg.asr.model is normalized at load/save time; the only legal value is SenseVoice. */
const configuredBackend = () => 'sensevoice';

/**
 * ⭐ `cfg.asr.model` 是唯一的产品选择源。
 *
 * App 的 `speech-policy.asr.backend` 只是给 App 段落执行体看的内部投影，不能再成为
 * 第二个设置。启动、模型切换和一次门生命周期变化都走这条低频同步：先读 App 当前
 * desired 值，只有不一致才写，避免每次拍掌都制造一个无意义的 policy generation。
 * 若段落正忙，App 会把写入留到边界；desired 已经是目标值，下一段自然收敛。
 */
let appSegmentBackendTarget = null;
let appSegmentBackendSync = null;
const syncAppSegmentBackend = async (target, reason = 'config') => {
  if (target !== 'sensevoice') {
    throw new Error(`unsupported ASR backend: ${target}`);
  }
  if (appSegmentBackendTarget === target) {
    return { backend: target, desired_backend: target, cached: true, reason };
  }
  if (appSegmentBackendSync?.target === target) return appSegmentBackendSync.promise;

  const promise = (async () => {
    const current = await android.json('/api/speech/policy');
    if (current?.asr?.backend !== target) {
      await android.json('/api/audio/segment/config', {
        method: 'POST', body: { backend: target },
      });
    }
    const desired = await android.json('/api/speech/policy');
    if (desired?.asr?.backend !== target) {
      throw new Error(`App ASR policy did not accept ${target}`);
    }
    appSegmentBackendTarget = target;
    return {
      backend: target,
      desired_backend: target,
      applied_backend: desired?.asr?.backend ?? target,
      cached: false,
      reason,
    };
  })().finally(() => {
    if (appSegmentBackendSync?.promise === promise) appSegmentBackendSync = null;
  });
  appSegmentBackendSync = { target, promise };
  return promise;
};

/** 结果准入的唯一判据：来源必须是**当下**这条 backend。 */
const backendOwns = (backend, generation) => {
  if (backend !== activeBackend || generation !== backendGeneration) {
    staleBackendDropped += 1;
    return false;
  }
  return true;
};

/**
 * 切换处理门。⭐ 顺序是 **先建立新的、确认它就绪、再撤旧的**（docs/075 §5）：
 *
 *   1. 登记目标路径的具名 mic 需求  ← 此刻旧需求还在，聚合 desired 恒为 true
 *   2. 等麦克风真的在录
 *   3. generation++ / activeBackend=target  ← 从这一刻起只有目标路径的结果能进库
 *   4. 起目标路径
 *   5. 停旧路径、撤旧需求
 *
 * ⚠ 旧版是反的（先 stopChain 再请求麦克风），于是**中间必然出现 demand=0 的一瞬**，
 *   麦克风真的停掉；而 Android 拒绝从后台重启 microphone 类型的 FGS，实测重试 969 次、
 *   40 秒才恢复。那 40 秒足以让 App 侧的采集循环判定「麦克风没了」——docs/074 的整条故障链
 *   就是从这一瞬开始的。
 * ⚠ 「不许两条同时 commit」由 `backendOwns` 保证（第 3 步之后旧路径的结果一律作废），
 *   所以停旧执行体可以晚一步，不必为了互斥去制造一个两边都停着的窗口。
 */
const applyBackend = async (target, reason = 'config') => {
  if (target === activeBackend) {
    // 同档位再次保存配置也要能修复 SenseVoice worker 重生后的冷 session。
    await asr.prepareBackend(target);
    const appBackend = await syncAppSegmentBackend(target, reason);
    return { changed: false, active: activeBackend, prepared: true, app_backend: appBackend };
  }
  const from = activeBackend;
  const steps = [];
  // 谁在把着处理门。⚠ 必须**在关门之前**问。
  const holders = lifecycle.activeRequesters();
  const wasOpen = pipeline.owner !== PIPELINE_OWNERS.RMS;

  // ── 1. 关掉旧的处理门（判断门与麦克风一概不动）─────────────────────────
  if (wasOpen) {
    const closed = applyPipelineIdle({
      requester: 'backend_switch', owner: 'chain', force: true,
      reason: `backend_switch:${reason}`, metadata: { from, to: target },
    });
    steps.push({ step: 'close_old_door', accepted: closed?.accepted === true });
  }
  /** 先让目标 backend 自己证明能用，再切代次。 */
  try {
    const prepared = await asr.prepareBackend(target);
    steps.push({ step: 'prepare_target', backend: target, ready: prepared?.ready === true });
    const appBackend = await syncAppSegmentBackend(target, reason);
    steps.push({ step: 'sync_app_segment_backend', ...appBackend });
  } catch (error) {
    if (wasOpen && holders.length > 0) {
      const restored = await engageProcessing(
        { source: holders[0], reason: `backend_switch_failed:${reason}` },
        'listen_mode',
        { cue: false },
      ).catch((restoreError) => ({
        ok: false,
        reason: String(restoreError?.message ?? restoreError),
      }));
      steps.push({ step: 'restore_old_door', ...restored });
    }
    if (reason === 'api') {
      // updateAsrConfig 已经落盘；API 切换失败时必须把持久化选择还原为旧档位。
      try {
        cfg = saveAsrConfig(CONFIG_FILE, { model: from });
        asr.configure(cfg.asr);
      } catch (rollbackError) {
        const detail = String(rollbackError?.message ?? rollbackError);
        if (error && typeof error === 'object') {
          error.rollback_error = detail;
        } else {
          const wrapped = new Error(String(error?.message ?? error));
          wrapped.rollback_error = detail;
          error = wrapped;
        }
      }
    }
    onStageChange();
    throw error;
  }

  // ── 2. 换代次：从这一刻起只有目标路径的结果算数（`backendOwns` 是唯一判据）──
  backendGeneration += 1;
  activeBackend = target;

  // ── 3. 原来门是被 listen 把着的话，用新实现把同一扇门重新打开 ─────────────
  //    ⚠ lease 不受关门影响，所以这里不需要重新 engage lifecycle，只要把处理门再推开一次。
  let reengaged = null;
  if (holders.length > 0) {
    reengaged = await engageProcessing(
      { source: holders[0], reason: `backend_switch:${reason}` }, 'listen_mode', { cue: false },
    );
    steps.push({ step: 'reengage', requester: holders[0], ...reengaged });
  }

  hub?.markCold(); hub?.schedule();
  onStageChange();
  return {
    changed: true, from, active: activeBackend, generation: backendGeneration,
    reengaged: reengaged?.ok ?? null, steps,
  };
};

/**
 * ⭐ **选择改变**（使用者动了下拉框）。取值域变了才走完整的切换状态机。
 */
const selectBackend = (target, reason = 'config') => applyBackend(target, reason);

/**
 * ⭐ **确保当前选择的那条 backend 就绪**——⛔ **不看它有没有变过**（docs/090 §6）。
 *
 * ⚠ 这正是本轮真机阻塞的形状：boot 时 `configured` 与 `active` 初值都是 `sensevoice`，
 * 于是 `if (wanted !== activeBackend)` 永远不成立，`prepareBackend()` **一次都没跑过**，
 * 而两个字段各自都很诚实、页面上一切正常。
 * **「值没变」不是「已经就绪」的证据。**
 */
const ensureBackendReady = (reason = 'ensure') => applyBackend(configuredBackend(), reason);

const backendSnapshot = () => {
  const asrSnapshot = asr?.snapshot?.() ?? {};
  const selected = asrSnapshot.model?.selected ?? null;
  return {
  configured_backend: configuredBackend(),
  active_backend: activeBackend,
  app_segment_backend_target: appSegmentBackendTarget,
  backend_generation: backendGeneration,
  /**
   * ⚠ 这条 `ready` 描述的仍然是**本包**的准备度（资产/声明），保留是因为诊断页与
   * verify 断言都挂在它上面。⛔ 但它**不再**代表 automatic ASR 能不能跑——
   * 那件事只有 `automatic_ready` 回答，而它的来源是 App 的可执行体事实。
   */
  ready: asrSnapshot.ready === true,
  reason: asrSnapshot.reason ?? null,
  /** ⭐ automatic Segment ASR 现在就能执行吗。null = App 还没报过。 */
  automatic_ready: appExecutable ? appExecutable.ready === true : null,
  app_executable: appExecutable,
  selected_ready: selected?.ready === true,
  stale_backend_result_dropped: staleBackendDropped,
  sensevoice_state: asr?.snapshot()?.state ?? 'unknown',
  /** 最近一次 automatic ASR 错误（有界；⛔ 不是日志）。 */
  app_asr_error: appAsrError,
  /** ⛔ `user.persistent` 永远不在这里：本包碰不到它，也不该显得像能碰。 */
  mic_requesters_held: [...micRequestersHeld],
  };
};


/**
 * ⭐ 资源生命周期的唯一协调者（docs/061 §五）。
 *
 * Mic 需求、听写组、常驻 load/unload 三件事必须**串行**经过它：并发的
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
  dictation: {
    /** 唯一 ASR backend 的 ORT resident。 */
    required: () => true,
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
  // ⭐ 停链 = 关掉**它自己那几个** consumer，不是直接掐水源。
  //   处理门只有这一条，关闭时撤销本包自己的全部 consumer。
  applyChainConsumers(false);
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
  // ⚠ 先开 consumer 再起链：链启动本身要用到麦克风，所以这里不能走
  //   `syncChainConsumers()`（那时 `lifecycle.chain` 还不是 `started`，会全部关掉）。
  applyChainConsumers(true);
  const result = await lifecycle.startChain(reason);
  syncPcmDemand();
  onStageChange();
  return result;
};

/**
 * Android Assistant 的唯一 primary action。
 *
 * 这是一个**模式动作**，不是「再开一个录音器」：
 *   · 已有物理录音时，只补齐 speech 自己的具名 demand，不碰 user.persistent；
 *   · 手动 lease 逐个按当前 generation 结束，FireRedVAD 随 lease 退出；
 *   · 目标 consumer 统一回到 RMS→CAM++VAD→ASR。
 *
 * 调用串行化，重复调用在进行中复用同一个结果，完成后再次调用仍是幂等收口。
 */
const runAssistantCall = async (body = {}) => {
  if (assistantCallPromise) return assistantCallPromise;

  assistantCallPromise = (async () => {
    const startedAt = Date.now();
    const actionId = typeof body?.action_id === 'string' && body.action_id.trim()
      ? body.action_id.trim().slice(0, 96)
      : 'assistant.primary';
    const previousConfig = {
      speakerEnabled: cfg.speaker_activity?.enabled === true,
      chainDesired: cfg.chain_desired,
    };
    const chainWasStarted = lifecycle.chain === 'started';
    let configChanged = false;
    let chainStartedByCall = false;
    const manualReleased = [];

    assistantCallState.in_flight = true;
    assistantCallState.call_count += 1;
    assistantCallState.last = {
      result: 'running',
      action_id: actionId,
      at_ms: startedAt,
    };
    onStageChange();

    let beforeMic = null;
    let wasRecording = false;
    let startedByCall = false;

    const finish = ({ ok, status, reason = null, error = null }) => {
      const mic = assistantMicProjection(sources.mic);
      const mode = assistantMode();
      const elapsedMs = Date.now() - startedAt;
      const last = {
        result: ok ? 'success' : 'failure',
        action_id: actionId,
        at_ms: Date.now(),
        elapsed_ms: elapsedMs,
        mode,
        reason,
        error,
        mic_was_recording: wasRecording,
        mic_started_by_call: startedByCall,
        mic_recording: mic.recording,
        fgs_running: mic.fgs_running,
        last_error: mic.last_error,
        holders: mic.demand.holders,
        manual_leases_released: manualReleased,
      };
      assistantCallState.last = last;
      return {
        status,
        body: {
          ok,
          schema: 'termux-os.speech-assistant-call.v1',
          action_id: actionId,
          target_mode: 'automatic',
          mode,
          reason,
          error,
          diagnostics: {
            mic_was_recording: wasRecording,
            mic_started_by_call: startedByCall,
            mic_recording: mic.recording,
            fgs_running: mic.fgs_running,
            last_error: mic.last_error,
            holders: mic.demand.holders,
            manual_leases_released: manualReleased,
            elapsed_ms: elapsedMs,
          },
          state: assistantCallProjection(),
        },
      };
    };

    const rollback = async () => {
      if (configChanged) {
        try {
          cfg = saveSpeakerActivityConfig(CONFIG_FILE, { enabled: previousConfig.speakerEnabled });
        } catch (rollbackError) {
          console.log(`[termux-speech] assistant config rollback failed: ${rollbackError?.message ?? rollbackError}`);
        }
      }
      if (chainStartedByCall && lifecycle.leases.size === 0) {
        await stopChain({ reason: 'assistant_call_failed', force: false }).catch(() => {});
      } else if (configChanged || chainStartedByCall) {
        syncChainConsumers();
      }
      await speakerActivityTransition.catch(() => {});
    };

    const fail = async (status, reason, error = null) => {
      await rollback();
      return finish({ ok: false, status, reason, error });
    };

    try {
      beforeMic = await readMic();
      sources.mic = beforeMic;
      appEvents.observeSnapshot(beforeMic?.capture, beforeMic?.capture?.boot_id);
      const before = assistantMicProjection(beforeMic);
      wasRecording = before.recording === true;
      // dev reload / App 重启后，先用 App 的真实 holder 校准本地镜像，避免跳过一次必要的 demand。
      lifecycle.reconcile({ micHeld: assistantMicHeldFrom(beforeMic) });

      // Assistant 明确选择自动模式；这是与 UI 的 Auto 按钮同一份持久化配置。
      if (!previousConfig.speakerEnabled) {
        cfg = saveSpeakerActivityConfig(CONFIG_FILE, { enabled: true });
        configChanged = true;
      }

      // 若链已停但手动 lease 仍在，先把 chain 拉起；这样退出手动 lease 时不会出现
      // demand=0 的物理麦克风空窗，避免 Android 后台重启 microphone FGS 被拒绝。
      if (lifecycle.chain !== 'started') {
        const started = await startChain('assistant_primary');
        if (!started.ok) {
          return fail(503, started.reason ?? 'chain_start_failed', started.error ?? null);
        }
        chainStartedByCall = true;
      }

      // Chain Started 但 App 已经丢了 speech holder 时，显式等待这次 demand 请求的结果；
      // 不使用 syncPcmDemand 的 fire-and-forget 路径来隐藏 requires_user_foreground。
      if (!lifecycle.micHeld) {
        const acquired = await lifecycle.acquireMic();
        if (!acquired.ok) return fail(503, acquired.reason ?? 'mic_request_failed', acquired.error ?? null);
      }

      // 只释放当前真实存在的 lease，并带上 generation；不使用 force，也绝不触碰 user.persistent。
      for (const lease of [...lifecycle.leases.values()]) {
        const released = await exitListen({
          reason: 'assistant_primary',
          requester: lease.requester,
          generation: lease.generation,
          force: false,
        });
        if (!released.ok) {
          return fail(409, released.reason ?? 'manual_lease_release_failed', null);
        }
        if (released.reason !== 'not_engaged') manualReleased.push(lease.requester);
      }

      syncChainConsumers();
      await speakerActivityTransition;
      if (!consumers.enabled('speaker_activity') || !speakerActivity.enabled) {
        return fail(503, 'camplus_not_ready', speakerActivity.lastError ?? null);
      }

      // 成功进入自动模式后让重启沿用这个明确选择；Stop 按钮仍可把它改回 stopped。
      if (cfg.chain_desired !== 'started') {
        cfg = saveLifecycleConfig(CONFIG_FILE, { chain_desired: 'started' });
      }

      let finalMic = await readMic();
      sources.mic = finalMic;
      appEvents.observeSnapshot(finalMic?.capture, finalMic?.capture?.boot_id);
      if (!wasRecording) {
        // App 的 mic/demand 是异步启动 AudioRecord/FGS；只在调用前确实未录音时等待。
        const ready = await awaitMicRecording(4000);
        finalMic = await readMic();
        sources.mic = finalMic;
        appEvents.observeSnapshot(finalMic?.capture, finalMic?.capture?.boot_id);
        if (!ready.ok || assistantMicProjection(finalMic).recording !== true) {
          return fail(503, ready.reason ?? 'microphone_not_recording', finalMic?.last_error ?? null);
        }
        startedByCall = true;
      } else if (assistantMicProjection(finalMic).recording !== true) {
        return fail(503, 'microphone_lost_during_call', finalMic?.last_error ?? null);
      }

      if (assistantMode() !== 'automatic') {
        return fail(409, 'automatic_mode_not_ready', null);
      }
      return finish({ ok: true, status: 200, reason: 'automatic_ready' });
    } catch (error) {
      const status = Number(error?.status ?? error?.statusCode) || 500;
      return fail(status, 'assistant_call_failed', String(error?.message ?? error));
    } finally {
      assistantCallState.in_flight = false;
      onStageChange();
      assistantCallPromise = null;
    }
  })();
  return assistantCallPromise;
};

/**
 * 常驻声明的收敛点。
 *
 * 待机形态要求 VAD/ASR 图在**处理之前**就已经在内存里（docs/053 §1），所以声明必须
 * 在服务启动时发出，而不是等第一次 `run`/`stream`——否则第一次处理要现场付载入，恰好把代价
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
  const vadDeclared = declared(VAD_RESIDENT_ID);
  const asrDeclared = declared(ASR_RESIDENT_ID);
  // App 的列表是声明事实；本包自己的 ResidentGraph 只是它的本地镜像。
  // 重启后必须同步镜像，否则页面会把已经在 worker 里的图显示成「未声明」。
  vad?.reconcileResident(vadDeclared);
  asr?.reconcileResident(asrDeclared);
  try {
    const mic = await readMic();
    micHeld = (mic?.demand?.holders ?? []).includes(MIC_REQUESTER);
    appEvents.observeSnapshot(mic?.capture, mic?.capture?.boot_id);
  } catch { micHeld = undefined; }
  const value = lifecycle.reconcile({
    vadLoaded: vadDeclared,
    asrLoaded: asrDeclared,
    micHeld,
  });
  state.residents = `reconciled vad=${vadDeclared ? 'declared' : 'absent'} asr=${asrDeclared ? 'declared' : 'absent'}`
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
      const [devices, mic, descriptor, memory] = await Promise.all([
        readInputs(),
        readMic(),
        android.describe(),
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
      rms.configure(rmsWebSocketDescriptor(descriptor));
      // App 侧 history 提供最多 6 秒 pre-roll；只有 raw consumer 获准时才建立这条 WS。
      pcm.configure(pcmWebSocketDescriptor(descriptor, 6000));

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
      // transport snapshot 回答，根本不需要过一趟 HTTP。`refresh()` 每 2 秒取一次已经够了。
      //
      // ⭐ RMS-only 待机时 raw PCM 本来就应该是 disconnected。不能再拿 pcm.snapshot()
      // 作为 gate 的上游安全判据，否则每次 raw PCM 关闭都会把仍在流动的 RMS 判成
      // `recording=false / pcm_unavailable`，造成 RMS gate 自己把自己关掉。只有在确实
      // 已经准入 raw PCM 时，raw transport 的丢帧才是安全关闭条件。
      const stream = pcm.snapshot();
      const rmsStream = rms?.snapshot() ?? null;
      const pcmNeeded = lifecycle.wantsPcm();
      const gateStream = pcmNeeded ? stream : rmsStream;
      if (!gateStream?.connected || gateStream.last_frame_age_ms === null || gateStream.last_frame_age_ms > 1000) {
        const snapshot = gate.ingest({
          rms: null,
          recording: false,
          frameSeq: gateStream?.frame_seq ?? 0,
          sampleAgeMs: 1001,
        });
        observeGateLifecycle(snapshot);
      }
      // ⚠ 兜底，不是主路径：只有「按需求本该有 PCM，却长时间一帧都没有」才去读一次快照，
      // 有界退避 2/5/10/30 秒，恢复即停。事实的主来源是 `/ws/android/events` 的推送。
      await captureWatchdog.poll({
        expected: pcmNeeded,
        lastFrameAgeMs: stream.last_frame_age_ms,
      });
      applyOwnerTimeout();
      // 观察者租约到期后要真的把 RMS 传输关掉，⛔ 否则「按需」只是说说。
      syncRmsObserver();
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
   * 把 `rms_gate`/`pipeline`/`vad`/`asr` 原样嵌进去，而这些同时还在顶层，
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
  /** Android Assistant primary action 的最近一次收口与当前自动模式事实。 */
  assistant: () => assistantCallProjection(),
  records: () => records.snapshot(),
  pcm_consumers: () => consumers.snapshot(),
  acoustic_lab: () => lab.snapshot(),
  speaker_lab: () => speakerLab.snapshot(),
  /** ⛔ 刻意不含 sliding timeline（任务书 §十七）：完整时间轴留在 Speaker Lab。 */
  speaker_gate: () => speakerGate.snapshot(),
  /** ⛔ 不含长时间轴：完整 event 列表走 `/activity-shadow/history`。 */
  target_activity: () => activityShadow.snapshot(),
  /** ⛔ 不含 WAV 列表与长时间轴：那些走 /activity-test/segments。 */
  /**
   * ⭐ 名字从 `activity_test` 改成 `speaker_activity`（0.21.5）。
   * ⚠ 它**从来就不是** Activity Test 那个调试端点的投影——喂它的是
   *   `speakerActivity`，也就是生产的常驻 CAM++VAD。一个叫「test」的域
   *   装着生产状态，是「UI 名称与真实运行职责不一致」的典型：
   *   读的人会以为不开调试就没有数据，于是把概览那张图判成坏的。
   */
  speaker_activity: () => speakerActivityProjection(),
  /** docs/088 P4：App 的 segment 结果消费面（⛔ 不含音频，只有元数据与计数）。 */
  app_segments: () => appSegments?.snapshot?.() ?? null,
  foreground: () => ({
    /** ⭐ 此刻谁在判段。页面照抄这一个值，⛔ 不许自己从三个开关里再推一遍。 */
    authority: foregroundAuthority(),
    mode: foregroundMode(),
    enabled: foregroundEnabled(),
    /** 生产链现在判段用的就是这几个数——⛔ 页面照抄，不许自己再算一遍。 */
    relative: relativeForeground.references(),
    calibration: calibrator.snapshot(),
    /**
     * ⭐ 背景锚点素材是**从哪来的、够不够**。
     * ⚠ 没有它，`background_too_short` 只能告诉你「不够」，
     *   却分不出「App 没给」「这次没问」「问了但环里本来就短」——
     *   而这三件事的修法完全不同。
     */
    ambient: {
      source: 'app_mic_ambient',
      window_ms: AMBIENT_WINDOW_MS,
      reads: ambientReads,
      last: ambientLast,
    },
    absolute: foreground.snapshot(),
  }),
  memory: () => memoryCache,
  states: () => bus.snapshot(),
  asr: () => asr.snapshot(),
  /**
   * ⭐ automatic ASR 的**可执行**事实与最近一次错误。⛔ 与 `asr`（本包自己的准备度）
   * 刻意分成两个域：真机上它们曾经一个说 ready 一个跑不动，合并会让那件事永远看不见。
   */
  asr_backend: () => backendSnapshot(),
  // ⚠ `transitions` 不在里面：那是**诊断历史**，64 条深拷贝挂在最高频的通道上没有道理。
  // 需要时走 `/pipeline/transitions`。
  pipeline: () => pipelineWithoutHistory(),
  /**
   * ⭐ **两个页面共用的那一份 ASR 文字**（概览 + 诊断）。
   *
   * ⚠ 修的是两件事：① 页面此前只看得见 **commit**，现在也显示上游的 incomplete 当前句；
   *   ② 概览读记录组、诊断读旧的控制器最后一条——
 *   诊断页必须与真实的记录组结果保持一致，而不是只显示 App 回过的文字。
   *   **两个页面问的是同一个问题，就必须读同一个字段。**
   * ⚠ 两条 backend 都是段式的；中间结果来自上游半快门的 `incomplete`，
   *   不是 App live hypothesis。它必须与公共状态使用同一个 shutter contract。
   */
  asr_live: () => {
    const product = publicState.snapshot();
    const current = product.transcription ?? {};
    const latest = product.latest ?? {};
    return {
    backend: activeBackend,
    /**
     * ⚠ 0.21.5：**两条 backend 都是段式的**，中间没有文字可给。
     *   如实说 `false`，⛔ 不拿空串冒充「此刻没人说话」（docs/056 那个形状）。
     */
    live_supported: false,
    live_text: '',
    live_at_ms: null,
    hypotheses: 0,
    current: current.status === 'incomplete'
      ? {
        segment_id: current.segment_id,
        revision: current.revision,
        status: current.status,
        text: current.provisional_text ?? '',
        backend: current.backend ?? activeBackend,
        updated_at: current.updated_at ?? null,
      }
      : null,
    current_status: current.status ?? null,
    current_backend: current.backend ?? null,
    latest: {
      text: latest.latest_final_text ?? null,
      backend: latest.latest_final_backend ?? null,
      segment_id: latest.latest_segment_id ?? null,
      at_ms: latest.latest_final_at ?? null,
    },
    /** 门后正在把哪一段变成文字：两条 backend 共用同一个队列深度。 */
    pending: asr?.snapshot()?.queue?.depth ?? 0,
    committed: records?.lastSentence ?? null,
    committed_total: asr?.snapshot()?.transcripts?.published_this_run ?? null,
    };
  },
  // ── 高频域：随音频持续变化 ───────────────────────────────────────────
  /** ⭐ 产品状态：页面与下游都读这一个，⛔ 不再各自从 23 个内部域里拼。 */
  public: () => publicSnapshot(),
  rms_stream: () => rms.snapshot(),
  rms_gate: () => rmsGateSnapshot(),
  pcm_stream: () => pcm.snapshot(),
  pcm_pool: () => vad.snapshot().pcm_pool ?? null,
  vad: () => vad.snapshot(),
  input: () => inputProjection(),
};

// ⚠ `asr_live` 进热通道：半快门状态要及时投影到「正在识别」行。
/**
 * ⭐ 产品状态快照。**下游只需要这一份。**
 *
 * ⚠ 功能可用性在这里汇总，而不是让每个消费者自己拼：
 *   「模型管理器挂了」与「识别模型缺了」对使用者是两件完全不同的事，
 *   压成一个 `available` 布尔就分不出来了（任务书 §九）。
 */
const publicSnapshot = () => {
  const asrSnap = asr?.snapshot?.() ?? {};
  const camSnap = speakerActivity?.snapshot?.() ?? {};
  const features = featureReadiness({
    chainAvailable: lifecycle?.chain !== 'error',
    /**
     * ⚠ 「手动语音输入可用」问的是**能不能用**，⛔ 不是「此刻正在用」。
     *
     * 第一版写成「RMS 门有数据 或 PCM 连着」——那两个只有链**跑着**才成立，
     * 于是链停着（完全正常的待机状态）时整个服务显示「不可用」。
     * 真机上一打开页面就是这样，而那正是任务书 §九 要避免的「一锅端」。
     * ⭐ 判据改成「App 答得上话」：只要它还在，使用者点一下就能开始。
     */
    micAvailable: sources.mic !== null && state.state !== 'error',
    asrReady: asrSnap.ready === true,
    asrReason: asrSnap.reason ?? null,
    asrBackend: asrSnap.model?.selected?.id ?? asrSnap.model?.model ?? null,
    residentEnabled: cfg.speaker_activity?.enabled === true,
    residentReady: camSnap.enabled === true && camSnap.profile_ready === true,
    residentReason: camSnap.profile_ready === false ? 'no_voice_profile' : (camSnap.last_error ?? null),
  });
  return publicState.snapshot({ features });
};

const HOT_DOMAINS = ['rms_stream', 'rms_gate', 'pcm_stream', 'pcm_pool', 'vad', 'input', 'asr_live', 'public'];

/**
 * Capability readiness is deliberately separate from package health. A model
 * can be absent while the service, PCM control plane, and unrelated models are
 * healthy; boot must expose that fact instead of becoming `dependencies_not_ready`.
 */
const modelCapabilitySnapshot = () => ({
  fireredvad: {
    available: fireRedVadReady,
    reason: fireRedVadReady ? null : (vadModel?.reason ?? 'runtime_companion_missing'),
    executable: VAD_MODEL_PATH,
    companions: { cmvn: VAD_CMVN_PATH },
    files_present: vad?.snapshot?.().model?.files_present ?? false,
    resident: vad?.snapshot?.().model?.residency ?? null,
  },
  sensevoice: {
    available: senseVoiceReady,
    reason: senseVoiceReady ? null : (senseModel?.reason ?? senseFrontendWhy ?? 'model_not_enabled'),
    executable: senseModel?.executable?.path ?? null,
    companions: { frontend: senseFrontend?.root ?? null },
    resident: asr?.snapshot?.().resident ?? null,
  },
  campplus: {
    available: Boolean(CAMPLUS_MODEL_PATH && CAMPLUS_CTX_PATH),
    reason: CAMPLUS_MODEL_PATH && CAMPLUS_CTX_PATH ? null : 'model_not_enabled',
    executable: CAMPLUS_CTX_PATH,
    source: CAMPLUS_MODEL_PATH,
  },
});

/** 概览需要、而别的域里没有的那四项。刻意小：它跟着音量一起走高频通道。 */
const inputProjection = () => {
  const rmsStream = rms.snapshot();
  const stream = pcm.snapshot();
  const mic = sources.mic;
  const devices = sources.devices;
  const selector = devices?.configured?.input_device ?? mic?.configured_input_device ?? 'system_default';
  const recording = mic?.recording === true;
  const rmsFresh = transportFresh(rms, Date.now());
  const rawFresh = transportFresh(pcm, Date.now());
  const fresh = rmsFresh || rawFresh;
  return {
    ready: recording && fresh,
    reason: !recording ? 'microphone_not_recording'
      : !rmsStream.connected ? 'authenticated_rms_stream_not_connected'
        : !fresh ? 'rms_stream_stale' : null,
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
    rms: {
      transport_connected: rmsStream.connected === true,
      frame_seq: Number(rmsStream.frame_seq) || 0,
      last_frame_age_ms: rmsStream.last_frame_age_ms ?? null,
      binary_frames: Number(rmsStream.binary_frames) || 0,
    },
  };
};

const pipelineWithoutHistory = () => {
  const { transitions, ...rest } = pipeline.snapshot();
  return { ...rest, transitions_count: transitions?.length ?? 0 };
};

hub = new StateHub({ builders: DOMAIN_BUILDERS, hot: HOT_DOMAINS });

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

/**
 * `/assistant/call` is intentionally unauthenticated only for the Android App's
 * loopback request. The service itself is normally bound to 127.0.0.1; keep the
 * address check explicit so a future bind-host change cannot turn this into a LAN action.
 */
const isLoopbackRequest = (req) => {
  const address = String(req.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};

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

const parseByteRange = (raw, totalSize) => {
  if (!raw || !String(raw).startsWith('bytes=') || totalSize <= 0) return null;
  const value = String(raw).slice('bytes='.length).trim();
  if (value.includes(',')) return null;
  const dash = value.indexOf('-');
  if (dash < 0) return null;
  const startText = value.slice(0, dash).trim();
  const endText = value.slice(dash + 1).trim();
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return null;
  const requestedEnd = endText ? Number(endText) : totalSize - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, totalSize - 1) };
};

const sendWavFile = (res, req, file) => {
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'audio file not found' }));
  }
  const stat = fs.statSync(file);
  const totalSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parsed = parseByteRange(range, totalSize);
    if (!parsed) {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
      return res.end();
    }
    const chunk = fs.readFileSync(file).subarray(parsed.start, parsed.end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk.length,
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
    });
    return res.end(chunk);
  }
  const raw = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': raw.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  return res.end(raw);
};

/** App-owned segment audio stays in App's sandbox; speech only proxies the bytes. */
const proxyAppSegmentWav = async (res, req, segmentId) => {
  let upstream;
  try {
    upstream = await android.raw(
      `/api/audio/segment/audio?segment_id=${encodeURIComponent(segmentId)}`,
      { headers: req.headers.range ? { Range: req.headers.range } : {} },
    );
  } catch (error) {
    throw new UpstreamError(`App segment audio unavailable: ${String(error?.message ?? error)}`, 502);
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  };
  for (const [from, to] of [['content-type', 'Content-Type'],
                             ['content-range', 'Content-Range'],
                             ['accept-ranges', 'Accept-Ranges']]) {
    const value = upstream.headers.get(from);
    if (value) headers[to] = value;
  }
  res.writeHead(upstream.status, headers);
  return res.end(body);
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
    return send(200, {
      ok: true,
      service: 'termux-speech',
      state: state.state,
      capability_state: modelCapabilitySnapshot(),
    });
  }
  /**
   * Android Assistant's configured target. The App currently sends only
   * `{action_id:"assistant.primary"}` and has no Package system key; loopback
   * plus the exact route is the authentication boundary, not a general auth bypass.
   */
  if (req.method === 'POST' && route === '/assistant/call' && isLoopbackRequest(req)) {
    try {
      const body = await readBody(req);
      const result = await runAssistantCall(body);
      return send(result.status, result.body);
    } catch (error) {
      const status = Number(error?.status ?? error?.statusCode) || 500;
      return send(status, { ok: false, schema: 'termux-os.speech-assistant-call.v1',
        reason: 'assistant_call_request_failed', error: String(error?.message ?? error) });
    }
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
      return send(200, { ok: true, ...(await listModels(PACKAGE_ROOT, { config: cfg })) });
    }
    /**
     * ⚠ 取回/安装现在是**作业**：立刻回 202 + operation_id，⛔ 不再挂着等几百 MB 下完。
     *   `degraded` 表示模型管理服务不在——那是 503（稍后可再试），不是 502（上游坏了）。
     */
    if (req.method === 'POST' && route === '/models/download') {
      const body = await readBody(req);
      const r = await downloadModel(String(body?.model_id ?? ''), { choice: body?.choice ?? null });
      return send(r.ok ? 202 : r.degraded ? 503 : 502, r);
    }
    if (req.method === 'POST' && route === '/models/use') {
      const body = await readBody(req);
      const r = await useModel(String(body?.model_id ?? ''));
      return send(r.ok ? 202 : r.degraded ? 503 : 409, r);
    }
    if (req.method === 'GET' && route === '/models/operation') {
      const id = String(url.searchParams.get('operation_id') ?? '');
      if (!id) return send(400, { ok: false, error: 'operation_id required' });
      const r = await modelOperation(id);
      return send(r.ok === false && r.degraded ? 503 : 200, r);
    }
    if (req.method === 'GET' && route === '/live') {
      // ⭐ 有人在看 = RMS telemetry 该开。⛔ 不造新的 observer 框架，
      //   直接把「页面在拉状态」这件既有事实当作租约续期。
      noteRmsObserver();
      syncRmsObserver();
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
      // ⭐ 页面在读状态 = 有人在看（见 noteRmsObserver 的头部）。
      noteRmsObserver();
      syncRmsObserver();
      hub.markAll();
      hub.build();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(hub.snapshotJson());
    }
    if (req.method === 'GET' && route === '/state/watch') {
      /**
       * ⭐ 在**进入**时续租，⛔ 不是返回时——这条请求最长会挂 25 秒，
       * 而那 25 秒里页面显然还开着。返回时才续会让租约在最安静的时候先断掉。
       */
      noteRmsObserver();
      syncRmsObserver();
      const intervalMs = normalizeWatchInterval(
        url.searchParams.get('interval_ms'),
        DEFAULT_WATCH_INTERVAL_MS,
      );
      const result = await hub.watch(
        url.searchParams.get('after'),
        url.searchParams.get('boot_id'),
        Number(url.searchParams.get('timeout_ms')) || WATCH_TIMEOUT_MS,
        intervalMs,
      );
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        // The Framework WS bridge forwards the body byte-for-byte. These
        // cursors let it advance without parsing and re-stringifying it.
        'X-Termux-State-Version': String(result.version),
        'X-Termux-State-Boot-Id': hub.bootId,
      });
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
    if (req.method === 'GET' && (route === '/records/audio' || route.startsWith('/records/audio/'))) {
      const segId = route.startsWith('/records/audio/')
        ? route.slice('/records/audio/'.length)
        : url.searchParams.get('segment_id') || url.searchParams.get('id');
      if (!segId) return send(400, { ok: false, error: 'segment_id required' });
      let item = records.find(segId);
      if (item?.source_kind === 'app_segment' || item?.source === 'app_segment') {
        return proxyAppSegmentWav(res, req, segId);
      }
      let file = item?.wav_path;
      if (!file || !fs.existsSync(file)) {
        for (const group of records.liveGroups()) {
          const candidate = path.join(records.groupDir(group.group_id), `${segId}.wav`);
          if (fs.existsSync(candidate)) {
            file = candidate;
            break;
          }
        }
      }
      if (!file || !fs.existsSync(file)) {
        const vadCandidate = path.join(VAD_DATA_ROOT, 'wav', `${segId}.wav`);
        if (fs.existsSync(vadCandidate)) {
          file = vadCandidate;
        }
      }
      return sendWavFile(res, req, file);
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
      /**
       * ⛔ 这里**刻意不续**观察者租约。
       * ⚠ 第一版续了，结果是：探针每读一次就把「有没有人在看」刷成真，
       *   于是「没人看」这个状态**永远观测不到**——
       *   一个会改变自己所报告的事实的诊断读取，报告的是它自己。
       * 续租只发生在 `/live`（页面真的在拉状态流）与显式 observer。
       */
      return send(200, { ok: true, value: rmsGateSnapshot(), gate: gateExecutionFacts() });
    }
    if (req.method === 'GET' && route === '/rms/config') {
      return send(200, { ok: true, value: cfg.rms_gate });
    }
    if (req.method === 'POST' && route === '/rms/config') {
      const value = updateGateConfig(await readBody(req));
      return send(200, { ok: true, value });
    }
    /**
     * ⭐ 正式产品状态。**这是下游唯一需要的端点**（docs/PUBLIC_STATE.md）。
     * ⛔ 它不含 RMS / CAM++ 分数 / HTP / segment spool 内部结构——
     *   那些在 `/live` 的调试域里，产品 API 与 debug API 刻意分开。
     */
    if (req.method === 'GET' && route === '/public') {
      return send(200, { ok: true, value: publicSnapshot() });
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
      return send(200, { ok: true, value: asr.snapshot(), backend: backendSnapshot() });
    }
    /** docs/074：两条 pipeline 的产品级状态。configured 与 active 分开报，不合成一个。 */
    /** docs/076：主体音量层 gate 的状态与最近判定。使用者实测时看的就是这里。 */
    if (req.method === 'GET' && route === '/asr/foreground') {
      return send(200, {
        ok: true,
        enabled: foregroundEnabled(),
        mode: foregroundMode(),
        value: {
          mode: foregroundMode(),
          relative: relativeForeground.references(),
          calibration: calibrator.snapshot(),
          absolute: foreground.snapshot(),
        },
        recent: foregroundLog.slice(-Number(url.searchParams.get('limit') ?? 20)),
      });
    }
    if (req.method === 'POST' && route === '/asr/foreground') {
      const body = await readBody(req);
      if (body?.enabled !== undefined) {
        cfg = saveLifecycleConfig(CONFIG_FILE, { foreground_gate_enabled: body.enabled !== false });
      }
      if (body?.mode === 'relative' || body?.mode === 'absolute') {
        cfg = saveLifecycleConfig(CONFIG_FILE, { foreground_gate_mode: body.mode });
      }
      if (body?.reset === true) {
        foreground.reset(String(body.source ?? 'api'));
        calibrator.reset(String(body.source ?? 'api'));
        relativeForeground.setReferences({ backgroundDb: null, userDb: null });
      }
      if (body?.config && typeof body.config === 'object') foreground.configure(body.config);
      if (body?.relative && typeof body.relative === 'object') relativeForeground.configure(body.relative);
      if (body?.calibration && typeof body.calibration === 'object') calibrator.configure(body.calibration);
      return send(200, {
        ok: true,
        enabled: foregroundEnabled(),
        mode: foregroundMode(),
        value: {
          mode: foregroundMode(),
          relative: relativeForeground.references(),
          calibration: calibrator.snapshot(),
          absolute: foreground.snapshot(),
        },
      });
    }
    if (req.method === 'GET' && route === '/asr/backend') {
      return send(200, { ok: true, value: backendSnapshot() });
    }
    if (req.method === 'POST' && route === '/asr/backend') {
      const body = await readBody(req);
      const value = updateAsrConfig({ model: body?.model });
      const switched = await selectBackend(value.model ?? 'sensevoice', 'api');
      return send(200, { ok: true, value: { ...backendSnapshot(), ...switched } });
    }
    /**
     * ⛔ `/asr/dictation*` 四条旧端点在 0.21.5 整组删除。
     * 它们曾描述旧的 App live WS 连接态与 hypothesis；现在由本包 VAD 切段并交给 spool。
     * ⚠ 「进入听写模式」这个动作没有消失，它本来就是 `POST /listen` 的一个具名调用方。
     */
    if (req.method === 'GET' && route === '/asr/config') {
      return send(200, { ok: true, value: asr.publicConfig() });
    }
    if (req.method === 'POST' && route === '/asr/config') {
      const value = updateAsrConfig(await readBody(req));
      // ⭐ selector 一改就切，不要求使用者自己先停后开。
      const switched = await selectBackend(value.model ?? 'sensevoice', 'api');
      return send(200, { ok: true, value, backend: { ...backendSnapshot(), ...switched } });
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
    if (req.method === 'GET' && route === '/devices') {
      return send(200, { ok: true, ...inputPayload(await readInputs()) });
    }
    /**
     * 拍手手势（App 的 Feature Gate）。
     * ⭐ **本包只是一层薄转发**：判定、模板、DSP 全在 App 内——高频音频不出 App。
     *   放在这里的理由只有一个：录入与调参是**低频操作**，属于 WebUI 该管的事，
     *   而不该逼使用者去 App 的设定页。
     * ⛔ 不缓存 App 的状态：一个会过期的副本比没有更糟。
     */
    /**
     * P1 policy 转发。⭐ App 是执行态的唯一真相源；本包只做**低频**转发。
     * ⚠ 它必须是**顶层**路由：第一版我把它塞进了 `/clap` 那个块的 map 里，
     *   于是它只在 `/clap/policy` 下存在，而调用方按约定打 `/policy` 拿到 not_found——
     *   两边各自都"正常"，只是**约定的形状与实现的形状不是同一个**。
     */
    if (route === '/policy' || route.startsWith('/policy/')) {
      const map = {
        '/policy': ['GET', 'GET', '/api/speech/policy'],
        '/policy/status': ['GET', 'GET', '/api/speech/policy/status'],
        '/policy/put': ['POST', 'PUT', '/api/speech/policy'],
      };
      const entry = map[route];
      if (!entry) throw new UpstreamError(`unknown policy route: ${route}`, 404);
      const [inbound, outbound, appPath] = entry;
      if (req.method !== inbound) throw new UpstreamError(`${route} needs ${inbound}`, 405);
      const body = inbound === 'GET' ? undefined : await readBody(req);
      const payload = await android.json(appPath, {
        method: outbound,
        ...(outbound === 'GET' ? {} : { body: body ?? {} }),
      });
      const value = payload?.value ?? payload?.data ?? payload;
      // policy 里带着 gate.mode——PUT 之后同样要把前门对齐。
      const policyMode = value?.gate?.mode;
      if (typeof policyMode === 'string') appEvents.onGateFacts({ mode: policyMode });
      return send(200, { ok: true, value });
    }
    if (route === '/clap' || route.startsWith('/clap/')) {
      const sub = route.slice('/clap'.length) || '/state';
      /**
       * ⚠ 入站方法与出站方法**分开写**：Package 代理层只做 GET/POST，
       *   而 App 那边「删除模板」是 DELETE。把两者压成一个字段，
       *   重置按钮就会以 405 的形式失败，而页面上看起来只是没反应。
       */
      const map = {
        '/state': ['GET', 'GET', '/api/audio/gate/state'],
        '/events': ['GET', 'GET', '/api/audio/gate/events'],
        '/config': ['POST', 'POST', '/api/audio/gate/config'],
        '/enroll/start': ['POST', 'POST', '/api/audio/gate/enroll/start'],
        '/enroll/finish': ['POST', 'POST', '/api/audio/gate/enroll/finish'],
        '/enroll/cancel': ['POST', 'POST', '/api/audio/gate/enroll/cancel'],
        '/enroll/drop': ['POST', 'POST', '/api/audio/gate/enroll/drop'],
        '/test': ['POST', 'POST', '/api/audio/gate/test'],
        '/reset': ['POST', 'DELETE', '/api/audio/gate/profile'],
      };
      const entry = map[sub];
      if (!entry) throw new UpstreamError(`unknown clap route: ${sub}`, 404);
      const [inbound, outbound, appPath] = entry;
      if (req.method !== inbound) throw new UpstreamError(`${sub} needs ${inbound}`, 405);
      const body = inbound === 'GET' ? undefined : await readBody(req);
      const payload = await android.json(appPath, {
        method: outbound,
        ...(outbound === 'GET' || outbound === 'DELETE' ? {} : { body: body ?? {} }),
      });
      /**
       * ⭐ 切换是**经过本包**发生的，所以当场就把前门的开门源改掉，⛔ 不等那条 WS。
       * ⚠ 只靠事件的后果已经实测到：改模式本身不推事件，于是 `open_source` 一直
       *   停在旧值——使用者选了音量，门却还只认拍掌，而两边各自看起来都正常。
       *   事件仍然保留：从 App 自己的设定页改模式时，那条路才是唯一的通知。
       */
      const observed = payload?.value ?? payload?.data ?? payload;
      const observedMode = observed?.mode;
      if (typeof observedMode === 'string') appEvents.onGateFacts({ mode: observedMode });
      /**
       * ⭐ policy 里也带着 gate.mode——PUT 之后同样要把前门对齐，
       * ⚠ 否则「用 policy 改模式」与「用 /clap/config 改模式」两条路会给出不同结果。
       */
      const policyMode = observed?.gate?.mode;
      if (typeof policyMode === 'string') appEvents.onGateFacts({ mode: policyMode });
      /** App Feature Gate profile is the only clap authority. Add freshness at the
       * proxy boundary so UI/agents cannot mistake an old report or CAM enrollment
       * count for the current profile. */
      const observedAt = Date.now();
      const value = observed && typeof observed === 'object' && !Array.isArray(observed)
        ? { ...observed, source: 'app_gate_profile', observed_at_ms: observedAt, read_at_ms: observedAt }
        : { value: observed, source: 'app_gate_profile', observed_at_ms: observedAt, read_at_ms: observedAt };
      return send(200, { ok: true, value });
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
    /**
     * ⭐ Mic Off 必须是**对聚合**的操作（docs/077 §1）。
     *
     * ⚠ 旧版只撤 `user.persistent`，而 `termux-speech`（chain）与
     *   旧的独立 consumer 照旧持有 ⇒ 页面写着「已关闭」而 AudioRecord 从没停过、
     *   系统绿点一直亮。**一个说「已关闭」而设备仍在录音的开关，比没有这个开关更糟。**
     *   现在它关掉本包全部 PCM consumer、撤掉本包的具名需求，再撤使用者那一份。
     */
    if (req.method === 'POST' && (route === '/mic/enable' || route === '/mic/disable')) {
      const operation = route.endsWith('/enable') ? 'enable' : 'disable';
      if (operation === 'disable') {
        // ⛔ Mic 总开关关掉 ⇒ 实验也必须停，而且**不会**在麦克风回来时偷偷自己恢复：
        //    `mode` 归 idle，只有使用者再点一次「开始测试」才会重新开。
        lab.mode = 'idle';
        // ⛔ 声纹页同理：回 idle、停掉 CAM++ 推理，**麦克风回来也不自行恢复**。
        speakerLab.forceIdle('mic_off');
        /**
         * ⛔ 正式声纹门同样清空：时间轴、环、迟滞状态全部丢掉。
         * ⚠ 留着旧时间轴的后果很具体——麦克风回来后第一个 segment 会拿**关机之前**
         *   那几个 USER 窗当证据，而那段音频与它毫无关系。
         */
        speakerGate.forceIdle('mic_off');
        activityShadow.forceIdle('mic_off');
        speakerActivity.forceIdle('mic_off');
        consumers.disableAll();
        await stopChain({ reason: 'mic_off', force: true }).catch(() => null);
        syncPcmDemand();
        await revokeOrphanMicHolders('mic_off');
      }
      await android.json(`/api/android/mic/${operation}`, { method: 'POST', body: {} });
      // ⚠ 变量不叫 `value`：A13 那条断言用 `^\s*value,$` 挡住「speech_input 投影
      //   又被塞回状态流」，一个同名的简写会把它误伤成红灯（而它本身是对的）。
      const refreshed = await refresh();
      const mic = await readMic().catch(() => null);
      return send(200, {
        ok: true,
        operation,
        // 关完之后**谁还在持有**必须说出来，否则「关不掉」永远查不出原因。
        remaining_holders: mic?.demand?.holders ?? null,
        recording: mic?.recording ?? null,
        consumers: consumers.snapshot(),
        value: refreshed,
      });
    }
    /**
     * 目标说话人活动 shadow（docs/083）。⛔ 这一整组端点**没有一条**会走到
     * SenseVoice / records / 50 句 —— 到 metadata 为止。
     * ⚠ 必须排在 `/speaker` 之前的同类前缀之外；这里用精确前缀，不会与它们冲突。
     */
    /**
     * docs/084 CAM++ HTP 验收模式。⛔ 默认 OFF；开关只有 start/stop 两个动词，
     * 不做「配置里存一个 enabled」——测试模式不该在重启后自己回来。
     */
    if (route === '/activity-test' || route.startsWith('/activity-test/')) {
      const sub = route.slice('/activity-test'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        return send(200, { ok: true, value: speakerActivityProjection(),
                           consumer_enabled: consumers.enabled('speaker_activity'),
                           mic: { holders: consumers.holders() } });
      }
      if (req.method === 'GET' && sub === '/history') {
        const n = Math.max(1, Math.min(300, Number(url.searchParams.get('limit')) || 120));
        return send(200, { ok: true, history: speakerActivity.scoreHistory(n) });
      }
      if (req.method === 'GET' && sub === '/segments') {
        return send(200, { ok: true, segments: speakerActivity.recentSegments(),
                           kept: speakerActivity.segments.length,
                           limit: speakerActivity.segments.length ? undefined : undefined });
      }
      if (req.method === 'GET' && (sub.startsWith('/audio/') || sub === '/audio')) {
        const segName = sub.startsWith('/audio/')
          ? sub.slice('/audio/'.length)
          : url.searchParams.get('segment') || url.searchParams.get('clip');
        const file = speakerActivity.wavPath(segName);
        return sendWavFile(res, req, file);
      }
      if (req.method === 'POST' && sub === '/start') {
        if (listenEngaged()) {
          throw new UpstreamError('CAM++VAD is disabled during manual listen mode', 409);
        }
        try {
          await transitionSpeakerActivity(true, 'activity_test');
          if (!speakerActivity.enabled) throw new Error('CAM++VAD did not start');
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 409);
        }
        // ⛔ 不直接要麦克风：水源生死**只**由 consumer 聚合决定（docs/077），
        //    这里翻开关，`syncPcmDemand` 去跟 App 谈。
        consumers.setEnabled('speaker_activity', true);
        syncPcmDemand();
        onStageChange();
        return send(200, { ok: true, value: speakerActivityProjection(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && sub === '/stop') {
        consumers.setEnabled('speaker_activity', false);
        await transitionSpeakerActivity(false, 'user');
        syncPcmDemand();
        onStageChange();
        return send(200, { ok: true, value: speakerActivityProjection(),
                           consumers: consumers.snapshot(),
                           // ⛔ 谁还在持有麦克风必须说出来，否则「关不掉」永远查不出原因
                           remaining_holders: consumers.holders() });
      }
      if (req.method === 'POST' && sub === '/config') {
        const body = await readBody(req).catch(() => ({}));
        try {
          if (body?.tail_margin_ms !== undefined) {
            speakerActivity.setTailMargin(body.tail_margin_ms);
          }
          if (body?.head_trim_ms !== undefined) {
            speakerActivity.setHeadTrim(body.head_trim_ms);
          }
          if (body?.head_mode !== undefined) {
            speakerActivity.setHeadMode(body.head_mode);
          }
          if (body?.continuation_grace_ms !== undefined) {
            speakerActivity.setGrace(body.continuation_grace_ms);
          }
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 400);
        }
        onStageChange();
        return send(200, { ok: true, value: speakerActivityProjection() });
      }
      if (req.method === 'POST' && sub === '/segments/remove') {
        const body = await readBody(req).catch(() => ({}));
        const ok = speakerActivity.removeSegment(body?.seq);
        return send(ok ? 200 : 404, { ok, removed: ok });
      }
    }
    if (route === '/activity-shadow' || route.startsWith('/activity-shadow/')) {
      const sub = route.slice('/activity-shadow'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        return send(200, { ok: true, value: activityShadow.snapshot(),
                           consumer_enabled: consumers.enabled('activity_shadow') });
      }
      if (req.method === 'GET' && sub === '/history') {
        const n = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 30));
        return send(200, { ok: true, events: activityShadow.history(n) });
      }
      if (req.method === 'POST' && sub === '/config') {
        const body = await readBody(req).catch(() => ({}));
        const patch = Object.fromEntries(['enabled', 'window_ms', 'step_ms', 'enter_threshold',
          'exit_threshold', 'enter_confirm', 'exit_confirm', 'pre_roll_ms', 'post_roll_ms',
          'intra_pause_grace_ms', 'vad_gates_speaker', 'keep_events']
          .filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        try {
          cfg = saveActivityShadowConfig(CONFIG_FILE, patch);
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 400);
        }
        activityShadow.configure(cfg.target_activity_shadow);
        activityShadow.setEnabled(cfg.target_activity_shadow.enabled === true);
        syncChainConsumers();
        onStageChange();
        return send(200, { ok: true, value: activityShadow.snapshot(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && sub === '/stats/reset') {
        return send(200, { ok: true, stats: activityShadow.resetStats() });
      }
    }
    /**
     * 正式声纹门（docs/081）。
     * ⚠ **必须排在 `/speaker` 那一组之前**：那一组用的是 `startsWith('/speaker')`，
     *   `/speaker-gate/state` 会被它吞掉然后落进 404——前缀匹配不看分隔符。
     */
    /**
     * 正式 CAM++VAD 的开关与状态。⭐ 与 `/activity-test/*` 的区别是**归属**：
     * 这一条写配置、随链起停、重启后还在；那一组是手动验收台，关掉服务就没了。
     */
    /**
     * 孤儿登记录音：列出与删除。
     * ⭐ 开机时它们已经被扫进 `orphans/`，所以**登记目录里 glob 不到它们**——
     *   这条端点只是让使用者能看见、能清掉。⛔ 服务自己绝不删使用者的录音。
     */
    if (req.method === 'GET' && route === '/speaker/enroll/orphans') {
      return send(200, { ok: true, orphans: speakerLab.orphanEnrollWavs(),
                         swept_at_boot: speakerLab.sweptOrphans ?? null });
    }
    if (req.method === 'POST' && route === '/speaker/enroll/orphans/purge') {
      return send(200, { ok: true, ...speakerLab.purgeOrphanEnrollWavs() });
    }
    if (route === '/speaker-activity' || route.startsWith('/speaker-activity/')) {
      const sub = route.slice('/speaker-activity'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        return send(200, {
          ok: true,
          enabled_in_config: cfg.speaker_activity?.enabled === true,
          consumer_enabled: consumers.enabled('speaker_activity'),
          /** ⚠ 只在验证时非 null；⛔ 它不是链路状态的一部分。 */
          replay: replayState,
          value: speakerActivityProjection(),
        });
      }
      /**
       * ⭐ 开发态执行器开关（docs/087 P3）。⛔ **普通用户设置面不暴露**——
       *   它不是产品选项，是一条回退通道。
       */
      if (req.method === 'POST' && sub === '/executor') {
        const body = await readBody(req).catch(() => ({}));
        const mode = String(body?.executor ?? '');
        if (!['app', 'legacy_speech', 'shadow'].includes(mode)) {
          throw new UpstreamError('executor must be app / legacy_speech / shadow', 400);
        }
        try {
          cfg = saveSpeakerActivityConfig(CONFIG_FILE, { executor: mode });
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 400);
        }
        // ⛔ 别让配置写进去而执行体还停在旧状态（与声纹门同一条教训）。
        await appActivity?.setMode?.(mode).catch(() => null);
        syncChainConsumers();
        await speakerActivityTransition.catch(() => {});
        onStageChange();
        return send(200, { ok: true, executor: mode, value: speakerActivityProjection(),
                           consumers: consumers.snapshot() });
      }
      /**
       * 手动重新同步声纹（诊断用；正常路径是登记完成时自动同步 + 指纹对账）。
       * ⚠ 失败也回 **200**：Framework 的代理对非 2xx 只转发一句
       *   `termux-speech service HTTP 409`，**把原因整个吃掉**——
       *   而这条端点存在的全部意义就是那个原因。
       */
      if (req.method === 'POST' && sub === '/profile/sync') {
        const r = await appActivity?.syncProfile?.() ?? { ok: false, reason: 'no_executor' };
        const cal = speakerLab.calibration();
        /**
         * ⚠ `ok` 是**传输层**的判据，不是这次同步成不成功的判据。
         *   Framework 的代理看到 `ok:false` 就把整个 body 换成一句
         *   `termux-speech service HTTP 200`——于是原因照样消失，只是换了个方式。
         * ⭐ 域内的结论必须放在**自己的字段**里（`synced`），⛔ 不许借用 `ok`。
         */
        const { ok: _syncOk, ...detail } = r;
        return send(200, {
          ok: true,
          synced: r.ok === true,
          ...detail,
          // ⭐ 把判据的两个输入也摆出来：「为什么不同步」只有这两种答案。
          lab_profile_ready: cal.profile_ready === true,
          lab_fingerprint: cal.profile_fingerprint ?? null,
          lab_has_reference: Array.isArray(cal.profile?.reference),
          value: speakerActivityProjection(),
        });
      }
      if (req.method === 'POST' && sub === '/config') {
        const body = await readBody(req).catch(() => ({}));
        if (body?.enabled === undefined) {
          throw new UpstreamError('enabled is required', 400);
        }
        try {
          cfg = saveSpeakerActivityConfig(CONFIG_FILE, { enabled: body.enabled === true });
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 400);
        }
        // ⛔ 别让配置写进去而 consumer 还停在旧状态（与声纹门同一条教训）。
        syncChainConsumers();
        onStageChange();
        return send(200, {
          ok: true,
          enabled_in_config: cfg.speaker_activity?.enabled === true,
          consumer_enabled: consumers.enabled('speaker_activity'),
          value: speakerActivityProjection(),
        });
      }
      /**
       * ⭐ **真实 replay**：把一段已保存的 PCM 从**麦克风那条同一个入口**推进去。
       *
       * ⚠ 存在的理由很具体：设备的声学回环有 AEC，把使用者自己的录音从喇叭放出来
       *   再收回麦克风，CAM++ 的相似度会被压到 0.05 上下——不是它认不出，是那段声音
       *   到不了麦克风。于是「CAM++ 判 USER」这件事在这台机器上**无法用播放来验证**。
       * ⭐ 它调的是 `ingestPcmFrame`，**与实时 PCM 一模一样的那一个函数**——
       *   RMS 门、声纹门、CAM++VAD、spool、ASR 全都按原样看到这些帧。
       * ⛔ 它不是直接调用 App ASR API：段仍然由 CAM++VAD 自己切，
       *   仍然进同一个 spool，仍然由当前 backend 转写。绕过其中任何一步都不算跑通。
       * ⚠ 仅供验证：帧按 100 ms 一块喂，节拍由**喂进去多少音频**决定而不是墙钟
       *   （docs/063 的教训：按墙钟喂会让整段音频一瞬到齐，算法根本没被执行到）。
       */
      if (req.method === 'POST' && sub === '/replay') {
        const body = await readBody(req).catch(() => ({}));
        const wav = String(body?.wav_path ?? '');
        if (!wav) throw new UpstreamError('wav_path is required', 400);
        if (!consumers.enabled('speaker_activity')) {
          throw new UpstreamError('speaker_activity is not enabled; replay would prove nothing', 409);
        }
        let samples;
        try { samples = readWavMono16(wav); } catch (error) {
          throw new UpstreamError(`cannot read ${wav}: ${String(error?.message ?? error)}`, 400);
        }
        const FRAME = 1600;                       // 100 ms @ 16 kHz
        const paceMs = body?.pace_ms === undefined ? 100 : Math.max(0, Number(body.pace_ms) || 0);
        const total = Math.floor(samples.length / FRAME);
        /**
         * ⚠ **不等它跑完就回**。按真实时间喂 10 秒音频要 10 秒，而 Framework 的
         *   包代理会在那之前把请求掐掉（实测 `The operation was aborted due to timeout`）。
         * ⭐ 真实的麦克风也是这样：帧一直来，没有人拿着一个 HTTP 请求等它。
         *   进度看 `GET /speaker-activity/state`。
         */
        replayState = {
          wav_path: wav, frames: 0, total, pace_ms: paceMs,
          started_at_ms: Date.now(), finished_at_ms: null,
        };
        void (async () => {
          let observed = Date.now();
          for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
            const slice = samples.subarray(i, i + FRAME);
            const buf = Buffer.allocUnsafe(slice.length * 2);
            for (let n = 0; n < slice.length; n += 1) buf.writeInt16LE(slice[n], n * 2);
            observed += 100;
            ingestPcmFrame(buf, { observed_at_ms: observed, source: 'replay' });
            replayState.frames += 1;
            /**
             * ⚠ **按真实时间喂**。第一版把 10 秒音频在 224 ms 内推完，结果 CAM++ 的
             *   相似度与纯静音没有区别：它的推理是 `await` 的，帧比推理来得快时，
             *   窗口拿到的并不是这段音频。⛔ 「喂进去了」与「被算过了」是两件事。
             */
            if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
          }
          replayState.finished_at_ms = Date.now();
        })().catch((error) => {
          replayState.error = String(error?.message ?? error);
          replayState.finished_at_ms = Date.now();
        });
        return send(202, {
          ok: true, started: true, wav_path: wav, total_frames: total,
          audio_ms: total * 100, pace_ms: paceMs,
          note: 'progress: GET /speaker-activity/state',
        });
      }
      /**
       * ⭐ **窄测**（任务书 §1）：同一段音频、**同一个 feature tensor**，
       *   分别喂 CPU CAM++ 与 HTP CAM++，再各自与**生产实际加载的那份 centroid** 打分。
       *
       * 它要分开的是两件一直被混在一起的事：
       *   · Lab 的 0.76–0.92 是「**整段**登记音频 vs 由这些整段算出来的质心」——
       *     那是构造上就该高的数（质心正是它们的平均）。
       *   · 生产的 0.12–0.22 是「**1500 ms 滑窗** vs 同一个质心」。
       * ⛔ 拿这两个数直接相减，得到的结论必然是错的。
       * 所以这里同时给出：整段(CPU) / 同一窗(CPU) / 同一窗(HTP) 三个分数，
       * 以及 cos(cpu_win, htp_win) —— 只有最后这个能回答「后端是不是分叉了」。
       */
      if (req.method === 'POST' && sub === '/probe') {
        const body = await readBody(req).catch(() => ({}));
        const wav = String(body?.wav_path ?? '');
        if (!wav) throw new UpstreamError('wav_path is required', 400);
        const windowMs = Math.max(500, Number(body?.window_ms) || 1500);
        let samples;
        try { samples = readWavMono16(wav); } catch (error) {
          throw new UpstreamError(`cannot read ${wav}: ${String(error?.message ?? error)}`, 400);
        }
        const cal = speakerLab.calibration?.() ?? {};
        if (cal.profile_ready !== true) throw new UpstreamError('no speaker profile', 409);

        const toI16 = (f32) => Int16Array.from(f32, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
        const need = Math.round(windowMs / 1000 * 16000);
        /** ⚠ 取**中间**那一窗：开头结尾多半是静音，拿静音去比声纹毫无意义。 */
        const start = Math.max(0, Math.floor((samples.length - need) / 2));
        const win = samples.subarray(start, start + need);

        const cos = (a, b) => {
          let d = 0; let na = 0; let nb = 0;
          for (let i = 0; i < a.length; i += 1) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
          return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
        };
        const out = { wav_path: wav, samples: samples.length, window_ms: windowMs,
                      window_samples: win.length, window_start_sample: start };
        try {
          await speakerEmbedder.ensure();
          const full = await speakerEmbedder.embed(toI16(samples));
          out.cpu_full = { frames: full.frames, score: cal.profile.score(full.embedding) };
          const cpuWin = await speakerEmbedder.embed(toI16(win));
          out.cpu_window = { frames: cpuWin.frames, score: cal.profile.score(cpuWin.embedding) };
          out.cpu_full_vs_cpu_window = cos(full.embedding, cpuWin.embedding);
          try {
            await camHtpEmbedder.ensure();
            const htpWin = await camHtpEmbedder.embed(toI16(win));
            out.htp_window = { frames: htpWin.frames, score: cal.profile.score(htpWin.embedding),
                               compute_unit: htpWin.compute_unit };
            /** ⭐ 这一个数才回答「CPU 与 HTP 是不是同一个嵌入空间」。 */
            out.cpu_vs_htp_window = cos(cpuWin.embedding, htpWin.embedding);
          } catch (error) { out.htp_error = String(error?.message ?? error); }
        } catch (error) { out.cpu_error = String(error?.message ?? error); }
        /** ⚠ `fingerprint` 是 getter 不是方法——调用它会抛，而那时前面所有测量都白做了。 */
        out.profile = { fingerprint: cal.profile?.fingerprint ?? null,
                        enrollments: cal.profile?.enrollments?.length ?? null };
        return send(200, { ok: true, value: out });
      }
      throw new UpstreamError(`unknown speaker-activity route: ${route}`, 404);
    }
    if (route === '/speaker-gate' || route.startsWith('/speaker-gate/')) {
      const sub = route.slice('/speaker-gate'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        return send(200, { ok: true, value: speakerGate.snapshot(),
                           foreground_authority: foregroundAuthority(),
                           consumer_enabled: consumers.enabled('speaker_gate') });
      }
      if (req.method === 'POST' && sub === '/config') {
        const body = await readBody(req).catch(() => ({}));
        const patch = Object.fromEntries(['enabled', 'min_coverage', 'rms_activity',
          'inference_timeout_ms', 'timeline_ms']
          .filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        try {
          cfg = saveSpeakerGateConfig(CONFIG_FILE, patch);
        } catch (error) {
          throw new UpstreamError(String(error?.message ?? error), 400);
        }
        speakerGate.configure(cfg.speaker_gate);
        // 开关一变，水源的需求就变了——⛔ 别让配置写进去而 consumer 还停在旧状态。
        syncChainConsumers();
        onStageChange();
        return send(200, { ok: true, value: speakerGate.snapshot(),
                           foreground_authority: foregroundAuthority(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'GET' && sub === '/telemetry') {
        const gt = speakerGate.snapshot().telemetry;
        return send(200, { ok: true,
          speaker_gate: gt,
          baseline: telemetryBaseline,
          delta: telemetryBaseline ? {
            elapsed_ms: Date.now() - telemetryBaseline.at_ms,
            windows_run: gt.windows_run - (telemetryBaseline.windows_run ?? 0),
            decisions: gt.decisions,
          } : null });
      }
      if (req.method === 'POST' && sub === '/telemetry/reset') {
        const current = speakerGate.snapshot().telemetry;
        telemetryBaseline = { at_ms: Date.now(), windows_run: current.windows_run };
        return send(200, { ok: true, speaker_gate: speakerGate.resetTelemetry(),
                           baseline: telemetryBaseline });
      }
    }
    /**
     * 声纹登记 / 实时 similarity（docs/080）。⛔ 这一整组端点**没有一条**会走到
 * SenseVoice / records —— 到 similarity 为止。
     */
    if (route.startsWith('/speaker')) {
      const sub = route.slice('/speaker'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        // ⭐ 校准台要看得见生产线此刻是什么状态——后果发生在别处，提示要在动手这一处。
        return send(200, { ok: true, value: speakerLab.snapshot(),
                           speaker_gate: speakerGate.snapshot(),
                           consumer_enabled: consumers.enabled('speaker') });
      }
      if (req.method === 'GET' && (sub.startsWith('/audio/') || sub === '/audio')) {
        const clipName = sub.startsWith('/audio/')
          ? sub.slice('/audio/'.length)
          : url.searchParams.get('clip') || url.searchParams.get('name');
        const file = speakerLab.audioPath(clipName);
        return sendWavFile(res, req, file);
      }
      if (req.method === 'POST' && (sub === '/enroll/start' || sub === '/test/start')) {
        const mode = sub.startsWith('/enroll') ? 'enrolling' : 'testing';
        try {
          await speakerLab.start(mode);
        } catch (error) {
          // ⛔ 模型缺失就明说，不要静默进入一个什么都不会发生的模式。
          return send(503, { ok: false, error: String(error?.message ?? error),
                             value: speakerLab.snapshot() });
        }
        setConsumer('speaker', true);
        onStageChange();
        return send(200, { ok: true, value: speakerLab.snapshot(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && (sub === '/enroll/stop' || sub === '/test/stop')) {
        speakerLab.stop();
        setConsumer('speaker', false);
        onStageChange();
        return send(200, { ok: true, value: speakerLab.snapshot(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && sub === '/profile/build') {
        const built = speakerLab.buildProfile();
        /**
         * ⭐ 登记完成 = 一次**低频**同步。⛔ 不在每个 CAM++ 窗上查询声纹。
         * ⚠ 同步失败不改这条请求的结果：登记本身成功了，而 App 侧 fail closed
         *   （没有声纹就不判决）——把它变成 500 会让使用者以为登记没成。
         */
        const synced = await appActivity?.syncProfile?.() ?? { ok: false, reason: 'no_executor' };
        return send(200, { ok: true, ...built, app_profile: synced,
                           value: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/profile/clear') {
        const cleared = speakerLab.clearProfile();
        // ⛔ 不留一份没人维护的旧身份在 App 里。
        const removed = await appActivity?.clearProfile?.() ?? { ok: false, reason: 'no_executor' };
        return send(200, { ok: true, ...cleared, app_profile: removed,
                           value: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/profile/remove') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, ...speakerLab.removeEnrollment(String(body?.id ?? '')),
                           value: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/config') {
        return send(200, { ok: true, value: speakerLab.configure(await readBody(req)),
                           state: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/purge') {
        return send(200, { ok: true, ...speakerLab.purge(), value: speakerLab.snapshot() });
      }
      /** ⭐ 轻量时间轴：按游标只取增量，⛔ 绝不塞进 `/live`（那是整份状态）。 */
      if (req.method === 'GET' && sub === '/timeline') {
        return send(200, { ok: true,
          ...speakerLab.timelineSince(url.searchParams.get('after') ?? 0,
                                      Number(url.searchParams.get('limit')) || 200),
          uservad: speakerLab.uservad.snapshot(),
          cpu: speakerLab.cpu(),
          labels: speakerLab.labels.snapshot(speakerLab.uservad.config),
          vad_probability: speakerLab.lastVadProb,
          mode: speakerLab.mode });
      }
      if (req.method === 'POST' && sub === '/label') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, label: speakerLab.setLabel(String(body?.label ?? '')),
                           value: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/labels/clear') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, ...speakerLab.clearLabelStats(body?.label ?? null),
                           value: speakerLab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/threshold/ack') {
        return send(200, { ok: true, ...speakerLab.acknowledgeCalibration(),
                           value: speakerLab.snapshot() });
      }
    }
    /**
     * 声学校准 / Endpoint Lab（docs/078）。⛔ 这一整组端点**没有一条**会走到
 * SenseVoice / records —— 到 WAV 为止。
     */
    if (route.startsWith('/acoustic-lab')) {
      const sub = route.slice('/acoustic-lab'.length);
      if (req.method === 'GET' && (sub === '' || sub === '/state')) {
        return send(200, { ok: true, value: lab.snapshot(), timeline: lab.timelineSlice(400),
                           disk_bytes: lab.diskBytes(), consumer_enabled: consumers.enabled('lab') });
      }
      if (req.method === 'GET' && sub === '/timeline') {
        return send(200, { ok: true, timeline: lab.timelineSlice(Number(url.searchParams.get('n')) || 400) });
      }
      if (req.method === 'GET' && sub === '/epochs') {
        return send(200, { ok: true, epochs: lab.snapshot().epochs, disk_bytes: lab.diskBytes() });
      }
      if (req.method === 'GET' && sub.startsWith('/audio/')) {
        const [, , seq, which] = sub.split('/');
        const file = lab.audioPath(seq, which);
        if (!file) return send(404, { ok: false, error: 'no such lab audio' });
        const raw = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': raw.length,
                             'Cache-Control': 'no-store' });
        return res.end(raw);
      }
      if (req.method === 'POST' && sub === '/config') {
        return send(200, { ok: true, value: lab.configure(await readBody(req)) });
      }
      if (req.method === 'POST' && (sub === '/calibration/start' || sub === '/test/start')) {
        const mode = sub.startsWith('/calibration') ? 'calibrating' : 'testing';
        const body = await readBody(req).catch(() => ({}));
        try { await lab.ensureResident(); } catch (error) {
          return send(503, { ok: false, error: String(error?.message ?? error) });
        }
        lab.reset(mode);
        lab.mode = mode;
        // 校准的是哪一层由调用方明说；不给就是用户层（旧行为）。
        if (mode === 'calibrating') {
          lab.calibTarget = body?.target === 'background' ? 'background' : 'user';
        } else if (typeof body?.phase === 'string') {
          lab.setPhase(body.phase);
        }
        // ⭐ 只开 `lab` 这一个 consumer；RMS/VAD 一律不动。
        setConsumer('lab', true);
        onStageChange();
        return send(200, { ok: true, value: lab.snapshot(),
                           consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && (sub === '/calibration/stop' || sub === '/test/stop')) {
        lab.mode = 'idle';
        setConsumer('lab', false);
        onStageChange();
        return send(200, { ok: true, value: lab.snapshot(), consumers: consumers.snapshot() });
      }
      if (req.method === 'POST' && sub === '/phase') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, phase: lab.setPhase(body?.phase ?? null), value: lab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/reference/apply') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, ...lab.applyReference(body?.target ?? 'user'), value: lab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/reference/clear') {
        const body = await readBody(req).catch(() => ({}));
        return send(200, { ok: true, ...lab.clearReference(body?.target ?? 'all'), value: lab.snapshot() });
      }
      if (req.method === 'POST' && sub === '/purge') {
        lab.purge();
        return send(200, { ok: true, disk_bytes: lab.diskBytes() });
      }
      return send(404, { ok: false, error: `not found: ${route}` });
    }
    if (req.method === 'GET' && route === '/pcm/consumers') {
      return send(200, { ok: true, value: consumers.snapshot() });
    }
    if (req.method === 'POST' && route === '/pcm/consumers') {
      const body = await readBody(req);
      const name = String(body?.name ?? '');
      if (!consumers.has(name)) {
        return send(400, { ok: false, error: `unknown consumer: ${name}` });
      }
      const value = setConsumer(name, body?.enabled !== false);
      onStageChange();
      return send(200, { ok: true, value });
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
    + ` pool=${cfg.vad.pcm_pool_ms}ms`
    + ` vad-countdown=${cfg.vad.no_output_timeout_ms}ms`
    + ` asr-countdown=${cfg.asr.idle_timeout_ms}ms`
    + ` chain=${cfg.chain_desired} warm=${cfg.dictation_warm_timeout_seconds}s`,
  );
  void (async () => {
    await refresh().catch(() => {});
    // 先对账再决定动作：这一步既不 declare 也不 undeclare，只是认清 App 那边现在是什么。
    await reconcileFromApp();
    // ⭐ 上一条命留下的具名需求在这里清掉——此刻还没有任何 consumer 开着，
    //   所以凡是以 `termux-speech` 开头的 holder 都是孤儿。
    await revokeOrphanMicHolders('boot').catch(() => {});
    lastReconcileMs = Date.now();
    // 归档打不开不是致命错误：记录照常写盘，只是轮转会停下并如实上报——
    // 绝不会因为「归档不可用」就把 WAV 删掉。
    const archiveOk = await archive.open();
    const recovered = records.reconcile();
    console.log(`[termux-speech] records archive=${archiveOk ? 'ready' : archive.lastError}`
      + ` groups_on_disk=${recovered.snapshot.groups_on_disk}`
      + (recovered.notes.length ? ` recovery=${recovered.notes.join(' | ')}` : ''));
    // ⭐ 先收敛唯一 backend 再启动 chain，确保启动时就完成 SenseVoice readiness。
    const bootWanted = configuredBackend();
    await syncAppSegmentBackend(bootWanted, 'boot').catch((error) => {
      console.log(`[termux-speech] App ASR backend boot sync failed: ${error?.message ?? error}`);
    });
    // ⭐ 无条件 ensure：⛔ 不许用「选择值没变」跳过准备（docs/090 §6）。
    await ensureBackendReady('boot').catch((error) => {
      console.log(`[termux-speech] backend boot readiness failed: ${error?.message ?? error}`);
    });
    if (cfg.chain_desired === 'started') {
      await startChain('boot');
    } else {
      // ⭐ 停链是使用者的决定，服务重启不该替他撤销它。这里**什么都不做**——
      // 尤其不 undeclare：重启不是 churn HTP 会话的理由。
      console.log('[termux-speech] chain_desired=stopped; leaving residents untouched');
      onStageChange();
    }
    /** 启动再次确认唯一的 SenseVoice backend 已就绪。 */
    // 起链之后再 ensure 一次：起链会动处理门与常驻，⛔ 同样不看选择值有没有变。
    const wanted = configuredBackend();
    await ensureBackendReady('boot_after_chain').catch((error) => ({
      changed: false, error: String(error?.message ?? error),
    }));
    console.log(`[termux-speech] backend ready: active=${activeBackend} configured=${wanted}`
      + ` automatic_ready=${appExecutable ? appExecutable.ready === true : 'unknown'}`);
    onStageChange();
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
  vad.close();
  asr.close();
  state.state = 'stopped';
  flush(true);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);

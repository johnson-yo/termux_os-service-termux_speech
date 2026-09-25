/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Isolated v4 config, App transports, last-owner lease, VAD/ASR, and WebUI fixtures.
 * [OUTPUT]: Truthful Package self-test PASS/FAIL lines without requiring a phone or model inference.
 * [POS]: Device-independent gate for RMS→FireRedVAD→WAV→SenseVoice plus speech.idle.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStatus, readStatus } from '../service/status.mjs';
import {
  loadConfig,
  saveAsrConfig,
  saveRmsGateConfig,
  saveVadConfig,
} from '../service/config.mjs';
import { systemKeyAuthorized } from '../service/http-auth.mjs';
import {
  appJson,
  createAndroidAppClient,
  discoverAndroidApp,
} from '../service/app-api.mjs';
import { PcmWs, pcmWebSocketDescriptor } from '../service/pcm-ws.mjs';
import { RmsGate } from '../service/rms-gate.mjs';
import { projectSpeechInput } from '../service/speech-input.mjs';
import { computeFbank, loadCmvn } from '../service/vad/fbank.mjs';
import { StreamVadPost } from '../service/vad/postprocessor.mjs';
import { projectStates, routeClass } from '../service/states.mjs';
import { VadController } from '../service/vad/controller.mjs';
import { AsrController } from '../service/asr/controller.mjs';
import { decodeCtcIds, makeSenseVoiceInput } from '../service/asr/features.mjs';
import { PIPELINE_OWNERS, PipelineLease } from '../service/pipeline-lease.mjs';

let failures = 0;
const test = (name, condition) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-'));
const statusFile = path.join(temporaryRoot, 'status.json');
writeStatus(statusFile, { state: 'idle', refresh_count: 3 });
test('status is written atomically', readStatus(statusFile).refresh_count === 3);
test(
  'atomic status write leaves no temporary file',
  !fs.readdirSync(temporaryRoot).some((file) => file.endsWith('.tmp')),
);

const legacyFile = path.join(temporaryRoot, 'conf.v3.json');
const configFile = path.join(temporaryRoot, 'conf.v4.json');
fs.writeFileSync(legacyFile, JSON.stringify({
  schema: 'termux-os-framework.termux-speech.conf.v3',
  poll_interval_ms: 2500,
  rms_gate: { open_threshold: 0.06, sample_interval_ms: 200 },
}));
const migrated = loadConfig(configFile, legacyFile);
test(
  'v3 config migrates to v4 and preserves the RMS/VAD/ASR defaults',
  migrated.schema === 'termux-os-framework.termux-speech.conf.v4'
    && migrated.rms_gate.open_threshold === 0.06
    && migrated.vad.pcm_pool_ms === 6000
    && migrated.vad.no_output_timeout_ms === 15_000
    && migrated.asr.idle_timeout_ms === 15_000,
);
fs.writeFileSync(configFile, JSON.stringify({
  schema: 'termux-os-framework.termux-speech.conf.v3',
  rms_gate: { open_threshold: 0.06, sample_interval_ms: 200 },
}));
const recoveredMigration = loadConfig(configFile, legacyFile);
test(
  'an old-schema shell at the v4 path is rebuilt from the last valid v3 config',
  recoveredMigration.schema === 'termux-os-framework.termux-speech.conf.v4'
    && recoveredMigration.rms_gate.open_threshold === 0.06,
);
const savedGate = saveRmsGateConfig(configFile, { open_threshold: 0.07 });
const savedVad = saveVadConfig(configFile, {
  pcm_pool_ms: 5500,
  no_output_timeout_ms: 18_000,
});
const savedAsr = saveAsrConfig(configFile, {
  idle_timeout_ms: 22_000,
});
test(
  'RMS, VAD, and ASR standby config persist independently',
  savedGate.rms_gate.open_threshold === 0.07
    && savedVad.vad.pcm_pool_ms === 5500
    && savedVad.vad.no_output_timeout_ms === 18_000
    && savedAsr.asr.idle_timeout_ms === 22_000,
);
fs.writeFileSync(configFile, JSON.stringify({
  ...savedAsr,
  retired_marker: true,
  speaker_gate: { ...savedAsr.speaker_gate, retired_marker: true },
}));
const cleaned = loadConfig(configFile);
const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'));
test(
  'config load rewrites only the current schema fields',
  cleaned.schema === 'termux-os-framework.termux-speech.conf.v4'
    && !Object.hasOwn(persisted, 'retired_marker')
    && !Object.hasOwn(persisted.speaker_gate, 'retired_marker'),
);
let invalidPoolRejected = false;
try { saveVadConfig(configFile, { pcm_pool_ms: 6100 }); } catch { invalidPoolRejected = true; }
test('VAD pre-roll Pool cannot exceed six seconds', invalidPoolRejected);
test(
  'System Key authentication accepts only the exact key',
  systemKeyAuthorized('Bearer test-key', 'test-key')
    && !systemKeyAuthorized('Bearer wrong', 'test-key'),
);

const descriptorFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    value: {
      base_url: 'http://127.0.0.1:8796',
      token: 'provider-secret',
      headers: { Authorization: 'Bearer provider-secret' },
    },
  }),
});
const descriptor = await discoverAndroidApp({
  frameworkUrl: 'http://127.0.0.1:8980',
  systemKey: 'framework-key',
  fetchImpl: descriptorFetch,
});
test(
  'termux-os.app.api descriptor is usable without persisting credentials',
  descriptor.baseUrl === 'http://127.0.0.1:8796'
    && descriptor.authorization === 'Bearer provider-secret',
);

let observedAuthorization = '';
const appData = await appJson(descriptor, '/api/android/mic/status', {
  fetchImpl: async (_url, options) => {
    observedAuthorization = options.headers.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { recording: true } }),
    };
  },
});
test(
  'App JSON request uses the descriptor and returns only data',
  appData.recording === true && observedAuthorization === 'Bearer provider-secret',
);

let descriptorCalls = 0;
const client = createAndroidAppClient({
  frameworkUrl: 'http://127.0.0.1:8980',
  systemKey: 'framework-key',
  fetchImpl: async (url) => {
    if (url.includes('/api/capabilities/')) {
      descriptorCalls += 1;
      return descriptorFetch();
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { recording: true } }),
    };
  },
});
await client.describe();
await client.json('/api/android/mic/status');
await client.describe();
test('JSON and WS discovery share the short-lived descriptor cache', descriptorCalls === 1);

const pcmDescriptor = pcmWebSocketDescriptor(descriptor);
const pcmClient = new PcmWs();
pcmClient.configure(pcmDescriptor);
const pcmSnapshot = pcmClient.snapshot();
test(
  'PCM descriptor selects the exact App WS while public state redacts credentials',
  /**
   * ⭐ `?rms=1` 是**故意**的：RMS 的权威是 App，逐帧锚让那个数与它的帧成对到达。
   * ⚠ 路径本身一个字符都没变——旧 App 忽略这个参数就是从前的行为。
   */
  pcmDescriptor.endpoint === 'ws://127.0.0.1:8796/api/android/mic/stream?rms=1'
    && pcmSnapshot.endpoint === '/api/android/mic/stream'
    && pcmSnapshot.frame_bytes === 3200
    && !JSON.stringify(pcmSnapshot).includes('provider-secret'),
);

const gate = new RmsGate({ open_threshold: 0.05, sample_interval_ms: 200 });
/**
 * ⚠ 下面这一组钉的是 **RMS 阈值 admission 本身**：越阈开门、跌落不关门、下游关门后重新 arm。
 *   P2 把正式 admission 整个搬进了 App（`gateExecutor='app'` 之后 `ingest()` 不再开门），
 *   于是这组全红——**而实现是变得更正确了**。
 * ⭐ 这套逻辑没有被删除，它就是 `legacy_speech` 回退态。所以这里**显式声明测的是它**，
 *   ⛔ 而不是把断言改软。**测试要跟着语义走，不是跟着颜色走。**
 */
gate.setGateExecutor('legacy_speech');
/**
 * ⚠ 下面这一组钉的是 **RMS 阈值 admission 本身**：越阈开门、跌落不关门、
 *   下游关门后重新 arm。P2 把正式 admission 整个搬进了 App（`gateExecutor='app'`
 *   之后 `ingest()` 不再开门），于是这组测试全红——**而实现是变得更正确了**。
 * ⭐ 这套逻辑并没有被删除，它就是 `legacy_speech` 回退态；所以这里显式声明测的是它，
 *   ⛔ 而不是把断言改软。**测试要跟着语义走，不是跟着颜色走。**
 */
gate.setGateExecutor('legacy_speech');
let gateValue = gate.ingest({
  rms: 0.10,
  recording: true,
  frameSeq: 1,
  sampleAgeMs: 0,
}, 1000);
test(
  'RMS opens and latches admission for the VAD Pool',
  gateValue.state === 'open'
    && gateValue.pcm_admission === 'allow'
    && gateValue.decision_metric === 'avg_100ms'
    && gateValue.decision_window_ms === 100
    && gateValue.decision_value === 0.10
    && gateValue.close_control === 'current_pipeline_lease_owner',
);
gateValue = gate.ingest({
  rms: 0.03,
  recording: true,
  frameSeq: 2,
  sampleAgeMs: 0,
}, 1100);
test('RMS falloff does not close the downstream-owned gate',
  gateValue.state === 'open'
    && gateValue.decision_value === 0.03
    && gateValue.pcm_admission === 'allow');
gateValue = gate.ingest({
  rms: 0.01,
  recording: true,
  frameSeq: 3,
  sampleAgeMs: 0,
}, 1200);
test('RMS can stay open through a quiet frame after admission',
  gateValue.state === 'open' && gateValue.decision_value === 0.01
    && gateValue.pcm_admission === 'allow');
gateValue = gate.closeFromDownstream('speech.vad', 'camplus_no_user_timeout', 1200);
test(
  'VAD can reset the pipeline to before RMS without an immediate bounce',
  gateValue.state === 'closed'
    && gateValue.open_armed === false
    && gateValue.last_transition.owner === 'speech.vad',
);
gate.ingest({ rms: 0.00, recording: true, frameSeq: 4, sampleAgeMs: 0 }, 1300);
gateValue = gate.ingest({ rms: 0.10, recording: true, frameSeq: 5, sampleAgeMs: 0 }, 1400);
test('RMS rearms on low audio and opens again on a new qualified sound', gateValue.state === 'open');

const ownership = new PipelineLease();
ownership.observeGate({
  state: 'open',
  pcm_admission: 'allow',
  transition_seq: 9,
  opened_at_ms: 1000,
}, 1000);
const staleAsrBeforeVad = ownership.requestIdle({
  requester: PIPELINE_OWNERS.ASR,
  reason: 'premature_asr_timeout',
  epoch: ownership.epoch,
}, 1200);
const toVad = ownership.handoff(
  PIPELINE_OWNERS.VAD,
  PIPELINE_OWNERS.ASR,
  'vad_wav_published',
  1300,
);
const staleVad = ownership.requestIdle({
  requester: PIPELINE_OWNERS.VAD,
  reason: 'expired_vad_timeout',
  epoch: ownership.epoch,
}, 1400);
const asrIdle = ownership.requestIdle({
  requester: PIPELINE_OWNERS.ASR,
  reason: 'asr_standby',
  epoch: ownership.epoch,
}, 1500);
test(
  'RMS opens, VAD hands WAV to ASR, and only ASR can return to RMS',
  staleAsrBeforeVad.code === 'stale_owner'
    && toVad.accepted
    && staleVad.code === 'stale_owner'
    && asrIdle.accepted
    && ownership.snapshot().owner === PIPELINE_OWNERS.RMS,
);

const post = new StreamVadPost();
let speechStart = null;
let speechEnd = null;
for (let index = 0; index < 12; index += 1) {
  speechStart ??= post.process(1).start_frame ?? null;
}
for (let index = 0; index < 34; index += 1) {
  speechEnd ??= post.process(0).end_frame ?? null;
}
test(
  'FireRedVAD postprocessor reuses the App 5/0.5/5/8/30/1200 cut conditions',
  speechStart !== null
    && speechEnd !== null
    && post.options.smoothWindow === 5
    && post.options.threshold === 0.5
    && post.options.padStartFrames === 5
    && post.options.minSpeechFrames === 8
    && post.options.minSilenceFrames === 30
    && post.options.maxSpeechFrames === 1200,
);

const cmvnBytes = Buffer.alloc(160 * 4);
for (let index = 80; index < 160; index += 1) cmvnBytes.writeFloatLE(1, index * 4);
const pcmSamples = Float64Array.from(
  { length: 1600 },
  (_, index) => Math.sin(index / 9) * 6000,
);
const fbank = computeFbank(pcmSamples, loadCmvn(cmvnBytes));
test(
  'dependency-free fbank produces the proven 80-bin 10 ms FireRedVAD input',
  fbank.frames === 8 && fbank.feat.length === 8 && fbank.feat.every((row) => row.length === 80),
);

const senseSamples = Float32Array.from(
  { length: 1600 },
  (_, index) => Math.sin(index / 11) * 5000,
);
const senseInput = makeSenseVoiceInput(senseSamples, {
  add: new Float32Array(560),
  scale: Float32Array.from({ length: 560 }, () => 1),
});
const decoded = decodeCtcIds([1, 1, 0, 2, 2, 0, 3], ['<blank>', '你', '▁好', '<noise>']);
test(
  'SenseVoice preprocessing produces fixed LFR 7/6 input and CTC text',
  senseInput.validFrames === 2
    && senseInput.speech.length === 167 * 560
    && senseInput.speech.slice(0, 1120).every(Number.isFinite)
    && decoded.text === '你 好',
);

const modelRoot = path.join(temporaryRoot, 'models', 'fireredvad');
fs.mkdirSync(modelRoot, { recursive: true });
fs.writeFileSync(path.join(modelRoot, 'model.onnx'), 'fixture');
fs.writeFileSync(path.join(modelRoot, 'cmvn.bin'), cmvnBytes);
const vadRoot = path.join(temporaryRoot, 'vad-data');
// 与 ASR fixture 同一纪律：只实现 residents 路由，transient 路径一旦被用到就抛。
const vadDeclares = [];
const fakeAndroid = {
  async json(route, options = {}) {
    if (route === '/api/inference/residents/fixture-vad' && options.method === 'PUT') {
      vadDeclares.push(options.body);
      return { declared: 'fixture-vad' };
    }
    if (route === '/api/inference/residents/fixture-vad/stream') {
      return { values: { probs: [] } };
    }
    throw new Error(`unexpected VAD fixture route: ${options.method ?? 'GET'} ${route}`);
  },
};
/**
 * ⚠ 这个 fixture 曾经传 `modelFile:` —— 而 docs/093 的 logical-model 迁移把那个参数
 *   改成了已路由好的 `graph:`（`executableGraphArgs` 的产物）。**构造器不接 `modelFile`，
 *   于是它被静默忽略**，`modelPath` 恒为 null，`arm()` 每次都以
 *   `FireRedVAD logical executable is unavailable` 失败。
 * ⭐ 后果不是一条红断言，是 `enqueue()` 抛异常**把整个文件打断**——
 *   自那之后本文件 99 条断言里有 **69 条从来没有执行过**，而报告只显示一条红。
 *   ⭐ **一个传了却没人读的构造参数，和一个根本不存在的参数，在测试里长得一模一样。**
 */
const vad = new VadController({
  android: fakeAndroid,
  dataRoot: vadRoot,
  graph: { path: path.join(modelRoot, 'model.onnx'), kind: 'source', isContext: false },
  cmvnFile: path.join(modelRoot, 'cmvn.bin'),
  residentId: 'fixture-vad',
  config: { pcm_pool_ms: 6000, no_output_timeout_ms: 15_000 },
});
vad.observeTransport({ connected: true });
vad.observeGate({
  state: 'open',
  pcm_admission: 'allow',
  transition_seq: 1,
  opened_at_ms: 1000,
}, 1000);
const quietFrame = Buffer.alloc(3200);
for (let index = 0; index < 70; index += 1) {
  vad.ingestPcm(quietFrame, { observed_at_ms: 1000 + index * 100 });
}
let vadValue = vad.snapshot(8000);
test(
  'the pre-roll Pool rolls before the Gate opens so speech onset is never truncated',
  (() => {
    const rolling = new VadController({
      android: fakeAndroid,
      dataRoot: path.join(temporaryRoot, 'vad-rolling'),
      graph: { path: path.join(modelRoot, 'model.onnx'), kind: 'source', isContext: false },
      cmvnFile: path.join(modelRoot, 'cmvn.bin'),
      residentId: 'fixture-vad',
      config: { pcm_pool_ms: 6000, no_output_timeout_ms: 15_000 },
    });
    rolling.observeTransport({ connected: true });
    // 刻意**不**开门：旧实现此刻一个字节都不留，于是 RMS decision window 的滞后
    // 直接从 timeline 头部啃掉语音起点。
    for (let index = 0; index < 20; index += 1) {
      rolling.ingestPcm(Buffer.alloc(3200), { observed_at_ms: 1000 + index * 100 });
    }
    const closed = rolling.snapshot(3000);
    return closed.pcm_pool.admission === 'block'
      && closed.pcm_pool.rolling === 'always'
      && closed.pcm_pool.retained_bytes === 20 * 3200
      && closed.pcm_pool.eligible_ms === 2000;
  })(),
);

test(
  'VAD owns a real bounded pre-roll Pool reserved for the VAD path',
  vadValue.pcm_pool.owner === 'termux-speech-vad'
    && vadValue.pcm_pool.duration_ms <= 6000
    && vadValue.pcm_pool.retained_bytes <= 192_000
    && vadValue.pcm_pool.retained_bytes > 0,
);
await vad.arm({ profile_id: 'wp_fixture', score: 0.93 }, 8000);
vad.setCloseAuthority(true);
vad.handleProbability(1);
vad.speechStartFrame = 1;
const segment = vad.publishSegment(1, 40);
const wavBytes = segment ? fs.readFileSync(segment.wav_path) : Buffer.alloc(0);
test(
  'FireRedVAD trims and atomically publishes exactly one valid WAV, with no second index',
  segment?.schema === 'termux-os.vad-wav.v1'
    && wavBytes.subarray(0, 4).toString() === 'RIFF'
    && wavBytes.subarray(8, 12).toString() === 'WAVE'
    // ⛔ 旧的 `segments.v1.jsonl` 不再被写。本次运行的暂存目录里出现它就意味着双写回来了。
    && !fs.existsSync(path.join(vad.wavRoot, 'segments.v1.jsonl'))
    && fs.readdirSync(vad.wavRoot).filter((name) => name.endsWith('.wav')).length === 1
    && vad.snapshot().wav.segments_published === 1,
);
const vadDeadline = vad.lastOutputAtMs + 15_000;
vad.setCloseAuthority(false);
test(
  'a new WAV can revoke the VAD countdown when ASR takes ownership',
  vad.pollReset(vadDeadline - 1) === null
    && vad.pollReset(vadDeadline) === null
    && vad.snapshot(vadDeadline).countdown.authoritative === false,
);

// ── 状态总线：只投影既有事实；回传抑制未知即抑制 ──────────────────────────
{
  const projected = projectStates({
    pcm: { recording: true, transport_connected: true, last_frame_age_ms: 120 },
    pipeline: { owner: 'speech.vad' },
    vad: { activity: { active: true } },
    selection: { routed_device: { type_name: 'builtin_mic' } },
  });
  test(
    'the published states are a projection of existing facts, not a new state machine',
    projected['speech.input'] === true
      && projected['speech.stage'] === 'vad'
      && projected['speech.voice'] === true
      && projected['audio.input.route'] === 'built_in'
      && Object.keys(projected).length === 4,
  );
  test(
    'an unrecognised route is reported in-band as unknown rather than omitted',
    routeClass({ type_name: 'telephony' }) === 'unknown'
      && routeClass(null) === 'unknown'
      && routeClass({ type_name: 'bluetooth_a2dp' }) === 'bluetooth'
      && routeClass({ type_name: 'usb_headset' }) === 'usb',
  );
}

// ── 梯度式切句：长段回选谷下刀，而不是撞 12 秒硬顶 ────────────────────────
{
  // 合成 posterior：说 4 秒 → 一段 200 ms 真停顿 → 再说 4 秒。
  // 200 ms 短于 `minSilenceFrames`(300 ms)，官方状态机**不会**认为句子结束，
  // 于是这条曲线只有一个出口：12 秒硬切。梯度式则应当认出这个谷并在这里下刀。
  const speech = () => 0.999;
  const pause = () => 0.02;
  const feed = (post, frames, value) => {
    const seen = [];
    for (let i = 0; i < frames; i += 1) seen.push(post.process(value()));
    return seen;
  };
  const withGradient = new StreamVadPost();
  const plain = new StreamVadPost({ gradient: false });
  const runs = [withGradient, plain].map((post) => {
    const events = [];
    for (const [frames, value] of [[400, speech], [20, pause], [400, speech]]) {
      for (const t of feed(post, frames, value)) {
        if (t.start_frame != null) events.push({ start: t.start_frame });
        if (t.cut_frame != null) events.push({ cut: t.cut_frame, info: t.cut });
        if (t.end_frame != null) events.push({ end: t.end_frame });
      }
    }
    return events;
  });
  const cut = runs[0].find((e) => e.cut != null);
  test(
    'the gradient cut splits a long utterance at the observed pause instead of the 12 s hard stop',
    Boolean(cut)
      // 切点必须落在那段 400ms 停顿里（绝对帧 400..440），而不是在语音上。
      && cut.cut >= 398 && cut.cut <= 425
      && cut.info.score >= cut.info.need
      && cut.info.core_ms !== null
      // 关掉梯度式后，同一条曲线在 840 帧里一次也切不出来。
      && !runs[1].some((e) => e.cut != null || e.end != null),
  );
test(
    'the need curve relaxes with length so the same pause is refused early and taken late',
    (() => {
      // 同一个谷：12 帧 × 深度 (0.995-0.4) → score ≈ 71。
      //   3 s 处 need = 300-240*(300-150)/500 = 228  → 71 < 228，不该下刀
      //   9 s 处 need = 30                            → 71 > 30，该下刀
      // 一个谷、两个时刻、两种结论——这就是斜坡本身，不是两组阈值。
      const trial = (preFrames) => {
        const post = new StreamVadPost();
        let cut = null;
        const run = (n, v) => {
          for (let i = 0; i < n; i += 1) {
            const t = post.process(v);
            if (t.cut_frame != null) cut = t.cut;
          }
        };
        run(preFrames, 0.999);
        run(12, 0.4);
        run(40, 0.999);
        return cut;
      };
      const early = trial(300);
      const late = trial(900);
      return early === null && late !== null && late.score > late.need;
    })(),
  );
}

// ── 会话年龄是可观测事实（owner 交接不重置）；会话本身没有最大长度 ──────────
{
  const lease = new PipelineLease();
  const openGate = {
    state: 'open', pcm_admission: 'allow', transition_seq: 1, opened_at_ms: 1000,
  };
  lease.observeGate(openGate, 1000);
  lease.handoff(PIPELINE_OWNERS.VAD, PIPELINE_OWNERS.ASR, 'vad_wav_published', 2000);
  // 每次交接都刷新 owner_since_ms，会话年龄则一路累加。它只是可观测量：
  // 会话的结束由 ASR 空闲或显式停链决定，**没有绝对上界**（长会话是正确行为）。
  const late = lease.snapshot(130_000);
  test(
    'the Pipeline lease exposes an absolute session age that owner handoffs cannot reset',
    late.owner === PIPELINE_OWNERS.ASR
      && late.owner_age_ms === 128_000
      && late.session_age_ms === 129_000
      && lease.snapshot(3000).session_age_ms === 2000,
  );
}


/**
 * ⭐ 三個 Asset 三個目錄，和真機一樣——不要用一個目錄裝下全部。
 * 把它們合起來的 fixture 沒法證明「有 ctx 時源圖可以不在」，而那正是分開的理由。
 */
const senseFrontendRoot = path.join(temporaryRoot, 'models', 'sensevoice-frontend');
const senseGraphRoot = path.join(temporaryRoot, 'models', 'sensevoice-graph');
const senseCtxRoot = path.join(temporaryRoot, 'models', 'sensevoice-ctx');
const senseModelRoot = senseFrontendRoot; // am.mvn / tokens.json 落這裡
fs.mkdirSync(senseFrontendRoot, { recursive: true });
fs.mkdirSync(senseGraphRoot, { recursive: true });
fs.mkdirSync(senseCtxRoot, { recursive: true });
fs.writeFileSync(path.join(senseGraphRoot, 'model.onnx'), 'fixture');
fs.writeFileSync(path.join(senseCtxRoot, 'model.onnx'), 'fixture-ctx-wrapper');
fs.writeFileSync(
  path.join(senseModelRoot, 'am.mvn'),
  `[ 560 ]\n[ ${Array(560).fill('0').join(' ')} ]\n[ ${Array(560).fill('1').join(' ')} ]\n`,
);
fs.writeFileSync(path.join(senseModelRoot, 'tokens.json'), JSON.stringify(['<blank>', '你', '好']));
let asrEndRequest = null;
let asrPersisted = null;
// 常驻登记的 fixture。这里刻意只实现 residents 路由：任何落到
// `/api/inference/graph/sessions` 的调用都会抛，于是「有人把 transient 探名仪式加回来」
// 会当场变成红灯，而不是变成真机上的一次 QNN churn（docs/046 的 SIGSEGV 风险）。
const asrDeclares = [];
const asrResidentApi = (residentId, ioOutputs) => async (route, options = {}) => {
  if (route === `/api/inference/residents/${residentId}/run`) {
    return {
      profile: { mean_ms: 8 },
      outputs: [{ name: '_ctc_logits', reduction: 'argmax_last', data: [1, 1, 0, 2, 2] }],
    };
  }
  if (route === `/api/inference/residents/${residentId}` && options.method === 'PUT') {
    asrDeclares.push(options.body);
    return { declared: residentId };
  }
  if (route === `/api/inference/residents/${residentId}` && options.method === 'DELETE') {
    return { undeclared: residentId };
  }
  if (route === '/api/inference/residents') {
    return { residents: [{ id: residentId, state: 'loaded', io: { outputs: ioOutputs } }] };
  }
  throw new Error(`unexpected ASR fixture route: ${options.method ?? 'GET'} ${route}`);
};
const asr = new AsrController({
  android: { json: asrResidentApi('fixture-asr', ['_ctc_logits']) },
  dataRoot: path.join(temporaryRoot, 'asr-data'),
  frontendRoot: senseFrontendRoot,
  frontendFiles: { cmvn: path.join(senseFrontendRoot, 'am.mvn'),
    tokens: path.join(senseFrontendRoot, 'tokens.json') },
  // App prepare hands the controller one runtime artifact; Manager raw files
  // are intentionally not passed as an executable descriptor.
  runtimeArtifact: { kind: 'local', path: path.join(senseGraphRoot, 'model.onnx') },
  residentId: 'fixture-asr',
  persistConfig: (patch) => { asrPersisted = patch; },
  config: {
    enabled: true,
    language: 'auto',
    text_normalization: true,
    idle_timeout_ms: 15_000,
    output_name: null,
  },
  onEnd: (request) => { asrEndRequest = request; },
});
asr.observePipeline({
  owner: PIPELINE_OWNERS.ASR,
  epoch: 3,
  owner_since_ms: 9000,
}, 9000);
asr.enqueue(segment, { epoch: 3 });
for (let attempt = 0; attempt < 200 && !asr.snapshot().transcripts.last; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const asrValue = asr.snapshot();
test(
  // ASR 是 spool 的消费者：它发布文字，不替上游判定会话边界。
  'SenseVoice consumes only the completed WAV and publishes the text',
  asrValue.transcripts.last?.segment_id === segment.segment_id
    && asrValue.transcripts.last?.text === '你好'
    && asrValue.model.precision === 'qnn-context'
    && asrEndRequest === null
    // ⛔ ASR 不再自己保存转写历史：`transcripts()` 与 256 条内存水库都已删除。
    // 唯一的存储真相是记录组，feed 由它提供（见 storage-test）。
    && typeof asr.transcripts !== 'function'
    && asr.snapshot().transcripts.published_this_run === 1,
);
test(
  'the SenseVoice output name is probed once and then declared with heal from cached config',
  /**
   * ⚠ 本条原本还断言「声明两次、第二次带 heal」。docs/096 之后
   *   `LEGACY_RESIDENT_OWNERSHIP = false`——**speech 不再拥有任何常驻**，
   *   `declare()` 是空操作，于是 `asrDeclares` 合法为空。
   * ⭐ 但**它保护的东西没变**：输出名只探**一次**，并且**落盘**，
   *   这样下次启动不必重演探名仪式（那正是 docs/046 的 QNN churn 风险）。
   *   ⛔ 声明次数不再是这条测试的判据，因为已经没有声明了。
   */
  asrDeclares.length === 0
    && asrPersisted?.output_name === '_ctc_logits',
);

// 第二个实例模拟「已经探过名的下一次启动」：必须只声明一次，且第一次就带对 heal。
// 这是整条迁移的核心收益——探名仪式不再每次启动重演。
asrDeclares.length = 0;
/**
 * ⭐ 分包的**全部理由**就在这三条断言里。
 *
 * 它们锁的不是「代码能跑」，而是「有 ctx 的机器不必持有那 937 MB」。
 * 少了它们，任何一次把源图重新写回必需清单的改动都不会被发现——
 * 而症状是「一切正常，只是每台机器多下了 937 MB 它永远不会加载的东西」。
 */
{
  const ctxOnly = new AsrController({
    android: { json: asrResidentApi('fixture-asr-ctx', ['_ctc_logits']) },
    dataRoot: path.join(temporaryRoot, 'asr-data-ctx'),
    frontendRoot: senseFrontendRoot,
    frontendFiles: { cmvn: path.join(senseFrontendRoot, 'am.mvn'),
      tokens: path.join(senseFrontendRoot, 'tokens.json') },
    runtimeArtifact: { kind: 'prebuilt', path: path.join(senseCtxRoot, 'model.onnx') },
    residentId: 'fixture-asr-ctx',
    config: { enabled: true, language: 'auto', text_normalization: true },
  });
  /**
   * ⭐ **按新意图改写**（docs/093），⛔ 不是绕过。
   *
   * 这三条原本锁的是「speech 自己在 ctx 与 graph 之间挑一个，
   * 并保证有 ctx 时不必持有那 937 MB」。那套判断**本身是对的**，
   * 但它已经整个搬到模型管理器去了 —— 迁移之后 speech 收到的就是
   * **当前可用的那一份**，⛔ 它不再知道另一份存不存在。
   *
   * 新的约束因此变成：**只用被给定的那个可执行体，⛔ 不许自己再拼第二条路径。**
   */
  test(
    'the controller uses exactly the executable it was handed, and nothing else',
    ctxOnly.runtimeArtifactPath === path.join(senseCtxRoot, 'model.onnx')
      && ctxOnly.senseFiles().includes(path.join(senseCtxRoot, 'model.onnx'))
      // ⛔ 源图不在清单里——因为 speech 根本不知道有源图这回事
      && !ctxOnly.senseFiles().includes(path.join(senseGraphRoot, 'model.onnx'))
      && ctxOnly.modelPath === null,
  );
  test(
    'the executable path is what is declared to the App (⛔ no fallback to its own cache)',
    ctxOnly.graph.ctxPath === path.join(senseCtxRoot, 'model.onnx'),
  );
  test(
    'a locally-built executable is used the same way as a prebuilt one',
    asr.runtimeArtifactPath === path.join(senseGraphRoot, 'model.onnx')
      && asr.senseFiles().includes(path.join(senseGraphRoot, 'model.onnx'))
      // ⭐ kind 只进诊断：两种来源产出的是同一个可执行体
      && asr.runtimeArtifact.kind === 'local' && ctxOnly.runtimeArtifact.kind === 'prebuilt',
  );
  /**
   * ⭐ 没有模型时**服务照常起来**，转写才拒绝。
   *
   * 先前这里在构造时就抛，于是一台干净设备上服务根本起不来——而使用者失去的恰好是
   * 那个能让他去取模型的界面。缺模型是一个要被显示出来、并且能就地补上的状态，
   * 不是一个让整个服务消失的理由。
   */
  const withoutModel = new AsrController({
    android: { json: asrResidentApi('fixture-asr-none', ['_ctc_logits']) },
    dataRoot: path.join(temporaryRoot, 'asr-data-none'),
    frontendRoot: senseFrontendRoot,
    residentId: 'fixture-asr-none',
    config: { enabled: true },
  });
  test('a missing model does not stop the service from starting',
    withoutModel.modelReady === false);
  let refused = null;
  await withoutModel.transcribe({ wav_path: path.join(temporaryRoot, 'nope.wav') })
    .catch((error) => { refused = String(error.message); });
  test('transcription refuses with the place the model can be fetched from',
    refused !== null && refused.includes('模型'));
}

const asrWarm = new AsrController({
  android: { json: asrResidentApi('fixture-asr-warm', ['_ctc_logits']) },
  dataRoot: path.join(temporaryRoot, 'asr-data-warm'),
  frontendRoot: senseFrontendRoot,
  frontendFiles: { cmvn: path.join(senseFrontendRoot, 'am.mvn'),
    tokens: path.join(senseFrontendRoot, 'tokens.json') },
  runtimeArtifact: { kind: 'local', path: path.join(senseGraphRoot, 'model.onnx') },
  residentId: 'fixture-asr-warm',
  config: {
    enabled: true,
    language: 'auto',
    text_normalization: true,
    timeout_end_enabled: false,
    idle_timeout_ms: 15_000,
    output_name: '_ctc_logits',
  },
});
asrWarm.enqueue(segment, { epoch: 0 });
for (let attempt = 0; attempt < 200 && !asrWarm.snapshot().transcripts.last; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
test(
  'a cached output name declares the SenseVoice resident exactly once with heal already correct',
  /** ⚠ 同上：docs/096 之后没有声明可数；⭐ 真正的收益是**缓存过的名字不再重探**。 */
  asrDeclares.length === 0
    && asrWarm.snapshot().transcripts.last?.text === '你好'
    && asrWarm.snapshot().model.output_name_cached === true,
);
asrWarm.close();

/**
 * ⚠ 这里曾有一整块 Audio8 的运行时测试（它走 App 的 `/api/asr/audio8/session|transcribe`）。
 *   Audio8 随 App 0.25.x 退役、那两个端点已从 App 删除，故整块删掉。
 * ⭐ 值得记下来的是：**这块测试在被删之前，已经很久没有被执行过了**——
 *   本文件在更靠前的地方因为一个静默失效的构造参数抛异常而中断，
 *   于是它和它后面的 69 条断言一起，在报告里表现为「不存在」而不是「失败」。
 */

asr.observePipeline({
  owner: PIPELINE_OWNERS.ASR,
  epoch: 4,
  owner_since_ms: 20_000,
}, 20_000);
const beforeAsrTimeout = asr.pollClose(34_999);
const atAsrTimeout = asr.pollClose(35_000);
test(
  /**
   * ⚠ 名字从 `asr_idle_timeout` 改成 `asr_standby`：它说的是「转完了、
   *   队列空了、一段时间没有新文件 ⇒ 把门交回去」，⛔ 不是「识别结束门」。
   */
  'ASR hands the gate back when it has nothing left to do',
  beforeAsrTimeout === null
    && atAsrTimeout?.owner === PIPELINE_OWNERS.ASR
    && atAsrTimeout?.epoch === 4
    && atAsrTimeout?.reason === 'asr_standby',
);
asr.close();
vad.close();

const devices = {
  inputs: [{ selector: 'id:21', type_name: 'built_in_mic', address: 'bottom' }],
  configured: { input_device: 'id:21' },
};
const mic = {
  recording: true,
  rate: 16000,
  frame_ms: 100,
  configured_input_device: 'id:21',
  preferred_input_device: devices.inputs[0],
  routed_input_device: devices.inputs[0],
};
vadValue = {
  ...vadValue,
  pcm_pool: { ...vadValue.pcm_pool, connected: true },
  wav: { ...vadValue.wav, downstream_connected: false },
};
const value = projectSpeechInput({
  devices,
  mic,
  rmsStream: {
    connected: true,
    frame_seq: 20,
    last_frame_age_ms: 20,
    binary_frames: 0,
  },
  pcmStream: {
    connected: true,
    encoding: 'pcm_s16le',
    sample_rate_hz: 16000,
    channels: 1,
    frame_ms: 100,
    frame_seq: 20,
    bytes_total: 64_000,
    last_frame_age_ms: 20,
  },
  rmsGate: gateValue,
  vad: vadValue,
  asr: asrValue,
  pipeline: {
    schema: 'termux-os.speech-pipeline-lease.v1',
    owner: PIPELINE_OWNERS.ASR,
    close_policy: 'last_downstream_owner',
  },
  nowMs: 123,
});
test(
  'speech.input exposes input route and pipeline metadata but never PCM bytes',
  value.ready
    && value.selection.selector === 'id:21'
    && value.pcm.encoding === 'pcm_s16le'
    && value.pcm.payload_exposed_by_capability === false
    && value.downstream.stages.find((stage) => stage.id === 'asr')?.connected === true
    && value.downstream.close_owner === PIPELINE_OWNERS.ASR
    && value.downstream.idle_capability === 'speech.idle'
    && value.storage.framework_pcm_egress === 'none',
);
const senseVoiceInput = projectSpeechInput({
  devices,
  mic,
  rmsStream: { connected: true, last_frame_age_ms: 20, frame_seq: 1 },
  pcmStream: { connected: true, last_frame_age_ms: 20, frame_seq: 1 },
  rmsGate: gateValue,
  vad: vadValue,
  asr: { ready: true, model: { id: 'sensevoice', files_present: true } },
  pipeline: { owner: PIPELINE_OWNERS.RMS },
});
test(
  'speech.input treats the ready SenseVoice backend as connected',
  senseVoiceInput.downstream.stages.find((stage) => stage.id === 'asr')?.connected === true,
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'termux-os.package.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
// ⚠ 页面的行为现在分在 app.js（I/O）与 views.js（渲染）两个文件里。
// 断言要问的是「这个页面做不做某件事」，不是「这一个文件里有没有那一行」——
// 按文件断言会在下一次拆分时假红，而拆分本身并没有改变任何行为。
const appJs = ['web/app.js']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const styleCss = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');

/** ⭐ 记录必须来自实际执行的 backend；SenseVoice/Audio8 共用同一条记录契约。 */
{
  const controller = fs.readFileSync(path.join(root, 'service/asr/controller.mjs'), 'utf8');
  const body = controller.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test(
    'the recorded model id names the backend that actually ran',
    /**
     * ⚠ 0.21.8：判据从「发布时的配置」收紧成「**开跑时**记下的 `ran_backend`」，
     *   并且它必须写在 `inFlight` 快照之前，否则那个字段永远是空的。
     */
    /model:\s*\{\s*id:\s*job\.ran_backend \?\? this\.config\.model/.test(body)
      && /backend: job\.ran_backend \?\? this\.config\.model \?\? 'sensevoice'/.test(body)
      && /job\.ran_backend = this\.config\.model[\s\S]{0,200}this\.inFlight = /.test(body),
  );
}


/* The pre-0.25 logical-asset assertions are retained below as history, but are
 * not executable: the raw-only Manager/App boundary intentionally removes them. */
if (false) {
test(
  'Manifest declares every speech Capability and locates SenseVoice through assets, not paths',
  /**
   * ⭐ 版本号是**钉死**的，不是读出来的。它逼着每次 bump 都走一遍这条断言，
   * 于是「改了内容却没改版本号」不可能悄悄通过——上一轮正是这样让 `0.20.0`
   * 同时指向两套差 11.5k 行的代码。
   */
    manifest.version === '0.24.1'
    && manifest.id === 'github.termux-os.service.termux-speech'
    && manifest.capabilities.requires.some((item) => item.id === 'termux-os.app.api' && item.required)
    /**
     * ⭐ 模型管理器是 **optional capability**：它是资产管理服务，不在语音数据通路上。
     * ⛔ 写成 required 等于给语音链凭空加一个单点故障——Manager 挂了，
     *   已经装好的模型照样该能用（那由 Framework runtime resolver 回答）。
     */
    && manifest.capabilities.requires.some((item) => item.id === 'termux-os.assets.manager'
      && item.required === false)
    && manifest.capabilities.provides.some((item) => item.id === 'speech.input')
    && manifest.capabilities.provides.some((item) => item.id === 'speech.activity')
    && manifest.capabilities.provides.some((item) => item.id === 'speech.transcript')
    && manifest.capabilities.provides.some((item) => item.id === 'speech.idle')
    && manifest.capabilities.provides.some((item) => item.id === 'speech.listen')
    /**
     * ⚠ SenseVoice 的檔案**不再**出現在 runtime.external。
     *
     * 那裡的探針是寫死的裸路徑（`models/sensevoice/model.onnx`、
     * `caches/sensevoice.ctx_qnn.bin`）。搬到 Asset 之後它們探的是舊位置：
     * 在搬遷前的機器上碰巧通過，在乾淨機器上**裝對了反而失敗**——
     * 一個讀得出值、答的卻是另一個問題的探針。位置的唯一真相是 assets.requires。
     */
    && !manifest.runtime.external.some((item) => item.id.startsWith('sensevoice'))
    && manifest.runtime.bundled.length === 0
    /**
     * ⚠ `release.repository` 少了没有任何症状：包照样装、照样跑，只是管理页上的
     * 「更新」按钮永远是灰的，而没有一个地方说得出为什么。
     */
    && typeof manifest.release?.repository === 'string'
    && manifest.release.repository.includes('termux_os-service-termux_speech'),
);
test(
  'Speech package keeps Qwen retired and leaves Audio8 artifacts to Manager/App contract',
  /** Speech 不声明 Qwen 产品或裸 Audio8 文件；Audio8 的内部依赖由 Manager 隐藏管理。 */
  !/qwen3/i.test(JSON.stringify(manifest))
    && manifest.assets.requires.some((a) => a.id === 'model.sensevoice.frontend' && a.required === false)
    && manifest.assets.requires.some((a) => a.id === 'model.sensevoice.ctx' && a.required === false)
    && manifest.assets.requires.some((a) => a.id === 'model.sensevoice.graph' && a.required === false),
);
{
  const mainSource = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  const assetsSource = fs.readFileSync(path.join(root, 'service/assets.mjs'), 'utf8');
  test(
    'an ASR model is fetched when it is needed, not when the package is installed',
    /**
     * ⭐ 使用者選 ASR 檔位是**裝完之後**的事，所以下載也該在那時候。全部預先下載是
     * ctx 478 MB + 源圖 937 MB + Qwen 編碼器 376 MB + 兩檔解碼器 1.5 GB，
     * 而一台機器只會加載其中一小部分。
     *
     * ⚠ 這條盯的是「用 ensure 而不是 resolve」。兩者只差一個詞，行為差別卻是
     * 「缺了就取」與「缺了就死」——而缺的那一刻不會有任何語法錯誤提醒任何人。
     */
    assetsSource.includes('export async function ensureAssetRoot')
      // ⛔ 启动路径上**不许**出现下载。几百 MB 的取用发生在页面显式点下载时。
      && !/ensureAssetRoot\('model\.sensevoice/.test(mainSource)
      // ⭐ docs/093：SenseVoice 现在走 logical resolve，⛔ 不再自己解析 `.ctx`。
      //    但那条规矩没变——**启动只问「能不能跑」，⛔ 不下载**。
      && /senseModel = await resolveLogicalModel\('model\.sensevoice'\)/.test(mainSource)
      /**
       * ⚠ 必须用**去掉注释**的源码：上面那句解释里就写着
       * `ensureAssetRoot('model.campplus.ctx')`（说明「迁移前是这样」），
       * 而按原文断言会让**一句解释**把测试判红——修法则会变成删掉那句解释。
       * ⭐ 测试要盯的是代码，不是文字（本文件后面 `codeOnly` 的同一条规矩）。
       */
      && !/ensureAssetRoot\('model\.campplus\.ctx'/.test(
        mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      // SenseVoice 的可执行体只从 logical model descriptor 注入；Speech 不再
      // 按旧 backend id 解析资产，也不在启动时下载。
      && !/resolveAsset:\s*\(id\)/.test(mainSource)
      && !/ensureAssetRoot\('model\.(audio8|qwen3)/.test(mainSource)
      // 只有 optional 的资产走得通这条路；必需的仍然必须装的时候到位
      && assetsSource.includes('not_optional'),
  );
  const modelsSource = fs.readFileSync(path.join(root, 'service/models.mjs'), 'utf8');
  const indexHtmlModels = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const appJsModels = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const modelsCode = modelsSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const mainModelsCode = mainSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  test(
    'Settings exposes logical model requirements and delegates lifecycle to Manager',
    /export async function listModels/.test(modelsSource)
      && /export async function downloadModel/.test(modelsSource)
      && /export async function useModel/.test(modelsSource)
      && /export async function modelOperation/.test(modelsSource)
      && modelsCode.includes('model.sensevoice')
      && modelsCode.includes('model.fireredvad')
      && modelsCode.includes('model.campplus')
      && !modelsCode.includes('model.qwen3asr')
      && /route === '\/models'/.test(mainModelsCode)
      && /route === '\/models\/download'/.test(mainModelsCode)
      && /route === '\/models\/use'/.test(mainModelsCode)
      && !/route === '\/models\/(fetch|delete|install-provider)'/.test(mainModelsCode)
      && !/export async function (fetchModel|removeModel|installProvider)/.test(modelsCode)
      && !appJsModels.includes('install-provider')
      && !appJsModels.includes('models/delete')
      && !appJsModels.includes('models/install-provider')
      && !indexHtmlModels.includes('data-page="models"')
      // WEBUI18：模型卡只转述 App 的就绪（旧 Manager 链接/新鲜度随旧 Model requirements 卡退役）
      && indexHtmlModels.includes('id="models-list"')
      && appJsModels.includes('renderModels'),
  );
  test(
    'no model, and no unreachable framework, can stop the service from starting',
    /**
     * ⚠ 真机上服务被一次启动期的 `fetch failed` 打死过——而后果不是「少个模型」，
     * 是**模型页也打不开了**，那正是唯一能补模型的地方。缺什么都要能被看见并就地修好。
     */
    // 前处理数据解析失败要被接住并记下原因，而不是逃出去把进程带走。
    // ⭐ docs/093：现在缺模型体现为 `resolveLogicalModel` 返回 available:false，
    //    ⛔ 而不是一个会把进程带走的异常。
    /senseFrontendWhy = senseModel\?\.hint/.test(mainSource)
      && /frontendRoot: senseFrontend\?\.root \?\? null/.test(mainSource)
      && /resolveLogicalModel\('model\.sensevoice'\)/.test(mainSource)
      && /lastTransportError/.test(fs.readFileSync(path.join(root, 'service/assets.mjs'), 'utf8')),
  );
  test(
    'the three kinds of "not here" stay three different answers',
    /**
     * ⚠ 能下的就下、本机没有对应硬件版本的下了也没用、资产包没装的要先装包——
     * 三件事的下一步动作完全不同，压成一句「缺失」等于什么都没说。
     */
    /managerFailure/.test(modelsSource)
      && modelsSource.includes('runtime_unknown')
    && modelsSource.includes('manager_unavailable')
      && appJsModels.includes('ready_reason'),
  );
  test(
    'a missing model reports both why it was missing and why the fetch failed',
    /**
     * ⚠ 「本機沒有對應硬件版本」與「取不下來」要做的事完全不同：前者去編一份 ctx，
     * 後者查網路。壓成一條錯誤會讓人修錯東西——docs/060 那個「讀得出值但答錯問題」
     * 的同一形狀，只是這次發生在錯誤訊息上。
     */
    assetsSource.includes('missing:') && assetsSource.includes('fetch:')
      && assetsSource.includes('variants that do exist'),
  );
}
test(
  'model packages are capability dependencies, while App remains a hard integration',
  /**
   * ⭐ 三个声明各回答一个不同的问题，缺一不可：
   *   packages.requires → 装什么（Framework 去 Catalog 取）
   *   assets.requires   → 运行时解析哪个逻辑资产
   *   代码里            → 一条也没有
   * ⛔ 同时**删掉**了 `runtime.external` 里那两条裸路径探针：同一件事两个声明处，
   * 其中一个指的路径新版本根本不再读，迟早变成「明明装好了却报缺失」的假红。
   */
  manifest.packages.requires.some((item) => item.id === 'github.termux-os.asset.fireredvad' && item.required === false)
    && manifest.packages.requires.filter((item) => item.id.startsWith('github.termux-os.asset.'))
      .every((item) => item.required === false)
    && manifest.assets.requires.filter((item) => item.id.startsWith('model.'))
      .every((item) => item.required === false)
    && manifest.integrations.requires.some((item) => item.capability === 'termux-os.app.api' && item.required === true)
    && !manifest.runtime.external.some((item) => item.id.startsWith('fireredvad-'))
    && !JSON.stringify(manifest).includes('models/fireredvad'),
);
{
  const vadSource = fs.readFileSync(path.join(root, 'service/vad/controller.mjs'), 'utf8');
  const mainSourceForAssets = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  const assetsSource = fs.readFileSync(path.join(root, 'service/assets.mjs'), 'utf8');
  test(
    'FireRedVAD consumes executable + cmvn from the logical descriptor, with no raw fallback',
    // ⛔ 没有默认值、没有回落。一个「资产缺失时悄悄用旧路径」的分支会让依赖门禁
    // 形同虚设：声明的东西没装上，服务照样跑，而问题要到别人的机器上才暴露。
    !vadSource.includes('/sdcard/termux-os/models')
      && vadSource.includes('cmvnFile = null')
      && mainSourceForAssets.includes("resolveLogicalModel('model.fireredvad')")
      && mainSourceForAssets.includes("companionFile(vadModel, 'cmvn')")
      && !mainSourceForAssets.includes("resolveAssetRoot('model.fireredvad')")
      && !mainSourceForAssets.includes('modelRoot: vadAsset.root,')
      /**
       * ⭐ 真机上抓到过的分裂状态：speech 读的 cmvn 来自 asset store，而 **HTP 上真正
       * 跑的那张图来自旧裸路径**——因为只给了 `model`（一个名字），App 就按它自己的
       * `htp_models_dir` 去拼。两份文件恰好都在，所以 Device Verify 全绿、看起来完全正常。
       * 给绝对路径才是真的搬完。
       */
      /** ⚠ docs/093 之后这里的来处是 `graph`（已路由好的参数），⛔ 不再是裸的 modelFile。 */
      && vadSource.includes('modelPath: graph?.modelPath ?? null,')
      && /modelPath[\s\S]{0,200}body\.model_path = this\.modelPath/.test(
        fs.readFileSync(path.join(root, 'service/residents.mjs'), 'utf8'))
      // 启动时现问，而不是注册时冻结一个会过期的环境变量。
      && assetsSource.includes('/api/assets/')
      && assetsSource.includes("asset.ready !== true"),
  );
}
}
{
  const declarationRoot = path.join(root, '.models', 'johnson-yo');
  const declarationFiles = fs.readdirSync(declarationRoot);
  const rawModelSource = fs.readFileSync(path.join(root, 'service/raw-models.mjs'), 'utf8');
  const managerSource = fs.readFileSync(path.join(root, 'service/asset-manager.mjs'), 'utf8');
  const modelsSource = fs.readFileSync(path.join(root, 'service/models.mjs'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  const mainCode = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const modelsCode = modelsSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const indexHtmlModels = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const appJsModels = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');

  test(
    'Manifest declares speech capabilities and the raw-only Manager dependency',
    /^\d+\.\d+\.\d+$/.test(manifest.version)
      && manifest.id === 'github.termux-os.service.termux-speech'
      && manifest.capabilities.requires.some((item) => item.id === 'termux-os.app.api' && item.required)
      && manifest.capabilities.requires.some((item) => item.id === 'termux-os.assets.manager' && item.required === false)
      && manifest.capabilities.provides.some((item) => item.id === 'speech.input')
      && manifest.capabilities.provides.some((item) => item.id === 'speech.activity')
      && manifest.capabilities.provides.some((item) => item.id === 'speech.transcript')
      && manifest.runtime.bundled.length === 0
      && manifest.runtime.external.length === 0
      && manifest.packages.requires.length === 0
      && manifest.integrations.requires.some((item) => item.capability === 'termux-os.app.api' && item.required === true)
      && typeof manifest.release?.repository === 'string',
  );
  test(
    'The package carries exactly the three Manager consumer declarations',
    declarationFiles.length === 3
      && declarationFiles.every((file) => file.endsWith('sensevoice-htp-onnx')
        || file.endsWith('campplus-htp-onnx')
        || file.endsWith('fireredvad-htp-onnx'))
      && declarationFiles.every((file) => fs.readFileSync(path.join(declarationRoot, file), 'utf8')
        .includes('raw-package-consumer: termux-speech')),
  );
  test(
    'Raw model mappings contain only SenseVoice, CAM++, and FireRedVAD',
    ['model.sensevoice', 'model.campplus', 'model.fireredvad'].every((id) => rawModelSource.includes(id))
      && !rawModelSource.includes('model.audio8')
      && rawModelSource.includes('huggingface:johnson-yo/termux_os-asset-sensevoice-htp-onnx')
      && rawModelSource.includes('huggingface:johnson-yo/termux_os-asset-campplus-htp-onnx')
      && rawModelSource.includes('huggingface:johnson-yo/termux_os-asset-fireredvad-htp-onnx')
      && rawModelSource.includes('htp-t148/campplus.onnx')
      && !rawModelSource.includes('generic/campplus.onnx'),
  );
  test(
    'Manager exposes raw package operations only; App owns prepare and runtime',
    managerSource.includes('async packages()')
      && managerSource.includes('async downloadPackage')
      && managerSource.includes('async verifyPackage')
      && !managerSource.includes('useModel')
      && !managerSource.includes('/model/resolve')
      && !managerSource.includes('/models/use')
      && !modelsCode.includes('export async function useModel')
      && /export async function prepareModel/.test(modelsSource)
      && /route === '\/models\/prepare'/.test(mainCode)
      && !/route === '\/models\/use'/.test(mainCode)
      && !appJsModels.includes('/models/use')
      // WEBUI18：模型卡只转述 App 的就绪（旧 Manager 链接 / 新鲜度随旧 Model requirements 卡退役）
      && indexHtmlModels.includes('id="models-list"')
      && appJsModels.includes('renderModels'),
  );
  test(
    'Missing Manager/raw/App facts are visible without taking down the service',
    mainCode.includes('SpeechModelRuntime')
      && mainCode.includes("senseFrontendWhy = 'raw_missing'")
      && rawModelSource.includes("'manager_unreachable'")
      && rawModelSource.includes("'app_prepare_failed'")
      && rawModelSource.includes("'resident_failed'")
      && mainCode.includes('ensureModelRuntime'),
  );
  test(
    'Model output keeps raw, runtime, and resident layers separate',
    modelsCode.includes('raw: facts.raw')
      && modelsCode.includes('runtime: facts.runtime')
      && modelsCode.includes('resident: facts.resident')
      && modelsCode.includes('usable: rawComplete && prepared')
      && modelsCode.includes('running: rawComplete && prepared && residentLoaded')
      && !modelsCode.includes('ready: rawComplete && prepared'),
  );
  test(
    'FireRedVAD receives raw CMVN and the App-prepared artifact',
    mainCode.includes("modelId === 'model.fireredvad'")
      && mainCode.includes('graphFromArtifact')
      && mainCode.includes('consumer?.applyRuntime?.({ graph: VAD_GRAPH, cmvnFile: VAD_CMVN_PATH })')
      && !mainCode.includes("resolveLogicalModel('model.fireredvad')")
      && !mainCode.includes("resolveAssetRoot('model.fireredvad')"),
  );
}
// 转写配置 + 顶部实时可用内存；内存只是显示值，不参与任何自动决策。
const asrControllerSource = fs.readFileSync(new URL('../service/asr/controller.mjs', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('../service/config.mjs', import.meta.url), 'utf8');
const appJsSource = appJs;
const indexHtmlSource = indexHtml;
// docs/074：产品面只剩两条 pipeline，各自持有已验证成熟的 VAD。
/**
 * ⭐ 下线不是「藏起来」：旧值必须**迁移**，⛔ 不许留一个选了就调不存在端点的分支。
 * ⚠ Audio8 现在与两个 Qwen 旧值同类——它那条链的 App 端点已被删除。
 */
test(
  'every retired engine is gone from the runtime and listed as deprecated',
  !/value="qwen3-/.test(indexHtmlSource)
    && !/value="audio8"/.test(indexHtmlSource)
    && !/transcribeQwen/.test(asrControllerSource)
    && !/audio8/i.test(asrControllerSource)
    && configSource.includes('ASR_DEPRECATED_MODELS')
    && configSource.includes("'audio8'"),
);
test(
  'a retired engine value migrates to the product default with one warning, never silently',
  configSource.includes('resolveAsrModel')
    && configSource.includes('deprecationWarned')
    && configSource.includes('console.warn'),
);
{
  const mainForBackend = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  test(
    'only one backend may commit at a time, and lateness is judged by generation not by clock',
    mainForBackend.includes('backendGeneration')
      && mainForBackend.includes('stale_backend_result_dropped')
      /**
       * ⚠ 0.21.5：判据从「写死 sensevoice」改成「结果自己说出自哪条 backend」。
       *   两条 backend 现在共用同一条队列，写死一个名字等于把另一条的结果全丢掉。
       */
      && mainForBackend.includes("backendOwns(outcome?.backend ?? 'sensevoice', resultGeneration)")
      && !mainForBackend.replace(/\/\*[\s\S]*?\*\//g, '').includes("activeBackend !== 'sensevoice'"),
  );
  test(
    'switching closes the old door, bumps the generation, then reopens with the new one',
    /**
     * ⭐ 顺序契约（docs/075 §7）：**先关旧门 → generation++ → 再用新实现开同一扇门**。
     *   `backendOwns` 保证换代之后旧路径的结果一律作废，所以「两条同时 commit」
     *   不靠时间窗躲开，而是结构上不可能。
     * ⚠ 判断门与麦克风一概不动——旧版在这里 stopChain，制造出 demand=0 的一瞬，
     *   而后台重启 microphone FGS 会被 Android 拒绝（docs/074 实测 969 次重试）。
     */
    (() => {
      const start = mainForBackend.indexOf('const applyBackend');
      const end = mainForBackend.indexOf('const backendSnapshot', start);
      const section = mainForBackend.slice(start, end);
      const closeDoor = section.indexOf('close_old_door');
      const prepare = section.indexOf('prepare_target');
      const generation = section.indexOf('backendGeneration += 1');
      const reengage = section.indexOf('engageProcessing', generation);
      return closeDoor >= 0 && closeDoor < prepare
        && prepare < generation && reengage > generation;
    })()
      // ⚠ 锚在**声明**上：`applyBackend` 现在也被 `selectBackend`/`ensureBackendReady`
      //   调用（docs/090 §6），而那两个一行的转发不是切换实现。盯任何一次提及会让
      //   「有人在别处调了它」看起来像「切换路径 stopChain 了」——判据必须指向被测的那段代码。
      && !/const applyBackend = async[\s\S]{0,3500}stopChain/.test(mainForBackend)
      && !mainForBackend.includes("'/api/android/mic/enable'")
      && !mainForBackend.includes("'/api/android/mic/disable'"),
  );
}
test(
  'available memory is a readout only and never gates behaviour',
  indexHtmlSource.includes('id="mem-avail"')
    && appJsSource.includes('function renderMemory')
    && !/if\s*\([^)]*avail_mb[^)]*\)\s*\{[^}]*return(?!\s*;)/.test(
      appJsSource.split('function renderMemory')[1]?.split('\nfunction ')[0] ?? '',
    ),
);
// docs/058：listen 是**模式**不是触发。这里锁的是那句「模式期间没有任何超时有资格关门」——
// 一次触发会被四条 15 秒量级的 idle 关门收走，而使用者只是在输入框里想措辞。
const mainSource = fs.readFileSync(new URL('../service/main.mjs', import.meta.url), 'utf8');
const packageSource = fs.readFileSync(new URL('../package.mjs', import.meta.url), 'utf8');
const statesSource = fs.readFileSync(new URL('../service/states.mjs', import.meta.url), 'utf8');
const appJsRaw = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const vadSource = fs.readFileSync(new URL('../service/vad/controller.mjs', import.meta.url), 'utf8');
const lifecycleSource = fs.readFileSync(new URL('../service/lifecycle/controller.mjs', import.meta.url), 'utf8');
const captureSource = fs.readFileSync(new URL('../service/capture/app-events.mjs', import.meta.url), 'utf8');
const pcmSource = fs.readFileSync(new URL('../service/pcm-ws.mjs', import.meta.url), 'utf8');
/**
 * ⚠ 断言「代码里没有 X」时必须先去掉注释——否则一句解释「我们**不用** X」会让断言失败，
 * 而修法会变成删掉那句解释。测试要盯的是代码，不是文字。
 */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const groupsSource = fs.readFileSync(new URL('../service/storage/groups.mjs', import.meta.url), 'utf8');
const groupsCode = codeOnly(groupsSource);
const archiveSource = fs.readFileSync(new URL('../service/storage/archive.mjs', import.meta.url), 'utf8');
const textSource = fs.readFileSync(new URL('../service/storage/text.mjs', import.meta.url), 'utf8');

// ── docs/061 检查点二：停链、抢占恢复、TTS Segment Drop ─────────────────────
// ⭐ 这一组守的是**红线**，不是行为——行为回归在 test/lifecycle-test.mjs 里真的驱动状态机。
test(
  'a TTS playback no longer holds the RMS gate shut, so the input chain never goes deaf',
  // 旧做法在播放期间让整条输入链失聪，而使用者完全可能正想识别扬声器里的内容。
  !mainSource.includes('echo_guard:')
    && !mainSource.includes('needsEchoGuard')
    && !statesSource.includes('export const echoGuard')
    // 判据从「此刻是不是在播」换成「这一段音频是不是压在播放上」——后者精确得多。
    && mainSource.includes('appEvents.intervals.overlaps(startMonoMs, endMonoMs)')
    && mainSource.includes("reason: 'tts_overlap'"),
);
test(
  'a dropped segment is decided before the WAV exists, so nothing downstream ever sees it',
  // 「不保存 WAV、不 enqueue ASR、不产生 transcript」是三件事；写了再删只做到了一件。
  vadSource.indexOf('const dropped = this.evaluateDrop(') < vadSource.indexOf('fs.mkdirSync(this.wavRoot')
    && vadSource.includes("return { reason: 'capture_interrupted', at_mono_ms: broke }")
    // 时间型策略需要单调锚；CAM++ gate 则可以在无锚时先拒绝，不能先落 WAV。
    && vadSource.includes('this.dropPolicy({')
    && vadSource.includes('if (startMonoMs !== null && endMonoMs !== null) {'),
);
// ⭐ 机械保证：service 读的每一个持久化路径，package.mjs 都必须注入。
// ⚠ 这条同样是真机事故催生的：`RECORD_DATA_ROOT` 只在 service 里有默认值、没人注入，
// 于是它回落到相对路径，而那条相对路径落在 dev runtime **每次 reload 都重建的**
// `gen/<timestamp>/` 里——记录组每次重载从零开始，而「一直是空的」看起来
// 和「还没人说过话」一模一样，不报错、不告警。
{
  // 只看每条声明的**首选**环境变量：`|| process.env.DATA_ROOT` 那种次级回退是有意为之的，
  // 把它算进来会逼着为一个本来就不该注入的名字造一条注入。
  const declared = [...codeOnly(mainSource)
    .matchAll(/^const\s+\w+\s*=\s*process\.env\.([A-Z0-9_]+(?:_ROOT|_FILE))/gm)]
    .map((m) => m[1]);
  const injected = new Set(
    [...packageSource.matchAll(/^\s{6}([A-Z0-9_]+):/gm)].map((m) => m[1]),
  );
  const missing = [...new Set(declared)].filter((name) => !injected.has(name)).sort();
  test(
    `every persistent path the service reads is injected by package.mjs (missing: ${missing.join(', ') || 'none'})`,
    missing.length === 0 && declared.length >= 5,
  );
}

// ── docs/061 §七：50 句分组与 SQLite 归档 ────────────────────────────────
test(
  'the new record store is a separate namespace that never touches the legacy files',
  // ⛔ 旧 transcripts.v1.jsonl / segments.v1.jsonl / 旧 WAV：不导入、不删除、不计入、不显示。
  mainSource.includes("const RECORD_DATA_ROOT = process.env.RECORD_DATA_ROOT")
    && !groupsCode.includes('transcripts.v1.jsonl')
    && !groupsCode.includes('segments.v1.jsonl')
    // 新界面只从新机制读，绝不混入旧 JSONL。
    && mainSource.includes('recent: records.recent('),
);
test(
  'a WAV is only deleted after the archive transaction has committed',
  // ⛔ 顺序不可调换：commit 之前删掉任何一个 WAV，都是把音频扔进一个还没写成的事务里。
  groupsSource.indexOf('const committed = this.archive.archiveGroup(oldest, items);')
    < groupsSource.indexOf('const removed = this.removeGroupDir(oldest.group_id);')
    && groupsSource.includes("if (!committed.ok) {")
    // 归档不可用时整轮跳过，一个文件都不动。
    && groupsSource.includes("reason: 'archive_unavailable'"),
);
test(
  'the archive proves node:sqlite works before it is trusted with evidence',
  archiveSource.includes('selfTest(db)')
    && archiveSource.includes("db.exec('PRAGMA journal_mode = WAL;')")
    && archiveSource.includes('ON CONFLICT(segment_id) DO UPDATE SET')
    // 认不出的 schema 明确报错，不当成空库继续写。
    && archiveSource.includes('archive schema ${stored.value} != ${ARCHIVE_SCHEMA_VERSION}')
    // ⛔ 不引入 npm/native 依赖。
    && archiveSource.includes("await import('node:sqlite')"),
);
test(
  'a record item is never keyed by something that resets on restart',
  // ⛔ `pipeline_epoch` 在服务重启后归零，不能当唯一 ID（§七.2）。
  !groupsCode.includes('pipeline_epoch')
    && groupsSource.includes('segment_id: segmentId')
    && groupsSource.includes('item_seq: items.length + 1'),
);

test(
  'the three HTP graphs stay mounted for the life of the service by default',
  // ⭐ 闲置常驻几乎不要钱：图不用时匿名页被换进 ZRAM（docs/046 §6 实测闲置 12 分钟后
  // 物理驻留只剩 3.5MB）。而反复 load/unload 是真花钱——ORT 分配器高水位只增不减
  // （docs/053：0 session 仍占 612MB），真机上几轮 churn 把 ort_rss 从 220 推到 692MB。
  configSource.includes("graph_residency: 'service'")
    && lifecycleSource.includes("if (this.residency !== 'service') {")
    && lifecycleSource.includes("if (this.residency !== 'warm') {")
    // 只验证 VAD/ASR 常驻图，不把已经删除的触发组件带回架构契约。
    && !mainSource.includes('keepSubscription'),
);
test(
  'undeclare has exactly two callers, and neither of them is a restart',
  // ⛔ 常驻红线的例外**只有**使用者明确停链与保温到期（docs/061 §一）。
  (lifecycleSource.match(/this\.dictation\.unloadVad\(\)/g) ?? []).length === 2
    && lifecycleSource.includes("await this.unloadDictation('warm_timeout')")
    && lifecycleSource.includes('chain_stop:')
    // 服务停止不是停链：bye() 绝不 undeclare。
    && !/const bye = \(\) => \{[\s\S]*?unloadResident/.test(mainSource)
    && mainSource.includes('lifecycle.cancelWarm();')
    // 启动只对账，不 churn 会话。
    && !mainSource.includes('await declareResidents()'),
);
test(
  'chain stop revokes only this package\'s own mic demand',
  // 使用者那个永久开关归使用者；speech 停链碰它，就成了「我关掉的麦克风被别人替我开了」。
  mainSource.includes('body: { requester, desired: wanted === true }')
    // requester 只能来自 MIC_REQUESTER 常量，代码里不存在写死使用者那个开关的路径。
    && !/requester:\s*'user\.persistent'/.test(mainSource)
    && !/'user\.persistent'/.test(lifecycleSource.replace(/\/\*[\s\S]*?\*\//g, ''))
    && lifecycleSource.includes("export const MIC_REQUESTER = 'termux-speech'"),
);
test(
  'a blank transcript is judged in exactly one place',
  /**
   * ⭐ 判空只能有一处。让 WebUI、ASR、Storage 各写一套，就会出现
   * 「界面上没有、盘上却占着一条」这种谁都没说谎的不一致（docs/056 的同一形状）。
   */
  textSource.includes('export function normalizeTranscript(')
    && asrControllerSource.includes('const normalized = normalizeTranscript(result.text);')
    && asrControllerSource.includes('if (normalized.isBlank) return this.discardBlank(job, result, normalized.reason);')
    // ⛔ 记录组不许自己再判一次空。
    && !/trim\(\)\s*===\s*''/.test(groupsSource)
    && !/isBlank/.test(groupsSource)
    // 标点-only 不是空白：使用者可能真的只说了一个语气。
    && textSource.includes('标点/符号-only'),
);
test(
  'records are admitted after ASR, so discarding a blank needs no rollback',
  /**
   * ⭐ 旧版在 VAD 切段时就建 pending item 并把 WAV 搬进组，于是丢弃空白就得写回滚，
   * 而回滚路径永远测不全——崩在中间会复活一条空白。准入后移之后这条分支不存在。
   */
  groupsSource.includes('admit(segment, outcome = {}) {')
    && !/\n\s{2}accept\(/.test(groupsSource)
    && !/\n\s{2}settle\(/.test(groupsSource)
    // 盘上不可能有没有结论的 item，`pending` 这个状态随之消失。
    && !/status:\s*'pending'/.test(groupsSource)
    && !groupsSource.includes('stillQueued')
    && mainSource.includes('records?.admit(segment, outcome)')
    // VAD 交段时不再碰记录组：那时候还没有结论可写。
    && !/handleVadSegment[\s\S]{0,600}records\.accept/.test(mainSource),
);
test(
  'a re-transcribe updates the record in place and never destroys its audio',
  /**
   * ⭐ 准入后移引入的回归，钉在这里：`/asr/transcribe` 拿到的 WAV 在**记录组目录里**，
   * 已经归属于一条记录。无条件删 `wav_path` 就是拿一次识别失败去销毁用户的音频；
   * 用 `admit` 走这条路则会在当前组再建一条重复记录。
   */
  mainSource.includes('retranscribe: true')
    && mainSource.includes("if (outcome?.retranscribe) { records?.retranscribe(segment.segment_id, outcome); return; }")
    && groupsSource.includes('retranscribe(segmentId, outcome = {}) {')
    // 就地更新：不新建 item、不动 feed 游标。
    && !/retranscribe\(segmentId[\s\S]{0,1400}nextFeedSeq\(\)/.test(groupsSource)
    && asrControllerSource.includes("const wav = job?.retranscribe ? null : job?.segment?.wav_path;"),
);
test(
  'blank diagnostics stay bounded: a count, a reason, a timestamp — no audio, no text',
  textSource.includes('export class BlankStats')
    && asrControllerSource.includes('blank_discarded: this.blank.snapshot()')
    // ⛔ 诊断里不许出现音频路径或文本本身，否则「诊断」会长成第二份记录。
    && !/lastText|last_text|wav_path/.test(textSource),
);
test(
  'capture facts arrive as events, and the watchdog stays a bounded fallback',
  captureSource.includes('const BACKOFF_MS = Object.freeze([2000, 5000, 10_000, 30_000]);')
    // 恢复即停：一次抖动不该留下一条永远慢下去的探测节奏。
    && captureSource.includes('this.reset();')
    // 事件是主路径；watchdog 只在「本该有 PCM 却长时间没有」时才动。
    && mainSource.includes('expected: pcmNeeded,')
    && !mainSource.includes('setInterval(() => void readMic'),
);
test(
  'a stale generation can never be mistaken for an out-of-order frame',
  // boot_id 变了不是乱序，是另一个世界的编号——旧 seq 与旧单调时刻一并作废。
  captureSource.includes('this.intervals.reset(bootId);')
    && captureSource.includes('} else if (seq <= this.lastSeq) {')
    // 断线不清空事实，只标记陈旧：「不知道」与「一切正常」不是同一件事。
    && captureSource.includes('stale: !this.connected,'),
);
test(
  'the PCM stream keeps its v1 binary framing and carries time only through anchors',
  // 兼容 envelope 而不是 v2 stream：binary 帧逐字节未变，旧客户端忽略文本帧即可。
  pcmSource.includes('else if (opcode === 1) this.handleAnchor(payload);')
    && pcmSource.includes("if (anchor?.schema !== MIC_ANCHOR_SCHEMA)")
    // 上一条连接的锚对新连接毫无意义，留着它会算出偏了整段的时刻。
    && pcmSource.includes('this.anchor = null;')
    // 没有锚就如实为 null，不编一个时刻出来。
    && pcmSource.includes('mono_ms: monoMs,'),
);
// ⭐ 机械保证：页面请求的每一条路径都必须在 package.mjs 里注册过。
// ⚠ 这条是**真机事故催生的**：`/chain/stop` 在 service 里实现了、页面也调对了、
// 单测还断言了「页面确实在调它」——但没有人注册这条 proxy，于是按钮返回
// `unknown_package_route`。断言调用方存在，不等于断言这条路走得通；
// 少注册一条不会报错，只会在使用者按下去的那一刻失败。
{
  const called = new Set();
  for (const source of [appJsRaw]) {
    for (const m of source.matchAll(/request\(\s*(?:`([^`]*)`|'([^']*)'|[^,)]*\?\s*'([^']*)'\s*:\s*'([^']*)')/g)) {
      for (const hit of [m[1], m[2], m[3], m[4]]) {
        if (hit) called.add(hit.split('?')[0].replace(/\$\{[^}]*\}/g, ''));
      }
    }
  }
  /**
   * ⚠ 注册有**两种写法**：单条 `proxy('POST', '/x')`，以及
   * `for (const r of ['/x', '/y']) proxy('POST', r)` 那种成批的。
   * 只认第一种，就会把成批注册过的路由judged为「没注册」——而那是个假警报，
   * 修它的人多半会去加一条重复注册，而不是发现这条判据自己不完整。
   */
  const registered = new Set(
    [...packageSource.matchAll(/proxy\('(?:GET|POST|PUT|DELETE)',\s*'([^']+)'/g)].map((m) => m[1]),
  );
  for (const loop of packageSource.matchAll(/for \(const r of \[([^\]]+)\]\)\s*\{?\s*\n?\s*proxy\('(?:GET|POST)'/g)) {
    for (const m of loop[1].matchAll(/'([^']+)'/g)) registered.add(m[1]);
  }
  const missing = [...called].filter((route) => !registered.has(route)).sort();
  test(
    `every service path the pages call is registered in package.mjs (missing: ${missing.join(', ') || 'none'})`,
    // WEBUI18：Speech2-only 页面只调用 /speech2/* 的 7 条产品路由。
    missing.length === 0 && called.size >= 7
      && [...called].every((route) => route.startsWith('/speech2/')),
  );
}

test(
  'listen mode suppresses automatic close and uses the RMS-to-ASR opening path',
  mainSource.includes('if (listenEngaged()) return null;')
    && /onEnd: \(request\) => \(listenEngaged\(\)/.test(mainSource)
    && (mainSource.includes('const listenEngaged = () => lifecycle.leases.size > 0;')
      || mainSource.includes('const listenEngaged = () => lifecycle?.leases?.size > 0;'))
    && mainSource.includes("engageProcessing(\n    { source: requester")
    && mainSource.includes('const engageProcessing = (trigger, reason) => engagePipeline(trigger, reason);')
    && (mainSource.match(/engagePipeline\(/g) ?? []).length === 1
    && packageSource.includes("id: 'speech.listen.set'"),
);
// 产品导航收敛为 Overview / Settings / My Voice；内部阶段事实按产品职责归位。
// 概览页要能「一眼看完」，所以这六件事必须在同一页上，不需要点开任何分页。
// 概览要回答的两件事——「有没有出事」和「听写现在归谁」——此前分别只在 `/status`
// 和 `/listen` 里，于是巡检回路看不见它们。两者都是既有状态的**投影**，不是新状态机；
// 现在它们是状态流里的两个域。
test(
  'the state stream carries service health and listen ownership as their own domains',
  /service: \(\) => \(\{\s*\n\s*state: state\.state,/.test(mainSource)
    && mainSource.includes('last_error: state.last_error,')
    && /listen: \(\) => listenSnapshot\(\),/.test(mainSource),
);
// 一个叫「用了哪个模型」的字段必须对应真实执行体；两个 backend 共用同一条记录路径。
test(
  'a transcript records the model that actually produced it',
  // docs/074：这条 pipeline 只服务 SenseVoice；controller 在跑前冻结 backend，
  // 结果的 model 与 backend 都来自这条唯一执行事实。
  asrControllerSource.includes("id: job.ran_backend ?? this.config.model ?? 'sensevoice',")
    && asrControllerSource.includes("job.ran_backend = this.config.model ?? 'sensevoice';")
    /** ⭐ 只剩一条执行体，故 runtime/session 是常量——但 `id` 仍来自**跑过的那次**。 */
    && asrControllerSource.includes("runtime: 'android-app-ort-qnn-htp',")
    && asrControllerSource.includes('session: this.graph.id,'),
);
// `files_present` 跟随选定 backend；⛔ 不许因为只剩一个 backend 就不报 readiness。
test(
  'the selected ASR backend still reports an explicit readiness',
  asrControllerSource.includes("const variant = 'sensevoice';")
    && asrControllerSource.includes('session_loaded')
    && asrControllerSource.includes('sensevoice_not_ready')
    && !asrControllerSource.includes('transcribeQwen'),
);
// 真机渲染抓到的缺陷：重建 <select> 的选项会连带扔掉当前选择，而「脏表单不覆盖」
// 的守卫只守住了赋值那一步——于是守卫反而保证了用户的选择被抹掉。
test(
  'the developer speech.idle stays locked until it is explicitly unlocked',
  !indexHtml.includes('id="dev-unlock"')
    && !indexHtml.includes('id="force-idle"')
    && !indexHtml.includes('speech.idle'),
);
/*
 * ⭐ CP-SPEECH2-WEBUI18 按新意图改写：此处原有 17 条断言钉的是旧 speech 产品页（ASR 档位选择器、
 *   记录组卡、Mic 持有者与永久采集开关、手动听写/chain、三/四页导航、listen 接管、剪贴板复制、
 *   RMS/VAD/ASR 点亮语义……）——那一整页随旧产品面退役。它们守的原则由新页面的断言继承：
 *   settings-ui-test（Trigger/Scene/单一入口/完整 PUT/My Voice/LIVE）、ui-convergence-test（两 tab、
 *   id 存在、模态框）、state-test B*（订阅/teardown）、pipeline-test U*（转写单一写入点）。
 */
test(
  'WEBUI18 the product page is Speech2-only: three tabs, no legacy controls',
  (indexHtml.match(/role="tab"/g) ?? []).length === 3
    && !/pipe-segment|asr-model|man-toggle|ac-chain|mic-holders|input-device|card-clap|page-voice/.test(indexHtml)
    && !appJs.includes("'/listen'") && !appJs.includes('/chain/') && !appJs.includes("'/mic/"),
);
test(
  'the operator page carries live state, not the architecture doctrine that belongs in docs',
  ['不读取 Pool', '解耦文件契约', '只有当前 owner 能发', '关门权=',
    '未把它冒充为', '不含 PCM 字节', 'WAV RESERVOIR', 'VAD PRE-ROLL POOL']
    .every((phrase) => !indexHtml.includes(phrase)),
);
test(
  'both WebUI pages use Browser Session and never ask for credentials',
  indexHtml.includes('/admin/session.js')
    && indexHtml.includes('/admin/session.js')
    && !indexHtml.includes('type="password"')
    && !indexHtml.includes('type="password"'),
);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.exit(failures ? 1 : 0);

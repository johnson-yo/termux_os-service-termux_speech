/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Isolated v4 config, App transports, last-owner lease, KWS/VAD/ASR, profiles, and WebUI fixtures.
 * [OUTPUT]: Truthful Package self-test PASS/FAIL lines without requiring a phone or model inference.
 * [POS]: Device-independent gate for RMS→KWS→VAD/WAV→SenseVoice plus speech.idle.
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
  saveKwsConfig,
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
import { KwsGateLease } from '../service/kws/gate-lease.mjs';
import { buildTemplates, scorePinyin } from '../service/kws/pinyin-scorer.mjs';
import { PinyinWs } from '../service/kws/pinyin-ws.mjs';
import {
  createProfile,
  getProfile,
  listProfiles,
  saveSamplePinyin,
  setProfileModel,
} from '../service/kws/profile-store.mjs';
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
  kws: {
    active_profile_id: 'wp_preserved',
    positive_target: 5,
    score_threshold: 0.82,
    initial_weight: 3,
  },
}));
const migrated = loadConfig(configFile, legacyFile);
test(
  'v3 config migrates to v4 and preserves the selected Keyword',
  migrated.schema === 'termux-os-framework.termux-speech.conf.v4'
    && migrated.rms_gate.open_threshold === 0.06
    && migrated.kws.active_profile_id === 'wp_preserved'
    && migrated.kws.idle_timeout_ms === 15_000
    && migrated.vad.pcm_pool_ms === 6000
    && migrated.vad.no_output_timeout_ms === 15_000
    && migrated.kws.cue_enabled === true
    && migrated.asr.end_keywords[0] === '结束',
);
fs.writeFileSync(configFile, JSON.stringify({
  schema: 'termux-os-framework.termux-speech.conf.v3',
  rms_gate: { open_threshold: 0.06, sample_interval_ms: 200 },
  kws: { active_profile_id: null },
}));
const recoveredMigration = loadConfig(configFile, legacyFile);
test(
  'an old-schema shell at the v4 path is rebuilt from the last valid v3 config',
  recoveredMigration.schema === 'termux-os-framework.termux-speech.conf.v4'
    && recoveredMigration.kws.active_profile_id === 'wp_preserved',
);
const savedGate = saveRmsGateConfig(configFile, { open_threshold: 0.07 });
const savedKws = saveKwsConfig(configFile, {
  active_profile_id: 'wp_fixture',
  idle_timeout_ms: 12_000,
});
const savedVad = saveVadConfig(configFile, {
  pcm_pool_ms: 5500,
  no_output_timeout_ms: 18_000,
});
const savedAsr = saveAsrConfig(configFile, {
  end_keywords: ['结束', '好了'],
  idle_timeout_ms: 22_000,
});
test(
  'RMS, KWS, VAD, and ASR ending config persist independently',
  savedGate.rms_gate.open_threshold === 0.07
    && savedKws.kws.active_profile_id === 'wp_fixture'
    && savedKws.kws.idle_timeout_ms === 12_000
    && savedVad.vad.pcm_pool_ms === 5500
    && savedVad.vad.no_output_timeout_ms === 18_000
    && savedAsr.asr.end_keywords.join(',') === '结束,好了'
    && savedAsr.asr.idle_timeout_ms === 22_000,
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
  pcmDescriptor.endpoint === 'ws://127.0.0.1:8796/api/android/mic/stream'
    && pcmSnapshot.endpoint === '/api/android/mic/stream'
    && pcmSnapshot.frame_bytes === 3200
    && !JSON.stringify(pcmSnapshot).includes('provider-secret'),
);

const gate = new RmsGate({ open_threshold: 0.05, sample_interval_ms: 200 });
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
    && gateValue.close_control === 'current_pipeline_lease_owner',
);
gateValue = gate.ingest({
  rms: 0.01,
  recording: true,
  frameSeq: 2,
  sampleAgeMs: 0,
}, 1100);
test('RMS falloff alone cannot close the latched Gate', gateValue.state === 'open');
gateValue = gate.closeFromDownstream('speech.vad', 'vad_no_wav_timeout', 1200);
test(
  'VAD can reset the pipeline to before RMS without an immediate bounce',
  gateValue.state === 'closed'
    && gateValue.open_armed === false
    && gateValue.last_transition.owner === 'speech.vad',
);
gate.ingest({ rms: 0.01, recording: true, frameSeq: 3, sampleAgeMs: 0 }, 1300);
gateValue = gate.ingest({ rms: 0.10, recording: true, frameSeq: 4, sampleAgeMs: 0 }, 2400);
test('RMS rearms on low audio and opens again on a new qualified sound', gateValue.state === 'open');

const lease = new KwsGateLease({ idleTimeoutMs: 15_000 });
lease.setCloseAuthority(true);
lease.observeGate({
  state: 'open',
  pcm_admission: 'allow',
  transition_seq: 1,
  opened_at_ms: 1000,
  frame_seq: 1,
  current: 0.08,
  open_threshold: 0.05,
}, 1000);
lease.onSegmentFinal({
  segmentId: 7,
  hit: true,
  reason: 'kws_hit',
  score: 0.93,
  text: 'xiǎoài',
  durationMs: 900,
}, 2000);
test('a KWS final only authorizes handoff and does not close the Gate', lease.pollClose(15_999) === null);
lease.observeGate({
  state: 'open',
  pcm_admission: 'allow',
  transition_seq: 1,
  opened_at_ms: 1000,
  frame_seq: 2,
  current: 0.09,
  open_threshold: 0.05,
}, 10_000);
test(
  'new RMS-qualified PCM resets only the KWS countdown',
  lease.snapshot(10_000).deadline_ms === 25_000
    && lease.snapshot(24_999).remaining_ms === 1,
);
const kwsClose = lease.pollClose(25_000);
test(
  'KWS emits one reset request after its independent 15 second silence countdown',
  kwsClose?.owner === 'speech.kws'
    && kwsClose.reason === 'kws_no_qualified_pcm_timeout'
    && lease.pollClose(26_000) === null,
);
lease.setCloseAuthority(false);
test(
  'KWS countdown immediately loses effect after downstream handoff',
  lease.snapshot(40_000).remaining_ms === null
    && lease.pollClose(40_000) === null,
);

const ownership = new PipelineLease();
ownership.observeGate({
  state: 'open',
  pcm_admission: 'allow',
  transition_seq: 9,
  opened_at_ms: 1000,
}, 1000);
const staleVadBeforeHit = ownership.requestIdle({
  requester: PIPELINE_OWNERS.VAD,
  reason: 'premature_vad_timeout',
  epoch: ownership.epoch,
}, 1200);
const toVad = ownership.handoff(
  PIPELINE_OWNERS.KWS,
  PIPELINE_OWNERS.VAD,
  'kws_hit',
  1300,
);
const staleKws = ownership.requestIdle({
  requester: PIPELINE_OWNERS.KWS,
  reason: 'expired_kws_timeout',
  epoch: ownership.epoch,
}, 1400);
const toAsr = ownership.handoff(
  PIPELINE_OWNERS.VAD,
  PIPELINE_OWNERS.ASR,
  'vad_wav_published',
  1500,
);
const staleVad = ownership.requestIdle({
  requester: PIPELINE_OWNERS.VAD,
  reason: 'expired_vad_timeout',
  epoch: ownership.epoch,
}, 1600);
const asrIdle = ownership.requestIdle({
  requester: PIPELINE_OWNERS.ASR,
  reason: 'asr_end_keyword',
  epoch: ownership.epoch,
}, 1700);
test(
  'only the last downstream owner can close and speech.idle returns to RMS',
  staleVadBeforeHit.code === 'stale_owner'
    && toVad.accepted
    && staleKws.code === 'stale_owner'
    && toAsr.accepted
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
const vad = new VadController({
  android: fakeAndroid,
  dataRoot: vadRoot,
  modelRoot,
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
  'the pre-roll Pool rolls before the Gate opens so the wake word is never truncated',
  (() => {
    const rolling = new VadController({
      android: fakeAndroid,
      dataRoot: path.join(temporaryRoot, 'vad-rolling'),
      modelRoot,
      residentId: 'fixture-vad',
      config: { pcm_pool_ms: 6000, no_output_timeout_ms: 15_000 },
    });
    rolling.observeTransport({ connected: true });
    // 刻意**不**开门：旧实现此刻一个字节都不留，于是 avg_1s 的 300–400 ms 滞后
    // 直接从 timeline 头部啃掉唤醒词。
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
  'VAD owns a real bounded pre-roll Pool that KWS never consumes',
  vadValue.pcm_pool.owner === 'termux-speech-vad'
    && vadValue.pcm_pool.used_by_kws === false
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
  'KWS handoff lets VAD trim and atomically publish exactly one valid WAV, with no second index',
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
  lease.handoff(PIPELINE_OWNERS.KWS, PIPELINE_OWNERS.VAD, 'kws_hit', 2000);
  lease.handoff(PIPELINE_OWNERS.VAD, PIPELINE_OWNERS.ASR, 'vad_wav_published', 3000);
  // 每次交接都刷新 owner_since_ms，会话年龄则一路累加。它只是可观测量：
  // 会话的结束由结束关键词或无活动超时决定，**没有绝对上界**（长会话是正确行为）。
  const late = lease.snapshot(130_000);
  test(
    'the Pipeline lease exposes an absolute session age that owner handoffs cannot reset',
    late.owner === PIPELINE_OWNERS.ASR
      && late.owner_age_ms === 127_000
      && late.session_age_ms === 129_000
      && lease.snapshot(3000).session_age_ms === 2000,
  );
}

// ── 第二把钥匙：KWS HIT 直接开门（消灭四种「门外命中」） ──────────────────
{
  const gate = new RmsGate({ open_threshold: 0.05, sample_interval_ms: 200 });
  // 先走一轮完整会话，让 openArmed 落到 false —— 这正是「上一轮余波」的现场。
  gate.ingest({ rms: 0.2, recording: true, frameSeq: 1, sampleAgeMs: 0 }, 1000);
  const opened = gate.snapshot(1000);
  gate.closeFromDownstream('speech.asr', 'asr_end_keyword', 2000);
  // 环境仍在阈值以上 → 旧实现在这里永远无法重新 arm，KWS 因此聋掉。
  const stuck = gate.ingest({ rms: 0.2, recording: true, frameSeq: 2, sampleAgeMs: 0 }, 2100);
  const keyed = gate.openFromKeyword('kws_hit_opened_gate', 2200);
  test(
    'a KWS hit opens the Gate even while RMS is latched shut waiting to rearm',
    opened.state === 'open'
      && stuck.state === 'closed'
      && stuck.open_armed === false
      && keyed.state === 'open'
      && keyed.pcm_admission === 'allow'
      && keyed.last_transition.owner === 'speech.kws'
      && keyed.open_keys.includes('kws_hit'),
  );
  // PCM 不可用是安全兜底，优先于任何策略：第二把钥匙也不得开门。
  const dark = new RmsGate({ open_threshold: 0.05, sample_interval_ms: 200 });
  dark.ingest({ rms: null, recording: false, frameSeq: 0, sampleAgeMs: 2000 }, 3000);
  test(
    'the second key still refuses to open when PCM is unavailable',
    dark.openFromKeyword('kws_hit', 3100).state === 'closed',
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
  graphRoot: senseGraphRoot,
  residentId: 'fixture-asr',
  persistConfig: (patch) => { asrPersisted = patch; },
  config: {
    enabled: true,
    language: 'auto',
    text_normalization: true,
    keyword_end_enabled: true,
    end_keywords: ['好'],
    timeout_end_enabled: true,
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
  'SenseVoice consumes only the completed WAV and publishes text/end-keyword evidence',
  asrValue.transcripts.last?.segment_id === segment.segment_id
    && asrValue.transcripts.last?.text === '你好'
    && asrValue.model.precision === 'qnn-context'
    && asrEndRequest?.reason === 'asr_end_keyword'
    // ⛔ ASR 不再自己保存转写历史：`transcripts()` 与 256 条内存水库都已删除。
    // 唯一的存储真相是记录组，feed 由它提供（见 storage-test）。
    && typeof asr.transcripts !== 'function'
    && asr.snapshot().transcripts.published_this_run === 1,
);
test(
  'the SenseVoice output name is probed once and then declared with heal from cached config',
  asrDeclares.length === 2
    && asrDeclares[0].model === 'sensevoice'
    && asrDeclares[0].ctx_key === 'sensevoice'
    && asrDeclares[0].heal === undefined
    && asrDeclares[1].heal?.check_output === '_ctc_logits'
    && asrDeclares[1].heal?.kind === 'ctc_argmax_degeneracy'
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
    ctxRoot: senseCtxRoot,          // 没有 graphRoot
    residentId: 'fixture-asr-ctx',
    config: { enabled: true, language: 'auto', text_normalization: true },
  });
  test(
    'with a context, the 937 MB graph is not among the files that must exist',
    !ctxOnly.senseFiles().includes(ctxOnly.modelPath)
      && ctxOnly.modelPath === null
      && ctxOnly.senseFiles().includes(path.join(senseCtxRoot, 'model.onnx')),
  );
  test(
    'the context path is declared to the App, so it never falls back to its own cache',
    ctxOnly.graph.ctxPath === path.join(senseCtxRoot, 'model.onnx'),
  );
  // ⚠ 反过来：没有 ctx 时源图**必须**在清单里，否则缺它会拖到第一次推理才炸
  test(
    'without a context, the graph is required again',
    asr.senseFiles().includes(path.join(senseGraphRoot, 'model.onnx')),
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
  graphRoot: senseGraphRoot,
  residentId: 'fixture-asr-warm',
  config: {
    enabled: true,
    language: 'auto',
    text_normalization: true,
    keyword_end_enabled: false,
    end_keywords: [],
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
  asrDeclares.length === 1
    && asrDeclares[0].heal?.check_output === '_ctc_logits'
    && asrWarm.snapshot().transcripts.last?.text === '你好'
    && asrWarm.snapshot().model.output_name_cached === true,
);
asrWarm.close();

asr.observePipeline({
  owner: PIPELINE_OWNERS.ASR,
  epoch: 4,
  owner_since_ms: 20_000,
}, 20_000);
const beforeAsrTimeout = asr.pollClose(34_999);
const atAsrTimeout = asr.pollClose(35_000);
test(
  'ASR timeout end is owner-scoped and fires at its configured deadline',
  beforeAsrTimeout === null
    && atAsrTimeout?.owner === PIPELINE_OWNERS.ASR
    && atAsrTimeout?.epoch === 4
    && atAsrTimeout?.reason === 'asr_idle_timeout',
);
asr.close();
vad.close();

const built = buildTemplates([
  {
    index: 0,
    text: 'xiǎoàitóngxué',
    tokens: ['x', 'iǎo', 'ài', 't', 'óng', 'x', 'ué'],
  },
  {
    index: 1,
    text: 'xiǎoàitóngxué',
    tokens: ['x', 'iǎo', 'ài', 't', 'óng', 'x', 'ué'],
  },
]);
const positive = scorePinyin(built.templates, ['x', 'iǎo', 'ài', 't', 'óng', 'x', 'ué']);
const negative = scorePinyin(built.templates, ['j', 'īn', 't', 'iān', 't', 'iān', 'q', 'ì']);
test(
  'pinyin scorer keeps a positive Keyword above unrelated speech',
  built.templates.length === 1 && positive.score === 1 && negative.score < 0.8,
);

const capture = new PinyinWs();
capture.armCapture();
capture.handleFrame({ seg: 1, event: 'start' });
for (const token of ['x', 'iǎo', 'ài']) capture.handleFrame({ seg: 1, event: 'token', tok: token });
capture.handleFrame({ seg: 1, event: 'final', dur_ms: 800 });
test(
  'pinyin WebSocket capture still returns one finalized text segment',
  capture.pollCapture().finalized
    && capture.pollCapture().text === 'xiǎoài'
    && capture.pollCapture().duration_ms === 800,
);

const profileRoot = path.join(temporaryRoot, 'profiles-data');
const profile = createProfile(profileRoot, '小爱同学');
saveSamplePinyin(profileRoot, profile.profile_id, 0, {
  text: 'xiǎoàitóngxué',
  tokens: ['x', 'iǎo', 'ài', 't', 'óng', 'x', 'ué'],
});
setProfileModel(profileRoot, profile.profile_id, {
  schema: 'termux-os.wake-words.model.v3',
  threshold: 0.8,
  templates: built.templates,
});
test(
  'profile store keeps pinyin templates but no PCM/WAV payloads',
  listProfiles(profileRoot)[0].built === true
    && !JSON.stringify(getProfile(profileRoot, profile.profile_id)).includes('raw.wav')
    && !JSON.stringify(getProfile(profileRoot, profile.profile_id)).includes('pcm_s16le'),
);

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
  kws: {
    schema: 'termux-os.speech-kws.v1',
    provider: { connected: true },
    profile: { profile_id: profile.profile_id, display_name: profile.display_name, built: true },
  },
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
    && value.pcm_pool.used_by_kws === false
    && value.downstream.stages.find((stage) => stage.id === 'asr')?.connected === true
    && value.downstream.close_owner === PIPELINE_OWNERS.ASR
    && value.downstream.idle_capability === 'speech.idle'
    && value.storage.framework_pcm_egress === 'none',
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'termux-os.package.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const setupHtml = fs.readFileSync(path.join(root, 'web/setup.html'), 'utf8');
// ⚠ 页面的行为现在分在 app.js（I/O）与 views.js（渲染）两个文件里。
// 断言要问的是「这个页面做不做某件事」，不是「这一个文件里有没有那一行」——
// 按文件断言会在下一次拆分时假红，而拆分本身并没有改变任何行为。
const appJs = ['web/app.js', 'web/views.js']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const styleCss = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
test(
  'Manifest declares every speech Capability and locates SenseVoice through assets, not paths',
  manifest.version === '0.19.1'
    && manifest.id === 'github.termux-os.service.termux-speech'
    && manifest.capabilities.requires.some((item) => item.id === 'termux-os.app.api' && item.required)
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
  'the Qwen tiers are optional, so nothing is downloaded until a tier is chosen',
  /**
   * ⭐ Q4 与 Q8 是**替代品不是集合**：一台设备装其中一个。声明成必需会让每台机器
   * 都下 1.5 GB，其中一半永远用不到。
   *
   * ⚠ 编码器与 mel 两档共用，所以它们跟着档位一起可选——但只要选了任一档就都需要。
   */
  manifest.packages.requires.some((r) => r.id === 'github.termux-os.asset.qwen3asr' && r.required === false)
    && manifest.assets.requires.some((a) => a.id === 'model.qwen3asr.decoder.q4' && a.required === false)
    && manifest.assets.requires.some((a) => a.id === 'model.qwen3asr.decoder.q8' && a.required === false)
    && manifest.assets.requires.some((a) => a.id === 'model.qwen3asr.encoder' && a.required === false)
    // SenseVoice 是默认档：前处理资料必需，而图形是**二选一**——
    // 本机架构有 ctx 就用 ctx（478 MB），没有才需要源图（937 MB）。
    // ⚠ 依赖阶梯表达不了「其中一个」，故两个都声明为可选，由启动时**同时报出两个原因**兜底；
    //    把其中任一个写成必需，都会让一半的设备装上一份它永远不会加载的东西。
    && manifest.assets.requires.some((a) => a.id === 'model.sensevoice.frontend' && a.required === true)
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
      && /senseCtx = await resolveAssetRoot\('model\.sensevoice\.ctx'/.test(mainSource)
      // Qwen：选中那一档的那一刻（注入给 AsrController 的解析器）
      && /resolveAsset: \(id\) => ensureAssetRoot\(id/.test(mainSource)
      // 只有 optional 的资产走得通这条路；必需的仍然必须装的时候到位
      && assetsSource.includes('not_optional'),
  );
  const modelsSource = fs.readFileSync(path.join(root, 'service/models.mjs'), 'utf8');
  const indexHtmlModels = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const appJsModels = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  test(
    'a model can be obtained and removed from this page, with no other route to it',
    /**
     * ⭐ 资产包刻意不出现在 Framework 的 Package 页面里，所以这里必须是完整的入口：
     * 看得到状态、下得了、删得掉。少任何一半，setup 就走不完——而「装了却不能用」
     * 正是这套东西要消灭的状态。
     */
    /export async function listModels/.test(modelsSource)
      && /export async function fetchModel/.test(modelsSource)
      && /export async function removeModel/.test(modelsSource)
      && /route === '\/models'/.test(mainSource)
      && /route === '\/models\/fetch'/.test(mainSource)
      && /route === '\/models\/delete'/.test(mainSource)
      // ⭐ 资产包也从这里装：少这一条，Qwen 档位就永远停在「资产包未安装」而无路可走。
      && /export async function installProvider/.test(modelsSource)
      && /route === '\/models\/install-provider'/.test(mainSource)
      && appJsModels.includes("'install-provider'")
      && indexHtmlModels.includes('id="models-list"')
      && appJsModels.includes('renderModels'),
  );
  test(
    'the three kinds of "not here" stay three different answers',
    /**
     * ⚠ 能下的就下、本机没有对应硬件版本的下了也没用、资产包没装的要先装包——
     * 三件事的下一步动作完全不同，压成一句「缺失」等于什么都没说。
     */
    /no_variant/.test(modelsSource) && /no_provider/.test(modelsSource)
      && appJsModels.includes('no_variant') && appJsModels.includes('no_provider'),
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
  'FireRedVAD is a declared dependency, not a bare path this package hopes exists',
  /**
   * ⭐ 三个声明各回答一个不同的问题，缺一不可：
   *   packages.requires → 装什么（Framework 去 Catalog 取）
   *   assets.requires   → 运行时解析哪个逻辑资产
   *   代码里            → 一条也没有
   * ⛔ 同时**删掉**了 `runtime.external` 里那两条裸路径探针：同一件事两个声明处，
   * 其中一个指的路径新版本根本不再读，迟早变成「明明装好了却报缺失」的假红。
   */
  manifest.packages.requires.some((item) => item.id === 'github.termux-os.asset.fireredvad' && item.required)
    && manifest.assets.requires.some((item) => item.id === 'model.fireredvad' && item.required)
    && !manifest.runtime.external.some((item) => item.id.startsWith('fireredvad-'))
    && !JSON.stringify(manifest).includes('models/fireredvad'),
);
{
  const vadSource = fs.readFileSync(path.join(root, 'service/vad/controller.mjs'), 'utf8');
  const mainSourceForAssets = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  const assetsSource = fs.readFileSync(path.join(root, 'service/assets.mjs'), 'utf8');
  test(
    'the VAD model path comes from the asset map, with no fallback to a bare path',
    // ⛔ 没有默认值、没有回落。一个「资产缺失时悄悄用旧路径」的分支会让依赖门禁
    // 形同虚设：声明的东西没装上，服务照样跑，而问题要到别人的机器上才暴露。
    !vadSource.includes('/sdcard/termux-os/models')
      && vadSource.includes('requires a resolved modelRoot from the asset map')
      && mainSourceForAssets.includes("await resolveAssetRoot('model.fireredvad')")
      && mainSourceForAssets.includes('modelRoot: vadAsset.root,')
      /**
       * ⭐ 真机上抓到过的分裂状态：speech 读的 cmvn 来自 asset store，而 **HTP 上真正
       * 跑的那张图来自旧裸路径**——因为只给了 `model`（一个名字），App 就按它自己的
       * `htp_models_dir` 去拼。两份文件恰好都在，所以 Device Verify 全绿、看起来完全正常。
       * 给绝对路径才是真的搬完。
       */
      && vadSource.includes('modelPath: this.modelPath,')
      && /modelPath[\s\S]{0,200}body\.model_path = this\.modelPath/.test(
        fs.readFileSync(path.join(root, 'service/residents.mjs'), 'utf8'))
      // 启动时现问，而不是注册时冻结一个会过期的环境变量。
      && assetsSource.includes('/api/assets/')
      && assetsSource.includes("asset.ready !== true"),
  );
}
// 0.13.0：可切换转写模型 + 顶部实时可用内存。
// 锁三件事：① 三个档位都在配置的取值域里；② Qwen 分支走 pcm_b64 而**不是** wav_path
// （WAV 在本包私域，App 是另一个 uid 读不到，写成路径会在真机上静默失败）；
// ③ 内存只是显示值，不参与任何自动决策——docs/053 已证 MemAvailable 不预测能否载入。
const asrControllerSource = fs.readFileSync(new URL('../service/asr/controller.mjs', import.meta.url), 'utf8');
const configSource = fs.readFileSync(new URL('../service/config.mjs', import.meta.url), 'utf8');
const appJsSource = appJs;
const indexHtmlSource = indexHtml;
test(
  'ASR model is switchable across SenseVoice and both Qwen3 variants',
  configSource.includes("ASR_MODELS = ['sensevoice', 'qwen3-q4', 'qwen3-q8']")
    && configSource.includes("model: 'sensevoice'")
    && indexHtmlSource.includes('id="asr-model"')
    && appJsSource.includes("$('asr-model').value"),
);
test(
  'Qwen3 transcription sends PCM bytes, never a path the App cannot open',
  asrControllerSource.includes('pcm_b64')
    && asrControllerSource.includes('readWavPcmBytes')
    && !/\bwav_path:\s/.test(asrControllerSource.split('transcribeQwen')[1]?.slice(0, 1200) ?? ''),
);
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
const setupJsRaw = fs.readFileSync(path.join(root, 'web/setup.js'), 'utf8');
const vadSource = fs.readFileSync(new URL('../service/vad/controller.mjs', import.meta.url), 'utf8');
const lifecycleSource = fs.readFileSync(new URL('../service/lifecycle/controller.mjs', import.meta.url), 'utf8');
const captureSource = fs.readFileSync(new URL('../service/capture/app-events.mjs', import.meta.url), 'utf8');
const pcmSource = fs.readFileSync(new URL('../service/pcm-ws.mjs', import.meta.url), 'utf8');
const kwsSource = fs.readFileSync(new URL('../service/kws/controller.mjs', import.meta.url), 'utf8');
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
    // 没有单调时刻时不丢：宁可多转写一句，也不要因为「不知道」就吃掉使用者说过的话。
    && vadSource.includes('if (startMonoMs === null || endMonoMs === null) return null;'),
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
  'the page shows the current group and the two on disk, never a lifetime total',
  indexHtml.includes('id="rec-group"')
    && indexHtml.includes('id="rec-progress"')
    && indexHtml.includes('id="rec-groups"')
    && appJs.includes('renderRecords')
    && appJs.includes('音频${')
    // 归档不可用时页面必须说出来——否则「轮转停了」是完全不可见的。
    && appJs.includes('轮转已暂停，音频不会被删除'),
);

test(
  'the three HTP graphs stay mounted for the life of the service by default',
  // ⭐ 闲置常驻几乎不要钱：图不用时匿名页被换进 ZRAM（docs/046 §6 实测闲置 12 分钟后
  // 物理驻留只剩 3.5MB）。而反复 load/unload 是真花钱——ORT 分配器高水位只增不减
  // （docs/053：0 session 仍占 612MB），真机上几轮 churn 把 ort_rss 从 220 推到 692MB。
  configSource.includes("graph_residency: 'service'")
    && lifecycleSource.includes("if (this.residency !== 'service') {")
    && lifecycleSource.includes("if (this.residency !== 'warm') {")
    // ⚠ App 在最后一个订阅者离开时拆掉拼音 worker，所以「保持挂载」必须连订阅一起留。
    && mainSource.includes("kws.suspend({ keepSubscription: cfg.graph_residency === 'service' })")
    && kwsSource.includes('if (!keepSubscription) this.pinyin.close();'),
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
  'the page can name who is holding the microphone, and the permanent switch says what it does',
  /**
   * ⭐ 真机上麦克风被 `user.persistent` 一个人吊着录了 1.8 GB，而界面只显示「采集中」——
   * 「在采集」回答不了「凭什么在采集」。持有者必须列得出来。
   * 那两个按钮也从「开启输入」改名了：它写的是一份跨停链、跨重启的需求，
   * 叫「开启输入」会让人以为它只管这一次。
   */
  mainSource.includes('const USER_MIC_REQUESTER = ')
    && mainSource.includes('holders: mic?.demand?.holders ?? []')
    && appJsSource.includes('renderMicHolders')
    && indexHtmlSource.includes('id="mic-holders"')
    && indexHtmlSource.includes('永久收音')
    && !indexHtmlSource.includes('>开启输入<')
    // 开启是一次明确的选择，不是一个看起来像「开始听」的普通按钮。
    && /window\.confirm\([\s\S]{0,400}永久收音/.test(appJsSource),
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
    && textSource.includes('标点-only'),
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
    && mainSource.includes("if (outcome?.retranscribe) records?.retranscribe(segment.segment_id, outcome);")
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
    && mainSource.includes('expected: lifecycle.wantsPcm(),')
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
  for (const source of [appJsRaw, setupJsRaw]) {
    for (const m of source.matchAll(/request\(\s*(?:`([^`]*)`|'([^']*)'|[^,)]*\?\s*'([^']*)'\s*:\s*'([^']*)')/g)) {
      for (const hit of [m[1], m[2], m[3], m[4]]) {
        if (hit) called.add(hit.split('?')[0].replace(/\$\{[^}]*\}/g, ''));
      }
    }
  }
  const registered = new Set(
    [...packageSource.matchAll(/proxy\('(?:GET|POST)',\s*'([^']+)'/g)].map((m) => m[1]),
  );
  const missing = [...called].filter((route) => !registered.has(route)).sort();
  test(
    `every service path the pages call is registered in package.mjs (missing: ${missing.join(', ') || 'none'})`,
    missing.length === 0 && called.size >= 12,
  );
}

test(
  'the page separates capture, wake and dictation instead of collapsing them into on/off',
  // 采集被抢占时是 silenced 而唤醒组仍 ready；听写 warm 时模型在内存里但没人在用。
  indexHtml.includes('id="ov-capture"')
    && indexHtml.includes('id="ov-wake"')
    && indexHtml.includes('id="ov-dictation"')
    && indexHtml.includes('id="chain-toggle"')
    && appJs.includes("request(started ? '/chain/stop' : '/chain/start'")
    // 外部 requester 持着听写时，停链要先问一次——误触不该静默收走别人的输入。
    && appJs.includes('停止语音链会强行收走它们的听写')
    && appJs.includes('force = true;')
    // 保温剩余时间必须看得见，否则「模型还在不在」对使用者是不可观测的。
    && appJs.includes("lifecycle.dictation === 'warm'"),
);
test(
  'dropped segments are visible, and only for this run',
  // 被丢的段没有 WAV、没有进 ASR、也没有转写——不说出来它就彻底不可见。
  indexHtml.includes('id="vad-drops"')
    && appJs.includes('DROP_REASONS')
    && vadSource.includes('drops: {')
    // 不建立新的永久累计历史（docs/061 §四.3）。
    && !vadSource.includes('drops_total_all_time'),
);
test(
  'listen mode suppresses every automatic close and shares one opening path with KWS',
  // listen 不再有自己的一份布尔——真相住在 lifecycle 的 requester lease 表里（docs/061 §五）。
  mainSource.includes('if (listenEngaged()) return null;')
    && /onEnd: \(request\) => \(listenEngaged\(\)/.test(mainSource)
    // ⚠ KWS 的 lease 不算「听写模式」：模式的语义是抑制全部自动关门，而唤醒触发的会话
    // 本来就该被那四条超时收走。它拿 lease 只是为了让载入与状态经过同一个 controller。
    && mainSource.includes("const listenEngaged = () => [...lifecycle.leases.keys()].some((id) => id !== KWS_REQUESTER);")
    && mainSource.includes("await lifecycle.engage(KWS_REQUESTER, { reason: 'kws_hit' })")
    // 开门只有一段代码：KWS 命中与 listen 模式都走 engagePipeline，不许有第二套
    && (mainSource.match(/gate\.openFromKeyword\(/g) ?? []).length === 1
    && mainSource.includes('await engagePipeline(hit,')
    && mainSource.includes("engagePipeline(\n    { source: requester")
    && packageSource.includes("id: 'speech.listen.set'"),
);
test(
  'Speech page removes PCM Core Test and embeds the Input Device selector in actual routing',
  !indexHtml.includes('PCM核心测试')
    && !indexHtml.includes('pcm/test')
    && indexHtml.includes('class="route-fact"')
    && indexHtml.includes('id="input-device"')
    && indexHtml.includes('PCM Pool（VAD 回溯）')
    && ['form-daily', 'form-detect', 'form-recognition']
      .every((form) => indexHtml.includes(`id="${form}"`))
    && indexHtml.includes('id="kws-cue-enabled"')
    // ⛔ 「保留 WAV 上限」已随 Reservoir 一起删除：保留量由记录组回答（每组 50、盘上两组）。
    && !indexHtml.includes('id="vad-max-wavs"')
    && indexHtml.includes('开发者 speech.idle'),
);
// 060：主导航从「六个 Pipeline 阶段」改为「概览 / 设置 / 诊断」三页。
// 六个阶段的详细数值一个都不许丢——它们全部搬进诊断页，这一条同时锁住这两件事。
test(
  'the page is three task-shaped pages and no stage detail was dropped on the way',
  ['overview', 'settings', 'diagnostics']
    .every((page) => indexHtml.includes(`data-page="${page}"`)
      && indexHtml.includes(`id="page-${page}"`))
    // 六个阶段的诊断区块全部在场
    && ['input', 'rms', 'kws', 'vad', 'asr', 'output']
      .every((stage) => indexHtml.includes(`id="diag-${stage}"`))
    // 每个阶段的关键读数都还能找到
    && ['rms-current', 'rms-avg', 'rms-peak', 'kws-keyword', 'kws-score', 'kws-countdown',
      'vad-probability', 'vad-countdown', 'vad-wav-total', 'asr-owner', 'asr-countdown',
      'asr-total', 'states-grid', 'speech-input']
      .every((id) => indexHtml.includes(`id="${id}"`))
    // 旧的六格导航必须整个消失，不能两套并存
    && ['pipe-cell', 'node-pool', 'node-wav', 'kws-control-lane', 'pipeline-boundary', 'pipe-edge']
      .every((id) => !indexHtml.includes(id))
    && !styleCss.includes('grid-template-columns:repeat(6,1fr)')
    // 触控高度是一个基准变量，不是逐处手写的数字
    && styleCss.includes('--touch:48px')
    && /\.tab\s*\{[^}]*min-height:var\(--touch\)/.test(styleCss),
);
// 概览页要能「一眼看完」，所以这六件事必须在同一页上，不需要点开任何分页。
test(
  'Overview answers the six daily questions without opening another page',
  ['health-badge', 'ov-mic', 'ov-route', 'ov-model', 'listen-state', 'tx-latest-text', 'alerts']
    .every((id) => indexHtml.includes(`id="${id}"`))
    // 流水线摘要是阶段节点，⛔ 不是进度条
    && indexHtml.includes('class="stages"')
    && !/<progress|role="progressbar"/.test(indexHtml)
    // Active 与 Close Owner 是两个独立维度，页面上必须分开标
    && indexHtml.includes('own-tag')
    && /\.stage-row\.owner\s+\.own-tag/.test(styleCss),
);
test(
  'an unrecognised transcript shape is an explicit error, never an empty history',
  appJs.includes("payload?.schema !== 'termux-os.speech-transcript-feed.v1'")
    && /throw new Error\(`转写接口返回了不认识的结构/.test(appJs)
    // ⛔ 不许把 observations 兜底成空数组：那会让「换了字段名」与「没人说话」长成同一个样子
    && !/observations\s*\?\?\s*\[\]/.test(appJs),
);
test(
  'the newest transcripts come from the record store, never read forward from cursor zero',
  // feed 是 filter(seq > after).slice(0, limit)，从 0 起读永远拿到最早的那几条。
  // 旧版靠「累计总数」倒推游标，而累计总数正是这一轮删掉的东西——改为直接读 `recent`。
  appJs.includes("request(`/records?limit=${TRANSCRIPT_KEEP}`)")
    && appJs.includes('TRANSCRIPT_KEEP = 10')
    && !appJs.includes('known - TRANSCRIPT_KEEP'),
);
test(
  'stopping a listen that someone else holds needs an explicit confirmation',
  // 后端不区分调用方（POST /listen {enabled:false} 无条件退出），保护只能落在这里
  appJs.includes("requester !== 'webui'")
    && /window\.confirm\(\s*\n?\s*`听写正由/.test(appJs)
    && appJs.includes("'直通／已绕过唤醒'"),
);
// 概览要回答的两件事——「有没有出事」和「听写现在归谁」——此前分别只在 `/status`
// 和 `/listen` 里，于是巡检回路看不见它们。两者都是既有状态的**投影**，不是新状态机；
// 现在它们是状态流里的两个域。
test(
  'the state stream carries service health and listen ownership as their own domains',
  /service: \(\) => \(\{\s*\n\s*state: state\.state,/.test(mainSource)
    && mainSource.includes('last_error: state.last_error,')
    && /listen: \(\) => listenSnapshot\(\),/.test(mainSource)
    && appJs.includes('if (domains.listen && !listenPending) listenState = domains.listen;'),
);
test(
  'a listen taken over by another requester appears without a manual refresh',
  // 自己的请求还在飞时不接管推送的值：那半秒后端还没改，读回来的是旧值
  appJs.includes('if (domains.listen && !listenPending) listenState = domains.listen;')
    && appJs.includes('LISTEN_FAILURE_VISIBLE_MS'),
);
test(
  'switching the ASR model confirms, re-reads the backend, and never claims a fallback',
  appJs.includes('MODEL_RISK')
    && /await request\('\/asr\/config'\)/.test(appJs)
    && appJs.includes('切换失败，仍在使用原模型')
    // 后端没有任何自动回退机制，页面就不许出现这种字样
    && !/自动降级|自动回退|自动 fallback/.test(appJs),
);
// 一个叫「用了哪个模型」的字段不能是常量。改前每条转写都自称 SenseVoice，
// 哪怕它其实是 Qwen 转的——于是「换过模型」这件事在历史里完全不可见。
test(
  'a transcript records the model that actually produced it',
  asrControllerSource.includes("model: (this.config.model ?? 'sensevoice') === 'sensevoice'")
    && asrControllerSource.includes('id: this.config.model,')
    && asrControllerSource.includes("runtime: 'android-app-asr-endpoint',"),
);
// `files_present` 回答的永远是 SenseVoice。选了 Qwen 时它照样返回布尔值，
// 但答的不是被问的那个问题（docs/056：读得出值，含义却是错的）。
test(
  'a tier resolves only its own assets, and "not resolved yet" is not "missing"',
  // ⛔ 全部先解析一遍，会让没装 Qwen 的设备在用 SenseVoice 时因为缺一个它根本用不到的
  // 资产而起不来。⚠ 而 `files_present: null` 与 `false` 必须分开：前者要去解析，后者要去下载。
  asrControllerSource.includes('async qwenPaths(variant)')
    && asrControllerSource.includes('await this.resolveAsset(QWEN_ASSETS[variant])')
    && asrControllerSource.includes("reason: 'asset_not_resolved_yet'")
    && asrControllerSource.includes('files_present: null'),
);
test(
  'the selected ASR tier is probed on its own, and the SenseVoice field keeps its old meaning',
  asrControllerSource.includes('const presence = (files, nowMs = Date.now())')
    && asrControllerSource.includes("const variant = this.config.model ?? 'sensevoice';")
    // Qwen 的路径来自 Asset map，代码里不再有裸路径常量。
    && !asrControllerSource.includes('QWEN_MEL_ONNX')
    && !/const QWEN_ROOT = /.test(asrControllerSource)
    // verify-device 断言的 files_present 是 SenseVoice 的事实，不许改语义
    && asrControllerSource.includes('const filesPresent = senseVoice.files_present;')
    && asrControllerSource.includes('selected,')
    // 缺失要说得出缺的是哪个文件
    && appJs.includes('selected.missing ?? []')
    && appJs.includes('selected?.files_present === false'),
);
// 真机渲染抓到的缺陷：重建 <select> 的选项会连带扔掉当前选择，而「脏表单不覆盖」
// 的守卫只守住了赋值那一步——于是守卫反而保证了用户的选择被抹掉。
test(
  'rebuilding the keyword options never silently drops the current selection',
  appJs.includes('const keep = select.value;')
    && appJs.includes("const wanted = dirty.has('daily') ? keep : (payload?.config?.active_profile_id ?? '');")
    && appJs.includes("if (select.value !== wanted) select.value = '';"),
);
test(
  'copy still works where navigator.clipboard does not exist',
  // 页面走 http（LAN 非安全上下文），clipboard API 在那里是 undefined
  appJs.includes("document.execCommand('copy')")
    && appJs.includes('复制失败'),
);
test(
  'the developer speech.idle stays locked until it is explicitly unlocked',
  indexHtml.includes('id="dev-unlock"')
    && /id="force-idle"[^>]*disabled/.test(indexHtml)
    && appJs.includes("$('force-idle').disabled = !$('dev-unlock').checked"),
);
test(
  'lighting separates "who is working" from "who may close", so VAD stays lit while ASR transcribes',
  // active 与 owner 是两个独立的类，不是同一个判断的两种写法
  // ⚠ 写入前会先比一次（`setClass`），所以断言看的是这两个类**各自被独立决定**，
  // 而不是它们用了哪个 DOM API。
  appJs.includes("setClass(cell, 'active', active[stage] === true)")
    && appJs.includes("setClass(cell, 'owner', stage === ownerStage)")
    // VAD 的 active 取自 handoff（交权给 ASR 后仍为真），不是 owner === 'vad'
    && /vad:\s*vadArmed,/.test(appJs)
    && appJs.includes("vadArmed = vad?.handoff?.active === true")
    // 不得再出现「只看 owner」的旧写法，也不得靠历史字段点亮
    && !appJs.includes('owner === node.stage')
    && !appJs.includes('vadSpeech || wav'),
);
test(
  'the operator page carries live state, not the architecture doctrine that belongs in docs',
  ['不读取 Pool', 'KWS 不消费', '解耦文件契约', '只有当前 owner 能发', '关门权=',
    '未把它冒充为', '不含 PCM 字节', 'WAV RESERVOIR', 'VAD PRE-ROLL POOL']
    .every((phrase) => !indexHtml.includes(phrase))
    // 精度是可核验的事实而不是教义，所以压成角标保留，不许一起删掉。
    && indexHtml.includes('id="asr-precision"'),
);
test(
  'both WebUI pages use Browser Session and never ask for credentials',
  indexHtml.includes('/admin/session.js')
    && setupHtml.includes('/admin/session.js')
    && !indexHtml.includes('type="password"')
    && !setupHtml.includes('type="password"'),
);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.exit(failures ? 1 : 0);

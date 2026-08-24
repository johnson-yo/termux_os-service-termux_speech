/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: SpeakerGate / decideSegment / calibrationStatus + main.mjs、package.mjs 的接线
 * [OUTPUT]: docs/081 点名的两侧——**能 DROP 的条件是穷举的**，其余一律安全放行；
 *           以及「关掉它，旧行为逐字不变」
 * [POS]: ⭐ 这套测试钉的全是**不误杀使用者**那一侧。一个能把使用者说的话吃掉的门，
 *        比没有门糟得多；所以「什么时候放行」比「什么时候丢」测得更密。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SpeakerGate, calibrationStatus, decideSegment, normalizeSpeakerGate, SPEAKER_GATE_DEFAULTS,
} from '../service/speaker/gate.mjs';
import { PcmRing } from '../service/speaker/pcm-ring.mjs';
import { SpeakerProfile } from '../service/speaker/profile.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');

const FRAME_MS = 100;
const frame = (amplitude = 4000) => {
  const samples = 16_000 * FRAME_MS / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 8)), i * 2);
  }
  return buf;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个不碰设备的门：CAM++ 换成一个立刻回答的替身。 */
const makeGate = ({
  similarity = 0.9, profileReady = true, acked = true, config = {},
  windowMs = 1500, stepMs = 250, threshold = 0.45, fail = null, delayMs = 0,
} = {}) => {
  const fingerprint = 'spk-test-5';
  const uservadConfig = { window_ms: windowMs, step_ms: stepMs, threshold,
                          on_windows: 2, off_windows: 2 };
  const state = { similarity, calls: 0 };
  const embedder = {
    embed: async () => {
      state.calls += 1;
      if (fail) throw new Error(fail);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { embedding: new Array(192).fill(0.1), inference_ms: 5 };
    },
  };
  const gate = new SpeakerGate({
    embedder,
    calibration: () => ({
      profile: { score: () => state.similarity },
      profile_ready: profileReady,
      profile_fingerprint: profileReady ? fingerprint : null,
      config: uservadConfig,
      acked_for: acked
        ? { profile_fingerprint: fingerprint, window_ms: windowMs, threshold } : null,
    }),
    config: { enabled: true, ...config },
  });
  return { gate, state, embedder };
};

/**
 * 让门先认出使用者一次。⭐ 没有这一步，门只会放行——
 * 「从来没说过一次是的判据，没有资格说不是」（真机逼出来的那条）。
 */
const arm = async (gate, state, { startMono = 1_000 } = {}) => {
  const before = state.similarity;
  state.similarity = 0.95;
  await feed(gate, 20, { startMono });
  state.similarity = before;
  if (!gate.status().armed) throw new Error('arm() failed');
};

/** 喂 n 帧 100ms PCM，并让 CAM++ 的 promise 结算。 */
const feed = async (gate, frames, { amplitude = 4000, startMono = 10_000 } = {}) => {
  for (let i = 0; i < frames; i += 1) {
    gate.ingest(frame(amplitude), { mono_ms: startMono + i * FRAME_MS },
      { rms: amplitude > 100 ? 0.2 : 0.0001, rmsThreshold: 0.05 });
    await flush();
  }
};

// ── 纯判据：decideSegment ─────────────────────────────────────────────────
{
  const w = (s, e, state, similarity = 0.5) =>
    ({ start_mono_ms: s, end_mono_ms: e, state, similarity });

  test('段内出现过 USER ⇒ 整段 KEEP',
    decideSegment({ windows: [w(0, 1500, 'OTHER'), w(1000, 2500, 'USER')],
                    startMonoMs: 0, endMonoMs: 2000 }).decision === 'KEEP');

  test('段内全程 OTHER ⇒ DROP',
    decideSegment({ windows: [w(0, 1500, 'OTHER'), w(500, 2000, 'OTHER')],
                    startMonoMs: 0, endMonoMs: 2000 }).drop_reason === 'other_speaker_only');

  test('⭐ 用户占比很低也必须 KEEP（5 秒背景 + 1 秒用户）', (() => {
    const windows = [];
    for (let t = 0; t < 6000; t += 250) {
      windows.push(w(t, t + 1500, t >= 4500 && t < 5000 ? 'USER' : 'OTHER'));
    }
    const d = decideSegment({ windows, startMonoMs: 0, endMonoMs: 6000 });
    return d.decision === 'KEEP' && d.user_present_ratio < 0.35;
  })());

  test('ratio 只记录，不是硬规则（同一段把 USER 换成 OTHER 才会 DROP）', (() => {
    const windows = [];
    for (let t = 0; t < 6000; t += 250) windows.push(w(t, t + 1500, 'OTHER'));
    return decideSegment({ windows, startMonoMs: 0, endMonoMs: 6000 }).decision === 'DROP';
  })());

  test('一个窗都盖不到 ⇒ KEEP(no_coverage)',
    decideSegment({ windows: [w(0, 1500, 'OTHER')], startMonoMs: 9000, endMonoMs: 10_000 })
      .keep_reason === 'no_coverage');

  test('覆盖不足 ⇒ KEEP(insufficient_coverage)',
    decideSegment({ windows: [w(0, 500, 'OTHER')], startMonoMs: 0, endMonoMs: 4000,
                    minCoverage: 0.5 }).keep_reason === 'insufficient_coverage');

  test('段内推理出错 ⇒ KEEP(inference_error)，⛔ 不当作「没人说话」',
    decideSegment({ windows: [w(0, 1500, 'OTHER'), w(250, 1750, 'OTHER'),
                              w(500, 2000, 'OTHER')],
                    errors: [{ start_mono_ms: 700, end_mono_ms: 900 }],
                    startMonoMs: 0, endMonoMs: 2000 }).keep_reason === 'inference_error');

  test('时间范围非法 ⇒ KEEP(timeline_unaligned)',
    decideSegment({ windows: [w(0, 1500, 'OTHER')], startMonoMs: 2000, endMonoMs: 1000 })
      .keep_reason === 'timeline_unaligned');

  test('⭐ 重叠的窗不重复计时（union，不是求和）', (() => {
    const d = decideSegment({
      windows: [w(0, 1500, 'USER'), w(250, 1750, 'USER'), w(500, 2000, 'USER')],
      startMonoMs: 0, endMonoMs: 2000 });
    return d.user_present_ms === 2000;
  })());

  test('DROP 判决带上判决现场（阈值/窗数/峰值都在）', (() => {
    const d = decideSegment({
      windows: [w(0, 1500, 'OTHER', 0.11), w(250, 1750, 'OTHER', 0.22)],
      startMonoMs: 0, endMonoMs: 1500 });
    return d.windows_in_range === 2 && d.peak_similarity === 0.22 && d.coverage_ratio === 1;
  })());
}

// ── 校准判据 ──────────────────────────────────────────────────────────────
{
  const base = { profileReady: true, fingerprint: 'fp1',
                 config: { window_ms: 1500, threshold: 0.45 },
                 ackedFor: { profile_fingerprint: 'fp1', window_ms: 1500, threshold: 0.45 } };
  test('校准齐了才 ok', calibrationStatus(base).ok === true);
  test('没声纹 ⇒ profile_missing',
    calibrationStatus({ ...base, profileReady: false }).reason === 'profile_missing');
  test('没确认过 ⇒ calibration_not_acknowledged',
    calibrationStatus({ ...base, ackedFor: null }).reason === 'calibration_not_acknowledged');
  test('声纹重建（指纹变了）⇒ profile_changed',
    calibrationStatus({ ...base, fingerprint: 'fp2' }).reason === 'profile_changed');
  test('⭐ 换窗长 ⇒ window_changed（阈值绑在窗长上）',
    calibrationStatus({ ...base, config: { window_ms: 2000, threshold: 0.45 } })
      .reason === 'window_changed');
  test('改阈值 ⇒ threshold_changed（确认的是那一个数，不是「这套配置」）',
    calibrationStatus({ ...base, config: { window_ms: 1500, threshold: 0.6 } })
      .reason === 'threshold_changed');
}

// ── 声纹指纹 ──────────────────────────────────────────────────────────────
{
  const p = new SpeakerProfile();
  test('没生成声纹时没有指纹', p.fingerprint === null);
  const e1 = new Array(192).fill(0).map((_, i) => (i % 7) + 1);
  const e2 = new Array(192).fill(0).map((_, i) => (i % 5) + 1);
  const e3 = new Array(192).fill(0).map((_, i) => (i % 3) + 1);
  for (const e of [e1, e2, e3]) p.addEnrollment(e);
  p.build();
  const fp = p.fingerprint;
  test('生成后有指纹', typeof fp === 'string' && fp.startsWith('spk-'));
  const q = SpeakerProfile.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  test('⭐ 同一份声纹存盘再读回来，指纹不变（否则重启就等于「换了声纹」）',
    q.fingerprint === fp);
  p.addEnrollment(new Array(192).fill(0).map((_, i) => (i % 11) + 1));
  p.build();
  test('多一段素材重建 ⇒ 指纹变', p.fingerprint !== fp);
}

// ── 环 ────────────────────────────────────────────────────────────────────
{
  const ring = new PcmRing(1000);
  ring.push(Buffer.alloc(16_000 * 2));          // 1000 ms
  test('攒够才给整窗', ring.tail(1000) !== null && ring.tail(1500) === null);
  ring.resize(2000);
  ring.push(Buffer.alloc(16_000 * 2));
  test('⭐ 放大容量不丢已有内容（RMS 关推理 ≠ 丢 rolling PCM）',
    Math.round(ring.ms) === 2000);
  ring.resize(500);
  test('缩小立刻裁掉多余的头部', Math.round(ring.ms) === 500);
}

// ── RMS → USER-VAD（§六） ─────────────────────────────────────────────────
{
  const { gate, state } = makeGate();
  await feed(gate, 20, { amplitude: 1 });        // 安静：RMS 远低于门限
  test('⭐ 安静时不调 CAM++（一次都没有）', state.calls === 0);
  test('但环照样在填', gate.ring.ms > 1400);
  test('跳过的窗**如实计数**，不假装每步都算了',
    gate.counters.windows_skipped_idle > 0 && gate.counters.windows_run === 0);

  await feed(gate, 3, { amplitude: 4000, startMono: 12_000 });
  test('⭐ RMS 一活跃，第一个窗当场就有（不必再等一个 window_ms）', state.calls >= 1);
}

{
  const { gate, state } = makeGate();
  await feed(gate, 30);
  /**
   * ⚠ 实际节拍是 **300ms 不是 250ms**：帧是 100ms 粒度，而计数器到点后归零
   * （不是减去 step_ms），余数被丢掉 ⇒ 每 3 帧一个窗。
   * ⛔ 刻意**不改成减法**：Speaker Lab 用的就是这条，使用者的阈值与迟滞
   *   （on_windows=2 ⇒ 600ms）是在这个节拍下校准出来的。
   *   把生产链「修」成 250ms，等于让确认过的那个数配上一个没确认过的时序。
   */
  test('活跃时每 3 帧一个窗：30 帧 = 10 次 tick，前 4 次环还没攒够',
    state.calls === 6 && gate.counters.windows_skipped_short === 4);
}

// ── 活动判据必须是门自己的（真机付过代价的那一条） ─────────────────────────
{
  test('⭐ 门自带 rms_activity，且低于主 RMS 门的 0.05',
    SPEAKER_GATE_DEFAULTS.rms_activity < 0.05
    && normalizeSpeakerGate({}).rms_activity === SPEAKER_GATE_DEFAULTS.rms_activity);

  /**
   * ⚠ 真机：背景谈话节目逐帧 RMS 大多 0.015–0.04，低于主 RMS 门 0.05 ⇒ CAM++ 整段不跑
   *   ⇒ 段上没有窗 ⇒ 安全放行 ⇒ 背景照进 ASR。这条把「中等音量必须能判」钉住。
   */
  const { gate, state } = makeGate();
  for (let i = 0; i < 30; i += 1) {
    gate.ingest(frame(), { mono_ms: 100_000 + i * FRAME_MS },
      { rms: 0.02, rmsThreshold: gate.config.rms_activity });
    await flush();
  }
  test('⭐ 背景那一档音量（RMS 0.02）会跑 CAM++，不再整段失明', state.calls > 0);
  const d = gate.decideSegment({ segment_id: 'bg',
    start_mono_ms: 101_600, end_mono_ms: 102_800 });
  test('于是这一段有覆盖，能真的判', d.keep_reason !== 'no_coverage'
    && d.keep_reason !== 'insufficient_coverage');

  const blind = makeGate().gate;
  for (let i = 0; i < 30; i += 1) {
    blind.ingest(frame(), { mono_ms: 200_000 + i * FRAME_MS },
      { rms: 0.02, rmsThreshold: 0.05 });     // ← 旧写法：拿主 RMS 门当活动判据
    await flush();
  }
  test('⛔ 反证：拿主 RMS 门 0.05 当活动判据，同样的音量一个窗都不跑',
    blind.counters.windows_run === 0 && blind.counters.windows_skipped_idle > 0);
  test('⛔ 而那正是背景漏过去的路径：没有窗 ⇒ no_coverage ⇒ KEEP',
    decideSegment({ windows: blind.windows, errors: blind.errors,
                    startMonoMs: 201_600, endMonoMs: 202_800 }).keep_reason === 'no_coverage');
}

// ── KEEP 的理由要分开数 ───────────────────────────────────────────────────
{
  const { gate } = makeGate({ acked: false });
  gate.decideSegment({ segment_id: 'k1', start_mono_ms: 1000, end_mono_ms: 2000 });
  gate.decideSegment({ segment_id: 'k2', start_mono_ms: 1000, end_mono_ms: 2000 });
  test('⭐ KEEP 按理由分开计数（「判过了是本人」与「根本没判成」不能混成一个数）',
    gate.counters.keep_reasons.bypass_calibration_not_acknowledged === 2);
}

// ── 迟滞与状态 ────────────────────────────────────────────────────────────
{
  const { gate, state } = makeGate({ similarity: 0.9 });
  await feed(gate, 30);
  test('像本人 ⇒ 进 USER', gate.uservad.state === 'USER');
  state.similarity = 0.05;
  await feed(gate, 30, { startMono: 13_000 });
  test('⭐ 换人 ⇒ 回 OTHER（USER→OTHER 会 reset）', gate.uservad.state === 'OTHER');
  test('时间轴里两种状态都在',
    gate.windows.some((w) => w.state === 'USER') && gate.windows.some((w) => w.state === 'OTHER'));
}

// ── 安全放行（§十二） ─────────────────────────────────────────────────────
{
  const seg = { segment_id: 's1', start_mono_ms: 10_000, end_mono_ms: 12_000 };

  const off = makeGate({ config: { enabled: false } }).gate;
  test('门关着 ⇒ KEEP(bypass_gate_disabled)',
    off.decideSegment(seg).keep_reason === 'bypass_gate_disabled');

  const noProfile = makeGate({ profileReady: false }).gate;
  test('没声纹 ⇒ KEEP(bypass_profile_missing)',
    noProfile.decideSegment(seg).keep_reason === 'bypass_profile_missing');

  const notAcked = makeGate({ acked: false }).gate;
  test('⭐ 没确认校准 ⇒ KEEP(bypass_calibration_not_acknowledged)',
    notAcked.decideSegment(seg).keep_reason === 'bypass_calibration_not_acknowledged');

  const { gate: broken, state } = makeGate({ fail: 'CAM++ exploded' });
  await feed(broken, 30);
  test('推理一直失败 ⇒ 一个窗都没有，且错误落在时间轴上',
    broken.windows.length === 0 && broken.errors.length > 0 && state.calls > 0);
  test('CAM++ 出错 ⇒ 该段 KEEP（此时连一次 USER 都没有，理由是更前面那条）',
    broken.decideSegment({ segment_id: 's2', start_mono_ms: 10_500, end_mono_ms: 11_500 })
      .keep_reason === 'bypass_no_user_evidence_yet');
  // armed 之后错误才轮到自己那条理由。
  const { gate: g2, state: s2 } = makeGate();
  await arm(g2, s2, { startMono: 12_000 });
  g2.errors.push({ start_mono_ms: 14_100, end_mono_ms: 14_300 });
  test('armed 之后，段内推理出错 ⇒ KEEP(inference_error)',
    g2.decideSegment({ segment_id: 's2b', start_mono_ms: 14_000, end_mono_ms: 14_500 })
      .keep_reason === 'inference_error');

  const timeoutGate = makeGate({ delayMs: 50, config: { inference_timeout_ms: 200 } }).gate;
  timeoutGate.configure({ inference_timeout_ms: 200 });
  test('超时是可配置的且被 normalize 夹住',
    normalizeSpeakerGate({ inference_timeout_ms: 5 }).inference_timeout_ms === 200);

  const bypassCounted = makeGate({ acked: false }).gate;
  bypassCounted.decideSegment(seg);
  test('bypass 单独计数（⛔ 不混进 keep，否则「门在放行」和「门没开」看起来一样）',
    bypassCounted.counters.decisions.bypass === 1
    && bypassCounted.counters.decisions.keep === 0);
}

// ── 真的会 DROP（否则上面那些 KEEP 不证明任何事） ──────────────────────────
{
  const { gate, state } = makeGate({ similarity: 0.02 });
  await arm(gate, state, { startMono: 18_000 });
  await feed(gate, 40, { startMono: 20_000 });
  const d = gate.decideSegment({ segment_id: 's3',
    start_mono_ms: 21_000, end_mono_ms: 23_000 });
  test('⭐ 全程别人说话 ⇒ 真的 DROP（安全语义没把门变成摆设）', d.decision === 'DROP');
  test('DROP 计数', gate.counters.decisions.drop === 1);
}
{
  const { gate, state } = makeGate({ similarity: 0.02 });
  await arm(gate, state, { startMono: 28_000 });
  await feed(gate, 20, { startMono: 30_000 });
  state.similarity = 0.95;
  await feed(gate, 20, { startMono: 32_000 });
  const d = gate.decideSegment({ segment_id: 's4',
    start_mono_ms: 30_500, end_mono_ms: 33_800 });
  test('⭐ 背景里插了一句本人的话 ⇒ 整段 KEEP',
    d.decision === 'KEEP' && d.keep_reason === 'user_present');
}

// ── Mic Off / 停链 ────────────────────────────────────────────────────────
{
  const { gate } = makeGate({ similarity: 0.95 });
  await feed(gate, 30, { startMono: 80_000 });
  test('先有时间轴', gate.windows.length > 0 && gate.uservad.state === 'USER');
  gate.forceIdle('mic_off');
  test('⭐ Mic Off ⇒ 时间轴/环/迟滞全清（旧证据不许判新音频）',
    gate.windows.length === 0 && gate.ring.ms === 0 && gate.uservad.state === 'OTHER'
    && gate.monoMs === null && gate.running === false);
  test('清空之后 ⇒ 段一律 KEEP（证据也清掉了，回到只放行）',
    gate.decideSegment({ segment_id: 's5', start_mono_ms: 80_500, end_mono_ms: 81_500 })
      .keep_reason === 'bypass_no_user_evidence_yet');
}

// ── snapshot 契约（§十七：正式 /live 不放 timeline） ───────────────────────
{
  const { gate } = makeGate();
  await feed(gate, 20);
  const s = gate.snapshot();
  test('⛔ snapshot 里没有 sliding timeline',
    s.windows === undefined && s.timeline === undefined && typeof s.timeline_windows === 'number');
  test('snapshot 说得出「此刻是什么」', s.state === 'USER' || s.state === 'OTHER');
  test('duty cycle proxy 在', typeof s.telemetry.cam_duty === 'number');
  test('默认值就是 OFF', SPEAKER_GATE_DEFAULTS.enabled === false
    && normalizeSpeakerGate({}).enabled === false);
}

// ── 单飞 ──────────────────────────────────────────────────────────────────
{
  const { gate, state } = makeGate({ delayMs: 400 });
  await feed(gate, 20);
  test('⭐ 上一次还没回来就跳过并计数（⛔ 排队会让延迟越积越大）',
    gate.counters.windows_skipped_busy > 0 && state.calls < 8);
}

// ── 接线（改坏了单测抓不到，只能钉源码） ───────────────────────────────────
{
  test('foregroundAuthority 是派生值，speaker 优先于 rms',
    /const foregroundAuthority = \(\) => \(consumers\.enabled\('speaker_gate'\) && cfg\.speaker_gate\?\.enabled === true \? 'speaker'/
      .test(main));
  test('⭐ 只有一个 DROP 权威：speaker 分支直接 return，不落进 RMS 那条', (() => {
    const body = main.slice(main.indexOf('const foregroundDecide'),
      main.indexOf('const handleVadSegment'));
    const speakerBranch = body.indexOf("foregroundAuthority() === 'speaker'");
    const rmsBranch = body.indexOf('if (!foregroundEnabled())');
    return speakerBranch >= 0 && rmsBranch > speakerBranch
      && body.slice(speakerBranch, rmsBranch).includes('return d;');
  })());
  test('DROP 之后不入 ASR 队列、不进记录组（50 句名额不动）', (() => {
    const body = main.slice(main.indexOf('const handleVadSegment'),
      main.indexOf('const handleVadSegment') + 1600);
    const drop = body.indexOf("fg.decision === 'DROP'");
    const enqueue = body.indexOf('asr.enqueue');
    return drop >= 0 && enqueue > drop && body.slice(drop, enqueue).includes('return;')
      && !body.slice(drop, enqueue).includes('records.admit');
  })());
  /**
   * ⭐ RMS 的权威**只有一个**，而且是 App：它在采集循环里逐帧量，与那一帧一起到达。
   * 本地那份只在 App 没给的时候顶上（旧 App / 没带 `?rms=1` 的连接），
   * 并且回落**必须被计数** —— 一个静默的回落会让「RMS 已经归 App 了」
   * 在完全没有生效的情况下听起来是真的。
   */
  /**
   * ⚠ 这一条曾经还钉着字面量 `let frameRms = null;`。P2 把它改成
   *   `const frameRms = needRms ? ... : null;`（先判要不要，再决定算不算），
   *   于是测试红了——⛔ 而那是**更正确**的写法。钉声明语法不是钉不变式。
   * ⭐ 真正的不变式有三条，与怎么写无关：
   *   ① App 给了就用 App 的；② 没给才本地算；③ 本地那条路**全仓只有一处**。
   */
  test('RMS 权威在 App，本地只是可见的回落，且仍然只算一次',
    main.includes("consumers.enabled('speaker_gate')")
    && main.includes('Number.isFinite(meta?.rms)')
    && main.includes('rmsFromApp += 1')
    && main.includes('rmsComputedLocally += 1')
    && (main.match(/rmsS16le\(frame\)/g) ?? []).length === 1);
  test('speaker_gate 跟着链走，并且有自己的开关',
    /consumers\.setEnabled\('speaker_gate', wantSpeakerGate\)/
      .test(main));
  /** consumer 集合只有一个定义，启动与停止都通过同一条路径。 */
  test('⭐ 链的 consumer 集合只有一份定义（startChain/stopChain 都走它）', (() => {
    /**
     * ⚠ 这里曾经要求 `consumers.setEnabled('rms', on);`——P2 把它删了：
     *   链**不再**因为要开门而订阅 RMS，RMS 从此只服务观察者（`syncRmsObserver()`）。
     * ⛔ 断言应当跟着这个决定走，而不是要求实现把已经拆掉的耦合再装回去。
     */
    return main.includes('syncRmsObserver();')
      && !main.includes("consumers.setEnabled('rms', on);")
      && main.includes("consumers.setEnabled('vad', on && listenEngaged());")
      && main.includes('const applyChainConsumers = (on) =>')
      && main.includes('applyChainConsumers(true)')
      && main.includes('applyChainConsumers(false)');
  })());
  test('Mic Off 会清掉正式门', main.includes("speakerGate.forceIdle('mic_off')"));
  test('⭐ /speaker-gate 排在 /speaker 之前（前缀匹配不看分隔符）',
    main.indexOf("route.startsWith('/speaker-gate/')")
      < main.indexOf("route.startsWith('/speaker')"));
  test('speaker_gate 是一个独立的 domain', main.includes('speaker_gate: () => speakerGate.snapshot()'));
  test('⛔ speaker_gate 不在高频域里', (() => {
    const hot = main.slice(main.indexOf('const HOT_DOMAINS'), main.indexOf('const HOT_DOMAINS') + 200);
    return !hot.includes('speaker_gate');
  })());
  test('每一条 /speaker-gate 端点都在 package.mjs 注册过', (() => {
    const served = new Set();
    const block = main.slice(main.indexOf("route === '/speaker-gate'"),
      main.indexOf("route.startsWith('/speaker')"));
    for (const m of block.matchAll(/sub === '([^']+)'/g)) {
      if (m[1]) served.add(`/speaker-gate${m[1]}`);
    }
    return [...served].every((r) => pkg.includes(`'${r}'`));
  })());
  test('声纹只有一份：生产链读 Speaker Lab 的 calibration()',
    main.includes('calibration: () => speakerLab.calibration()')
    && !main.includes('new SpeakerProfile('));

}

console.log(`${count - failures}/${count} speaker gate assertions passed`);
process.exit(failures ? 1 : 0);

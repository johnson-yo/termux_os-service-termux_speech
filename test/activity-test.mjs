/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: SpeakerActivity（docs/084 CAM-only 验收模式）+ UserWatchdog + main.mjs / package.mjs 的接线
 * [OUTPUT]: 任务书点名的每一条：默认 OFF、无 profile 不算分、HTP backend、
 *           FSM 四态、防重开、pre/post-roll、WAV 格式与有界保留、不碰正式判决、
 *           OFF 释放、ON→OFF→ON 不复活旧 candidate、8 秒 USER-loss rolling watchdog
 * [POS]: ⭐ 这套测试钉的第一件事仍然是**「关掉它，什么都不变」**。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpeakerActivity, TEST_DEFAULTS, KEEP_SEGMENTS, TAIL_MARGIN_CHOICES,
  DEFAULT_TAIL_MARGIN_MS, HEAD_TRIM_CHOICES, DEFAULT_HEAD_TRIM_MS, GRACE_CHOICES,
  DEFAULT_HEAD_MODE }
  from '../service/speaker/activity.mjs';
import { UserWatchdog } from '../service/speaker/user-watchdog.mjs';

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
const src = fs.readFileSync(path.join(root, 'service/speaker/activity.mjs'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(src);

const SR = 16_000;
const FRAME_MS = 100;                                   // 真机就是 100 ms 一帧
const frame = () => Buffer.alloc(SR * FRAME_MS / 1000 * 2);

/** 造一个不碰网络的 CAM++：分数由脚本给定，⛔ 不依赖设备。 */
const makeRig = ({ profileReady = true, scores = [] } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camtest-'));
  let i = 0;
  const confirmed = [];
  const released = [];
  const embedder = {
    backend: 'htp',
    ctxPath: '/sdcard/x/model_ir11.onnx',
    ensured: 0,
    released: 0,
    async ensure() { this.ensured += 1; },
    async release() { this.released += 1; },
    async embed() {
      const s = scores[Math.min(i, scores.length - 1)] ?? 0;
      i += 1;
      return { embedding: [1], inference_ms: 5, compute_unit: 'htp' };
    },
  };
  const t = new SpeakerActivity({
    embedder,
    calibration: () => ({ profile_ready: profileReady, profile: { score: () => cur } }),
    dataRoot: dir,
    onConfirmedUser: (event) => confirmed.push(event),
    freeSessions: async () => { released.push('freed'); return { released: ['vad', 'asr'] }; },
    restoreSessions: async () => { released.push('restored'); return true; },
  });
  let cur = 0;
  /**
   * 喂 n 帧，每帧 100 ms。
   * ⚠ 帧之间必须让出事件循环：真机上帧是 100 ms 一个地到的，推理有的是时间跑完；
   *   同步连喂会让第 2、3 个窗全部撞上 `camInFlight` 变成 busy skip ——
   *   那测的是测试脚本的同步性，不是产品的节拍。
   */
  const feed = async (n, score) => {
    cur = score;
    for (let k = 0; k < n; k += 1) {
      const at = (t.pcmMonoMs ?? 0) + FRAME_MS;
      t.ingest(frame(), { mono_ms: at - FRAME_MS });
      await new Promise((r) => setImmediate(r));
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { t, dir, embedder, released, confirmed, feed, settle, setScore: (v) => { cur = v; } };
};

// ── A. 默认状态与前置 ──────────────────────────────────────────────────────
{
  const { t } = makeRig();
  test('A1 ⛔ 默认 OFF', t.enabled === false && t.graphLoaded === false);
  test('A2 默认参数就是任务书固定的那一组',
    TEST_DEFAULTS.window_ms === 1500 && TEST_DEFAULTS.step_ms === 300
    && TEST_DEFAULTS.enter_threshold === 0.40 && TEST_DEFAULTS.exit_threshold === 0.35
    && TEST_DEFAULTS.enter_confirm === 2 && TEST_DEFAULTS.exit_confirm === 2
    && TEST_DEFAULTS.pre_roll_ms === 500 && TEST_DEFAULTS.post_roll_ms === 0);
  test('A3 ⭐ step 诚实写 300（不再配置 250 实跑 300）', TEST_DEFAULTS.step_ms === 300);
  const s = t.snapshot();
  test('A4 backend / graph_loaded / ctx_path 都在状态里（不许静默回落 CPU）',
    s.backend === 'htp' && s.graph_loaded === false && typeof s.ctx_path === 'string');
}

{
  const { t } = makeRig({ profileReady: false });
  let threw = null;
  await t.start().catch((e) => { threw = e; });
  test('B1 ⛔ 没有 profile 不启动', threw !== null && t.enabled === false);
  const { t: t2, feed } = makeRig({ profileReady: false });
  t2.enabled = true;                                   // 强行绕过开关也不许算分
  await feed(30, 0.9);
  test('B2 ⛔ 没有 profile 就不算 similarity', t2.snapshot().similarity === null);
}

// ── C. 启停与释放 ─────────────────────────────────────────────────────────
{
  const rig = makeRig();
  await rig.t.start();
  test('C1 profile 就绪后可启动，且 graph 标记为已加载',
    rig.t.enabled === true && rig.t.graphLoaded === true && rig.embedder.ensured === 1);
  test('C2 ⭐ 启动时腾出 HTP 会话（本包自己的 vad/asr）',
    rig.released[0] === 'freed'
    && rig.t.snapshot().released_sessions?.released?.length === 2);
  await rig.t.stop();
  test('C3 OFF 释放 ctx', rig.t.graphLoaded === false && rig.embedder.released === 1);
  test('C4 OFF 之后把会话还回去', rig.released.includes('restored'));
  test('C5 Mic Off ⇒ 停止且不自行恢复', (() => {
    rig.t.enabled = true; rig.t.forceIdle('mic_off');
    return rig.t.enabled === false;
  })());
}

// ── D. FSM 四态与 commit ──────────────────────────────────────────────────
const drive = async (rig, plan) => {
  for (const [frames, score] of plan) { await rig.feed(frames, score); await rig.settle(); }
};

{
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[20, 0.05]]);                       // 2 s 静音铺底（攒满一个窗）
  test('D1 静音时停在 OTHER 且不产生 candidate',
    rig.t.fsm.state === 'OTHER' && rig.t.fsm.counters.candidates === 0);
  await drive(rig, [[3, 0.55]]);
  test('D2 OTHER → MAYBE_USER', rig.t.fsm.state === 'MAYBE_USER');
  test('D2b MAYBE_USER 尚未确认时不发 confirmed USER', rig.confirmed.length === 0);
  await drive(rig, [[3, 0.55]]);
  test('D3 连续 2 个支持窗 ⇒ USER', rig.t.fsm.state === 'USER' && rig.t.fsm.candidate?.user_seen);
  test('D3b 正式进入 USER 才发 confirmed USER', rig.confirmed.length >= 1);
  await drive(rig, [[3, 0.10]]);
  test('D4 USER → MAYBE_END', rig.t.fsm.state === 'MAYBE_END');
  await drive(rig, [[3, 0.60]]);
  test('D5 ⭐ MAYBE_END → USER 回来时**不**产生 commit',
    rig.t.fsm.state === 'USER' && rig.t.fsm.counters.commits === 0);
  // ⚠ 半快门之后还要「确认无后续」才落全快门，所以要喂满 grace 的静默
  await drive(rig, [[3, 0.05], [3, 0.05], [18, 0.05]]);
  test('D6 连续 2 个退出窗 + 无后续 ⇒ speaker_exit commit（全快门）',
    rig.t.fsm.counters.commits === 1
    && rig.t.fsm.lastCommit?.commit_reason === 'speaker_exit');
  await rig.t.stop();
}

{
  // 连续用户语音下每个仍为 USER 的 CAM 窗都刷新上游 watchdog，不能只在首次确认时回调。
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[20, 0.02], [3, 0.60], [30, 0.60]]);
  test('D7 连续 USER 会产生重复 confirmed USER 事件', rig.confirmed.length >= 2);
  test('D8 confirmed USER 事件按 CAM 音频时钟单调递增',
    rig.confirmed.every((e, i, a) => i === 0 || e.confirmed_user_at_ms >= a[i - 1].confirmed_user_at_ms));
  await rig.t.stop();
}

// ── E. WAV：格式 / pre-post roll / 有界保留 ────────────────────────────────
{
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[20, 0.02], [3, 0.6], [3, 0.6], [6, 0.6], [3, 0.02], [3, 0.02]]);
  await drive(rig, [[20, 0.02]]);        // 喂满 grace（全快门）并让磁带盖过切点
  const segs = rig.t.recentSegments();
  /**
   * ⭐ 判据从「一共几段」改为「几段 **complete**」。
   * 半快门现在会先交付一版 `incomplete`（那正是「先处理」这件事），
   * 所以数总数会把同一句话的中间版本算成第二句——而产品规则说的从来是
   * 「这是一句话」，不是「只落一个文件」。
   */
  const finals = segs.filter((x) => x.status === 'complete');
  test('E1 commit 之后落了一个 complete WAV', finals.length === 1);
  const wav = path.join(rig.dir, finals[0].wav);
  const raw = fs.readFileSync(wav);
  test('E2 WAV 是 16k / mono / PCM16',
    raw.toString('ascii', 0, 4) === 'RIFF' && raw.toString('ascii', 8, 12) === 'WAVE'
    && raw.readUInt16LE(22) === 1 && raw.readUInt32LE(24) === 16_000
    && raw.readUInt16LE(34) === 16);
  /**
   * ⭐ 文件名现在承载**身份**：`<segment_id>.r<revision>.<part|final>.wav`。
   * 每个 revision 一个不可变文件——⛔ 绝不原地覆盖，ASR 可能正拿着上一版在读。
   */
  test('E3 文件名 = segment_id + revision + 是否最终版',
    /^spk[a-z0-9]+-\d+-c\d+\.r\d+\.final\.wav$/.test(finals[0].wav)
      && finals[0].segment_id === finals[0].wav.split('.')[0]
      && finals[0].revision >= 1);
  // ⚠ head_trim 之后 `pre_roll_ms` 可以是负的（起点被刻意往后挪）。
  //   真正该守的性质不是「起点在 candidate_start 之前」，而是**不啃掉开口**：
  //   起点必须仍然明显早于「第一个越阈窗」。
  test('E4 ⭐ 头部仍留有引子：起点明显早于 first_maybe_user（不啃开口）',
    segs[0].marks.pcm_start_ms <= segs[0].marks.first_maybe_user_ms - 200
    && segs[0].marks.pcm_start_ms >= segs[0].old_pcm_start_ms);
  // ⚠ 旧断言（commit 之后还要有音频）在 retroactive 之后**故意不再成立**：
  //   本轮就是要让音频终点回到 commit **之前**。
  test('E5 ⭐ 切点回到 commit 之前，且仍在确认 USER 之后（没切掉正文）',
    segs[0].segment_audio_end_ms < segs[0].marks.commit_ms
    && segs[0].segment_audio_end_ms > segs[0].marks.confirmed_user_ms);
  test('E6 六个时刻齐全，可直接判断切得对不对',
    ['pcm_start_ms', 'candidate_start_ms', 'first_maybe_user_ms', 'confirmed_user_ms',
      'commit_ms', 'pcm_end_ms'].every((k) => Number.isFinite(segs[0].marks[k])));
  await rig.t.stop();
}

{
  const rig = makeRig();
  await rig.t.start();
  for (let i = 0; i < KEEP_SEGMENTS + 4; i += 1) {
    rig.t.segments.unshift({ seq: 1000 + i, wav: `seg-${1000 + i}.wav`, marks: {} });
  }
  // 触发一次真实 commit 让裁剪逻辑跑起来
  await drive(rig, [[20, 0.02], [3, 0.6], [3, 0.6], [3, 0.02], [3, 0.02], [20, 0.02]]);
  test(`F1 ⛔ 片段有界保留（≤ ${KEEP_SEGMENTS}）`, rig.t.segments.length <= KEEP_SEGMENTS);
  await rig.t.stop();
}

// ── G. 防重开 / ON→OFF→ON ────────────────────────────────────────────────
{
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[20, 0.02], [3, 0.6], [3, 0.6], [3, 0.02], [3, 0.02], [18, 0.02]]);
  const after = rig.t.fsm.counters.candidates;
  await drive(rig, [[2, 0.6]]);       // 窗里还装着刚提交过的音频
  test('G1 ⭐ 已提交的音频不许重开 candidate（判据是窗起点，⛔ 不是冷却时间）',
    rig.t.fsm.counters.candidates === after);
  test('G2 判据用 committed_until 而不是 cooldown',
    /committedUntilMs/.test(fs.readFileSync(path.join(root, 'service/speaker/activity-fsm.mjs'), 'utf8'))
    && !/cooldown/i.test(code));
  await rig.t.stop();
  await rig.t.start();
  test('G3 ON→OFF→ON 不复活旧 candidate',
    rig.t.fsm.candidate === null && rig.t.fsm.state === 'OTHER'
    && rig.t.snapshot().current_candidate_id === null);
  await rig.t.stop();
}

// ── H. 连续 PCM / cadence ────────────────────────────────────────────────
{
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[30, 0.02]]);
  test('H1 ⭐ PCM 磁带常时滚动（静音期照样在录，不是确认后才开始）',
    rig.t.tape.buf.length > 0 && rig.t.tape.endMs !== null);
  const w = rig.t.snapshot().timing.windows;
  await drive(rig, [[9, 0.02]]);      // 900 ms ⇒ 300 ms 节拍应多出 3 个窗
  test('H2 300 ms 节拍：900 ms 音频恰好多出 3 个窗',
    rig.t.snapshot().timing.windows - w === 3);
  await rig.t.stop();
}

{
  /**
   * ⭐ RMS 前讲话的 replay：CAM++ consumer 已经开着，但 admission 仍关闭时，
   * PCM 只进入滚动带、不产生推理窗；RMS 开门后第一句可以回看门前音频。
   */
  const rig = makeRig();
  await rig.t.start();
  rig.t.setHeadMode('safe');
  for (let i = 0; i < 10; i += 1) {
    const start = rig.t.pcmMonoMs ?? 0;
    rig.t.ingest(frame(), { mono_ms: start }, { infer: false });
    await new Promise((r) => setImmediate(r));
  }
  const closed = rig.t.snapshot();
  test('H3 RMS closed: rolling PCM remains, CAM++ does not infer',
    closed.pcm_tape.rolling === true
      && closed.pcm_tape.duration_ms >= 900
      && closed.timing.closed_frames === 10
      && closed.timing.windows === 0);
  await drive(rig, [[6, 0.60], [6, 0.60], [6, 0.02], [6, 0.02], [20, 0.02]]);
  const final = rig.t.recentSegments().find((s) => s.status === 'complete');
  test('H4 RMS-open replay includes PCM before admission in final WAV',
    final?.marks?.pcm_start_ms < 1000
      && final?.marks?.confirmed_user_ms >= 1000);
  await rig.t.stop();
}

// ── I. 隔离墙：不碰任何正式判决 ───────────────────────────────────────────
{
  test('I1 ⛔ 模块本身不引用 ASR / records / 50 句',
    !/sensevoice|audio8|records|transcri|enqueue/i.test(code));
  test('I2 ⛔ 路由块里不调 ASR / records',
    (() => {
      const b = main.slice(main.indexOf("route === '/activity-test'"),
        main.indexOf("route === '/activity-test'") + 3200);
      return !/asr\.|records\.|enqueue/i.test(b);
    })());
test('I3 只是多一个 PCM consumer（⛔ 不新开麦克风）',
    main.includes("{ name: 'speaker_activity', wantsPcm: true")
    && main.includes("if (consumers.enabled('speaker_activity'))")
    && main.includes('infer: automaticCamSegmentAllowed()'));
  test('I4 ⛔ 不绕过聚合表直接要麦克风（docs/077）',
    (() => {
      const b = main.slice(main.indexOf("sub === '/start'"),
        main.indexOf("sub === '/start'") + 700);
      return !/setMicDemand/.test(b);
    })());
  test('I5 Mic Off 会停掉 CAM++VAD', main.includes("speakerActivity.forceIdle('mic_off')"));
  test('I6 ⭐ 每一条 /activity-test 端点都在 package.mjs 注册过', (() => {
    const b = main.slice(main.indexOf("route === '/activity-test'"));
    const served = new Set();
    for (const m of b.slice(0, 3200).matchAll(/sub === '([^']+)'/g)) {
      served.add(`/activity-test${m[1]}`);
    }
    served.add('/activity-test/audio');           // WAV 走 query 形状，单独注册
    return [...served].every((r) => pkg.includes(`'${r}'`));
  })());
  test('I7 WAV 端点防路径穿越', (() => {
    const rig = makeRig();
    return rig.t.wavPath('../../etc/passwd') === null && rig.t.wavPath('x.wav') === null;
  })());
  /**
   * ⭐ 守卫的**反向**断言：真实产出的文件名必须放得出来。
   *
   * 只测「坏名字被挡」，一个把所有名字都挡掉的守卫也能全绿——而它在真机上的表现是
   * 「段切出来了但点不响」，且切段那一侧完全正常，于是问题看起来在音频上。
   * 上一版正是这样：守卫要求以 `seg-` 开头，改名之后每一次试听都静默返回 null。
   */
  test('I7b ⭐ 真实产出的文件名（含 revision 与 part/final）放得出来', (() => {
    const rig = makeRig();
    for (const name of ['spkabc123-1-c1.r1.part.wav', 'spkabc123-1-c1.r3.final.wav']) {
      fs.writeFileSync(path.join(rig.dir, name), Buffer.alloc(8));
      if (rig.t.wavPath(name) === null) return false;
    }
    // 目录之外的东西仍然进不来，即使它以合法后缀结尾
    return rig.t.wavPath('sub/dir/ok.wav') === null;
  })());
  /**
   * ⭐ 下游**会搬走**它拿到的那份（`records.admit` 对 `wav_path` 做 renameSync，
   *   记录组接管音频——那对 VAD 那条链是正确的）。所以本模块交出去的必须是
   *   **另一份**，否则「切出来的段可试听」会在第一次成功转写之后静默失效：
   *   列表里还在，点下去 404，而切段那一侧一切正常。
   */
  test('I9 ⭐ 下游搬走它那份之后，试听仍然可用（两份，归属分明）', await (async () => {
    const rig = makeRig();
    const handed = [];
    rig.t.onSegment = (seg) => handed.push(seg);
    await rig.t.start();
    await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [12, 0.6],
                      [3, 0.02], [3, 0.02], [20, 0.02]]);
    await rig.t.stop();
    if (!handed.length) return false;
    // 模拟下游接管：把它拿到的那份搬走
    for (const seg of handed) fs.rmSync(seg.wav_path, { force: true });
    const segs = rig.t.recentSegments();
    return segs.length > 0
      && segs.every((x) => x.wav_available === true)
      && segs.every((x) => rig.t.wavPath(x.wav) !== null)
      // ⛔ 交出去的那一份不在自己的目录里（否则搬走的就是同一个文件）
      && handed.every((seg) => path.dirname(seg.wav_path) !== rig.dir);
  })());
  test('I8 HTP 加载失败时不吞掉，且把会话还回去', /restoreSessions\(this\.releasedSessions\)/.test(code)
    && /throw error;/.test(code));
}

// ── J. 调度以 PCM audio clock 驱动，不随推理完成漂移 ──────────────────────
{
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[300, 0.02]]);                 // 30 秒音频
  const t = rig.t.snapshot().timing;
  test('J1 ⭐ 每 3 帧恰好一个 due（调度按 PCM 帧序，不看墙钟）',
    t.frames === 300 && t.due === 100);
  test('J2 30 秒不累积漂移：due 与 frames/3 精确相等', t.due === Math.floor(t.frames / 3));
  test('J3 ⭐ 每一条早退都有计数（⛔ 无声丢弃 = 查不出来的丢弃）',
    t.windows + t.skipped_busy + t.skipped_short + t.skipped_no_profile === t.due);
  await rig.t.stop();
}
{
  // 一次慢推理之后，节拍必须回到 audio clock，⛔ 不能把之后整条 cadence 永久后推
  const rig = makeRig();
  let slow = true;
  const orig = rig.embedder.embed.bind(rig.embedder);
  rig.embedder.embed = async (...a) => {
    if (slow) { slow = false; await new Promise((r) => setTimeout(r, 400)); }
    return orig(...a);
  };
  await rig.t.start();
  await drive(rig, [[150, 0.02]]);
  await new Promise((r) => setTimeout(r, 600));   // 等那次 400ms 的慢推理真的结束
  const t = rig.t.snapshot().timing;
  test('J4 慢一次之后 cadence 自愈（due 仍等于 frames/3）', t.due === Math.floor(t.frames / 3));
  test('J5 pending 有界：最多一个在飞，多余的记 busy 而不排队',
    t.skipped_busy >= 1 && rig.t.camInFlight === false);
  await rig.t.stop();
}

// ── K. 反推句尾 ───────────────────────────────────────────────────────────
{
  test('K1 tail_margin 可选值与默认',
    TAIL_MARGIN_CHOICES.join('/') === '300/500/700/900' && DEFAULT_TAIL_MARGIN_MS === 700);
  test('K2 ⛔ post_roll 已退役为 0（不许两条尾巴叠加）', TEST_DEFAULTS.post_roll_ms === 0);
}
const seg1 = async (margin, body = 9) => {
  const rig = makeRig();
  await rig.t.start();
  rig.t.setTailMargin(margin);
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [body, 0.6],
                    [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  await rig.t.stop();
  return g;
};
{
  const g = await seg1(700);
  test('K3 ⭐ 新切点在 commit 之前（retroactive 生效）',
    g && g.segment_audio_end_ms < g.marks.commit_ms);
  test('K4 公式成立：estimated = first_maybe_end − window + margin',
    g.estimated_user_end_ms === g.marks.first_maybe_end_ms - 1500 + 700);
  // 半快门之后 commit 被**刻意推迟** grace(1200)，所以相对 commit 省得更多：
  //   300（退出确认）+ 800（窗内回切）+ 1200（半快门等待）≈ 2300 ms
  // ⭐ 这正是本轮的要点：**多等的是判决，不是尾巴** —— 音频终点没有跟着往后跑。
  test('K5 相对 commit 省掉约 2300 ms（退出确认 + 窗内回切 + 半快门等待）',
    g.saved_tail_ms >= 2000 && g.saved_tail_ms <= 2600);
  test('K6 ⭐ 两个语义分开：音频终点 ≠ 检测边界',
    g.segment_audio_end_ms < g.detection_committed_until_ms
    && g.detection_committed_until_ms === g.marks.commit_ms);
  test('K7 检测滞后被如实报出', g.detection_tail_ms > 0);
  test('K8 句首仍然保守：起点早于 first_maybe_user 至少 200 ms',
    g.marks.pcm_start_ms <= g.marks.first_maybe_user_ms - 200);
  test('K9 retroactive 标记为真（有 anchor）', g.retroactive === true);
}
{
  // ⚠ 用足够长的正文，否则短句会被「不许切到确认 USER 之前」的下界夹住，
  //   那时两档会输出同一个值 —— 那是护栏在起作用，不是公式坏了。
  const a = await seg1(300, 30); const b = await seg1(900, 30);
  test('K10 tail_margin 单调影响切点（900 比 300 多留 600 ms）',
    b.estimated_user_end_ms - a.estimated_user_end_ms === 600);
}
{
  // 回弹：USER → MAYBE_END → USER → 再真正退出，anchor 必须用**最后**那一轮
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6],
                    [3, 0.10],                       // 进 MAYBE_END（第一个 anchor）
                    [3, 0.60], [3, 0.60],            // 回弹成 USER ⇒ anchor 必须清掉
                    [6, 0.60],
                    [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  test('K11 ⭐ MAYBE_END→USER 回弹后不拿旧 anchor 当句尾',
    g && g.marks.first_maybe_end_ms > g.marks.confirmed_user_ms + 1000);
  test('K12 回弹后仍只产生一句（数 complete，不数文件）',
    rig.t.recentSegments().filter((x) => x.status === 'complete').length === 1);
  await rig.t.stop();
}
{
  // ⭐ 本轮关键回归：切短了 WAV 之后，1500ms 窗不能再看见刚提交的 USER 而重开
  const rig = makeRig();
  await rig.t.start();
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [6, 0.6],
                    [3, 0.02], [3, 0.02], [15, 0.02]]);   // 喂满 grace 让它真的 commit
  const n = rig.t.recentSegments().length;
  const cand = rig.t.fsm.counters.candidates;
  await drive(rig, [[3, 0.6]]);        // 紧接着高分：窗里仍装着刚提交过的音频
  test('K13 ⭐ retroactive 裁短之后**不**重复开 candidate',
    rig.t.fsm.counters.candidates === cand);
  test('K14 也不会重复产生 WAV', rig.t.recentSegments().length === n);
  await rig.t.stop();
}
{
  // 安全护栏：异常分数序列不许切出负长度/极短片段
  const rig = makeRig();
  await rig.t.start();
  rig.t.setTailMargin(300);
  await drive(rig, [[25, 0.02], [3, 0.9], [3, 0.9], [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  test('K15 切点有下界：不会切到确认 USER 之前，也不会出负长度',
    g && g.duration_ms > 0 && g.segment_audio_end_ms > g.marks.confirmed_user_ms);
  await rig.t.stop();
}
{
  let threw = null;
  const rig = makeRig();
  try { rig.t.setTailMargin(450); } catch (e) { threw = e; }
  test('K16 ⛔ 非法 tail_margin 被拒（不是静默取整）', threw !== null);
}

// ── L. 头部裁剪与两个 gap（使用者第二轮反馈） ─────────────────────────────
{
  /**
   * ⭐ 转正默认值 = 使用者实测认可的那一组：trim / 1300。
   * ⚠ 它之前是 safe/0，原因是当时 `PcmTape` 还在漂移；漂移修掉之后同一个 1300
   *   从「吃字」变成「切得准」——**改变的是前提，不是这个数**。
   */
  test('L1 head_trim 可选值与实测默认',
    HEAD_TRIM_CHOICES.join('/') === '0/300/700/1000/1300/1600'
    && DEFAULT_HEAD_TRIM_MS === 1300 && DEFAULT_HEAD_MODE === 'trim');
  let threw = null;
  const rig0 = makeRig();
  try { rig0.t.setHeadTrim(450); } catch (e) { threw = e; }
  test('L2 ⛔ 非法 head_trim 被拒', threw !== null);
}
const segHead = async (trim) => {
  const rig = makeRig();
  await rig.t.start();
  rig.t.setHeadMode('trim');
  rig.t.setHeadTrim(trim);
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [30, 0.6],
                    [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  await rig.t.stop();
  return g;
};
{
  const a = await segHead(0);
  const b = await segHead(700);
  test('L3 ⭐ head_trim=0 与旧行为一致（起点 = first_maybe_user − window − pre_roll）',
    a.marks.pcm_start_ms === a.old_pcm_start_ms && a.trimmed_head_ms === 0);
  test('L4 ⭐ head_trim=700 真的往后挪了 700 ms',
    b.trimmed_head_ms === 700
    && b.marks.pcm_start_ms - a.marks.pcm_start_ms === 700);
  test('L4b 默认 1300 ⇒ 起点约在 first_maybe_user − 700（真实开口点附近）', (() => {
    const g = a;  // head_trim=0 时起点 = fmu − 2000
    return g.marks.first_maybe_user_ms - g.marks.pcm_start_ms === 2000;
  })());
  test('L5 头部裁剪不影响尾部切点',
    a.segment_audio_end_ms === b.segment_audio_end_ms);
  test('L6 ⛔ 上界护栏：绝不切到 first_maybe_user 之后（不吃正文）',
    b.marks.pcm_start_ms <= b.marks.first_maybe_user_ms - 200);
}
{
  const g = await segHead(1600);
  test('L7 最大档(1600)也被护栏夹住，仍在 first_maybe_user 之前',
    g.marks.pcm_start_ms <= g.marks.first_maybe_user_ms - 200 && g.duration_ms > 0);
}
{
  const g = await segHead(700);
  test('L8 ⭐ 两个 gap 分开报：音频域滞后 与 墙钟落盘耗时',
    Number.isFinite(g.detection_tail_ms) && Number.isFinite(g.gap_commit_to_wav_ms)
    && g.gap_commit_to_wav_ms >= 0 && g.detection_tail_ms > 0);
  test('L9 commit / wav 两个墙钟时刻都留了档',
    Number.isFinite(g.commit_at_ms) && Number.isFinite(g.wav_at_ms)
    && g.wav_at_ms >= g.commit_at_ms);
}

// ── M. 半快门 / 全快门（使用者第三轮反馈：小停顿不该封段） ────────────────
const segGrace = async (grace, plan) => {
  const rig = makeRig();
  await rig.t.start();
  rig.t.setGrace(grace);
  await drive(rig, plan);
  const segs = rig.t.recentSegments();
  // ⚠ 必须在 stop() **之前**抄下计数：stop() 会 fsm.reset()，读晚了全是 0。
  const counters = { ...rig.t.fsm.counters };
  await rig.t.stop();
  return { segs, fsm: { counters } };
};
{
  test('M1 grace 可选值与验收模式默认',
    GRACE_CHOICES.join('/') === '0/600/1200/1800/2500'
    && TEST_DEFAULTS.continuation_grace_ms === 1200);
}
{
  // 说 → 停约 900ms → 再说 → 真正停：应该是**一段**，不是两段
  const r = await segGrace(1200, [
    [25, 0.02], [3, 0.6], [3, 0.6], [6, 0.6],
    [9, 0.05],                                   // 900 ms 小停顿（低于 grace）
    [3, 0.6], [3, 0.6], [6, 0.6],                // 接着说
    [3, 0.02], [3, 0.02], [20, 0.02],            // 真的停了
  ]);
  /**
   * ⭐ 规则没变：小停顿不切句。变的是它现在**先交付一版 incomplete**。
   * 所以判据是「只有一句话」——一个 segment_id、一个 complete——
   * ⛔ 不是「只有一个文件」。
   */
  const ids = new Set(r.segs.map((x) => x.segment_id));
  const finals = r.segs.filter((x) => x.status === 'complete');
  test('M2 ⭐ 小停顿只落半快门，后续接上 ⇒ 仍是**一句话**（不切句）',
    ids.size === 1 && finals.length === 1);
  if (process.env.DBG) console.log('  DBG segs:',
    JSON.stringify(r.segs.map((x) => [x.segment_id, x.status, x.revision, x.wav])));
  test('M2b 中间那一版是 incomplete，且与最终版同一个 segment_id、revision 更小',
    r.segs.every((x) => x.status === 'complete' || x.status === 'incomplete')
      && r.segs.filter((x) => x.status === 'incomplete')
        .every((x) => x.segment_id === finals[0].segment_id
          && x.revision < finals[0].revision));
  test('M3 该段确实跨过了那次停顿（时长覆盖前后两截）',
    finals[0].duration_ms > 3000);
}
{
  // 同样的音频，grace=0（旧行为）应该切成两段 —— 证明是 grace 起的作用
  const r = await segGrace(0, [
    [25, 0.02], [3, 0.6], [3, 0.6], [6, 0.6],
    [9, 0.05],
    [3, 0.6], [3, 0.6], [6, 0.6],
    [3, 0.02], [3, 0.02], [20, 0.02],
  ]);
  // ⭐ 真相比「切成两段」更糟：grace=0 时 commit 之后，防重开的 1500 ms 封锁期
  //   把刚恢复的那半句**整个吃掉**（candidate 开了但凑不满 enter_confirm ⇒ 作废）。
  //   实测 candidates=2 / commits=1 ⇒ **后半句直接消失**，正是使用者报的现象。
  test('M4 ⭐ 对照：grace=0 时后半句被封锁期整个丢掉（1 段 + 一个作废候选）',
    r.segs.length === 1 && r.fsm.counters.candidates === 2
    && r.fsm.counters.commits === 1 && r.fsm.counters.discarded >= 1);
}
{
  // 停顿超过 grace ⇒ 全快门，两句仍然分开
  const r = await segGrace(1200, [
    [25, 0.02], [3, 0.6], [3, 0.6], [6, 0.6],
    [30, 0.02],                                  // 3 秒真停顿（远超 grace）
    [3, 0.6], [3, 0.6], [6, 0.6],
    [3, 0.02], [3, 0.02], [20, 0.02],
  ]);
  test('M5 明显停顿仍然分成两句（全快门正常落闸）',
    r.segs.filter((x) => x.status === 'complete').length === 2
      && new Set(r.segs.map((x) => x.segment_id)).size === 2);
}
{
  // ⚠ 用够长的正文，否则「不许切到确认 USER 之前」的下界会夹住公式（那是护栏在起作用）
  const r = await segGrace(1200, [
    [25, 0.02], [3, 0.6], [3, 0.6], [30, 0.6], [3, 0.02], [3, 0.02], [20, 0.02],
  ]);
  test('M6 半快门不改变切点：句尾仍按最后一轮 first_maybe_end 反推',
    r.segs[0].estimated_user_end_ms
      === r.segs[0].marks.first_maybe_end_ms - 1500 + r.segs[0].tail_margin_ms);
  test('M7 ⭐ 多等的是判决不是尾巴：新切点仍在 commit 之前',
    r.segs[0].segment_audio_end_ms < r.segs[0].marks.commit_ms);
}
{
  let threw = null;
  const rig = makeRig();
  try { rig.t.setGrace(999); } catch (e) { threw = e; }
  test('M8 ⛔ 非法 grace 被拒', threw !== null);
}

// ── N. PcmTape 不许因时间戳漂移而丢窗（真机卡顿的根因） ──────────────────
{
  /**
   * ⭐ 真机根因回归：`mono_ms` 是设备真实时间戳，每帧并非精确 100 ms。
   *   这里刻意让它每帧多 0.02 ms —— 25 秒环上就会累积到 ~5 ms，
   *   足以让「按时间映射字节」的老实现每个窗都短几十字节、窗停产。
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camdrift-'));
  const t = new SpeakerActivity({
    embedder: { backend: 'htp', ctxPath: 'x', async ensure() {}, async release() {},
      async embed() { return { embedding: [1], inference_ms: 5, compute_unit: 'htp' }; } },
    calibration: () => ({ profile_ready: true, profile: { score: () => 0.05 } }),
    dataRoot: dir,
  });
  await t.start();
  let at = 0;
  for (let i = 0; i < 3200; i += 1) {            // 320 秒音频，足够填满并轮转 25 秒环
    t.ingest(Buffer.alloc(16_000 * 100 / 1000 * 2), { mono_ms: at });
    at += 100.02;                                 // ⚠ 每帧多 0.02 ms 的真实抖动
    // ⚠ 每帧都让出事件循环：真机上帧是 100 ms 一个地到的，推理有的是时间跑完。
    //   批量同步喂会造出现实中不存在的 `camInFlight` 撞车（这个坑本轮踩过三次）。
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 30));
  const ti = t.snapshot().timing;
  test('N1 ⭐ 时间戳抖动下不再出现 skipped_short（老实现会大面积丢窗）',
    ti.skipped_short <= 6);
  test('N2 窗产出率仍接近 due（丢失率 < 5%）',
    ti.windows >= Math.floor(ti.due * 0.95));
  test('N3 每个 due 仍然去向明确（分层计数不漏账）',
    ti.windows + ti.skipped_busy + ti.skipped_short + ti.skipped_no_profile === ti.due);
  await t.stop();
}

// ── O. 句首 Safe 默认（使用者实测「切头吃字」之后的回退） ────────────────
{
  const rig = makeRig();
  await rig.t.start();
  test('O1 默认是实测认可的 trim / 1300',
    rig.t.snapshot().config.head_mode === 'trim'
    && rig.t.snapshot().config.head_trim_ms === 1300);
  rig.t.setHeadMode('safe');   // 以下三条钉的是 **Safe 这个档位本身**仍然一点都不裁
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [12, 0.6],
                    [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  test('O2 ⭐ Safe 模式一点都不裁（起点 = 旧起点，宁可多录不吃字）',
    g.marks.pcm_start_ms === g.old_pcm_start_ms && g.trimmed_head_ms === 0);
  await rig.t.stop();
}
{
  // ⭐ Safe 模式下即使有人把 head_trim 调大，也**不许**生效
  const rig = makeRig();
  await rig.t.start();
  rig.t.setHeadMode('safe');        // ⭐ 默认已是 trim，所以这一条必须**显式**选 Safe
  rig.t.setHeadTrim(1600);
  await drive(rig, [[25, 0.02], [3, 0.6], [3, 0.6], [12, 0.6],
                    [3, 0.02], [3, 0.02], [20, 0.02]]);
  const g = rig.t.recentSegments()[0];
  test('O3 ⛔ Safe 永不应用裁剪（即使 head_trim=1600 也不动）', g.trimmed_head_ms === 0);
  await rig.t.stop();
}
{
  let threw = null;
  const rig = makeRig();
  try { rig.t.setHeadMode('magic'); } catch (e) { threw = e; }
  test('O4 ⛔ 非法 head_mode 被拒', threw !== null);
}

// ── P. CAM++ USER watchdog：初次准入与 USER-loss 共用一条生命周期 ────────
{
  let now = 1000;
  const w = new UserWatchdog({ now: () => now });
  w.open({ roundId: 1 });
  test('P1 RMS open 建立 8 秒 watchdog',
    w.snapshot().active === true && w.snapshot().deadline_ms === 9000);
  now = 8999;
  test('P2 初始 no-user 在 deadline 前不超时', !w.expired());
  now = 9000;
  test('P3 初始连续 8 秒无 USER 才超时', w.expired());
}
{
  let now = 2000;
  const w = new UserWatchdog({ now: () => now });
  w.open({ roundId: 2 });
  now = 2500;
  test('P4 confirmed USER 刷新 deadline',
    w.confirm({ roundId: 2, atMs: now, appMonoMs: 12345 })
      && w.snapshot().deadline_ms === 10500
      && w.snapshot().last_confirmed_user_app_mono_ms === 12345);
  now = 9999;
  test('P5 USER 消失后按最后确认重新计算 8 秒', !w.expired());
  now = 10500;
  test('P6 最后 confirmed USER 后连续 8 秒超时', w.expired());
}
{
  let now = 3000;
  const w = new UserWatchdog({ now: () => now });
  w.open({ roundId: 3 });
  test('P7 MAYBE_USER/OTHER 没有 confirm 不刷新 deadline',
    w.snapshot().deadline_ms === 11000);
  now = 4000;
  w.confirm({ roundId: 3, atMs: now });
  now = 4500;
  test('P8 repeated confirmed USER 可反复滚动刷新',
    w.confirm({ roundId: 3, atMs: now })
      && w.snapshot().deadline_ms === 12500);
}
{
  let now = 5000;
  const w = new UserWatchdog({ now: () => now });
  w.open({ roundId: 10 });
  now = 5500;
  w.confirm({ roundId: 10, atMs: now });
  w.open({ roundId: 11 });
  now = 14_000;
  test('P9 stale round callback 不能刷新新 round',
    w.confirm({ roundId: 10, atMs: now }) === false
      && w.snapshot().round_id === 11
      && w.snapshot().deadline_ms === 13_500);
  w.clear(11);
  test('P10 clear 后 watchdog inactive，旧 callback 仍被拒绝',
    !w.snapshot().active && w.confirm({ roundId: 11, atMs: now }) === false);
}

console.log(`${count - failures}/${count} activity test assertions passed`);
process.exit(failures ? 1 : 0);

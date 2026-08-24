/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: AppSpeakerActivity（本包这一侧）+ AppEventsClient 的 `activity` 域
 * [OUTPUT]: P3 回归：低频同步、exactly-once、丢帧回填、重生不产生 ghost、
 *           以及「谁在执行」说的是事实
 * [POS]: 纯逻辑，⛔ 不起 WebSocket、不连 App、不碰音频。
 *        ⭐ 迁移期最容易出的错是「两套执行体都在正常工作」或者「两边都以为对方在跑」——
 *        两种都不报错，前者把一句话切两遍，后者一句话都不出。这里逐条钉死。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { AppSpeakerActivity, APP_ACTIVITY_MODES } from '../service/speaker/app-activity.mjs';
import { AppEventsClient } from '../service/capture/app-events.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };

/** 一个记账用的假 App：⛔ 不做网络，只记下「谁被调了、带了什么」。 */
const fakeAndroid = (handlers = {}) => {
  const calls = [];
  return {
    calls,
    json: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
      const h = handlers[`${options.method ?? 'GET'} ${path}`] ?? handlers[path];
      if (typeof h === 'function') return h(options.body);
      if (h instanceof Error) throw h;
      return h ?? {};
    },
  };
};

const profileOf = (n = 5) => ({
  profile_ready: true,
  profile: {
    reference: Array.from({ length: 192 }, (_, i) => Math.sin(i * 0.31) / 13.7),
    fingerprint: 'spk-cafe1234-5',
    builtAtMs: 1700,
    config: { threshold: 0.55 },
    enrollments: Array.from({ length: n }, (_, i) => ({ id: `e${i}` })),
  },
});

const segment = (seq, revision, status = 'complete') => ({
  segment_id: `app-x-c${Math.ceil(seq / 2)}`,
  revision, status, wav_path: `/sdcard/termux-os/speech-segments/s${seq}.wav`,
  duration_ms: 2400, start_mono_ms: 1000, end_mono_ms: 3400,
  commit_reason: 'speaker_exit', max_similarity: 0.71, mean_user_similarity: 0.68, seq,
});

const facts = (over = {}) => ({
  schema: 'termux-os.app-speaker-activity.v1',
  executor: 'app', running: true, admitted: true, state: 'USER',
  transitions: 3, segments: 0, profile_ready: true, last_similarity: 0.7,
  last_segment: null, last_error: null, ...over,
});

// ── ① 低频声纹同步 ─────────────────────────────────────────────────────────
{
  const android = fakeAndroid({ 'POST /api/speech/speaker/profile': (b) => ({ profile: { fingerprint: b.fingerprint } }) });
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  const r = await a.syncProfile();
  test('A1 登记完成后声纹被送到 App', r.ok === true);
  // ⚠ 第一条现在是 GET（去问 App 存到第几代了），POST 才是那次同步。
  const body = android.calls.find((c) => c.method === 'POST').body;
  test('A2 送的是结论不是素材（只有 centroid/阈值/指纹）',
    Array.isArray(body.reference) && body.reference.length === 192
    && !('enrollment_wavs' in body) && !('samples' in body));
  test('A3 阈值与登记数如实带上', body.threshold === 0.55 && body.enrollments === 5);
  const put = android.calls.filter((c) => c.method === 'POST');
  test('A4 generation 单调递增', put[0].body.generation === 1);
  const r2 = await a.syncProfile();
  test('A5 再同步一次 generation 继续递增',
    r2.ok === true && android.calls.filter((c) => c.method === 'POST')[1].body.generation === 2);
}

/**
 * ⭐ generation 必须从**持久的那一侧**取。
 * ⚠ 本包每次重启都从 0 开始数：第二次重启之后送出去的永远是 1，而 App 已经存到 2，
 *   于是**此后每一次同步都被拒绝**，且不报错（App 手里还有一份能用的旧副本）。
 */
{
  const android = fakeAndroid({
    'GET /api/speech/speaker/profile': () => ({ generation: 7, fingerprint: 'spk-old-3' }),
    'POST /api/speech/speaker/profile': (b) => ({ profile: { fingerprint: b.fingerprint } }),
  });
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  const r = await a.syncProfile();
  const posted = android.calls.find((c) => c.method === 'POST');
  test('A4b ⭐ 冷启后的第一次同步用 App 那边的 generation+1，⛔ 不是本地的 0+1',
    r.ok === true && posted.body.generation === 8);
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: () => ({ profile_ready: false }), modelPath: '/m.onnx',
  });
  const r = await a.syncProfile();
  test('A6 没有声纹时不发请求，也不抛（App 侧 fail closed）',
    r.ok === false && r.reason === 'no_profile' && android.calls.length === 0);
}

{
  const android = fakeAndroid({ 'POST /api/speech/speaker/profile': new Error('boom') });
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  const r = await a.syncProfile();
  test('A7 同步失败如实报告且不抛', r.ok === false && String(r.reason).includes('boom'));
}

// ── ② 启动顺序：声纹必须先于 start ─────────────────────────────────────────
{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', ctxPath: '/c.onnx', mode: 'app',
  });
  await a.start({ step_ms: 300 });
  const paths = android.calls.map((c) => c.path);
  /**
   * ⭐ 顺序是判据本身，不是实现细节：
   *   · `mode` 必须最先——App 可能刚被 LMK 杀过重生，⛔ 不能假设它还记得上一次的值；
   *   · `profile` 必须在 `start` 之前——反过来那段窗口里每个窗都会被 fail-closed 丢掉，
   *     而计数器上只表现为 `skipped_no_profile` 涨了一点。
   */
  // ⚠ 只看**写**的顺序：中间那次 GET 是同步为了拿 generation 顺手读的一次，
  //   它不构成一个步骤，把它算进顺序等于把实现细节钉进契约。
  const writes = android.calls.filter((c) => c.method === 'POST').map((c) => c.path);
  test('B1 顺序是 mode → model → config → profile → start',
    writes.join('|') === [
      '/api/speech/activity/mode', '/api/speech/activity/model',
      '/api/speech/activity/config',
      '/api/speech/speaker/profile', '/api/speech/activity/start',
    ].join('|'));
  const modelCall = android.calls.find((c) => c.path === '/api/speech/activity/model');
  test('B2 模型来源由本包给定，⛔ App 不猜路径',
    modelCall.body.model_path === '/m.onnx' && modelCall.body.ctx_path === '/c.onnx');
  test('B3 start 之后 started 为真', a.started === true);
}

// ── ③ 准入是低频且幂等 ─────────────────────────────────────────────────────
{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  await a.start();
  const before = android.calls.length;
  await a.admit(true, 'gate');
  await a.admit(true, 'gate');
  await a.admit(true, 'gate');
  test('C1 同向重复准入只发一次请求', android.calls.length === before + 1);
  await a.admit(false, 'rms_gate_closed');
  test('C2 反向准入会发请求', android.calls.length === before + 2);
  test('C3 关门的理由如实带上',
    android.calls.at(-1).body.admitted === false
    && android.calls.at(-1).body.reason === 'rms_gate_closed');
}

{
  const android = fakeAndroid({ 'POST /api/speech/activity/admission': new Error('unreachable') });
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  a.started = true;
  await a.admit(true, 'gate');
  test('C4 ⭐ 准入请求失败时本地状态退回去（否则下一次同向调用被幂等吃掉，'
    + '而 App 从来没收到过）', a.admitted === false);
}

// ── ④ exactly-once ─────────────────────────────────────────────────────────
{
  const got = [];
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', onSegment: (s) => got.push(s),
  });
  a.observe(facts({ segments: 0 }), 'boot-1');
  a.observe(facts({ segments: 1, last_segment: segment(1, 1, 'incomplete') }), 'boot-1');
  a.observe(facts({ segments: 1, last_segment: segment(1, 1, 'incomplete') }), 'boot-1');
  a.observe(facts({ segments: 2, last_segment: segment(2, 2) }), 'boot-1');
  test('D1 每一段只交付一次', got.length === 2);
  test('D2 重复推送被认出来', a.duplicatesDropped >= 1);
  test('D3 半快门与全快门都交付，且 revision 单调',
    got[0].status === 'incomplete' && got[1].status === 'complete'
    && got[1].revision > got[0].revision);
  test('D4 交付的是路径与元数据，⛔ 没有一个音频字节',
    typeof got[0].wav_path === 'string' && !('pcm' in got[0]) && !('audio' in got[0]));
  test('D5 段落标注了执行者', got[0].executor === 'app');
}

// ── ⑤ App 重生不产生 ghost transition ──────────────────────────────────────
{
  const got = [];
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', onSegment: (s) => got.push(s),
  });
  a.observe(facts({ segments: 5, last_segment: segment(5, 1) }), 'boot-1');
  const afterFirst = got.length;
  // App 被 LMK 杀掉重生：计数器归零，但那不是「倒退」，更不是一批新段落。
  a.observe(facts({ segments: 0, last_segment: null, transitions: 0 }), 'boot-2');
  a.observe(facts({ segments: 1, last_segment: segment(1, 1) }), 'boot-2');
  test('E1 ⭐ 重生后只重新对齐基线，⛔ 不重放历史',
    got.length === afterFirst + 1 && a.bootId === 'boot-2');
  test('E2 重生被计数（不是静默的）', a.ghostTransitionsAvoided >= 1);
}

// ── ⑥ 丢帧回填：低频通道允许丢中间值，但定稿不能丢 ─────────────────────────
{
  const got = [];
  const android = fakeAndroid({
    'GET /api/speech/activity/segments?limit=40': () => ({
      segments: [segment(1, 1, 'incomplete'), segment(2, 2), segment(3, 1)],
    }),
  });
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', onSegment: (s) => got.push(s),
  });
  a.observe(facts({ segments: 0 }), 'boot-1');
  a.observe(facts({ segments: 3, last_segment: segment(3, 1) }), 'boot-1');
  await new Promise((r) => setTimeout(r, 10));
  test('F1 ⭐ 计数跳格时回填中间那几段', got.length === 3);
  test('F2 回填按 seq 升序', got[0].wav_path.endsWith('s1.wav') && got[2].wav_path.endsWith('s3.wav'));
  test('F3 回填被计数', a.segmentsBackfilled === 3);
  const before = got.length;
  a.observe(facts({ segments: 3, last_segment: segment(3, 1) }), 'boot-1');
  test('F4 回填之后同一段不会再交付一次', got.length === before);
}

// ── ⑦ 「谁在执行」说的是事实 ───────────────────────────────────────────────
{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m.onnx' });
  test('G0 ⭐ 初值来自配置而不是写死——写死会让「配置说 app、执行体说 speech」'
    + '一直成立，于是两条链都在正常工作而没有一条在处理声音',
    new AppSpeakerActivity({ android, calibration: profileOf, modelPath: '/m', mode: 'app' }).mode
      === 'app');
  await a.setMode('app');
  test('G1 只设了模式还没启动 ⇒ 执行者仍然是 speech',
    a.active() === false && a.snapshot().executor === 'speech');
  await a.start();
  test('G2 真的起来之后才敢说 app', a.active() === true && a.snapshot().executor === 'app');
  await a.stop('user');
  test('G3 停掉之后立刻改回 speech', a.active() === false && a.snapshot().executor === 'speech');
  let threw = false;
  try { await a.setMode('turbo'); } catch { threw = true; }
  test('G4 未知模式被拒绝', threw === true);
  test('G5 取值域只有三个', APP_ACTIVITY_MODES.length === 3);
}

// ── ⑧ AppEvents：activity 域按既有 boot_id/seq 规则转发 ───────────────────
{
  const seen = [];
  const client = new AppEventsClient({ now: () => 1000 });
  client.onActivity = (a, bootId) => seen.push({ segments: a.segments, bootId });
  const frame = (bootId, seq, activity) => JSON.stringify({
    schema: 'termux-os.app-events.v2', boot_id: bootId, seq, event: 'activity.segment',
    data: { activity },
  });
  client.ingest(frame('boot-1', 1, facts({ segments: 1 })));
  client.ingest(frame('boot-1', 1, facts({ segments: 2 })));   // seq 不前进 ⇒ 整帧丢弃
  client.ingest(frame('boot-1', 2, facts({ segments: 2 })));
  test('H1 seq 不前进的帧整帧丢弃，activity 也不转发',
    seen.length === 2 && seen[1].segments === 2);
  test('H2 转发时带上 boot_id', seen[0].bootId === 'boot-1');
  client.ingest(frame('boot-2', 1, facts({ segments: 0 })));
  test('H3 boot_id 变了照常转发（消费方据此重新对齐）',
    seen.length === 3 && seen[2].bootId === 'boot-2');
}

// ── ⑨ 对账收敛：一次瞬时失败不许变成永久故障 ─────────────────────────────
{
  // 假计时器：⛔ 不让单测真的等 1 秒。
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return { unref() {} }; };
  const clearTimer = () => {};
  const fire = () => { const t = timers.splice(0); for (const fn of t) fn(); };

  let failNext = true;
  const android = fakeAndroid({
    'POST /api/speech/activity/start': () => {
      if (failNext) { failNext = false; throw new Error('resident declare failed'); }
      return {};
    },
  });
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => true, setTimer, clearTimer,
  });
  const first = await a.ensureRunning({ step_ms: 300 });
  test('I1 开机那一次失败如实报告，⛔ 不假装成功', first.ok === false && a.started === false);
  test('I2 ⭐ 失败会安排重试（一次瞬时故障不该变成永久故障）', timers.length === 1);
  fire();
  await new Promise((r) => setTimeout(r, 5));
  test('I3 重试成功后自己起来', a.started === true && a.active() === true);
  test('I4 好了之后不再排重试（⛔ 它不是心跳）', timers.length === 0);
  const before = android.calls.length;
  await a.ensureRunning();
  test('I5 已经在跑时 ensureRunning 是空操作', android.calls.length === before);
}

{
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return { unref() {} }; };
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => true, setTimer, clearTimer: () => {},
  });
  await a.ensureRunning();
  test('J1 起来了', a.started === true);
  // App 被 LMK 杀掉重生：它身上没有我们声明过的任何东西。
  a.observe(facts({ running: false }), null);
  await new Promise((r) => setTimeout(r, 5));
  test('J2 ⭐ App 说自己没在跑 ⇒ 立刻对账重启（⛔ 不等下一次开门）',
    a.restarts >= 1 && a.started === true);
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => true,
  });
  await a.ensureRunning();
  const before = a.restarts;
  a.observe(facts({ segments: 1, last_segment: segment(1, 1) }), 'boot-1');
  test('K1 第一次看见 boot_id 不算重生（只是我们刚连上）', a.restarts === before);
  a.observe(facts({ segments: 0, running: true }), 'boot-2');
  await new Promise((r) => setTimeout(r, 5));
  test('K2 换了 boot_id ⇒ 那是另一个 App 进程，本地的「已启动」作废并重新声明',
    a.restarts > before);
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => false,
  });
  const r = await a.ensureRunning();
  test('L1 不该跑的时候不起（⛔ 对账不是「总是打开」）',
    r.reason === 'not_wanted' && a.started === false && android.calls.length === 0);
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'legacy_speech',
    wantRunning: () => true,
  });
  const r = await a.ensureRunning();
  test('L2 legacy 执行器下对账什么都不做', r.reason === 'not_app_executor'
    && android.calls.length === 0);
}

// ── ⑩ 声纹对账：起来了不等于声纹也送到了 ─────────────────────────────────
{
  const android = fakeAndroid({
    'POST /api/speech/speaker/profile': (b) => ({ profile: { fingerprint: b.fingerprint } }),
  });
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app', wantRunning: () => true,
  });
  await a.ensureRunning();
  const afterStart = android.calls.length;

  a.observe(facts({ profile_ready: true, profile_fingerprint: 'spk-cafe1234-5' }), 'boot-1');
  await a.ensureRunning();
  test('M1 指纹一致时对账一个请求都不发', android.calls.length === afterStart);

  // 使用者重新登记了：App 那边还是旧的那一份。
  a.observe(facts({ profile_ready: true, profile_fingerprint: 'spk-old-3' }), 'boot-1');
  await a.ensureRunning();
  await new Promise((r) => setTimeout(r, 5));
  test('M2 ⭐ 指纹对不上 ⇒ 补送一次（⛔ 判据是 App 报的指纹，不是「我上次送了什么」）',
    android.calls.length > afterStart
      && android.calls.at(-1).path === '/api/speech/speaker/profile');
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app', wantRunning: () => true,
  });
  await a.ensureRunning();
  const before = android.calls.length;
  await a.ensureRunning();
  await a.ensureRunning();
  test('M3 还没收到过任何事实时不「以防万一」地补送（⛔ 那是白发的请求）',
    android.calls.length === before);
}

{
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: () => ({ profile_ready: false }), modelPath: '/m.onnx',
    mode: 'app', wantRunning: () => true,
  });
  await a.ensureRunning();
  const before = android.calls.length;
  a.observe(facts({ profile_ready: false, profile_fingerprint: null }), 'boot-1');
  await a.ensureRunning();
  test('M4 本包自己都没有声纹时什么都不送', android.calls.length === before);
}

// ── ⑪ 关门倒计时的续命：判据是**时间戳前进**，不是「收到一帧」 ──────────────
{
  const seen = [];
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => true, onUserConfirmed: (e) => seen.push(e),
  });
  await a.ensureRunning();

  /**
   * ⚠ `Number(null) === 0`，不是 NaN。App 还没确认过 USER 时这个字段是 JSON `null`，
   *   直接 `Number()` 会得到 0 而 `Number.isFinite(0)` 为真 ⇒ 门一开就凭空续一次命。
   *   真机实测过：`user_confirms_seen=1 / last_user_mono_ms=0`，那一刻根本没人说话。
   */
  a.observe(facts({ last_user_mono_ms: null }), 'boot-1');
  test('N1 ⭐ `last_user_mono_ms=null` 不许被读成 0（⛔ 那会凭空续一次命）', seen.length === 0);

  a.observe(facts({ last_user_mono_ms: 1000 }), 'boot-1');
  test('N2 时间戳第一次出现 ⇒ 续一次命', seen.length === 1 && seen[0].confirmed_user_at_ms === 1000);

  // 低频通道允许重复推送；每次重复都续一次的话，门就永远不会关了。
  a.observe(facts({ last_user_mono_ms: 1000 }), 'boot-1');
  a.observe(facts({ last_user_mono_ms: 1000 }), 'boot-1');
  test('N3 ⭐ 重复推送同一个时刻**不**续命（时间戳天然幂等）', seen.length === 1);

  a.observe(facts({ last_user_mono_ms: 900 }), 'boot-1');
  test('N4 倒退的时刻也不续命', seen.length === 1);

  a.observe(facts({ last_user_mono_ms: 1300 }), 'boot-1');
  test('N5 前进了才续', seen.length === 2 && seen[1].confirmed_user_at_ms === 1300);

  test('N6 回调形状与 legacy 的 onConfirmedUser 相同',
    seen[1].state === 'USER' && seen[1].mono_ms === 1300);
}

{
  const seen = [];
  const android = fakeAndroid();
  const a = new AppSpeakerActivity({
    android, calibration: profileOf, modelPath: '/m.onnx', mode: 'app',
    wantRunning: () => true, onUserConfirmed: (e) => seen.push(e),
  });
  await a.ensureRunning();
  /**
   * ⚠ **第一帧只对齐基线**（boot_id 首见），它上面的时刻不会续命。
   *   这是对的：那一帧的时刻可能是我们连上之前就有的旧事实。
   *   代价只是最多晚一拍——App 在 USER 期间每秒都会再报一次。
   */
  a.observe(facts({ last_user_mono_ms: 5000 }), 'boot-1');
  test('O0 首见 boot_id 的那一帧只对齐基线，⛔ 不续命', seen.length === 0);
  a.observe(facts({ last_user_mono_ms: 5000 }), 'boot-1');
  test('O1 下一帧带着同一个时刻就续命了', seen.length === 1);
  await a.admit(false, 'rms_gate_closed');
  await a.admit(true, 'gate');
  a.observe(facts({ last_user_mono_ms: 4000 }), 'boot-1');
  test('O2 ⭐ 新一轮准入不继承上一轮的时刻（⛔ 否则倒计时一开门就被续过一次）',
    seen.length === 2 && seen[1].confirmed_user_at_ms === 4000);
}

console.log(`app-activity-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

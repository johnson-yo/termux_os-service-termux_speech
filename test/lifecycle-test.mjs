/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: LifecycleController / AppEventsClient / CaptureWatchdog / TtsIntervals
 * [OUTPUT]: docs/061 §九 B、C、D 的行为回归——生命周期、抢占恢复、TTS Segment Drop
 * [POS]: 与 self-test.mjs 的分工：那边断言「源码里写了什么」，这边**真的驱动状态机**。
 *        依赖全部注入，时钟与定时器是假的，故 300 秒保温在这里是一次 `clock.advance()`。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import {
  CHAIN,
  DICTATION,
  LifecycleController,
  MIC_REQUESTER,
  WAKE,
} from '../service/lifecycle/controller.mjs';
import { AppEventsClient, CaptureWatchdog } from '../service/capture/app-events.mjs';
import { TtsIntervals } from '../service/capture/tts-intervals.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}`);
  }
};

/** 假时钟 + 假定时器：到期与否由测试说了算，绝不真的等。 */
class FakeClock {
  constructor(start = 1_000_000) {
    this.nowMs = start;
    this.timers = [];
    this.seq = 0;
  }

  now = () => this.nowMs;

  setTimer = (fn, delayMs) => {
    this.seq += 1;
    this.timers.push({ id: this.seq, at: this.nowMs + delayMs, fn });
    return this.seq;
  };

  clearTimer = (id) => {
    this.timers = this.timers.filter((item) => item.id !== id);
  };

  async advance(ms) {
    this.nowMs += ms;
    const due = this.timers.filter((item) => item.at <= this.nowMs);
    this.timers = this.timers.filter((item) => item.at > this.nowMs);
    for (const item of due) await item.fn();
    // 让 controller 内部的 promise 链跑完。
    await new Promise((resolve) => { setImmediate(resolve); });
  }
}

const makeHarness = ({
  warmTimeoutMs = 300_000, failAsrLoad = false, residency = 'service',
} = {}) => {
  const clock = new FakeClock();
  const calls = [];
  const record = (name) => { calls.push(name); };
  const controller = new LifecycleController({
    warmTimeoutMs,
    residency,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    mic: {
      request: async (requester, wanted) => {
        record(`mic:${requester}:${wanted}`);
        return { ok: true };
      },
    },
    wake: {
      load: async () => record('wake:load'),
      unload: async () => record('wake:unload'),
    },
    dictation: {
      loadVad: async () => record('vad:load'),
      loadAsr: async () => {
        record('asr:load');
        if (failAsrLoad) throw new Error('SenseVoice resident refused');
      },
      unloadVad: async () => record('vad:unload'),
      unloadAsr: async () => record('asr:unload'),
    },
  });
  return { clock, calls, controller };
};

// ---------------------------------------------------------------- B 生命周期

{
  const { controller, calls } = makeHarness();
  await controller.startChain('test');
  const first = calls.length;
  const again = await controller.startChain('test');
  test(
    'B1 Chain Start 幂等：第二次不重复请求 Mic、不重复载唤醒组',
    again.ok && again.reason === 'already_started' && calls.length === first,
  );
  test(
    'B1b Chain Start 预载听写组：唤醒组存在的意义就是「需要时立刻叫醒它」',
    calls.includes('wake:load')
      && calls.includes('vad:load')
      && calls.includes('asr:load')
      && controller.dictationState === DICTATION.READY,
  );
}

{
  const { controller, calls } = makeHarness({ residency: 'chain' });
  await controller.startChain();
  await controller.stopChain({ reason: 'test' });
  const afterFirst = [...calls];
  const again = await controller.stopChain({ reason: 'test' });
  test(
    'B2 Chain Stop 幂等：已经停了就什么都不做',
    again.ok && again.reason === 'already_stopped' && calls.length === afterFirst.length,
  );
  test(
    'B3 Chain Stop 撤销 speech 自己的 Mic 需求（且只有这一份）',
    calls.includes(`mic:${MIC_REQUESTER}:false`)
      && !calls.some((item) => item.includes('user.persistent'))
      && controller.micHeld === false,
  );
  test(
    'B4 Chain Stop 释放唤醒组订阅并卸载 VAD/ASR 常驻',
    calls.includes('wake:unload')
      && controller.wakeState === WAKE.UNLOADED
      && controller.dictationState === DICTATION.UNLOADED,
  );
}

{
  const { controller, calls } = makeHarness();
  // 停链基线：从来没 start 过。
  const engaged = await controller.engage('webui', { reason: 'manual' });
  test(
    'B6 停链状态下 Listen 仍可用，并按序载入 VAD → ASR → 请求 Mic',
    engaged.ok
      && calls.indexOf('vad:load') < calls.indexOf('asr:load')
      && calls.indexOf('asr:load') < calls.indexOf(`mic:${MIC_REQUESTER}:true`),
  );
  test('B7 载入成功后才进入 active', controller.dictationState === DICTATION.ACTIVE);
}

{
  const { controller, calls } = makeHarness({ failAsrLoad: true });
  const engaged = await controller.engage('webui');
  test(
    'B8 VAD 成功而 ASR 失败：回滚已载入的 VAD，不进入 ready，且不留 Mic 需求',
    !engaged.ok
      && engaged.reason === 'load_failed'
      && calls.includes('vad:load')
      && calls.includes('vad:unload')
      && !calls.includes(`mic:${MIC_REQUESTER}:true`)
      && controller.dictationState === DICTATION.UNLOADED
      && controller.micHeld === false,
  );
  test(
    'B8b 半状态不存在：失败之后不可能只剩 VAD 在跑',
    controller.dictationLoaded() === false && controller.leases.size === 0,
  );
}

{
  const { controller, calls } = makeHarness();
  await controller.engage('webui');
  await controller.release('webui');
  test(
    'B9 停链基线下 release 立刻释放 Mic',
    calls.at(-1) === `mic:${MIC_REQUESTER}:false` && controller.micHeld === false,
  );
  test(
    'B10 release 之后听写资源进入 warm，而不是被卸掉',
    controller.dictationState === DICTATION.WARM
      && !calls.includes('vad:unload')
      && controller.warmRemainingMs() === 300_000,
  );
  test(
    'B10b 保温期间不得自动恢复 RMS+KWS',
    controller.chain === CHAIN.STOPPED && !calls.includes('wake:load'),
  );
}

{
  const { controller, calls, clock } = makeHarness();
  await controller.engage('webui');
  await controller.release('webui');
  await clock.advance(299_000);
  const before = calls.filter((item) => item === 'vad:load').length;
  await controller.engage('webui');
  test(
    'B11 保温期内再次 engage 不重复载模',
    calls.filter((item) => item === 'vad:load').length === before
      && controller.dictationState === DICTATION.ACTIVE,
  );
}

{
  const { controller, calls, clock } = makeHarness({ residency: 'warm' });
  await controller.engage('webui');
  await controller.release('webui');
  await clock.advance(300_001);
  test(
    'B12 保温超时后卸载 VAD+ASR（ASR 先、VAD 后）',
    calls.includes('asr:unload')
      && calls.includes('vad:unload')
      && calls.indexOf('asr:unload') < calls.indexOf('vad:unload')
      && controller.dictationState === DICTATION.UNLOADED,
  );
}

{
  const { controller, calls } = makeHarness();
  await controller.startChain();
  await controller.engage('webui');
  const micReleases = () => calls.filter((item) => item === `mic:${MIC_REQUESTER}:false`).length;
  const before = micReleases();
  await controller.release('webui');
  test(
    'B13 Chain Started 基线下 release 保留 Mic，回到 RMS+KWS',
    micReleases() === before
      && controller.micHeld === true
      && controller.chain === CHAIN.STARTED
      && controller.dictationState === DICTATION.WARM,
  );
}

{
  const { controller, calls, clock } = makeHarness({ warmTimeoutMs: 5000, residency: 'chain' });
  await controller.startChain();
  await controller.engage('webui');
  await controller.release('webui');
  await clock.advance(5001);
  test(
    'B12b Chain Started 下保温到期**不卸载**——唤醒组还在守着，随时会叫醒它；'
    + '而且反复 load/unload 会把 ORT 分配器高水位推上去，为省内存而周期性卸载净效果是费内存',
    !calls.includes('vad:unload')
      && controller.dictationState === DICTATION.READY
      && controller.warmRemainingMs() === null,
  );
}

{
  const { controller, calls, clock } = makeHarness({ warmTimeoutMs: 5000, residency: 'warm' });
  await controller.startChain();
  await controller.engage('webui');
  await controller.release('webui');
  await clock.advance(5001);
  test(
    'B12c residency=warm 恢复 061 §二.5 的严格语义：Chain Started 下也照样卸载',
    calls.includes('vad:unload') && controller.dictationState === DICTATION.UNLOADED,
  );
}

{
  const { controller, calls, clock } = makeHarness({ warmTimeoutMs: 5000 });
  await controller.engage('webui');
  await controller.release('webui');
  // 保温快到期时又有人来了：新的 engage 必须让旧 timer 作废。
  await clock.advance(4900);
  await controller.engage('webui');
  await clock.advance(200);
  test(
    'B14 warm timer 与新 engage 竞争：过期的 timer 不得卸掉刚刚被用起来的资源',
    !calls.includes('vad:unload') && controller.dictationState === DICTATION.ACTIVE,
  );
}

{
  const { controller, clock } = makeHarness({ warmTimeoutMs: 5000 });
  await controller.engage('webui');
  await controller.release('webui');
  // 卸载与 engage 同时发生：串行化保证两者不会各跑一半。
  const [expired, engaged] = await Promise.all([
    clock.advance(5001),
    controller.engage('ime'),
  ]);
  void expired;
  test(
    'B15 unload 与 engage 竞争：结果只能是「载着且在用」或「卸了再重载」，不存在半状态',
    engaged.ok
      && controller.dictationState === DICTATION.ACTIVE
      && controller.leases.size === 1,
  );
}

{
  const { controller } = makeHarness();
  await controller.engage('ime');
  const [stopped, engaged] = await Promise.all([
    controller.stopChain({ reason: 'race', force: true }),
    controller.engage('webui'),
  ]);
  test(
    'B16 stop chain 与 engage 竞争：两者串行，最终状态自洽',
    stopped.ok
      && (engaged.ok
        ? controller.leases.size === 1 && controller.dictationLoaded()
        : controller.leases.size === 0 && !controller.dictationLoaded()),
  );
}

{
  const { controller, calls } = makeHarness();
  await controller.engage('webui');
  await controller.engage('termux-ime');
  const loads = calls.filter((item) => item === 'vad:load').length;
  test(
    'B17 多 requester 同时持有：只载一次模，两份 lease 独立',
    loads === 1 && controller.leases.size === 2,
  );
  await controller.release('webui');
  test(
    'B17b 一个释放不动摇另一个：仍是 active，Mic 不放',
    controller.leases.size === 1
      && controller.dictationState === DICTATION.ACTIVE
      && controller.micHeld === true,
  );
}

{
  const { controller } = makeHarness();
  const engaged = await controller.engage('webui');
  const wrong = await controller.release('webui', { generation: engaged.lease.generation + 99 });
  test(
    'B18 非持有者/旧 generation 的 release 被拒绝',
    !wrong.ok && wrong.reason === 'stale_generation' && controller.leases.size === 1,
  );
  const right = await controller.release('webui', { generation: engaged.lease.generation });
  test('B18b 同一次 lease 的持有者可以正常释放', right.ok && controller.leases.size === 0);
}

{
  const { controller } = makeHarness({ residency: 'chain' });
  await controller.engage('termux-ime');
  const refused = await controller.stopChain({ reason: 'accident' });
  test(
    'B19 外部 requester 还持着时，普通停链被拒绝并如实报出是谁',
    !refused.ok
      && refused.reason === 'requesters_active'
      && refused.requesters.includes('termux-ime')
      && controller.leases.size === 1,
  );
  const forced = await controller.stopChain({ reason: 'user_confirmed', force: true });
  test(
    'B19b 强制停链收走全部 speech lease',
    forced.ok && forced.revoked.includes('termux-ime') && controller.leases.size === 0,
  );
}

{
  const { controller, calls } = makeHarness();
  // 服务重启：App 那边两张图都还在。⛔ 绝不 undeclare，也不重新 declare。
  controller.reconcile({ vadLoaded: true, asrLoaded: true, micHeld: false });
  test(
    'B20 启动对账既不 declare 也不 undeclare，只是认清 App 侧现在是什么',
    calls.length === 0
      && controller.dictationState === DICTATION.WARM
      && controller.dictationLoaded(),
  );
  test(
    'B20c 对账**不起**保温倒计时——一次服务重启没有「用完」这回事，'
    + '在这里起表会让重启本身在 300 秒后导致一次 undeclare',
    controller.warmRemainingMs() === null,
  );
  controller.reconcile({ vadLoaded: false, asrLoaded: false, micHeld: false });
  test(
    'B20b 两张图真的不在了就如实退回 unloaded，不继续宣称 warm',
    controller.dictationState === DICTATION.UNLOADED && calls.length === 0,
  );
}

{
  const { controller, calls } = makeHarness();
  await controller.startChain();
  const stopped = await controller.stopChain({ reason: 'user' });
  test(
    'B21 默认 residency=service：停链释放麦克风与唤醒检测，但**三张图继续挂着**——'
    + '闲置常驻几乎不要钱（换进 ZRAM），而反复 load/unload 会把分配器高水位推上去',
    stopped.ok
      && calls.includes(`mic:${MIC_REQUESTER}:false`)
      && calls.includes('wake:unload')
      && !calls.includes('vad:unload')
      && !calls.includes('asr:unload')
      && controller.dictationLoaded()
      && controller.dictationState === DICTATION.READY,
  );
  const engaged = await controller.engage('webui');
  test(
    'B21b 图还挂着，所以停链后再听写不必重新载模',
    engaged.ok && calls.filter((item) => item === 'vad:load').length === 1,
  );
}

{
  const { controller, calls, clock } = makeHarness({ warmTimeoutMs: 5000 });
  await controller.engage('webui');
  await controller.release('webui');
  await clock.advance(5001);
  test(
    'B22 默认策略下保温到期同样不卸——warm 只是「没人在用」，不是「该扔了」',
    !calls.includes('vad:unload')
      && controller.dictationState === DICTATION.READY
      && controller.warmRemainingMs() === null,
  );
}

// ------------------------------------------------------------ C 抢占与恢复

const frame = (overrides = {}) => JSON.stringify({
  schema: 'termux-os.app-events.v2',
  event: overrides.event ?? 'capture',
  boot_id: overrides.bootId ?? 'boot-a',
  seq: overrides.seq ?? 1,
  mono_ms: overrides.monoMs ?? 1000,
  data: {
    active: overrides.ttsActive ?? false,
    playing: overrides.playing ?? { current: null, recent: [] },
    capture: {
      schema: 'termux-os.mic-capture.v1',
      state: overrides.state ?? 'active',
      desired: true,
      client_silenced: overrides.silenced ?? false,
      valid_pcm_emitting: overrides.valid ?? true,
      capture_generation: overrides.generation ?? 1,
      boot_id: overrides.bootId ?? 'boot-a',
    },
  },
});

{
  const events = new AppEventsClient({ now: () => 5000 });
  events.ingest(frame({ seq: 1 }));
  events.ingest(frame({ seq: 2, silenced: true, valid: false, state: 'silenced' }));
  test(
    'C1 silenced 事件到达后，采集状态不再宣称有有效 PCM',
    events.captureState() === 'silenced' && events.validPcm() === false,
  );
  const before = events.framesReceived;
  events.ingest(frame({ seq: 2, silenced: true, valid: false, state: 'silenced' }));
  events.ingest(frame({ seq: 1 }));
  test(
    'C2 同一 boot_id 内 seq 不前进的帧一律丢弃（重复推送天然幂等）',
    events.framesReceived === before && events.framesDiscarded === 2,
  );
  events.ingest(frame({ seq: 3, valid: true, state: 'active' }));
  test('C3 恢复事件让状态回到 active', events.captureState() === 'active' && events.validPcm());
}

{
  const events = new AppEventsClient({ now: () => 1 });
  events.ingest(frame({ seq: 100, generation: 3 }));
  events.intervals.ingest({ current: null, recent: [{ start_mono_ms: 1, end_mono_ms: 2 }] }, 'boot-a');
  test('C4 记住了 boot-a 的 TTS 区间', events.intervals.overlaps(1, 2) !== null);
  // App 重生：seq 从 1 重新开始，旧单调时刻失去意义。
  events.ingest(frame({ seq: 1, bootId: 'boot-b', generation: 1 }));
  test(
    'C5 boot_id 变了：旧 seq 不再当成乱序丢弃，旧区间整份作废',
    events.lastSeq === 1
      && events.bootId === 'boot-b'
      && events.generationChanges === 2
      && events.intervals.overlaps(1, 2) === null,
  );
}

{
  const events = new AppEventsClient({ now: () => 9000 });
  events.ingest(frame({ seq: 1 }));
  events.connected = true;
  const live = events.snapshot(9000);
  events.connected = false;
  const dropped = events.snapshot(9000);
  test(
    'C6 断线不清空已知事实，只把它标记为陈旧——「不知道」与「一切正常」不是同一件事',
    live.stale === false
      && dropped.stale === true
      && dropped.capture?.state === 'active',
  );
}

{
  let probes = 0;
  const clock = new FakeClock(0);
  const watchdog = new CaptureWatchdog({
    now: clock.now,
    readSnapshot: async () => { probes += 1; return { state: 'stalled' }; },
  });
  // 按需求本该有 PCM，却一直没有有效帧。
  await watchdog.poll({ expected: true, lastFrameAgeMs: 9000 }, 0);
  await watchdog.poll({ expected: true, lastFrameAgeMs: 9000 }, 1000);
  test('C7 watchdog 有界退避：2 秒之内不重复探测', probes === 1);
  await watchdog.poll({ expected: true, lastFrameAgeMs: 9000 }, 2001);
  await watchdog.poll({ expected: true, lastFrameAgeMs: 9000 }, 7100);
  test('C8 退避按 2/5/10/30 递增而不是固定周期', probes === 3 && watchdog.step === 3);
  await watchdog.poll({ expected: true, lastFrameAgeMs: 100 }, 8000);
  test('C9 状态一恢复立刻停止退避查询', watchdog.step === 0 && probes === 3);
  await watchdog.poll({ expected: false, lastFrameAgeMs: null }, 99_000);
  test('C10 没有 Mic 需求时不探测——没人要 PCM，"没有 PCM" 就不是异常', probes === 3);
}

// ---------------------------------------------------------------- D TTS Drop

{
  const intervals = new TtsIntervals();
  intervals.ingest({
    current: null,
    recent: [{ playback_id: 'p1', start_mono_ms: 1000, end_mono_ms: 2000 }],
  }, 'boot-a');

  test('D1 段完全位于 TTS 之前：不丢', intervals.overlaps(200, 900) === null);
  test('D2 段的开头与 TTS 重叠：丢', intervals.overlaps(1500, 2500) !== null);
  test('D3 TTS 在段的中间开始：丢', intervals.overlaps(500, 2500) !== null);
  test('D4 段的结尾与 TTS 重叠：丢', intervals.overlaps(900, 1200) !== null);
  test('D5 段完全位于 TTS 之后：不丢', intervals.overlaps(2100, 3000) === null);
  test('D5b 段被 TTS 完全覆盖：丢', intervals.overlaps(1200, 1800) !== null);

  intervals.ingest({
    current: null,
    recent: [{ playback_id: 'p2', start_mono_ms: 5000, end_mono_ms: 6000 }],
  }, 'boot-a');
  test(
    'D6 多段 TTS 区间：每一段都参与判定，且重复推送不堆积',
    intervals.overlaps(5500, 5600) !== null
      && intervals.overlaps(1500, 1600) !== null
      && intervals.intervals.length === 2,
  );

  intervals.ingest({ current: { playback_id: 'p3', start_mono_ms: 9000 }, recent: [] }, 'boot-a');
  test(
    'D7 正在播的那一段视为开区间——它还没结束，谁也不知道会播到什么时候',
    intervals.overlaps(9500, 9600) !== null && intervals.overlaps(8000, 8500) === null,
  );

  intervals.ingest({ current: null, recent: [] }, 'boot-b');
  test(
    'D8 App generation 变了：旧 TTS 区间不影响新 PCM',
    intervals.overlaps(1500, 1600) === null && intervals.bootId === 'boot-b',
  );
}

{
  const intervals = new TtsIntervals();
  intervals.ingest({ current: null, recent: [{ start_mono_ms: 100, end_mono_ms: 200 }] }, 'boot-a');
  test(
    'D12 没有单调时刻时不做判定——宁可多转写一句，也不因为「不知道」就吃掉使用者的话',
    intervals.overlaps(null, 200) === null && intervals.overlaps(100, undefined) === null,
  );
}

console.log(`\nlifecycle-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

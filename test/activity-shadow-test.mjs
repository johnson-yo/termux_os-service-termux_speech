/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: TargetActivityFsm（纯逻辑）+ main.mjs / config.mjs / package.mjs 的接线
 * [OUTPUT]: docs/083 点名的两侧——① shadow 不许碰任何正式判决 ② FSM 语义与 PoC 一致
 * [POS]: ⭐ 这套测试钉的第一件事是**「关掉它，什么都不变」**；
 *        第二件事是那两条被真机逼出来的规则（防重复 candidate / 非语音必不是用户）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TargetActivityFsm, ACTIVITY_DEFAULTS, normalizeActivityConfig, OTHER, MAYBE_USER, USER,
} from '../service/speaker/activity-fsm.mjs';
import { TargetActivityShadow } from '../service/speaker/activity-shadow.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const conf = fs.readFileSync(path.join(root, 'service/config.mjs'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
const shadow = fs.readFileSync(path.join(root, 'service/speaker/activity-shadow.mjs'), 'utf8');
/**
 * ⚠ 检查「代码里有没有调 X」必须**先去掉注释**：头部那句「⛔ 不调 SenseVoice」
 *   本身就含 `SenseVoice`，于是断言在一个完全正确的文件上报红。
 *   docs/078 的 S11 是同一个形状——判据不能被它要禁止的那个词的**说明**触发。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const shadowCode = stripComments(shadow);

/** 把一串 (时间, 分数) 与连续 speech 的 VAD 喂进 FSM。 */
const drive = (fsm, windows, { speech = true, step = 250, vadFrom = 0 } = {}) => {
  for (const [t, sim] of windows) {
    for (let v = vadFrom; v < t; v += 10) fsm.onVad(v, speech ? 0.9 : 0.01);
    vadFrom = t;
    fsm.onWindow(t, sim);
  }
  return vadFrom;
};

// ── 默认值与配置 ──────────────────────────────────────────────────────────
test('A1 默认 OFF', ACTIVITY_DEFAULTS.enabled === undefined
  && /target_activity_shadow: \{\s*\n\s*enabled: false/.test(conf));
test('A2 参数就是 PoC 验证过的那一组',
  ACTIVITY_DEFAULTS.window_ms === 1500 && ACTIVITY_DEFAULTS.step_ms === 250
  && ACTIVITY_DEFAULTS.enter_threshold === 0.40 && ACTIVITY_DEFAULTS.exit_threshold === 0.35
  && ACTIVITY_DEFAULTS.enter_confirm === 2 && ACTIVITY_DEFAULTS.exit_confirm === 2
  && ACTIVITY_DEFAULTS.pre_roll_ms === 500 && ACTIVITY_DEFAULTS.post_roll_ms === 400);
test('A3 ⛔ step 不许被静默改成 500（PoC：1 s 从 3/3 掉到 1/3）',
  normalizeActivityConfig({ step_ms: 500 }).step_ms === 500
  && ACTIVITY_DEFAULTS.step_ms === 250);
test('A4 事件保留有界', normalizeActivityConfig({ keep_events: 9999 }).keep_events === 200);

// ── 状态机语义 ────────────────────────────────────────────────────────────
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.10], [1750, 0.50], [2000, 0.10]]);
  test('B1 OTHER→MAYBE→OTHER 不 commit（没确认过就作废）',
    f.counters.commits === 0 && f.counters.discarded === 1 && f.state === OTHER);
}
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55]]);
  test('B2 连续 2 个支持窗 ⇒ USER', f.state === USER && f.candidate.user_seen === true);
}
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55], [2000, 0.10], [2250, 0.60]]);
  test('B3 USER→MAYBE_END→USER 不 commit（抖一下不算结束）',
    f.state === USER && f.counters.commits === 0);
}
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55], [2000, 0.10], [2250, 0.05]]);
  test('B4 连续 2 个 exit 窗 ⇒ speaker_exit commit',
    f.counters.commits === 1 && f.lastCommit.commit_reason === 'speaker_exit');
  test('B5 commit 带齐 metadata',
    ['candidate_id', 'candidate_start_ms', 'confirmed_user_ms', 'confirmed_user_end_ms',
     'commit_ms', 'commit_reason', 'max_similarity', 'mean_user_similarity',
     'window_count', 'pcm_start_ms', 'pcm_end_ms', 'duration_ms']
      .every((k) => k in f.lastCommit));
  test('B6 ⛔ commit 里没有 PCM 本体（不许把张量/base64 塞 JSON）',
    !JSON.stringify(f.lastCommit).includes('data_b64')
    && typeof f.lastCommit.pcm_start_ms === 'number');
}
{
  const f = new TargetActivityFsm();
  let v = drive(f, [[1500, 0.50], [1750, 0.55]]);
  for (let t = v; t <= 1750 + 1300; t += 10) f.onVad(t, 0.01);   // 静默超过 grace
  test('B7 vad_silence 作为 endpoint',
    f.counters.commits === 1 && f.lastCommit.commit_reason === 'vad_silence');
}
{
  const f = new TargetActivityFsm();
  let v = drive(f, [[1500, 0.50], [1750, 0.55]]);
  for (let t = v; t <= 1750 + 400; t += 10) f.onVad(t, 0.01);    // 350 ms 级停顿
  test('B8 ⭐ 句内 ~400 ms 停顿**不**切段', f.counters.commits === 0 && f.state === USER);
}

// ── 两条被真机逼出来的规则 ────────────────────────────────────────────────
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55], [2000, 0.10], [2250, 0.05]]);
  const after = f.counters.candidates;
  // commit 之后，窗里仍装着刚提交的音频（起点 < committed_until），分数照样很高
  drive(f, [[2500, 0.60], [2750, 0.62]], { vadFrom: 2250 });
  test('C1 ⭐ 同一段音频不许开出第二个 candidate',
    f.counters.candidates === after && f.counters.commits === 1);
  // 窗的起点越过提交点之后，才允许重新开
  drive(f, [[4000, 0.60], [4250, 0.62]], { vadFrom: 2750 });
  test('C2 窗起点越过提交点之后可以正常再开',
    f.counters.candidates === after + 1 && f.state === USER);
}
{
  const f = new TargetActivityFsm();
  // ⭐ 非语音就肯定不是用户：VAD 全程静默时，再高的分数也不许抬状态
  for (const [t, sim] of [[1500, 0.90], [1750, 0.95], [2000, 0.95]]) {
    for (let v = t - 250; v < t; v += 10) f.onVad(v, 0.01);
    f.onWindow(t, sim);
  }
  test('C3 ⭐ 非语音期间分数再高也不进 USER',
    f.state === OTHER && f.counters.commits === 0 && f.counters.windows_silent === 3);
  test('C4 静默时 shouldInfer=false（调用方据此省掉推理）', f.shouldInfer(2000) === false);
}
{
  const f = new TargetActivityFsm();
  test('C5 ⭐ 一帧 VAD 都没收到过 ⇒ 不许否决（否则 shadow 自己饿死）',
    f.vadAvailable() === false && f.shouldInfer(5000) === true);
  f.onWindow(1500, 0.50); f.onWindow(1750, 0.55);
  test('C6 VAD 离线时 CAM++ 照常判决', f.state === USER);
  test('C7 「VAD 在不在线」是可见状态，不是静默降级',
    f.snapshot().vad_available === false);
}

// ── 连续两句 ──────────────────────────────────────────────────────────────
{
  const f = new TargetActivityFsm();
  let v = drive(f, [[1500, 0.50], [1750, 0.55], [2000, 0.05], [2250, 0.05]]);
  v = drive(f, [[6000, 0.55], [6250, 0.60], [6500, 0.05], [6750, 0.05]], { vadFrom: v });
  test('D1 连续两句 ⇒ 两个独立 commit',
    f.counters.commits === 2 && f.events.length === 2
    && f.events[0].candidate_id !== f.events[1].candidate_id);
  test('D2 两个 candidate 的 PCM 区间不重叠',
    f.events[0].pcm_end_ms <= f.events[1].pcm_start_ms);
}

// ── pre-roll / 保留上限 / 复位 ────────────────────────────────────────────
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55], [2000, 0.05], [2250, 0.05]]);
  const e = f.lastCommit;
  test('E1 ⭐ pre-roll 从窗起点再往前，句首不丢',
    e.pcm_start_ms === Math.max(0, (1500 - 1500) - 500)
    && e.pcm_start_ms < e.confirmed_user_ms);
  test('E2 post-roll 覆盖到 commit 之后', e.pcm_end_ms === 2250 + 400);
}
{
  const f = new TargetActivityFsm({ keep_events: 5 });
  let v = 0;
  for (let i = 0; i < 8; i += 1) {
    const b = 2000 + i * 4000;
    v = drive(f, [[b, 0.50], [b + 250, 0.55], [b + 500, 0.05], [b + 750, 0.05]], { vadFrom: v });
  }
  test('F1 事件保留有界', f.events.length === 5 && f.counters.commits === 8);
}
{
  const f = new TargetActivityFsm();
  drive(f, [[1500, 0.50], [1750, 0.55]]);
  f.reset();
  test('F2 复位后不残留 candidate（Mic On 不自动恢复旧 candidate）',
    f.state === OTHER && f.candidate === null && f.counters.commits === 0
    && f.committedUntilMs === null);
}

// ── 接线：shadow 绝不碰正式判决 ───────────────────────────────────────────
{
  const block = main.slice(main.indexOf("route === '/activity-shadow'"),
    main.indexOf("正式声纹门（docs/081）"));
  test('G1 ⛔ shadow 路由不调 ASR / 不写 records / 不占 50 句',
    !/asr\.enqueue|records\.admit|sensevoice/i.test(block));
  test('G2 ⛔ shadow 模块本身不引用 ASR / records',
    !/asr|records|sensevoice/i.test(shadowCode));
  test('G3 commit 对象带 `shadow: true` 标记',
    fs.readFileSync(path.join(root, 'service/speaker/activity-fsm.mjs'), 'utf8')
      .includes('shadow: true'));
  test('G4 默认 OFF：consumer 跟着配置走，关掉就 forceIdle',
    /consumers\.setEnabled\('activity_shadow', on && cfg\.target_activity_shadow\?\.enabled === true\)/
      .test(main)
    && main.includes("activityShadow.forceIdle(on ? 'shadow_disabled' : 'chain_stopped')"));
  test('G5 ⛔ 不新开麦克风：只在 PCM 分流点多挂一个 consumer',
    (main.match(/new PcmWs\(/g) ?? []).length === 1
    && main.includes("if (consumers.enabled('activity_shadow')) activityShadow.ingest(frame, meta)"));
  test('G6 ⭐ 不新开 FireRedVAD：复用生产那张图的观测钩子',
    main.includes('onProbability: (probability, frameIndex) =>')
    && !/new VadController\([\s\S]{0,4000}new VadController\(/.test(main));
  test('G7 Mic Off 会清掉 shadow', main.includes("activityShadow.forceIdle('mic_off')"));
  test('G8 每一条 /activity-shadow 端点都在 package.mjs 注册过', (() => {
    const served = new Set();
    for (const m of block.matchAll(/sub === '([^']+)'/g)) served.add(`/activity-shadow${m[1]}`);
    return [...served].every((r) => pkg.includes(`'${r}'`));
  })());
  test('G9 ⛔ 长时间轴不进 /live（只暴露状态与少量统计）', (() => {
    const dom = main.slice(main.indexOf('target_activity: () =>'),
      main.indexOf('target_activity: () =>') + 200);
    return dom.includes('activityShadow.snapshot()')
      && !dom.includes('history');
  })());
  test('G10 ⭐ 墙钟与 CPU 时间分开报（不许混为一谈）',
    shadowCode.includes('cam_wall_duty') && shadowCode.includes('node_cpu_during_cam_duty')
    && shadowCode.includes('process.cpuUsage'));
  /**
   * ⭐ 这条钉的是**字段名不许说谎**：CAM++ 的 ONNX 在 App 的 `:ort_worker`，
   *   `process.cpuUsage()` 量的是 node 自己。叫 `cam_cpu_*` 会让读的人把它当成
   *   「CAM++ 花了多少 CPU」——那是另一个问题的答案（docs/056 的形状）。
   */
  test('G12 ⛔ 不许把 node 自己的 CPU 叫成 CAM++ 的 CPU',
    !/\bcam_cpu_/.test(shadowCode) && shadowCode.includes('node_cpu_ms_during_cam'));
  test('G11 PCM 环常时滚动，与推理开不开无关',
    /this\.ring\.push\(frame\);[\s\S]{0,600}shouldInfer/.test(shadow)
    && /shouldInfer\(end\)\) \{ this\.stats\.cam_skipped_silent/.test(shadow));
}

// ── H. 启动期回调：`?.` 挡不住 TDZ ────────────────────────────────────────
/**
 * ⭐ 真机上服务**每次启动即崩**、整包 API 全线 `fetch failed`，而源码里 14 处 `hub?.`
 *   看上去全都写了保护。`?.` 挡的是 `null`/`undefined`，TDZ 里的绑定两者都不是。
 *   下面两条一条钉「回调确实会在启动期发生」，一条钉「那时 hub 必须已经是 null」。
 */
{
  test('H1 setEnabled(true) 会在构造期就回调 onChange（启动期回调真的会发生）', (() => {
    // 复现 main.mjs 的那两行：构造 → 立刻按持久化配置 setEnabled(true)
    let calls = 0;
    const inst = new TargetActivityShadow({
      embedder: { embed: async () => ({ embedding: [] }) },
      calibration: () => ({ profile_ready: false }),
      onChange: () => { calls += 1; },
    });
    inst.setEnabled(true);
    return calls === 1;
  })());
  test('H2 ⭐ main.mjs 的 hub 是**可空前向引用**，且初始化早于第一次引用', (() => {
    const lines = main.split('\n');
    const declared = lines.findIndex((l) => /^\s*let hub\s*=\s*null\s*;/.test(l));
    // ⚠ `(?<![\w-])` 是必需的：没有它，`'./state-hub.mjs'` 这行 import 会被当成第一次引用。
    const firstUse = lines.findIndex((l) => /(?<![\w-])hub\s*\??\./.test(l)
      && !/^\s*[*/]/.test(l));
    return declared >= 0 && firstUse >= 0 && declared < firstUse;
  })());
  test('H3 ⛔ hub 不许再写成靠后的 const（那会让 14 处 `hub?.` 全部形同虚设）',
    !/^\s*const hub\s*=/m.test(main) && /^\s*hub = new StateHub\(/m.test(main));
}

console.log(`${count - failures}/${count} activity shadow assertions passed`);
process.exit(failures ? 1 : 0);

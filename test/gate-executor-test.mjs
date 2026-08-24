/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RmsGate（admission 退出后）+ AppEventsClient 的 gate 事实消费
 * [OUTPUT]: P2 回归：本包不再自己判开门、一次 App gate = 一次 admission、重连不虚开
 * [POS]: 纯逻辑，⛔ 不起 WebSocket、不连 App。
 *        ⭐ 迁移期最容易出的错是「两套 admission 都在正常工作」——
 *        那不会报错，只会让一句话被开两次门。这里逐条钉死。
 * [PROTOCOL]: 变更时更新此頭部，然后检查 CLAUDE.md
 */
import { RmsGate } from '../service/rms-gate.mjs';
import { AppEventsClient } from '../service/capture/app-events.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };

const gateConfig = { open_threshold: 0.05, sample_interval_ms: 200 };
const loudFrame = (gate, seq) => gate.ingest(
  { rms: 0.9, recording: true, frameSeq: seq, sampleAgeMs: 0 }, 1000 + seq * 100);

// ── P2：本包不再按 RMS 阈值开门 ────────────────────────────────────────────
{
  const gate = new RmsGate(gateConfig);
  for (let i = 1; i <= 20; i += 1) loudFrame(gate, i);
  const s = gate.snapshot(3000);
  test('P1 响度远超阈值也不再开门（admission 已退出 product path）', s.state === 'closed');
  test('P2 默认执行者是 app', s.gate_executor === 'app');
  test('P3 兼容字段仍报 external（旧读者不会误解成 rms 在判）', s.open_source === 'external');
  // ⭐ observation ≠ admission：采样与可用性照常
  test('P4 RMS 观测仍然工作', s.current === 0.9 && s.available === true);
}

// ── 显式请求仍能开门（App 的 gate 事实走这条） ─────────────────────────────
{
  const gate = new RmsGate(gateConfig);
  loudFrame(gate, 1);
  const opened = gate.openFromRequest('app_gate', 2000);
  test('P5 显式请求可以开门', opened.state === 'open');
  test('P6 开门理由如实记录', opened.last_transition.reason === 'app_gate');
}

// ── 开发态回退：显式切到 legacy 才会自己判 ─────────────────────────────────
{
  const gate = new RmsGate(gateConfig);
  test('P7 切换执行者返回是否真的变了', gate.setGateExecutor('legacy_speech') === true);
  test('P8 重复切换不算变化', gate.setGateExecutor('legacy_speech') === false);
  for (let i = 1; i <= 3; i += 1) loudFrame(gate, i);
  test('P9 回退态下才按阈值开门', gate.snapshot(2000).state === 'open');
  test('P10 回退态如实报告', gate.snapshot(2000).gate_executor === 'legacy_speech');
}

// ── AppEvents：一次 gate.open = 一次消费 ───────────────────────────────────
const frame = (bootId, seq, gate) => JSON.stringify({
  schema: 'termux-os.app-events.v2', boot_id: bootId, seq, event: 'gate.open',
  data: { gate },
});

{
  let consumed = 0;
  const client = new AppEventsClient({ now: () => 1000 });
  client.onGateOpen = () => { consumed += 1; };
  const g = (opens, mode = 'feature') => ({ mode, opens, profile_ready: true, testing: false });

  client.ingest(frame('boot-a', 1, g(5)));
  test('Q1 第一帧只对齐基线，⛔ 不当成一次开门', consumed === 0);
  client.ingest(frame('boot-a', 2, g(6)));
  test('Q2 计数递增 = 一次开门', consumed === 1);
  // ⚠ 同一帧重复推送（重连后常见）必须幂等
  client.ingest(frame('boot-a', 2, g(6)));
  test('Q3 seq 不前进的重复帧被丢弃', consumed === 1);
  client.ingest(frame('boot-a', 3, g(6)));
  test('Q4 相同 opens 不再算一次', consumed === 1);
  client.ingest(frame('boot-a', 4, g(9)));
  test('Q5 一次跳跃仍然只算一次 admission', consumed === 2);
}

// ── App 重启：boot_id 变了，计数归零不得虚开 ───────────────────────────────
{
  let consumed = 0;
  const client = new AppEventsClient({ now: () => 1000 });
  client.onGateOpen = () => { consumed += 1; };
  const g = (opens) => ({ mode: 'feature', opens, profile_ready: true, testing: false });
  client.ingest(frame('boot-a', 1, g(50)));
  client.ingest(frame('boot-a', 2, g(51)));
  test('R1 旧世界里正常消费', consumed === 1);
  // App 重生：新 boot_id，opens 从 0 重新开始
  client.ingest(frame('boot-b', 1, g(0)));
  test('R2 ⭐ 重启后的第一帧不得被当成开门（计数倒退只是换了个世界）', consumed === 1);
  client.ingest(frame('boot-b', 2, g(1)));
  test('R3 新世界里的第一次真实开门正常消费', consumed === 2);
}

// ── volume 与 feature 对下游必须完全等价 ───────────────────────────────────
{
  const trace = (mode) => {
    const seen = [];
    const client = new AppEventsClient({ now: () => 1000 });
    client.onGateOpen = (g) => seen.push(g.opens);
    const g = (opens) => ({ mode, opens, profile_ready: true, testing: false });
    client.ingest(frame('boot-x', 1, g(0)));
    client.ingest(frame('boot-x', 2, g(1)));
    client.ingest(frame('boot-x', 3, g(2)));
    return seen;
  };
  const volume = trace('volume');
  const feature = trace('feature');
  test('S1 ⭐ volume 与 feature 对下游逐项相同（mode 只是 metadata）',
    JSON.stringify(volume) === JSON.stringify(feature) && volume.length === 2);
}

// ── 测试模式不驱动下游 ─────────────────────────────────────────────────────
{
  let consumed = 0;
  const client = new AppEventsClient({ now: () => 1000 });
  client.onGateOpen = () => { consumed += 1; };
  client.ingest(frame('boot-t', 1, { mode: 'feature', opens: 0, testing: false }));
  client.ingest(frame('boot-t', 2, { mode: 'feature', opens: 1, testing: true }));
  test('T1 测试模式只打分，⛔ 不开门', consumed === 0);
  client.ingest(frame('boot-t', 3, { mode: 'feature', opens: 2, testing: false }));
  test('T2 退出测试模式后恢复正常', consumed === 1);
}

// ── 接线契约：开门必须**推进流水线**，不只是改门的状态 ────────────────────
{
  const fs = await import('node:fs');
  const url = await import('node:url');
  const path = await import('node:path');
  const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  const handler = /appEvents\.onGateOpen = \(appGate\) => \{[\s\S]*?\n\};/.exec(main)?.[0] ?? '';
  /**
   * ⭐ 真机事故（P2）：只调 `openFromRequest` 而不调 `observeGateLifecycle`，
   *   门开了、计数涨了、日志也打了，而**流水线永远停在 rms**——「拍了没反应」。
   *   P2 之前它是靠 10 Hz 的 RMS 帧循环顺带完成的；撤掉那条流，副作用就静默消失。
   * ⛔ 这条钉的是「开门这件事必须自带推进」，不是某一行的写法。
   */
  test('U1 gate-open 处理器必须自己推进流水线（⛔ 不许再搭 RMS 循环的便车）',
    handler.includes('openProductGate('));
  /**
   * ⭐ U2 从「两条路径长得一样」升级成「**只有一条路径**」。
   *   长得一样是靠人维护的，只有一条是靠结构保证的。
   */
  test('U2 正式开门只有一个入口：openProductGate 之外没人调 openFromRequest',
    (main.match(/gate\.openFromRequest\(/g) ?? []).length === 1
      && /const openProductGate = [\s\S]{0,600}?gate\.openFromRequest\(/.test(main));
  test('U2b 那唯一的入口自己做全三步（开门 + lifecycle + 回写快照）',
    /const openProductGate = \(reason[\s\S]{0,700}?observeGateLifecycle\(opened, nowMs\)[\s\S]{0,200}?rmsGateSnapshot\(nowMs\)/.test(main));
  test('U2c 两条 product 路径都走它',
    /openProductGate\('app_gate'\)/.test(main)
      && /openProductGate\(`\$\{reason\}_opened_gate`\)/.test(main));
}

/**
 * ⭐ 真机事故（P2 第二处）：`openFromRequest` 的第一行安全兜底问的是
 *   「本包这条 RMS 观测流够不够新」，而 admission 早已搬进 App。
 *   实测 App 报 `recording=true frame_seq=55463`、门开了 92 次，
 *   本包同时报 `available=false`（sample_age 1158ms > 1000ms），
 *   于是**每一次开门请求都被静默拒绝**，`transition_seq` 恒为 0。
 * ⛔ 这几条钉的是「麦克风的生死由持有它的那一侧回答」。
 */
{
  const live = () => {
    const g = new RmsGate({ open_threshold: 0.08, sample_interval_ms: 200 });
    // App 执行者 + 本包观测流已陈旧（available 恒 false，因为从未 ingest）
    g.setGateExecutor('app');
    return g;
  };

  const a = live();
  a.setCaptureLive(true);
  const openedByApp = a.openFromRequest('app_gate');
  test('U3 App 说还在录 ⇒ 观测流陈旧也必须开门',
    openedByApp.state === 'open' && a.transitionSeq === 1);
  test('U3b 开了门的快照必须自洽（state=open ⇒ 允许 PCM）',
    openedByApp.pcm_admission === 'allow');

  const b = live();
  b.setCaptureLive(false);
  test('U4 App 说没在录 ⇒ 兜底照常拒绝',
    b.openFromRequest('app_gate').state === 'closed' && b.transitionSeq === 0);

  const c = live();
  c.setCaptureLive(null);   // 事实不可信（断线/陈旧）
  test('U5 事实不可信 ⇒ 退回本包自己的观测（此处为 false，拒绝）',
    c.openFromRequest('app_gate').state === 'closed');

  const d = new RmsGate({ open_threshold: 0.08, sample_interval_ms: 200 });
  d.setGateExecutor('legacy_speech');
  d.setCaptureLive(true);   // ⛔ 开发态回退不听 App 的
  test('U6 legacy_speech 执行者的判据一行未变',
    d.openFromRequest('explicit_listen').state === 'closed');

  const e = live();
  e.setCaptureLive(true);
  const snap = e.snapshot();
  test('U7 两个判据分开报，不一致必须看得见',
    snap.capture_live === true && snap.rms_stream_fresh === false);
}

/* ── policy 事实：关门倒计时的长度由 App 推过来，⛔ 本包不另存一份 ────────── */
{
  const seen = [];
  const client = new AppEventsClient({ now: () => 1000 });
  client.onPolicy = (p) => seen.push(p);
  const frame = (seq, policy) => JSON.stringify({
    schema: 'termux-os.app-events.v2', boot_id: 'boot-p', seq, event: 'policy',
    data: { policy },
  });
  client.ingest(frame(1, { user_timeout_ms: 8000, gate_mode: 'feature' }));
  client.ingest(frame(2, { user_timeout_ms: 20000, gate_mode: 'feature' }));
  test('P11 policy 事实经既有 AppEvents 通道转发（⛔ 不新开 WS、⛔ 不轮询）',
    seen.length === 2 && seen[1].user_timeout_ms === 20000);
  client.ingest(frame(2, { user_timeout_ms: 99999 }));
  test('P12 seq 不前进的帧整帧丢弃，policy 也不转发', seen.length === 2);
}

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

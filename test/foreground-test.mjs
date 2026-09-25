/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: ForegroundGate + main.mjs 的接线
 * [OUTPUT]: docs/076 点名的安全性质——不误杀、不污染、不裁剪、可关掉
 * [POS]: ⭐ 这套测试钉的全是**「宁可放过背景，不误杀用户」**的那一侧：
 *        一个能把使用者说的话吃掉的 gate，比没有 gate 糟得多。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForegroundGate, framesToDb, SILENCE_DB } from '../service/asr/foreground.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
/**
 * ⚠ 断言「代码里没有 X」之前必须先去掉注释——否则一句解释「我们**不用** X」
 *   会让断言失败，而修法会变成**删掉那句解释**。测试要盯的是代码，不是文字。
 *   （self-test 里已经写过这条；这一轮我又踩了一次。）
 */
const mainCode = main
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** 造一段恒定 dB 的帧序列。 */
const seg = (db, ms, frameMs = 10) => Array.from({ length: ms / frameMs }, () => db);

// ── reference 生命周期 ────────────────────────────────────────────────────
{
  const g = new ForegroundGate();
  test('R1 刚开会话时 reference 未就绪', g.ready === false && g.band() === null);
  const d0 = g.decide(seg(-20, 500), 10);
  test('R2 未就绪一律 KEEP，且说得出原因',
    d0.decision === 'KEEP' && d0.keep_reason === 'reference_not_ready');
  // 攒够 3 秒
  for (let i = 0; i < 6; i += 1) g.decide(seg(-20, 500), 10);
  test('R3 攒够 reference_min_ms 后就绪', g.ready === true && g.band() !== null);
  test('R4 R* 落在喂进去的那个层上（p60，允许一个 bin 的偏差）',
    Math.abs(g.snapshot().reference_db + 20) <= 2);
}

// ── KEEP / DROP 判据 ──────────────────────────────────────────────────────
{
  const g = new ForegroundGate();
  for (let i = 0; i < 8; i += 1) g.decide(seg(-20, 500), 10);
  const near = g.decide(seg(-22, 1000), 10);
  test('K1 与 R* 同层的段 KEEP', near.decision === 'KEEP');
  const far = g.decide(seg(-45, 1000), 10);
  test('K2 明显低于 band 的整段 DROP，且原因指名道姓',
    far.decision === 'DROP' && far.drop_reason === 'below_reference_band');
  test('K3 DROP 段带齐 telemetry',
    far.time_in_reference_band_ms === 0 && far.in_reference_band_ratio === 0
    && typeof far.segment_median_rms_db === 'number'
    && Array.isArray(far.reference_band));

  // ⭐ overlap：背景 → 用户 → 背景。只要中间命中主体层，**整段**保留。
  const overlap = [...seg(-45, 600), ...seg(-20, 500), ...seg(-45, 600)];
  const o = g.decide(overlap, 10);
  test('K4 背景→用户→背景：整段 KEEP，不裁剪',
    o.decision === 'KEEP' && o.time_in_reference_band_ms >= 500);
  test('K5 段内不裁剪是结构性的——判定只回 KEEP/DROP，不回任何区间',
    !('crop' in o) && !('cut_ms' in o) && !('keep_ranges' in o));
}

// ── ⭐ 上一轮量出来的两个坑，逐个钉死 ─────────────────────────────────────
{
  const g = new ForegroundGate();
  for (let i = 0; i < 8; i += 1) g.decide(seg(-20, 500), 10);
  // 坑①：400 ms 的真实语音段，绝对毫秒判据会结构性误杀（攒不满 300 ms）。
  const short = g.decide(seg(-20, 400), 10);
  test('B1 400 ms 的同层短段必须 KEEP（比例判据救的就是它）',
    short.decision === 'KEEP' && short.in_reference_band_ratio >= 0.9);
  // 长背景段里只有零星几帧碰到带内 → DROP（离 300 ms 还很远）。
  const longQuiet = [...seg(-40, 3600), ...seg(-20, 240)];   // 3.84 s，240 ms 在带内
  const lq = g.decide(longQuiet, 10);
  test('B3 3.84 s 的背景段只有 240 ms 在带内 → DROP',
    lq.decision === 'DROP' && lq.in_reference_band_ratio < 0.1);
  /**
   * ⭐ 与 B3 只差 160 ms，却必须是相反的答案——这一条钉的是任务的红线：
   *   「用户+背景重叠时，只要检测到主体 reference，整段保留」。
   *   占比同样很低（10%），但主体能量**确实存在**，就不许判掉。
   */
  const overlapLong = [...seg(-40, 3600), ...seg(-20, 400)];  // 4.0 s，400 ms 在带内
  const ol = g.decide(overlapLong, 10);
  test('B4 同样是长段、占比同样只有 10%，但带内累计够 → KEEP（重叠红线）',
    ol.decision === 'KEEP' && ol.keep_reason === 'in_band_ms'
    && ol.in_reference_band_ratio < 0.12);
  // 坑②：R* 不能用众数。这里只断言 modal 仅作 telemetry，判定不依赖它。
  test('B2 modal 只进 telemetry，不参与判定',
    'segment_modal_rms_db' in short && 'modal_prominence' in short
    && fs.readFileSync(path.join(root, 'service/asr/foreground.mjs'), 'utf8')
      .includes("percentile(sorted, 0.6)"));
}

// ── 污染防护 ──────────────────────────────────────────────────────────────
{
  const g = new ForegroundGate();
  for (let i = 0; i < 8; i += 1) g.decide(seg(-20, 500), 10);
  const before = g.snapshot().reference_db;
  for (let i = 0; i < 20; i += 1) g.decide(seg(-45, 1000), 10);   // 一堆背景段
  const after = g.snapshot().reference_db;
  test('P1 ⛔ DROP 段绝不更新 reference（20 段背景之后 R* 纹丝不动）',
    Math.abs(after - before) < 1e-9);
  test('P2 计数分开记', g.snapshot().foreground_drop_count === 20);
  g.reset('listen');
  test('P3 reset 后回到未就绪，且换了来源',
    g.ready === false && g.snapshot().reference_source === 'listen'
    && g.snapshot().reference_sample_ms === 0);
}

// ── framesToDb ────────────────────────────────────────────────────────────
{
  const silent = framesToDb(new Int16Array(16000));
  test('F1 全零样本落到静音底，不产生 -Infinity',
    silent.length > 90 && silent.every((v) => v === SILENCE_DB));
  const tone = new Int16Array(16000);
  for (let i = 0; i < tone.length; i += 1) tone[i] = Math.round(3276 * Math.sin(i / 8));
  const db = framesToDb(tone);
  // 幅度 0.1 的正弦，RMS ≈ 0.0707 ⇒ ≈ −23 dB
  test('F2 已知幅度的正弦得到预期 dB（±1.5 dB）',
    Math.abs(db[50] + 23) < 1.5);
}

// ── 接线契约 ──────────────────────────────────────────────────────────────
test('W1 gate 装在 SenseVoice **之前**：DROP 不 enqueue',
  /const fg = foregroundDecide\(segment\);[\s\S]{0,400}if \(fg\.decision === 'DROP'\)[\s\S]{0,300}return;\s*\n\s*\}\s*\n\s*asr\.enqueue/.test(main));
test('W2 DROP 顺手删掉 staging WAV（它已经没有归属者）',
  /fg\.decision === 'DROP'[\s\S]{0,200}fs\.rmSync\(segment\.wav_path/.test(main));
test('W3 只装在 SenseVoice 这条门上——Audio8 的 commit 路径没有 gate',
  !/onCommit[\s\S]{0,600}foregroundDecide/.test(main));
test('W4 关掉开关立刻恢复原行为，一行判定都不执行',
  main.includes("if (!foregroundEnabled()) return { decision: 'KEEP', keep_reason: 'gate_disabled' }"));
test('W5 量不出来就 KEEP——「量不了」绝不能变成「不听了」',
  /catch \(error\) \{\s*\n\s*return \{ decision: 'KEEP', keep_reason: 'measure_failed'/.test(main));
test('W6 每次开门重新校正（session-local）',
  main.includes('foreground.reset(reason);'));
test('W7 状态与最近判定可读', main.includes("route === '/asr/foreground'")
  && main.includes('absolute: foreground.snapshot()'));

// ── docs/079：生产链接上相对门 + 会话自动校准 ─────────────────────────────
test('W8 默认走 relative，absolute 只是可回退的另一个取值',
  main.includes("cfg.foreground_gate_mode === 'absolute' ? 'absolute' : 'relative'"));
/**
 * ⭐ B* 的素材只能来自会话开始**之前**——等门开了再去问「刚才背景多响」就晚了。
 *
 * ⚠ **这一条曾经钉错了对象。** 旧断言要求 ambient 挂在本包的 rms consumer 上
 *   （`if (consumers.enabled('rms')) calibrator.ingestAmbient(`）。那在 P1 之前成立，
 *   因为链一开 RMS 就常驻；P2 之后那条 10 Hz WS 只在 WebUI 观察时才开，
 *   于是「有没有背景锚点」变成了「有没有人开着页面」——而且**不会报错**，
 *   `beginSession` 只会安静地写下 `background_too_short`。
 * ⭐ 正确的不变式不是「挂在哪条流上」，而是：
 *   **会话开始之前那几秒的背景，必须来自一个一直有音频的地方，并且在 `beginSession` 之前到位。**
 *   唯一一直有音频的是 App，所以素材向它取；⛔ 不把 RMS WS 变回正式链路。
 */
test('W9 会话开始前先取回背景素材，且严格早于 beginSession',
  /await primeAmbientForSession\(reason\);\s*\n\s*calibrator\.beginSession\(reason\);/.test(main));
test('W9b ⛔ ambient 不再挂在 10Hz 的 RMS 循环上',
  !/calibrator\.ingestAmbient\(rmsToDbFrames/.test(mainCode));
/**
 * ⭐ 整窗**替换**而不是追加：`beginSession` 的取窗是相对环尾算的，
 *   追加会让环尾落在「HTTP 回来的那一刻」而不是素材的尾——背景窗随网络抖动平移。
 */
test('W9c 用 primeAmbient 整窗替换，⛔ 不追加',
  mainCode.includes('calibrator.primeAmbient(')
    && !/calibrator\.ingestAmbient\(/.test(mainCode));
/** ⛔ 取素材失败绝不能打断会话：没有 gate 好过误杀使用者（docs/079 的失败保护是 KEEP）。 */
test('W9d 取素材失败不抛，只如实记账',
  /catch \(error\) \{[\s\S]{0,320}calibrator\.primeAmbient\(\[\]\)/.test(main));
/** ⚠ 「不够」与「没问」与「问了但环里就是短」修法完全不同，必须分得开。 */
test('W9e ambient 事实可观察（来源 / 次数 / 上一次结果）',
  /ambient: \{[\s\S]{0,260}reads: ambientReads[\s\S]{0,80}last: ambientLast/.test(main));
test('W10 开门那一刻定两个锚点',
  main.includes('calibrator.beginSession(reason);'));
/**
 * ⚠ 顺序：先 `ingestSegment` 再 `decide`，否则第一段拿不到自己贡献的参考。
 *   而 `ingestSegment` 在 frozen 之后是空操作——这就是「判定不回写参考」。
 */
test('W11 先补参考再判段，且判完不回写',
  /calibrator\.ingestSegment\(db\);[\s\S]{0,160}relativeForeground\.decide\(/.test(main));
/**
 * ⭐ 生产**不能**要求使用者先录一段背景。Lab 那个 `/acoustic-lab/calibration/*`
 *   是实验台的，正式链上不该有对应物——两个锚点全部由工作流自动取得。
 */
// ⭐ WEBUI18：Acoustic Lab 随旧 speech 产品面退役 ⇒ 对外**没有任何** calibration 端点。
test('W12 生产不要求使用者先录背景（对外没有 calibration 端点）',
  (() => {
    const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
    return [...pkg.matchAll(/'(\/[\w/-]*calibration[\w/-]*)'/g)].length === 0;
  })());

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

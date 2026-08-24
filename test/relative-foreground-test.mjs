/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RelativeForegroundGate + AcousticLab 的双参考接线 + ForegroundGate 的 `fixed`
 * [OUTPUT]: docs/079 点名的性质——分不开就 KEEP、判定永不回写参考、逐帧越线时间才是判据
 * [POS]: ⭐ 这套测试同时钉两侧：
 *        · 安全侧沿用 docs/076——「背景里说一句话」必须整段 KEEP，宁可放过背景；
 *        · 有效侧是本轮新增——**纯背景必须 DROP**，否则这条门等于不存在。
 *        R10 用的是参考机（SM8550 / HTP V73）真机量到的两组分布，它把「取哪个分位数」这个判断钉死在数据上。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import {
  RelativeForegroundGate, RELATIVE_DEFAULTS, REFERENCE_STATS,
  distributionOf, statFrom, percentileOf,
} from '../service/asr/relative-foreground.mjs';
import { ForegroundGate } from '../service/asr/foreground.mjs';
import { SessionCalibrator } from '../service/asr/session-calibrator.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const seg = (db, ms, frameMs = 10) => Array.from({ length: Math.round(ms / frameMs) }, () => db);
const concat = (...parts) => parts.flat();

// ── 阈值算术与就绪判断 ────────────────────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  test('R1 没有参考时 gap/threshold 都是 null，不是 0',
    g.gapDb === null && g.thresholdDb === null);
  const d0 = g.decide(seg(-10, 1000), 10);
  test('R2 没有参考一律 KEEP，并说得出是哪一种没准备好',
    d0.decision === 'KEEP' && d0.keep_reason === 'reference_not_ready');

  g.setReferences({ backgroundDb: -32, userDb: -18 });
  test('R3 T = B* + alpha×(R*-B*)', g.gapDb === 14 && g.thresholdDb === -25);
  g.configure({ alpha: 0.25 });
  test('R4 alpha 可调且立刻生效', g.thresholdDb === -28.5);
  g.configure({ alpha: RELATIVE_DEFAULTS.alpha });
}

// ── 分不开的时候不许硬判 ──────────────────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -30, userDb: -27 });   // gap 3 < min_separation 6
  test('R5 两层分不开 ⇒ ready=false', g.ready === false);
  const d = g.decide(seg(-40, 4000), 10);
  test('R6 分不开时 KEEP 而不是 DROP——这是红线，宁可放过背景',
    d.decision === 'KEEP' && d.keep_reason === 'insufficient_separation');
  test('R7 两种「没准备好」必须分得开，不能都叫 not_ready',
    g.references().not_ready_reason === 'insufficient_separation');
}

// ── 纯背景必须 DROP（本轮新增的有效性侧） ────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });   // T = -25
  const d = g.decide(seg(-38, 4000), 10);
  test('R8 纯背景整段低于 T ⇒ DROP background_only',
    d.decision === 'DROP' && d.drop_reason === 'background_only'
    && d.time_above_threshold_ms === 0);
}

// ── 背景里夹一句话必须整段 KEEP（docs/076 的红线，一条没松） ─────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });   // T = -25
  const frames = concat(seg(-38, 1800), seg(-16, 300), seg(-38, 1900));
  const d = g.decide(frames, 10);
  test('R9 4 秒背景里只有 300 ms 用户 ⇒ 仍然 KEEP 整段',
    d.decision === 'KEEP' && d.keep_reason === 'foreground_present'
    && d.time_above_threshold_ms === 300);
  test('R9b 占比只有 7.5%，判据**没有**看占比',
    d.time_above_threshold_ms / d.segment_duration_ms < 0.08);
}

// ── ⭐ 真机分布回归：定哪个分位数比定 alpha 重要得多 ──────────────────────
{
  // 参考机（SM8550）实测（10 ms 帧，各约 32 秒，背景=持续播放的中文访谈播客）：
  const BG = { p50: -39.0, p60: -37.5, p75: -35.2, p90: -32.5, p95: -31.4, max: -27.4 };
  const SM = { p50: -32.1, p60: -29.3, p75: -24.1, p90: -18.7, p95: -16.3, max: -8.8 };

  const tOf = (b, u, alpha = 0.5) => b + alpha * (u - b);
  const tP60 = tOf(BG.p60, SM.p60);
  const tTail = tOf(BG.p95, SM.p90);
  test('R10a 两边都取 p60 ⇒ T 落在背景 p90 之下 ⇒ 结构性 false KEEP',
    tP60 < BG.p90);
  test('R10b B* 取 p95、R* 取 p90 ⇒ T 高过背景最大值 ⇒ 纯背景一帧都过不去',
    tTail > BG.max);
  test('R10c 默认就该是尾部那一组',
    REFERENCE_STATS.background === 'p95' && REFERENCE_STATS.user === 'p90');

  // 用真实分位数造一段「统计上像背景」的帧，检验默认配置下确实 DROP。
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: BG.p95, userDb: SM.p90 });
  const bgLike = concat(seg(-45, 1000), seg(-39, 1500), seg(-33, 1000), seg(-28, 200));
  const d = g.decide(bgLike, 10);
  test('R10d 真机背景形状（含 200 ms 的 -28 dB 尖峰）在默认配置下仍 DROP',
    d.decision === 'DROP' && d.time_above_threshold_ms === 0);
}

// ── 单侧：说得比平时大声不是失败理由 ──────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });
  const d = g.decide(seg(-6, 1000), 10);            // 比 R* 还高 13 dB
  test('R11 远高于用户参考 ⇒ 照样 KEEP（无上沿）',
    d.decision === 'KEEP' && d.keep_reason === 'foreground_present');
  // 同一段在旧的绝对 band 门下会失败，这正是换单侧的理由。
  const old = new ForegroundGate({ fixed: true });
  old.rStar = -19; old.refMs = 999_999; old.refValues = [-19];
  const od = old.decide(seg(-6, 1000), 10);
  test('R11b 同一段在旧 band 门下被判掉——对照成立', od.decision === 'DROP');
}

// ── 判定永不回写参考（docs/078 那个正反馈） ──────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });
  const before = JSON.stringify(g.references());
  for (let i = 0; i < 20; i += 1) g.decide(seg(-40, 4000), 10);
  for (let i = 0; i < 20; i += 1) g.decide(seg(-12, 4000), 10);
  test('R12 40 次判定之后 B*/R*/T 逐字不变', JSON.stringify(g.references()) === before);
}

// ── C1：ForegroundGate 的 fixed 必须真的冻结判决值 ───────────────────────
{
  const g = new ForegroundGate({ fixed: true });
  g.rStar = -26.19; g.refMs = 999_999; g.refValues = [-26.19];
  test('R13 fixed 模式起手就绪', g.ready === true);
  for (let i = 0; i < 30; i += 1) g.decide(concat(seg(-42, 3600), seg(-24, 400)), 10);
  test('R13b 30 次 KEEP 之后 R* 一动没动（真机上它滑了约 8 dB）',
    g.snapshot().reference_db === -26.19);

  const drift = new ForegroundGate();               // 默认非冻结＝旧行为
  drift.rStar = -26.19; drift.refMs = 999_999; drift.refValues = [-26.19];
  for (let i = 0; i < 30; i += 1) drift.decide(concat(seg(-42, 3600), seg(-24, 400)), 10);
  test('R13c 不加 fixed 时确实会漂——证明 R13b 测到的是开关而不是巧合',
    drift.snapshot().reference_db < -30);
}

// ── p90 不是主判据 ───────────────────────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });   // T = -25
  // 整段 p90 都在 T 之下，但有一段连续 250 ms 越线。
  const frames = concat(seg(-40, 3000), seg(-20, 250), seg(-40, 750));
  const d = g.decide(frames, 10);
  test('R14 segment p90 低于 T，但逐帧累计够 ⇒ KEEP',
    d.segment_p90_db < d.foreground_threshold_db && d.decision === 'KEEP');
  test('R14b 最长连续越线时长被记下来', d.max_contiguous_above_threshold_ms === 250);
}

// ── C3：判决现场必须完整 ─────────────────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });
  const d = g.decide(concat(seg(-38, 2000), seg(-15, 400)), 10);
  const need = ['background_reference_db', 'user_reference_db', 'reference_gap_db',
    'foreground_threshold_db', 'alpha', 'foreground_min_ms',
    'segment_p50_db', 'segment_p75_db', 'segment_p90_db', 'segment_p95_db',
    'time_above_threshold_ms', 'max_contiguous_above_threshold_ms'];
  test('R15 判决记录带齐 C3 要求的每一个字段',
    need.every((k) => d[k] !== undefined && d[k] !== null));
}

// ── 短段与静音 ───────────────────────────────────────────────────────────
{
  const g = new RelativeForegroundGate();
  g.setReferences({ backgroundDb: -31, userDb: -19 });
  const d = g.decide(seg(-40, 120), 10);
  test('R16 太短的段不判，直接 KEEP',
    d.decision === 'KEEP' && d.keep_reason === 'segment_too_short_to_judge');
  test('R17 distributionOf 忽略静音帧，全静音返回 null',
    distributionOf([-70, -70, -70]) === null
    && distributionOf([-70, -20, -20]).n === 2);
  test('R18 statFrom 认不得的名字返回 null，绝不返回一个「差不多」的数',
    statFrom(distributionOf(seg(-20, 1000)), 'p42') === null
    && statFrom(distributionOf(seg(-20, 1000)), 'median') === -20);
  test('R19 percentileOf 空输入返回 null', percentileOf([], 0.5) === null);
}

// ── 会话自动校准（生产链，docs/079 §生产链） ──────────────────────────────
{
  const cal = new SessionCalibrator();
  // 进入处理前的背景窗口，以及紧挨着入口的排除窗口。
  cal.ingestAmbient(seg(-38, 6000));
  cal.ingestAmbient(seg(-16, 1500));
  const s = cal.beginSession('listen');
  test('S1 B* 只取排除窗口之前的背景素材',
    Math.abs(s.background_db + 38) < 0.5);
  cal.ingestSegment(seg(-16, 1500));
  test('S2 会话内合格语音素材建立 R*',
    Math.abs(cal.snapshot().user_db + 16) < 0.5 && cal.snapshot().frozen === true);
  const g = new RelativeForegroundGate();
  g.setReferences(cal.references());
  test('S3 两个锚点直接给出可用的 T', g.ready === true && g.thresholdDb === -27);
}
{
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-38, 6000));
  cal.ingestAmbient(seg(-38, 1500));           // listen：开门前没人说话
  const s = cal.beginSession('listen');
  test('S4 listen 模式开门时只有 B*，R* 还没有', s.background_db !== null && s.user_db === null);
  const g = new RelativeForegroundGate();
  g.setReferences(cal.references());
  test('S5 只有一个参考 ⇒ 不 ready ⇒ 判段一律 KEEP',
    g.ready === false && g.decide(seg(-40, 4000), 10).decision === 'KEEP');
  cal.ingestSegment(seg(-15, 1600));           // 使用者说了第一句
  g.setReferences(cal.references());
  test('S6 头几句把 R* 建起来之后 gate 才开始工作',
    cal.snapshot().frozen === true && g.ready === true);
  test('S7 建起来之后纯背景段 DROP',
    g.decide(seg(-40, 4000), 10).decision === 'DROP');
}
{
  /**
   * ⭐ 真机逼出来的一条：listen 模式下开门 2 秒内 VAD 就 published 了一段**背景**
   *   （背景本身是连续人声），第一版没有资格门槛，于是 R* 被它定死且低于 B*。
   *   现在这样的段**根本进不了** R*——「谁算用户素材」由独立测得的 B* 来判，不是先到先得。
   */
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-38, 7500));
  cal.beginSession('listen');
  cal.ingestSegment(seg(-37, 1600));           // 一段背景冒充用户
  test('S8 背景电平的段没有资格定义 R*，被明确拒绝并计数',
    cal.snapshot().user_db === null && cal.snapshot().frozen === false
    && cal.snapshot().user_rejected_ms === 1600
    && cal.snapshot().note.startsWith('user_material_too_quiet'));
  const g = new RelativeForegroundGate();
  g.setReferences(cal.references());
  test('S8b 此时仍然没有 gate（一律 KEEP），而不是误杀',
    g.ready === false && g.decide(seg(-38, 4000), 10).decision === 'KEEP');
  cal.ingestSegment(seg(-18, 1600));           // 使用者真的说话了
  g.setReferences(cal.references());
  test('S8c 真正高出背景的段一到，R* 立刻建起来、门开始工作',
    cal.snapshot().frozen === true && g.ready === true
    && g.decide(seg(-38, 4000), 10).decision === 'DROP');
}
{
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-38, 1000));           // 素材不够
  const s = cal.beginSession('listen');
  test('S9 背景素材不够就不定 B*，并说得出是为什么',
    s.background_db === null && s.note.startsWith('background_too_short'));
}
{
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-38, 6000));
  cal.ingestAmbient(seg(-16, 1500));
  cal.beginSession('listen');
  const before = JSON.stringify(cal.references());
  for (let i = 0; i < 30; i += 1) cal.ingestSegment(seg(-45, 4000));
  test('S10 冻结之后再喂 30 段也改不动参考（判定不回写）',
    JSON.stringify(cal.references()) === before);
  cal.beginSession('listen');
  test('S11 新会话重新校准——参考是 session-local',
    cal.snapshot().started_at_ms !== null && cal.snapshot().source === 'listen');
}

// ── primeAmbient：整窗替换（本轮把 ambient 的来源从 10Hz RMS 流换成 App 一次取回）──
/**
 * ⭐ 这一组钉的是**对齐**，不是「批量喂」。`beginSession` 的取窗是**相对环尾**算的，
 *   所以环尾必须正好是素材的尾。追加会让环尾落在「HTTP 回来的那一刻」，
 *   于是背景窗随网络抖动整体平移——而平移之后它照样能定出一个 B*，
 *   ⛔ 不报错、看起来完全正常，只是量的不是那一段。
 */
{
  const cal = new SessionCalibrator();
  cal.primeAmbient([...seg(-38, 6000), ...seg(-16, 1500)]);
  const s = cal.beginSession('listen');
  test('S12 整窗预置后 B* 与逐帧喂给出同一个答案',
    Math.abs(s.background_db + 38) < 0.5);
}
{
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-70, 7500));                        // 上一场留下的旧素材
  cal.primeAmbient([...seg(-38, 6000), ...seg(-16, 1500)]); // 这一场的素材
  const s = cal.beginSession('listen');
  test('S13 ⛔ prime 是替换不是追加：旧素材不得参与，也不得把窗口推走',
    Math.abs(s.background_db + 38) < 0.5);
}
{
  const cal = new SessionCalibrator();
  const ms = cal.primeAmbient(seg(-38, 3000));
  const s = cal.beginSession('listen');
  test('S14 素材不足时如实拒绝定 B*（⛔ 不补齐、不假装够）',
    ms === 3000 && s.background_db === null && String(s.note).startsWith('background_too_short'));
}
{
  const cal = new SessionCalibrator();
  cal.ingestAmbient(seg(-38, 7500));
  cal.primeAmbient([]);                                     // 取素材失败的那条路径
  const s = cal.beginSession('listen');
  test('S15 取不到素材 ⇒ 没有 B* ⇒ 后面整场 KEEP（失败保护方向朝外）',
    s.background_db === null && new RelativeForegroundGate().ready === false);
}

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

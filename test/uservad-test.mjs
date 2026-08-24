/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: UserVadState / LabelStats 纯逻辑 + speaker-lab / main / package / 页面的接线
 * [OUTPUT]: docs/080 §17 点名的每一项：滚动缓冲、窗调度、迟滞、实时改参、标签统计、
 *           episode 保留 10 个、Mic Off 复位、不碰 ASR/records
 * [POS]: ⭐ 判据的形状在纯逻辑层钉死；接线层只钉「不能再犯」的那几条。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserVadState, LabelStats, USERVAD_DEFAULTS, RECOMMENDED_WINDOWS, describe }
  from '../service/speaker/uservad.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lab = fs.readFileSync(path.join(root, 'service/speaker-lab.mjs'), 'utf8');
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
const js = fs.readFileSync(path.join(root, 'web/speaker.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web/speaker.html'), 'utf8');

const feed = (s, sims) => sims.map((v) => s.push({ similarity: v }));

// ── 迟滞 ────────────────────────────────────────────────────────────────
{
  const s = new UserVadState();
  test('V1 默认就是离线 PoC 验过的那一组',
    USERVAD_DEFAULTS.window_ms === 1500 && USERVAD_DEFAULTS.step_ms === 250
    && USERVAD_DEFAULTS.threshold === 0.30);
  let r = feed(s, [0.5]);
  test('V2 一个窗越阈还不够（on_windows=2）', r[0].state === 'OTHER' && r[0].on_streak === 1);
  r = feed(s, [0.5]);
  test('V3 连续两个才进 USER，并记下 transition',
    r[0].state === 'USER' && r[0].transition === 'OTHER->USER');
  r = feed(s, [0.1]);
  test('V4 掉一个窗不出来（off_windows=2）', r[0].state === 'USER' && r[0].off_streak === 1);
  r = feed(s, [0.1]);
  test('V5 连续两个才回 OTHER', r[0].state === 'OTHER' && r[0].transition === 'USER->OTHER');
  test('V6 四个量同时吐出——否则「模型没认出」与「迟滞没数够」分不开',
    ['raw_match', 'on_streak', 'off_streak', 'state'].every((k) => k in r[0]));
}
// ── 实时改参 ────────────────────────────────────────────────────────────
{
  const s = new UserVadState();
  const r = s.configure({ threshold: 0.5 });
  test('V7 改阈值不提示重校（只有窗长会）', r.window_changed === false && r.recalibrate_hint === false);
  const r2 = s.configure({ window_ms: 1000 });
  test('V8 ⭐ 换窗长必须提示重新校准阈值（阈值与窗长绑定）',
    r2.window_changed === true && r2.recalibrate_hint === true);
  s.acknowledgeCalibration();
  test('V9 使用者确认后提示消失', s.snapshot().recalibrate_hint === false);
  s.configure({ on_windows: 0.4, off_windows: -3 });
  test('V10 迟滞窗数下限是 1，不许变成 0 或负数',
    s.config.on_windows === 1 && s.config.off_windows === 1);
}
// ── 标签只统计，不参与判决 ──────────────────────────────────────────────
{
  const st = new LabelStats();
  // ⚠ 第二个参数是 VAD 概率：只有「当时确实有人在说话」的窗才进定阈值那一组。
  st.setLabel('USER'); [0.8, 0.85, 0.9, 0.82, 0.88].forEach((v) => st.add(v, 0.9));
  st.setLabel('OTHER_NEAR'); [0.3, 0.35, 0.28, 0.31, 0.33].forEach((v) => st.add(v, 0.9));
  const sg = st.windowPercentileSuggestion();
  // ⚠ V11/V12/V22/V23/V18 测的是**保留作对照**的逐窗分位数规则；
  //    运行时用的是下面 V24+ 那套按迟滞模拟的判据。
  test('V11 分得开时给中点，并报出余量',
    sg.ok === true && sg.threshold > 0.35 && sg.threshold < 0.8 && sg.margin > 0);
  st.setLabel('OTHER_NEAR'); st.add(0.95, 0.9);
  // ⚠ 只有 6 个 other 样本，抗离群规则不适用（p95==max），如实报「样本不够」而不是 overlap。
  test('V12 一旦重叠就明说重叠，⛔ 不给一个假装有意义的数',
    st.windowPercentileSuggestion().ok === false
    && st.windowPercentileSuggestion().reason.startsWith('overlap'));
  /**
   * ⭐ 真机逼出来的那一条：按相位打标签会把相位内的**静默**算进去，
   *   于是 USER 的 p10 描述的是静默（真机实测 −0.02），规则永远只报重叠。
   */
  const q = new LabelStats();
  q.setLabel('USER');
  [0.85, 0.88, 0.9, 0.86, 0.87].forEach((v) => q.add(v, 0.9));       // 说话
  [0.01, -0.02, 0.03, 0.0, 0.02].forEach((v) => q.add(v, 0.02));     // 同一相位里的静默
  q.setLabel('OTHER_NEAR'); [0.3, 0.32, 0.29, 0.31, 0.33].forEach((v) => q.add(v, 0.9));
  const s2 = q.snapshot();
  test('V17 含静默那组的 p10 会被静默拖到 0 附近', s2.labels.USER.p10 < 0.1);
  /**
   * ⭐ 真机实测：1500 ms 的窗跨过标签切换点，切到 BACKGROUND 之后约 6 个窗里
   *   还含着使用者刚说完的话（0.565 / 0.419），被记成「背景」后
   *   一票否决掉整个建议阈值。跨界的窗记进任何一栏都是错的。
   */
  const tr = new LabelStats();
  tr.setLabel('USER'); tr.add(0.9, 0.9, true);
  tr.setLabel('BACKGROUND');
  tr.add(0.56, 0.9, false);                       // 窗里还有上一类的音频
  tr.add(0.05, 0.9, true);
  test('V20 跨标签切换的窗不进任何一栏，并计数',
    tr.snapshot().labels.BACKGROUND.n === 1 && tr.snapshot().impure_dropped === 1);
  test('V21 isPure 按窗长判断：切换后不足一个窗长即不纯',
    tr.isPure(1500, Date.now()) === false && tr.isPure(0, Date.now()) === true);
  /** 单个离群窗不该一票否决——给抗离群的实用判据，并如实说有几个窗超过。 */
  const ol = new LabelStats();
  ol.setLabel('USER'); [0.7,0.72,0.75,0.78,0.8,0.82].forEach((v)=>ol.add(v,0.9,true));
  ol.setLabel('BACKGROUND');
  // ⚠ n 必须够大，否则 p95 就是 max（最近秩法），抗离群等于没做。
  [...Array(29)].forEach((_,i)=>ol.add(0.05+i*0.006,0.9,true));
  ol.add(0.9, 0.9, true);                          // 一个离群窗
  const sg2 = ol.windowPercentileSuggestion();
  test('V22 一个离群窗不再让规则报重叠，但会如实标注它不是严格分离',
    sg2.ok === true && sg2.strict === false && sg2.other_over_threshold === 1);
  const few = new LabelStats();
  few.setLabel('USER'); [0.7,0.72,0.75,0.78,0.8,0.82].forEach((v)=>few.add(v,0.9,true));
  few.setLabel('BACKGROUND'); [0.05,0.1,0.15,0.2,0.9].forEach((v)=>few.add(v,0.9,true));
  test('V23 样本太少时不假装抗离群，明说是样本不够',
    few.windowPercentileSuggestion().reason === 'overlap_but_too_few_other_samples');
  test('V18 ⭐ 定阈值只看说话中那组，于是仍然分得开',
    s2.labels_speech.USER.p10 > 0.8 && s2.window_percentiles.ok === true);
  test('V19 静默窗不进 speech 组', s2.labels_speech.USER.n === 5 && s2.labels.USER.n === 10);
  /* ── 运行时判据：按迟滞模拟，而不是逐窗分位数 ─────────────────────────
   * ⭐ 这一组直接编码真机那份数据的形状（docs/081）：背景 101 个窗里只有 13 个
   *   越过 0.45，而且挤成**两段连续尖峰**；逐窗 p95 因此报「重叠、无解」，
   *   而运行时问的是「背景会不会触发」。判据的单位必须和系统的单位一致。
   */
  {
    const rt = new LabelStats();
    rt.setLabel('USER');
    // 用户：说话时 0.6~0.75，中间夹着静默（静默会打断 on_streak，运行时就是这样）
    for (let i = 0; i < 30; i += 1) rt.add(i % 6 === 5 ? 0.05 : 0.62 + (i % 5) * 0.02, 0.9, true);
    rt.setLabel('BACKGROUND');
    // 背景：绝大多数很低，但有**孤立**的高点——孤立点不该让判据崩掉
    for (let i = 0; i < 40; i += 1) rt.add(i === 7 || i === 21 ? 0.58 : 0.05 + (i % 4) * 0.03, 0.9, true);
    const sg = rt.suggestedThreshold({ on_windows: 2, off_windows: 2 });
    test('V24 ⭐ 背景只有孤立高点时，判据不再报「无解」（迟滞要求连续两个）',
      sg.ok === true && sg.other_enters === 0 && sg.user_on_ratio > 0.5);
    test('V25 给出的阈值确实让背景零触发',
      LabelStats.simulate([...rt.values.BACKGROUND],
        { threshold: sg.threshold, onWindows: 2, offWindows: 2 }).enters === 0);
    test('V26 同一份数据，逐窗分位数规则会报重叠——两套判据的差别是真的',
      rt.windowPercentileSuggestion().ok === false);

    const hard = new LabelStats();
    hard.setLabel('USER');
    for (let i = 0; i < 30; i += 1) hard.add(0.6 + (i % 5) * 0.02, 0.9, true);
    hard.setLabel('BACKGROUND');
    // 背景里有一段**持续**的高分（真机那两段尖峰就是这个形状）
    for (let i = 0; i < 40; i += 1) hard.add(i >= 10 && i < 18 ? 0.66 : 0.05, 0.9, true);
    const hs = hard.suggestedThreshold({ on_windows: 2, off_windows: 2 });
    test('V27 ⛔ 背景里有持续高分时，如实说没有干净阈值，不硬给一个',
      hs.ok === false && hs.reason === 'overlap');
    test('V28 但要给出折中点与代价，让人自己权衡',
      hs.best_effort !== null && typeof hs.best_effort.other_enters === 'number');
    test('V29 表格覆盖整个取值域，供页面画出来', hs.table.length === 61);

    test('V30 ⭐ 迟滞模拟就是运行时那台状态机：孤立越阈不进 USER', (() => {
      const one = LabelStats.simulate([0, 0.9, 0, 0.9, 0], { threshold: 0.5, onWindows: 2 });
      const two = LabelStats.simulate([0, 0.9, 0.9, 0, 0], { threshold: 0.5, onWindows: 2 });
      return one.enters === 0 && two.enters === 1;
    })());
    test('V31 样本不够就说不够（新判据同样不假装）',
      new LabelStats().suggestedThreshold().reason === 'not_enough_samples');

    /**
     * ⭐ 真机逼出来的最后一条：⛔ **不要选悬崖边**。
     *   第一版「背景零触发里用户覆盖最高」在真机数据上给出 0.35，
     *   而背景的地板正是 0.36——换一段电视节目它立刻开始误收。
     *   可用带两端是两种失败：低端背景开始触发，高端使用者自己被挡；取中点。
     */
    const cliff = new LabelStats();
    cliff.setLabel('USER');
    // 用户 0.50~0.62：覆盖在 0.62 以上开始塌
    for (let i = 0; i < 40; i += 1) cliff.add(0.50 + (i % 7) * 0.02, 0.9, true);
    cliff.setLabel('BACKGROUND');
    // 背景大多很低，但有一段连续 0.30 —— 于是背景地板在 0.31 附近
    for (let i = 0; i < 40; i += 1) cliff.add(i >= 12 && i < 20 ? 0.30 : 0.02, 0.9, true);
    const cs = cliff.suggestedThreshold({ on_windows: 2, off_windows: 2 });
    test('V32 ⭐ 选可用带中点，⛔ 不贴着背景地板',
      cs.ok === true && cs.threshold > cs.band_low && cs.threshold < cs.band_high
      && cs.margin_below >= 0.05);
    test('V33 中点两侧的余量都报出来，让人自己判断够不够',
      typeof cs.margin_below === 'number' && typeof cs.margin_above === 'number');
    test('V34 建议值确实让背景零触发',
      LabelStats.simulate(cliff.values.BACKGROUND,
        { threshold: cs.threshold, onWindows: 2, offWindows: 2 }).enters === 0);
    test('V35 且用户覆盖不低于 90%（上沿的判据）', cs.user_on_ratio >= 0.9);
  }

  const fresh = new LabelStats();
  test('V13 样本不够就说不够', fresh.windowPercentileSuggestion().reason === 'not_enough_samples');
  test('V14 认不得的标签不写入', fresh.setLabel('NONSENSE') === 'UNLABELED');
  test('V15 describe 空输入不炸', describe([]).n === 0);
  const s = new UserVadState();
  s.push({ similarity: 0.9 });
  test('V16 push 不接受标签参数——判据看不到标签',
    !/push\(\{[^}]*label/.test(fs.readFileSync(
      path.join(root, 'service/speaker/uservad.mjs'), 'utf8')));
}
// ── 接线：本轮的结构红线 ────────────────────────────────────────────────
{
  test('S1 ⭐ CAM++ 的窗由 rolling buffer + step 驱动，不由 VAD segment 决定',
    lab.includes('this.msSinceWindow >= this.uservad.config.step_ms')
    && lab.includes('#runWindow'));
  test('S2 VAD 只提供显示用的概率，并在状态里说明它的角色',
    lab.includes("vad_role: 'display_only__does_not_cut_campplus_windows'"));
  test('S3 滑窗单飞并统计跳过次数——排队会让延迟越积越大',
    lab.includes('if (this.camInFlight) { this.skippedWindows += 1; return; }'));
  test('S4 攒不满一个窗不推理', lab.includes('if (!chunk) return;'));
  test('S5 没有声纹就不跑 CAM++', lab.includes('if (!this.profile.ready) return;'));
  test('S6 episode 按最终 USER 状态录，带 pre/post roll',
    lab.includes("transition === 'OTHER->USER'") && lab.includes('POST_ROLL_MS')
    && lab.includes('PRE_ROLL_MS'));
  test('S7 episode 最多 10 个且连 WAV 一起删',
    lab.includes('KEEP_EPISODES = 10') && /episodes\.length > KEEP_EPISODES[\s\S]{0,220}rmSync/.test(lab));
  test('S8 Mic 总开关关掉 ⇒ 回 idle 且不自行恢复',
    lab.includes('forceIdle(') && main.includes("speakerLab.forceIdle('mic_off')"));
  test('S9 runtime 配置与声纹分开存——0.57 与 0.30 不是同一个东西',
    lab.includes('#runtimePath()') && lab.includes('uservad.json'));
  test('S10 时间轴走专用增量端点，⛔ 不塞进 /live',
    main.includes("sub === '/timeline'") && lab.includes('timelineSince('));
  /**
   * ⚠ 子串检查必须**先剥掉注释**：头部那句「⛔ 不进 SenseVoice、不 records.admit」
   *   本身就含有这些词，会把「绝不调用 X」的测试用「声明绝不调用 X 的注释」打红。
   */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const labCode = stripComments(lab);
  test('S11 ⛔ 这一页不碰 ASR / records / 50 句（只看代码，不看注释）',
    !/\brecords\./.test(labCode) && !/asr\.enqueue/.test(labCode)
    && !/SenseVoice|Audio8/.test(labCode));
  const used = [...js.matchAll(/'(\/speaker\/[\w/-]+)'/g)].map((m) => m[1])
    .concat([...js.matchAll(/`(\/speaker\/[\w/-]+)\?/g)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((r) => !pkg.includes(`'${r}'`));
  test(`S12 页面用到的每个端点都在 package.mjs 注册过${missing.length ? ` — 缺 ${missing.join(', ')}` : ''}`,
    used.length > 0 && missing.length === 0);
  const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const declared = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const absent = [...ids].filter((k) => !declared.has(k));
  test(`S13 页面引用的每个 id 都存在${absent.length ? ` — 缺 ${absent.join(', ')}` : ''}`,
    absent.length === 0);
  test('S14 建议阈值绝不自动应用，必须点一下',
    js.includes("$('suggest-apply').onclick") && !lab.includes('autoApplyThreshold'));
  test('S15 页面明确提示「换窗长要重校阈值」', js.includes('recalibrate_hint'));
  test('S16 750/1000/1500/2000 是推荐值，500 只能手输',
    JSON.stringify(RECOMMENDED_WINDOWS) === JSON.stringify([750, 1000, 1500, 2000])
    && js.includes('500 ms（不推荐）'));
  /**
   * ⭐ 真机踩过：上一轮脚本把标签留在 OTHER_NEAR，使用者接着登记自己的声纹再测试，
   *   **说的每一句都被记进「另一个人」那一栏**（判决是对的，8 次 OTHER→USER），
   *   而被污染的统计又直接喂给建议阈值。标签是对「这一次录音」的陈述。
   */
  test('S18 每次开始都把标签复位为 UNLABELED',
    /uservad\.reset\(\);[\s\S]{0,700}this\.labels\.setLabel\('UNLABELED'\)/.test(lab));
  test('S19 阈值绑的是 (声纹, 窗长)——重建声纹同样要提示重校',
    /buildProfile\(\)[\s\S]{0,500}calibrationStale = true/.test(lab));
  test('S20 当前标签与状态同样醒目', html.includes('id="label-badge"')
    && js.includes("$('label-badge')"));
  test('S17 speaker 仍是独立 consumer，且只有开始时才启用',
    main.includes("setConsumer('speaker', true)") && main.includes("setConsumer('speaker', false)"));
}

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

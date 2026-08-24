/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: SpeakerProfile 纯逻辑 + speaker-lab / main.mjs / package.mjs / 页面的接线
 * [OUTPUT]: docs/080 点名的安全性质与「页面真的打得通」的机械保证
 * [POS]: ⭐ 安全侧与 docs/076/079 完全一致：**不知道你是谁**绝不等于**把你丢掉**。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeakerProfile, cosine, l2norm, describe, EMBEDDING_DIM } from '../service/speaker/profile.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
const lab = fs.readFileSync(path.join(root, 'service/speaker-lab.mjs'), 'utf8');
const cam = fs.readFileSync(path.join(root, 'service/speaker/campplus.mjs'), 'utf8');

/** 造一个可控的「说话人」：基向量 + 噪声，方向稳定。 */
const speaker = (seed, jitter = 0) => {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  const base = Array.from({ length: EMBEDDING_DIM }, () => rnd());
  return (n = 0) => l2norm(base.map((v) => v + jitter * rnd() * (n + 1)));
};

// ── 安全性质：不知道你是谁 ≠ 把你丢掉 ───────────────────────────────────
{
  const p = new SpeakerProfile();
  const d = p.decide(speaker(1)(), 3000);
  test('P1 没有声纹一律 KEEP，并说得出原因',
    d.verdict === 'KEEP' && d.reason === 'no_profile' && d.similarity === null);
  test('P2 段太短一律 KEEP（短段 embedding 不可信）',
    p.decide(speaker(1)(), 400).reason === 'too_short');
}
// ── 登记 ────────────────────────────────────────────────────────────────
{
  const me = speaker(7, 0.25);
  const p = new SpeakerProfile();
  test('P3 一段就想生成声纹会被拒——那等于把一次口误钉成身份',
    (p.addEnrollment(me(0)), p.build().reason) === 'not_enough_enrollments');
  p.addEnrollment(me(1)); p.addEnrollment(me(2));
  const built = p.build();
  test('P4 够三段才生成，并给出登记内部一致性', built.ok === true && built.pairwise.n === 3);
  test('P5 参考是单位向量', Math.abs(Math.hypot(...p.reference) - 1) < 1e-9);
  const other = speaker(99, 0.25);
  const mine = p.decide(me(3), 3000);
  const theirs = p.decide(other(0), 3000);
  test('P6 本人 KEEP、他人 DROP', mine.verdict === 'KEEP' && theirs.verdict === 'DROP');
  test('P7 判定携带 similarity 与当时的 threshold',
    typeof mine.similarity === 'number' && mine.threshold === p.config.threshold);
}
// ── 判定永不回写声纹 ────────────────────────────────────────────────────
{
  const me = speaker(3, 0.2);
  const p = new SpeakerProfile();
  for (let i = 0; i < 4; i += 1) p.addEnrollment(me(i));
  p.build();
  const before = JSON.stringify(p.reference);
  const other = speaker(55, 0.2);
  for (let i = 0; i < 30; i += 1) { p.decide(me(i), 3000); p.decide(other(i), 3000); }
  test('P8 60 次判定之后声纹逐位不变（docs/078 的正反馈不许重演）',
    JSON.stringify(p.reference) === before && p.enrollments.length === 4);
}
// ── 持久化 ──────────────────────────────────────────────────────────────
{
  const me = speaker(11, 0.2);
  const p = new SpeakerProfile();
  for (let i = 0; i < 3; i += 1) p.addEnrollment(me(i));
  p.build();
  const back = SpeakerProfile.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  // ⚠ 探针向量要**先算好再用**：`me()` 每次调用都会推进内部随机状态，
  //   写成 `back.decide(me(9)) vs p.decide(me(9))` 比的是两个不同的输入——
  //   第一版就是这么写的，红了才发现错在测试不在代码。
  const probe = me(9);
  test('P9 存盘再读回，参考与判定完全一致',
    back.ready && Math.abs(back.decide(probe, 3000).similarity
                           - p.decide(probe, 3000).similarity) < 1e-9);
  test('P10 维度不对的声纹**不认**，宁可当作没有',
    SpeakerProfile.fromJSON({ reference: [1, 2, 3] }).ready === false);
}
{
  test('P11 describe 空输入不炸', describe([]).n === 0);
  test('P12 零向量没有方向，l2norm 返回 null 而不是 NaN 向量',
    l2norm(new Array(EMBEDDING_DIM).fill(0)) === null);
  test('P13 cosine 是内积（两侧都已归一化）',
    Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-12);
}
// ── 接线 ────────────────────────────────────────────────────────────────
{
  test('S1 speaker 是独立的 consumer，开它不动别人',
    main.includes("{ name: 'speaker', wantsPcm: true") && main.includes("consumers.enabled('speaker')"));
  test('S2 自带一张 VAD 图——第三个消费者共用有状态流会互相污染',
    main.includes("`${VAD_RESIDENT_ID}-spk`"));
  test('S3 CAM++ 走 CPU，不抢 NPU', cam.includes("backend: 'cpu'"));
  test('S4 要拿回张量必须显式 return_outputs + output_mode=raw',
    cam.includes('return_outputs: true') && cam.includes("output_mode: 'raw'"));
  test('S5 前处理复用 VAD 那份 fbank（实测与 Kaldi 一致），不另写一份',
    cam.includes("from '../vad/fbank.mjs'"));
  // ⚠ 这三条原本钉的是**段级**实现的字符串。docs/080 把实时判定改成滑窗之后
  //   那些字符串不存在了——钉住的应该是行为，不是当时那一行代码长什么样。
  test('S6 停止时把手上的登记段与 episode 都收掉，不让最后一句凭空消失',
    lab.includes("if (this.segment) void this.#closeEnrollSegment('stopped')")
    && lab.includes("if (this.episode) this.#finishEpisode('stopped')"));
  test('S7 登记时算不出来记 ERROR，绝不悄悄丢掉',
    lab.includes("status: 'ERROR'"));
  test('S8 太短的登记段丢弃且不留 WAV',
    lab.includes('durationMs < this.enrollConfig.min_segment_ms) return;'));
  /** ⭐ 漏注册 = Framework 回 unknown_package_route，而写操作若丢弃响应就完全看不见。 */
  const jsSrc = fs.readFileSync(path.join(root, 'web/speaker.js'), 'utf8');
  const used = [...jsSrc.matchAll(/'(\/speaker\/[\w/-]+)'/g)].map((m) => m[1]);
  const missing = used.filter((r) => !pkg.includes(`'${r}'`));
  test(`S9 页面用到的每个 /speaker 端点都在 package.mjs 注册过${missing.length ? ` — 缺 ${missing.join(', ')}` : ''}`,
    used.length > 0 && missing.length === 0);
  test('S10 试听 URL 与代理层注册的形状一致（query，不是路径段）',
    pkg.includes("context.routes.register('GET', '/speaker/audio'")
    && jsSrc.includes('/speaker/audio?clip='));
  const html = fs.readFileSync(path.join(root, 'web/speaker.html'), 'utf8');
  const ids = new Set([...jsSrc.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const declared = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const absent = [...ids].filter((k) => !declared.has(k));
  test(`S11 页面引用的每个 id 都存在${absent.length ? ` — 缺 ${absent.join(', ')}` : ''}`,
    absent.length === 0);
  test('S12 页面走 Browser Session 且 base 是 /api/packages',
    jsSrc.includes('window.TermuxOS.api') && jsSrc.includes('`/api/packages/${')
    && !/fetch\(/.test(jsSrc));
  test('S13 请求失败必须看得见，不许静默吞掉',
    !jsSrc.includes('.catch(() => null)\n') || jsSrc.includes('note.className = \'note bad\''));
  test('S14 内容放在 .page 里（全站只有它会滚）', html.includes('<section class="page">'));
  test('S15 My Voice 是原生产品页且不跳旧 Speaker Lab', (() => {
    const index = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
    return index.includes('data-page="voice"') && !index.includes('href="speaker.html"');
  })());
}

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

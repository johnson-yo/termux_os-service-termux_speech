/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个真实目录里的 profile.json + enroll-*.wav
 * [OUTPUT]: 登记样本索引在**重启后**仍然存在、可播、可删的回归
 * [POS]: ⭐ 这一组守的是一个真实用户 bug：盘上 7 段音频都在、profile 说有 7 段，
 *        而页面上一个都点不了——因为索引只活在内存里。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
let count = 0;
const test = (name, cond, detail = '') => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};

/** 只测索引重建这一段纯逻辑：⛔ 不起 ORT、不连 App。 */
const { SpeakerLab } = await import('../service/speaker-lab.mjs');

const wavBytes = (ms = 1000) => {
  const samples = Math.round(16000 * (ms / 1000));
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.write('WAVE', 8);
  return b;
};

const makeRoot = (enrollments, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-'));
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify({
    version: 1, config: {}, built_at_ms: 1, reference: null, pairwise: null,
    enrollments: enrollments.map((e, i) => ({
      id: e.id, duration_ms: e.duration_ms ?? 1000, at_ms: e.at_ms ?? (1000 + i),
      embedding: new Array(192).fill(0.05),
    })),
  }));
  for (const f of files) fs.writeFileSync(path.join(root, f), wavBytes());
  return root;
};

/** 只构造对象、不启动任何图。 */
const labAt = (root) => new SpeakerLab({
  android: null, embedder: null, vadModelRoot: root, dataRoot: root,
  residentId: 'test', onChange: () => {},
});

// ── 1. 重启恢复 ────────────────────────────────────────────────────────────

{
  const root = makeRoot(
    [{ id: 'enroll-1-100' }, { id: 'enroll-2-200' }, { id: 'enroll-3-300' }],
    ['enroll-1-100.wav', 'enroll-2-200.wav', 'enroll-3-300.wav'],
  );
  const lab = labAt(root);
  const clips = lab.enrollClips;
  test('E1 ⭐ 重启后样本列表从 profile + 盘上文件重建（不再是空的）', clips.length === 3, `${clips.length}`);
  test('E2 每一段都有可播放的文件名', clips.every((c) => /^enroll-.*\.wav$/.test(c.wav)));
  test('E3 全部标为 OK（文件都在）', clips.every((c) => c.status === 'OK'));
  test('E4 ⭐ profile.enrollments 数量 == UI 列表数量（这正是之前不成立的那条）',
    lab.profile.enrollments.length === clips.length);
  test('E5 按时间倒序（最新的在前）', clips[0].at_ms >= clips[clips.length - 1].at_ms);
  test('E6 标记为恢复而来（诊断时分得清现场录的还是恢复的）', clips.every((c) => c.restored === true));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 2. 文件缺失 ────────────────────────────────────────────────────────────

{
  const root = makeRoot([{ id: 'a-1' }, { id: 'a-2' }], ['a-1.wav']);   // a-2.wav 不在
  const lab = labAt(root);
  test('E7 ⚠ 文件没了仍然列出来，但标 MISSING（⛔ 不悄悄跳过）',
    lab.enrollClips.length === 2
      && lab.enrollClips.find((c) => c.id === 'a-2').status === 'MISSING');
  test('E8 缺失的那一段说得出原因',
    lab.enrollClips.find((c) => c.id === 'a-2').error === 'wav_missing');
  test('E9 在场的那一段照常 OK', lab.enrollClips.find((c) => c.id === 'a-1').status === 'OK');
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 3. 孤儿 WAV ────────────────────────────────────────────────────────────

{
  const root = makeRoot([{ id: 'b-1' }], ['b-1.wav', 'enroll-orphan-9.wav']);
  const lab = labAt(root);
  test('E10 ⛔ 孤儿 WAV 不进产品列表（它不属于任何声纹）', lab.enrollClips.length === 1);
  test('E11 但要报得出数（诊断用，⛔ 本轮不删）', lab.orphanEnrollWavs().length === 1);
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * ⭐ **孤儿必须离开登记录音的目录。**
 *   真机上 `speaker-lab/` 曾同时躺着 17 个 `enroll-*.wav` 而 profile 只认 7 个，
 *   于是 `ls enroll-* | head -1` 选中的是一段没登记过的录音——一整轮排障
 *   把「CAM++ 坏了」追了下去，而 CAM++ 一直是好的。
 * ⛔ 判据是「登记目录里 glob 不到孤儿」，不是「孤儿被删了」。
 */
{
  const root = makeRoot([{ id: 'c-1' }], ['c-1.wav', 'enroll-orphan-1.wav', 'enroll-orphan-2.wav']);
  const lab = labAt(root);
  const globbed = fs.readdirSync(root).filter((f) => f.startsWith('enroll-') && f.endsWith('.wav'));
  test('E12 登记目录里 `enroll-*.wav` 只剩登记过的那些', globbed.length === 0);
  test('E13 孤儿被移走而不是删掉，且仍然数得出来', lab.orphanEnrollWavs().length === 2
    && fs.existsSync(path.join(root, 'orphans', 'enroll-orphan-1.wav')));
  test('E14 登记过的录音一个都没动', fs.existsSync(path.join(root, 'c-1.wav'))
    && lab.enrollClips.length === 1 && lab.enrollClips[0].status === 'OK');
  const purged = lab.purgeOrphanEnrollWavs();
  test('E15 显式 purge 才真的删，并报告删了几个', purged.removed.length === 2
    && purged.remaining === 0 && lab.orphanEnrollWavs().length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * ⛔ **profile 读不出来时一个文件都不许动。**
 *   「使用者还没登记」与「profile 没读出来」在这一层长得一模一样，
 *   而按后者行动会把他全部录音一次扫光。
 */
{
  const root = makeRoot([], ['enroll-1-111.wav', 'enroll-2-222.wav']);
  const lab = labAt(root);
  test('E16 没有任何登记记录时不扫（宁可留着孤儿，也不能扫掉真的录音）',
    lab.sweptOrphans.skipped === 'no_profile'
      && fs.existsSync(path.join(root, 'enroll-1-111.wav'))
      && fs.existsSync(path.join(root, 'enroll-2-222.wav')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 4. 删除 ────────────────────────────────────────────────────────────────

{
  const root = makeRoot([{ id: 'c-1' }, { id: 'c-2' }], ['c-1.wav', 'c-2.wav']);
  const lab = labAt(root);
  lab.removeEnrollment('c-1');
  test('E12 删除后列表少一条', lab.enrollClips.length === 1 && lab.enrollClips[0].id === 'c-2');
  test('E13 ⚠ WAV 也一起删掉（只摘索引会每次删除都留一个孤儿）',
    !fs.existsSync(path.join(root, 'c-1.wav')));
  test('E14 ⭐ 删除是持久的：重启后不会回来',
    labAt(root).enrollClips.length === 1);
  test('E15 profile 与列表仍然一致', labAt(root).profile.enrollments.length === 1);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 5. 全新安装 ────────────────────────────────────────────────────────────

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-empty-'));
  const lab = labAt(root);
  test('E16 没有 profile 时是空列表而不是崩溃', Array.isArray(lab.enrollClips) && lab.enrollClips.length === 0);
  test('E17 孤儿扫描在空目录上也安全', lab.orphanEnrollWavs().length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${count - failures}/${count} enrollment assertions passed`);
process.exit(failures ? 1 : 0);

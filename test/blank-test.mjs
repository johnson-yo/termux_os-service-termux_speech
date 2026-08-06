/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: normalizeTranscript / BlankStats / RecordGroups
 * [OUTPUT]: 空白 ASR 结果的行为回归——不输出、不占名额、不留音频、不推游标
 * [POS]: ⭐ 这一套要证明的不是「空白被过滤掉了」，而是**空白在盘上没有留下任何痕迹**：
 *        它不进组、不占那 50 条、不拿 feed 游标、不进 SQLite、WAV 也不留。
 *        判空只有一个函数，所以这里测的那一个答案就是全链读到的那一个答案。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordArchive } from '../service/storage/archive.mjs';
import { GROUP_SIZE, RecordGroups } from '../service/storage/groups.mjs';
import { BlankStats, normalizeTranscript } from '../service/storage/text.mjs';
import { AsrController } from '../service/asr/controller.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-blank-'));

let segmentSeq = 0;
const makeSegment = (wavDir) => {
  segmentSeq += 1;
  const segmentId = `seg-${String(segmentSeq).padStart(5, '0')}`;
  fs.mkdirSync(wavDir, { recursive: true });
  const wavPath = path.join(wavDir, `${segmentId}.wav`);
  fs.writeFileSync(wavPath, Buffer.alloc(64, segmentSeq % 251));
  return { segment_id: segmentId, wav_path: wavPath, duration_ms: 800 };
};

/* ══════════════════════════════════════════════════════════════
   B1. 规范化：九类输入，一个函数回答
   ══════════════════════════════════════════════════════════════ */

const blankCases = [
  ['空字符串', ''],
  ['单个空格', ' '],
  ['换行与 Tab', '\n\t'],
  ['全角空格', '　　'],
  ['不换行空格 NBSP', ' '],
  ['零宽空格 only', '​​​'],
  ['零宽连接符 only', '‌‍'],
  ['BOM only', '﻿'],
  ['不可见控制符 only', ''],
  ['软连字符 only', '­'],
  ['混合不可见与空白', ' ﻿​ \n­\t '],
];
for (const [label, input] of blankCases) {
  const value = normalizeTranscript(input);
  test(`B1 「${label}」判为空白且规范化为空串`, value.isBlank === true && value.text === '');
}

const nonBlankCases = [
  ['正常中文', '你好世界', '你好世界'],
  ['正常英文', 'hello world', 'hello world'],
  ['两端有空白的中文', '  你好  ', '你好'],
  ['夹着零宽字符的中文', '你​好', '你好'],
  // ⛔ 标点-only **不算空白**：使用者可能真的只说了一个语气。
  ['标点 only（不算空白）', '。。。', '。。。'],
  ['问号叹号 only（不算空白）', '?!', '?!'],
];
for (const [label, input, expected] of nonBlankCases) {
  const value = normalizeTranscript(input);
  test(`B2 「${label}」不算空白，规范化为 ${JSON.stringify(expected)}`,
    value.isBlank === false && value.text === expected);
}

test('B3 null / undefined 与空串同解，不抛异常',
  normalizeTranscript(null).isBlank === true && normalizeTranscript(undefined).isBlank === true);

test('B4 Unicode 规范化到 NFC：分解形与合成形给出同一个答案',
  normalizeTranscript('Å').text === normalizeTranscript('Å').text);

/**
 * ⭐ 三种空白分开记。它们对应三种不同的上游故障：
 * 解码真的什么都没出、解码出了空白字符、解码出了不可见字符。
 */
test('B5 空白原因可区分，不压成一个笼统的 blank',
  normalizeTranscript('').reason === 'empty'
    && normalizeTranscript('  ').reason === 'whitespace_only'
    && normalizeTranscript('​').reason === 'invisible_only');

/* ══════════════════════════════════════════════════════════════
   B6. 诊断计数：有界，只留三样
   ══════════════════════════════════════════════════════════════ */
{
  let clock = 1000;
  const stats = new BlankStats({ now: () => { clock += 7; return clock; } });
  stats.record('empty');
  stats.record('whitespace_only');
  const snapshot = stats.snapshot();
  test('B6 空白诊断只留 count / last reason / last timestamp——不留音频不留文本',
    snapshot.count === 2
      && snapshot.last_reason === 'whitespace_only'
      && typeof snapshot.last_at_ms === 'number'
      && Object.keys(snapshot).length === 3);
}

/* ══════════════════════════════════════════════════════════════
   B7. 存储：空白在盘上不留任何痕迹
   ══════════════════════════════════════════════════════════════ */

const makeStore = async (name) => {
  const storeRoot = path.join(root, name);
  const archive = new RecordArchive({ file: path.join(storeRoot, 'archive.v1.sqlite3') });
  await archive.open();
  return {
    storeRoot,
    archive,
    groups: new RecordGroups({ root: storeRoot, archive }),
    wavDir: path.join(root, `${name}-staging`),
  };
};

/**
 * 模拟 ASR 的判定：空白就删 staging WAV 并计数，非空白才准入。
 * ⛔ 这里刻意复用**同一个** `normalizeTranscript`——两个地方各判一次，
 * 迟早会出现「界面上没有、盘上却占着一条」这种谁都没说谎的不一致。
 */
const feed = (groups, wavDir, blank, rawText) => {
  const segment = makeSegment(wavDir);
  const normalized = normalizeTranscript(rawText);
  if (normalized.isBlank) {
    blank.record(normalized.reason);
    fs.rmSync(segment.wav_path, { force: true });
    return { segment, admitted: false };
  }
  groups.admit(segment, {
    status: 'succeeded',
    text: normalized.text,
    model: { id: 'sensevoice' },
    inference_ms: 30,
  });
  return { segment, admitted: true };
};

{
  const { groups, wavDir, archive, storeRoot } = await makeStore('discard');
  const blank = new BlankStats();

  const first = feed(groups, wavDir, blank, '');
  test('B7 空白不进记录组：一个组都没开出来',
    groups.liveGroups().length === 0 && groups.snapshot().active === null);
  test('B8 空白的 staging WAV 被删掉，且从未进过任何组目录',
    !fs.existsSync(first.segment.wav_path)
      && !fs.existsSync(path.join(storeRoot, 'group-000001')));
  test('B9 空白不分配 feed 游标，也不进 feed',
    groups.feed(0, 100).observations.length === 0);

  feed(groups, wavDir, blank, '   ');
  feed(groups, wavDir, blank, '​');
  test('B10 连续空白只累加诊断计数，盘上依然什么都没有',
    blank.snapshot().count === 3 && groups.liveGroups().length === 0);

  const good = feed(groups, wavDir, blank, '你好');
  test('B11 空白之后的第一条有效结果顺序正常，就是第 1 条',
    good.admitted
      && groups.snapshot().active.item_count === 1
      && groups.readItems('group-000001')[0].item_seq === 1);

  const feedAfter = groups.feed(0, 100);
  test('B12 feed 里只有那一条有效结果',
    feedAfter.observations.length === 1 && feedAfter.observations[0].text === '你好');
  archive.close();
}

/* ══════════════════════════════════════════════════════════════
   B13. 分组边界：第 50 条与第 101 条候选为空
   ══════════════════════════════════════════════════════════════ */
{
  const { groups, wavDir, archive } = await makeStore('boundary-50');
  const blank = new BlankStats();
  for (let i = 0; i < 49; i += 1) feed(groups, wavDir, blank, `句子 ${i}`);
  test('B13 前置：当前组 49 条', groups.snapshot().active.item_count === 49);

  feed(groups, wavDir, blank, '​\n ');
  test('B14 第 50 条候选为空：当前组保持 49，不满员、不完成、不轮转',
    groups.snapshot().active.item_count === 49
      && groups.group('group-000001').state === 'active'
      && groups.liveGroups().length === 1);

  feed(groups, wavDir, blank, '真正的第五十句');
  test('B15 下一条有效结果才成为第 50 条，该组这时才完成',
    groups.group('group-000001').item_count === GROUP_SIZE
      && groups.group('group-000001').state === 'completed');
  archive.close();
}

{
  const { groups, wavDir, archive, storeRoot } = await makeStore('boundary-101');
  const blank = new BlankStats();
  for (let i = 0; i < 100; i += 1) feed(groups, wavDir, blank, `句子 ${i}`);
  test('B16 前置：两组各 50 条，盘上两组',
    groups.liveGroups().length === 2 && groups.group('group-000002').state === 'completed');

  feed(groups, wavDir, blank, '﻿');
  await groups.rotate();
  test('B17 第 101 条候选为空：不开新组、不触发轮转，最旧那组仍在盘上',
    groups.liveGroups().length === 2
      && fs.existsSync(path.join(storeRoot, 'group-000001'))
      && !archive.isArchived('group-000001'));

  feed(groups, wavDir, blank, '真正的第一百零一句');
  await groups.rotate();
  test('B18 下一条有效结果才触发轮转：最旧组归档进 SQLite 并删目录',
    archive.isArchived('group-000001')
      && !fs.existsSync(path.join(storeRoot, 'group-000001'))
      && groups.snapshot().active.group_id === 'group-000003');

  const archived = archive.query({ limit: 500 });
  test('B19 SQLite 里一条空白都没有——它们从来没进过组，也就没有东西可归档',
    archived.items.length === GROUP_SIZE
      && archived.items.every((row) => String(row.text ?? '').trim().length > 0));
  archive.close();
}

/* ══════════════════════════════════════════════════════════════
   B20. 重启：残留 staging WAV 不会变成记录
   ══════════════════════════════════════════════════════════════ */
{
  const { groups, wavDir, archive, storeRoot } = await makeStore('restart');
  const blank = new BlankStats();
  feed(groups, wavDir, blank, '第一句');
  // 一个还没转写完就断电的段：staging 里留着一份 WAV。
  const orphan = makeSegment(wavDir);

  const revived = new RecordGroups({ root: storeRoot, archive });
  revived.reconcile();
  test('B20 重启后残留 staging WAV 不进组、不计为有效记录',
    revived.snapshot().active.item_count === 1
      && revived.feed(0, 100).observations.length === 1
      && fs.existsSync(orphan.wav_path));
  archive.close();
}

/* ══════════════════════════════════════════════════════════════
   B21. 重转写：已入组的记录不是 staging，空白不得销毁它的音频
   ══════════════════════════════════════════════════════════════ */
{
  const { groups, wavDir, archive } = await makeStore('retranscribe');
  const blank = new BlankStats();
  const segment = makeSegment(wavDir);
  groups.admit(segment, { status: 'succeeded', text: '原来这句', model: { id: 'sensevoice' } });
  const before = groups.readItems('group-000001')[0];
  const seqBefore = before.feed_seq;

  // 重转写出了一个更好的结果：就地更新，不新建、不动游标。
  groups.retranscribe(segment.segment_id, {
    status: 'succeeded', text: '重转写之后', model: { id: 'qwen3-q4' }, inference_ms: 90,
  });
  const items = groups.readItems('group-000001');
  test(
    'B21 重转写就地更新原记录：不新建 item、不重发 feed 游标',
    items.length === 1
      && items[0].text === '重转写之后'
      && items[0].model.id === 'qwen3-q4'
      && items[0].feed_seq === seqBefore,
  );
  test(
    'B22 重转写不移动也不删除 WAV——它已经归属于这条记录',
    items[0].wav_path === before.wav_path && fs.existsSync(items[0].wav_path),
  );

  /**
   * ⭐ 我自己引入的回归，在这里钉住：`discardBlank` 原本无条件删 `wav_path`，
   * 而重转写拿到的是**记录组目录里**那一份。一次识别失败绝不能销毁用户的音频。
   *
   * ⚠ 直接驱动**真的那个方法**。在测试里重抄一遍那个条件判断不是测试，是复述——
   * 代码改回去它照样绿。
   */
  const owned = items[0].wav_path;
  const fake = { blank: new BlankStats(), completedSegments: [], authority: false, epoch: 0 };
  AsrController.prototype.discardBlank.call(
    fake,
    { retranscribe: true, epoch: 0, segment: { segment_id: segment.segment_id, wav_path: owned } },
    { inference_ms: 12 },
    'empty',
  );
  test(
    'B23 重转写结果为空白时不删 WAV，原记录的音频原样留着',
    fs.existsSync(owned) && fake.blank.snapshot().count === 1,
  );

  // 反面：普通新段的 staging WAV 必须真的被删掉，否则这条守卫就成了「什么都不删」。
  const staging = makeSegment(wavDir);
  AsrController.prototype.discardBlank.call(
    fake,
    { retranscribe: false, epoch: 0, segment: { segment_id: staging.segment_id, wav_path: staging.wav_path } },
    { inference_ms: 12 },
    'empty',
  );
  test(
    'B24 但普通新段的 staging WAV 照样立刻删除——守卫只挡已归属的那一份',
    !fs.existsSync(staging.wav_path) && fake.blank.snapshot().count === 2,
  );
  archive.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nblank-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

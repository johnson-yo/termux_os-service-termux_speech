/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RecordGroups / RecordArchive，跑在临时目录上
 * [OUTPUT]: docs/061 §九E 的行为回归——50 条分组、盘上最多两组、归档后才删 WAV、崩溃恢复
 * [POS]: 真的建目录、真的写 SQLite、真的删文件。⭐ 101 条用**构造数据**跑完，
 *        不需要说 101 次话（§十.4.15）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordArchive } from '../service/storage/archive.mjs';
import { GROUP_SIZE, RecordGroups } from '../service/storage/groups.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-records-'));

/** 造一个「已经被 VAD 接受」的段：一个真实存在的小 WAV 文件 + 时间信息。 */
let segmentSeq = 0;
const makeSegment = (wavDir) => {
  segmentSeq += 1;
  const segmentId = `seg-${String(segmentSeq).padStart(5, '0')}`;
  fs.mkdirSync(wavDir, { recursive: true });
  const wavPath = path.join(wavDir, `${segmentId}.wav`);
  fs.writeFileSync(wavPath, Buffer.alloc(64, segmentSeq % 251));
  return {
    segment_id: segmentId,
    wav_path: wavPath,
    start_ms: 1_700_000_000_000 + segmentSeq * 1000,
    end_ms: 1_700_000_000_000 + segmentSeq * 1000 + 800,
    duration_ms: 800,
  };
};

const makeStore = async (name, options = {}) => {
  const storeRoot = path.join(root, name);
  const archive = new RecordArchive({ file: path.join(storeRoot, 'archive.v1.sqlite3') });
  await archive.open();
  const groups = new RecordGroups({ root: storeRoot, archive, ...options });
  return { storeRoot, archive, groups, wavDir: path.join(root, `${name}-src`) };
};

// ── node:sqlite 最小兼容测试（§七.4：用前必须验，不可用则本子项停下报告）────────
{
  const { archive } = await makeStore('probe');
  test(
    'E0 node:sqlite 可用，且最小兼容测试（建表→写→读→删）通过',
    archive.available === true && archive.compat?.ok === true,
  );
  archive.close();
}

// ── 分组与轮转 ────────────────────────────────────────────────────────────
{
  const { groups, wavDir, archive, storeRoot } = await makeStore('rotate');
  const feed = (n) => {
    for (let i = 0; i < n; i += 1) {
      const segment = makeSegment(wavDir);
      groups.admit(segment, {
        status: 'succeeded',
        text: `句子 ${segment.segment_id}`,
        model: { id: 'sensevoice', runtime: 'android-app-ort-qnn-htp' },
        inference_ms: 42,
      });
    }
  };
  const dirs = () => fs.readdirSync(storeRoot).filter((n) => n.startsWith('group-')).sort();

  feed(49);
  test(
    'E1 1～49 条只有一个 active 组',
    dirs().length === 1 && groups.snapshot().active.item_count === 49,
  );

  feed(1);
  test(
    'E2 第 50 条让第一组满员并完成（50 个 item 全部终态）',
    groups.group('group-000001').state === 'completed'
      && groups.group('group-000001').item_count === GROUP_SIZE,
  );

  feed(1);
  test(
    'E3 第 51 条开出第二组',
    dirs().length === 2 && groups.snapshot().active.group_id === 'group-000002',
  );

  feed(49);
  test(
    'E4 第 100 条让第二组完成',
    groups.group('group-000002').state === 'completed' && dirs().length === 2,
  );

  const group1Dir = path.join(storeRoot, 'group-000001');
  const wavsBefore = fs.readdirSync(group1Dir).filter((n) => n.endsWith('.wav')).length;
  feed(1);
  await groups.rotate();
  test(
    'E5 第 101 条：最旧组先归档进 SQLite，再删掉它的 WAV 与目录，然后开出第三组',
    wavsBefore === GROUP_SIZE
      && !fs.existsSync(group1Dir)
      && archive.isArchived('group-000001')
      && groups.snapshot().active.group_id === 'group-000003',
  );
  test(
    'E6 稳定态盘上最多两组',
    dirs().length === 2 && dirs().join(',') === 'group-000002,group-000003',
  );

  const archived = archive.query({ groupId: 'group-000001', limit: 100 });
  test(
    'E7 SQLite 内容完整：50 行、文字与模型都在、且明确记录 WAV 已不可用',
    archived.items.length === GROUP_SIZE
      && archived.items.every((row) => row.status === 'succeeded' && row.text && row.model_id === 'sensevoice')
      && archived.items.every((row) => row.wav_available === false),
  );
  test(
    'E11 重复归档不产生重复行（幂等）',
    (() => {
      const items = [{
        segment_id: archived.items[0].segment_id,
        item_seq: archived.items[0].item_seq,
        status: 'succeeded',
        text: archived.items[0].text,
      }];
      archive.archiveGroup({ group_id: 'group-000001', group_seq: 1 }, items);
      return archive.query({ groupId: 'group-000001', limit: 100 }).items.length === GROUP_SIZE;
    })(),
  );
  test(
    'E16 快照不报全生命周期累计——只报当前组进度与盘上那两组',
    (() => {
      const snapshot = groups.snapshot();
      const text = JSON.stringify(snapshot);
      return snapshot.active.progress === '1/50'
        && snapshot.groups.length === 2
        && !('total' in snapshot)
        && !text.includes('lifetime')
        && !/"\w*total\w*":\s*\d{3,}/.test(text);
    })(),
  );
  archive.close();
}

// ── 归档失败时绝不删 WAV ──────────────────────────────────────────────────
{
  const { groups, wavDir, storeRoot, archive } = await makeStore('nocommit');
  // ⚠ 必须在喂满之前就让归档不可用：`admit` 会自己触发轮转，
  // 事后再打断只会验到「已经归档完了」——那不是这条断言要测的东西。
  archive.close();
  groups.archive = {
    open: async () => false,
    lastError: 'simulated archive outage',
    isArchived: () => false,
    stats: () => ({ available: false }),
  };
  for (let i = 0; i < 101; i += 1) {
    const segment = makeSegment(wavDir);
    groups.admit(segment, { status: 'succeeded', text: 'x' });
  }
  const outcome = await groups.rotate();
  const group1 = path.join(storeRoot, 'group-000001');
  test(
    'E8 归档不可用时**一个 WAV 都不删**，并如实报出原因',
    outcome?.reason === 'archive_unavailable'
      && fs.existsSync(group1)
      && fs.readdirSync(group1).filter((n) => n.endsWith('.wav')).length === GROUP_SIZE,
  );
}

// ── 崩溃恢复 ──────────────────────────────────────────────────────────────
{
  const { groups, wavDir, archive, storeRoot } = await makeStore('crash-after-commit');
  for (let i = 0; i < 101; i += 1) {
    const segment = makeSegment(wavDir);
    groups.admit(segment, { status: 'succeeded', text: 'x' });
  }
  // 模拟「commit 成功、还没来得及删目录」就崩了：手工写库，状态与目录都保持旧样。
  const items = groups.readItems('group-000001');
  const committed = archive.archiveGroup(groups.group('group-000001'), items);
  const group1 = path.join(storeRoot, 'group-000001');
  test('E9a 前置：commit 成功但目录还在', committed.ok && fs.existsSync(group1));

  const revived = new RecordGroups({ root: storeRoot, archive });
  revived.reconcile();
  test(
    'E9 commit 后、删除前崩溃：重启后继续把删除做完（唯一键保证不会重复插入）',
    !fs.existsSync(group1) && revived.group('group-000001').state === 'archived',
  );
  archive.close();
}

{
  const { groups, wavDir, archive, storeRoot } = await makeStore('crash-after-delete');
  for (let i = 0; i < 101; i += 1) {
    const segment = makeSegment(wavDir);
    groups.admit(segment, { status: 'succeeded', text: 'x' });
  }
  const items = groups.readItems('group-000001');
  archive.archiveGroup(groups.group('group-000001'), items);
  fs.rmSync(path.join(storeRoot, 'group-000001'), { recursive: true, force: true });
  // 状态文件仍停在 completed：删完了但还没记上。
  const revived = new RecordGroups({ root: storeRoot, archive });
  revived.reconcile();
  test(
    'E10 删除后、状态更新前崩溃：以 SQLite 与目录的事实收敛，不重删也不重插',
    revived.group('group-000001').state === 'archived'
      && revived.liveGroups().length === 2,
  );
  archive.close();
}

{
  const { groups, wavDir, archive, storeRoot } = await makeStore('resume-active');
  for (let i = 0; i < 7; i += 1) {
    const segment = makeSegment(wavDir);
    groups.admit(segment, { status: 'succeeded', text: 'x' });
  }
  const revived = new RecordGroups({ root: storeRoot, archive });
  revived.reconcile();
  const next = makeSegment(wavDir);
  revived.admit(next, { status: 'succeeded', text: 'x' });
  test(
    'E12 active 组未满 50 时重启：继续用原来那一组，不另起炉灶',
    revived.snapshot().active.group_id === 'group-000001'
      && revived.snapshot().active.item_count === 8,
  );
  archive.close();
}

/**
 * ⭐ 准入后移之后，「ASR 没完成就重启」在记录组里**没有任何痕迹**——
 * 那个段这时候还只是一份 staging WAV，组里一条也没写。
 * 旧版在这里要把 pending item 判为失败，而那条回滚路径正是空白结果赖以存活的地方。
 */
{
  const { groups, wavDir, archive, storeRoot } = await makeStore('no-pending');
  const segment = makeSegment(wavDir);
  // 段已切出、ASR 还没跑完就重启：记录组这时候什么都不知道，也不该知道。
  const revived = new RecordGroups({ root: storeRoot, archive });
  revived.reconcile();
  test(
    'E13 ASR 未完成即重启：记录组里一条都没有，staging WAV 原样留着等 ASR 队列恢复',
    revived.liveGroups().length === 0
      && fs.existsSync(segment.wav_path),
  );

  revived.admit(segment, { status: 'succeeded', text: '恢复之后' });
  const items = revived.readItems('group-000001');
  test(
    'E13b 盘上不可能存在没有结论的 item——`pending` 这个状态已经不存在',
    items.length === 1
      && items.every((item) => item.status === 'succeeded' || item.status === 'failed')
      && !JSON.stringify(items).includes('"pending"'),
  );
  archive.close();
}

// ── 旧数据一动不动 ────────────────────────────────────────────────────────
{
  const legacyRoot = path.join(root, 'legacy');
  const legacyWav = path.join(legacyRoot, 'vad', 'wav');
  fs.mkdirSync(legacyWav, { recursive: true });
  const legacyJsonl = path.join(legacyWav, 'segments.v1.jsonl');
  fs.writeFileSync(legacyJsonl, '{"segment_id":"old-1"}\n{"segment_id":"old-2"}\n');
  const legacyFile = path.join(legacyWav, 'old-1.wav');
  fs.writeFileSync(legacyFile, Buffer.alloc(16, 7));
  const before = fs.readFileSync(legacyJsonl, 'utf8');

  const { groups, wavDir, archive } = await makeStore('isolation');
  for (let i = 0; i < 101; i += 1) {
    const segment = makeSegment(wavDir);
    groups.admit(segment, { status: 'succeeded', text: 'x' });
  }
  await groups.rotate();
  test(
    'E14/E15 旧 JSONL 与旧 WAV 既没被导入也没被删——新机制是独立命名空间',
    fs.readFileSync(legacyJsonl, 'utf8') === before
      && fs.existsSync(legacyFile)
      && !JSON.stringify(groups.snapshot()).includes('old-1')
      && archive.query({ limit: 200 }).items.every((row) => !row.segment_id.startsWith('old-')),
  );
  archive.close();
}

// ── item 内容完整性 ──────────────────────────────────────────────────────
{
  const { groups, wavDir, archive } = await makeStore('item-shape');
  const segment = makeSegment(wavDir);
  const admitted = groups.admit(segment, {
    status: 'succeeded',
    text: '你好',
    model: { id: 'sensevoice', runtime: 'android-app-ort-qnn-htp' },
    inference_ms: 123,
  });
  const done = groups.readItems('group-000001')[0];
  test(
    'E17 item 在 ASR 有结论时才诞生，一写下去就是终态，且 WAV 已从 staging 移进本组目录',
    admitted.admitted
      && done.status === 'succeeded'
      && done.wav_available === true
      && fs.existsSync(done.wav_path)
      && !fs.existsSync(segment.wav_path)
      && done.group_id === 'group-000001'
      && done.item_seq === 1,
  );
  test(
    'E18 终态带齐 §七.2 要求的字段：稳定 id、组、序号、起止、模型、耗时、两个时间戳',
    done.status === 'succeeded'
      && done.text === '你好'
      && done.model.id === 'sensevoice'
      && done.inference_ms === 123
      && done.segment_start_ms === segment.start_ms
      && done.segment_end_ms === segment.end_ms
      && typeof done.created_at === 'string'
      && typeof done.completed_at === 'string'
      // ⛔ 不许拿服务重启就归零的 pipeline_epoch 当唯一 ID。
      && !('pipeline_epoch' in done),
  );
  const failedSegment = makeSegment(wavDir);
  groups.admit(failedSegment, { status: 'failed', error: 'HTP said no' });
  const failed = groups.readItems('group-000001')[1];
  test(
    'E19 失败的 item 保留明确状态与原因，同样是终态',
    failed.status === 'failed' && failed.error === 'HTP said no' && failed.completed_at,
  );
  archive.close();
}

/* ══════════════════════════════════════════════════════════════
   F. 单路径：一份 WAV、没有旧写入、feed 只从这里来（docs/061 §七/§八）
   ══════════════════════════════════════════════════════════════ */
{
  const feedRoot = path.join(root, 'feed');
  const archive = new RecordArchive({ file: path.join(feedRoot, 'archive.v1.sqlite3') });
  await archive.open();
  const groups = new RecordGroups({ root: feedRoot, archive });
  const wavDir = path.join(feedRoot, 'staging');

  const first = makeSegment(wavDir);
  groups.admit(first, {
    status: 'succeeded',
    text: '第一句',
    model: { id: 'sensevoice' },
    inference_ms: 200,
    utterance_id: 'utt_a',
    language: 'auto',
    keyword_matched: null,
    observed_ms: 1_785_000_000_000,
  });

  const groupDir = path.join(feedRoot, 'group-000001');
  test(
    'F1 每个 Segment 只有一份 WAV：暂存区已经空了，音频只在它那一组的目录里',
    fs.readdirSync(wavDir).filter((name) => name.endsWith('.wav')).length === 0
      && fs.readdirSync(groupDir).filter((name) => name.endsWith('.wav')).length === 1,
  );

  test(
    'F2 不写 segments.v1.jsonl、不写 transcripts.v1.jsonl、不写旧 Reservoir',
    !fs.existsSync(path.join(wavDir, 'segments.v1.jsonl'))
      && !fs.existsSync(path.join(groupDir, 'segments.v1.jsonl'))
      && !fs.existsSync(path.join(feedRoot, 'transcripts.v1.jsonl'))
      && !fs.readdirSync(feedRoot).includes('transcripts'),
  );

  const feed = groups.feed(0, 10);
  test(
    'F3 feed 的形状与旧 feed 逐字一致——消费者读的是字段名，不是来源',
    feed.schema === 'termux-os.speech-transcript-feed.v1'
      && Array.isArray(feed.observations)
      && feed.observations.length === 1
      && feed.observations[0].text === '第一句'
      && feed.observations[0].final === true
      && feed.observations[0].utterance_id === 'utt_a'
      && feed.observations[0].model.id === 'sensevoice'
      && feed.observations[0].timing.inference_ms === 200
      && feed.next === feed.observations[0].seq,
  );

  /**
   * ⭐ 换存储最容易**静默**弄坏的地方。
   *
   * `termux-ime` 与 `termux-interpreter` 都把游标持久化，并且只认「比手上这个大的」。
   * 旧 feed 的 seq 是从 1 开始的行号（真机上已到 3200）；如果新机制重新从 1 编号，
   * 它们会永远读到 0 条、且**永远不报错**——空数组和「没人说话」型别相同（docs/056）。
   */
  test(
    'F4 feed 游标远大于旧行号，两个持久化游标的消费者不会静默失聪',
    feed.observations[0].seq > 1_700_000_000_000
      && groups.feed(feed.next, 10).observations.length === 0,
  );

  const second = makeSegment(wavDir);
  groups.admit(second, { status: 'failed', error: 'HTP said no' });
  const third = makeSegment(wavDir);
  groups.admit(third, {
    status: 'succeeded', text: '第二句', model: { id: 'sensevoice' },
  });
  const afterCursor = groups.feed(feed.next, 10);
  test(
    'F5 游标语义是 filter(seq > after) 升序；失败的句子不占游标也不进 feed',
    afterCursor.observations.length === 1
      && afterCursor.observations[0].text === '第二句'
      && afterCursor.next > feed.next,
  );

  // 重启后游标必须继续递增，不能回头。
  const reopened = new RecordGroups({ root: feedRoot, archive });
  const fourth = makeSegment(wavDir);
  reopened.admit(fourth, {
    status: 'succeeded', text: '重启之后', model: { id: 'sensevoice' },
  });
  const resumed = reopened.feed(afterCursor.next, 10);
  test(
    'F6 服务重启后 feed 游标继续递增，绝不回头',
    resumed.observations.length === 1
      && resumed.observations[0].text === '重启之后'
      && resumed.observations[0].seq > afterCursor.next,
  );
  archive.close();
}

/* ══════════════════════════════════════════════════════════════
   G. 按 id 查一条 ≠ 最近 N 条
   ══════════════════════════════════════════════════════════════ */
{
  const { groups, wavDir, archive } = await makeStore('lookup');
  const first = makeSegment(wavDir);
  groups.admit(first, { status: 'succeeded', text: '第一组里的一句' });
  // 把当前组填满，逼出第二组——于是第一条落在**上一组**里。
  for (let i = 0; i < GROUP_SIZE; i += 1) {
    groups.admit(makeSegment(wavDir), { status: 'succeeded', text: `填充 ${i}` });
  }
  test(
    'G1 前置：第一条已经不在当前组里',
    groups.liveGroups().length === 2
      && !groups.readItems(groups.snapshot().active.group_id)
        .some((item) => item.segment_id === first.segment_id),
  );
  /**
   * ⭐ `recent()` 是**显示窗口**（上限 50 条），当前组一满就把它占满，
   * 于是上一组的段一条都够不到——`/asr/transcribe` 因此对着盘上明明存在的 WAV
   * 报 `record item with WAV not found`。「最近 N 条」与「按 id 查一条」是两个问题。
   */
  test(
    'G2 recent(50) 够不到上一组的段——用它按 id 查会得到「不存在」',
    !groups.recent(50).some((item) => item.segment_id === first.segment_id),
  );
  test(
    'G3 find() 跨全部活组，答案不随当前组的进度改变',
    groups.find(first.segment_id)?.segment_id === first.segment_id
      && groups.find(first.segment_id)?.text === '第一组里的一句',
  );
  test('G4 找不存在的 id 明确返回 null', groups.find('no-such-segment') === null && groups.find('') === null);
  archive.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nstorage-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

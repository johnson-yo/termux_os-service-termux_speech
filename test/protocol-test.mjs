/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: TargetActivityFsm（半/全快门）、AsrController 的入队与陈旧判据、RecordGroups
 * [OUTPUT]: incomplete / complete 协议的回归——身份、修订单调、陈旧丢弃、计数规则
 * [POS]: ⭐ 这条协议的全部价值在于**同一句话的两次交付不会被当成两句话**。
 *        它只能在这一层被证伪：真机上「多出一句」与「少了一句」都要等到有人念完
 *        50 句才看得见。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TargetActivityFsm } from '../service/speaker/activity-fsm.mjs';
import { RecordGroups } from '../service/storage/groups.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const freshGroups = () => new RecordGroups({
  root: fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-proto-')), archive: null, groupSize: 50,
});

// ────────────────────────────────── 1. FSM：一句话，两次交付

{
  const halves = [];
  const commits = [];
  const fsm = new TargetActivityFsm(
    { continuation_grace_ms: 1200, vad_gates_speaker: false, enter_confirm: 2, exit_confirm: 2 },
    { onHalfShutter: (e) => halves.push(e), onCommit: (e) => commits.push(e) },
  );
  let t = 0;
  const w = (sim, n = 1) => { for (let i = 0; i < n; i += 1) { t += 300; fsm.onWindow(t, sim); } };

  w(0.05, 4);          // 背景
  w(0.60, 4);          // 说话 → USER
  w(0.05, 3);          // 停 900 ms：越过 exit_confirm ⇒ 半快门
  test('P1 ⭐ 半快门**发事件**，不是只写一个字段（否则那段等待纯粹是延迟）',
    halves.length === 1);
  test('P2 半快门时还没有 commit（判决仍然要等）', commits.length === 0);
  const firstHalf = halves[0];

  w(0.60, 3);          // 接着说 ⇒ 回弹
  w(0.05, 3);          // 再停 ⇒ 第二次半快门
  test('P3 回弹之后可以再发一次半快门（同一句话的下一个修订）', halves.length === 2);
  test('P4 ⭐ 两次半快门属于同一个 candidate（同一句话）',
    halves[0].candidate_id === halves[1].candidate_id);
  test('P5 修订号单调递增', halves[1].revision === halves[0].revision + 1);

  w(0.05, 5);          // 等够 grace ⇒ 全快门
  test('P6 全快门产生 commit', commits.length === 1);
  test('P7 ⭐ 最终版的修订号严格大于它自己发过的每一个 incomplete',
    commits[0].revision > halves[1].revision);
  test('P8 ⭐ 最终版与中间版是**同一句话**', commits[0].candidate_id === firstHalf.candidate_id);
}

{
  // grace=0 ⇒ 旧行为：没有半快门这回事
  const halves = [];
  const commits = [];
  const fsm = new TargetActivityFsm(
    { continuation_grace_ms: 0, vad_gates_speaker: false },
    { onHalfShutter: (e) => halves.push(e), onCommit: (e) => commits.push(e) },
  );
  let t = 0;
  const w = (sim, n = 1) => { for (let i = 0; i < n; i += 1) { t += 300; fsm.onWindow(t, sim); } };
  w(0.05, 3); w(0.60, 4); w(0.05, 3);
  test('P9 ⛔ grace=0 时一个半快门都不发（关掉就是完全的旧行为）',
    halves.length === 0 && commits.length === 1);
  test('P10 旧行为下最终版仍然带修订号 1（下游不必分两种形状解析）',
    commits[0].revision === 1);
}

// ────────────────────────────────── 2. spool：身份、取代、陈旧

/** 一个只做入队/判陈旧的最小替身：⛔ 不碰模型，判据本身才是被测对象。 */
class Spool {
  constructor() { this.pending = []; this.latest = new Map(); this.superseded = 0; }

  enqueue(segmentId, revision) {
    const gone = this.pending.filter((j) => j.id === segmentId && j.rev < revision);
    this.pending = this.pending.filter((j) => !gone.includes(j));
    this.superseded += gone.length;
    this.latest.set(segmentId, Math.max(this.latest.get(segmentId) ?? 0, revision));
    this.pending.push({ id: segmentId, rev: revision });
  }

  isStale(job) {
    const latest = this.latest.get(job.id);
    return latest !== undefined && job.rev < latest;
  }
}

{
  const s = new Spool();
  s.enqueue('seg-a', 1);
  s.enqueue('seg-a', 2);
  test('Q1 ⭐ 更新的修订取代还没开工的旧修订（不把算力花在必然被丢弃的结果上）',
    s.pending.length === 1 && s.pending[0].rev === 2 && s.superseded === 1);
  test('Q2 ⛔ 同一句话的 complete 不会被它自己的 incomplete 判成重复',
    s.pending[0].id === 'seg-a');

  // r1 已经在推理（不在 pending 里了），r2 随后入队 ⇒ r1 的结果必须可识别为陈旧
  const inFlight = { id: 'seg-b', rev: 1 };
  s.enqueue('seg-b', 1);
  s.pending = s.pending.filter((j) => j.id !== 'seg-b');
  s.enqueue('seg-b', 2);
  test('Q3 ⭐ 单槽串行下 r1 的结果完全可能在 r2 之后才回来，且必须被判为陈旧',
    s.isStale(inFlight) === true);
  test('Q4 最新的那一版不是陈旧的', s.isStale({ id: 'seg-b', rev: 2 }) === false);
  test('Q5 没见过的句子不算陈旧（⛔ 未知不等于过期）',
    s.isStale({ id: 'seg-zzz', rev: 1 }) === false);
}

// ────────────────────────────────── 3. 记录组：incomplete 不占那 50 句

{
  const groups = freshGroups();
  const admit = (n, text = `第${n}句。`) => groups.admit(
    { segment_id: `sv-${n}` },
    { status: 'succeeded', text, model: 'sensevoice', backend: 'sensevoice' },
  );

  admit(1);
  const after1 = groups.snapshot().active.sentence_count;
  test('R1 complete 计一句', after1 === 1);

  // incomplete 走的是另一条路：它根本不调 admit。这里把契约钉在「调用方不 admit」上。
  const mainSource = fs.readFileSync(
    path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'service/main.mjs'),
    'utf8');
  test('R2 ⭐ incomplete **不** admit（它是中间品，不占那 50 句里的一格）',
    /segment_status === 'incomplete'[\s\S]{0,700}return;/.test(mainSource)
      && mainSource.indexOf("segment_status === 'incomplete'")
        < mainSource.indexOf('records?.admit(segment, outcome);'));
  test('R3 ⭐ 判据是 segment_status，⛔ 不是 status（后者说的是识别成功没有）',
    mainSource.includes("outcome?.segment_status === 'incomplete'"));
  test('R4 complete 一到就把这句话的临时文本删掉（⛔ 不留两个真相）',
    mainSource.includes('provisional.delete(segment.segment_id);'));
  test('R5 临时文本有界（⛔ 一次长会话不许让它无限增长）',
    mainSource.includes('PROVISIONAL_CAP'));

  admit(2);
  test('R6 计数仍然只跟着 complete 走', groups.snapshot().active.sentence_count === 2);

  groups.admit({ segment_id: 'sv-3' },
    { status: 'failed', error: 'boom', backend: 'sensevoice' });
  const snap = groups.snapshot();
  test('R7 失败留档但不占名额（既有契约不因本轮改动而变）',
    snap.active.item_count === 3 && snap.active.sentence_count === 2);
}

// ────────────────────────────────── 4. ASR 不决定 status

{
  const src = fs.readFileSync(
    path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)),
      'service/asr/controller.mjs'), 'utf8');
  test('S1 ⭐ ASR 只**继承**上游的 status，不自己判断',
    src.includes("segment_status: job.status ?? 'complete'")
      && !/segment_status:\s*(text|record|result)\./.test(src));
  test('S2 输出带上修订号（下游要靠它丢弃陈旧结果）',
    src.includes('revision: job.revision ?? 1,'));
  test('S3 ⭐ 陈旧结果不发布，但**留痕**（静默丢弃 = 查不出来的丢弃）',
    src.includes('this.staleDropped += 1;') && src.includes('this.lastStale = {'));
  test('S4 一次投递的身份是 (segment_id, revision)，一段话的身份仍是 segment_id',
    src.includes('const key = `${segmentId}#${revision}`;'));
  test('S5 ⛔ 缺省 revision=1：旧调用方（手动链 / 重转写）一个字都不用改',
    src.includes('Math.max(1, Number(segment?.revision) || 1)'));
}

console.log(`\n${count - failures}/${count} protocol assertions passed`);
process.exit(failures ? 1 : 0);

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: AppSegments（本包这一侧）+ AppEventsClient 的 `segment` 域
 * [OUTPUT]: P4 回归：exactly-once、丢帧回填、重生不重放、**upsert 不是 append**
 * [POS]: 纯逻辑，⛔ 不起 WebSocket、不连 App、不碰音频。
 *        ⭐ 这一层最容易出的错是「A 出一次、B 又新增一次」——它不报错，
 *        只是产品里多出一句几乎一样的话。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { AppSegments } from '../service/speaker/app-segments.mjs';
import { AppEventsClient } from '../service/capture/app-events.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };

const fakeAndroid = (handlers = {}) => {
  const calls = [];
  return {
    calls,
    json: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      const h = handlers[path] ?? handlers[`${options.method ?? 'GET'} ${path}`];
      if (typeof h === 'function') return h();
      if (h instanceof Error) throw h;
      return h ?? {};
    },
  };
};

const result = (seq, id, revision, complete, text = '一句话') => ({
  seq, segment_id: id, revision, complete, blank: text.trim() === '', text,
  backend: 'sensevoice', start_mono_ms: 1000, end_mono_ms: 3400,
  duration_ms: 2400, inference_ms: 160, asr_calls: 1,
});

const facts = (over = {}) => ({
  executor: 'app', results_seq: 0, state: 'IDLE', backend: 'sensevoice',
  provisionals: 0, finals: 0, blank_suppressed: 0, asr_in_flight: 0, last: null, ...over,
});

/** 一个记账用的假 records：⭐ 它就是「产品里到底留下了几句」的度量。 */
const fakeRecords = () => {
  const items = new Map();
  return {
    items,
    admits: 0,
    upserts: 0,
    provisionals: 0,
    find(id) { return items.get(id) ?? null; },
    admit(segment, outcome) { this.admits += 1; items.set(segment.segment_id, { ...outcome }); },
    retranscribe(id, outcome) { this.upserts += 1; items.set(id, { ...outcome }); },
    noteProvisional() { this.provisionals += 1; },
  };
};

/** 把 AppSegments 接到假 records 上——与 main.mjs 的 `ingestAppSegmentResult` 同形。 */
const rig = (handlers = {}) => {
  const records = fakeRecords();
  const android = fakeAndroid(handlers);
  const seg = new AppSegments({
    android,
    onResult: (r) => {
      if (!r.complete) { records.noteProvisional(); return; }
      if (r.blank || !r.text.trim()) return;
      if (records.find(r.segment_id)) records.retranscribe(r.segment_id, r);
      else records.admit({ segment_id: r.segment_id }, r);
    },
  });
  return { seg, records, android };
};

// ── ① A → B：产品里只留一句 ─────────────────────────────────────────────────
{
  const { seg, records } = rig();
  seg.observe(facts({ results_seq: 0 }), 'boot-1');
  seg.observe(facts({ results_seq: 1, last: result(1, 'seg-1', 1, false, 'A 的文字') }), 'boot-1');
  test('A1 provisional 不进 records（⛔ 它会占掉 50 句里的一格）',
    records.admits === 0 && records.provisionals === 1);
  seg.observe(facts({ results_seq: 2, last: result(2, 'seg-1', 2, true, 'A 加 B 的文字') }), 'boot-1');
  test('A2 ⭐ final 之后产品里只有一句', records.items.size === 1);
  test('A3 那一句的文字是 B 的', records.items.get('seg-1').text === 'A 加 B 的文字');
  test('A4 revision 跟着走', records.items.get('seg-1').revision === 2);
}

// ── ② 没有续句：A 直接升 final，仍然只有一句、只 ASR 过一次 ──────────────────
{
  const { seg, records } = rig();
  seg.observe(facts(), 'boot-1');
  seg.observe(facts({ results_seq: 1, last: result(1, 'seg-2', 1, false, '就这一句') }), 'boot-1');
  // 超时升级：同一个 revision，只是 complete 变成 true，且 asr_calls 仍然是 1
  seg.observe(facts({ results_seq: 2,
    last: { ...result(2, 'seg-2', 1, true, '就这一句'), asr_calls: 1 } }), 'boot-1');
  test('B1 无续句时产品里也只有一句', records.items.size === 1 && records.admits === 1);
  test('B2 ⭐ 没有第二次 ASR（asr_calls 仍是 1）', records.items.get('seg-2').asr_calls === 1);
}

// ── ③ 重复推送 / 倒退 / 重生 ────────────────────────────────────────────────
{
  const { seg, records } = rig();
  seg.observe(facts(), 'boot-1');
  const f = facts({ results_seq: 1, last: result(1, 'seg-3', 1, true) });
  seg.observe(f, 'boot-1');
  seg.observe(f, 'boot-1');
  seg.observe(f, 'boot-1');
  test('C1 重复推送只交付一次', records.admits === 1 && seg.duplicates >= 2);
  seg.observe(facts({ results_seq: 0, last: null }), 'boot-2');
  seg.observe(facts({ results_seq: 1, last: result(1, 'seg-9', 1, true, '新一辈子的话') }), 'boot-2');
  test('C2 ⭐ App 重生后不重放历史，只对齐基线', records.items.size === 2 && seg.ghostAvoided >= 1);
}

// ── ④ 丢帧回填：定稿不能丢 ─────────────────────────────────────────────────
{
  const { seg, records, android } = rig({
    'GET /api/audio/segment/results?after=0': () => ({
      results: [result(1, 'seg-a', 1, false, 'A'), result(2, 'seg-a', 2, true, 'AB'),
        result(3, 'seg-b', 1, true, '第二句')],
    }),
  });
  seg.observe(facts(), 'boot-1');
  seg.observe(facts({ results_seq: 3, last: result(3, 'seg-b', 1, true, '第二句') }), 'boot-1');
  await new Promise((r) => setTimeout(r, 10));
  test('D1 ⭐ 计数跳格时回填中间那几条', seg.backfilled === 3);
  test('D2 回填之后产品里是两句（A/B 合成一句）', records.items.size === 2);
  test('D3 第一句是 B 的文字', records.items.get('seg-a').text === 'AB');
  const before = records.admits + records.upserts;
  seg.observe(facts({ results_seq: 3, last: result(3, 'seg-b', 1, true, '第二句') }), 'boot-1');
  test('D4 回填之后同一条不会再交付一次', records.admits + records.upserts === before);
  test('D5 回填只问自己之后的（⛔ 不重放全部历史）',
    android.calls.some((c) => c.path.includes('after=0')));
}

// ── ⑤ 空结果 ───────────────────────────────────────────────────────────────
{
  const { seg, records } = rig();
  seg.observe(facts(), 'boot-1');
  seg.observe(facts({ results_seq: 1, last: result(1, 'seg-empty', 1, true, '   ') }), 'boot-1');
  test('E1 空结果不进 records、不占名额', records.items.size === 0 && records.admits === 0);
  test('E2 但它被数出来了（⛔ 静默丢弃 = 查不出来的丢弃）', seg.blankSuppressed === 1);
}

// ── ⑥ AppEvents 转发遵循既有 boot_id/seq 规则 ──────────────────────────────
{
  const seen = [];
  const client = new AppEventsClient({ now: () => 1000 });
  client.onSegment = (s, bootId) => seen.push({ seq: s.results_seq, bootId });
  const frame = (bootId, seq, segment) => JSON.stringify({
    schema: 'termux-os.app-events.v2', boot_id: bootId, seq, event: 'segment.final',
    data: { segment },
  });
  client.ingest(frame('boot-1', 1, facts({ results_seq: 1 })));
  client.ingest(frame('boot-1', 1, facts({ results_seq: 2 })));   // seq 不前进 ⇒ 整帧丢弃
  client.ingest(frame('boot-1', 2, facts({ results_seq: 2 })));
  test('F1 seq 不前进的帧整帧丢弃', seen.length === 2 && seen[1].seq === 2);
  test('F2 转发时带上 boot_id', seen[0].bootId === 'boot-1');
}

console.log(`app-segments-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

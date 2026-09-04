/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 真的 [SpeechPublicState] / [RecordGroups]（临时目录）+ main.mjs / web 的源码文本
 * [OUTPUT]: docs/091 PART A / PART G —— provisional 只进「正在识别」、history 每个逻辑段落只有一条、
 *           final 清掉 provisional、音频不可用时不画播放器
 * [POS]: ⭐ 使用者实测「同一句看到两个 ASR 输出」而「正在识别」一次没亮过。
 *        App 侧的病因（等待期从错误的时刻起算）由 App 单测钉住；本文件钉的是**消费侧**：
 *        即使 App 交付两次，历史里也**结构上**只能有一条。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeechPublicState, STATUS_COMPLETE, STATUS_INCOMPLETE } from '../service/public-state.mjs';
import { RecordGroups } from '../service/storage/groups.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const main = code(read('service/main.mjs'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-ux-'));

// ── PART A：provisional 与 final 的产品语义 ────────────────────────────

{
  const ps = new SpeechPublicState();
  ps.noteTranscript({ segment_id: 'seg-1' },
    { text: '你好', revision: 1, segment_status: STATUS_INCOMPLETE, backend: 'sensevoice' });
  const during = ps.snapshot().transcription;
  test('U1 A 的临时结果落在「正在识别」那一栏',
    during.status === STATUS_INCOMPLETE && during.provisional_text === '你好'
    && during.final_text === null && during.active === true);

  ps.noteTranscript({ segment_id: 'seg-1' },
    { text: '你好世界', revision: 2, segment_status: STATUS_COMPLETE, backend: 'sensevoice' });
  const after = ps.snapshot().transcription;
  test('U2 ⭐ final 到达后 provisional 被清掉（⛔ 不许两条并存）',
    after.status === STATUS_COMPLETE && after.provisional_text === null
    && after.final_text === '你好世界' && after.active === false);
  test('U3 「最近识别」拿到的是最终那一条', ps.snapshot().latest.latest_final_text === '你好世界');
}

{
  const ps = new SpeechPublicState();
  ps.noteTranscript({ segment_id: 'seg-2' },
    { text: '你好', revision: 1, segment_status: STATUS_INCOMPLETE });
  ps.noteTranscript({ segment_id: 'seg-2' },
    { text: '你好', revision: 1, segment_status: STATUS_COMPLETE });
  const after = ps.snapshot().transcription;
  test('U4 A-only：同一 revision 升为定稿也要清掉「正在识别」',
    after.status === STATUS_COMPLETE && after.provisional_text === null);
}

{
  const ps = new SpeechPublicState();
  ps.noteTranscript({ segment_id: 'seg-3' },
    { text: 'B 完整版', revision: 2, segment_status: STATUS_COMPLETE });
  ps.noteTranscript({ segment_id: 'seg-3' },
    { text: 'A 半截', revision: 1, segment_status: STATUS_INCOMPLETE });
  test('U5 ⭐ 迟到的 revision 1 不许把定稿打回「正在识别」',
    ps.snapshot().transcription.final_text === 'B 完整版');
}

// ── PART A：records 只收 final ────────────────────────────────────────

{
  const dir = tmp();
  const g = new RecordGroups({ root: dir });
  const seg = { segment_id: 'seg-10', source_kind: 'app_segment', audio_available: true };
  g.admit({ ...seg, start_ms: 0, end_ms: 1000, duration_ms: 1000 },
    { status: 'succeeded', text: '你好', revision: 1, backend: 'sensevoice' });
  g.retranscribe('seg-10', { status: 'succeeded', text: '你好世界', revision: 2, backend: 'sensevoice' });
  const items = g.recent(10).filter((i) => i.segment_id === 'seg-10');
  test('U6 ⭐ revision 2 是**就地替换**，历史里只有一条', items.length === 1);
  test('U7 留下的是最终那一版', items[0].text === '你好世界');
  const g2 = new RecordGroups({ root: dir });
  test('U8 重启后仍然只有一条', g2.recent(10).filter((i) => i.segment_id === 'seg-10').length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const g = new RecordGroups({ root: dir });
  const before = g.snapshot();
  g.admit({ segment_id: 'seg-11', source_kind: 'app_segment', audio_available: true,
    start_ms: 0, end_ms: 900, duration_ms: 900 },
  { status: 'succeeded', text: '一句话', revision: 1, backend: 'sensevoice' });
  const dup = g.admit({ segment_id: 'seg-11', source_kind: 'app_segment', audio_available: true },
    { status: 'succeeded', text: '一句话', revision: 1, backend: 'sensevoice' });
  test('U9 同一个 segment_id 不许被 admit 两次', dup.admitted === false
    && dup.reason === 'duplicate_segment');
  test('U10 计数没有被重复占用', typeof before === 'object'
    && g.recent(10).filter((i) => i.segment_id === 'seg-11').length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * ⚠ 判据必须**只看 `ingestAppSegmentResult` 这一段**：`records?.admit(` 在文件里
 * 还有一次（legacy 手动链的 `onSegment`），拿全文件做位置比较会比到那一次上，
 * 于是这条断言测的是另一个函数——**恒假**，而且看起来完全合理。
 */
{
  const fn = main.slice(main.indexOf('const ingestAppSegmentResult'));
  const body = fn.slice(0, fn.indexOf('\n};'));
  test('U11 ⭐ 未完成的结果在进 records 之前就被截住（⛔ 不 admit、⛔ 不占 50 句名额）',
    body.indexOf('if (!r.complete)') > 0
    && body.indexOf('if (!r.complete)') < body.indexOf('records?.admit(')
    && !main.includes('noteProvisional'));
}

test('U12 定稿走 find → retranscribe / admit 的 upsert，⛔ 不是无条件 append',
  /const existing = records\?\.find\?\.\(r\.segment_id\) \?\? null;/.test(main)
  && /if \(existing\) records\.retranscribe\(/.test(main));

test('U13 「正在识别」有且只有一栏（⛔ 不新增第二个 widget）',
  (read('web/index.html').match(/id="ov-current"/g) ?? []).length === 1);

// ── PART G：音频只是一个引用 ───────────────────────────────────────────

test('U14 ⭐ App 段落的音频是一个**引用**，⛔ 不是 speech 本地路径',
  /wav_path: null,/.test(main) && /audio_ref: \{ source: 'app', segment_id: r\.segment_id \}/.test(main));

test('U15 App 私有绝对路径不进 records', !/wav_path: r\.archive_wav/.test(main));

{
  const views = read('web/views.js');
  test('U16 ⭐ 音频不可用时不画播放器，改成一句说明',
    views.includes("record.audio_available === false") && views.includes('音频已过期'));
  const appjs = read('web/app.js');
  test('U17 `audio_available` 由记录自己说，⛔ 不从 segment_id 推',
    appjs.includes('audio_available: item.audio_available === true'));
}

// ── 音频可用性是结构保证，⛔ 不是快照 ────────────────────────────────

{
  const dir = tmp();
  const g = new RecordGroups({ root: dir });
  // 模拟老记录：admit 时序修好之前，App 段落带着 audio_available=false 落库
  g.admit({ segment_id: 'seg-20', source_kind: 'app_segment', audio_available: false,
    start_ms: 0, end_ms: 800, duration_ms: 800 },
  { status: 'succeeded', text: '一句话', revision: 1, backend: 'sensevoice' });
  const row = g.recent(5).find((i) => i.segment_id === 'seg-20');
  test('U18 ⭐ App 段落的音频可用性由结构保证（活组 + App 上限高于活跃池天花板）',
    row.audio_available === true && row.audio_source === 'app');

  /**
   * ⚠ 这两段原本共用同一个时间窗（0–800ms），于是第二条被
   *   `audio_window_already_committed` 去重挡掉——⭐ 那是**正确**的产品行为
   *   （同一段音频不许落两条记录），只是它比这条测试晚出现，而测试没跟上。
   * ⛔ 修 fixture，不动产品：给它一个自己的窗。
   */
  const speechOwned = g.admit({ segment_id: 'seg-21', source_kind: 'vad_segment', wav_path: null,
    start_ms: 1000, end_ms: 1800, duration_ms: 800 },
  { status: 'succeeded', text: '手动那条', revision: 1, backend: 'sensevoice' });
  const manual = g.recent(5).find((i) => i.segment_id === 'seg-21');
  test('U19 ⛔ 非 App 段落不许被这条规则顺手标成可用',
    speechOwned.admitted === true && manual.audio_available === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('U20 ⭐ 归档不是 App 的事：speech 始终保留两个活组（⇒ 未归档池 50–99）',
  read('service/storage/groups.mjs').includes('if (live.length <= 2) return null;'));

{
  const dir = tmp();
  const g = new RecordGroups({ root: dir });
  g.admit({ segment_id: 'seg-30', source_kind: 'app_segment', audio_available: true,
    start_ms: 0, end_ms: 900, duration_ms: 900 },
  { status: 'succeeded', text: 'A 半截', revision: 1, backend: 'sensevoice' });
  const afterAdmit = g.lastSentence?.text;
  g.retranscribe('seg-30', { status: 'succeeded', text: 'A+B 完整', revision: 2, backend: 'sensevoice' });
  /**
   * ⭐ 「最近识别」要跟着改写走。⚠ 原本 `retranscribe` 不动 `lastSentence`：
   *   A+B 的 B 定稿之后页面那一行仍然是上一句——内容更新了、显示停在旧的，
   *   看起来就像「没有提交」。
   */
  test('U21 ⭐ 就地改写也要更新「最近识别」',
    afterAdmit === 'A 半截' && g.lastSentence?.text === 'A+B 完整');
  const rows = g.recent(10).filter((i) => i.segment_id === 'seg-30');
  test('U22 ⛔ 但游标不动：那是同一句话的新内容，不是一句新话',
    rows.length === 1 && rows[0].text === 'A+B 完整');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nresult-ux-test: ${count - failures}/${count} assertions passed`);
process.exit(failures ? 1 : 0);

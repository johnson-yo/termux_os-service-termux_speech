/**
 * [INPUT]: service/storage/groups.mjs（⛔ 未改）、service/main.mjs 与 web/app.js 源码
 * [OUTPUT]: Recovery19D/20B：旧 App audio_ref 与新 identity snapshot 经 RecordGroups、SQLite archive、
 *           keyset query / history UI 往返；migration 只加列并保留旧句子。
 * [POS]: 包自测。
 * [PROTOCOL]: 变更时更新此头部。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordArchive } from '../service/storage/archive.mjs';
import { RecordGroups } from '../service/storage/groups.mjs';
import { DatabaseSync } from 'node:sqlite';

let pass = 0; let fail = 0;
const test = (name, ok) => { if (ok) pass += 1; else { fail += 1; console.log(`FAIL ${name}`); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-archive-'));
const archive = new RecordArchive({ file: path.join(root, 'archive.v1.sqlite3') });
await archive.open();
const groups = new RecordGroups({ root, archive });
const key = 's2:boot-A:3:gen-3-seg-2';
const r = groups.admit({
  segment_id: key, source: 'speech2', source_kind: 'app_segment', audio_available: true,
  audio_ref: { source: 'app', segment_id: key }, wav_path: null, duration_ms: 2400,
}, { status: 'succeeded', text: '你好', backend: 'speech2', source: 'speech2',
  meta: { speaker_role: 'USER', enrollment_id: 'voice-a', voice_name: 'A', cosine: 0.63, matched: true,
    metrics: { audio_duration_ms: 2400, asr_processing_ms: 250, speech_end_to_first_text_ms: 1200,
    speech_end_to_final_text_ms: 2100, realtime_x: 9.6 } } });
const item = groups.find(key);
test('A1 admitted into the existing 50-group', r.admitted === true && /^group-/.test(item?.group_id ?? ''));
test('A2 app-owned audio (RecordGroups unchanged)', item?.audio_available === true && item?.audio_source === 'app');
test('A3 still a Speech2 record for /speech2/history', item?.source === 'speech2');
test('A4 metrics travel in meta', item?.meta?.metrics?.realtime_x === 9.6);
test('A5 RecordGroups preserves frozen identity snapshot fields', item?.meta?.speaker_role === 'USER'
  && item?.meta?.enrollment_id === 'voice-a' && item?.meta?.voice_name === 'A'
  && item?.meta?.cosine === 0.63 && item?.meta?.matched === true);

const archivedKey = 's2:boot-A:3:archived-final';
const archivedAt = new Date('2026-09-24T00:00:00.000Z').toISOString();
test('A6 SQLite writes existing RecordGroups with identity and audio_ref metadata', archive.archiveGroup({
  group_id: 'group-speech2-identity', group_seq: 99, created_at: archivedAt, completed_at: archivedAt,
}, [{
  segment_id: archivedKey, item_seq: 1, status: 'succeeded', text: 'persisted identity',
  model: { id: 'sensevoice-t267', runtime: 'app-speech2' }, created_at: archivedAt, completed_at: archivedAt,
  source: 'speech2', source_kind: 'app_segment',
  meta: { speaker_role: 'USER', enrollment_id: 'voice-b', voice_name: 'B', cosine: 0.71, matched: true },
  audio_ref: { source: 'app', segment_id: archivedKey },
}]).ok === true);
const archivedRead = archive.query({ source: 'speech2', limit: 10 }).items.find((x) => x.segment_id === archivedKey);
test('A7 SQLite reload retains identity/audio ref and does not claim archived audio is playable',
  archivedRead?.meta?.speaker_role === 'USER' && archivedRead?.meta?.enrollment_id === 'voice-b'
    && archivedRead?.meta?.voice_name === 'B' && archivedRead?.meta?.cosine === 0.71
    && archivedRead?.meta?.matched === true && archivedRead?.audio_ref?.segment_id === archivedKey
    && archivedRead?.audio_available === false);

const legacyFile = path.join(root, 'legacy-v1.sqlite3');
const legacyDb = new DatabaseSync(legacyFile);
legacyDb.exec(`
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE archived_groups (group_id TEXT PRIMARY KEY, group_seq INTEGER NOT NULL, item_count INTEGER NOT NULL,
    created_at TEXT, completed_at TEXT, archived_at TEXT NOT NULL);
  CREATE TABLE archived_items (segment_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, item_seq INTEGER NOT NULL,
    status TEXT NOT NULL, text TEXT, model_id TEXT, model_runtime TEXT, inference_ms INTEGER,
    segment_start_ms INTEGER, segment_end_ms INTEGER, duration_ms INTEGER, created_at TEXT, completed_at TEXT,
    error TEXT, wav_available INTEGER NOT NULL DEFAULT 0, archived_at TEXT NOT NULL);
  INSERT INTO schema_meta VALUES ('schema_version', '1');
`);
legacyDb.prepare(`INSERT INTO archived_items (
  segment_id, group_id, item_seq, status, text, model_id, created_at, completed_at, archived_at
) VALUES (?,?,?,?,?,?,?,?,?)`).run('old-speech2', 'old-group', 1, 'succeeded', 'old text', 'sensevoice-t267',
  archivedAt, archivedAt, archivedAt);
legacyDb.prepare(`INSERT INTO archived_items (
  segment_id, group_id, item_seq, status, text, model_id, created_at, completed_at, archived_at
) VALUES (?,?,?,?,?,?,?,?,?)`).run('old-other', 'old-group', 2, 'succeeded', 'other text', 'legacy-asr',
  archivedAt, archivedAt, archivedAt);
legacyDb.close();
const migrated = new RecordArchive({ file: legacyFile });
const migrationOpened = await migrated.open();
const migratedSpeech2 = migrated.query({ source: 'speech2' }).items;
const oldText = migrated.query().items.find((x) => x.segment_id === 'old-other');
test('A8 schema v1 migration is additive and exposes only the old T267 row as Speech2',
  migrationOpened && migratedSpeech2.length === 1 && migratedSpeech2[0].segment_id === 'old-speech2'
    && migratedSpeech2[0].text === 'old text' && oldText?.text === 'other text'
    && migratedSpeech2[0].meta === null && migratedSpeech2[0].audio_ref === null);
migrated.close();

const main = fs.readFileSync(new URL('../service/main.mjs', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
test('A9 /records/audio proxies app_segment records to the App archive',
  main.includes("item?.source_kind === 'app_segment'") && main.includes('proxyAppSegmentWav(res, req, segId)'));
test('A10 admit uses audio_ref only when the App archived under the same key',
  main.includes("e.audio_ref?.source === 'app' && e.audio_ref?.segment_id === key"));
test('A11 history item: player via /records/audio + five metrics',
  app.includes('/records/audio?segment_id=') && ['Audio ', 'ASR ', 'Latency ', 'Final ', 'Speed ']
    .every((w) => app.includes(w)));
test('A12 RecordGroups grouping code remains model-agnostic with 50-sentence group size',
  !fs.readFileSync(new URL('../service/storage/groups.mjs', import.meta.url), 'utf8').includes('speech2')
    && fs.readFileSync(new URL('../service/storage/groups.mjs', import.meta.url), 'utf8').includes('GROUP_SIZE = 50'));
archive.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`speech2-archive: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);

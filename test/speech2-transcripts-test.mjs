#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// [INPUT]: A fake App transcript read surface and an in-memory history.
// [OUTPUT]: Host proof of the SPEECH17 consumer semantics — provisional live-only, revision
//           replace, final exactly once, HARD16 final-without-provisional, stale/blank suppression,
//           restart backfill without duplicates, boot epoch change, truncation, layered overview.
// [POS]: Consumer contract test; it never opens audio and never touches a model.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Speech2Transcripts, historyKey } from '../service/speech2-transcripts.mjs';
import { speech2Overview, SPEECH2_SCENES } from '../service/speech2.mjs';
import { AppEventsClient } from '../service/capture/app-events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) {
    console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1;
  }
};

/** A fake App: an append-only event log keyed by (boot_id, seq), like Speech2TranscriptRing. */
const fakeApp = (bootId = 'boot-A') => {
  const app = { bootId, events: [], oldest: 1 };
  app.push = (e) => {
    const seq = app.events.length + 1;
    app.events.push({ boot_id: app.bootId, seq, generation: 1, scene_policy_id: 'MEDIA_STREAM',
      speaker_role: 'UNSPECIFIED', logical_ms: 3000, ...e });
    return seq;
  };
  app.fetchSince = async (after, limit) => {
    const events = app.events.filter((e) => e.seq > after && e.seq >= app.oldest).slice(0, limit);
    const latest = new Map();
    for (const e of app.events.filter((x) => x.seq >= app.oldest)) latest.set(`${e.generation}/${e.segment_id}`, e);
    return { boot_id: app.bootId, events, truncated: after + 1 < app.oldest,
      oldest_available_seq: app.oldest, latest_per_segment: [...latest.values()] };
  };
  return app;
};
const history = () => {
  const rows = new Map();
  return {
    rows,
    onFinal: (e, key) => { if (rows.has(key)) return { admitted: false }; rows.set(key, e.text); return { admitted: true }; },
    hasFinal: (key) => rows.has(key),
  };
};
const noTimers = { setTimer: () => 0, clearTimer: () => {} };

await test('provisional stays live-only and never reaches history', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'hello wor', complete: false });
  await c.sync();
  assert.equal(h.rows.size, 0);
  assert.equal(c.snapshot().current.text, 'hello wor');
  assert.equal(c.snapshot().counters.provisional, 1);
});

await test('rev1 -> rev3 replaces the live provisional (one row, newest text)', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'a', complete: false });
  app.push({ segment_id: 'seg-1', revision: 3, text: 'a b c', complete: false });
  await c.sync();
  const live = c.snapshot().live.filter((x) => x.segment_id === 'seg-1');
  assert.equal(live.length, 1);
  assert.equal(live[0].revision, 3);
  assert.equal(live[0].text, 'a b c');
  assert.equal(c.snapshot().counters.revision_replaced, 1);
});

await test('final after provisional is written to history exactly once', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'a', complete: false });
  app.push({ segment_id: 'seg-1', revision: 3, text: 'a b', complete: false });
  app.push({ segment_id: 'seg-1', revision: 3, text: 'a b c', complete: true });
  await c.sync();
  await c.sync();
  assert.equal(h.rows.size, 1);
  assert.equal([...h.rows.values()][0], 'a b c');
  assert.equal(c.snapshot().live.filter((x) => x.segment_id === 'seg-1').length, 1);
});

await test('RECOVERY20B: Conversation final identity snapshot passes through unchanged for A, B and Other', async () => {
  const app = fakeApp();
  const stored = new Map();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince,
    onFinal: (event, key) => { stored.set(key, structuredClone(event)); return { admitted: true }; },
    hasFinal: (key) => stored.has(key), ...noTimers });
  app.push({ segment_id: 'seg-A', revision: 1, text: 'from A', complete: true,
    scene_policy_id: 'CONVERSATION', speaker_role: 'USER', enrollment_id: 'voice-A',
    voice_name: 'Alice', cosine: 0.63, matched: true });
  app.push({ segment_id: 'seg-B', revision: 1, text: 'from B', complete: true,
    scene_policy_id: 'CONVERSATION', speaker_role: 'USER', enrollment_id: 'voice-B',
    voice_name: 'Bob', cosine: 0.71, matched: true });
  app.push({ segment_id: 'seg-other', revision: 1, text: 'from other', complete: true,
    scene_policy_id: 'CONVERSATION', speaker_role: 'OTHER', enrollment_id: null,
    voice_name: 'Other', cosine: 0.42, matched: false });
  await c.sync();
  const rows = [...stored.values()];
  assert.deepEqual(rows.map((e) => [e.voice_name, e.enrollment_id, e.cosine, e.matched]), [
    ['Alice', 'voice-A', 0.63, true], ['Bob', 'voice-B', 0.71, true], ['Other', null, 0.42, false],
  ]);
  assert.equal(c.snapshot().counters.finals_admitted, 3);
});

await test('HARD16: a final with no preceding provisional is accepted', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-9', revision: 0, text: 'sixteen seconds', complete: true });
  await c.sync();
  assert.equal(h.rows.size, 1);
  assert.equal(c.snapshot().counters.finals_admitted, 1);
});

await test('stale (lower revision after higher) and blank are suppressed', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 3, text: 'new', complete: false });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'old', complete: false });
  app.push({ segment_id: 'seg-2', revision: 1, text: '  。 ', complete: true });
  await c.sync();
  const s = c.snapshot();
  assert.equal(s.counters.suppressed_stale, 1);
  assert.equal(s.counters.suppressed_blank, 1);
  assert.equal(s.live.find((x) => x.segment_id === 'seg-1').text, 'new');
  assert.equal(h.rows.size, 0);
});

await test('restart: persisted cursor backfills the missed final with no duplicate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c-'));
  const cursorFile = path.join(dir, 'cursor.json');
  const app = fakeApp(); const h = history();
  const c1 = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, cursorFile, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'one', complete: true });
  await c1.sync();
  c1.close();
  // termux-speech is down while the App keeps producing.
  app.push({ segment_id: 'seg-2', revision: 1, text: 'two p', complete: false });
  app.push({ segment_id: 'seg-2', revision: 1, text: 'two', complete: true });
  const c2 = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, cursorFile, ...noTimers });
  assert.equal(c2.snapshot().after_seq, 1);
  await c2.sync();
  assert.deepEqual([...h.rows.values()], ['one', 'two']);
  // A cursor lost on disk still cannot duplicate: history is keyed.
  fs.rmSync(cursorFile);
  const c3 = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, cursorFile, ...noTimers });
  await c3.sync();
  assert.equal(h.rows.size, 2);
  assert.ok(c3.snapshot().counters.finals_duplicate >= 2);
});

await test('boot change opens a new transport epoch (old seq never dedups new boot)', async () => {
  const app = fakeApp('boot-A'); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  app.push({ segment_id: 'seg-1', revision: 1, text: 'first life', complete: true });
  await c.sync();
  // App restarts: seq and segment ids restart from 1.
  app.bootId = 'boot-B'; app.events = [];
  app.push({ segment_id: 'seg-1', revision: 1, text: 'second life', complete: true });
  await c.sync();
  assert.equal(c.snapshot().boot_id, 'boot-B');
  assert.equal(c.snapshot().counters.boot_changes, 1);
  assert.equal(h.rows.size, 2, 'same segment_id in a new boot is a new sentence');
  assert.notEqual(historyKey('boot-A', { generation: 1, segment_id: 'seg-1' }),
    historyKey('boot-B', { generation: 1, segment_id: 'seg-1' }));
});

await test('truncated backfill is named and live state is restored from latest_per_segment', async () => {
  const app = fakeApp(); const h = history();
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers });
  for (let i = 0; i < 5; i += 1) app.push({ segment_id: `seg-${i}`, revision: 1, text: `t${i}`, complete: i < 4 });
  app.oldest = 4;
  await c.sync();
  assert.equal(c.snapshot().counters.truncated_gaps, 1);
  assert.ok(c.snapshot().live.some((x) => x.segment_id === 'seg-4'));
});

await test('AppEvents transcript fact only wakes the consumer', async () => {
  const woken = [];
  const events = new AppEventsClient({});
  events.onTranscript = (fact, bootId) => woken.push([fact.transcript_write_seq, bootId]);
  events.ingest(JSON.stringify({ boot_id: 'b', seq: 1, data: { transcript: { transcript_write_seq: 7 } } }));
  assert.deepEqual(woken, [[7, 'b']]);
  const app = fakeApp(); const h = history();
  let wakes = 0;
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, setTimer: () => { wakes += 1; return 1; }, clearTimer: () => {} });
  c.observe({ transcript_write_seq: 0, boot_id: null });
  assert.equal(wakes, 0, 'nothing new ⇒ no fetch');
  c.observe({ transcript_write_seq: 3, boot_id: 'boot-A' });
  assert.equal(wakes, 1);
});

await test('WEBUI18: the cursor file is rewritten only when (boot_id, after_seq) changes', async () => {
  const app = fakeApp(); const h = history();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2cur-'));
  const cursorFile = path.join(dir, 'c.json');
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h, ...noTimers, cursorFile });
  app.push({ segment_id: 'seg-1', revision: 0, text: 'one', complete: true });
  await c.sync();
  const writes1 = c.counters.cursor_writes;
  for (let i = 0; i < 20; i += 1) await c.sync();      // nothing new: must not touch the file
  assert.equal(c.counters.cursor_writes, writes1);
  app.push({ segment_id: 'seg-2', revision: 0, text: 'two', complete: true });
  await c.sync();
  assert.equal(c.counters.cursor_writes, writes1 + 1);
});

await test('WEBUI18: an event-shaped fact wakes by its seq; another bus boot never forces a sync', async () => {
  const app = fakeApp(); const h = history();
  const timers = [];
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  app.push({ segment_id: 'seg-1', revision: 0, text: 'one', complete: true });
  await c.sync();
  const w0 = c.counters.wakes;
  // same transcript boot, seq already consumed, frame from a *different* AppEvents boot ⇒ no wake
  c.observe({ boot_id: 'boot-A', seq: 1 }, 'app-events-boot-Z');
  assert.equal(c.counters.wakes, w0);
  c.observe({ boot_id: 'boot-A', seq: 2 }, 'app-events-boot-Z');
  assert.equal(c.counters.wakes, w0 + 1);
  assert.equal(c.snapshot().wakes_by_reason.event, 1);
});

await test('WEBUI18: start() is idempotent — repeated calls never stack safety chains', async () => {
  const app = fakeApp(); const h = history();
  let armed = 0;
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h,
    setTimer: () => { armed += 1; return armed; }, clearTimer: () => {} });
  for (let i = 0; i < 50; i += 1) c.start();
  // one wake timer + one safety timer, no matter how often start() is called
  assert.equal(armed, 2);
  assert.equal(c.snapshot().wakes_by_reason.start, 1);
});

await test('WEBUI18: the App frame carries transcript at the top level and it wakes the consumer', async () => {
  const app = fakeApp(); const h = history();
  let armed = 0;
  const c = new Speech2Transcripts({ fetchSince: app.fetchSince, ...h,
    setTimer: () => { armed += 1; return armed; }, clearTimer: () => {} });
  c.bootId = 'boot-A'; c.afterSeq = 92;
  const ae = new AppEventsClient({});
  ae.onTranscript = (fact, boot) => c.observe(fact, boot);
  // ⭐ exact App shape (AppEvents.frame): transcript is a sibling of data, not inside it
  ae.ingest(JSON.stringify({ schema: 'x', event: 'speech2.transcript', boot_id: 'bus-1', seq: 7,
    transcript: { boot_id: 'boot-A', seq: 93, segment_id: 'seg-9', revision: 1 }, data: {} }));
  assert.equal(ae.transcriptFrames, 1);
  assert.equal(c.snapshot().wakes_by_reason.event, 1);
});

await test('overview keeps installed / reachable / models / running / analysis separate', () => {
  const down = speech2Overview(null, 'connect ECONNREFUSED');
  assert.equal(down.app_reachable, false);
  assert.equal(down.state, 'unavailable');
  const missing = speech2Overview({ running: false, models: {
    campplus: { installed: true, ready: false }, fireredvad: { installed: true, ready: false },
    sensevoice_t267: { installed: false, ready: false, reason: 'not_installed' } } });
  assert.equal(missing.state, 'model_missing');
  assert.equal(missing.models_ready, false);
  const running = speech2Overview({ running: true, scene_policy_id: 'CONVERSATION', cam_active: true,
    segmentation: { running: true }, models: {
      campplus: { installed: true, ready: true }, fireredvad: { installed: true, ready: true },
      sensevoice_t267: { installed: true, ready: true } } },
    null, { ring: { source_active: true, active_source: 'SYSTEM_BUILTIN_MIC' } });
  assert.equal(running.state, 'running');
  assert.equal(running.analysis_active, true);
  assert.equal(running.scene, 'CONVERSATION');
  assert.deepEqual(SPEECH2_SCENES, ['VOICE_INPUT', 'CONVERSATION', 'MEDIA_STREAM', 'AI_BARGE_IN', 'MEDIA_FILE']);
  // ⭐ WEBUI18：Speech2 在跑但 AudioRing 没有源 ⇒ 不是 running，是 no_input（并带 warning）。
  const deaf = speech2Overview({ running: true, models: {
    campplus: { installed: true, ready: true }, fireredvad: { installed: true, ready: true },
    sensevoice_t267: { installed: true, ready: true } } }, null, { ring: { source_active: false } });
  assert.equal(deaf.state, 'no_input');
  assert.ok(deaf.warnings.includes('no_input_source'));
});

await test('source contract: no dev test route, no model file probing, no realtime logic', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const consumer = strip(fs.readFileSync(path.join(root, 'service/speech2-transcripts.mjs'), 'utf8'));
  const client = strip(fs.readFileSync(path.join(root, 'service/speech2.mjs'), 'utf8'));
  const ui = strip(fs.readFileSync(path.join(root, 'web/app.js'), 'utf8'));
  for (const [name, src] of [['consumer', consumer], ['client', client], ['ui', ui]]) {
    assert.ok(!src.includes('/test/asr-results'), `${name} must not read the dev-only asr-results route`);
    assert.ok(!src.includes('/speech2/test/'), `${name} must not call dev-only Speech2 routes`);
    assert.ok(!/existsSync|statSync/.test(src.replace(/fs\.(mkdirSync|writeFileSync|renameSync|readFileSync)/g, '')),
      `${name} must not probe files to decide readiness`);
    assert.ok(!/\/speech2\/scene\b/.test(src), `${name} must not add a duplicate scene endpoint`);
  }
  assert.ok(ui.includes("p.segmentation.scene = scene"), 'scene goes through policy.segmentation.scene');
  // RECOVERY19F: the Settings controls are real policy consumers. Threshold/confirm are
  // writable; window/step are shown only as effective fixed HTP geometry, never as inputs.
  for (const knob of ['enter_threshold', 'exit_threshold', 'enter_confirm', 'exit_confirm']) {
    assert.ok(ui.includes(knob), `Settings must write runtime CAM field ${knob}`);
  }
  for (const id of ['pol-cam-enter', 'pol-cam-exit', 'pol-cam-enter-confirm', 'pol-cam-exit-confirm']) {
    assert.ok(ui.includes(id), `Settings must render CAM control ${id}`);
  }
  assert.ok(client.includes('cam_policy_geometry'), 'effective CAM geometry must come from App status');
  for (const fixed of ['g.model_window_ms', 'g.model_step_ms', 'g.model_frames', 'g.matches']) {
    assert.ok(ui.includes(fixed), `fixed HTP geometry projection is incomplete: ${fixed}`);
  }
  assert.ok(ui.includes('Geometry is not tunable'), 'fixed HTP geometry must be explicitly read-only');
  assert.ok(!ui.includes('pol-cam-window') && !ui.includes('pol-cam-step'),
    'fixed CAM geometry must not have editable controls');
  const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');
  for (const route of ['/speech2/overview', '/speech2/transcripts/live', '/speech2/history', '/speech2/my-voice']) {
    assert.ok(pkg.includes(`'${route}'`), `package.mjs must register ${route}`);
  }
  const files = fs.readFileSync(path.join(root, 'public-files.txt'), 'utf8');
  for (const f of ['service/speech2-transcripts.mjs', 'web/app.js']) {
    assert.ok(files.split('\n').includes(f), `public-files.txt must list ${f}`);
  }
});

console.log(`speech2-transcripts: ${passed} passed`);

/**
 * [INPUT]: service/speech2.mjs USER voice collection client and overview projection
 * [OUTPUT]: RECOVERY19E/20B: multi-voice client mapping, read-only Test route, and selected target projection.
 * [POS]: Focused package host test; no device, CAM model, mic, or enrollment data.
 * [PROTOCOL]: Update this header when changed, then check AGENTS.md.
 */
import assert from 'node:assert/strict';
import { createSpeech2Client, speech2Overview } from '../service/speech2.mjs';

const calls = [];
const client = createSpeech2Client({ json: async (path, options = {}) => {
  calls.push({ path, ...options }); return { voices: [], user_enrollment_count: 0 };
} });
await client.voices();
await client.addVoice({ label: 'A' });
await client.testVoice('voice-A');
await client.rerecordVoice('voice-A', { duration_ms: 8000 });
await client.renameVoice('voice-A', 'Renamed');
await client.removeVoice('voice-A');
assert.deepEqual(calls.map(({ path, method = 'GET' }) => [method, path]), [
  ['GET', '/api/speech2/voices'],
  ['POST', '/api/speech2/voices'],
  ['POST', '/api/speech2/voices/test'],
  ['POST', '/api/speech2/voices/voice-A/record'],
  ['PATCH', '/api/speech2/voices/voice-A'],
  ['DELETE', '/api/speech2/voices/voice-A'],
]);
assert.equal(calls[2].body.enrollment_id, 'voice-A');
assert.equal(calls[4].body.label, 'Renamed');

const multi = speech2Overview({
  running: true, scene_policy_id: 'VOICE_INPUT', cam: { enrollment_store: { user_count: 2 } },
}, null, { ring: { source_active: true }, policy: { trigger: { mode: 'volume' },
  segmentation: { target_enrollment_id: 'voice-B' } } });
assert.equal(multi.voices_registered, true);
assert.equal(multi.user_voice_count, 2);
assert.equal(multi.selected_target_enrollment_id, 'voice-B');
assert(!multi.warnings.includes('voices_required_for_scene'));
const empty = speech2Overview({
  running: true, scene_policy_id: 'VOICE_INPUT', cam: { enrollment_store: { user_count: 0 } },
}, null, { ring: { source_active: true } });
assert.equal(empty.voices_registered, false);
assert(empty.warnings.includes('voices_required_for_scene'));
console.log('speech2-voices: 4/4 passed');

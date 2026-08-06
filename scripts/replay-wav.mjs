/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 记录组里的 WAV、常驻 FireRedVAD 图、当前切句策略
 * [OUTPUT]: Per-file cut decisions (gradient on vs off) printed as one comparable line each.
 * [POS]: On-device sanity replay. It proves the ported policy runs on real posteriors; it is not a
 *        corpus study — the inputs are already-cut segments, so only trends are meaningful.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeFbank, loadCmvn } from '../service/vad/fbank.mjs';
import { StreamVadPost } from '../service/vad/postprocessor.mjs';

const [, , rootArg, limitArg] = process.argv;
/**
 * ⚠ 改读**记录组**。旧的 `segments.v1.jsonl` 已经不再被写（docs/061 §七），
 * 继续读它会得到一份停在改版那一刻的历史，而且里面的 `wav_path` 指向的文件早已
 * 被移进某一组的目录——「看起来有记录、文件全都 MISSING」是最难看懂的那种失败。
 */
const recordsRoot = rootArg || process.env.RECORD_DATA_ROOT;
const limit = Math.max(1, Number(limitArg) || 12);
const base = process.env.APP_BASE || 'http://127.0.0.1:8796';
const token = process.env.APP_TOKEN || '';
const resident = process.env.VAD_RESIDENT || '';
const cmvn = loadCmvn(fs.readFileSync(process.env.VAD_CMVN || '/sdcard/termux-os/models/fireredvad/cmvn.bin'));

const readWav = (file) => {
  const buffer = fs.readFileSync(file);
  const samples = new Float64Array((buffer.length - 44) / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(44 + i * 2);
  return samples;
};

const posteriors = async (samples) => {
  const { feat } = computeFbank(samples, cmvn);
  const out = [];
  for (let offset = 0; offset < feat.length; offset += 40) {
    const batch = feat.slice(offset, offset + 40);
    const steps = batch.map((row) => {
      const bytes = Buffer.alloc(row.length * 4);
      row.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
      return { inputs: { feat: { dtype: 'float32', shape: [1, 1, row.length], data_b64: bytes.toString('base64') } } };
    });
    const response = await fetch(`${base}/api/inference/residents/${resident}/stream`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reset: offset === 0,
        state_links: { caches_packed: 'new_caches_packed' },
        outputs: ['probs'],
        steps,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = await response.json();
    if (!payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
    out.push(...(payload.data?.values?.probs ?? []));
  }
  return out;
};

const runPolicy = (probs, gradient) => {
  const post = new StreamVadPost({ gradient });
  const cuts = [];
  const ends = [];
  let start = null;
  const spans = [];
  for (const probability of probs) {
    const t = post.process(probability);
    if (t.start_frame != null) start = t.start_frame;
    if (t.cut_frame != null) { cuts.push(t.cut); spans.push([start, t.cut]); start = t.cut_frame + 1; }
    if (t.end_frame != null) { ends.push(t.end_frame); if (start != null) spans.push([start, t.end_frame]); start = null; }
  }
  return { cuts, ends, spans };
};

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const state = readJson(path.join(recordsRoot, 'state.v1.json'));
const records = (state?.groups ?? [])
  .filter((group) => group.state !== 'archived' && group.state !== 'lost')
  .sort((a, b) => a.group_seq - b.group_seq)
  .flatMap((group) => readJson(path.join(recordsRoot, group.group_id, 'items.v1.json')) ?? [])
  .filter((item) => item.wav_path)
  .slice(-limit);

console.log(`resident=${resident} files=${records.length}`);
let gradientTotal = 0;
let plainTotal = 0;
for (const record of records) {
  if (!fs.existsSync(record.wav_path)) { console.log(`  MISSING ${path.basename(record.wav_path)}`); continue; }
  const probs = await posteriors(readWav(record.wav_path));
  const on = runPolicy(probs, true);
  const off = runPolicy(probs, false);
  gradientTotal += on.spans.length;
  plainTotal += off.spans.length;
  const mean = probs.reduce((a, b) => a + b, 0) / (probs.length || 1);
  console.log(
    `  ${record.segment_id} ${String(record.duration_ms).padStart(6)}ms frames=${String(probs.length).padStart(4)}`
    + ` p̄=${mean.toFixed(3)}  gradient: cuts=${on.cuts.length} spans=${on.spans.length}`
    + `  plain: spans=${off.spans.length}`
    + (on.cuts[0] ? `  first=[${on.cuts[0].valley_ms}] score=${on.cuts[0].score}/${on.cuts[0].need}` : ''),
  );
}
console.log(`TOTAL spans gradient=${gradientTotal} plain=${plainTotal}`);

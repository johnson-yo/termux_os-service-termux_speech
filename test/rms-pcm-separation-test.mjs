/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RMS-only/PCM transport classes, consumer aggregation, and the live main wiring
 * [OUTPUT]: Regression proof that RMS waiting has no raw PCM holder or binary payload
 * [POS]: docs/077 + current task; pure host test, no device or microphone required
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RmsWs,
  pcmWebSocketDescriptor,
  rmsWebSocketDescriptor,
} from '../service/pcm-ws.mjs';
import { PcmConsumers } from '../service/pcm-consumers.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');

{
  const consumers = new PcmConsumers([
    { name: 'rms', wantsRms: true, wantsPcm: false },
    { name: 'cam', wantsPcm: true, pcmAdmitted: false },
  ]);
  consumers.setEnabled('rms', true);
  consumers.setEnabled('cam', true);
  test('R1 RMS-only holder does not request raw PCM',
    consumers.wantsRms() === true
      && consumers.rmsHolders().join(',') === 'rms'
      && consumers.wantsPcm() === false
      && consumers.holders().length === 0);
  consumers.setPcmAdmitted('cam', true);
  test('R2 CAM raw PCM is attached only after explicit admission',
    consumers.wantsPcm() === true && consumers.holders().join(',') === 'cam');
  consumers.setPcmAdmitted('cam', false);
  test('R3 closing the PCM admission leaves RMS alive',
    consumers.wantsRms() === true && consumers.wantsPcm() === false);
}

{
  const received = [];
  const rms = new RmsWs({ onRms: (frame) => received.push(frame) });
  rms.handleAnchor(Buffer.from(JSON.stringify({
    schema: 'termux-os.mic-frame-anchor.v1',
    stream: 'rms',
    frame_seq: 17,
    mono_ms: 1234,
    frame_ms: 100,
    capture_generation: 2,
    boot_id: 'boot',
    gap: false,
    rms: 0.125,
  })));
  test('R4 RMS WS emits one metadata frame with App RMS',
    received.length === 1 && received[0].rms === 0.125 && received[0].frame_seq === 17);
  test('R5 RMS WS has received no binary PCM', rms.snapshot().binary_frames === 0);
  rms.handlePcm(Buffer.alloc(3200));
  test('R6 an unexpected binary frame is counted and not delivered as PCM',
    rms.snapshot().binary_frames === 1 && received.length === 1);
}

{
  const descriptor = { baseUrl: 'http://127.0.0.1:8796', authorization: 'Bearer test' };
  const pcm = pcmWebSocketDescriptor(descriptor, 6000);
  const rms = rmsWebSocketDescriptor(descriptor);
  test('R7 PCM descriptor carries bounded pre-roll only on the PCM endpoint',
    pcm.endpoint === 'ws://127.0.0.1:8796/api/android/mic/stream?rms=1&pre_roll_ms=6000'
      && rms.endpoint === 'ws://127.0.0.1:8796/api/android/mic/rms');
}

test('R8 live wiring has separate RMS WS and demand aggregation',
  main.includes('new RmsWs(')
    && main.includes('consumers.wantsRms()')
    && main.includes('rms.configure(rmsWebSocketDescriptor(descriptor))')
    && main.includes('pcm.configure(pcmWebSocketDescriptor(descriptor, 6000))'));

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

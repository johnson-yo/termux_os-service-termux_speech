/**
 * ⚠ 0.21.5 删除了 `web/lab.*`（声学校准 / Endpoint Lab 产品页）。
 *   本文件从此只测**服务端**那条隔离契约（`acoustic-lab.mjs` 到 WAV 为止、
 *   自带 VAD 常驻、一切 `debug_only`），⛔ 不再测一个不存在的页面。
 * ⭐ 服务端保留的理由写在报告里：那些端点仍是唯一能在真实房间里
 *   复现 docs/078–079 判据的工具，而它们不在数据通路上。
 */
/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: AcousticLab 的纯逻辑 + main.mjs/package.mjs 的接线
 * [OUTPUT]: docs/078 的隔离契约与两个真机踩过的坑
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_DEFAULTS, FOREGROUND_DEFAULTS } from '../service/acoustic-lab.mjs';
import { computeFbank } from '../service/vad/fbank.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const lab = fs.readFileSync(path.join(root, 'service/acoustic-lab.mjs'), 'utf8');
const pkg = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');

/**
 * ⭐ 真机上坏在这里：`computeFbank` 返回 `{feat, frames}` 而不是数组，
 *   `if (feats?.length)` 恒为假 ⇒ 一帧特征都没进队，而**没有任何报错**。
 *   这条测试把「它返回的是对象」钉住，下次谁再当数组用会立刻红。
 */
test('L1 computeFbank 返回 {feat,frames}，不是数组',
  (() => {
    const r = computeFbank(new Int16Array(1600), { means: new Float32Array(80), istd: new Float32Array(80).fill(1) });
    return !Array.isArray(r) && Array.isArray(r.feat) && typeof r.frames === 'number';
  })());
test('L2 lab 按对象解构用它，不再当数组', lab.includes('const { feat } = computeFbank('));
test('L3 HALF 触发时把静默计数归零（否则 acoustic_full 永远不触发）',
  /this\.halfIndex \+= 1;[\s\S]{0,300}this\.silSinceHalf = 0;/.test(lab));

test('L4 端点默认值沿用已验证那一组，不凭空重设计',
  ENDPOINT_DEFAULTS.vad_arm === 0.5 && ENDPOINT_DEFAULTS.vad_slope === -0.02
  && ENDPOINT_DEFAULTS.half_hold_ms === 30 && ENDPOINT_DEFAULTS.hard_cap_ms === 8000
  && ENDPOINT_DEFAULTS.max_half === 2
  && FOREGROUND_DEFAULTS.band_half_db === 6 && FOREGROUND_DEFAULTS.min_in_band_ms === 300);

// ── 隔离契约：这一页绝不许碰正式链 ────────────────────────────────────────
test('L5 lab 模块的**代码**里没有 SenseVoice / Audio8 / records 的任何调用',
  (() => {
    // ⚠ 注释里当然会写「不进 SenseVoice、不 records.admit」——把注释算进证据
    //   会得到一个永远失败的假测试（state-test / pcm-fanout-test 都踩过同一个坑）。
    const code = lab.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
    return !/sensevoice|audio8|records|admit|transcribe/i.test(code);
  })());
test('L6 lab 只是一个 consumer，不是 mic 总开关',
  main.includes("{ name: 'lab', wantsPcm: true")
  && main.includes("if (consumers.enabled('lab')) lab.ingest(frame);")
  && main.includes("setConsumer('lab', true)"));
test('L7 停止实验只关 lab 自己',
  /sub === '\/calibration\/stop' \|\| sub === '\/test\/stop'[\s\S]{0,200}setConsumer\('lab', false\)/.test(main));
test('L8 Mic 总开关关闭时实验停止，且不会自行恢复',
  /operation === 'disable'[\s\S]{0,300}lab\.mode = 'idle';/.test(main));
test('L9 事件带 debug 标记，避免被正式 handler 误收',
  lab.includes("source: 'acoustic_lab', debug_only: true"));
test('L10 只保留最新 10 个 epoch，且连 WAV 一起删',
  /while \(this\.epochs\.length > EPOCH_KEEP\)[\s\S]{0,200}fs\.rmSync\(/.test(lab));
/**
 * ⚠ 这一条原本钉的是字面量 `'Content-Type': 'audio/wav'`。代理改成**原样透传**
 *   （content-type 由上游给）之后那个字面量消失了，而契约反而更强了——
 *   钉实现细节的测试，会在实现变得更正确时变红。现在钉的是意图本身：
 *   这条路上不许出现 `.json()`，头由上游决定。
 */
test('L11 WAV 透传不走 JSON 代理（否则会以「解析失败」的形式失败）',
  pkg.includes("context.routes.register('GET', '/acoustic-lab/audio'")
  && (() => {
    const helper = /const pipeWav = async \(req, res, url, label\) => \{[\s\S]*?\n  \};/.exec(pkg)?.[0];
    return Boolean(helper) && !helper.includes('.json()') && helper.includes("['content-type', 'Content-Type']");
  })());
test('L12 lab 自带一张 VAD 常驻图，不与正式那张共用有状态的流',
  lab.includes("id: residentId, model: 'fireredvad'")
  && main.includes('residentId: `${VAD_RESIDENT_ID}-lab`'));

// ── ⭐ 真机上「页面根本没反应」的三个原因，逐个钉死 ────────────────────────

// ── docs/079：双参考接线 ────────────────────────────────────────────────

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

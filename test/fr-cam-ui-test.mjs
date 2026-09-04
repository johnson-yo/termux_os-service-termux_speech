/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: web/{index.html,app.js}、service/{app-pipeline.mjs,config.mjs,main.mjs}
 * [OUTPUT]: docs/099 的 UI 侧契约——segment 新语义、旧值迁移、countdown 换源
 * [POS]: ⭐ 源码级断言。这些在运行期看不出来：countdown 读一个死域照样显示 `(0s)`，
 *        而「0」与「不知道」在界面上长得一模一样。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEGMENTS, canonicalSegment, validateSelection } from '../service/app-pipeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const html = read('web/index.html');
const app = read('web/app.js');
const main = read('service/main.mjs');

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

/** 只看代码，⛔ 不看注释——这一轮的注释里必然写着被禁的那些名字。 */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');
const appCode = codeOnly(app);
const bodyOnly = html.replace(/<!--[\s\S]*?-->/g, '');

/* ── segment 新语义 + 旧值迁移 ────────────────────────────────────── */

test('E1 断句层的取值域是 fireredvad / fireredvad_camplus',
  SEGMENTS.length === 2
  && SEGMENTS.includes('fireredvad') && SEGMENTS.includes('fireredvad_camplus'));

test('E2 ⭐ 旧值 camplus 迁移成 fireredvad_camplus（⛔ 不报错）',
  canonicalSegment('camplus') === 'fireredvad_camplus'
  && canonicalSegment('fireredvad') === 'fireredvad'
  && validateSelection({ trigger: 'passthrough', segment: 'camplus', asr: 'sensevoice' })
    .segment === 'fireredvad_camplus');

test('E3 ⛔ 认不出的值仍然要报错（迁移不是"什么都收"）', (() => {
  try {
    validateSelection({ trigger: 'passthrough', segment: 'nonsense', asr: 'sensevoice' });
    return false;
  } catch { return true; }
})());

/**
 * ⭐ conf 里的旧值也必须迁移（`normalizeConfig` 不导出，故按源码断言）。
 * ⚠ 判据刻意包含**回落值**：旧代码的回落是 `camplus`，那会让一个空 conf
 *   直接进入退役语义。
 */
test('E4 conf 里的旧值也迁移，⛔ 不让一次重启把人挡在门外',
  read('service/config.mjs').includes("raw0 === 'camplus' ? 'fireredvad_camplus' : raw0")
  && read('service/config.mjs').includes("['fireredvad', 'fireredvad_camplus'].includes(canonical) ? canonical : 'fireredvad'"));

test('E5 两组 selector 的 option 都是新值，⛔ camplus 不再作为独立断句器出现',
  (bodyOnly.match(/<option value="fireredvad">/g) ?? []).length === 2
  && (bodyOnly.match(/<option value="fireredvad_camplus">/g) ?? []).length === 2
  && !bodyOnly.includes('<option value="camplus"'));

test('E6 Header short 标签：FR / FR+C',
  main.includes("fireredvad: 'FR'") && main.includes("fireredvad_camplus: 'FR+C'")
  // ⚠ 旧值仍在表里 —— 那是**读**得懂旧配置的需要。
  && main.includes("camplus: 'FR+C'"));

test('E7 ⛔ 用户可见文案不再把 CAM++ 说成一个断句器',
  !bodyOnly.includes('<option value="camplus">CAM++</option>')
  && bodyOnly.includes('FireRedVAD + CAM++（本人过滤）'));

/* ── countdown 换源 ──────────────────────────────────────────────── */

test('E8 ⭐ countdown 读 App 的 segmenter 事实（active_ms / hard_cap_ms）',
  appCode.includes('const hardCapMs = Number(segmenter?.config?.hard_cap_ms);')
  && appCode.includes('const activeMs = Number(segmenter?.active_ms);')
  && appCode.includes('const remainMs = Math.max(0, hardCapMs - activeMs);'));

test('E9 ⛔ countdown 不再读两个 legacy 死域',
  !appCode.includes('automatic_cam_admission?.remaining_seconds')
  && !/gc-vad[\s\S]{0,900}vad\?\.activity\?\.segment_ms/.test(appCode));

/**
 * ⭐ **null / 缺失必须显示 `—`，⛔ 不是 `(0s)`**。
 * ⚠ 这正是旧 bug 的形状：`Number(null)` 是 **0 不是 NaN**，于是「读不到」
 *   被画成了「还剩 0 秒」，而使用者只看得见那个 0。
 */
test('E10 ⭐ 读不到时显示 —，⛔ 不是 0',
  appCode.includes("setText(elVadCountdown, '(—)');")
  && appCode.includes('!Number.isFinite(hardCapMs) || !Number.isFinite(activeMs)')
  && !appCode.includes("? `(${Math.max(0, Math.ceil(remain))}s)` : '(0s)'"));

test('E11 段落未打开时也是 —（⛔ 不拿上一段的残值顶替）',
  appCode.includes("const chunkOpen = segmenter?.active === true;")
  && appCode.includes('stopped || !chunkOpen'));

/* ── LIVE：FR 永远是断句层，CAM 只是过滤 ─────────────────────────── */

test('E12 ⭐ FR telemetry 永远显示（⛔ CAM 不再替代它）',
  appCode.includes("setText(off, `RMS · FireRedVAD${camOn ? ' · CAM++ 本人过滤' : ''} · 1秒/柱`);")
  && appCode.includes('const frPart = `FR ${'));

test('E13 CAM++ 只在开了本人过滤时追加相似度与本人/非本人',
  appCode.includes('const camPart = camOn')
  && appCode.includes("apSegment.state === 'USER' ? '本人' : '非本人'"));

test('E14 阈值线永远是 FR 的语音概率阈值（它是断句层）',
  appCode.includes('camLine.title = `FireRedVAD 语音阈值: ${vadThreshold.toFixed(2)}`'));

test('E15 CAM++ 参数的"此刻不生效"判据是**过滤开没开**，⛔ 不是"谁在断句"',
  appCode.includes("camIdle.hidden = eff.segment === 'fireredvad_camplus';"));

test('E16 模型需求：FR 永远需要，CAM++ 只在开过滤时需要',
  appCode.includes("const camNeeded = effSegment === 'fireredvad_camplus';")
  && app.includes('FireRedVAD 当前需要（唯一断句器）'));

/* ── Flow 仍然三节点 ─────────────────────────────────────────────── */

test('E17 ⛔ 不新增第四个 flow 节点',
  (bodyOnly.match(/class="gate-box/g) ?? []).length === 3
  && bodyOnly.includes('id="gn-rms"') && bodyOnly.includes('id="gn-vad"')
  && bodyOnly.includes('id="gn-asr"'));

test('E18 三层 API 形状不变（⛔ 没有第四层）',
  appCode.includes("trigger: ['pipe-trigger', 'set-pipe-trigger']")
  && appCode.includes("segment: ['pipe-segment', 'set-pipe-segment']")
  && appCode.includes("asr: ['pipe-asr', 'asr-model']")
  && !appCode.includes('speaker_filter'));

console.log(`fr-cam-ui-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

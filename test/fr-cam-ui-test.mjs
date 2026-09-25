/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: web/{index.html,app.js}、service/{app-pipeline.mjs,config.mjs,main.mjs}
 * [OUTPUT]: docs/099 的 service 侧契约（segment 取值域、旧值迁移）+ RECOVERY20B：真实 CAM meter 比例
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

/*
 * ⭐ CP-SPEECH2-WEBUI18 按新意图改写：E5–E18 钉的是旧页面的「Segmentation 选择器 / FR+C 标签 /
 *   countdown 读 App segmenter / 三层 Pipeline 选择器」——那一整套随旧 speech 产品面退役
 *   （Speech2 用 Scene 取代 Segmentation）。上面 E1–E4 的 service 侧取值域与旧值迁移仍然有效
 *   （旧 conf 里存着的值必须继续读得懂），故保留。
 */
test('E5 ⭐ 旧 Segmentation 选择器与三层 Pipeline 选择器已退出产品页',
  !/pipe-segment|set-pipe-segment|pipe-trigger|set-pipe-asr|fireredvad_camplus/.test(bodyOnly + appCode));
test('E6 Overview uses three real meters and a 60-second chart; retired flow controls stay absent',
  ['live-rms-meter', 'live-fr-meter', 'live-cam-meter'].every((id) => bodyOnly.includes(`id="${id}"`))
  && !/class="gate-box|id="gn-(trigger|scene|asr)/.test(bodyOnly)
  && bodyOnly.includes('id="live-history"')
  && appCode.includes('const LIVE_WINDOW_SECONDS = 60;')
  && appCode.includes('for (let i = 0; i < LIVE_WINDOW_SECONDS; i += 1)')
  && appCode.includes('activity.cam_cosine')
  && appCode.includes('bar.style.width = `${v === null ? 0 : v * 100}%`')
  && appCode.includes('Math.round(r.cosine * LIVE_PLOT_HEIGHT)')
  && !appCode.includes('PLOT_H * 0.7'));

console.log(`fr-cam-ui-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

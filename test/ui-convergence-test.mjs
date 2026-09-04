/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `web/` 的 Overview / Settings / My Voice DOM 与渲染接线
 * [OUTPUT]: 三个产品 tab、runtime 事实位置、设置边界、原生声纹登记与选定 VAD 计时来源的结构回归
 * [POS]: UI 产品收敛的结构钉；不以文案假绿，优先检查 DOM/调用关系。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const html = read('web/index.html');
const app = read('web/app.js');
const views = read('web/views.js');
const speaker = read('web/speaker.html');
const speakerJs = read('web/speaker.js');
const speakerCss = read('web/speaker.css');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const body = stripHtmlComments(html);

let failed = 0;
const test = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

// ── My Voice：产品页原生，Speaker Lab 只能留在开发者页面 ────────────────
const speakerBody = stripHtmlComments(speaker);
const devOpen = speakerBody.indexOf('<details id="dev-lab">');
const devClose = speakerBody.indexOf('</details>');
const insideLab = (needle) => {
  const at = speakerBody.indexOf(needle);
  return at > devOpen && at < devClose;
};
test('V1 Speaker Lab 折叠，产品三步在前', devOpen > 0 && devClose > devOpen
  && ['第 1 步', '第 2 步', '第 3 步'].every((x) => speakerBody.indexOf(x) < devOpen)
  && speakerBody.indexOf('id="enrollments"') < devOpen);
test('V2 threshold/score/candidate 只在 Lab，不进入 My Voice 产品 tab',
  ['id="cfg-threshold"', 'id="cfg-window_ms"', 'id="cfg-step_ms"', 'id="lab-facts"']
    .every(insideLab)
  && !body.includes('speaker.html')
  && !body.includes('<iframe'));
test('V3 enrollment 样本支持试听、删除、重录',
  body.includes('id="vc-clips"') && speakerJs.includes("createElement('audio')")
  && speakerJs.includes('/speaker/audio?clip=')
  && speakerJs.includes("textContent = '删除'") && speakerJs.includes("textContent = '重录'")
  && /again\.onclick[\s\S]{0,240}\/speaker\/profile\/remove[\s\S]{0,240}\/speaker\/enroll\/start/.test(speakerJs));
test('V4 Lab 错误仍有可见错误区，且不与产品页混用',
  speaker.includes('id="page-error"') && speaker.indexOf('id="page-error"') < devOpen
  && speakerCss.includes('#dev-lab > summary'));

// ── 三页 sitemap / inventory ──────────────────────────────────────────────
const pages = [...body.matchAll(/data-page="([a-z-]+)"/g)].map((m) => m[1]);
test('U1 主导航正好 Overview / Settings / My Voice 三个 tab',
  JSON.stringify(pages) === JSON.stringify(['overview', 'settings', 'voice']), pages.join(','));
test('U2 页面容器与导航一一对应，旧 speech/diagnostics 页面消失',
  ['overview', 'settings', 'voice'].every((p) => body.includes(`id="page-${p}"`))
  && !body.includes('id="page-speech"') && !body.includes('id="page-diagnostics"')
  && !body.includes('data-page="speech"') && !body.includes('data-page="diagnostics"'));
test('U3 app PAGES 与 DOM 一致',
  /PAGES = Object\.freeze\(\['overview', 'settings', 'voice'\]\)/.test(app));
test('U4 Overview 是事实与控制页：RMS/CAM/VAD/ASR 读数与开关行都在 Overview', (() => {
  const overview = body.slice(body.indexOf('id="page-overview"'), body.indexOf('id="page-settings"'));
  return ['rms-current', 'rms-avg', 'rms-threshold', 'rms-admission', 'cam-plot', 'rms-cam-countdown',
    'cam-live', 'cam-owner', 'vad-mode', 'vad-owner', 'vad-live', 'asr-owner', 'ov-current',
    /** ⚠ `man-toggle` / `ac-mic` 是已删除的旧模式按钮；手动入口现在是 `pd-manual`。 */
    'asr-model-facts', 'res-enabled', 'pd-manual'].every((id) => overview.includes(`id="${id}"`));
})());
test('U5 Settings 收拢可修改配置，并按功能折叠', (() => {
  const settings = body.slice(body.indexOf('id="page-settings"'), body.indexOf('id="page-voice"'));
  return (settings.match(/<details class="card settings-group/g) ?? []).length >= 3
    && ['asr-model', 'asr-language',
      'open-threshold', 'input-device', 'enable', 'disable', 'card-models-wrap']
      .every((id) => settings.includes(`id="${id}"`))
    && settings.includes('id="pol-spk-usertimeout"')
    // ⚠ `pol-vad-provider` → `set-pipe-segment`：断句方式归 Pipeline，⛔ 不再是 policy 字段。
    && settings.includes('id="set-pipe-segment"')
    && /<details class="card settings-group" id="card-policy">/.test(settings)
    && !/<details class="card settings-group" id="card-policy" open>/.test(settings);
})());
test('U6 My Voice 只有 native enrollment，且没有旧页/图表入口', (() => {
  const voice = body.slice(body.indexOf('id="page-voice"'));
  return ['vc-start', 'vc-stop', 'vc-build', 'vc-clear', 'vc-enable', 'vc-clips']
    .every((id) => voice.includes(`id="${id}"`))
    && !voice.includes('speaker.html') && !voice.includes('<iframe')
    && !voice.includes('cam-plot') && !voice.includes('Activity Test');
})());
test('U7 固定 CAM++ timeout 不暴露为 Settings 输入',
  !body.includes('camplus-timeout') && !body.includes('cam_timeout_seconds')
  && !body.includes('cam-timeout-seconds'));
test('U8 产品源码不恢复已删除的 KWS/keyword 入口',
  !body.toLowerCase().includes('kws') && !body.toLowerCase().includes('keyword'));

// ── 顶层绑定与 renderer 接线 ──────────────────────────────────────────────
const bindings = [...stripJsComments(app).matchAll(
  /^\$\('([\w-]+)'\)(\??)\.(addEventListener|onclick|oninput|onchange)/gm,
)].map(([, id, optional]) => ({ id, optional: optional === '?' }));
const missing = bindings.filter((b) => !b.optional && !html.includes(`id="${b.id}"`));
test(`U9 顶层绑定的每个 id 都存在或使用可选绑定（${bindings.length} 个）`,
  bindings.length > 0 && missing.length === 0, missing.map((x) => x.id).join(','));

const writes = /\$\('([\w-]+)'\)\.(textContent|className|innerHTML|value|disabled|hidden|src|title)/g;
const dangling = [];
for (const [file, source] of [['views.js', views], ['app.js', app]]) {
  for (const [, id] of stripJsComments(source).matchAll(writes)) {
    if (!html.includes(`id="${id}"`)) dangling.push(`${file}:${id}`);
  }
}
test('U10 renderer 直写的每个 id 都在页面里', dangling.length === 0, [...new Set(dangling)].join(','));
test('U11 每个导出的 renderer 都有 app caller', (() => {
  const exported = [...views.matchAll(/^    (render[A-Z]\w*),$/gm)].map((m) => m[1]);
  const uncalled = exported.filter((name) => !app.includes(`V.${name}(`));
  if (uncalled.length) console.log(`   uncalled: ${uncalled.join(', ')}`);
  return exported.length > 0 && uncalled.length === 0;
})());
test('U12 区域失败隔离且可见',
  /for \(const \[name, needs, render\] of REGIONS\)[\s\S]{0,400}try \{[\s\S]{0,120}render\(\);/.test(app)
  && app.includes('regionFailures') && body.includes('id="region-failures"'));
test('U13 状态流成功也更新 LIVE，而不是永远 CONNECTING',
  /socket\.onmessage[\s\S]{0,600}setBadge\(\$\('pipeline-live'\), 'LIVE'/.test(app)
  && app.includes("'状态流断开，正在重连…'"));
/**
 * ⚠ 判据不变（电平够 **或** 门开了），来处变了：门开与否现在按 trigger 的产品语义
 *   由 App 回答（直通=常开、停止=常关、音量/拍掌=App 的 `admitted`），
 *   ⛔ 不再一律拿本包 RMS 比阈值——真机上本包那条 RMS 已经三个半小时没有新帧。
 */
test('U14 Overview 门开时按处理门说听到了',
  /const heard = level >= 0\.02 \|\| gateOpen;/.test(app)
    && app.includes("const gateOpen = stopped ? false"));
/**
 * ⭐ **按新意图改写**，⛔ 不是绕过。
 * OLD → 「手动听写」模式下 FireRedVAD 的计时不许拿常开的 RMS 门当说话。
 * WHY OBSOLETE → 手动/自动这套模式已经不存在；三层 Pipeline 里没有"手动听写"。
 * NEW → 保住的是**同一条原则**：语音层必须跟一条**真的活动事实**，
 *   ⛔ 不许因为门开着（直通就是永远开着）就画成一直在说话。
 */
test('U14b 语音层跟真实活动事实，⛔ 不把常开的门当成持续说话',
  app.includes('&& Number.isFinite(vadProb) && vadProb >= vadThreshold && vadFresh')
    && app.includes('lastVadAdvanceAtMs')
    && !app.includes('const isSpeaking = speaking || heard || domains.vad?.activity?.active === true;'));
test('U15 Audio8/SenseVoice 都从同一份 public ASR live 状态读文字',
  views.includes('value?.latest') && views.includes('current?.backend')
  && app.includes("['overview-asr-live', ['asr_live']"));

console.log(failed === 0 ? '\nui-convergence: all green' : `\nui-convergence: ${failed} failed`);
process.exit(failed ? 1 : 0);

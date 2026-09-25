/**
 * [INPUT]: Recovery20B Speech page, transcript client, archive and existing RecordGroups contract.
 * [OUTPUT]: Static contract checks for Overview / History / Settings, LIVE transcript slots, and no temporary UI.
 * [POS]: Product-surface test; browser layout and actual rendered meter proportions are tested separately.
 * [PROTOCOL]: Update this header when changed, then check AGENTS.md.
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const htmlRaw = read('../web/index.html');
const appRaw = read('../web/app.js');
const css = read('../web/style.css');
const main = read('../service/main.mjs');
const speech2 = read('../service/speech2.mjs');
const transcripts = read('../service/speech2-transcripts.mjs');
const archive = read('../service/storage/archive.mjs');
const groups = read('../service/storage/groups.mjs');
const packageSource = read('../package.mjs');
const publicFiles = read('../public-files.txt');
const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, ' ');
const code = appRaw.replace(/\/\*[\s\S]*?\*\//g, ' ');
const overview = html.slice(html.indexOf('id="page-overview"'), html.indexOf('id="page-history"'));
const history = html.slice(html.indexOf('id="page-history"'), html.indexOf('id="page-settings"'));
const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('</main>'));

let passed = 0; let failed = 0;
const test = (name, ok) => { if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name}`); } };
const tabs = [...html.matchAll(/role="tab"[^>]*data-page="([^"]+)"[^>]*>([^<]*)</g)];

test('U1 三页导航固定为 Overview / History / Settings',
  JSON.stringify(tabs.map((m) => [m[1], m[2].trim()])) === JSON.stringify([
    ['overview', 'Overview'], ['history', 'History'], ['settings', 'Settings'],
  ]) && code.includes("const PAGES = Object.freeze(['overview', 'history', 'settings']);"));
test('U2 Overview 含日常 Start/Stop、Mode、Activation、LIVE 三条 meter',
  ['ov-start', 'ov-stop', 'ov-scene', 'ov-trigger', 'live-rms-meter', 'live-fr-meter', 'live-cam-meter']
    .every((id) => overview.includes(`id="${id}"`))
    && /<span>Mode<\/span>/.test(overview) && /<span>Activation<\/span>/.test(overview));
test('U3 Overview 没有技术状态墙、临时验收入口或独立 Apply',
  !/MEM|ZRAM|pipeline|tensor id|gate flow|ownership|latest decision|acceptance|mic-acceptance|\bApply\b/i.test(overview));
test('U4 LIVE 只有当前 provisional 与最新 final 两个固定文字位，不生成 transcript 列表',
  overview.includes('id="live-current-half"') && overview.includes('id="live-previous-final"')
    && overview.includes('id="live-speech-lines"')
    && overview.includes('<div class="cam-history" id="live-history"></div>')
    && code.includes('s?.current?.text') && code.includes('Array.isArray(s?.live)')
    && code.includes('row?.complete === true'));
test('U5 常规网页源码已移除临时判断录音工具与轮询',
  !/test-recording|判断录音|tr-start|tr-player/.test(html + code));
test('R1 临时录音 backend、路由和公开包条目均已移除',
  !/test-recording/.test(main + packageSource + publicFiles)
    && !fs.existsSync(new URL('../service/test-recording.mjs', import.meta.url)));
test('U6 Activation 仅提供 Voice activated / Always listening；Stop 是运行按钮',
  /<option value="volume">Voice activated<\/option>/.test(overview)
    && /<option value="passthrough">Always listening<\/option>/.test(overview)
    && !/option value="stop"/.test(overview));
test('U7 Mode / Activation / target 变更直接写当前完整 policy，不要求 Apply',
  code.includes("$('ov-trigger')?.addEventListener('change', applyActivation)")
    && code.includes("$('ov-scene')?.addEventListener('change', applyMode)")
    && code.includes("$('ov-target')?.addEventListener('change', applyTarget)")
    && code.includes("request('/speech2/policy')")
    && code.includes("method: 'PUT', body: next")
    && !overview.includes('id="ov-apply"'));
test('U8 target voice 只在 Voice Input 显示，候选来自 USER voices；Setup 定位 My Voices',
  code.includes("wrap.hidden = o?.scene !== 'VOICE_INPUT'")
    && code.includes("Array.isArray(voice?.voices)")
    && code.includes("p.segmentation.target_enrollment_id = id")
    && code.includes("selectPage('settings')")
    && settings.includes('id="card-voice"'));
test('U9 Conversation / Media 的人话说明与过滤语义明确',
  code.includes('Everyone is transcribed. Known voices are named.')
    && code.includes('Speech is transcribed without speaker filtering.')
    && code.includes('Only ${targetName} will be transcribed.'));

test('H1 History 独立页面支持 keyset Load more，不锁 Recent 10',
  history.includes('id="history-list"') && history.includes('id="history-more"')
    && code.includes("new URLSearchParams({ limit: '50' })")
    && code.includes("query.set('before_at'") && code.includes("query.set('before_id'")
    && !code.includes("limit: '10'"));
test('H2 每条历史项读取持久 meta identity，不读取 LIVE CAM 回填',
  code.includes('const meta = it.meta ?? {}') && code.includes('meta.enrollment_id')
    && code.includes('meta.voice_name') && code.includes('meta.cosine') && code.includes('meta.matched')
    && main.includes('speaker_role: e.speaker_role') && main.includes('enrollment_id: e.matched === true')
    && main.includes('voice_name: e.matched === true') && main.includes('matched: e.matched === true'));
test('H3 沿用 RecordGroups、50句轮转、既有 SQLite archive 与 /records/audio',
  groups.includes('export const GROUP_SIZE = 50;')
    && main.includes('records.liveGroups()') && main.includes('archive.query({ limit: Math.min(200, limit + 1)')
    && archive.includes('meta_json') && archive.includes('audio_ref_json')
    && code.includes('/records/audio?segment_id='));
test('H4 retention 后保留文字、不创建坏播放器；性能细节默认折叠',
  code.includes("it.audio_available === true") && code.includes("'Audio expired'")
    && code.includes("el('details', 'tx-details')") && !/details[^>]+open/.test(code));
test('H5 History 继续展示 Audio / ASR / Latency / Final / Speed',
  ['Audio ', 'ASR ', 'Latency ', 'Final ', 'Speed '].every((part) => code.includes(part)));

test('C1 同一 enrollment 的颜色保存在 localStorage；最多四个 distinct voice 色，Other 灰色',
  code.includes("const SPEAKER_COLOR_KEY = 'termux-speech.speaker-colors.v1'")
    && code.includes('localStorage.getItem(SPEAKER_COLOR_KEY)')
    && code.includes('localStorage.setItem(SPEAKER_COLOR_KEY')
    && code.includes("'speaker-other'") && css.includes('.speaker-other { --speaker-color: #8993a1; }'));
test('C2 LIVE CAM 使用真实 cosine 百分比，不以固定 USER 高度冒充',
  code.includes('activity.cam_cosine') && code.includes('bar.style.width = `${v === null ? 0 : v * 100}%`')
    && !code.includes('PLOT_H * 0.7'));
test('C3 LIVE CAM 显示真实 best VoiceName/分数，未匹配明确标为 Not matched/Other',
  html.includes('id="live-cam-name"') && html.includes('id="live-cam-value"')
    && code.includes('cam_best_enrollment_label') && code.includes("'Not matched'")
    && code.includes("activity.cam_ownership === 'OTHER'") && code.includes('Best voice:'));
test('U10 用户可见 WebUI 文案统一使用 Speech，不泄漏 Speech2 品牌字样',
  html.includes('<span class="status-lbl">Speech</span>')
    && !/<span class="status-lbl">Speech2<\/span>/.test(html)
    && !/aria-label="Speech2[^\"]*"/.test(html)
    && !/title="[^\"]*Speech2[^\"]*"/.test(html)
    && !/Speech2 (?:started|stopped|unreachable|policy unavailable|is not running|was stopped)/.test(code));

test('S1 Settings 保留多人 My Voices 的 Add / Re-record / Rename / Delete',
  ['card-voice', 'vc-add', 'vc-voices', 'vc-clips'].every((id) => settings.includes(`id="${id}"`))
    && ['Re-record', 'Rename', 'Delete'].every((label) => code.includes(label)));
test('S2 My Voices Test 是 5 秒正式入口并走只读 voices/test 路由',
  code.includes('Test · 5 s') && code.includes("request('/speech2/voices/test'")
    && code.includes('startVoiceTest') && main.includes("route === '/speech2/voices/test'")
    && !settings.includes('test-recording'));
test('S2a My Voices Test 展示最佳声纹/分数/结论，并在作业终态清除录音提示',
  code.includes('tr?.best_voice_name ? `Best ${tr.best_voice_name}`')
    && code.includes('`${best} · ${score} · ${matched ? \'Matched\' : \'Not matched\'}`')
    && code.includes("job.mode === 'test' && !active")
    && code.includes("voiceNotice('Speak normally for five seconds.', 'warn')"));
test('S3 Advanced 折叠包含 Speech policy / Audio input / Models',
  settings.includes('id="card-advanced"') && ['card-policy', 'card-input', 'card-models']
    .every((id) => settings.includes(`id="${id}"`)));
test('P1 no-trailing-slash package entry resolves stylesheet and app script inside the package',
  html.includes('<base href="/packages/github.termux-os.service.termux-speech/">')
    && html.includes('href="style.css"') && html.includes('src="app.js"'));

test('I1 Conversation / transcript consumer 保存每个 final 的身份快照字段',
  transcripts.includes('enrollment_id') && transcripts.includes('voice_name')
    && transcripts.includes('cosine') && transcripts.includes('matched'));
test('I2 History 的 App audio_ref 只在 segment id 一致时使用旧代理契约',
  main.includes("e.audio_ref?.source === 'app' && e.audio_ref?.segment_id === key")
    && main.includes("{ source: 'app', segment_id: key }"));
test('I3 字幕时间缺失显示横线，不伪装成 Unix epoch',
  code.includes('const time = new Date(at)') && code.includes('Number.isFinite(time.getTime())'));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

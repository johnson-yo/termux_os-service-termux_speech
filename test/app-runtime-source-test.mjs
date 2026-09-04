/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: web/{index.html,app.js,views.js}、service/{main.mjs,app-pipeline.mjs}、RecordGroups
 * [OUTPUT]: docs/097 的两条硬约束——① 页面 runtime 事实只有一个来处（App）；
 *           ② 同一段音频不许在历史里变成两条句子
 * [POS]: 前一半是源码级断言（这些不变式在运行期看不出来：多读一个旧域、少一个
 *        provider 分支，页面照样画得出图，只是画的是另一台机器），
 *        后一半是真的建目录、真的写记录的行为回归。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordGroups } from '../service/storage/groups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const html = read('web/index.html');
const app = read('web/app.js');
const views = read('web/views.js');
const main = read('service/main.mjs');
const client = read('service/app-pipeline.mjs');

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

/** 只看代码，⛔ 不看注释——这一轮加的注释里必然写着被禁的那些名字。 */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');
const appCode = codeOnly(app);
const viewsCode = codeOnly(views);

/* ══════════════════════════════════════════════════════════════
   A. runtime 事实只有一个来处
   ══════════════════════════════════════════════════════════════ */
test('A1 服务端有 app_pipeline 域，且它在热通道里',
  main.includes('app_pipeline: () => appPipelineProjection()')
  && /HOT_DOMAINS = \[[^\]]*'app_pipeline'/.test(main));

test('A2 telemetry 是六个只读端点的并行读取，且逐个失败互不影响',
  client.includes("one('/api/speech/activity')")
  && client.includes("one('/api/audio/gate/state')")
  && client.includes("one('/api/audio/segment/state')")
  && client.includes("one('/api/android/mic/status')")
  && client.includes("one('/api/speech/policy')")
  && client.includes('return { ok: false, error: String(error?.message ?? error) };'));

test('A3 ⭐ 没人在看时一次 HTTP 都不发（观测成本正比于有没有观测者）',
  main.includes('if (!hub?.watching) return;')
  && main.includes('startAppTelemetry();'));

/**
 * ⚠ 慢档的判据必须是"它自己上一次跑是多久以前"，⛔ 不是"此刻有没有 watcher"：
 *   watcher 在两次长轮询之间会短暂消失，1.5 秒的采样点经常正好落在那个缝里。
 */
test('A3b 两档由同一个 tick 驱动，慢档按自己的时钟到期',
  main.includes("if (Date.now() - appRuntime.slow_at_ms >= APP_TELEMETRY_SLOW_MS) void pollAppTelemetry('slow');")
  && (main.match(/setInterval\(\(\) => \{\n    if \(!hub\?\.watching\) return;/g) ?? []).length === 1);

test('A4 ⚠ 轮询次数与读取时刻不驱动推送（⛔ 否则测的是时间不是状态）',
  read('service/state-hub.mjs').includes("'fast_at_ms',")
  && read('service/state-hub.mjs').includes("'polls',"));

test('A4b ⚠ App 的 pipeline 是**扁的**，⛔ 不是本包那层 `app` 包装（读错字段=合法但错误的答案）',
  main.includes("const app = (p && typeof p === 'object' && 'effective' in p) ? p : (p?.app ?? null);"));

test('A4c 第一份 snapshot 带当前 telemetry（⛔ 不自己造一个"陈旧"出来）',
  main.includes("await pollAppTelemetry('slow').catch(() => {});")
  && main.includes("if (!hub.watching) void pollAppTelemetry('fast');"));

test('A4d ⭐ 两档轮询各有各的互斥锁与各自的新鲜度时钟',
  main.includes('let fastInFlight = false;') && main.includes('let slowInFlight = false;')
  && main.includes('if (fast ? fastInFlight : slowInFlight) return;')
  && main.includes('&& appRuntime.slow_at_ms > 0 && (now - appRuntime.slow_at_ms) < APP_TELEMETRY_SLOW_STALE_MS')
  && main.includes('pipeline_age_ms:'));

test('A4e 切换发生的那一刻立刻重读（⛔ 不等下一个 tick）',
  /PUT' && route === '\/pipeline'[\s\S]{0,1200}await pollAppTelemetry\('slow'\)/.test(main));

test('A5 ⭐ 读不到就说读不到（⛔ 不拿最后一次读到的值冒充"现在"）',
  main.includes('fresh: appRuntime.fast_at_ms > 0 && (now - appRuntime.fast_at_ms) < APP_TELEMETRY_STALE_MS')
  && app.includes('读数已陈旧'));

test('A6 Header 六格全部读 app_pipeline，⛔ 不再读 lifecycle.chain / pipeline.owner',
  appCode.includes('const updateHeaderStatus = (liveTone = \'ok\') => {')
  && appCode.includes('const ap = domains.app_pipeline ?? null;')
  && !/updateHeaderStatus[\s\S]*?domains\.lifecycle\?\.chain/.test(appCode)
  && !/updateHeaderStatus[\s\S]*?domains\.pipeline\?\.owner/.test(appCode));

/**
 * ⚠ **按新意图改写**（docs/099）：`segment` 那一层现在回答的是
 *   「要不要开 CAM++ 本人过滤」，⛔ 不再是「谁在断句」——断句器只有 FR 一个。
 * ⭐ 不变的仍然是那条：**只有一个来处**，且是 App effective。
 */
test('A7 当前 segment 档位只有一个来处（App effective），⛔ 不从本包字段里猜',
  appCode.includes("const currentSegment = () => domains.app_pipeline?.effective?.segment ?? null;")
  && appCode.includes("const camFilterOn = () => currentSegment() === 'fireredvad_camplus';")
  && !appCode.includes("domains.speech_input?.downstream?.vad_mode"));

test('A8 ⭐ 三层的两组 selector 是同一个控件的两个视图（一个渲染器、一个 PUT）',
  html.includes('id="pipe-trigger"') && html.includes('id="set-pipe-trigger"')
  && html.includes('id="pipe-segment"') && html.includes('id="set-pipe-segment"')
  && appCode.includes("trigger: ['pipe-trigger', 'set-pipe-trigger']")
  && appCode.includes("segment: ['pipe-segment', 'set-pipe-segment']")
  && appCode.includes("asr: ['pipe-asr', 'asr-model']")
  && (appCode.match(/function renderPipeline\(/g) ?? []).length === 1
  && (appCode.match(/await request\('\/pipeline', \{ method: 'PUT'/g) ?? []).length === 1);

test('A9 ⚠ 切换途中 desired 不许冒充 effective',
  appCode.includes('if (!pipeApplyInFlight) {')
  && appCode.includes('正在切换'));

test('A10 ⛔ 旧的两个重复写入点已删（gate.mode / vad.provider 不再是 policy 字段）',
  !html.includes('id="pol-gate-mode"') && !html.includes('id="pol-vad-provider"')
  && !appCode.includes("['pol-gate-mode', 'gate', 'mode', 'str']")
  && !appCode.includes("['pol-vad-provider', 'vad', 'provider', 'str']"));

test('A11 Flow 三个节点的名字随 effective 变，⛔ 不写死 RMS/VAD/ASR',
  appCode.includes("setText(nodeRms, labels.trigger ?? '触发')")
  && appCode.includes("setText(nameVad, labels.segment ?? '断句')")
  && appCode.includes("setText(nodeAsr, labels.asr ?? '转录')"));

test('A12 ⭐ trigger=stop 时当前 bucket 不再制造 activity（旧数据自然滑走）',
  appCode.includes('if (!stopped) {\n    slot.gate = slot.gate || gateOpen;'));

test('A13 ⭐ 直通就是"永远开着"，⛔ 不再拿 RMS 阈值判定当触发',
  appCode.includes("const gateOpen = stopped ? false\n    : trigger === 'passthrough' ? true"));

/**
 * ⚠ **按新意图改写**：FR 是断句层 ⇒ 它的 telemetry **永远在**；
 *   CAM++ 只在开了本人过滤时**追加**，⛔ 不再替代 FR（旧实现里 CAM 一开
 *   就把整条 FR telemetry 挤掉了）。
 */
test('A14 LIVE tooltip：FR 永远在，CAM++ 只在开过滤时追加',
  appCode.includes('FireRedVAD ${r.vadActive')
  && appCode.includes('r.camOn')
  && appCode.includes("r.camState === 'USER' ? '本人' : '非本人'")
  && !appCode.includes('（未计为语音）'));

test('A15 CAM++ 的 HTP telemetry 进得了 tooltip（compute_unit + last_infer_ms）',
  main.includes('compute_unit: act.compute_unit ?? null')
  && main.includes('last_infer_ms: Number.isFinite(Number(act.last_infer_ms))')
  && appCode.includes('infer ${Number(r.inferMs).toFixed(1)}ms'));

test('A16 LIVE 的视觉契约没变：60 柱 / 1 秒一柱 / 峰值 / 固定 slot',
  app.includes('const LIVE_WINDOW_SECONDS = 60;')
  && app.includes('const bucket = Math.floor(Date.now() / 1000);')
  && app.includes('slot.rms = Math.max(Number(slot.rms) || 0, level);')
  && app.includes("col.className = 'cam-col';")
  && app.includes("col.classList.add('cam-col-empty');"));

test('A17 转录层的身份以 App effective 为准（⛔ 不是本包 conf 的 asr.model）',
  viewsCode.includes('const effAsr = ap?.effective?.asr ?? null;')
  && viewsCode.includes("modelLabel(effAsr ?? selected?.id"));

test('A18 ⛔ 使用者可见页面不出现 automatic/manual 与 executor ownership',
  (() => {
    const body = html.replace(/<!--[\s\S]*?-->/g, '');
    const banned = ['自动转录', '手动转录', '自动与手动', '自动说话人',
      'speaker executor', 'activity executor', 'segment executor', 'legacy_speech',
      'PCM 直连', '等待鉴权 PCM WS'];
    return banned.every((word) => !body.includes(word))
      && !appCode.includes("row('执行方 gate / vad / speaker'");
  })());

test('A19 Overview 三层 selector 不再沿用按钮用的 tablist 容器',
  html.includes('class="ov-pipe-row"')
  && !html.replace(/<!--[\s\S]*?-->/g, '').includes('class="ov-mode-tablist"')
  && read('web/style.css').includes('.ov-pipe-row {')
  && read('web/style.css').includes('grid-template-columns: repeat(3, minmax(0, 1fr));'));

/* ══════════════════════════════════════════════════════════════
   A'. docs/098：两种句尾方案 + 共用硬切时长
   ══════════════════════════════════════════════════════════════ */

test('A20 两个句尾方案都在设置里，且各自的参数都在',
  html.includes('id="pol-vad-endmode"')
  && html.includes('value="hangover"') && html.includes('value="stepped"')
  && ['pol-vad-hangover', 'pol-vad-hgmax', 'pol-vad-hgmin', 'pol-vad-pressure']
    .every((id) => html.includes(`id="${id}"`)));

test('A21 ⭐ 硬切时长是一个可调项（⛔ 不再写死），且两个方案共用',
  html.includes('id="pol-seg-hardcap"')
  && appCode.includes("['pol-seg-hardcap', 'segment', 'hard_cap_ms', 'int']"));

test('A22 五个新旋钮都走**同一条** policy PUT，⛔ 不另开端点',
  ['pol-vad-endmode', 'pol-vad-hangover', 'pol-vad-hgmax', 'pol-vad-hgmin', 'pol-vad-pressure']
    .every((id) => new RegExp(`\\['${id}', 'vad',`).test(appCode))
  && !appCode.includes("'/vad/end-mode'"));

test('A23 ⭐ 说明行读的是 App 报回来的实况，⛔ 不是 policy 里那个值',
  appCode.includes('const sc = segRt.segmenter?.config ?? null;')
  && appCode.includes("sc.end_mode === 'hangover'")
  && main.includes('segmenter: act.vad_segmenter ?? null'));

/* ══════════════════════════════════════════════════════════════
   B. 同一段音频不许变成两条句子
   ══════════════════════════════════════════════════════════════ */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-dupe-'));
const groups = new RecordGroups({ root });

/** 真机 boundary journal seq 429–438 的形状：candidate 27 的同一段音频被转了两次。 */
const appSegment = (id, start, end) => ({
  segment_id: id,
  source_kind: 'app_segment',
  start_ms: start,
  end_ms: end,
  duration_ms: end - start,
});
const ok = (text) => ({ status: 'succeeded', text, backend: 'sensevoice' });

const first = groups.admit(appSegment('seg-159', 34081076, 34089876), ok('一段话'));
test('B1 第一条正常入库', first.admitted === true);

const dup = groups.admit(appSegment('seg-160', 34081076, 34089876), ok('一段话'));
test('B2 ⭐ 区间完全相同的重开被挡下（真机 seg-159 / seg-160）',
  dup.admitted === false && dup.reason === 'audio_window_already_committed'
  && dup.covered_by === 'seg-159');

const inner = groups.admit(appSegment('seg-161', 34082000, 34089000), ok('一段话'));
test('B3 被完整包含的区间同样被挡下', inner.admitted === false
  && inner.reason === 'audio_window_already_committed');

const longer = groups.admit(appSegment('seg-162', 34081076, 34095000), ok('一段话，还有后半句'));
test('B4 ⭐ 更长的一段**不许**被挡（它含有新说的话，挡掉就是删使用者的数据）',
  longer.admitted === true);

const later = groups.admit(appSegment('seg-163', 34096000, 34099000), ok('下一句'));
test('B5 时间上不重叠的下一句正常入库', later.admitted === true);

test('B6 ⛔ 判据不是"文字一样"——同一句话真说两遍必须两条都留下',
  groups.admit(appSegment('seg-164', 34100000, 34103000), ok('下一句')).admitted === true);

test('B7 被挡下的次数看得见（⛔ 静默丢弃 = 查不出来的丢弃）',
  groups.snapshot().suppressed_duplicates === 2
  && groups.snapshot().last_suppressed?.covered_by === 'seg-159');

const survivors = groups.recent(20).map((item) => item.segment_id);
test('B8 历史里 seg-160 / seg-161 一条都没有',
  !survivors.includes('seg-160') && !survivors.includes('seg-161')
  && survivors.includes('seg-159') && survivors.includes('seg-162'));

test('B9 句子计数只算真的入库的那些（159 / 162 / 163 / 164 四条）',
  groups.snapshot().active.sentence_count === 4);

/** ⚠ 单调时钟会在重启/换代时归零：旧记录不许"包含"一条几分钟后的新记录。 */
const stale = new RecordGroups({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-dupe2-')) });
let clock = Date.parse('2026-08-28T00:00:00Z');
stale.now = () => clock;
stale.admit(appSegment('seg-a', 30000, 40000), ok('重启前的一段'));
clock += 5 * 60_000;   // 五分钟后（重启，单调钟归零）
const afterBoot = stale.admit(appSegment('seg-b', 34081, 35000), ok('重启后的一句'));
test('B10 ⭐ 超出时间窗的"包含"不算重复（⛔ 否则重启后第一句会被吃掉）',
  afterBoot.admitted === true);

test('B11 blank / 失败的 item 不参与"已提交"判据',
  (() => {
    const g = new RecordGroups({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'termux-speech-dupe3-')) });
    g.admit(appSegment('seg-x', 1000, 5000), { status: 'failed', error: 'asr_failed' });
    return g.admit(appSegment('seg-y', 2000, 4000), ok('真的说了一句')).admitted === true;
  })());

fs.rmSync(root, { recursive: true, force: true });

console.log(`app-runtime-source-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

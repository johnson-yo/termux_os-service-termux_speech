/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: StateHub、WS 桥、以及 web/ 与 service/ 的源码文本
 * [OUTPUT]: docs/061 §十一A/§十一B 的回归——snapshot/增量/版本/重连/慢客户端/隐藏静默/单订阅
 * [POS]: 纯单元 + 源码契约。⭐ 这一轮删掉的是**一条每 250ms 跑一次的回路**，
 *        而「它没有回来」只能靠对源码断言来长期保证——行为测试看不见一个被重新加回来的定时器。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateHub } from '../service/state-hub.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, '..', file), 'utf8');
/**
 * 只看代码，不看注释。⚠ 注释里出现 `setInterval` 是完全正常的（我们正是在记录
 * 它为什么被删掉），把它算成证据会得到一个永远失败、或者永远通过的假测试。
 */
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  // ⚠ `//` 也出现在 URL 里。`${protocol}//${location.host}…` 那一行如果被当成注释
  // 掐掉，后面整条 WS 地址就凭空消失，而断言只会说「没找到」，不会说「我把它删了」。
  // 故只在**行首或空白之后**的 `//` 才算注释。
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

const appJs = codeOnly(read('web/app.js'));
const viewsJs = codeOnly(read('web/views.js'));
const mainSource = codeOnly(read('service/main.mjs'));
const wsSource = codeOnly(read('service/transcript-ws.mjs'));
const packageSource = codeOnly(read('package.mjs'));

/* ══════════════════════════════════════════════════════════════
   A. 状态事件
   ══════════════════════════════════════════════════════════════ */
const facts = { a: 1, b: 'x', slow: { config: true } };
const hub = new StateHub({
  builders: {
    fast: () => ({ value: facts.a }),
    text: () => ({ value: facts.b }),
    slow: () => facts.slow,
  },
  hot: ['fast'],
});

const first = JSON.parse(hub.snapshotJson());
test(
  'A1 新连接先拿到完整 snapshot，且带 ok / schema / boot_id / version',
  first.ok === true
    && first.full === true
    && first.schema === 'termux-os.speech-state.v1'
    && typeof first.boot_id === 'string' && first.boot_id.length > 10
    && Number.isInteger(first.version) && first.version > 0
    && Object.keys(first.domains).sort().join(',') === 'fast,slow,text',
);

const versionAfterFirst = hub.version;
hub.build();
test(
  'A2 状态没变就不加版本，也不重新发一份完整树',
  hub.version === versionAfterFirst
    && JSON.parse(hub.since(versionAfterFirst).json).domains
    && Object.keys(JSON.parse(hub.since(versionAfterFirst).json).domains).length === 0,
);

facts.a = 2;
hub.build(['hot']);
const delta = JSON.parse(hub.since(versionAfterFirst).json);
test(
  'A3 单个域变化只标记那一个域，其余域不进增量',
  delta.full === false
    && Object.keys(delta.domains).join(',') === 'fast'
    && delta.domains.fast.value === 2,
);

const beforeMonotonic = hub.version;
facts.b = 'y';
hub.build(['cold']);
facts.slow = { config: false };
hub.build(['cold']);
test(
  'A4 version 单调递增，永不回退',
  hub.version > beforeMonotonic && hub.version === beforeMonotonic + 2,
);

const reconnect = hub.since(hub.version, 'a-different-boot-id');
test(
  'A5 boot_id 对不上就退回完整 snapshot——旧 sequence 绝不能盖在新状态上',
  reconnect.full === true && JSON.parse(reconnect.json).full === true,
);

const ahead = hub.since(hub.version + 999);
test(
  'A6 客户端游标超前（拿着上一条命的版本号）同样退回完整 snapshot',
  ahead.full === true,
);

{
  // 慢客户端 = 它在忙，没有挂在 watch 上。等它回来时，中间那几次变化**不补发**，
  // 它拿到的是当下事实。服务端因此不需要为任何客户端保留队列。
  const slowCursor = hub.version;
  for (let index = 0; index < 5; index += 1) {
    facts.a = 100 + index;
    hub.build(['hot']);
  }
  const settled = await hub.watch(slowCursor, hub.bootId, 5000);
  const payload = JSON.parse(settled.json);
  test(
    'A7 慢客户端不造成无界队列：回来时拿到的是当下事实，不是五个中间值',
    payload.domains.fast.value === 104
      && Object.keys(payload.domains).join(',') === 'fast',
  );
}

{
  // 多个订阅者共用同一份不可变 snapshot 文本。
  const cursor = hub.version;
  const one = hub.since(cursor - 1).json;
  const two = hub.since(cursor - 1).json;
  test('A8 多个订阅者复用同一份序列化结果，不为每个 client 各构造一次', one === two);
}

{
  const idle = new StateHub({ builders: { x: () => ({ v: 1 }) } });
  const before = idle.builds;
  idle.markAll();
  idle.pump();
  test('A9 没有观测者时一行都不算——观测成本正比于变化次数，不正比于时间', idle.builds === before);
  const waiting = idle.watch(0, idle.bootId, 1200);
  test('A9b 第一个观测者到来时才构造', idle.builds > before);
  await waiting;
}

{
  const timed = new StateHub({ builders: { x: () => ({ v: 1 }) } });
  timed.build();
  const started = Date.now();
  // ⚠ 生产里那个超时定时器是 unref 的（观测不该把进程钉住），所以测试要自己撑住事件循环。
  const keepAlive = setTimeout(() => {}, 3000);
  const result = await timed.watch(timed.version, timed.bootId, 1000);
  clearTimeout(keepAlive);
  test(
    'A10 长时间没有变化时返回一个空增量，而不是无限挂着',
    Date.now() - started >= 900 && JSON.parse(result.json).full === false,
  );
}

{
  const facts = { value: 0 };
  const paced = new StateHub({
    builders: { fast: () => ({ value: facts.value }) },
    hot: ['fast'],
    minIntervalMs: 0,
  });
  paced.build();
  const started = Date.now();
  const waiting = paced.watch(paced.version, paced.bootId, 2000, 100);
  const keepAlive = setTimeout(() => {}, 3000);
  setTimeout(() => {
    facts.value = 1;
    paced.markHot();
    paced.schedule();
  }, 20);
  const result = await waiting;
  clearTimeout(keepAlive);
  const payload = JSON.parse(result.json);
  test(
    'A10b observer cadence throttles stable-state rebuilds without delaying a changed fact forever',
    Date.now() - started >= 80 && payload.domains.fast.value === 1,
  );
}

{
  const facts = { value: 0 };
  const paced = new StateHub({
    builders: { fast: () => ({ value: facts.value }) },
    hot: ['fast'],
    minIntervalMs: 0,
  });
  paced.build();
  const keepAlive = setTimeout(() => {}, 3000);
  facts.value = 1;
  paced.markHot();
  const trigger = await paced.watch(paced.version, paced.bootId, 2000, 0);
  const started = Date.now();
  const waiting = paced.watch(trigger.version - 1, paced.bootId, 2000, 100);
  const result = await waiting;
  clearTimeout(keepAlive);
  test(
    'A10c a pre-existing version still respects the observer cadence',
    Date.now() - started >= 80 && JSON.parse(result.json).domains.fast.value === 1,
  );
}

/**
 * ⚠ 断言必须**限定在那个函数体内**。写成 `/const ingestPcmFrame[\s\S]*?project\(/`
 * 会一路贪到几百行之外 `refresh()` 里那个完全正当的 `project()`，于是这条测试
 * 无论代码对不对都失败——一个作用域错了的正则，测的不是它声称在测的东西。
 */
const functionBody = (source, header) => {
  const start = source.indexOf(header);
  if (start < 0) return '';
  const end = source.indexOf('\n};', start);
  return source.slice(start, end < 0 ? undefined : end);
};
const pcmPath = functionBody(mainSource, 'const ingestPcmFrame = (frame, meta) => {');
const tickPath = functionBody(mainSource, 'async function tick() {');
test(
  'A11 PCM 帧路径与 tick 都不再构造整棵状态树，只标脏',
  pcmPath.includes('hub?.markHot();')
    && !pcmPath.includes('project(')
    && tickPath.includes('hub.markHot();')
    && !tickPath.includes('project(')
    && mainSource.includes('state.state = readyNow() ? \'ready\' : \'idle\';'),
);

/**
 * ⭐ 解耦（docs/061 §1）：观测不许挂在处理链上。
 * 音频路径只能**登记**状态脏了，真正的构造必须推到下一个 tick 去合并。
 */
test(
  'A11b 观测与处理链解耦：音频路径只 schedule，绝不同步构造',
  pcmPath.includes('hub?.schedule();')
    && !pcmPath.includes('hub?.pump();')
    && !tickPath.includes('hub.pump();')
    && read('service/state-hub.mjs').includes('setImmediate(() => {'),
);

/**
 * 同一条原则的第二半：高频域的构造函数里不许有磁盘 I/O。
 * `vad.snapshot()` 曾经每次探两个模型文件，而它是热域——那两次 `existsSync`
 * 会随着状态流一起被拉进音频路径。
 */
test(
  'A11c 高频域不碰磁盘：模型在不在是缓存的事实，不是每次投影都去问一次内核',
  read('service/vad/controller.mjs').includes('files_present: this.filesPresent(),')
    && read('service/vad/controller.mjs').includes('filesPresent(nowMs = Date.now()) {')
    && read('service/asr/controller.mjs').includes('const presenceCache = new Map();'),
);

test(
  'A12 transitions 有上限，且不在普通状态流里',
  read('service/pipeline-lease.mjs').includes('while (this.transitions.length > this.historyLimit)')
    && mainSource.includes('const { transitions, ...rest } = pipeline.snapshot();')
    && mainSource.includes("route === '/pipeline/transitions'"),
);

test(
  'A13 重复的 speech_input 投影不再进状态流——同一批对象过去每次都发两遍',
  !/^\s*value,$/m.test(mainSource)
    && mainSource.includes('input: () => inputProjection(),')
    && mainSource.includes("route === '/speech-input'"),
);

/**
 * 每秒一次的闪存写入曾经带着整棵 14KB 投影树（真机实测 27,193 字节）。
 * 状态文件回答的是「服务活着吗」，不是「此刻每一个字段是什么」。
 */
test(
  'A13b 状态文件只写健康字段，不把整棵投影树每秒刷进闪存',
  mainSource.includes('const statusPayload = () => ({')
    && mainSource.includes('writeStatus(STATUS_FILE, statusPayload());')
    && !/writeStatus\(STATUS_FILE, state\)/.test(mainSource)
    // 目录只建一次：每秒一趟 mkdirSync 是在反复确认一件已经确认过的事
    && read('service/status.mjs').includes('const ensured = new Set();'),
);

test(
  'A14 归档计数被缓存，且只在写成功之后失效',
  read('service/storage/archive.mjs').includes('if (this.counts) return { ...base, ...this.counts };')
    && read('service/storage/archive.mjs').includes("this.counts = null;\n      return { ok: true"),
);

/**
 * ⭐ PCM 的归属（docs/061 §POS，使用者当面重申）。
 *
 * 原则：PCM 原则上留在 App 私有域；只有明确用 API 要求导出时才出来，
 * 段级音频一律**按路径传递**而不是把字节搬来搬去。
 * ⚠ 本轮不改传输方式（`app/` 与 PCM stream 协议在禁止修改范围内），这条测试
 * 锁的是**不许倒退**：状态流、转写 feed、记录 API 里都只能有计数与元数据。
 */
test(
  'A15 状态流与记录只带计数和路径，PCM 字节一个都不许进来',
  // pcm_stream 域是**计数器**：帧号、字节总数、帧龄——没有任何一个字段承载采样
  !/payload|samples|pcm_base64|audio_data/.test(read('service/pcm-ws.mjs').split('snapshot(')[1] ?? '')
    && read('service/speech-input.mjs').includes('payload_exposed_by_capability: false')
    && read('service/speech-input.mjs').includes("framework_pcm_egress: 'none'")
    && read('service/speech-input.mjs').includes("browser_pcm_egress: 'none'")
    // 段级音频按**路径**交给下游，记录组拿到的也是路径
    && read('service/storage/groups.mjs').includes('wav_path: wavAvailable ? wavPath : null,')
    && !read('service/storage/archive.mjs').includes('BLOB'),
);

/* ══════════════════════════════════════════════════════════════
   B. 前端订阅
   ══════════════════════════════════════════════════════════════ */
test(
  /**
   * ⚠ 判据从「全文不许出现 `setInterval`」收紧成它**自己的名字**所说的那件事：
   *   不许有固定的高频 `/live` 轮询。
   * ⭐ 0.21.4 的「我的声音」在**正在录样本**时按 1.2s 拉一次 `/speaker/state`——
   *   段是后端按停顿切出来的，不轮询使用者要等按下停止才看见自己刚说的几段。
   *   它离开那一页就 clear、录完就停，⛔ 不是心跳。
   * ⛔ 仍然禁止的：任何 `/live` 轮询、任何快于 1 秒的定时器。
   */
  'B1 页面没有 250ms 的 /live 定时器，一个固定高频轮询都不剩',
  !appJs.includes("request('/live')")
    && !/loadLive/.test(appJs)
    // 每一个 setInterval 的周期都必须 >= 1000ms，且不许打 /live
    && [...appJs.matchAll(/setInterval\([^,]+,\s*(\d+)\)/g)]
      .every(([, ms]) => Number(ms) >= 1000)
    && !/setInterval\([^)]*live/i.test(appJs),
);

test(
  'B2 同一时刻只存在一个状态订阅，且有显式 teardown',
  appJs.includes('if (stateSocket || document.visibilityState !== \'visible\') return;')
    && appJs.includes('const closeStateSocket = ()')
    && appJs.includes('const closeTranscriptSocket = ()')
    // 摘掉 onclose 再关，否则关闭动作自己会安排一次不想要的重连
    && /closeStateSocket[\s\S]*?socket\.onclose = null;/.test(appJs),
);

test(
  'B3 页面隐藏就完全静默：关掉两条 WS，且不再重绘任何区域',
  appJs.includes('closeStateSocket();\n    closeTranscriptSocket();')
    && /const applyDomains = \(changed\) => \{\s*\n\s*if \(document\.visibilityState !== 'visible'\) return;/
      .test(appJs),
);

test(
  'B4 重新可见时重取完整 snapshot，不去补隐藏期间的每一个中间事件',
  appJs.includes('connectStateSocket();\n    connectTranscriptSocket();\n    renderVisible();')
    && appJs.includes('const renderVisible = ()'),
);

test(
  'B5 WS 重连不会叠加 listener：重连前后都只有一个 socket 对象持有回调',
  /socket\.onclose = \(\) => \{\s*if \(stateSocket !== socket \|\| stateConnectionGeneration !== generation\) return;/.test(appJs)
    && !appJs.includes("socket.addEventListener('message'"),
);

test(
  /**
   * ⚠ 举例用的那个区域从 `records` 换成 `activity`：0.21.4 把记录组卡移出概览，
   *   而「声音活动」成了本轮最要紧的按域订阅（它决定一开口有没有反应）。
   * ⭐ 判据没变：区域的依赖必须**显式声明**，且只有被触及的域才重画。
   */
  'B6 单个域变化只触发对应区域，区域的依赖是显式声明的',
  appJs.includes('const REGIONS = [')
    && appJs.includes('if (!needs.some((domain) => touched.has(domain))) continue;')
    && appJs.includes("['overview-activity', ['rms_gate', 'public', 'speaker_activity', 'pipeline', 'vad', 'asr'],"),
);

test(
  'B7 认不出的状态帧是显式错误，不是空状态',
  appJs.includes("frame?.schema !== 'termux-os.speech-state.v1'")
    && /throw new Error\(`状态帧结构不认识/.test(appJs),
);

test(
  'B8 旧诊断 JSON 不再进入产品页，页面不会隐藏一整份调试 payload',
  !viewsJs.includes('renderRaw')
    && !viewsJs.includes('renderDiagnostics')
    && !appJs.includes('raw-details'),
);

test(
  'B9 产品区域按域拆开，且不在不可见 tab 上重绘',
  appJs.includes('if (!regionVisible(name)) continue;')
    && appJs.includes("['overview-rms', ['rms_gate']")
    && !appJs.includes('V.renderDiagnostics(domains, listenState)'),
);

test(
  'B10 转写列表有固定上限',
  appJs.includes('while (transcripts.length > TRANSCRIPT_KEEP) transcripts.shift();'),
);

test(
  /**
   * ⚠ `requester !== 'webui'` 换成了 `holder !== 'webui'`：承载这条判断的按钮
   *   从 `listen-toggle` 换到了 `man-toggle`（0.21.4 收敛成一个入口）。
   * ⭐ 语义没变，所以判据只放宽到「有没有把别人的持有当回事」这一步。
   */
  'B11 Chain / Listen / Mic / Group 的语义没有回退',
  appJs.includes("request(started ? '/chain/stop' : '/chain/start'")
    && /holder[\s\S]{0,200}!== 'webui'/.test(appJs)
    && viewsJs.includes('CAPTURE_LABELS')
    && appJs.includes("$('man-toggle')")
    && !viewsJs.includes("$('rec-progress')"),
);

/* ══════════════════════════════════════════════════════════════
   传输层：WS 桥自己不许有定时器
   ══════════════════════════════════════════════════════════════ */
test(
  'B12 WS 桥不再每 200ms 问一次上游——它挂在一个「有变化才回答」的读取器上',
  !/setInterval/.test(wsSource)
    && wsSource.includes('const loop = async () => {')
    && packageSource.includes("serviceWatch(\n          `/asr/transcripts/watch?after=")
    && packageSource.includes('/state/watch'),
);

/**
 * ⭐ 推送节奏由需求决定。真机实测：页面零推送时 Chrome 已经要 4.24% 的一个核，
 * 每秒 5 次推送再叠 5.54%——主要代价不是解析或重绘，是把渲染进程叫醒本身。
 */
test(
  'B12b 页面按它正在看什么要节奏：Overview/听写中 400ms、静息 1 秒，变了才换订阅',
  // RMS gate remains a 100ms service path; the browser only needs a 2.5Hz projection.
  appJs.includes('const STATE_INTERVAL_MS = { overview: 400, live: 400, other: 1000 };')
    && appJs.includes('/state/ws?interval_ms=')
    && appJs.includes('const retuneStateSocket = () => {')
    && appJs.includes('if (wantedInterval() === socketIntervalMs) return;')
    && packageSource.includes("Number(query.get('interval_ms')) || 1000")
    && packageSource.includes('interval_ms=${intervalMs}')
    && packageSource.includes('serviceStateWatch(')
    && mainSource.includes('normalizeWatchInterval(')
    && mainSource.includes('X-Termux-State-Version')
    // 服务端仍有自己那条与载荷无关的硬上限，客户端只能要求**更慢**
    && read('service/state-hub.mjs').includes('export const MIN_PUSH_INTERVAL_MS = 200;'),
);

test(
  'B13 长挂请求用的是它自己的超时，不是那个 8 秒的通用超时',
  packageSource.includes('AbortSignal.timeout(40_000)')
    && /const serviceText = async \(path\) => \{/.test(packageSource),
);

console.log(`\nstate-test: ${count - failures}/${count} assertions passed`);
if (failures > 0) process.exit(1);

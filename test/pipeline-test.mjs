/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RecordGroups 真实实例 + termux-speech pipeline 源码契约
 * [OUTPUT]: docs/075 点名的四组回归——判断门、mic 生命周期、backend 互斥、50 句 context group
 * [POS]: ⭐ 「一个 commit = 一个句子」与「每 50 句一组」是**契约**，不是实现细节。
 *        契约必须能在毫秒级被证伪，否则它只会在真机上、在第 50 句那一刻才被发现是错的。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordGroups } from '../service/storage/groups.mjs';
import { normalizeTranscript } from '../service/storage/text.mjs';

let failures = 0;
let count = 0;
let skipped = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};
/**
 * ⚠ 「取不到就跳过」此前只写在注释里：断言写的是 `appLoop !== null && …`，
 * 于是缺少 App 源码时它**判为 FAIL**，而不是跳过。在作者的机器上路径永远解析得到，
 * 所以这个分支一次都没被走到过——一条只在别人机器上为真的失败。
 */
const testIf = (available, name, evaluate) => {
  // ⚠ 判据必须是 thunk：作为普通实参它在调用前就被求值，于是「跳过」那一支
  //    还没轮到就已经在 `null.includes(...)` 上抛了。
  if (!available) { skipped += 1; console.log(`SKIP ${name}（未提供 TERMUX_OS_APP_SRC）`); return; }
  test(name, evaluate());
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
/**
 * App 侧那个采集循环。⚠ 它不在本仓库里，取不到就明确跳过，不静默当成通过。
 *
 * ⛔ 路径不能写死在源码里：一个指向作者工作站的绝对路径，对其他人**永远**是「跳过」，
 * 而「跳过」与「通过」在汇总行里长得几乎一样。改由环境变量给出，缺席即如实跳过。
 */
const APP_LOOP = process.env.TERMUX_OS_APP_SRC
  ? path.join(process.env.TERMUX_OS_APP_SRC,
    'main/src/main/java/com/termux_os/app/inference/SpeechPipeline.kt')
  : null;
const appLoop = APP_LOOP && fs.existsSync(APP_LOOP) ? fs.readFileSync(APP_LOOP, 'utf8') : null;

const freshGroups = (groupSize = 50) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-groups-'));
  return new RecordGroups({ root: dir, archive: null, groupSize });
};

/** 走**正式路径**：normalize → 非空白才 admit。空白/live/stale 在这一步之前就被挡掉。 */
const commit = (groups, n, backend = 'sensevoice', text = `第${n}句。`) => {
  const normalized = normalizeTranscript(text);
  if (normalized.isBlank) return { admitted: false, reason: 'blank' };
  return groups.admit(
    { segment_id: `${backend}-${n}`, start_ms: null, end_ms: null, duration_ms: null },
    { status: 'succeeded', text: normalized.text, model: backend, backend, source: 'test' },
  );
};

// ────────────────────────────────── 1. 判断门 / 处理门

/**
 * ⚠ 这一条曾经钉的是字面量 `gate.openFromRequest(\`${reason}_opened_gate\`)`。
 *   开门被收敛成唯一入口 `openProductGate()` 之后它就红了——而实现是**变得更正确**了：
 *   开门原本是「三步各写一遍」，现在只有一处。⛔ 钉实现细节的测试会在重构时反对重构。
 * ⭐ 真正的不变式有两条，都与怎么写无关：
 *   ① 开门走的是**那个唯一入口**；② 之后**必须**确认 owner 已经是 VAD 才继续。
 */
test('RMS 开门后只交给 VAD，不能从其他状态直接越级',
  main.includes('openProductGate(`${reason}_opened_gate`)')
    && main.includes('pipeline.owner !== PIPELINE_OWNERS.VAD'));
test('RMS 阈值越线按选定 VAD 建立唯一处理窗口（CAM++ watchdog 或自动 FireRedVAD）',
  main.includes('ensureAutomaticCamAdmission(snapshot, monotonicNowMs());')
    && main.includes('const automaticCamWatchdog = new UserWatchdog')
    && main.includes('DEFAULT_USER_WATCHDOG_TIMEOUT_MS')
    && main.includes('automaticCamWatchdog.open({ roundId: pipeline.epoch')
    && main.includes('automaticCamWatchdog.confirm({')
    && main.includes('waiting_user: waitingUser')
    && main.includes('onConfirmedUser: noteAutomaticCamUser')
    && main.includes("reason: 'camplus_no_user_timeout'")
    && main.includes("criterion: 'confirmed_user'")
    && main.includes("if (!listenEngaged() && !automaticFireRed) {")
    && main.includes("reason: 'manual_listen_required'")
    && main.includes('automaticFireRedArmEpoch')
    && !main.includes('scheduleAutomaticVadArm')
    && !main.includes('let automaticVadArm = null'));
test('App 对账会同步本地常驻镜像，runtime readiness 不拿空镜像冒充已声明',
  read('service/residents.mjs').includes('reconcileDeclared(declared)')
    && main.includes('vad?.reconcileResident(vadDeclared)')
    && main.includes('asr?.reconcileResident(asrDeclared)'));
test('listen 模式：进入 RMS → VAD → ASR 的处理链',
  (() => {
    const start = main.indexOf('const enterListen');
    const end = main.indexOf('const exitListen', start);
    const body = start >= 0 && end > start ? main.slice(start, end) : '';
    return body.includes('await engageProcessing(')
      && body.includes("consumers.setEnabled('vad', !useCamPlus)")
      && body.includes("transitionSpeakerActivity(false, 'manual_listen')")
      && body.includes('await awaitValidPcm()')
      && main.includes('const pool = vad.snapshot()?.pcm_pool')
      && main.includes('Number(pool?.eligible_ms) > 0')
      && main.includes("reason: transportReady ? 'pcm_prebuffer_unavailable' : 'pcm_unavailable'");
  })());
test('manual listen 等待 VAD eligible prebuffer，避免首帧 fan-out race 直接 409',
  main.includes('const awaitValidPcm = async (timeoutMs = 8000)')
    && main.includes('pcm.ensure();')
    && main.includes("await new Promise((resolve) => { setTimeout(resolve, 100); });")
    && !/awaitValidPcm[\s\S]{0,700}return \{ ok: true, waited_ms: timeoutMs - \(deadline - Date\.now\(\)\) \};/.test(main));
/** 唯一 ASR backend 共用同一条 WAV→文字队列；实际引擎由 cfg.asr.model 选择。 */
/**
 * ⭐ 这条真正保护的是「**处理门只有一条**，⛔ 不许按 backend 分叉出第二扇门」——
 *   docs/075 为这件事付过代价。它与「有几个 backend」无关，故 Audio8 退役后
 *   保留前两个判据、去掉那两个只描述 Audio8 存在的判据。
 */
test('处理门只有一条，⛔ 不按 backend 分叉',
  main.includes('const engageProcessing = (trigger, reason) => engagePipeline(trigger, reason);')
    && !/engageProcessing[\s\S]{0,200}engageAudio8/.test(main));

// ────────────────────────────────── 2. Mic 生命周期

test('本包永不触碰 user.persistent',
  !main.includes("'/api/android/mic/enable'")
    && !main.includes("'/api/android/mic/disable'")
    && main.includes('termux-speech must never touch user.persistent'));
test('切换不再 stopChain，故聚合 demand 不会归零',
  !/applyBackend[\s\S]{0,2000}stopChain/.test(main));
test('唯一听写路径载入选定 VAD 与选定 ASR',
  main.includes('required: () => true')
    && fs.readFileSync(path.join(root, 'service/lifecycle/controller.mjs'), 'utf8')
      .includes("this.dictation.required?.() === false"));
/**
 * ⚠ 原本这两条一条钉「Audio8 走 App 正式端点」、一条钉「Audio8 不另开 PCM consumer」。
 *   Audio8 退役后合并成一条：**它的每一处痕迹都必须消失**，包括那两个已从 App
 *   删掉的端点。⭐ 第二条的本意（⛔ 不许为某个 backend 另开一路 PCM）由
 *   `rms-pcm-separation-test` / `pcm-fanout-test` 继续守着，与 backend 数量无关。
 */
test('⛔ Audio8 在运行时与 PCM 分流上都不留痕迹',
  !read('service/asr/controller.mjs').includes('/api/asr/audio8/')
    && !main.includes('/api/asr/audio8/')
    && !/\{ name: 'audio8'/.test(main)
    && !main.includes('MIC_REQUESTER_AUDIO8')
    && !main.includes('openAudio8Link'));
test('常驻助手切出来的段进的是同一条 ASR 队列',
  main.includes('onSegment: (segment) => {')
    && main.includes('asr.enqueue(segment, { epoch: pipeline.epoch });')
    && main.includes('if (!automaticCamSegmentAllowed())'));
test('自动 CAM++ 开门后不再由 RMS 低音量二次关门',
  main.includes('automaticCamModeActive()')
    && !main.includes('closeAutomaticCamForLowRms')
    && !main.includes('gate.shouldCloseForLowRms(snapshot)')
    && !main.includes("reason: 'rms_below_close_threshold'")
    && !read('service/rms-gate.mjs').includes('shouldCloseForLowRms'));
test('退休 Audio8 后 consumer 表不再包含它',
  !/\{ name: 'audio8'/.test(main)
    && !main.includes('MIC_REQUESTER_AUDIO8')
    && !main.includes('openAudio8Link'));
testIf(appLoop !== null, 'App 采集循环：麦克风暂时没了**不是终态**（旧版在这里 break，循环永久死亡）',
  () => !/if \(!PersistentMic\.isEnabled\(\)\) \{[\s\S]{0,200}break/.test(appLoop)
    && appLoop.includes('micWaiting = true')
    && appLoop.includes('micRecoveries++'));
testIf(appLoop !== null, '恢复后 VAD 串流与闸门都从断点之后重来（否则会报出一个不存在的 gap）',
  () => /micWaiting = false[\s\S]{0,400}gate\.resetAfterDiscontinuity\(\)/.test(appLoop));
testIf(appLoop !== null, '活性心跳由**收到多少音频**驱动：没有心跳与没有 PCM 是同一件事',
  () => appLoop.includes('frames % HEARTBEAT_FRAMES == 0L'));

// ────────────────────────────────── 3. backend 互斥与代次

test('结果准入的唯一判据是 (backend, generation)，⛔ 不是写死的某一条 backend',
  main.includes('const backendOwns = (backend, generation)')
    && main.includes("backendOwns(outcome?.backend ?? 'sensevoice', resultGeneration)")
    // ⚠ 剥掉注释再扫：解释这次修改的注释里必然写着那句被禁的旧代码
    && !main.replace(/\/\*[\s\S]*?\*\//g, '').includes("activeBackend !== 'sensevoice'"));
test('切换时 generation 先加，再重新开门——旧结果结构上不可能进新库',
  /backendGeneration \+= 1;\s*\n\s*activeBackend = target;/.test(main));

// ────────────────────────────────── 4. 一个 commit = 一个句子

{
  const groups = freshGroups();
  const r1 = commit(groups, 1);
  test('C1 一次 commit 正好 +1 句', r1.admitted === true
    && groups.snapshot().active.sentence_count === 1);

  const before = groups.snapshot().active.sentence_count;
  const blank = commit(groups, 2, 'sensevoice', '   ');
  test('C2 空白不是句子：连 admit 都走不到', blank.admitted === false
    && groups.snapshot().active.sentence_count === before);

  // live hypothesis / stale 结果根本不会到 admit——它们在 DictationLink 里就被拦下。
  
  // 失败的 item 要留档，但它不是一句话。
  groups.admit({ segment_id: 'failed-1' }, { status: 'failed', error: 'boom', backend: 'sensevoice' });
  const snap = groups.snapshot();
  test('C4 失败的 item 记录在案，但不占那 50 句里的一格',
    snap.active.item_count === 2 && snap.active.sentence_count === 1);
}

// ────────────────────────────────── 5. 50 句一组

{
  const groups = freshGroups();
  for (let n = 1; n <= 49; n += 1) commit(groups, n);
  const at49 = groups.snapshot().active;
  test('G1 第 49 句时组仍是 active', at49.sentence_count === 49 && at49.group_seq === 1);

  commit(groups, 50);
  const g1 = groups.group('group-000001');
  test('G2 第 50 句落地即封组', g1.state === 'completed' && g1.sentence_count === 50);

  commit(groups, 51);
  const at51 = groups.snapshot().active;
  test('G3 第 51 句进入下一组的第 1 句',
    at51.group_seq === 2 && at51.sentence_count === 1);

  // ⚠ 失败的 item 掺进来不许把组撑爆：50 数的是句子。
  const groups2 = freshGroups();
  for (let n = 1; n <= 49; n += 1) commit(groups2, n);
  for (let n = 0; n < 5; n += 1) {
    groups2.admit({ segment_id: `f-${n}` }, { status: 'failed', error: 'x', backend: 'sensevoice' });
  }
  test('G4 掺 5 条失败 item 后仍在第一组，因为句子只有 49',
    groups2.snapshot().active.group_seq === 1
      && groups2.snapshot().active.sentence_count === 49
      && groups2.snapshot().active.item_count === 54);
  commit(groups2, 50);
  test('G5 第 50 句仍然准确封组（失败 item 没有偷走名额）',
    groups2.group('group-000001').state === 'completed');
}

// ────────────────────────────────── 6. 连续结果的同一 group

{
  const groups = freshGroups();
  commit(groups, 1, 'sensevoice', 'A 句。');
  commit(groups, 2, 'sensevoice', 'B 句。');
  commit(groups, 3, 'sensevoice', 'C 句。');
  const active = groups.snapshot().active;
  const items = groups.readItems(active.group_id);
  test('M1 连续 SenseVoice 三句落在**同一个** group',
    active.group_seq === 1 && active.sentence_count === 3
      && items.every((item) => item.group_id === 'group-000001'));
  test('M2 顺序与内容不乱',
    items.map((item) => item.text).join('') === 'A 句。B 句。C 句。');
  test('M3 每句都记着自己出自哪条门',
    items.map((item) => item.backend).join(',') === 'sensevoice,sensevoice,sensevoice');
  test('M4 feed 游标连续递增（消费者按游标读，跳号等于丢句）',
    items.map((item) => item.feed_seq).every((seq, i, all) => i === 0 || seq > all[i - 1]));
}

// ────────────────────────────────── 7. 产品页的转写文字（CP-SPEECH2-WEBUI18）
/**
 * ⭐ **按新意图改写**：旧 U1–U7 钉的是旧页面的 `asr_live` 域、`renderAsrLive` 双写入点、
 *   `copy-latest` 按钮与 SenseVoice(T167) 段式链——它们随旧 speech 产品面一起退役。
 *   不变的判据：**只有一个写入点**、实时与定稿分两行、历史只读 Speech2 final。
 */
{
  const appJs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  test('U1 概览有「正在识别」一行 + LIVE 行 + 历史列表',
    ['tx-current', 'live-rows', 'tx-history-list'].every((id) => html.includes(`id="${id}"`)));
  test('U2 「正在识别」只有 renderLive 一个写入点',
    (appJs.match(/\$\('tx-current'\)/g) ?? []).length === 1
      && /function renderLive\(s\)[\s\S]*?\$\('tx-current'\)/.test(appJs));
  test('U3 实时文字来自服务端的 speech2 热域（同一次推送）',
    appJs.includes("if ('speech2' in frame.domains) renderLive(frame.domains.speech2);")
      && /HOT_DOMAINS = \[[^\]]*'speech2'/.test(main));
  test('U4 provisional 与 final 分两种样式，同一句只占一行',
    appJs.includes("it.complete ? 's2-final' : 's2-provisional'")
      && appJs.includes('row.dataset.key = it.key'));
  test('U5 历史只读 /speech2/history（Speech2 final）',
    appJs.includes("request('/speech2/history?limit=10')")
      && main.includes("it.source_kind === 'speech2'"));
  test('U8 一句话定稿即标脏热域，不等下一次 PCM tick',
    main.includes('hub?.markHot()') && main.includes('hub?.schedule()'));
}

console.log(`\n${count - failures}/${count} passed` + (skipped ? `, ${skipped} skipped（缺 App 源码，未冒充通过）` : ''));
process.exit(failures ? 1 : 0);

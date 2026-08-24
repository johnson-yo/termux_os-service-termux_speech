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
test('RMS 阈值越线只建立 CAM++ 的 8 秒 USER 准入窗口，FireRedVAD 只能手动 arm',
  main.includes('ensureAutomaticCamAdmission(snapshot, monotonicNowMs());')
    && main.includes('const automaticCamWatchdog = new UserWatchdog')
    && main.includes('DEFAULT_USER_WATCHDOG_TIMEOUT_MS')
    && main.includes('automaticCamWatchdog.open({ roundId: pipeline.epoch')
    && main.includes('automaticCamWatchdog.confirm({')
    && main.includes('waiting_user: waitingUser')
    && main.includes('onConfirmedUser: noteAutomaticCamUser')
    && main.includes("reason: 'camplus_no_user_timeout'")
    && main.includes("criterion: 'confirmed_user'")
    && main.includes("if (!listenEngaged()) {")
    && main.includes("reason: 'manual_listen_required'")
    && !main.includes('scheduleAutomaticVadArm')
    && !main.includes('let automaticVadArm = null'));
test('App 对账会同步本地常驻镜像，SenseVoice readiness 不拿空镜像冒充已声明',
  read('service/residents.mjs').includes('reconcileDeclared(declared)')
    && main.includes('vad?.reconcileResident(vadDeclared)')
    && main.includes('asr?.reconcileResident(asrDeclared)')
    && !read('web/views.js').includes("selected?.id === 'audio8'")
    && read('web/views.js').includes("['SenseVoice 资产'"));
test('listen 模式：进入 RMS → VAD → ASR 的处理链',
  (() => {
    const start = main.indexOf('const enterListen');
    const end = main.indexOf('const exitListen', start);
    const body = start >= 0 && end > start ? main.slice(start, end) : '';
    return body.includes('await engageProcessing(')
      && body.includes("consumers.setEnabled('vad', true)")
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
/** 唯一 ASR backend 共用同一条 WAV→文字队列。 */
test('处理门只有一条，且只由 SenseVoice 识别',
  main.includes('const engageProcessing = (trigger, reason) => engagePipeline(trigger, reason);')
    && !/engageProcessing[\s\S]{0,200}engageAudio8/.test(main)
    && !read('service/asr/controller.mjs').includes('audio8'));

// ────────────────────────────────── 2. Mic 生命周期

test('本包永不触碰 user.persistent',
  !main.includes("'/api/android/mic/enable'")
    && !main.includes("'/api/android/mic/disable'")
    && main.includes('termux-speech must never touch user.persistent'));
test('切换不再 stopChain，故聚合 demand 不会归零',
  !/applyBackend[\s\S]{0,2000}stopChain/.test(main));
test('唯一听写路径载入 FireRedVAD 与 SenseVoice',
  main.includes('required: () => true')
    && fs.readFileSync(path.join(root, 'service/lifecycle/controller.mjs'), 'utf8')
      .includes("this.dictation.required?.() === false"));
test('Audio8 runtime branch 已退休',
  !read('service/asr/controller.mjs').includes('audio8')
    && !read('service/asr/controller.mjs').includes('/api/asr/audio8/'));
test('Audio8 不再触发 App session/load 请求',
  !main.includes('ensureAudio8ForApp') && !main.includes('/api/asr/audio8/'));
test('常驻助手切出来的段两条 backend 都收得到',
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

// ────────────────────────────────── 7. 两个页面的 ASR 文字

{
  const views = fs.readFileSync(path.join(root, 'web/views.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const viewsJs = fs.readFileSync(path.join(root, 'web/views.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');

  test('U1 概览只有一组「正在识别」与「最近识别」事实行',
    ['ov-current', 'ov-latest', 'tx-live-meta', 'tx-latest-meta']
      .every((id) => html.includes(`id="${id}"`))
      && !html.includes('id="asr-live-text"') && !html.includes('id="asr-last-text"'));
  /**
   * ⭐ 不是「把两处改成一样」，是**只留一个写入点**。两处各写各的，迟早会在某个
   *   分支上再次分岔——docs/075 之前就是这么分岔的（概览读记录组、诊断读
   *   SenseVoice 控制器自己的最后一条）。
   */
  test('U2 四个位置只有 renderAsrLive 一个写入点',
    /**
     * ⛔ 一次直接 `$('...')` 赋值都不许有：唯一的写入发生在下面那两个 id 对的循环里。
     * ⚠ 0.21.4 概览那两个 id 改成 `ov-current` / `ov-latest`（旧的 `tx-*` 卡整块退役），
     *   ⭐ 判据仍然是「只有那两个循环在写」，而且 app.js 也不许再写它们——
     *   本轮就差点在 app.js 里另开一个写入点，把刚合并好的东西重新拆开。
     */
    (views.match(/\$\('(tx-latest|asr-last|tx-live|asr-live)-/g) ?? []).length === 0
      && views.includes("['ov-latest', 'tx-latest-meta']")
      && views.includes("['ov-current', 'tx-live-meta']")
      && (appJs.match(/setText\(\$\('(ov-current|ov-latest)'\)/g) ?? []).length === 0);
  test('U3 实时文字来自服务端的同一个 asr_live 域，两页共用一次渲染',
    appJs.includes("['overview-asr-live', ['asr_live']")
      && !appJs.includes("['diag-asr-live'")
      && main.includes('asr_live: () =>')
      /**
       * ⚠ 判据是「`asr_live` 在热域**里**」，⛔ 不是「它是数组的最后一个」。
       *   原来写成 `'asr_live'];` 精确匹配了行尾，于是 0.21.3 往热域里加一个
       *   `public` 就把它判红了——而 asr_live 一直好好地在那儿。
       */
      && /HOT_DOMAINS = \[[^\]]*'asr_live'/.test(main));
  /**
   * ⚠ 0.21.5：**两条 backend 都是段式的**——Audio8 那条 live hypothesis 链已删除。
   *   所以 `live_supported` 恒为 false，而那是实话，⛔ 不是退化。
   */
  test('U4 按 shutter contract 区分 incomplete 当前句与 complete 最新句',
    main.includes('live_supported: false')
      && main.includes('current_status: current.status ?? null')
      && views.includes("current?.status === 'incomplete'")
      && !views.includes('SenseVoice 逐段识别，没有中间结果'));
  test('U5 已定稿那一句两条门共用 RecordGroups 的同一条记录',
    main.includes('committed: records?.lastSentence ?? null')
      && fs.readFileSync(path.join(root, 'service/storage/groups.mjs'), 'utf8')
        .includes('this.lastSentence = this.sentenceView(item)'));
  /**
   * ⚠ 0.21.4 概览只剩一个复制按钮（`copy-latest`），旧的 `tx-copy-latest` 已删。
   * ⭐ 判据加了一条：⛔ **不许从 DOM 抠文本**——`ov-latest` 里可能是占位文案，
   *   而按钮把「尚未产生转写」六个字复制走，和什么都不做一样是在骗人。
   */
  test('U6 复制按钮复制的是**页面上显示的那一句**',
    appJs.includes('void reportCopy(V.latestText())')
      && !/copy-latest'\)\?\.addEventListener[\s\S]{0,200}textContent/.test(appJs)
      && viewsJs.includes("for (const id of ['tx-copy-latest', 'copy-latest'])"));
  test('U7 处理门开着时状态流加快，关着回到 1 秒',
    appJs.includes('live: 400') && appJs.includes('liveDoorOpen()'));
  /**
   * ⚠ 0.21.5：没有 hypothesis 了（那是 live 链的东西）。
   * ⭐ 同一条契约仍在，只是触发点变成「一句话定稿」：转写落地立刻标脏，
   *   ⛔ 不等下一次 PCM tick。
   */
  test('U8 一句话定稿即标脏热域，不等下一次 PCM tick',
    main.includes('hub?.markHot()') && main.includes('hub?.schedule()'));
}

console.log(`\n${count - failures}/${count} passed` + (skipped ? `, ${skipped} skipped（缺 App 源码，未冒充通过）` : ''));
process.exit(failures ? 1 : 0);

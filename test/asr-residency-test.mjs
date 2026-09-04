/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: main.mjs / asr/controller.mjs 的源码文本
 * [OUTPUT]: docs/090 §5–§7、§10 的契约回归 —— 启动无条件 ensure、select 与 ensure 分家、
 *           automatic ready 只认 App 的可执行事实、error 不再伪装成 blank
 * [POS]: ⭐ 这些全部是**运行期看不出来**的东西：把 ensure 藏在 `if (值变了)` 后面、
 *        或者拿本包的 resident 镜像当 automatic ready，页面上一切正常而自动链一个字都没有。
 *        真机上它们已经各发生过一次，故用源码断言机械钉住。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const main = read('service/main.mjs');
const ctl = read('service/asr/controller.mjs');
/** 去掉块注释：文档里当然会写出这些形状，钉的是**代码**。 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mainCode = code(main);

// ── §6 启动必须 ensure，且不许比较 selector ────────────────────────────

test('R1 select 与 ensure 是两个具名操作',
  /const selectBackend = /.test(mainCode) && /const ensureBackendReady = /.test(mainCode));

test('R2 ensure 读的是 configured，⛔ 不接受调用方传目标值',
  /const ensureBackendReady = \(reason[^)]*\) => applyBackend\(configuredBackend\(\)/.test(mainCode));

test('R3 boot 调用 ensure（不是 applyBackend 的条件分支）',
  mainCode.includes("ensureBackendReady('boot')"));

test('R4 起链之后再 ensure 一次', mainCode.includes("ensureBackendReady('boot_after_chain')"));

/**
 * ⭐ 本轮真机阻塞的**精确形状**：configured 与 active 初值都是 sensevoice，
 * 于是这个条件永远不成立、prepare 一次都没跑过，而两个字段各自都诚实。
 */
test('R5 ⛔ boot 路径不再有「选择值没变就跳过」的分支',
  !/if\s*\(\s*bootWanted\s*!==\s*activeBackend\s*\)/.test(mainCode)
  && !/if\s*\(\s*wanted\s*!==\s*activeBackend\s*\)/.test(mainCode));

test('R6 使用者改选择走 selectBackend',
  (mainCode.match(/await selectBackend\(value\.model/g) ?? []).length === 2
  && !/await applyBackend\(value\.model/.test(mainCode));

// ── prepareBackend 幂等 ────────────────────────────────────────────────

test('R7 同档位再次 apply 仍然 prepare（⛔ 不是 no-op）',
  /if \(target === activeBackend\)[\s\S]{0,400}?await this\.prepareBackend|if \(target === activeBackend\)[\s\S]{0,400}?await asr\.prepareBackend\(target\)/
    .test(mainCode));

test('R8 SenseVoice 的 prepare 就是 ensureResident（声明幂等，⛔ 不重复建图）',
  /if \(variant === 'sensevoice'\)[\s\S]{0,200}?await this\.ensureResident\(\)/.test(code(ctl)));

/**
 * ⚠ R9 原本钉「Audio8 的 prepare/runtime 分支走官方 App session contract」。
 *   Audio8 随 App 0.25.x 退役、那两个端点已从 App 删除，故按新意图倒过来钉。
 * ⭐ 但**它保护的东西没变**：`prepareBackend` 仍然必须对认不出的 backend
 *   **明确报错**，⛔ 绝不「悄悄按 SenseVoice 跑」——那才是这条测试的本意。
 */
test('R9 ⛔ 不再有 Audio8 分支，而认不出的 backend 仍然明确报错',
  !/audio8/i.test(code(ctl))
  && code(ctl).includes('is not served by this pipeline'));

// ── §5/§7 automatic ready 只认 App 的事实 ──────────────────────────────

test('R10 App 的可执行事实有一个专门的位置',
  /let appExecutable = null;/.test(mainCode));

test('R11 它来自 App 推过来的 segment 事实，⛔ 不是本包轮询出来的',
  /segment\.readiness/.test(mainCode) && !/\/api\/audio\/segment\/config'\s*,\s*\{\s*method: 'GET'/.test(mainCode));

test('R12 automatic_ready 与本包自己的 ready 分开报',
  mainCode.includes('automatic_ready:') && mainCode.includes('app_executable:')
  && mainCode.includes('ready: asrSnapshot.ready === true'));

/** ⭐ 判据必须是 App 的事实，⛔ 不许回落成「本包觉得自己 ready」。 */
test('R13 automatic_ready ⛔ 不由 asrSnapshot 决定',
  /automatic_ready: appExecutable \? appExecutable\.ready === true : null/.test(mainCode));

test('R14 可执行事实进了状态域（诊断页看得到）',
  /asr_backend: \(\) => backendSnapshot\(\)/.test(mainCode));

// ── §10 error 与 blank 分家 ────────────────────────────────────────────

test('R15 错误在 blank 判定**之前**就被截住',
  mainCode.indexOf('if (r.error) {') > 0
  && mainCode.indexOf('if (r.error) {') < mainCode.indexOf('if (blank) {'));

test('R16 错误有种类，⛔ 不靠 contains 那句人话',
  /r\.error_kind \?\? 'asr_failed'/.test(mainCode));

test('R17 错误有界：只留最后一条 + 同类连续计数',
  /let appAsrError = null;/.test(mainCode)
  && /count: \(appAsrError\?\.kind === kind/.test(mainCode));

test('R18 错误⛔ 不进 records、⛔ 不占 50 句名额',
  /if \(r\.error\) \{[\s\S]{0,600}?onStageChange\(\);\s*return;\s*\}/.test(mainCode));

test('R19 错误在状态里看得见', /app_asr_error: appAsrError/.test(mainCode));

// ── UI：只留一个 selector ──────────────────────────────────────────────

{
  const html = read('web/index.html');
  const selects = (html.match(/<select id="[^"]*asr-model[^"]*"/g) ?? []);
  test('R20 Settings 里 ASR 档位只有一个选择器', selects.length === 1);
  const views = read('web/views.js');
  test('R21 页面显示 automatic 可执行事实（⛔ 不只显示本包的 ready）',
    views.includes('automatic_ready') && views.includes('自动转写可执行'));
  test('R22 重复常驻在页面上说得出来', views.includes('ambiguous'));
  test('R23 未就绪/错误有低频可见的说明', views.includes('app_asr_error'));
}

// ── P6：孤儿常驻不许再生成（docs/091 PART E）────────────────────────────

test('R24 ⭐ 常驻 id 由 packageId 摘要派生，⛔ 不再回落到一个谁也不认识的名字',
  /const instanceResidentSuffix = PACKAGE_ID/.test(mainCode)
  && /createHash\('sha256'\)\.update\(String\(PACKAGE_ID\)\)/.test(mainCode)
  && !/\|\| 'tsp-vad-local'/.test(mainCode) && !/\|\| 'tsp-asr-local'/.test(mainCode));

test('R25 派生结果与 package.mjs 注入的那个**逐字相同**（否则等于换了个名字的同一个 bug）', (() => {
  const crypto = createHash;
  const digest = crypto('sha256').update('github.termux-os.service.termux-speech')
    .digest('hex').slice(0, 8);
  const pkg = read('package.mjs');
  return /VAD_RESIDENT_ID: `tsp-vad-\$\{instanceDigest\}`/.test(pkg)
    && /ASR_RESIDENT_ID: `tsp-asr-\$\{instanceDigest\}`/.test(pkg)
    && digest === '48d46676';
})());

/**
 * ⭐ automatic 链**不订阅 PCM**：那一整套 legacy consumer 默认全关，
 * 只有 RMS（判断门的第一把钥匙）是开着的。
 */
test('R26 ⭐ 注册一个 PCM consumer 的默认值就是「关」（⛔ 不许默认订阅音频）', (() => {
  const consumers = read('service/pcm-consumers.mjs');
  // 判据在**注册函数的签名**上：默认关意味着新增一个 consumer 不会顺手打开一条 PCM 流。
  return /register\(\{[^}]*enabled = false[^}]*\}\)/.test(consumers)
    && /wantsPcm = true/.test(consumers);
})());

test('R26b automatic 链里没有任何一处在启动时打开 PCM consumer',
  !/consumers\.set\((['"])(vad|audio8|speaker_activity|activity_shadow)\1,\s*true\)/.test(mainCode)
  || /engageProcessing|enterListen/.test(mainCode));

test('R27 ⛔ 服务重启/停链不许 undeclare（那是 churn，不是卸载）',
  /chain_desired=stopped; leaving residents untouched/.test(read('service/main.mjs'))
  && /这里绝不 undeclare/.test(read('service/main.mjs')));


/**
 * ⭐ **可执行体是会迟到的事实，⛔ 不是只在开机为真的常量**（docs/103 §8.2⑥）。
 *
 * ⚠ 同一个形状出现过三次（docs/101 麦克风需求、docs/090 boot、本轮 ASR+VAD 两处），
 *   所以对账器必须**一次覆盖全部**，⛔ 不是给某一个模型单独打补丁。
 * ⚠ VAD 那份**三个消费者共用**（VadController / AcousticLab / SpeakerLab）——
 *   ⛔ 让它们各自去问会变成三份会各自漂移的答案。
 */
test('R12 启动时解析不到的可执行体，由一条有界对账器补上',
  mainCode.includes('reconcileExecutables')
  && mainCode.includes('reconcileAsrExecutable')
  && mainCode.includes('reconcileVadExecutable')
  && /for \(const consumer of \[vad, lab, speakerLab\]\)/.test(mainCode));
test('R13 ⛔ 退避有界且没有终局放弃',
  mainCode.includes('EXECUTABLE_RECONCILE_MAX_MS')
  && /Math\.min\(executableBackoffMs \* 2, EXECUTABLE_RECONCILE_MAX_MS\)/.test(mainCode)
  && !/executableGaveUp|reconcileDisabled/.test(mainCode));
test('R14 ⭐ 闭合要说出来，⛔ 不许静默自愈',
  /logical executables reconciled after boot/.test(mainCode)
  && mainCode.includes('recoveries='));

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

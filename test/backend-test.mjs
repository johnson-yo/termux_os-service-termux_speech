/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: config 的 ASR selector 与迁移函数
 * [OUTPUT]: docs/074 §27 点名的 selector / 迁移 / 互斥契约回归
 * [POS]: ⭐ 这套钉的是「退休不是藏起来」：旧值必须一次迁移并写回合法配置，不能继续运行旧后端。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsx from 'node:fs';
import osx from 'node:os';
import { ASR_DEPRECATED_MODELS, ASR_MODELS, loadConfig, resolveAsrModel } from '../service/config.mjs';

/** 用真实文件走一遍 loadConfig，而不是猜它的内部函数——测的是使用者真会走到的那条路。 */
const loadWith = (asr) => {
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'tsp-backend-'));
  const file = path.join(dir, 'config.json');
  fsx.writeFileSync(file, JSON.stringify({ asr }));
  return loadConfig(file);
};

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------------------------------------------------------- selector

test('selector 恰好只剩 sensevoice',
  ASR_MODELS.length === 1 && ASR_MODELS[0] === 'sensevoice');
test('sensevoice 被接受', resolveAsrModel('sensevoice').model === 'sensevoice');
test('audio8 只作为一次性迁移输入',
  resolveAsrModel('audio8').model === 'sensevoice'
  && resolveAsrModel('audio8').migratedFrom === 'audio8');
test('产品唯一值仍是 sensevoice',
  loadWith({}).asr.model === 'sensevoice');

// ---------------------------------------------------------------- 迁移

test('qwen3-q4 迁移到默认值并记下它是从哪来的',
  resolveAsrModel('qwen3-q4').model === 'sensevoice'
  && resolveAsrModel('qwen3-q4').migratedFrom === 'qwen3-q4');
test('qwen3-q8 同样迁移',
  resolveAsrModel('qwen3-q8').model === 'sensevoice');
test('两个旧值都在 deprecated 名单里（而不是被当成未知值）',
  ASR_DEPRECATED_MODELS.includes('audio8')
    && ASR_DEPRECATED_MODELS.includes('qwen3-q4') && ASR_DEPRECATED_MODELS.includes('qwen3-q8'));
test('未知值也落到默认值，不抛不崩',
  resolveAsrModel('totally-unknown').model === 'sensevoice');
test('从盘上读到旧配置时得到有效新值（不 crash、不 silent）',
  loadWith({ model: 'qwen3-q8' }).asr.model === 'sensevoice');
test('迁移只警告一次——每次读配置都刷屏等于没有警告',
  (() => {
    const seen = [];
    const original = console.warn;
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      // 前面的用例已经触发过一次警告；这里再连读三次不应再有新的
      resolveAsrModel('qwen3-q4');
      resolveAsrModel('qwen3-q8');
      resolveAsrModel('qwen3-q4');
    } finally { console.warn = original; }
    return seen.length === 0;
  })());

// ---------------------------------------------------------------- 下线的四个层面

const configSource = read('service/config.mjs');
const controller = read('service/asr/controller.mjs');
const indexHtml = read('web/index.html');
const appJs = read('web/app.js');
const main = read('service/main.mjs');

test('UI 不再提供 qwen3 选项', !/value="qwen3-/.test(indexHtml) && !/qwen3-q[48]/.test(appJs));
test('UI 不提供 Audio8 选项', !indexHtml.includes('value="audio8"') && !appJs.includes('Audio8'));
test('runtime 不再有 Qwen3 分支', !/transcribeQwen|qwenPaths|QWEN_ASSETS/.test(controller));
test('走到非本 pipeline 的引擎时明确报错，而不是按 SenseVoice 悄悄跑',
  controller.includes('is not served by this pipeline'));

// ---------------------------------------------------------------- 互斥与代次

const applyStart = main.indexOf('const applyBackend');
const applyEnd = main.indexOf('const backendSnapshot', applyStart);
const applySection = main.slice(applyStart, applyEnd);
const closeDoorAt = applySection.indexOf('close_old_door');
const prepareAt = applySection.indexOf('prepare_target');
const generationAt = applySection.indexOf('backendGeneration += 1');
const reengageAt = applySection.indexOf('engageProcessing', generationAt);
test('切换：先关旧门 → 目标 backend 就绪 → generation++ → 再用新实现开同一扇门',
  closeDoorAt >= 0 && closeDoorAt < prepareAt
    && prepareAt < generationAt && reengageAt > generationAt);
test('Audio8 backend 已从 runtime 退休',
  !controller.includes('ensureAudio8Session')
    && !controller.includes("'/api/asr/audio8/session'")
    && !controller.includes("'/api/asr/audio8/transcribe'")
    && !main.includes('ensureAudio8ForApp'));
// ⭐ 判断门与麦克风在切换时**一概不动**。旧版在这里 stopChain，于是 demand 归零、
//    麦克风真的停掉，而后台重启 microphone FGS 会被 Android 拒绝（docs/074 实测 969 次重试）。
test('切换不碰判断门，也不制造 demand=0 的一瞬',
  // ⚠ 锚在**声明**上，理由同 self-test：转发调用不是切换实现。
  !/const applyBackend = async[\s\S]{0,2000}stopChain/.test(main));
test('本包只用具名 requester，绝不调 mic/enable|disable（那两条动的是 user.persistent）',
  !main.includes("'/api/android/mic/enable'")
    && !main.includes("'/api/android/mic/disable'")
    && main.includes("'/api/android/mic/demand'"));
test('setMicDemand 硬拒 user.persistent——防的是「以后有人顺手传了它」',
  main.includes('termux-speech must never touch user.persistent'));
test('麦克风要等到**真的在录**才算就绪（demand 返回 200 只说明需求登记了）',
  main.includes('const awaitMicRecording') && main.includes("'microphone_not_recording'"));
/**
 * ⭐ **按新意图改写**（docs/090 §6），⛔ 不是换个名字绕过去。
 *
 * 旧断言只要求「configured !== active 时收敛」。真机证明那不够：configured 与 active
 * 初值都是 `sensevoice`，条件永远不成立，于是 `prepareBackend()` **一次都没跑过**，
 * 而两个字段各自都诚实、页面上一切正常。
 * **「选择改变」与「确保就绪」是两件事**，启动必须调后者，且不许比较选择值。
 */
test('启动无条件 ensure 当前选中的 backend（⛔ 不许用「值没变」跳过）',
  main.includes("ensureBackendReady('boot')")
    && main.includes('const ensureBackendReady = ')
    && !/if\s*\(\s*bootWanted\s*!==\s*activeBackend\s*\)/.test(main));
test('自动 App 段落的 backend 跟随 cfg.asr.model，policy 只是低频投影',
  main.includes('const syncAppSegmentBackend = async')
    && main.includes("'/api/speech/policy'")
    && main.includes("'/api/audio/segment/config'")
    && main.includes('body: { backend: target }')
    && main.includes('syncAppSegmentBackend(target, reason)'));
test('启动先同步/收敛 backend，再启动 chain，消灭首次进入的旧初值窗口', (() => {
  const syncAt = main.indexOf("syncAppSegmentBackend(bootWanted, 'boot')");
  const chainAt = main.indexOf("startChain('boot')", syncAt);
  return syncAt >= 0 && chainAt > syncAt;
})());
test('App 段落 backend 固定由唯一 SenseVoice 配置事实同步',
  main.includes("const configuredBackend = () => 'sensevoice';")
    && main.includes("if (target !== 'sensevoice')"));
test('SenseVoice 迟到结果在切走后不许进库',
  main.includes('backendOwns(outcome?.backend ?? \'sensevoice\', resultGeneration)')
    && main.includes('staleBackendDropped += 1'));
/**
 * ⚠ 0.21.5：`service/asr/dictation.mjs`（App live WS）删除，`backend_generation`
 *   这个自报字段随它消失。⭐ 但**互斥判据本身没变**：迟到的结果按代次认，不按时钟。
 *   现在两条 backend 共用同一条队列，代次判定落在 `backendOwns` 与 ASR 的 epoch 上。
 */
test('迟到的结果按「出自谁」判定，⛔ 不按时钟、⛔ 也不写死某一条 backend',
  main.includes("backendOwns(outcome?.backend ?? 'sensevoice', resultGeneration)")
    && !main.replace(/\/\*[\s\S]*?\*\//g, '').includes("activeBackend !== 'sensevoice'")
    /**
     * ⚠ 0.21.8 再进一步：不是「发布时的配置」，而是**开跑时**记下的 `ran_backend`。
     *   切 backend 会改 config，而转写要几百毫秒到几秒——用发布时的配置回答
     *   「谁产出的」，一条 SenseVoice 的结果会自称新 backend 并通过代次判定。
     */
    && read('service/asr/controller.mjs').includes("backend: job.ran_backend ?? this.config.model ?? 'sensevoice'")
    && /job\.ran_backend = this\.config\.model[\s\S]{0,200}this\.inFlight = /.test(read('service/asr/controller.mjs')));
/**
 * ⭐ **切 backend 时正在跑的那一趟，结果必须仍然算在旧 backend 头上。**
 *   这是「可选 backend」最容易漏的边界：转写要几百毫秒到几秒，而切换是瞬时的。
 * ⚠ 判据看的是**顺序**——`ran_backend` 在 `transcribe()` 之前赋值，
 *   而且在 `inFlight` 快照之前，否则「此刻门后是谁在跑」不可观测。
 */
{
  const ctl = read('service/asr/controller.mjs');
  const pump = ctl.slice(ctl.indexOf('async pump()'));
  const setAt = pump.indexOf('job.ran_backend =');
  const flightAt = pump.indexOf('this.inFlight =');
  const runAt = pump.indexOf('await this.transcribe(');
  test('B-sw1 ran_backend 在开跑前、且在 inFlight 快照前记下',
    setAt > 0 && flightAt > setAt && runAt > flightAt);
  test('B-sw2 门后这一趟是谁在跑，状态里看得见',
    ctl.includes('in_flight_backend: this.inFlight?.ran_backend ?? null'));
  test('B-sw3 ⛔ publish 不再问「现在配置是什么」',
    !/backend: this\.config\.model \?\? 'sensevoice'/.test(ctl.replace(/\/\*[\s\S]*?\*\//g, '')));
}

test('状态把 configured 与 active 分开报（合成一个就看不出切换失败）',
  main.includes('configured_backend') && main.includes('active_backend')
  && main.includes('backend_generation'));

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

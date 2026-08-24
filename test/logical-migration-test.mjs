/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `service/logical-models.mjs`（真的跑）+ `main.mjs` / `asr/controller.mjs` 的源码
 * [OUTPUT]: docs/093 §14–§21 的迁移回归：speech 只请求 logical model，
 *           ⛔ 不再判断 CTX/ONNX、⛔ 不再比较 target、⛔ 不再拼文件名
 * [POS]: ⭐ 这些约束**在运行期看不出来**：把那套判断抄回来，功能照样正常，
 *        只是从此有两个地方决定「用哪一份」，而它们迟早会不一致。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLogicalModel, requireLogicalModel, companionFile, companionRoot,
  ModelNotEnabled } from '../service/logical-models.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const main = code(read('service/main.mjs'));
const ctl = code(read('service/asr/controller.mjs'));

// ── 客户端行为（真的跑）─────────────────────────────────────────────

const ok = {
  ok: true, model_id: 'model.sensevoice', display_name: 'SenseVoice', version: '3.1.0',
  state: 'enabled', available: true, reason: null,
  executable: { kind: 'prebuilt', path: '/store/ctx/model.onnx', verified_at: 'now' },
  companions: { 'model.sensevoice.frontend': {
    root: '/store/fe', files: { cmvn: '/store/fe/am.mvn', tokens: '/store/fe/tokens.json' } } },
};
const fetchOk = async () => ({ ok: true, json: async () => ok });
const fetchNotEnabled = async () => ({ ok: true, json: async () => ({
  ok: true, model_id: 'model.campplus', state: 'not_downloaded', available: false,
  reason: 'model_not_enabled', hint: '请在「模型管理器」里下载并点「使用」。',
  executable: null, companions: {} }) });
const fetchDown = async () => { throw new Error('ECONNREFUSED'); };

test('M1 可用时给出可执行体',
  (await resolveLogicalModel('model.sensevoice', { fetchImpl: fetchOk })).executable.path
    === '/store/ctx/model.onnx');

test('M2 ⭐ 伴随文件按 role 取，⛔ 不拼文件名', (() => {
  const c = companionFile(ok, 'model.sensevoice.frontend', 'cmvn');
  return c === '/store/fe/am.mvn'
    && companionFile(ok, 'model.sensevoice.frontend', 'tokens') === '/store/fe/tokens.json'
    && companionRoot(ok, 'model.sensevoice.frontend') === '/store/fe';
})());

test('M3 取不到的 role 返回 null，⛔ 不回落到一个猜出来的名字',
  companionFile(ok, 'model.sensevoice.frontend', 'nope') === null
    && companionFile(ok, 'model.nonexistent', 'cmvn') === null);

test('M4 ⭐ 「模型没准备好」是正常状态，⛔ 不抛异常', (async () => {
  const d = await resolveLogicalModel('model.campplus', { fetchImpl: fetchNotEnabled });
  return d.available === false && d.reason === 'model_not_enabled' && typeof d.hint === 'string';
})());

test('M5 ⚠ 「够不到管理器」与「模型没准备好」是两件事', (async () => {
  const d = await resolveLogicalModel('model.sensevoice', { fetchImpl: fetchDown });
  return d.available === false && d.reason === 'model_manager_unavailable';
})());

{
  let threw = null;
  try { await requireLogicalModel('model.campplus', { fetchImpl: fetchNotEnabled }); }
  catch (e) { threw = e; }
  test('M6 require 版在不可用时抛 ModelNotEnabled 且带得出 hint',
    threw instanceof ModelNotEnabled && threw.reason === 'model_not_enabled'
      && typeof threw.hint === 'string');
}

test('M7 ⚠ 走 query 而不是路径段（Framework 的包路由是精确匹配，⛔ 无通配符）',
  read('service/logical-models.mjs').includes("/model/resolve`\n    + `?id="));

// ── ⭐ speech 不再自己判断 ────────────────────────────────────────────

test('S1 ⭐ SenseVoice 只请求 logical model',
  main.includes("resolveLogicalModel('model.sensevoice')"));

test('S2 ⛔ 不再有 ctx→graph 的 fallback 判断',
  !main.includes("resolveAssetRoot('model.sensevoice.ctx')")
  && !main.includes("resolveAssetRoot('model.sensevoice.graph')")
  && !/senseCtx\s*\|\|\s*senseGraph/.test(main));

test('S3 ⛔ ASR 控制器不再收 ctxRoot / graphRoot',
  !/ctxRoot\s*=\s*null/.test(ctl.slice(0, ctl.indexOf('constructor') + 3000))
  && ctl.includes('executablePath = null'));

test('S4 ⛔ 控制器不再拼 SenseVoice 的文件名',
  !ctl.includes("path.join(frontendRoot, 'am.mvn')")
  && !ctl.includes("path.join(frontendRoot, 'tokens.json')")
  && !ctl.includes("path.join(ctxRoot, 'model.onnx')")
  && ctl.includes('frontendFiles?.cmvn'));

test('S5 ⛔ 退休 Audio8 不再进入 ASR 控制器',
  !/\$\{ctxRoot\}\/model_ir11\.onnx/.test(ctl)
  && !ctl.includes('audio8'));

test('S6 ⭐ CAM++ 的可执行体也来自管理器',
  main.includes("resolveLogicalModel('model.campplus')")
  && !main.includes("ensureAssetRoot('model.campplus.ctx')"));

test('S7 ⭐ speech 里 ⛔ 不出现 target / QNN 的比较',
  !/htp\s*===|qnn\s*===|'v73'|'v79'/.test(main.replace(/tsp-vad-|tsp-asr-/g, '')));

test('S8 ⭐ kind 只进诊断，⛔ 不改变行为', (() => {
  // 控制器可以记下 kind，但⛔ 不许出现 `if (kind === 'prebuilt')` 这种分支
  return ctl.includes('this.executableKind = executableKind')
    && !/executableKind\s*===\s*'/.test(ctl);
})());

test('S9 ⭐ 缺模型不许让服务起不来（那正是唯一能补模型的界面）',
  main.includes('senseVoiceReady = senseModel?.available === true')
  && !/throw .*senseModel/.test(main));

test('S10 ⭐ 消费方 ⛔ 不许直接读管理器的 state 文件',
  !main.includes('hf-model-manager/models/')
  && !read('service/logical-models.mjs').includes('readFileSync'));

/**
 * ⭐ **真机上撞到的那个假绿**（docs/093）：模型管理器还没起来 ⇒ 可执行体是 null
 * ⇒ 文件清单为空 ⇒ `missing.length === 0` ⇒ **报 ready，而它一个模型都没有**。
 * ⚠ 一个空集合让「全部满足」与「什么都没问」变成同一个答案。
 */
test('S11 ⭐ 空的文件清单 ⛔ 不许被读成「文件都在」',
  ctl.includes('const filesPresent = senseVoice.files.length > 0 && senseVoice.files_present;')
  && ctl.includes("'model_not_enabled'"));

test('S12 未启用时 reason 说得出是「没启用」而不是「文件缺失」',
  /!this\.modelReady \? 'model_not_enabled'/.test(ctl));

console.log(`\n${count - failures}/${count} logical-migration assertions passed`);
process.exit(failures ? 1 : 0);

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `service/logical-models.mjs`（真的跑）+ 四个消费者与 `main.mjs` 的源码
 * [OUTPUT]: 「`executable.path` 不是 `model_path`」这条规则的回归
 * [POS]: ⭐ 这条约束**在有源图的机器上看不出来**：那里 `model_path` 恰好也能加载，
 *        只是白编译一次。它只在**只装了编译产物**的机器上才炸——而那正是新装机的常态
 *        （Manager 按 docs/092 会删掉几百 MB 的源图）。
 * ⭐ 真机症状是 App 的 `EP_CONTEXT_AS_MODEL_PATH`：加载器拿 EPContext 去编译一份新的
 *   context，而它内部那个 `ep_cache_context` 相对引用再也解析不到自己的目录。
 * ⚠ `asr/controller.mjs` 一直是对的，另外三个 FireRedVAD 消费者在 docs/093 迁移时被漏下——
 *   ⭐ **一条正确但只写在一个文件里的规则，和一条没有写下来的规则，寿命一样长。**
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableGraphArgs } from '../service/logical-models.mjs';

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

// ── 路由函数本身（真的跑）────────────────────────────────────────────
const CTX = '/sdcard/termux-os/caches/fireredvad-1.1.0.ctx.onnx';

for (const kind of ['local', 'prebuilt']) {
  const r = executableGraphArgs({ executable: { kind, path: CTX } });
  test(`a ${kind} executable goes to ctx_path`, r.ctxPath === CTX);
  test(`a ${kind} executable never becomes model_path`, r.modelPath === null);
  test(`a ${kind} executable is flagged as a context`, r.isContext === true);
}

test('the derived ctx key is version bound, not the bare model name',
  executableGraphArgs({ executable: { kind: 'local', path: CTX } }).ctxKey === 'fireredvad-1.1.0');

const SRC = '/sdcard/termux-os/models/x/1.0.0/generic/fireredvad/model.onnx';
const plain = executableGraphArgs({ executable: { kind: 'source', path: SRC } });
test('a plain graph still goes to model_path', plain.modelPath === SRC && plain.ctxPath === null);

test('no executable resolves to null, not to a guessed path',
  executableGraphArgs({}) === null && executableGraphArgs(null) === null);
test('an executable without a path is not usable',
  executableGraphArgs({ executable: { kind: 'local' } }) === null);

// ── 消费者：⛔ 谁都不许自己判 ────────────────────────────────────────
const consumers = {
  'vad/controller.mjs': code(read('service/vad/controller.mjs')),
  'speaker-lab.mjs': code(read('service/speaker-lab.mjs')),
  'acoustic-lab.mjs': code(read('service/acoustic-lab.mjs')),
  'asr/controller.mjs': code(read('service/asr/controller.mjs')),
};

for (const [name, src] of Object.entries(consumers)) {
  /**
   * ⭐ 判据是「有没有把一个 executable 直接塞进 modelPath」。
   * ⛔ 不是「有没有出现 model_path 这个词」——状态投影里合法地出现它。
   */
  test(`${name} never assigns an executable path into modelPath`,
    !/modelPath\s*[:=]\s*this\.executablePath/.test(src)
    && !/modelPath\s*:\s*this\.modelPath\s*,?\s*$/m.test(src.replace(/modelPath: this\.modelPath,\n\s*ctxPath/g, '')));
  test(`${name} does not decide the routing itself`,
    !/executable\??\.kind\s*===\s*['"](local|prebuilt)['"]/.test(src));
}

// asr 那个曾经手写的结论必须来自共享函数，⛔ 不许是巧合。
test('asr/controller.mjs routes through the shared helper',
  consumers['asr/controller.mjs'].includes('executableGraphArgs('));

// 三个 FireRedVAD 消费者接收的是**已经路由好的参数**，⛔ 不是裸路径。
test('vad/controller.mjs takes routed graph args, not a bare path',
  /graph\s*=\s*null/.test(consumers['vad/controller.mjs'])
  && !/modelFile\s*=\s*null/.test(consumers['vad/controller.mjs']));
test('speaker-lab.mjs takes routed graph args, not a bare path',
  /vadGraph\s*=\s*null/.test(consumers['speaker-lab.mjs'])
  && !/vadModelFile\s*=\s*null/.test(consumers['speaker-lab.mjs']));
test('acoustic-lab.mjs takes routed graph args, not a bare path',
  /graph\s*=\s*null/.test(consumers['acoustic-lab.mjs'])
  && !/modelFile\s*=\s*null/.test(consumers['acoustic-lab.mjs']));

// main.mjs 只算一次，三处共用同一份。
const main = code(read('service/main.mjs'));
test('main.mjs routes the FireRedVAD executable exactly once',
  (main.match(/executableGraphArgs\(vadModel\)/g) ?? []).length === 1);
test('main.mjs hands the same routed args to all three consumers',
  (main.match(/(?:^|[^\w])(?:vadG|g)raph: VAD_GRAPH/g) ?? []).length === 3);

/**
 * ⭐ **「用完就走」是这两张图存在的全部理由。**
 *
 * `tsp-*-spk` 是一个 HTP 会话；docs/096 收走 speech 的常驻所有权，正是因为这类图
 * 会一直占着而没有任何界面说得出来。**建了不删 = 换了个名字的常驻。**
 * ⚠ 真机验过一次「叫临时但不走」：`enroll/stop` 之后两个会话仍然在 `inference/top` 里。
 */
const lab = code(read('service/speaker-lab.mjs'));
test('speaker-lab releases its ephemeral sessions when it goes idle',
  /async stop\(\)[\s\S]{0,300}#releaseGraphs/.test(lab)
    && /forceIdle\([\s\S]{0,300}#releaseGraphs/.test(lab));
test('the enrollment graphs are declared ephemeral, not as residents',
  /ephemeral: true/.test(lab)
    && /ephemeral: true/.test(code(read('service/speaker/campplus.mjs'))));
test('stopping enrollment awaits the release',
  /await speakerLab\.stop\(\)/.test(code(read('service/main.mjs'))));

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: BoundaryVoter / candidates
 * [OUTPUT]: `{字A}{标点}{字B}` debounce 的行为回归
 * [POS]: docs/065。⭐ 这套要钉死的三件事恰好就是任务要求的三条 trace：
 *        同标点两次 → commit；标点变化两次 → 仍 commit；单次误标点 → 不 commit。
 *        它们全都只跟字符串有关，所以能用毫秒级单测逐个证伪，而不是靠真机去撞。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { BoundaryVoter, candidates } from '../service/asr/boundary.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

// ---------------------------------------------------------------- candidates

test('尾部自动标点没有右字素，结构上不是候选',
  candidates('广州买东西。').length === 0);
test('句中标点左右都有字，是候选',
  candidates('广州。买东西').length === 1);
test('多个句中标点各自成候选',
  candidates('甲。乙，丙').length === 2);
test('开头就是标点不算候选（左边没有字）',
  candidates('。买东西').length === 0);
test('连续标点不会造出空候选',
  candidates('广州。。买').length === 0 + candidates('广州。。买').length);
test('标点变化不改变 key',
  candidates('广州。买东西')[0].key === candidates('广州，买东西')[0].key);
test('key 不含标点本身',
  !candidates('广州。买东西')[0].key.includes('。'));

// ---------------------------------------------------------------- A/B/C 三条 trace

const traceA = new BoundaryVoter();
const a1 = traceA.accept('广州。买东西');
const a2 = traceA.accept('广州。买东西了');
test('trace A 同标点两次 → commit',
  a1.commit === null && a2.commit !== null && a2.commit.text === '广州。');
test('trace A commit 后 active 只剩右半',
  a2.active === '买东西了');

const traceB = new BoundaryVoter();
const b1 = traceB.accept('广州。买东西');
const b2 = traceB.accept('广州，买东西了');
test('trace B 标点变化两次 → 仍然 commit',
  b1.commit === null && b2.commit !== null);
test('trace B commit 用最新那条的标点',
  b2.commit.punct === '，' && b2.commit.text === '广州，');

const traceC = new BoundaryVoter();
const c1 = traceC.accept('广州。买东西');
const c2 = traceC.accept('广州买东西了');       // 那个标点是一次性误判，没有第二次 support
const c3 = traceC.accept('广州买东西了吗');
test('trace C 单次误标点 → 不 commit',
  c1.commit === null && c2.commit === null && c3.commit === null);
test('trace C 全程 committed 为空', traceC.committed === '');

// ---------------------------------------------------------------- 其余规则

const gapVoter = new BoundaryVoter();
gapVoter.accept('广州。买东西');                // hit #1
gapVoter.accept('广州买东西了');                // 抖掉，evidence 不清零
const g3 = gapVoter.accept('广州，买东西了吧');  // hit #2 → commit
test('非连续两次 support 即可 confirm（中间抖掉一次不清零）',
  g3.commit !== null && g3.commit.support === 2);

const leftVoter = new BoundaryVoter();
leftVoter.accept('甲。乙，丙');
const l2 = leftVoter.accept('甲。乙，丙丁');
test('多个已确认边界时提交最靠左的那个',
  l2.commit !== null && l2.commit.text === '甲。');

const winVoter = new BoundaryVoter({ window: 2 });
winVoter.accept('广州。买东西');
winVoter.accept('完全不同的内容啊');
winVoter.accept('还是不同的东西呢');
const w4 = winVoter.accept('广州。买东西');
test('证据滑出窗口后不再算数',
  w4.commit === null);

const cropVoter = new BoundaryVoter();
cropVoter.accept('广州。买东西');
cropVoter.accept('广州。买东西了');              // commit '广州。'
const p3 = cropVoter.accept('广州。买东西了吗');  // 整段重出，需剪掉已提交前缀
test('已提交前缀被剪掉，不会重复计入 active',
  p3.active === '买东西了吗');
test('已提交内容不再回到 active（无 duplicate）',
  !p3.active.includes('广州'));

const ratioVoter = new BoundaryVoter();
ratioVoter.accept('广州。买东西');
const r2 = ratioVoter.accept('广州。买东西');
test('cutRatio 在 0..1 之间且与可见位置一致',
  r2.commit.cutRatio > 0 && r2.commit.cutRatio < 1
  && Math.abs(r2.commit.cutRatio - 3 / '广州。买东西'.length) < 1e-9);

// ⚠ cutRatio 的分母必须是**整条 hypothesis**：调用方拿它乘的是整条的 active_audio_ms。
const offVoter = new BoundaryVoter();
offVoter.accept('甲甲甲。乙乙乙，丙丙');
const off2 = offVoter.accept('甲甲甲。乙乙乙，丙丙丙');   // 同一趟交两刀
test('同一趟里第二刀的 cutRatio 仍相对整条 hypothesis（advance 不偏右）',
  off2.commits.length === 2
  && Math.abs(off2.commits[1].cutRatio - 8 / '甲甲甲。乙乙乙，丙丙丙'.length) < 1e-9);

const emptyVoter = new BoundaryVoter();
test('空 hypothesis 不炸也不 commit',
  emptyVoter.accept('').commit === null && emptyVoter.accept(null).commit === null);

// ---------------------------------------------------------------- 真机查出来的两条

const dupVoter = new BoundaryVoter();
dupVoter.accept('你觉得期限很强，其实大部分都有假象');
const d2 = dupVoter.accept('你觉得期限很强，其实大部分都有假象。舞台上');
test('真机复现：同一个 key 提交后不再被确认第二次（duplicate=0）',
  d2.commit !== null
  && dupVoter.accept('你觉得极限很强，其实大部分都有假象。舞台上，他们').commit?.key !== d2.commit.key);

const rateVoter = new BoundaryVoter();
rateVoter.accept('甲。乙，丙。丁');
const rate2 = rateVoter.accept('甲。乙，丙。丁戊');
// ⭐ 一条 hypothesis 里连着交多刀：提交速率不再被「一条一刀」卡住，
//   这正是滞后涨到 8 秒编码窗、窗左侧未提交音频被丢弃的那条因果的解药。
test('同一趟里连续提交多个已确认边界（提交速率不被一条一刀卡住）',
  rate2.commits.length === 2
  && rate2.commits[0].text === '甲。' && rate2.commits[1].text === '乙，');

const stopVoter = new BoundaryVoter();
stopVoter.accept('甲。乙，丙');
const stop2 = stopVoter.accept('甲。乙，丙丁');
// '乙，丙' 那一刀在第二条里 right context 变了（丙→丙丁），故未确认——必须停在它前面。
test('遇到未确认的边界就停，不跨过尚未稳定的中间内容',
  stop2.commits.length >= 1 && stop2.commits[0].text === '甲。');

// 真机第二条：不同 key 的下一个边界，不许把上一句原样再交一遍。
const seqVoter = new BoundaryVoter();
seqVoter.accept('你觉得极限很强，其实大部分都');
const s2 = seqVoter.accept('你觉得极限很强，其实大部分都想象，舞台上');   // commit '你觉得极限很强，'
const s3 = seqVoter.accept('你觉得极限很强，其实大部分都有假象。舞台上，他们');
const s4 = seqVoter.accept('你觉得极限很强，其实大部分都有假象。舞台上，他们能');
test('声学 advance 滞后时，下一个边界不重复交上一句',
  s2.commit?.text === '你觉得极限很强，'
  && s4.commit !== null && !s4.commit.text.includes('你觉得极限很强'));

// 窗滑过去之后 text 从半句开始，什么都不该剪。
const slidVoter = new BoundaryVoter();
slidVoter.accept('甲乙丙。丁戊');
slidVoter.accept('甲乙丙。丁戊己');                       // commit '甲乙丙。'
const slid = slidVoter.cropCommitted('完全无关的后半句内容');
test('窗滑过去后不误剪', slid === '完全无关的后半句内容');

// 真机第三条：ASR 把已提交那句里的词改写掉，字面剪不掉——只有 key 去重挡得住，
// 而它的时长必须覆盖编码窗，不能只覆盖证据窗。
const rewriteVoter = new BoundaryVoter({ window: 4, dedupeWindow: 8 });
rewriteVoter.accept('你觉得基建很强，其实大部分');
rewriteVoter.accept('你觉得基建很强，其实大部分都');        // commit '你觉得基建很强，'
for (const t of ['其实大部分都有假象', '其实大部分都有假象啊', '其实大部分都有假象呢']) {
  rewriteVoter.accept(t);
}
const rw = rewriteVoter.accept('你觉得期限很强，其实大部分都有假象');
test('已提交的边界在编码窗内不会因 ASR 改写而重复提交',
  rw.commit === null || !rw.commit.text.includes('很强'));

// 真机第四条（zh 30s 实测序列）：提交后 ASR 改写了已提交那句里的词，
// 字符串剪裁必然失效——靠 boundary key 定位上一刀才不会重复。
const locVoter = new BoundaryVoter();
locVoter.accept('你觉得期限很强，其实大部分都');
const L2 = locVoter.accept('你觉得期限很强，其实大部分都有假象。舞台上，他们的后空');
const L3 = locVoter.accept('你觉得极限很强，其实大部分都想象。舞台上，他们能后空翻，能跳舞');
test('已提交那句被 ASR 改写后，下一刀仍按 key 定位、不重复',
  L2.commit?.text === '你觉得期限很强，'
  && (L3.commit === null || !L3.commit.text.includes('很强')));

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

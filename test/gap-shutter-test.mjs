/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: decide / cutPoints（gap 半快门 + 标点全快门）+ BoundaryVoter 的剪裁锚点
 * [OUTPUT]: docs/067 §18 点名的八条行为回归
 * [POS]: 正式 commit 路径已从 support≥2 换成 gap+punct 单次确认，
 *        故这套测试就是新正式路径的定义。旧 BoundaryVoter 的测试保留不动。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { cutPoints, decide } from '../service/asr/gap-commit.mjs';
import { BoundaryVoter } from '../service/asr/boundary.mjs';

let failures = 0;
let count = 0;
const test = (name, condition) => {
  count += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  if (!condition) failures += 1;
};

// 1. gap + 尾部标点 → commit（旧规则永远做不到的那一条）
const t1 = decide({ trigger: 'gap', active: '这是一个句子。' });
test('gap + 尾部标点 → commit',
  t1 !== null && t1.text === '这是一个句子。' && t1.trailing === true);

// 2. gap + 句中标点 → commit
const t2 = decide({ trigger: 'gap', active: '广州，买东西' });
test('gap + 句中标点 → commit 到标点后',
  t2 !== null && t2.text === '广州，' && t2.trailing === false);

// 3. gap 但无标点 → 不 commit（不为了没标点强行切句）
test('gap 但无标点 → 不 commit',
  decide({ trigger: 'gap', active: '我今天去了广州' }) === null);

// 4. fallback + 标点 → 不走单次强确认
test('fallback + 标点 → 不 commit',
  decide({ trigger: 'fallback', active: '这是一个句子。' }) === null
  && decide({ trigger: 'fallback', active: '广州，买东西' }) === null);

// 5. gap + 多个标点 → 取最靠右的安全边界（不是第一个逗号）
const t5 = decide({ trigger: 'gap', active: '我今天去了广州，后来又去了佛山。然后' });
test('gap + 多标点 → commit 到最右边界',
  t5 !== null && t5.text === '我今天去了广州，后来又去了佛山。' && t5.points === 2);
const t5b = decide({ trigger: 'gap', active: '我今天去了广州，后来又去了佛山。' });
test('最右边界是尾部标点时也一次吃掉',
  t5b !== null && t5b.trailing === true && t5b.text.endsWith('佛山。'));

// 6. 已提交过的旧标点不得重复提交（靠剪裁锚点，不靠记忆标点本身）
const v6 = new BoundaryVoter();
const a6 = v6.crop('广州，买东西');
const d6 = decide({ trigger: 'gap', active: a6 });
v6.noteExternalCommit(a6, d6.cut, d6.text);
const a6b = v6.crop('广州，买东西了。');
test('已提交前缀被剪掉，旧标点不再是候选',
  a6b === '买东西了。' && decide({ trigger: 'gap', active: a6b }).text === '买东西了。');

// 7. 标点类型后来变化不造成 duplicate
const v7 = new BoundaryVoter();
const a7 = v7.crop('广州。买东西');
const d7 = decide({ trigger: 'gap', active: a7 });
v7.noteExternalCommit(a7, d7.cut, d7.text);
const a7b = v7.crop('广州，买东西了');   // 。→，
test('标点类型变化后不重复提交已交内容',
  !a7b.includes('广州') && a7b === '买东西了');

// 8. 空白 hypothesis 不 commit
test('空白 hypothesis 不 commit',
  decide({ trigger: 'gap', active: '' }) === null
  && decide({ trigger: 'gap', active: '   ' }) === null
  && decide({ trigger: 'gap', active: '。' }) === null);

// ---- cutPoints 的两条边界情形 ----
test('连续标点只切一次，切在最后一个之后',
  cutPoints('广州。。买').length === 1 && cutPoints('广州。。买')[0].cut === 4);
test('开头就是标点不算切点',
  cutPoints('。买东西').length === 0);

// ---- 尾部标点后跟空白仍算 trailing（ASR 常带尾空格）----
const t9 = decide({ trigger: 'gap', active: 'This is a sentence. ' });
test('尾部标点后跟空白仍视为 trailing',
  t9 !== null && t9.trailing === true && t9.text.trim().endsWith('.'));

// ---- 英文句中标点 ----
const t10 = decide({ trigger: 'gap', active: 'Okay, these are my top ten' });
test('英文句中逗号 → commit 到逗号后',
  t10 !== null && t10.text === 'Okay, ' && t10.trailing === false);

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

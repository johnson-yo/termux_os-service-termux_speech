/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一条 live hypothesis 的文本 + 它的 trigger_reason / gap_ms + 已提交状态
 * [OUTPUT]: 对外提供「半快门 / 全快门」判定：commit 到哪个 boundary，或者不 commit
 * [POS]: docs/067。取代旧的 support≥2 debounce 作为**正式** commit 路径。
 *
 * ⭐ **两个证据，一次成交。** VAD gap 是**声学**边界证据，ASR 标点是**语义**边界证据。
 *   docs/066 量出：贴 8 秒窗的 case 里真正「没有可提交点」的只有 4%，
 *   75–82% 是在等第二条 hypothesis。而那第二条并不带来新证据——
 *   它只是把同一件事再看一遍。gap 本身就是那个第二证据，而且它是**声学**的、
 *   与 ASR 的文本抖动独立，比「同一个 key 再出现一次」强。
 * ⭐ **尾部标点在 gap 触发时是合法的**。旧规则要求 `{A}{标点}{B}`，尾部标点没有 B
 *   所以永远不能提交——而说完一句话停顿，恰恰是最该提交的时刻，
 *   句尾标点也恰恰在那时出现。缺的那个 B，gap 已经在声学上提供了。
 * ⚠ **fallback 触发不走这条路**。fallback 只证明「攒够了新音频」，
 *   没有任何停顿证据；拿单个标点就提交，等于把模型的自动补句号当成事实。
 * ⚠ 取**最靠右**的可提交标点：gap 发生在最新语音之后，这段停顿之前的语义内容
 *   已经完整，一次吃掉；只提交第一个逗号会白白浪费这个 gap。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { PUNCT } from './boundary.mjs';

const isSpace = (ch) => /\s/.test(ch);

/**
 * 找出 active 文本里所有可提交的标点切点（切点 = 标点之后的下标）。
 * 连续标点算作一个（切在最后一个之后）。
 */
export function cutPoints(active) {
  const out = [];
  if (typeof active !== 'string') return out;
  for (let i = 0; i < active.length; i += 1) {
    if (!PUNCT.has(active[i])) continue;
    // 连续标点/空白只在最后一个之后切一次
    let j = i;
    while (j + 1 < active.length && (PUNCT.has(active[j + 1]) || isSpace(active[j + 1]))) j += 1;
    // 左边必须有字：开头就是标点不是边界
    let l = i - 1;
    while (l >= 0 && (PUNCT.has(active[l]) || isSpace(active[l]))) l -= 1;
    if (l < 0) { i = j; continue; }
    const cut = j + 1;
    const trailing = cut >= active.length;
    out.push({ cut, punct: active[i], trailing });
    i = j;
  }
  return out;
}

/**
 * 半快门/全快门判定。
 *
 * @param trigger      'gap' | 'fallback'
 * @param active       已剪掉 committed 之后的当前文本
 * @returns {null | {cut, punct, trailing, cutRatioLocal, reason}}
 */
export function decide({ trigger, active }) {
  if (trigger !== 'gap') return null;                 // 只有半快门按下过，才允许全快门
  if (typeof active !== 'string' || !active.trim()) return null;
  const points = cutPoints(active);
  if (!points.length) return null;                    // gap 够大但没有标点 → 等下一句
  // ⭐ 最靠右的那个：gap 之前的语义内容已经完整，一次吃掉。
  const best = points[points.length - 1];
  const text = active.slice(0, best.cut);
  if (!text.trim()) return null;
  return {
    cut: best.cut,
    punct: best.punct,
    trailing: best.trailing,
    points: points.length,
    text,
    reason: best.trailing ? 'gap_trailing_punct' : 'gap_internal_punct',
  };
}

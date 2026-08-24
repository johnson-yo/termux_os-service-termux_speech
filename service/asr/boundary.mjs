/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: ASR 运行时送来的一串 live hypothesis（纯文本，无任何语义标注）
 * [OUTPUT]: 经 debounce/voting 确认的 commit 边界 —— 提交文本 + 该边界在可见文本中的位置
 * [POS]: docs/065。commit 判断住在 termux-speech，App 只给 hypothesis。
 *
 * ⭐ **边界身份不含标点字符本身**：`广州。买` 与 `广州，买` 说的是同一件事——
 *   「广州」和「买」之间有一刀。把标点写进 key，一次 `。`→`，` 的抖动就会让证据清零，
 *   而那恰恰是最常见的抖动。key 只由**左右最近的有效字素**（加少量局部上下文做 tie-break）构成。
 * ⭐ **候选必须左右都有字**：hypothesis 尾部自动补的那个 `。` 右边没有东西，
 *   于是它**在结构上**当不了候选——这比事后加一条「忽略末尾标点」的规则可靠，
 *   因为后者要求每个新入口都记得去调用它。
 * ⚠ support 不要求连续：`A。B` → 抖掉 → `A，B` 应当 commit。
 *   连续计数会把一次抖动当成全盘否定，而 ASR 的抖动是常态不是异常。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 第一版只覆盖 ASR 实际会输出的语义标点，不做成通用 parser。 */
export const PUNCT = new Set(['。', '！', '？', '.', '!', '?', '，', ',', '；', ';', '：', ':']);

/** 空白与标点都不是「字」。左右两侧的 A/B 必须是真正的字素。 */
const isSkippable = (ch) => PUNCT.has(ch) || /\s/.test(ch);

/** tie-break 用的局部上下文长度：够区分重复词，又不至于让长句改写把 key 打散。 */
const CTX = 2;

/** `committed` 只保留尾部这么多字用于剪裁；再往前的内容早已滑出编码窗。 */
const TAIL_CHARS = 200;

const contextLeft = (text, index) => {
  let out = '';
  for (let i = index; i >= 0 && out.length < CTX; i -= 1) {
    if (!isSkippable(text[i])) out = text[i] + out;
  }
  return out;
};

const contextRight = (text, index) => {
  let out = '';
  for (let i = index; i < text.length && out.length < CTX; i += 1) {
    if (!isSkippable(text[i])) out += text[i];
  }
  return out;
};

/**
 * 找出一条 hypothesis 里所有 `{字A}{标点}{字B}` 候选。
 *
 * 返回 `{ key, punct, cut }`，`cut` 是**提交切点**：标点之后、B 之前的下标，
 * 于是提交文本包含 A 与标点，而 B 留给下一轮。
 */
export function candidates(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (let i = 0; i < text.length; i += 1) {
    if (!PUNCT.has(text[i])) continue;
    // 往左找最近的字素
    let l = i - 1;
    while (l >= 0 && isSkippable(text[l])) l -= 1;
    if (l < 0) continue;
    // 往右找最近的字素
    let r = i + 1;
    while (r < text.length && isSkippable(text[r])) r += 1;
    if (r >= text.length) continue;          // ⭐ 尾部自动标点：没有 B，天然不是候选
    out.push({
      key: `${contextLeft(text, l)}|${contextRight(text, r)}`,
      punct: text[i],
      cut: i + 1,
      left: text[l],
      right: text[r],
    });
  }
  return out;
}

/**
 * 边界投票器。维护 `committed` 前缀与最近若干条 hypothesis 的证据。
 *
 * ⚠ 它**只认字符串**。声学位置换算由调用方按可见比例做——这里不引入任何时间概念，
 *   否则单测就得造时间，而这套规则里没有一条真的跟时间有关。
 */
export class BoundaryVoter {
  /**
   * @param window 证据滚动窗口（保留最近多少条 hypothesis 的命中）
   * @param support 确认所需的命中次数（不要求连续）
   */
  constructor({ window = 4, support = 2, dedupeWindow = 8 } = {}) {
    this.window = Math.max(2, Number(window) || 4);
    this.support = Math.max(2, Number(support) || 2);
    /**
     * ⭐ 去重的时长由**编码窗**决定，不是由证据窗决定：同一段音频只在它还留在
     * 8 秒窗里的时候才可能被再看见一次。真机事故——证据窗（4 条）比编码窗短，
     * 于是「你觉得X很强，」在守卫过期之后又被交了一遍，
     * 而这次 ASR 把「基建」改写成了「期限」，字面对不上、`cropCommitted` 也救不了。
     */
    this.dedupeWindow = Math.max(this.window, Number(dedupeWindow) || 8);
    this.committed = '';
    this.seq = 0;
    /** key → 命中过的 hypothesis 序号（升序，只留窗口内的） */
    this.evidence = new Map();
    /**
     * key → 提交时的 seq。⭐ 声学 advance 是**比例估算**，所以提交之后那几个字
     * 常常还留在编码窗里；不记住刚提交过什么，同一个边界会被确认第二次，
     * 而那正是 duplicate 的来源。真机实测「你觉得X很强，」被连着提交两次。
     * ⚠ 只压制一个窗口的时长——同样的话过一阵子再说一次是合法的。
     */
    this.recentKeys = new Map();
    /** 上一刀切在哪个 boundary 上；下一条 hypothesis 靠它定位已提交的边界。 */
    this.lastKey = null;
  }

  /**
   * 只剪裁、不投票、不改状态——给 gap 半快门那条正式路径用（docs/067）。
   * ⭐ 剪裁与投票必须能分开：正式 commit 已经不再依赖投票，
   *   但「哪一段是新的」这个问题两条路都要答，而它只有一个正确答案。
   */
  crop(rawText) {
    const raw = typeof rawText === 'string' ? rawText : '';
    if (this.lastKey) {
      const hit = candidates(raw).find((c) => c.key === this.lastKey);
      if (hit) return raw.slice(hit.cut);
    }
    return this.cropCommitted(raw);
  }

  /**
   * 记下这一刀（不经投票）。`cut` 是**剪裁后 active** 的下标。
   * ⚠ 尾部标点没有右侧字素，构不成 `{A}{标点}{B}` key，此时只能靠字符串尾巴定位——
   *   如实把 `lastKey` 清掉，而不是留一个指向别处的旧 key。
   */
  noteExternalCommit(active, cut, text) {
    this.committed = (this.committed + text).slice(-TAIL_CHARS);
    const hit = candidates(active).find((c) => c.cut === cut);
    this.lastKey = hit ? hit.key : null;
    if (hit) this.recentKeys.set(hit.key, this.seq);
  }

  /**
   * 剪掉已经交出去的那一段。
   *
   * ⭐ **按 committed 的尾巴匹配 text 的开头**，不是拿整个 committed 去比。
   *   两种情况得同时成立：编码窗还没滑过去时，hypothesis 仍然从整段开头重出，
   *   要剪掉的是「最近提交的那几句」；窗滑过去之后，text 从半句开始，
   *   什么都不该剪。拿整个 committed 做 `startsWith`，第二种情况永远匹配不上；
   *   而退化成「最长公共前缀」会啃掉几个恰好相同的字。
   * ⚠ 真机事故：曾在提交后把 `committed` 清空，理由是「App 已经 advance 过了」——
   *   但 advance 是**比例估算**，那几个字还在窗里，于是下一个边界从位置 0 切起，
   *   把上一句原样又交了一遍。**声学 advance 近似，字符串这一层就不能省。**
   */
  cropCommitted(text) {
    const tail = this.committed;
    if (!tail || !text) return text;
    const max = Math.min(tail.length, text.length);
    // 取**最长**的匹配：短的匹配可能只是碰巧同字，长的才是真的重出。
    for (let n = max; n > 0; n -= 1) {
      if (text.startsWith(tail.slice(tail.length - n))) return text.slice(n);
    }
    return text;
  }

  /**
   * 吃一条 hypothesis，返回这一条里**全部**已确认的边界（从左到右）。
   *
   * ⭐ **一条里可以交多个。** 一次只交最左那个时，提交速率上限就是一条 hypothesis 一刀
   *   （约 1.6 秒），而连续语流产生边界比这更快，滞后于是一路涨到 8 秒编码窗——
   *   **此时窗左边那段还没提交的音频会被直接丢掉**（`s0 = max(commitSample, s1-窗)`），
   *   真机表现为提交文本成段掉字。已确认（support≥2）的边界按定义就是稳定的。
   * ⚠ 但遇到**未确认**的边界就必须停：越过它就是「跨过尚未稳定的中间内容」。
   * ⚠ 全部判断都在**同一个** `active` 字符串上做：剪裁会改变后续边界的左上下文、
   *   从而改变它的 key，剪一次重算一次会让证据对不上号。
   */
  accept(rawText) {
    this.seq += 1;
    const raw = typeof rawText === 'string' ? rawText : '';
    /**
     * ⭐ **先按 boundary key 定位上一刀，字符串比对只是退路。**
     * 真机事故：提交「你觉得期限很强，」之后 ASR 把「期限」改写成「极限」，
     * 于是没有任何字符串能匹配上，下一个边界从位置 0 切起、把上一句原样又交了一遍。
     * 而我们**知道**上一刀切在哪个 key 上，那个 key 由局部上下文构成，
     * 恰好不受它左边那个词被改写的影响。
     */
    let active = raw;
    let located = false;
    if (this.lastKey) {
      const hit = candidates(raw).find((c) => c.key === this.lastKey);
      if (hit) { active = raw.slice(hit.cut); located = true; }
    }
    if (!located) active = this.cropCommitted(raw);
    // ⚠ 剪掉了多少字必须记住：`cutRatio` 是拿来乘**整个可见窗**的声学时长的。
    const cropOffset = raw.length - active.length;

    const found = candidates(active);
    const seen = new Set();
    for (const c of found) {
      if (seen.has(c.key)) continue;         // 同一条里重复出现的 key 只算一票
      seen.add(c.key);
      const hits = this.evidence.get(c.key) ?? [];
      hits.push(this.seq);
      this.evidence.set(c.key, hits);
    }
    const floor = this.seq - this.window + 1;
    for (const [key, hits] of this.evidence) {
      const kept = hits.filter((x) => x >= floor);
      if (kept.length) this.evidence.set(key, kept);
      else this.evidence.delete(key);
    }
    for (const [key, at] of this.recentKeys) {
      if (this.seq - at >= this.dedupeWindow) this.recentKeys.delete(key);
    }

    const commits = [];
    let consumed = 0;
    for (const c of found) {
      if (c.cut <= consumed) continue;
      const committedAt = this.recentKeys.get(c.key);
      // 刚交过的那一刀：跳过它继续看右边，它不算「未稳定内容」。
      if (committedAt !== undefined && this.seq - committedAt < this.dedupeWindow) continue;
      const hits = this.evidence.get(c.key) ?? [];
      if (hits.length < this.support) break;   // ⚠ 未确认 → 停，不许越过
      const text = active.slice(consumed, c.cut);
      consumed = c.cut;
      this.committed = (this.committed + text).slice(-TAIL_CHARS);
      this.evidence.delete(c.key);
      this.recentKeys.set(c.key, this.seq);
      this.lastKey = c.key;
      commits.push({
        text,
        key: c.key,
        punct: c.punct,                        // 用**最新**这条 hypothesis 当前的标点
        support: hits.length,
        // 分母是**整条 hypothesis**，因为调用方乘的是整条的 active_audio_ms。
        cutRatio: raw.length ? (cropOffset + c.cut) / raw.length : 0,
      });
    }
    /**
     * docs/066 量測：把这一条里**每个候选**的证据状态如实带出去。
     * 「8 秒 active」到底是「没有可提交点」还是「有但没确认」，
     * 只有把候选与它的 support 一起记下来才分得开——只记 commit 分不开。
     */
    const observed = found.map((c) => ({
      key: c.key,
      punct: c.punct,
      cut: c.cut,
      support: (this.evidence.get(c.key) ?? []).length,
      first_seen_seq: (this.evidence.get(c.key) ?? [])[0] ?? null,
      recently_committed: this.recentKeys.has(c.key),
    }));
    return { active: active.slice(consumed), commits, commit: commits[0] ?? null, observed, seq: this.seq };
  }
}

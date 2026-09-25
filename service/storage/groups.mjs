/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个 VAD segment **连同它已经完成的 ASR 结果**
 * [OUTPUT]: 每组 50 条的记录组；盘上稳定态最多两组，更旧的先归档进 SQLite 再删 WAV
 * [POS]: docs/061 §七。**全新的存储命名空间**——旧的 transcripts.v1.jsonl / segments.v1.jsonl
 *        与旧 WAV 一律不导入、不删除、不计入、不在新界面里出现。
 *
 *        ⭐ 准入发生在 ASR **之后**（`admit`），不是之前。旧版在 VAD 切段时就建一条
 *        `pending` item 并把 WAV 搬进组里，于是一句空白转写照样占掉一个名额、留下一份
 *        音频、拿到一个 feed 游标——要修它就得写一条回滚路径，而回滚路径永远测不全
 *        （崩在中间就会复活一条空白）。现在 item 一写下去就是终态，
 *        **「回滚」这个分支不存在**。
 * [PROTOCOL]: ⛔ 删除顺序不可调换：读最旧完成组 → 事务插入 → **commit 成功** → 标记 archived
 *             → 删 WAV 与目录 → 更新组状态。commit 之前删掉任何一个 WAV，
 *             都是把音频扔进一个还没写成的事务里。
 *             ⛔ 不用 `pipeline_epoch` 当唯一 ID：它在服务重启后归零。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

export const GROUP_SIZE = 50;
export const STATE_SCHEMA = 'termux-os.speech-records-state.v1';
export const ITEM_SCHEMA = 'termux-os.speech-record-item.v1';

/** 往回看几条就够：重开总是紧跟着上一条定稿发生（真机实录相隔 <2 s）。 */
const DUPLICATE_WINDOW_LOOKBACK = 5;
/** 单调时钟会在重启/换代时归零；不限时间窗的话旧记录能"包含"新记录。 */
const DUPLICATE_WINDOW_MAX_AGE_MS = 60_000;

const pad = (value) => String(value).padStart(6, '0');
const groupIdFor = (seq) => `group-${pad(seq)}`;

const atomicWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * item → feed observation。字段名与旧 feed 保持一致：消费者读的是名字，不是来源。
 */
const sourceKindOf = (item) => item?.source_kind
  ?? (item?.source === 'app_segment' ? 'app_segment' : null);
const audioAvailableOf = (item) => item?.audio_available === true
  || (sourceKindOf(item) === 'app_segment' && item?.audio_available !== false);

const feedRecord = (item, seq) => ({
  schema: 'termux-os.speech-transcript.v1',
  seq,
  observed_ms: Number(item.observed_ms) || Date.parse(item.completed_at) || seq,
  utterance_id: item.utterance_id ?? `utt_${item.segment_id}`,
  segment_id: item.segment_id,
  text: item.text ?? '',
  final: true,
  language: item.language ?? null,
  model: item.model ?? null,
  backend: item.backend ?? null,
  timing: { inference_ms: item.inference_ms ?? null },
  group_id: item.group_id,
  duration_ms: item.duration_ms ?? null,
  audio_available: audioAvailableOf(item),
  source_kind: sourceKindOf(item),
});

export class RecordGroups {
  constructor({
    root: rawRoot,
    archive,
    groupSize = GROUP_SIZE,
    now = () => Date.now(),
    onChange = () => {},
  }) {
    // ⚠ 一律解析成绝对路径。item 里记的 `wav_path` 会被 ASR 读、被诊断显示、被归档引用——
    // 存一条相对路径意味着「只有从当时那个 cwd 才找得到它」，而那个前提迟早不成立
    // （真机上就出现过：记录说 wav_available=true，而从别的目录看过去文件根本不存在）。
    const root = path.resolve(rawRoot);
    this.root = root;
    this.archive = archive;
    this.groupSize = Math.max(1, Number(groupSize) || GROUP_SIZE);
    this.now = now;
    this.onChange = onChange;
    this.stateFile = path.join(root, 'state.v1.json');
    this.state = readJson(this.stateFile) ?? {
      schema: STATE_SCHEMA,
      next_group_seq: 1,
      next_feed_seq: 0,
      active_group_id: null,
      groups: [],
    };
    if (this.state.schema !== STATE_SCHEMA) {
      // ⚠ 认不出的 schema 明确报错，不当成空目录重来——那会把已有记录变成孤儿。
      throw new Error(`unrecognised records state schema: ${this.state.schema}`);
    }
    this.lastRotation = null;
    this.lastError = null;
    /**
     * ⭐ **最新的那一句**，两条处理门共用的唯一来源。
     *
     * ⚠ 概览页曾读记录组、诊断页读 `asr.transcripts.last`（那是 **SenseVoice 控制器**
     *   自己的最后一条）——于是选另一个 backend 时诊断页永远显示「尚未产生转写」，而句子
     *   正在一条条落库。两个页面问的是同一个问题，就必须读同一个字段。
     */
    this.lastSentence = null;
    /** 被「音频区间已提交」判据挡掉的次数。⛔ 静默丢弃 = 查不出来的丢弃。 */
    this.suppressedDuplicates = 0;
    this.lastSuppressed = null;
    /**
     * ⭐ transcript feed 的游标（docs/061 §七）。
     *
     * ⚠ **必须比旧 feed 的游标大**，否则换存储这件事会静默地废掉两个消费者。
     * 旧 feed 的 `seq` 是从 1 开始的行号（真机上已到 3200）；`termux-ime` 与
     * `termux-interpreter` 都把游标持久化，并且只认「比我手上大的」——重新从 1 编号，
     * 它们会永远读到 0 条、永远不报错（`undefined ?? []` 与「没人说话」型别相同，
     * docs/056 的同一形状）。
     * 故游标取**毫秒时刻**：天然单调、天然远大于任何旧行号，且重启后仍然递增。
     */
    this.state.next_feed_seq = Math.max(
      Number(this.state.next_feed_seq) || 0,
      this.now(),
    );
  }

  nextFeedSeq() {
    const next = Math.max(Number(this.state.next_feed_seq) || 0, this.now()) + 1;
    this.state.next_feed_seq = next;
    return next;
  }

  groupDir(groupId) { return path.join(this.root, groupId); }
  itemsFile(groupId) { return path.join(this.groupDir(groupId), 'items.v1.json'); }

  readItems(groupId) { return readJson(this.itemsFile(groupId)) ?? []; }

  writeItems(groupId, items) { atomicWrite(this.itemsFile(groupId), items); }

  persist() { atomicWrite(this.stateFile, this.state); }

  group(groupId) { return this.state.groups.find((item) => item.group_id === groupId) ?? null; }

  activeGroup() {
    return this.state.active_group_id ? this.group(this.state.active_group_id) : null;
  }

  /**
   * 启动恢复（§七.5）。**只看两样看得见的事实**：目录在不在，SQLite 里有没有那一行。
   * 与 docs/051 同一条原则——不写「崩溃恢复」分支，冷启与崩溃后走同一条路径。
   */
  reconcile() {
    const notes = [];
    for (const group of [...this.state.groups]) {
      const dirExists = fs.existsSync(this.groupDir(group.group_id));
      const archived = this.archive?.isArchived(group.group_id) === true;
      if (archived && dirExists) {
        // commit 之后、删除之前崩过：唯一键保证不会重复，继续把删除做完。
        this.removeGroupDir(group.group_id);
        group.state = 'archived';
        notes.push(`${group.group_id}: resumed delete after commit`);
      } else if (archived && !dirExists) {
        if (group.state !== 'archived') notes.push(`${group.group_id}: state caught up to archive`);
        group.state = 'archived';
      } else if (!dirExists && group.state !== 'archived') {
        // 目录没了但没归档：这不是我们做的，如实标记而不是假装它归档过。
        group.state = 'lost';
        notes.push(`${group.group_id}: directory missing without an archive row`);
      }
    }
    // ⭐ 这里曾经有一段「把没结完的 pending item 判为失败」。它随准入后移一起消失了：
    // item 只在有结论时才写下来，所以盘上不可能存在一个没有结论的 item。
    // 还没转写完的段这时候还在 ASR 自己的持久队列里，重启后照常继续。
    for (const group of this.state.groups) {
      if (group.state === 'archived' || group.state === 'lost') continue;
      this.refreshGroup(group);
    }
    this.state.groups = this.state.groups.filter((group) => group.state !== 'lost' || true);
    this.hydrateLastSentence();
    this.persist();
    void this.rotate();
    return { notes, snapshot: this.snapshot() };
  }

  /**
   * ⭐ **一个 commit = 一个句子**（docs/075 §8）。「50 句」数的是**句子**，不是 item。
   *
   * ⚠ 失败的 item 仍然要留在组里（它是这一段音频的结论），但它**不是一句话**——
   *   把它算进 50，一组里就可能只有 43 句真话，而这一组存在的理由正是「50 句上下文」。
   *   两个数分开：`item_count` 是盘上有几条，`sentence_count` 是这组有几句。
   */
  sentencesIn(items) {
    return items.filter((item) => item.status === 'succeeded').length;
  }

  refreshGroup(group, items = this.readItems(group.group_id)) {
    group.item_count = items.length;
    group.sentence_count = this.sentencesIn(items);
    // 每个 item 写下去就是终态，故「已终结几条」恒等于「有几条」，不再单独记。
    if (group.state === 'archived' || group.state === 'lost') return group;
    const full = group.sentence_count >= this.groupSize;
    if (full) {
      if (group.state !== 'completed') {
        group.state = 'completed';
        group.completed_at = new Date(this.now()).toISOString();
      }
    } else {
      group.state = group.group_id === this.state.active_group_id ? 'active' : 'filling';
    }
    return group;
  }

  openGroup() {
    const seq = this.state.next_group_seq;
    const groupId = groupIdFor(seq);
    this.state.next_group_seq = seq + 1;
    const group = {
      group_id: groupId,
      group_seq: seq,
      state: 'active',
      item_count: 0,
      sentence_count: 0,
      created_at: new Date(this.now()).toISOString(),
      completed_at: null,
    };
    fs.mkdirSync(this.groupDir(groupId), { recursive: true });
    this.writeItems(groupId, []);
    this.state.groups.push(group);
    this.state.active_group_id = groupId;
    return group;
  }

  /**
   * ⭐ 准入一个**已经有结论**的段。item 写下去就是终态，所以没有 `pending`、
   * 没有回滚、没有「崩在中间复活一条空白」。
   *
   * WAV 从 staging **移动**进本组目录：记录组从此是它唯一的所有者，
   * 于是「删除该组的目录」就真的把这一组的音频删干净了，不会有别处的副本悄悄留着。
   *
   * ⛔ 调用方必须已经判过空白（[normalizeTranscript]）。这里不再替它判——
   * 判断只能有一个地方，两个地方迟早给出两个答案。
   */
  admit(segment, outcome = {}) {
    const segmentId = String(segment?.segment_id ?? '');
    if (!segmentId) throw new Error('record item requires a segment_id');
    const succeeded = outcome.status === 'succeeded';
    let group = this.activeGroup();
    // ⚠ 从盘上现算，不信内存里那个字段：它可能是旧版状态文件里根本没有的东西，
    //   而「组满了没有」错一次就会有第 51 句挤进上一组。
    if (group && this.sentencesIn(this.readItems(group.group_id)) >= this.groupSize) group = null;
    if (!group) group = this.openGroup();
    const items = this.readItems(group.group_id);
    if (items.some((item) => item.segment_id === segmentId)) {
      return { admitted: false, reason: 'duplicate_segment', segment_id: segmentId };
    }
    const covered = this.#alreadyCommittedWindow(segment);
    if (covered) {
      this.suppressedDuplicates += 1;
      this.lastSuppressed = {
        segment_id: segmentId,
        covered_by: covered.segment_id,
        start_ms: segment.start_ms ?? null,
        end_ms: segment.end_ms ?? null,
        at: new Date(this.now()).toISOString(),
      };
      return { admitted: false, reason: 'audio_window_already_committed', segment_id: segmentId,
        covered_by: covered.segment_id };
    }
    const appOwned = segment.source_kind === 'app_segment' || segment.source === 'app_segment';
    const wavPath = path.join(this.groupDir(group.group_id), `${segmentId}.wav`);
    let wavAvailable = false;
    if (!appOwned) {
      try {
        if (segment.wav_path && fs.existsSync(segment.wav_path)) {
          fs.renameSync(segment.wav_path, wavPath);
          wavAvailable = true;
        }
      } catch (error) {
        this.lastError = `wav move failed: ${String(error?.message ?? error)}`;
      }
    }
    /**
     * ⭐ **App 段落的音频「在不在」是由结构保证的，⛔ 不是 admit 那一刻的一张快照。**
     *
     * 判据链是硬的：这条 item 在**活组**里（`recent`/`find` 只读活组），
     * 而活组最多两组 = 100 句（过渡期 150），App 侧的上限 `history.wav_keep`
     * 默认 200 **高于**那个天花板 ⇒ 只要它还出现在列表里，App 那边就还有它。
     * 一组被归档时它就整组从活组消失，⛔ 根本不会被显示。
     *
     * ⚠ 存快照的后果两个方向都发生过：`archive_wav` 还没写好就 admit ⇒
     * 一条**刚转写完**的句子显示「音频已过期」；反过来存了 true 又被淘汰 ⇒
     * 一个必然 404 的播放器。**一个由别人拥有的事实，不要在自己这边存一份副本。**
     */
    const audioAvailable = appOwned ? true : wavAvailable;
    const sourceKind = segment.source_kind ?? (appOwned ? 'app_segment' : null);
    const item = {
      schema: ITEM_SCHEMA,
      segment_id: segmentId,
      group_id: group.group_id,
      item_seq: items.length + 1,
      status: succeeded ? 'succeeded' : 'failed',
      wav_path: wavAvailable ? wavPath : null,
      wav_available: wavAvailable,
      audio_available: audioAvailable,
      audio_source: appOwned ? 'app' : wavAvailable ? 'speech' : null,
      source_kind: sourceKind,
      segment_start_ms: segment.start_ms ?? null,
      segment_end_ms: segment.end_ms ?? null,
      duration_ms: segment.duration_ms ?? null,
      text: succeeded ? (outcome.text ?? '') : null,
      model: outcome.model ?? null,
      /**
       * 这一句是哪条处理门产出的。⚠ 与 `model` 分开：`model` 是权重的名字，
       * `backend` 是那扇门的名字——同一组里两条门混着是允许的（docs/075 §9），
       * 而「这一组是怎么来的」只有逐句记下来才答得出。
       */
      backend: outcome.backend ?? null,
      inference_ms: outcome.inference_ms ?? null,
      // ⚠ 「本该有 WAV 却没拿到」才是错误。听写链（docs/065）的 PCM 从不离开 App，
      //    它本来就没有 WAV——把那当成错误会让每一条正常的听写记录都带着一句假报警。
      error: outcome.error
        ?? (!appOwned && segment.wav_path && !wavAvailable ? 'WAV was not available at admit time' : null),
      source: outcome.source ?? 'segment',
      /**
       * 生产者自带的元数据（SPEECH17：Speech2 的 speaker_role/scene/revision/身份）。
       * ⭐ 原样透传，本模块⛔ 不解释——「这一句是谁说的」属于生产者，不属于记录组。
       */
      meta: outcome.meta ?? null,
      created_at: new Date(this.now()).toISOString(),
      completed_at: new Date(this.now()).toISOString(),
    };
    // feed 只发成功的句子；失败的 item 仍然记录在案，但不占游标。
    if (succeeded) {
      item.feed_seq = this.nextFeedSeq();
      item.utterance_id = outcome.utterance_id ?? null;
      item.language = outcome.language ?? null;
      item.observed_ms = outcome.observed_ms ?? this.now();
    }
    items.push(item);
    if (succeeded) this.lastSentence = this.sentenceView(item);
    this.writeItems(group.group_id, items);
    this.refreshGroup(group, items);
    this.persist();
    this.onChange();
    void this.rotate();
    return { admitted: true, item, group_id: group.group_id, wav_path: item.wav_path };
  }

  /**
   * 重转写一条**已经在组里**的记录（`/asr/transcribe`）。
   *
   * ⛔ 与 [admit] 是两个操作，刻意不合并：这里跨全部活组找原来那一条并就地更新，
   * **绝不新建 item、绝不移动或删除 WAV、绝不改 `feed_seq`**。
   * 用 `admit` 走这条路会在当前组再建一条重复记录，而那份 WAV 已经归属于原记录了。
   */
  retranscribe(segmentId, outcome = {}) {
    const id = String(segmentId ?? '');
    for (const group of this.liveGroups()) {
      const items = this.readItems(group.group_id);
      const item = items.find((entry) => entry.segment_id === id);
      if (!item) continue;
      item.status = outcome.status === 'succeeded' ? 'succeeded' : 'failed';
      item.text = outcome.status === 'succeeded' ? (outcome.text ?? '') : item.text;
      item.model = outcome.model ?? item.model;
      item.backend = outcome.backend ?? item.backend;
      item.inference_ms = outcome.inference_ms ?? item.inference_ms;
      item.error = outcome.error ?? null;
      if (outcome.meta !== undefined) item.meta = outcome.meta;
      item.completed_at = new Date(this.now()).toISOString();
      /**
       * ⭐ **「最近识别」要跟着改写走**（docs/091 §使用者反馈④）。
       * ⚠ 这里原本不动 `lastSentence`：于是 A+B 的 B 定稿之后，页面上那一行仍然是
       *   上一句——内容明明更新了，显示却停在旧的，看起来像「没有提交」。
       * ⛔ 但游标（`feed_seq`）仍然不动：重转写改的是同一句话的内容，不是一句新话，
       *   重新发号会让每个持久化游标的消费者把它当成新句子再读一遍。
       */
      if (item.status === 'succeeded') this.lastSentence = this.sentenceView(item);
      this.writeItems(group.group_id, items);
      this.refreshGroup(group, items);
      this.persist();
      this.onChange();
      return { updated: true, group_id: group.group_id, item_seq: item.item_seq };
    }
    return { updated: false, reason: 'unknown_segment' };
  }

  /** 一句话的对外形状。⚠ 只有一个构造处，页面与 API 不会各拼一份。 */
  sentenceView(item) {
    if (!item) return null;
    return {
      text: item.text ?? '',
      backend: item.backend ?? null,
      model: item.model ?? null,
      group_id: item.group_id,
      item_seq: item.item_seq,
      feed_seq: item.feed_seq ?? null,
      inference_ms: item.inference_ms ?? null,
      /**
       * ⭐ **原音频时长**。item 上一直有它，而这个投影把它丢了——
       * 于是概览那行「原音频 => 推理 | 倍速」永远算不出来，只能退化成一个推理毫秒数。
       * ⚠ 少一个字段不会报错：`undefined` 与「这条记录没有音频」在下游长得一样。
       */
      duration_ms: item.duration_ms ?? null,
      audio_available: audioAvailableOf(item),
      audio_source: item.audio_source ?? null,
      source_kind: sourceKindOf(item),
      segment_id: item.segment_id ?? null,
      meta: item.meta ?? null,
      at_ms: Date.parse(item.completed_at) || null,
    };
  }

  /** 启动时把它从盘上补回来：重启不该让「最新一句」变成「还没说过话」。 */
  hydrateLastSentence() {
    for (const group of [...this.liveGroups()].reverse()) {
      const items = this.readItems(group.group_id);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].status === 'succeeded') {
          this.lastSentence = this.sentenceView(items[i]);
          return this.lastSentence;
        }
      }
    }
    return null;
  }

  /** 盘上还留着的组（未归档、未丢失），按序号升序。 */
  liveGroups() {
    return this.state.groups
      .filter((group) => group.state !== 'archived' && group.state !== 'lost')
      .sort((a, b) => a.group_seq - b.group_seq);
  }

  /**
   * 轮转。⛔ 顺序是硬的：commit 成功之前一个 WAV 都不许删。
   * 归档只对**全部终态**的完成组做——还有 item 没转写完就归档，等于把不知道的结论写进库。
   */
  async rotate() {
    const live = this.liveGroups();
    if (live.length <= 2) return null;
    const oldest = live[0];
    const items = this.readItems(oldest.group_id);
    if (oldest.state !== 'completed') {
      // 允许短暂出现三组：最旧那组还没收满，等它满了再转。
      this.lastRotation = { skipped: oldest.group_id, reason: 'not_completed', at_ms: this.now() };
      return this.lastRotation;
    }
    if (!this.archive || !(await this.archive.open())) {
      this.lastRotation = {
        skipped: oldest.group_id,
        reason: 'archive_unavailable',
        error: this.archive?.lastError ?? 'no archive',
        at_ms: this.now(),
      };
      return this.lastRotation;
    }
    const committed = this.archive.archiveGroup(oldest, items);
    if (!committed.ok) {
      // ⛔ commit 失败 = 一个 WAV 都不删。下一轮再试。
      this.lastRotation = { skipped: oldest.group_id, ...committed, at_ms: this.now() };
      return this.lastRotation;
    }
    oldest.state = 'archived';
    oldest.archived_at = new Date(this.now()).toISOString();
    oldest.archived_rows = committed.rows;
    this.persist();
    const removed = this.removeGroupDir(oldest.group_id);
    this.persist();
    this.lastRotation = {
      archived: oldest.group_id, rows: committed.rows, removed_files: removed, at_ms: this.now(),
    };
    this.onChange();
    return this.lastRotation;
  }

  removeGroupDir(groupId) {
    const dir = this.groupDir(groupId);
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.wav')) removed += 1;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 已经不在了。 */ }
    return removed;
  }

  /**
   * ⭐ **同一段音频不许变成两条句子**（docs/097 §十九）。
   *
   * 判据是**音频区间的包含关系**，⛔ 不是「文字长得一样」——后者会把一个人
   * 真的说了两遍的同一句话删掉一条，而那是使用者的数据。
   *
   * 真机实录（boundary journal seq 429–438）：seg-159 在 rev2 定稿并关段之后，
   * 同一个 candidate 27 的 `full_shutter` 又来了；此时 coordinator 里没有活动段落，
   * 于是它**用那个 candidate 的 effective onset 重新开了 seg-160**，
   * 区间与 seg-159 逐毫秒相同（34081076..34089876），转出来的字自然一模一样。
   * ⇒ 根因在 App 的 [SegmentCoordinator]（见报告），这里是**记录层的兜底**：
   *   一段已经被完整提交过的音频，不该因为被转写第二次而在历史里多出一行。
   *
   * ⚠ 三条收紧，缺一不可：
   *   ① 只看**最近几条**（重开总是在几秒内发生）；
   *   ② 两条都必须带完整区间；
   *   ③ 参照那条必须是**刚刚**落库的——单调时钟会在重启/换代时归零，
   *      不限时间窗的话，重启前的一条长记录能"包含"重启后的一条新记录。
   */
  #alreadyCommittedWindow(segment) {
    const start = Number(segment?.start_ms);
    const end = Number(segment?.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const nowMs = this.now();
    let seen = 0;
    for (const group of [...this.liveGroups()].reverse()) {
      for (const item of this.readItems(group.group_id).reverse()) {
        if (seen >= DUPLICATE_WINDOW_LOOKBACK) return null;
        seen += 1;
        if (item.status !== 'succeeded') continue;
        const at = Date.parse(item.completed_at ?? item.created_at ?? '');
        if (!Number.isFinite(at) || nowMs - at > DUPLICATE_WINDOW_MAX_AGE_MS) return null;
        const prevStart = Number(item.segment_start_ms);
        const prevEnd = Number(item.segment_end_ms);
        if (!Number.isFinite(prevStart) || !Number.isFinite(prevEnd)) continue;
        if (prevStart <= start && prevEnd >= end) return item;
      }
    }
    return null;
  }

  /**
   * 按 segment_id 找一条记录，**跨全部活组**。
   *
   * ⚠ 不要用 `recent()` 代替它。`recent` 是一个**显示用**的窗口（上限 50 条），
   * 而当前组一满 50 条就把整个窗口占满，于是上一组的段一条都够不到——
   * `/asr/transcribe` 因此对着盘上明明存在的 WAV 报 `record item with WAV not found`。
   * 「最近 N 条」与「按 id 查一条」是两个问题，用前者回答后者，
   * 答案会随着当前组的进度悄悄改变。
   */
  find(segmentId) {
    const id = String(segmentId ?? '');
    if (!id) return null;
    for (const group of [...this.liveGroups()].reverse()) {
      const item = this.readItems(group.group_id).find((entry) => entry.segment_id === id);
      if (item) return item;
    }
    return null;
  }

  /** 最近 N 条转写：只从**新机制**里读，绝不混入旧 JSONL。 */
  recent(limit = 10) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 10));
    const rows = [];
    for (const group of [...this.liveGroups()].reverse()) {
      for (const item of this.readItems(group.group_id).reverse()) {
        rows.push(this.#withLiveAudio(item));
        if (rows.length >= bounded) return rows;
      }
    }
    return rows;
  }

  /**
   * 读取时补上 App 段落的音频可用性。⭐ 同 [admit] 的理由：它是结构保证的。
   * ⚠ 这一步也**修好了老记录**——admit 时序修复之前落库的那些带着 `false`，
   *   而它们的音频其实一直都在。⛔ 不去改盘上的旧数据：那是历史，改它才是错的。
   */
  #withLiveAudio(item) {
    if (item?.source_kind !== 'app_segment' || item.audio_available === true) return item;
    return { ...item, audio_available: true, audio_source: 'app' };
  }

  /**
   * transcript feed（`speech.transcript` Capability 的落地）。
   * ⚠ 语义必须与旧 feed 逐字一致：`filter(seq > after).slice(0, limit)` 升序，
   * 游标是顶层 `next`。`termux-ime` 与 `termux-interpreter` 都按这个约定写的。
   */
  feed(after = 0, limit = 100) {
    const cursor = Math.max(0, Number(after) || 0);
    const maximum = Math.max(1, Math.min(200, Number(limit) || 100));
    const rows = [];
    for (const group of this.liveGroups()) {
      for (const item of this.readItems(group.group_id)) {
        if (item.status !== 'succeeded') continue;
        const seq = Number(item.feed_seq) || 0;
        if (seq <= cursor) continue;
        rows.push(feedRecord(item, seq));
      }
    }
    rows.sort((a, b) => a.seq - b.seq);
    const observations = rows.slice(0, maximum);
    return {
      schema: 'termux-os.speech-transcript-feed.v1',
      observations,
      next: observations.at(-1)?.seq ?? cursor,
    };
  }

  snapshot() {
    const live = this.liveGroups();
    const active = this.activeGroup();
    return {
      schema: 'termux-os.speech-records.v1',
      root: this.root,
      group_size: this.groupSize,
      active: active ? {
        group_id: active.group_id,
        group_seq: active.group_seq,
        progress: `${active.sentence_count ?? 0}/${this.groupSize}`,
        sentence_count: active.sentence_count ?? 0,
        item_count: active.item_count,
      } : null,
      // ⚠ 只报「盘上还有哪两组」，**不报全生命周期累计** —— 那正是这一轮要拿掉的东西。
      groups: live.slice(-2).map((group) => ({
        group_id: group.group_id,
        group_seq: group.group_seq,
        state: group.state,
        item_count: group.item_count,
        sentence_count: group.sentence_count ?? 0,
        created_at: group.created_at,
        completed_at: group.completed_at,
        wav_available: true,
      })),
      groups_on_disk: live.length,
      last_rotation: this.lastRotation,
      archive: this.archive?.stats() ?? null,
      /** ⭐ 被「音频区间已提交」挡掉的重复。看得见的重复只是待办，看不见的才是债。 */
      suppressed_duplicates: this.suppressedDuplicates ?? 0,
      last_suppressed: this.lastSuppressed ?? null,
      last_error: this.lastError,
    };
  }
}

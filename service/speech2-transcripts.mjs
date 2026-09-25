/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App 的 Speech2 transcript 读取面 `GET /api/speech2/transcripts?after_seq=`（权威）
 *          + AppEvents 帧里的 `transcript` 紧凑事实（只作唤醒）
 * [OUTPUT]: 对外提供 Speech2Transcripts —— live（provisional 可被替换）与 history（final 恰好一次）
 * [POS]: CP-SPEECH2-TERMUX-SPEECH17 §7–§16。⭐ 一句话：**App 决定「这一句的哪一版是什么」，
 *        本包决定「它在产品里怎么呈现、何时进历史」。** ⛔ 本模块不认识 CAM/VAD/FSM/ASR。
 *
 * ⭐ **两层身份不许合并**（SPEECH2_TERMUX_SPEECH_CONTRACT §1）：
 *   transport `boot_id + seq` 只回答「漏没漏、重没重」（游标）；
 *   业务 `generation + segment_id + revision` 回答「哪一句的哪一版」（live 替换）。
 *   ⭐ history 的键是 `boot_id + generation + segment_id` —— App 重生后 generation/segment_id
 *   会从头数（docs/091 那条：一个身份的唯一性范围必须覆盖引用它的那份数据的寿命）。
 * ⭐ **推送不可靠 ⇒ 权威在读取面**：AppEvents 队列满丢最旧，所以帧只用来「叫醒」，
 *   真正的数据一律走 `after_seq` 回填；再加一个低频兜底同步（⛔ 不是轮询主流程）。
 * ⭐ **游标落盘**（数据目录，⛔ 不在包版本目录）：termux-speech 重启 / 升级后从上次的
 *   `(boot_id, seq)` 接着读 ⇒ final 不丢；history 按键去重 ⇒ final 不重。
 * ⭐ **boot_id 变了 ⇒ 新的 transport 纪元**：游标归零，旧 seq ⛔ 不与新 boot 混着去重。
 * ⭐ defensive（§12）：stale（revision 倒退）/ blank / error ⛔ 不当正常 transcript。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md 与 public-files.txt
 */
import fs from 'node:fs';
import path from 'node:path';

export const SPEECH2_TRANSCRIPT_SCHEMA = 'termux-os.speech2-transcript.v1';
const CURSOR_SCHEMA = 'termux-os.speech2-transcript-cursor.v1';
const LIVE_LIMIT = 12;
const PAGE_LIMIT = 256;

export const historyKey = (bootId, e) => `s2:${bootId}:${e.generation}:${e.segment_id}`;
/** ⭐ live 的键不含 boot（同一 boot 内唯一即可），history 的键含 boot。 */
export const liveKey = (bootId, e) => `${bootId}:${e.generation}:${e.segment_id}`;

const isBlank = (text) => !String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

export class Speech2Transcripts {
  /**
   * @param fetchSince  `(afterSeq, limit) => Promise<{boot_id, events, truncated, ...}>`
   * @param onFinal     `(event, key) => {admitted:boolean}` 把 final 写进 history（恰好一次）
   * @param hasFinal    `(key) => boolean` history 里是否已有这一句（重启后的去重权威）
   * @param cursorFile  游标文件（数据目录）
   */
  constructor({
    fetchSince,
    onFinal = () => ({ admitted: true }),
    hasFinal = () => false,
    onChange = () => {},
    cursorFile = null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    safetyIntervalMs = 10_000,
  }) {
    this.fetchSince = fetchSince;
    this.onFinal = onFinal;
    this.hasFinal = hasFinal;
    this.onChange = onChange;
    this.cursorFile = cursorFile;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.safetyIntervalMs = safetyIntervalMs;

    this.bootId = null;
    this.afterSeq = 0;
    this.live = new Map();           // liveKey -> view
    this.syncing = false;
    this.syncAgain = false;
    this.timer = null;
    this.safetyTimer = null;
    this.lastSyncAtMs = null;
    this.lastError = null;
    this.available = null;           // App Speech2 读取面可达吗（null = 还没问过）
    this.counters = {
      events_seen: 0, provisional: 0, finals_admitted: 0, finals_duplicate: 0,
      revision_replaced: 0, suppressed_stale: 0, suppressed_blank: 0, suppressed_error: 0,
      boot_changes: 0, truncated_gaps: 0, syncs: 0, sync_errors: 0, wakes: 0, cursor_writes: 0,
    };
    /** ⭐ WEBUI18：wake 按来源计数——「为什么一直在同步」必须答得出来。 */
    this.wakesByReason = Object.create(null);
    /** 上一次落盘的游标。⭐ 没变就不写：游标在 /sdcard，每次 tmp+rename 都会惊动 MediaProvider。 */
    this.savedCursor = null;
    this.#loadCursor();
  }

  #loadCursor() {
    if (!this.cursorFile) return;
    try {
      const c = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'));
      if (c?.schema === CURSOR_SCHEMA && typeof c.boot_id === 'string') {
        this.bootId = c.boot_id;
        this.afterSeq = Math.max(0, Number(c.after_seq) || 0);
        this.savedCursor = `${this.bootId}:${this.afterSeq}`;
      }
    } catch { /* 没有游标 = 从头读；history 的键去重保证不会重复 */ }
  }

  #saveCursor() {
    if (!this.cursorFile) return;
    const cursor = `${this.bootId}:${this.afterSeq}`;
    // ⚠ 真机（WEBUI18）：无新事件时每秒仍重写一次 → MediaProvider 日志被 rename 警告刷屏。
    if (cursor === this.savedCursor) return;
    try {
      fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
      const tmp = `${this.cursorFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: CURSOR_SCHEMA, boot_id: this.bootId, after_seq: this.afterSeq }));
      fs.renameSync(tmp, this.cursorFile);
      this.savedCursor = cursor;
      this.counters.cursor_writes += 1;
    } catch (error) {
      this.lastError = `cursor write failed: ${String(error?.message ?? error)}`;
    }
  }

  /**
   * ⭐ 幂等（WEBUI18 真机抓到）：`refresh()` 每 2 s 调一次 `start()`，而旧实现每调一次就多挂一条
   *   10 s 的兜底链且从不清理 ⇒ 几小时后每秒都有几十次同步（真机 `wakes_by_reason.start=72`）。
   */
  start() {
    if (this.safetyTimer !== null) return;
    this.wake('start');
    const tick = () => {
      this.safetyTimer = this.setTimer(() => { this.wake('safety'); tick(); }, this.safetyIntervalMs);
    };
    tick();
  }

  close() {
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.safetyTimer !== null) this.clearTimer(this.safetyTimer);
    this.timer = null; this.safetyTimer = null;
  }

  /** AppEvents 帧里的 `transcript` 域。⭐ 只作唤醒：seq 比游标新（或 boot 变了）才去读。 */
  observe(fact, frameBootId = null) {
    if (!fact || typeof fact !== 'object') return;
    // ⭐ 事实可能是紧凑事实（`transcript_write_seq`/`latest`）或事件本身（`seq`）。
    // ⚠ ⛔ 不拿 AppEvents 帧的 boot_id 顶替：那是另一条总线的纪元，与 transcript 的 boot 不同
    //   ⇒ 每一帧都会被当成「新纪元」而触发一次同步。
    const writeSeq = Number(fact.transcript_write_seq ?? fact.latest?.seq ?? fact.seq ?? 0);
    const boot = fact.boot_id ?? fact.latest?.boot_id ?? null;
    void frameBootId;
    if ((boot && boot !== this.bootId) || writeSeq > this.afterSeq) this.wake('event');
  }

  wake(reason = 'event') {
    // ⚠ 只数**真正排上的**同步：AppEvents 每帧都带 transcript 事实，连同已排队的调用一起数，
    //   计数器会以帧率增长，读起来像「每秒几十次回填」。
    if (this.timer !== null) return;
    this.counters.wakes += 1;
    this.wakesByReason[reason] = (this.wakesByReason[reason] ?? 0) + 1;
    this.timer = this.setTimer(() => { this.timer = null; void this.sync(reason); }, reason === 'event' ? 30 : 0);
  }

  /** 一次同步：把 `after_seq` 之后的全部事件读完（分页），逐条应用。 */
  async sync(reason = 'manual') {
    if (this.syncing) { this.syncAgain = true; return; }
    this.syncing = true;
    try {
      for (let page = 0; page < 64; page += 1) {
        let r;
        try {
          r = await this.fetchSince(this.afterSeq, PAGE_LIMIT);
        } catch (error) {
          this.available = false;
          this.counters.sync_errors += 1;
          this.lastError = String(error?.message ?? error);
          break;
        }
        this.available = true;
        this.lastError = null;
        const boot = typeof r?.boot_id === 'string' ? r.boot_id : null;
        if (!boot) break;
        if (boot !== this.bootId) {
          // ⭐ 新纪元：旧 seq 属于「另一个世界的编号」，⛔ 不拿来去重。
          if (this.bootId !== null) this.counters.boot_changes += 1;
          this.bootId = boot;
          this.afterSeq = 0;
          this.live.clear();
          this.#saveCursor();
          continue;  // 用新纪元的游标重新读
        }
        if (r.truncated === true) {
          // ⭐ 读取面明说「你要的那一段已经不在了」⇒ 记下缺口，用 latest_per_segment 恢复 live。
          this.counters.truncated_gaps += 1;
          for (const e of r.latest_per_segment ?? []) this.#apply(e, { replay: true });
        }
        const events = Array.isArray(r.events) ? r.events : [];
        for (const e of events) {
          this.#apply(e);
          const seq = Number(e?.seq) || 0;
          if (seq > this.afterSeq) this.afterSeq = seq;
        }
        this.#saveCursor();
        if (events.length < PAGE_LIMIT) break;
      }
      this.counters.syncs += 1;
      this.lastSyncAtMs = this.now();
      this.lastSyncReason = reason;
    } finally {
      this.syncing = false;
      this.onChange();
      if (this.syncAgain) { this.syncAgain = false; this.wake('coalesced'); }
    }
  }

  #apply(e, { replay = false } = {}) {
    if (!e || typeof e !== 'object') return;
    if (!replay) this.counters.events_seen += 1;
    if (e.error || e.error_kind) { this.counters.suppressed_error += 1; return; }
    if (isBlank(e.text)) { this.counters.suppressed_blank += 1; return; }
    const lk = liveKey(this.bootId, e);
    const prev = this.live.get(lk);
    const revision = Number(e.revision) || 0;
    if (prev) {
      // ⭐ stale：同一句的旧版本推出去会让界面文字**倒退**。
      if (revision < prev.revision || (revision === prev.revision && prev.complete && !e.complete)) {
        this.counters.suppressed_stale += 1;
        return;
      }
      if (revision > prev.revision) this.counters.revision_replaced += 1;
    }
    const view = {
      key: lk,
      boot_id: this.bootId,
      seq: Number(e.seq) || 0,
      generation: e.generation,
      segment_id: e.segment_id,
      revision,
      complete: e.complete === true,
      text: String(e.text),
      speaker_role: e.speaker_role ?? null,
      enrollment_id: e.matched === true ? e.enrollment_id ?? null : null,
      voice_name: e.matched === true && e.voice_name ? String(e.voice_name) : 'Other',
      cosine: e.cosine !== null && e.cosine !== undefined && Number.isFinite(Number(e.cosine))
        ? Number(e.cosine) : null,
      matched: e.matched === true,
      scene_policy_id: e.scene_policy_id ?? null,
      logical_ms: e.logical_ms ?? null,
      updated_at_ms: this.now(),
      history: null,
    };
    if (view.complete) {
      const hk = historyKey(this.bootId, e);
      if (this.hasFinal(hk)) {
        this.counters.finals_duplicate += 1;
        view.history = 'already_recorded';
      } else {
        const r = this.onFinal(e, hk) ?? {};
        if (r.admitted === false) { this.counters.finals_duplicate += 1; view.history = r.reason ?? 'not_admitted'; }
        else { this.counters.finals_admitted += 1; view.history = 'recorded'; }
      }
    } else {
      this.counters.provisional += 1;
    }
    this.live.delete(lk);          // 重新插入 ⇒ Map 顺序即「最近更新」顺序
    this.live.set(lk, view);
    while (this.live.size > LIVE_LIMIT) this.live.delete(this.live.keys().next().value);
  }

  /** ⭐ 当前正在变化的那一句（最近更新且未完成）；没有就是 null。 */
  current() {
    const all = [...this.live.values()];
    for (let i = all.length - 1; i >= 0; i -= 1) if (!all[i].complete) return all[i];
    return null;
  }

  snapshot() {
    return {
      schema: SPEECH2_TRANSCRIPT_SCHEMA,
      available: this.available,
      boot_id: this.bootId,
      after_seq: this.afterSeq,
      current: this.current(),
      live: [...this.live.values()].reverse(),
      last_sync_at_ms: this.lastSyncAtMs,
      last_error: this.lastError,
      counters: { ...this.counters },
      wakes_by_reason: { ...this.wakesByReason },
    };
  }
}

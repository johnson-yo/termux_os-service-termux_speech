/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: App 的 `segment` 低频事实（AppEvents）+ `/api/audio/segment/results` 回填
 * [OUTPUT]: 对外提供 AppSegments —— 把 App 的 provisional/final **upsert** 成产品句子
 * [POS]: docs/140（承接 docs/088 P4）。⭐ 一句话：**App 决定「这一句到哪为止、文字是什么」，
 *        本包决定「它在产品里怎么呈现、进哪一组」。**
 *
 * ⭐ **upsert 不是 append。** A（revision 1，未完成）与 B（revision 2，最终）是
 *   **同一句话的两次交付**：产品里只能留下一条。
 *   ⚠ 实现上分两层：provisional 只进 `publicState`（页面即时可见），
 *   **只有 complete 才进 records**；而 complete 到达时先 `find(segment_id)`——
 *   已经在组里就**就地更新**，⛔ 不新建一条。
 *   ⇒ 于是「A 出一次、B 又新增一次」在结构上不可能发生，而不是靠调用方记得去去重。
 * ⚠ exactly-once 的判据是**递增的 `results_seq`**，⛔ 不是 `segment_id`：
 *   同一句合法地会来两次（A 与 B），而事件总线也允许重复推送——
 *   只有序号能同时回答「这是新的一条吗」与「我有没有漏掉中间那几条」。
 * ⛔ 本模块不认识 PCM、不认识 WAV bytes、不 enqueue 任何模型：
 *   自动模式的 ASR 已经在 App 里跑完了。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export class AppSegments {
  /**
   * @param android    App API 客户端（只用于回填）
   * @param onResult   `(result) => void` 交给产品层（publicState / records）
   */
  constructor({ android, onResult = () => {}, onChange = () => {}, now = () => Date.now() }) {
    this.android = android;
    this.onResult = onResult;
    this.onChange = onChange;
    this.now = now;

    this.bootId = null;
    this.lastSeq = 0;
    this.provisionals = 0;
    this.finals = 0;
    this.duplicates = 0;
    this.backfilled = 0;
    this.ghostAvoided = 0;
    this.blankSuppressed = 0;
    this.lastError = null;
    this.lastFacts = null;
    this.backfillInFlight = false;
  }

  /** AppEvents 帧里的 `segment` 域。⛔ exactly-once 只在这里做。 */
  observe(segment, bootId = null) {
    if (!segment || typeof segment !== 'object') return;
    this.lastFacts = segment;
    if (bootId && bootId !== this.bootId) {
      /**
       * App 重生：序号归零。⭐ 只重新对齐基线，⛔ 不重放历史——
       * 把上一辈子的 final 再交付一次，产品里就会多出一批重复的句子。
       */
      this.bootId = bootId;
      this.lastSeq = Number(segment.results_seq) || 0;
      this.ghostAvoided += 1;
      this.onChange();
      return;
    }
    const seq = Number(segment.results_seq);
    if (!Number.isFinite(seq)) return;
    if (seq < this.lastSeq) { this.lastSeq = seq; this.ghostAvoided += 1; return; }
    if (seq === this.lastSeq) { this.duplicates += 1; return; }

    const last = segment.last;
    if (seq === this.lastSeq + 1 && Number(last?.seq) === seq) {
      this.lastSeq = seq;
      this.#deliver(last);
      return;
    }
    // 跳了不止一格 ⇒ 中间有帧被丢掉了。⚠ 定稿不能丢。
    void this.#backfill(seq);
  }

  async #backfill(target) {
    if (this.backfillInFlight) return;
    this.backfillInFlight = true;
    try {
      const data = await this.android.json(
        `/api/audio/segment/results?after=${this.lastSeq}`, { method: 'GET' });
      const rows = Array.isArray(data?.results) ? data.results : [];
      for (const row of rows.sort((a, b) => Number(a.seq) - Number(b.seq))) {
        if (Number(row.seq) <= this.lastSeq) continue;
        this.lastSeq = Number(row.seq);
        this.backfilled += 1;
        this.#deliver(row);
      }
      if (this.lastSeq < target) this.lastSeq = target;
    } catch (error) {
      this.lastError = `backfill: ${error?.message ?? error}`;
    } finally {
      this.backfillInFlight = false;
    }
  }

  #deliver(row) {
    if (!row || typeof row !== 'object' || !row.segment_id) return;
    const complete = row.complete === true;
    const blank = row.blank === true || String(row.text ?? '').trim() === '';
    if (complete) this.finals += 1; else this.provisionals += 1;
    if (complete && blank) this.blankSuppressed += 1;
    try {
      this.onResult({
        segment_id: String(row.segment_id),
        revision: Number(row.revision) || 1,
        complete,
        blank,
        text: String(row.text ?? ''),
        backend: row.backend ?? null,
        start_mono_ms: Number(row.start_mono_ms) || null,
        end_mono_ms: Number(row.end_mono_ms) || null,
        duration_ms: Number(row.duration_ms) || null,
        inference_ms: Number(row.inference_ms) || null,
        asr_calls: Number(row.asr_calls) || 0,
        archive_wav: row.archive_wav ?? null,
        error: row.error ?? null,
        error_kind: row.error_kind ?? null,
        vad_provider: row.vad_provider ?? null,
        // Diagnostic only: CAM++ owns the start; the fused end may be sourced
        // by CAM++, FireRedVAD, or both. Older App releases omit this field.
        fusion_source: row.fusion_source ?? null,
        seq: Number(row.seq) || 0,
        executor: 'app',
      });
    } catch (error) {
      this.lastError = `result consumer: ${error?.message ?? error}`;
    }
    this.onChange();
  }

  snapshot() {
    const f = this.lastFacts ?? {};
    return {
      schema: 'termux-os.speech-app-segments.v1',
      executor: f.executor ?? null,
      state: f.state ?? null,
      backend: f.backend ?? null,
      results_seq: this.lastSeq,
      app_results_seq: f.results_seq ?? null,
      provisionals_received: this.provisionals,
      finals_received: this.finals,
      duplicates_dropped: this.duplicates,
      backfilled: this.backfilled,
      ghost_avoided: this.ghostAvoided,
      blank_suppressed: this.blankSuppressed,
      app_provisionals: f.provisionals ?? null,
      app_finals: f.finals ?? null,
      app_asr_in_flight: f.asr_in_flight ?? null,
      boot_id: this.bootId,
      last_error: this.lastError,
    };
  }
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 各 RMS/PCM consumer 的独立开关与 PCM 准入状态
 * [OUTPUT]: 对外提供 RMS-only 与 raw PCM 两个独立聚合答案，以及各自的持有者
 * [POS]: docs/077。**一个水源、多个水龙头**——source 是否运行只由聚合决定，
 *        任何单个 consumer 都不是总开关。
 *
 * ⭐ 为什么要有这个表：此前「Package 要不要 PCM」等于 `lifecycle.micHeld`，
 *   而 `micHeld` 由 chain 起停决定。于是 RMS 与 VAD 永远同生共死，
 *   而「开一个功能」实际上是在开关整条管子（docs/077 §1）。
 * ⚠ `wantsPcm=false` 的 consumer 也要登记：foreground gate 吃的是 VAD segment
 *   不是 PCM，把它记下来才能在状态里说清楚「它没有把着水源」。
 * [PROTOCOL]: 纯 JS，无 I/O（单测直接驱动）。变更时更新此头部，然后检查 CLAUDE.md
 */

export class PcmConsumers {
  constructor(specs = []) {
    /** name → { wants_rms, wants_pcm, pcm_admitted, enabled, reason } */
    this.map = new Map();
    for (const s of specs) this.register(s);
    this.changeSeq = 0;
  }

  register({ name, wantsRms = false, wantsPcm = true, enabled = false, pcmAdmitted = true, note = null }) {
    if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(String(name ?? ''))) {
      throw new Error(`invalid consumer name: ${name}`);
    }
    this.map.set(name, {
      wants_rms: wantsRms === true,
      wants_pcm: wantsPcm === true,
      pcm_admitted: pcmAdmitted === true,
      enabled: enabled === true,
      note,
    });
    return this.map.get(name);
  }

  has(name) { return this.map.has(name); }

  enabled(name) { return this.map.get(name)?.enabled === true; }

  pcmAdmitted(name) { return this.map.get(name)?.pcm_admitted === true; }

  /** @return 聚合是否发生了变化（调用方据此决定要不要动硬件需求）。 */
  setEnabled(name, on) {
    const c = this.map.get(name);
    if (!c) throw new Error(`unknown consumer: ${name}`);
    const before = `${this.wantsRms()}:${this.wantsPcm()}`;
    c.enabled = on === true;
    this.changeSeq += 1;
    return before !== `${this.wantsRms()}:${this.wantsPcm()}`;
  }

  /** 开关保持着功能语义，准入单独控制它此刻能否拿到 raw PCM。 */
  setPcmAdmitted(name, on) {
    const c = this.map.get(name);
    if (!c) throw new Error(`unknown consumer: ${name}`);
    const before = this.wantsPcm();
    c.pcm_admitted = on === true;
    this.changeSeq += 1;
    return before !== this.wantsPcm();
  }

  /**
   * ⭐ 唯一的聚合判据：**还有没有一个开着的、真的要 PCM 的 consumer**。
   * ⛔ 这里刻意不看 chain、不看 backend、不看处理门——它们都只是「谁开了哪些 consumer」。
   */
  wantsPcm() {
    for (const c of this.map.values()) {
      if (c.enabled && c.wants_pcm && c.pcm_admitted) return true;
    }
    return false;
  }

  wantsRms() {
    for (const c of this.map.values()) if (c.enabled && c.wants_rms) return true;
    return false;
  }

  /** 现在把着水源的是谁。界面要能回答「我关了为什么还在录」。 */
  holders() {
    return [...this.map.entries()]
      .filter(([, c]) => c.enabled && c.wants_pcm && c.pcm_admitted)
      .map(([name]) => name)
      .sort();
  }

  rmsHolders() {
    return [...this.map.entries()]
      .filter(([, c]) => c.enabled && c.wants_rms)
      .map(([name]) => name)
      .sort();
  }

  /** 全部关掉（使用者按下 Mic Off）。@return 是否有东西被关掉。 */
  disableAll(except = []) {
    const keep = new Set(except);
    let changed = false;
    for (const [name, c] of this.map) {
      if (keep.has(name) || !c.enabled) continue;
      c.enabled = false;
      changed = true;
    }
    if (changed) this.changeSeq += 1;
    return changed;
  }

  snapshot() {
    return {
      schema: 'termux-os.speech-pcm-consumers.v1',
      wants_pcm: this.wantsPcm(),
      wants_rms: this.wantsRms(),
      pcm_holders: this.holders(),
      rms_holders: this.rmsHolders(),
      change_seq: this.changeSeq,
      consumers: Object.fromEntries([...this.map.entries()].map(([name, c]) => [name, { ...c }])),
    };
  }
}

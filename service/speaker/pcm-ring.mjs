/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 连续的 s16le PCM 分片
 * [OUTPUT]: 「最近 N 毫秒」这一个问题的答案，以字节形式
 * [POS]: docs/081。Speaker Lab 与正式声纹门共用**同一个**环——
 *        两份实现会各自漂移，而它们回答的是同一个问题。
 *
 * ⛔ 存字节，不存文件；⛔ `tail()` 攒不够一个整窗时返回 `null`，
 *   绝不拿半个窗去推理（半个窗的 embedding 与整窗不可比，而分数会照样给出来）。
 * [PROTOCOL]: 纯 JS，无 I/O（单测直接驱动）。变更时更新此头部，然后检查 CLAUDE.md
 */

export const SR = 16_000;

export class PcmRing {
  constructor(ms) { this.cap = Math.ceil(SR * ms / 1000) * 2; this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - this.cap);
  }

  /** 取最近 ms 毫秒；不足则返回 null。 */
  tail(ms) {
    const need = Math.ceil(SR * ms / 1000) * 2;
    return this.buf.length >= need ? this.buf.subarray(this.buf.length - need) : null;
  }

  get ms() { return this.buf.length / 2 / SR * 1000; }

  clear() { this.buf = Buffer.alloc(0); }

  /**
   * 改容量。⚠ 缩小时立刻裁掉多余的头部，放大时**保留已有内容**——
   * `RMS 关推理 ≠ 丢 rolling PCM`（任务书 §六）依赖的就是这条：
   * 安静期环照样在填，重新活跃时第一个窗当场就有，不必再等一个 window_ms。
   */
  resize(ms) {
    this.cap = Math.ceil(SR * ms / 1000) * 2;
    if (this.buf.length > this.cap) this.buf = this.buf.subarray(this.buf.length - this.cap);
  }
}

/** s16le Buffer → Int16Array（推理前唯一需要的转换）。 */
export const toInt16 = (buf) => {
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
};

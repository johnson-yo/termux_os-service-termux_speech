/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: ASR 解码出来的原始文本
 * [OUTPUT]: `normalizeTranscript(raw) -> { text, isBlank, reason }`——最终文本的唯一规范形式
 * [POS]: 输出、保存、计数**共用同一个判断**。让 WebUI、ASR、Storage 各写一套 blank 判断，
 *        就会出现「界面上没有、盘上却占着一条」这种谁都没说谎的不一致。
 * [PROTOCOL]: 纯函数，无 IO、无依赖。变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 不可见字符。⚠ 刻意**不含** `\t \n \r`——它们是合法空白，交给 trim 处理；
 * 把它们列进来只会让「删掉」和「修剪」两件事互相掩盖。
 *
 * 三类：C0/C1 控制符、格式与方向控制符（含 BOM 与零宽三兄弟）、软连字符。
 */
const INVISIBLE = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f'
  + '\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2060-\\u2064\\u206a-\\u206f'
  + '\\ufeff\\ufff9-\\ufffb]',
  'gu',
);

/**
 * ⚠ JS 的 `\s` 已经包含 NBSP(00a0)、全角空格(3000) 与 BOM(feff)，但**不含零宽空格
 * (200b)**——所以「删不可见」与「修剪空白」必须是两步，少任何一步都会让一串
 * 零宽字符伪装成一句话。
 */
const EDGE_SPACE = /^\s+|\s+$/gu;

/**
 * ⛔ 只有**规范化之后没有可见内容**才算空白。
 *
 * 标点-only（「。。。」「?!」）**不算空白**：使用者可能真的只说了一个语气，
 * 而且 CTC 解码器对真正的空结果给的是空串（id 0 是 blank，`<|zh|>` 一类标签会被剥掉），
 * 我们不需要替它猜。
 */
export function normalizeTranscript(raw) {
  const source = String(raw ?? '');
  const text = source.normalize('NFC').replace(INVISIBLE, '').replace(EDGE_SPACE, '');
  if (text.length > 0) return { text, isBlank: false, reason: null };
  // 三种空白分开记：它们对应三种不同的上游故障，压成一个 reason 就查不动了。
  const reason = source.length === 0 ? 'empty'
    : source.replace(INVISIBLE, '').length === 0 ? 'invisible_only'
      : 'whitespace_only';
  return { text: '', isBlank: true, reason };
}

/**
 * 空白诊断计数器。⛔ 只留 count / last reason / last timestamp——
 * 不留音频、不留文本、不无界增长。要的是「最近是不是一直在空转」，不是一份日志。
 */
export class BlankStats {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.count = 0;
    this.lastReason = null;
    this.lastAtMs = null;
  }

  record(reason) {
    this.count += 1;
    this.lastReason = reason ?? 'empty';
    this.lastAtMs = this.now();
    return this;
  }

  snapshot() {
    return {
      count: this.count,
      last_reason: this.lastReason,
      last_at_ms: this.lastAtMs,
    };
  }
}

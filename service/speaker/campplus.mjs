/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 16 kHz mono s16 samples
 * [OUTPUT]: 192 维 CAM++ speaker embedding，由 App 的 ORT **CPU** graph session 计算
 * [POS]: docs/080。整条链都在手机上：PCM → Node fbank（复用 VAD 那份）→ per-utt CMN
 *        → App ORT CPU → embedding。⛔ 不装新 runtime，不占 NPU。
 *
 * ⭐ 三件都是实测确认过、不能凭直觉改的事：
 *   ① **前处理复用 `../vad/fbank.mjs`**：它与 torchaudio Kaldi fbank 实测
 *      `max|Δ| ≤ 7.6e-04`。⚠ 这是量出来的，不是「都是 80 维 Kaldi fbank」推出来的——
 *      窗函数 / DC 去除 / log floor 任何一处不同都会移动 embedding。
 *   ② **`backend: 'cpu'`**：CAM++ 没有 HTP ctx，也不该去抢 NPU。手机实测
 *      1 秒段 20.7 ms、3 秒段 40 ms、8 秒段 90 ms，SoC 温度不动。
 *   ③ **要拿回张量必须 `return_outputs: true` + `output_mode: 'raw'`**，
 *      回来的是 `outputs[].data_b64`。⚠ 默认只回 stats——按字面猜 `values.embedding`
 *      会拿到 `undefined`，再 `Array.from` 就成了一个长度为 1 的数组，**一路不报错**。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { computeFbank } from '../vad/fbank.mjs';
import { ResidentGraph } from '../residents.mjs';
import { EMBEDDING_DIM } from './profile.mjs';

const MEL = 80;
const SR = 16_000;
/** 恒等 CMVN：`computeFbank` 会做 `(x-mean)*istd`，这样拿到的就是原始 fbank。 */
const IDENTITY_CMVN = {
  means: new Float32Array(MEL),
  istd: new Float32Array(MEL).fill(1),
};

export class CamPlusEmbedder {
  /**
   * @param backend  `cpu`（既有声纹门，动态 T）或 `htp`（docs/084 验收模式，**固定 T=148**）
   * @param ctxPath  QNN 2.47 EPContext wrapper 的绝对路径；给了才可能真的跑在 HTP 上
   *
   * ⚠ 两者不是同一张图能力：HTP ctx 是**固定 [1,148,80]**（1500 ms 一个窗），
   *   登记那种整段 1.1–5.6 s 的动态长度它吃不下 —— 所以登记继续留 CPU，
   *   运行时才用 HTP（实测两侧 centroid cos=0.999992，见 INTEGRATION_READINESS.md）。
   */
  constructor({ android, residentId, modelPath, estMemMb = 32,
                backend = 'cpu', ctxPath = null, resolveModelPath = null }) {
    this.modelPath = modelPath;
    /** 用时解析的兜底（见 [ensure]）。⛔ 不是「另一个来源」，是**同一个**来源晚一点问。 */
    this.resolveModelPath = resolveModelPath;
    this.backend = backend;
    this.ctxPath = ctxPath;
    /**
     * ⭐ 登记用的 CAM++ 是 **CPU + 动态长度**的临时会话。
     * ⛔ 它与 App 那张常驻 `app-speaker-cam`（HTP、固定 `[1,148,80]`）**不是同一张图**，
     *   也不该常驻：登记是罕见的一次性动作，而那张图吃不下整段任意长度的录音。
     */
    this.graph = new ResidentGraph({
      android, id: residentId, model: 'campplus',
      modelPath, backend, ctxPath, estMemMb, priority: 40, ephemeral: true,
    });
    this.lastError = null;
    this.lastMs = null;
    this.calls = 0;
  }

  get filesPresent() {
    try {
      // ctx 命中时源图不必存在（runbook §5：`require(ctxUsable || 源图存在)`）
      if (this.ctxPath && fs.existsSync(this.ctxPath)) return true;
      return fs.existsSync(this.modelPath);
    } catch { return false; }
  }

  /** 释放这张图（只在 docs/084 验收模式用；⛔ 常驻声纹门不该 churn HTP 会话）。 */
  async release() { try { await this.graph.undeclare(); } finally { this.lastError = null; } }

  /**
   * ⭐ **登记用的那张图改成用时解析。**
   *
   * ⚠ 它只在使用者点「登记」时才用到，而旧代码在**服务启动那一刻**把它解析成一个常量。
   *   真机复现过两种失败，且都不报错、只在几分钟后表现成一句 `CAM++ model missing`：
   *   ① Manager 比本服务晚起一秒 ⇒ 整个 descriptor 拿不到；
   *   ② Manager 答了话但 `companions` 还没派生完 ⇒ **答案完整合法，只是少了这一项**。
   * ⭐ 启动时解析一个只在人点按钮时才需要的东西，等于把一次瞬时竞态变成永久故障。
   * ⛔ 解析不到仍然明确失败，不猜路径、不回落。
   */
  setModelPath(next) {
    if (!next || next === this.modelPath) return;
    this.modelPath = next;
    this.graph.modelPath = next;
  }

  async ensure() {
    if (!this.filesPresent && typeof this.resolveModelPath === 'function') {
      this.setModelPath(await this.resolveModelPath().catch(() => null));
    }
    if (!this.filesPresent) throw new Error(`CAM++ model missing: ${this.modelPath}`);
    await this.graph.declare();
    return this.graph.snapshot();
  }

  /** 官方前处理：Kaldi fbank(80) → 逐维减均值（per-utterance CMN）。 */
  features(samples) {
    const { feat, frames } = computeFbank(samples, IDENTITY_CMVN);
    if (!frames) return null;
    const means = new Float64Array(MEL);
    for (const row of feat) for (let i = 0; i < MEL; i += 1) means[i] += row[i];
    for (let i = 0; i < MEL; i += 1) means[i] /= frames;
    const out = new Float32Array(frames * MEL);
    for (let t = 0; t < frames; t += 1) {
      for (let i = 0; i < MEL; i += 1) out[t * MEL + i] = feat[t][i] - means[i];
    }
    return { data: out, frames };
  }

  /** @param samples Int16Array —— 一段 16 kHz mono PCM。 */
  async embed(samples) {
    const f = this.features(samples);
    if (!f) throw new Error('too few samples for one fbank frame');
    const started = Date.now();
    const r = await this.graph.run({
      inputs: {
        feat: {
          dtype: 'float32',
          shape: [1, f.frames, MEL],
          data_b64: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)
            .toString('base64'),
        },
      },
      outputs: ['embedding'],
      // ⛔ 这两个都必须给，否则只回 stats（见头部 ③）。
      return_outputs: true,
      output_mode: 'raw',
    });
    const tensor = (r?.outputs ?? []).find((t) => t?.name === 'embedding') ?? r?.outputs?.[0];
    if (!tensor?.data_b64) {
      throw new Error(`CAM++ returned no tensor (keys: ${Object.keys(r ?? {}).join(',')})`);
    }
    const buf = Buffer.from(tensor.data_b64, 'base64');
    const emb = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (emb.length !== EMBEDDING_DIM) {
      throw new Error(`CAM++ embedding dim ${emb.length}, expected ${EMBEDDING_DIM}`);
    }
    this.calls += 1;
    this.lastMs = r?.profile?.median_ms ?? (Date.now() - started);
    this.lastError = null;
    return {
      embedding: Array.from(emb),
      frames: f.frames,
      duration_ms: Math.round(samples.length / SR * 1000),
      inference_ms: Number(Number(this.lastMs).toFixed(1)),
      compute_unit: r?.profile?.compute_unit ?? null,
    };
  }

  snapshot() {
    return {
      model_path: this.modelPath,
      files_present: this.filesPresent,
      backend: 'cpu',
      resident: this.graph.snapshot?.() ?? null,
      calls: this.calls,
      last_inference_ms: this.lastMs,
      last_error: this.lastError,
    };
  }
}

export const defaultModelPath = (root) => path.join(root, 'campplus', 'model.onnx');

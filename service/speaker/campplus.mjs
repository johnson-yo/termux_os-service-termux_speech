/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 16 kHz mono PCM16 的一个固定 1.5 s 窗
 * [OUTPUT]: App 内 HTP CAM++ 的 192 维 embedding 与可核对的执行事实
 * [POS]: docs/132 P2。Speech 只持有窄 embedding client；前处理、模型和 session 归 App。
 *
 * ⛔ 本文件不再导入 fbank、generic/campplus.onnx 或 [ResidentGraph]。
 * App 是唯一的 CAM++ 前处理/HTP 执行方，登记与正式识别共用同一条实现。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const CAMPLUS_MODEL_ID = 'campplus';
export const CAMPLUS_EMBEDDING_CONTRACT = 'campplus-htp-t148-v1';
export const CAMPLUS_FEATURE_PROTOCOL = 'campplus-kaldi-cmn-v1';
export const CAMPLUS_WINDOW_MS = 1_500;
export const CAMPLUS_WINDOW_SAMPLES = 24_000;
export const CAMPLUS_FRAMES = 148;
export const CAMPLUS_EMBEDDING_DIM = 192;

const encodePcm = (samples) => {
  if (!(samples instanceof Int16Array) || samples.length !== CAMPLUS_WINDOW_SAMPLES) {
    throw new RangeError(
      `CAM++ HTP requires exactly ${CAMPLUS_WINDOW_SAMPLES} PCM samples (1.5 s)`,
    );
  }
  const bytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) bytes.writeInt16LE(samples[i], i * 2);
  return bytes.toString('base64');
};

const finiteEmbedding = (value) => {
  if (!Array.isArray(value) || value.length !== CAMPLUS_EMBEDDING_DIM) return false;
  let norm = 0;
  for (const x of value) {
    if (!Number.isFinite(Number(x))) return false;
    norm += Number(x) ** 2;
  }
  return norm > 0 && Number.isFinite(norm);
};

export class CamPlusEmbedder {
  constructor({ android, residentId = null, modelPath = null, ctxPath = null } = {}) {
    this.android = android;
    // Kept as a diagnostic identity for old snapshots; App owns the actual lease.
    this.residentId = residentId;
    this.modelPath = modelPath;
    this.ctxPath = ctxPath;
    this.prepared = false;
    this.metadata = null;
    this.lastError = null;
    this.lastMs = null;
    this.calls = 0;
    this.releaseInFlight = null;
  }

  setModelPath(next) {
    if (next) this.modelPath = next;
  }

  setRuntime({ sourcePath, artifact } = {}) {
    if (sourcePath) this.modelPath = sourcePath;
    if (artifact?.path) this.ctxPath = artifact.path;
    return this.snapshot();
  }

  async ensure() {
    if (this.prepared) return this.metadata ?? this.snapshot();
    try {
      const data = await this.android.json('/api/speech/speaker/embedding/prepare', {
        method: 'POST',
        body: {
          model_id: CAMPLUS_MODEL_ID,
          embedding_contract: CAMPLUS_EMBEDDING_CONTRACT,
        },
      });
      // App 的 `data` 本身就是 execution facts；不能把其中的 embedding 字段
      // 当成另一层结果对象。prepare 与 embed 共用同一个明确的 data contract。
      const meta = data;
      if (meta?.backend !== 'htp' || meta?.frames !== CAMPLUS_FRAMES
          || meta?.window_ms !== CAMPLUS_WINDOW_MS) {
        throw new Error('App returned a non-fixed HTP CAM++ contract');
      }
      this.prepared = true;
      this.metadata = meta;
      this.lastError = null;
      return meta;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  async release() {
    if (!this.prepared && !this.releaseInFlight) return this.snapshot();
    if (this.releaseInFlight) return this.releaseInFlight;
    this.releaseInFlight = (async () => {
      try {
        const data = await this.android.json('/api/speech/speaker/embedding/release', {
          method: 'POST', body: { model_id: CAMPLUS_MODEL_ID },
        });
        this.prepared = false;
        this.metadata = null;
        this.lastError = null;
        return data;
      } finally {
        this.releaseInFlight = null;
      }
    })();
    return this.releaseInFlight;
  }

  /** App performs feature extraction and inference; no raw PCM is retained there. */
  async embed(samples) {
    await this.ensure();
    const started = Date.now();
    try {
      const data = await this.android.json('/api/speech/speaker/embedding', {
        method: 'POST',
        body: {
          model_id: CAMPLUS_MODEL_ID,
          embedding_contract: CAMPLUS_EMBEDDING_CONTRACT,
          pcm_s16le_b64: encodePcm(samples),
        },
      });
      // App API 的响应是 `{ ok: true, data: { embedding: [...] , ...facts } }`，
      // appJson 已经取出 data。这里必须保留 data 对象，embedding 只是其中一个字段。
      const result = data;
      const embedding = result?.embedding;
      if (!finiteEmbedding(embedding)) throw new Error('App returned an invalid CAM++ embedding');
      if (result?.backend !== 'htp' || result?.frames !== CAMPLUS_FRAMES) {
        throw new Error('App returned an incompatible CAM++ execution fact');
      }
      this.calls += 1;
      this.lastMs = Number.isFinite(Number(result.inference_ms))
        ? Number(result.inference_ms) : Date.now() - started;
      this.metadata = { ...this.metadata, ...result };
      this.lastError = null;
      return {
        embedding,
        frames: CAMPLUS_FRAMES,
        duration_ms: CAMPLUS_WINDOW_MS,
        inference_ms: this.lastMs,
        // `backend=htp` is the fixed contract; compute_unit is an observed App fact.
        // Never manufacture a value when the App cannot prove the lower-level unit.
        compute_unit: result.compute_unit ?? null,
        model_id: result.model_id ?? CAMPLUS_MODEL_ID,
        model_version: result.model_version ?? null,
        embedding_contract: result.embedding_contract ?? CAMPLUS_EMBEDDING_CONTRACT,
        feature_protocol: result.feature_protocol ?? CAMPLUS_FEATURE_PROTOCOL,
        backend: result.backend,
      };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  snapshot() {
    return {
      model_id: CAMPLUS_MODEL_ID,
      model_path: this.modelPath,
      ctx_path: this.ctxPath,
      resident_id: this.residentId,
      backend: 'htp',
      window_ms: CAMPLUS_WINDOW_MS,
      samples: CAMPLUS_WINDOW_SAMPLES,
      frames: CAMPLUS_FRAMES,
      embedding_dim: CAMPLUS_EMBEDDING_DIM,
      embedding_contract: CAMPLUS_EMBEDDING_CONTRACT,
      feature_protocol: CAMPLUS_FEATURE_PROTOCOL,
      prepared: this.prepared,
      metadata: this.metadata,
      calls: this.calls,
      last_inference_ms: this.lastMs,
      last_error: this.lastError,
    };
  }
}

export const defaultModelPath = (root) => `${root}/campplus/htp-t148/campplus.onnx`;

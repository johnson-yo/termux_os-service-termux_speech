/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: The authenticated App client plus one resident declaration (id, model, ctx_key, heal, est_mem_mb).
 * [OUTPUT]: A ResidentGraph handle exposing declare/run/stream/io and a declaration snapshot.
 * [POS]: The only path from this Package to App HTP graphs. Replaces per-call create/delete on
 *        `/api/inference/graph/sessions`, so the App owns residency and reconciles it after a worker
 *        respawn or a high-water recycle (docs/051 §5, docs/053 §3, docs/054 §4).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const RESIDENTS_PATH = '/api/inference/residents';

/**
 * 声明是对**设备期望状态**的陈述，不是对本进程寿命的陈述。
 *
 * 所以这里没有 `undeclare()`：服务重启、`dev reload`、framework 重启都不该 churn HTP 会话——
 * 反复 create/delete 正是 docs/046 记录的「污染进程 QNN context 致 SIGSEGV」风险，
 * 也与「常驻」二字自相矛盾。已知代价是卸载 Package 会留下孤儿声明，但它是**可见的**
 * （`GET /api/inference/residents` 列出，ort 侧五图合计仅 115 MB），不是 docs/053 §11
 * 那种隐形泄漏；清理入口是同一组 API 的 DELETE。
 */
export class ResidentGraph {
  constructor({
    android, id, model, ctxKey = null, heal = null, estMemMb = 0, priority = 50,
    /**
     * ⭐ 模型的**绝对路径**，来自 Framework 的 Asset map。
     *
     * ⚠ 只给 `model`（一个名字）时，App 会按它自己的 `htp_models_dir` 去拼路径——
     * 于是真机上出现过这个分裂状态：speech 读的 cmvn 来自 asset store，
     * 而 **HTP 上真正跑的那张图来自旧裸路径**。两份文件恰好都在，所以一切看起来正常，
     * 直到有人删掉旧路径。给了 path 才是真的搬完。
     */
    modelPath = null,
    /** Asset 装来的 EPContext（绝对路径）；不给则由 App 自编并落它的 caches/ */
    ctxPath = null,
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id ?? ''))) {
      throw new Error(`invalid resident id: ${id}`);
    }
    this.android = android;
    this.id = id;
    this.model = model;
    this.modelPath = modelPath;
    this.ctxPath = ctxPath;
    this.ctxKey = ctxKey;
    this.heal = heal;
    this.estMemMb = estMemMb;
    this.priority = priority;
    this.declared = false;
    this.lastError = null;
    this.lastDeclaredAtMs = null;
  }

  body() {
    const body = {
      worker: 'ort',
      model: this.model,
      backend: 'htp',
      pinned: true,
      priority: this.priority,
      est_mem_mb: this.estMemMb,
      created_by: 'termux-speech',
    };
    if (this.modelPath) body.model_path = this.modelPath;
    if (this.ctxPath) body.ctx_path = this.ctxPath;
    if (this.ctxKey) body.ctx_key = this.ctxKey;
    if (this.heal) body.heal = this.heal;
    return body;
  }

  /** 幂等声明。App 侧 `declare` 一律 force 对账，故这里不需要自己安排重试节奏。 */
  async declare({ force = false } = {}) {
    if (this.declared && !force) return null;
    const result = await this.android.json(`${RESIDENTS_PATH}/${this.id}`, {
      method: 'PUT',
      body: this.body(),
      timeoutMs: 180_000,
    });
    this.declared = true;
    this.lastDeclaredAtMs = Date.now();
    this.lastError = null;
    return result;
  }

  /** 撤销并卸载。只在 heal 声明需要修正时用（改 spec 必须 DELETE+PUT，见 docs/054 §4.4）。 */
  async undeclare() {
    try {
      await this.android.json(`${RESIDENTS_PATH}/${this.id}`, {
        method: 'DELETE',
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
    }
    this.declared = false;
  }

  /** 本条声明的 io 缓存（输出名探一次永久记住）；未就绪时返回 null 而不是抛。 */
  async io() {
    const snapshot = await this.android.json(RESIDENTS_PATH, { timeoutMs: 15_000 });
    const entry = (snapshot?.residents ?? []).find((item) => item?.id === this.id);
    return entry?.io ?? null;
  }

  async invoke(verb, body) {
    await this.declare();
    try {
      return await this.android.json(`${RESIDENTS_PATH}/${this.id}/${verb}`, {
        method: 'POST',
        body,
        timeoutMs: 180_000,
      });
    } catch (error) {
      // 404 = 声明本身不见了（App 重装 / 声明文件被清）。重新声明一次再让调用方重试，
      // 而不是把它当成模型坏了。
      if (Number(error?.status) === 404) {
        this.declared = false;
        error.retryable = true;
        error.retryAfterMs = error.retryAfterMs ?? 500;
      }
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  run(body) {
    return this.invoke('run', body);
  }

  stream(body) {
    return this.invoke('stream', body);
  }

  snapshot() {
    return {
      resident_id: this.id,
      model: this.model,
      ctx_key: this.ctxKey,
      declared: this.declared,
      declared_at_ms: this.lastDeclaredAtMs,
      owner: 'app_resident_registry',
      last_error: this.lastError,
    };
  }
}

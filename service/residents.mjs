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
 * ⭐ **临时会话**：建了就用、用完就删，⛔ 不进声明态、⛔ 不被对账器补回来。
 *
 * docs/096 退役的是「speech 拥有**常驻**图」——两份同功能的图各占一个 HTP session
 * 而没有界面说得出来。它**没有**退役「一次罕见的、使用者发起的动作临时借一张图」，
 * 而声纹**登记**正是这种：它要的是一张 **CPU、动态长度** 的 CAM++
 * （固定 `[1,148,80]` 的运行时那张吃不下 1.1–5.6 秒的整段），
 * 而 App 的三层 pipeline 里没有、也不该有这样一张常驻图。
 * ⚠ 退役 `declare()` 时这条路径被一起切断了，症状是登记时报
 *   `no such resident: tsp-vad-…-spk`——一个**没有人再声明**的 id。
 */
const SESSIONS_PATH = '/api/inference/graph/sessions';

/** ⛔ docs/096：Speech 侧的 tsp-* 常驻所有权已退役。见 `declare()` 的理由。 */
const LEGACY_RESIDENT_OWNERSHIP = false;

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
     * 跑在哪个后端。默认 `htp`——既有五张图一行不改。
     * ⭐ `cpu` 是给 CAM++ 声纹图用的：它没有 HTP ctx，也不该去抢 NPU
     *   （实测手机 CPU 上 3 秒的段 40 ms，本来就付得起）。
     */
    backend = 'htp',
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
    /**
     * ⭐ 临时会话（见 [SESSIONS_PATH]）。⛔ 只给「罕见 + 使用者发起 + 用完即走」的路径，
     *   ⛔ 绝不用来绕过 docs/096：常驻仍然只有 App 能拥有。
     */
    ephemeral = false,
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id ?? ''))) {
      throw new Error(`invalid resident id: ${id}`);
    }
    this.android = android;
    this.id = id;
    this.model = model;
    this.backend = backend;
    this.modelPath = modelPath;
    this.ctxPath = ctxPath;
    this.ephemeral = ephemeral === true;
    this.ctxKey = ctxKey;
    this.heal = heal;
    this.estMemMb = estMemMb;
    this.priority = priority;
    this.declared = false;
    this.lastError = null;
    this.lastDeclaredAtMs = null;
  }

  /**
   * ⭐ **只在还没声明时接受路径更新。**
   *
   * ⚠ 声明过之后就地改 spec 是无效的：App 的对账器看到「声明有、实际也有」会跳过，
   *   不触发重载（docs/054 §4.4）——⛔ 于是本地字段与 HTP 上真正跑的那张图会分叉，
   *   而两边都不会报错。要换图只能 undeclare 之后重来。
   */
  configure({ ctxKey, modelPath, ctxPath } = {}) {
    if (this.declared) {
      throw new Error(`resident ${this.id} is already declared; undeclare before changing its graph`);
    }
    if (ctxKey !== undefined) this.ctxKey = ctxKey;
    if (modelPath !== undefined) this.modelPath = modelPath;
    if (ctxPath !== undefined) this.ctxPath = ctxPath;
    return this;
  }

  body() {
    const body = {
      worker: 'ort',
      model: this.model,
      backend: this.backend,
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

  /**
   * ⛔ **docs/096：Speech 不再拥有任何 runtime graph。**
   *
   * App 的三层 Pipeline 是唯一 execution owner，它自己声明 `app-speaker-cam`
   * （CAM++ / **htp**）、`app-asr-sensevoice` 与 `fireredvad`。
   * ⚠ Speech 这边曾经声明的 `tsp-vad-*` / `tsp-asr-*` / `tsp-*-spk-emb` 与它们
   *   **逐个功能重复**，各占一个 HTP session，而 `tsp-*-spk-emb` 还是 cpu 后端——
   *   同一个 CAM++ 同时存在一个 htp 版和一个 cpu 版，没有任何界面说得出这件事。
   * ⭐ 堵在 `declare()` 这一个咽喉，而不是逐个改调用点：
   *   漏掉一个调用点的症状是「大部分时候没问题」，那种缺陷最难发现。
   */
  async declare({ force = false } = {}) {
    if (this.ephemeral) {
      if (this.declared && !force) return null;
      const result = await this.android.json(SESSIONS_PATH, {
        method: 'POST',
        body: { name: this.id, ...this.body() },
        timeoutMs: 180_000,
      });
      this.declared = true;
      this.lastDeclaredAtMs = Date.now();
      this.lastError = null;
      return result;
    }
    if (!LEGACY_RESIDENT_OWNERSHIP) {
      this.declared = false;
      this.lastError = null;
      return null;
    }
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
      await this.android.json(
        this.ephemeral ? `${SESSIONS_PATH}/${this.id}` : `${RESIDENTS_PATH}/${this.id}`,
        { method: 'DELETE', timeoutMs: 60_000 },
      );
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
    }
    this.declared = false;
  }

  /**
   * 服务重启后的事实对账只同步本地镜像，不触碰 App 的声明或会话。
   * 这样 UI 不会把「App 已有」误画成「本包未声明」，也不会为了修显示而 churn 图。
   */
  reconcileDeclared(declared) {
    this.declared = declared === true;
    if (!this.declared) this.lastDeclaredAtMs = null;
    return this.snapshot();
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
      const base = this.ephemeral ? SESSIONS_PATH : RESIDENTS_PATH;
      return await this.android.json(`${base}/${this.id}/${verb}`, {
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

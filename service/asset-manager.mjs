/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework capability `termux-os.assets.manager`（action）与 `termux-os.assets.inventory`（feed）
 * [OUTPUT]: `AssetManagerClient` —— 一层很薄的转接：发现、调用、归一化错误、以及「它不在」这个状态
 * [POS]: ⭐ **本包对模型生命周期的唯一出口**。目录、库存、上游元数据、已批准版本、
 *        安装/取回/校验/删除、更新判定、引用、作业进度——全部由 Manager 负责，
 *        本包只保留「这个模型对语音意味着什么」。
 *
 * ⛔ 这里**不复制** Manager 的任何逻辑：不判 update 三分法、不比较版本、不算引用、
 *   不实现第二个 operation 状态机、不碰 HF/CF API。复制一份就会有两个各自漂移的真相。
 * ⛔ 不写死 Manager 的 package id、端口、`/api/packages/...` 路径。只认 capability id——
 *   写死的常量在派生实例上全部失效，而且那正是 capability 要消灭的东西。
 * ⚠ **Manager 不可用不是本包的故障条件**。它是资产管理服务，不在语音数据通路上：
 *   已经装好的模型继续由 Framework runtime resolver 解析（见 service/assets.mjs），
 *   使用者只是暂时不能下载/更新/删除/看远端目录。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const MANAGER_CAPABILITY = 'termux-os.assets.manager';
export const INVENTORY_CAPABILITY = 'termux-os.assets.inventory';

/** 归一化的「用不了」。⚠ 每一种都要能分开：修法完全不同。 */
export const UNAVAILABLE = Object.freeze({
  NOT_INSTALLED: 'manager_not_installed',   // 目录里没有这个 capability
  UNREACHABLE: 'manager_unreachable',       // 有 capability，但进程/框架够不到
  NO_CREDENTIALS: 'no_framework_credentials',
});

const REASON_TEXT = Object.freeze({
  [UNAVAILABLE.NOT_INSTALLED]: '模型管理服务未安装',
  [UNAVAILABLE.UNREACHABLE]: '模型管理服务暂不可用',
  [UNAVAILABLE.NO_CREDENTIALS]: '缺少 Framework 凭证',
});

export const unavailableText = (reason) => REASON_TEXT[reason] ?? '模型管理服务暂不可用';

export class AssetManagerClient {
  /**
   * @param frameworkUrl Loader 注入
   * @param systemKey    Loader 注入
   * @param discoveryTtlMs 发现结果的缓存时长。⚠ 不能是 0：模型页每几秒刷新一次，
   *        每次都去问一遍能力目录，等于给单进程的 Framework 加一份没必要的负载。
   */
  constructor({
    frameworkUrl = process.env.TERMUX_OS_FRAMEWORK_URL || '',
    systemKey = process.env.TERMUX_OS_SYSTEM_KEY || '',
    fetchImpl = fetch,
    discoveryTtlMs = 30_000,
    now = () => Date.now(),
  } = {}) {
    this.frameworkUrl = frameworkUrl;
    this.systemKey = systemKey;
    this.fetchImpl = fetchImpl;
    this.discoveryTtlMs = discoveryTtlMs;
    this.now = now;
    /** { at, present:boolean, feedEndpoint:string|null, feedFormat:string|null } */
    this.discovery = null;
    this.lastError = null;
  }

  get configured() { return Boolean(this.frameworkUrl && this.systemKey); }

  async #framework(path, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
    const response = await this.fetchImpl(`${this.frameworkUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.systemKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  /**
   * 能力目录里有没有它，以及 feed 的端点在哪。
   *
   * ⭐ feed 端点**来自 describe**，⛔ 不由本包拼装——拼出来的地址在派生实例上会指向别人。
   */
  async discover({ force = false } = {}) {
    if (!this.configured) return { present: false, reason: UNAVAILABLE.NO_CREDENTIALS };
    const cached = this.discovery;
    if (!force && cached && this.now() - cached.at < this.discoveryTtlMs) return cached;
    try {
      const list = await this.#framework('/api/capabilities');
      const ids = (list.data?.capabilities ?? []).map((c) => c?.id ?? c?.capability ?? c);
      const present = ids.includes(MANAGER_CAPABILITY);
      let feedEndpoint = null;
      let feedFormat = null;
      if (ids.includes(INVENTORY_CAPABILITY)) {
        const d = await this.#framework(`/api/capabilities/${INVENTORY_CAPABILITY}`);
        const info = d.data?.capability ?? d.data ?? {};
        feedEndpoint = info.endpoint ?? d.data?.endpoint ?? null;
        feedFormat = info.format ?? d.data?.format ?? null;
      }
      this.lastError = null;
      this.discovery = { at: this.now(), present, feedEndpoint, feedFormat,
        reason: present ? null : UNAVAILABLE.NOT_INSTALLED };
      return this.discovery;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      /**
       * ⚠ 发现失败**不缓存**成「没装」。够不到框架是暂时的，
       * 而把它记成 not_installed 会让页面在框架恢复之后继续说「没装」到 TTL 结束。
       */
      return { present: false, reason: UNAVAILABLE.UNREACHABLE, error: this.lastError };
    }
  }

  /**
   * 调一次 Manager。
   * @returns `{ ok:true, value }` 或 `{ ok:false, unavailable?, error, detail? }`
   *
   * ⚠ 三种失败要分开：Manager 不在（degraded，页面照常显示已装模型）、
   *   Manager 在但这次调用失败（报错给使用者）、以及 Manager 明确回答了 `ok:false`
   *   （例如 `asset_in_use`，那是**答案**不是故障，要原样展示）。
   */
  async call(op, args = {}, { timeoutMs = 30_000 } = {}) {
    const found = await this.discover();
    if (!found.present) {
      return { ok: false, unavailable: found.reason, error: found.reason, detail: found.error ?? null };
    }
    try {
      const r = await this.#framework(`/api/capabilities/${MANAGER_CAPABILITY}/invoke`, {
        method: 'POST', body: { input: JSON.stringify({ op, ...args }) }, timeoutMs,
      });
      /**
       * ⚠ Framework 的 invoke 回的是**信封** `{ok, capability, provider, value}`，
       *   动作自己的返回值在 `value` 里。⛔ 读顶层会拿到一个恒为 true 的 ok，
       *   于是「调用成功」与「Manager 说不行」在日志里长得一模一样。
       */
      if (r.data?.ok !== true) {
        /**
         * ⭐ **能力还在目录里，不代表它还活着。**
         *
         * Framework 的 capability 注册在**进程死掉之后依然存在**（它记的是「谁声明提供」，
         * 不是「此刻能不能用」）。真机实测：`kill -9` 掉 Manager 之后，
         * `/api/capabilities` 照样列着它，于是只看目录的 `status()` 会回答「可用」，
         * 而每一次调用都失败——页面写着「模型管理正常」，按钮却一个都按不动。
         * ⚠ 这与 docs/075 的教训同形：`connected` 不等于「在工作」。
         * ⭐ Framework 自己已经把话说清楚了（`provider_not_ready` 来自 provider 的
         *   `available()` 探活），把它当成**够不到**，⛔ 不要原样透出去当成业务错误。
         */
        const err = String(r.data?.error ?? '');
        if (err === 'provider_not_ready' || err === 'no_provider' || err === 'unknown_capability') {
          this.discovery = null;
          return { ok: false, unavailable: UNAVAILABLE.UNREACHABLE, error: UNAVAILABLE.UNREACHABLE, detail: err };
        }
        return { ok: false, error: err || `invoke HTTP ${r.status}`, detail: r.data?.reason ?? null };
      }
      return { ok: true, value: r.data.value ?? null };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      // 发现过它却调不通 ⇒ 下次重新发现，别抱着一个过期的 present:true 反复失败。
      this.discovery = null;
      return { ok: false, unavailable: UNAVAILABLE.UNREACHABLE, error: UNAVAILABLE.UNREACHABLE,
        detail: this.lastError };
    }
  }

  /** 本包只关心自己那几个 asset，所以按 id 逐个问 detail 会打太多次——一次全量再挑。 */
  async assets() { return this.call('assets'); }

  /** Logical-model management is the only model surface consumed by Settings. */
  async models() { return this.call('models'); }

  async model(modelId) { return this.call('model', { model_id: modelId }); }

  async downloadModel(modelId, choice = null) {
    return this.call('download', { model_id: modelId, ...(choice ? { choice } : {}) }, { timeoutMs: 120_000 });
  }

  async useModel(modelId) {
    return this.call('use', { model_id: modelId }, { timeoutMs: 30_000 });
  }

  async detail(assetId) { return this.call('detail', { asset_id: assetId }); }

  /** 本机能不能用这个 asset（target 匹配由 Framework 判定，Manager 只转达）。 */
  async resolve(assetId) { return this.call('resolve', { asset_id: assetId }); }

  async install(assetId) { return this.call('install', { asset_id: assetId }, { timeoutMs: 120_000 }); }

  async fetchPayload(assetId) { return this.call('fetch', { asset_id: assetId }, { timeoutMs: 120_000 }); }

  async remove(assetId) { return this.call('remove', { asset_id: assetId }, { timeoutMs: 60_000 }); }

  async operation(operationId) { return this.call('operation', { operation_id: operationId }); }

  async operations() { return this.call('operations'); }

  /**
   * 事件游标。⭐ 只用来触发「模型页该刷新了」，⛔ 绝不进语音热路径。
   * feed 断了页面退回轮询，语音链一点不受影响。
   */
  async events(after = 0, limit = 50) { return this.call('events', { after, limit }); }

  /** 页面用的一行状态。⚠ 「没装」与「够不到」必须分开说，修法不同。 */
  async status() {
    const found = await this.discover();
    return {
      available: found.present === true,
      reason: found.present ? null : found.reason,
      message: found.present ? null : unavailableText(found.reason),
      feed_endpoint: found.feedEndpoint ?? null,
      feed_format: found.feedFormat ?? null,
    };
  }
}

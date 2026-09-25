/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework capability `termux-os.assets.manager` / action
 *          `assets.manager.query`.
 * [OUTPUT]: A raw-only Manager 0.4.4 client: package cards, file facts,
 *           download/verify operations, and explicit transport/contract errors.
 * [POS]: Termux Speech's Manager boundary. Manager owns raw bytes only;
 *        App owns prepare, executable artifacts, residents, and inference.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const MANAGER_CAPABILITY = 'termux-os.assets.manager';
export const MANAGER_ACTION = 'assets.manager.query';

export const UNAVAILABLE = Object.freeze({
  NOT_INSTALLED: 'manager_not_installed',
  UNREACHABLE: 'manager_unreachable',
});

const REASON_TEXT = Object.freeze({
  [UNAVAILABLE.NOT_INSTALLED]: '模型管理服务未安装',
  [UNAVAILABLE.UNREACHABLE]: '模型管理服务暂不可用',
});

export const unavailableText = (reason) => REASON_TEXT[reason] ?? '模型管理服务暂不可用';

const CONTRACT_ERRORS = new Set([
  'unknown_package_route', 'unknown_op', 'not_found', 'unknown_package',
  'unknown_raw_file', 'invalid_response', 'input must be JSON',
]);

const contractError = (status, value, fallback = 'manager_contract_error') => {
  const error = String(value?.error ?? '');
  return status >= 400 || CONTRACT_ERRORS.has(error) || !value || typeof value !== 'object'
    ? fallback : null;
};

export class AssetManagerClient {
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

  async discover({ force = false } = {}) {
    if (!this.configured) return { present: false, reason: UNAVAILABLE.UNREACHABLE, error: 'no credentials' };
    const cached = this.discovery;
    if (!force && cached && this.now() - cached.at < this.discoveryTtlMs) return cached;
    try {
      const list = await this.#framework('/api/capabilities');
      if (list.status < 200 || list.status >= 300 || !list.data) {
        return { present: false, reason: UNAVAILABLE.UNREACHABLE, error: `HTTP ${list.status}` };
      }
      const ids = (list.data.capabilities ?? []).map((c) => c?.id ?? c?.capability ?? c);
      const present = ids.includes(MANAGER_CAPABILITY);
      this.lastError = null;
      this.discovery = {
        at: this.now(), present,
        reason: present ? null : UNAVAILABLE.NOT_INSTALLED,
        error: present ? null : 'capability not registered',
      };
      return this.discovery;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.discovery = null;
      return { present: false, reason: UNAVAILABLE.UNREACHABLE, error: this.lastError };
    }
  }

  /** Invoke only the frozen raw package capability. */
  async call(op, args = {}, { timeoutMs = 30_000 } = {}) {
    const found = await this.discover();
    if (!found.present) {
      return { ok: false, unavailable: found.reason, error: found.reason, detail: found.error ?? null };
    }
    try {
      const response = await this.#framework(`/api/capabilities/${MANAGER_CAPABILITY}/invoke`, {
        method: 'POST',
        body: { input: JSON.stringify({ op, ...args }) },
        timeoutMs,
      });
      const envelope = response.data;
      if (envelope?.ok !== true) {
        const error = String(envelope?.error ?? `invoke HTTP ${response.status}`);
        if (['provider_not_ready', 'no_provider', 'unknown_capability'].includes(error)) {
          this.discovery = null;
          return { ok: false, unavailable: UNAVAILABLE.UNREACHABLE,
            error: UNAVAILABLE.UNREACHABLE, detail: error };
        }
        return { ok: false, error: CONTRACT_ERRORS.has(error) || response.status >= 400
          ? 'manager_contract_error' : error, detail: envelope?.reason ?? error };
      }
      const value = envelope.value;
      if (!value || typeof value !== 'object') {
        return { ok: false, error: 'manager_contract_error', detail: 'capability returned no object' };
      }
      const bad = contractError(response.status, value);
      if (bad) return { ok: false, error: bad, detail: value.error ?? `HTTP ${response.status}` };
      return { ok: true, value };
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.discovery = null;
      return { ok: false, unavailable: UNAVAILABLE.UNREACHABLE,
        error: UNAVAILABLE.UNREACHABLE, detail: this.lastError };
    }
  }

  async packages() { return this.call('packages'); }
  async package(packageKey) { return this.call('package', { package_key: packageKey }); }
  async file(packageKey, filePath) { return this.call('file', { package_key: packageKey, path: filePath }); }
  async refresh() { return this.call('refresh', {}, { timeoutMs: 120_000 }); }
  async downloadPackage(packageKey) {
    return this.call('download', { package_key: packageKey }, { timeoutMs: 3_600_000 });
  }
  async verifyPackage(packageKey) {
    return this.call('verify', { package_key: packageKey }, { timeoutMs: 3_600_000 });
  }
  async operation(operationId) { return this.call('operation', { operation_id: operationId }); }
  async operations() { return this.call('operations'); }
  async declarations() { return this.call('declarations'); }
  async events(after = 0, limit = 50) { return this.call('events', { after, limit }); }

  async status() {
    const found = await this.discover();
    return {
      available: found.present === true,
      reason: found.present ? null : found.reason,
      message: found.present ? null : unavailableText(found.reason),
    };
  }
}

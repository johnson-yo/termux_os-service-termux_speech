/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework termux-os.app.api Capability, injected System Key, and App API paths.
 * [OUTPUT]: A short-lived Android App descriptor, cached JSON client, credential-safe WS discovery,
 *           and `UpstreamError.retryable` for App 503/429 (resident not settled yet, or bounded admission).
 * [POS]: Termux Speech's only Android-provider transport boundary; credentials are never persisted or logged.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export class UpstreamError extends Error {
  constructor(message, status = 502, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    // 「还没好」不是「坏了」。App 侧 503 有两个来源，都必须原样重试而不是记为失败：
    // 常驻图在 worker 重生后尚未对账完成（docs/051 §5.4），以及有界准入 Semaphore(8)
    // 拒绝过载（docs/051 §4.3）。把它压成 502 会让调用方放弃并上报错误。
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 从 App 的错误文本里取出 `retry_after_ms=1000`；取不到就用调用方的默认值。 */
const retryAfterFrom = (text, fallback = 1000) => {
  const matched = /retry_after_ms\s*=\s*(\d+)/.exec(String(text ?? ''));
  return matched ? Number(matched[1]) : fallback;
};

export async function discoverAndroidApp({
  frameworkUrl,
  systemKey,
  fetchImpl = fetch,
  timeoutMs = 5000,
}) {
  const response = await fetchImpl(`${frameworkUrl}/api/capabilities/termux-os.app.api/invoke`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${systemKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true || !body?.value) {
    throw new UpstreamError(body?.reason ?? body?.error ?? `termux-os.app.api HTTP ${response.status}`, 503);
  }
  const value = body.value;
  let baseUrl;
  try { baseUrl = new URL(value.base_url).origin; } catch {
    throw new UpstreamError('termux-os.app.api returned an invalid base_url', 503);
  }
  const authorization = value.headers?.Authorization
    ?? (typeof value.token === 'string' && value.token ? `Bearer ${value.token}` : '');
  if (!authorization) throw new UpstreamError('termux-os.app.api returned no authorization descriptor', 503);
  return { baseUrl, authorization };
}

export async function appJson(descriptor, path, {
  method = 'GET',
  body,
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  const response = await fetchImpl(`${descriptor.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: descriptor.authorization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error ?? `Android App HTTP ${response.status} ${path}`;
    const retryable = response.status === 503 || response.status === 429;
    const status = retryable || (response.status >= 400 && response.status < 500)
      ? response.status
      : 502;
    throw new UpstreamError(message, status, {
      retryable,
      retryAfterMs: retryable ? retryAfterFrom(message) : null,
    });
  }
  return payload.data;
}

export function createAndroidAppClient({
  frameworkUrl,
  systemKey,
  fetchImpl = fetch,
  descriptorTtlMs = 30_000,
}) {
  let cached = null;
  let validUntil = 0;
  let discoveryPromise = null;

  const descriptor = async (force = false) => {
    if (!force && cached && Date.now() < validUntil) return cached;
    if (!discoveryPromise) {
      discoveryPromise = discoverAndroidApp({ frameworkUrl, systemKey, fetchImpl })
        .then((value) => {
          cached = value;
          validUntil = Date.now() + descriptorTtlMs;
          return value;
        })
        .finally(() => { discoveryPromise = null; });
    }
    return discoveryPromise;
  };

  const json = async (path, options = {}) => {
    try {
      return await appJson(await descriptor(), path, { ...options, fetchImpl });
    } catch (error) {
      if (error?.status !== 401 && error?.status !== 403) throw error;
      cached = null;
      validUntil = 0;
      return appJson(await descriptor(true), path, { ...options, fetchImpl });
    }
  };

  return {
    describe: descriptor,
    json,
    invalidate() {
      cached = null;
      validUntil = 0;
    },
  };
}

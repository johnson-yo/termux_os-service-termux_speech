/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework `GET /api/assets/<id>`、`POST /api/assets/<id>/fetch` 与 Loader 注入的
 *          `TERMUX_OS_FRAMEWORK_URL` / `TERMUX_OS_SYSTEM_KEY`
 * [OUTPUT]: `resolveAssetRoot(id)` —— 一个**已验证**的绝对路径，或一个明确的失败；
 *           `ensureAssetRoot(id)` —— 同上，但缺的时候先取一次
 * [POS]: 模型位置的唯一来源。⛔ 本包不再持有任何裸模型路径。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const FRAMEWORK_URL = process.env.TERMUX_OS_FRAMEWORK_URL || '';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

/**
 * ⭐ 启动时**现问**，不用注册时算好的环境变量。
 *
 * 资产可以在服务注册之后才装上、才升级、才被换成另一个版本；一个在注册那一刻
 * 冻结下来的路径，会在这些时刻里静静地指向错的地方，而且指对指错长得一模一样。
 *
 * ⛔ 没有回落路径。拿不到就抛——起不来比带着未知状态跑更容易查，
 * 而且依赖门禁本就该在这之前把它拦住；真跑到这里还失败，说明门禁本身有问题。
 */
export async function resolveAssetRoot(id, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!FRAMEWORK_URL || !SYSTEM_KEY) {
    throw new Error(`asset ${id}: no Framework credentials in the environment`);
  }
  /**
   * ⭐ **够不到框架要重试，够到了才算答案。**
   *
   * ⚠ 真机上服务被这一行打死过：受监管的服务在框架 HTTP 还没开始接受连接时就起来了，
   * 第一次 `fetch` 抛 `fetch failed`，而这里立刻放弃 → 服务退出 → 重启 → 再来一遍。
   * 症状是「资产不可达」，而资产就在盘上，框架一秒后也好好的。
   *
   * ⛔ 只对**传输失败**重试。「这个资产没登记」是一个确定的答案，重试它只是在等一件
   * 不会发生的事。
   */
  let payload;
  let lastTransportError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetchImpl(`${FRAMEWORK_URL}/api/assets/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${SYSTEM_KEY}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        throw Object.assign(new Error(payload?.error ?? `HTTP ${response.status}`), { answered: true });
      }
      lastTransportError = null;
      break;
    } catch (error) {
      if (error?.answered) {
        throw new Error(`asset ${id}: cannot reach the Framework asset registry: ${String(error?.message ?? error)}`);
      }
      lastTransportError = error;
      await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)); });
    }
  }
  if (lastTransportError) {
    throw new Error(`asset ${id}: cannot reach the Framework asset registry: `
      + `${String(lastTransportError?.message ?? lastTransportError)} (after 6 attempts)`);
  }
  const asset = payload.asset ?? {};
  // ⚠ 「登记了」不等于「能用」：ready 才算数，理由要原样带出来。
  if (asset.ready !== true) {
    throw new Error(`asset ${id} is not ready: ${asset.detail ?? asset.reason ?? 'unknown reason'}`);
  }
  if (!asset.path) throw new Error(`asset ${id} is ready but has no path`);
  return { root: asset.path, version: asset.version ?? null, package: asset.package ?? null };
}

/**
 * ⭐ **ASR 模型不是安装依赖，是「开始听写」时的依赖。**
 *
 * 一台机器只会用到一个 ASR 档位，而是哪一个要等使用者选。装的时候全下等于
 * SenseVoice 的 ctx 478MB + 源图 937MB + Qwen 编码器 376MB + 两档解码器 1.5GB，
 * 其中绝大部分永远不会被加载一次。所以缺的时候就地取一次，取完再问一遍。
 *
 * ⚠ 这不是「另一种安装」：只有 manifest 里标了 `optional` 的资产走得通这条路，
 * 框架会以 `not_optional` 拒绝其余的。装的时候就该到位的东西，仍然必须装的时候到位。
 *
 * ⚠ 超时给到 30 分钟：这里真的在下几百 MB。⛔ 但**不重试**——半途失败的下载
 * 框架那边不会留下半个文件，而一个自动重试会把「网络不通」变成一段没人看得懂的长时间静默。
 */
export async function ensureAssetRoot(id, { fetchImpl = fetch, onFetch = () => {} } = {}) {
  try {
    return await resolveAssetRoot(id, { fetchImpl });
  } catch (missing) {
    onFetch({ id, stage: 'start', reason: String(missing?.message ?? missing) });
    const response = await fetchImpl(`${FRAMEWORK_URL}/api/assets/${encodeURIComponent(id)}/fetch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SYSTEM_KEY}` },
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      /**
       * ⚠ 把**两个**原因都带出来。「本机没有对应硬件版本」与「取不下来」要做的事完全不同：
       * 前者去编一份 ctx，后者查网络。只报后一个会让人修错东西。
       */
      throw new Error(`asset ${id} is missing and could not be fetched.\n`
        + `  missing: ${String(missing?.message ?? missing)}\n`
        + `  fetch:   ${payload?.error ?? `HTTP ${response.status}`}`
        + `${payload?.detail ? ` — ${payload.detail}` : ''}`
        + `${payload?.candidates?.length ? `\n  variants that do exist: ${payload.candidates.join(', ')}` : ''}`);
    }
    onFetch({ id, stage: 'done', bytes: payload.bytes ?? 0, path: payload.path ?? null });
    return resolveAssetRoot(id, { fetchImpl });
  }
}

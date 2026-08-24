/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: HF Model Manager 的 `GET /models/<id>/resolve`（经 Framework 的 loopback 转发）
 * [OUTPUT]: `resolveLogicalModel(id)` —— 一个 **executable descriptor**，或一个明确的「未启用」
 * [POS]: docs/093。⭐ **这个文件把「模型从哪来」这件事整个搬走了。**
 *
 * 迁移前 speech 自己干这些：
 *   · 先 resolve `model.sensevoice.ctx`，取不到再 resolve `model.sensevoice.graph`；
 *   · 拼 `path.join(ctxRoot, 'model.onnx')` / `${ctxRoot}/model_ir11.onnx`；
 *   · 知道 v73、知道 QNN target、知道哪个是预制哪个是本机编的。
 * ⛔ 这些**全部不再是它的事**。它现在只说「我要 model.sensevoice」。
 *
 * ⭐ 为什么这条边界值得单独一个文件：那套判断**曾经是对的**，
 *   但它散在业务代码里 ⇒ 每加一个模型就要再抄一遍，而抄错不会报错，
 *   只会打开一个不存在或者不对的文件。
 * ⚠ 消费方⛔ 不许直接读 Manager 的 state JSON：那是实现细节，这条 API 才是契约。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const FRAMEWORK_URL = process.env.TERMUX_OS_FRAMEWORK_URL || 'http://127.0.0.1:8980';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';
const MANAGER = 'github.termux-os.service.hf-model-manager';

export class ModelNotEnabled extends Error {
  constructor(modelId, reason, hint) {
    super(`${modelId}: ${reason}`);
    this.modelId = modelId;
    this.reason = reason;
    this.hint = hint ?? '请在「模型管理器」里下载并点「使用」。';
  }
}

/**
 * 取一个 logical model 此刻的可执行体。
 *
 * @returns `{available:true, executable:{kind,path}, companions:{...}}`
 *          或 `{available:false, reason, hint}` —— ⛔ **不抛异常**：
 *          「模型还没准备好」是一个正常状态，不是故障。
 */
export async function resolveLogicalModel(id, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  /**
   * ⚠ 走 **query 而不是路径段**：Framework 的包路由是精确路径匹配、⛔ 没有通配符，
   *   所以带 id 的操作在代理层一律用 `?id=`（与 Manager 既有的 `/asset?id=` 同一形状）。
   *   ⛔ 照着 service 层的路径形状去拼这一层，会稳定地拿到 `unknown_package_route`。
   */
  const url = `${FRAMEWORK_URL}/api/packages/${MANAGER}/model/resolve`
    + `?id=${encodeURIComponent(id)}`;
  let payload;
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${SYSTEM_KEY}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = await r.json().catch(() => null);
    if (!r.ok || payload?.ok !== true) {
      /**
       * ⚠ 够不到 Manager 与「模型没准备好」是**两件事**，⛔ 不能压成一个。
       *   前者要去看服务，后者要去点「使用」。
       */
      return {
        available: false, model_id: id,
        reason: 'model_manager_unavailable',
        hint: `模型管理器不可达（${payload?.error ?? `HTTP ${r.status}`}）。`,
      };
    }
  } catch (error) {
    return {
      available: false, model_id: id,
      reason: 'model_manager_unavailable',
      hint: `模型管理器不可达（${String(error?.message ?? error)}）。`,
    };
  }
  return payload;
}

/**
 * 拿一个**必须可用**的可执行体；不可用就抛 [ModelNotEnabled]。
 * ⭐ 给那些「没有它就真的做不了事」的调用点用；
 * ⛔ 启动路径不要用它 —— 见 `main.mjs` 里那条「服务本体要起得来」的规矩。
 */
export async function requireLogicalModel(id, opts) {
  const d = await resolveLogicalModel(id, opts);
  if (d?.available !== true) throw new ModelNotEnabled(id, d?.reason ?? 'unknown', d?.hint);
  return d;
}

/**
 * 从 descriptor 里按 **role** 取一个伴随文件的绝对路径。
 * ⭐ 这是 9 处硬编码文件名的唯一替代品：`companionFile(d, 'model.sensevoice.frontend', 'cmvn')`
 * ⛔ 而不是 `path.join(frontendRoot, 'am.mvn')`。
 * ⚠ 取不到返回 null —— 调用方必须处理，⛔ 不许回落到一个猜出来的名字。
 */
export const companionFile = (descriptor, assetIdOrRole, role) => {
  const item = descriptor?.companions?.[assetIdOrRole];
  if (role !== undefined) return item?.files?.[role] ?? null;
  // Prepared bundles are already role-keyed and hand out an absolute path.
  return item?.path ?? null;
};

export const companionRoot = (descriptor, assetId) =>
  descriptor?.companions?.[assetId]?.root ?? null;

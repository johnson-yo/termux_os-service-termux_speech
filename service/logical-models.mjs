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
  /**
   * ⭐ **够不到 Manager 要重试；够到了才算答案。**
   *
   * ⚠ 真机付过这个代价：本服务与 Manager 在**同一轮 reconcile** 里启动（相差约一秒），
   *   本服务先起来，第一次 `fetch` 得到 `fetch failed`，于是三个模型全被解析成
   *   「不可用」——**而这个答案会被缓存到下次重启为止**。症状是声纹登记报
   *   `FireRedVAD logical executable is unavailable`，而那个 ctx 就在盘上、
   *   Manager 一秒后也好好的，`/model/resolve` 手工打过去一切正常。
   * ⭐ `assets.mjs` 早就为**同一件事**写过 6 次重试；那条教训没有被带进取代它的这一层。
   *   ⛔ 只对**传输失败**重试：「这个模型没启用」是一个确定的答案，重试它只是在等一件不会发生的事。
   */
  const ATTEMPTS = 6;
  let payload;
  let lastTransport = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
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
         * ⭐ 但**服务回了话**就是一个答案，⛔ 不重试。
         */
        return {
          available: false, model_id: id,
          reason: 'model_manager_unavailable',
          hint: `模型管理器不可达（${payload?.error ?? `HTTP ${r.status}`}）。`,
        };
      }
      lastTransport = null;
      break;
    } catch (error) {
      lastTransport = error;
      await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)); });
    }
  }
  if (lastTransport) {
    return {
      available: false, model_id: id,
      reason: 'model_manager_unavailable',
      hint: `模型管理器不可达（${String(lastTransport?.message ?? lastTransport)}，重试 ${ATTEMPTS} 次）。`,
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
 * 编译产物（EPContext）的两种 `kind`。
 * ⭐ `prebuilt` = Asset 装来的，`local` = 本机 `prepare` 编的；对**调用方**它们是同一类东西：
 *   **一份编译好的上下文**，⛔ 不是一张可以拿去编译的源图。
 */
const CONTEXT_KINDS = new Set(['local', 'prebuilt']);

/**
 * ⭐ **把一个 executable 翻译成 App 图会话的参数。这条规则只许存在于这里。**
 *
 * ⚠ `descriptor.executable.path` **不是** `model_path`。它多数时候是一份 EPContext：
 *   当成 `model_path` 送过去，加载器会拿它**去编译一份新的 context**，而它内部那个
 *   `ep_cache_context` 相对引用就再也解析不到自己的目录了。App 侧的 `ModelPreflight`
 *   会以 `EP_CONTEXT_AS_MODEL_PATH` 明确拒绝，并直接告诉你该传 `ctx_path`。
 * ⚠ 这条规则 `asr/controller.mjs` 早就做对了（`ctxPath = executablePath; modelPath = null`），
 *   而三个 FireRedVAD 消费者（vad / speaker-lab / acoustic-lab）在 docs/093 迁移时被漏下。
 * ⭐ **一条只在四分之三的调用点生效的规则，失效方式恰恰就是这一种**——
 *   所以判据收在这一个函数里，消费者拿到的是**已经路由好的参数**，
 *   ⛔ 它们不许知道 `kind` 这个字段存在。
 *
 * @returns `{path, kind, isContext, modelPath, ctxPath, ctxKey}`，或 null（没有可执行体）
 */
export const executableGraphArgs = (descriptor, { ctxKey = null } = {}) => {
  const exe = descriptor?.executable;
  if (!exe?.path) return null;
  const isContext = CONTEXT_KINDS.has(String(exe.kind ?? ''));
  return {
    path: exe.path,
    kind: exe.kind ?? null,
    isContext,
    modelPath: isContext ? null : exe.path,
    ctxPath: isContext ? exe.path : null,
    /**
     * ⚠ 绑版本：`fireredvad-1.1.0.ctx.onnx` → `fireredvad-1.1.0`。
     *   ⛔ 不能是裸模型名——旧版本编出来的 ctx 会被当成新版本的可执行体。
     *   给了 `ctx_path` 时 App 直接用那一份，这个键只决定「自编那份叫什么」。
     */
    ctxKey: ctxKey ?? String(exe.path).split('/').pop()
      .replace(/\.onnx$/, '').replace(/\.ctx$/, ''),
  };
};

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

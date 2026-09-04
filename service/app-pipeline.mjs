/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个已建好的 App API client（`createAndroidAppClient` 的返回值）
 * [OUTPUT]: 对外提供 createAppPipelineClient —— App 三层 Pipeline 的**薄客户端**
 * [POS]: docs/096。⭐ 这是 Speech 与 App runtime 之间**唯一**的控制通道。
 *
 * ⛔ **不在这里重建 App 的状态机**：requested/effective/state/transition/generation
 *   全部由 App 计算，本文件只做 HTTP 与一层最薄的形状校验。
 * ⭐ **desired 与 effective 是两件事**：Speech 可以保存使用者想要的三层组合，
 *   但「现在真的在跑什么」永远只能来自 `GET /api/speech/pipeline`。
 *   ⚠ 把它们混成一个值的后果很具体：切换的那几秒里 UI 会显示新后端已生效，
 *   而 App 还在 transitioning——使用者据此以为可以说话了。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const TRIGGERS = Object.freeze(['stop', 'passthrough', 'volume', 'clap']);
/**
 * ⭐ **断句层只有一个断句器：FireRedVAD**（docs/099）。
 *   `fireredvad`         = 只有 FR；
 *   `fireredvad_camplus` = FR 断句 + CAM++ 作为 **outer 本人过滤**。
 * ⛔ `camplus` 作为「另一个断句器」已退役，⚠ 但**必须继续读得懂** ——
 *   使用者 conf 里存着的就是它，报错会让一次重启把人挡在门外。
 */
export const SEGMENTS = Object.freeze(['fireredvad', 'fireredvad_camplus']);
export const SEGMENT_LEGACY_CAMPLUS = 'camplus';

/** ⛔ 旧值在**进门那一刻**规范化，不让它渗进下游任何一处判断。 */
export const canonicalSegment = (raw) =>
  (raw === SEGMENT_LEGACY_CAMPLUS ? 'fireredvad_camplus' : raw);
export const ASRS = Object.freeze(['sensevoice']);

const PIPELINE_PATH = '/api/speech/pipeline';

/** 三层取值域校验。⛔ 非法值当场拒绝，不静默回落——回落会让「我设的」与「在跑的」分家。 */
export function validateSelection({ trigger, segment, asr }) {
  if (!TRIGGERS.includes(trigger)) throw new Error(`trigger must be one of ${TRIGGERS.join('|')}`);
  const canonical = canonicalSegment(segment);
  if (!SEGMENTS.includes(canonical)) throw new Error(`segment must be one of ${SEGMENTS.join('|')}`);
  if (!ASRS.includes(asr)) throw new Error(`asr must be one of ${ASRS.join('|')}`);
  return { trigger, segment: canonical, asr };
}

/**
 * ⭐ 一次 PUT 提交**整套**三层，⛔ 不分三次调用。
 * App 侧的 transition 是串行且原子的；分三次会产生三次 transition，
 * 其中两次是中间状态（例如「新 trigger + 旧 ASR」），而那些状态没有任何人想要。
 */
export function createAppPipelineClient(android) {
  const unwrap = (r) => (r && typeof r === 'object' && 'data' in r ? r.data : r);
  return {
    async get() {
      return unwrap(await android.json(PIPELINE_PATH));
    },
    async transitions() {
      const r = unwrap(await android.json(`${PIPELINE_PATH}/transitions`));
      return r?.transitions ?? [];
    },
    /** @param selection 完整三层；@param reason 只进 App 的 transition 历史 */
    async put(selection, reason = 'termux-speech') {
      const body = { ...validateSelection(selection), reason };
      return unwrap(await android.json(PIPELINE_PATH, {
        method: 'PUT', body, timeoutMs: 240_000,
      }));
    },
    /**
     * ⭐ **runtime telemetry 的唯一取处**（docs/097）。四个只读端点各回答一件事，
     *   ⛔ 刻意不合并成一个「都给我」：它们的变化频率差一个数量级，
     *   合并之后最慢的那一个会把最快的那一个的节奏拖下来。
     *
     * ⚠ 每一个都可能单独失败（App 重启、worker 重生），所以调用方拿到的是
     *   `{ok,value}` 而不是 throw——一个域读不到不该让另外三个一起消失。
     */
    async telemetry() {
      const one = async (path) => {
        try { return { ok: true, value: unwrap(await android.json(path)) }; } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      };
      const [pipeline, activity, gate, segment, mic, policy] = await Promise.all([
        one(PIPELINE_PATH),
        one('/api/speech/activity'),
        one('/api/audio/gate/state'),
        one('/api/audio/segment/state'),
        one('/api/android/mic/status'),
        one('/api/speech/policy'),
      ]);
      return { pipeline, activity, gate, segment, mic, policy };
    },
    /** 只要 RMS 与 CAM/VAD 这两个真的每秒都在动的量。 */
    async fastTelemetry() {
      const one = async (path) => {
        try { return { ok: true, value: unwrap(await android.json(path)) }; } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      };
      const [activity, mic] = await Promise.all([
        one('/api/speech/activity'),
        one('/api/android/mic/status'),
      ]);
      return { activity, mic };
    },
    /** 只改一层，其余沿用 App 当前 **requested**（⛔ 不是 effective：切换中途 effective 是旧值）。 */
    async patch(partial, reason = 'termux-speech') {
      const now = await this.get();
      const base = now?.requested ?? now?.effective ?? {};
      return this.put({
        trigger: partial.trigger ?? base.trigger,
        segment: partial.segment ?? base.segment,
        asr: partial.asr ?? base.asr,
      }, reason);
    },
  };
}

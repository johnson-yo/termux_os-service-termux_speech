/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 内部各控制器**已经发生的事实**（转写结果、活动判定、功能可用性）
 * [OUTPUT]: `termux-os.speech-product-state.v1` —— 下游 package 唯一需要订阅的那一份
 * [POS]: ⭐ **产品状态的唯一权威。**
 *
 * 下游要知道的只有五件事：服务能不能用、有没有人在说话、是不是本人、
 * 现在识别到什么、最后一次识别到什么。
 * ⛔ 下游**不该**需要理解 RMS / FireRedVAD / CAM++ 窗口 / 声纹分数 / QNN / HTP /
 *   graph / holder / segment spool——那些是实现，实现会换，而产品语义不该跟着换。
 *
 * ⚠ 这里**不做判断，只做归一**：每个字段都由一个内部权威喂进来
 *   （谁产生事实谁调用），⛔ 页面与下游都不许自己从 RMS/holders 猜活动状态。
 * ⚠ 纯逻辑、无 IO、无定时器：它必须能在毫秒级单测里跑完一整条
 *   idle → activity → transcribing → final → idle 的生命周期。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * ⚠ 名字**刻意不叫** `termux-os.speech-state.v1`——那个名字已经被状态流的**信封**
 * 占用了（`state-hub.mjs` 的 `STATE_SCHEMA`，装的是 `{domains, version, boot_id}`）。
 * 两个不同结构共用一个 schema 名，正是 schema 本来要消灭的那种歧义：
 * 下游按名字判断结构时会拿到另一样东西。
 */
export const SCHEMA = 'termux-os.speech-product-state.v1';

/** 活动来源。⭐ 产品层枚举，⛔ 不暴露内部模块名或文件名。 */
export const SOURCE_RESIDENT = 'resident';   // 常驻语音助手（CAM++ 判定 USER 后切段）
export const SOURCE_MANUAL = 'manual';       // 手动语音输入（FireRedVAD 切段）

/** 说话的是谁。⚠ `unknown` 是**带内取值**：手动路径本来就不做声纹判断。 */
export const USER_STATE = Object.freeze(['user', 'other', 'unknown']);

/** 一段转写的状态。⭐ 与 ASR spool 的 `segment_status` 同名同义，⛔ 不另造一套词。 */
export const STATUS_INCOMPLETE = 'incomplete';
export const STATUS_COMPLETE = 'complete';

const nowDefault = () => Date.now();

/** 空的转写视图。⚠ 每个字段都在，只是为 null——⛔ 下游不该判断字段存不存在。 */
const IDLE_TRANSCRIPTION = Object.freeze({
  active: false,
  segment_id: null,
  revision: null,
  status: null,
  backend: null,
  provisional_text: null,
  final_text: null,
  started_at: null,
  updated_at: null,
});

export class SpeechPublicState {
  constructor({ now = nowDefault } = {}) {
    this.now = now;
    this.transcription = { ...IDLE_TRANSCRIPTION };
    /** ⭐ 只增不改的「最后一次说定的话」。回到 idle 之后**依然保留**。 */
    this.latest = {
      latest_final_text: null,
      latest_final_at: null,
      latest_segment_id: null,
      latest_record_id: null,
      latest_final_backend: null,
    };
    this.activity = { active: false, source: null, user_state: 'unknown', started_at: null };
    /** 每个 segment 见过的最高 revision：低于它的结果是迟到的，不许回写。 */
    this.seenRevision = new Map();
    this.changeSeq = 0;
  }

  #touch() { this.changeSeq += 1; }

  /** ⚠ 有界：常驻服务里一个只增不减的 Map 就是慢性泄漏。 */
  #remember(segmentId, revision) {
    this.seenRevision.set(segmentId, revision);
    while (this.seenRevision.size > 200) {
      this.seenRevision.delete(this.seenRevision.keys().next().value);
    }
  }

  /**
   * 语音活动。由**判定方**调用（常驻链的 CAM++，手动链的 VAD），⛔ 不是页面猜的。
   *
   * ⚠ `active` 不等于「麦克风在录」：麦克风可以常驻而没有人说话，
   *   那时 `active=false`。这是本模块存在的主要理由之一。
   */
  setActivity({ active, source = null, userState = 'unknown' } = {}) {
    const on = active === true;
    const state = USER_STATE.includes(userState) ? userState : 'unknown';
    const wasOn = this.activity.active;
    const next = {
      active: on,
      source: on ? source : null,
      user_state: on ? state : 'unknown',
      started_at: on ? (wasOn ? this.activity.started_at : this.now()) : null,
    };
    /**
     * ⭐ **没变就不算变。** 这个方法被每一帧 PCM 调用（判定方每帧都在报告它的看法），
     * 无条件 `#touch()` 会让 `change_seq` 每秒涨十几——而契约说的是
     * 「`change_seq` 没变就是没变」，一个恒在跳的序号让下游根本没法用它做去重。
     * ⚠ 真机上就是这么发现的：一句话没说，12 次采样里它涨了 248。
     */
    const same = next.active === this.activity.active
      && next.source === this.activity.source
      && next.user_state === this.activity.user_state;
    this.activity = same ? this.activity : next;
    if (!same) this.#touch();
    return this.activity;
  }

  /**
   * 一条转写结果。**转写状态的唯一入口。**
   *
   * @param segment `{segment_id, source}`
   * @param outcome `{text, revision, segment_status, retranscribe, blank}`
   */
  noteTranscript(segment, outcome = {}) {
    const segmentId = String(segment?.segment_id ?? '');
    if (!segmentId) return this.transcription;
    /**
     * ⛔ 重转写不动产品状态：那是使用者在回看历史，不是他此刻在说话。
     *   把它写进 `latest` 会让「最近识别」跳回一句几小时前的话。
     */
    if (outcome?.retranscribe === true) return this.transcription;

    const revision = Number(outcome?.revision) || 1;
    /**
     * ⭐ **迟到的 revision 不许回写。** ASR 会为同一段发多个版本，
     *   而网络/队列不保证顺序；一个旧版本盖掉新版本，页面上就是文字**倒退**。
     */
    const seen = this.seenRevision.get(segmentId);
    if (seen !== undefined && revision < seen) return this.transcription;
    this.#remember(segmentId, revision);

    const complete = outcome?.segment_status !== STATUS_INCOMPLETE;
    const text = typeof outcome?.text === 'string' ? outcome.text : '';
    const at = this.now();

    if (!complete) {
      /** ⚠ 新的一段开始时，⛔ 不许把上一条 final 当成这一段的临时文字。 */
      const sameSegment = this.transcription.segment_id === segmentId;
      this.transcription = {
        active: true,
        segment_id: segmentId,
        revision,
        status: STATUS_INCOMPLETE,
        backend: outcome?.backend ?? null,
        provisional_text: text,
        final_text: null,
        started_at: sameSegment ? this.transcription.started_at ?? at : at,
        updated_at: at,
      };
      this.#touch();
      return this.transcription;
    }

    /**
     * ⭐ 空结果**不进 latest**：识别不出东西不是「最近识别到空白」，
     *   而是「这一段没有产出」。让它进 latest 会把使用者上一句有用的话冲掉。
     */
    const blank = outcome?.blank === true || text.trim() === '';
    this.transcription = {
      active: false,
      segment_id: segmentId,
      revision,
      status: STATUS_COMPLETE,
      backend: outcome?.backend ?? null,
      provisional_text: null,
      final_text: blank ? null : text,
      started_at: this.transcription.segment_id === segmentId ? this.transcription.started_at : at,
      updated_at: at,
    };
    if (!blank) {
      this.latest = {
        latest_final_text: text,
        latest_final_at: at,
        latest_segment_id: segmentId,
        latest_record_id: outcome?.record_id ?? null,
        latest_final_backend: outcome?.backend ?? null,
        duration_ms: outcome?.duration_ms ?? null,
        audio_available: segment?.audio_available === true,
        source_kind: segment?.source_kind ?? segment?.source ?? null,
      };
    }
    this.#touch();
    return this.transcription;
  }

  /** 一轮结束、回到待机。⚠ `latest` **不清**——那正是下游要读的东西。 */
  idle() {
    this.transcription = { ...IDLE_TRANSCRIPTION };
    this.activity = { active: false, source: null, user_state: 'unknown', started_at: null };
    this.#touch();
    return this.transcription;
  }

  /**
   * 完整快照。
   *
   * @param features 各功能的可用性 `{manual:{ready,reason}, resident:{...}, ...}`
   */
  snapshot({ features = {} } = {}) {
    const list = Object.values(features);
    /**
     * ⭐ `ready` 问的是「**当前产品核心功能**能不能工作」，
     *   ⛔ 不是「所有东西都完好」。模型管理器挂了、调试 Lab 用不了、
     *   某个当前没在用的模型缺失——这些都不该让语音服务显示成不可用。
     */
    const core = [features.manual, features.transcription].filter(Boolean);
    const ready = core.length > 0 && core.every((f) => f?.ready === true);
    const degraded = list.filter((f) => f?.ready !== true).length > 0;
    const reasons = Object.entries(features)
      .filter(([, f]) => f?.ready !== true && f?.reason)
      .map(([name, f]) => `${name}:${f.reason}`);
    return {
      schema: SCHEMA,
      change_seq: this.changeSeq,
      service: {
        ready,
        degraded,
        /** ⚠ 一句机器可读的原因串；人话映射归 UI，⛔ 不在这里写中文。 */
        reason: reasons.length ? reasons.join(',') : null,
        since: this.startedAt ?? null,
        features,
      },
      activity: { ...this.activity },
      transcription: { ...this.transcription },
      latest: { ...this.latest },
      observed_at_ms: this.now(),
    };
  }
}

/**
 * 各功能的可用性。⭐ 纯函数：给它内部事实，它只回答「能不能用、不能用是为什么」。
 *
 * ⚠ 判据刻意分开而不是一锅端（任务书 §九）：模型管理器不可用**不影响**说话与识别，
 *   而识别模型缺失确实让识别不可用——把它们压成一个布尔，使用者会以为整个服务坏了。
 */
export const featureReadiness = ({
  chainAvailable = true,
  micAvailable = true,
  asrReady = false,
  asrReason = null,
  asrBackend = null,
  residentEnabled = false,
  residentReady = false,
  residentReason = null,
} = {}) => ({
  manual: {
    ready: chainAvailable === true && micAvailable === true,
    reason: chainAvailable !== true ? 'chain_unavailable'
      : micAvailable !== true ? 'microphone_unavailable' : null,
  },
  resident: {
    ready: residentEnabled === true && residentReady === true,
    reason: residentEnabled !== true ? 'disabled' : (residentReady ? null : residentReason ?? 'not_ready'),
  },
  transcription: {
    ready: asrReady === true,
    reason: asrReady === true ? null : asrReason ?? 'asr_not_ready',
    backend: asrBackend,
  },
});

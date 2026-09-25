/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Staged VAD WAVs, ASR config, Pipeline lease snapshots, the App graph HTP API,
 *          and `../storage/text.mjs` for the one blank judgement.
 * [OUTPUT]: SenseVoice transcripts, record-group admission (`onResult`), an incremental feed,
 *           bounded blank-discard diagnostics, and the standby hand-back when idle.
 * [POS]: WAV-only backend stage; it never reads PCM/Pool or controls VAD segmentation.
 *        ⭐ It is also the **admission point**: a segment becomes a record only once this stage has a
 *        verdict, so a blank result is discarded with its staging WAV instead of being rolled back
 *        out of a group it should never have entered.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeCtcIds,
  loadSenseCmvn,
  loadTokens,
  makeSenseVoiceInput,
  readWavMono16,
  SENSEVOICE_SHAPE,
  tensorSpec,
} from './features.mjs';
import { ResidentGraph } from '../residents.mjs';
import { BlankStats, normalizeTranscript } from '../storage/text.mjs';

const graphFromRuntime = (artifact) => {
  if (!artifact?.path) return null;
  const context = ['local', 'prebuilt', 'ctx'].includes(String(artifact.kind ?? ''));
  return {
    modelPath: context ? null : artifact.path,
    ctxPath: context ? artifact.path : null,
    ctxKey: artifact.ctx_key ?? path.basename(artifact.path).replace(/\.onnx$/, '').replace(/\.ctx$/, ''),
  };
};

/**
 * ⭐ 兩個檔位的檔案位置都由 **Asset map** 解析，這條鏈上沒有任何裸路徑。
 *
 * SenseVoice 曾經搬不動，因為 App 按 `htp_models_dir` 自己拼路徑。App 0.11.9 起
 * `residents` 收 `model_path` 與 `ctx_path`，那個阻塞就沒有了——現在兩邊都是
 * speech **顯式發給 App**，App 不猜位置。
 *
 * 在使用 SenseVoice 時因為缺一個它根本用不到的資產而起不來。
 */
// 首次调用要在设备上编译 mel/编码器两张图的 EPContext（分钟级，只发生一次，之后落 caches/）；
// 稳态 14 秒音频约 2.9 秒。给足余量，让「首次很慢」不至于表现为「坏掉」。

/** 只取 WAV 的 data chunk（s16le 裸流），供 /api/asr 的 pcm_b64 入口 */
const readWavPcmBytes = (file) => {
  const buf = fs.readFileSync(file);
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    let i = 12;
    while (i + 8 <= buf.length) {
      const id = buf.toString('ascii', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'data') return buf.subarray(i + 8, Math.min(buf.length, i + 8 + size));
      i += 8 + size + (size & 1);
    }
  }
  return buf;
};

const DEFAULT_RESIDENT_ID = 'tsp-asr-local';
// 准入用的保守估值（docs/051 §2.2 实测五图合计 115 MB，SenseVoice 是其中最大的一张）；
// 上机后按 `GET /api/inference/memory` 校正。
const ASR_EST_MEM_MB = 96;
/** 去重集合的上限。只用来挡住同一个段被重复 enqueue，不承担历史职责。 */
const COMPLETED_CAP = 256;
// 常驻未就绪或有界准入拒绝时的重试上限。与 `attempts` 分开计数：
// 「还没好」重试多少次都不该让一句话被判定为永久失败。
const RETRYABLE_LIMIT = 30;
const LANGUAGE_IDS = Object.freeze({
  auto: 0,
  zh: 3,
  en: 4,
  yue: 7,
  ja: 11,
  ko: 12,
});

const cloneJson = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

const atomicWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Best effort. */ }
};

const durableAppend = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

/** 一组文件在不在。返回缺了哪些，而不只是一个布尔——「缺失」要能说出缺的是什么。 */
/**
 * ⚠ 带缓存。`snapshot()` 每次都探三到六个文件，而它会被状态流按域拉起来——
 * 观测不该把磁盘 I/O 带进处理链（docs/061 §1）。2 秒过期：删掉模型仍然看得见，
 * 但不会变成每次投影一串 `existsSync`。
 */
const presenceCache = new Map();
const presence = (files, nowMs = Date.now()) => {
  const key = files.join('\u0000');
  const cached = presenceCache.get(key);
  if (cached && nowMs - cached.at_ms < 2000) return cached.value;
  const missing = files.filter((file) => !fs.existsSync(file));
  const value = { files, missing, files_present: missing.length === 0 };
  presenceCache.set(key, { value, at_ms: nowMs });
  return value;
};

export class AsrController {
  constructor({
    android,
    dataRoot,
    config,
    /**
     * ⭐ SenseVoice 的三樣東西分開給，因為它們**在不同的時候才被需要**。
     *
     * `frontendRoot`（363 KB）永遠要；`ctxRoot` 是本機架構的預編譯產物；
     * `graphRoot`（937 MB）只在沒有 ctx 時才要——App 的判據是
     * `require(ctxUsable || 源圖存在)`，有 ctx 時源圖一次都不會被打開。
     */
    frontendRoot,
    /** App `/model/prepare` 返回的 runtime artifact；Manager 不参与此接口。 */
    runtimeArtifact = null,
    /** 伴随文件的 role → 绝对路径映射（`cmvn` / `tokens`）。 */
    frontendFiles = null,
    /** 本機的 htp/qnn。⚠ 曾經寫死成 v73/2.47，在 S25 上會如實地報一個錯的值。 */
    target = null,
    residentId = DEFAULT_RESIDENT_ID,
    persistConfig = () => {},
    onEnd = () => {},
    onChange = () => {},
    /**
     * ⭐ 一句话进入**终态**时的唯一回调（转写成功且非空白，或永久失败）。
     * 记录组在这一刻才准入它——在此之前，这个段在盘上只有一份 staging WAV。
     *
     * ⛔ **空白结果不走这里**：它既不是成功也不是失败，它是「什么都没说」。
     * 参见 [discardBlank]。
     */
    onResult = () => {},
    /** 读取当前 backend 代次；每个 job 开始时冻结，防止切换后迟到结果串线。 */
    getBackendGeneration = () => null,
  }) {
    this.android = android;
    this.dataRoot = dataRoot;
    /**
     * ⛔ 旧的 `transcripts/transcripts.v1.jsonl` 与它的 256 条内存水库都已删除
     * （docs/061 §七）。转写的唯一存储真相是记录组 + SQLite 归档；这里只保留
     * 「最后一条」用于显示，以及一个**有界**的去重集合。
     * ⚠ 旧文件本身不删、不迁、不读——它就留在盘上，新代码当它不存在。
     */
    this.pendingFile = path.join(dataRoot, 'pending.v1.json');
    this.failedFile = path.join(dataRoot, 'failed.v1.jsonl');
    this.config = { ...config };
    // ⚠ 同上：缺前处理数据也不许把服务打死，否则那个能补它的页面就打不开了。
    //    `modelReady` 一并把它算进去，转写请求会明确拒绝。
    /**
     * ⚠ 没有模型不是构造失败，是一个如实报出来的**未就绪**。
     *
     * 先前这里直接抛：干净设备上服务因此起不来，而使用者失去的恰好是那个能让他
     * 去取模型的界面。缺模型时照常构造，`ready` 为 false，转写请求明确拒绝并说明原因。
     */
    /**
     * ⭐ **docs/093：只认一个「可执行体」，⛔ 不再分 ctx 与 graph。**
     *
     * `runtimeArtifact` 由 App 的 prepare 接口给出——它是**当前这台机器上能跑的那一份**，
     * 是预制还是本机编的都一样。⛔ 本类不再拼 `model.onnx`、不再判断优先级、
     * 也不再知道 v73 / QNN 是什么。
     * ⚠ 伴随文件按 **role** 取（`cmvn` / `tokens`），⛔ 不拼 `am.mvn` / `tokens.json`：
     *   文件名是 asset 的性质，写死它在换一份 asset 时不会报错，只会打开错的文件。
     */
    this.runtimeArtifact = runtimeArtifact ?? null;
    this.runtimeArtifactPath = runtimeArtifact?.path ?? null;
    this.frontendRoot = frontendRoot;
    this.cmvnPath = frontendFiles?.cmvn ?? null;
    this.tokensPath = frontendFiles?.tokens ?? null;
    this.target = target;
    this.modelReady = Boolean(this.runtimeArtifactPath && this.cmvnPath && this.tokensPath);
    /**
     * ⭐ `graphFromRuntime` 只把 App artifact 的 kind/path 投影成 graph 参数：
     *   context 只能进 `ctx_path`，source 只能进 `model_path`；ctx key 随 artifact 版本绑定。
     */
    const routed = graphFromRuntime(this.runtimeArtifact);
    this.ctxPath = routed?.ctxPath ?? null;
    this.modelPath = routed?.modelPath ?? null;
    this.graph = new ResidentGraph({
      android,
      id: residentId,
      model: 'sensevoice',
      ctxKey: routed?.ctxKey ?? null,
      // ⭐ 給絕對路徑，不只給名字（VAD 那邊踩過：只給名字時 cmvn 來自 asset store
      // 而**圖來自舊裸路徑**，兩份都在時看起來完全正常）。
      modelPath: this.modelPath,
      ctxPath: this.ctxPath,
      estMemMb: ASR_EST_MEM_MB,
      heal: this.config.output_name ? this.healFor(this.config.output_name) : null,
    });
    this.persistConfig = persistConfig;
    this.onEnd = onEnd;
    this.onChange = onChange;
    this.onResult = onResult;
    this.getBackendGeneration = getBackendGeneration;
    this.authority = false;
    this.epoch = 0;
    this.activatedAtMs = null;
    this.lastActivityAtMs = null;
    this.lastEnd = null;
    this.lastError = null;
    /** 错误必须归属到当前唯一的 SenseVoice backend。 */
    this.lastErrorBackend = null;
    this.lastInferenceMs = null;
    this.lastTranscript = null;
    this.outputName = null;
    this.tokens = null;
    this.cmvn = null;
    this.pending = [];
    this.inFlight = null;
    /**
     * segment_id → 已知的最高 revision。⭐ 判「陈旧」的唯一依据。
     * ⚠ 有界：与 completedSegments 一起裁剪，否则一次长会话会让它无限增长。
     */
    this.latestRevision = new Map();
    this.supersededCount = 0;
    this.staleDropped = 0;
    /**
     * 发布链路的有界诊断。`lastTranscript` 只证明 App 回了文字；任务要求还要能
     * 证明它有没有穿过 `onResult` 进入 public/records。旧版把 callback 异常静默吞掉，
     * 真机上因此只能看到「转写成功」与「记录没增加」两个互相矛盾的事实。
     */
    this.resultCallbackCalls = 0;
    this.resultCallbackErrors = 0;
    this.lastResultCallback = null;
    this.retryTimer = null;
    /** 去重用的段 id。⚠ 必须有界：它曾经随历史一起无限增长。 */
    this.completedSegments = [];
    this.transcriptSeq = 0;
    this.lastObservedMs = 0;
    /** 空白结果的有界诊断：只有计数、最后一次原因与时刻，不留音频也不留文本。 */
    this.blank = new BlankStats();
    this.loadPending();
    setImmediate(() => void this.pump());
  }

  configure(config) {
    this.config = { ...this.config, ...config };
    return this.publicConfig();
  }

  publicConfig() {
    return {
      enabled: this.config.enabled !== false,
      // ⚠ 这里是**白名单投影**：配置里有的字段不加进来就读不出去。
      // 我加了 `model` 却忘了这一条与 `updateAsrConfig` 的允许列表，
      // 于是下拉框既显示不出当前档位、也存不下新档位——两端都不报错。
      model: this.config.model,
      language: this.config.language,
      text_normalization: this.config.text_normalization !== false,
      idle_timeout_ms: this.config.idle_timeout_ms,
    };
  }

  loadPending() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      if (saved?.schema === 'termux-os.speech-asr-pending.v1' && Array.isArray(saved.jobs)) {
        this.pending = saved.jobs.filter((job) => (
          job?.segment?.segment_id
          && !this.completedSegments.includes(job.segment.segment_id)
        ));
      }
    } catch { /* No pending work is normal on first start. */ }
  }

  /** 输出名是模型的静态属性，记进本包配置即永久生效——探名仪式因此只发生一次。 */
  persistOutputName(outputName) {
    this.config = { ...this.config, output_name: outputName };
    try { this.persistConfig({ output_name: outputName }); } catch { /* 下次启动重探即可。 */ }
  }

  persistPending() {
    atomicWrite(this.pendingFile, {
      schema: 'termux-os.speech-asr-pending.v1',
      jobs: this.pending,
      updated_at: new Date().toISOString(),
    });
  }

  observePipeline(pipeline, nowMs = Date.now()) {
    const active = pipeline?.owner === 'speech.asr';
    const epoch = Math.max(0, Number(pipeline?.epoch) || 0);
    if (active && (!this.authority || epoch !== this.epoch)) {
      this.authority = true;
      this.epoch = epoch;
      this.activatedAtMs = Number(pipeline?.owner_since_ms) || nowMs;
      this.lastActivityAtMs = nowMs;
      this.lastEnd = null;
    } else if (!active && this.authority) {
      this.authority = false;
      this.activatedAtMs = null;
      this.lastActivityAtMs = null;
    }
    return this.snapshot(nowMs);
  }

  /**
   * @param retranscribe 这个段**已经是一条记录**（`/asr/transcribe` 的重转写路径）。
   *        两件事因此不同：它的 WAV 归记录组所有，不是 staging，**绝不能删**；
   *        结果要更新原来那一条，而不是在当前组再建一条。
   *        「新准入」与「重转写已有记录」是两个操作，不共用一条路径。
   */
  enqueue(segment, { epoch = this.epoch, retranscribe = false } = {}) {
    const segmentId = String(segment?.segment_id ?? '');
    if (!segmentId) throw new Error('ASR requires a VAD segment_id');
    if (!fs.existsSync(segment.wav_path)) throw new Error(`ASR WAV missing: ${segment.wav_path}`);
    /**
     * ⭐ 一段话的身份是 `segment_id`，一次投递的身份是 `(segment_id, revision)`。
     *
     * 把两者混成一个，同一句话的 `complete` 就会被它自己的 `incomplete` 判成重复而丢掉。
     * ⚠ 缺省 revision = 1：旧调用方（FireRedVAD 手动链、重转写）一个字都不用改，
     *   它们本来就只投一次。
     */
    const revision = Math.max(1, Number(segment?.revision) || 1);
    const status = segment?.status === 'incomplete' ? 'incomplete' : 'complete';
    const key = `${segmentId}#${revision}`;
    if ((!retranscribe && this.completedSegments.includes(key))
      || this.pending.some((job) => job.key === key)
      || this.inFlight?.key === key) {
      return { accepted: false, reason: 'duplicate_segment', segment_id: segmentId, revision };
    }
    /**
     * ⭐ 更新的修订**取消**还没开工的旧修订。
     * 让一段已经被更好的版本取代的音频排在前面推理，是把最稀缺的资源花在必然被丢弃的结果上。
     */
    /**
     * `pump()` 保持 in-flight job 在 pending[0]，直到 finally 才 shift。
     * 因此它虽然「正在跑」，仍会出现在 `this.pending` 里；把它从这里过滤掉会
     * 让 r1 结束时的 `pending.shift()` 误删掉真正要跑的 r2——这正是真机上
     * 「有文字、但 final 没进 public/records」的竞态。飞行中的旧 revision
     * 不可撤销，只能让它按 stale 规则完成；这里只取消尚未开工的旧 revision。
     */
    const inFlightKey = this.inFlight?.key ?? null;
    const superseded = this.pending.filter(
      (job) => job.key !== inFlightKey
        && job.segment.segment_id === segmentId && job.revision < revision);
    if (superseded.length) {
      this.pending = this.pending.filter((job) => !superseded.includes(job));
      this.supersededCount = (this.supersededCount ?? 0) + superseded.length;
    }
    this.latestRevision.set(segmentId, Math.max(this.latestRevision.get(segmentId) ?? 0, revision));
    const nowMs = Date.now();
    const job = {
      schema: 'termux-os.speech-asr-job.v1',
      job_id: `asr_${nowMs}_${crypto.randomBytes(3).toString('hex')}`,
      epoch: Math.max(0, Number(epoch) || 0),
      segment: cloneJson(segment),
      retranscribe: retranscribe === true,
      revision,
      status,
      key,
      attempts: 0,
      enqueued_at_ms: nowMs,
    };
    this.pending.push(job);
    this.persistPending();
    if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = nowMs;
    this.onChange();
    setImmediate(() => void this.pump());
    return { accepted: true, job_id: job.job_id, segment_id: segmentId, revision, status };
  }

  /** VAD 回收 WAV 前问这里：这个段我还要用吗（排队中或正在推理）。 */
  holdsSegment(segmentId) {
    if (!segmentId) return false;
    return this.inFlight?.segment?.segment_id === segmentId
      || this.pending.some((job) => job.segment?.segment_id === segmentId);
  }

  /**
   * 这个结果还算数吗。⭐ 判据是「同一句话有没有更新的修订」，
   * ⛔ 不是时间、不是顺序——单槽串行下 r1 的结果完全可能在 r2 入队之后才回来。
   */
  isStale(job) {
    const latest = this.latestRevision.get(job?.segment?.segment_id);
    return latest !== undefined && (job?.revision ?? 1) < latest;
  }

  /** 本機實際會用到的檔案。⚠ 有 ctx 時源圖不在清單裡——要求一個永遠不會被打開的檔案存在，
   *  等於把那 937 MB 變成事實上的必需品，ctx 就白裝了。 */
  senseFiles() {
    return [this.cmvnPath, this.tokensPath, ...(this.ctxPath ? [this.ctxPath] : [this.modelPath])]
      .filter(Boolean);
  }

  ensureFiles() {
    for (const file of this.senseFiles()) {
      if (!fs.existsSync(file)) throw new Error(`SenseVoice file missing: ${file}`);
    }
    if (!this.cmvn) this.cmvn = loadSenseCmvn(this.cmvnPath);
    if (!this.tokens) this.tokens = loadTokens(this.tokensPath);
  }

  healFor(outputName) {
    return {
      kind: 'ctc_argmax_degeneracy',
      split_input: 'speech',
      length_input: 'speech_lengths',
      check_output: outputName,
      blank: 0,
      max_depth: 3,
      min_frames: 25,
    };
  }

  /**
   * ⭐ **可执行体是一个会迟到的事实，⛔ 不是一个只在开机为真的常量。**
   *
   * ⚠ 真机复现两次：speech 比模型管理器先起来时，启动那一刻解析不到伴生文件，
   *   于是 SenseVoice 永远报 `model_not_enabled`，而**重启一次 speech 就好了**。
   *   docs/101 的同一条：**一个只在开机试一次的解析，等于把一次瞬时故障变成永久故障**。
   *
   * ⛔ 已经声明过常驻时不许就地改路径：App 的对账器看到「声明有、实际也有」会跳过，
   *   改 spec 不触发重载（docs/054 §4.4）。故只在**还没就绪**时接受更新——
   *   那正是这个缺口存在的全部场景。
   * @returns 有没有真的换过（供调用方决定要不要说出来）
   */
  applyRuntime({ artifact, frontendFiles, target } = {}) {
    if (this.modelReady) return false;
    const cmvn = frontendFiles?.cmvn ?? null;
    const tokens = frontendFiles?.tokens ?? null;
    if (!artifact?.path || !cmvn || !tokens) return false;
    this.runtimeArtifact = artifact;
    this.runtimeArtifactPath = artifact.path;
    this.cmvnPath = cmvn;
    this.tokensPath = tokens;
    if (target) this.target = target;
    const routed = graphFromRuntime(artifact);
    this.ctxPath = routed?.ctxPath ?? null;
    this.modelPath = routed?.modelPath ?? null;
    this.graph.configure({
      ctxKey: routed?.ctxKey ?? null,
      modelPath: this.modelPath,
      ctxPath: this.ctxPath,
    });
    this.modelReady = true;
    this.onChange();
    return true;
  }

  /**
   * 保证常驻声明存在，且 heal 带着**正确的**输出名。
   *
   * 输出名（`ctc_logits` 还是 `_ctc_logits`）是模型的静态属性，旧实现为了问出它做
   * `list → delete → create → delete → create`——而 docs/046 明写 QNN `createSession`
   * 失败会污染进程 QNN context 致 SIGSEGV、不允许 churn。现在探一次就记进本包配置：
   * 第一次（且仅第一次）付两次载入，此后永远单次载入、零 churn。
   *
   * 之所以必须 DELETE+PUT 而不是重新 PUT：App 的对账器看到「声明有、实际也有」就跳过，
   * 改 spec 不会触发重载（docs/054 §4.4）。
   */
  async ensureResident() {
    this.ensureFiles();
    if (this.config.output_name) {
      if (!this.graph.heal) this.graph.heal = this.healFor(this.config.output_name);
      this.outputName = this.config.output_name;
      await this.graph.declare();
      return;
    }
    await this.graph.declare();
    const io = await this.graph.io();
    const names = (io?.outputs ?? []).filter(Boolean);
    const outputName = names.includes('ctc_logits')
      ? 'ctc_logits'
      : names.includes('_ctc_logits') ? '_ctc_logits' : names[0];
    if (!outputName) throw new Error('SenseVoice resident reported no output name');
    this.outputName = outputName;
    this.persistOutputName(outputName);
    this.graph.heal = this.healFor(outputName);
    await this.graph.undeclare();
    await this.graph.declare({ force: true });
  }

  /** 只同步 App 已存在的声明；不在重启/对账路径上发起任何图操作。 */
  reconcileResident(declared) {
    this.graph.reconcileDeclared(declared);
    return this.graph.snapshot();
  }

  /**
   * 卸载常驻。⛔ **只有两个调用方**：使用者明确停链，和听写保温到期（docs/061 §一）。
   * 服务重启、dev reload、错误恢复、Mic 被抢占一律不许走到这里——那是 churn，不是卸载。
   */
  async unloadResident() {
    await this.graph.undeclare();
    this.onChange();
    return this.graph.snapshot();
  }
  /** 处理门切换前的正式准备动作；每个 backend 都走自己的正式 runtime seam。 */
  async prepareBackend(variant = this.config.model ?? 'sensevoice') {
    if (variant === 'sensevoice') {
      if (!this.modelReady) return { backend: variant, ready: false };
      await this.ensureResident();
      return { backend: variant, ready: true };
    }
    throw new Error(`ASR engine "${variant}" is not served by this pipeline`);
  }

  async transcribe(segment, variant = this.config.model ?? 'sensevoice') {
    if (variant !== 'sensevoice') {
      throw new Error(`ASR engine "${variant}" is not served by this pipeline`);
    }
    // ⛔ 缺模型时明确拒绝并说清楚该做什么。不重试——重试解决不了「东西不在盘上」。
    if (!this.modelReady) {
      throw new Error('SenseVoice has no model on this device yet. '
        + 'Open 设置 → 模型 and fetch the context for this device (or the portable graph).');
    }
    await this.ensureResident();
    const samples = readWavMono16(segment.wav_path);
    const input = makeSenseVoiceInput(samples, this.cmvn);
    if (input.validFrames <= 0) throw new Error('SenseVoice WAV is too short for one fbank frame');
    const started = Date.now();
    const result = await this.graph.run({
      iters: 1,
      warmup: 0,
      return_outputs: false,
      output_mode: 'argmax',
      inputs: {
        speech: tensorSpec('float32', SENSEVOICE_SHAPE, input.speech),
        speech_lengths: tensorSpec('int32', [1], [input.validFrames]),
        language: tensorSpec(
          'int32',
          [1],
          [LANGUAGE_IDS[this.config.language] ?? LANGUAGE_IDS.auto],
        ),
        textnorm: tensorSpec(
          'int32',
          [1],
          [this.config.text_normalization === false ? 14 : 15],
        ),
      },
    });
    const outputs = result?.outputs ?? [];
    const output = outputs.find((item) => item?.name === this.outputName) ?? outputs[0];
    if (!output || output.reduction !== 'argmax_last' || !Array.isArray(output.data)) {
      throw new Error('SenseVoice API returned no server-side argmax output');
    }
    const decoded = decodeCtcIds(output.data, this.tokens);
    return {
      ...decoded,
      valid_frames: input.validFrames,
      inference_ms: Math.max(0, Date.now() - started),
      profile: cloneJson(result?.profile),
    };
  }


  /**
   * ⛔ 空白结果的**唯一**归宿：删掉 staging WAV，记一笔有界诊断，然后什么都不做。
   *
   * 不发布、不分配 feed 游标、不进记录组、不进 SQLite、不占那 50 条名额——
   * 因为它根本没有进过组：准入在 ASR 之后，而它没通过。
   * 于是「第 50 条是空白」不需要任何特殊处理：当前组停在 49，下一条有效结果才是第 50 条。
   */
  discardBlank(job, result, reason) {
    this.blank.record(reason);
    // ⛔ 只删自己这一侧的 staging WAV。重转写拿到的是**记录组目录里**那一份，
    // 它已经归属于一条记录；删掉它就是拿一次识别失败去销毁用户的音频。
    const wav = job?.retranscribe ? null : job?.segment?.wav_path;
    if (wav) {
      // ⚠ 删不掉不是错误：VAD 的水库本来就会回收它。这里只是让它立刻消失而不是稍后。
      try { fs.rmSync(wav, { force: true }); } catch { /* 水库兜底。 */ }
    }
    this.completedSegments.push(job.key ?? job.segment.segment_id);
    while (this.completedSegments.length > COMPLETED_CAP) this.completedSegments.shift();
    // 空白也真的推了一次理——耗时如实留着，否则「空转」在耗时上看不出成本。
    this.lastInferenceMs = result?.inference_ms ?? null;
    if (this.lastErrorBackend === (job.ran_backend ?? this.config?.model ?? 'sensevoice')) {
      this.lastError = null;
      this.lastErrorBackend = null;
    }
    // ⚠ 仍要推进活跃时刻：空白也是「ASR 刚刚做完一件事」，不推进会让 idle 倒计时
    // 在一串空白里提前触发，把还在说话的人当成已经说完。
    if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = Date.now();
    return { blank: true, reason };
  }

  publish(job, result) {
    const nowMs = Date.now();
    // ⭐ 规范化是**唯一**的判空点。输出、保存、计数从此读的是同一个答案。
    const normalized = normalizeTranscript(result.text);
    if (normalized.isBlank) return this.discardBlank(job, result, normalized.reason);
    result = { ...result, text: normalized.text };
    const record = {
      schema: 'termux-os.speech-transcript.v1',
      seq: ++this.transcriptSeq,
      observed_ms: Math.max(nowMs, this.lastObservedMs + 1),
      utterance_id: `utt_${nowMs}_${crypto.randomBytes(3).toString('hex')}`,
      segment_id: job.segment.segment_id,
      pipeline_epoch: job.epoch,
      text: result.text,
      final: true,
      language: this.config.language,
      /** 当前唯一执行体，运行时事实与配置/selector保持同一来源。 */
      model: {
        id: job.ran_backend ?? this.config.model ?? 'sensevoice',
        runtime: 'android-app-ort-qnn-htp',
        precision: 'qnn-context',
        htp: this.target?.htp ?? null,
        qnn: this.target?.qnn ?? null,
        session: this.graph.id,
      },
      audio: {
        wav_path: job.segment.wav_path,
        duration_ms: job.segment.duration_ms,
        sample_rate_hz: job.segment.sample_rate_hz,
        channels: job.segment.channels,
        encoding: job.segment.encoding,
      },
      timing: {
        queued_at_ms: job.enqueued_at_ms,
        started_at_ms: this.inFlight?.started_at_ms ?? null,
        completed_at_ms: nowMs,
        inference_ms: result.inference_ms,
        profile: result.profile,
      },
    };
    // ⛔ 这里曾经 `durableAppend` 一条 `transcripts.v1.jsonl` 并推进一个 256 条的内存环。
    // 两者都删了：转写的持久化归记录组（`onResult` → `settle`），一句话只落一处。
    this.lastObservedMs = record.observed_ms;
    this.completedSegments.push(job.key ?? record.segment_id);
    while (this.completedSegments.length > COMPLETED_CAP) this.completedSegments.shift();
    this.lastTranscript = record;
    this.lastInferenceMs = result.inference_ms;
    if (this.lastErrorBackend === (job.ran_backend ?? this.config?.model ?? 'sensevoice')) {
      this.lastError = null;
      this.lastErrorBackend = null;
    }
    if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = nowMs;
    // ⭐ 记录组的 item 在这里**诞生并直接进入终态**（准入后移，docs/061 §七.2 已改写）。
    // 回调失败不得影响转写本身。
    /**
     * ⭐ 陈旧结果：**不发布**。
     *
     * r1 还在推理时 r2 就入队了，是这条链的常态（半快门先处理、全快门随后）。
     * 让 r1 的文字后到并覆盖 r2，会把一句已经定稿的话换回它的中间版本——
     * 而两者都「成功」，从状态上分辨不出来。
     * ⚠ 仍然要留痕：静默丢弃会让「这句怎么没出来」永远查不到。
     */
    if (this.isStale(job)) {
      this.staleDropped += 1;
      this.lastStale = {
        segment_id: record.segment_id,
        revision: job.revision ?? 1,
        superseded_by: this.latestRevision.get(record.segment_id) ?? null,
        backend: job.ran_backend ?? this.config.model ?? 'sensevoice',
        backend_generation: job.ran_backend_generation ?? null,
        at_ms: nowMs,
      };
      return { record, stale: true };
    }
    this.resultCallbackCalls += 1;
    this.lastResultCallback = {
      segment_id: record.segment_id,
      revision: job.revision ?? 1,
      status: job.status ?? 'complete',
      backend: job.ran_backend ?? this.config.model ?? 'sensevoice',
      backend_generation: job.ran_backend_generation ?? null,
      at_ms: nowMs,
      error: null,
    };
    try {
      this.onResult(job.segment, {
        retranscribe: job.retranscribe === true,
        /**
         * ⛔ ASR **不决定** status，它只把上游的判决原样带过去。
         * `succeeded` 说的是「这次识别成功了」，`segment_status` 说的是
         * 「这段音频是不是最终版」——两件事，压成一个就再也分不开。
         */
        status: 'succeeded',
        segment_status: job.status ?? 'complete',
        revision: job.revision ?? 1,
        text: record.text,
        model: record.model,
        /**
         * 这一句出自当前唯一支持的 backend，跟配置/selector保持同一事实源。
         */
        backend: job.ran_backend ?? this.config.model ?? 'sensevoice',
        backend_generation: job.ran_backend_generation ?? null,
        inference_ms: record.timing?.inference_ms ?? null,
        audio_duration_ms: record.audio?.duration_ms ?? job.segment?.duration_ms ?? null,
        // ⭐ feed 要靠记录组重建，所以这些字段必须**跟着结果一起**落到 item 里。
        // 少一个就是一个消费者读不到的字段，而它们读不到的时候不会报错，只会安静地少做事。
        utterance_id: record.utterance_id,
        language: record.language,
        observed_ms: record.observed_ms,
      });
    } catch (error) {
      this.resultCallbackErrors += 1;
      this.lastResultCallback = {
        ...this.lastResultCallback,
        error: String(error?.message ?? error),
      };
      console.log(`[termux-speech] result publish callback failed: ${this.lastResultCallback.error}`);
    }
    return { record };
  }

  failPermanently(job, error) {
    const record = {
      schema: 'termux-os.speech-asr-failure.v1',
      job_id: job.job_id,
      segment_id: job.segment.segment_id,
      pipeline_epoch: job.epoch,
      attempts: job.attempts,
      error: String(error?.message ?? error),
      failed_at: new Date().toISOString(),
    };
    durableAppend(this.failedFile, record);
    // 永久失败仍然入组：它有音频、有原因，只是没有文本。⛔ 静默丢弃才是错的——
    // 空白与失败是两件事，前者是「没人说话」，后者是「说了但我们没听懂」。
    try {
      this.onResult(job.segment, {
        retranscribe: job.retranscribe === true,
        status: 'failed',
        error: record.error,
        model: { id: job.ran_backend ?? this.config.model },
        backend: job.ran_backend ?? this.config.model ?? 'sensevoice',
        backend_generation: job.ran_backend_generation ?? null,
      });
    } catch { /* 同上。 */ }
  }

  async pump() {
    if (this.inFlight || this.pending.length === 0 || this.config.enabled === false) return;
    const job = this.pending[0];
    job.attempts = Math.max(0, Number(job.attempts) || 0) + 1;
    /**
     * ⭐ **这一趟是哪条 backend 跑的，必须在开跑前记下来。**
     *
     * ⚠ 以前 `publish()` 用的是 `this.config.model` —— 那是**发布那一刻**的配置。
     *   转写要几百毫秒到几秒，而使用者可以在中途切 backend：切完之后 config 已经是新的，
     *   因此结果的 backend 必须在任务开始时冻结，不能由完成时的配置猜。
     *   ⛔ 「谁产出的」是既成事实，不能由之后的配置回答。
     * ⚠ 必须写在 `this.inFlight` 快照**之前**，否则快照里那个字段永远是空的。
     */
    job.ran_backend = this.config.model ?? 'sensevoice';
    job.ran_backend_generation = this.getBackendGeneration?.() ?? null;
    this.persistPending();
    this.inFlight = { ...cloneJson(job), started_at_ms: Date.now() };
    this.onChange();
    let retry = false;
    let retryDelayMs = 1000;
    try {
      // `ran_backend` is the immutable backend choice for this in-flight attempt;
      // a UI switch may change config while the WAV is being processed.
      const result = await this.transcribe(job.segment, job.ran_backend);
      const published = this.publish(job, result);
      this.pending.shift();
      this.persistPending();
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.lastErrorBackend = job.ran_backend ?? this.config.model ?? 'sensevoice';
      // 「还没好」与「坏了」必须分开计数。App 侧 503 有两个来源——常驻在 worker 重生后
      // 尚未对账完成、以及有界准入拒绝过载（docs/051 §4.3/§5.4）——两者都不是这句话的错。
      // 旧实现把它们计入 3 次即永久失败的 attempts，于是一次 worker 重生就能烧掉一句转写。
      const retryable = error?.retryable === true;
      if (retryable) {
        // 这一趟不算这句话的过失：退回 attempts，另立一条有上界的等待计数。
        job.attempts = Math.max(0, Number(job.attempts) || 1) - 1;
        job.waits = Math.max(0, Number(job.waits) || 0) + 1;
        retryDelayMs = Number(error?.retryAfterMs) || 1000;
      }
      const exhausted = retryable ? job.waits >= RETRYABLE_LIMIT : job.attempts >= 3;
      if (exhausted) {
        this.failPermanently(job, error);
        this.pending.shift();
        if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = Date.now();
      } else {
        retry = true;
      }
      this.persistPending();
    } finally {
      this.inFlight = null;
      this.onChange();
      if (retry) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.pump();
        }, retryDelayMs);
      } else {
        setImmediate(() => void this.pump());
      }
    }
  }

  /**
   * ⭐ **这不是「识别结束门」，是「转写完了就回待命」。**
   *
   * ASR 是 spool 的消费者：上游（FireRedVAD / CAM++VAD）切完段、它转完、
   * 队列空了、一段时间没有新文件——那就没有事情要做了，把门交回去。
   * ⛔ 它**不判断使用者说完了没有**，那是切段的事；也**不能被关掉**——
   *   一个可以关掉的「交回」等于让 ASR 永久占着门，而它本来就没有资格占。
   * ⚠ ASR 不持有会话结束门；它只在转写队列空闲后把关闭权交回上游。
   */
  pollClose(nowMs = Date.now()) {
    if (!this.authority) return null;
    const currentBusy = (this.inFlight && this.inFlight.epoch === this.epoch)
      || this.pending.some((job) => job.epoch === this.epoch);
    if (currentBusy || this.lastActivityAtMs === null
      || nowMs - this.lastActivityAtMs < this.config.idle_timeout_ms) return null;
    this.lastEnd = {
      reason: 'asr_standby',
      requested_at_ms: nowMs,
      epoch: this.epoch,
    };
    return {
      owner: 'speech.asr',
      epoch: this.epoch,
      reason: this.lastEnd.reason,
      requested_at_ms: nowMs,
    };
  }

  snapshot(nowMs = Date.now()) {
    const currentBusy = (this.inFlight && this.inFlight.epoch === this.epoch)
      || this.pending.some((job) => job.epoch === this.epoch);
    const deadline = this.authority
      && !currentBusy
      && this.lastActivityAtMs !== null
      ? this.lastActivityAtMs + this.config.idle_timeout_ms
      : null;
    const senseVoice = presence(this.senseFiles());
    /**
     * ⚠ **「没有文件要检查」⛔ 不等于「文件都在」。**
     *
     * 真机上撞到过：raw/prepare 还没完成时 runtime artifact 是 null ⇒ `senseFiles()` 返回空数组
     * ⇒ `missing.length === 0` ⇒ `files_present: true` ⇒ 整条链报 **ready，而它一个模型都没有**。
     * ⭐ 一个空集合让「全部满足」与「什么都没问」变成同一个答案 —— 这两件事必须分开。
     */
    const filesPresent = senseVoice.files.length > 0 && senseVoice.files_present;
    const senseReady = this.modelReady && filesPresent
      && (this.graph.declared || this.lastErrorBackend !== 'sensevoice');
    /** ⭐ 只剩一个 backend，但 `variant` 这一层留着：它是**运行时事实**的名字，
     *   ⛔ 不是「有几个选项」的函数。⚠ 持久化的旧 backend 值在 [config.mjs] 那一层
     *   已经被强制成 `sensevoice` 并如实说出来。 */
    const variant = 'sensevoice';
    const selected = {
      id: variant,
      ...senseVoice,
      ready: senseReady,
      reason: senseReady ? null
        : (!this.modelReady ? 'model_not_enabled'
          : filesPresent ? 'sensevoice_not_ready' : 'model_missing'),
    };
    const selectedReady = selected.ready === true;
    return {
      schema: 'termux-os.speech-asr.v1',
      capability: 'speech.transcript',
      state: this.inFlight ? 'transcribing'
        : this.pending.length ? 'queued'
          : this.authority ? 'listening'
            : 'standby',
      ready: selectedReady,
      reason: selectedReady ? null : selected.reason,
      authority: {
        active: this.authority,
        owner: 'speech.asr',
        epoch: this.epoch,
        activated_at_ms: this.activatedAtMs,
      },
      model: {
        id: variant,
        model: variant,
        model_path: this.modelPath,
        ctx_path: this.ctxPath,
        cmvn_path: this.cmvnPath,
        tokens_path: this.tokensPath,
        files_present: selected.files_present,
        ready: selectedReady,
        reason: selected.reason,
        runtime: 'android-app-ort-qnn-htp',
        precision: 'qnn-context',
        /**
         * ⚠ 這兩個曾經是寫死的 `'v73'` / `'2.47'`——在 S25（v79）上它會如實地報一個錯的值，
         * 和 docs/060 那個「`model.id` 是常量 `sensevoice`」是同一個形狀：
         * 一個名叫「跑在什麼架構上」的欄位不能是常量。現在來自本機裝的那份 ctx 的 target。
         */
        htp: this.target?.htp ?? null,
        qnn: this.target?.qnn ?? null,
        session: this.graph.id,
        session_loaded: this.graph.declared,
        residency: this.graph.snapshot(),
        output_name_cached: Boolean(this.config.output_name),
        output_name: this.outputName,
        selected,
      },
      queue: {
        depth: this.pending.length,
        /** ⚠ `ran_backend` 让「切换那一瞬正在跑的是谁」可观测，⛔ 不用事后猜。 */
        in_flight: cloneJson(this.inFlight),
        in_flight_backend: this.inFlight?.ran_backend ?? null,
        pending_file: this.pendingFile,
      },
      /** ⚠ 名字从 `ending` 改成 `standby`：它说的是「多久没事做就交回门」。 */
      standby: {
        timeout_ms: this.config.idle_timeout_ms,
        deadline_ms: deadline,
        remaining_ms: deadline === null ? null : Math.max(0, deadline - nowMs),
        last_activity_at_ms: this.lastActivityAtMs,
        last: cloneJson(this.lastEnd),
      },
      transcripts: {
        // ⚠ `total` 只数**本次运行转写了几句**。它曾经是索引文件的行数（真机上 3200），
        // 而那个数字对「现在怎么样」不提供任何信息（docs/061 §七）。
        // 历史归记录组：盘上哪两组、归档里多少条，由 `records` 域回答。
        published_this_run: this.transcriptSeq,
        /**
         * ⭐ 被丢弃的空白结果。**只有计数、最后一次原因与时刻**，不留音频不留文本。
         * 它值得显示：一串持续增长而 `published_this_run` 不动的空白，
         * 说明流水线在空转（docs/060 实测过几分钟 254 条无人说话的转写）——
         * 而这件事在把空白当成正常转写写进组里的时候是看不见的。
         */
        blank_discarded: this.blank.snapshot(),
        last: cloneJson(this.lastTranscript),
        http_feed: '/asr/transcripts',
        websocket: '/asr/transcripts/ws',
        store: 'records',
      },
      publish: {
        result_callback_calls: this.resultCallbackCalls,
        result_callback_errors: this.resultCallbackErrors,
        stale_dropped: this.staleDropped,
        superseded: this.supersededCount,
        last_stale: cloneJson(this.lastStale),
        last_result_callback: cloneJson(this.lastResultCallback),
      },
      last_inference_ms: this.lastInferenceMs,
      last_error: this.lastError,
      observed_at_ms: nowMs,
    };
  }

  close() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

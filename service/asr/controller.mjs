/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Staged VAD WAVs, ASR config, Pipeline lease snapshots, the App graph HTP API,
 *          and `../storage/text.mjs` for the one blank judgement.
 * [OUTPUT]: SenseVoice transcripts, record-group admission (`onResult`), an incremental feed,
 *           bounded blank-discard diagnostics, and ASR-owned keyword/timeout idle requests.
 * [POS]: WAV-only SenseVoice stage; it never reads PCM/Pool or controls VAD segmentation.
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

/**
 * ⭐ 兩個檔位的檔案位置都由 **Asset map** 解析，這條鏈上沒有任何裸路徑。
 *
 * SenseVoice 曾經搬不動，因為 App 按 `htp_models_dir` 自己拼路徑。App 0.11.9 起
 * `residents` 收 `model_path` 與 `ctx_path`，那個阻塞就沒有了——現在兩邊都是
 * speech **顯式發給 App**，App 不猜位置。
 *
 * ⚠ **按檔位解析**：選了哪一檔才問哪一檔。全部先解析一遍會讓沒裝 Qwen 的裝置
 * 在使用 SenseVoice 時因為缺一個它根本用不到的資產而起不來。
 */
const QWEN_ASSETS = Object.freeze({
  encoder: 'model.qwen3asr.encoder',
  'qwen3-q4': 'model.qwen3asr.decoder.q4',
  'qwen3-q8': 'model.qwen3asr.decoder.q8',
});
const QWEN_FILES = Object.freeze({
  mel: 'qwen3asr_mel.onnx',
  encoder: 'qwen3asr_enc_tanh_fp16.onnx',
  'qwen3-q4': 'qwen3asr-q4out.gguf',
  'qwen3-q8': 'Qwen3-ASR-0.6B-Q8_0.gguf',
});
// 首次调用要在设备上编译 mel/编码器两张图的 EPContext（分钟级，只发生一次，之后落 caches/）；
// 稳态 14 秒音频约 2.9 秒。给足余量，让「首次很慢」不至于表现为「坏掉」。
const QWEN_SESSION_TIMEOUT_MS = 180_000;
const QWEN_TRANSCRIBE_TIMEOUT_MS = 300_000;

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

const normalizedKeyword = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/\s+/g, '');

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
    graphRoot = null,
    ctxRoot = null,
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
    /**
     * Asset map 的解析器。注入而非 import：本檔不該知道 Framework 在哪、憑證是什麼，
     * 那是 `service/assets.mjs` 的事。單測也因此不需要一個 Framework 就能驅動它。
     */
    resolveAsset = async (id) => { throw new Error(`no asset resolver injected for ${id}`); },
  }) {
    this.android = android;
    this.resolveAsset = resolveAsset;
    this.qwenPathCache = null;
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
    if (!frontendRoot) throw new Error('AsrController requires a resolved frontendRoot from the asset map');
    /**
     * ⚠ 没有模型不是构造失败，是一个如实报出来的**未就绪**。
     *
     * 先前这里直接抛：干净设备上服务因此起不来，而使用者失去的恰好是那个能让他
     * 去取模型的界面。缺模型时照常构造，`ready` 为 false，转写请求明确拒绝并说明原因。
     */
    this.modelReady = Boolean(ctxRoot || graphRoot);
    this.frontendRoot = frontendRoot;
    this.graphRoot = graphRoot;
    // EPContext wrapper 的檔名由 Asset Package 的 `files.graph` 決定；
    // ⚠ wrapper 內部以 `./model.bin` 引用 context binary，兩者必須同目錄同名。
    this.ctxPath = ctxRoot ? path.join(ctxRoot, 'model.onnx') : null;
    this.target = target;
    this.modelPath = graphRoot ? path.join(graphRoot, 'model.onnx') : null;
    this.cmvnPath = path.join(frontendRoot, 'am.mvn');
    this.tokensPath = path.join(frontendRoot, 'tokens.json');
    this.graph = new ResidentGraph({
      android,
      id: residentId,
      model: 'sensevoice',
      ctxKey: 'sensevoice',
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
    this.authority = false;
    this.epoch = 0;
    this.activatedAtMs = null;
    this.lastActivityAtMs = null;
    this.lastEnd = null;
    this.lastError = null;
    this.lastInferenceMs = null;
    this.lastTranscript = null;
    this.outputName = null;
    this.tokens = null;
    this.cmvn = null;
    this.pending = [];
    this.inFlight = null;
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
      keyword_end_enabled: this.config.keyword_end_enabled !== false,
      end_keywords: [...(this.config.end_keywords ?? [])],
      timeout_end_enabled: this.config.timeout_end_enabled !== false,
      idle_timeout_ms: this.config.idle_timeout_ms,
    };
  }

  loadPending() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      if (saved?.schema === 'termux-os.speech-asr-pending.v1' && Array.isArray(saved.jobs)) {
        this.pending = saved.jobs.filter((job) => (
          job?.segment?.segment_id
          && !this.completedSegments.has(job.segment.segment_id)
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
    if (this.completedSegments.includes(segmentId)
      || this.pending.some((job) => job.segment.segment_id === segmentId)
      || this.inFlight?.segment?.segment_id === segmentId) {
      return { accepted: false, reason: 'duplicate_segment', segment_id: segmentId };
    }
    const nowMs = Date.now();
    const job = {
      schema: 'termux-os.speech-asr-job.v1',
      job_id: `asr_${nowMs}_${crypto.randomBytes(3).toString('hex')}`,
      epoch: Math.max(0, Number(epoch) || 0),
      segment: cloneJson(segment),
      retranscribe: retranscribe === true,
      attempts: 0,
      enqueued_at_ms: nowMs,
    };
    this.pending.push(job);
    this.persistPending();
    if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = nowMs;
    this.onChange();
    setImmediate(() => void this.pump());
    return { accepted: true, job_id: job.job_id, segment_id: segmentId };
  }

  /** VAD 回收 WAV 前问这里：这个段我还要用吗（排队中或正在推理）。 */
  holdsSegment(segmentId) {
    if (!segmentId) return false;
    return this.inFlight?.segment?.segment_id === segmentId
      || this.pending.some((job) => job.segment?.segment_id === segmentId);
  }

  /** 本機實際會用到的檔案。⚠ 有 ctx 時源圖不在清單裡——要求一個永遠不會被打開的檔案存在，
   *  等於把那 937 MB 變成事實上的必需品，ctx 就白裝了。 */
  senseFiles() {
    return [this.cmvnPath, this.tokensPath, ...(this.ctxPath ? [this.ctxPath] : [this.modelPath])];
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

  /**
   * 卸载常驻。⛔ **只有两个调用方**：使用者明确停链，和听写保温到期（docs/061 §一）。
   * 服务重启、dev reload、错误恢复、Mic 被抢占一律不许走到这里——那是 churn，不是卸载。
   */
  async unloadResident() {
    await this.graph.undeclare();
    this.onChange();
    return this.graph.snapshot();
  }

  /**
   * Qwen3-ASR 分支：走 App 的 /api/asr 端到端（mel/編碼器在 HTP，解碼在 ggml-hexagon）。
   * ⚠ 音頻走 `pcm_b64` 而非 `wav_path`——WAV 落在本包的私域，App 是另一個 uid **讀不到**。
   * 15 秒 @16k s16le 約 480KB，base64 後 640KB，走 loopback HTTP 沒問題（不是 Binder）。
   */
  async transcribeQwen(segment, variant) {
    const paths = await this.qwenPaths(variant);
    const gguf = paths.decoder;
    if (this.qwenLoaded !== gguf) {
      await this.android.json('/api/asr/session', {
        method: 'POST',
        body: { model_path: gguf },
        // ⚠ app-api 默认 8 秒，而这两步都会超。GGUF 热载入实测约 1.5 秒，
        // 但 worker 刚重生时要连权重一起读；编码器/mel 的 EPContext 首次编译更是分钟级。
        // 默认超时会把「慢」误报成「坏」，而重试只会让它从头再慢一次。
        timeoutMs: QWEN_SESSION_TIMEOUT_MS,
      });
      this.qwenLoaded = gguf;
    }
    const pcm = readWavPcmBytes(segment.wav_path);
    const started = Date.now();
    let data;
    try {
      data = await this.android.json('/api/asr/transcribe', {
        method: 'POST',
        body: {
          pcm_b64: pcm.toString('base64'),
          mel_path: paths.mel,
          encoder_path: paths.encoder,
        },
        timeoutMs: QWEN_TRANSCRIBE_TIMEOUT_MS,
      });
    } catch (error) {
      // 會話可能被 LMK 帶走；下次重新載入而不是把這個檔位永久記成已載入
      this.qwenLoaded = null;
      throw error;
    }
    return {
      text: String(data?.text ?? '').trim(),
      tokens: [],
      valid_frames: Number(data?.n_audio_tokens) || 0,
      inference_ms: Math.max(0, Date.now() - started),
      profile: cloneJson(data?.timings_ms),
    };
  }

  async transcribe(segment) {
    const variant = this.config.model ?? 'sensevoice';
    if (variant !== 'sensevoice') return this.transcribeQwen(segment, variant);
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
   * 解析選中檔位需要的三個路徑。⚠ **只問這一檔**：全部先解析一遍會讓沒裝 Qwen 的
   * 裝置在使用 SenseVoice 時，因為缺一個它根本用不到的資產而起不來。
   *
   * ⛔ 沒有回落。缺了就是缺了，錯誤原樣上拋——一個「找不到就用舊路徑」的分支會讓
   * 「這台機器到底裝了什麼」變成一個沒人答得出的問題。
   */
  async qwenPaths(variant) {
    if (this.qwenPathCache?.variant === variant) return this.qwenPathCache;
    const encoder = await this.resolveAsset(QWEN_ASSETS.encoder);
    const decoder = await this.resolveAsset(QWEN_ASSETS[variant]);
    const resolved = {
      variant,
      mel: path.join(encoder.root, QWEN_FILES.mel),
      encoder: path.join(encoder.root, QWEN_FILES.encoder),
      decoder: path.join(decoder.root, QWEN_FILES[variant]),
    };
    this.qwenPathCache = resolved;
    return resolved;
  }

  matchingEndKeyword(text) {
    if (this.config.keyword_end_enabled === false) return null;
    const normalized = normalizedKeyword(text);
    if (!normalized) return null;
    return (this.config.end_keywords ?? []).find((keyword) => {
      const candidate = normalizedKeyword(keyword);
      return candidate && normalized.includes(candidate);
    }) ?? null;
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
    this.completedSegments.push(job.segment.segment_id);
    while (this.completedSegments.length > COMPLETED_CAP) this.completedSegments.shift();
    // 空白也真的推了一次理——耗时如实留着，否则「空转」在耗时上看不出成本。
    this.lastInferenceMs = result?.inference_ms ?? null;
    this.lastError = null;
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
    const keyword = this.matchingEndKeyword(result.text);
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
      // ⚠ 这里曾经无条件写 `id: 'sensevoice'`——即使这句话实际是 Qwen 转的。
      // 于是历史记录里每一条都自称 SenseVoice，而「换了模型」这件事在事后完全不可见：
      // 一个字段既然叫「用了哪个模型」，就不能是个常量。
      model: (this.config.model ?? 'sensevoice') === 'sensevoice'
        ? {
          id: 'sensevoice',
          runtime: 'android-app-ort-qnn-htp',
          precision: 'qnn-context',
          htp: 'v73',
          qnn: '2.47',
          session: this.graph.id,
        }
        : {
          id: this.config.model,
          runtime: 'android-app-asr-endpoint',
          precision: this.config.model === 'qwen3-q4' ? 'q4_0' : 'q8_0',
        },
      audio: {
        wav_path: job.segment.wav_path,
        duration_ms: job.segment.duration_ms,
        sample_rate_hz: job.segment.sample_rate_hz,
        channels: job.segment.channels,
        encoding: job.segment.encoding,
      },
      end_gate: {
        keyword_matched: keyword,
        requested_idle: Boolean(keyword),
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
    this.completedSegments.push(record.segment_id);
    while (this.completedSegments.length > COMPLETED_CAP) this.completedSegments.shift();
    this.lastTranscript = record;
    this.lastInferenceMs = result.inference_ms;
    this.lastError = null;
    if (this.authority && job.epoch === this.epoch) this.lastActivityAtMs = nowMs;
    // ⭐ 记录组的 item 在这里**诞生并直接进入终态**（准入后移，docs/061 §七.2 已改写）。
    // 回调失败不得影响转写本身。
    try {
      this.onResult(job.segment, {
        retranscribe: job.retranscribe === true,
        status: 'succeeded',
        text: record.text,
        model: record.model,
        inference_ms: record.timing?.inference_ms ?? null,
        // ⭐ feed 要靠记录组重建，所以这些字段必须**跟着结果一起**落到 item 里。
        // 少一个就是一个消费者读不到的字段，而它们读不到的时候不会报错，只会安静地少做事。
        utterance_id: record.utterance_id,
        language: record.language,
        keyword_matched: record.end_gate?.keyword_matched ?? null,
        observed_ms: record.observed_ms,
      });
    } catch { /* 记录组的问题不能传染回转写。 */ }
    return { record, keyword };
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
        model: { id: this.config.model },
      });
    } catch { /* 同上。 */ }
  }

  async pump() {
    if (this.inFlight || this.pending.length === 0 || this.config.enabled === false) return;
    const job = this.pending[0];
    job.attempts = Math.max(0, Number(job.attempts) || 0) + 1;
    this.persistPending();
    this.inFlight = { ...cloneJson(job), started_at_ms: Date.now() };
    this.onChange();
    let retry = false;
    let retryDelayMs = 1000;
    try {
      const result = await this.transcribe(job.segment);
      const published = this.publish(job, result);
      this.pending.shift();
      this.persistPending();
      if (published.keyword && this.authority && job.epoch === this.epoch) {
        this.lastEnd = {
          reason: 'asr_end_keyword',
          keyword: published.keyword,
          requested_at_ms: Date.now(),
          epoch: job.epoch,
        };
        this.onEnd({
          owner: 'speech.asr',
          epoch: job.epoch,
          reason: this.lastEnd.reason,
          metadata: {
            keyword: published.keyword,
            transcript_seq: published.record.seq,
            segment_id: published.record.segment_id,
          },
        });
      }
    } catch (error) {
      this.lastError = String(error?.message ?? error);
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

  pollClose(nowMs = Date.now()) {
    if (!this.authority || this.config.timeout_end_enabled === false) return null;
    const currentBusy = (this.inFlight && this.inFlight.epoch === this.epoch)
      || this.pending.some((job) => job.epoch === this.epoch);
    if (currentBusy || this.lastActivityAtMs === null
      || nowMs - this.lastActivityAtMs < this.config.idle_timeout_ms) return null;
    this.lastEnd = {
      reason: 'asr_idle_timeout',
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
      && this.config.timeout_end_enabled !== false
      && !currentBusy
      && this.lastActivityAtMs !== null
      ? this.lastActivityAtMs + this.config.idle_timeout_ms
      : null;
    const senseVoice = presence(this.senseFiles());
    const filesPresent = senseVoice.files_present;
    // ⚠ 上面那个 `files_present` 回答的**永远是 SenseVoice**。选了 Qwen 档位时它照样
    // 返回 true/false，但答的不是「我选的这个模型在不在」——读得出值，含义却是错的
    // （docs/056 的同一形状）。所以被选中的那一档单独探，名字里写清楚它是谁。
    const variant = this.config.model ?? 'sensevoice';
    // ⚠ Qwen 檔位的檔案位置由 Asset map 給，只有解析過才知道；還沒解析時如實報
    // 「尚未解析」而不是一個看起來像「缺失」的 false——那兩件事要做的處置完全不同。
    const selected = variant === 'sensevoice'
      ? { id: variant, ...senseVoice }
      : (this.qwenPathCache?.variant === variant
        ? { id: variant, ...presence([this.qwenPathCache.decoder, this.qwenPathCache.mel, this.qwenPathCache.encoder]) }
        : { id: variant, files: [], missing: [], files_present: null, reason: 'asset_not_resolved_yet' });
    return {
      schema: 'termux-os.speech-asr.v1',
      capability: 'speech.transcript',
      state: this.inFlight ? 'transcribing'
        : this.pending.length ? 'queued'
          : this.authority ? 'listening'
            : 'standby',
      ready: filesPresent && (this.graph.declared || !this.lastError),
      authority: {
        active: this.authority,
        owner: 'speech.asr',
        epoch: this.epoch,
        activated_at_ms: this.activatedAtMs,
      },
      model: {
        id: 'sensevoice',
        model: this.config.model ?? 'sensevoice',
        model_path: this.modelPath,
        ctx_path: this.ctxPath,
        cmvn_path: this.cmvnPath,
        tokens_path: this.tokensPath,
        files_present: filesPresent,
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
        residency: this.graph.snapshot(),
        output_name_cached: Boolean(this.config.output_name),
        output_name: this.outputName,
        selected,
      },
      queue: {
        depth: this.pending.length,
        in_flight: cloneJson(this.inFlight),
        pending_file: this.pendingFile,
      },
      ending: {
        keyword_enabled: this.config.keyword_end_enabled !== false,
        end_keywords: [...(this.config.end_keywords ?? [])],
        timeout_enabled: this.config.timeout_end_enabled !== false,
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

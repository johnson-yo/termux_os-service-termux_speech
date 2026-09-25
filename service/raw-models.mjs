/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Raw package cards from Manager 0.4.4 and App model/prepare facts.
 * [OUTPUT]: The speech model mapping, four-layer readiness projection, and the
 *           raw-source -> App runtime handoff.
 * [POS]: P0 raw-only model boundary. Manager owns raw packages; App owns every
 *        executable, context, resident, and inference fact.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import path from 'node:path';

export const MANAGER_WEB_PATH = '/packages/github.termux-os.service.hf-model-manager/';
export const RAW_PACKAGE_SCHEMA = 'termux-os.raw-model-packages.v1';
export const SPEECH_MODEL_SCHEMA = 'termux-os.speech-model-layers.v1';

/**
 * Logical ids remain speech's internal business ids only. They are not sent to
 * Manager as lifecycle commands and never identify an App executable.
 */
export const MODEL_REQUIREMENTS = Object.freeze({
  'model.sensevoice': Object.freeze({
    modelId: 'sensevoice',
    name: 'SenseVoice',
    feature: 'asr',
    description: '语音转文字。',
    packageKey: 'huggingface:johnson-yo/termux_os-asset-sensevoice-htp-onnx',
    files: Object.freeze([
      Object.freeze({ path: 'model.onnx', role: 'model' }),
      Object.freeze({ path: 'am.mvn', role: 'cmvn' }),
      Object.freeze({ path: 'tokens.json', role: 'tokens' }),
    ]),
    prepareRole: 'model',
  }),
  'model.campplus': Object.freeze({
    modelId: 'campplus',
    name: 'CAM++',
    feature: 'speaker',
    description: '说话人判断与声纹。',
    packageKey: 'huggingface:johnson-yo/termux_os-asset-campplus-htp-onnx',
    files: Object.freeze([
      Object.freeze({ path: 'htp-t148/campplus.onnx', role: 'model' }),
    ]),
    prepareRole: 'model',
  }),
  'model.fireredvad': Object.freeze({
    modelId: 'fireredvad',
    name: 'FireRedVAD',
    feature: 'vad',
    description: '语音活动检测。',
    packageKey: 'huggingface:johnson-yo/termux_os-asset-fireredvad-htp-onnx',
    files: Object.freeze([
      Object.freeze({ path: 'model.onnx', role: 'model' }),
      Object.freeze({ path: 'cmvn.bin', role: 'cmvn' }),
    ]),
    prepareRole: 'model',
  }),
});

export const MODEL_IDS = Object.freeze(Object.keys(MODEL_REQUIREMENTS));

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const absolute = (value) => typeof value === 'string' && path.isAbsolute(value) ? value : null;

export const requirementFor = (modelId) => MODEL_REQUIREMENTS[modelId] ?? null;

export const packageVersion = (card) => String(
  card?.package_version ?? card?.upstream_revision ?? 'unknown',
);

export const findCard = (cards, modelId) => {
  const requirement = requirementFor(modelId);
  if (!requirement) return null;
  return (cards ?? []).find((card) => card?.key === requirement.packageKey) ?? null;
};

const findFile = (card, wanted) => (card?.files ?? []).find((file) => (
  file?.path === wanted.path || file?.local_path === wanted.path || file?.remote_path === wanted.path
));

/**
 * Only Manager's absolute `file.local.path` is accepted. `local_path` and
 * `path.join('/sdcard/...')` are deliberately not fallbacks.
 */
export const rawFileFacts = (card, modelId) => {
  const requirement = requirementFor(modelId);
  if (!requirement || !card) return [];
  return requirement.files.map((wanted) => {
    const file = findFile(card, wanted);
    const localPath = absolute(file?.local?.path);
    const state = file?.local?.state ?? 'none';
    return {
      ...wanted,
      state,
      path: localPath,
      size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
      sha256: file?.sha256 ?? null,
      source_path: file?.path ?? wanted.path,
      present: state === 'complete' && Boolean(localPath),
    };
  });
};

export const rawLayer = (card, modelId, managerReason = null) => {
  const files = rawFileFacts(card, modelId);
  if (managerReason) return {
    state: 'unknown', reason: managerReason, complete: false, package_key: requirementFor(modelId)?.packageKey ?? null,
    package_version: null, files: [], usage: null,
  };
  if (!card) return {
    state: 'none', reason: 'raw_missing', complete: false,
    package_key: requirementFor(modelId)?.packageKey ?? null, package_version: null, files: [], usage: null,
  };
  const complete = files.length > 0 && files.every((file) => file.present);
  const state = complete ? 'complete'
    : files.some((file) => file.state === 'partial' || file.state === 'complete') ? 'partial' : 'none';
  return {
    state,
    reason: complete ? null : 'raw_missing',
    complete,
    package_key: card.key ?? null,
    package_version: packageVersion(card),
    status: card.status ?? 'unknown',
    files,
    usage: card.usage ?? null,
  };
};

export const rawPath = (raw, role) => raw?.files?.find((file) => file.role === role)?.path ?? null;

export const prepareRequest = (modelId, raw) => {
  const requirement = requirementFor(modelId);
  const sourcePath = rawPath(raw, requirement?.prepareRole ?? 'model');
  if (!requirement || !raw?.complete || !sourcePath) return null;
  const modelVersion = raw.package_version || 'unknown';
  return {
    model_id: requirement.modelId,
    model_version: modelVersion,
    mode: 'compile_local',
    source_path: sourcePath,
    // This is an App cache key, not a Manager executable identity. It never
    // travels back to Manager and is returned as runtime metadata only.
    ctx_key: `${requirement.modelId}-${modelVersion}`.replace(/[^A-Za-z0-9._-]/g, '-'),
  };
};

export const appArtifact = (value, request) => {
  const artifact = value?.artifact;
  const artifactPath = absolute(artifact?.path);
  if (value?.ok !== true || !artifactPath || value?.inference_verified !== true) return null;
  return {
    kind: artifact.kind ?? 'app',
    path: artifactPath,
    model_id: request.model_id,
    model_version: request.model_version,
    ctx_key: request.ctx_key,
    target: value.target ?? null,
    load_verified: value.load_verified === true,
    inference_verified: value.inference_verified === true,
    ctx_cache: value.ctx_cache ?? null,
  };
};

const emptyRuntime = () => ({
  state: 'not_prepared',
  reason: 'app_not_prepared',
  prepared: false,
  artifact: null,
  last_error: null,
});

const emptyResident = () => ({ state: 'unknown', loaded: false, reason: 'resident_unknown' });

const cleanResident = (value, requirement) => {
  if (!value || typeof value !== 'object') return emptyResident();
  const wanted = requirement?.modelId;
  const candidates = Array.isArray(value.residents) ? value.residents : [];
  const resident = candidates.find((item) => {
    const model = String(item?.model ?? item?.model_id ?? '');
    const id = String(item?.id ?? item?.name ?? '');
    return model === wanted || id.includes(wanted ?? '__missing__');
  });
  if (!resident) return { state: 'unloaded', loaded: false, reason: 'resident_not_loaded' };
  const loaded = resident.loaded === true || resident.state === 'loaded' || resident.session_loaded === true;
  return {
    state: loaded ? 'loaded' : (resident.state ?? 'unknown'),
    loaded,
    reason: loaded ? null : (resident.error ?? 'resident_not_loaded'),
    id: resident.id ?? resident.name ?? null,
  };
};

/**
 * Coordinates facts only; it never owns an App resident. The App's existing
 * pipeline/resident APIs remain the sole execution owner.
 */
export class SpeechModelRuntime {
  constructor({ manager, android, onChange = () => {} } = {}) {
    this.manager = manager;
    this.android = android;
    this.onChange = onChange;
    this.cards = null;
    this.managerState = { available: null, reason: null, message: null };
    this.models = new Map(MODEL_IDS.map((id) => [id, {
      raw: null, runtime: emptyRuntime(), resident: emptyResident(),
    }]));
    this.refreshInFlight = null;
    this.prepareInFlight = new Map();
    // App ModelPrepare is deliberately single-flight because every compile probes the
    // same App worker and temporarily recycles ORT. Keep the model jobs independent in
    // the UI, but serialize their App handoffs here.
    this.prepareQueue = Promise.resolve();
  }

  async refresh({ force = false } = {}) {
    if (this.refreshInFlight && !force) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const result = await this.manager.packages();
      if (!result.ok) {
        const reason = result.unavailable === 'manager_unreachable'
          ? 'manager_unreachable' : (result.error ?? 'manager_contract_error');
        const contract = result.unavailable ? reason : 'manager_contract_error';
        this.managerState = {
          available: false,
          reason: contract,
          message: result.detail ?? result.error ?? contract,
        };
        for (const id of MODEL_IDS) {
          const current = this.models.get(id);
          current.raw = rawLayer(null, id, contract);
        }
        return { ok: false, reason: contract };
      }
      const value = result.value;
      if (value?.ok !== true || value.schema !== RAW_PACKAGE_SCHEMA || !Array.isArray(value.packages)) {
        this.managerState = { available: false, reason: 'manager_contract_error', message: 'invalid raw package response' };
        for (const id of MODEL_IDS) this.models.get(id).raw = rawLayer(null, id, 'manager_contract_error');
        return { ok: false, reason: 'manager_contract_error' };
      }
      this.cards = value.packages;
      this.managerState = { available: true, reason: null, message: null };
      for (const id of MODEL_IDS) this.models.get(id).raw = rawLayer(findCard(this.cards, id), id);
      this.onChange();
      return { ok: true, value };
    })().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  async inspect(modelId, { refresh = false } = {}) {
    if (!requirementFor(modelId)) return { ok: false, reason: 'unknown_model' };
    if (refresh || this.cards === null) await this.refresh({ force: refresh });
    return { ok: true, model_id: modelId, ...this.models.get(modelId) };
  }

  async prepare(modelId) {
    if (!requirementFor(modelId)) return { ok: false, reason: 'unknown_model' };
    if (this.prepareInFlight.has(modelId)) return this.prepareInFlight.get(modelId);
    const prior = this.prepareQueue;
    const promise = prior.then(() => (async () => {
      const inspected = await this.inspect(modelId);
      if (!inspected.ok) return inspected;
      if (inspected.raw?.complete !== true) {
        const current = this.models.get(modelId);
        current.runtime = { ...emptyRuntime(), reason: inspected.raw?.reason ?? 'raw_missing' };
        return { ok: false, model_id: modelId, reason: current.runtime.reason, raw: current.raw };
      }
      if (inspected.runtime?.prepared === true) return { ok: true, model_id: modelId, runtime: inspected.runtime };
      const request = prepareRequest(modelId, inspected.raw);
      if (!request) return { ok: false, model_id: modelId, reason: 'raw_missing' };
      try {
        const value = await this.android.json('/api/inference/model/prepare', {
          method: 'POST', body: request, timeoutMs: 30 * 60_000,
        });
        const artifact = appArtifact(value, request);
        const current = this.models.get(modelId);
        if (!artifact) {
          current.runtime = {
            state: 'failed', reason: 'app_prepare_failed', prepared: false,
            artifact: null, last_error: value?.error ?? { code: 'prepare_failed', stage: value?.stage ?? null },
          };
          this.onChange();
          return { ok: false, model_id: modelId, reason: 'app_prepare_failed', value };
        }
        current.runtime = {
          state: 'prepared', reason: null, prepared: true, artifact, last_error: null,
        };
        this.onChange();
        return { ok: true, model_id: modelId, runtime: current.runtime, value };
      } catch (error) {
        const current = this.models.get(modelId);
        current.runtime = {
          state: 'failed', reason: 'app_prepare_failed', prepared: false, artifact: null,
          last_error: String(error?.message ?? error),
        };
        this.onChange();
        return { ok: false, model_id: modelId, reason: 'app_prepare_failed', detail: current.runtime.last_error };
      }
    })());
    this.prepareQueue = promise.catch(() => {});
    const tracked = promise.finally(() => this.prepareInFlight.delete(modelId));
    this.prepareInFlight.set(modelId, tracked);
    return tracked;
  }

  async residents() {
    if (!this.android?.json) return { ok: false, reason: 'resident_unknown' };
    try {
      const value = await this.android.json('/api/inference/residents');
      for (const id of MODEL_IDS) {
        const current = this.models.get(id);
        current.resident = cleanResident(value, requirementFor(id));
      }
      this.onChange();
      return { ok: true, value };
    } catch (error) {
      for (const id of MODEL_IDS) this.models.get(id).resident = {
        state: 'failed', loaded: false, reason: 'resident_failed',
        detail: String(error?.message ?? error),
      };
      this.onChange();
      return { ok: false, reason: 'resident_failed' };
    }
  }

  rawPath(modelId, role = 'model') {
    const current = this.models.get(modelId);
    return rawPath(current?.raw, role);
  }

  runtimeArtifact(modelId) { return this.models.get(modelId)?.runtime?.artifact ?? null; }

  snapshot() {
    const models = {};
    for (const [id, current] of this.models) {
      models[id] = {
        raw: current.raw ?? rawLayer(null, id, this.managerState.reason),
        runtime: current.runtime,
        resident: current.resident,
        usable: current.raw?.complete === true && current.runtime?.prepared === true,
        running: current.resident?.loaded === true,
      };
    }
    return {
      schema: SPEECH_MODEL_SCHEMA,
      manager: { ...this.managerState },
      management_path: MANAGER_WEB_PATH,
      models,
    };
  }
}

export const modelRequirements = (config = {}) => {
  const cam = config?.pipeline?.segment === 'fireredvad_camplus'
    || config?.pipeline?.segment === 'camplus';
  const asrEnabled = config?.asr?.enabled !== false;
  return MODEL_IDS.map((modelId) => {
    const requirement = requirementFor(modelId);
    const required = modelId === 'model.sensevoice' ? asrEnabled
      : modelId === 'model.fireredvad' ? asrEnabled : cam;
    return {
      model_id: modelId,
      name: requirement.name,
      feature: requirement.feature,
      description: requirement.description,
      requirement: required ? 'required' : 'optional',
      selected: required,
      reason: required ? '当前 Pipeline 需要它。' : '当前 Pipeline 未使用它。',
    };
  });
};

export const graphFromArtifact = (artifact) => {
  if (!artifact?.path) return null;
  const context = ['local', 'prebuilt', 'ctx'].includes(String(artifact.kind ?? ''));
  return {
    path: artifact.path,
    modelPath: context ? null : artifact.path,
    ctxPath: context ? artifact.path : null,
    ctxKey: artifact.ctx_key ?? path.basename(artifact.path).replace(/\.onnx$/, '').replace(/\.ctx$/, ''),
  };
};

export const frontendFromRaw = (raw) => ({
  cmvn: rawPath(raw, 'cmvn'),
  tokens: rawPath(raw, 'tokens'),
});

// Keep the implementation's validation useful to tests and future consumers.
export const isRawPackageCard = (value) => Boolean(value && value.key && Array.isArray(value.files)
  && hasOwn(value, 'status'));

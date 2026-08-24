/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `cfg.asr.model` / speech policy projection + Manager logical-model capability
 * [OUTPUT]: Logical model requirements and thin download/use/operation proxies for Settings
 * [POS]: Termux Speech model requirements boundary. The UI never sees asset artifacts.
 * [PROTOCOL]: 只使用 `model.*` logical ids；不复制 Manager 状态机、不读 Framework asset registry。
 */

import { resolveLogicalModel } from './logical-models.mjs';
import { AssetManagerClient, unavailableText } from './asset-manager.mjs';

const MODEL_IDS = Object.freeze([
  'model.sensevoice',
  'model.fireredvad',
  'model.campplus',
]);

/**
 * The selector is the only ASR choice. Requirements are derived from the
 * current config, not from the Manager's artifact list or an old backend key.
 */
export const REQUIREMENTS = Object.freeze({
  'model.sensevoice': {
    name: 'SenseVoice', feature: 'asr', description: '语音转文字。',
  },
  'model.fireredvad': {
    name: 'FireRedVAD', feature: 'vad', description: '手动转录时判断语音起止。',
  },
  'model.campplus': {
    name: 'CAM++', feature: 'speaker_activity', description: '自动转录时判断当前说话人。',
  },
});

let client = null;
export const managerClient = (override = null) => {
  if (override) { client = override; return client; }
  if (!client) client = new AssetManagerClient();
  return client;
};
export const __resetManagerClient = () => { client = null; };

const managerFailure = (status) => ({
  available: false,
  reason: status.reason ?? 'manager_unavailable',
  message: status.message ?? unavailableText(status.reason),
});

const selectedAsr = () => 'model.sensevoice';

const requirementRows = (config) => {
  const asr = selectedAsr(config);
  const vadRequired = config?.asr?.enabled !== false;
  const speakerRequired = config?.speaker_activity?.enabled === true;
  return MODEL_IDS.map((modelId) => {
    const meta = REQUIREMENTS[modelId];
    const requirement = meta.feature === 'asr'
      ? (modelId === asr ? 'required' : 'alternative')
      : meta.feature === 'vad'
        ? (vadRequired ? 'required' : 'optional')
        : (speakerRequired ? 'required' : 'optional');
    return {
      model_id: modelId,
      name: meta.name,
      feature: meta.feature,
      description: meta.description,
      requirement,
      selected: modelId === asr,
      reason: requirement === 'required'
        ? (meta.feature === 'asr' ? `当前选择的 ASR 模型（cfg.asr.model=${config?.asr?.model ?? 'sensevoice'}）。`
          : meta.feature === 'vad' ? '当前 ASR 链需要手动转录的语音检测。'
            : '当前 policy 已开启自动转录的说话人活动判定。')
        : requirement === 'alternative'
          ? '未选择；切换 ASR 模型后才需要。'
          : meta.feature === 'vad' ? '当前配置没有启用 ASR，暂不要求。'
            : '当前 policy 未开启自动转录，暂不要求。',
    };
  });
};

const cleanOperation = (operation) => {
  if (!operation || typeof operation !== 'object') return null;
  return {
    operation_id: operation.operation_id ?? null,
    action: operation.action ?? null,
    state: operation.state ?? null,
    stage: operation.stage ?? null,
    stages: Array.isArray(operation.stages) ? operation.stages : [],
    progress_precision: operation.progress_precision ?? 'stage',
    bytes_done: Number.isFinite(operation.bytes_done) ? operation.bytes_done : null,
    bytes_total: Number.isFinite(operation.bytes_total) ? operation.bytes_total : null,
    progress: Number.isFinite(operation.progress) ? operation.progress : null,
    error: operation.error ?? null,
  };
};

const cleanManagerModel = (model) => model ? {
  state: model.state ?? null,
  user_status: model.user_status ?? null,
  usable: model.usable === true,
  can_use: model.can_use === true,
  version: model.version ?? null,
  operation: cleanOperation(model.operation),
  diagnostics: model.diagnostics?.last_failure_stage || model.diagnostics?.last_error
    ? {
      last_failure_stage: model.diagnostics.last_failure_stage ?? null,
      last_error: model.diagnostics.last_error ?? null,
    } : null,
} : null;

const cleanRuntime = (descriptor) => ({
  ready: descriptor?.available === true,
  reason: descriptor?.available === true ? null : (descriptor?.reason ?? 'model_not_enabled'),
});

const normalizeOperation = (result, modelId) => {
  if (!result.ok) return {
    ok: false, model_id: modelId, error: result.error, detail: result.detail ?? null,
    degraded: Boolean(result.unavailable),
  };
  const value = result.value ?? {};
  if (value.ok !== true) return {
    ok: false, model_id: modelId, error: value.error ?? 'manager_refused',
    detail: value.detail ?? null,
  };
  return {
    ok: true,
    model_id: modelId,
    operation_id: value.operation?.operation_id ?? null,
    state: value.operation?.state ?? null,
    stage: value.operation?.stage ?? null,
    stages: value.operation?.stages ?? null,
    progress_precision: value.operation?.progress_precision ?? 'stage',
    deduplicated: value.deduplicated === true,
  };
};

/**
 * One Manager logical snapshot plus runtime resolver facts. The response is
 * intentionally a new public shape: no asset id, target, path, graph, ctx,
 * encoder, decoder, frontend, package, or QNN detail crosses this boundary.
 */
export async function listModels(_packageRoot = null, {
  manager = managerClient(),
  config = {},
  resolveModel = resolveLogicalModel,
} = {}) {
  const rows = requirementRows(config);
  const managerStatus = await manager.status();
  let managerValue = null;
  let managerError = null;
  if (managerStatus.available) {
    const response = await manager.models();
    if (response.ok) managerValue = response.value ?? null;
    else managerError = response;
  }
  const byId = new Map((managerValue?.models ?? []).map((model) => [model.model_id, model]));
  const runtime = new Map();
  await Promise.all(rows.map(async (row) => {
    try { runtime.set(row.model_id, cleanRuntime(await resolveModel(row.model_id))); }
    catch (error) { runtime.set(row.model_id, { ready: false, reason: String(error?.message ?? error) }); }
  }));

  const managerView = managerStatus.available && !managerError
    ? { available: true, reason: null, message: null }
    : managerFailure(managerError?.unavailable
      ? {
        reason: managerError.unavailable,
        message: managerError.detail ?? unavailableText(managerError.unavailable),
      }
      : managerStatus);
  const requirements = rows.map((row) => {
    const m = cleanManagerModel(byId.get(row.model_id));
    const r = runtime.get(row.model_id) ?? { ready: false, reason: 'runtime_unknown' };
    const ready = r.ready === true;
    const failed = m?.state === 'failed';
    return {
      ...row,
      ready,
      ready_reason: ready ? null : r.reason,
      manager_known: Boolean(m),
      manager: m,
      actions: {
        download: managerView.available && !ready,
        use: managerView.available && !ready && m?.can_use === true,
        retry: managerView.available && failed,
      },
    };
  });
  const required = requirements.filter((r) => r.requirement === 'required');
  const complete = required.every((r) => r.ready);
  const sources = managerValue?.sources ?? null;
  return {
    schema: 'termux-os.speech-model-requirements.v1',
    manager: managerView,
    manager_catalog: {
      known: sources?.catalog?.known === true,
      stale: sources?.catalog?.stale !== false,
      age_ms: sources?.catalog?.age_ms ?? null,
      updated_at_ms: sources?.catalog?.updated_at_ms ?? null,
      refreshing: sources?.catalog?.refreshing === true,
    },
    management_path: managerValue?.management_path ?? null,
    config: {
      asr_model: config?.asr?.model ?? 'sensevoice',
      asr_enabled: config?.asr?.enabled !== false,
      speaker_activity_enabled: config?.speaker_activity?.enabled === true,
    },
    requirements,
    features: {
      asr: requirements.filter((r) => r.feature === 'asr').find((r) => r.selected)?.ready === true,
      vad: requirements.find((r) => r.feature === 'vad')?.ready === true,
      speaker_activity: requirements.find((r) => r.feature === 'speaker_activity')?.ready === true,
    },
    summary: {
      ready: complete,
      required_count: required.length,
      ready_count: required.filter((r) => r.ready).length,
    },
    change_seq: managerValue?.change_seq ?? null,
  };
}

const known = (id) => MODEL_IDS.includes(id);

export async function downloadModel(modelId, { manager = managerClient(), choice = null } = {}) {
  if (!known(modelId)) return { ok: false, error: 'unknown_model' };
  const status = await manager.status();
  if (!status.available) return { ok: false, ...managerFailure(status), error: status.reason, degraded: true };
  return normalizeOperation(await manager.downloadModel(modelId, choice), modelId);
}

export async function useModel(modelId, { manager = managerClient() } = {}) {
  if (!known(modelId)) return { ok: false, error: 'unknown_model' };
  const status = await manager.status();
  if (!status.available) return { ok: false, ...managerFailure(status), error: status.reason, degraded: true };
  return normalizeOperation(await manager.useModel(modelId), modelId);
}

export async function modelOperation(operationId, { manager = managerClient() } = {}) {
  const status = await manager.status();
  if (!status.available) return { ok: false, ...managerFailure(status), error: status.reason, degraded: true };
  const result = await manager.operation(operationId);
  if (!result.ok) return { ok: false, error: result.error, detail: result.detail ?? null,
    degraded: Boolean(result.unavailable) };
  return { ok: true, operation: cleanOperation(result.value?.operation ?? result.value) };
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Raw package cards and App-owned runtime facts.
 * [OUTPUT]: The public four-layer model page plus raw download/prepare/operation proxies.
 * [POS]: Termux Speech model UI boundary. Logical ids are internal feature ids only.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { AssetManagerClient, unavailableText } from './asset-manager.mjs';
import {
  MANAGER_WEB_PATH,
  MODEL_IDS,
  MODEL_REQUIREMENTS,
  SpeechModelRuntime,
  modelRequirements,
} from './raw-models.mjs';

let client = null;
export const managerClient = (override = null) => {
  if (override) { client = override; return client; }
  if (!client) client = new AssetManagerClient();
  return client;
};
export const __resetManagerClient = () => { client = null; };

const operation = (value) => {
  const item = value?.operation ?? value;
  if (!item || typeof item !== 'object') return null;
  return {
    operation_id: item.operation_id ?? item.id ?? null,
    action: item.action ?? null,
    package_key: item.package_key ?? item.model_key ?? null,
    state: item.state ?? null,
    stage: item.stage ?? null,
    stages: Array.isArray(item.stages) ? item.stages : [],
    progress_precision: item.progress_precision ?? 'stage',
    bytes_done: Number.isFinite(Number(item.bytes_done)) ? Number(item.bytes_done) : null,
    bytes_total: Number.isFinite(Number(item.bytes_total)) ? Number(item.bytes_total) : null,
    progress: Number.isFinite(Number(item.progress)) ? Number(item.progress) : null,
    error: item.error ?? null,
  };
};

const failure = (result) => ({
  ok: false,
  error: result.error ?? 'manager_contract_error',
  detail: result.detail ?? null,
  degraded: result.unavailable === 'manager_unreachable',
  reason: result.unavailable === 'manager_unreachable' ? 'manager_unreachable' : 'manager_contract_error',
  message: result.detail ?? unavailableText(result.unavailable),
});

const normalizeOperation = (result, modelId, packageKey) => {
  if (!result.ok) return { ...failure(result), model_id: modelId, package_key: packageKey };
  const value = result.value ?? {};
  if (value.ok !== true) return {
    ok: false, model_id: modelId, package_key: packageKey,
    error: value.error ?? 'manager_refused', detail: value.detail ?? null,
  };
  const op = operation(value);
  return {
    ok: true,
    model_id: modelId,
    package_key: packageKey,
    operation_id: op?.operation_id ?? value.operation_id ?? null,
    operation: op,
    deduplicated: value.deduplicated === true,
  };
};

const runtimeFor = (snapshot, modelId) => snapshot?.models?.[modelId] ?? {
  raw: { state: 'unknown', complete: false, reason: 'manager_unreachable', files: [] },
  runtime: { state: 'not_prepared', prepared: false, reason: 'app_not_prepared' },
  resident: { state: 'unknown', loaded: false, reason: 'resident_unknown' },
  usable: false,
  running: false,
};

const managerView = (snapshot) => ({
  available: snapshot?.manager?.available === true,
  reason: snapshot?.manager?.reason ?? null,
  message: snapshot?.manager?.message ?? null,
});

/** Build the new UI view; raw/runtime/resident are intentionally separate. */
export async function listModels(_packageRoot = null, {
  manager = managerClient(),
  config = {},
  runtime = null,
} = {}) {
  const owner = runtime ?? new SpeechModelRuntime({ manager });
  await owner.refresh().catch(() => {});
  // L4 is an App fact, not a projection of raw completeness or local declarations.
  // Read it beside the Manager card so the page can distinguish usable from running.
  if (typeof owner.residents === 'function') await owner.residents().catch(() => {});
  const snapshot = owner.snapshot();
  const managerStatus = managerView(snapshot);
  const rows = modelRequirements(config).map((row) => {
    const facts = runtimeFor(snapshot, row.model_id);
    const rawComplete = facts.raw?.complete === true;
    const prepared = facts.runtime?.prepared === true;
    const residentLoaded = facts.resident?.loaded === true;
    const reason = facts.raw?.reason
      ?? facts.runtime?.reason
      ?? facts.resident?.reason
      ?? null;
    return {
      ...row,
      package_key: MODEL_REQUIREMENTS[row.model_id].packageKey,
      package_version: facts.raw?.package_version ?? null,
      raw: facts.raw,
      runtime: facts.runtime,
      resident: facts.resident,
      usable: rawComplete && prepared,
      running: rawComplete && prepared && residentLoaded,
      model_reason: reason,
      actions: {
        download: managerStatus.available && !rawComplete,
        prepare: rawComplete && !prepared,
        retry: facts.runtime?.state === 'failed' || facts.resident?.state === 'failed',
      },
    };
  });
  const required = rows.filter((row) => row.requirement === 'required');
  const usableCount = required.filter((row) => row.usable).length;
  return {
    schema: 'termux-os.speech-model-layers.v1',
    manager: managerStatus,
    management_path: MANAGER_WEB_PATH,
    requirements: rows,
    features: {
      asr: rows.find((row) => row.model_id === 'model.sensevoice')?.usable === true,
      vad: rows.find((row) => row.model_id === 'model.fireredvad')?.usable === true,
      speaker_activity: rows.find((row) => row.model_id === 'model.campplus')?.usable === true,
    },
    summary: {
      all_required_usable: required.every((row) => row.usable),
      required_count: required.length,
      usable_count: usableCount,
      raw_complete_count: required.filter((row) => row.raw?.complete === true).length,
      prepared_count: required.filter((row) => row.runtime?.prepared === true).length,
      running_count: required.filter((row) => row.resident?.loaded === true).length,
    },
    manager_catalog: { known: managerStatus.available, stale: false, age_ms: null },
    change_seq: null,
  };
}

const known = (id) => MODEL_IDS.includes(id);

export async function downloadModel(modelId, { manager = managerClient() } = {}) {
  if (!known(modelId)) return { ok: false, error: 'unknown_model' };
  const key = MODEL_REQUIREMENTS[modelId].packageKey;
  return normalizeOperation(await manager.downloadPackage(key), modelId, key);
}

export async function prepareModel(modelId, { runtime = null, manager = managerClient(), android } = {}) {
  if (!known(modelId)) return { ok: false, error: 'unknown_model' };
  const owner = runtime ?? new SpeechModelRuntime({ manager, android });
  const result = await owner.prepare(modelId);
  return result.ok ? result : { ...result, degraded: result.reason === 'manager_unreachable' };
}

export async function modelOperation(operationId, { manager = managerClient() } = {}) {
  if (!operationId) return { ok: false, error: 'operation_id required' };
  const result = await manager.operation(operationId);
  if (!result.ok) return failure(result);
  return { ok: true, operation: operation(result.value) };
}

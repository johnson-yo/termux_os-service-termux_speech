#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// [INPUT]: Framework URL/System Key, running Termux Speech instance, the App Speech2 surface.
// [OUTPUT]: `pass` / `fail` / `blocked` (exit 0/1/2). Recovery20B: checks cover the Speech2-only
//           product surface — layered overview, App-reported model readiness, the versioned policy
//           (Trigger/Scene), transcript live/history, My Voice, the input source, the three-page WebUI
//           and retirement of legacy write routes. `blocked` means a prerequisite is missing,
//           so nothing was asserted — one cause, not ten downstream symptoms.
// [POS]: Installed/Dev-compatible verification; it never prints credentials or audio and does not require a new physical input event.
// [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
const BASE = process.env.TERMUX_OS_FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
const TOKEN = process.env.TERMUX_OS_SYSTEM_KEY ?? '';
const BASE_PACKAGE_ID = 'github.termux-os.service.termux-speech';
let packageId = process.env.TERMUX_OS_PACKAGE_ID ?? null;
const checks = [];
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const resolvePackageId = async () => {
  if (packageId) return packageId;
  const response = await fetch(`${BASE}/api/packages`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true || !Array.isArray(payload.packages)) {
    throw new Error(payload?.error ?? `HTTP ${response.status} /api/packages`);
  }
  const exact = payload.packages.find((item) => item.id === BASE_PACKAGE_ID);
  if (exact) packageId = exact.id;
  if (!packageId) {
    const dev = payload.packages.filter(
      (item) => item.source === 'dev-mount' && item.id?.startsWith(`${BASE_PACKAGE_ID}@`),
    );
    if (dev.length === 1) packageId = dev[0].id;
    else if (dev.length > 1) throw new Error('multiple Termux Speech Dev instances; set TERMUX_OS_PACKAGE_ID');
  }
  if (!packageId) throw new Error('Termux Speech Package instance not found');
  return packageId;
};

const request = async (route, { method = 'GET', body, timeoutMs = 8000 } = {}) => {
  const id = await resolvePackageId();
  const response = await fetch(`${BASE}/api/packages/${id}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${response.status} ${route}`);
  }
  return payload;
};

const discoverApp = async () => {
  const response = await fetch(`${BASE}/api/capabilities/termux-os.app.api/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => null);
  const value = payload?.value;
  if (!response.ok || payload?.ok !== true || !value?.base_url) {
    throw new Error(payload?.reason ?? payload?.error ?? 'termux-os.app.api unavailable');
  }
  const authorization = value.headers?.Authorization
    ?? (value.token ? `Bearer ${value.token}` : null);
  if (!authorization) throw new Error('termux-os.app.api returned no authorization');
  return { baseUrl: new URL(value.base_url).origin, authorization };
};

const appRequest = async (descriptor, route, {
  method = 'GET',
  body,
  timeoutMs = 30_000,
} = {}) => {
  const response = await fetch(descriptor.baseUrl + route, {
    method,
    headers: {
      Authorization: descriptor.authorization,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `App HTTP ${response.status} ${route}`);
  }
  return payload.data;
};

const check = async (id, run) => {
  try { checks.push({ id, result: 'pass', evidence: await run() }); }
  catch (error) { checks.push({ id, result: 'fail', evidence: String(error?.message ?? error) }); }
};

/**
 * ⭐ **缺一个前置不是十四个失败，是一个。**
 *
 * 真机踩过：adapter 没挂载时 `termux-os.app.api` 没有提供者，于是十四条断言里有十条
 * 各自报出自己的下游症状——「no provider registered」「PCM WS is not live」
 * 「Pool stopped writing」——每一条都是真的，每一条都指向错的地方。读的人会去查
 * 麦克风、查 Pool、查 App，而唯一要做的事是把 adapter 挂上。
 *
 * 所以前置在跑任何断言**之前**问，缺了就只说这一件事，并且直接给出该敲的命令。
 */
const preflight = async () => {
  const missing = [];
  const note = (what, why, fix) => missing.push({ what, why, fix });

  let packages = null;
  try {
    const response = await fetch(`${BASE}/api/packages`, { headers, signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      note('framework', payload?.error ?? `HTTP ${response.status}`,
        'check TERMUX_OS_FRAMEWORK_URL and TERMUX_OS_SYSTEM_KEY');
      return missing;   // 夠不到 Framework 時，後面每一項都只會重複同一個原因
    }
    packages = payload.packages;
  } catch (error) {
    note('framework', String(error?.message ?? error), 'is the Framework service running?');
    return missing;
  }

  try { await resolvePackageId(); }
  catch (error) {
    note('termux-speech', String(error?.message ?? error),
      'install it, or dev-mount the workspace: POST /api/dev/packages {package_id, workspace, slug}');
  }

  try {
    const response = await fetch(`${BASE}/api/capabilities`, { headers, signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null);
    const entry = (payload?.capabilities ?? []).find((item) => item.capability === 'termux-os.app.api');
    if (!entry) {
      // 誰提供 termux-os.app.api 是 adapter 的事，但這裡刻意寫出它的名字：
      // 「沒有提供者」對讀的人不可行動，「adapter 沒起來」可以。
      note('termux-os.app.api', 'no provider registered',
        'the Android App adapter is not loaded — install github.termux-os.adapter.android-app '
        + 'or dev-mount it（slug: github-termux-os-adapter）');
    } else if (entry.ready !== true) {
      note('termux-os.app.api', entry.reason ?? 'provider is not ready',
        'the adapter is loaded but cannot reach the App on 8796 — is the App running and its token current?');
    }
  } catch (error) {
    note('termux-os.app.api', String(error?.message ?? error), 'cannot read the capability registry');
  }

  return missing;
};

const waitFor = async (read, accept, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return value;
};

const blocked = await preflight();
if (blocked.length) {
  /**
   * ⚠ `blocked` 不是 `fail`。
   *
   * fail = 「這台機器上這件事真的壞了」，blocked = 「還沒到能問這個問題的地步」。
   * 壓成同一個值會讓一次沒挂 adapter 看起來像十條真實的功能回歸，
   * 而**假紅比沒測更貴**——它讓人去修沒壞的東西，也讓真紅下一次不再被當回事。
   */
  console.log(JSON.stringify({
    schema: 'termux-os.device-verify.v1',
    result: 'blocked',
    blocked,
    checks: [],   // 一條都沒跑，所以一條都不報——空著才是誠實的
  }));
  process.exit(2);
}

const TRIGGERS = ['stop', 'passthrough', 'volume'];
const SCENES = ['VOICE_INPUT', 'CONVERSATION', 'MEDIA_STREAM', 'AI_BARGE_IN', 'MEDIA_FILE'];

await check('speech2_overview_layered', async () => {
  const o = (await request('/speech2/overview', { timeoutMs: 15_000 })).value;
  for (const k of ['installed', 'app_reachable', 'running', 'models_ready', 'trigger', 'input', 'state']) {
    if (!(k in o)) throw new Error(`overview is missing ${k}`);
  }
  if (o.app_reachable !== true) throw new Error(`App Speech2 unreachable: ${o.error}`);
  if (!TRIGGERS.includes(o.trigger)) throw new Error(`trigger=${o.trigger} is not a product trigger`);
  return `state=${o.state} trigger=${o.trigger} scene=${o.scene} input=${o.input?.active_source ?? 'none'}`;
});

await check('speech2_models_ready_app_authority', async () => {
  const m = (await request('/speech2/overview', { timeoutMs: 15_000 })).value.models;
  if (m?.authority !== 'app') throw new Error(`readiness authority=${m?.authority}`);
  const missing = ['campplus', 'fireredvad', 'sensevoice_t267'].filter((k) => m?.[k]?.installed !== true);
  if (missing.length) throw new Error(`not installed: ${missing.join(', ')}`);
  return ['campplus', 'fireredvad', 'sensevoice_t267'].map((k) => `${k}=${m[k].ready ? 'ready' : 'installed'}`).join(' ');
});

await check('speech2_policy_trigger_scene', async () => {
  const doc = (await request('/speech2/policy')).value;
  const p = doc?.policy;
  if (p?.schema_version !== 4) throw new Error(`schema_version=${p?.schema_version}`);
  if (!['passthrough', 'volume'].includes(p?.trigger?.mode)) throw new Error(`trigger.mode=${p?.trigger?.mode}`);
  if (p?.segmentation?.scene !== null && !SCENES.includes(p?.segmentation?.scene)) {
    throw new Error(`scene=${p?.segmentation?.scene}`);
  }
  return `revision=${doc.revision} trigger.mode=${p.trigger.mode} scene=${p.segmentation.scene}`;
});

await check('speech2_transcript_live_and_history', async () => {
  const live = (await request('/speech2/transcripts/live')).value;
  if (live?.schema !== 'termux-os.speech2-transcript.v1') throw new Error(`live schema=${live?.schema}`);
  if (live.available !== true) throw new Error(`transcript read surface unavailable: ${live.last_error}`);
  const hist = (await request('/speech2/history?limit=5')).value;
  if (!Array.isArray(hist?.items)) throw new Error('history items missing');
  if (hist.items.some((it) => it.source_kind !== 'speech2')) throw new Error('history mixes non-Speech2 rows');
  return `boot=${String(live.boot_id).slice(0, 8)} after_seq=${live.after_seq} history=${hist.items.length}`;
});

await check('speech2_my_voice_route', async () => {
  const v = (await request('/speech2/my-voice')).value;
  if (typeof v?.registered !== 'boolean') throw new Error('registered is not a boolean');
  return `registered=${v.registered} job=${v.job?.state ?? 'idle'}`;
});

await check('speech2_input_source', async () => {
  const v = (await request('/speech2/input')).value;
  if (!v?.product_sources?.includes(v?.configured)) throw new Error(`configured=${v?.configured}`);
  return `configured=${v.configured} active=${v.ring?.active_source ?? 'none'}`;
});

await check('webui_three_pages_no_legacy', async () => {
  const id = await resolvePackageId();
  const response = await fetch(`${BASE}/packages/${id}/index.html`, { headers, signal: AbortSignal.timeout(8000) });
  const html = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} index.html`);
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  if (JSON.stringify(tabs) !== JSON.stringify(['Overview', 'History', 'Settings'])) throw new Error(`tabs=${JSON.stringify(tabs)}`);
  if (/clap|拍掌/i.test(html)) throw new Error('clap reference in the product page');
  return `tabs=${tabs.join('|')}`;
});

await check('legacy_write_routes_retired', async () => {
  const id = await resolvePackageId();
  const response = await fetch(`${BASE}/api/packages/${id}/mic/enable`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(8000),
  });
  if (response.status === 200) throw new Error('legacy /mic/enable still accepted');
  return `POST /mic/enable -> ${response.status}`;
});

const result = checks.some((item) => item.result === 'fail') ? 'fail' : 'pass';
console.log(JSON.stringify({ schema: 'termux-os.device-verify.v1', result, checks }));
process.exit(result === 'pass' ? 0 : 1);

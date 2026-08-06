/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: This Package's `assets.requires`, the Framework asset API, and the injected System Key.
 * [OUTPUT]: `listModels`, `fetchModel`, `removeModel`, `installProvider` — the model shelf behind 设置 → 模型.
 * [POS]: The only place a person can obtain or remove a speech model. Asset Packages are deliberately
 *        hidden from the Framework's own Package pages: a model belongs to whoever needs it.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';

const FRAMEWORK_URL = process.env.TERMUX_OS_FRAMEWORK_URL || '';
const SYSTEM_KEY = process.env.TERMUX_OS_SYSTEM_KEY || '';

/**
 * 每个资产在**使用者眼里**是什么，以及它属于哪一档。
 *
 * ⚠ 这张表只提供人读得懂的名字与分组。是否必需、装没装、多大，全部来自
 * Manifest 与 Framework——在这里再写一份就会有两个互相矛盾的真相。
 */
const SHELF = Object.freeze({
  'model.fireredvad': { name: '语音检测 · FireRedVAD', tier: 'core' },
  'model.sensevoice.frontend': { name: 'SenseVoice 前处理数据', tier: 'core' },
  'model.sensevoice.ctx': { name: 'SenseVoice · 本机加速器版本', tier: 'sensevoice' },
  'model.sensevoice.graph': { name: 'SenseVoice · 通用图（没有加速器版本时才需要）', tier: 'sensevoice' },
  'model.qwen3asr.encoder': { name: 'Qwen3-ASR 编码器', tier: 'qwen' },
  'model.qwen3asr.decoder.q4': { name: 'Qwen3-ASR 解码器 Q4', tier: 'qwen' },
  'model.qwen3asr.decoder.q8': { name: 'Qwen3-ASR 解码器 Q8', tier: 'qwen' },
});

const auth = () => ({ Authorization: `Bearer ${SYSTEM_KEY}` });

async function frameworkJson(pathname, { method = 'GET', timeoutMs = 15_000 } = {}) {
  const response = await fetch(`${FRAMEWORK_URL}${pathname}`, {
    method,
    headers: auth(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

/** Manifest 是「本包需要哪些资产」的唯一来源。 */
function declared(packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'termux-os.package.json'), 'utf8'));
  return manifest.assets?.requires ?? [];
}

/**
 * 模型架：每个资产一行，带上它此刻的状态。
 *
 * ⚠ 三种「没有」要分开，因为下一步动作完全不同：
 *   `missing`        — 装得了，点下载
 *   `no_variant`     — 这台机器没有对应的硬件版本，下载也没用
 *   `no_provider`    — 提供它的资产包还没装（Qwen 是可选依赖，默认就不在）
 */
export async function listModels(packageRoot) {
  const items = [];
  for (const need of declared(packageRoot)) {
    const meta = SHELF[need.id] ?? { name: need.id, tier: 'other' };
    /**
     * ⭐ 先问 `variants`，再问 `assets/<id>`。
     *
     * ⚠ `GET /api/assets/<id>` 在「还没取过」时回 404，而 404 也是「根本没有这个资产」
     * 的答案——两件事挤在同一个状态码里。可选资产在取到之前本来就没有登记，
     * 于是「点一下就能下」会被显示成「资产包没装」，而那是一句让人无从下手的话。
     * `variants` 问的是宣告方，宣告方在包装上的那一刻就在了。
     */
    const variants = await frameworkJson(`/api/assets/${encodeURIComponent(need.id)}/variants`);
    const declaredBy = variants.ok ? variants.payload : null;
    const { ok, payload } = await frameworkJson(`/api/assets/${encodeURIComponent(need.id)}`);
    const asset = payload?.asset ?? null;

    let state;
    let detail = null;
    if (!declaredBy) { state = 'no_provider'; detail = '提供这个模型的资产包还没有安装'; }
    else if (ok && asset?.ready === true) state = 'present';
    else if (declaredBy.selected == null) {
      state = 'no_variant';
      detail = declaredBy.detail
        ?? `本机加速器没有对应版本${declaredBy.candidates?.length ? `（已有：${declaredBy.candidates.join(', ')}）` : ''}`;
    } else {
      state = 'missing';
      detail = asset?.detail && asset.detail !== 'not registered (asset package not installed?)'
        ? asset.detail : null;
    }

    items.push({
      id: need.id,
      name: meta.name,
      tier: meta.tier,
      required: need.required !== false,
      state,
      detail,
      version: asset?.version ?? null,
      target: asset?.target ?? declaredBy?.selected ?? null,
      path: asset?.path ?? null,
      // 只有按需取来的才删得掉；随包装上的删了会让「装好了」不再是真的。
      removable: state === 'present' && need.required === false,
    });
  }
  return {
    schema: 'termux-os.speech-models.v1',
    items,
    /** 能不能转写：核心两项到位，且 SenseVoice 至少有一种图。 */
    ready: items.filter((i) => i.tier === 'core').every((i) => i.state === 'present')
      && items.some((i) => i.tier === 'sensevoice' && i.state === 'present'),
  };
}

/**
 * 取一个模型。⚠ 超时给到 40 分钟——这里真的在下几百 MB，而这条请求由使用者
 * 显式点出来，页面上有它自己的进度提示。⛔ 不自动重试：网络不通时重试只会
 * 变成一段没人看得懂的长时间静默。
 */
export async function fetchModel(id) {
  if (!SHELF[id]) return { ok: false, error: 'unknown_model' };
  const { ok, status, payload } = await frameworkJson(
    `/api/assets/${encodeURIComponent(id)}/fetch`, { method: 'POST', timeoutMs: 40 * 60_000 },
  );
  if (ok && payload?.ok) return { ok: true, id, bytes: payload.bytes ?? 0, path: payload.path ?? null };
  return {
    ok: false,
    error: payload?.error ?? `HTTP ${status}`,
    detail: payload?.detail ?? null,
    candidates: payload?.candidates ?? null,
  };
}

export async function removeModel(id) {
  if (!SHELF[id]) return { ok: false, error: 'unknown_model' };
  const { ok, status, payload } = await frameworkJson(
    `/api/assets/${encodeURIComponent(id)}/payload`, { method: 'DELETE', timeoutMs: 60_000 },
  );
  if (ok && payload?.ok) return { ok: true, id, removed_files: payload.removed_files ?? 0 };
  return { ok: false, error: payload?.error ?? `HTTP ${status}`, detail: payload?.detail ?? null };
}

/**
 * 装上提供这个模型的资产包。
 *
 * ⭐ 只报一个 asset id 上去。哪个包提供它由目录回答——在这里写死一个包名，等于把
 * 「谁供应这个模型」复制到一个本包无法维护的地方，而它迟早会跟目录说不一样的话。
 *
 * ⚠ 立刻返回：装包是一个后台作业，页面之后重新读一次模型架就看得到结果。
 * 让这条请求挂到装完，只会把「已经开始了」和「还没开始」变得无法区分。
 */
export async function installProvider(id) {
  if (!SHELF[id]) return { ok: false, error: 'unknown_model' };
  const { ok, status, payload } = await frameworkJson(
    `/api/assets/${encodeURIComponent(id)}/provider`, { method: 'POST', timeoutMs: 5 * 60_000 },
  );
  if (ok && payload?.ok) return { ok: true, id, package_id: payload.package_id ?? null, job: payload.job ?? null };
  return {
    ok: false,
    error: payload?.error ?? `HTTP ${status}`,
    detail: payload?.detail ?? null,
    candidates: payload?.candidates ?? null,
  };
}

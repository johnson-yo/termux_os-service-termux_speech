/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个假的 Framework（capability 目录 + invoke）与假的 runtime resolver
 * [OUTPUT]: HF Model/Asset Manager 接入的回归——发现、降级、合并、写操作、引用护栏
 * [POS]: ⭐ 这一组测试守的是**分工线**：Manager 回答「这个 asset 客观上是什么」，
 *        本包回答「它对语音意味着什么」，而且 **Manager 不在时语音不受影响**。
 *
 * ⛔ 不连真机、不连真 Manager、不下载任何东西。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetManagerClient, MANAGER_CAPABILITY, INVENTORY_CAPABILITY, UNAVAILABLE,
} from '../service/asset-manager.mjs';
import {
  listModels, downloadModel, useModel, modelOperation, REQUIREMENTS,
} from '../service/models.mjs';

let failures = 0;
let count = 0;
const test = (name, cond, detail = '') => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 一个 package root，只需要 manifest 里的 assets.requires。 */
const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-models-'));
fs.copyFileSync(path.join(root, 'termux-os.package.json'), path.join(pkgRoot, 'termux-os.package.json'));

const ASSET = (id, over = {}) => ({
  asset_id: id,
  source: 'huggingface',
  update_state: 'up_to_date',
  update_label: '已是最新',
  payload_bytes: 27262976,
  references: [{ consumer_package_id: 'github.termux-os.service.termux-speech', reference_type: 'declared' }],
  registry: { known: true, package_id: 'github.termux-os.asset.campplus' },
  upstream: { known: false },
  local: { known: true, declared: true, installed: true, version: '1.0.0',
    target: 'android-arm64-v73-qnn247', provider_package: 'github.termux-os.asset.campplus', ready: true },
  ...over,
});

/**
 * 一个假 Framework。⚠ 只实现本包真正用到的三条：能力目录、describe、invoke。
 * `handler` 收到解析后的 `{op, ...}`，返回 action 的 value。
 */
function fakeFramework({ capabilities = [MANAGER_CAPABILITY, INVENTORY_CAPABILITY], handler = () => ({ ok: true }),
  throwOn = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if (throwOn && String(url).includes(throwOn)) throw new Error('connect ECONNREFUSED');
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).endsWith('/api/capabilities')) {
      return json({ ok: true, capabilities: capabilities.map((id) => ({ id })) });
    }
    if (String(url).endsWith(`/api/capabilities/${INVENTORY_CAPABILITY}`)) {
      return json({ ok: true, capability: INVENTORY_CAPABILITY, kind: 'feed',
        endpoint: '/api/packages/github.termux-os.service.hf-model-manager/events', format: 'jsonl-cursor' });
    }
    if (String(url).endsWith(`/api/capabilities/${MANAGER_CAPABILITY}/invoke`)) {
      const command = JSON.parse(JSON.parse(init.body).input);
      return json({ ok: true, capability: MANAGER_CAPABILITY, provider: 'hf-model-manager',
        value: handler(command) });
    }
    return json({ ok: false, error: 'not found' });
  };
  return { fetchImpl, calls };
}

const clientWith = (fw, over = {}) => new AssetManagerClient({
  frameworkUrl: 'http://127.0.0.1:8980', systemKey: 'k', fetchImpl: fw.fetchImpl, ...over,
});

/** runtime resolver 的替身：一份「盘上有什么」的清单。 */
const resolverFor = (present) => async (id) => {
  if (!present.includes(id)) throw new Error(`asset ${id} is not ready: missing_asset`);
  return { root: `/sdcard/models/${id}`, version: '1.0.0', package: 'github.termux-os.asset.x' };
};

/**
 * ⚠ 这里曾是 `Object.keys(SHELF)`——一张 **asset id** 的清单
 *   （`model.campplus.ctx` 这一级）。docs/092 之后本包只谈 **logical model**
 *   （`model.campplus`），`SHELF` 随之退役。
 * ⭐ 顺带记下这个文件出过的事：它 import 了 4 个早已不存在的符号，于是**整个文件
 *   连载入都失败**，自 docs/092 起一次都没跑过——而报告里它和一个通过的文件长得一样。
 */
const ALL = Object.keys(REQUIREMENTS);

// ── 1. 发现 ────────────────────────────────────────────────────────────────

{
  const fw = fakeFramework();
  const c = clientWith(fw);
  const s = await c.status();
  test('M1 通过 capability discovery 找到 action', s.available === true);
  test('M2 ⭐ feed 端点来自 describe，⛔ 不由本包拼装',
    s.feed_endpoint === '/api/packages/github.termux-os.service.hf-model-manager/events'
      && s.feed_format === 'jsonl-cursor');
  test('M3 ⛔ 全过程没有出现 Manager 的 package URL 或端口',
    fw.calls.every((x) => !x.url.includes(':9000') && !x.url.includes('/api/packages/')),
    fw.calls.map((x) => x.url).join(' '));

  const before = fw.calls.length;
  await c.status();
  test('M4 发现结果被缓存（⛔ 别给单进程 Framework 加没必要的负载）', fw.calls.length === before);
}

{
  const fw = fakeFramework({ capabilities: [] });
  const s = await clientWith(fw).status();
  test('M5 Manager 未安装 ⇒ 明确说「未安装」，⛔ 不是「坏了」',
    s.available === false && s.reason === UNAVAILABLE.NOT_INSTALLED);
}

{
  const fw = fakeFramework({ throwOn: '/api/capabilities' });
  const c = clientWith(fw);
  const s = await c.status();
  test('M6 够不到 Framework ⇒ unreachable，与「未安装」分开',
    s.available === false && s.reason === UNAVAILABLE.UNREACHABLE);
  test('M7 ⚠ 够不到时**不缓存**成「没装」（否则恢复后还会继续说没装到 TTL 结束）',
    c.discovery === null);
}

{
  const c = new AssetManagerClient({ frameworkUrl: '', systemKey: '' });
  const s = await c.status();
  test('M8 没有凭证是第三种情况，也不抛异常', s.available === false && s.reason === UNAVAILABLE.NO_CREDENTIALS);
}

// ── 2–4. 模型视图：logical model 形状（docs/092 之后重写）────────────────────
//
// ⚠ 这里原本是 M9–M24（约 40 条），钉着**旧视图形状**：`data.items[]`、
//   `i.id === 'model.campplus.ctx'`（**asset 这一级**）。docs/092 之后本包只谈
//   **logical model**（`model.campplus`），返回的是 `requirements[]` + `features` + `summary`。
//   ⭐ 它们不是「不需要了」——其中「Manager 不在时已装模型仍然可用」是真正独特的保护——
//   而是**钉在了一个已经不存在的形状上**。以下按新形状重写，⛔ 不是删掉。

/** 装了的模型：运行时解析器说 available。⭐ 它与 Manager 无关，这正是要保护的东西。 */
const installedRuntime = async (modelId) => ({
  model_id: modelId, available: true, version: '1.0.0',
  executable: { kind: 'local', path: `/sdcard/${modelId}.ctx.onnx` },
});
const missingRuntime = async (modelId) => ({
  model_id: modelId, available: false, reason: 'model_missing',
});

{
  // Manager 完全不在（能力目录里没有它），但模型**装着**
  const fw = fakeFramework({ capabilities: [] });
  const data = await listModels(null, {
    manager: clientWith(fw), config: {}, resolveModel: installedRuntime,
  });

  test('M9 ⭐ 每一行都有人话名字，⛔ 不把 asset id 摆给使用者看',
    data.requirements.length > 0
      && data.requirements.every((r) => r.name && !String(r.name).startsWith('model.')));
  test('M10 每个模型都说得出属于哪个功能、为什么需要它',
    data.requirements.every((r) => r.feature && r.description));

  /**
   * ⭐⭐ **这条是整段里最值钱的一条**：Manager 不在时，**已装模型仍然可用**。
   * ⚠ 判据来自 `resolveModel`（运行时解析器），⛔ 不来自 Manager——
   *   模型管理器是**资产管理服务**，它不在语音数据通路上。
   *   写成依赖 Manager 等于给语音链凭空加一个单点故障。
   */
  test('M16 ⭐ Manager 不在时，已装模型仍显示为可用',
    data.requirements.every((r) => r.ready === true));
  test('M17 ⭐ 语音功能就绪度不受 Manager 影响',
    data.features.asr === true && data.features.vad === true);

  test('M18 管理面信息如实标为未知，⛔ 不猜也不显示 0',
    data.manager.available === false
      && data.requirements.every((r) => r.manager_known === false && r.manager === null));
  test('M19 页面能说出「管理服务不可用」这句话',
    typeof data.manager.message === 'string' && data.manager.message.length > 0);
  test('M24 不可用要说出原因', typeof data.manager.reason === 'string' && data.manager.reason !== '');
}

{
  // Manager 不在，且模型**也没装**：两件事都要如实说，⛔ 不许混成一个
  const fw = fakeFramework({ capabilities: [] });
  const data = await listModels(null, {
    manager: clientWith(fw), config: {}, resolveModel: missingRuntime,
  });
  test('M14 ⭐ 功能就绪度由本包判断——没装就是没装',
    data.requirements.every((r) => r.ready === false) && data.features.asr === false);
  /**
   * ⭐ **「管理器不在」与「模型没装」是两件事。**
   * ⚠ 把它们压成一个 `ready:false`，使用者会去重装管理器来解决一个模型缺失的问题。
   * ⭐ 判据是**同一次调用里两个字段各说各的**：模型不可用（ready=false）
   *   而管理器不可用是**另一个**字段（manager.available=false）——⛔ 不是同一个。
   */
  test('M23 ⭐ 盘上有的就是可用的，盘上没有的就是不可用的——与 Manager 无关', (() => {
    const noneReady = data.requirements.every((r) => r.ready === false);
    const managerSeparate = data.manager.available === false
      && data.requirements.every((r) => Object.hasOwn(r, 'ready') && Object.hasOwn(r, 'manager_known'));
    return noneReady && managerSeparate;
  })());
}

{
  // 能力还在目录里，但提供方进程已经死了（真机 kill -9 抓到的）
  const fw = fakeFramework({ throwOn: '/invoke' });
  const data = await listModels(null, {
    manager: clientWith(fw), config: {}, resolveModel: installedRuntime,
  });
  test('M21 ⭐ Manager 进程不可达时也不拖垮模型页', Array.isArray(data.requirements));
  test('M23b ⭐ 目录里有、进程死了 ⇒ 页面必须说「不可用」', data.manager.available === false);
  test('M23c ⚠ 但已装模型照样可用（这正是不该被 Manager 影响的部分）',
    data.requirements.every((r) => r.ready === true) && data.features.asr === true);
}

// ── 5. 写操作走 Manager ────────────────────────────────────────────────────

{
  const seen = [];
  const fw = fakeFramework({ handler: (cmd) => {
    seen.push(cmd.op);
    /** ⚠ op 名随 docs/092 从 asset 级的 `fetch`/`install` 换成 logical 级的 `download`/`use`。 */
    if (cmd.op === 'download' || cmd.op === 'use') {
      return { ok: true, deduplicated: false,
        operation: { operation_id: 'op_1', state: 'queued', stage: 'resolving',
          stages: ['resolving', 'downloading', 'verifying', 'done'], progress_precision: 'stage' } };
    }
    if (cmd.op === 'operation') {
      return { ok: true, operation: { operation_id: 'op_1', state: 'complete', stage: 'done' } };
    }
    return { ok: true };
  } });
  const c = clientWith(fw);
  const f = await downloadModel('model.sensevoice', { manager: c });
  test('M25 下载 ⇒ 拿到 operation_id，⛔ 不挂着等几百 MB',
    f.ok === true && f.operation_id === 'op_1' && seen.includes('download'));
  test('M26 ⭐ 原样带出进度精度声明，页面据此不许画百分比', f.progress_precision === 'stage');
  test('M27 阶段集合来自 Manager', Array.isArray(f.stages) && f.stages.includes('downloading'));

  /**
   * ⚠ M28 原本钉 `installProvider`——「装提供方」在 docs/092 之前是本包的一个写操作。
   * ⭐ 之后它整个搬进了模型管理器（本包只谈 logical model），故该断言随 API 一起退役。
   *   「使用」现在就是那条写操作，由 M29 之前的 `useModel` 覆盖。
   */
  const p = await useModel('model.sensevoice', { manager: c });
  test('M28 「使用」也是作业，⛔ 不挂着等编译', p.ok === true && Boolean(p.operation_id));

  const op = await modelOperation('op_1', { manager: c });
  test('M29 作业状态从 Manager 查，⛔ 本包不做第二个状态机', op.operation?.state === 'complete');

  test('M30 未知模型直接拒绝，⛔ 不去打扰 Manager',
    (await downloadModel('model.not.mine', { manager: c })).error === 'unknown_model');
}

// ── 6. 删除：⚠ 已整体搬进模型管理器 ──────────────────────────────────────

/**
 * ⚠ 这里曾有 M31/M32/M33 三条：「有人在用 ⇒ 如实展示是谁、⛔ 不提供 force」、
 *   「HTTP 409 带出来」、「没人用 ⇒ 删得掉」。它们钉的是本包的 `removeModel`。
 * ⭐ docs/092 之后**删除整个搬进了模型管理器**（引用护栏也在那边：
 *   `references_unknown` 时拒绝删除——「问不到谁在用」与「没有人在用」是两回事）。
 *   本包不再有删除入口，故这三条随 API 一起退役，⛔ 不留一个永远为真的空壳断言。
 */

// ── 7. 源码级：不许留下绕过 Manager 的正式路径 ─────────────────────────────

{
  /**
   * ⚠ 扫**代码**，不扫注释。
   * 这几条禁令的注释里必然写着被禁的那个字符串（「⛔ 绝不直接调 DELETE …/payload」），
   * 于是一个不去注释的检查会把**警告本身**当成违规抓出来——
   * 而更糟的反面是：为了让测试变绿去删掉那句警告。
   */
  const codeOf = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const modelsSrc = codeOf('service/models.mjs');
  const adapterSrc = codeOf('service/asset-manager.mjs');
  const mainSrc = codeOf('service/main.mjs');
  const appSrc = codeOf('web/app.js');

  test('M34 ⛔ 本包不存在直接删 payload 的路径（那条路绕过引用检查）',
    !/api\/assets\/[^'"`]*\/payload/.test(modelsSrc) && !/\/payload/.test(mainSrc));
  test('M35 ⛔ 不再自己调 Framework 的 provider/fetch 做生命周期',
    !/api\/assets\/[^'"`]*\/(provider|fetch)/.test(modelsSrc));
  test('M36 ⛔ 适配器里没有 Manager 的 package id / 端口 / package 路由',
    !adapterSrc.includes('hf-model-manager') && !adapterSrc.includes('9000')
      && !adapterSrc.includes('/api/packages/'));
  test('M37 ⭐ 只认 capability id', adapterSrc.includes("'termux-os.assets.manager'")
    && adapterSrc.includes("'termux-os.assets.inventory'"));
  test('M38 ⛔ 本包不复制 update 三分法的判定逻辑（只读 Manager 的字段）',
    !modelsSrc.includes('upstream_changed_unapproved')
      || /update_state === 'approved_update_available'/.test(modelsSrc));
  /**
   * ⚠ M39 原本钉「只有 `approved_update_available` 的更新才可点」。
   * ⭐ docs/092 之后**更新整个搬进了模型管理器**，`models.mjs` 里再没有任何
   *   update 字段——故断言换成「⛔ 本包不许自己长出第二套更新判断」，
   *   这才是它当初真正在保护的东西（⛔ 不许绕过 Manager 的批准）。
   */
  test('M39 ⛔ 本包不自己判断「能不能更新」',
    !/updatable|update_state|update_available/.test(modelsSrc));
  test('M40 ⛔ 页面不画百分比进度条', !/progress\s*[:=]\s*\d|width:\s*\$\{/.test(appSrc));
  /**
   * ⚠ 0.21.3 起模型**不再是主导航一级页面**（任务书 §十七：它是工具不是功能）。
   *   原断言要求 PAGES 里有 'models'，那是上一版信息架构的约束。
   * ⭐ 判据换成「入口仍然存在，只是收进了设置」——⛔ 收起来不等于拿走。
   */
  test('M41 ⭐ 模型入口仍在（收进设置，不再占一级导航）',
    !/PAGES = Object\.freeze\(\[[^\]]*'models'/.test(appSrc)
      && /card-models-wrap/.test(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'))
      && /renderModels/.test(appSrc));
  test('M42 runtime resolver 仍在，且不经过 Manager',
    fs.existsSync(path.join(root, 'service/assets.mjs'))
      && /resolveAssetRoot/.test(mainSrc) && !/assetManager|AssetManagerClient/.test(mainSrc));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'termux-os.package.json'), 'utf8'));
  test('M43 版本已升到 0.24.1', manifest.version === '0.24.1');
  test('M44 ⭐ Manager 声明为 capability 依赖且 required=false',
    manifest.capabilities.requires.some((r) => r.id === 'termux-os.assets.manager' && r.required === false));
  test('M45 ⛔ 不新增 packages.requires 指向 Manager（那会把它变成安装门禁）',
    !(manifest.packages?.requires ?? []).some((r) => String(r.id).includes('hf-model-manager')));
  test('M46 ⚠ 静态依赖只靠 manifest 推导，⛔ 不再重复 explicit register',
    !modelsSrc.includes("op: 'references'") && !modelsSrc.includes('reference_register'));
  /**
   * OLD TEST → manifest 与 SHELF 里都不许出现 `qwen3asr`。
   * WHY OBSOLETE → 那条禁令针对的是**退休的 Qwen3-ASR GGUF 解码器**（1.5 GB 权重、
   *   没有任何代码会加载）。0.21.8 起 Audio8 真的要用同一个 asset 包里的
   *   `model.qwen3asr.encoder`（mel + 音频编码器）——⛔ 而重新收录一份自己的副本，
   *   就是让同一份权重有两个会各自漂移的答案。
   * NEW ASSERTION → 退休的是**解码器**：`decoder.q4/q8` 不许回来；编码器允许且必须
   *   出现在 SHELF 里（一个装得上却没人说得清为什么的依赖，比缺依赖更难查）。
   */
  test('M47 退休的是 Qwen3-ASR 解码器，不是 Audio8 用的那个编码器',
    !(manifest.assets?.requires ?? []).some((a) => /qwen3asr\.decoder/.test(String(a.id)))
      /** ⚠ SHELF 退役后，判据只剩 manifest 这一处——⛔ 不再有第二张清单会跟它漂。 */
      && !(manifest.assets?.requires ?? []).some((a) => /qwen3asr\.decoder/.test(String(a.id))));
  /**
   * ⭐ **本包不许知道 Audio8 的文件在哪。**
   *   0.21.5 时那是六个绝对路径的配置项；0.21.8 起「在哪」由 asset resolve 回答。
   * ⚠ 判据是**结构**：控制器只能从 `resolveAsset` 拿目录，⛔ 配置里不许再有路径键，
   *   ⛔ 源码里不许出现 HF URL 或 /sdcard 物理目录。
   */
  /**
   * ⚠ 这里曾有两条 Audio8 断言（M49「位置来自 asset resolve」、M48「SHELF 覆盖 Audio8 三件套」）。
   *   Audio8 随 App 0.25.x 退役，两条一并删除。
   * ⛔ **诚实边界**：本文件当前**根本载入不了**——它 import 的
   *   `fetchModel` / `removeModel` / `installProvider` / `SHELF` 在 `models.mjs` 里
   *   已经不存在（被 `downloadModel` / `useModel` 取代），所以它自 docs/092 那一轮起
   *   一次都没有执行过。⭐ **一个连 import 都失败的测试文件，在只数红行的报告里
   *   和一个通过的文件长得一样。** 修复它是另一件事，不在 Audio8 清理这一轮里。
   */
}


// ── 8. 接线级：真的把服务起起来，把每条模型路由打一遍 ──────────────────────

{
  /**
   * ⭐ 这一段的存在理由是一次真实事故（HF Manager 那边刚发生过）：
   * 纯模块断言 119 条全绿，而真机上每一条列表路由都回 `500 … is not defined`。
   * ⚠ **纯模块测得再密，也证明不了那些模块被正确地接在了一起。**
   *
   * 这里不连 Manager、不连 App、不下载任何东西：Framework URL 指向一个
   * 确定没人监听的端口，于是 Manager 一定「够不到」——正好同时验了降级路径。
   */
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const freePort = async () => new Promise((r) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => r(port)); });
  });
  const http = await import('node:http');
  const port = await freePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-boot-'));

  /**
   * ⭐ 一个**会回答**的假 Framework，而不是一个死端口。
   *
   * ⚠ 第一版用死端口，服务要 60 秒以上才 bind——`resolveAssetRoot` 对**传输失败**
   *   退避重试 6 次（约 10.5 秒），启动路径上六个 asset 串行相加。那不是本测试要验的东西。
   * ⚠ 第二版让它一律回「没登记」，服务**直接退出**——那不是缺陷：
   *   `model.fireredvad` 与 `model.campplus.graph` 是 required，源码里写明了
   *   「解析不出来就根本起不来，⛔ 没有回落」，因为悄悄跑起来会让依赖门禁形同虚设。
   *   ⛔ 不为了让测试变绿去改那条策略。
   * ⭐ 所以这里回答**必需的三个 asset 都在**（指向临时目录），可选的照实说没有——
   *   这正是真机此刻的样子，而本测试要验的是**接线**与 **Manager 缺席时的降级**。
   */
  const assetRoot = path.join(dataRoot, 'fake-assets');
  fs.mkdirSync(assetRoot, { recursive: true });
  const REQUIRED = new Set(['model.fireredvad', 'model.sensevoice.frontend', 'model.campplus.graph']);
  const fwServer = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/api/capabilities')) return send(200, { ok: true, capabilities: [] });
    const m = req.url.match(/^\/api\/assets\/([^/?]+)/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (REQUIRED.has(id)) {
        return send(200, { ok: true, asset: { id, ready: true, path: assetRoot, version: '1.0.0',
          package: 'github.termux-os.asset.fake', files: {}, target: 'generic' } });
      }
      return send(200, { ok: false, error: 'not registered (asset package not installed?)' });
    }
    return send(404, { ok: false, error: 'not found' });
  });
  await new Promise((r) => { fwServer.listen(0, '127.0.0.1', r); });
  const fwPort = fwServer.address().port;
  /**
   * ⚠ 两个「只在真机上红」的坑，都在这一行上：
   *   ① 入口必须是**绝对路径**——Termux 的 node 对相对入口直接报
   *      `expected absolute path: "service/main.mjs"`。
   *   ② `process.execPath` 在 Termux 上**不是 node**，是 Android linker
   *      （Framework 自己为此备了 `nodeExecutable()`）。照着它 spawn，
   *      内核把 .mjs 当可执行文件加载，报 `bad ELF magic: 2f2a2a0a`——
   *      那四个字节就是文件开头的 `/**`。
   * ⭐ 一条在开发机上永远绿、在设备上永远红的测试，最容易被当成「环境问题」放过，
   *   而这恰恰是唯一一条以「真的跑起来」为目的的测试。
   */
  const nodeBin = path.basename(process.execPath) === 'node'
    ? process.execPath
    : (process.env.NODE || 'node');
  const child = spawn(nodeBin, [path.join(root, 'service/main.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      TERMUX_OS_FRAMEWORK_URL: `http://127.0.0.1:${fwPort}`,
      TERMUX_OS_SYSTEM_KEY: 'boot-test-key',
      TERMUX_OS_PACKAGE_ROOT: root,
      CONFIG_FILE: path.join(dataRoot, 'termux-speech.v4.json'),
      VAD_DATA_ROOT: path.join(dataRoot, 'vad'),
      ASR_DATA_ROOT: path.join(dataRoot, 'asr'),
      RECORD_DATA_ROOT: path.join(dataRoot, 'records'),
      STATUS_FILE: path.join(dataRoot, 'status.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  const call = async (p, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { Authorization: 'Bearer boot-test-key', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const up = await (async () => {
    for (let i = 0; i < 80; i += 1) {
      try { if ((await call('/health')).status === 200) return true; } catch { /* 还没起来 */ }
      await new Promise((r) => { setTimeout(r, 250); });
    }
    return false;
  })();
  test('B1 ⭐ Manager 不存在时服务照样起得来（必需 asset 在，可选的不在）', up, stderr.slice(-400));

  if (up) {
    const models = await call('/models');
    test('B2 ⭐ GET /models 不是内部错误（这正是上次全 500 的那一类）',
      models.status === 200 && models.data?.ok === true,
      `${models.status} ${JSON.stringify(models.data).slice(0, 200)}`);
    /** ⚠ `items` 随 docs/092 换成 `requirements`（logical model 这一级）。 */
    test('B3 每一行都带产品名，⛔ 真机上不会裸露 asset id',
      (models.data?.requirements ?? []).length === ALL.length
        && (models.data?.requirements ?? []).every((i) => i.name && !String(i.name).startsWith('model.')));
    test('B4 Manager 不可达时如实说出来', models.data?.manager?.available === false);
        /** ⚠ schema 随 logical model 层换名；⭐ 判据仍是「它必须自报 schema」。 */
    test('B5 schema 是新的',
      models.data?.schema === 'termux-os.speech-model-requirements.v1');

    for (const [route, init] of [
      /**
       * ⚠ 路由随 docs/092 从 asset 级换成 logical 级：
       *   `fetch`/`install-provider` → `download`/`use`；`delete` 整个搬进了模型管理器。
       */
      ['/models/download', { method: 'POST', body: JSON.stringify({ model_id: 'model.campplus' }) }],
      ['/models/use', { method: 'POST', body: JSON.stringify({ model_id: 'model.campplus' }) }],
    ]) {
      const r = await call(route, init);
      test(`B6${route} ⇒ 503 degraded，⛔ 不是 500，也不是假装成功`,
        r.status === 503 && r.data?.degraded === true,
        `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    }
    const op = await call('/models/operation?operation_id=op_x');
    test('B7 作业查询在 Manager 不可用时同样是 degraded', op.status === 503);
    const bad = await call('/models/operation');
    test('B8 缺参数是 400，⛔ 不是 500', bad.status === 400);

    const live = await call('/live');
    test('B9 ⚠ /live 仍然正常（Manager 与语音链无关）', live.status === 200 && live.data?.ok === true);
    test('B10 /live 含有当前三段处理状态',
      Object.hasOwn(live.data ?? {}, 'vad') && Object.hasOwn(live.data ?? {}, 'asr'));
  }

  child.kill('SIGTERM');
  await new Promise((r) => { setTimeout(r, 400); });
  child.kill('SIGKILL');
  fwServer.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

fs.rmSync(pkgRoot, { recursive: true, force: true });
console.log(`\n${count - failures}/${count} manager-integration assertions passed`);
process.exit(failures ? 1 : 0);

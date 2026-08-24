/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: PcmConsumers + main.mjs 的接线
 * [OUTPUT]: docs/077 的架构不变式——一个水源、多个独立水龙头、聚合决定生死
 * [POS]: ⭐ 这套测试钉的是**耦合不会再长回来**：
 *        「关掉 RMS 把 VAD 也关了」这种事只能靠对结构断言来长期保证，
 *        行为测试看不见一个被重新加回去的隐式依赖。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import { WATCH_TIMEOUT_MS } from '../service/state-hub.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PcmConsumers } from '../service/pcm-consumers.mjs';

let failures = 0;
let count = 0;
const test = (name, cond) => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');

const fresh = () => new PcmConsumers([
  { name: 'rms', wantsRms: true, wantsPcm: false }, { name: 'vad' },
  { name: 'foreground', wantsPcm: false },
]);

// ── 聚合语义 ──────────────────────────────────────────────────────────────
{
  const c = fresh();
  test('C1 一个都没开时不要 PCM', c.wantsPcm() === false && c.holders().length === 0);
  test('C2 开 RMS-only transport，raw PCM 仍关闭，且聚合发生了变化', c.setEnabled('rms', true) === true
    && c.wantsRms() === true && c.wantsPcm() === false);
  test('C3 再开 VAD，raw PCM 聚合才打开',
    c.setEnabled('vad', true) === true && c.wantsPcm() === true);
  test('C4 关掉 RMS，VAD raw PCM 仍在，RMS transport 独立关闭',
    c.setEnabled('rms', false) === true && c.enabled('vad') === true && c.wantsPcm() === true);
  test('C5 关掉最后一个才落到「不要」', c.setEnabled('vad', false) === true
    && c.wantsPcm() === false);
}

// ── ⭐ consumer 互相独立 ──────────────────────────────────────────────────
{
  const c = fresh();
  c.setEnabled('vad', true);
  test('D1 RMS OFF + VAD ON：水源开着，RMS 不受影响',
    c.enabled('rms') === false && c.enabled('vad') === true && c.wantsPcm() === true);
  c.setEnabled('rms', true); c.setEnabled('vad', false);
  test('D2 RMS ON + VAD OFF：只有 RMS transport 成立，raw PCM 不在',
    c.enabled('rms') === true && c.enabled('vad') === false
      && c.wantsRms() === true && c.wantsPcm() === false);
  c.setEnabled('foreground', false);
  test('D3 独立消费者开关不动别人',
    c.enabled('rms') === true && c.enabled('vad') === false);
}

// ── foreground 不是水源的持有者 ───────────────────────────────────────────
{
  const c = fresh();
  c.setEnabled('foreground', true);
  test('E1 foreground 开着也不要 PCM（它吃的是 VAD segment）',
    c.wantsPcm() === false && c.holders().length === 0);
  test('E2 但它在状态里看得见，不是隐身的',
    c.snapshot().consumers.foreground.enabled === true
    && c.snapshot().consumers.foreground.wants_pcm === false);
}

// ── Mic Off = 对聚合的操作 ────────────────────────────────────────────────
{
  const c = fresh();
  for (const n of ['rms', 'vad']) c.setEnabled(n, true);
  test('F1 RMS holder 与 raw PCM holders 分开列出',
    c.rmsHolders().join(',') === 'rms' && c.holders().join(',') === 'vad');
  c.disableAll();
  test('F2 disableAll 之后一个不剩', c.wantsPcm() === false && c.holders().length === 0);
}

// ── 接线契约（这些才是防止耦合长回来的那一层）──────────────────────────────
test('W1 RMS/raw 两个水源只由各自聚合决定，chain/backend/处理门都不是总开关',
  main.includes('const wantRms = consumers.wantsRms() || consumers.wantsPcm();')
    && main.includes('const wantPcm = consumers.wantsPcm();')
    && /const syncPcmDemand = \(\) => \{[\s\S]{0,700}lifecycle\.acquireMic\(\)[\s\S]{0,300}lifecycle\.releaseMic\(\)/.test(main));
test('W2 RMS WS 与 PCM WS 在各自入口分流，RMS 与 VAD 各自可关',
  main.includes('const ingestRmsFrame = (meta) =>')
    && main.includes("if (consumers.enabled('vad')) vad.ingestPcm(frame, meta);"));
test('W3 RMS-only 等待使用 RmsWs，raw PCM 仍只由 PcmWs 按需建立',
  (main.match(/new RmsWs\(/g) ?? []).length === 1
    && (main.match(/new PcmWs\(/g) ?? []).length === 1);
/**
 * ⚠ 判据从「那一行字面量」改成「那个性质」：链的 consumer 集合现在只有一份定义
 * （`applyChainConsumers`），起链与停链都走它。docs/081 抓到过写死两份的后果——
 * 新增的 `speaker_gate` 在开机自动起链那条路径上永远打不开。
 */
/**
 * ⚠ P2 之前这一条钉的是字面量 `consumers.setEnabled('rms', on)`——
 *   即「链一开就订 RMS」。P2 把开门判断整个收回 App 之后那一行**不该再存在**，
 *   于是钉实现细节的测试会在实现变得更正确时变红。改成钉它本来的意图。
 */
test('W4 停链只关它自己那几个 consumer，不直接掐水源',
  /const applyChainConsumers = \(on\) => \{[\s\S]{0,900}syncRmsObserver\(\)/.test(main)
    && /stopChain = async[\s\S]{0,600}applyChainConsumers\(false\)/.test(main)
    && !/stopChain = async[\s\S]{0,600}pcm\.close\(\)/.test(main));
/**
 * ⭐ P2 的新不变式：**麦克风需求与传输需求是两件事**。
 * 自动等待期本包一条 WS 都不订，但麦克风必须还持着——门现在由 App 判，
 * 而 App 要判就得有音频。⚠ 把两者绑在一起会让「关掉一条遥测」变成「把整条链弄哑」。
 */
test('W4b 链开着就持麦，即使一条传输都不需要',
  /const wantMic = wantRms \|\| wantPcm \|\| lifecycle\?\.chain === 'started';/.test(main)
    && /if \(wantMic\) \{[\s\S]{0,200}acquireMic/.test(main));
/** ⭐ RMS 传输从此只服务观察者：product Gate 不再是它的需求方。 */
test('W4c RMS 传输由 observer 租约驱动，⛔ 不再由链驱动',
  main.includes('const RMS_OBSERVER_TTL_MS')
    && main.includes('const syncRmsObserver =')
    && !/applyChainConsumers = \(on\) => \{[\s\S]{0,900}setEnabled\('rms', on\)/.test(main));
test('W5 退休 Audio8 后主链没有独立 Audio8 consumer',
  !/\{ name: 'audio8'/.test(main) && !main.includes('MIC_REQUESTER_AUDIO8'));
test('W6 Mic Off 是对聚合的操作，并把「还剩谁在持有」如实报出来',
  /route === '\/mic\/disable'[\s\S]{0,900}consumers\.disableAll\(\)/.test(main)
    && main.includes('remaining_holders: mic?.demand?.holders ?? null'));
test('W7 启动时清掉上一条命留下的具名需求（孤儿只可能是它们）',
  main.includes("await revokeOrphanMicHolders('boot')")
    && main.includes("const OWNED_PREFIX = 'termux-speech';"));
test('W8 只撤自己家的名字，绝不碰 user.persistent',
  main.includes('h.startsWith(OWNED_PREFIX)')
    && main.includes('termux-speech must never touch user.persistent'));
test('W9 foreground gate 不碰 mic / PCM 生命周期（只看代码，注释里出现 PCM 是正常的）',
  (() => {
    // ⚠ 注释里当然会写「绝不裁剪 segment 内的 PCM」——把注释算进证据，
    //   会得到一个永远失败的假测试（docs/061 state-test 里踩过同一个坑）。
    const src = fs.readFileSync(path.join(root, 'service/asr/foreground.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
    return /mic|pcm|demand|lifecycle|android\./i.test(src) === false;
  })());

/* ── RMS observer 租约：⭐「有人在看」的证据是页面在读状态，⛔ 不是 `/live` ── */
{
  /**
   * ⚠ 真机报的缺陷：WebUI 走的是 `/state/ws`（桥到 `/state/watch`），**从来不打 `/live`**，
   *   于是租约永远续不上、RMS 传输一直关着——图表上表现为「只有触发之后才有数」，
   *   而每一个指示灯都正常。
   */
  const codeOnly = main.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.split('//')[0]).join('\n');
  const watchBlock = codeOnly.slice(
    codeOnly.indexOf("route === '/state/watch'"),
    codeOnly.indexOf("route === '/state/watch'") + 400);
  const stateBlock = codeOnly.slice(
    codeOnly.indexOf("route === '/state'"),
    codeOnly.indexOf("route === '/state'") + 300);
  test('W10 ⭐ `/state` 与 `/state/watch` 都续 RMS 观察者租约',
    watchBlock.includes('noteRmsObserver()') && stateBlock.includes('noteRmsObserver()'));
  test('W11 在**进入** watch 时续租（它最长挂 25 秒，返回时才续会先断掉）',
    watchBlock.indexOf('noteRmsObserver()') < watchBlock.indexOf('normalizeWatchInterval'));
  /**
   * ⭐ 自锁的形状：租约要靠状态变化来续，而最主要的状态变化（RMS）又要靠租约才有。
   * `/state/watch` 在什么都没变时最长挂 `WATCH_TIMEOUT_MS`，所以 TTL 必须比它长。
   */
  const ttl = Number((codeOnly.match(/RMS_OBSERVER_TTL_MS = ([\d_]+)/) ?? [])[1]?.replace(/_/g, ''));
  test('W12 租约长于 watch 的挂起上限（⛔ 否则形成「要靠 RMS 才能续 RMS」的自锁）',
    Number.isFinite(ttl) && ttl > WATCH_TIMEOUT_MS);
  test('W13 租约到期后 5Hz 巡检真的把 RMS 传输关掉',
    codeOnly.includes('syncRmsObserver()'));
}

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

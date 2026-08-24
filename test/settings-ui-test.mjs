/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `web/index.html` / `web/app.js` / `web/style.css` 的源码
 * [OUTPUT]: policy 单卡、ASR 单一模型选择与使用者本轮界面要求的回归
 * [POS]: 纯静态断言，⛔ 不起浏览器。⭐ 这三条都不是"看起来不好看"，
 *        每一条都会让界面进入一个**退不出去**或**改了不生效**的状态。
 * ⚠ 与 `self-test.mjs` 的 `codeOnly()` 同一条教训：断言"代码里不许有 X"之前先剥注释。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../web/index.html');
const app = read('../web/app.js');
const css = read('../web/style.css');
/** 只留会执行的代码：注释里出现某个名字不算"还在用它"。 */
const code = app.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.split('//')[0]).join('\n');

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };

const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-voice"'));

// ── ① policy 的每个可调项只有一个入口 ─────────────────────────────────────
test('S1 存在一张"策略参数（policy）"卡', settings.includes('id="card-policy"'));

test('S2 ⭐ 音量阈值只有一个入口（⛔ 同一字段两个入口迟早各说各的）',
  (settings.match(/id="open-threshold"/g) ?? []).length === 1
  && (settings.match(/id="open-number"/g) ?? []).length === 1);

test('S3 音量阈值的那个入口在 policy 卡里，⛔ 不在语音检测那一组',
  settings.slice(settings.indexOf('id="card-policy"'), settings.indexOf('id="form-daily"'))
    .includes('id="open-threshold"'));

test('S4 ⛔ 旧的分段 ± 按钮已经不在（它们被 policy 卡的输入框取代）',
  !html.includes('id="seg-head-up"') && !html.includes('id="seg-tail-up"')
  && !html.includes('id="seg-grace-up"') && !code.includes("'seg-head-up'"));

test('S5 ⛔ 音量阈值不再由语音检测那一组保存',
  !code.slice(code.indexOf("saveGroup('detect'"), code.indexOf("saveGroup('detect'") + 400)
    .includes('/rms/config'));

/** ⭐ 映射只写一遍：读、写、脏检查共用同一张表，⛔ 手写两遍必然漂。 */
test('S6 policy 字段映射只有一份定义',
  (code.match(/const POLICY_FIELDS = Object\.freeze\(/g) ?? []).length === 1
  && code.includes('function fillPolicyForm') && code.includes('function collectPolicy'));

test('S7 每一个映射到的 id 在 HTML 里真的存在', (() => {
  const ids = [...code.matchAll(/\['([a-z0-9-]+)', '(gate|speaker|vad|segment)'/g)].map((m) => m[1]);
  return ids.length >= 18 && ids.every((id) => settings.includes(`id="${id}"`));
})());

test('S8 保存走一次完整 PUT（generation+1），⛔ 不是逐字段 setter',
  code.includes("$('policy-save')") && code.includes('putPolicy((p) => { collectPolicy(p); })')
  && code.includes('next.generation = Number(current.generation ?? 0) + 1'));

/** ⛔ 已停用 / 没有执行方的参考不应继续占据产品设置页。 */
test('S9 设置页不展示停用项、无执行方参考或第二个 ASR backend',
  !settings.includes('policy-readonly')
  && !settings.includes('已停用')
  && !settings.includes('尚无执行方')
  && !settings.includes('asr.backend')
  && !code.includes('renderPolicyReadonly'));

test('S10 policy 保存时把内部 backend 投影钉回 cfg.asr.model',
  code.includes("request('/asr/config')")
  && code.includes('(next.asr ??= {}).backend = selectedModel'));

test('S11 正在编辑时不许被后台刷新覆盖',
  code.includes('policyDirty') && code.includes('if (!policy || policyDirty) return;'));

// ── ② 拍掌卡：退出某个状态的按钮永远可点 ───────────────────────────────────
test('S12 ⭐ 测试中的"停止测试"不因为没有模板而禁用',
  code.includes("testBtn.disabled = testing ? clapBusy : (!ready || enrolling || clapBusy);"));

test('S13 录制中的"停止"同样不被 testing 禁用',
  code.includes("startBtn.disabled = clapBusy || (enrolling ? false : testing);"));

test('S14 四个按钮不可能同时禁用（测试中至少"停止测试"可点）', (() => {
  // 用最坏的一组事实模拟一次：测试中 + 没有模板 + 没有样本 + 不忙
  const testing = true; const ready = false; const enrolling = false;
  const captured = 0; const clapBusy = false;
  const start = clapBusy || (enrolling ? false : testing);
  const build = !enrolling || captured < 5;
  const stop = testing ? clapBusy : (!ready || enrolling || clapBusy);
  const clear = clapBusy || (!ready && captured === 0);
  return !(start && build && stop && clear);
})());

// ── ③ LIVE 图：1 秒一柱、浅灰 RMS、与判决柱重叠 ────────────────────────────
test('S15 ⭐ 一秒一柱（⛔ 不随状态流的 interval 漂移）',
  code.includes('const bucket = Math.floor(Date.now() / 1000);')
  && code.includes('liveSlots.get(bucket)'));

test('S16 同一秒内 RMS 取峰值（⛔ 均值会把开门那一下抹平）',
  code.includes('slot.rms = Math.max(Number(slot.rms) || 0, currentRms);'));

test('S17 RMS 柱是浅灰且在底层', /\.bar-rms\s*\{[^}]*background:\s*#94a3b8/.test(css)
  && /\.bar-rms\s*\{[^}]*z-index:\s*0/.test(css));

/**
 * ⭐ **按新意图改写**（docs/091 PART B），⛔ 不是绕过 S18。
 *
 * 旧断言要求判决柱**收窄**（left/right:28%），那是为了不遮住底层的浅灰参照量。
 * 使用者实测反馈：不同种类的柱宽度不一致，读图时会以为它们代表不同的时间跨度。
 * 现在的约束反过来——**所有图层同宽同 x**，靠不透明度与层序分层。
 */
test('S18 ⭐ 所有图层同宽同 x（⛔ 不许某一层画得更窄）', (() => {
  const layer = (name) => {
    const m = new RegExp(`\\.bar-${name}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : null;
  };
  const names = ['rms', 'gate', 'speech', 'firered'];
  return names.every((n) => {
    const body = layer(n);
    return body !== null
      && /left:\s*0;/.test(body) && /right:\s*0;/.test(body)
      && !/left:\s*\d+%/.test(body) && !/width:/.test(body);
  });
})());

test('S19 固定 60 个 slot = 最近一分钟，⛔ 柱宽不随条数变',
  code.includes('const LIVE_WINDOW_SECONDS = 60;')
  && /grid-template-columns:\s*repeat\(60,\s*minmax\(0,\s*1fr\)\)/.test(css)
  && !/\.cam-col[^{]*\{[^}]*flex:\s*1/.test(css));

test('S19b 每一帧都渲染满 60 个格子（缺数据的留空）',
  code.includes('for (let i = 0; i < LIVE_WINDOW_SECONDS; i += 1)')
  && code.includes('cam-col-empty'));

test('S19c ⭐ slot 的身份是「那一秒」而不是数组下标',
  code.includes('const first = nowBucket - (LIVE_WINDOW_SECONDS - 1);')
  && code.includes('if (key <= bucket - LIVE_WINDOW_SECONDS) liveSlots.delete(key);'));

/**
 * ⭐ 未过判断门时**不许**画「语音」柱（docs/091 PART C）——使用者实测到的正是这个。
 * 三条判据缺一不可：门开了、状态是 USER、这一秒真有一条 activity 事实。
 */
test('S19d 语音柱的判据是产品事实而不是 CAM++ 相似度',
  code.includes('const gateAdmitted = cam?.active === true || cam?.inference_admitted === true;')
  && code.includes("const speechNow = gateAdmitted && camState === 'USER' && userFresh;")
  && code.includes('slot.speech = slot.speech || speechNow;'));

test('S19e ⛔ 静止的 USER 状态不许每秒复制成一根新柱',
  code.includes('lastUserAdvanceAtMs') && code.includes('USER_FACT_FRESH_MS'));

test('S19f raw similarity 只进 tooltip，⛔ 不进产品判据',
  !/slot\.speech\s*=\s*[^;]*sim/.test(code));

// ── ④ 「门永远不会开」必须说出来 ────────────────────────────────────────────
test('S20 Overview 上有一条「门被堵住」的横幅', html.includes('id="ov-gate-blocked"'));

test('S21 ⭐ 判据由后端给（⛔ 页面不自己从两个字段推）',
  code.includes("rms?.gate_blocked === true"));

test('S22 ⚠ 横幅代码必须待在**有 `rms` 的那个渲染函数里**', (() => {
  const i = code.indexOf('const blockedBanner');
  if (i < 0) return false;
  const head = code.slice(0, i);
  const starts = [...head.matchAll(/\n(function [A-Za-z]|const [A-Za-z]+ = \()/g)].map((m) => m.index);
  const fn = head.slice(starts[starts.length - 1], starts[starts.length - 1] + 400);
  // 第一版落在了 `updateHeaderStatus()` 里，那里根本没有 `rms` 这个名字——
  // 一个恒为 undefined 的判据只会让横幅永远不显示，而且不报错。
  // ⚠ 匹配是从那个 `\n` 开始的，所以第 0 行是空串——取第一行要先把它剥掉。
  return /\brms\b/.test(fn.replace(/^\n/, '').split('\n')[0]);
})());

// ── ⑤ 关门倒计时可调，且入口只有一个 ──────────────────────────────────────
test('S23 关门倒计时是 policy 的一个字段，入口在 policy 卡里',
  settings.includes('id="pol-spk-usertimeout"')
  && code.includes("['pol-spk-usertimeout', 'speaker', 'user_timeout_ms', 'int']"));

test('S24 ⛔ 它没有第二个入口', (settings.match(/user_timeout_ms/g) ?? []).length === 1);

// ── 使用者反馈②③：入口唯一性 ────────────────────────────────────────────

/**
 * ⭐ 触发方式（音量/拍掌）**就是 policy 的一个字段**，所以它只能住在 policy 卡里。
 * ⚠ 它曾经在卡外另有一组 tab —— 那是第二个写入点，而这张卡的规矩就是
 *   「每个可调项只出现一次」。两个入口写同一个字段，迟早各说各的。
 */
test('S25 gate.mode 在 policy 卡里，且只有一个入口',
  html.includes('id="pol-gate-mode"')
  && code.includes("['pol-gate-mode', 'gate', 'mode', 'str']")
  && !html.includes('id="trg-volume"') && !html.includes('id="trg-clap"'));

test('S26 ⛔ 触发方式没有第二个写入点',
  !/trg-volume|trg-clap/.test(code));

/** ⭐ 保存 ASR 设定**就是**切换：⛔ 没有「选了但没切」这个状态。 */
test('S27 ASR 只有一个提交按钮',
  !html.includes('id="asr-model-apply"')
  && html.includes('id="save-daily"'));

test('S28 保存时先切模型再存语言，并回读后端确认',
  code.includes('const wantedModel = $(\'asr-model\').value;')
  && code.includes("confirmed.value.model !== wantedModel"));

console.log(`settings-ui-test: ${count - failures}/${count} assertions passed`);
process.exit(failures === 0 ? 0 : 1);

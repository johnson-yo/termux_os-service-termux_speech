/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework base URL + token（其它什么都不给）
 * [OUTPUT]: 一个下游 package 能否**只靠正式公共契约**用上语音服务的证明
 * [POS]: ⭐ 这是 `docs/PUBLIC_STATE.md` 的验收夹具，不是示例代码。
 *
 * 它被刻意写成「营养不良」的样子：全文没有 RMS / CAM++ / FireRedVAD / ASR spool /
 * segment 数据库 / `/live` 的任何调试域，也没有 speech 的 package id。
 * ⛔ 只要有一处越界，这个夹具就失去意义——它要证明的正是「下游不需要理解内部实现」。
 * 契约测试会对本文件做源码级检查。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const STATE_CAPABILITY = 'speech.state';

const call = async (baseUrl, token, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

/**
 * 一个下游消费方的完整生活：发现 → 读状态 → 认出五件事。
 * @returns `{ok, degraded, steps}`
 */
export const runConsumer = async ({ baseUrl, token }) => {
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail: String(detail) }); return ok; };

  // ① 发现。⭐ 唯一入口是能力目录，⛔ 不写死 package id。
  const list = await call(baseUrl, token, '/api/capabilities');
  const ids = (list.data?.capabilities ?? []).map((c) => c?.id ?? c?.capability ?? c);
  if (!ids.includes(STATE_CAPABILITY)) {
    // ⚠ 语音服务没装不是错误：消费方要能在没有它的机器上活着。
    step('discovery', true, 'speech not installed — consumer degrades cleanly');
    return { ok: true, degraded: true, steps };
  }
  step('discover speech.state capability', true, STATE_CAPABILITY);

  // ② 读一次状态。
  const invoked = await call(baseUrl, token, `/api/capabilities/${STATE_CAPABILITY}/invoke`,
    { method: 'POST', body: { input: '' } });
  const s = invoked.data?.value ?? null;
  step('invoke returns a product state', s?.schema === 'termux-os.speech-product-state.v1',
    JSON.stringify(invoked.data).slice(0, 160));
  if (!s) return { ok: false, degraded: false, steps };

  // ③ 五件事都在，且都能不看内部实现就读懂。
  step('① 服务能不能用', typeof s.service?.ready === 'boolean'
    && typeof s.service?.degraded === 'boolean'
    && typeof s.service?.features === 'object',
    `ready=${s.service?.ready} degraded=${s.service?.degraded}`);
  step('② 有没有人在说话', typeof s.activity?.active === 'boolean',
    `active=${s.activity?.active} source=${s.activity?.source}`);
  step('③ 是不是本人', ['user', 'other', 'unknown'].includes(s.activity?.user_state),
    `user_state=${s.activity?.user_state}`);
  step('④ 现在识别到什么（provisional/final 分得开）',
    'provisional_text' in (s.transcription ?? {}) && 'final_text' in (s.transcription ?? {})
      && [null, 'incomplete', 'complete'].includes(s.transcription?.status),
    `status=${s.transcription?.status}`);
  step('⑤ 最后一次识别到什么', 'latest_final_text' in (s.latest ?? {}),
    `latest=${JSON.stringify(s.latest?.latest_final_text)}`);
  // ④ ⛔ 契约里**不该**出现内部实现。
  /**
   * ⛔ 契约里不该出现内部实现。
   *
   * ⚠ 判据看的是**键名**，⛔ 不是把整份 JSON 当字符串扫：
   *   第一版用 `/rms/i` 扫全文，结果被 `"terms"` 里的 "rms" 命中——
   *   与上一轮 `hi` 命中 `this` 完全同一个坑，而这次是我自己写的检查踩的。
   */
  const keys = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) { keys.add(k.toLowerCase()); walk(v); }
  }(s));
  const banned = ['rms', 'campplus', 'fireredvad', 'qnn', 'htp', 'spool', 'holder',
    'similarity', 'threshold', 'score', 'profile'];
  const leaked = banned.filter((b) => [...keys].some((k) => k === b || k.includes(`_${b}`) || k.startsWith(`${b}_`)));
  step('⛔ 状态里没有内部实现细节（按键名判，⛔ 不按子串）',
    leaked.length === 0, `leaked=${leaked.join(',')} keys=${[...keys].join(',')}`);
  /** ⭐ 公共状态里不许有中文：下游可能是另一种语言的界面，人话映射归它自己。 */
  step('⛔ 状态里没有中文（人话映射归消费方）', !/[一-龥]/.test(
    JSON.stringify({ ...s,
      transcription: { ...s.transcription, provisional_text: null, final_text: null },
      latest: { ...s.latest, latest_final_text: null } }),
  ));

  // ⑤ 变化可被观察：change_seq 单调。
  const again = await call(baseUrl, token, `/api/capabilities/${STATE_CAPABILITY}/invoke`,
    { method: 'POST', body: { input: '' } });
  const s2 = again.data?.value;
  step('change_seq 可用于判断「变没变」', typeof s2?.change_seq === 'number'
    && s2.change_seq >= s.change_seq, `${s.change_seq} → ${s2?.change_seq}`);

  return { ok: steps.every((x) => x.ok), degraded: false, steps };
};

if (process.argv[1] && process.argv[1].endsWith('consumer-fixture.mjs')) {
  const baseUrl = process.env.FRAMEWORK_URL ?? 'http://127.0.0.1:8980';
  const token = process.env.TERMUX_OS_SYSTEM_KEY ?? '';
  if (!token) { console.error('TERMUX_OS_SYSTEM_KEY required'); process.exit(2); }
  const r = await runConsumer({ baseUrl, token });
  for (const x of r.steps) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`);
  console.log(r.degraded ? '\nDEGRADED (speech absent)' : `\n${r.ok ? 'CONSUMER OK' : 'CONSUMER FAILED'}`);
  process.exit(r.ok ? 0 : 1);
}

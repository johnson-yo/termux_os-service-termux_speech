/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `SpeechPublicState` + `featureReadiness`，以及 main.mjs / package.mjs 的接线
 * [OUTPUT]: 产品状态的回归——生命周期、迟到 revision、空结果、latest 保留、功能可用性
 * [POS]: ⭐ 守两条线：**下游只读这一份**，以及 **latest 回到待机后不能消失**。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpeechPublicState, featureReadiness, SCHEMA } from '../service/public-state.mjs';

let failures = 0;
let count = 0;
const test = (name, cond, detail = '') => {
  count += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures += 1;
};
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let clock = 1_000_000;
const make = () => new SpeechPublicState({ now: () => clock });
const seg = (id) => ({ segment_id: id });
const inc = (text, revision = 1) => ({ text, revision, segment_status: 'incomplete' });
const fin = (text, revision = 1, extra = {}) => ({ text, revision, segment_status: 'complete', ...extra });

// ── 1. 一整条生命周期 ──────────────────────────────────────────────────────

{
  const s = make();
  const idle0 = s.snapshot();
  test('L1 待机：转写为空、活动为假', idle0.transcription.active === false
    && idle0.transcription.status === null && idle0.activity.active === false);
  test('L2 待机时 latest 也是空的（还没说过话）', idle0.latest.latest_final_text === null);

  s.setActivity({ active: true, source: 'resident', userState: 'user' });
  const a = s.snapshot();
  test('L3 活动：说得出来源与是不是本人',
    a.activity.active === true && a.activity.source === 'resident' && a.activity.user_state === 'user');
  test('L4 活动有起始时刻', typeof a.activity.started_at === 'number');

  clock += 500;
  s.noteTranscript(seg('s1'), inc('今天天'));
  const p1 = s.snapshot();
  test('L5 临时结果：status=incomplete 且有 provisional_text',
    p1.transcription.status === 'incomplete' && p1.transcription.provisional_text === '今天天'
      && p1.transcription.final_text === null && p1.transcription.active === true);

  clock += 500;
  s.noteTranscript(seg('s1'), inc('今天天气', 2));
  test('L6 同一段的下一个 revision 覆盖临时文字',
    s.snapshot().transcription.provisional_text === '今天天气');
  test('L7 ⚠ started_at 不因为 revision 变化而重置',
    s.snapshot().transcription.started_at === p1.transcription.started_at);

  clock += 500;
  s.noteTranscript(seg('s1'), fin('今天天气不错', 3));
  const f = s.snapshot();
  test('L8 最终结果：status=complete、final_text 有值、provisional 清空',
    f.transcription.status === 'complete' && f.transcription.final_text === '今天天气不错'
      && f.transcription.provisional_text === null && f.transcription.active === false);
  test('L9 latest 同步更新', f.latest.latest_final_text === '今天天气不错'
    && f.latest.latest_segment_id === 's1' && typeof f.latest.latest_final_at === 'number');

  s.idle();
  const back = s.snapshot();
  test('L10 ⭐ 回到待机：transcription 清空', back.transcription.status === null
    && back.transcription.final_text === null && back.transcription.active === false);
  test('L11 ⭐⭐ 但 latest **仍然保留**（这正是下游要读的东西）',
    back.latest.latest_final_text === '今天天气不错');
  test('L12 活动也回到待机', back.activity.active === false && back.activity.source === null);
}

// ── 2. 下一段不能继承上一段 ────────────────────────────────────────────────

{
  const s = make();
  s.noteTranscript(seg('s1'), fin('第一句'));
  s.idle();
  s.noteTranscript(seg('s2'), inc('第二'));
  const v = s.snapshot();
  test('N1 ⭐ 新一段开始时，⛔ 不许把上一条 final 当成这一段的临时文字',
    v.transcription.provisional_text === '第二' && v.transcription.final_text === null);
  test('N2 但 latest 还是上一句（它还没说完新的）', v.latest.latest_final_text === '第一句');
  test('N3 segment_id 跟着换', v.transcription.segment_id === 's2');
}

// ── 3. 迟到的 revision ─────────────────────────────────────────────────────

{
  const s = make();
  s.noteTranscript(seg('s1'), inc('新版本', 5));
  s.noteTranscript(seg('s1'), inc('旧版本', 2));
  test('R1 ⭐ 迟到的 revision 不回写（否则页面上文字会倒退）',
    s.snapshot().transcription.provisional_text === '新版本');
  s.noteTranscript(seg('s1'), fin('旧的最终', 3));
  test('R2 迟到的 complete 同样不回写',
    s.snapshot().transcription.status === 'incomplete'
      && s.snapshot().latest.latest_final_text === null);
  s.noteTranscript(seg('s1'), fin('真正的最终', 6));
  test('R3 更新的 revision 照常生效', s.snapshot().latest.latest_final_text === '真正的最终');
}

// ── 4. 空结果 ──────────────────────────────────────────────────────────────

{
  const s = make();
  s.noteTranscript(seg('s1'), fin('有内容'));
  s.noteTranscript(seg('s2'), fin('   '));
  test('B1 ⭐ 空白结果不进 latest（⛔ 不许冲掉上一句有用的话）',
    s.snapshot().latest.latest_final_text === '有内容'
      && s.snapshot().latest.latest_segment_id === 's1');
  test('B2 但它自己那一段如实标成 complete + final_text=null',
    s.snapshot().transcription.status === 'complete'
      && s.snapshot().transcription.final_text === null);
  s.noteTranscript(seg('s3'), fin('', 1, { blank: true }));
  test('B3 显式 blank 同样不进 latest', s.snapshot().latest.latest_final_text === '有内容');
}

// ── 5. 重转写 ──────────────────────────────────────────────────────────────

{
  const s = make();
  s.noteTranscript(seg('s1'), fin('现在说的'));
  const before = s.snapshot().latest.latest_final_at;
  clock += 10_000;
  s.noteTranscript(seg('old'), fin('几小时前那句', 1, { retranscribe: true }));
  const after = s.snapshot();
  test('T1 ⛔ 重转写不动产品状态（那是回看历史，不是此刻在说话）',
    after.latest.latest_final_text === '现在说的' && after.latest.latest_final_at === before);
  test('T2 也不动当前转写', after.transcription.segment_id === 's1');
}

// ── 6. 活动 ────────────────────────────────────────────────────────────────

{
  const s = make();
  s.setActivity({ active: true, source: 'manual' });
  test('A1 手动链不假装做过声纹判断 ⇒ unknown',
    s.snapshot().activity.user_state === 'unknown' && s.snapshot().activity.source === 'manual');
  const t0 = s.snapshot().activity.started_at;
  clock += 1000;
  s.setActivity({ active: true, source: 'manual' });
  test('A2 持续说话不重置 started_at', s.snapshot().activity.started_at === t0);
  s.setActivity({ active: false });
  test('A3 停止后 source/started_at 归位',
    s.snapshot().activity.source === null && s.snapshot().activity.started_at === null);
  s.setActivity({ active: true, source: 'resident', userState: 'other' });
  test('A4 常驻链可以说「是别人」', s.snapshot().activity.user_state === 'other');
  s.setActivity({ active: true, source: 'resident', userState: 'nonsense' });
  test('A5 ⚠ 非法取值收敛成 unknown，⛔ 不透出去', s.snapshot().activity.user_state === 'unknown');
}

// ── 7. 功能可用性（⭐ 不许一锅端） ─────────────────────────────────────────

{
  const all = featureReadiness({
    chainAvailable: true, micAvailable: true, asrReady: true,
    residentEnabled: true, residentReady: true,
  });
  const s = make();
  const ok = s.snapshot({ features: all });
  test('F1 全好 ⇒ ready 且不 degraded', ok.service.ready === true && ok.service.degraded === false);

  const noProfile = featureReadiness({
    chainAvailable: true, micAvailable: true, asrReady: true,
    residentEnabled: true, residentReady: false, residentReason: 'no_voice_profile',
  });
  const v = s.snapshot({ features: noProfile });
  test('F2 ⭐ 常驻助手没登记声纹 ⇒ degraded，但 service 仍 ready（核心功能还能用）',
    v.service.ready === true && v.service.degraded === true);
  test('F3 原因是机器可读的 feature:reason',
    v.service.reason.includes('resident:no_voice_profile'), v.service.reason);

  const noAsr = featureReadiness({ chainAvailable: true, micAvailable: true, asrReady: false,
    asrReason: 'model_missing' });
  test('F4 识别不可用 ⇒ service 不 ready（那才是核心）',
    s.snapshot({ features: noAsr }).service.ready === false);

  const noMic = featureReadiness({ chainAvailable: true, micAvailable: false, asrReady: true });
  test('F5 麦克风不可用 ⇒ 手动输入不 ready 且说得出原因',
    noMic.manual.ready === false && noMic.manual.reason === 'microphone_unavailable');
  test('F6 关掉的功能 reason 是 disabled，⛔ 不是「坏了」',
    featureReadiness({ residentEnabled: false }).resident.reason === 'disabled');
}

// ── 8. 接线与契约 ──────────────────────────────────────────────────────────

{
  const codeOf = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const main = codeOf('service/main.mjs');
  const pkg = codeOf('package.mjs');

  /**
   * ⭐ 名字必须与状态流信封**区分开**：`termux-os.speech-state.v1` 已经被
   * `state-hub.mjs` 用于 `{domains, version, boot_id}` 那层包装。
   * 同名不同构会让按 schema 判断结构的下游拿到另一样东西。
   */
  test('W1 schema 名固定，且不与状态流信封同名',
    SCHEMA === 'termux-os.speech-product-state.v1'
      && fs.readFileSync(path.join(root, 'service/state-hub.mjs'), 'utf8')
        .includes("STATE_SCHEMA = 'termux-os.speech-state.v1'"));
  test('W2 ⭐ 转写事实由 onResult 喂给唯一权威', /publicState\.noteTranscript\(segment/.test(main));
  test('W3 活动由判定方上报，⛔ 不是页面猜的',
    /const syncPublicActivity = /.test(main) && /publicState\.setActivity/.test(main));
  test('W4 ⚠ 回到待机会清 transcription 而**不清** latest',
    /publicState\.idle\(\)/.test(main) && !/publicState\.latest\s*=/.test(main));
  test('W5 有正式端点 /public', /route === '\/public'/.test(main) && /proxy\('GET', '\/public'\)/.test(pkg));
  test('W6 ⭐ 以 capability 暴露（下游不写死 package id）',
    /id: 'speech\.state'/.test(pkg) && /action: 'speech\.state\.read'/.test(pkg));
  test('W7 /live 里也有产品域（页面读同一份）', /public: \(\) => publicSnapshot\(\)/.test(main));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'termux-os.package.json'), 'utf8'));
  test('W8 版本 0.22.5', manifest.version === '0.22.5');
  test('W9 manifest 里声明了 speech.state',
    manifest.capabilities.provides.some((c) => c.id === 'speech.state'));

  const doc = fs.readFileSync(path.join(root, 'docs/PUBLIC_STATE.md'), 'utf8');
  test('D1 契约文档存在且锁定 schema', doc.includes('termux-os.speech-state.v1'));
  test('D2 文档版本与 manifest 一致', doc.includes(`Version: **${manifest.version}**`));
  /**
   * ⚠ 判据是「文档说明了这件事」，⛔ 不是「文档用了我想的那个词」。
   * 第一版要求 `latest` 与「仍然保留」出现在同一行，而文档写的是
   * 「`latest` 不会因为回到待机而清空」——同一个意思，更好的说法。
   */
  test('D3 ⭐ 文档写明 latest 回到待机后不清空',
    doc.split('\n').some((line) => line.includes('latest')
      && line.includes('回到待机') && line.includes('清空')));
  test('D4 文档给出下游消费示例', doc.includes('IME') && doc.includes('ime.preview'));
}


// ── 9. UI 信息架构（DOM/route 级，⛔ 不是「看起来对」） ────────────────────

{
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const pages = [...html.matchAll(/data-page="([a-z-]+)"/g)].map((m) => m[1]);

  /** 三个产品 tab 是唯一公开信息架构；Speaker Lab 不从产品导航进入。 */
  test('U1 ⭐ 主导航正好三个：Overview / Settings / My Voice',
    JSON.stringify(pages) === JSON.stringify(['overview', 'settings', 'voice']),
    pages.join(','));
  test('U2 PAGES 与导航一致（少一个 ⇒ 那个标签点了没反应）',
    /PAGES = Object\.freeze\(\['overview', 'settings', 'voice'\]\)/.test(app));
  test('U3 ⛔ 模型不再是一级导航，但入口还在（收进设置）',
    !pages.includes('models') && html.includes('id="card-models-wrap"'));
  test('U4 ⭐ 常驻助手有正式开关，且连的是正式配置端点',
    html.includes('id="res-enabled"') && app.includes("'/speaker-activity/config'"));
  test('U5 ⭐ 手动语音输入只有一个正式按钮',
    (html.match(/id="man-toggle"/g) ?? []).length === 1 && html.includes('手动转录'));
  test('U6 声纹登记有正式入口', html.includes('id="res-enroll"') && html.includes('登记我的声音'));
  test('U7 旧 speech/diagnostics 页面与 iframe 入口全部消失',
    !html.includes('id="page-speech"') && !html.includes('id="page-diagnostics"')
      && !html.includes('data-page="speech"') && !html.includes('data-page="diagnostics"')
      && !html.includes('<iframe') && !html.includes('speaker.html'));
  test('U8 ⛔ 产品页不出现声学阈值 / 拼音 / 声纹分数字样', (() => {
    /**
     * ⚠ 先去掉 HTML 注释再扫：这条禁令的注释里必然写着被禁的那些词
     * （「⛔ 这里不出现 HTML/QNN/声纹分数」），不去注释就会把**警告本身**判成违规，
     * 而最省事的「修法」是删掉那句警告。同一个坑本轮之前踩过一次。
     */
    const seg = html.slice(html.indexOf('id="page-overview"'), html.indexOf('id="page-settings"'))
      .replace(/<!--[\s\S]*?-->/g, '');
    return !/[Pp]inyin|拼音|score_threshold|声纹分数|HTP|QNN/.test(seg);
  })());
  test('U9 ⭐ 产品渲染只订 `public` 一个域',
    /\['product', \['public'\]/.test(app));
  test('U10 ⚠ 人话映射在前端做（公共状态里没有中文）',
    app.includes('USER_STATE_TEXT') && app.includes('检测到你的声音')
      && !fs.readFileSync(path.join(root, 'service/public-state.mjs'), 'utf8').includes('检测到'));
}


// ── 10. 下游夹具：只用正式契约 ─────────────────────────────────────────────

{
  const fx = fs.readFileSync(path.join(root, 'scripts/consumer-fixture.mjs'), 'utf8');
  const body = fx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  /**
   * ⭐ 判据是「它**调了**哪些路径」，⛔ 不是「它的文本里出现过哪些词」——
   * 夹具自己那条禁令的正则里就写着 rms/campplus，按词扫会把**禁令本身**判成违规。
   * （本轮第三次踩同一个形状：先看行为，再看文字。）
   */
  const called = [...body.matchAll(/call\(baseUrl, token, ([^,)]+)/g)].map((m) => m[1].trim());
  test('C1 ⭐ 夹具只调 capability 接口，⛔ 不碰任何内部 API',
    called.length > 0 && called.every((expr) => /^['`]\/api\/capabilities/.test(expr)),
    called.join(' | '));
  test('C2 ⛔ 夹具不写死 speech 的 package id', !body.includes('termux-speech'));
  test('C3 只靠 capability 发现', body.includes("'speech.state'") && body.includes('/api/capabilities'));
  test('C4 ⚠ 语音服务没装时干净降级', /degraded: true/.test(body));
  test('C5 五件事都验到了', ['服务能不能用', '有没有人在说话', '是不是本人',
    '现在识别到什么', '最后一次识别到什么'].every((x) => fx.includes(x)));
}


// ── 11. change_seq 必须真的表示「变了」 ────────────────────────────────────

{
  const s = make();
  s.setActivity({ active: false });
  const base = s.snapshot().change_seq;
  for (let i = 0; i < 50; i += 1) s.setActivity({ active: false });
  test('Q1 ⭐ 重复报告同一个活动状态不涨 change_seq（真机上它每秒涨十几）',
    s.snapshot().change_seq === base, `${base} → ${s.snapshot().change_seq}`);
  s.setActivity({ active: true, source: 'manual' });
  test('Q2 真的变了才涨', s.snapshot().change_seq === base + 1);
  for (let i = 0; i < 20; i += 1) s.setActivity({ active: true, source: 'manual' });
  test('Q3 持续说话期间也不空涨', s.snapshot().change_seq === base + 1);
  s.setActivity({ active: true, source: 'manual', userState: 'user' });
  test('Q4 ⚠ 但 user_state 变了要涨（那是下游关心的事实）',
    s.snapshot().change_seq === base + 2);
}


// ── 12. 待机不是故障 ───────────────────────────────────────────────────────

{
  /**
   * ⭐ 真机抓到的一条：链停着（正常待机）时，页面显示「语音服务不可用」。
   * 「手动语音输入可用」问的是**能不能用**，⛔ 不是「此刻正在用」。
   */
  const idleButFine = featureReadiness({
    chainAvailable: true, micAvailable: true, asrReady: true,
    residentEnabled: false,
  });
  const s = make();
  test('I1 ⭐ 链停着但一切正常 ⇒ service.ready=true（待机不是故障）',
    s.snapshot({ features: idleButFine }).service.ready === true);
  test('I2 只有常驻助手关着 ⇒ degraded 但仍 ready',
    s.snapshot({ features: idleButFine }).service.degraded === true);

  const appGone = featureReadiness({ chainAvailable: true, micAvailable: false, asrReady: true });
  test('I3 ⚠ App 真的够不到才算手动输入不可用',
    appGone.manual.ready === false && appGone.manual.reason === 'microphone_unavailable');

  const src = fs.readFileSync(path.join(root, 'service/main.mjs'), 'utf8');
  test('I4 ⛔ 可用性判据不再看「此刻有没有 PCM」',
    /micAvailable: sources\.mic !== null/.test(src)
      && !/micAvailable: gate\?\.snapshot\(\)/.test(src));
}

console.log(`\n${count - failures}/${count} public-state assertions passed`);
process.exit(failures ? 1 : 0);

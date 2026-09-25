/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: `web/` 的 Overview / History / Settings DOM 与接线（CP-SPEECH2-RECOVERY20B）
 * [OUTPUT]: 三个产品 tab、每个绑定/直写 id 真实存在、渲染失败可见、
 *           以及 WebView 不依赖宿主弹框的确认模态框结构回归
 * ⭐ 按新意图改写：旧 V1–V4（Speaker Lab）、U1–U8/U11–U15（四 tab、旧 renderer、asr_live、
 *   手动听写）钉的是随旧 speech 产品面退役的页面。结构判据（id 存在、模态框安全）不变。
 * [POS]: UI 产品收敛的结构钉；不以文案假绿，优先检查 DOM/调用关系。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const html = read('web/index.html');
const app = read('web/app.js');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const body = stripHtmlComments(html);
const appCode = stripJsComments(app);

let failed = 0;
const test = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

test('U1 主导航正好 Overview / History / Settings 三个 tab',
  JSON.stringify([...body.matchAll(/role="tab"[^>]*data-page="(\w+)"/g)].map((m) => m[1]))
    === '["overview","history","settings"]');
test('U2 页面容器与导航一一对应，旧 speech2 / voice / 诊断页消失',
  body.includes('id="page-overview"') && body.includes('id="page-history"') && body.includes('id="page-settings"')
  && !/id="page-(speech2|voice|diagnostics)"/.test(body));
test('U3 app PAGES 与 DOM 一致', appCode.includes("const PAGES = Object.freeze(['overview', 'history', 'settings']);"));

// ── 顶层绑定与直写 id ────────────────────────────────────────────────────
const bindings = [...appCode.matchAll(
  /^\$\('([\w-]+)'\)(\??)\.(addEventListener|onclick|oninput|onchange)/gm,
)].map(([, id, optional]) => ({ id, optional: optional === '?' }));
const devIds = new Set(['dev-policy-reload', 'dev-policy-apply', 'dev-policy-json', 'dev-policy-note']);
const allIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const missing = bindings.filter((b) => !allIds.has(b.id));
test(`U9 顶层绑定的每个 id 都存在（${bindings.length} 个）`,
  bindings.length > 0 && missing.length === 0, missing.map((x) => x.id).join(','));
const referenced = [...appCode.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
const dangling = [...new Set(referenced)].filter((id) => !allIds.has(id) && !devIds.has(id));
test('U10 代码引用的每个 id 都在页面里（?dev=1 的模板 id 也在 <template> 里）',
  dangling.length === 0 && [...devIds].every((id) => html.includes(`id="${id}"`)), dangling.join(','));
test('U12 请求失败显式可见（⛔ 不 .catch(() => null) 吞掉）',
  // 唯一允许的一处是解析响应体：解析失败随即被下一行的显式 `throw` 接住。
  (appCode.match(/\.catch\(\(\) => null\)/g) ?? []).length === 1
  && appCode.includes('const payload = await response.json().catch(() => null);')
  && appCode.includes("const error = new Error(payload?.error ?? `HTTP ${response.status}`);"));
test('U13 状态流成功也点亮 Live state，而不是永远 CONNECTING',
  /socket\.onmessage[\s\S]{0,900}liveDot\('ok'/.test(appCode));

// ── WebView-safe confirmation contract ────────────────────────────────────
test('U16 确认框由 Package DOM 自己绘制，⛔ 不依赖原生 WebView dialog',
  body.includes('id="tos-confirm"')
  && body.includes('id="tos-confirm-panel"')
  && body.includes('role="dialog"')
  && body.includes('aria-modal="true"')
  && body.includes('id="tos-confirm-cancel"')
  && body.includes('id="tos-confirm-accept"')
  && read('web/style.css').includes('position:fixed;')
  && read('web/style.css').includes('.tos-confirm[hidden]'));
test('U17 破坏性动作（删除 My Voice）走异步页面模态框，⛔ 代码不调用原生 confirm',
  (appCode.match(/await confirmInPage\(/g) ?? []).length >= 1
  && !/\b(?:window\.)?confirm\s*\(/.test(appCode));
test('U18 页面模态框有安全交互：焦点、Esc/Tab、Back history 与单飞请求',
  appCode.includes('document.addEventListener(\'keydown\', onKeyDown, true)')
  && appCode.includes("event.key === 'Escape'")
  && appCode.includes("event.key !== 'Tab'")
  && appCode.includes('history.pushState')
  && appCode.includes("window.addEventListener('popstate'")
  && appCode.includes('if (pending || historyCleanupPending) return Promise.resolve(false)')
  && appCode.includes('message.textContent = String(nextMessage)'));

console.log(failed === 0 ? '\nui-convergence: all green' : `\nui-convergence: ${failed} failed`);
process.exit(failed ? 1 : 0);

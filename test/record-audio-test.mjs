/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: package.mjs 的 Browser Session 路由表 + 一个模拟内部 service 的 WAV 上游
 * [OUTPUT]: `/records/audio` 代理契约：原样字节、Range 透传、状态码不被压平
 * [POS]: 唯一一条**功能性**（真起 HTTP、真收字节）的代理测试，其余测试只读源码文本
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
/**
 * ⭐ 这一条不写成源码文本断言。历史记录播不了的那次，源码里
 *   `<audio src>` 是对的、内部端点是对的、WAV 也是对的——**每一段单独看都成立**，
 *   坏的是它们之间那一跳。只有真的发一次请求、真的数一次字节才看得见。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../package.mjs';

let failures = 0; let count = 0;
const test = (n, c) => { count += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) failures += 1; };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgSource = fs.readFileSync(path.join(root, 'package.mjs'), 'utf8');

const SYSTEM_KEY = 'test-system-key-not-a-real-token';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60, 7)]); // 64 字节，前 44 当 header
const upstreamSeen = [];

/** 内部 service 的最小复刻：只保留 sendWavFile 的对外契约（200/206/404/416）。 */
const upstream = http.createServer((req, res) => {
  upstreamSeen.push({ url: req.url, auth: req.headers.authorization, range: req.headers.range ?? null });
  if (req.headers.authorization !== `Bearer ${SYSTEM_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }
  const url = new URL(req.url, 'http://internal');
  const known = url.pathname === '/records/audio'
    ? url.searchParams.get('segment_id') === 'seg-ok'
    : true;
  if (!known) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'audio file not found' }));
  }
  const range = req.headers.range;
  if (range) {
    const [rawStart, rawEnd] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(rawStart, 10) || 0;
    const end = rawEnd ? parseInt(rawEnd, 10) : WAV.length - 1;
    if (start >= WAV.length || end >= WAV.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${WAV.length}` });
      return res.end();
    }
    const chunk = WAV.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${WAV.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunk.length,
      'Content-Type': 'audio/wav',
    });
    return res.end(chunk);
  }
  res.writeHead(200, {
    'Content-Type': 'audio/wav', 'Content-Length': WAV.length, 'Accept-Ranges': 'bytes',
  });
  return res.end(WAV);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

// ── 用真实 register() 收集路由表；context 只是一副空壳，不启动任何东西 ──────────
const routes = new Map();
const stub = {
  packageId: 'github.termux-os.service.termux-speech',
  root, frameworkRoot: root, persistRoot: path.join(root, 'tmp-test-persist'),
  nodeExecutable: process.execPath,
  configFile: (name) => path.join(root, 'tmp-test-persist', name),
  services: { id: (id) => id, register: () => {} },
  ports: { get: () => ({ port: upstreamPort }) },
  auth: { systemKey: () => SYSTEM_KEY },
  routes: { register: (method, route, handler) => routes.set(`${method} ${route}`, handler) },
  websockets: { register: () => {} },
  capabilities: { provide: () => {} },
  actions: { register: () => {} },
};
await register(stub);

/** 最小 res 替身：只记录 writeHead/end 实际收到了什么。 */
const call = async (route, { range } = {}) => {
  const captured = { status: 0, headers: {}, chunks: [], body: Buffer.alloc(0), missing: false };
  const handler = routes.get(`GET ${route.split('?')[0]}`);
  // ⚠ 路由不存在时也要返回**完整形状**：否则「这条路由没注册」会以
  //   「测试自己崩了」的形式出现，而崩溃报的是断言那一行，不是缺失那一行。
  if (!handler) { captured.missing = true; return captured; }
  const res = {
    writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {}; return res; },
    end(body) { if (body) captured.chunks.push(Buffer.from(body)); },
  };
  await handler({ url: route, method: 'GET', headers: range ? { range } : {} }, res, {
    json: (r, status, payload) => { captured.status = status; captured.chunks.push(Buffer.from(JSON.stringify(payload))); },
  });
  captured.body = Buffer.concat(captured.chunks);
  return captured;
};
const header = (c, name) => c.headers[name] ?? c.headers[name.toLowerCase()];

// ── R1–R4：任务要求的四种结果 ──────────────────────────────────────────────
test('R0 /records/audio 已注册（少了它 Framework 回 unknown_package_route）',
  routes.has('GET /records/audio'));

const full = await call('/records/audio?segment_id=seg-ok');
test('R1 valid segment → 200 + audio/wav + 原样字节',
  full.status === 200 && header(full, 'Content-Type') === 'audio/wav'
  && full.body.length === WAV.length && full.body.equals(WAV));

const partial = await call('/records/audio?segment_id=seg-ok', { range: 'bytes=0-43' });
test('R2 Range: bytes=0-43 → 206 + Content-Range + 44 字节',
  partial.status === 206 && header(partial, 'Content-Range') === `bytes 0-43/${WAV.length}`
  && partial.body.length === 44 && partial.body.equals(WAV.subarray(0, 44)));
// ⚠ 不能写成 `partial.status !== 200`：路由整个不存在时 status 是 0，那条断言会**变绿**。
//   一个在「什么都没发生」时也通过的测试，测的是它自己。
test('R2b 整段与分段是两个不同的状态码，没有被压平',
  full.status === 200 && partial.status === 206);
test('R2c Range 真的转发给了内部端点，不是代理自己截的',
  upstreamSeen.at(-1)?.range === 'bytes=0-43');

const missing = await call('/records/audio?segment_id=seg-nope');
test('R3 不存在的 segment → 404（状态原样，不变成 200 或 503）', missing.status === 404);

const unsat = await call('/records/audio?segment_id=seg-ok', { range: 'bytes=999999-' });
test('R4 越界 Range → 416 + Content-Range', unsat.status === 416
  && header(unsat, 'Content-Range') === `bytes */${WAV.length}`);

// ── A1–A3：认证边界 ────────────────────────────────────────────────────────
test('A1 代理向内部端点出示 System Key',
  upstreamSeen.every((s) => s.auth === `Bearer ${SYSTEM_KEY}`));
test('A2 System Key 不出现在任何回给浏览器的头或体里',
  ![full, partial, missing, unsat].some((c) =>
    JSON.stringify(c.headers).includes(SYSTEM_KEY) || c.body.includes(SYSTEM_KEY)));
test('A3 代理不接受来自浏览器的 token/路径参数（只认 segment_id）',
  !/records\/audio[\s\S]{0,400}(searchParams\.get\('(token|path|file)'\))/.test(pkgSource));

// ── G1–G3：一次由「读得出值但答错问题」造成的事故，钉在这里 ─────────────────
test('G1 segment_id 经 encodeURIComponent 后才拼进上游 URL',
  /encodeURIComponent\(segmentId\)/.test(pkgSource));
test('G2 WAV 这条路上没有 response.json()',
  /const pipeWav = async \(req, res, url, label\) => \{[\s\S]*?\n  \};/.exec(pkgSource)?.[0]
    ?.includes('.json()') === false);
test('G3 上游状态码原样使用，不是写死的 200',
  /res\.writeHead\(upstream\.status, out\)/.test(pkgSource));

// ── E1–E3：既有三条 WAV 代理的回归（共用同一个 helper） ─────────────────────
for (const [name, route] of [['acoustic-lab', '/acoustic-lab/audio?epoch=1&which=full'],
                             ['activity-test', '/activity-test/audio?wav=a.wav'],
                             ['speaker', '/speaker/audio?clip=b.wav']]) {
  const r = await call(route);
  const ranged = await call(route, { range: 'bytes=0-9' });
  test(`E:${name} 仍然 200 + 原样字节，且现在也支持 Range`,
    r.status === 200 && r.body.equals(WAV) && ranged.status === 206 && ranged.body.length === 10);
}

// ── P1：`/records` 本身没有被动到 ─────────────────────────────────────────
test('P1 /records 仍然是 JSON proxy，没被这次改动带走',
  pkgSource.includes("proxy('GET', '/records');") && routes.has('GET /records'));

upstream.close();
console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);

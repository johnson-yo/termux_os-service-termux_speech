/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package context, Termux Speech loopback service, Browser Session, and private data roots.
 * [OUTPUT]: Audio/ASR routes, transcript WebSocket, speech.input/activity/transcript/idle Capabilities,
 *           and the Android Assistant primary-action proxy.
 * [POS]: Thin registration; PCM/tensors stay App↔Service while Framework carries control/text metadata.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { serveWebSocketFeed } from './service/transcript-ws.mjs';

export async function register(context) {
  const SERVICE_ID = context.services.id('termux-speech');
  const port = context.ports.get('http')?.port;
  const serviceBase = `http://127.0.0.1:${port}`;
  const instanceDigest = crypto
    .createHash('sha256')
    .update(String(context.packageId))
    .digest('hex')
    .slice(0, 8);

  context.services.register({
    id: 'termux-speech',
    name: 'Termux Speech',
    command: context.nodeExecutable,
    args: ['service/main.mjs'],
    cwd: context.root,
    env: {
      STATUS_FILE: `${context.frameworkRoot}/.runtime/services/${SERVICE_ID}/status.json`,
      CONFIG_FILE: context.configFile('termux-speech.v4.json'),
      // 改名前的真实配置文件（docs/054 §3.3）。v3 → v4 的迁移早已在设备上完成，
      // 现在唯一还需要跨过的边界是「旧包名的 v4」→「新包名的 v4」。
      LEGACY_CONFIG_FILE: context.configFile('termux-audio.v4.json'),
      VAD_DATA_ROOT: path.join(context.persistRoot, 'data', 'termux-speech', 'vad'),
      ASR_DATA_ROOT: path.join(context.persistRoot, 'data', 'termux-speech', 'asr'),
      // ⚠ 必须显式注入到 persistRoot。⭐ 少这一行的后果在真机上出现过：
      // 服务回落到相对默认路径，而那条相对路径落在 dev runtime **每次 reload 都会重建的
      // gen/<timestamp>/** 目录里——于是记录组每次重载都从零开始，SQLite 也跟着没了。
      // 「它一直是空的」看起来和「还没人说过话」一模一样。
      RECORD_DATA_ROOT: path.join(context.persistRoot, 'data', 'termux-speech', 'records'),
      // 常驻 id 即 App worker 侧的 session 名：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，
      // 且不得撞 App 自己的保留名。实例键拼进去会超 64 字符，故取摘要——
      // 同一实例恒定，Dev 与 Installed 互不相撞（docs/054 §4.2）。
      // Manifest 是「本包需要哪些模型」的唯一来源，模型架从这里读它。
      // ⚠ 显式注入：dev runtime 每次 reload 换一个 gen/<timestamp>/ 目录，
      // 从 import.meta.url 推出来的相对根会跟着漂。
      TERMUX_OS_PACKAGE_ROOT: context.root,
      VAD_RESIDENT_ID: `tsp-vad-${instanceDigest}`,
      ASR_RESIDENT_ID: `tsp-asr-${instanceDigest}`,
    },
    health: { type: 'http', url: `${serviceBase}/health`, timeout_ms: 1500 },
    stop_timeout_ms: 5000,
  });

  /**
   * ⚠ `timeoutMs` 必须能被调大：取一个模型是几百 MB，8 秒会把一条**正在成功**的
   * 下载掐成一次失败，而盘上留下的是半个 `.part`——看起来像网络坏了，其实是我们
   * 自己等不及。请求发起方最清楚这一次该等多久。
   */
  const serviceRequest = async (path, { method = 'GET', body, timeoutMs = 8000 } = {}) => {
    const response = await fetch(serviceBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${context.auth.systemKey()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(payload?.error ?? `termux-speech service HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  /**
   * 长挂请求专用。
   * ⚠ `serviceRequest` 的 8 秒超时对「等到有变化再回答」是**错的**：状态安静 25 秒
   * 完全正常，用 8 秒去截它会把一条本该零流量的链路变成 7.5 秒一次的轮询。
   * ⚠ 返回**原文**：状态帧在服务端已经用缓存的每域 JSON 拼好，这里不该再 parse 一遍。
   */
  const serviceText = async (path) => {
    const response = await fetch(serviceBase + path, {
      headers: { Authorization: `Bearer ${context.auth.systemKey()}` },
      signal: AbortSignal.timeout(40_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`termux-speech service HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return text;
  };

  /**
   * State watch is already serialized by the service. Keep its body raw and
   * carry the cursor in response headers so the Framework bridge does not
   * parse and reconstruct every delta just to continue the long poll.
   */
  const serviceStateWatch = async (path) => {
    const response = await fetch(serviceBase + path, {
      headers: { Authorization: `Bearer ${context.auth.systemKey()}` },
      signal: AbortSignal.timeout(40_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`termux-speech service HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      text,
      version: Number(response.headers.get('x-termux-state-version')),
      boot_id: response.headers.get('x-termux-state-boot-id'),
    };
  };

  /** 长挂的 JSON 版本，供转写 WS 使用。 */
  const serviceWatch = async (path) => {
    const payload = JSON.parse(await serviceText(path));
    if (payload?.ok !== true) throw new Error(payload?.error ?? 'termux-speech watch failed');
    return payload;
  };

  context.actions.register({
    id: 'speech.input.read',
    name: 'Read Speech Input',
    adapter: 'termux-speech',
    available: async () => {
      try { await serviceRequest('/health'); return true; } catch { return false; }
    },
    run: async () => (await serviceRequest('/speech-input')).value,
  });

  /**
   * ⭐ **正式产品状态**（0.21.3）。下游 package 只订阅这一个就够了：
   *   服务能不能用、有没有人在说话、是不是本人、现在识别到什么、最后一次识别到什么。
   * ⛔ 它刻意**不**暴露 RMS / CAM++ 分数 / FireRedVAD / QNN / HTP / segment spool——
   *   那些是实现，实现会换而产品语义不该跟着换。契约见 docs/PUBLIC_STATE.md。
   */
  context.actions.register({
    id: 'speech.state.read',
    name: 'Read Speech Product State',
    adapter: 'termux-speech',
    available: async () => {
      try { await serviceRequest('/health'); return true; } catch { return false; }
    },
    run: async () => (await serviceRequest('/public')).value,
  });
  context.capabilities.provide({
    id: 'speech.state',
    provider: 'termux-speech',
    kind: 'action',
    action: 'speech.state.read',
    service: SERVICE_ID,
  });

  context.capabilities.provide({
    id: 'speech.input',
    provider: 'termux-speech',
    kind: 'action',
    action: 'speech.input.read',
    service: SERVICE_ID,
  });
  context.actions.register({
    id: 'speech.idle.request',
    name: 'Return Speech Pipeline to RMS Standby',
    adapter: 'termux-speech',
    available: async () => {
      try { await serviceRequest('/health'); return true; } catch { return false; }
    },
    run: async (input = {}) => (await serviceRequest('/idle', {
      method: 'POST',
      body: {
        reason: input.reason ?? 'capability_speech_idle',
        requested_by: input.requested_by ?? 'capability',
      },
    })).value,
  });
  context.actions.register({
    id: 'speech.listen.set',
    name: 'Enter or Leave Dictation Listen Mode',
    adapter: 'termux-speech',
    available: async () => {
      try { await serviceRequest('/health'); return true; } catch { return false; }
    },
    // 模式而非触发：engaged 期间四条 idle 自动关门全部让位，退出只由调用方负责（docs/058）。
    run: async (input = {}) => (await serviceRequest('/listen', {
      method: 'POST',
      body: {
        enabled: input.enabled === true,
        reason: input.reason ?? 'capability_speech_listen',
        requester: input.requester ?? 'capability',
      },
    })).value,
  });
  context.capabilities.provide({
    id: 'speech.listen',
    provider: 'termux-speech',
    kind: 'action',
    action: 'speech.listen.set',
    service: SERVICE_ID,
  });
  context.capabilities.provide({
    id: 'speech.idle',
    provider: 'termux-speech',
    kind: 'action',
    action: 'speech.idle.request',
    service: SERVICE_ID,
  });
  context.capabilities.provide({
    id: 'speech.activity',
    provider: 'termux-speech',
    kind: 'feed',
    service: SERVICE_ID,
    endpoint: `/api/packages/${context.packageId}/vad/activity`,
  });
  context.capabilities.provide({
    id: 'speech.transcript',
    provider: 'termux-speech',
    kind: 'feed',
    service: SERVICE_ID,
    endpoint: `/api/packages/${context.packageId}/asr/transcripts`,
  });

  /**
   * 转写推送。⛔ 不再每 200ms 问一次上游：`/asr/transcripts/watch` 会挂到真的有新句子。
   */
  context.websockets.register('/asr/transcripts/ws', (req, socket, head, { query }) => {
    serveWebSocketFeed(req, socket, head, {
      after: Number(query.get('after')) || 0,
      ready: { type: 'ready', schema: 'termux-os.speech-transcript-ws.v1' },
      pump: async (cursor) => {
        const feed = await serviceWatch(
          `/asr/transcripts/watch?after=${encodeURIComponent(cursor)}&limit=100`,
        );
        return {
          frames: (feed?.observations ?? []).map((value) => ({ type: 'transcript', value })),
          next: Number(feed?.next) || cursor,
        };
      },
    });
  });

  /**
   * ⭐ 状态推送（docs/061 §五/§六）。页面的 250ms 全量轮询由它取代。
   *
   * 第一帧是**完整 snapshot**，之后只有变化的域。服务端那条 `/state/watch` 会挂到
   * 真的有变化为止，所以状态不动的时候这条链路一个字节都不走。
   */
  context.websockets.register('/state/ws', (req, socket, head, { query }) => {
    /**
     * ⭐ **节奏由「页面正在看什么」决定**（docs/061 §五：高频值与低频值分开）。
     *
     * 真机实测：页面开着但零推送时 Chrome 就要 4.24% 的一个核——那是「浏览器开着一个
     * 页面」的地板，代码动不了。而每秒 5 次推送再叠 5.54%，其中主要不是解析或重绘，
     * 是**把渲染进程从空闲里叫醒**这件事本身有固定代价。
     * 所以诊断页（有真的音量表）要 200ms，概览页那行文字 1 秒一次足够，
     * 且切页时重连一次——重连会拿到完整 snapshot，不会漏状态。
     */
    const intervalMs = Math.max(100, Math.min(5000, Number(query.get('interval_ms')) || 1000));
    let lastAtMs = 0;
    serveWebSocketFeed(req, socket, head, {
      after: null,
      pump: async (cursor) => {
        const waited = Date.now() - lastAtMs;
        if (waited < intervalMs) {
          await new Promise((resolve) => { setTimeout(resolve, intervalMs - waited); });
        }
        lastAtMs = Date.now();
        const search = cursor && cursor.version !== undefined
          ? `?after=${encodeURIComponent(cursor.version)}&boot_id=${encodeURIComponent(cursor.boot_id)}`
          : '';
        // ⚠ 这里刻意拿**原文**转发：服务端已经用缓存的每域 JSON 拼好了，
        // 再 parse 一次又 stringify 一次是纯粹的重复劳动。
        const watched = await serviceStateWatch(
          `/state/watch${search}${search ? '&' : '?'}interval_ms=${intervalMs}`,
        );
        let { version, boot_id: bootId } = watched;
        // Keep a bounded compatibility fallback for a mixed-version dev
        // reload. Normal operation uses headers and never parses this body in
        // the Framework bridge.
        if (!Number.isFinite(version) || !bootId) {
          try {
            const parsed = JSON.parse(watched.text);
            version = Number(parsed?.version);
            bootId = parsed?.boot_id;
          } catch { /* 交给下面按 null 处理。 */ }
        }
        if (!Number.isFinite(version) || !bootId) return { frames: [], next: cursor };
        return {
          frames: [watched.text],
          next: { version, boot_id: bootId },
        };
      },
    });
  });

  const proxy = (method, route, servicePath = route, { timeoutMs } = {}) => {
    context.routes.register(method, route, async (req, res, { json, readBody }) => {
      try {
        const body = method === 'POST' ? await readBody() : undefined;
        const query = method === 'GET'
          ? new URL(req.url, 'http://framework.local').search
          : '';
        const payload = await serviceRequest(servicePath + query, { method, body, timeoutMs });
        json(res, 200, payload);
      } catch (error) {
        json(res, Number(error?.status) || 503, {
          ok: false,
          error: String(error?.message ?? error),
        });
      }
    });
  };

  // 模型需求卡。⭐ 这里只转发 logical model 状态与作业，不暴露资产清单，也不提供删除。
  proxy('GET', '/models');
  /**
   * ⚠ 下载/安装现在由 Manager 作为**作业**执行，本包立刻拿到 operation_id，
   *   所以这两条不再需要 40 分钟超时；页面按阶段轮询这一条。
   */
  proxy('GET', '/models/operation');
  proxy('POST', '/models/download', '/models/download', { timeoutMs: 120_000 });
  proxy('POST', '/models/use', '/models/use', { timeoutMs: 120_000 });
  proxy('GET', '/status');
  proxy('GET', '/live');
  proxy('GET', '/state');
  proxy('GET', '/state/stats');
  proxy('GET', '/pipeline/transitions');
  proxy('GET', '/lifecycle');
  proxy('GET', '/records');
  proxy('GET', '/records/archive');
  proxy('GET', '/pipeline');
  proxy('GET', '/listen');
  proxy('GET', '/states');
  proxy('GET', '/rms');
  proxy('GET', '/rms/config');
  // ⭐ 正式产品状态（下游唯一需要的那一个）。
  proxy('GET', '/public');
  proxy('GET', '/vad');
  proxy('GET', '/vad/config');
  proxy('GET', '/vad/activity');
  proxy('GET', '/asr');
  proxy('GET', '/asr/config');
  proxy('GET', '/asr/transcripts');
  // 听写链（docs/065）：状态只读 + 两个 App 闸门参数的读写代理。
  proxy('GET', '/asr/backend');
  proxy('GET', '/asr/foreground');
  proxy('GET', '/pcm/consumers');
  // 声学校准 / Endpoint Lab（docs/078）。⛔ 这一组没有一条会走到 ASR。
  proxy('GET', '/speaker/state');
  proxy('GET', '/speaker/timeline');
  // 正式声纹门（docs/081）。⛔ 与上面那两条不是一组：Lab 是校准台，这是生产线。
  proxy('GET', '/activity-shadow/state');
  proxy('GET', '/activity-shadow/history');
  // docs/084 CAM++ HTP 验收模式（默认 OFF）
  proxy('GET', '/activity-test/state');
  proxy('GET', '/activity-test/history');
  proxy('GET', '/activity-test/segments');
  proxy('GET', '/speaker-activity/state');
  proxy('POST', '/speaker-activity/replay');
  proxy('POST', '/speaker-activity/probe');
  proxy('GET', '/speaker/enroll/orphans');
  proxy('POST', '/speaker/enroll/orphans/purge');
  proxy('GET', '/speaker-gate/state');
  proxy('GET', '/speaker-gate/telemetry');
  for (const r of ['/acoustic-lab/state', '/acoustic-lab/timeline', '/acoustic-lab/epochs']) {
    proxy('GET', r);
  }
  /**
   * ⭐ WAV 试听要**原样透传字节**，不能走 `proxy`（它 `response.json()`）。
   * 一个把 WAV 当 JSON 解析的路由，会以「解析失败」的形式失败——而真正的原因是
   * 我们把二进制塞进了一条只会读 JSON 的管子。
   */
  proxy('GET', '/devices');
  /**
   * 拍手手势（App Feature Gate）的**低频**控制面。
   * ⚠ 新增一条必须**同时**加在这里，漏了 Framework 直接回 `unknown_package_route`
   *   而页面上只表现为按钮没反应（docs/079 §8 已经付过这个代价）。
   */
  // P1 policy（低频）。⚠ 新增一条必须**同时**加在这里，漏了 Framework 直接回
  //   unknown_package_route，而页面上只表现为按钮没反应。
  proxy('GET', '/policy');
  proxy('GET', '/policy/status');
  proxy('POST', '/policy/put');
  proxy('GET', '/clap/state');
  proxy('GET', '/clap/events');
  proxy('POST', '/clap/config');
  proxy('POST', '/clap/enroll/start');
  proxy('POST', '/clap/enroll/finish');
  proxy('POST', '/clap/enroll/cancel');
  proxy('POST', '/clap/enroll/drop');
  proxy('POST', '/clap/test');
  proxy('POST', '/clap/reset');
  proxy('GET', '/speech-input');
  proxy('POST', '/rms/config');
  proxy('POST', '/vad/config');
  proxy('POST', '/asr/config');

  /**
   * WAV 原样透传：**状态码、Range、字节都不加工**。上游那一侧（`sendWavFile`）已经
   * 完整实现了 200/206/404/416，这里唯一的职责是把它原封不动地端出去。
   * ⚠ 不要在这里 `response.json()`——把二进制塞进一条只会读 JSON 的管子，失败会以
   *   「解析错误」的形式出现，而真正的原因在别处。
   * ⚠ 不要把 206 压成 200：浏览器 seek 靠的就是它，压掉之后 audio control 看着能播，
   *   一拖动就回到开头。
   * ⚠ 两层路由的形状**故意不同**（代理层 query，service 层路径段）：Framework 的
   *   `dispatchPackageRoute` 是精确匹配，`/records/audio/<id>` 这种路径段形式在代理层
   *   根本注册不出来。
   */
  const pipeWav = async (req, res, url, label) => {
    const headers = { Authorization: `Bearer ${context.auth.systemKey()}` };
    if (req?.headers?.range) headers.Range = req.headers.range;
    let upstream;
    try {
      upstream = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `${label}: ${String(error?.message ?? error)}` }));
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    const out = { 'Cache-Control': 'no-store', 'Content-Length': body.length };
    for (const [from, to] of [['content-type', 'Content-Type'],
                              ['content-range', 'Content-Range'],
                              ['accept-ranges', 'Accept-Ranges']]) {
      const value = upstream.headers.get(from);
      if (value) out[to] = value;
    }
    res.writeHead(upstream.status, out);
    res.end(body);
  };
  /**
   * ⭐ 历史记录试听。`/records` 只给得到 `segment_id`，WAV 本体要走这一条。
   * 少了它 Framework 直接 `unknown_package_route`，而页面上只看得到一个
   * 播不动的 audio control（media error 4），完全指不到这里。
   */
  context.routes.register('GET', '/records/audio', async (req, res) => {
    const q = new URL(req.url, 'http://framework.local').searchParams;
    const segmentId = String(q.get('segment_id') ?? q.get('id') ?? '');
    await pipeWav(req, res,
      `${serviceBase}/records/audio?segment_id=${encodeURIComponent(segmentId)}`,
      'record wav');
  });
  context.routes.register('GET', '/acoustic-lab/audio', async (req, res) => {
    const q = new URL(req.url, 'http://framework.local').searchParams;
    await pipeWav(req, res, `${serviceBase}/acoustic-lab/audio/${Number(q.get('epoch'))}/`
      + `${String(q.get('which') ?? '')}`, 'lab audio');
  });
  context.routes.register('GET', '/activity-test/audio', async (req, res) => {
    const q = new URL(req.url, 'http://framework.local').searchParams;
    await pipeWav(req, res, `${serviceBase}/activity-test/audio/${String(q.get('wav') ?? '')}`,
      'activity-test segment');
  });
  context.routes.register('GET', '/speaker/audio', async (req, res) => {
    const q = new URL(req.url, 'http://framework.local').searchParams;
    await pipeWav(req, res, `${serviceBase}/speaker/audio/${String(q.get('clip') ?? '')}`,
      'speaker clip');
  });

  /**
   * ⚠ 新增一条 `/speaker` 端点必须**同时**加在这里。漏了的话 Framework 直接回
   * `unknown_package_route`，而页面若把写操作的响应丢掉就完全看不出来
   * （docs/079 §8 已经用一整轮 72 个 epoch 的错标签付过这个代价）。
   * ⚠ 改完 `package.mjs` 要 `framework.sh restart`——installed 包的 import 没有 cache-buster。
   */
  for (const r of ['/speaker/enroll/start', '/speaker/enroll/stop',
    '/speaker/test/start', '/speaker/test/stop', '/speaker/profile/build',
    '/speaker/profile/clear', '/speaker/profile/remove', '/speaker/config', '/speaker/purge',
    '/speaker/label', '/speaker/labels/clear', '/speaker/threshold/ack',
    '/speaker-activity/config',
    // docs/087 P3：执行器开关与手动声纹同步（⛔ 两条都不进普通用户设置面）。
    '/speaker-activity/executor', '/speaker-activity/profile/sync',
    '/speaker-gate/config', '/speaker-gate/telemetry/reset',
    '/activity-shadow/config', '/activity-shadow/stats/reset',
    '/activity-test/start', '/activity-test/stop', '/activity-test/segments/remove',
    '/activity-test/config',
    // ⚠ 只注册了 GET /pcm/consumers 而漏了 POST：Framework 直接回
    //   `unknown_package_route`，本轮做 A/B 时才发现（service 侧一直是有的）。
    '/pcm/consumers']) {
    proxy('POST', r, r, { timeoutMs: 120_000 });
  }
  for (const r of ['/acoustic-lab/config', '/acoustic-lab/calibration/start',
    '/acoustic-lab/calibration/stop', '/acoustic-lab/test/start', '/acoustic-lab/test/stop',
    '/acoustic-lab/reference/apply', '/acoustic-lab/reference/clear', '/acoustic-lab/purge',
    '/acoustic-lab/phase']) {
    proxy('POST', r, r, { timeoutMs: 60_000 });
  }
  proxy('POST', '/asr/dictation');
  /**
   * ⚠ GET 与 POST 都要注册：service 两个都实现了，而这里只注册了 POST——
   * 于是页面每次加载都对 GET 拿到一个 404（`unknown_package_route`）。
   * 它被 `.catch()` 吞掉所以功能没坏，但控制台每次都留一条红色噪音，
   * 而那正是使用者验收时第一眼会看到的东西。
   */
  proxy('GET', '/asr/dictation/gate');
  proxy('POST', '/asr/dictation/gate');
  proxy('POST', '/asr/transcribe');
  proxy('POST', '/chain/start');
  proxy('POST', '/chain/stop');
  proxy('POST', '/lifecycle/config');
  proxy('POST', '/idle');
  proxy('POST', '/listen');
  // Android App 的 primary action 由 loopback service 统一收口到自动 CAM++ 模式。
  proxy('POST', '/assistant/call', '/assistant/call', { timeoutMs: 15_000 });
  proxy('POST', '/input-device');
  proxy('POST', '/mic/enable');
  proxy('POST', '/mic/disable');
}

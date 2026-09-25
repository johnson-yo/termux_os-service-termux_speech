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
      error.details = Array.isArray(payload?.details) ? payload.details : null;
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
        // ⚠ 只判 POST 会让 PUT 的 body **静默变成 undefined**：路由注册了、返回 200、
        //   而下游收到一个空 patch ⇒ 「什么都没改」和「改了没生效」长得一模一样。
        const body = (['POST', 'PUT', 'PATCH'].includes(method)
          || (method === 'DELETE' && route === '/speech2/voices/item')) ? await readBody() : undefined;
        const query = method === 'GET'
          ? new URL(req.url, 'http://framework.local').search
          : '';
        const payload = await serviceRequest(servicePath + query, { method, body, timeoutMs });
        json(res, 200, payload);
    } catch (error) {
      json(res, Number(error?.status) || 503, {
        ok: false,
        error: String(error?.message ?? error),
        ...(Array.isArray(error?.details) ? { details: error.details } : {}),
      });
    }
    });
  };

  // 模型四层状态。raw package facts 与 App runtime facts 分层转发，不暴露 Manager 内部状态机。
  proxy('GET', '/models');
  /**
   * ⚠ 下载/安装现在由 Manager 作为**作业**执行，本包立刻拿到 operation_id，
   *   所以这两条不再需要 40 分钟超时；页面按阶段轮询这一条。
   */
  proxy('GET', '/models/operation');
  proxy('POST', '/models/download', '/models/download', { timeoutMs: 120_000 });
  proxy('POST', '/models/prepare', '/models/prepare', { timeoutMs: 30 * 60_000 });
  proxy('GET', '/status');
  proxy('GET', '/live');
  proxy('GET', '/state');
  proxy('GET', '/state/stats');
  proxy('GET', '/pipeline/transitions');
  proxy('GET', '/lifecycle');
  proxy('GET', '/records');
  proxy('GET', '/records/archive');
  proxy('GET', '/pipeline');
  // ⛔ CP-SPEECH2-WEBUI18：旧三层 Pipeline 的写入口已退役（Speech2 是唯一产品后端）。
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
  // ⛔ WEBUI18：旧声纹/拍掌/Lab/activity-test 的只读诊断与写入口一并退出产品面。
  proxy('GET', '/devices');
  // 只读：旧 App policy（诊断），旧 speech-input 投影（verify/diagnostic）。⛔ 写入口已退役。
  proxy('GET', '/policy');
  proxy('GET', '/policy/status');
  proxy('GET', '/speech-input');

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

  proxy('POST', '/idle');
  proxy('POST', '/listen');
  // Android App 的 primary action 由 loopback service 统一收口到自动 CAM++ 模式。
  proxy('POST', '/assistant/call', '/assistant/call', { timeoutMs: 15_000 });
  // CP-SPEECH2-SHELL-POLICY5: thin, versioned Speech2 client routes. The Package owns no
  // Speech2 runtime and therefore does not add any microphone/model lifecycle here.
  proxy('GET', '/speech2/status');
  proxy('GET', '/speech2/policy');
  proxy('PUT', '/speech2/policy', '/speech2/policy', { timeoutMs: 15_000 });
  // ⭐ WEBUI18：Start = 旧链让出麦克风 + App Speech2 start + 启动 AudioRing 麦克风源（两者都要时间）。
  // ⚠ 真机：Stop 后再 Start 要 23–34 s（App 重载 T267 ctx）⇒ 给到 120 s。
  proxy('POST', '/speech2/start', '/speech2/start', { timeoutMs: 120_000 });
  proxy('POST', '/speech2/stop', '/speech2/stop', { timeoutMs: 45_000 });
  proxy('GET', '/speech2/input');
  proxy('POST', '/speech2/input', '/speech2/input', { timeoutMs: 15_000 });
  // CP-SPEECH2-TERMUX-SPEECH17：正式 transcript / history / My Voice / 分层状态。
  proxy('GET', '/speech2/overview');
  proxy('GET', '/speech2/transcripts/live');
  proxy('POST', '/speech2/transcripts/sync');
  proxy('GET', '/speech2/history');
  proxy('GET', '/speech2/my-voice');
  proxy('POST', '/speech2/my-voice', '/speech2/my-voice', { timeoutMs: 15_000 });
  proxy('DELETE', '/speech2/my-voice');
  proxy('GET', '/speech2/voices');
  proxy('POST', '/speech2/voices');
  proxy('POST', '/speech2/voices/test');
  proxy('POST', '/speech2/voices/record');
  proxy('PATCH', '/speech2/voices/item');
  proxy('DELETE', '/speech2/voices/item');
}

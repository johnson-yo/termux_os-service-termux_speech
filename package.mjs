/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package context, Termux Speech loopback service, Browser Session, and private data roots.
 * [OUTPUT]: Audio/ASR routes, transcript WebSocket, and speech.input/activity/transcript/idle Capabilities.
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
      WAKE_WORDS_ROOT: path.join(context.persistRoot, 'data', 'termux-speech', 'wake-words'),
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
        const text = await serviceText(`/state/watch${search}`);
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 交给下面按 null 处理。 */ }
        if (!parsed) return { frames: [], next: cursor };
        return {
          frames: [text],
          next: { version: parsed.version, boot_id: parsed.boot_id },
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

  // 模型架。⭐ 这是唯一能取得或删除语音模型的地方——资产包不出现在 Framework
  // 自己的 Package 页面里，所以少任何一条，setup 就走不完。
  proxy('GET', '/models');
  // 40 分钟：这一条真的在下几百 MB，由使用者显式点出来。
  proxy('POST', '/models/fetch', '/models/fetch', { timeoutMs: 40 * 60_000 });
  proxy('POST', '/models/delete', '/models/delete', { timeoutMs: 60_000 });
  proxy('POST', '/models/install-provider', '/models/install-provider', { timeoutMs: 5 * 60_000 });
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
  proxy('GET', '/kws');
  proxy('GET', '/kws/config');
  proxy('GET', '/vad');
  proxy('GET', '/vad/config');
  proxy('GET', '/vad/activity');
  proxy('GET', '/asr');
  proxy('GET', '/asr/config');
  proxy('GET', '/asr/transcripts');
  proxy('GET', '/devices');
  proxy('GET', '/speech-input');
  proxy('GET', '/wake-words/profiles');
  proxy('GET', '/wake-words/profile');
  proxy('GET', '/wake-words/guided/stream-test/status');
  proxy('POST', '/rms/config');
  proxy('POST', '/kws/config');
  proxy('POST', '/vad/config');
  proxy('POST', '/asr/config');
  proxy('POST', '/asr/transcribe');
  proxy('POST', '/chain/start');
  proxy('POST', '/chain/stop');
  proxy('POST', '/lifecycle/config');
  proxy('POST', '/idle');
  proxy('POST', '/listen');
  proxy('POST', '/input-device');
  proxy('POST', '/mic/enable');
  proxy('POST', '/mic/disable');
  proxy('POST', '/wake-words/profiles');
  proxy('POST', '/wake-words/profile/delete');
  proxy('POST', '/wake-words/profile/build');
  proxy('POST', '/wake-words/samples/delete');
  proxy('POST', '/wake-words/guided/capture/start');
  proxy('POST', '/wake-words/guided/capture/poll');
  proxy('POST', '/wake-words/guided/capture/stop');
  proxy('POST', '/wake-words/guided/capture/cancel');
  proxy('POST', '/wake-words/guided/test/start');
  proxy('POST', '/wake-words/guided/stream-test/start');
  proxy('POST', '/wake-words/guided/stream-test/stop');
}

/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Framework `/api/states`, the injected System Key, and one projection of the live snapshot.
 * [OUTPUT]: A push writer for this Package's states plus a reader for the facts other packages own.
 * [POS]: The Package's edge onto the Framework state bus. It carries facts about now — never PCM,
 *        tensors, credentials or paths, and never anything that must not be dropped.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const ROUTE_CLASSES = Object.freeze({
  builtin_mic: 'built_in',
  builtin_speaker: 'built_in',
  builtin_earpiece: 'built_in',
  bluetooth_sco: 'bluetooth',
  bluetooth_a2dp: 'bluetooth',
  wired_headset: 'wired',
  wired_headphones: 'wired',
  usb_device: 'usb',
  usb_headset: 'usb',
  usb_accessory: 'usb',
});

/** 路由分类。`unknown` 必须是**带内**取值：知道设备在但认不出它，与写入者已经死了不是同一件事。 */
export const routeClass = (device) => {
  const raw = String(device?.type_name ?? '').toLowerCase();
  if (!raw) return 'unknown';
  return ROUTE_CLASSES[raw] ?? (raw.includes('bluetooth') ? 'bluetooth'
    : raw.includes('usb') ? 'usb'
      : raw.includes('wired') || raw.includes('head') ? 'wired'
        : raw.includes('built') ? 'built_in' : 'unknown');
};

/** 只投影既有内部状态，不新增任何状态机。 */
export const projectStates = (value) => {
  const pcm = value?.pcm;
  const fresh = pcm?.recording === true
    && pcm?.transport_connected === true
    && Number.isFinite(Number(pcm.last_frame_age_ms))
    && Number(pcm.last_frame_age_ms) < 1000;
  return {
    'speech.input': fresh,
    'speech.stage': String(value?.pipeline?.owner ?? 'speech.rms').replace('speech.', ''),
    'speech.voice': value?.vad?.activity?.active === true,
    'audio.input.route': routeClass(value?.selection?.routed_device
      ?? value?.selection?.preferred_device),
  };
};

export class StateBus {
  constructor({ frameworkUrl, systemKey, packageId, fetchImpl = fetch }) {
    this.frameworkUrl = frameworkUrl;
    this.systemKey = systemKey;
    this.packageId = packageId;
    this.fetchImpl = fetchImpl;
    this.published = new Map();
    this.seen = new Map();
    this.lastError = null;
    this.writes = 0;
  }

  async post(path, body) {
    const response = await this.fetchImpl(`${this.frameworkUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.systemKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.reason ?? payload?.error ?? `states HTTP ${response.status}`);
    }
    return payload;
  }

  /** 只推变化。总线明确允许丢中间值，所以重复推同一个值没有任何意义。 */
  async publish(value) {
    const wanted = projectStates(value);
    for (const [name, next] of Object.entries(wanted)) {
      if (this.published.get(name) === next) continue;
      try {
        await this.post('/api/states', { name, value: next, package: this.packageId });
        this.published.set(name, next);
        this.writes += 1;
        this.lastError = null;
      } catch (error) {
        // 总线不可用不能影响语音链。下一次变化再试。
        this.lastError = String(error?.message ?? error);
      }
    }
    return this.snapshot();
  }

  /** 我们读到的别人的事实。页面要显示输出侧，而输出侧不归我们写。 */
  observed() {
    return Object.fromEntries([...this.seen].map(([name, state]) => [name, {
      value: state?.value ?? null,
      live: state?.live === true,
      ...(state?.live === true ? {} : { stale_reason: state?.stale_reason ?? 'unknown' }),
    }]));
  }

  async read(names) {
    const response = await this.fetchImpl(`${this.frameworkUrl}/api/states`, {
      headers: { Authorization: `Bearer ${this.systemKey}` },
      signal: AbortSignal.timeout(3000),
    });
    const payload = await response.json().catch(() => null);
    const wanted = new Set(names);
    const found = new Map();
    for (const state of payload?.states ?? []) {
      if (wanted.has(state.name)) found.set(state.name, state);
    }
    this.seen = found;
    return found;
  }

  snapshot() {
    return {
      schema: 'termux-os.speech-states.v1',
      published: Object.fromEntries(this.published),
      observed: this.observed(),
      writes: this.writes,
      last_error: this.lastError,
    };
  }
}

/**
 * ⭐ docs/061 §四.2：**回传抑制不再落在 RMS 门上**。
 *
 * 旧做法在 TTS 播放期间按住门，代价是整条输入链失聪——而使用者完全可能正想识别扬声器里
 * 的内容（YouTube、对面的人）。抑制改为在 VAD segment 完成时按**单调时间区间相交**判定，
 * 见 `capture/tts-intervals.mjs`：判据从「此刻是不是在播」变成「这一段音频是不是压在播放上」，
 * 后者精确得多，也不需要为了回答它而持续观测。
 *
 * ⛔ 无论用哪种做法，抑制点都**绝不是关麦克风**：进程重启后 Android 要求启动 mic FGS
 * 那一刻 Activity 为 TOP（docs/050 §11.7），走 `mic/disable` 会让一个防回传的功能把系统
 * 弄成永久失聪。
 */

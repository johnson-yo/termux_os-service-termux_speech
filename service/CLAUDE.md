# service/
> L2 | Parent: ../AGENTS.md

## Members

- `main.mjs`: wires PCM → RMS → Pool/KWS → VAD/WAV → ASR, owner handoffs, `speech.idle`, and the
  Package APIs. `/live` is the one endpoint the page polls.
- `app-api.mjs`: discovers and caches the App descriptor; marks 503/429 as retryable.
- `assets.mjs`: the only source of model locations. `ensureAssetRoot` fetches an optional asset the
  first time it is needed.
- `residents.mjs`: declares the VAD/ASR graphs as App-owned residents and runs them.
- `config.mjs`, `http-auth.mjs`, `status.mjs`: persistence, loopback auth, health file.
- `pcm-ws.mjs`: the App's PCM WebSocket; exposes counters, never payloads.
- `rms-gate.mjs`: live RMS and the OPEN latch, with two opening keys (threshold, wake hit).
- `pipeline-lease.mjs`: epoch-scoped close authority.
- `states.mjs`, `state-hub.mjs`: the state-bus facts and the change-driven stream behind `/live`.
- `speech-input.mjs`, `transcript-ws.mjs`: the `speech.input` projection and the transcript feed.
- `kws/`, `vad/`, `asr/`, `storage/`, `capture/`, `lifecycle/`: see their own L2 files.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

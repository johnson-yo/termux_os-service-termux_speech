# Package instructions — github.termux-os.service.termux-speech

## Responsibility

**Speech is the only product backend (release candidate 0.27.16).** The WebUI is Speech-only
(three pages: Overview, History, Settings); the legacy RMS/VAD/ASR product surface is retired — its write
routes answer `410 LEGACY_SPEECH_RETIRED`, its App pipeline telemetry and model reconciler do not
start, and at boot the legacy App pipeline is set to `stop` so the system microphone is free for
the Speech2 AudioRing source. Generic infrastructure (RecordGroups, state-hub, records, capability
registrations, speech.idle/listen actions) is kept. Source-tree legacy tools remain available to their
focused host tests, but `public-files.txt` excludes the downstream-only acoustic/speaker labs and
consumer contract fixture from the production archive; when those lab sources are absent, their
legacy routes return `410 LEGACY_SPEECH_RETIRED` and the product runtime remains loadable.

Own everything downstream of raw audio: RMS gate, owner lease, the manual FireRedVAD rolling
pre-roll Pool, the automatic CAM++ mono-ms rolling tape, FireRedVAD features and staircase cut
policy, WAV retention, ASR preprocessing and decoding, transcript records, and the five speech
Capabilities.

The user-facing ASR selector is `cfg.asr.model`; automatic App segments and the manual spool
follow it. App `speech-policy.asr.backend` is only a synchronized internal projection and is not
a second Settings control.

The Android App owns the microphone, the ORT-QNN/HTP runtime and graph residency. Discover it
through the `termux-os.app.api` Capability. Never route PCM, tensors, model bytes or credentials
through Framework Core or the browser.

## Rules

- **Declare a resident graph once, then only run it.** Never create or delete a graph session and
  never undeclare on shutdown — a service restart is not a reason to churn an HTP session.
- **Treat an App 503 as "not ready yet" and retry.** Only a non-retryable failure counts against an
  utterance.
- **Do not invent model paths or executable descriptors.** Manager 0.4.4 supplies only raw package
  and file facts (`file.local.path`). App `/api/inference/model/prepare` owns the source-to-runtime
  handoff, context/cache choice, and inference verification; App `/api/inference/residents` owns
  the live resident fact. The service may pass those returned facts to its consumers, but it never
  constructs a cache path or sends an executable/context descriptor back to Manager.
- **Only the current lease owner may close.** A lease answers who may close, never who is working.
- **Suppress feedback at the gate, never at the microphone.** Re-enabling capture needs a top
  activity, so disabling the mic becomes permanent deafness.
- **A session has no maximum length.** VAD silence and ASR idle policy close it.
- **A decision never writes back the reference it was judged against.** Almost every segment is a
  KEEP, so absorbing them drags the reference into the background and the gate quietly becomes
  always-KEEP. Freezing must apply to the value the decision reads, not the value the page prints —
  on the device those were two different numbers and the printed one looked healthy.
- **Adding a service route means registering it in `package.mjs` too**, and an installed
  `package.mjs` is only re-read after a full Framework restart (the loader skips the ESM
  cache-buster outside dev-runtime).
- **Never download inside service startup.** A model is hundreds of megabytes; fetching one there
  makes starting take half an hour with nowhere to show progress, and a failure removes the page
  that would fix it. Startup resolves; the model shelf fetches.
- Never overwrite user configuration, profiles, model files or records during an update.
- Give every Package instance a distinct App graph session name.

## Layout

- `service/` — HTTP service, App clients, resident declarations, RMS, lease, projections, config
  - `vad/` VAD and WAV · `asr/` recognition · `storage/` records
  - `capture/` App event stream · `lifecycle/` chain start/stop
- `service/speech2.mjs` — thin client for the independent App `/api/speech2/*` surface
  (status/policy/start/stop/transcripts/USER voice collection) plus the App AudioRing source API, the product
  Trigger mapping (`stop` = Speech2 stopped · `passthrough`/`volume` = `policy.trigger.mode`), the
  product policy field map, and `speech2Overview()` (layered projection + input + warnings +
  per-poll activity); it owns no audio, CAM/VAD/chunking/ASR/model lifecycle and never probes
  model files
- Speech2 Start (`POST /speech2/start`) = release the legacy mic path → App Speech2 start → start the
  configured AudioRing microphone source (`config.speech2.input_source`, default
  `SYSTEM_BUILTIN_MIC`); an input failure (e.g. `FGS_REQUIRED`) is kept and shown, never hidden
- `service/speech2-transcripts.mjs` — the formal Speech2 transcript consumer: AppEvents only wakes
  it, `GET /api/speech2/transcripts?after_seq=` is the authority; provisional stays live-only,
  a higher revision replaces the live line, a final enters records exactly once (key
  `s2:<boot_id>:<generation>:<segment_id>`), the `(boot_id, seq)` cursor lives in the data root
- `web/` — the Speech product surface: `index.html` (Overview / History / Settings; its `/packages/<id>/`
  base is required because Framework serves the package entry without a trailing slash), `app.js` (all I/O and
  rendering), `style.css`. The compact shared Header shows MEM/ZRAM plus Speech, Input, Live state,
  Trigger, Scene and Models from existing state domains. LIVE retains three current meters, a fixed
  60-second timeline of Sound/RMS, FireRedVAD probability, and actual CAM cosine, plus exactly two fixed
  text slots: current provisional and latest completed sentence (History remains the full list). Overview is
  the daily-use page with Stopped/Listening/Error and Start/Stop merged into its Mode/Activation controls card,
  plus Voice Input target, one-line explanation, and Sound/Speech/Voice-match meters; it omits engineering
  status grids, the temporary recording tool and acceptance controls.
  History reuses RecordGroups, the existing SQLite archive and `/records/audio`, shows frozen identity,
  and hides the player after WAV retention expires. Settings contains My Voices (USER collection API; never
  the fixed `my-voice` compatibility slot) and advanced policy/audio/model/diagnostics controls.
  My Voices Test captures five seconds for CAM-only comparison and is read-only. Conversation admits valid
  speech regardless of CAM identity; Voice Input filters non-target/unmatched speakers before ASR enqueue
  with a named trace reason. Every policy write remains GET → change → PUT of the complete policy.
- `service/models.mjs` — the model shelf: the raw Manager download/operation routes plus the
  raw/runtime/resident projection used by the WebUI
- `service/raw-models.mjs` — the fixed three-model raw mapping and App-runtime coordinator
- `service/asset-manager.mjs` — the raw-only Manager 0.4.4 capability client
- `test/`, `scripts/` — host suites, smoke, and the device verification hook
- `public-files.txt` — the release archive's contents. Anything imported at runtime must be listed.
  `scripts/consumer-fixture.mjs`, `service/acoustic-lab.mjs`, and `service/speaker-lab.mjs` are
  source-only test/lab inputs and must not be added to the production archive.

## Runtime paths

- Status: `<frameworkRoot>/.runtime/services/<context.services.id('termux-speech')>/`
- Config: `config/termux-speech.v4.json` (includes `speech2.input_source`)
- Speech2 transcript cursor: `<persistRoot>/data/termux-speech/speech2/transcript-cursor.v1.json`
  (⛔ never inside the version directory: an update must not lose or replay finals)
- Data: `<persistRoot>/data/termux-speech/{vad,asr,records}/`
- Models use speech's internal ids (`model.sensevoice`, `model.fireredvad`, and
  `model.campplus`) only as feature ids. The raw package mapping is fixed in
  `service/raw-models.mjs` and uses the Manager keys
  `huggingface:johnson-yo/termux_os-asset-{sensevoice,campplus,fireredvad}-htp-onnx`.
  Manager returns absolute local file facts; the service sends a complete raw source to App
  `/api/inference/model/prepare`; the returned App artifact and resident snapshot are separate
  runtime layers.

  ⛔ The service never restores Manager logical `resolve/use` routes, guesses a model/cache path,
  chooses a target or QNN version, or sends an executable/context descriptor to Manager.
  A missing layer degrades that feature and remains visible as `manager_unreachable`,
  `manager_contract_error`, `raw_missing`, `app_prepare_failed`, or `resident_failed`.

## Verification

`scripts/verify-device.mjs` answers `pass` (0), `fail` (1) or `blocked` (2). Blocked means a
prerequisite is missing, so nothing was asserted — it is not a kind of failure.

Two recoveries: after the App restarts, the mic foreground service needs one top activity; on
`NPU crashed. SSR detected (1007)` the residents still report loaded while every execution fails,
and recycling the App's inference workers restores them.

## Commands

```sh
termux-os-sdk test github.termux-os.service.termux-speech
termux-os-sdk doctor github.termux-os.service.termux-speech
termux-os-sdk release github.termux-os.service.termux-speech
```

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

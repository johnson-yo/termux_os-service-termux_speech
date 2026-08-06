# Package instructions — github.termux-os.service.termux-speech

## Responsibility

Own everything downstream of raw audio: RMS gate, owner lease, rolling pre-roll Pool, wake-word
policy, VAD features and cut policy, WAV retention, ASR preprocessing and decoding, transcript
records, and the five speech Capabilities.

The Android App owns the microphone, the ORT-QNN/HTP runtime and graph residency. Discover it
through the `termux-os.app.api` Capability. Never route PCM, tensors, model bytes or credentials
through Framework Core or the browser.

## Rules

- **Declare a resident graph once, then only run it.** Never create or delete a graph session and
  never undeclare on shutdown — a service restart is not a reason to churn an HTP session.
- **Treat an App 503 as "not ready yet" and retry.** Only a non-retryable failure counts against an
  utterance.
- **Hold no model paths.** Locations come from the Framework asset map at the moment a model is
  needed (`service/assets.mjs`).
- **Only the current lease owner may close.** A lease answers who may close, never who is working.
- **Suppress feedback at the gate, never at the microphone.** Re-enabling capture needs a top
  activity, so disabling the mic becomes permanent deafness.
- **A session has no maximum length.** The configured end keyword closes it.
- **Never download inside service startup.** A model is hundreds of megabytes; fetching one there
  makes starting take half an hour with nowhere to show progress, and a failure removes the page
  that would fix it. Startup resolves; the model shelf fetches.
- Never overwrite user configuration, profiles, model files or records during an update.
- Give every Package instance a distinct App graph session name.

## Layout

- `service/` — HTTP service, App clients, resident declarations, RMS, lease, projections, config
  - `kws/` wake word · `vad/` VAD and WAV · `asr/` recognition · `storage/` records
  - `capture/` App event stream · `lifecycle/` chain start/stop
- `service/models.mjs` — the model shelf: the only route to obtaining or removing a speech model,
  because asset Packages are hidden from the Framework's own Package pages
- `web/` — 概览 / 设置 / 诊断 pages plus the wake-word setup page
- `test/`, `scripts/` — host suites, smoke, and the device verification hook
- `public-files.txt` — the release archive's contents. Anything imported at runtime must be listed.

## Runtime paths

- Status: `<frameworkRoot>/.runtime/services/<context.services.id('termux-speech')>/`
- Config: `config/termux-speech.v4.json`
- Data: `<persistRoot>/data/termux-speech/{wake-words,records}/`
- Models: resolved by asset id, never by path — `model.fireredvad`,
  `model.sensevoice.{frontend,ctx,graph}`, `model.qwen3asr.*`

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

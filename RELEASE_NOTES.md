# Release notes — github.termux-os.service.termux-speech

## 0.18.0 — first public release

Supersedes 0.17.0, which was withdrawn before it could be installed: its archive carried source
comments naming an unrelated project, and the Framework's install-time content gate refused it.
The release workflow now runs that same gate before building the archive.

## 0.17.0 (withdrawn)

- Ask the App adapter for `termux-os.app.api`, the Capability it actually provides.
- Fetch an ASR model the first time it is needed rather than at install.
- `model.sensevoice.ctx` became one asset id with a build per DSP; the Framework picks this
  device's. Requires Framework `>= 0.2.22`.

## 0.13.0

- Three phone-first pages — 概览 / 设置 / 诊断 — replacing the six stage tabs.
- Settings grouped by occasion rather than by backend module.
- A transcript records the model that actually produced it.

Earlier versions were development checkpoints and are not documented here.

# Release notes — github.termux-os.service.termux-speech

## 0.19.0 — models are obtained from this page

- **The service starts without a model.** It used to download the SenseVoice context inside service
  startup: on a clean device that is half an hour with no visible progress, and a failure took the
  service with it — removing the very page you would use to fix it. Startup now only resolves.
  Transcription refuses with where to go, and the service stays up.
- **设置 → 模型** lists every model the Package needs, with its state, and downloads or removes it.
  Asset Packages no longer appear under the Framework's own Package pages, so this is the whole
  route: install the Package, open this page, fetch what is missing.
- **An asset Package can be installed from here too.** The page names the model it wants and the
  catalog answers which Package supplies it, so a tier that was never installed is one button away
  rather than a dead end.
- Three kinds of "not here" stay three answers: not downloaded, no build for this accelerator, or
  the asset Package is not installed. Each needs a different next step.

Requires Framework `>= 0.2.27`.

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

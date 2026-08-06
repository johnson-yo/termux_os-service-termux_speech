# Termux Speech

Speech to text on an Android phone, entirely on the device. A Termux-OS service Package.

Audio never leaves the phone: capture, wake word, voice activity detection and recognition all run
locally on the Qualcomm HTP accelerator through the Termux-OS App.

## Pipeline

```text
microphone → RMS gate → wake word → voice activity detection → speech recognition → transcript
```

The gate opens on either loudness or a wake word. Segments are cut at natural pauses, transcribed,
and written to a local record store with an HTTP feed and a live WebSocket.

## Models

| Stage | Model |
| --- | --- |
| Wake word | pinyin keyword spotting (provided by the App) |
| Voice activity | FireRedVAD |
| Recognition | SenseVoiceSmall (default), or Qwen3-ASR-0.6B in Q4 / Q8 |

Models are not bundled and not downloaded at install. Each one is fetched the first time it is
actually needed, from the asset Packages listed under Requirements. The SenseVoice context is
matched to the device's DSP automatically.

## Using it

Install from the Termux-OS package catalog, then open **Termux Speech** in the admin panel:

- **概览** — is it running, what it heard
- **设置** — microphone, wake word, sensitivity, ASR model
- **诊断** — per-stage readings when something is wrong

Enroll a wake word on the setup page before first use.

Provides the `speech.input`, `speech.activity`, `speech.transcript`, `speech.idle` and
`speech.listen` Capabilities for other Packages.

## Requirements

- Framework Core `>= 0.2.22`
- The Termux-OS App adapter (`termux-os.app.api`)
- `github.termux-os.asset.fireredvad >= 1.0.0`
- `github.termux-os.asset.sensevoice >= 3.0.0`
- `github.termux-os.asset.qwen3asr >= 1.1.0` — only for the Qwen tiers

## Development

```sh
for t in test/*.mjs; do node "$t"; done
node scripts/verify-device.mjs   # on a device, with the service running
```

## Licence

Apache-2.0. Model weights are distributed separately under their own terms by the asset Packages
above. See `LICENSE`, `NOTICE.md` and `SECURITY.md`.

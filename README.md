# Termux Speech

Speech to text on an Android phone, entirely on the device. This Termux-OS service Package keeps
audio local and exposes speech input, activity, transcript, idle, and listen Capabilities.

## Pipeline

The App owns microphone capture and the ORT-QNN/HTP runtime. This Package owns the processing
state and the two independent VAD paths:

```text
App microphone → PCM + RMS
                    │
                    ├─ RMS → FireRedVAD staircase cuts → WAV → ASR
                    │
                    └─ CAM++VAD activity FSM → incomplete/complete segments → ASR
                                                                  │
                                             transcript + record store + state feeds
```

FireRedVAD uses the measured gradient/staircase pause policy: it selects a scored pause valley,
cuts at the deep-core tail, and lets the residual continue into the next segment. CAM++VAD is a
separate resident activity path and does not use that cut policy. Both paths share one bounded ASR
spool and never send PCM through Framework Core or the browser.

## Models

| Stage | Model |
| --- | --- |
| Voice activity | FireRedVAD |
| Recognition | SenseVoiceSmall segment transcription |
| Speaker activity | CAM++ 192-d embedding |

Models are not bundled or downloaded during service startup. They are resolved through the asset
Packages listed under Requirements and fetched only when needed.

## Using it

Install from the Termux-OS package catalog, then open **Termux Speech** in the admin panel:

- **概览** — service health, current activity, and the latest recognition
- **设置** — microphone, sensitivity, ASR model, and speaker activity
- **诊断** — per-stage readings when something is wrong

## Requirements

- Framework Core `>= 0.2.27`
- The Termux-OS App adapter (`termux-os.app.api`)
- `github.termux-os.asset.fireredvad >= 1.0.0`
- `github.termux-os.asset.sensevoice >= 3.0.0`
- `github.termux-os.asset.campplus >= 1.0.0`

## Development

```sh
for t in test/*.mjs; do node "$t"; done
node scripts/verify-device.mjs   # on a device, with the service running
```

## Licence

Apache-2.0. Model weights are distributed separately under their own terms by the asset Packages
above. See `LICENSE`, `NOTICE.md`, and `SECURITY.md`.

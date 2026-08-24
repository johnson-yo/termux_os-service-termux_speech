# Termux Speech

Termux Speech is a local speech-input service for Termux-OS. Audio, recognition, and saved speech
records stay on the Android device while the service provides speech activity and transcript
capabilities to other packages.

## What it provides

- microphone input and speech-activity state;
- local speech-to-text with SenseVoice;
- optional speaker-activity detection with CAM++; and
- transcript, idle, and listen capabilities for consumers.

The Termux-OS App owns microphone capture and model execution. This Package owns speech-session
state, segmentation, storage, and the public capability surface.

## Models

- SenseVoice — speech recognition;
- FireRedVAD — voice activity detection; and
- CAM++ — optional speaker activity.

Model assets are managed separately by the HF Model Manager and are not bundled in this source
repository.

## Use

Install the Package from the Termux-OS catalog and open **Termux Speech** in the administration
interface. The WebUI exposes overview, settings, and diagnostic views.

## Development

```sh
for test in test/*.mjs; do node "$test"; done
node scripts/verify-device.mjs
```

## Licence

Apache-2.0. See `LICENSE`, `NOTICE.md`, and `SECURITY.md`.

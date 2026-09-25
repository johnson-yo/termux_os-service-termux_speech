# Termux Speech

Speech provides private, on-device transcription and speaker-aware voice controls for Termux-OS.
Audio capture and recognition run in the Android App; this service presents controls, live results,
history, and saved WAV playback.

## Product

- **Overview** shows live Speech activity and controls.
- **History** lists completed sentences and available audio.
- **Settings** manages input, modes, and My Voices.
- **Conversation** labels recognized speakers; **Voice Input** can listen for a selected voice;
  **Media** transcribes without speaker-based admission filtering.
- **My Voices** supports enrollment, rename, re-record, delete, and a five-second local test.

## Requirements

- Termux-OS Framework Core `>= 0.3.0` and the App Speech API.
- Model assets are installed separately; the optional HF Model Manager handles raw model files.

Install Termux Speech from the Termux-OS Package Registry. To run host checks, use
`for t in test/*.mjs; do node "$t"; done`; on-device verification is `node scripts/verify-device.mjs`.

Licensed under Apache-2.0. Model assets are distributed separately under their own terms; see
`LICENSE`, `NOTICE.md`, and `SECURITY.md`.

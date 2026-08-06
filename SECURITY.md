# Security

This Package captures microphone audio continuously while enabled.

- **Audio stays on the device.** PCM, tensors, WAV segments and model bytes travel only over
  authenticated loopback between this Package and the Termux-OS App. There is no upload path and no
  telemetry.
- **Transcripts and WAV segments are stored locally**, along with wake-word enrollment recordings.
  Anyone with read access to the Package's data directory can read them. Uninstalling preserves
  user data by design; delete the data directory if you want the recordings gone.
- **Credentials are never persisted.** The App base URL and token arrive through the
  `termux-os.app.api` Capability and stay in memory. The WebUI uses the Framework Browser Session.

Report a suspected vulnerability privately to the maintainer before opening a public issue. Do not
include device identifiers, tokens, recorded audio or transcripts in a public issue.

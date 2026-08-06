# service/asr/
> L2 | Parent: ../CLAUDE.md

## Members

- `features.mjs`: WAV preprocessing — fbank, LFR, CMVN.
- `controller.mjs`: SenseVoice through the App HTP or a Qwen3-ASR tier, CTC decoding, end-keyword
  and idle close rules, and per-tier asset resolution.

A tier resolves only its own assets, so a device without Qwen still runs SenseVoice. A decoded
result is normalised once in `../storage/text.mjs`; a blank one is discarded before admission.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

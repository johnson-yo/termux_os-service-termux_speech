# service/vad/
> L2 | Parent: ../CLAUDE.md

## Members

- `fbank.mjs`: dependency-free Kaldi-compatible feature extraction.
- `postprocessor.mjs`: stream conditions plus the gradient cut — segments end at the best pause
  found so far rather than at a hard limit.
- `controller.mjs`: the rolling pre-roll Pool, FireRedVAD calls through the App, WAV retention, and
  `speech.activity`.

The Pool rolls at all times. It belongs to VAD and is never a wake-word input.

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

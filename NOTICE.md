# Notice

This Package is licensed under Apache-2.0.

The Wake Words setup flow, pinyin WebSocket client, profile format, and pinyin coverage scorer were
adapted from `github.termux-os.service.wake-words` 0.5.0, also licensed under Apache-2.0.

At runtime the Android App may use `model.wake-pinyin.app-htp`, derived from the k2-fsa
sherpa-onnx WenetSpeech 3.3M KWS model published under Apache-2.0. This Package does not redistribute
the model, ONNX Runtime, QNN libraries, or any binary artifact.

SenseVoice WAV preprocessing and CTC integration were adapted from the archived
`github.termux-os.service.speech-asr` implementation. At runtime the Android App may use the
external SenseVoice EPContext produced from the FunASR/FunAudioLLM SenseVoice model. The model and
compiled context remain governed by their original notices and are not redistributed by this
Package.

AI-Agent disclosure is optional reference information: if an AI Agent materially contributed, record the tool and scope here without placing credentials, private prompts, or internal notes in the release.

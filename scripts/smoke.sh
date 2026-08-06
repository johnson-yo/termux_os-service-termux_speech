#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# [INPUT]: The Package backend, PCM/RMS/lease/KWS/VAD/ASR/WS modules, both WebUI pages, and isolated self-test.
# [OUTPUT]: A truthful PASS/FAIL result for github.termux-os.service.termux-speech.
# [POS]: scripts/smoke.sh in the generated Extension Package.
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
fail=0
node --check "$HERE/package.mjs" && echo "PASS backend syntax" || { echo "FAIL backend syntax"; fail=1; }
node --check "$HERE/service/main.mjs" && echo "PASS service syntax" || { echo "FAIL service syntax"; fail=1; }
node --check "$HERE/service/app-api.mjs" && echo "PASS App API client syntax" || { echo "FAIL App API client syntax"; fail=1; }
node --check "$HERE/service/pcm-ws.mjs" && echo "PASS PCM WebSocket syntax" || { echo "FAIL PCM WebSocket syntax"; fail=1; }
node --check "$HERE/service/rms-gate.mjs" && echo "PASS RMS Gate syntax" || { echo "FAIL RMS Gate syntax"; fail=1; }
node --check "$HERE/service/pipeline-lease.mjs" && echo "PASS Pipeline lease syntax" || { echo "FAIL Pipeline lease syntax"; fail=1; }
node --check "$HERE/service/lifecycle/controller.mjs" && echo "PASS lifecycle controller syntax" || { echo "FAIL lifecycle controller syntax"; fail=1; }
node --check "$HERE/service/capture/app-events.mjs" && echo "PASS capture observer syntax" || { echo "FAIL capture observer syntax"; fail=1; }
node --check "$HERE/service/capture/tts-intervals.mjs" && echo "PASS TTS interval syntax" || { echo "FAIL TTS interval syntax"; fail=1; }
node --check "$HERE/service/storage/groups.mjs" && echo "PASS record groups syntax" || { echo "FAIL record groups syntax"; fail=1; }
node --check "$HERE/service/storage/archive.mjs" && echo "PASS record archive syntax" || { echo "FAIL record archive syntax"; fail=1; }
node --check "$HERE/service/kws/controller.mjs" && echo "PASS KWS controller syntax" || { echo "FAIL KWS controller syntax"; fail=1; }
node --check "$HERE/service/kws/gate-lease.mjs" && echo "PASS KWS Gate lease syntax" || { echo "FAIL KWS Gate lease syntax"; fail=1; }
node --check "$HERE/service/kws/pinyin-ws.mjs" && echo "PASS pinyin WS syntax" || { echo "FAIL pinyin WS syntax"; fail=1; }
node --check "$HERE/service/kws/pinyin-scorer.mjs" && echo "PASS pinyin scorer syntax" || { echo "FAIL pinyin scorer syntax"; fail=1; }
node --check "$HERE/service/vad/controller.mjs" && echo "PASS VAD controller syntax" || { echo "FAIL VAD controller syntax"; fail=1; }
node --check "$HERE/service/vad/fbank.mjs" && echo "PASS VAD fbank syntax" || { echo "FAIL VAD fbank syntax"; fail=1; }
node --check "$HERE/service/vad/postprocessor.mjs" && echo "PASS VAD postprocessor syntax" || { echo "FAIL VAD postprocessor syntax"; fail=1; }
node --check "$HERE/service/asr/controller.mjs" && echo "PASS ASR controller syntax" || { echo "FAIL ASR controller syntax"; fail=1; }
node --check "$HERE/service/asr/features.mjs" && echo "PASS ASR features syntax" || { echo "FAIL ASR features syntax"; fail=1; }
node --check "$HERE/service/transcript-ws.mjs" && echo "PASS transcript WebSocket syntax" || { echo "FAIL transcript WebSocket syntax"; fail=1; }
node --check "$HERE/web/views.js" && echo "PASS WebUI views syntax" || { echo "FAIL WebUI views syntax"; fail=1; }
node --check "$HERE/web/app.js" && echo "PASS WebUI syntax" || { echo "FAIL WebUI syntax"; fail=1; }
node --check "$HERE/web/setup.js" && echo "PASS setup WebUI syntax" || { echo "FAIL setup WebUI syntax"; fail=1; }
node "$HERE/test/self-test.mjs" || fail=1
node "$HERE/test/lifecycle-test.mjs" || fail=1
node "$HERE/test/storage-test.mjs" || fail=1
node "$HERE/test/state-test.mjs" || fail=1
echo "smoke: $([ $fail -eq 0 ] && echo ALL PASS || echo FAILED)"
exit $fail

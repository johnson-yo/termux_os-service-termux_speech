/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Device/PCM metadata plus RMS, Pipeline lease, FireRedVAD/WAV, and ASR snapshots.
 * [OUTPUT]: Provider-neutral speech.input metadata with truthful owner, Pool, WAV, and transcript boundaries.
 * [POS]: Pure projection; PCM bytes never enter the returned object or Framework/browser routes.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export const SPEECH_INPUT_SCHEMA = 'termux-os.speech-input.v1';

export function projectSpeechInput({
  devices,
  mic,
  rmsStream = null,
  pcmStream,
  rmsGate = null,
  vad = null,
  asr = null,
  pipeline = null,
  vadMode = 'unknown',
  nowMs = Date.now(),
}) {
  const selector = devices?.configured?.input_device
    ?? mic?.configured_input_device
    ?? 'system_default';
  const selected = selector === 'system_default'
    ? null
    : (devices?.inputs ?? []).find((item) => item.selector === selector) ?? null;
  const rmsFresh = rmsStream?.connected === true
    && Number.isFinite(Number(rmsStream?.last_frame_age_ms))
    && Number(rmsStream.last_frame_age_ms) <= 1000;
  const recording = mic?.recording === true;
  const pool = vad?.pcm_pool ?? null;
  return {
    schema: SPEECH_INPUT_SCHEMA,
    capability: 'speech.input',
    provider: 'termux-speech',
    ready: recording && rmsFresh,
    reason: !recording
      ? 'microphone_not_recording'
      : !rmsStream?.connected ? 'authenticated_rms_stream_not_connected'
        : !rmsFresh ? 'rms_stream_stale'
          : null,
    selection: {
      selector,
      system_default: selector === 'system_default',
      selected_device: selected,
      preferred_device: mic?.preferred_input_device ?? null,
      routed_device: mic?.routed_input_device ?? null,
    },
    pcm: {
      encoding: pcmStream?.encoding ?? 'pcm_s16le',
      sample_rate_hz: Number(pcmStream?.sample_rate_hz) || Number(mic?.rate) || 16_000,
      channels: Number(pcmStream?.channels) || 1,
      frame_ms: Number(pcmStream?.frame_ms) || Number(mic?.frame_ms) || 100,
      recording,
      transport_connected: pcmStream?.connected === true,
      frame_seq: Number(pcmStream?.frame_seq) || 0,
      bytes_total: Number(pcmStream?.bytes_total) || 0,
      last_frame_age_ms: pcmStream?.last_frame_age_ms ?? null,
      payload_exposed_by_capability: false,
    },
    rms: {
      transport_connected: rmsStream?.connected === true,
      frame_seq: Number(rmsStream?.frame_seq) || 0,
      last_frame_age_ms: rmsStream?.last_frame_age_ms ?? null,
      binary_frames: Number(rmsStream?.binary_frames) || 0,
      payload_exposed_by_capability: false,
    },
    rms_gate: rmsGate,
    pcm_pool: pool,
    pipeline,
    vad_mode: vadMode,
    vad,
    asr,
    downstream: {
      path: vadMode === 'camplus_automatic'
        ? 'pcm_to_rms_to_camplus_vad_to_wav_to_asr_text'
        : vadMode === 'fireredvad_manual'
          ? 'pcm_to_rms_to_fireredvad_to_wav_to_asr_text'
          : 'pcm_to_rms_to_vad_to_wav_to_asr_text',
      vad_mode: vadMode,
      close_owner: pipeline?.owner ?? 'speech.rms',
      close_policy: 'last_downstream_owner',
      idle_capability: 'speech.idle',
      stages: [
        { id: 'rms', role: 'open_admission', connected: rmsGate?.available === true
          && rmsStream?.connected === true },
        { id: 'pool', role: vadMode === 'camplus_automatic'
          ? 'camplus_preroll_only' : 'fireredvad_preroll_only',
          connected: pool?.connected === true },
        { id: 'vad', role: vadMode === 'camplus_automatic'
          ? 'camplus_user_to_wav' : 'fireredvad_staircase_to_wav',
          connected: vadMode === 'camplus_automatic'
            ? true : vad?.model?.files_present === true },
        { id: 'asr', role: 'wav_to_text_only', connected: asr?.ready === true },
      ],
    },
    storage: {
      hot_pcm_owner: 'termux-speech',
      hot_pcm_scope: vadMode === 'camplus_automatic'
        ? 'process-memory-rolling-camplus-preroll' : 'process-memory-after-rms-admission',
      rms_transport: 'authenticated_app_loopback_rms_ws',
      raw_pcm_transport: 'authenticated_app_loopback_pcm_ws_on_demand',
      framework_pcm_egress: 'none',
      browser_pcm_egress: 'none',
      wav_owner: 'termux-speech',
      wav_scope: 'package-persistent-data',
      wav_root: vad?.wav?.root ?? null,
      wav_index: vad?.wav?.index ?? null,
      transcript_owner: 'termux-speech',
      transcript_scope: 'package-persistent-data',
      transcript_index: asr?.transcripts?.index ?? null,
    },
    observed_at_ms: nowMs,
  };
}

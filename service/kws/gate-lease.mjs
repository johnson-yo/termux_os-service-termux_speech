/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A latched RMS Gate, Pipeline owner authority, qualified PCM, pinyin telemetry, and timeout config.
 * [OUTPUT]: One KWS-owned idle request only while the Pipeline lease still names KWS as owner.
 * [POS]: KWS lifecycle policy; a VAD handoff immediately invalidates this stage's close authority.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.round(Math.max(minimum, Math.min(maximum, parsed)))
    : fallback;
};

export class KwsGateLease {
  constructor({ idleTimeoutMs = 15_000 } = {}) {
    this.configure({ idleTimeoutMs });
    this.closeAuthority = false;
    this.active = false;
    this.gateTransitionSeq = 0;
    this.openedAtMs = null;
    this.lastQualifiedPcmAtMs = null;
    this.lastQualifiedFrameSeq = 0;
    this.deadlineMs = null;
    this.closeRequested = false;
    this.segment = null;
    this.lastSegment = null;
    this.lastHit = null;
    this.lastClose = null;
  }

  configure({ idleTimeoutMs = this.idleTimeoutMs } = {}) {
    this.idleTimeoutMs = boundedInteger(idleTimeoutMs, 15_000, 1000, 60_000);
  }

  setCloseAuthority(active) {
    this.closeAuthority = active === true;
    if (!this.closeAuthority) this.closeRequested = false;
    return this.snapshot();
  }

  observeGate(gate, nowMs = Date.now()) {
    const open = gate?.state === 'open' && gate?.pcm_admission === 'allow';
    const transitionSeq = Math.max(0, Number(gate?.transition_seq) || 0);
    if (open && (!this.active || transitionSeq !== this.gateTransitionSeq)) {
      this.active = true;
      this.gateTransitionSeq = transitionSeq;
      this.openedAtMs = Number(gate?.opened_at_ms) || nowMs;
      this.lastQualifiedPcmAtMs = this.openedAtMs;
      this.lastQualifiedFrameSeq = Math.max(0, Number(gate?.frame_seq) || 0);
      this.deadlineMs = this.lastQualifiedPcmAtMs + this.idleTimeoutMs;
      this.closeRequested = false;
      this.segment = null;
    } else if (!open && this.active) {
      this.active = false;
      this.deadlineMs = null;
      this.closeRequested = false;
      this.segment = null;
    } else if (open) {
      const frameSeq = Math.max(0, Number(gate?.frame_seq) || 0);
      const current = Number(gate?.current);
      const threshold = Number(gate?.open_threshold);
      const qualified = frameSeq !== this.lastQualifiedFrameSeq
        && Number.isFinite(current)
        && Number.isFinite(threshold)
        && current >= threshold;
      if (qualified) {
        this.lastQualifiedFrameSeq = frameSeq;
        this.lastQualifiedPcmAtMs = nowMs;
        this.deadlineMs = nowMs + this.idleTimeoutMs;
        this.closeRequested = false;
      }
    }
    return this.snapshot(nowMs);
  }

  onSegmentStart(segmentId, nowMs = Date.now()) {
    if (!this.active) return this.snapshot(nowMs);
    this.segment = {
      id: segmentId,
      active: true,
      started_at_ms: nowMs,
      token_count: 0,
      decoded_text: '',
    };
    return this.snapshot(nowMs);
  }

  onSegmentToken({ segmentId, text, tokenCount }, nowMs = Date.now()) {
    if (!this.active) return this.snapshot(nowMs);
    if (!this.segment) {
      this.segment = {
        id: segmentId,
        active: true,
        started_at_ms: nowMs,
        token_count: 0,
        decoded_text: '',
      };
    }
    if (this.segment.id !== segmentId) return this.snapshot(nowMs);
    this.segment.decoded_text = text ?? this.segment.decoded_text;
    this.segment.token_count = Number(tokenCount) || this.segment.token_count;
    this.segment.observed_at_ms = nowMs;
    return this.snapshot(nowMs);
  }

  onSegmentFinal({
    segmentId,
    hit = false,
    reason = null,
    score = 0,
    text = '',
    durationMs = null,
  }, nowMs = Date.now()) {
    this.lastSegment = {
      id: segmentId,
      hit: hit === true,
      reason: reason ?? (hit ? 'kws_hit' : 'kws_miss'),
      score: Number(score) || 0,
      decoded_text: text,
      duration_ms: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
      finalized_at_ms: nowMs,
    };
    if (this.segment?.id === segmentId) this.segment.active = false;
    if (hit) this.lastHit = { ...this.lastSegment };
    return this.snapshot(nowMs);
  }

  pollClose(nowMs = Date.now()) {
    if (!this.closeAuthority || !this.active || this.closeRequested
      || this.deadlineMs === null || nowMs < this.deadlineMs) {
      return null;
    }
    this.closeRequested = true;
    this.lastClose = {
      reason: 'kws_no_qualified_pcm_timeout',
      requested_at_ms: nowMs,
    };
    return {
      reason: this.lastClose.reason,
      requested_at_ms: nowMs,
      owner: 'speech.kws',
    };
  }

  snapshot(nowMs = Date.now()) {
    return {
      schema: 'termux-os.kws-gate-lease.v2',
      active: this.active,
      close_authority: this.closeAuthority,
      gate_transition_seq: this.gateTransitionSeq,
      opened_at_ms: this.openedAtMs,
      idle_timeout_ms: this.idleTimeoutMs,
      last_qualified_pcm_at_ms: this.lastQualifiedPcmAtMs,
      last_qualified_frame_seq: this.lastQualifiedFrameSeq,
      deadline_ms: this.deadlineMs,
      remaining_ms: !this.closeAuthority || this.deadlineMs === null
        ? null
        : Math.max(0, this.deadlineMs - nowMs),
      resets_on: 'new_pcm_frame_at_or_above_rms_open_threshold',
      close_requested: this.closeRequested,
      segment: this.segment ? { ...this.segment } : null,
      last_segment: this.lastSegment ? { ...this.lastSegment } : null,
      last_hit: this.lastHit ? { ...this.lastHit } : null,
      last_close: this.lastClose ? { ...this.lastClose } : null,
    };
  }
}

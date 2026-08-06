/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: RMS Gate transitions plus KWS, VAD, ASR, or developer handoff/idle requests.
 * [OUTPUT]: One epoch-scoped downstream owner and an auditable transition history.
 * [POS]: The single source of truth for the “last downstream stage closes” invariant.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import crypto from 'node:crypto';

export const PIPELINE_OWNERS = Object.freeze({
  RMS: 'speech.rms',
  KWS: 'speech.kws',
  VAD: 'speech.vad',
  ASR: 'speech.asr',
});

const NEXT_OWNER = Object.freeze({
  [PIPELINE_OWNERS.KWS]: PIPELINE_OWNERS.VAD,
  [PIPELINE_OWNERS.VAD]: PIPELINE_OWNERS.ASR,
});

const cloneJson = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

export class PipelineLease {
  constructor({ historyLimit = 64 } = {}) {
    this.historyLimit = Math.max(8, Math.min(256, Number(historyLimit) || 64));
    this.owner = PIPELINE_OWNERS.RMS;
    this.epoch = 0;
    this.sessionId = null;
    this.gateTransitionSeq = 0;
    this.openedAtMs = null;
    this.ownerSinceMs = Date.now();
    this.lastIdle = null;
    this.lastRejected = null;
    this.transitions = [];
  }

  record(from, to, reason, actor, nowMs, metadata = null) {
    const transition = {
      seq: this.transitions.at(-1)?.seq + 1 || 1,
      epoch: this.epoch,
      session_id: this.sessionId,
      from,
      to,
      reason,
      actor,
      at_ms: nowMs,
      metadata: cloneJson(metadata),
    };
    this.transitions.push(transition);
    while (this.transitions.length > this.historyLimit) this.transitions.shift();
    this.owner = to;
    this.ownerSinceMs = nowMs;
    return transition;
  }

  observeGate(gate, nowMs = Date.now()) {
    const open = gate?.state === 'open' && gate?.pcm_admission === 'allow';
    const transitionSeq = Math.max(0, Number(gate?.transition_seq) || 0);
    if (open && this.owner === PIPELINE_OWNERS.RMS) {
      this.epoch += 1;
      this.sessionId = `speech_${nowMs}_${crypto.randomBytes(3).toString('hex')}`;
      this.gateTransitionSeq = transitionSeq;
      this.openedAtMs = Number(gate?.opened_at_ms) || nowMs;
      const transition = this.record(
        PIPELINE_OWNERS.RMS,
        PIPELINE_OWNERS.KWS,
        'rms_open',
        PIPELINE_OWNERS.RMS,
        nowMs,
        { gate_transition_seq: transitionSeq },
      );
      return { type: 'open', accepted: true, transition, snapshot: this.snapshot(nowMs) };
    }
    if (!open && this.owner !== PIPELINE_OWNERS.RMS) {
      const previousOwner = this.owner;
      const transition = this.record(
        previousOwner,
        PIPELINE_OWNERS.RMS,
        gate?.last_transition?.reason ?? 'upstream_unavailable',
        'upstream_safety',
        nowMs,
        { gate_transition_seq: transitionSeq },
      );
      this.lastIdle = {
        epoch: this.epoch,
        previous_owner: previousOwner,
        reason: transition.reason,
        actor: transition.actor,
        at_ms: nowMs,
      };
      this.sessionId = null;
      this.openedAtMs = null;
      return { type: 'idle', accepted: true, transition, snapshot: this.snapshot(nowMs) };
    }
    return { type: 'unchanged', accepted: false, snapshot: this.snapshot(nowMs) };
  }

  handoff(expectedOwner, nextOwner, reason, nowMs = Date.now(), metadata = null) {
    if (NEXT_OWNER[expectedOwner] !== nextOwner) {
      throw new Error(`unsupported pipeline handoff: ${expectedOwner} -> ${nextOwner}`);
    }
    if (this.owner !== expectedOwner) {
      return this.reject(expectedOwner, reason, 'stale_owner', nowMs, metadata);
    }
    const transition = this.record(
      expectedOwner,
      nextOwner,
      reason,
      expectedOwner,
      nowMs,
      metadata,
    );
    return { accepted: true, transition, snapshot: this.snapshot(nowMs) };
  }

  requestIdle({
    requester,
    reason = 'speech_idle',
    epoch = null,
    force = false,
    metadata = null,
  }, nowMs = Date.now()) {
    if (this.owner === PIPELINE_OWNERS.RMS) {
      return this.reject(requester, reason, 'already_idle', nowMs, metadata);
    }
    if (!force && requester !== this.owner) {
      return this.reject(requester, reason, 'stale_owner', nowMs, metadata);
    }
    if (!force && epoch !== null && Number(epoch) !== this.epoch) {
      return this.reject(requester, reason, 'stale_epoch', nowMs, metadata);
    }
    const previousOwner = this.owner;
    const transition = this.record(
      previousOwner,
      PIPELINE_OWNERS.RMS,
      reason,
      force ? 'developer' : requester,
      nowMs,
      metadata,
    );
    this.lastIdle = {
      epoch: this.epoch,
      previous_owner: previousOwner,
      reason,
      actor: transition.actor,
      at_ms: nowMs,
    };
    this.sessionId = null;
    this.openedAtMs = null;
    return {
      accepted: true,
      previous_owner: previousOwner,
      transition,
      snapshot: this.snapshot(nowMs),
    };
  }

  reject(requester, reason, code, nowMs, metadata) {
    this.lastRejected = {
      requester,
      current_owner: this.owner,
      epoch: this.epoch,
      reason,
      code,
      at_ms: nowMs,
      metadata: cloneJson(metadata),
    };
    return {
      accepted: false,
      code,
      current_owner: this.owner,
      snapshot: this.snapshot(nowMs),
    };
  }

  snapshot(nowMs = Date.now()) {
    return {
      schema: 'termux-os.speech-pipeline-lease.v1',
      state: this.owner === PIPELINE_OWNERS.RMS ? 'idle' : 'active',
      owner: this.owner,
      epoch: this.epoch,
      session_id: this.sessionId,
      gate_transition_seq: this.gateTransitionSeq,
      opened_at_ms: this.openedAtMs,
      // 会话的绝对年龄。owner 每次交接都会重置 `owner_since_ms`，而这个不会——
      // 它是唯一不被「会话内的活动」重置的时间基准。
      session_age_ms: this.openedAtMs === null ? null : Math.max(0, nowMs - this.openedAtMs),
      owner_since_ms: this.ownerSinceMs,
      owner_age_ms: Math.max(0, nowMs - this.ownerSinceMs),
      close_policy: 'last_downstream_owner',
      upstream_safety_override: true,
      last_idle: cloneJson(this.lastIdle),
      last_rejected: cloneJson(this.lastRejected),
      last_transition: cloneJson(this.transitions.at(-1)),
      transitions: this.transitions.map((item) => cloneJson(item)),
      observed_at_ms: nowMs,
    };
  }
}

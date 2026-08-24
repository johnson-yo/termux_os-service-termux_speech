/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Monotonic service time, one CAM++ round identity, and confirmed USER events.
 * [OUTPUT]: A single rolling USER-loss deadline with stale-round rejection and diagnostics.
 * [POS]: CAM++ lifecycle guard; it decides when automatic speech returns to RMS, but never
 *        participates in FireRedVAD, segmentation, WAV, or ASR.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { performance } from 'node:perf_hooks';

export const DEFAULT_USER_WATCHDOG_TIMEOUT_MS = 8_000;

/** Monotonic milliseconds: wall-clock changes must not extend a speech round. */
export const monotonicNowMs = () => performance.now();

const finiteOr = (value, fallback) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

export class UserWatchdog {
  constructor({ timeoutMs = DEFAULT_USER_WATCHDOG_TIMEOUT_MS, now = monotonicNowMs } = {}) {
    this.timeoutMs = Math.max(1, finiteOr(timeoutMs, DEFAULT_USER_WATCHDOG_TIMEOUT_MS));
    this.now = now;
    this.roundId = null;
    this.sequence = 0;
    this.active = false;
    this.openedAtMs = null;
    this.lastConfirmedUserAtMs = null;
    this.lastConfirmedUserAppMonoMs = null;
    this.deadlineMs = null;
  }

  open({ roundId, openedAtMs = this.now() } = {}) {
    this.sequence += 1;
    this.roundId = roundId ?? this.sequence;
    this.active = true;
    this.openedAtMs = finiteOr(openedAtMs, this.now());
    this.lastConfirmedUserAtMs = null;
    this.lastConfirmedUserAppMonoMs = null;
    this.deadlineMs = this.openedAtMs + this.timeoutMs;
    return this.snapshot(this.openedAtMs);
  }

  /** Only a formal USER confirmation refreshes the deadline. */
  confirm({ roundId, atMs = this.now(), appMonoMs = null } = {}) {
    if (!this.active || roundId !== this.roundId) return false;
    this.lastConfirmedUserAtMs = finiteOr(atMs, this.now());
    this.lastConfirmedUserAppMonoMs = Number.isFinite(Number(appMonoMs))
      ? Number(appMonoMs) : null;
    this.deadlineMs = this.lastConfirmedUserAtMs + this.timeoutMs;
    return true;
  }

  clear(roundId = null) {
    if (roundId !== null && roundId !== this.roundId) return false;
    this.active = false;
    this.roundId = null;
    this.openedAtMs = null;
    this.lastConfirmedUserAtMs = null;
    this.lastConfirmedUserAppMonoMs = null;
    this.deadlineMs = null;
    return true;
  }

  expired(nowMs = this.now(), roundId = this.roundId) {
    return this.active
      && roundId === this.roundId
      && this.deadlineMs !== null
      && finiteOr(nowMs, this.now()) >= this.deadlineMs;
  }

  snapshot(nowMs = this.now()) {
    const now = finiteOr(nowMs, this.now());
    const remaining = this.active && this.deadlineMs !== null
      ? Math.max(0, this.deadlineMs - now) : null;
    return {
      timeout_ms: this.timeoutMs,
      active: this.active,
      round_id: this.roundId,
      sequence: this.sequence,
      clock: 'service_monotonic_ms',
      opened_at_ms: this.openedAtMs,
      last_confirmed_user_at_ms: this.lastConfirmedUserAtMs,
      last_confirmed_user_app_mono_ms: this.lastConfirmedUserAppMonoMs,
      deadline_ms: this.deadlineMs,
      remaining_ms: remaining,
      remaining_seconds: remaining === null ? null : Math.ceil(remaining / 1000),
    };
  }
}

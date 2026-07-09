import { computeWaitSeconds } from '../utils/waitSecondsBudget';

describe('computeWaitSeconds (ENG-124 wait_seconds budget cap)', () => {
  const NOW = 1_000_000_000_000; // fixed epoch ms for determinism

  // ─── No deadline: preserve prior behavior ──────────────────────────────
  it('returns the requested seconds unchanged when no deadline is supplied', () => {
    expect(computeWaitSeconds({ requestedSeconds: 30, nowMs: NOW })).toEqual({
      seconds: 30,
      requestedSeconds: 30,
      deadlineReached: false,
    });
  });

  it('clamps the requested value to the 300s max', () => {
    expect(computeWaitSeconds({ requestedSeconds: 400, nowMs: NOW })).toEqual({
      seconds: 300,
      requestedSeconds: 300,
      deadlineReached: false,
    });
  });

  it('floors a below-range or invalid request to 1 second', () => {
    expect(computeWaitSeconds({ requestedSeconds: 0, nowMs: NOW }).seconds).toBe(1);
    expect(computeWaitSeconds({ requestedSeconds: -5, nowMs: NOW }).seconds).toBe(1);
    expect(computeWaitSeconds({ requestedSeconds: undefined, nowMs: NOW }).seconds).toBe(1);
    expect(computeWaitSeconds({ requestedSeconds: NaN, nowMs: NOW }).seconds).toBe(1);
  });

  // ─── Deadline far away: no capping ─────────────────────────────────────
  it('does not cap when the deadline is comfortably beyond the requested wait', () => {
    const result = computeWaitSeconds({
      requestedSeconds: 30,
      deadlineMs: NOW + 10 * 60 * 1000, // 10 min out
      nowMs: NOW,
    });
    expect(result).toEqual({ seconds: 30, requestedSeconds: 30, deadlineReached: false });
  });

  // ─── Deadline soon: clamp to remaining budget ──────────────────────────
  it('shortens the wait to the remaining budget minus the safety margin', () => {
    // 20s until deadline, default 5s margin → 15s allowed, request 60s
    const result = computeWaitSeconds({
      requestedSeconds: 60,
      deadlineMs: NOW + 20 * 1000,
      nowMs: NOW,
    });
    expect(result).toEqual({ seconds: 15, requestedSeconds: 60, deadlineReached: true });
  });

  it('returns a zero-length wait when the deadline is already within the margin', () => {
    const result = computeWaitSeconds({
      requestedSeconds: 60,
      deadlineMs: NOW + 3 * 1000, // 3s out, under the 5s margin
      nowMs: NOW,
    });
    expect(result).toEqual({ seconds: 0, requestedSeconds: 60, deadlineReached: true });
  });

  it('returns a zero-length wait when the deadline is already in the past', () => {
    const result = computeWaitSeconds({
      requestedSeconds: 60,
      deadlineMs: NOW - 10 * 1000,
      nowMs: NOW,
    });
    expect(result).toEqual({ seconds: 0, requestedSeconds: 60, deadlineReached: true });
  });

  // ─── Boundary: remaining exactly equals requested ──────────────────────
  it('does not flag deadlineReached when remaining budget exactly covers the request', () => {
    // 35s out, 5s margin → 30s remaining, request 30s
    const result = computeWaitSeconds({
      requestedSeconds: 30,
      deadlineMs: NOW + 35 * 1000,
      nowMs: NOW,
    });
    expect(result).toEqual({ seconds: 30, requestedSeconds: 30, deadlineReached: false });
  });

  it('honors a custom safety margin', () => {
    const result = computeWaitSeconds({
      requestedSeconds: 60,
      deadlineMs: NOW + 30 * 1000,
      nowMs: NOW,
      marginSeconds: 10, // 30 - 10 = 20s allowed
    });
    expect(result).toEqual({ seconds: 20, requestedSeconds: 60, deadlineReached: true });
  });
});

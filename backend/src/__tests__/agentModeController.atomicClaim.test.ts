import {
  activeSessionGenerations,
  tryClaimSessionGeneration,
  releaseSessionGeneration,
} from '../controllers/agentModeController';

/**
 * INCREMENT B2 — atomic session-generation claim (no double-proceed race).
 *
 * The pre-existing pattern was a hand-rolled `has()` check followed by a
 * separate `add()` at two duplicated call sites. The two statements were only
 * atomic because nothing `await`ed between them; any future edit inserting an
 * await between check and set re-opens a window where two near-simultaneous
 * /generate calls both proceed.
 *
 * The fix encapsulates check-and-set into a single indivisible primitive,
 * `tryClaimSessionGeneration(sessionId)`, that returns `true` for exactly one
 * caller and `false` for any concurrent caller while the session is busy.
 *
 * These assertions are the human-written behavioral contract for B2.
 */
describe('AgentModeController - atomic session-generation claim (B2)', () => {
  const sessionId = 'session-claim-race';

  beforeEach(() => {
    activeSessionGenerations.clear();
  });

  it('two near-simultaneous claims on one sessionId: exactly one proceeds', () => {
    // Two claims fired back-to-back with NO await between them — the exact
    // shape of "near-simultaneous" requests racing on the same tick.
    const first = tryClaimSessionGeneration(sessionId);
    const second = tryClaimSessionGeneration(sessionId);

    // Exactly one proceeds, the other is rejected (busy/locked).
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('records the session as busy once claimed', () => {
    expect(activeSessionGenerations.has(sessionId)).toBe(false);
    tryClaimSessionGeneration(sessionId);
    expect(activeSessionGenerations.has(sessionId)).toBe(true);
  });

  it('a different sessionId can still claim concurrently (no cross-session blocking)', () => {
    expect(tryClaimSessionGeneration('session-a')).toBe(true);
    expect(tryClaimSessionGeneration('session-b')).toBe(true);
    // But each session is independently single-flight.
    expect(tryClaimSessionGeneration('session-a')).toBe(false);
  });

  it('releasing a claim lets the next claim proceed', () => {
    expect(tryClaimSessionGeneration(sessionId)).toBe(true);
    expect(tryClaimSessionGeneration(sessionId)).toBe(false);

    releaseSessionGeneration(sessionId);

    // After release the session is free again.
    expect(activeSessionGenerations.has(sessionId)).toBe(false);
    expect(tryClaimSessionGeneration(sessionId)).toBe(true);
  });

  it('releasing an unclaimed session is a no-op (idempotent)', () => {
    // Mirrors the finally-block contract: releasing is always safe.
    expect(() => releaseSessionGeneration('never-claimed')).not.toThrow();
    expect(activeSessionGenerations.has('never-claimed')).toBe(false);
  });
});

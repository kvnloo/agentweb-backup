/**
 * ENG-907 — unit tests for the whole-turn wall-clock budget helper.
 *
 * The agent loop already self-regulates against its STEP budget (maxIterations)
 * but had no equivalent for wall-clock time, so a long research turn ran until
 * the controller's hard cap guillotined it and the user got zero output. These
 * tests pin the phase ladder that lets the loop wrap up on its own instead.
 */

import { evaluateTurnTimeBudget, buildTurnTimeBudgetNudge } from '../turnTimeBudget';

const START = 1_000_000;
const CAP = START + 600_000; // 10-minute whole-turn cap

describe('evaluateTurnTimeBudget', () => {
  it('stays in the normal phase early in the turn', () => {
    const state = evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 60_000 });
    expect(state.phase).toBe('normal');
    expect(state.elapsedMs).toBe(60_000);
    expect(state.remainingMs).toBe(540_000);
  });

  it('falls back to the real clock when nowMs is not supplied', () => {
    // Production never passes nowMs — only the tests do. If the default were wrong the
    // budget would misread every real turn, so pin that the live path works.
    const now = Date.now();
    const state = evaluateTurnTimeBudget({ startedAtMs: now - 60_000, hardCapMs: now + 540_000 });
    expect(state.phase).toBe('normal');
    expect(state.elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(state.remainingMs).toBeGreaterThan(0);
    expect(state.remainingMs).toBeLessThanOrEqual(540_000);
  });

  it('enters wrap_up once the elapsed fraction crosses the threshold', () => {
    // 70% of 600s = 420s
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 419_000 }).phase)
      .toBe('normal');
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 420_000 }).phase)
      .toBe('wrap_up');
  });

  it('enters final_synthesis once less than the synthesis reserve remains', () => {
    // default reserve 90s -> fires at 510s elapsed
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 509_000 }).phase)
      .toBe('wrap_up');
    const state = evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 510_000 });
    expect(state.phase).toBe('final_synthesis');
    expect(state.reserveMs).toBe(90_000);
  });

  it('grows the reserve adaptively when a single LLM call is slower than the base reserve', () => {
    // A 160s call needs more than 90s of headroom for the synthesis turn.
    const state = evaluateTurnTimeBudget({
      startedAtMs: START,
      hardCapMs: CAP,
      nowMs: START + 400_000,
      longestLlmCallMs: 160_000,
    });
    expect(state.reserveMs).toBe(200_000); // 160s * 1.25
    expect(state.phase).toBe('final_synthesis'); // 200s remaining <= 200s reserve
  });

  it('never reserves more than half the budget, so a pathological call cannot force synthesis immediately', () => {
    const state = evaluateTurnTimeBudget({
      startedAtMs: START,
      hardCapMs: CAP,
      nowMs: START + 10_000,
      longestLlmCallMs: 590_000,
    });
    expect(state.reserveMs).toBe(300_000);
    expect(state.phase).toBe('normal');
  });

  it('reports final_synthesis when the cap has already passed', () => {
    const state = evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 700_000 });
    expect(state.phase).toBe('final_synthesis');
    expect(state.remainingMs).toBe(0);
  });

  it('is disabled (always normal) when the cap is missing or not after the start', () => {
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: NaN, nowMs: START + 999_999 }).phase)
      .toBe('normal');
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: START, nowMs: START + 10 }).phase)
      .toBe('normal');
    expect(evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: undefined as any, nowMs: START + 10 }).phase)
      .toBe('normal');
  });

  it('honours explicit overrides for the wrap-up fraction and the reserve', () => {
    const state = evaluateTurnTimeBudget({
      startedAtMs: START,
      hardCapMs: CAP,
      nowMs: START + 300_000,
      wrapUpFraction: 0.5,
      synthesisReserveMs: 60_000,
    });
    expect(state.phase).toBe('wrap_up');
    expect(state.reserveMs).toBe(60_000);
  });

  it('ignores a non-finite or negative reserve/fraction override and falls back to the defaults', () => {
    const state = evaluateTurnTimeBudget({
      startedAtMs: START,
      hardCapMs: CAP,
      nowMs: START + 420_000,
      wrapUpFraction: Number.NaN,
      synthesisReserveMs: -5,
      longestLlmCallMs: Number.NaN,
    });
    expect(state.reserveMs).toBe(90_000);
    expect(state.phase).toBe('wrap_up');
  });
});

describe('buildTurnTimeBudgetNudge', () => {
  const wrapUp = evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 420_000 });
  const final = evaluateTurnTimeBudget({ startedAtMs: START, hardCapMs: CAP, nowMs: START + 510_000 });

  it('tells the model to stop new discovery work in the wrap-up phase', () => {
    const msg = buildTurnTimeBudgetNudge(wrapUp, 'wrap_up');
    expect(msg).toMatch(/\[SYSTEM\]/);
    expect(msg).toMatch(/time/i);
    expect(msg).toMatch(/stop starting new/i);
    // Remaining seconds are surfaced so the model can size its remaining work.
    expect(msg).toContain('180');
  });

  it('forbids further tool calls and demands a partial deliverable in the final phase', () => {
    const msg = buildTurnTimeBudgetNudge(final, 'final_synthesis');
    expect(msg).toMatch(/\[SYSTEM WARNING\]/);
    expect(msg).toMatch(/do not call any (more|further) tools/i);
    // The whole point of ENG-907: deliver what exists, labelled as partial.
    expect(msg).toMatch(/partial/i);
    expect(msg).toMatch(/what you already have|gathered so far/i);
  });

  // ENG-1310 AC4: the wall-clock nudge used to tell the model to "write your final
  // answer NOW ... even if it is incomplete" with no distinction between a number the
  // model actually verified this session and one it is recalling/guessing under time
  // pressure — the exact shape that produced an unverified figure stated as current.
  // Both nudges now require the reply to be split into labeled verified/unverified
  // sections so a rushed answer is never presented as fully confirmed.
  it('requires a labeled verified/unverified split in the wrap-up nudge (ENG-1310 AC4)', () => {
    const msg = buildTurnTimeBudgetNudge(wrapUp, 'wrap_up');
    expect(msg).toMatch(/verified:/i);
    expect(msg).toMatch(/unverified\s*\/\s*not checked:/i);
    expect(msg).toMatch(/never state an item from the unverified section as if it were confirmed/i);
  });

  it('requires a labeled verified/unverified split in the final-synthesis nudge (ENG-1310 AC4)', () => {
    const msg = buildTurnTimeBudgetNudge(final, 'final_synthesis');
    expect(msg).toMatch(/verified:/i);
    expect(msg).toMatch(/unverified\s*\/\s*not checked:/i);
    expect(msg).toMatch(/never assert an item from the unverified section as fact/i);
    // Still forbids new tool calls and still surfaces the recovery instruction —
    // the split is additive, not a replacement for the existing ENG-907 behavior.
    expect(msg).toMatch(/do not call any (more|further) tools/i);
    expect(msg).toMatch(/reply "continue"/i);
  });
});

/**
 * Tests for the policy DSL parser + evaluator at backend/src/loops/core/policy/dsl.ts.
 */

import {
  ConditionParseError,
  applyOp,
  evaluate,
  evaluateParsed,
  parseCondition,
} from '../loops/core/policy/dsl';
import type { NormalizedEvent } from '../loops/core/types';
import { asSubjectId, asVariantId } from '../loops/core/types';

const T0 = new Date('2026-05-25T00:00:00Z');
const window = { start: new Date('2026-05-18T00:00:00Z'), end: new Date('2026-05-25T23:59:59Z') };

function mk(subject: string, type: string, offsetSeconds = 0): NormalizedEvent {
  return {
    subjectId: asSubjectId(subject),
    eventType: type,
    ts: new Date(T0.getTime() + offsetSeconds * 1000),
  };
}

// ---------------------------------------------------------------------------
// Parser — failure paths
// ---------------------------------------------------------------------------

describe('parseCondition — failure paths', () => {
  it('throws on empty string', () => {
    expect(() => parseCondition('')).toThrow(ConditionParseError);
  });

  it('throws on garbage input', () => {
    expect(() => parseCondition('not a real condition')).toThrow(ConditionParseError);
  });

  it('throws on unsupported operator', () => {
    expect(() => parseCondition('landed_count ~ 100')).toThrow(ConditionParseError);
  });

  it('throws when "over" suffix uses the wrong unit', () => {
    expect(() => parseCondition('landed_count < 100 over 7h')).toThrow(ConditionParseError);
  });
});

// ---------------------------------------------------------------------------
// Parser — happy paths
// ---------------------------------------------------------------------------

describe('parseCondition — count expressions', () => {
  it('parses a simple count threshold', () => {
    const parsed = parseCondition('landed_count < 100');
    expect(parsed).toEqual({
      kind: 'count',
      eventType: 'landed',
      op: '<',
      threshold: 100,
      windowDays: undefined,
    });
  });

  it('parses a count threshold with an "over Nd" suffix', () => {
    const parsed = parseCondition('eval_failed_count > 5 over 7d');
    expect(parsed).toEqual({
      kind: 'count',
      eventType: 'eval_failed',
      op: '>',
      threshold: 5,
      windowDays: 7,
    });
  });

  it('parses every operator', () => {
    expect(parseCondition('x_count < 1')).toMatchObject({ op: '<' });
    expect(parseCondition('x_count > 1')).toMatchObject({ op: '>' });
    expect(parseCondition('x_count <= 1')).toMatchObject({ op: '<=' });
    expect(parseCondition('x_count >= 1')).toMatchObject({ op: '>=' });
    expect(parseCondition('x_count = 0')).toMatchObject({ op: '=' });
    expect(parseCondition('x_count != 0')).toMatchObject({ op: '!=' });
  });

  it('parses zero-shortcut idiom', () => {
    const parsed = parseCondition('icp_match_count = 0');
    expect(parsed).toMatchObject({ kind: 'count', threshold: 0, op: '=' });
  });

  it('tolerates extra whitespace', () => {
    const parsed = parseCondition('   landed_count   <   100   ');
    expect(parsed).toMatchObject({ kind: 'count', threshold: 100 });
  });
});

describe('parseCondition — ratio expressions', () => {
  it('parses a ratio threshold', () => {
    const parsed = parseCondition('form_submitted_count / landed_count < 0.1');
    expect(parsed).toEqual({
      kind: 'ratio',
      numeratorType: 'form_submitted',
      denominatorType: 'landed',
      op: '<',
      threshold: 0.1,
      windowDays: undefined,
    });
  });

  it('parses a ratio threshold with "over Nd"', () => {
    const parsed = parseCondition('eval_failed_count / eval_started_count > 0.2 over 7d');
    expect(parsed).toMatchObject({ kind: 'ratio', threshold: 0.2, windowDays: 7 });
  });
});

describe('parseCondition — coincidence expressions', () => {
  it('parses A-but-no-B-within-Nh', () => {
    const parsed = parseCondition('signed_up but no onboarding_started within 24h');
    expect(parsed).toEqual({
      kind: 'coincidence',
      presentEventType: 'signed_up',
      absentEventType: 'onboarding_started',
      withinHours: 24,
    });
  });

  it('rejects malformed coincidence', () => {
    expect(() => parseCondition('signed_up but onboarding_started')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyOp — operator semantics
// ---------------------------------------------------------------------------

describe('applyOp', () => {
  it('< returns true when left < right', () => {
    expect(applyOp(1, '<', 2)).toBe(true);
    expect(applyOp(2, '<', 2)).toBe(false);
  });

  it('= returns true when strictly equal', () => {
    expect(applyOp(0, '=', 0)).toBe(true);
    expect(applyOp(0, '=', 1)).toBe(false);
  });

  it('!= returns true when not equal', () => {
    expect(applyOp(0, '!=', 1)).toBe(true);
    expect(applyOp(0, '!=', 0)).toBe(false);
  });

  it('handles all six operators correctly across boundary', () => {
    expect(applyOp(5, '<=', 5)).toBe(true);
    expect(applyOp(5, '>=', 5)).toBe(true);
    expect(applyOp(5, '<', 5)).toBe(false);
    expect(applyOp(5, '>', 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evaluator — count
// ---------------------------------------------------------------------------

describe('evaluate — count conditions', () => {
  it('fires when count is below threshold', () => {
    const events = [mk('u1', 'landed'), mk('u2', 'landed')];
    expect(evaluate('landed_count < 100', events, window)).toBe(true);
  });

  it('does not fire when count meets threshold', () => {
    const events = Array.from({ length: 100 }, (_, i) => mk(`u${i}`, 'landed'));
    expect(evaluate('landed_count < 100', events, window)).toBe(false);
  });

  it('zero shortcut fires when no events of that type exist', () => {
    const events = [mk('u1', 'landed')]; // no `icp_match` events
    expect(evaluate('icp_match_count = 0', events, window)).toBe(true);
  });

  it('zero shortcut does not fire when events exist', () => {
    const events = [mk('u1', 'icp_match'), mk('u2', 'landed')];
    expect(evaluate('icp_match_count = 0', events, window)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evaluator — ratio
// ---------------------------------------------------------------------------

describe('evaluate — ratio conditions', () => {
  it('fires when ratio is below threshold', () => {
    const events = [
      ...Array.from({ length: 100 }, (_, i) => mk(`u${i}`, 'landed')),
      ...Array.from({ length: 5 }, (_, i) => mk(`u${i}`, 'form_submitted')),
    ];
    // 5/100 = 0.05 < 0.1
    expect(evaluate('form_submitted_count / landed_count < 0.1', events, window)).toBe(true);
  });

  it('does not fire when ratio is above threshold', () => {
    const events = [
      ...Array.from({ length: 100 }, (_, i) => mk(`u${i}`, 'landed')),
      ...Array.from({ length: 20 }, (_, i) => mk(`u${i}`, 'form_submitted')),
    ];
    // 20/100 = 0.2 NOT < 0.1
    expect(evaluate('form_submitted_count / landed_count < 0.1', events, window)).toBe(false);
  });

  it('division by zero returns false (no signal — volume rule handles empty data separately)', () => {
    const events: NormalizedEvent[] = []; // no landed
    expect(evaluate('form_submitted_count / landed_count < 0.1', events, window)).toBe(false);
  });

  it('eval-failing rule: fires when ≥20% of started evals fail', () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => mk(`u${i}`, 'eval_started')),
      ...Array.from({ length: 3 }, (_, i) => mk(`u${i}`, 'eval_failed')),
    ];
    // 3/10 = 0.3 > 0.2
    expect(evaluate('eval_failed_count / eval_started_count > 0.2', events, window)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evaluator — coincidence
// ---------------------------------------------------------------------------

describe('evaluate — coincidence conditions', () => {
  it('fires when a subject has the present event but not the absent within window', () => {
    const events = [mk('u1', 'signed_up', 0)];
    // u1 signed up but never started onboarding -> coincidence fires.
    expect(evaluate('signed_up but no onboarding_started within 24h', events, window)).toBe(true);
  });

  it('does not fire when the absent event occurs within the window', () => {
    const events = [
      mk('u1', 'signed_up', 0),
      mk('u1', 'onboarding_started', 60), // 60s later, well within 24h
    ];
    expect(evaluate('signed_up but no onboarding_started within 24h', events, window)).toBe(false);
  });

  it('fires when the absent event occurs but OUTSIDE the window', () => {
    const events = [
      mk('u1', 'signed_up', 0),
      // 25 hours later -> outside 24h window
      mk('u1', 'onboarding_started', 25 * 60 * 60),
    ];
    expect(evaluate('signed_up but no onboarding_started within 24h', events, window)).toBe(true);
  });

  it('handles multiple subjects independently', () => {
    const events = [
      mk('u1', 'signed_up', 0),
      mk('u1', 'onboarding_started', 60), // u1 OK
      mk('u2', 'signed_up', 0),
      // u2 never starts onboarding
    ];
    // u2 has the coincidence -> rule fires.
    expect(evaluate('signed_up but no onboarding_started within 24h', events, window)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Smoke-spec-aligned tests — the 3 personas
// ---------------------------------------------------------------------------

describe('evaluate — personas from ACCEPTANCE_SPEC.md', () => {
  it('early-dipper population fires capture-broken rule', () => {
    // 3 early-dippers (landed only) + 1 completer
    const events: NormalizedEvent[] = [
      mk('dipper1', 'landed'),
      mk('dipper2', 'landed'),
      mk('dipper3', 'landed'),
      mk('completer1', 'landed'),
      mk('completer1', 'form_submitted'),
    ];
    // 1 form_submit / 4 landed = 0.25, > 0.1 — so the ratio rule does NOT fire.
    expect(evaluate('form_submitted_count / landed_count < 0.1', events, window)).toBe(false);

    // With more dippers, ratio drops below 0.1.
    const more: NormalizedEvent[] = [
      ...Array.from({ length: 20 }, (_, i) => mk(`dipper${i}`, 'landed')),
      mk('completer1', 'landed'),
      mk('completer1', 'form_submitted'),
    ];
    // 1/21 ≈ 0.048 < 0.1 — fires.
    expect(evaluate('form_submitted_count / landed_count < 0.1', more, window)).toBe(true);
  });

  it('completer-only population fires no friction rules', () => {
    const events: NormalizedEvent[] = [
      mk('c1', 'landed'),
      mk('c1', 'form_submitted'),
      mk('c1', 'eval_started'),
      mk('c1', 'eval_completed'),
      mk('c1', 'signed_up'),
      mk('c1', 'onboarding_started', 60),
    ];
    expect(evaluate('form_submitted_count / landed_count < 0.1', events, window)).toBe(false);
    expect(evaluate('eval_failed_count / eval_started_count > 0.2', events, window)).toBe(false);
    expect(evaluate('signed_up but no onboarding_started within 24h', events, window)).toBe(false);
  });

  it('complainer/timeout population fires eval-failing rule', () => {
    const events: NormalizedEvent[] = [
      ...Array.from({ length: 10 }, (_, i) => mk(`u${i}`, 'eval_started')),
      ...Array.from({ length: 4 }, (_, i) => mk(`u${i}`, 'eval_failed', i * 60)),
    ];
    // 4/10 = 0.4 > 0.2 -> fires.
    expect(evaluate('eval_failed_count / eval_started_count > 0.2', events, window)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateParsed is callable when caller has the AST cached
// ---------------------------------------------------------------------------

describe('evaluateParsed', () => {
  it('round-trips against the same condition as evaluate()', () => {
    const events = [mk('u1', 'landed')];
    const parsed = parseCondition('landed_count > 0');
    expect(evaluateParsed(parsed, events, window)).toBe(true);
    expect(evaluate('landed_count > 0', events, window)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dimension filters — `_count[key=value]`
//
// Fixes the capture-broken false alarm: <LandedTracker/> fires `landed` on
// every frontend page (each tagged with dimensions.landerPath), so comparing
// /ai-eval-only submits against site-wide landings is meaningless. The filter
// lets a rule count only the events it means to.
// ---------------------------------------------------------------------------

describe('dimension filters', () => {
  function mkd(subject: string, type: string, dims?: NormalizedEvent['dimensions']): NormalizedEvent {
    return {
      subjectId: asSubjectId(subject),
      eventType: type,
      ts: T0,
      ...(dims ? { dimensions: dims } : {}),
    };
  }

  it('parses a count with a dimension filter (value may contain "/")', () => {
    expect(parseCondition('landed_count[landerPath=/ai-eval] < 100')).toEqual({
      kind: 'count',
      eventType: 'landed',
      filter: { dimensionKey: 'landerPath', dimensionValue: '/ai-eval' },
      op: '<',
      threshold: 100,
      windowDays: undefined,
    });
  });

  it('parses a ratio with a denominator filter only', () => {
    expect(
      parseCondition('eval_started_count / landed_count[landerPath=/ai-eval] < 0.1 over 7d'),
    ).toEqual({
      kind: 'ratio',
      numeratorType: 'eval_started',
      denominatorType: 'landed',
      denominatorFilter: { dimensionKey: 'landerPath', dimensionValue: '/ai-eval' },
      op: '<',
      threshold: 0.1,
      windowDays: 7,
    });
  });

  it('count filter only counts events whose dimension matches', () => {
    const events = [
      mkd('u1', 'landed', { landerPath: '/ai-eval' }),
      mkd('u2', 'landed', { landerPath: '/' }),
      mkd('u3', 'landed', { landerPath: '/blog' }),
      mkd('u4', 'landed'), // no landerPath dimension → excluded
    ];
    // Unscoped sees all 4; scoped sees only the /ai-eval one.
    expect(evaluate('landed_count >= 4', events, window)).toBe(true);
    expect(evaluate('landed_count[landerPath=/ai-eval] >= 4', events, window)).toBe(false);
    expect(evaluate('landed_count[landerPath=/ai-eval] = 1', events, window)).toBe(true);
  });

  it('capture-broken: scoping the denominator to /ai-eval flips a false alarm to healthy', () => {
    // 30 site-wide landings (only 3 on /ai-eval) + 2 server-confirmed eval starts.
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < 3; i++) events.push(mkd(`a${i}`, 'landed', { landerPath: '/ai-eval' }));
    for (let i = 0; i < 27; i++) events.push(mkd(`b${i}`, 'landed', { landerPath: '/blog' }));
    for (let i = 0; i < 2; i++) events.push(mkd(`e${i}`, 'eval_started'));

    // Old (broken) rule: 2 / 30 = 0.067 < 0.1 → FALSE alarm fires.
    expect(evaluate('eval_started_count / landed_count < 0.1', events, window)).toBe(true);
    // Fixed rule: 2 / 3 = 0.67, NOT < 0.1 → does not fire. Capture is fine; the
    // real story is just low /ai-eval volume (a top-of-funnel problem).
    expect(
      evaluate('eval_started_count / landed_count[landerPath=/ai-eval] < 0.1', events, window),
    ).toBe(false);
  });
});

// Ensure asVariantId import isn't dead.
void asVariantId;

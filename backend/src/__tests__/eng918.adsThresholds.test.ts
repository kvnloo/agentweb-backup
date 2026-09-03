/**
 * ENG-918 — per-account ads-threshold store rules.
 *
 * These cover the guarantees that are expensive to get wrong: the source-precedence rule, the
 * movement cap, absolute bounds, the sample-size gate, the post-revert cooldown, and the revision
 * cap. Every assertion here was red-checked (the behaviour was broken deliberately and the test
 * watched to fail) — a test that has never failed is not evidence it can.
 */

import {
  LEARNED_COOLDOWN_DAYS,
  THRESHOLD_REGISTRY,
  REVISION_HISTORY_LIMIT,
  applyThresholdWrite,
  buildThresholdEntityKey,
  buildThresholdRevert,
  evaluateThresholdWrite,
  parseThresholdEntityKey,
  resolveThresholds,
  type AdsThreshold,
} from '../services/adsThresholds';

const FREQ = 'creativeFatigue.frequencyCritical'; // default 3.5, cap 20%, min 1.5, max 8
const CTR = 'creativeFatigue.ctrDropCriticalPct'; // default 20, cap 25%, min 5, max 60

function param(overrides: Partial<AdsThreshold> = {}): AdsThreshold {
  return {
    accountId: '1842363582956923',
    platform: 'meta',
    paramKey: FREQ,
    currentValue: 3.5,
    defaultValue: 3.5,
    source: 'default',
    updatedAt: '2026-09-01T00:00:00.000Z',
    learnedCooldownUntil: null,
    revisions: [],
    ...overrides,
  };
}

describe('source precedence', () => {
  it('refuses a learned write over a human-set value', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.6,
      source: 'learned',
      sampleSize: 500,
      existing: param({ currentValue: 3.0, source: 'user' }),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('learned_would_override_user');
  });

  it('allows a user write over a learned value — a human correcting a machine', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.0,
      source: 'user',
      existing: param({ currentValue: 3.9, source: 'learned' }),
    });

    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.value).toBe(3.0);
  });

  it('allows a learned write when the standing value is only a default', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.7,
      source: 'learned',
      sampleSize: 500,
      existing: param({ currentValue: 3.5, source: 'default' }),
    });

    expect(verdict.allowed).toBe(true);
  });
});

describe('movement cap', () => {
  it('clamps a learned write to the per-cycle maximum step', () => {
    // current 3.5, cap 20% -> largest allowed step is 0.7, so 6.0 lands at 4.2
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 6.0,
      source: 'learned',
      sampleSize: 500,
      existing: param({ currentValue: 3.5, source: 'default' }),
    });

    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.value).toBeCloseTo(4.2, 10);
      expect(verdict.requestedValue).toBe(6.0);
      expect(verdict.clampedBy).toBe('movementCap');
    }
  });

  it('clamps downward moves symmetrically', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 1.0,
      source: 'learned',
      sampleSize: 500,
      existing: param({ currentValue: 3.5, source: 'default' }),
    });

    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.value).toBeCloseTo(2.8, 10);
  });

  it('does NOT clamp a user write inside bounds — a human typing a value is not the mistake the cap guards', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 7.5,
      source: 'user',
      existing: param({ currentValue: 3.5, source: 'default' }),
    });

    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.value).toBe(7.5);
      expect(verdict.clampedBy).toBeNull();
    }
  });
});

describe('bounds — refuse a human, clamp a machine', () => {
  it('REFUSES a user write outside bounds rather than silently storing a different number', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 50,
      source: 'user',
      existing: param({ currentValue: 3.5 }),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('out_of_bounds');
  });

  it('refuses an out-of-bounds user write at the low end too', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 0.1,
      source: 'user',
      existing: param({ currentValue: 3.5 }),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('out_of_bounds');
  });

  it('clamps rather than refuses a learned write, since a fit is a proposal not an assertion', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 100,
      source: 'learned',
      sampleSize: 500,
      existing: param({ currentValue: 7.9, source: 'default' }),
    });

    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.value).toBe(THRESHOLD_REGISTRY[FREQ].max);
  });

  it('stops a capped learned value walking past the floor over repeated cycles', () => {
    // Each step is individually legal; bounds are what stop the destination.
    let current = param({ currentValue: 3.5, source: 'default' });
    for (let i = 0; i < 40; i++) {
      const verdict = evaluateThresholdWrite({
        paramKey: FREQ,
        requestedValue: 0,
        source: 'learned',
        sampleSize: 500,
        existing: current,
      });
      if (!verdict.allowed) break;
      current = param({ currentValue: verdict.value, source: 'learned' });
    }

    expect(current.currentValue).toBe(THRESHOLD_REGISTRY[FREQ].min);
  });
});

describe('sample-size gate', () => {
  it('refuses a learned write below the minimum sample size', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.6,
      source: 'learned',
      sampleSize: 5,
      existing: param(),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('insufficient_sample');
  });

  it('treats a missing sample size on a learned write as zero, not as unbounded', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.6,
      source: 'learned',
      existing: param(),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('insufficient_sample');
  });

  it('does not gate a user write on sample size', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.0,
      source: 'user',
      existing: param(),
    });

    expect(verdict.allowed).toBe(true);
  });
});

describe('post-revert cooldown', () => {
  const reverted = () =>
    buildThresholdRevert({
      existing: param({ currentValue: 3.0, source: 'user' }),
      changedBy: 'user-1',
      changedAt: '2026-09-03T00:00:00.000Z',
    });

  it('refuses a learned write inside the cooldown window', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.7,
      source: 'learned',
      sampleSize: 500,
      existing: reverted(),
      at: new Date('2026-09-20T00:00:00.000Z'),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('revert_cooldown');
  });

  it('allows a learned write once the cooldown has elapsed', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.7,
      source: 'learned',
      sampleSize: 500,
      existing: reverted(),
      at: new Date(`2026-10-05T00:00:00.000Z`),
    });

    expect(verdict.allowed).toBe(true);
  });

  it('sets the cooldown LEARNED_COOLDOWN_DAYS out from the revert', () => {
    const until = Date.parse(String(reverted().learnedCooldownUntil));
    const expected = Date.parse('2026-09-03T00:00:00.000Z') + LEARNED_COOLDOWN_DAYS * 86_400_000;
    expect(until).toBe(expected);
  });

  it('does not block a HUMAN write during the cooldown — it only pauses machine writes', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.2,
      source: 'user',
      existing: reverted(),
      at: new Date('2026-09-05T00:00:00.000Z'),
    });

    expect(verdict.allowed).toBe(true);
  });

  it('fails CLOSED on an unparseable cooldown stamp', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.7,
      source: 'learned',
      sampleSize: 500,
      existing: param({ learnedCooldownUntil: 'not-a-date' }),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('revert_cooldown');
  });

  it('clears the cooldown when a human writes, since that supersedes the revert', () => {
    const written = applyThresholdWrite({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: FREQ,
      value: 3.2,
      source: 'user',
      evidence: 'set deliberately after reverting',
      changedBy: 'user-1',
      changedAt: '2026-09-05T00:00:00.000Z',
      existing: reverted(),
    });

    expect(written.learnedCooldownUntil).toBeNull();
  });

  it('clears the spent stamp when a learned write lands after the cooldown, rather than carrying a dead field', () => {
    const written = applyThresholdWrite({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: FREQ,
      value: 3.7,
      source: 'learned',
      evidence: 'refit once the cooldown elapsed',
      sampleSize: 500,
      changedBy: 'loop:meta-ads',
      changedAt: '2026-11-01T00:00:00.000Z',
      existing: reverted(),
    });

    expect(written.learnedCooldownUntil).toBeNull();
  });
});

describe('refusals', () => {
  it('refuses an unknown parameter', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: 'nope.notAThing',
      requestedValue: 1,
      source: 'user',
      existing: null,
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('unknown_parameter');
  });

  it.each([NaN, Infinity, -Infinity])('refuses the non-finite value %p', value => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: value,
      source: 'user',
      existing: param(),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('not_finite');
  });

  it('refuses a write that resolves to the value already stored', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.5,
      source: 'user',
      existing: param({ currentValue: 3.5 }),
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('no_change');
  });

  it('falls back to the registry default as the baseline when nothing is stored', () => {
    const verdict = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: THRESHOLD_REGISTRY[FREQ].defaultValue,
      source: 'user',
      existing: null,
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('no_change');
  });
});

describe('revisions', () => {
  it('records provenance on the written revision', () => {
    const written = applyThresholdWrite({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: FREQ,
      value: 3.9,
      source: 'learned',
      evidence: 'fitted over 59d of Haven delivery',
      sampleSize: 412,
      changedBy: 'loop:meta-ads',
      changedAt: '2026-09-03T10:00:00.000Z',
      existing: param({ currentValue: 3.5 }),
    });

    expect(written.currentValue).toBe(3.9);
    expect(written.source).toBe('learned');
    expect(written.revisions[0]).toMatchObject({
      value: 3.9,
      previousValue: 3.5,
      source: 'learned',
      sampleSize: 412,
      changedBy: 'loop:meta-ads',
    });
  });

  it('does not attach a sample size to a user write', () => {
    const written = applyThresholdWrite({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: FREQ,
      value: 3.0,
      source: 'user',
      evidence: 'set in the portal',
      sampleSize: 999,
      changedBy: 'user-1',
      changedAt: '2026-09-03T10:00:00.000Z',
      existing: param(),
    });

    expect(written.revisions[0].sampleSize).toBeNull();
  });

  it('caps history and keeps the newest entries', () => {
    let current = param({ currentValue: 3.5 });
    for (let i = 0; i < REVISION_HISTORY_LIMIT + 12; i++) {
      current = applyThresholdWrite({
        accountId: '1842363582956923',
        platform: 'meta',
        paramKey: FREQ,
        value: 3.5 + (i + 1) / 100,
        source: 'user',
        evidence: `edit ${i}`,
        changedBy: 'user-1',
        changedAt: `2026-09-03T10:${String(i).padStart(2, '0')}:00.000Z`,
        existing: current,
      });
    }

    expect(current.revisions).toHaveLength(REVISION_HISTORY_LIMIT);
    expect(current.revisions[0].evidence).toBe(`edit ${REVISION_HISTORY_LIMIT + 11}`);
  });

  it('carries a null previousValue on the first write', () => {
    const written = applyThresholdWrite({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: FREQ,
      value: 3.0,
      source: 'user',
      evidence: 'first',
      changedBy: 'user-1',
      changedAt: '2026-09-03T10:00:00.000Z',
      existing: null,
    });

    expect(written.revisions[0].previousValue).toBeNull();
  });
});

describe('revert', () => {
  it('restores from the REGISTRY, not from a stale stored default', () => {
    // Written when the default was 9.9; the registry has since moved to 3.5.
    const stale = param({ currentValue: 6.0, defaultValue: 9.9, source: 'user' });

    const reverted = buildThresholdRevert({
      existing: stale,
      changedBy: 'user-1',
      changedAt: '2026-09-03T10:00:00.000Z',
    });

    expect(reverted.currentValue).toBe(THRESHOLD_REGISTRY[FREQ].defaultValue);
    expect(reverted.currentValue).not.toBe(9.9);
    // The denormalised copy is refreshed too, so the item stops carrying the stale number.
    expect(reverted.defaultValue).toBe(THRESHOLD_REGISTRY[FREQ].defaultValue);
  });

  it('preserves history and re-opens the parameter to learned writes after the cooldown', () => {
    const existing = param({
      currentValue: 3.0,
      source: 'user',
      revisions: [
        {
          value: 3.0,
          previousValue: 3.5,
          source: 'user',
          evidence: 'human override',
          sampleSize: null,
          changedAt: '2026-09-02T00:00:00.000Z',
          changedBy: 'user-1',
        },
      ],
    });

    const reverted = buildThresholdRevert({
      existing,
      changedBy: 'user-1',
      changedAt: '2026-09-03T10:00:00.000Z',
    });

    // 'default', not 'user' — a revert withdraws an override rather than asserting a new one.
    expect(reverted.source).toBe('default');
    expect(reverted.revisions).toHaveLength(2);
    expect(reverted.revisions[1].evidence).toBe('human override');

    const afterCooldown = evaluateThresholdWrite({
      paramKey: FREQ,
      requestedValue: 3.7,
      source: 'learned',
      sampleSize: 500,
      existing: reverted,
      at: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(afterCooldown.allowed).toBe(true);
  });
});

describe('entity keys', () => {
  it('round-trips platform and account id', () => {
    const key = buildThresholdEntityKey('meta', '1842363582956923');
    expect(key).toBe('meta#1842363582956923');
    expect(parseThresholdEntityKey(key)).toEqual({
      platform: 'meta',
      accountId: '1842363582956923',
    });
  });

  it('splits on the FIRST separator so an account id containing # is not truncated', () => {
    const parsed = parseThresholdEntityKey('meta#odd#account');
    expect(parsed).toEqual({ platform: 'meta', accountId: 'odd#account' });
  });

  it.each(['', 'meta', '#orphan', 'meta#'])('rejects the malformed entity key %p', key => {
    expect(parseThresholdEntityKey(key)).toBeNull();
  });

  it('keeps a Meta account id from colliding with an identical Google customer id', () => {
    expect(buildThresholdEntityKey('meta', '2883029950')).not.toBe(
      buildThresholdEntityKey('google_ads', '2883029950'),
    );
  });
});

describe('resolveThresholds', () => {
  it('returns every registry parameter, filling unset ones from defaults', () => {
    const resolved = resolveThresholds([
      param({ paramKey: FREQ, currentValue: 3.0, source: 'user' }),
    ]);

    expect(resolved[FREQ]).toEqual({ value: 3.0, source: 'user' });
    expect(resolved[CTR]).toEqual({
      value: THRESHOLD_REGISTRY[CTR].defaultValue,
      source: 'default',
    });
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(THRESHOLD_REGISTRY).sort());
  });

  it('returns a full set of defaults for an account that has never set anything', () => {
    const resolved = resolveThresholds([]);
    expect(Object.keys(resolved)).toHaveLength(Object.keys(THRESHOLD_REGISTRY).length);
    expect(Object.values(resolved).every(r => r.source === 'default')).toBe(true);
  });
});

import {
  buildOutcomeEntityKey,
  parseOutcomeEntityKey,
  createRecommendation,
  scoreRecommendation,
  applyScore,
  getSettlingWindowDays,
  type Recommendation,
} from '../services/outcomeLedger';

const baseInput = {
  accountId: '1842363582956923',
  platform: 'meta' as const,
  recommendationId: 'rec_1',
  hypothesis: 'Raising frequency cap will reduce fatigue-driven CTR decay',
  predictedMetric: 'ctr',
  predictedDirection: 'increase' as const,
  predictedMagnitudePct: 10,
  evaluationDate: '2026-01-01',
  createdAt: '2025-12-01T00:00:00.000Z',
  createdBy: 'agent',
};

describe('buildOutcomeEntityKey / parseOutcomeEntityKey', () => {
  it('round-trips platform and accountId', () => {
    const key = buildOutcomeEntityKey('google_ads', 'acct-9');
    expect(key).toBe('google_ads#acct-9');
    expect(parseOutcomeEntityKey(key)).toEqual({ platform: 'google_ads', accountId: 'acct-9' });
  });

  it('rejects an unrecognised platform', () => {
    expect(parseOutcomeEntityKey('tiktok#acct-1')).toBeNull();
  });

  it('rejects a key with no separator', () => {
    expect(parseOutcomeEntityKey('meta-acct-1')).toBeNull();
  });

  it('rejects a key with an empty accountId', () => {
    expect(parseOutcomeEntityKey('meta#')).toBeNull();
  });
});

describe('getSettlingWindowDays', () => {
  it('returns 28 for meta and 90 for google_ads', () => {
    expect(getSettlingWindowDays('meta')).toBe(28);
    expect(getSettlingWindowDays('google_ads')).toBe(90);
  });
});

describe('createRecommendation', () => {
  it('builds a pending recommendation with null scoring fields', () => {
    const rec = createRecommendation(baseInput);
    expect(rec.status).toBe('pending');
    expect(rec.adopted).toBeNull();
    expect(rec.verdict).toBeNull();
    expect(rec.scoredAt).toBeNull();
  });

  it('throws on an empty hypothesis', () => {
    expect(() => createRecommendation({ ...baseInput, hypothesis: '   ' })).toThrow(/hypothesis/);
  });

  it('throws the clean validation message, not a raw TypeError, when hypothesis is entirely absent', () => {
    // Live-tested against a real admin request missing the field entirely (not an empty string):
    // `undefined.trim()` threw "Cannot read properties of undefined (reading 'trim')" instead of
    // this message, before the falsy-check could run.
    const { hypothesis, ...rest } = baseInput;
    expect(() => createRecommendation(rest as any)).toThrow(/hypothesis must not be empty/);
  });

  it('throws on a negative predictedMagnitudePct', () => {
    expect(() => createRecommendation({ ...baseInput, predictedMagnitudePct: -1 })).toThrow(/predictedMagnitudePct/);
  });

  it('throws on a non-finite predictedMagnitudePct', () => {
    expect(() => createRecommendation({ ...baseInput, predictedMagnitudePct: NaN })).toThrow(/predictedMagnitudePct/);
  });

  it('throws on an empty predictedMetric', () => {
    expect(() => createRecommendation({ ...baseInput, predictedMetric: '' })).toThrow(/predictedMetric/);
  });

  it.each(['sideways', '', 'INCREASE'])(
    'throws on an invalid predictedDirection %p',
    badDirection => {
      expect(() => createRecommendation({ ...baseInput, predictedDirection: badDirection as any })).toThrow(/predictedDirection/);
    },
  );

  it.each(['not-a-date', '', 'February 30th'])(
    'throws on an unparseable evaluationDate %p — a bad date must not silently bypass the settling-window guard',
    badDate => {
      expect(() => createRecommendation({ ...baseInput, evaluationDate: badDate })).toThrow(/evaluationDate/);
    },
  );

  it('accepts a plain YYYY-MM-DD evaluationDate', () => {
    expect(() => createRecommendation({ ...baseInput, evaluationDate: '2026-03-15' })).not.toThrow();
  });
});

describe('scoreRecommendation', () => {
  const pending: Recommendation = createRecommendation(baseInput);

  it('is unscoreable before the settling window elapses (27 days, meta)', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-01-28T00:00:00.000Z', // 27 days after evaluationDate
      adopted: true,
      actualValue: 5,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.verdictReason).toMatch(/settling window/);
  });

  it('is scoreable exactly at the settling window boundary (28 days, meta)', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-01-29T00:00:00.000Z', // 28 days after evaluationDate
      adopted: true,
      actualValue: 5,
      baselineValue: 4,
    });
    expect(result.verdict).not.toBe('unscoreable');
  });

  it('is unscoreable when not adopted, even past the settling window', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: false,
      actualValue: 5,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.verdictReason).toMatch(/not adopted/);
  });

  it('is unscoreable when actualValue is null (no data)', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: null,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.verdictReason).toMatch(/unavailable/);
  });

  it('is unscoreable when baselineValue is zero (percentage undefined)', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 5,
      baselineValue: 0,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.verdictReason).toMatch(/zero/);
  });

  it('is unscoreable, not silently misclassified as decrease, when actualValue is NaN', () => {
    // A direct (non-HTTP) caller could pass NaN even though JSON can't carry it over the route —
    // without this guard, NaN fails both `> 0` comparisons and falls through to 'decrease', a
    // wrong verdict rather than an obviously-failed one.
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: NaN,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.actualDirection).toBeNull();
  });

  it('is unscoreable, not a spurious increase, when actualValue is Infinity', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: Infinity,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.actualMagnitudePct).toBeNull();
  });

  it('is unscoreable when baselineValue is NaN', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 5,
      baselineValue: NaN,
    });
    expect(result.verdict).toBe('unscoreable');
  });

  it('is unscoreable and reports flat when the change is within the flat band', () => {
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 4.003,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('unscoreable');
    expect(result.actualDirection).toBe('flat');
  });

  it('is correct when actual direction matches predicted direction (increase)', () => {
    const result = scoreRecommendation({
      recommendation: pending, // predicts increase
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 5,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('correct');
    expect(result.actualDirection).toBe('increase');
    expect(result.actualMagnitudePct).toBeCloseTo(25, 5);
  });

  it('is incorrect when actual direction opposes predicted direction', () => {
    const result = scoreRecommendation({
      recommendation: pending, // predicts increase
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 3,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('incorrect');
    expect(result.actualDirection).toBe('decrease');
  });

  it('scores on direction alone, ignoring how far actual magnitude is from predicted magnitude', () => {
    // predicted +10%, actual +200% — direction matches, so still correct despite the huge gap.
    const result = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 12,
      baselineValue: 4,
    });
    expect(result.verdict).toBe('correct');
  });

  it('throws for a platform with no settling window defined', () => {
    const badRec = { ...pending, platform: 'linkedin_ads' as any };
    expect(() =>
      scoreRecommendation({
        recommendation: badRec,
        now: '2026-06-01T00:00:00.000Z',
        adopted: true,
        actualValue: 5,
        baselineValue: 4,
      }),
    ).toThrow(/no settling window/);
  });
});

describe('applyScore', () => {
  it('transitions a pending recommendation to scored with the score fields applied', () => {
    const pending = createRecommendation(baseInput);
    const score = scoreRecommendation({
      recommendation: pending,
      now: '2026-06-01T00:00:00.000Z',
      adopted: true,
      actualValue: 5,
      baselineValue: 4,
    });
    const scored = applyScore(pending, score);
    expect(scored.status).toBe('scored');
    expect(scored.verdict).toBe('correct');
    expect(scored.adopted).toBe(true);
    expect(scored.scoredAt).toBe('2026-06-01T00:00:00.000Z');
    // original untouched
    expect(pending.status).toBe('pending');
  });
});

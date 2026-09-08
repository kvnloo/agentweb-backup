/**
 * ENG-1550 — storage-layer conversion rules.
 *
 * `itemToRecommendation` is pure (no AWS calls inside it), so it's tested directly rather than
 * through `getRecommendation`/`getRecommendationsForAccount`, which would need the whole
 * DynamoDB client mocked to exercise the same branch. Mirrors `eng918.adsThresholdsDb.test.ts`'s
 * shape — this file's own review round flagged its absence as a real gap: `itemToRecommendation`
 * had zero direct coverage, only exercised indirectly through route tests that mock this module
 * entirely, so none of its corruption guards were actually being run anywhere.
 */

import { itemToRecommendation } from '../services/outcomeLedgerDb';

function item(overrides: Record<string, unknown> = {}) {
  return {
    entityKey: 'meta#1842363582956923',
    recommendationId: 'rec_1',
    hypothesis: 'Raising frequency cap will reduce fatigue-driven CTR decay',
    predictedMetric: 'ctr',
    predictedDirection: 'increase',
    predictedMagnitudePct: 10,
    evaluationDate: '2026-01-01',
    createdAt: '2025-12-01T00:00:00.000Z',
    createdBy: 'agent',
    status: 'pending',
    ...overrides,
  };
}

describe('itemToRecommendation — corrupted data fails loud, not silently', () => {
  it('converts a well-formed pending item', () => {
    const parsed = itemToRecommendation(item());
    expect(parsed).toMatchObject({
      accountId: '1842363582956923',
      platform: 'meta',
      recommendationId: 'rec_1',
      predictedDirection: 'increase',
      predictedMagnitudePct: 10,
      status: 'pending',
      adopted: null,
      verdict: null,
    });
  });

  it('converts a well-formed scored item', () => {
    const parsed = itemToRecommendation(
      item({
        status: 'scored',
        adopted: true,
        scoredAt: '2026-02-01T00:00:00.000Z',
        actualDirection: 'increase',
        actualMagnitudePct: 25,
        verdict: 'correct',
      }),
    );
    expect(parsed).toMatchObject({
      status: 'scored',
      adopted: true,
      actualDirection: 'increase',
      actualMagnitudePct: 25,
      verdict: 'correct',
    });
  });

  it('returns null for an unparseable entity key rather than throwing', () => {
    expect(itemToRecommendation(item({ entityKey: 'malformed-no-separator' }))).toBeNull();
  });

  it.each(['sideways', '', undefined, null, 'INCREASE'])(
    'throws for the invalid predictedDirection %p rather than casting it silently',
    badDirection => {
      // A recommendation that never wrote-side-validated direction should not sail through the
      // read layer either — this is the one place every reader passes through.
      expect(() => itemToRecommendation(item({ predictedDirection: badDirection }))).toThrow(/predictedDirection/);
    },
  );

  it.each([undefined, 'not-a-number', {}, null])(
    'throws rather than silently producing NaN when predictedMagnitudePct is %p',
    badValue => {
      expect(() => itemToRecommendation(item({ predictedMagnitudePct: badValue }))).toThrow(/non-finite/);
    },
  );

  it('throws for an invalid status', () => {
    expect(() => itemToRecommendation(item({ status: 'archived' }))).toThrow(/status/);
  });

  it('throws for an invalid actualDirection when present', () => {
    expect(() =>
      itemToRecommendation(item({ status: 'scored', actualDirection: 'sideways' })),
    ).toThrow(/actualDirection/);
  });

  it('allows a null/absent actualDirection on a pending item', () => {
    expect(() => itemToRecommendation(item())).not.toThrow();
  });

  it('throws for an invalid verdict when present', () => {
    expect(() => itemToRecommendation(item({ status: 'scored', verdict: 'maybe' }))).toThrow(/verdict/);
  });

  it.each(['not-a-number', {}])(
    'throws rather than silently producing NaN when actualMagnitudePct is %p',
    badValue => {
      expect(() =>
        itemToRecommendation(item({ status: 'scored', actualMagnitudePct: badValue })),
      ).toThrow(/non-finite/);
    },
  );

  it('throws for a non-finite actualMagnitudePct (Infinity)', () => {
    // Confirms the score route's own Number.isFinite guard has a matching guard here too — a
    // caller that bypassed the route (or a future writer) should not be able to write an
    // unreadable record.
    expect(() =>
      itemToRecommendation(item({ status: 'scored', actualMagnitudePct: Infinity })),
    ).toThrow(/non-finite/);
  });

  it('allows a null actualMagnitudePct (not yet scored, or genuinely unscoreable)', () => {
    expect(itemToRecommendation(item({ status: 'scored', actualMagnitudePct: null }))?.actualMagnitudePct).toBeNull();
  });
});

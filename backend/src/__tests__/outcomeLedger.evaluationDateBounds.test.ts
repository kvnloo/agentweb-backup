/**
 * ENG-1550 — a recommendation may not be dated into the past.
 *
 * THE BUG. `createRecommendation` validated only that `evaluationDate` PARSES, never that it sits
 * after `createdAt`. `scoreRecommendation` then treats a row as settled once
 * `now >= evaluationDate + windowDays`, so a recommendation created today with
 * `evaluationDate: '2020-01-01'` is born already past its settling window and can be scored
 * immediately — returning a real `correct`/`wrong` verdict about a period that ended before the
 * prediction was ever made.
 *
 * WHY THAT MATTERS MORE THAN A NORMAL VALIDATION GAP. This store exists to be a falsifiable track
 * record of whether the agent's advice works. Accepting a backdated evaluation date permits
 * retroactive prediction: recording "predictions" whose outcomes are already known and having them
 * score as correct. That does not merely produce one bad row — it makes the aggregate record
 * untrustworthy, which is the single property the ledger exists to provide.
 *
 * Reachable today through the admin REST route (`POST /api/outcome-ledger/:platform/:accountId`),
 * independent of any one caller.
 */

import { createRecommendation, scoreRecommendation } from '../services/outcomeLedger';

const BASE = {
  accountId: '1234567890',
  platform: 'meta' as const,
  recommendationId: 'rec-1',
  hypothesis: 'Pause the two lowest-CTR ad sets.',
  predictedMetric: 'cost_per_lead',
  predictedDirection: 'increase' as const,
  predictedMagnitudePct: 10,
  createdBy: 'user-1',
};

const CREATED_AT = '2026-09-16T10:00:00.000Z';

describe('ENG-1550 evaluationDate bounds', () => {
  it('rejects an evaluationDate before createdAt', () => {
    expect(() =>
      createRecommendation({ ...BASE, createdAt: CREATED_AT, evaluationDate: '2020-01-01T00:00:00.000Z' })
    ).toThrow(/evaluationDate/i);
  });

  it('rejects a backdated evaluationDate even by a single day', () => {
    expect(() =>
      createRecommendation({ ...BASE, createdAt: CREATED_AT, evaluationDate: '2026-09-15T10:00:00.000Z' })
    ).toThrow(/evaluationDate/i);
  });

  // The regression this is really about: without the bounds check the row below is created happily,
  // is already past its 28-day settling window, and scores a real verdict about 2020.
  it('cannot be used to score a verdict about a period predating the recommendation', () => {
    let backdated: ReturnType<typeof createRecommendation> | undefined;
    try {
      backdated = createRecommendation({
        ...BASE,
        createdAt: CREATED_AT,
        evaluationDate: '2020-01-01T00:00:00.000Z',
      });
    } catch {
      // Correct behaviour — the row can never exist, so no verdict can be fabricated from it.
      return;
    }

    const result = scoreRecommendation({
      recommendation: backdated,
      now: CREATED_AT,
      adopted: true,
      actualValue: 45,
      baselineValue: 50,
    });
    // If creation ever starts succeeding again, scoring such a row must still not yield a real
    // verdict. Failing here means retroactive prediction is possible.
    expect(result.verdict).toBe('unscoreable');
  });

  it('still accepts a future evaluationDate', () => {
    const rec = createRecommendation({
      ...BASE,
      createdAt: CREATED_AT,
      evaluationDate: '2026-10-15T00:00:00.000Z',
    });
    expect(rec.status).toBe('pending');
    expect(rec.evaluationDate).toBe('2026-10-15T00:00:00.000Z');
  });

  // Same instant is not a prediction about the past; the settling window still applies, so it
  // cannot be scored until 28 days later. Allowed deliberately rather than by omission.
  it('accepts an evaluationDate equal to createdAt', () => {
    expect(() =>
      createRecommendation({ ...BASE, createdAt: CREATED_AT, evaluationDate: CREATED_AT })
    ).not.toThrow();
  });

  it('accepts a date-only evaluationDate in the future', () => {
    // Models supply these in practice; `new Date('2026-10-15')` is UTC midnight.
    expect(() =>
      createRecommendation({ ...BASE, createdAt: CREATED_AT, evaluationDate: '2026-10-15' })
    ).not.toThrow();
  });

  it('rejects an unparseable createdAt rather than comparing against Invalid Date', () => {
    // Every comparison against an Invalid Date is false, so an unvalidated createdAt would silently
    // disable the new bound — the same trap the existing evaluationDate parse check documents.
    expect(() =>
      createRecommendation({ ...BASE, createdAt: 'not a date', evaluationDate: '2026-10-15T00:00:00.000Z' })
    ).toThrow(/createdAt/i);
  });

  it('still rejects an unparseable evaluationDate', () => {
    expect(() =>
      createRecommendation({ ...BASE, createdAt: CREATED_AT, evaluationDate: 'next quarter' })
    ).toThrow(/evaluationDate/i);
  });
});

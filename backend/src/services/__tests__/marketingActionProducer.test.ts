import { candidatesFromRecommendations, CREATIVE_REFRESH_ACTION } from '../marketingActionProducer';
import { attachMarketingActions, readMarketingActions } from '../marketingActionEnvelope';
import type { Recommendation } from '../outcomeLedger';

function rec(adId: string, magnitude: number, overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    accountId: 'act_1', platform: 'meta', recommendationId: `fatigue_${adId}`,
    hypothesis: 'Review refreshing the fatigued creative; a replacement may recover its prior-window CTR.',
    predictedMetric: 'ctr', predictedDirection: 'increase', predictedMagnitudePct: magnitude,
    evaluationDate: '2026-10-20T23:59:59.999Z', createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'emma:creative-fatigue', adopted: null, status: 'pending', scoredAt: null,
    actualDirection: null, actualMagnitudePct: null, verdict: null, verdictReason: null,
    context: {
      version: 1, clientUserId: 'u1', campaignId: 'c1', adId, metricScope: 'ad', mode: 'shadow',
      source: 'assess_client_health', sourceWindow: { since: '2026-09-29', until: '2026-10-05' },
      rationale: 'CTR drop flagged.',
      evidence: [{ reference: `meta:act_1:c1:${adId}:prior`, metric: 'ctr', value: 2 }],
      assumptions: ['uncalibrated'], confidence: 'uncalibrated', reviewState: 'unreviewed',
      reviewAfter: '2026-11-17T00:00:00.000Z',
    } as any,
    ...overrides,
  };
}

const SRC = { sourceKind: 'run' as const, sourceId: 'run_123' };

describe('ENG-1094 marketing-action producer', () => {
  it('ENG-2775 shadow: observer receives risk classification; output unchanged', () => {
    const seen: Array<{ id: string; risk: unknown }> = [];
    const recs = [rec('a', 10), rec('b', 70)];
    const withObs = candidatesFromRecommendations(recs, SRC, (c, risk) => seen.push({ id: c.scopeId, risk }));
    expect(withObs).toEqual(candidatesFromRecommendations(recs, SRC));
    expect(seen).toHaveLength(2);
    expect(seen[0].risk).toMatchObject({ riskClass: 'creative_change', requiresApproval: true });
  });

  it('ENG-2775 shadow: a mutating or throwing observer cannot change candidates', () => {
    const recs = [rec('a', 10), rec('b', 70)];
    const expected = candidatesFromRecommendations(recs, SRC);
    const got = candidatesFromRecommendations(recs, SRC, (c) => {
      c.evidence.push('tampered');
      c.priority.confidence = 'high';
      (c as any).scopeId = 'x';
      throw new Error('observer boom');
    });
    expect(got).toEqual(expected);
  });

  it('ENG-2775 shadow: a rejecting async observer is handled (no unhandled rejection)', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const recs = [rec('a', 10)];
      const expected = candidatesFromRecommendations(recs, SRC);
      const got = candidatesFromRecommendations(recs, SRC, (async () => {
        throw new Error('async boom');
      }) as any);
      expect(got).toEqual(expected);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('maps a structured ledger recommendation to a valid contract candidate (no prose parsing)', () => {
    const [c] = candidatesFromRecommendations([rec('ad1', 60)], SRC);
    expect(c.actionType).toBe(CREATIVE_REFRESH_ACTION);
    expect(c.scopeId).toBe('meta:act_1:c1:ad1');
    expect(c.sourceId).toBe('run_123');
    expect(c.priority.businessImpact).toBe('high');
    expect(c.priority.confidence).toBe('low');
    expect(c.evidence).toEqual(['meta:act_1:c1:ad1:prior ctr=2']);
  });

  it('feeds attachMarketingActions: at most 3 actions, stable ids and order across retries and input order', () => {
    const recs = [rec('a', 10), rec('b', 70), rec('c', 30), rec('d', 55)];
    const first = attachMarketingActions({ response: 'long-form text' }, candidatesFromRecommendations(recs, SRC));
    const retry = attachMarketingActions(first, candidatesFromRecommendations([...recs].reverse(), SRC));
    expect(first.marketingActions).toHaveLength(3);
    expect(retry.marketingActions.map((a) => a.id)).toEqual(first.marketingActions.map((a) => a.id));
    expect(readMarketingActions(retry).map((a) => a.scopeId)).toEqual(first.marketingActions.map((a) => a.scopeId));
    expect(retry.response).toBe('long-form text');
  });

  it('empty/legacy input yields an empty action list', () => {
    expect(candidatesFromRecommendations(undefined, SRC)).toEqual([]);
    expect(candidatesFromRecommendations([], SRC)).toEqual([]);
    expect(candidatesFromRecommendations([rec('x', 40, { context: undefined })], SRC)).toEqual([]);
    expect(attachMarketingActions({}, candidatesFromRecommendations([], SRC)).marketingActions).toEqual([]);
  });

  it('skips scored rows: history is not a move', () => {
    expect(candidatesFromRecommendations([rec('s', 40, { status: 'scored' })], SRC)).toEqual([]);
  });

  it('requires a sourceId when there is something to attribute', () => {
    expect(() => candidatesFromRecommendations([rec('a', 10)], { sourceKind: 'run', sourceId: ' ' })).toThrow(/sourceId/);
  });
});

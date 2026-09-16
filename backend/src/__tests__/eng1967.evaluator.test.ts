import { evaluateSettledRecommendation } from '../services/adsOutcomeEvaluator';
import { createRecommendation } from '../services/outcomeLedger';
const now = '2026-06-01T00:00:00.000Z';
function recommendation(): any {
  return { ...createRecommendation({ platform: 'meta', accountId: 'a', recommendationId: 'r', createdBy: 'emma',
    hypothesis: 'Recovery', predictedMetric: 'ctr', predictedDirection: 'increase', predictedMagnitudePct: 20,
    createdAt: '2026-03-01T00:00:00.000Z', evaluationDate: '2026-03-29T23:59:59.999Z' }),
    context: { clientUserId: 'client', campaignId: 'campaign', metricScope: 'campaign',
      sourceWindow: { since: '2026-03-01', until: '2026-03-14' } } };
}
function rows(since: string, clicks: number): any[] {
  return Array.from({ length: 14 }, (_, i) => ({ entityKey: 'meta#a#campaign', accountId: 'a', platform: 'meta',
    userId: 'client', campaignId: 'campaign', rowType: 'campaign', dataQuality: 'exact', currency: 'USD', reportingTimezone: 'UTC',
    date: new Date(Date.parse(since) + i * 86400000).toISOString().slice(0, 10),
    impressions: 10000, clicks, spend: 100, capturedAt: new Date(Date.parse(since) + (i + 28) * 86400000).toISOString() }));
}
const receipt = () => ({ reference: 'execution:1', clientUserId: 'client', campaignId: 'campaign', accountId: 'a', platform: 'meta',
  recommendationId: 'r', executedAt: '2026-03-15T00:00:00.000Z', status: 'succeeded', adopted: true });
const run = (patch: any = {}) => evaluateSettledRecommendation({ recommendation: recommendation(), now,
  receipt: receipt(), baseline: { rows: rows('2026-03-01', 100), truncated: false },
  outcome: { rows: rows('2026-03-16', 200), truncated: false }, ...patch });
it('scores settled attributed recovery correct', () => expect(run()).toMatchObject({ verdict: 'correct', adopted: true }));
it('scores an attributed decrease incorrect, but never a missing receipt', () => {
  expect(run({ outcome: { rows: rows('2026-03-16', 50), truncated: false } })).toMatchObject({ verdict: 'incorrect' });
  expect(run({ receipt: null })).toMatchObject({ verdict: 'unscoreable', adopted: null });
});
it('labels statistically indistinguishable results inconclusive', () =>
  expect(run({ outcome: { rows: rows('2026-03-16', 100), truncated: false } })).toMatchObject({ verdict: 'inconclusive' }));
it('passing safety control: unsettled data is never correct', () => expect(run({ now: '2026-04-01' })?.verdict).not.toBe('correct'));
it.each(['userId', 'accountId', 'campaignId', 'platform'])('refuses foreign snapshot %s', key => {
  const foreign = rows('2026-03-16', 200); foreign[0][key] = 'foreign';
  expect(run({ outcome: { rows: foreign, truncated: false } })).toMatchObject({ verdict: 'unscoreable' });
});
it('does not score ad-level predictions against campaign metrics', () => {
  const r = recommendation(); r.context.metricScope = 'ad';
  expect(run({ recommendation: r })).toMatchObject({ verdict: 'unscoreable' });
});
it('waits for platform settlement; partial reads and low samples never become incorrect', () => {
  expect(run({ now: '2026-04-01' })).toBeNull();
  expect(run({ baseline: { rows: [], truncated: true } })).toMatchObject({ verdict: 'unscoreable' });
  expect(run({ outcome: { rows: rows('2026-03-16', 1), truncated: false } })).toMatchObject({ verdict: 'inconclusive' });
});
it('rejects a receipt for a different client and preserves explicit non-adoption', () => {
  expect(run({ receipt: { ...receipt(), clientUserId: 'other' } })).toMatchObject({ verdict: 'unscoreable', adopted: null });
  expect(run({ receipt: { ...receipt(), adopted: false, status: 'declined' } })).toMatchObject({ verdict: 'unscoreable', adopted: false });
});
it('uses the longer Google settling window rather than Meta timing', () => {
  const r = recommendation(); r.platform = 'google_ads';
  expect(run({ recommendation: r, now: '2026-05-01' })).toBeNull();
});
it('accepts an explicit decline recorded after the prediction horizon', () => {
  expect(run({ receipt: { ...receipt(), adopted: false, status: 'declined', executedAt: '2026-05-01' } }))
    .toMatchObject({ adopted: false, verdict: 'unscoreable' });
});
it.each([null, true, { impressions: '1000' }])('never fabricates a verdict from malformed metric element %p', malformed => {
  const broken = rows('2026-03-16', 200); broken[0] = malformed;
  expect(run({ outcome: { rows: broken, truncated: false } })).toMatchObject({ verdict: 'unscoreable' });
});

it('rejects invalid prediction dates before attempting evaluation', () => {
  const r = recommendation(); r.evaluationDate = 'invalid';
  expect(() => run({ recommendation: r })).toThrow(/date/i);
});

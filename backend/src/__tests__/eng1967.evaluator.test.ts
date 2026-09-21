import { evaluateSettledRecommendation } from '../services/adsOutcomeEvaluator';
import { createRecommendation } from '../services/outcomeLedger';
const now = '2026-06-01T00:00:00.000Z';
function recommendation(): any {
  return { ...createRecommendation({ platform: 'meta', accountId: 'a', recommendationId: 'r', createdBy: 'emma',
    hypothesis: 'Recovery', predictedMetric: 'ctr', predictedDirection: 'increase', predictedMagnitudePct: 20,
    createdAt: '2026-03-01T00:00:00.000Z', evaluationDate: '2026-03-29T23:59:59.999Z' }),
    context: { version: 1, source: 'assess_client_health', mode: 'shadow', adId: 'ad',
      rationale: 'Recovery', confidence: 'uncalibrated', reviewState: 'unreviewed', reviewAfter: now,
      evidence: [{ reference: 'snapshot', metric: 'ctr_drop_pct', value: 40 }], assumptions: ['stable spend'], clientUserId: 'client', campaignId: 'campaign', metricScope: 'campaign',
      sourceWindow: { since: '2026-03-01', until: '2026-03-14' } } };
}
function rows(since: string, clicks: number): any[] {
  return Array.from({ length: 14 }, (_, i) => ({ entityKey: 'meta#a#campaign', accountId: 'a', platform: 'meta',
    userId: 'client', campaignId: 'campaign', rowType: 'campaign', dataQuality: 'exact', currency: 'USD', reportingTimezone: 'UTC',
    date: new Date(Date.parse(since) + i * 86400000).toISOString().slice(0, 10),
    impressions: 10000, clicks, spend: 100, capturedAt: new Date(Date.parse(since) + (i + 29) * 86400000).toISOString() }));
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

it.each([undefined, null])('leaves contextless legacy rows unevaluated (%p)', context => {
  const r = { ...recommendation(), context }, before = structuredClone(r);
  expect(run({ recommendation: r })).toBeNull();
  expect(r).toEqual(before);
});
it.each([{ version: 2 }, { source: 'manual' }, { clientUserId: '' }, { clientUserId: null }])(
  'does not evaluate unknown context or missing client attribution: %p', patch => {
    const r = recommendation(); Object.assign(r.context, patch);
    expect(run({ recommendation: r })).toBeNull();
  });
it.each([
  ['Pacific/Kiritimati', '2026-04-26T10:00:00.000Z'],
  ['America/Los_Angeles', '2026-04-27T07:00:00.000Z'],
  // The baseline includes the March 8 DST transition (23-hour reporting day).
  ['America/New_York', '2026-04-27T04:00:00.000Z'],
])('requires the final reporting day to end in %s before settlement', (zone, settledAt) => {
  const outcome = rows('2026-03-16', 200).map(x => ({ ...x, reportingTimezone: zone, capturedAt: now }));
  const baseline = rows('2026-03-01', 100).map(x => ({ ...x, reportingTimezone: zone, capturedAt: now }));
  outcome[13].capturedAt = new Date(Date.parse(settledAt) - 1).toISOString();
  expect(run({ baseline: { rows: baseline }, outcome: { rows: outcome } })).toMatchObject({ verdict: 'unscoreable' });
  outcome[13].capturedAt = settledAt;
  expect(run({ baseline: { rows: baseline }, outcome: { rows: outcome } })).toMatchObject({ verdict: 'correct' });
});
it.each([
  ['2026-03-08', '2026-04-06T04:00:00.000Z'],
  ['2026-11-01', '2026-11-30T05:00:00.000Z'],
])('uses the DST-adjusted end of reporting day %s', (date, settledAt) => {
  // Exercise a DST-transition row directly within a complete 14-day window.
  const r = recommendation();
  const start = new Date(Date.parse(date) - 13 * 86400000).toISOString().slice(0, 10);
  r.evaluationDate = date + 'T23:59:59.999Z';
  r.createdAt = '2026-01-01T00:00:00.000Z';
  r.context.sourceWindow = { since: '2026-01-01', until: '2026-01-14' };
  const e = { ...receipt(), executedAt: '2026-01-15T00:00:00.000Z' };
  const baseline = rows('2026-01-01', 100).map(x => ({ ...x, reportingTimezone: 'America/New_York', capturedAt: '2026-12-01' }));
  const outcome = rows(start, 200).map(x => ({ ...x, reportingTimezone: 'America/New_York', capturedAt: '2026-12-01' }));
  const args = { recommendation: r, receipt: e, now: '2026-12-02', baseline: { rows: baseline }, outcome: { rows: outcome } };
  outcome[13].capturedAt = new Date(Date.parse(settledAt) - 1).toISOString();
  expect(run(args)).toMatchObject({ verdict: 'unscoreable' });
  outcome[13].capturedAt = settledAt;
  expect(run(args)).toMatchObject({ verdict: 'correct' });
});
it.each(['Not/AZone', '+05:00', '', true])('rejects unsupported reporting timezone %p', reportingTimezone => {
  const baseline = rows('2026-03-01', 100).map(x => ({ ...x, reportingTimezone }));
  const outcome = rows('2026-03-16', 200).map(x => ({ ...x, reportingTimezone }));
  expect(run({ baseline: { rows: baseline }, outcome: { rows: outcome } })).toMatchObject({ verdict: 'unscoreable' });
});

// Daily ingestion needs time to perform the post-settlement refresh. A cron tick
// at the provider boundary must not permanently score the still-mutable snapshot.
it.each(['2026-04-26T23:59:59.999Z', '2026-04-27T09:00:00.000Z', '2026-04-28T09:00:00.000Z'])(
  'keeps a due campaign pending while the final daily refresh is still due (%s)', clock => {
    const stale = rows('2026-03-16', 200);
    stale[13].capturedAt = '2026-04-26T09:00:00.000Z';
    expect(run({ now: clock, outcome: { rows: stale, truncated: false } })).toBeNull();
  });

it('scores after the daily final refresh even at the latest reporting-day boundary', () => {
  const baseline = rows('2026-03-01', 100).map(x => ({ ...x, reportingTimezone: 'Etc/GMT+12', capturedAt: '2026-04-28T09:00:00.000Z' }));
  const outcome = rows('2026-03-16', 200).map(x => ({ ...x, reportingTimezone: 'Etc/GMT+12', capturedAt: '2026-04-28T09:00:00.000Z' }));
  expect(run({ now: '2026-04-29T00:00:00.000Z', baseline: { rows: baseline }, outcome: { rows: outcome } }))
    .toMatchObject({ verdict: 'correct', adopted: true });
});

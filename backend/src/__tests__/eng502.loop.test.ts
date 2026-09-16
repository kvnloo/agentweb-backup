/** Real capture/ledger/evaluator/memory services; only DynamoDB transport is in memory. */
const mockTables = new Map<string, Map<string, any>>();
const key = (x: any) => x.memoryId ? `${x.userId}/${x.memoryId}` : `${x.entityKey}/${x.recommendationId ?? x.date ?? x.paramKey}`;
const table = (name: string) => { if (!mockTables.has(name)) mockTables.set(name, new Map()); return mockTables.get(name)!; };
const conflict = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
const mockClient = {
  scan: jest.fn(),
  put: (p: any) => ({ promise: async () => { const t = table(p.TableName), k = key(p.Item);
    if (p.ConditionExpression?.includes('attribute_not_exists') && t.has(k)) throw conflict();
    t.set(k, structuredClone(p.Item)); return {}; } }),
  get: (p: any) => ({ promise: async () => ({ Item: structuredClone(table(p.TableName).get(key(p.Key))) }) }),
  query: jest.fn((p: any) => ({ promise: async () => {
    const v = p.ExpressionAttributeValues;
    let rows = [...table(p.TableName).values()].filter(x => p.IndexName === 'StatusEvaluationDateIndex'
      ? x.status === 'pending' && x.evaluationDate <= v[':due']
      : v[':userId'] ? x.userId === v[':userId'] && x.memoryId.startsWith(v[':prefix'] ?? '')
      : x.entityKey === (v[':e'] ?? v[':entityKey']));
    if (v[':since']) rows = rows.filter(x => x.date >= v[':since'] && x.date <= v[':until']);
    return { Items: structuredClone(rows.slice(0, p.Limit ?? 100)), LastEvaluatedKey: undefined };
  } })),
  update: (p: any) => ({ promise: async () => {
    const t = table(p.TableName), k = key(p.Key), old = t.get(k);
    if (!old || old.status !== 'pending' || old.context.execution) throw conflict();
    old.context.execution = structuredClone(p.ExpressionAttributeValues[':receipt']); return {};
  } }),
  transactWrite: (p: any) => ({ promise: async () => {
    for (const { Put, Update } of p.TransactItems) {
      const x = Put ?? Update, old = table(x.TableName).get(key(x.Item ?? x.Key));
      if (Put?.ExpressionAttributeValues?.[':context'] && JSON.stringify(old?.context) !== JSON.stringify(Put.ExpressionAttributeValues[':context'])) throw Object.assign(conflict(), { code: 'TransactionCanceledException' });
      if (Update ? old?.status !== 'pending' : Put.ConditionExpression.includes(':pending') ? old?.status !== 'pending' : Put.ConditionExpression.includes(':expected') ? old?.updatedAt !== Put.ExpressionAttributeValues[':expected'] : !!old) throw Object.assign(conflict(), { code: 'TransactionCanceledException' });
    }
    for (const { Put, Update } of p.TransactItems) {
      if (Put) table(Put.TableName).set(key(Put.Item), structuredClone(Put.Item));
      if (Update) Object.assign(table(Update.TableName).get(key(Update.Key)), Update.ExpressionAttributeValues[':score']);
    }
    return {};
  } }),
};
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => mockClient) } } }));
import { captureFatigueRecommendations } from '../services/adsRecommendationCapture';
import { runAdsLearningEvaluation } from '../cron/adsLearningCron';
import { getDueRecommendations, completeEvaluation, commitLearningReview, getScopedLearning } from '../services/adsLearningDb';
const input = { clientUserId: 'u', accountId: 'a', campaignIds: ['c'], now: '2026-03-15T00:00:00.000Z',
  fatigued: [{ id: 'ad', reasons: ['ctr_drop'] }], ads: [{ id: 'ad', campaign_id: 'c',
    current_insights: { data: [{ date_start: '2026-03-01', date_stop: '2026-03-14', ctr: 1 }] },
    prior_insights: { data: [{ date_start: '2026-02-15', date_stop: '2026-02-28', ctr: 2 }] } }] };
beforeEach(() => { mockTables.clear(); delete process.env.ADS_LEARNING_MODE; mockClient.scan.mockReset().mockImplementation(() => ({ promise: async () => ({ Items: [{ userId: 'u', adAccount: 'a' }] }) })); });
it('unsupported ad evidence stays in the ledger without generating guidance', async () => {
  await captureFatigueRecommendations(input);
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  const learning = await getScopedLearning({ userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c', now: '2026-05-01' });
  expect(learning).toHaveLength(1);
  expect([...table('AW-AdsOutcomeLedger').values()][0]).toMatchObject({ status: 'scored', verdict: 'unscoreable', adopted: null });
});
it('replay cannot duplicate a learned item or rewrite a verdict', async () => {
  await captureFatigueRecommendations(input);
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  await runAdsLearningEvaluation(new Date('2026-05-02'));
  expect(table('AW-AccountMemory').size).toBe(0);
  expect([...table('AW-AdsOutcomeLedger').values()][0].scoredAt).toBe('2026-05-01T00:00:00.000Z');
});
it('isolates shared-account clients through evaluation and retrieval', async () => {
  await captureFatigueRecommendations(input);
  await captureFatigueRecommendations({ ...input, clientUserId: 'other' });
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  const learning = await getScopedLearning({ userId: 'other', accountId: 'a', platform: 'meta', campaignId: 'c', now: '2026-05-01' });
  expect(learning).toHaveLength(1);
  expect(learning.every(x => x.userId === 'other')).toBe(true);
});
it('passing safety control: off switch performs no evaluation writes', async () => {
  process.env.ADS_LEARNING_MODE = 'off'; await runAdsLearningEvaluation(new Date('2026-05-01'));
  expect(table('AW-AccountMemory').size).toBe(0);
});

import { adsMetricsDb } from '../services/adsMetricsDb';
import { observeVerifiedCreativeExecution } from '../services/adsExecutionCapture';
async function metrics(since: string, clicks: number, settled = true, campaignId = 'c') {
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.parse(since) + i * 86400000).toISOString().slice(0, 10);
    await adsMetricsDb.putSnapshot({ entityKey: `meta#a#${campaignId}`, platform: 'meta', accountId: 'a', campaignId, userId: 'u',
      date, rowType: 'campaign', currency: 'USD', reportingTimezone: 'UTC', dataQuality: 'exact',
      impressions: 10000, clicks, spend: 100, capturedAt: settled ? new Date(Date.parse(date) + 29 * 86400000).toISOString() : input.now,
      parentAccountId: null, campaignName: 'C', platformMetrics: {}, snapshotSource: 'daily' });
  }
}
it('captures supported campaign evidence and attaches only a verified execution receipt, then learns', async () => {
  await metrics('2026-02-15', 200, false); await metrics('2026-03-01', 100, false);
  await captureFatigueRecommendations(input);
  expect(table('AW-AdsOutcomeLedger').size).toBe(2);
  await observeVerifiedCreativeExecution({ userId: 'u', accountId: 'a', adId: 'ad', creativeId: 'replacement', verified: true,
    now: '2026-03-15T12:00:00.000Z' });
  // Simulate the daily collector's final refresh after the provider settling interval.
  await metrics('2026-03-01', 100);
  await metrics('2026-03-16', 200);
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  expect([...table('AW-AdsOutcomeLedger').values()].find(r => r.context.metricScope === 'campaign'))
    .toMatchObject({ verdict: 'correct', adopted: true });
  const scope = { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c', now: '2026-05-01' };
  const lessons = await getScopedLearning(scope);
  expect(lessons).toHaveLength(2);
  expect(lessons[1].learning).toMatchObject({ confidence: 'directional', reviewState: 'proposed' });
  await runAdsLearningEvaluation(new Date('2026-05-02'));
  expect(await getScopedLearning(scope)).toEqual(lessons);
  expect(await getScopedLearning({ ...scope, userId: 'other' })).toHaveLength(1);
});
it('never infers adoption from unverified success', async () => {
  await captureFatigueRecommendations(input);
  await observeVerifiedCreativeExecution({ userId: 'u', accountId: 'a', adId: 'ad', creativeId: 'replacement', verified: false, now: input.now });
  expect([...table('AW-AdsOutcomeLedger').values()][0].context.execution).toBeUndefined();
});

jest.mock('../services/metaTokenRefresh', () => ({ ensureFreshMetaAdAccountToken: jest.fn() }));
jest.mock('../services/db', () => ({}));
import { reviewLearning } from '../services/adsLearningReview';
import { getThreshold } from '../services/adsThresholdsDb';
async function supportedFleet() {
  for (let n = 0; n < 30; n++) {
    const c = `c-${n}`, ad = `ad-${n}`;
    await metrics('2026-02-15', 200, false, c);
    await metrics('2026-03-01', 100, false, c);
    await captureFatigueRecommendations({ ...input, campaignIds: [c], fatigued: [{ id: ad, reasons: ['ctr_drop'] }],
      ads: [{ ...input.ads[0], id: ad, campaign_id: c }] });
    await observeVerifiedCreativeExecution({ userId: 'u', accountId: 'a', adId: ad, creativeId: `replacement-${n}`, verified: true,
      now: '2026-03-15T12:00:00.000Z' });
    await metrics('2026-03-01', 100, true, c);
    await metrics('2026-03-16', 200, true, c);
  }
  // Sixty ad/campaign records exceed one bounded tick; the next tick drains the rest.
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  await runAdsLearningEvaluation(new Date('2026-05-01T00:15:00Z'));
  return [...table('AW-AccountMemory').values()].find(r => r.learning.confidence === 'directional');
}
const scope = { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c-0', now: '2026-05-02T00:00:00.000Z' };
it('supported shadow learning requires review, then updates ENG-918 once with capped movement and provenance', async () => {
  const lesson = await supportedFleet();
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
  expect(await reviewLearning({ ...scope, campaignId: undefined }, lesson.memoryId, 'approve', 'client')).toMatchObject({ applied: true });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toMatchObject({ currentValue: 25, source: 'learned',
    revisions: [expect.objectContaining({ sampleSize: 30, changedBy: 'u', evidence: expect.stringContaining(lesson.memoryId) })] });
});
it('approval replay cannot walk the movement cap', async () => {
  const lesson = await supportedFleet();
  const s = { ...scope, campaignId: lesson.learning.campaignId };
  await reviewLearning(s, lesson.memoryId, 'approve', 'client');
  await reviewLearning(s, lesson.memoryId, 'approve', 'client');
  expect((await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct'))?.revisions).toHaveLength(1);
});
it('rollback restores registry default with audit history and cooldown', async () => {
  const lesson = await supportedFleet();
  const s = { ...scope, campaignId: lesson.learning.campaignId };
  await reviewLearning(s, lesson.memoryId, 'approve', 'client');
  await reviewLearning({ ...s, now: '2026-05-03T00:00:00.000Z' }, lesson.memoryId, 'revert');
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toMatchObject({ currentValue: 20, source: 'default',
    learnedCooldownUntil: expect.any(String), revisions: [expect.any(Object), expect.any(Object)] });
});

it('keeps pending evidence and emits an error when the atomic evaluation write fails', async () => {
  await captureFatigueRecommendations(input);
  const write = jest.spyOn(mockClient, 'transactWrite').mockReturnValueOnce({ promise: async () => { throw new Error('offline'); } });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  expect([...table('AW-AdsOutcomeLedger').values()][0].status).toBe('pending');
  expect(table('AW-AccountMemory').size).toBe(0);
  expect(error).toHaveBeenCalledWith('[AdsLearning] evaluation failed', expect.any(Object));
  write.mockRestore(); error.mockRestore();
});
it('refuses a shared-account parameter promotion despite sufficient evidence', async () => {
  const lesson = await supportedFleet();
  mockClient.scan.mockImplementationOnce(() => ({ promise: async () => ({ Items: [{ userId: 'u', adAccount: 'a' }, { userId: 'peer', adAccount: 'a' }] }) }));
  expect(await reviewLearning({ ...scope, campaignId: lesson.learning.campaignId }, lesson.memoryId, 'approve', 'client'))
    .toMatchObject({ applied: false, reason: 'ambiguous_account_ownership' });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});
it('refuses campaign capture from snapshots dated after the assessment', async () => {
  await metrics('2026-02-15', 200); await metrics('2026-03-01', 100);
  await captureFatigueRecommendations(input);
  expect([...table('AW-AdsOutcomeLedger').values()].filter(r => r.context.metricScope === 'campaign')).toHaveLength(0);
});

import { createRecommendation } from '../services/outcomeLedger';
function legacyItem() {
  const { platform, accountId, ...r } = createRecommendation({ platform: 'meta', accountId: 'a', recommendationId: 'legacy',
    createdBy: 'manual', hypothesis: 'Legacy', predictedMetric: 'ctr', predictedDirection: 'increase',
    predictedMagnitudePct: 20, createdAt: '2026-03-01', evaluationDate: '2026-03-29' });
  return { ...r, entityKey: 'meta#a' };
}
it('due selection excludes legacy pending rows and cron leaves them byte-for-byte untouched', async () => {
  const legacy = legacyItem(); table('AW-AdsOutcomeLedger').set(key(legacy), legacy);
  expect((await getDueRecommendations(new Date('2026-06-01'))).rows).toEqual([]);
  await runAdsLearningEvaluation(new Date('2026-06-01'));
  expect(table('AW-AdsOutcomeLedger').get(key(legacy))).toEqual(legacyItem());
  expect(table('AW-AccountMemory').size).toBe(0);
});
it('completion refuses a contextless scored legacy row before any write', async () => {
  const legacy = legacyItem(); table('AW-AdsOutcomeLedger').set(key(legacy), legacy);
  const { entityKey, ...fields } = legacy;
  await expect(completeEvaluation({ ...fields, platform: 'meta', accountId: 'a', status: 'scored', scoredAt: '2026-06-01',
    verdict: 'unscoreable', verdictReason: 'missing_client_attribution' })).rejects.toThrow(/context|ENG-502/i);
  expect(table('AW-AdsOutcomeLedger').get(key(legacy))).toEqual(legacyItem());
});
it('production due adapter leaves Google rows pending (guard support is not an integration)', async () => {
  await captureFatigueRecommendations(input);
  const r = [...table('AW-AdsOutcomeLedger').values()][0];
  table('AW-AdsOutcomeLedger').clear(); r.entityKey = 'google_ads#a';
  table('AW-AdsOutcomeLedger').set(key(r), r);
  expect((await getDueRecommendations(new Date('2026-09-01'))).rows).toEqual([]);
  await runAdsLearningEvaluation(new Date('2026-09-01'));
  expect(table('AW-AdsOutcomeLedger').get(key(r)).status).toBe('pending');
});
it.each(['campaign', 'channel'] as const)('%s approval and revert are qualitative only, even with 30 supported outcomes', async target => {
  const lesson = await supportedFleet(), s = { ...scope, campaignId: lesson.learning.campaignId };
  const result = await reviewLearning(s, lesson.memoryId, 'approve', target);
  expect(result).toMatchObject({ applied: true, parameter: null, lesson: { learning: { scope: target, reviewState: 'approved' } } });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
  expect(await reviewLearning({ ...s, now: '2026-05-03' }, lesson.memoryId, 'revert')).toMatchObject({
    applied: true, parameter: null, lesson: { learning: { reviewState: 'reverted' } } });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});
it('rechecks context after a stale due-index candidate before invoking the evaluator', async () => {
  await captureFatigueRecommendations(input);
  const fresh = jest.spyOn(mockClient, 'get').mockImplementationOnce((p: any) => ({ promise: async () => {
    const r = structuredClone(table(p.TableName).get(key(p.Key))); delete r.context; return { Item: r };
  } }));
  const evaluator = jest.spyOn(require('../services/adsOutcomeEvaluator'), 'evaluateSettledRecommendation');
  await runAdsLearningEvaluation(new Date('2026-06-01'));
  expect(evaluator).not.toHaveBeenCalled();
  expect([...table('AW-AdsOutcomeLedger').values()][0].status).toBe('pending');
  fresh.mockRestore(); evaluator.mockRestore();
});
it('atomic completion cannot overwrite a row whose ENG-502 context was removed', async () => {
  await captureFatigueRecommendations(input);
  const r = (await getDueRecommendations(new Date('2026-06-01'))).rows[0];
  const stored = [...table('AW-AdsOutcomeLedger').values()][0]; delete stored.context;
  await expect(completeEvaluation({ ...r, status: 'scored', scoredAt: '2026-06-01', verdict: 'unscoreable' }))
    .rejects.toThrow();
  expect(stored.status).toBe('pending');
});

it('default review scope approves guidance without changing an account parameter', async () => {
  const lesson = await supportedFleet();
  expect(await reviewLearning({ ...scope, campaignId: lesson.learning.campaignId }, lesson.memoryId, 'approve'))
    .toMatchObject({ applied: true, parameter: null, lesson: { learning: { scope: 'campaign' } } });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});
it('transaction boundary refuses a parameter paired with campaign-scoped approval', async () => {
  const lesson = await supportedFleet();
  await expect(commitLearningReview({ ...lesson, updatedAt: scope.now,
    learning: { ...lesson.learning, reviewState: 'approved' } }, lesson,
    { accountId: 'a', platform: 'meta', paramKey: 'creativeFatigue.ctrDropCriticalPct', currentValue: 25 } as any, null))
    .rejects.toThrow(/scope/i);
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});

it.each([true, { userId: 'peer', connected_accounts: true }, { userId: 'peer', connected_accounts: [null] }])(
  'cannot promote a threshold when ownership data is malformed (%p)', async malformed => {
    const lesson = await supportedFleet();
    mockClient.scan.mockImplementation(() => ({ promise: async () => ({ Items: [malformed] }) }));
    await expect(reviewLearning(scope, lesson.memoryId, 'approve', 'client')).rejects.toThrow(/ownership/i);
    expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
  });
it('cannot promote on an incomplete bounded ownership read', async () => {
  const lesson = await supportedFleet();
  mockClient.scan.mockImplementation(() => ({ promise: async () => ({ Items: [{ userId: 'u', adAccount: 'a' }], LastEvaluatedKey: { userId: 'more' } }) }));
  await expect(reviewLearning(scope, lesson.memoryId, 'approve', 'client')).rejects.toThrow(/ownership/i);
  expect(mockClient.scan.mock.calls.length).toBeLessThanOrEqual(20);
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});
it('finds a second account owner on a later page and refuses promotion', async () => {
  const lesson = await supportedFleet();
  mockClient.scan.mockImplementationOnce(() => ({ promise: async () => ({ Items: [{ userId: 'u', adAccount: 'a' }], LastEvaluatedKey: { userId: 'u' } }) }))
    .mockImplementationOnce(() => ({ promise: async () => ({ Items: [{ userId: 'peer', adAccount: 'a' }] }) }));
  expect(await reviewLearning(scope, lesson.memoryId, 'approve', 'client')).toMatchObject({ applied: false, reason: 'ambiguous_account_ownership' });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});

it('counts a linked peer as an owner even when its access token is unavailable', async () => {
  const lesson = await supportedFleet();
  mockClient.scan.mockImplementationOnce(() => ({ promise: async () => ({ Items: [
    { userId: 'u', adAccount: 'a' },
    { userId: 'peer', connected_accounts: [{ platform: 'meta', account_id: 'act_a', config: { account_type: 'ad_account' } }] },
  ] }) }));
  expect(await reviewLearning(scope, lesson.memoryId, 'approve', 'client')).toMatchObject({ applied: false, reason: 'ambiguous_account_ownership' });
});

it('bounds an unresponsive ownership read without writing a threshold', async () => {
  const lesson = await supportedFleet();
  const abort = jest.fn();
  mockClient.scan.mockImplementationOnce(() => ({ promise: () => new Promise(() => {}), abort }));
  jest.useFakeTimers();
  try {
    const rejected = expect(reviewLearning(scope, lesson.memoryId, 'approve', 'client')).rejects.toThrow(/deadline/i);
    await jest.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(abort).toHaveBeenCalledTimes(1);
    expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
  } finally { jest.useRealTimers(); }
});

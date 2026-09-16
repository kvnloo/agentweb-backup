/** Real capture/ledger/evaluator/memory services; only DynamoDB transport is in memory. */
const mockTables = new Map<string, Map<string, any>>();
const key = (x: any) => x.memoryId ? `${x.userId}/${x.memoryId}` : `${x.entityKey}/${x.recommendationId ?? x.date ?? x.paramKey}`;
const table = (name: string) => { if (!mockTables.has(name)) mockTables.set(name, new Map()); return mockTables.get(name)!; };
const conflict = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
const mockClient = {
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
import { getScopedLearning } from '../services/adsLearningDb';
const input = { clientUserId: 'u', accountId: 'a', campaignIds: ['c'], now: '2026-03-15T00:00:00.000Z',
  fatigued: [{ id: 'ad', reasons: ['ctr_drop'] }], ads: [{ id: 'ad', campaign_id: 'c',
    current_insights: { data: [{ date_start: '2026-03-01', date_stop: '2026-03-14', ctr: 1 }] },
    prior_insights: { data: [{ date_start: '2026-02-15', date_stop: '2026-02-28', ctr: 2 }] } }] };
beforeEach(() => { mockTables.clear(); delete process.env.ADS_LEARNING_MODE; });
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
      impressions: 10000, clicks, spend: 100, capturedAt: settled ? new Date(Date.parse(date) + 28 * 86400000).toISOString() : input.now,
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
jest.mock('../services/db', () => ({ userDb: { getAllUsers: jest.fn().mockResolvedValue([{ userId: 'u', adAccount: 'a' }]) } }));
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
  await runAdsLearningEvaluation(new Date('2026-05-01'));
  return [...table('AW-AccountMemory').values()].find(r => r.learning.confidence === 'directional');
}
const scope = { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c-0', now: '2026-05-02T00:00:00.000Z' };
it('supported shadow learning requires review, then updates ENG-918 once with capped movement and provenance', async () => {
  const lesson = await supportedFleet();
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
  expect(await reviewLearning({ ...scope, campaignId: undefined }, lesson.memoryId, 'approve')).toMatchObject({ applied: true });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toMatchObject({ currentValue: 25, source: 'learned',
    revisions: [expect.objectContaining({ sampleSize: 30, changedBy: 'u', evidence: expect.stringContaining(lesson.memoryId) })] });
});
it('approval replay cannot walk the movement cap', async () => {
  const lesson = await supportedFleet();
  const s = { ...scope, campaignId: lesson.learning.campaignId };
  await reviewLearning(s, lesson.memoryId, 'approve');
  await reviewLearning(s, lesson.memoryId, 'approve');
  expect((await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct'))?.revisions).toHaveLength(1);
});
it('rollback restores registry default with audit history and cooldown', async () => {
  const lesson = await supportedFleet();
  const s = { ...scope, campaignId: lesson.learning.campaignId };
  await reviewLearning(s, lesson.memoryId, 'approve');
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
  const { userDb } = await import('../services/db');
  (userDb.getAllUsers as jest.Mock).mockResolvedValueOnce([{ userId: 'u', adAccount: 'a' }, { userId: 'peer', adAccount: 'a' }]);
  expect(await reviewLearning({ ...scope, campaignId: lesson.learning.campaignId }, lesson.memoryId, 'approve'))
    .toMatchObject({ applied: false, reason: 'ambiguous_account_ownership' });
  expect(await getThreshold('meta', 'a', 'creativeFatigue.ctrDropCriticalPct')).toBeNull();
});
it('refuses campaign capture from snapshots dated after the assessment', async () => {
  await metrics('2026-02-15', 200); await metrics('2026-03-01', 100);
  await captureFatigueRecommendations(input);
  expect([...table('AW-AdsOutcomeLedger').values()].filter(r => r.context.metricScope === 'campaign')).toHaveLength(0);
});

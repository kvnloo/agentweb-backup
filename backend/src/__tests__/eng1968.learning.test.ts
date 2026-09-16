import { buildOutcomeLesson, resolveScopedLessons, proposeParameterLearning } from '../services/adsScopedLearning';
const now = '2026-06-01T00:00:00.000Z';
const row: any = { platform: 'meta', accountId: 'a', recommendationId: 'r', status: 'scored', verdict: 'correct',
  adopted: true, scoredAt: now, context: { clientUserId: 'u', campaignId: 'c', metricScope: 'campaign',
    evidence: [{ reference: 'snapshot', metric: 'ctr_drop_pct', value: 40 }],
    sourceWindow: { since: '2026-01-01', until: '2026-01-14' },
    execution: { reference: 'exec', executedAt: '2026-01-15', adopted: true } } };
it('preserves provenance, confidence, expiry, review and reversible history in account memory', () => {
  expect(buildOutcomeLesson(row)).toMatchObject({ userId: 'u', category: 'insight', learning: {
    scope: 'campaign', campaignId: 'c', reviewState: 'proposed', confidence: 'directional',
    references: ['meta#a/r', 'exec'], createdAt: now, updatedAt: now,
    expiresAt: '2026-08-30T00:00:00.000Z', history: [{ state: 'proposed', at: now }] } });
});
it('retrieves bounded deterministic global/client/campaign/channel order without another tenant', () => {
  const lesson = buildOutcomeLesson(row)!;
  const items = ['channel', 'campaign', 'client'].map((scope, i) => ({ ...lesson, memoryId: String(i), learning: { ...lesson.learning, scope, channel: 'meta' } }));
  const foreign = { ...lesson, userId: 'other' };
  const resolved = resolveScopedLessons([foreign, ...items], { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c', now });
  expect(resolved.map((x: any) => x.learning.scope)).toEqual(['global', 'client', 'campaign', 'channel']);
});
it('proposes a capped ENG-918 parameter only from repeated independent supported outcomes', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...row, recommendationId: String(i), context: { ...row.context,
    campaignId: `campaign-${i}`, execution: { ...row.context.execution, reference: `exec-${i}` } } }));
  expect(proposeParameterLearning(rows, null, now)).toMatchObject({ allowed: true, value: 25 });
  expect(proposeParameterLearning(rows.slice(0, 29), null, now)).toMatchObject({ allowed: false });
  expect(proposeParameterLearning(rows, { source: 'user', currentValue: 15 } as any, now)).toMatchObject({ allowed: false, reason: 'learned_would_override_user' });
});
it('passing safety control: empty evidence cannot support parameter learning', () => expect(proposeParameterLearning([], null, now)?.allowed).not.toBe(true));
it('excludes expired, rolled back, wrong-account and wrong-campaign lessons', () => {
  const l = buildOutcomeLesson(row)!;
  const lessons = [
    { ...l, learning: { ...l.learning, expiresAt: '2026-01-01' } },
    { ...l, learning: { ...l.learning, reviewState: 'reverted' } },
    { ...l, learning: { ...l.learning, campaignId: 'other' } },
    { ...l, learning: { ...l.learning, accountId: 'other' } },
  ];
  expect(resolveScopedLessons(lessons, { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c', now })).toHaveLength(1);
});
it('cannot count overlapping windows or replayed execution receipts as independent support', () => {
  const repeated = Array.from({ length: 30 }, (_, i) => ({ ...row, recommendationId: String(i) }));
  expect(proposeParameterLearning(repeated, null, now)).toMatchObject({ allowed: false });
});

import { resolveThresholds } from '../services/adsThresholds';
it('expired learned parameter falls back without deleting numeric audit history', () => {
  const parameter: any = { paramKey: 'creativeFatigue.ctrDropCriticalPct', currentValue: 25, source: 'learned',
    updatedAt: '2026-01-01', revisions: [{ evidence: 'Reviewed ads-learning#fixture', changedAt: '2026-01-01' }] };
  expect(resolveThresholds([parameter])['creativeFatigue.ctrDropCriticalPct']).toEqual({ value: 20, source: 'default' });
  expect(parameter.revisions).toHaveLength(1);
});

it.each(['incorrect', 'inconclusive', 'unscoreable'])('keeps %s outcomes out of guidance projection', verdict => {
  expect(buildOutcomeLesson({ ...row, verdict })).toBeNull();
});
it('excludes previously stored unsupported guidance on retrieval', () => {
  const lesson = buildOutcomeLesson(row)!;
  lesson.learning.confidence = 'unsupported';
  expect(resolveScopedLessons([lesson], { userId: 'u', accountId: 'a', platform: 'meta', campaignId: 'c', now })).toHaveLength(1);
});

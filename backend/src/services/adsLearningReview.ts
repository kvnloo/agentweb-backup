import { userDb } from './db';
import { getConnectedMetaAccountsList, cleanAccountId } from './metaAccountCredentials';
import { getLearningItem, getLearningRecommendations, commitLearningReview } from './adsLearningDb';
import { proposeParameterLearning, resolveScopedLessons, type LearningScope } from './adsScopedLearning';
import { getThreshold } from './adsThresholdsDb';
import { applyThresholdWrite, buildThresholdRevert, resolveThresholds } from './adsThresholds';
/** Explicit owner review promotes shadow guidance. No cron ever calls this or mutates a campaign. */
export async function reviewLearning(scope: LearningScope, memoryId: string, action: 'approve' | 'revert',
  targetScope: 'client' | 'campaign' | 'channel' = 'campaign') {
  const lesson = await getLearningItem(scope.userId, memoryId);
  if (!lesson || lesson.userId !== scope.userId || lesson.learning?.accountId !== scope.accountId || lesson.learning.platform !== scope.platform) {
    throw new Error('Learning scope mismatch');
  }
  if (lesson.learning.reviewState === (action === 'approve' ? 'approved' : 'reverted')) return { applied: false, reason: 'already_reviewed' };
  if (action === 'approve' && !resolveScopedLessons([lesson], { ...scope, campaignId: scope.campaignId ?? lesson.learning.campaignId }).some(x => x.memoryId === memoryId)) throw new Error('Learning expired or scope mismatch');
  if (Date.parse(scope.now) <= Date.parse(lesson.updatedAt)) throw new Error('Review must advance revision time');
  // ENG-918 is account-keyed. Do not promote client-derived evidence into a shared account.
  const users = await userDb.getAllUsers();
  if (!Array.isArray(users) || users.some(u => !u || typeof u.userId !== 'string')) throw new Error('Ownership unavailable');
  const owners = new Set(users.filter(u => getConnectedMetaAccountsList(u).some((a: { accountId: string }) => a.accountId === scope.accountId) || (typeof u.adAccount === 'string' && cleanAccountId(u.adAccount) === scope.accountId)).map(u => u.userId));
  if (scope.platform !== 'meta' || owners.size !== 1 || !owners.has(scope.userId)) return { applied: false, reason: 'ambiguous_account_ownership' };
  const paramKey = 'creativeFatigue.ctrDropCriticalPct';
  const existing = await getThreshold('meta', scope.accountId, paramKey);
  let parameter;
  let references = lesson.learning.references;
  if (action === 'approve') {
    if (lesson.learning.reviewState !== 'proposed' || lesson.learning.confidence !== 'directional') return { applied: false, reason: 'unsupported_learning' };
    const page = await getLearningRecommendations(scope.platform, scope.accountId);
    if (page.truncated) return { applied: false, reason: 'evidence_page_incomplete' };
    const effective = existing ? resolveThresholds([existing], new Date(scope.now))[paramKey] : undefined;
    const effectiveExisting = existing && effective ? { ...existing, currentValue: effective.value, source: effective.source } : existing;
    const proposal = proposeParameterLearning(page.rows.filter(r => r.context?.clientUserId === scope.userId && (!existing || Date.parse(r.scoredAt ?? '') > Date.parse(existing.updatedAt))), effectiveExisting, scope.now);
    if (!proposal.allowed) return { applied: false, reason: proposal.reason };
    if (!proposal.references.includes(lesson.learning.references[0])) return { applied: false, reason: 'outcome_already_consumed' };
    references = proposal.references;
    parameter = applyThresholdWrite({ accountId: scope.accountId, platform: 'meta', paramKey, value: proposal.value,
      source: 'learned', evidence: `Reviewed ${memoryId}; independent settled outcome references are retained on that account-memory revision.`,
      sampleSize: proposal.sampleSize, changedBy: scope.userId, changedAt: scope.now, existing });
  } else {
    if (!existing || lesson.learning.reviewState !== 'approved' || existing.source !== 'learned' || existing.updatedAt !== lesson.updatedAt) {
      return { applied: false, reason: 'parameter_changed_since_learning' };
    }
    parameter = buildThresholdRevert({ existing, changedBy: scope.userId, changedAt: scope.now, evidence: `Reverted ${memoryId}` });
  }
  if (action === 'revert') targetScope = lesson.learning.scope as 'client' | 'campaign' | 'channel';
  const state = action === 'approve' ? 'approved' as const : 'reverted' as const;
  const { campaignId: _campaign, channel: _channel, ...oldLearning } = lesson.learning;
  const next = { ...lesson, updatedAt: scope.now, learning: { ...oldLearning, scope: targetScope,
    ...(targetScope === 'campaign' ? { campaignId: lesson.learning.campaignId } : {}),
    ...(targetScope === 'channel' ? { channel: scope.platform } : {}), references,
    reviewState: state, updatedAt: scope.now,
    expiresAt: action === 'approve' ? new Date(Date.parse(scope.now) + 90 * 86400000).toISOString() : lesson.learning.expiresAt,
    history: [...lesson.learning.history, { state, at: scope.now, scope: targetScope, references }].slice(-20) } };
  await commitLearningReview(next, lesson, parameter, existing?.updatedAt ?? null);
  return { applied: true, lesson: next, parameter };
}

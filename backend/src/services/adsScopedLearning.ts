/** Qualitative lessons use AW-AccountMemory; numeric evidence stays in ENG-1550. */
import { createHash } from 'crypto';
import { evaluateThresholdWrite, type AdsThreshold } from './adsThresholds';
import type { Recommendation } from './outcomeLedger';
export const LEARNING_PREFIX = 'ads-learning#';
/** A safe domain refusal, distinct from dependency or implementation failures. */
export class LearningReviewConflict extends Error {}
export interface ScopedLesson {
  userId: string; memoryId: string; category: 'insight'; content: string; createdAt: string; updatedAt: string;
  learning: {
    scope: 'global' | 'client' | 'campaign' | 'channel'; accountId: string; platform: string;
    campaignId?: string; channel?: string; references: string[]; confidence: 'directional' | 'unsupported';
    reviewState: 'proposed' | 'approved' | 'reverted'; createdAt: string; updatedAt: string; expiresAt: string;
    history: Array<{ state: string; at: string; scope?: string; references?: string[] }>;
  };
}
export function buildOutcomeLesson(r: Recommendation): ScopedLesson | null {
  if (!r.context || r.context.metricScope !== 'campaign' || (r.verdict !== 'correct' || r.adopted !== true) || r.status !== 'scored' || !r.scoredAt) return null;
  const reference = `${r.platform}#${r.accountId}/${r.recommendationId}`;
  return {
    userId: r.context.clientUserId, memoryId: LEARNING_PREFIX + createHash('sha256').update(reference).digest('hex'),
    category: 'insight', createdAt: r.scoredAt, updatedAt: r.scoredAt,
    content: 'The settled campaign comparison supported the predicted direction. This is observational evidence, not proof of causality; review the linked outcome before reuse.',
    learning: {
      scope: 'campaign', accountId: r.accountId, platform: r.platform, campaignId: r.context.campaignId,
      references: [reference, ...(r.context.execution ? [r.context.execution.reference] : [])],
      confidence: 'directional', reviewState: 'proposed',
      createdAt: r.scoredAt, updatedAt: r.scoredAt, expiresAt: new Date(Date.parse(r.scoredAt) + 90 * 86400000).toISOString(),
      history: [{ state: 'proposed', at: r.scoredAt }],
    },
  };
}
export interface LearningScope { userId: string; accountId: string; platform: string; campaignId?: string; now: string }
export function resolveScopedLessons(items: unknown[], scope: LearningScope): ScopedLesson[] {
  const now = Date.parse(scope.now);
  if (!Number.isFinite(now)) throw new Error('Invalid learning clock');
  // Policy is code-owned. No tenant can write global context through account memory.
  const global: ScopedLesson = { userId: scope.userId, memoryId: 'ads-policy-v1', category: 'insight',
    content: 'Shadow learning is advisory. Explicit user parameters take precedence. Never increase spend or execute a campaign change from learned guidance alone.',
    createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    learning: { scope: 'global', accountId: scope.accountId, platform: scope.platform, references: ['ENG-502', 'ENG-918'],
      confidence: 'unsupported', reviewState: 'approved', createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
      expiresAt: '9999-01-01T00:00:00.000Z', history: [] } };
  const rank = { client: 1, campaign: 2, channel: 3 };
  const valid = items.slice(0, 100).filter((raw): raw is ScopedLesson => {
    const x = raw as ScopedLesson, l = x?.learning;
    return !!x && typeof x === 'object' && x.userId === scope.userId && typeof x.memoryId === 'string' &&
      typeof x.content === 'string' && x.content.length <= 2000 && !!l && typeof l === 'object' &&
      l.accountId === scope.accountId && l.platform === scope.platform && ['client', 'campaign', 'channel'].includes(l.scope) &&
      ['proposed', 'approved'].includes(l.reviewState) && l.confidence === 'directional' &&
      Number.isFinite(Date.parse(l.createdAt)) && Number.isFinite(Date.parse(l.updatedAt)) && Date.parse(l.expiresAt) > now &&
      Array.isArray(l.references) && l.references.length > 0 && l.references.length <= 40 && l.references.every(r => typeof r === 'string' && r.length <= 2000) &&
      Array.isArray(l.history) && l.history.length <= 20 && l.history.every(h => h && typeof h.state === 'string' && Number.isFinite(Date.parse(h.at))) &&
      // Narrower stored scope never broadens when the caller omitted it.
      (!l.campaignId || l.campaignId === scope.campaignId) && (l.scope !== 'campaign' || !!l.campaignId) &&
      (l.scope !== 'channel' || l.channel === scope.platform);
  });
  valid.sort((a, b) => rank[a.learning.scope as keyof typeof rank] - rank[b.learning.scope as keyof typeof rank] ||
    b.learning.updatedAt.localeCompare(a.learning.updatedAt) || a.memoryId.localeCompare(b.memoryId));
  return [global, ...valid.slice(0, 19)];
}
/** Only independent, correct campaign outcomes support a CTR detector proposal. No causal claim. */
export function proposeParameterLearning(rows: Recommendation[], existing: AdsThreshold | null, now: string) {
  const receipts = new Set<string>();
  const windows = new Map<string, Array<{ since: string; until: string }>>();
  const values: number[] = [];
  const references: string[] = [];
  const first = rows.find(r => r.context)?.context?.clientUserId;
  const account = rows[0]?.accountId, platform = rows[0]?.platform;
  for (const r of [...rows].slice(0, 100).sort((a, b) => a.recommendationId.localeCompare(b.recommendationId))) {
    const c = r.context, e = c?.execution;
    if (!c || c.clientUserId !== first || r.accountId !== account || r.platform !== platform ||
      r.status !== 'scored' || r.verdict !== 'correct' || r.adopted !== true || c.metricScope !== 'campaign' ||
      !r.scoredAt || Date.parse(r.scoredAt) > Date.parse(now) || Date.parse(r.scoredAt) < Date.parse(now) - 90 * 86400000 ||
      !e || !e.adopted || receipts.has(e.reference)) continue;
    const evidence = c.evidence.find(x => x.metric === 'ctr_drop_pct');
    if (!evidence || !Number.isFinite(evidence.value) || evidence.value <= 0 || evidence.value > 100) continue;
    const seen = windows.get(c.campaignId) ?? [];
    if (seen.some(w => w.since <= c.sourceWindow.until && w.until >= c.sourceWindow.since)) continue;
    seen.push({ since: c.sourceWindow.since, until: r.evaluationDate?.slice(0, 10) ?? c.sourceWindow.until }); windows.set(c.campaignId, seen); receipts.add(e.reference);
    values.push(evidence.value); references.push(`${r.platform}#${r.accountId}/${r.recommendationId}`);
  }
  values.sort((a, b) => a - b);
  const requestedValue = values.length ? values[Math.floor(values.length / 2)] : 20;
  const verdict = evaluateThresholdWrite({ paramKey: 'creativeFatigue.ctrDropCriticalPct', requestedValue,
    source: 'learned', sampleSize: values.length, existing, at: new Date(now) });
  return { ...verdict, sampleSize: values.length, references };
}

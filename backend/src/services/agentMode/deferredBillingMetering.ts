/**
 * Deferred billing-subject resolution for LLM metering (ENG-1858).
 *
 * Extracted from agentModeService.ts, which only wires it into callLLM's
 * metering step. See the section comment below for why the billing subject is
 * resolved here, at metering time, rather than at each call site.
 */
import { meterUserUsage, meterUserUsageAsync } from '../usageRecorderService';
import { cronJobRegistry } from '../../utils/cronJobRegistry';

// ─── ENG-1858: billing subject for auxiliary-call metering ───────────────────
//
// Auxiliary LLM calls (titles, summaries, judges, diagnostics, vision checks,
// onboarding, enrichment…) now carry the acting user's `userId`, but not the
// ENG-1217 billing subject — resolving it at every call site would put two
// DynamoDB reads, and a new failure mode, in front of each of those calls. It is
// resolved here instead, at metering time, after the response already exists:
// fire-and-forget and fail-open, so it can neither delay nor break the LLM call.
//
// Only the ledger's descriptive `billingUserId` attribute depends on this: the
// legacy per-user cap charge (retired, ENG-2286) used to resolve the org pool itself.
// The agent loop already passes `billingUserId`, so its metering takes the
// synchronous path below exactly as before.
//
// 60s cache: a burst of auxiliary calls for one user (title + chips + judges in
// one turn) resolves once. Staleness is acceptable because the value only labels
// who paid on the ledger row, org membership changes are rare, and the cap
// charge — the enforced number — never reads this cache.
const BILLING_SUBJECT_CACHE_TTL_MS = 60_000;
const BILLING_SUBJECT_CACHE_MAX_ENTRIES = 1_000;
const billingSubjectCache = new Map<string, { value: Promise<string>; expiresAt: number }>();

function resolveBillingUserIdCached(userId: string): Promise<string> {
  const now = Date.now();
  const hit = billingSubjectCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) billingSubjectCache.delete(userId);

  // Lazy for the same reason as the agent loop's resolveBillingSubject:
  // tokenUsageService pulls in the db -> aws config graph.
  const { resolveBillingUserId } = require('../tokenUsageService') as typeof import('../tokenUsageService');
  // Several suites replace tokenUsageService with a partial mock (see
  // resolveBillingSubject); surface that synchronously so the caller meters as before.
  if (typeof resolveBillingUserId !== 'function') {
    throw new Error('tokenUsageService.resolveBillingUserId is unavailable');
  }
  // The in-flight promise is cached, so concurrent calls share one lookup.
  const value = Promise.resolve()
    .then(() => resolveBillingUserId(userId))
    .then((billingUserId) => billingUserId || userId);
  // A failed lookup is never cached: the next call retries instead of pinning
  // the fallback for a minute.
  value.catch(() => {
    if (billingSubjectCache.get(userId)?.value === value) billingSubjectCache.delete(userId);
  });
  if (billingSubjectCache.size >= BILLING_SUBJECT_CACHE_MAX_ENTRIES) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    const oldest = billingSubjectCache.keys().next().value;
    if (oldest !== undefined) billingSubjectCache.delete(oldest);
  }
  billingSubjectCache.set(userId, { value, expiresAt: now + BILLING_SUBJECT_CACHE_TTL_MS });
  return value;
}

/**
 * Meter an LLM call, filling in the billing subject when the caller supplied a
 * user but not who pays for them. Never throws and never returns a promise the
 * caller could await: a context that already has `billingUserId` (the agent
 * loop) or has no user is metered synchronously and unchanged.
 */
export function meterWithResolvedBilling(ctx: Parameters<typeof meterUserUsage>[0]): void {
  if (!ctx.userId || ctx.billingUserId) {
    meterUserUsage(ctx);
    return;
  }
  const userId = ctx.userId;
  let billing: Promise<string>;
  try {
    billing = resolveBillingUserIdCached(userId);
  } catch (err) {
    // The resolver could not even be loaded (e.g. a partially mocked module).
    // Meter exactly as before this existed rather than lose the row.
    console.error(`[AgentMode] ENG-1858: billing resolver unavailable for ${userId}; metering without billingUserId:`, err);
    meterUserUsage(ctx);
    return;
  }
  const deferred = billing
    .catch((err) => {
      console.error(`[AgentMode] ENG-1858: failed to resolve billing user for ${userId} (${ctx.feature}); billing to the acting user:`, err);
      return userId;
    })
    // meterUserUsageAsync, not meterUserUsage: the tracked promise must settle
    // only when the usage row is written, or the drain below
    // would wait for nothing (CodeRabbit, PR #2926).
    .then((billingUserId) => meterUserUsageAsync({ ...ctx, billingUserId }))
    .catch((err) => console.error('[AgentMode] ENG-1858: metering after billing resolution failed:', err));
  // Tracked so a graceful shutdown waits for the writes (CodeRabbit, PR #2926):
  // the response has already gone out, and without this a deploy that stops the
  // process between the response and the resolved write would lose the usage
  // row. server.ts's runDrain already awaits
  // cronJobRegistry.drain(). Still never awaited here — the LLM call path does
  // not wait on metering.
  void cronJobRegistry.track('deferredLlmMetering', deferred);
}

/**
 * heatScoreService (C1 — CRM Unification v1).
 *
 * Computes a 0-100 heat score per Contact to rank prospects for outreach.
 * Pure scoring logic lives in `computeHeatScore(signals)`; the async
 * `computeForContact(contactId)` wrapper is wired up once the sync endpoint
 * and AW-Leads email-index GSI are in place (follow-up tasks B1, D2).
 *
 * Rules (spec — https://www.notion.so/34209247c9518183b99fd037d6884f6c):
 *   +25 has AW-Users record (signed up)
 *   +40 has active Stripe subscription (paying or trialing)
 *   +20 status in {qualified, proposal_sent, negotiating} OR open Deal at Qualified+
 *   +15 recent engagement event <7d old
 *   +10 isICP === true
 *   -50 contactStatus !== 'active' (do-not-contact, unsubscribed)
 *   Clamp 0-100
 *   Do-not-contact is clamped <50 regardless of positive signals.
 */

export interface HeatScoreSignals {
  /** Has an AW-Users record linked (self-signed-up) */
  hasUserRecord?: boolean;
  /** Active paid or trialing Stripe subscription */
  hasActiveSubscription?: boolean;
  /** Current sales status on the Lead row */
  status?: string | null;
  /** Stages of any open Deals this contact is on */
  openDealStages?: string[];
  /** ISO timestamp of the most recent engagement event (any source) */
  lastEngagementAt?: string | null;
  /** ICP match flag */
  isICP?: boolean;
  /** Contact opt-in state */
  contactStatus?: 'active' | 'do-not-contact' | 'unsubscribed' | null;
}

/** Statuses that indicate the lead is in-flight with sales. */
const ACTIVE_SALES_STATUSES = new Set(
  ['qualified', 'proposal_sent', 'negotiating'].map(s => s.toLowerCase())
);

/** Deal stages that count as 'qualified or better'. */
const QUALIFIED_DEAL_STAGES = new Set(
  ['Qualified', 'Demo', 'Proposal', 'Negotiation', 'Won'].map(s => s.toLowerCase())
);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Ceiling applied when the contact is explicitly do-not-contact / unsubscribed. */
const OPTED_OUT_CEILING = 49;

/**
 * Pure synchronous scorer — deterministic, cheap, easy to test.
 * `now` is injected so tests can pin the clock.
 */
export function computeHeatScore(signals: HeatScoreSignals, now: Date = new Date()): number {
  let score = 0;

  if (signals.hasUserRecord) score += 25;
  if (signals.hasActiveSubscription) score += 40;

  const statusLower = (signals.status || '').toString().toLowerCase().trim();
  const hasActiveStatus = statusLower.length > 0 && ACTIVE_SALES_STATUSES.has(statusLower);
  const hasQualifiedDeal = (signals.openDealStages || []).some(stage =>
    QUALIFIED_DEAL_STAGES.has(String(stage).toLowerCase())
  );
  if (hasActiveStatus || hasQualifiedDeal) score += 20;

  if (signals.lastEngagementAt) {
    const ts = Date.parse(signals.lastEngagementAt);
    if (!Number.isNaN(ts)) {
      const ageMs = now.getTime() - ts;
      if (ageMs >= 0 && ageMs <= SEVEN_DAYS_MS) score += 15;
    }
  }

  if (signals.isICP === true) score += 10;

  // Hard penalty for opted-out contacts: the spec says do-not-contact / unsubscribed
  // should always land under 50 regardless of other positive signals.
  const isOptedOut =
    signals.contactStatus === 'do-not-contact' || signals.contactStatus === 'unsubscribed';
  if (isOptedOut) {
    score -= 50;
  }

  // Clamp 0-100.
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  // Belt-and-suspenders: opted-out cannot exceed the ceiling even if someone
  // later tweaks the arithmetic above.
  if (isOptedOut && score > OPTED_OUT_CEILING) {
    score = OPTED_OUT_CEILING;
  }

  return score;
}

/**
 * Async wrapper that fetches the signals for a contact and computes the score.
 * Wired to real data sources in follow-up PRs (depends on B1 + D2). For now
 * this is a thin orchestration layer so downstream callers can already depend
 * on the stable signature.
 */
export async function computeForContact(
  contactId: string,
  fetchers: {
    loadSignals: (contactId: string) => Promise<HeatScoreSignals>;
  }
): Promise<number> {
  const signals = await fetchers.loadSignals(contactId);
  return computeHeatScore(signals);
}

/**
 * Batch recomputation helper — used by migration scripts and by bulk POC
 * reassignment flows. Returns a Map<contactId, score>.
 */
export async function recomputeBatch(
  contactIds: string[],
  fetchers: { loadSignals: (contactId: string) => Promise<HeatScoreSignals> }
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  // Sequential is fine at current scale (spec calls for per-hook recompute, not
  // continuous bulk). Callers that want parallelism can p-map at the callsite.
  for (const id of contactIds) {
    results.set(id, await computeForContact(id, fetchers));
  }
  return results;
}

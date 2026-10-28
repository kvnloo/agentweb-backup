/**
 * ENG-2716 (child of ENG-2715): pre-run cost estimate for CRM enrich-v3.
 *
 * Pure, vendor-free. Per-lead rates are calibrated from the Opiner run of
 * 2026-10-27 (112 leads -> $31.60 actual): Apollo full-contact $0.445 on ~30%
 * of leads, LLM extraction, match/lookup calls, and web search. Apollo misses
 * still incur the lookup/LLM/web cost, so they are priced into every lead.
 */
import { createHash } from 'crypto';

export const ENRICHMENT_COST_RATES_USD = {
  /** Apollo full-contact reveal price. */
  apolloFullContact: 0.445,
  /** Share of leads that end up buying a full contact (Opiner: 34/112). */
  apolloRevealRate: 34 / 112,
  /** LLM extraction cost per lead (Opiner: $8.47 / 112). */
  llmPerLead: 8.47 / 112,
  /** Match / lookup calls per lead, paid on hits and misses (Opiner: $3.61 / 112). */
  lookupPerLead: 3.61 / 112,
  /** Web search per lead (Opiner: $1.37 / 112). */
  webSearchPerLead: 1.37 / 112,
  /**
   * Unattributed remainder of the Opiner run ($31.60 minus the itemised
   * $28.58), spread per lead so the reference run reproduces exactly.
   */
  otherPerLead: (31.6 - 15.13 - 8.47 - 3.61 - 1.37) / 112,
} as const;

export interface EnrichmentCostEstimate {
  leadCount: number;
  perLeadUsd: number;
  totalUsd: number;
  breakdownUsd: { apollo: number; llm: number; lookups: number; webSearch: number; other: number };
  /** Opaque token the client echoes back to confirm this exact estimate. */
  confirmationToken: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimateEnrichmentCost(listId: string, leadCount: number): EnrichmentCostEstimate {
  const n = Number.isFinite(leadCount) && leadCount > 0 ? Math.floor(leadCount) : 0;
  const r = ENRICHMENT_COST_RATES_USD;
  const apollo = n * r.apolloFullContact * r.apolloRevealRate;
  const llm = n * r.llmPerLead;
  const lookups = n * r.lookupPerLead;
  const webSearch = n * r.webSearchPerLead;
  const other = n * r.otherPerLead;
  const total = apollo + llm + lookups + webSearch + other;
  const totalUsd = round2(total);
  return {
    leadCount: n,
    perLeadUsd: n ? round2(total / n) : 0,
    totalUsd,
    breakdownUsd: {
      apollo: round2(apollo),
      llm: round2(llm),
      lookups: round2(lookups),
      webSearch: round2(webSearch),
      other: round2(other),
    },
    confirmationToken: confirmationTokenFor(listId, n, totalUsd),
  };
}

export function confirmationTokenFor(listId: string, leadCount: number, totalUsd: number): string {
  return createHash('sha256')
    .update(`enrich-v3-estimate:v1:${listId}:${leadCount}:${totalUsd.toFixed(2)}`)
    .digest('hex')
    .slice(0, 32);
}

export type ConfirmationCheck = { ok: true } | { ok: false; reason: 'missing' | 'stale' };

/**
 * Back-compatible gate: a supplied token must match the current estimate.
 * A missing token is rejected only when `required` (env
 * ENRICH_V3_REQUIRE_COST_CONFIRMATION=true), which flips on once the portal
 * confirm dialog ships.
 */
export function checkEstimateConfirmation(
  supplied: unknown,
  estimate: EnrichmentCostEstimate,
  required: boolean,
): ConfirmationCheck {
  if (typeof supplied !== 'string' || supplied.length === 0) {
    return required ? { ok: false, reason: 'missing' } : { ok: true };
  }
  return supplied === estimate.confirmationToken ? { ok: true } : { ok: false, reason: 'stale' };
}

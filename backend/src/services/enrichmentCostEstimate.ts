/**
 * ENG-2716 (child of ENG-2715): pre-run cost estimate for CRM enrich-v3.
 *
 * Pure, vendor-free. Per-lead shares are calibrated from the Opiner run of
 * 2026-10-27 (112 leads -> $31.60 actual at the time): Apollo broker waterfall on
 * ~30% of leads, LLM extraction, match/lookup calls, and web search. Apollo misses
 * still incur the lookup/LLM/web cost, so they are priced into every lead.
 *
 * ENG-2720: the Apollo line is read from the vendor rate card (the same number
 * the ledger books) instead of a hardcoded price, and the LLM line is the
 * measured Luna cost, so this estimate tracks what the run will actually book.
 * With both applied the Opiner reference run estimates ~$13.6, down from $31.60.
 */
import { createHash } from 'crypto';
import { getAllocatedRate } from '../utils/vendorRateCard';

export const ENRICHMENT_COST_RATES_USD = {
  /** Share of leads that trigger the Apollo broker waterfall (Opiner: 34/112; prod-wide ~28%). */
  apolloRevealRate: 34 / 112,
  /**
   * LLM extraction plus OpenRouter web-search cost per lead, booked. Enrichment moved from
   * gpt-5.5 (Opiner: $8.47 / 112 = $0.076) to gpt-5.6-luna (ENG-2720). Measured on the real
   * Opiner list: ~$0.0027 of tokens plus ~$0.015 of OpenRouter search fees (158 searches over
   * 73 leads), ~$0.018 all-in; the ledger now books both (agentModeService BYOK cost).
   * Rounded up to $0.02. Not model-aware: an org on another model, or the
   * CRM_ENRICH_V3_DEFAULT_MODEL=gpt-5.5 rollback, books ~4x more per lead than this.
   */
  llmPerLead: 0.02,
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
  // Fail loud rather than estimate $0 if the key is ever removed from the card.
  const apolloWaterfallUsd = getAllocatedRate('apollo', 'waterfall_email');
  if (apolloWaterfallUsd === null) throw new Error('Apollo waterfall_email rate unavailable');
  const apollo = n * apolloWaterfallUsd * r.apolloRevealRate;
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

/**
 * Normalize a client lead selection. An absent or empty array means "whole
 * list" (the enrich run already treats it that way), so the estimate must
 * price the same leads the run will process.
 */
export function normalizeLeadSelection(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((id: unknown): id is string => typeof id === 'string');
  return ids.length > 0 ? ids : undefined;
}

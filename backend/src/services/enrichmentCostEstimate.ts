/**
 * ENG-2716 (child of ENG-2715): pre-run cost estimate for CRM enrich-v3.
 *
 * Pure arithmetic over the rate card (no vendor calls, no I/O; the confirmation token reads the server secret). Per-lead shares are calibrated from the Opiner run of
 * 2026-10-27 (112 leads -> $31.60 actual at the time): Apollo broker waterfall on
 * ~30% of leads, LLM extraction, match/lookup calls, and web search. Apollo misses
 * still incur the lookup/LLM/web cost, so they are priced into every lead.
 *
 * ENG-2720: the Apollo line is read from the vendor rate card (the same number
 * the ledger books) instead of a hardcoded price, and the LLM line is the
 * measured Luna cost, so this estimate tracks what the run will actually book.
 * With the LLM line updated the Opiner reference run estimates ~$25.4, down from $31.60 (Apollo stays at the 9-credit $0.445 per the owner's 2026-11-02 decision). The LLM line
 * scales with the saved config's field count and the Apollo line with the leads that lack an
 * email; customers see the result as a percent of their allowance, never as dollars.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { getAllocatedRate } from '../utils/vendorRateCard';

export const ENRICHMENT_COST_RATES_USD = {
  /** Share of leads that trigger the Apollo broker waterfall (Opiner: 34/112; prod-wide ~28%). */
  apolloRevealRate: 34 / 112,
  /**
   * LLM extraction plus OpenRouter web-search cost per web field per lead, booked. Enrichment moved
   * from gpt-5.5 (Opiner: $8.47 / 112 leads) to gpt-5.6-luna (ENG-2720). Measured on the real Opiner
   * list with 10 fields: ~$0.0027 of tokens plus ~$0.015 of OpenRouter search fees (158 searches over
   * 73 leads), ~$0.018 per lead all-in, ~$0.0018 per field; rounded up to $0.002. Scaling with the
   * saved config's field count keeps the quote honest for wide configs. Not model-aware: an org on
   * another model, or the CRM_ENRICH_V3_DEFAULT_MODEL=gpt-5.5 rollback, books more than this default; the
   * customer quote passes a model-aware figure (`fieldCostUsd`) and uses this one only as the Luna fallback.
   */
  llmPerFieldPerLead: 0.002,
  /** Field count the reference run (and the measurement above) used; also the default when no config is saved yet. */
  referenceFieldCount: 10,
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

export interface EstimateInputs {
  /**
   * Leads in the run that have no email. Only those can trigger the Apollo broker (the identity
   * resolver skips it when an email is already known), so a list where every lead has an email is
   * quoted no Apollo line. Defaults to every lead (the previous behaviour). The observed 34/112 broker
   * share is applied to this count, so the line never exceeds what it was before.
   */
  emaillessCount?: number;
  /** Included fields plus smart-field dependencies in the saved config. Defaults to the reference config. */
  fieldCount?: number;
  /** USD one Enigma card-revenue fetch books per lead; set only when the config asks for a card-revenue field the user may buy. */
  enigmaPerLeadUsd?: number;
  /** Expected booked cost of one web field for one lead on the enrichment model (model-aware); defaults to the Luna figure. */
  fieldCostUsd?: number;
  /** Whose quote this is: bound into the confirmation token so one user's token cannot confirm another's run. */
  userId?: string;
}

export function estimateEnrichmentCost(listId: string, leadCount: number, inputs: EstimateInputs = {}): EnrichmentCostEstimate {
  const n = Number.isFinite(leadCount) && leadCount > 0 ? Math.floor(leadCount) : 0;
  const r = ENRICHMENT_COST_RATES_USD;
  const emailless = Number.isFinite(inputs.emaillessCount) ? Math.min(n, Math.max(0, Math.floor(inputs.emaillessCount as number))) : n;
  const fields = Number.isFinite(inputs.fieldCount) && (inputs.fieldCount as number) > 0 ? Math.floor(inputs.fieldCount as number) : r.referenceFieldCount;
  // Fail loud rather than estimate $0 if the key is ever removed from the card.
  const apolloWaterfallUsd = getAllocatedRate('apollo', 'waterfall_email');
  if (apolloWaterfallUsd === null) throw new Error('Apollo waterfall_email rate unavailable');
  const apollo = emailless * apolloWaterfallUsd * r.apolloRevealRate;
  const perField = Number.isFinite(inputs.fieldCostUsd) && (inputs.fieldCostUsd as number) > 0 ? (inputs.fieldCostUsd as number) : r.llmPerFieldPerLead;
  const llm = n * fields * perField;
  const enigmaPerLead = Number.isFinite(inputs.enigmaPerLeadUsd) && (inputs.enigmaPerLeadUsd as number) > 0 ? (inputs.enigmaPerLeadUsd as number) : 0;
  const lookups = n * r.lookupPerLead;
  const webSearch = n * r.webSearchPerLead;
  const other = n * r.otherPerLead + n * enigmaPerLead;
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
    confirmationToken: confirmationTokenFor(inputs.userId ?? '', listId, n, totalUsd),
  };
}

/**
 * What a customer may see of an estimate (ENG-1212: no dollar figures, no vendor breakdown, which
 * would expose our allocated rates). The dollar total stays server-side: it feeds the confirmation
 * token and the allowance projection only.
 */
export interface CustomerEnrichmentEstimate {
  leadCount: number;
  /** Share of the monthly usage allowance this run is expected to use, percent (2 decimals under 1%, otherwise 1); null when the plan has no dollar allowance. */
  estimatedPercentOfAllowance: number | null;
  /** Whether the run is expected to be admitted against the remaining allowance (conservative check). */
  withinAllowance: boolean;
  /** Echo back as `confirmEstimateToken` on the enrich-v3 POST. */
  confirmationToken: string;
}

export function toCustomerEstimate(
  estimate: EnrichmentCostEstimate,
  allowance: { percent: number | null; withinAllowance: boolean },
): CustomerEnrichmentEstimate {
  return {
    leadCount: estimate.leadCount,
    estimatedPercentOfAllowance: allowance.percent,
    withinAllowance: allowance.withinAllowance,
    confirmationToken: estimate.confirmationToken,
  };
}

/**
 * Opaque confirmation token for one quote. It is an HMAC under a server secret and bound to the user, so a
 * customer cannot brute-force it back into the dollar total it commits to (an unkeyed hash of
 * list id + lead count + total was recoverable in milliseconds, which would have leaked our allocated
 * rates through the very quote that hides them). Stable across instances: the secret is the shared JWT secret.
 */
export function confirmationTokenFor(userId: string, listId: string, leadCount: number, totalUsd: number): string {
  // A derived subkey keeps this use of the shared secret separate from JWT signing (domain separation).
  const key = createHmac('sha256', getJwtSecret()).update('agentweb:enrich-v3-quote-token:key:v1').digest();
  return createHmac('sha256', key)
    .update(`enrich-v3-estimate:v2:${userId}:${listId}:${leadCount}:${totalUsd.toFixed(2)}`)
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
  const a = Buffer.from(supplied);
  const b = Buffer.from(estimate.confirmationToken);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'stale' };
}

/**
 * Normalize a client lead selection. An absent or empty array means "whole
 * list" (the enrich run already treats it that way), so the estimate must
 * price the same leads the run will process.
 */
export function normalizeLeadSelection(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // De-duplicated: DynamoDB's batch read rejects duplicate keys, and a repeated id must neither inflate the
  // quote nor be processed twice, so the quote and the run both see each id once.
  const ids = Array.from(new Set(raw.filter((id: unknown): id is string => typeof id === 'string')));
  return ids.length > 0 ? ids : undefined;
}

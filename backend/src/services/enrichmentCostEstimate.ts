/**
 * ENG-2716 (child of ENG-2715): pre-run cost estimate for CRM enrich-v3.
 *
 * Pure arithmetic over the rate card (no vendor calls, no I/O; the confirmation token reads the server secret).
 * Per contact: Apollo match/org lookups and web search as booked on prod, the LLM line per web field, and the
 * Apollo broker waterfall for emailless leads it can actually be sent for. The constants are calibrated on what
 * prod booked (see ENRICHMENT_COST_RATES_USD); the Apollo price is read from the vendor rate card (the same
 * number the ledger books, $0.445 per the owner's 2026-11-02 decision). Customers see the result as a percent
 * of their allowance, never as dollars.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { getAllocatedRate } from '../utils/vendorRateCard';

/**
 * Recalibrated 2026-11-12 (ENG-2720) against what prod actually booked. Customer runs since the 2026-11-04 changes
 * (prod logs `runEnrichment DONE` joined to the `AW-UsageRecords` ledger by user and day; test accounts excluded):
 * 118 processed contacts, 4 customers, $8.09 booked ($0.0686 per contact, $0.0661 of it before the one Apollo
 * broker request); the previous constants quoted $14.4-14.8 for those runs (+78% to +83% depending on the field
 * count), about 60% of it from the Apollo line.
 *
 * The per-contact lines are per PROCESSED contact. A lead the identity resolver skips (no usable email, no LinkedIn,
 * no first and last name) books nothing, so it is left out of them (`skippedCount`): in one of those runs 54 of 84
 * leads were skipped. The Apollo broker (group tier 3.5a, the only path in a v3 run: resolver step 6.5 needs a lead
 * hint it never gets) fires for a lead that still lacks an email and has a first and last name plus a company or
 * email domain on the lead. Prod logs show 60 of 146 such leads firing it on one list (41%); a few emailed leads
 * with no fresh email metadata also fire it when Apollo has no person for them (2 of ~203 emailed leads Nov 3-10,
 * about +$0.004 per emailed lead, not modelled).
 *
 * Backtest, from the same prod data the constants come from (so a fit, not a validation): Nov 4+ runs quote $7.80
 * without the one broker request vs $8.09 booked (-4%); the 11-03 list with 146 eligible leads $36.94 vs $37.19
 * booked (-1%). Per run the error is large, because booked cost per contact depends on what Apollo already has
 * cached (the cache is shared across customers) and on how many distinct companies a list spans: $0.009-$0.019
 * per contact for cache-served re-runs, $0.09-$0.14 for small cold runs, $0.072 for the 146-lead cold list. This is
 * the average across them, right in total and not for a single run.
 *
 * Known limits (see also the dev note): (1) the broker share (41%) was measured only on leads that have a LinkedIn
 * URL, where Apollo's LinkedIn match supplied the email for the rest; for eligible leads WITHOUT a LinkedIn URL it
 * is unmeasured (no customer list had any; the test account's synthetic leads always fire) and probably higher, up
 * to every such lead at $0.445. (2) Emailed leads with no fresh email metadata can fire the broker (above).
 * Re-check against the ledger as more runs land.
 */
export const ENRICHMENT_COST_RATES_USD = {
  /** Share of emailless leads with a first and last name plus a company/email domain that fire the Apollo broker (prod: 60/146). */
  apolloEligibleRate: 60 / 146,
  /**
   * Share of the remaining emailless leads (resolvable, but missing a name or company on the lead, so the broker may
   * be reached only after the resolver fills one in) assumed to fire it. Not measured on that bucket: this is the
   * Opiner list's overall share (34 of 112 leads, 2026-10-27, before the eligibility split).
   */
  apolloOtherRate: 34 / 112,
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
  /**
   * Apollo person match + org lookups per contact as booked (prod since 11-04: $2.673 + $2.128 over 118 contacts).
   * Cache hits are free, so this is below one paid match per contact (54 paid matches for 118 contacts).
   */
  lookupPerLead: (2.673 + 2.128) / 118,
  /** You.com web search per contact as booked (prod since 11-04: $1.113 over 118 contacts). */
  webSearchPerLead: 1.113 / 118,
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
   * quoted no Apollo line. Pass 0 when the saved config does not request an email. Defaults to every lead.
   */
  emaillessCount?: number;
  /**
   * Of the emailless leads, those with a first and last name plus a company or email domain on the lead: the ones
   * the Apollo broker can be sent for at once. Defaults to every emailless lead (the conservative reading when the
   * caller cannot tell).
   */
  brokerEligibleCount?: number;
  /**
   * Leads the identity resolver skips before any paid call (no usable email, no LinkedIn, no first and last name).
   * They book nothing, so they are left out of every per-lead cost line, and out of the Apollo line. Defaults to 0.
   */
  skippedCount?: number;
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
  const skipped = Number.isFinite(inputs.skippedCount) ? Math.min(n, Math.max(0, Math.floor(inputs.skippedCount as number))) : 0;
  const billable = n - skipped;
  // Skipped leads are all emailless and never eligible, so they come out of both Apollo buckets.
  const reachable = Math.max(0, emailless - skipped);
  const eligible = Number.isFinite(inputs.brokerEligibleCount)
    ? Math.min(reachable, Math.max(0, Math.floor(inputs.brokerEligibleCount as number)))
    : reachable;
  const otherEmailless = reachable - eligible;
  const apollo = (eligible * r.apolloEligibleRate + otherEmailless * r.apolloOtherRate) * apolloWaterfallUsd;
  const perField = Number.isFinite(inputs.fieldCostUsd) && (inputs.fieldCostUsd as number) > 0 ? (inputs.fieldCostUsd as number) : r.llmPerFieldPerLead;
  const llm = billable * fields * perField;
  const enigmaPerLead = Number.isFinite(inputs.enigmaPerLeadUsd) && (inputs.enigmaPerLeadUsd as number) > 0 ? (inputs.enigmaPerLeadUsd as number) : 0;
  const lookups = billable * r.lookupPerLead;
  const webSearch = billable * r.webSearchPerLead;
  const other = billable * enigmaPerLead;
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
    // JSON-encoded tuple, not a ':'-joined string: ('a:b','c') and ('a','b:c') must not produce the same token.
    .update(JSON.stringify(['enrich-v3-estimate:v3', userId, listId, leadCount, totalUsd.toFixed(2)]))
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

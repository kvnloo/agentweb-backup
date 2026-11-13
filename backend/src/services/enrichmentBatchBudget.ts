import type { EnrichmentConfig, OrchestratorDeps } from './crmEnrichmentServiceV3';
import { checkTokenUsage, TURN_ADMISSION } from './tokenUsageService';
import { getAllocatedRate } from '../utils/vendorRateCard';
import { getModelPrice } from '../utils/llmPricing';
import { isCardRevenueField } from './enrichmentGroups';
import { resolveModelForUser } from './modelRoles';
import { isEnigmaEnrichmentEnabledForUser } from './enigmaCardRevenueEnrichment';

const LUNA_MODEL = 'openrouter/openai/gpt-5.6-luna';
/**
 * Booked cost per web-tier field per lead on the default model, measured on the real Opiner list with
 * gpt-5.6-luna (ENG-2720): ~$0.0018 all-in (tokens ~$0.0003 + search fee ~$0.0015).
 */
const MEASURED_TOKENS_PER_FIELD_USD = 0.0003;
const MEASURED_SEARCH_PER_FIELD_USD = 0.0015;
/** Expected-quote floor per field per lead: the measured Luna figure rounded up. */
const EXPECTED_FIELD_FLOOR_USD = 0.002;
/** Admission reserves 10x the measured booked cost, never less than $0.02 (it was $0.10, sized for gpt-5.5). */
const WEB_FIELD_GUARD_MULTIPLE = 10;
const WEB_FIELD_GUARD_FLOOR_USD = 0.02;
/** Unpriced model: reserve 25x Luna's token price (about $0.09 per field, the same as gpt-5.5; a few dearer models such as gpt-4 and the $10/$50 aliases reserve more) instead of the floor. */
const UNPRICED_MODEL_PRICE_RATIO = 25;

/** How many times dearer (input + output price) the model is than Luna, at least 1; unpriced => UNPRICED_MODEL_PRICE_RATIO (gpt-5.5-sized, not the dearest case). */
function modelPriceRatio(model?: string): number {
  const luna = getModelPrice(LUNA_MODEL);
  const price = model ? getModelPrice(model) : luna;
  const blended = (p: { inPerM: number; outPerM: number }) => p.inPerM + p.outPerM;
  return luna && price ? Math.max(1, blended(price) / blended(luna)) : UNPRICED_MODEL_PRICE_RATIO;
}

/** Measured booked cost of one web field for one lead on this model: tokens scale with price, the search fee does not. */
function measuredFieldCostUsd(model?: string): number {
  return MEASURED_TOKENS_PER_FIELD_USD * modelPriceRatio(model) + MEASURED_SEARCH_PER_FIELD_USD;
}

/**
 * Per-field web/LLM reserve for the model enrichment will actually run: 10x the measured cost, floor
 * $0.02. So Luna (and cheaper) reserves the floor, while an org on gpt-5.5 or another premium model
 * reserves proportionally more.
 */
export function webFieldGuardUsd(model?: string): number {
  return Math.max(WEB_FIELD_GUARD_FLOOR_USD, WEB_FIELD_GUARD_MULTIPLE * measuredFieldCostUsd(model));
}

/** Expected (not reserved) booked cost of one web field for one lead on this model, for the customer quote. */
export function expectedFieldCostUsd(model?: string): number {
  return Math.max(EXPECTED_FIELD_FLOOR_USD, Math.ceil(measuredFieldCostUsd(model) * 1000) / 1000);
}

/**
 * Card-revenue fields are routed by `aliasFor || name` and are only bought when asked for by name
 * (isCardRevenueField). Enigma bills per value returned, once per lead however many card fields were
 * asked for: 12m revenue, yoy growth, and the brand name/website values that come back with them.
 */
export function wantsEnigma(config: EnrichmentConfig): boolean {
  return config.fields.some(field => field.include && isCardRevenueField(field.aliasFor || field.name));
}

/**
 * What one Enigma fetch books per lead, from the rate card. Enigma bills every value returned, including
 * rows we discard (enigmaGraphql.ts SEARCH_BRAND_QUERY: ~19 credits typical, 52 at worst).
 *  - 'expected': 12m revenue + yoy growth + 4 brand name/website values ($0.28), between typical and worst.
 *  - 'worstCase': 4 card-transaction rows at the 12m rate + name and 5 websites ($0.52), for the admission reserve.
 */
export function enigmaFetchUsd(kind: 'expected' | 'worstCase' = 'expected'): number {
  const rate = (key: string): number => {
    const value = getAllocatedRate('enigma', key);
    if (value === null || !Number.isFinite(value) || value < 0) throw new Error('Enrichment rate unavailable');
    return value;
  };
  return kind === 'worstCase'
    ? 4 * rate('card_revenue_12m') + 6 * rate('brand_attribute')
    : rate('card_revenue_12m') + rate('card_revenue_yoy_growth_12m') + 4 * rate('brand_attribute');
}

/** An Enigma fetch only happens when the config asks for a card-revenue field AND this user may buy Enigma (allowlist). */
export function enigmaApplies(config: EnrichmentConfig, userId: string): boolean {
  return wantsEnigma(config) && isEnigmaEnrichmentEnabledForUser(userId);
}

/** Included fields plus smart-field dependencies, at least 1: what the per-field cost scales with. */
export function effectiveFieldCount(config: EnrichmentConfig): number {
  const fields = config.fields.filter(field => field.include);
  const dependencyCount = fields.reduce((count, field) => count + (field.smartDependencies?.length ?? 0), 0);
  return Math.max(1, fields.length + dependencyCount);
}

/** The model enrichment's field calls will run on, mirroring enrichmentV3RealDeps (env overrides first, then the role). */
export async function enrichmentModelFor(userId: string): Promise<string> {
  try {
    return process.env.CRM_ENRICH_V3_WEB_SEARCH_MODEL
      || process.env.CRM_ENRICH_V3_EXTRACT_MODEL
      || await resolveModelForUser(userId, 'enrichment');
  } catch {
    return 'unresolved-enrichment-model'; // unpriced, so the reserve stays conservative
  }
}

/** Conservative admission estimate, not a price or a settlement calculation.
 * Per lead it reserves every vendor the identity chain can reach (Apollo match, the Apollo email
 * waterfall (once: it could fire at resolver tier 6.5 and again at group tier 3.5a, uncached, but prod shows
 * about one request per emailless lead and at $0.445 a second one is not worth reserving), Apollo org, enrich.so find and reverse lookups, two You.com searches), plus a
 * guard-banded web/LLM cost per field (scaled by the enrichment model's price; the 10x covers the
 * additional You.com queries made per field group) and, when the config asks for a card-revenue field
 * and the user may buy Enigma, one worst-case Enigma fetch.
 * It must stay above what a run books; tests pin that. Cached hits may cost less; unusually expensive
 * in-flight work may cost more. Only one bounded (20-lead) batch is ever admitted at a time.
 *
 * ENG-2720: dropped the enrich.so `phone_finder` line ($0.25 per lead; nothing in the backend
 * calls it), reserved Enigma only when it can actually be bought (it was $0.10 on every field),
 * stopped charging You.com four times per field, added the Apollo `person_match` call that was
 * missing, and replaced the gpt-5.5-sized $0.10 per-field band.
 */
export function estimateEnrichmentBatchMicroUsd(
  config: EnrichmentConfig,
  leadCount: number,
  model?: string,
  /** Whether this user may buy Enigma. Defaults to true: a pure estimate stays conservative unless told otherwise. */
  enigmaEnabled: boolean = true,
): number {
  const rate = (...args: Parameters<typeof getAllocatedRate>): number => {
    const value = getAllocatedRate(...args);
    if (value === null || !Number.isFinite(value) || value < 0) throw new Error('Enrichment rate unavailable');
    return value;
  };
  const identity = rate('apollo', 'person_match')
    + rate('apollo', 'waterfall_email')
    + rate('apollo', 'org_enrichment')
    + rate('enrich.so', 'email_lookup')
    + rate('enrich.so', 'reverse_lookup')
    + 2 * rate('you.com', 'query');
  const enigma = enigmaEnabled && wantsEnigma(config) ? enigmaFetchUsd('worstCase') : 0;
  const perLead = identity
    + effectiveFieldCount(config) * webFieldGuardUsd(model)
    + enigma;
  return Math.ceil(perLead * leadCount * 1_000_000);
}

/** Per-run local floor prevents an eventually-consistent ledger read from
 * reusing budget already admitted by this run. No usage records are rewritten.
 */
export function buildEnrichmentBudgetCheck(userId: string): NonNullable<OrchestratorDeps['checkBudget']> {
  let floorMicroUsd = 0;
  let month: string | undefined;
  return async ({ leadCount, config, phase }) => {
    const current = await checkTokenUsage(userId);
    if (!current.allowed) return false;
    if (month !== current.month) {
      month = current.month;
      floorMicroUsd = 0;
    }
    floorMicroUsd = Math.max(floorMicroUsd, Math.round((current.costUsed ?? 0) * 1_000_000));
    const estimate = estimateEnrichmentBatchMicroUsd(config, leadCount, await enrichmentModelFor(userId), isEnigmaEnrichmentEnabledForUser(userId));
    const projected = await checkTokenUsage(userId, {
      projectedCostMicroUsd: estimate,
      minimumCostUsedMicroUsd: floorMicroUsd,
    });
    if (!projected.allowed || projected.month !== month) return false;
    if (phase === 'batch') {
      // The existing admission path owns PAYG admission bookkeeping; forecasts
      // above are strictly read-only and cannot raise a cap or make a month billable.
      const admitted = await checkTokenUsage(userId, TURN_ADMISSION);
      if (!admitted.allowed || admitted.month !== month) return false;
      floorMicroUsd += estimate;
    }
    return true;
  };
}

/** Conservative admission reserve for a whole run, in micro-dollars, for the model this user's enrichment runs on. */
export async function admissionEstimateMicroUsd(userId: string, config: EnrichmentConfig, leadCount: number): Promise<number> {
  const count = Math.max(0, Math.floor(leadCount));
  return count === 0 ? 0 : estimateEnrichmentBatchMicroUsd(config, count, await enrichmentModelFor(userId), isEnigmaEnrichmentEnabledForUser(userId));
}

/**
 * ENG-2715/2720: read-only allowance projection for a pre-run quote. Strictly forecast-only (no
 * admission write, no enrichment).
 *  - `percent`: the EXPECTED cost as a share of the monthly dollar allowance in force (credits and
 *    pooling applied), 2 decimals under 1% and 1 otherwise, so no dollar amount ever leaves the server.
 *    It uses one usage read for the allowance and the cost we already hold, not the difference of two
 *    reads, so spend booked in between (or one read failing open to $0) cannot skew it. null when the
 *    plan has no dollar allowance.
 *  - `withinAllowance`: whether the CONSERVATIVE reserve would be admitted, so it predicts admission.
 */
export async function projectAllowance(
  userId: string,
  expectedMicroUsd: number,
  admissionMicroUsd: number = expectedMicroUsd,
): Promise<{ percent: number | null; withinAllowance: boolean }> {
  if (expectedMicroUsd <= 0 && admissionMicroUsd <= 0) return { percent: 0, withinAllowance: true };
  const [current, reserve] = await Promise.all([
    checkTokenUsage(userId),
    checkTokenUsage(userId, { projectedCostMicroUsd: Math.max(expectedMicroUsd, admissionMicroUsd) }),
  ]);
  const allowance = current.costAllowance;
  const expectedUsd = expectedMicroUsd / 1_000_000;
  const points = typeof allowance === 'number' && allowance > 0
    ? expectedUsd / allowance * 100
    : allowance === null || allowance === undefined ? null : expectedUsd > 0 ? 100 : 0;
  return {
    percent: points === null ? null : points < 1 ? Math.round(points * 100) / 100 : Math.round(points * 10) / 10,
    withinAllowance: reserve.allowed === true,
  };
}

import type { EnrichmentConfig, OrchestratorDeps } from './crmEnrichmentServiceV3';
import { checkTokenUsage, TURN_ADMISSION } from './tokenUsageService';
import { getAllocatedRate } from '../utils/vendorRateCard';
import { getModelPrice } from '../utils/llmPricing';
import { isCardRevenueField } from './enrichmentGroups';
import { resolveModelForUser } from './modelRoles';

/**
 * Booked cost per web-tier field per lead on the default model, measured on the real Opiner list with
 * gpt-5.6-luna (ENG-2720): ~$0.0018 all-in (tokens ~$0.0003 + search fee ~$0.0015).
 */
const LUNA_MODEL = 'openrouter/openai/gpt-5.6-luna';
const MEASURED_TOKENS_PER_FIELD_USD = 0.0003;
const MEASURED_SEARCH_PER_FIELD_USD = 0.0015;
/** Admission reserves 10x the measured booked cost, never less than $0.02 (it was $0.10, sized for gpt-5.5). */
const WEB_FIELD_GUARD_MULTIPLE = 10;
const WEB_FIELD_GUARD_FLOOR_USD = 0.02;
/** Unpriced model: assume it is as expensive as the dearest model enrichment could be pointed at. */
const UNPRICED_MODEL_PRICE_RATIO = 25;

/**
 * Per-field web/LLM reserve for the model enrichment will actually run. Token cost scales with the
 * model's price against Luna's; the OpenRouter search fee does not. So Luna (and cheaper) reserves the
 * floor, while an org on gpt-5.5 or another premium model reserves proportionally more.
 */
export function webFieldGuardUsd(model?: string): number {
  const luna = getModelPrice(LUNA_MODEL);
  const price = model ? getModelPrice(model) : luna;
  const blended = (p: { inPerM: number; outPerM: number }) => p.inPerM + p.outPerM;
  const ratio = luna && price ? Math.max(1, blended(price) / blended(luna)) : UNPRICED_MODEL_PRICE_RATIO;
  return Math.max(
    WEB_FIELD_GUARD_FLOOR_USD,
    WEB_FIELD_GUARD_MULTIPLE * (MEASURED_TOKENS_PER_FIELD_USD * ratio + MEASURED_SEARCH_PER_FIELD_USD),
  );
}

/** The model enrichment's field calls will run on, mirroring enrichmentV3RealDeps (env overrides first, then the role). */
async function enrichmentModelFor(userId: string): Promise<string> {
  try {
    return process.env.CRM_ENRICH_V3_WEB_SEARCH_MODEL
      || process.env.CRM_ENRICH_V3_EXTRACT_MODEL
      || await resolveModelForUser(userId, 'enrichment');
  } catch {
    return 'unresolved-enrichment-model'; // unpriced, so the reserve stays conservative
  }
}

/** Conservative admission estimate, not a price or a settlement calculation.
 * Per lead it reserves every vendor the identity chain can reach, each hit once (Apollo match,
 * Apollo email waterfall, Apollo org, enrich.so find and reverse lookups, two You.com searches),
 * plus a guard-banded web/LLM cost per field (scaled by the enrichment model's price) and, when the
 * config asks for any Enigma card-revenue field, one Enigma fetch's fills.
 * It must stay above what a run books and within a small multiple of the customer-facing estimate
 * (enrichmentCostEstimate.ts); tests pin both. Cached hits may cost less; unusually expensive
 * in-flight work may cost more. Only one bounded (20-lead) batch is ever admitted at a time.
 *
 * ENG-2720: dropped the enrich.so `phone_finder` line ($0.25 per lead; nothing in the backend
 * calls it), reserved Enigma only when card-revenue fields are configured (it was $0.10 on every
 * field), counted You.com once per lead instead of four times per field, added the Apollo
 * `person_match` call that was missing, and replaced the gpt-5.5-sized $0.10 per-field band.
 */
export function estimateEnrichmentBatchMicroUsd(config: EnrichmentConfig, leadCount: number, model?: string): number {
  const fields = config.fields.filter(field => field.include);
  const dependencyCount = fields.reduce((count, field) => count + (field.smartDependencies?.length ?? 0), 0);
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
  // Card-revenue fields are routed by `aliasFor || name` and are only bought when asked for by name
  // (isCardRevenueField). Enigma bills per value returned, once per lead however many card fields were
  // asked for: 12m revenue, yoy growth, and the brand name/website values that come back with them.
  const wantsEnigma = fields.some(field => isCardRevenueField(field.aliasFor || field.name));
  const enigma = wantsEnigma
    ? rate('enigma', 'card_revenue_12m') + rate('enigma', 'card_revenue_yoy_growth_12m') + 4 * rate('enigma', 'brand_attribute')
    : 0;
  const perLead = identity
    + Math.max(1, fields.length + dependencyCount) * webFieldGuardUsd(model)
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
    const estimate = estimateEnrichmentBatchMicroUsd(config, leadCount, await enrichmentModelFor(userId));
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

export interface EnrichmentRunEstimate {
  leadCount: number;
  estimatedCostUsd: number;
  withinAllowance: boolean;
}

/** ENG-2715: pre-run estimate shown before the user confirms a CRM
 * enrichment. Strictly read-only: a forecast-only usage check, no admission
 * write, no enrichment. Uses the same conservative per-lead number the
 * per-batch cap enforces, so "within allowance" here predicts admission.
 */
export async function estimateEnrichmentRun(
  userId: string,
  config: EnrichmentConfig,
  leadCount: number,
): Promise<EnrichmentRunEstimate> {
  const count = Math.max(0, Math.floor(leadCount));
  const microUsd = count === 0 ? 0 : estimateEnrichmentBatchMicroUsd(config, count, await enrichmentModelFor(userId));
  const estimatedCostUsd = Math.ceil(microUsd / 10_000) / 100;
  if (count === 0) return { leadCount: 0, estimatedCostUsd: 0, withinAllowance: true };
  const projected = await checkTokenUsage(userId, { projectedCostMicroUsd: microUsd });
  return { leadCount: count, estimatedCostUsd, withinAllowance: projected.allowed === true };
}

import type { EnrichmentConfig, OrchestratorDeps } from './crmEnrichmentServiceV3';
import { checkTokenUsage, TURN_ADMISSION } from './tokenUsageService';
import { getAllocatedRate } from '../utils/vendorRateCard';

/**
 * Booked cost per web-tier field per lead that admission reserves: the extraction call plus the
 * OpenRouter web-search fee, with a wide guard band. Measured on the real Opiner list with
 * gpt-5.6-luna (ENG-2720): ~$0.0018 per field per lead all-in (tokens ~$0.0003 + search ~$0.0015),
 * so $0.02 is ~10x. It was $0.10, sized for gpt-5.5, which made admission ask for ~50x what a run
 * books. Not model-aware: the CRM_ENRICH_V3_DEFAULT_MODEL=gpt-5.5 rollback books roughly 19x more.
 */
const WEB_FIELD_GUARD_USD = 0.02;
/** Config aliases that route through Enigma, the only fields that incur an Enigma fill. */
const ENIGMA_ALIASES = new Set(['card_revenue_12m', 'card_revenue_yoy_growth_12m']);

/** Conservative admission estimate, not a price or a settlement calculation.
 * Per lead it reserves every vendor the identity chain can reach, each hit once (Apollo match,
 * Apollo email waterfall, Apollo org, enrich.so find and reverse lookups, two You.com searches),
 * plus a guard-banded web/LLM cost per field and an Enigma fill only for card-revenue fields.
 * It must stay above what the customer-facing estimate (enrichmentCostEstimate.ts) predicts
 * and stay within a small multiple of it; a test pins both. Cached hits may cost less;
 * unusually expensive in-flight work may cost more. Only one bounded (20-lead) batch is ever
 * admitted at a time.
 *
 * ENG-2720: dropped the enrich.so `phone_finder` line ($0.25 per lead; nothing in the backend
 * calls it), charged Enigma only for card-revenue fields (was $0.10 on every field), counted
 * You.com once per lead instead of four times per field, added the Apollo `person_match` call
 * that was missing, and replaced the gpt-5.5-sized $0.10 per-field LLM band.
 */
export function estimateEnrichmentBatchMicroUsd(config: EnrichmentConfig, leadCount: number): number {
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
  const enigmaFields = fields.filter(field => field.aliasFor !== undefined && ENIGMA_ALIASES.has(field.aliasFor)).length;
  const perLead = identity
    + Math.max(1, fields.length + dependencyCount) * WEB_FIELD_GUARD_USD
    + enigmaFields * rate('enigma', 'card_revenue_12m');
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
    const estimate = estimateEnrichmentBatchMicroUsd(config, leadCount);
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
  const microUsd = count === 0 ? 0 : estimateEnrichmentBatchMicroUsd(config, count);
  const estimatedCostUsd = Math.ceil(microUsd / 10_000) / 100;
  if (count === 0) return { leadCount: 0, estimatedCostUsd: 0, withinAllowance: true };
  const projected = await checkTokenUsage(userId, { projectedCostMicroUsd: microUsd });
  return { leadCount: count, estimatedCostUsd, withinAllowance: projected.allowed === true };
}

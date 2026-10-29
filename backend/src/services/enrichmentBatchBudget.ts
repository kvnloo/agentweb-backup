import type { EnrichmentConfig, OrchestratorDeps } from './crmEnrichmentServiceV3';
import { checkTokenUsage, TURN_ADMISSION } from './tokenUsageService';
import { getAllocatedRate } from '../utils/vendorRateCard';

/** Conservative admission estimate, not a price or a settlement calculation.
 * Budget for both identity vendors, four searches per field, Enigma and LLM
 * work. Cached hits may cost less; unusually expensive in-flight work may cost
 * more. Only one bounded (20-lead) batch is ever admitted at a time.
 */
export function estimateEnrichmentBatchMicroUsd(config: EnrichmentConfig, leadCount: number): number {
  const fields = config.fields.filter(field => field.include);
  const dependencyCount = fields.reduce((count, field) => count + (field.smartDependencies?.length ?? 0), 0);
  const rate = (...args: Parameters<typeof getAllocatedRate>): number => {
    const value = getAllocatedRate(...args);
    if (value === null || !Number.isFinite(value) || value < 0) throw new Error('Enrichment rate unavailable');
    return value;
  };
  const identity = rate('apollo', 'full_enrichment')
    + rate('apollo', 'org_enrichment')
    + rate('enrich.so', 'phone_finder')
    + rate('enrich.so', 'reverse_lookup');
  const perField = 4 * rate('you.com', 'query')
    + rate('enigma', 'card_revenue_12m') + 0.10; // LLM guard band
  return Math.ceil((identity + Math.max(1, fields.length + dependencyCount) * perField) * leadCount * 1_000_000);
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

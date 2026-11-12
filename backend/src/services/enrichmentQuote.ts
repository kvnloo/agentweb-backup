/**
 * ENG-2720: the pre-run enrichment quote, kept out of the route so it can be tested without Express.
 *
 * Two layers, so the enrich-time confirmation check never pays for more than it needs:
 *  - `priceEnrichment`: the internal estimate (dollars, server-side only). The estimate routes and the
 *    enrich-v3 stale-token check both call this with the same inputs, so they cannot disagree.
 *  - `quoteEnrichment`: that estimate plus the allowance projection, as the customer-safe view
 *    (ENG-1212: percent of allowance, no dollars, no vendor breakdown).
 */
import type { EnrichmentConfig } from './crmEnrichmentServiceV3';
import {
  estimateEnrichmentCost,
  toCustomerEstimate,
  type CustomerEnrichmentEstimate,
  type EnrichmentCostEstimate,
} from './enrichmentCostEstimate';
import {
  admissionEstimateMicroUsd,
  effectiveFieldCount,
  enigmaApplies,
  enigmaFetchUsd,
  enrichmentModelFor,
  expectedFieldCostUsd,
  projectAllowance,
} from './enrichmentBatchBudget';

export interface QuoteDeps {
  /** One page of a list's leads. */
  getLeadsPage(
    listId: string,
    limit: number,
    lastKey?: unknown,
  ): Promise<{ items: Array<{ leadId?: unknown; email?: unknown } & BrokerIdentityFields>; lastEvaluatedKey?: unknown }>;
  /** The list's saved enrichment config, or undefined when none is saved. Rejects when a saved config cannot be read: the quote must fail, not guess. */
  getSavedConfig(listId: string, userId: string): Promise<EnrichmentConfig | undefined>;
  /** Whether this is an email the resolver would use as one (not blank, not a placeholder/test domain). */
  hasUsableEmail(email: unknown): boolean;
}

export interface QuoteParams {
  userId: string;
  listId: string;
  /** A selected subset; absent means the whole list. */
  leadIds?: string[];
}

const PAGE_SIZE = 200;

/** The lead fields the Apollo broker needs (enrichmentGroupWaterfall tier 3.5a). */
export interface BrokerIdentityFields {
  firstName?: unknown;
  lastName?: unknown;
  company?: unknown;
  domain?: unknown;
  website?: unknown;
  emailDomain?: unknown;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/**
 * Whether the Apollo broker can be sent for this (emailless) lead: tier 3.5a needs a first and last name plus an
 * email domain or a company. The run derives the email domain from the lead's domain or website, so those count.
 */
export function canReachApolloBroker(lead: BrokerIdentityFields | undefined): boolean {
  if (!lead) return false;
  return filled(lead.firstName) && filled(lead.lastName)
    && (filled(lead.company) || filled(lead.domain) || filled(lead.website) || filled(lead.emailDomain));
}

/**
 * Whether a run on this config can ask for a lead's email at all: an included field that is (or aliases) the
 * canonical `email`, or a smart field depending on it. Without one the broker never fires (tier 3.5a only runs for
 * a requested `email`; the identity resolver is called without a lead hint, so its broker step never runs).
 */
export function configRequestsEmail(config: EnrichmentConfig): boolean {
  return config.fields.some(f => f.include && (
    (f.aliasFor ?? f.name) === 'email' || (f.smartDependencies ?? []).includes('email')
  ));
}

/**
 * The leads an enrich-v3 run would touch, and how many have no usable email (only those can trigger the
 * Apollo broker: the identity resolver skips it when an email is already known). The list is always paged,
 * and a selected subset is counted only for ids that actually belong to the list, as the run itself only
 * processes real leads. The scan stops as soon as every requested id has been found; ids that do not exist
 * still cost one pass over the list (bounded by its size). Trusting the raw id count would let a caller multiply the quote with fake ids until
 * the percent resolves the per-lead rate (100,000 fake ids read as 28,000%).
 */
export async function inspectLeads(
  deps: QuoteDeps,
  listId: string,
  leadIds?: string[],
): Promise<{ count: number; emailless: number; brokerEligible: number }> {
  const wanted = leadIds ? new Set(leadIds) : undefined;
  let count = 0;
  let emailless = 0;
  let brokerEligible = 0;
  let lastKey: unknown = undefined;
  do {
    const page = await deps.getLeadsPage(listId, PAGE_SIZE, lastKey);
    for (const lead of page.items) {
      if (wanted && !(typeof lead?.leadId === 'string' && wanted.has(lead.leadId))) continue;
      count++;
      if (!deps.hasUsableEmail(lead?.email)) {
        emailless++;
        if (canReachApolloBroker(lead)) brokerEligible++;
      }
    }
    lastKey = page.lastEvaluatedKey;
    // Every wanted id found: the rest of the list cannot add to the count (ids are unique within a list).
    if (wanted && count >= wanted.size) break;
  } while (lastKey);
  return { count, emailless, brokerEligible };
}

export async function priceEnrichment(
  deps: QuoteDeps,
  { userId, listId, leadIds }: QuoteParams,
): Promise<{ estimate: EnrichmentCostEstimate; config: EnrichmentConfig | undefined; leadCount: number }> {
  // Config first: if it cannot be read there is nothing to quote, so fail before paying for a pass over the list.
  const config = await deps.getSavedConfig(listId, userId);
  const { count, emailless, brokerEligible } = await inspectLeads(deps, listId, leadIds);
  const model = await enrichmentModelFor(userId);
  // No requested email, no broker: price no Apollo line. A list with no saved config runs the default config, which includes email.
  const asksForEmail = !config || configRequestsEmail(config);
  const estimate = estimateEnrichmentCost(listId, count, {
    userId,
    emaillessCount: asksForEmail ? emailless : 0,
    brokerEligibleCount: asksForEmail ? brokerEligible : 0,
    fieldCount: config ? effectiveFieldCount(config) : undefined,
    fieldCostUsd: expectedFieldCostUsd(model),
    enigmaPerLeadUsd: config && enigmaApplies(config, userId) ? enigmaFetchUsd('expected') : undefined,
  });
  return { estimate, config, leadCount: count };
}

export type PricedEnrichment = Awaited<ReturnType<typeof priceEnrichment>>;

/** The customer view of an already-priced quote: lets the 409 path reuse the price it just computed instead of scanning the list again. */
export async function quoteFromPriced(
  userId: string,
  priced: PricedEnrichment,
): Promise<{ estimate: EnrichmentCostEstimate; customerView: CustomerEnrichmentEstimate }> {
  const { estimate, config, leadCount } = priced;
  const expectedMicro = Math.round(estimate.totalUsd * 1_000_000);
  const reserveMicro = config
    ? Math.max(expectedMicro, await admissionEstimateMicroUsd(userId, config, leadCount))
    : expectedMicro;
  const allowance = await projectAllowance(userId, expectedMicro, reserveMicro);
  return { estimate, customerView: toCustomerEstimate(estimate, allowance) };
}

export async function quoteEnrichment(
  deps: QuoteDeps,
  params: QuoteParams,
): Promise<{ estimate: EnrichmentCostEstimate; customerView: CustomerEnrichmentEstimate }> {
  return quoteFromPriced(params.userId, await priceEnrichment(deps, params));
}

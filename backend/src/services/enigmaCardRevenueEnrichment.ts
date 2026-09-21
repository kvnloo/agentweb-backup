/**
 * Enigma card revenue inside V3 enrichment (ENG-1388 Phase 2).
 *
 * Policy lives here so the waterfall only has to map an outcome to fills:
 *   - who may buy Enigma data at all (flag + allowlist; empty allowlist = nobody)
 *   - which leads are worth a call (industry card-adoption gate)
 *   - how much one run may spend (per-run cap) and when to stop (402/401 breaker)
 *   - a per-run summary so skips never masquerade as failures, and failures
 *     never masquerade as "no data"
 *
 * Card revenue is card spend on US consumer and small-business cards, not total
 * revenue. Enigma's guidance: valid for high card-adoption industries, a floor
 * for mixed ones, not meaningful for low ones
 * (documentation.enigma.com/resources/card_revenue_data).
 */

import {
  EnigmaAuthError,
  EnigmaCreditsExhaustedError,
  EnigmaBudgetExhaustedError,
  isEnigmaBlockedWebsite,
  EnigmaQuotaExceededError,
  EnigmaRateLimitedError,
  type EnigmaBrandLookupResult,
  type EnigmaService,
} from './enigmaService';

// ─── Access gate ─────────────────────────────────────────────────────────────

/**
 * True only when ENIGMA_ENRICHMENT_ENABLED is exactly 'true' AND the user is in
 * ENIGMA_ENRICHMENT_USER_ALLOWLIST (comma-separated user ids). An empty or
 * missing allowlist means nobody — the opposite of an "unrestricted" default.
 */
export function isEnigmaEnrichmentEnabledForUser(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.ENIGMA_ENRICHMENT_ENABLED !== 'true' || !userId) return false;
  const allowlist = (env.ENIGMA_ENRICHMENT_USER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowlist.includes(userId);
}

// ─── Industry card-adoption gate ─────────────────────────────────────────────

export type CardAdoption = 'high' | 'mixed' | 'low' | 'unknown';

// Keyword rules over free-text industry labels (we have no NAICS codes). Anchored
// on Enigma's examples; the rest are common Apollo/LinkedIn-style labels.
// `low` is checked first so "B2B SaaS for restaurants" is low, not high.
const ADOPTION_KEYWORDS: Record<Exclude<CardAdoption, 'unknown'>, string[]> = {
  low: [
    'software', 'saas', 'b2b', 'api', 'developer tools', 'devtools', 'dev tools', 'cloud', 'hosting', 'platform',
    'it services', 'information technology', 'cybersecurity', 'security software', 'data infrastructure', 'analytics',
    'machine learning', 'artificial intelligence', 'ai', 'semiconductor', 'semiconductors', 'telecommunications',
    'wholesale', 'distribution', 'manufacturing', 'industrial', 'machinery', 'chemicals', 'logistics', 'freight',
    'supply chain', 'shipping', 'biotech', 'biotechnology', 'pharmaceutical', 'pharmaceuticals', 'oil', 'energy',
    'mining', 'utilities', 'staffing', 'recruiting', 'outsourcing', 'martech', 'adtech', 'fintech', 'payments',
    'banking', 'venture capital', 'private equity', 'crypto', 'web3', 'blockchain', 'government', 'defense', 'aerospace',
  ],
  high: [
    'retail', 'e-commerce', 'ecommerce', 'dtc', 'd2c', 'direct to consumer', 'consumer goods', 'restaurant',
    'restaurants', 'food & beverage', 'food & beverages', 'food and beverage', 'cafe', 'coffee', 'bakery', 'bar', 'bars',
    'hospitality', 'hotel', 'hotels', 'fitness', 'gym', 'wellness', 'spa', 'salon', 'beauty', 'cosmetics', 'skincare',
    'apparel', 'fashion', 'jewelry', 'luxury goods', 'sporting goods', 'furniture', 'home goods', 'pet', 'pets',
    'grocery', 'supermarket', 'supermarkets', 'wine', 'spirits', 'brewery', 'entertainment', 'recreation', 'leisure',
    'events', 'travel', 'tourism', 'personal services', 'consumer services', 'car wash', 'automotive repair', 'dry cleaning',
  ],
  mixed: [
    'healthcare', 'health care', 'hospital', 'medical', 'dental', 'dentist', 'veterinary', 'clinic',
    'professional services', 'legal', 'law', 'accounting', 'consulting', 'real estate', 'property', 'insurance',
    'education', 'edtech', 'construction', 'home services', 'plumbing', 'hvac', 'landscaping', 'cleaning', 'marketing',
    'advertising', 'agency', 'nonprofit', 'non-profit', 'marketplace', 'healthtech', 'proptech', 'insurtech',
  ],
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ADOPTION_PATTERNS = Object.fromEntries(
  Object.entries(ADOPTION_KEYWORDS).map(([cls, words]) => [
    cls,
    new RegExp(`(^|[^a-z0-9])(${words.map(escapeRegExp).join('|')})([^a-z0-9]|$)`, 'i'),
  ]),
) as Record<Exclude<CardAdoption, 'unknown'>, RegExp>;

/** Classify any industry labels known for a company. No labels → 'unknown'. */
export function classifyCardAdoption(industryLabels: Array<string | null | undefined>): CardAdoption {
  const text = industryLabels.filter((s): s is string => typeof s === 'string' && s.trim() !== '').join(' | ');
  if (!text) return 'unknown';
  if (ADOPTION_PATTERNS.low.test(text)) return 'low';
  if (ADOPTION_PATTERNS.high.test(text)) return 'high';
  if (ADOPTION_PATTERNS.mixed.test(text)) return 'mixed';
  return 'unknown';
}

// ─── Per-run fetcher ─────────────────────────────────────────────────────────

export type EnigmaSkipReason =
  | 'unusable_domain'
  | 'low_card_adoption'
  | 'cap_reached'
  | 'budget_reached'
  | 'not_found'
  | 'no_value'
  | 'provider_unavailable';

export type EnigmaFailReason = 'credits_exhausted' | 'auth' | 'rate_limited' | 'error';

export type EnigmaCardRevenueOutcome =
  | { kind: 'found'; result: EnigmaBrandLookupResult & { cardRevenue12m: NonNullable<EnigmaBrandLookupResult['cardRevenue12m']> }; adoption: CardAdoption }
  | { kind: 'skipped'; reason: EnigmaSkipReason }
  | { kind: 'failed'; reason: EnigmaFailReason };

export interface EnigmaRunSummary {
  lookups: number;
  filled: number;
  skipped: Partial<Record<EnigmaSkipReason, number>>;
  failed: Partial<Record<EnigmaFailReason, number>>;
  /** Set when a 402/401 stopped every later Enigma call in this run. */
  haltedBy?: 'credits_exhausted' | 'auth' | 'budget_reached';
}

export interface EnigmaLookupRequest {
  domain: string | null;
  companyName?: string;
  industryLabels: Array<string | null | undefined>;
  forceRefresh: boolean;
}

export interface EnigmaCardRevenueFetcher {
  fetch(request: EnigmaLookupRequest): Promise<EnigmaCardRevenueOutcome>;
  summary(): EnigmaRunSummary;
}

// ENG-1933 measured ~19 credits per live call (52 worst case) on a 2,100
// credit/month plan, so 100 calls is already about a month's allowance.
export const DEFAULT_MAX_ENIGMA_LOOKUPS_PER_RUN = 100;

export function maxLookupsPerRunFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ENIGMA_MAX_CALLS_PER_RUN);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_ENIGMA_LOOKUPS_PER_RUN;
}

/**
 * One fetcher per enrichment run. The per-run cap counts lookups (a cache hit
 * uses a slot too — conservative, since a hit can't be known before the call)
 * and the slot is reserved synchronously, so concurrent leads cannot overshoot.
 */
export function createEnigmaCardRevenueFetcher(opts: {
  service: EnigmaService;
  userId: string;
  maxLookupsPerRun?: number;
}): EnigmaCardRevenueFetcher {
  const max = opts.maxLookupsPerRun ?? maxLookupsPerRunFromEnv();
  const summary: EnigmaRunSummary = { lookups: 0, filled: 0, skipped: {}, failed: {} };
  const skip = (reason: EnigmaSkipReason): EnigmaCardRevenueOutcome => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
    return { kind: 'skipped', reason };
  };
  const fail = (reason: EnigmaFailReason): EnigmaCardRevenueOutcome => {
    summary.failed[reason] = (summary.failed[reason] ?? 0) + 1;
    return { kind: 'failed', reason };
  };

  return {
    async fetch(request) {
      if (summary.haltedBy) return skip(summary.haltedBy === 'budget_reached' ? 'budget_reached' : 'provider_unavailable');
      // Checked before a per-run slot is taken: a list full of form or profile
      // hosts must not use up the run's lookups without a single API call.
      if (!request.domain || isEnigmaBlockedWebsite(request.domain)) return skip('unusable_domain');

      const adoption = classifyCardAdoption(request.industryLabels);
      if (adoption === 'low') return skip('low_card_adoption');

      if (summary.lookups >= max) return skip('cap_reached');
      summary.lookups++;

      let result: EnigmaBrandLookupResult;
      try {
        result = await opts.service.lookupBrandCardRevenue(
          { website: request.domain, companyName: request.companyName },
          { userId: opts.userId, forceRefresh: request.forceRefresh },
        );
      } catch (err) {
        if (err instanceof EnigmaQuotaExceededError) return skip('cap_reached');
        // The monthly budget is platform-wide: once spent, every later lead in
        // this run would hit the same wall, so stop calling.
        if (err instanceof EnigmaBudgetExhaustedError) {
          if (!summary.haltedBy) {
            summary.haltedBy = 'budget_reached';
            console.error(`[enigma:enrichment] run halted (budget_reached) for user ${opts.userId}: ${err.message}`);
          }
          return skip('budget_reached');
        }
        if (err instanceof EnigmaCreditsExhaustedError || err instanceof EnigmaAuthError) {
          const reason = err instanceof EnigmaCreditsExhaustedError ? 'credits_exhausted' : 'auth';
          if (!summary.haltedBy) {
            summary.haltedBy = reason;
            console.error(`[enigma:enrichment] run halted (${reason}) for user ${opts.userId}: ${err.message}`);
          }
          return fail(reason);
        }
        if (err instanceof EnigmaRateLimitedError) return fail('rate_limited');
        console.warn(`[enigma:enrichment] lookup failed for ${request.domain}: ${(err as Error).message}`);
        return fail('error');
      }

      if (result.status === 'skipped') return skip('unusable_domain');
      if (result.status === 'not_found') return skip('not_found');
      const { cardRevenue12m } = result;
      if (!cardRevenue12m) return skip('no_value');
      summary.filled++;
      return { kind: 'found', result: { ...result, cardRevenue12m }, adoption };
    },
    summary: () => ({ ...summary, skipped: { ...summary.skipped }, failed: { ...summary.failed } }),
  };
}

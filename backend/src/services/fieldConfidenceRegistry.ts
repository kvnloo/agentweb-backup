/**
 * Centralized per-field confidence registry.
 *
 * Before this module, confidence assignments were scattered:
 *   - apolloOrgEnrichment.ts had a private ORG_FIELD_CONFIDENCE table.
 *   - enrichSoReverseLookup.ts hardcoded 'high' for every field — too
 *     optimistic for current-state fields like title/company that go stale
 *     when subjects change jobs.
 *   - applyApolloMatchToLead.ts hardcoded 'medium' inline at projection sites.
 *
 * The registry consolidates them so:
 *   - There is a single source of truth per (provider × field).
 *   - Adjustments (e.g. demoting Apollo annual revenue from 'medium' to 'low')
 *     are made in one place.
 *   - Unknown combinations fall back to a safe 'medium' default — protects
 *     against typos and new-field rollouts that forget to wire confidence.
 *
 * The optional `signal` parameter is plumbing for future callers that want
 * to upgrade confidence when a match used a strong identifier (linkedin URL)
 * vs a weak one (name+org). Today the registry ignores it — added now so
 * call-site signatures don't need to change later.
 */

export type Confidence = 'high' | 'medium' | 'low';

export type FieldConfidenceProvider = 'apollo' | 'enrich.so';

/** Identifier used to make the match. Some fields could be promoted/demoted
 *  based on signal strength in the future. */
export type FieldConfidenceSignal = 'linkedin' | 'email' | 'name+org';

// ─── Tables ─────────────────────────────────────────────────────────────────

/**
 * Apollo per-field confidence. Apollo doesn't return field-level confidence
 * on /organizations/enrich, so we infer:
 *   - 'high'   for factual public-record fields (funding rounds, dates)
 *   - 'medium' for current-state fields refreshed weekly (tech stack, growth)
 *   - 'low'    for estimates Apollo synthesizes (annual revenue, dept headcount)
 *
 * Person-level fields like `employmentHistory` are 'medium' — Apollo's data
 * is comprehensive but the recency cap is variable per person.
 */
const APOLLO_FIELD_CONFIDENCE: Record<string, Confidence> = {
  // Identity fields (filled by the identity resolver / person waterfall).
  // 'high' for stable identifiers; 'medium' for current-state fields that
  // drift when the subject changes jobs. Listed explicitly so Apollo identity
  // fields no longer silently default to 'medium' while enrich.so rates the
  // same fields 'high'.
  firstName: 'high',
  lastName: 'high',
  email: 'high',
  linkedin: 'high',
  website: 'medium',   // current-state; can change when company rebrands
  company: 'medium',
  title: 'medium',
  phone: 'medium',

  // Person fields (filled by applyApolloMatchToLead from /people/match)
  employmentHistory: 'medium',

  // Org fields (filled by apolloOrgEnrichmentSpecialists from match.organization)
  companyTechStack: 'medium',
  companyHeadcountGrowth6mo: 'medium',
  companyHeadcountGrowth12mo: 'medium',
  companyHeadcountGrowth24mo: 'medium',
  companyFundingTotal: 'high',
  companyFundingStage: 'high',
  companyFundingLastRoundDate: 'high',
  companyAnnualRevenue: 'low',          // estimate
  companyDepartmentHeadcount: 'low',    // estimate

  // ── V3 waterfall snake_case FIELD_GROUPS entries ──────────────────────────
  // The V3 waterfall (enrichmentGroupWaterfall.ts) calls getFieldConfidence with
  // the snake_case field names from FIELD_GROUPS (e.g. 'funding_stage'), not
  // the camelCase names used by the identity resolver path above. Without these
  // entries every waterfall lookup silently falls back to the 'medium' default.
  //
  // Rationale mirrors the camelCase block above:
  //   'high'   for factual public-record fields (funding rounds, dates, founding year)
  //   'low'    for synthesized estimates (revenue ranges, valuations)
  //   (fields that legitimately default to 'medium' are omitted — no entry needed)

  // company_financial group (factual public-record fields)
  funding_stage: 'high',        // mirrors companyFundingStage: 'high'
  total_funding: 'high',        // mirrors companyFundingTotal: 'high'
  last_funding_date: 'high',    // mirrors companyFundingLastRoundDate: 'high'
  founded_year: 'high',         // factual public record (incorporation date)

  // company_financial group (synthesized estimates)
  revenue_range: 'low',         // estimate / range — mirrors companyAnnualRevenue: 'low'
  valuation: 'low',             // estimate; rarely publicly disclosed
};

/**
 * enrich.so per-field confidence. Pre-fix code hardcoded 'high' across the
 * board, but that overstates fidelity for fields that drift between API
 * fetches (title/company change when subjects change jobs) and for
 * historical fields that are sparser than the current snapshot
 * (pastCompanies, education, skills).
 *
 * Identity / current-snapshot fields stay 'high'. Drift-prone or sparser
 * fields drop to 'medium'.
 */
const ENRICHSO_FIELD_CONFIDENCE: Record<string, Confidence> = {
  // Identity (high — these are how we ID the person)
  firstName: 'high',
  lastName: 'high',
  email: 'high',
  linkedin: 'high',         // profileUrl
  headline: 'high',         // current LinkedIn headline
  connectionCount: 'high',  // factual count
  location: 'high',         // current location

  // Current state (medium — drift when subject changes jobs)
  title: 'medium',
  company: 'medium',

  // Historical / lower-fidelity (medium)
  pastCompanies: 'medium',
  skills: 'medium',
  education: 'medium',
  summary: 'medium',
};

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Look up the confidence for a given (provider × field) pair.
 *
 * @param provider     The data source the value came from.
 * @param field        The lead field being filled (camelCase, e.g. 'firstName',
 *                     'companyTechStack'). Pass the lead-side field name —
 *                     not the raw provider field name.
 * @param signal       Optional. Reserved for future use; currently ignored.
 *                     Caller can pass the identifier used to make the match
 *                     so the registry can be extended to upgrade confidence
 *                     for strong-identifier matches without changing call sites.
 *
 * @returns 'high' | 'medium' | 'low'. Unknown (provider × field) pairs return
 *          'medium' so a typo or a new field rollout doesn't accidentally
 *          mark fresh data as either fully trustworthy or unusable.
 */
export function getFieldConfidence(
  provider: FieldConfidenceProvider,
  field: string,
  signal?: FieldConfidenceSignal,
): Confidence {
  // signal is currently unused — accepted to lock in the call shape for
  // future extensions (e.g. linkedin signal upgrades enrich.so company
  // from medium to high since LinkedIn data is the source of truth).
  void signal;
  const table =
    provider === 'apollo'
      ? APOLLO_FIELD_CONFIDENCE
      : ENRICHSO_FIELD_CONFIDENCE;
  return table[field] ?? 'medium';
}

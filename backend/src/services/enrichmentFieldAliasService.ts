/**
 * User-field-name → canonical-field-name resolver.
 *
 * Users name their custom fields however they want (`company_overview`,
 * `funding_round`, `headcount`, …). The enrichment pipeline groups fields by
 * FIELD_GROUPS (defined in enrichmentGroups.ts) using exact-string match.
 * Without alias resolution, every user variant falls into the legacy ungrouped
 * path — which means: cache miss every time, no per-group search template,
 * no targeted re-search.
 *
 * Three-tier resolution:
 *   1. Static map  — hand-curated, ~25 most common variants (zero LLM cost)
 *   2. Per-list persisted map — LLM resolutions cached on AW-LeadLists, so we
 *      pay the LLM cost once per list per novel field name
 *   3. LLM mapping — fired only when neither tier 1 nor tier 2 has the field
 *
 * Failure mode is graceful: if the LLM call fails, we fall back to the static
 * tier and any unresolved field goes through the existing ungrouped path.
 */

import { crmDb } from './db';
import { agentModeService } from './agentModeService';
import { FIELD_GROUPS } from './enrichmentGroups';
import { buildFieldMappingSystemPrompt, buildFieldMappingUserPrompt } from './enrichmentPrompts';
import { meterUsageFromResponse } from '../utils/llmClients';

// ── Tier 1: hand-curated alias map ───────────────────────────────────────────
//
// Add entries here when the team observes a user-field convention that should
// map to a canonical field. Keys are case-insensitive at lookup time.
export const STATIC_FIELD_ALIASES: Record<string, string> = {
  // → company_description (firmographic)
  company_overview:     'company_description',
  business_description: 'company_description',
  about_company:        'company_description',
  company_summary:      'company_description',
  business_summary:     'company_description',
  description:          'company_description',
  about:                'company_description',

  // → employee_count
  employees:    'employee_count',
  headcount:    'employee_count',
  team_size:    'employee_count',
  company_size: 'employee_count',
  staff_count:  'employee_count',

  // → industry
  sector:            'industry',
  vertical:          'industry',
  business_category: 'industry',
  industry_specific: 'industry',
  industry_type:     'industry',

  // → founded_year
  founded:       'founded_year',
  year_founded:  'founded_year',
  established:   'founded_year',
  founding_year: 'founded_year',

  // → hq_location
  hq:           'hq_location',
  headquarters: 'hq_location',
  hq_city:      'hq_location',
  hq_address:   'hq_location',
  location:     'hq_location',
  address:      'hq_location',

  // → funding_stage (financial)
  funding_round:        'funding_stage',
  last_funding_round:   'funding_stage',
  latest_funding_stage: 'funding_stage',
  series:               'funding_stage',
  current_stage:        'funding_stage',

  // → total_funding
  total_funding_usd: 'total_funding',
  total_raised:      'total_funding',
  money_raised:      'total_funding',
  capital_raised:    'total_funding',
  total_capital:     'total_funding',

  // → country (geography)
  hq_country:    'country',
  company_country: 'country',

  // → region (geography)
  geographic_region: 'region',
  geo_region:        'region',
  area:              'region',

  // → time_zone (geography)
  timezone:    'time_zone',
  tz:          'time_zone',
  hq_timezone: 'time_zone',

  // → all_office_locations (geography)
  office_locations: 'all_office_locations',
  offices:          'all_office_locations',
  branch_offices:   'all_office_locations',

  // → hq_address (geography)
  street_address: 'hq_address',
  full_address:   'hq_address',
  mailing_address: 'hq_address',

  // → product_categories (product)
  product_lines:    'product_categories',
  product_types:    'product_categories',
  product_segment:  'product_categories',

  // → pricing_model (product)
  pricing_tier:    'pricing_model',
  pricing:         'pricing_model',
  business_model:  'pricing_model',
  go_to_market:    'pricing_model',
  gtm_motion:      'pricing_model',

  // → target_market (product)
  customer_segment:    'target_market',
  ideal_customer:      'target_market',
  customer_persona:    'target_market',
  audience:            'target_market',

  // → primary_offerings (product)
  main_products: 'primary_offerings',
  flagship:      'primary_offerings',
  core_offering: 'primary_offerings',

  // → customer_logos (product)
  notable_customers: 'customer_logos',
  case_studies:      'customer_logos',
  customer_list:     'customer_logos',

  // → tenure_at_company (person_career)
  tenure:                'tenure_at_company',
  time_at_company:       'tenure_at_company',
  years_at_company:      'tenure_at_company',

  // → prior_companies (person_career)
  previous_companies: 'prior_companies',
  past_employers:     'prior_companies',
  work_history:       'prior_companies',
  career_history:     'prior_companies',

  // → education (person_career)
  schools:        'education',
  university:     'education',
  alma_mater:     'education',
  degrees:        'education',

  // → recent_role_change_date (person_career)
  role_change_date:  'recent_role_change_date',
  joined_date:       'recent_role_change_date',
  start_date:        'recent_role_change_date',

  // → years_experience (person_career)
  total_experience:  'years_experience',
  years_in_industry: 'years_experience',
  experience_years:  'years_experience',
};

// Build a flat set of all canonical field names from FIELD_GROUPS once.
function buildCanonicalSet(): Set<string> {
  const out = new Set<string>();
  for (const group of Object.values(FIELD_GROUPS)) {
    for (const f of group.fields) out.add(f);
  }
  return out;
}

let _canonicalSet: Set<string> | null = null;
export function canonicalFieldSet(): Set<string> {
  if (!_canonicalSet) _canonicalSet = buildCanonicalSet();
  return _canonicalSet;
}

// Used by the LLM prompt — flat list of canonical fields with brief meaning.
function canonicalFieldDescriptions(): string {
  const lines = [
    'company_name        — official company name',
    'website             — company website URL',
    'industry            — sector or vertical (e.g. B2B SaaS, FinTech)',
    'employee_count      — number of employees / headcount',
    'founded_year        — year the company was founded',
    'hq_location         — HQ city / region',
    'company_description — prose description of what the company does',
    'company_type        — org type (Public / Private / PE-backed / Acquired)',
    'company_linkedin_url — LinkedIn company page URL',
    'revenue_range       — bucketed revenue (e.g. $1-10M)',
    'funding_stage       — most recent funding round (Pre-seed / Seed / Series A-Z / IPO / etc.)',
    'total_funding       — total $ raised across all rounds',
    'investors           — list of investors',
    'last_funding_date   — date of last round',
    'valuation           — company valuation',
    'tech_stack          — technologies/tools the company uses',
    'crm_used            — CRM platform used',
    'marketing_tools     — marketing tools used',
    'cloud_provider      — cloud provider (AWS/GCP/Azure)',
    'analytics_tools     — analytics tools',
    'engineering_stack   — engineering tools/languages',
    'twitter_handle      — Twitter/X handle',
    'linkedin_followers  — LinkedIn follower count',
    'glassdoor_rating    — Glassdoor rating',
    'g2_rating           — G2 rating',
    'recent_news         — recent news / announcements',
    'hiring_signals      — hiring activity signals',
    'job_postings_count  — number of open job postings',
    'leadership_changes  — recent leadership changes',
    'funding_news        — recent funding announcements',
    'expansion_signals   — geographic / market expansion',
    'country             — primary country (e.g. United States, UK, Germany)',
    'region              — geographic region (e.g. North America, EMEA, APAC)',
    'time_zone           — primary time zone (e.g. PST, EST, GMT)',
    'all_office_locations — list of office locations / branches',
    'hq_address          — full street address of HQ',
    'product_categories  — product lines / categories the company sells',
    'pricing_model       — pricing tier or model (free / freemium / SMB / enterprise / PLG / sales-led)',
    'target_market       — ICP / target customer segment',
    'primary_offerings   — flagship / main products',
    'customer_logos      — notable customers, case studies',
    'tenure_at_company   — how long the person has been at current company',
    'prior_companies     — list of previous employers',
    'education           — schools, universities, degrees',
    'recent_role_change_date — date the person started their current role',
    'years_experience    — total years of professional experience',
    'first_name          — person first name',
    'last_name           — person last name',
    'title               — job title',
    'seniority           — seniority level (IC / Manager / Director / VP / C-level)',
    'department          — department / function',
    'linkedin_url        — person LinkedIn profile URL',
    'email               — person email',
    'phone               — person phone',
    'location            — person geographic location',
  ];
  return lines.join('\n');
}

// ── LLM mapping ──────────────────────────────────────────────────────────────

async function llmMapFieldsToCanonical(
  unresolvedFields: string[],
  userId?: string
): Promise<Record<string, string | null>> {
  if (unresolvedFields.length === 0) return {};

  const system = buildFieldMappingSystemPrompt(canonicalFieldDescriptions());
  const user = buildFieldMappingUserPrompt(unresolvedFields);

  try {
    // Use the configured enrichment model — same one as suggestEnrichment.
    const { CrmEnrichmentService } = await import('./crmEnrichmentService');
    const { enrichmentModel } = await CrmEnrichmentService.getEnrichmentConfig();
    const llm = await agentModeService.getClientForModel(enrichmentModel);
    const completion = await llm.chat.completions.create({
      model: enrichmentModel,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });
    meterUsageFromResponse({
      userId,
      model: enrichmentModel,
      provider: enrichmentModel.startsWith('anthropic') || enrichmentModel.startsWith('claude') ? 'bedrock' : 'azure',
      feature: 'crm_enrichment_field_alias',
    }, completion);
    const raw = completion.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const canonicalSet = canonicalFieldSet();
    const out: Record<string, string | null> = {};
    for (const f of unresolvedFields) {
      const v = parsed[f];
      if (typeof v === 'string' && v.length > 0 && canonicalSet.has(v)) {
        out[f] = v;
      } else {
        // null, missing, or non-canonical — treat as unresolved
        out[f] = null;
      }
    }
    return out;
  } catch (err: any) {
    console.warn(`[enrichmentFieldAlias] LLM mapping failed: ${err?.message}`);
    // Graceful: return all-null so callers fall back to static map only
    return Object.fromEntries(unresolvedFields.map(f => [f, null]));
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a list of user-named fields to canonical names.
 *
 *   1. Pull the list's persisted fieldCanonicalMap (one DB read).
 *   2. Compose: canonical-set ∪ static-aliases ∪ persisted-map → known map.
 *   3. Fields not in known map and not already canonical → unresolved[].
 *   4. If unresolved, call LLM once. Filter to non-null results.
 *   5. Persist any new mappings to the list.
 *   6. Return the effective map (user-field → canonical-field).
 *
 * The map covers ALL output fields the caller passed in, including ones that
 * were already canonical (they map to themselves). That gives `splitFieldsByGroup`
 * a uniform lookup surface.
 */
export interface ResolveFieldAliasesResult {
  effectiveMap: Record<string, string>;
  newlyResolved: Record<string, string>;
}

export async function resolveFieldAliases(
  listId: string,
  outputFields: string[],
  userId?: string
): Promise<ResolveFieldAliasesResult> {
  const canonicalSet = canonicalFieldSet();
  const list = await crmDb.getLeadListById(listId).catch(() => null);
  const persisted = ((list as any)?.fieldCanonicalMap as Record<string, string>) || {};

  // Build effective map for fields we already know about
  const effective: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const f of outputFields) {
    if (canonicalSet.has(f)) {
      effective[f] = f;
      continue;
    }
    const lc = f.toLowerCase();
    if (STATIC_FIELD_ALIASES[lc]) {
      effective[f] = STATIC_FIELD_ALIASES[lc];
      continue;
    }
    if (persisted[f]) {
      effective[f] = persisted[f];
      continue;
    }
    unresolved.push(f);
  }

  if (unresolved.length === 0) {
    return { effectiveMap: effective, newlyResolved: {} };
  }

  const newMappings = await llmMapFieldsToCanonical(unresolved, userId);
  const newlyResolved: Record<string, string> = {};
  for (const [f, canonical] of Object.entries(newMappings)) {
    if (canonical) {
      effective[f] = canonical;
      newlyResolved[f] = canonical;
    }
    // null → leave out of effective; splitFieldsByGroup will treat as ungrouped
  }

  // Persist new mappings to the list (best-effort, non-blocking on failure)
  if (Object.keys(newlyResolved).length > 0) {
    try {
      await crmDb.updateLeadList(listId, {
        fieldCanonicalMap: { ...persisted, ...newlyResolved },
      });
    } catch (err: any) {
      console.warn(`[enrichmentFieldAlias] Failed to persist canonical map: ${err?.message}`);
    }
  }

  return { effectiveMap: effective, newlyResolved };
}

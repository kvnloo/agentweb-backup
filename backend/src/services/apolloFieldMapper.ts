/**
 * Pure mapping functions: Apollo /people/match payloads → AgentWeb lead fields.
 *
 * Confidence rules (Apollo doesn't return a numeric score):
 *   - Email status comes from `email_status` enum directly
 *   - Other fields fall back to a tier inferred from how many strong identifiers
 *     the call provided (linkedin_url + email > linkedin_url > email > name+org)
 */

export type ApolloConfidence = 'high' | 'medium' | 'low';

export interface ApolloEmploymentEntry {
  organizationName?: string;
  organizationId?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  description?: string;
}

export interface MappedPerson {
  apolloPersonId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailStatus?: string;
  phone?: string;
  title?: string;
  seniority?: string;
  headline?: string;
  linkedin?: string;
  twitter?: string;
  github?: string;
  city?: string;
  state?: string;
  country?: string;
  timezone?: string;
  departments?: string[];
  subdepartments?: string[];
  functions?: string[];
  employmentHistory?: ApolloEmploymentEntry[];
  /** Per-field confidence; consumers project this onto enrichmentMetadata. */
  fieldConfidence: Partial<Record<keyof MappedPerson, ApolloConfidence>>;
}

export interface MappedOrganization {
  apolloOrgId?: string;
  domain?: string;
  name?: string;
  industry?: string;
  industries?: string[];
  estimatedNumEmployees?: number;
  foundedYear?: number;
  annualRevenue?: number;
  annualRevenuePrinted?: string;
  totalFunding?: number;
  latestFundingStage?: string;
  latestFundingRoundDate?: string;
  techStack?: string[];
  headcountGrowth6mo?: number;
  headcountGrowth12mo?: number;
  headcountGrowth24mo?: number;
  departmentHeadcount?: Record<string, number>;
  hqCity?: string;
  hqState?: string;
  hqCountry?: string;
  hqRawAddress?: string;
  websiteUrl?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  phone?: string;
  shortDescription?: string;
}

export interface MapMatchInputs {
  /** Inputs that were sent to /people/match — used for confidence inference. */
  hadLinkedinUrl?: boolean;
  hadEmail?: boolean;
  hadNameAndOrg?: boolean;
}

function inferBaseConfidence(inputs: MapMatchInputs): ApolloConfidence {
  // 2 strong identifiers → high; 1 → medium; weak → low.
  const strong = (inputs.hadLinkedinUrl ? 1 : 0) + (inputs.hadEmail ? 1 : 0);
  if (strong >= 2) return 'high';
  if (strong === 1) return 'medium';
  if (inputs.hadNameAndOrg) return 'low';
  return 'low';
}

function emailConfidence(emailStatus: string | undefined): ApolloConfidence {
  switch ((emailStatus ?? '').toLowerCase()) {
    case 'verified':
      return 'high';
    case 'guessed':
      return 'low';
    case 'unverified':
    case 'extrapolated':
      return 'medium';
    default:
      return 'low';
  }
}

function strOrUndef(v: any): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function numOrUndef(v: any): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function arrayOfStrings(v: any): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
  return out.length ? out : undefined;
}

/**
 * Merge two optional string lists, dedup by lowercased value, preserve the
 * first list's ordering. Used to combine `industries` + `secondary_industries`
 * (Apollo treats them as distinct lists; we surface a single union).
 */
function dedupConcat(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...(a ?? []), ...(b ?? [])]) {
    const key = x.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(x); }
  }
  return out.length ? out : undefined;
}

export function mapApolloPerson(
  apolloPerson: any,
  inputs: MapMatchInputs = {},
): MappedPerson {
  const p = apolloPerson ?? {};
  const base = inferBaseConfidence(inputs);

  const employmentHistory: ApolloEmploymentEntry[] | undefined = Array.isArray(p.employment_history)
    ? p.employment_history.map((e: any) => ({
        organizationName: strOrUndef(e?.organization_name),
        organizationId: strOrUndef(e?.organization_id),
        title: strOrUndef(e?.title),
        startDate: strOrUndef(e?.start_date),
        endDate: strOrUndef(e?.end_date),
        current: typeof e?.current === 'boolean' ? e.current : undefined,
        description: strOrUndef(e?.description),
      })).filter((e: ApolloEmploymentEntry) => e.organizationName || e.title)
    : undefined;

  const phoneNumbers = Array.isArray(p.phone_numbers) ? p.phone_numbers : [];
  const firstSanitized = phoneNumbers
    .map((n: any) => strOrUndef(n?.sanitized_number) ?? strOrUndef(n?.raw_number))
    .find((x: string | undefined): x is string => !!x);

  const mapped: MappedPerson = {
    apolloPersonId: strOrUndef(p.id),
    firstName: strOrUndef(p.first_name),
    lastName: strOrUndef(p.last_name),
    email: strOrUndef(p.email),
    emailStatus: strOrUndef(p.email_status),
    phone: firstSanitized,
    title: strOrUndef(p.title),
    seniority: strOrUndef(p.seniority),
    headline: strOrUndef(p.headline),
    linkedin: strOrUndef(p.linkedin_url),
    twitter: strOrUndef(p.twitter_url),
    github: strOrUndef(p.github_url),
    city: strOrUndef(p.city),
    state: strOrUndef(p.state),
    country: strOrUndef(p.country),
    timezone: strOrUndef(p.time_zone),
    departments: arrayOfStrings(p.departments),
    subdepartments: arrayOfStrings(p.subdepartments),
    functions: arrayOfStrings(p.functions),
    employmentHistory: employmentHistory && employmentHistory.length ? employmentHistory : undefined,
    fieldConfidence: {},
  };

  for (const k of Object.keys(mapped) as (keyof MappedPerson)[]) {
    if (k === 'fieldConfidence') continue;
    if (mapped[k] === undefined) continue;
    if (k === 'email') {
      mapped.fieldConfidence[k] = emailConfidence(mapped.emailStatus);
    } else {
      mapped.fieldConfidence[k] = base;
    }
  }
  return mapped;
}

export function mapApolloOrganization(apolloOrg: any): MappedOrganization {
  const o = apolloOrg ?? {};

  const departmentHeadcount: Record<string, number> | undefined = (() => {
    const src = o.departmental_head_count ?? o.departmentHeadcount;
    if (!src || typeof src !== 'object') return undefined;
    // S15: only keep keys matching a safe identifier shape — Apollo's response
    // is trusted but downstream UI/log consumers shouldn't see arbitrary
    // strings (DDB tolerates but rendering doesn't).
    const SAFE_KEY = /^[a-z][a-z0-9_]*$/i;
    const entries = Object.entries(src).filter(
      ([k, v]) => typeof v === 'number' && k.length <= 64 && SAFE_KEY.test(k),
    );
    if (!entries.length) return undefined;
    return Object.fromEntries(entries) as Record<string, number>;
  })();

  return {
    apolloOrgId: strOrUndef(o.id),
    domain: strOrUndef(o.primary_domain) ?? strOrUndef(o.website_url),
    name: strOrUndef(o.name),
    industry: strOrUndef(o.industry),
    industries: dedupConcat(arrayOfStrings(o.industries), arrayOfStrings(o.secondary_industries)),
    estimatedNumEmployees: numOrUndef(o.estimated_num_employees),
    foundedYear: numOrUndef(o.founded_year),
    annualRevenue: numOrUndef(o.annual_revenue),
    annualRevenuePrinted: strOrUndef(o.annual_revenue_printed),
    totalFunding: numOrUndef(o.total_funding),
    latestFundingStage: strOrUndef(o.latest_funding_stage),
    latestFundingRoundDate: strOrUndef(o.latest_funding_round_date),
    techStack: arrayOfStrings(o.technology_names) ?? arrayOfStrings(o.current_technologies),
    headcountGrowth6mo: numOrUndef(o.organization_headcount_six_month_growth),
    headcountGrowth12mo: numOrUndef(o.organization_headcount_twelve_month_growth),
    headcountGrowth24mo: numOrUndef(o.organization_headcount_twenty_four_month_growth),
    departmentHeadcount,
    hqCity: strOrUndef(o.city),
    hqState: strOrUndef(o.state),
    hqCountry: strOrUndef(o.country),
    hqRawAddress: strOrUndef(o.raw_address),
    websiteUrl: strOrUndef(o.website_url),
    linkedinUrl: strOrUndef(o.linkedin_url),
    twitterUrl: strOrUndef(o.twitter_url),
    phone: strOrUndef(o.sanitized_phone) ?? strOrUndef(o.phone),
    shortDescription: strOrUndef(o.short_description) ?? strOrUndef(o.seo_description),
  };
}

export interface MappedMatch {
  person: MappedPerson;
  organization?: MappedOrganization;
  /** Apollo's request_id, used to correlate async webhooks (phone reveals). */
  requestId?: string;
}

export function mapApolloMatchResponse(apiData: any, inputs: MapMatchInputs = {}): MappedMatch | null {
  if (!apiData) return null;
  const personRaw = apiData.person ?? null;
  if (!personRaw || !personRaw.id) return null;
  const orgRaw = personRaw.organization ?? personRaw.account ?? apiData.organization ?? null;
  return {
    person: mapApolloPerson(personRaw, inputs),
    organization: orgRaw ? mapApolloOrganization(orgRaw) : undefined,
    requestId: strOrUndef(apiData.request_id) ?? strOrUndef(personRaw.request_id),
  };
}

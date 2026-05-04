import { createHash } from 'crypto';
import { extractDomainFromEmail } from '../utils/leadSchema';

export type EntityType = 'company' | 'person';
export type EnrichmentCacheSource = 'web_search' | 'linkedin' | 'existing_data';

export interface LeadInfo {
  email?: string;
  company?: string;
  website?: string;
  firstName?: string;
  lastName?: string;
}

export interface RawWebResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string;
  thumbnail: string | null;
}

export interface RawCacheData {
  webResults: RawWebResult[];
  // Secondary LinkedIn company page search — only populated for groups containing company_linkedin_url
  linkedinCompanyResults: RawWebResult[] | null;
  linkedinData: {
    profileId: string;
    publicIdentifier: string;
    rawProfile: Record<string, unknown>;
    fetchedAt: string;
  } | null;
}

export interface FieldGroupConfig {
  entityType: EntityType;
  version: number;       // increment when fields array changes; triggers automatic cache miss
  fields: string[];
  sources: EnrichmentCacheSource[];
  searchTemplate: string;  // {{emailDomain}}, {{company}}, {{firstName}}, {{lastName}} placeholders
  ttlDays: number;
}

// Phase 1 groups — only what the current pipeline can populate.
// Phase 2 (person_social, contact_validity) require APIs not yet wired.
export const FIELD_GROUPS: Record<string, FieldGroupConfig> = {

  // ── COMPANY-LEVEL ────────────────────────────────────────────────────────
  // Cached per company domain. All leads from the same domain share one entry.

  company_firmographic: {
    entityType: 'company',
    version: 1,
    fields: [
      'company_name', 'website', 'industry', 'employee_count',
      'founded_year', 'hq_location', 'company_description',
      'company_type', 'company_linkedin_url',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} company overview',
    ttlDays: 180,
  },

  company_financial: {
    entityType: 'company',
    version: 1,
    fields: [
      'revenue_range', 'funding_stage', 'total_funding',
      'investors', 'last_funding_date', 'valuation',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} funding investors',
    ttlDays: 180,
  },

  company_technographic: {
    entityType: 'company',
    version: 1,
    fields: [
      'tech_stack', 'crm_used', 'marketing_tools',
      'cloud_provider', 'analytics_tools', 'engineering_stack',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} technology stack tools',
    ttlDays: 180,
  },

  company_social: {
    entityType: 'company',
    version: 1,
    fields: [
      'twitter_handle', 'linkedin_followers',
      'glassdoor_rating', 'g2_rating',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} linkedin twitter glassdoor',
    ttlDays: 180,
  },

  intent_signals: {
    entityType: 'company',
    version: 1,
    fields: [
      'recent_news', 'hiring_signals', 'job_postings_count',
      'leadership_changes', 'funding_news', 'expansion_signals',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} news hiring announcement',
    ttlDays: 30,  // signals go stale faster than facts
  },

  company_geography: {
    entityType: 'company',
    version: 1,
    fields: [
      'country', 'region', 'time_zone',
      'all_office_locations', 'hq_address',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} headquarters offices locations',
    ttlDays: 180,
  },

  company_product: {
    entityType: 'company',
    version: 1,
    fields: [
      'product_categories', 'pricing_model', 'target_market',
      'primary_offerings', 'customer_logos',
    ],
    sources: ['web_search'],
    searchTemplate: '{{emailDomain}} products pricing customers',
    ttlDays: 90,
  },

  // ── PERSON-LEVEL ─────────────────────────────────────────────────────────
  // Cached per work email. Leads with the same email get the same person entry.

  person_identity: {
    entityType: 'person',
    version: 1,
    fields: [
      'first_name', 'last_name', 'title', 'seniority',
      'department', 'linkedin_url', 'email', 'phone', 'location',
    ],
    sources: ['linkedin', 'web_search'],
    searchTemplate: '{{firstName}} {{lastName}} {{emailDomain}} linkedin',
    ttlDays: 90,
  },

  person_career: {
    entityType: 'person',
    version: 1,
    fields: [
      'tenure_at_company', 'prior_companies', 'education',
      'recent_role_change_date', 'years_experience',
    ],
    sources: ['linkedin', 'web_search'],
    searchTemplate: '{{firstName}} {{lastName}} {{emailDomain}} career history',
    ttlDays: 90,
  },
};

// ── Canonical key builders ────────────────────────────────────────────────────

export function buildCompanyCanonicalKey(lead: LeadInfo): string | null {
  // Priority 1: work email domain (most stable; free domains already excluded)
  const emailDomain = extractDomainFromEmail(lead.email);
  if (emailDomain) return `company:${emailDomain}`;

  // Priority 2: explicit website domain
  if (lead.website) {
    const domain = extractDomainFromUrl(lead.website);
    if (domain) return `company:${domain}`;
  }

  // Priority 3: normalized company name (weaker — collision-prone, last resort)
  const co = normalizeCompanyName(lead.company ?? '');
  if (co) return `company:${co}`;

  return null;
}

export function buildPersonCanonicalKey(lead: LeadInfo): string | null {
  // Priority 1: work email — most unique identifier per person
  const emailDomain = extractDomainFromEmail(lead.email);
  if (emailDomain && lead.email) {
    return `person:${lead.email.trim().toLowerCase()}`;
  }

  // Priority 2: domain (from website or company) + normalized full name
  const domain =
    (lead.website ? extractDomainFromUrl(lead.website) : null) ??
    normalizeCompanyName(lead.company ?? '');
  const name = normalizeName(`${lead.firstName ?? ''} ${lead.lastName ?? ''}`);

  if (domain && name) return `person:${domain}:${name}`;

  return null;
}

export function toCanonicalId(canonicalKey: string): string {
  return createHash('sha256').update(canonicalKey).digest('hex');
}

export function toFieldGroupSk(groupName: string, version: number): string {
  return `${groupName}#v${version}`;
}

// ── Normalizers (private) ─────────────────────────────────────────────────────

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\b(inc|llc|ltd|corp|co|plc|gmbh|pty|limited|incorporated)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z\s]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractDomainFromUrl(url: string): string | null {
  try {
    const withProtocol = url.startsWith('http') ? url : `https://${url}`;
    const parsed = new URL(withProtocol);
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    // Require at least one dot — bare labels like "localhost" or garbage strings aren't useful keys
    if (!hostname || !hostname.includes('.')) return null;
    return hostname;
  } catch {
    return null;
  }
}

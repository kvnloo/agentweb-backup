/**
 * fieldValueValidator — shared, provider-agnostic shape validation for enriched
 * field values, applied at the single write boundary in the V3 orchestrator
 * (crmEnrichmentServiceV3.ts) so EVERY source (Apollo, enrich.so, Unipile,
 * web-search, LLM) is covered by one rule set.
 *
 * Background: provider APIs occasionally return malformed values that are
 * non-empty strings but not real data — e.g. enrich.so returned a LinkedIn
 * *search* URL ("linkedin.com/search/results/companies/?keywords=…") for
 * company_linkedin_url. The per-tier checks only validated the LLM path, so the
 * garbage sailed through the api tier. Centralizing the guard here means adding
 * a new provider can't reintroduce the gap.
 *
 * Pure + synchronous (no I/O) — safe to call inside a fill filter.
 */

// LinkedIn organization pages legitimately come in three path forms:
//   /company/  — businesses
//   /school/   — educational institutions (universities, schools)
//   /showcase/ — sub-brand / product showcase pages
// All are valid company-linkedin values; only non-org paths (/search/, /in/,
// /pub/dir/, bare text) are rejected.
const VALID_COMPANY_LINKEDIN_RE = /linkedin\.com\/(company|school|showcase)\//i;
const VALID_PERSON_LINKEDIN_RE = /linkedin\.com\/in\//i;

// Only the fields that are supposed to hold a LinkedIn *profile URL* are
// shape-validated. Crucially this is an explicit allowlist, NOT a substring
// match on "linkedin": fields like `linkedin_followers` (a count) or a future
// `linkedin_headline` (free text) must pass through untouched. Names are
// normalized (lowercased, underscores stripped) so canonical (`linkedin_url`,
// `company_linkedin_url`) and config/camelCase (`linkedin`, `companyLinkedin`)
// variants all map to the same key.
const PERSON_LINKEDIN_FIELDS = new Set(['linkedin', 'linkedinurl']);
const COMPANY_LINKEDIN_FIELDS = new Set(['companylinkedin', 'companylinkedinurl']);

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/_/g, '');
}

/**
 * Returns true when `value` is an acceptable value for `field`.
 *
 * - company linkedin URL fields → must be a real linkedin.com/company/ URL
 * - person linkedin URL fields  → must be a real linkedin.com/in/ URL
 *   (rejects /search/, /pub/dir/, company pages, bare handles, etc.)
 * - every other field           → accepted unchanged. This includes non-URL
 *   linkedin-named fields (linkedin_followers, etc.) which are intentionally
 *   NOT in the allowlists above.
 *
 * Empty/non-string values are treated as invalid so callers can use this as the
 * sole gate without a separate emptiness check.
 */
export function isValidFieldValue(field: string, value: string): boolean {
  const key = normalizeFieldName(field);
  const isCompanyLinkedin = COMPANY_LINKEDIN_FIELDS.has(key);
  const isPersonLinkedin = PERSON_LINKEDIN_FIELDS.has(key);

  // Non-linkedin fields are never inspected — return early so nothing else can
  // ever gate them. Only the two linkedin URL fields below get any validation.
  if (!isCompanyLinkedin && !isPersonLinkedin) return true;

  if (typeof value !== 'string' || value.length === 0) return false;

  return isCompanyLinkedin
    ? VALID_COMPANY_LINKEDIN_RE.test(value)
    : VALID_PERSON_LINKEDIN_RE.test(value);
}

/**
 * Convenience for call sites that build an object literal or conditional
 * assignment from a raw provider URL (e.g. the enrich.so direct route and its
 * draft preview): returns the URL only when it is a non-empty http(s) string
 * AND a valid LinkedIn URL for `field`, otherwise `undefined`.
 */
export function linkedinUrlOrUndef(field: string, url: string | null | undefined): string | undefined {
  return typeof url === 'string' && url.startsWith('http') && isValidFieldValue(field, url)
    ? url
    : undefined;
}

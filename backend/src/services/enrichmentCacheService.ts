import { crmDb } from './db';
import {
  FIELD_GROUPS,
  buildCompanyCanonicalKey,
  buildPersonCanonicalKey,
  toCanonicalId,
  toFieldGroupSk,
  type LeadInfo,
  type RawCacheData,
} from './enrichmentGroups';

// Maps each field to the first group that contains it.
// Fields not in any group go to `ungrouped`.
//
// `aliases` is an optional user-field-name → canonical-field-name map. The
// caller (resolveFieldAliases in enrichmentFieldAliasService) populates it
// from a static alias map, the list's persisted canonical map, and an LLM
// mapping for novel field names. With this, a user field like `funding_round`
// (alias for `funding_stage`) lands in `company_financial` group instead of
// the legacy ungrouped path — which means cache reuse + targeted search.
//
// Behavior:
//   • If aliases[field] is set and points to a canonical field that exists
//     in some group, the user's original field name is bucketed into that
//     group (so the LLM is asked for `funding_round` not `funding_stage`,
//     but cache key + search template come from the canonical group).
//   • Otherwise, exact match against group.fields wins.
//   • Otherwise, the field goes to `ungrouped`.
export function splitFieldsByGroup(
  fields: string[],
  options?: { aliases?: Record<string, string> }
): { byGroup: Map<string, string[]>; ungrouped: string[] } {
  const aliases = options?.aliases ?? {};
  const byGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];

  for (const field of fields) {
    // Resolve to canonical: alias > self
    const canonical = aliases[field] ?? field;
    let found = false;
    for (const [groupName, config] of Object.entries(FIELD_GROUPS)) {
      if (config.fields.includes(canonical)) {
        if (!byGroup.has(groupName)) byGroup.set(groupName, []);
        // KEEP user's original field name — the LLM extraction prompt and
        // customFields persistence both use the user-facing name.
        byGroup.get(groupName)!.push(field);
        found = true;
        break;
      }
    }
    if (!found) ungrouped.push(field);
  }
  return { byGroup, ungrouped };
}

export async function getRawDataFromCache(
  lead: LeadInfo,
  groupName: string,
  forceRefreshCache = false
): Promise<RawCacheData | null> {
  const config = FIELD_GROUPS[groupName];
  if (!config) return null;

  const canonicalKey = config.entityType === 'company'
    ? buildCompanyCanonicalKey(lead)
    : buildPersonCanonicalKey(lead);

  if (!canonicalKey) return null;
  if (forceRefreshCache) return null;

  const canonicalId = toCanonicalId(canonicalKey);
  const sk = toFieldGroupSk(groupName, config.version);

  let item: any;
  try {
    item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
  } catch (err: any) {
    // Table not yet created — treat as cache miss, don't fail enrichment
    if (err?.code === 'ResourceNotFoundException') return null;
    throw err;
  }
  if (!item) return null;

  // Belt-and-suspenders: DynamoDB TTL deletes asynchronously, so an item
  // can still be returned for a short window after its expiresAt passes.
  if (item.expiresAt <= Math.floor(Date.now() / 1000)) return null;

  return item.rawData as RawCacheData;
}

export async function writeRawDataToCache(
  lead: LeadInfo,
  groupName: string,
  rawData: RawCacheData,
  queryUsed: string,
  sourcesUsed: string[]
): Promise<void> {
  const config = FIELD_GROUPS[groupName];
  if (!config) return;

  const canonicalKey = config.entityType === 'company'
    ? buildCompanyCanonicalKey(lead)
    : buildPersonCanonicalKey(lead);

  if (!canonicalKey) return;

  const canonicalId = toCanonicalId(canonicalKey);
  const sk = toFieldGroupSk(groupName, config.version);
  const colonIdx = canonicalKey.indexOf(':');
  const entityKey = colonIdx !== -1 ? canonicalKey.slice(colonIdx + 1) : canonicalKey;

  try {
    await crmDb.putEnrichmentCacheItem({
      canonicalId,
      fieldGroup: sk,
      canonicalKey,
      entityKey,
      entityType: config.entityType,
      cacheType: 'field_group',
      rawData,
      queryUsed,
      sourcesUsed,
      resultCount: rawData.webResults.length,
      schemaVersion: config.version,
      fetchedAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + config.ttlDays * 86400,
    });
  } catch (err: any) {
    // Race condition: another worker wrote this entry first, ignore
    if (err?.code === 'ConditionalCheckFailedException') return;
    // Table not yet created — silently skip the write
    if (err?.code === 'ResourceNotFoundException') return;
    throw err;
  }
}

// Reconstruct the webContext string the LLM expects from cached raw data.
// Mirrors the string format built by gatherWebContext() in crmEnrichmentService.
export function buildWebContextFromCache(
  rawData: RawCacheData,
  hasCompanyLinkedinField: boolean
): string {
  if (rawData.webResults.length === 0) return '';

  let webContext = JSON.stringify(rawData.webResults, null, 2);

  if (hasCompanyLinkedinField && rawData.linkedinCompanyResults && rawData.linkedinCompanyResults.length > 0) {
    const companyUrls = rawData.linkedinCompanyResults
      .map(r => r.url)
      .filter(url => /linkedin\.com\/company\//i.test(url));
    webContext += `\n\nDedicated LinkedIn company page search results:\n${JSON.stringify(rawData.linkedinCompanyResults, null, 2)}`;
    if (companyUrls.length > 0) {
      webContext += `\n\nLinkedIn company page URLs found in dedicated search (use these first):\n${companyUrls.join('\n')}`;
    }
  }

  return webContext;
}

// Reconstruct the linkedinContext string the LLM expects from cached raw data.
// Mirrors the string format built by gatherLinkedInContext() in crmEnrichmentService.
export function buildLinkedInContextFromCache(
  rawData: RawCacheData,
  isEnrichingLinkedin: boolean
): string {
  if (!rawData.linkedinData) return '';

  let linkedinContext = `\nLinkedIn profile data:\n${JSON.stringify(rawData.linkedinData.rawProfile, null, 2)}`;

  if (isEnrichingLinkedin && rawData.linkedinData.publicIdentifier) {
    const profileUrl = `https://www.linkedin.com/in/${rawData.linkedinData.publicIdentifier}`;
    linkedinContext += `\n\nResolved LinkedIn profile URL: ${profileUrl}`;
  }

  return linkedinContext;
}

// Returns the group name if all fields belong to a single company-level group, else null.
// Used in enrichLead() to decide whether this enrichment job is cache-eligible.
export function resolveCompanyGroupForFields(fields: string[]): string | null {
  for (const [groupName, config] of Object.entries(FIELD_GROUPS)) {
    if (config.entityType !== 'company') continue;
    if (fields.every(f => config.fields.includes(f))) return groupName;
  }
  return null;
}

// Returns true if all LinkedIn-source fields belong to person_identity group.
export function isLinkedInCacheEligible(linkedinFields: string[]): boolean {
  const config = FIELD_GROUPS.person_identity;
  return linkedinFields.every(f => config.fields.includes(f));
}

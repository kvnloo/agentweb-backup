/**
 * Strips internal-only audit fields from `enrichmentMetadata` before sending
 * to the customer-portal. Specifically:
 *
 *  - Rewrites `source: 'crm-history'` to `source: 'agentweb'` so end-users
 *    never see the cross-tenant origin tag.
 *  - Removes `siblingLeadId`, `siblingListId`, `siblingUserId` from any field
 *    meta (those exist only for server-side debugging / data-lineage work).
 *  - ENG-1388/ENG-1930: strips Enigma card-revenue fields from a lead when the
 *    VIEWER (not the list owner) isn't on the Enigma allowlist. The allowlist
 *    (ENIGMA_ENRICHMENT_USER_ALLOWLIST) only ever gated who could TRIGGER a
 *    paid lookup — canAccessCrmList's normal org-sharing path lets any
 *    same-org member read a lead once it exists, with no allowlist check at
 *    all (found live, CodeRabbit on agentweb#3061: an org member who was
 *    never allowlisted could already read card revenue on a co-worker's
 *    list). Enigma's licence is internal-use-only, not "internal to whichever
 *    org happens to share this list" — this is the actual display boundary.
 *
 * Internal-only endpoints that legitimately need the full audit shape (admin
 * delegation, debug routes) should NOT call this — they should serialize the
 * raw stored value.
 */

import type { EnrichedFieldMeta } from './enrichedFieldValue';
import { isCardRevenueField } from '../services/enrichmentGroups';
import { isEnigmaEnrichmentEnabledForUser } from '../services/enigmaCardRevenueEnrichment';

type AnyMeta = Partial<EnrichedFieldMeta> & Record<string, any>;

export function sanitizeEnrichmentFieldMeta(meta: AnyMeta | undefined | null): AnyMeta | undefined {
  if (!meta || typeof meta !== 'object') return meta as undefined;
  const { siblingLeadId, siblingListId, siblingUserId, ...rest } = meta;
  void siblingLeadId; void siblingListId; void siblingUserId;
  if (rest.source === 'crm-history') {
    rest.source = 'agentweb';
  }
  return rest;
}

export function sanitizeEnrichmentMetadataForResponse(
  enrichmentMetadata: Record<string, AnyMeta> | undefined | null,
): Record<string, AnyMeta> | undefined {
  if (!enrichmentMetadata || typeof enrichmentMetadata !== 'object') return enrichmentMetadata as undefined;
  const out: Record<string, AnyMeta> = {};
  for (const [field, meta] of Object.entries(enrichmentMetadata)) {
    const cleaned = sanitizeEnrichmentFieldMeta(meta);
    if (cleaned !== undefined) out[field] = cleaned;
  }
  return out;
}

/** Drops any card-revenue key from a plain field-keyed map (customFields or enrichmentMetadata). */
export function stripCardRevenueKeys<V>(map: Record<string, V> | undefined | null): Record<string, V> | undefined {
  if (!map || typeof map !== 'object') return map as undefined;
  const out: Record<string, V> = {};
  for (const [field, value] of Object.entries(map)) {
    if (!isCardRevenueField(field)) out[field] = value;
  }
  return out;
}

/**
 * True when card-revenue fields must be hidden from this viewer: a
 * `viewerUserId` was given and it isn't on the Enigma allowlist. Every
 * customer-facing read (REST, Emma tools, CSV export) is already behind
 * `authenticateToken`, so `viewerUserId` is always a real id there — pass it
 * at every such call site. Omitting it preserves the old no-filtering
 * behaviour, for internal-only callers that don't serve a specific viewer.
 */
export function shouldHideCardRevenueForViewer(viewerUserId: string | undefined | null): boolean {
  return !!viewerUserId && !isEnigmaEnrichmentEnabledForUser(viewerUserId);
}

/**
 * Convenience wrapper: shallow-clones the lead, replaces its
 * `enrichmentMetadata` with the sanitized version, and — when `viewerUserId`
 * is given and NOT Enigma-allowlisted — strips card-revenue fields from both
 * `customFields` and `enrichmentMetadata` regardless of list ownership. Pass
 * `viewerUserId` at every customer-facing read; omitting it preserves the old
 * behaviour (no card-revenue filtering) for callers that already restrict
 * this some other way (there are none today — every caller should pass it).
 * Returns a new object so the caller's reference to the raw row is untouched.
 */
export function sanitizeLeadForResponse<T extends { enrichmentMetadata?: any; customFields?: Record<string, any> }>(
  lead: T | null | undefined,
  viewerUserId?: string,
): T | null | undefined {
  if (!lead) return lead;
  const hideCardRevenue = shouldHideCardRevenueForViewer(viewerUserId);
  if (!lead.enrichmentMetadata && !hideCardRevenue && !('emailDraftSendClaimedAt' in lead)) return lead;
  // ENG-2984: the send lease is server-only; preserve the raw row for claim checks.
  const publicLead = { ...lead };
  delete (publicLead as T & { emailDraftSendClaimedAt?: unknown }).emailDraftSendClaimedAt;
  return {
    ...publicLead,
    ...(lead.enrichmentMetadata ? { enrichmentMetadata: sanitizeEnrichmentMetadataForResponse(lead.enrichmentMetadata) } : {}),
    ...(hideCardRevenue ? {
      customFields: stripCardRevenueKeys(lead.customFields) ?? lead.customFields,
      ...(lead.enrichmentMetadata ? { enrichmentMetadata: stripCardRevenueKeys(sanitizeEnrichmentMetadataForResponse(lead.enrichmentMetadata)) } : {}),
    } : {}),
  };
}

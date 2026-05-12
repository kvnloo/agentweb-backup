/**
 * Strips internal-only audit fields from `enrichmentMetadata` before sending
 * to the customer-portal. Specifically:
 *
 *  - Rewrites `source: 'crm-history'` to `source: 'agentweb'` so end-users
 *    never see the cross-tenant origin tag.
 *  - Removes `siblingLeadId`, `siblingListId`, `siblingUserId` from any field
 *    meta (those exist only for server-side debugging / data-lineage work).
 *
 * Internal-only endpoints that legitimately need the full audit shape (admin
 * delegation, debug routes) should NOT call this — they should serialize the
 * raw stored value.
 */

import type { EnrichedFieldMeta } from './enrichedFieldValue';

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

/**
 * Convenience wrapper: shallow-clones the lead and replaces its
 * `enrichmentMetadata` with the sanitized version. Returns a new object so
 * the caller's reference to the raw row is untouched.
 */
export function sanitizeLeadForResponse<T extends { enrichmentMetadata?: any }>(lead: T | null | undefined): T | null | undefined {
  if (!lead) return lead;
  if (!lead.enrichmentMetadata) return lead;
  return { ...lead, enrichmentMetadata: sanitizeEnrichmentMetadataForResponse(lead.enrichmentMetadata) };
}

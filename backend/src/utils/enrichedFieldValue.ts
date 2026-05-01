/**
 * Sidecar metadata for an enriched lead field.
 *
 * Stored on the lead as `enrichmentMetadata: Record<fieldName, EnrichedFieldMeta>`,
 * separate from the value (which stays in `customFields[fieldName]` or the standard
 * lead column). UI joins value + meta at display time.
 */
export interface EnrichedFieldMeta {
  source: 'web_search' | 'linkedin' | 'existing_data' | 'manual';
  sourceUrl?: string;
  sourceQuote?: string;
  confidence?: 'high' | 'medium' | 'low';
  enrichedAt: string;          // ISO
  enrichedJobId?: string;
  /** Set when a user has manually verified the value. */
  verifiedBy?: { userId: string; at: string };
  /** Set when a user has rejected the value. */
  rejectedReason?: string;
  rejectedAt?: string;
  /** Critic verdict from item #6 critic pass, if it ran. */
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  /** Normalized form of the value (e.g. enum, numeric range) when a type spec recognizes the field. */
  normalized?: string | number | { min: number; max: number } | null;
}

/** Trim a quote to a reasonable size to bound row growth in DynamoDB. */
const MAX_QUOTE_CHARS = 240;

export function trimQuote(quote: string | undefined | null): string | undefined {
  if (typeof quote !== 'string') return undefined;
  const t = quote.trim();
  if (!t) return undefined;
  return t.length > MAX_QUOTE_CHARS ? t.slice(0, MAX_QUOTE_CHARS) + '…' : t;
}

/** Whitelist-merge metadata patch: drops keys whose value is undefined. */
export function mergeMeta(
  base: EnrichedFieldMeta | undefined,
  patch: Partial<EnrichedFieldMeta>
): EnrichedFieldMeta {
  const next: EnrichedFieldMeta = base
    ? { ...base }
    : { source: 'manual', enrichedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch) as [keyof EnrichedFieldMeta, unknown][]) {
    if (v !== undefined) (next as any)[k] = v;
  }
  return next;
}

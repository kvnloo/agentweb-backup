/**
 * Sidecar metadata for an enriched lead field.
 *
 * Stored on the lead as `enrichmentMetadata: Record<fieldName, EnrichedFieldMeta>`,
 * separate from the value (which stays in `customFields[fieldName]` or the standard
 * lead column). UI joins value + meta at display time.
 */
export interface EnrichedFieldMeta {
  /**
   * Origin classification.
   *  - 'crm-history': internal-only marker for CRM-history Tier 0 fills. The
   *    response sanitizer in `sanitizeEnrichmentMetadataForResponse` rewrites
   *    this to 'agentweb' before returning to the customer-portal so that the
   *    cross-tenant origin is never surfaced to end users.
   *  - 'agentweb': the public-facing source value the UI sees for those fills.
   */
  /**
   *  - 'llm': value computed by the smart-field LLM evaluator (POST enrichment phase).
   */
  source: 'web_search' | 'linkedin' | 'existing_data' | 'manual' | 'api' | 'crm-history' | 'agentweb' | 'llm';
  /**
   * For 'crm-history' fills: the leadId of the sibling we copied from.
   * Stripped before responses reach the customer-portal.
   */
  siblingLeadId?: string;
  siblingListId?: string;
  siblingUserId?: string;
  /**
   * Specific data provider that produced this value, when known. `source` says
   * what *kind* of data it is (web vs linkedin vs internal); `provider` says
   * *who* supplied it (e.g. enrich.so, unipile, crunchbase, openmart). The
   * provenance UI shows the provider when set, falling back to the source
   * label. Visible only to admins / delegated sessions.
   */
  provider?: string;
  sourceUrl?: string;
  sourceQuote?: string;
  confidence?: 'high' | 'medium' | 'low';
  enrichedAt: string;          // ISO
  enrichedJobId?: string;
  /** Whether this value was served from a provider cache rather than a live API call.
   *  Absent on legacy records written before this field was added. */
  fromCache?: boolean;
  /** Set when a user has manually verified the value. */
  verifiedBy?: { userId: string; at: string };
  /** Set when a user has rejected the value. */
  rejectedReason?: string;
  rejectedAt?: string;
  /** Critic verdict from item #6 critic pass, if it ran. */
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  /**
   * Actionable per-field quality view derived from `criticVerdict` for
   * web-sourced fields. Advisory only — a `drop` view recommends removal but
   * the value is never auto-deleted.
   *  - 'drop' ← contradicted
   *  - 'low'  ← unsupported / partially-supported
   *  - 'high' ← supported
   */
  criticView?: 'drop' | 'low' | 'high';
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

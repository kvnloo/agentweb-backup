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
  /**
   * Grounding classification for web-tier values (ENG-122). Distinguishes a
   * value proven against the fetched source text from one that could not be:
   *  - 'grounded': the value/quote was found in the real fetched source → safe to state.
   *  - 'web-unverified': web-sourced but the quote couldn't be matched to the source → hedge.
   *  - 'ai-knowledge': asserted from the model's training memory with no web source
   *    (kept only when the stated company matches the lead) → hedge, distinct badge.
   * Drives the "Web — unverified" vs "AI knowledge — unverified" UI badges.
   */
  grounding?: 'grounded' | 'web-unverified' | 'ai-knowledge';
  /** Normalized form of the value (e.g. enum, numeric range) when a type spec recognizes the field. */
  normalized?: string | number | { min: number; max: number } | null;
}

/**
 * Classify how trustworthy an enriched field value is, for caveating in UX.
 *
 * Returns 'verified' when the value is safe to state as fact, 'unverified'
 * when it should be hedged ("unverified", "per web search", low confidence).
 *
 * The Slashy bug: a small company's funding_stage isn't in Apollo, so it's
 * filled by the web-search/LLM tier (`metaWeb` → confidence 'medium'). The LLM
 * can return a plausible-but-wrong stage ("Series C"). Treating 'medium'/'low'/
 * unknown confidence as unverified lets the assistant caveat it instead of
 * asserting it.
 *
 * Precedence (first match wins):
 *  1. User action — `verifiedBy` ⇒ verified; `rejectedReason`/`rejectedAt` ⇒ unverified.
 *  2. Critic verdict (web-tier only) — `criticView` 'high' ⇒ verified; 'low'/'drop' ⇒ unverified.
 *  3. Confidence — 'high' ⇒ verified; 'medium'/'low'/absent ⇒ unverified.
 */
export function fieldVerificationStatus(
  meta: EnrichedFieldMeta | undefined,
): 'verified' | 'unverified' {
  if (!meta) return 'unverified';
  if (meta.verifiedBy) return 'verified';
  if (meta.rejectedReason || meta.rejectedAt) return 'unverified';
  // ENG-122: values that couldn't be grounded in the fetched source carry a
  // badged-unverified state and are NEVER auto-promoted to verified.
  if (meta.grounding === 'web-unverified' || meta.grounding === 'ai-knowledge') return 'unverified';
  // Critic caution downgrades even a grounded value (source may describe a
  // different entity — the Slash/Slashy case).
  if (meta.criticView === 'low' || meta.criticView === 'drop') return 'unverified';
  // Deterministic grounding: the fact was found in the real fetched source.
  if (meta.grounding === 'grounded') return 'verified';
  if (meta.criticView === 'high') return 'verified';
  return meta.confidence === 'high' ? 'verified' : 'unverified';
}

/**
 * Which "— unverified" provenance badge (if any) the UI should show for a field.
 * Returns null when the value is verified (no caveat needed). Otherwise maps the
 * grounding classification to the two ENG-122 badges, falling back to the web
 * badge for legacy web-sourced values written before `grounding` existed.
 */
export function fieldProvenanceBadge(
  meta: EnrichedFieldMeta | undefined,
): null | 'web-unverified' | 'ai-knowledge' {
  if (!meta) return null;
  if (fieldVerificationStatus(meta) === 'verified') return null;
  if (meta.grounding === 'ai-knowledge') return 'ai-knowledge';
  if (meta.grounding === 'web-unverified') return 'web-unverified';
  if (meta.source === 'web_search') return 'web-unverified';
  return null;
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

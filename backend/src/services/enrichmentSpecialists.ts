/**
 * Item #7 — Specialist registry.
 *
 * For high-value fields where we have a direct API or scraper that's more
 * reliable than scraping search-result snippets, register a specialist.
 * The enrichment pipeline calls specialists BEFORE the LLM extraction step;
 * fields populated by a specialist are skipped by the LLM (no double-work).
 *
 * Today this just formalizes the LinkedIn API path that's already wired into
 * the pipeline; the registry is the structural plug-point for future specialists
 * (Crunchbase, Apollo, ZoomInfo, etc.) without churning enrichLead.
 */

import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

export interface SpecialistResult {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  source: EnrichedFieldMeta['source'];
  sourceUrl?: string;
  sourceQuote?: string;
}

export interface FieldSpecialist {
  /** Field name this specialist provides values for. */
  fieldName: string;
  /** Stable label for logs and metadata. */
  label: string;
  /**
   * Try to populate the field. Return null when the specialist can't help —
   * the LLM-extraction path will then handle it as usual.
   */
  resolve(lead: LeadRecord, ctx: SpecialistContext): Promise<SpecialistResult | null>;
}

export interface SpecialistContext {
  userId: string;
  linkedInAccountId?: string | null;
}

const REGISTRY: Map<string, FieldSpecialist> = new Map();

export function registerSpecialist(spec: FieldSpecialist): void {
  REGISTRY.set(spec.fieldName, spec);
}

export function getSpecialist(fieldName: string): FieldSpecialist | undefined {
  return REGISTRY.get(fieldName);
}

export function clearSpecialists(): void {
  REGISTRY.clear();
}

export interface SpecialistFailure {
  field: string;
  label: string;
  message: string;
}

export interface RunSpecialistsResult {
  resolvedFields: Record<string, string | null>;
  resolvedMeta: Record<string, Pick<EnrichedFieldMeta, 'source' | 'sourceUrl' | 'sourceQuote' | 'confidence'>>;
  sourceContexts: string[];
  /**
   * Specialists that threw while resolving. Non-fatal — the LLM-extraction
   * path still runs for these fields — but the caller may want to surface
   * these in failure-breakdown so users can see *why* a value came from the
   * fallback path instead of the higher-confidence specialist.
   */
  failures: SpecialistFailure[];
}

/**
 * Run any matching specialists for the given output fields. Returns:
 *   - resolvedFields: fields whose values came from a specialist
 *   - resolvedMeta: metadata for those fields
 *   - sourceContexts: extra source text to append to combinedSource for
 *     citation verification (e.g., the raw Crunchbase snippet that backed
 *     the value). Without this, verifyCitations would reject specialist
 *     values because their sourceQuote isn't in web/linkedin context.
 *   - failures: structured per-field error info for specialists that threw.
 *
 * The caller should:
 *   1. Remove resolvedFields from the LLM extraction list
 *   2. Merge resolvedFields/resolvedMeta into the final enrichment output
 *   3. Append sourceContexts to combinedSource before verifyCitations
 *   4. Optionally record failures in the job's failure-breakdown
 */
export async function runSpecialists(
  outputFields: string[],
  lead: LeadRecord,
  ctx: SpecialistContext
): Promise<RunSpecialistsResult> {
  const resolvedFields: Record<string, string | null> = {};
  const resolvedMeta: Record<string, any> = {};
  const sourceContextsByLabel = new Map<string, string>();  // dedup by specialist label
  const failures: SpecialistFailure[] = [];

  await Promise.all(outputFields.map(async (field) => {
    const specialist = REGISTRY.get(field);
    if (!specialist) return;
    try {
      const r = await specialist.resolve(lead, ctx);
      if (r) {
        resolvedFields[field] = r.value;
        resolvedMeta[field] = {
          source: r.source,
          sourceUrl: r.sourceUrl,
          sourceQuote: r.sourceQuote,
          confidence: r.confidence,
        };
        if (r.sourceQuote) {
          // The quote itself is enough for verification when the specialist's
          // source isn't otherwise in combinedSource. Use specialist label as
          // dedup key so 3 specialists from the same source contribute one block.
          const existing = sourceContextsByLabel.get(specialist.label) || '';
          sourceContextsByLabel.set(specialist.label, existing + '\n' + r.sourceQuote);
        }
      }
    } catch (err: unknown) {
      // Specialist failures are non-fatal — pipeline falls back to LLM extraction.
      // Structured failure record so callers can attribute the LLM fallback to
      // the specialist outage instead of a silent miss. err may not be an Error.
      const message = err instanceof Error
        ? err.message
        : (typeof err === 'string' ? err : 'unknown specialist error');
      console.warn(`[enrichmentSpecialists] ${specialist.label} failed for field ${field}: ${message}`);
      failures.push({ field, label: specialist.label, message });
    }
  }));

  return {
    resolvedFields,
    resolvedMeta,
    sourceContexts: Array.from(sourceContextsByLabel.values()),
    failures,
  };
}

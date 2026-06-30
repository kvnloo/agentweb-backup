/**
 * Meta Ads breakdown partial-failure status (ENG-104).
 *
 * `getMetaAdsMetrics` fetches three "breakdown" insights endpoints (demographics,
 * placement, device) concurrently. Unlike the core endpoints (which throw — a
 * FATAL failure), a breakdown error is non-fatal: the method logs it and proceeds.
 * The problem was that a missing/errored breakdown became indistinguishable from
 * an empty-but-successful one, and the tool always returned `success: true` with
 * no indication of which sections actually came back. A partial failure was thus
 * invisible to both the caller/LLM (tool result) and telemetry.
 *
 * This PURE helper summarizes the three raw Graph API responses into an explicit
 * per-section status so the caller can attach `sections` + `partialFailure` +
 * `unavailableSections` to its result. It does NOT decide fatal-vs-partial — the
 * caller keeps its existing `throw` on the core endpoints (fatal => success:false)
 * and uses this only for the non-fatal breakdowns (partial => success:true +
 * partialFailure:true). This mirrors the structured-error taxonomy the repo
 * already uses (toolErrorClassifier / toolFailureType): breakdowns are a distinct
 * 'partial' class, separate from a thrown 'fatal' failure.
 */

/** A raw Graph API breakdown response: success carries `data`, failure carries
 * `error`, and it can also be null/undefined when a fetch produced nothing. */
export type MetaBreakdownResponse =
  | { data?: unknown[]; error?: { message?: string; code?: number | string } | null }
  | null
  | undefined;

export type MetaBreakdownSection = 'demographics' | 'placement' | 'device';
export type MetaBreakdownSectionStatus = 'ok' | 'unavailable';

export interface MetaBreakdownStatusSummary {
  /** Per-section availability — 'ok' when the section's data came back, else 'unavailable'. */
  sections: Record<MetaBreakdownSection, MetaBreakdownSectionStatus>;
  /** Sections that did NOT come back (errored or null), in stable order. */
  unavailableSections: MetaBreakdownSection[];
  /** True when at least one breakdown section is unavailable. */
  partialFailure: boolean;
  /** Per-section error message captured from the raw response (only for unavailable sections). */
  sectionErrors: Partial<Record<MetaBreakdownSection, string>>;
}

const SECTION_ORDER: MetaBreakdownSection[] = ['demographics', 'placement', 'device'];

/**
 * A section is unavailable when the response is null/undefined OR carries an
 * `error`. An empty-but-successful response (`{ data: [] }` with no error) is
 * 'ok' — the campaign legitimately had no breakdown rows; that is not a failure.
 */
function sectionErrorMessage(response: MetaBreakdownResponse): string | null {
  if (response == null) return 'No response received';
  const err = response.error;
  if (err == null) return null;
  const message = typeof err.message === 'string' && err.message.trim() ? err.message.trim() : 'Unknown breakdown error';
  return err.code != null && err.code !== '' ? `${message} (code ${err.code})` : message;
}

export function summarizeBreakdownSections(input: {
  demographics: MetaBreakdownResponse;
  placement: MetaBreakdownResponse;
  device: MetaBreakdownResponse;
}): MetaBreakdownStatusSummary {
  const responses: Record<MetaBreakdownSection, MetaBreakdownResponse> = {
    demographics: input.demographics,
    placement: input.placement,
    device: input.device,
  };

  const sections = {} as Record<MetaBreakdownSection, MetaBreakdownSectionStatus>;
  const unavailableSections: MetaBreakdownSection[] = [];
  const sectionErrors: Partial<Record<MetaBreakdownSection, string>> = {};

  for (const section of SECTION_ORDER) {
    const errorMessage = sectionErrorMessage(responses[section]);
    if (errorMessage) {
      sections[section] = 'unavailable';
      unavailableSections.push(section);
      sectionErrors[section] = errorMessage;
    } else {
      sections[section] = 'ok';
    }
  }

  return {
    sections,
    unavailableSections,
    partialFailure: unavailableSections.length > 0,
    sectionErrors,
  };
}

/** Structured telemetry payload for a tool that succeeded with a partial result. */
export interface ToolPartialFailureTelemetry {
  toolName: string;
  unavailableSections: string[];
}

/**
 * Detect a partial-failure tool result and build its telemetry payload (ENG-104).
 *
 * A successful tool result that carries `partialFailure: true` (e.g.
 * get_meta_ads_metrics with an errored breakdown section) is a success whose
 * degradation must still be observable. This PURE helper extracts the
 * unavailable-section metadata so the agent-mode telemetry layer — which has the
 * runId/sessionId the leaf tool method does not — can route it through
 * `recorder.toolPartialFailure`, the same loop-event mechanism ENG-102/103 use.
 *
 * Returns null for any result that is NOT an explicit partial failure, so the
 * all-success path emits nothing (behavior-preserving).
 */
export function buildToolPartialFailureTelemetry(
  toolName: string,
  result: unknown,
): ToolPartialFailureTelemetry | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.partialFailure !== true) return null;
  const unavailableSections = Array.isArray(r.unavailableSections)
    ? r.unavailableSections.filter((s): s is string => typeof s === 'string')
    : [];
  return { toolName, unavailableSections };
}

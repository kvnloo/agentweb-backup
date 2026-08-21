/**
 * ENG-1210 AC12 — recording the `declined` third of the recommendation funnel.
 *
 * AC12 asks telemetry to record "recommendation shown/accepted/declined". `shown` and
 * `accepted` have been emitted since the drivers resolver landed; `declined` had no event
 * because it had no observable moment. The runway panel offers "Preview this change" and
 * a "Keep <model> — your allowance is projected to run out ..." SPAN. Nothing to click
 * means nothing to record, and a decline is otherwise just the absence of an accept.
 *
 * ## What this records, and what it deliberately does not
 *
 * It records a decline the customer PERFORMED — a gesture that already exists in the UI,
 * named by `reason` so the funnel stays interpretable. It does NOT infer a decline from
 * silence. "Shown, ignored, never came back" is the larger and more interesting case, and
 * it cannot be derived here: it needs `shown` joined against `applied` over time, which
 * requires the queryable store `llmUsageTelemetry.ts` documents as deferred and
 * data-plane-gated. Emitting a guess would put rows in the funnel that mean something
 * different from the rows beside them.
 *
 * No new UI control is introduced. Asking a customer to click "no" would also cut against
 * AC7's deliberately guilt-free framing, and that copy was written that way on purpose.
 */

import { getEffectiveLlmUsagePolicy } from "./llmUsagePolicyResolverService";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";

/**
 * The gestures that already exist and unambiguously mean "not this one".
 *
 * A closed set, not free text: a synonym invented by a future caller would silently split
 * the funnel in two and make "how many declined?" unanswerable.
 */
export const DECLINE_REASONS = {
  /** Toggled a single previewed switch back off after seeing its projected effect. */
  removedFromPreview: "removed_from_preview",
  /** Abandoned the whole previewed basket via "Clear preview". */
  previewCleared: "preview_cleared",
} as const;

export type DeclineReason = (typeof DECLINE_REASONS)[keyof typeof DECLINE_REASONS];

const VALID_REASONS: readonly string[] = Object.values(DECLINE_REASONS);

/**
 * Same bound as the preview route. One request must not be able to turn into an
 * unbounded number of log lines.
 */
export const MAX_DECLINE_SELECTIONS = 20;

export interface DeclinedSelection {
  fromModel: string;
  toModel: string;
  /** The estimate the customer was SHOWN. Never recomputed — see below. */
  estimatedDaysRecovered?: number | null;
  confidence?: string | null;
}

export interface RecordDeclineInput {
  reason: DeclineReason;
  selections: DeclinedSelection[];
}

export interface RecordDeclineResult {
  recorded: number;
}

export class InvalidDeclineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeclineInputError";
  }
}

export async function recordRecommendationDeclined(
  userId: string,
  input: RecordDeclineInput,
): Promise<RecordDeclineResult> {
  if (!VALID_REASONS.includes(input?.reason)) {
    throw new InvalidDeclineInputError(
      `\`reason\` must be one of: ${VALID_REASONS.join(", ")}`,
    );
  }
  if (!Array.isArray(input.selections) || input.selections.length === 0) {
    throw new InvalidDeclineInputError(
      "`selections` must contain at least one selection — a decline of nothing is not a decline",
    );
  }
  const bounded = input.selections.slice(0, MAX_DECLINE_SELECTIONS);
  for (const s of bounded) {
    // Non-empty, not merely a string. A blank or whitespace-only id records a decline
    // that cannot be traced back to the recommendation the customer was shown, which is a
    // row in the funnel that answers no question.
    if (
      !s ||
      typeof s.fromModel !== "string" ||
      typeof s.toModel !== "string" ||
      !s.fromModel.trim() ||
      !s.toModel.trim()
    ) {
      throw new InvalidDeclineInputError(
        "each selection must have non-empty string `fromModel` and `toModel`",
      );
    }
  }

  // Resolved the same way `shown` and `applied` resolve it, so all three land on one key
  // and the funnel actually joins. An org member's decline belongs to the paying account.
  const usage = await getEffectiveLlmUsagePolicy(userId);
  if (!usage.policy) {
    // No ceiling means no runway, so nothing was ever recommended. A `declined` row with
    // no `shown` counterpart would be worse than no row.
    return { recorded: 0 };
  }

  // Sequential rather than Promise.all: the count returned must be the count emitted, and
  // `recordUsageTelemetry` already swallows its own failures so nothing here can reject.
  for (const s of bounded) {
    await recordUsageTelemetry(usage.billingUserId, USAGE_TELEMETRY_EVENTS.recommendationDeclined, {
      fromModel: s.fromModel,
      toModel: s.toModel,
      reason: input.reason,
      // Named `...AtDecision` to match the applied event: the audit is what the customer
      // was looking at when they decided, not what we would estimate now.
      estimatedDaysRecoveredAtDecision:
        typeof s.estimatedDaysRecovered === "number" ? s.estimatedDaysRecovered : null,
      confidenceAtDecision: typeof s.confidence === "string" ? s.confidence : null,
    });
  }

  return { recorded: bounded.length };
}

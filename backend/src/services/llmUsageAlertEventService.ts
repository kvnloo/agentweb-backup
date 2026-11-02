/**
 * ENG-2769 — outcomes of the usage-alert modal (TokenWarningModal).
 *
 * `runway_forecast_computed` fires when the backend COMPUTES a forecast, not when a
 * customer sees the alert, so "did the alert help?" had no denominator and no
 * outcome. This records the four observable moments of the modal: shown, dismissed
 * ("Got it"), see-options ("See what's using it") and the primary CTA (book a call /
 * upgrade / contact). Same log sink and billing-subject key as the rest of the runway
 * funnel, so it joins with `runway_forecast_computed` on `billingUserId`.
 *
 * Durable storage is ENG-2770 (data-plane); this only emits through
 * `recordUsageTelemetry`, whose sink is swappable for that store.
 */

import { resolveBillingUserId } from "./tokenUsageService";
import { recordUsageTelemetry, USAGE_TELEMETRY_EVENTS } from "./llmUsageTelemetry";

/** Closed set: a synonym from a future caller would silently split the funnel. */
export const ALERT_ACTIONS = {
  shown: USAGE_TELEMETRY_EVENTS.alertShown,
  dismissed: USAGE_TELEMETRY_EVENTS.alertDismissed,
  see_options: USAGE_TELEMETRY_EVENTS.alertSeeOptions,
  book_call: USAGE_TELEMETRY_EVENTS.alertBookCall,
  upgrade: USAGE_TELEMETRY_EVENTS.alertUpgrade,
  contact: USAGE_TELEMETRY_EVENTS.alertContact,
} as const;

export type AlertAction = keyof typeof ALERT_ACTIONS;

const VALID_ACTIONS = Object.keys(ALERT_ACTIONS);
const VALID_REASONS = ["usage", "forecast"];

export class InvalidAlertEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAlertEventError";
  }
}

export interface RecordAlertEventInput {
  action: unknown;
  reason?: unknown;
  estimatedDaysRemaining?: unknown;
  percentUsed?: unknown;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function recordUsageAlertEvent(
  userId: string,
  input: RecordAlertEventInput,
): Promise<{ recorded: number }> {
  const action = input?.action;
  if (typeof action !== "string" || !VALID_ACTIONS.includes(action)) {
    throw new InvalidAlertEventError(`\`action\` must be one of: ${VALID_ACTIONS.join(", ")}`);
  }
  const reason = input.reason ?? "usage";
  if (typeof reason !== "string" || !VALID_REASONS.includes(reason)) {
    throw new InvalidAlertEventError(`\`reason\` must be one of: ${VALID_REASONS.join(", ")}`);
  }

  // The billing SUBJECT, matching runway_forecast_computed — an org member's alert
  // belongs to the paying account, or the join is wrong.
  const billingUserId = await resolveBillingUserId(userId);
  await recordUsageTelemetry(billingUserId, ALERT_ACTIONS[action as AlertAction], {
    reason,
    actingUserId: userId,
    // As shown to the customer; never recomputed.
    estimatedDaysRemainingAtAlert: finiteOrNull(input.estimatedDaysRemaining),
    percentUsed: finiteOrNull(input.percentUsed),
  });
  return { recorded: 1 };
}

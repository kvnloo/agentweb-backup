/**
 * Onboarding stage derivation.
 *
 * The frontend onboarding flow emits a stream of events (see
 * `OnboardingV2.tsx` → `trackOnboardingEvent`). Phase 1 of the Lifecycle Drip
 * epic persists those events server-side and derives a single
 * `onboardingStage` field on the user, so Emma / admin tooling / drip
 * campaigns can segment users without replaying the event log.
 *
 * The stage is a lossy summary of the log — at most one stage per user at any
 * given time. Stages are computed deterministically from the event log +
 * "last active" signal so the same log always produces the same stage.
 *
 * Stage order (roughly low → high engagement):
 *   signed_up_no_start → goal_selected → brand_submitted | brand_skipped
 *     → data_connected → channel_connected → onboarding_completed → active
 *
 * Plus one lateral terminal state: `stale` (completed onboarding but no
 * activity in ≥ 30 days). `stale` overrides `active` regardless of prior
 * events, so the re-engagement drip can target cooled users.
 */

export type OnboardingStage =
  | "signed_up_no_start"
  | "goal_selected"
  | "brand_submitted"
  | "brand_skipped"
  | "data_connected"
  | "channel_connected"
  | "onboarding_completed"
  | "active"
  | "stale";

export const ALL_ONBOARDING_STAGES: readonly OnboardingStage[] = [
  "signed_up_no_start",
  "goal_selected",
  "brand_submitted",
  "brand_skipped",
  "data_connected",
  "channel_connected",
  "onboarding_completed",
  "active",
  "stale",
] as const;

/**
 * Event types the onboarding flow emits. Kept as a wide set — the endpoint
 * accepts any of these; unknown event types are rejected at the HTTP layer.
 *
 * Phase 2 (Onboarding v2 analytics task
 * https://www.notion.so/34c09247c951812cbc90f09aa68fc5d3) extended this set with:
 *   channel_selected, icp_selected, value_prop_edited, ads_generated,
 *   ads_regenerated, welcome_offer_shown, welcome_offer_outcome,
 *   brand_build_status, onboarding_abandoned, deviation, channels_skipped
 * Backwards compatible — every event name PR #568 used still resolves.
 */
export const ALLOWED_ONBOARDING_EVENTS = new Set<string>([
  // Phase 1 (PR #568) — do not remove, existing consumers depend on these.
  "goal_selected",
  "brand_submitted",
  "brand_skipped",
  "data_connected",
  "data_skipped",
  "channel_connected",
  "onboarding_completed",
  "onboarding_skipped",
  // Phase 2 — Onboarding v2 analytics extension.
  "channel_selected",
  "channels_skipped",
  "icp_selected",
  "value_prop_edited",
  "ads_generated",
  "ads_regenerated",
  "welcome_offer_shown",
  "welcome_offer_outcome",
  "brand_build_status",
  "brand_fallback_manual",
  "onboarding_abandoned",
  "deviation",
  // Outreach (test-env re-enable — not committed to harsha/dev)
  "outreach_channel_connect_already_connected",
  "outreach_channel_connect_clicked",
  "outreach_channel_connect_error",
  "outreach_channel_connect_skipped",
  "outreach_channel_connect_success",
  "outreach_crm_save_clicked",
  "outreach_crm_save_failed",
  "outreach_crm_save_send_invites_clicked",
  "outreach_crm_save_succeeded",
  "outreach_crm_saved",
  "outreach_drafts_continue",
  "outreach_drafts_regenerate_all",
  "outreach_icp_auto_retry",
  "outreach_icp_freetext_submit",
  "outreach_icp_manual_retry_clicked",
  "outreach_icp_manual_retry_shown",
  "outreach_icp_picked",
  "outreach_icp_selected",
  "outreach_prospects_continue",
  "outreach_prospects_empty",
  "outreach_prospects_error",
  "outreach_prospects_loaded",
  "outreach_prospects_retry",
  "outreach_prospects_search_started",
  "outreach_prospects_skip",
  "outreach_prospects_stall_escape",
  "outreach_specs_skipped",
  "outreach_specs_submitted",
]);

export interface OnboardingEvent {
  /** Event name, must be in {@link ALLOWED_ONBOARDING_EVENTS}. */
  event: string;
  /** ISO 8601 timestamp when the event was recorded (server side). */
  ts: string;
  /** Optional free-form event-specific payload (e.g. { goal: 'paid_ads' }). */
  data?: Record<string, unknown>;
}

/**
 * Derive the user's current onboarding stage from the full event log plus
 * `lastActiveAt` (used only to detect the `stale` state).
 *
 * @param events   Event log in any order. Older events come first after the
 *                 function sorts internally, so callers don't need to pre-sort.
 * @param now      "Current" time used for `stale` detection. Defaults to
 *                 `Date.now()` but can be injected in tests.
 * @param lastActiveAt ISO timestamp of last user activity (login, chat
 *                 session, etc.). Used only when onboarding is completed.
 */
export function deriveOnboardingStage(
  events: OnboardingEvent[] | undefined,
  opts: { now?: Date; lastActiveAt?: string | null } = {},
): OnboardingStage {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return "signed_up_no_start";

  const now = opts.now ?? new Date();

  // Use presence of specific events, not just the last one — a user can
  // complete onboarding, come back later, and we still want `onboarding_completed`
  // to win over an earlier `goal_selected` event.
  const seen = new Set(list.map((e) => e.event));

  // Terminal states first.
  if (seen.has("onboarding_completed")) {
    // Check staleness (no activity for 30+ days).
    const lastActive = opts.lastActiveAt ? new Date(opts.lastActiveAt) : null;
    const hasValidActivity =
      lastActive !== null && !Number.isNaN(lastActive.getTime());
    if (
      hasValidActivity &&
      now.getTime() - (lastActive as Date).getTime() >
        30 * 24 * 60 * 60 * 1000
    ) {
      return "stale";
    }
    return hasValidActivity ? "active" : "onboarding_completed";
  }

  if (seen.has("channel_connected")) return "channel_connected";
  if (seen.has("data_connected")) return "data_connected";

  // Brand: submitted wins over skipped (user can go back and fill it in).
  if (seen.has("brand_submitted")) return "brand_submitted";
  if (seen.has("brand_skipped")) return "brand_skipped";

  if (seen.has("goal_selected")) return "goal_selected";

  // Catch-all: any other event recorded but nothing we recognise as a stage
  // marker (e.g. `onboarding_skipped` on its own, or `data_skipped` alone).
  // Treat as "signed_up_no_start" — the user engaged but didn't advance past
  // the goal step, so the re-engagement drip should still nudge them.
  return "signed_up_no_start";
}

/** Type guard — is `s` a valid {@link OnboardingStage}? */
export function isOnboardingStage(s: unknown): s is OnboardingStage {
  return (
    typeof s === "string" &&
    (ALL_ONBOARDING_STAGES as readonly string[]).includes(s)
  );
}

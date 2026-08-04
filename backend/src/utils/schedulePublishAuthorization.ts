import { isPublishName } from './hardeningGaps';

/**
 * ENG-827 — resolving the unattended publish gate.
 *
 * The social/publishing tools carry a hard "review with the user and get explicit
 * approval before publishing" instruction. In an unattended scheduled run there is
 * no human to approve, so without a machine-readable authorization signal the model
 * cannot tell an owner-authorized autopublish from an unauthorized one and defaults
 * to refusing — while the deterministic required-function checker nudges it up to
 * `maxAttempts` (20) times. That is the loop that burned the reported runs.
 *
 * The authorization signal must be something the OWNER set on the schedule, at
 * schedule-creation time, that unambiguously means "publish without asking me":
 *
 *  1. `requiredFunctionCalls` naming a publish tool. This is the primary signal.
 *     The owner ticked `post_on_connected_account` in the schedule form's required-
 *     function picker, declaring that a run only succeeds if it publishes. That is
 *     an explicit, durable, per-schedule instruction to take the action — and it is
 *     already the exact list the required-function checker enforces, so honouring it
 *     here is what makes the prompt and the checker agree instead of contradict.
 *
 *  2. `fullAutonomy`. A broader opt-in waiver of the human gate on irreversible
 *     decisions. Note this is NOT sufficient on its own as the primary signal: it is
 *     surfaced in the UI as "if Emma needs a decision mid-run she'll proceed with her
 *     recommended option" — it governs AskUserQuestion parking, not tool gating — so
 *     an owner automating a daily post has no reason to tick it. Empirically no
 *     production schedule that requires a publish tool has it set, which is why
 *     keying authorization on it alone leaves every affected schedule still refusing.
 *
 * Authorization is deliberately PER-TOOL: only the publish tools the owner actually
 * listed are authorized, so requiring `post_on_connected_account` does not silently
 * authorize `publish_landing_page_changes`. Anything not explicitly named stays
 * gated and falls back to the safe draft-and-notify outcome.
 */
export interface SchedulePublishAuthorizationInput {
  fullAutonomy?: boolean;
  requiredFunctionCalls?: string[];
}

export interface SchedulePublishAuthorization {
  /** True when this schedule carries standing owner authorization to publish unattended. */
  authorized: boolean;
  /** The exact publish tools the owner required, in declaration order (de-duplicated). */
  tools: string[];
}

const UNAUTHORIZED: SchedulePublishAuthorization = { authorized: false, tools: [] };

/**
 * Resolve a schedule's standing publish authorization. Safe on a missing/partial
 * schedule (a failed lookup must never break a run) and defaults, in every
 * ambiguous case, to NOT authorized — the reversible draft-and-notify outcome.
 */
export function resolveSchedulePublishAuthorization(
  schedule: SchedulePublishAuthorizationInput | null | undefined
): SchedulePublishAuthorization {
  if (!schedule) return UNAUTHORIZED;

  const required = Array.isArray(schedule.requiredFunctionCalls) ? schedule.requiredFunctionCalls : [];
  const tools = Array.from(
    new Set(required.filter((name): name is string => typeof name === 'string' && isPublishName(name)))
  );

  return { authorized: tools.length > 0 || schedule.fullAutonomy === true, tools };
}

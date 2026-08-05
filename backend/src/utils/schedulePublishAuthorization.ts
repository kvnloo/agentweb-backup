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
 * Authorization comes ONLY from an explicit, structured, owner-set boolean:
 *
 *  A. `autopublishAuthorized` — the dedicated per-schedule consent flag. Its checkbox
 *     states in plain words that the run will publish to the live account without
 *     showing the owner the content first. Ticking it is informed consent.
 *
 *  B. `fullAutonomy` — the pre-existing broader waiver, rendered as an amber warning
 *     covering "irreversible choices that can't be undone after launch". Publishing
 *     is squarely within what that already asks the owner to accept.
 *
 * Deliberately NOT a signal:
 *
 *  - `requiredFunctionCalls` naming a publish tool. That picker is a VERIFICATION
 *    control ("this run only counts as successful if it called X") and its UI carries
 *    no approval-waiver language, so a tick cannot mean consent. 5 of the 8 production
 *    schedules requiring a publish tool — including the ACTIVE "LUCAS — LinkedIn
 *    Thought Leadership" — would otherwise have started publishing unreviewed.
 *
 *  - Approval-waiver wording in the schedule's prompt. Intent inferred from prose is
 *    not consent: the wording is unscoped, so a waiver written about a different step
 *    ("do not ask for approval when generating images") would authorize a live post.
 *    A prose matcher can always be narrowed and will always have another hole; consent
 *    has to be a field the owner deliberately set.
 *
 * Everything is fail-closed: an unreadable schedule, a malformed field, or anything
 * short of an explicit true resolves to NOT authorized — the reversible
 * draft-and-notify outcome.
 *
 * Authorization is still reported PER-TOOL: `tools` lists only the publish tools the
 * owner designated, so the directive names exactly those and the required-function
 * checker filters in lockstep.
 */

export interface SchedulePublishAuthorizationInput {
  /** Dedicated per-schedule consent flag — the owner ticked "publish without review". */
  autopublishAuthorized?: boolean;
  /** Broader irreversible-action waiver; also covers publishing. */
  fullAutonomy?: boolean;
  /** Used only to report WHICH publish tools are in scope — never to grant consent. */
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

  // Consent is a flag the owner deliberately set — never inferred from the required
  // -function picker or from wording in the prompt. Strict === true so a truthy
  // string/number from a loosely-typed caller cannot grant publishing rights.
  const authorized =
    schedule.autopublishAuthorized === true || schedule.fullAutonomy === true;

  return { authorized, tools };
}

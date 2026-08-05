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
 * Authorization comes from EXACTLY ONE signal: `autopublishAuthorized`, the dedicated
 * per-schedule consent flag. Its checkbox states in plain words that the run will
 * publish to the live connected account without showing the owner the content first,
 * that posts go live automatically, and that they cannot be un-published. Ticking it
 * is informed consent. Nothing else grants it.
 *
 * Three other signals were tried and each was rejected for the SAME reason — a control
 * whose own wording does not tell the owner that publishing-without-review is what
 * they are agreeing to cannot serve as consent for it:
 *
 *  - `requiredFunctionCalls` naming a publish tool. That picker is a VERIFICATION
 *    control ("this run only counts as successful if it called X") and its UI carries
 *    no approval-waiver language. 5 of the 8 production schedules requiring a publish
 *    tool — including the ACTIVE "LUCAS — LinkedIn Thought Leadership" — would
 *    otherwise have started publishing unreviewed.
 *
 *  - Approval-waiver wording in the schedule's prompt. Intent inferred from prose is
 *    not consent: the wording is unscoped, so a waiver written about a different step
 *    ("do not ask for approval when generating images") would authorize a live post.
 *    A prose matcher can always be narrowed and will always have another hole.
 *
 *  - `fullAutonomy`. It reads "if Emma needs a decision mid-run, she'll proceed with
 *    her recommended option instead of pausing to ask you" — it governs how a blocking
 *    AskUserQuestion is ANSWERED (see ENG-396/ENG-517), not whether a live write may
 *    happen. An owner ticking it consented to Emma picking between options, not to
 *    Emma posting content they never saw. It remains in force for question handling
 *    and is deliberately irrelevant here.
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
  /**
   * The ONLY consent signal — the owner ticked "Publish without my review", whose
   * copy spells out that posts go live unseen and cannot be un-published.
   */
  autopublishAuthorized?: boolean;
  /**
   * The publish tools the owner could see when they consented, recorded at grant
   * time. Consent is bound to THIS list: it is not a standing licence that follows
   * whatever the schedule later requires.
   */
  autopublishAuthorizedTools?: string[];
  /** The schedule's current requirements — narrows scope, never grants consent. */
  requiredFunctionCalls?: string[];
}

/** The publish tools a schedule currently requires, de-duplicated in order. */
export function getRequiredPublishTools(requiredFunctionCalls?: string[]): string[] {
  const required = Array.isArray(requiredFunctionCalls) ? requiredFunctionCalls : [];
  return Array.from(
    new Set(required.filter((name): name is string => typeof name === 'string' && isPublishName(name)))
  );
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

  const requiredPublishTools = getRequiredPublishTools(schedule.requiredFunctionCalls);

  // Consent is bound to the scope it was granted for. `autopublishAuthorizedTools`
  // is the list the owner could see when they ticked the box; anything the schedule
  // requires LATER is outside what they approved. Without this, editing
  // requiredFunctionCalls after a grant would silently re-scope standing consent
  // onto tools the owner never saw — e.g. a consent for post_on_connected_account
  // quietly becoming one for publish_landing_page_changes.
  //
  // An approved list is REQUIRED for a grant to mean anything: consent recorded
  // without one has unknown scope, so it authorizes nothing (fail-closed).
  const approved = Array.isArray(schedule.autopublishAuthorizedTools)
    ? schedule.autopublishAuthorizedTools.filter((t): t is string => typeof t === 'string')
    : [];
  const tools = requiredPublishTools.filter(t => approved.includes(t));

  // CONSENT and SCOPE are separate, and BOTH are required.
  //
  // Consent is the one flag the owner deliberately set for THIS purpose — never
  // inferred from the required-function picker, from prompt wording, or from
  // fullAutonomy (which governs how blocking questions are answered, not whether a
  // live write may happen). Strict === true so a truthy string/number from a
  // loosely-typed caller cannot grant publishing rights.
  //
  // Scope is `tools`. Consent with an EMPTY scope authorizes nothing: the owner
  // consented to unattended publishing but designated no tool to do it with, so
  // there is no specific irreversible action to approve. Authorizing that would
  // turn an empty scope into a licence to reach for any live-publishing tool —
  // an unscoped mandate the owner never granted. Requiring a designated tool keeps
  // every authorization concrete and enumerable. Note this does NOT make the
  // required-function picker a consent signal: it cannot authorize anything on its
  // own, it only bounds what an already-granted consent covers.
  const authorized = schedule.autopublishAuthorized === true && tools.length > 0;

  return { authorized, tools };
}

/**
 * Narrow a schedule's required-function list to what this run is actually allowed
 * to be nudged for.
 *
 * THE INVARIANT: the deterministic required-function checker must never demand a
 * publishing tool that the system prompt forbids. Both sides derive from the same
 * `SchedulePublishAuthorization`, so they cannot drift — but the check has to be on
 * the authorized TOOL SET, not on `authorized` alone. Consent is bound to an
 * approved scope, so a run can legitimately be authorized for one publish tool
 * while the schedule also requires another that the owner never approved. Keying on
 * the boolean would keep both, and the prompt names only the approved one — which
 * is precisely the prompt-versus-checker contradiction that produced the ~21-turn
 * nudge loop in the reported sessions.
 *
 * Non-publishing requirements are never touched.
 */
export function filterRequiredFunctionsToAuthorizedScope(
  requiredFunctionCalls: string[] | undefined,
  authorization: SchedulePublishAuthorization
): string[] {
  const required = Array.isArray(requiredFunctionCalls) ? requiredFunctionCalls : [];
  return required.filter(name => !isPublishName(name) || authorization.tools.includes(name));
}

/**
 * Combine the authorization a run was admitted under with a later re-read, keeping
 * whichever is MORE RESTRICTIVE.
 *
 * A scheduled run resolves its authorization once at admission and threads that one
 * value through every turn — that single-resolution rule is what stops the checker
 * and the prompt disagreeing. But a run lasts minutes, so an owner who revokes
 * consent mid-run would otherwise watch it publish anyway from a snapshot taken
 * before they hit the switch. Revocation has to bite immediately; it is the only
 * control they have once a run is live.
 *
 * The combination is deliberately MONOTONIC — it can only ever remove authorization,
 * never add it:
 *
 *  - it cannot re-authorize a run that was admitted unauthorized, so a grant landing
 *    mid-run never turns a draft-and-notify run into a publishing one behind the
 *    owner's back;
 *  - it cannot widen scope, so a tool added to the approved list mid-run is not
 *    reachable until the next run;
 *  - narrowing is idempotent and cannot oscillate, so re-applying it every turn can
 *    only ever REDUCE what the checker nudges for — it can never reintroduce a
 *    demand for a tool the prompt forbids.
 *
 * An unreadable re-read (`null`) keeps the admitted value rather than failing closed.
 * Failing closed on a throttled DynamoDB read would silently downgrade a legitimately
 * authorized run to draft-only, which is the ticket's original complaint in reverse —
 * and the admitted value was itself resolved fail-closed.
 */
export function narrowPublishAuthorization(
  admitted: SchedulePublishAuthorization,
  latest: SchedulePublishAuthorization | null | undefined
): SchedulePublishAuthorization {
  if (!latest) return admitted;
  const tools = admitted.tools.filter(tool => latest.tools.includes(tool));
  return {
    authorized: admitted.authorized && latest.authorized && tools.length > 0,
    tools: admitted.authorized && latest.authorized ? tools : []
  };
}

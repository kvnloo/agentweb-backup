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

/**
 * Tools whose publishing power depends on WHICH action is invoked.
 *
 * `isPublishName` classifies by tool name, which is exactly right for the tools that
 * do one thing — but two tools carry a mixed set of actions behind a single name, and
 * both can write publicly under the owner's identity:
 *
 *  - `twitter_manage_post` posts a multi-tweet THREAD, replies, quote-tweets and
 *    retweets; it also fetches metrics and lists repliers.
 *  - `linkedin_manage_post` reposts and comments; it also lists comments and pulls
 *    analytics.
 *
 * Gating the whole tool would refuse a scheduled analytics read, which nothing in this
 * ticket justifies. Not gating it at all leaves a public post reachable from an
 * unattended run that the owner never authorized — the exact hole this module exists
 * to close. So the decision is per ACTION, and `nonPublishing` is the enumerated side:
 * anything not on it — including an action added to the tool later, or a call that
 * names no action at all — is treated as publishing and gated. A drift-guard test
 * asserts these lists together cover the tool's declared action enum, so a new action
 * is classified deliberately rather than inheriting the fail-closed default by
 * accident.
 *
 * Deletes, likes and reactions sit on the `nonPublishing` side on purpose. They are
 * not publications of content — they carry volume/destructive risk that the SAFETY &
 * VOLUME LIMITS block governs, and a delete is the REMEDY for a bad post, so refusing
 * it for want of publishing consent would be backwards.
 */
export const ACTION_SCOPED_PUBLISH_TOOLS: Record<string, { publishing: string[]; nonPublishing: string[] }> = {
  twitter_manage_post: {
    publishing: ['post_thread', 'reply', 'quote_tweet', 'retweet'],
    nonPublishing: [
      'delete_tweet', 'like', 'unlike', 'unretweet',
      'get_tweet_metrics', 'list_replies', 'get_retweeters', 'get_liking_users', 'get_quote_tweets',
    ],
  },
  linkedin_manage_post: {
    publishing: ['repost', 'comment'],
    nonPublishing: ['react', 'list_comments', 'get_analytics'],
  },
};

/**
 * True for any tool that can publish publicly — by name, or by holding at least one
 * publishing action. This is the classification CONSENT SCOPE is built from, so an
 * owner can authorize a thread-posting schedule at all.
 */
export function isPublishCapableTool(name: string): boolean {
  return isPublishName(name) || Object.prototype.hasOwnProperty.call(ACTION_SCOPED_PUBLISH_TOOLS, name);
}

/**
 * True when THIS call would publish. Name-classified tools always do; an
 * action-scoped tool does unless the call names one of its enumerated
 * non-publishing actions (fail-closed on an unknown or missing action).
 */
export function isPublishCall(name: string, args?: any): boolean {
  if (isPublishName(name)) return true;
  const spec = ACTION_SCOPED_PUBLISH_TOOLS[name];
  if (!spec) return false;
  const action = typeof args?.action === 'string' ? args.action : '';
  return !spec.nonPublishing.includes(action);
}

/** The publish tools a schedule currently requires, de-duplicated in order. */
export function getRequiredPublishTools(requiredFunctionCalls?: string[]): string[] {
  const required = Array.isArray(requiredFunctionCalls) ? requiredFunctionCalls : [];
  return Array.from(
    new Set(required.filter((name): name is string => typeof name === 'string' && isPublishCapableTool(name)))
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
  return required.filter(name => !isPublishCapableTool(name) || authorization.tools.includes(name));
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
 * An unreadable re-read (`null`) FAILS CLOSED, like every other ambiguous case in this
 * module. While the schedule cannot be read we cannot know whether consent still
 * stands, and the two outcomes are not symmetric: publishing while blind is an
 * irreversible live post the owner may already have revoked, whereas withholding
 * produces a draft — which this ticket's own recommendation calls a success state, not
 * a failure. The nudge loop that made a withheld publish expensive is fixed separately
 * and unconditionally, so a downgrade here costs a draft, not a burned run.
 */
export function narrowPublishAuthorization(
  admitted: SchedulePublishAuthorization,
  latest: SchedulePublishAuthorization | null | undefined
): SchedulePublishAuthorization {
  if (!latest) return UNAUTHORIZED;
  const tools = admitted.tools.filter(tool => latest.tools.includes(tool));
  return {
    authorized: admitted.authorized && latest.authorized && tools.length > 0,
    tools: admitted.authorized && latest.authorized ? tools : []
  };
}

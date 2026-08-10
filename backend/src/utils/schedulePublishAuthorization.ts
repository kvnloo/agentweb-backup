import { isPublishName } from './hardeningGaps';
import { resolvePublishAuthorized, SchedulePublishApprovalInput } from './schedulePublishApproval';

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
 * CONSENT IS AFFIRMATIVE AND TOOL-SCOPED
 * -------------------------------------
 * A schedule publishes unattended only where the owner explicitly said so
 * (`autopublishAuthorized`) and only through the publish tools they approved
 * (`autopublishAuthorizedTools`). Absence is not consent. An empty scope authorizes
 * nothing. `requirePublishApproval` still wins when set, so an owner who asked to be
 * held stays held even if a grant exists.
 *
 * This module briefly ran at the opposite polarity, reading ENG-803's opt-out alone, so
 * that absence meant AUTHORIZED. That preserved existing behaviour without a migration,
 * but it cannot express the property this ticket is actually about: that a specific
 * human agreed their account may post unreviewed. Under review it also proved unable to
 * bound the grant — with no approved list, editing `requiredFunctionCalls` silently
 * re-points standing consent at a tool the owner never saw.
 *
 * ONE FIELD, ONE POLARITY, BOTH GATES. `resolvePublishAuthorized` in
 * schedulePublishApproval.ts (ENG-803's `executeTool` check) now delegates here, so the
 * dispatch gate and the registry gate cannot disagree. Two independent readings of the
 * same setting is exactly how the earlier collision arose: one gate ordered the model to
 * publish while the other mechanically refused, which is worse than either rule alone.
 *
 * MIGRATION IS MANDATORY AND ORDERED. Every schedule predating the field resolves to NOT
 * authorized. scripts/grant-schedule-autopublish.ts records affirmative consent for the
 * schedules that publish today and MUST run BEFORE this deploys. Running it early is
 * inert — nothing reads the field until this code ships — whereas merging first stops
 * every live publishing schedule within minutes of deploy.
 *
 * The rejected-signal list from ENG-827's own review rounds is unchanged: prompt prose,
 * `requiredFunctionCalls`, and `fullAutonomy` are each NOT consent. A control whose
 * wording never tells the owner that publishing-without-review is what they are agreeing
 * to cannot be consent for it. Do not reinstate any of them.
 *
 * WHAT THIS MODULE STILL ADDS OVER ENG-803's CHECK — none of it is redundant:
 *
 *  - `filterRequiredFunctionsToAuthorizedScope`, so the deterministic checker cannot
 *    nudge for a publish tool the prompt forbids. That contradiction is what looped
 *    the reported runs ~21 times; ENG-803 does not touch the checker.
 *  - admission stamping plus `narrowPublishAuthorization`, so a run keeps the
 *    permissions it began with: revocation bites mid-run, a mid-run GRANT cannot widen
 *    a draft-only run into a publishing one.
 *  - action-scoped classification, so a scheduled analytics read through
 *    `twitter_manage_post` is not gated while a thread post through the same tool is.
 *  - enforcement on the MCP registry and client tool-registry paths, which
 *    `executeTool`'s check alone does not cover.
 */

export interface SchedulePublishAuthorizationInput extends SchedulePublishApprovalInput {
  /**
   * AFFIRMATIVE owner consent to publish unattended. Absence is NOT consent — a
   * schedule nobody has explicitly authorized drafts and notifies.
   */
  autopublishAuthorized?: boolean;
  /**
   * The publish tools the owner approved when they consented. Consent is bound to THIS
   * list, so editing `requiredFunctionCalls` later cannot re-scope it onto a tool they
   * never saw.
   */
  autopublishAuthorizedTools?: string[];
  /**
   * The schedule's current requirements. Bounds what the required-function checker may
   * nudge for; NEVER grants consent — see the rejected-signal note above.
   */
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
  /**
   * The publish tools this schedule REQUIRES and that the checker may therefore nudge
   * for, in declaration order (de-duplicated). This is a nudge scope, not the set of
   * tools publishing is limited to — see the note in `resolveSchedulePublishAuthorization`.
   */
  tools: string[];
}

const UNAUTHORIZED: SchedulePublishAuthorization = { authorized: false, tools: [] };

/**
 * Resolve a schedule's standing publish authorization.
 *
 * OPT-IN, AND TOOL-SCOPED. Publishing under the owner's name to a live account is
 * irreversible, so it happens only where the owner affirmatively said so and only
 * through the tools they approved. Absence of consent is not consent; an empty scope
 * authorizes nothing; and `requirePublishApproval` still wins if it is set, so an owner
 * who explicitly asked to be held stays held even if a grant is present.
 *
 * WHY `tools` IS LOAD-BEARING HERE. Consent is recorded against the publish tools the
 * owner could see when they gave it. Without that binding, editing the schedule's
 * required functions afterwards silently re-points standing consent at a tool they
 * never approved — a consent for `post_on_connected_account` quietly becoming one for
 * `publish_landing_page_changes`.
 *
 * MIGRATION NOTE — READ BEFORE MERGING. Every schedule that predates this field
 * resolves to NOT authorized, which stops the live publishing schedules. The backfill
 * in scripts/grant-schedule-autopublish.ts records affirmative consent for the
 * currently-publishing schedules and MUST be run before this ships. Writing it early is
 * inert: the field is unread until this code deploys.
 *
 * Everything ambiguous fails closed: an unreadable schedule, a malformed field, or
 * anything short of an explicit `true` gives the reversible draft-and-notify outcome.
 */
export function resolveSchedulePublishAuthorization(
  schedule: SchedulePublishAuthorizationInput | null | undefined
): SchedulePublishAuthorization {
  if (!schedule) return UNAUTHORIZED;

  // The owner's explicit hold outranks any grant: they asked to review, so review.
  if (schedule.requirePublishApproval === true) return UNAUTHORIZED;

  // Strict === true, so a truthy string or number from a loosely-typed caller cannot
  // become permission to post.
  if (schedule.autopublishAuthorized !== true) return UNAUTHORIZED;

  const approved = Array.isArray(schedule.autopublishAuthorizedTools)
    ? schedule.autopublishAuthorizedTools.filter(
        (t): t is string => typeof t === 'string' && isPublishCapableTool(t)
      )
    : [];
  // Consent with no approved tool has unknown scope and authorizes nothing, rather than
  // becoming a licence to reach for any publishing tool.
  if (approved.length === 0) return UNAUTHORIZED;

  return { authorized: true, tools: Array.from(new Set(approved)) };
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
  // Scope is load-bearing again: an intersection that empties out is no longer an
  // authorization, so a tool dropped from the approved list stops being publishable
  // immediately rather than at the next run.
  return {
    authorized: admitted.authorized && latest.authorized && tools.length > 0,
    tools: admitted.authorized && latest.authorized ? tools : []
  };
}

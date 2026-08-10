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
 * THE SIGNAL IS ENG-803's `requirePublishApproval`, AND ONLY THAT.
 * ---------------------------------------------------------------
 * This module originally carried its own opt-IN flag (`autopublishAuthorized`) at the
 * OPPOSITE polarity. ENG-803 (PR #2260) shipped first, so both gates ended up on the
 * same dispatch path — `executeTool` runs ENG-803's check and then dispatches through
 * the tool registry, where this module's guard runs. A publish had to satisfy BOTH,
 * and because the opt-in flag's only writer was a route that never shipped, the
 * conjunction was DENY for every schedule in existence. That was verified on the
 * preview, not merely reasoned about: a default-shaped schedule was told to publish by
 * ENG-803's live directive and then mechanically refused here, producing a burned run
 * worse than the bug this ticket reports.
 *
 * Two contradictory owner controls cannot both be right, so this one yields. Consent
 * is now read through `resolvePublishAuthorized` — the single, already-live resolver —
 * which means:
 *
 *  - absence means AUTHORIZED, preserving what scheduled runs have always done. No
 *    backfill, no migration, and no existing schedule changes behaviour.
 *  - the owner's control is the OPT-OUT ("Require approval before publishing"). It is
 *    human-writable only: it is absent from the `manage_scheduled_chat` MCP allowlist,
 *    so Emma can neither grant herself publishing rights nor silence her own.
 *  - a schedule that cannot be READ AT ALL still resolves to withheld, because that is
 *    the recoverable error. Absence of a field is not absence of an answer.
 *
 * The rejected-signal list that survives from ENG-827's own review rounds is unchanged
 * and is restated in schedulePublishApproval.ts: prompt prose, `requiredFunctionCalls`,
 * and `fullAutonomy` are each NOT consent. Do not reinstate any of them here.
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
 * Resolve a schedule's standing publish authorization. Safe on a missing/partial
 * schedule (a failed lookup must never break a run) and defaults, when the schedule
 * cannot be read at all, to NOT authorized — the reversible draft-and-notify outcome.
 *
 * `authorized` DOES NOT DEPEND ON `tools`, and that is deliberate. An earlier version
 * required a designated publish tool for consent to mean anything, which reads as the
 * safer rule but is wrong under this polarity: most publishing schedules never name a
 * publish tool in `requiredFunctionCalls` at all — they just tell Emma to post in the
 * prompt. Measured on the live table, only 4 of the 25 active publishing-shaped
 * schedules require one outright. Gating on a non-empty tool list would have refused
 * the other 21, which is the same deny-by-construction failure this reconciliation
 * exists to remove, just applied to a subset.
 *
 * So the grant is schedule-wide, exactly as ENG-803 already enforces it at
 * `executeTool`, and `tools` carries only the narrower question of what the
 * deterministic checker is allowed to demand.
 */
export function resolveSchedulePublishAuthorization(
  schedule: SchedulePublishAuthorizationInput | null | undefined
): SchedulePublishAuthorization {
  if (!schedule) return UNAUTHORIZED;

  // One resolver, shared with ENG-803's `executeTool` gate. Two independent readings
  // of the same owner setting is precisely how the polarity collision arose, so the
  // boolean is never recomputed here.
  const authorized = resolvePublishAuthorized(schedule);
  if (!authorized) return UNAUTHORIZED;

  return { authorized: true, tools: getRequiredPublishTools(schedule.requiredFunctionCalls) };
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
  // `authorized` is independent of `tools` for the reason given in
  // resolveSchedulePublishAuthorization: a schedule that names no publish tool still
  // publishes. Intersecting the nudge scope stays monotonic either way.
  const authorized = admitted.authorized && latest.authorized;
  return {
    authorized,
    tools: authorized ? admitted.tools.filter(tool => latest.tools.includes(tool)) : []
  };
}

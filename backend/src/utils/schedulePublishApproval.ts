/**
 * ENG-803 — deterministic publish authorization for unattended scheduled runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Session 0fe2e743 ("Harsha X Reply Guy") drafted five replies, never called
 * twitter_manage_post, and justified it with an "active X publishing gate" that no
 * tool had ever returned. Banning the fabrication alone is not enough: with no
 * machine-readable signal, whether the run publishes is left to the model's mood,
 * so the skipped-tool half of the ticket stays reachable (Greptile review #15).
 * This resolver supplies the missing signal, so the directive can state a decision
 * instead of leaving one to be guessed.
 *
 * THE DEFAULT IS AUTHORIZED, AND THAT IS THE WHOLE POINT
 * -----------------------------------------------------
 * Scheduled runs have always published — there was never a gate in front of
 * twitter_manage_post, and a behavioural replay of the reported prompt against
 * baseline `main` posted in 10/10 runs. ENG-803 is a report of the agent INVENTING
 * a restriction, so answering it with a real platform-wide restriction is the wrong
 * cure. Measured against the live AW-TaskSchedules table: 897 schedules, 96 active,
 * of which 25 ACTIVE are publishing-shaped (4 requiring a publish tool outright, 21
 * whose prompt tells Emma to post/publish/tweet/reply). A default-deny silently
 * converts all 25 into drafting-only runs — trading a 1-in-62-session fabrication
 * for 25 broken schedules.
 *
 * So the owner control is an OPT-OUT: `requirePublishApproval === true` means "hold
 * my runs at the publish step". Anything else — false, absent, or a legacy row that
 * predates the field — keeps today's behaviour. Because absence means authorized,
 * NO BACKFILL AND NO DATA MIGRATION ARE NEEDED, and no existing schedule changes
 * behaviour when this ships.
 *
 * This is not fail-open in the dangerous direction: it preserves an existing
 * capability rather than granting a new one, and the model still cannot talk its way
 * into publishing — the value is read off the record, never off the prompt. Note the
 * default applies to a MISSING FIELD, not to a missing answer: when the schedule
 * cannot be read at all we withhold instead, because that is the recoverable error
 * (see resolvePublishAuthorized).
 *
 * SIGNALS DELIBERATELY NOT HONOURED — do not reinstate any of these:
 *
 *  - The schedule prompt's free text ("POST replies directly"). Model-read, never an
 *    owner decision, and unscoped — a waiver written about a different step would
 *    authorize a live post.
 *  - `requiredFunctionCalls` naming a publish tool. MODEL-WRITABLE: the
 *    `manage_scheduled_chat` MCP tool PUTs it onto the schedule record, as do admin
 *    templates and work-plan steps. Honouring it lets Emma grant herself standing
 *    authority to post.
 *  - `fullAutonomy` (ENG-396). A different consent: Emma proceeds with her
 *    recommended option rather than pausing on a mid-run decision. That is consent
 *    to decide unaided, not to publish under the owner's name.
 *
 * The rule they share: an authorization signal must mean exactly the capability
 * being granted, and must be writable only by a human. `requirePublishApproval` is
 * absent from the `manage_scheduled_chat` MCP allowlist, so the guard is
 * bidirectional — a model that could write the opt-out could also silence its own
 * publishing.
 *
 * RELATIONSHIP TO ENG-827 (PR #2263), WHICH IS STILL UNMERGED
 * -----------------------------------------------------------
 * ENG-827 introduces `autopublishAuthorized` — the same concept at the OPPOSITE
 * polarity (opt-IN, fail-closed, scope-bound to designated tools). The two field
 * names are deliberately different so that if both land, they cannot silently
 * collide on one name with contradictory meanings; the conflict surfaces as a
 * visible reconciliation instead. Everything here is confined to files ENG-827 does
 * not touch (this file, getScheduledSessionOverride, and the agentModeService call
 * site) precisely so that reconciliation is a product decision rather than a merge
 * fight. See the ENG-803 notes in agentModeSystemPrompt.ts.
 */

import { isPublishName } from './hardeningGaps';

/** The shape this resolver reads. Deliberately minimal — only the owner's opt-out. */
export interface SchedulePublishApprovalInput {
  /**
   * Owner opt-OUT. True means "hold this schedule's runs at the publish step and
   * tell me what is waiting". Human-writable only.
   */
  requirePublishApproval?: boolean;
}

/**
 * Whether an unattended run on this schedule may publish externally.
 *
 * TWO DIFFERENT ABSENCES, TWO DIFFERENT ANSWERS — this distinction is the whole
 * correctness argument, and conflating them was a real bug (Greptile review #16):
 *
 *   - The FIELD is absent on a schedule we successfully read -> AUTHORIZED. That is
 *     every one of the 897 existing rows, none of which has the attribute; treating
 *     it as a withhold would convert 25 active publishing schedules into
 *     drafting-only runs. Absence of the field is not a signal, it is the default.
 *
 *   - The RECORD itself is absent (deleted schedule, or a read that failed and was
 *     caught upstream) -> NOT AUTHORIZED. Here we genuinely do not know what the
 *     owner chose, and an owner who set `requirePublishApproval` would be
 *     overridden by a transient DynamoDB blip. The two errors are not symmetric:
 *     publishing is IRREVERSIBLE and public, while withholding saves the drafts and
 *     tells the owner what is waiting. When we cannot verify, take the recoverable
 *     one.
 *
 * Strict `!== true` on the field so a truthy string or number from a loosely-typed
 * caller cannot silence a schedule's publishing by accident.
 */
export function resolvePublishAuthorized(
  schedule?: SchedulePublishApprovalInput | null
): boolean {
  // No record => we cannot confirm the owner's choice => do not take the
  // irreversible action. See the two-absences note above.
  if (!schedule) return false;
  return schedule.requirePublishApproval !== true;
}

/**
 * Extract a scheduleId from a chat session's pageIdentifier.
 *
 * Scheduled sessions are stamped `"<title>|scheduleId:<id>"` when the run is
 * dispatched (see runScheduledChat). Returns null for any session that is not a
 * scheduled run, or whose identifier is missing or malformed.
 *
 * ANCHORED TO THE STAMPED SUFFIX, DELIBERATELY (Greptile review #17, security).
 * `<title>` is the owner-supplied schedule name, so it is attacker-controlled text
 * sitting IN FRONT of the authoritative id. An unanchored search takes the FIRST
 * match, so naming a schedule `Evil scheduleId:aaaa` yields
 * `"Evil scheduleId:aaaa|scheduleId:<real>"` and the parser would return `aaaa` —
 * binding this run's publish authorization to a DIFFERENT schedule's setting. That
 * turns a display string into an authorization primitive: point it at any schedule
 * with no opt-out and an approval-required run is told to publish.
 *
 * Requiring the `|` separator AND end-of-string pins it to the segment the
 * dispatcher actually appends, which is always last, so no amount of title text can
 * select the record.
 */
export function extractScheduleId(pageIdentifier?: string | null): string | null {
  if (!pageIdentifier || typeof pageIdentifier !== 'string') return null;
  const match = pageIdentifier.match(/\|scheduleId:([a-f0-9-]+)\s*$/);
  return match ? match[1] : null;
}

/**
 * How a session resolves for the dispatch-time publish gate.
 *
 *   'allow'        -> not a scheduled run; no owner schedule setting applies. The
 *                     attended paths that share the tool dispatcher (Emma sidebar,
 *                     live voice) land here, and a human is present for them.
 *   'scheduled'    -> a scheduled run; read the schedule and apply its setting.
 *   'unverifiable' -> we cannot tell. Block, because publishing is irreversible.
 *
 * A NULL SESSION IS 'unverifiable', NOT 'allow' (Greptile review #23). Deleting a
 * scheduled session does not cancel its in-flight worker, so the worker keeps
 * running and its session lookup starts returning null. Treating that as "not
 * scheduled" let the run publish externally past an owner who had required
 * approval — the fail-open hole again, this time through a null rather than a
 * throw. `session?.sessionType !== 'scheduled'` reads naturally and is exactly
 * wrong here, because it collapses "definitely attended" and "no idea" into one
 * answer.
 */
export type PublishGateSessionClass = 'allow' | 'scheduled' | 'unverifiable';

export function classifySessionForPublishGate(
  session?: { sessionType?: string } | null
): PublishGateSessionClass {
  if (!session) return 'unverifiable';
  return session.sessionType === 'scheduled' ? 'scheduled' : 'allow';
}

/**
 * ENG-803: does this call publish CONTENT to an external account?
 *
 * Scoped per dispatcher, because tools like twitter_manage_post and
 * linkedin_manage_post mix publishing actions with pure reads. Blocking a whole
 * dispatcher would stop an approval-required reply run from even FINDING the
 * mentions it is supposed to draft answers to — it would produce nothing at all,
 * not even the drafts the owner is waiting for.
 *
 * "Publishing" here means the action puts something on the owner's public presence
 * under their name. That includes reshares (retweet / repost), not just authored
 * text: an owner who asked to approve before publishing did not agree to have
 * their feed posted to on their behalf either. Pure engagement signals that create
 * no post (like, react, unlike, unretweet) and reads are excluded, as is
 * delete_tweet — removal is governed by its own confirmation rules.
 *
 * Lives here rather than as a private in agentModeService so the enforcement tests
 * exercise the REAL predicate. They previously re-declared a copy of this map and
 * asserted against the copy, which passes no matter what the guard actually does.
 */
const DISPATCHER_PUBLISHING_ACTIONS: Record<string, ReadonlySet<string>> = {
  twitter_manage_post: new Set(['reply', 'post_thread', 'quote_tweet', 'retweet']),
  linkedin_manage_post: new Set(['comment', 'repost']),
};

/**
 * Fold a dispatcher action to the one spelling this map is keyed on.
 *
 * MUST mirror the dispatcher (Greptile review #24, security). `_twitterManagePostImpl`
 * opens with `args.action.replace(/_/g, '-')` and switches on the HYPHENATED form, so
 * `post-thread` and `quote-tweet` are fully valid ways to publish. Comparing the raw
 * value against underscore-only entries therefore let those two spellings sail past the
 * guard and post on a schedule whose owner had required approval — the setting held
 * only for models that happened to pick the other spelling.
 *
 * Folding hyphens to underscores covers both spellings with one entry. Lowercasing is
 * belt-and-braces: the dispatcher's switch is case-sensitive, so a differently-cased
 * action would be rejected downstream anyway — but a guard that is stricter than the
 * dispatcher can only ever block a call that was going to fail, never allow one.
 */
function normalizePublishAction(action: unknown): string {
  return typeof action === 'string' ? action.trim().toLowerCase().replace(/-/g, '_') : '';
}

export function isExternalContentPublish(toolName: string, args: any): boolean {
  // publish_* / post_on_* — whole-tool publishers.
  if (isPublishName(toolName)) return true;
  if (!/_manage_post$/.test(toolName)) return false;

  const known = DISPATCHER_PUBLISHING_ACTIONS[toolName];
  // An UNKNOWN *_manage_post dispatcher is treated as publishing (Greptile review
  // #22 flagged exactly this gap for linkedin_manage_post). A tool named
  // "manage post" is a posting surface by definition, so a new one must not get a
  // free pass simply because nobody added it here. The cost of the conservative
  // default is that a read action on a future dispatcher is blocked on the
  // minority of schedules that require approval; the cost of the permissive
  // default is publishing without the consent the owner explicitly withheld.
  if (!known) return true;
  return known.has(normalizePublishAction(args?.action));
}

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
 * capability rather than granting a new one. A read failure resolves to the status
 * quo, not to a new grant.
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
 * Strict `!== true` so that false, undefined, null, a missing attribute, or a
 * legacy row all resolve to authorized — the pre-existing behaviour. Only an
 * explicit boolean true withholds.
 */
export function resolvePublishAuthorized(
  schedule?: SchedulePublishApprovalInput | null
): boolean {
  return schedule?.requirePublishApproval !== true;
}

/**
 * Extract a scheduleId from a chat session's pageIdentifier.
 *
 * Scheduled sessions are stamped `"<title>|scheduleId:<uuid>"` when the run is
 * dispatched (see runScheduledChat). Returns null for any session that is not a
 * scheduled run, or whose identifier is missing or malformed.
 */
export function extractScheduleId(pageIdentifier?: string | null): string | null {
  if (!pageIdentifier || typeof pageIdentifier !== 'string') return null;
  const match = pageIdentifier.match(/scheduleId:([a-f0-9-]+)/);
  return match ? match[1] : null;
}

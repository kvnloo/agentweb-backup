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
 * Authorization must be something the OWNER set on the schedule, at schedule-creation
 * time, that unambiguously means "publish without asking me". Two routes qualify:
 *
 *  A. `fullAutonomy` on its own. This is the platform's INFORMED consent control: the
 *     schedule form renders it as an amber-bordered warning that explicitly says Emma
 *     will proceed on "irreversible choices that can't be undone after launch". An
 *     owner ticking that has been told what they are waiving.
 *
 *  B. `requiredFunctionCalls` naming a publish tool AND the owner's own prompt
 *     explicitly waiving approval. BOTH are needed, and this is the important part:
 *
 *     The Required Functions picker is a VERIFICATION control ("this run only counts
 *     as successful if it called X"), not a consent surface — its UI carries no
 *     approval-waiver language whatsoever. Treating that tick alone as standing
 *     approval would silently convert schedules whose owner ticked it to VERIFY a
 *     publish into schedules that publish unreviewed. That is not hypothetical: of the
 *     8 production schedules requiring a publish tool, only 3 (the reported Kevin
 *     runs) contain approval-waiver language; the other 5 — including the active
 *     "LUCAS — LinkedIn Thought Leadership" — do not, and must keep drafting.
 *
 *     Requiring a second, independently-authored signal from the schedule's own prompt
 *     ("Post the FULL text automatically. Do not ask for approval.") makes the intent
 *     unambiguous and owner-stated rather than inferred from a checkbox that never
 *     claimed to mean consent.
 *
 * Everything is fail-closed: no match, an unreadable schedule, or a malformed field
 * all resolve to NOT authorized, i.e. the reversible draft-and-notify outcome.
 *
 * Authorization is deliberately PER-TOOL: only the publish tools the owner actually
 * listed are authorized, so requiring `post_on_connected_account` does not silently
 * authorize `publish_landing_page_changes`. Anything not explicitly named stays
 * gated and falls back to the safe draft-and-notify outcome.
 */

/**
 * Explicit approval-waiver phrasings, matched against the schedule's own prompt.
 * Deliberately NARROW: each pattern requires the owner to have written about
 * approval/asking/sign-off, or to have said "post automatically" in as many words.
 * A bare "automatically" is NOT enough — "automatically generate an image" says
 * nothing about publishing unreviewed — so it is not matched.
 */
const APPROVAL_WAIVER_PATTERNS: RegExp[] = [
  // "do not ask for approval", "don't wait for my sign-off", "doesn't ask for permission"
  /\bdo(?:es)?\s*n(?:o|')?t\s+(?:ask|wait|check|stop)\s+(?:for\s+)?(?:my\s+|your\s+|an?\s+|any\s+|the\s+)?(?:approval|sign[-\s]?off|confirmation|permission|review)/i,
  // "without approval", "without asking", "without my sign-off", "without waiting for review"
  /\bwithout\s+(?:my\s+|your\s+|any\s+|prior\s+|explicit\s+|human\s+|further\s+|waiting\s+for\s+)*(?:approval|sign[-\s]?off|confirmation|permission|review|asking)/i,
  // "no approval needed", "no sign-off required"
  /\bno\s+(?:approval|sign[-\s]?off|confirmation|permission)\s+(?:is\s+)?(?:needed|required|necessary)/i,
  // "post it automatically", "publish automatically", "automatically post"
  /\b(?:post|publish|share|tweet)\s+(?:it\s+|them\s+|this\s+|the\s+\S+\s+){0,3}automatically\b/i,
  /\bautomatically\s+(?:post|publish|share|tweet)\b/i,
];

/** Does the schedule's own prompt explicitly waive the publish-approval gate? */
export function promptWaivesPublishApproval(startingMessage?: string): boolean {
  if (typeof startingMessage !== 'string' || !startingMessage.trim()) return false;
  return APPROVAL_WAIVER_PATTERNS.some(re => re.test(startingMessage));
}
export interface SchedulePublishAuthorizationInput {
  fullAutonomy?: boolean;
  requiredFunctionCalls?: string[];
  /** The schedule's own prompt — the second, owner-authored consent signal (route B). */
  startingMessage?: string;
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

  // Route A: the informed consent control, sufficient on its own.
  if (schedule.fullAutonomy === true) return { authorized: true, tools };

  // Route B: a required publish tool is only consent when the owner's own prompt
  // ALSO waives approval. The picker alone is a verification control, never a
  // waiver — see the header note for why that distinction is load-bearing.
  const authorized = tools.length > 0 && promptWaivesPublishApproval(schedule.startingMessage);
  return { authorized, tools };
}

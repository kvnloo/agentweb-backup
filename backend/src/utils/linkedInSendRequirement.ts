import { toolCallSucceeded } from './toolCallOutcome';

/**
 * ENG-1720 — a `linkedin_outreach` requirement must be satisfied by a SEND that
 * happened, not by any call to the tool that happens to share its name.
 *
 * THE BUG. `linkedin_outreach` is one action-multiplexing tool: `search-people`,
 * `get-profile` and `list-connections` read, `send-invite`/`send-message`/
 * `send-inmail` write to a real person. A schedule can only spell the TOOL in
 * `requiredFunctionCalls` — there is no per-action requirement — so the final
 * verdict counted every successful call by name. A run that made ONE successful
 * `search-people` and had EVERY `send-invite` refused therefore satisfied
 * `min: 1`, kept `runDelivered: true`, and reported `status: 'success'` to an
 * owner whose outreach sent nothing. Of the 8 schedules declaring the
 * requirement in production, 6 leave `functionCallMinCalls` empty (defaults to
 * 1) and 2 set `{ linkedin_outreach: 1 }` — every one of them is defeated this
 * way, which is precisely the false success ENG-1132 AC #2 was filed to catch.
 *
 * WHY NOT JUST WIDEN THE BLOCK REGEX. The previous mechanism only engaged when
 * `LINKEDIN_INVITE_CAP_BLOCK_RE` recognised a cooldown/pacing phrasing, so a
 * send failing any OTHER way ("recipient cannot be reached", provider errors —
 * the class ENG-1640 reported live on 2026-08-31, 8 leads across 3+ runs) was
 * never even considered. Counting the ACTION makes that regex a labelling
 * concern (which sentence the owner reads) rather than a correctness one
 * (whether the run passed), which is why the fix lives here and not in the
 * pattern.
 *
 * THE RULE, and its deliberate boundary:
 *
 *   - A run that attempted NO send action is not a send run. Nothing changes for
 *     it — the name-keyed count still stands, so a schedule that requires
 *     `linkedin_outreach` purely for reads (search/report cadences) is not newly
 *     broken, and neither is a mixed schedule that legitimately found nobody
 *     worth inviting and sent nothing.
 *   - A run that attempted at least one send IS a send run, and only its
 *     SUCCEEDED sends count toward the minimum. Reads are excluded outright: a
 *     search is not a substitute for the invitation the owner is paying for.
 *
 * The boundary is drawn at "attempted", not at "was blocked", on purpose. It
 * does mean a read-oriented schedule whose model speculatively tries one send
 * that fails now reports failure. That is the correct report: the tool was asked
 * to contact a real person, and it did not. Treating it as success is the exact
 * defect above with a less common ledger shape.
 *
 * SCOPE. This changes the FINAL verdict only. It deliberately does NOT feed
 * `countsTowardRequirement` / the runVerifiedChat nudge loop: that loop re-presses
 * the model toward an unmet requirement, and pressing harder against an account
 * that is refusing sends is the press amplification ENG-1715 exists to bound —
 * see the asymmetry `toolCallOutcome.ts` documents for the same reason. Publish
 * equivalence (`requiredCallSatisfaction.ts`, ENG-1045/ENG-1276) is untouched;
 * `linkedin_outreach` has no equivalence routes.
 */

/** A tool-ledger entry as agentMode records it: { name, arguments, result, error }. */
export interface LinkedInLedgerEntry {
  name?: string;
  arguments?: any;
  result?: any;
  error?: any;
  duplicateOf?: string;
}

export const LINKEDIN_OUTREACH_TOOL = 'linkedin_outreach';

/**
 * The actions that put a message in front of a real person. `cancel-invitation`
 * and `accept-invitation` are writes too, but neither initiates outreach — a
 * schedule that requires `linkedin_outreach` is not satisfied by withdrawing an
 * invitation, and inbound accepts are not the run's own sending work.
 */
export const LINKEDIN_SEND_ACTIONS = new Set<string>([
  'send-invite',
  'send-message',
  'send-inmail',
]);

/**
 * A ledger entry's `arguments` is USUALLY the parsed object, but a request-only
 * entry can still carry the raw JSON string the provider sent when parsing failed
 * at dispatch time. Reading `.action` off a string returns undefined, which would
 * classify a genuine send as a non-send and hand back the very false success this
 * module removes. Same fallback as `resolveAction` in requiredCallSatisfaction.ts
 * and `reconstructedToolCallArguments` in agentModeController.ts.
 */
export function linkedInOutreachArgs(call: any): Record<string, any> | null {
  const args = call?.arguments;
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fold an action to the spelling the dispatcher actually routes on.
 *
 * `agentModeService.linkedinOutreach` opens with
 * `(args.action as string)?.replace(/_/g, '-')`, so `send_invite` and
 * `send-invite` reach the SAME handler and both really send. The ledger stores
 * the model's raw argument, not the folded one, so comparing it verbatim credits
 * one spelling and not the other for the identical send — the same
 * one-spelling-only defect `normalizeAction` was added to requiredCallSatisfaction
 * for. Fold here so classification cannot disagree with dispatch.
 */
export function normalizeLinkedInOutreachAction(call: any): string {
  const args = linkedInOutreachArgs(call);
  const raw = args ? args.action : undefined;
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/_/g, '-') : '';
}

/** Is this ledger entry a `linkedin_outreach` call at all? */
export function isLinkedInOutreachCall(call: any): boolean {
  return call?.name === LINKEDIN_OUTREACH_TOOL;
}

/** Is this ledger entry a `linkedin_outreach` call that tried to contact someone? */
export function isLinkedInSendCall(call: any): boolean {
  return isLinkedInOutreachCall(call) && LINKEDIN_SEND_ACTIONS.has(normalizeLinkedInOutreachAction(call));
}

export interface LinkedInSendRequirementVerdict {
  /** The run tried to contact at least one person, so its sends are what count. */
  isSendRun: boolean;
  attemptedSends: number;
  successfulSends: number;
  /**
   * True when this is a send run whose successful sends fall short of the
   * configured minimum. Always false for a run that attempted no send — such a
   * run keeps the historical name-keyed count (see the module docblock).
   */
  requirementMissed: boolean;
  /**
   * What `functionCallDetails.linkedin_outreach.actual` should report, or null to
   * leave the name-keyed count in place. Non-null exactly when `isSendRun`, so a
   * send run can never persist `{ actual: 2, required: 1 }` next to a
   * `functionCallMisses` entry naming the same tool — the self-contradicting
   * record shape ENG-827/ENG-1045 spent two issues removing.
   */
  reportedActual: number | null;
}

/**
 * Decide whether a run's `linkedin_outreach` requirement was met, action-aware.
 *
 * `toolCalls` must be the COMBINED ledger (a resumed run's abandoned portion plus
 * this portion) — the same list the block detector and the requirement counter
 * read, so a send that succeeded before an abandonment still counts.
 */
export function evaluateLinkedInSendRequirement(
  toolCalls: Array<LinkedInLedgerEntry | null | undefined> | null | undefined,
  requiredCalls: number,
): LinkedInSendRequirementVerdict {
  const entries = Array.isArray(toolCalls) ? toolCalls : [];
  const sendCalls = entries.filter(isLinkedInSendCall);
  const attemptedSends = sendCalls.length;
  const successfulSends = sendCalls.filter(toolCallSucceeded).length;
  const isSendRun = attemptedSends > 0;
  // A non-positive/NaN minimum is treated as 1, matching the caller's own
  // `functionCallMinCalls.linkedin_outreach || 1` default: a requirement that is
  // present at all asks for at least one send.
  const minimum = Number.isFinite(requiredCalls) && requiredCalls > 0 ? requiredCalls : 1;
  return {
    isSendRun,
    attemptedSends,
    successfulSends,
    requirementMissed: isSendRun && successfulSends < minimum,
    reportedActual: isSendRun ? successfulSends : null,
  };
}

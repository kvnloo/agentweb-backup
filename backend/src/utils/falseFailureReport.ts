/**
 * ENG-971: false-FAILURE reporting after a confirmed successful publish/deploy.
 *
 * The INVERSION of the usual truthful-reporting failure (ENG-143 finalize guard,
 * ENG-736 landing reconciler both guard the false-SUCCESS direction). In the prod
 * session the work genuinely landed — the shared capture route was fixed, the
 * landing-page changes were published to production, and live smoke tests verified
 * them — but a validation error on a trailing NON-CRITICAL bookkeeping call
 * (save_memory) was generalized into "the system timed out and your changes were
 * not saved. Please try again." All three judges scored it 2/5 for dataAccuracy.
 * Worst-case consequence: the user re-runs a production deploy that already landed.
 *
 * Two independent defects produced that sentence, and this module backs the fix for
 * both:
 *   1. The model-visible tool error for a bookkeeping tool carried no criticality
 *      verdict — it read exactly like a failure of the primary work. `BOOKKEEPING_TOOLS`
 *      / `isBookkeepingTool` drive the scoped guidance in
 *      AgentModeService.formatToolError.
 *   2. Nothing checked the closing narrative against the run's own tool ledger.
 *      `reconcileFalseFailureReport` is that check: a deterministic, always-on guard
 *      (no LLM, no feature flag) that fires ONLY when the final message asserts BOTH
 *      an interruption AND that the work was not saved, while the ledger holds a
 *      CONFIRMED successful publish/deploy.
 *
 * Like the ENG-736 reconciler it only ever APPENDS — it never removes or rewrites the
 * model's own text — so it cannot invent an outcome the ledger does not show (a run
 * with no confirmed publish produces no correction at all).
 *
 * WHERE IT HAS TO RUN. Pulling the production session showed the false-failure
 * sentence was NOT the model's closing narrative: the turn hit the 600s generation
 * timeout (`GENERATION_TIMEOUT_MS`) three minutes AFTER the publish had landed and
 * been verified live, and the message was written by the DIAGNOSIS AGENT in
 * agentModeController's catch block. A thrown turn never reaches the seam in
 * `generateMarketingResponse` where the finalize guard and the ENG-736 reconciler
 * live, so the guard is wired on BOTH paths: the loop edge (model-composed close)
 * and the diagnosis path (`ledgerFromSucceededFunctions` supplies the ledger there,
 * since `toolCalls[]` does not survive the throw).
 */

/** A tool-ledger entry (agentMode toolCalls[]): { name, result, error }. */
export interface FalseFailureLedgerEntry {
  name?: string;
  result?: any;
  error?: any;
}

/**
 * Bookkeeping / side-effect tools: they record a note ABOUT the work, they are not
 * the work. A failure here can never invalidate an already-confirmed primary
 * outcome. Deliberately limited to the cross-session memory tools — a knowledge-base
 * file write (update_knowledge_base_file) produces a user-visible artifact and IS
 * primary work, so misclassifying it would be worse than the bug being fixed.
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set<string>([
  'save_memory',
  'save_org_memory',
  'delete_memory',
  'delete_org_memory',
]);

export function isBookkeepingTool(toolName: string | undefined | null): boolean {
  return !!toolName && BOOKKEEPING_TOOLS.has(toolName);
}

/**
 * Tools whose SUCCESS means something real and user-visible went live. Read-only
 * lookups are intentionally excluded — this guard is about work that HAPPENED this
 * run, which is what makes "your changes were not saved" a factual error.
 */
const CONFIRMED_PUBLISH_TOOLS: ReadonlySet<string> = new Set<string>([
  'publish_landing_page_changes',
  'deploy_landing_page',
  'generate_landing_page',
  'duplicate_landing_page',
  'publish_blog_article',
]);

/** Plain-language label per tool, so the correction reads as prose, not tool names. */
const PUBLISH_ACTION_LABELS: Record<string, string> = {
  publish_landing_page_changes: 'published your landing-page changes',
  deploy_landing_page: 'deployed your landing page',
  generate_landing_page: 'deployed your landing page',
  duplicate_landing_page: 'deployed your landing page',
  publish_blog_article: 'published your blog article',
};

/** Marker on the appended correction — keeps a second pass idempotent. */
const CORRECTION_MARKER = '⚠️ Correction: the run log confirms this session DID complete';

/**
 * "…the system timed out…" — an interruption asserted about the run itself. Also
 * covers the "connection was lost / interrupted" phrasings of the same claim.
 */
const INTERRUPTION_CLAIM_RE = /\btimed[- ]out\b|\btimeouts?\b|\b(?:session|connection|request)\b[^.!?\n]{0,40}\b(?:was )?(?:interrupted|dropped|lost)\b/i;

/**
 * "…your changes were not saved…" / "…nothing was saved…" / "…your edits were lost…".
 * Requires an explicit not-saved/lost assertion — an accurate, scoped caveat such as
 * "I could not save a memory note" must NOT match (it names the note, not the work).
 */
const NOT_SAVED_CLAIM_RE =
  /\b(?:was|were|are|is)\s*n[o']?t\s+saved\b|\bnot\s+(?:been\s+)?saved\b|\bnothing\s+(?:was\s+)?saved\b|\bnot\s+persisted\b|\bdid\s*n[o']?t\s+save\b|\b(?:changes?|edits?|updates?|work|progress|fixes?)\b[^.!?\n]{0,40}\b(?:were|was|are|is)?\s*(?:lost|discarded|rolled\s+back|reverted)\b/i;

/**
 * Negators that turn a not-saved clause into a truthful REASSURANCE — "but no work
 * was lost", "however, none of your work was lost", "recovered without any work
 * lost". Matched only against the text PRECEDING the loss/save term inside the same
 * clause, so a genuine "nothing was saved" (where the negator IS the subject that
 * went missing) still counts as an assertion.
 */
const NEGATED_LOSS_PREFIX_RE = /\b(?:no|none|nothing|without|never)\b[^.!?;,\n]{0,24}$/i;

/** Clause boundaries — a negator only negates within its own clause. */
const CLAUSE_BOUNDARY_RE = /[.!?;,\n][^.!?;,\n]*$/;

/**
 * The not-saved half of the pattern, ignoring clauses whose loss/save term is negated.
 * All matches are considered: one truthful "no work was lost" clause elsewhere in the
 * message must not excuse a real "your changes were not saved" claim, and vice versa.
 */
function assertsWorkNotSaved(content: string): boolean {
  const re = new RegExp(NOT_SAVED_CLAIM_RE.source, `${NOT_SAVED_CLAIM_RE.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const before = content.slice(0, match.index);
    const boundary = before.search(CLAUSE_BOUNDARY_RE);
    const clausePrefix = boundary === -1 ? before : before.slice(boundary + 1);
    if (!NEGATED_LOSS_PREFIX_RE.test(clausePrefix)) return true;
  }
  return false;
}

/**
 * Does the final text assert the ENG-971 pattern — an interruption AND that the work
 * was not saved? Both halves are required: an interruption alone ("the web search
 * timed out, everything else is saved") and a save-failure alone ("I could not save a
 * memory note") are each legitimate and must not trigger a correction. A negated loss
 * ("the session timed out; however, none of your work was lost") is truthful too, and
 * is likewise excluded.
 */
export function assertsUnsavedInterruption(content: string): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  return INTERRUPTION_CLAIM_RE.test(content) && assertsWorkNotSaved(content);
}

/** True when this ledger entry is a publish/deploy that genuinely went live. */
function isConfirmedPublish(entry: FalseFailureLedgerEntry | null | undefined): boolean {
  if (!entry || entry.error !== undefined) return false;
  if (!entry.name || !CONFIRMED_PUBLISH_TOOLS.has(entry.name)) return false;
  const r = entry.result;
  // Record-shaped landing tools carry their own lifecycle state on the minimal
  // stored result: only "deployed" / "success" actually went live ("failed",
  // "generating", "deploying", "building" did not). Tools whose minimal result
  // carries no status at all (publish_landing_page_changes, publish_blog_article)
  // are confirmed by the absence of an error — an encoded success=false failure is
  // already downgraded to an error entry upstream (core/toolDispatch).
  if (r && typeof r === 'object') {
    if (typeof r.status === 'string' && r.status !== 'deployed') return false;
    if (typeof r.buildStatus === 'string' && r.buildStatus !== 'success') return false;
  }
  return true;
}

/**
 * Build a ledger from a session's `calledFunctions` histogram.
 *
 * The in-loop ledger (`toolCalls[]`) only exists on the path where the turn RETURNS.
 * When the turn THROWS — the 600s generation timeout that produced the ENG-971
 * session — the controller's catch has nothing but the persisted session. That
 * session already carries an accurate success ledger: `toolDispatch` flushes
 * successful and failed calls to SEPARATE counters (`incrementCalledFunctions` /
 * `incrementFailedFunctions`) after every iteration, so `calledFunctions` is the
 * histogram of calls that SUCCEEDED, durable at the moment of the throw.
 *
 * Entries carry no `result` and no `error`, which is exactly right: a name in this
 * histogram is itself the confirmation that the call succeeded.
 */
export function ledgerFromSucceededFunctions(
  calledFunctions: Record<string, number> | null | undefined,
): FalseFailureLedgerEntry[] {
  if (!calledFunctions || typeof calledFunctions !== 'object') return [];
  return Object.entries(calledFunctions)
    .filter(([name, count]) => !!name && typeof count === 'number' && count > 0)
    .map(([name]) => ({ name }));
}

/** Plain-language labels of every publish/deploy confirmed this run, de-duplicated. */
export function collectConfirmedPublishActions(
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of toolCalls) {
    if (!isConfirmedPublish(entry)) continue;
    const label = PUBLISH_ACTION_LABELS[entry.name as string];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** The visible correction appended to a false-failure closing narrative. */
export function buildFalseFailureCorrection(actions: string[], bookkeepingFailed: boolean): string {
  return (
    `${CORRECTION_MARKER}, successfully: ${actions.join('; ')}. `
    + 'That work is saved and live — the statement above about a timeout or unsaved changes does not apply to it, '
    + 'so please do NOT re-run it.'
    + (bookkeepingFailed
      ? ' The only step that failed was a bookkeeping call that stores a note for future sessions; '
        + 'it does not affect the work above.'
      : '')
  );
}

/**
 * Append a truthful correction when the final message reports the session as timed
 * out / unsaved while the run ledger confirms a publish or deploy actually landed.
 * Returns `content` unchanged when there is nothing to correct (no confirmed publish,
 * no false-failure claim, a correction already present, or no text to augment).
 */
export function reconcileFalseFailureReport(
  content: string,
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content;
  if (content.includes(CORRECTION_MARKER)) return content;
  if (!assertsUnsavedInterruption(content)) return content;

  const actions = collectConfirmedPublishActions(toolCalls);
  if (actions.length === 0) return content;

  const bookkeepingFailed = Array.isArray(toolCalls)
    && toolCalls.some((e) => e && e.error !== undefined && isBookkeepingTool(e.name));

  return `${content.replace(/\s+$/, '')}\n\n${buildFalseFailureCorrection(actions, bookkeepingFailed)}`;
}

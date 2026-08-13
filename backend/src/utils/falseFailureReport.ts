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
  'publish_blog_article',
  // A duplicate social post or a duplicate outreach email is as unrecoverable as a
  // duplicate deploy, so a false failure after one is just as costly.
  'post_on_connected_account',
  'post_thread',
  'send_email_to_lead',
  'send_email_from_sender',
  'send_dm',
]);

/**
 * Two tools were REMOVED from this set after review, and the reason matters:
 *
 *   `generate_landing_page` / `duplicate_landing_page` produce a DRAFT plus a
 *   preview, not a production publish — in the ENG-971 session generate_landing_page
 *   returned `awaitingReconnect: true` with a preview URL. Labelling that "deployed"
 *   and telling the user not to re-run it is simply false, and re-running a draft is
 *   cheap and harmless. Tolerable while this set only drove an appended correction;
 *   not tolerable once it also decides whether a scheduled run is allowed to retry,
 *   where over-reach silently disables a schedule's auto-recovery.
 *
 * Also deliberately absent: `twitter_manage_post`. It multiplexes create/delete/read
 * behind one name, and on the diagnosis path only the NAME survives the throw — a
 * successful delete would be announced as "posted". This guard's whole contract is
 * that it cannot claim an outcome the ledger does not show, so anything ambiguous is
 * excluded rather than guessed.
 */

/**
 * ENG-1173: data writes that are duplicate-unsafe but are NOT publishes.
 *
 * Kept in its own set, and consumed ONLY by `reconcileFalseDataWriteFailure`, because
 * `CONFIRMED_PUBLISH_TOOLS` decides more than wording. Through
 * `collectConfirmedPublishActions` it drives `mayHavePublished` in agentModeController,
 * which decides whether a failed SCHEDULED run may be requeued at all. Adding CRM
 * writes there would silently disable a schedule's auto-recovery for any task that
 * touches the CRM — exactly the over-reach the note above about
 * `generate_landing_page` describes. This set changes a MESSAGE and nothing else.
 *
 * Narrow on purpose. `import_leads_from_search` is deliberately absent: ENG-1002 and
 * ENG-1068 both record its written-vs-reported counts disagreeing, so "it wrote
 * something" is not yet a claim this module can stand behind by name alone.
 */
const CONFIRMED_DATA_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  'add_leads_to_list',
  'create_lead_list',
  'add_lead_engagement',
  // Enrichment spends paid Apollo / LinkedIn credits and writes back to the CRM, so a
  // needless re-run costs real money on top of duplicating work.
  'enrich_leads_execute',
  'enrich_lead_custom',
  // Created in the user's OWN Drive — a re-run leaves them with two of the file.
  'create_google_doc',
  'create_google_sheet',
  'create_knowledge_base',
]);

/** Plain-language labels for the data-write set. Deliberately carry no quantities. */
const DATA_WRITE_ACTION_LABELS: Record<string, string> = {
  add_leads_to_list: 'added leads to your list',
  create_lead_list: 'created your lead list',
  add_lead_engagement: 'recorded a lead engagement event',
  enrich_leads_execute: 'ran enrichment on your lead list',
  enrich_lead_custom: 'enriched a lead',
  create_google_doc: 'created a Google Doc in your Drive',
  create_google_sheet: 'created a Google Sheet in your Drive',
  create_knowledge_base: 'created a knowledge base',
};

/**
 * Deliberately EXCLUDED, and the reasons follow the same rule as the publish set —
 * a name has to confirm the outcome on its own, because on the diagnosis path the
 * name is all that survives the throw:
 *
 *   `import_leads_from_search` — ENG-1002 and ENG-1068 both record its
 *   written-vs-reported counts disagreeing, so "it wrote something" is not yet a
 *   claim this module can stand behind.
 *
 *   `create_blog_article`, `create_book`, `create_social_media_posts` — these produce
 *   DRAFTS, not published artifacts, exactly like the `generate_landing_page` case
 *   above. Re-running a draft is cheap; telling the user not to is simply false.
 *
 *   `create_task_from_prompt` / `create_task_from_template` /
 *   `create_image_task_from_prompt` — all three are marked [DEPRECATED] in the tool
 *   registry and are being phased out.
 *
 *   Every `update_*` and `delete_*` tool — these overwrite or remove a known target,
 *   so a repeat converges on the same state instead of duplicating it. Re-running is
 *   the safe advice there, which is the opposite of what this notice says.
 */

/** Plain-language label per tool, so the correction reads as prose, not tool names. */
const PUBLISH_ACTION_LABELS: Record<string, string> = {
  publish_landing_page_changes: 'published your landing-page changes',
  deploy_landing_page: 'deployed your landing page',
  publish_blog_article: 'published your blog article',
  post_on_connected_account: 'posted to your connected account',
  post_thread: 'posted your thread',
  send_email_to_lead: 'sent your email',
  send_email_from_sender: 'sent your email',
  send_dm: 'sent your direct message',
};

/** Marker on the appended correction — keeps a second pass idempotent. */
const CORRECTION_MARKER = '⚠️ Correction: the run log confirms this session DID complete';

/**
 * "…the system timed out…" — an interruption asserted about the run itself. The
 * message is written by an LLM, so this cannot key off one sentence: "cut short",
 * "ended unexpectedly", "ran out of time" and "partway through" are the same claim
 * in the diagnosis agent's own vocabulary.
 */
const INTERRUPTION_CLAIM_RE = new RegExp([
  String.raw`\btimed[- ]out\b`,
  String.raw`\btimeouts?\b`,
  String.raw`\bran\s+out\s+of\s+time\b`,
  String.raw`\bcut\s+short\b`,
  String.raw`\bended\s+unexpectedly\b`,
  String.raw`\bpartway\s+through\b`,
  String.raw`\bdid\s*n[o']?t\s+finish\b`,
  // ENG-1173: the diagnosis agent's OWN phrasing for the same claim. Production
  // session 98b90503 closed with "the process took longer than expected" and matched
  // none of the patterns above, so the guard never even reached the ledger check.
  String.raw`\btook\s+longer\s+than\s+expected\b`,
  String.raw`\b(?:session|connection|request|run)\b[^.!?\n]{0,40}\b(?:was )?(?:interrupted|dropped|lost)\b`,
].join('|'), 'i');

/**
 * The loss claim comes in two grammatically OPPOSITE shapes, and conflating them is
 * what makes a naive regex both miss real failures and fire on truthful reassurance:
 *
 *   DENIED SUCCESS — "not saved", "never applied", "did not go through", "nothing
 *   was published". A negator is REQUIRED for these to assert loss; they are already
 *   negative, so they need no further negation check.
 *
 *   ASSERTED LOSS — "your changes were lost / discarded / reverted". These assert
 *   loss on their own, which means a negator FLIPS them into reassurance: "no work
 *   was lost" and "your changes were not lost" are both truthful.
 *
 * Handling them with one pattern is why "your changes were not lost" would previously
 * have fired the guard: the negator sat INSIDE the match, where a prefix-only check
 * could never see it.
 */
const DENIED_SUCCESS_RE = new RegExp([
  String.raw`\b(?:was|were|are|is|has|have|had|been)\s*n[o']?t\s+(?:been\s+)?(?:saved|persisted|applied|published|deployed|posted|sent|committed|stored)\b`,
  String.raw`\bnot\s+(?:been\s+)?(?:saved|persisted|applied|published|deployed|posted|sent|committed|stored)\b`,
  String.raw`\b(?:was|were|are|is)\s+never\s+(?:saved|persisted|applied|published|deployed|posted|sent)\b`,
  String.raw`\bdid\s*n[o']?t\s+(?:save|persist|apply|publish|deploy|post|send|go\s+through|make\s+it)\b`,
  String.raw`\bcould\s*n[o']?t\s+be\s+(?:saved|persisted|applied|published|deployed|posted|sent|committed)\b`,
  // Scoped to the WORK, so a truthful "I could not complete the competitor
  // comparison" or "…could not complete the memory note" stays silent.
  String.raw`\bcould\s*n[o']?t\s+(?:complete|finish)\s+(?:the\s+|your\s+)?(?:deployment|deploy|publish\w*|update|changes?|fix(?:es)?|edits?|post|send)\b`,
  // ENG-1173: "Emma was unable to finish adding your prospects to the … list" — the
  // production denial in session 98b90503, where five add_leads_to_list batches had
  // all returned success. Left unscoped on purpose: the object is a GERUND phrase
  // ("finish adding your prospects"), which no noun list can enumerate. Over-firing
  // is cheap here because the guard only ever APPENDS what the ledger confirms — it
  // cannot assert an outcome the run did not produce.
  String.raw`\b(?:was|were|is|are)?\s*unable\s+to\s+(?:finish|complete)\b`,
  String.raw`\bcould\s+not\s+be\s+completed\b`,
  String.raw`\bmay\s+n[o']?t\s+have\s+(?:been\s+)?(?:saved|persisted|applied|published|deployed|sent|gone\s+through)\b`,
  String.raw`\bnothing\s+(?:was\s+)?(?:saved|persisted|applied|published|deployed|posted|sent)\b`,
  String.raw`\bnone\s+of\s+(?:the|your|these|those)\s+[^.!?\n]{0,30}?\b(?:made\s+it|went\s+through|(?:was|were)\s+(?:saved|applied|published|deployed|sent|posted))\b`,
  // "…cut short BEFORE the changes could be applied" — negative by structure, with
  // no negator anywhere in it. Requires "could BE <verb>", so "before I could save a
  // memory note" (a truthful scoped caveat) does not match.
  String.raw`\bbefore\s+[^.!?\n]{0,30}?\bcould\s+be\s+(?:saved|applied|published|deployed|sent|posted|committed)\b`,
].join('|'), 'i');

/** "…your changes were lost…" — asserts loss outright, so a negator cancels it. */
const ASSERTED_LOSS_RE =
  /\b(?:changes?|edits?|updates?|work|progress|fixes?|deployment|post|email|message)\b[^.!?\n]{0,40}\b(?:were|was|are|is|been)?\s*(?:lost|discarded|rolled\s+back|reverted|thrown\s+away|wiped)\b/i;

/**
 * Negators that turn an asserted loss into a truthful REASSURANCE — "but no work was
 * lost", "however, none of your work was lost". Checked against the text PRECEDING
 * the match inside the same clause.
 */
const NEGATED_LOSS_PREFIX_RE = /\b(?:no|none|nothing|without|never)\b[^.!?;,\n]{0,24}$/i;

/** The same negators appearing INSIDE the match — "your changes were not lost". */
const NEGATOR_WITHIN_RE = /\b(?:not|never|n't|no)\b/i;

/** Clause boundaries — a negator only negates within its own clause. */
const CLAUSE_BOUNDARY_RE = /[.!?;,\n][^.!?;,\n]*$/;

/**
 * The loss half of the pattern. A denied success is decisive on its own; an asserted
 * loss counts only when nothing negates it, whether the negator sits before the match
 * or within it. All matches are considered, so one truthful "no work was lost" clause
 * elsewhere in the message cannot excuse a real "your changes were not saved" claim.
 */
function assertsWorkNotSaved(content: string): boolean {
  if (DENIED_SUCCESS_RE.test(content)) return true;

  const re = new RegExp(ASSERTED_LOSS_RE.source, `${ASSERTED_LOSS_RE.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (NEGATOR_WITHIN_RE.test(match[0])) continue;
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
/**
 * The successes belonging to THIS turn, as a delta between two `calledFunctions`
 * snapshots.
 *
 * `calledFunctions` accumulates for the LIFE OF THE SESSION — `incrementCalledFunctions`
 * merges into the existing map and is never reset per turn or per run. Reading it raw
 * therefore attributes any earlier success to the current failure, which breaks in two
 * ways:
 *
 *   - Interactive: turn 1 publishes, turn 7 fails on something unrelated, and the
 *     error message announces the turn-1 publish as though it were this request's.
 *   - Scheduled, and far worse: an abandoned run that published is RESUMED into the
 *     same session (`isResumeRun` → `sessionId = pendingResumeSessionId`). The
 *     resumed run inherits that publish, so an unrelated zero-output failure would
 *     see it and suppress the requeue — silently ending the schedule's auto-recovery.
 *     Resume is precisely the path for runs that did real work first, so this is the
 *     common case, not a corner.
 *
 * Only counts that INCREASED since the snapshot are this turn's work. A missing
 * baseline means "nothing known to have happened before", which is correct for a
 * fresh session and conservative everywhere else.
 */
export function diffSucceededFunctions(
  before: Record<string, number> | null | undefined,
  after: Record<string, number> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!after || typeof after !== 'object') return out;
  const baseline = before && typeof before === 'object' ? before : {};
  for (const [name, count] of Object.entries(after)) {
    if (!name || typeof count !== 'number') continue;
    const prior = typeof baseline[name] === 'number' ? baseline[name] : 0;
    if (count - prior > 0) out[name] = count - prior;
  }
  return out;
}

export function ledgerFromSucceededFunctions(
  calledFunctions: Record<string, number> | null | undefined,
): FalseFailureLedgerEntry[] {
  if (!calledFunctions || typeof calledFunctions !== 'object') return [];
  return Object.entries(calledFunctions)
    .filter(([name, count]) => !!name && typeof count === 'number' && count > 0)
    .map(([name]) => ({ name }));
}

/** A persisted transcript message, as the scheduled paths read it. */
export interface TranscriptToolMessage {
  role?: string;
  name?: string;
  content?: unknown;
  timestamp?: string;
  metadata?: { timestamp?: string; [k: string]: unknown };
}

/**
 * Publish/deploy actions this ATTEMPT completed, read from the transcript rather
 * than from `calledFunctions`.
 *
 * The counters are session-cumulative and a recovered run RESUMES the abandoned
 * run's session, so on the reconciler path they cannot tell an earlier attempt's
 * publish from this one's — which would wrongly pause a schedule whose latest
 * attempt published nothing. The lease already carries `startedAt`, so the
 * transcript gives a precisely-scoped answer with no extra state to persist:
 * successful publish tool results timestamped at or after this attempt began.
 *
 * A tool result carrying the "⚠️ Tool Error" envelope is a FAILED call and never
 * counts. Messages with no usable timestamp are ignored rather than assumed
 * in-window — over-counting here pauses a live schedule.
 */
export function collectPublishActionsSince(
  messages: TranscriptToolMessage[] | null | undefined,
  sinceIso: string | null | undefined,
): string[] {
  if (!Array.isArray(messages)) return [];
  const since = sinceIso ? new Date(sinceIso).getTime() : NaN;
  if (!Number.isFinite(since)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (!m || m.role !== 'tool' || !m.name || !CONFIRMED_PUBLISH_TOOLS.has(m.name)) continue;
    const stamp = m.timestamp || m.metadata?.timestamp;
    const at = stamp ? new Date(stamp).getTime() : NaN;
    if (!Number.isFinite(at) || at < since) continue;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (text.includes('⚠️ Tool Error')) continue;
    const label = PUBLISH_ACTION_LABELS[m.name];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
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
 * The notice for text that carries no false CLAIM but does carry false ADVICE — the
 * static fallback used when the diagnosis agent is unavailable still says "please try
 * sending your message again", which after a landed publish is the same double-deploy
 * instruction that made ENG-971 harmful.
 */
export function buildConfirmedWorkNotice(actions: string[]): string {
  return (
    `${CORRECTION_MARKER}, successfully: ${actions.join('; ')}. `
    + 'That work is saved and live, so please do NOT re-run it.'
  );
}

/**
 * Append what the ledger confirms, with no test on the prose.
 *
 * `reconcileFalseFailureReport` judges a message and corrects it only when it lies.
 * This one is for text the CALLER already knows is generic — the fixed fallback
 * strings on the error path, which have no outcome in them at all and end in blanket
 * retry advice. There is nothing to judge, so a confirmed publish alone earns the
 * notice. Never point this at model-written prose: a truthful closing message would
 * get a "Correction" banner it does not deserve.
 */
export function appendConfirmedPublishNotice(
  content: string,
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content;
  if (content.includes(CORRECTION_MARKER)) return content;

  const actions = collectConfirmedPublishActions(toolCalls);
  if (actions.length === 0) return content;

  return `${content.replace(/\s+$/, '')}\n\n${buildConfirmedWorkNotice(actions)}`;
}

/**
 * ENG-1173: entity nouns whose QUANTITY the diagnosis agent can never know.
 *
 * The agent is handed `calledFunctions` — a histogram of tool-call counts — and
 * nothing else numeric. It has no `successCount`, no row count, no record count. So
 * every quantity of a record-like thing in its output is unfounded by construction,
 * whatever number it happens to be.
 */
const UNFOUNDED_COUNT_NOUNS = [
  'leads?', 'contacts?', 'prospects?', 'subscribers?',
  'records?', 'rows?', 'entries', 'items?',
  'posts?', 'emails?', 'messages?', 'campaigns?',
  'lists?', 'articles?', 'pages?', 'images?', 'files?',
].join('|');

const UNFOUNDED_COUNT_RE = new RegExp(
  String.raw`\b(?:(the|your|all|these|those)\s+)?\d[\d,]*\s+(${UNFOUNDED_COUNT_NOUNS})\b`,
  'gi',
);

/**
 * Remove entity quantities from diagnosis-agent prose.
 *
 * Production session 39eb5663 wrote 75 leads across three `add_leads_to_list` batches
 * and closed with "I have successfully added the 3 leads to your CRM list". The `3` is
 * `calledFunctions["add_leads_to_list"]` — the call count — and reading it as a lead
 * count is the only reasonable reading of what the prompt actually sent.
 *
 * This STRIPS rather than corrects, and that is the whole design: there is no
 * authoritative record count on this path to reconcile against, so the only honest
 * options are "no number" and "a number that might be wrong". A user told "added the
 * leads" goes and looks; a user told "added the 3 leads" believes it.
 *
 * Digits only. Spelled-out quantities ("three leads") are left alone deliberately —
 * the observed failure is numeric because the ledger is JSON, and word-matching would
 * mangle ordinary prose for no measured benefit.
 *
 * Point this ONLY at diagnosis-agent output. The main agent composes its closing from
 * real tool results and its counts ARE founded; stripping them there would destroy
 * true information.
 */
export function stripUnfoundedEntityCounts(content: string): string {
  if (typeof content !== 'string' || content.length === 0) return content;
  return content.replace(
    UNFOUNDED_COUNT_RE,
    (_match, determiner: string | undefined, noun: string) => `${determiner || 'the'} ${noun}`,
  );
}

/** Plain-language labels of every duplicate-unsafe data write confirmed this run. */
export function collectConfirmedDataWriteActions(
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of toolCalls) {
    // A name in this ledger is itself the confirmation that the call succeeded
    // (see ledgerFromSucceededFunctions); an entry carrying an error never counts.
    if (!entry || entry.error !== undefined) continue;
    if (!entry.name || !CONFIRMED_DATA_WRITE_TOOLS.has(entry.name)) continue;
    const label = DATA_WRITE_ACTION_LABELS[entry.name];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * A run can both publish AND write data. The publish reconciler runs first and stamps
 * CORRECTION_MARKER, and a bare `includes(CORRECTION_MARKER)` bail-out would then drop
 * the data-write warning entirely — the user is told not to re-run the deploy, and
 * nothing warns them off re-running the import that would duplicate records.
 *
 * So instead of yielding, extend the banner that is already there with the actions it
 * does not already name. Idempotent by construction: an action whose label is already
 * present is never re-added, so a second pass changes nothing.
 */
function extendExistingCorrection(
  content: string,
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string {
  const missing = collectConfirmedDataWriteActions(toolCalls)
    .filter((action) => !content.includes(action));
  if (missing.length === 0) return content;

  return (
    `${content.replace(/\s+$/, '')} It also ${missing.join('; ')} — that data is written `
    + 'and saved, so please do NOT re-run that either; a repeat can create duplicate records.'
  );
}

/** The visible correction appended after a confirmed, duplicate-unsafe data write. */
function buildDataWriteNotice(actions: string[]): string {
  return (
    `${CORRECTION_MARKER}, successfully: ${actions.join('; ')}. `
    + 'That data is written and saved, so please do NOT re-run it — a repeat import can '
    + 'create duplicate records. Check the list before retrying.'
  );
}

/**
 * ENG-1173: the data-write twin of `appendConfirmedPublishNotice`, for text the CALLER
 * already knows is generic.
 *
 * The fixed fallbacks ("I encountered an error … Please try sending your message
 * again", "The server restarted … Please send your message again") carry no outcome to
 * judge, just blanket retry advice — and that advice after a landed CRM import is the
 * same duplicate-record instruction this ticket is about. These strings are reached
 * whenever the diagnosis agent is unavailable, including its own 10s timeout, so the
 * path is not rare. Never point this at model-written prose: truthful text would
 * collect a "Correction" banner it does not deserve.
 */
export function appendConfirmedDataWriteNotice(
  content: string,
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content;
  if (content.includes(CORRECTION_MARKER)) return extendExistingCorrection(content, toolCalls);

  const actions = collectConfirmedDataWriteActions(toolCalls);
  if (actions.length === 0) return content;

  return `${content.replace(/\s+$/, '')}\n\n${buildDataWriteNotice(actions)}`;
}

/**
 * ENG-1173: the ENG-971 inversion, one seam over — a message denying work that a
 * confirmed CRM write actually completed.
 *
 * Same contract as `reconcileFalseFailureReport`: fires only when the text asserts
 * BOTH an interruption AND that the work was not saved, appends only what the ledger
 * confirms, and never rewrites the model's own words. Run this AFTER the publish
 * reconciler — the shared `CORRECTION_MARKER` makes whichever fires first win, and a
 * landed publish is the more expensive thing to re-run.
 */
export function reconcileFalseDataWriteFailure(
  content: string,
  toolCalls: FalseFailureLedgerEntry[] | null | undefined,
): string {
  if (typeof content !== 'string' || content.trim().length === 0) return content;
  // A publish correction is already here — extend it rather than drop the warning.
  if (content.includes(CORRECTION_MARKER)) return extendExistingCorrection(content, toolCalls);
  if (!assertsUnsavedInterruption(content)) return content;

  const actions = collectConfirmedDataWriteActions(toolCalls);
  if (actions.length === 0) return content;

  return `${content.replace(/\s+$/, '')}\n\n${buildDataWriteNotice(actions)}`;
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

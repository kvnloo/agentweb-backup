/**
 * PURE guard for a final turn that "answers" with serialization residue (ENG-1054).
 *
 * The core loop's only failed-synthesis check was `!content` (see core/termination.ts,
 * ladder step 3). That covers a turn that emitted NOTHING, but not a turn that emitted
 * structural JSON debris — observed in production as a closing assistant message whose
 * entire content was the two characters `}]`. Being non-empty, it satisfied the
 * `final_response` branch: the loop broke, the debris was persisted and shown to the
 * user, and every remaining deliverable of a 215-message run was lost. Worse, the run
 * had already applied money-affecting changes (paused ad campaigns), so the user was
 * left unable to tell what had executed — with a real risk of re-running it.
 *
 * Two pieces, both pure so they are cheap to test and cannot themselves fail a run:
 *   - `isUnusableSynthesis` — is this "answer" actually just serialization residue?
 *   - `buildExecutedActionsFallback` — a truthful recap built from the tool-call
 *     ledger, so a synthesis failure can never erase the record of what ran.
 */

import { SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE, STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE } from './termination';
import { buildTurnTimeBudgetNudge } from '../../../utils/turnTimeBudget';
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';

/**
 * Residue is short by nature — it is the tail of a structure the model failed to
 * finish emitting. Anything longer is far likelier to be real (if odd) output, so
 * the guard stays deliberately narrow rather than risk discarding a genuine answer.
 */
const MAX_RESIDUE_LENGTH = 40;

/**
 * Only JSON structural punctuation and whitespace. Deliberately NOT a general
 * "no letters" test: `...`, `—` and emoji-only replies are meaningful, and must
 * never be thrown away.
 */
const STRUCTURAL_ONLY = /^[\s{}[\],:"']+$/;

/**
 * The two markers `geminiNativeClient.toGeminiRequest` uses when it degrades an
 * unsigned tool call and its result into conversational text. They are OUR history
 * serialization, never something a user asked for, so a reply that opens with one
 * is the model transcribing its own context back instead of answering.
 *
 * This is the same ENG-1054 failure as `}]`, one step earlier: in the production
 * session, message 163 was a 20,081-char verbatim echo of the preceding tool result
 * (ending `…[Content truncated — full response in S3]}}`) shipped as the assistant's
 * answer. Length alone cannot catch it — the echo is enormous — so it is matched by
 * its opening marker instead.
 */
const HISTORY_ECHO_PREFIX = /^\[(?:Result of \S+:|Previously called )/;

/**
 * ENG-1224 (Variant B): the internal control-directive text this loop itself
 * injects as a budget nudge — see turnTimeBudget.ts's final-synthesis warning
 * ("...Do not call any more tools. Write your final answer NOW...") and the
 * step-budget warning ("Stop all searching/pagination immediately..."). Both
 * are OUR instructions TO the model, never something a user asked for.
 *
 * Production session d5898ffd (model gemini-3.1-flash-lite, under loop stress
 * after a tool error) echoed the injected instruction back verbatim as its
 * final answer instead of following it — the entire final turn was the literal
 * string "Do not call any more tools." A reply that opens with this phrasing is
 * the model parroting its own context, not answering, exactly like the history
 * echo above.
 *
 * Scoped to phrasing that actually appears in an injected nudge: "Do not call
 * any more tools" (`buildTurnTimeBudgetNudge`, `turnTimeBudget.ts`) and "Stop
 * all searching/pagination immediately" (the step-budget warning,
 * `agentModeService.ts`). Earlier revisions also matched "stop calling tools"
 * and "no more tool call(s)?", but no code path ever injects either phrase —
 * being anchored-and-short, they risked misclassifying a genuine final answer
 * that happens to open with similar wording as unusable synthesis.
 */
const INTERNAL_DIRECTIVE_ECHO_RE =
  /^(?:\[SYSTEM(?:\s+WARNING)?\]\s*)?(?:do\s*n[o']?t\s+call\s+any\s+(?:more|further)\s+tools|stop\s+all\s+searching(?:\s*\/\s*pagination)?)\b/i;

/**
 * ENG-1188: a gemini-3.1-pro-preview work-plan session generated and
 * screenshot-verified the corrected assets, then closed with the model echoing the
 * injected synthesis nudge back verbatim — 3 repeats in 744 chars — instead of
 * writing the delivery message. Non-empty and only 744 chars, it is far under
 * `isDegenerateRepetition`'s 1000-char/300-word floor (built for a much larger
 * collapse) and does not start with the history-echo marker above, so it slipped
 * past every existing check and shipped straight to the user.
 *
 * Two or more verbatim copies of a nudge WE injected is never a real answer — a
 * turn that merely quotes it once (e.g. explaining what the system told it) is
 * left alone; only actual repetition trips this.
 *
 * `isUnusableSynthesis` is the loop's ONE choke point for terminating content
 * (agentModeService.ts calls it exactly once, on whatever is about to ship), so
 * every string the loop pushes as a "respond again" nudge belongs in this list —
 * not just SYNTHESIS_NUDGE. CONTINUE_PROMPT (max_tokens continuation) and
 * ANTI_LOOP_STOP_MESSAGE (repeated-identical-tool-calls warning) are injected by
 * the exact same "push a system message, let the model respond again" mechanism,
 * so a collapse that echoes either of THOSE back is just as real a failure and was,
 * before this, just as unguarded.
 */
// ENG-2778: the step-cap forced-synthesis warning is loop-injected too; an echo of it is not an answer.
const INJECTED_NUDGES = [SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE, STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE];

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * ENG-907's wall-clock nudges (`buildTurnTimeBudgetNudge`, `turnTimeBudget.ts`) are
 * injected by this exact same mechanism, but each embeds a live remaining-seconds
 * count, so no two injections are byte-identical — the plain-string check above can
 * never match one. Rather than hand-copy the wording into a second, driftable
 * constant, generate a sample with a sentinel duration and turn IT into a pattern:
 * escape the sample for regex use, then widen the sentinel's digits back into
 * `\d+`. If the wording in turnTimeBudget.ts ever changes, this pattern changes
 * with it automatically.
 */
const TIME_BUDGET_SENTINEL_SECONDS = 918273;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTimeBudgetNudgePattern(kind: 'wrap_up' | 'final_synthesis'): RegExp {
  const sample = buildTurnTimeBudgetNudge(
    { phase: kind, elapsedMs: 0, remainingMs: TIME_BUDGET_SENTINEL_SECONDS * 1000, reserveMs: 0 },
    kind,
  );
  const source = escapeRegExp(sample).replace(String(TIME_BUDGET_SENTINEL_SECONDS), '\\d+');
  return new RegExp(source);
}

const TIME_BUDGET_NUDGE_PATTERNS = [
  buildTimeBudgetNudgePattern('wrap_up'),
  buildTimeBudgetNudgePattern('final_synthesis'),
];

/** Count non-overlapping matches of an anchorless pattern within `haystack`. */
function countPatternOccurrences(haystack: string, pattern: RegExp): number {
  const matches = haystack.match(new RegExp(pattern.source, 'g'));
  return matches ? matches.length : 0;
}

/**
 * True when `trimmed` is mostly one of our own injected nudges, echoed back. An
 * exact match — the entire turn is one bare copy of a nudge — is non-empty, so it
 * never re-triggers the retry ladder that injected it in the first place, and it
 * ships as a real final answer unless caught here alongside the 2+-repeat case.
 */
function isNudgeEcho(trimmed: string): boolean {
  if (
    INJECTED_NUDGES.some((nudge) => trimmed === nudge || countOccurrences(trimmed, nudge) >= 2)
  ) {
    return true;
  }
  return TIME_BUDGET_NUDGE_PATTERNS.some((pattern) => {
    const anchored = new RegExp(`^${pattern.source}$`);
    return anchored.test(trimmed) || countPatternOccurrences(trimmed, pattern) >= 2;
  });
}

/**
 * Degenerate-repetition thresholds. A model that collapses into a repetition loop
 * emits a huge message with almost no vocabulary: the live probe that drove the
 * ENG-1054 retry into this state produced 30,791 words built from just 65 unique
 * tokens (0.2% unique; `group` alone was 72.7% of it) and shipped all 180 KB of it
 * into the transcript.
 *
 * Genuine prose does not come close — even a repetitive status table runs 10-15%
 * unique — so the bar is set far below anything real and only applies to messages
 * long enough for the ratio to mean something. A false positive costs one synthesis
 * retry, never a silently dropped answer.
 */
const DEGENERATE_MIN_WORDS = 300;
const DEGENERATE_MAX_UNIQUE_RATIO = 0.03;

/** True when `trimmed` is a repetition collapse rather than an answer. */
function isDegenerateRepetition(trimmed: string): boolean {
  // 300 words cannot fit in fewer than ~1000 chars — skip the split for anything
  // shorter so the common case never pays for the scan.
  if (trimmed.length < 1000) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < DEGENERATE_MIN_WORDS) return false;
  return new Set(words).size / words.length < DEGENERATE_MAX_UNIQUE_RATIO;
}

/**
 * True when `content` is non-empty but carries no answer at all — either leftover
 * JSON structure such as `}]`, `},{` or `"}`, or a transcription of the loop's own
 * degraded tool history.
 *
 * Empty/whitespace content returns FALSE on purpose: that case already has its own
 * bounded handling in the termination ladder, and this guard must not change it.
 */
export function isUnusableSynthesis(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  // Checked before the length cap: a history echo, a nudge echo, a leaked
  // internal directive, and a repetition collapse are all either long by
  // nature or an intentionally short exact/prefix match.
  if (HISTORY_ECHO_PREFIX.test(trimmed)) return true;
  if (isNudgeEcho(trimmed)) return true;
  if (INTERNAL_DIRECTIVE_ECHO_RE.test(trimmed)) return true;
  if (isDegenerateRepetition(trimmed)) return true;
  if (trimmed.length > MAX_RESIDUE_LENGTH) return false;
  if (!STRUCTURAL_ONLY.test(trimmed)) return false;
  // Punctuation-only, but it might still be a COMPLETE value the user asked for:
  // `{}`, `[]` and `[{}]` are legitimate answers to "return an empty object" or
  // "show me the list". Residue is by definition the tail of a structure the model
  // never finished, so it does not parse — `}]`, `},{` and `"}` all fail here while
  // every complete value succeeds. Parsing is the exact discriminator, so use it
  // rather than discarding on shape alone.
  return !isCompleteJsonValue(trimmed);
}

/** True when `trimmed` is a whole, parseable JSON value rather than a fragment. */
function isCompleteJsonValue(trimmed: string): boolean {
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** The subset of a loop tool-call ledger entry this module reads. */
export interface ExecutedToolCall {
  name?: string;
  /** the loop sets an `error` key on a ledger entry whose tool threw */
  error?: unknown;
  /**
   * set by the dispatcher when this call was collapsed into an identical earlier
   * one. That earlier call is its own ledger entry, so counting this as well would
   * double-report a single action.
   */
  duplicateOf?: unknown;
  /**
   * a `{ deferred: true }` result means the call was NOT executed — the media
   * budget paused it for a later turn. It carries no `error`, so without its own
   * bucket it would be reported as an action that already ran.
   *
   * A `{ success: false }` result means the handler REPORTED failure by returning
   * rather than throwing. Only a throw reaches the dispatcher's error path
   * (toolDispatch.ts:440); a returned failure is pushed through the success path
   * (toolDispatch.ts:849) with no `error` key, so it too needs reading here.
   */
  result?: unknown;
}

/** Narrow an entry's `result` to an object we can read flags off. */
function resultFlags(call: ExecutedToolCall): { deferred?: unknown; success?: unknown } | null {
  const result = call.result as { deferred?: unknown; success?: unknown } | null | undefined;
  return result && typeof result === 'object' ? result : null;
}

/** True for a ledger entry the dispatcher deferred instead of executing. */
function isDeferred(call: ExecutedToolCall): boolean {
  return resultFlags(call)?.deferred === true;
}

/**
 * True for a call whose handler returned a failure instead of throwing one.
 *
 * Strictly `=== false`: most results have no `success` key at all, and treating a
 * missing flag as failure would under-report actions that really did apply — the
 * mirror-image error, and just as misleading on a recap the user is relying on.
 */
function isReportedFailure(call: ExecutedToolCall): boolean {
  return resultFlags(call)?.success === false;
}

/**
 * True for an `install_skills` call that installed SOME of what was asked for and had the
 * rest refused.
 *
 * That result carries `success: true` (something was installed), so every failure test above
 * reads it as a clean install — and a partial install is exactly the shape where the ONE skill
 * the gated tool needed is the one that was refused. Treating it as a clean success disarmed
 * the notice on the case it is most likely to be needed for.
 *
 * `rejectedSkillIds` is set by `agentModeService.installSkills` precisely so this is a fact in
 * the result rather than something inferred from prose in `message`.
 */
function isPartialInstall(call: ExecutedToolCall): boolean {
  const rejected = (call.result as { rejectedSkillIds?: unknown } | null | undefined)?.rejectedSkillIds;
  return Array.isArray(rejected) && rejected.length > 0;
}

/**
 * The tool names a rejected skill would have unlocked, per `installSkills` (agentModeService.ts)
 * resolving `rejectedSkillIds` before this reader ever sees them. Empty for any call that did
 * not carry the field — an unscoped throw, a legacy result shape, or a full subscription refusal
 * that never got as far as knowing which ids to look up.
 */
function getRejectedToolNames(call: ExecutedToolCall): string[] {
  const names = (call.result as { rejectedToolNames?: unknown } | null | undefined)?.rejectedToolNames;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}


/**
 * ENG-1188 root-cause fix recommendation #2: a ledger of tool NAMES and counts
 * told the user work happened, but not how to get it — "save_file — 1 succeeded"
 * is not a deliverable. `extractMinimalToolResult` (agentModeService.ts) already
 * preserves the URL on every asset-producing tool's result — save_file ->
 * file_url, create_html_file/create_html_from_template -> s3_url, generate_image
 * -> imageUrl, playwright_browser_take_screenshot -> screenshotUrl, generate_video
 * -> videoUrl, generate_voiceover -> audioUrl — so it is already sitting in the
 * ledger this module reads; nothing here ever looked at it.
 */
const ASSET_URL_FIELDS = ['file_url', 's3_url', 'imageUrl', 'screenshotUrl', 'videoUrl', 'audioUrl'] as const;

/** The URL on a succeeded call's result, checking every known asset field. */
function extractAssetUrl(call: ExecutedToolCall): string | null {
  const result = call.result as Record<string, unknown> | null | undefined;
  if (!result || typeof result !== 'object') return null;
  for (const field of ASSET_URL_FIELDS) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Tally the ledger into per-tool outcome counts, ignoring collapsed duplicates. */
function tallyExecutedActions(
  toolCalls: ExecutedToolCall[],
): Map<string, { ok: number; failed: number; deferred: number; urls: string[] }> {
  const counts = new Map<string, { ok: number; failed: number; deferred: number; urls: string[] }>();
  for (const call of toolCalls || []) {
    const name = call && typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) continue;
    // A collapsed duplicate never ran: the call it points at did, and is counted
    // separately. Including it would report the same action twice.
    if (call.duplicateOf !== undefined && call.duplicateOf !== null) continue;
    const entry = counts.get(name) || { ok: 0, failed: 0, deferred: 0, urls: [] };
    if ('error' in call || isReportedFailure(call)) {
      entry.failed++;
    } else if (isDeferred(call)) {
      entry.deferred++;
    } else {
      entry.ok++;
      // Only a succeeded call's URL is a real, fetchable asset — a failed call can
      // still carry a stale/partial URL field in its error payload, and reporting
      // that would hand the user a link to something that was never produced.
      const url = extractAssetUrl(call);
      if (url && !entry.urls.includes(url)) entry.urls.push(url);
    }
    counts.set(name, entry);
  }
  return counts;
}

/**
 * Every number in the recap counts TOOL CALLS, never records touched — and the two
 * are easy to confuse in exactly the situation the recap exists for. Session
 * 39eb5663 imported 75 leads as three 25-row batches and closed with "successfully
 * added the 3 leads": the run's batch count read as a record count. This recap would
 * render that same run as "add_leads_to_list — 3 succeeded", so it says outright
 * what the 3 refers to rather than leaving the reader to guess.
 */
const COUNT_BASIS_NOTE =
  '(Counts are tool calls, not the number of records created or changed.)';

/** Render the `- tool — n succeeded, n failed` lines (plus asset URLs) for a tally. */
function renderLedgerLines(
  counts: Map<string, { ok: number; failed: number; deferred: number; urls: string[] }>,
): string {
  const lines: string[] = [];
  for (const [name, { ok, failed, deferred, urls }] of counts) {
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} succeeded`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (deferred > 0) parts.push(`${deferred} not run (paused for budget)`);
    lines.push(`- ${name} — ${parts.join(', ')}`);
    for (const url of urls) lines.push(`  ${url}`);
  }
  return lines.join('\n');
}

/**
 * Recap to APPEND when a turn's synthesis broke once and the retry then produced
 * text (ENG-1054).
 *
 * The gate here used to be either/or: any text at all from the retry suppressed the
 * ledger completely. But "did the model emit characters?" is not "did the model
 * answer" — a retry that returns a fragment, or drifts, satisfied it and the record
 * of what had executed was lost anyway. Classifying the retry's prose as good-or-bad
 * is the wrong tool: it is unbounded, and any false positive discards a real answer.
 *
 * So do not choose. Keep whatever the model wrote AND state what ran underneath it.
 * On a recovered turn that costs a few honest lines; on a turn where the retry
 * drifted it is the difference between the user knowing their campaigns were paused
 * and not knowing. This is the ticket's own recommendation — a synthesis failure
 * must not be able to erase the record of executed actions.
 *
 * Returns null when there is nothing to report, so nothing is appended.
 */
export function buildExecutedActionsFooter(toolCalls: ExecutedToolCall[]): string | null {
  const counts = tallyExecutedActions(toolCalls);
  if (counts.size === 0) return null;

  const closing = countsInclude(counts, 'ok')
    ? " The ones marked “succeeded” have already been applied — please don't re-run them."
    : '';

  return [
    '---',
    "*Part of my reply for this turn didn't come through correctly, so for completeness, here is what I actually ran:*",
    '',
    renderLedgerLines(counts),
    '',
    `${closing} ${COUNT_BASIS_NOTE}`.trim(),
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n').trim();
}

/** True when any tool in the tally has at least one call in `bucket`. */
function countsInclude(
  counts: Map<string, { ok: number; failed: number; deferred: number; urls: string[] }>,
  bucket: 'ok' | 'failed' | 'deferred',
): boolean {
  for (const entry of counts.values()) if (entry[bucket] > 0) return true;
  return false;
}

/**
 * ENG-1331: a work-plan session generated and screenshot-exported only 4 of 12
 * requested display-ad sizes, then closed with "all 12 sizes have been rendered,
 * QA'd, and saved" — fluent, well-formed prose, not the junk `isUnusableSynthesis`
 * above exists to catch. The closing message was built from INTENT ("render all
 * 12") rather than from what actually ran, so a claim like this reads as a normal
 * answer and ships straight to the user.
 *
 * `detectFalseCompletionClaim` is the orthogonal truth check: instead of judging
 * whether the text looks like an answer, it parses any explicit numeric completion
 * claim ("all N <asset noun>", "N of N", "N/N") out of the content and compares it
 * against the ledger's actual count of succeeded asset-producing tool calls.
 *
 * `toolCalls` holds every call made THIS TURN, but "this turn" is not "this step":
 * in an AUTOCOMPLETE-mode work-plan session the whole loop — including every
 * `set_work_plan_status` call between steps/variants — runs inside one turn, so a
 * multi-variant turn can carry several steps' worth of successful assets in one
 * ledger. Comparing a claim about the LATEST step/variant ("all 12 sizes for
 * Variant 4") against the WHOLE ledger reproduces the exact ENG-1188 masking bug on
 * this new mechanism: variants 1-3's already-succeeded renders paper over variant
 * 4's shortfall, and the guard built to catch that shortfall goes silent on it.
 * `sinceLastStepBoundary` below scopes the count to calls made after the last
 * completed/skipped `set_work_plan_status` in the ledger, mirroring the `sinceIso`
 * cutoff agentModeService.ts already uses for the `expectedAssetCount` gate — same
 * idea, expressed as a ledger-index cut since this pure module only ever sees one
 * turn's tool-call array in call order, not the session messages `sinceIso` reads
 * timestamps from.
 */
const ASSET_NOUN = '(?:sizes?|images?|banners?|ads?|assets?|variants?|creatives?|renders?|screenshots?|photos?|videos?|templates?|graphics?)';

/**
 * Appends the same "an asset noun follows within a few words" requirement
 * `ALL_N_NOUN_PATTERN` already used, onto any other numeric-claim core pattern. Live
 * repro: without this, N_OF_N/N_SLASH_N matched an unrelated same-number ratio —
 * "10 of 10 pages", "3/3 of the brief" — and misread it as an asset-completion
 * claim. `ALL_N_NOUN_PATTERN` never had that hole because it always required a noun;
 * the other two patterns need the identical suffix, not a separate ad-hoc check.
 */
function withNounProximity(coreSource: string): string {
  return `${coreSource}(?:\\s+\\S+){0,6}?\\s+${ASSET_NOUN}\\b`;
}

/** "all 12 sizes", "all 12 of the requested display sizes" (up to 6 words between). */
const ALL_N_NOUN_PATTERN = new RegExp(withNounProximity('\\ball\\s+(\\d+)'), 'gi');
/** "12 of 12 banners" — the backreference requires the SAME number twice, so "4 of 12" never matches. */
const N_OF_N_PATTERN = new RegExp(withNounProximity('\\b(\\d+)\\s+of\\s+\\1'), 'gi');
/** "12/12 images". */
const N_SLASH_N_PATTERN = new RegExp(withNounProximity('\\b(\\d+)\\s*\\/\\s*\\1'), 'gi');

const ASSET_PRODUCING_TOOL_NAMES = new Set([
  'generate_image',
  'generate_video',
  'generate_voiceover',
  'create_html_file',
  'create_html_from_template',
  'save_file',
  'playwright_browser_take_screenshot',
]);

/**
 * The tool that closes a work-plan step/variant (`set_work_plan_status`) is
 * recorded in this same per-turn ledger, so a completed/skipped call to it is a
 * real boundary between "the previous step's work" and "this step's work".
 */
const STEP_BOUNDARY_TOOL_NAME = 'set_work_plan_status';

/**
 * True for a successful, actually-executed (not errored, not reported-failed,
 * not a same-turn duplicate) step-boundary call.
 *
 * CodeRabbit (ENG-1331 follow-up): a `set_work_plan_status` call the dispatcher
 * collapsed as a duplicate of an earlier identical one (`duplicateOf` set) never
 * ran — the call it points at is the real boundary and is its own ledger entry.
 * Counting the duplicate too could point `sinceLastStepBoundary` at a boundary
 * that only APPEARS to be the last one in array order, double-counting or
 * mis-scoping around it. Mirrors `tallyExecutedActions`' existing `duplicateOf`
 * exclusion elsewhere in this file — same rule, same reason.
 */
function isSuccessfulBoundary(call: ExecutedToolCall | undefined): boolean {
  if (!call || call.name !== STEP_BOUNDARY_TOOL_NAME) return false;
  if ('error' in call || isReportedFailure(call)) return false;
  if (call.duplicateOf !== undefined && call.duplicateOf !== null) return false;
  return true;
}

/**
 * Slices `toolCalls` down to the assets that back a claim about the step/variant
 * the CLOSING SYNTHESIS is describing.
 *
 * Two distinct shapes reach this function, and they need opposite scoping:
 *
 *  - A not-yet-closed step still being described (e.g. "12 sizes for Variant 4"
 *    written before Variant 4's own set_work_plan_status call, or never followed
 *    by one at all): the last successful boundary belongs to an EARLIER,
 *    already-closed step, so its own preceding assets must be excluded — scope to
 *    AFTER that boundary. This is the original ENG-1188 masking-prevention case:
 *    an earlier variant's 40 successful renders must never paper over a later
 *    variant's shortfall.
 *
 *  - A step that just closed ITSELF in this same turn (the last ledger entry IS
 *    the successful set_work_plan_status call, with nothing after it): the
 *    closing synthesis is necessarily describing the work THAT call just closed,
 *    so THOSE preceding assets are exactly what the claim is about — scope to
 *    AFTER the boundary BEFORE that one instead (or the whole ledger, if this is
 *    the only boundary). Getting this wrong made a step that genuinely finished
 *    all N assets and validly closed itself read as producing zero — a live
 *    false-UNDERCLAIM bug (CodeRabbit, ENG-1331 follow-up) on top of the
 *    over-claim bug this module was built to catch in the first place.
 *
 * "Nothing after it" is what distinguishes the two — but "nothing" means no
 * MEANINGFUL call, not literally no ledger entries. A same-turn duplicate of the
 * boundary itself (the model re-emits an identical set_work_plan_status; the
 * dispatcher collapses the second one with `duplicateOf` set) trailing the real
 * close is not new work — it never ran — so it must not make a genuinely
 * self-closing step look like it has "a not-yet-closed step's" shape and get
 * mis-scoped back to empty (CodeRabbit, ENG-1331 follow-up, second pass: found by
 * live-tracing the first duplicateOf fix rather than trusting it).
 */
function sinceLastStepBoundary(toolCalls: ExecutedToolCall[]): ExecutedToolCall[] {
  const isDuplicateEntry = (call: ExecutedToolCall | undefined): boolean =>
    !!call && call.duplicateOf !== undefined && call.duplicateOf !== null;

  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (!isSuccessfulBoundary(toolCalls[i])) continue;
    if (toolCalls.slice(i + 1).every(isDuplicateEntry)) {
      for (let j = i - 1; j >= 0; j--) {
        if (!isSuccessfulBoundary(toolCalls[j])) continue;
        return toolCalls.slice(j + 1);
      }
      return toolCalls;
    }
    return toolCalls.slice(i + 1);
  }
  return toolCalls;
}

/**
 * Without `tools`: the largest succeeded-call count among the known
 * asset-producing tools in the ledger — NOT a sum across tool names. A step like
 * "Render the Full Size Matrix" (requiredFunctionCalls: create_html_file +
 * playwright_browser_take_screenshot) builds a FEW reusable HTML templates and
 * takes MANY per-size screenshots from them; both tools are legitimately part of
 * "this step's work", but they are not interchangeable units of the same
 * deliverable. Summing them would let, e.g., 5 create_html_file calls + 7
 * screenshots satisfy an expectedAssetCount of 12 while only 7 of the 12 requested
 * sizes were actually rendered — the same "claimed count met by padding across
 * unrelated calls" failure this module exists to catch, just introduced by ITS OWN
 * counting instead of the model's prose. Max still correctly reports 12 when a
 * step genuinely produces 12 of its primary deliverable, whichever single tool
 * that turns out to be — the safe default for a step that hasn't said which tool
 * is "the N things".
 *
 * With `tools`: sums successes across exactly those tool names instead. The step
 * author has already resolved the ambiguity max exists to guard against — e.g. a
 * step whose N deliverables are genuinely split across two tools (some images,
 * some videos) — so summing the ones they named is correct, not padding.
 */
function countProducedAssets(toolCalls: ExecutedToolCall[], tools?: ReadonlySet<string>): number {
  const counts = tallyExecutedActions(toolCalls);
  if (tools) {
    let sum = 0;
    for (const [name, { ok }] of counts) {
      if (tools.has(name)) sum += ok;
    }
    return sum;
  }
  let max = 0;
  for (const [name, { ok }] of counts) {
    if (ASSET_PRODUCING_TOOL_NAMES.has(name)) max = Math.max(max, ok);
  }
  return max;
}

/** Minimal shape of a persisted assistant message this reads — mirrors the
 * identical local interface `seedMediaCallKeysFromHistory` (toolDispatch.ts) already
 * uses to reconstruct tool calls from `session.messages`. */
interface HistoryMessageLike {
  role?: string;
  timestamp?: string;
  metadata?: {
    timestamp?: string;
    toolCalls?: ExecutedToolCall[];
  } | null;
}

/**
 * ENG-1331: the work-plan step completion gate's asset counter
 * (`AgentModeService.extractGeneratedImageFilenames`) only recognizes the
 * system-message marker `generate_image` emits — a step whose deliverable is
 * Playwright-rendered screenshots (`create_html_file` +
 * `playwright_browser_take_screenshot`, no `generate_image` call at all) can never
 * satisfy it, so the ENG-1188 xCures completion gate stays silently blind to
 * exactly the failure mode production hit here (4 of 12 screenshots rendered, the
 * step still marked completed). This counts every `ASSET_PRODUCING_TOOL_NAMES`
 * success across `session.messages` instead of one tool's marker — the same ledger
 * this module already reads for the synthesis-claim check above, so both
 * mechanisms agree on what "an asset was produced" means.
 *
 * Scoped by `sinceIso` exactly like `extractGeneratedImageFilenames`: only calls
 * from a message timestamped at or after the cutoff count, so an earlier step's
 * assets never satisfy a later step's requirement. Per-message granularity (not
 * per-call) matches `seedMediaCallKeysFromHistory`'s existing precedent for reading
 * this same persisted shape.
 *
 * `tools` (ENG-1331), when the caller has one (a work-plan step's
 * `expectedAssetCountTools`), is forwarded to `countProducedAssets` as-is — sum
 * those specific tools instead of taking the max across every producing tool.
 * Omit it to keep the safe max-based default.
 */
export function extractProducedAssetCount(
  messages: HistoryMessageLike[] | undefined | null,
  sinceIso?: string,
  tools?: readonly string[],
): number {
  if (!Array.isArray(messages)) return 0;
  const toolSet = tools && tools.length > 0 ? new Set(tools) : undefined;
  let total = 0;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const toolCalls = message.metadata?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const timestamp = message.timestamp || message.metadata?.timestamp;
    if (sinceIso && timestamp && timestamp < sinceIso) continue;
    total += countProducedAssets(toolCalls, toolSet);
  }
  return total;
}

export interface FalseCompletionClaim {
  /** The largest numeric completion claim found in the content. */
  claimed: number;
  /** The ledger's actual count of succeeded asset-producing tool calls. */
  actual: number;
}

/**
 * Returns the claim/actual mismatch when `content` asserts a numeric completion
 * ("all 12 sizes", "12 of 12", "12/12") that the ledger cannot back up, or `null`
 * when there is no such claim or the ledger meets or exceeds it. A claim that
 * already admits a shortfall (e.g. "4 of the 12 requested sizes") does not match
 * any of these patterns, so an honest partial report is never flagged.
 *
 * `scopeToLastStepBoundary` (default true) restricts the ledger to
 * `sinceLastStepBoundary` before counting — correct for the single-turn closing
 * synthesis this was built for (ENG-1188: an earlier variant's successes must not
 * paper over a later variant's shortfall). A caller summarizing an entire
 * multi-step session (CodeRabbit, ENG-1331 follow-up) needs the OPPOSITE: a
 * truthful claim about assets produced across several already-closed steps would
 * be scoped down to "since the last set_work_plan_status" and misread as false
 * whenever the currently-open step hasn't produced anything yet. Pass `false` to
 * count the whole ledger instead.
 */
export function detectFalseCompletionClaim(
  content: unknown,
  toolCalls: ExecutedToolCall[],
  scopeToLastStepBoundary: boolean = true,
): FalseCompletionClaim | null {
  if (typeof content !== 'string' || !content.trim()) return null;

  const claims = new Set<number>();
  for (const pattern of [ALL_N_NOUN_PATTERN, N_OF_N_PATTERN, N_SLASH_N_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // A count of existing ads is not a claim that this turn produced them.
      // Require a production predicate attached to the count, not a word such
      // as "generated" elsewhere in an analytics answer ("generated leads").
      // Inspect bounded predicate context per match, not the entire prefix and
      // suffix (quadratic on long lists). Sentinels prevent a truncated word or
      // suffix from becoming an artificial word/sentence boundary.
      const beforeStart = Math.max(0, match.index - 160);
      const before = ((beforeStart > 0 ? 'x' : '') + content.slice(beforeStart, match.index)).split(/[.!?\n]/).pop() || '';
      const afterStart = match.index + match[0].length;
      const afterEnd = Math.min(content.length, afterStart + 256);
      const after = (content.slice(afterStart, afterEnd) + (afterEnd < content.length ? 'x' : '')).split(/[.!?\n]/)[0];
      const producedBefore = /\b(?:generated|created|rendered|delivered|produced|exported|saved)\s*$/i.test(before);
      // The verb may end the sentence, introduce a list ("generated:"), or point
      // at one ("generated below"). "are ready" / "are done" claim the same thing
      // with no production verb at all.
      const verbAfter = /^\s*(?:(?:have|has)\s+been\s+|(?:were|was|are|is)\s+)?(?:successfully\s+)?(generated|created|rendered|delivered|produced|exported|saved)(?:\s+successfully)?(?=\s*(?:$|[,;:]|and\b|for\b|below\b|above\b|here\b))/i.exec(after);
      // "4 of 4 ads delivered" is Meta delivery status, not an asset this turn made.
      const adDelivery = !!verbAfter && verbAfter[1].toLowerCase() === 'delivered' && /\b(?:ads?|campaigns?|ad\s+sets?)$/i.test(match[0]);
      const producedAfter = (!!verbAfter && !adDelivery)
        || /^\s*(?:(?:have|has)\s+been\s+|(?:were|was|are|is)\s+)(?:all\s+)?(?:now\s+)?(?:ready|done|complete|completed|finished|attached)\b/i.test(after)
        || /^\s+for\b[^.!?\n]{0,120}\b(?:were|was|have been)\s+(?:generated|created|rendered|delivered|produced|exported|saved)\b/i.test(after);
      if (!producedBefore && !producedAfter) continue;
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) claims.add(n);
    }
  }
  if (claims.size === 0) return null;

  const claimed = Math.max(...claims);
  const scopedToolCalls = scopeToLastStepBoundary ? sinceLastStepBoundary(toolCalls) : toolCalls;
  const actual = countProducedAssets(scopedToolCalls);
  if (actual >= claimed) return null;
  return { claimed, actual };
}

/**
 * ENG-2076: whether `detectFalseCompletionClaim`'s domain (image/video/HTML-template
 * generation) is actually in play THIS turn — i.e. whether `toolCalls` contains at
 * least one call to `ASSET_PRODUCING_TOOL_NAMES`. Callers should skip the guard
 * entirely when this is false.
 *
 * Deliberately turn-scoped only — an earlier revision of this fix also treated a
 * session's persisted `calledFunctions` (an asset tool used in a PRIOR turn) as
 * enough to let the guard run, on the theory that it would widen coverage. It does
 * the opposite: `detectFalseCompletionClaim`'s `actual` is unconditionally computed
 * from `toolCalls` (this turn only — see `countProducedAssets` above), never from
 * history. So gating on session history while still computing `actual` from an empty
 * this-turn ledger reproduces the exact ENG-2076 bug one level up: a session that
 * generated real images earlier and later TRUTHFULLY recaps that true count on a
 * turn with no new tool calls (a normal "what's next" follow-up) would get told
 * "0 of N were actually produced" again — just gated to media-generating sessions
 * instead of firing on every session. Turn-scoped-only avoids that: a recap turn
 * with zero matching tool calls skips the check entirely, exactly as it does for the
 * live ENG-2076 repro (a Meta Ads session recapping "3 creatives created" on a turn
 * that made no tool calls at all — a clarifying question, not new work), while a
 * turn that DOES call an asset-producing tool (the original ENG-1188/ENG-1331
 * same-turn shortfall: N screenshots claimed, fewer actually taken) still runs the
 * check exactly as before.
 */
export function assetProducingToolsInPlay(toolCalls: ExecutedToolCall[]): boolean {
  return toolCalls.some((call) => typeof call.name === 'string' && ASSET_PRODUCING_TOOL_NAMES.has(call.name));
}

/**
 * Correction to APPEND when `detectFalseCompletionClaim` finds a claim the ledger
 * cannot back up. Keeps the model's original prose (it may still hold other real,
 * useful detail) but states the real count and the named shortfall right underneath
 * it, so the user is never left believing more happened than actually did.
 *
 * Scoped to the same `sinceLastStepBoundary` slice `detectFalseCompletionClaim`
 * used to compute `claim.actual` — showing a wider ledger here would contradict the
 * very count the correction is stating (e.g. "only 4 of 12" next to a list that
 * includes 40 unrelated successes from earlier steps).
 */
/**
 * A line stating, as fact, that a capability could not run this turn — or null when every tool
 * that was refused later succeeded.
 *
 * PREPENDED by the caller, and deliberately UNCONDITIONAL rather than gated on detecting a false
 * claim in the prose. Both of those are the lessons from the live case this exists for: a
 * delegated session where the skill gate refused `audit_ad_utm_coverage`, `install_skills` was
 * refused by subscription, and the model then ran an unrelated AD LIST and presented a confident
 * "UTM Tagging Audit Summary — PASS, 6/6 ads tagged" table built from it. A correction WAS
 * produced by `buildFalseClaimCorrectionFooter` — but appended below the fabricated table, and
 * only because that particular claim happened to carry a checkable number.
 *
 * So this does not try to decide whether the answer claims the tool ran. Whether a tool was
 * refused by the gate and never afterwards succeeded is a FACT already in the ledger, needing no
 * inference, so it cannot false-positive: it only ever states something that definitively
 * happened. And a claim phrased in a way no detector anticipates is exactly the case a
 * conditional guard misses, which is why this one is not conditional.
 *
 * Redundant when the model was already honest about it. That is the cheap direction to be wrong.
 */
export function buildUnavailableCapabilityNotice(toolCalls: ExecutedToolCall[]): string | null {
  const calls = toolCalls ?? [];

  /*
   * Fires only when the model ATTEMPTED to obtain the capability and could not.
   *
   * Three failure modes this narrowing exists for, all found in review:
   *
   *  - The gate refuses ANY name not in the session's allowed set, including one the model tried
   *    speculatively and then simply did without. Warning there puts a banner above a perfectly
   *    correct answer, and a warning that appears when nothing is wrong is one people learn to
   *    skip — exactly when it finally matters. If no install was attempted, the model was not
   *    blocked from something it needed.
   *  - An install that FAILED is not always shaped as a throw: `installSkills` NEVER throws —
   *    every one of its paths returns `{ success: false, message }`. In today's wiring the
   *    dispatcher's `toolResultError` downgrade does convert that into a ledger `error`, so the
   *    throw check happens to catch it; `isReportedFailure` reads the returned shape directly
   *    so this does not silently depend on that downgrade staying wired.
   *  - A PARTIAL install reports `success: true` because SOMETHING installed, while the skill
   *    the gated tool needed may be the one that was refused (`isPartialInstall`). Nothing
   *    upstream flags this one: no error is raised, because from installSkills' point of view
   *    the call succeeded.
   *
   * Note what is deliberately NOT required: that the install came AFTER the refusal, or even
   * that no install this turn succeeded. Both used to be enforced via a ledger-index comparison
   * (`installSucceededAfter > i`), which is meaningless: `executePreparedTools` (toolDispatch.ts)
   * always appends Phase 1 preflight failures — which is what a skill-gate refusal is — before
   * any Phase 3 executed result, including every `install_skills` outcome, regardless of the
   * order the model emitted the calls in. So an index comparison could never see a gate refusal
   * as coming AFTER a successful install; on the real incident shape (a refusal plus ANY
   * install_skills call, failed or not) it would only ever suppress the notice, never correctly
   * arm it — including when the turn also contains an install failure that is the actual cause.
   *
   * A per-tool "did the skill THIS tool needed actually arrive" check is possible on a PARTIAL
   * install: `installSkills` resolves its `rejectedSkillIds` to the tool names they would have
   * unlocked (`rejectedToolNames`, agentModeService.ts) precisely so this reader does not have
   * to guess. When that field is present, only a gated tool whose name is actually in it counts
   * as still unavailable — a failure over here does not arm the notice for an unrelated tool B
   * whose own skill installed fine.
   *
   * A full refusal (subscription-blocked, no valid ids at all) carries no such mapping — nothing
   * in the ledger says which tool names the model was after. For that shape only, this falls
   * back to turn-global: any install failure with no name info arms the notice for every gated
   * tool in the turn. A redundant banner on a turn that in fact recovered is the cheap direction
   * to be wrong; silently hiding a real gap is not.
   */
  let installAttempted = false;
  let installFailed = false;
  let unscopedInstallFailure = false;
  const rejectedToolNames = new Set<string>();
  calls.forEach((call) => {
    if (call?.name !== 'install_skills') return;
    installAttempted = true;
    const threw = call?.error !== undefined && call?.error !== null;
    if (threw || isReportedFailure(call) || isPartialInstall(call)) {
      installFailed = true;
      const names = getRejectedToolNames(call);
      if (names.length > 0) {
        names.forEach((n) => rejectedToolNames.add(n));
      } else {
        unscopedInstallFailure = true;
      }
    }
  });

  const succeeded = new Set<string>();
  for (const call of calls) {
    const name = typeof call?.name === 'string' ? call.name : '';
    if (!name) continue;
    const threw = call?.error !== undefined && call?.error !== null;
    if (!threw && !isReportedFailure(call)) succeeded.add(name);
  }

  const unavailable = new Set<string>();
  calls.forEach((call) => {
    const name = typeof call?.name === 'string' ? call.name : '';
    if (!name || call?.error === undefined || call?.error === null) return;
    const err = call.error instanceof Error ? call.error : new Error(String(call.error));
    if (classifyToolErrorClass(err) !== 'tool_unavailable') return;
    /*
     * The INSTALLER is never itself the missing capability (ENG-1795). This notice exists to
     * say "the tool you were expecting output from did not run"; `install_skills` did run, and
     * refused — naming it here tells the user a tool was unavailable when what actually
     * happened is that it worked and reported a reason.
     *
     * Load-bearing, though no longer for install_skills' OWN refusals — those now classify
     * `skill_install_refused` and never reach this filter. Four other install_skills failures
     * still classify `tool_unavailable`, because the classifier matches the bare tool name
     * inside the message: a gateway policy block, the repeated-failure breaker, an excludeTools
     * removal, and a timeout. Any of them would otherwise name install_skills in a banner as a
     * capability that "did not run".
     */
    if (name === 'install_skills') return;
    // Ran successfully at some point in the turn — the capability is present.
    if (succeeded.has(name)) return;
    // Never tried to obtain it: doing without a speculative tool is not a missing capability.
    if (!installAttempted) return;
    // Every install this turn came back clean, so nothing stopped the model from getting what
    // it asked for. Only an install that could NOT deliver means a capability was missing.
    if (!installFailed) return;
    // A failure this turn was scoped to specific tool names (a partial install) and THIS tool
    // is not among them — some other skill was refused, not the one this tool needed. Only an
    // unscoped failure (no name info at all) falls back to arming every gated tool.
    if (rejectedToolNames.size > 0 && !rejectedToolNames.has(name) && !unscopedInstallFailure) return;
    unavailable.add(name);
  });

  if (unavailable.size === 0) return null;
  const names = [...unavailable].sort();
  const one = names.length === 1;
  return (
    `⚠️ ${one ? 'This capability was' : 'These capabilities were'} not available this turn and did not run: ` +
    `${names.map((n) => `\`${n}\``).join(', ')}. ` +
    `Anything below that would normally come from ${one ? 'it' : 'them'} was not produced by ${one ? 'that tool' : 'those tools'}.`
  );
}

/** Shape of the fields `coding_agent`'s own result carries through to the ledger — see
 *  `codingAgentService.ts`'s `AcceptanceStatus`/`AcceptanceVerificationResult` for the source of
 *  truth; duplicated narrowly here rather than imported so this module stays free of a dependency
 *  on a specific tool's service file, matching how the rest of this file reads `call.result`. */
interface CodingAgentResultShape {
  acceptanceStatus?: string;
  acceptance?: {
    checks?: Array<{ label?: string; status?: string; message?: string }>;
  };
}

function codingAgentResult(call: ExecutedToolCall): CodingAgentResultShape | null {
  if (call?.name !== 'coding_agent') return null;
  const result = call.result as CodingAgentResultShape | null | undefined;
  return result && typeof result === 'object' ? result : null;
}

/**
 * Stable, unique substring identifying this notice — used both to build the banner and, below, to
 * detect one already present in `content` before prepending another. Kept as one constant so the
 * two can never drift apart.
 */
const ACCEPTANCE_FAILURE_MARKER = 'VERIFICATION FAILED — coding_agent';

/**
 * ENG-1899. `coding_agent`'s own deterministic acceptance checks are real — they run against the
 * actual preview URL, not the model's opinion of it — and `codingAgentService.ts` already forces
 * `success: false` when they fail. But the human-readable `message` it returns is built as
 * `${result.message}\n\n${acceptance.summary}...` — a concatenation that puts the MODEL's own
 * original claim first and the real verification failure after. A live incident (ENG-1899): the
 * model reported "visual verification passed with screenshot" while its own `selector_exists`
 * check had failed and the button copy it described matched neither the brief nor the deployed
 * page. The failure was always present in `acceptanceStatus`/`acceptance` on the ledger entry —
 * nothing downstream read it before this.
 *
 * Same fix shape as `buildUnavailableCapabilityNotice` above, for the same reason:
 * UNCONDITIONAL — this states a fact already in the ledger (a specific check failed), never tries
 * to detect that the model's prose claims success, so a claim phrased in a way no detector
 * anticipated (exactly what happened live) cannot slip through. And it is PREPENDED — the true
 * state must be seen before the model's own possibly-false claim, not after it, or the same
 * anchoring effect that produced the original incident this module exists for repeats here.
 *
 * `currentContent` (optional) is the text this notice is about to be prepended to. Found live on
 * env1 (not a hypothetical): a session that hits two consecutive coding_agent failures — the
 * ORIGINAL ENG-1899 incident's own shape — can have the model's second completion echo its own
 * prior (already-decorated) turn from conversation history, so the banner appears twice: once
 * copied by the model, once freshly prepended here. This function still ran exactly once per call
 * (confirmed live via container logs); the model supplied the duplicate.
 *
 * Independent-review finding: an earlier revision suppressed on any occurrence of the bare marker
 * PHRASE anywhere in `currentContent` — which also fires when the model's prose merely recaps an
 * OLDER, different failure (e.g. "last time you saw: ⚠️ VERIFICATION FAILED..."), silently
 * swallowing a genuinely new, currently-real failure this same turn. That is the expensive
 * direction to be wrong — a live problem going unreported — not the cheap one. Fixed by computing
 * the full notice text FIRST and only suppressing when `currentContent` already contains that
 * EXACT string: a real echo of this turn's own notice reproduces it verbatim (same failed checks,
 * same messages), while a different or new failure produces different text that won't match.
 *
 * Returns null when no `coding_agent` call this turn has a real failure — a `'passed'` result, a
 * `'not_run'` result (no acceptance checks configured), or no `coding_agent` call at all — or when
 * `currentContent` already contains this exact notice verbatim. Redundant when the model was
 * already honest about it (or already showing this exact notice); that is the cheap direction to
 * be wrong.
 */
export function buildAcceptanceFailureNotice(
  toolCalls: ExecutedToolCall[],
  currentContent?: string,
): string | null {
  const calls = toolCalls ?? [];
  const failures: Array<{ summaryLine: string }> = [];

  // Independent review finding (ENG-1899): a failure isn't still true once a LATER
  // coding_agent call in the same turn passed. The tool's own contract ("call
  // coding_agent ONCE per user request unless it explicitly fails") means a second
  // call in the same turn is a retry of the same request, and `acceptance.checks`
  // re-verifies the full configured set fresh each call, not incrementally — so a
  // later 'passed' result is a complete, current statement that nothing is broken
  // anymore. Reporting the earlier, now-superseded failure would itself be exactly
  // the "stale claim contradicts current true state" defect this notice exists to
  // prevent. No per-call target id (e.g. page_id) is threaded onto the ledger, so
  // this can't distinguish "retried the same page" from "edited a different page
  // that happens to pass" — accepted, since the tool's contract treats same-turn
  // calls as sequential attempts at one request, not independent parallel targets.
  calls.forEach((call, index) => {
    const result = codingAgentResult(call);
    if (!result) return;
    if (result.acceptanceStatus !== 'failed' && result.acceptanceStatus !== 'blocked') return;

    const supersededByLaterPass = calls.slice(index + 1).some((laterCall) => {
      const laterResult = codingAgentResult(laterCall);
      return laterResult?.acceptanceStatus === 'passed';
    });
    if (supersededByLaterPass) return;

    const failedChecks = (result.acceptance?.checks ?? []).filter((c) => c.status !== 'passed');
    const checkLines = failedChecks.length > 0
      ? failedChecks.map((c) => `  - ${c.label ?? 'check'}: ${c.message ?? 'failed'}`).join('\n')
      : '  - (no per-check detail was returned)';
    failures.push({ summaryLine: checkLines });
  });

  if (failures.length === 0) return null;

  const plural = failures.length > 1;
  const notice = (
    `⚠️ ${ACCEPTANCE_FAILURE_MARKER}'s own acceptance check${plural ? 's did' : ' did'} not ` +
    `pass this turn, so the change below may not actually be live or correct even if it is ` +
    `described as done:\n` +
    failures.map((f) => f.summaryLine).join('\n') +
    `\n\nTreat the summary that follows as the model's own unverified account of what it did, not ` +
    `as confirmed fact — it may describe a state that does not match what is actually deployed.`
  );

  if (typeof currentContent === 'string' && currentContent.includes(notice)) {
    return null;
  }

  return notice;
}

export function buildFalseClaimCorrectionFooter(
  claim: FalseCompletionClaim,
  toolCalls: ExecutedToolCall[],
): string {
  const counts = tallyExecutedActions(sinceLastStepBoundary(toolCalls));
  const ledgerLines = counts.size > 0 ? renderLedgerLines(counts) : '(No assets were actually produced.)';

  return [
    '---',
    `⚠️ *Correction: the "${claim.claimed}" figure above is not accurate — only ${claim.actual} of ${claim.claimed} were actually produced this turn; the rest were never generated.* Here is what actually ran:`,
    '',
    ledgerLines,
    '',
    COUNT_BASIS_NOTE,
  ].join('\n').trim();
}

/**
 * Render a truthful recap of what the run actually executed, for use when the model
 * could not produce a written synthesis at all. It reports only tool names and
 * outcome counts — never invented results — so it cannot manufacture a false success.
 */
export function buildExecutedActionsFallback(toolCalls: ExecutedToolCall[]): string {
  const counts = tallyExecutedActions(toolCalls);

  const preamble =
    'I ran into a problem writing up my final response for this turn, so the summary below is built directly from the actions I actually ran.';

  if (counts.size === 0) {
    return `${preamble}\n\nNo actions were taken, so nothing has changed. Please send your request again and I'll pick it back up.`;
  }

  const lines = [renderLedgerLines(counts)];
  const totalOk = countsInclude(counts, 'ok') ? 1 : 0;
  const totalDeferred = countsInclude(counts, 'deferred') ? 1 : 0;

  // Only the succeeded bucket may be described as applied. A deferred call was
  // never executed, so telling the user not to re-run it would be the exact false
  // success this module exists to prevent.
  const closing: string[] = [];
  if (totalOk > 0) {
    closing.push("The ones marked “succeeded” have already been applied — please don't re-run them.");
  }
  if (totalDeferred > 0) {
    closing.push('The ones marked “not run” were never executed, so nothing was applied for them.');
  }
  closing.push("Ask me to summarize what I just did and I'll write up the details.");
  closing.push(COUNT_BASIS_NOTE);

  return [preamble, '', lines.join('\n'), '', closing.join(' ')].join('\n');
}

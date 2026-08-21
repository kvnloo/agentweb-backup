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

import { SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE } from './termination';
import { buildTurnTimeBudgetNudge } from '../../../utils/turnTimeBudget';

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
const INJECTED_NUDGES = [SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE];

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
  // Checked before the length cap: a history echo, a nudge echo, and a repetition
  // collapse are all either long by nature or an intentionally short exact-match.
  if (HISTORY_ECHO_PREFIX.test(trimmed)) return true;
  if (isNudgeEcho(trimmed)) return true;
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
 * Slices `toolCalls` down to calls made AFTER the most recent successful
 * `set_work_plan_status` call, so a claim about the step/variant currently being
 * closed is never checked against an earlier step's already-counted assets. With no
 * such boundary in the ledger (a single-step turn, or a turn with no work plan at
 * all) the whole ledger is the current step's, matching prior behavior exactly.
 */
function sinceLastStepBoundary(toolCalls: ExecutedToolCall[]): ExecutedToolCall[] {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (!call || call.name !== STEP_BOUNDARY_TOOL_NAME) continue;
    if ('error' in call || isReportedFailure(call)) continue;
    return toolCalls.slice(i + 1);
  }
  return toolCalls;
}

/** Total succeeded calls across every known asset-producing tool in the ledger. */
function countProducedAssets(toolCalls: ExecutedToolCall[]): number {
  const counts = tallyExecutedActions(toolCalls);
  let total = 0;
  for (const [name, { ok }] of counts) {
    if (ASSET_PRODUCING_TOOL_NAMES.has(name)) total += ok;
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
 */
export function detectFalseCompletionClaim(
  content: unknown,
  toolCalls: ExecutedToolCall[],
): FalseCompletionClaim | null {
  if (typeof content !== 'string' || !content.trim()) return null;

  const claims = new Set<number>();
  for (const pattern of [ALL_N_NOUN_PATTERN, N_OF_N_PATTERN, N_SLASH_N_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) claims.add(n);
    }
  }
  if (claims.size === 0) return null;

  const claimed = Math.max(...claims);
  const actual = countProducedAssets(sinceLastStepBoundary(toolCalls));
  if (actual >= claimed) return null;
  return { claimed, actual };
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

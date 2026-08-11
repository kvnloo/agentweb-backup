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
  // Checked before the length cap: a history echo is long by nature.
  if (HISTORY_ECHO_PREFIX.test(trimmed)) return true;
  if (trimmed.length > MAX_RESIDUE_LENGTH) return false;
  return STRUCTURAL_ONLY.test(trimmed);
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
 * Render a truthful recap of what the run actually executed, for use when the model
 * could not produce a written synthesis. It reports only tool names and outcome
 * counts — never invented results — so it cannot manufacture a false success.
 */
export function buildExecutedActionsFallback(toolCalls: ExecutedToolCall[]): string {
  const counts = new Map<string, { ok: number; failed: number; deferred: number }>();
  for (const call of toolCalls || []) {
    const name = call && typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) continue;
    // A collapsed duplicate never ran: the call it points at did, and is counted
    // separately. Including it would report the same action twice.
    if (call.duplicateOf !== undefined && call.duplicateOf !== null) continue;
    const entry = counts.get(name) || { ok: 0, failed: 0, deferred: 0 };
    if ('error' in call || isReportedFailure(call)) entry.failed++;
    else if (isDeferred(call)) entry.deferred++;
    else entry.ok++;
    counts.set(name, entry);
  }

  const preamble =
    'I ran into a problem writing up my final response for this turn, so the summary below is built directly from the actions I actually ran.';

  if (counts.size === 0) {
    return `${preamble}\n\nNo actions were taken, so nothing has changed. Please send your request again and I'll pick it back up.`;
  }

  const lines: string[] = [];
  let totalOk = 0;
  let totalDeferred = 0;
  for (const [name, { ok, failed, deferred }] of counts) {
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} succeeded`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (deferred > 0) parts.push(`${deferred} not run (paused for budget)`);
    totalOk += ok;
    totalDeferred += deferred;
    lines.push(`- ${name} — ${parts.join(', ')}`);
  }

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

  return [preamble, '', lines.join('\n'), '', closing.join(' ')].join('\n');
}

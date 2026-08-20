/**
 * Unconsumed-cursor detection (ENG-1207 AC3).
 *
 * A run must not finish silently on an unread page. AC1/AC2 made truncation
 * VISIBLE in tool messages; this makes it NOTICED. The distinction is the whole
 * ticket: `has_more: true` and `next_cursor` were already present during the
 * ENG-1200 incident, and the model issued the identical unpaged query six times,
 * concluded 20 of 107 leads had answers, wrote 17 records and reported the job
 * complete. Prose has had its turn.
 *
 * The check is deterministic and needs no judge: a tool handed back a cursor and
 * nothing ever passed it back. That is a fact about the run's tool ledger, not a
 * judgement about the reply's wording — so it costs no LLM call and cannot be
 * argued with.
 *
 * WHY THIS IS NOT IN `finalizeGuard`, which is the established claimed-vs-executed
 * seam and explicitly set out to be the ONLY one: that guard is gated behind
 * AGENT_FINALIZE_GUARD *and* AGENT_RUNTIME_SPINE_ENABLED, both off in production.
 * Building AC3 there would ship an acceptance criterion that cannot run — which is
 * uncomfortably close to the defect being fixed. Everything here is therefore a
 * PURE function over the ledger, so `finalizeGuard` can absorb it unchanged the day
 * those flags flip, and the second seam is temporary by construction.
 */

/** The subset of a dispatched tool result this check needs. */
export interface CursorLedgerEntry {
  status?: string;
  toolCall?: { function?: { name?: string } } | any;
  functionArgs?: any;
  result?: any;
}

export interface UnconsumedCursor {
  /** Tool that handed back the cursor nobody used. */
  tool: string;
  /** The cursor value itself, so a caller can name the exact resume point. */
  cursor: string;
  /** Rows actually read from this tool across the whole paging chain. */
  returned: number;
}

/** Result keys a tool may hand a continuation back under. */
const CURSOR_RESULT_KEYS = ['next_cursor', 'nextCursor'] as const;

/** Row-bearing keys, so "how much did we actually read" is answerable. */
const ROW_KEYS = ['leads', 'engagements', 'results', 'items', 'rows'] as const;

/**
 * The tool's name, or null when the entry does not carry one.
 *
 * A notice naming "a tool" cannot be acted on — there is nothing for the reader to
 * resume — so an unnameable entry is malformed input, and this module's contract
 * for malformed input is to ignore it (CodeRabbit, #2493).
 */
function toolNameOf(entry: CursorLedgerEntry): string | null {
  return entry?.toolCall?.function?.name || entry?.toolCall?.name || null;
}

/**
 * Every string appearing anywhere in a call's arguments.
 *
 * Matched on VALUE rather than on a list of parameter names: tools spell it
 * `cursor`, `next_cursor`, `start_cursor`, and a tool adopting a fourth spelling
 * must not silently look consumed. Depth is bounded — arguments are shallow by
 * construction, and an unbounded walk over model-supplied input is a denial of
 * service waiting to happen.
 */
function argValues(args: unknown, depth = 0, out: Set<string> = new Set()): Set<string> {
  if (depth > 4 || args === null || typeof args !== 'object') {
    if (typeof args === 'string') out.add(args);
    return out;
  }
  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value === 'string') out.add(value);
    else if (value && typeof value === 'object') argValues(value, depth + 1, out);
  }
  return out;
}

function cursorFrom(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  for (const key of CURSOR_RESULT_KEYS) {
    const value = (result as Record<string, unknown>)[key];
    // A non-string or empty cursor is not a resume point. Treating `42` or `''`
    // as one would raise a warning nobody can act on.
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function rowsFrom(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  for (const key of ROW_KEYS) {
    const value = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

/**
 * Cursors handed back during the run that nothing later passed back.
 *
 * One entry per TOOL, not per cursor: paging three deep and stopping is one
 * unread remainder, and listing every cursor ever issued would bury the
 * actionable one. `returned` accumulates across the chain, because the honest
 * statement is how much of the data the run actually saw.
 */
export function findUnconsumedCursors(
  ledger: readonly CursorLedgerEntry[] | null | undefined,
): UnconsumedCursor[] {
  if (!Array.isArray(ledger) || ledger.length === 0) return [];

  const rowsPerTool = new Map<string, number>();
  const emitted: { tool: string; cursor: string; index: number }[] = [];

  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i];
    // A failed call read nothing, so it has nothing unread. Warning here would
    // tell the user to resume a query that never ran.
    if (entry?.status && entry.status !== 'success') continue;

    const tool = toolNameOf(entry);
    if (!tool) continue; // unnameable: nothing a reader could resume

    rowsPerTool.set(tool, (rowsPerTool.get(tool) ?? 0) + rowsFrom(entry?.result));

    const cursor = cursorFrom(entry?.result);
    if (cursor) emitted.push({ tool, cursor, index: i });
  }

  // Consumption is tracked by cursor VALUE, not by tool name.
  //
  // An earlier revision closed a tool's chain as soon as that tool returned a page
  // with no cursor, on the reasoning that a consumed cursor always produces a
  // further call whose result advances or closes the chain. That is true only when
  // every call for a tool belongs to the SAME paging chain. It does not hold for an
  // independent query: page 1 of list A leaves a cursor unread, the model then runs
  // a fresh unrelated search with the same tool against list B, and list B's
  // complete result closed list A's chain — silently reporting A as fully read when
  // its page 2 was never fetched (CodeRabbit, #2493).
  //
  // Mutating the value matching away failed no test at the time, which I took as
  // proof it was unreachable. It only proved the suite had no independent-call
  // case. It has one now.
  const unconsumed: UnconsumedCursor[] = [];
  const lastPerTool = new Map<string, UnconsumedCursor>();
  for (const pending of emitted) {
    const used = ledger
      .slice(pending.index + 1)
      .some((later) => later?.status !== 'error' && argValues(later?.functionArgs).has(pending.cursor));
    if (used) continue;
    // One entry per tool: paging three deep and stopping is one unread remainder,
    // and the DEEPEST outstanding cursor is the one worth resuming from.
    lastPerTool.set(pending.tool, {
      tool: pending.tool,
      cursor: pending.cursor,
      returned: rowsPerTool.get(pending.tool) ?? 0,
    });
  }
  unconsumed.push(...lastPerTool.values());
  return unconsumed;
}

/**
 * A plain statement of which portion is unprocessed, or null when nothing is.
 *
 * Silent on a complete run, deliberately. A permanent caveat is noise, and noise
 * is what taught the model to ignore `has_more` in the first place.
 *
 * It never states a remaining total, because nobody looked — that is the point.
 * Inventing one here would be the AC1 defect wearing a different hat.
 */
export function unconsumedCursorNotice(
  unconsumed: readonly UnconsumedCursor[] | null | undefined,
): string | null {
  if (!Array.isArray(unconsumed) || unconsumed.length === 0) return null;

  const parts = unconsumed.map(
    (u) => `${u.tool} returned ${u.returned} row(s) and more remain unread`,
  );
  return (
    `Note: this did not cover all the data. ${parts.join('; ')}. ` +
    `Pass the next_cursor from that call to continue before treating the result as complete.`
  );
}

/**
 * The seam-facing entry point: same shape as `reconcileLandingDeploymentReport`
 * and `reconcileFalseFailureReport`, its two neighbours at the finalize point —
 * `(content, toolCalls) => content`, append-only, unchanged when there is nothing
 * to say.
 *
 * It exists so the ADAPTER is tested too, not just the detection. The loop's
 * ledger entries are `{ name, arguments, result, error }`, which is a different
 * shape from `CursorLedgerEntry`; mapping them inline at the call site would leave
 * the one piece of glue that can silently mis-wire the whole check as the only
 * untested part of it. Given this ticket exists because a signal was present and
 * nobody acted on it, that seemed like the wrong place to save a function.
 *
 * `neverExecuted` is injected rather than imported so this module stays pure and
 * free of loop dependencies; the caller passes the same predicate the finalize
 * ledger uses, so the two cannot disagree about which calls actually ran.
 */
export function reconcileUnconsumedCursors(
  content: string,
  toolCalls: readonly any[] | null | undefined,
  neverExecuted?: (toolCall: any) => boolean,
): string {
  if (!content || !Array.isArray(toolCalls) || toolCalls.length === 0) return content;

  const ledger: CursorLedgerEntry[] = toolCalls.map((tc: any): CursorLedgerEntry => ({
    status: tc?.error !== undefined
      ? 'error'
      : (neverExecuted?.(tc) ? 'deferred' : 'success'),
    toolCall: { function: { name: tc?.name } },
    functionArgs: tc?.arguments,
    result: tc?.result,
  }));

  const notice = unconsumedCursorNotice(findUnconsumedCursors(ledger));
  return notice ? `${content}\n\n${notice}` : content;
}

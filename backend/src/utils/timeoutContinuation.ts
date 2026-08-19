/**
 * ENG-510: when the whole-turn generation cap (GENERATION_TIMEOUT_MS) kills a media-heavy
 * turn mid-flight, the images that already finished ARE persisted (the synchronous
 * `image-generated` markers written the instant each image completes), but the caller
 * otherwise sees a bare 504 with no hint that work was saved or that "continue" will
 * finish the rest. Worse, the chat renders generated images inline only from the
 * end-of-turn `toolCalls` stamp (lost on a cap-kill) — so those finished images would
 * never actually reach the user in the thread. If the 3rd variant then fails forever,
 * the 2 that DID complete are unrecoverable in-chat.
 *
 * These pure helpers let the controller (a) collect exactly the images THIS turn saved
 * and (b) build a user-facing continuation message that embeds them as markdown so they
 * render inline (MarkdownMessage's img component) — delivering the finished work
 * immediately, independent of the lost toolCalls stamp — and invites "continue".
 */

export interface TimeoutContinuationMessage {
  metadata?: {
    kind?: string;
    imageUrl?: string;
    imageFilename?: string;
    timestamp?: string;
    // ENG-907: set on the canned error/diagnostic closings. Those are NOT the turn's
    // own work and must never be counted as salvageable output.
    isErrorMessage?: boolean;
    isDiagnosticMessage?: boolean;
    // ENG-1239: set on the tool-role message toolDispatch persists the instant it
    // defers a generate_image/video call for the per-turn media budget (see
    // hasPersistedMediaBudgetDeferral below).
    mediaBudgetDeferred?: boolean;
    // ENG-1239: an assistant message's own settled toolCalls ledger, checked by
    // hasUnresolvedMediaDeferral for the "soft" deferral shape (see
    // hasDeferredMediaBudgetToolCall).
    toolCalls?: DeferredToolCallLike[];
  } | null;
  timestamp?: string;
  role?: string;
  content?: unknown;
  name?: string;
}

/** ENG-907: what a timed-out turn actually managed to persist before the cap fired. */
export interface SalvagedTurnWork {
  /** Assistant messages carrying real (non-error) text that this turn wrote. */
  narrationCount: number;
  /** Distinct tool names this turn executed, in first-seen order. */
  toolNames: string[];
}

export interface GeneratedImageRef {
  imageUrl: string;
  filename: string;
}

/**
 * Collect image-generated markers (carrying a saved URL) persisted at or after `sinceMs`,
 * URL-deduped. Mirrors scanMessagesForAssets' marker shape and timestamp precedence
 * (`message.timestamp || metadata.timestamp`) so the set matches exactly what the asset
 * panel will render for this turn — and never includes an earlier turn's images.
 */
export function collectMediaGeneratedSince(
  messages: TimeoutContinuationMessage[] | undefined | null,
  sinceMs: number,
): GeneratedImageRef[] {
  if (!Array.isArray(messages)) return [];
  const out: GeneratedImageRef[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const marker = message?.metadata;
    if (!marker || marker.kind !== 'image-generated' || !marker.imageUrl) continue;
    // `message` is non-null here (a nullish entry yields no marker and already continued).
    const rawTs = message.timestamp || marker.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (seen.has(marker.imageUrl)) continue;
    seen.add(marker.imageUrl);
    out.push({ imageUrl: marker.imageUrl, filename: marker.imageFilename || 'generated-image.png' });
  }
  return out;
}

/**
 * User-facing message shown when the turn timed out AFTER delivering >= 1 image. Embeds
 * each completed image as a markdown image so it renders inline in the chat (and persists
 * for reload), then invites "continue". Returns null when nothing was delivered this turn,
 * so the caller keeps the existing 504 — a genuinely empty timeout must not be dressed up
 * as a partial success.
 */
export function buildTimeoutContinuationMessage(images: GeneratedImageRef[] | undefined | null): string | null {
  if (!Array.isArray(images) || images.length < 1) return null;
  const n = images.length;
  const noun = n === 1 ? 'image' : 'images';
  const gallery = images.map((img) => `![${img.filename}](${img.imageUrl})`).join('\n\n');
  return (
    `⚠️ This request went over the time limit before I could finish everything. ` +
    `I generated and saved ${n} ${noun} so far — here ${n === 1 ? 'it is' : 'they are'}:\n\n` +
    `${gallery}\n\n` +
    `Reply "continue" and I'll pick up where I left off and create anything still missing — ` +
    `I won't redo what's already done.`
  );
}

/**
 * ENG-907: the loop's own wall-clock budget (utils/turnTimeBudget) tries to wrap the turn
 * up before the cap, but it can only re-check between iterations — a single long tool call
 * can carry the turn past the synthesis reserve, and then the forced synthesis call is
 * itself guillotined. Observed live on the preview: the budget fired with 27s left and the
 * turn still returned 504.
 *
 * So the loop is best-effort and this is the backstop. `persistIncrementally` (ENG-473)
 * has already written every settled turn to the session, so the research the user paid for
 * is sitting in the thread — a bare 504 just puts a red error on top of it and tells them
 * to start over. Collect what THIS turn persisted so the caller can acknowledge it instead.
 *
 * Deliberately counts only assistant text and executed tool names: enough to prove work
 * happened and to say what kind, with nothing invented. Error/diagnostic closings are
 * excluded — counting the "took too long, please try again" message as salvaged work is
 * exactly the false-success this is meant to prevent.
 */
export function collectTurnWorkSince(
  messages: TimeoutContinuationMessage[] | undefined | null,
  sinceMs: number,
): SalvagedTurnWork {
  const empty: SalvagedTurnWork = { narrationCount: 0, toolNames: [] };
  if (!Array.isArray(messages)) return empty;
  let narrationCount = 0;
  const toolNames: string[] = [];
  const seenTools = new Set<string>();
  for (const message of messages) {
    if (!message) continue;
    const meta = message.metadata;
    const rawTs = message.timestamp || meta?.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    if (message.role === 'tool') {
      const name = typeof message.name === 'string' ? message.name : '';
      if (name && !seenTools.has(name)) {
        seenTools.add(name);
        toolNames.push(name);
      }
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (meta?.isErrorMessage || meta?.isDiagnosticMessage) continue;
    if (meta?.kind === 'generation-timeout-continuation') continue;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (text) narrationCount += 1;
  }
  return { narrationCount, toolNames };
}

/**
 * ENG-1239: toolDispatch's per-turn media-budget deferral (toolDispatch.ts, `makeDeferred`)
 * stops short of the whole-turn hard cap and asks the user to reply "continue" — it never
 * throws, so the interactive route sees a normal 200 response, not a timeout. This detects
 * that specific deferral on a settled turn's toolCalls ledger so the caller can resume the
 * batch itself instead of waiting on the user to notice and retype "continue".
 *
 * Scoped to `reason === 'media_generation_time_budget'` specifically — the same 'deferred'
 * status also covers ENG-822's handler-supplied refusals (e.g. an anonymous-account-scoped
 * decline), which carry their own reason and must NOT be auto-retried the same way.
 */
export interface DeferredToolCallLike {
  result?: { deferred?: boolean; reason?: string; [key: string]: unknown } | null;
}

export function hasDeferredMediaBudgetToolCall(
  toolCalls: DeferredToolCallLike[] | undefined | null,
): boolean {
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some(
    (tc) => tc?.result?.deferred === true && tc.result?.reason === 'media_generation_time_budget',
  );
}

/**
 * ENG-1239: the whole-turn hard-timeout catch branch (agentModeController.ts) never gets
 * a settled `response` — `withGenerationTimeout` rejected, so there is no `toolCalls`
 * ledger for hasDeferredMediaBudgetToolCall to inspect. This reads the same "a media call
 * was deferred" signal off the PERSISTED session history instead: toolDispatch writes a
 * tool-role message with `metadata.mediaBudgetDeferred: true` the instant it defers a
 * call (before the turn can go on to time out), so it survives even when the turn's own
 * final response never arrives. Confirmed against the real production incident (session
 * 822c1ed4, 2026-08-14T18:20:51.907Z): the deferral marker persisted, then the whole-turn
 * cap fired ~21s later — this is exactly the marker that scenario left behind.
 *
 * Scoped to `sinceMs` (the turn's own start) so an EARLIER turn's already-resolved
 * deferral is never mistaken for this turn's.
 */
export function hasPersistedMediaBudgetDeferral(
  messages: TimeoutContinuationMessage[] | undefined | null,
  sinceMs: number,
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message?.metadata?.mediaBudgetDeferred) return false;
    const rawTs = message.timestamp || message.metadata.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    return Number.isFinite(ts) && ts >= sinceMs;
  });
}

/**
 * ENG-1239: durability backstop for the in-process auto-continuation chain. Firing the
 * continuation only right after the deferred turn means a process death in between (a
 * deploy, a crash) loses it silently with no record it was ever attempted. This lets ANY
 * later touch of the session (getSession, on the next page load) detect the same
 * condition from session history alone — no new persistence — and re-fire the resume.
 *
 * Deliberately looks ONLY at the LAST message (cheap enough to call from a
 * frequently-polled endpoint) and requires it to be one of THREE shapes an unresolved
 * media pause actually leaves behind:
 *  - the whole-turn-timeout partial-delivery notice, tagged `mediaBudgetDeferred: true`
 *    (added alongside `kind: 'generation-timeout-continuation'` specifically for this —
 *    the generic non-media salvage variant shares the same `kind` but is NOT tagged, so
 *    it correctly returns false here)
 *  - the model's own successful reply whose toolCalls ledger still shows a deferred call
 *  - OUR OWN synthetic auto-continuation directive (role: 'user', kind:
 *    'auto-continuation') dangling with no reply — a process death can kill the
 *    continuation's own turn AFTER it persists that directive but BEFORE it replies,
 *    which neither of the two assistant-authored shapes above matches (verified live:
 *    killing the backend right after the directive saved left getSession blind to it
 *    until this branch was added). Scoped to the `auto-continuation` kind specifically —
 *    a REAL customer message dangling with no reply is a different, unrelated problem
 *    and must never be mistaken for a media pause.
 * Anything else — including the round-cap exhaustion notice (`kind:
 * 'auto-continuation-exhausted'`) superseding an earlier pause — returns false, so this
 * can never retry forever once the bounded round cap has already given up once.
 */
export function hasUnresolvedMediaDeferral(
  messages: TimeoutContinuationMessage[] | undefined | null,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === 'user') return last.metadata?.kind === 'auto-continuation';
  if (last.role !== 'assistant') return false;
  if (last.metadata?.mediaBudgetDeferred === true) return true;
  return hasDeferredMediaBudgetToolCall(last.metadata?.toolCalls);
}

/** Cap the tool list so a 40-step run doesn't produce an unreadable wall of names. */
const MAX_LISTED_TOOLS = 6;

/**
 * ENG-907: user-facing message for a turn that timed out having done real work but never
 * got to write its final answer. Points at the steps already in the thread (they are
 * persisted and visible) rather than restating them, names what ran, and invites
 * "continue" with an explicit promise not to start over.
 *
 * Returns null when the turn persisted nothing — a genuinely empty timeout keeps the 504
 * rather than being dressed up as a partial success.
 */
export function buildTimeoutPartialWorkMessage(work: SalvagedTurnWork | undefined | null): string | null {
  if (!work) return null;
  const { narrationCount, toolNames } = work;
  if (narrationCount < 1 && toolNames.length < 1) return null;

  const listed = toolNames.slice(0, MAX_LISTED_TOOLS);
  const overflow = toolNames.length - listed.length;
  const toolSentence = listed.length
    ? ` I ran ${listed.map((t) => `\`${t}\``).join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}` +
      `, and the results are in the steps above.`
    : ' The work I completed is in the steps above.';

  return (
    `⚠️ **Partial results — I hit the time limit for this request before I could write the final answer.**\n\n` +
    `What I did finish is saved in this conversation and is not lost.${toolSentence}\n\n` +
    `Reply "continue" and I'll pick up from there and produce the parts that are still ` +
    `missing — I won't redo the research that's already done.`
  );
}

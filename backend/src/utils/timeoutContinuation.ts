/**
 * ENG-510: when the whole-turn generation cap (GENERATION_TIMEOUT_MS) kills a media-heavy
 * turn mid-flight, the images that already finished ARE persisted (the synchronous
 * `image-generated` markers written the instant each image completes), but the caller
 * otherwise sees a bare 504 with no hint that work was saved or that "continue" will
 * finish the rest. These pure helpers let the controller count exactly what THIS turn
 * delivered and craft a user-facing continuation message instead of a silent failure.
 */

export interface TimeoutContinuationMessage {
  metadata?: { kind?: string; imageUrl?: string; timestamp?: string } | null;
  timestamp?: string;
}

/**
 * Count image-generated markers (carrying a saved URL) persisted at or after `sinceMs`.
 * Mirrors scanMessagesForAssets' marker shape and timestamp precedence
 * (`message.timestamp || metadata.timestamp`) so the count matches exactly what the
 * asset panel will render for this turn — and never double-counts an earlier turn's
 * images.
 */
export function countMediaGeneratedSince(
  messages: TimeoutContinuationMessage[] | undefined | null,
  sinceMs: number,
): number {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    const marker = message?.metadata;
    if (marker?.kind !== 'image-generated' || !marker?.imageUrl) continue;
    const rawTs = message?.timestamp || marker?.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    if (Number.isFinite(ts) && ts >= sinceMs) count++;
  }
  return count;
}

/**
 * User-facing message shown when the turn timed out AFTER delivering >= 1 media asset.
 * Returns null when nothing was delivered this turn, so the caller keeps the existing
 * 504 — a genuinely empty timeout must not be dressed up as a partial success.
 */
export function buildTimeoutContinuationMessage(mediaGeneratedThisTurn: number): string | null {
  if (!Number.isFinite(mediaGeneratedThisTurn) || mediaGeneratedThisTurn < 1) return null;
  const n = Math.floor(mediaGeneratedThisTurn);
  const noun = n === 1 ? 'image' : 'images';
  return (
    `⚠️ This request went over the time limit before I could finish everything. ` +
    `I generated and saved ${n} ${noun} so far (shown above). ` +
    `Reply "continue" and I'll pick up where I left off and create anything still missing — ` +
    `I won't redo what's already done.`
  );
}

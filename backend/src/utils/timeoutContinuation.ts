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
  metadata?: { kind?: string; imageUrl?: string; imageFilename?: string; timestamp?: string } | null;
  timestamp?: string;
}

export interface GeneratedImageRef {
  imageUrl: string;
  filename: string;
}

export interface MediaBudgetToolCall {
  name?: string;
  result?: {
    imageUrl?: string;
    filename?: string;
    deferred?: boolean;
    reason?: string;
  } | null;
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
 * Explain a whole-turn timeout that occurred while media tools were actively in
 * flight but before any asset finished. `pendingTools` comes from the final SSE
 * progress snapshot, so non-media timeouts keep their existing generic handling.
 */
export function buildEmptyMediaTimeoutMessage(
  pendingTools: string[] | undefined | null,
): string | null {
  const remaining = Array.isArray(pendingTools)
    ? pendingTools.filter((name) => name === 'generate_image').length
    : 0;
  if (remaining < 1) return null;
  const noun = remaining === 1 ? 'image' : 'images';
  return (
    `⚠️ This image request hit the time limit before any images finished. ` +
    `No image from this batch finished, so there was nothing from it to upload or use in a creative or ad. ` +
    `${remaining} ${noun} still ${remaining === 1 ? 'remains' : 'remain'}. ` +
    `Please retry the request; it will start from the first missing image.`
  );
}

/**
 * Deterministic terminal response for a soft media-budget deferral. Stopping the
 * agent loop at this boundary prevents a later iteration from uploading a partial
 * image set to Meta. Successful generated images are delivered inline; deferred
 * calls become the exact remaining count.
 */
export function buildMediaBudgetDeferralMessage(
  toolCalls: MediaBudgetToolCall[] | undefined | null,
): string | null {
  if (!Array.isArray(toolCalls)) return null;
  const images = toolCalls
    .filter((call) => call?.name === 'generate_image' && typeof call.result?.imageUrl === 'string')
    .map((call) => ({
      imageUrl: call.result!.imageUrl!,
      filename: call.result?.filename || 'generated-image.png',
    }));
  const remaining = toolCalls.filter(
    (call) => call?.name === 'generate_image'
      && call.result?.deferred === true
      && call.result?.reason === 'media_generation_time_budget',
  ).length;
  if (remaining < 1) return null;

  const completed = images.length;
  const completedNoun = completed === 1 ? 'image' : 'images';
  const remainingNoun = remaining === 1 ? 'image' : 'images';
  const gallery = images.map((image) => `![${image.filename}](${image.imageUrl})`).join('\n\n');
  const delivered = completed > 0
    ? `I generated and saved ${completed} ${completedNoun} so far${gallery ? `:\n\n${gallery}` : '.'}`
    : 'No images finished before the budget boundary.';

  return (
    `⚠️ This request reached the per-response media time budget before the full batch finished. ` +
    `${delivered}\n\n` +
    `${remaining} ${remainingNoun} still ${remaining === 1 ? 'remains' : 'remain'}. ` +
    `I stopped before starting any follow-on publishing steps, so the incomplete batch was not published. ` +
    `Reply "continue" and I'll create only what is still missing.`
  );
}

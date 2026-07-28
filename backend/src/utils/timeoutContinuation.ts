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

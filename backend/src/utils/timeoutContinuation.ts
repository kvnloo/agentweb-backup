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
 * User-facing nouns for the media-gen tools subject to the per-run time budget. Kept
 * local (rather than imported from core/toolDispatch) so these copy helpers stay a
 * dependency-free leaf util — importing the dispatcher here would pull the gateway and
 * the whole tool-execution graph into the controller's error path.
 *
 * Mirrors MEDIA_GEN_TOOLS in services/agentMode/core/toolDispatch.ts. Adding a media-gen
 * tool there without adding it here degrades to the generic "asset" wording; it never
 * silently drops the deferral message (unknown names simply aren't counted).
 */
const MEDIA_TOOL_NOUNS: Record<string, { singular: string; plural: string }> = {
  generate_image: { singular: 'image', plural: 'images' },
  generate_video: { singular: 'video', plural: 'videos' },
  generate_voiceover: { singular: 'voiceover', plural: 'voiceovers' },
};

/** Singular/plural noun for a set of media tool names — kind-specific, or "asset" when mixed. */
function mediaNounFor(toolNames: string[]): { singular: string; plural: string } {
  const kinds = new Set(toolNames);
  if (kinds.size === 1) {
    const only = MEDIA_TOOL_NOUNS[toolNames[0]];
    if (only) return only;
  }
  return { singular: 'asset', plural: 'assets' };
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
  const pending = Array.isArray(pendingTools)
    ? pendingTools.filter((name): name is string => typeof name === 'string' && name in MEDIA_TOOL_NOUNS)
    : [];
  const remaining = pending.length;
  if (remaining < 1) return null;
  const label = mediaNounFor(pending);
  const noun = remaining === 1 ? label.singular : label.plural;
  return (
    `⚠️ This ${label.singular} request hit the time limit before any ${label.plural} finished. ` +
    `No ${label.singular} from this batch finished, so there was nothing from it to upload or use in a creative or ad. ` +
    `${remaining} ${noun} still ${remaining === 1 ? 'remains' : 'remain'}. ` +
    `Please retry the request; it will start from the first missing ${label.singular}.`
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
  // Only generate_image results carry a renderable URL, so the inline gallery stays
  // image-only — but the REMAINING count spans every budgeted media tool. Counting only
  // generate_image made a deferred video/voiceover return null, which dropped the caller
  // into a canned string that lost the completed images entirely.
  const images = toolCalls
    .filter((call) => call?.name === 'generate_image' && typeof call.result?.imageUrl === 'string')
    .map((call) => ({
      imageUrl: call.result!.imageUrl!,
      filename: call.result?.filename || 'generated-image.png',
    }));
  const deferredNames = toolCalls
    .filter((call) => typeof call?.name === 'string'
      && call.name in MEDIA_TOOL_NOUNS
      && call.result?.deferred === true
      && call.result?.reason === 'media_generation_time_budget')
    .map((call) => call.name as string);
  const remaining = deferredNames.length;
  if (remaining < 1) return null;

  const completed = images.length;
  const completedNoun = completed === 1 ? 'image' : 'images';
  const remainingLabel = mediaNounFor(deferredNames);
  const remainingNoun = remaining === 1 ? remainingLabel.singular : remainingLabel.plural;
  const gallery = images.map((image) => `![${image.filename}](${image.imageUrl})`).join('\n\n');
  const delivered = completed > 0
    ? `I generated and saved ${completed} ${completedNoun} so far${gallery ? `:\n\n${gallery}` : '.'}`
    : 'Nothing from this batch finished before the budget boundary.';

  return (
    `⚠️ This request reached the per-response media time budget before the full batch finished. ` +
    `${delivered}\n\n` +
    `${remaining} ${remainingNoun} still ${remaining === 1 ? 'remains' : 'remain'}. ` +
    // Scoped deliberately to what the code actually guarantees: from this pause onward
    // nothing further in this response was published. It does NOT claim that no publishing
    // happened earlier in the turn — an earlier iteration may already have published.
    `I paused here rather than taking the incomplete set on to any further publishing step. ` +
    `Reply "continue" and I'll create only what is still missing.`
  );
}

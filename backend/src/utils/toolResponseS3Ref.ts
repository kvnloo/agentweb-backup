/**
 * toolResponseS3Ref — the single definition of the "[Full response stored at S3
 * key: …]" header that toolDispatch prepends to an offloaded tool response.
 *
 * The header is the ONLY recovery path a later turn has: once
 * trimToolMessagesForContext compresses an old tool message to a short preview,
 * the S3 key is all that lets search_tool_response / read_tool_response page
 * back through the original payload. Builder and matcher therefore live
 * together so they cannot drift apart (ENG-940).
 *
 * When the offload cannot be completed at all, the response instead carries the
 * "could NOT be stored" notice below. S3 being unavailable is not something we
 * can paper over — but the model must never be handed a lossy preview that
 * looks complete, so the loss is stated instead of hidden. Both headers are
 * leading, and the trimmer preserves whichever one is present.
 */

const HEADER_PREFIX = '[Full response stored at S3 key: ';

// The key never contains ']', so a non-greedy match to the first ']' is exact.
// Anchored at the start because toolDispatch always PREPENDS the header — a
// bracket sequence appearing mid-payload is tool output, not a recovery ref.
const HEADER_PATTERN = /^\[Full response stored at S3 key: ([^\]]+?) \(\d+ chars\)[^\]]*\]\n*/;

const UNAVAILABLE_PATTERN = /^\[Full response could NOT be stored \(\d+ chars\)[^\]]*\]\n*/;

/** Build the header prepended to an offloaded tool response. */
export function buildToolResponseS3Header(key: string, contentLength: number): string {
  return `${HEADER_PREFIX}${key} (${contentLength} chars) — use search_tool_response tool to find specific fields]\n\n`;
}

/**
 * Return the leading S3 reference header (including its trailing newlines),
 * or null when the content was not offloaded.
 */
export function extractToolResponseS3Ref(content: string): string | null {
  const match = HEADER_PATTERN.exec(content);
  return match ? match[0] : null;
}

/** Return just the S3 key from a leading reference header, or null. */
export function parseToolResponseS3Key(content: string): string | null {
  const match = HEADER_PATTERN.exec(content);
  return match ? match[1] : null;
}

/**
 * Build the header prepended when a response was too large to keep but could
 * not be offloaded. It tells the model the two things it cannot work out for
 * itself: that this message is the only copy, and that a later preview of it
 * will be lossy — so anything not visible must be re-fetched, never inferred.
 */
export function buildToolResponseUnavailableHeader(contentLength: number): string {
  return (
    `[Full response could NOT be stored (${contentLength} chars) — storage was unavailable, ` +
    `so there is no key to page through. This message is the only copy: read what you need NOW. ` +
    `On a later turn only a short preview of it remains — do NOT infer any detail that is not ` +
    `visible there, and re-run the source tool if you need the rest]\n\n`
  );
}

/**
 * Return the leading recovery/notice header of EITHER kind (including its
 * trailing newlines), or null when the content carries neither. This is what
 * the trimmer matches on: both headers must survive compression, since each is
 * what stops the model from trusting a preview it should not trust.
 */
export function extractToolResponseHeader(content: string): string | null {
  const match = HEADER_PATTERN.exec(content) ?? UNAVAILABLE_PATTERN.exec(content);
  return match ? match[0] : null;
}

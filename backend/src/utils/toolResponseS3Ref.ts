/**
 * toolResponseS3Ref — the single definition of the "[Full response stored at S3
 * key: …]" header that toolDispatch prepends to an offloaded tool response.
 *
 * The header is the ONLY recovery path a later turn has: once
 * trimToolMessagesForContext compresses an old tool message to a short preview,
 * the S3 key is all that lets search_tool_response / read_tool_response page
 * back through the original payload. Builder and matcher therefore live
 * together so they cannot drift apart (ENG-940).
 */

const HEADER_PREFIX = '[Full response stored at S3 key: ';

// The key never contains ']', so a non-greedy match to the first ']' is exact.
// Anchored at the start because toolDispatch always PREPENDS the header — a
// bracket sequence appearing mid-payload is tool output, not a recovery ref.
const HEADER_PATTERN = /^\[Full response stored at S3 key: ([^\]]+?) \(\d+ chars\)[^\]]*\]\n*/;

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

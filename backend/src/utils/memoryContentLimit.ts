/**
 * ENG-908 / ENG-1298 / ENG-831 — the 2000-character memory cap, and why its error
 * text is load-bearing.
 *
 * Three separately-reported tickets, one cause. `save_memory` and `save_org_memory`
 * rejected oversized content with a bare sentence:
 *
 *     Content must be 2000 characters or less
 *
 * It names the limit and nothing else — not how long the content actually was, not by
 * how much it overran, and not what to do instead. So the agent had no way to compute a
 * shorter payload and simply re-sent the same one. ENG-908 measured it as the single
 * most repeated tool-level defect in its window (3 of 55 sessions) and the only thing
 * dragging an otherwise-perfect run down; ENG-1298 found it across four sessions in a
 * 38-hour window; ENG-831 watched `save_org_memory` fail three consecutive times on one
 * run. Every occurrence recovers eventually, so it never surfaces as user-visible harm —
 * it just burns model round-trips, quietly, on every affected run.
 *
 * The fix is the message. An error that reports the actual length, the overrun, and the
 * action to take is one the caller can act on without guessing; one that repeats the
 * limit it already declared in the schema is not.
 *
 * Counting is code points (`Array.from`), not UTF-16 code units — the same unit as the
 * declared `maxLength: 2000` and the original guards (ENG-821), so an emoji or astral
 * character costs one, and the number quoted back matches the number enforced.
 */
export const MEMORY_CONTENT_MAX_CHARS = 2000;

/** Code-point length — the unit the cap is declared and enforced in. */
export function memoryContentLength(content: string): number {
  return Array.from(content).length;
}

/**
 * ENG-1199 — the best place to cut oversized content so the first part fits.
 *
 * Returns a code-point index <= the cap: the end of the last paragraph, line, or
 * sentence boundary inside the cap when one exists in its back half, else the last
 * whitespace there, else the cap itself. Scheduled runs that hit the cap retried five
 * times trimming blind; a concrete index lets them comply in one retry.
 */
export function suggestMemorySplitPoint(content: string, max: number = MEMORY_CONTENT_MAX_CHARS): number {
  const chars = Array.from(content);
  if (chars.length <= max) return chars.length;
  const head = chars.slice(0, max).join('');
  const floor = Math.floor(max / 2);
  const toCodePoints = (utf16Index: number) => Array.from(head.slice(0, utf16Index)).length;
  for (const pattern of [/\n\s*\n/g, /\n/g, /[.!?;](?=\s)/g]) {
    let last = -1;
    for (const m of head.matchAll(pattern)) last = (m.index ?? 0) + m[0].length;
    if (last > 0 && toCodePoints(last) >= floor) return toCodePoints(last);
  }
  const ws = head.search(/\s\S*$/);
  if (ws > 0 && toCodePoints(ws) >= floor) return toCodePoints(ws);
  return max;
}

/**
 * Throw an actionable over-length error, or return cleanly.
 *
 * `field` names the argument in the caller's own vocabulary so the message points at
 * something the caller actually passed.
 */
export function assertMemoryContentWithinLimit(content: string, field = 'content'): void {
  const length = memoryContentLength(content);
  if (length <= MEMORY_CONTENT_MAX_CHARS) return;
  const over = length - MEMORY_CONTENT_MAX_CHARS;
  const split = suggestMemorySplitPoint(content);
  const tail = Array.from(content).slice(Math.max(0, split - 40), split).join('').trim();
  throw new Error(
    `Content must be ${MEMORY_CONTENT_MAX_CHARS} characters or less — this ${field} is `
    + `${length} characters, ${over} over the limit. Do NOT retry the same text: it will fail `
    + `identically. Shorten it to the essential fact, or split it into multiple memories of `
    + `at most ${MEMORY_CONTENT_MAX_CHARS} characters each, then save again. `
    + `Suggested split point: character ${split} (first part ends "...${tail}"); save the first `
    + `${split} characters, then split the remaining ${length - split} into further memories of at most `
    + `${MEMORY_CONTENT_MAX_CHARS} characters each.`,
  );
}

/**
 * ENG-2574 — the largest content save_memory / save_org_memory accept in one call. Up to
 * this size the tool splits content itself (at `suggestMemorySplitPoint` boundaries) into
 * rows of at most MEMORY_CONTENT_MAX_CHARS, instead of rejecting a 2,018-character note and
 * spending a model turn on a retry the tool could do itself. Beyond it the schema still
 * rejects: an 8,000-character "fact" is a document, not a memory.
 */
export const MEMORY_AUTOSPLIT_MAX_CHARS = MEMORY_CONTENT_MAX_CHARS * 4;

/**
 * Split content into chunks of at most `max` code points, cutting at paragraph, line,
 * sentence, or whitespace boundaries where possible. Content within the cap comes back
 * as a single unchanged chunk. Whitespace at a cut is trimmed; empty chunks are dropped.
 */
export function splitMemoryContent(content: string, max: number = MEMORY_CONTENT_MAX_CHARS): string[] {
  if (memoryContentLength(content) <= max) return [content];
  const chunks: string[] = [];
  let rest = content;
  while (memoryContentLength(rest) > max) {
    const cut = suggestMemorySplitPoint(rest, max);
    const chars = Array.from(rest);
    const head = chars.slice(0, cut).join('').trim();
    if (head) chunks.push(head);
    rest = chars.slice(cut).join('').trimStart();
  }
  const tail = rest.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

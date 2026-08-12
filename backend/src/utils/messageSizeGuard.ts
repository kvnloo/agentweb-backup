/**
 * PURE per-item size guard for persisted chat messages (ENG-946).
 *
 * DynamoDB rejects any item over 400KB. The final assistant turn of a long
 * agent-mode run carries the whole run's tool-call ledger on
 * `metadata.toolCalls` (name + arguments + RESULT for every call), which for a
 * data-gathering scheduled run dwarfs the answer itself — a measured production
 * item was 626,580 chars, of which the report was 12KB and the ledger 600KB+.
 *
 * The previous guard only ever truncated `message.content`, so on those items it
 * shortened the 12KB report and left the 600KB ledger untouched: the item stayed
 * over the limit, `batchWrite` threw `ValidationException: Item size has exceeded
 * the maximum allowed size`, and the caller swallowed it. The user's scheduled run
 * was recorded `success` while its report was silently dropped from the transcript
 * (prod sessions 82e0ee50… on 2026-08-07 and dc5b7a52… on 2026-08-06).
 *
 * So shed in order of least value to the user, and only ever touch the answer last:
 *   1. the tool-result payloads on the ledger (diagnostics, reproducible from the
 *      tool messages that are already persisted as their own items),
 *   2. the ledger down to bare tool names,
 *   3. the message text, truncated to whatever budget is left,
 *   4. the remaining metadata, if even an empty message would not fit.
 *
 * Pure: never mutates its input, and guarantees the returned message serializes to
 * at most `maxBytes` bytes (short of a message whose bare skeleton exceeds it).
 */

export const OMITTED_TOOL_RESULT = '[omitted — message exceeded the persistence size limit]';

/**
 * Size of `value` as DynamoDB measures it: UTF-8 BYTES, not UTF-16 code units.
 *
 * `JSON.stringify(x).length` undercounts every non-ASCII character — JSON.stringify
 * leaves them literal rather than \u-escaping them, so one CJK character is 1 unit of
 * `.length` but 3 bytes on the wire, and an emoji is 2 units but 4 bytes. A 200,000-character
 * Chinese report would clear a 350,000-"char" budget at 600KB encoded and still be rejected —
 * the precise failure this module exists to prevent.
 */
const serializedSize = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

/** Truncate `content` until the whole message fits, then return it. */
function fitContent(message: any, maxBytes: number, originalSize: number): any {
  const contentStr =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const notice = `\n\n[Truncated — original size: ${originalSize} bytes]`;
  const overhead = serializedSize({ ...message, content: '' });

  let keep = Math.max(0, maxBytes - overhead - notice.length);
  // A character slice is only a guess at a BYTE budget — JSON escaping expands some
  // characters, and any non-ASCII one costs 2-4 bytes — so converge by re-measuring
  // rather than trusting the first estimate.
  for (let attempt = 0; attempt < 32 && keep > 0; attempt++) {
    const candidate = { ...message, content: contentStr.slice(0, keep) + notice };
    const candidateSize = serializedSize(candidate);
    if (candidateSize <= maxBytes) return candidate;
    keep = Math.max(0, keep - Math.max(1, candidateSize - maxBytes));
  }
  return { ...message, content: notice.trim() };
}

/**
 * Return a copy of `message` that serializes to at most `maxBytes` bytes, shedding the
 * least valuable parts first. Returns the ORIGINAL reference when it already fits.
 */
export function shrinkMessageForPersistence(message: any, maxBytes: number): any {
  if (!message || typeof message !== 'object') return message;
  const originalSize = serializedSize(message);
  if (originalSize <= maxBytes) return message;

  let working: any = message;

  const ledger = working?.metadata?.toolCalls;
  if (Array.isArray(ledger) && ledger.length > 0) {
    // 1. Drop result payloads LARGEST-FIRST, and stop the moment the item fits.
    //
    // Not all-or-nothing, because result size tracks how much the result is worth
    // keeping almost exactly inversely. A `generate_image`/`upload_image` result is
    // ~100 bytes (`{success, imageUrl}`) and is READ downstream — utils/
    // scanMessagesForAssets builds the session asset cache out of exactly those two
    // fields, and only generate_image/generate_video are in chatbotService's
    // REPAIRABLE_TOOL_CALLS, so a shed `upload_image` result is gone for good. A
    // `search_tool_response` result is ~15KB of paging diagnostics that nothing reads
    // and whose source tool message is persisted as its own item anyway.
    //
    // Shedding by size therefore drops the blobs that caused the overflow and leaves
    // the small, load-bearing results untouched.
    const shed = new Set<number>();
    const budgetToRecover = originalSize - maxBytes;
    let recovered = 0;
    const bySizeDesc = ledger
      .map((call: any, index: number) => ({
        index,
        cost:
          call && typeof call === 'object' && call.result !== undefined
            ? serializedSize(call.result) - OMITTED_TOOL_RESULT.length - 2
            : 0,
      }))
      .filter((entry) => entry.cost > 0)
      .sort((a, b) => b.cost - a.cost || a.index - b.index);
    for (const entry of bySizeDesc) {
      if (recovered >= budgetToRecover) break;
      shed.add(entry.index);
      recovered += entry.cost;
    }
    const shedResults = (indices: Set<number>) => ({
      ...working,
      metadata: {
        ...working.metadata,
        toolCalls: ledger.map((call: any, index: number) =>
          indices.has(index) ? { ...call, result: OMITTED_TOOL_RESULT } : call
        ),
      },
    });
    working = shedResults(shed);
    if (serializedSize(working) <= maxBytes) return working;

    // The size estimate was optimistic (JSON escaping) — shed every result.
    working = shedResults(new Set(ledger.map((_: any, index: number) => index)));
    if (serializedSize(working) <= maxBytes) return working;

    // 2. Still over — keep only what the ledger is actually read for: which
    //    tools ran. Flagged so a reader knows the ledger is not the full record.
    working = {
      ...working,
      metadata: {
        ...working.metadata,
        toolCalls: ledger
          .map((call: any) => ({ name: call?.name }))
          .filter((call: any) => typeof call.name === 'string'),
        toolCallsTruncated: true,
      },
    };
    if (serializedSize(working) <= maxBytes) return working;
  }

  // 3. Truncate the answer itself.
  const withFittedContent = fitContent(working, maxBytes, originalSize);
  if (serializedSize(withFittedContent) <= maxBytes) return withFittedContent;

  // 4. Nothing but the message skeleton left — the metadata alone is over budget.
  //    `toolCalls` names are kept even here: agentModeController's history filter
  //    drops an assistant tool-call turn that has no `metadata.toolCalls`, so
  //    removing the key outright would evict the message from the conversation.
  const stripped = {
    ...working,
    metadata: {
      timestamp: working?.metadata?.timestamp,
      ...(Array.isArray(working?.metadata?.toolCalls) ? { toolCalls: working.metadata.toolCalls } : {}),
      metadataTruncated: true,
    },
  };
  return fitContent(stripped, maxBytes, originalSize);
}

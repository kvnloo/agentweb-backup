/**
 * ENG-2227: provenance label for text typed by an anonymous share-link visitor.
 *
 * A share link lets anyone holding it write into the account owner's real session, so what they type must not read
 * to the model as the verified owner's word. The label is appended SERVER-side, last, to every such message (a visitor
 * cannot place text after it or remove it). One constant, because the typed history rebuild, this turn's own message, the
 * benchmark replay and the model-comparison replay must say exactly the same thing, and the system prompt section refers
 * to this exact string. The feedback comment and the voice call say the same thing in their own words (a system row and a
 * spoken transcript have no "last line" to append to).
 */
export const ANONYMOUS_SHARE_MARKER = '[Sent by an anonymous viewer via a shared link — not a verified account owner]';

/**
 * The message text with the provenance label appended. Idempotent: text that already ends with the label (the benchmark
 * replay bakes it into the stored copy, and the history rebuild then sees the stamp again) is returned unchanged, so a
 * message is never labelled twice.
 */
export function withAnonymousShareMarker(text: string): string {
  if (text.trimEnd().endsWith(ANONYMOUS_SHARE_MARKER)) return text;
  return `${text}\n\n${ANONYMOUS_SHARE_MARKER}`;
}

/** True when the stored message was written by an anonymous share-link visitor (the stamp `runSessionTurn` writes). */
export function isAnonymousShareMessage(message: { metadata?: { ishareSender?: { isAnonymous?: boolean } } } | null | undefined): boolean {
  return message?.metadata?.ishareSender?.isAnonymous === true;
}

/**
 * The server-authored continuation turns ("[SYSTEM] This is an automatic continuation, not a message from the user ...")
 * ride the same turn as a visitor's request and are stamped with it, but no visitor wrote them: labelling one "sent by an
 * anonymous viewer" would contradict its own first line.
 */
export const AUTO_CONTINUATION_PREFIX = '[SYSTEM] This is an automatic continuation';

/** True for a stored or live user turn the server wrote itself (an auto-continuation), whatever stamp it carries. */
export function isServerAuthoredContinuation(message: { content?: unknown; metadata?: { kind?: string } } | null | undefined, liveText?: string): boolean {
  if (message?.metadata?.kind === 'auto-continuation') return true;
  const text = liveText ?? (typeof message?.content === 'string' ? message.content : '');
  return text.trimStart().startsWith(AUTO_CONTINUATION_PREFIX);
}

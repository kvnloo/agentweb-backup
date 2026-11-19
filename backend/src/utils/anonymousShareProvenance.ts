/**
 * ENG-2227: provenance label for text typed by an anonymous share-link visitor.
 *
 * A share link lets anyone holding it write into the account owner's real session, so what they type must not read
 * to the model as the verified owner's word. The label is appended SERVER-side, last, to every such message (a visitor
 * cannot place text after it or remove it). One constant, because the history rebuild, this turn's own message, the
 * benchmark replay, the feedback comment and the voice transcript must all say exactly the same thing, and the system
 * prompt section refers to this exact string.
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

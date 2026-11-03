/**
 * Small helpers for text that an outsider wrote (a contact's name, the subject and body of their reply) before it is shown to a customer.
 * Everything here is linear in the length of its input: none of it may stall the server on hostile text.
 */

/**
 * Characters that show nothing or change how the text around them is shown. They can hide words from a person (while a mail summarizer still reads
 * them), reorder what follows, or make an empty-looking block. Every format character goes (Unicode category Cf: zero-width and direction marks,
 * soft hyphen, tag characters and so on) except the zero-width joiner and non-joiner, which real text needs (emoji sequences, Persian and Indic
 * scripts); text with only those left is not shown (see hasVisibleText). Also gone: the blank "filler" letters and the blank braille cell.
 */
const INVISIBLE = /(?![\u200c\u200d])[\p{Cf}\u034f\u115f\u1160\u2065\u2800\u3164\uffa0\u{e0000}-\u{e007f}]/gu;
/** C0/C1 controls except tab and newline, plus the Unicode line and paragraph separators. */
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

/** The text without invisible, direction-changing and control characters, and with no-break spaces made ordinary. Keeps tabs and newlines. */
export function stripUnsafeChars(value: string): string {
  return value.replace(INVISIBLE, "").replace(CONTROL, "").replace(/\u00a0/g, " ");
}

/** `text.slice(0, end)` that never leaves half of an emoji (a lone high surrogate) at the cut. */
export function sliceSafe(text: string, end: number): string {
  const cut = text.slice(0, end);
  const last = cut.length ? cut.charCodeAt(cut.length - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** True when the text has a letter, number, punctuation mark or symbol (an emoji counts). Spaces and joiners alone show nothing. */
export function hasVisibleText(value: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
}

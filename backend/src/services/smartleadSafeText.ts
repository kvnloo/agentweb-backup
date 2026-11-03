/**
 * Small helpers for text that an outsider wrote (a contact's name, the subject and body of their reply) before it is shown to a customer.
 * Everything here is linear in the length of its input: none of it may stall the server on hostile text.
 */

/** Zero-width and direction-changing characters: they can hide text, reorder what comes after them, or make an empty-looking block. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
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

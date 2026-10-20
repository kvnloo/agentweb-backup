// The one phone/SID redactor for hot-lead-call text that is logged or persisted (error messages,
// timeline event details). Matched in order at each position:
//  - a Twilio resource SID (CA call, PN number, ...: two capitals + 32 hex, which can hold a long
//    digit run) is kept: it is an identifier worth having in a log. Account SIDs (AC...) are half of
//    the API credential and are removed by the credential layer in voiceProvider before this runs.
//  - an ISO date (2026-10-19) is kept.
//  - anything else shaped like a phone number is replaced: 7+ decimal digits of any script (\p{Nd}),
//    optionally led by + (the fullwidth plus, or a URL-encoded %2B) and separated by whitespace (NBSP
//    included), brackets, dots, commas, asterisks, underscores, slashes, any Unicode hyphen/minus, or
//    invisible characters (zero-width space/joiners, word joiner, BOM, soft hyphen) that hide a split.
// A plain-digit start is only bounded on the LEFT (not glued to another digit, an underscore or a dash),
// so ids like job_1234567 survive while a glued prefix ("to4155550100") does not; a digit run glued on the
// right ("4155550100x") is still redacted, and a leading + or %2B always starts a match.
// No trailing \b: an underscore suffix (a word character) must not stop the SID being kept whole.
export const RESOURCE_SID = /\b[A-Z]{2}[0-9a-f]{32}(?![0-9a-f])/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?!\d)/;
const PHONE_LIKE = /(?:[+＋]|%2[Bb]|(?<![\p{Nd}_-]))\p{Nd}(?:[\s().,*_\-‐-―−－/\u00AD\u200B-\u200D\u2060\uFEFF]*\p{Nd}){6,}/u;
const KEEP_OR_PHONE = new RegExp(`(${RESOURCE_SID.source}|${ISO_DATE.source})|${PHONE_LIKE.source}`, 'gu');

export const REDACTED = '[redacted]';

export function redactPhones(text: string): string {
  return text.replace(KEEP_OR_PHONE, (match, kept) => (kept ? match : REDACTED));
}

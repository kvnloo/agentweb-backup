// The one phone/SID redactor for hot-lead-call text that is logged or persisted (error messages,
// timeline event details). Matched in order at each position:
//  - a Twilio resource SID (CA call, PN number, ...: two capitals + 32 hex, which can hold a long
//    digit run) is kept: it is an identifier worth having in a log. Account SIDs (AC...) are half of
//    the API credential and are removed by the credential layer in voiceProvider before this runs.
//  - an ISO date (2026-10-19) is kept.
//  - anything else shaped like a phone number is replaced: 7+ decimal digits of any script (\p{Nd}),
//    optionally led by + (or the fullwidth plus) and separated by whitespace (NBSP included), brackets,
//    dots, slashes, or any Unicode hyphen/minus.
// A plain-digit start is only bounded on the LEFT (not glued to a word character or dash), so ids like
// job_1234567 survive; a digit run glued on the right ("4155550100x") is still redacted, and a leading
// + always starts a match.
export const RESOURCE_SID = /\b[A-Z]{2}[0-9a-f]{32}\b/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?!\d)/;
const PHONE_LIKE = /(?:[+＋]|(?<![\w-]))\p{Nd}(?:[\s().\-‐-―−－/]*\p{Nd}){6,}/u;
const KEEP_OR_PHONE = new RegExp(`(${RESOURCE_SID.source}|${ISO_DATE.source})|${PHONE_LIKE.source}`, 'gu');

export const REDACTED = '[redacted]';

export function redactPhones(text: string): string {
  return text.replace(KEEP_OR_PHONE, (match, kept) => (kept ? match : REDACTED));
}

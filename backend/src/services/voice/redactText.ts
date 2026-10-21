// The one phone/SID redactor for hot-lead-call text that is logged or persisted (error messages,
// timeline event details). Matched in order at each position:
//  - a Twilio resource SID (CA call, PN number, ...: two capitals + 32 hex, which can hold a long
//    digit run) is kept: it is an identifier worth having in a log. Account SIDs (AC...) are half of
//    the API credential and are removed by the credential layer in voiceProvider before this runs.
//  - an ISO date (2026-10-19) is kept.
//  - a UUID is kept: its hex blocks hold digit runs that would otherwise look like a number (a letter before
//    a digit run does not stop a match).
//  - a number written with thousands separators (1,234,567 or 12,345,678) and a spaced list of short numbers
//    (1, 2, 3, 4, 5, 6, 7) are kept. A run with a 4-digit group (1,415,555,0100) is not one of these. Residual
//    risk, accepted: a phone split into 1-3 digit groups by ", " (415, 555, 01, 00) is read as such a list.
//  - anything else shaped like a phone number is replaced: 7+ decimal digits of any script (\p{Nd}),
//    optionally led by + (the fullwidth plus, or a URL-encoded %2B) and separated by whitespace (NBSP
//    included), a URL-encoded space (%20), brackets, dots, commas, semicolons, pipes, hashes, tildes, equals
//    signs, asterisks, underscores, slashes, any Unicode hyphen/minus, or invisible characters (zero-width
//    space/joiners, word joiner, BOM, soft hyphen, the left-to-right and right-to-left marks, the Arabic letter
//    mark) that hide a split.
// A plain-digit start is only bounded on the LEFT (not glued to another digit, an underscore or a dash),
// so ids like job_1234567 survive while a glued prefix ("to4155550100") does not; a digit run glued on the
// right ("4155550100x") is still redacted, and a leading + or %2B always starts a match.
// No trailing \b: an underscore suffix (a word character) must not stop the SID being kept whole.
const RESOURCE_SID = /\b[A-Z]{2}[0-9a-f]{32}(?![0-9a-f])/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?!\d)/;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
// Both need a left bound like a phone's and must end where the run ends, so they never keep the front of a longer phone-like run.
const THOUSANDS_NUMBER = /(?<![\p{Nd}_-])\d{1,3}(?:,\d{3}){2,}(?![\p{Nd}]|,\p{Nd})/u;
const SHORT_NUMBER_LIST = /(?<![\p{Nd}_-])\d{1,3}(?:, \d{1,3}){2,}(?![\p{Nd}]|, ?\p{Nd})/u;
const PHONE_LIKE = /(?:[+＋]|%2[Bb]|(?<![\p{Nd}_-]))\p{Nd}(?:(?:%20|[\s().,;|#~=*_\-‐-―−－/\u00AD\u200B-\u200F\u061C\u2060\uFEFF])*\p{Nd}){6,}/u;
const KEEP = [RESOURCE_SID, ISO_DATE, UUID, THOUSANDS_NUMBER, SHORT_NUMBER_LIST].map((re) => re.source).join('|');
const KEEP_OR_PHONE = new RegExp(`(${KEEP})|${PHONE_LIKE.source}`, 'gu');

export const REDACTED = '[redacted]';

export function redactPhones(text: string): string {
  return text.replace(KEEP_OR_PHONE, (match, kept) => (kept ? match : REDACTED));
}

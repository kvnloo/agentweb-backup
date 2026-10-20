import { phoneDigits } from './smokeTestLead';

/**
 * ENG-2123. Identity rules for deduplicating EMAIL-LESS lead captures by phone number.
 *
 * Deliberately stricter than utils/smokeTestLead.isDedupablePhone (7 digits, length only), which the
 * portal mirrors and which must not move. Merging two rows is destructive (the second submission's
 * names, company and answers overwrite the first's), so the bar here is "could this plausibly be
 * ONE person's own number", and every doubt resolves to NO key, i.e. today's behaviour (a new row).
 */

const MIN_DIGITS = 10;
const MAX_DIGITS = 15; // E.164

/**
 * The key two submissions must share to be the same person, or '' when the number is not specific
 * enough to merge on. Never returns a non-empty string for junk, so it is also safe as a sparse
 * GSI key (DynamoDB rejects an empty-string index key; callers must omit the attribute on '').
 *
 * 10-digit numbers are treated as NANP: area code and exchange cannot begin with 0 or 1. That also
 * rejects some non-NANP 10-digit national formats (e.g. Australian mobiles written 04xx xxx xxx);
 * those simply keep today's no-dedupe behaviour.
 */
export function phoneDedupeKey(phone: unknown): string {
  const digits = phoneDigits(phone);
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return '';
  if (/^(\d)\1+$/.test(digits)) return ''; // 0000000000, 5555555555
  if (isSequential(digits)) return '';     // 1234567890, 0123456789, 9876543210
  if (digits.length === 10 && (digits[0] < '2' || digits[3] < '2')) return '';
  return digits;
}

function isSequential(digits: string): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < digits.length; i++) {
    const d = Number(digits[i]) - Number(digits[i - 1]);
    if (d !== 1 && d !== -9) up = false;
    if (d !== -1 && d !== 9) down = false;
    if (!up && !down) return false;
  }
  return true;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Two submissions on one number are DIFFERENT people when both state a first name (or both state a
 * last name) and they differ. One side being blank is not a conflict: a later step of a multi-step
 * lander often carries no name. A household, office or reception line is the case this protects.
 */
export function phoneNamesConflict(existing: any, incoming: any): boolean {
  for (const field of ['firstName', 'lastName'] as const) {
    const a = norm(existing?.[field]);
    const b = norm(incoming?.[field]);
    if (a && b && a !== b) return true;
  }
  return false;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const wellFormed = (v: string): string => v.replace(LONE_SURROGATE, '\uFFFD');

/** The normalized first+last name of a submission: the seed that lets same-named racers share one separate row. */
export function phoneNameSeed(lead: any): string {
  // encodeURIComponent keeps a literal '|' in a name from colliding with the field delimiter. It THROWS on a lone
  // surrogate (a name cut mid-emoji by a landing page), and this runs on the public capture route, so the name is
  // made well-formed first: the seed must be total, never a reason to lose a lead.
  return `${encodeURIComponent(wellFormed(norm(lead?.firstName)))}|${encodeURIComponent(wellFormed(norm(lead?.lastName)))}`;
}

/** More matches on one key than this means a shared line, not a repeat visitor: never merge. */
export const PHONE_FANOUT_CAP = 5;

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * A phone-matched repeat visit may only FILL blanks on the row it lands on. Phone identity is weaker than
 * email identity (a hand-entered lead, a shared line, anyone who knows the number), so it must never replace
 * a value a person or an earlier capture already stored. Existing non-blank keys always win.
 */
export function fillBlankCustomFields(existing: Record<string, any> | undefined, incoming: Record<string, any> | undefined): Record<string, any> {
  const merged: Record<string, any> = { ...(existing || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (isBlank(merged[k]) && !isBlank(v)) merged[k] = v;
  }
  return merged;
}

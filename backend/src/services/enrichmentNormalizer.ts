/**
 * Post-extraction value normalization for enrichment fills.
 *
 * Applied before persistFills() so all tiers (Apollo direct, LLM/Apollo,
 * LLM/web) produce consistent formats regardless of source.
 *
 * Money    → $X.XXB / $X.XXM / $X.XXK (human-readable, US format)
 * Dates    → MM/DD/YYYY (American format)
 * Phone    → E.164 international format, invalid/vanity numbers dropped
 * LinkedIn → person /in/ and company /company,school,showcase/ URLs only;
 *            malformed values (e.g. /search/ URLs) dropped
 */

import type { FieldFill } from './enrichmentGroupWaterfall';
import { sanitizePhone } from '../utils/phoneValidation';
import { isValidFieldValue } from './fieldValueValidator';

// ─── Field sets ───────────────────────────────────────────────────────────────

const PHONE_FIELDS = new Set(['phone', 'company_phone']);

const MONEY_FIELDS = new Set([
  'total_funding', 'valuation', 'total_funding_usd',
  'arr', 'mrr', 'annual_revenue', 'funding_amount',
]);

// Fields whose names end with these suffixes are treated as dates.
const DATE_SUFFIX_SNAKE = '_date';
const DATE_SUFFIX_CAMEL = 'Date';

function isDateField(field: string): boolean {
  return field.endsWith(DATE_SUFFIX_SNAKE) || field.endsWith(DATE_SUFFIX_CAMEL);
}

// ─── Money normalization ──────────────────────────────────────────────────────

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/trillion|T$/i, 1e12],
  [/billion|B$/i, 1e9],
  [/million|M$/i, 1e6],
  [/thousand|K$/i, 1e3],
];

function parseMoneyToNumber(raw: string): number | null {
  // Strip currency symbols, commas, whitespace
  let s = raw.replace(/[$,\s]/g, '');

  // Check for word/letter multipliers (e.g. "852 billion", "1.5B", "287.25M")
  for (const [pattern, mult] of MULTIPLIERS) {
    if (pattern.test(s)) {
      const numeric = parseFloat(s.replace(pattern, ''));
      if (!isNaN(numeric)) return numeric * mult;
    }
  }

  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export function normalizeMoney(raw: string): string {
  const n = parseMoneyToNumber(raw);
  if (n === null) return raw;

  if (n >= 1e12) return `$${(n / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(2).replace(/\.?0+$/, '')}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Date normalization ───────────────────────────────────────────────────────

// Handles: ISO full ("2026-03-01T00:00:00.000+00:00"), ISO date ("2025-10-14"),
// "14-Nov-2025", "Nov 14, 2025", "2025/10/14", already "MM/DD/YYYY"

// Month name → 0-based index. Used to avoid constructing Date from non-ISO strings
// (which V8 parses as local midnight, causing off-by-one via getUTCDate() in
// positive-offset timezones such as IST UTC+5:30).
const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

function monthNameToIndex(name: string): number | undefined {
  return MONTH_NAMES[name.toLowerCase().slice(0, 9)];
}

export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return raw;

  // Already MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;

  // "14-Nov-2025" or "14 Nov 2025" — parse without Date constructor to stay UTC-safe.
  const dmy = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (dmy) {
    const mi = monthNameToIndex(dmy[2]);
    if (mi !== undefined) {
      return `${String(mi + 1).padStart(2, '0')}/${dmy[1].padStart(2, '0')}/${dmy[3]}`;
    }
  }

  // "Nov 14, 2025" — parse without Date constructor to stay UTC-safe.
  const mdy = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const mi = monthNameToIndex(mdy[1]);
    if (mi !== undefined) {
      return `${String(mi + 1).padStart(2, '0')}/${mdy[2].padStart(2, '0')}/${mdy[3]}`;
    }
  }

  // ISO full datetime or date ("2025-10-14", "2026-03-01T00:00:00.000+00:00",
  // "2025/10/14"). These parse as UTC — safe to use getUTC* methods.
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  return raw; // can't parse — return as-is
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Normalize money and date values in fills before persisting.
 *
 * @param aliases  userFieldName → canonicalFieldName map (from EnrichmentConfig).
 *                 Used to resolve user-named fields (e.g. "totalFunding") to their
 *                 canonical equivalent ("total_funding") for type detection.
 */
export function normalizeFills(
  fills: FieldFill[],
  aliases: Record<string, string> = {},
): FieldFill[] {
  const out: FieldFill[] = [];
  for (const fill of fills) {
    const { field, value } = fill;
    if (!value) {
      out.push(fill);
      continue;
    }

    // Resolve to canonical: explicit alias > self
    const canonical = aliases[field] ?? field;

    if (PHONE_FIELDS.has(canonical)) {
      const normalized = sanitizePhone(value);
      // Drop the fill entirely when the value is not a valid phone number
      // (vanity numbers, free-text, garbage from LLM) rather than persisting
      // something undiallable.
      if (normalized === null) continue;
      out.push(normalized !== value ? { ...fill, value: normalized } : fill);
      continue;
    }

    if (MONEY_FIELDS.has(canonical)) {
      const normalized = normalizeMoney(value);
      out.push(normalized !== value ? { ...fill, value: normalized } : fill);
      continue;
    }

    if (isDateField(canonical)) {
      const normalized = normalizeDate(value);
      out.push(normalized !== value ? { ...fill, value: normalized } : fill);
      continue;
    }

    // LinkedIn URL fields: drop values that aren't a real profile URL of the
    // right kind (person /in/ vs company /company,/school,/showcase). Keyed on
    // `canonical` so a custom-named field aliased to linkedin_url /
    // company_linkedin_url is still covered. isValidFieldValue returns true for
    // every non-linkedin field, so this is a no-op for everything else.
    if (!isValidFieldValue(canonical, value)) {
      console.warn(
        `[normalizeFills] dropped fill field="${field}" canonical="${canonical}" ` +
        `— invalid LinkedIn URL: "${String(value).slice(0, 100)}"`,
      );
      continue;
    }

    out.push(fill);
  }
  return out;
}

/**
 * Post-extraction value normalization for enrichment fills.
 *
 * Applied before persistFills() so all tiers (Apollo direct, LLM/Apollo,
 * LLM/web) produce consistent formats regardless of source.
 *
 * Money  → $X.XXB / $X.XXM / $X.XXK (human-readable, US format)
 * Dates  → MM/DD/YYYY (American format)
 */

import type { FieldFill } from './enrichmentGroupWaterfall';

// ─── Field sets ───────────────────────────────────────────────────────────────

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
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return raw;

  // Already MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;

  // Try native Date parsing first (handles ISO and most standard formats)
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }

  // "14-Nov-2025" or "14 Nov 2025"
  const dmy = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{4})$/);
  if (dmy) {
    const attempt = new Date(`${dmy[2]} ${dmy[1]}, ${dmy[3]}`);
    if (!isNaN(attempt.getTime())) {
      const mm = String(attempt.getMonth() + 1).padStart(2, '0');
      const dd = String(attempt.getDate()).padStart(2, '0');
      return `${mm}/${dd}/${attempt.getFullYear()}`;
    }
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
  return fills.map(fill => {
    const { field, value } = fill;
    if (!value) return fill;

    // Resolve to canonical: explicit alias > self
    const canonical = aliases[field] ?? field;

    if (MONEY_FIELDS.has(canonical)) {
      const normalized = normalizeMoney(value);
      return normalized !== value ? { ...fill, value: normalized } : fill;
    }

    if (isDateField(canonical)) {
      const normalized = normalizeDate(value);
      return normalized !== value ? { ...fill, value: normalized } : fill;
    }

    return fill;
  });
}

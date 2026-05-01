/**
 * Per-field type registry. Drives normalization of LLM-extracted strings into
 * filterable / sortable / segmentable forms.
 *
 * Each spec returns:
 *   { value: <canonical raw form, may equal input>, normalized: <typed form for filters> }
 *
 * If normalization fails, normalized is null but value is preserved (we never
 * destroy data — UI can still show the raw text).
 */

export type Normalized =
  | string
  | number
  | { min: number; max: number }
  | null;

export interface FieldTypeSpec {
  kind: 'enum' | 'numeric_range' | 'numeric' | 'url' | 'date' | 'string';
  enumValues?: readonly string[];
  normalize: (raw: string) => { value: string | null; normalized: Normalized };
}

// ── Enum normalizers ──────────────────────────────────────────────────────────

const FUNDING_STAGES = [
  'Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D',
  'Series E', 'Series F', 'IPO', 'Public', 'Acquired', 'Bootstrapped',
] as const;

function normalizeEnum(values: readonly string[], raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  for (const v of values) {
    const vl = v.toLowerCase();
    if (lower === vl || lower.includes(vl) || vl.includes(lower)) return v;
  }
  // Specific aliases
  if (/bootstrap|bootstrapped|self-?fund/.test(lower)) return 'Bootstrapped';
  if (/ipo|public/.test(lower)) return values.includes('Public') ? 'Public' : null;
  return null;
}

// ── Numeric range normalizers ─────────────────────────────────────────────────

const REVENUE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '<$1M',     min: 0,           max: 1_000_000 },
  { label: '$1-10M',   min: 1_000_000,   max: 10_000_000 },
  { label: '$10-100M', min: 10_000_000,  max: 100_000_000 },
  { label: '$100M-1B', min: 100_000_000, max: 1_000_000_000 },
  { label: '$1B+',     min: 1_000_000_000, max: Number.MAX_SAFE_INTEGER },
];

/** Parse "$5M", "$1.2 billion", "1,000,000", "5K" to a number. Returns null on failure. */
export function parseMoneyToNumber(raw: string): number | null {
  const s = raw.replace(/[$,£€¥]/g, '').trim().toLowerCase();
  const m = s.match(/^([\d.]+)\s*(k|m|mm|million|b|bn|billion|t|trillion)?\b/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (isNaN(base)) return null;
  const unit = (m[2] || '').toLowerCase();
  switch (unit) {
    case 'k': return base * 1_000;
    case 'm': case 'mm': case 'million': return base * 1_000_000;
    case 'b': case 'bn': case 'billion': return base * 1_000_000_000;
    case 't': case 'trillion': return base * 1_000_000_000_000;
    default: return base;
  }
}

/** Parse "11-50", "~200", "200+", "100 to 500" to {min, max}. */
export function parseEmployeeCount(raw: string): { min: number; max: number } | null {
  const s = raw.replace(/employees?|people|staff/gi, '').replace(/,/g, '').trim();
  if (!s) return null;
  // Range "11-50" or "100 to 500"
  const rangeMatch = s.match(/(\d+)\s*(?:-|to|–|—)\s*(\d+)/i);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  // "200+"
  const plusMatch = s.match(/(\d+)\s*\+/);
  if (plusMatch) {
    const n = parseInt(plusMatch[1], 10);
    return { min: n, max: Number.MAX_SAFE_INTEGER };
  }
  // "~200" or "200" or "approximately 200"
  const singleMatch = s.match(/(?:about|approximately|approx|~)?\s*(\d+)/i);
  if (singleMatch) {
    const n = parseInt(singleMatch[1], 10);
    return { min: n, max: n };
  }
  return null;
}

// ── Specs ─────────────────────────────────────────────────────────────────────

export const FIELD_TYPES: Record<string, FieldTypeSpec> = {
  funding_stage: {
    kind: 'enum',
    enumValues: FUNDING_STAGES,
    normalize: (raw) => {
      const canonical = normalizeEnum(FUNDING_STAGES, raw);
      return { value: canonical ?? (raw.trim() || null), normalized: canonical };
    },
  },
  employee_count: {
    kind: 'numeric_range',
    normalize: (raw) => {
      const range = parseEmployeeCount(raw);
      return { value: (raw.trim() || null) as string | null, normalized: range };
    },
  },
  revenue_range: {
    kind: 'numeric_range',
    normalize: (raw) => {
      // Try to bucket into a known revenue range
      const num = parseMoneyToNumber(raw);
      if (num !== null) {
        for (const bucket of REVENUE_BUCKETS) {
          if (num >= bucket.min && num < bucket.max) {
            return { value: bucket.label, normalized: { min: bucket.min, max: bucket.max } };
          }
        }
      }
      // Fall back: keep raw, no normalization
      return { value: raw.trim() || null, normalized: null };
    },
  },
  total_funding: {
    kind: 'numeric',
    normalize: (raw) => ({ value: raw.trim() || null, normalized: parseMoneyToNumber(raw) }),
  },
  founded_year: {
    kind: 'numeric',
    normalize: (raw) => {
      const m = raw.match(/(19|20)\d{2}/);
      const n = m ? parseInt(m[0], 10) : null;
      return { value: raw.trim() || null, normalized: n };
    },
  },
  linkedin_url: {
    kind: 'url',
    normalize: (raw) => {
      const m = raw.match(/https?:\/\/(?:[a-z]{0,3}\.)?linkedin\.com\/in\/[^\s"?#]+/i);
      return { value: m ? m[0] : null, normalized: null };
    },
  },
  company_linkedin_url: {
    kind: 'url',
    normalize: (raw) => {
      const m = raw.match(/https?:\/\/(?:[a-z]{0,3}\.)?linkedin\.com\/company\/[^\s"?#]+/i);
      return { value: m ? m[0] : null, normalized: null };
    },
  },
};

/**
 * Apply field-type normalization. Returns a new map with normalized values
 * (and a sidecar map of normalized forms for caller's convenience).
 *
 * Fields without a spec pass through unchanged.
 */
export function normalizeFields(
  fields: Record<string, string | null>
): { fields: Record<string, string | null>; normalized: Record<string, Normalized> } {
  const out: Record<string, string | null> = { ...fields };
  const normalized: Record<string, Normalized> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const spec = FIELD_TYPES[key];
    if (!spec) continue;
    const result = spec.normalize(value);
    out[key] = result.value;
    if (result.normalized !== null) normalized[key] = result.normalized;
  }
  return { fields: out, normalized };
}

/**
 * ENG-2532 (child of ENG-2167): pure CSV lead-import parser for drip-sequence enrollment.
 *
 * Parses an uploaded CSV into normalized enrollment candidates plus per-row rejections.
 * No persistence, network, or sending — the caller owns enrollment writes.
 */

export type CsvRejectReason =
  | 'missing_email_column'
  | 'invalid_email'
  | 'suppressed'
  | 'row_limit';

export interface EnrollmentCandidate {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  tags: string[];
}

export interface CsvRejection {
  /** 1-based data row number (header excluded). */
  row: number;
  reason: CsvRejectReason;
}

export interface ParseEnrollmentCsvOptions {
  /** Emails that must not be enrolled (do-not-email list, existing enrollments). */
  excludeEmails?: Iterable<string>;
  /** Maximum data rows processed; overflow rows are rejected `row_limit`. Default 5000. */
  maxRows?: number;
}

export interface ParseEnrollmentCsvResult {
  candidates: EnrollmentCandidate[];
  rejected: CsvRejection[];
  duplicates: number;
}

export const DEFAULT_MAX_ROWS = 5000;

type Field = 'email' | 'firstName' | 'lastName' | 'company' | 'tags';

const HEADER_ALIASES: Record<string, Field> = {
  email: 'email',
  emailaddress: 'email',
  firstname: 'firstName',
  lastname: 'lastName',
  company: 'company',
  companyname: 'company',
  tags: 'tags',
  tag: 'tags',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

/** RFC 4180-style tokenizer: quoted fields, escaped quotes, CRLF/LF, embedded newlines. */
export function tokenizeCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

export function parseEnrollmentCsv(
  csvText: string,
  opts: ParseEnrollmentCsvOptions = {},
): ParseEnrollmentCsvResult {
  const rows = tokenizeCsv(csvText);
  const result: ParseEnrollmentCsvResult = { candidates: [], rejected: [], duplicates: 0 };
  if (rows.length === 0) return result;

  const [header, ...data] = rows;
  const columns: Partial<Record<Field, number>> = {};
  header.forEach((h, idx) => {
    const field = HEADER_ALIASES[normalizeHeader(h)];
    if (field && columns[field] === undefined) columns[field] = idx;
  });

  if (columns.email === undefined) {
    result.rejected = data.map((_, i) => ({ row: i + 1, reason: 'missing_email_column' }));
    return result;
  }

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const excluded = new Set(
    Array.from(opts.excludeEmails ?? [], (e) => e.trim().toLowerCase()),
  );
  const byEmail = new Map<string, EnrollmentCandidate>();
  const get = (r: string[], f: Field): string | undefined => {
    const idx = columns[f];
    if (idx === undefined) return undefined;
    const v = (r[idx] ?? '').trim();
    return v === '' ? undefined : v;
  };

  data.forEach((r, i) => {
    const rowNum = i + 1;
    if (i >= maxRows) {
      result.rejected.push({ row: rowNum, reason: 'row_limit' });
      return;
    }
    const email = (get(r, 'email') ?? '').toLowerCase();
    if (!EMAIL_RE.test(email)) {
      result.rejected.push({ row: rowNum, reason: 'invalid_email' });
      return;
    }
    if (excluded.has(email)) {
      result.rejected.push({ row: rowNum, reason: 'suppressed' });
      return;
    }
    const tags = splitTags(get(r, 'tags'));
    const existing = byEmail.get(email);
    if (existing) {
      result.duplicates++;
      for (const t of tags) if (!existing.tags.includes(t)) existing.tags.push(t);
      return;
    }
    const candidate: EnrollmentCandidate = { email, tags: Array.from(new Set(tags)) };
    const firstName = get(r, 'firstName');
    const lastName = get(r, 'lastName');
    const company = get(r, 'company');
    if (firstName) candidate.firstName = firstName;
    if (lastName) candidate.lastName = lastName;
    if (company) candidate.company = company;
    byEmail.set(email, candidate);
    result.candidates.push(candidate);
  });

  return result;
}

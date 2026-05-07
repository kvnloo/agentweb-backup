/**
 * CSV column → Lead field auto-matcher.
 * Used by the import wizard preview endpoint to suggest a default mapping
 * the user can override.
 */

export type LeadField =
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'company'
  | 'title'
  | 'linkedin'
  | 'companyLinkedin'
  | 'notes';

export type MappingTarget = LeadField | 'skip';

export interface MappingSuggestion {
  field: MappingTarget;
  confidence: 'high' | 'medium' | 'low';
  splitFullName?: boolean;
}

const FIELD_SYNONYMS: Record<LeadField, string[]> = {
  email: ['email', 'e-mail', 'e_mail', 'email address', 'work email', 'business email', 'mail'],
  firstName: ['first name', 'firstname', 'first', 'given name', 'fname', 'first_name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name', 'lname', 'last_name'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'cellphone', 'telephone', 'tel', 'mobile number'],
  company: ['company', 'company name', 'organization', 'organisation', 'org', 'employer', 'account', 'account name'],
  title: ['title', 'job title', 'role', 'position', 'job', 'job role'],
  linkedin: [
    'linkedin',
    'linkedin url',
    'linkedin profile',
    'linkedin profile url',
    'li url',
    'li profile',
    'personal linkedin',
  ],
  companyLinkedin: [
    'company linkedin',
    'co linkedin',
    'co. linkedin',
    'company linkedin url',
    'company linkedin profile',
    'org linkedin',
    'organization linkedin',
    'company li',
  ],
  notes: ['notes', 'note', 'comments', 'comment', 'description', 'remarks'],
};

const FULL_NAME_SYNONYMS = ['full name', 'name', 'contact name', 'fullname'];

// Normalize the synonym tables once so headers and synonyms are compared in
// the same canonical form (lowercase, punctuation stripped, whitespace collapsed).
const NORMALIZED_FIELD_SYNONYMS: Record<LeadField, string[]> = Object.fromEntries(
  (Object.keys(FIELD_SYNONYMS) as LeadField[]).map((field) => [
    field,
    FIELD_SYNONYMS[field].map((s) => normalize(s)),
  ]),
) as Record<LeadField, string[]>;

const NORMALIZED_FULL_NAME_SYNONYMS = FULL_NAME_SYNONYMS.map((s) => normalize(s));

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._\-]+/g, ' ')
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

interface MatchResult {
  field: MappingTarget;
  confidence: 'high' | 'medium' | 'low';
}

function matchHeader(header: string): MatchResult {
  const norm = normalize(header);

  // Exact synonym match → high confidence.
  // Iterate companyLinkedin BEFORE linkedin so "company linkedin" doesn't get
  // grabbed as a fuzzy match for "linkedin".
  const fieldOrder: LeadField[] = [
    'email',
    'firstName',
    'lastName',
    'companyLinkedin',
    'linkedin',
    'phone',
    'company',
    'title',
    'notes',
  ];

  for (const field of fieldOrder) {
    if (NORMALIZED_FIELD_SYNONYMS[field].includes(norm)) {
      return { field, confidence: 'high' };
    }
  }

  // Substring containment for compound names ("business email address").
  for (const field of fieldOrder) {
    for (const syn of NORMALIZED_FIELD_SYNONYMS[field]) {
      if (norm === syn) continue; // already checked
      if (norm.includes(syn) && syn.length >= 4) {
        return { field, confidence: 'high' };
      }
    }
  }

  // Fuzzy (Levenshtein ≤ 2 for short, ≤ 3 for longer) → medium confidence.
  let best: { field: MappingTarget; distance: number } = { field: 'skip', distance: Infinity };
  for (const field of fieldOrder) {
    for (const syn of NORMALIZED_FIELD_SYNONYMS[field]) {
      const d = levenshtein(norm, syn);
      const tolerance = syn.length <= 5 ? 1 : syn.length <= 10 ? 2 : 3;
      if (d <= tolerance && d < best.distance) {
        best = { field, distance: d };
      }
    }
  }
  if (best.field !== 'skip') {
    return { field: best.field, confidence: 'medium' };
  }

  return { field: 'skip', confidence: 'low' };
}

/**
 * Suggest a column→field mapping for a CSV's header row.
 *
 * Rules:
 * - First occurrence wins per target field (avoids two CSV columns both
 *   writing to e.g. `email`).
 * - "Full Name"/"Name" is mapped to firstName + splitFullName=true *only* if
 *   no explicit first/last name column was found.
 */
export function suggestColumnMapping(headers: string[]): Record<string, MappingSuggestion> {
  const result: Record<string, MappingSuggestion> = {};
  const claimedFields = new Set<MappingTarget>();
  const fullNameHeaders: string[] = [];

  // Pass 1: classify each header.
  const provisional: { header: string; match: MatchResult; isFullName: boolean }[] = [];
  for (const header of headers) {
    const norm = normalize(header);
    const isFullName = NORMALIZED_FULL_NAME_SYNONYMS.includes(norm);
    if (isFullName) {
      fullNameHeaders.push(header);
      provisional.push({ header, match: { field: 'skip', confidence: 'low' }, isFullName: true });
      continue;
    }
    provisional.push({ header, match: matchHeader(header), isFullName: false });
  }

  // Pass 2: enforce first-occurrence-wins.
  for (const { header, match, isFullName } of provisional) {
    if (isFullName) continue;
    if (match.field !== 'skip' && claimedFields.has(match.field)) {
      result[header] = { field: 'skip', confidence: 'low' };
      continue;
    }
    if (match.field !== 'skip') claimedFields.add(match.field);
    result[header] = { field: match.field, confidence: match.confidence };
  }

  // Pass 3: handle full-name headers. Split into first/last only if neither is
  // already claimed by another column.
  const hasFirst = claimedFields.has('firstName');
  const hasLast = claimedFields.has('lastName');
  for (const header of fullNameHeaders) {
    if (!hasFirst && !hasLast) {
      result[header] = { field: 'firstName', confidence: 'medium', splitFullName: true };
      claimedFields.add('firstName');
      claimedFields.add('lastName');
    } else {
      result[header] = { field: 'skip', confidence: 'low' };
    }
  }

  return result;
}

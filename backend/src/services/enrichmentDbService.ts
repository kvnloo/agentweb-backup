import AWS from 'aws-sdk';
import '../config/aws';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-EnrichmentDB`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EnrichedField {
  value: string | number | string[];
  source: string;
  lastVerifiedAt: string;
  confidenceScore: number;
  expiresAt: string;
}

export interface PersonEnrichmentRecord {
  pk: string;
  sk: 'META';
  email: string;
  linkedinUrl?: string;
  domain?: string;
  normalizedFullName?: string;
  fields: Partial<Record<PersonFieldName, EnrichedField>>;
  enrichmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyEnrichmentRecord {
  pk: string;
  sk: 'META';
  domain: string;
  normalizedCompanyName: string;
  fields: Partial<Record<CompanyFieldName, EnrichedField>>;
  enrichmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export type PersonFieldName =
  | 'firstName'
  | 'lastName'
  | 'jobTitle'
  | 'company'
  | 'department'
  | 'seniority'
  | 'phone'
  | 'linkedinUrl';

export type CompanyFieldName =
  | 'companyName'
  | 'employeeCount'
  | 'industry'
  | 'description'
  | 'linkedinCompanyUrl'
  | 'techStack'
  | 'funding'
  | 'revenue'
  | 'foundedYear'
  | 'headquarters';

export interface PersonLookupParams {
  email?: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  companyName?: string;
}

export interface CompanyLookupParams {
  domain?: string;
  companyName?: string;
}

// ─── TTL constants (days) ────────────────────────────────────────────────────

const FIELD_TTL_DAYS: Record<PersonFieldName | CompanyFieldName, number> = {
  // Person — fast-changing
  jobTitle: 45,
  company: 45,
  linkedinUrl: 30,
  department: 60,
  seniority: 60,
  phone: 60,
  // Person — stable
  firstName: 180,
  lastName: 180,
  // Company — moderate
  employeeCount: 75,
  techStack: 75,
  description: 90,
  linkedinCompanyUrl: 60,
  funding: 105,
  revenue: 105,
  headquarters: 120,
  // Company — stable
  companyName: 180,
  industry: 180,
  foundedYear: 365,
};

// Per-field source authority: index 0 = most trusted
const SOURCE_AUTHORITY: Partial<Record<PersonFieldName | CompanyFieldName, string[]>> = {
  linkedinUrl: ['linkedin', 'web_search'],
  jobTitle: ['linkedin', 'web_search'],
  firstName: ['linkedin', 'web_search'],
  lastName: ['linkedin', 'web_search'],
  department: ['linkedin', 'web_search'],
  seniority: ['linkedin', 'web_search'],
  employeeCount: ['web_search', 'linkedin'],
  techStack: ['web_search'],
  funding: ['web_search'],
  revenue: ['web_search'],
  industry: ['linkedin', 'web_search'],
  companyName: ['web_search', 'linkedin'],
};

const FUZZY_THRESHOLD = 0.80;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = /\b(inc|corp|corporation|llc|ltd|limited|co|company|plc|gmbh|srl|bv|ag|sa)\b\.?/gi;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(LEGAL_SUFFIXES, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeFullName(firstName: string, lastName: string): string {
  return `${lastName.trim().toLowerCase()}#${firstName.trim().toLowerCase()}`;
}

/**
 * Jaro-Winkler similarity in [0, 1]. Case-insensitive.
 */
export function computeSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();

  if (s1 === s2) return 1;
  if (s1.length === 0 && s2.length === 0) return 1;

  const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);

  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Winkler boost: reward common prefix up to 4 chars
  let prefix = 0;
  for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

export function isFieldFresh(field: EnrichedField): boolean {
  if (!field.expiresAt) return false;
  return new Date(field.expiresAt) > new Date();
}

function makeExpiresAt(fieldName: string): string {
  const days = FIELD_TTL_DAYS[fieldName as PersonFieldName | CompanyFieldName] ?? 60;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * Conflict resolution: returns whichever field value should win.
 * Order: recency (>7 day gap) → source authority → confidence score.
 */
export function resolveConflict(
  existing: EnrichedField,
  incoming: EnrichedField,
  fieldName: string,
): EnrichedField {
  const existingDate = new Date(existing.lastVerifiedAt).getTime();
  const incomingDate = new Date(incoming.lastVerifiedAt).getTime();
  const daysDiff = (incomingDate - existingDate) / 86_400_000;

  // 1. Recency: more than 7-day gap → newer wins
  if (daysDiff > 7) return incoming;
  if (daysDiff < -7) return existing;

  // 2. Source authority
  const authority = SOURCE_AUTHORITY[fieldName as PersonFieldName | CompanyFieldName];
  if (authority) {
    const existingRank = authority.indexOf(existing.source);
    const incomingRank = authority.indexOf(incoming.source);
    const effectiveExisting = existingRank === -1 ? Infinity : existingRank;
    const effectiveIncoming = incomingRank === -1 ? Infinity : incomingRank;
    if (effectiveIncoming < effectiveExisting) return incoming;
    if (effectiveExisting < effectiveIncoming) return existing;
  }

  // 3. Confidence score tiebreaker
  return incoming.confidenceScore > existing.confidenceScore ? incoming : existing;
}

// ─── DynamoDB helpers ─────────────────────────────────────────────────────────

async function getPersonByEmail(email: string): Promise<PersonEnrichmentRecord | null> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { pk: `PERSON#${email}`, sk: 'META' } })
    .promise();
  return (result.Item as PersonEnrichmentRecord) ?? null;
}

async function getPersonByLinkedinUrl(linkedinUrl: string): Promise<PersonEnrichmentRecord | null> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'linkedinUrl-index',
      KeyConditionExpression: 'linkedinUrl = :url',
      ExpressionAttributeValues: { ':url': linkedinUrl },
      Limit: 1,
    })
    .promise();
  return (result.Items?.[0] as PersonEnrichmentRecord) ?? null;
}

async function getPersonByNameAndDomain(
  normalizedFullName: string,
  domain: string,
): Promise<PersonEnrichmentRecord | null> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'domain-normalizedName-index',
      KeyConditionExpression: '#domain = :domain AND normalizedFullName = :name',
      ExpressionAttributeNames: { '#domain': 'domain' },
      ExpressionAttributeValues: { ':domain': domain, ':name': normalizedFullName },
      Limit: 1,
    })
    .promise();
  return (result.Items?.[0] as PersonEnrichmentRecord) ?? null;
}

async function getCompaniesByNormalizedName(
  normalizedName: string,
): Promise<CompanyEnrichmentRecord[]> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'normalizedCompanyName-index',
      KeyConditionExpression: 'normalizedCompanyName = :name',
      ExpressionAttributeValues: { ':name': normalizedName },
    })
    .promise();
  return (result.Items ?? []) as CompanyEnrichmentRecord[];
}

async function getCompanyByDomain(domain: string): Promise<CompanyEnrichmentRecord | null> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { pk: `COMPANY#${domain}`, sk: 'META' } })
    .promise();
  return (result.Item as CompanyEnrichmentRecord) ?? null;
}

// ─── Lookup — 4-step person cascade ──────────────────────────────────────────

export async function lookupPerson(
  params: PersonLookupParams,
): Promise<PersonEnrichmentRecord | null> {
  const { email, linkedinUrl, firstName, lastName, domain, companyName } = params;

  // Step 1: exact email
  if (email) {
    const hit = await getPersonByEmail(email.toLowerCase().trim());
    if (hit) return hit;
  }

  // Step 2: LinkedIn URL
  if (linkedinUrl) {
    const hit = await getPersonByLinkedinUrl(linkedinUrl);
    if (hit) return hit;
  }

  // Step 3: name + domain
  if (firstName && lastName && domain) {
    const normalizedName = normalizeFullName(firstName, lastName);
    const hit = await getPersonByNameAndDomain(normalizedName, domain);
    if (hit) return hit;
  }

  // Step 4: name + fuzzy company name → derive domain → name+domain lookup
  if (firstName && lastName && companyName) {
    const company = await lookupCompany({ companyName });
    if (company) {
      const normalizedName = normalizeFullName(firstName, lastName);
      const hit = await getPersonByNameAndDomain(normalizedName, company.domain);
      if (hit) return hit;
    }
  }

  return null;
}

// ─── Lookup — 2-step company cascade ─────────────────────────────────────────

export async function lookupCompany(
  params: CompanyLookupParams,
): Promise<CompanyEnrichmentRecord | null> {
  const { domain, companyName } = params;

  // Step 1: exact domain
  if (domain) {
    const hit = await getCompanyByDomain(domain.toLowerCase().trim());
    if (hit) return hit;
  }

  // Step 2: fuzzy company name
  if (companyName) {
    const normalizedInput = normalizeCompanyName(companyName);
    const candidates = await getCompaniesByNormalizedName(normalizedInput);

    // Exact normalized match first
    const exactMatch = candidates.find(c => c.normalizedCompanyName === normalizedInput);
    if (exactMatch) return exactMatch;

    // Jaro-Winkler fuzzy match
    let best: CompanyEnrichmentRecord | null = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = computeSimilarity(normalizedInput, candidate.normalizedCompanyName);
      if (score >= FUZZY_THRESHOLD && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) return best;
  }

  return null;
}

// ─── Upsert helpers ───────────────────────────────────────────────────────────

function buildFieldRecord(
  fieldName: string,
  value: string | number | string[],
  source: string,
  confidenceScore = 0.85,
): EnrichedField {
  return {
    value,
    source,
    lastVerifiedAt: new Date().toISOString(),
    confidenceScore,
    expiresAt: makeExpiresAt(fieldName),
  };
}

function mergeFields<F extends string>(
  existing: Partial<Record<F, EnrichedField>>,
  incoming: Partial<Record<F, EnrichedField>>,
): Partial<Record<F, EnrichedField>> {
  const merged: Partial<Record<F, EnrichedField>> = { ...existing };
  for (const key of Object.keys(incoming) as F[]) {
    const incomingField = incoming[key]!;
    const existingField = existing[key];
    merged[key] = existingField ? resolveConflict(existingField, incomingField, key) : incomingField;
  }
  return merged;
}

// ─── upsertPerson ─────────────────────────────────────────────────────────────

export async function upsertPerson(
  email: string,
  fields: Partial<Record<PersonFieldName, string | number | string[]>>,
  source: string,
  confidenceOverrides: Partial<Record<PersonFieldName, number>> = {},
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await getPersonByEmail(normalizedEmail);
  const now = new Date().toISOString();

  // Build incoming field records
  const incomingFields: Partial<Record<PersonFieldName, EnrichedField>> = {};
  for (const [key, value] of Object.entries(fields) as [PersonFieldName, string | number | string[]][]) {
    if (value !== undefined && value !== null) {
      incomingFields[key] = buildFieldRecord(
        key,
        value,
        source,
        confidenceOverrides[key] ?? 0.85,
      );
    }
  }

  const mergedFields = existing
    ? mergeFields(existing.fields, incomingFields)
    : incomingFields;

  // Derive top-level GSI attributes from fields
  const linkedinUrlField = mergedFields.linkedinUrl ?? existing?.fields.linkedinUrl;
  const firstNameField = mergedFields.firstName ?? existing?.fields.firstName;
  const lastNameField = mergedFields.lastName ?? existing?.fields.lastName;

  const topLevelLinkedinUrl =
    typeof linkedinUrlField?.value === 'string' ? linkedinUrlField.value : existing?.linkedinUrl;

  const firstName =
    (fields.firstName as string) ?? (existing?.fields.firstName?.value as string);
  const lastName =
    (fields.lastName as string) ?? (existing?.fields.lastName?.value as string);
  const normalizedFullName =
    firstName && lastName ? normalizeFullName(firstName, lastName) : existing?.normalizedFullName;

  const emailDomain = normalizedEmail.includes('@') ? normalizedEmail.split('@')[1] : undefined;

  const record: PersonEnrichmentRecord = {
    pk: `PERSON#${normalizedEmail}`,
    sk: 'META',
    email: normalizedEmail,
    ...(topLevelLinkedinUrl ? { linkedinUrl: topLevelLinkedinUrl } : {}),
    ...(emailDomain ? { domain: emailDomain } : {}),
    ...(normalizedFullName ? { normalizedFullName } : {}),
    fields: mergedFields,
    enrichmentCount: (existing?.enrichmentCount ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();
}

// ─── upsertCompany ────────────────────────────────────────────────────────────

export async function upsertCompany(
  domain: string,
  fields: Partial<Record<CompanyFieldName, string | number | string[]>>,
  source: string,
  confidenceOverrides: Partial<Record<CompanyFieldName, number>> = {},
): Promise<void> {
  const normalizedDomain = domain.toLowerCase().trim();
  const existing = await getCompanyByDomain(normalizedDomain);
  const now = new Date().toISOString();

  const incomingFields: Partial<Record<CompanyFieldName, EnrichedField>> = {};
  for (const [key, value] of Object.entries(fields) as [CompanyFieldName, string | number | string[]][]) {
    if (value !== undefined && value !== null) {
      incomingFields[key] = buildFieldRecord(
        key,
        value,
        source,
        confidenceOverrides[key] ?? 0.85,
      );
    }
  }

  const mergedFields = existing
    ? mergeFields(existing.fields, incomingFields)
    : incomingFields;

  // normalizedCompanyName: prefer the incoming companyName if provided, else keep existing
  const companyNameValue =
    (fields.companyName as string) ??
    (existing?.fields.companyName?.value as string) ??
    normalizedDomain;
  const normalizedCompanyName = normalizeCompanyName(companyNameValue);

  const record: CompanyEnrichmentRecord = {
    pk: `COMPANY#${normalizedDomain}`,
    sk: 'META',
    domain: normalizedDomain,
    normalizedCompanyName,
    fields: mergedFields,
    enrichmentCount: (existing?.enrichmentCount ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();
}

// ─── Output field → DB field mapping ─────────────────────────────────────────

const PERSON_FIELD_PATTERNS: Array<[RegExp, PersonFieldName]> = [
  [/^first/i, 'firstName'],
  [/^last/i, 'lastName'],
  [/job.?title|^title$|^position$|^role$/i, 'jobTitle'],
  [/linkedin.*url|^linkedin$|personal.*linkedin|lead.*linkedin/i, 'linkedinUrl'],
  [/^phone|mobile/i, 'phone'],
  [/department|^dept$/i, 'department'],
  [/seniority|^level$/i, 'seniority'],
];

const COMPANY_FIELD_PATTERNS: Array<[RegExp, CompanyFieldName]> = [
  [/^company.*name$|^company$|^organization$/i, 'companyName'],
  [/employee|headcount|team.?size/i, 'employeeCount'],
  [/^industry$|^sector$|^vertical$/i, 'industry'],
  [/funding/i, 'funding'],
  [/^revenue$|^arr$|^mrr$|annual.?revenue/i, 'revenue'],
  [/tech.?stack|technolog|^tools$/i, 'techStack'],
  [/^description$|^about$|^overview$|^summary$/i, 'description'],
  [/headquarters|^hq$|^location$|^city$|^country$/i, 'headquarters'],
  [/founded|founding.?year|founded.?year/i, 'foundedYear'],
  [/company.*linkedin|linkedin.*company/i, 'linkedinCompanyUrl'],
];

export function mapOutputFieldToPersonField(fieldName: string): PersonFieldName | null {
  for (const [pattern, dbField] of PERSON_FIELD_PATTERNS) {
    if (pattern.test(fieldName)) return dbField;
  }
  return null;
}

export function mapOutputFieldToCompanyField(fieldName: string): CompanyFieldName | null {
  for (const [pattern, dbField] of COMPANY_FIELD_PATTERNS) {
    if (pattern.test(fieldName)) return dbField;
  }
  return null;
}

/**
 * Returns a map of output field name → cached value for all fields that have fresh cache.
 */
export function getCachedFieldValues(
  outputFields: string[],
  freshPersonFields: Partial<Record<PersonFieldName, string | number | string[]>>,
  freshCompanyFields: Partial<Record<CompanyFieldName, string | number | string[]>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of outputFields) {
    const personField = mapOutputFieldToPersonField(field);
    if (personField && freshPersonFields[personField] !== undefined) {
      result[field] = String(freshPersonFields[personField]);
      continue;
    }
    const companyField = mapOutputFieldToCompanyField(field);
    if (companyField && freshCompanyFields[companyField] !== undefined) {
      result[field] = String(freshCompanyFields[companyField]);
    }
  }
  return result;
}

/**
 * Builds a context string from fresh cached fields to inject into the LLM prompt.
 */
export function buildCachedEnrichmentContext(
  freshPersonFields: Partial<Record<PersonFieldName, string | number | string[]>>,
  freshCompanyFields: Partial<Record<CompanyFieldName, string | number | string[]>>,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(freshPersonFields)) {
    lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  for (const [key, value] of Object.entries(freshCompanyFields)) {
    lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  if (lines.length === 0) return '';
  return `Previously enriched data (high confidence — prefer these values):\n${lines.join('\n')}`;
}

// ─── getPersonFreshFields ─────────────────────────────────────────────────────

/**
 * Returns a map of field → cached value for all fields that are still fresh.
 * Used by enrichmentService to skip API calls for already-cached data.
 */
export function getPersonFreshFields(
  record: PersonEnrichmentRecord,
): Partial<Record<PersonFieldName, string | number | string[]>> {
  const result: Partial<Record<PersonFieldName, string | number | string[]>> = {};
  for (const [key, field] of Object.entries(record.fields) as [PersonFieldName, EnrichedField][]) {
    if (field && isFieldFresh(field)) {
      result[key] = field.value;
    }
  }
  return result;
}

export function getCompanyFreshFields(
  record: CompanyEnrichmentRecord,
): Partial<Record<CompanyFieldName, string | number | string[]>> {
  const result: Partial<Record<CompanyFieldName, string | number | string[]>> = {};
  for (const [key, field] of Object.entries(record.fields) as [CompanyFieldName, EnrichedField][]) {
    if (field && isFieldFresh(field)) {
      result[key] = field.value;
    }
  }
  return result;
}

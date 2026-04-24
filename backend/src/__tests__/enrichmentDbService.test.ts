/**
 * Unit tests for enrichmentDbService
 * Tests: normalizeCompanyName, normalizeFullName, computeSimilarity,
 *        isFieldFresh, resolveConflict, lookupPerson, lookupCompany,
 *        upsertPerson, upsertCompany
 */

const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({})),
}));

jest.mock('../config/aws', () => ({}));

import {
  normalizeCompanyName,
  normalizeFullName,
  computeSimilarity,
  isFieldFresh,
  resolveConflict,
  lookupPerson,
  lookupCompany,
  upsertPerson,
  upsertCompany,
  EnrichedField,
  PersonEnrichmentRecord,
  CompanyEnrichmentRecord,
} from '../services/enrichmentDbService';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeField(
  value: string,
  source = 'web_search',
  daysOld = 10,
  confidenceScore = 0.9,
  ttlDays = 45,
): EnrichedField {
  const lastVerifiedAt = new Date(Date.now() - daysOld * 86_400_000).toISOString();
  const expiresAt = new Date(Date.now() + (ttlDays - daysOld) * 86_400_000).toISOString();
  return { value, source, lastVerifiedAt, confidenceScore, expiresAt };
}

function makeExpiredField(value: string, source = 'web_search'): EnrichedField {
  return makeField(value, source, 60, 0.9, 45); // 60 days old, TTL 45 → expired
}

const NOW = new Date().toISOString();

const samplePerson: PersonEnrichmentRecord = {
  pk: 'PERSON#john@acme.com',
  sk: 'META',
  email: 'john@acme.com',
  linkedinUrl: 'https://www.linkedin.com/in/johndoe',
  domain: 'acme.com',
  normalizedFullName: 'doe#john',
  fields: {
    firstName: makeField('John', 'linkedin'),
    jobTitle: makeField('VP Engineering', 'linkedin'),
  },
  enrichmentCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const sampleCompany: CompanyEnrichmentRecord = {
  pk: 'COMPANY#acme.com',
  sk: 'META',
  domain: 'acme.com',
  normalizedCompanyName: 'acme',
  fields: {
    companyName: makeField('Acme Corp', 'web_search'),
    employeeCount: makeField('500', 'web_search'),
  },
  enrichmentCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

// ─── normalizeCompanyName ────────────────────────────────────────────────────

describe('normalizeCompanyName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCompanyName('  Acme  ')).toBe('acme');
  });

  it('removes common legal suffixes', () => {
    expect(normalizeCompanyName('Apple Inc')).toBe('apple');
    expect(normalizeCompanyName('Microsoft Corporation')).toBe('microsoft');
    expect(normalizeCompanyName('Widget LLC')).toBe('widget');
    expect(normalizeCompanyName('Global Ltd')).toBe('global');
    expect(normalizeCompanyName('Startup Co')).toBe('startup');
  });

  it('replaces & with and', () => {
    expect(normalizeCompanyName('Sales & Marketing Co')).toBe('sales and marketing');
  });

  it('removes punctuation', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeCompanyName('Big   Blue   Corp')).toBe('big blue');
  });

  it('handles already-clean names', () => {
    expect(normalizeCompanyName('stripe')).toBe('stripe');
  });
});

// ─── normalizeFullName ───────────────────────────────────────────────────────

describe('normalizeFullName', () => {
  it('returns lastName#firstName, lowercased', () => {
    expect(normalizeFullName('John', 'Doe')).toBe('doe#john');
  });

  it('trims whitespace', () => {
    expect(normalizeFullName(' Jane ', ' Smith ')).toBe('smith#jane');
  });

  it('handles empty parts gracefully', () => {
    expect(normalizeFullName('John', '')).toBe('#john');
    expect(normalizeFullName('', 'Doe')).toBe('doe#');
  });
});

// ─── computeSimilarity ──────────────────────────────────────────────────────

describe('computeSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(computeSimilarity('apple', 'apple')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(computeSimilarity('abc', 'xyz')).toBeLessThan(0.5);
  });

  it('returns high score for close strings', () => {
    expect(computeSimilarity('acme corp', 'acme')).toBeGreaterThan(0.7);
  });

  it('is case-insensitive', () => {
    expect(computeSimilarity('Apple', 'apple')).toBe(1);
  });

  it('returns 1 for empty strings', () => {
    expect(computeSimilarity('', '')).toBe(1);
  });

  it('penalises very different lengths', () => {
    expect(computeSimilarity('a', 'abcdefghij')).toBeLessThan(0.9);
  });
});

// ─── isFieldFresh ────────────────────────────────────────────────────────────

describe('isFieldFresh', () => {
  it('returns true when expiresAt is in the future', () => {
    const field = makeField('VP Engineering', 'linkedin', 10, 0.9, 45);
    expect(isFieldFresh(field)).toBe(true);
  });

  it('returns false when expiresAt is in the past', () => {
    const field = makeExpiredField('Old Title');
    expect(isFieldFresh(field)).toBe(false);
  });

  it('returns false when expiresAt is missing', () => {
    const field = makeField('VP Engineering');
    (field as any).expiresAt = undefined;
    expect(isFieldFresh(field)).toBe(false);
  });
});

// ─── resolveConflict ────────────────────────────────────────────────────────

describe('resolveConflict', () => {
  it('keeps existing when incoming is older by more than 7 days', () => {
    const existing = makeField('CEO', 'linkedin', 5);
    const incoming = makeField('CTO', 'linkedin', 20);
    expect(resolveConflict(existing, incoming, 'jobTitle').value).toBe('CEO');
  });

  it('takes incoming when incoming is newer by more than 7 days', () => {
    const existing = makeField('CEO', 'linkedin', 30);
    const incoming = makeField('CTO', 'linkedin', 2);
    expect(resolveConflict(existing, incoming, 'jobTitle').value).toBe('CTO');
  });

  it('prefers higher-authority source when recency is within 7 days', () => {
    // linkedin has higher authority than web_search for jobTitle
    const existing = makeField('CEO', 'web_search', 3);
    const incoming = makeField('CTO', 'linkedin', 5);
    expect(resolveConflict(existing, incoming, 'jobTitle').value).toBe('CTO');
  });

  it('prefers higher confidence score as final tiebreaker', () => {
    const existing = makeField('CEO', 'web_search', 3, 0.7);
    const incoming = makeField('CTO', 'web_search', 5, 0.95);
    expect(resolveConflict(existing, incoming, 'jobTitle').value).toBe('CTO');
  });

  it('keeps existing when all factors are equal or favour existing', () => {
    const existing = makeField('CEO', 'linkedin', 1, 0.95);
    const incoming = makeField('CTO', 'web_search', 3, 0.7);
    expect(resolveConflict(existing, incoming, 'jobTitle').value).toBe('CEO');
  });
});

// ─── lookupPerson ────────────────────────────────────────────────────────────

describe('lookupPerson', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns null when no lookup params are provided', async () => {
    const result = await lookupPerson({});
    expect(result).toBeNull();
  });

  it('step 1: finds person by exact email', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: samplePerson }),
    });

    const result = await lookupPerson({ email: 'john@acme.com' });
    expect(result).toEqual(samplePerson);
    expect(mockDocumentClientMethods.get).toHaveBeenCalledWith(
      expect.objectContaining({ Key: { pk: 'PERSON#john@acme.com', sk: 'META' } }),
    );
  });

  it('step 1: returns null when email not found in DB', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    // no LinkedIn/name/domain provided → no fallback steps
    const result = await lookupPerson({ email: 'unknown@acme.com' });
    expect(result).toBeNull();
  });

  it('step 2: falls through to LinkedIn URL lookup when email miss', async () => {
    // email miss
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    // LinkedIn GSI hit
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [samplePerson] }),
    });

    const result = await lookupPerson({
      email: 'unknown@acme.com',
      linkedinUrl: 'https://www.linkedin.com/in/johndoe',
    });
    expect(result).toEqual(samplePerson);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
      expect.objectContaining({ IndexName: 'linkedinUrl-index' }),
    );
  });

  it('step 3: falls through to name + domain lookup when email and linkedin miss', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    // LinkedIn miss
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [] }),
    });
    // name+domain hit
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [samplePerson] }),
    });

    const result = await lookupPerson({
      email: 'unknown@acme.com',
      linkedinUrl: 'https://www.linkedin.com/in/nobody',
      firstName: 'John',
      lastName: 'Doe',
      domain: 'acme.com',
    });
    expect(result).toEqual(samplePerson);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
      expect.objectContaining({ IndexName: 'domain-normalizedName-index' }),
    );
  });

  it('step 4: fuzzy company name lookup when all prior steps miss', async () => {
    // No email/linkedinUrl/domain — only companyName → goes straight to company name lookup
    // 1st query: normalizedCompanyName-index → finds sampleCompany (exact normalized match 'acme')
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [sampleCompany] }),
    });
    // 2nd query: domain-normalizedName-index → finds samplePerson
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [samplePerson] }),
    });

    const result = await lookupPerson({
      firstName: 'John',
      lastName: 'Doe',
      companyName: 'Acme Corp',
    });
    expect(result).toEqual(samplePerson);
  });

  it('returns null when fuzzy match score is below 80%', async () => {
    // Only companyName provided — goes to company name lookup
    const differentCompany: CompanyEnrichmentRecord = {
      ...sampleCompany,
      normalizedCompanyName: 'totally different company xyz',
    };
    // 1st query: normalizedCompanyName-index → returns low-similarity company
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [differentCompany] }),
    });

    const result = await lookupPerson({
      firstName: 'John',
      lastName: 'Doe',
      companyName: 'Acme',
    });
    expect(result).toBeNull();
  });
});

// ─── lookupCompany ───────────────────────────────────────────────────────────

describe('lookupCompany', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns null when no params provided', async () => {
    const result = await lookupCompany({});
    expect(result).toBeNull();
  });

  it('step 1: finds company by exact domain', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: sampleCompany }),
    });
    const result = await lookupCompany({ domain: 'acme.com' });
    expect(result).toEqual(sampleCompany);
    expect(mockDocumentClientMethods.get).toHaveBeenCalledWith(
      expect.objectContaining({ Key: { pk: 'COMPANY#acme.com', sk: 'META' } }),
    );
  });

  it('step 2: fuzzy company name match when domain misses', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [sampleCompany] }),
    });

    const result = await lookupCompany({ companyName: 'Acme Corp' });
    expect(result).toEqual(sampleCompany);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
      expect.objectContaining({ IndexName: 'normalizedCompanyName-index' }),
    );
  });

  it('returns null when fuzzy score is below threshold', async () => {
    // Only companyName → no domain get, goes straight to fuzzy name query
    const veryDifferent = { ...sampleCompany, normalizedCompanyName: 'zzz completely different zzz' };
    mockDocumentClientMethods.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [veryDifferent] }),
    });

    const result = await lookupCompany({ companyName: 'Acme' });
    expect(result).toBeNull();
  });
});

// ─── upsertPerson ────────────────────────────────────────────────────────────

describe('upsertPerson', () => {
  beforeEach(() => jest.resetAllMocks());

  it('creates a new record when none exists', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertPerson('john@acme.com', { jobTitle: 'CEO', firstName: 'John' }, 'linkedin');

    expect(mockDocumentClientMethods.put).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({
          pk: 'PERSON#john@acme.com',
          sk: 'META',
          email: 'john@acme.com',
          enrichmentCount: 1,
        }),
      }),
    );
  });

  it('merges new fields into existing record using conflict resolution', async () => {
    const existingWithOldTitle: PersonEnrichmentRecord = {
      ...samplePerson,
      fields: {
        jobTitle: makeField('Old Title', 'linkedin', 40), // 40 days old → stale candidate
      },
    };
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: existingWithOldTitle }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertPerson('john@acme.com', { jobTitle: 'New CEO' }, 'linkedin');

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.fields.jobTitle.value).toBe('New CEO');
    expect(putCall.Item.enrichmentCount).toBe(2);
  });

  it('preserves existing fresh field when incoming loses conflict resolution', async () => {
    const existingWithFreshTitle: PersonEnrichmentRecord = {
      ...samplePerson,
      fields: {
        jobTitle: makeField('Current CEO', 'linkedin', 1, 0.99), // very fresh, high confidence
      },
    };
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: existingWithFreshTitle }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertPerson('john@acme.com', { jobTitle: 'Old Role' }, 'web_search');

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.fields.jobTitle.value).toBe('Current CEO');
  });

  it('normalizes email to lowercase', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertPerson('JOHN@ACME.COM', { jobTitle: 'CEO' }, 'web_search');

    expect(mockDocumentClientMethods.put).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ pk: 'PERSON#john@acme.com', email: 'john@acme.com' }),
      }),
    );
  });

  it('sets linkedinUrl and normalizedFullName as top-level GSI attributes', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertPerson(
      'john@acme.com',
      { linkedinUrl: 'https://www.linkedin.com/in/johndoe', firstName: 'John', lastName: 'Doe' },
      'linkedin',
    );

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.linkedinUrl).toBe('https://www.linkedin.com/in/johndoe');
    expect(putCall.Item.normalizedFullName).toBe('doe#john');
  });
});

// ─── upsertCompany ────────────────────────────────────────────────────────────

describe('upsertCompany', () => {
  beforeEach(() => jest.resetAllMocks());

  it('creates a new record when none exists', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertCompany('acme.com', { companyName: 'Acme Corp', employeeCount: '500' }, 'web_search');

    expect(mockDocumentClientMethods.put).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({
          pk: 'COMPANY#acme.com',
          sk: 'META',
          domain: 'acme.com',
          normalizedCompanyName: 'acme',
          enrichmentCount: 1,
        }),
      }),
    );
  });

  it('sets normalizedCompanyName from companyName field', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: undefined }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertCompany('microsoft.com', { companyName: 'Microsoft Corporation' }, 'web_search');

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.normalizedCompanyName).toBe('microsoft');
  });

  it('increments enrichmentCount on each upsert', async () => {
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: sampleCompany }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertCompany('acme.com', { employeeCount: '600' }, 'web_search');

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.enrichmentCount).toBe(2);
  });

  it('applies conflict resolution to existing fields', async () => {
    const existingCompany: CompanyEnrichmentRecord = {
      ...sampleCompany,
      fields: {
        employeeCount: makeField('100', 'web_search', 70), // stale
      },
    };
    mockDocumentClientMethods.get.mockReturnValueOnce({
      promise: () => Promise.resolve({ Item: existingCompany }),
    });
    mockDocumentClientMethods.put.mockReturnValueOnce({
      promise: () => Promise.resolve({}),
    });

    await upsertCompany('acme.com', { employeeCount: '500' }, 'web_search');

    const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
    expect(putCall.Item.fields.employeeCount.value).toBe('500');
  });
});

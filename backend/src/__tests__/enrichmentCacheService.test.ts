// Tests for enrichmentCacheService.ts — cache read/write layer

const mockGetEnrichmentCacheItem = jest.fn();
const mockPutEnrichmentCacheItem = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentCacheItem: mockGetEnrichmentCacheItem,
    putEnrichmentCacheItem: mockPutEnrichmentCacheItem,
  },
}));

import {
  getRawDataFromCache,
  writeRawDataToCache,
  buildWebContextFromCache,
  buildLinkedInContextFromCache,
  splitFieldsByGroup,
} from '../services/enrichmentCacheService';
import type { RawCacheData } from '../services/enrichmentGroups';

const MOCK_RAW_DATA: RawCacheData = {
  webResults: [
    { title: 'Acme Corp', url: 'https://acme.com', snippet: 'A great company', publishedDate: '2026-01-01', thumbnail: null },
  ],
  linkedinCompanyResults: null,
  linkedinData: null,
};

const MOCK_PERSON_RAW_DATA: RawCacheData = {
  webResults: [],
  linkedinCompanyResults: null,
  linkedinData: {
    profileId: 'abc123',
    publicIdentifier: 'john-doe',
    rawProfile: { headline: 'CEO at Acme', name: 'John Doe' },
    fetchedAt: '2026-01-01T00:00:00.000Z',
  },
};

const VALID_LEAD = {
  email: 'john@acme.com',
  company: 'Acme Corp',
  firstName: 'John',
  lastName: 'Doe',
};

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── getRawDataFromCache ──────────────────────────────────────────────────────

describe('getRawDataFromCache', () => {
  // FAIL cases
  it('returns null for unknown group name', async () => {
    const result = await getRawDataFromCache(VALID_LEAD, 'nonexistent_group');
    expect(result).toBeNull();
    expect(mockGetEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('returns null when forceRefreshCache is true without calling DB', async () => {
    const result = await getRawDataFromCache(VALID_LEAD, 'company_firmographic', true);
    expect(result).toBeNull();
    expect(mockGetEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('returns null when lead has no usable canonical key', async () => {
    const result = await getRawDataFromCache({ email: 'x@gmail.com' }, 'company_firmographic');
    expect(result).toBeNull();
    expect(mockGetEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('returns null when DynamoDB returns no item (cache miss)', async () => {
    mockGetEnrichmentCacheItem.mockResolvedValue(null);
    const result = await getRawDataFromCache(VALID_LEAD, 'company_firmographic');
    expect(result).toBeNull();
  });

  it('returns null when cached item is expired', async () => {
    mockGetEnrichmentCacheItem.mockResolvedValue({
      rawData: MOCK_RAW_DATA,
      expiresAt: nowSec() - 100,  // expired 100 seconds ago
    });
    const result = await getRawDataFromCache(VALID_LEAD, 'company_firmographic');
    expect(result).toBeNull();
  });

  // SUCCESS case
  it('returns rawData when cache hit is valid and not expired', async () => {
    mockGetEnrichmentCacheItem.mockResolvedValue({
      rawData: MOCK_RAW_DATA,
      expiresAt: nowSec() + 86400,  // valid for 24 more hours
    });
    const result = await getRawDataFromCache(VALID_LEAD, 'company_firmographic');
    expect(result).toEqual(MOCK_RAW_DATA);
  });

  it('calls DB with correct SHA256 canonicalId and fieldGroup SK', async () => {
    mockGetEnrichmentCacheItem.mockResolvedValue(null);
    await getRawDataFromCache(VALID_LEAD, 'company_firmographic');
    expect(mockGetEnrichmentCacheItem).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),  // SHA256 hex
      'company_firmographic#v1'
    );
  });
});

// ─── writeRawDataToCache ──────────────────────────────────────────────────────

describe('writeRawDataToCache', () => {
  // FAIL cases
  it('does not write when group name is unknown', async () => {
    await writeRawDataToCache(VALID_LEAD, 'nonexistent_group', MOCK_RAW_DATA, 'query', ['web_search']);
    expect(mockPutEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('does not write when lead has no usable canonical key', async () => {
    await writeRawDataToCache({ email: 'x@gmail.com' }, 'company_firmographic', MOCK_RAW_DATA, 'query', ['web_search']);
    expect(mockPutEnrichmentCacheItem).not.toHaveBeenCalled();
  });

  it('does not throw when putEnrichmentCacheItem rejects (race condition)', async () => {
    const err: any = new Error('ConditionalCheckFailedException');
    err.code = 'ConditionalCheckFailedException';
    mockPutEnrichmentCacheItem.mockRejectedValue(err);
    await expect(
      writeRawDataToCache(VALID_LEAD, 'company_firmographic', MOCK_RAW_DATA, 'query', ['web_search'])
    ).resolves.not.toThrow();
  });

  // SUCCESS case
  it('writes item with correct structure and TTL', async () => {
    mockPutEnrichmentCacheItem.mockResolvedValue(undefined);
    await writeRawDataToCache(VALID_LEAD, 'company_firmographic', MOCK_RAW_DATA, 'acme.com company overview', ['web_search']);

    expect(mockPutEnrichmentCacheItem).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: expect.stringMatching(/^[a-f0-9]{64}$/),
        fieldGroup: 'company_firmographic#v1',
        canonicalKey: 'company:acme.com',
        entityKey: 'acme.com',
        entityType: 'company',
        rawData: MOCK_RAW_DATA,
        queryUsed: 'acme.com company overview',
        sourcesUsed: ['web_search'],
        resultCount: 1,
        schemaVersion: 1,
        expiresAt: expect.any(Number),
        fetchedAt: expect.any(String),
      })
    );
  });

  it('sets expiresAt ~180 days from now for company_firmographic', async () => {
    mockPutEnrichmentCacheItem.mockResolvedValue(undefined);
    const before = nowSec();
    await writeRawDataToCache(VALID_LEAD, 'company_firmographic', MOCK_RAW_DATA, 'q', ['web_search']);
    const after = nowSec();

    const call = mockPutEnrichmentCacheItem.mock.calls[0][0];
    const expectedMin = before + 180 * 86400 - 5;
    const expectedMax = after + 180 * 86400 + 5;
    expect(call.expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(call.expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it('sets expiresAt ~30 days from now for intent_signals (positive hit)', async () => {
    mockPutEnrichmentCacheItem.mockResolvedValue(undefined);
    const before = nowSec();
    // Must be a NON-empty payload: empty results now get the short negative
    // TTL (WS4), so the group's full TTL only applies to a real hit. The
    // empty/negative case is covered in enrichmentCacheNegativeTtl.test.ts.
    await writeRawDataToCache(VALID_LEAD, 'intent_signals', MOCK_RAW_DATA, 'q', ['web_search']);
    const after = nowSec();

    const call = mockPutEnrichmentCacheItem.mock.calls[0][0];
    const expectedMin = before + 30 * 86400 - 5;
    const expectedMax = after + 30 * 86400 + 5;
    expect(call.expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(call.expiresAt).toBeLessThanOrEqual(expectedMax);
  });
});

// ─── buildWebContextFromCache ─────────────────────────────────────────────────

describe('buildWebContextFromCache', () => {
  it('serializes webResults as JSON string', () => {
    const ctx = buildWebContextFromCache(MOCK_RAW_DATA, false);
    expect(ctx).toContain('Acme Corp');
    expect(ctx).toContain('https://acme.com');
  });

  it('returns empty string when webResults is empty', () => {
    const ctx = buildWebContextFromCache({ webResults: [], linkedinCompanyResults: null, linkedinData: null }, false);
    expect(ctx).toBe('');
  });

  it('appends linkedin company section when hasCompanyLinkedinField is true and results exist', () => {
    const rawWithLinkedin: RawCacheData = {
      webResults: [{ title: 'Acme', url: 'https://acme.com', snippet: '', publishedDate: '', thumbnail: null }],
      linkedinCompanyResults: [{ title: 'Acme', url: 'https://www.linkedin.com/company/acme/', snippet: '', publishedDate: '', thumbnail: null }],
      linkedinData: null,
    };
    const ctx = buildWebContextFromCache(rawWithLinkedin, true);
    expect(ctx).toContain('LinkedIn company page URLs found');
    expect(ctx).toContain('linkedin.com/company/acme');
  });

  it('does not append linkedin section when hasCompanyLinkedinField is false', () => {
    const rawWithLinkedin: RawCacheData = {
      webResults: [{ title: 'Acme', url: 'https://acme.com', snippet: '', publishedDate: '', thumbnail: null }],
      linkedinCompanyResults: [{ title: 'Acme', url: 'https://linkedin.com/company/acme', snippet: '', publishedDate: '', thumbnail: null }],
      linkedinData: null,
    };
    const ctx = buildWebContextFromCache(rawWithLinkedin, false);
    expect(ctx).not.toContain('LinkedIn company page');
  });
});

// ─── splitFieldsByGroup ───────────────────────────────────────────────────────

describe('splitFieldsByGroup', () => {
  // FAIL cases
  it('puts unknown fields into ungrouped', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['totally_unknown_field']);
    expect(byGroup.size).toBe(0);
    expect(ungrouped).toEqual(['totally_unknown_field']);
  });

  it('returns empty byGroup and ungrouped for empty input', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup([]);
    expect(byGroup.size).toBe(0);
    expect(ungrouped).toHaveLength(0);
  });

  it('puts mixed known+unknown into correct buckets', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['industry', 'totally_unknown']);
    expect(byGroup.get('company_firmographic')).toContain('industry');
    expect(ungrouped).toContain('totally_unknown');
  });

  // SUCCESS cases
  it('maps a single firmographic field to company_firmographic group', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['industry']);
    expect(byGroup.get('company_firmographic')).toEqual(['industry']);
    expect(ungrouped).toHaveLength(0);
  });

  it('maps fields from two groups into separate group entries', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['industry', 'revenue_range']);
    expect(byGroup.get('company_firmographic')).toContain('industry');
    expect(byGroup.get('company_financial')).toContain('revenue_range');
    expect(ungrouped).toHaveLength(0);
  });

  it('maps person_identity field correctly', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['linkedin_url']);
    expect(byGroup.get('person_identity')).toContain('linkedin_url');
    expect(ungrouped).toHaveLength(0);
  });

  it('groups multiple fields from the same group together', () => {
    const { byGroup } = splitFieldsByGroup(['industry', 'employee_count', 'founded_year']);
    const fg = byGroup.get('company_firmographic') || [];
    expect(fg).toContain('industry');
    expect(fg).toContain('employee_count');
    expect(fg).toContain('founded_year');
    expect(byGroup.size).toBe(1);
  });

  // ── alias resolution (Tier 1/2/3 from enrichmentFieldAliasService) ────────

  it('routes a user field via alias map to its canonical group', () => {
    // funding_round → funding_stage (financial)
    const { byGroup, ungrouped } = splitFieldsByGroup(
      ['funding_round'],
      { aliases: { funding_round: 'funding_stage' } },
    );
    expect(byGroup.get('company_financial')).toEqual(['funding_round']);
    expect(ungrouped).toHaveLength(0);
  });

  it('keeps the user-facing field name in the group bucket (not the canonical)', () => {
    // The LLM extraction prompt + customFields persistence both use the user name.
    const { byGroup } = splitFieldsByGroup(
      ['my_overview'],
      { aliases: { my_overview: 'company_description' } },
    );
    expect(byGroup.get('company_firmographic')).toEqual(['my_overview']);
  });

  it('falls through to ungrouped when alias points to a non-existent canonical', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(
      ['my_field'],
      { aliases: { my_field: 'made_up_canonical' } },
    );
    expect(byGroup.size).toBe(0);
    expect(ungrouped).toEqual(['my_field']);
  });

  it('mixes alias-resolved + canonical + unknown fields correctly', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(
      ['funding_round', 'industry', 'random_thing'],
      { aliases: { funding_round: 'funding_stage' } },
    );
    expect(byGroup.get('company_financial')).toEqual(['funding_round']);
    expect(byGroup.get('company_firmographic')).toEqual(['industry']);
    expect(ungrouped).toEqual(['random_thing']);
  });
});

// ─── buildLinkedInContextFromCache ───────────────────────────────────────────

describe('buildLinkedInContextFromCache', () => {
  it('returns empty string when no linkedinData in cache', () => {
    const ctx = buildLinkedInContextFromCache(MOCK_RAW_DATA, true);
    expect(ctx).toBe('');
  });

  it('includes raw profile JSON in context', () => {
    const ctx = buildLinkedInContextFromCache(MOCK_PERSON_RAW_DATA, false);
    expect(ctx).toContain('CEO at Acme');
  });

  it('appends resolved LinkedIn URL when isEnrichingLinkedin is true', () => {
    const ctx = buildLinkedInContextFromCache(MOCK_PERSON_RAW_DATA, true);
    expect(ctx).toContain('Resolved LinkedIn profile URL');
    expect(ctx).toContain('linkedin.com/in/john-doe');
  });

  it('does not append URL when isEnrichingLinkedin is false', () => {
    const ctx = buildLinkedInContextFromCache(MOCK_PERSON_RAW_DATA, false);
    expect(ctx).not.toContain('Resolved LinkedIn profile URL');
  });
});

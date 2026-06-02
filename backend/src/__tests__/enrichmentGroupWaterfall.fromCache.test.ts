// Verifies the fromCache field shape on EnrichedFieldMeta.
// Flow-through tests (provider → FieldFill.meta → lead record) are added in later tasks.

import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

describe('EnrichedFieldMeta — fromCache field', () => {
  it('type accepts fromCache: true', () => {
    const meta: EnrichedFieldMeta = {
      source: 'api',
      provider: 'apollo',
      confidence: 'high',
      enrichedAt: new Date().toISOString(),
      fromCache: true,
    };
    expect(meta.fromCache).toBe(true);
  });

  it('type accepts fromCache: false', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      provider: 'llm_web_search',
      confidence: 'medium',
      enrichedAt: new Date().toISOString(),
      fromCache: false,
    };
    expect(meta.fromCache).toBe(false);
  });

  it('type allows fromCache to be absent (optional)', () => {
    const meta: EnrichedFieldMeta = {
      source: 'manual',
      enrichedAt: new Date().toISOString(),
    };
    expect(meta.fromCache).toBeUndefined();
  });
});

// ─── runWaterfall Apollo fromCache propagation ────────────────────────────────

import { runWaterfall, createApolloFetchContext } from '../services/enrichmentGroupWaterfall';
import type { WaterfallDeps, RunWaterfallInput } from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    listId: 'list-1',
    email: 'jane@acme.com',
    firstName: 'Jane',
    lastName: 'Doe',
    company: 'Acme',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as LeadRecord;
}

function makeDeps(overrides: Partial<WaterfallDeps> = {}): WaterfallDeps {
  return {
    fetchApolloOrg: jest.fn().mockResolvedValue(null),
    fetchApolloPerson: jest.fn().mockResolvedValue(null),
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {} }),
    fetchWebForGroup: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('runWaterfall — Apollo fromCache propagation', () => {
  it('sets fromCache: true on Tier 2 Apollo fills when fetchApolloOrg returns fromCache: true', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue({
        mapped: { employee_count: '250' },
        raw: {},
        fromCache: true,
      }),
    });

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead: makeLead(),
        groupName: 'company_firmographic',
        requestedFields: ['employee_count'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'employee_count');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(true);
  });

  it('sets fromCache: false on Tier 2 Apollo fills when fetchApolloOrg returns fromCache: false', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue({
        mapped: { employee_count: '500' },
        raw: {},
        fromCache: false,
      }),
    });

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead: makeLead(),
        groupName: 'company_firmographic',
        requestedFields: ['employee_count'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'employee_count');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(false);
  });
});

describe('runWaterfall — Unipile fromCache propagation', () => {
  it('sets fromCache: true on Tier 3.5b Unipile person fills when findUnipilePerson returns fromCache: true', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue({
        title: 'VP Engineering',
        fromCache: true,
      }),
    });

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead: makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' }),
        groupName: 'person_identity',
        requestedFields: ['title'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'title');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(true);
  });

  it('sets fromCache: false on Tier 3.5b Unipile person fills when findUnipilePerson returns fromCache: false', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue({
        title: 'CTO',
        fromCache: false,
      }),
    });

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead: makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' }),
        groupName: 'person_identity',
        requestedFields: ['title'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'title');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(false);
  });
});

describe('runWaterfall — Tier 1 CRM fromCache', () => {
  it('sets fromCache: true on Tier 1 CRM hits (existing lead data)', async () => {
    const lead = makeLead({
      customFields: { company_description: 'Acme makes widgets' },
      enrichmentMetadata: {
        company_description: {
          source: 'api' as const,
          provider: 'apollo',
          confidence: 'high' as const,
          enrichedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        },
      },
    });

    const deps = makeDeps();

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead,
        groupName: 'company_firmographic',
        requestedFields: ['company_description'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(true);
  });
});

describe('runWaterfall — web search fromCache', () => {
  it('sets fromCache: false on Tier 4 web search fills', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Acme Corp makes widgets.' }),
      extractFieldsViaLLM: jest.fn().mockImplementation(({ fields }: { fields: string[] }) =>
        Promise.resolve({
          filled: Object.fromEntries(
            fields.map(f => [f, { value: 'Widget Manufacturing', sourceUrl: 'https://acme.com' }])
          ),
        })
      ),
    });

    const result = await runWaterfall(
      {
        listId: 'list-1',
        lead: makeLead(),
        groupName: 'company_firmographic',
        // company_description is in company_firmographic but NOT in APOLLO_GROUP_COVERAGE,
        // so it falls straight to Tier 4 (web search)
        requestedFields: ['company_description'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        refreshFields: new Set(),
      },
      deps,
    );

    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill).toBeDefined();
    expect(fill!.meta.fromCache).toBe(false);
  });
});

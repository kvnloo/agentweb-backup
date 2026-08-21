import {
  createApolloFetchContext,
  createEnrichSoFetchContext,
  runWaterfall,
  type ApolloFetchResult,
  type RunWaterfallInput,
  type WaterfallDeps,
} from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

const LIST_ID = 'list-without-unipile';

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-without-unipile',
    email: 'jane@acme.example',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

function apolloResult(mapped: Record<string, string>): ApolloFetchResult {
  return { mapped, raw: null };
}

function makeDeps(overrides: Partial<WaterfallDeps> = {}): WaterfallDeps {
  return {
    fetchApolloOrg: jest.fn().mockResolvedValue(null),
    fetchApolloPerson: jest.fn().mockResolvedValue(null),
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    fetchWebForGroup: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

async function runWithoutUnipile(
  input: Pick<RunWaterfallInput, 'groupName' | 'requestedFields'> & { lead?: LeadRecord },
  deps: WaterfallDeps,
) {
  return runWaterfall({
    listId: LIST_ID,
    lead: input.lead ?? makeLead(),
    groupName: input.groupName,
    requestedFields: input.requestedFields,
    configFieldsByName: {},
    apolloCtx: createApolloFetchContext(),
    enrichSoCtx: createEnrichSoFetchContext(),
    refreshFields: new Set<string>(),
  }, deps);
}

describe('enrichment waterfall without Unipile dependencies', () => {
  it('keeps both Unipile ports optional in the test boundary', () => {
    const deps = makeDeps();

    expect(deps.findUnipilePerson).toBeUndefined();
    expect(deps.findUnipileCompany).toBeUndefined();
  });

  it('returns all person identity fields when Apollo supplies them', async () => {
    const deps = makeDeps({
      fetchApolloPerson: jest.fn().mockResolvedValue(apolloResult({
        first_name: 'Jane',
        last_name: 'Doe',
        title: 'VP Marketing',
        linkedin_url: 'https://www.linkedin.com/in/jane-doe',
      })),
    });

    const result = await runWithoutUnipile({
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name', 'title', 'linkedin_url'],
    }, deps);

    expect(Object.fromEntries(result.fields.map(field => [field.field, field.value]))).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      title: 'VP Marketing',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(result.missing).toEqual([]);
  });

  it('returns all person identity fields when the web tier supplies them', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Jane Doe is VP Marketing at Acme.' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: {
          first_name: { value: 'Jane' },
          last_name: { value: 'Doe' },
          title: { value: 'VP Marketing' },
          linkedin_url: { value: 'https://www.linkedin.com/in/jane-doe' },
        },
        missing: [],
      }),
    });

    const result = await runWithoutUnipile({
      groupName: 'person_identity',
      requestedFields: ['first_name', 'last_name', 'title', 'linkedin_url'],
    }, deps);

    expect(Object.fromEntries(result.fields.map(field => [field.field, field.value]))).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      title: 'VP Marketing',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(result.missing).toEqual([]);
  });

  it('returns company firmographics when Apollo supplies them', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({
        company_name: 'Acme',
        industry: 'Software',
        employee_count: '250',
      })),
    });

    const result = await runWithoutUnipile({
      groupName: 'company_firmographic',
      requestedFields: ['company_name', 'industry', 'employee_count'],
      lead: makeLead({ company: 'Acme' }),
    }, deps);

    expect(Object.fromEntries(result.fields.map(field => [field.field, field.value]))).toEqual({
      company_name: 'Acme',
      industry: 'Software',
      employee_count: '250',
    });
    expect(result.missing).toEqual([]);
  });
});

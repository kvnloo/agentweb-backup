// Tests for the intentional hq_location exclusion from T3.5b-enrich.so.
//
// Design comment in enrichmentGroupWaterfall.ts:574-578:
//   "hq_location intentionally NOT mapped: this tier (T3.5b) sits ABOVE Unipile
//   and web-search, and web-search yields a better HQ value. The waterfall only
//   fills empty fields, so letting enrich.so set hq_location would block the
//   superior web-search result."
//
// These tests verify that hq_location is never filled by the enrich.so tier
// (T3.5b), ensuring it falls through to the web tier for a better value.

import {
  runWaterfall,
  createApolloFetchContext,
  createEnrichSoFetchContext,
  type WaterfallDeps,
  type RunWaterfallInput,
} from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

const FROZEN_NOW = new Date('2026-05-11T12:00:00.000Z').getTime();
const LIST_ID = 'list-hq-1';
const LEAD_ID = 'lead-hq-1';

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: LEAD_ID,
    email: 'jane@acme.com',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
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

function makeInput(overrides: Partial<RunWaterfallInput> = {}): RunWaterfallInput {
  return {
    listId: LIST_ID,
    lead: makeLead(),
    groupName: 'company_firmographic',
    requestedFields: ['hq_location'],
    configFieldsByName: {},
    apolloCtx: createApolloFetchContext(),
    enrichSoCtx: createEnrichSoFetchContext(),
    refreshFields: new Set<string>(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── hq_location not filled by enrich.so ─────────────────────────────────────

describe('enrichmentGroupWaterfall — hq_location intentionally excluded from T3.5b-enrich.so', () => {
  // FAIL: enrich.so returns a companyLocation value — verify hq_location is NOT
  // used from it and remains in `missing` after T3.5b-es.
  it('does NOT fill hq_location from enrich.so even when companyLocation is returned', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      companyName: 'Acme Corp',
      companyLocation: 'San Francisco, CA',   // enrich.so returns this — must NOT be used
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        lead: makeLead({ email: 'jane@acme.com' }),
        requestedFields: ['hq_location'],
      }),
      deps,
    );

    // hq_location must remain missing — not filled by enrich.so
    expect(result.missing).toContain('hq_location');
    expect(result.fields.find(f => f.field === 'hq_location')).toBeUndefined();
  });

  // FAIL: verify the enrich.so fill count for hq_location is 0 even when
  // companyLocation is present in the response.
  it('does not increment enrichSo tier fill count for hq_location', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      companyLocation: 'New York, NY',
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        lead: makeLead({ email: 'jane@acme.com' }),
        requestedFields: ['hq_location'],
      }),
      deps,
    );

    expect(result.tierFills.enrichSo).toBe(0);
    expect(result.fields.length).toBe(0);
  });

  // SUCCESS: enrich.so fills other company fields (company_name) but NOT hq_location.
  // company_name must be filled; hq_location must remain in missing.
  it('fills company_name from enrich.so while hq_location falls through to missing', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      companyName: 'Acme Corp',
      companyLocation: 'Austin, TX',  // intentionally left unmapped
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        lead: makeLead({ email: 'jane@acme.com' }),
        requestedFields: ['company_name', 'hq_location'],
      }),
      deps,
    );

    // company_name should be filled by enrich.so
    const companyNameFill = result.fields.find(f => f.field === 'company_name');
    expect(companyNameFill).toBeDefined();
    expect(companyNameFill?.value).toBe('Acme Corp');
    expect(companyNameFill?.meta.provider).toBe('enrich.so');

    // hq_location must NOT be filled by enrich.so — falls to missing
    expect(result.missing).toContain('hq_location');
    expect(result.fields.find(f => f.field === 'hq_location')).toBeUndefined();
  });
});

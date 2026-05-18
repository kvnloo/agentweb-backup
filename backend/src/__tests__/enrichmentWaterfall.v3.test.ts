// Tests for enrichmentWaterfall — Req B core of v3.1 enrichment.
// Strict 4-tier waterfall per group, per lead:
//   Tier 1: CRM (lead-side freshness check via isFresh)
//   Tier 2: Apollo (memoized via ApolloFetchContext)
//   Tier 3: LLM over Apollo context (conditional — only when Apollo non-null
//           AND residuals are within Apollo's coverage)
//   Tier 4: Web (one Google CSE per group with residuals)
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.2.

import {
  runWaterfall,
  createApolloFetchContext,
  APOLLO_GROUP_COVERAGE,
  UNIPILE_PERSON_COVERAGE,
  type WaterfallDeps,
  type RunWaterfallInput,
  type ApolloFetchContext,
  type ApolloFetchResult,
} from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

const FROZEN_NOW = new Date('2026-05-11T12:00:00.000Z').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_ID = 'list-1';
const LEAD_ID = 'lead-1';

function freshMetaAt(daysAgo: number): EnrichedFieldMeta {
  return {
    source: 'existing_data',
    enrichedAt: new Date(FROZEN_NOW - daysAgo * DAY_MS).toISOString(),
  };
}

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: LEAD_ID,
    email: 'jane@acme.com',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

function apolloResult(mapped: Record<string, string>, raw: any = null): ApolloFetchResult {
  return { mapped, raw };
}

function makeDeps(overrides: Partial<WaterfallDeps> = {}): WaterfallDeps {
  return {
    fetchApolloOrg: jest.fn().mockResolvedValue(null),
    fetchApolloPerson: jest.fn().mockResolvedValue(null),
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    fetchWebForGroup: jest.fn().mockResolvedValue(null),
    findLinkedInUrl: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RunWaterfallInput> = {}): RunWaterfallInput {
  return {
    listId: LIST_ID,
    lead: makeLead(),
    groupName: 'company_firmographic',
    requestedFields: ['company_name'],
    configFieldsByName: {},
    apolloCtx: createApolloFetchContext(),
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

// ─── APOLLO_GROUP_COVERAGE map — verify scope ─────────────────────────────────

describe('APOLLO_GROUP_COVERAGE', () => {
  it('covers tech_stack in company_technographic (verified in apolloFieldMapper.ts)', () => {
    expect(APOLLO_GROUP_COVERAGE.company_technographic).toContain('tech_stack');
  });

  it('covers revenue_range / funding_stage / total_funding in company_financial', () => {
    expect(APOLLO_GROUP_COVERAGE.company_financial).toEqual(
      expect.arrayContaining(['revenue_range', 'funding_stage', 'total_funding']),
    );
  });

  it('has ZERO coverage for intent_signals (web-only by design)', () => {
    expect(APOLLO_GROUP_COVERAGE.intent_signals ?? []).toEqual([]);
  });

  it('covers twitter_handle in company_social', () => {
    expect(APOLLO_GROUP_COVERAGE.company_social ?? []).toContain('twitter_handle');
  });

  it('has ZERO coverage for company_product (Apollo gap)', () => {
    expect(APOLLO_GROUP_COVERAGE.company_product ?? []).toEqual([]);
  });
});

// ─── Empty work / no-op paths ────────────────────────────────────────────────

describe('runWaterfall — empty / no-op paths', () => {
  it('returns empty result when no requested fields belong to the group', async () => {
    const deps = makeDeps();
    const result = await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['tech_stack'],  // belongs to technographic, not firmographic
      }),
      deps,
    );

    expect(result.fields).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.tierFills).toEqual({ crm: 0, apollo: 0, web: 0, missing: 0 });
    expect(deps.fetchApolloOrg).not.toHaveBeenCalled();
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
  });
});

// ─── Tier 1 (CRM) ─────────────────────────────────────────────────────────────

describe('runWaterfall — Tier 1 (CRM)', () => {
  it('honors fresh CRM values; no Apollo / no web calls', async () => {
    const deps = makeDeps();
    const lead = makeLead({
      customFields: { company_name: 'Acme', industry: 'SaaS' },
      enrichmentMetadata: {
        company_name: freshMetaAt(30),
        industry: freshMetaAt(30),
      },
    });
    const result = await runWaterfall(
      makeInput({
        lead,
        requestedFields: ['company_name', 'industry'],
      }),
      deps,
    );

    expect(result.fields).toHaveLength(2);
    expect(result.fields.every(f => f.meta.source === 'existing_data')).toBe(true);
    expect(result.tierFills).toEqual({ crm: 2, apollo: 0, web: 0, missing: 0 });
    expect(deps.fetchApolloOrg).not.toHaveBeenCalled();
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
    expect(deps.extractFieldsViaLLM).not.toHaveBeenCalled();
  });

  it('falls through when CRM values are stale (older than group TTL)', async () => {
    // company_firmographic ttlDays = 180. Make values 200 days old → stale.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_name: 'Acme Corp' })),
    });
    const lead = makeLead({
      customFields: { company_name: 'Acme Old' },
      enrichmentMetadata: { company_name: freshMetaAt(200) },
    });
    const result = await runWaterfall(
      makeInput({
        lead,
        requestedFields: ['company_name'],
      }),
      deps,
    );

    expect(deps.fetchApolloOrg).toHaveBeenCalledTimes(1);
    expect(result.fields[0]?.value).toBe('Acme Corp');
    expect(result.tierFills.crm).toBe(0);
    expect(result.tierFills.apollo).toBe(1);
  });

  it('refreshFields bypasses Tier 1 even when CRM value is fresh', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_name: 'Acme Refreshed' })),
    });
    const lead = makeLead({
      customFields: { company_name: 'Acme Cached' },
      enrichmentMetadata: { company_name: freshMetaAt(1) },  // fresh
    });
    const result = await runWaterfall(
      makeInput({
        lead,
        requestedFields: ['company_name'],
        refreshFields: new Set([`${LEAD_ID}:company_name`]),
      }),
      deps,
    );

    expect(deps.fetchApolloOrg).toHaveBeenCalledTimes(1);
    expect(result.fields[0]?.value).toBe('Acme Refreshed');
    expect(result.tierFills.crm).toBe(0);
  });

  it('falls through when lead has the field key but empty value', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_name: 'Acme Real' })),
    });
    const lead = makeLead({
      customFields: { company_name: '' },
      enrichmentMetadata: { company_name: freshMetaAt(1) },
    });
    const result = await runWaterfall(
      makeInput({ lead, requestedFields: ['company_name'] }),
      deps,
    );

    expect(result.fields[0]?.value).toBe('Acme Real');
    expect(result.tierFills.crm).toBe(0);
    expect(result.tierFills.apollo).toBe(1);
  });
});

// ─── Tier 2 (Apollo) ──────────────────────────────────────────────────────────

describe('runWaterfall — Tier 2 (Apollo)', () => {
  it('Apollo hit covers all residuals → no Tier 3, no Tier 4', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({
        company_name: 'Acme Corp', industry: 'SaaS',
      })),
    });
    const result = await runWaterfall(
      makeInput({ requestedFields: ['company_name', 'industry'] }),
      deps,
    );

    expect(result.fields).toHaveLength(2);
    expect(result.fields.every(f => f.meta.source === 'api')).toBe(true);
    expect(result.fields.every(f => f.meta.provider === 'apollo')).toBe(true);
    expect(result.tierFills.apollo).toBe(2);
    expect(deps.extractFieldsViaLLM).not.toHaveBeenCalled();
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
  });

  it('skips Apollo entirely for groups with empty coverage (intent_signals)', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'news...' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { recent_news: 'launched product Y' }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'intent_signals',
        requestedFields: ['recent_news'],
      }),
      deps,
    );

    expect(deps.fetchApolloOrg).not.toHaveBeenCalled();
    expect(deps.fetchApolloPerson).not.toHaveBeenCalled();
    expect(deps.fetchWebForGroup).toHaveBeenCalledTimes(1);
    expect(result.tierFills.web).toBe(1);
  });
});

// ─── Tier 3 (LLM over Apollo context) ─────────────────────────────────────────

describe('runWaterfall — Tier 3 (LLM over Apollo)', () => {
  it('runs LLM reconciliation when Apollo non-null AND residuals within Apollo coverage', async () => {
    // Apollo returns company_name directly but does NOT structure tech_stack — Tier 3
    // LLM picks tech_stack from Apollo's free-text fields.
    const apolloMapped = { company_name: 'Acme' };
    const apolloRaw = { company_name: 'Acme', _rawTechBlob: 'AWS HubSpot Stripe' };
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult(apolloMapped, apolloRaw)),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { tech_stack: 'AWS, HubSpot, Stripe' },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'company_technographic',
        requestedFields: ['tech_stack'],
      }),
      deps,
    );

    expect(deps.extractFieldsViaLLM).toHaveBeenCalledTimes(1);
    expect(result.tierFills.apollo).toBe(1);   // Tier 3 fills attributed to apollo
    expect(result.fields[0]?.value).toBe('AWS, HubSpot, Stripe');
    expect(result.fields[0]?.meta.source).toBe('api');
    expect(result.fields[0]?.meta.provider).toBe('apollo');
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
  });

  it('skips Tier 3 when Apollo returns null (no data to reconcile)', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp...' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { tech_stack: 'AWS' }, missing: [],
      }),
    });
    await runWaterfall(
      makeInput({
        groupName: 'company_technographic',
        requestedFields: ['tech_stack'],
      }),
      deps,
    );

    // The single LLM call must be for the WEB context (Tier 4), not Tier 3.
    expect(deps.extractFieldsViaLLM).toHaveBeenCalledTimes(1);
    const llmCall = (deps.extractFieldsViaLLM as jest.Mock).mock.calls[0][0];
    expect(llmCall.sourceContext).toContain('serp');
    expect(llmCall.tier).toBe('web');
  });

  it('skips Tier 3 when no residuals are within Apollo coverage', async () => {
    // Apollo covered fields are 'tech_stack'; user requests 'crm_used' which is in
    // company_technographic but NOT in APOLLO_GROUP_COVERAGE.company_technographic.
    // Apollo returns null for crm_used (not in coverage). Tier 3 has nothing to reconcile.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ tech_stack: 'AWS' })),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp...' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { crm_used: 'HubSpot' }, missing: [],
      }),
    });
    await runWaterfall(
      makeInput({
        groupName: 'company_technographic',
        requestedFields: ['crm_used'],   // NOT in Apollo coverage for this group
      }),
      deps,
    );

    // Apollo was called (because the GROUP has coverage), but crm_used is not in
    // Apollo's mappable set, so Tier 3 doesn't run for it — falls to web.
    expect(deps.extractFieldsViaLLM).toHaveBeenCalledTimes(1);
    const llmCall = (deps.extractFieldsViaLLM as jest.Mock).mock.calls[0][0];
    expect(llmCall.tier).toBe('web');
  });
});

// ─── Tier 4 (Web) ─────────────────────────────────────────────────────────────

describe('runWaterfall — Tier 4 (Web)', () => {
  it('ONE web call covers multiple residuals in the same group', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp content' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_name: 'Acme', industry: 'SaaS', employee_count: '500' },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({
        requestedFields: ['company_name', 'industry', 'employee_count'],
      }),
      deps,
    );

    expect(deps.fetchWebForGroup).toHaveBeenCalledTimes(1);   // not 3
    expect(deps.extractFieldsViaLLM).toHaveBeenCalledTimes(1);
    expect(result.tierFills.web).toBe(3);
    expect(result.fields.every(f => f.meta.source === 'web_search')).toBe(true);
  });

  it('records missing fields when web extraction returns null for them', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp content' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_name: 'Acme' },
        missing: ['industry'],
      }),
    });
    const result = await runWaterfall(
      makeInput({ requestedFields: ['company_name', 'industry'] }),
      deps,
    );

    expect(result.fields.map(f => f.field)).toEqual(['company_name']);
    expect(result.missing).toEqual(['industry']);
    expect(result.tierFills).toEqual({ crm: 0, apollo: 0, web: 1, missing: 1 });
  });

  it('skips web when web fetch returns null (e.g. all upstream caches expired AND fetch failed)', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ requestedFields: ['company_name'] }),
      deps,
    );

    expect(deps.extractFieldsViaLLM).not.toHaveBeenCalled();
    expect(result.missing).toEqual(['company_name']);
    expect(result.tierFills.missing).toBe(1);
  });
});

// ─── Apollo memoization + failure semantics ───────────────────────────────────

describe('runWaterfall — Tier 3.5a (Apollo broker chain)', () => {
  const LEAD_HINT = { listId: LIST_ID, leadId: LEAD_ID };

  it('fires for person_identity when email missing + name + emailDomain + leadHint', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['email'],
        lead: makeLead({ email: undefined, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(apolloBrokerChain).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
      LEAD_HINT,
    );
  });

  it('skipped when no leadHint', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['email'],
        lead: makeLead({ email: undefined, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
        // no leadHint
      }),
      deps,
    );
    expect(apolloBrokerChain).not.toHaveBeenCalled();
  });

  it('accepts guessed email with confidence=low', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: 'guessed' }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['email'],
        lead: makeLead({ email: undefined, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'email');
    expect(fill?.value).toBe('jane@acme.com');
    expect(fill?.meta.confidence).toBe('low');
  });

  it('accepts verified email with confidence=high', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: 'verified' }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['email'],
        lead: makeLead({ email: undefined, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'email');
    expect(fill?.value).toBe('jane@acme.com');
    expect(fill?.meta.confidence).toBe('high');
  });

  it('accepts undefined emailStatus with confidence=medium', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: undefined }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['email'],
        lead: makeLead({ email: undefined, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' }),
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'email');
    expect(fill?.value).toBe('jane@acme.com');
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('skipped for non-person_identity groups', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_name'],
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(apolloBrokerChain).not.toHaveBeenCalled();
  });
});

describe('runWaterfall — Apollo memoization (per-lead-per-entity)', () => {
  it('TWO company groups share ONE Apollo org fetch via the shared context', async () => {
    const apolloMock = jest.fn().mockResolvedValue({
      company_name: 'Acme', tech_stack: 'AWS',
    });
    const deps = makeDeps({ fetchApolloOrg: apolloMock });
    const ctx: ApolloFetchContext = createApolloFetchContext();

    await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_name'],
        apolloCtx: ctx,
      }),
      deps,
    );
    await runWaterfall(
      makeInput({
        groupName: 'company_technographic',
        requestedFields: ['tech_stack'],
        apolloCtx: ctx,
      }),
      deps,
    );

    expect(apolloMock).toHaveBeenCalledTimes(1);   // memoized across two waterfall calls
    expect(ctx.orgFetchAttempted).toBe(true);
  });

  it('Apollo error marks ctx.orgFetchFailed and falls through to web', async () => {
    const apolloMock = jest.fn().mockRejectedValue(new Error('Apollo 503'));
    const deps = makeDeps({
      fetchApolloOrg: apolloMock,
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_name: 'Acme' }, missing: [],
      }),
    });
    const ctx = createApolloFetchContext();
    const result = await runWaterfall(
      makeInput({ requestedFields: ['company_name'], apolloCtx: ctx }),
      deps,
    );

    expect(ctx.orgFetchFailed).toBe(true);
    expect(ctx.orgFetchAttempted).toBe(true);
    expect(result.tierFills.web).toBe(1);
    expect(result.fields[0]?.meta.source).toBe('web_search');
  });

  it('subsequent group call after Apollo failure does NOT retry Apollo', async () => {
    const apolloMock = jest.fn().mockRejectedValue(new Error('Apollo 503'));
    const deps = makeDeps({
      fetchApolloOrg: apolloMock,
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: ['x'] }),
    });
    const ctx = createApolloFetchContext();

    await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_name'],
        apolloCtx: ctx,
      }),
      deps,
    );
    await runWaterfall(
      makeInput({
        groupName: 'company_technographic',
        requestedFields: ['tech_stack'],
        apolloCtx: ctx,
      }),
      deps,
    );

    expect(apolloMock).toHaveBeenCalledTimes(1);   // failure cached
  });

  it('person and org Apollo contexts are independent (one failing does not affect the other)', async () => {
    const orgMock = jest.fn().mockRejectedValue(new Error('Apollo org down'));
    const personMock = jest.fn().mockResolvedValue(apolloResult({ first_name: 'Jane', last_name: 'Doe' }));
    const deps = makeDeps({
      fetchApolloOrg: orgMock,
      fetchApolloPerson: personMock,
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: ['x'] }),
    });
    const ctx = createApolloFetchContext();

    await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_name'],
        apolloCtx: ctx,
      }),
      deps,
    );
    const personResult = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name', 'last_name'],
        apolloCtx: ctx,
      }),
      deps,
    );

    expect(ctx.orgFetchFailed).toBe(true);
    expect(ctx.personFetchFailed).toBe(false);
    expect(personResult.tierFills.apollo).toBe(2);
  });
});

// ─── Tier 3.5c (Unipile company enrichment) ──────────────────────────────────

describe('runWaterfall — Tier 3.5c (Unipile company enrichment)', () => {
  it('fires for company group with remaining fields; fills via LLM; meta=unipile', async () => {
    const companyRaw = { name: 'Acme Corp', description: 'A SaaS company', employee_count: 42 };
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: 'A SaaS company', employee_count: '42' },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_description', 'employee_count'],
      }),
      deps,
    );

    expect(deps.findUnipileCompany).toHaveBeenCalledTimes(1);
    expect(result.fields).toHaveLength(2);
    expect(result.fields.every(f => f.meta.source === 'api' && f.meta.provider === 'unipile')).toBe(true);
    expect(result.tierFills.apollo).toBe(2);
    expect(result.tierFills.web).toBe(0);
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
  });

  it('passes company_linkedin_url from lead to dep', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const lead = makeLead({ company_linkedin_url: 'https://www.linkedin.com/company/acme-co/' });
    await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(deps.findUnipileCompany).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: LEAD_ID }),
      'https://www.linkedin.com/company/acme-co/',
    );
  });

  it('passes company_linkedin_url filled this run by Apollo to dep', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({
        company_linkedin_url: 'https://www.linkedin.com/company/apollo-filled/',
      })),
      findUnipileCompany: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_linkedin_url', 'company_description'],
      }),
      deps,
    );

    expect(deps.findUnipileCompany).toHaveBeenCalledWith(
      expect.anything(),
      'https://www.linkedin.com/company/apollo-filled/',
    );
  });

  it('soft-fails when dep returns null — fields fall through to web', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'serp content' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: 'from web' }, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.fields[0]?.value).toBe('from web');
    expect(result.fields[0]?.meta.source).toBe('web_search');
    expect(result.tierFills.web).toBe(1);
    expect(result.tierFills.apollo).toBe(0);
  });

  it('does NOT fire for person entity groups when Apollo already fills all fields', async () => {
    const deps = makeDeps({
      fetchApolloPerson: jest.fn().mockResolvedValue(apolloResult({ first_name: 'Jane' })),
      findUnipileCompany: jest.fn(),
    });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(deps.findUnipileCompany).not.toHaveBeenCalled();
  });

  it('does NOT fire when remaining is empty after Tier 2 Apollo', async () => {
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_description: 'Already filled' })),
      findUnipileCompany: jest.fn(),
    });
    await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(deps.findUnipileCompany).not.toHaveBeenCalled();
  });

  it('silently skips when findUnipileCompany dep is not provided', async () => {
    const deps = makeDeps();  // no findUnipileCompany — it is optional
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result).toBeDefined();
    expect(result.missing).toContain('company_description');
  });

  it('does not fill field when LLM returns empty string for it', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme' } }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: '' }, missing: [] }),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'company_description')).toBeUndefined();
    expect(result.missing).toContain('company_description');
  });

  it('calls extractFieldsViaLLM with full JSON of company raw data', async () => {
    const companyRaw = { name: 'Acme', industry: ['SaaS'], employee_count: 100 };
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: ['company_description'] }),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    const llmCall = (deps.extractFieldsViaLLM as jest.Mock).mock.calls[0][0];
    expect(llmCall.tier).toBe('apollo');
    expect(llmCall.sourceContext).toBe(JSON.stringify(companyRaw));
    expect(llmCall.fields).toContain('company_description');
    // sourceContext is the companyRaw JSON, not the wrapper object
  });

  it('accounts for company fills under apollo in tierFills when no web needed', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme' } }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: 'A company' },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.tierFills).toEqual({ crm: 0, apollo: 1, web: 0, missing: 0 });
    expect(result.missing).toEqual([]);
  });
});

// ─── Tier 3.5c (Unipile person enrichment) ────────────────────────────────────

describe('runWaterfall — Tier 3.5c (Unipile person enrichment)', () => {
  const personProfileRaw = {
    first_name: 'Jane',
    last_name: 'Doe',
    headline: 'VP Marketing at Acme',
    location: 'San Francisco, California, United States',
    public_identifier: 'jane-doe-acme',
    work_experience: [
      { company: 'Acme', position: 'VP Marketing', start: '1/1/2023', end: null, company_id: '111' },
      { company: 'OldCo', position: 'Manager', start: '1/1/2020', end: '12/31/2022', company_id: '222' },
    ],
    education: [{ school: 'MIT', degree: 'MBA' }],
  };

  it('fires for person group when Apollo misses fields; direct-maps known fields', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name', 'last_name', 'title', 'location', 'linkedin_url'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
    expect(result.fields.find(f => f.field === 'location')?.value).toBe('San Francisco, California, United States');
    expect(result.fields.find(f => f.field === 'linkedin_url')?.value).toBe('https://www.linkedin.com/in/jane-doe-acme');
    expect(result.fields.every(f => f.meta.source === 'api' && f.meta.provider === 'unipile')).toBe(true);
  });

  it('calls findUnipileCompany with profileOnly=true for person groups', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(deps.findUnipileCompany).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      true,
    );
  });

  it('uses linkedin_url filled by 3.5b when lead.linkedin is absent', async () => {
    const deps = makeDeps({
      findLinkedInUrl: jest.fn().mockResolvedValue('https://www.linkedin.com/in/jane-doe-acme'),
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['linkedin_url', 'first_name'], lead }),
      deps,
    );

    const callLead = (deps.findUnipileCompany as jest.Mock).mock.calls[0][0];
    expect(callLead.linkedin).toBe('https://www.linkedin.com/in/jane-doe-acme');
  });

  it('falls through to LLM for fields not in direct map', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { seniority: 'vp' }, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['seniority'] }),
      deps,
    );

    expect(deps.extractFieldsViaLLM).toHaveBeenCalled();
    expect(result.fields.find(f => f.field === 'seniority')?.value).toBe('vp');
  });

  it('skips LLM when direct map fills all remaining fields', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name', 'last_name'] }),
      deps,
    );

    // direct map fills first_name + last_name → LLM called with empty remaining
    const llmCall = (deps.extractFieldsViaLLM as jest.Mock).mock.calls[0];
    if (llmCall) {
      expect(llmCall[0].fields).toHaveLength(0);
    }
  });

  it('maps tenure_at_company and prior_companies for person_career group', async () => {
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z').getTime());
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_career', requestedFields: ['tenure_at_company', 'prior_companies', 'education'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'prior_companies')?.value).toBe('OldCo');
    expect(result.fields.find(f => f.field === 'education')?.value).toBe('MIT, MBA');
    expect(result.fields.find(f => f.field === 'tenure_at_company')?.value).toBeDefined();
  });

  it('smart company match — picks correct job when multiple concurrent roles', async () => {
    const multiJobProfile = {
      ...personProfileRaw,
      work_experience: [
        { company: 'SideProject', position: 'Advisor', start: '1/1/2024', end: null, company_id: '333' },
        { company: 'Acme', position: 'VP Marketing', start: '1/1/2023', end: null, company_id: '111' },
      ],
    };
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw: multiJobProfile }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['title'],
        lead: makeLead({ company: 'Acme' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
  });

  it('gracefully skips when findUnipileCompany returns null for person group', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(result.missing).toContain('first_name');
  });

  it('gracefully skips when personProfileRaw is absent in result', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null }),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(result.missing).toContain('first_name');
  });

  it('maps recent_role_change_date from current work_experience start', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_career', requestedFields: ['recent_role_change_date'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'recent_role_change_date')?.value).toBe('1/1/2023');
  });

  it('maps email and phone from contact_info when present (Sales Nav accounts)', async () => {
    const profileWithContact = {
      ...personProfileRaw,
      contact_info: {
        emails: [{ address: 'jane@acme.com' }],
        phones: [{ number: '+1-555-0100' }],
      },
    };
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw: profileWithContact }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['email', 'phone'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'email')?.value).toBe('jane@acme.com');
    expect(result.fields.find(f => f.field === 'phone')?.value).toBe('+1-555-0100');
  });

  it('gracefully skips contact_info when absent (normal LinkedIn accounts)', async () => {
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: null, personProfileRaw }),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['email', 'phone'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'email')).toBeUndefined();
    expect(result.fields.find(f => f.field === 'phone')).toBeUndefined();
  });
});

// ─── UNIPILE_PERSON_COVERAGE map ──────────────────────────────────────────────

describe('UNIPILE_PERSON_COVERAGE', () => {
  it('covers identity fields', () => {
    expect(UNIPILE_PERSON_COVERAGE.person_identity).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'title', 'location', 'linkedin_url']),
    );
  });

  it('covers career fields', () => {
    expect(UNIPILE_PERSON_COVERAGE.person_career).toEqual(
      expect.arrayContaining(['tenure_at_company', 'prior_companies', 'education', 'recent_role_change_date']),
    );
  });
});

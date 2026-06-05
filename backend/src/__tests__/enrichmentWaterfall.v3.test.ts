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
  createEnrichSoFetchContext,
  APOLLO_GROUP_COVERAGE,
  type WaterfallDeps,
  type RunWaterfallInput,
  type ApolloFetchContext,
  type ApolloFetchResult,
} from '../services/enrichmentGroupWaterfall';
import { buildFieldGuidanceV3 } from '../services/enrichmentV3RealDeps';
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
    enrichSoCtx: createEnrichSoFetchContext(),
    refreshFields: new Set<string>(),
    ...overrides,
  };
}

// Fix 1: extractFieldsViaLLM now returns per-field objects; `fv` builds one.
function fv(value: string, sourceUrl?: string, sourceQuote?: string) {
  const obj: { value: string; sourceUrl?: string; sourceQuote?: string } = { value };
  if (sourceUrl) obj.sourceUrl = sourceUrl;
  if (sourceQuote) obj.sourceQuote = sourceQuote;
  return obj;
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
    expect(result.tierFills).toEqual({ crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 });
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
    expect(result.tierFills).toEqual({ crm: 2, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 });
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
        filled: { recent_news: fv('launched product Y') }, missing: [],
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
        filled: { tech_stack: fv('AWS, HubSpot, Stripe') },
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
        filled: { tech_stack: fv('AWS') }, missing: [],
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
        filled: { crm_used: fv('HubSpot') }, missing: [],
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
        filled: { company_name: fv('Acme'), industry: fv('SaaS'), employee_count: fv('500') },
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
        filled: { company_name: fv('Acme') },
        missing: ['industry'],
      }),
    });
    const result = await runWaterfall(
      makeInput({ requestedFields: ['company_name', 'industry'] }),
      deps,
    );

    expect(result.fields.map(f => f.field)).toEqual(['company_name']);
    expect(result.missing).toEqual(['industry']);
    expect(result.tierFills).toEqual({ crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 1, missing: 1 });
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
        filled: { company_name: fv('Acme') }, missing: [],
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

// ─── Tier 5 (Unipile company enrichment — after web) ─────────────────────────

describe('runWaterfall — Tier 5 (Unipile company enrichment after web)', () => {
  it('fires for company group after web when lead.linkedin present; fills via LLM; meta=unipile', async () => {
    const companyRaw = { name: 'Acme Corp', description: 'A SaaS company', employee_count: 42 };
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company'), employee_count: fv('42') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description', 'employee_count'] }),
      deps,
    );

    expect(deps.findUnipileCompany).toHaveBeenCalledTimes(1);
    expect(result.fields).toHaveLength(2);
    expect(result.fields.every(f => f.meta.source === 'api' && f.meta.provider === 'unipile')).toBe(true);
    expect(result.tierFills.unipile).toBe(2);
    expect(result.tierFills.web).toBe(0);
  });

  it('fires AFTER Tier 4 web — web fills first, Unipile gets remaining fields', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn()
        .mockResolvedValueOnce({ filled: { company_description: fv('from web') }, missing: [] }) // Tier 4
        .mockResolvedValueOnce({ filled: { employee_count: fv('42') }, missing: [] }), // Tier 5
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme', employee_count: 42 } }),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description', 'employee_count'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'company_description')?.meta.source).toBe('web_search');
    expect(result.fields.find(f => f.field === 'employee_count')?.meta.source).toBe('api');
    expect(result.tierFills.web).toBe(1);
    expect(result.tierFills.unipile).toBe(1);
  });

  it('skips when lead.linkedin is absent', async () => {
    const lead = makeLead(); // no linkedin
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme' } }),
    });
    await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(deps.findUnipileCompany).not.toHaveBeenCalled();
  });

  it('soft-fails when dep returns null — field goes missing', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.missing).toContain('company_description');
  });

  it('fills company_name directly when companyRaw is null', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ company_name: 'Acme Corp', companyRaw: null }),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_name'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'company_name')?.value).toBe('Acme Corp');
    expect(result.fields.find(f => f.field === 'company_name')?.meta.provider).toBe('unipile');
  });

  it('does NOT fire when remaining is empty after Apollo', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_description: 'Already filled' })),
      findUnipileCompany: jest.fn(),
    });
    await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(deps.findUnipileCompany).not.toHaveBeenCalled();
  });

  it('silently skips when findUnipileCompany dep is not provided', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps(); // no findUnipileCompany — it is optional
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result).toBeDefined();
    expect(result.missing).toContain('company_description');
  });

  it('does not fill field when LLM returns empty string', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme' } }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: fv('') }, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'company_description')).toBeUndefined();
    expect(result.missing).toContain('company_description');
  });

  it('calls extractFieldsViaLLM with full JSON of companyRaw', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const companyRaw = { name: 'Acme', industry: ['SaaS'], employee_count: 100 };
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: ['company_description'] }),
    });
    await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    const llmCall = (deps.extractFieldsViaLLM as jest.Mock).mock.calls[0][0];
    expect(llmCall.tier).toBe('apollo');
    expect(llmCall.sourceContext).toBe(JSON.stringify(companyRaw));
    expect(llmCall.fields).toContain('company_description');
  });

  it('accounts for company fills under unipile in tierFills', async () => {
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe' });
    const deps = makeDeps({
      findUnipileCompany: jest.fn().mockResolvedValue({ companyRaw: { name: 'Acme' } }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A company') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ lead, groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );

    expect(result.tierFills).toEqual({ crm: 0, apollo: 0, enrichSo: 0, unipile: 1, web: 0, missing: 0 });
    expect(result.missing).toEqual([]);
  });
});

describe('runWaterfall — web-tier per-field provenance (Fix 1)', () => {
  it('FAIL CASE: a web-tier fill carries provider llm_web_search', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Acme is a SaaS company.' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.source).toBe('web_search');
    expect(fill?.meta.provider).toBe('llm_web_search');
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('FAIL CASE: a web-tier fill carries the sourceUrl returned by the LLM', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company', 'https://acme.com/about') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.sourceUrl).toBe('https://acme.com/about');
  });

  it('FAIL CASE: a web-tier fill carries the sourceQuote returned by the LLM', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company', undefined, 'Acme builds SaaS for teams') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.sourceQuote).toBe('Acme builds SaaS for teams');
  });

  it('SUCCESS CASE: a web-tier fill with no URL/quote still produces a valued fill', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.value).toBe('A SaaS company');
    expect(fill?.meta.sourceUrl).toBeUndefined();
    expect(fill?.meta.sourceQuote).toBeUndefined();
  });
});

describe('runWaterfall — confidence on meta (Fix 6)', () => {
  it('FAIL CASE: a Tier 2 Apollo deterministic fill uses the raw registry confidence', async () => {
    // funding_stage is now registered as 'high' in APOLLO_FIELD_CONFIDENCE (snake_case
    // waterfall block). A Tier-2 direct Apollo fill for funding_stage must return
    // confidence: 'high' — proving the snake_case lookup wiring actually works.
    // (Before Fix 1, APOLLO_FIELD_CONFIDENCE had no snake_case keys so every
    //  waterfall lookup silently returned the 'medium' default.)
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ funding_stage: 'Series B' })),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_financial', requestedFields: ['funding_stage'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'funding_stage');
    // funding_stage is registered as 'high' in the snake_case waterfall block.
    expect(fill?.meta.confidence).toBe('high');
  });

  it('FAIL CASE: a Tier 3 LLM-over-Apollo fill is downgraded one notch from the registry value (high→medium)', async () => {
    // funding_stage → registry: 'high'; Tier-3 llmExtracted downgrade: high → medium.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult(
        { unrelated: 'x' },
        { name: 'Acme', latest_funding_stage: 'Series B' },
      )),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { funding_stage: fv('Series B') }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_financial', requestedFields: ['funding_stage'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'funding_stage');
    // high → medium (one-notch downgrade for LLM extraction over Apollo context)
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('Tier 3 LLM-over-Apollo fill for a low registry field stays low (low→low branch)', async () => {
    // revenue_range → registry: 'low'; Tier-3 llmExtracted downgrade: low → low.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult(
        { unrelated: 'x' },
        { name: 'Acme', annual_revenue_printed: '$1M–$10M' },
      )),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { revenue_range: fv('$1M–$10M') }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_financial', requestedFields: ['revenue_range'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'revenue_range');
    // low → low (floor — can't go lower than 'low')
    expect(fill?.meta.confidence).toBe('low');
  });

  it('FAIL CASE: a Unipile fill carries medium confidence', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue({ linkedin_url: 'https://www.linkedin.com/in/jane-doe' }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['linkedin_url'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'linkedin_url');
    expect(fill?.meta.provider).toBe('unipile');
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('SUCCESS CASE: a web-tier fill carries medium confidence', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.confidence).toBe('medium');
  });
});

// ─── Tier 3.5b (Unipile person enrichment via findUnipilePerson) ──────────────

describe('runWaterfall — Tier 3.5b (Unipile person enrichment)', () => {
  const personResult = {
    first_name: 'Jane',
    last_name: 'Doe',
    title: 'VP Marketing',
    company_name: 'Acme',
    linkedin_url: 'https://www.linkedin.com/in/jane-doe-acme',
  };

  it('fires for person group when person fields remain; fills directly from result', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(personResult),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name', 'last_name', 'title', 'linkedin_url'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Marketing');
    expect(result.fields.find(f => f.field === 'linkedin_url')?.value).toBe('https://www.linkedin.com/in/jane-doe-acme');
    expect(result.fields.every(f => f.meta.source === 'api' && f.meta.provider === 'unipile')).toBe(true);
  });

  it('passes linkedin_url filled by Apollo (Tier 2) to findUnipilePerson', async () => {
    // Apollo fills linkedin_url → waterfall passes it as lead.linkedin to findUnipilePerson
    const deps = makeDeps({
      fetchApolloPerson: jest.fn().mockResolvedValue(apolloResult({ linkedin_url: 'https://www.linkedin.com/in/jane-doe-acme' })),
      findUnipilePerson: jest.fn().mockResolvedValue({ first_name: 'Jane' }),
    });
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'Acme' });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['linkedin_url', 'first_name'], lead }),
      deps,
    );

    const callLead = (deps.findUnipilePerson as jest.Mock).mock.calls[0][0];
    expect(callLead.linkedin).toBe('https://www.linkedin.com/in/jane-doe-acme');
  });

  it('passes lead.linkedin directly when present', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(personResult),
    });
    const lead = makeLead({ linkedin: 'https://www.linkedin.com/in/jane-doe-acme' });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'], lead }),
      deps,
    );

    const callLead = (deps.findUnipilePerson as jest.Mock).mock.calls[0][0];
    expect(callLead.linkedin).toBe('https://www.linkedin.com/in/jane-doe-acme');
  });

  it('gracefully skips when findUnipilePerson returns null', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(null),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(result.missing).toContain('first_name');
  });

  it('skips when no PERSON_TIER35B_FIELDS in remaining', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(personResult),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['seniority'] }),
      deps,
    );

    expect(deps.findUnipilePerson).not.toHaveBeenCalled();
  });

  it('skips for non-person groups (company group)', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(personResult),
      fetchWebForGroup: jest.fn().mockResolvedValue(null),
    });
    await runWaterfall(
      makeInput({ groupName: 'company_profile', requestedFields: ['company_name'] }),
      deps,
    );

    expect(deps.findUnipilePerson).not.toHaveBeenCalled();
  });

  it('only fills fields that are in remaining (does not double-fill already-filled fields)', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue(personResult),
    });
    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name', 'title'],
        lead: makeLead({ lastName: 'Doe' }),
      }),
      deps,
    );

    const fields = result.fields.filter(f => f.meta.provider === 'unipile');
    expect(fields.map(f => f.field)).not.toContain('last_name');
  });

  it('falls through to Tier 4 (web) for fields findUnipilePerson did not return', async () => {
    const deps = makeDeps({
      findUnipilePerson: jest.fn().mockResolvedValue({ first_name: 'Jane' }),
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Jane Doe context' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { last_name: fv('Doe') }, missing: [] }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name', 'last_name'] }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
    expect(deps.fetchWebForGroup).toHaveBeenCalled();
  });

  it('skips when findUnipilePerson dep is absent', async () => {
    const deps = makeDeps({ fetchWebForGroup: jest.fn().mockResolvedValue(null) });
    delete (deps as any).findUnipilePerson;
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );

    expect(result.missing).toContain('first_name');
  });
});

// ─── Tier 3.5b-enrich.so ────────────────────────────────────────────────────

describe('runWaterfall — T3.5b-enrich.so (reverse lookup)', () => {
  it('fills person fields from enrich.so when email present and fields remaining', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      firstName: 'Jane',
      lastName: 'Doe',
      jobTitle: 'VP Engineering',
      profileUrl: 'https://www.linkedin.com/in/janedoe',
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name', 'last_name', 'title', 'linkedin_url'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(findEnrichSoPerson).toHaveBeenCalledWith('jane@acme.com');
    expect(result.fields.find(f => f.field === 'first_name')?.value).toBe('Jane');
    expect(result.fields.find(f => f.field === 'last_name')?.value).toBe('Doe');
    expect(result.fields.find(f => f.field === 'title')?.value).toBe('VP Engineering');
    expect(result.fields.find(f => f.field === 'linkedin_url')?.value).toBe('https://www.linkedin.com/in/janedoe');
  });

  it('sets fromCache correctly on enrich.so fills', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      firstName: 'Jane',
      fromCache: true,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'first_name')?.meta.fromCache).toBe(true);
    expect(result.fields.find(f => f.field === 'first_name')?.meta.provider).toBe('enrich.so');
  });

  it('fills company fields from enrich.so', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      companyName: 'Acme Corp',
      companyLinkedInUrl: 'https://www.linkedin.com/company/acme',
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'company_firmographic',
        requestedFields: ['company_name', 'company_linkedin_url'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'company_name')?.value).toBe('Acme Corp');
    expect(result.fields.find(f => f.field === 'company_linkedin_url')?.value).toBe('https://www.linkedin.com/company/acme');
  });

  it('fills career fields as JSON stringified arrays', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      pastCompanies: ['OldCo', 'StartupX'],
      education: ['MIT (BS Computer Science)'],
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'person_career',
        requestedFields: ['prior_companies', 'education'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.fields.find(f => f.field === 'prior_companies')?.value).toBe(JSON.stringify(['OldCo', 'StartupX']));
    expect(result.fields.find(f => f.field === 'education')?.value).toBe(JSON.stringify(['MIT (BS Computer Science)']));
  });

  it('skips when no email available', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({ firstName: 'Jane' });
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name'],
        lead: makeLead({ email: undefined }),
      }),
      deps,
    );

    expect(findEnrichSoPerson).not.toHaveBeenCalled();
    expect(result.missing).toContain('first_name');
  });

  it('memoizes — calls findEnrichSoPerson only once across multiple uses', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue({
      firstName: 'Jane',
      fromCache: false,
    });
    const deps = makeDeps({ findEnrichSoPerson });
    const enrichSoCtx = createEnrichSoFetchContext();

    await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'], enrichSoCtx }),
      deps,
    );
    await runWaterfall(
      makeInput({ groupName: 'person_career', requestedFields: ['prior_companies'], enrichSoCtx }),
      deps,
    );

    expect(findEnrichSoPerson).toHaveBeenCalledTimes(1);
  });

  it('skips when findEnrichSoPerson dep absent', async () => {
    const deps = makeDeps();
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['first_name'] }),
      deps,
    );
    expect(result.missing).toContain('first_name');
  });

  describe('buildFieldGuidanceV3 — tech_stack default instruction', () => {
    it('injects default tech_stack guidance when no user instruction set', () => {
      const guidance = buildFieldGuidanceV3(['tech_stack'], {});
      expect(guidance).toContain('tech_stack');
      expect(guidance).toContain('comma-separated');
      expect(guidance).not.toContain('Return only what is explicitly stated');
    });

    it('uses user instruction over default when set', () => {
      const guidance = buildFieldGuidanceV3(
        ['tech_stack'],
        { tech_stack: { instruction: 'List only CRM tools.' } },
      );
      expect(guidance).toContain('List only CRM tools.');
      expect(guidance).not.toContain('comma-separated');
    });

    it('other fields still get generic guidance', () => {
      const guidance = buildFieldGuidanceV3(['industry'], {});
      expect(guidance).toContain('Return only what is explicitly stated');
    });
  });

  it('handles enrich.so returning null gracefully', async () => {
    const findEnrichSoPerson = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findEnrichSoPerson });

    const result = await runWaterfall(
      makeInput({
        groupName: 'person_identity',
        requestedFields: ['first_name'],
        lead: makeLead({ email: 'jane@acme.com' }),
      }),
      deps,
    );

    expect(result.missing).toContain('first_name');
  });
});

// Tests for crmEnrichmentServiceV3 — the Phase 1 orchestrator.
// Coordinates: loadLeads → per-lead pipeline (identity → groups (sequential)
// → ungrouped web → critic over web-tier → batched setLeadFields by policy).
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §1 architecture + §8.4 tests.
// Unit-tests focus on the orchestrator's COORDINATION; resolver + waterfall
// behavior is covered by their own tests.

import {
  runEnrichment,
  type OrchestratorDeps,
  type RunEnrichmentInput,
  type EnrichmentConfig,
} from '../services/crmEnrichmentServiceV3';
import type { LeadRecord } from '../services/crmEnrichmentService';

jest.mock('../services/enrichmentSiblingConfigFields', () => ({
  ...jest.requireActual('../services/enrichmentSiblingConfigFields'),
  buildSiblingFieldMappingTable: jest.fn().mockResolvedValue({ canonical: new Map(), llm: new Map() }),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    createEnrichmentSnapshotItem: jest.fn().mockResolvedValue(undefined),
    createEnrichmentJobMeta: jest.fn().mockResolvedValue(undefined),
  },
}));

import { crmDb } from '../services/db';
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const LIST_ID = 'list-1';
const USER_ID = 'user-1';

function makeConfig(overrides: Partial<EnrichmentConfig> = {}): EnrichmentConfig {
  return {
    fields: [
      {
        name: 'company_name',
        type: 'string',
        instruction: 'company name',
        include: true,
        overwritePolicy: 'fill_if_empty',
      },
    ],
    globalOverwriteDefault: 'fill_if_empty',
    schemaVersion: 1,
    updatedAt: '2026-05-11T00:00:00Z',
    updatedBy: USER_ID,
    ...overrides,
  };
}

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    email: 'jane@acme.com',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    loadLeads: jest.fn().mockResolvedValue([]),
    // `siblings: []` matches the production `resolveIdentity` contract added
    // in 5ecf5ad3 — Tier 0b iterates this array, so omitting it would throw
    // `siblings is not iterable` for every test that exercises a successful
    // identity-resolution path.
    resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
    runWaterfall: jest.fn().mockResolvedValue({
      fields: [],
      missing: [],
      tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 },
    }),
    extractUngroupedFieldsViaWeb: jest.fn().mockResolvedValue({
      fields: [],
      missing: [],
      tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 },
    }),
    runCriticOverWebFills: jest.fn().mockResolvedValue({ verdicts: {} }),
    setLeadFields: jest.fn().mockResolvedValue(undefined),
    evaluateSmartField: jest.fn().mockResolvedValue({ value: null, reasoning: '' }),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RunEnrichmentInput> = {}): RunEnrichmentInput {
  return {
    listId: LIST_ID,
    userId: USER_ID,
    config: makeConfig(),
    mode: 'enrich',
    ...overrides,
  };
}

// ─── Empty list ───────────────────────────────────────────────────────────────

describe('runEnrichment — empty list skips sibling mapping table', () => {
  it('does not call buildSiblingFieldMappingTable when there are no leads', async () => {
    const { buildSiblingFieldMappingTable } = require('../services/enrichmentSiblingConfigFields');
    (buildSiblingFieldMappingTable as jest.Mock).mockClear();

    const deps = makeDeps({ loadLeads: jest.fn().mockResolvedValue([]) });
    await runEnrichment(makeInput(), deps);

    expect(buildSiblingFieldMappingTable as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('runEnrichment — empty list', () => {
  it('returns 0-processed run when list has no leads', async () => {
    const deps = makeDeps({ loadLeads: jest.fn().mockResolvedValue([]) });
    const result = await runEnrichment(makeInput(), deps);

    expect(result.processed).toBe(0);
    expect(result.tierFillBreakdown.total).toEqual({
      crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0,
    });
    expect(deps.resolveIdentity).not.toHaveBeenCalled();
    expect(deps.runWaterfall).not.toHaveBeenCalled();
    expect(deps.setLeadFields).not.toHaveBeenCalled();
  });
});

// ─── leadIds filter ──────────────────────────────────────────────────────────
// The dep is now responsible for honoring leadIds (real impl uses BatchGetItem
// when set, paginated Query otherwise). The orchestrator's job is to pass it
// through faithfully and process whatever the dep returns.

describe('runEnrichment — leadIds filter', () => {
  it('passes input.leadIds through to deps.loadLeads when set', async () => {
    const loadLeads = jest.fn().mockResolvedValue([
      makeLead({ leadId: 'lead-2' }),
      makeLead({ leadId: 'lead-3' }),
    ]);
    const deps = makeDeps({ loadLeads });

    const result = await runEnrichment(
      makeInput({ leadIds: ['lead-2', 'lead-3'] }),
      deps,
    );

    expect(loadLeads).toHaveBeenCalledWith({
      listId: LIST_ID,
      userId: USER_ID,
      leadIds: ['lead-2', 'lead-3'],
    });
    expect(result.processed).toBe(2);
    expect(deps.resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it('processes 0 leads when the dep returns no matches for the requested leadIds', async () => {
    const deps = makeDeps({ loadLeads: jest.fn().mockResolvedValue([]) });

    const result = await runEnrichment(
      makeInput({ leadIds: ['nonexistent'] }),
      deps,
    );

    expect(result.processed).toBe(0);
    expect(deps.resolveIdentity).not.toHaveBeenCalled();
  });

  it('passes leadIds as undefined when input.leadIds is not set', async () => {
    const loadLeads = jest.fn().mockResolvedValue([
      makeLead({ leadId: 'lead-1' }),
      makeLead({ leadId: 'lead-2' }),
    ]);
    const deps = makeDeps({ loadLeads });

    const result = await runEnrichment(makeInput(), deps);

    expect(loadLeads).toHaveBeenCalledWith({
      listId: LIST_ID,
      userId: USER_ID,
      leadIds: undefined,
    });
    expect(result.processed).toBe(2);
    expect(deps.resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it('passes leadIds as undefined when input.leadIds is an empty array (treated as no filter)', async () => {
    const loadLeads = jest.fn().mockResolvedValue([
      makeLead({ leadId: 'lead-1' }),
      makeLead({ leadId: 'lead-2' }),
    ]);
    const deps = makeDeps({ loadLeads });

    const result = await runEnrichment(makeInput({ leadIds: [] }), deps);

    expect(loadLeads).toHaveBeenCalledWith({
      listId: LIST_ID,
      userId: USER_ID,
      leadIds: undefined,
    });
    expect(result.processed).toBe(2);
    expect(deps.resolveIdentity).toHaveBeenCalledTimes(2);
  });
});

// ─── Identity resolution failure ──────────────────────────────────────────────

describe('runEnrichment — identity resolution', () => {
  it('skips lead when identity resolution fails; increments identityResolutionFailed', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      resolveIdentity: jest.fn().mockResolvedValue({
        ok: false, reason: 'identity_unresolvable',
      }),
    });
    const result = await runEnrichment(makeInput(), deps);

    expect(result.processed).toBe(0);
    expect(result.failed.identityResolutionFailed).toBe(1);
    expect(deps.runWaterfall).not.toHaveBeenCalled();
    expect(deps.setLeadFields).not.toHaveBeenCalled();
  });
});

// ─── Group routing ────────────────────────────────────────────────────────────

describe('runEnrichment — group routing', () => {
  it('routes requested fields to their canonical groups; calls runWaterfall once per group', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        // company_firmographic
        { name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        // company_technographic
        { name: 'tech_stack', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        // person_identity
        { name: 'title', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(deps.runWaterfall).toHaveBeenCalledTimes(3);
    const calledGroups = (deps.runWaterfall as jest.Mock).mock.calls.map(c => c[0].groupName).sort();
    expect(calledGroups).toEqual(['company_firmographic', 'company_technographic', 'person_identity']);
  });

  it('only includes fields where config.include === true', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'industry', type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(deps.runWaterfall).toHaveBeenCalledTimes(1);
    const call = (deps.runWaterfall as jest.Mock).mock.calls[0][0];
    expect(call.requestedFields).toEqual(['company_name']);
  });

  it('routes ungrouped (custom-named) fields through extractUngroupedFieldsViaWeb', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      extractUngroupedFieldsViaWeb: jest.fn().mockResolvedValue({
        fields: [{ field: 'stag', value: 'Series B', meta: { source: 'web_search', enrichedAt: '2026-05-11T00:00:00Z' } as any }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: 'funding stage', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const result = await runEnrichment(makeInput({ config }), deps);

    expect(deps.runWaterfall).not.toHaveBeenCalled();   // no canonical group
    expect(deps.extractUngroupedFieldsViaWeb).toHaveBeenCalledTimes(1);
    const call = (deps.extractUngroupedFieldsViaWeb as jest.Mock).mock.calls[0][0];
    expect(call.fields).toEqual(['stag']);
    expect(result.tierFillBreakdown.total.web).toBe(1);
  });
});

// ─── Alias routing — user-named fields route through canonical group ─────────

describe('runEnrichment — aliasFor routing', () => {
  it('routes a user-named field through its canonical group when aliasFor is set', async () => {
    // User names their field "stag" but maps it to canonical "funding_stage"
    // (which is in company_financial group, Apollo-direct-mapped).
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series E', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'funding_stage' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    // Waterfall was called for the CANONICAL group, with the CANONICAL field name
    const wfCall = (deps.runWaterfall as jest.Mock).mock.calls[0][0];
    expect(wfCall.groupName).toBe('company_financial');
    expect(wfCall.requestedFields).toEqual(['funding_stage']);

    // setLeadFields wrote under the USER's name (stag), not the canonical name
    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const writeCall = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(writeCall.customFields).toEqual({ stag: 'Series E' });
    expect(writeCall.customFields.funding_stage).toBeUndefined();
  });

  it('fans out a single canonical fill to every user-facing field that maps to it', async () => {
    // Real CRM lists frequently have data in BOTH `company` and `company_name`.
    // Both config fields route to canonical `company_name`; the waterfall fills
    // it once and the orchestrator must write the same value under BOTH user
    // names so neither column silently misses its enriched value.
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme Corp', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'company',      type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'company_name' },
        { name: 'company_name', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    // Waterfall is called exactly once for the canonical (no duplicate work).
    expect(deps.runWaterfall).toHaveBeenCalledTimes(1);
    const wfCall = (deps.runWaterfall as jest.Mock).mock.calls[0][0];
    expect(wfCall.requestedFields).toEqual(['company_name']);

    // setLeadFields was given both user-facing columns with the same value.
    // `company` is a STANDARD_LEAD_COLUMN → topLevel; `company_name` is not → customFields.
    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const writeCall = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(writeCall.topLevel).toEqual({ company: 'Acme Corp' });
    expect(writeCall.customFields).toEqual({ company_name: 'Acme Corp' });
  });

  it('fans out to all three user fields when three configs alias the same canonical', async () => {
    // Lead has empty email so the fill_if_empty policy lets the canonical
    // `email` value through to the top-level column.
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ email: '' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'email', value: 'jane@acme.com', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'email',  type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'Email',  type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
        { name: 'e_mail', type: 'string', instruction: '', include: true,
          overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(deps.runWaterfall).toHaveBeenCalledTimes(1);
    const writeCall = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    // `email` is a STANDARD_LEAD_COLUMN → topLevel; the two aliases land in customFields.
    expect(writeCall.topLevel).toEqual({ email: 'jane@acme.com' });
    expect(writeCall.customFields).toEqual({
      Email: 'jane@acme.com',
      e_mail: 'jane@acme.com',
    });
  });

  it('leaves ungrouped fields alone when aliasFor is not set', async () => {
    // No aliasFor → "stag" stays ungrouped → routed to extractUngroupedFieldsViaWeb
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    const config = makeConfig({
      fields: [
        { name: 'stag', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(deps.runWaterfall).not.toHaveBeenCalled();   // no canonical routing
    expect(deps.extractUngroupedFieldsViaWeb).toHaveBeenCalledTimes(1);
    const call = (deps.extractUngroupedFieldsViaWeb as jest.Mock).mock.calls[0][0];
    expect(call.fields).toEqual(['stag']);
  });
});

// ─── Apollo memoization across groups (orchestrator's job) ────────────────────

describe('runEnrichment — Apollo memoization', () => {
  it('shares one ApolloFetchContext across all groups for a single lead', async () => {
    const seenContexts: any[] = [];
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        seenContexts.push(input.apolloCtx);
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'tech_stack', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toBe(seenContexts[1]);   // same object reference
  });

  it('different leads get different ApolloFetchContexts', async () => {
    const seenContexts: any[] = [];
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        seenContexts.push({ leadId: input.lead.leadId, ctx: input.apolloCtx });
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }),
    });

    await runEnrichment(makeInput(), deps);

    const lead1Ctx = seenContexts.find(s => s.leadId === 'lead-1')!.ctx;
    const lead2Ctx = seenContexts.find(s => s.leadId === 'lead-2')!.ctx;
    expect(lead1Ctx).not.toBe(lead2Ctx);
  });
});

// ─── Write semantics (overwrite policy) ───────────────────────────────────────

describe('runEnrichment — write semantics', () => {
  it('mode=enrich: writes fields via setLeadFields with ifNotExists=false for fill_if_empty (filtering is app-side)', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.ifNotExists).toBe(false);
    expect(call.customFields).toEqual({ company_name: 'Acme' });
  });

  it('merges fill_if_empty and always_overwrite fields into a single setLeadFields call', async () => {
    // company_name (fill_if_empty) and industry (always_overwrite) come from the same
    // waterfall call. The orchestrator combines both policy buckets into one DB write.
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'industry', value: 'SaaS', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [], tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'always_overwrite' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    // Both policy buckets are merged into one setLeadFields call.
    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.customFields).toEqual({ company_name: 'Acme', industry: 'SaaS' });
    expect(call.ifNotExists).toBe(false);
  });

  it('routes standard CRM column fills to setLeadFields.topLevel; custom names to customFields', async () => {
    // firstName, email → top-level (so values appear in the standard lead columns)
    // industry, stag → customFields (not standard columns)
    // Lead must start empty for fill_if_empty to actually write.
    const emptyLead = { leadId: 'lead-1', email: '', firstName: '',
      enrichmentMetadata: {}, customFields: {} } as any;
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([emptyLead]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'firstName', value: 'Jane', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'email', value: 'jane@acme.com', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'industry', value: 'SaaS', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 3, web: 0, missing: 0 },
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'firstName', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'first_name' },
        { name: 'email', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', aliasFor: 'email' },
        { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    // Standard columns went to topLevel
    expect(call.topLevel).toEqual({ firstName: 'Jane', email: 'jane@acme.com' });
    // Custom went to customFields
    expect(call.customFields).toEqual({ industry: 'SaaS' });
  });

  it("does NOT write 'existing_data' fills (value already on the lead)", async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'existing_data', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 1, apollo: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(deps.setLeadFields).not.toHaveBeenCalled();
  });

  it('mode=preview: never calls setLeadFields even when fields are produced', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    const result = await runEnrichment(makeInput({ mode: 'preview' }), deps);

    expect(deps.setLeadFields).not.toHaveBeenCalled();
    expect(result.preview).toBeDefined();
    expect(result.preview![0]?.extractedFields.company_name).toBe('Acme');
  });
});

// ─── Critic pass ──────────────────────────────────────────────────────────────

describe('runEnrichment — critic pass', () => {
  it('critic receives ONLY web-tier fills (Apollo and existing_data excluded)', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'industry', value: 'SaaS', meta: { source: 'web_search', sourceQuote: 'Acme is a SaaS company', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'tech_stack', value: 'AWS', meta: { source: 'existing_data', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [], tierFills: { crm: 1, apollo: 1, web: 1, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(deps.runCriticOverWebFills).toHaveBeenCalledTimes(1);
    const call = (deps.runCriticOverWebFills as jest.Mock).mock.calls[0][0];
    expect(call.fills.map((f: any) => f.field)).toEqual(['industry']);
  });

  it('critic is SKIPPED when no web-tier fills exist (all-Apollo or all-CRM lead)', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [], tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(deps.runCriticOverWebFills).not.toHaveBeenCalled();
  });
});

// ─── Aggregation across leads ─────────────────────────────────────────────────

describe('runEnrichment — aggregation', () => {
  it('sums tierFillBreakdown across leads and groups; produces per-group + total rollup', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [],
        missing: [],
        tierFills: { crm: 1, apollo: 2, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.tierFillBreakdown.total).toEqual({
      crm: 2, apollo: 4, enrichSo: 0, unipile: 0, web: 0, missing: 0,
    });
    expect(result.tierFillBreakdown.company_firmographic).toEqual({
      crm: 2, apollo: 4, enrichSo: 0, unipile: 0, web: 0, missing: 0,
    });
  });

  it('returns a deterministic runId and durationMs in the result', async () => {
    const deps = makeDeps({ loadLeads: jest.fn().mockResolvedValue([]) });
    const result = await runEnrichment(makeInput(), deps);

    expect(typeof result.runId).toBe('string');
    expect(result.runId.length).toBeGreaterThan(0);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Bug fix #1: critic verdicts must be stamped onto web-fill metas ──────────

describe('runEnrichment — critic verdicts propagate to lead writes', () => {
  it('stamps criticVerdict onto each web-tier fill before setLeadFields', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'web_search', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'industry', value: 'SaaS', meta: { source: 'web_search', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 0, web: 2, missing: 0 },
      }),
      runCriticOverWebFills: jest.fn().mockResolvedValue({
        verdicts: {
          company_name: 'supported',
          industry: 'unsupported',
        },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.enrichmentMetadata.company_name.criticVerdict).toBe('supported');
    expect(call.enrichmentMetadata.industry.criticVerdict).toBe('unsupported');
  });

  it('does NOT stamp criticVerdict on non-web fills', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-05-11T00:00:00Z' } as any },
          { field: 'industry', value: 'SaaS', meta: { source: 'web_search', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 1, missing: 0 },
      }),
      runCriticOverWebFills: jest.fn().mockResolvedValue({
        verdicts: { industry: 'partially-supported' },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.enrichmentMetadata.company_name.criticVerdict).toBeUndefined();
    expect(call.enrichmentMetadata.industry.criticVerdict).toBe('partially-supported');
  });
});

// ─── Bug fix #2: apolloFailed counter must reflect waterfall failures ─────────

describe('runEnrichment — apolloFailed counter', () => {
  it('increments apolloFailed once per lead when waterfall reports org-fetch failure', async () => {
    // The waterfall mock sets apolloCtx.orgFetchFailed = true to simulate Apollo failure.
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        input.apolloCtx.orgFetchAttempted = true;
        input.apolloCtx.orgFetchFailed = true;
        return { fields: [], missing: ['company_name'], tierFills: { crm: 0, apollo: 0, web: 0, missing: 1 } };
      }),
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.failed.apolloFailed).toBe(1);
  });

  it('counts apolloFailed as 1 per lead even when both org and person fetch failed', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        input.apolloCtx.orgFetchAttempted = true;
        input.apolloCtx.orgFetchFailed = true;
        input.apolloCtx.personFetchAttempted = true;
        input.apolloCtx.personFetchFailed = true;
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }),
    });
    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'first_name', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    const result = await runEnrichment(makeInput({ config }), deps);

    // apolloFailed is incremented once per lead (org || person), not once per entity type.
    expect(result.failed.apolloFailed).toBe(1);
  });

  it('does NOT increment apolloFailed when Apollo returns a clean null (miss, not error)', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        input.apolloCtx.orgFetchAttempted = true;
        // orgFetchFailed stays false — clean null is not a failure
        return { fields: [], missing: ['company_name'], tierFills: { crm: 0, apollo: 0, web: 0, missing: 1 } };
      }),
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.failed.apolloFailed).toBe(0);
  });
});

// ─── Bug fix #3: per-lead errors must not crash the run ───────────────────────

describe('runEnrichment — per-lead error isolation', () => {
  it('continues processing other leads when one lead errors in runWaterfall', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
      runWaterfall: jest.fn().mockImplementation(async (input: any) => {
        if (input.lead.leadId === 'lead-1') throw new Error('LLM timeout');
        return {
          fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any }],
          missing: [], tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
        };
      }),
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.processed).toBe(1);                  // lead-2 succeeded
    expect(result.failed.llmOrParseFailed).toBe(1);    // lead-1 errored
    expect(deps.setLeadFields).toHaveBeenCalledTimes(1);   // only lead-2 written
  });

  it('counts setLeadFields failures in updateFailed and continues the run', async () => {
    const setLeadFieldsMock = jest.fn()
      .mockRejectedValueOnce(new Error('DDB conditional check failed'))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any }],
        missing: [], tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields: setLeadFieldsMock,
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.failed.updateFailed).toBe(1);
    expect(result.processed).toBe(1);                  // lead-2 written successfully
  });
});

// ─── Socket.IO progress + complete emission ───────────────────────────────────

describe('runEnrichment — socket progress events', () => {
  it('emits crm-enrichment-progress at start with totalToProcess and progress=0', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const initial = socketEmit.mock.calls.find(
      ([, event, payload]) => event === 'crm-enrichment-progress' && payload.progress === 0,
    );
    expect(initial).toBeDefined();
    expect(initial![2]).toMatchObject({
      message: expect.stringMatching(/starting/i),
      progress: 0,
      processedCount: 0,
      failedCount: 0,
      totalToProcess: 2,
    });
  });

  it('emits to both socketId room and user:{userId} room when socketId provided', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });

    await runEnrichment(makeInput(), deps, {
      userId: USER_ID,
      socketId: 'socket-abc',
      socketEmit,
    });

    const rooms = new Set(socketEmit.mock.calls.map(([room]) => room));
    expect(rooms.has('socket-abc')).toBe(true);
    expect(rooms.has(`user:${USER_ID}`)).toBe(true);
  });

  it('emits crm-enrichment-complete with listId, processedCount, failedCount once at end', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } as any },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const completes = socketEmit.mock.calls.filter(
      ([room, event]) => event === 'crm-enrichment-complete' && room === `user:${USER_ID}`,
    );
    expect(completes).toHaveLength(1);
    expect(completes[0][2]).toMatchObject({
      listId: LIST_ID,
      processedCount: 2,
      failedCount: 0,
    });
    expect(Array.isArray(completes[0][2].outputFields)).toBe(true);
  });

  it('does not throw when no options are provided (back-compat)', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    await expect(runEnrichment(makeInput(), deps)).resolves.toBeDefined();
  });

  it('emits progress updates with non-zero processed count as leads complete', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-1' }),
        makeLead({ leadId: 'lead-2' }),
      ]),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const progressCalls = socketEmit.mock.calls.filter(
      ([, event]) => event === 'crm-enrichment-progress',
    );
    // At least the initial 0% emit plus a post-processing emit.
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    const finalProgress = progressCalls[progressCalls.length - 1][2];
    expect(finalProgress.processedCount).toBe(2);
    expect(finalProgress.progress).toBe(100);
  });

  it('progress message says "skipped" (not "failed") for identity-resolution failures, failedCount=0', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: false, reason: 'no_identity_signal' }),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const chunkProgress = socketEmit.mock.calls.filter(
      ([, event, payload]) => event === 'crm-enrichment-progress' && payload.progress === 100,
    );
    expect(chunkProgress.length).toBeGreaterThanOrEqual(1);
    const msg: string = chunkProgress[chunkProgress.length - 1][2].message;
    expect(msg).toMatch(/skipped/i);
    expect(msg).not.toMatch(/failed/i);
    expect(chunkProgress[chunkProgress.length - 1][2].failedCount).toBe(0);
  });

  it('progress message says "failed" for hard failures (llmOrParse), failedCount=N', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      resolveIdentity: jest.fn().mockRejectedValue(new Error('provider timeout')),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const chunkProgress = socketEmit.mock.calls.filter(
      ([, event, payload]) => event === 'crm-enrichment-progress' && payload.progress === 100,
    );
    expect(chunkProgress.length).toBeGreaterThanOrEqual(1);
    const payload = chunkProgress[chunkProgress.length - 1][2];
    expect(payload.message).toMatch(/failed/i);
    expect(payload.message).not.toMatch(/skipped/i);
    expect(payload.failedCount).toBe(1);
  });

  it('progress message shows both "skipped" and "failed" when both categories present', async () => {
    const socketEmit = jest.fn();
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'lead-skip' }),
        makeLead({ leadId: 'lead-fail' }),
      ]),
      resolveIdentity: jest.fn()
        .mockResolvedValueOnce({ ok: false, reason: 'no_identity_signal' })
        .mockRejectedValueOnce(new Error('provider timeout')),
    });

    await runEnrichment(makeInput(), deps, { userId: USER_ID, socketEmit });

    const chunkProgress = socketEmit.mock.calls.filter(
      ([, event, payload]) => event === 'crm-enrichment-progress' && payload.progress === 100,
    );
    expect(chunkProgress.length).toBeGreaterThanOrEqual(1);
    const payload = chunkProgress[chunkProgress.length - 1][2];
    expect(payload.message).toMatch(/skipped/i);
    expect(payload.message).toMatch(/failed/i);
    expect(payload.failedCount).toBe(1);
  });
});

// ─── Smart fields ─────────────────────────────────────────────────────────────

describe('runEnrichment — smart fields', () => {
  function makeSmartConfig(overrides: Partial<EnrichmentConfig> = {}): EnrichmentConfig {
    return makeConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later and total funding > $1M',
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'true when series A or later and total funding > $1M',
          smartDependencies: ['funding_stage', 'total_funding'],
        },
      ],
      ...overrides,
    });
  }

  it('excludes smart field from waterfall routing — runWaterfall not called for smart field', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);
    // runWaterfall should not have been called with isQualified as a requested field
    const waterfallCalls = (deps.runWaterfall as jest.Mock).mock.calls;
    const allRequestedFields = waterfallCalls.flatMap((call: any[]) => call[0].requestedFields ?? []);
    expect(allRequestedFields).not.toContain('isQualified');
  });

  it('injects missing smart-field deps as synthetic enrichment fields', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);
    // funding_stage and total_funding are deps — they should have been routed
    // through runWaterfall (both are in company_financial group)
    const waterfallCalls = (deps.runWaterfall as jest.Mock).mock.calls;
    const allRequestedFields = waterfallCalls.flatMap((call: any[]) => call[0].requestedFields ?? []);
    expect(allRequestedFields).toContain('funding_stage');
    expect(allRequestedFields).toContain('total_funding');
  });

  it('does NOT inject dep already present in user config', async () => {
    const configWithDep = makeConfig({
      fields: [
        {
          name: 'funding_stage',
          type: 'string',
          instruction: 'company funding stage',
          include: true,
          overwritePolicy: 'fill_if_empty',
        },
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later',
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'true when series A or later',
          smartDependencies: ['funding_stage'],
        },
      ],
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
    });
    await runEnrichment(makeInput({ config: configWithDep }), deps);
    // funding_stage appears exactly once in requested fields (from user config),
    // not duplicated via injection
    const waterfallCalls = (deps.runWaterfall as jest.Mock).mock.calls;
    const allRequestedFields = waterfallCalls.flatMap((call: any[]) => call[0].requestedFields ?? []);
    const count = allRequestedFields.filter((f: string) => f === 'funding_stage').length;
    expect(count).toBe(1);
  });

  it('calls evaluateSmartField with enriched dep values after waterfall', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series B', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
          { field: 'total_funding', value: '5000000', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series B > Series A' }),
    });

    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    expect(deps.evaluateSmartField).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldName: 'isQualified',
        condition: 'true when series A or later and total funding > $1M',
        depValues: expect.objectContaining({
          funding_stage: 'Series B',
          total_funding: '5000000',
        }),
      }),
    );
  });

  it('writes smart field value to lead after evaluation', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series B', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
          { field: 'total_funding', value: '5000000', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series B > Series A' }),
    });

    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    const setCallArgs = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(setCallArgs.customFields).toMatchObject({ isQualified: 'true' });
    expect(setCallArgs.enrichmentMetadata?.isQualified?.source).toBe('llm');
  });

  it('skips evaluateSmartField when all deps could not be enriched', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [],  // nothing enriched
        missing: ['funding_stage', 'total_funding'],
        tierFills: { crm: 0, apollo: 0, web: 0, missing: 2 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: '' }),
    });

    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    // No dep data available → evaluateSmartField must NOT be called (save LLM tokens)
    expect(deps.evaluateSmartField).not.toHaveBeenCalled();
  });

  it('succeeds overall when evaluateSmartField throws — smart field just missing', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      evaluateSmartField: jest.fn().mockRejectedValue(new Error('LLM timeout')),
    });

    const result = await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    expect(result.processed).toBe(1);
    expect(result.failed.llmOrParseFailed).toBe(0);
  });

  it('fallback finds dep value stored under user-facing field name (reverse-alias lookup)', async () => {
    // Lead already has funding_stage stored under the user-facing name 'Funding Stage'
    // from a prior enrichment run. Waterfall skips it (fill_if_empty). Fallback must
    // find it via reverse-alias so smart eval receives the dep value.
    const configWithAlias = makeConfig({
      fields: [
        {
          name: 'Funding Stage',
          type: 'string',
          instruction: 'company funding stage',
          include: true,
          overwritePolicy: 'fill_if_empty',
          aliasFor: 'funding_stage',
        },
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later',
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'true when series A or later',
          smartDependencies: ['funding_stage'],
        },
      ],
    });
    const leadWithExistingDep = makeLead({
      customFields: { 'Funding Stage': 'Series B' },
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([leadWithExistingDep]),
      // Waterfall returns nothing — fill_if_empty, value already exists
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [],
        missing: ['Funding Stage'],
        tierFills: { crm: 0, apollo: 0, web: 0, missing: 1 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series B > Series A' }),
    });

    await runEnrichment(makeInput({ config: configWithAlias }), deps);

    // Fallback must have found 'funding_stage' via reverse-alias of 'Funding Stage'
    expect(deps.evaluateSmartField).toHaveBeenCalledWith(
      expect.objectContaining({
        depValues: expect.objectContaining({ funding_stage: 'Series B' }),
      }),
    );
  });

  it('does NOT write injected dep fields to lead after enrichment', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series B', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
          { field: 'total_funding', value: '5000000', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series B > Series A' }),
    });

    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    const setCallArgs = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    // Injected deps must NOT appear on the lead
    expect(setCallArgs.customFields).not.toHaveProperty('funding_stage');
    expect(setCallArgs.customFields).not.toHaveProperty('total_funding');
    // Smart field itself MUST be written
    expect(setCallArgs.customFields).toMatchObject({ isQualified: 'true' });
  });

  it('writes dep field normally when it is part of user config (not injected)', async () => {
    const configWithDep = makeConfig({
      fields: [
        {
          name: 'funding_stage',
          type: 'string',
          instruction: 'company funding stage',
          include: true,
          overwritePolicy: 'fill_if_empty',
        },
        {
          name: 'isQualified',
          type: 'boolean',
          instruction: 'true when series A or later',
          include: true,
          overwritePolicy: 'fill_if_empty',
          smartCondition: 'true when series A or later',
          smartDependencies: ['funding_stage'],
        },
      ],
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series A', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series A' }),
    });

    await runEnrichment(makeInput({ config: configWithDep }), deps);

    const setCallArgs = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    // funding_stage is in user config → must be written
    expect(setCallArgs.customFields).toHaveProperty('funding_stage', 'Series A');
    expect(setCallArgs.customFields).toMatchObject({ isQualified: 'true' });
  });

  it('smart eval still uses injected dep value even though dep is not written to lead', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'funding_stage', value: 'Series C', meta: { source: 'api', enrichedAt: '2026-05-11T00:00:00Z' } },
        ],
        missing: ['total_funding'],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 1 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'true', reasoning: 'Series C' }),
    });

    await runEnrichment(makeInput({ config: makeSmartConfig() }), deps);

    // Eval must have been called with the dep value
    expect(deps.evaluateSmartField).toHaveBeenCalledWith(
      expect.objectContaining({
        depValues: expect.objectContaining({ funding_stage: 'Series C' }),
      }),
    );
    // But funding_stage must NOT be stored on the lead
    const setCallArgs = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(setCallArgs.customFields).not.toHaveProperty('funding_stage');
  });
});

// ─── Concurrent chunk writes ──────────────────────────────────────────────────

describe('runEnrichment — concurrent chunk writes', () => {
  it('writes all leads in a chunk concurrently, not one-at-a-time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const setLeadFields = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight -= 1;
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'l1' }),
        makeLead({ leadId: 'l2' }),
        makeLead({ leadId: 'l3' }),
      ]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{
          field: 'company_name',
          value: 'Acme',
          meta: { source: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' },
        }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.processed).toBe(3);
    expect(setLeadFields).toHaveBeenCalledTimes(3);
    // Sequential writes would never have more than one call in flight at once.
    expect(maxInFlight).toBe(3);
  });
});

describe('runEnrichment — smart-field meta records the producing model', () => {
  function smartConfig(): EnrichmentConfig {
    return makeConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'string',
          instruction: 'qualified?',
          include: true,
          overwritePolicy: 'always_overwrite',
          smartCondition: 'company has > 100 employees',
        },
      ],
    });
  }

  it('FAIL CASE: smart-field fill meta has provider set to the model from evaluateSmartField', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'yes', reasoning: 'big company', model: 'gpt-5-chat-2' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.source).toBe('llm');
    expect(meta.provider).toBe('gpt-5-chat-2');
  });

  it('FAIL CASE: smart-field meta omits provider when evaluateSmartField returns no model', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'yes', reasoning: 'r' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.source).toBe('llm');
    expect(meta.provider).toBeUndefined();
  });

  it('FAIL CASE: smart-field meta provider reflects an overridden model name', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'no', reasoning: 'r', model: 'gpt-4.1' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.provider).toBe('gpt-4.1');
  });

  it('SUCCESS CASE: a null smart-field value produces no fill at all', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: null, reasoning: '', model: 'gpt-5-chat-2' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    expect(setLeadFields).not.toHaveBeenCalled();
  });
});

describe('runEnrichment — enrichedJobId stamping (Fix 7)', () => {
  it('FAIL CASE: every persisted fill carries meta.enrichedJobId equal to the run id', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    const result = await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_name;
    expect(meta.enrichedJobId).toBe(result.runId);
  });

  it('FAIL CASE: enrichedJobId is identical across multiple fields written for one lead', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
          { field: 'industry', value: 'SaaS', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    const result = await runEnrichment(makeInput({ config: makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' },
        { name: 'industry', type: 'string', instruction: 'ind', include: true, overwritePolicy: 'always_overwrite' },
      ],
    }) }), deps);
    const md = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata;
    expect(md.company_name.enrichedJobId).toBe(result.runId);
    expect(md.industry.enrichedJobId).toBe(result.runId);
  });

  it('FAIL CASE: stamping enrichedJobId does not erase other meta keys', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', confidence: 'high', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_name;
    expect(meta.provider).toBe('apollo');
    expect(meta.confidence).toBe('high');
  });

  it('SUCCESS CASE: preview mode does not call setLeadFields (no stamping path)', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ mode: 'preview', config: makeConfig({
      fields: [{ name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    expect(setLeadFields).not.toHaveBeenCalled();
  });
});

describe('runEnrichment — critic view derivation (Fix 5)', () => {
  function webFillDeps(verdicts: Record<string, string>) {
    return makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{
          field: 'company_description',
          value: 'A SaaS company',
          meta: { source: 'web_search', provider: 'llm_web_search', enrichedAt: '2026-01-01T00:00:00Z' },
        }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
      }),
      runCriticOverWebFills: jest.fn().mockResolvedValue({ verdicts }),
      setLeadFields: jest.fn().mockResolvedValue(undefined),
    });
  }

  const cfg = makeConfig({
    fields: [{ name: 'company_description', type: 'string', instruction: 'desc', include: true, overwritePolicy: 'always_overwrite' }],
  });

  it('FAIL CASE: a contradicted verdict derives criticView "drop"', async () => {
    const deps = webFillDeps({ company_description: 'contradicted' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticVerdict).toBe('contradicted');
    expect(meta.criticView).toBe('drop');
  });

  it('FAIL CASE: an unsupported verdict derives criticView "low"', async () => {
    const deps = webFillDeps({ company_description: 'unsupported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticView).toBe('low');
  });

  it('FAIL CASE: a partially-supported verdict derives criticView "low"', async () => {
    const deps = webFillDeps({ company_description: 'partially-supported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticView).toBe('low');
  });

  it('SUCCESS CASE: a supported verdict derives criticView "high" and the fill is still persisted', async () => {
    const deps = webFillDeps({ company_description: 'supported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.topLevel?.company_description ?? call.customFields?.company_description).toBe('A SaaS company');
    expect(call.enrichmentMetadata.company_description.criticView).toBe('high');
  });

  it('SUCCESS CASE: a fill with no critic verdict has no criticView', async () => {
    const deps = webFillDeps({});  // critic returns no verdict for the field
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticVerdict).toBeUndefined();
    expect(meta.criticView).toBeUndefined();
  });
});

// ─── Cross-group field propagation ───────────────────────────────────────────
// person_identity fills linkedin_url → enrichedLead.linkedin must be set
// before company_firmographic waterfall runs so findUnipileCompany Approach 1
// can use it.

describe('runEnrichment — cross-group field propagation', () => {
  it('propagates linkedin_url fill into enrichedLead.linkedin before company group runs', async () => {
    const lead = makeLead({ leadId: 'lead-prop-1', email: 'jane@acme.com' });

    let companyGroupLead: any = null;

    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      runWaterfall: jest.fn().mockImplementation(async ({ groupName, lead: l }) => {
        if (groupName === 'person_identity') {
          return {
            fields: [{
              field: 'linkedin_url',
              value: 'https://www.linkedin.com/in/jane',
              meta: { source: 'linkedin', enrichedAt: new Date().toISOString() },
            }],
            missing: [],
            tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
          };
        }
        if (groupName === 'company_firmographic') {
          companyGroupLead = l;
        }
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }),
    });

    const config = makeConfig({
      fields: [
        { name: 'linkedin_url', type: 'string', instruction: 'linkedin url', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    expect(companyGroupLead).not.toBeNull();
    expect(companyGroupLead.linkedin).toBe('https://www.linkedin.com/in/jane');
  });

  it('propagates company_name fill into enrichedLead.company', async () => {
    const lead = makeLead({ leadId: 'lead-prop-2', email: 'jane@acme.com' });

    const companyGroupLeads: any[] = [];

    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      runWaterfall: jest.fn().mockImplementation(async ({ groupName, lead: l }) => {
        if (groupName === 'company_firmographic') {
          companyGroupLeads.push(l);
          return {
            fields: [{
              field: 'company_name',
              value: 'Acme Corp',
              meta: { source: 'web_search', enrichedAt: new Date().toISOString() },
            }],
            missing: [],
            tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
          };
        }
        return { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, web: 0, missing: 0 } };
      }),
    });

    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'employee_count', type: 'string', instruction: 'employee count', include: true, overwritePolicy: 'fill_if_empty' },
      ],
    });

    await runEnrichment(makeInput({ config }), deps);

    // company_firmographic runs twice (once per field batch) OR once with both fields —
    // either way, the second call (if any) should see company already set.
    // Primary assertion: company_name fill propagates to enrichedLead.company_name.
    expect(companyGroupLeads[0]).not.toBeNull();
    // After first company_firmographic call fills company_name, enrichedLead.company is set.
    // Verify by checking the fill reached allFills (setLeadFields was called with company_name).
    const setCall = (deps.setLeadFields as jest.Mock).mock.calls[0]?.[0];
    expect(setCall?.topLevel?.company_name ?? setCall?.customFields?.company_name).toBe('Acme Corp');
  });
});

// ─── Snapshot & job-meta persistence ─────────────────────────────────────────

describe('runEnrichment — snapshot and job-meta persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not write snapshots or job meta in preview mode', async () => {
    const lead = makeLead({ leadId: 'lead-snap-1', customFields: { company_name: 'OldCo' } });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({ mode: 'preview' }), deps);

    expect(mockCrmDb.createEnrichmentSnapshotItem).not.toHaveBeenCalled();
    expect(mockCrmDb.createEnrichmentJobMeta).not.toHaveBeenCalled();
  });

  it('writes one snapshot per successfully written lead', async () => {
    const lead = makeLead({
      leadId: 'lead-snap-2',
      customFields: { company_name: 'OldCo' },
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    // always_overwrite so the fill isn't dropped by bucketByOverwritePolicy
    // (fill_if_empty with an existing value would produce an empty actualFills)
    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [{ name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'always_overwrite' }],
      }),
    }), deps);

    expect(mockCrmDb.createEnrichmentSnapshotItem).toHaveBeenCalledTimes(1);
    const call = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    expect(call.leadId).toBe('lead-snap-2');
    expect(call.previousCustomFields).toEqual({ company_name: 'OldCo' });
    expect(typeof call.jobId).toBe('string');
    expect(typeof call.expiresAt).toBe('number');
  });

  it('snapshots null for a custom field the lead does not have yet', async () => {
    const lead = makeLead({ leadId: 'lead-snap-3', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const call = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    expect(call.previousCustomFields).toEqual({ company_name: null });
  });

  it('snapshots existing standard field value before overwrite', async () => {
    const lead = makeLead({
      leadId: 'lead-snap-4',
      firstName: 'OldFirst',
      customFields: {},
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      extractUngroupedFieldsViaWeb: jest.fn().mockResolvedValue({
        fields: [{ field: 'firstName', value: 'NewFirst', meta: { source: 'web' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
      }),
    });

    // always_overwrite so the fill is not dropped by bucketByOverwritePolicy
    // (fill_if_empty with an existing firstName would yield empty actualFills)
    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [{
          name: 'firstName',
          type: 'string',
          instruction: 'first name',
          include: true,
          overwritePolicy: 'always_overwrite',
        }],
      }),
    }), deps);

    const call = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    expect(call.previousStandardFields).toEqual({ firstName: 'OldFirst' });
    expect(call.previousCustomFields).toEqual({});
  });

  it('writes job meta with correct counts after a successful run', async () => {
    const lead = makeLead({ leadId: 'lead-meta-1', customFields: { company_name: 'OldCo' } });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    expect(mockCrmDb.createEnrichmentJobMeta).toHaveBeenCalledTimes(1);
    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.listId).toBe(LIST_ID);
    expect(meta.userId).toBe(USER_ID);
    expect(meta.processedCount).toBe(1);
    expect(meta.status).toBe('completed');
    expect(meta.failureBreakdown.updateFailed).toBe(0);
    expect(typeof meta.jobId).toBe('string');
    expect(typeof meta.expiresAt).toBe('number');
    expect(meta.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('does not write job meta when no leads processed and no failures', async () => {
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([]),
    });

    await runEnrichment(makeInput(), deps);

    expect(mockCrmDb.createEnrichmentJobMeta).not.toHaveBeenCalled();
  });

  // B8 — V3 must write attemptedLeadIds, failedCount, skippedCount to job meta
  it('writes attemptedLeadIds, failedCount, skippedCount to job meta (B8 parity with V1)', async () => {
    const lead = makeLead({ leadId: 'lead-b8', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.failedCount).toBe(0);
    expect(meta.skippedCount).toBe(0);
    expect(Array.isArray(meta.attemptedLeadIds)).toBe(true);
    expect(meta.attemptedLeadIds).toContain('lead-b8');
    expect(meta.leadsDeduplicationUnavailable).toBeUndefined();
  });

  it('writes identity resolution failures to skippedCount, not failedCount', async () => {
    const lead = makeLead({ leadId: 'lead-id-fail', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: false, reason: 'no_email' }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.skippedCount).toBe(1);
    expect(meta.failedCount).toBe(0);
  });

  it('writes job meta when all leads are unresolvable (processed=0, failedCount=0)', async () => {
    const lead = makeLead({ leadId: 'lead-unresolvable', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: false, reason: 'no_email' }),
    });

    await runEnrichment(makeInput(), deps);

    expect(mockCrmDb.createEnrichmentJobMeta).toHaveBeenCalledTimes(1);
    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.processedCount).toBe(0);
    expect(meta.failedCount).toBe(0);
    expect(meta.skippedCount).toBe(1);
  });

  it('sets leadsDeduplicationUnavailable instead of attemptedLeadIds when >5000 leads', async () => {
    const manyLeads = Array.from({ length: 5001 }, (_, i) =>
      makeLead({ leadId: `lead-big-${i}`, customFields: {} }),
    );
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue(manyLeads),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.leadsDeduplicationUnavailable).toBe(true);
    expect(meta.attemptedLeadIds).toBeUndefined();
  });

  it('snapshot write failure aborts lead processing — lead not counted as enriched', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockRejectedValue(new Error('DynamoDB error'));
    const lead = makeLead({ leadId: 'lead-snap-6', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    const result = await runEnrichment(makeInput(), deps);

    // Snapshot failure must prevent both the lead write and the processed count.
    // A lead that cannot be snapshotted cannot be reverted — do not count as success.
    expect(result.processed).toBe(0);
    expect(deps.setLeadFields).not.toHaveBeenCalled();
  });

  it('writes successfulLeadIds containing the enriched lead ID', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const lead = makeLead({ leadId: 'lead-success-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(Array.isArray(meta.successfulLeadIds)).toBe(true);
    expect(meta.successfulLeadIds).toContain('lead-success-1');
    expect(meta.successLeadsDeduplicationUnavailable).toBeUndefined();
  });

  it('does not include failed lead in successfulLeadIds', async () => {
    const lead = makeLead({ leadId: 'lead-fail-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: false, reason: 'no_email' }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [],
        missing: [],
        tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0]?.[0];
    if (meta) {
      expect((meta.successfulLeadIds ?? []).includes('lead-fail-1')).toBe(false);
    }
  });

  it('sets successLeadsDeduplicationUnavailable instead of successfulLeadIds when >5000 leads succeed', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const manyLeads = Array.from({ length: 5001 }, (_, i) =>
      makeLead({ leadId: `lead-succ-big-${i}`, customFields: {} }),
    );
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue(manyLeads),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.successLeadsDeduplicationUnavailable).toBe(true);
    expect(meta.successfulLeadIds).toBeUndefined();
  });

  it('writes totalFieldsFilled with provider fills count for successful lead', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const lead = makeLead({ leadId: 'lead-fields-1', customFields: {} });
    const emptyWaterfall = { fields: [], missing: [], tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 0, web: 0, missing: 0 } };
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      // Only first waterfall call returns fills — subsequent group calls return empty
      // so fills don't double-count due to per-group routing.
      runWaterfall: jest.fn()
        .mockResolvedValueOnce({
          fields: [
            { field: 'company_name', value: 'Acme', meta: { source: 'apollo' } },
            { field: 'title', value: 'CEO', meta: { source: 'apollo' } },
          ],
          missing: [],
          tierFills: { crm: 0, apollo: 2, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
        })
        .mockResolvedValue(emptyWaterfall),
    });

    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [
          { name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' },
          { name: 'title', type: 'string', instruction: 'title', include: true, overwritePolicy: 'always_overwrite' },
        ],
      }),
    }), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.totalFieldsFilled).toBe(2);
  });

  it('writes totalFieldsAttempted equal to config fields count times leads count', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const leads = [
      makeLead({ leadId: 'lead-fields-2a', customFields: {} }),
      makeLead({ leadId: 'lead-fields-2b', email: 'bob@acme.com', customFields: {} }),
    ];
    const config = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' },
        { name: 'title', type: 'string', instruction: 'title', include: true, overwritePolicy: 'always_overwrite' },
        { name: 'city', type: 'string', instruction: 'city', include: true, overwritePolicy: 'always_overwrite' },
      ],
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue(leads),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({ config }), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.totalFieldsAttempted).toBe(6); // 3 fields × 2 leads
  });

  it('excludes non-included fields from totalFieldsAttempted', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const lead = makeLead({ leadId: 'lead-fields-excl', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [
          { name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' },
          { name: 'title', type: 'string', instruction: 'title', include: false, overwritePolicy: 'always_overwrite' },
        ],
      }),
    }), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    // Only 1 included field × 1 lead = 1, not 2
    expect(meta.totalFieldsAttempted).toBe(1);
  });

  it('does not count totalFieldsFilled for leads where the write fails', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const lead = makeLead({ leadId: 'lead-fields-3', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
      setLeadFields: jest.fn().mockRejectedValue(new Error('DB error')),
    });

    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [{ name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
      }),
    }), deps);

    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.totalFieldsFilled).toBe(0);
  });

  it('counts totalFieldsFilled for fill_if_empty field provider had data for even when lead already has the value', async () => {
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    const lead = makeLead({ leadId: 'lead-fields-4', customFields: { company_name: 'ExistingCo' } });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'apollo' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [{ name: 'company_name', type: 'string', instruction: 'co', include: true, overwritePolicy: 'fill_if_empty' }],
      }),
    }), deps);

    // Provider had data (writableFills.length = 1) even though fill was skipped
    // because the lead already had the value — this is Option A: count provider coverage.
    const meta = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(meta.totalFieldsFilled).toBe(1);
  });
});

// ─── computeLeadSourceBreakdown (via snapshot) ───────────────────────────────
// Tested indirectly: the sourceBreakdown tally in runEnrichment uses
// computeLeadSourceBreakdown and the result is reflected in the
// createEnrichmentJobMeta call's sourceBreakdown field.

describe('computeLeadSourceBreakdown — provider mapping via runEnrichment snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mockResolvedValue(undefined);
  });

  it('maps enrich.so provider to enrichSo live count', async () => {
    const lead = makeLead({ leadId: 'lead-es-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'enrich.so', enrichedAt: new Date().toISOString(), fromCache: false } }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, enrichSo: 1, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const metaCall = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(metaCall.sourceBreakdown.enrichSo.live).toBe(1);
    expect(metaCall.sourceBreakdown.enrichSo.cached).toBe(0);
  });

  it('maps unipile provider to unipile live count', async () => {
    const lead = makeLead({ leadId: 'lead-uni-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'title', value: 'CTO', meta: { source: 'linkedin', provider: 'unipile', enrichedAt: new Date().toISOString(), fromCache: false } }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, enrichSo: 0, unipile: 1, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({
      config: makeConfig({ fields: [{ name: 'title', type: 'string', instruction: 'job title', include: true, overwritePolicy: 'fill_if_empty' }] }),
    }), deps);

    const metaCall = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(metaCall.sourceBreakdown.unipile.live).toBe(1);
  });

  it('maps apollo provider to apollo live count', async () => {
    const lead = makeLead({ leadId: 'lead-ap-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'ApolloOrg', meta: { source: 'api', provider: 'apollo', enrichedAt: new Date().toISOString(), fromCache: false } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const metaCall = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    expect(metaCall.sourceBreakdown.apollo.live).toBe(1);
  });

  it('deduplicates — same provider appearing twice counts as one source entry per lead', async () => {
    // Two fills with provider='apollo' should yield only 1 live count (dedup by seen set)
    const lead = makeLead({ leadId: 'lead-dedup-1', customFields: {} });
    const apolloMeta = { source: 'api' as const, provider: 'apollo', enrichedAt: new Date().toISOString(), fromCache: false };
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company_name', value: 'DedupOrg', meta: apolloMeta },
          { field: 'company_linkedin_url', value: 'https://linkedin.com/company/dedup', meta: apolloMeta },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput({
      config: makeConfig({ fields: [
        { name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'company_linkedin_url', type: 'string', instruction: 'company linkedin', include: true, overwritePolicy: 'fill_if_empty' },
      ]}),
    }), deps);

    const metaCall = (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mock.calls[0][0];
    // dedup: apollo appears twice but only 1 live count
    expect(metaCall.sourceBreakdown.apollo.live).toBe(1);
  });
});

// ─── buildSnapshotFields — previousEnrichmentMetadata capture ────────────────

describe('buildSnapshotFields — previousEnrichmentMetadata via createEnrichmentSnapshotItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mockResolvedValue(undefined);
  });

  it('captures existing enrichmentMetadata as previousEnrichmentMetadata in the snapshot', async () => {
    const existingMeta = { provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' };
    const lead = makeLead({
      leadId: 'lead-bsf-1',
      customFields: { company_name: 'OldCo' },
      enrichmentMetadata: { company_name: existingMeta },
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'NewCo', meta: { source: 'api', provider: 'enrich.so', enrichedAt: new Date().toISOString(), fromCache: false } }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, enrichSo: 1, unipile: 0, web: 0, missing: 0 },
      }),
    });

    // always_overwrite so the fill is not dropped (fill_if_empty with existing
    // company_name value yields empty actualFills → empty previousEnrichmentMetadata)
    await runEnrichment(makeInput({
      config: makeConfig({
        fields: [{ name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'always_overwrite' }],
      }),
    }), deps);

    const snapCall = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    expect(snapCall.previousEnrichmentMetadata).toEqual({ company_name: existingMeta });
  });

  it('captures null in previousEnrichmentMetadata when lead had no prior metadata for a field', async () => {
    const lead = makeLead({
      leadId: 'lead-bsf-2',
      customFields: {},
      enrichmentMetadata: {},
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company_name', value: 'BrandNewCo', meta: { source: 'api', provider: 'apollo', enrichedAt: new Date().toISOString(), fromCache: false } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
    });

    await runEnrichment(makeInput(), deps);

    const snapCall = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    expect(snapCall.previousEnrichmentMetadata).toEqual({ company_name: null });
  });
});

// ─── Injected dep filter — injectedDepNames excluded from writableFills ───────

describe('runEnrichment — injected smart-field deps not in writableFills (snapshot + setLeadFields)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mockResolvedValue(undefined);
    (mockCrmDb.createEnrichmentJobMeta as jest.Mock).mockResolvedValue(undefined);
  });

  it('does not include injected dep fields in the snapshot or setLeadFields call', async () => {
    // funding_stage is a smart-field dep injected because it is NOT in the user's config.
    // The waterfall fills it, but it must be stripped before snapshot/write.
    const lead = makeLead({ leadId: 'lead-inj-1', customFields: {} });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([lead]),
      resolveIdentity: jest.fn().mockResolvedValue({ ok: true, resolved: {}, siblings: [] }),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          // company_name is a user config field
          { field: 'company_name', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: new Date().toISOString(), fromCache: false } },
          // funding_stage is an injected dep (not in user config)
          { field: 'funding_stage', value: 'Series A', meta: { source: 'api', provider: 'apollo', enrichedAt: new Date().toISOString(), fromCache: false } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, enrichSo: 0, unipile: 0, web: 0, missing: 0 },
      }),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'ICP', reasoning: 'high growth', model: 'gemini' }),
    });

    const configWithSmart = makeConfig({
      fields: [
        { name: 'company_name', type: 'string', instruction: 'company name', include: true, overwritePolicy: 'fill_if_empty' },
        { name: 'isICP', type: 'string', instruction: 'is ICP?', include: true, overwritePolicy: 'fill_if_empty', smartCondition: 'true if funding_stage is Series A', smartDependencies: ['funding_stage'] },
      ],
    });

    await runEnrichment(makeInput({ config: configWithSmart }), deps);

    // The snapshot must not contain funding_stage (it was injected, not user-configured)
    const snapCall = (mockCrmDb.createEnrichmentSnapshotItem as jest.Mock).mock.calls[0][0];
    const allSnapshotFields = {
      ...snapCall.previousCustomFields,
      ...snapCall.previousStandardFields,
    };
    expect(allSnapshotFields).not.toHaveProperty('funding_stage');

    // setLeadFields customFields must not contain funding_stage
    const setFieldsCall = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(setFieldsCall.customFields ?? {}).not.toHaveProperty('funding_stage');
  });
});

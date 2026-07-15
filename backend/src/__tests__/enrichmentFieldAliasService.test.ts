// Field-alias resolution: static map → list-persisted map → LLM mapping → ungrouped.

const mockLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getClientForModel: jest.fn().mockResolvedValue({
      chat: { completions: { create: (...a: any[]) => mockLLM(...a) } },
    }),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
  },
}));

// CrmEnrichmentService is dynamically imported by the alias service for the
// model config — stub the static method so tests don't need the full service.
jest.mock('../services/crmEnrichmentService', () => ({
  CrmEnrichmentService: {
    getEnrichmentConfig: async () => ({
      enrichmentModel: 'gemini-3-flash-preview',
      dataExtractionModel: 'gemini-3-flash-preview',
    }),
  },
}));

const mockMeterUserUsage = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  meterUserUsage: (...a: any[]) => mockMeterUserUsage(...a),
}));

import { resolveFieldAliases, STATIC_FIELD_ALIASES, canonicalFieldSet } from '../services/enrichmentFieldAliasService';
import { crmDb } from '../services/db';
const mockDb = crmDb as jest.Mocked<typeof crmDb>;

beforeEach(() => {
  mockLLM.mockReset();
  mockMeterUserUsage.mockReset();
  mockDb.getLeadListById.mockReset();
  mockDb.updateLeadList.mockReset();
  mockDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'u1' } as any);
  mockDb.updateLeadList.mockResolvedValue(undefined as any);
});

describe('resolveFieldAliases — per-user metering (ENG-200)', () => {
  it('charges the field-mapping LLM call to the caller (userId + tokens) via meterUserUsage', async () => {
    // A non-canonical field forces the LLM mapping tier to run.
    mockLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ some_weird_field: null }) } }],
      usage: { prompt_tokens: 90, completion_tokens: 12 },
    });

    await resolveFieldAliases('list1', ['some_weird_field'], 'user-3');

    expect(mockMeterUserUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-3',
      feature: 'crm_enrichment_field_alias',
      inputTokens: 90,
      outputTokens: 12,
    }));
  });
});

function llmReply(map: Record<string, string | null>) {
  return { choices: [{ message: { content: JSON.stringify(map) } }] };
}

// ── Tier 1: static map ──────────────────────────────────────────────────────

describe('resolveFieldAliases — static map (Tier 1)', () => {
  it('resolves common aliases without an LLM call', async () => {
    const r = await resolveFieldAliases('list1', ['funding_round', 'company_overview', 'hq_city']);
    expect(r.effectiveMap).toEqual({
      funding_round:    'funding_stage',
      company_overview: 'company_description',
      hq_city:          'hq_location',
    });
    expect(mockLLM).not.toHaveBeenCalled();
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('passes already-canonical fields through unchanged', async () => {
    const r = await resolveFieldAliases('list1', ['industry', 'funding_stage', 'hq_location']);
    expect(r.effectiveMap).toEqual({
      industry:      'industry',
      funding_stage: 'funding_stage',
      hq_location:   'hq_location',
    });
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('static aliases are case-insensitive', async () => {
    const r = await resolveFieldAliases('list1', ['Funding_Round', 'COMPANY_OVERVIEW']);
    expect(r.effectiveMap.Funding_Round).toBe('funding_stage');
    expect(r.effectiveMap.COMPANY_OVERVIEW).toBe('company_description');
  });

  it('reports newlyResolved as empty when nothing was LLM-mapped', async () => {
    const r = await resolveFieldAliases('list1', ['funding_round']);
    expect(r.newlyResolved).toEqual({});
  });
});

// ── Tier 2: persisted per-list map ──────────────────────────────────────────

describe('resolveFieldAliases — persisted per-list map (Tier 2)', () => {
  it('uses persisted map without an LLM call', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      fieldCanonicalMap: { my_quirky_field: 'industry' },
    } as any);

    const r = await resolveFieldAliases('list1', ['my_quirky_field']);
    expect(r.effectiveMap.my_quirky_field).toBe('industry');
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('persisted map overrides nothing when value is already in static map', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      // even if persisted map contradicts static, static wins (deterministic)
      fieldCanonicalMap: { funding_round: 'industry' },
    } as any);
    const r = await resolveFieldAliases('list1', ['funding_round']);
    expect(r.effectiveMap.funding_round).toBe('funding_stage');  // static beats persisted
  });
});

// ── Tier 3: LLM mapping ─────────────────────────────────────────────────────

describe('resolveFieldAliases — LLM mapping (Tier 3)', () => {
  it('calls LLM only for fields not in static or persisted maps', async () => {
    mockLLM.mockResolvedValueOnce(llmReply({ totally_novel: 'industry' }));

    const r = await resolveFieldAliases('list1', ['funding_round', 'totally_novel']);
    expect(r.effectiveMap.funding_round).toBe('funding_stage');
    expect(r.effectiveMap.totally_novel).toBe('industry');
    expect(r.newlyResolved).toEqual({ totally_novel: 'industry' });
    // LLM called exactly once with only the unresolved field
    expect(mockLLM).toHaveBeenCalledTimes(1);
    const call = mockLLM.mock.calls[0][0];
    const userMsg = call.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('totally_novel');
    expect(userMsg).not.toContain('funding_round');
  });

  it('persists newly-resolved mappings to the list', async () => {
    mockLLM.mockResolvedValueOnce(llmReply({ co_desc: 'company_description', stack: 'tech_stack' }));
    await resolveFieldAliases('list1', ['co_desc', 'stack']);
    expect(mockDb.updateLeadList).toHaveBeenCalledWith('list1', expect.objectContaining({
      fieldCanonicalMap: expect.objectContaining({
        co_desc: 'company_description',
        stack:   'tech_stack',
      }),
    }));
  });

  it('discards LLM mappings to non-canonical names', async () => {
    mockLLM.mockResolvedValueOnce(llmReply({ wonky: 'made_up_field' }));
    const r = await resolveFieldAliases('list1', ['wonky']);
    expect(r.effectiveMap.wonky).toBeUndefined();
    expect(r.newlyResolved).toEqual({});
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('treats LLM-returned null as unresolved (not persisted)', async () => {
    mockLLM.mockResolvedValueOnce(llmReply({ random_field: null }));
    const r = await resolveFieldAliases('list1', ['random_field']);
    expect(r.effectiveMap.random_field).toBeUndefined();
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('falls back to static map on LLM failure (graceful degrade)', async () => {
    mockLLM.mockRejectedValueOnce(new Error('rate limit'));
    const r = await resolveFieldAliases('list1', ['funding_round', 'random_field']);
    expect(r.effectiveMap.funding_round).toBe('funding_stage');  // static still works
    expect(r.effectiveMap.random_field).toBeUndefined();          // LLM failed, no resolution
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response gracefully', async () => {
    mockLLM.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const r = await resolveFieldAliases('list1', ['random_field']);
    expect(r.effectiveMap.random_field).toBeUndefined();
  });

  it('does not write empty map when LLM returns all null', async () => {
    mockLLM.mockResolvedValueOnce(llmReply({ a: null, b: null }));
    const r = await resolveFieldAliases('list1', ['a', 'b']);
    expect(r.newlyResolved).toEqual({});
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });
});

// ── New-group aliases (geography / product / person_career) ───────────────

describe('resolveFieldAliases — new groups', () => {
  it('routes geography variants to canonical', async () => {
    const r = await resolveFieldAliases('list1', ['hq_country', 'timezone', 'office_locations', 'street_address']);
    expect(r.effectiveMap).toEqual({
      hq_country:       'country',
      timezone:         'time_zone',
      office_locations: 'all_office_locations',
      street_address:   'hq_address',
    });
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('routes product variants to canonical', async () => {
    const r = await resolveFieldAliases('list1', ['product_lines', 'pricing_tier', 'customer_segment', 'main_products', 'notable_customers']);
    expect(r.effectiveMap).toEqual({
      product_lines:     'product_categories',
      pricing_tier:      'pricing_model',
      customer_segment:  'target_market',
      main_products:     'primary_offerings',
      notable_customers: 'customer_logos',
    });
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('routes person career variants to canonical', async () => {
    const r = await resolveFieldAliases('list1', ['tenure', 'previous_companies', 'university', 'joined_date', 'total_experience']);
    expect(r.effectiveMap).toEqual({
      tenure:             'tenure_at_company',
      previous_companies: 'prior_companies',
      university:         'education',
      joined_date:        'recent_role_change_date',
      total_experience:   'years_experience',
    });
    expect(mockLLM).not.toHaveBeenCalled();
  });
});

// ── canonicalFieldSet sanity ────────────────────────────────────────────────

describe('canonicalFieldSet', () => {
  it('contains the canonical names referenced by static aliases', () => {
    const canonical = canonicalFieldSet();
    // Every value in STATIC_FIELD_ALIASES must point to a real canonical field.
    for (const [alias, target] of Object.entries(STATIC_FIELD_ALIASES)) {
      expect(canonical.has(target)).toBe(true);
    }
  });
});

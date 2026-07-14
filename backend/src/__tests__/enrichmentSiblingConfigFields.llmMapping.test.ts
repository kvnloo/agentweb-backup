/**
 * Bug regression: Tier 0b's `MAPPING_MODEL` previously pointed at a Bedrock
 * Claude ID that the LLMService constructor couldn't resolve to an inference
 * profile, so every run threw `ValidationException: The provided model
 * identifier is invalid`. The change to `gpt-5-chat-2` (with an env override)
 * removes that throw, but the fallback path is still load-bearing — if the
 * model is misconfigured in some other way, Tier 0b must degrade to a
 * field-to-itself mapping rather than blocking the run. These tests pin
 * down both the happy path and the fallback.
 */

import {
  buildLLMFieldMapping,
  buildCanonicalFieldMap,
  buildSiblingFieldMappingTable,
  copySiblingConfigFields,
} from '../services/enrichmentSiblingConfigFields';
import type { EnrichmentFieldConfig } from '../services/crmEnrichmentServiceV3';
import type { LeadRecord } from '../services/crmEnrichmentService';
import type { SiblingLeadResult } from '../services/enrichmentIdentityResolver';

const mockGenerateJSONContent = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({
    generateJSONContent: mockGenerateJSONContent,
  })),
}));

function field(name: string, instruction = ''): EnrichmentFieldConfig {
  return {
    name,
    type: 'string',
    instruction,
    include: true,
    overwritePolicy: 'fill_if_empty',
  };
}

describe('Tier 0b buildLLMFieldMapping', () => {
  beforeEach(() => {
    mockGenerateJSONContent.mockReset();
  });

  it('returns an empty map for an empty input list (no LLM call)', async () => {
    const out = await buildLLMFieldMapping([]);
    expect(out.size).toBe(0);
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });

  it('parses the LLM response into a field→aliases map', async () => {
    mockGenerateJSONContent.mockResolvedValueOnce({
      fundingStage: ['funding_stage', 'stage', 'round'],
      employeeCount: ['employee_count', 'headcount'],
    });

    const out = await buildLLMFieldMapping([
      field('fundingStage', 'Latest funding round'),
      field('employeeCount'),
    ]);

    expect(mockGenerateJSONContent).toHaveBeenCalledTimes(1);
    expect(out.get('fundingStage')).toEqual(['funding_stage', 'stage', 'round']);
    expect(out.get('employeeCount')).toEqual(['employee_count', 'headcount']);
  });

  it('falls back to each-field-maps-to-itself when the LLM throws (Bug 2 safety net)', async () => {
    mockGenerateJSONContent.mockRejectedValueOnce(
      new Error('ValidationException: The provided model identifier is invalid.'),
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await buildLLMFieldMapping([
      field('fundingStage'),
      field('employeeCount'),
    ]);

    expect(out.get('fundingStage')).toEqual(['fundingStage']);
    expect(out.get('employeeCount')).toEqual(['employeeCount']);
    expect(warnSpy).toHaveBeenCalledWith(
      '[tier0b] LLM field mapping failed:',
      expect.stringContaining('provided model identifier is invalid'),
    );

    warnSpy.mockRestore();
  });

  it('drops entries whose LLM value is not an array and trims string aliases', async () => {
    mockGenerateJSONContent.mockResolvedValueOnce({
      goodField: [' alias_one ', '', 'alias_two'],
      malformedField: 'not-an-array',
    });

    const out = await buildLLMFieldMapping([
      field('goodField'),
      field('malformedField'),
    ]);

    expect(out.get('goodField')).toEqual(['alias_one', 'alias_two']);
    expect(out.has('malformedField')).toBe(false);
  });

  it('includes each field\'s instruction in the prompt so the LLM can disambiguate similar names', async () => {
    mockGenerateJSONContent.mockResolvedValueOnce({});

    await buildLLMFieldMapping([
      field('stage', 'Most recent funding stage (Seed, Series A, etc.)'),
      field('size'),
    ]);

    const [systemPrompt, userPrompt] = mockGenerateJSONContent.mock.calls[0];
    expect(systemPrompt).toMatch(/CRM data schema expert/i);
    expect(userPrompt).toContain('- stage (Most recent funding stage (Seed, Series A, etc.))');
    expect(userPrompt).toContain('- size');
  });
});

// ─── Canonical map ──────────────────────────────────────────────────────────

describe('Tier 0b buildCanonicalFieldMap', () => {
  it('maps each aliased config field to its canonical lookup key', () => {
    const out = buildCanonicalFieldMap([
      { ...field('stag'), aliasFor: 'funding_stage' },
      { ...field('emps'), aliasFor: 'employee_count' },
      field('customNote'), // no aliasFor → excluded
    ]);
    expect(out.get('stag')).toEqual(['funding_stage']);
    expect(out.get('emps')).toEqual(['employee_count']);
    expect(out.has('customNote')).toBe(false);
  });

  it('returns an empty map when no fields have aliasFor', () => {
    const out = buildCanonicalFieldMap([field('a'), field('b')]);
    expect(out.size).toBe(0);
  });
});

// ─── Run-start mapping builder ──────────────────────────────────────────────

describe('Tier 0b buildSiblingFieldMappingTable', () => {
  beforeEach(() => mockGenerateJSONContent.mockReset());

  it('excludes identity fields, splits aliased vs unaliased, and merges both maps', async () => {
    mockGenerateJSONContent.mockResolvedValueOnce({ tags: ['labels', 'categories'] });

    const out = await buildSiblingFieldMappingTable([
      field('firstName'),                                       // identity → dropped
      { ...field('stag'), aliasFor: 'funding_stage' },          // aliased
      field('tags'),                                            // unaliased → goes to LLM
    ]);

    expect(out.canonical.get('stag')).toEqual(['funding_stage']);
    expect(out.canonical.has('firstName')).toBe(false);
    expect(out.llm.get('tags')).toEqual(['labels', 'categories']);
    // LLM was only asked about the unaliased non-identity field.
    expect(mockGenerateJSONContent).toHaveBeenCalledTimes(1);
    expect(mockGenerateJSONContent.mock.calls[0][1]).toContain('- tags');
    expect(mockGenerateJSONContent.mock.calls[0][1]).not.toContain('- firstName');
  });

  it('skips the LLM call entirely when every non-identity field already has aliasFor', async () => {
    const out = await buildSiblingFieldMappingTable([
      { ...field('stag'), aliasFor: 'funding_stage' },
    ]);
    expect(out.llm.size).toBe(0);
    expect(mockGenerateJSONContent).not.toHaveBeenCalled();
  });
});

// ─── Per-lead copy ──────────────────────────────────────────────────────────

function lead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    customFields: {},
    enrichmentMetadata: {},
    ...overrides,
  } as LeadRecord;
}

function sibling(overrides: Partial<SiblingLeadResult> = {}): SiblingLeadResult {
  return {
    leadId: 'sib-1',
    listId: 'list-other',
    userId: 'user-other',
    updatedAt: new Date().toISOString(),
    customFields: {},
    ...overrides,
  };
}

describe('Tier 0b copySiblingConfigFields', () => {
  const emptyMap = { canonical: new Map(), llm: new Map() };

  it('returns no fills when no siblings supplied', () => {
    const out = copySiblingConfigFields(lead(), [], [field('industry')], emptyMap);
    expect(out.fills).toEqual([]);
  });

  it('skips identity fields (those are Tier 0a\'s job, not Tier 0b\'s)', () => {
    const sib = sibling({ firstName: 'Jane', customFields: { firstName: 'Jane' } });
    const out = copySiblingConfigFields(lead(), [sib], [field('firstName')], emptyMap);
    expect(out.fills).toEqual([]);
  });

  it('skips when the lead already has a value at the top level', () => {
    const sib = sibling({ customFields: { website: 'https://sib.com' } });
    const out = copySiblingConfigFields(
      lead({ website: 'https://lead.com' } as any),
      [sib],
      [field('website')],
      emptyMap,
    );
    expect(out.fills).toEqual([]);
  });

  it('skips when the lead already has a value in customFields', () => {
    const sib = sibling({ customFields: { industry: 'AI' } });
    const out = copySiblingConfigFields(
      lead({ customFields: { industry: 'Fintech' } }),
      [sib],
      [field('industry')],
      emptyMap,
    );
    expect(out.fills).toEqual([]);
  });

  it('skips when the field is in the refresh set (force re-enrichment requested)', () => {
    const sib = sibling({ customFields: { industry: 'AI' } });
    const refresh = new Set<string>(['lead-1:industry']);
    const out = copySiblingConfigFields(lead(), [sib], [field('industry')], emptyMap, refresh);
    expect(out.fills).toEqual([]);
  });

  it('copies a missing custom field from a sibling via the LLM alias map', () => {
    const sib = sibling({
      leadId: 'sib-9',
      listId: 'list-other',
      userId: 'user-other',
      customFields: { industry: 'AI Tooling' },
    });
    const mappingTable = {
      canonical: new Map<string, string[]>(),
      llm: new Map<string, string[]>([['sector', ['industry']]]),
    };
    const out = copySiblingConfigFields(lead(), [sib], [field('sector')], mappingTable);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].field).toBe('sector');
    expect(out.fills[0].value).toBe('AI Tooling');
    expect(out.fills[0].meta).toMatchObject({
      source: 'crm-history',
      provider: 'agentweb',
      siblingLeadId: 'sib-9',
      siblingListId: 'list-other',
      siblingUserId: 'user-other',
    });
  });

  it('also tries the exact field name as a last-resort key when no mapping hits', () => {
    const sib = sibling({ customFields: { tags: 'a, b, c' } });
    const out = copySiblingConfigFields(lead(), [sib], [field('tags')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].value).toBe('a, b, c');
  });

  it('walks siblings in order and stops at the first hit for a given field', () => {
    const fresh = sibling({ leadId: 'sib-fresh', customFields: { tags: 'fresh' } });
    const stale = sibling({ leadId: 'sib-stale', customFields: { tags: 'stale' } });
    const out = copySiblingConfigFields(lead(), [fresh, stale], [field('tags')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].value).toBe('fresh');
    expect((out.fills[0].meta as any).siblingLeadId).toBe('sib-fresh');
  });

  it('skips siblings whose updatedAt is older than the field\'s TTL window', () => {
    // 200 days old — outside the default 90-day TTL for fields with no FIELD_GROUP.
    const oldDate = new Date(Date.now() - 200 * 86400 * 1000).toISOString();
    const stale = sibling({ updatedAt: oldDate, customFields: { tags: 'stale-200d' } });
    const out = copySiblingConfigFields(lead(), [stale], [field('tags')], emptyMap);
    expect(out.fills).toEqual([]);
  });

  it('skips siblings that have no customFields map at all', () => {
    const sib = sibling({ customFields: undefined as any });
    const out = copySiblingConfigFields(lead(), [sib], [field('tags')], emptyMap);
    expect(out.fills).toEqual([]);
  });

  it('treats whitespace-only sibling values as missing', () => {
    const sib = sibling({ customFields: { tags: '   ' } });
    const out = copySiblingConfigFields(lead(), [sib], [field('tags')], emptyMap);
    expect(out.fills).toEqual([]);
  });

  it('dedupes candidate keys so the same sibling field is not probed twice', () => {
    // canonical and llm both yield "industry" — and the field's own name does too.
    const sib = sibling({ customFields: { industry: 'AI' } });
    const mappingTable = {
      canonical: new Map<string, string[]>([['industry', ['industry']]]),
      llm: new Map<string, string[]>([['industry', ['industry']]]),
    };
    const out = copySiblingConfigFields(lead(), [sib], [field('industry')], mappingTable);
    expect(out.fills).toHaveLength(1);
  });

  // ── Provenance carry-forward (Slashy/Slash bug) ──────────────────────────
  // A sibling value that originated from a web search must keep its web
  // provenance when copied, re-stamped as source:'web_search', so the
  // orchestrator's critic can re-verify it against THIS lead's identity.
  it('re-stamps a web-sourced sibling value as web_search and carries source URL/quote', () => {
    const sib = sibling({
      leadId: 'sib-web',
      customFields: { funding_stage: 'Series B' },
      enrichmentMetadata: {
        funding_stage: {
          source: 'web_search',
          provider: 'llm_web_search',
          confidence: 'medium',
          sourceUrl: 'https://www.slash.com/blog/slash-raises-series-b',
          sourceQuote: 'Slash has recently raised $41 million in a Series B funding round',
          enrichedAt: '2026-06-23T09:59:32Z',
        } as any,
      },
    });
    const out = copySiblingConfigFields(lead(), [sib], [field('funding_stage')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].value).toBe('Series B');
    expect(out.fills[0].meta).toMatchObject({
      source: 'web_search',
      provider: 'llm_web_search',
      sourceUrl: 'https://www.slash.com/blog/slash-raises-series-b',
      sourceQuote: 'Slash has recently raised $41 million in a Series B funding round',
      // sibling lineage retained for debugging
      siblingLeadId: 'sib-web',
    });
  });

  // ── Training-memory grounding badge (ENG-122) ────────────────────────────
  // A web-sourced copy is second-hand — never verified against THIS lead's
  // identity — so it is badged unverified and forced to low confidence rather
  // than inheriting the sibling's (often 'high') confidence. This prevents
  // stale copied funding from presenting as confident/verified.
  it('badges a web-sourced sibling copy as web-unverified at low confidence (not the sibling\'s high confidence)', () => {
    const sib = sibling({
      leadId: 'sib-web',
      customFields: { total_funding: '$6.5M' },
      enrichmentMetadata: {
        total_funding: {
          source: 'web_search',
          provider: 'llm_web_search',
          confidence: 'high',
          sourceQuote: 'Raises $6.5M',
          enrichedAt: '2026-06-23T09:59:32Z',
        } as any,
      },
    });
    const out = copySiblingConfigFields(lead(), [sib], [field('total_funding')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].meta).toMatchObject({
      source: 'web_search',
      grounding: 'web-unverified',
      confidence: 'low',
    });
  });

  it('downgrades a sibling that was \'grounded\' to \'web-unverified\' when copied to another lead', () => {
    const sib = sibling({
      customFields: { total_funding: '$41M' },
      enrichmentMetadata: {
        total_funding: {
          source: 'web_search',
          provider: 'llm_web_search',
          confidence: 'high',
          grounding: 'grounded',
          sourceQuote: 'raised $41 million',
          enrichedAt: '2026-06-23T00:00:00Z',
        } as any,
      },
    });
    const out = copySiblingConfigFields(lead(), [sib], [field('total_funding')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].meta).toMatchObject({ grounding: 'web-unverified', confidence: 'low' });
  });

  it('preserves an \'ai-knowledge\' badge on a web-sourced sibling copy', () => {
    const sib = sibling({
      customFields: { total_funding: '$100M' },
      enrichmentMetadata: {
        total_funding: {
          source: 'web_search',
          provider: 'llm_web_search',
          confidence: 'low',
          grounding: 'ai-knowledge',
          enrichedAt: '2026-06-23T00:00:00Z',
        } as any,
      },
    });
    const out = copySiblingConfigFields(lead(), [sib], [field('total_funding')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].meta).toMatchObject({ grounding: 'ai-knowledge', confidence: 'low' });
  });

  it('keeps the plain crm-history shape for a non-web (Apollo) sibling value', () => {
    const sib = sibling({
      leadId: 'sib-apollo',
      customFields: { industry: 'Fintech' },
      enrichmentMetadata: {
        industry: { source: 'api', provider: 'apollo', confidence: 'high', enrichedAt: '2026-06-23T00:00:00Z' } as any,
      },
    });
    const out = copySiblingConfigFields(lead(), [sib], [field('industry')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].meta).toMatchObject({ source: 'crm-history', provider: 'agentweb' });
    expect((out.fills[0].meta as any).sourceUrl).toBeUndefined();
  });

  it('keeps the plain crm-history shape when the sibling has no provenance for the field', () => {
    const sib = sibling({ leadId: 'sib-nometa', customFields: { tags: 'a, b' } });
    const out = copySiblingConfigFields(lead(), [sib], [field('tags')], emptyMap);
    expect(out.fills).toHaveLength(1);
    expect(out.fills[0].meta).toMatchObject({ source: 'crm-history', provider: 'agentweb' });
  });
});

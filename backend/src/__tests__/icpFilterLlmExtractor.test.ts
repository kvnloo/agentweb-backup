// Tests for the LLM-backed ICP → LinkedIn filter extractor.
//
// The extractor takes a single ICPPersona and returns 1-3 candidate filter
// variants (label + optional title/industry/location/keywords). It is the
// hot path behind GET /api/crm/icp/filters when the persona's cache is
// stale or absent.

import { extractIcpFiltersWithLlm, ICP_FILTER_CACHE_VERSION } from '../services/icpFilterLlmExtractor';
import type { ICPPersona } from '../services/icpStatusService';

const fakePersona = (over: Partial<ICPPersona> = {}): ICPPersona => ({
  name: 'Mid-market RevOps Leaders',
  pain: 'data hand-offs between marketing and sales',
  desire: 'pipeline visibility without manual rollups',
  objection: 'switching cost from existing Salesforce reports',
  meta_targeting_brief:
    'RevOps managers at B2B SaaS companies in North America who use Salesforce.',
  ...over,
});

describe('extractIcpFiltersWithLlm', () => {
  it('exposes a cache version constant (bumped when prompt/model changes)', () => {
    expect(typeof ICP_FILTER_CACHE_VERSION).toBe('number');
    expect(ICP_FILTER_CACHE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('happy path: returns the LLM-produced variants verbatim', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [
          { label: 'Broad', title: 'RevOps Leaders', industry: 'B2B SaaS' },
          {
            label: 'North America focus',
            title: 'RevOps Leaders',
            industry: 'B2B SaaS',
            location: 'North America',
          },
        ],
      }),
    };

    const result = await extractIcpFiltersWithLlm(fakePersona(), { llm });
    expect(llm.generateJsonRobust).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Broad');
    expect(result[1].location).toBe('North America');
  });

  it('caps to 3 variants when the LLM returns more', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [
          { label: 'A', title: 'T1' },
          { label: 'B', title: 'T2' },
          { label: 'C', title: 'T3' },
          { label: 'D', title: 'T4' },
          { label: 'E', title: 'T5' },
        ],
      }),
    };

    const result = await extractIcpFiltersWithLlm(fakePersona(), { llm });
    expect(result).toHaveLength(3);
    expect(result.map((v) => v.label)).toEqual(['A', 'B', 'C']);
  });

  it('drops variants whose label or all filter fields are missing', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [
          { label: 'Good', title: 'RevOps' },
          { label: '', title: 'NoLabel' }, // dropped (no label)
          { label: 'Empty' }, // dropped (no filter fields)
          { title: 'OrphanTitle' }, // dropped (no label)
        ],
      }),
    };

    const result = await extractIcpFiltersWithLlm(fakePersona(), { llm });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Good');
  });

  it('throws when the LLM returns no usable variants', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({ variants: [] }),
    };

    await expect(extractIcpFiltersWithLlm(fakePersona(), { llm })).rejects.toThrow(
      /no.*variants/i,
    );
  });

  it('throws when the LLM returns a malformed shape (missing variants array)', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({ stuff: 'not what we asked for' }),
    };

    await expect(extractIcpFiltersWithLlm(fakePersona(), { llm })).rejects.toThrow();
  });

  it('propagates network/parse errors from the LLM (no silent fallback)', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockRejectedValue(new Error('Bedrock timeout')),
    };

    await expect(extractIcpFiltersWithLlm(fakePersona(), { llm })).rejects.toThrow(
      /Bedrock timeout/,
    );
  });

  it('includes all 5 persona fields in the user prompt sent to the LLM', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [{ label: 'X', title: 'Y' }],
      }),
    };
    const persona = fakePersona({
      name: 'UNIQ_NAME_42',
      pain: 'UNIQ_PAIN_42',
      desire: 'UNIQ_DESIRE_42',
      objection: 'UNIQ_OBJECTION_42',
      meta_targeting_brief: 'UNIQ_BRIEF_42',
    });
    await extractIcpFiltersWithLlm(persona, { llm });
    const [, userPrompt] = llm.generateJsonRobust.mock.calls[0];
    expect(userPrompt).toContain('UNIQ_NAME_42');
    expect(userPrompt).toContain('UNIQ_PAIN_42');
    expect(userPrompt).toContain('UNIQ_DESIRE_42');
    expect(userPrompt).toContain('UNIQ_OBJECTION_42');
    expect(userPrompt).toContain('UNIQ_BRIEF_42');
  });

  it('system prompt instructs LLM to output ONLY JSON with a variants array', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [{ label: 'X', title: 'Y' }],
      }),
    };
    await extractIcpFiltersWithLlm(fakePersona(), { llm });
    const [systemPrompt] = llm.generateJsonRobust.mock.calls[0];
    expect(systemPrompt).toMatch(/variants/i);
    expect(systemPrompt).toMatch(/JSON/i);
  });

  it('coerces non-string fields and trims whitespace defensively', async () => {
    const llm = {
      generateJsonRobust: jest.fn().mockResolvedValue({
        variants: [
          {
            label: '  Broad  ',
            title: '  RevOps Leaders ',
            industry: 'B2B SaaS',
            location: null,
            keywords: undefined,
          },
        ],
      }),
    };

    const result = await extractIcpFiltersWithLlm(fakePersona(), { llm });
    expect(result[0].label).toBe('Broad');
    expect(result[0].title).toBe('RevOps Leaders');
    expect(result[0].industry).toBe('B2B SaaS');
    expect(result[0].location).toBeUndefined();
    expect(result[0].keywords).toBeUndefined();
  });
});

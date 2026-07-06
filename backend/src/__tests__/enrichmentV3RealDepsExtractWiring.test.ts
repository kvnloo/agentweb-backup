// ENG-122: unit-covers the LLM-facing glue in extractFieldsViaLLMReal that
// classifyWebValues' own tests can't reach — parsing __entity_company__ from the
// model response and wiring source / lead company / claimed company into the
// grounding classification. The LLM call is mocked so the wiring is deterministic.
import { extractFieldsViaLLMReal } from '../services/enrichmentV3RealDeps';
import { metaWeb } from '../services/enrichmentGroupWaterfall';
import { createLLMService } from '../utils/llmService';

const mockWebSearch = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({
    generateJSONContentWithWebSearch: (...a: any[]) => mockWebSearch(...a),
    generateJSONContent: jest.fn(),
  })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  (createLLMService as jest.Mock).mockReturnValue({
    generateJSONContentWithWebSearch: (...a: any[]) => mockWebSearch(...a),
    generateJSONContent: jest.fn(),
  });
});

const input = (over: any = {}) => ({
  tier: 'web' as const,
  sourceContext: '',
  fields: ['funding_stage'],
  groupName: 'company_firmographic',
  lead: { leadId: 'l1', email: 'a@x.com', company: 'Quillwork AI' } as any,
  configFieldsByName: { funding_stage: {} },
  listId: 'list1',
  ...over,
});

describe('extractFieldsViaLLMReal — grounding wiring (ENG-122)', () => {
  it('DROPS the value when __entity_company__ mismatches the lead company (wrong entity)', async () => {
    mockWebSearch.mockResolvedValue({
      funding_stage: { value: 'Seed', sourceUrl: 'https://x', sourceQuote: 'Quill raised $6.5M in seed' },
      __entity_company__: 'Quill Meetings',
    });
    const res = await extractFieldsViaLLMReal(
      input({ lead: { leadId: 'l1', email: 'a@quillwork.ai', company: 'Quillwork AI' } }),
    );
    expect(res.filled.funding_stage).toBeUndefined();
    expect(res.missing).toContain('funding_stage');
  });

  it('tags the value "grounded" when it appears in the source and the entity matches', async () => {
    mockWebSearch.mockResolvedValue({
      funding_stage: { value: 'Series B', sourceUrl: 'https://x', sourceQuote: 'raised $100M in a Series B round' },
      __entity_company__: 'Slash',
    });
    const res = await extractFieldsViaLLMReal(
      input({
        sourceContext: 'Slash raised $100M in a Series B round led by Accel.',
        lead: { leadId: 'l1', email: 'a@slash.com', company: 'Slash' },
      }),
    );
    expect(res.filled.funding_stage?.grounding).toBe('grounded');
  });

  it('tags an unsourced memory value "ai-knowledge" when the entity matches', async () => {
    mockWebSearch.mockResolvedValue({
      funding_stage: { value: 'Seed' }, // no sourceUrl, no sourceQuote → training memory
      __entity_company__: 'Acme Labs',
    });
    const res = await extractFieldsViaLLMReal(
      input({
        sourceContext: 'unrelated page text with no funding',
        lead: { leadId: 'l1', email: 'a@acme.com', company: 'Acme Labs' },
      }),
    );
    expect(res.filled.funding_stage?.grounding).toBe('ai-knowledge');
  });
});

describe('metaWeb — grounding → confidence mapping (ENG-122)', () => {
  it('grounded → high confidence, with the grounding stamped', () => {
    const m = metaWeb('https://x', 'a quote', 'grounded');
    expect(m.confidence).toBe('high');
    expect(m.grounding).toBe('grounded');
  });
  it('web-unverified → low confidence', () => {
    expect(metaWeb(undefined, undefined, 'web-unverified').confidence).toBe('low');
  });
  it('ai-knowledge → low confidence', () => {
    expect(metaWeb(undefined, undefined, 'ai-knowledge').confidence).toBe('low');
  });
});

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

import { buildLLMFieldMapping } from '../services/enrichmentSiblingConfigFields';
import type { EnrichmentFieldConfig } from '../services/crmEnrichmentServiceV3';

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

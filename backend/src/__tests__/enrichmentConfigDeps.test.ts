// Tests for enrichmentConfigDeps — wires real DB + LLM impls into the dep
// objects consumed by enrichmentConfigService. Exercises the exported builder
// functions and the private heuristic/LLM helpers through the returned dep
// objects so we don't have to reach into private scope.

jest.mock('../services/db', () => ({
  crmDb: {
    getEnrichmentConfig: jest.fn(),
    setEnrichmentConfig: jest.fn(),
    getLeadListById: jest.fn(),
    mergeFieldNames: jest.fn(),
  },
}));

// LLM service is lazy-imported inside the private functions; mock the factory.
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

// enrichmentGroups is imported lazily too — use the real module (it's pure data).
// enrichmentPrompts is lazy-imported inside llmClassifySmartFields.
jest.mock('../services/enrichmentPrompts', () => ({
  buildSmartFieldClassificationSystemPrompt: jest.fn().mockReturnValue('sys'),
  buildSmartFieldClassificationUserPrompt: jest.fn().mockReturnValue('usr'),
}));

import { crmDb } from '../services/db';
import { createLLMService } from '../utils/llmService';
import {
  buildConfigServiceDeps,
  buildConfigProcessingDeps,
} from '../services/enrichmentConfigDeps';

const mkLLM = createLLMService as jest.Mock;

// ─── buildConfigServiceDeps ───────────────────────────────────────────────────

describe('buildConfigServiceDeps', () => {
  it('readListConfig delegates to crmDb.getEnrichmentConfig', async () => {
    const stored = { fields: [], schemaVersion: 1 };
    (crmDb.getEnrichmentConfig as jest.Mock).mockResolvedValue(stored);
    const deps = buildConfigServiceDeps();
    const result = await deps.readListConfig('list-1');
    expect(crmDb.getEnrichmentConfig).toHaveBeenCalledWith('list-1');
    expect(result).toBe(stored);
  });

  it('writeListConfig delegates to crmDb.setEnrichmentConfig', async () => {
    (crmDb.setEnrichmentConfig as jest.Mock).mockResolvedValue(undefined);
    const deps = buildConfigServiceDeps();
    const config: any = { fields: [], schemaVersion: 1 };
    await deps.writeListConfig('list-1', config);
    expect(crmDb.setEnrichmentConfig).toHaveBeenCalledWith('list-1', config);
  });

  it('loadListFieldNames returns fieldNames from list, defaulting to [] on missing', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ fieldNames: ['industry', 'company'] });
    const deps = buildConfigServiceDeps();
    const names = await deps.loadListFieldNames('list-1');
    expect(names).toEqual(['industry', 'company']);
  });

  it('loadListFieldNames returns [] when list has no fieldNames', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({});
    const deps = buildConfigServiceDeps();
    const names = await deps.loadListFieldNames('list-1');
    expect(names).toEqual([]);
  });

  it('loadListFieldNames returns [] when list is null', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    const deps = buildConfigServiceDeps();
    const names = await deps.loadListFieldNames('list-1');
    expect(names).toEqual([]);
  });

  it('mergeListFieldNames appends only names not already on the list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ fieldNames: ['industry', 'website'] });
    (crmDb.mergeFieldNames as jest.Mock).mockResolvedValue(undefined);
    const deps = buildConfigServiceDeps();
    await deps.mergeListFieldNames('list-1', ['industry', 'funding_stage']);
    expect(crmDb.mergeFieldNames).toHaveBeenCalledWith('list-1', ['funding_stage']);
  });

  it('mergeListFieldNames does not call mergeFieldNames when all names already exist', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ fieldNames: ['industry', 'funding_stage'] });
    (crmDb.mergeFieldNames as jest.Mock).mockClear();
    const deps = buildConfigServiceDeps();
    await deps.mergeListFieldNames('list-1', ['funding_stage']);
    expect(crmDb.mergeFieldNames).not.toHaveBeenCalled();
  });

  // ─── heuristicTypeSuggestion (via llmSuggestTypes) ───────────────────────

  describe('llmSuggestTypes (heuristic)', () => {
    it('classifies _count / count$ / number_of fields as number', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([
        { name: 'employee_count', instruction: '' },
        { name: 'headcount', instruction: '' },
        { name: 'number_of_leads', instruction: '' },
      ]);
      expect(result.find(r => r.name === 'employee_count')?.type).toBe('number');
      expect(result.find(r => r.name === 'number_of_leads')?.type).toBe('number');
    });

    it('classifies employees and revenue as number', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([
        { name: 'employees', instruction: '' },
        { name: 'revenue', instruction: '' },
      ]);
      expect(result.find(r => r.name === 'employees')?.type).toBe('number');
      expect(result.find(r => r.name === 'revenue')?.type).toBe('number');
    });

    it('classifies is_* / has_* / *_verified fields as boolean', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([
        { name: 'is_hiring', instruction: '' },
        { name: 'has_website', instruction: '' },
        { name: 'email_verified', instruction: '' },
      ]);
      expect(result.find(r => r.name === 'is_hiring')?.type).toBe('boolean');
      expect(result.find(r => r.name === 'has_website')?.type).toBe('boolean');
      expect(result.find(r => r.name === 'email_verified')?.type).toBe('boolean');
    });

    it('classifies *_date / *date fields as date', async () => {
      // Note: fields ending in _at are classified as number by the _at$ rule (which
      // runs before the date check) — only _date / date suffixes reach the date branch.
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([
        { name: 'founded_date', instruction: '' },
        { name: 'birthdate', instruction: '' },
      ]);
      expect(result.find(r => r.name === 'founded_date')?.type).toBe('date');
      expect(result.find(r => r.name === 'birthdate')?.type).toBe('date');
    });

    it('defaults to string for unrecognized field names', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([
        { name: 'industry', instruction: '' },
        { name: 'description', instruction: '' },
      ]);
      expect(result.find(r => r.name === 'industry')?.type).toBe('string');
      expect(result.find(r => r.name === 'description')?.type).toBe('string');
    });

    it('returns an empty array for empty input', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmSuggestTypes([]);
      expect(result).toEqual([]);
    });
  });

  // ─── llmInferAliases ─────────────────────────────────────────────────────

  describe('llmInferAliases', () => {
    it('returns {} for empty input without calling LLM', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmInferAliases([]);
      expect(mkLLM).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });

    it('calls LLM and returns the JSON result for non-empty input', async () => {
      const mockGenerate = jest.fn().mockResolvedValue({ funding_round: 'funding_stage' });
      mkLLM.mockReturnValue({ generateJSONContent: mockGenerate });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmInferAliases([
        { name: 'funding_round', instruction: 'Series A or B' },
      ]);
      expect(mkLLM).toHaveBeenCalled();
      expect(result).toEqual({ funding_round: 'funding_stage' });
    });

    it('returns {} when LLM throws (fail soft)', async () => {
      mkLLM.mockReturnValue({
        generateJSONContent: jest.fn().mockRejectedValue(new Error('llm down')),
      });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmInferAliases([
        { name: 'opaque_xyz', instruction: 'something' },
      ]);
      expect(result).toEqual({});
    });

    it('returns {} when LLM returns null', async () => {
      mkLLM.mockReturnValue({
        generateJSONContent: jest.fn().mockResolvedValue(null),
      });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmInferAliases([
        { name: 'stag', instruction: 'funding stage' },
      ]);
      expect(result).toEqual({});
    });
  });

  // ─── llmClassifySmartFields ───────────────────────────────────────────────

  describe('llmClassifySmartFields', () => {
    it('returns {} for empty input without calling LLM', async () => {
      const deps = buildConfigServiceDeps();
      const result = await deps.llmClassifySmartFields([]);
      expect(mkLLM).not.toHaveBeenCalled();
      expect(result).toEqual({});
    });

    it('calls LLM and returns the JSON classification result', async () => {
      const classification = {
        is_hiring: { isSmartField: true, dependencies: ['employee_count'] },
      };
      mkLLM.mockReturnValue({
        generateJSONContent: jest.fn().mockResolvedValue(classification),
      });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmClassifySmartFields([
        { name: 'is_hiring', instruction: 'are they hiring engineers' },
      ]);
      expect(result).toEqual(classification);
    });

    it('returns {} when LLM throws (fail soft)', async () => {
      mkLLM.mockReturnValue({
        generateJSONContent: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmClassifySmartFields([
        { name: 'is_hiring', instruction: 'are they hiring' },
      ]);
      expect(result).toEqual({});
    });

    it('returns {} when LLM returns null', async () => {
      mkLLM.mockReturnValue({
        generateJSONContent: jest.fn().mockResolvedValue(null),
      });
      const deps = buildConfigServiceDeps();
      const result = await deps.llmClassifySmartFields([
        { name: 'is_hiring', instruction: 'are they hiring' },
      ]);
      expect(result).toEqual({});
    });
  });
});

// ─── buildConfigProcessingDeps ────────────────────────────────────────────────

describe('buildConfigProcessingDeps', () => {
  it('readListConfig delegates to crmDb.getEnrichmentConfig', async () => {
    const stored = { fields: [], schemaVersion: 1 };
    (crmDb.getEnrichmentConfig as jest.Mock).mockResolvedValue(stored);
    const deps = buildConfigProcessingDeps();
    const result = await deps.readListConfig('list-2');
    expect(crmDb.getEnrichmentConfig).toHaveBeenCalledWith('list-2');
    expect(result).toBe(stored);
  });

  it('does not expose writeListConfig (processing-only subset)', () => {
    const deps = buildConfigProcessingDeps();
    expect((deps as any).writeListConfig).toBeUndefined();
  });

  it('llmInferAliases returns {} for empty input', async () => {
    const deps = buildConfigProcessingDeps();
    const result = await deps.llmInferAliases([]);
    expect(result).toEqual({});
  });

  it('llmClassifySmartFields returns {} for empty input', async () => {
    const deps = buildConfigProcessingDeps();
    const result = await deps.llmClassifySmartFields([]);
    expect(result).toEqual({});
  });
});

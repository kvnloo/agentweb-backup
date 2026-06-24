jest.mock('../services/enrichmentConfigService', () => ({
  processEnrichmentConfig: jest.fn(),
  canonicalFieldName: jest.fn(), // returns undefined by default → "no canonical match"
}));
jest.mock('../services/enrichmentConfigDeps', () => ({
  buildConfigProcessingDeps: jest.fn().mockReturnValue({}),
}));
jest.mock('../services/crmEnrichmentServiceV3', () => ({
  runEnrichment: jest.fn(),
}));
jest.mock('../services/enrichmentV3RealDeps', () => ({
  buildOrchestratorDeps: jest.fn().mockReturnValue({}),
}));
jest.mock('../services/db', () => ({
  crmDb: { getLeadsByListId: jest.fn(), getLeadListById: jest.fn() },
}));

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { runEnrichment } from '../services/crmEnrichmentServiceV3';
import { crmDb } from '../services/db';
import {
  runEmmaEnrichment,
  pickPreviewLeadIds,
  resolveExecuteLeadIds,
  buildListContext,
} from '../emma/enrichmentToolRunner';
import { buildRawEnrichmentConfig } from '../emma/enrichmentToolConfig';

const PROCESSED_CONFIG = {
  fields: [{ name: 'industry', type: 'string', instruction: 'x', include: true, overwritePolicy: 'fill_if_empty' }],
  globalOverwriteDefault: 'fill_if_empty',
  schemaVersion: 1,
  updatedAt: '2026-05-21T00:00:00.000Z',
  updatedBy: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  (processEnrichmentConfig as jest.Mock).mockResolvedValue({ config: PROCESSED_CONFIG, warnings: [] });
  // Default: list has no existing custom fields (normalization is a no-op for existing tests)
  (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ fieldNames: [] });
});

describe('runEmmaEnrichment', () => {
  it('processes the config, runs V3 in enrich mode, and maps the summary', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-1',
      processed: 8,
      failed: { identityResolutionFailed: 1, apolloFailed: 0, llmOrParseFailed: 1, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 1234,
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'classify industry' }],
      mode: 'enrich',
      leadIds: ['l1', 'l2'],
    });
    expect(processEnrichmentConfig).toHaveBeenCalled();
    expect(runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'list-1', userId: 'user-1', mode: 'enrich', leadIds: ['l1', 'l2'], config: PROCESSED_CONFIG }),
      expect.anything(),
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(summary).toMatchObject({
      runId: 'run-1',
      mode: 'enrich',
      processedCount: 8,
      failedCount: 2,
      durationMs: 1234,
      warnings: [],
    });
    expect(summary.samples).toBeUndefined();
  });

  it('maps preview samples from result.preview', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-2',
      processed: 2,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 50,
      preview: [
        {
          leadId: 'l1',
          extractedFields: { industry: 'Tech' },
          meta: { industry: { source: 'api', confidence: 'high', enrichedAt: 'x' } },
        },
        {
          leadId: 'l2',
          extractedFields: { industry: 'Finance' },
          meta: { industry: { source: 'api', confidence: 'high', enrichedAt: 'x' } },
        },
      ],
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'classify industry' }],
      mode: 'preview',
      leadIds: ['l1', 'l2'],
    });
    expect(summary.mode).toBe('preview');
    expect(summary.samples).toEqual([
      { leadId: 'l1', enrichedFields: { industry: 'Tech' }, unverifiedFields: [] },
      { leadId: 'l2', enrichedFields: { industry: 'Finance' }, unverifiedFields: [] },
    ]);
  });

  it('flags web-sourced / low-confidence preview fields as unverified (the Slashy funding_stage bug)', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-unverified',
      processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 50,
      preview: [
        {
          leadId: 'slashy-1',
          extractedFields: { industry: 'SaaS', funding_stage: 'Series C', employee_count: '50' },
          meta: {
            // Apollo high-confidence factual field → verified
            industry: { source: 'api', provider: 'apollo', confidence: 'high', enrichedAt: 'x' },
            // Web-sourced LLM guess → medium → unverified (the bug: "Slashy = Series C")
            funding_stage: { source: 'web_search', provider: 'llm_web_search', confidence: 'medium', enrichedAt: 'x' },
            // Critic-supported web field → verified
            employee_count: { source: 'web_search', confidence: 'medium', criticView: 'high', enrichedAt: 'x' },
          },
        },
      ],
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'funding_stage', instruction: 'find funding stage' }],
      mode: 'preview',
      leadIds: ['slashy-1'],
    });
    expect(summary.samples).toEqual([
      {
        leadId: 'slashy-1',
        enrichedFields: { industry: 'SaaS', funding_stage: 'Series C', employee_count: '50' },
        unverifiedFields: ['funding_stage'],
      },
    ]);
  });

  it('treats a preview sample with no meta as fully unverified', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-nometa',
      processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 50,
      preview: [
        { leadId: 'l1', extractedFields: { funding_stage: 'Series C' }, meta: {} },
      ],
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'funding_stage', instruction: 'find funding stage' }],
      mode: 'preview',
      leadIds: ['l1'],
    });
    expect(summary.samples?.[0].unverifiedFields).toEqual(['funding_stage']);
  });

  it('surfaces config-processing warnings', async () => {
    (processEnrichmentConfig as jest.Mock).mockResolvedValue({
      config: PROCESSED_CONFIG,
      warnings: ["'company' and 'company_name'"],
    });
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'r', processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {}, durationMs: 1,
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1', userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'x' }], mode: 'enrich',
    });
    expect(summary.warnings).toEqual(["'company' and 'company_name'"]);
  });

  it('propagates a ConfigValidationError from processEnrichmentConfig', async () => {
    const err = new Error("'industry' is already in the list.");
    err.name = 'ConfigValidationError';
    (processEnrichmentConfig as jest.Mock).mockRejectedValue(err);
    await expect(
      runEmmaEnrichment({
        listId: 'list-1', userId: 'user-1',
        outputFields: [{ name: 'industry', instruction: 'x' }], mode: 'enrich',
      }),
    ).rejects.toThrow(/already in the list/);
    expect(runEnrichment).not.toHaveBeenCalled();
  });

  it('normalizes a standard synonym (company_name → company) and includes fieldRemaps in summary', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-norm',
      processed: 3,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 100,
    });
    // List has no existing custom fields — normalization applies standard synonym only
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ fieldNames: [] });

    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'company_name', instruction: 'find the company' }],
      mode: 'enrich',
    });

    // processEnrichmentConfig should have been called with a config whose first field is 'company'
    const calledConfig = (processEnrichmentConfig as jest.Mock).mock.calls[0][0].config;
    expect(calledConfig.fields[0].name).toBe('company');

    // Summary should carry the remap
    expect(summary.fieldRemaps).toEqual([
      { from: 'company_name', to: 'company', reason: 'standard_column' },
    ]);
  });

  it('proceeds with original output_fields when getLeadListById throws (fail-soft)', async () => {
    (crmDb.getLeadListById as jest.Mock).mockRejectedValue(new Error('DynamoDB timeout'));
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-fallback',
      processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 50,
    });

    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'company_name', instruction: 'find the company' }],
      mode: 'enrich',
    });

    // Should have called processEnrichmentConfig with the original (unnormalized) field
    const calledConfig = (processEnrichmentConfig as jest.Mock).mock.calls[0][0].config;
    expect(calledConfig.fields[0].name).toBe('company_name');

    // No remaps — normalization was skipped
    expect(summary.fieldRemaps).toBeUndefined();
  });
});

describe('pickPreviewLeadIds', () => {
  it('prefers leads with identity data', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [
        { leadId: 'a', email: '', linkedin: '' },
        { leadId: 'b', email: 'b@co.com', linkedin: '' },
        { leadId: 'c', email: '', linkedin: 'https://linkedin.com/in/c' },
        { leadId: 'd', email: '', linkedin: '' },
      ],
    });
    const ids = await pickPreviewLeadIds('list-1', undefined);
    expect(ids).toEqual(['b', 'c']);
  });

  it('falls back to the first leads when fewer than 2 have identity data', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [{ leadId: 'a', email: '', linkedin: '' }, { leadId: 'b', email: '', linkedin: '' }],
    });
    const ids = await pickPreviewLeadIds('list-1', undefined);
    expect(ids).toEqual(['a', 'b']);
  });

  it('draws the sample from explicit lead_ids when provided', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [
        { leadId: 'a', email: 'a@co.com' },
        { leadId: 'b', email: 'b@co.com' },
        { leadId: 'c', email: 'c@co.com' },
      ],
    });
    const ids = await pickPreviewLeadIds('list-1', ['c', 'a']);
    expect(ids.sort()).toEqual(['a', 'c']);
  });

  it('throws when the list has no leads', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: [] });
    await expect(pickPreviewLeadIds('list-1', undefined)).rejects.toThrow(/no leads/i);
  });

  it('treats a non-array items response as an empty pool and throws', async () => {
    // Exercises the `Array.isArray(result?.items) ? ... : []` false branch (line 98)
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: null });
    await expect(pickPreviewLeadIds('list-1', undefined)).rejects.toThrow(/no leads/i);
  });

  it('treats a missing items field as an empty pool and throws', async () => {
    // Exercises the `Array.isArray(result?.items) ? ... : []` false branch (line 98) via undefined
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({});
    await expect(pickPreviewLeadIds('list-1', undefined)).rejects.toThrow(/no leads/i);
  });

  it('treats a null DB result as an empty pool (optional-chaining null path, line 98)', async () => {
    // Exercises the `result?.items` optional-chaining false branch when result itself is null
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue(null);
    await expect(pickPreviewLeadIds('list-1', undefined)).rejects.toThrow(/no leads/i);
  });
});

describe('resolveExecuteLeadIds', () => {
  it('uses explicit lead_ids and their count', async () => {
    const r = await resolveExecuteLeadIds('list-1', ['x', 'y', 'z']);
    expect(r).toEqual({ leadIds: ['x', 'y', 'z'], count: 3 });
    expect(crmDb.getLeadsByListId).not.toHaveBeenCalled();
  });

  it('counts the whole list when lead_ids is absent', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [{ leadId: 'a' }, { leadId: 'b' }],
    });
    const r = await resolveExecuteLeadIds('list-1', undefined);
    expect(r).toEqual({ leadIds: undefined, count: 2 });
  });

  it('treats a non-array items response as zero leads', async () => {
    // Exercises the `Array.isArray(result?.items) ? ... : []` false branch (line 125)
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: null });
    const r = await resolveExecuteLeadIds('list-1', undefined);
    expect(r).toEqual({ leadIds: undefined, count: 0 });
  });

  it('treats a null DB result as zero leads (optional-chaining null path, line 125)', async () => {
    // Exercises the `result?.items` optional-chaining false branch when result itself is null
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue(null);
    const r = await resolveExecuteLeadIds('list-1', undefined);
    expect(r).toEqual({ leadIds: undefined, count: 0 });
  });
});

describe('runEmmaEnrichment — listContext propagation', () => {
  it('forwards the list name + description as listContext into the V3 run', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      fieldNames: [],
      name: 'YC Poker Night',
      description: 'YC alumni',
    });
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-ctx',
      processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 10,
    });
    await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'company', instruction: 'find company' }],
      mode: 'enrich',
    });
    expect(runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ listContext: 'YC Poker Night — YC alumni' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes listContext=undefined when the list lookup fails', async () => {
    (crmDb.getLeadListById as jest.Mock).mockRejectedValue(new Error('ddb down'));
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-ctx2',
      processed: 0,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 5,
    });
    await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'company', instruction: 'find company' }],
      mode: 'enrich',
    });
    expect(runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ listContext: undefined }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('buildListContext', () => {
  it('combines name and description with an em-dash separator', () => {
    expect(buildListContext({ name: 'YC Poker Night', description: 'YC alumni' }))
      .toBe('YC Poker Night — YC alumni');
  });

  it('returns the name alone when description is empty', () => {
    expect(buildListContext({ name: 'YC Poker Night', description: '' }))
      .toBe('YC Poker Night');
  });

  it('returns the description alone when name is empty', () => {
    expect(buildListContext({ name: '', description: 'YC alumni' }))
      .toBe('YC alumni');
  });

  it('returns undefined when both name and description are missing', () => {
    expect(buildListContext({})).toBeUndefined();
    expect(buildListContext(null)).toBeUndefined();
    expect(buildListContext({ name: '   ', description: '  ' })).toBeUndefined();
  });

  it('truncates an over-long combined context to 200 chars', () => {
    const longDesc = 'x'.repeat(500);
    const result = buildListContext({ name: 'List', description: longDesc });
    expect(result).toBeDefined();
    expect(result!.length).toBe(200);
  });
});

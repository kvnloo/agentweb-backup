jest.mock('../services/enrichmentConfigService', () => ({
  processEnrichmentConfig: jest.fn(),
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
  crmDb: { getLeadsByListId: jest.fn() },
}));

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { runEnrichment } from '../services/crmEnrichmentServiceV3';
import { crmDb } from '../services/db';
import {
  runEmmaEnrichment,
  pickPreviewLeadIds,
  resolveExecuteLeadIds,
} from '../emma/enrichmentToolRunner';

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
        { leadId: 'l1', extractedFields: { industry: 'Tech' }, meta: {} },
        { leadId: 'l2', extractedFields: { industry: 'Finance' }, meta: {} },
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
      { leadId: 'l1', enrichedFields: { industry: 'Tech' } },
      { leadId: 'l2', enrichedFields: { industry: 'Finance' } },
    ]);
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
});

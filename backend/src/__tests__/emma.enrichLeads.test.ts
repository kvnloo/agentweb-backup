// Tests for Emma CRM enrichment tool registration and execution (V3 engine)

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../emma/enrichmentToolRunner', () => ({
  runEmmaEnrichment: jest.fn(),
  pickPreviewLeadIds: jest.fn(),
  resolveExecuteLeadIds: jest.fn(),
}));

jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import {
  runEmmaEnrichment,
  pickPreviewLeadIds,
  resolveExecuteLeadIds,
} from '../emma/enrichmentToolRunner';
import { crmDb } from '../services/db';

const SUMMARY = {
  runId: 'run-1',
  mode: 'enrich' as const,
  processedCount: 5,
  failedCount: 0,
  failureBreakdown: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
  durationMs: 100,
  warnings: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  (runEmmaEnrichment as jest.Mock).mockResolvedValue(SUMMARY);
  (pickPreviewLeadIds as jest.Mock).mockResolvedValue(['l1', 'l2']);
  (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 5 });
});

describe('enrich_leads_preview', () => {
  it('registers with the new object-array output_fields schema', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'output_fields']),
    );
    expect(tool.definition.inputSchema.required).not.toContain('instruction');
    expect(tool.definition.inputSchema.required).not.toContain('sources');
  });

  it('runs V3 in preview mode on the sampled lead ids', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    const result = await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }] },
      { userId: 'user1', socketId: 'sock-1' },
    );
    expect(pickPreviewLeadIds).toHaveBeenCalledWith('list-abc', undefined);
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc',
      userId: 'user1',
      mode: 'preview',
      leadIds: ['l1', 'l2'],
      socketId: 'sock-1',
    }));
    expect(result).toBe(SUMMARY);
  });

  it('rejects when there is no user context', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    await expect(
      tool.execute({ list_id: 'l', output_fields: [{ name: 'f', instruction: 'i' }] }, {}),
    ).rejects.toThrow(/Authentication required/);
  });

  it('returns processedCount=0 with identityResolutionFailed>0 when all sampled leads lack identity data', async () => {
    const identityFailureSummary = {
      ...SUMMARY,
      mode: 'preview' as const,
      processedCount: 0,
      failedCount: 2,
      failureBreakdown: { identityResolutionFailed: 2, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      samples: [],
    };
    (runEmmaEnrichment as jest.Mock).mockResolvedValue(identityFailureSummary);
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    const result = await tool.execute(
      { list_id: 'list_1778189476782_1au64sgvz', output_fields: [{ name: 'company', instruction: 'find company name' }] },
      { userId: 'user1' },
    );
    expect(result.processedCount).toBe(0);
    expect(result.failureBreakdown.identityResolutionFailed).toBe(2);
  });
});

describe('enrich_leads_execute', () => {
  it('registers and requires list_id + output_fields', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'output_fields']),
    );
  });

  it('runs V3 in enrich mode for a list under the cap', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 5 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }] },
      { userId: 'user1', socketId: 'sock-1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc', userId: 'user1', mode: 'enrich', leadIds: undefined,
    }));
  });

  it('passes an explicit lead_ids subset through', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: ['a', 'b'], count: 2 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }], lead_ids: ['a', 'b'] },
      { userId: 'user1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({ leadIds: ['a', 'b'] }));
  });

  it('rejects and does not run when the list exceeds the cap', async () => {
    process.env.EMMA_ENRICH_MAX_LEADS = '10';
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 11 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await expect(
      tool.execute(
        { list_id: 'big', output_fields: [{ name: 'industry', instruction: 'classify' }] },
        { userId: 'user1' },
      ),
    ).rejects.toThrow(/limit/i);
    expect(runEmmaEnrichment).not.toHaveBeenCalled();
    delete process.env.EMMA_ENRICH_MAX_LEADS;
  });

  it('rejects when the list is empty', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 0 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await expect(
      tool.execute(
        { list_id: 'empty', output_fields: [{ name: 'industry', instruction: 'classify' }] },
        { userId: 'user1' },
      ),
    ).rejects.toThrow(/no leads/i);
    expect(runEmmaEnrichment).not.toHaveBeenCalled();
  });
});

describe('enrich_lead_custom', () => {
  beforeEach(() => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-7',
      customFields: { company_size: '200' },
      title: 'CTO',
    });
  });

  it('registers and requires list_id + lead_id + output_fields', () => {
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'lead_id', 'output_fields']),
    );
  });

  it('runs V3 enrich mode on a single-lead batch and returns enriched values', async () => {
    (runEmmaEnrichment as jest.Mock).mockResolvedValue({ ...SUMMARY, processedCount: 1 });
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    const result = await tool.execute(
      {
        list_id: 'list-abc',
        lead_id: 'lead-7',
        output_fields: [
          { name: 'company_size', instruction: 'find headcount' },
          { name: 'title', instruction: 'find their job title' },
        ],
      },
      { userId: 'user1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc',
      userId: 'user1',
      mode: 'enrich',
      leadIds: ['lead-7'],
    }));
    expect(result.leadId).toBe('lead-7');
    expect(result.enrichedValues).toEqual({ company_size: '200', title: 'CTO' });
  });

  it('returns sanitized per-field enrichmentMetadata so the agent can cite source/confidence', async () => {
    (runEmmaEnrichment as jest.Mock).mockResolvedValue({ ...SUMMARY, processedCount: 1 });
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-7',
      customFields: { funding_stage: 'Series C' },
      enrichmentMetadata: {
        funding_stage: {
          source: 'web_search',
          provider: 'llm_web_search',
          confidence: 'medium',
          sourceUrl: 'https://example.com/slashy',
          enrichedAt: '2026-06-22T00:00:00.000Z',
        },
      },
    });
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    const result = await tool.execute(
      {
        list_id: 'list-abc',
        lead_id: 'lead-7',
        output_fields: [{ name: 'funding_stage', instruction: 'find funding stage' }],
      },
      { userId: 'user1' },
    );
    expect(result.enrichedValues).toEqual({ funding_stage: 'Series C' });
    expect(result.enrichmentMetadata).toBeDefined();
    expect(result.enrichmentMetadata.funding_stage.provider).toBe('llm_web_search');
    expect(result.enrichmentMetadata.funding_stage.confidence).toBe('medium');
  });

  it('strips cross-tenant CRM-history lineage from enrich_lead_custom enrichmentMetadata', async () => {
    (runEmmaEnrichment as jest.Mock).mockResolvedValue({ ...SUMMARY, processedCount: 1 });
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-7',
      customFields: { funding_stage: 'Seed' },
      enrichmentMetadata: {
        funding_stage: {
          source: 'crm-history',
          provider: 'agentweb',
          confidence: 'medium',
          siblingLeadId: 'other-tenant-lead',
          siblingListId: 'other-tenant-list',
          siblingUserId: 'other-tenant-user',
          enrichedAt: '2026-06-22T00:00:00.000Z',
        },
      },
    });
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    const result = await tool.execute(
      {
        list_id: 'list-abc',
        lead_id: 'lead-7',
        output_fields: [{ name: 'funding_stage', instruction: 'find funding stage' }],
      },
      { userId: 'user1' },
    );
    const meta = result.enrichmentMetadata.funding_stage;
    expect(meta.source).toBe('agentweb');            // rewritten from 'crm-history'
    expect(meta.siblingLeadId).toBeUndefined();
    expect(meta.siblingListId).toBeUndefined();
    expect(meta.siblingUserId).toBeUndefined();
  });

  it('omits enrichmentMetadata when the enriched lead has none', async () => {
    (runEmmaEnrichment as jest.Mock).mockResolvedValue({ ...SUMMARY, processedCount: 1 });
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-7',
      customFields: { company_size: '200' },
      title: 'CTO',
    });
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    const result = await tool.execute(
      {
        list_id: 'list-abc',
        lead_id: 'lead-7',
        output_fields: [{ name: 'company_size', instruction: 'find headcount' }],
      },
      { userId: 'user1' },
    );
    expect(result.enrichmentMetadata).toBeUndefined();
  });

  it('rejects when output_fields is empty (via buildRawEnrichmentConfig)', async () => {
    (runEmmaEnrichment as jest.Mock).mockRejectedValue(new Error('output_fields must be a non-empty array'));
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    await expect(
      tool.execute({ list_id: 'l', lead_id: 'x', output_fields: [] }, { userId: 'user1' }),
    ).rejects.toThrow(/non-empty/);
  });

  it('rejects when there is no user context', async () => {
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    await expect(
      tool.execute(
        { list_id: 'l', lead_id: 'x', output_fields: [{ name: 'f', instruction: 'i' }] },
        {},
      ),
    ).rejects.toThrow(/Authentication required/);
  });
});

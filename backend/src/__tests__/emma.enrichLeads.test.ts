// Tests for Emma CRM enrichment tool registration and execution

jest.mock('../server', () => ({
  io: {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    emit: jest.fn(),
  },
  app: {},
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    updateLead: jest.fn(),
    updateFieldNames: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    searchWeb: jest.fn(),
    linkedinOutreach: jest.fn(),
  },
}));

jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
}));

// Import tools to trigger registration (side effect)
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { CrmEnrichmentService } from '../services/crmEnrichmentService';

// Spy on CrmEnrichmentService methods
jest.spyOn(CrmEnrichmentService.prototype, 'preview').mockResolvedValue({
  totalLeads: 100,
  leadsToProcess: 80,
  alreadyEnriched: 20,
  samples: [
    { leadId: 'lead1', lead: { leadId: 'lead1', company: 'Acme' }, enrichedFields: { industry: 'Tech' } },
    { leadId: 'lead2', lead: { leadId: 'lead2', company: 'Beta' }, enrichedFields: { industry: 'Finance' } },
  ],
});

jest.spyOn(CrmEnrichmentService.prototype, 'execute').mockResolvedValue({
  jobId: 'job-123',
  processedCount: 80,
  failedCount: 0,
  skippedCount: 0,
  totalToProcess: 80,
  outputFields: ['industry'],
  failureBreakdown: { searchWebFailed: 0, linkedinFailed: 0, llmOrParseFailed: 0, updateFailed: 0 },
});

describe('Emma CRM Enrichment Tools', () => {
  it('should register enrich_leads_preview tool', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview');
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe('enrich_leads_preview');
    expect(tool!.definition.inputSchema.required).toContain('list_id');
    expect(tool!.definition.inputSchema.required).toContain('instruction');
    expect(tool!.definition.inputSchema.required).toContain('output_fields');
    expect(tool!.definition.inputSchema.required).toContain('sources');
  });

  it('should register enrich_leads_execute tool', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_execute');
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe('enrich_leads_execute');
    expect(tool!.definition.inputSchema.required).toContain('list_id');
  });

  it('should call service.preview() with correct args from preview tool', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    const result = await tool.execute({
      list_id: 'list-abc',
      instruction: 'Determine industry',
      output_fields: ['industry'],
      sources: ['web_search'],
    }, { userId: 'user1' });

    expect(result.totalLeads).toBe(100);
    expect(result.samples).toHaveLength(2);
    expect(CrmEnrichmentService.prototype.preview).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc',
      userId: 'user1',
      instruction: 'Determine industry',
      outputFields: ['industry'],
      sources: ['web_search'],
    }));
  });

  it('should call service.execute() with correct args from execute tool', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    const result = await tool.execute({
      list_id: 'list-abc',
      instruction: 'Determine industry',
      output_fields: ['industry'],
      sources: ['web_search'],
    }, { userId: 'user1', socketId: 'sock-123' });

    expect(result.jobId).toBe('job-123');
    expect(CrmEnrichmentService.prototype.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        listId: 'list-abc',
        userId: 'user1',
      }),
      'sock-123',
      undefined
    );
  });

  it('should pass userId from context', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    await tool.execute({
      list_id: 'list-xyz',
      instruction: 'test',
      output_fields: ['field1'],
      sources: ['existing_data'],
    }, { userId: 'user-42' });

    expect(CrmEnrichmentService.prototype.preview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-42' })
    );
  });

  describe('enrich_lead_custom tool', () => {
    beforeEach(() => {
      (CrmEnrichmentService.prototype.execute as jest.Mock).mockClear();
    });

    it('should register enrich_lead_custom tool', () => {
      const tool = emmaToolRegistry.getTool('enrich_lead_custom');
      expect(tool).toBeDefined();
      expect(tool!.definition.name).toBe('enrich_lead_custom');
      expect(tool!.definition.inputSchema.required).toEqual(
        expect.arrayContaining(['list_id', 'lead_id', 'custom_field_prompts'])
      );
    });

    it('should wrap service.execute() with a single-lead batch and derived outputFields/instruction', async () => {
      const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
      const result = await tool.execute({
        list_id: 'list-abc',
        lead_id: 'lead-7',
        custom_field_prompts: [
          { field_name: 'company_size', prompt: 'Find headcount on LinkedIn' },
          { field_name: 'industry', prompt: 'Classify their industry', data_type: 'text' },
        ],
      }, { userId: 'user1' });

      expect(result.leadId).toBe('lead-7');
      expect(result.listId).toBe('list-abc');
      expect(result.outputFields).toEqual(['company_size', 'industry']);
      expect(result.processedCount).toBe(80);
      expect(CrmEnrichmentService.prototype.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          listId: 'list-abc',
          userId: 'user1',
          outputFields: ['company_size', 'industry'],
          leadIds: ['lead-7'],
          forceOverwrite: true,
          sources: ['web_search', 'linkedin'],
          instruction: expect.stringContaining('company_size'),
        }),
        undefined,
        undefined
      );
    });

    it('should respect custom sources when provided', async () => {
      const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
      await tool.execute({
        list_id: 'list-abc',
        lead_id: 'lead-7',
        custom_field_prompts: [{ field_name: 'notes', prompt: 'Anything interesting' }],
        sources: ['existing_data'],
        force_overwrite: false,
      }, { userId: 'user1' });

      expect(CrmEnrichmentService.prototype.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sources: ['existing_data'],
          forceOverwrite: false,
        }),
        undefined,
        undefined
      );
    });

    it('should throw when custom_field_prompts is empty', async () => {
      const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
      await expect(
        tool.execute({ list_id: 'l', lead_id: 'x', custom_field_prompts: [] }, { userId: 'user1' })
      ).rejects.toThrow(/non-empty/);
    });

    it('should throw when no userId in context', async () => {
      const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
      await expect(
        tool.execute({
          list_id: 'l',
          lead_id: 'x',
          custom_field_prompts: [{ field_name: 'f', prompt: 'p' }],
        }, {})
      ).rejects.toThrow(/Authentication required/);
    });
  });
});

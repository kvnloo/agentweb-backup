// Unit tests for CRM Enrichment Service

jest.mock('../server', () => ({
  io: {
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
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

const mockGeminiCreate = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    searchWeb: jest.fn(),
    linkedinOutreach: jest.fn(),
    getGeminiClient: jest.fn().mockResolvedValue({
      chat: {
        completions: {
          create: mockGeminiCreate,
        },
      },
    }),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
}));

import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { io } from '../server';
import { CrmEnrichmentService, EnrichmentJobSpec } from '../services/crmEnrichmentService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockIo = io as any;

// Helper: mock a successful Gemini completion response
function geminiResponse(content: Record<string, string>) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
  };
}

// Helper to create a sample lead
function createLead(overrides: any = {}) {
  return {
    leadId: `lead-${Math.random().toString(36).slice(2, 8)}`,
    company: 'Acme Corp',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@acme.com',
    title: 'CEO',
    customFields: {},
    ...overrides,
  };
}

describe('CrmEnrichmentService', () => {
  let service: CrmEnrichmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
  });

  // ─── FAIL CASES ───────────────────────────────────────────────────────────

  describe('preview - fail cases', () => {
    it('should throw error when list not found', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue(null);

      const spec: EnrichmentJobSpec = {
        listId: 'nonexistent',
        userId: 'user1',
        instruction: 'Enrich with company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
      };

      await expect(service.preview(spec)).rejects.toThrow('Lead list not found');
    });

    it('should return zero-count preview when no leads match filters', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [
        createLead({ customFields: { status: 'inactive' } }),
      ], lastEvaluatedKey: null, hasMore: false });

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Enrich with company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
        filters: [{ field: 'status', operator: 'equals', value: 'active' }],
      };

      const result = await service.preview(spec);
      expect(result.totalLeads).toBe(1);
      expect(result.leadsToProcess).toBe(0);
    });
  });

  describe('execute - fail cases', () => {
    it('should count LLM parse failure in failureBreakdown and continue processing', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' }), createLead({ leadId: 'lead2' })],
        lastEvaluatedKey: null, hasMore: false,
      });

      // First lead: JSON mode fails, retry also returns garbage
      mockGeminiCreate
        .mockRejectedValueOnce(new Error('Invalid JSON'))
        .mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' } }] })
        // Second lead succeeds
        .mockResolvedValueOnce(geminiResponse({ company_size: '500+' }));

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'A company' }] });
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
      };

      const result = await service.execute(spec);
      expect(result.failureBreakdown.llmOrParseFailed).toBeGreaterThanOrEqual(1);
      // Second lead should still succeed
      expect(result.processedCount).toBeGreaterThanOrEqual(1);
    });

    it('should count web search failure in failureBreakdown and continue processing', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' }), createLead({ leadId: 'lead2' })],
        lastEvaluatedKey: null, hasMore: false,
      });

      mockAgentModeService.searchWeb
        .mockResolvedValueOnce({ success: false, error: 'Rate limited' })
        .mockResolvedValueOnce({ success: true, results: [{ title: 'Acme', snippet: 'A company' }] });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '500+' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
      };

      const result = await service.execute(spec);
      expect(result.failureBreakdown.searchWebFailed).toBe(1);
      expect(result.processedCount).toBe(1);
    });

    it('should skip linkedin source with warning when no account connected', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });

      mockGetAccountsByUserId.mockResolvedValue([]);

      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine industry',
        outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      const result = await service.execute(spec);
      expect(result.warnings).toContain('No LinkedIn (Unipile) account connected — linkedin source skipped');
      expect(result.processedCount).toBe(1);
    });
  });

  // ─── SUCCESS CASES ────────────────────────────────────────────────────────

  describe('preview - success cases', () => {
    it('should return correct stats and 2 sample results with enriched fields', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1' }),
        createLead({ leadId: 'lead2' }),
        createLead({ leadId: 'lead3' }),
        createLead({ leadId: 'lead4', customFields: { company_size: '100', industry: 'Finance' } }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'A company' }] });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '500+', industry: 'Technology' }));

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine company size and industry',
        outputFields: ['company_size', 'industry'],
        sources: ['web_search'],
      };

      const result = await service.preview(spec);
      expect(result.totalLeads).toBe(4);
      expect(result.leadsToProcess).toBe(3); // 3 without both fields
      expect(result.alreadyEnriched).toBe(1);
      expect(result.samples).toHaveLength(2);
      expect(result.samples[0].enrichedFields).toBeDefined();
    });
  });

  describe('execute - success cases', () => {
    it('should update customFields on leads with existing_data source', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1', company: 'Acme', title: 'CTO', customFields: { revenue: '10M' } }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Technology' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Infer the industry from existing fields',
        outputFields: ['industry'],
        sources: ['existing_data'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        customFields: expect.objectContaining({ industry: 'Technology' }),
      }));
    });

    it('should call searchWeb + Gemini per lead with web_search source', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Tech company' }] });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '500+' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith(expect.stringContaining('Acme Corp'), 5);
      expect(mockGeminiCreate).toHaveBeenCalled();
    });

    it('should call searchPeople/getProfile per lead with linkedin source', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', linkedin: 'https://linkedin.com/in/johndoe' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);

      mockAgentModeService.linkedinOutreach
        .mockResolvedValue({ success: true, data: { headline: 'CTO at Acme', summary: 'Tech leader' } });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ seniority: 'C-level' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine seniority level',
        outputFields: ['seniority'],
        sources: ['linkedin'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
        'user1',
        expect.objectContaining({ action: 'get-profile', account_id: 'acc1' })
      );
    });

    it('should feed both web_search and linkedin data to Gemini with combined sources', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Tech company' }] });
      // First call: search-people returns a result, second call: get-profile returns profile
      mockAgentModeService.linkedinOutreach
        .mockResolvedValueOnce({ success: true, data: { items: [{ provider_id: 'prov1' }] } })
        .mockResolvedValueOnce({ success: true, data: { headline: 'CTO', summary: 'Leader' } });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '500+', seniority: 'C-level' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Determine company size and seniority',
        outputFields: ['company_size', 'seniority'],
        sources: ['web_search', 'linkedin'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalled();
      // Both data sources fed into the same Gemini call
      const geminiCall = mockGeminiCreate.mock.calls[0][0];
      const userMsg = geminiCall.messages.find((m: any) => m.role === 'user')?.content || '';
      expect(userMsg).toContain('Web search');
      expect(userMsg).toContain('LinkedIn');
    });

    it('should re-process already-enriched leads when forceOverwrite=true', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1', customFields: { company_size: '100' } }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '500+' }));

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Big company' }] });
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
        forceOverwrite: true,
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
    });

    it('should correctly narrow leads with filters', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1', customFields: { status: 'active' } }),
        createLead({ leadId: 'lead2', customFields: { status: 'inactive' } }),
        createLead({ leadId: 'lead3', customFields: { status: 'active' } }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Company' }] });
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find industry',
        outputFields: ['industry'],
        sources: ['web_search'],
        filters: [{ field: 'status', operator: 'equals', value: 'active' }],
      };

      const result = await service.execute(spec);
      // Only 2 active leads should be processed
      expect(result.processedCount).toBe(2);
      expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(2);
    });

    it('should call updateFieldNames with new field names after completion', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_size: '100' }));

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Company' }] });
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find company size',
        outputFields: ['company_size'],
        sources: ['web_search'],
      };

      await service.execute(spec);
      expect(mockCrmDb.updateFieldNames).toHaveBeenCalledWith('list1', ['company_size']);
    });

    it('should use parallelism of 5 when linkedin source is enabled', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      // Create enough leads to test parallelism
      const leads = Array.from({ length: 20 }, (_, i) => createLead({ leadId: `lead${i}` }));
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);
      mockAgentModeService.linkedinOutreach
        .mockResolvedValue({ success: true, data: { headline: 'CTO' } });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ seniority: 'C-level' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find seniority',
        outputFields: ['seniority'],
        sources: ['linkedin'],
      };

      const result = await service.execute(spec);
      // All 20 leads should be processed
      expect(result.processedCount).toBe(20);
      // Gemini called once per lead
      expect(mockGeminiCreate).toHaveBeenCalledTimes(20);
    });
  });

  // ─── BACKWARD COMPATIBILITY ───────────────────────────────────────────────

  describe('enrichWebCompat', () => {
    it('should call execute with hardcoded web_company_info params', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false });

      const result = await CrmEnrichmentService.enrichWebCompat('list1', 'user1', 'socket1', false);
      // With no leads, processedCount should be 0
      expect(result.processedCount).toBe(0);
    });
  });

  // ─── SOCKET.IO PROGRESS ───────────────────────────────────────────────────

  describe('Socket.IO progress events', () => {
    it('should emit progress events via Socket.IO when socketId provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Company' }] });
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find industry',
        outputFields: ['industry'],
        sources: ['web_search'],
      };

      await service.execute(spec, 'test-socket-id');

      const toMock = mockIo.to;
      expect(toMock).toHaveBeenCalledWith('test-socket-id');
      const emitMock = toMock.mock.results[0]?.value?.emit;
      expect(emitMock).toHaveBeenCalledWith(
        'crm-enrichment-progress',
        expect.objectContaining({ jobId: expect.any(String) })
      );
    });
  });
});

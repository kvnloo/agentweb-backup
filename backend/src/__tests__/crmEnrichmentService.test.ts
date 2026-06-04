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
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    updateFieldNames: jest.fn(),
    setLeadFields: jest.fn(),
    mergeFieldNames: jest.fn(),
    updateSearchQueryTemplates: jest.fn(),
    createEnrichmentSnapshotItem: jest.fn(),
    createEnrichmentJobMeta: jest.fn(),
    updateEnrichmentJobStatus: jest.fn(),
    getEnrichmentJobsByListId: jest.fn(),
    getEnrichmentSnapshotsByJobId: jest.fn(),
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
    getClientForModel: jest.fn().mockResolvedValue({
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

jest.mock('../services/enrichmentCacheService', () => ({
  getRawDataFromCache: jest.fn().mockResolvedValue(null),
  writeRawDataToCache: jest.fn().mockResolvedValue(undefined),
  buildWebContextFromCache: jest.fn().mockReturnValue(''),
  buildLinkedInContextFromCache: jest.fn().mockReturnValue(''),
  isLinkedInCacheEligible: jest.fn().mockReturnValue(false),
  splitFieldsByGroup: jest.fn().mockImplementation((fields: string[]) => ({ byGroup: new Map(), ungrouped: fields })),
}));

// Default cluster-service stub: reject so enrichLead's catch path falls through
// to the legacy gatherWebContext (no template → buildSearchQuery uses company
// name). Tests of cluster behavior live in enrichmentClusterService.test.ts.
jest.mock('../services/enrichmentClusterService', () => ({
  getOrCreateClustersForFields: jest.fn().mockRejectedValue(new Error('cluster service stubbed off in this test')),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../services/linkedInOutreachService', () => {
  const actual = jest.requireActual('../services/linkedInOutreachService');
  // Prevent isAccountConnected from calling the Unipile API in unit tests
  actual.linkedInOutreachService.isAccountConnected = jest.fn().mockResolvedValue(true);
  return actual;
});

import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { settingsService } from '../services/settingsService';
import { io } from '../server';
import { CrmEnrichmentService, EnrichmentJobSpec } from '../services/crmEnrichmentService';
import * as apolloServiceModule from '../services/apolloService';
import type { ApolloService } from '../services/apolloService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockIo = io as any;

// Helper: mock a successful Gemini completion response
// Accepts either legacy flat-string format or new rich-citation format:
//   legacy:  { field: "value" }
//   citation: { field: { value: "...", sourceQuote: "...", sourceUrl: "...", confidence: "high" } }
function geminiResponse(content: Record<string, any>) {
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
    // Bridge new targeted-write API to existing assertions that inspect updateLead payloads.
    mockCrmDb.setLeadFields.mockImplementation(async (listId: string, leadId: string, options: any) => {
      const payload: Record<string, any> = { ...(options?.topLevel || {}) };
      if (options?.customFields && Object.keys(options.customFields).length > 0) {
        payload.customFields = options.customFields;
      }
      if (options?.enrichmentMetadata && Object.keys(options.enrichmentMetadata).length > 0) {
        payload.enrichmentMetadata = options.enrichmentMetadata;
      }
      await mockCrmDb.updateLead(listId, leadId, payload as any);
    });
    mockCrmDb.mergeFieldNames.mockImplementation(async (listId: string, newFields: Set<string> | string[]) => {
      await mockCrmDb.updateFieldNames(listId, Array.from(newFields as any));
    });
    mockCrmDb.createEnrichmentSnapshotItem.mockResolvedValue(undefined);
    mockCrmDb.createEnrichmentJobMeta.mockResolvedValue(undefined);
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
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

  describe('preview - empty-signal leads', () => {
    it('skips searchWeb when leads have no email/company (avoids identical-bogus-results bug)', async () => {
      // Leads have only LinkedIn URLs — no email, no company. The canonical
      // group templates use {{emailDomain}}, which collapses to "" for these,
      // making the query "company overview" / "funding investors" — generic
      // searches that historically returned the same FedEx page for every lead.
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const emptyLeads = [
        { leadId: 'lead1', linkedin: 'https://www.linkedin.com/in/scott-t', customFields: {} },
        { leadId: 'lead2', linkedin: 'https://www.linkedin.com/in/mike-h', customFields: {} },
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: emptyLeads, lastEvaluatedKey: null, hasMore: false });

      // No mock searchWeb setup — if it gets called, the mock returns undefined
      // and the test would throw. We assert it is NOT called.
      mockGeminiCreate.mockResolvedValue(geminiResponse({ company_name: null, industry: null }));

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Research {{emailDomain}} {{company}}',
        outputFields: ['company_name', 'industry'],
        sources: ['web_search'],
        // Caller-provided template using emailDomain — common case from the UI
        webSearchTemplate: '{{emailDomain}} company overview',
      };

      await service.preview(spec);

      // The whole point of this fix: the broken generic search must NOT fire.
      expect(mockAgentModeService.searchWeb).not.toHaveBeenCalled();
    });
  });

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
      expect(mockAgentModeService.searchWeb).toHaveBeenCalledTimes(1);
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

    it('should preserve existing linkedin URL when Unipile returns nothing and LLM says Unknown', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({
        leadId: 'lead1',
        linkedin: 'https://www.linkedin.com/in/existing-url',
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Acme',
      })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);

      // Unipile lookup fails — no profile found
      mockAgentModeService.linkedinOutreach.mockResolvedValue({ success: false, data: null });

      // LLM returns Unknown (no LinkedIn data available)
      mockGeminiCreate.mockResolvedValue(geminiResponse({ linkedin_url: 'Unknown' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find the personal LinkedIn profile URL for {{firstName}} {{lastName}} at {{company}}',
        outputFields: ['linkedin_url'],
        sources: ['linkedin'],
        sourcesPerField: { linkedin_url: ['linkedin'] },
        linkedinSearchTemplate: '{{firstName}} {{lastName}} {{company}}',
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);

      // updateLead must NOT have written "Unknown" to the linkedin field
      const updateCall = mockCrmDb.updateLead.mock.calls[0];
      const updates = updateCall[2];
      expect(updates.linkedin).toBeUndefined();
    });

    it('should use existing valid linkedin URL as primary source when isEnrichingLinkedin', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({
        leadId: 'lead1',
        linkedin: 'https://www.linkedin.com/in/existing-url',
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Acme',
      })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);

      // Unipile returns profile data from the existing URL lookup
      mockAgentModeService.linkedinOutreach
        .mockResolvedValue({ success: true, data: { public_identifier: 'existing-url', headline: 'CTO' } });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ linkedin_url: 'https://www.linkedin.com/in/existing-url' }));

      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find the personal LinkedIn profile URL for {{firstName}} {{lastName}} at {{company}}',
        outputFields: ['linkedin_url'],
        sources: ['linkedin'],
        sourcesPerField: { linkedin_url: ['linkedin'] },
        linkedinSearchTemplate: '{{firstName}} {{lastName}} {{company}}',
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);

      // First linkedinOutreach call should be get-profile with the existing URL (not search-people)
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
        'user1',
        expect.objectContaining({ action: 'get-profile', profile_url: 'https://www.linkedin.com/in/existing-url' })
      );

      // The valid URL should be written back
      const updateCall = mockCrmDb.updateLead.mock.calls[0];
      const updates = updateCall[2];
      expect(updates.linkedin).toBe('https://www.linkedin.com/in/existing-url');
    });

    it('should use email domain as company fallback for linkedin search when no company set', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({
        leadId: 'lead1',
        company: '',
        firstName: '',
        lastName: '',
        email: 'nick@engenerate.ai',
        customFields: { first_name: 'Nicholas', last_name: 'Koutsunis' },
      })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });
      mockGetAccountsByUserId.mockResolvedValue([{ account_id: 'acc1', platform: 'unipile' }] as any);

      // search-people finds a result
      mockAgentModeService.linkedinOutreach
        .mockResolvedValueOnce({
          success: true,
          data: { items: [{ provider_id: 'p123', public_identifier: 'nicholas-koutsunis' }] },
        })
        .mockResolvedValueOnce({
          success: true,
          data: { public_identifier: 'nicholas-koutsunis', headline: 'Founder' },
        });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ linkedin_url: 'https://www.linkedin.com/in/nicholas-koutsunis' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find linkedin',
        outputFields: ['linkedin_url'],
        sources: ['linkedin'],
        sourcesPerField: { linkedin_url: ['linkedin'] },
        linkedinSearchTemplate: '',
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);

      // search-people should have been called with name + email domain
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
        'user1',
        expect.objectContaining({ action: 'search-people', keywords: 'Nicholas Koutsunis engenerate.ai' })
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
      // Both data sources fed into Gemini (per-group dispatch — web and linkedin
      // go to separate parallel calls; assert both contexts surface across calls).
      const allUserMsgs = mockGeminiCreate.mock.calls
        .map(call => (call[0].messages.find((m: any) => m.role === 'user')?.content) || '')
        .join('\n---\n');
      expect(allUserMsgs).toContain('Web search');
      expect(allUserMsgs).toContain('LinkedIn');
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

  // ─── buildFieldGuidance ───────────────────────────────────────────────────

  describe('buildFieldGuidance', () => {
    const buildFieldGuidance = (fields: string[]): string =>
      (CrmEnrichmentService as any).buildFieldGuidance(fields);

    it('should include range estimate guidance for employee fields', () => {
      const guidance = buildFieldGuidance(['employee_count']);
      expect(guidance).toContain('employee_count');
      expect(guidance).toContain('range');
      // LLM is told to return null (not "Unknown") when value is absent
      expect(guidance).toContain('Return null if');
    });

    it('should default to Bootstrapped for funding fields when not found', () => {
      const guidance = buildFieldGuidance(['funding_status']);
      expect(guidance).toContain('funding_status');
      expect(guidance).toContain('Bootstrapped');
    });

    it('should use Not publicly disclosed for revenue fields', () => {
      const guidance = buildFieldGuidance(['annual_revenue']);
      expect(guidance).toContain('Not publicly disclosed');
    });

    it('should use null for missing industry values', () => {
      const guidance = buildFieldGuidance(['industry']);
      expect(guidance).toContain('industry');
      expect(guidance).toContain('Return null');
    });

    it('should handle empty fields list with null fallback string', () => {
      const guidance = buildFieldGuidance([]);
      expect(guidance).toContain('null');
    });

    it('should include guidance for all fields in a mixed list', () => {
      const guidance = buildFieldGuidance(['company_profile', 'employee_count', 'funding_status']);
      expect(guidance).toContain('employee_count');
      expect(guidance).toContain('funding_status');
      expect(guidance).toContain('company_profile');
    });
  });

  // ─── splitFields ─────────────────────────────────────────────────────────

  describe('splitFields', () => {
    const splitFields = (fields: Record<string, string | null>) =>
      (CrmEnrichmentService as any).splitFields(fields);

    it('should map known field names to standard lead fields', () => {
      const { standardUpdates, customUpdates } = splitFields({
        company: 'Acme Corp',
        phone: '555-1234',
        title: 'CTO',
      });
      expect(standardUpdates).toEqual({ company: 'Acme Corp', phone: '555-1234', title: 'CTO' });
      expect(customUpdates).toEqual({});
    });

    it('should map variant field names like company_name, job_title, first_name', () => {
      const { standardUpdates, customUpdates } = splitFields({
        company_name: 'Acme',
        job_title: 'Engineer',
        first_name: 'John',
        last_name: 'Doe',
        linkedin_url: 'https://linkedin.com/in/johndoe',
      });
      expect(standardUpdates).toEqual({
        company: 'Acme',
        title: 'Engineer',
        firstName: 'John',
        lastName: 'Doe',
        linkedin: 'https://linkedin.com/in/johndoe',
      });
      expect(customUpdates).toEqual({});
    });

    it('should put unrecognized fields into customUpdates', () => {
      const { standardUpdates, customUpdates } = splitFields({
        employee_count: '51-200',
        funding_status: 'Series A',
        company: 'Acme',
      });
      expect(standardUpdates).toEqual({ company: 'Acme' });
      expect(customUpdates).toEqual({ employee_count: '51-200', funding_status: 'Series A' });
    });

    it('should handle empty fields object', () => {
      const { standardUpdates, customUpdates } = splitFields({});
      expect(standardUpdates).toEqual({});
      expect(customUpdates).toEqual({});
    });

    it('should exclude null values from standard updates and preserve them in custom updates', () => {
      const { standardUpdates, customUpdates } = splitFields({
        linkedin_url: null,
        company: null,
        employee_count: null,
        title: 'CEO',
      });
      expect(standardUpdates).toEqual({ title: 'CEO' });
      expect(customUpdates).toEqual({ employee_count: null });
    });

    it('should drop empty string values from standard updates', () => {
      const { standardUpdates, customUpdates } = splitFields({
        linkedin_url: '',
        title: 'CTO',
        funding_status: null,
      });
      expect(standardUpdates).toEqual({ title: 'CTO' });
      expect(customUpdates).toEqual({ funding_status: null });
    });

    it('should keep real values even when other fields are null', () => {
      const { standardUpdates, customUpdates } = splitFields({
        linkedin_url: 'https://linkedin.com/in/jane',
        company: null,
        employee_count: '11-50',
      });
      expect(standardUpdates).toEqual({ linkedin: 'https://linkedin.com/in/jane' });
      expect(customUpdates).toEqual({ employee_count: '11-50' });
    });
  });

  // ─── execute - standard field updates ───────────────────────────────────

  describe('execute - standard field mapping', () => {
    it('should update standard lead fields instead of creating custom fields', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', title: '' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Tech company' }] });
      mockGeminiCreate.mockResolvedValue(geminiResponse({
        company: 'Black Tiger',
        title: 'VP Engineering',
        employee_count: '51-200',
      }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find company, title, and employee count',
        outputFields: ['company', 'title', 'employee_count'],
        sources: ['web_search'],
      };

      await service.execute(spec);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.objectContaining({
        company: 'Black Tiger',
        title: 'VP Engineering',
        customFields: expect.objectContaining({ employee_count: '51-200' }),
      }));
      // company and title should NOT be in customFields
      const updateCall = mockCrmDb.updateLead.mock.calls[0][2];
      expect(updateCall.customFields).not.toHaveProperty('company');
      expect(updateCall.customFields).not.toHaveProperty('title');
    });
  });

  // ─── EMAIL DOMAIN FALLBACK ────────────────────────────────────────────────

  describe('execute - email domain fallback when company is empty', () => {
    it('should search using email domain when lead has no company name', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', email: 'reed@blacktiger.tech' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Black Tiger', snippet: '51-200 employees' }] });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ employee_count: '51-200' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find employee count',
        outputFields: ['employee_count'],
        sources: ['web_search'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      // Should search using the email domain, not skip the search
      expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith(
        expect.stringContaining('blacktiger.tech'),
        5,
      );
    });

    it('should skip web search entirely when both company and email are empty', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', email: '' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ employee_count: 'Unknown' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find employee count',
        outputFields: ['employee_count'],
        sources: ['web_search'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      // No search term available — web search should be skipped
      expect(mockAgentModeService.searchWeb).not.toHaveBeenCalled();
    });
  });

  // ─── PERSONAL EMAIL DOMAIN GUARD ─────────────────────────────────────────

  describe('isInstitutionalDomain', () => {
    it('identifies .edu/.gov/.mil', () => {
      expect(CrmEnrichmentService.isInstitutionalDomain('stanford.edu')).toBe(true);
      expect(CrmEnrichmentService.isInstitutionalDomain('whitehouse.gov')).toBe(true);
      expect(CrmEnrichmentService.isInstitutionalDomain('army.mil')).toBe(true);
    });

    it('identifies country-coded academic and gov TLDs', () => {
      expect(CrmEnrichmentService.isInstitutionalDomain('ox.ac.uk')).toBe(true);
      expect(CrmEnrichmentService.isInstitutionalDomain('iitb.ac.in')).toBe(true);
      expect(CrmEnrichmentService.isInstitutionalDomain('cabinetoffice.gov.uk')).toBe(true);
      expect(CrmEnrichmentService.isInstitutionalDomain('education.gob.es')).toBe(true);
    });

    it('does not flag commercial domains', () => {
      expect(CrmEnrichmentService.isInstitutionalDomain('acme.com')).toBe(false);
      expect(CrmEnrichmentService.isInstitutionalDomain('startup.io')).toBe(false);
      expect(CrmEnrichmentService.isInstitutionalDomain('education-startup.com')).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(CrmEnrichmentService.isInstitutionalDomain('')).toBe(false);
    });
  });

  describe('isPersonalEmailDomain', () => {
    it('identifies common personal providers', () => {
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@gmail.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@yahoo.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@hotmail.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@outlook.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@icloud.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@protonmail.com')).toBe(true);
    });

    it('does not flag business domains', () => {
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@acme.com')).toBe(false);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@blacktiger.tech')).toBe(false);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@zime.ai')).toBe(false);
      expect(CrmEnrichmentService.isPersonalEmailDomain('user@theliva.ai')).toBe(false);
    });

    it('handles missing or malformed email gracefully', () => {
      expect(CrmEnrichmentService.isPersonalEmailDomain('')).toBe(false);
      expect(CrmEnrichmentService.isPersonalEmailDomain('nodomain')).toBe(false);
    });

    it('flags institutional domains as personal (skips company-target enrichment)', () => {
      expect(CrmEnrichmentService.isPersonalEmailDomain('jane@stanford.edu')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('john@whitehouse.gov')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('alex@ox.ac.uk')).toBe(true);
    });

    it('flags disposable email domains as personal', () => {
      expect(CrmEnrichmentService.isPersonalEmailDomain('throw@mailinator.com')).toBe(true);
      expect(CrmEnrichmentService.isPersonalEmailDomain('temp@yopmail.com')).toBe(true);
    });
  });

  describe('execute - personal email domain skips company search', () => {
    it('should NOT use gmail.com as a company search term', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', email: 'john@gmail.com' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ employee_count: 'Unknown' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find employee count',
        outputFields: ['employee_count'],
        sources: ['web_search'],
      };

      await service.execute(spec);
      // Web search must NOT be called with a personal domain as the company term
      expect(mockAgentModeService.searchWeb).not.toHaveBeenCalledWith(
        expect.stringContaining('gmail.com'),
        expect.anything(),
      );
    });

    it('should NOT use outlook.com as a company search term', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', email: 'alex@outlook.com' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ employee_count: 'Unknown' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find employee count',
        outputFields: ['employee_count'],
        sources: ['web_search'],
      };

      await service.execute(spec);
      expect(mockAgentModeService.searchWeb).not.toHaveBeenCalledWith(
        expect.stringContaining('outlook.com'),
        expect.anything(),
      );
    });

    it('should still use business domain when company is empty', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [createLead({ leadId: 'lead1', company: '', email: 'reed@blacktiger.tech' })];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Black Tiger', snippet: '51-200 employees' }] });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ employee_count: '51-200' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find employee count',
        outputFields: ['employee_count'],
        sources: ['web_search'],
      };

      await service.execute(spec);
      expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith(
        expect.stringContaining('blacktiger.tech'),
        5,
      );
    });
  });

  // ─── LEAD IDS FILTERING ──────────────────────────────────────────────────

  describe('leadIds filtering', () => {
    it('should only process leads matching the provided leadIds', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1' }),
        createLead({ leadId: 'lead2' }),
        createLead({ leadId: 'lead3' }),
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
        leadIds: ['lead1', 'lead3'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(2);
      expect(mockCrmDb.updateLead).toHaveBeenCalledTimes(2);
      const updatedLeadIds = mockCrmDb.updateLead.mock.calls.map(c => c[1]);
      expect(updatedLeadIds).toContain('lead1');
      expect(updatedLeadIds).toContain('lead3');
      expect(updatedLeadIds).not.toContain('lead2');
    });

    it('should process all leads when leadIds is not provided', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1' }),
        createLead({ leadId: 'lead2' }),
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
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(2);
    });

    it('should return zero results when leadIds match no leads', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1' }),
        createLead({ leadId: 'lead2' }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find industry',
        outputFields: ['industry'],
        sources: ['web_search'],
        leadIds: ['nonexistent-lead'],
      };

      const result = await service.execute(spec);
      expect(result.processedCount).toBe(0);
    });

    it('should apply leadIds filter before field filters', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1', customFields: { status: 'active' } }),
        createLead({ leadId: 'lead2', customFields: { status: 'active' } }),
        createLead({ leadId: 'lead3', customFields: { status: 'inactive' } }),
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
        leadIds: ['lead1', 'lead3'],
        filters: [{ field: 'status', operator: 'equals', value: 'active' }],
      };

      // leadIds narrows to lead1 + lead3, then status filter keeps only lead1
      const result = await service.execute(spec);
      expect(result.processedCount).toBe(1);
      expect(mockCrmDb.updateLead).toHaveBeenCalledWith('list1', 'lead1', expect.anything());
    });

    it('should preview correctly with leadIds filter', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      const leads = [
        createLead({ leadId: 'lead1' }),
        createLead({ leadId: 'lead2' }),
        createLead({ leadId: 'lead3', customFields: { industry: 'Finance' } }),
      ];
      mockCrmDb.getLeadsByListId.mockResolvedValue({ items: leads, lastEvaluatedKey: null, hasMore: false });

      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockAgentModeService.searchWeb
        .mockResolvedValue({ success: true, results: [{ title: 'Acme', snippet: 'Company' }] });

      const spec: EnrichmentJobSpec = {
        listId: 'list1',
        userId: 'user1',
        instruction: 'Find industry',
        outputFields: ['industry'],
        sources: ['web_search'],
        leadIds: ['lead1'],
      };

      const result = await service.preview(spec);
      expect(result.totalLeads).toBe(1); // only lead1 selected via leadIds
      expect(result.leadsToProcess).toBe(1); // only lead1, which has no industry
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

  // ─── SITE-WIDE UNIPILE ACCOUNT FALLBACK ─────────────────────────────────

  describe('site-wide Unipile account fallback', () => {
    it('should return null when no user account AND no site-wide setting', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockSettingsService.getSetting.mockResolvedValue(null);

      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1', userId: 'user1',
        instruction: 'Determine industry', outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      const result = await service.execute(spec);
      expect(result.warnings).toContain('No LinkedIn (Unipile) account connected — linkedin source skipped');
    });

    it('should return null when all site-wide accounts are disabled', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'sw1', enabled: false }]),
        updatedAt: '', updatedBy: '',
      });

      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1', userId: 'user1',
        instruction: 'Determine industry', outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      const result = await service.execute(spec);
      expect(result.warnings).toContain('No LinkedIn (Unipile) account connected — linkedin source skipped');
    });

    it('should handle malformed site-wide settings JSON gracefully', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: 'not-valid-json',
        updatedAt: '', updatedBy: '',
      });

      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1' })],
        lastEvaluatedKey: null, hasMore: false,
      });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1', userId: 'user1',
        instruction: 'Determine industry', outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      const result = await service.execute(spec);
      expect(result.warnings).toContain('No LinkedIn (Unipile) account connected — linkedin source skipped');
    });

    it('should prefer user own account over site-wide', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'user-acc', account_name: 'My LinkedIn', config: {} as any, created_at: '', updated_at: '' },
      ]);
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'sw-acc', enabled: true }]),
        updatedAt: '', updatedBy: '',
      });

      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1', linkedin: 'https://linkedin.com/in/johndoe' })],
        lastEvaluatedKey: null, hasMore: false,
      });
      mockAgentModeService.linkedinOutreach.mockResolvedValue({ success: true, data: { headline: 'CEO' } });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1', userId: 'user1',
        instruction: 'Determine industry', outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      await service.execute(spec);
      // Should use user's own account, not site-wide
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
        'user1',
        expect.objectContaining({ account_id: 'user-acc' }),
      );
    });

    it('should fall back to site-wide account when user has no Unipile account', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: 'site-wide-unipile-accounts',
        settingValue: JSON.stringify([{ account_id: 'sw-acc', enabled: true }]),
        updatedAt: '', updatedBy: '',
      });

      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
      mockCrmDb.getLeadsByListId.mockResolvedValue({
        items: [createLead({ leadId: 'lead1', linkedin: 'https://linkedin.com/in/johndoe' })],
        lastEvaluatedKey: null, hasMore: false,
      });
      mockAgentModeService.linkedinOutreach.mockResolvedValue({ success: true, data: { headline: 'CEO' } });
      mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'Tech' }));
      mockCrmDb.updateLead.mockResolvedValue({} as any);
      mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

      const spec: EnrichmentJobSpec = {
        listId: 'list1', userId: 'user1',
        instruction: 'Determine industry', outputFields: ['industry'],
        sources: ['linkedin', 'existing_data'],
      };

      const result = await service.execute(spec);
      // Should NOT have the warning since site-wide account is available
      expect(result.warnings || []).not.toContain('No LinkedIn (Unipile) account connected — linkedin source skipped');
      // Should have used the site-wide account
      expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
        'user1',
        expect.objectContaining({ account_id: 'sw-acc' }),
      );
    });
  });
});

// ─── applySearchTemplate ─────────────────────────────────────────────────────

describe('CrmEnrichmentService.applySearchTemplate', () => {
  const lead = {
    leadId: 'test',
    firstName: 'John',
    lastName: 'Doe',
    company: 'Acme Corp',
    email: 'john@acme.com',
    title: 'CEO',
    linkedin: 'https://www.linkedin.com/in/johndoe',
    customFields: { industry: 'SaaS' },
  };

  it('substitutes all standard placeholders', () => {
    const template = '{{firstName}} {{lastName}} {{company}} {{email}} {{title}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, lead))
      .toBe('John Doe Acme Corp john@acme.com CEO');
  });

  it('derives emailDomain from email', () => {
    const template = '{{company}} {{emailDomain}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, lead)).toBe('Acme Corp acme.com');
  });

  it('substitutes customFields placeholder', () => {
    const template = '{{company}} {{customFields.industry}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, lead)).toBe('Acme Corp SaaS');
  });

  it('collapses multiple spaces when a field is empty', () => {
    const emptyLead = { leadId: 'test', company: 'Beta Inc', email: 'test@beta.com' };
    const template = '{{firstName}} {{lastName}} {{company}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, emptyLead)).toBe('Beta Inc');
  });

  it('handles lead with no email gracefully for emailDomain', () => {
    const noEmailLead = { leadId: 'test', company: 'Gamma' };
    const template = '{{company}} {{emailDomain}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, noEmailLead)).toBe('Gamma');
  });

  it('handles missing customFields key gracefully', () => {
    const template = '{{company}} {{customFields.missing_field}}';
    expect(CrmEnrichmentService.applySearchTemplate(template, lead)).toBe('Acme Corp');
  });
});

// ─── templateHasNoLeadSignal ─────────────────────────────────────────────────

describe('CrmEnrichmentService.templateHasNoLeadSignal', () => {
  it('returns true when emailDomain placeholder resolves to empty (no email on lead)', () => {
    const template = '{{emailDomain}} company overview';
    const lead = { leadId: 'l1', linkedin: 'https://www.linkedin.com/in/foo' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(true);
  });

  it('returns false when emailDomain resolves to a real domain', () => {
    const template = '{{emailDomain}} company overview';
    const lead = { leadId: 'l1', email: 'jane@acme.com' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(false);
  });

  it('returns true when template references {{company}} but lead has only email (placeholder unfilled)', () => {
    const template = '{{company}} funding investors';
    const lead = { leadId: 'l1', email: 'jane@acme.com' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(true);
  });

  it('returns false when {{firstName}} {{lastName}} both populated', () => {
    const template = '{{firstName}} {{lastName}} linkedin';
    const lead = { leadId: 'l1', firstName: 'Jane', lastName: 'Doe' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(false);
  });

  it('returns true for a literal template with no placeholders (constant query)', () => {
    const template = 'company overview';
    const lead = { leadId: 'l1', email: 'jane@acme.com', company: 'Acme' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(true);
  });

  it('returns true when {{customFields.foo}} is the only placeholder and not present', () => {
    const template = '{{customFields.industry}} sector';
    const lead = { leadId: 'l1', customFields: {} };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(true);
  });

  it('returns false when at least one placeholder is filled even if others are empty', () => {
    const template = '{{firstName}} {{lastName}} {{emailDomain}}';
    const lead = { leadId: 'l1', firstName: 'Jane' };
    expect(CrmEnrichmentService.templateHasNoLeadSignal(template, lead)).toBe(false);
  });
});

// ─── Search grouping / deduplication ─────────────────────────────────────────

describe('CrmEnrichmentService search grouping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Result', snippet: 'info', url: 'https://example.com' }],
    });
  });

  it('calls searchWeb exactly once even when multiple web_search fields are provided', async () => {
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({ funding_stage: 'Seed', employee_count: '11-50' })
    );
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'list_g1', userId: 'user1', fieldNames: [],
      searchQueryTemplates: {
        funding_stage: '{{company}} funding rounds',
        employee_count: '{{company}} funding rounds',
      },
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead_g1', company: 'Acme Corp' })],
      lastEvaluatedKey: null,
    } as any);

    const service = new CrmEnrichmentService();
    await service.execute({
      listId: 'list_g1', userId: 'user1',
      instruction: 'test', outputFields: ['funding_stage', 'employee_count'],
      sources: ['web_search'],
    });

    expect(mockAgentModeService.searchWeb).toHaveBeenCalledTimes(1);
  });

  it('uses webSearchTemplate from spec to build the single query', async () => {
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({ linkedin_url: 'https://linkedin.com/in/x', tech_stack: 'React' })
    );
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'list_g2', userId: 'user1', fieldNames: [],
      searchQueryTemplates: {
        linkedin_url: '{{firstName}} {{lastName}} {{company}} linkedin',
        tech_stack: '{{company}} technology stack',
      },
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead_g2', firstName: 'Jane', lastName: 'Smith', company: 'Beta Inc' })],
      lastEvaluatedKey: null,
    } as any);

    const service = new CrmEnrichmentService();
    await service.execute({
      listId: 'list_g2', userId: 'user1',
      instruction: 'test', outputFields: ['linkedin_url', 'tech_stack'],
      sources: ['web_search'],
      webSearchTemplate: '{{firstName}} {{lastName}} {{company}} linkedin',
    });

    expect(mockAgentModeService.searchWeb).toHaveBeenCalledTimes(1);
    expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith('Jane Smith Beta Inc linkedin', 5);
  });
});

// ─── Template fallback chain ──────────────────────────────────────────────────

describe('CrmEnrichmentService template fallback chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
    mockAgentModeService.searchWeb.mockResolvedValue({ success: true, results: [] });
  });

  it('runtime spec webSearchTemplate overrides stored template', async () => {
    mockGeminiCreate.mockResolvedValue(geminiResponse({ funding_stage: 'Bootstrapped' }));
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'list_f1', userId: 'user1', fieldNames: [],
      webSearchTemplate: '{{company}} stored template',
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead_f1', company: 'Delta Corp' })],
      lastEvaluatedKey: null,
    } as any);

    const service = new CrmEnrichmentService();
    await service.execute({
      listId: 'list_f1', userId: 'user1',
      instruction: 'test', outputFields: ['funding_stage'],
      sources: ['web_search'],
      webSearchTemplate: '{{company}} runtime override',
    });

    expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith('Delta Corp runtime override', 5);
  });

  it('stored webSearchTemplate is used when spec provides none', async () => {
    mockGeminiCreate.mockResolvedValue(geminiResponse({ funding_stage: 'Series A' }));
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'list_f2', userId: 'user1', fieldNames: [],
      webSearchTemplate: '{{company}} funding crunchbase',
    } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead_f2', company: 'Epsilon Ltd' })],
      lastEvaluatedKey: null,
    } as any);

    const service = new CrmEnrichmentService();
    await service.execute({
      listId: 'list_f2', userId: 'user1',
      instruction: 'test', outputFields: ['funding_stage'],
      sources: ['web_search'],
    });

    expect(mockAgentModeService.searchWeb).toHaveBeenCalledWith('Epsilon Ltd funding crunchbase', 5);
  });
});

// ─── suggestEnrichment ────────────────────────────────────────────────────────

describe('CrmEnrichmentService.suggestEnrichment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns instruction, outputFields, webSearchTemplate, and sources', async () => {
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        instruction: 'Find funding info.',
        outputFields: ['funding_stage', 'funding_amount'],
        webSearchTemplate: '{{company}} funding rounds investors',
        sources: ['web_search'],
      }) } }],
    });

    const result = await CrmEnrichmentService.suggestEnrichment('find funding info');

    expect(result.instruction).toBe('Find funding info.');
    expect(result.outputFields).toEqual(['funding_stage', 'funding_amount']);
    expect(result.webSearchTemplate).toBe('{{company}} funding rounds investors');
    expect(result.sources).toEqual(['web_search']);
  });

  it('normalizes outputFields to snake_case', async () => {
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        instruction: 'test',
        outputFields: ['Employee Count', 'techStack', 'Funding Stage'],
        searchQueryTemplates: {},
        sources: ['web_search'],
      }) } }],
    });

    const result = await CrmEnrichmentService.suggestEnrichment('test');
    expect(result.outputFields).toEqual(['employee_count', 'techstack', 'funding_stage']);
  });

  it('auto-saves config to list when listId is provided', async () => {
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        instruction: 'test',
        outputFields: ['funding_stage'],
        webSearchTemplate: '{{company}} funding investors',
        sources: ['web_search'],
      }) } }],
    });
    mockCrmDb.updateSearchQueryTemplates.mockResolvedValue({} as any);

    await CrmEnrichmentService.suggestEnrichment('test', { listId: 'list_s1' });

    expect(mockCrmDb.updateSearchQueryTemplates).toHaveBeenCalledWith(
      'list_s1', {}, undefined, 'test', ['funding_stage'],
      '{{company}} funding investors', undefined, ['web_search'], undefined
    );
  });

  it('saves sourcesPerField when LLM returns it', async () => {
    const sourcesPerField = { linkedin_url: ['linkedin'], company_info: ['web_search'] };
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        instruction: 'test',
        outputFields: ['linkedin_url', 'company_info'],
        webSearchTemplate: '{{company}} overview',
        linkedinSearchTemplate: '{{firstName}} {{lastName}} {{company}}',
        sourcesPerField,
        sources: ['web_search', 'linkedin'],
      }) } }],
    });
    mockCrmDb.updateSearchQueryTemplates.mockResolvedValue({} as any);

    const result = await CrmEnrichmentService.suggestEnrichment('test', { listId: 'list_s2' });

    expect(result.sourcesPerField).toEqual(sourcesPerField);
    expect(mockCrmDb.updateSearchQueryTemplates).toHaveBeenCalledWith(
      'list_s2', {}, sourcesPerField, 'test', ['linkedin_url', 'company_info'],
      '{{company}} overview', '{{firstName}} {{lastName}} {{company}}', ['linkedin', 'web_search'], undefined
    );
  });

  it('does NOT save templates when no listId provided', async () => {
    mockGeminiCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        instruction: 'test',
        outputFields: ['tech_stack'],
        searchQueryTemplates: { tech_stack: '{{company}} tech' },
        sources: ['web_search'],
      }) } }],
    });

    await CrmEnrichmentService.suggestEnrichment('find tech stack');

    expect(mockCrmDb.updateSearchQueryTemplates).not.toHaveBeenCalled();
  });

  it('falls back gracefully when LLM throws', async () => {
    mockGeminiCreate.mockRejectedValue(new Error('LLM unavailable'));

    const result = await CrmEnrichmentService.suggestEnrichment('find tech stack');

    expect(result.instruction).toBe('find tech stack');
    expect(result.outputFields).toEqual([]);
    expect(result.webSearchTemplate).toBe('');
    expect(result.sources).toEqual(['web_search']);
  });

  it('includes existing fields context in user prompt', async () => {
    let capturedMessages: any[] = [];
    mockGeminiCreate.mockImplementation(({ messages }: any) => {
      capturedMessages = messages;
      return Promise.resolve({
        choices: [{ message: { content: JSON.stringify({
          instruction: 'test',
          outputFields: ['tech_stack'],
          searchQueryTemplates: {},
          sources: ['web_search'],
        }) } }],
      });
    });

    await CrmEnrichmentService.suggestEnrichment('find tech stack', {
      existingStandardFields: ['email', 'company'],
      existingCustomFields: ['funding_stage'],
    });

    const userMsg = capturedMessages.find((m: any) => m.role === 'user')?.content || '';
    expect(userMsg).toContain('email, company');
    expect(userMsg).toContain('funding_stage');
  });
});

// ─── buildFieldGuidance — company vs personal LinkedIn ────────────────────────

describe('CrmEnrichmentService.buildFieldGuidance — LinkedIn field types', () => {
  const buildFieldGuidance = (fields: string[]): string =>
    (CrmEnrichmentService as any).buildFieldGuidance(fields);

  it('should return company page (/company/) guidance for company_linkedin_url', () => {
    const guidance = buildFieldGuidance(['company_linkedin_url']);
    expect(guidance).toContain('/company/');
    // Must NOT tell the LLM to look for /in/ URLs for a company page field
    expect(guidance).not.toContain('/in/');
  });

  it('should return personal profile (/in/) guidance for personal_linkedin_url', () => {
    const guidance = buildFieldGuidance(['personal_linkedin_url']);
    expect(guidance).toContain('/in/');
    expect(guidance).not.toContain('/company/');
  });

  it('should return personal profile (/in/) guidance for lead_linkedin_url', () => {
    const guidance = buildFieldGuidance(['lead_linkedin_url']);
    expect(guidance).toContain('/in/');
    expect(guidance).not.toContain('/company/');
  });

  it('should return company page guidance for company_linkedin (no _url suffix)', () => {
    const guidance = buildFieldGuidance(['company_linkedin']);
    expect(guidance).toContain('/company/');
    expect(guidance).not.toContain('/in/');
  });

  it('should return both /company/ and /in/ when both field types appear in a mixed list', () => {
    const guidance = buildFieldGuidance(['company_linkedin_url', 'personal_linkedin_url']);
    expect(guidance).toContain('/company/');
    expect(guidance).toContain('/in/');
  });
});

// ─── buildSearchQuery — company LinkedIn suffix ───────────────────────────────

describe('CrmEnrichmentService.buildSearchQuery (private static)', () => {
  const buildSearchQuery = (lead: any, outputFields: string[]): string =>
    (CrmEnrichmentService as any).buildSearchQuery(lead, outputFields);

  it('includes "linkedin" in query for company_linkedin_url field', () => {
    const lead = { leadId: 'test', company: 'Acme Corp', email: 'john@acme.com' };
    const query = buildSearchQuery(lead, ['company_linkedin_url']);
    expect(query).toContain('Acme Corp');
    expect(query.toLowerCase()).toContain('linkedin');
  });

  it('does NOT treat company_linkedin_url as a person-level field', () => {
    // Should NOT prefix with firstName/lastName for company LinkedIn
    const lead = { leadId: 'test', firstName: 'John', lastName: 'Doe', company: 'Acme Corp', email: 'john@acme.com' };
    const query = buildSearchQuery(lead, ['company_linkedin_url']);
    // Person-name prefix should not appear for a company-level query
    expect(query).not.toMatch(/^John Doe/);
    expect(query).toContain('Acme Corp');
  });

  it('generates person-based query for personal_linkedin_url field', () => {
    const lead = { leadId: 'test', firstName: 'John', lastName: 'Doe', company: 'Acme Corp', email: 'john@acme.com' };
    const query = buildSearchQuery(lead, ['personal_linkedin_url']);
    expect(query).toContain('John Doe');
    expect(query.toLowerCase()).toContain('linkedin');
  });
});

// ─── Enrichment History Snapshot Tests ───────────────────────────────────────

describe('CrmEnrichmentService - enrichment history snapshot', () => {
  let service: CrmEnrichmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.createEnrichmentSnapshotItem.mockResolvedValue(undefined);
    mockCrmDb.createEnrichmentJobMeta.mockResolvedValue(undefined);
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
    mockSettingsService.getSetting.mockResolvedValue(null);
  });

  // FAIL test 1: snapshot is NOT written when lead enrichment fails
  it('should NOT call createEnrichmentSnapshotItem for failed leads', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-fail' })],
      lastEvaluatedKey: null, hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({ success: false, error: 'Network error' });

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Find company size',
      outputFields: ['company_size'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.failedCount).toBe(1);
    expect(mockCrmDb.createEnrichmentSnapshotItem).not.toHaveBeenCalled();
  });

  // FAIL test 2: snapshot previousCustomFields contains ONLY outputFields, not unrelated fields
  it('should snapshot only outputFields values, not unrelated customFields', async () => {
    const lead = createLead({
      leadId: 'lead-1',
      customFields: { industry: 'SaaS', unrelated_field: 'should-not-be-snapshotted' },
    });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [lead], lastEvaluatedKey: null, hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true, results: [{ title: 'Acme', snippet: 'SaaS company' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'FinTech' }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Find industry',
      outputFields: ['industry'],
      sources: ['web_search'],
      forceOverwrite: true,
    };

    await service.execute(spec);

    expect(mockCrmDb.createEnrichmentSnapshotItem).toHaveBeenCalledTimes(1);
    const snapshotCall = mockCrmDb.createEnrichmentSnapshotItem.mock.calls[0][0];
    expect(snapshotCall.previousCustomFields).toHaveProperty('industry', 'SaaS');
    expect(snapshotCall.previousCustomFields).not.toHaveProperty('unrelated_field');
  });

  // FAIL test 3: job meta NOT written when leadsToProcess is empty
  it('should NOT call createEnrichmentJobMeta when there are no leads to process', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [], lastEvaluatedKey: null, hasMore: false,
    });

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Find industry',
      outputFields: ['industry'],
      sources: ['web_search'],
    };

    await service.execute(spec);
    expect(mockCrmDb.createEnrichmentJobMeta).not.toHaveBeenCalled();
  });

  // B1/B4 — snapshot previousEnrichmentMetadata keyed by original snake_case (not mapped camelCase)
  it('snapshots previousEnrichmentMetadata under original field name (first_name not firstName)', async () => {
    const existingMeta = { source: 'web_search', enrichedAt: '2025-01-01T00:00:00Z' };
    const lead = createLead({
      leadId: 'lead-b1',
      firstName: 'OldFirst',
      enrichmentMetadata: { first_name: existingMeta },
      customFields: {},
    });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [lead], lastEvaluatedKey: null, hasMore: false });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true, results: [{ title: 'John Doe', snippet: 'Person profile' }],
    });
    // LLM returns first_name (original key) — STANDARD_FIELD_MAP maps it to firstName
    mockGeminiCreate.mockResolvedValue(geminiResponse({ first_name: 'NewFirst' }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Find first name',
      outputFields: ['first_name'],
      sources: ['web_search'],
      forceOverwrite: true,
    };

    await service.execute(spec);

    const snapshotCall = mockCrmDb.createEnrichmentSnapshotItem.mock.calls[0][0];
    // Key must be 'first_name' (original) not 'firstName' (mapped) so revert delete is not a no-op
    expect(snapshotCall.previousEnrichmentMetadata).toHaveProperty('first_name', existingMeta);
    expect(snapshotCall.previousEnrichmentMetadata).not.toHaveProperty('firstName');
  });

  // SUCCESS test: snapshot captures correct previous value before updateLead overwrites it
  it('should snapshot the existing field value before it is overwritten by enrichment', async () => {
    const lead = createLead({
      leadId: 'lead-1',
      customFields: { industry: 'SaaS' },
    });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [lead], lastEvaluatedKey: null, hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true, results: [{ title: 'Acme', snippet: 'FinTech company' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ industry: 'FinTech' }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Update industry',
      outputFields: ['industry'],
      sources: ['web_search'],
      forceOverwrite: true,
    };

    await service.execute(spec);

    expect(mockCrmDb.createEnrichmentSnapshotItem).toHaveBeenCalledTimes(1);
    const snapshotCall = mockCrmDb.createEnrichmentSnapshotItem.mock.calls[0][0];
    // Previous value should be captured BEFORE updateLead is called
    expect(snapshotCall.previousCustomFields).toEqual({ industry: 'SaaS' });
    expect(snapshotCall.leadId).toBe('lead-1');
    expect(snapshotCall.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  // FAIL test 4: snapshot stores null for a field not yet on the lead
  it('should store null in snapshot for outputFields not present on lead', async () => {
    const lead = createLead({ leadId: 'lead-1', customFields: {} });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [lead], lastEvaluatedKey: null, hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true, results: [{ title: 'Acme', snippet: 'Tech company' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack: 'React, Node.js' }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Find tech stack',
      outputFields: ['tech_stack'],
      sources: ['web_search'],
    };

    await service.execute(spec);

    expect(mockCrmDb.createEnrichmentSnapshotItem).toHaveBeenCalledTimes(1);
    const snapshotCall = mockCrmDb.createEnrichmentSnapshotItem.mock.calls[0][0];
    expect(snapshotCall.previousCustomFields).toEqual({ tech_stack: null });
  });

  // FAIL test 5: createEnrichmentJobMeta called with correct outputFields
  it('should call createEnrichmentJobMeta with correct listId, userId, and outputFields', async () => {
    const lead = createLead({ leadId: 'lead-1', customFields: {} });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [lead], lastEvaluatedKey: null, hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true, results: [{ title: 'Acme', snippet: 'Tech company' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack: 'React' }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user42',
      instruction: 'Find tech stack',
      outputFields: ['tech_stack'],
      sources: ['web_search'],
    };

    await service.execute(spec);

    expect(mockCrmDb.createEnrichmentJobMeta).toHaveBeenCalledTimes(1);
    const metaCall = mockCrmDb.createEnrichmentJobMeta.mock.calls[0][0];
    expect(metaCall.listId).toBe('list1');
    expect(metaCall.userId).toBe('user42');
    expect(metaCall.outputFields).toEqual(['tech_stack']);
    expect(metaCall.status).toBe('completed');
    expect(metaCall.processedCount).toBe(1);
  });
});

// ─── Enrichment Revert Tests ──────────────────────────────────────────────────

describe('CrmEnrichmentService - revertJob', () => {
  let service: CrmEnrichmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockSettingsService.getSetting.mockResolvedValue(null);
  });

  // FAIL test 6: revert on already-undone job returns error
  it('should throw when reverting an already-undone job', async () => {
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([]);
    // Simulate job meta being returned with status 'undone' — no snapshots remain
    // The service should detect there is nothing to revert (0 snapshots) and throw
    await expect(service.revertJob('job-xyz', 'list1')).rejects.toThrow();
  });

  // FAIL test 7: getLeadById returning null counts as failed, not thrown
  it('should count lead as failed (not throw) when getLeadById returns null', async () => {
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([
      {
        jobId: 'job-1', leadId: 'lead-missing',
        previousCustomFields: { industry: 'SaaS' },
        previousStandardFields: {},
      },
    ]);
    mockCrmDb.getLeadById.mockResolvedValue(null);

    const result = await service.revertJob('job-1', 'list1');
    expect(result.failedCount).toBe(1);
    expect(result.revertedCount).toBe(0);
  });

  // FAIL test 8: mismatched listId — verifying snapshots belong to correct list
  it('should return zero revertedCount when no snapshots exist for jobId', async () => {
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([]);

    await expect(service.revertJob('job-unknown', 'list1')).rejects.toThrow();
  });

  // SUCCESS test: revert merges snapshot into current lead, preserving new columns
  it('should restore enriched fields while preserving columns added after enrichment', async () => {
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([
      {
        jobId: 'job-1', leadId: 'lead-1',
        previousCustomFields: { industry: 'SaaS', tech_stack: null },
        previousStandardFields: {},
      },
    ]);
    // Current lead has a new column 'phone' added after enrichment
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', listId: 'list1',
      customFields: { industry: 'FinTech', tech_stack: 'React', phone: '123-456' },
    });

    const result = await service.revertJob('job-1', 'list1');

    expect(result.revertedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const updatedCustomFields = updateCall[2].customFields as Record<string, any>;
    // Enriched fields restored to pre-enrichment values
    expect(updatedCustomFields['industry']).toBe('SaaS');
    // tech_stack was null before enrichment → should be removed (not present)
    expect(updatedCustomFields).not.toHaveProperty('tech_stack');
    // New column added after enrichment must be preserved
    expect(updatedCustomFields['phone']).toBe('123-456');
  });
});

// ─── Revert metadata restoration tests ──────────────────────────────────────
//
// The revert logic at crmEnrichmentService.ts:2223-2230 merges
// snapshot.previousEnrichmentMetadata back into the current lead's
// enrichmentMetadata. Null entries mean "this key didn't exist before
// enrichment" and must be DELETED; non-null entries must be restored.

describe('CrmEnrichmentService - revertJob enrichmentMetadata restoration', () => {
  let service: CrmEnrichmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockSettingsService.getSetting.mockResolvedValue(null);
  });

  // FAIL: snapshot has previousEnrichmentMetadata with a non-null entry —
  // updateLead must be called with that metadata restored.
  it('restores non-null previousEnrichmentMetadata entry in updateLead call', async () => {
    const prevMeta = { provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' };
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([
      {
        jobId: 'job-meta-1',
        leadId: 'lead-meta-1',
        previousCustomFields: {},
        previousStandardFields: {},
        previousEnrichmentMetadata: { company_name: prevMeta },
      },
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-meta-1',
      listId: 'list1',
      customFields: {},
      enrichmentMetadata: { company_name: { provider: 'enrich.so', enrichedAt: '2026-06-01T00:00:00Z' } },
    });

    const result = await service.revertJob('job-meta-1', 'list1');

    expect(result.revertedCount).toBe(1);
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const updatedMeta = (updateCall[2] as any).enrichmentMetadata as Record<string, any>;
    expect(updatedMeta['company_name']).toEqual(prevMeta);
  });

  // FAIL: snapshot has previousEnrichmentMetadata = { company_name: null } —
  // that key must be removed (not present) in the updateLead call.
  it('removes enrichmentMetadata key when previousEnrichmentMetadata entry is null', async () => {
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([
      {
        jobId: 'job-meta-2',
        leadId: 'lead-meta-2',
        previousCustomFields: {},
        previousStandardFields: {},
        previousEnrichmentMetadata: { company_name: null },
      },
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-meta-2',
      listId: 'list1',
      customFields: {},
      enrichmentMetadata: { company_name: { provider: 'apollo', enrichedAt: '2026-06-01T00:00:00Z' } },
    });

    const result = await service.revertJob('job-meta-2', 'list1');

    expect(result.revertedCount).toBe(1);
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const updatedMeta = (updateCall[2] as any).enrichmentMetadata as Record<string, any>;
    expect(updatedMeta).not.toHaveProperty('company_name');
  });

  // SUCCESS: full round-trip — snapshot has both null and non-null entries —
  // verify correct merge (null → remove, non-null → restore).
  it('correctly merges mixed null/non-null previousEnrichmentMetadata in one revert', async () => {
    const titlePrevMeta = { provider: 'apollo', enrichedAt: '2026-01-15T00:00:00Z' };
    mockCrmDb.getEnrichmentSnapshotsByJobId.mockResolvedValue([
      {
        jobId: 'job-meta-3',
        leadId: 'lead-meta-3',
        previousCustomFields: {},
        previousStandardFields: {},
        previousEnrichmentMetadata: {
          title: titlePrevMeta,       // non-null → restore
          company_name: null,         // null → remove
        },
      },
    ]);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-meta-3',
      listId: 'list1',
      customFields: {},
      enrichmentMetadata: {
        title: { provider: 'enrich.so', enrichedAt: '2026-06-01T00:00:00Z' },
        company_name: { provider: 'apollo', enrichedAt: '2026-06-01T00:00:00Z' },
        // hq_location was NOT in the snapshot → must remain untouched
        hq_location: { provider: 'web_search', enrichedAt: '2026-06-01T00:00:00Z' },
      },
    });

    const result = await service.revertJob('job-meta-3', 'list1');

    expect(result.revertedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const updatedMeta = (updateCall[2] as any).enrichmentMetadata as Record<string, any>;
    // restored
    expect(updatedMeta['title']).toEqual(titlePrevMeta);
    // removed
    expect(updatedMeta).not.toHaveProperty('company_name');
    // untouched (not in snapshot)
    expect(updatedMeta['hq_location']).toBeDefined();
  });
});

// ─── Citation Verification ────────────────────────────────────────────────────
//
// LLM extraction now returns a rich format per field:
//   { value: "...", sourceQuote: "...", sourceUrl: "...", confidence: "high|medium|low" }
//
// After parsing, we verify the sourceQuote appears (substring, case-insensitive,
// whitespace-collapsed) inside the web/linkedin source context. Unsupported claims
// are dropped to null. Legacy flat-string responses are kept as-is for back-compat.

describe('CrmEnrichmentService - citation verification', () => {
  let service: CrmEnrichmentService;

  // Each test exercises the full enrichment pipeline (cluster grouping,
  // multi-LLM extraction, critic pass), which can exceed Jest's 5s default
  // when CI workers are saturated.
  jest.setTimeout(20000);

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.createEnrichmentSnapshotItem.mockResolvedValue(undefined);
    mockCrmDb.createEnrichmentJobMeta.mockResolvedValue(undefined);
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
  });

  function setupSingleLeadJob(searchSnippet: string) {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead1' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', url: 'https://acme.com', snippet: searchSnippet }],
    });
  }

  function lastUpdateCustomFields(): Record<string, any> {
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    return (updateCall[2] as any).customFields || {};
  }

  it('keeps a value when sourceQuote appears verbatim in the web context', async () => {
    setupSingleLeadJob('Acme is a Series B startup with 200 employees');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        funding_stage: {
          value: 'Series B',
          sourceQuote: 'Series B startup',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().funding_stage).toBe('Series B');
  });

  it('rejects (removes) a value when sourceQuote is not found in any source', async () => {
    setupSingleLeadJob('Acme is an early-stage startup');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        funding_stage: {
          value: 'Series B',
          sourceQuote: 'raised $100M Series B',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().funding_stage).toBeUndefined();
  });

  it('rejects a value when rich-format response omits sourceQuote', async () => {
    setupSingleLeadJob('Acme is a Series B startup');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        funding_stage: { value: 'Series B', confidence: 'high' },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().funding_stage).toBeUndefined();
  });

  it('keeps a value from a legacy flat-string LLM response (backwards compat)', async () => {
    setupSingleLeadJob('Acme is a Series B startup');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({ funding_stage: 'Series B' })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().funding_stage).toBe('Series B');
  });

  it('matches sourceQuote case-insensitively', async () => {
    setupSingleLeadJob('Acme operates in the FinTech sector');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        industry: {
          value: 'FinTech',
          sourceQuote: 'FINTECH SECTOR',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get industry',
      outputFields: ['industry'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().industry).toBe('FinTech');
  });

  it('matches sourceQuote with whitespace collapsed', async () => {
    setupSingleLeadJob('Founded in 2018, Acme employs 200 people');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        founded_year: {
          value: '2018',
          // Multi-line / multi-space quote — should match the source after whitespace collapse
          sourceQuote: 'Founded\n  in   2018',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get founded year',
      outputFields: ['founded_year'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    expect(lastUpdateCustomFields().founded_year).toBe('2018');
  });

  it('preserves existing LinkedIn slug-validation behavior (rejects URL whose slug is not in source)', async () => {
    setupSingleLeadJob('Acme is a Series B startup');
    // Hallucinated LinkedIn URL — slug "fake-slug-not-anywhere" is not in any source
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        company_linkedin_url: {
          value: 'https://www.linkedin.com/company/fake-slug-not-anywhere',
          sourceQuote: 'Acme is a Series B startup',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get LinkedIn',
      outputFields: ['company_linkedin_url'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    // Even though the quote is in source, the slug-check should still reject the URL
    expect(lastUpdateCustomFields().company_linkedin_url).toBeUndefined();
  });

  it('persists enrichmentMetadata sidecar with source, sourceUrl, sourceQuote, confidence, jobId, enrichedAt', async () => {
    setupSingleLeadJob('Acme is a Series B startup with 200 employees');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        funding_stage: {
          value: 'Series B',
          sourceQuote: 'Series B startup',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    await service.execute(spec);
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const meta = (updateCall[2] as any).enrichmentMetadata;
    expect(meta).toBeDefined();
    expect(meta.funding_stage).toMatchObject({
      source: 'web_search',
      sourceQuote: 'Series B startup',
      sourceUrl: 'https://acme.com',
      confidence: 'high',
    });
    expect(meta.funding_stage.enrichedJobId).toEqual(expect.any(String));
    expect(meta.funding_stage.enrichedAt).toEqual(expect.any(String));
  });

  it('drops stale enrichmentMetadata when forceOverwrite clears a field to null', async () => {
    // Simulate: lead already has industry="Tech" with metadata from a prior run.
    // forceOverwrite re-runs enrichment; new LLM extraction finds nothing → field cleared.
    // The stale metadata for that field MUST be removed (otherwise UI shows empty
    // value with source/quote/confidence still attached, which is confusing).
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({
        leadId: 'lead1',
        customFields: { industry: 'Tech' },
        enrichmentMetadata: {
          industry: {
            source: 'web_search',
            sourceQuote: 'old quote',
            confidence: 'high',
            enrichedAt: '2026-01-01T00:00:00Z',
            enrichedJobId: 'old-job',
          },
          other_field: { source: 'web_search', enrichedAt: '2026-01-01T00:00:00Z' },
        },
      })],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', url: 'https://acme.com', snippet: 'no industry info here' }],
    });
    // LLM returns null for industry (rich format) → verifyCitations rejects → null
    mockGeminiCreate.mockResolvedValue(geminiResponse({
      industry: { value: null, sourceQuote: null, confidence: 'low' },
    }));
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get industry',
      outputFields: ['industry'],
      sources: ['web_search'],
      forceOverwrite: true,
    };

    await service.execute(spec);
    const setCall = mockCrmDb.setLeadFields.mock.calls[0];
    const options = setCall[2] as any;
    // Cleared field should be removed from both maps via targeted REMOVE lists.
    expect(options.removeCustomFieldKeys).toContain('industry');
    expect(options.removeEnrichmentMetadataKeys).toContain('industry');
  });

  it('omits enrichmentMetadata for null/rejected fields', async () => {
    setupSingleLeadJob('Acme is an early-stage startup');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        funding_stage: {
          value: 'Series B',
          sourceQuote: 'raised $100M Series B',  // not in source → rejected
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get funding stage',
      outputFields: ['funding_stage'],
      sources: ['web_search'],
    };

    await service.execute(spec);
    const updateCall = mockCrmDb.updateLead.mock.calls[0];
    const meta = (updateCall[2] as any).enrichmentMetadata || {};
    expect(meta.funding_stage).toBeUndefined();
  });

  it('targeted re-search: when first pass yields >50% nulls, retries with field-name keywords and fills in missing values', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead1', email: 'jane@acme.com', company: 'Acme Corp' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    // First search returns generic info; targeted retry finds revenue & funding details
    mockAgentModeService.searchWeb
      .mockResolvedValueOnce({
        success: true,
        results: [{ title: 'Acme', url: 'https://acme.com', snippet: 'Acme is a tech company' }],
      })
      .mockResolvedValueOnce({
        success: true,
        results: [{
          title: 'Acme Funding',
          url: 'https://news.com/acme',
          snippet: 'Acme raised Series B for $30M annual revenue $8M',
        }],
      });

    // First LLM call: only first field has a citation; revenue/funding null
    // Second LLM call (targeted retry): fills in revenue and funding
    mockGeminiCreate
      .mockResolvedValueOnce(geminiResponse({
        industry: { value: 'Tech', sourceQuote: 'tech company', sourceUrl: 'https://acme.com', confidence: 'high' },
        revenue_range: { value: null, sourceQuote: null, confidence: 'low' },
        funding_stage: { value: null, sourceQuote: null, confidence: 'low' },
      }))
      .mockResolvedValueOnce(geminiResponse({
        revenue_range: { value: '$8M', sourceQuote: 'annual revenue $8M', sourceUrl: 'https://news.com/acme', confidence: 'high' },
        funding_stage: { value: 'Series B', sourceQuote: 'Series B for $30M', sourceUrl: 'https://news.com/acme', confidence: 'high' },
      }));

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get details',
      outputFields: ['industry', 'revenue_range', 'funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    // Targeted re-search produced an extra searchWeb call.
    // Gemini is called >= 2 times (extraction + retargeted extraction; critic adds 1 more if enabled).
    expect(mockAgentModeService.searchWeb).toHaveBeenCalledTimes(2);
    expect(mockGeminiCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    const cf = lastUpdateCustomFields();
    expect(cf.industry).toBe('Tech');
    // Note: revenue_range "$8M" gets bucketed by normalizer to "$1-10M"
    expect(cf.revenue_range).toBe('$1-10M');
    expect(cf.funding_stage).toBe('Series B');
  });

  it('critic pass: drops claims the critic marks as CONTRADICTED, downgrades unsupported/partial to low confidence', async () => {
    setupSingleLeadJob('Acme operates in the SaaS sector with multiple products');
    // `market_size` is non-canonical and not in the static alias map, so the
    // alias resolver would fire an LLM call to map it. Pre-populate the list's
    // canonical map so the resolver short-circuits and the mockGeminiCreate
    // queue lines up with the extraction + critic calls only.
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'user1',
      fieldCanonicalMap: { market_size: 'revenue_range' },
    } as any);
    // Three claims, all present in source (so verifyCitations keeps them).
    // Critic produces three different verdicts — only "contradicted" should drop.
    mockGeminiCreate
      .mockResolvedValueOnce(geminiResponse({
        industry: { value: 'SaaS', sourceQuote: 'SaaS sector', sourceUrl: 'https://acme.com', confidence: 'high' },
        market_size: { value: '$10B', sourceQuote: 'multiple products', sourceUrl: 'https://acme.com', confidence: 'high' },
        funding_stage: { value: 'Series Z', sourceQuote: 'multiple products', sourceUrl: 'https://acme.com', confidence: 'high' },
      }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({
          industry:      { verdict: 'supported',          reason: 'sector explicitly named' },
          market_size:   { verdict: 'unsupported',        reason: 'no figure in source' },
          funding_stage: { verdict: 'contradicted',       reason: 'source says bootstrapped' },
        }) } }],
      });

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get details',
      outputFields: ['industry', 'market_size', 'funding_stage'],
      sources: ['web_search'],
    };

    await service.execute(spec);
    const cf = lastUpdateCustomFields();
    expect(cf.industry).toBe('SaaS');                                  // supported → kept high
    expect(cf.market_size).toBe('$10B');                               // unsupported → kept but low confidence
    expect(cf.funding_stage).toBeUndefined();                          // contradicted → removed

    const meta = (mockCrmDb.updateLead.mock.calls[0][2] as any).enrichmentMetadata;
    expect(meta.industry.criticVerdict).toBe('supported');
    expect(meta.market_size.criticVerdict).toBe('unsupported');
    expect(meta.market_size.confidence).toBe('low');
  });

  it('keeps a mix of supported and unsupported fields independently', async () => {
    setupSingleLeadJob('Acme operates in the SaaS sector with 200 employees');
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({
        industry: {
          value: 'SaaS',
          sourceQuote: 'SaaS sector',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
        funding_stage: {
          value: 'Series C',
          sourceQuote: 'closed Series C round of $50M',
          sourceUrl: 'https://acme.com',
          confidence: 'high',
        },
      })
    );

    const spec: EnrichmentJobSpec = {
      listId: 'list1', userId: 'user1',
      instruction: 'Get details',
      outputFields: ['industry', 'funding_stage'],
      sources: ['web_search'],
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);
    const cf = lastUpdateCustomFields();
    expect(cf.industry).toBe('SaaS');           // supported → kept
    expect(cf.funding_stage).toBeUndefined();   // unsupported → removed
  });
});

// ─── Stage 3: LinkedIn confidence scoring via company-id resolver ─────────────

describe('CrmEnrichmentService - LinkedIn confidence scoring (Stage 3)', () => {
  const {
    setUnipileSearchParamServiceForTesting,
    __resetUnipileSearchParamServiceForTesting,
  } = require('../services/unipileSearchParamService');
  const enrichmentLogger = require('../utils/enrichmentLogger');

  let service: CrmEnrichmentService;
  let warnSpy: jest.SpyInstance;
  let originalFlag: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.createEnrichmentSnapshotItem.mockResolvedValue(undefined);
    mockCrmDb.createEnrichmentJobMeta.mockResolvedValue(undefined);
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
    originalFlag = process.env.CRM_USE_LINKEDIN_ID_RESOLUTION;
    warnSpy = jest.spyOn(enrichmentLogger.enrichLog, 'warn').mockImplementation(() => {});
    __resetUnipileSearchParamServiceForTesting();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.CRM_USE_LINKEDIN_ID_RESOLUTION;
    else process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = originalFlag;
    warnSpy.mockRestore();
    __resetUnipileSearchParamServiceForTesting();
  });

  function setupSearchPeopleJob(opts: {
    leadOverrides?: any;
    searchPeopleItems: any[];
  }) {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead(opts.leadOverrides ?? {})],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockGetAccountsByUserId.mockResolvedValue([
      { account_id: 'acc1', platform: 'unipile' },
    ] as any);
    // search-people → first call returns items; if a get-profile is invoked
    // afterwards we satisfy it with a basic profile shape.
    mockAgentModeService.linkedinOutreach
      .mockResolvedValueOnce({ success: true, data: { items: opts.searchPeopleItems } })
      .mockResolvedValue({ success: true, data: { public_identifier: 'picked', headline: 'CEO' } });

    mockGeminiCreate.mockResolvedValue(geminiResponse({ seniority: 'C-level' }));
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
  }

  function buildSpec(): EnrichmentJobSpec {
    return {
      listId: 'list1',
      userId: 'user1',
      instruction: 'Determine seniority',
      outputFields: ['seniority'],
      sources: ['linkedin'],
      sourcesPerField: { seniority: ['linkedin'] },
    };
  }

  function setupResolver(returnValue: { topId: string | null; throws?: boolean }) {
    const resolveTopId = returnValue.throws
      ? jest.fn().mockRejectedValue(new Error('resolver boom'))
      : jest.fn().mockResolvedValue(returnValue.topId);
    setUnipileSearchParamServiceForTesting({ resolveTopId } as any);
    return resolveTopId;
  }

  function lastUserMessageAcrossLLMCalls(): string {
    return mockGeminiCreate.mock.calls
      .map((call: any[]) => (call[0].messages.find((m: any) => m.role === 'user')?.content) || '')
      .join('\n---\n');
  }

  it('flag OFF → preserves blind items[0] behavior, no resolver call, confidence=unspecified', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'false';
    const resolveTopId = setupResolver({ topId: 'company-acme-id' });
    setupSearchPeopleJob({
      searchPeopleItems: [
        { provider_id: 'p1', current_role: { company: { id: 'wrong-co' } } },
      ],
    });

    const result = await service.execute(buildSpec());
    expect(result.processedCount).toBe(1);
    expect(resolveTopId).not.toHaveBeenCalled();

    // No low-confidence warning emitted in legacy path
    const warnEvents = warnSpy.mock.calls.map((c: any[]) => c[0]?.event);
    expect(warnEvents).not.toContain('linkedin_context_low_confidence');

    // search-people called with combined keywords (legacy free-text behavior)
    expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
      'user1',
      expect.objectContaining({
        action: 'search-people',
        keywords: 'John Doe Acme Corp',
      }),
    );
  });

  it('flag ON + resolver hit + matching candidate → confidence=high, correct profile fed to LLM', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'true';
    const resolveTopId = setupResolver({ topId: 'company-acme-id' });

    setupSearchPeopleJob({
      searchPeopleItems: [
        { provider_id: 'wrong', current_role: { company: { id: 'unrelated-co' } } },
        { provider_id: 'right', current_role: { company: { id: 'company-acme-id' } }, public_identifier: 'right-person' },
      ],
    });

    const result = await service.execute(buildSpec());
    expect(result.processedCount).toBe(1);
    expect(resolveTopId).toHaveBeenCalledWith(
      'acc1',
      expect.objectContaining({ type: 'COMPANY', keywords: 'Acme Corp' }),
    );

    // search-people was passed company_id (Stage 2 will accept this field)
    expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
      'user1',
      expect.objectContaining({ action: 'search-people', company_id: 'company-acme-id' }),
    );

    // get-profile was invoked on the *matching* provider_id, not items[0]
    expect(mockAgentModeService.linkedinOutreach).toHaveBeenCalledWith(
      'user1',
      expect.objectContaining({ action: 'get-profile', provider_id: 'right' }),
    );

    // No low-confidence warning
    const warnEvents = warnSpy.mock.calls.map((c: any[]) => c[0]?.event);
    expect(warnEvents).not.toContain('linkedin_context_low_confidence');
  });

  it('flag ON + resolver hit + NO matching candidate → confidence=low, LinkedIn fields dropped from prompt, warn logged', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'true';
    setupResolver({ topId: 'company-acme-id' });

    setupSearchPeopleJob({
      searchPeopleItems: [
        // None of the candidates match the resolved company id
        { provider_id: 'p1', public_identifier: 'wrong-1', current_role: { company: { id: 'co-x' } }, headline: 'Director', summary: 'Old summary' },
      ],
    });

    const result = await service.execute(buildSpec());
    expect(result.processedCount).toBe(1);

    // LLM prompt should NOT contain Unipile-derived structured fields
    const allUserMsgs = lastUserMessageAcrossLLMCalls();
    expect(allUserMsgs).not.toContain('LinkedIn profile data');
    expect(allUserMsgs).not.toContain('Resolved LinkedIn profile URL');
    expect(allUserMsgs).not.toContain('Old summary');

    // Telemetry warn emitted
    const lowConfWarn = warnSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((f: any) => f?.event === 'linkedin_context_low_confidence');
    expect(lowConfWarn).toBeDefined();
    expect(lowConfWarn).toMatchObject({
      event: 'linkedin_context_low_confidence',
      company: 'Acme Corp',
      candidateCount: 1,
      resolvedCompanyId: 'company-acme-id',
    });
  });

  it('flag ON + resolver returns null → confidence=low, LinkedIn fields dropped, warn logged', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'true';
    setupResolver({ topId: null });

    setupSearchPeopleJob({
      searchPeopleItems: [
        { provider_id: 'p1', public_identifier: 'maybe', current_role: { company: { id: 'co-x' } }, headline: 'CTO', summary: 'Bio' },
      ],
    });

    const result = await service.execute(buildSpec());
    expect(result.processedCount).toBe(1);

    const allUserMsgs = lastUserMessageAcrossLLMCalls();
    expect(allUserMsgs).not.toContain('LinkedIn profile data');
    expect(allUserMsgs).not.toContain('Bio');

    const lowConfWarn = warnSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((f: any) => f?.event === 'linkedin_context_low_confidence');
    expect(lowConfWarn).toBeDefined();
    expect(lowConfWarn?.resolvedCompanyId).toBeNull();
  });

  it('flag ON + resolver throws → confidence=low, enrichment still completes', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'true';
    setupResolver({ topId: null, throws: true });

    setupSearchPeopleJob({
      searchPeopleItems: [
        { provider_id: 'p1', public_identifier: 'fallback', current_role: { company: { id: 'co-x' } }, headline: 'CTO' },
      ],
    });

    const result = await service.execute(buildSpec());
    // Enrichment still completes — resolver errors don't fail the lead
    expect(result.processedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const lowConfWarn = warnSpy.mock.calls
      .map((c: any[]) => c[0])
      .find((f: any) => f?.event === 'linkedin_context_low_confidence');
    expect(lowConfWarn).toBeDefined();
  });

  it('flag ON + low confidence: web-search-regex LinkedIn URLs from web context survive', async () => {
    process.env.CRM_USE_LINKEDIN_ID_RESOLUTION = 'true';
    setupResolver({ topId: 'company-acme-id' });

    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'user1' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead1' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockGetAccountsByUserId.mockResolvedValue([
      { account_id: 'acc1', platform: 'unipile' },
    ] as any);

    // Web search returns a snippet containing a LinkedIn URL — regex picks it up
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [
        { title: 'John Doe', url: 'https://example.com', snippet: 'See https://www.linkedin.com/in/john-doe-from-web' },
      ],
    });
    // search-people returns a candidate with WRONG company → low confidence
    mockAgentModeService.linkedinOutreach
      .mockResolvedValueOnce({ success: true, data: { items: [
        { provider_id: 'wrong-p', public_identifier: 'wrong-p', current_role: { company: { id: 'co-x' } } },
      ] } })
      .mockResolvedValue({ success: true, data: { public_identifier: 'wrong-p', headline: 'X' } });

    mockGeminiCreate.mockResolvedValue(geminiResponse({ linkedin_url: 'https://www.linkedin.com/in/john-doe-from-web' }));
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);

    const spec: EnrichmentJobSpec = {
      listId: 'list1',
      userId: 'user1',
      instruction: 'Find the personal LinkedIn URL',
      outputFields: ['linkedin_url'],
      sources: ['web_search', 'linkedin'],
      sourcesPerField: { linkedin_url: ['web_search', 'linkedin'] },
    };

    const result = await service.execute(spec);
    expect(result.processedCount).toBe(1);

    // The web-search-regex URL must still appear in the prompt context
    const allUserMsgs = lastUserMessageAcrossLLMCalls();
    expect(allUserMsgs).toContain('john-doe-from-web');
    // But Unipile-derived structured profile data must NOT
    expect(allUserMsgs).not.toContain('LinkedIn profile data');
  });
});

describe('CrmEnrichmentService.getEnrichmentConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('falls back to gpt-5-chat-2 defaults when no setting is stored', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null as any);
    const config = await CrmEnrichmentService.getEnrichmentConfig();
    expect(config).toEqual({
      enrichmentModel: 'gpt-5-chat-2',
      dataExtractionModel: 'gpt-5-chat-2',
    });
  });

  it('falls back to gpt-5-chat-2 defaults when stored JSON is malformed', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'crm-enrichment-config',
      settingValue: 'not-json',
      updatedBy: 'system',
      updatedAt: new Date().toISOString(),
    } as any);
    const config = await CrmEnrichmentService.getEnrichmentConfig();
    expect(config).toEqual({
      enrichmentModel: 'gpt-5-chat-2',
      dataExtractionModel: 'gpt-5-chat-2',
    });
  });

  it('returns stored values when present, overriding the default', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'crm-enrichment-config',
      settingValue: JSON.stringify({
        enrichmentModel: 'gemini-3-pro-preview',
        dataExtractionModel: 'anthropic.claude-sonnet-4-6',
      }),
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    } as any);
    const config = await CrmEnrichmentService.getEnrichmentConfig();
    expect(config).toEqual({
      enrichmentModel: 'gemini-3-pro-preview',
      dataExtractionModel: 'anthropic.claude-sonnet-4-6',
    });
  });

  it('falls back per-field when stored JSON omits one model', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'crm-enrichment-config',
      settingValue: JSON.stringify({ enrichmentModel: 'gemini-3-pro-preview' }),
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    } as any);
    const config = await CrmEnrichmentService.getEnrichmentConfig();
    expect(config.enrichmentModel).toBe('gemini-3-pro-preview');
    expect(config.dataExtractionModel).toBe('gpt-5-chat-2');
  });
});

// ─── apolloTechStack waterfall ────────────────────────────────────────────────

function mockApolloOrg(techStack: string[] | null) {
  const matchOrg = jest.fn().mockResolvedValue(
    techStack && techStack.length > 0
      ? { found: true, organization: { techStack }, fromCache: false, checkedAt: new Date().toISOString() }
      : { found: false, fromCache: false, checkedAt: new Date().toISOString() },
  );
  const svc = { matchOrg, matchPerson: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService;
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);
  return { matchOrg, svc };
}

function baseSpec(overrides: Partial<EnrichmentJobSpec> = {}): EnrichmentJobSpec {
  return {
    listId: 'list-1',
    userId: 'user-1',
    instruction: 'Find tech stack',
    outputFields: ['tech_stack_analytics', 'tech_stack_cms'],
    sources: ['web_search'],
    apolloTechStack: true,
    ...overrides,
  } as EnrichmentJobSpec;
}

describe('enrichLead — apolloTechStack waterfall', () => {
  let service: CrmEnrichmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CrmEnrichmentService();
    mockCrmDb.setLeadFields.mockImplementation(async (listId: string, leadId: string, options: any) => {
      const payload: Record<string, any> = { ...(options?.topLevel || {}) };
      if (options?.customFields) payload.customFields = options.customFields;
      if (options?.enrichmentMetadata) payload.enrichmentMetadata = options.enrichmentMetadata;
      await mockCrmDb.updateLead(listId, leadId, payload as any);
    });
    mockCrmDb.mergeFieldNames.mockImplementation(async (listId: string, newFields: Set<string> | string[]) => {
      await mockCrmDb.updateFieldNames(listId, Array.from(newFields as any));
    });
    mockCrmDb.createEnrichmentSnapshotItem.mockResolvedValue(undefined);
    mockCrmDb.createEnrichmentJobMeta.mockResolvedValue(undefined);
    mockCrmDb.updateEnrichmentJobStatus.mockResolvedValue(undefined);
    mockCrmDb.updateLead.mockResolvedValue({} as any);
    mockCrmDb.updateFieldNames.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses Apollo context and skips web search when Apollo returns techStack', async () => {
    const { matchOrg } = mockApolloOrg(['Google Analytics', 'WordPress']);
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({ tech_stack_analytics: 'Google Analytics', tech_stack_cms: 'WordPress' }),
    );
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
    expect(mockAgentModeService.searchWeb).not.toHaveBeenCalled();
    expect(mockGeminiCreate).toHaveBeenCalled();
    // First call is field-alias resolution; Apollo context appears in a later extraction call.
    const allPrompts = mockGeminiCreate.mock.calls.map(c => JSON.stringify(c[0])).join('\n');
    expect(allPrompts).toContain('Google Analytics');
    expect(allPrompts).toContain('WordPress');
  });

  it('falls back to web search when Apollo returns no techStack', async () => {
    const { matchOrg } = mockApolloOrg(null);
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme tech', snippet: 'Uses Mixpanel and Shopify' }],
    });
    mockGeminiCreate.mockResolvedValue(
      geminiResponse({ tech_stack_analytics: 'Mixpanel', tech_stack_cms: 'Shopify' }),
    );
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });

  it('skips Apollo and runs web search when lead has no domain', async () => {
    const { matchOrg } = mockApolloOrg(['React']);
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', snippet: 'Uses Hubspot' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Unknown' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', email: undefined, emailDomain: undefined, website: undefined, company: 'Acme' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).not.toHaveBeenCalled();
    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });

  it('falls back to web search when Apollo service is not ready', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(false);
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', snippet: 'Uses AWS' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Unknown' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });

  it('does not call Apollo when apolloTechStack flag is absent', async () => {
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    const matchOrg = jest.fn();
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(
      { matchOrg, matchPerson: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService,
    );
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', snippet: 'Uses AWS' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Unknown' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    // No apolloTechStack flag
    await service.execute(baseSpec({ apolloTechStack: undefined } as any));

    expect(matchOrg).not.toHaveBeenCalled();
  });

  it('does not call Apollo during preview (no credits burned on preview)', async () => {
    const { matchOrg } = mockApolloOrg(['React', 'AWS']);
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Unknown' }));
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Acme', snippet: 'Uses AWS' }],
    });
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.preview(baseSpec());

    expect(matchOrg).not.toHaveBeenCalled();
  });

  it('does not call Apollo when domain is a personal email domain', async () => {
    const { matchOrg } = mockApolloOrg(['React']);
    mockAgentModeService.searchWeb.mockResolvedValue({
      success: true,
      results: [{ title: 'Gmail', snippet: 'Email service' }],
    });
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Unknown' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'gmail.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).not.toHaveBeenCalled();
    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });

  it('extracts domain from website when emailDomain absent', async () => {
    const { matchOrg } = mockApolloOrg(['Segment']);
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Segment' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: undefined, website: 'https://www.beta.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).toHaveBeenCalledWith('beta.com');
  });

  it('falls back to web search when Apollo matchOrg rejects', async () => {
    const matchOrg = jest.fn().mockRejectedValue(new Error('Apollo timeout'));
    const svc = { matchOrg, matchPerson: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService;
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Mixpanel' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });

  it('falls back to web search when Apollo returns found:true with empty techStack', async () => {
    const matchOrg = jest.fn().mockResolvedValue({
      found: true,
      organization: { techStack: [] },
      fromCache: false,
      checkedAt: new Date().toISOString(),
    });
    const svc = { matchOrg, matchPerson: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService;
    jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
    jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);
    mockGeminiCreate.mockResolvedValue(geminiResponse({ tech_stack_analytics: 'Mixpanel' }));
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-1' } as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [createLead({ leadId: 'lead-1', emailDomain: 'acme.com' })],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    await service.execute(baseSpec());

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
    expect(mockAgentModeService.searchWeb).toHaveBeenCalled();
  });
});

// Tests for Emma linkedin_outreach_batch tool

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
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
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
import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAgentMode = agentModeService as jest.Mocked<typeof agentModeService>;

describe('Emma linkedin_outreach_batch tool', () => {
  const context = { userId: 'user-123' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should be registered in the tool registry', () => {
    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch');
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe('linkedin_outreach_batch');
    expect(tool!.definition.inputSchema.required).toContain('account_id');
    expect(tool!.definition.inputSchema.required).toContain('action');
    expect(tool!.definition.inputSchema.required).toContain('lead_list_id');
    expect(tool!.definition.inputSchema.required).toContain('template');
  });

  // FAILURE TEST 1: Missing lead_list_id returns error
  it('should return error when lead_list_id is missing', async () => {
    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      { account_id: 'acc-1', action: 'send-invite', template: 'Hello {{firstName}}' },
      context
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/lead_list_id/i);
  });

  // FAILURE TEST 2: Template with unknown variables returns warning
  it('should return warning when template contains unknown variables', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123', name: 'Test List' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'l1', listId: 'list-1', data: { firstName: 'Alice', linkedin: 'https://linkedin.com/in/alice' } },
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hello {{firstName}}, from {{unknownVar}} at {{anotherUnknown}}',
      },
      context
    );
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknownVar/),
      expect.stringMatching(/anotherUnknown/),
    ]));
  });

  // FAILURE TEST 3: Leads without LinkedIn URLs are skipped gracefully
  it('should skip leads without LinkedIn URLs', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123', name: 'Test List' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'l1', listId: 'list-1', data: { firstName: 'Alice' } }, // no linkedin
        { leadId: 'l2', listId: 'list-1', data: { firstName: 'Bob', linkedin: '' } }, // empty linkedin
        { leadId: 'l3', listId: 'list-1', data: { firstName: 'Carol', linkedin: 'https://linkedin.com/in/carol' } },
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentMode.linkedinOutreach.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hello {{firstName}}!',
      },
      context
    );
    expect(result.success).toBe(true);
    expect(result.summary.skipped).toBe(2);
    expect(result.summary.sent).toBe(1);
    // Only Carol should have been sent
    expect(mockAgentMode.linkedinOutreach).toHaveBeenCalledTimes(1);
  });

  // SUCCESS TEST: 5 leads with template personalized and batch-sent
  it('should personalize template and batch-send to 5 leads', async () => {
    const leads = [
      { leadId: 'l1', listId: 'list-1', data: { firstName: 'Alice', lastName: 'Smith', company: 'Acme', title: 'CEO', linkedin: 'https://linkedin.com/in/alice' } },
      { leadId: 'l2', listId: 'list-1', data: { firstName: 'Bob', lastName: 'Jones', company: 'Beta', title: 'CTO', linkedin: 'https://linkedin.com/in/bob' } },
      { leadId: 'l3', listId: 'list-1', data: { firstName: 'Carol', lastName: 'Lee', company: 'Gamma', title: 'VP', linkedin: 'https://linkedin.com/in/carol' } },
      { leadId: 'l4', listId: 'list-1', data: { firstName: 'Dan', lastName: 'Kim', company: 'Delta', title: 'CFO', linkedin: 'https://linkedin.com/in/dan' } },
      { leadId: 'l5', listId: 'list-1', data: { firstName: 'Eve', lastName: 'Wu', company: 'Echo', title: 'COO', linkedin: 'https://linkedin.com/in/eve' } },
    ];

    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123', name: 'Test List' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentMode.linkedinOutreach.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hi {{firstName}} {{lastName}}, I see you are {{title}} at {{company}}. Let us connect!',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.summary.sent).toBe(5);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.skipped).toBe(0);
    expect(mockAgentMode.linkedinOutreach).toHaveBeenCalledTimes(5);

    // Verify personalized messages
    expect(mockAgentMode.linkedinOutreach).toHaveBeenCalledWith('user-123', expect.objectContaining({
      action: 'send-invite',
      account_id: 'acc-1',
      profile_url: 'https://linkedin.com/in/alice',
      message: 'Hi Alice Smith, I see you are CEO at Acme. Let us connect!',
    }));
    expect(mockAgentMode.linkedinOutreach).toHaveBeenCalledWith('user-123', expect.objectContaining({
      message: 'Hi Eve Wu, I see you are COO at Echo. Let us connect!',
    }));
  });

  // FAILURE TEST: Missing auth context
  it('should return error when userId is missing', async () => {
    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    await expect(tool.execute(
      { account_id: 'acc-1', action: 'send-invite', lead_list_id: 'list-1', template: 'Hi' },
      {}
    )).rejects.toThrow(/user context/i);
  });

  // Test: max_leads limits the number of leads processed
  it('should respect max_leads parameter', async () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({
      leadId: `l${i}`,
      listId: 'list-1',
      data: { firstName: `User${i}`, linkedin: `https://linkedin.com/in/user${i}` },
    }));

    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123', name: 'Test List' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentMode.linkedinOutreach.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hello {{firstName}}!',
        max_leads: 3,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.summary.sent).toBe(3);
    expect(mockAgentMode.linkedinOutreach).toHaveBeenCalledTimes(3);
  });

  // Test: Failed outreach calls are counted
  it('should count failed outreach calls', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123', name: 'Test List' });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        { leadId: 'l1', listId: 'list-1', data: { firstName: 'Alice', linkedin: 'https://linkedin.com/in/alice' } },
        { leadId: 'l2', listId: 'list-1', data: { firstName: 'Bob', linkedin: 'https://linkedin.com/in/bob' } },
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    });
    mockAgentMode.linkedinOutreach
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, message: 'Rate limited' });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hello {{firstName}}!',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.summary.sent).toBe(1);
    expect(result.summary.failed).toBe(1);
  });

  // Test: Lead list not found
  it('should return error when lead list is not found', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null);

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'nonexistent',
        template: 'Hello!',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  // Test: Lead list belongs to different user
  it('should return error when lead list belongs to different user', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'other-user', name: 'Test List' });

    const tool = emmaToolRegistry.getTool('linkedin_outreach_batch')!;
    const result = await tool.execute(
      {
        account_id: 'acc-1',
        action: 'send-invite',
        lead_list_id: 'list-1',
        template: 'Hello!',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found|unauthorized/i);
  });
});

// Unit tests for report_product_issues tool

// Mock dependencies BEFORE any imports
jest.mock('../../services/notionService', () => ({
  createOncallItem: jest.fn(),
}));

const mockCreateFeaturebasePost = jest.fn();
jest.mock('../../services/featurebaseService', () => ({
  createFeaturebasePost: mockCreateFeaturebasePost,
}), { virtual: true });

jest.mock('../../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/settingsService', () => ({
  settingsService: {
    getJsonArraySetting: jest.fn().mockResolvedValue(['founders@agentweb.pro']),
  },
}));

jest.mock('../../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  accountMemoryDb: {
    getMemories: jest.fn().mockResolvedValue([]),
    putMemory: jest.fn().mockResolvedValue(undefined),
    deleteMemory: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue(null),
}));

// Mock agentModeService to avoid pulling in its huge dependency tree
jest.mock('../../services/agentModeService', () => ({
  agentModeService: {},
}));

// Mock the MCP registry module - provide both the class and the singleton
const toolMap = new Map<string, any>();
const mockRegistryInstance = {
  register: jest.fn((handler: any) => toolMap.set(handler.name, handler)),
  getTool: jest.fn((name: string) => toolMap.get(name)),
  getToolNames: jest.fn(() => Array.from(toolMap.keys())),
  getToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllTools: jest.fn(() => Array.from(toolMap.values())),
};

jest.mock('../../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => mockRegistryInstance),
  mcpToolRegistry: mockRegistryInstance,
}));

// Mock apiTools to prevent it from trying to register admin tools with complex deps
jest.mock('../../mcp/server/apiTools', () => ({
  adminToolNames: [],
}));

import { emmaToolRegistry } from '../../emma/registry';

import { createOncallItem } from '../../services/notionService';
import { resendService } from '../../services/resendService';
import { userDb } from '../../services/db';

const mockCreateOncallItem = createOncallItem as jest.MockedFunction<typeof createOncallItem>;
const mockGetUserById = userDb.getUserById as jest.MockedFunction<typeof userDb.getUserById>;
const mockResendSendEmail = resendService.sendEmail as jest.MockedFunction<typeof resendService.sendEmail>;

describe('report_product_issues tool', () => {
  let toolExecute: (args: any, context: any) => Promise<any>;

  beforeAll(async () => {
    // Load tools (registers report_product_issues)
    await import('../../emma/tools');

    const tool = emmaToolRegistry.getTool('report_product_issues');
    expect(tool).toBeDefined();
    toolExecute = tool!.execute;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOncallItem.mockResolvedValue({
      pageId: 'notion-page-id',
      notionUrl: 'https://notion.so/notionpageid',
    });
    mockCreateFeaturebasePost.mockResolvedValue({
      postId: 'featurebase-post-id',
      postUrl: 'https://feedback.agentweb.pro/p/featurebase-post-id',
      linearIssueUrls: ['https://linear.app/agentweb/issue/ENG-123'],
    });
    mockGetUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      displayName: 'Test Customer',
    } as any);
  });

  it('should throw if no userId in context', async () => {
    await expect(toolExecute(
      { issues: [{ title: 'Bug', description: 'It broke' }] },
      {}
    )).rejects.toThrow('Authentication required');
  });

  it('should throw if user not found', async () => {
    mockGetUserById.mockResolvedValueOnce(null as any);

    await expect(toolExecute(
      { issues: [{ title: 'Bug', description: 'It broke' }] },
      { userId: 'unknown-user' }
    )).rejects.toThrow('User not found');
  });

  it('should create Featurebase post with Customer Reported tag for a single issue', async () => {
    const result = await toolExecute(
      { issues: [{ title: 'Login fails', description: 'Cannot log in on mobile', priority: 'High', pageUrl: 'https://app.example.com/login' }] },
      { userId: 'user-123', sessionId: 'sess-456' }
    );

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].issueId).toBe('FB-featurebase-post-id');

    expect(mockCreateOncallItem).not.toHaveBeenCalled();
    expect(mockCreateFeaturebasePost).toHaveBeenCalledWith({
      title: 'Login fails',
      description: 'Cannot log in on mobile',
      kind: 'bug',
      priority: 'High',
      tags: ['Customer Reported', 'bug', 'priority:High'],
      attachmentUrls: [],
      reporter: {
        userId: 'user-123',
        email: 'customer@example.com',
        name: 'Test Customer',
      },
      context: {
        'User Name': 'Test Customer',
        'User Email': 'customer@example.com',
        'User ID': 'user-123',
        'Priority': 'High',
        'Page URL': 'https://app.example.com/login',
        'Session ID': 'sess-456',
      },
    });
  });

  it('should process multiple issues in one call', async () => {
    mockCreateFeaturebasePost
      .mockResolvedValueOnce({ postId: 'p1', postUrl: 'https://feedback.agentweb.pro/p/p1', linearIssueUrls: [] })
      .mockResolvedValueOnce({ postId: 'p2', postUrl: 'https://feedback.agentweb.pro/p/p2', linearIssueUrls: [] });

    const result = await toolExecute(
      { issues: [
        { title: 'Bug 1', description: 'First issue' },
        { title: 'Bug 2', description: 'Second issue', pageUrl: 'https://app.example.com/page2' },
      ] },
      { userId: 'user-123' }
    );

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({ title: 'Bug 1', success: true, issueId: 'FB-p1', issueUrl: 'https://feedback.agentweb.pro/p/p1' });
    expect(result.results[1]).toEqual({ title: 'Bug 2', success: true, issueId: 'FB-p2', issueUrl: 'https://feedback.agentweb.pro/p/p2' });
    expect(mockCreateFeaturebasePost).toHaveBeenCalledTimes(2);
    expect(mockCreateOncallItem).not.toHaveBeenCalled();
    expect(mockResendSendEmail).toHaveBeenCalledTimes(2);
  });

  it('should handle partial failures gracefully', async () => {
    mockCreateFeaturebasePost
      .mockResolvedValueOnce({ postId: 'p1', postUrl: 'https://feedback.agentweb.pro/p/p1', linearIssueUrls: [] })
      .mockRejectedValueOnce(new Error('Featurebase API error'));

    const result = await toolExecute(
      { issues: [
        { title: 'Good issue', description: 'This works' },
        { title: 'Bad issue', description: 'This fails' },
      ] },
      { userId: 'user-123' }
    );

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);
    expect(result.results[1].error).toBe('Featurebase API error');
    expect(result.message).toContain('1 of 2');
  });

  it('should send resend email to founders only (never customer) with issue details', async () => {
    await toolExecute(
      { issues: [{ title: 'Bug', description: 'Desc', pageUrl: 'https://app.example.com/page' }] },
      { userId: 'user-123' }
    );

    expect(mockResendSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['founders@agentweb.pro'],
        subject: '[Issue] Bug — reported by customer@example.com',
        replyTo: 'customer@example.com',
        html: expect.stringContaining('FB-featurebase-post-id'),
      })
    );
    expect(mockResendSendEmail.mock.calls[0][0].html).toContain('Open in Featurebase');
    const callArgs = mockResendSendEmail.mock.calls[0][0];
    expect(callArgs.to).not.toContain('customer@example.com');
  });

  it('should send only one email per issue (no oncall alert duplicate)', async () => {
    await toolExecute(
      { issues: [{ title: 'Bug', description: 'Desc' }] },
      { userId: 'user-123' }
    );

    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
  });

  it('should handle missing pageUrl and sessionId gracefully', async () => {
    await toolExecute(
      { issues: [{ title: 'Bug', description: 'Desc' }] },
      { userId: 'user-123' }
    );

    expect(mockCreateFeaturebasePost).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: 'Medium',
        context: expect.objectContaining({
          'Priority': 'Medium',
          'Page URL': 'N/A',
          'Session ID': 'N/A',
        }),
      }),
    );
  });

  describe('delegate admin access', () => {
    const delegateContext = {
      userId: 'user-123',
      sessionId: 'sess-789',
      isDelegatedAdmin: true,
      adminEmail: 'admin@agentweb.pro',
    };

    it('should send email to founders + admin (never customer) when isDelegatedAdmin', async () => {
      await toolExecute(
        { issues: [{ title: 'Admin-reported bug', description: 'Found via delegation' }] },
        delegateContext
      );

      expect(mockResendSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['founders@agentweb.pro', 'admin@agentweb.pro'],
          replyTo: 'customer@example.com',
        })
      );
      const callArgs = mockResendSendEmail.mock.calls[0][0];
      expect(callArgs.to).not.toContain('customer@example.com');
    });

    it('should show delegation info in email body when isDelegatedAdmin', async () => {
      await toolExecute(
        { issues: [{ title: 'Admin-reported bug', description: 'Found via delegation' }] },
        delegateContext
      );

      const callArgs = mockResendSendEmail.mock.calls[0][0];
      expect(callArgs.html).toContain('admin@agentweb.pro');
      expect(callArgs.html).toContain('Via delegation');
      expect(callArgs.html).toContain('customer@example.com');
    });

    it('should add Reported By (Admin) field to Featurebase context when isDelegatedAdmin', async () => {
      await toolExecute(
        { issues: [{ title: 'Admin-reported bug', description: 'Found via delegation' }] },
        delegateContext
      );

      expect(mockCreateFeaturebasePost).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            'Reported By (Admin)': 'admin@agentweb.pro',
          }),
        })
      );
    });

    it('should suppress customer email even when isDelegatedAdmin but adminEmail is unknown', async () => {
      await toolExecute(
        { issues: [{ title: 'Bug', description: 'Desc' }] },
        { userId: 'user-123', isDelegatedAdmin: true }
      );

      const callArgs = mockResendSendEmail.mock.calls[0][0];
      // Customer must never receive email under any delegate scenario
      expect(callArgs.to).not.toContain('customer@example.com');
      // Only internal recipients (productIssueEmails) when adminEmail not resolved
      expect(callArgs.to).toEqual(['founders@agentweb.pro']);
    });
  });
});

// Unit tests for report_product_issue tool

// Mock dependencies BEFORE any imports
jest.mock('../../services/notionService', () => ({
  createOncallItem: jest.fn(),
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test' }),
  })),
}));

jest.mock('../../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
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
import { emailService } from '../../services/emailService';

const mockCreateOncallItem = createOncallItem as jest.MockedFunction<typeof createOncallItem>;
const mockGetUserById = userDb.getUserById as jest.MockedFunction<typeof userDb.getUserById>;
const mockResendSendEmail = resendService.sendEmail as jest.MockedFunction<typeof resendService.sendEmail>;

describe('report_product_issue tool', () => {
  let toolExecute: (args: any, context: any) => Promise<any>;

  beforeAll(async () => {
    // Load tools (registers report_product_issue)
    await import('../../emma/tools');

    const tool = emmaToolRegistry.getTool('report_product_issue');
    expect(tool).toBeDefined();
    toolExecute = tool!.execute;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOncallItem.mockResolvedValue({
      pageId: 'notion-page-id',
      notionUrl: 'https://notion.so/notionpageid',
    });
    mockGetUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      displayName: 'Test Customer',
    } as any);
    // Spy on sendOncallAlert
    jest.spyOn(emailService, 'sendOncallAlert').mockResolvedValue(undefined);
  });

  it('should throw if no userId in context', async () => {
    await expect(toolExecute(
      { title: 'Bug', description: 'It broke' },
      {}
    )).rejects.toThrow('Authentication required');
  });

  it('should throw if user not found', async () => {
    mockGetUserById.mockResolvedValueOnce(null as any);

    await expect(toolExecute(
      { title: 'Bug', description: 'It broke' },
      { userId: 'unknown-user' }
    )).rejects.toThrow('User not found');
  });

  it('should create Notion item with Oncall and Customer Reported tags', async () => {
    const result = await toolExecute(
      { title: 'Login fails', description: 'Cannot log in on mobile', priority: 'High', pageUrl: 'https://app.example.com/login' },
      { userId: 'user-123', sessionId: 'sess-456' }
    );

    expect(result.success).toBe(true);
    expect(result.notionUrl).toBe('https://notion.so/notionpageid');

    expect(mockCreateOncallItem).toHaveBeenCalledWith({
      title: 'Login fails',
      description: 'Cannot log in on mobile',
      additionalTags: ['Customer Reported'],
      context: {
        'User Email': 'customer@example.com',
        'User ID': 'user-123',
        'Page URL': 'https://app.example.com/login',
        'Session ID': 'sess-456',
      },
    });
  });

  it('should send oncall alert email with Notion URL (no duplicate creation)', async () => {
    await toolExecute(
      { title: 'Bug', description: 'Desc' },
      { userId: 'user-123' }
    );

    expect(emailService.sendOncallAlert).toHaveBeenCalledWith(
      'Customer Report: Bug',
      'Desc',
      expect.objectContaining({ 'User Email': 'customer@example.com' }),
      'https://notion.so/notionpageid' // notionUrl passed to skip duplicate
    );
  });

  it('should send support email to founders', async () => {
    await toolExecute(
      { title: 'Bug', description: 'Desc', pageUrl: 'https://app.example.com/page' },
      { userId: 'user-123' }
    );

    expect(mockResendSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'founders@agentweb.pro',
        subject: expect.stringContaining('Product Issue from customer@example.com'),
        replyTo: 'customer@example.com',
      })
    );
  });

  it('should handle missing pageUrl and sessionId gracefully', async () => {
    await toolExecute(
      { title: 'Bug', description: 'Desc' },
      { userId: 'user-123' }
    );

    expect(mockCreateOncallItem).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          'Page URL': 'N/A',
          'Session ID': 'N/A',
        }),
      })
    );
  });
});

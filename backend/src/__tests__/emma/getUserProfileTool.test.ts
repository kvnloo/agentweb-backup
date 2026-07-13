// Unit tests for the get_user_profile tool (ENG-288 follow-up).
//
// Before ENG-288's follow-up fix this tool read the raw user.subscriptionType
// field, so an org member self-reporting their tier via Emma would get their
// own (e.g. Free) tier instead of the org owner's inherited tier — the same
// bug class as the wrong-tier/no-shared-assets symptom, just surfaced through
// a chat tool instead of the connected-accounts or landing-pages UI.

jest.mock('../../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
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
import { userDb } from '../../services/db';
import { getUserSubscriptionType } from '../../services/subscriptionService';

const mockGetUserById = userDb.getUserById as jest.MockedFunction<typeof userDb.getUserById>;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.MockedFunction<typeof getUserSubscriptionType>;

describe('get_user_profile tool', () => {
  let toolExecute: (args: any, context: any) => Promise<any>;

  beforeAll(async () => {
    await import('../../emma/tools');

    const tool = emmaToolRegistry.getTool('get_user_profile');
    expect(tool).toBeDefined();
    toolExecute = tool!.execute;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should throw if no userId in context', async () => {
    await expect(toolExecute({}, {})).rejects.toThrow('Authentication required');
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('should return an error when the user is not found', async () => {
    mockGetUserById.mockResolvedValueOnce(null as any);

    const result = await toolExecute({}, { userId: 'unknown-user' });

    expect(result).toEqual({ error: 'User profile not found.' });
    expect(mockGetUserSubscriptionType).not.toHaveBeenCalled();
  });

  it('should fall back to context.agentUserId when userId is absent', async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: 'agent-user-1',
      email: 'agent@example.com',
      subscriptionType: 'Free',
    } as any);
    mockGetUserSubscriptionType.mockResolvedValueOnce('Free');

    const result = await toolExecute({}, { agentUserId: 'agent-user-1' });

    expect(mockGetUserById).toHaveBeenCalledWith('agent-user-1');
    expect(result.subscriptionType).toBe('Free');
  });

  it('should report the solo user own tier when not in an org', async () => {
    mockGetUserById.mockResolvedValueOnce({
      userId: 'solo-user',
      email: 'solo@example.com',
      displayName: 'Solo User',
      companyName: 'Solo Co',
      subscriptionType: 'Pro',
    } as any);
    mockGetUserSubscriptionType.mockResolvedValueOnce('Pro');

    const result = await toolExecute({}, { userId: 'solo-user' });

    expect(mockGetUserSubscriptionType).toHaveBeenCalledWith('solo-user');
    expect(result).toEqual({
      email: 'solo@example.com',
      displayName: 'Solo User',
      companyName: 'Solo Co',
      subscriptionType: 'Pro',
    });
  });

  it('should report the org owner tier for a member, not the member own raw field (ENG-288)', async () => {
    // Member's own record still carries the stale/never-updated Free tier from
    // signup — the fix must not read this field directly.
    mockGetUserById.mockResolvedValueOnce({
      userId: 'member-1',
      email: 'member@example.com',
      displayName: 'Org Member',
      companyName: null,
      subscriptionType: 'Free',
      orgId: 'org-1',
      orgRole: 'member',
    } as any);
    mockGetUserSubscriptionType.mockResolvedValueOnce('Super Premium');

    const result = await toolExecute({}, { userId: 'member-1' });

    expect(mockGetUserSubscriptionType).toHaveBeenCalledWith('member-1');
    expect(result.subscriptionType).toBe('Super Premium');
    expect(result.subscriptionType).not.toBe('Free');
  });
});

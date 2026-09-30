const mockSearchPlatformKnowledgeBase = jest.fn();
const observe = jest.fn();

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue({}),
    incrementFailedFunctions: jest.fn().mockResolvedValue({}),
    updateSessionResultEndpointMetadata: jest.fn().mockResolvedValue({}),
  },
  searchPlatformKnowledgeBase: (...args: any[]) =>
    mockSearchPlatformKnowledgeBase(...args),
}));
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getSkillsAvailableToUser: jest.fn().mockResolvedValue([]),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    listTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn().mockResolvedValue({}),
  })),
}));
jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));
jest.mock('../services/z0ContextPacket', () => ({
  observeZ0ContextPacketShadow: (...args: any[]) => observe(...args),
}));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService z0 context packet shadow hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the original KB result unchanged and observes it once', async () => {
    mockSearchPlatformKnowledgeBase.mockResolvedValue([
      {
        id: 'kb-1',
        content: 'Brand voice: practical and technical.',
        metadata: {
          source: 'private-knowledge-base',
          fileName: 'strategy.md',
        },
      },
    ]);
    const service = new AgentModeService();

    const result = await service.searchKnowledgeBase('brand voice', 5);

    expect(result).toEqual({
      success: true,
      message: 'Found 1 knowledge base results for "brand voice"',
      query: 'brand voice',
      returnedResults: 1,
      hasMore: false,
      results: [
        {
          content: 'Brand voice: practical and technical.',
          source: 'private-knowledge-base',
          fileName: 'strategy.md',
        },
      ],
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(
      'brand voice',
      result,
      'agentweb-public-kb',
    );
  });

  it('observes an empty result without changing completeness semantics', async () => {
    mockSearchPlatformKnowledgeBase.mockResolvedValue([]);
    const service = new AgentModeService();

    const result = await service.searchKnowledgeBase('missing topic', 5);

    expect(result).toMatchObject({
      success: true,
      query: 'missing topic',
      results: [],
      returnedResults: 0,
      hasMore: false,
    });
    expect(observe).toHaveBeenCalledWith(
      'missing topic',
      result,
      'agentweb-public-kb',
    );
  });

  it('observes a failed search but does not turn failure into success', async () => {
    mockSearchPlatformKnowledgeBase.mockRejectedValue(new Error('search offline'));
    const service = new AgentModeService();

    const result = await service.searchKnowledgeBase('brand voice', 5);

    expect(result).toMatchObject({
      success: false,
      error: 'search offline',
    });
    expect(observe).toHaveBeenCalledWith(
      'brand voice',
      result,
      'agentweb-public-kb',
    );
  });
});

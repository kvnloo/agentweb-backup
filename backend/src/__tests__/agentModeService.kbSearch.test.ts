/**
 * Tests for searchKnowledgeBase result bounding + empty-query guard.
 *
 * Bug 1: max_results must bound the number of returned results.
 * Bug 2: an empty / whitespace query must not run a search (it returned the whole KB).
 */

import { AgentModeService } from '../services/agentModeService';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: jest.fn().mockResolvedValue(undefined),
}));

const mockSearchPlatformKnowledgeBase = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    incrementCalledFunctions: jest.fn().mockResolvedValue({}),
    incrementFailedFunctions: jest.fn().mockResolvedValue({}),
    updateSessionResultEndpointMetadata: jest.fn().mockResolvedValue({}),
  },
  searchPlatformKnowledgeBase: (...args: any[]) => mockSearchPlatformKnowledgeBase(...args),
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

function makeChunks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    content: `chunk-${i}`,
    metadata: { source: 'public-knowledge-base' },
  }));
}

describe('AgentModeService.searchKnowledgeBase', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('bounds the result count to max_results even when the source returns more', async () => {
    mockSearchPlatformKnowledgeBase.mockResolvedValue(makeChunks(8));

    const res = await service.searchKnowledgeBase('real query', 3);

    expect(res.success).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.totalResults).toBe(3);
  });

  it('caps the effective max at 10 even if a larger max_results is requested', async () => {
    mockSearchPlatformKnowledgeBase.mockResolvedValue(makeChunks(40));

    const res = await service.searchKnowledgeBase('real query', 25);

    expect(res.results.length).toBeLessThanOrEqual(10);
  });

  it('returns no results for an empty query without running a search', async () => {
    const res = await service.searchKnowledgeBase('', 5);

    expect(res.success).toBe(true);
    expect(res.results).toEqual([]);
    expect(res.totalResults).toBe(0);
    expect(mockSearchPlatformKnowledgeBase).not.toHaveBeenCalled();
  });

  it('returns no results for a whitespace-only query without running a search', async () => {
    const res = await service.searchKnowledgeBase('   \n\t ', 5);

    expect(res.success).toBe(true);
    expect(res.results).toEqual([]);
    expect(mockSearchPlatformKnowledgeBase).not.toHaveBeenCalled();
  });
});

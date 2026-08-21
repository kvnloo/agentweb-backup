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

  it('bounds the result count to max_results, and does not call the page a total (ENG-1207)', async () => {
    // Rewritten, not deleted, so the diff shows what changed. `totalResults: 3`
    // when 8 matched was the defect this ticket is about, asserted as if it were
    // correct: a field named "total" carrying a page count is more misleading than
    // the prose, because a structured field reads as authoritative.
    mockSearchPlatformKnowledgeBase.mockResolvedValue(makeChunks(8));

    const res = await service.searchKnowledgeBase('real query', 3);

    expect(res.success).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.returnedResults).toBe(3);
    expect(res.hasMore).toBe(true);
    expect(res).not.toHaveProperty('totalResults');
    expect(res.message).not.toMatch(/^Found 3 knowledge base results/);
    expect(res.message).toMatch(/max_results|more/i);
  });

  it('reads as a plain count when nothing was cut (ENG-1207)', async () => {
    // The control. Over-qualifying a complete answer teaches the model to ignore
    // the qualifier, which is how has_more came to be ignored in the first place.
    mockSearchPlatformKnowledgeBase.mockResolvedValue(makeChunks(2));

    const res = await service.searchKnowledgeBase('real query', 5);

    expect(res.returnedResults).toBe(2);
    expect(res.hasMore).toBe(false);
    expect(res.message).toMatch(/Found 2 knowledge base results/);
    expect(res.message).not.toMatch(/more|max_results/i);
  });

  it('BOUNDARY: exactly at the bound is not reported as cut (ENG-1207)', async () => {
    // `slice` returns everything here, so a naive "did I slice?" check would warn
    // about nothing. Whether MORE exists beyond it is unknowable — see the
    // implementation note — and this asserts we do not guess in the safe direction
    // either.
    mockSearchPlatformKnowledgeBase.mockResolvedValue(makeChunks(3));

    const res = await service.searchKnowledgeBase('real query', 3);

    expect(res.results).toHaveLength(3);
    expect(res.hasMore).toBe(false);
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
    expect(res.returnedResults).toBe(0);
    expect(res.hasMore).toBe(false);
    expect(mockSearchPlatformKnowledgeBase).not.toHaveBeenCalled();
  });

  it('returns no results for a whitespace-only query without running a search', async () => {
    const res = await service.searchKnowledgeBase('   \n\t ', 5);

    expect(res.success).toBe(true);
    expect(res.results).toEqual([]);
    expect(mockSearchPlatformKnowledgeBase).not.toHaveBeenCalled();
  });
});

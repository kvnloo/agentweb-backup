import { AgentModeService } from '../services/agentModeService';
import { searchPlatformKnowledgeBase } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn(),
    getChatSession: jest.fn(),
    incrementCalledFunctions: jest.fn(),
  },
  searchPlatformKnowledgeBase: jest.fn(),
}));

jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - search_knowledge_base', () => {
  let agentModeService: AgentModeService;
  const mockSearchPlatformKnowledgeBase = searchPlatformKnowledgeBase as jest.MockedFunction<typeof searchPlatformKnowledgeBase>;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('Tool Definition', () => {
    it('should include search_knowledge_base in available tools', () => {
      const tools = agentModeService.getAvailableTools();
      const searchKnowledgeBaseTool = tools.find(
        (tool: any) => tool.function?.name === 'search_knowledge_base'
      );

      expect(searchKnowledgeBaseTool).toBeDefined();
      expect(searchKnowledgeBaseTool?.function?.name).toBe('search_knowledge_base');
    });

    it('should have correct tool description', () => {
      const tools = agentModeService.getAvailableTools();
      const searchKnowledgeBaseTool = tools.find(
        (tool: any) => tool.function?.name === 'search_knowledge_base'
      );

      expect(searchKnowledgeBaseTool?.function?.description).toContain('knowledge base');
      expect(searchKnowledgeBaseTool?.function?.description).toContain('private knowledge');
      expect(searchKnowledgeBaseTool?.function?.description).toContain('public knowledge');
    });

    it('should have correct parameters', () => {
      const tools = agentModeService.getAvailableTools();
      const searchKnowledgeBaseTool = tools.find(
        (tool: any) => tool.function?.name === 'search_knowledge_base'
      );

      const params = searchKnowledgeBaseTool?.function?.parameters;
      expect(params).toBeDefined();
      expect(params?.properties).toHaveProperty('query');
      expect(params?.properties).toHaveProperty('max_results');
      expect(params?.required).toContain('query');
      
      expect(params?.properties?.query?.type).toBe('string');
      expect(params?.properties?.max_results?.type).toBe('number');
      expect(params?.properties?.max_results?.default).toBe(5);
    });
  });

  describe('executeTool - search_knowledge_base', () => {
    it('should call searchKnowledgeBase with correct parameters', async () => {
      const mockResults = [
        {
          id: 'kb-1',
          content: 'Test content 1',
          metadata: { source: 'public-knowledge-base' }
        },
        {
          id: 'kb-2',
          content: 'Test content 2',
          metadata: { source: 'private-knowledge-base' }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      const result = await (agentModeService as any).executeTool(
        'search_knowledge_base',
        { query: 'test query', max_results: 5 },
        'user-123',
        'session-456',
        false
      );

      expect(mockSearchPlatformKnowledgeBase).toHaveBeenCalledWith('test query', 5, 'user-123');
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        content: 'Test content 1',
        source: 'public-knowledge-base'
      });
      expect(result.results[1]).toEqual({
        content: 'Test content 2',
        source: 'private-knowledge-base'
      });
    });

    it('should use default max_results when not provided', async () => {
      const mockResults = [
        {
          id: 'kb-1',
          content: 'Test content',
          metadata: { source: 'public-knowledge-base' }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      await (agentModeService as any).executeTool(
        'search_knowledge_base',
        { query: 'test query' },
        'user-123',
        'session-456',
        false
      );

      expect(mockSearchPlatformKnowledgeBase).toHaveBeenCalledWith('test query', 5, 'user-123');
    });

    it('should limit max_results to 10', async () => {
      const mockResults: any[] = [];
      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      await (agentModeService as any).executeTool(
        'search_knowledge_base',
        { query: 'test query', max_results: 20 },
        'user-123',
        'session-456',
        false
      );

      expect(mockSearchPlatformKnowledgeBase).toHaveBeenCalledWith('test query', 10, 'user-123');
    });
  });

  describe('searchKnowledgeBase method', () => {
    it('should return success with results when search finds content', async () => {
      const mockResults = [
        {
          id: 'kb-1',
          content: 'Public knowledge content',
          metadata: { source: 'public-knowledge-base' }
        },
        {
          id: 'kb-2',
          content: 'Private knowledge content',
          metadata: { source: 'private-knowledge-base' }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Found 2 knowledge base results');
      expect(result.query).toBe('test query');
      expect(result.results).toHaveLength(2);
      expect(result.totalResults).toBe(2);
      expect(result.results[0].content).toBe('Public knowledge content');
      expect(result.results[0].source).toBe('public-knowledge-base');
      expect(result.results[1].content).toBe('Private knowledge content');
      expect(result.results[1].source).toBe('private-knowledge-base');
    });

    it('should return success with empty results when no content found', async () => {
      mockSearchPlatformKnowledgeBase.mockResolvedValue([]);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('No knowledge base results found');
      expect(result.query).toBe('test query');
      expect(result.results).toEqual([]);
      expect(result.totalResults).toBe(0);
    });

    it('should handle null/undefined search results', async () => {
      mockSearchPlatformKnowledgeBase.mockResolvedValue(null as any);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('No knowledge base results found');
      expect(result.results).toEqual([]);
      expect(result.totalResults).toBe(0);
    });

    it('should map results correctly without taskId', async () => {
      const mockResults = [
        {
          id: 'kb-1',
          content: 'Test content',
          metadata: { source: 'public-knowledge-base', taskId: 'task-123' }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.results[0]).not.toHaveProperty('taskId');
      expect(result.results[0]).toEqual({
        content: 'Test content',
        source: 'public-knowledge-base'
      });
    });

    it('should handle unknown source gracefully', async () => {
      const mockResults = [
        {
          id: 'kb-1',
          content: 'Test content',
          metadata: {
            source: 'test-source'
          }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      // Should return the actual source value if provided
      expect(result.results[0].source).toBe('test-source');
    });

    it('should limit maxResults to 10', async () => {
      mockSearchPlatformKnowledgeBase.mockResolvedValue([]);

      await (agentModeService as any).searchKnowledgeBase(
        'test query',
        15,
        'user-123'
      );

      expect(mockSearchPlatformKnowledgeBase).toHaveBeenCalledWith('test query', 10, 'user-123');
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Search failed');
      mockSearchPlatformKnowledgeBase.mockRejectedValue(error);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to search the knowledge base');
      expect(result.error).toBe('Search failed');
    });

    it('should handle errors without message', async () => {
      const error = { code: 'ERROR' };
      mockSearchPlatformKnowledgeBase.mockRejectedValue(error);

      const result = await (agentModeService as any).searchKnowledgeBase(
        'test query',
        5,
        'user-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('Mock Responses', () => {
    it('should return correct mock response for search_knowledge_base', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('search_knowledge_base', {
        query: 'test query'
      });

      expect(mockResponse).toEqual({
        success: true,
        message: 'Found 2 mock knowledge base results for "test query"',
        query: 'test query',
        results: [
          {
            content: 'This is a mock knowledge base result for "test query". It contains information that was previously stored from a task execution.',
            source: 'public-knowledge-base'
          },
          {
            content: 'Another mock knowledge base result for "test query". This information comes from a private knowledge base entry.',
            source: 'private-knowledge-base'
          }
        ],
        totalResults: 2
      });
    });

    it('should not include taskId in mock results', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('search_knowledge_base', {
        query: 'test query'
      });

      expect(mockResponse.results[0]).not.toHaveProperty('taskId');
      expect(mockResponse.results[1]).not.toHaveProperty('taskId');
    });
  });

  describe('System Prompt', () => {
    it('should mention search_knowledge_base in system prompt', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      expect(systemPrompt).toContain('search_knowledge_base');
      expect(systemPrompt).toContain('Knowledge Base Search');
    });

    it('should explain when to use knowledge base vs web search', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      expect(systemPrompt).toContain('knowledge base for stored information');
      expect(systemPrompt).toContain('web search for information from the internet');
    });

    it('should mention private and public knowledge', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();

      expect(systemPrompt).toContain('private knowledge');
      expect(systemPrompt).toContain('public knowledge');
    });
  });
});


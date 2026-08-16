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

jest.mock('aws-sdk');

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

  beforeEach(async () => {
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
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
          metadata: { source: 'public-knowledge-base', fileName: 'guide.txt' }
        },
        {
          id: 'kb-2',
          content: 'Test content 2',
          metadata: { source: 'private-knowledge-base', fileName: 'knowledge-base.txt' }
        }
      ];

      mockSearchPlatformKnowledgeBase.mockResolvedValue(mockResults);

      const result = await (agentModeService as any).executeTool(
        agentModeService.default_model,
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
        source: 'public-knowledge-base',
        fileName: 'guide.txt'
      });
      expect(result.results[1]).toEqual({
        content: 'Test content 2',
        source: 'private-knowledge-base',
        fileName: 'knowledge-base.txt'
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
        agentModeService.default_model,
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
        agentModeService.default_model,
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
          metadata: { source: 'public-knowledge-base', fileName: 'public-guide.txt' }
        },
        {
          id: 'kb-2',
          content: 'Private knowledge content',
          metadata: { source: 'private-knowledge-base', fileName: 'private-doc.txt' }
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
      expect(result.results[0].fileName).toBe('public-guide.txt');
      expect(result.results[1].content).toBe('Private knowledge content');
      expect(result.results[1].source).toBe('private-knowledge-base');
      expect(result.results[1].fileName).toBe('private-doc.txt');
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
          metadata: { source: 'public-knowledge-base', taskId: 'task-123', fileName: 'test.txt' }
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
        source: 'public-knowledge-base',
        fileName: 'test.txt'
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

    // ENG-1057: the Vertex source was the one path in this function that never
    // capped content length, unlike Drive/ClickUp docs/ClickUp tasks below it.
    // A single oversized result crashed the whole process with a Node
    // ERR_STRING_TOO_LONG uncaught exception, taking down every request on this
    // single-instance backend until auto-restart.
    it('should truncate Vertex result content over 5000 chars with a truncation marker', async () => {
      const longContent = 'x'.repeat(6000);
      mockSearchPlatformKnowledgeBase.mockResolvedValue([
        { id: 'kb-1', content: longContent, metadata: { source: 'public-knowledge-base' } },
      ]);

      const result = await (agentModeService as any).searchKnowledgeBase('test query', 5, 'user-123');

      expect(result.results[0].content).toBe('x'.repeat(5000) + '\n\n[Content truncated]');
      expect(result.results[0].content.length).toBeLessThan(longContent.length);
    });

    it('does not crash when an individual Vertex result has null/undefined content (malformed upstream response)', async () => {
      mockSearchPlatformKnowledgeBase.mockResolvedValue([
        { id: 'kb-1', content: null, metadata: { source: 'public-knowledge-base' } },
        { id: 'kb-2', content: undefined, metadata: { source: 'public-knowledge-base' } },
      ] as any);

      const result = await (agentModeService as any).searchKnowledgeBase('test query', 5, 'user-123');

      expect(result.success).toBe(true);
      expect(result.results[0].content).toBeNull();
      expect(result.results[1].content).toBeUndefined();
    });

    it('should not truncate Vertex result content at exactly 5000 chars', async () => {
      const boundaryContent = 'x'.repeat(5000);
      mockSearchPlatformKnowledgeBase.mockResolvedValue([
        { id: 'kb-1', content: boundaryContent, metadata: { source: 'public-knowledge-base' } },
      ]);

      const result = await (agentModeService as any).searchKnowledgeBase('test query', 5, 'user-123');

      expect(result.results[0].content).toBe(boundaryContent);
      expect(result.results[0].content).not.toContain('[Content truncated]');
    });

    it('should not truncate Vertex result content under 5000 chars', async () => {
      mockSearchPlatformKnowledgeBase.mockResolvedValue([
        { id: 'kb-1', content: 'short content', metadata: { source: 'public-knowledge-base' } },
      ]);

      const result = await (agentModeService as any).searchKnowledgeBase('test query', 5, 'user-123');

      expect(result.results[0].content).toBe('short content');
    });

    it('should truncate only the oversized result when multiple Vertex results have mixed lengths', async () => {
      const longContent = 'y'.repeat(7000);
      mockSearchPlatformKnowledgeBase.mockResolvedValue([
        { id: 'kb-1', content: 'short content', metadata: { source: 'public-knowledge-base' } },
        { id: 'kb-2', content: longContent, metadata: { source: 'private-knowledge-base' } },
      ]);

      const result = await (agentModeService as any).searchKnowledgeBase('test query', 5, 'user-123');

      expect(result.results[0].content).toBe('short content');
      expect(result.results[1].content).toBe('y'.repeat(5000) + '\n\n[Content truncated]');
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
            source: 'public-knowledge-base',
            fileName: 'platform-guide.txt'
          },
          {
            content: 'Another mock knowledge base result for "test query". This information comes from a private knowledge base entry.',
            source: 'private-knowledge-base',
            fileName: 'knowledge-base.txt'
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

    it('should include fileName in mock results', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('search_knowledge_base', {
        query: 'test query'
      });

      expect(mockResponse.results[0]).toHaveProperty('fileName');
      expect(mockResponse.results[0].fileName).toBe('platform-guide.txt');
      expect(mockResponse.results[1]).toHaveProperty('fileName');
      expect(mockResponse.results[1].fileName).toBe('knowledge-base.txt');
    });
  });

  describe('System Prompt', () => {
    it('should mention skill installation workflow', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('install_skills');
    });

    it('should provide guidance on file attachments', async () => {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      expect(systemPrompt).toContain('File Attachments');
    });
  });
});


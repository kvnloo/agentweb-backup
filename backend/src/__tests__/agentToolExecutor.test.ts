// Mock the registry before importing
jest.mock('../mcp/server/registry', () => {
  const mockRegistry = {
    getToolDefinitions: jest.fn(),
    getToolNames: jest.fn(),
    execute: jest.fn(),
    getTool: jest.fn(),
  };
  return {
    mcpToolRegistry: mockRegistry,
  };
});

import { AgentToolExecutor } from '../services/agentToolExecutor';
import { mcpToolRegistry } from '../mcp/server/registry';

const mockRegistry = mcpToolRegistry as jest.Mocked<typeof mcpToolRegistry>;

describe('AgentToolExecutor', () => {
  let executor: AgentToolExecutor;

  beforeEach(() => {
    jest.clearAllMocks();
    executor = new AgentToolExecutor();
  });

  describe('listTools', () => {
    it('should return tool definitions from registry', () => {
      const mockTools = [
        { name: 'generate_blog', description: 'Generate a blog post', inputSchema: {} },
        { name: 'create_image', description: 'Create an image', inputSchema: {} },
      ];

      mockRegistry.getToolDefinitions.mockReturnValue(mockTools);

      const result = executor.listTools();

      expect(result).toEqual(mockTools);
      expect(mockRegistry.getToolDefinitions).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no tools registered', () => {
      mockRegistry.getToolDefinitions.mockReturnValue([]);

      const result = executor.listTools();

      expect(result).toEqual([]);
    });
  });

  describe('executeTool', () => {
    it('should execute tool and return success result', async () => {
      const mockResult = { content: [{ type: 'text', text: 'Blog generated!' }] };
      mockRegistry.execute.mockResolvedValue(mockResult);

      const result = await executor.executeTool(
        'generate_blog',
        { topic: 'AI Marketing' },
        { userId: 'user-123', sessionId: 'session-abc' }
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual(mockResult);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();

      expect(mockRegistry.execute).toHaveBeenCalledWith(
        'generate_blog',
        { topic: 'AI Marketing' },
        { userId: 'user-123', sessionId: 'session-abc' }
      );
    });

    it('should return error result when tool execution fails', async () => {
      mockRegistry.execute.mockRejectedValue(new Error('Tool failed'));

      const result = await executor.executeTool(
        'broken_tool',
        {},
        { userId: 'user-123' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Tool failed');
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return error when tool not found', async () => {
      mockRegistry.execute.mockRejectedValue(new Error('Tool nonexistent not found'));

      const result = await executor.executeTool(
        'nonexistent',
        {},
        { userId: 'user-123' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should pass context with llmModel', async () => {
      mockRegistry.execute.mockResolvedValue({ content: [] });

      await executor.executeTool(
        'generate_blog',
        { topic: 'Test' },
        { userId: 'user-123', sessionId: 'sess-1', llmModel: 'claude-sonnet' }
      );

      expect(mockRegistry.execute).toHaveBeenCalledWith(
        'generate_blog',
        { topic: 'Test' },
        { userId: 'user-123', sessionId: 'sess-1', llmModel: 'claude-sonnet' }
      );
    });

    it('should measure execution time', async () => {
      // Simulate a slow tool
      mockRegistry.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: [] }), 50))
      );

      const result = await executor.executeTool(
        'slow_tool',
        {},
        { userId: 'user-123' }
      );

      expect(result.success).toBe(true);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(40);
    });
  });
});

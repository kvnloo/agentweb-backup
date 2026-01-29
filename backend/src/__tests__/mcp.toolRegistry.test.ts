/**
 * Unit tests for mcp/client/toolRegistry.ts
 * Tests the ToolRegistry class for client-side tool management with context
 */

import { ToolRegistry, AgentTool, ToolContext } from '../mcp/client/toolRegistry';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const createMockContext = (overrides?: Partial<ToolContext>): ToolContext => ({
    userId: 'test-user-123',
    sessionId: 'test-session-456',
    llmModel: 'gpt-4',
    mockMode: false,
    service: {},
    ...overrides
  });

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool successfully', () => {
      const tool: AgentTool = {
        name: 'test_tool',
        definition: {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: {} }
          }
        },
        execute: jest.fn().mockResolvedValue({ success: true })
      };

      registry.register(tool);

      const retrievedTool = registry.getTool('test_tool');
      expect(retrievedTool).toBeDefined();
      expect(retrievedTool?.name).toBe('test_tool');
    });

    it('should register multiple tools', () => {
      const tool1: AgentTool = {
        name: 'tool_one',
        definition: { type: 'function', function: { name: 'tool_one' } },
        execute: jest.fn()
      };
      const tool2: AgentTool = {
        name: 'tool_two',
        definition: { type: 'function', function: { name: 'tool_two' } },
        execute: jest.fn()
      };

      registry.register(tool1);
      registry.register(tool2);

      const allTools = registry.getAllTools();
      expect(allTools).toHaveLength(2);
    });

    it('should overwrite existing tool with same name', () => {
      const originalTool: AgentTool = {
        name: 'duplicate_tool',
        definition: { type: 'function', function: { name: 'duplicate_tool', description: 'Original' } },
        execute: jest.fn().mockResolvedValue('original')
      };
      const newTool: AgentTool = {
        name: 'duplicate_tool',
        definition: { type: 'function', function: { name: 'duplicate_tool', description: 'New' } },
        execute: jest.fn().mockResolvedValue('new')
      };

      registry.register(originalTool);
      registry.register(newTool);

      const allTools = registry.getAllTools();
      expect(allTools).toHaveLength(1);
      
      const definitions = registry.getToolDefinitions();
      expect(definitions[0].function.description).toBe('New');
    });
  });

  describe('getTool', () => {
    it('should return undefined for non-existent tool', () => {
      const tool = registry.getTool('nonexistent');
      expect(tool).toBeUndefined();
    });

    it('should return correct tool by name', () => {
      const expectedTool: AgentTool = {
        name: 'specific_tool',
        definition: { type: 'function', function: { name: 'specific_tool', description: 'Specific' } },
        execute: jest.fn()
      };

      registry.register(expectedTool);

      const tool = registry.getTool('specific_tool');
      expect(tool).toBeDefined();
      expect(tool?.definition.function.description).toBe('Specific');
    });
  });

  describe('execute', () => {
    it('should execute tool with context', async () => {
      const mockExecute = jest.fn().mockResolvedValue({ result: 'success' });
      const tool: AgentTool = {
        name: 'context_tool',
        definition: { type: 'function', function: { name: 'context_tool' } },
        execute: mockExecute
      };

      registry.register(tool);
      const context = createMockContext();

      await registry.execute('context_tool', { param: 'value' }, context);

      expect(mockExecute).toHaveBeenCalledWith(
        { param: 'value' },
        context
      );
    });

    it('should throw error for unknown tool', async () => {
      const context = createMockContext();

      await expect(registry.execute('unknown_tool', {}, context))
        .rejects.toThrow('Unknown tool: unknown_tool');
    });

    it('should pass args and context correctly', async () => {
      const mockExecute = jest.fn().mockResolvedValue('done');
      const tool: AgentTool = {
        name: 'args_test_tool',
        definition: { type: 'function', function: { name: 'args_test_tool' } },
        execute: mockExecute
      };

      registry.register(tool);

      const args = { 
        stringParam: 'hello', 
        numberParam: 42, 
        nested: { key: 'value' } 
      };
      const context = createMockContext({
        userId: 'custom-user',
        sessionId: 'custom-session',
        llmModel: 'gpt-3.5-turbo',
        mockMode: true
      });

      await registry.execute('args_test_tool', args, context);

      expect(mockExecute).toHaveBeenCalledWith(args, context);
      expect(mockExecute.mock.calls[0][1].userId).toBe('custom-user');
      expect(mockExecute.mock.calls[0][1].mockMode).toBe(true);
    });

    it('should return result from tool execution', async () => {
      const expectedResult = {
        data: { items: [1, 2, 3] },
        status: 'completed'
      };
      const tool: AgentTool = {
        name: 'result_tool',
        definition: { type: 'function', function: { name: 'result_tool' } },
        execute: jest.fn().mockResolvedValue(expectedResult)
      };

      registry.register(tool);
      const context = createMockContext();

      const result = await registry.execute('result_tool', {}, context);

      expect(result).toEqual(expectedResult);
    });

    it('should propagate errors from tool execution', async () => {
      const tool: AgentTool = {
        name: 'error_tool',
        definition: { type: 'function', function: { name: 'error_tool' } },
        execute: jest.fn().mockRejectedValue(new Error('Tool execution failed'))
      };

      registry.register(tool);
      const context = createMockContext();

      await expect(registry.execute('error_tool', {}, context))
        .rejects.toThrow('Tool execution failed');
    });

    it('should handle async tool execution', async () => {
      const tool: AgentTool = {
        name: 'async_tool',
        definition: { type: 'function', function: { name: 'async_tool' } },
        execute: async (args, context) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { 
            processed: args.input, 
            user: context.userId 
          };
        }
      };

      registry.register(tool);
      const context = createMockContext({ userId: 'async-user' });

      const result = await registry.execute('async_tool', { input: 'test-data' }, context);

      expect(result).toEqual({
        processed: 'test-data',
        user: 'async-user'
      });
    });
  });

  describe('getAllTools', () => {
    it('should return empty array when no tools registered', () => {
      const tools = registry.getAllTools();
      expect(tools).toEqual([]);
    });

    it('should return all registered tools', () => {
      const toolNames = ['alpha', 'beta', 'gamma', 'delta'];
      toolNames.forEach(name => {
        registry.register({
          name,
          definition: { type: 'function', function: { name } },
          execute: jest.fn()
        });
      });

      const tools = registry.getAllTools();
      expect(tools).toHaveLength(4);
      expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(toolNames));
    });
  });

  describe('getToolDefinitions', () => {
    it('should return empty array when no tools registered', () => {
      const definitions = registry.getToolDefinitions();
      expect(definitions).toEqual([]);
    });

    it('should return all tool definitions', () => {
      const tool1: AgentTool = {
        name: 'def_tool_1',
        definition: { 
          type: 'function', 
          function: { 
            name: 'def_tool_1', 
            description: 'First definition',
            parameters: { type: 'object', properties: { a: { type: 'string' } } }
          } 
        },
        execute: jest.fn()
      };
      const tool2: AgentTool = {
        name: 'def_tool_2',
        definition: { 
          type: 'function', 
          function: { 
            name: 'def_tool_2', 
            description: 'Second definition',
            parameters: { type: 'object', properties: { b: { type: 'number' } } }
          } 
        },
        execute: jest.fn()
      };

      registry.register(tool1);
      registry.register(tool2);

      const definitions = registry.getToolDefinitions();
      expect(definitions).toHaveLength(2);
      expect(definitions[0]).toEqual(tool1.definition);
      expect(definitions[1]).toEqual(tool2.definition);
    });
  });
});

// Test the exported singleton instance
describe('toolRegistry singleton', () => {
  it('should export a ToolRegistry instance', async () => {
    const { toolRegistry } = await import('../mcp/client/toolRegistry');
    expect(toolRegistry).toBeInstanceOf(ToolRegistry);
  });
});

/**
 * Unit tests for mcp/server/registry.ts
 * Tests the McpToolRegistry class for server-side MCP tool management
 */

import { McpToolRegistry, McpToolHandler } from '../mcp/server/registry';

describe('McpToolRegistry', () => {
  let registry: McpToolRegistry;

  beforeEach(() => {
    registry = new McpToolRegistry();
  });

  describe('register', () => {
    it('should register a tool successfully', () => {
      const handler: McpToolHandler = {
        name: 'test_tool',
        definition: {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: {} }
        },
        execute: jest.fn().mockResolvedValue({ success: true })
      };

      registry.register(handler);

      const names = registry.getToolNames();
      expect(names).toContain('test_tool');
    });

    it('should register multiple tools', () => {
      const handler1: McpToolHandler = {
        name: 'tool_one',
        definition: { name: 'tool_one', description: 'First tool' },
        execute: jest.fn()
      };
      const handler2: McpToolHandler = {
        name: 'tool_two',
        definition: { name: 'tool_two', description: 'Second tool' },
        execute: jest.fn()
      };

      registry.register(handler1);
      registry.register(handler2);

      const names = registry.getToolNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('tool_one');
      expect(names).toContain('tool_two');
    });

    it('should overwrite existing tool with same name', () => {
      const originalHandler: McpToolHandler = {
        name: 'duplicate_tool',
        definition: { name: 'duplicate_tool', description: 'Original' },
        execute: jest.fn().mockResolvedValue('original')
      };
      const newHandler: McpToolHandler = {
        name: 'duplicate_tool',
        definition: { name: 'duplicate_tool', description: 'New' },
        execute: jest.fn().mockResolvedValue('new')
      };

      registry.register(originalHandler);
      registry.register(newHandler);

      const names = registry.getToolNames();
      expect(names).toHaveLength(1);
      
      const definitions = registry.getToolDefinitions();
      expect(definitions[0].description).toBe('New');
    });
  });

  describe('getToolDefinitions', () => {
    it('should return empty array when no tools registered', () => {
      const definitions = registry.getToolDefinitions();
      expect(definitions).toEqual([]);
    });

    it('should return all tool definitions', () => {
      const handler1: McpToolHandler = {
        name: 'tool_a',
        definition: { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object' } },
        execute: jest.fn()
      };
      const handler2: McpToolHandler = {
        name: 'tool_b',
        definition: { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object' } },
        execute: jest.fn()
      };

      registry.register(handler1);
      registry.register(handler2);

      const definitions = registry.getToolDefinitions();
      expect(definitions).toHaveLength(2);
    });

    it('should return correct structure for each definition', () => {
      const expectedDefinition = {
        name: 'structured_tool',
        description: 'A tool with complete definition',
        inputSchema: {
          type: 'object',
          properties: {
            param1: { type: 'string', description: 'First parameter' },
            param2: { type: 'number', description: 'Second parameter' }
          },
          required: ['param1']
        }
      };

      const handler: McpToolHandler = {
        name: 'structured_tool',
        definition: expectedDefinition,
        execute: jest.fn()
      };

      registry.register(handler);

      const definitions = registry.getToolDefinitions();
      // ENG-336: getToolDefinitions() adds default annotations (derived from the handler's
      // `readOnly` flag, unset here so it defaults to a destructive/write classification) —
      // `expectedDefinition` itself stays unannotated since it doubles as the registered input.
      expect(definitions[0]).toEqual({
        ...expectedDefinition,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      });
    });
  });

  describe('getToolNames', () => {
    it('should return empty array when no tools registered', () => {
      const names = registry.getToolNames();
      expect(names).toEqual([]);
    });

    it('should return all tool names', () => {
      const tools = ['alpha', 'beta', 'gamma'];
      tools.forEach(name => {
        registry.register({
          name,
          definition: { name },
          execute: jest.fn()
        });
      });

      const names = registry.getToolNames();
      expect(names).toHaveLength(3);
      expect(names).toEqual(expect.arrayContaining(tools));
    });
  });

  describe('execute', () => {
    it('should execute a registered tool successfully', async () => {
      const mockResult = { data: 'test result', status: 'success' };
      const handler: McpToolHandler = {
        name: 'executable_tool',
        definition: { name: 'executable_tool' },
        execute: jest.fn().mockResolvedValue(mockResult)
      };

      registry.register(handler);

      const result = await registry.execute('executable_tool', {});
      expect(result).toEqual(mockResult);
    });

    it('should throw error for unknown tool', async () => {
      await expect(registry.execute('nonexistent_tool', {}))
        .rejects.toThrow('Tool nonexistent_tool not found');
    });

    it('should pass arguments correctly to handler', async () => {
      const mockExecute = jest.fn().mockResolvedValue('done');
      const handler: McpToolHandler = {
        name: 'args_tool',
        definition: { name: 'args_tool' },
        execute: mockExecute
      };

      registry.register(handler);

      const args = { param1: 'value1', param2: 42, nested: { key: 'value' } };
      await registry.execute('args_tool', args);

      expect(mockExecute).toHaveBeenCalledWith(args, undefined);
    });

    it('should handle async execution correctly', async () => {
      const handler: McpToolHandler = {
        name: 'async_tool',
        definition: { name: 'async_tool' },
        execute: async (args) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { processed: args.input };
        }
      };

      registry.register(handler);

      const result = await registry.execute('async_tool', { input: 'test' });
      expect(result).toEqual({ processed: 'test' });
    });

    it('should propagate errors from handler', async () => {
      const handler: McpToolHandler = {
        name: 'error_tool',
        definition: { name: 'error_tool' },
        execute: jest.fn().mockRejectedValue(new Error('Handler failed'))
      };

      registry.register(handler);

      await expect(registry.execute('error_tool', {}))
        .rejects.toThrow('Handler failed');
    });
  });
});

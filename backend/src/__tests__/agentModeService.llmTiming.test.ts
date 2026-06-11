/**
 * Tests for per-turn LLM timing metadata in AgentModeService.
 *
 * Validates that:
 * 1. iterationTimings are stored in the last assistant message's metadata
 * 2. Tool execution durations are stored in toolCalls metadata entries
 * 3. Parallel tool execution works correctly
 */

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';

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
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
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

describe('AgentModeService - LLM Timing Metadata', () => {
  let agentModeService: AgentModeService;
  let llmCallSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'test-session',
      userId: 'test-user',
      messages: [],
      workPlan: null,
      associatedSkills: [],
    });

    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = { getSetting: jest.fn().mockResolvedValue(null) };

    const mockDb = require('../services/db');
    mockDb.userDb = { getUserById: jest.fn().mockResolvedValue(null) };

    agentModeService = new AgentModeService();
    llmCallSpy = jest.spyOn(agentModeService as any, 'callLLM');
  });

  describe('iteration timing metadata', () => {
    it('should store iterationTimings with tool names in last assistant message metadata', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'search_web', arguments: '{}' } },
              { id: 'tc2', function: { name: 'create_task', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      // Find the last assistant message in responseMessages
      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);
      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      expect(lastAssistant.metadata).toBeDefined();
      expect(lastAssistant.metadata.iterationTimings).toBeDefined();
      expect(lastAssistant.metadata.iterationTimings).toHaveLength(2);

      // First iteration should have tool names
      expect(lastAssistant.metadata.iterationTimings[0].iteration).toBe(1);
      expect(lastAssistant.metadata.iterationTimings[0].toolNames).toEqual(['search_web', 'create_task']);
      expect(lastAssistant.metadata.iterationTimings[0].llmDurationMs).toBeGreaterThanOrEqual(0);

      // Second iteration should have no tools
      expect(lastAssistant.metadata.iterationTimings[1].iteration).toBe(2);
      expect(lastAssistant.metadata.iterationTimings[1].toolNames).toEqual([]);
    });

    it('should store iterationTimings even when no tool calls in response', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Simple response',
            tool_calls: null
          }
        }]
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);
      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      expect(lastAssistant.metadata).toBeDefined();
      expect(lastAssistant.metadata.iterationTimings).toBeDefined();
      expect(lastAssistant.metadata.iterationTimings).toHaveLength(1);
      expect(lastAssistant.metadata.iterationTimings[0].toolNames).toEqual([]);
      // Should not have toolCalls when no tools were called
      expect(lastAssistant.metadata.toolCalls).toBeUndefined();
    });
  });

  describe('tool execution duration in metadata', () => {
    it('should include duration in toolCalls metadata entries', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'get_website_info', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { success: true };
      });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      expect(lastAssistant.metadata.toolCalls).toBeDefined();
      expect(lastAssistant.metadata.toolCalls).toHaveLength(1);
      expect(lastAssistant.metadata.toolCalls[0].name).toBe('get_website_info');
      expect(lastAssistant.metadata.toolCalls[0].duration).toBeGreaterThanOrEqual(10);
    });

    it('should include duration for each tool when multiple tools are called', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'search_web', arguments: '{}' } },
              { id: 'tc2', function: { name: 'get_seo_metrics', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      expect(lastAssistant.metadata.toolCalls).toHaveLength(2);
      expect(lastAssistant.metadata.toolCalls[0].name).toBe('search_web');
      expect(typeof lastAssistant.metadata.toolCalls[0].duration).toBe('number');
      expect(lastAssistant.metadata.toolCalls[1].name).toBe('get_seo_metrics');
      expect(typeof lastAssistant.metadata.toolCalls[1].duration).toBe('number');
    });
  });

  describe('parallel tool execution', () => {
    it('should execute multiple tools concurrently (not sequentially)', async () => {
      const TOOL_DELAY_MS = 50;
      let inFlight = 0;
      let maxInFlight = 0;
      const starts: number[] = [];
      const ends: number[] = [];

      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'search_web', arguments: '{}' } },
              { id: 'tc2', function: { name: 'get_seo_metrics', arguments: '{}' } },
              { id: 'tc3', function: { name: 'get_website_info', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      // Each tool takes TOOL_DELAY_MS — if sequential, total >= 3 * TOOL_DELAY_MS
      // If parallel, total should be close to TOOL_DELAY_MS
      jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        starts.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, TOOL_DELAY_MS));
        ends.push(Date.now());
        inFlight--;
        return { success: true };
      });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      // Verify at least 2 tools were in-flight simultaneously.
      expect(maxInFlight).toBeGreaterThan(1);

      // Compute tool execution window only (exclude full-response overhead).
      const toolsWindowMs = Math.max(...ends) - Math.min(...starts);
      // Parallel window should be close to one delay, not N * delay.
      expect(toolsWindowMs).toBeLessThan(2 * TOOL_DELAY_MS);
    });

    it('should preserve tool result order matching original tool_calls order', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'tc2', function: { name: 'tool_b', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      // tool_b finishes before tool_a to test ordering is preserved
      const executeToolSpy = jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(
        async (...args: any[]) => {
          const toolName = args[1] as string;
          const delay = toolName === 'tool_a' ? 40 : 10;
          await new Promise(resolve => setTimeout(resolve, delay));
          return { result: `${toolName}_result` };
        }
      );
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockImplementation(
        (result: any) => result
      );

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      // Verify both tools were called
      expect(executeToolSpy).toHaveBeenCalledTimes(2);

      // Verify tool order in metadata matches original tool_calls order
      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      expect(lastAssistant.metadata.toolCalls[0].name).toBe('tool_a');
      expect(lastAssistant.metadata.toolCalls[1].name).toBe('tool_b');
    });

    it('should count pre-execution unavailable tools as failed tool calls', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: 'test-session',
        userId: 'test-user',
        messages: [],
        workPlan: null,
        associatedSkills: ['skill-html-create'],
      });

      const { skillService } = require('../services/skillService');
      skillService.getPublishedSkills.mockResolvedValue([
        {
          skillId: 'skill-html-create',
          name: 'HTML Create',
          description: 'Create HTML documents',
          toolNames: ['create_html_file'],
          isPublished: true,
        },
      ]);
      skillService.getSkillsByIds.mockResolvedValue([
        {
          skillId: 'skill-html-create',
          name: 'HTML Create',
          description: 'Create HTML documents',
          toolNames: ['create_html_file'],
          isPublished: true,
        },
      ]);

      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc-unavailable',
                function: {
                  name: 'update_html_file',
                  arguments: JSON.stringify({
                    file_url: 'https://example.com/report.html',
                    update_type: 'css',
                    operations_json: '[]',
                  }),
                },
              },
            ],
          },
        }],
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Recovered after installing the missing skill.',
            tool_calls: null,
          },
        }],
      });

      const executeToolSpy = jest.spyOn(agentModeService as any, 'executeTool');

      const result = await agentModeService.generateMarketingResponse(
        'Update the HTML file', [], 'test-user', 'test-model', 'test-session', true
      );

      expect(executeToolSpy).not.toHaveBeenCalled();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        id: 'tc-unavailable',
        name: 'update_html_file',
        error: 'Tool "update_html_file" is not available. You must install the required skill first using install_skills.',
        duration: 0,
      });
      expect(chatbotDb.incrementFailedFunctions).toHaveBeenCalledWith(
        'test-session',
        { update_html_file: 1 }
      );

      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      expect(lastAssistant.metadata.toolCalls).toHaveLength(1);
      expect(lastAssistant.metadata.toolCalls[0].error).toContain('not available');
    });

    it('should handle mixed success and failure in parallel tools', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'good_tool', arguments: '{}' } },
              { id: 'tc2', function: { name: 'bad_tool', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            role: 'assistant',
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(
        async (...args: any[]) => {
          const toolName = args[1] as string;
          if (toolName === 'bad_tool') throw new Error('Tool failed');
          return { success: true };
        }
      );
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });
      (chatbotDb.incrementFailedFunctions as jest.Mock) = jest.fn().mockResolvedValue({});

      const result = await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      // Check metadata has both tool entries with durations
      const assistantMessages = result.responseMessages.filter((m: any) => m.role === 'assistant');
      const lastAssistant = assistantMessages[assistantMessages.length - 1];

      expect(lastAssistant.metadata.toolCalls).toHaveLength(2);

      // good_tool should have result and duration
      const goodTool = lastAssistant.metadata.toolCalls.find((tc: any) => tc.name === 'good_tool');
      expect(goodTool).toBeDefined();
      expect(goodTool.result).toEqual({ success: true });
      expect(typeof goodTool.duration).toBe('number');

      // bad_tool should have error and duration
      const badTool = lastAssistant.metadata.toolCalls.find((tc: any) => tc.name === 'bad_tool');
      expect(badTool).toBeDefined();
      expect(badTool.error).toBe('Tool failed');
      expect(typeof badTool.duration).toBe('number');

      // Failed function counter should be updated for bad_tool
      expect(chatbotDb.incrementFailedFunctions).toHaveBeenCalledWith(
        'test-session',
        { bad_tool: 1 }
      );
    });
  });
});

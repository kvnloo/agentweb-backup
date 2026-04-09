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
import { settingsService } from '../services/settingsService';

// Mock dependencies
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../services/db', () => ({
  ...jest.requireActual('../services/db'),
  taskTemplateDb: {
    getAllTemplates: jest.fn().mockResolvedValue([]),
    getPublishedTemplates: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('../utils/secretsManager');

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
    }))
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
  })),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) })
  })),
  config: {
    update: jest.fn()
  }
}));

describe('AgentModeService - LLM Timing Metadata', () => {
  let agentModeService: AgentModeService;
  let llmCallSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock chatbotDb
    (chatbotDb.getChatSession as jest.Mock) = jest.fn().mockResolvedValue({
      sessionId: 'test-session',
      userId: 'test-user',
      messages: [],
      workPlan: null
    });
    (chatbotDb.addMessageToSession as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementCalledFunctions as jest.Mock) = jest.fn().mockResolvedValue({});

    // Mock settingsService.getSetting
    (settingsService.getSetting as jest.Mock) = jest.fn().mockResolvedValue(null);

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
        await new Promise(resolve => setTimeout(resolve, TOOL_DELAY_MS));
        return { success: true };
      });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      const start = Date.now();
      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );
      const elapsed = Date.now() - start;

      // If tools run in parallel, total should be well under 3 * TOOL_DELAY_MS
      // Allow generous margin for test overhead but reject clearly sequential execution
      expect(elapsed).toBeLessThan(3 * TOOL_DELAY_MS);
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

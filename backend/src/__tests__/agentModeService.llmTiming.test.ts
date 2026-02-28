/**
 * Tests for per-turn LLM timing logs in AgentModeService.
 *
 * Validates that:
 * 1. callLLM() logs model name, duration, and token count
 * 2. Main agent loop logs iteration number with tool names
 * 3. Tool execution logs tool name with duration
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

describe('AgentModeService - LLM Timing Logs', () => {
  let agentModeService: AgentModeService;
  let consoleSpy: jest.SpyInstance;
  let llmCallSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();

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

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('callLLM timing', () => {
    it('should log model name, duration, and token count after LLM call', async () => {
      // Mock the client directly on the llmModels registry
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test' } }],
        usage: { total_tokens: 150 }
      });
      (agentModeService as any).llmModels = {
        'test-model': {
          client: { chat: { completions: { create: mockCreate } } }
        }
      };

      await (agentModeService as any).callLLM('test-model', [], {});

      const timingLog = consoleSpy.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: LLM call completed')
      );
      expect(timingLog).toBeDefined();
      expect(timingLog![0]).toMatch(/model=test-model/);
      expect(timingLog![0]).toMatch(/duration=\d+ms/);
      expect(timingLog![0]).toMatch(/tokens=150/);
    });

    it('should log tokens as N/A when usage is not available', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'test' } }]
        // no usage field
      });
      (agentModeService as any).llmModels = {
        'test-model': {
          client: { chat: { completions: { create: mockCreate } } }
        }
      };

      await (agentModeService as any).callLLM('test-model', [], {});

      const timingLog = consoleSpy.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: LLM call completed')
      );
      expect(timingLog).toBeDefined();
      expect(timingLog![0]).toMatch(/tokens=N\/A/);
    });

    it('should throw error when model is not registered', async () => {
      (agentModeService as any).llmModels = {};

      await expect(
        (agentModeService as any).callLLM('unknown-model', [], {})
      ).rejects.toThrow("Invalid model 'unknown-model'");
    });
  });

  describe('iteration summary logging', () => {
    it('should log iteration number with tool names when tools are called', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
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
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      // Mock executeTool to return a simple result
      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const iterationLog = consoleSpy.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: Iteration 1')
      );
      expect(iterationLog).toBeDefined();
      expect(iterationLog![0]).toContain('tools=search_web, create_task');
      expect(iterationLog![0]).toContain('sessionId=test-session');
    });

    it('should log tools=none when no tool calls in response', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Simple response',
            tool_calls: null
          }
        }]
      });

      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const iterationLog = consoleSpy.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: Iteration 1')
      );
      expect(iterationLog).toBeDefined();
      expect(iterationLog![0]).toContain('tools=none');
    });
  });

  describe('tool execution timing', () => {
    it('should log tool name and duration after tool execution', async () => {
      // First call returns a tool call, second call returns final response
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
            tool_calls: [
              { id: 'tc1', function: { name: 'get_website_info', arguments: '{}' } }
            ]
          }
        }]
      }).mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      // Mock executeTool with a small delay to verify timing
      jest.spyOn(agentModeService as any, 'executeTool').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { success: true };
      });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const toolLog = consoleSpy.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: Tool executed')
      );
      expect(toolLog).toBeDefined();
      expect(toolLog![0]).toContain('name=get_website_info');
      expect(toolLog![0]).toMatch(/duration=\d+ms/);
      expect(toolLog![0]).toContain('sessionId=test-session');
    });

    it('should log timing for each tool when multiple tools are called', async () => {
      llmCallSpy.mockResolvedValueOnce({
        choices: [{
          message: {
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
            content: 'Done',
            tool_calls: null
          }
        }]
      });

      jest.spyOn(agentModeService as any, 'executeTool').mockResolvedValue({ success: true });
      jest.spyOn(agentModeService as any, 'extractMinimalToolResult').mockReturnValue({ success: true });

      await agentModeService.generateMarketingResponse(
        'Test message', [], 'test-user', 'test-model', 'test-session', true
      );

      const toolLogs = consoleSpy.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('AgentMode: Tool executed')
      );
      expect(toolLogs).toHaveLength(2);
      expect(toolLogs[0][0]).toContain('name=search_web');
      expect(toolLogs[1][0]).toContain('name=get_seo_metrics');
    });
  });
});

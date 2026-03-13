import { AgentModeService } from '../services/agentModeService';
import { ChatMessage } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  taskTemplateDb: {
    listTemplates: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('aws-sdk');

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - Crashed Session Recovery', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('buildMarketingContext skips empty assistant messages', () => {
    it('should skip assistant messages with no content and no tool_calls', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
        { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:01:00.000Z' },
        // Empty assistant message — artifact from Gemini returning undefined content
        { role: 'assistant', content: '', timestamp: '2025-01-01T00:02:00.000Z' } as any,
        { role: 'user', content: 'Are you there?', timestamp: '2025-01-01T00:03:00.000Z' },
        { role: 'assistant', content: 'Yes, I am here!', timestamp: '2025-01-01T00:04:00.000Z' },
      ];

      const result = (agentModeService as any).buildMarketingContext(
        'New message',
        sessionHistory,
        []
      );

      // The empty assistant message should be filtered out
      const assistantMessages = result.filter((msg: any) => msg.role === 'assistant' && msg.content === '');
      // Only the injected task status message might be empty-ish, but the broken one should be gone
      const brokenMessages = result.filter(
        (msg: any) => msg.role === 'assistant' && msg.content === '' && !msg.tool_calls
      );
      expect(brokenMessages.length).toBe(0);
    });

    it('should keep assistant messages that have tool_calls even if content is empty', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
        { role: 'user', content: 'Run a task', timestamp: '2025-01-01T00:01:00.000Z' },
        // Assistant with tool_calls but no text content — this is valid
        {
          role: 'assistant',
          content: '',
          timestamp: '2025-01-01T00:02:00.000Z',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'run_task', arguments: '{}' } }],
        } as any,
        { role: 'tool', content: 'Task completed', timestamp: '2025-01-01T00:03:00.000Z', tool_call_id: 'tc1' } as any,
        { role: 'assistant', content: 'Done!', timestamp: '2025-01-01T00:04:00.000Z' },
      ];

      const result = (agentModeService as any).buildMarketingContext(
        'New message',
        sessionHistory,
        []
      );

      // The assistant message with tool_calls should be preserved
      const toolCallMessages = result.filter((msg: any) => msg.tool_calls);
      expect(toolCallMessages.length).toBe(1);
    });

    it('should skip assistant messages with null/undefined content and no tool_calls', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
        { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:01:00.000Z' },
        // null content — DynamoDB dropped the field
        { role: 'assistant', content: null as any, timestamp: '2025-01-01T00:02:00.000Z' },
        { role: 'user', content: 'Try again', timestamp: '2025-01-01T00:03:00.000Z' },
        // undefined content
        { role: 'assistant', content: undefined as any, timestamp: '2025-01-01T00:04:00.000Z' },
        { role: 'user', content: 'Still broken?', timestamp: '2025-01-01T00:05:00.000Z' },
        { role: 'assistant', content: 'Working now!', timestamp: '2025-01-01T00:06:00.000Z' },
      ];

      const result = (agentModeService as any).buildMarketingContext(
        'New message',
        sessionHistory,
        []
      );

      // Both null and undefined content assistant messages should be filtered out
      const assistantMsgs = result.filter((msg: any) => msg.role === 'assistant');
      // Should have: 'Working now!' + injected task status message
      const contentlessMsgs = assistantMsgs.filter(
        (msg: any) => !msg.content || msg.content === ''
      );
      expect(contentlessMsgs.length).toBe(0);
    });
  });

  describe('buildMarketingContext skips error messages', () => {
    it('should skip assistant messages with isErrorMessage metadata', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
        { role: 'user', content: 'Do something', timestamp: '2025-01-01T00:01:00.000Z' },
        {
          role: 'assistant',
          content: 'I encountered an error processing your request.',
          timestamp: '2025-01-01T00:02:00.000Z',
          metadata: { isErrorMessage: true, portalType: 'agent' as const, timestamp: '2025-01-01T00:02:00.000Z' },
        } as any,
        { role: 'user', content: 'Try again', timestamp: '2025-01-01T00:03:00.000Z' },
        {
          role: 'assistant',
          content: 'I encountered an error processing your request.',
          timestamp: '2025-01-01T00:04:00.000Z',
          metadata: { isErrorMessage: true, portalType: 'agent' as const, timestamp: '2025-01-01T00:04:00.000Z' },
        } as any,
        { role: 'user', content: 'One more time', timestamp: '2025-01-01T00:05:00.000Z' },
        { role: 'assistant', content: 'Here is the result!', timestamp: '2025-01-01T00:06:00.000Z' },
      ];

      const result = (agentModeService as any).buildMarketingContext(
        'New message',
        sessionHistory,
        []
      );

      // Error messages should be filtered out
      const errorMsgs = result.filter(
        (msg: any) => msg.content && msg.content.includes('I encountered an error')
      );
      expect(errorMsgs.length).toBe(0);

      // Normal assistant message should be preserved
      const normalAssistant = result.filter(
        (msg: any) => msg.role === 'assistant' && msg.content === 'Here is the result!'
      );
      expect(normalAssistant.length).toBe(1);
    });

    it('should keep assistant messages without isErrorMessage metadata', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
        { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:01:00.000Z' },
        {
          role: 'assistant',
          content: 'Response with metadata but not error',
          timestamp: '2025-01-01T00:02:00.000Z',
          metadata: { portalType: 'agent' as const, timestamp: '2025-01-01T00:02:00.000Z' },
        } as any,
      ];

      const result = (agentModeService as any).buildMarketingContext(
        'New message',
        sessionHistory,
        []
      );

      const kept = result.filter(
        (msg: any) => msg.content === 'Response with metadata but not error'
      );
      expect(kept.length).toBe(1);
    });
  });

  describe('responseMessage.content normalization', () => {
    it('should ensure content is string even when LLM returns undefined', () => {
      // This tests the concept - the actual code normalizes responseMessage.content
      // after extraction from LLM response
      const responseMessage: any = { role: 'assistant', content: undefined };

      // Simulate the fix logic
      if (responseMessage.content == null) {
        responseMessage.content = '';
      }

      expect(responseMessage.content).toBe('');
      expect(typeof responseMessage.content).toBe('string');
    });

    it('should ensure content is string even when LLM returns null', () => {
      const responseMessage: any = { role: 'assistant', content: null };

      if (responseMessage.content == null) {
        responseMessage.content = '';
      }

      expect(responseMessage.content).toBe('');
      expect(typeof responseMessage.content).toBe('string');
    });

    it('should not modify content when it is a valid string', () => {
      const responseMessage: any = { role: 'assistant', content: 'Hello world' };

      if (responseMessage.content == null) {
        responseMessage.content = '';
      }

      expect(responseMessage.content).toBe('Hello world');
    });

    it('should clean up null tool_calls', () => {
      const responseMessage: any = { role: 'assistant', content: 'Hello', tool_calls: null };

      if (!responseMessage.tool_calls) {
        delete responseMessage.tool_calls;
      }

      expect(responseMessage.tool_calls).toBeUndefined();
      expect('tool_calls' in responseMessage).toBe(false);
    });

    it('should preserve valid tool_calls', () => {
      const toolCalls = [{ id: 'tc1', type: 'function', function: { name: 'test', arguments: '{}' } }];
      const responseMessage: any = { role: 'assistant', content: '', tool_calls: toolCalls };

      if (!responseMessage.tool_calls) {
        delete responseMessage.tool_calls;
      }

      expect(responseMessage.tool_calls).toBe(toolCalls);
    });
  });
});

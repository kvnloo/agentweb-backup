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

describe('AgentModeService - buildMarketingContext with Attachments', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('buildMarketingContext', () => {
    it('should include attachment URLs for user messages with attachments', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Please analyze this document',
          timestamp: '2025-01-01T00:01:00.000Z',
          metadata: {
            portalType: 'agent' as const,
            timestamp: '2025-01-01T00:01:00.000Z',
            attachments: [
              {
                filename: 'report.pdf',
                url: 'https://example.com/files/report.pdf',
                size: 1024000,
                mimetype: 'application/pdf',
                uploadedAt: '2025-01-01T00:00:30.000Z',
              },
            ],
          },
        },
        {
          role: 'assistant',
          content: 'I will analyze the document for you.',
          timestamp: '2025-01-01T00:02:00.000Z',
        },
      ];

      const messageContent = 'What are the key findings?';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      // Find the user message with attachments in the result
      const userMessageWithAttachment = result.find(
        (msg: any) => msg.role === 'user' && msg.content.includes('**Attached Files:**')
      );

      expect(userMessageWithAttachment).toBeDefined();
      expect(userMessageWithAttachment.content).toContain('Please analyze this document');
      expect(userMessageWithAttachment.content).toContain('**Attached Files:**');
      expect(userMessageWithAttachment.content).toContain('[report.pdf](https://example.com/files/report.pdf)');
    });

    it('should handle multiple attachments in a single message', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Compare these two files',
          timestamp: '2025-01-01T00:01:00.000Z',
          metadata: {
            portalType: 'agent' as const,
            timestamp: '2025-01-01T00:01:00.000Z',
            attachments: [
              {
                filename: 'file1.pdf',
                url: 'https://example.com/files/file1.pdf',
                size: 2048000,
                mimetype: 'application/pdf',
                uploadedAt: '2025-01-01T00:00:30.000Z',
              },
              {
                filename: 'file2.pdf',
                url: 'https://example.com/files/file2.pdf',
                size: 1536000,
                mimetype: 'application/pdf',
                uploadedAt: '2025-01-01T00:00:35.000Z',
              },
            ],
          },
        },
      ];

      const messageContent = 'What are the differences?';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      const userMessageWithAttachments = result.find(
        (msg: any) => msg.role === 'user' && msg.content.includes('**Attached Files:**')
      );

      expect(userMessageWithAttachments).toBeDefined();
      expect(userMessageWithAttachments.content).toContain('[file1.pdf](https://example.com/files/file1.pdf)');
      expect(userMessageWithAttachments.content).toContain('[file2.pdf](https://example.com/files/file2.pdf)');
    });

    it('should not modify user messages without attachments', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Hello, how are you?',
          timestamp: '2025-01-01T00:01:00.000Z',
          metadata: {
            portalType: 'agent' as const,
            timestamp: '2025-01-01T00:01:00.000Z',
            attachments: [],
          },
        },
      ];

      const messageContent = 'What is the weather today?';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      const userMessage = result.find(
        (msg: any) => msg.role === 'user' && msg.content === 'Hello, how are you?'
      );

      expect(userMessage).toBeDefined();
      expect(userMessage.content).not.toContain('**Attached Files:**');
      expect(userMessage.content).toBe('Hello, how are you?');
    });

    it('should handle user messages without metadata', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Hello',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
      ];

      const messageContent = 'What is the weather today?';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      const userMessage = result.find(
        (msg: any) => msg.role === 'user' && msg.content === 'Hello'
      );

      expect(userMessage).toBeDefined();
      expect(userMessage.content).not.toContain('**Attached Files:**');
    });

    it('should handle attachments with empty filename', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Look at this',
          timestamp: '2025-01-01T00:01:00.000Z',
          metadata: {
            portalType: 'agent' as const,
            timestamp: '2025-01-01T00:01:00.000Z',
            attachments: [
              {
                url: 'https://example.com/files/document.pdf',
                filename: '',
                size: 512000,
                mimetype: 'application/pdf',
                uploadedAt: '2025-01-01T00:00:30.000Z',
              },
            ],
          },
        },
      ];

      const messageContent = 'What do you think?';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      const userMessageWithAttachment = result.find(
        (msg: any) => msg.role === 'user' && msg.content.includes('**Attached Files:**')
      );

      expect(userMessageWithAttachment).toBeDefined();
      expect(userMessageWithAttachment.content).toContain('[Attachment](https://example.com/files/document.pdf)');
    });

    it('should preserve other message properties when adding attachments', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'assistant',
          content: 'I can help with that',
          timestamp: '2025-01-01T00:02:00.000Z',
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: {
                name: 'test_function',
                arguments: '{}',
              },
            },
          ],
        } as any,
        // tool result immediately follows — tool_calls should be preserved
        {
          role: 'tool',
          content: 'Done',
          timestamp: '2025-01-01T00:02:30.000Z',
          tool_call_id: 'call_123',
        } as any,
      ];

      const messageContent = 'Great!';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      const assistantMessage = result.find(
        (msg: any) => msg.role === 'assistant' && msg.content === 'I can help with that'
      );

      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.tool_calls).toBeDefined();
      expect(assistantMessage.tool_calls).toHaveLength(1);
      expect(assistantMessage.tool_calls[0].id).toBe('call_123');
    });

    it('should include attachments in messages within the 10-message window', () => {
      // Create a history with 15 user messages, where the 8th one has attachments
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ];

      for (let i = 0; i < 15; i++) {
        sessionHistory.push({
          role: 'user',
          content: `Message ${i + 1}`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          metadata: i === 7 ? { // 8th message (index 7) has attachments
            portalType: 'agent' as const,
            timestamp: new Date(Date.now() + i * 1000).toISOString(),
            attachments: [
              {
                filename: 'important.pdf',
                url: 'https://example.com/files/important.pdf',
                size: 3072000,
                mimetype: 'application/pdf',
                uploadedAt: new Date(Date.now() + i * 1000).toISOString(),
              },
            ],
          } : undefined,
        });

        sessionHistory.push({
          role: 'assistant',
          content: `Response to message ${i + 1}`,
          timestamp: new Date(Date.now() + i * 1000 + 500).toISOString(),
        });
      }

      const messageContent = 'Latest message';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      // The 8th user message should be within the 10-message window and have attachments
      const messageWithAttachment = result.find(
        (msg: any) => msg.role === 'user' && msg.content.includes('important.pdf')
      );

      expect(messageWithAttachment).toBeDefined();
      expect(messageWithAttachment.content).toContain('**Attached Files:**');
      expect(messageWithAttachment.content).toContain('[important.pdf](https://example.com/files/important.pdf)');
    });

    it('should append current user message with correct content', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Previous message',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
      ];

      const messageContent = 'Current message with attachments\n\n**Attached Files:**\n[file.pdf](https://example.com/file.pdf)';
      const currentTaskStatuses: any[] = [];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      // The last user message should be the current message
      const lastUserMessage = result.filter((msg: any) => msg.role === 'user').pop();

      expect(lastUserMessage).toBeDefined();
      expect(lastUserMessage.content).toBe(messageContent);
      expect(lastUserMessage.content).toContain('[file.pdf](https://example.com/file.pdf)');
    });

    it('should strip tool_calls from assistant message not followed by a tool result', () => {
      // Reproduces the ValidationException when a session was aborted mid-tool-call:
      // orphaned tool_use blocks cause Bedrock to return 400.
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Run the weekly report',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
        {
          role: 'assistant',
          content: '',
          timestamp: '2025-01-01T00:02:00.000Z',
          tool_calls: [
            { id: 'orphan_1', type: 'function', function: { name: 'run_task', arguments: '{}' } },
          ],
        } as any,
        // No tool result follows — the session was aborted
        {
          role: 'user',
          content: 'continue',
          timestamp: '2025-01-01T00:03:00.000Z',
        },
      ];

      const result = (agentModeService as any).buildMarketingContext('continue', sessionHistory, []);

      const assistantMsg = result.find((msg: any) => msg.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.tool_calls).toBeUndefined();
    });

    it('should preserve tool_calls when immediately followed by a tool result', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Run the weekly report',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
        {
          role: 'assistant',
          content: '',
          timestamp: '2025-01-01T00:02:00.000Z',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'run_task', arguments: '{}' } },
          ],
        } as any,
        {
          role: 'tool',
          content: 'Task completed successfully',
          timestamp: '2025-01-01T00:02:30.000Z',
          tool_call_id: 'call_1',
        } as any,
        {
          role: 'assistant',
          content: 'The task is done.',
          timestamp: '2025-01-01T00:03:00.000Z',
        },
      ];

      const result = (agentModeService as any).buildMarketingContext('What next?', sessionHistory, []);

      const assistantMsg = result.find((msg: any) => msg.role === 'assistant' && (msg as any).tool_calls);
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.tool_calls).toHaveLength(1);
      expect(assistantMsg.tool_calls[0].id).toBe('call_1');
    });

    it('should strip multiple orphaned tool_call messages', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'Do something',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
        {
          role: 'assistant',
          content: '',
          timestamp: '2025-01-01T00:02:00.000Z',
          tool_calls: [
            { id: 'orphan_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          ],
        } as any,
        // Second orphaned assistant tool call (no tool result between them either)
        {
          role: 'assistant',
          content: '',
          timestamp: '2025-01-01T00:02:10.000Z',
          tool_calls: [
            { id: 'orphan_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
          ],
        } as any,
        {
          role: 'user',
          content: 'continue',
          timestamp: '2025-01-01T00:03:00.000Z',
        },
      ];

      const result = (agentModeService as any).buildMarketingContext('continue', sessionHistory, []);

      const assistantsWithToolCalls = result.filter(
        (msg: any) => msg.role === 'assistant' && msg.tool_calls
      );
      expect(assistantsWithToolCalls).toHaveLength(0);
    });

    it('should include task statuses before the current user message', () => {
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
      ];

      const messageContent = 'What is the status?';
      const currentTaskStatuses = [
        {
          taskId: 'task-123',
          executionId: 'exec-456',
          taskName: 'Test Task',
          status: 'completed',
        },
      ];

      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        currentTaskStatuses
      );

      // Find the task status message
      const taskStatusMessage = result.find(
        (msg: any) => msg.role === 'assistant' && msg.content.includes('Current Task Statuses')
      );

      expect(taskStatusMessage).toBeDefined();
      expect(taskStatusMessage.content).toContain('Test Task');
      expect(taskStatusMessage.content).toContain('completed');
      expect(taskStatusMessage.content).toContain('✅');

      // Verify it comes before the current user message
      const taskStatusIndex = result.indexOf(taskStatusMessage);
      const lastUserMessageIndex = result.findIndex(
        (msg: any) => msg.role === 'user' && msg.content === messageContent
      );
      expect(taskStatusIndex).toBeLessThan(lastUserMessageIndex);
    });
  });
});


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

      // The orphaned tool_call assistant message must not leak into the context —
      // no assistant message may carry the unresolved tool_calls.
      const assistantWithToolCalls = result.find(
        (msg: any) => msg.role === 'assistant' && msg.tool_calls
      );
      expect(assistantWithToolCalls).toBeUndefined();
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

    it('should NOT inject a "no tasks have been run" assistant message when there are no task statuses (ENG-129)', () => {
      // Regression: an empty session used to push an assistant context message
      // reading "📋 Task Status: No tasks have been run in this session yet."
      // right before the user's message. On a terse confirmation (e.g.
      // "go with defaults") the model could parrot that injected assistant turn
      // verbatim instead of proceeding with the actual work. The empty-status
      // note carries no useful signal, so it must not be injected at all.
      const sessionHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'assistant',
          content: 'I propose 6 ad groups for the campaign. Should I proceed?',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
      ];

      const messageContent = 'go with defaults';

      // No task statuses (empty array)
      const result = (agentModeService as any).buildMarketingContext(
        messageContent,
        sessionHistory,
        []
      );

      // The misleading empty-status assistant message must not appear anywhere.
      const emptyStatusMessage = result.find(
        (msg: any) =>
          typeof msg.content === 'string' &&
          msg.content.includes('No tasks have been run in this session yet')
      );
      expect(emptyStatusMessage).toBeUndefined();

      // The last message is still the user's confirmation, adjacent to the real
      // assistant proposal (not separated by an injected status turn).
      const lastMessage = result[result.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe(messageContent);
    });

    describe('work plan all-steps-complete detection', () => {
      const baseHistory: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
        {
          role: 'user',
          content: 'continue',
          timestamp: '2025-01-01T00:01:00.000Z',
        },
      ];

      it('should inject ALL STEPS COMPLETE as a user message when every step is completed', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' },
            { stepCount: 2, title: 'Step 2', status: 'completed' },
            { stepCount: 3, title: 'Step 3', status: 'completed' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        // Guard uses user role so it appears as a direct instruction right before the response
        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'user' && /ALL \d+ STEPS ARE DONE/.test(msg.content)
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).toMatch(/ALL \d+ STEPS ARE DONE/);
        expect(workPlanMsg.content).toContain('DO NOT retry or re-execute any work plan steps');
        expect(workPlanMsg.content).toContain('help them with that new request normally');
        // Step details are NOT listed when all done (avoids LLM retrying them)
        expect(workPlanMsg.content).not.toContain('Step 1');
        expect(workPlanMsg.content).not.toContain('You MUST continue working');
      });

      it('should inject ALL STEPS COMPLETE when all steps are skipped', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'skipped' },
            { stepCount: 2, title: 'Step 2', status: 'skipped' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'user' && /ALL \d+ STEPS ARE DONE/.test(msg.content)
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).toMatch(/ALL \d+ STEPS ARE DONE/);
      });

      it('should inject ALL STEPS COMPLETE when steps are a mix of completed and skipped', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' },
            { stepCount: 2, title: 'Step 2', status: 'skipped' },
            { stepCount: 3, title: 'Step 3', status: 'completed' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'user' && /ALL \d+ STEPS ARE DONE/.test(msg.content)
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).toMatch(/ALL \d+ STEPS ARE DONE/);
        // Should show correct counts
        expect(workPlanMsg.content).toContain('2 completed');
        expect(workPlanMsg.content).toContain('1 skipped');
      });

      it('should NOT inject ALL STEPS COMPLETE when a pending step remains', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' },
            { stepCount: 2, title: 'Step 2', status: 'pending' },
            { stepCount: 3, title: 'Step 3', status: 'pending' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'assistant' && msg.content.includes('WORK PLAN')
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).not.toContain('ALL STEPS COMPLETE');
        expect(workPlanMsg.content).toContain('You MUST continue working');
      });

      it('should not show autocomplete instruction when all steps are done', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          autocomplete: true,
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'user' && /ALL \d+ STEPS ARE DONE/.test(msg.content)
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).toMatch(/ALL \d+ STEPS ARE DONE/);
        expect(workPlanMsg.content).not.toContain('AUTOCOMPLETE MODE');
      });

      it('should still show autocomplete instruction when steps remain and autocomplete is true', () => {
        const workPlan = {
          title: 'Ad Image Generation',
          autocomplete: true,
          steps: [
            { stepCount: 1, title: 'Step 1', status: 'completed' },
            { stepCount: 2, title: 'Step 2', status: 'pending' },
          ],
        };

        const result = (agentModeService as any).buildMarketingContext(
          'continue',
          baseHistory,
          [],
          workPlan
        );

        const workPlanMsg = result.find(
          (msg: any) => msg.role === 'assistant' && msg.content.includes('WORK PLAN')
        );
        expect(workPlanMsg).toBeDefined();
        expect(workPlanMsg.content).toContain('AUTOCOMPLETE MODE');
      });

      // Regression for the LinkedIn Ads "Generate 3 Images Per Hook" stall: a long
      // image step times out mid-run; on the user's nudge the still-pending step was
      // re-rendered with no memory of the images already produced, so the model
      // regenerated from scratch and never advanced. The fix scans the session's
      // "Image generated: X" system messages and surfaces them in the work-plan
      // context so the model generates only what's missing.
      describe('image-generation work plan resumption (asset awareness)', () => {
        const imageStepWorkPlan = {
          title: 'LinkedIn Ads Campaign generator',
          steps: [
            { stepCount: 1, title: 'Collect Campaign Inputs', status: 'completed' },
            { stepCount: 2, title: 'Write 6 Hooks & Ad Copy', status: 'completed' },
            {
              stepCount: 3,
              title: 'Generate 3 Images Per Hook',
              status: 'pending',
              requiredFunctionCalls: ['generate_image'],
            },
            { stepCount: 4, title: 'Generate Creative Hub Report', status: 'pending' },
          ],
        };

        it('surfaces already-generated image filenames so the model does not regenerate them', () => {
          const sessionHistory: ChatMessage[] = [
            { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
            { role: 'user', content: 'generate', timestamp: '2025-01-01T00:01:00.000Z' },
            { role: 'system', content: 'Image generated: xcures_h1_typographic.png', timestamp: '2025-01-01T00:02:00.000Z' },
            { role: 'system', content: 'Image generated: xcures_h1_dataclarity.png', timestamp: '2025-01-01T00:03:00.000Z' },
            { role: 'system', content: 'Image generated: xcures_h2_typographic.png', timestamp: '2025-01-01T00:04:00.000Z' },
            // Duplicate from a prior timed-out run must not be double-counted
            { role: 'system', content: 'Image generated: xcures_h1_typographic.png', timestamp: '2025-01-01T00:05:00.000Z' },
          ];

          const result = (agentModeService as any).buildMarketingContext(
            'go',
            sessionHistory,
            [],
            imageStepWorkPlan
          );

          const workPlanMsg = result.find(
            (msg: any) => msg.role === 'assistant' && msg.content.includes('WORK PLAN')
          );
          expect(workPlanMsg).toBeDefined();
          // Asset-awareness section present with the de-duplicated filenames
          expect(workPlanMsg.content).toContain('ALREADY-GENERATED ASSETS (3)');
          expect(workPlanMsg.content).toContain('xcures_h1_typographic.png');
          expect(workPlanMsg.content).toContain('xcures_h1_dataclarity.png');
          expect(workPlanMsg.content).toContain('xcures_h2_typographic.png');
          expect(workPlanMsg.content).toMatch(/DO NOT regenerate/i);
          // Progression guidance so the step actually advances
          expect(workPlanMsg.content).toContain('STEP PROGRESSION');
          expect(workPlanMsg.content).toContain('set_work_plan_status');
        });

        it('omits the asset section when no images have been generated yet', () => {
          const sessionHistory: ChatMessage[] = [
            { role: 'system', content: 'You are a helpful assistant', timestamp: '2025-01-01T00:00:00.000Z' },
            { role: 'user', content: 'start', timestamp: '2025-01-01T00:01:00.000Z' },
          ];

          const result = (agentModeService as any).buildMarketingContext(
            'go',
            sessionHistory,
            [],
            imageStepWorkPlan
          );

          const workPlanMsg = result.find(
            (msg: any) => msg.role === 'assistant' && msg.content.includes('WORK PLAN')
          );
          expect(workPlanMsg).toBeDefined();
          expect(workPlanMsg.content).not.toContain('ALREADY-GENERATED ASSETS');
          // Progression guidance still present
          expect(workPlanMsg.content).toContain('STEP PROGRESSION');
        });
      });
    });
  });
});


// ENG-510: already-generated-asset awareness must be surfaced even WITHOUT a work plan,
// so a "continue" after a mid-batch timeout regenerates only the still-missing images —
// including one that landed in the orphaned worker after the whole-turn cap.
describe('AgentModeService - already-generated asset awareness (ENG-510)', () => {
  const agentModeService = new AgentModeService();

  const imgMarker = (filename: string, ts: string): ChatMessage => ({
    role: 'system',
    content: `Image generated: ${filename}`,
    timestamp: ts,
    metadata: { timestamp: ts, kind: 'image-generated', imageFilename: filename, imageUrl: `https://s3/${filename}` },
  } as any);

  describe('buildGeneratedAssetsAwarenessText', () => {
    it('returns empty string when there are no generated images', () => {
      expect(AgentModeService.buildGeneratedAssetsAwarenessText(undefined)).toBe('');
      expect(AgentModeService.buildGeneratedAssetsAwarenessText([])).toBe('');
    });

    it('lists every filename with a do-not-regenerate instruction', () => {
      const text = AgentModeService.buildGeneratedAssetsAwarenessText(['icon-sun.png', 'icon-moon.png']);
      expect(text).toContain('ALREADY-GENERATED ASSETS (2)');
      expect(text).toContain('DO NOT regenerate them');
      expect(text).toContain('- icon-sun.png');
      expect(text).toContain('- icon-moon.png');
    });
  });

  describe('standalone injection (no work plan)', () => {
    it('surfaces already-generated images on a continue turn with no work plan', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are EMMA', timestamp: '2026-07-24T06:46:00.000Z' },
        { role: 'user', content: 'Generate a sun, a moon, and a star icon', timestamp: '2026-07-24T06:47:00.000Z' },
        imgMarker('icon-sun.png', '2026-07-24T06:54:00.000Z'),
        imgMarker('icon-moon.png', '2026-07-24T06:56:00.000Z'),
        // completed in the orphaned worker AFTER the cap — marker present, no toolCalls stamp
        imgMarker('icon-star.png', '2026-07-24T06:58:00.000Z'),
        { role: 'user', content: 'continue', timestamp: '2026-07-24T06:59:00.000Z' },
      ];

      const result = (agentModeService as any).buildMarketingContext('continue', sessionHistory, []);
      const awareness = result.find(
        (m: any) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('ALREADY-GENERATED ASSETS')
      );
      expect(awareness).toBeDefined();
      // the orphan-window image (star) must be listed so it is NOT redone
      expect(awareness.content).toContain('icon-star.png');
      expect(awareness.content).toContain('icon-sun.png');
      expect(awareness.content).toContain('icon-moon.png');
      expect(awareness.content).toContain('ALREADY-GENERATED ASSETS (3)');
    });

    it('injects nothing when no images have been generated', () => {
      const sessionHistory: ChatMessage[] = [
        { role: 'system', content: 'You are EMMA', timestamp: '2026-07-24T06:46:00.000Z' },
        { role: 'user', content: 'continue', timestamp: '2026-07-24T06:59:00.000Z' },
      ];
      const result = (agentModeService as any).buildMarketingContext('continue', sessionHistory, []);
      const awareness = result.find(
        (m: any) => typeof m.content === 'string' && m.content.includes('ALREADY-GENERATED ASSETS')
      );
      expect(awareness).toBeUndefined();
    });
  });
});

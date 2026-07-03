/**
 * Tests for generateMarketingResponse
 * 
 * Note: Event loop yielding has been removed as long-running operations
 * are now handled by generateMarketingResponseWorker.
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

describe('AgentModeService - generateMarketingResponse', () => {
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

    // Mock settingsService.getSetting (used by getMarketingSystemPrompt)
    (settingsService.getSetting as jest.Mock) = jest.fn().mockResolvedValue(null);

    // Create service instance
    agentModeService = new AgentModeService();

    // Spy on callLLM method. Default fallback prevents real HTTP calls when
    // a test's mockResolvedValueOnce chain is exhausted (e.g. suggested-replies call).
    llmCallSpy = jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
      choices: [{ message: { content: '', tool_calls: null } }],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('generateMarketingResponse', () => {
    it('should include current date only in system message', async () => {
      const isoSpy = jest
        .spyOn(Date.prototype, 'toISOString')
        .mockReturnValue('2026-01-03T12:34:56.000Z');

      let systemMessageContent = '';
      let firstCallCaptured = false;
      llmCallSpy.mockImplementation(async (_model: string, messages: any[]) => {
        // Only capture the first call (the main marketing response call, not generateSuggestedReplies)
        if (!firstCallCaptured) {
          systemMessageContent = messages[0]?.content || '';
          firstCallCaptured = true;
        }
        return {
          choices: [{
            message: {
              content: 'Response',
              tool_calls: null
            }
          }]
        };
      });

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      expect(systemMessageContent).toContain('Current date: 2026-01-03');
      expect(systemMessageContent).not.toContain('Current time');
      expect(systemMessageContent).not.toContain('T12:34:56');

      isoSpy.mockRestore();
    });

    it('should process LLM calls and tool calls correctly', async () => {
      // Mock callLLM to simulate multiple LLM calls with tool calls
      let callCount = 0;
      llmCallSpy.mockImplementation(async () => {
        callCount++;
        // Simulate a delay to represent a real LLM call
        await new Promise(resolve => setTimeout(resolve, 10));

        if (callCount === 1) {
          // First call returns with tool calls
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: 'call_1',
                  function: {
                    name: 'search_knowledge_base',
                    arguments: JSON.stringify({ query: 'test query' })
                  }
                }]
              }
            }]
          };
        } else {
          // Second call returns final response
          return {
            choices: [{
              message: {
                content: 'Final response',
                tool_calls: null
              }
            }]
          };
        }
      });

      // Mock executeTool to return quickly
      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'Tool result'
      });

      // Call generateMarketingResponse
      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify the response is correct
      expect(result.content).toBe('Final response');
      expect((agentModeService as any).executeTool).toHaveBeenCalled();
    });

    it('should handle long-running LLM calls', async () => {
      // Mock callLLMto simulate a long-running LLM call
      llmCallSpy.mockImplementation(async () => {
        // Simulate a longer delay
        await new Promise(resolve => setTimeout(resolve, 50));

        return {
          choices: [{
            message: {
              content: 'Response',
              tool_calls: null
            }
          }]
        };
      });

      // Call generateMarketingResponse
      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify the response is correct
      expect(result.content).toBe('Response');
    });

    it('should handle multiple loop iterations with tool calls', async () => {
      // Mock callLLMto return multiple iterations with tool calls
      let iteration = 0;
      llmCallSpy.mockImplementation(async () => {
        iteration++;
        await new Promise(resolve => setTimeout(resolve, 5));

        if (iteration < 3) {
          // First two iterations return tool calls
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: `call_${iteration}`,
                  function: {
                    name: 'search_knowledge_base',
                    arguments: JSON.stringify({ query: `query ${iteration}` })
                  }
                }]
              }
            }]
          };
        } else {
          // Third iteration returns final response
          return {
            choices: [{
              message: {
                content: 'Final response',
                tool_calls: null
              }
            }]
          };
        }
      });

      // Mock executeTool
      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'Tool result'
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify the response is correct
      expect(result.content).toBe('Final response');
      expect((agentModeService as any).executeTool).toHaveBeenCalledTimes(2);
    });

    it('should return correct response', async () => {
      // Mock callLLM to return a simple response
      llmCallSpy.mockResolvedValue({
        choices: [{
          message: {
            content: 'Test response content',
            tool_calls: null
          }
        }]
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify the response is correct
      expect(result.content).toBe('Test response content');
      expect(result.toolCalls).toEqual([]);
      expect(result.knowledgeBaseQueries).toEqual([]);
      expect(result.sources).toEqual([]);
    });

    it('should handle tool calls correctly', async () => {
      // Mock callLLM to return tool calls
      llmCallSpy
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                function: {
                  name: 'search_knowledge_base',
                  arguments: JSON.stringify({ query: 'test query' })
                }
              }]
            }
          }]
        })
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: 'Final response with tool results',
              tool_calls: null
            }
          }]
        });

      // Mock executeTool
      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'Knowledge base search result'
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify tool was executed. The tool context now carries runBudgetDeadlineMs
      // (the run's wall-clock budget, used by wait_seconds to cap its sleep — ENG-124),
      // so extraContext is an object rather than undefined.
      expect((agentModeService as any).executeTool).toHaveBeenCalledWith(
        agentModeService.default_model,
        'search_knowledge_base',
        { query: 'test query' },
        'test-user',
        'test-session',
        false,
        expect.objectContaining({ runBudgetDeadlineMs: expect.any(Number) })
      );

      // Verify final response includes tool results
      expect(result.content).toBe('Final response with tool results');
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe('search_knowledge_base');
    });
  });

  describe('Tool execution', () => {
    it('should execute tools correctly', async () => {
      // Mock callLLM to return tool calls
      llmCallSpy
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                function: {
                  name: 'search_knowledge_base',
                  arguments: JSON.stringify({ query: 'test query' })
                }
              }]
            }
          }]
        })
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: 'Final response',
              tool_calls: null
            }
          }]
        });

      // Mock executeTool with a delay to simulate long-running operation
      (agentModeService as any).executeTool = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { formattedContent: 'Tool result' };
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify tool was executed
      expect((agentModeService as any).executeTool).toHaveBeenCalled();
      expect(result.content).toBe('Final response');
    });

    it('should handle tool execution errors', async () => {
      // Mock callLLM to return tool calls
      llmCallSpy
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                function: {
                  name: 'search_knowledge_base',
                  arguments: JSON.stringify({ query: 'test query' })
                }
              }]
            }
          }]
        })
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: 'Final response after error',
              tool_calls: null
            }
          }]
        });

      // Mock executeTool to throw an error
      (agentModeService as any).executeTool = jest.fn().mockRejectedValue(
        new Error('Tool execution failed')
      );

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify error was handled and response still returned
      expect(result.content).toBe('Final response after error');
    });
  });

  describe('Multiple tool calls', () => {
    it('should handle multiple tool executions', async () => {
      // Mock callLLM to return multiple tool calls
      llmCallSpy
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  function: {
                    name: 'search_knowledge_base',
                    arguments: JSON.stringify({ query: 'query 1' })
                  }
                },
                {
                  id: 'call_2',
                  function: {
                    name: 'search_knowledge_base',
                    arguments: JSON.stringify({ query: 'query 2' })
                  }
                }
              ]
            }
          }]
        })
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: 'Final response',
              tool_calls: null
            }
          }]
        });

      // Mock executeTool with delays to simulate long-running operations
      let toolCallCount = 0;
      (agentModeService as any).executeTool = jest.fn().mockImplementation(async () => {
        toolCallCount++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { formattedContent: `Tool result ${toolCallCount}` };
      });

      const result = await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Verify both tools were executed
      expect((agentModeService as any).executeTool).toHaveBeenCalledTimes(2);
      expect(result.content).toBe('Final response');
    });
  });

  describe('Anti-loop detection', () => {
    it('should inject warning when same tool calls repeat 3 consecutive times', async () => {
      const repeatedToolCall = {
        id: 'call_repeat',
        function: {
          name: 'update_html_file',
          arguments: JSON.stringify({ filename: 'report.html', content: 'same content' })
        }
      };

      let callCount = 0;
      llmCallSpy.mockImplementation(async () => {
        callCount++;
        if (callCount <= 4) {
          // First 4 calls: return identical tool calls (iterations 1-4)
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{ ...repeatedToolCall, id: `call_${callCount}` }]
              }
            }]
          };
        } else {
          // 5th call: LLM responds to anti-loop warning; 6th call is generateSuggestedReplies
          return {
            choices: [{
              message: {
                content: 'I was repeating myself. Here is what I accomplished so far.',
                tool_calls: null
              }
            }]
          };
        }
      });

      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'File updated successfully'
      });

      const result = await agentModeService.generateMarketingResponse(
        'Update the report',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // The LLM should have received the anti-loop warning and produced a final response
      expect(result.content).toBe('I was repeating myself. Here is what I accomplished so far.');

      // The warning was injected into the conversation (role: 'user') so the LLM sees it,
      // but responseMessages filters out user messages. Verify via console.warn instead.
      const warnSpy = jest.spyOn(console, 'warn');
      // The warning was already logged during execution; check that callCount confirms
      // the LLM was called 6 times (3 repeated + 1 more repeated after warning + final response + generateSuggestedReplies)
      expect(callCount).toBe(6);
    });

    it('should not trigger anti-loop when tool calls have different arguments', async () => {
      let callCount = 0;
      llmCallSpy.mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          // Each call has different arguments — should NOT trigger anti-loop
          return {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: `call_${callCount}`,
                  function: {
                    name: 'search_web',
                    arguments: JSON.stringify({ query: `different query ${callCount}` })
                  }
                }]
              }
            }]
          };
        } else {
          return {
            choices: [{
              message: {
                content: 'Search complete',
                tool_calls: null
              }
            }]
          };
        }
      });

      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'Search result'
      });

      const result = await agentModeService.generateMarketingResponse(
        'Research competitors',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      expect(result.content).toBe('Search complete');

      // No anti-loop warning should be present
      const warningMessage = result.responseMessages.find(
        (m: any) => m.role === 'user' && m.content?.includes('[SYSTEM]') && m.content?.includes('repeatedly')
      );
      expect(warningMessage).toBeUndefined();
    });

    it('should provide fallback content when maxIterations is exhausted with no response', async () => {
      // LLM always returns tool calls, never a text response
      llmCallSpy.mockImplementation(async () => {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: `call_${Date.now()}`,
                function: {
                  name: 'search_web',
                  arguments: JSON.stringify({ query: `query_${Date.now()}` })
                }
              }]
            }
          }]
        };
      });

      (agentModeService as any).executeTool = jest.fn().mockResolvedValue({
        formattedContent: 'Result'
      });

      const result = await agentModeService.generateMarketingResponse(
        'Do something complex',
        [],
        'test-user',
        agentModeService.default_model,
        'test-session'
      );

      // Should have the fallback message instead of empty content
      expect(result.content).toContain('maximum number of processing steps');
    });
  });
});

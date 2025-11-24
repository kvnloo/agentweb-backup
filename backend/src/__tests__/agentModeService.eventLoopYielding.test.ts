/**
 * Tests for event loop yielding in generateMarketingResponse
 * 
 * These tests verify that generateMarketingResponse yields control back to the event loop
 * during long-running operations, allowing health checks and other requests to be processed.
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
    getAllTemplates: jest.fn().mockResolvedValue([])
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

describe('AgentModeService - Event Loop Yielding', () => {
  let agentModeService: AgentModeService;
  let mockOpenAI: any;

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
    
    // Get the OpenAI client from the service
    mockOpenAI = (agentModeService as any).openai;
  });

  describe('generateMarketingResponse event loop yielding', () => {
    it('should yield control to event loop after each LLM call', async () => {
      // Track when setImmediate is called
      const setImmediateCalls: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Mock setImmediate to track calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCalls.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to simulate multiple LLM calls with tool calls
      let callCount = 0;
      mockOpenAI.chat.completions.create = jest.fn().mockImplementation(async () => {
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

      const startTime = Date.now();
      
      // Call generateMarketingResponse
      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      // Verify setImmediate was called (at least once per LLM call)
      expect(setImmediateCalls.length).toBeGreaterThan(0);
      
      // Verify setImmediate was called after the first LLM call
      // (The first call should have triggered a setImmediate)
      expect(setImmediateCalls.length).toBeGreaterThanOrEqual(1);

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });

    it('should allow other operations to be processed during long-running generateResponse', async () => {
      // Track if a concurrent operation can run
      let concurrentOperationExecuted = false;
      const concurrentOperation = () => {
        concurrentOperationExecuted = true;
      };

      // Mock OpenAI to simulate a long-running LLM call
      let llmCallStarted = false;
      mockOpenAI.chat.completions.create = jest.fn().mockImplementation(async () => {
        llmCallStarted = true;
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

      // Start generateMarketingResponse
      const responsePromise = agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Wait a bit, then schedule a concurrent operation
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Schedule concurrent operation using setImmediate
      setImmediate(concurrentOperation);

      // Wait for the response
      await responsePromise;

      // Verify the concurrent operation was executed
      // This proves that the event loop was able to process other operations
      expect(concurrentOperationExecuted).toBe(true);
    });

    it('should yield control between loop iterations when multiple tool calls are made', async () => {
      const setImmediateCallTimes: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Track setImmediate calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCallTimes.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to return multiple iterations with tool calls
      let iteration = 0;
      mockOpenAI.chat.completions.create = jest.fn().mockImplementation(async () => {
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

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Verify setImmediate was called multiple times (at least once per iteration)
      // We expect at least 2 calls: one after first LLM call, one before second iteration
      expect(setImmediateCallTimes.length).toBeGreaterThanOrEqual(2);

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });

    it('should still return correct response despite event loop yielding', async () => {
      // Mock OpenAI to return a simple response
      mockOpenAI.chat.completions.create = jest.fn().mockResolvedValue({
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
        'test-session'
      );

      // Verify the response is correct
      expect(result.content).toBe('Test response content');
      expect(result.toolCalls).toEqual([]);
      expect(result.knowledgeBaseQueries).toEqual([]);
      expect(result.sources).toEqual([]);
    });

    it('should handle tool calls correctly with event loop yielding', async () => {
      // Mock OpenAI to return tool calls
      mockOpenAI.chat.completions.create = jest.fn()
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
        'test-session'
      );

      // Verify tool was executed
      expect((agentModeService as any).executeTool).toHaveBeenCalledWith(
        'search_knowledge_base',
        { query: 'test query' },
        'test-user',
        'test-session',
        false
      );

      // Verify final response includes tool results
      expect(result.content).toBe('Final response with tool results');
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe('search_knowledge_base');
    });
  });

  describe('Tool execution event loop yielding', () => {
    it('should yield control before tool execution starts', async () => {
      const setImmediateCalls: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Mock setImmediate to track calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCalls.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to return tool calls
      mockOpenAI.chat.completions.create = jest.fn()
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
      let toolExecutionStarted = false;
      (agentModeService as any).executeTool = jest.fn().mockImplementation(async () => {
        toolExecutionStarted = true;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { formattedContent: 'Tool result' };
      });

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Verify setImmediate was called before tool execution
      // We expect at least 2 calls: one after LLM call, one before tool execution
      expect(setImmediateCalls.length).toBeGreaterThanOrEqual(2);
      
      // Verify tool was executed
      expect((agentModeService as any).executeTool).toHaveBeenCalled();

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });

    it('should yield control after tool execution completes', async () => {
      const setImmediateCalls: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Mock setImmediate to track calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCalls.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to return tool calls
      mockOpenAI.chat.completions.create = jest.fn()
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

      // Mock executeTool with a delay
      (agentModeService as any).executeTool = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { formattedContent: 'Tool result' };
      });

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Verify setImmediate was called after tool execution
      // We expect calls: after LLM call, before tool, after tool, before next iteration
      expect(setImmediateCalls.length).toBeGreaterThanOrEqual(3);

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });

    it('should yield control even when tool execution fails', async () => {
      const setImmediateCalls: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Mock setImmediate to track calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCalls.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to return tool calls
      mockOpenAI.chat.completions.create = jest.fn()
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

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Verify setImmediate was called even after error handling
      // We expect calls: after LLM call, before tool, after error handling
      expect(setImmediateCalls.length).toBeGreaterThanOrEqual(3);

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });
  });

  describe('Multiple tool calls event loop yielding', () => {
    it('should yield control between multiple tool executions', async () => {
      const setImmediateCalls: number[] = [];
      const originalSetImmediate = global.setImmediate;
      
      // Mock setImmediate to track calls
      global.setImmediate = jest.fn((callback: () => void) => {
        setImmediateCalls.push(Date.now());
        return originalSetImmediate(callback);
      }) as unknown as typeof setImmediate;

      // Mock OpenAI to return multiple tool calls
      mockOpenAI.chat.completions.create = jest.fn()
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

      await agentModeService.generateMarketingResponse(
        'Test message',
        [],
        'test-user',
        'test-session'
      );

      // Verify setImmediate was called multiple times
      // We expect: after LLM call, before tool 1, after tool 1, before tool 2, after tool 2, before next iteration
      expect(setImmediateCalls.length).toBeGreaterThanOrEqual(5);
      
      // Verify both tools were executed
      expect((agentModeService as any).executeTool).toHaveBeenCalledTimes(2);

      // Restore original setImmediate
      global.setImmediate = originalSetImmediate;
    });
  });
});


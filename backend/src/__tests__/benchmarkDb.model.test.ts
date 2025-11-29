// Mock AWS SDK BEFORE importing db
jest.mock('aws-sdk', () => {
  const mockDocClient = {
    scan: jest.fn(),
    query: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({
      putObject: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
    SecretsManager: jest.fn(),
    config: {
      update: jest.fn(),
    },
  };
});

import { benchmarkTestDb } from '../services/db';
import AWS from 'aws-sdk';

describe('BenchmarkTestDb - Model Selection and Size Limit Handling', () => {
  let mockDocClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get the mocked DocumentClient instance
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDocClient = new DocumentClient();
  });

  describe('addTestResult - Size Limit Error Handling', () => {
    const testId = 'test-123';
    const testResult = {
      testId,
      runId: 'run-456',
      status: 'success',
      passed: true,
      actualResponse: 'Test response',
      actualFunctionCalls: ['function1'],
      keywordMatches: ['keyword1'],
      keywordMisses: [],
      functionCallMatches: ['function1'],
      functionCallMisses: [],
      executionTime: 100,
      llmModel: 'gpt-5-chat-2',
      createdAt: new Date().toISOString(),
    };

    it('should successfully add test result when no size limit error', async () => {
      const mockAttributes = {
        testId,
        testHistory: [testResult],
        updatedAt: new Date().toISOString(),
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: mockAttributes,
        }),
      });

      const result = await benchmarkTestDb.addTestResult(testId, testResult);

      expect(result).toEqual(mockAttributes);
      expect(mockDocClient.update).toHaveBeenCalledTimes(1);
      expect(mockDocClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { testId },
          UpdateExpression: expect.stringContaining('list_append'),
        })
      );
    });

    it('should handle size limit error by keeping last 10 records', async () => {
      // First call fails with size limit error
      const sizeLimitError = {
        code: 'ValidationException',
        message: 'Item size to update has exceeded the maximum allowed size',
      };

      // Mock test with 15 history records
      const testHistory = Array.from({ length: 15 }, (_, i) => ({
        testId,
        runId: `run-${i}`,
        status: 'success',
        passed: true,
        actualResponse: `Response ${i}`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: [],
        functionCallMatches: [],
        functionCallMisses: [],
        executionTime: 100,
        createdAt: new Date().toISOString(),
      }));

      const currentTest = {
        testId,
        testHistory,
      };

      // Expected: keep last 10 records (indices 5-14)
      const expectedHistory = testHistory.slice(-10);

      mockDocClient.update
        .mockReturnValueOnce({
          promise: jest.fn().mockRejectedValue(sizeLimitError),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Attributes: {
              testId,
              testHistory: expectedHistory,
              updatedAt: new Date().toISOString(),
            },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Attributes: {
              testId,
              testHistory: [...expectedHistory, testResult],
              updatedAt: new Date().toISOString(),
            },
          }),
        });

      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: currentTest,
        }),
      });

      const result = await benchmarkTestDb.addTestResult(testId, testResult);

      // Verify get was called to fetch current test
      expect(mockDocClient.get).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { testId },
        })
      );

      // Verify cleanup update was called
      expect(mockDocClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { testId },
          UpdateExpression: 'SET #testHistory = :updatedHistory, #updatedAt = :updatedAt',
          ExpressionAttributeValues: expect.objectContaining({
            ':updatedHistory': expectedHistory,
          }),
        })
      );

      // Verify retry update was called
      expect(mockDocClient.update).toHaveBeenCalledTimes(3);
      expect(result.testHistory).toHaveLength(11); // 10 kept + 1 new
    });

    it('should handle size limit error when test has less than 10 records', async () => {
      const sizeLimitError = {
        code: 'ValidationException',
        message: 'Item size to update has exceeded the maximum allowed size',
      };

      // Mock test with only 5 history records
      const testHistory = Array.from({ length: 5 }, (_, i) => ({
        testId,
        runId: `run-${i}`,
        status: 'success',
        passed: true,
        actualResponse: `Response ${i}`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: [],
        functionCallMatches: [],
        functionCallMisses: [],
        executionTime: 100,
        createdAt: new Date().toISOString(),
      }));

      const currentTest = {
        testId,
        testHistory,
      };

      // Should keep all 5 records (slice(-10) keeps all if less than 10)
      const expectedHistory = testHistory.slice(-10);

      mockDocClient.update
        .mockReturnValueOnce({
          promise: jest.fn().mockRejectedValue(sizeLimitError),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Attributes: {
              testId,
              testHistory: expectedHistory,
              updatedAt: new Date().toISOString(),
            },
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Attributes: {
              testId,
              testHistory: [...expectedHistory, testResult],
              updatedAt: new Date().toISOString(),
            },
          }),
        });

      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: currentTest,
        }),
      });

      const result = await benchmarkTestDb.addTestResult(testId, testResult);

      expect(mockDocClient.update).toHaveBeenCalledTimes(3);
      expect(result.testHistory).toHaveLength(6); // 5 kept + 1 new
    });

    it('should throw error if test not found during cleanup', async () => {
      const sizeLimitError = {
        code: 'ValidationException',
        message: 'Item size to update has exceeded the maximum allowed size',
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(sizeLimitError),
      });

      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: null, // Test not found
        }),
      });

      await expect(benchmarkTestDb.addTestResult(testId, testResult)).rejects.toThrow('Test not found');
    });

    it('should throw error if no test history to remove', async () => {
      const sizeLimitError = {
        code: 'ValidationException',
        message: 'Item size to update has exceeded the maximum allowed size',
      };

      const currentTest = {
        testId,
        testHistory: [], // No history
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(sizeLimitError),
      });

      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: currentTest,
        }),
      });

      await expect(benchmarkTestDb.addTestResult(testId, testResult)).rejects.toThrow(
        'Item size limit exceeded but no test history to remove'
      );
    });

    it('should not handle non-size-limit errors', async () => {
      const otherError = {
        code: 'ResourceNotFoundException',
        message: 'Table not found',
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(otherError),
      });

      await expect(benchmarkTestDb.addTestResult(testId, testResult)).rejects.toEqual(otherError);
      expect(mockDocClient.get).not.toHaveBeenCalled();
    });

    it('should handle cleanup update failure', async () => {
      const sizeLimitError = {
        code: 'ValidationException',
        message: 'Item size to update has exceeded the maximum allowed size',
      };

      const cleanupError = new Error('Cleanup failed');

      const testHistory = Array.from({ length: 15 }, (_, i) => ({
        testId,
        runId: `run-${i}`,
        status: 'success',
        passed: true,
        actualResponse: `Response ${i}`,
        actualFunctionCalls: [],
        keywordMatches: [],
        keywordMisses: [],
        functionCallMatches: [],
        functionCallMisses: [],
        executionTime: 100,
        createdAt: new Date().toISOString(),
      }));

      const currentTest = {
        testId,
        testHistory,
      };

      mockDocClient.update
        .mockReturnValueOnce({
          promise: jest.fn().mockRejectedValue(sizeLimitError),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockRejectedValue(cleanupError),
        });

      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: currentTest,
        }),
      });

      await expect(benchmarkTestDb.addTestResult(testId, testResult)).rejects.toThrow(
        'Failed to add test result and cleanup failed'
      );
    });
  });

  describe('createBenchmarkTest - Model Selection', () => {
    it('should create test with provided llmModel', async () => {
      const benchmarkTest = {
        testId: 'test-123',
        createdBy: 'admin-123',
        sessionId: 'session-456',
        userId: 'user-789',
        testName: 'Test Name',
        description: 'Test Description',
        conversationHistory: {
          messages: [],
        },
        expectedOutput: {
          keywords: ['keyword1'],
          functionCalls: ['function1'],
        },
        status: 'draft',
        llmModel: 'gpt-5-chat-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      mockDocClient.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await benchmarkTestDb.createBenchmarkTest(benchmarkTest);

      expect(result).toEqual(benchmarkTest);
      expect(mockDocClient.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            llmModel: 'gpt-5-chat-2',
          }),
        })
      );
    });

    it('should create test without llmModel if not provided', async () => {
      const benchmarkTest = {
        testId: 'test-123',
        createdBy: 'admin-123',
        sessionId: 'session-456',
        userId: 'user-789',
        testName: 'Test Name',
        conversationHistory: {
          messages: [],
        },
        expectedOutput: {},
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      mockDocClient.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await benchmarkTestDb.createBenchmarkTest(benchmarkTest);

      expect(result).toEqual(benchmarkTest);
      expect(mockDocClient.put).toHaveBeenCalled();
    });
  });

  describe('updateBenchmarkTest - Model Selection', () => {
    it('should update test with llmModel', async () => {
      const testId = 'test-123';
      const updates = {
        testName: 'Updated Test Name',
        llmModel: 'gpt-5-chat-2',
        status: 'active',
      };

      const mockAttributes = {
        testId,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: mockAttributes,
        }),
      });

      const result = await benchmarkTestDb.updateBenchmarkTest(testId, updates);

      expect(result).toEqual(mockAttributes);
      expect(mockDocClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { testId },
          UpdateExpression: expect.stringContaining('#llmModel'),
          ExpressionAttributeNames: expect.objectContaining({
            '#llmModel': 'llmModel',
          }),
          ExpressionAttributeValues: expect.objectContaining({
            ':val1': 'gpt-5-chat-2', // Order may vary, check for the value
          }),
        })
      );
      // Verify llmModel is in the expression attribute values
      const updateCall = mockDocClient.update.mock.calls[0][0];
      expect(Object.values(updateCall.ExpressionAttributeValues)).toContain('gpt-5-chat-2');
    });

    it('should update test without llmModel if not in updates', async () => {
      const testId = 'test-123';
      const updates = {
        testName: 'Updated Test Name',
        status: 'active',
      };

      const mockAttributes = {
        testId,
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: mockAttributes,
        }),
      });

      const result = await benchmarkTestDb.updateBenchmarkTest(testId, updates);

      expect(result).toEqual(mockAttributes);
      expect(mockDocClient.update).toHaveBeenCalled();
      // Verify llmModel is not in the update expression
      const updateCall = mockDocClient.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeNames).not.toHaveProperty('#llmModel');
    });
  });
});


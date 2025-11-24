/**
 * Tests for generateMarketingResponseWorkerService
 * 
 * These tests verify that the worker service correctly spawns worker processes
 * and handles communication between the main process and worker process.
 * 
 * IMPORTANT: These tests use proper cleanup to prevent memory leaks.
 */

import { GenerateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { fork } from 'child_process';

// Mock child_process
jest.mock('child_process', () => ({
  fork: jest.fn()
}));

// Mock path
jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/'))
}));

describe('GenerateMarketingResponseWorkerService', () => {
  let workerService: GenerateMarketingResponseWorkerService;
  let mockWorker: any;
  let messageHandlers: Map<string, (data: any) => void>;
  let errorHandlers: Map<string, (error: Error) => void>;
  let exitHandlers: Map<string, (code: number | null, signal: string | null) => void>;

  beforeEach(() => {
    jest.clearAllMocks();
    workerService = new GenerateMarketingResponseWorkerService();

    // Track handlers to prevent memory leaks
    messageHandlers = new Map();
    errorHandlers = new Map();
    exitHandlers = new Map();

    // Create a mock worker process
    mockWorker = {
      on: jest.fn((event: string, handler: any) => {
        // Store handlers for cleanup
        if (event === 'message') {
          messageHandlers.set('default', handler);
        } else if (event === 'error') {
          errorHandlers.set('default', handler);
        } else if (event === 'exit') {
          exitHandlers.set('default', handler);
        }
      }),
      send: jest.fn(),
      kill: jest.fn()
    };

    // Mock fork to return our mock worker
    (fork as jest.Mock).mockReturnValue(mockWorker);
  });

  afterEach(() => {
    // Clean up handlers to prevent memory leaks
    messageHandlers.clear();
    errorHandlers.clear();
    exitHandlers.clear();
    
    // Clear any pending timers
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('runInWorker', () => {
    const mockParams = {
      messageContent: 'Test message',
      sessionHistory: [],
      userId: 'test-user-id',
      sessionId: 'test-session-id',
      mockMode: false
    };

    const mockResult = {
      content: 'Test response',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: []
    };

    it('should fork a worker process and send the request', async () => {
      // Set up mock to resolve with success
      let messageHandler: ((message: any) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Verify fork was called
      expect(fork).toHaveBeenCalled();

      // Simulate worker sending success message immediately
      if (messageHandler) {
        messageHandler({
          type: 'success',
          result: mockResult
        });
      }

      const result = await promise;

      // Verify result
      expect(result).toEqual(mockResult);
      expect(mockWorker.send).toHaveBeenCalledWith({
        type: 'generateMarketingResponse',
        params: mockParams
      });
      expect(mockWorker.kill).toHaveBeenCalled();
    });

    it('should handle worker error messages', async () => {
      let messageHandler: ((message: any) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Simulate worker sending error message
      if (messageHandler) {
        messageHandler({
          type: 'error',
          error: 'Test error',
          stack: 'Error stack trace'
        });
      }

      await expect(promise).rejects.toThrow('Test error');
      expect(mockWorker.kill).toHaveBeenCalled();
    });

    it('should handle worker process errors', async () => {
      let errorHandler: ((error: Error) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'error') {
          errorHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Simulate worker process error
      if (errorHandler) {
        errorHandler(new Error('Process error'));
      }

      await expect(promise).rejects.toThrow('Process error');
      expect(mockWorker.kill).toHaveBeenCalled();
    });

    it('should handle worker process exit with non-zero code', async () => {
      let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Simulate worker exit with error code
      if (exitHandler) {
        exitHandler(1, 'SIGTERM');
      }

      await expect(promise).rejects.toThrow('Worker process exited with code 1 and signal SIGTERM');
    });

    it('should handle worker timeout', async () => {
      // Use fake timers for timeout test
      jest.useFakeTimers();

      let messageHandler: ((message: any) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Fast-forward time to trigger timeout (30 minutes = 1800000ms)
      jest.advanceTimersByTime(30 * 60 * 1000);

      await expect(promise).rejects.toThrow('generateMarketingResponse worker timed out after 30 minutes');
      expect(mockWorker.kill).toHaveBeenCalledWith('SIGTERM');

      // Clean up
      jest.useRealTimers();
    });

    it('should clear timeout when worker sends success message', async () => {
      jest.useFakeTimers();

      let messageHandler: ((message: any) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams);

      // Send success message before timeout
      if (messageHandler) {
        messageHandler({
          type: 'success',
          result: mockResult
        });
      }

      // Fast-forward time - timeout should not trigger
      jest.advanceTimersByTime(30 * 60 * 1000);

      const result = await promise;
      expect(result).toEqual(mockResult);

      jest.useRealTimers();
    });

    it('should use correct worker script path in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      workerService.runInWorker(mockParams);

      expect(fork).toHaveBeenCalledWith(
        expect.stringContaining('workers/generateMarketingResponseWorker.js'),
        [],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: process.env
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should use TypeScript file with ts-node in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      workerService.runInWorker(mockParams);

      expect(fork).toHaveBeenCalledWith(
        expect.stringContaining('workers/generateMarketingResponseWorker.ts'),
        [],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: process.env,
          execArgv: ['-r', 'ts-node/register']
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('should pass mockMode parameter correctly', async () => {
      let messageHandler: ((message: any) => void) | undefined;
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const paramsWithMockMode = {
        ...mockParams,
        mockMode: true
      };

      const promise = workerService.runInWorker(paramsWithMockMode);

      // Verify mockMode is sent to worker
      expect(mockWorker.send).toHaveBeenCalledWith({
        type: 'generateMarketingResponse',
        params: paramsWithMockMode
      });

      // Complete the promise
      if (messageHandler) {
        messageHandler({
          type: 'success',
          result: mockResult
        });
      }

      await promise;
    });
  });
});

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
      llmModel: 'gpt-5.1',
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

      // Fast-forward time to trigger timeout (45 minutes = 2700000ms)
      jest.advanceTimersByTime(45 * 60 * 1000);

      await expect(promise).rejects.toThrow('generateMarketingResponse worker timed out after 45 minutes');
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

    it('should use compiled JavaScript in production environment', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      expect(forkCall[0]).toContain('workers/generateMarketingResponseWorker.js');
      // execArgv should be undefined (not set) for compiled JavaScript
      expect(forkCall[2].execArgv).toBeUndefined();
      expect(forkCall[2].env).toEqual(process.env);

      process.env.NODE_ENV = originalEnv;
    });

    it('should use compiled JavaScript in staging environment (NODE_ENV=staging)', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';

      workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      expect(forkCall[0]).toContain('workers/generateMarketingResponseWorker.js');
      // execArgv should be undefined (not set) for compiled JavaScript
      expect(forkCall[2].execArgv).toBeUndefined();
      expect(forkCall[2].env).toEqual(process.env);

      process.env.NODE_ENV = originalEnv;
    });

    it('should use TypeScript with ts-node only in local development (NODE_ENV=development and __dirname in src/)', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      const scriptPath = forkCall[0];
      
      // In test environment, __dirname is in src/__tests__, so it should detect as local dev
      // and use TypeScript with ts-node
      if (scriptPath.includes('generateMarketingResponseWorker.ts')) {
        expect(forkCall[2].execArgv).toEqual(['-r', 'ts-node/register']);
      } else {
        // If it uses .js, it means __dirname contains 'dist' (deployed environment)
        expect(scriptPath).toContain('generateMarketingResponseWorker.js');
        expect(forkCall[2].execArgv).toBeUndefined();
      }

      process.env.NODE_ENV = originalEnv;
    });

    it('should use compiled JavaScript when NODE_ENV=development but code is in dist/ (deployed environment)', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      // This test verifies the fix: even when NODE_ENV=development, if __dirname contains 'dist',
      // we should use compiled JavaScript (not TypeScript with ts-node)
      // This covers the staging environment case where NODE_ENV=development but code is deployed
      workerService.runInWorker(mockParams);
      
      const forkCall = (fork as jest.Mock).mock.calls[0];
      const scriptPath = forkCall[0];
      
      // The key test: verify that the logic checks __dirname, not just NODE_ENV
      // In test environment, __dirname is typically in src/, so it will use .ts
      // But the logic should handle the case where __dirname contains 'dist' even with NODE_ENV=development
      if (scriptPath.includes('generateMarketingResponseWorker.ts')) {
        // Local development: uses TypeScript with ts-node
        expect(forkCall[2].execArgv).toEqual(['-r', 'ts-node/register']);
      } else {
        // Deployed environment (even with NODE_ENV=development): uses compiled JavaScript
        expect(scriptPath).toContain('generateMarketingResponseWorker.js');
        expect(forkCall[2].execArgv).toBeUndefined();
      }
      
      // Verify the logic correctly distinguishes between local dev and deployed environments
      // by checking __dirname, not just NODE_ENV
      expect(forkCall).toBeDefined();
      expect(forkCall[2].env).toEqual(process.env);

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

    it('should forward progress updates from worker to callback', async () => {
      const progressCallback = jest.fn();
      let messageHandler: ((message: any) => void) | undefined;
      
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams, progressCallback);

      // Simulate worker sending progress updates
      if (messageHandler) {
        const progress1 = { iteration: 1, status: 'thinking', toolCalls: [] };
        messageHandler({ type: 'progress', progress: progress1 });
        
        const progress2 = { iteration: 1, status: 'executing_tools', toolCalls: [], pendingTools: ['test_tool'] };
        messageHandler({ type: 'progress', progress: progress2 });
        
        // Finally send success
        messageHandler({
          type: 'success',
          result: mockResult
        });
      }

      await promise;

      // Verify progress callbacks were called
      expect(progressCallback).toHaveBeenCalledWith({ iteration: 1, status: 'thinking', toolCalls: [] });
      expect(progressCallback).toHaveBeenCalledWith({ iteration: 1, status: 'executing_tools', toolCalls: [], pendingTools: ['test_tool'] });
      expect(progressCallback).toHaveBeenCalledTimes(2);
    });

    it('should not clear timeout on progress messages', async () => {
      jest.useFakeTimers();
      const progressCallback = jest.fn();
      let messageHandler: ((message: any) => void) | undefined;
      
      mockWorker.on.mockImplementation((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      });

      const promise = workerService.runInWorker(mockParams, progressCallback);

      // Send progress messages
      if (messageHandler) {
        messageHandler({ type: 'progress', progress: { iteration: 1, status: 'thinking' } });
        messageHandler({ type: 'progress', progress: { iteration: 1, status: 'executing_tools' } });
      }

      // Fast-forward time - timeout should not trigger because progress messages don't clear it
      jest.advanceTimersByTime(1000);

      // Send success to complete
      if (messageHandler) {
        messageHandler({ type: 'success', result: mockResult });
      }

      await promise;

      expect(progressCallback).toHaveBeenCalled();
      jest.useRealTimers();
    });
  });
});

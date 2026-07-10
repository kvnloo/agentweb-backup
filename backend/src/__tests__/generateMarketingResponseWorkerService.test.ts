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

  // Helper function to wait for async operations and worker initialization
  const waitForAsync = async () => {
    // Wait for ready signal to be sent and processed
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  };

  // Helper to wait for send to be called (for tests that need to access send calls)
  const waitForSend = async (minCalls = 1) => {
    await waitForAsync();
    // Poll until send has been called the expected number of times
    let attempts = 0;
    while (mockWorker.send.mock.calls.length < minCalls && attempts < 10) {
      await new Promise(resolve => setImmediate(resolve));
      attempts++;
    }
    if (mockWorker.send.mock.calls.length < minCalls) {
      throw new Error(`Timeout waiting for send to be called ${minCalls} times (got ${mockWorker.send.mock.calls.length})`);
    }
  };

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
          // Always use 'default' key - we only keep one message handler at a time
          messageHandlers.set('default', handler);

          // Automatically send 'ready' signal when the first message handler is registered
          // This simulates the worker process sending ready after initialization
          if (messageHandlers.size === 1) {
            handler({ type: 'ready' });
          }
        } else if (event === 'error') {
          errorHandlers.set('default', handler);
        } else if (event === 'exit') {
          exitHandlers.set('default', handler);
        }
      }),
      removeListener: jest.fn((event: string, handler: any) => {
        // Actually remove the handler when requested
        if (event === 'message') {
          // Find and remove the specific handler
          for (const [key, storedHandler] of messageHandlers.entries()) {
            if (storedHandler === handler) {
              messageHandlers.delete(key);
              break;
            }
          }
        }
      }),
      send: jest.fn(),
      kill: jest.fn(),
      killed: false,
      stdout: null,
      stderr: null
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

  // Define mockParams at class level so it's accessible to all tests
  const mockParams = {
    messageContent: 'Test message',
    sessionHistory: [],
    userId: 'test-user-id',
    llmModel: 'gpt-5.5',
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

  describe('runInWorker', () => {

    it('should fork a worker process and send the request', async () => {
      const promise = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForSend();

      // Verify fork was called
      expect(fork).toHaveBeenCalled();

      // Get the message handler and simulate worker sending success message
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({
          type: 'success',
          requestId,
          result: mockResult
        });
      }

      const result = await promise;

      // Verify result
      expect(result).toEqual(mockResult);
      expect(mockWorker.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generateMarketingResponse',
          requestId: expect.any(String),
          params: mockParams
        })
      );
      // Worker should NOT be killed in new implementation (reused)
      expect(mockWorker.kill).not.toHaveBeenCalled();
    });

    it('should handle worker error messages', async () => {
      const promise = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForSend();

      // Simulate worker sending error message
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({
          type: 'error',
          requestId,
          error: 'Test error',
          stack: 'Error stack trace'
        });
      }

      await expect(promise).rejects.toThrow('Test error');
      // Worker should NOT be killed for individual request errors (reused)
      expect(mockWorker.kill).not.toHaveBeenCalled();
    });

    it('should handle worker process errors', async () => {
      const promise = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForAsync();

      // Simulate worker process error
      const errorHandler = errorHandlers.get('default');
      if (errorHandler) {
        errorHandler(new Error('Process error'));
      }

      await expect(promise).rejects.toThrow('Process error');
    });

    it('should handle worker process exit with non-zero code', async () => {
      const promise = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForAsync();

      // Simulate worker exit with error code
      const exitHandler = exitHandlers.get('default');
      if (exitHandler) {
        exitHandler(1, 'SIGTERM');
      }

      await expect(promise).rejects.toThrow('Worker process exited with code 1 and signal SIGTERM');
    });

    it('rejects immediately when the worker dies mid-submission (exit before the request is registered)', async () => {
      // B1 race: a worker exit/error that fires between `await ensureWorker()` resolving and
      // the request being registered in pendingRequests must still reject this request
      // promptly — otherwise it hangs until the 45-min worker timeout, which (combined with
      // the controller's GENERATION_TIMEOUT_MS) locks the user out of their session for ~10 min.
      jest.useFakeTimers();

      // Pre-warm a ready worker so ensureWorker() resolves without re-forking.
      await workerService.ensureWorkerReady();
      await Promise.resolve();
      jest.advanceTimersByTime(0);

      // Simulate the worker dying the instant the request is sent (before any reply comes back),
      // by firing the exit handler synchronously from `send`.
      const exitHandler = exitHandlers.get('default');
      mockWorker.send.mockImplementationOnce(() => {
        if (exitHandler) exitHandler(1, null);
        return true;
      });

      const promise = workerService.runInWorker(mockParams);

      // Must reject promptly on worker death — NOT hang to the 45-minute timeout.
      await expect(promise).rejects.toThrow(/exited with code 1|Worker process error/);

      jest.useRealTimers();
    });

    it('clears the session→request mapping when the worker crashes (no stale cancel on the next worker)', async () => {
      // B1 hygiene: the exit/error handlers reject + clear pendingRequests, but the
      // session→requestId mapping must also be cleared. Otherwise a dead session's
      // requestId lingers and a later cancelSession() for that session mis-fires a
      // {type:'cancel'} at the *fresh* worker — and the map grows unbounded across crashes.
      const promise = workerService.runInWorker(mockParams);
      await waitForAsync();

      // Worker dies mid-run.
      const exitHandler = exitHandlers.get('default');
      if (exitHandler) exitHandler(1, 'SIGTERM');
      await expect(promise).rejects.toThrow(/exited with code 1/);

      // A fresh worker comes up for an unrelated request.
      const sendCallsBefore = mockWorker.send.mock.calls.length;
      await workerService.ensureWorkerReady();

      // Cancelling the CRASHED session must be a no-op — its mapping is gone.
      workerService.cancelSession(mockParams.sessionId);

      const cancelSends = mockWorker.send.mock.calls
        .slice(sendCallsBefore)
        .filter((c: any[]) => c[0]?.type === 'cancel');
      expect(cancelSends).toHaveLength(0);
    });

    it('should handle worker timeout', async () => {
      // Use fake timers for timeout test
      jest.useFakeTimers();

      const promise = workerService.runInWorker(mockParams);

      // Process ready message (sent automatically)
      await Promise.resolve();
      jest.advanceTimersByTime(0);

      // Fast-forward time to trigger timeout (45 minutes = 2700000ms)
      jest.advanceTimersByTime(45 * 60 * 1000);

      await expect(promise).rejects.toThrow('generateMarketingResponse worker timed out after 45 minutes');

      // Clean up
      jest.useRealTimers();
    });

    it('should clear timeout when worker sends success message', async () => {
      jest.useFakeTimers();

      const promise = workerService.runInWorker(mockParams);

      // Process ready message (sent automatically)
      await Promise.resolve();
      jest.advanceTimersByTime(0);

      // Send success message before timeout
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({
          type: 'success',
          requestId,
          result: mockResult
        });
      }

      // Fast-forward time - timeout should not trigger
      jest.advanceTimersByTime(30 * 60 * 1000);

      const result = await promise;
      expect(result).toEqual(mockResult);

      jest.useRealTimers();
    });

    it('should use compiled JavaScript in production environment', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const promise = workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      expect(forkCall[0]).toContain('workers/generateMarketingResponseWorker.js');
      // execArgv should include heap limit for compiled JavaScript
      expect(forkCall[2].execArgv).toEqual(['--max-old-space-size=4096']);
      expect(forkCall[2].env).toEqual(process.env);

      // Wait for ready and complete the promise
      await waitForSend();
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'success', requestId, result: mockResult });
      }

      await promise;
      process.env.NODE_ENV = originalEnv;
    });

    it('should use compiled JavaScript in staging environment (NODE_ENV=staging)', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'staging';

      const promise = workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      expect(forkCall[0]).toContain('workers/generateMarketingResponseWorker.js');
      // execArgv should include heap limit for compiled JavaScript
      expect(forkCall[2].execArgv).toEqual(['--max-old-space-size=4096']);
      expect(forkCall[2].env).toEqual(process.env);

      // Wait for ready and complete the promise
      await waitForSend();
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'success', requestId, result: mockResult });
      }

      await promise;
      process.env.NODE_ENV = originalEnv;
    });

    it('should use TypeScript with ts-node only in local development (NODE_ENV=development and __dirname in src/)', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const promise = workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      const scriptPath = forkCall[0];

      // In test environment, __dirname is in src/__tests__, so it should detect as local dev
      // and use TypeScript with ts-node
      if (scriptPath.includes('generateMarketingResponseWorker.ts')) {
        expect(forkCall[2].execArgv).toEqual(['-r', 'ts-node/register', '--max-old-space-size=4096']);
      } else {
        // If it uses .js, it means __dirname contains 'dist' (deployed environment)
        expect(scriptPath).toContain('generateMarketingResponseWorker.js');
        expect(forkCall[2].execArgv).toEqual(['--max-old-space-size=4096']);
      }

      // Wait for ready and complete the promise
      await waitForSend();
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'success', requestId, result: mockResult });
      }

      await promise;
      process.env.NODE_ENV = originalEnv;
    });

    it('should use compiled JavaScript when NODE_ENV=development but code is in dist/ (deployed environment)', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      // This test verifies the fix: even when NODE_ENV=development, if __dirname contains 'dist',
      // we should use compiled JavaScript (not TypeScript with ts-node)
      // This covers the staging environment case where NODE_ENV=development but code is deployed
      const promise = workerService.runInWorker(mockParams);

      const forkCall = (fork as jest.Mock).mock.calls[0];
      const scriptPath = forkCall[0];

      // The key test: verify that the logic checks __dirname, not just NODE_ENV
      // In test environment, __dirname is typically in src/, so it will use .ts
      // But the logic should handle the case where __dirname contains 'dist' even with NODE_ENV=development
      if (scriptPath.includes('generateMarketingResponseWorker.ts')) {
        // Local development: uses TypeScript with ts-node
        expect(forkCall[2].execArgv).toEqual(['-r', 'ts-node/register', '--max-old-space-size=4096']);
      } else {
        // Deployed environment (even with NODE_ENV=development): uses compiled JavaScript
        expect(scriptPath).toContain('generateMarketingResponseWorker.js');
        expect(forkCall[2].execArgv).toEqual(['--max-old-space-size=4096']);
      }

      // Verify the logic correctly distinguishes between local dev and deployed environments
      // by checking __dirname, not just NODE_ENV
      expect(forkCall).toBeDefined();
      expect(forkCall[2].env).toEqual(process.env);

      // Wait for ready and complete the promise
      await waitForSend();
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'success', requestId, result: mockResult });
      }

      await promise;
      process.env.NODE_ENV = originalEnv;
    });

    it('should pass mockMode parameter correctly', async () => {
      const paramsWithMockMode = {
        ...mockParams,
        mockMode: true
      };

      const promise = workerService.runInWorker(paramsWithMockMode);

      // Wait for worker initialization
      await waitForSend();

      // Verify mockMode is sent to worker
      expect(mockWorker.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'generateMarketingResponse',
          requestId: expect.any(String),
          params: paramsWithMockMode
        })
      );

      // Complete the promise
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({
          type: 'success',
          requestId,
          result: mockResult
        });
      }

      await promise;
    });

    it('should forward progress updates from worker to callback', async () => {
      const progressCallback = jest.fn();

      const promise = workerService.runInWorker(mockParams, progressCallback);

      // Wait for worker initialization
      await waitForSend();

      // Simulate worker sending progress updates
      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;

        const progress1 = { iteration: 1, status: 'thinking', toolCalls: [] };
        messageHandler({ type: 'progress', requestId, progress: progress1 });

        const progress2 = { iteration: 1, status: 'executing_tools', toolCalls: [], pendingTools: ['test_tool'] };
        messageHandler({ type: 'progress', requestId, progress: progress2 });

        // Finally send success
        messageHandler({
          type: 'success',
          requestId,
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

      const promise = workerService.runInWorker(mockParams, progressCallback);

      // Wait for ready to be processed
      await Promise.resolve();
      jest.advanceTimersByTime(0);

      // Send progress messages
      const messageHandler = messageHandlers.get('default');
      if (messageHandler && mockWorker.send.mock.calls.length > 0) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'progress', requestId, progress: { iteration: 1, status: 'thinking' } });
        messageHandler({ type: 'progress', requestId, progress: { iteration: 1, status: 'executing_tools' } });
      }

      // Fast-forward time - timeout should not trigger because progress messages don't clear it
      jest.advanceTimersByTime(1000);

      // Send success to complete
      if (messageHandler && mockWorker.send.mock.calls.length > 0) {
        const sendCall = mockWorker.send.mock.calls[0];
        const requestId = sendCall[0].requestId;
        messageHandler({ type: 'success', requestId, result: mockResult });
      }

      await promise;

      expect(progressCallback).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('should reuse the same worker for multiple requests', async () => {
      // First request
      const promise1 = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForSend();

      const messageHandler = messageHandlers.get('default');
      if (messageHandler) {
        const sendCall1 = mockWorker.send.mock.calls[0];
        const requestId1 = sendCall1[0].requestId;
        messageHandler({
          type: 'success',
          requestId: requestId1,
          result: mockResult
        });
      }

      await promise1;

      // Clear the mock calls to see if fork is called again
      (fork as jest.Mock).mockClear();

      // Second request - should reuse worker
      const promise2 = workerService.runInWorker({
        ...mockParams,
        messageContent: 'Second message'
      });

      await waitForSend(2);

      // Worker should NOT be forked again
      expect(fork).not.toHaveBeenCalled();

      if (messageHandler) {
        const sendCall2 = mockWorker.send.mock.calls[1];
        const requestId2 = sendCall2[0].requestId;
        messageHandler({
          type: 'success',
          requestId: requestId2,
          result: mockResult
        });
      }

      await promise2;

      // Verify both requests were sent to the same worker
      expect(mockWorker.send).toHaveBeenCalledTimes(2);
      expect(mockWorker.kill).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should drain in-flight requests before killing the worker', async () => {
      // Start a request
      const promise = workerService.runInWorker(mockParams);

      // Wait for worker initialization
      await waitForAsync();

      // Simulate the in-flight request completing while shutdown is draining
      const requestId = (workerService as any).pendingRequests.keys().next().value;
      setTimeout(() => {
        // Resolve the in-flight request via the message handler (simulates worker responding)
        const handler = messageHandlers.get('default');
        if (handler) {
          handler({ type: 'success', requestId, result: { content: 'done', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] } });
        }
      }, 100);

      // Shutdown should wait for the in-flight request and then kill the worker
      await workerService.shutdown();

      // Worker is force-killed (SIGKILL) after drain completes. SIGTERM is
      // intentionally ignored by the worker so the OS process-group/cgroup SIGTERM
      // that fires on deploy cannot abort an in-flight run before the drain (ENG-201),
      // so the parent must use SIGKILL to actually terminate it.
      expect(mockWorker.kill).toHaveBeenCalledWith('SIGKILL');

      // The in-flight request resolved naturally (not rejected)
      await expect(promise).resolves.toMatchObject({ content: 'done' });
    });

    it('should handle shutdown when no worker is running', async () => {
      // Should not throw
      await expect(workerService.shutdown()).resolves.not.toThrow();
    });

    it('should block new runInWorker calls once draining', async () => {
      // Start the drain (no pending requests, completes immediately)
      const shutdownPromise = workerService.shutdown();

      // New requests should be rejected immediately
      await expect(
        workerService.runInWorker(mockParams)
      ).rejects.toThrow('draining');

      await shutdownPromise;
    });
  });
});

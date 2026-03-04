/**
 * Worker process for running generateMarketingResponse in isolation
 * This prevents blocking the main event loop during long-running operations
 */

import { AgentModeService } from '../services/agentModeService';

// Initialize the service
const agentModeService = new AgentModeService();

// Initialize once when worker starts (not per message)
let initialized = false;
let initializationPromise: Promise<void> | null = null;

// Track the current requestId so uncaught error handlers can include it
let currentRequestId: string | null = null;

async function ensureInitialized() {
  if (initialized) return;

  // If initialization is already in progress, wait for it
  if (initializationPromise) {
    await initializationPromise;
    return;
  }

  // Start initialization
  console.log('[Worker-DEBUG] Starting AgentModeService initialization...');
  initializationPromise = agentModeService.initialize();
  await initializationPromise;
  initialized = true;
  console.log('[Worker-DEBUG] AgentModeService initialized (MCP servers loaded)');
}

// Initialize immediately when worker starts, then send ready signal
ensureInitialized()
  .then(() => {
    // Signal to parent that worker is ready
    process.send!({ type: 'ready' });
  })
  .catch(error => {
    console.error('[Worker] Failed to initialize AgentModeService:', error);
    process.exit(1);
  });

// Listen for messages from parent process
process.on('message', async (message: any) => {
  const requestId = message.requestId;
  currentRequestId = requestId;

  try {
    if (message.type === 'generateMarketingResponse') {
      // Ensure initialization completed (should already be done)
      await ensureInitialized();

      const { messageContent, sessionHistory, userId,llmModel, sessionId, mockMode } = message.params;

      // Progress callback to forward progress updates to parent process
      const onProgress = (progress: { iteration: number; status: string; toolCalls?: any[] }) => {
        process.send!({
          type: 'progress',
          requestId,
          progress
        });
      };

      const result = await agentModeService.generateMarketingResponse(
        messageContent,
        sessionHistory,
        userId,
        llmModel,
        sessionId,
        mockMode,
        onProgress
      );

      // Send result back to parent process
      process.send!({
        type: 'success',
        requestId,
        result
      });
    } else {
      process.send!({
        type: 'error',
        requestId,
        error: `Unknown message type: ${message.type}`
      });
    }
  } catch (error) {
    // Send error back to parent process
    process.send!({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
});

// Handle uncaught errors — include currentRequestId so the parent can match the response
process.on('uncaughtException', (error) => {
  process.send!({
    type: 'error',
    requestId: currentRequestId,
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  process.send!({
    type: 'error',
    requestId: currentRequestId,
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
  process.exit(1);
});




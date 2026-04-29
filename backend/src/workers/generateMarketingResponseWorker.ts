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

// Track cancelled request IDs
const cancelledRequestIds = new Set<string>();

// Listen for messages from parent process
process.on('message', async (message: any) => {
  if (message.type === 'ping') {
    process.send!({ type: 'pong', pingId: message.pingId });
    return;
  }

  if (message.type === 'cancel') {
    cancelledRequestIds.add(message.requestId);
    return;
  }

  const requestId = message.requestId;
  currentRequestId = requestId;

  try {
    if (message.type === 'generateMarketingResponse') {
      // Ensure initialization completed (should already be done)
      await ensureInitialized();

      const { messageContent, sessionHistory, userId, llmModel, sessionId, mockMode, isInteractiveShare, isDelegatedAccess, excludeTools, screenshotUrl } = message.params;

      // Progress callback to forward progress updates to parent process
      const onProgress = (progress: { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[]; suggestions?: string[] }) => {
        process.send!({
          type: 'progress',
          requestId,
          progress
        });
      };

      // Socket.IO emit callback — forwards events to parent process over IPC,
      // which then emits on the real io instance (worker has no Socket.IO server)
      const socketEmit = (room: string, event: string, payload: any) => {
        process.send!({ type: 'socketEmit', room, event, payload });
      };

      const isCancelled = () => cancelledRequestIds.has(requestId);

      const result = await agentModeService.generateMarketingResponse(
        messageContent,
        sessionHistory,
        userId,
        llmModel,
        sessionId,
        mockMode,
        onProgress,
        socketEmit,
        isInteractiveShare,
        isCancelled,
        excludeTools,
        screenshotUrl,
        isDelegatedAccess
      );

      // Clean up cancelled flag
      cancelledRequestIds.delete(requestId);

      // Send result back to parent process
      process.send!({
        type: 'success',
        requestId,
        result: { ...result, cancelled: isCancelled() || result.cancelled }
      });
    } else {
      process.send!({
        type: 'error',
        requestId,
        error: `Unknown message type: ${message.type}`
      });
    }
  } catch (error) {
    // Log error with full context for debugging
    console.error('[Worker] Error in generateMarketingResponse:', {
      requestId,
      sessionId: message.params?.sessionId,
      llmModel: message.params?.llmModel,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    // Send error back to parent process with context
    // Include partial usage messages if available (accumulated before the error)
    const partialUsageMessages = (error as any)?.partialUsageMessages;
    const originalMessage = (error as any)?.originalMessage;
    process.send!({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: {
        sessionId: message.params?.sessionId,
        llmModel: message.params?.llmModel,
      },
      ...(originalMessage ? { originalMessage } : {}),
      ...(partialUsageMessages?.length ? { partialUsageMessages } : {})
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




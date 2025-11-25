/**
 * Worker process for running generateMarketingResponse in isolation
 * This prevents blocking the main event loop during long-running operations
 */

import { AgentModeService } from '../services/agentModeService';

// Initialize the service
const agentModeService = new AgentModeService();

// Listen for messages from parent process
process.on('message', async (message: any) => {
  try {
    if (message.type === 'generateMarketingResponse') {
      const { messageContent, sessionHistory, userId, sessionId, mockMode } = message.params;
      
      // Progress callback to forward progress updates to parent process
      const onProgress = (progress: { iteration: number; status: string; toolCalls?: any[] }) => {
        process.send!({
          type: 'progress',
          progress
        });
      };
      
      const result = await agentModeService.generateMarketingResponse(
        messageContent,
        sessionHistory,
        userId,
        sessionId,
        mockMode,
        onProgress
      );
      
      // Send result back to parent process
      process.send!({
        type: 'success',
        result
      });
    } else {
      process.send!({
        type: 'error',
        error: `Unknown message type: ${message.type}`
      });
    }
  } catch (error) {
    // Send error back to parent process
    process.send!({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  process.send!({
    type: 'error',
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  process.send!({
    type: 'error',
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
  process.exit(1);
});




/**
 * Worker process for running generateMarketingResponse in isolation
 * This prevents blocking the main event loop during long-running operations
 */

// Load environment variables FIRST (worker runs in separate process)
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { AgentModeService } from '../services/agentModeService';
import { AgentModeServiceV2 } from '../services/AgentModeServiceV2';

// Feature flag: Set USE_AGENT_V2=true to use the new modular architecture
const USE_AGENT_V2 = process.env.USE_AGENT_V2 === 'true';

// Log immediately at startup
console.log('='.repeat(60));
console.log('[Worker] AGENT MODE VERSION CHECK');
console.log(`[Worker] USE_AGENT_V2 env = "${process.env.USE_AGENT_V2}"`);
console.log(`[Worker] USE_AGENT_V2 flag = ${USE_AGENT_V2}`);
console.log(`[Worker] Service: ${USE_AGENT_V2 ? 'V2 (NEW)' : 'V1 (Original)'}`);
console.log('='.repeat(60));

// Initialize the service based on feature flag
const agentModeService = new AgentModeService();
let agentModeServiceV2Instance: AgentModeServiceV2 | null = null;

// Initialize V2 if enabled
async function initializeV2() {
  if (USE_AGENT_V2 && !agentModeServiceV2Instance) {
    agentModeServiceV2Instance = new AgentModeServiceV2();
    await agentModeServiceV2Instance.initialize(agentModeService);
    console.log('Worker: Using AgentModeServiceV2 (new modular architecture)');
  }
}

// Get the active service
function getService() {
  if (USE_AGENT_V2 && agentModeServiceV2Instance) {
    return agentModeServiceV2Instance;
  }
  return agentModeService;
}

// Listen for messages from parent process
process.on('message', async (message: any) => {
  try {
    // Initialize V2 on first message if needed
    await initializeV2();
    
    if (message.type === 'generateMarketingResponse') {
      const { messageContent, sessionHistory, userId,llmModel, sessionId, mockMode } = message.params;
      
      // Progress callback to forward progress updates to parent process
      const onProgress = (progress: { iteration: number; status: string; toolCalls?: any[] }) => {
        process.send!({
          type: 'progress',
          progress
        });
      };
      
      // Use the appropriate service based on feature flag
      const service = getService();
      const result = await service.generateMarketingResponse(
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




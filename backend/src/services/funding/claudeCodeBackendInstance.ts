/**
 * ENG-2113 PR C: the process-wide ClaudeCodeBackend, built with the real dependencies. Kept apart from claudeCodeBackend.ts so that file stays
 * testable with fakes and free of the heavy imports (Emma's service, the bridge singletons, DynamoDB).
 */
import { agentModeService } from "../agentModeService";
import { chatbotDb } from "../chatbotService";
import { stripImageDataForPersistence } from "../agentMode/incrementalPersist";
import { seedSearchCallCountFromHistory } from "../agentMode/core/toolDispatch";
import { EMPTY_FINAL_RESPONSE_FALLBACK } from "../agentMode/core/termination";
import { isCancelled } from "../../utils/sseProgress";
import { ClaudeCodeBackend, legacyBridgeAllowed, newClaudeRunId } from "./claudeCodeBackend";
import { claudeRunRegistry } from "./claudeRunRegistry";
import { emmaToolBridgeExecutor, toolBridgeMcp } from "./toolBridgeService";
import { runHostTurn } from "./loginHostTurn";
import { getLoginHostProvider } from "./loginHostProvider";
import { getAttemptUsageJournal } from "./attemptUsageJournal";
import { LlmConnectionDb } from "./llmConnectionDb";

const connections = new LlmConnectionDb();

export const claudeCodeBackend = new ClaudeCodeBackend({
  hostClient: () => getLoginHostProvider().client(),
  prepareTurnContext: (input) => agentModeService.prepareTurnContext(input),
  trimToolMessages: (messages) => agentModeService.trimToolMessagesForContext(messages),
  runHostTurn,
  bridge: toolBridgeMcp,
  // The tool relay (worker protocol >= 4 and a matching version check); anything else runs on the HTTP bridge as before.
  relay: {
    workerProtocol: () => getLoginHostProvider().workerProtocol(),
    protocolStatus: () => getLoginHostProvider().protocolStatus(),
    // Default refuse (production's HTTP bridge is a zero-tool stub). A dev or test box whose bridge serves real tools sets this to "true".
    allowLegacyBridge: () => legacyBridgeAllowed(),
    invalidateProtocol: () => getLoginHostProvider().invalidateProtocol(),
  },
  executor: emmaToolBridgeExecutor,
  registry: claudeRunRegistry,
  isCancelled,
  persistMessages: async (sessionId, messages) => {
    await chatbotDb.addMessagesToSession(sessionId, stripImageDataForPersistence(messages));
  },
  markNeedsReconnect: async (connectionId, epoch, reason) => {
    await connections.hostedMarkNeedsReconnect(connectionId, epoch, reason.slice(0, 60), new Date().toISOString());
  },
  // The same forward the worker path uses: an event from a tool reaches the user's open tabs (CRM and coding-agent live refresh).
  socketEmit: (room, event, payload) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { io } = require("../../server");
      io.to(room).emit(event, payload);
    } catch {
      /* Socket.IO not available: the refresh is best-effort */
    }
  },
  writeJournal: (row) => getAttemptUsageJournal().record(row),
  emptyFallbackText: EMPTY_FINAL_RESPONSE_FALLBACK,
  now: () => Date.now(),
  newRunId: newClaudeRunId,
  seedSearchCount: (history) => seedSearchCallCountFromHistory(history as any),
  turnHardCapMs: parseInt(process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '600000', 10),
});

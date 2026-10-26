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
import { ClaudeCodeBackend, newClaudeRunId } from "./claudeCodeBackend";
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
  executor: emmaToolBridgeExecutor,
  registry: claudeRunRegistry,
  isCancelled,
  persistMessages: async (sessionId, messages) => {
    await chatbotDb.addMessagesToSession(sessionId, stripImageDataForPersistence(messages));
  },
  markNeedsReconnect: async (connectionId, epoch, reason) => {
    await connections.hostedMarkNeedsReconnect(connectionId, epoch, reason.slice(0, 60), new Date().toISOString());
  },
  writeJournal: (row) => getAttemptUsageJournal().record(row),
  emptyFallbackText: EMPTY_FINAL_RESPONSE_FALLBACK,
  now: () => Date.now(),
  newRunId: newClaudeRunId,
  seedSearchCount: (history) => seedSearchCallCountFromHistory(history as any),
  turnHardCapMs: parseInt(process.env.AGENT_MODE_GENERATION_TIMEOUT_MS || '600000', 10),
});

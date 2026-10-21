/**
 * Worker process for running generateMarketingResponse in isolation
 * This prevents blocking the main event loop during long-running operations
 */

import { agentModeService } from '../services/agentModeService';
import { installWorkerShutdownGuards } from './workerShutdownGuards';
import { installSandboxMetaInterceptorAtBoot } from '../services/sandbox/bootstrap';
import { shouldBootstrapBackgroundJobs } from '../utils/instanceState';
import { withRunFunding, noteRunFundingUnset, resolveRunFunding, type RunFunding } from '../services/funding/runFunding';

// Survive the OS process-group/cgroup SIGTERM on deploy so an in-flight scheduled run
// isn't aborted before the parent's drain can let it finish (ENG-201). The parent is the
// sole authority on worker termination (SIGKILL after drain); we exit only on IPC
// disconnect. Install before any heavy init so the guards are active immediately.
installWorkerShutdownGuards();

// ENG-1852: use the module's own exported singleton, not a separate `new AgentModeService()`.
// agentModeService.ts's own module body constructs and exports `agentModeService` as soon as
// the module loads — which happens the moment this file's import above resolves, regardless
// of what we do with it. Constructing ANOTHER instance here just meant this worker process
// carried two live AgentModeService objects: this one (deliberately `.initialize()`'d below)
// and the module's own singleton, which nothing in this file ever initialized. The vast
// majority of AgentModeService methods are stateless proxies to external APIs and don't care
// which instance answers, but a handful of tool handlers in emma/tools.ts and apiTools.ts
// (install_skills, getUnassociatedToolNames, ...) import that plain singleton directly rather
// than going through the caller-scoped `context.service`, and DO depend on per-instance state
// populated only by .initialize() (this.toolRegistry, this.mcpClientService). Whichever of the
// two objects happened to be constructed calling that particular tool decided whether the call
// saw the correctly-populated 264-tool registry or a permanently empty one — confirmed live via
// a captured construction stack trace showing both instances alive in the same worker pid.
// Using the singleton here means there is only ever one object per process again, matching
// what emma/tools.ts and apiTools.ts already assume.

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
  initializationPromise = (async () => {
    // ENG-1912: this worker is a SEPARATE forked process (child_process.fork in
    // generateMarketingResponseWorkerService.ts) with its own V8 isolate and its own
    // globalThis — server.ts's installSandboxMetaInterceptorAtBoot() call in the main
    // process's listen() callback never runs here, so this process's fetch/axios/https
    // were never patched. Found live in production: a sandbox principal's
    // call_meta_ads_insights_api tool call (which runs inside this worker, per the
    // "[Worker]"-prefixed AgentMode tool logs) reached the REAL graph.facebook.com with
    // its sentinel token and got Meta's own real "Bad signature" OAuthException back —
    // exactly the invariant ("zero requests leave the process for graph.facebook.com")
    // this interceptor exists to hold. Unlike server.ts's own install call (which logs
    // and continues, because the main process has plenty of other jobs an interceptor
    // failure shouldn't take down), a failed install HERE must fail the whole worker:
    // this process's only job is exactly the tool calls the interceptor has to guard,
    // so continuing without it silently recreates the leak this fix exists to close.
    // Skip under the Jest test-boot path, since this worker module is imported directly
    // by generateMarketingResponseWorker.argOrder.test.ts / .errorStatus.test.ts and
    // metaInterceptor.test.ts owns the module-level singleton's install/uninstall itself.
    if (shouldBootstrapBackgroundJobs()) {
      installSandboxMetaInterceptorAtBoot();
      console.log('[Worker] Sandbox Meta interceptor installed');
    }
    await agentModeService.initialize();
  })();
  // The reset must be in a finally. If the IIFE rejects and this stays assigned, every
  // later message hits the early return above, awaits the same permanently-rejected
  // promise, and throws the same stale error forever with no path back —
  // AgentModeService.initialize() gets this right and this did not.
  try {
    await initializationPromise;
    // Latch on the service's OWN verdict, not on "the promise resolved". initialize()
    // resolves even when initialization degraded — every step inside it swallows its own
    // errors — so marking this worker initialized on mere resolution makes a degraded init
    // permanent here, and the retry path the service provides never runs. This process is
    // exactly where ENG-1852 manifested, so it is the last place that should latch blind.
    initialized = agentModeService.isInitialized === true;
  } finally {
    initializationPromise = null;
  }
  if (initialized) {
    console.log('[Worker-DEBUG] AgentModeService initialized (MCP servers loaded)');
  } else {
    console.error('[Worker] AgentModeService initialization DEGRADED — next message retries.');
  }
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

  // ENG-1118: a chat session ended in the parent — hand back the MCP clients it owns
  // (a browser server pools per session, so this is a real Chromium) instead of waiting
  // for the idle sweep. Fire-and-forget: there is no reply and nothing to fail into.
  if (message.type === 'releaseSessionClients') {
    try {
      await agentModeService.releaseSessionMcpClients(message.sessionId);
    } catch (error) {
      console.warn(`[Worker] Failed to release MCP clients for session ${message.sessionId}:`, error);
    }
    return;
  }

  const requestId = message.requestId;
  currentRequestId = requestId;

  try {
    if (message.type === 'generateMarketingResponse') {
      // Ensure initialization completed (should already be done)
      await ensureInitialized();

      const {
        messageContent,
        sessionHistory,
        userId,
        llmModel,
        sessionId,
        mockMode,
        isInteractiveShare,
        isDelegatedAccess,
        excludeTools,
        screenshotUrl,
        persistIncrementally,
        publishAuthorizationOverride,
        turnStartMs,
        approvedRevisionImageSources,
        requireWorkPlanDisposition,
        isUnattendedRun,
        runFunding,
        modelRouting,
      } = message.params;

      // ENG-1816 F1: enter the ambient store BEFORE calling into agentModeService, so
      // every nested callLLM call in this turn (including tool-internal ones) reads
      // the same funding without any of those ~50 call sites being edited. A caller
      // that hasn't been updated to send `runFunding` (e.g. controllers/benchmark.ts)
      // falls back to resolving it fresh here rather than failing closed, but is
      // counted so unwrapped callers are discoverable before a customer route
      // depends on them. Resolving via resolveRunFunding — not a hand-built
      // 'agentweb' literal — so this fallback stays correct as resolution logic
      // evolves instead of silently drifting from it.
      let effectiveRunFunding: RunFunding = runFunding;
      if (!effectiveRunFunding) {
        noteRunFundingUnset('generateMarketingResponseWorker');
        effectiveRunFunding = await resolveRunFunding({ userId });
      }

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

      const result = await withRunFunding(effectiveRunFunding, () =>
        agentModeService.generateMarketingResponse(
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
          isDelegatedAccess,
          persistIncrementally,
          // ENG-907: the caller's whole-turn deadline stamp, so the loop's time budget
          // measures against the same cap (the fork/IPC hop happens before we get here).
          turnStartMs,
          // ENG-827: the authorization the CALLER resolved, so the system prompt is built
          // from the same value the required-function checker holds.
          //
          // Both of these arrive off `message.params` and are therefore `any`, so their
          // order is NOT type-checked here — passing them the wrong way round compiles
          // clean and silently swaps a deadline for an authorization. Keep this list in
          // the same order as generateMarketingResponse's signature.
          publishAuthorizationOverride,
          approvedRevisionImageSources,
          requireWorkPlanDisposition,
          // ENG-2072: see the "Keep this list in the same order" note above.
          isUnattendedRun,
          // ENG-669 PR-C: must stay LAST, matching generateMarketingResponse's own final parameter.
          modelRouting,
        ),
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
    // ENG-1670: generateMarketingResponse's catch block classifies the raw
    // provider error (e.g. a 429) into a friendly-text Error and preserves
    // .status/.code on it for downstream classifyZeroAssistantFailure — but
    // that classification only survives if it crosses this IPC boundary too.
    // Dropping it here made every wrapped error look like an unclassifiable
    // 'system' failure once it reached agentModeController, regardless of the
    // original cause (prod-verified: a rate-limited scheduled run reported
    // "unexpected system error" instead of the correct transient-retry copy).
    const status = (error as any)?.status;
    const code = (error as any)?.code;
    // ENG-1670: whether OpenRouter actually sent a Retry-After header is not
    // guaranteed — forwarding the answer (not just the friendly message) means
    // a future recurrence of this failure class is self-diagnosing from the
    // durable session record instead of needing logs that expire in 14 days.
    const retryAfterHeaderPresent = (error as any)?.retryAfterHeaderPresent;
    const retryAfterMs = (error as any)?.retryAfterMs;
    // ENG-2121: same IPC-boundary hazard ENG-1670 already documented above for
    // status/code — the controller's whole-turn timeout backstop (which salvages
    // any images/tool work already persisted this turn) only runs when it sees
    // this flag on the error it awaits. Without forwarding it here, EVERY
    // generation request (the interactive endpoint always runs through this
    // worker) would silently lose the tag at this exact hop, regardless of the
    // wrapping fix in generateMarketingResponse's own catch.
    const isGenerationTimeout = (error as any)?.isGenerationTimeout;
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
      ...(partialUsageMessages?.length ? { partialUsageMessages } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(isGenerationTimeout ? { isGenerationTimeout } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(retryAfterHeaderPresent !== undefined ? { retryAfterHeaderPresent } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
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

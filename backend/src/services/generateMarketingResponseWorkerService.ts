/**
 * Service to run generateMarketingResponse in a separate process
 * This prevents blocking the main event loop during long-running operations
 */

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { clearTerminalProgress } from '../utils/sseProgress';
import { DRAIN_CEILING_MS, DRAIN_POLL_INTERVAL_MS } from '../utils/shutdownConstants';
import type { WorkPlanTurnDisposition } from './agentMode/core/workPlanTurnDisposition';
import type { PendingApprovalDeck } from './agentMode/core/approvalDeck';
import type { RunFunding } from './funding/runFunding';
import { claudeRunRegistry } from './funding/claudeRunRegistry';

export interface GenerateMarketingResponseParams {
  messageContent: string;
  sessionHistory: any[];
  userId: string;
  llmModel: string;
  sessionId: string;
  mockMode?: boolean;
  isInteractiveShare?: boolean;
  isDelegatedAccess?: boolean;
  excludeTools?: string[];
  screenshotUrl?: string;
  // ENG-473: when set, the worker persists each settled turn to the session as it
  // completes so a hard process kill leaves a visible partial transcript.
  persistIncrementally?: boolean;
  // ENG-1816 F1: the run's funding decision, resolved once by the caller and carried
  // across the fork IPC boundary exactly like publishAuthorizationOverride below —
  // plain serializable data, never a positional argument (this interface already has
  // ~15 fields; generateMarketingResponse's own signature has ~19 positional params).
  // The worker enters an AsyncLocalStorage scope with this value before calling into
  // agentModeService, so every nested callLLM call sees it without being edited.
  // Optional only for callers not yet updated; absent is treated as 'agentweb' (F1
  // never assigns any other route, so this is not yet a real branch in practice).
  runFunding?: RunFunding;
  // ENG-827 (Greptile): the publish authorization the CALLER already resolved, carried
  // across the worker boundary so the system prompt is built from the same value the
  // required-function checker uses. Two independent reads can land either side of a
  // revocation and disagree — and the disagreement that matters is a prompt saying
  // "draft only" while the checker still demands a publishing tool, which is the retry
  // loop this ticket exists to fix. Plain data, so it survives serialization.
  publishAuthorizationOverride?: { authorized: boolean; tools: string[] };
  // ENG-907: epoch ms at which the caller started this turn's whole-turn wall-clock
  // cap. Passed through to the loop so its time budget uses the SAME deadline the
  // caller enforces, rather than one that starts after the fork IPC hop.
  turnStartMs?: number;
  // ENG-936: approved source URLs for confirmed image revisions. When supplied,
  // the tool dispatcher rejects confirm=true generate_image calls that reference
  // any unapproved source image for this run.
  approvedRevisionImageSources?: string[];
  requireWorkPlanDisposition?: boolean;
  // ENG-2072: tri-state — see ToolContext.isUnattendedRun in mcp/client/toolRegistry.ts.
  // Plain boolean, so it survives the IPC serialization to the worker process.
  isUnattendedRun?: boolean;
  // ENG-669 PR-C: set when `llmModel` was routed by the AgentWeb Model: the selection and why, stamped on this turn's
  // assistant messages beside `llm`. Plain data, so it survives the IPC serialization.
  modelRouting?: import('./agentMode/agentWebModelRouter').MessageModelRouting;
}

export interface GenerateMarketingResponseResult {
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  cancelled?: boolean;
  // Loop termination signal carried unchanged across IPC; suppress automatic replay.
  truncatedByStepBudget?: boolean;
  // ENG-2812: the run stopped at the session's turn/spend limit and waits for the person; never auto-continue it.
  pausedBySessionLimit?: boolean;
  // ENG-473: count of responseMessages already persisted incrementally during the
  // run, so the caller's final batch persists only the remaining tail.
  persistedResponseCount?: number;
  workPlanTurnDisposition?: WorkPlanTurnDisposition;
  // ENG-1635/1644: the deck built this turn, when present — plain data, survives
  // the fork IPC boundary like publishAuthorizationOverride above.
  pendingApprovalDeck?: PendingApprovalDeck;
}

/**
 * ENG-2294: the dev-mode worker must load ts-node in transpile-only mode, matching the parent
 * process (`ts-node --transpile-only src/server.ts`). Full type-checking at require-time made
 * every dev/preview brand-build worker exit 1 on any type error (e.g. untyped `nspell`).
 * The deployed (dist) branch is unchanged.
 */
export function resolveWorkerLaunch(dir: string, isLocalDevelopment: boolean): { workerScript: string; execArgv: string[] } {
  if (isLocalDevelopment) {
    return {
      workerScript: path.join(dir, '../workers/generateMarketingResponseWorker.ts'),
      execArgv: ['-r', 'ts-node/register/transpile-only', '--max-old-space-size=4096']
    };
  }
  return {
    workerScript: path.join(dir, '../workers/generateMarketingResponseWorker.js'),
    execArgv: ['--max-old-space-size=4096']
  };
}

export class GenerateMarketingResponseWorkerService {
  private worker: ChildProcess | null = null;
  private pendingRequests: Map<string, { resolve: Function; reject: Function; onProgress?: Function; timeout: NodeJS.Timeout }> = new Map();
  private sessionToRequestId: Map<string, string> = new Map();
  private requestIdCounter = 0;
  private workerReady = false;
  private workerInitPromise: Promise<void> | null = null;
  private pingIdCounter = 0;
  private pendingPings: Map<string, (alive: boolean) => void> = new Map();
  private draining = false;

  /**
   * Initialize and start the worker process
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker && !this.worker.killed) {
      if (this.workerReady) {
        return; // Worker already running and ready
      }
      if (this.workerInitPromise) {
        await this.workerInitPromise;
        return;
      }
    }

    // Get the worker script path
    let workerScript: string;
    let execArgv: string[] = [];

    const isDeployedEnvironment = __dirname.includes('/dist/') || __dirname.includes('\\dist\\');
    const isLocalDevelopment = process.env.NODE_ENV === 'development' && !isDeployedEnvironment;

    ({ workerScript, execArgv } = resolveWorkerLaunch(__dirname, isLocalDevelopment));

    // Fork a new process with increased memory limit (4GB) to prevent OOM errors
    this.worker = fork(workerScript, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: process.env,
      execArgv
    });
    this.workerReady = false;

    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const readyTimeout = setTimeout(() => {
      const error = new Error('Worker initialization timeout');
      if (readyReject) {
        readyReject(error);
      }
    }, 120000); // 120 second timeout for initialization (increased to handle MCP server connections)
    this.workerInitPromise = new Promise<void>((resolve, reject) => {
      readyResolve = () => {
        this.workerReady = true;
        clearTimeout(readyTimeout);
        resolve();
        this.workerInitPromise = null;
      };
      readyReject = (error) => {
        clearTimeout(readyTimeout);
        reject(error);
        this.workerInitPromise = null;
      };
    });

    // Forward stdout from worker to parent process
    if (this.worker.stdout) {
      this.worker.stdout.on('data', (data: Buffer) => {
        process.stdout.write(`[Worker] ${data}`);
      });
    }

    // Forward stderr from worker to parent process
    if (this.worker.stderr) {
      this.worker.stderr.on('data', (data: Buffer) => {
        process.stderr.write(`[Worker] ${data}`);
      });
    }

    // Handle messages from worker
    this.worker.on('message', (message: any) => {
      if (message.type === 'ready') {
        if (!this.workerReady && readyResolve) {
          console.log('[Worker] Worker ready and initialized');
          readyResolve();
        }
        return;
      }

      if (message.type === 'pong') {
        const callback = this.pendingPings.get(message.pingId);
        if (callback) {
          this.pendingPings.delete(message.pingId);
          callback(true);
        }
        return;
      }

      if (message.type === 'progress' && message.requestId) {
        const reqId = message.requestId;
        const pending = this.pendingRequests.get(reqId);
        if (pending) {
          // Reset the inactivity timeout on each progress update so long-running
          // sessions don't get killed while they're still making progress.
          clearTimeout(pending.timeout);
          pending.timeout = setTimeout(() => {
            const p = this.pendingRequests.get(reqId);
            if (p) {
              this.pendingRequests.delete(reqId);
              p.reject(new Error('generateMarketingResponse worker timed out after 45 minutes of inactivity'));
            }
          }, 45 * 60 * 1000);
          if (pending.onProgress) {
            pending.onProgress(message.progress);
          }
        }
        return;
      }

      // Forward Socket.IO events from the worker to the real io instance
      if (message.type === 'socketEmit') {
        try {
          const { io } = require('../server');
          io.to(message.room).emit(message.event, message.payload);
        } catch {
          // Socket.IO not available (shouldn't happen in main process)
        }
        return;
      }

      if (!message.requestId) return;

      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      // Clean up session mapping
      for (const [sid, rid] of this.sessionToRequestId.entries()) {
        if (rid === message.requestId) {
          this.sessionToRequestId.delete(sid);
          break;
        }
      }

      if (message.type === 'success') {
        pending.resolve(message.result);
      } else if (message.type === 'error') {
        const error: any = new Error(message.error);
        if (message.stack) {
          error.stack = message.stack;
        }
        if (message.originalMessage) {
          error.originalMessage = message.originalMessage;
        }
        if (message.partialUsageMessages?.length) {
          error.partialUsageMessages = message.partialUsageMessages;
        }
        // ENG-1670: restore the original provider error's status/code so
        // classifyZeroAssistantFailure (agentModeController) can tell a
        // transient 429 apart from a real system error — without these, a
        // rate-limited scheduled run gets misreported to the user as an
        // "unexpected system error" instead of the accurate retry-in-progress copy.
        if (message.status !== undefined) {
          error.status = message.status;
        }
        if (message.code !== undefined) {
          error.code = message.code;
        }
        // ENG-1670: restore whether OpenRouter actually sent a Retry-After header
        // for this occurrence, so a future recurrence of this failure class is
        // self-diagnosing from the persisted session record instead of needing
        // logs that have already rotated out by the time anyone investigates.
        if (message.retryAfterHeaderPresent !== undefined) {
          error.retryAfterHeaderPresent = message.retryAfterHeaderPresent;
        }
        if (message.retryAfterMs !== undefined) {
          error.retryAfterMs = message.retryAfterMs;
        }
        // ENG-2121: restore the whole-turn-timeout tag so the controller's own
        // backstop (withGenerationTimeout's caller — salvages any images/tool work
        // already persisted this turn) treats a bounded per-call LLM timeout the
        // same as its own hard-cap race firing, instead of silently losing the
        // signal at this same IPC boundary ENG-1670 already had to patch once.
        if (message.isGenerationTimeout) {
          error.isGenerationTimeout = message.isGenerationTimeout;
        }
        pending.reject(error);
      }
    });

    // Handle worker errors
    this.worker.on('error', (error) => {
      console.error('[Worker] Worker process error:', error);
      if (readyReject) {
        readyReject(error);
      }
      // Clear SSE progress for every in-flight session BEFORE failAllPendingRequests
      // drops the session→request mapping — otherwise a worker that died
      // mid-iteration leaves a stale progress entry that streams "Thinking…"
      // to the frontend forever (the SSE-zombie-progress bug, B4). This runs
      // while sessionToRequestId is still populated.
      this.clearProgressForInFlightSessions();
      // Reject all pending requests and clear BOTH pendingRequests and
      // sessionToRequestId so the controller's lock releases immediately (B1).
      this.failAllPendingRequests(error);
      this.worker = null;
    });

    // Handle worker exit
    this.worker.on('exit', (code, signal) => {
      console.log(`[Worker] Worker process exited with code ${code} and signal ${signal}`);
      const exitError = new Error(`Worker process exited with code ${code} and signal ${signal}`);
      if (readyReject) {
        readyReject(exitError);
      }
      // See the 'error' handler above: clear SSE progress BEFORE
      // failAllPendingRequests drops the session→request mapping, so a worker
      // that exits mid-iteration cannot orphan its sessions' progress entries (B4).
      this.clearProgressForInFlightSessions();
      // Reject all pending requests and clear both maps so the controller's
      // generation lock releases immediately instead of waiting the timeout (B1).
      this.failAllPendingRequests(exitError);
      this.worker = null;
    });

    if (this.workerInitPromise) {
      await this.workerInitPromise;
    }
  }

  /**
   * Reject every in-flight request and fully clear the request bookkeeping when the
   * worker dies (exit/error). Clearing BOTH pendingRequests and sessionToRequestId is
   * essential: a leftover session→requestId mapping for a dead session would make a
   * later cancelSession() mis-fire a {type:'cancel'} at the *fresh* worker, and the
   * map would grow unbounded across crashes. Rejecting promptly here is what lets the
   * controller's try/finally release the per-session generation lock immediately
   * instead of waiting out GENERATION_TIMEOUT_MS.
   */
  private failAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.sessionToRequestId.clear();
  }

  /**
   * Pre-start the worker process so it's ready before the first request.
   * Called at server startup to avoid cold-start latency on the first chat message.
   */
  async ensureWorkerReady(): Promise<void> {
    await this.ensureWorker();
  }

  /**
   * Clear the SSE progress entry for every session that currently has an
   * in-flight request. Called on worker death (`error`/`exit`) so a generation
   * that dies mid-iteration cannot leave a zombie progress entry that the
   * frontend streams as "Thinking…" indefinitely. Best-effort: a failure to
   * clear one session's progress must not block clearing the others or the
   * surrounding worker teardown.
   */
  private clearProgressForInFlightSessions(): void {
    for (const sessionId of this.sessionToRequestId.keys()) {
      try {
        clearTerminalProgress(sessionId);
      } catch (err) {
        console.error(`[Worker] Failed to clear progress for session ${sessionId} on worker death:`, err);
      }
    }
  }

  /**
   * Send a cancel signal to the worker for a given session
   */
  cancelSession(sessionId: string): void {
    // ENG-2113: a turn on the user's own Claude plan runs in THIS process, not the worker, so the worker message below never reaches it.
    // Every Stop / timeout / preemption site already calls this method; the registry is a no-op for any session without a Claude turn.
    claudeRunRegistry.cancel(sessionId);
    const requestId = this.sessionToRequestId.get(sessionId);
    if (requestId && this.worker && !this.worker.killed) {
      this.worker.send({ type: 'cancel', requestId });
    }
  }

  /**
   * ENG-1118: tell the worker to release a finished chat session's MCP clients.
   *
   * Browser MCP servers pool per chat session and those pools live in the worker process,
   * so a caller in this process cannot reclaim them directly — a scheduled run's Chromium
   * would sit idle until the pool sweep. Fire-and-forget, like cancelSession: never starts
   * a worker (with no worker there is nothing to release) and never throws into the
   * caller's `finally`.
   */
  releaseSessionClients(sessionId: string): void {
    if (!sessionId) return;
    if (!this.worker || this.worker.killed) return;
    try {
      this.worker.send({ type: 'releaseSessionClients', sessionId });
    } catch (error) {
      console.warn(`[Worker] Could not signal MCP client release for session ${sessionId}:`, (error as Error).message);
    }
  }

  /**
   * Shutdown the worker process, draining any in-flight requests first.
   * Blocks until pendingRequests.size === 0 or the remaining drain budget elapses.
   */
  async shutdown(ceilingMs: number = DRAIN_CEILING_MS): Promise<void> {
    this.draining = true;
    console.log(`[Worker] Drain started — ${this.pendingRequests.size} in-flight request(s)`);

    const deadline = Date.now() + Math.max(0, ceilingMs);

    // ENG-2113: a turn on the user's own Claude plan runs in this process, not the worker, so it is not in pendingRequests. It is waited for
    // the same way (and stopped, gracefully for the host, if the ceiling is reached) so a deploy does not cut it off mid-write.
    while ((this.pendingRequests.size > 0 || claudeRunRegistry.size > 0) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
    }

    if (claudeRunRegistry.size > 0) {
      console.warn(`[Worker] Drain ceiling reached — stopping ${claudeRunRegistry.cancelAll()} Claude plan turn(s)`);
    }
    if (this.pendingRequests.size > 0) {
      console.warn(`[Worker] Drain ceiling reached — ${this.pendingRequests.size} request(s) still in-flight; force-killing`);
      this.failAllPendingRequests(new Error('Worker shutdown — drain ceiling exceeded'));
    } else {
      console.log('[Worker] All in-flight requests completed — shutting down worker process');
    }

    if (this.worker && !this.worker.killed) {
      // SIGKILL, not SIGTERM: the worker deliberately ignores SIGTERM so the OS
      // process-group/cgroup SIGTERM on deploy can't abort an in-flight run before the
      // drain above completes (ENG-201). The parent must therefore force-kill it here.
      this.worker.kill('SIGKILL');
      this.worker = null;
    }
  }

  /**
   * Check if the worker process is alive and responsive via ping/pong.
   * Returns true if the worker responds within the timeout.
   */
  async isWorkerHealthy(timeoutMs = 5000): Promise<boolean> {
    if (!this.worker || this.worker.killed || !this.workerReady) {
      return false;
    }

    const pingId = `ping_${++this.pingIdCounter}_${Date.now()}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(pingId);
        resolve(false);
      }, timeoutMs);

      this.pendingPings.set(pingId, (alive) => {
        clearTimeout(timer);
        resolve(alive);
      });

      try {
        this.worker!.send({ type: 'ping', pingId });
      } catch {
        clearTimeout(timer);
        this.pendingPings.delete(pingId);
        resolve(false);
      }
    });
  }

  /**
   * Kill the current worker and start a fresh one.
   * Used when the worker is detected as unresponsive.
   */
  async restartWorker(): Promise<void> {
    console.log('[Worker] Restarting worker process...');
    if (this.worker && !this.worker.killed) {
      this.worker.kill('SIGKILL');
    }
    this.worker = null;
    this.workerReady = false;
    this.workerInitPromise = null;
    await this.ensureWorker();
    console.log('[Worker] Worker process restarted successfully');
  }

  /**
   * Run generateMarketingResponse in a separate process
   * This prevents blocking the main event loop, allowing health checks to continue working
   */
  async runInWorker(
    params: GenerateMarketingResponseParams,
    onProgress?: (progress: { iteration: number; status: string; toolCalls?: any[]; pendingTools?: string[]; suggestions?: string[] }) => void
  ): Promise<GenerateMarketingResponseResult> {
    if (this.draining) {
      throw new Error('Worker is draining — no new requests accepted');
    }
    // Ensure worker is running
    await this.ensureWorker();

    if (!this.worker) {
      throw new Error('Failed to start worker process');
    }

    return new Promise((resolve, reject) => {
      // Generate unique request ID
      const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;

      // Set a timeout for this specific request (45 minutes max)
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          reject(new Error('generateMarketingResponse worker timed out after 45 minutes'));
        }
      }, 45 * 60 * 1000);

      // Store the request callbacks and session mapping
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        onProgress,
        timeout
      });
      this.sessionToRequestId.set(params.sessionId, requestId);

      // Send the request to the worker
      this.worker!.send({
        type: 'generateMarketingResponse',
        requestId,
        params
      });
    });
  }
}

export const generateMarketingResponseWorkerService = new GenerateMarketingResponseWorkerService();

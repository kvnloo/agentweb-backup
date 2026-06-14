/**
 * Service to run generateMarketingResponse in a separate process
 * This prevents blocking the main event loop during long-running operations
 */

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { clearTerminalProgress } from '../utils/sseProgress';

interface GenerateMarketingResponseParams {
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
}

interface GenerateMarketingResponseResult {
  content: string;
  toolCalls: any[];
  knowledgeBaseQueries: string[];
  sources: string[];
  responseMessages: any[];
  cancelled?: boolean;
  backupModelUsed?: boolean;
  originalModel?: string;
  backupModel?: string;
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

    if (isLocalDevelopment) {
      workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.ts');
      execArgv = ['-r', 'ts-node/register', '--max-old-space-size=4096'];
    } else {
      workerScript = path.join(__dirname, '../workers/generateMarketingResponseWorker.js');
      execArgv = ['--max-old-space-size=4096'];
    }

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
    const requestId = this.sessionToRequestId.get(sessionId);
    if (requestId && this.worker && !this.worker.killed) {
      this.worker.send({ type: 'cancel', requestId });
    }
  }

  /**
   * Shutdown the worker process
   */
  async shutdown(): Promise<void> {
    if (this.worker && !this.worker.killed) {
      this.worker.kill('SIGTERM');
      this.worker = null;
    }
    // Reject all pending requests and clear the request/session bookkeeping.
    this.failAllPendingRequests(new Error('Worker shutdown'));
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

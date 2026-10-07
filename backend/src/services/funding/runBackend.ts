/**
 * ENG-1816 F1 — RunBackend: the turn-level seam Track B's ClaudeCodeBackend (B4)
 * plugs into. `EmmaLoopBackend` wraps today's `generateMarketingResponse` unchanged.
 *
 * Scope boundary, deliberate: F1 defines and unit-tests this seam but does NOT
 * rewire the real worker script (`workers/generateMarketingResponseWorker.ts`) to
 * call through it — that script is a live, high-traffic production path, and nothing
 * needs the seam yet (Track A never touches it; only B4 introduces a second
 * `RunBackend`). B4 does the actual cutover of that call site. Until then this class
 * is real, tested code with no production caller — exactly the same shape as
 * `decideFallback` in this same ticket.
 */
import { agentModeService } from "../agentModeService";
import type {
  GenerateMarketingResponseParams,
  GenerateMarketingResponseResult,
} from "../generateMarketingResponseWorkerService";
import type { RunFunding } from "./runFunding";
import { emitBestEffort, type AttemptOutcome, type FinishReason, type RunEmitter } from "../agentMode/streamEvents";

export interface RunBackendCallbacks {
  onProgress: (progress: {
    iteration: number;
    status: string;
    toolCalls?: any[];
    pendingTools?: string[];
    suggestions?: string[];
  }) => void;
  socketEmit: (room: string, event: string, payload: any) => void;
  isCancelled: () => boolean;
  /**
   * ENG-1816 F3: typed event sink. The caller owns it (and the runId); every backend emits
   * into this one emitter so no backend needs its own parallel event path. Optional so
   * existing callers are unchanged. Emit through `emitBestEffort`, never `emitter.emit`
   * directly: a sink failure must not reach a live turn.
   */
  emitter?: RunEmitter;
}

export interface RunBackend {
  run(params: GenerateMarketingResponseParams, callbacks: RunBackendCallbacks): Promise<GenerateMarketingResponseResult>;
}

/**
 * Wraps `agentModeService.generateMarketingResponse` with the exact positional
 * argument order the real worker script uses today — deliberately duplicated rather
 * than imported, because the worker script is not calling through this class yet
 * (see file doc comment); keeping the two in sync is a currently-manual invariant
 * that B4's cutover removes by deleting the worker script's own copy.
 */
export class EmmaLoopBackend implements RunBackend {
  async run(
    params: GenerateMarketingResponseParams,
    { onProgress, socketEmit, isCancelled, emitter }: RunBackendCallbacks,
  ): Promise<GenerateMarketingResponseResult> {
    let result: GenerateMarketingResponseResult;
    try {
      result = await this.generate(params, onProgress, socketEmit, isCancelled);
    } catch (error) {
      emitAttemptFinished(emitter, 'failed');
      throw error;
    }
    let outcome: AttemptOutcome = 'completed';
    try {
      if (isCancelled()) outcome = 'cancelled';
    } catch {
      // A throwing isCancelled must not turn a finished run into a failure.
    }
    emitAttemptFinished(emitter, outcome, result.toolCalls?.length);
    return result;
  }

  private generate(
    params: GenerateMarketingResponseParams,
    onProgress: RunBackendCallbacks["onProgress"],
    socketEmit: RunBackendCallbacks["socketEmit"],
    isCancelled: RunBackendCallbacks["isCancelled"],
  ): Promise<GenerateMarketingResponseResult> {
    return agentModeService.generateMarketingResponse(
      params.messageContent,
      params.sessionHistory,
      params.userId,
      params.llmModel,
      params.sessionId,
      params.mockMode,
      onProgress,
      socketEmit,
      params.isInteractiveShare,
      isCancelled,
      params.excludeTools,
      params.screenshotUrl,
      params.isDelegatedAccess,
      params.persistIncrementally,
      params.turnStartMs,
      params.publishAuthorizationOverride,
      params.approvedRevisionImageSources,
      params.requireWorkPlanDisposition,
      params.isUnattendedRun,
    );
  }
}

const FINISH_REASON: Record<AttemptOutcome, FinishReason> = {
  completed: "stop",
  failed: "error",
  cancelled: "cancelled",
};

/**
 * Terminal events, mirroring the agent_run_completed / agent_run_failed lifecycle in
 * agentModeService.ts. `cancelled` is derived from `isCancelled()` after the run
 * resolves; how the loop exits on cancellation was not independently verified, so treat
 * that mapping as best-effort until B4 consumes it.
 */
function emitAttemptFinished(emitter: RunEmitter | undefined, outcome: AttemptOutcome, toolCalls?: number): void {
  emitBestEffort(emitter, { type: "attempt-finished", outcome, ...(toolCalls !== undefined ? { toolCalls } : {}) });
  emitBestEffort(emitter, { type: "finish", reason: FINISH_REASON[outcome] });
}

const emmaLoopBackend = new EmmaLoopBackend();

/** F1 always resolves EmmaLoopBackend. B4 adds the ClaudeCodeBackend branch. */
export function pickRunBackend(_runFunding: RunFunding | undefined): RunBackend {
  return emmaLoopBackend;
}

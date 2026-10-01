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
    { onProgress, socketEmit, isCancelled }: RunBackendCallbacks,
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

const emmaLoopBackend = new EmmaLoopBackend();

/** F1 always resolves EmmaLoopBackend. B4 adds the ClaudeCodeBackend branch. */
export function pickRunBackend(_runFunding: RunFunding | undefined): RunBackend {
  return emmaLoopBackend;
}

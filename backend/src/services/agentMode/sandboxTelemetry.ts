import { isEvaluationUser } from '../evaluationPolicy';

/**
 * Which agent-mode runs belong to a sandbox (eval_) principal — so the reliability
 * recorder never sees them (ENG-1907). `agentReliabilitySnapshotCron` has no per-user
 * filter and feeds the closure gate's failedRunRate/degradedRunRate.
 *
 * Identity travels explicitly with every terminal and claim-check callback; the marked
 * set only answers for callers that have no userId in scope. Entries are released on the
 * terminal event, so the set stays small — the cap is a leak guard for runs that never
 * terminate, not the correctness mechanism.
 */
const sandboxRunIds = new Set<string>();
const MAX_TRACKED_RUNS = 5000;

export function markSandboxRun(runId: string): void {
  if (sandboxRunIds.size >= MAX_TRACKED_RUNS) {
    console.warn(`[sandboxTelemetry] ${MAX_TRACKED_RUNS} sandbox runs tracked without a terminal event; evicting the oldest`);
    const oldest = sandboxRunIds.values().next().value;
    if (oldest !== undefined) sandboxRunIds.delete(oldest);
  }
  sandboxRunIds.add(runId);
}

export function forgetSandboxRun(runId: string): void {
  sandboxRunIds.delete(runId);
}

/** Explicit identity first, the marked set second. */
export function isSandboxRun(runId: string, userId?: string): boolean {
  return isEvaluationUser(userId) || sandboxRunIds.has(runId);
}

/** Terminal event: answer and release in one step. */
export function releaseSandboxRun(runId: string, userId?: string): boolean {
  const sandbox = isSandboxRun(runId, userId);
  sandboxRunIds.delete(runId);
  return sandbox;
}

export function __resetSandboxRunsForTests(): void {
  sandboxRunIds.clear();
}

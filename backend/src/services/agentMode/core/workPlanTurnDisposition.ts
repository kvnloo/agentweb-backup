export type WorkPlanTurnSnapshot = {
  hasWorkPlan: boolean;
  pendingStepCount?: number;
  awaitingAction?: {
    kind: 'input' | 'question';
    id: string;
  };
};

export type WorkPlanTurnDisposition =
  | { kind: 'needs_input'; actionId: string }
  | { kind: 'step_complete'; stepCount: number }
  | { kind: 'continuing' }
  | { kind: 'failed'; retryable: true }
  | { kind: 'invalid'; code: 'WORKPLAN_TURN_MISSING_DISPOSITION'; retryable: true }
  | { kind: 'not_applicable' };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function awaitingId(value: unknown, idKey: string): string | undefined {
  const record = asRecord(value);
  if (!record || record.status !== 'awaiting' || typeof record[idKey] !== 'string') {
    return undefined;
  }

  const id = record[idKey].trim();
  return id || undefined;
}

/**
 * Capture only persisted workplan state. Model prose is deliberately excluded:
 * a sentence that looks like a question is not a durable turn outcome.
 */
export function snapshotWorkPlanTurn(session: unknown): WorkPlanTurnSnapshot {
  const sessionRecord = asRecord(session);
  const workPlan = asRecord(sessionRecord?.workPlan);
  if (!workPlan) {
    return { hasWorkPlan: false };
  }

  const pendingInputId = awaitingId(sessionRecord?.pendingWorkPlanInput, 'requestId');
  if (pendingInputId) {
    return {
      hasWorkPlan: true,
      pendingStepCount: findPendingStepCount(workPlan.steps),
      awaitingAction: { kind: 'input', id: pendingInputId },
    };
  }

  const pendingQuestionId = awaitingId(sessionRecord?.pendingUserQuestion, 'questionId');
  return {
    hasWorkPlan: true,
    pendingStepCount: findPendingStepCount(workPlan.steps),
    ...(pendingQuestionId
      ? { awaitingAction: { kind: 'question' as const, id: pendingQuestionId } }
      : {}),
  };
}

function findPendingStepCount(steps: unknown): number | undefined {
  if (!Array.isArray(steps)) return undefined;

  for (const value of steps) {
    const step = asRecord(value);
    if (!step || step.status !== 'pending' || typeof step.stepCount !== 'number') continue;
    if (!Number.isInteger(step.stepCount) || step.stepCount < 1) continue;
    return step.stepCount;
  }

  return undefined;
}

/**
 * ENG-1626: true when `message` is the assistant's last turn and it ended with
 * a workplan disposition failure (WORKPLAN_TURN_MISSING_DISPOSITION, e.g. a
 * decision-card creation that silently failed) that this module already
 * flagged as retryable. A production session hit this and the assistant told
 * the customer "I couldn't create the decision card... Please retry" — the
 * automatic in-turn retry above had already run once and failed again, so the
 * only path forward was the customer typing the literal phrase "retry
 * creating the card". The caller uses this to re-enforce the disposition
 * check on the customer's NEXT turn regardless of what they actually typed,
 * so the retry happens on its own instead of depending on that exact phrase.
 */
export function priorTurnNeedsWorkPlanDispositionRetry(message: unknown): boolean {
  const record = asRecord(message);
  if (!record || record.role !== 'assistant') return false;
  const metadata = asRecord(record.metadata);
  const failure = asRecord(metadata?.workPlanDispositionFailure);
  return failure?.retryable === true;
}

// Mirrors the transient/infrastructure error shapes the "Retrying a Transient
// Failure" system-prompt carve-out (ENG-828) names: v0 timeout codes, 5xx/
// network errors, and a plain "timed out" (coding_agent's own message, which
// carries no error code — only `result.retryable`).
const TRANSIENT_ERROR_PATTERN =
  /V0_CALL_TIMEOUT|V0_GENERATION_TIMEOUT|fetch failed|ECONNRESET|ENOTFOUND|network error|NetworkError|ETIMEDOUT|socket hang up|Connect Timeout|timed out|UND_ERR/i;

/**
 * ENG-828: true when the pending step's own tool was retried once per the
 * "Retrying a Transient Failure" carve-out and failed BOTH times with a
 * transient/infrastructure-shaped error. Without this, a turn that correctly
 * leaves the step `pending` and explains the platform failure honestly still
 * has `before.pendingStepCount === after.pendingStepCount` with no
 * `awaitingAction` — indistinguishable, to decideWorkPlanTurnDisposition, from
 * a turn that produced no structured outcome at all. That misclassifies a
 * legitimate exhausted-retry outcome as `invalid`, which overwrites the
 * model's own honest explanation with the generic "I couldn't create the
 * decision card... Please retry" fallback (reproduced live testing ENG-828).
 */
/** Normalizes a ledger entry's `error` to a string, whether it's already one
 * (the common shape — see toolDispatch.ts's `error.message`) or a structured
 * object carrying `message`/`code` (a gateway error the minimizer didn't
 * stringify). Never lets a non-string error silently disappear. */
function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  const record = asRecord(error);
  const message = record?.message;
  const code = record?.code;
  if (typeof message === 'string' || typeof code === 'string') {
    return [code, message].filter((v) => typeof v === 'string').join(': ');
  }
  return undefined;
}

export function hadExhaustedTransientStepFailure(
  toolCalls: Array<{ name?: unknown; error?: unknown; result?: unknown }> | undefined,
  requiredFunctionCalls: unknown,
): boolean {
  if (!Array.isArray(toolCalls) || !Array.isArray(requiredFunctionCalls)) return false;
  for (const toolName of requiredFunctionCalls) {
    if (typeof toolName !== 'string') continue;
    const callsForTool = toolCalls.filter((tc) => tc?.name === toolName);
    // The carve-out allows exactly ONE retry — a legitimate exhausted-retry
    // outcome means this tool was called at least twice this turn. A single
    // failed attempt (the model hasn't retried, or gave up early) must NOT
    // match here, or it would mask a genuine prompt-compliance regression by
    // classifying it as a valid `failed` disposition instead of `invalid`
    // (which nudges the model to actually retry). Not requiring identical
    // arguments between attempts: live verification (ENG-828) showed a real
    // model retry can differ by trivial rephrasing, not byte-for-byte reuse.
    if (callsForTool.length < 2) continue;
    const last = callsForTool[callsForTool.length - 1];
    const lastErrorText = errorText(last.error);
    const retryable = asRecord(last.result)?.retryable === true;
    if (retryable || (lastErrorText && TRANSIENT_ERROR_PATTERN.test(lastErrorText))) return true;
  }
  return false;
}

/** Pure lookup: the pending step's own record from a session's `workPlan.steps`. */
export function findWorkPlanStepByCount(session: unknown, stepCount: number | undefined): UnknownRecord | undefined {
  if (stepCount === undefined) return undefined;
  const workPlan = asRecord(asRecord(session)?.workPlan);
  const steps = workPlan?.steps;
  if (!Array.isArray(steps)) return undefined;
  return steps.find((s) => asRecord(s)?.stepCount === stepCount) as UnknownRecord | undefined;
}

export function decideWorkPlanTurnDisposition({
  before,
  after,
  stillRunning = false,
  failed = false,
}: {
  before: WorkPlanTurnSnapshot;
  after: WorkPlanTurnSnapshot;
  stillRunning?: boolean;
  failed?: boolean;
}): WorkPlanTurnDisposition {
  if (!before.hasWorkPlan) return { kind: 'not_applicable' };

  if (after.awaitingAction) {
    return {
      kind: 'needs_input',
      actionId: `${after.awaitingAction.kind}:${after.awaitingAction.id}`,
    };
  }

  if (failed) return { kind: 'failed', retryable: true };
  if (stillRunning) return { kind: 'continuing' };

  if (before.pendingStepCount === undefined) return { kind: 'not_applicable' };

  if (
    before.pendingStepCount !== undefined
    && before.pendingStepCount !== after.pendingStepCount
  ) {
    return { kind: 'step_complete', stepCount: before.pendingStepCount };
  }

  return {
    kind: 'invalid',
    code: 'WORKPLAN_TURN_MISSING_DISPOSITION',
    retryable: true,
  };
}

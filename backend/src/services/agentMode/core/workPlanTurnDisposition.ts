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

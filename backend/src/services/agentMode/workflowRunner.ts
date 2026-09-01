/**
 * ENG-397 — impure orchestration for the Workflow engine. The pure decision
 * logic lives in `core/workflow.ts`; this file is where session I/O
 * (chatbotDb) happens.
 *
 * There is no chat/tool wiring yet — startWorkflow/advanceWorkflow are
 * internal entry points exercised by tests in this slice. Rendering a
 * workflow through Emma's chat loop is a deliberately separate follow-on
 * (see ENG-419's own comment thread), not part of this ticket's 4
 * acceptance criteria.
 */

import { v4 as uuidv4 } from 'uuid';
import { chatbotDb } from '../chatbotService';
import {
  WorkflowDefinition,
  WorkflowRunState,
  buildWorkflowRunState,
  findNextStep,
  resolveStepParameters,
  recordStepSuccess,
  recordStepFailure,
  markBlockedOnParameter,
  collectEntityIdsFromCheckpoints,
  findGatedParameterKeys,
} from './core/workflow';

export async function startWorkflow(
  sessionId: string,
  definition: WorkflowDefinition,
  initialParameters?: Record<string, unknown>,
): Promise<WorkflowRunState> {
  // A gated key (objective, budget_mode, ...) MUST come from a
  // human-attributed AskUserQuestion answer, never a caller-supplied initial
  // value — resolveStepParameters only checks presence, not provenance, so
  // letting one through here would silently bypass checkQuestionGate.
  const gatedKeys = findGatedParameterKeys(definition);
  const rejectedKeys = Object.keys(initialParameters ?? {}).filter((key) => gatedKeys.has(key));
  if (rejectedKeys.length > 0) {
    throw new Error(
      `startWorkflow: initialParameters cannot supply gated parameter(s) that must be resolved via AskUserQuestion: ${rejectedKeys.join(', ')}`,
    );
  }

  // updateSessionWorkflowRun's failIfActiveExists guard is satisfied by
  // `attribute_not_exists(workflowRun)`, which DynamoDB's conditional
  // UpdateItem treats as true whether the field is merely absent on an
  // existing item OR the whole item doesn't exist — an UpdateItem call
  // creates the row if missing. Without this check, a bad or stale
  // sessionId would silently upsert a near-empty ChatSession row instead
  // of failing loud.
  const existingSession = await chatbotDb.getChatSession(sessionId);
  if (!existingSession) {
    throw new Error(`startWorkflow: no session found for sessionId '${sessionId}'`);
  }

  const run = buildWorkflowRunState({
    runId: uuidv4(),
    workflowId: definition.workflowId,
    createdAt: new Date().toISOString(),
    initialParameters,
  });
  const session = await chatbotDb.updateSessionWorkflowRun(sessionId, run, { failIfActiveExists: true });
  if (!session?.workflowRun) throw new Error('WORKFLOW_ALREADY_ACTIVE');
  return session.workflowRun;
}

export type AdvanceOutcome =
  | { kind: 'no_active_run' }
  | { kind: 'blocked'; run: WorkflowRunState }
  | { kind: 'step_verified'; run: WorkflowRunState }
  | { kind: 'completed'; run: WorkflowRunState }
  | { kind: 'step_failed'; run: WorkflowRunState }
  // Optimistic-lock loss — caller must re-read and retry rather than trust `run`.
  | { kind: 'conflict'; run: WorkflowRunState };

/**
 * Advance the session's active workflow run by exactly one step. Always
 * re-reads the session fresh from the DB first (mirrors
 * resolveCampaignObjectiveGate's "never trust in-memory" rule) so a stale
 * caller can't race a concurrent write.
 */
export async function advanceWorkflow(sessionId: string, definition: WorkflowDefinition): Promise<AdvanceOutcome> {
  const session = await chatbotDb.getChatSession(sessionId);
  const run = session?.workflowRun;
  if (!run) return { kind: 'no_active_run' };

  const step = findNextStep(definition, run);
  if (!step) return { kind: run.status === 'failed' ? 'step_failed' : 'completed', run };

  const resolution = resolveStepParameters(step, run, session?.pendingUserQuestion, session?.answeredQuestions);
  if (resolution.blocked) {
    const blockedRun = markBlockedOnParameter(run, resolution.block, new Date().toISOString());
    const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, blockedRun, { requireVersion: run.version });
    if (!persisted?.workflowRun) return { kind: 'conflict', run };
    return { kind: 'blocked', run: persisted.workflowRun };
  }

  const at = () => new Date().toISOString();

  // "campaign_id feeds the next step": merge prior VERIFIED steps' checkpointed
  // entity IDs ahead of resolvedParameters, so a step declaring an input that
  // matches an earlier step's output name receives it automatically — without
  // ever persisting entity IDs into run.resolvedParameters itself (they stay
  // sourced from the checkpoints, the single place this data lives).
  const executionInput = { ...collectEntityIdsFromCheckpoints(run), ...resolution.resolvedParameters };

  let executeResult: Record<string, unknown>;
  try {
    executeResult = await step.execute(executionInput);
  } catch (err: any) {
    const failedRun = recordStepFailure(run, step, { error: err?.message || 'execute failed' }, at());
    const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, failedRun, { requireVersion: run.version });
    if (!persisted?.workflowRun) return { kind: 'conflict', run };
    return { kind: 'step_failed', run: persisted.workflowRun };
  }

  // A declared output execute() failed to return a usable value for would
  // otherwise checkpoint as a fake entity id — the literal string
  // "undefined"/"null" (String(undefined) === 'undefined'), a stringified
  // object, NaN/Infinity ("NaN" is not a real id either), or a
  // whitespace-only string — and get threaded into a later step's input as
  // if it were real. Fail loud here instead of trusting execute() honored
  // its contract.
  const invalidOutputs = step.outputs.filter((k) => {
    const value = executeResult[k];
    if (value === undefined || value === null) return true;
    if (typeof value === 'number') return !Number.isFinite(value);
    if (typeof value === 'string') return value.trim() === '';
    return true; // any other type (object, boolean, array, ...) is not a valid entity id
  });
  if (invalidOutputs.length > 0) {
    const failedRun = recordStepFailure(
      run,
      step,
      { error: `execute() did not return a valid value for declared output(s): ${invalidOutputs.join(', ')}` },
      at(),
    );
    const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, failedRun, { requireVersion: run.version });
    if (!persisted?.workflowRun) return { kind: 'conflict', run };
    return { kind: 'step_failed', run: persisted.workflowRun };
  }

  // verify() is step-authored and may do live I/O (a read-back call) — it is
  // NOT guaranteed to catch its own transport failures. Without this guard, a
  // thrown verify() skips every checkpoint write entirely: the run stays
  // 'in_progress' with this step still unattempted, so the NEXT advanceWorkflow
  // call (an ordinary retry, not even a concurrent one) calls execute() again
  // and creates a second real entity — the exact duplicate-creation failure
  // class this engine exists to close. Symmetric with the execute() try/catch
  // above.
  let verification: Awaited<ReturnType<typeof step.verify>>;
  try {
    verification = await step.verify(executeResult, executionInput);
  } catch (err: any) {
    const failedRun = recordStepFailure(run, step, { error: err?.message || 'verify failed' }, at());
    const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, failedRun, { requireVersion: run.version });
    if (!persisted?.workflowRun) return { kind: 'conflict', run };
    return { kind: 'step_failed', run: persisted.workflowRun };
  }
  if (!verification.verified) {
    const discrepancy = 'mismatches' in verification ? verification.mismatches : { error: verification.error };
    const failedRun = recordStepFailure(run, step, discrepancy, at());
    const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, failedRun, { requireVersion: run.version });
    if (!persisted?.workflowRun) return { kind: 'conflict', run };
    return { kind: 'step_failed', run: persisted.workflowRun };
  }

  const entityIds = Object.fromEntries(step.outputs.map((k) => [k, String(executeResult[k])]));
  const successRun = recordStepSuccess(
    definition,
    run,
    step,
    resolution.resolvedParameters,
    entityIds,
    verification.verifiedFields,
    at(),
  );
  const persisted = await chatbotDb.updateSessionWorkflowRun(sessionId, successRun, { requireVersion: run.version });
  if (!persisted?.workflowRun) return { kind: 'conflict', run };
  return { kind: persisted.workflowRun.status === 'completed' ? 'completed' : 'step_verified', run: persisted.workflowRun };
}

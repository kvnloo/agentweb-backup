/**
 * Deterministic Workflow engine (ENG-397) — ordered typed steps with declared
 * inputs/outputs, checkpointed mutations, and up-front parameter resolution.
 *
 * WHY THIS EXISTS (incident 2026-07-15/16, session e2fd937d…): the RankAI Meta
 * campaign build ran as ~520 messages of free-text chat. Every step's spec
 * lived in prose; every retry re-derived state from chat memory instead of
 * live API state. Duplicate campaigns got created and deleted, ads got
 * attached to wrong images, and the campaign objective silently defaulted.
 *
 * THIS IS NOT `workPlan` (`create_work_plan`/`set_work_plan_status`). That
 * primitive is a freeform to-do list: steps are prose title/description
 * strings the model itself writes, and its only gates are a step-order check
 * and a call-count check (`requiredFunctionCalls` against a session-wide
 * `calledFunctions` counter) — it has no declared typed inputs/outputs, no
 * entity-ID checkpointing, and no read-back verification tied to a step
 * contract. This module is the typed, checkpointed, verified alternative the
 * ticket asks for.
 *
 * This module is PURE (no I/O) — it only reuses the existing ENG-396
 * AskUserQuestion gate (`checkQuestionGate`/`findQuestionByKind`) to resolve
 * irreversible/spend-bearing parameters, rather than inventing a parallel
 * resolution mechanism. Persistence lives in chatbotService
 * (`updateSessionWorkflowRun`); impure orchestration (calling a step's
 * execute/verify, reading/writing the session) lives in
 * `services/agentMode/workflowRunner.ts`.
 */

import { PendingUserQuestion, checkQuestionGate, findQuestionByKind } from './askUserQuestion';

/** A parameter a step's execute() needs that is IRREVERSIBLE/spend-bearing and
 *  must therefore be resolved via a prior ENG-396 AskUserQuestion — never
 *  invented mid-run. This module only GATES on the answer; emitting the
 *  question is a consumer concern (see resolveCampaignObjectiveGate for the
 *  reference pattern in agentModeService.ts) and is out of scope here. */
export interface WorkflowParameterRequirement {
  /** Name this value is written under in resolvedParameters / passed to execute(). */
  key: string;
  /** The AskUserQuestion `kind` to look up via findQuestionByKind. */
  questionKind: string;
  /** Field on the answered option's payload holding the concrete value. */
  payloadField: string;
}

export interface WorkflowVerificationMismatch {
  parameter: string;
  requested: unknown;
  applied: unknown;
}

/** Contract a step's verify() returns. A transport/read-back failure ('error')
 *  is distinct from a genuine mismatch — mirrors the existing ad-set
 *  read-back convention's readBackError vs readBackMismatch split. */
export type WorkflowStepVerification =
  | { verified: true; verifiedFields: Record<string, unknown> }
  | { verified: false; mismatches: WorkflowVerificationMismatch[] }
  | { verified: false; error: string };

/**
 * One typed step. `execute`/`verify` are function-typed fields (same
 * precedent as the `ToolRegistry` interface in `core/types.ts`) — declaring
 * their signature here does not make this file impure; only a concrete step
 * implementation (e.g. createCampaignStep.ts) actually calls out to an API.
 *
 * Contract: execute() MUST resolve to an object whose keys include every
 * name in `outputs` — the engine extracts entityIds from those keys.
 */
export interface WorkflowStepDefinition {
  id: string;
  inputs: string[];
  outputs: string[];
  requiredParameters: WorkflowParameterRequirement[];
  execute: (resolvedParameters: Record<string, unknown>) => Promise<Record<string, unknown>>;
  verify: (
    executeResult: Record<string, unknown>,
    resolvedParameters: Record<string, unknown>,
  ) => Promise<WorkflowStepVerification>;
}

export interface WorkflowDefinition {
  workflowId: string;
  /** Order is the workflow order. */
  steps: WorkflowStepDefinition[];
}

export type WorkflowRunStatus = 'in_progress' | 'blocked_on_parameter' | 'completed' | 'failed';

/** Persisted per-attempted-step record. Absence of an entry for a step id
 *  means "not attempted yet" — not modeled as its own status, keeping the
 *  enum to exactly the states a real transition produces. */
export interface WorkflowStepCheckpoint {
  stepId: string;
  status: 'verified' | 'failed';
  entityIds?: Record<string, string>;
  verifiedFields?: Record<string, unknown>;
  verifiedAt?: string;
  failedAt?: string;
  discrepancy?: WorkflowVerificationMismatch[] | { error: string };
}

export interface WorkflowBlock {
  stepId: string;
  missingParameter: string;
  questionKind: string;
  reason: string;
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  checkpoints: WorkflowStepCheckpoint[];
  /** Parameters resolved so far, keyed by `WorkflowParameterRequirement.key`.
   *  Applied verbatim downstream — never re-derived (mirrors the
   *  askUserQuestion.ts payload contract). */
  resolvedParameters: Record<string, unknown>;
  /** Present only while status === 'blocked_on_parameter'. */
  blockedOn?: WorkflowBlock;
  /** Present only while status === 'failed'. */
  failedStepId?: string;
  /** Optimistic-lock version. Bumped by every transition function below. The
   *  consumer passes the PRE-transition value as `requireVersion` to
   *  chatbotDb.updateSessionWorkflowRun. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function buildWorkflowRunState(input: {
  runId: string;
  workflowId: string;
  createdAt?: string;
  /** Ordinary (non-gated) values the caller already knows at start time —
   *  e.g. a campaign name or budget amount — seeded into resolvedParameters
   *  up front so a step's execute() isn't left to read an undefined input.
   *  Irreversible/spend-bearing values still MUST go through
   *  requiredParameters/AskUserQuestion, never through here. */
  initialParameters?: Record<string, unknown>;
}): WorkflowRunState {
  const at = input.createdAt ?? new Date(0).toISOString();
  return {
    runId: input.runId,
    workflowId: input.workflowId,
    status: 'in_progress',
    checkpoints: [],
    resolvedParameters: { ...(input.initialParameters ?? {}) },
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function findCheckpoint(run: WorkflowRunState, stepId: string): WorkflowStepCheckpoint | undefined {
  return run.checkpoints.find((c) => c.stepId === stepId);
}

/**
 * Flatten every VERIFIED checkpoint's entityIds into one bag, keyed by output
 * name — e.g. { campaign_id: 'camp_1' }. This is the "campaign_id feeds the
 * next step" mechanism from the ticket's own example: a later step whose
 * `inputs` names one of these keys receives it automatically (see
 * workflowRunner.advanceWorkflow, which merges this ahead of
 * resolvedParameters when building a step's execution input). Always derived
 * fresh from checkpoints — the source of truth — rather than duplicated into
 * `resolvedParameters`, so there is exactly one place this data lives.
 */
export function collectEntityIdsFromCheckpoints(run: WorkflowRunState): Record<string, string> {
  const collected: Record<string, string> = {};
  for (const checkpoint of run.checkpoints) {
    if (checkpoint.status === 'verified' && checkpoint.entityIds) {
      Object.assign(collected, checkpoint.entityIds);
    }
  }
  return collected;
}

/**
 * First step WITHOUT a 'verified' checkpoint, in definition order. Returns
 * null when the run is terminal ('completed'/'failed') or every step is
 * verified.
 *
 * THIS is the resumability primitive (AC2): a step already checkpointed
 * 'verified' is never returned, so a fresh call after a kill-and-restart
 * picks up at the next unattempted step and never re-runs (or re-creates the
 * entity for) a step that's done. A 'failed' run always returns null here —
 * that single fact is what guarantees AC4's "subsequent steps do not run"
 * without any extra check at call sites.
 */
export function findNextStep(definition: WorkflowDefinition, run: WorkflowRunState): WorkflowStepDefinition | null {
  if (run.status === 'completed' || run.status === 'failed') return null;
  for (const step of definition.steps) {
    const checkpoint = findCheckpoint(run, step.id);
    if (!checkpoint || checkpoint.status !== 'verified') return step;
  }
  return null;
}

export type ResolveStepParametersResult =
  | { blocked: false; resolvedParameters: Record<string, unknown> }
  | { blocked: true; block: WorkflowBlock };

/**
 * Gate a step's requiredParameters against the session's live/archived
 * AskUserQuestion state, via the EXISTING checkQuestionGate/findQuestionByKind
 * — no parallel resolution mechanism. Returns the merged resolved bag (prior
 * run.resolvedParameters plus this step's newly-resolved values) or the
 * first unresolved requirement (AC3: blocks before mutation, surfaces the
 * missing input).
 */
export function resolveStepParameters(
  step: WorkflowStepDefinition,
  run: WorkflowRunState,
  pending: PendingUserQuestion | null | undefined,
  archive: Record<string, PendingUserQuestion> | null | undefined,
): ResolveStepParametersResult {
  const resolvedParameters: Record<string, unknown> = { ...run.resolvedParameters };

  for (const req of step.requiredParameters) {
    if (Object.prototype.hasOwnProperty.call(resolvedParameters, req.key)) continue;

    const candidate = findQuestionByKind(pending, archive, req.questionKind);
    const gate = checkQuestionGate(pending, candidate?.questionId, archive);
    if (!gate.allowed) {
      return {
        blocked: true,
        block: { stepId: step.id, missingParameter: req.key, questionKind: req.questionKind, reason: gate.reason },
      };
    }

    const value = gate.payload?.[req.payloadField];
    if (value === undefined) {
      return {
        blocked: true,
        block: {
          stepId: step.id,
          missingParameter: req.key,
          questionKind: req.questionKind,
          reason: `Answered option for kind '${req.questionKind}' carried no '${req.payloadField}' payload field`,
        },
      };
    }
    resolvedParameters[req.key] = value;
  }

  return { blocked: false, resolvedParameters };
}

export function markBlockedOnParameter(run: WorkflowRunState, block: WorkflowBlock, at: string): WorkflowRunState {
  return {
    ...run,
    status: 'blocked_on_parameter',
    blockedOn: block,
    version: run.version + 1,
    updatedAt: at,
  };
}

/**
 * Appends/replaces this step's checkpoint as 'verified'; merges the
 * parameters that were resolved to run it into run.resolvedParameters (so a
 * later step doesn't re-ask); clears blockedOn; sets status to 'completed'
 * iff this was the last step in definition order, else 'in_progress'.
 */
export function recordStepSuccess(
  definition: WorkflowDefinition,
  run: WorkflowRunState,
  step: WorkflowStepDefinition,
  resolvedParameters: Record<string, unknown>,
  entityIds: Record<string, string>,
  verifiedFields: Record<string, unknown>,
  at: string,
): WorkflowRunState {
  const checkpoint: WorkflowStepCheckpoint = {
    stepId: step.id,
    status: 'verified',
    entityIds,
    verifiedFields,
    verifiedAt: at,
  };
  const checkpoints = [...run.checkpoints.filter((c) => c.stepId !== step.id), checkpoint];
  const isLastStep = definition.steps[definition.steps.length - 1]?.id === step.id;
  const allVerified = definition.steps.every(
    (s) => checkpoints.find((c) => c.stepId === s.id)?.status === 'verified',
  );

  return {
    ...run,
    status: isLastStep && allVerified ? 'completed' : 'in_progress',
    checkpoints,
    resolvedParameters,
    blockedOn: undefined,
    version: run.version + 1,
    updatedAt: at,
  };
}

/**
 * Appends a 'failed' checkpoint with the discrepancy attached verbatim; sets
 * status:'failed' + failedStepId. findNextStep on a 'failed' run always
 * returns null (see its docstring) — that's what makes AC4's "subsequent
 * steps do not run" hold without any extra check at call sites.
 */
export function recordStepFailure(
  run: WorkflowRunState,
  step: WorkflowStepDefinition,
  discrepancy: WorkflowVerificationMismatch[] | { error: string },
  at: string,
): WorkflowRunState {
  const checkpoint: WorkflowStepCheckpoint = {
    stepId: step.id,
    status: 'failed',
    discrepancy,
    failedAt: at,
  };
  const checkpoints = [...run.checkpoints.filter((c) => c.stepId !== step.id), checkpoint];

  return {
    ...run,
    status: 'failed',
    checkpoints,
    failedStepId: step.id,
    blockedOn: undefined,
    version: run.version + 1,
    updatedAt: at,
  };
}

/** Human/log-facing rendering of "failed-at-step-N". Uses the step's 1-based
 *  position in definition order plus its stable id, since the ticket's own
 *  phrase doesn't specify index vs id and no acceptance criterion checks this
 *  string literally. Returns null when the run has not failed. */
export function describeFailedAtStep(definition: WorkflowDefinition, run: WorkflowRunState): string | null {
  if (run.status !== 'failed' || !run.failedStepId) return null;
  const index = definition.steps.findIndex((s) => s.id === run.failedStepId);
  const position = index === -1 ? '?' : index + 1;
  return `failed-at-step-${position} (${run.failedStepId})`;
}

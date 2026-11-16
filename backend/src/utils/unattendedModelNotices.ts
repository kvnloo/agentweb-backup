import type { ModelUnavailableError, ModelUnavailableReason } from '../services/agentMode/modelUnavailable';
import { ACCOUNT_DISCONNECTED_STATUS } from './scheduledRunAccountGate';
import { SEND_CAPACITY_EXHAUSTED_STATUS } from './scheduledRunCapacityGate';
import { MODEL_UNAVAILABLE_BLOCK_REASON } from './scheduleRunBlockedReason';
import { isTestScheduledSession } from './scheduledTestRunSession';
import { shouldForceScheduledAutocomplete } from '../services/agentMode/core/scheduledAutocomplete';

/**
 * ENG-669 PR-D: the decisions behind the owner notices for unattended runs whose model was refused (outside the plan,
 * or no longer available). Pure, so the "once per change into the state" rules are tested without a scheduled run.
 * The copy is unattendedModelNoticeCopy.ts's; the wiring is runScheduledChat's and pauseWorkPlanForUnavailableStepModel's.
 */

/** The fields a schedule run result carries when its saved model was refused (see MODEL_UNAVAILABLE_BLOCK_REASON). */
export interface ScheduleModelBlock {
  blockedBy: typeof MODEL_UNAVAILABLE_BLOCK_REASON;
  blockedReason: ModelUnavailableReason;
  /** The refused id as the schedule saved it. */
  blockedModel: string;
}

export function scheduleModelBlockFields(error: ModelUnavailableError): ScheduleModelBlock {
  return { blockedBy: MODEL_UNAVAILABLE_BLOCK_REASON, blockedReason: error.reason, blockedModel: error.requestedModel };
}

export function isScheduleModelBlockedRun(run: unknown): boolean {
  return !!run && typeof run === 'object' && (run as { blockedBy?: unknown }).blockedBy === MODEL_UNAVAILABLE_BLOCK_REASON;
}

/**
 * Skips written by the gates that run BEFORE the model is resolved (a disconnected LinkedIn account, no daily invite
 * budget) say nothing about the model, so they neither continue nor end a model block.
 */
const PRE_MODEL_GATE_SKIP_STATUSES = new Set<string>([ACCOUNT_DISCONNECTED_STATUS, SEND_CAPACITY_EXHAUSTED_STATUS]);

/**
 * Set (true) on a run result that FAILED before the model was resolved (the usage limit, a required function the plan
 * does not allow or could not be checked, unresolved entitlements, a withheld report, a deleted owner; a run missing its
 * variables saves no result at all): like the skips above, it says nothing
 * about the model, so it neither continues nor ends a model block (#3676 follow-up 1: blocked, then a limit, then
 * blocked again is one episode, one email).
 */
export const ENDED_BEFORE_MODEL_CHECK_FLAG = 'endedBeforeModelCheck';

/**
 * Set (true) on a model-blocked result of a manual Test run. A Test run never emails the owner (they are watching it),
 * so it must not count as the block they were told about: the next cron run still emails (#3676 follow-up 3).
 */
export const SCHEDULE_TEST_RUN_FLAG = 'testRun';

/** A prior run that tells nothing about whether the owner was told of a model block (see the flags above). */
function isSilentOnModelBlock(run: object): boolean {
  const flags = run as Record<string, unknown>;
  return PRE_MODEL_GATE_SKIP_STATUSES.has(typeof flags.status === 'string' ? flags.status : '')
    || flags[ENDED_BEFORE_MODEL_CHECK_FLAG] === true
    || (flags[SCHEDULE_TEST_RUN_FLAG] === true && isScheduleModelBlockedRun(run));
}

/**
 * True when `block` is a change INTO the blocked state, so the owner is emailed: the most recent prior run that got as
 * far as the model was not blocked (it ran, or there is none), or was blocked on a different model or for a different
 * reason (the owner changed the pin to another model that is refused too, or the model went from "not in your plan" to
 * "no longer available"). False while the same block repeats, so an hourly schedule sends one email, not 24 a day.
 *
 * Edge-triggered on run history like didSourcingBlockStateChange, with no persisted "already emailed" flag: a run that
 * gets past the model check (the owner chose a model the plan includes, upgraded, or unpinned the schedule) ends the
 * state, and a later block emails again. Runs that say nothing about it are passed over (isSilentOnModelBlock): the
 * pre-model skips and failures, and a Test run's block. `priorRunResults` is the history BEFORE this run.
 */
export function isNewScheduleModelBlock(priorRunResults: unknown, block: ScheduleModelBlock): boolean {
  const results = Array.isArray(priorRunResults) ? priorRunResults : [];
  for (let i = results.length - 1; i >= 0; i--) {
    const run = results[i];
    if (!run || typeof run !== 'object' || isSilentOnModelBlock(run)) continue;
    if (!isScheduleModelBlockedRun(run)) return true;
    const prior = run as { blockedModel?: unknown; blockedReason?: unknown };
    return prior.blockedModel !== block.blockedModel || prior.blockedReason !== block.blockedReason;
  }
  return true;
}

/**
 * Is nobody reading this session's chat when its work plan pauses? The turn's own `isUnattendedRun` signal when the
 * caller passes one (true for runScheduledChat and the headless runVerifiedChat callers, false for every interactive
 * route), else how the session was created: the same tri-state rule as shouldForceScheduledAutocomplete. A manual
 * "Test this schedule" run is unattended by that signal but the owner is watching it, so it is excluded.
 */
export function isUnattendedPause(
  session: { sessionType?: string; pageIdentifier?: string; title?: string } | null | undefined,
  isUnattendedRun?: boolean,
): boolean {
  return shouldForceScheduledAutocomplete(session, isUnattendedRun) && !isTestScheduledSession(session);
}

/** Metadata stamped on the in-chat step pause message when its owner notice was sent. */
export const STEP_MODEL_NOTICE_SENT_FLAG = 'ownerNotified';

/**
 * True when the owner was already emailed about this step of this session: some earlier pause message for the step
 * carries the sent flag. Read across the WHOLE transcript, not just its tail: an unattended run nudges the model again
 * after a pause (runVerifiedChat's retry turns), and each nudge produces a fresh pause message for the same step.
 */
export function wasStepModelNoticeSent(messages: unknown, stepCount: number): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message: any) => {
    const meta = message?.metadata;
    return message?.role === 'assistant'
      && meta?.kind === 'work-plan-step-model-unavailable'
      && meta?.stepCount === stepCount
      && meta?.[STEP_MODEL_NOTICE_SENT_FLAG] === true;
  });
}

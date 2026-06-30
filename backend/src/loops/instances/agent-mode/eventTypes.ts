/**
 * Agent-mode loop — event vocabulary.
 *
 * This is the concrete realization of the audit's "plug AgentMode into the same
 * apparatus" ask. Rather than build a parallel telemetry system, AgentMode emits
 * NormalizedEvents into the SAME `Dev-AW-LoopEvents` table the funnel loops use,
 * so the same sensor, attribution cron, cooldown read-back, and health endpoint
 * cover it for free.
 *
 * Mapping to the record types Rui named:
 *
 *   AgentRun / AgentRunEvent  — the debugging timeline. Every event below,
 *                               keyed by subjectId = runId, IS one response
 *                               attempt's timeline (run_started … tool
 *                               events … run_*). sessionId is stored as a join
 *                               dimension.
 *   AgentDecision             — `agent_decision`: why Emma chose an action
 *                               (which tools, which iteration).
 *   AgentOutcome              — `agent_tool_succeeded` / `agent_tool_failed`
 *                               and `agent_run_completed` / `agent_run_failed`:
 *                               what happened after the action.
 *   AgentLearningEvent        — NOT an event here; it's the durable LearningEvent
 *                               the loop's policy→tools→learning pipeline writes
 *                               when a repeated failure pattern is detected, with
 *                               the exact proposed fix. (see failureRuleSet.ts)
 *
 * The target metric is tool reliability: agent_tool_succeeded / agent_tool_invoked.
 * `agent_tool_invoked` fires on every call (the denominator); a terminal
 * succeeded/failed fires alongside it (the numerator / the failure signal the
 * policy groups by tool).
 */

import { asLoopId } from '../../core/types';

export const AGENT_MODE_LOOP_ID = asLoopId('agent-mode');

/** The run begins (one per chat turn that may call tools). */
export const EVT_RUN_STARTED = 'agent_run_started';
/** The LLM decided to call one or more tools this iteration. */
export const EVT_DECISION = 'agent_decision';
/** A tool call was dispatched — the reliability denominator. */
export const EVT_TOOL_INVOKED = 'agent_tool_invoked';
/** A tool call returned successfully — the reliability numerator. */
export const EVT_TOOL_SUCCEEDED = 'agent_tool_succeeded';
/** A tool call threw / errored — the signal the policy groups by tool. */
export const EVT_TOOL_FAILED = 'agent_tool_failed';
/** A tool call was skipped without executing — neither success nor failure.
 * Today this is media-gen calls deferred by the per-run time budget. Recorded
 * as its own class so deferred/skipped is accounted separately from success and
 * failure and never pollutes the reliability ratio or the failure policy. */
export const EVT_TOOL_DEFERRED = 'agent_tool_deferred';
/** A tool call SUCCEEDED but returned an explicitly partial result — some
 * sub-sections of its output were unavailable (e.g. get_meta_ads_metrics where a
 * breakdown endpoint errored while the core metrics came back). The call is still
 * a success (it is NOT a failure and must not pollute the failure ratio), but the
 * partial degradation is recorded as its own class so a section silently going
 * dark is visible to telemetry instead of hiding behind success:true (ENG-104). */
export const EVT_TOOL_PARTIAL_FAILURE = 'agent_tool_partial_failure';
/** The run finished and produced a final answer. */
export const EVT_RUN_COMPLETED = 'agent_run_completed';
/** The run aborted with an unrecovered error. */
export const EVT_RUN_FAILED = 'agent_run_failed';
/** Durable outcome verdict (ok | degraded | failed), emitted alongside every
 * terminal run event. "Completed" ≠ "succeeded": runs absorb tool failures and
 * still complete, and only a durable event lets the loop's sensor learn from
 * degraded runs (the inspector's read-time flags are invisible to the policy). */
export const EVT_RUN_VERDICT = 'agent_run_verdict';

export const AGENT_MODE_EVENT_TYPES = [
  EVT_RUN_STARTED,
  EVT_DECISION,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
  EVT_TOOL_FAILED,
  EVT_TOOL_DEFERRED,
  EVT_TOOL_PARTIAL_FAILURE,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_VERDICT,
] as const;

/**
 * Tests for buildEvalCases — turning failed/degraded AgentRuns into replayable
 * eval cases (the replay-eval harness seed).
 *
 * Behavioral contract:
 *   1. Only failed or degraded runs become eval cases — clean runs are noise.
 *      Runs without a stored verdict event are judged by computeRunVerdict
 *      over their counts (historical pre-verdict events still export).
 *   2. A case carries everything needed to reproduce/categorize the failure:
 *      runId, sessionId, model, verdict + reasons, per-failure toolName +
 *      errorClass + errorMessage, and the decision context (tool names +
 *      already-redacted args previews).
 *   3. summarizeEvalCases aggregates by toolName × errorClass with counts,
 *      sorted worst-first — the seed for the human-curated eval set.
 *   4. No raw user content beyond the upstream-redacted previews leaves the
 *      rows — cases must be safe to share in a repo-external fixture dir.
 */

import { buildEvalCases, summarizeEvalCases } from '../loops/scripts/exportEvalCases';
import type { AgentRunEventRow } from '../services/agentRunInspectorService';

function row(runId: string, eventType: string, ts: string, dimensions?: Record<string, unknown>): AgentRunEventRow {
  return { subjectId: runId, eventType, ts, dimensions } as AgentRunEventRow;
}

function cleanRun(runId: string, ts: string): AgentRunEventRow[] {
  return [
    row(runId, 'agent_run_started', ts, { sessionId: `s-${runId}`, llmModel: 'claude-sonnet-4-6' }),
    row(runId, 'agent_tool_invoked', ts, { toolName: 'search_web' }),
    row(runId, 'agent_tool_succeeded', ts, { toolName: 'search_web' }),
    row(runId, 'agent_run_completed', ts, { toolCalls: 1, failedToolCalls: 0 }),
    row(runId, 'agent_run_verdict', ts, { verdict: 'ok', reasons: '', toolCalls: 1, failedToolCalls: 0 }),
  ];
}

function degradedRun(runId: string, ts: string): AgentRunEventRow[] {
  return [
    row(runId, 'agent_run_started', ts, { sessionId: `s-${runId}`, llmModel: 'claude-sonnet-4-6' }),
    row(runId, 'agent_decision', ts, { iteration: 1, toolNames: 'linkedin_outreach', toolArgsPreview: '{"message":"[redacted preview]"}' }),
    row(runId, 'agent_tool_invoked', ts, { toolName: 'linkedin_outreach' }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'linkedin_outreach', errorClass: 'invalid_args', errorMessage: 'Invitation message is too long (224 characters)' }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'linkedin_outreach', errorClass: 'invalid_args', errorMessage: 'Invitation message is too long (231 characters)' }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'linkedin_outreach', errorClass: 'invalid_args', errorMessage: 'Invalid parameters' }),
    row(runId, 'agent_run_completed', ts, { toolCalls: 4, failedToolCalls: 3 }),
    row(runId, 'agent_run_verdict', ts, { verdict: 'degraded', reasons: 'failed_tool_calls,repeated_tool_failures', toolCalls: 4, failedToolCalls: 3 }),
  ];
}

/** Pre-verdict era: failures but no agent_run_verdict event stored. */
function legacyDegradedRun(runId: string, ts: string): AgentRunEventRow[] {
  return [
    row(runId, 'agent_run_started', ts, { sessionId: `s-${runId}` }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'legacy_search_web', errorClass: 'Error', errorMessage: 'Request failed with status code 429' }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'legacy_search_web', errorClass: 'Error', errorMessage: 'Request failed with status code 429' }),
    row(runId, 'agent_tool_failed', ts, { toolName: 'legacy_search_web', errorClass: 'Error', errorMessage: 'Request failed with status code 429' }),
    row(runId, 'agent_run_completed', ts, { toolCalls: 5, failedToolCalls: 3 }),
  ];
}

describe('buildEvalCases', () => {
  it('exports degraded and failed runs, skips clean ones', () => {
    const rows = [
      ...cleanRun('run-ok', '2026-06-12T08:00:00.000Z'),
      ...degradedRun('run-bad', '2026-06-12T07:00:00.000Z'),
    ];

    const cases = buildEvalCases(rows);

    expect(cases).toHaveLength(1);
    expect(cases[0].runId).toBe('run-bad');
    expect(cases[0].verdict).toBe('degraded');
    expect(cases[0].reasons).toContain('failed_tool_calls');
  });

  it('judges pre-verdict-era runs by their counts so history still exports', () => {
    const cases = buildEvalCases(legacyDegradedRun('run-legacy', '2026-06-10T08:00:00.000Z'));

    expect(cases).toHaveLength(1);
    expect(cases[0].verdict).toBe('degraded');
  });

  it('carries failure details and decision context on the case', () => {
    const [evalCase] = buildEvalCases(degradedRun('run-bad', '2026-06-12T07:00:00.000Z'));

    expect(evalCase.sessionId).toBe('s-run-bad');
    expect(evalCase.llmModel).toBe('claude-sonnet-4-6');
    expect(evalCase.failures).toHaveLength(3);
    expect(evalCase.failures[0]).toEqual(
      expect.objectContaining({ toolName: 'linkedin_outreach', errorClass: 'invalid_args' }),
    );
    expect(evalCase.decisions[0].toolNames).toContain('linkedin_outreach');
    expect(evalCase.decisions[0].toolArgsPreview).toContain('redacted');
  });
});

describe('summarizeEvalCases', () => {
  it('aggregates by toolName × errorClass, worst-first', () => {
    const cases = buildEvalCases([
      ...degradedRun('run-1', '2026-06-12T07:00:00.000Z'),
      ...degradedRun('run-2', '2026-06-12T06:00:00.000Z'),
      ...legacyDegradedRun('run-3', '2026-06-10T08:00:00.000Z'),
    ]);

    const summary = summarizeEvalCases(cases);

    expect(summary[0].toolName).toBe('linkedin_outreach');
    expect(summary[0].errorClass).toBe('invalid_args');
    expect(summary[0].failureCount).toBe(6);
    expect(summary[0].runCount).toBe(2);
    expect(summary[1].toolName).toBe('legacy_search_web');
    expect(summary[1].failureCount).toBe(3);
  });
});

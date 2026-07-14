/**
 * Tests for the post-run outcome verdict (degraded-run detection).
 *
 * Behavioral contract (June 12 telemetry finding: 165 runs, 0 hard failures,
 * but 60+ tool failures silently absorbed — "completed" ≠ "succeeded", and
 * nothing durable records the difference, so the agent-mode loop cannot learn
 * from degraded runs):
 *   1. computeRunVerdict is deterministic:
 *      - failed terminal state → 'failed'
 *      - ≥3 failed tool calls, OR ≥1/3 of tool calls failed, OR the same tool
 *        failed ≥3 times → 'degraded', with machine-readable reasons
 *      - otherwise → 'ok' (1 failure in a 28-call run must NOT flag)
 *   2. The recorder emits a durable `agent_run_verdict` spine event alongside
 *      every terminal run event, carrying verdict + reasons + counts, so the
 *      loop's sensor (not just the read-time inspector) can consume it.
 *   3. The inspector surfaces the verdict on the run summary and flags
 *      degraded runs.
 */

import {
  AgentRunRecorder,
  computeRunVerdict,
} from '../loops/instances/agent-mode/runRecorder';
import { EVT_RUN_VERDICT } from '../loops/instances/agent-mode/eventTypes';
import { buildAgentRunSummaries, AgentRunEventRow } from '../services/agentRunInspectorService';
import type { ClockPort, DynamoPort } from '../loops/core/ports';

function fakeDynamo(): { port: DynamoPort; puts: Array<{ table: string; item: unknown }> } {
  const puts: Array<{ table: string; item: unknown }> = [];
  const port = {
    putItem: async (table: string, item: unknown) => {
      puts.push({ table, item });
    },
    getItem: async () => null,
    query: async () => ({ items: [] }),
  } as unknown as DynamoPort;
  return { port, puts };
}

const clock: ClockPort = { now: () => new Date('2026-06-12T08:00:00.000Z') };

describe('computeRunVerdict', () => {
  it('returns ok for a clean run and for sporadic failures', () => {
    expect(computeRunVerdict({ failed: false, toolCalls: 5, failedToolCalls: 0 }).verdict).toBe('ok');
    // The June telemetry's typical healthy-but-imperfect run: 28 calls, 1-2 failures.
    expect(computeRunVerdict({ failed: false, toolCalls: 28, failedToolCalls: 2 }).verdict).toBe('ok');
  });

  it('returns failed for a failed terminal state', () => {
    const v = computeRunVerdict({ failed: true, toolCalls: 1, failedToolCalls: 1 });
    expect(v.verdict).toBe('failed');
  });

  it('flags degraded on ≥3 failed tool calls', () => {
    const v = computeRunVerdict({ failed: false, toolCalls: 28, failedToolCalls: 3 });
    expect(v.verdict).toBe('degraded');
    expect(v.reasons).toContain('failed_tool_calls');
  });

  it('flags degraded on high failure ratio even with few calls', () => {
    const v = computeRunVerdict({ failed: false, toolCalls: 4, failedToolCalls: 2 });
    expect(v.verdict).toBe('degraded');
    expect(v.reasons).toContain('high_failure_ratio');
  });

  it('flags degraded when the same tool fails repeatedly — the retry-spiral case', () => {
    const v = computeRunVerdict({
      failed: false,
      toolCalls: 20,
      failedToolCalls: 2,
      maxSameToolFailures: 3,
    });
    // Only 10% failed overall, but one tool got hammered — that is the
    // linkedin_outreach 15-retries-in-16s shape.
    expect(v.verdict).toBe('degraded');
    expect(v.reasons).toContain('repeated_tool_failures');
  });

  it('flags degraded on an unresolved finalize-guard claim mismatch (ENG-143)', () => {
    // Zero tool failures — the run "worked" — but the final message claimed an
    // action the ledger does not back. That is user-facing degradation and must
    // reach the 17:30 UTC failure-cluster cron via the verdict reasons.
    const v = computeRunVerdict({ failed: false, toolCalls: 2, failedToolCalls: 0, claimMismatch: true });
    expect(v.verdict).toBe('degraded');
    expect(v.reasons).toContain('claim_mismatch');
  });

  it('claimMismatch absent/false leaves the verdict unchanged', () => {
    expect(computeRunVerdict({ failed: false, toolCalls: 2, failedToolCalls: 0, claimMismatch: false }).verdict).toBe('ok');
    expect(computeRunVerdict({ failed: false, toolCalls: 2, failedToolCalls: 0 }).verdict).toBe('ok');
  });
});

describe('AgentRunRecorder verdict emission', () => {
  it('emits agent_run_verdict alongside run_completed', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-1', { toolCalls: 10, failedToolCalls: 4, sessionId: 's1' });

    const verdictPut = puts.map((p) => p.item as any).find((i) => i.eventType === EVT_RUN_VERDICT);
    expect(verdictPut).toBeDefined();
    expect(verdictPut.dimensions.verdict).toBe('degraded');
    expect(String(verdictPut.dimensions.reasons)).toContain('failed_tool_calls');
    expect(verdictPut.dimensions.toolCalls).toBe(10);
    expect(verdictPut.dimensions.sessionId).toBe('s1');
  });

  it('emits an ok verdict for clean completions', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-2', { toolCalls: 3, failedToolCalls: 0 });

    const verdictPut = puts.map((p) => p.item as any).find((i) => i.eventType === EVT_RUN_VERDICT);
    expect(verdictPut.dimensions.verdict).toBe('ok');
  });

  it('emits a failed verdict alongside run_failed', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runFailed('run-3', { error: new Error('boom'), toolCalls: 1, failedToolCalls: 1 });

    const verdictPut = puts.map((p) => p.item as any).find((i) => i.eventType === EVT_RUN_VERDICT);
    expect(verdictPut.dimensions.verdict).toBe('failed');
  });

  it('threads claimMismatch through runCompleted into a degraded verdict with claim_mismatch reason', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('run-4', { toolCalls: 2, failedToolCalls: 0, sessionId: 's4', claimMismatch: true });

    const verdictPut = puts.map((p) => p.item as any).find((i) => i.eventType === EVT_RUN_VERDICT);
    expect(verdictPut.dimensions.verdict).toBe('degraded');
    expect(String(verdictPut.dimensions.reasons)).toContain('claim_mismatch');
  });

  it('emits a loud agent_claim_check_error event when the finalize-guard judge fails', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.claimCheckError('run-5', { sessionId: 's5', error: new Error('judge unavailable: 503 service unavailable') });

    const item = puts.map((p) => p.item as any).find((i) => i.eventType === 'agent_claim_check_error');
    expect(item).toBeDefined();
    expect(item.subjectId).toBe('run-5');
    expect(item.dimensions.sessionId).toBe('s5');
    expect(item.dimensions.errorMessage).toContain('judge unavailable');
    expect(item.dimensions.errorClass).toBe('upstream_5xx');
  });
});

describe('inspector verdict surfacing', () => {
  function row(runId: string, eventType: string, ts: string, dimensions?: Record<string, unknown>): AgentRunEventRow {
    return { subjectId: runId, eventType, ts, dimensions } as AgentRunEventRow;
  }

  it('exposes the verdict + degraded flag on the run summary', () => {
    const rows = [
      row('run-1', 'agent_run_started', '2026-06-12T08:00:00.000Z', { sessionId: 's1' }),
      row('run-1', 'agent_run_completed', '2026-06-12T08:01:00.000Z', { toolCalls: 10, failedToolCalls: 4 }),
      row('run-1', 'agent_run_verdict', '2026-06-12T08:01:00.100Z', {
        verdict: 'degraded',
        reasons: 'failed_tool_calls,high_failure_ratio',
        toolCalls: 10,
        failedToolCalls: 4,
      }),
    ];

    const [summary] = buildAgentRunSummaries(rows);

    expect(summary.outcomeVerdict).toBe('degraded');
    expect(summary.outcomeReasons).toContain('failed_tool_calls');
    expect(summary.flags.some((f) => f.code === 'degraded_run')).toBe(true);
  });
});

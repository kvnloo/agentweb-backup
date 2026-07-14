/**
 * Tests for the agent-mode failure-pattern policy.
 *
 * The policy turns a window of agent-run events into proposals: for any tool
 * whose failures cluster (>= minFailures AND failure-rate >= minFailureRate
 * over the window), propose a cloud-dev fix spec carrying the exact failure
 * signature — the "repeated pattern + exact proposed fix" the audit asks for.
 * Healthy tools and one-off blips produce nothing.
 */

import { AgentFailureRuleSet } from '../loops/instances/agent-mode/failureRuleSet';
import {
  EVT_RUN_VERDICT,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';
import type { NormalizedEvent, TimeWindow } from '../loops/core/types';
import { asSubjectId } from '../loops/core/types';

const WINDOW: TimeWindow = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-08T00:00:00Z'),
};

let seq = 0;
function evt(
  eventType: string,
  toolName: string,
  extra: Record<string, string | number | boolean | null> = {},
): NormalizedEvent {
  seq++;
  return {
    subjectId: asSubjectId(`session-${seq}`),
    eventType,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { toolName, ...extra },
  };
}

function invoked(toolName: string, n: number): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_INVOKED, toolName));
}
function failed(toolName: string, n: number, errorClass = 'TimeoutError'): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_FAILED, toolName, { errorClass }));
}
function succeeded(toolName: string, n: number): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_SUCCEEDED, toolName));
}

/** A run_verdict event, as emitVerdict() writes it — no toolName dimension. */
function verdict(reasons: string[], sessionId = `session-${++seq}`): NormalizedEvent {
  return {
    subjectId: asSubjectId(sessionId),
    eventType: EVT_RUN_VERDICT,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { verdict: reasons.length > 0 ? 'degraded' : 'ok', reasons: reasons.join(','), sessionId },
  };
}

describe('AgentFailureRuleSet', () => {
  const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  it('proposes a fix for a tool whose failures clear both thresholds', async () => {
    const events = [
      ...invoked('generate_image', 10),
      ...failed('generate_image', 4),
      ...succeeded('generate_image', 6),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.kind).toBe('code_change');
    expect(p.sourceRuleId).toBe('tool-failure:generate_image');
    expect(p.payload).toEqual(
      expect.objectContaining({ toolName: 'generate_image', failures: 4, invocations: 10 }),
    );
    // triggering stats carry the dominant error class for the fix spec
    expect(p.triggeringStats).toEqual(
      expect.objectContaining({ toolName: 'generate_image', topErrorClass: 'TimeoutError' }),
    );
  });

  it('does NOT propose when failures are below the count threshold', async () => {
    const events = [...invoked('send_email', 20), ...failed('send_email', 2), ...succeeded('send_email', 18)];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(0);
  });

  it('does NOT propose when the failure rate is below threshold even if count is high', async () => {
    // 5 failures but out of 100 invocations = 5% < 20%
    const events = [...invoked('search', 100), ...failed('search', 5), ...succeeded('search', 95)];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(0);
  });

  it('proposes independently per tool and sorts the worst-rate tool first', async () => {
    const events = [
      ...invoked('alpha', 10),
      ...failed('alpha', 3), // 30%
      ...invoked('beta', 10),
      ...failed('beta', 8), // 80%
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.payload).map((x: any) => x.toolName)).toEqual(['beta', 'alpha']);
  });

  it('uses the most frequent error class as the failure signature', async () => {
    const events = [
      ...invoked('publish_post', 10),
      ...failed('publish_post', 1, 'AuthError'),
      ...failed('publish_post', 3, 'RateLimitError'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].triggeringStats).toEqual(
      expect.objectContaining({ topErrorClass: 'RateLimitError' }),
    );
  });

  it('returns nothing for an empty window', async () => {
    expect(await policy.evaluate([], WINDOW)).toEqual([]);
  });

  it('ignores failures with no toolName dimension (cannot attribute a fix)', async () => {
    const orphan: NormalizedEvent = {
      subjectId: asSubjectId('s-x'),
      eventType: EVT_TOOL_FAILED,
      ts: new Date('2026-06-04T00:00:00Z'),
    };
    const proposals = await policy.evaluate([orphan, orphan, orphan, orphan], WINDOW);
    expect(proposals).toHaveLength(0);
  });
});

/**
 * claim_mismatch clustering (ENG-143 gap): the finalize guard writes
 * agent_run_verdict events with reasons including 'claim_mismatch', but until
 * now nothing clustered them — the 17:30 UTC cron only ever scanned
 * agent_tool_invoked/agent_tool_failed, so a real truthfulness problem could
 * fire the guard every day and nobody would be told. These events carry no
 * toolName dimension (they're a whole-run verdict, not a per-tool outcome),
 * so they cannot flow through the per-tool clustering above — they need their
 * own aggregate count across the window.
 */
describe('AgentFailureRuleSet — claim_mismatch clustering (ENG-143)', () => {
  const policy = new AgentFailureRuleSet({ minClaimMismatches: 2 });

  it('proposes a truthfulness fix once claim_mismatch verdicts cross the threshold', async () => {
    const events = [
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
      verdict([], 's-3'), // clean run — must not count
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    const claimProposal = proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness');
    expect(claimProposal).toBeDefined();
    expect(claimProposal!.kind).toBe('code_change');
    expect(claimProposal!.payload).toEqual(
      expect.objectContaining({ occurrences: 2, sessionIds: ['s-1', 's-2'] }),
    );
    expect(claimProposal!.triggeringStats).toEqual(expect.objectContaining({ occurrences: 2 }));
  });

  it('does NOT propose below the threshold', async () => {
    const events = [verdict(['claim_mismatch'], 's-1'), verdict([], 's-2'), verdict([], 's-3')];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness')).toBeUndefined();
  });

  it('ignores run_verdict events whose reasons do not include claim_mismatch', async () => {
    const events = [
      verdict(['failed_tool_calls'], 's-1'),
      verdict(['high_failure_ratio'], 's-2'),
      verdict(['repeated_tool_failures'], 's-3'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness')).toBeUndefined();
  });

  it('coexists with per-tool failure proposals in the same window', async () => {
    const events = [
      ...invoked('generate_image', 10),
      ...failed('generate_image', 4),
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.sourceRuleId).sort()).toEqual(
      ['claim-mismatch:truthfulness', 'tool-failure:generate_image'].sort(),
    );
  });

  it('sorts the claim-mismatch proposal FIRST regardless of tool failure rate', async () => {
    const events = [
      // 90% failure rate — would sort first under the old tool-only comparator
      ...invoked('generate_image', 10),
      ...failed('generate_image', 9),
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.sourceRuleId)).toEqual([
      'claim-mismatch:truthfulness',
      'tool-failure:generate_image',
    ]);
  });
});

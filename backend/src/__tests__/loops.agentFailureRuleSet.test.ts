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

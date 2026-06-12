/**
 * Tests for the agent-mode run recorder — the bridge from AgentMode's hot path
 * into the shared Dev-AW-LoopEvents table.
 *
 * The recorder must:
 *   - write the right NormalizedEvent for each lifecycle point (run start,
 *     decision, tool invoked/succeeded/failed, run end)
 *   - key every event by subjectId = runId so they form one run timeline
 *     while allowing sessionId to be stored as a join dimension
 *   - put the toolName + errorClass on dimensions (the policy groups on these)
 *   - NEVER throw into the caller's hot path (telemetry failures are swallowed)
 */

import { AgentRunRecorder } from '../loops/instances/agent-mode/runRecorder';
import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';

function fakeDynamo() {
  const puts: Array<{ table: string; item: DynamoAttributeMap }> = [];
  const port: DynamoPort = {
    putItem: jest.fn(async (table: string, item: DynamoAttributeMap) => {
      puts.push({ table, item });
    }),
    getItem: jest.fn(async () => null),
    query: jest.fn(async () => ({ items: [] })),
  };
  return { port, puts };
}

const NOW = new Date('2026-06-09T12:00:00Z');
const clock = { now: () => NOW };

describe('AgentRunRecorder', () => {
  it('records run start keyed by sessionId with model on dimensions', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runStarted('sess-1:run:abc', { llmModel: 'claude-opus-4-8', sessionType: 'regular', sessionId: 'sess-1' });

    expect(puts).toHaveLength(1);
    const item = puts[0].item as any;
    expect(item.loopId).toBe('agent-mode');
    expect(item.eventType).toBe(EVT_RUN_STARTED);
    expect(item.subjectId).toBe('sess-1:run:abc');
    expect(item.dimensions.sessionId).toBe('sess-1');
    expect(item.dimensions.llmModel).toBe('claude-opus-4-8');
    expect(item.dimensions.sessionType).toBe('regular');
    // tsSession is the SK and must include runId + eventType for uniqueness
    expect(String(item.tsSession)).toContain('sess-1:run:abc');
  });

  it('records a decision with the chosen tool names', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.decision('sess-1', {
      iteration: 2,
      toolNames: ['generate_image', 'send_email'],
      toolArgKeys: 'generate_image:prompt,send_email:subject|to',
      toolArgsPreview: '[{"tool":"generate_image","args":{"prompt":"hero image"}}]',
      decisionExplanation: 'Chose multiple tools in one iteration.',
      explanationSource: 'deterministic_tool_summary',
      toolPolicyFlags: 'send_email:confirmation_recommended:critical',
      toolPolicySummary: 'send_email:external_send:high:observe',
    });

    const item = puts[0].item as any;
    expect(item.eventType).toBe(EVT_DECISION);
    expect(item.dimensions.toolNames).toBe('generate_image,send_email');
    expect(item.dimensions.toolCount).toBe(2);
    expect(item.dimensions.iteration).toBe(2);
    expect(item.dimensions.toolArgKeys).toBe('generate_image:prompt,send_email:subject|to');
    expect(item.dimensions.toolArgsPreview).toContain('hero image');
    expect(item.dimensions.decisionExplanation).toBe('Chose multiple tools in one iteration.');
    expect(item.dimensions.explanationSource).toBe('deterministic_tool_summary');
    expect(item.dimensions.toolPolicyFlags).toBe('send_email:confirmation_recommended:critical');
    expect(item.dimensions.toolPolicySummary).toBe('send_email:external_send:high:observe');
  });

  it('records tool invoked + succeeded with toolName + duration', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolInvoked('sess-1', { toolName: 'search', iteration: 1 });
    await rec.toolSucceeded('sess-1', { toolName: 'search', durationMs: 1234 });

    expect((puts[0].item as any).eventType).toBe(EVT_TOOL_INVOKED);
    expect((puts[0].item as any).dimensions.toolName).toBe('search');
    expect((puts[1].item as any).eventType).toBe(EVT_TOOL_SUCCEEDED);
    expect((puts[1].item as any).dimensions.durationMs).toBe(1234);
  });

  it('records tool failure with a semantic errorClass derived from the error', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    class TimeoutError extends Error {}
    await rec.toolFailed('sess-1', { toolName: 'publish_post', error: new TimeoutError('took too long') });

    const item = puts[0].item as any;
    expect(item.eventType).toBe(EVT_TOOL_FAILED);
    expect(item.dimensions.toolName).toBe('publish_post');
    // Semantic taxonomy: timed-out failures classify as 'timeout' regardless
    // of whether the tool threw a named TimeoutError or a plain Error.
    expect(item.dimensions.errorClass).toBe('timeout');
    expect(String(item.dimensions.errorMessage)).toContain('took too long');
  });

  it('records a plain-Error rate limit as rate_limit, not the flat Error class', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolFailed('sess-1', {
      toolName: 'bravesearch_brave_web_search',
      error: new Error('Request failed with status code 429'),
    });

    expect((puts[0].item as any).dimensions.errorClass).toBe('rate_limit');
  });

  it('keeps the legacy named class for unrecognized custom errors', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    const err = new Error('weird');
    err.name = 'CustomDomainError';
    await rec.toolFailed('sess-1', { toolName: 'custom_tool', error: err });

    expect((puts[0].item as any).dimensions.errorClass).toBe('CustomDomainError');
  });

  it('records run completed + run failed terminal events', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runCompleted('sess-1', { toolCalls: 3, failedToolCalls: 0 });
    await rec.runFailed('sess-2', { error: new Error('boom'), toolCalls: 1, failedToolCalls: 1 });

    expect((puts[0].item as any).eventType).toBe(EVT_RUN_COMPLETED);
    expect((puts[0].item as any).dimensions.toolCalls).toBe(3);
    // Every terminal event is followed by a durable agent_run_verdict event.
    expect((puts[1].item as any).eventType).toBe('agent_run_verdict');
    expect((puts[1].item as any).dimensions.verdict).toBe('ok');
    expect((puts[2].item as any).eventType).toBe(EVT_RUN_FAILED);
    expect((puts[2].item as any).subjectId).toBe('sess-2');
    expect((puts[3].item as any).eventType).toBe('agent_run_verdict');
    expect((puts[3].item as any).dimensions.verdict).toBe('failed');
  });

  it('never throws into the caller hot path when Dynamo fails', async () => {
    const port: DynamoPort = {
      putItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
      getItem: jest.fn(),
      query: jest.fn(),
    };
    const rec = new AgentRunRecorder(port, clock);
    // Should resolve, not reject.
    await expect(rec.toolFailed('sess-1', { toolName: 't', error: new Error('x') })).resolves.toBeUndefined();
  });
});

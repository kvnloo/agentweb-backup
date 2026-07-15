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
  EVT_TOOL_DEFERRED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_PARTIAL_FAILURE,
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

  it('records the OTel traceId on run start dimensions when provided (ENG-141 bridge)', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runStarted('sess-1:run:abc', {
      llmModel: 'claude-opus-4-8',
      sessionId: 'sess-1',
      traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });

    const item = puts[0].item as any;
    expect(item.dimensions.traceId).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('omits traceId from run start dimensions when not provided (tracing off)', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.runStarted('sess-1:run:abc', { llmModel: 'claude-opus-4-8', sessionId: 'sess-1' });

    const item = puts[0].item as any;
    expect(item.dimensions.traceId).toBeUndefined();
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
      argsRepairedCount: 1,
      schemaErrorCount: 2,
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
    expect(item.dimensions.argsRepairedCount).toBe(1);
    expect(item.dimensions.schemaErrorCount).toBe(2);
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
      toolName: 'legacy_search_web',
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

  it('records a deferred tool call as its own event class with reason + budget context (ENG-103)', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolDeferred('sess-1', {
      toolName: 'generate_image',
      reason: 'media_generation_time_budget',
      iteration: 4,
      sessionId: 'sess-1',
      mediaAssetsProducedThisRun: 3,
      deadlineMs: 1700000000000,
    });

    const item = puts[0].item as any;
    // Deferred is NOT toolInvoked/succeeded/failed — its own class.
    expect(item.eventType).toBe(EVT_TOOL_DEFERRED);
    expect(item.dimensions.toolName).toBe('generate_image');
    expect(item.dimensions.reason).toBe('media_generation_time_budget');
    expect(item.dimensions.iteration).toBe(4);
    expect(item.dimensions.mediaAssetsProducedThisRun).toBe(3);
    expect(item.dimensions.deadlineMs).toBe(1700000000000);
  });

  it('records a partial-failure tool call as its own event class with the unavailable sections (ENG-104)', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolPartialFailure('sess-1:run:abc', {
      toolName: 'get_meta_ads_metrics',
      unavailableSections: ['demographics', 'device'],
      iteration: 2,
      sessionId: 'sess-1',
    });

    const item = puts[0].item as any;
    // Partial failure is its OWN class — NOT toolFailed (the call succeeded) and
    // NOT toolDeferred (the call executed).
    expect(item.eventType).toBe(EVT_TOOL_PARTIAL_FAILURE);
    expect(item.subjectId).toBe('sess-1:run:abc');
    expect(item.dimensions.toolName).toBe('get_meta_ads_metrics');
    // Sections are stored comma-joined + a numeric count (cleanDims drops arrays).
    expect(item.dimensions.unavailableSections).toBe('demographics,device');
    expect(item.dimensions.unavailableCount).toBe(2);
    expect(item.dimensions.iteration).toBe(2);
    expect(item.dimensions.sessionId).toBe('sess-1');
  });

  it('partial-failure telemetry never throws into the caller hot path when Dynamo fails', async () => {
    const port: DynamoPort = {
      putItem: jest.fn().mockRejectedValue(new Error('dynamo down')),
      getItem: jest.fn(),
      query: jest.fn(),
    };
    const rec = new AgentRunRecorder(port, clock);
    await expect(
      rec.toolPartialFailure('sess-1', { toolName: 't', unavailableSections: ['x'] }),
    ).resolves.toBeUndefined();
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

describe('AgentRunRecorder failed-call args capture', () => {
  // Root-cause material for failure investigation (Rui/Argusoft ask, 2026-06-12):
  // the exact arguments of a FAILING call are recorded — capped + redacted.
  // Successful calls never store full args (size + privacy).

  it('records serialized args on tool failure', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolFailed('run-1', {
      toolName: 'linkedin_outreach',
      error: new Error('Invalid parameters'),
      args: { action: 'send-invite', profile_url: 'https://linkedin.com/in/x', message: 'hey' },
    });

    const item = puts[0].item as any;
    expect(item.eventType).toBe(EVT_TOOL_FAILED);
    const parsed = JSON.parse(item.dimensions.failedArgsJson);
    expect(parsed.action).toBe('send-invite');
    expect(parsed.message).toBe('hey');
  });

  it('redacts secret-like keys in captured args', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolFailed('run-1', {
      toolName: 'call_meta_marketing_api',
      error: new Error('boom'),
      args: { endpoint: '/campaigns', access_token: 'EAAB-secret', apiKey: 'k-123', password: 'hunter2' },
    });

    const parsed = JSON.parse((puts[0].item as any).dimensions.failedArgsJson);
    expect(parsed.endpoint).toBe('/campaigns');
    expect(parsed.access_token).toBe('[redacted]');
    expect(parsed.apiKey).toBe('[redacted]');
    expect(parsed.password).toBe('[redacted]');
  });

  it('caps oversized args payloads', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolFailed('run-1', {
      toolName: 'update_html_file',
      error: new Error('hash mismatch'),
      args: { operations_json: 'x'.repeat(20000) },
    });

    const stored = (puts[0].item as any).dimensions.failedArgsJson as string;
    expect(stored.length).toBeLessThanOrEqual(4096);
    expect(stored).toContain('…[truncated]');
  });

  it('omits the field when args are absent or unserializable', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolFailed('run-1', { toolName: 'search_web', error: new Error('x') });
    const circular: any = {}; circular.self = circular;
    await rec.toolFailed('run-1', { toolName: 'search_web', error: new Error('y'), args: circular });

    expect((puts[0].item as any).dimensions.failedArgsJson).toBeUndefined();
    expect((puts[1].item as any).dimensions.failedArgsJson).toBeUndefined();
  });

  it('never records args on success', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    await rec.toolSucceeded('run-1', { toolName: 'search_web', durationMs: 10 });

    expect((puts[0].item as any).dimensions.failedArgsJson).toBeUndefined();
  });
});

describe('AgentRunRecorder serialized write chain (ENG-102)', () => {
  // The recorder must serialize writes for one run so a terminal run record
  // (run_completed/run_failed) can never persist before the per-tool records
  // enqueued before it, and a drain (flush) before teardown guarantees nothing
  // is lost on worker exit. Persistence failures surface as a structured logger
  // signal + writeFailures counter, not console-only.

  it('serializes a terminal record AFTER per-tool records even when tool puts are slow', async () => {
    // Fake Dynamo that DELAYS only the per-tool events; resolves run_completed
    // immediately. Without the chain, the immediate run_completed put would land
    // before the delayed tool_failed put (the original fire-and-forget bug).
    const puts: Array<{ item: any }> = [];
    const port: DynamoPort = {
      putItem: jest.fn(async (_table: string, item: DynamoAttributeMap) => {
        const eventType = (item as any).eventType as string;
        if (eventType.startsWith('agent_tool_')) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        puts.push({ item });
      }),
      getItem: jest.fn(async () => null),
      query: jest.fn(async () => ({ items: [] })),
    };
    const rec = new AgentRunRecorder(port, clock);

    // Fire-and-forget call order: tool failure first, then the terminal record.
    void rec.toolFailed('run-1', { toolName: 'publish_post', error: new Error('boom'), durationMs: 5 });
    void rec.runCompleted('run-1', { toolCalls: 1, failedToolCalls: 1 });

    await rec.flush();

    const order = puts.map((p) => p.item.eventType);
    const failedIdx = order.indexOf(EVT_TOOL_FAILED);
    const completedIdx = order.indexOf(EVT_RUN_COMPLETED);
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    // The per-tool record is durably written BEFORE the terminal record.
    expect(failedIdx).toBeLessThan(completedIdx);
  });

  it('flush() drains all enqueued writes (nothing lost if the caller drains before exit)', async () => {
    const { port, puts } = fakeDynamo();
    const rec = new AgentRunRecorder(port, clock);

    // Many fire-and-forget emits without awaiting individual calls.
    void rec.runStarted('run-1', { sessionId: 'sess-1' });
    void rec.toolInvoked('run-1', { toolName: 'search', iteration: 1 });
    void rec.toolSucceeded('run-1', { toolName: 'search', durationMs: 3 });
    void rec.toolInvoked('run-1', { toolName: 'send_email', iteration: 1 });
    void rec.toolFailed('run-1', { toolName: 'send_email', error: new Error('x') });
    void rec.runCompleted('run-1', { toolCalls: 2, failedToolCalls: 1 });

    await rec.flush();

    // runStarted(1) + invoked(2) + succeeded(1) + failed(1) + completed(1) + verdict(1) = 7
    expect(puts).toHaveLength(7);
  });

  it('surfaces a write failure as a structured logger signal + writeFailures counter (not a throw)', async () => {
    const port: DynamoPort = {
      putItem: jest.fn().mockRejectedValue(new Error('Request failed with status code 429')),
      getItem: jest.fn(),
      query: jest.fn(),
    };
    const log = jest.fn();
    const rec = new AgentRunRecorder(port, clock, undefined, { log });

    // The calling method must NOT throw — it resolves even though the write failed.
    await expect(
      rec.toolFailed('run-1', { toolName: 't', error: new Error('inner') }),
    ).resolves.toBeUndefined();
    await rec.flush();

    expect(rec.writeFailures).toBe(1);
    expect(log).toHaveBeenCalledWith(
      'error',
      'agent_recorder_write_failed',
      expect.objectContaining({ eventType: EVT_TOOL_FAILED, runId: 'run-1', errorClass: 'rate_limit' }),
    );
  });
});

import { buildAgentRunSummaries, AgentRunEventRow } from '../services/agentRunInspectorService';
import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';

describe('agentRunInspectorService', () => {
  it('groups AgentRun events into an operator-readable timeline', () => {
    const rows: AgentRunEventRow[] = [
      {
        eventType: EVT_RUN_COMPLETED,
        subjectId: 'sess-1:run:a',
        ts: '2026-06-09T22:00:03.000Z',
        dimensions: { sessionId: 'sess-1', toolCalls: 1, failedToolCalls: 0 },
      },
      {
        eventType: EVT_RUN_STARTED,
        subjectId: 'sess-1:run:a',
        ts: '2026-06-09T22:00:00.000Z',
        dimensions: {
          sessionId: 'sess-1',
          userId: 'user-1',
          llmModel: 'anthropic.claude-opus-4-8',
          sessionType: 'regular',
        },
      },
      {
        eventType: EVT_DECISION,
        subjectId: 'sess-1:run:a',
        ts: '2026-06-09T22:00:01.000Z',
        dimensions: {
          sessionId: 'sess-1',
          iteration: 1,
          toolNames: 'save_memory',
          toolArgKeys: 'save_memory:category|content',
          toolArgsPreview: '[{"tool":"save_memory","args":{"content":"hello"}}]',
          decisionExplanation: 'Chose save_memory to persist user-provided information for future context.',
          explanationSource: 'deterministic_tool_summary',
          toolCount: 1,
        },
      },
      {
        eventType: EVT_TOOL_INVOKED,
        subjectId: 'sess-1:run:a',
        ts: '2026-06-09T22:00:01.100Z',
        dimensions: { sessionId: 'sess-1', iteration: 1, toolName: 'save_memory' },
      },
      {
        eventType: EVT_TOOL_SUCCEEDED,
        subjectId: 'sess-1:run:a',
        ts: '2026-06-09T22:00:01.300Z',
        dimensions: { sessionId: 'sess-1', toolName: 'save_memory', durationMs: 200 },
      },
    ];

    const [run] = buildAgentRunSummaries(rows);

    expect(run.runId).toBe('sess-1:run:a');
    expect(run.status).toBe('completed');
    expect(run.sessionId).toBe('sess-1');
    expect(run.userId).toBe('user-1');
    expect(run.llmModel).toBe('anthropic.claude-opus-4-8');
    expect(run.toolCalls).toBe(1);
    expect(run.failedToolCalls).toBe(0);
    expect(run.decisions).toEqual([
      {
        ts: '2026-06-09T22:00:01.000Z',
        iteration: 1,
        toolNames: ['save_memory'],
        toolArgKeys: 'save_memory:category|content',
        toolArgsPreview: '[{"tool":"save_memory","args":{"content":"hello"}}]',
        decisionExplanation: 'Chose save_memory to persist user-provided information for future context.',
        explanationSource: 'deterministic_tool_summary',
      },
    ]);
    expect(run.outcomes).toHaveLength(2);
    expect(run.events.map((event) => event.eventType)).toEqual([
      EVT_RUN_STARTED,
      EVT_DECISION,
      EVT_TOOL_INVOKED,
      EVT_TOOL_SUCCEEDED,
      EVT_RUN_COMPLETED,
    ]);
  });

  it('marks failed runs and preserves tool failure details', () => {
    const rows: AgentRunEventRow[] = [
      {
        eventType: EVT_RUN_STARTED,
        subjectId: 'sess-2:run:b',
        ts: '2026-06-09T22:01:00.000Z',
        dimensions: { sessionId: 'sess-2', userId: 'user-2' },
      },
      {
        eventType: EVT_TOOL_FAILED,
        subjectId: 'sess-2:run:b',
        ts: '2026-06-09T22:01:02.000Z',
        dimensions: {
          sessionId: 'sess-2',
          toolName: 'search_web',
          durationMs: 123,
          errorClass: 'TimeoutError',
          errorMessage: 'tool timed out',
        },
      },
      {
        eventType: EVT_RUN_FAILED,
        subjectId: 'sess-2:run:b',
        ts: '2026-06-09T22:01:03.000Z',
        dimensions: {
          sessionId: 'sess-2',
          toolCalls: 1,
          failedToolCalls: 1,
          errorClass: 'TimeoutError',
          errorMessage: 'run failed',
        },
      },
    ];

    const [run] = buildAgentRunSummaries(rows);

    expect(run.status).toBe('failed');
    expect(run.toolCalls).toBe(1);
    expect(run.failedToolCalls).toBe(1);
    expect(run.outcomes[0]).toMatchObject({
      eventType: EVT_TOOL_FAILED,
      toolName: 'search_web',
      durationMs: 123,
      errorClass: 'TimeoutError',
      errorMessage: 'tool timed out',
    });
  });
});

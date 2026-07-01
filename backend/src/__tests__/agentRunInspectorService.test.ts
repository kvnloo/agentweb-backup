import {
  buildAgentRunChatContext,
  buildAgentRunSummaries,
  AgentRunEventRow,
} from '../services/agentRunInspectorService';
import {
  EVT_DECISION,
  EVT_RUN_COMPLETED,
  EVT_RUN_FAILED,
  EVT_RUN_STARTED,
  EVT_TOOL_DEFERRED,
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
          toolPolicyFlags: 'save_memory:side_effecting_tool:info',
          toolPolicySummary: 'save_memory:session_state:low:observe',
          argsRepairedCount: 1,
          schemaErrorCount: 0,
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
    expect(run.durationMs).toBe(3000);
    expect(run.flags).toEqual([]);
    expect(run.decisions).toEqual([
      {
        ts: '2026-06-09T22:00:01.000Z',
        iteration: 1,
        toolNames: ['save_memory'],
        toolArgKeys: 'save_memory:category|content',
        toolArgsPreview: '[{"tool":"save_memory","args":{"content":"hello"}}]',
        decisionExplanation: 'Chose save_memory to persist user-provided information for future context.',
        explanationSource: 'deterministic_tool_summary',
        toolPolicyFlags: 'save_memory:side_effecting_tool:info',
        toolPolicySummary: 'save_memory:session_state:low:observe',
        argsRepairedCount: 1,
        schemaErrorCount: 0,
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
          failureType: 'bug',
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
    expect(run.flags.map((flag) => flag.code)).toEqual(['run_failed', 'failed_tool_calls']);
    expect(run.outcomes[0]).toMatchObject({
      eventType: EVT_TOOL_FAILED,
      toolName: 'search_web',
      durationMs: 123,
      errorClass: 'TimeoutError',
      errorMessage: 'tool timed out',
      failureType: 'bug',
    });
  });

  it('flags high-volume runs, repeated tools, and gateway policy warnings', () => {
    const rows: AgentRunEventRow[] = [
      {
        eventType: EVT_RUN_STARTED,
        subjectId: 'sess-3:run:c',
        ts: '2026-06-09T22:02:00.000Z',
        dimensions: { sessionId: 'sess-3', userId: 'user-3' },
      },
      {
        eventType: EVT_DECISION,
        subjectId: 'sess-3:run:c',
        ts: '2026-06-09T22:02:01.000Z',
        dimensions: {
          sessionId: 'sess-3',
          iteration: 1,
          toolNames: 'search_web,search_web,search_web,search_web,search_web,create_gtm_plan',
          toolPolicyFlags: 'create_gtm_plan:possible_task_tool_mismatch:warning',
          toolPolicySummary: 'create_gtm_plan:internal_write:medium:observe',
        },
      },
      ...Array.from({ length: 5 }, (_, idx) => ({
        eventType: EVT_TOOL_INVOKED,
        subjectId: 'sess-3:run:c',
        ts: `2026-06-09T22:02:0${idx + 2}.000Z`,
        dimensions: { sessionId: 'sess-3', iteration: 1, toolName: 'search_web' },
      })),
      {
        eventType: EVT_RUN_COMPLETED,
        subjectId: 'sess-3:run:c',
        ts: '2026-06-09T22:03:35.000Z',
        dimensions: { sessionId: 'sess-3', toolCalls: 13, failedToolCalls: 0 },
      },
    ];

    const [run] = buildAgentRunSummaries(rows);

    expect(run.durationMs).toBe(95_000);
    expect(run.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'high_tool_volume', severity: 'warning' }),
      expect.objectContaining({ code: 'long_run', severity: 'info' }),
      expect.objectContaining({ code: 'repeated_tool', severity: 'warning', evidence: 'search_web' }),
      expect.objectContaining({ code: 'possible_task_tool_mismatch', severity: 'warning', evidence: 'create_gtm_plan' }),
    ]));
  });

  it('flags tool retry budget failures for operator triage', () => {
    const rows: AgentRunEventRow[] = [
      {
        eventType: EVT_RUN_STARTED,
        subjectId: 'sess-budget:run:a',
        ts: '2026-06-17T02:00:00.000Z',
        dimensions: { sessionId: 'sess-budget', userId: 'user-budget' },
      },
      {
        eventType: EVT_TOOL_FAILED,
        subjectId: 'sess-budget:run:a',
        ts: '2026-06-17T02:00:01.000Z',
        dimensions: {
          sessionId: 'sess-budget',
          toolName: 'generate_image',
          errorClass: 'repeated_failure',
          errorMessage: 'Tool "generate_image" already failed 2 time(s) in this run, reaching its retry budget of 2.',
          failureType: 'bug',
        },
      },
      {
        eventType: EVT_RUN_COMPLETED,
        subjectId: 'sess-budget:run:a',
        ts: '2026-06-17T02:00:02.000Z',
        dimensions: { sessionId: 'sess-budget', toolCalls: 3, failedToolCalls: 1 },
      },
    ];

    const [run] = buildAgentRunSummaries(rows);

    expect(run.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'tool_retry_budget_exceeded',
        severity: 'warning',
        evidence: 'generate_image',
      }),
    ]));
  });

  it('builds chat context from the matching ChatSession and ChatMessages rows', () => {
    const chat = buildAgentRunChatContext({
      sessionId: 'sess-chat-1',
      customerPortalBaseUrl: 'https://app.agentweb.pro/',
      session: {
        sessionId: 'sess-chat-1',
        title: 'Tool-heavy reliability smoke test',
        portalType: 'agent',
        sessionType: 'regular',
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-10T10:02:00.000Z',
        messageCount: 4,
      },
      messages: [
        {
          messageIndex: 3,
          message: {
            role: 'assistant',
            content: 'I created the requested HTML file and checked the tool results.',
          },
        },
        {
          messageIndex: 1,
          message: {
            role: 'user',
            content: 'Read this pasted text and create an HTML report.',
          },
        },
        {
          messageIndex: 2,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Also make sure telemetry captures why tools were used.' }],
          },
        },
      ],
    });

    expect(chat).toEqual(expect.objectContaining({
      found: true,
      sessionId: 'sess-chat-1',
      title: 'Tool-heavy reliability smoke test',
      portalType: 'agent',
      sessionType: 'regular',
      messageCount: 4,
      firstUserMessage: 'Read this pasted text and create an HTML report.',
      lastUserMessage: 'Also make sure telemetry captures why tools were used.',
      lastAssistantMessage: 'I created the requested HTML file and checked the tool results.',
      customerPortalUrl: 'https://app.agentweb.pro/agent-mode/sess-chat-1',
    }));
  });

  it('accounts deferred tool calls separately from success and failure (ENG-103)', () => {
    const rows: AgentRunEventRow[] = [
      {
        eventType: EVT_RUN_STARTED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:00.000Z',
        dimensions: { sessionId: 'sess-1' },
      },
      {
        eventType: EVT_TOOL_INVOKED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:01.000Z',
        dimensions: { sessionId: 'sess-1', toolName: 'generate_image' },
      },
      {
        eventType: EVT_TOOL_SUCCEEDED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:01.500Z',
        dimensions: { sessionId: 'sess-1', toolName: 'generate_image', durationMs: 500 },
      },
      {
        eventType: EVT_TOOL_DEFERRED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:02.000Z',
        dimensions: { sessionId: 'sess-1', toolName: 'generate_image', reason: 'media_generation_time_budget' },
      },
      {
        eventType: EVT_TOOL_DEFERRED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:02.500Z',
        dimensions: { sessionId: 'sess-1', toolName: 'generate_image', reason: 'media_generation_time_budget' },
      },
      {
        eventType: EVT_RUN_COMPLETED,
        subjectId: 'sess-1:run:def',
        ts: '2026-06-09T22:00:03.000Z',
        // terminal toolCalls/failedToolCalls absent → counts fall back to event tallies
        dimensions: { sessionId: 'sess-1' },
      },
    ];

    const [run] = buildAgentRunSummaries(rows);

    // 1 invoked, 0 failed, 2 deferred — deferred is its own bucket.
    expect(run.toolCalls).toBe(1);
    expect(run.failedToolCalls).toBe(0);
    expect(run.deferredToolCalls).toBe(2);
    // Deferred does not produce a failed_tool_calls flag.
    expect(run.flags.some((f) => f.code === 'failed_tool_calls')).toBe(false);
  });

  it('returns a clear not-found chat context when only spine telemetry exists', () => {
    const chat = buildAgentRunChatContext({
      sessionId: 'missing-session',
      customerPortalBaseUrl: 'https://app.agentweb.pro',
      messages: [],
    });

    expect(chat).toEqual({
      found: false,
      sessionId: 'missing-session',
      messageCount: 0,
      customerPortalUrl: 'https://app.agentweb.pro/agent-mode/missing-session',
    });
  });
});

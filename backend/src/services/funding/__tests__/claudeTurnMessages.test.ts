import { mapLedgerToResponseMessages } from '../claudeTurnMessages';
import type { BridgeCallRecord } from '../toolBridge';
import { EMPTY_FINAL_RESPONSE_FALLBACK } from '../../agentMode/core/termination';

const NOW = () => '2026-10-26T00:00:00.000Z';

let seq = 0;
function rec(over: Partial<BridgeCallRecord> & Pick<BridgeCallRecord, 'toolCallId' | 'name'>): BridgeCallRecord {
  seq += 1;
  return {
    args: {},
    kind: 'executed',
    isError: false,
    toolMessageContent: `${over.name} ok`,
    arrivalSeq: seq,
    startedAt: 1000,
    endedAt: 1250,
    durationMs: 250,
    ...over,
  };
}

const LLM = 'openrouter/anthropic/claude-opus-5.5'; // the registry id, never the CLI alias
const base = { llm: LLM, now: NOW };

describe('mapLedgerToResponseMessages', () => {
  it('maps a turn with no tools to the single answer message', () => {
    const { responseMessages, toolCalls } = mapLedgerToResponseMessages({ ...base, ledger: [], finalText: 'Hello' });
    expect(toolCalls).toEqual([]);
    expect(responseMessages).toEqual([
      { role: 'assistant', content: 'Hello', llm: LLM, metadata: { timestamp: NOW(), funding: 'subscription' } },
    ]);
  });

  it("emits an assistant message with OpenAI-shape tool_calls immediately followed by one tool message per call", () => {
    const ledger = [
      rec({ toolCallId: 'a', name: 'get_leads', args: { limit: 5 }, groupId: 'g1', groupIndex: 0, groupOrder: 0, result: { n: 5 } }),
      rec({ toolCallId: 'b', name: 'get_tasks', groupId: 'g1', groupIndex: 1, groupOrder: 0 }),
      rec({ toolCallId: 'c', name: 'save_note', groupId: 'g2', groupIndex: 0, groupOrder: 1 }),
    ];
    const { responseMessages } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'Done' });
    expect(responseMessages.map((m) => m.role + (m.tool_call_id ? `:${m.tool_call_id}` : ''))).toEqual([
      'assistant', 'tool:a', 'tool:b', 'assistant', 'tool:c', 'assistant',
    ]);
    expect(responseMessages[0].tool_calls).toEqual([
      { id: 'a', type: 'function', function: { name: 'get_leads', arguments: '{"limit":5}' } },
      { id: 'b', type: 'function', function: { name: 'get_tasks', arguments: '{}' } },
    ]);
    expect(responseMessages[1]).toEqual({
      tool_call_id: 'a', role: 'tool', name: 'get_leads', content: 'get_leads ok', metadata: { timestamp: NOW() },
    });
  });

  it('treats a call the stream never announced as its own group, so every pair stays adjacent', () => {
    const ledger = [rec({ toolCallId: 'x', name: 'get_leads' }), rec({ toolCallId: 'y', name: 'get_tasks' })];
    const { responseMessages } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'ok' });
    expect(responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant']);
  });

  it('puts what the model was handed in the tool message, never the real text of a withheld result', () => {
    const ledger = [
      rec({
        toolCallId: 'h', name: 'meta_preview', groupId: 'g', groupOrder: 0, groupIndex: 0,
        toolMessageContent: 'PREVIEW approvalToken=SECRET-123',
        answeredContent: 'This confirmation belongs to an earlier turn.',
        result: { digest: 'd', approvalToken: 'SECRET-123' },
        staleHalt: true,
      }),
    ];
    const { responseMessages, toolCalls } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'x' });
    const all = JSON.stringify(responseMessages);
    expect(all).not.toContain('SECRET-123');
    expect(responseMessages[1].content).toBe('This confirmation belongs to an earlier turn.');
    expect(toolCalls[0].result).toBeUndefined();
  });

  it('marks a collapsed duplicate the way Emma does', () => {
    const ledger = [
      rec({ toolCallId: 'a', name: 'get_leads', groupId: 'g', groupIndex: 0, groupOrder: 0 }),
      rec({ toolCallId: 'b', name: 'get_leads', groupId: 'g', groupIndex: 1, groupOrder: 0, kind: 'collapsed', duplicateOfId: 'a', toolMessageContent: 'collapsed' }),
    ];
    const { responseMessages, toolCalls } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'x' });
    expect(responseMessages[2].metadata).toEqual({ timestamp: NOW(), duplicateSuppressed: true, duplicateOfId: 'a' });
    expect(toolCalls[1]).toMatchObject({ id: 'b', duplicateOf: 'a', duration: 0 });
    expect(toolCalls[1].error).toBeUndefined();
  });

  it('never stores a deferral marker in the ledger, so no backstop can continue a plan chat on AgentWeb', () => {
    const ledger = [
      rec({ toolCallId: 'a', name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } }),
      rec({ toolCallId: 'b', name: 'get_leads', result: { n: 1 } }),
    ];
    const { responseMessages, toolCalls } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'x' });
    expect(toolCalls[0].result).toBeUndefined();
    expect(toolCalls[1].result).toEqual({ n: 1 });
    expect(JSON.stringify(responseMessages)).not.toContain('media_generation_time_budget');
    const { hasUnresolvedMediaDeferral } = require('../../../utils/timeoutContinuation');
    expect(hasUnresolvedMediaDeferral(responseMessages)).toBe(false);
  });

  it('a refused or failed call is an error by its kind alone, even when the bridge did not flag it', () => {
    const ledger = [
      rec({ toolCallId: 'r', name: 'send_email', kind: 'refused', isError: false }),
      rec({ toolCallId: 'f', name: 'get_leads', kind: 'failed', isError: false }),
      rec({ toolCallId: 'e', name: 'get_leads', kind: 'executed', isError: false }),
    ];
    const { toolCalls } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'x' });
    expect(toolCalls.map((t) => t.error !== undefined)).toEqual([true, true, false]);
  });

  it('records refused and failed calls as errors without leaking detail', () => {
    const ledger = [
      rec({ toolCallId: 'r', name: 'send_email', kind: 'refused', isError: true, toolMessageContent: 'send_email is not available in this run.' }),
      rec({ toolCallId: 'f', name: 'get_leads', kind: 'failed', isError: true, error: 'executor failed' }),
    ];
    const { toolCalls } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'x' });
    expect(toolCalls[0].error).toBe('Tool call did not complete');
    expect(toolCalls[1].error).toBe('executor failed');
  });

  it('stamps the last message with usage (no cost), the funding label and the ledger', () => {
    const ledger = [rec({ toolCallId: 'a', name: 'get_leads', groupId: 'g', groupIndex: 0, groupOrder: 0, result: { n: 1 } })];
    const { responseMessages, toolCalls } = mapLedgerToResponseMessages({
      ...base,
      ledger,
      finalText: 'Answer',
      stamps: { modelRouting: 'x' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const last = responseMessages[responseMessages.length - 1];
    expect(last.content).toBe('Answer');
    expect(last.usage).toEqual({
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, estimated_cost: 0,
    });
    expect(last.modelRouting).toBe('x');
    expect(last.metadata.funding).toBe('subscription');
    expect(last.metadata.toolCalls).toEqual(toolCalls);
    expect(toolCalls[0]).toEqual({ id: 'a', name: 'get_leads', arguments: {}, duration: 250, result: { n: 1 } });
    // intermediate assistant messages carry no usage: the tokens are the turn's, counted once
    expect(responseMessages[0].usage).toBeUndefined();
  });
});

it('never persists a blank answer', () => {
  for (const blank of ['', '   \n']) {
    const { responseMessages } = mapLedgerToResponseMessages({ ...base, ledger: [], finalText: blank });
    expect(responseMessages[responseMessages.length - 1].content).toBe(EMPTY_FINAL_RESPONSE_FALLBACK);
  }
});

describe('persisted turn replayed through buildMarketingContext', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { agentModeService } = require('../../agentModeService');

  it('keeps every tool_calls message because its tool results follow immediately, and drops nothing', () => {
    const ledger = [
      rec({ toolCallId: 'a', name: 'get_leads', groupId: 'g1', groupIndex: 0, groupOrder: 0 }),
      rec({ toolCallId: 'b', name: 'get_tasks', groupId: 'g1', groupIndex: 1, groupOrder: 0 }),
      rec({ toolCallId: 'c', name: 'save_note' }),
    ];
    const { responseMessages } = mapLedgerToResponseMessages({ ...base, ledger, finalText: 'All done' });
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      ...responseMessages,
    ];
    const ctx = agentModeService.buildMarketingContext('second', history);
    const withCalls = ctx.filter((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(withCalls).toHaveLength(2);
    expect(ctx.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['a', 'b', 'c']);
    // each assistant tool_calls message is directly followed by tool messages answering exactly its ids
    ctx.forEach((m: any, i: number) => {
      if (m.role === 'assistant' && m.tool_calls) {
        const ids = m.tool_calls.map((t: any) => t.id);
        expect(ctx.slice(i + 1, i + 1 + ids.length).map((t: any) => t.tool_call_id)).toEqual(ids);
      }
    });
    expect(ctx[ctx.length - 1]).toMatchObject({ role: 'user', content: 'second' });
  });
});

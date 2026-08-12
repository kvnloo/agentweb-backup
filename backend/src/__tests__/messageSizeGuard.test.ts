import { shrinkMessageForPersistence, OMITTED_TOOL_RESULT } from '../utils/messageSizeGuard';

const size = (value: unknown) => JSON.stringify(value).length;

/** A tool-ledger entry whose `result` payload is `chars` long. */
const ledgerEntry = (i: number, chars: number) => ({
  id: `tooluse_${i}`,
  name: 'search_tool_response',
  duration: 500,
  arguments: { query: `q${i}` },
  result: { success: true, content: 'x'.repeat(chars) },
});

describe('shrinkMessageForPersistence (ENG-946)', () => {
  const MAX = 10_000;

  it('returns the message untouched when it already fits', () => {
    const message = { role: 'assistant', content: 'the report', metadata: { toolCalls: [ledgerEntry(0, 10)] } };
    expect(shrinkMessageForPersistence(message, MAX)).toBe(message);
  });

  it('sheds the tool-result payloads first, keeping the answer intact', () => {
    const content = 'THE DAILY REPORT';
    const message = {
      role: 'assistant',
      content,
      usage: { total_tokens: 42 },
      metadata: { timestamp: 't', toolCalls: [ledgerEntry(0, 8_000), ledgerEntry(1, 8_000)] },
    };

    const shrunk: any = shrinkMessageForPersistence(message, MAX);

    expect(size(shrunk)).toBeLessThanOrEqual(MAX);
    // The user-visible answer and token accounting survive.
    expect(shrunk.content).toBe(content);
    expect(shrunk.usage).toEqual({ total_tokens: 42 });
    // The ledger is kept, minus its bulky payloads.
    expect(shrunk.metadata.toolCalls).toHaveLength(2);
    expect(shrunk.metadata.toolCalls[0].name).toBe('search_tool_response');
    expect(shrunk.metadata.toolCalls[0].result).toBe(OMITTED_TOOL_RESULT);
    // The input is never mutated.
    expect(message.metadata.toolCalls[0].result).toEqual({ success: true, content: 'x'.repeat(8_000) });
  });

  // utils/scanMessagesForAssets builds the session asset cache from
  // toolCall.result.imageUrl / .videoUrl, and chatbotService can only repair
  // generate_image / generate_video — a shed `upload_image` result is gone for good.
  // Those results are ~100 bytes; the blobs that blow the budget are ~15KB. So shed
  // by size and the asset-bearing ones are never touched.
  it('sheds the big diagnostic blobs and keeps the small asset-bearing results', () => {
    const message = {
      role: 'assistant',
      content: 'Here are your images.',
      metadata: {
        timestamp: 't',
        toolCalls: [
          ledgerEntry(0, 9_000),
          { id: 'i1', name: 'upload_image', result: { success: true, imageUrl: 'https://s3/a.png' } },
          ledgerEntry(1, 9_000),
          { id: 'i2', name: 'generate_video', result: { success: true, videoUrl: 'https://s3/b.mp4' } },
        ],
      },
    };

    const shrunk: any = shrinkMessageForPersistence(message, MAX);
    const calls = shrunk.metadata.toolCalls;

    expect(size(shrunk)).toBeLessThanOrEqual(MAX);
    // The asset URLs the cache is built from survive verbatim...
    expect(calls[1].result).toEqual({ success: true, imageUrl: 'https://s3/a.png' });
    expect(calls[3].result).toEqual({ success: true, videoUrl: 'https://s3/b.mp4' });
    // ...and a paging blob is what paid for it. Only as many as needed are shed —
    // shedding stops the moment the item fits — so assert at least one, not both.
    const shedNames = calls.filter((c: any) => c.result === OMITTED_TOOL_RESULT).map((c: any) => c.name);
    expect(shedNames.length).toBeGreaterThanOrEqual(1);
    expect(shedNames.every((n: string) => n === 'search_tool_response')).toBe(true);
  });

  it('falls back to a names-only ledger when shedding results is not enough', () => {
    const message = {
      role: 'assistant',
      content: 'THE DAILY REPORT',
      metadata: {
        timestamp: 't',
        // 300 entries: even with no results, the full entries blow the budget.
        toolCalls: Array.from({ length: 300 }, (_, i) => ledgerEntry(i, 200)),
      },
    };

    // 12KB: too small for 300 full entries even with results shed, big enough
    // for 300 bare names — so the names-only rung is the one that fits.
    const shrunk: any = shrinkMessageForPersistence(message, 12_000);

    expect(size(shrunk)).toBeLessThanOrEqual(12_000);
    expect(shrunk.content).toBe('THE DAILY REPORT');
    expect(shrunk.metadata.toolCallsTruncated).toBe(true);
    expect(shrunk.metadata.toolCalls.every((c: any) => Object.keys(c).length === 1 && c.name)).toBe(true);
  });

  it('truncates the message text only as a last resort, and still fits', () => {
    const message = { role: 'assistant', content: 'y'.repeat(50_000), metadata: { timestamp: 't' } };

    const shrunk: any = shrinkMessageForPersistence(message, MAX);

    expect(size(shrunk)).toBeLessThanOrEqual(MAX);
    expect(shrunk.content.startsWith('yyy')).toBe(true);
    expect(shrunk.content).toContain('Truncated');
  });

  it('stringifies array content before truncating it', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'z'.repeat(50_000) }],
      metadata: { timestamp: 't' },
    };

    const shrunk: any = shrinkMessageForPersistence(message, MAX);

    expect(size(shrunk)).toBeLessThanOrEqual(MAX);
    expect(typeof shrunk.content).toBe('string');
  });

  it('fits even when the metadata alone exceeds the budget', () => {
    const message = {
      role: 'assistant',
      content: 'w'.repeat(20_000),
      metadata: { timestamp: 't', citations: Array.from({ length: 500 }, (_, i) => ({ url: `https://example.com/${'p'.repeat(60)}/${i}` })) },
    };

    const shrunk: any = shrinkMessageForPersistence(message, 4_000);

    expect(size(shrunk)).toBeLessThanOrEqual(4_000);
    expect(shrunk.role).toBe('assistant');
  });

  // The guard this replaced sliced content to MAX_MESSAGE_CONTENT_SIZE *characters*
  // and called it done. JSON escaping can double that: 350,000 quote characters
  // serialize to 700,000, so an escape-heavy tool payload stayed over DynamoDB's
  // 400KB limit even AFTER "truncation", and batchWrite threw anyway. Budget must be
  // measured on the serialized form, which is why fitContent converges instead of
  // trusting its first estimate.
  it('fits escape-heavy content, where a character-count slice would not', () => {
    const message = {
      role: 'tool',
      name: 'search_tool_response',
      tool_call_id: 'x',
      content: '"'.repeat(50_000),
    };
    // The naive slice-to-budget a caller might reach for still blows past it.
    expect(JSON.stringify({ ...message, content: message.content.slice(0, MAX) }).length)
      .toBeGreaterThan(MAX);

    const shrunk: any = shrinkMessageForPersistence(message, MAX);

    expect(size(shrunk)).toBeLessThanOrEqual(MAX);
    expect(shrunk.role).toBe('tool');
    expect(shrunk.content).toContain('Truncated');
  });

  it('is a no-op for non-object input', () => {
    expect(shrinkMessageForPersistence(null as any, MAX)).toBeNull();
    expect(shrinkMessageForPersistence('nope' as any, MAX)).toBe('nope');
  });

  it('reproduces the production item that was lost (626,580 chars, 40-call ledger)', () => {
    // Session 82e0ee50 — the final report was generated, then dropped because the
    // 40-call tool ledger on its metadata pushed the item past DynamoDB's limit.
    const report = '<h2>Daily User Activity Report</h2>'.repeat(300);
    const message = {
      role: 'assistant',
      llm: 'anthropic.claude-opus-5',
      content: report,
      usage: { total_tokens: 1000 },
      metadata: {
        timestamp: 't',
        iterationTimings: [{ iteration: 1, llmDurationMs: 100, toolNames: ['x'] }],
        toolCalls: Array.from({ length: 40 }, (_, i) => ledgerEntry(i, 15_000)),
      },
    };
    expect(size(message)).toBeGreaterThan(350_000);

    const shrunk: any = shrinkMessageForPersistence(message, 350_000);

    expect(size(shrunk)).toBeLessThanOrEqual(350_000);
    // The whole report survives — nothing the user asked for is lost.
    expect(shrunk.content).toBe(report);
  });
});

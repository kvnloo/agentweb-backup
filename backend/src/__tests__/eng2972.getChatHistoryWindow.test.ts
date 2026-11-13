// ENG-2972: get_chat_history was rejected at schema validation when the model
// omitted start_time/end_time. Schema and handler must agree that both are optional.
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import { resolveChatHistoryWindow } from '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'admin-1', authToken: 't' } as any;

function definition(): any {
  return (mcpToolRegistry.getAllToolDefinitions() as any[]).find((d: any) => d.name === 'get_chat_history');
}

describe('ENG-2972 get_chat_history window contract', () => {
  beforeEach(() => mockMcpFetch.mockReset());

  it('schema no longer requires start_time/end_time (the args the model really sends)', () => {
    const def = definition();
    expect(def).toBeDefined();
    expect(def.inputSchema.required ?? []).not.toContain('start_time');
    expect(def.inputSchema.required ?? []).not.toContain('end_time');
  });

  it('handler defaults a missing window to the trailing 24h', async () => {
    mockMcpFetch.mockResolvedValue({ sessions: [] } as any);
    const before = Date.now();
    const result = await mcpToolRegistry.execute('get_chat_history', {}, context);
    expect(JSON.parse((result as any).content[0].text).error).toBeUndefined();
    const path = (mockMcpFetch.mock.calls[0][0] as any).path as string;
    const q = new URLSearchParams(path.split('?')[1]);
    const start = Date.parse(q.get('startTime')!);
    const end = Date.parse(q.get('endTime')!);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end - start).toBe(24 * 60 * 60 * 1000);
  });

  it('passes caller-supplied values through verbatim', () => {
    expect(resolveChatHistoryWindow({ start_time: '2026-03-28T00:00:00Z', end_time: '2026-03-29T00:00:00Z' }))
      .toEqual({ start_time: '2026-03-28T00:00:00Z', end_time: '2026-03-29T00:00:00Z' });
  });

  it('fills only start_time from a supplied end_time', () => {
    expect(resolveChatHistoryWindow({ end_time: '2026-03-29T00:00:00.000Z' }))
      .toEqual({ start_time: '2026-03-28T00:00:00.000Z', end_time: '2026-03-29T00:00:00.000Z' });
  });

  it('rejects invalid or inverted windows with an actionable error', () => {
    expect(resolveChatHistoryWindow({ start_time: 'yesterday' })).toHaveProperty('error');
    expect(resolveChatHistoryWindow({ start_time: '2026-03-29T00:00:00Z', end_time: '2026-03-28T00:00:00Z' }))
      .toHaveProperty('error');
  });
});

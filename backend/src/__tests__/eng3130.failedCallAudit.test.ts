/**
 * ENG-3130: a call that fails in-band leaves an audit row (`mcp_tool_failed`) that is neither
 * usage nor billable. Pure service test with an in-memory store; no Stripe, no Dynamo.
 */
import {
  EVT_MCP_TOOL_FAILED,
  EVT_MCP_TOOL_USED,
  getMcpUserUsage,
  recordMcpToolFailed,
  recordMcpToolUse,
  type McpUsageEventStore,
} from '../services/mcpUsageEventsService';

type Item = Record<string, any>;

function fakeStore(): McpUsageEventStore & { items: Item[] } {
  const items: Item[] = [];
  return {
    items,
    put: jest.fn(async (item: Item) => {
      items.push(item);
    }) as any,
    queryByLoopId: jest.fn(async (loopId: string) => items.filter((i) => i.loopId === loopId)) as any,
  };
}

const NOW = new Date('2026-11-17T10:00:00Z');
const RANGE = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' };

describe('ENG-3130 failed-call audit row', () => {
  it('writes one mcp_tool_failed row with tool, platform and client, and no arguments', async () => {
    const store = fakeStore();
    await expect(
      recordMcpToolFailed({ product: 'zoma', userId: 'u1', toolName: 'call_meta_marketing_api', platform: 'meta', authMethod: 'oauth', now: NOW }, store),
    ).resolves.toBe(true);
    expect(store.items).toHaveLength(1);
    const row = store.items[0];
    expect(row.eventType).toBe(EVT_MCP_TOOL_FAILED);
    expect(row.subjectId).toBe('u1');
    expect(JSON.stringify(row)).toContain('call_meta_marketing_api');
    expect(JSON.stringify(row)).toContain('"outcome"');
    expect(JSON.stringify(row)).toContain('failed');
  });

  it('writes nothing without a user id', async () => {
    const store = fakeStore();
    await expect(recordMcpToolFailed({ product: 'zoma', toolName: 't' } as any, store)).resolves.toBe(false);
    expect(store.items).toHaveLength(0);
  });

  it('a failed call is never counted as a tool call (so never billed or shown as used)', async () => {
    const store = fakeStore();
    await recordMcpToolUse({ product: 'zoma', userId: 'u1', toolName: 'list_meta_ads_campaigns', platform: 'meta', now: NOW }, store);
    await recordMcpToolUse({ product: 'zoma', userId: 'u1', toolName: 'meta_account_health', platform: 'meta', now: NOW }, store);
    await recordMcpToolFailed({ product: 'zoma', userId: 'u1', toolName: 'call_meta_marketing_api', platform: 'meta', now: NOW }, store);
    await recordMcpToolFailed({ product: 'zoma', userId: 'u1', toolName: 'call_meta_marketing_api', platform: 'meta', now: NOW }, store);
    expect(store.items.map((i) => i.eventType).sort()).toEqual([EVT_MCP_TOOL_FAILED, EVT_MCP_TOOL_FAILED, EVT_MCP_TOOL_USED, EVT_MCP_TOOL_USED]);
    const usage = await getMcpUserUsage('u1', RANGE, store);
    expect(usage.toolCalls).toBe(2);
  });
});

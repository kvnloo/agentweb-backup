/**
 * ENG-2303 P4 acceptance: writes are metered as a distinct event kind in
 * mcpUsageEventsService; zoma_usage reads it back per user for the current month. Record
 * only — no Stripe call. A write that never reached Meta (preview, mismatch, refusal) is
 * not a write event.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUsersByIds: jest.fn() } }));

import type { DynamoAttributeMap } from '../loops/core/ports';
import {
  EVT_MCP_WRITE_EXECUTED,
  getMcpUserUsage,
  recordMcpToolUse,
  recordMcpWriteExecuted,
} from '../services/mcpUsageEventsService';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { currentUsageMonth, runZomaTool } from '../mcp/zomaOnboarding';

function fakeStore() {
  const items: DynamoAttributeMap[] = [];
  return {
    items,
    put: jest.fn(async (item: DynamoAttributeMap) => { items.push(item); }),
    queryByLoopId: jest.fn(async (loopId: string) => items.filter((i) => i.loopId === loopId)),
  };
}

describe('ENG-2303 write metering', () => {
  it('records a write as its own event kind with entity, action, verdict and object id', async () => {
    const store = fakeStore();
    await recordMcpWriteExecuted({
      userId: 'u1', toolName: 'call_meta_marketing_api', authMethod: 'oauth', clientId: 'c1',
      entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: '999',
      now: new Date('2026-10-12T10:00:00Z'),
    }, store);
    expect(store.items[0]).toMatchObject({
      loopId: 'emma-mcp', eventType: EVT_MCP_WRITE_EXECUTED, subjectId: 'u1', ts: '2026-10-12T10:00:00.000Z',
      dimensions: expect.objectContaining({ entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: '999' }),
    });
    expect(String(store.items[0].tsSession)).toMatch(/^2026-10-12T10:00:00\.000Z#u1#mcp_write_executed#/);
  });

  it('per-user monthly usage counts tool calls and writes by verdict, excluding other users and months', async () => {
    const store = fakeStore();
    const w = (userId: string, verification: string, at: string) =>
      recordMcpWriteExecuted({ userId, toolName: 't', entityType: 'CAMPAIGN', action: 'UPDATE', verification, now: new Date(at) }, store);
    await w('u1', 'CONFIRMED', '2026-10-02T00:00:00Z');
    await w('u1', 'UNCONFIRMED', '2026-10-03T00:00:00Z');
    await w('u1', 'MISMATCH', '2026-10-04T00:00:00Z');
    await w('u1', 'CONFIRMED', '2026-09-30T23:59:59Z'); // previous month
    await w('u2', 'CONFIRMED', '2026-10-05T00:00:00Z'); // other user
    await recordMcpToolUse({ userId: 'u1', toolName: 'zoma_status', now: new Date('2026-10-06T00:00:00Z') }, store);

    const usage = await getMcpUserUsage('u1', currentUsageMonth(Date.parse('2026-10-12T00:00:00Z')), store);
    expect(usage.start).toBe('2026-10-01T00:00:00.000Z');
    expect(usage.end).toBe('2026-11-01T00:00:00.000Z');
    expect(usage.toolCalls).toBe(1);
    expect(usage.writes).toEqual({ total: 3, confirmed: 1, mismatch: 1, unconfirmed: 1 });
    expect(usage.recentWrites.map((r) => r.verification)).toEqual(['CONFIRMED', 'UNCONFIRMED', 'MISMATCH']);
  });

  it('zoma_usage returns the summary text for the current month', async () => {
    const getUsage = jest.fn().mockResolvedValue({
      start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z', toolCalls: 7,
      writes: { total: 2, confirmed: 2, mismatch: 0, unconfirmed: 0 },
      recentWrites: [{ ts: '2026-10-12T10:00:00.000Z', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: '999' }],
    });
    const res: any = await runZomaTool('zoma_usage', {}, { userId: 'u1' }, { getUsage, now: () => Date.parse('2026-10-12T12:00:00Z') } as any);
    expect(getUsage).toHaveBeenCalledWith('u1', { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' });
    expect(res.summary).toContain('Writes sent to Meta: 2 (confirmed 2');
    expect(res.summary).toContain('CREATE CAMPAIGN 999 → CONFIRMED');
    expect(res.summary).toContain('Billing is not enabled yet');
  });
});

describe('ENG-2303 gateway meters dispatched writes only', () => {
  const metaAccount = { platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 't' } } as any;
  const deps = (writeResult: any, over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps => ({
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
    validateOAuthToken: jest.fn(),
    listAccounts: jest.fn().mockResolvedValue([metaAccount]),
    execute: jest.fn() as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    now: () => Date.now(),
    executeWrite: jest.fn().mockResolvedValue(writeResult),
    recordWrite: jest.fn().mockResolvedValue(true) as any,
    ...over,
  });
  const call = (d: MetaToolkitGatewayDeps) => handleMetaToolkitCall({
    authorization: 'Bearer aw_k', toolName: 'call_meta_marketing_api',
    args: { entity_type: 'CAMPAIGN', action: 'CREATE', params: { name: 'x' } },
  }, d);

  it('a dispatched write emits one write event and one tool-use event', async () => {
    const d = deps({ success: true, verification: 'CONFIRMED', id: '999' });
    await call(d);
    expect(d.recordWrite).toHaveBeenCalledTimes(1);
    expect(d.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: '999', authMethod: 'api_key' }));
    expect(d.recordUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'PREVIEW', success: false, preview_token: 'v1.x' }],
    [{ status: 'PREVIEW_MISMATCH', success: false }],
    [{ status: 'FAILED', success: false }],
  ])('%p is not a write event', async (result) => {
    const d = deps(result);
    await call(d);
    expect(d.recordWrite).not.toHaveBeenCalled();
  });

  it('a metering failure does not turn an executed write into an error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps({ success: true, verification: 'CONFIRMED', id: '999' }, { recordWrite: jest.fn().mockRejectedValue(new Error('ddb down')) as any });
    const res: any = await call(d);
    expect(res.success).toBe(true);
    expect(res.metering).toMatch(/not recorded/);
  });
});

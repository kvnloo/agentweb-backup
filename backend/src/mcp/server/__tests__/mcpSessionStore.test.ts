/**
 * Tests for the durable MCP session store (ENG-114).
 *
 * Behavioral contract exercised:
 *  - set → get round-trips the minimal session metadata.
 *  - get returns null for absent OR expired sessions (consistent eviction, AC #3).
 *  - touch refreshes liveness; no-op on an absent session.
 *  - delete removes the record (idempotent).
 *  - Dynamo store follows the AW-OAuthSessions pattern (put/get/update/delete),
 *    omits undefined agentUserId, throttles touch writes, and swallows a
 *    conditional-check failure on a vanished row.
 *  - Factory selects the implementation from MCP_SESSION_STORE.
 */

// ─── Mock aws-sdk before importing the store (mirrors oauthService.test) ──────
const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockGet = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockUpdate = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockDelete = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: mockPut,
        get: mockGet,
        update: mockUpdate,
        delete: mockDelete,
      })),
    },
  },
}));

import {
  InMemoryMcpSessionStore,
  DynamoMcpSessionStore,
  createMcpSessionStore,
} from '../mcpSessionStore';

const HOUR_MS = 3_600_000;

describe('InMemoryMcpSessionStore', () => {
  it('round-trips session metadata on set → get', async () => {
    const store = new InMemoryMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', agentUserId: 'user-A', isInternal: false });

    const record = await store.get('s1');
    expect(record).not.toBeNull();
    expect(record!.sessionId).toBe('s1');
    expect(record!.agentUserId).toBe('user-A');
    expect(record!.isInternal).toBe(false);
    expect(typeof record!.createdAt).toBe('string');
    expect(record!.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns null for an unknown session', async () => {
    const store = new InMemoryMcpSessionStore(HOUR_MS);
    expect(await store.get('nope')).toBeNull();
  });

  it('evicts and returns null for an expired session (consistent eviction)', async () => {
    // Negative ttl → the record is already expired the instant it is written.
    const store = new InMemoryMcpSessionStore(-1000);
    await store.set({ sessionId: 's1', isInternal: false });
    expect(await store.get('s1')).toBeNull();
  });

  it('touch refreshes ttl for a live session and is a no-op when absent', async () => {
    const store = new InMemoryMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', agentUserId: 'u', isInternal: false });
    const before = (await store.get('s1'))!.ttl;

    // Advance wall clock so a refresh is observable.
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 5000);
    await store.touch('s1');
    (Date.now as jest.Mock).mockRestore();

    const after = (await store.get('s1'))!.ttl;
    expect(after).toBeGreaterThanOrEqual(before);

    // Touching a session that does not exist must not throw or create one.
    await expect(store.touch('ghost')).resolves.toBeUndefined();
    expect(await store.get('ghost')).toBeNull();
  });

  it('delete removes the record', async () => {
    const store = new InMemoryMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', isInternal: true });
    await store.delete('s1');
    expect(await store.get('s1')).toBeNull();
  });

  it('keeps sessions isolated by id (A on instance A does not collide with B)', async () => {
    const store = new InMemoryMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 'A', agentUserId: 'userA', isInternal: false });
    await store.set({ sessionId: 'B', agentUserId: 'userB', isInternal: false });
    expect((await store.get('A'))!.agentUserId).toBe('userA');
    expect((await store.get('B'))!.agentUserId).toBe('userB');
  });
});

describe('DynamoMcpSessionStore', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does NOT pass empty credentials when access-key env vars are unset (uses IAM provider chain)', () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const DocumentClient = require('aws-sdk').default.DynamoDB.DocumentClient as jest.Mock;
    DocumentClient.mockClear();

    new DynamoMcpSessionStore(HOUR_MS);

    // Empty static creds would disable the default provider chain (IAM instance
    // role) — the config must omit `credentials` entirely when env keys are unset.
    const cfg = DocumentClient.mock.calls[0][0];
    expect('credentials' in cfg).toBe(false);

    if (saved.id !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.id;
    if (saved.secret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
  });

  it('passes static credentials when both access-key env vars are present', () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_test';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret_test';
    const DocumentClient = require('aws-sdk').default.DynamoDB.DocumentClient as jest.Mock;
    DocumentClient.mockClear();

    new DynamoMcpSessionStore(HOUR_MS);

    const cfg = DocumentClient.mock.calls[0][0];
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIA_test', secretAccessKey: 'secret_test' });

    if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = saved.id;
    if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
  });

  it('set writes a record and omits an undefined agentUserId (DynamoDB rejects undefined)', async () => {
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', isInternal: true }); // no agentUserId

    expect(mockPut).toHaveBeenCalledTimes(1);
    const item = mockPut.mock.calls[0][0].Item;
    expect(item.sessionId).toBe('s1');
    expect(item.isInternal).toBe(true);
    expect('agentUserId' in item).toBe(false);
    expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('set includes agentUserId when present', async () => {
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', agentUserId: 'user-A', isInternal: false });
    expect(mockPut.mock.calls[0][0].Item.agentUserId).toBe('user-A');
  });

  it('get returns the record when present and unexpired', async () => {
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({
        Item: {
          sessionId: 's1',
          agentUserId: 'user-A',
          isInternal: false,
          createdAt: new Date().toISOString(),
          lastActivity: Date.now(),
          ttl: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    });
    const store = new DynamoMcpSessionStore(HOUR_MS);
    const record = await store.get('s1');
    expect(record!.agentUserId).toBe('user-A');
  });

  it('get returns null for a missing item', async () => {
    mockGet.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });
    const store = new DynamoMcpSessionStore(HOUR_MS);
    expect(await store.get('missing')).toBeNull();
  });

  it('get returns null for an expired item (ttl in the past) — consistent eviction', async () => {
    mockGet.mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({
        Item: {
          sessionId: 's1',
          isInternal: false,
          createdAt: new Date().toISOString(),
          lastActivity: Date.now(),
          ttl: Math.floor(Date.now() / 1000) - 10,
        },
      }),
    });
    const store = new DynamoMcpSessionStore(HOUR_MS);
    expect(await store.get('s1')).toBeNull();
  });

  it('throttles touch writes to at most one per interval per session', async () => {
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', isInternal: true }); // records a touch baseline
    mockUpdate.mockClear();

    await store.touch('s1'); // within throttle window of the set → suppressed
    await store.touch('s1');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('touch persists after the throttle interval elapses', async () => {
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await store.set({ sessionId: 's1', isInternal: true });
    mockUpdate.mockClear();

    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 120_000); // +2 min
    await store.touch('s1');
    (Date.now as jest.Mock).mockRestore();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const args = mockUpdate.mock.calls[0][0];
    expect(args.ConditionExpression).toContain('attribute_exists');
  });

  it('touch swallows a ConditionalCheckFailedException (row already gone)', async () => {
    mockUpdate.mockReturnValueOnce({
      promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }),
    });
    const store = new DynamoMcpSessionStore(HOUR_MS);
    // No prior set → not throttled → attempts the update, which "fails" softly.
    await expect(store.touch('s1')).resolves.toBeUndefined();
  });

  it('touch rethrows unexpected errors (fail loud, not silent)', async () => {
    mockUpdate.mockReturnValueOnce({
      promise: jest.fn().mockRejectedValue({ code: 'ProvisionedThroughputExceededException' }),
    });
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await expect(store.touch('s1')).rejects.toBeDefined();
  });

  it('delete removes the row', async () => {
    const store = new DynamoMcpSessionStore(HOUR_MS);
    await store.delete('s1');
    expect(mockDelete).toHaveBeenCalledWith({
      TableName: expect.stringContaining('AW-MCPSessions'),
      Key: { sessionId: 's1' },
    });
  });
});

describe('createMcpSessionStore factory', () => {
  const original = process.env.MCP_SESSION_STORE;
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_SESSION_STORE;
    else process.env.MCP_SESSION_STORE = original;
  });

  it('defaults to the in-memory store', () => {
    delete process.env.MCP_SESSION_STORE;
    expect(createMcpSessionStore(HOUR_MS)).toBeInstanceOf(InMemoryMcpSessionStore);
  });

  it('selects the Dynamo store when MCP_SESSION_STORE=dynamo', () => {
    process.env.MCP_SESSION_STORE = 'dynamo';
    expect(createMcpSessionStore(HOUR_MS)).toBeInstanceOf(DynamoMcpSessionStore);
  });

  it('treats any other value as in-memory', () => {
    process.env.MCP_SESSION_STORE = 'redis';
    expect(createMcpSessionStore(HOUR_MS)).toBeInstanceOf(InMemoryMcpSessionStore);
  });
});

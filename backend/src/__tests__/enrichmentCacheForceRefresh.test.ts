/**
 * Tests for `force` flag on putEnrichmentCacheItem and forceRefresh propagation.
 *
 * Pre-fix bug: `putEnrichmentCacheItem` always sent a `ConditionExpression`
 * that no-op'd if a non-expired row existed. So `forceRefresh: true` callers
 * would burn API credits + LRU updates but the DDB row would stay stale.
 *
 * Fix: optional `force?: boolean` param drops the ConditionExpression so the
 * put is unconditional. apolloService and enrichSoService must propagate
 * `forceRefresh: true` as `force: true` to the DB layer.
 */

import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    put: jest.fn(),
    get: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

import { crmDb } from '../services/db';

describe('crmDb.putEnrichmentCacheItem — force flag', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  const baseItem = {
    canonicalId: 'force-test-1',
    fieldGroup: 'apollo:linkedin:https://www.linkedin.com/in/x#match#v1',
    canonicalKey: 'apollo:linkedin:https://www.linkedin.com/in/x',
    entityKey: 'apollo:linkedin:https://www.linkedin.com/in/x',
    entityType: 'apollo',
    cacheType: 'apollo' as const,
    rawData: { person: { id: 'p1' } },
    queryUsed: '',
    sourcesUsed: ['apollo'],
    resultCount: 1,
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  };

  it('default put (force=false): includes ConditionExpression for race protection', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem(baseItem as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.ConditionExpression).toMatch(/attribute_not_exists\(canonicalId\)/);
    expect(args.ConditionExpression).toMatch(/expiresAt < :now/);
  });

  it('default put with no existing row: succeeds (DDB applies condition)', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await expect(crmDb.putEnrichmentCacheItem(baseItem as any)).resolves.toBeUndefined();
    expect(mockDynamoDB.put).toHaveBeenCalledTimes(1);
  });

  it('default put with existing non-expired row: silently no-ops via ConditionalCheckFailedException', async () => {
    const err: any = new Error('conflict');
    err.code = 'ConditionalCheckFailedException';
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(err) });
    await expect(crmDb.putEnrichmentCacheItem(baseItem as any)).resolves.toBeUndefined();
  });

  it('force=true: drops ConditionExpression entirely (unconditional put)', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem(baseItem as any, { force: true });
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.ConditionExpression).toBeUndefined();
    // Without a ConditionExpression we also shouldn't carry a `:now` placeholder.
    expect(args.ExpressionAttributeValues).toBeUndefined();
  });

  it('force=true with existing row: overwrites successfully (no Condition fail)', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await expect(
      crmDb.putEnrichmentCacheItem(baseItem as any, { force: true }),
    ).resolves.toBeUndefined();
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.Item.canonicalId).toBe('force-test-1');
    expect(args.ConditionExpression).toBeUndefined();
  });

  it('force=true with no existing row: also succeeds', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await expect(
      crmDb.putEnrichmentCacheItem(baseItem as any, { force: true }),
    ).resolves.toBeUndefined();
    expect(mockDynamoDB.put).toHaveBeenCalledTimes(1);
  });

  it('force=false (explicit): preserves race-protection condition', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem(baseItem as any, { force: false });
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.ConditionExpression).toMatch(/attribute_not_exists\(canonicalId\)/);
  });
});

// ─── Service-level propagation tests ────────────────────────────────────────

describe('ApolloService — forceRefresh propagates force=true to DB layer', () => {
  // We test through the cache-store `put` shim which is the boundary the
  // service uses to write through. The factory wraps this with a flag.

  const {
    ApolloService,
    __resetApolloServiceForTesting,
  } = require('../services/apolloService');

  function makeStore() {
    const rows = new Map<string, any>();
    const calls: Array<{ row: any; opts?: { force?: boolean } }> = [];
    return {
      rows,
      calls,
      async get(canonicalId: string, sk: string) {
        return rows.get(`${canonicalId}#${sk}`) ?? null;
      },
      async put(row: any, opts?: { force?: boolean }) {
        calls.push({ row, opts });
        rows.set(`${row.canonicalId}#${row.fieldGroup}`, row);
      },
    };
  }

  function makeHttp(overrides: any = {}) {
    return {
      match: jest.fn().mockResolvedValue({ person: null }),
      findEmail: jest.fn().mockResolvedValue({ person: null }),
      enrichOrg: jest.fn().mockResolvedValue({ organization: null }),
      ...overrides,
    };
  }

  beforeEach(() => {
    __resetApolloServiceForTesting();
  });

  it('apolloService passes force=true to store.put when forceRefresh=true', async () => {
    const http = makeHttp({
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'A', email: 'a@b.com' },
      }),
    });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await svc.matchPerson({ email: 'a@b.com' }, { forceRefresh: true });

    // At least one put with force=true (the primary row, plus possibly fanout)
    const forced = store.calls.find((c) => c.opts?.force === true);
    expect(forced).toBeDefined();
  });

  it('apolloService default (no forceRefresh) passes force=false / undefined', async () => {
    const http = makeHttp({
      match: jest.fn().mockResolvedValue({
        person: { id: 'p1', first_name: 'A' },
      }),
    });
    const store = makeStore();
    const svc = new ApolloService({ http, store });

    await svc.matchPerson({ email: 'a@b.com' });

    const primary = store.calls[0];
    expect(!!primary.opts?.force).toBe(false);
  });
});

describe('EnrichSoService — forceRefresh propagates force=true to DB layer', () => {
  const {
    EnrichSoService,
    __resetEnrichSoServiceForTesting,
  } = require('../services/enrichSoService');

  function makeHttp(overrides: any = {}) {
    return {
      validateEmail: jest.fn(),
      findEmail: jest.fn(),
      reverseLookup: jest.fn(),
      ...overrides,
    };
  }

  function makeStore() {
    const items = new Map<string, any>();
    const calls: Array<{ row: any; opts?: { force?: boolean } }> = [];
    return {
      _items: items,
      calls,
      async get(canonicalId: string, sk: string) {
        const item = items.get(`${canonicalId}#${sk}`);
        if (!item) return null;
        if (item.expiresAt <= Math.floor(Date.now() / 1000)) return null;
        return item;
      },
      async put(item: any, opts?: { force?: boolean }) {
        calls.push({ row: item, opts });
        items.set(`${item.canonicalId}#${item.fieldGroup}`, item);
      },
    };
  }

  beforeEach(() => {
    __resetEnrichSoServiceForTesting();
  });

  it('enrichSoService passes force=true when forceRefresh=true', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      }),
    });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await svc.validateEmail('a@b.com', { forceRefresh: true });

    const forced = store.calls.find((c) => c.opts?.force === true);
    expect(forced).toBeDefined();
  });

  it('enrichSoService default (no forceRefresh) passes force=false / undefined', async () => {
    const http = makeHttp({
      validateEmail: jest.fn().mockResolvedValue({
        success: true,
        data: { result: 'valid', confidence: 'high', isCatchAll: false },
      }),
    });
    const store = makeStore();
    const svc = new EnrichSoService({ http, store });

    await svc.validateEmail('a@b.com');

    const primary = store.calls[0];
    expect(!!primary.opts?.force).toBe(false);
  });
});

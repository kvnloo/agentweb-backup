/**
 * DynamoDB-path tests for the v0 usage guard (ENG-287 review follow-up).
 *
 * The in-memory tests in v0UsageGuard.test.ts run with persistence disabled, so the
 * conditional-write semantics — the ONLY cross-instance dedupe in prod — had zero
 * coverage. These tests enable persistence (V0_USAGE_DYNAMO_TEST) against a mocked
 * DocumentClient and pin the reserve condition's exact semantics.
 */
const mockPut = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();

jest.mock('aws-sdk', () => {
  const client = () => ({ put: mockPut, get: mockGet, delete: mockDelete });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import {
  _resetV0UsageGuardForTest,
  guardedV0ChatCreate,
  clearV0UsageForPage,
} from '../services/v0UsageGuard';

const ok = (v: any = {}) => ({ promise: () => Promise.resolve(v) });
const conditionalFailure = () => ({
  promise: () => Promise.reject(Object.assign(new Error('conditional failed'), {
    code: 'ConditionalCheckFailedException',
  })),
});

const createArgs = (create: jest.Mock) => ({
  userId: 'user_1',
  operation: 'additional_page_chat_create' as const,
  scopeId: 'site_1',
  slug: 'book-a-demo',
  prompt: 'p',
  create,
});

beforeAll(() => {
  process.env.V0_USAGE_DYNAMO_TEST = 'true';
});

afterAll(() => {
  delete process.env.V0_USAGE_DYNAMO_TEST;
});

beforeEach(() => {
  _resetV0UsageGuardForTest();
  mockPut.mockReset().mockReturnValue(ok());
  mockGet.mockReset().mockReturnValue(ok({ Item: undefined }));
  mockDelete.mockReset().mockReturnValue(ok());
});

describe('v0UsageGuard — DynamoDB conditional reserve (cross-instance semantics)', () => {
  test('the reserve condition reclaims failed, STALE-reserved, and STALE-succeeded records — a FRESH succeeded is never clobbered', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_1' });
    await guardedV0ChatCreate(createArgs(create));

    const reservePut = mockPut.mock.calls.find((c: any) => c[0].ConditionExpression);
    expect(reservePut).toBeDefined();
    // Each clause is scoped to a status on purpose:
    //  - a bare `updatedAt < :stale` would overwrite a FRESH succeeded record, double-
    //    spending the generation and losing the chat-reuse identity (that is what keeps
    //    two concurrent builds of the same route deduped to one chat);
    //  - but a succeeded record must NOT be immortal either, so it is reclaimable once its
    //    chat ages past the reuse ceiling, keyed on `createdAt` (when the chat was minted).
    //    Without that clause a dead chat wedges the route forever. (ENG-287 residual)
    expect(reservePut![0].ConditionExpression).toBe(
      'attribute_not_exists(idempotencyKey) OR #status = :failed' +
      ' OR (#status = :reserved AND #updatedAt < :stale)' +
      ' OR (#status = :succeeded AND #createdAt < :chatStale)' +
      // In DynamoDB a `<` against a MISSING attribute is false, so without this clause a
      // succeeded row with no readable createdAt — which canReuseChat also refuses to reuse —
      // would match nothing, fail the condition on every attempt, and wedge the route forever.
      ' OR (#status = :succeeded AND attribute_not_exists(#createdAt))'
    );
    expect(reservePut![0].ExpressionAttributeValues).toMatchObject({
      ':failed': 'failed',
      ':reserved': 'reserved',
      ':succeeded': 'succeeded',
    });
    expect(typeof reservePut![0].ExpressionAttributeValues[':stale']).toBe('string');
    expect(typeof reservePut![0].ExpressionAttributeValues[':chatStale']).toBe('string');
    // The chat ceiling is the looser of the two — it must not expire a chat that a
    // resume-after-timeout retry should still be reusing.
    expect(
      Date.parse(reservePut![0].ExpressionAttributeValues[':chatStale'])
    ).toBeLessThan(Date.parse(reservePut![0].ExpressionAttributeValues[':stale']));
  });

  test('lost race + other instance SUCCEEDED → returns reused chat, no create call', async () => {
    const create = jest.fn();
    mockPut.mockReturnValueOnce(conditionalFailure());
    mockGet.mockReturnValue(ok({
      Item: {
        idempotencyKey: 'k', userId: 'user_1', operation: 'additional_page_chat_create',
        scopeId: 'site_1', status: 'succeeded', chatId: 'chat_other_instance',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }));

    const result = await guardedV0ChatCreate(createArgs(create));

    expect(result).toEqual({ id: 'chat_other_instance', reused: true });
    expect(create).not.toHaveBeenCalled();
  });

  test('lost race + other instance still RESERVED → throws in-progress and resyncs the local map', async () => {
    const create = jest.fn();
    const winner = {
      idempotencyKey: 'k', userId: 'user_1', operation: 'additional_page_chat_create',
      scopeId: 'site_1', status: 'reserved',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    // Pre-check read sees nothing; the conditional put loses; recovery read sees the winner.
    mockGet.mockReturnValueOnce(ok({ Item: undefined })).mockReturnValue(ok({ Item: winner }));
    mockPut.mockReturnValueOnce(conditionalFailure());

    await expect(guardedV0ChatCreate(createArgs(create))).rejects.toThrow(/in progress/i);
    expect(create).not.toHaveBeenCalled();

    // The local map was resynced to the winner's record (not left as this instance's
    // phantom reservation): a follow-up attempt consults it and still blocks fresh.
    mockPut.mockClear();
    await expect(guardedV0ChatCreate(createArgs(create))).rejects.toThrow(/in progress/i);
    expect(mockPut).not.toHaveBeenCalled(); // blocked by the pre-check, before any write
  });

  test('a persisted FAILED record from a previous run does not block a retry', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_retry' });
    mockGet.mockReturnValueOnce(ok({
      Item: {
        idempotencyKey: 'k', userId: 'user_1', operation: 'additional_page_chat_create',
        scopeId: 'site_1', status: 'failed', failureReason: 'timed out after 300s',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }));

    const result = await guardedV0ChatCreate(createArgs(create));

    expect(result).toMatchObject({ id: 'chat_retry' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a persisted STALE reserved record (crash tombstone) does not block a retry', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'chat_reclaimed' });
    const staleIso = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // > 20-min TTL
    mockGet.mockReturnValueOnce(ok({
      Item: {
        idempotencyKey: 'k', userId: 'user_1', operation: 'additional_page_chat_create',
        scopeId: 'site_1', status: 'reserved',
        createdAt: staleIso, updatedAt: staleIso,
      },
    }));

    const result = await guardedV0ChatCreate(createArgs(create));

    expect(result).toMatchObject({ id: 'chat_reclaimed' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('clearV0UsageForPage deletes both the first-page and sub-page identities', async () => {
    await clearV0UsageForPage({
      userId: 'user_1',
      pageId: 'page_1',
      siteId: 'site_1',
      slug: 'book-a-demo',
    });

    const deletedKeys = mockDelete.mock.calls.map((c: any) => c[0].Key.idempotencyKey);
    expect(deletedKeys).toEqual([
      'first_page_chat_create#user_1#page_1##',
      'additional_page_chat_create#user_1#site_1#book-a-demo#',
    ]);
  });
});

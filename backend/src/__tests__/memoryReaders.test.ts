/**
 * ENG-2840 (W2-1): the memory readers follow the cursor up to a bound instead of returning one page.
 *
 * The bug: a memory row carries a 1,536-number embedding (about 17 KB) and a query page holds 1 MB, so one page is 56 to 60 rows;
 * both readers returned after the first page, so an account with more memories than that only ever showed its OLDEST ~56. On
 * 2026-11-23 the largest account stored 277 rows and one page returned 56. These tests drive the real db functions against a
 * mocked DocumentClient that serves pages the way DynamoDB does.
 */
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => mockDocumentClientMethods) },
  S3: jest.fn(() => ({ upload: jest.fn(), getObject: jest.fn(), deleteObject: jest.fn() })),
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn(), updateEmailEventContent: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { getReceivedEmailContent: jest.fn(), getDeliveredEmailContent: jest.fn() },
}));

import { accountMemoryDb, orgMemoryDb, ACCOUNT_MEMORY_LIST_ATTRIBUTES, ORG_MEMORY_LIST_ATTRIBUTES } from '../services/db';
import { MEMORY_READ_MAX_ROWS_LIST, MEMORY_READ_MAX_ROWS_PROMPT } from '../utils/memoryReadLimits';

type Row = Record<string, any>;
const accountRow = (i: number): Row => ({ userId: 'u1', memoryId: `01ROW${String(i).padStart(4, '0')}`, category: 'insight', content: `fact ${i}`, embedding: [i, i], createdAt: '2026-01-01' });
const orgRow = (i: number): Row => ({ orgId: 'o1', memoryId: `01ORG${String(i).padStart(4, '0')}`, category: 'insight', content: `fact ${i}`, embedding: [i, i], createdAt: '2026-01-01' });

/** Serve `pages` one per query call, each with a LastEvaluatedKey except the last, like DynamoDB paging a long partition. */
function servePages(pages: Row[][], keyOf: (row: Row) => Row) {
  let call = 0;
  mockDocumentClientMethods.query.mockImplementation(() => ({
    promise: async () => {
      const items = pages[Math.min(call, pages.length - 1)];
      const last = call >= pages.length - 1;
      call++;
      return { Items: items, ...(last ? {} : { LastEvaluatedKey: keyOf(items[items.length - 1]) }) };
    },
  }));
}
const accountKey = (row: Row) => ({ userId: row.userId, memoryId: row.memoryId });
const orgKey = (row: Row) => ({ orgId: row.orgId, memoryId: row.memoryId });
const range = (from: number, count: number, make: (i: number) => Row) => Array.from({ length: count }, (_, k) => make(from + k));

beforeEach(() => {
  jest.clearAllMocks();
  mockDocumentClientMethods.query.mockReset();
  mockDocumentClientMethods.delete.mockReset();
  mockDocumentClientMethods.update.mockReset();
});

describe('the bounds', () => {
  it('are 200 rows for the prompt loader and 1,000 for the list screens', () => {
    expect(MEMORY_READ_MAX_ROWS_PROMPT).toBe(200);
    expect(MEMORY_READ_MAX_ROWS_LIST).toBe(1000);
  });
});

describe('accountMemoryDb.getUserMemories follows the cursor', () => {
  it('returns every row across pages, and asks for the remainder each time (Limit = bound minus rows so far)', async () => {
    servePages([range(1, 3, accountRow), range(4, 2, accountRow)], accountKey);
    const rows = await accountMemoryDb.getUserMemories('u1');
    expect(rows.map((r: Row) => r.content)).toEqual(['fact 1', 'fact 2', 'fact 3', 'fact 4', 'fact 5']);
    const calls = mockDocumentClientMethods.query.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0].Limit).toBe(200);
    expect(calls[0].ExclusiveStartKey).toBeUndefined();
    expect(calls[1].Limit).toBe(197);
    expect(calls[1].ExclusiveStartKey).toEqual({ userId: 'u1', memoryId: '01ROW0003' });
  });

  it('reads the prod shape: 277 rows in pages of 56 stop after four pages at 200 rows, not at the first 56 (the order is pinned by the order tests)', async () => {
    const pages = [0, 1, 2, 3, 4].map((p) => range(p * 56 + 1, p === 4 ? 53 : 56, accountRow));
    servePages(pages, accountKey);
    const rows = await accountMemoryDb.getUserMemories('u1');
    expect(rows).toHaveLength(200);
    const limits = mockDocumentClientMethods.query.mock.calls.map((c) => c[0].Limit);
    expect(limits).toEqual([200, 144, 88, 32]);
  });

  it('stops at the bound even if a page returns more than was asked for', async () => {
    servePages([range(1, 3, accountRow), range(4, 3, accountRow)], accountKey);
    const rows = await accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows: 4 });
    expect(rows).toHaveLength(4);
    expect(mockDocumentClientMethods.query.mock.calls[1][0].Limit).toBe(1);
  });

  it('makes one call when everything fits in one page', async () => {
    servePages([range(1, 3, accountRow)], accountKey);
    expect(await accountMemoryDb.getUserMemories('u1')).toHaveLength(3);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(1);
  });

  it('reads newest first by default (memory ids are ULIDs), and oldest first when asked', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1');
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ScanIndexForward).toBe(false);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { newestFirst: false });
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ScanIndexForward).toBeUndefined();
  });

  it('keeps the embedding vectors by default (the prompt loader ranks by them) and strips them on request', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    expect((await accountMemoryDb.getUserMemories('u1'))[0].embedding).toEqual([1, 1]);
    servePages([range(1, 2, accountRow)], accountKey);
    const stripped = await accountMemoryDb.getUserMemories('u1', undefined, undefined, { omitEmbeddings: true });
    expect(stripped).toHaveLength(2);
    for (const row of stripped) expect('embedding' in row).toBe(false);
    expect(stripped[0].content).toBe('fact 1');
  });

  it('a category read uses the category index, is bounded, and does not claim a time order the index cannot give', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', 'preference');
    const call = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(call.IndexName).toBe('UserIdCategoryIndex');
    expect(call.ScanIndexForward).toBeUndefined();
    expect(call.Limit).toBe(200);
  });

  it('a call WITH a limit behaves as before: that limit, no direction change', async () => {
    servePages([range(1, 5, accountRow)], accountKey);
    const rows = await accountMemoryDb.getUserMemories('u1', undefined, 5);
    expect(rows).toHaveLength(5);
    const call = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(call.Limit).toBe(5);
    expect(call.ScanIndexForward).toBeUndefined();
  });

  it('skips structured learning rows, jumping the contiguous range, and still fills the bound', async () => {
    mockDocumentClientMethods.query.mockImplementation((params: any) => ({
      promise: async () => (params.KeyConditionExpression.includes('memoryId <')
        ? { Items: range(1, 2, accountRow) }
        : { Items: [{ memoryId: 'ads-learning#a', content: 'proposal' }], LastEvaluatedKey: { userId: 'u1', memoryId: 'ads-learning#a' } }),
    }));
    const rows = await accountMemoryDb.getUserMemories('u1');
    expect(rows.map((r: Row) => r.memoryId)).toEqual(['01ROW0001', '01ROW0002']);
    const jump = mockDocumentClientMethods.query.mock.calls[1][0];
    expect(jump.ExpressionAttributeValues[':learningBoundary']).toBe('ads-learning#');
    expect(jump.ExclusiveStartKey).toBeUndefined();
    expect(jump.Limit).toBe(200);
  });

  it('fails closed when the page budget runs out: 17 pages for the prompt bound, 44 for the list bound, 10 for a limit call', async () => {
    mockDocumentClientMethods.query.mockImplementation(() => ({ promise: async () => ({ Items: [], LastEvaluatedKey: { userId: 'u1', memoryId: 'x' } }) }));
    await expect(accountMemoryDb.getUserMemories('u1')).rejects.toThrow(/bounded page budget/);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(17);
    mockDocumentClientMethods.query.mockClear();
    await expect(accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows: 1000 })).rejects.toThrow(/bounded page budget/);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(44);
    mockDocumentClientMethods.query.mockClear();
    await expect(accountMemoryDb.getUserMemories('u1', undefined, 7)).rejects.toThrow(/bounded page budget/);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(10);
  });

  it('still fails closed on a malformed row', async () => {
    mockDocumentClientMethods.query.mockReturnValue({ promise: async () => ({ Items: [{ memoryId: 5, content: 'x' }] }) });
    await expect(accountMemoryDb.getUserMemories('u1')).rejects.toThrow(/Malformed account memory item/);
  });
});

describe('orgMemoryDb.getOrgMemories follows the cursor', () => {
  it('returns every row across pages, newest first by default', async () => {
    servePages([range(1, 3, orgRow), range(4, 2, orgRow)], orgKey);
    const rows = await orgMemoryDb.getOrgMemories('o1');
    expect(rows).toHaveLength(5);
    const calls = mockDocumentClientMethods.query.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0].ScanIndexForward).toBe(false);
    expect(calls[0].Limit).toBe(200);
    expect(calls[1].Limit).toBe(197);
    expect(calls[1].ExclusiveStartKey).toEqual({ orgId: 'o1', memoryId: '01ORG0003' });
  });

  it('stops at the bound, oldest first and without vectors for the list screens', async () => {
    servePages([range(1, 3, orgRow), range(4, 3, orgRow)], orgKey);
    const rows = await orgMemoryDb.getOrgMemories('o1', undefined, undefined, { maxRows: 4, newestFirst: false, omitEmbeddings: true });
    expect(rows).toHaveLength(4);
    for (const row of rows) expect('embedding' in row).toBe(false);
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ScanIndexForward).toBeUndefined();
    expect(mockDocumentClientMethods.query.mock.calls[1][0].Limit).toBe(1);
  });

  it('keeps vectors by default', async () => {
    servePages([range(1, 2, orgRow)], orgKey);
    expect((await orgMemoryDb.getOrgMemories('o1'))[0].embedding).toEqual([1, 1]);
  });

  it('a category read uses the category index and no direction', async () => {
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1', 'workflow');
    const call = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(call.IndexName).toBe('OrgIdCategoryIndex');
    expect(call.ScanIndexForward).toBeUndefined();
  });

  it('a call WITH a limit is one query, as before, even when more pages exist', async () => {
    servePages([range(1, 2, orgRow), range(3, 2, orgRow)], orgKey);
    const rows = await orgMemoryDb.getOrgMemories('o1', undefined, 2);
    expect(rows).toHaveLength(2);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(1);
    expect(mockDocumentClientMethods.query.mock.calls[0][0].Limit).toBe(2);
  });

  it('fails closed when the page budget runs out (17 pages for the prompt bound)', async () => {
    mockDocumentClientMethods.query.mockImplementation(() => ({ promise: async () => ({ Items: [], LastEvaluatedKey: { orgId: 'o1', memoryId: 'x' } }) }));
    await expect(orgMemoryDb.getOrgMemories('o1')).rejects.toThrow(/Org memory retrieval exceeded its bounded page budget/);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(17);
  });

});

describe('deleteMemory says whether there was anything to delete', () => {
  it('account: true when a row came back, false when none did, and it asks for the old item', async () => {
    mockDocumentClientMethods.delete.mockReturnValue({ promise: async () => ({ Attributes: accountRow(1) }) });
    expect(await accountMemoryDb.deleteMemory('u1', 'm1')).toBe(true);
    expect(mockDocumentClientMethods.delete.mock.calls[0][0]).toMatchObject({ Key: { userId: 'u1', memoryId: 'm1' }, ReturnValues: 'ALL_OLD' });
    mockDocumentClientMethods.delete.mockReturnValue({ promise: async () => ({}) });
    expect(await accountMemoryDb.deleteMemory('u1', 'gone')).toBe(false);
  });

  it('org: true when a row came back, false when none did', async () => {
    mockDocumentClientMethods.delete.mockReturnValue({ promise: async () => ({ Attributes: orgRow(1) }) });
    expect(await orgMemoryDb.deleteMemory('o1', 'm1')).toBe(true);
    expect(mockDocumentClientMethods.delete.mock.calls[0][0]).toMatchObject({ Key: { orgId: 'o1', memoryId: 'm1' }, ReturnValues: 'ALL_OLD' });
    mockDocumentClientMethods.delete.mockReturnValue({ promise: async () => ({}) });
    expect(await orgMemoryDb.deleteMemory('o1', 'gone')).toBe(false);
  });

  it('still refuses to delete a structured learning row', async () => {
    await expect(accountMemoryDb.deleteMemory('u1', 'ads-learning#x')).rejects.toThrow(/learning review/);
    expect(mockDocumentClientMethods.delete).not.toHaveBeenCalled();
  });
});

describe('an ascending read jumps over the learning range at the END of the partition', () => {
  it('uses a > boundary past the last learning id, makes no further call, and returns the ordinary rows (the list routes read this way)', async () => {
    mockDocumentClientMethods.query.mockImplementation((params: any) => ({
      promise: async () => (params.KeyConditionExpression.includes('memoryId >')
        ? { Items: [] }
        : { Items: range(1, 2, accountRow), LastEvaluatedKey: { userId: 'u1', memoryId: 'ads-learning#a' } }),
    }));
    const rows = await accountMemoryDb.getUserMemories('u1', undefined, undefined, { newestFirst: false });
    expect(rows.map((r: Row) => r.memoryId)).toEqual(['01ROW0001', '01ROW0002']);
    const calls = mockDocumentClientMethods.query.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[1].KeyConditionExpression).toContain('memoryId >');
    expect(calls[1].ExpressionAttributeValues[':learningBoundary']).toBe('ads-learning#\uffff');
    expect(calls[1].ExclusiveStartKey).toBeUndefined();
    expect(calls[1].ScanIndexForward).toBeUndefined();
  });
});

describe('the org reader keeps a limit call as it was', () => {
  it('a limit call has no direction either (the account reader is pinned the same way)', async () => {
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1', undefined, 2);
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ScanIndexForward).toBeUndefined();
  });
});

describe('omitEmbeddings does not fetch the vectors: a projection naming every other attribute', () => {
  const ACCOUNT_ATTRS = ['category', 'content', 'createdAt', 'memoryId', 'sourceSessionId', 'updatedAt', 'userId'];
  const ORG_ATTRS = ['category', 'content', 'createdAt', 'memoryId', 'orgId', 'sourceUserId', 'updatedAt'];
  const projectedNames = (call: any) => Object.values(call.ExpressionAttributeNames as Record<string, string>).sort();
  const expressionUsesEveryName = (call: any) => Object.keys(call.ExpressionAttributeNames).every((k) => call.ProjectionExpression.includes(k));

  it('account: names every stored attribute except embedding, and a default read names none (the prompt loader needs the vectors)', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { omitEmbeddings: true });
    const call = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(projectedNames(call)).toEqual(ACCOUNT_ATTRS);
    expect(expressionUsesEveryName(call)).toBe(true);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1');
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ProjectionExpression).toBeUndefined();
  });

  it('org: names every stored attribute except embedding, and a default read names none', async () => {
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1', undefined, undefined, { omitEmbeddings: true });
    const call = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(projectedNames(call)).toEqual(ORG_ATTRS);
    expect(expressionUsesEveryName(call)).toBe(true);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1');
    expect(mockDocumentClientMethods.query.mock.calls[0][0].ProjectionExpression).toBeUndefined();
  });

  it('a category read and a limit call carry the projection too', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', 'preference', undefined, { omitEmbeddings: true });
    const byCategory = mockDocumentClientMethods.query.mock.calls[0][0];
    expect(byCategory.IndexName).toBe('UserIdCategoryIndex');
    expect(projectedNames(byCategory)).toEqual(ACCOUNT_ATTRS);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1', undefined, 2, { omitEmbeddings: true });
    expect(projectedNames(mockDocumentClientMethods.query.mock.calls[0][0])).toEqual(ORG_ATTRS);
  });

  it('the projection survives the learning-range jump (the jump query is built from the same parameters)', async () => {
    mockDocumentClientMethods.query.mockImplementation((params: any) => ({
      promise: async () => (params.KeyConditionExpression.includes('memoryId <')
        ? { Items: range(1, 2, accountRow) }
        : { Items: [{ memoryId: 'ads-learning#a', content: 'proposal' }], LastEvaluatedKey: { userId: 'u1', memoryId: 'ads-learning#a' } }),
    }));
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { omitEmbeddings: true });
    const jump = mockDocumentClientMethods.query.mock.calls[1][0];
    expect(jump.KeyConditionExpression).toContain('memoryId <');
    expect(projectedNames(jump)).toEqual(ACCOUNT_ATTRS);
  });
});

describe('the bound of a read is a whole number of at least 1', () => {
  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])('a maxRows of %p falls back to the default of 200', async (maxRows) => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows });
    expect(mockDocumentClientMethods.query.mock.calls[0][0].Limit).toBe(200);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, orgRow)], orgKey);
    await orgMemoryDb.getOrgMemories('o1', undefined, undefined, { maxRows });
    expect(mockDocumentClientMethods.query.mock.calls[0][0].Limit).toBe(200);
  });

  it('a fractional maxRows is rounded down, but never below 1', async () => {
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows: 2.7 });
    expect(mockDocumentClientMethods.query.mock.calls[0][0].Limit).toBe(2);
    mockDocumentClientMethods.query.mockClear();
    servePages([range(1, 2, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows: 0.5 });
    expect(mockDocumentClientMethods.query.mock.calls[0][0].Limit).toBe(1);
  });
});

describe('a read that stops at its bound with more rows stored says so in the log', () => {
  const morePages = (make: (i: number) => Row, key: (r: Row) => Row) =>
    mockDocumentClientMethods.query.mockImplementation(() => ({ promise: async () => ({ Items: range(1, 4, make), LastEvaluatedKey: key(make(4)) }) }));
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('account: one warning when the bound is hit with a cursor still pending', async () => {
    morePages(accountRow, accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, undefined, { maxRows: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/account memory read stopped at its 4-row bound/);
  });

  it('org: one warning when the bound is hit with a cursor still pending', async () => {
    morePages(orgRow, orgKey);
    await orgMemoryDb.getOrgMemories('o1', undefined, undefined, { maxRows: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/org memory read stopped at its 4-row bound/);
  });

  it('no warning when the rows ran out, and none for a limit call', async () => {
    servePages([range(1, 3, accountRow)], accountKey);
    await accountMemoryDb.getUserMemories('u1');
    morePages(accountRow, accountKey);
    await accountMemoryDb.getUserMemories('u1', undefined, 4);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the org reader still returns rows as stored (it never validated them)', () => {
  it('a row without content comes back instead of failing the whole list, with a limit call and without', async () => {
    mockDocumentClientMethods.query.mockReturnValue({ promise: async () => ({ Items: [{ orgId: 'o1', memoryId: 'm1' }, orgRow(2)] }) });
    expect((await orgMemoryDb.getOrgMemories('o1')).map((r: Row) => r.memoryId)).toEqual(['m1', '01ORG0002']);
    expect((await orgMemoryDb.getOrgMemories('o1', undefined, 5)).map((r: Row) => r.memoryId)).toEqual(['m1', '01ORG0002']);
  });

  it('a page that is not a list is still refused', async () => {
    mockDocumentClientMethods.query.mockReturnValue({ promise: async () => ({ Items: 'nope' }) });
    await expect(orgMemoryDb.getOrgMemories('o1')).rejects.toThrow(/Malformed org memory page/);
  });
});

describe('the account reader still refuses a row without a string content (unchanged design)', () => {
  it('fails closed, with or without a limit', async () => {
    mockDocumentClientMethods.query.mockReturnValue({ promise: async () => ({ Items: [{ userId: 'u1', memoryId: 'm1' }] }) });
    await expect(accountMemoryDb.getUserMemories('u1')).rejects.toThrow(/Malformed account memory item/);
    await expect(accountMemoryDb.getUserMemories('u1', undefined, 5)).rejects.toThrow(/Malformed account memory item/);
  });
});

describe('setMemoryEmbedding never brings a deleted memory back', () => {
  const conditionalFailure = () => ({ promise: async () => { throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' }); } });

  it('account: the update is conditional on the row existing, and a row deleted meanwhile is ignored', async () => {
    mockDocumentClientMethods.update.mockReturnValue({ promise: async () => ({}) });
    await accountMemoryDb.setMemoryEmbedding('u1', 'm1', [1, 2]);
    expect(mockDocumentClientMethods.update.mock.calls[0][0]).toMatchObject({ Key: { userId: 'u1', memoryId: 'm1' }, ConditionExpression: 'attribute_exists(memoryId)' });
    mockDocumentClientMethods.update.mockReturnValue(conditionalFailure());
    await expect(accountMemoryDb.setMemoryEmbedding('u1', 'gone', [1, 2])).resolves.toBeUndefined();
  });

  it('org: the same', async () => {
    mockDocumentClientMethods.update.mockReturnValue({ promise: async () => ({}) });
    await orgMemoryDb.setMemoryEmbedding('o1', 'm1', [1, 2]);
    expect(mockDocumentClientMethods.update.mock.calls[0][0]).toMatchObject({ Key: { orgId: 'o1', memoryId: 'm1' }, ConditionExpression: 'attribute_exists(memoryId)' });
    mockDocumentClientMethods.update.mockReturnValue(conditionalFailure());
    await expect(orgMemoryDb.setMemoryEmbedding('o1', 'gone', [1, 2])).resolves.toBeUndefined();
  });

  it('any other failure is still thrown', async () => {
    mockDocumentClientMethods.update.mockReturnValue({ promise: async () => { throw Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' }); } });
    await expect(accountMemoryDb.setMemoryEmbedding('u1', 'm1', [1])).rejects.toThrow('throttled');
    await expect(orgMemoryDb.setMemoryEmbedding('o1', 'm1', [1])).rejects.toThrow('throttled');
  });
});

describe('an ascending read that reaches its bound on a page ending in the learning range', () => {
  it('stops there: it does not ask for a page with Limit 0, and it says it stopped at the bound', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDocumentClientMethods.query.mockImplementation(() => ({
      promise: async () => ({ Items: range(1, 2, accountRow), LastEvaluatedKey: { userId: 'u1', memoryId: 'ads-learning#a' } }),
    }));
    const rows = await accountMemoryDb.getUserMemories('u1', undefined, undefined, { newestFirst: false, maxRows: 2 });
    expect(rows).toHaveLength(2);
    expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(1);
    expect(mockDocumentClientMethods.query.mock.calls.every((c) => c[0].Limit !== 0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/there may be more rows stored/);
    warn.mockRestore();
  });
});

describe('the projection lists cover every attribute the writers store', () => {
  it('account: a row written by addMemory with every optional argument carries only listed attributes (plus the embedding)', async () => {
    mockDocumentClientMethods.put.mockReturnValue({ promise: async () => ({}) });
    await accountMemoryDb.addMemory('u1', 'insight', 'a fact', 'session-1', [0.1, 0.2]);
    const stored = Object.keys(mockDocumentClientMethods.put.mock.calls[0][0].Item).sort();
    expect(stored).toEqual([...ACCOUNT_MEMORY_LIST_ATTRIBUTES, 'embedding'].sort());
  });

  it('org: the same', async () => {
    mockDocumentClientMethods.put.mockReturnValue({ promise: async () => ({}) });
    await orgMemoryDb.addMemory('o1', 'insight', 'a fact', 'author-1', [0.1, 0.2]);
    const stored = Object.keys(mockDocumentClientMethods.put.mock.calls[0][0].Item).sort();
    expect(stored).toEqual([...ORG_MEMORY_LIST_ATTRIBUTES, 'embedding'].sort());
  });
});

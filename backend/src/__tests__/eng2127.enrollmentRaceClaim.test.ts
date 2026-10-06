/**
 * ENG-2127 (remaining scope) — the bulk-enrollment race.
 *
 * Enrollment IDs are random; the only duplicate check used to be a query against
 * `leadEmail-index`, which is eventually consistent. Two concurrent callers for the
 * same lead+sequence could both see "not enrolled" and both write — the whole sequence
 * delivered twice. `enrollLead` now atomically claims every identity candidate against
 * this table's own (strongly consistent) primary key in the same transaction as the
 * real enrollment write, so only one of two racing callers can ever win.
 *
 * These tests simulate the actual DynamoDB conditional-put semantics inside the mock
 * (a shared "claimed keys" set that a second conditional put against an already-present
 * key fails against) specifically so the concurrency case is a real assertion, not a
 * restatement of the implementation.
 */

const mockQuery = jest.fn();
const mockTransactWrite = jest.fn();

jest.mock('aws-sdk', () => {
  const client = () => ({
    query: mockQuery,
    put: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
    transactWrite: mockTransactWrite,
    update: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
  });
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) }, config: { update: jest.fn() } },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';

const emptyRows = { promise: () => Promise.resolve({ Items: [] }) };

const input = {
  sequenceId: 'seq-1', userId: 'user-1', listId: 'list-1',
  leadId: 'lead-1', leadEmail: 'ada@acme.io',
  identityCandidates: ['ada@acme.io', 'https://www.linkedin.com/in/ada/'],
};

/** A conditional-check failure from a real TransactWriteItems call. */
const conditionalFailure = () => {
  const err: any = new Error('Transaction cancelled');
  err.code = 'TransactionCanceledException';
  err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
  return err;
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockReturnValue(emptyRows);
  mockTransactWrite.mockReset();
});

describe('enrollLead: the claim transaction itself', () => {
  it('claims every identity candidate plus the enrollment, in one transaction', async () => {
    mockTransactWrite.mockReturnValue({ promise: () => Promise.resolve({}) });

    const result = await dripSequenceDb.enrollLead(input as any);

    expect(result).not.toBeNull();
    const items = mockTransactWrite.mock.calls[0][0].TransactItems;
    expect(items).toHaveLength(3); // 2 identity candidates + the enrollment itself
    const claimKeys = items.map((t: any) => t.Put.Item.enrollmentId).filter((id: string) => id.startsWith('claim#'));
    expect(claimKeys).toEqual(
      expect.arrayContaining([
        'claim#seq-1#ada@acme.io',
        'claim#seq-1#https://www.linkedin.com/in/ada/',
      ]),
    );
    // Every claim carries a conditional guard against a prior claim.
    items
      .filter((t: any) => t.Put.Item.enrollmentId.startsWith('claim#'))
      .forEach((t: any) => expect(t.Put.ConditionExpression).toBe('attribute_not_exists(enrollmentId)'));
  });

  it('claim items carry none of this table\'s GSI key attributes — invisible to every existing query', async () => {
    mockTransactWrite.mockReturnValue({ promise: () => Promise.resolve({}) });

    await dripSequenceDb.enrollLead(input as any);

    const items = mockTransactWrite.mock.calls[0][0].TransactItems;
    const claims = items.filter((t: any) => t.Put.Item.enrollmentId.startsWith('claim#'));
    for (const claim of claims) {
      // leadEmail-index key, sequenceId-status-index key, userId-nextSendAt-index key.
      expect(claim.Put.Item.leadEmail).toBeUndefined();
      expect(claim.Put.Item.status).toBeUndefined();
      expect(claim.Put.Item.userId).toBeUndefined();
      expect(claim.Put.Item.nextSendAt).toBeUndefined();
    }
  });

  it('returns null, not a thrown error, when a candidate is already claimed', async () => {
    mockTransactWrite.mockReturnValue({ promise: () => Promise.reject(conditionalFailure()) });

    const result = await dripSequenceDb.enrollLead(input as any);

    expect(result).toBeNull();
  });

  it('returns null on a TransactionConflictException too', async () => {
    const err: any = new Error('conflict');
    err.code = 'TransactionConflictException';
    mockTransactWrite.mockReturnValue({ promise: () => Promise.reject(err) });

    const result = await dripSequenceDb.enrollLead(input as any);

    expect(result).toBeNull();
  });

  it('rethrows an unrelated error rather than silently treating it as "already enrolled"', async () => {
    mockTransactWrite.mockReturnValue({ promise: () => Promise.reject(new Error('network blip')) });

    await expect(dripSequenceDb.enrollLead(input as any)).rejects.toThrow('network blip');
  });
});

describe('bulkEnroll: treats a lost race the same as the pre-check finding a row', () => {
  it('counts a null from enrollLead as skipped, not enrolled, and does not throw', async () => {
    mockTransactWrite.mockReturnValue({ promise: () => Promise.reject(conditionalFailure()) });

    const result = await dripSequenceDb.bulkEnroll([input as any]);

    expect(result).toEqual({ enrolled: 0, skipped: 1 });
  });
});

describe('the actual bug: two concurrent callers racing past the same eventually-consistent pre-check', () => {
  it('only one of two simultaneous enrollLead calls for the same lead+sequence wins', async () => {
    // Simulates real DynamoDB: a conditional put against an already-present key fails.
    // Both callers' GSI pre-check already returned "nothing" (mockQuery above) — this
    // is exactly the race window ENG-2127 describes. Without the claim transaction,
    // both would reach the old unconditional `put` and both would succeed.
    const claimed = new Set<string>();
    mockTransactWrite.mockImplementation((params: any) => ({
      promise: async () => {
        const keys: string[] = params.TransactItems
          .map((t: any) => t.Put.Item.enrollmentId)
          .filter((id: string) => id.startsWith('claim#'));
        if (keys.some((k) => claimed.has(k))) {
          const err: any = new Error('Transaction cancelled');
          err.code = 'TransactionCanceledException';
          err.CancellationReasons = keys.map((k) => ({ Code: claimed.has(k) ? 'ConditionalCheckFailed' : 'None' }));
          throw err;
        }
        keys.forEach((k) => claimed.add(k));
        return {};
      },
    }));

    const [first, second] = await Promise.all([
      dripSequenceDb.enrollLead(input as any),
      dripSequenceDb.enrollLead(input as any),
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
  });
});

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
 * These tests pin the control-flow correctness (a conditional put against an
 * already-present key resolves to null, not a second write) using a mocked
 * transactWrite — they are not a genuine interleaving test, since nothing here awaits
 * between two "concurrent" calls at the mock layer. The actual proof that this holds
 * under real, simultaneous requests is a live test against a running preview backend +
 * real DynamoDB (recorded in chod-brain's pr-3264 node), not these unit tests alone.
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

  /**
   * A TransactionConflictException is NOT the same as a ConditionalCheckFailed — AWS's
   * own guidance is that it means another transaction was concurrently touching the
   * same item and this one couldn't proceed, not that the condition was evaluated and
   * lost. Treating it the same as a genuine duplicate (an earlier version of this code
   * did) would silently drop a lead with zero signal anything went wrong. It must be
   * retried, not resolved to null.
   */
  it('retries on a transient TransactionConflictException rather than treating it as a duplicate', async () => {
    const conflict: any = new Error('conflict');
    conflict.code = 'TransactionConflictException';
    let attempts = 0;
    mockTransactWrite.mockImplementation(() => ({
      promise: () => {
        attempts++;
        if (attempts === 1) return Promise.reject(conflict);
        return Promise.resolve({});
      },
    }));

    const result = await dripSequenceDb.enrollLead(input as any);

    expect(result).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it('throws, rather than silently returning null, if the conflict never resolves', async () => {
    const conflict: any = new Error('conflict');
    conflict.code = 'TransactionConflictException';
    mockTransactWrite.mockReturnValue({ promise: () => Promise.reject(conflict) });

    await expect(dripSequenceDb.enrollLead(input as any)).rejects.toThrow('conflict');
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
    // This pins the CONTROL-FLOW correctness (a conditional put against an
    // already-present key resolves to null, not a second enrollment) — it is not a
    // genuine interleaving test, since the mock's transactWrite has no await before its
    // first branch, so these two calls do not actually race at the OS/event-loop level.
    // The real proof of atomicity under genuine concurrency is the live test (recorded
    // in chod-brain's pr-3264 node): 5 truly concurrent HTTP requests against a running
    // preview backend + real DynamoDB, exactly 1 won. Both callers' GSI pre-check
    // already returned "nothing" (mockQuery above) — this is exactly the race window
    // ENG-2127 describes. Without the claim transaction, both would reach the old
    // unconditional `put` and both would succeed.
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

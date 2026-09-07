/**
 * ENG-702 §6 adoption for v0 — the first adapter to carry an idempotency token.
 *
 * The unit of charge is ONE PER RESERVATION, not per attempt. `meteredV0`
 * returns a thunk that `withRetry` re-invokes, so before this every retry inside
 * one reservation booked another charge — the exact defect ENG-702 names:
 * "the v0 retry loop books duplicates under one reservation".
 */
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: jest.fn(),
}));

import { meteredV0, recordV0Call } from '../services/v0Metering';
import { meteringKeyFor } from '../services/v0UsageGuard';
import { recordVendorUsage } from '../services/usageRecorderService';

const mockRecord = recordVendorUsage as jest.Mock;
const keysRecorded = () => mockRecord.mock.calls.map((c) => c[0].idempotencyKey);

describe('meteringKeyFor', () => {
  it('is derived from the guard key, not invented alongside it', () => {
    // Two independent notions of "the same v0 call" would drift, and the
    // failure would be silent: the guard deduping while the ledger charged
    // twice, or the reverse.
    expect(meteringKeyFor('chat_create#u1#page1##', '2026-09-08T10:00:00.000Z')).toBe(
      'v0:chat_create#u1#page1###2026-09-08T10:00:00.000Z',
    );
  });

  it('separates two reservations of the SAME generation', () => {
    // A guard-permitted retry after a failure really did call v0 again and must
    // be charged in full.
    const guardKey = 'chat_create#u1#page1##';
    expect(meteringKeyFor(guardKey, '2026-09-08T10:00:00.000Z')).not.toBe(
      meteringKeyFor(guardKey, '2026-09-08T10:05:00.000Z'),
    );
  });
});

describe('meteredV0 carries the token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records the supplied key on a successful call', async () => {
    await meteredV0({ userId: 'u1', operation: 'chat_create', idempotencyKey: 'v0:k#t' }, async () => 'ok')();

    expect(keysRecorded()).toEqual(['v0:k#t']);
  });

  it('records it on a failed call that still reached the vendor', async () => {
    const vendorError = Object.assign(new Error('v0 said no'), { status: 500 });

    await expect(
      meteredV0({ userId: 'u1', operation: 'chat_create', idempotencyKey: 'v0:k#t' }, async () => {
        throw vendorError;
      })(),
    ).rejects.toBe(vendorError);

    expect(keysRecorded()).toEqual(['v0:k#t']);
  });

  it('every retry inside ONE reservation shares the key, so the ledger charges once', async () => {
    // The thunk is what withRetry re-invokes. Three attempts, three recorder
    // calls — but one identity, so the transactional write dedupes them.
    const thunk = meteredV0({ userId: 'u1', operation: 'correction_message', idempotencyKey: 'v0:k#t' }, async () => 'ok');

    await thunk();
    await thunk();
    await thunk();

    expect(mockRecord).toHaveBeenCalledTimes(3);
    expect(new Set(keysRecorded()).size).toBe(1);
  });

  it('a second reservation gets a different key and is charged in full', async () => {
    await meteredV0({ userId: 'u1', operation: 'chat_create', idempotencyKey: meteringKeyFor('g', 't1') }, async () => 'ok')();
    await meteredV0({ userId: 'u1', operation: 'chat_create', idempotencyKey: meteringKeyFor('g', 't2') }, async () => 'ok')();

    expect(new Set(keysRecorded()).size).toBe(2);
  });

  it('omits the field entirely when no key is supplied, rather than sending undefined', async () => {
    await meteredV0({ userId: 'u1', operation: 'chat_create' }, async () => 'ok')();

    expect(mockRecord.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
  });

  it('still records nothing when the vendor was never reached', async () => {
    const localError = new Error('DNS failure'); // no status — never reached v0

    await expect(
      meteredV0({ userId: 'u1', operation: 'chat_create', idempotencyKey: 'v0:k#t' }, async () => {
        throw localError;
      })(),
    ).rejects.toBe(localError);

    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('recordV0Call passes the key straight through', () => {
    recordV0Call({ userId: 'u1', operation: 'iterate_message', idempotencyKey: 'v0:k#t' });

    expect(mockRecord.mock.calls[0][0].idempotencyKey).toBe('v0:k#t');
  });
});

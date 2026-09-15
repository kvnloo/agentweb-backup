/**
 * Tests for AW-SpendEvents, the ENG-1250 §1 spend ledger.
 *
 * The behaviours worth locking down are the ones that turn into money bugs and
 * cannot be repaired after the fact:
 *  - a replayed idempotency key adds $0 and returns the ORIGINAL event
 *  - a lifecycle only ever advances out of `reserved`
 *  - the write refuses rows that would make §3's invariant unprovable
 *  - range queries go through the GSI and paginate to exhaustion
 *  - no TTL is written (the approved retention decision)
 */

// Mock BEFORE imports
jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    put: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import {
  SPEND_EVENTS_TABLE,
  SPEND_EVENTS_OCCURRED_AT_INDEX,
  SpendEvent,
  SpendEventValidationError,
  recordSpendEvent,
  getSpendEvent,
  transitionSpendEvent,
  listSpendEvents,
  listSpendEventsBounded,
  sumSettledMicroUsd,
  validateSpendEvent,
  isLegalLifecycleTransition,
} from '../services/spendEventDb';

const mockDynamoDB = new (AWS.DynamoDB.DocumentClient as any)();

const conditionalFailure = () => Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });

const anEvent = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  billingUserId: 'owner-1',
  eventId: 'evt-1',
  occurredAt: '2026-09-07T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'user-1',
  provider: 'elevenlabs',
  operation: 'text_to_speech',
  unit: 'character',
  quantity: 1200,
  costMicroUsd: 3600,
  costSource: 'allocated',
  rateCardVersion: '2026-08-16',
  lifecycle: 'settled',
  ...over,
});

describe('spendEventDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    mockDynamoDB.query.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
  });

  describe('recordSpendEvent', () => {
    it('writes a conditional put guarding both key attributes', async () => {
      const result = await recordSpendEvent(anEvent());

      expect(result.stored).toBe(true);
      const arg = mockDynamoDB.put.mock.calls[0][0];
      expect(arg.TableName).toBe(SPEND_EVENTS_TABLE);
      expect(arg.ConditionExpression).toBe(
        'attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)',
      );
    });

    it('writes NO ttl attribute — the approved retention decision is "keep"', async () => {
      await recordSpendEvent(anEvent());

      const item = mockDynamoDB.put.mock.calls[0][0].Item;
      expect(item).not.toHaveProperty('ttl');
      expect(Object.keys(item)).toEqual(Object.keys(anEvent()));
    });

    it('a replayed idempotency key adds $0 and returns the ORIGINAL event, not the retry', async () => {
      const original = anEvent({ costMicroUsd: 3600, vendorReference: 'vendor-abc' });
      const retryWithDifferentCost = anEvent({ costMicroUsd: 999999, vendorReference: 'vendor-zzz' });

      mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionalFailure()) });
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: original }) });

      const result = await recordSpendEvent(retryWithDifferentCost);

      expect(result.stored).toBe(false);
      expect(result.event).toEqual(original);
      // the whole point: the retry's cost is discarded, not booked
      expect(result.event.costMicroUsd).toBe(3600);
      expect(mockDynamoDB.put).toHaveBeenCalledTimes(1);
    });

    it('surfaces a conflict it cannot read back rather than retrying into a double charge', async () => {
      mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionalFailure()) });
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

      await expect(recordSpendEvent(anEvent())).rejects.toThrow(/could not be read back/);
    });

    it('propagates a non-conditional DynamoDB failure', async () => {
      mockDynamoDB.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' })),
      });

      await expect(recordSpendEvent(anEvent())).rejects.toThrow('boom');
    });

    it('validates before writing — a rejected event never reaches DynamoDB', async () => {
      await expect(recordSpendEvent(anEvent({ billingMonth: '2026-08' }))).rejects.toBeInstanceOf(
        SpendEventValidationError,
      );
      expect(mockDynamoDB.put).not.toHaveBeenCalled();
    });
  });

  describe('validateSpendEvent', () => {
    it('rejects a billingMonth that disagrees with occurredAt', () => {
      // These two fields index the same row into two different months; once
      // written, nothing downstream can tell which one was the lie.
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00Z', billingMonth: '2026-08' })))
        .toThrow(/disagrees with occurredAt/);
    });

    it('accepts a matching month', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-12-31T23:59:59Z', billingMonth: '2026-12' })))
        .not.toThrow();
    });

    it('requires rateCardVersion when the cost is allocated', () => {
      expect(() => validateSpendEvent(anEvent({ costSource: 'allocated', rateCardVersion: undefined })))
        .toThrow(/rateCardVersion is required/);
    });

    it('does not require rateCardVersion when the vendor measured the cost', () => {
      expect(() => validateSpendEvent(anEvent({ costSource: 'measured', rateCardVersion: undefined })))
        .not.toThrow();
    });

    it('rejects a fractional costMicroUsd — the §3 invariant is exact to one micro-dollar', () => {
      expect(() => validateSpendEvent(anEvent({ costMicroUsd: 3600.5 }))).toThrow(/non-negative integer/);
    });

    it('rejects negative money and negative quantity', () => {
      expect(() => validateSpendEvent(anEvent({ costMicroUsd: -1 }))).toThrow(/non-negative integer/);
      expect(() => validateSpendEvent(anEvent({ quantity: -1 }))).toThrow(/non-negative number/);
    });

    it.each(['billingUserId', 'eventId', 'actingUserId', 'provider', 'operation', 'unit'] as const)(
      'rejects a missing %s',
      (field) => {
        expect(() => validateSpendEvent(anEvent({ [field]: '' } as Partial<SpendEvent>))).toThrow(
          new RegExp(`${field} is required`),
        );
      },
    );

    it('rejects a malformed occurredAt', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: 'yesterday' }))).toThrow(/ISO-8601/);
    });

    // CodeRabbit, PR #2787: a prefix match on the date is not enough.
    it('rejects an offset timestamp whose UTC instant is in another month', () => {
      // Real instant is 2026-09-30T23:30Z, but the string carries "2026-10" and
      // sorts under October on the GSI — it would land in one month's
      // projection and be invisible to the other month's range query.
      expect(() =>
        validateSpendEvent(anEvent({ occurredAt: '2026-10-01T00:30:00+01:00', billingMonth: '2026-10' })),
      ).toThrow(/canonical UTC/);
    });

    it('rejects any non-Z timezone, including an explicit +00:00', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00+00:00' }))).toThrow(/canonical UTC/);
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00' }))).toThrow(/canonical UTC/);
    });

    it('rejects a date that does not exist rather than letting Date roll it forward', () => {
      // Date() turns this into 2026-03-02, so a real event would be stored on an unreal day.
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-02-30T00:00:00Z', billingMonth: '2026-02' })))
        .toThrow(/canonical UTC/);
    });

    it('rejects month 13 in both fields', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-13-01T00:00:00Z', billingMonth: '2026-13' })))
        .toThrow(/canonical UTC/);
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00Z', billingMonth: '2026-13' })))
        .toThrow(/real month/);
    });

    it('accepts a leap day that does exist', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2028-02-29T12:00:00.000Z', billingMonth: '2028-02' })))
        .not.toThrow();
    });

    it('accepts an instant with and without milliseconds', () => {
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00Z' }))).not.toThrow();
      expect(() => validateSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00.123Z' }))).not.toThrow();
    });
  });

  // CodeRabbit, PR #2787: the GSI sorts occurredAt as a raw string, so every
  // stored row has to use ONE serialization or lexical order stops matching
  // chronological order.
  describe('occurredAt is canonicalised on write', () => {
    it.each([
      ['2026-09-07T10:00:00Z', '2026-09-07T10:00:00.000Z'],
      ['2026-09-07T10:00:00.1Z', '2026-09-07T10:00:00.100Z'],
      ['2026-09-07T10:00:00.12Z', '2026-09-07T10:00:00.120Z'],
      ['2026-09-07T10:00:00.123Z', '2026-09-07T10:00:00.123Z'],
    ])('stores %s as %s', async (given, expected) => {
      await recordSpendEvent(anEvent({ occurredAt: given }));

      expect(mockDynamoDB.put.mock.calls[0][0].Item.occurredAt).toBe(expected);
    });

    it('returns the canonicalised event, not the caller\'s raw one', async () => {
      const result = await recordSpendEvent(anEvent({ occurredAt: '2026-09-07T10:00:00Z' }));

      expect(result.event.occurredAt).toBe('2026-09-07T10:00:00.000Z');
    });

    it('the four accepted forms sort chronologically once stored', async () => {
      const given = ['2026-09-07T10:00:00Z', '2026-09-07T10:00:00.1Z', '2026-09-07T10:00:00.12Z', '2026-09-07T10:00:00.123Z'];

      const stored: string[] = [];
      for (const occurredAt of given) {
        jest.clearAllMocks();
        mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
        await recordSpendEvent(anEvent({ occurredAt }));
        stored.push(mockDynamoDB.put.mock.calls[0][0].Item.occurredAt);
      }

      // Raw, these sort in exactly reverse-chronological order.
      expect([...given].sort()).toEqual([...given].sort((a, b) => Date.parse(b) - Date.parse(a)));
      // Canonicalised, lexical order and instant order are the same thing.
      expect([...stored].sort()).toEqual([...stored].sort((a, b) => Date.parse(a) - Date.parse(b)));
    });
  });

  describe('lifecycle', () => {
    it('only allows a reservation to advance, and both terminal states are final', () => {
      expect(isLegalLifecycleTransition('reserved', 'settled')).toBe(true);
      expect(isLegalLifecycleTransition('reserved', 'voided')).toBe(true);
      expect(isLegalLifecycleTransition('settled', 'voided')).toBe(false);
      expect(isLegalLifecycleTransition('voided', 'settled')).toBe(false);
      expect(isLegalLifecycleTransition('settled', 'settled')).toBe(false);
    });

    it('settling writes the final cost under a lifecycle = reserved condition', async () => {
      const ok = await transitionSpendEvent('owner-1', 'evt-1', 'settled', 4200);

      expect(ok).toBe(true);
      const arg = mockDynamoDB.update.mock.calls[0][0];
      expect(arg.ConditionExpression).toBe("attribute_exists(billingUserId) AND lifecycle = :reserved");
      expect(arg.ExpressionAttributeValues[':reserved']).toBe('reserved');
      expect(arg.ExpressionAttributeValues[':cost']).toBe(4200);
      expect(arg.UpdateExpression).toContain('costMicroUsd = :cost');
    });

    it('voiding zeroes the cost rather than leaving the reservation amount booked', async () => {
      await transitionSpendEvent('owner-1', 'evt-1', 'voided');

      const arg = mockDynamoDB.update.mock.calls[0][0];
      expect(arg.ExpressionAttributeValues[':zero']).toBe(0);
      expect(arg.UpdateExpression).toContain('costMicroUsd = :zero');
    });

    it('returns false — not an error — when the row is no longer reserved', async () => {
      mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(conditionalFailure()) });

      await expect(transitionSpendEvent('owner-1', 'evt-1', 'settled', 4200)).resolves.toBe(false);
    });

    it('refuses to settle without a final cost', async () => {
      await expect(transitionSpendEvent('owner-1', 'evt-1', 'settled')).rejects.toThrow(/requires the final costMicroUsd/);
      expect(mockDynamoDB.update).not.toHaveBeenCalled();
    });

    it('refuses to book a cost onto a void', async () => {
      await expect(transitionSpendEvent('owner-1', 'evt-1', 'voided', 100)).rejects.toThrow(/must not supply a cost/);
      expect(mockDynamoDB.update).not.toHaveBeenCalled();
    });

    it('refuses a fractional settlement amount', async () => {
      await expect(transitionSpendEvent('owner-1', 'evt-1', 'settled', 12.5)).rejects.toThrow(/non-negative integer/);
    });
  });

  describe('listSpendEvents', () => {
    it('queries the occurredAt GSI, not the base table', async () => {
      await listSpendEvents('owner-1', '2026-09-01', '2026-09-30');

      const arg = mockDynamoDB.query.mock.calls[0][0];
      expect(arg.IndexName).toBe(SPEND_EVENTS_OCCURRED_AT_INDEX);
      expect(arg.KeyConditionExpression).toContain('occurredAt BETWEEN');
    });

    it('brackets the end bound so the final day is not silently dropped', async () => {
      await listSpendEvents('owner-1', '2026-09-01', '2026-09-30');

      expect(mockDynamoDB.query.mock.calls[0][0].ExpressionAttributeValues[':end']).toBe('2026-09-30~');
    });

    it('paginates to exhaustion — a truncated page would read as reconciliation drift', async () => {
      const page1 = { Items: [anEvent({ eventId: 'a' })], LastEvaluatedKey: { billingUserId: 'owner-1', eventId: 'a' } };
      const page2 = { Items: [anEvent({ eventId: 'b' })] };
      mockDynamoDB.query
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page1) })
        .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page2) });

      const events = await listSpendEvents('owner-1', '2026-09-01', '2026-09-30');

      expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
      expect(events.map((e) => e.eventId)).toEqual(['a', 'b']);
      expect(mockDynamoDB.query.mock.calls[1][0].ExclusiveStartKey).toEqual(page1.LastEvaluatedKey);
    });
  });

  describe('sumSettledMicroUsd', () => {
    it('counts settled events only — reservations are admission input, not spend', () => {
      const events = [
        anEvent({ eventId: '1', lifecycle: 'settled', costMicroUsd: 100 }),
        anEvent({ eventId: '2', lifecycle: 'reserved', costMicroUsd: 5000 }),
        anEvent({ eventId: '3', lifecycle: 'voided', costMicroUsd: 0 }),
        anEvent({ eventId: '4', lifecycle: 'settled', costMicroUsd: 23 }),
      ];

      expect(sumSettledMicroUsd(events)).toBe(123);
    });

    it('is exact over many small amounts — integer micro-dollars, no float drift', () => {
      const events = Array.from({ length: 10000 }, (_, i) =>
        anEvent({ eventId: `e${i}`, lifecycle: 'settled', costMicroUsd: 1 }),
      );

      expect(sumSettledMicroUsd(events)).toBe(10000);
    });

    it('is 0 for no events', () => {
      expect(sumSettledMicroUsd([])).toBe(0);
    });
  });

  describe('getSpendEvent', () => {
    it('returns null when the event does not exist', async () => {
      await expect(getSpendEvent('owner-1', 'nope')).resolves.toBeNull();
    });

    it('reads by the composite key', async () => {
      mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: anEvent() }) });

      const found = await getSpendEvent('owner-1', 'evt-1');

      expect(mockDynamoDB.get.mock.calls[0][0].Key).toEqual({ billingUserId: 'owner-1', eventId: 'evt-1' });
      expect(found?.eventId).toBe('evt-1');
    });
  });
});

// ── ENG-1841: the bounded read ──────────────────────────────────────────────
describe('listSpendEventsBounded (ENG-1841)', () => {
  const page = (n: number, from: number, last: boolean) => ({
    promise: () =>
      Promise.resolve({
        Items: Array.from({ length: n }, (_, i) => ({ eventId: `e${from + i}` })),
        ...(last ? {} : { LastEvaluatedKey: { k: from + n } }),
      }),
  });

  beforeEach(() => jest.clearAllMocks());

  it('pages to the end and reports not exceeded when the range fits', async () => {
    mockDynamoDB.query.mockReturnValueOnce(page(3, 0, false)).mockReturnValueOnce(page(2, 3, true));

    const { events, exceeded } = await listSpendEventsBounded('owner-1', '2026-09-01', '2026-09-31', 10);

    expect(exceeded).toBe(false);
    expect(events).toHaveLength(5);
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
  });

  it('stops paging as soon as it holds more than the ceiling, and says so', async () => {
    mockDynamoDB.query
      .mockReturnValueOnce(page(6, 0, false))
      .mockReturnValueOnce(page(6, 6, false))
      .mockReturnValueOnce(page(6, 12, true));

    const { exceeded } = await listSpendEventsBounded('owner-1', '2026-09-01', '2026-09-31', 10);

    expect(exceeded).toBe(true);
    // Bounded work: the third page is never requested.
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
  });

  it('an exactly-at-ceiling range is not exceeded', async () => {
    mockDynamoDB.query.mockReturnValueOnce(page(10, 0, true));

    await expect(listSpendEventsBounded('owner-1', '2026-09-01', '2026-09-31', 10)).resolves.toMatchObject({ exceeded: false });
  });
});

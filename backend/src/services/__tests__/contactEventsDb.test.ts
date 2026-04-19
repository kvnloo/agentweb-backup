// @ts-nocheck
/**
 * Tests for contactEventsDb (A3 — CRM Unification v1).
 *
 * The service is thin, so tests focus on:
 * - Idempotency: same sourceRecordId never writes twice
 * - Append-only: no delete/update helpers exposed
 * - contactId normalisation: email keys lowercased + trimmed
 * - Query shape: chronological, filterable by time range, filterable by dealId
 */

jest.mock('aws-sdk', () => {
  const mockDocClient = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    scan: jest.fn(),
    batchWrite: jest.fn(),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import {
  contactEventsDb,
  normalizeContactId,
  LogEventInput,
  ContactEvent,
} from '../contactEventsDb';

// Grab the shared mock client instance the service was constructed with.
const mockClient: any = new (AWS as any).DynamoDB.DocumentClient();

const promisifyOk = (data: unknown) => ({ promise: () => Promise.resolve(data) });
const promisifyErr = (err: unknown) => ({ promise: () => Promise.reject(err) });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('normalizeContactId', () => {
  it('lowercases email addresses', () => {
    expect(normalizeContactId('Foo@Example.COM')).toBe('foo@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContactId('  foo@example.com  ')).toBe('foo@example.com');
  });

  it('preserves the nocontact fallback shape', () => {
    expect(normalizeContactId('nocontact:lead_123')).toBe('nocontact:lead_123');
  });
});

describe('contactEventsDb.logEvent', () => {
  const baseInput: LogEventInput = {
    contactId: 'user@example.com',
    source: 'signup',
    eventType: 'contact.created',
    sourceRecordId: 'user-abc123',
    payload: { signupDate: '2026-04-14' },
  };

  it('writes a new event when sourceRecordId has not been seen', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));
    mockClient.put.mockReturnValueOnce(promisifyOk({}));

    const result = await contactEventsDb.logEvent(baseInput);

    expect(result.deduplicated).toBe(false);
    expect(result.event.contactId).toBe('user@example.com');
    expect(result.event.sourceRecordId).toBe('user-abc123');
    expect(result.event.eventId).toMatch(/^evt_\d+_[a-z0-9]+$/);
    expect(mockClient.put).toHaveBeenCalledTimes(1);
    const putCall = mockClient.put.mock.calls[0][0];
    expect(putCall.TableName).toMatch(/AW-ContactEvents$/);
    // Condition expression guards against racing writers.
    expect(putCall.ConditionExpression).toContain('attribute_not_exists');
  });

  it('deduplicates replays of the same sourceRecordId', async () => {
    const existing: ContactEvent = {
      contactId: 'user@example.com',
      eventTimestamp: '2026-04-13T00:00:00.000Z',
      eventId: 'evt_existing',
      source: 'signup',
      eventType: 'contact.created',
      payload: {},
      sourceRecordId: 'user-abc123',
      createdAt: '2026-04-13T00:00:00.000Z',
    };
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [existing] }));

    const result = await contactEventsDb.logEvent(baseInput);

    expect(result.deduplicated).toBe(true);
    expect(result.event).toEqual(existing);
    expect(mockClient.put).not.toHaveBeenCalled();
  });

  it('lowercases the contactId before persisting', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));
    mockClient.put.mockReturnValueOnce(promisifyOk({}));

    const result = await contactEventsDb.logEvent({
      ...baseInput,
      contactId: 'User@Example.COM',
      sourceRecordId: 'user-mixedcase',
    });

    expect(result.event.contactId).toBe('user@example.com');
    expect(mockClient.put.mock.calls[0][0].Item.contactId).toBe('user@example.com');
  });

  it('throws when contactId is missing', async () => {
    await expect(
      contactEventsDb.logEvent({ ...baseInput, contactId: '' })
    ).rejects.toThrow('contactId');
  });

  it('throws when sourceRecordId is missing', async () => {
    await expect(
      contactEventsDb.logEvent({ ...baseInput, sourceRecordId: '' })
    ).rejects.toThrow('sourceRecordId');
  });

  it('tags events with dealId when provided', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));
    mockClient.put.mockReturnValueOnce(promisifyOk({}));

    const result = await contactEventsDb.logEvent({
      ...baseInput,
      sourceRecordId: 'user-deal-xyz',
      dealId: 'deal_123',
    });

    expect(result.event.dealId).toBe('deal_123');
    expect(mockClient.put.mock.calls[0][0].Item.dealId).toBe('deal_123');
  });

  it('omits dealId entirely when not provided (no empty-string GSI trap)', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));
    mockClient.put.mockReturnValueOnce(promisifyOk({}));

    await contactEventsDb.logEvent({ ...baseInput, sourceRecordId: 'no-deal' });

    const putItem = mockClient.put.mock.calls[0][0].Item;
    expect('dealId' in putItem).toBe(false);
  });
});

describe('contactEventsDb.isEventProcessed', () => {
  it('returns true when an event with sourceRecordId exists', async () => {
    mockClient.query.mockReturnValueOnce(
      promisifyOk({
        Items: [{ contactId: 'a@b.com', sourceRecordId: 'sri-1' }],
      })
    );

    const processed = await contactEventsDb.isEventProcessed('sri-1');
    expect(processed).toBe(true);
  });

  it('returns false when no event with sourceRecordId exists', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));

    const processed = await contactEventsDb.isEventProcessed('sri-unknown');
    expect(processed).toBe(false);
  });
});

describe('contactEventsDb.getEventsForContact', () => {
  const contactId = 'user@example.com';
  const sampleEvents: ContactEvent[] = [
    {
      contactId,
      eventTimestamp: '2026-04-14T10:00:00.000Z',
      eventId: 'evt_1',
      source: 'signup',
      eventType: 'contact.created',
      payload: {},
      sourceRecordId: 'sri-1',
      createdAt: '2026-04-14T10:00:00.000Z',
    },
    {
      contactId,
      eventTimestamp: '2026-04-14T11:00:00.000Z',
      eventId: 'evt_2',
      source: 'stripe',
      eventType: 'payment.subscribed',
      payload: { amount: 4900 },
      sourceRecordId: 'sri-2',
      createdAt: '2026-04-14T11:00:00.000Z',
    },
  ];

  it('queries the base table with a contactId key condition', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: sampleEvents }));

    const events = await contactEventsDb.getEventsForContact(contactId);
    expect(events).toEqual(sampleEvents);

    const queryCall = mockClient.query.mock.calls[0][0];
    expect(queryCall.KeyConditionExpression).toContain('contactId = :cid');
    expect(queryCall.ExpressionAttributeValues[':cid']).toBe(contactId);
    // Default is newest-first.
    expect(queryCall.ScanIndexForward).toBe(false);
  });

  it('normalises the contactId before querying', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));

    await contactEventsDb.getEventsForContact('USER@Example.com');
    expect(mockClient.query.mock.calls[0][0].ExpressionAttributeValues[':cid']).toBe(
      'user@example.com'
    );
  });

  it('filters by a start/end time range when both are provided', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));

    await contactEventsDb.getEventsForContact(contactId, {
      startTime: '2026-04-14T00:00:00.000Z',
      endTime: '2026-04-15T00:00:00.000Z',
    });

    const queryCall = mockClient.query.mock.calls[0][0];
    expect(queryCall.KeyConditionExpression).toContain('BETWEEN');
  });

  it('supports ascending order when requested', async () => {
    mockClient.query.mockReturnValueOnce(promisifyOk({ Items: [] }));

    await contactEventsDb.getEventsForContact(contactId, { ascending: true });
    expect(mockClient.query.mock.calls[0][0].ScanIndexForward).toBe(true);
  });
});

describe('contactEventsDb.getEventsForDeal', () => {
  it('scans with a dealId filter', async () => {
    mockClient.scan.mockReturnValueOnce(promisifyOk({ Items: [] }));

    await contactEventsDb.getEventsForDeal('deal_abc');

    const scanCall = mockClient.scan.mock.calls[0][0];
    expect(scanCall.FilterExpression).toBe('dealId = :did');
    expect(scanCall.ExpressionAttributeValues[':did']).toBe('deal_abc');
  });
});

describe('contactEventsDb — append-only surface', () => {
  it('does not expose delete or update helpers', () => {
    expect((contactEventsDb as any).delete).toBeUndefined();
    expect((contactEventsDb as any).deleteEvent).toBeUndefined();
    expect((contactEventsDb as any).update).toBeUndefined();
    expect((contactEventsDb as any).updateEvent).toBeUndefined();
  });
});

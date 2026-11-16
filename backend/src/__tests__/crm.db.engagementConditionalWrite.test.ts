/** ENG-3052: edit/delete of a lead engagement must not write a stale array. Mocks only. */
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

// Mock emailEventsDb and resendService before importing db.ts
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

// contactEventsDb is called from createLead when attribution is captured.
const mockLogEvent = jest.fn().mockResolvedValue({ event: {}, deduplicated: false });
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: {
    logEvent: (...args: any[]) => mockLogEvent(...args),
  },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

import { crmDb } from '../services/db';

const listId = 'L1';
const leadId = 'LD1';
const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:00:05.000Z';
const e1 = { eventId: 'e1', eventType: 'custom.note', eventData: {}, createdAt: T0 };
const e2 = { eventId: 'e2', eventType: 'custom.call', eventData: {}, createdAt: T0 };
const appended = { eventId: 'e3', eventType: 'custom.linkedin_invite_sent', eventData: {}, createdAt: T1 };
const edit = { eventType: 'custom.note', eventData: { notes: 'edited' }, createdAt: T0 };

const condFail = () => Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });

/** Queue successive getLeadById reads and update outcomes. */
function arrange(reads: any[], updates: Array<'ok' | 'race' | Error>) {
  const get = mockDocumentClientMethods.get;
  get.mockReset();
  reads.forEach((item) => get.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({ Item: item }) }));
  get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: reads[reads.length - 1] }) });
  const update = mockDocumentClientMethods.update;
  update.mockReset();
  update.mockImplementation((params: any) => ({
    promise: jest.fn().mockImplementation(async () => {
      const outcome = updates.shift() ?? 'ok';
      if (outcome === 'race') throw condFail();
      if (outcome instanceof Error) throw outcome;
      return { Attributes: { listId, leadId, engagements: params.ExpressionAttributeValues[':engagements'] } };
    }),
  }));
  return update;
}
const sentParams = (update: jest.Mock, call: number) => update.mock.calls[call][0];

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each([
  ['deleteLeadEngagement', () => crmDb.deleteLeadEngagement(listId, leadId, 'e1'), ['e2', 'e3']],
  ['updateLeadEngagement', () => crmDb.updateLeadEngagement(listId, leadId, 'e1', edit), ['e1', 'e2', 'e3']],
])('%s under a concurrent append (ENG-3052)', (_name, run, survivorIds) => {
  it('AC1: the write is conditioned on what was read', async () => {
    const update = arrange([{ listId, leadId, updatedAt: T0, engagements: [e1, e2] }], ['ok']);
    await run();
    const p = sentParams(update, 0);
    expect(p.ConditionExpression).toContain('attribute_exists(leadId)');
    expect(p.ConditionExpression).toContain('updatedAt = :expectedUpdatedAt');
    expect(p.ConditionExpression).toContain('size(engagements) = :expectedCount');
    expect(p.ExpressionAttributeValues[':expectedUpdatedAt']).toBe(T0);
    expect(p.ExpressionAttributeValues[':expectedCount']).toBe(2);
    expect(p.ExpressionAttributeValues[':updatedAt'] > T0).toBe(true);
  });

  it('AC1: an engagement appended between read and write survives', async () => {
    const update = arrange(
      [
        { listId, leadId, updatedAt: T0, engagements: [e1, e2] },
        { listId, leadId, updatedAt: T1, engagements: [e1, e2, appended] },
      ],
      ['race', 'ok'],
    );
    const result: any = await run();
    expect(update).toHaveBeenCalledTimes(2);
    const written = sentParams(update, 1).ExpressionAttributeValues[':engagements'];
    expect(written.map((e: any) => e.eventId)).toEqual(survivorIds);
    expect(sentParams(update, 1).ExpressionAttributeValues[':expectedUpdatedAt']).toBe(T1);
    expect(result.engagements.map((e: any) => e.eventId)).toEqual(survivorIds);
  });

  it('AC1: a race that never settles fails with preconditionFailed and stops retrying', async () => {
    const update = arrange([{ listId, leadId, updatedAt: T0, engagements: [e1, e2] }], ['race', 'race', 'race', 'race', 'race']);
    await expect(run()).rejects.toMatchObject({ preconditionFailed: true });
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('AC2: no concurrent change means one read-modify-write, same array as before', async () => {
    const update = arrange([{ listId, leadId, updatedAt: T0, engagements: [e1, e2] }], ['ok']);
    await run();
    expect(update).toHaveBeenCalledTimes(1);
    expect(sentParams(update, 0).UpdateExpression).toBe('SET engagements = :engagements, isEngaged = :isEngaged, updatedAt = :updatedAt');
  });

  it('a lead row with no updatedAt is still writable', async () => {
    const update = arrange([{ listId, leadId, engagements: [e1, e2] }], ['ok']);
    await run();
    const p = sentParams(update, 0);
    expect(p.ConditionExpression).toContain('attribute_not_exists(updatedAt)');
    expect(p.ExpressionAttributeValues[':expectedUpdatedAt']).toBeUndefined();
  });

  it('missing lead and missing engagement keep their messages', async () => {
    arrange([undefined], []);
    await expect(run()).rejects.toThrow('Lead not found');
    arrange([{ listId, leadId, updatedAt: T0, engagements: [e2] }], []);
    await expect(run()).rejects.toThrow('Engagement not found');
  });

  it('a non-conditional DynamoDB error is not retried', async () => {
    const boom = Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' });
    const update = arrange([{ listId, leadId, updatedAt: T0, engagements: [e1, e2] }], [boom]);
    await expect(run()).rejects.toThrow('throttled');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

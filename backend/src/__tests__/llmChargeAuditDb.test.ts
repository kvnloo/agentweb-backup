const put = jest.fn();
const query = jest.fn();
jest.mock('aws-sdk', () => ({ DynamoDB: { DocumentClient: jest.fn(() => ({ put, query })) } }));

import { recordLlmChargeEvent, listLlmChargeEvents } from '../services/llmChargeAuditDb';

const event = { billingUserId: 'bill-1', eventId: '2026-08-15T12:00:00.000Z#one', occurredAt: '2026-08-15T12:00:00.000Z', actingUserId: 'member-1', tokens: 10, costMicroUsd: 42, counterAppliedAt: '2026-08-15T12:00:01.000Z' };

describe('llmChargeAuditDb', () => {
  beforeEach(() => { put.mockReset(); query.mockReset(); });
  it('writes a conditional append-only charge event', async () => {
    put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await expect(recordLlmChargeEvent(event)).resolves.toBe(true);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ Item: expect.objectContaining(event), ConditionExpression: expect.stringContaining('attribute_not_exists') }));
  });
  it('makes a replay a no-op', async () => {
    put.mockReturnValue({ promise: jest.fn().mockRejectedValue({ code: 'ConditionalCheckFailedException' }) });
    await expect(recordLlmChargeEvent(event)).resolves.toBe(false);
  });
  it('does not hide storage failures', async () => {
    put.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('down')) });
    await expect(recordLlmChargeEvent(event)).rejects.toThrow('down');
  });
  it('queries one billing subject by chronological event key', async () => {
    query.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [event] }) });
    await expect(listLlmChargeEvents('bill-1', '2026-08-01', '2026-08-31')).resolves.toEqual([event]);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ KeyConditionExpression: expect.stringContaining('eventId BETWEEN') }));
  });
  it('does not surface an audit intent that never reached the counter', async () => {
    query.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [{ ...event, counterAppliedAt: undefined }] }) });
    await expect(listLlmChargeEvents('bill-1', '2026-08-01', '2026-08-31')).resolves.toEqual([]);
  });

  it('follows LastEvaluatedKey past a single DynamoDB query page (Greptile P1, fixed in 690f7597d)', async () => {
    const page1Event = { ...event, eventId: '2026-08-01T00:00:00.000Z#a' };
    const page2Event = { ...event, eventId: '2026-08-15T00:00:00.000Z#b' };
    query
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [page1Event],
          LastEvaluatedKey: { billingUserId: 'bill-1', eventId: page1Event.eventId },
        }),
      })
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [page2Event] }),
      });

    const result = await listLlmChargeEvents('bill-1', '2026-08-01', '2026-08-31');

    expect(query).toHaveBeenCalledTimes(2);
    // The second query resumes from exactly the key the first page returned.
    expect(query.mock.calls[1][0]).toMatchObject({
      ExclusiveStartKey: { billingUserId: 'bill-1', eventId: page1Event.eventId },
    });
    expect(result).toEqual([page1Event, page2Event]);
  });
});

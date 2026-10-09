// ENG-2308: userDb.updateUser can replace single elements of a list attribute
// in place, so two writers touching different elements never overwrite each
// other (a full-list read-modify-write cannot guarantee that).

jest.mock('aws-sdk', () => {
  const mockDynamoDB = { get: jest.fn(), query: jest.fn(), update: jest.fn() };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import { userDb } from '../services/db';

describe('userDb.updateUser elementSets', () => {
  let ddb: any;

  beforeEach(() => {
    jest.clearAllMocks();
    ddb = new (AWS.DynamoDB.DocumentClient as any)();
    ddb.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [{ userId: 'u1', email: 'u1@example.com' }] }),
    });
    ddb.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'u1' } }) });
  });

  it('builds a list-element SET alongside ordinary field SETs and the caller condition', async () => {
    await userDb.updateUser('u1', { icpStatus: 'ready' } as any, {
      elementSets: [{ path: ['icpResult'], index: 3, value: { id: 'x' } }],
      condition: {
        expression: '#icpResult[3].#cid = :cid',
        names: { '#icpResult': 'icpResult', '#cid': 'id' },
        values: { ':cid': 'x' },
      },
    });

    const p = ddb.update.mock.calls[0][0];
    expect(p.UpdateExpression).toBe('SET #icpStatus = :icpStatus, #el0p0[3] = :el0');
    expect(p.ConditionExpression).toBe('#icpResult[3].#cid = :cid');
    expect(p.ExpressionAttributeNames).toEqual({
      '#icpStatus': 'icpStatus',
      '#el0p0': 'icpResult',
      '#icpResult': 'icpResult',
      '#cid': 'id',
    });
    expect(p.ExpressionAttributeValues).toEqual({ ':icpStatus': 'ready', ':el0': { id: 'x' }, ':cid': 'x' });
  });

  it('supports a nested list path and several elements in one write', async () => {
    await userDb.updateUser('u1', {} as any, {
      elementSets: [
        { path: ['competitorResult', 'per_icp'], index: 0, value: 'a' },
        { path: ['competitorResult', 'per_icp'], index: 2, value: 'b' },
      ],
    });
    const p = ddb.update.mock.calls[0][0];
    expect(p.UpdateExpression).toBe('SET #el0p0.#el0p1[0] = :el0, #el1p0.#el1p1[2] = :el1');
    expect(p.ExpressionAttributeNames['#el1p1']).toBe('per_icp');
  });

  it('does nothing when there are neither fields nor elements to write', async () => {
    await userDb.updateUser('u1', {} as any, { elementSets: [] });
    expect(ddb.update).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN])('rejects a non-integer or negative index (%s) before touching DynamoDB', async (index) => {
    await expect(
      userDb.updateUser('u1', {} as any, { elementSets: [{ path: ['icpResult'], index: index as number, value: 1 }] }),
    ).rejects.toThrow(/index must be a non-negative integer/);
    expect(ddb.update).not.toHaveBeenCalled();
  });
});

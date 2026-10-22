// userDb.updateUser can set or remove a single value at a document path
// (`icpResult[2].pain`, `icpResult[2]`), so a write touches only what it means to
// change and its condition only has to assert what that write depends on.

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

describe('userDb.updateUser pathSets / pathRemoves', () => {
  let ddb: any;

  beforeEach(() => {
    jest.clearAllMocks();
    ddb = new (AWS.DynamoDB.DocumentClient as any)();
    ddb.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [{ userId: 'u1', email: 'u1@example.com' }] }),
    });
    ddb.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'u1' } }) });
  });

  it('sets a value inside a list element and keeps the caller condition and names separate', async () => {
    await userDb.updateUser('u1', {} as any, {
      pathSets: [
        { path: ['icpResult', 2, 'pain'], value: 'new pain' },
        { path: ['icpResult', 2, 'userIntent', 'pain'], value: 'new pain' },
      ],
      condition: {
        expression: '#cl[2].#cid = :cid',
        names: { '#cl': 'icpResult', '#cid': 'id' },
        values: { ':cid': 'icp_x' },
      },
    });

    const p = ddb.update.mock.calls[0][0];
    expect(p.UpdateExpression).toBe('SET #ps0p0[2].#ps0p2 = :ps0, #ps1p0[2].#ps1p2.#ps1p3 = :ps1');
    expect(p.ExpressionAttributeNames).toEqual({
      '#ps0p0': 'icpResult',
      '#ps0p2': 'pain',
      '#ps1p0': 'icpResult',
      '#ps1p2': 'userIntent',
      '#ps1p3': 'pain',
      '#cl': 'icpResult',
      '#cid': 'id',
    });
    expect(p.ExpressionAttributeValues).toEqual({ ':ps0': 'new pain', ':ps1': 'new pain', ':cid': 'icp_x' });
    expect(p.ConditionExpression).toBe('#cl[2].#cid = :cid');
  });

  it('removes a list element', async () => {
    await userDb.updateUser('u1', {} as any, { pathRemoves: [{ path: ['icpResult', 1] }] });
    const p = ddb.update.mock.calls[0][0];
    expect(p.UpdateExpression).toBe('REMOVE #pr0p0[1]');
    expect(p.ExpressionAttributeNames).toEqual({ '#pr0p0': 'icpResult' });
    expect(p.ExpressionAttributeValues).toBeUndefined();
  });

  it('combines ordinary fields, path sets and path removes in one expression', async () => {
    await userDb.updateUser('u1', { icpStatus: 'ready' } as any, {
      pathSets: [{ path: ['icpResult', 0, 'name'], value: 'n' }],
      pathRemoves: [{ path: ['icpResult', 3] }],
    });
    expect(ddb.update.mock.calls[0][0].UpdateExpression).toBe('SET #icpStatus = :icpStatus, #ps0p0[0].#ps0p2 = :ps0 REMOVE #pr0p0[3]');
  });

  it('writes nothing, and does not call DynamoDB, when there is nothing to do', async () => {
    await userDb.updateUser('u1', {} as any, { pathSets: [], pathRemoves: [] });
    expect(ddb.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a path that does not start with an attribute name', [0, 'x']],
    ['an empty path', []],
    ['a negative index', ['icpResult', -1]],
    ['a fractional index', ['icpResult', 1.5]],
    ['an empty segment', ['icpResult', '', 'x']],
  ])('rejects %s before touching DynamoDB', async (_label, path) => {
    await expect(userDb.updateUser('u1', {} as any, { pathSets: [{ path: path as any, value: 1 }] })).rejects.toThrow(/updateUser ps\[0\]/);
    await expect(userDb.updateUser('u1', {} as any, { pathRemoves: [{ path: path as any }] })).rejects.toThrow(/updateUser pr\[0\]/);
    expect(ddb.update).not.toHaveBeenCalled();
  });
});

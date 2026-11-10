jest.mock('aws-sdk', () => {
  const client = { put: jest.fn(), update: jest.fn(), scan: jest.fn() };
  return { DynamoDB: { DocumentClient: jest.fn(() => client) }, S3: jest.fn(), config: { update: jest.fn() } };
});
jest.mock('../services/zomaActivationEvents', () => ({ emitActivationSignup: jest.fn().mockResolvedValue(undefined) }));
import AWS from 'aws-sdk';
import { userDb } from '../services/db';
import { emitActivationSignup } from '../services/zomaActivationEvents';
const client = new AWS.DynamoDB.DocumentClient();
const update = client.update as jest.Mock;
const scan = client.scan as jest.Mock;
const put = client.put as jest.Mock;
const user = { userId: 'u1', email: 'u@b.co' };
const event = { userId: 'u1', timestamp: '2026-11-09T00:00:00Z' };
beforeEach(() => {
  jest.clearAllMocks();
  update.mockReturnValue({ promise: async () => ({}) });
  put.mockReturnValue({ promise: async () => ({}) });
});
it('uses owner-bound conditional nested write so workers/retries cannot overwrite first event', async () => {
  expect(await userDb.recordZomaActivationEvent(user, 'signed_up' as any, event)).toBe(true);
  expect(update.mock.calls[0][0]).toMatchObject({ Key: { email: user.email }, ConditionExpression: 'userId = :userId', UpdateExpression: 'SET #events = if_not_exists(#events, :empty)' });
  expect(update.mock.calls[1][0]).toMatchObject({
    TableName: expect.stringMatching(/AW-Users$/), Key: { email: user.email },
    UpdateExpression: 'SET #events.#stage = :event',
    ConditionExpression: 'userId = :userId AND attribute_not_exists(#events.#stage)',
    ExpressionAttributeNames: { '#events': 'zomaActivationEvents', '#stage': 'signed_up' },
    ExpressionAttributeValues: { ':event': event, ':userId': user.userId },
  });
});
it('a conditional race loser is a no-op', async () => {
  update.mockReturnValueOnce({ promise: async () => ({}) }).mockReturnValueOnce({ promise: async () => { throw { code: 'ConditionalCheckFailedException' }; } });
  expect(await userDb.recordZomaActivationEvent(user, 'signed_up' as any, event)).toBe(false);
});
it('initialization cannot recreate a deleted/replaced user', async () => {
  update.mockReturnValueOnce({ promise: async () => { throw { code: 'ConditionalCheckFailedException' }; } });
  await expect(userDb.recordZomaActivationEvent(user, 'signed_up' as any, event)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
  expect(update).toHaveBeenCalledTimes(1);
});
it('report uses bounded projection and exact pagination without private user fields', async () => {
  scan.mockReturnValue({ promise: async () => ({ Items: [user, { userId: 'deleted_u2' }, { userId: 'eval_fixture' }], LastEvaluatedKey: { email: 'last@b.co' } }) });
  const result = await userDb.listZomaActivationUsers({ email: 'previous@b.co' });
  expect(scan.mock.calls[0][0]).toMatchObject({ Limit: 250, ProjectionExpression: 'userId, email, createdAt, zomaActivationEvents', ExclusiveStartKey: { email: 'previous@b.co' } });
  expect(result).toEqual({ users: [user], cursor: { email: 'last@b.co' } });
});
it('persisted account creation wires signup; a failed put never emits signup', async () => {
  await userDb.createUser('new@b.co', 'new', 'hash');
  await new Promise(resolve => setImmediate(resolve));
  expect(emitActivationSignup).toHaveBeenCalledWith('new', 'new@b.co', expect.any(String));
  (emitActivationSignup as jest.Mock).mockClear();
  put.mockReturnValueOnce({ promise: async () => { throw new Error('offline'); } });
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  await userDb.createUser('bad@b.co', 'bad', 'hash').catch(() => undefined);
  expect(emitActivationSignup).not.toHaveBeenCalled();
  log.mockRestore();
});

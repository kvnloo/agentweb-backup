import AWS from 'aws-sdk';
jest.mock('aws-sdk', () => {
  const client = { put: jest.fn(), delete: jest.fn() };
  return { DynamoDB: { DocumentClient: jest.fn(() => client) }, S3: jest.fn(), config: { update: jest.fn() } };
});
import { oauthSessionDb } from '../services/db';
const client = new AWS.DynamoDB.DocumentClient();
const put = client.put as jest.Mock;
const remove = client.delete as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  put.mockReturnValue({ promise: async () => ({}) });
  remove.mockReturnValue({ promise: async () => ({}) });
});
afterEach(() => jest.restoreAllMocks());

it('writes the existing table with its existing random session key and ten-minute TTL', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1000000);
  const session = { sessionId: 'random-secret', userId: 'user', provider: 'fathom' as const, payload: { tokens: {} } };
  await oauthSessionDb.save(session);
  expect(put).toHaveBeenCalledWith({ TableName: expect.stringMatching(/AW-OAuthSessions$/), Item: { ...session, ttl: 1600 } });
});
it('retains the Meta save attributes', async () => {
  const session = { sessionId: 'meta-secret', userId: 'user', access_token: 'access', scopes: ['ads'], flow: 'meta' };
  await oauthSessionDb.save(session);
  expect(put.mock.calls[0][0].Item).toEqual({ ...session, ttl: expect.any(Number) });
});
it('consumes in a single conditional delete bound to owner, provider, and live TTL', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1000000);
  const attributes = { sessionId: 'secret', userId: 'user', provider: 'fathom', payload: {} };
  remove.mockReturnValue({ promise: async () => ({ Attributes: attributes }) });
  expect(await oauthSessionDb.consume('secret', 'user', 'fathom')).toEqual(attributes);
  expect(remove).toHaveBeenCalledWith({
    TableName: expect.stringMatching(/AW-OAuthSessions$/), Key: { sessionId: 'secret' },
    ConditionExpression: 'userId = :userId AND #provider = :provider AND #ttl > :now',
    ExpressionAttributeNames: { '#provider': 'provider', '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':userId': 'user', ':provider': 'fathom', ':now': 1000 }, ReturnValues: 'ALL_OLD',
  });
});
it('returns null on a conditional failure (missing, consumed, expired, or wrong binding)', async () => {
  remove.mockReturnValue({ promise: async () => { throw { code: 'ConditionalCheckFailedException' }; } });
  expect(await oauthSessionDb.consume('secret', 'user', 'fathom')).toBeNull();
});
it.each(['save', 'consume'])('logs and propagates %s infrastructure failures', async operation => {
  const error = new Error('unavailable');
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  (operation === 'save' ? put : remove).mockReturnValue({ promise: async () => { throw error; } });
  const call = operation === 'save'
    ? oauthSessionDb.save({ sessionId: 'secret', userId: 'user', provider: 'fathom', payload: {} })
    : oauthSessionDb.consume('secret', 'user', 'fathom');
  await expect(call).rejects.toBe(error);
  expect(log).toHaveBeenCalled();
});

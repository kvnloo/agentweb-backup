const get = jest.fn();
const query = jest.fn();
const client = jest.fn((_options: unknown) => ({ get, query }));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: function(options: unknown) { return client(options); } } } }));
import { notificationLookup } from '../services/leadNotificationLookup';
const clientOptions = client.mock.calls[0][0];
const signal = () => new AbortController().signal;
const request = (result: unknown) => ({ promise: jest.fn().mockResolvedValue(result), abort: jest.fn() });
beforeEach(() => { get.mockReset(); query.mockReset(); });

it('gets page IDs directly without any owner pagination', async () => {
  get.mockReturnValue(request({ Item: { id: 'page', userId: 'owner' } }));
  expect(await notificationLookup.pages('owner', 'page', signal())).toEqual([{ id: 'page', userId: 'owner' }]);
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ Key: { id: 'page' } }));
  expect(query).not.toHaveBeenCalled();
});
it('caps owner URL searches and refuses partial results without following the cursor', async () => {
  query.mockReturnValue(request({ Items: [{ id: 'page' }], LastEvaluatedKey: { id: 'more' } }));
  expect(await notificationLookup.pages('owner', '', signal())).toEqual([]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ Limit: 25, IndexName: 'UserIdIndex',
    KeyConditionExpression: 'userId = :owner', ExpressionAttributeValues: { ':owner': 'owner' } }));
});
it('caps campaign work at one owner/date query and exposes truncation', async () => {
  query.mockReturnValue(request({ Items: [], LastEvaluatedKey: { id: 'more' } }));
  expect(await notificationLookup.campaigns('owner', '2026-09-01', '2026-09-24', signal())).toMatchObject({ truncated: true });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ Limit: 100,
    ExpressionAttributeValues: { ':owner': 'owner', ':since': '2026-09-01', ':until': '2026-09-24' } }));
});
it.each(['pages', 'campaigns'])('aborts an in-flight %s SDK request and never retries or paginates', async method => {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const pending = new Promise((_, fail) => { reject = fail; });
  const abort = jest.fn(() => reject(new Error('aborted')));
  get.mockReturnValue({ promise: () => pending, abort });
  query.mockReturnValue({ promise: () => pending, abort });
  const work = method === 'pages' ? notificationLookup.pages('owner', 'page', controller.signal) :
    notificationLookup.campaigns('owner', '2026-09-01', '2026-09-24', controller.signal);
  const assertion = expect(work).rejects.toThrow('aborted');
  controller.abort();
  await assertion;
  expect(abort).toHaveBeenCalledTimes(1);
  expect(get.mock.calls.length + query.mock.calls.length).toBe(1);
  expect(clientOptions).toMatchObject({ maxRetries: 0, httpOptions: { timeout: 2000, connectTimeout: 2000 } });
});
it('starts no request after the deadline', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(notificationLookup.pages('owner', '', controller.signal)).rejects.toThrow();
  await expect(notificationLookup.campaigns('owner', '', '', controller.signal)).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

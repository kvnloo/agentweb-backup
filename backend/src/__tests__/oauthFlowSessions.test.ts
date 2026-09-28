import { createOAuthSessionDbMock } from './fixtures/oauthSessionDb';
const mockDb = createOAuthSessionDbMock();
jest.mock('../services/db', () => ({ oauthSessionDb: mockDb }));
import { consumeOAuthFlowSession, storeOAuthFlowSession } from '../services/oauthFlowSessions';

const session = () => ({ userId: 'user', expires: Date.now() + 600000, tokens: { access_token: 'access', expires_in: 3600 } });
beforeEach(() => { mockDb.rows.clear(); jest.clearAllMocks(); });

it('consumes a legacy Map-only session once after the Dynamo miss', async () => {
  const payload = session();
  const local = new Map([['old-random-secret', payload]]);
  expect(await consumeOAuthFlowSession('fathom', local, 'old-random-secret', 'user')).toEqual(payload);
  expect(mockDb.consume).toHaveBeenCalledWith('old-random-secret', 'user', 'fathom');
  expect(await consumeOAuthFlowSession('fathom', local, 'old-random-secret', 'user')).toBeNull();
});
it('rejects an expired legacy session', async () => {
  const local = new Map([['secret', { ...session(), expires: Date.now() }]]);
  expect(await consumeOAuthFlowSession('fathom', local, 'secret', 'user')).toBeNull();
});
it('does not burn a legacy session on a wrong-user attempt', async () => {
  const local = new Map([['secret', session()]]);
  expect(await consumeOAuthFlowSession('fathom', local, 'secret', 'other')).toBeNull();
  expect(await consumeOAuthFlowSession('fathom', local, 'secret', 'user')).not.toBeNull();
});
it('dual writes the local shadow only after Dynamo succeeds', async () => {
  const local = new Map();
  const payload = session();
  const id = await storeOAuthFlowSession('fathom', local, payload);
  expect(mockDb.rows.get(id)).toMatchObject({ provider: 'fathom', userId: 'user', payload });
  expect(local.get(id)).toEqual({ ...payload, persisted: true });
});
it('does not leave a local session when Dynamo write fails', async () => {
  const local = new Map();
  mockDb.save.mockRejectedValueOnce(new Error('unavailable'));
  await expect(storeOAuthFlowSession('fathom', local, session())).rejects.toThrow('unavailable');
  expect(local.size).toBe(0);
});
it('binds the shared session to its provider', async () => {
  const local = new Map();
  const id = await storeOAuthFlowSession('fathom', local, session());
  expect(await consumeOAuthFlowSession('hubspot', new Map(), id, 'user')).toBeNull();
  expect(await consumeOAuthFlowSession('fathom', new Map(), id, 'user')).not.toBeNull();
});
it('allows only one concurrent consume across instances', async () => {
  const id = await storeOAuthFlowSession('fathom', new Map(), session());
  const results = await Promise.all([1, 2].map(() => consumeOAuthFlowSession('fathom', new Map(), id, 'user')));
  expect(results.filter(Boolean)).toHaveLength(1);
});

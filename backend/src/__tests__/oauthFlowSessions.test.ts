import { createOAuthSessionDbMock } from './fixtures/oauthSessionDb';
const mockDb = createOAuthSessionDbMock();
jest.mock('../services/db', () => ({ oauthSessionDb: mockDb }));
import { consumeOAuthFlowSession, storeOAuthFlowSession } from '../services/oauthFlowSessions';

const session = () => ({ userId: 'user', expires: Date.now() + 600000, tokens: { access_token: 'access', expires_in: 3600 } });
beforeEach(() => { mockDb.rows.clear(); jest.clearAllMocks(); });

it('finalize on instance A completes connect on instance B, once', async () => {
  const payload = session();
  const id = await storeOAuthFlowSession('fathom', payload);
  expect(mockDb.rows.get(id)).toMatchObject({ provider: 'fathom', userId: 'user', payload });
  expect(await consumeOAuthFlowSession('fathom', id, 'user')).toEqual(payload);
  expect(await consumeOAuthFlowSession('fathom', id, 'user')).toBeNull();
});
it('has no process-local fallback: an unknown id is a miss', async () => {
  expect(await consumeOAuthFlowSession('fathom', 'never-stored', 'user')).toBeNull();
  expect(mockDb.consume).toHaveBeenCalledWith('never-stored', 'user', 'fathom');
});
it('rejects empty or non-string session ids without touching Dynamo', async () => {
  expect(await consumeOAuthFlowSession('fathom', '  ', 'user')).toBeNull();
  expect(await consumeOAuthFlowSession('fathom', 42 as unknown as string, 'user')).toBeNull();
  expect(mockDb.consume).not.toHaveBeenCalled();
});
it('propagates a Dynamo write failure', async () => {
  mockDb.save.mockRejectedValueOnce(new Error('unavailable'));
  await expect(storeOAuthFlowSession('fathom', session())).rejects.toThrow('unavailable');
});
it('binds the shared session to its provider', async () => {
  const id = await storeOAuthFlowSession('fathom', session());
  expect(await consumeOAuthFlowSession('hubspot', id, 'user')).toBeNull();
  expect(await consumeOAuthFlowSession('fathom', id, 'user')).not.toBeNull();
});
it('allows only one concurrent consume across instances', async () => {
  const id = await storeOAuthFlowSession('fathom', session());
  const results = await Promise.all([1, 2].map(() => consumeOAuthFlowSession('fathom', id, 'user')));
  expect(results.filter(Boolean)).toHaveLength(1);
});

jest.mock('../services/db', () => ({ userDb: { getUserByEmail: jest.fn(), updateUser: jest.fn() }, orgDb: {}, oauthSessionDb: { get: jest.fn() } }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: { updateStatus: jest.fn(), getByEmail: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/emailService', () => ({ emailService: {} }));
jest.mock('../services/serverSignalEmitter', () => ({ emitAppSignal: jest.fn() }));
jest.mock('../services/zomaActivationEvents', () => ({ ActivationStage: { AdAccountConnected: 'ad_account_connected' }, emitActivation: jest.fn().mockResolvedValue(true), emitActivationLogin: jest.fn().mockResolvedValue(undefined), emitWaitlistApproval: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/connectedAccountsDb', () => ({ createAccount: jest.fn(), getAccountById: jest.fn() }));
jest.mock('../services/metaConnectionHandoff', () => ({ verifyMetaAdAccountReadBack: jest.fn().mockResolvedValue({ ok: false }), raiseMetaConnectionHandoff: jest.fn() }));
jest.mock('../services/metaService', () => ({ metaService: {} }));
jest.mock('../services/instagramService', () => ({ instagramService: {} }));
jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn().mockResolvedValue(true) }));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn().mockReturnValue('jwt') }));
import { login, googleCallback } from '../controllers/auth';
import { userDb, oauthSessionDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { createAccount } from '../services/connectedAccountsDb';
import { connectMetaAdAccounts } from '../services/metaOAuthFinalize';
import { emitActivation, emitActivationLogin, emitWaitlistApproval } from '../services/zomaActivationEvents';
import waitlistRoutes from '../routes/waitlist';
import bcrypt from 'bcryptjs';
function res() { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; }
const user: any = { userId: 'u1', email: 'u@b.co', roles: ['customer'], isActive: true, isOAuthUser: true };
beforeEach(() => { (userDb.getUserByEmail as jest.Mock).mockResolvedValue({ ...user }); });
it('password success wires login; invalid password does not', async () => {
  await login({ body: { email: user.email, password: 'test' } } as any, res());
  expect(emitActivationLogin).toHaveBeenCalledWith('u1');
  (emitActivationLogin as jest.Mock).mockClear();
  (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
  await login({ body: { email: user.email, password: 'wrong' } } as any, res());
  expect(emitActivationLogin).not.toHaveBeenCalled();
});
it('existing Google OAuth success wires login; absent profile does not', async () => {
  const done = jest.fn();
  await googleCallback({ query: {}, body: {}, headers: {} } as any, 'access', 'refresh', { emails: [{ value: user.email }], id: 'google', displayName: 'U' } as any, done);
  expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ userId: 'u1' }));
  expect(emitActivationLogin).toHaveBeenCalledWith('u1');
  (emitActivationLogin as jest.Mock).mockClear();
  await googleCallback({} as any, '', '', null as any, done);
  expect(emitActivationLogin).not.toHaveBeenCalled();
});
it('Meta connection emits after persistence; failed persistence emits nothing', async () => {
  (oauthSessionDb.get as jest.Mock).mockResolvedValue({ userId: 'u1', access_token: 'token', scopes: [] });
  (createAccount as jest.Mock).mockResolvedValue({ account_name: 'ads', config: {} });
  const input: any = { userId: 'u1', adAccounts: [{ account_id: '111', name: 'ads' }], tokenSessionId: 's1' };
  await connectMetaAdAccounts(input);
  expect(emitActivation).toHaveBeenCalledWith('u1', 'ad_account_connected');
  (emitActivation as jest.Mock).mockClear();
  (createAccount as jest.Mock).mockRejectedValueOnce(new Error('write failed'));
  await expect(connectMetaAdAccounts(input)).rejects.toThrow('write failed');
  expect(emitActivation).not.toHaveBeenCalled();
});
it.each(['invited', 'completed', 'pending'])('waitlist status %s wires approval only on successful approval states', async status => {
  const route = (waitlistRoutes as any).stack.find((s: any) => s.route?.path === '/:email/status').route;
  const handler = route.stack[route.stack.length - 1].handle;
  await handler({ params: { email: user.email }, body: { status } }, res());
  expect((emitWaitlistApproval as jest.Mock).mock.calls).toEqual(status === 'pending' ? [] : [[user.email]]);
});

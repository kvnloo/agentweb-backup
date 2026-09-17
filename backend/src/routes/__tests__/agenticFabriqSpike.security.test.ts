const mockEligible = jest.fn(() => true);
const mockResolve = jest.fn();
const mockInitiate = jest.fn();
const mockEnsure = jest.fn();
const mockList = jest.fn();
jest.mock('../../middleware/auth', () => ({ authenticateToken: jest.fn() }));
jest.mock('../../integrations/agenticFabriq', () => ({
  isUserEligibleForAgenticFabriqSpike: (...args: unknown[]) => (mockEligible as any)(...args),
  getAgenticFabriqAppCredentials: async () => ({ appId: 'app' }),
  agenticFabriqClient: { ensureExternalUser: (...args: unknown[]) => mockEnsure(...args), initiateOAuth: (...args: unknown[]) => mockInitiate(...args), listConnections: (...args: unknown[]) => mockList(...args) },
}));
jest.mock('../../services/emailProviderService', () => ({ bootstrapEmailProviders: async () => undefined, resolveEmailAccount: (...args: unknown[]) => mockResolve(...args) }));
import router from '../agenticFabriqSpike';
import { createPendingConnect, clearPendingConnectsForTest, consumePendingConnect } from '../../integrations/agenticFabriq/pendingConnectStore';
const create = createPendingConnect as (...args: any[]) => Promise<any>;
const consume = consumePendingConnect as (...args: any[]) => Promise<any>;
async function invoke(path: string, query: Record<string, unknown>, userId = 'route-user') {
  const handler = (router as any).stack.find((layer: any) => layer.route?.path === path).route.stack.at(-1).handle;
  const res: any = { statusCode: 200, status: jest.fn(function(this: any, code: number) { this.statusCode = code; return this; }), json: jest.fn(), send: jest.fn() };
  await handler({ query, user: { userId } }, res);
  return res;
}
describe('hostile Fabriq OAuth routes', () => {
  beforeEach(() => { clearPendingConnectsForTest(); jest.clearAllMocks(); mockEligible.mockReturnValue(true); mockResolve.mockResolvedValue({ platform: 'gmail', ownerUserId: 'route-user', accountId: 'mailbox' }); mockInitiate.mockResolvedValue({ oauth_url: 'https://vendor.test/consent' }); });
  it('initiates with read authorization and a random separate state', async () => {
    await invoke('/init', { account_id: 'mailbox' });
    expect(mockResolve).toHaveBeenCalledWith('route-user', 'mailbox', 'read');
    expect(mockInitiate).toHaveBeenCalledWith('app', 'route-user', 'gmail', { connectionId: expect.stringMatching(/^[a-f0-9]{32}$/), state: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('lets the same user restart an abandoned init and invalidates only the old attempt', async () => {
    expect((await invoke('/init', { account_id: 'mailbox' })).statusCode).toBe(200);
    const firstChallenge = mockInitiate.mock.calls[0][3];
    expect((await invoke('/init', { account_id: 'mailbox' })).statusCode).toBe(200);
    const secondChallenge = mockInitiate.mock.calls[1][3];
    expect(secondChallenge.connectionId).toBe(firstChallenge.connectionId);
    expect(secondChallenge.state).not.toBe(firstChallenge.state);
    expect(await consume(firstChallenge.connectionId, firstChallenge.state)).toBeNull();
  });
  it.each([{ tool: 'outlook' }, { status: 'connected' }, { status: 'nonsense' }, { state: undefined }, { state: ['a', 'b'] }, { connection_id: ['x'] }])('rejects invalid callback without vendor contact: %j', async bad => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    const res = await invoke('/callback', { connection_id: issued.connectionId, state: issued.state, tool: 'gmail', status: 'success', ...bad });
    expect(res.statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(await consume(issued.connectionId, issued.state)).not.toBeNull();
  });
  it('rejects forged state without deleting the real attempt', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    expect((await invoke('/callback', { connection_id: issued.connectionId, state: '0'.repeat(64), tool: 'gmail', status: 'success' })).statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(await consume(issued.connectionId, issued.state)).not.toBeNull();
  });
  it('checks bound ownership again and accepts only one replay-safe success', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    mockList.mockResolvedValue([{ tool: 'gmail', connection_id: issued.connectionId, status: 'connected' }]);
    const query = { connection_id: issued.connectionId, state: issued.state, tool: 'gmail', status: 'success', external_user_id: 'attacker' };
    const first = await invoke('/callback', query);
    expect(first.send).toHaveBeenCalledWith(expect.stringContaining('Gmail connected'));
    expect(mockList).toHaveBeenCalledWith('app', 'route-user');
    expect(mockResolve).toHaveBeenCalledWith('route-user', 'mailbox', 'read');
    expect((await invoke('/callback', query)).statusCode).toBe(400);
    expect(mockList).toHaveBeenCalledTimes(1);
  });
  it('preserves bounded callback retries for configured status and temporary vendor failure', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    const query = { ...issued, connection_id: issued.connectionId, tool: 'gmail', status: 'success' };
    mockList.mockResolvedValueOnce([{ tool: 'gmail', connection_id: issued.connectionId, status: 'configured' }]);
    expect((await invoke('/callback', query)).statusCode).toBe(200);
    mockList.mockRejectedValueOnce(new Error('temporary'));
    expect((await invoke('/callback', query)).statusCode).toBe(502);
    mockList.mockResolvedValueOnce([{ tool: 'gmail', connection_id: issued.connectionId, status: 'connected' }]);
    expect((await invoke('/callback', query)).send).toHaveBeenCalledWith(expect.stringContaining('Gmail connected'));
    expect((await invoke('/callback', query)).statusCode).toBe(400);
  });
  it('fails closed when ownership changed or eligibility was revoked', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    mockResolve.mockResolvedValue({ platform: 'gmail', ownerUserId: 'other', accountId: 'mailbox' });
    expect((await invoke('/callback', { ...issued, connection_id: issued.connectionId, tool: 'gmail', status: 'success' })).statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('does not accept ambiguous duplicate matching connections', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    const row = { tool: 'gmail', connection_id: issued.connectionId, status: 'connected' };
    mockList.mockResolvedValue([row, row]);
    const res = await invoke('/callback', { ...issued, connection_id: issued.connectionId, tool: 'gmail', status: 'success' });
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining('Gmail connected'));
  });
  it('consumes error callbacks once without a vendor request', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    const query = { ...issued, connection_id: issued.connectionId, tool: 'gmail', status: 'error' };
    expect((await invoke('/callback', query)).statusCode).toBe(200);
    expect((await invoke('/callback', query)).statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('rechecks eligibility after issue and before token/vendor calls', async () => {
    const issued = await create('route-user', 'mailbox', 'gmail');
    mockEligible.mockReturnValue(false);
    expect((await invoke('/callback', { ...issued, connection_id: issued.connectionId, tool: 'gmail', status: 'success' })).statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated, ineligible and malformed init requests before vendor calls', async () => {
    expect((await invoke('/init', { account_id: 'mailbox' }, '')).statusCode).toBe(401);
    mockEligible.mockReturnValue(false);
    expect((await invoke('/init', { account_id: 'mailbox' })).statusCode).toBe(403);
    mockEligible.mockReturnValue(true);
    expect((await invoke('/init', { account_id: ['mailbox'] })).statusCode).toBe(400);
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockInitiate).not.toHaveBeenCalled();
  });

});

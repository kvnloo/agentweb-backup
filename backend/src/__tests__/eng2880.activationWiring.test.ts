jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), recordZomaActivationEvent: jest.fn() }, oauthSessionDb: { get: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/zomaActivationEvents', () => ({
  ...jest.requireActual('../services/zomaActivationEvents'),
  emitActivation: jest.fn().mockResolvedValue(true), emitActivationLogin: jest.fn().mockResolvedValue(undefined),
}));
import { ActivationStage as S, emitActivation, emitActivationLogin } from '../services/zomaActivationEvents';
import { getZomaReadiness } from '../mcp/zomaOnboarding';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
const account: any = { platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'token', granted_scopes: ['ads_management'] } };
it.each([[false, false], [true, false], [false, true], [true, true]])('readiness card=%s account=%s emits only real observed milestones', async (paid, connected) => {
  await getZomaReadiness('u1', {
    getUser: async () => ({ userId: 'u1' }), resolvePaymentMethod: async () => ({ hasPaymentMethod: paid }),
    listAccounts: async () => connected ? [account] : [], now: Date.now, frontendUrl: () => 'https://example.com', pagesUrl: () => 'https://api.example.com',
    findLiveCustomerId: async () => 'cus_1', createPaymentMethodSetupSession: async () => ({ url: 'https://stripe.test/setup' }),
    buildMetaConnectUrl: async () => 'https://meta.test/connect', googleEnabled: () => false,
  } as any);
  expect(emitActivation).toHaveBeenCalledWith('u1', S.OnboardingStarted);
  expect((emitActivation as jest.Mock).mock.calls.some(c => c[1] === S.AdAccountConnected)).toBe(connected);
  expect((emitActivation as jest.Mock).mock.calls.some(c => c[1] === S.OnboardingCompleted)).toBe((process.env.ZOMA_REQUIRE_PAYMENT_METHOD === 'true' ? paid : true) && connected);
});
it('unknown account never emits onboarding', async () => {
  await expect(getZomaReadiness('missing', { getUser: async () => undefined } as any)).rejects.toThrow();
  expect(emitActivation).not.toHaveBeenCalled();
});
it('authenticated toolkit login is wired and actual guarded write goes through result observer', async () => {
  // The observer's default emitter is its own module-local implementation; use the
  // mocked durable boundary to prove the gateway executes it, not a source-text claim.
  process.env.ZOMA_ACTIVATION_EVENTS_ENABLED = 'true';
  const { userDb } = require('../services/db');
  userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@b.co' });
  userDb.recordZomaActivationEvent.mockResolvedValue(true);
  const executeWrite = jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', status: 'PAUSED', id: 'ad1' });
  await handleMetaToolkitCall({ authorization: 'Bearer aw_test', toolName: 'call_meta_marketing_api', args: { entity_type: 'AD', action: 'CREATE', params: { name: 'new' } } }, {
    validateApiKey: async () => ({ userId: 'u1', keyId: 'k1' }), validateOAuthToken: jest.fn(),
    listAccounts: async () => [account], now: Date.now, execute: jest.fn(), executeWrite,
    recordUsage: jest.fn().mockResolvedValue(true), recordWrite: jest.fn().mockResolvedValue(true),
  } as any);
  expect(emitActivationLogin).toHaveBeenCalledWith('u1');
  expect(executeWrite).toHaveBeenCalledTimes(1);
  expect(userDb.recordZomaActivationEvent.mock.calls.map((c: any[]) => c[1])).toEqual([S.AdCreationStarted, S.AdCreationCompleted]);
  delete process.env.ZOMA_ACTIVATION_EVENTS_ENABLED;
});
it('invalid authentication emits nothing', async () => {
  await expect(handleMetaToolkitCall({ authorization: null, toolName: 'zoma_status' })).rejects.toThrow();
  expect(emitActivationLogin).not.toHaveBeenCalled();
});

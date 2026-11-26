/**
 * ENG-3195: brand-new Zoma accounts showed "Payment method on file" (relayed by the chat client as
 * "Payment: on file") although no card was ever added. While no card is asked for at setup
 * (ZOMA_REQUIRE_PAYMENT_METHOD unset), payment readiness is true without a card, so:
 *  1. zoma_status leaves the payment line out of the checklist and marks `payment.required: false`;
 *  2. with the card requirement on, the line and the structured payment state are as before;
 *  3. writes are unchanged in both modes (the write gate never reads the new field);
 *  4. the zoma_status tool description no longer tells the client a card is always checked, so the
 *     client's own paraphrase ("Payment: on file") is not primed by it.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import { assertZomaWriteReady, runZomaTool, type ZomaOnboardingDeps } from '../mcp/zomaOnboarding';
import { zomaToolDefinitions } from '../mcp/zomaToolDefinitions';

const NOW = 1_800_000_000_000;
const metaAccount = () => ({
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', currency: 'TWD', granted_scopes: ['ads_management'] },
});

function deps(accounts: any[], hasCard: boolean): ZomaOnboardingDeps & Record<string, jest.Mock> {
  return {
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', zomaAdsExperience: 'runs_ads', email: 'new@b.co' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    findLiveCustomerId: jest.fn().mockResolvedValue('cus_1'),
    createCustomerForUser: jest.fn(),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: hasCard }),
    createPaymentMethodSetupSession: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_setup' }),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://facebook.example/connect'),
    googleEnabled: () => false,
    pagesUrl: () => 'https://api.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
  } as any;
}
const status = (d: ZomaOnboardingDeps): Promise<any> => runZomaTool('zoma_status', {}, { userId: 'u1' }, d);

describe('ENG-3195 zoma_status payment line', () => {
  const saved = process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
  afterEach(() => {
    if (saved === undefined) delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
    else process.env.ZOMA_REQUIRE_PAYMENT_METHOD = saved;
  });

  describe('card not required at setup (ZOMA_REQUIRE_PAYMENT_METHOD unset, as in prod)', () => {
    beforeEach(() => { delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD; });

    it('a brand-new account with no card is not told a payment method is on file', async () => {
      const d = deps([], false);
      const r = await status(d);
      expect(r.summary).not.toContain('Payment method on file');
      expect(r.summary).not.toMatch(/payment/i);
      expect(r.payment).toEqual({ ready: true, required: false });
      expect(d.resolvePaymentMethod).not.toHaveBeenCalled();
      expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
      // The next step is still the Meta connection, as before.
      expect(r.next_step).toContain('https://facebook.example/connect');
    });

    it('a fully set-up account keeps the rest of the checklist and writes stay enabled', async () => {
      const d = deps([metaAccount()], false);
      const r = await status(d);
      expect(r.summary.split('\n').slice(0, 4)).toEqual([
        'Zoma setup:',
        '  [x] AgentWeb login (new@b.co)',
        '  [x] How familiar you are with ads (runs_ads)',
        '  [x] Meta ad account connected (111, TWD)',
      ]);
      expect(r.writes_enabled).toBe(true);
      await expect(assertZomaWriteReady('u1', d)).resolves.toBeUndefined();
    });
  });

  describe('card required at setup (ZOMA_REQUIRE_PAYMENT_METHOD=true)', () => {
    beforeEach(() => { process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true'; });

    it('with a card: the line is ticked and the payment state has no `required` field', async () => {
      const r = await status(deps([metaAccount()], true));
      expect(r.summary).toContain('  [x] Payment method on file');
      expect(r.payment).toEqual({ ready: true });
    });

    it('without a card: the line is unticked, the setup link is the next step, writes are refused', async () => {
      const d = deps([metaAccount()], false);
      const r = await status(d);
      expect(r.summary).toContain('  [ ] Payment method on file');
      expect(r.payment).toEqual({ ready: false, link: 'https://checkout.stripe.com/c/pay/cs_setup' });
      expect(r.next_step).toContain('Add a payment method');
      await expect(assertZomaWriteReady('u1', d)).rejects.toThrow(/No payment method on file/);
    });
  });

  it('the zoma_status description only asks about a payment method when one is required', () => {
    const d = zomaToolDefinitions(false).find((t) => t.name === 'zoma_status')!.description;
    expect(d).not.toMatch(/payment method on file\)/);
    expect(d).not.toMatch(/need both a payment method/);
    expect(d).toContain('a payment method only when one is required at setup');
    expect(d).toContain('never tell the user a payment method is on file unless the checklist says so');
  });
});

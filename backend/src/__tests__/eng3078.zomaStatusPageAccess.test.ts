/**
 * ENG-3078 acceptance: zoma_status must not say "All set" when a connected Meta account's
 * Facebook Page access is confirmed missing (`has_meta_pages: false`).
 *  1. missing  -> the Page problem is the next step; the account carries page_access: 'missing'.
 *  2. unknown  -> nothing changes (never probed is not a verdict).
 *  3. granted  -> output identical to today.
 *  4. the message is getMetaAdsNoPagesMessage verbatim.
 *  5. reads still work, nothing is stored, the write gate is untouched.
 * ENG-3125 extended next_step: the same message, verbatim and once, followed by numbered fix
 * steps (see eng3125.zomaMetaPageBlocker.test.ts), and a fresh Meta reconnect link is minted.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import { assertZomaWriteReady, getZomaReadiness, runZomaTool, type ZomaOnboardingDeps } from '../mcp/zomaOnboarding';
import { buildMetaAdsWrongPageMessage, META_ADS_NO_PAGES_MESSAGE } from '../utils/metaAdsScope';

const NOW = 1_800_000_000_000;
const ALL_SET = 'All set. Ask me about your Meta ads, e.g. "how are my campaigns doing this week?"';
// The exact text a fully set-up user gets on main today (Google Ads provider off).
const TODAY_SUMMARY = [
  'Zoma setup:',
  '  [x] AgentWeb login (a@b.co)',
  '  [x] Payment method on file',
  '  [x] Meta ad account connected (111, TWD)',
  '',
  ALL_SET,
].join('\n');

const metaAccount = (over: any = {}, id = '111') => ({
  platform: 'meta',
  account_id: `act_${id}`,
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: id, currency: 'TWD', granted_scopes: ['ads_management'], ...over },
});
const googleAccount = () => ({
  platform: 'google_ads',
  account_id: '1234567890',
  account_name: 'Acme Search',
  config: { account_type: 'google_ads', customer_id: '1234567890', currency: 'USD', access_token: 't', refresh_token: 'r' },
});

function deps(accounts: any[], over: Partial<ZomaOnboardingDeps> = {}): ZomaOnboardingDeps & Record<string, jest.Mock> {
  return {
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    findLiveCustomerId: jest.fn(),
    createCustomerForUser: jest.fn(),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
    createPaymentMethodSetupSession: jest.fn(),
    buildMetaConnectUrl: jest.fn().mockResolvedValue('https://facebook.example/connect'),
    buildGoogleAdsConnectUrl: jest.fn().mockResolvedValue('https://accounts.google.example/connect'),
    googleEnabled: () => false,
    frontendUrl: () => 'https://app.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
    ...over,
  } as any;
}
const status = (d: ZomaOnboardingDeps): Promise<any> => runZomaTool('zoma_status', {}, { userId: 'u1' }, d);
// ENG-3127: the Page step leads with the fact that reads still work.
const READS_OK = 'Reading your Meta campaigns and reports works. Creating new ads is blocked until this is fixed:\n';
/** ENG-3125: the ENG-3127 lead, the canonical message verbatim and exactly once, then the guided fix steps. */
const expectPageStep = (nextStep: string | null, message: string) => {
  expect(typeof nextStep).toBe('string');
  expect(nextStep!.startsWith(`${READS_OK}${message}\n\nTo fix it:\n1. `)).toBe(true);
  expect(nextStep!.split(message).length).toBe(2);
};

describe('ENG-3078 zoma_status and Facebook Page access', () => {
  it('missing: the Page problem is the next step instead of "All set"', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: false })]));
    expect(r.summary).not.toContain('All set');
    expectPageStep(r.next_step, META_ADS_NO_PAGES_MESSAGE);
    expect(r.summary).toContain(`\n\n${READS_OK}${META_ADS_NO_PAGES_MESSAGE}\n`);
    expect(r.meta.accounts).toEqual([
      { account_id: '111', name: 'Phoenix', currency: 'TWD', ads_management: 'granted', page_access: 'missing' },
    ]);
  });

  it('missing: the ad account still shows as connected and reads/write readiness are unchanged', async () => {
    const d = deps([metaAccount({ has_meta_pages: false })]);
    const r = await status(d);
    expect(r.summary).toContain('  [x] Meta ad account connected (111, TWD)');
    expect(r.meta.ready).toBe(true);
    expect(r.writes_enabled).toBe(true);
    // ENG-3125: one fresh reconnect link for the guided fix; Meta stays connected.
    expect(d.buildMetaConnectUrl).toHaveBeenCalledTimes(1);
    await expect(assertZomaWriteReady('u1', d)).resolves.toBeUndefined();
  });

  it('missing because existing ads run under an inaccessible Page: names that Page', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: false, existing_ads_page_id: '9001' })]));
    expectPageStep(r.next_step, buildMetaAdsWrongPageMessage('9001'));
    expect(r.summary).not.toContain('All set');
  });

  it('one account granted, one missing: only the missing one is flagged and the step is shown', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: true }), metaAccount({ has_meta_pages: false }, '222')]));
    expect(r.summary).not.toContain('All set');
    expectPageStep(r.next_step, META_ADS_NO_PAGES_MESSAGE);
    expect(r.meta.accounts.map((a: any) => [a.account_id, a.page_access])).toEqual([['111', undefined], ['222', 'missing']]);
  });

  it('two accounts with the same Page problem: the message is shown once', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: false }), metaAccount({ has_meta_pages: false }, '222')]));
    expectPageStep(r.next_step, META_ADS_NO_PAGES_MESSAGE);
  });

  it('Google Ads ready but Meta Page missing: still not "All set"', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: false }), googleAccount()], { googleEnabled: () => true }));
    expect(r.google_ads.ready).toBe(true);
    expect(r.summary).not.toContain('All set');
    expectPageStep(r.next_step, META_ADS_NO_PAGES_MESSAGE);
  });

  it('missing with mintLinks off (device-flow poll): step shown, no link minted', async () => {
    const d = deps([metaAccount({ has_meta_pages: false })]);
    const r = await getZomaReadiness('u1', d, { mintLinks: false });
    expectPageStep(r.next_step, META_ADS_NO_PAGES_MESSAGE);
    expect(d.buildMetaConnectUrl).not.toHaveBeenCalled();
  });

  it('a payment problem still comes first when the Page is also missing', async () => {
    process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
    try {
      const d = deps([metaAccount({ has_meta_pages: false })], {
        resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: false }),
        findLiveCustomerId: jest.fn().mockResolvedValue('cus_1'),
        createPaymentMethodSetupSession: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_setup' }),
      });
      const r = await status(d);
      expect(r.next_step).toContain('Add a payment method');
      expect(r.next_step).not.toContain('Facebook Pages');
    } finally {
      delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
    }
  });

  it('unknown (never probed): nothing changes', async () => {
    const r = await status(deps([metaAccount()]));
    expect(r.summary).toBe(TODAY_SUMMARY);
    expect(r.next_step).toBeNull();
    expect(r.meta.accounts).toEqual([{ account_id: '111', name: 'Phoenix', currency: 'TWD', ads_management: 'granted' }]);
  });

  it('granted: output is identical to today', async () => {
    const r = await status(deps([metaAccount({ has_meta_pages: true })]));
    expect(r.summary).toBe(TODAY_SUMMARY);
    expect(r.next_step).toBeNull();
    expect(r.meta.accounts).toEqual([{ account_id: '111', name: 'Phoenix', currency: 'TWD', ads_management: 'granted' }]);
  });
});

process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-3128 — "How familiar are you with ads?" through zoma_status (agent asks in chat), and the
 * "just a friend" exclusion from active-user counts.
 *   - unanswered: zoma_status asks the question first and mints no setup links
 *   - zoma_status { ads_experience } persists the answer on the user; an invalid value is refused
 *   - runs_ads: straight to connecting ad accounts (Meta, Google), then the card, then done
 *   - new_to_ads: ENG-3134 — the Meta connect link first, the ad-account setup guide after it
 *   - not_interested: exactly the thank-you, no further steps, nothing minted (ENG-3134)
 *   - ENG-3134: the first answer is "Hey, welcome to Zoma." and the one question, no checklist
 *   - ENG-3134: a friend is classified `pal` in the lead list
 *   - no step ever routes to the Emma app
 *   - not_interested users are excluded from the scoreboard and activation-queue counts
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import { getZomaReadiness, runZomaTool, ZomaNotReadyError, type ZomaOnboardingDeps } from '../mcp/zomaOnboarding';
import { ZOMA_NEW_TO_ADS_STEPS, ZOMA_NOT_INTERESTED_MESSAGE } from '../mcp/zomaAdsExperience';
import { buildZomaScoreboard, type ScoreboardDeps, type ZomaUserRecord, type ZomaWriteEvent } from '../services/zomaScoreboard';
import { activeUserCount, buildTracker, dailyFollowUpList, helpAlert, type ZomaTrackedUser } from '../services/zomaActivationQueue';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const META_LINK = 'https://www.facebook.com/v23.0/dialog/oauth?client_id=x';
const GOOGLE_LINK = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=g';
const EMMA_APP = 'app.agentweb.pro';
const metaAccount = () => ({
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', currency: 'USD', granted_scopes: ['ads_management'] },
});

function deps(user: Record<string, unknown>, over: Partial<ZomaOnboardingDeps> = {}) {
  let row: Record<string, unknown> = { userId: 'u1', email: 'friend@gmail.com', ...user };
  const d = {
    getUser: jest.fn(async () => row),
    listAccounts: jest.fn().mockResolvedValue([]),
    findLiveCustomerId: jest.fn().mockResolvedValue('cus_1'),
    createCustomerForUser: jest.fn().mockResolvedValue('cus_new'),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: false, customerId: null, card: null, isZoma: false }),
    createPaymentMethodSetupSession: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_setup' }),
    buildMetaConnectUrl: jest.fn().mockResolvedValue(META_LINK),
    buildGoogleAdsConnectUrl: jest.fn().mockResolvedValue(GOOGLE_LINK),
    googleEnabled: () => true,
    pagesUrl: () => 'https://api.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
    saveAdsExperience: jest.fn(async (_u: string, answer: string) => {
      row = { ...row, zomaAdsExperience: answer };
    }),
    ...over,
  };
  return d as unknown as ZomaOnboardingDeps & Record<string, jest.Mock>;
}

const status = (d: ZomaOnboardingDeps, args: unknown = {}) => runZomaTool('zoma_status', args, { userId: 'u1' }, d) as Promise<any>;

describe('ENG-3128 zoma_status asks "How familiar are you with ads?"', () => {
  it('unanswered: the question is the next step, with all three options, and no links are minted', async () => {
    const d = deps({});
    const r = await status(d);
    expect(r.ads_experience).toBeNull();
    expect(r.next_step).toContain('How familiar are you with ads?');
    for (const value of ['runs_ads', 'new_to_ads', 'not_interested']) expect(r.next_step).toContain(value);
    expect(r.next_step).toContain('Not interested, just a friend');
    // ENG-3134: first contact is the welcome and the one question, not a setup checklist.
    expect(r.summary.startsWith('Hey, welcome to Zoma.')).toBe(true);
    expect(r.summary).not.toContain('[ ]');
    expect(d.buildMetaConnectUrl).not.toHaveBeenCalled();
    expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
    expect(d.createCustomerForUser).not.toHaveBeenCalled();
    expect(d.saveAdsExperience).not.toHaveBeenCalled();
  });

  it('runs_ads: answer is stored, next step is connecting ad accounts (Meta + Google), no setup guide', async () => {
    const d = deps({});
    const r = await status(d, { ads_experience: 'runs_ads' });
    expect(d.saveAdsExperience).toHaveBeenCalledWith('u1', 'runs_ads');
    expect(r.ads_experience).toBe('runs_ads');
    expect(r.next_step).toContain(META_LINK);
    expect(r.next_step).toContain(GOOGLE_LINK);
    expect(r.next_step).not.toContain('business.facebook.com/overview');
    expect(r.next_step).not.toContain(EMMA_APP);
  });

  it('runs_ads with ad accounts connected: the card comes next, then done', async () => {
    const d = deps({ zomaAdsExperience: 'runs_ads' }, { listAccounts: jest.fn().mockResolvedValue([metaAccount()]) });
    const card = await getZomaReadiness('u1', d);
    expect(card.next_step).toContain('https://checkout.stripe.com/c/pay/cs_setup');

    (d.resolvePaymentMethod as jest.Mock).mockResolvedValue({ hasPaymentMethod: true, customerId: 'cus_1', card: null, isZoma: true });
    const done = await getZomaReadiness('u1', d);
    expect(done.next_step).toBeNull();
    expect(done.writes_enabled).toBe(true);
  });

  it('new_to_ads: guided Meta Business/ad account + Facebook Page + Google Ads setup, then the connect links', async () => {
    const d = deps({});
    const r = await status(d, { ads_experience: 'new_to_ads' });
    expect(d.saveAdsExperience).toHaveBeenCalledWith('u1', 'new_to_ads');
    for (const step of ZOMA_NEW_TO_ADS_STEPS) expect(r.next_step).toContain(step);
    expect(r.next_step).toMatch(/Business portfolio/);
    expect(r.next_step).toMatch(/Facebook Page/);
    expect(r.next_step).toMatch(/ad account/);
    expect(r.next_step).toMatch(/Google Ads account/);
    // ENG-3134: the answer leads straight to Meta connect; the guide follows the link.
    expect(r.next_step.indexOf(META_LINK)).toBeLessThan(r.next_step.indexOf('Facebook Page'));
    expect(r.next_step.startsWith('Connect Meta')).toBe(true);
    expect(r.next_step).toContain(GOOGLE_LINK);
    expect(r.next_step).not.toContain(EMMA_APP);
  });

  it('not_interested: thank-you with no further steps, nothing minted', async () => {
    const d = deps({});
    const r = await status(d, { ads_experience: 'not_interested' });
    expect(d.saveAdsExperience).toHaveBeenCalledWith('u1', 'not_interested');
    // ENG-3134: the whole answer is exactly the thank-you; no setup state or links ride along.
    expect(r).toEqual({ summary: 'Thanks for signing up and trying out Zoma.', ads_experience: 'not_interested', next_step: null });
    expect(ZOMA_NOT_INTERESTED_MESSAGE).toBe('Thanks for signing up and trying out Zoma.');
    expect(d.buildMetaConnectUrl).not.toHaveBeenCalled();
    expect(d.createPaymentMethodSetupSession).not.toHaveBeenCalled();
    expect(r.summary).not.toContain(EMMA_APP);
  });

  it('an invalid answer is refused and nothing is stored', async () => {
    const d = deps({});
    await expect(status(d, { ads_experience: 'maybe' })).rejects.toThrow(ZomaNotReadyError);
    expect(d.saveAdsExperience).not.toHaveBeenCalled();
  });
});

describe('ENG-3128 "just a friend" users are excluded from active-user counts', () => {
  const write = (userId: string): ZomaWriteEvent => ({
    userId, ts: new Date(NOW - 86400000).toISOString(), platform: 'meta', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: 'c1',
  });
  const sbDeps = (users: ZomaUserRecord[], events: ZomaWriteEvent[]): ScoreboardDeps => ({
    listZomaUsers: async () => users,
    getUser: async (id) => users.find((u) => u.userId === id),
    listWriteEvents: async () => events,
    now: () => NOW,
  });

  it('scoreboard: a not_interested user is listed, flagged, and never counted (even with a write)', async () => {
    const sb = await buildZomaScoreboard(sbDeps(
      [
        { userId: 'u1', email: 'ann@acme.co', zomaAdsExperience: 'runs_ads' },
        { userId: 'u2', email: 'pal@gmail.com', zomaAdsExperience: 'not_interested' },
        { userId: 'u3', email: 'bo@shop.co' },
      ],
      [write('u1'), write('u2')],
    ));
    const friend = sb.rows.find((r) => r.userId === 'u2')!;
    expect(friend).toMatchObject({ excluded: 'pal', active7d: false });
    expect(sb.summary).toEqual({ zomaUsers: 2, activeUsers7d: 1, firstAdUsers: 0, excludedAccounts: 1, palUsers: 1 });
  });

  it('activation queue: not_interested is never due, stalled, or needing help, and not in the active count', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const friend: ZomaTrackedUser = { name: 'Pal', email: 'pal@gmail.com', dateInvited: '2026-11-01T00:00:00Z', adsExperience: 'not_interested', currentBlocker: 'none' };
    const prospect: ZomaTrackedUser = { name: 'Ann', email: 'ann@acme.co', dateInvited: '2026-11-01T00:00:00Z', adsExperience: 'new_to_ads' };
    const rows = buildTracker([friend, prospect], now);
    expect(rows.find((r) => r.email === 'pal@gmail.com')).toMatchObject({ notInterested: true, classification: 'pal', due: false, needsHelp: false, stalled: false, nextAction: null });
    expect(rows.find((r) => r.email === 'ann@acme.co')).toMatchObject({ classification: 'prospect' });
    expect(dailyFollowUpList([friend, prospect], now).map((r) => r.email)).toEqual(['ann@acme.co']);
    expect(helpAlert(rows)?.users.map((r) => r.email)).toEqual(['ann@acme.co']);
    expect(activeUserCount([friend, prospect], now)).toBe(1);
  });
});

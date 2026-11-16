/**
 * ENG-3125 regression (Opslane run 2142, P1): POST /api/zoma/setup/poll for an approved user whose
 * Meta ad account has no Facebook Page must carry a fresh Meta connect link (auth_type=rerequest).
 * Uses the REAL default mintMetaLink -> buildMetaConnectUrl path; only Secrets Manager is faked.
 * The link can only go missing when minting throws, so that failure must be retried once and,
 * if it persists, surfaced (link_error + traced) instead of silently dropped.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-3125-test-secret';

const getMetaCredentials = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getMetaCredentials: (...a: unknown[]) => getMetaCredentials(...a), getInstagramCredentials: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/journeyTracking', () => ({ aliasJourney: jest.fn(), anonymousSetupId: (id: string) => id, trackJourney: jest.fn() }));
jest.mock('../services/journeyMilestones', () => ({ noteProductUse: jest.fn(), noteSignup: jest.fn(), zomaMilestone: jest.fn() }));

import { getZomaReadiness, META_CREATE_PAGE_URL } from '../mcp/zomaOnboarding';
import { defaultZomaDeviceFlowDeps, pollSetup, sha256, type ZomaDeviceFlowDeps } from '../mcp/zomaDeviceFlow';
import { defaultZomaLinkCodec } from '../mcp/zomaSetupLinks';

const NOW = 1_800_000_000_000;
const DEVICE_CODE = 'device-code-eng-3125-link';
const DEVICE_ID = sha256(DEVICE_CODE);

/** Zero Pages, none on record — exactly what metaOAuthFinalize stores for a Page-less login. */
const noPageAccount = {
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', currency: 'USD', granted_scopes: ['ads_management'], has_meta_pages: false, meta_page_count: 0 },
};

function harness() {
  const events: any[] = [];
  const store: any = {
    getDevice: async () => ({ deviceId: DEVICE_ID, userCode: 'BCDFGHJK', status: 'approved', userId: 'user-1', intervalSec: 5, createdAt: '', expiresAt: NOW + 3_600_000 }),
    claimPoll: async () => ({ ok: true }),
    appendEvent: async (_id: string, e: any) => { events.push(e); },
    issueToken: jest.fn().mockResolvedValue(true),
  };
  const onboarding: any = {
    getUser: jest.fn().mockResolvedValue({ userId: 'user-1', zomaAdsExperience: 'runs_ads', email: 'a@b.co' }),
    listAccounts: jest.fn().mockResolvedValue([noPageAccount]),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
    buildMetaConnectUrl: jest.fn(),
    googleEnabled: () => false,
    frontendUrl: () => 'https://app.agentweb.pro',
    now: () => NOW,
  };
  const deps: ZomaDeviceFlowDeps = {
    ...defaultZomaDeviceFlowDeps, // real mintMetaLink
    store,
    now: () => NOW,
    links: defaultZomaLinkCodec,
    readiness: (userId) => getZomaReadiness(userId, onboarding, { mintLinks: false }),
    principalAllowed: async () => true,
  };
  return { deps, store, events };
}

const CREDS = { clientId: 'meta-app-id', clientSecret: 'meta-app-secret' };

beforeEach(() => getMetaCredentials.mockReset());

describe('ENG-3125 poll: no Facebook Page -> fix_meta_page WITH a Meta connect link', () => {
  it('real link path: rerequest link, create_page_url, instructions carrying the link, no token', async () => {
    getMetaCredentials.mockResolvedValue(CREDS);
    const h = harness();
    const r: any = await pollSetup(DEVICE_CODE, h.deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ next_step: 'fix_meta_page', reason: 'no_page_exists', create_page_url: META_CREATE_PAGE_URL });
    const url = new URL(r.body.link);
    expect(url.searchParams.get('auth_type')).toBe('rerequest');
    expect(url.searchParams.get('client_id')).toBe('meta-app-id');
    expect(r.body.instructions.join('\n')).toContain(r.body.link);
    expect(r.body).not.toHaveProperty('link_error');
    expect(r.body).not.toHaveProperty('access_token');
    expect(h.store.issueToken).not.toHaveBeenCalled();
  });

  it('a transient mint failure is retried, so the link is still returned', async () => {
    getMetaCredentials.mockRejectedValueOnce(new Error('Failed to fetch Meta credentials from Secrets Manager')).mockResolvedValue(CREDS);
    const h = harness();
    const r: any = await pollSetup(DEVICE_CODE, h.deps);
    expect(new URL(r.body.link).searchParams.get('auth_type')).toBe('rerequest');
    expect(h.events.some((e) => e.step === 'meta_link')).toBe(false);
  });

  it('a persistent mint failure is surfaced (link_error + traced), never silently dropped', async () => {
    getMetaCredentials.mockRejectedValue(new Error('Failed to fetch Meta credentials from Secrets Manager'));
    const h = harness();
    const r: any = await pollSetup(DEVICE_CODE, h.deps);
    expect(r.body).toMatchObject({ next_step: 'fix_meta_page', reason: 'no_page_exists', create_page_url: META_CREATE_PAGE_URL });
    expect(r.body).not.toHaveProperty('link');
    expect(r.body.link_error).toMatch(/poll again/);
    expect(r.body.instructions.join('\n')).toMatch(/poll setup again for a fresh Meta connect link/i);
    expect(r.body.instructions.join('\n')).not.toContain('ask me');
    expect(h.events).toContainEqual(expect.objectContaining({ step: 'meta_link', outcome: 'error' }));
    expect(r.body).not.toHaveProperty('access_token');
    expect(getMetaCredentials).toHaveBeenCalledTimes(2);
  });
});

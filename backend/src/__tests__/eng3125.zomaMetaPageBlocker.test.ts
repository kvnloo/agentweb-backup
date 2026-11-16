/**
 * ENG-3125 acceptance: "Connected, but ads will fail — no accessible Facebook Page" is a
 * structured, guided blocker in zoma_status and the device-flow poll, not just an Emma toast.
 *  1. each reason (no_page_exists | page_not_granted | no_advertiser_role) is derived from the
 *     stored Page probe and maps to its own agent-relayable steps + a fresh Meta connect link.
 *  2. the poll returns next_step 'fix_meta_page' and never issues the token while it exists.
 *  3. the browser journey never shows "You're set" while it exists (continue + Stripe return).
 *  4. readiness is re-derived on the next poll: once the Page is usable, setup completes.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'eng-3125-test-secret';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../services/metaConnectUrl', () => ({ buildMetaConnectUrl: jest.fn() }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/journeyTracking', () => ({ aliasJourney: jest.fn(), anonymousSetupId: (id: string) => id, trackJourney: jest.fn() }));
jest.mock('../services/journeyMilestones', () => ({ noteProductUse: jest.fn(), noteSignup: jest.fn(), zomaMilestone: jest.fn() }));

import {
  classifyMetaPageBlocker,
  getZomaReadiness,
  META_CREATE_PAGE_URL,
  META_PAGE_READS_OK,
  runZomaTool,
  type ZomaOnboardingDeps,
  type ZomaReadiness,
} from '../mcp/zomaOnboarding';
import { continueInBrowser, finishPayment, pollSetup, sha256, type ZomaDeviceFlowDeps } from '../mcp/zomaDeviceFlow';
import type { ZomaDeviceRecord, ZomaDeviceStore } from '../mcp/zomaDeviceStore';
import { defaultZomaLinkCodec } from '../mcp/zomaSetupLinks';
import { META_ADS_NO_PAGES_MESSAGE } from '../utils/metaAdsScope';

const NOW = 1_800_000_000_000;
const CONNECT = 'https://www.facebook.com/v25.0/dialog/oauth?auth_type=rerequest&state=s';

const metaAccount = (over: any = {}, id = '111') => ({
  platform: 'meta',
  account_id: `act_${id}`,
  account_name: 'Phoenix',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: id, currency: 'TWD', granted_scopes: ['ads_management'], ...over },
});

/** Stored Page-probe shapes for each reason (as written by metaOAuthFinalize / the sweep). */
const PROBES = {
  no_page_exists: { has_meta_pages: false, meta_page_count: 0, accessible_page_ids: [] },
  page_not_granted: { has_meta_pages: false, meta_page_count: 0, accessible_page_ids: [], existing_ads_page_id: '9001' },
  page_not_granted_declined: { has_meta_pages: false, declined_required_permissions: ['pages_show_list'] },
  no_advertiser_role: { has_meta_pages: false, meta_page_count: 2, accessible_page_ids: ['1', '2'], existing_ads_page_id: '9001' },
};

function onboardingDeps(accounts: any[]): ZomaOnboardingDeps & Record<string, jest.Mock> {
  return {
    getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co' }),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    findLiveCustomerId: jest.fn(),
    createCustomerForUser: jest.fn(),
    resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
    createPaymentMethodSetupSession: jest.fn(),
    buildMetaConnectUrl: jest.fn().mockResolvedValue(CONNECT),
    googleEnabled: () => false,
    frontendUrl: () => 'https://app.agentweb.pro',
    now: () => NOW,
    getUsage: jest.fn(),
  } as any;
}

describe('ENG-3125 classification of the stored Page probe', () => {
  it.each([
    ['no_page_exists', PROBES.no_page_exists],
    ['page_not_granted', PROBES.page_not_granted],
    ['page_not_granted', PROBES.page_not_granted_declined],
    ['no_advertiser_role', PROBES.no_advertiser_role],
  ])('%s', (reason, probe) => {
    expect(classifyMetaPageBlocker(probe)).toBe(reason);
  });
});

describe('ENG-3125 zoma_status: reason -> structured blocker + guided next_step', () => {
  it('no_page_exists: create a Page, then reconnect with a fresh Meta link', async () => {
    const r: any = await runZomaTool('zoma_status', {}, { userId: 'u1' }, onboardingDeps([metaAccount(PROBES.no_page_exists)]));
    expect(r.blocker).toMatchObject({ type: 'meta_page_access', reason: 'no_page_exists', account_ids: ['111'], link: CONNECT, create_page_url: META_CREATE_PAGE_URL });
    expect(r.blocker.steps[0]).toContain(META_CREATE_PAGE_URL);
    expect(r.blocker.steps[1]).toContain(CONNECT);
    expect(r.next_step.startsWith(`${META_PAGE_READS_OK}\n${META_ADS_NO_PAGES_MESSAGE}`)).toBe(true);
    expect(r.next_step).toContain(`1. Create a Facebook Page`);
    expect(r.summary).toContain('[ ] Facebook Page usable for ads');
    expect(r.summary).not.toContain('All set');
  });

  it('page_not_granted: fresh Meta link that re-offers Page selection, naming the Page of record', async () => {
    const r: any = await runZomaTool('zoma_status', {}, { userId: 'u1' }, onboardingDeps([metaAccount(PROBES.page_not_granted)]));
    expect(r.blocker).toMatchObject({ reason: 'page_not_granted', page_id: '9001', link: CONNECT });
    expect(r.blocker).not.toHaveProperty('create_page_url');
    expect(r.blocker.steps[0]).toContain(CONNECT);
    expect(r.blocker.steps.join(' ')).toContain('Edit access');
    expect(r.blocker.steps.join(' ')).toContain('Facebook Page 9001');
    expect(r.blocker.steps.join(' ')).not.toContain('pages/create');
  });

  it('no_advertiser_role: how to get "Create ads" access, then reconnect', async () => {
    const r: any = await runZomaTool('zoma_status', {}, { userId: 'u1' }, onboardingDeps([metaAccount(PROBES.no_advertiser_role)]));
    expect(r.blocker).toMatchObject({ reason: 'no_advertiser_role', page_id: '9001', link: CONNECT });
    const text = r.blocker.steps.join('\n');
    expect(text).toContain('"Create ads"');
    expect(text).toContain('Business Settings');
    expect(text).toContain(`Once access is granted, open this Meta connect link`);
    expect(text).toContain(CONNECT);
  });

  it('a poll-time read (mintLinks off) still carries the blocker but mints nothing', async () => {
    const d = onboardingDeps([metaAccount(PROBES.no_page_exists)]);
    const r = await getZomaReadiness('u1', d, { mintLinks: false });
    expect(r.blocker?.reason).toBe('no_page_exists');
    expect(r.blocker).not.toHaveProperty('link');
    expect(d.buildMetaConnectUrl).not.toHaveBeenCalled();
  });

  it('granted or never probed: no blocker', async () => {
    for (const probe of [{ has_meta_pages: true }, {}]) {
      const r = await getZomaReadiness('u1', onboardingDeps([metaAccount(probe)]));
      expect(r.blocker).toBeNull();
      expect(r.next_step).toBeNull();
    }
  });
});

// ─── Device flow ─────────────────────────────────────────────────────────────

class MemoryStore implements ZomaDeviceStore {
  devices = new Map<string, ZomaDeviceRecord>();
  tokens = new Map<string, any>();
  async createDevice() { return true; }
  async getDevice(id: string) { const d = this.devices.get(id); return d ? { ...d } : null; }
  async getDeviceIdByUserCode() { return null; }
  async claimPoll(id: string, _i: number, now: number) { this.devices.get(id)!.lastPollAt = now; return { ok: true as const }; }
  async resolveDevice() { return false; }
  async saveLink(id: string, step: any, link: string) { const d = this.devices.get(id)!; d.links = { ...(d.links ?? {}), [step]: link }; }
  async issueToken(id: string, token: any) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'approved') return false;
    d.status = 'issued';
    this.tokens.set(token.tokenHash, token);
    return true;
  }
  async getToken(hash: string) { return this.tokens.get(hash) ?? null; }
  async revokeToken() { return false; }
  async appendEvent(id: string, event: any) { const d = this.devices.get(id); if (d) d.events = [...(d.events ?? []), event]; }
}

const DEVICE_CODE = 'device-code-eng-3125';
const DEVICE_ID = sha256(DEVICE_CODE);

function harness(readiness: () => Promise<Partial<ZomaReadiness>>) {
  let now = NOW;
  const store = new MemoryStore();
  store.devices.set(DEVICE_ID, {
    deviceId: DEVICE_ID, userCode: 'BCDFGHJK', status: 'approved', userId: 'user-1',
    intervalSec: 5, createdAt: new Date(NOW).toISOString(), expiresAt: NOW + 3_600_000,
  } as ZomaDeviceRecord);
  const deps = {
    store,
    now: () => now,
    backendUrl: () => 'https://api.example.test',
    readiness: jest.fn(readiness),
    mintMetaLink: jest.fn(async (_u: string, deviceId: string) => `${CONNECT}&zoma=${deviceId}`),
    mintPaymentLink: jest.fn(),
    ensureClient: jest.fn(),
    consumeAuthCode: jest.fn(),
    principalAllowed: jest.fn().mockResolvedValue(true),
    links: defaultZomaLinkCodec,
    verifyMetaState: jest.fn(),
    finalizeMeta: jest.fn(),
    connectAdAccounts: jest.fn(),
    getCheckoutSession: jest.fn().mockResolvedValue({ status: 'complete', userId: 'user-1' }),
  } as unknown as ZomaDeviceFlowDeps;
  return { deps, store, advance: (ms: number) => (now += ms) };
}

/** Real readiness (mintLinks off, exactly as the device flow reads it) over a mutable account. */
function liveAccount(probe: any) {
  const state = { probe };
  const readiness = () => getZomaReadiness('user-1', onboardingDeps([metaAccount(state.probe)]), { mintLinks: false });
  return { state, readiness };
}

describe('ENG-3125 device flow: completion is withheld while the Page blocker exists', () => {
  it.each(['no_page_exists', 'page_not_granted', 'no_advertiser_role'] as const)(
    '%s: poll returns fix_meta_page with steps + a fresh connect link, and no token',
    async (reason) => {
      const { readiness } = liveAccount(PROBES[reason]);
      const h = harness(readiness);
      const r: any = await pollSetup(DEVICE_CODE, h.deps);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ next_step: 'fix_meta_page', reason, link: `${CONNECT}&zoma=${DEVICE_ID}`, interval: 5 });
      expect(r.body).not.toHaveProperty('access_token');
      expect(r.body.instructions.join('\n')).toContain(r.body.link);
      if (reason === 'no_page_exists') expect(r.body.create_page_url).toBe(META_CREATE_PAGE_URL);
      else expect(r.body.page_id).toBe('9001');
      expect(h.store.tokens.size).toBe(0);
    },
  );

  it('readiness re-derives on the next poll: once the Page is usable the token is issued', async () => {
    const live = liveAccount(PROBES.page_not_granted);
    const h = harness(live.readiness);
    expect((await pollSetup(DEVICE_CODE, h.deps)).body).toMatchObject({ next_step: 'fix_meta_page' });
    live.state.probe = { has_meta_pages: true, accessible_page_ids: ['9001'] };
    h.advance(5_000);
    const done: any = await pollSetup(DEVICE_CODE, h.deps);
    expect(done.body).toMatchObject({ next_step: 'complete', token_type: 'Bearer' });
    expect(h.store.tokens.size).toBe(1);
  });

  it('browser: continue shows the guided fix with a Reconnect Meta button, never "You\'re set"', async () => {
    const h = harness(liveAccount(PROBES.no_page_exists).readiness);
    const step: any = await continueInBrowser(DEVICE_ID, h.deps);
    expect(step).toMatchObject({ kind: 'page', retryUrl: `${CONNECT}&zoma=${DEVICE_ID}`, retryLabel: 'Reconnect Meta' });
    expect(step.done).toBeUndefined();
    expect(step.title).not.toContain("You're set");
    expect(step.steps[0]).toContain(META_CREATE_PAGE_URL);
    expect(step.steps.join(' ')).toContain('Reconnect Meta button');
  });

  it('browser: a verified Stripe return does not report success while the blocker exists', async () => {
    const live = liveAccount(PROBES.no_advertiser_role);
    const h = harness(live.readiness);
    const t = h.deps.links.sign({ purpose: 'continue', zoma: DEVICE_ID }, 3600);
    const blocked: any = await finishPayment({ t, session_id: 'cs_test_1' }, h.deps);
    expect(blocked.done).toBeUndefined();
    expect(blocked.steps.join(' ')).toContain('"Create ads"');

    live.state.probe = { has_meta_pages: true };
    const ok: any = await finishPayment({ t, session_id: 'cs_test_1' }, h.deps);
    expect(ok).toMatchObject({ kind: 'page', done: true, title: "You're set" });
  });
});

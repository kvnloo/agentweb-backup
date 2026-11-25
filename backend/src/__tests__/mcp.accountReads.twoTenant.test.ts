/**
 * ENG-2840 (W2-6a): the account reads proved through the REAL path (MCP client -> MCP server -> tool -> mcpFetch -> the real Express app and
 * routes -> Emma's real handlers -> in-memory DynamoDB), with two tenants. Only the provider-facing posts service is a double (it would call
 * LinkedIn), so what is asked of it, and as whom, is read off the double.
 *
 * What this proves beyond the unit tests: a foreign connected-account id is refused by the real resolver before any provider call, a
 * teammate's account is reachable only when it is shared with the organization (and then with the OWNER's token, as in the portal), the
 * answer memory is per caller (one tenant's read never answers another), a plain organization member is refused the two organization
 * settings reads, and an ads account id of another tenant finds nothing. Not provable here: the provider calls themselves, the settings
 * of an owner whose plan data the fake does not hold.
 */
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const { makeTwoTenantFake } = jest.requireActual('./helpers/twoTenantMcpHarness');
  const fake = makeTwoTenantFake();
  (global as any).__accountReadsFake = fake;
  actual.DynamoDB.DocumentClient = fake.documentClient;
  return actual;
});
jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-token'),
  getSecret: jest.fn().mockResolvedValue('mock-secret'),
}));
const mockPosts = jest.fn();
jest.mock('../services/socialPostsService', () => ({
  getPostsForUser: (...a: any[]) => mockPosts(...a),
}));

import app from '../app';
import { socialReadGuard } from '../mcp/server/accountReadTools';
import {
  connectCaller,
  installSelfCallFetch,
  seedTwoTenantWorld,
  snapshotTenant,
  TENANT_A,
  TENANT_B,
  type McpCaller,
  type Outcome,
  type Tenant,
} from './helpers/twoTenantMcpHarness';

const fake: any = (global as any).__accountReadsFake;
const DENIED = /Account not found or access denied/;

const ACCOUNTS = {
  A: { li: 'li-alpha', liName: 'ALPHA company page', ads: '111222333', adsName: 'ALPHA ADS ACCOUNT', slack: 'CALPHA01', mention: 'UALPHA01' },
  B: { li: 'li-bravo', liName: 'BRAVO company page', ads: '999888777', adsName: 'BRAVO ADS ACCOUNT', slack: 'CBRAVO01', mention: 'UBRAVO01' },
} as const;

let restoreFetch: () => void;
const callers: Record<string, McpCaller> = {};
beforeAll(async () => {
  restoreFetch = installSelfCallFetch(app);
  for (const userId of [TENANT_A.owner, TENANT_A.member!, TENANT_B.owner]) callers[userId] = await connectCaller(userId);
});
afterAll(async () => {
  await Promise.all(Object.values(callers).map((c) => c.close()));
  restoreFetch();
});

type Acct = Record<keyof (typeof ACCOUNTS)['A'], string>;
function seedAccounts(t: Tenant, a: Acct, shared = false): void {
  const row = fake.items('AW-Users').find((u: any) => u.userId === t.owner);
  fake.seed('AW-Users', {
    ...row,
    displayName: `${t.label} Owner`,
    companyName: `${t.label} Corp`,
    connected_accounts: [
      { platform: 'linkedin', account_id: a.li, account_name: a.liName, sharedWithOrg: shared, config: { account_type: 'company' } },
      { platform: 'facebook', account_id: `act_${a.ads}`, account_name: a.adsName, sharedWithOrg: false, config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: `act_${a.ads}` } },
    ],
  });
  const org = fake.items('AW-Organizations').find((o: any) => o.orgId === t.orgId);
  fake.seed('AW-Organizations', { ...org, leadNotifications: { enabled: true, slackChannelId: a.slack, mentions: [a.mention], maskPhone: false } });
}

beforeEach(() => {
  seedTwoTenantWorld(fake);
  seedAccounts(TENANT_A, ACCOUNTS.A);
  seedAccounts(TENANT_B, ACCOUNTS.B);
  socialReadGuard.reset();
  mockPosts.mockReset();
  mockPosts.mockImplementation(async (ownerUserId: string, options: any) => ({
    accounts: [{ accountId: options.accountId }],
    posts: [{ id: `post-by-${ownerUserId}`, accountId: options.accountId, accountName: 'a page', platform: 'linkedin', accountType: 'company', content: `a post read with ${ownerUserId}'s token`, createdAt: '2026-11-01T00:00:00.000Z', metrics: null }],
  }));
});

function expectNone(label: string, o: Outcome, markers: string[]) {
  const leaked = markers.filter((m) => o.text.includes(m));
  expect({ label, leaked }).toEqual({ label, leaked: [] });
}
const ALPHA = [ACCOUNTS.A.liName, ACCOUNTS.A.adsName, ACCOUNTS.A.slack, ACCOUNTS.A.mention, 'ALPHA Corp', 'A Owner'];
const BRAVO = [ACCOUNTS.B.liName, ACCOUNTS.B.adsName, ACCOUNTS.B.slack, ACCOUNTS.B.mention, 'BRAVO Corp', 'B Owner'];

describe('get_user_profile', () => {
  it('answers with the key\'s own user and nobody else, whatever an argument says', async () => {
    const a = await callers[TENANT_A.owner].call('get_user_profile', {});
    expect(a.isError).toBe(false);
    expect(a.json).toMatchObject({ email: `${TENANT_A.owner}@${TENANT_A.orgId}.test`, displayName: 'A Owner', companyName: 'A Corp' });
    expect(Object.keys(a.json).sort()).toEqual(['companyName', 'displayName', 'email', 'subscriptionType']);
    expectNone('own profile', a, BRAVO);
    const b = await callers[TENANT_B.owner].call('get_user_profile', { user_id: TENANT_A.owner });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/"user_id" is not an input of get_user_profile/);
    expectNone('override', b, ALPHA);
  });
});

describe('the social reads', () => {
  const posts = (caller: McpCaller, account_id: string) => caller.call('list_connected_account_posts', { account_id });

  it('the owner reads its own account, through the posts service, with its own token', async () => {
    const o = await posts(callers[TENANT_A.owner], ACCOUNTS.A.li);
    expect(o.isError).toBe(false);
    expect(o.json.success).toBe(true);
    expect(mockPosts).toHaveBeenCalledTimes(1);
    expect(mockPosts.mock.calls[0][0]).toBe(TENANT_A.owner);
    expectNone('own posts', o, BRAVO);
  });

  it.each(['list_connected_account_posts', 'load_connected_account_metrics', 'get_post_analytics'] as const)('%s: another tenant\'s account id is refused before any provider call, and nothing of it comes back', async (tool) => {
    const args = tool === 'get_post_analytics' ? { account_id: ACCOUNTS.A.li, post_ids: ['urn:li:share:1'] } : { account_id: ACCOUNTS.A.li };
    const before = snapshotTenant(fake, TENANT_A);
    const o = await callers[TENANT_B.owner].call(tool, args);
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(DENIED);
    expectNone(tool, o, ALPHA);
    expect(mockPosts).not.toHaveBeenCalled();
    expect(snapshotTenant(fake, TENANT_A)).toBe(before);
  });

  it('the answer memory is per caller: after the owner read its account, another tenant naming it is still refused, not served from the memory', async () => {
    await posts(callers[TENANT_A.owner], ACCOUNTS.A.li);
    mockPosts.mockClear();
    const o = await posts(callers[TENANT_B.owner], ACCOUNTS.A.li);
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(DENIED);
    expect(o.text).not.toContain('post-by-');
    expect(mockPosts).not.toHaveBeenCalled();
  });

  it('a teammate\'s account is reachable only once it is shared with the organization, and then with the OWNER\'s token', async () => {
    const refused = await posts(callers[TENANT_A.member!], ACCOUNTS.A.li);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(DENIED);
    expect(mockPosts).not.toHaveBeenCalled();
    seedAccounts(TENANT_A, ACCOUNTS.A, true);
    const shared = await posts(callers[TENANT_A.member!], ACCOUNTS.A.li);
    expect(shared.isError).toBe(false);
    expect(mockPosts.mock.calls[0][0]).toBe(TENANT_A.owner);
    expectNone('shared', shared, BRAVO);
  });

  it('an account id that exists on no tenant is refused the same way, and the budget counts the attempt', async () => {
    const o = await posts(callers[TENANT_A.owner], 'li-nobody');
    expect(o.isError).toBe(true);
    expect(o.text).toMatch(DENIED);
    expect(socialReadGuard.calls.size).toBe(1);
  });
});

describe('organization settings reads', () => {
  it('the organization owner reads its own lead-notification settings, and only its own', async () => {
    const a = await callers[TENANT_A.owner].call('get_lead_notification_settings', {});
    expect(a.isError).toBe(false);
    expect(a.json).toMatchObject({ success: true, enabled: true, channel: ACCOUNTS.A.slack, mentions: [ACCOUNTS.A.mention] });
    expectNone('A notification', a, BRAVO);
    const b = await callers[TENANT_B.owner].call('get_lead_notification_settings', {});
    expect(b.json).toMatchObject({ channel: ACCOUNTS.B.slack });
    expectNone('B notification', b, ALPHA);
  });

  it('a plain organization member is refused both settings reads (they hold Slack ids and phone data)', async () => {
    const n = await callers[TENANT_A.member!].call('get_lead_notification_settings', {});
    expect(n.isError).toBe(true);
    expect(n.text).toMatch(/API error \(403\).*Only organization owners and admins/);
    expectNone('member notification', n, ALPHA);
    const h = await callers[TENANT_A.member!].call('get_hot_lead_call_settings', {});
    expect(h.isError).toBe(true);
    expect(h.text).toMatch(/API error \(403\)/);
    expectNone('member hot lead', h, ALPHA);
  });

  it('an identity or organization id in the arguments is refused by name', async () => {
    for (const tool of ['get_lead_notification_settings', 'get_hot_lead_call_settings']) {
      for (const extra of ['org_id', 'orgId', 'user_id', 'client_id']) {
        const o = await callers[TENANT_B.owner].call(tool, { [extra]: TENANT_A.orgId });
        expect({ tool, extra, isError: o.isError, named: o.text.includes(`"${extra}" is not an input of ${tool}`) }).toEqual({ tool, extra, isError: true, named: true });
        expectNone(`${tool} ${extra}`, o, ALPHA);
      }
    }
  });
});

describe('get_ads_thresholds', () => {
  it('another tenant\'s ad account id finds nothing, and names nothing of it', async () => {
    for (const id of [ACCOUNTS.A.ads, `act_${ACCOUNTS.A.ads}`]) {
      const o = await callers[TENANT_B.owner].call('get_ads_thresholds', { account_id: id });
      expect(o.isError).toBe(true);
      expect(o.text).toMatch(/API error \(403\): Ad account is not one of your connected accounts/);
      expectNone('foreign ads account', o, ALPHA);
    }
  });
  it('an account name or a path trick is refused before any call', async () => {
    for (const id of [ACCOUNTS.A.adsName, '../admin', `${ACCOUNTS.A.ads}/../1`]) {
      const o = await callers[TENANT_B.owner].call('get_ads_thresholds', { account_id: id });
      expect(o.isError).toBe(true);
      expect(o.text).toMatch(/account_id must be the numeric Meta ad account id/);
    }
  });
});

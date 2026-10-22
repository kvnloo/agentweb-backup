/**
 * ENG-2605 negative controls through the REAL org-aware lookup (getAccountsWithOwnerIncludingOrgShared),
 * with only the user/org tables faked. hubspotService.orgShared.test.ts mocks that lookup wholesale, so
 * the sharedWithOrg and org-membership filtering the whole security argument rests on is exercised here.
 */
process.env.JWT_SECRET = 'test-secret';

let mockUsers: Record<string, any> = {};
let mockMembersByOrg: Record<string, any[]> = {};

jest.mock('axios');
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
    getAllUsers: jest.fn(),
    updateUser: jest.fn(),
  },
  orgDb: {
    getOrgMembers: jest.fn((orgId: string) => Promise.resolve(mockMembersByOrg[orgId] ?? [])),
  },
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's', tokenUrl: 'https://api.hubapi.com/oauth/v1/token' }),
}));

import { HubSpotService } from '../services/hubspotService';

const FRESH = () => Date.now() + 60 * 60 * 1000;
const hs = (id: string, sharedWithOrg?: boolean) => ({
  platform: 'hubspot', account_id: id, account_name: `Portal ${id}`,
  config: { access_token: `tok-${id}`, refresh_token: `ref-${id}`, token_expires_at: FRESH(), hub_id: Number(id) },
  ...(sharedWithOrg === undefined ? {} : { sharedWithOrg }),
});
const setUsers = (...users: any[]) => {
  mockUsers = Object.fromEntries(users.map(u => [u.userId, u]));
  mockMembersByOrg = {};
  for (const u of users) if (u.orgId) (mockMembersByOrg[u.orgId] ||= []).push(u);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('HubSpotService.create through the real org-aware lookup', () => {
  it('serves a teammate from an account an admin SHARED', async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', true)] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    expect((await HubSpotService.create('peer')).accountId).toBe('111');
  });

  it('NEVER serves an UNSHARED teammate account (sharedWithOrg false)', async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', false)] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    await expect(HubSpotService.create('peer')).rejects.toThrow('HubSpot account not connected');
  });

  it('NEVER serves an account whose sharedWithOrg flag was never set', async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111')] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    await expect(HubSpotService.create('peer')).rejects.toThrow('HubSpot account not connected');
  });

  it('the unshared account is unreachable even by its explicit id', async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', false)] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    await expect(HubSpotService.create('peer', '111')).rejects.toThrow('HubSpot account "111" not found');
  });

  it("a member of ANOTHER org cannot reach this org's shared account", async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', true)] }, { userId: 'alien', orgId: 'o2', connected_accounts: [] });
    await expect(HubSpotService.create('alien')).rejects.toThrow('HubSpot account not connected');
    await expect(HubSpotService.create('alien', '111')).rejects.toThrow('HubSpot account "111" not found');
  });

  it('a user in NO org gets only their own accounts', async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', true)] }, { userId: 'loner', connected_accounts: [] });
    await expect(HubSpotService.create('loner')).rejects.toThrow('HubSpot account not connected');
  });

  it("the caller's OWN account wins over a shared one", async () => {
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [hs('111', true)] }, { userId: 'peer', orgId: 'o1', connected_accounts: [hs('222')] });
    expect((await HubSpotService.create('peer')).accountId).toBe('222');
  });

  it('a shared NON-HubSpot account is not mistaken for a HubSpot one', async () => {
    const ads = { platform: 'google_ads', account_id: '333', account_name: 'Ads', config: {}, sharedWithOrg: true };
    setUsers({ userId: 'owner', orgId: 'o1', connected_accounts: [ads] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    await expect(HubSpotService.create('peer')).rejects.toThrow('HubSpot account not connected');
  });

  it('two members sharing DIFFERENT portals is ambiguous and says so', async () => {
    setUsers({ userId: 'a', orgId: 'o1', connected_accounts: [hs('111', true)] }, { userId: 'b', orgId: 'o1', connected_accounts: [hs('222', true)] }, { userId: 'peer', orgId: 'o1', connected_accounts: [] });
    await expect(HubSpotService.create('peer')).rejects.toThrow(/Multiple HubSpot accounts found/);
  });
});

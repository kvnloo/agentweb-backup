/**
 * ENG-2605: HubSpotService honours an org-shared HubSpot account.
 * The caller's own account always wins; a teammate's account is considered only when the caller has
 * none AND its owner shared it (getAccountsWithOwnerIncludingOrgShared enforces sharedWithOrg).
 * The token lifecycle must follow the OWNER: refresh and write-back go to the owner's record.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  updateAccountTokens: jest.fn(),
  updateAccountConfig: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';
import * as db from '../services/connectedAccountsDb';
import { getHubSpotConfig } from '../config/integrations';

const mockPost = axios.post as jest.Mock;
const mockGet = axios.get as jest.Mock;
const getAccountsByUserId = db.getAccountsByUserId as jest.Mock;
const getAccountById = db.getAccountById as jest.Mock;
const getShared = db.getAccountsWithOwnerIncludingOrgShared as jest.Mock;
const updateAccountTokens = db.updateAccountTokens as jest.Mock;

const FRESH = () => Date.now() + 60 * 60 * 1000;
const hubspotAccount = (id: string, over: any = {}, config: any = {}) => ({
  platform: 'hubspot',
  account_id: id,
  account_name: `Portal ${id}`,
  config: { access_token: `tok-${id}`, refresh_token: `ref-${id}`, token_expires_at: FRESH(), hub_id: Number(id), ...config },
  ...over,
});
const sharedFrom = (ownerUserId: string, id: string, config: any = {}) => ({ ...hubspotAccount(id, {}, config), sharedWithOrg: true, userId: ownerUserId });

beforeEach(() => {
  jest.resetAllMocks();
  (getHubSpotConfig as jest.Mock).mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
  });
  getAccountsByUserId.mockResolvedValue([]);
  getAccountById.mockResolvedValue(null);
  getShared.mockResolvedValue([]);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('create() without an account id', () => {
  it("the caller's OWN account wins and the org lookup is never made", async () => {
    getAccountsByUserId.mockResolvedValue([hubspotAccount('111')]);
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1');
    expect(svc.accountId).toBe('111');
    expect(getShared).not.toHaveBeenCalled();
  });

  it('a caller with no account of their own uses the single org-shared one', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1');
    expect(svc.accountId).toBe('222');
    expect(svc.portalId).toBe('222');
    expect(getShared).toHaveBeenCalledWith('caller-1');
  });

  it("an expiring shared token is refreshed and WRITTEN BACK TO THE OWNER, never the caller", async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222', { token_expires_at: 0 })]);
    mockPost.mockResolvedValue({ data: { access_token: 'new-tok', refresh_token: 'new-ref', expires_in: 1800 } });
    await HubSpotService.create('caller-1');
    expect(updateAccountTokens).toHaveBeenCalledTimes(1);
    expect(updateAccountTokens).toHaveBeenCalledWith('owner-1', 'hubspot', expect.objectContaining({ access_token: 'new-tok' }), '222');
    expect(updateAccountTokens.mock.calls.some(c => c[0] === 'caller-1')).toBe(false);
  });

  it('a token that expires mid-operation also refreshes against the OWNER record', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1');
    // Later, the service re-resolves the account for its refresh. It must look it up as the owner.
    getAccountById.mockResolvedValue(hubspotAccount('222', {}, { token_expires_at: 0 }));
    mockPost.mockResolvedValue({ data: { access_token: 'late-tok', expires_in: 1800 } });
    mockGet.mockResolvedValue({ data: { id: '1', properties: {} } });
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1000);
    await svc.getContactById('1');
    expect(getAccountById).toHaveBeenCalledWith('222', 'owner-1');
    expect(updateAccountTokens).toHaveBeenCalledWith('owner-1', 'hubspot', expect.objectContaining({ access_token: 'late-tok' }), '222');
    expect(updateAccountTokens.mock.calls.some(c => c[0] === 'caller-1')).toBe(false);
  });

  it('a mid-operation refresh stays on the ORIGINAL owner: if the owner removed the account, a teammate\'s shared copy of the same portal is NOT used', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1');
    // owner-1 has since removed the account; owner-2 shares a copy of the SAME portal id
    getAccountById.mockResolvedValue(null);
    getShared.mockResolvedValue([sharedFrom('owner-2', '222', { token_expires_at: 0 })]);
    mockPost.mockResolvedValue({ data: { access_token: 'wrong-tok', expires_in: 1800 } });
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    await expect(svc.getContactById('1')).rejects.toThrow(/not found/);
    expect(mockPost).not.toHaveBeenCalled();
    expect(updateAccountTokens).not.toHaveBeenCalled();
  });

  it('two shared accounts and none of the caller\'s: ambiguity, naming both', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222'), sharedFrom('owner-2', '333')]);
    await expect(HubSpotService.create('caller-1')).rejects.toThrow(/Multiple HubSpot accounts found: \[Portal 222 \(ID: 222\), Portal 333 \(ID: 333\)\]\. Specify account_id\./);
  });

  it('two accounts of the caller\'s own: the existing ambiguity error, shared accounts not consulted', async () => {
    getAccountsByUserId.mockResolvedValue([hubspotAccount('111'), hubspotAccount('112')]);
    await expect(HubSpotService.create('caller-1')).rejects.toThrow(/Multiple HubSpot accounts found/);
    expect(getShared).not.toHaveBeenCalled();
  });

  it('nothing own and nothing shared: the unchanged "not connected" message', async () => {
    await expect(HubSpotService.create('caller-1')).rejects.toThrow('HubSpot account not connected. Please connect your HubSpot account in Settings.');
  });

  it('only HubSpot accounts of OTHER members count (not the caller\'s own row, not other platforms)', async () => {
    getShared.mockResolvedValue([
      { platform: 'google_ads', account_id: '999', account_name: 'Ads', config: {}, sharedWithOrg: true, userId: 'owner-1' },
      { ...hubspotAccount('111'), userId: 'caller-1' },
    ]);
    await expect(HubSpotService.create('caller-1')).rejects.toThrow('HubSpot account not connected');
  });

  it('a failing org lookup reads as "no shared account", exactly the pre-sharing behaviour', async () => {
    getShared.mockRejectedValue(new Error('dynamo throttled'));
    await expect(HubSpotService.create('caller-1')).rejects.toThrow('HubSpot account not connected');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('org-shared account lookup failed'));
  });
});

describe('create() with an explicit account id', () => {
  it("the caller's own account with that id is used first", async () => {
    getAccountById.mockResolvedValue(hubspotAccount('111'));
    const svc = await HubSpotService.create('caller-1', '111');
    expect(svc.accountId).toBe('111');
    expect(getShared).not.toHaveBeenCalled();
  });

  it('an id that is a teammate\'s SHARED account resolves to it', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222'), sharedFrom('owner-2', '333')]);
    const svc = await HubSpotService.create('caller-1', '333');
    expect(svc.accountId).toBe('333');
  });

  it('an id that is neither the caller\'s nor shared: the unchanged "not found" error', async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    await expect(HubSpotService.create('caller-1', '404')).rejects.toThrow('HubSpot account "404" not found. Please reconnect your account.');
  });

  it('an own account of a different platform with that id does not satisfy it', async () => {
    getAccountById.mockResolvedValue({ platform: 'attio', account_id: '222', config: {} });
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1', '222');
    expect(svc.accountId).toBe('222');
    expect(getShared).toHaveBeenCalled();
  });
});

describe("create() with an account 'source' (Emma resolves own -> pasted token -> shared)", () => {
  it("'own' never consults shared accounts, even when the caller has none", async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    await expect(HubSpotService.create('caller-1', undefined, 'own')).rejects.toThrow('HubSpot account not connected');
    expect(getShared).not.toHaveBeenCalled();
  });

  it("'own' with an explicit id that is only a shared account is 'not found'", async () => {
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    await expect(HubSpotService.create('caller-1', '222', 'own')).rejects.toThrow('HubSpot account "222" not found');
    expect(getShared).not.toHaveBeenCalled();
  });

  it("'shared' skips the caller's own accounts entirely", async () => {
    getAccountsByUserId.mockResolvedValue([hubspotAccount('111')]);
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1', undefined, 'shared');
    expect(svc.accountId).toBe('222');
    expect(getAccountsByUserId).not.toHaveBeenCalled();
  });

  it("'shared' with an explicit id does not look at the caller's own account", async () => {
    getAccountById.mockResolvedValue(hubspotAccount('222'));
    getShared.mockResolvedValue([sharedFrom('owner-1', '222')]);
    const svc = await HubSpotService.create('caller-1', '222', 'shared');
    expect(svc.accountId).toBe('222');
    expect(getAccountById).not.toHaveBeenCalled();
  });

  it("'shared' with nothing shared: the unchanged 'not connected' message", async () => {
    await expect(HubSpotService.create('caller-1', undefined, 'shared')).rejects.toThrow('HubSpot account not connected');
  });
});


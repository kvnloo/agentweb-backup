/**
 * Org-shared connected accounts on the social READ paths (ENG-943).
 *
 * list_connected_accounts reports the caller's own accounts PLUS any a teammate
 * shared with the org. These three read helpers resolved against the caller's own
 * record only, so a listed account came back "Account not found or access denied".
 * Same access-scope split the mail tools had, on a different platform.
 *
 * The owner id also has to reach the adapter: adapters persist a refreshed token
 * with updateAccountTokens(userId, …), so passing the caller would write a
 * teammate's rotated token onto the caller's record and leave the owner's stale.
 */

// Mock unipile-node-sdk to prevent import errors (may not be installed locally)
jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountsByUserIdIncludingOrgShared: jest.fn(),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  getAccountById: jest.fn(),
  getAccountByIdConsistent: jest.fn(),
  isTokenValid: jest.fn(),
}));

jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: {
    getAdapter: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';

const mockAccessible = getAccountsWithOwnerIncludingOrgShared as jest.MockedFunction<
  typeof getAccountsWithOwnerIncludingOrgShared
>;
const mockSocial = socialPlatformService as jest.Mocked<typeof socialPlatformService>;

const CALLER = 'caller-user-1';
const OWNER = 'teammate-user-2';

/** A teammate's LinkedIn page, shared with the org — owned by OWNER, not CALLER. */
const sharedLinkedIn = {
  account_id: 'urn:li:organization:999',
  account_name: 'Shared Company Page',
  platform: 'linkedin',
  sharedWithOrg: true,
  userId: OWNER,
  config: { account_type: 'company_page', access_token: 't', token_expires_at: Date.now() + 3600000 },
};

/** The caller's own LinkedIn page — owner is the caller. */
const ownLinkedIn = {
  account_id: 'urn:li:organization:111',
  account_name: 'My Company Page',
  platform: 'linkedin',
  userId: CALLER,
  config: { account_type: 'company_page', access_token: 't', token_expires_at: Date.now() + 3600000 },
};

describe('AgentModeService — org-shared accounts on social read paths (ENG-943)', () => {
  let service: AgentModeService;
  const adapter: any = {
    getComments: jest.fn(),
    getAccountMetrics: jest.fn(),
    getPostAnalytics: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocial.getAdapter.mockReturnValue(adapter);
    // Everything the caller can reach: their own account and the teammate's shared one.
    mockAccessible.mockResolvedValue([ownLinkedIn, sharedLinkedIn] as any);
    service = new AgentModeService();
  });

  describe('listLinkedInComments', () => {
    it('reads comments on a teammate’s org-shared account as its OWNER', async () => {
      adapter.getComments.mockResolvedValue([
        { commentUrn: 'urn:li:comment:1', actorUrn: 'urn:li:person:a', text: 'hi', createdAt: 1 },
      ]);

      const result = await service.listLinkedInComments(CALLER, sharedLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(true);
      expect(adapter.getComments).toHaveBeenCalledWith(sharedLinkedIn, 'urn:li:share:1', OWNER);
    });

    it('still uses the caller’s own id for the caller’s own account', async () => {
      adapter.getComments.mockResolvedValue([]);

      const result = await service.listLinkedInComments(CALLER, ownLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(true);
      expect(adapter.getComments).toHaveBeenCalledWith(ownLinkedIn, 'urn:li:share:1', CALLER);
    });

    it('rejects an account the caller cannot reach', async () => {
      const result = await service.listLinkedInComments(CALLER, 'urn:li:organization:nope', 'urn:li:share:1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.getComments).not.toHaveBeenCalled();
    });
  });

  describe('loadConnectedAccountMetrics', () => {
    it('loads a teammate’s org-shared account metrics as its OWNER', async () => {
      adapter.getAccountMetrics.mockResolvedValue({ followers: [] });

      const result = await service.loadConnectedAccountMetrics(CALLER, sharedLinkedIn.account_id);

      expect(result.success).toBe(true);
      expect(adapter.getAccountMetrics).toHaveBeenCalledWith(sharedLinkedIn, OWNER, undefined, undefined);
    });

    it('rejects an account the caller cannot reach', async () => {
      const result = await service.loadConnectedAccountMetrics(CALLER, 'urn:li:organization:nope');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.getAccountMetrics).not.toHaveBeenCalled();
    });
  });

  describe('getPostAnalytics', () => {
    it('reads analytics on a teammate’s org-shared account as its OWNER', async () => {
      adapter.getPostAnalytics.mockResolvedValue([{ postId: 'p1' }]);

      const result = await service.getPostAnalytics(CALLER, sharedLinkedIn.account_id, ['p1']);

      expect(result.success).toBe(true);
      expect(adapter.getPostAnalytics).toHaveBeenCalledWith(sharedLinkedIn, ['p1'], OWNER);
    });

    it('rejects an account the caller cannot reach', async () => {
      const result = await service.getPostAnalytics(CALLER, 'urn:li:organization:nope', ['p1']);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.getPostAnalytics).not.toHaveBeenCalled();
    });
  });
});

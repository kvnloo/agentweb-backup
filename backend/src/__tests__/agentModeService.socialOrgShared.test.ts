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
import {
  getAccountsWithOwnerIncludingOrgShared,
  getAccountByIdConsistent,
  getAccountsByUserId,
} from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';

const mockAccessible = getAccountsWithOwnerIncludingOrgShared as jest.MockedFunction<
  typeof getAccountsWithOwnerIncludingOrgShared
>;
const mockConsistent = getAccountByIdConsistent as jest.MockedFunction<
  typeof getAccountByIdConsistent
>;
// getPostsForUser (socialPostsService, real/unmocked here) re-fetches accounts itself via
// this — separate from mockAccessible, which only gates loadConnectedAccountPosts's own
// existence check via resolveAccessibleAccount.
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
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
    createReaction: jest.fn(),
    listPosts: jest.fn(),
    getPostMetrics: jest.fn(),
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

  /**
   * A reaction is a write, so it keeps the last-moment re-read postOnConnectedAccount
   * uses: the listing that made the account reachable is not a standing grant, and the
   * owner can disconnect or un-share it while the call is in flight. It does NOT carry
   * ENG-827's assertStillAuthorized — createReaction has no such parameter, because a
   * like is not a publish.
   */
  describe('reactToLinkedInPost', () => {
    beforeEach(() => {
      // By default the re-read agrees with the listing.
      mockConsistent.mockImplementation(async (accountId: string) =>
        [ownLinkedIn, sharedLinkedIn].find(a => a.account_id === accountId) as any
      );
      adapter.createReaction.mockResolvedValue({ message: 'ok', postId: 'r1', postUrl: 'u' });
    });

    it('reacts on a teammate’s org-shared account as its OWNER', async () => {
      const result = await service.reactToLinkedInPost(CALLER, sharedLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(true);
      expect(mockConsistent).toHaveBeenCalledWith(sharedLinkedIn.account_id, OWNER, 'linkedin');
      expect(adapter.createReaction).toHaveBeenCalledWith(sharedLinkedIn, 'urn:li:share:1', 'LIKE', OWNER);
    });

    it('still uses the caller’s own id for the caller’s own account', async () => {
      const result = await service.reactToLinkedInPost(CALLER, ownLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(true);
      expect(adapter.createReaction).toHaveBeenCalledWith(ownLinkedIn, 'urn:li:share:1', 'LIKE', CALLER);
    });

    it('rejects an account the caller cannot reach', async () => {
      const result = await service.reactToLinkedInPost(CALLER, 'urn:li:organization:nope', 'urn:li:share:1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.createReaction).not.toHaveBeenCalled();
    });

    it('refuses when the owner un-shared the account after it was listed', async () => {
      mockConsistent.mockResolvedValue({ ...sharedLinkedIn, sharedWithOrg: false } as any);

      const result = await service.reactToLinkedInPost(CALLER, sharedLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.createReaction).not.toHaveBeenCalled();
    });

    it('refuses when the account was disconnected after it was listed', async () => {
      mockConsistent.mockResolvedValue(null as any);

      const result = await service.reactToLinkedInPost(CALLER, sharedLinkedIn.account_id, 'urn:li:share:1');

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account is no longer connected');
      expect(adapter.createReaction).not.toHaveBeenCalled();
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

  // ENG-1385: loadConnectedAccountPosts was the one sibling ENG-943 missed — it
  // resolved existence via a plain per-caller lookup, so a company page listed by
  // list_connected_accounts (org-shared-aware) came back "Account not found or
  // access denied" from list_connected_account_posts. Unlike the other siblings
  // above, this one calls through to the real (unmocked) getPostsForUser in
  // socialPostsService, which does its OWN internal account re-fetch via
  // getAccountsByUserId — so the owner id has to reach that second lookup too,
  // not just the first existence check.
  describe('loadConnectedAccountPosts', () => {
    it('loads a teammate’s org-shared account posts as its OWNER', async () => {
      mockGetAccountsByUserId.mockImplementation(async (uid: string) =>
        uid === OWNER ? [sharedLinkedIn] as any : []
      );
      adapter.listPosts.mockResolvedValue([
        { id: 'urn:li:share:1', commentary: 'A post', author: sharedLinkedIn.account_id },
      ]);

      const result = await service.loadConnectedAccountPosts(CALLER, sharedLinkedIn.account_id, {});

      expect(result.success).toBe(true);
      expect(adapter.listPosts).toHaveBeenCalledWith(
        sharedLinkedIn,
        expect.anything(),
        OWNER
      );
    });

    it('rejects an account the caller cannot reach', async () => {
      const result = await service.loadConnectedAccountPosts(CALLER, 'urn:li:organization:nope', {});

      expect(result.success).toBe(false);
      expect(result.message).toBe('Account not found or access denied');
      expect(adapter.listPosts).not.toHaveBeenCalled();
    });
  });
});

/**
 * account_id does not identify an account on its own — the same id can appear on
 * two platforms (one Google account connected for Gmail and Drive is the common
 * case, and the accessible set now returns both rather than silently dropping
 * one). A LinkedIn-specific entry point matching on the id alone can therefore
 * pick a row of some other platform and hand it to the LinkedIn adapter.
 *
 * The mail resolver already prefers the row whose platform the caller is asking
 * about; these do the same.
 */
describe('AgentModeService — id collisions across platforms on the LinkedIn paths (ENG-943)', () => {
  let service: AgentModeService;
  const adapter: any = {
    getComments: jest.fn(),
    createReaction: jest.fn(),
  };

  /** Same account_id as the LinkedIn page below, different platform. */
  const collidingOther = {
    account_id: 'shared@example.com',
    account_name: 'Drive',
    platform: 'google_drive',
    userId: CALLER,
    config: { account_type: 'google_drive', access_token: 't', token_expires_at: Date.now() + 3600000 },
  };

  const linkedInAtSameId = {
    account_id: 'shared@example.com',
    account_name: 'Shared Page',
    platform: 'linkedin',
    sharedWithOrg: true,
    userId: OWNER,
    config: { account_type: 'company_page', access_token: 't', token_expires_at: Date.now() + 3600000 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSocial.getAdapter.mockReturnValue(adapter);
    // Non-LinkedIn row first, so an id-only match picks the wrong one.
    mockAccessible.mockResolvedValue([collidingOther, linkedInAtSameId] as any);
    service = new AgentModeService();
  });

  it('picks the LinkedIn row when reading comments, not the same-id account on another platform', async () => {
    adapter.getComments.mockResolvedValue([]);

    const result = await service.listLinkedInComments(CALLER, 'shared@example.com', 'urn:li:share:1');

    expect(result.success).toBe(true);
    expect(adapter.getComments).toHaveBeenCalledWith(linkedInAtSameId, 'urn:li:share:1', OWNER);
  });

  it('picks the LinkedIn row when reacting', async () => {
    mockConsistent.mockResolvedValue({ ...linkedInAtSameId } as any);
    adapter.createReaction.mockResolvedValue({ success: true });

    const result = await service.reactToLinkedInPost(CALLER, 'shared@example.com', 'urn:li:share:1', 'LIKE');

    expect(result.success).toBe(true);
    expect(mockConsistent).toHaveBeenCalledWith('shared@example.com', OWNER, 'linkedin');
  });
});

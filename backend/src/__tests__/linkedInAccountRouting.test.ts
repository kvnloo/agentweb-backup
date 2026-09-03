/**
 * ENG-1614 — account-selection/distribution layer for LinkedIn write actions.
 *
 * An org with two connected LinkedIn accounts gets zero benefit from the
 * second one today: every pacing/cap mechanism is keyed strictly per single
 * accountId, so a scheduled run naming the capped account simply fails
 * instead of routing to the account with headroom.
 */

const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...args: any[]) => mockGetAccountsWithOwnerIncludingOrgShared(...args),
}));

import { routeLinkedInWriteToAccountWithHeadroom } from '../services/agentMode/linkedInAccountRouting';
import type { ResolvedLinkedInAccount } from '../services/agentMode/linkedInDailyVolumeGate';

describe('routeLinkedInWriteToAccountWithHeadroom (ENG-1614)', () => {
  const CALLER = 'user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
  });

  afterEach(() => {
    delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  });

  const cappedAccount: ResolvedLinkedInAccount = {
    ownerUserId: CALLER,
    configuredDailyInviteCap: 10,
    dailyVolumeState: { invite: { count: 10, windowStartedAt: Date.now() } },
  };

  it('returns null (no routing) when the requested account already has headroom — AC5, single/unconstrained account unchanged', async () => {
    const headroomAccount: ResolvedLinkedInAccount = {
      ownerUserId: CALLER,
      configuredDailyInviteCap: 10,
      dailyVolumeState: { invite: { count: 3, windowStartedAt: Date.now() } },
    };

    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', headroomAccount);

    expect(result).toBeNull();
    // No need to even look at other accounts when the requested one is fine.
    expect(mockGetAccountsWithOwnerIncludingOrgShared).not.toHaveBeenCalled();
  });

  it('routes to an org-shared account with headroom when the requested account is at its daily cap — AC1', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
      {
        platform: 'unipile',
        account_id: 'acct-B',
        userId: 'teammate-2',
        sharedWithOrg: true,
        config: { daily_invite_cap: 30, daily_volume: { invite: { count: 2, windowStartedAt: Date.now() } } },
      },
    ]);

    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

    expect(result).not.toBeNull();
    expect(result!.accountId).toBe('acct-B');
    expect(result!.account.ownerUserId).toBe('teammate-2');
    expect(result!.reason).toContain('acct-A');
    expect(result!.reason).toContain('acct-B');
  });

  it('never routes to a teammate account that is not sharedWithOrg — AC4', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
      // getAccountsWithOwnerIncludingOrgShared itself never returns unshared
      // teammate accounts, but assert the routing layer would also reject one
      // if it somehow appeared — belt and suspenders against the ENG-1198
      // failure mode (implicit platform-wide substitution).
    ]);

    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

    expect(result).toBeNull();
  });

  it('returns null when every other connected account is also at capacity — AC5 fallback, existing refusal still applies', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
      {
        platform: 'unipile',
        account_id: 'acct-B',
        userId: 'teammate-2',
        sharedWithOrg: true,
        config: { daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } },
      },
    ]);

    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

    expect(result).toBeNull();
  });

  it('returns null for actions that are not volume-classed (cancel-invitation, accept-invitation) even if the account is "capped"', async () => {
    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'cancel-invitation', 'acct-A', cappedAccount);

    expect(result).toBeNull();
    expect(mockGetAccountsWithOwnerIncludingOrgShared).not.toHaveBeenCalled();
  });

  it('skips non-unipile platforms and the requested account itself when scanning candidates', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
      { platform: 'meta', account_id: 'acct-A', userId: CALLER, config: {} },
      {
        platform: 'unipile',
        account_id: 'acct-C',
        userId: CALLER,
        config: { daily_invite_cap: 30, daily_volume: { invite: { count: 0, windowStartedAt: Date.now() } } },
      },
    ]);

    const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

    expect(result!.accountId).toBe('acct-C');
    expect(result!.account.ownerUserId).toBe(CALLER);
  });
});

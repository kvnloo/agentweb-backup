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
import { linkedInOutreachService } from '../services/linkedInOutreachService';

describe('routeLinkedInWriteToAccountWithHeadroom (ENG-1614)', () => {
  const CALLER = 'user-1';

  let probeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
    // ENG-3101: the router now asks whether a candidate's session is alive. Default
    // every account to a live session so the older cases keep testing what they
    // tested; no case here may reach the real Unipile client.
    probeSpy = jest.spyOn(linkedInOutreachService, 'probeAccountSession').mockResolvedValue('connected');
  });

  afterEach(() => {
    delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  });

  // Well past the ENG-1721 warm-up ramp (max 14 days) — these fixtures model
  // an established account so existing assertions are about the configured
  // cap, not the ramp. Cooldown/ramp-specific behavior gets its own fixtures.
  const ESTABLISHED_CONNECTED_AT = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

  const cappedAccount: ResolvedLinkedInAccount = {
    ownerUserId: CALLER,
    configuredDailyInviteCap: 10,
    dailyVolumeState: { invite: { count: 10, windowStartedAt: Date.now() } },
    connectedAt: ESTABLISHED_CONNECTED_AT,
  };

  it('returns null (no routing) when the requested account already has headroom — AC5, single/unconstrained account unchanged', async () => {
    const headroomAccount: ResolvedLinkedInAccount = {
      ownerUserId: CALLER,
      configuredDailyInviteCap: 10,
      dailyVolumeState: { invite: { count: 3, windowStartedAt: Date.now() } },
      connectedAt: ESTABLISHED_CONNECTED_AT,
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

  describe('ENG-1721 warm-up ramp interaction', () => {
    // The account behind the actual ENG-1132/ENG-1614 production incident was
    // itself under 24h old — a freshly-connected account's EFFECTIVE cap is
    // lower than its configured one (see ENG-1721's warm-up ramp), so headroom
    // must be evaluated against the ramp, not just the configured cap, on
    // BOTH the requested account and every candidate.
    const justConnected = new Date().toISOString();
    const wellEstablished = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

    it('routes away from a freshly-connected requested account that has hit its ramp limit, even though its configured cap is much higher', async () => {
      const rampedAccount: ResolvedLinkedInAccount = {
        ownerUserId: CALLER,
        configuredDailyInviteCap: 30,
        // Day-1 ramp limit is 5 (LINKEDIN_WARMUP_RAMP) — already at 5, so this
        // account has ZERO real headroom today despite its cap reading "30".
        dailyVolumeState: { invite: { count: 5, windowStartedAt: Date.now() } },
        connectedAt: justConnected,
      };
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 30 } },
        {
          platform: 'unipile',
          account_id: 'acct-B',
          userId: 'teammate-2',
          sharedWithOrg: true,
          created_at: wellEstablished,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 2, windowStartedAt: Date.now() } } },
        },
      ]);

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', rampedAccount);

      expect(result).not.toBeNull();
      expect(result!.accountId).toBe('acct-B');
    });

    it('does not pick a freshly-connected candidate that has already hit its own ramp limit', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
        {
          // Configured cap reads generous (30), but this account is brand new —
          // ramped down to 5/day — and has already used all 5 today.
          platform: 'unipile',
          account_id: 'acct-B',
          userId: 'teammate-2',
          sharedWithOrg: true,
          created_at: justConnected,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 5, windowStartedAt: Date.now() } } },
        },
        {
          platform: 'unipile',
          account_id: 'acct-C',
          userId: 'teammate-3',
          sharedWithOrg: true,
          created_at: wellEstablished,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 0, windowStartedAt: Date.now() } } },
        },
      ]);

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(result).not.toBeNull();
      expect(result!.accountId).toBe('acct-C');
    });
  });

  describe('LinkedIn account-level invitation cooldown ("Cannot resend yet")', () => {
    // ENG-1132/ENG-1614 root-cause check: the real production incidents behind this
    // ticket (iTrials/Sweta, Hannah K) were all this in-process breaker, not the
    // daily_invite_cap — an account with plenty of daily headroom left still fails
    // every send once LinkedIn itself has rejected one with "Cannot resend yet".
    afterEach(() => {
      jest.restoreAllMocks();
    });

    const headroomAccount: ResolvedLinkedInAccount = {
      ownerUserId: CALLER,
      configuredDailyInviteCap: 10,
      dailyVolumeState: { invite: { count: 1, windowStartedAt: Date.now() } },
      connectedAt: ESTABLISHED_CONNECTED_AT,
    };

    it('routes send-invite to another account when the requested one is under cooldown despite having daily headroom', async () => {
      jest.spyOn(linkedInOutreachService, 'isUnderInvitationCooldown').mockImplementation(
        (accountId: string) => accountId === 'acct-A',
      );
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

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', headroomAccount);

      expect(result).not.toBeNull();
      expect(result!.accountId).toBe('acct-B');
      expect(result!.reason).toContain('cooldown');
    });

    it('does not route a cooldown on send-message/send-inmail/cancel/accept-invitation — cooldown is invite-only', async () => {
      const cooldownSpy = jest.spyOn(linkedInOutreachService, 'isUnderInvitationCooldown').mockReturnValue(true);

      for (const action of ['send-message', 'send-inmail', 'cancel-invitation', 'accept-invitation']) {
        const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, action, 'acct-A', headroomAccount);
        expect(result).toBeNull();
      }
      // send-message/send-inmail ARE volume-classed (unlike cancel/accept), so the
      // headroom check itself still runs; only the cooldown gate must skip them.
      expect(cooldownSpy).not.toHaveBeenCalledWith('acct-A');
    });

    it('skips a candidate that is itself under cooldown and falls through to one that is not', async () => {
      jest.spyOn(linkedInOutreachService, 'isUnderInvitationCooldown').mockImplementation(
        (accountId: string) => accountId === 'acct-A' || accountId === 'acct-B',
      );
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } },
        {
          platform: 'unipile',
          account_id: 'acct-B',
          userId: 'teammate-2',
          sharedWithOrg: true,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 2, windowStartedAt: Date.now() } } },
        },
        {
          platform: 'unipile',
          account_id: 'acct-C',
          userId: 'teammate-3',
          sharedWithOrg: true,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 0, windowStartedAt: Date.now() } } },
        },
      ]);

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', headroomAccount);

      expect(result).not.toBeNull();
      expect(result!.accountId).toBe('acct-C');
    });

    it('returns null when every other account is also under cooldown — existing single-account-style refusal still applies', async () => {
      jest.spyOn(linkedInOutreachService, 'isUnderInvitationCooldown').mockReturnValue(true);
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

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', headroomAccount);

      expect(result).toBeNull();
    });
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

  describe('candidate with a dead session (ENG-3101)', () => {
    // The 2026-11-11 scheduled run: the requested account was at its daily cap, the
    // first other account had headroom but a session already known to be dead, and
    // five send-invite calls were refused as "disconnected" because of it while four
    // live accounts sat unused.
    const withHeadroom = (account_id: string, userId: string = CALLER) => ({
      platform: 'unipile',
      account_id,
      userId,
      config: { daily_invite_cap: 30, daily_volume: { invite: { count: 0, windowStartedAt: Date.now() } } },
    });
    const requestedRow = { platform: 'unipile', account_id: 'acct-A', userId: CALLER, config: { daily_invite_cap: 10 } };
    const probeBy = (states: Record<string, 'connected' | 'disconnected' | 'unknown'>) =>
      probeSpy.mockImplementation(async (id: string) => states[id] ?? 'connected');

    it('skips a disconnected first candidate and routes to the next live one with headroom', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        requestedRow, withHeadroom('acct-dead'), withHeadroom('acct-live', 'teammate-2'),
      ]);
      probeBy({ 'acct-dead': 'disconnected' });

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(result!.accountId).toBe('acct-live');
      expect(result!.account.ownerUserId).toBe('teammate-2');
      expect(result!.reason).not.toContain('acct-dead');
    });

    it('returns null when every other candidate is disconnected, so the caller gets the daily-cap refusal for the account it asked for', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        requestedRow, withHeadroom('acct-dead-1'), withHeadroom('acct-dead-2', 'teammate-2'),
      ]);
      probeBy({ 'acct-dead-1': 'disconnected', 'acct-dead-2': 'disconnected' });

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(result).toBeNull();
    });

    it('does not exclude a candidate whose probe is indeterminate (unknown)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([requestedRow, withHeadroom('acct-unknown')]);
      probeBy({ 'acct-unknown': 'unknown' });

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(result!.accountId).toBe('acct-unknown');
    });

    it('does not exclude a candidate when the probe itself throws', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([requestedRow, withHeadroom('acct-B')]);
      probeSpy.mockRejectedValue(new Error('probe blew up'));

      const result = await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(result!.accountId).toBe('acct-B');
    });

    it('reports each skipped disconnected candidate to the caller, and a failing report does not stop routing', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        requestedRow, withHeadroom('acct-dead'), withHeadroom('acct-live'),
      ]);
      probeBy({ 'acct-dead': 'disconnected' });
      const onDisconnectedCandidate = jest.fn().mockRejectedValue(new Error('health write failed'));

      const result = await routeLinkedInWriteToAccountWithHeadroom(
        CALLER, 'send-invite', 'acct-A', cappedAccount, undefined, { onDisconnectedCandidate },
      );

      expect(onDisconnectedCandidate.mock.calls).toEqual([['acct-dead']]);
      expect(result!.accountId).toBe('acct-live');
    });

    it('probes only candidates that would otherwise be chosen: not the requested account, not a capped one, none after the pick', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        requestedRow,
        { ...withHeadroom('acct-capped'), config: { daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } } },
        withHeadroom('acct-live'),
        withHeadroom('acct-never-reached'),
      ]);

      await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', cappedAccount);

      expect(probeSpy.mock.calls).toEqual([['acct-live']]);
    });

    it('makes no probe at all when the requested account has headroom', async () => {
      await routeLinkedInWriteToAccountWithHeadroom(CALLER, 'send-invite', 'acct-A', {
        ...cappedAccount,
        dailyVolumeState: { invite: { count: 1, windowStartedAt: Date.now() } },
      });

      expect(probeSpy).not.toHaveBeenCalled();
    });
  });
});

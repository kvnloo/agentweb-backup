/**
 * linkedInDailyVolumeGate — pins the two correctness bugs a code review
 * caught before this shipped (2026-08-25):
 *
 * 1. Ownership: a write against an org-shared LinkedIn account must persist
 *    to the account OWNER's record, not the calling user's.
 * 2. Ordering: the daily-volume reservation must not be persisted until
 *    AFTER the hourly/burst pacer also grants the write — otherwise a write
 *    refused by the hourly ceiling still burns one of the account's daily
 *    slots for nothing.
 */

const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();
const mockUpdateAccountConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../../connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...args: any[]) => mockGetAccountsWithOwnerIncludingOrgShared(...args),
  updateAccountConfig: (...args: any[]) => mockUpdateAccountConfig(...args),
}));

const mockReserveWriteSlot = jest.fn();
jest.mock('../../linkedInWritePacer', () => {
  const actual = jest.requireActual('../../linkedInWritePacer');
  return {
    ...actual,
    reserveWriteSlot: (...args: any[]) => mockReserveWriteSlot(...args),
  };
});

import {
  paceLinkedInWrite,
  resolveLinkedInAccountForWrite,
  setDailyInviteCap,
} from '../linkedInDailyVolumeGate';

const ACCOUNT_ID = 'unipile-acc-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveWriteSlot.mockResolvedValue({ allowed: true, waitedMs: 0 });
  // linkedInWritePacer's daily-cap mechanism is off (Infinity) by default
  // under Jest — opt back in so these tests actually exercise the ceiling,
  // same convention as linkedInWritePacer.test.ts.
  process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
});

afterEach(() => {
  delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
});

describe('resolveLinkedInAccountForWrite — ownership resolution', () => {
  it('returns null when the account is not connected/accessible to the caller', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'some-other-account', userId: 'user-1' },
    ]);

    const result = await resolveLinkedInAccountForWrite('user-1', ACCOUNT_ID);

    expect(result).toBeNull();
  });

  it("tags the account's real owner, not the calling user, for an org-shared account", async () => {
    // caller is 'user-2', the account belongs to 'user-1' and is shared with the org.
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: ACCOUNT_ID, userId: 'user-1', config: { daily_invite_cap: 30 } },
    ]);

    const result = await resolveLinkedInAccountForWrite('user-2', ACCOUNT_ID);

    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBe('user-1');
    expect(result!.configuredDailyInviteCap).toBe(30);
  });

  it('resolves the caller as owner for their own (non-shared) account', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: ACCOUNT_ID, userId: 'user-1' },
    ]);

    const result = await resolveLinkedInAccountForWrite('user-1', ACCOUNT_ID);

    expect(result!.ownerUserId).toBe('user-1');
  });
});

describe('paceLinkedInWrite — check ordering and persistence', () => {
  it('is a no-op for actions outside PACED_WRITE_ACTIONS — no pacer or persistence call at all', async () => {
    const result = await paceLinkedInWrite('search-people', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined }, ACCOUNT_ID);

    expect(result.refusal).toBeNull();
    expect(mockReserveWriteSlot).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('refuses on the daily cap WITHOUT ever calling the hourly/burst pacer', async () => {
    const exhausted = { invite: { count: 10, windowStartedAt: Date.now() } };

    const result = await paceLinkedInWrite('send-invite', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: exhausted }, ACCOUNT_ID);

    expect(result.refusal).not.toBeNull();
    expect(result.refusal!.message).toBe('LinkedIn daily volume limit reached');
    expect(mockReserveWriteSlot).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('does NOT persist the daily reservation when the hourly/burst pacer refuses — the exact bug this fixes', async () => {
    mockReserveWriteSlot.mockResolvedValue({ allowed: false, reason: 'hourly ceiling reached', retryAfterMs: 60_000 });

    const result = await paceLinkedInWrite('send-invite', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined }, ACCOUNT_ID);

    expect(result.refusal).not.toBeNull();
    expect(result.refusal!.message).toBe('LinkedIn write actions are being paced');
    // The daily check passed (cap was wide open) and computed a nextState,
    // but since the hourly pacer then refused, that reservation must never
    // reach the account's persisted config — otherwise a write that never
    // touched LinkedIn would have burned real daily quota.
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('persists the daily reservation, through the OWNER record, only once both checks pass', async () => {
    mockReserveWriteSlot.mockResolvedValue({ allowed: true, waitedMs: 0 });

    const result = await paceLinkedInWrite(
      'send-invite',
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: 10, dailyVolumeState: undefined },
      ACCOUNT_ID,
    );

    expect(result.refusal).toBeNull();
    expect(mockReserveWriteSlot).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(mockUpdateAccountConfig).toHaveBeenCalledTimes(1);
    const [ownerArg, platformArg, accountIdArg, updateArg] = mockUpdateAccountConfig.mock.calls[0];
    expect(ownerArg).toBe('owner-user-id'); // the OWNER, not some other id
    expect(platformArg).toBe('unipile');
    expect(accountIdArg).toBe(ACCOUNT_ID);
    expect(typeof updateArg).toBe('function');
    expect(updateArg({ daily_invite_cap: 10 }).updates.daily_volume.invite.count).toBe(1);
  });

  it('recomputes from the fresh durable state and refuses when another write used the final slot', async () => {
    mockUpdateAccountConfig.mockImplementationOnce(async (_owner: string, _platform: string, _accountId: string, mutation: any) => {
      expect(mutation({
        daily_invite_cap: 10,
        daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } },
      }).skip).toBe(true);
    });

    const result = await paceLinkedInWrite(
      'send-invite',
      { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined },
      ACCOUNT_ID,
    );

    expect(result.refusal!.message).toBe('LinkedIn daily volume limit reached');
  });

  it('fails closed when a durable daily reservation cannot be persisted', async () => {
    mockUpdateAccountConfig.mockRejectedValueOnce(new Error('boom'));

    const result = await paceLinkedInWrite(
      'send-invite',
      { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined },
      ACCOUNT_ID,
    );

    expect(result.refusal!.message).toBe('LinkedIn daily volume reservation could not be secured');
  });
});

describe('setDailyInviteCap', () => {
  it('writes the cap through the account OWNER record, not the caller', async () => {
    await setDailyInviteCap({ ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined }, ACCOUNT_ID, 30);

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('owner-user-id', 'unipile', ACCOUNT_ID, { daily_invite_cap: 30 });
  });

  it('validates and clamps the cap inside the focused gate helper', async () => {
    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined },
      ACCOUNT_ID,
      -1,
    )).rejects.toThrow('daily_invite_cap must be a non-negative number');

    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined },
      ACCOUNT_ID,
      100,
    )).resolves.toBe(30);
  });
});

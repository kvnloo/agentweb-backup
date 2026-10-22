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
  releaseLinkedInDailySlot,
  resolveLinkedInAccountForWrite,
  setDailyInviteCap,
  DailyInviteCapNotOwnerError,
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

  // Legacy rows carry two ids (account_id and Unipile's config.unipile_account_id) that can differ; either names the row.
  it("accepts a legacy row's Unipile id (config.unipile_account_id) as naming the caller's own account", async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'our-internal-id', userId: 'user-1', config: { unipile_account_id: ACCOUNT_ID } },
    ]);

    const result = await resolveLinkedInAccountForWrite('user-1', ACCOUNT_ID);

    expect(result).not.toBeNull();
    expect(result!.ownerUserId).toBe('user-1');
  });

  it("still returns the row's own id when asked by account_id", async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'our-internal-id', userId: 'user-1', config: { unipile_account_id: ACCOUNT_ID } },
    ]);
    expect(await resolveLinkedInAccountForWrite('user-1', 'our-internal-id')).not.toBeNull();
  });

  it('does NOT widen access: an id that matches neither id of any of the caller\'s rows is refused (e.g. the shared pool account)', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'our-internal-id', userId: 'user-1', config: { unipile_account_id: ACCOUNT_ID } },
    ]);
    expect(await resolveLinkedInAccountForWrite('user-1', 'site-wide-pool-account')).toBeNull();
  });

  it('ignores non-unipile rows and rows with no config', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'gmail', account_id: ACCOUNT_ID, userId: 'user-1' },
      { platform: 'unipile', account_id: 'other', userId: 'user-1' },
    ]);
    expect(await resolveLinkedInAccountForWrite('user-1', ACCOUNT_ID)).toBeNull();
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
    const result = await paceLinkedInWrite('search-people', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined }, ACCOUNT_ID);

    expect(result.refusal).toBeNull();
    expect(mockReserveWriteSlot).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('refuses on the daily cap WITHOUT ever calling the hourly/burst pacer', async () => {
    const exhausted = { invite: { count: 10, windowStartedAt: Date.now() } };

    const result = await paceLinkedInWrite('send-invite', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: exhausted, connectedAt: undefined }, ACCOUNT_ID);

    expect(result.refusal).not.toBeNull();
    expect(result.refusal!.message).toBe('LinkedIn daily volume limit reached');
    expect(mockReserveWriteSlot).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('does NOT persist the daily reservation when the hourly/burst pacer refuses — the exact bug this fixes', async () => {
    mockReserveWriteSlot.mockResolvedValue({ allowed: false, reason: 'hourly ceiling reached', retryAfterMs: 60_000 });

    const result = await paceLinkedInWrite('send-invite', { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined }, ACCOUNT_ID);

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
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined },
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
      { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
    );

    expect(result.refusal!.message).toBe('LinkedIn daily volume limit reached');
  });

  it('fails closed when a durable daily reservation cannot be persisted', async () => {
    mockUpdateAccountConfig.mockRejectedValueOnce(new Error('boom'));

    const result = await paceLinkedInWrite(
      'send-invite',
      { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
    );

    expect(result.refusal!.message).toBe('LinkedIn daily volume reservation could not be secured');
  });
});

// ENG-1873 AC2. `paceLinkedInWrite` refuses from independent sources whose messages
// are prose. The stale-invitation drain reported every one of them as "write-pacing
// limit", so a drain that withdrew nothing three times over 14 hours could not say
// why. Each refusal must now carry a machine-readable gate that callers report.
describe('paceLinkedInWrite — every refusal names its gate (ENG-1873)', () => {
  const account = { ownerUserId: 'user-1', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined };

  it('daily volume cap -> gate daily_volume', async () => {
    const exhausted = { invite: { count: 10, windowStartedAt: Date.now() } };
    const result = await paceLinkedInWrite('send-invite', { ...account, dailyVolumeState: exhausted }, ACCOUNT_ID);
    expect(result.refusal!.gate).toBe('daily_volume');
  });

  it('hourly write pacer -> gate write_pacer', async () => {
    mockReserveWriteSlot.mockResolvedValue({ allowed: false, reason: 'hourly ceiling reached', retryAfterMs: 60_000 });
    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);
    expect(result.refusal!.gate).toBe('write_pacer');
  });

  it('durable re-check finding the last slot taken -> gate daily_volume', async () => {
    mockUpdateAccountConfig.mockImplementationOnce(async (_o: string, _p: string, _a: string, mutation: any) => {
      mutation({ daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } });
    });
    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);
    expect(result.refusal!.gate).toBe('daily_volume');
  });

  it('reservation that cannot be persisted -> gate reservation_persistence', async () => {
    mockUpdateAccountConfig.mockRejectedValueOnce(new Error('boom'));
    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);
    expect(result.refusal!.gate).toBe('reservation_persistence');
  });

  // The path the drain actually takes. A cancel consumes no invite budget, but it
  // still passes through the durable daily-volume commit — so a persistence failure
  // refuses EVERY withdrawal even when both gates allow. That commit was the one
  // step the original local reproduction never exercised.
  // ENG-1594: a cancel consumes no daily budget, so it must not touch the durable
  // record at all — and therefore a persistence failure can never refuse it.
  it('cancel/accept-invitation keep hourly pacing but never persist a daily reservation', async () => {
    mockUpdateAccountConfig.mockRejectedValue(new Error('ConditionalCheckFailedException'));
    for (const action of ['cancel-invitation', 'accept-invitation']) {
      const result = await paceLinkedInWrite(action, account, ACCOUNT_ID);
      expect(result.refusal).toBeNull();
    }
    expect(mockReserveWriteSlot).toHaveBeenCalledTimes(2);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    mockUpdateAccountConfig.mockReset().mockResolvedValue(undefined);
  });

  it('cancel-invitation is still refused by the hourly pacer', async () => {
    mockReserveWriteSlot.mockResolvedValue({ allowed: false, reason: 'hourly ceiling reached', retryAfterMs: 60_000 });
    const result = await paceLinkedInWrite('cancel-invitation', account, ACCOUNT_ID);
    expect(result.refusal!.gate).toBe('write_pacer');
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});

describe('setDailyInviteCap', () => {
  it('writes the cap through the account OWNER record, not the caller', async () => {
    await setDailyInviteCap({ ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined, connectedAt: undefined }, ACCOUNT_ID, 30, 'owner-user-id');

    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('owner-user-id', 'unipile', ACCOUNT_ID, { daily_invite_cap: 30 });
  });

  it('validates and clamps the cap inside the focused gate helper', async () => {
    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
      -1,
      'owner-user-id',
    )).rejects.toThrow('daily_invite_cap must be a non-negative integer');

    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
      100,
      'owner-user-id',
    )).resolves.toBe(30);
  });

  // Regression test: Number.isFinite alone accepts fractional values, so a cap
  // of 10.5 would let reserveDailyVolumeSlot's integer count comparison permit
  // an 11th invite — exceeding the configured daily cap.
  it('ENG-1594: refuses an org-shared member who is not the owner, without persisting', async () => {
    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
      30,
      'shared-member-id',
    )).rejects.toBeInstanceOf(DailyInviteCapNotOwnerError);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('rejects a fractional cap', async () => {
    await expect(setDailyInviteCap(
      { ownerUserId: 'owner-user-id', configuredDailyInviteCap: undefined, dailyVolumeState: undefined, connectedAt: undefined },
      ACCOUNT_ID,
      10.5,
      'owner-user-id',
    )).rejects.toThrow('daily_invite_cap must be a non-negative integer');
  });
});

// ENG-1721 / ENG-1609 AC #6 — the warm-up ramp has to reach the send path from
// the ACCOUNT RECORD, not just be correct in isolation. The arithmetic is pinned
// in linkedInWarmupRamp.test.ts; this pins the wiring.
describe('warm-up ramp wiring (ENG-1721)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const accountRow = (createdAt: string | undefined, config: any = {}) => ([{
    platform: 'unipile',
    account_id: ACCOUNT_ID,
    userId: 'user-1',
    created_at: createdAt,
    config,
  }]);

  it('reads created_at off the account record', async () => {
    const createdAt = new Date(Date.now() - DAY).toISOString();
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(
      accountRow(createdAt, { daily_invite_cap: 30 }),
    );

    const resolved = await resolveLinkedInAccountForWrite('user-1', ACCOUNT_ID);

    expect(resolved).toMatchObject({ connectedAt: createdAt, configuredDailyInviteCap: 30 });
  });

  it('AC #6: a connection made yesterday is refused at the warm-up rate, not its configured 30', async () => {
    const account = {
      ownerUserId: 'user-1',
      configuredDailyInviteCap: 30,
      // Five already sent today: under the configured 30, at the warm-up 5.
      dailyVolumeState: { invite: { count: 5, windowStartedAt: Date.now() } },
      connectedAt: new Date(Date.now() - DAY).toISOString(),
    };

    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);

    expect(result.refusal).not.toBeNull();
    expect(result.refusal!.message).toBe('LinkedIn daily volume limit reached');
    expect(result.refusal!.error).toContain('safety ceiling of 5');
    // Refused before the hourly pacer and before any write, exactly like the
    // configured-cap path.
    expect(mockReserveWriteSlot).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('the same state on an ESTABLISHED connection is allowed through', async () => {
    mockUpdateAccountConfig.mockImplementation(async (_u: string, _p: string, _a: string, fn: any) => {
      fn({ daily_invite_cap: 30, daily_volume: { invite: { count: 5, windowStartedAt: Date.now() } } });
    });
    const account = {
      ownerUserId: 'user-1',
      configuredDailyInviteCap: 30,
      dailyVolumeState: { invite: { count: 5, windowStartedAt: Date.now() } },
      connectedAt: new Date(Date.now() - 200 * DAY).toISOString(),
    };

    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);

    expect(result.refusal).toBeNull();
  });

  it('applies the ramp on the DURABLE re-check too, not just the cheap first check', async () => {
    // The CAS callback re-derives the slot from freshly-read config. Reading the
    // unramped cap there would commit a reservation the first check had refused —
    // and created_at lives on the account row, not in config, so it has to come
    // from the resolved account.
    let capturedRefusal: string | undefined;
    mockUpdateAccountConfig.mockImplementation(async (_u: string, _p: string, _a: string, fn: any) => {
      // Fresh config shows 5 sent — fine for a configured 30, over the warm-up 5.
      const out = fn({ daily_invite_cap: 30, daily_volume: { invite: { count: 5, windowStartedAt: Date.now() } } });
      capturedRefusal = out?.skip ? 'skipped' : undefined;
    });
    const account = {
      ownerUserId: 'user-1',
      configuredDailyInviteCap: 30,
      // Cheap check passes (nothing sent yet in the in-memory view)...
      dailyVolumeState: { invite: { count: 0, windowStartedAt: Date.now() } },
      connectedAt: new Date(Date.now() - DAY).toISOString(),
    };

    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);

    // ...and the durable re-check catches it against the RAMPED cap.
    expect(capturedRefusal).toBe('skipped');
    expect(result.refusal).not.toBeNull();
    expect(result.refusal!.error).toContain('safety ceiling of 5');
  });

  it('an account with no created_at keeps its configured cap rather than being throttled', async () => {
    mockUpdateAccountConfig.mockImplementation(async (_u: string, _p: string, _a: string, fn: any) => {
      fn({ daily_invite_cap: 30, daily_volume: { invite: { count: 5, windowStartedAt: Date.now() } } });
    });
    const account = {
      ownerUserId: 'user-1',
      configuredDailyInviteCap: 30,
      dailyVolumeState: { invite: { count: 5, windowStartedAt: Date.now() } },
      connectedAt: undefined,
    };

    const result = await paceLinkedInWrite('send-invite', account, ACCOUNT_ID);

    expect(result.refusal).toBeNull();
  });
});

describe('ENG-2529: legacy-row id + slot release (Opslane run 725)', () => {
  it("persists the reservation under the stored account_id when the caller named the row by its Unipile id", async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'legacy-row-w5', userId: 'user-1', config: { unipile_account_id: 'unipile-legacy-w5' } },
    ]);
    const resolved = await resolveLinkedInAccountForWrite('user-1', 'unipile-legacy-w5');
    const result = await paceLinkedInWrite('send-message', resolved!, 'unipile-legacy-w5');
    expect(result.refusal).toBeNull();
    expect(mockUpdateAccountConfig.mock.calls[0][2]).toBe('legacy-row-w5');
  });

  it('releaseLinkedInDailySlot decrements the current window under the stored id', async () => {
    const acct = { ownerUserId: 'owner', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined, storedAccountId: 'row-1' };
    await releaseLinkedInDailySlot('send-message', acct, 'uni-1', 5);
    const [owner, , id, fn] = mockUpdateAccountConfig.mock.calls[0];
    expect(owner).toBe('owner');
    expect(id).toBe('row-1');
    expect(fn({ daily_volume: { message: { count: 2, windowStartedAt: 5 } } }).updates.daily_volume.message).toEqual({ count: 1, windowStartedAt: 5 });
    expect(fn({ daily_volume: { message: { count: 0, windowStartedAt: 5 } } }).skip).toBe(true);
  });

  it('releaseLinkedInDailySlot skips the refund when a new daily window started after the reservation', async () => {
    const acct = { ownerUserId: 'owner', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined, storedAccountId: 'row-1' };
    await releaseLinkedInDailySlot('send-message', acct, 'uni-1', 5);
    const fn = mockUpdateAccountConfig.mock.calls[0][3];
    expect(fn({ daily_volume: { message: { count: 1, windowStartedAt: 999 } } }).skip).toBe(true);
  });

  it('paceLinkedInWrite reserves the hourly slot under the stored account id', async () => {
    const acct = { ownerUserId: 'owner', configuredDailyInviteCap: 10, dailyVolumeState: undefined, connectedAt: undefined, storedAccountId: 'row-1' };
    mockUpdateAccountConfig.mockImplementation(async (_o: string, _p: string, _i: string, f: any) => f({ daily_invite_cap: 10 }));
    const res = await paceLinkedInWrite('send-invite', acct, 'uni-1');
    expect(res.refusal).toBeNull();
    expect(mockReserveWriteSlot).toHaveBeenCalledWith('row-1');
    expect(typeof (res as any).reservedWindowStartedAt).toBe('number');
  });

  it('releaseLinkedInDailySlot never throws when the refund cannot be persisted', async () => {
    mockUpdateAccountConfig.mockRejectedValueOnce(new Error('boom'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(releaseLinkedInDailySlot('send-message', { ownerUserId: 'o', configuredDailyInviteCap: 1, dailyVolumeState: undefined, connectedAt: undefined }, 'a')).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

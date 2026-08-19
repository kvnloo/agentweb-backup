/**
 * ENG-1197 — the scheduled-run gate for a disconnected LinkedIn account.
 *
 * The gate's whole risk is over-matching: a schedule wrongly withheld is a
 * self-inflicted outage, worse than the wasted run it was trying to prevent. So most
 * of what follows pins the cases that must NOT block.
 */

import {
  ACCOUNT_DISCONNECTED_STATUS,
  MAX_CONSECUTIVE_ACCOUNT_SKIPS,
  buildAccountSkipReason,
  countTrailingAccountSkips,
  evaluateAccountGate,
  findPinnedUnipileAccountIds,
  probeIdForAccount,
  unipileIdsForAccount,
} from '../utils/scheduledRunAccountGate';

const JENNIFER = 'tMgX8uZJTZWTG_mFY1aI2A';
const SHARED = 'mLJm4hlsQ2eVsqqA6mlTVA';

describe('findPinnedUnipileAccountIds', () => {
  it('matches an account id named verbatim in the prompt', () => {
    const message =
      'ACCOUNT + LIST: Use LinkedIn account_id tMgX8uZJTZWTG_mFY1aI2A (Jennifer Sun) for all LinkedIn actions.';

    expect(findPinnedUnipileAccountIds(message, [JENNIFER])).toEqual([JENNIFER]);
  });

  it('returns nothing when the prompt names no account at all', () => {
    // Such a schedule resolves its account at call time and already falls back off a
    // dead one, so gating it here would remove a working path rather than protect one.
    const message = 'Run the daily LinkedIn outreach for the Dream 100 list.';

    expect(findPinnedUnipileAccountIds(message, [JENNIFER])).toEqual([]);
  });

  it('ignores an id the user does not own', () => {
    // A shared/site-wide id can appear in a prompt; it is not this user's to gate on.
    const message = `Use account ${SHARED} for discovery.`;

    expect(findPinnedUnipileAccountIds(message, [JENNIFER])).toEqual([]);
  });

  it('handles a missing or empty starting message', () => {
    expect(findPinnedUnipileAccountIds(undefined, [JENNIFER])).toEqual([]);
    expect(findPinnedUnipileAccountIds(null, [JENNIFER])).toEqual([]);
    expect(findPinnedUnipileAccountIds('', [JENNIFER])).toEqual([]);
  });

  it('returns every owned id the prompt pins', () => {
    const second = 'QBdKa04gQLKTuKYEJuOLtA';
    const message = `Primary ${JENNIFER}, fallback ${second}.`;

    expect(findPinnedUnipileAccountIds(message, [JENNIFER, second])).toEqual([JENNIFER, second]);
  });

  it('does not match on a blank owned id', () => {
    // A malformed account row must not make every prompt look like a match.
    expect(findPinnedUnipileAccountIds('any prompt at all', [''])).toEqual([]);
  });
});

describe('countTrailingAccountSkips', () => {
  it('counts only the unbroken run of gate skips at the tail', () => {
    const results = [
      { status: ACCOUNT_DISCONNECTED_STATUS },
      { status: 'success' },
      { status: ACCOUNT_DISCONNECTED_STATUS },
      { status: ACCOUNT_DISCONNECTED_STATUS },
    ];

    expect(countTrailingAccountSkips(results)).toBe(2);
  });

  it('stops at a productive run', () => {
    const results = [{ status: ACCOUNT_DISCONNECTED_STATUS }, { status: 'success' }];

    expect(countTrailingAccountSkips(results)).toBe(0);
  });

  it('does not count the other gate\'s skips', () => {
    // ENG-1259's pre-check skip is a different judgement with a different remedy;
    // conflating the streaks would pause a schedule for the wrong reason.
    const results = [{ status: 'skipped_no_content' }, { status: 'skipped_no_content' }];

    expect(countTrailingAccountSkips(results)).toBe(0);
  });

  it('treats absent or malformed history as no streak', () => {
    expect(countTrailingAccountSkips(undefined)).toBe(0);
    expect(countTrailingAccountSkips(null)).toBe(0);
    expect(countTrailingAccountSkips([])).toBe(0);
    expect(countTrailingAccountSkips([{}, { status: null }])).toBe(0);
  });

  it('does not throw on a literal undefined entry in the history array', () => {
    // Distinct from `{}` above: an actual hole/undefined element hits the `?.`
    // short-circuit itself, not just an object whose `status` is absent.
    expect(countTrailingAccountSkips([undefined as any, { status: ACCOUNT_DISCONNECTED_STATUS }])).toBe(1);
    expect(countTrailingAccountSkips([{ status: ACCOUNT_DISCONNECTED_STATUS }, undefined as any])).toBe(0);
  });

  it('reaches the pause threshold only after that many consecutive skips', () => {
    const skips = Array.from({ length: MAX_CONSECUTIVE_ACCOUNT_SKIPS - 1 }, () => ({
      status: ACCOUNT_DISCONNECTED_STATUS,
    }));

    // The run being gated right now is the Nth, so the controller adds one.
    expect(countTrailingAccountSkips(skips) + 1).toBe(MAX_CONSECUTIVE_ACCOUNT_SKIPS);
    expect(countTrailingAccountSkips(skips.slice(1)) + 1).toBeLessThan(MAX_CONSECUTIVE_ACCOUNT_SKIPS);
  });
});

describe('buildAccountSkipReason', () => {
  it('names the account so an owner with several knows which to reconnect', () => {
    const reason = buildAccountSkipReason(['Jennifer Sun']);

    expect(reason).toContain('"Jennifer Sun"');
    expect(reason).toContain('Settings → Connected Accounts');
    // Says it resumes by itself — the skip deliberately leaves the schedule active.
    expect(reason).toContain('resumes');
  });

  it('reads correctly for several accounts and for none', () => {
    expect(buildAccountSkipReason(['A', 'B'])).toContain('"A" and "B"');
    expect(buildAccountSkipReason([])).toContain('The LinkedIn Outreach account this schedule uses');
  });
});

describe('evaluateAccountGate — the decision itself', () => {
  const USER = 'user-1';
  const PINNED = `Use LinkedIn account_id ${JENNIFER} (Jennifer Sun) for all LinkedIn actions.`;

  const dead = { account_id: JENNIFER, account_name: 'Jennifer Sun', config: { needs_reconnect: true } };
  const live = { account_id: JENNIFER, account_name: 'Jennifer Sun', config: {} };

  const deps = (accounts: any[], probe: any = 'disconnected') => ({
    listUnipileAccounts: jest.fn().mockResolvedValue(accounts),
    probeSession: jest.fn().mockResolvedValue(probe),
  });

  it('blocks when the pinned account is flagged dead and the probe confirms it', async () => {
    const d = deps([dead]);

    const result = await evaluateAccountGate(PINNED, USER, d);

    expect(result).toEqual({
      blocked: true,
      accountIds: [JENNIFER],
      accountNames: ['Jennifer Sun'],
    });
    expect(d.probeSession).toHaveBeenCalledWith(JENNIFER);
  });

  it('runs anyway when the flag is stale and the account is actually alive', async () => {
    // The cron refreshes the flag every 10 minutes, so it can lag a reconnect. The
    // confirming probe is what stops a stale flag withholding a working run.
    const d = deps([dead], 'connected');

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toMatchObject({ blocked: false });
  });

  it('runs anyway on an indeterminate probe', async () => {
    // A timeout is not evidence. Withholding on it would be an outage of our making.
    const d = deps([dead], 'unknown');

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toMatchObject({ blocked: false });
  });

  it('does not probe at all when the account is not flagged', async () => {
    const d = deps([live]);

    const result = await evaluateAccountGate(PINNED, USER, d);

    expect(result.blocked).toBe(false);
    // The flag is the cheap gate; the probe is only paid on the blocking path.
    expect(d.probeSession).not.toHaveBeenCalled();
  });

  it('runs when the user owns no Unipile account at all', async () => {
    const d = deps([]);

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toMatchObject({ blocked: false });
  });

  it('runs when the prompt pins no account', async () => {
    const d = deps([dead]);

    await expect(
      evaluateAccountGate('Run the daily LinkedIn outreach.', USER, d),
    ).resolves.toMatchObject({ blocked: false });
    expect(d.probeSession).not.toHaveBeenCalled();
  });

  it('runs when at least one of several pinned accounts is still live', async () => {
    const other = { account_id: 'QBdKa04gQLKTuKYEJuOLtA', account_name: 'Second', config: {} };
    const d = deps([dead, other]);

    await expect(
      evaluateAccountGate(`${PINNED} Fallback ${other.account_id}.`, USER, d),
    ).resolves.toMatchObject({ blocked: false });
  });

  it('blocks only when every pinned account is confirmed dead', async () => {
    const other = { account_id: 'QBdKa04gQLKTuKYEJuOLtA', account_name: 'Second', config: { needs_reconnect: true } };
    const d = deps([dead, other]);

    const result = await evaluateAccountGate(`${PINNED} Fallback ${other.account_id}.`, USER, d);

    expect(result.blocked).toBe(true);
    expect(result.accountIds).toEqual([JENNIFER, other.account_id]);
  });

  it('stops probing as soon as one pinned account proves alive', async () => {
    const other = { account_id: 'QBdKa04gQLKTuKYEJuOLtA', account_name: 'Second', config: { needs_reconnect: true } };
    const d = {
      listUnipileAccounts: jest.fn().mockResolvedValue([dead, other]),
      probeSession: jest.fn().mockResolvedValueOnce('connected').mockResolvedValue('disconnected'),
    };

    const result = await evaluateAccountGate(`${PINNED} Fallback ${other.account_id}.`, USER, d);

    expect(result.blocked).toBe(false);
    expect(d.probeSession).toHaveBeenCalledTimes(1);
  });

  it('runs when the account lookup returns something malformed', async () => {
    const d = {
      listUnipileAccounts: jest.fn().mockResolvedValue(undefined as any),
      probeSession: jest.fn(),
    };

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toMatchObject({ blocked: false });
    expect(d.probeSession).not.toHaveBeenCalled();
  });

  it('fails open when the account lookup throws', async () => {
    const d = {
      listUnipileAccounts: jest.fn().mockRejectedValue(new Error('dynamo unavailable')),
      probeSession: jest.fn(),
    };

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toEqual({
      blocked: false,
      accountIds: [],
      accountNames: [],
    });
  });

  it('fails open when the probe throws', async () => {
    const d = {
      listUnipileAccounts: jest.fn().mockResolvedValue([dead]),
      probeSession: jest.fn().mockRejectedValue(new Error('unipile down')),
    };

    await expect(evaluateAccountGate(PINNED, USER, d)).resolves.toMatchObject({ blocked: false });
  });

  it('falls back to the account id when the account has no name', async () => {
    const d = deps([{ account_id: JENNIFER, config: { needs_reconnect: true } }]);

    const result = await evaluateAccountGate(PINNED, USER, d);

    expect(result.accountNames).toEqual([JENNIFER]);
  });

  it('treats a row with no config object at all as live, not flagged', async () => {
    // Every other fixture in this file supplies `config: {...}`, even when empty.
    // A real DynamoDB row can omit the attribute entirely — distinct from `{}` —
    // and the gate must still default to "not known dead" rather than throw.
    const d = deps([{ account_id: JENNIFER } as any]);

    const result = await evaluateAccountGate(PINNED, USER, d);

    expect(result.blocked).toBe(false);
    expect(d.probeSession).not.toHaveBeenCalled();
  });
});

describe('unipileIdsForAccount / probeIdForAccount — a row with no config at all', () => {
  it('unipileIdsForAccount falls back to just the account_id', () => {
    expect(unipileIdsForAccount({ account_id: JENNIFER } as any)).toEqual([JENNIFER]);
  });

  it('probeIdForAccount falls back to the account_id', () => {
    expect(probeIdForAccount({ account_id: JENNIFER } as any)).toBe(JENNIFER);
  });
});

describe('a legacy row can be named by either of its two ids', () => {
  // A connected-account row carries our `account_id` AND Unipile's own
  // `config.unipile_account_id`. Usually equal; on legacy rows they differ. The sync
  // cron already resolves `config?.unipile_account_id || account_id`, and the health
  // module matches either — but this gate matched `account_id` alone, so a schedule
  // naming the Unipile token pinned nothing and the flag written on that very row was
  // never read. It fails open, so the cost is continued waste rather than an outage —
  // but withholding that run is the gate's whole job.
  const legacyRow = {
    account_id: 'legacy-row-id',
    account_name: 'Jennifer Sun',
    config: { needs_reconnect: true, unipile_account_id: 'tMgX8uZJTZWTG_mFY1aI2A' },
  };

  const deps = (probe: 'connected' | 'disconnected' | 'unknown') => ({
    listUnipileAccounts: async () => [legacyRow],
    probeSession: jest.fn(async () => probe),
  });

  it('blocks when the schedule names the Unipile id', async () => {
    const result = await evaluateAccountGate(
      'Run outreach using tMgX8uZJTZWTG_mFY1aI2A against the list.',
      'user-1',
      deps('disconnected'),
    );

    expect(result.blocked).toBe(true);
  });

  it('blocks when the schedule names our own account_id instead', async () => {
    const result = await evaluateAccountGate(
      'Run outreach using legacy-row-id against the list.',
      'user-1',
      deps('disconnected'),
    );

    expect(result.blocked).toBe(true);
  });

  it('probes the id Unipile actually knows, not our row id', async () => {
    const d = deps('disconnected');
    await evaluateAccountGate('Run outreach using legacy-row-id.', 'user-1', d);

    expect(d.probeSession).toHaveBeenCalledWith('tMgX8uZJTZWTG_mFY1aI2A');
  });

  it('reports the Unipile id, so the skip message and the pause lookup agree', async () => {
    const result = await evaluateAccountGate(
      'Run outreach using legacy-row-id.',
      'user-1',
      deps('disconnected'),
    );

    expect(result.accountIds).toEqual(['tMgX8uZJTZWTG_mFY1aI2A']);
  });

  it('still runs when a live probe contradicts the stored flag', async () => {
    const result = await evaluateAccountGate(
      'Run outreach using tMgX8uZJTZWTG_mFY1aI2A.',
      'user-1',
      deps('connected'),
    );

    expect(result.blocked).toBe(false);
  });
});

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
  findPinnedUnipileAccountIds,
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
    expect(buildAccountSkipReason([])).toContain('The LinkedIn account this schedule uses');
  });
});

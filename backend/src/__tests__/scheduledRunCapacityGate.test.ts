/**
 * ENG-1717 — the pre-send LinkedIn capacity gate (ENG-1609 AC #9).
 *
 * Like the ENG-1197 account gate, this gate's whole risk is over-matching: a
 * schedule wrongly withheld is a self-inflicted outage, worse than the wasted run it
 * was trying to prevent. Most of what follows pins the cases that must NOT block.
 */

import {
  SEND_CAPACITY_EXHAUSTED_STATUS,
  WINDOW_RENEWAL_MARGIN_MS,
  buildCapacitySkipReason,
  countTrailingCapacitySkips,
  evaluateCapacityGate,
  promptCouldPinAnAccount,
  scheduleSendsLinkedInInvites,
  type CapacityAccountLike,
} from '../utils/scheduledRunCapacityGate';
import { remainingDailyInvites } from '../services/linkedInWritePacer';

const JENNIFER = 'tMgX8uZJTZWTG_mFY1aI2A';
const ITRIALS = 'dBO0td4tS1yPXMec4n_bYg';
const HOUR = 60 * 60 * 1000;

const account = (
  id: string,
  headroom: Partial<CapacityAccountLike['headroom']>,
  extra: Partial<CapacityAccountLike> = {},
): CapacityAccountLike => ({
  account_id: id,
  account_name: `Account ${id}`,
  headroom: { remaining: 0, cap: 10, used: 10, resetsInMs: 6 * HOUR, ...headroom },
  ...extra,
});

const deps = (accounts: CapacityAccountLike[]) => ({
  listUsableAccounts: async () => accounts,
});

const OUTREACH_SCHEDULE = {
  startingMessage: 'Send connection requests to the leads in the list.',
  requiredFunctionCalls: ['linkedin_outreach'],
};

describe('scheduleSendsLinkedInInvites', () => {
  it('qualifies a schedule that declares the tool', () => {
    expect(scheduleSendsLinkedInInvites({ requiredFunctionCalls: ['linkedin_outreach'] }, [])).toBe(true);
  });

  it('qualifies a schedule that pins an account id, even with no declared tool', () => {
    // Jennifer's live "Daily Dream 100" schedule is exactly this shape:
    // requiredFunctionCalls is empty but the prompt names the account verbatim.
    expect(scheduleSendsLinkedInInvites({ requiredFunctionCalls: [] }, [JENNIFER])).toBe(true);
  });

  it('does NOT qualify a schedule that merely talks about LinkedIn', () => {
    // A production scan found 82 schedules whose prompt mentions LinkedIn and only 8
    // that declare linkedin_outreach. Reporting/ads/content schedules must not be
    // gated on an outreach account's send budget.
    const reporting = {
      startingMessage: 'Produce the monthly LinkedIn Ads performance report and email it.',
      requiredFunctionCalls: ['call_linkedin_ads_insights_api'],
    };
    expect(scheduleSendsLinkedInInvites(reporting, [])).toBe(false);
  });

  it('does not qualify on a malformed requiredFunctionCalls', () => {
    expect(scheduleSendsLinkedInInvites({ requiredFunctionCalls: null }, [])).toBe(false);
    expect(scheduleSendsLinkedInInvites(undefined, [])).toBe(false);
  });
});

describe('promptCouldPinAnAccount', () => {
  it('is false for ordinary prose', () => {
    expect(promptCouldPinAnAccount('Write the weekly blog post and email it to the team.')).toBe(false);
  });

  it('is true for every real account id shape seen in production', () => {
    // iTrials, TFA Connect, and Hannah K respectively.
    for (const id of ['dBO0td4tS1yPXMec4n_bYg', 'tMgX8uZJTZWTG_mFY1aI2A', 'NN-72jZtRD6nQSzEeK6n1g']) {
      expect(promptCouldPinAnAccount(`Use account ${id} for sends.`)).toBe(true);
    }
  });

  it('is false for a missing or empty prompt', () => {
    expect(promptCouldPinAnAccount(undefined)).toBe(false);
    expect(promptCouldPinAnAccount('')).toBe(false);
  });
});

describe('evaluateCapacityGate — must NOT block', () => {
  it('lets an unrelated schedule through WITHOUT reading accounts at all', async () => {
    // Not just "does not block" — it must cost nothing. Only 8 of 523 production
    // schedules declare the outreach tool, so a read here would tax every blog, ads
    // and reporting run on the platform to learn it was never relevant.
    const listUsableAccounts = jest.fn(async () => [account(ITRIALS, {})]);
    const result = await evaluateCapacityGate(
      { startingMessage: 'Write the weekly blog post.', requiredFunctionCalls: ['create_blog_article'] },
      'u1',
      { listUsableAccounts },
    );
    expect(result.blocked).toBe(false);
    expect(listUsableAccounts).not.toHaveBeenCalled();
  });

  it('does read accounts for a prompt that could be pinning one, even undeclared', async () => {
    // The pre-filter must never cost a real pin its gate: false positives are fine,
    // false negatives are not.
    const listUsableAccounts = jest.fn(async () => [account(JENNIFER, { remaining: 5 })]);
    const result = await evaluateCapacityGate(
      { startingMessage: `Use LinkedIn account_id ${JENNIFER}.`, requiredFunctionCalls: [] },
      'u1',
      { listUsableAccounts },
    );
    expect(result.blocked).toBe(false);
    expect(listUsableAccounts).toHaveBeenCalled();
  });

  it('lets the run through when one account still has budget', async () => {
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([
      account(ITRIALS, { remaining: 0 }),
      account(JENNIFER, { remaining: 4, used: 6 }),
    ]));
    expect(result.blocked).toBe(false);
  });

  it('lets the run through when the cap mechanism is disabled entirely (Infinity)', async () => {
    // resolveDailyInviteCap returns Infinity for the operator escape hatch. That is
    // budget, not exhaustion.
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([
      account(ITRIALS, { remaining: Infinity, cap: Infinity, used: 0, resetsInMs: 0 }),
    ]));
    expect(result.blocked).toBe(false);
  });

  it('lets the run through when the window renews within the margin', async () => {
    // The gate reads capacity once and the run takes minutes; a window about to
    // renew would make the verdict false before the run finished.
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([
      account(ITRIALS, { remaining: 0, resetsInMs: WINDOW_RENEWAL_MARGIN_MS - 1 }),
    ]));
    expect(result.blocked).toBe(false);
  });

  it('lets the run through when the user has no connected outreach account', async () => {
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([]));
    expect(result.blocked).toBe(false);
  });

  it('lets the run through when a pinned id matches nothing we hold', async () => {
    const result = await evaluateCapacityGate(
      { startingMessage: `Use account ${JENNIFER}.`, requiredFunctionCalls: [] },
      'u1',
      deps([account(ITRIALS, { remaining: 0 })]),
    );
    expect(result.blocked).toBe(false);
  });

  it('judges only the pinned account, ignoring an unrelated exhausted one', async () => {
    const result = await evaluateCapacityGate(
      { startingMessage: `Use LinkedIn account_id ${JENNIFER} for all actions.`, requiredFunctionCalls: [] },
      'u1',
      deps([account(JENNIFER, { remaining: 3 }), account(ITRIALS, { remaining: 0 })]),
    );
    expect(result.blocked).toBe(false);
  });

  it('fails open when the account lookup throws', async () => {
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', {
      listUsableAccounts: async () => { throw new Error('dynamo down'); },
    });
    expect(result.blocked).toBe(false);
  });
});

describe('evaluateCapacityGate — must block', () => {
  it('blocks when the only account has no budget left', async () => {
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([
      account(ITRIALS, { remaining: 0, cap: 10, used: 10 }),
    ]));
    expect(result.blocked).toBe(true);
    expect(result.accounts.map((a) => a.account_id)).toEqual([ITRIALS]);
  });

  it('blocks when EVERY account is exhausted', async () => {
    const result = await evaluateCapacityGate(OUTREACH_SCHEDULE, 'u1', deps([
      account(ITRIALS, { remaining: 0 }),
      account(JENNIFER, { remaining: 0 }),
    ]));
    expect(result.blocked).toBe(true);
    expect(result.accounts).toHaveLength(2);
  });

  it('blocks a pin-qualified schedule that declares no tool', async () => {
    const result = await evaluateCapacityGate(
      { startingMessage: `ACCOUNT: use ${JENNIFER} for all LinkedIn actions.`, requiredFunctionCalls: [] },
      'u1',
      deps([account(JENNIFER, { remaining: 0 })]),
    );
    expect(result.blocked).toBe(true);
  });

  it('matches a pin naming the legacy Unipile id on a row keyed by another id', async () => {
    // ENG-1197 fixed exactly this: a row carries both our account_id and Unipile's
    // config.unipile_account_id, and a prompt may name either.
    const result = await evaluateCapacityGate(
      { startingMessage: `Use ${JENNIFER}.`, requiredFunctionCalls: [] },
      'u1',
      deps([account('legacy-row-id', { remaining: 0 }, { config: { unipile_account_id: JENNIFER } })]),
    );
    expect(result.blocked).toBe(true);
  });
});

describe('buildCapacitySkipReason', () => {
  it('names the account, the cap, the renewal and the backlog', () => {
    const text = buildCapacitySkipReason([
      account(ITRIALS, { remaining: 0, cap: 30, used: 30, resetsInMs: 3 * HOUR }, { pendingCount: 393 }),
    ]);
    expect(text).toContain('30 of its 30');
    expect(text).toContain('393 invitations still pending');
    expect(text).toContain('in about 3 hours');
    expect(text).toContain('Settings');
  });

  it('omits the backlog sentence when the count was unavailable', () => {
    const text = buildCapacitySkipReason([account(ITRIALS, {}, { pendingCount: null })]);
    expect(text).not.toContain('still pending');
  });

  it('describes a user-configured zero cap as a block, not an exhausted budget', () => {
    // resolveDailyInviteCap keeps a user's own 0 as a real zero. It never renews, so
    // promising the customer it will is wrong.
    const text = buildCapacitySkipReason([account(ITRIALS, { remaining: 0, cap: 0, used: 0 })]);
    expect(text).toContain('daily invite cap of 0');
    expect(text).not.toContain('renews');
  });
});

describe('countTrailingCapacitySkips', () => {
  it('counts only the trailing run of this gate\'s own status', () => {
    expect(countTrailingCapacitySkips([
      { status: 'success' },
      { status: SEND_CAPACITY_EXHAUSTED_STATUS },
      { status: SEND_CAPACITY_EXHAUSTED_STATUS },
    ])).toBe(2);
  });

  it('does not confuse another gate\'s skip status for its own', () => {
    expect(countTrailingCapacitySkips([
      { status: SEND_CAPACITY_EXHAUSTED_STATUS },
      { status: 'skipped_account_disconnected' },
    ])).toBe(0);
  });

  it('tolerates a missing or malformed run history', () => {
    expect(countTrailingCapacitySkips(undefined)).toBe(0);
    expect(countTrailingCapacitySkips(null)).toBe(0);
  });
});

describe('remainingDailyInvites — the arithmetic the gate trusts', () => {
  const NOW = 1_788_000_000_000;
  const now = () => NOW;

  beforeEach(() => {
    // dailyInviteAbsoluteMax() is 0 under Jest, which resolveDailyInviteCap reads as
    // "operator disabled -> Infinity". Without this the assertions below silently
    // measure nothing.
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
  });
  afterEach(() => { delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX; });

  it('reports the full cap for an account that has never sent', () => {
    expect(remainingDailyInvites(10, undefined, { now })).toEqual({
      remaining: 10, cap: 10, used: 0, resetsInMs: 0,
    });
  });

  it('defaults an unconfigured account to the conservative 10, not the 30 ceiling', () => {
    // 14 of 16 production accounts have no daily_invite_cap set.
    expect(remainingDailyInvites(undefined, undefined, { now }).cap).toBe(10);
  });

  it('clamps a configured cap to the absolute ceiling', () => {
    expect(remainingDailyInvites(999, undefined, { now }).cap).toBe(30);
  });

  it('subtracts what the current window has already used', () => {
    const state = { invite: { count: 19, windowStartedAt: NOW - 2 * HOUR } };
    expect(remainingDailyInvites(30, state, { now })).toEqual({
      remaining: 11, cap: 30, used: 19, resetsInMs: 22 * HOUR,
    });
  });

  it('reports zero remaining at the cap, with the time until renewal', () => {
    const state = { invite: { count: 10, windowStartedAt: NOW - 20 * HOUR } };
    expect(remainingDailyInvites(10, state, { now })).toEqual({
      remaining: 0, cap: 10, used: 10, resetsInMs: 4 * HOUR,
    });
  });

  it('treats an expired window as a fresh full budget', () => {
    const state = { invite: { count: 10, windowStartedAt: NOW - 25 * HOUR } };
    expect(remainingDailyInvites(10, state, { now })).toMatchObject({ remaining: 10, used: 0 });
  });

  it('keeps a user-configured 0 a real block, never unlimited', () => {
    expect(remainingDailyInvites(0, undefined, { now })).toMatchObject({ remaining: 0, cap: 0 });
  });

  it('reports Infinity when the operator disabled the mechanism', () => {
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '0';
    expect(remainingDailyInvites(10, undefined, { now })).toMatchObject({ remaining: Infinity });
  });

  it('never disagrees with reserveDailyVolumeSlot about the same state', () => {
    // The two must stay in lockstep: they share readDailyWindow precisely so a
    // second implementation cannot drift. Walk a window to exhaustion and assert
    // remaining hits 0 exactly when the reservation starts refusing.
    const { reserveDailyVolumeSlot } = require('../services/linkedInWritePacer');
    let state: any = undefined;
    for (let i = 0; i < 10; i++) {
      expect(remainingDailyInvites(10, state, { now }).remaining).toBe(10 - i);
      const slot = reserveDailyVolumeSlot('send-invite', 10, state, { now });
      expect(slot.allowed).toBe(true);
      state = slot.nextState;
    }
    expect(remainingDailyInvites(10, state, { now }).remaining).toBe(0);
    expect(reserveDailyVolumeSlot('send-invite', 10, state, { now }).allowed).toBe(false);
  });
});

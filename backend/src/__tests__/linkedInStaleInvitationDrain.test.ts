// ENG-1719 / ENG-1609 AC #8 — bulk withdraw to reclaim pending capacity.
//
// Requested on ENG-1132 on 2026-08-11 and still unbuilt: Hannah K ~105 pending,
// TFA Connect / Jennifer Sun 539, still throttling her sends (ENG-1640).
// Reclaiming that today means one cancel-invitation call per invitation.

import { reserveDailyVolumeSlot } from '../services/linkedInWritePacer';
import { PACED_WRITE_ACTIONS } from '../services/linkedInWritePacer';
import {
  DEFAULT_MAX_WITHDRAWALS_PER_RUN,
  selectStaleInvitations,
  withdrawStaleInvitations,
  type StaleInvitationDrainDeps,
} from '../services/agentMode/linkedInStaleInvitationDrain';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-07T12:00:00.000Z');

const row = (publicId: string, ageDays: number, over: any = {}) => ({
  accountId: 'acc-1',
  invitedUserPublicId: publicId,
  publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
  invitationId: `inv-${publicId}`,
  invitedUserName: publicId.toUpperCase(),
  invitationText: '',
  sentAt: new Date(NOW - ageDays * DAY).toISOString(),
  syncedAt: new Date(NOW).toISOString(),
  ...over,
});

describe('selectStaleInvitations (AC #5)', () => {
  it('withdraws only rows older than N, oldest first', () => {
    const rows = [row('young', 2), row('old', 40), row('mid', 20), row('edge', 14)];
    const sel = selectStaleInvitations(rows, 14, NOW);

    expect(sel.candidates.map((c) => c.invitedUserPublicId)).toEqual(['old', 'mid', 'edge']);
    expect(sel.totalStale).toBe(3);
    expect(sel.totalPending).toBe(4);
    expect(sel.candidates[0]).toMatchObject({ invitationId: 'inv-old', ageDays: 40 });
  });

  it('is oldest-first so a run cut short by the pacer did the most valuable part', () => {
    const sel = selectStaleInvitations([row('b', 30), row('c', 90), row('a', 45)], 14, NOW);
    expect(sel.candidates.map((c) => c.ageDays)).toEqual([90, 45, 30]);
  });

  it('treats an unusable or future sentAt as "do not touch", never as old', () => {
    // Age is the entire basis of the decision, so an unparseable timestamp must
    // not be read as "probably old" — that would withdraw a fresh invitation.
    const rows = [
      row('nodate', 40, { sentAt: undefined }),
      row('bad', 40, { sentAt: 'not-a-date' }),
      row('future', 40, { sentAt: new Date(NOW + 5 * DAY).toISOString() }),
      row('real', 40),
    ];
    const sel = selectStaleInvitations(rows, 14, NOW);
    expect(sel.candidates.map((c) => c.invitedUserPublicId)).toEqual(['real']);
    expect(sel.unwithdrawable).toBe(0);
  });

  it('counts old rows with no invitationId as unwithdrawable rather than dropping them', () => {
    // "Nothing was old enough" and "we cannot act on these" are different facts —
    // collapsing them is the silence ENG-1718 removed from the read path.
    const sel = selectStaleInvitations([row('a', 40, { invitationId: '' }), row('b', 40)], 14, NOW);
    expect(sel.candidates.map((c) => c.invitedUserPublicId)).toEqual(['b']);
    expect(sel.unwithdrawable).toBe(1);
    expect(sel.totalStale).toBe(1);
  });

  it('caps the run and never exceeds the hard per-run maximum', () => {
    const many = Array.from({ length: 100 }, (_, i) => row(`p${i}`, 30 + i));
    expect(selectStaleInvitations(many, 14, NOW, 5).candidates).toHaveLength(5);
    expect(selectStaleInvitations(many, 14, NOW).candidates).toHaveLength(DEFAULT_MAX_WITHDRAWALS_PER_RUN);
    // A caller asking for more than the maximum is clamped, not obeyed.
    expect(selectStaleInvitations(many, 14, NOW, 500).candidates).toHaveLength(DEFAULT_MAX_WITHDRAWALS_PER_RUN);
    expect(selectStaleInvitations(many, 14, NOW, 0).candidates).toHaveLength(DEFAULT_MAX_WITHDRAWALS_PER_RUN);
    expect(selectStaleInvitations(many, 14, NOW).totalStale).toBe(100);
  });

  it('floors the threshold at 1 day and handles an empty/missing ledger', () => {
    expect(selectStaleInvitations([row('a', 2)], 0, NOW).candidates).toHaveLength(1);
    [null, undefined, []].forEach((rows) => {
      expect(selectStaleInvitations(rows as any, 14, NOW)).toMatchObject({
        candidates: [], totalStale: 0, totalPending: 0, unwithdrawable: 0,
      });
    });
  });
});

describe('withdrawStaleInvitations', () => {
  const makeDeps = (rows: any[], over: Partial<StaleInvitationDrainDeps> = {}): StaleInvitationDrainDeps => ({
    fetchPending: jest.fn(async () => rows),
    pace: jest.fn(async () => null),
    cancel: jest.fn(async () => {}),
    forget: jest.fn(async () => 1),
    now: () => NOW,
    ...over,
  });

  it('AC #1: withdraws the whole batch through one call', async () => {
    const deps = makeDeps([row('a', 40), row('b', 30), row('young', 2)]);
    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(deps.cancel).toHaveBeenCalledTimes(2);
    expect(result.withdrawn.map((w) => w.publicProfileUrl)).toEqual([
      'https://www.linkedin.com/in/a/',
      'https://www.linkedin.com/in/b/',
    ]);
    expect(result.stopReason).toBe('completed');
    expect(result.remainingStale).toBe(0);
    expect(result.totalPending).toBe(3);
  });

  it('AC #4: reports who and when-originally-sent for every withdrawal', async () => {
    const deps = makeDeps([row('a', 40)]);
    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.withdrawn[0]).toEqual({
      invitedUserName: 'A',
      publicProfileUrl: 'https://www.linkedin.com/in/a/',
      sentAt: new Date(NOW - 40 * DAY).toISOString(),
      ageDays: 40,
    });
  });

  it('AC #4: drops the ledger row so the CRM stops showing "invitation pending"', async () => {
    const deps = makeDeps([row('a', 40)]);
    await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });
    expect(deps.forget).toHaveBeenCalledWith('acc-1', 'inv-a');
  });

  it('AC #2: paces EVERY withdrawal — never reserves once and loops', async () => {
    // Reserving one slot and then looping is exactly the burst that gets an
    // account's LinkedIn session revoked.
    const deps = makeDeps([row('a', 40), row('b', 30), row('c', 20)]);
    await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });
    expect(deps.pace).toHaveBeenCalledTimes(3);
  });

  it('AC #2: checkpoints on a pacer refusal instead of failing or retrying', async () => {
    let calls = 0;
    const deps = makeDeps([row('a', 40), row('b', 30), row('c', 20)], {
      pace: jest.fn(async () => (++calls > 1 ? 'LinkedIn write actions are being paced' : null)),
    });

    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.withdrawn).toHaveLength(1);
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('paced');
    expect(result.remainingStale).toBe(2);
    expect(result.notice).toContain('at its write-pacing limit');
    expect(result.notice).toContain('not a LinkedIn rejection');
  });

  it('refused on the very first slot is a clean no-op report, not an error', async () => {
    const deps = makeDeps([row('a', 40)], { pace: jest.fn(async () => 'paced') });
    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(deps.cancel).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('paced');
    expect(result.withdrawn).toHaveLength(0);
    expect(result.remainingStale).toBe(1);
  });

  it('reports a per-invitation failure and keeps going', async () => {
    const deps = makeDeps([row('a', 40), row('b', 30)], {
      cancel: jest.fn(async (id: string) => {
        if (id === 'inv-a') throw new Error('invitation no longer exists');
      }),
    });

    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.failed).toEqual([{
      invitedUserName: 'A',
      publicProfileUrl: 'https://www.linkedin.com/in/a/',
      reason: 'invitation no longer exists',
    }]);
    expect(result.withdrawn).toHaveLength(1);
    // A failed withdrawal is still stale and still pending.
    expect(result.remainingStale).toBe(1);
    expect(result.notice).toContain('could not be withdrawn');
    // The failed one's ledger row is NOT dropped — it is still pending.
    expect(deps.forget).toHaveBeenCalledTimes(1);
    expect(deps.forget).toHaveBeenCalledWith('acc-1', 'inv-b');
  });

  it('a ledger-cleanup or CRM failure never turns a completed withdrawal into a failure', async () => {
    // The invitation IS gone on LinkedIn's side by then; reporting otherwise
    // would be the false report ENG-1718 removed from the read path.
    const deps = makeDeps([row('a', 40)], {
      forget: jest.fn(async () => { throw new Error('dynamo down'); }),
      recordWithdrawal: jest.fn(async () => { throw new Error('crm down'); }),
    });

    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.withdrawn).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });

  // CodeRabbit on PR #2801: not turning them into failures was right; SWALLOWING
  // them was not. A silent cleanup failure let the run claim a clean sweep while
  // the CRM still showed the person as pending.
  it('reports a ledger-cleanup failure instead of claiming a clean sweep', async () => {
    const deps = makeDeps([row('a', 40)], {
      forget: jest.fn(async () => { throw new Error('dynamo down'); }),
    });

    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.withdrawn).toHaveLength(1);
    expect(result.ledgerCleanupFailed).toEqual([
      { invitedUserName: 'A', publicProfileUrl: 'https://www.linkedin.com/in/a/' },
    ]);
    expect(result.notice).toContain('could not be cleared from our own records');
    expect(result.notice).toContain('next sync');
  });

  it('reports a CRM provenance failure, and says nothing retries it', async () => {
    // Unlike the cache row, nothing re-runs this: the only automatic
    // reconciliation walks still-pending invitations, and this one is not.
    const deps = makeDeps([row('a', 40)], {
      recordWithdrawal: jest.fn(async () => { throw new Error('crm down'); }),
    });

    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.withdrawn).toHaveLength(1);
    expect(result.crmRecordFailed).toEqual([
      { invitedUserName: 'A', publicProfileUrl: 'https://www.linkedin.com/in/a/' },
    ]);
    expect(result.notice).toContain('will not show the withdrawal in their history');
    expect(result.notice).toContain('Nothing retries this automatically');
  });

  it('a clean run reports both lists empty', async () => {
    const result = await withdrawStaleInvitations({
      accountId: 'acc-1', olderThanDays: 14, deps: makeDeps([row('a', 40)]),
    });
    expect(result.ledgerCleanupFailed).toEqual([]);
    expect(result.crmRecordFailed).toEqual([]);
    expect(result.notice).not.toContain('could not be cleared');
  });

  it('stops at its own budget and says how many remain', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`p${i}`, 30 + i));
    const deps = makeDeps(rows);

    const result = await withdrawStaleInvitations({
      accountId: 'acc-1', olderThanDays: 14, maxWithdrawals: 3, deps,
    });

    expect(result.withdrawn).toHaveLength(3);
    expect(result.stopReason).toBe('limit_reached');
    expect(result.remainingStale).toBe(7);
    expect(result.notice).toContain("this run's withdrawal budget");
  });

  it('always produces a relayable notice, including when nothing qualified', async () => {
    const deps = makeDeps([row('young', 2)]);
    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(deps.cancel).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('completed');
    expect(result.notice).toContain('Withdrew nothing older than 14 days');
    expect(result.notice).toContain('1 invitation was pending');
  });

  it('surfaces invitations it cannot withdraw rather than silently ignoring them', async () => {
    const deps = makeDeps([row('a', 40, { invitationId: '' })]);
    const result = await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(result.unwithdrawable).toBe(1);
    expect(result.notice).toContain('no withdrawable id in our records');
  });

  it('records CRM provenance for each withdrawal when a recorder is supplied', async () => {
    const recordWithdrawal = jest.fn(async () => ({ leadId: 'l1', listId: 'list1' }));
    const deps = makeDeps([row('a', 40)], { recordWithdrawal });

    await withdrawStaleInvitations({ accountId: 'acc-1', olderThanDays: 14, deps });

    expect(recordWithdrawal).toHaveBeenCalledWith(expect.objectContaining({
      invitationId: 'inv-a',
      publicProfileUrl: 'https://www.linkedin.com/in/a/',
    }));
  });
});

describe('AC #3: a drain is account maintenance, not send volume (drift guard)', () => {
  const OLD = process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
  beforeEach(() => { process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30'; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
    else process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = OLD;
  });

  it('withdrawals never consume the daily invite budget, however many are drained', () => {
    // dailyVolumeClassFor returns null for cancel/accept on purpose. If that ever
    // changed, a 40-withdrawal drain would silently eat the whole day's sending
    // allowance — the opposite of reclaiming capacity.
    const now = () => NOW;
    let state: any = {};
    for (let i = 0; i < 40; i++) {
      const slot = reserveDailyVolumeSlot('cancel-invitation', 10, state, { now });
      expect(slot.allowed).toBe(true);
      if (slot.allowed) state = slot.nextState;
    }
    expect(state.invite).toBeUndefined();
    // The account's full send allowance is still intact afterwards.
    let sends = 0;
    let sendState = state;
    for (let i = 0; i < 20; i++) {
      const slot = reserveDailyVolumeSlot('send-invite', 10, sendState, { now });
      if (!slot.allowed) break;
      sends++;
      sendState = slot.nextState;
    }
    expect(sends).toBe(10);
  });

  it('each individual withdrawal IS a paced write — the drain cannot outrun the pacer', () => {
    expect(PACED_WRITE_ACTIONS.has('cancel-invitation')).toBe(true);
    // The umbrella action deliberately is NOT paced itself: it performs no
    // LinkedIn write of its own, and pacing it would consume a slot on top of the
    // one each withdrawal already reserves.
    expect(PACED_WRITE_ACTIONS.has('withdraw-stale-invitations')).toBe(false);
  });
});

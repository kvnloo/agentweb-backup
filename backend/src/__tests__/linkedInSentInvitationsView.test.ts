/**
 * ENG-1718 — list-sent-invitations must never return a bare empty result.
 *
 * The incident (ENG-1132, iTrials/Sweta Sinha, 2026-08-26): two calls returned `{}`
 * while an account-level cooldown was actively firing, so the suggested remedy
 * (list the backlog, withdraw the stale ones) was not actionable. Our own ledger
 * held 126 pending invitations for that exact account at the time — nothing asked
 * it, because this action only ever read live.
 *
 * Every case below pins one of the named outcomes. The one thing that must never
 * happen again is an empty answer that looks like an authoritative "you have none".
 */

import {
  MAX_RETURNED_INVITATIONS,
  SENT_AT_PRECISION_NOTE,
  earliestSentAt,
  getSentInvitationsView,
} from '../services/agentMode/linkedInSentInvitationsView';

const ACCOUNT = 'dBO0td4tS1yPXMec4n_bYg';

const liveItem = (id: string, date: string) => ({
  object: 'InvitationSent',
  id,
  date,
  parsed_datetime: date,
  invited_user: `User ${id}`,
  invited_user_id: `uid-${id}`,
  invited_user_public_id: `pub-${id}`,
});

const cachedRow = (publicId: string, sentAt: string) => ({
  accountId: ACCOUNT,
  invitedUserPublicId: publicId,
  invitationId: `inv-${publicId}`,
  invitedUserName: `Name ${publicId}`,
  sentAt,
});

const deps = (live: any, cached: any[] = []) => ({
  fetchLive: jest.fn(async () => (typeof live === 'function' ? live() : live)),
  fetchCached: jest.fn(async () => cached),
});

describe('getSentInvitationsView — live read succeeds', () => {
  it('returns live rows, carrying sent_at so age is knowable', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({
      object: 'InvitationList',
      items: [liveItem('a', '2026-08-01T00:00:00Z'), liveItem('b', '2026-08-20T00:00:00Z')],
      cursor: null,
    }));

    expect(view.source).toBe('live');
    expect(view.totalPending).toBe(2);
    expect(view.items[0]).toEqual({
      id: 'a',
      invited_user_id: 'uid-a',
      invited_user_public_id: 'pub-a',
      invited_user: 'User a',
      sent_at: '2026-08-01T00:00:00Z',
    });
    // The old trim dropped the date entirely, which is why "withdraw invitations
    // older than N days" (ENG-1719) could not be built on this action's output.
    expect(view.items.every((i) => i.sent_at)).toBe(true);
    expect(view.notice).toContain('2 pending invitations');
  });

  it('caps the returned rows but still reports the true backlog size', async () => {
    const items = Array.from({ length: 375 }, (_, i) => liveItem(`a${i}`, '2026-08-01T00:00:00Z'));
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({ object: 'InvitationList', items, cursor: null }));

    expect(view.items).toHaveLength(MAX_RETURNED_INVITATIONS);
    expect(view.totalPending).toBe(375);
    expect(view.notice).toContain('375 pending invitations');
  });
});

describe('getSentInvitationsView — the ENG-1132 failure modes', () => {
  it('falls back to our ledger when the live read is non-conforming (the observed `{}`)', async () => {
    // The exact shape the SDK passes through at validateRequestPayloadLevel 'warn'.
    const d = deps({}, [cachedRow('sweta-1', '2026-07-01T00:00:00Z')]);
    const view = await getSentInvitationsView(ACCOUNT, undefined, d);

    expect(view.source).toBe('cache');
    expect(view.liveUnavailable).toBe(true);
    expect(view.totalPending).toBe(1);
    expect(view.notice).toContain('live read was unavailable');
    expect(d.fetchCached).toHaveBeenCalledWith(ACCOUNT);
  });

  it('falls back to our ledger when live says zero but we still hold records', async () => {
    // This is the incident precisely: a live zero during an active cooldown, with
    // 126 rows sitting in AW-UnipileSentInvitations for the same account.
    const cached = Array.from({ length: 126 }, (_, i) => cachedRow(`p${i}`, '2026-08-01T00:00:00Z'));
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({ object: 'InvitationList', items: [], cursor: null }, cached));

    expect(view.source).toBe('cache');
    expect(view.totalPending).toBe(126);
    expect(view.liveUnavailable).toBeUndefined();
    expect(view.notice).toContain('our own records');
  });

  it('falls back to our ledger when the live read throws', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, {
      fetchLive: async () => { throw new Error('502 Bad Gateway'); },
      fetchCached: async () => [cachedRow('x', '2026-06-01T00:00:00Z')],
    });

    expect(view.source).toBe('cache');
    expect(view.liveUnavailable).toBe(true);
    expect(view.notice).toContain('502 Bad Gateway');
  });

  it('returns cached rows OLDEST FIRST — those are the ones worth withdrawing', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({}, [
      cachedRow('new', '2026-08-30T00:00:00Z'),
      cachedRow('old', '2026-01-15T00:00:00Z'),
      cachedRow('mid', '2026-05-05T00:00:00Z'),
    ]));

    expect(view.items.map((i) => i.invited_user_public_id)).toEqual(['old', 'mid', 'new']);
  });
});

describe('getSentInvitationsView — the two kinds of nothing', () => {
  it('distinguishes "genuinely none tracked" and names the outside-AgentWeb possibility', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({ object: 'InvitationList', items: [], cursor: null }, []));

    expect(view.source).toBe('none');
    expect(view.liveUnavailable).toBeUndefined();
    expect(view.notice).toContain('outside AgentWeb');
    expect(view.notice).not.toHaveLength(0);
  });

  it('never lets "could not read" masquerade as "has none"', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, {
      fetchLive: async () => { throw new Error('timeout'); },
      fetchCached: async () => [],
    });

    expect(view.source).toBe('none');
    expect(view.liveUnavailable).toBe(true);
    expect(view.notice).toContain('NOT evidence');
  });

  it('still answers when BOTH the live read and the cache fail', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, {
      fetchLive: async () => { throw new Error('timeout'); },
      fetchCached: async () => { throw new Error('dynamo down'); },
    });

    expect(view.source).toBe('none');
    expect(view.liveUnavailable).toBe(true);
    expect(view.notice).toContain('could not be read either');
  });

  it('every outcome carries a non-empty notice — the invariant that makes a bare `{}` impossible', async () => {
    const cases = [
      deps({ object: 'InvitationList', items: [liveItem('a', '2026-08-01T00:00:00Z')], cursor: null }),
      deps({ object: 'InvitationList', items: [], cursor: null }, [cachedRow('c', '2026-08-01T00:00:00Z')]),
      deps({ object: 'InvitationList', items: [], cursor: null }, []),
      deps({}, []),
      deps(() => { throw new Error('boom'); }, []),
    ];
    for (const d of cases) {
      const view = await getSentInvitationsView(ACCOUNT, undefined, d);
      expect(typeof view.notice).toBe('string');
      expect(view.notice.length).toBeGreaterThan(0);
      expect(view.source).toMatch(/^(live|cache|none)$/);
      expect(typeof view.totalPending).toBe('number');
    }
  });
});

// CodeRabbit on PR #2796 — two Major findings, both the ENG-1718 defect one
// level below where the first fix reached.
describe('malformed live ROWS are not a usable live read', () => {
  it('does not fabricate an invitation from a null row, and falls back to the ledger', async () => {
    // {items:[null]} passed the envelope check, trimLive turned it into a row of
    // five nulls, the view reported "1 pending invitation read live", and the
    // non-empty page suppressed the cache fallback that held the real data.
    const view = await getSentInvitationsView('acc-1', undefined, {
      fetchLive: async () => ({ items: [null] }) as any,
      fetchCached: async () => [cachedRow('real-1', '2026-08-01T00:00:00.000Z')],
    });

    expect(view.source).toBe('cache');
    expect(view.liveUnavailable).toBe(true);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].id).toBe('inv-real-1');
    expect(view.notice).not.toContain('read live');
  });

  it('rejects a page where ANY row lacks an actionable identity', async () => {
    // A row with neither an invitation id nor a public id cannot be withdrawn,
    // deduplicated or shown to anyone, so counting it as pending is always wrong.
    for (const bad of [null, undefined, 'nope', 42, [], {}, { date: '2026-08-01' }, { id: '   ' }]) {
      const view = await getSentInvitationsView('acc-1', undefined, {
        fetchLive: async () => ({ items: [{ id: 'good-1' }, bad] }) as any,
        fetchCached: async () => [],
      });
      expect(view.source).toBe('none');
      expect(view.liveUnavailable).toBe(true);
    }
  });

  it('accepts a row identified by EITHER id or public id', async () => {
    const view = await getSentInvitationsView('acc-1', undefined, {
      fetchLive: async () => ({
        items: [{ id: 'a', date: '2026-08-01' }, { invited_user_public_id: 'bob' }],
      }) as any,
      fetchCached: async () => [],
    });
    expect(view.source).toBe('live');
    expect(view.items).toHaveLength(2);
  });
});

describe('a paginated page length is not the backlog size', () => {
  const page = (n: number, cursor: string | null) => ({
    items: Array.from({ length: n }, (_, i) => ({ id: `inv-${i}`, date: '2026-08-01T00:00:00.000Z' })),
    cursor,
  });

  it('reports a lower bound, not a total, when more pages remain', async () => {
    const view = await getSentInvitationsView('acc-1', undefined, {
      fetchLive: async () => page(3, 'next-page') as any,
      fetchCached: async () => [],
    });

    expect(view.totalPending).toBe(3);
    expect(view.totalPendingIsLowerBound).toBe(true);
    expect(view.cursor).toBe('next-page');
    expect(view.notice).toContain('At least 3 pending invitations');
    expect(view.notice).toContain('the real backlog is larger');
  });

  it('reports a plain total when the page is the whole list', async () => {
    const view = await getSentInvitationsView('acc-1', undefined, {
      fetchLive: async () => page(3, null) as any,
      fetchCached: async () => [],
    });

    expect(view.totalPending).toBe(3);
    expect(view.totalPendingIsLowerBound).toBeUndefined();
    expect(view.notice).toContain('3 pending invitations read live');
    expect(view.notice).not.toContain('At least');
  });
});

/**
 * ENG-1718 follow-up, found in production: a customer's scheduled runs read ~50
 * identical sent_at values and reported "an unexplained ~50-invite burst" to the
 * customer, twice. The timestamp was exactly N days before the run's own list
 * call: Unipile resolves LinkedIn's "Sent N days ago" label at request time.
 */
describe('sent_at is labelled approximate wherever rows are returned', () => {
  // What a real page looks like: one relative label, one timestamp for all of them.
  const sameLabel = Array.from({ length: 5 }, (_, i) => liveItem(`burst-${i}`, '2026-09-05T17:17:37.000Z'));

  it('live rows carry the flag, and the notice says identical timestamps are not a burst', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({
      object: 'InvitationList', items: sameLabel, cursor: null,
    }));

    expect(view.source).toBe('live');
    expect(view.sentAtIsApproximate).toBe(true);
    expect(view.notice).toContain(SENT_AT_PRECISION_NOTE);
    expect(view.notice).toMatch(/NOT a burst/);
  });

  it('cached rows carry the flag too — the ledger stores the same estimates', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps(
      { object: 'InvitationList', items: [], cursor: null },
      [cachedRow('x', '2026-09-04T21:17:36.000Z'), cachedRow('y', '2026-09-04T21:17:36.000Z')],
    ));

    expect(view.source).toBe('cache');
    expect(view.sentAtIsApproximate).toBe(true);
    expect(view.notice).toContain(SENT_AT_PRECISION_NOTE);
  });

  it('is absent when there are no rows to misread', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps({ object: 'InvitationList', items: [], cursor: null }));

    expect(view.source).toBe('none');
    expect(view).not.toHaveProperty('sentAtIsApproximate');
    expect(view.notice).not.toContain(SENT_AT_PRECISION_NOTE);
  });
});


/**
 * ENG-1938 — a live page carries ONE timestamp per relative label, so "withdraw
 * the oldest" is unrankable from it. Production, 2026-09-16: a live page of 99
 * pending invitations had a single distinct `sent_at`, exactly 14 days before the
 * call, while the ledger held 9 distinct values for the same account, the oldest
 * 44 days. The ledger keeps the earliest estimate ever observed, so merge it in.
 */
describe('live rows are merged with the ledger estimate', () => {
  const label = '2026-09-02T11:27:37.376Z'; // what "2 weeks ago" resolves to on every row
  const livePage = {
    object: 'InvitationList',
    items: [liveItem('a', label), liveItem('b', label), liveItem('c', label)],
    cursor: null,
  };

  it('prefers the ledger value when it is earlier, and returns oldest first', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps(livePage, [
      cachedRow('pub-a', '2026-08-03T00:00:00.000Z'), // 44 days: the real backlog
      cachedRow('pub-b', '2026-08-20T00:00:00.000Z'),
    ]));

    expect(view.source).toBe('live');
    expect(view.items.map((i) => i.sent_at)).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
      label, // 'c' is not in the ledger, so the live value stands
    ]);
    expect(view.totalPending).toBe(3);
  });

  it('keeps the live value when the ledger is later', async () => {
    const view = await getSentInvitationsView(ACCOUNT, undefined, deps(
      { object: 'InvitationList', items: [liveItem('a', '2026-07-01T00:00:00.000Z')], cursor: null },
      [cachedRow('pub-a', '2026-09-01T00:00:00.000Z')],
    ));

    expect(view.items[0].sent_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('still serves the live page when the ledger read fails', async () => {
    const d = {
      fetchLive: jest.fn(async () => livePage),
      fetchCached: jest.fn(async () => { throw new Error('dynamo down'); }),
    };
    const view = await getSentInvitationsView(ACCOUNT, undefined, d);

    expect(view.source).toBe('live');
    expect(view.items).toHaveLength(3);
    expect(view.items.every((i) => i.sent_at === label)).toBe(true);
  });
});

describe('earliestSentAt', () => {
  it('takes the earlier of two estimates, tolerating missing or unparseable values', () => {
    expect(earliestSentAt('2026-08-03T00:00:00.000Z', '2026-09-02T00:00:00.000Z')).toBe('2026-08-03T00:00:00.000Z');
    expect(earliestSentAt('2026-09-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z')).toBe('2026-08-03T00:00:00.000Z');
    expect(earliestSentAt(null, '2026-08-03T00:00:00.000Z')).toBe('2026-08-03T00:00:00.000Z');
    expect(earliestSentAt('2026-08-03T00:00:00.000Z', undefined)).toBe('2026-08-03T00:00:00.000Z');
    expect(earliestSentAt('not a date', '2026-08-03T00:00:00.000Z')).toBe('2026-08-03T00:00:00.000Z');
    expect(earliestSentAt(null, null)).toBeNull();
  });
});

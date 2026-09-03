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

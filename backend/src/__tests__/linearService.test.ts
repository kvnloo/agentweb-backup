import {
  addIssueComment,
  createInternalLinearIssue,
  escalateIssue,
  getEngineeringBugStats,
  getIssueCommentsDetailed,
  listOpenBugCanonicals,
  listOpenIssuesByLabel,
  listRecentlyResolvedBugCanonicals,
  reopenIssue,
  raiseIssueTriage,
  _resetLinearTeamCache,
} from '../services/linearService';

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({ apiKey: 'lin_api_test' })),
}));

const TEAM_RESPONSE = {
  data: {
    teams: {
      nodes: [{
        id: 'team_eng',
        states: {
          nodes: [
            { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
            { id: 'st_done', name: 'Done', type: 'completed' },
          ],
        },
        labels: {
          nodes: [
            { id: 'lab_bug', name: 'Bug' },
            { id: 'lab_crep', name: 'Customer Reported' },
          ],
        },
      }],
    },
  },
};

function lastCreateInput(): any {
  const call = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueCreate'));
  return JSON.parse(call[1].body).variables.input;
}

describe('linearService.createInternalLinearIssue', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('creates an issue with the given labels and NO Featurebase label (stays private)', async () => {
    const TEAM_WITH_AUTO = { data: { teams: { nodes: [{ id: 'team_eng', states: TEAM_RESPONSE.data.teams.nodes[0].states, labels: { nodes: [...TEAM_RESPONSE.data.teams.nodes[0].labels.nodes, { id: 'lab_fb', name: 'Featurebase' }, { id: 'lab_auto', name: 'Auto' }] } }] } } };
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_WITH_AUTO : { data: { issueCreate: { success: true, issue: { id: 'uuid-50', identifier: 'ENG-50', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    const r = await createInternalLinearIssue({ title: 'auto thing', description: 'd', labelNames: ['Auto', 'Bug'] });
    expect(r.identifier).toBe('ENG-50');
    expect(r.id).toBe('uuid-50'); // uuid returned for commenting
    const input = lastCreateInput();
    expect(input.labelIds.sort()).toEqual(['lab_auto', 'lab_bug'].sort());
    expect(input.labelIds).not.toContain('lab_fb'); // no Featurebase label -> never public
  });
});

describe('linearService.createInternalLinearIssue — triage fields + loud label resolution (ENG-187)', () => {
  const TEAM_TRIAGE = {
    data: {
      teams: {
        nodes: [{
          id: 'team_eng',
          states: {
            nodes: [
              { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
              { id: 'st_todo', name: 'Todo', type: 'unstarted' },
              { id: 'st_done', name: 'Done', type: 'completed' },
            ],
          },
          labels: {
            nodes: [
              { id: 'lab_bug', name: 'Bug' },
              { id: 'lab_crep', name: 'Customer Reported' },
              { id: 'lab_ret', name: 'Retention' },
              { id: 'lab_st_paid', name: 'Status: Paid / Retention Handoff' },
              { id: 'lab_autofix', name: 'autofix' },
              { id: 'lab_needs_pm', name: 'Needs PM' },
            ],
          },
        }],
      },
    },
  };
  const CREATE_OK = { data: { issueCreate: { success: true, issue: { id: 'uuid-60', identifier: 'ENG-60', url: 'u' } } } };

  function mockFetchSequence(...bodies: any[]) {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      const body = bodies[Math.min(n, bodies.length - 1)];
      n += 1;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
  }

  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => { jest.clearAllMocks(); jest.restoreAllMocks(); });

  it('sets priority, named state (Todo), and assignee on the created issue', async () => {
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({
      title: 'bug', description: 'd',
      labelNames: ['Bug', 'Customer Reported', 'Status: Paid / Retention Handoff', 'Retention'],
      priority: 1, stateName: 'Todo', assigneeId: 'user-harshit',
    });
    const input = lastCreateInput();
    expect(input.priority).toBe(1);
    expect(input.stateId).toBe('st_todo');
    expect(input.assigneeId).toBe('user-harshit');
    expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid'].sort());
  });

  it('keeps the backlog state when no stateName is given (existing callers unchanged)', async () => {
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'auto', description: 'd', labelNames: ['Bug'] });
    const input = lastCreateInput();
    expect(input.stateId).toBe('st_backlog');
    expect(input.priority).toBeUndefined();
    expect(input.assigneeId).toBeUndefined();
  });

  // ENG-187 contract #7 — label resolution is LOUD, never a silent drop
  it('logs an error NAMING each label that fails to resolve (no silent drops)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'bug', description: 'd', labelNames: ['Bug', 'Status: Nonexistent Stage'] });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Status: Nonexistent Stage'));
    expect(lastCreateInput().labelIds).toEqual(['lab_bug']); // still creates with what resolved
  });

  it('logs an error when the requested state name is unknown and falls back to backlog', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchSequence(TEAM_TRIAGE, CREATE_OK);
    await createInternalLinearIssue({ title: 'bug', description: 'd', labelNames: ['Bug'], stateName: 'NoSuchState' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('NoSuchState'));
    expect(lastCreateInput().stateId).toBe('st_backlog');
  });

  describe('raiseIssueTriage — union labels, raise-only priority (ENG-187 contract #6)', () => {
    const issueResponse = (priority: number, labelIds: string[]) => ({
      data: { issue: { priority, labels: { nodes: labelIds.map((id) => ({ id })) } } },
    });
    const UPDATE_OK = { data: { issueUpdate: { success: true } } };

    const lastUpdateInput = () => {
      const call = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
      return call ? JSON.parse(call[1].body).variables.input : null;
    };

    it('unions new stage labels into the existing set and raises Medium(3) -> Urgent(1)', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(3, ['lab_bug', 'lab_crep']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Status: Paid / Retention Handoff', 'Retention'], priority: 1 });
      const input = lastUpdateInput();
      expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid'].sort());
      expect(input.priority).toBe(1);
    });

    it('NEVER lowers priority: Urgent(1) canonical + Medium(3) reporter -> priority untouched', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(1, ['lab_bug', 'lab_crep', 'lab_ret', 'lab_st_paid']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Retention'], priority: 3 });
      // Labels already present + priority would be a downgrade -> nothing to do, no mutation sent.
      const updateCall = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
      expect(updateCall).toBeUndefined();
    });

    it('treats priority 0 (None) as the floor: any real priority raises it', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(0, ['lab_bug']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: [], priority: 3 });
      expect(lastUpdateInput().priority).toBe(3);
    });

    it('unions labels even when priority stays (labels-only update omits priority)', async () => {
      mockFetchSequence(TEAM_TRIAGE, issueResponse(1, ['lab_bug']), UPDATE_OK);
      await raiseIssueTriage('uuid-5', { addLabelNames: ['Retention'], priority: 2 });
      const input = lastUpdateInput();
      expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_ret'].sort());
      expect(input.priority).toBeUndefined();
    });

    it('atomically replaces an exclusive route label and updates the assignee', async () => {
      mockFetchSequence(
        TEAM_TRIAGE,
        issueResponse(3, ['lab_bug', 'lab_needs_pm']),
        UPDATE_OK,
      );
      await raiseIssueTriage('uuid-5', {
        addLabelNames: ['autofix'],
        removeLabelNames: ['Needs PM'],
        assigneeId: 'user-manan',
      });
      const input = lastUpdateInput();
      expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_autofix'].sort());
      expect(input.assigneeId).toBe('user-manan');
    });

    // ENG-187 contract #4 — settleStateName: an FB-synced feature request must END UP in Backlog,
    // without ever yanking back an issue a human already picked up (webhook retries are harmless).
    describe('settleStateName (ENG-187 contract #4)', () => {
      const issueResponseWithState = (priority: number, labelIds: string[], state: { id: string; type: string }) => ({
        data: { issue: { priority, state, labels: { nodes: labelIds.map((id) => ({ id })) } } },
      });

      it('moves a pre-work (unstarted) issue to Backlog, together with the label union', async () => {
        mockFetchSequence(TEAM_TRIAGE, issueResponseWithState(0, ['lab_bug'], { id: 'st_todo', type: 'unstarted' }), UPDATE_OK);
        await raiseIssueTriage('uuid-6', { addLabelNames: ['Retention'], settleStateName: 'Backlog' });
        const input = lastUpdateInput();
        expect(input.stateId).toBe('st_backlog');
        expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_ret'].sort());
        expect(input.priority).toBeUndefined(); // no priority requested -> none set
      });

      it('is idempotent: already in a backlog state + labels already present -> NO mutation at all (retry-safe)', async () => {
        mockFetchSequence(TEAM_TRIAGE, issueResponseWithState(0, ['lab_ret'], { id: 'st_backlog', type: 'backlog' }), UPDATE_OK);
        await raiseIssueTriage('uuid-6', { addLabelNames: ['Retention'], settleStateName: 'Backlog' });
        const updateCall = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
        expect(updateCall).toBeUndefined();
      });

      it('never yanks a STARTED issue back to Backlog (a human decision beats a webhook retry)', async () => {
        mockFetchSequence(TEAM_TRIAGE, issueResponseWithState(2, ['lab_bug'], { id: 'st_prog', type: 'started' }), UPDATE_OK);
        await raiseIssueTriage('uuid-6', { addLabelNames: ['Retention'], settleStateName: 'Backlog' });
        const input = lastUpdateInput();
        expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_ret'].sort()); // labels still union
        expect(input.stateId).toBeUndefined(); // state untouched
      });

      it('unknown settle-state name -> LOUD error naming it, labels still applied, state untouched', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockFetchSequence(TEAM_TRIAGE, issueResponseWithState(0, ['lab_bug'], { id: 'st_todo', type: 'unstarted' }), UPDATE_OK);
        await raiseIssueTriage('uuid-6', { addLabelNames: ['Retention'], settleStateName: 'NoSuchState' });
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('NoSuchState'));
        const input = lastUpdateInput();
        expect(input.labelIds.sort()).toEqual(['lab_bug', 'lab_ret'].sort());
        expect(input.stateId).toBeUndefined();
      });
    });
  });
});

describe('linearService.listOpenIssuesByLabel', () => {
  afterEach(() => jest.clearAllMocks());

  it('queries open issues by a single label and maps id/identifier/title/description', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [{ id: 'u1', identifier: 'ENG-1', title: 'Context limit reached', description: '- Session ID: sess-1' }] } },
    }) } as any));
    const res = await listOpenIssuesByLabel('Auto');
    expect(res).toEqual([{ identifier: 'ENG-1', issueId: 'u1', title: 'Context limit reached', description: '- Session ID: sess-1' }]);
    // The description is fetched so the auto-issue dedup gate can match on the Session/Schedule ID (ENG-240).
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).query).toContain('description');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).variables.label).toBe('Auto');
  });

  it('defaults description to "" when Linear returns none', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [{ id: 'u2', identifier: 'ENG-2', title: 't' }] } },
    }) } as any));
    const res = await listOpenIssuesByLabel('Auto');
    expect(res[0].description).toBe('');
  });

  // ENG-358 root cause: Linear's "Duplicate" state has its OWN state type ("duplicate", verified
  // live on ENG-350) — a blacklist of completed/canceled let duplicate-state issues stay dedupe
  // candidates, so recurrence comments landed on a canceled Duplicate instead of the open
  // canonical. The filter must WHITELIST open state types.
  it('whitelists open state types so duplicate-state issues are never dedupe candidates (ENG-358)', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [] } },
    }) } as any));
    await listOpenIssuesByLabel('Auto');
    const query = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).query;
    expect(query).toMatch(/state:\s*\{\s*type:\s*\{\s*in:/);
    for (const openType of ['triage', 'backlog', 'unstarted', 'started']) {
      expect(query).toContain(`"${openType}"`);
    }
    expect(query).not.toContain('nin');
  });
});

describe('linearService.listOpenBugCanonicals — open-state whitelist (ENG-358)', () => {
  afterEach(() => jest.clearAllMocks());

  // Same leak class as listOpenIssuesByLabel: a bug canonical in the Duplicate state must never
  // absorb new customer reports — the open canonical (or a fresh issue) must get them.
  it('whitelists open state types so duplicate-state canonicals are excluded', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [] } },
    }) } as any));
    await listOpenBugCanonicals();
    const query = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).query;
    expect(query).toMatch(/state:\s*\{\s*type:\s*\{\s*in:/);
    for (const openType of ['triage', 'backlog', 'unstarted', 'started']) {
      expect(query).toContain(`"${openType}"`);
    }
    expect(query).not.toContain('nin');
  });
});

describe('linearService.escalateIssue (ENG-358 — raise-only canonical escalation)', () => {
  afterEach(() => jest.clearAllMocks());

  /** fetch mock: 1st call answers the priority query, 2nd the mutation. */
  function mockEscalationFetch(currentPriority: number | null, mutationSuccess = true) {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1
        ? { data: { issue: currentPriority === null ? null : { priority: currentPriority } } }
        : { data: { issueUpdate: { success: mutationSuccess } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
  }

  it('raises "No priority" (0) to the incoming priority and refreshes the title', async () => {
    mockEscalationFetch(0);
    const escalated = await escalateIssue('uuid-337', { title: 'v0 credits CRITICAL — $9.10 spendable', priority: 1 });
    expect(escalated).toBe(true);
    const mutation = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(mutation.variables.input).toEqual({ title: 'v0 credits CRITICAL — $9.10 spendable', priority: 1 });
  });

  it('raises a less severe priority (3 -> 1)', async () => {
    mockEscalationFetch(3);
    await expect(escalateIssue('uuid-337', { title: 't', priority: 1 })).resolves.toBe(true);
  });

  it('never downgrades: an equal or weaker incoming priority is a no-op (no mutation call)', async () => {
    mockEscalationFetch(1);
    const escalated = await escalateIssue('uuid-337', { title: 't', priority: 2 });
    expect(escalated).toBe(false);
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1); // priority query only
  });

  it('throws when the issue is not found (callers best-effort it)', async () => {
    mockEscalationFetch(null);
    await expect(escalateIssue('uuid-missing', { title: 't', priority: 1 })).rejects.toThrow(/not found/i);
  });

  it('throws when the mutation reports failure', async () => {
    mockEscalationFetch(0, false);
    await expect(escalateIssue('uuid-337', { title: 't', priority: 1 })).rejects.toThrow(/escalation/i);
  });
});

describe('linearService.listRecentlyResolvedBugCanonicals (ENG-240 reopen candidates)', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('filters to completed/canceled Bug + Customer Reported issues and maps them', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      data: { issues: { nodes: [{ id: 'uuid-179', identifier: 'ENG-179', title: 'Google Ads OAuth', description: 'old' }] } },
    }) } as any));
    const res = await listRecentlyResolvedBugCanonicals();
    expect(res).toEqual([{ identifier: 'ENG-179', issueId: 'uuid-179', title: 'Google Ads OAuth', description: 'old' }]);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.query).toContain('completed');
    expect(body.query).toContain('canceled');
    expect(body.variables.bug).toBe('Bug');
    expect(body.variables.cust).toBe('Customer Reported');
  });
});

describe('linearService.reopenIssue (ENG-240)', () => {
  const TEAM_WITH_TODO = { data: { teams: { nodes: [{ id: 'team_eng', states: { nodes: [
    { id: 'st_backlog', name: 'Backlog', type: 'backlog' },
    { id: 'st_todo', name: 'Todo', type: 'unstarted' },
    { id: 'st_done', name: 'Done', type: 'completed' },
  ] }, labels: { nodes: [] } }] } } };
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('moves a resolved issue to the named state', async () => {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_WITH_TODO : { data: { issueUpdate: { success: true } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    await reopenIssue('uuid-179', 'Todo');
    const updateCall = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('issueUpdate'));
    const vars = JSON.parse(updateCall[1].body).variables;
    expect(vars).toEqual({ id: 'uuid-179', stateId: 'st_todo' });
  });

  it('throws (never silently no-ops) when the state name is unknown', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(TEAM_WITH_TODO) } as any));
    await expect(reopenIssue('uuid-179', 'Nonexistent')).rejects.toThrow(/state "Nonexistent" not found/);
  });
});

describe('linearService.addIssueComment', () => {
  afterEach(() => jest.clearAllMocks());

  it('calls commentCreate with the issueId + body', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: true } } }) } as any));
    await addIssueComment('uuid-1', 'Also reported by u@e.com');
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.query).toContain('commentCreate');
    expect(body.variables.input).toEqual({ issueId: 'uuid-1', body: 'Also reported by u@e.com' });
  });

  it('throws when commentCreate fails', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { commentCreate: { success: false } } }) } as any));
    await expect(addIssueComment('uuid-1', 'x')).rejects.toThrow(/commentCreate failed/);
  });
});

describe('linearService.getIssueCommentsDetailed (ENG-316)', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns body + createdAt per comment (the "most recent @Emma wins" contract needs the timestamp), tolerating null nodes/fields', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { issue: { comments: { nodes: [
        { body: 'first', createdAt: '2026-07-01T00:00:00.000Z' },
        { body: null, createdAt: null },
        null,
      ], pageInfo: { hasNextPage: false } } } } }),
    } as any));
    const r = await getIssueCommentsDetailed('uuid-1');
    expect(r).toEqual([
      { body: 'first', createdAt: '2026-07-01T00:00:00.000Z' },
      { body: '', createdAt: '' },
      { body: '', createdAt: '' },
    ]);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.query).toContain('createdAt');
    expect(body.variables).toEqual({ id: 'uuid-1' });
    // Explicitly sized + ordered: Linear defaults connections to 50 nodes (the getTeamMeta trap) —
    // an un-sized page would silently drop exactly the newest comments the resolve bridge needs.
    expect(body.query).toContain('first: 250');
    expect(body.query).toContain('orderBy: createdAt');
    expect(body.query).toContain('hasNextPage');
  });

  it('flags truncation LOUDLY when the issue has >250 comments (hasNextPage) instead of silently dropping them', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (global.fetch as any) = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { issue: { comments: { nodes: [
          { body: 'newest', createdAt: '2026-07-01T00:00:00.000Z' },
        ], pageInfo: { hasNextPage: true } } } } }),
      } as any));
      const r = await getIssueCommentsDetailed('uuid-busy');
      // Still returns the page it got — truncation degrades loudly, it does not throw.
      expect(r).toEqual([{ body: 'newest', createdAt: '2026-07-01T00:00:00.000Z' }]);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('truncated'));
      expect(err).toHaveBeenCalledWith(expect.stringContaining('uuid-busy'));
    } finally {
      err.mockRestore();
    }
  });

  it('missing issue -> empty list', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { issue: null } }) } as any));
    await expect(getIssueCommentsDetailed('nope')).resolves.toEqual([]);
  });
});

describe('linearService.getEngineeringBugStats', () => {
  afterEach(() => jest.clearAllMocks());

  it('counts canceled bugs in 7-day closed outflow so net-open changes reconcile', async () => {
    (global.fetch as any) = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        data: {
          open: { totalCount: 8 },
          opened: { totalCount: 3 },
          closed: { totalCount: 4 },
          canceled: { totalCount: 2 },
        },
      }),
    } as any));

    const stats = await getEngineeringBugStats('2026-07-01', '2026-07-08');

    expect(stats).toEqual({ netOpenBugs: 8, opened7d: 3, closed7d: 6 });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.query).toContain('canceledAt: { gte: $start, lt: $end }');
  });
});

describe('linearService.getTeamMeta — pagination guard (2026-07-07 live-smoke finding)', () => {
  beforeEach(() => { _resetLinearTeamCache(); });
  afterEach(() => jest.clearAllMocks());

  it('explicitly sizes the states and labels connections at 250 (Linear defaults to 50 and truncates silently)', async () => {
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TEAM_RESPONSE : { data: { issueCreate: { success: true, issue: { id: 'uuid-59', identifier: 'ENG-59', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Bug'] });
    const metaCall = (global.fetch as jest.Mock).mock.calls.find(c => (c[1]?.body || '').includes('teams(filter'));
    expect(metaCall).toBeDefined();
    const query: string = JSON.parse(metaCall![1].body).query;
    expect(query).toContain('states(first: 250)');
    expect(query).toContain('labels(first: 250)');
  });

  it('logs a LOUD error when the team has more states/labels than one 250 page (no silent truncation)', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const TRUNCATED = {
      data: {
        teams: {
          nodes: [{
            id: 'team_eng',
            states: { nodes: TEAM_RESPONSE.data.teams.nodes[0].states.nodes, pageInfo: { hasNextPage: false } },
            labels: { nodes: TEAM_RESPONSE.data.teams.nodes[0].labels.nodes, pageInfo: { hasNextPage: true } },
          }],
        },
      },
    };
    let n = 0;
    (global.fetch as any) = jest.fn(() => {
      n += 1;
      const body = n === 1 ? TRUNCATED : { data: { issueCreate: { success: true, issue: { id: 'uuid-60', identifier: 'ENG-60', url: 'u' } } } };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as any);
    });
    await createInternalLinearIssue({ title: 't', description: 'd', labelNames: ['Bug'] });
    expect(err.mock.calls.some(c => String(c[0]).includes('exceeds 250'))).toBe(true);
    err.mockRestore();
  });
});

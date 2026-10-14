import { buildSeedCases, parseFpCatalogue, resolveSessionRef, type SeedInputs } from '../loops/eval/goldenSetSeed';

const NOW = new Date('2026-09-25T00:00:00.000Z');

function sid(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function inputs(overrides: Partial<SeedInputs> = {}): SeedInputs {
  return {
    sessions: Array.from({ length: 80 }, (_, i) => ({ sessionId: sid(i), adminOverride: i < 3 })),
    candidates: [],
    users: [],
    now: NOW,
    ...overrides,
  };
}

describe('golden-set seed builder (ENG-2135)', () => {
  it('resolves full ids and unique 8+ char prefixes only', () => {
    const ids = ['abcdef12-1', 'abcdef12-2', '12345678-9'];
    const set = new Set(ids);
    expect(resolveSessionRef('12345678-9', set, ids)).toBe('12345678-9');
    expect(resolveSessionRef('12345678', set, ids)).toBe('12345678-9');
    expect(resolveSessionRef('abcdef12', set, ids)).toBeNull();
    expect(resolveSessionRef('1234', set, ids)).toBeNull();
    expect(resolveSessionRef('ffffffff', set, ids)).toBeNull();
  });

  it('keeps admin-override and replay-linked sessions, fills agent with the catalogue up to the target', () => {
    const fpCatalogue = {
      issues: { 'ENG-972': Array.from({ length: 70 }, (_, i) => sid(i + 5).slice(0, 8)).concat(['deadbeef']), 'ENG-47': [sid(0)] },
      replayFixtures: { 'yesno-terse-1': { session: sid(4).slice(0, 8), messageIndex: 15 }, 'missing-1': { session: 'feedface', messageIndex: 1 } },
    };
    const result = buildSeedCases(inputs({ fpCatalogue, targets: { agent: 50 } }));
    const agent = result.cases.filter((c) => c.surface === 'agent');
    expect(agent).toHaveLength(50);
    expect(result.report.agent).toMatchObject({ selected: 50, target: 50, eligible: 74 });
    expect(agent.filter((c) => c.taskType === 'admin_override')).toHaveLength(3);
    const replay = agent.filter((c) => c.replay);
    expect(replay).toEqual([expect.objectContaining({ sourceRef: { kind: 'sessionId', id: sid(4) }, replay: { fixtureId: 'yesno-terse-1', messageIndex: 15 }, taskType: 'replay_fixture' })]);
    // sid(0) is both admin-override and in ENG-47: one case, first source wins.
    expect(agent.filter((c) => c.sourceRef.id === sid(0))).toHaveLength(1);
    expect(result.unresolvedCatalogueIds).toBe(1);
    expect(result.unresolvedReplayFixtures).toEqual(['missing-1']);
    expect(new Set(agent.map((c) => c.caseId)).size).toBe(50);
  });

  it('is deterministic: the same inputs select the same cases in the same order', () => {
    const fpCatalogue = { issues: { 'ENG-1': Array.from({ length: 70 }, (_, i) => sid(i)) } };
    const a = buildSeedCases(inputs({ fpCatalogue }));
    const b = buildSeedCases(inputs({ fpCatalogue, sessions: [...inputs().sessions].reverse() }));
    expect(b.cases.map((c) => c.caseId)).toEqual(a.cases.map((c) => c.caseId));
  });

  it('selects independently of the dev/test split, so a capped surface still gets both splits', () => {
    const candidates = Array.from({ length: 300 }, (_, i) => ({ candidateId: `c-${i}`, reviewType: 'creative_image', reviewerSlackUserId: 'U', feedbackSlackUserIds: ['U'] }));
    const creative = buildSeedCases(inputs({ candidates })).cases.filter((c) => c.surface === 'creative');
    expect(creative).toHaveLength(50);
    const testShare = creative.filter((c) => c.split === 'test').length / creative.length;
    expect(testShare).toBeGreaterThan(0.4);
    expect(testShare).toBeLessThan(0.8);
  });

  it('selects creative candidates only when their own reviewer replied, never other types', () => {
    const candidates = [
      { candidateId: 'c1', reviewType: 'creative_image', reviewerSlackUserId: 'U_MATT', feedbackSlackUserIds: ['U_MATT'] },
      { candidateId: 'c2', reviewType: 'landing_page', reviewerSlackUserId: 'U_MATT', feedbackSlackUserIds: ['U_OTHER', 'U_MATT'] },
      { candidateId: 'c3', reviewType: 'creative_image', reviewerSlackUserId: 'U_MATT', feedbackSlackUserIds: ['U_OTHER'] },
      { candidateId: 'c4', reviewType: 'creative_image', feedbackSlackUserIds: ['U_MATT'] },
      { candidateId: 'c5', reviewType: 'lead_enrichment', reviewerSlackUserId: 'U_FF', feedbackSlackUserIds: ['U_FF'] },
      { candidateId: 'c6', reviewType: 'creative_image', reviewerSlackUserId: 'U_MATT', feedbackSlackUserIds: [] },
    ];
    const creative = buildSeedCases(inputs({ candidates })).cases.filter((c) => c.surface === 'creative');
    expect(creative.map((c) => c.sourceRef.id).sort()).toEqual(['c1', 'c2']);
    expect(creative.every((c) => c.criteria.length === 7 && c.sourceRef.kind === 'candidateId')).toBe(true);
  });

  it('balances canceled and active accounts by userId, excluding admins and other statuses', () => {
    const users = [
      ...Array.from({ length: 26 }, (_, i) => ({ userId: `can-${i}`, subscriptionStatus: 'canceled' })),
      ...Array.from({ length: 28 }, (_, i) => ({ userId: `act-${i}`, subscriptionStatus: 'active' })),
      { userId: 'admin', subscriptionStatus: 'active', isAdmin: true },
      { userId: 'pd', subscriptionStatus: 'past_due' },
    ];
    const account = buildSeedCases(inputs({ users })).cases.filter((c) => c.surface === 'account_health');
    expect(account).toHaveLength(30);
    expect(account.filter((c) => c.taskType === 'subscription_canceled')).toHaveLength(15);
    expect(account.filter((c) => c.taskType === 'subscription_active')).toHaveLength(15);
    expect(account.some((c) => c.sourceRef.id === 'admin' || c.sourceRef.id === 'pd')).toBe(false);
    expect(account.every((c) => c.sourceRef.kind === 'userId')).toBe(true);
  });

  it('fills from the other account class when one runs short', () => {
    const users = [
      ...Array.from({ length: 5 }, (_, i) => ({ userId: `can-${i}`, subscriptionStatus: 'canceled' })),
      ...Array.from({ length: 40 }, (_, i) => ({ userId: `act-${i}`, subscriptionStatus: 'active' })),
    ];
    const result = buildSeedCases(inputs({ users }));
    expect(result.report.account_health.selected).toBe(30);
    expect(result.report.account_health.bySource).toEqual({ subscription_status: 30 });
  });

  it('reports actual counts below target when the data does not allow it', () => {
    const result = buildSeedCases(inputs({ sessions: [{ sessionId: sid(1), adminOverride: true }] }));
    expect(result.report.agent).toMatchObject({ selected: 1, target: 50 });
    expect(result.report.creative).toMatchObject({ selected: 0, eligible: 0 });
  });

  it('validates the off-repo catalogue file', () => {
    expect(parseFpCatalogue({ issues: { 'ENG-1': ['a'] } })).toEqual({ issues: { 'ENG-1': ['a'] } });
    expect(() => parseFpCatalogue({ 'ENG-1': ['a'] })).toThrow(/issues/);
    expect(() => parseFpCatalogue({ issues: { 'ENG-1': [1] } })).toThrow(/string array/);
    expect(() => parseFpCatalogue({ issues: {}, replayFixtures: { f: { session: 's', messageIndex: -1 } } })).toThrow(/messageIndex/);
  });

  describe('sampled_session source', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ordinary = (i: number, over: Record<string, unknown> = {}) => ({
      sessionId: sid(1000 + i),
      adminOverride: false,
      createdAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
      sessionType: 'regular',
      messageCount: 6,
      userId: `user-${i}`,
      ...over,
    });
    const pool = (n = 100) => Array.from({ length: n }, (_, i) => ordinary(i));
    const agentOf = (result: ReturnType<typeof buildSeedCases>) => result.cases.filter((c) => c.surface === 'agent');
    const sampledIds = (result: ReturnType<typeof buildSeedCases>) => agentOf(result).filter((c) => c.taskType === 'sampled_session').map((c) => c.sourceRef.id);

    it('is deterministic and a larger target only appends (70 contains 60)', () => {
      const sessions = [...inputs().sessions.slice(0, 3), ...pool()];
      const at = (agent: number, rows = sessions) => sampledIds(buildSeedCases(inputs({ sessions: rows, targets: { agent } })));
      const s60 = at(60);
      const s70 = at(70);
      expect(s60).toHaveLength(57);
      expect(s70).toHaveLength(67);
      expect(s70).toEqual(expect.arrayContaining(s60));
      expect(at(70, [...sessions].reverse()).sort()).toEqual([...s70].sort());
      expect(buildSeedCases(inputs({ sessions, targets: { agent: 70 } })).report.agent.bySource).toMatchObject({ admin_override: 3, sampled_session: 67 });
    });

    it('is ordered by hash, not recency: newer sessions are not preferred', () => {
      const sessions = pool(60).map((s, i) => ({ ...s, createdAt: new Date(NOW.getTime() - (i + 1) * DAY).toISOString() }));
      const picked = new Set(sampledIds(buildSeedCases(inputs({ sessions, targets: { agent: 20 } }))));
      const newest20 = new Set(sessions.slice(0, 20).map((s) => s.sessionId));
      expect([...picked].filter((id) => newest20.has(id)).length).toBeLessThan(20);
    });

    it('excludes short, old, future-dated, evaluation, non-regular and unattributed sessions', () => {
      const bad = [
        ordinary(1, { messageCount: 3 }),
        ordinary(2, { messageCount: undefined }),
        ordinary(3, { createdAt: new Date(NOW.getTime() - 91 * DAY).toISOString() }),
        ordinary(4, { createdAt: undefined }),
        ordinary(5, { createdAt: 'not-a-date' }),
        ordinary(6, { createdAt: new Date(NOW.getTime() + DAY).toISOString() }),
        ordinary(7, { userId: 'eval_abc123' }),
        ordinary(8, { sessionType: 'scheduled' }),
      ];
      const good = [ordinary(10), ordinary(11, { messageCount: 4 }), ordinary(12, { sessionType: undefined }), ordinary(13, { createdAt: new Date(NOW.getTime() - 90 * DAY).toISOString() })];
      const result = buildSeedCases(inputs({ sessions: [...bad, ...good], targets: { agent: 20 } }));
      expect(sampledIds(result).sort()).toEqual(good.map((s) => s.sessionId).sort());
    });

    it('never re-labels a session already present as admin_override, fp_catalogue or replay_fixture', () => {
      const rows = [ordinary(1, { adminOverride: true }), ordinary(2), ordinary(3), ordinary(4)];
      const fpCatalogue = { issues: { 'ENG-9': [rows[1].sessionId] }, replayFixtures: { f1: { session: rows[2].sessionId, messageIndex: 2 } } };
      const agent = agentOf(buildSeedCases(inputs({ sessions: rows, fpCatalogue, targets: { agent: 50 } })));
      const type = (r: { sessionId: string }) => agent.find((c) => c.sourceRef.id === r.sessionId)?.taskType;
      expect([type(rows[0]), type(rows[1]), type(rows[2]), type(rows[3])]).toEqual(['admin_override', 'fp_catalogue', 'replay_fixture', 'sampled_session']);
      expect(agent).toHaveLength(4);
    });

    it('fills after pinned and fp_catalogue cases, and leaves a full default-target result unchanged', () => {
      const base = inputs({ fpCatalogue: { issues: { 'ENG-1': Array.from({ length: 70 }, (_, i) => sid(i)) } } });
      const without = buildSeedCases(base);
      const withPool = buildSeedCases({ ...base, sessions: [...base.sessions, ...pool()] });
      expect(withPool.cases.map((c) => c.caseId)).toEqual(without.cases.map((c) => c.caseId));
      expect(withPool.report.agent.bySource).toEqual(without.report.agent.bySource);
      expect(withPool.report.agent.eligible).toBe(without.report.agent.eligible + 100);
      // Raising the target keeps every existing case and adds sampled ones only.
      const bigger = buildSeedCases({ ...base, sessions: [...base.sessions, ...pool()], targets: { agent: 90 } });
      const ids = new Set(bigger.cases.map((c) => c.caseId));
      expect(without.cases.filter((c) => c.surface === 'agent').every((c) => ids.has(c.caseId))).toBe(true);
      expect(bigger.report.agent.bySource.sampled_session).toBe(90 - without.report.agent.eligible);
    });

    it('an empty candidate pool leaves the result unchanged', () => {
      const a = buildSeedCases(inputs({ targets: { agent: 70 } }));
      const b = buildSeedCases(inputs({ sessions: inputs().sessions.map((s) => ({ ...s, messageCount: 2, createdAt: NOW.toISOString() })), targets: { agent: 70 } }));
      expect(b.cases.map((c) => c.caseId)).toEqual(a.cases.map((c) => c.caseId));
      expect(b.report.agent.bySource.sampled_session).toBeUndefined();
    });
  });
});

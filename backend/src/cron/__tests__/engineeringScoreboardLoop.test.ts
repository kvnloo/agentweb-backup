import {
  WeaveClient,
  WeaveApiError,
  DynamoScoreboardSnapshotStore,
  buildEngineeringScoreboardMessage,
  getWeaveSecretName,
  runEngineeringScoreboardLoopOnce,
  type EngineeringScoreboardDeps,
  type EngineeringScoreboardSnapshot,
} from '../engineeringScoreboardLoop';

function makeDeps(overrides: Partial<EngineeringScoreboardDeps> = {}): EngineeringScoreboardDeps {
  const snapshots: EngineeringScoreboardSnapshot[] = [
    {
      snapshotDate: '2026-07-01',
      netOpenBugs: 15,
      opened7d: 4,
      closed7d: 6,
      bugRatioLastWeek: 0.12,
      prsLastWeek: 14,
      createdAt: '2026-07-01T12:00:00.000Z',
    },
  ];

  return {
    env: {
      ENGINEERING_SCOREBOARD_LOOP_ENABLED: 'true',
      ENGINEERING_SCOREBOARD_SLACK_USER_ID: 'U-HARSHA',
      ENGINEERING_SCOREBOARD_ENGINEERS: JSON.stringify([
        { name: 'Ada Lovelace', email: 'ada@example.com', prFloor: 3 },
        { name: 'Ben Bitdiddle', email: 'ben@example.com', prFloor: 2 },
      ]),
    },
    now: () => new Date('2026-07-08T12:00:00.000Z'),
    linear: {
      getBugStats: jest.fn().mockResolvedValue({ netOpenBugs: 11, opened7d: 5, closed7d: 9 }),
    },
    weave: {
      getAccounts: jest.fn().mockResolvedValue([
        { id: 'acct-ada', name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'acct-ben', name: 'Ben Bitdiddle', email: 'ben@example.com' },
      ]),
      getMetricSeries: jest.fn().mockImplementation(async (metric: string) => {
        if (metric === 'bug_ratio') {
          return [
            { date: '2026-07-01', value: 0.12 },
            { date: '2026-07-08', value: 0.08 },
          ];
        }
        if (metric === 'prs') {
          return [
            { date: '2026-07-01', value: 14 },
            { date: '2026-07-08', value: 17 },
            { date: '2026-07-08', group: 'acct-ada', value: 4 },
            { date: '2026-07-08', group: 'acct-ben', value: 1 },
          ];
        }
        if (metric === 'code_turnover') {
          return [
            { date: '2026-07-08', group: 'acct-ada', value: 0.18 },
            { date: '2026-07-08', group: 'acct-ben', value: 0.31 },
          ];
        }
        throw new Error(`unexpected metric ${metric}`);
      }),
    },
    snapshots: {
      listRecentSnapshots: jest.fn().mockResolvedValue(snapshots),
      appendSnapshot: jest.fn().mockResolvedValue(undefined),
    },
    slack: {
      postMessage: jest.fn().mockResolvedValue({ channel: 'D123', ts: '1720000000.000100', link: 'https://slack.test/msg' }),
    },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('engineering scoreboard backend loop', () => {
  it('is env-gated and makes zero Weave, Linear, Slack, or snapshot calls when disabled', async () => {
    const deps = makeDeps({
      env: { ENGINEERING_SCOREBOARD_LOOP_ENABLED: 'false' },
    });

    const result = await runEngineeringScoreboardLoopOnce(deps);

    expect(result.status).toBe('disabled');
    expect(deps.linear.getBugStats).not.toHaveBeenCalled();
    expect(deps.weave.getAccounts).not.toHaveBeenCalled();
    expect(deps.weave.getMetricSeries).not.toHaveBeenCalled();
    expect(deps.snapshots.listRecentSnapshots).not.toHaveBeenCalled();
    expect(deps.snapshots.appendSnapshot).not.toHaveBeenCalled();
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
  });

  it('sends exactly one proven Slack DM and appends the weekly snapshot on success', async () => {
    const deps = makeDeps();

    const result = await runEngineeringScoreboardLoopOnce(deps);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok result');
    expect(result.slack).toEqual({ channel: 'D123', ts: '1720000000.000100', link: 'https://slack.test/msg' });
    expect(deps.slack.postMessage).toHaveBeenCalledTimes(1);
    expect(deps.slack.postMessage).toHaveBeenCalledWith(
      'U-HARSHA',
      expect.stringContaining('TL;DR:'),
    );
    const message = (deps.slack.postMessage as jest.Mock).mock.calls[0][1] as string;
    expect(message).toContain('11 open bugs (+5/-9 last 7d)');
    expect(message).toContain('bug_ratio 0.08');
    expect(message).toContain('prs 17');
    expect(message).toContain('Ada Lovelace | 4 | 3 | 0.08 | 0.18');
    expect(message).toContain('Ben Bitdiddle | 1 | 2 | 0.08 | 0.31');
    expect(message).toContain('burning down by 4');
    expect(deps.snapshots.appendSnapshot).toHaveBeenCalledWith({
      snapshotDate: '2026-07-08',
      netOpenBugs: 11,
      opened7d: 5,
      closed7d: 9,
      bugRatioLastWeek: 0.08,
      prsLastWeek: 17,
      createdAt: '2026-07-08T12:00:00.000Z',
    });
  });

  it('does not record success when Slack fails to return a timestamp or link', async () => {
    const deps = makeDeps({
      slack: { postMessage: jest.fn().mockResolvedValue({ channel: 'D123', ts: '' }) },
    });

    const result = await runEngineeringScoreboardLoopOnce(deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed result');
    expect(result.error?.type).toBe('slack_delivery');
    expect(deps.snapshots.appendSnapshot).not.toHaveBeenCalled();
  });

  it('fails loud and sends no DM when Linear or Weave data collection fails', async () => {
    const deps = makeDeps({
      linear: { getBugStats: jest.fn().mockRejectedValue(new Error('Linear unavailable')) },
    });

    const result = await runEngineeringScoreboardLoopOnce(deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed result');
    expect(result.error?.type).toBe('linear');
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
    expect(deps.snapshots.appendSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces unknown Weave metrics as typed errors', async () => {
    const deps = makeDeps({
      weave: {
        getAccounts: jest.fn().mockResolvedValue([]),
        getMetricSeries: jest.fn().mockRejectedValue(
          new WeaveApiError('unknown_metric', 'unknown metric type: bugs_introduced'),
        ),
      },
    });

    const result = await runEngineeringScoreboardLoopOnce(deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed result');
    expect(result.error).toEqual({
      type: 'unknown_metric',
      message: 'unknown metric type: bugs_introduced',
    });
    expect(deps.slack.postMessage).not.toHaveBeenCalled();
  });

  it('propagates Weave REST unknown metric responses from WeaveClient', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'unknown metric type: bugs_introduced' })),
    });
    const client = new WeaveClient('test-key', 'https://weave.test/api/v1', fetchImpl as unknown as typeof fetch);

    await expect(
      client.getMetricSeries('bug_ratio', { start: '2026-07-01', end: '2026-07-08' }),
    ).rejects.toMatchObject({
      type: 'unknown_metric',
      message: 'unknown metric type: bugs_introduced',
      status: 400,
    });
  });

  it('accepts generic value fields from Weave metric rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify([{ date: '2026-07-08', value: 0.23 }])),
    });
    const client = new WeaveClient('test-key', 'https://weave.test/api/v1', fetchImpl as unknown as typeof fetch);

    await expect(
      client.getMetricSeries('bug_ratio', { start: '2026-07-01', end: '2026-07-08' }),
    ).resolves.toEqual([{ date: '2026-07-08', group: undefined, value: 0.23 }]);
  });

  it('uses a non-production Weave secret fallback outside production', () => {
    expect(getWeaveSecretName({ NODE_ENV: 'production' })).toBe('prod/AgentWeb/Weave');
    expect(getWeaveSecretName({ NODE_ENV: 'test' })).toBe('dev/AgentWeb/Weave');
    expect(getWeaveSecretName({ WEAVE_SECRET_NAME: 'custom/Weave' })).toBe('custom/Weave');
  });

  it('sorts all persisted snapshots before slicing to the requested recent window', async () => {
    const items = Array.from({ length: 9 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      return {
        snapshotDate: `2026-07-${day}`,
        netOpenBugs: index,
        opened7d: 1,
        closed7d: 2,
        bugRatioLastWeek: 0.1,
        prsLastWeek: 10,
        createdAt: `2026-07-${day}T12:00:00.000Z`,
      };
    });
    const query = jest.fn().mockResolvedValue({ items });
    const store = new DynamoScoreboardSnapshotStore({
      query,
      putItem: jest.fn(),
      getItem: jest.fn(),
    });

    const snapshots = await store.listRecentSnapshots(8);

    expect(query).toHaveBeenCalledWith(expect.not.objectContaining({ limit: expect.anything() }));
    expect(snapshots.map((snapshot) => snapshot.createdAt)).toEqual([
      '2026-07-09T12:00:00.000Z',
      '2026-07-08T12:00:00.000Z',
      '2026-07-07T12:00:00.000Z',
      '2026-07-06T12:00:00.000Z',
      '2026-07-05T12:00:00.000Z',
      '2026-07-04T12:00:00.000Z',
      '2026-07-03T12:00:00.000Z',
      '2026-07-02T12:00:00.000Z',
    ]);
  });

  it('renders prior-snapshot trend without requiring in-memory state', () => {
    const message = buildEngineeringScoreboardMessage({
      reportDate: '2026-07-08',
      bugStats: { netOpenBugs: 8, opened7d: 2, closed7d: 6 },
      orgTrend: { bugRatioPrevious: 0.2, bugRatioCurrent: 0.1, prsPrevious: 10, prsCurrent: 12 },
      engineerRows: [],
      priorSnapshots: [
        {
          snapshotDate: '2026-07-01',
          netOpenBugs: 12,
          opened7d: 5,
          closed7d: 5,
          bugRatioLastWeek: 0.2,
          prsLastWeek: 10,
          createdAt: '2026-07-01T12:00:00.000Z',
        },
      ],
    });

    expect(message).toContain('burning down by 4');
    expect(message).toContain('TL;DR: OK');
  });
});

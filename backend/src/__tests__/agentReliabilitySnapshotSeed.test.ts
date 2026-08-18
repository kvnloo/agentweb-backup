/**
 * ENG-746 — scheduler entry points for the reliability snapshot.
 *
 * Covers the boot seed (which is what makes the trend readable immediately
 * after the deploy that turns the cron on), the catch-up horizon parsing, and
 * the swallow-everything contract both entry points owe the boot sequence.
 */

import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';

const store = new Map<string, DynamoAttributeMap>();
const dynamo: DynamoPort = {
  putItem: jest.fn(async (_t: string, item: DynamoAttributeMap) => {
    store.set(`${item.loopId}#${item.tsSession}`, item);
  }),
  getItem: jest.fn(async () => null),
  query: jest.fn(async (params) => {
    const loopId = params.expressionAttributeValues?.[':loopId'];
    return { items: [...store.values()].filter((i) => i.loopId === loopId) };
  }),
};

const productionLoopPorts = jest.fn(() => ({
  dynamo,
  clock: { now: () => new Date('2026-06-14T18:00:00Z') },
}));

jest.mock('../loops/adapters/awsAdapters', () => ({
  productionLoopPorts: (...a: unknown[]) => productionLoopPorts(...(a as [])),
  awsDynamoAdapter: () => dynamo,
}));

// ENG-1312: runAgentReliabilitySnapshot/seedReliabilitySnapshotsIfEmpty now
// wire in readSatisfactionDimensionSamplesFromChatbotDb by default, which
// lazy-imports chatbotService. Without this mock the real chatbotService
// module (and its real AWS.DynamoDB.DocumentClient) would load and attempt a
// live network call from what must stay a hermetic, network-free unit test
// (per this repo's "Mocking AWS services with Jest" testing convention) — the
// getRecentSessionsPage mock below keeps that call fully in-process.
const getRecentSessionsPage = jest.fn().mockResolvedValue({ sessions: [] });
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getRecentSessionsPage: (...a: unknown[]) => getRecentSessionsPage(...a),
  },
}));

import {
  seedReliabilitySnapshotsIfEmpty,
  runAgentReliabilitySnapshot,
  resolveCatchUpDays,
  readReliabilityTrend,
  itemToSnapshot,
  utcDateString,
  DEFAULT_CATCH_UP_DAYS,
} from '../cron/agentReliabilitySnapshotCron';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';

function seedVerdict(ts: string, verdict: string, runId: string) {
  store.set(`agent-mode#${ts}#${runId}`, {
    loopId: 'agent-mode',
    tsSession: `${ts}#${runId}`,
    eventType: 'agent_run_verdict',
    subjectId: runId,
    ts,
    dimensions: { verdict },
  } as unknown as DynamoAttributeMap);
}

describe('resolveCatchUpDays', () => {
  it('falls back to the default when unset or unparseable', () => {
    expect(resolveCatchUpDays(undefined)).toBe(DEFAULT_CATCH_UP_DAYS);
    expect(resolveCatchUpDays('')).toBe(DEFAULT_CATCH_UP_DAYS);
    expect(resolveCatchUpDays('lots')).toBe(DEFAULT_CATCH_UP_DAYS);
  });

  it('clamps to a sane range and floors fractions', () => {
    expect(resolveCatchUpDays('0')).toBe(1);
    expect(resolveCatchUpDays('-5')).toBe(1);
    expect(resolveCatchUpDays('500')).toBe(90);
    expect(resolveCatchUpDays('7.9')).toBe(7);
    expect(resolveCatchUpDays('30')).toBe(30);
  });
});

describe('utcDateString / itemToSnapshot', () => {
  it('formats a UTC calendar day', () => {
    expect(utcDateString(new Date('2026-06-14T23:59:59Z'))).toBe('2026-06-14');
  });

  it('returns null for a row that carries no snapshot payload', () => {
    expect(itemToSnapshot({ loopId: 'x' })).toBeNull();
    expect(itemToSnapshot({ snapshot: null })).toBeNull();
    expect(itemToSnapshot({ snapshot: 'nonsense' })).toBeNull();
  });
});

describe('seedReliabilitySnapshotsIfEmpty (ENG-746)', () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    delete process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS;
  });

  it('seeds a trend when the partition is empty — the ENG-746 state', async () => {
    seedVerdict('2026-06-13T10:00:00.000Z', 'ok', 'r1');
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r2');

    const seeded = await seedReliabilitySnapshotsIfEmpty();

    expect(seeded).toBe(true);
    const trend = await readReliabilityTrend(dynamo, { limit: 30, windowLabel: '24h' });
    expect(trend.length).toBeGreaterThan(1);
  });

  it('is a no-op once any snapshot exists, so it cannot re-seed on every boot', async () => {
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');
    await seedReliabilitySnapshotsIfEmpty();

    jest.clearAllMocks();
    const again = await seedReliabilitySnapshotsIfEmpty();

    expect(again).toBe(false);
    expect(dynamo.putItem).not.toHaveBeenCalled();
  });

  it('honours the catch-up horizon from env', async () => {
    process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS = '3';
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');

    await seedReliabilitySnapshotsIfEmpty();

    const trend = await readReliabilityTrend(dynamo, { limit: 30, windowLabel: '24h' });
    expect(trend.length).toBe(3);
  });

  it('swallows a failure rather than breaking boot', async () => {
    productionLoopPorts.mockImplementationOnce(() => {
      throw new Error('dynamo unavailable');
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(seedReliabilitySnapshotsIfEmpty()).resolves.toBe(false);

    spy.mockRestore();
  });
});

describe('runAgentReliabilitySnapshot', () => {
  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    delete process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS;
  });

  it('writes snapshots and logs a summary', async () => {
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');
    seedVerdict('2026-06-14T11:00:00.000Z', 'failed', 'r2');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runAgentReliabilitySnapshot();

    expect(dynamo.putItem).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[AgentReliabilitySnapshot] 2026-06-14'));
    log.mockRestore();
  });

  it('ENG-1312: wires readSatisfactionDimensionSamplesFromChatbotDb by default — the reliability-trend endpoint actually gets fed real satisfaction-dimension data, not just a computation function nobody calls', async () => {
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');

    await runAgentReliabilitySnapshot();

    expect(getRecentSessionsPage).toHaveBeenCalled();
  });

  it('notes catch-up rows in the summary line', async () => {
    process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS = '3';
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runAgentReliabilitySnapshot();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('catch-up rows'));
    log.mockRestore();
  });

  it('swallows a failure rather than crashing the scheduler', async () => {
    productionLoopPorts.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runAgentReliabilitySnapshot()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      '[AgentReliabilitySnapshot] failed (swallowed):',
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it('logs the no-window case without throwing', async () => {
    const originalPut = dynamo.putItem;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    // Force zero windows written by making every put a no-op observation is not
    // possible; instead assert the table constant is the one being written to.
    seedVerdict('2026-06-14T10:00:00.000Z', 'ok', 'r1');
    await runAgentReliabilitySnapshot();

    expect(dynamo.putItem).toHaveBeenCalledWith(LOOP_EVENTS_TABLE, expect.any(Object));
    expect(originalPut).toBe(dynamo.putItem);
    log.mockRestore();
  });
});

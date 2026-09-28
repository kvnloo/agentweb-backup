/**
 * ENG-2195: the scheduled consumer runs the deterministic offline suite when new `eval_needed`
 * markers appeared since its last run, and records the verdict to Dev-AW-LoopEvents. It is inert
 * without EVAL_MARKER_SUITE_ENABLED=true, and an hour with no new markers writes nothing.
 */
import type AWS from 'aws-sdk';
import type { DynamoAttributeMap } from '../loops/core/ports';
import { EVAL_GATE_LOOP_ID } from '../loops/eval/evalChangeMarkers';
import type { OfflineSuiteResult } from '../loops/eval/offlineSuite';
import {
  EVAL_GATE_RUNS_LOOP_ID,
  EVAL_MARKER_SUITE_INTERVAL_MS,
  EVT_EVAL_SUITE_VERDICT,
  runEvalMarkerSuite,
  runLocalOfflineSuite,
  scheduleEvalMarkerSuite,
} from '../cron/evalMarkerSuiteCron';

type QueryInput = AWS.DynamoDB.DocumentClient.QueryInput;
type QueryOutput = AWS.DynamoDB.DocumentClient.QueryOutput;

const NOW = new Date('2026-09-28T12:00:00.000Z');
const ON = { EVAL_MARKER_SUITE_ENABLED: 'true' };

const marker = (ts: string, category: string) => ({
  loopId: EVAL_GATE_LOOP_ID,
  tsSession: `${ts}#skill:s1#eval_needed#abcd1234`,
  eventType: 'eval_needed',
  subjectId: 'skill:s1',
  ts,
  dimensions: { changeKind: 'skill', target: 's1', category, action: 'update' },
});

/** A fake Dev-AW-LoopEvents: the last verdict row (if any) and the eval-gate markers. */
function fakeTable(opts: { lastThrough?: string; markers?: Record<string, unknown>[] }) {
  const queries: QueryInput[] = [];
  const query = jest.fn(async (params: QueryInput): Promise<QueryOutput> => {
    queries.push(params);
    const loopId = params.ExpressionAttributeValues?.[':l'];
    if (loopId === EVAL_GATE_RUNS_LOOP_ID) {
      return { Items: opts.lastThrough ? [{ dimensions: { markersThrough: opts.lastThrough } }] : [] };
    }
    const since = String(params.ExpressionAttributeValues?.[':since']);
    return { Items: (opts.markers ?? []).filter((m) => String(m.tsSession) >= since) };
  });
  const puts: DynamoAttributeMap[] = [];
  const put = jest.fn(async (item: DynamoAttributeMap) => {
    puts.push(item);
  });
  return { query, put, puts, queries };
}

const suiteResult = (verdict: OfflineSuiteResult['verdict']): OfflineSuiteResult => ({
  suiteVersion: 1,
  verdict,
  mode: 'report_only',
  modeReason: 'EVAL_GATE_BLOCKING is not true',
  blocks: false,
  target: 'local',
  baseline: { baselineId: 'local-deterministic-v1', file: 'x.json', createdAt: '', source: '', target: 'local', suiteVersion: 1 },
  comparisons: [],
  sources: [],
  untracked: [],
  unavailable: verdict === 'unavailable' ? ['failure-replay: timeout'] : [],
  bypass: null,
  startedAt: NOW.toISOString(),
  finishedAt: NOW.toISOString(),
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('runEvalMarkerSuite', () => {
  it('is inert without the flag: no read, no suite, no write', async () => {
    const table = fakeTable({ markers: [marker('2026-09-28T11:00:00.000Z', 'skill')] });
    const runSuite = jest.fn();
    await expect(runEvalMarkerSuite({ env: {}, query: table.query, put: table.put, runSuite })).resolves.toEqual({ status: 'disabled' });
    expect(table.query).not.toHaveBeenCalled();
    expect(runSuite).not.toHaveBeenCalled();
    expect(table.put).not.toHaveBeenCalled();
  });

  it('runs the suite on new markers and records the verdict as the next cursor', async () => {
    const table = fakeTable({
      lastThrough: '2026-09-28T09:00:00.000Z',
      markers: [marker('2026-09-28T09:00:00.000Z', 'prompt'), marker('2026-09-28T10:00:00.000Z', 'skill'), marker('2026-09-28T11:30:00.000Z', 'model')],
    });
    const runSuite = jest.fn().mockResolvedValue(suiteResult('pass'));
    const outcome = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite });

    expect(outcome).toEqual({ status: 'ran', since: '2026-09-28T09:00:00.000Z', markerCount: 2, verdict: 'pass' });
    expect(runSuite).toHaveBeenCalledTimes(1);
    expect(table.puts).toHaveLength(1);
    const row = table.puts[0];
    expect(row.loopId).toBe(EVAL_GATE_RUNS_LOOP_ID);
    expect(row.eventType).toBe(EVT_EVAL_SUITE_VERDICT);
    expect(row.dimensions).toEqual(expect.objectContaining({
      verdict: 'pass',
      mode: 'report_only',
      markerCount: 2,
      categories: 'model,skill',
      markersSince: '2026-09-28T09:00:00.000Z',
      markersThrough: '2026-09-28T11:30:00.000Z',
    }));
    // The row holds no skill id or setting name.
    expect(JSON.stringify(row)).not.toContain('s1');
  });

  it('writes nothing when no marker is newer than the last run', async () => {
    const table = fakeTable({ lastThrough: '2026-09-28T11:30:00.000Z', markers: [marker('2026-09-28T11:30:00.000Z', 'skill')] });
    const runSuite = jest.fn();
    await expect(runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite }))
      .resolves.toEqual({ status: 'no_changes', since: '2026-09-28T11:30:00.000Z' });
    expect(runSuite).not.toHaveBeenCalled();
    expect(table.put).not.toHaveBeenCalled();
  });

  it('looks back 24 hours on its first run', async () => {
    const table = fakeTable({ markers: [marker('2026-09-27T11:00:00.000Z', 'skill'), marker('2026-09-28T01:00:00.000Z', 'judge')] });
    const runSuite = jest.fn().mockResolvedValue(suiteResult('pass'));
    const outcome = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite });
    expect(outcome).toEqual(expect.objectContaining({ since: '2026-09-27T12:00:00.000Z', markerCount: 1 }));
  });

  it('records a non-pass verdict and warns, without throwing', async () => {
    const table = fakeTable({ markers: [marker('2026-09-28T11:00:00.000Z', 'skill')] });
    const outcome = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite: async () => suiteResult('unavailable') });
    expect(outcome).toEqual(expect.objectContaining({ status: 'ran', verdict: 'unavailable' }));
    expect(table.puts[0].dimensions).toEqual(expect.objectContaining({ verdict: 'unavailable', unavailableCount: 1 }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('verdict unavailable'));
  });
});

describe('runLocalOfflineSuite', () => {
  it('runs the committed deterministic suite offline and passes on current code', async () => {
    const result = await runLocalOfflineSuite({});
    expect(result.target).toBe('local');
    expect(result.mode).toBe('report_only');
    expect(result.verdict).toBe('pass');
  });
});

describe('scheduleEvalMarkerSuite', () => {
  it('schedules nothing without the flag', () => {
    const setTimeoutFn = jest.fn();
    expect(scheduleEvalMarkerSuite({ env: {}, setTimeout: setTimeoutFn, isCronEnabled: () => true, track: jest.fn() })).toEqual({ scheduled: false });
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('ticks hourly through the cron registry, and skips a tick when cron is disabled on this instance', () => {
    let first: (() => void) | undefined;
    let every: (() => void) | undefined;
    const setIntervalFn = jest.fn((fn: () => void) => { every = fn; });
    const track = jest.fn((_name: string, p: Promise<unknown>) => p);
    const run = jest.fn().mockResolvedValue(undefined);
    let cronEnabled = true;
    const out = scheduleEvalMarkerSuite({
      env: ON,
      setTimeout: (fn: () => void) => { first = fn; },
      setInterval: setIntervalFn,
      isCronEnabled: () => cronEnabled,
      track,
      run,
    });
    expect(out).toEqual({ scheduled: true });
    first?.();
    expect(track).toHaveBeenCalledWith('EvalMarkerSuite', expect.any(Promise));
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), EVAL_MARKER_SUITE_INTERVAL_MS);
    cronEnabled = false;
    every?.();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * ENG-2195: the scheduled consumer runs the deterministic offline suite when new `eval_needed`
 * markers appeared since its last run, and records the verdict to Dev-AW-LoopEvents. It is inert
 * without EVAL_MARKER_SUITE_ENABLED=true, and an hour with no new markers writes nothing.
 */
import type AWS from 'aws-sdk';
import type { DynamoAttributeMap } from '../loops/core/ports';
import { EVAL_GATE_LOOP_ID } from '../loops/eval/evalChangeMarkers';
import * as offlineSuiteModule from '../loops/eval/offlineSuite';
import type { OfflineSuiteResult } from '../loops/eval/offlineSuite';
import {
  EVAL_GATE_RUNS_LOOP_ID,
  EVAL_MARKER_OVERLAP_MS,
  EVAL_MARKER_SUITE_INTERVAL_MS,
  EVT_EVAL_SUITE_VERDICT,
  markerTimestampOf,
  overlapFloor,
  runEvalMarkerSuite,
  runLocalOfflineSuite,
  scheduleEvalMarkerSuite,
} from '../cron/evalMarkerSuiteCron';

type QueryInput = AWS.DynamoDB.DocumentClient.QueryInput;
type QueryOutput = AWS.DynamoDB.DocumentClient.QueryOutput;

const NOW = new Date('2026-09-28T12:00:00.000Z');
const ON = { EVAL_MARKER_SUITE_ENABLED: 'true' };

const marker = (ts: string, category: string, subjectId = 'skill:s1', suffix = 'abcd1234') => ({
  loopId: EVAL_GATE_LOOP_ID,
  tsSession: `${ts}#${subjectId}#eval_needed#${suffix}`,
  eventType: 'eval_needed',
  subjectId,
  ts,
  dimensions: { changeKind: 'skill', target: subjectId.split(':')[1], category, action: 'update' },
});

/** A fake Dev-AW-LoopEvents: the last verdict row (if any) and the eval-gate markers. */
function fakeTable(opts: { lastThrough?: string; processedKeys?: string[]; markers?: Record<string, unknown>[] }) {
  const queries: QueryInput[] = [];
  const query = jest.fn(async (params: QueryInput): Promise<QueryOutput> => {
    queries.push(params);
    const loopId = params.ExpressionAttributeValues?.[':l'];
    if (loopId === EVAL_GATE_RUNS_LOOP_ID) {
      return {
        Items: opts.lastThrough
          ? [{ dimensions: { markersThrough: opts.lastThrough, processedKeys: (opts.processedKeys ?? []).join(',') } }]
          : [],
      };
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

/** The `processedKeys`/`markersThrough` a real prior tick would have written for these markers. */
function priorState(highWaterMark: string, processedKeys: readonly string[]) {
  return { lastThrough: highWaterMark, processedKeys: [...processedKeys] };
}

const dims = (item: DynamoAttributeMap | undefined) => item?.dimensions as Record<string, unknown> | undefined;

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

  it('runs the suite on new markers, re-scanning the overlap window behind the high-water mark', async () => {
    const covered = marker('2026-09-28T09:00:00.000Z', 'prompt');
    const newest = marker('2026-09-28T11:30:00.000Z', 'model');
    const table = fakeTable({
      ...priorState(covered.tsSession, [covered.tsSession]),
      markers: [covered, marker('2026-09-28T10:00:00.000Z', 'skill'), newest],
    });
    const runSuite = jest.fn().mockResolvedValue(suiteResult('pass'));
    const outcome = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite });

    const expectedSince = overlapFloor(covered.tsSession, EVAL_MARKER_OVERLAP_MS);
    expect(outcome).toEqual({ status: 'ran', since: expectedSince, markerCount: 2, verdict: 'pass' });
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
      markersSince: expectedSince,
      // The high-water mark is the newest marker's full sort key, still — the query floor is now
      // the overlap-adjusted `since`, but the cursor advances the same way.
      markersThrough: newest.tsSession,
      // Pruned to whatever is still within the overlap window of the new high-water mark: the
      // 09:00 and 10:00 markers are both more than EVAL_MARKER_OVERLAP_MS behind 11:30.
      processedKeys: newest.tsSession,
    }));
    // The cursor fields (markersSince/markersThrough/processedKeys) do carry the covered markers'
    // target identity as part of their sort key — same boundary evalChangeMarkers.ts already draws
    // for the marker rows themselves ("never the prompt text/value", not the identifier) — but the
    // row must never carry the marker's own value/valueSha/fields (the change's content).
    expect(row.dimensions).not.toHaveProperty('value');
    expect(row.dimensions).not.toHaveProperty('valueSha');
    expect(row.dimensions).not.toHaveProperty('fields');
  });

  it('writes nothing when every re-scanned marker was already processed', async () => {
    const covered = marker('2026-09-28T11:30:00.000Z', 'skill');
    const table = fakeTable({ ...priorState(covered.tsSession, [covered.tsSession]), markers: [covered] });
    const runSuite = jest.fn();
    await expect(runEvalMarkerSuite({ env: ON, now: () => NOW, query: table.query, put: table.put, runSuite }))
      .resolves.toEqual({ status: 'no_changes', since: overlapFloor(covered.tsSession, EVAL_MARKER_OVERLAP_MS) });
    expect(runSuite).not.toHaveBeenCalled();
    expect(table.put).not.toHaveBeenCalled();
  });

  it('never drops a same-millisecond sibling of the marker chosen as the cursor (ENG-2195 CodeRabbit)', async () => {
    // Two markers share a millisecond — buildEvalNeededItem's random per-write suffix is exactly
    // what keeps them distinct — but markerB is written only AFTER the first tick's query already
    // ran, so the first run sees and covers only markerA.
    const sameMs = '2026-09-28T10:00:00.000Z';
    const markerA = marker(sameMs, 'skill', 'skill:sA', 'aaaaaaaa');
    const markerB = marker(sameMs, 'skill', 'skill:sB', 'bbbbbbbb');
    const runSuite = jest.fn().mockResolvedValue(suiteResult('pass'));

    const table1 = fakeTable({ markers: [markerA] });
    const first = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table1.query, put: table1.put, runSuite });
    expect(first).toEqual(expect.objectContaining({ status: 'ran', markerCount: 1 }));
    const row1 = dims(table1.puts[0]);
    // The stored cursor is the marker's full sort key, not the bare, collision-prone timestamp —
    // a bare-timestamp cursor is exactly the shape CodeRabbit's finding traces the bug to.
    expect(row1?.markersThrough).toBe(markerA.tsSession);
    expect(row1?.processedKeys).toBe(markerA.tsSession);

    // Second tick: markerB has now landed at the same millisecond. Dedupe is by exact marker
    // identity, not by a `>` comparison against the cursor, so a same-millisecond sibling that
    // isn't THE processed key is still picked up regardless of how it sorts against the cursor.
    const table2 = fakeTable({
      ...priorState(String(row1?.markersThrough), [String(row1?.processedKeys)]),
      markers: [markerA, markerB],
    });
    const second = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table2.query, put: table2.put, runSuite });
    expect(second).toMatchObject({ status: 'ran', markerCount: 1, verdict: 'pass' });
    expect(dims(table2.puts[0])?.markersThrough).toBe(markerB.tsSession);
  });

  it('picks up a marker whose write completes after the cursor already advanced past a LATER ts, even though its own ts sorts before the cursor (ENG-2195 CodeRabbit)', async () => {
    // markerA: ts 10:05. markerB: ts 10:00 — five minutes EARLIER, well inside the overlap window,
    // so markerB.tsSession sorts BEFORE the cursor tick 1 sets. This is the write-completion race:
    // markerB's recordEvalChange call happened first (older ts) but its fire-and-forget PutItem
    // only lands in DynamoDB after tick 1 already ran and advanced past markerA (ts 10:05).
    const markerA = marker('2026-09-28T10:05:00.000Z', 'skill', 'skill:sA', 'aaaaaaaa');
    const markerB = marker('2026-09-28T10:00:00.000Z', 'model', 'skill:sB', 'bbbbbbbb');
    expect(markerB.tsSession < markerA.tsSession).toBe(true);
    const runSuite = jest.fn().mockResolvedValue(suiteResult('pass'));

    // Tick 1: markerB has not landed yet. Only markerA exists in the table.
    const table1 = fakeTable({ markers: [markerA] });
    const first = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table1.query, put: table1.put, runSuite });
    expect(first).toEqual(expect.objectContaining({ status: 'ran', markerCount: 1 }));
    const row1 = dims(table1.puts[0]);
    expect(row1?.markersThrough).toBe(markerA.tsSession);

    // A cursor built as a pure ">" bound would query from markerA.tsSession onward and never see
    // markerB (its tsSession sorts before that floor). The overlap floor must reach back far
    // enough to still include it.
    const floor = overlapFloor(String(row1?.markersThrough), EVAL_MARKER_OVERLAP_MS);
    expect(markerB.tsSession >= floor).toBe(true);
    expect(markerB.tsSession < String(row1?.markersThrough)).toBe(true);

    // Tick 2: markerB has now landed, still sorting before markerA/the old cursor.
    const table2 = fakeTable({
      ...priorState(String(row1?.markersThrough), String(row1?.processedKeys).split(',')),
      markers: [markerA, markerB],
    });
    const second = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table2.query, put: table2.put, runSuite });
    expect(second).toEqual(expect.objectContaining({ status: 'ran', markerCount: 1, verdict: 'pass' }));
    const row2 = dims(table2.puts[0]);
    // The high-water mark does not regress even though markerB sorts before it.
    expect(row2?.markersThrough).toBe(markerA.tsSession);
    expect(String(row2?.processedKeys).split(',').sort()).toEqual([markerA.tsSession, markerB.tsSession].sort());

    // Tick 3: nothing new landed. Both markers are still within the overlap window and already
    // processed, so neither is reprocessed — a straggler being caught once must not mean it (or
    // its sibling) triggers the suite again on every later tick that merely re-scans past it.
    const table3 = fakeTable({
      ...priorState(String(row2?.markersThrough), String(row2?.processedKeys).split(',')),
      markers: [markerA, markerB],
    });
    const third = await runEvalMarkerSuite({ env: ON, now: () => NOW, query: table3.query, put: table3.put, runSuite: jest.fn() });
    expect(third).toEqual({ status: 'no_changes', since: overlapFloor(String(row2?.markersThrough), EVAL_MARKER_OVERLAP_MS) });
    expect(table3.puts).toHaveLength(0);
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

describe('markerTimestampOf / overlapFloor', () => {
  it('extracts the ISO prefix of a full tsSession, and passes through a bare ISO unchanged', () => {
    expect(markerTimestampOf('2026-09-28T10:00:00.000Z#skill:s1#eval_needed#abcd1234')).toBe('2026-09-28T10:00:00.000Z');
    expect(markerTimestampOf('2026-09-28T10:00:00.000Z')).toBe('2026-09-28T10:00:00.000Z');
  });

  it('subtracts the overlap window from a high-water mark timestamp', () => {
    expect(overlapFloor('2026-09-28T10:00:00.000Z#skill:s1#eval_needed#abcd1234', 5 * 60 * 1000)).toBe('2026-09-28T09:55:00.000Z');
  });
});

describe('runLocalOfflineSuite', () => {
  it('runs the committed deterministic suite offline and passes on current code', async () => {
    const result = await runLocalOfflineSuite();
    expect(result.target).toBe('local');
    expect(result.mode).toBe('report_only');
    expect(result.verdict).toBe('pass');
  });

  it('passes a literal non-blocking gate config even when EVAL_GATE_BLOCKING=true is set in this process (ENG-2195 CodeRabbit)', async () => {
    // This job's own contract is always report-only; a stray EVAL_GATE_BLOCKING in the cron's
    // environment (it is a runner-env var today, not an EB one, but nothing enforces that) must
    // not reach the suite as a blocking gate. No registry grader is validated today, so an
    // end-to-end check of `result.mode`/`blocks` alone would pass whether or not this is fixed
    // (see the sibling `runOfflineSuite` unit tests for what a validated grader would do); this
    // asserts directly on the gate config the suite actually receives.
    const spy = jest.spyOn(offlineSuiteModule, 'runOfflineSuite');
    const original = process.env.EVAL_GATE_BLOCKING;
    process.env.EVAL_GATE_BLOCKING = 'true';
    try {
      await runLocalOfflineSuite();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].gate).toEqual({ blockingFlag: false });
    } finally {
      if (original === undefined) delete process.env.EVAL_GATE_BLOCKING;
      else process.env.EVAL_GATE_BLOCKING = original;
      spy.mockRestore();
    }
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

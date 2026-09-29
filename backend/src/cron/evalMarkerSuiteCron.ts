/**
 * Offline eval suite on "needs eval" markers (ENG-2195, decision D4).
 *
 * A prompt, model or skill edited in the database (AW-Settings through settingsService, AW-Skills
 * through skillService) records an `eval_needed` marker in Dev-AW-LoopEvents (loopId `eval-gate`,
 * evalChangeMarkers.ts). Once an hour this job lists the markers written since its last run and,
 * when there are any, runs the deterministic offline suite (the same run as
 * `runOfflineEvalSuite.ts --target local`: committed baseline, no network, no LLM) and records the
 * verdict as one `eval_suite_verdict` row (loopId `eval-gate-runs`). An hour with no new markers
 * writes nothing.
 *
 * Resuming: overlap + identity dedupe, not a pure "greater than cursor" range read
 * ------------------------------------------------------------------------------
 * A marker's `tsSession` sort key is `<ts>#<subjectId>#<eventType>#<random suffix>` — ordered by
 * `ts` first, but `ts` is the wall-clock instant `recordEvalChange` was CALLED, not when its
 * DynamoDB write actually lands. Every caller fires it as `void recordSkillChange(...)`
 * (evalChangeMarkers.ts) — genuinely fire-and-forget, never awaited — so two markers' writes can
 * complete out of `ts` order: network jitter, throttling retries, or simple event-loop
 * interleaving can let a marker with an EARLIER `ts` become durably queryable AFTER one with a
 * LATER `ts` already did. If a tick has already advanced its cursor past that later marker, a
 * pure `tsSession > cursor` read (or even the query's own `tsSession >= floor` bound) can never
 * see the straggler again — its `ts` sorts before the cursor for good (ENG-2195 CodeRabbit).
 *
 * So this job re-scans a bounded overlap window behind its high-water mark on every tick
 * (`EVAL_MARKER_OVERLAP_MS`, comfortably past worst-case DynamoDB retry/backoff latency for one
 * PutItem) and tracks which specific marker keys it already processed inside that window, rather
 * than relying on ordering alone. A marker re-seen in the overlap is skipped as a duplicate; one
 * that lands late is still new and gets processed. The verdict row carries both the high-water
 * mark (`markersThrough`) and the pruned set of recently-processed keys (`processedKeys`) needed
 * to resume this way — both scoped to the overlap window, so the row stays small regardless of
 * total marker volume over time.
 *
 * Report-only. A non-pass verdict is logged as a warning and recorded; nothing is blocked or
 * filed. Off by default: scheduled, and allowed to write, only when
 * EVAL_MARKER_SUITE_ENABLED=true (enabling it in production is an OPS step).
 */

import AWS from 'aws-sdk';
import localBaseline from '../loops/eval/baselines/local-deterministic.json';
import type { DynamoAttributeMap } from '../loops/core/ports';
import { LOOP_EVENTS_TABLE, eventToItem } from '../loops/core/sensors/eventTableEventSource';
import { asLoopId, asSubjectId, type LoopId } from '../loops/core/types';
import { listEvalChangeMarkers, type EvalChangeMarkerRow } from '../loops/eval/evalChangeMarkers';
import { parseBaseline, runOfflineSuite, type OfflineSuiteResult } from '../loops/eval/offlineSuite';
import { failureReplaySource, replayFixtureSource } from '../loops/eval/offlineSuiteSources';

export const EVAL_MARKER_SUITE_FLAG = 'EVAL_MARKER_SUITE_ENABLED';
export const EVAL_MARKER_SUITE_JOB_NAME = 'EvalMarkerSuite';
export const EVAL_GATE_RUNS_LOOP_ID: LoopId = asLoopId('eval-gate-runs');
export const EVT_EVAL_SUITE_VERDICT = 'eval_suite_verdict';
export const EVAL_MARKER_SUITE_INTERVAL_MS = 60 * 60 * 1000;
/** With no earlier verdict row, the first run looks back this far for markers. */
export const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/**
 * Every tick re-scans this far behind the high-water mark, so a marker whose write completes
 * later than its own `ts` (fire-and-forget PutItem, never awaited by the caller) is still caught.
 * Ten minutes is comfortably past the AWS SDK's worst-case default retry/backoff for one write —
 * one hour between ticks makes re-scanning this small a window cheap every time.
 */
export const EVAL_MARKER_OVERLAP_MS = 10 * 60 * 1000;
/** The first tick waits a little after boot, so a deploy does not start with a suite run. */
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;
const LOCAL_BASELINE_FILE = 'src/loops/eval/baselines/local-deterministic.json';

type QueryFn = (params: AWS.DynamoDB.DocumentClient.QueryInput) => Promise<AWS.DynamoDB.DocumentClient.QueryOutput>;
type PutFn = (item: DynamoAttributeMap) => Promise<void>;

export interface EvalMarkerSuiteDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  query?: QueryFn;
  put?: PutFn;
  runSuite?: () => Promise<OfflineSuiteResult>;
}

export type EvalMarkerSuiteOutcome =
  | { status: 'disabled' }
  | { status: 'no_changes'; since: string }
  | { status: 'ran'; since: string; markerCount: number; verdict: OfflineSuiteResult['verdict'] };

/**
 * The deterministic local run: the committed baseline, replay cases and reply-length fixtures.
 *
 * Always report-only, by a literal gate config rather than `gateConfigFromEnv` — this job's own
 * contract does not depend on whatever `EVAL_GATE_BLOCKING` happens to be set to in this
 * process's environment. That flag is meaningful for the PR job and the Atem/staging CLI runs
 * (backend/docs/evals/OFFLINE_EVAL_GATE.md); this cron never blocks (ENG-2195 CodeRabbit).
 */
export function runLocalOfflineSuite(): Promise<OfflineSuiteResult> {
  return runOfflineSuite({
    baseline: parseBaseline(localBaseline),
    baselineFile: LOCAL_BASELINE_FILE,
    target: 'local',
    sources: [failureReplaySource(), replayFixtureSource()],
    gate: { blockingFlag: false },
  });
}

/** The ISO timestamp prefix of a marker's own `tsSession` (or a bare ISO string, unchanged). */
export function markerTimestampOf(tsSessionOrIso: string): string {
  const hashIdx = tsSessionOrIso.indexOf('#');
  return hashIdx === -1 ? tsSessionOrIso : tsSessionOrIso.slice(0, hashIdx);
}

/** `overlapMs` before a high-water mark's own timestamp — the floor the next tick re-scans from. */
export function overlapFloor(highWaterMark: string, overlapMs: number): string {
  const at = Date.parse(markerTimestampOf(highWaterMark));
  return new Date((Number.isNaN(at) ? Date.now() : at) - overlapMs).toISOString();
}

export interface MarkerCursorState {
  /** The largest `tsSession` this job has ever seen, across every marker it has processed. */
  highWaterMark: string;
  /** Full `tsSession` of every marker within the overlap window of `highWaterMark` already processed. */
  processedKeys: readonly string[];
}

/** The cursor state of the newest verdict row, or undefined before the first run. */
export async function lastMarkerCursorState(query: QueryFn): Promise<MarkerCursorState | undefined> {
  const page = await query({
    TableName: LOOP_EVENTS_TABLE,
    KeyConditionExpression: 'loopId = :l',
    ExpressionAttributeValues: { ':l': EVAL_GATE_RUNS_LOOP_ID },
    ScanIndexForward: false,
    Limit: 1,
  });
  const dimensions = page.Items?.[0]?.dimensions as Record<string, unknown> | undefined;
  const highWaterMark = dimensions?.markersThrough;
  // `markersThrough` is a marker's full sort key, not a plain ISO date, so it must not be
  // validated with Date.parse — just require a non-empty string.
  if (typeof highWaterMark !== 'string' || highWaterMark.length === 0) return undefined;
  const processedKeysRaw = dimensions?.processedKeys;
  const processedKeys = typeof processedKeysRaw === 'string' && processedKeysRaw.length > 0 ? processedKeysRaw.split(',') : [];
  return { highWaterMark, processedKeys };
}

export function buildVerdictItem(
  result: OfflineSuiteResult,
  window: { since: string; markers: readonly EvalChangeMarkerRow[]; highWaterMark: string; processedKeys: readonly string[] },
  at: Date,
): DynamoAttributeMap {
  const categories = [...new Set(window.markers.map((m) => String(m.dimensions.category ?? 'unknown')))].sort();
  return eventToItem(EVAL_GATE_RUNS_LOOP_ID, {
    subjectId: asSubjectId(`offline-suite:${result.target}`),
    eventType: EVT_EVAL_SUITE_VERDICT,
    ts: at,
    dimensions: {
      verdict: result.verdict,
      mode: result.mode,
      blocks: result.blocks,
      target: result.target,
      suiteVersion: result.suiteVersion,
      baselineId: result.baseline.baselineId,
      markerCount: window.markers.length,
      categories: categories.join(','),
      markersSince: window.since,
      markersThrough: window.highWaterMark,
      // The resume cursor for the next tick's dedupe (see the file header); scoped to the
      // overlap window so this row stays small no matter how many markers accumulate over time.
      processedKeys: window.processedKeys.join(','),
      metrics: result.comparisons.map((c) => `${c.metricId}=${c.status}`).join(';'),
      unavailableCount: result.unavailable.length,
    },
  });
}

/** One tick: run the suite when markers appeared since the last verdict, and record the verdict. */
export async function runEvalMarkerSuite(deps: EvalMarkerSuiteDeps = {}): Promise<EvalMarkerSuiteOutcome> {
  const env = deps.env ?? process.env;
  if (env[EVAL_MARKER_SUITE_FLAG] !== 'true') return { status: 'disabled' };
  const now = deps.now ?? (() => new Date());
  let query = deps.query;
  let put = deps.put;
  if (!query || !put) {
    const doc = new AWS.DynamoDB.DocumentClient({ region: env.AWS_REGION || 'us-west-2' });
    query ??= (params) => doc.query(params).promise();
    put ??= async (item) => {
      await doc.put({ TableName: LOOP_EVENTS_TABLE, Item: item }).promise();
    };
  }

  const state = await lastMarkerCursorState(query);
  const since = state
    ? overlapFloor(state.highWaterMark, EVAL_MARKER_OVERLAP_MS)
    : new Date(now().getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
  // Every marker with a sort key at or after `since`, including ones this job already processed
  // in a prior tick's overlap window — dedupe below is by identity, not by re-excluding a range.
  const candidates = await listEvalChangeMarkers(query, since);
  const alreadyProcessed = new Set(state?.processedKeys ?? []);
  const markers = candidates.filter((m) => !alreadyProcessed.has(m.tsSession));
  if (markers.length === 0) return { status: 'no_changes', since };

  const result = await (deps.runSuite ?? runLocalOfflineSuite)();
  const highWaterMark = candidates.reduce((latest, m) => (m.tsSession > latest ? m.tsSession : latest), state?.highWaterMark ?? since);
  // Keep only the keys still within the overlap window of the NEW high-water mark — bounded
  // regardless of marker volume, and still sufficient to dedupe next tick's re-scan of that window.
  const nextOverlapFloor = overlapFloor(highWaterMark, EVAL_MARKER_OVERLAP_MS);
  const processedKeys = candidates.filter((m) => m.tsSession >= nextOverlapFloor).map((m) => m.tsSession);

  await put(buildVerdictItem(result, { since, markers, highWaterMark, processedKeys }, now()));
  const line = `[${EVAL_MARKER_SUITE_JOB_NAME}] ${markers.length} change(s) since ${since}: verdict ${result.verdict} (${result.mode})`;
  if (result.verdict === 'pass') console.log(line);
  else console.warn(`${line}; ${result.unavailable.join('; ') || 'see the metric statuses in the verdict row'}`);
  return { status: 'ran', since, markerCount: markers.length, verdict: result.verdict };
}

export interface EvalMarkerSuiteScheduleDeps {
  env?: NodeJS.ProcessEnv;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** instanceState.isCronEnabled: false on a draining or non-leader instance. */
  isCronEnabled: () => boolean;
  /** cronJobRegistry.track, so shutdown waits for an in-flight run. */
  track: (jobName: string, promise: Promise<unknown>) => Promise<unknown>;
  run?: () => Promise<unknown>;
}

/** Schedules the hourly tick when the flag is on. Returns whether it scheduled anything. */
export function scheduleEvalMarkerSuite(deps: EvalMarkerSuiteScheduleDeps): { scheduled: boolean } {
  const env = deps.env ?? process.env;
  if (env[EVAL_MARKER_SUITE_FLAG] !== 'true') return { scheduled: false };
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const repeat = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const run = deps.run ?? (() => runEvalMarkerSuite({ env }));
  const tick = () => {
    if (!deps.isCronEnabled()) return;
    deps.track(EVAL_MARKER_SUITE_JOB_NAME, run()).catch((error: unknown) => console.error(`[${EVAL_MARKER_SUITE_JOB_NAME}] Error:`, error));
  };
  schedule(() => {
    tick();
    repeat(tick, EVAL_MARKER_SUITE_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(`[${EVAL_MARKER_SUITE_JOB_NAME}] Initialized — hourly, first run in ${FIRST_RUN_DELAY_MS / 60000} min`);
  return { scheduled: true };
}

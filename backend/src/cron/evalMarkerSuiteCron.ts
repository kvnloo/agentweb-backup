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
 * The verdict row is also the cursor: `markersThrough` is the full sort key of the newest marker
 * it covered (not just its timestamp — two markers can share a millisecond, so only the full key,
 * which carries a per-write random suffix, disambiguates them), and the next run starts strictly
 * after it. That sort key embeds the same target identity the marker itself already carries
 * (a skill id or an AW-Settings name — evalChangeMarkers.ts's own boundary is "never the prompt
 * text/value", not the identifier), plus counts, categories and the per-metric status.
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

/** `markersThrough` of the newest verdict row, or undefined before the first run. */
export async function lastMarkersThrough(query: QueryFn): Promise<string | undefined> {
  const page = await query({
    TableName: LOOP_EVENTS_TABLE,
    KeyConditionExpression: 'loopId = :l',
    ExpressionAttributeValues: { ':l': EVAL_GATE_RUNS_LOOP_ID },
    ScanIndexForward: false,
    Limit: 1,
  });
  const dimensions = page.Items?.[0]?.dimensions as Record<string, unknown> | undefined;
  const through = dimensions?.markersThrough;
  // `markersThrough` is a marker's full sort key from the second run onward (see buildVerdictItem
  // below), not a plain ISO date, so it must not be validated with Date.parse — just require a
  // non-empty string.
  return typeof through === 'string' && through.length > 0 ? through : undefined;
}

export function buildVerdictItem(
  result: OfflineSuiteResult,
  window: { since: string; markers: readonly EvalChangeMarkerRow[] },
  at: Date,
): DynamoAttributeMap {
  const categories = [...new Set(window.markers.map((m) => String(m.dimensions.category ?? 'unknown')))].sort();
  // The cursor for the NEXT run must be the lexicographically greatest full sort key (tsSession)
  // among this run's markers, never just the greatest timestamp: two markers can share a
  // millisecond (buildEvalNeededItem appends a random suffix precisely so concurrent writes to
  // the same target don't collide), and a bare-timestamp cursor would make the next tick's
  // `m.tsSession > since` filter silently drop whichever of them wasn't chosen as "the" marker at
  // that millisecond (ENG-2195 CodeRabbit).
  const markersThrough = window.markers.reduce((latest, m) => (m.tsSession > latest ? m.tsSession : latest), window.since);
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
      markersThrough,
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

  const since = (await lastMarkersThrough(query)) ?? new Date(now().getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
  // The query's key condition is inclusive, and `since` is itself either a bare ISO lookback
  // floor (first run) or a marker's own full sort key (subsequent runs) — filtering on the full
  // `tsSession` rather than the bare `ts` is what makes `> since` exclude exactly the markers
  // this run already covered, and nothing sharing their millisecond (see buildVerdictItem).
  const markers = (await listEvalChangeMarkers(query, since)).filter((m) => m.tsSession > since);
  if (markers.length === 0) return { status: 'no_changes', since };

  const result = await (deps.runSuite ?? runLocalOfflineSuite)();
  await put(buildVerdictItem(result, { since, markers }, now()));
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

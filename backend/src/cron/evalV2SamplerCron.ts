/**
 * Online eval sampler cron (ENG-2144, ENG-2128 slice 6).
 *
 * Once a day: list the sessions whose last activity fell on the previous UTC day (the
 * AdminUpdatedAtIndex query — never a scan), draw a seeded uniform random sample of
 * EVAL_V2_SAMPLE_SIZE of them, grade each with the deterministic ENG-2137 graders, and store one
 * `eval_v2_scored` row per session in Dev-AW-LoopEvents (loopId `eval-v2`). Then refresh the
 * `eval-v2-daily` snapshots (1d and 7d) that GET /api/admin/loops/eval-v2-trend serves.
 *
 * Why "last activity on the previous day": a session whose updatedAt is on day D and which is
 * still untouched at run time (17:15 UTC on D+1) has been idle for at least 17 hours, so it is
 * complete. The frame does not depend on who opened the dashboard, which is the bias this
 * replaces (lazy scoring, ENG-1710).
 *
 * Idempotent per (day, session): the day's sample is recorded first in a `eval_v2_sample_run`
 * row (the same draw is reused if a run is resumed), and every score is a conditional put on a
 * deterministic key. A day that finished is skipped.
 *
 * Inert by default. A live run refuses unless EVAL_V2_SAMPLER_ENABLED=true; enabling it in
 * production is OPS-7 (ENG-2152). A dry run reads and grades but writes nothing.
 *
 * No grader is validated (evalRegistry.mayGate is false for all), so this cron raises no alert.
 */

import AWS from 'aws-sdk';
import type { ClockPort, DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { gradeSession, type TaskVerdict } from '../loops/eval/agentGraders';
import {
  SESSION_PROJECTION,
  listSessionsUpdatedBetween,
  loadSessionItems,
  type DocItem,
  type GraderTables,
  type ReadOnlyDocReader,
  type ReadRequest,
} from '../loops/eval/agentGraderLoader';
import {
  EVAL_V2_DAILY_LOOP_ID,
  EVAL_V2_LOOP_ID,
  EVAL_V2_WINDOWS,
  EVT_EVAL_V2_SAMPLE_RUN,
  EVT_EVAL_V2_SCORED,
  aggregateEvalV2,
  buildSampleRunItem,
  buildScoredEventItem,
  buildSnapshotItem,
  parseSampleRun,
  parseScoredEvent,
  parseSnapshotItem,
  sampleRunSortKey,
  sampleSeed,
  sampleUniform,
  shiftDate,
  surfaceOf,
  utcDayWindow,
  type EvalV2Snapshot,
  type EvalV2WindowLabel,
  type SampleRun,
} from '../loops/eval/evalV2Sampler';
import { SPEND_EVENTS_TABLE } from '../services/spendEventDb';

export const EVAL_V2_SAMPLER_FLAG = 'EVAL_V2_SAMPLER_ENABLED';
export const EVAL_V2_SAMPLE_SIZE_ENV = 'EVAL_V2_SAMPLE_SIZE';
export const DEFAULT_EVAL_V2_SAMPLE_SIZE = 50;
const MAX_EVAL_V2_SAMPLE_SIZE = 500;

export function samplerEnabled(raw: string | undefined): boolean {
  return raw === 'true';
}

/** EVAL_V2_SAMPLE_SIZE, clamped to [1, 500]; unset, blank or not a number means the default. */
export function resolveSampleSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EVAL_V2_SAMPLE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EVAL_V2_SAMPLE_SIZE;
  return Math.max(1, Math.min(MAX_EVAL_V2_SAMPLE_SIZE, Math.floor(n)));
}

export interface SamplerDeps {
  /** Writes (and the sample-run / snapshot reads) — Dev-AW-LoopEvents only. */
  dynamo: DynamoPort;
  /** Reads of sessions, messages and agent-mode events. */
  reader: ReadOnlyDocReader;
  tables: GraderTables;
  clock: ClockPort;
}

export interface SamplerOptions {
  /** EVAL_V2_SAMPLER_ENABLED. A live run refuses without it. */
  enabled: boolean;
  /** Read and grade, write nothing. Allowed with the flag off. */
  dryRun: boolean;
  sampleSize: number;
  /** UTC day to sample, `YYYY-MM-DD`. Defaults to the previous day. */
  sampleDate?: string;
}

export interface VerdictTallies {
  task: Record<TaskVerdict, number>;
  tool: Record<'pass' | 'fail', number>;
  groundedness: Record<'grounded' | 'ungrounded' | 'no_claims', number>;
}

export type SamplerResult =
  | { status: 'refused'; reason: 'flag_off' | 'day_not_over' | 'invalid_date'; sampleDate?: string }
  | { status: 'already_sampled'; sampleDate: string; sampled: number; frameSize: number }
  | {
    status: 'sampled' | 'dry_run';
    sampleDate: string;
    frameSize: number;
    sampled: number;
    graded: number;
    /** Scores written by this run (always 0 in a dry run). */
    written: number;
    /** Scores already stored for this day (a resumed run). */
    alreadyScored: number;
    tallies: VerdictTallies;
    snapshotsWritten: number;
  };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(date: string): boolean {
  return DATE_ONLY.test(date) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
}

/** Conditional put when the port supports it, else read-then-put (the digest-claim fallback). */
async function putIfAbsent(dynamo: DynamoPort, item: DynamoAttributeMap): Promise<boolean> {
  if (dynamo.putItemIfAbsent) return dynamo.putItemIfAbsent(LOOP_EVENTS_TABLE, item, ['loopId', 'tsSession']);
  const existing = await dynamo.getItem(LOOP_EVENTS_TABLE, { loopId: item.loopId, tsSession: item.tsSession });
  if (existing) return false;
  await dynamo.putItem(LOOP_EVENTS_TABLE, item);
  return true;
}

async function readSampleRun(dynamo: DynamoPort, sampleDate: string): Promise<SampleRun | null> {
  const item = await dynamo.getItem(LOOP_EVENTS_TABLE, { loopId: EVAL_V2_LOOP_ID, tsSession: sampleRunSortKey(sampleDate) });
  return parseSampleRun(item as Record<string, unknown> | null);
}

/**
 * The sampled sessions' AW-ChatSessions items. Normally all are in the day's frame; a resumed
 * run may name a session touched since, which is read back by key.
 */
async function sampledItems(reader: ReadOnlyDocReader, sessionsTable: string, frame: readonly DocItem[], ids: readonly string[]): Promise<DocItem[]> {
  const byId = new Map(frame.map((item) => [String(item.sessionId), item]));
  const out: DocItem[] = [];
  for (const id of ids) {
    const inFrame = byId.get(id);
    if (inFrame) {
      out.push(inFrame);
      continue;
    }
    const page = await reader.query({
      TableName: sessionsTable,
      KeyConditionExpression: 'sessionId = :s',
      ProjectionExpression: SESSION_PROJECTION,
      ExpressionAttributeValues: { ':s': id },
    });
    const item = page.Items?.[0];
    if (item) out.push(item);
  }
  return out;
}

function emptyTallies(): VerdictTallies {
  return {
    task: { success: 0, failure: 0, excluded: 0 },
    tool: { pass: 0, fail: 0 },
    groundedness: { grounded: 0, ungrounded: 0, no_claims: 0 },
  };
}

/**
 * Sample, grade and store one day. See the file header for the frame, idempotency and flag
 * contract. Throws on I/O errors (the scheduler entry point swallows them); a failed live run
 * leaves its sample-run row in `sampling`, and the next run resumes the same draw.
 */
export async function runEvalV2Sample(deps: SamplerDeps, opts: SamplerOptions): Promise<SamplerResult> {
  if (!opts.dryRun && !opts.enabled) return { status: 'refused', reason: 'flag_off' };

  const today = deps.clock.now().toISOString().slice(0, 10);
  const sampleDate = opts.sampleDate ?? shiftDate(today, -1);
  if (!isRealDate(sampleDate)) return { status: 'refused', reason: 'invalid_date', sampleDate };
  if (sampleDate >= today) return { status: 'refused', reason: 'day_not_over', sampleDate };

  const existingRun = await readSampleRun(deps.dynamo, sampleDate);
  if (existingRun?.status === 'complete') {
    return { status: 'already_sampled', sampleDate, sampled: existingRun.sessionIds.length, frameSize: existingRun.frameSize };
  }

  const window = utcDayWindow(sampleDate);
  const frame = await listSessionsUpdatedBetween(deps.reader, deps.tables.sessions, window);
  const sampleSize = Math.max(1, Math.floor(opts.sampleSize));
  const seed = sampleSeed(sampleDate);
  let run: SampleRun = existingRun ?? {
    sampleDate,
    status: 'sampling',
    seed,
    frameSize: frame.length,
    sampleSize,
    sessionIds: sampleUniform(frame, sampleSize, seed, (item) => String(item.sessionId)).map((item) => String(item.sessionId)),
    startedAt: deps.clock.now().toISOString(),
  };

  if (!opts.dryRun && !existingRun) {
    // Claim the day with its draw before grading, so a concurrent or resumed run reuses it.
    const claimed = await putIfAbsent(deps.dynamo, buildSampleRunItem(run));
    if (!claimed) {
      const winner = await readSampleRun(deps.dynamo, sampleDate);
      if (winner?.status === 'complete') {
        return { status: 'already_sampled', sampleDate, sampled: winner.sessionIds.length, frameSize: winner.frameSize };
      }
      if (winner) run = winner;
    }
  }

  const items = await sampledItems(deps.reader, deps.tables.sessions, frame, run.sessionIds);
  const loaded = await loadSessionItems(deps.reader, deps.tables, items, { ...window, includeSpend: false });
  const itemById = new Map(items.map((item) => [String(item.sessionId), item]));

  const tallies = emptyTallies();
  let written = 0;
  let alreadyScored = 0;
  const scoredAt = deps.clock.now();
  for (const l of loaded) {
    const graded = gradeSession(l.session, l.model, undefined);
    tallies.task[graded.task.verdict]++;
    tallies.tool[graded.tools.verdict]++;
    tallies.groundedness[graded.groundedness.verdict]++;
    if (opts.dryRun) continue;
    const item = buildScoredEventItem(graded, {
      sampleDate,
      surface: surfaceOf(itemById.get(l.session.sessionId) ?? {}),
      frameSize: run.frameSize,
      sampleSize: run.sessionIds.length,
      userTurns: l.session.userTurns,
    }, scoredAt);
    if (await putIfAbsent(deps.dynamo, item)) written++;
    else alreadyScored++;
  }

  let snapshotsWritten = 0;
  if (!opts.dryRun) {
    await deps.dynamo.putItem(LOOP_EVENTS_TABLE, buildSampleRunItem({
      ...run,
      status: 'complete',
      completedAt: deps.clock.now().toISOString(),
      written,
      alreadyScored,
    }));
    snapshotsWritten = (await writeEvalV2Snapshots(deps.dynamo, sampleDate, deps.clock.now())).length;
  }

  return {
    status: opts.dryRun ? 'dry_run' : 'sampled',
    sampleDate,
    frameSize: run.frameSize,
    sampled: run.sessionIds.length,
    graded: loaded.length,
    written,
    alreadyScored,
    tallies,
    snapshotsWritten,
  };
}

async function queryEvalV2Range(dynamo: DynamoPort, prefix: string, fromDate: string, toDate: string): Promise<Record<string, unknown>[]> {
  const result = await dynamo.query({
    tableName: LOOP_EVENTS_TABLE,
    keyConditionExpression: 'loopId = :l AND tsSession BETWEEN :from AND :to',
    expressionAttributeValues: { ':l': EVAL_V2_LOOP_ID, ':from': `${prefix}#${fromDate}`, ':to': `${prefix}#${toDate}#￿` },
  });
  return result.items as Record<string, unknown>[];
}

/**
 * Recompute and overwrite the 1d and 7d snapshots ending on `date` from the stored scores.
 * Deterministic keys make this an idempotent overwrite.
 */
export async function writeEvalV2Snapshots(dynamo: DynamoPort, date: string, now: Date): Promise<EvalV2Snapshot[]> {
  const from = shiftDate(date, 1 - Math.max(...Object.values(EVAL_V2_WINDOWS)));
  const [scoreRows, runRows] = await Promise.all([
    queryEvalV2Range(dynamo, EVT_EVAL_V2_SCORED, from, date),
    queryEvalV2Range(dynamo, EVT_EVAL_V2_SAMPLE_RUN, from, date),
  ]);
  const scores = scoreRows.flatMap((row) => parseScoredEvent(row) ?? []);
  const runs = runRows.flatMap((row) => parseSampleRun(row) ?? []);
  const snaps: EvalV2Snapshot[] = [];
  for (const windowLabel of Object.keys(EVAL_V2_WINDOWS) as EvalV2WindowLabel[]) {
    const snap = aggregateEvalV2(scores, { date, windowLabel, now, runs });
    await dynamo.putItem(LOOP_EVENTS_TABLE, buildSnapshotItem(snap));
    snaps.push(snap);
  }
  return snaps;
}

/** The last `limit` daily snapshots for one window, oldest first (GET /eval-v2-trend). */
export async function readEvalV2Trend(
  dynamo: DynamoPort,
  opts: { limit?: number; windowLabel?: EvalV2WindowLabel } = {},
): Promise<EvalV2Snapshot[]> {
  const windowLabel = opts.windowLabel ?? '7d';
  const result = await dynamo.query({
    tableName: LOOP_EVENTS_TABLE,
    keyConditionExpression: 'loopId = :l',
    expressionAttributeValues: { ':l': EVAL_V2_DAILY_LOOP_ID },
  });
  const snaps = result.items
    .flatMap((item) => parseSnapshotItem(item as Record<string, unknown>) ?? [])
    .filter((s) => s.windowLabel === windowLabel)
    .sort((a, b) => a.date.localeCompare(b.date));
  const limit = opts.limit ?? 14;
  return limit > 0 ? snaps.slice(-limit) : snaps;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

export function productionGraderTables(): GraderTables {
  return {
    sessions: `${TABLE_PREFIX}AW-ChatSessions`,
    messages: `${TABLE_PREFIX}AW-ChatMessages`,
    loopEvents: LOOP_EVENTS_TABLE,
    spendEvents: SPEND_EVENTS_TABLE,
  };
}

/** DocumentClient queries only. Scans are refused: nothing on this path may scan a table. */
export function queryOnlyReader(region = process.env.AWS_REGION || 'us-west-2'): ReadOnlyDocReader {
  const doc = new AWS.DynamoDB.DocumentClient({ region });
  return {
    query: (request: ReadRequest) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request: ReadRequest) => Promise.reject(new Error(`evalV2Sampler: scan of ${request.TableName} refused`)),
  };
}

/** Scheduler entry point: yesterday, live, from env. Never throws. */
export async function runEvalV2SamplerCron(): Promise<void> {
  try {
    const { awsDynamoAdapter } = await import('../loops/adapters/awsAdapters');
    const result = await runEvalV2Sample(
      { dynamo: awsDynamoAdapter(), reader: queryOnlyReader(), tables: productionGraderTables(), clock: { now: () => new Date() } },
      {
        enabled: samplerEnabled(process.env[EVAL_V2_SAMPLER_FLAG]),
        dryRun: false,
        sampleSize: resolveSampleSize(process.env[EVAL_V2_SAMPLE_SIZE_ENV]),
      },
    );
    console.log('[EvalV2Sampler]', JSON.stringify(result));
  } catch (err) {
    console.error('[EvalV2Sampler] failed (swallowed):', err);
  }
}

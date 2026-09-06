/**
 * Agent-mode daily reliability snapshot cron.
 *
 * Once per day this reads the trailing 24h (and 7d rolling) of agent-mode
 * telemetry from Dev-AW-LoopEvents (loopId='agent-mode'), computes the
 * reliability metrics (see agentReliabilitySnapshot.ts), and persists ONE dated
 * snapshot row per window back into the SAME table under a distinct
 * loopId='agent-reliability-daily'. This gives a durable trend line — a real
 * line, not one-off scans — queryable one command/endpoint away.
 *
 * Why no new table: the snapshot row reuses the existing Dev-AW-LoopEvents
 * PK(loopId)+SK(tsSession) schema. A deterministic SK keyed on the date makes
 * the write an idempotent overwrite (re-running the same day replaces the row,
 * never duplicates), and the existing per-loop `query` path reads them back.
 * Lower complexity than provisioning AW-AgentReliabilitySnapshots + extending
 * create-tables + ensureCriticalTables.
 *
 * CONTRACT: telemetry only. This summarizes events the recorder already wrote on
 * the chat hot path; it never touches the chat path, so it is
 * chat-behavior-preserving. The whole run is best-effort/swallowed — a Dynamo
 * hiccup logs loudly but never crashes boot or throws into the scheduler. Gated
 * behind AGENT_RELIABILITY_SNAPSHOT_ENABLED, consistent with the other loop
 * crons' explicit opt-in.
 */

import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import type { ClockPort } from '../loops/core/ports';
import type { LoopId, NormalizedEvent } from '../loops/core/types';
import { asLoopId, asSubjectId } from '../loops/core/types';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { AGENT_MODE_LOOP_ID } from '../loops/instances/agent-mode/eventTypes';
import {
  computeReliabilitySnapshot,
  type ReliabilitySnapshot,
  type SatisfactionDimensionSample,
} from './agentReliabilitySnapshot';

/** The loop partition the daily snapshot rows are stored under (distinct from
 * the raw 'agent-mode' event stream so reads of one never page the other). */
export const RELIABILITY_SNAPSHOT_LOOP_ID: LoopId = asLoopId('agent-reliability-daily');

/** Snapshot event type — one row per (date, window). */
export const EVT_RELIABILITY_SNAPSHOT = 'reliability_snapshot';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for the UTC calendar day of a Date. */
export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Deterministic SK for a snapshot row. Same (date, window) => same SK =>
 * idempotent overwrite via putItem. */
function snapshotSortKey(date: string, windowLabel: string): string {
  return `${date}#${windowLabel}`;
}

/**
 * Read all agent-mode events (the cron then filters to its window in code, the
 * same approach EventTableEventSource uses — the SK shape is heterogeneous and
 * the ts attr is denormalized on every row).
 */
async function readAgentModeEvents(dynamo: DynamoPort): Promise<NormalizedEvent[]> {
  const result = await dynamo.query({
    tableName: LOOP_EVENTS_TABLE,
    keyConditionExpression: 'loopId = :loopId',
    expressionAttributeValues: { ':loopId': AGENT_MODE_LOOP_ID },
  });
  const events: NormalizedEvent[] = [];
  for (const item of result.items) {
    const eventType = typeof item.eventType === 'string' ? item.eventType : undefined;
    const subjectId = typeof item.subjectId === 'string' ? item.subjectId : undefined;
    const tsStr = typeof item.ts === 'string' ? item.ts : undefined;
    if (!eventType || !subjectId || !tsStr) continue;
    const dimensions =
      item.dimensions && typeof item.dimensions === 'object'
        ? sanitizeDimensions(item.dimensions as Record<string, unknown>)
        : undefined;
    events.push({
      subjectId: asSubjectId(subjectId),
      eventType,
      ts: new Date(tsStr),
      ...(dimensions ? { dimensions } : {}),
    });
  }
  return events;
}

function sanitizeDimensions(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  return out;
}

/** Serialize a snapshot into a Dynamo row. The full snapshot lives under
 * `snapshot` so the read path can rehydrate it verbatim; the scalar metrics are
 * also flattened onto the row for cheap filter/scan and console inspection. */
function snapshotToItem(snap: ReliabilitySnapshot): DynamoAttributeMap {
  return {
    loopId: RELIABILITY_SNAPSHOT_LOOP_ID,
    tsSession: snapshotSortKey(snap.date, snap.windowLabel),
    eventType: EVT_RELIABILITY_SNAPSHOT,
    subjectId: snap.date,
    ts: snap.computedAt,
    date: snap.date,
    windowLabel: snap.windowLabel,
    toolSuccessRate: snap.toolSuccessRate,
    degradedRunRate: snap.degradedRunRate,
    failedRunRate: snap.failedRunRate,
    runCount: snap.runCount,
    // The full snapshot — all scalars + a flat-scalar cluster array — is a valid
    // nested DynamoAttributeMap, so the read path rehydrates it verbatim.
    snapshot: snap as unknown as DynamoAttributeMap,
  };
}

/** Rehydrate a snapshot from a stored row, or null if it isn't a snapshot row. */
export function itemToSnapshot(item: Record<string, unknown>): ReliabilitySnapshot | null {
  const snap = item.snapshot;
  if (snap && typeof snap === 'object') {
    return snap as unknown as ReliabilitySnapshot;
  }
  return null;
}

export interface SnapshotCronDeps {
  dynamo: DynamoPort;
  clock: ClockPort;
  /**
   * ENG-1312: optional source of satisfaction-judge dimension samples for the
   * same window. Deliberately OPT-IN — when omitted, no chatbotDb/DynamoDB
   * call is made at all, so every existing caller of writeReliabilitySnapshots
   * (this whole file's existing test suite included) keeps behaving as a
   * pure, network-free unit run. Only the production entry point
   * (runAgentReliabilitySnapshot) wires in
   * `readSatisfactionDimensionSamplesFromChatbotDb` below.
   */
  readSatisfactionSamples?: (range: { startTime: string; endTime: string }) => Promise<SatisfactionDimensionSample[]>;
}

/**
 * Bound on how many recent sessions to scan for satisfaction-dimension
 * samples per snapshot run. Matches the existing admin sync-mode ceiling
 * (routes/admin.ts `maxLimit`) — generous enough for a daily/weekly trend
 * signal without turning this best-effort telemetry read into an unbounded
 * scan.
 */
const SATISFACTION_SAMPLE_READ_LIMIT = 1000;

/**
 * Real production reader: pulls recently-updated ChatSessions (via the
 * existing AdminUpdatedAtIndex-backed `getRecentSessionsPage`, the same path
 * routes/admin.ts's chat-history sync mode already uses — no new DB access
 * pattern) and maps each session's `satisfactionScore.dimensions` into a
 * timestamped sample.
 *
 * Approximation, documented rather than hidden: this windows by session
 * `updatedAt`, not the score's own `evaluatedAt` — a session scored inside the
 * window but touched again afterward could be missed by a later run's window,
 * or a session updated in-window whose score is slightly stale could be
 * included. That's an acceptable trade for a "visible within a day" fleet
 * trend signal (the bar ENG-1312 sets), not a per-session audit.
 *
 * Best-effort and lazy-imported like every other DB dependency in this file's
 * sibling services: a failure here must never break the tool/run-verdict
 * metrics that already work, so errors are swallowed to an empty list.
 */
export async function readSatisfactionDimensionSamplesFromChatbotDb(range: {
  startTime: string;
  endTime: string;
}): Promise<SatisfactionDimensionSample[]> {
  try {
    const { chatbotDb } = await import('../services/chatbotService');
    const { sessions } = await chatbotDb.getRecentSessionsPage(SATISFACTION_SAMPLE_READ_LIMIT, undefined, range);
    const samples: SatisfactionDimensionSample[] = [];
    for (const session of sessions) {
      const score = session.satisfactionScore;
      const dims = score?.dimensions;
      if (!score || !dims) continue;
      const tsStr = score.evaluatedAt || session.updatedAt;
      const ts = tsStr ? new Date(tsStr) : undefined;
      if (!ts || Number.isNaN(ts.getTime())) continue;
      samples.push({
        ts,
        concision: dims.concision,
        instructionCompliance: dims.instructionCompliance,
        unnecessaryPermissionRequest: dims.unnecessaryPermissionRequest,
      });
    }
    return samples;
  } catch (err) {
    console.error('[AgentReliabilitySnapshot] readSatisfactionDimensionSamplesFromChatbotDb failed (swallowed):', err);
    return [];
  }
}

export interface WriteSnapshotOptions {
  /**
   * How many UTC days back to ensure a snapshot exists for, counting the
   * current day. 1 (the default) preserves the original today-only behaviour.
   *
   * Higher values make the cron self-healing: any recent day with no row yet —
   * because the cron was disabled, the box was down, or the feature had simply
   * never been switched on (ENG-746) — is computed from events already in the
   * store. Without this, the first run after an outage produces a single
   * snapshot with no pre-release baseline beside it, and closure-gate check 4
   * stays `insufficient_data` for another full day.
   *
   * Completed days are written once and then left alone; the current day is
   * always rewritten because its window is still moving.
   */
  catchUpDays?: number;
}

/** The (date, window) pairs that already have a row, so catch-up can skip them. */
async function existingSnapshotKeys(dynamo: DynamoPort): Promise<Set<string>> {
  const result = await dynamo.query({
    tableName: LOOP_EVENTS_TABLE,
    keyConditionExpression: 'loopId = :loopId',
    expressionAttributeValues: { ':loopId': RELIABILITY_SNAPSHOT_LOOP_ID },
  });
  const keys = new Set<string>();
  for (const item of result.items) {
    const sk = typeof item.tsSession === 'string' ? item.tsSession : undefined;
    if (sk) keys.add(sk);
  }
  return keys;
}

/**
 * Compute + persist the daily snapshots (24h + 7d) for the UTC day that just
 * ended (or the current day when run mid-day), plus — when `catchUpDays` > 1 —
 * any of the preceding days that have no row yet. Idempotent per (date,
 * window). Returns the snapshots written, oldest-first. Best-effort: callers
 * should not rely on it throwing — runAgentReliabilitySnapshot swallows for the
 * scheduler.
 *
 * The event partition is read exactly once and reused for every day computed,
 * so filling a two-week gap costs the same single query as writing one day.
 */
export async function writeReliabilitySnapshots(
  deps: SnapshotCronDeps,
  opts: WriteSnapshotOptions = {},
): Promise<ReliabilitySnapshot[]> {
  const now = deps.clock.now();
  const events = await readAgentModeEvents(deps.dynamo);
  const today = utcDateString(now);

  const catchUpDays = Math.max(1, Math.floor(opts.catchUpDays ?? 1));
  const existing = catchUpDays > 1 ? await existingSnapshotKeys(deps.dynamo) : new Set<string>();

  // ENG-1312: read satisfaction-dimension samples ONCE, covering the widest
  // span any (date, window) pair in this run needs — the oldest catch-up
  // day's 7d window reaches furthest back — then let computeReliabilitySnapshot
  // subset per (date, window) exactly like the reused `events` array above.
  // Opt-in and best-effort: an omitted dep or a failed read never blocks the
  // tool/run-verdict metrics that already work.
  let satisfactionSamples: SatisfactionDimensionSample[] = [];
  if (deps.readSatisfactionSamples) {
    try {
      const widestStart = new Date(now.getTime() - (catchUpDays - 1) * MS_PER_DAY - 7 * MS_PER_DAY);
      satisfactionSamples = await deps.readSatisfactionSamples({
        startTime: widestStart.toISOString(),
        endTime: now.toISOString(),
      });
    } catch (err) {
      console.error('[AgentReliabilitySnapshot] readSatisfactionSamples failed (swallowed):', err);
      satisfactionSamples = [];
    }
  }

  const windows: Array<{ label: string; spanMs: number }> = [
    { label: '24h', spanMs: MS_PER_DAY },
    { label: '7d', spanMs: 7 * MS_PER_DAY },
  ];

  const written: ReliabilitySnapshot[] = [];
  // Oldest-first so the trend line reads naturally as it is built.
  for (let back = catchUpDays - 1; back >= 0; back--) {
    const date = utcDateString(new Date(now.getTime() - back * MS_PER_DAY));
    // A completed day must close on its own UTC boundary, NOT at "now minus N
    // days" — the latter preserves the time of day, so a row labelled for one
    // date would carry hours belonging to the previous one and drop hours of
    // its own. Burn-in classifies rows as pre- or post-release purely by this
    // label, so a mislabelled window could put pre-release events in a
    // "post-release" snapshot and produce a wrong verdict. Today is the one
    // window that legitimately ends at `now`, because it is still moving.
    const dayEnd = back === 0 ? now : new Date(`${date}T23:59:59.999Z`);

    for (const w of windows) {
      const sk = snapshotSortKey(date, w.label);
      // A completed past day is written once; today always refreshes.
      if (back > 0 && existing.has(sk)) continue;

      const snap = computeReliabilitySnapshot({
        events,
        date,
        windowStart: new Date(dayEnd.getTime() - w.spanMs),
        windowEnd: dayEnd,
        windowLabel: w.label,
        now,
        satisfactionSamples,
      });
      // putItem on the same PK+SK overwrites — re-running the same day yields
      // ONE row per (date, window), never a duplicate.
      await deps.dynamo.putItem(LOOP_EVENTS_TABLE, snapshotToItem(snap));
      written.push(snap);
    }
  }
  return written;
}

/**
 * Read the last N daily 24h snapshots (default 14), oldest-first. The read path
 * for the trend line — consumed by show-reliability-trend.ts and the admin
 * endpoint.
 */
export async function readReliabilityTrend(
  dynamo: DynamoPort,
  opts: { limit?: number; windowLabel?: string } = {},
): Promise<ReliabilitySnapshot[]> {
  const windowLabel = opts.windowLabel ?? '24h';
  const result = await dynamo.query({
    tableName: LOOP_EVENTS_TABLE,
    keyConditionExpression: 'loopId = :loopId',
    expressionAttributeValues: { ':loopId': RELIABILITY_SNAPSHOT_LOOP_ID },
  });
  const snaps: ReliabilitySnapshot[] = [];
  for (const item of result.items) {
    const snap = itemToSnapshot(item as Record<string, unknown>);
    if (!snap) continue;
    if (snap.windowLabel !== windowLabel) continue;
    snaps.push(snap);
  }
  // Date order, oldest-first.
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  const limit = opts.limit ?? 14;
  return limit > 0 ? snaps.slice(-limit) : snaps;
}

/** Default catch-up horizon, matching readReliabilityTrend's 14-day default so
 * one run populates the whole trend the endpoint will return. */
export const DEFAULT_CATCH_UP_DAYS = 14;

/** Catch-up horizon from env, clamped to a sane range. An unset or blank value
 * means "use the default" — note `Number('')` is 0, not NaN, so the emptiness
 * check has to come first or a blank variable would silently mean 1 day. */
export function resolveCatchUpDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CATCH_UP_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CATCH_UP_DAYS;
  return Math.max(1, Math.min(90, Math.floor(n)));
}

/**
 * Boot-time seed. The cron fires once a day at 17:45 UTC, so on the first boot
 * after this ships the trend would stay empty — and closure-gate check 4
 * unsatisfiable — until that hour came around. This runs a single catch-up pass
 * at startup IF AND ONLY IF the snapshot partition is completely empty, which is
 * true exactly once, in the ENG-746 state. Once any row exists this returns
 * immediately, so it costs one small partition query per boot thereafter.
 *
 * NEVER throws — a telemetry seed must not affect boot.
 */
export async function seedReliabilitySnapshotsIfEmpty(): Promise<boolean> {
  try {
    const { productionLoopPorts } = await import('../loops/adapters/awsAdapters');
    const ports = productionLoopPorts();
    const existing = await existingSnapshotKeys(ports.dynamo);
    if (existing.size > 0) return false;

    const catchUpDays = resolveCatchUpDays(process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS);
    const written = await writeReliabilitySnapshots(
      {
        dynamo: ports.dynamo,
        clock: ports.clock,
        readSatisfactionSamples: readSatisfactionDimensionSamplesFromChatbotDb,
      },
      { catchUpDays },
    );
    console.log(
      `[AgentReliabilitySnapshot] Seeded an empty trend with ${written.length} rows ` +
        `across ${catchUpDays} days (first run — see ENG-746).`,
    );
    return true;
  } catch (err) {
    console.error('[AgentReliabilitySnapshot] seed failed (swallowed):', err);
    return false;
  }
}

/**
 * Scheduler entry point. Builds production ports, writes the snapshots, logs a
 * one-line summary. NEVER throws — telemetry must not crash the boot/scheduler.
 *
 * Runs by default; set AGENT_RELIABILITY_SNAPSHOT_ENABLED=false to opt out.
 * It was previously opt-in, the variable was never added to the production
 * environment, and the cron therefore never ran once — leaving the reliability
 * trend permanently empty and closure-gate check 4 unsatisfiable (ENG-746).
 */
export async function runAgentReliabilitySnapshot(): Promise<void> {
  try {
    // Lazy import keeps the AWS SDK off the cold path for callers that inject.
    const { productionLoopPorts } = await import('../loops/adapters/awsAdapters');
    const ports = productionLoopPorts();
    const catchUpDays = resolveCatchUpDays(process.env.AGENT_RELIABILITY_SNAPSHOT_CATCHUP_DAYS);
    const written = await writeReliabilitySnapshots(
      {
        dynamo: ports.dynamo,
        clock: ports.clock,
        readSatisfactionSamples: readSatisfactionDimensionSamplesFromChatbotDb,
      },
      { catchUpDays },
    );
    const day = written[written.length - 1];
    if (day) {
      // Summarize the current day; note any older days filled in this pass.
      const todayRows = written.filter((s) => s.date === day.date);
      const backfilled = written.length - todayRows.length;
      console.log(
        `[AgentReliabilitySnapshot] ${day.date}: ` +
          todayRows
            .map(
              (s) =>
                `${s.windowLabel} success=${(s.toolSuccessRate * 100).toFixed(1)}% ` +
                `degraded=${(s.degradedRunRate * 100).toFixed(1)}% runs=${s.runCount}`,
            )
            .join('  |  ') +
          (backfilled > 0 ? `  (+${backfilled} catch-up rows)` : ''),
      );
    } else {
      console.log('[AgentReliabilitySnapshot] no snapshot written (no windows)');
    }
  } catch (err) {
    console.error('[AgentReliabilitySnapshot] failed (swallowed):', err);
  }
}

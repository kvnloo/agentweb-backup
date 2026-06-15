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
}

/**
 * Compute + persist the daily snapshots (24h + 7d) for the UTC day that just
 * ended (or the current day when run mid-day). Idempotent per (date, window).
 * Returns the snapshots written. Best-effort: callers should not rely on it
 * throwing — runAgentReliabilitySnapshot swallows for the scheduler.
 */
export async function writeReliabilitySnapshots(
  deps: SnapshotCronDeps,
): Promise<ReliabilitySnapshot[]> {
  const now = deps.clock.now();
  const events = await readAgentModeEvents(deps.dynamo);
  const date = utcDateString(now);

  const windows: Array<{ label: string; start: Date }> = [
    { label: '24h', start: new Date(now.getTime() - MS_PER_DAY) },
    { label: '7d', start: new Date(now.getTime() - 7 * MS_PER_DAY) },
  ];

  const written: ReliabilitySnapshot[] = [];
  for (const w of windows) {
    const snap = computeReliabilitySnapshot({
      events,
      date,
      windowStart: w.start,
      windowEnd: now,
      windowLabel: w.label,
      now,
    });
    // putItem on the same PK+SK overwrites — re-running the same day yields ONE
    // row per (date, window), never a duplicate.
    await deps.dynamo.putItem(LOOP_EVENTS_TABLE, snapshotToItem(snap));
    written.push(snap);
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

/**
 * Scheduler entry point. Builds production ports, writes the snapshots, logs a
 * one-line summary. NEVER throws — telemetry must not crash the boot/scheduler.
 * Gated by the caller in server.ts behind AGENT_RELIABILITY_SNAPSHOT_ENABLED.
 */
export async function runAgentReliabilitySnapshot(): Promise<void> {
  try {
    // Lazy import keeps the AWS SDK off the cold path for callers that inject.
    const { productionLoopPorts } = await import('../loops/adapters/awsAdapters');
    const ports = productionLoopPorts();
    const written = await writeReliabilitySnapshots({ dynamo: ports.dynamo, clock: ports.clock });
    const day = written[0];
    if (day) {
      console.log(
        `[AgentReliabilitySnapshot] ${day.date}: ` +
          written
            .map(
              (s) =>
                `${s.windowLabel} success=${(s.toolSuccessRate * 100).toFixed(1)}% ` +
                `degraded=${(s.degradedRunRate * 100).toFixed(1)}% runs=${s.runCount}`,
            )
            .join('  |  '),
      );
    } else {
      console.log('[AgentReliabilitySnapshot] no snapshot written (no windows)');
    }
  } catch (err) {
    console.error('[AgentReliabilitySnapshot] failed (swallowed):', err);
  }
}

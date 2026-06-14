/**
 * Durable tracker for Slack-message timestamps that have already been dispatched
 * to cloud-dev. Used by the /api/slack/events reaction_added handler (via
 * loopSlackApprovalDispatcher) to prevent a second ✅ on the same digest DM from
 * spawning duplicate EC2 instances.
 *
 * v2 (this file): backed by DynamoDB `AW-LoopDispatches` through the loops
 * framework's injected `DynamoPort`, so the dedupe set survives backend
 * redeploys. v1 kept the set in an in-memory `Map`, which reset on every
 * Elastic Beanstalk restart — a ✅ on a pre-deploy DM could then re-dispatch.
 *
 * Storage (Dev-AW-LoopDispatches):
 *   PK messageTs (S)  — the Slack DM `item.ts`
 *   attrs: pageIds (S, JSON array), dispatchedAt (S, ISO), ttl (N, epoch seconds)
 *
 * TTL: `ttl` is `floor(now/1000) + 7d`. DynamoDB native TTL prunes rows passively
 * (deletion can lag up to ~48h), so reads ALSO filter on the stored `ttl` — a
 * not-yet-swept-but-expired item reads as NOT dispatched. This preserves the v1
 * 7-day semantics exactly.
 *
 * Resilience: the module-level singleton (`isDispatched`/`markDispatched`/
 * `getDispatched`) degrades to an in-memory Map if DynamoDB throws, so a table
 * outage can never crash the Slack events endpoint — at worst it falls back to
 * v1 behavior for that process.
 */

import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { awsDynamoAdapter } from '../loops/adapters/awsAdapters';

export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Table name follows the Dev-AW-Loop* convention shared with LoopEvents/LoopLearning. */
export const LOOP_DISPATCHES_TABLE = 'Dev-AW-LoopDispatches';

export interface DispatchEntry {
  dispatchedAt: Date;
  pageIds: string[];
}

interface DynamoLoopDispatchTrackerOptions {
  tableName?: string;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * DynamoDB-backed dispatch tracker. Injectable `DynamoPort` makes it fully
 * unit-testable with an in-memory fake — no live AWS. Construct a fresh instance
 * backed by the same `DynamoPort` to simulate a redeploy; the dedupe state
 * survives because it lives in the table, not the instance.
 */
export class DynamoLoopDispatchTracker {
  private readonly tableName: string;
  private readonly now: () => number;

  constructor(
    private readonly dynamo: DynamoPort,
    options: DynamoLoopDispatchTrackerOptions = {},
  ) {
    this.tableName = options.tableName ?? LOOP_DISPATCHES_TABLE;
    this.now = options.now ?? (() => Date.now());
  }

  async markDispatched(messageTs: string, pageIds: string[]): Promise<void> {
    const nowMs = this.now();
    const item: Record<string, string | number> = {
      messageTs,
      pageIds: JSON.stringify([...pageIds]),
      dispatchedAt: new Date(nowMs).toISOString(),
      ttl: Math.floor(nowMs / 1000) + Math.floor(TTL_MS / 1000),
    };
    await this.dynamo.putItem(this.tableName, item as unknown as DynamoAttributeMap);
  }

  async getDispatched(messageTs: string): Promise<DispatchEntry | null> {
    const raw = await this.dynamo.getItem(this.tableName, { messageTs });
    if (!raw) return null;
    if (this.isExpired(raw)) return null;
    return itemToEntry(raw);
  }

  async isDispatched(messageTs: string): Promise<boolean> {
    return (await this.getDispatched(messageTs)) !== null;
  }

  /** True if the stored `ttl` (epoch seconds) is at or before now — passive-expiry guard. */
  private isExpired(item: DynamoAttributeMap): boolean {
    const ttl = item.ttl;
    if (typeof ttl !== 'number') return false; // no ttl stored → never expires by this guard
    return ttl * 1000 <= this.now();
  }
}

function itemToEntry(item: DynamoAttributeMap): DispatchEntry {
  const dispatchedAtRaw = item.dispatchedAt;
  const pageIdsRaw = item.pageIds;
  const dispatchedAt =
    typeof dispatchedAtRaw === 'string' ? new Date(dispatchedAtRaw) : new Date(0);
  let pageIds: string[] = [];
  if (typeof pageIdsRaw === 'string') {
    try {
      const parsed = JSON.parse(pageIdsRaw);
      if (Array.isArray(parsed)) pageIds = parsed.filter((p): p is string => typeof p === 'string');
    } catch {
      pageIds = [];
    }
  }
  return { dispatchedAt, pageIds };
}

// ---------------------------------------------------------------------------
// Module-level singleton — the production call sites (loopSlackApprovalDispatcher)
// use these. Lazily binds the AWS DynamoDB adapter; degrades to an in-memory Map
// if DynamoDB is unavailable so the Slack events endpoint never crashes.
// ---------------------------------------------------------------------------

let defaultTracker: DynamoLoopDispatchTracker | null = null;

/** In-memory fallback used ONLY when a DynamoDB operation throws. */
const fallbackStore = new Map<string, DispatchEntry>();

function getDefaultTracker(): DynamoLoopDispatchTracker {
  if (!defaultTracker) {
    defaultTracker = new DynamoLoopDispatchTracker(awsDynamoAdapter());
  }
  return defaultTracker;
}

function sweepFallback(now = Date.now()): void {
  for (const [ts, entry] of fallbackStore) {
    if (now - entry.dispatchedAt.getTime() > TTL_MS) fallbackStore.delete(ts);
  }
}

export async function markDispatched(messageTs: string, pageIds: string[]): Promise<void> {
  try {
    await getDefaultTracker().markDispatched(messageTs, pageIds);
  } catch (err) {
    console.error(
      `[loopDispatchTracker] DynamoDB markDispatched failed for ${messageTs} — degrading to in-memory:`,
      err,
    );
    sweepFallback();
    fallbackStore.set(messageTs, { dispatchedAt: new Date(), pageIds: [...pageIds] });
  }
}

export async function isDispatched(messageTs: string): Promise<boolean> {
  try {
    return await getDefaultTracker().isDispatched(messageTs);
  } catch (err) {
    console.error(
      `[loopDispatchTracker] DynamoDB isDispatched failed for ${messageTs} — degrading to in-memory:`,
      err,
    );
    sweepFallback();
    return fallbackStore.has(messageTs);
  }
}

export async function getDispatched(messageTs: string): Promise<DispatchEntry | null> {
  try {
    return await getDefaultTracker().getDispatched(messageTs);
  } catch (err) {
    console.error(
      `[loopDispatchTracker] DynamoDB getDispatched failed for ${messageTs} — degrading to in-memory:`,
      err,
    );
    sweepFallback();
    return fallbackStore.get(messageTs) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers — not used by production code.
// ---------------------------------------------------------------------------

/**
 * Reset the module singleton. Optionally inject a tracker (or a DynamoPort)
 * so tests can drive the production call sites against a fake table.
 */
export function _resetForTesting(tracker?: DynamoLoopDispatchTracker | DynamoPort): void {
  fallbackStore.clear();
  if (tracker instanceof DynamoLoopDispatchTracker) {
    defaultTracker = tracker;
  } else if (tracker) {
    defaultTracker = new DynamoLoopDispatchTracker(tracker);
  } else {
    defaultTracker = null;
  }
}

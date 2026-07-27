/**
 * DynamoLearningStore — durable Layer-5 store (replaces InMemoryLearningStore in
 * production). Without this the loop forgets every proposal + outcome on each
 * redeploy, so it can never read its own history back to avoid re-proposing
 * in-flight or already-failed fixes.
 *
 * Storage (Dev-AW-LoopLearning):
 *   PK loopId
 *   SK sortKey = `<ts ISO>#<counter>` (chronological, unique)
 *   attrs (indexed for queries): ts, sourceRuleId, verdict, shippedAt
 *   attr `data` = JSON blob of the full LearningEvent (dates as ISO)
 *
 * Built on the injected DynamoPort — no AWS SDK import, keeps the core boundary
 * clean. Query-by-loopId + in-code filter is fine at loop volumes (a handful of
 * records/day).
 */

import type { DynamoAttributeMap, DynamoPort } from '../ports';
import type {
  HistoryFilter,
  LearningEvent,
  LearningRecord,
  LearningStore,
  LoopId,
} from '../types';

export const LOOP_LEARNING_TABLE = 'Dev-AW-LoopLearning';

let counter = 0;

interface DynamoLearningStoreOptions {
  tableName?: string;
}

export class DynamoLearningStore implements LearningStore {
  private readonly tableName: string;

  constructor(
    private readonly dynamo: DynamoPort,
    options: DynamoLearningStoreOptions = {},
  ) {
    this.tableName = options.tableName ?? LOOP_LEARNING_TABLE;
  }

  async record(event: LearningEvent): Promise<void> {
    counter++;
    const sortKey = `${event.ts.toISOString()}#${String(counter).padStart(6, '0')}`;
    await this.dynamo.putItem(this.tableName, itemFor(event, sortKey));
  }

  async recordDecisionIfAbsent(event: LearningEvent, decisionKey: string): Promise<boolean> {
    if (!this.dynamo.putItemIfAbsent) {
      throw new Error('DynamoPort.putItemIfAbsent is required for atomic loop decisions');
    }
    const sortKey = `decision#${decisionKey}`;
    return this.dynamo.putItemIfAbsent(
      this.tableName,
      itemFor(event, sortKey),
      ['loopId', 'sortKey'],
    );
  }

  async queryHistory(filter: HistoryFilter): Promise<LearningRecord[]> {
    const res = await this.dynamo.query({
      tableName: this.tableName,
      keyConditionExpression: 'loopId = :loopId',
      expressionAttributeValues: { ':loopId': filter.loopId },
    });

    const records: LearningRecord[] = [];
    for (const item of res.items) {
      const rec = itemToRecord(item);
      if (!rec) continue;
      if (filter.window && (rec.ts < filter.window.start || rec.ts > filter.window.end)) continue;
      if (filter.ruleIds && (!rec.proposal || !filter.ruleIds.includes(rec.proposal.sourceRuleId)))
        continue;
      if (filter.status && (!rec.decision || !filter.status.includes(rec.decision.status))) continue;
      records.push(rec);
    }
    // Chronological by sortKey.
    records.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return records;
  }

  async lastOutcomeForRule(loopId: LoopId, ruleId: string): Promise<LearningRecord | null> {
    const all = await this.queryHistory({ loopId });
    const matches = all
      .filter((r) => r.verdict != null && r.proposal?.sourceRuleId === ruleId)
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return matches[0] ?? null;
  }
}

function itemFor(event: LearningEvent, sortKey: string): DynamoAttributeMap {
  const item: Record<string, string> = {
    loopId: event.loopId,
    sortKey,
    ts: event.ts.toISOString(),
    data: JSON.stringify(serialize(event)),
  };
  const ruleId = event.proposal?.sourceRuleId;
  if (ruleId) item.sourceRuleId = ruleId;
  if (event.verdict != null) item.verdict = event.verdict;
  if (event.shippedAt) {
    item.shippedAt =
      event.shippedAt instanceof Date ? event.shippedAt.toISOString() : String(event.shippedAt);
  }
  return item as unknown as DynamoAttributeMap;
}

/** Dates -> ISO strings for JSON storage. */
function serialize(event: LearningEvent): Record<string, unknown> {
  return {
    ...event,
    ts: event.ts.toISOString(),
    ...(event.shippedAt
      ? { shippedAt: event.shippedAt instanceof Date ? event.shippedAt.toISOString() : event.shippedAt }
      : {}),
  };
}

function strAttr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function itemToRecord(item: DynamoAttributeMap): LearningRecord | null {
  const raw = strAttr(item.data);
  const sortKey = strAttr(item.sortKey);
  if (!raw || !sortKey) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Revive dates.
  const ts = typeof parsed.ts === 'string' ? new Date(parsed.ts) : new Date(0);
  const shippedAt = typeof parsed.shippedAt === 'string' ? new Date(parsed.shippedAt) : parsed.shippedAt ?? undefined;
  return {
    ...(parsed as unknown as LearningEvent),
    ts,
    ...(shippedAt ? { shippedAt: shippedAt as Date } : {}),
    sortKey,
  };
}

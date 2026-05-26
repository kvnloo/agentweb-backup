/**
 * eventTableEventSource — reads NormalizedEvents from the `Dev-AW-LoopEvents`
 * DynamoDB table via the injected `DynamoPort`.
 *
 * Production sensor for anonymous-funnel loops (the lander instance is the
 * first consumer). Reads all events for a given `loopId` within the
 * orchestrator's TimeWindow.
 *
 * Storage schema (Dev-AW-LoopEvents):
 *   PK loopId           — partition by loop instance
 *   SK tsSession        — `<ts ISO>#<sessionId>#<eventType>` — unique per
 *                         event, sorts by time
 *   attrs:
 *     eventType         — landed | form_submitted | eval_started | …
 *     subjectId         — sessionId or userId
 *     variantId?        — exposure tag (optional)
 *     ts                — ISO timestamp (denormalized from tsSession for
 *                         ergonomics)
 *     dimensions?       — Map<string, S|N|BOOL> — error text, elapsed_ms,
 *                         attribution, etc.
 */

import type { EventFilter, EventSource, LoopId, NormalizedEvent, TimeWindow } from '../types';
import { asSubjectId, asVariantId } from '../types';
import type { DynamoAttributeMap, DynamoPort, DynamoAttributeValue } from '../ports';

export const LOOP_EVENTS_TABLE = 'Dev-AW-LoopEvents';

interface EventTableSensorOptions {
  /** Override the table name (e.g. for tests against a local-DDB). */
  tableName?: string;
}

export class EventTableEventSource implements EventSource {
  private readonly tableName: string;

  constructor(
    private readonly dynamo: DynamoPort,
    private readonly loopId: LoopId,
    options: EventTableSensorOptions = {},
  ) {
    this.tableName = options.tableName ?? LOOP_EVENTS_TABLE;
  }

  async fetchEvents(window: TimeWindow, filter?: EventFilter): Promise<NormalizedEvent[]> {
    // Query all events for this loop, then filter by ts in code. This lets the
    // SK format be heterogeneous — client-fired anon events use
    // `<ts ISO>#<sessionId>#<eventType>` to allow many per session, while
    // server-fired terminal events (eval_completed, eval_failed) use
    // `<eventType>#<sessionId>` to be idempotent via conditional put. The ts
    // attribute is denormalized on every item so the window filter works
    // regardless of SK shape.
    const result = await this.dynamo.query({
      tableName: this.tableName,
      keyConditionExpression: 'loopId = :loopId',
      expressionAttributeValues: { ':loopId': this.loopId },
    });

    const events: NormalizedEvent[] = [];
    for (const item of result.items) {
      const ev = itemToEvent(item);
      if (!ev) continue;
      if (ev.ts < window.start || ev.ts > window.end) continue;
      if (filter?.eventTypes && !filter.eventTypes.includes(ev.eventType)) continue;
      if (filter?.subjectIds && !filter.subjectIds.includes(ev.subjectId)) continue;
      if (filter?.variantIds && ev.variantId && !filter.variantIds.includes(ev.variantId)) continue;
      events.push(ev);
    }
    return events;
  }
}

function itemToEvent(item: DynamoAttributeMap): NormalizedEvent | null {
  const eventType = strAttr(item.eventType);
  const subjectId = strAttr(item.subjectId);
  const tsStr = strAttr(item.ts);
  if (!eventType || !subjectId || !tsStr) return null;
  const variantId = strAttr(item.variantId);
  const dimensions = item.dimensions && typeof item.dimensions === 'object'
    ? sanitizeDimensions(item.dimensions as DynamoAttributeMap)
    : undefined;

  const ev: NormalizedEvent = {
    subjectId: asSubjectId(subjectId),
    eventType,
    ts: new Date(tsStr),
    ...(variantId ? { variantId: asVariantId(variantId) } : {}),
    ...(dimensions ? { dimensions } : {}),
  };
  return ev;
}

function strAttr(v: DynamoAttributeValue | undefined): string | undefined {
  if (typeof v === 'string') return v;
  return undefined;
}

function sanitizeDimensions(raw: DynamoAttributeMap): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      // Skip nested types — dimensions are flat by convention.
    }
  }
  return out;
}

/**
 * Build the storage row from a NormalizedEvent. Used by the ingestion route
 * (`routes/loopEvents.ts`) when writing new events.
 */
export function eventToItem(loopId: LoopId, event: NormalizedEvent): DynamoAttributeMap {
  const tsIso = event.ts.toISOString();
  const item: Record<string, DynamoAttributeValue> = {
    loopId,
    tsSession: `${tsIso}#${event.subjectId}#${event.eventType}`,
    eventType: event.eventType,
    subjectId: event.subjectId,
    ts: tsIso,
  };
  if (event.variantId) item.variantId = event.variantId;
  if (event.dimensions) {
    item.dimensions = { ...event.dimensions } as DynamoAttributeMap;
  }
  return item;
}

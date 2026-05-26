/**
 * In-memory sensor for hermetic smoke tests. The smoke harness preloads
 * scripted persona event streams; this implementation returns them on
 * fetchEvents(). Production loops use userArrayEventSource (Phase 2) or
 * eventTableEventSource (Phase 3) which read from real DynamoDB.
 */

import type { EventFilter, EventSource, NormalizedEvent, TimeWindow } from '../types';

export class InMemoryEventSource implements EventSource {
  constructor(private readonly events: readonly NormalizedEvent[] = []) {}

  async fetchEvents(window: TimeWindow, filter?: EventFilter): Promise<NormalizedEvent[]> {
    return this.events.filter((e) => {
      if (e.ts < window.start || e.ts > window.end) return false;
      if (filter?.eventTypes && !filter.eventTypes.includes(e.eventType)) return false;
      if (filter?.subjectIds && !filter.subjectIds.includes(e.subjectId)) return false;
      if (filter?.variantIds && e.variantId && !filter.variantIds.includes(e.variantId)) return false;
      return true;
    });
  }
}

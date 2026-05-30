/**
 * userArrayEventSource — Layer-1 sensor that reads events from a per-user array
 * attribute (e.g. `AW-Users.onboardingEvents[]`) and normalizes them.
 *
 * This is the sensor the onboarding loop needs: its events live on the user
 * record, not in the shared events table. Rather than import the agentweb user
 * DB (which would break the `loops/core/` package boundary), the user fetch is
 * injected as a function — the instance wiring supplies `userDb.getAllUsers`.
 *
 * Timestamp handling: onboarding events frequently lack their own per-event
 * timestamp. When absent, the event falls back to the user's `createdAt` so it
 * still lands inside a recent window — matching how the legacy onboarding loop
 * treated these events (it never required a per-event ts).
 */

import type { EventFilter, EventSource, NormalizedEvent, TimeWindow } from '../types';
import { asSubjectId } from '../types';

export interface UserArrayRecord {
  userId?: string;
  createdAt?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface UserArrayEventSourceOptions {
  /** User-record attribute holding the event array. Default 'onboardingEvents'. */
  arrayField?: string;
  /** Field on each event object holding the event type. Default 'event'. */
  eventTypeField?: string;
  /** Field on each event object holding an ISO timestamp, if any. Default 'ts'. */
  tsField?: string;
}

export class UserArrayEventSource implements EventSource {
  private readonly arrayField: string;
  private readonly eventTypeField: string;
  private readonly tsField: string;

  constructor(
    private readonly getUsers: () => Promise<UserArrayRecord[]>,
    options: UserArrayEventSourceOptions = {},
  ) {
    this.arrayField = options.arrayField ?? 'onboardingEvents';
    this.eventTypeField = options.eventTypeField ?? 'event';
    this.tsField = options.tsField ?? 'ts';
  }

  async fetchEvents(window: TimeWindow, filter?: EventFilter): Promise<NormalizedEvent[]> {
    const users = await this.getUsers();
    const out: NormalizedEvent[] = [];

    for (const u of users) {
      const arr = u[this.arrayField];
      if (!u.userId || !Array.isArray(arr)) continue;

      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const eventType = raw[this.eventTypeField];
        if (typeof eventType !== 'string' || !eventType) continue;

        // Per-event ts if present; else the user's createdAt; else the window
        // end (last resort so the event is still seen, not silently dropped).
        const tsRaw =
          (typeof raw[this.tsField] === 'string' ? (raw[this.tsField] as string) : undefined) ??
          u.createdAt;
        const ts = tsRaw ? new Date(tsRaw) : window.end;
        if (Number.isNaN(ts.getTime())) continue;
        if (ts < window.start || ts > window.end) continue;
        if (filter?.eventTypes && !filter.eventTypes.includes(eventType)) continue;

        const dimensions: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k === this.eventTypeField || k === this.tsField) continue;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            dimensions[k] = v;
          }
        }

        out.push({
          subjectId: asSubjectId(u.userId),
          eventType,
          ts,
          ...(Object.keys(dimensions).length ? { dimensions } : {}),
        });
      }
    }

    return out;
  }
}

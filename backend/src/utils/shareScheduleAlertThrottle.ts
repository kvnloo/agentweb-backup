/**
 * ENG-3149: caps on the "someone using your share link set up a scheduled chat" emails an account owner gets: at most
 * SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW in any rolling hour AND at most SHARE_SCHEDULE_ALERT_MAX_PER_DAY in any rolling 24 hours. Both
 * limits must allow an email; a refused request spends nothing.
 *
 * Why it exists: the alert fires when a share-link visitor makes a schedule's first mark, and a visitor can make many schedules.
 * Without a cap one link could mail the owner without limit. The hourly cap stops a burst; the daily cap stops a slow drip that
 * stays under the hourly one all day (5 an hour is 120 a day). Beyond a cap the email is skipped (the "Visitor-edited" badge still
 * shows). In process on purpose: a restart or a second instance can let a few extra through, which is harmless for a notification,
 * and it needs no table or attribute.
 *
 * The clock is injected so tests can slide the windows; each owner keeps at most the daily cap's worth of timestamps, and owners
 * with nothing left inside the daily window are swept, so the Map cannot grow without bound.
 */

export const SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW = 5;
export const SHARE_SCHEDULE_ALERT_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_SCHEDULE_ALERT_MAX_PER_DAY = 15;
export const SHARE_SCHEDULE_ALERT_DAY_MS = 24 * 60 * 60 * 1000;
/** Owners nobody has asked about for a whole daily window are swept in one pass; this is how often the sweep may run. */
const SWEEP_EVERY_MS = 60 * 1000;

export type ShareScheduleAlertLimit = 'hour' | 'day';

export type ShareScheduleAlertDecision =
  | { allowed: true }
  /**
   * `limit` says which cap refused. `firstBlock` is true for the first refusal by that cap since the owner last had room, so the
   * caller can log once instead of on every refusal.
   */
  | { allowed: false; limit: ShareScheduleAlertLimit; firstBlock: boolean };

export interface ShareScheduleAlertThrottle {
  /** Ask for one email slot for this owner. Allowed means it is now spent. */
  tryAcquire(ownerUserId: string): ShareScheduleAlertDecision;
  /** Owners currently remembered (for tests). */
  size(): number;
  reset(): void;
}

export function createShareScheduleAlertThrottle(options: {
  /** Emails allowed per `windowMs` (default 5 per hour). */
  max?: number;
  windowMs?: number;
  /** Emails allowed per `dayMs` (default 15 per 24 hours). */
  dailyMax?: number;
  dayMs?: number;
  now?: () => number;
} = {}): ShareScheduleAlertThrottle {
  const max = options.max ?? SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW;
  const windowMs = options.windowMs ?? SHARE_SCHEDULE_ALERT_WINDOW_MS;
  const dailyMax = options.dailyMax ?? SHARE_SCHEDULE_ALERT_MAX_PER_DAY;
  // The stamps are kept for the longer of the two windows, whatever the caller passed.
  const dayMs = Math.max(options.dayMs ?? SHARE_SCHEDULE_ALERT_DAY_MS, windowMs);
  const now = options.now ?? (() => Date.now());
  const owners = new Map<string, { sentAt: number[]; blockLogged: Set<ShareScheduleAlertLimit> }>();
  let lastSweep = now();

  const withinDay = (sentAt: number[], at: number) => sentAt.filter((stamp) => at - stamp < dayMs);

  const sweep = (at: number) => {
    lastSweep = at;
    for (const [owner, entry] of owners) {
      entry.sentAt = withinDay(entry.sentAt, at);
      if (entry.sentAt.length === 0) owners.delete(owner);
    }
  };

  return {
    tryAcquire(ownerUserId: string): ShareScheduleAlertDecision {
      const at = now();
      if (at - lastSweep >= SWEEP_EVERY_MS) sweep(at);
      const entry = owners.get(ownerUserId) ?? { sentAt: [], blockLogged: new Set<ShareScheduleAlertLimit>() };
      entry.sentAt = withinDay(entry.sentAt, at);

      const inLastHour = entry.sentAt.filter((stamp) => at - stamp < windowMs).length;
      const refusedBy: ShareScheduleAlertLimit | undefined =
        inLastHour >= max ? 'hour' : entry.sentAt.length >= dailyMax ? 'day' : undefined;
      if (refusedBy) {
        const firstBlock = !entry.blockLogged.has(refusedBy);
        entry.blockLogged.add(refusedBy);
        owners.set(ownerUserId, entry);
        return { allowed: false, limit: refusedBy, firstBlock };
      }

      entry.sentAt.push(at);
      entry.blockLogged.clear();
      owners.set(ownerUserId, entry);
      return { allowed: true };
    },
    size: () => owners.size,
    reset: () => { owners.clear(); lastSweep = now(); },
  };
}

/** The process-wide throttle the handlers use. */
export const shareScheduleAlertThrottle = createShareScheduleAlertThrottle();

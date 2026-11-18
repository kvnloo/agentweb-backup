/**
 * ENG-3149: at most N "someone using your share link set up a scheduled chat" emails per account owner per rolling window.
 *
 * Why it exists: the alert fires when a share-link visitor makes a schedule's first mark, and a visitor can make many schedules.
 * Without a cap one link could mail the owner without limit. Beyond the cap the email is skipped (the "Visitor-edited" badge still
 * shows). In process on purpose: a restart or a second instance can let a few extra through, which is harmless for a notification,
 * and it needs no table or attribute.
 *
 * The clock is injected so tests can slide the window; the Map is pruned so it cannot grow without bound.
 */

export const SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW = 5;
export const SHARE_SCHEDULE_ALERT_WINDOW_MS = 60 * 60 * 1000;
/** Owners nobody has asked about for this long are swept in one pass, so a long-lived process does not keep every owner it ever saw. */
const SWEEP_EVERY_MS = 60 * 1000;

export type ShareScheduleAlertDecision =
  | { allowed: true }
  /** `firstBlock` is true for the first refusal since the owner last had room, so the caller can log once instead of on every refusal. */
  | { allowed: false; firstBlock: boolean };

export interface ShareScheduleAlertThrottle {
  /** Ask for one email slot for this owner. Allowed means it is now spent. */
  tryAcquire(ownerUserId: string): ShareScheduleAlertDecision;
  /** Owners currently remembered (for tests). */
  size(): number;
  reset(): void;
}

export function createShareScheduleAlertThrottle(options: {
  max?: number;
  windowMs?: number;
  now?: () => number;
} = {}): ShareScheduleAlertThrottle {
  const max = options.max ?? SHARE_SCHEDULE_ALERT_MAX_PER_WINDOW;
  const windowMs = options.windowMs ?? SHARE_SCHEDULE_ALERT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const owners = new Map<string, { sentAt: number[]; blockLogged: boolean }>();
  let lastSweep = now();

  const fresh = (sentAt: number[], at: number) => sentAt.filter((stamp) => at - stamp < windowMs);

  const sweep = (at: number) => {
    lastSweep = at;
    for (const [owner, entry] of owners) {
      entry.sentAt = fresh(entry.sentAt, at);
      if (entry.sentAt.length === 0) owners.delete(owner);
    }
  };

  return {
    tryAcquire(ownerUserId: string): ShareScheduleAlertDecision {
      const at = now();
      if (at - lastSweep >= SWEEP_EVERY_MS) sweep(at);
      const entry = owners.get(ownerUserId) ?? { sentAt: [], blockLogged: false };
      entry.sentAt = fresh(entry.sentAt, at);
      if (entry.sentAt.length >= max) {
        const firstBlock = !entry.blockLogged;
        entry.blockLogged = true;
        owners.set(ownerUserId, entry);
        return { allowed: false, firstBlock };
      }
      entry.sentAt.push(at);
      entry.blockLogged = false;
      owners.set(ownerUserId, entry);
      return { allowed: true };
    },
    size: () => owners.size,
    reset: () => { owners.clear(); lastSweep = now(); },
  };
}

/** The process-wide throttle the handlers use. */
export const shareScheduleAlertThrottle = createShareScheduleAlertThrottle();

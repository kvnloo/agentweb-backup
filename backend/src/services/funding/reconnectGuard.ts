/**
 * ENG-2113: a worker can claim, in one forged result or one admission answer, that a customer's login is dead; acting on it marks that customer's connection
 * "needs reconnect" and takes their plan chats away. The stop is still shown to the user at once (as before). The record is marked only when
 *   (a) the signal arrives AND the worker's `connection.status` says needs_reconnect (`noteConfirmed`), or
 *   (b) the signal repeats on consecutive turns of the SAME connection (a turn that works resets it) whatever the status says (`note`),
 * at most once per cool-down per connection, and never for more than MAX_MARKS_PER_WINDOW different connections in a window (the circuit breaker).
 *
 * HONESTY ABOUT THE THREAT MODEL: `connection.status` comes from the SAME worker that sent the signal, so (a) is a consistency check, not independent evidence: a
 * compromised worker can say both. What bounds the damage of a compromised worker is the cool-down per connection and, above all, the circuit breaker: it can
 * take away at most MAX_MARKS_PER_WINDOW customers' plan chats per window before marking stops and an alert line is logged (users still see the stop; the 5 minute
 * sweeper and a human decide the rest). State is in memory per API instance: with several instances the limits apply per instance.
 */
export const MAX_MARKS_PER_WINDOW = 5;
export const MARK_WINDOW_MS = 10 * 60_000;
export class ReconnectGuard {
  private readonly seen = new Map<string, { count: number; first: number; lastMarked: number }>();
  /** Connections marked recently (any evidence), for the circuit breaker. */
  private readonly marks: Array<{ connectionId: string; at: number }> = [];
  private breakerLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly required = 2,
    private readonly windowMs = 10 * 60_000,
    private readonly cooldownMs = 5 * 60_000,
    private readonly maxEntries = 2_000,
  ) {}

  /** Records one "login is dead" signal; true only when it should now be acted on. */
  note(connectionId: string): boolean {
    const t = this.now();
    let e = this.seen.get(connectionId);
    if (!e || t - e.first > this.windowMs) e = { count: 0, first: t, lastMarked: e?.lastMarked ?? Number.NEGATIVE_INFINITY };
    e.count++;
    this.seen.set(connectionId, e);
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
    if (e.count < this.required) return false;
    if (t - e.lastMarked < this.cooldownMs) return false;
    if (!this.admitMark(connectionId, t)) return false;
    e.lastMarked = t;
    e.count = 0;
    return true;
  }

  /**
   * Independent evidence (the host's own `connection.status` says needs_reconnect, a different route from the turn stream): no second turn is waited for, only
   * the cool-down applies. True when the record should be marked now.
   */
  noteConfirmed(connectionId: string): boolean {
    const t = this.now();
    const e = this.seen.get(connectionId) ?? { count: 0, first: t, lastMarked: Number.NEGATIVE_INFINITY };
    if (t - e.lastMarked < this.cooldownMs) return false;
    if (!this.admitMark(connectionId, t)) return false;
    e.lastMarked = t;
    e.count = 0;
    this.seen.set(connectionId, e);
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }

  /**
   * The circuit breaker: more than MAX_MARKS_PER_WINDOW different connections marked within MARK_WINDOW_MS stops all marking (one alert line per window).
   * Records the mark when it admits it.
   */
  private admitMark(connectionId: string, t: number): boolean {
    while (this.marks.length && t - this.marks[0].at > MARK_WINDOW_MS) this.marks.shift();
    const distinct = new Set(this.marks.map((m) => m.connectionId));
    if (!distinct.has(connectionId) && distinct.size >= MAX_MARKS_PER_WINDOW) {
      if (t - this.breakerLoggedAt > MARK_WINDOW_MS) {
        this.breakerLoggedAt = t;
        console.error("[reconnect-guard] mark_breaker_open", { connectionsMarked: distinct.size, windowMs: MARK_WINDOW_MS });
      }
      return false;
    }
    this.marks.push({ connectionId, at: t });
    return true;
  }

  /** A turn on this connection worked: the signals were not consecutive. */
  reset(connectionId: string): void {
    const e = this.seen.get(connectionId);
    if (e) e.count = 0;
  }
}

/**
 * ENG-2113: a worker can claim, in one forged result or one admission answer, that a customer's login is dead; acting on it marks that customer's connection
 * "needs reconnect" and takes their plan chats away. The stop is still shown to the user at once (as before); the connection record is only marked when the signal
 * repeats on consecutive turns of the SAME connection (a turn that works resets it) and at most once per cool-down per connection. The caller also asks the worker
 * (a different route, `connection.status`) before it marks.
 */
export class ReconnectGuard {
  private readonly seen = new Map<string, { count: number; first: number; lastMarked: number }>();

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
    e.lastMarked = t;
    e.count = 0;
    return true;
  }

  /** A turn on this connection worked: the signals were not consecutive. */
  reset(connectionId: string): void {
    const e = this.seen.get(connectionId);
    if (e) e.count = 0;
  }
}
